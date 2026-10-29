//! A notification a client hears: its subscribing call made once its first callback registers, each
//! payload handed to every callback registered, and the subscription left once the last is taken
//! away.

use core::any::Any;
use core::fmt;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::sync::Notify;

use super::{
    Inner, Request, RequestDependencies, RequestOptions, ServiceManager, ServiceRouter, Step,
    Validate, traced,
};
use crate::constants::ProtocolCode;
use crate::debug::{DebugDirection, DebugType};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::identity::{Procedure, check_declaration};
use crate::payloads::PayloadCodec;
use crate::router::client::{NotificationLike, RouterClient};
use crate::router::types::{BoxFuture, RouterError};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What hears a notification's payload: what it settles with is reported when it fails.
pub type NotificationCallback<T> =
    Arc<dyn Fn(T) -> BoxFuture<Result<(), Arc<dyn Error + Send + Sync>>> + Send + Sync>;

/// What tells the server a subscription is left, with its call id and its answer.
pub type Unsubscribe<T> = Arc<dyn Fn(u32, T) -> BoxFuture<Result<(), CallError>> + Send + Sync>;

/// What a notification reads and writes by.
pub struct NotificationDependencies<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    /// Its subscribing request's codec.
    pub request: Req,
    /// Its subscribing request's result's codec.
    pub result: Res,
    /// Its notification's codec.
    pub notification: Not,
    /// The rules its subscribing request is judged by.
    pub validate: Option<Validate<Req::Value>>,
    /// Whether its rules stop at the first violation.
    pub fail_fast: bool,
    /// What tells the server a subscription is left; none cancels its call.
    pub unsubscribe: Option<Unsubscribe<Res::Value>>,
    /// The notifications its subscription takes ahead of what its callbacks settled, paced; none
    /// paces nothing.
    pub window: Option<u64>,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for NotificationDependencies<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationDependencies")
            .field("window", &self.window)
            .finish_non_exhaustive()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec>
    NotificationDependencies<Req, Res, Not>
{
    /// A notification's codecs, unpaced, judged by no rule, its subscription cancelled as it is left.
    #[must_use]
    pub fn of((request, result, notification): (Req, Res, Not)) -> Self {
        Self {
            request,
            result,
            notification,
            validate: None,
            fail_fast: false,
            unsubscribe: None,
            window: None,
        }
    }
}

// a settling many wait on: the registration in flight, or the leave
#[derive(Default)]
struct Settling {
    outcome: Mutex<Option<Result<(), CallError>>>,
    done: Notify,
}

impl Settling {
    async fn wait(&self) -> Result<(), CallError> {
        loop {
            let notified = self.done.notified();
            let mut notified = core::pin::pin!(notified);

            notified.as_mut().enable();

            let outcome = locked(&self.outcome).clone();

            if let Some(outcome) = outcome {
                return outcome;
            }

            notified.await;
        }
    }

    fn settle(&self, outcome: Result<(), CallError>) {
        *locked(&self.outcome) = Some(outcome);
        self.done.notify_waiters();
    }
}

struct State<Res, Not> {
    callbacks: Vec<(u64, NotificationCallback<Not>)>,
    next: u64,
    registering: Option<Arc<Settling>>,
    unregistering: Option<Arc<Settling>>,
    subscription: Option<(u32, Res)>,
    generation: u64,
}

struct NotificationShared<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    manager: Arc<Inner>,
    router: RouterClient,
    procedure: Procedure,
    requester: Request<Req, Res>,
    codec: Not,
    unsubscribe: Option<Unsubscribe<Res::Value>>,
    window: Option<u64>,
    state: Mutex<State<Res::Value, Not::Value>>,
    // itself, as its router holds it
    own: Mutex<Weak<Self>>,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for NotificationShared<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Notification")
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

impl<Req, Res, Not> NotificationShared<Req, Res, Not>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    fn liked(&self) -> Option<Arc<dyn NotificationLike>> {
        let own = locked(&self.own).upgrade()?;
        let liked: Arc<dyn NotificationLike> = own;

        Some(liked)
    }

    // held before it is asked for: a notification sent right behind the answer can come before
    // anything waiting on the answer runs
    async fn register(
        &self,
        (payload, options): (Req::Value, RequestOptions),
    ) -> Result<(), CallError> {
        let liked = self
            .liked()
            .ok_or_else(|| CallError::Disconnected(crate::router::core::DISPOSED.to_owned()))?;
        let registered = async {
            self.router
                .register_notification(Arc::clone(&liked))
                .map_err(CallError::Refused)?;

            // a notification's own request names no connection, whichever router it goes through
            let asked = RequestOptions {
                destination_id: options.destination_id,
                signal: options.signal,
                timeout: options.timeout,
                ..RequestOptions::default()
            };

            let (call_id, response) = self
                .requester
                .call_with(payload, (asked, Some(Arc::clone(&liked))))
                .map_err(CallError::Refused)?
                .with_call_id()
                .await?;

            locked(&self.state).subscription = Some((call_id, response));

            Ok(())
        }
        .await;

        // a router may hold it when what follows fails, as a subscription can
        if registered.is_err() && self.router.has_notification(&liked) {
            self.router.unregister_notification((&liked, true)).await;
        }

        registered
    }

    // the last callback out stops the notification: at the other end first, when it can be told,
    // so none comes for it after, then in the router
    async fn leave(&self) -> Result<(), CallError> {
        let left = locked(&self.state).subscription.take();
        let mut outcome = Ok(());
        // taken away at the other end, acknowledged: nothing is left there to cancel
        let mut is_acknowledged = false;

        if let (Some(unsubscribe), Some((call_id, response))) = (&self.unsubscribe, left) {
            match unsubscribe(call_id, response).await {
                Ok(()) => is_acknowledged = true,
                Err(error) => outcome = Err(error),
            }
        }

        if let Some(liked) = self.liked() {
            self.router
                .unregister_notification((&liked, !is_acknowledged))
                .await;
        }

        outcome
    }

    fn trace(&self, (error, rx): (Option<RouterError>, Option<Not::Value>)) {
        if !self.manager.is_debugging() {
            return;
        }

        self.manager.trace(
            &self.procedure,
            Step {
                call_id: None,
                connection_handle: None,
                direction: DebugDirection::Rx,
                error: error.map(|error| {
                    let traced: super::TracedError = Arc::new(error);

                    traced
                }),
                is_answered: false,
                options: None,
                rx: rx.map(traced),
                started: self.manager.notified_now(),
                tx: None,
                call_type: DebugType::Notification,
            },
        );
    }
}

impl<Req, Res, Not> NotificationLike for NotificationShared<Req, Res, Not>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    fn procedure(&self) -> &Procedure {
        &self.procedure
    }

    fn window(&self) -> Option<u64> {
        self.window
    }

    // the other end forgot the subscription: the callbacks hear nothing more, their registrations
    // have nothing left to take away, and the next asks anew
    fn drop_with(&self, failure: Option<&Failure>) {
        {
            let mut state = locked(&self.state);

            state.generation = state.generation.saturating_add(1);
            state.subscription = None;
            state.callbacks.clear();
        }

        let listeners = locked(&self.manager.dropped).clone();

        for listener in listeners {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener(&self.procedure, failure);
            }));

            if let Err(panicked) = called {
                self.manager
                    .router
                    .report(&crate::transport::panic_error(&*panicked), None);
            }
        }
    }

    fn trigger(
        &self,
        payload: Bytes,
    ) -> Result<BoxFuture<Vec<Result<(), Arc<dyn Error + Send + Sync>>>>, RouterError> {
        if !self
            .liked()
            .is_some_and(|liked| self.router.has_notification(&liked))
        {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(format!(
                "{} should not have been triggered",
                self.procedure.name
            )))));
        }

        // a notification that does not decode fails here, for the router to report
        let value = match crate::payloads::decoded(&self.codec, &payload) {
            Ok(value) => value,
            Err(refused) => {
                let failure = Failure::protocol(
                    ProtocolCode::PAYLOAD_UNDECODABLE,
                    crate::constants::RouterSide::Client,
                )
                .saying(refused.reason().to_owned())
                .of_call(Some(self.procedure.address()), None)
                .caused_by(Arc::new(refused));
                let error = RouterError::Failure(failure);

                self.trace((Some(error.clone()), None));

                return Err(error);
            }
        };

        self.trace((None, Some(value.clone())));

        let callbacks: Vec<NotificationCallback<Not::Value>> = locked(&self.state)
            .callbacks
            .iter()
            .map(|(_, callback)| Arc::clone(callback))
            .collect();
        let settling: Vec<BoxFuture<Result<(), Arc<dyn Error + Send + Sync>>>> = callbacks
            .iter()
            .map(|callback| callback(value.clone()))
            .collect();

        Ok(Box::pin(async move {
            let mut settled = Vec::new();

            for each in settling {
                settled.push(each.await);
            }

            settled
        }))
    }
}

// what takes a registration away, its types set aside
trait Unregistering: Send + Sync {
    fn unregister(&self, registration: (u64, u64)) -> BoxFuture<Result<(), CallError>>;
}

impl<Req, Res, Not> Unregistering for NotificationShared<Req, Res, Not>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    fn unregister(&self, (id, own): (u64, u64)) -> BoxFuture<Result<(), CallError>> {
        let leaving = {
            let mut state = locked(&self.state);

            // taken away already, or dropped with its connection
            if own != state.generation || !state.callbacks.iter().any(|(held, _)| *held == id) {
                return Box::pin(async { Ok(()) });
            }

            state.callbacks.retain(|(held, _)| *held != id);

            state.callbacks.is_empty().then(|| {
                let settling = Arc::new(Settling::default());

                state.unregistering = Some(Arc::clone(&settling));

                settling
            })
        };
        let Some(settling) = leaving else {
            return Box::pin(async { Ok(()) });
        };
        let Some(own) = locked(&self.own).upgrade() else {
            return Box::pin(async { Ok(()) });
        };

        Box::pin(async move {
            let left = own.leave().await;

            settling.settle(left.clone());

            {
                let mut state = locked(&own.state);

                if state
                    .unregistering
                    .as_ref()
                    .is_some_and(|held| Arc::ptr_eq(held, &settling))
                {
                    state.unregistering = None;
                }
            }

            left
        })
    }
}

/// A registration of a notification's callback: what takes it away.
pub struct NotificationRegistration {
    shared: Arc<dyn Unregistering>,
    id: u64,
    own: u64,
}

impl fmt::Debug for NotificationRegistration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationRegistration")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl NotificationRegistration {
    /// Takes its callback away; the last out leaves the subscription.
    pub fn unregister(&self) -> BoxFuture<Result<(), CallError>> {
        self.shared.unregister((self.id, self.own))
    }
}

/// A notification a client hears, one per procedure: what registers a callback to it.
pub struct Notification<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    shared: Arc<NotificationShared<Req, Res, Not>>,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> Clone
    for Notification<Req, Res, Not>
{
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for Notification<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Notification")
            .field("procedure", &self.shared.procedure)
            .finish_non_exhaustive()
    }
}

impl<Req, Res, Not> Notification<Req, Res, Not>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    /// Its procedure.
    #[must_use]
    pub fn procedure(&self) -> &Procedure {
        &self.shared.procedure
    }

    /// What its router holds of it.
    #[must_use]
    pub fn as_like(&self) -> Arc<dyn NotificationLike> {
        let liked: Arc<dyn NotificationLike> =
            Arc::<NotificationShared<Req, Res, Not>>::clone(&self.shared);

        liked
    }

    /// Registers `callback`, listening first: its subscribing call goes with `payload` when no
    /// subscription is held, and the registration waits for it.
    pub fn on(
        &self,
        (payload, callback): (Req::Value, NotificationCallback<Not::Value>),
        options: RequestOptions,
    ) -> BoxFuture<Result<NotificationRegistration, CallError>> {
        let shared = Arc::clone(&self.shared);
        let (id, own, unregistering) = {
            let mut state = locked(&shared.state);
            let id = state.next;

            state.next = state.next.saturating_add(1);
            // listening first, so a notification the registration lets through is not lost
            state.callbacks.push((id, callback));

            (id, state.generation, state.unregistering.clone())
        };

        Box::pin(async move {
            if let Some(unregistering) = unregistering {
                drop(unregistering.wait().await);
            }

            // a registration in flight is waited on even when the router already holds it
            let registering = {
                let liked = shared.liked();
                let mut state = locked(&shared.state);
                let is_held = liked.is_some_and(|liked| shared.router.has_notification(&liked));

                if state.registering.is_none() && !is_held {
                    let settling = Arc::new(Settling::default());
                    let registering = Arc::clone(&shared);
                    let settled = Arc::clone(&settling);

                    state.registering = Some(Arc::clone(&settling));
                    drop(state);
                    shared.manager.router.cover(async move {
                        let registered = registering.register((payload, options)).await;

                        {
                            let mut state = locked(&registering.state);

                            if state
                                .registering
                                .as_ref()
                                .is_some_and(|held| Arc::ptr_eq(held, &settled))
                            {
                                state.registering = None;
                            }
                        }

                        settled.settle(registered);
                    });

                    Some(settling)
                } else {
                    state.registering.clone()
                }
            };
            let outcome = match registering {
                Some(registering) => registering.wait().await,
                None => Ok(()),
            };
            let generation = locked(&shared.state).generation;
            let outcome = outcome.and_then(|()| {
                // dropped with its connection meanwhile: nothing is left to listen to
                if own == generation {
                    Ok(())
                } else {
                    Err(CallError::Disconnected(format!(
                        "{} was dropped with its connection",
                        shared.procedure.name
                    )))
                }
            });

            if let Err(error) = outcome {
                locked(&shared.state)
                    .callbacks
                    .retain(|(held, _)| *held != id);

                return Err(error);
            }

            let unregistering: Arc<dyn Unregistering> = shared;

            Ok(NotificationRegistration {
                shared: unregistering,
                id,
                own,
            })
        })
    }
}

/// A notification a manager made, kept for its life: asked for again, the same is given.
pub(super) struct Known {
    procedure: Procedure,
    window: Option<u64>,
    notification: Arc<dyn Any + Send + Sync>,
}

// what tells two declarations of one procedure apart
fn difference_of(known: &Procedure, asked: &Procedure) -> Option<String> {
    if known.kind != asked.kind {
        return Some(format!("kind {:?}, not {:?}", known.kind, asked.kind));
    }

    if known.maximum_payload_bytes != asked.maximum_payload_bytes {
        return Some(format!(
            "maximumPayloadBytes {:?}, not {:?}",
            known.maximum_payload_bytes, asked.maximum_payload_bytes
        ));
    }

    if known.name != asked.name {
        return Some(format!("procedureName {}, not {}", known.name, asked.name));
    }

    if known.service_revision != asked.service_revision {
        return Some(format!(
            "serviceRevision {}, not {}",
            known.service_revision, asked.service_revision
        ));
    }

    (known.deprecation != asked.deprecation).then(|| "another deprecation".to_owned())
}

fn window_of(window: Option<u64>) -> String {
    window.map_or_else(
        || "no window".to_owned(),
        |window| format!("window {window}"),
    )
}

// the notification of `procedure`, one per procedure: asked for again, the same is given
pub(super) fn notification_of<Req, Res, Not>(
    manager: &ServiceManager,
    (procedure, dependencies): (&Procedure, NotificationDependencies<Req, Res, Not>),
) -> Result<Notification<Req, Res, Not>, ProgrammerError>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    // * the router's check before the manager's own reason, so spec 16.10's order holds here too
    check_declaration(procedure)?;

    let key = (procedure.service_id, procedure.id);
    let known = locked(&manager.inner.notifications).get(&key).map(|known| {
        (
            known.procedure.clone(),
            known.window,
            Arc::clone(&known.notification),
        )
    });

    if let Some((held, window, notification)) = known {
        let difference = difference_of(&held, procedure).or_else(|| {
            (window != dependencies.window).then(|| {
                format!(
                    "{}, not {}",
                    window_of(window),
                    window_of(dependencies.window)
                )
            })
        });

        if let Some(difference) = difference {
            return Err(ProgrammerError::new(format!(
                "{}/{} is already a notification with {difference}",
                procedure.service_id, procedure.id
            )));
        }

        return notification
            .downcast_ref::<Notification<Req, Res, Not>>()
            .cloned()
            .ok_or_else(|| {
                ProgrammerError::new(format!(
                    "{}/{} is already a notification of other payloads",
                    procedure.service_id, procedure.id
                ))
            });
    }

    if dependencies.window == Some(0) {
        return Err(ProgrammerError::new(
            "a window is a whole number above 0, not 0",
        ));
    }

    let ServiceRouter::Client(router) = &manager.inner.router else {
        return Err(ProgrammerError::new(
            "only a client hears notifications; a server notifies them",
        ));
    };
    let requester = manager.requester_of(
        procedure,
        (
            RequestDependencies {
                request: dependencies.request,
                result: dependencies.result,
                validate: dependencies.validate,
                fail_fast: dependencies.fail_fast,
            },
            DebugType::Request,
        ),
    )?;
    let shared = Arc::new(NotificationShared {
        manager: Arc::clone(&manager.inner),
        router: router.clone(),
        procedure: procedure.clone(),
        requester,
        codec: dependencies.notification,
        unsubscribe: dependencies.unsubscribe,
        window: dependencies.window,
        state: Mutex::new(State {
            callbacks: Vec::new(),
            next: 1,
            registering: None,
            unregistering: None,
            subscription: None,
            generation: 0,
        }),
        own: Mutex::new(Weak::new()),
    });

    *locked(&shared.own) = Arc::downgrade(&shared);

    let notification = Notification { shared };
    let kept: Arc<dyn Any + Send + Sync> = Arc::new(notification.clone());

    locked(&manager.inner.notifications).insert(
        key,
        Known {
            procedure: procedure.clone(),
            window: dependencies.window,
            notification: kept,
        },
    );

    Ok(notification)
}
