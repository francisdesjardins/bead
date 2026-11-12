//! A notification a client hears: its subscribing call made once its first callback registers, each
//! payload handed to every callback registered, and the subscription left once the last is taken
//! away.

use core::any::Any;
use core::fmt;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::sync::{Notify, oneshot};

use super::{
    Inner, Maker, RegistrationOptions, Request, RequestDependencies, RouterLike, ServiceManager,
    Step, Validate, traced,
};
use crate::constants::ProtocolCode;
use crate::debug::{DebugDirection, DebugType};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::payloads::PayloadCodec;
use crate::router::client::{NotificationLike, UnregisterNotificationOptions};
use crate::router::core::DISPOSED;
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
    /// A requester's `dependencies`, and the codec of the notification it hears: unpaced, its
    /// subscription cancelled as it is left.
    #[must_use]
    pub fn new(dependencies: RequestDependencies<Req, Res>, notification: Not) -> Self {
        let RequestDependencies {
            request,
            result,
            validate,
            fail_fast,
        } = dependencies;

        Self {
            request,
            result,
            notification,
            validate,
            fail_fast,
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
    // its manager's router, a client's, through the port
    router: Arc<dyn RouterLike>,
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
    // anything waiting on the answer runs; asked for once its router subscribed it
    async fn register(
        &self,
        (payload, options): (Req::Value, RegistrationOptions),
    ) -> Result<(), CallError> {
        let liked = self
            .liked()
            .ok_or_else(|| CallError::Disconnected(DISPOSED.to_owned()))?;
        let registered = async {
            self.router
                .register_notification(Arc::clone(&liked))
                .map_err(CallError::Refused)?
                .await?;

            let (call_id, response) = self
                .requester
                .subscribe_with(payload, (&options, Arc::clone(&liked)))
                .map_err(CallError::Refused)?
                .with_call_id()
                .await?;

            locked(&self.state).subscription = Some((call_id, response));

            Ok(())
        }
        .await;

        // a router may hold it when what follows fails, as a subscription can
        if registered.is_err() && self.router.has_notification(&liked) {
            self.router
                .unregister_notification(&liked, &UnregisterNotificationOptions::default())
                .await;
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
            let options = UnregisterNotificationOptions {
                cancel: Some(!is_acknowledged),
            };

            self.router.unregister_notification(&liked, &options).await;
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

        let listeners = self.manager.dropped.all();

        for listener in listeners {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener(&self.procedure, failure);
            }));

            if let Err(panicked) = called {
                self.router
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
                self.procedure.procedure_name
            )))));
        }

        // a notification that does not decode fails here, for the router to report; its codec's
        // panic fails it as its refusal does (spec 17.2, item 3)
        let value = match crate::payloads::decoded(&self.codec, &payload)
            .unwrap_or_else(|panicked| Err(crate::payloads::refusal_saying(&panicked)))
        {
            Ok(value) => value,
            Err(refused) => {
                let failure = Failure::protocol(
                    ProtocolCode::PAYLOAD_UNDECODABLE,
                    crate::constants::RouterSide::Client,
                )
                // ! a detail of the side's own words: its codec's reason, in spec 17.2's words;
                // the rest in its cause
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
        let (reply, outcome) = oneshot::channel();
        let router = Arc::clone(&own.router);

        // * the leave goes as it is made, in a task of its own: its future only waits, and one
        // dropped leaves no registration after it waiting on a leave that never settles
        router.cover(Box::pin(async move {
            let left = own.leave().await;

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

            settling.settle(left.clone());
            drop(reply.send(left));
        }));

        Box::pin(async move {
            outcome
                .await
                .unwrap_or_else(|_gone| Err(CallError::Disconnected(DISPOSED.to_owned())))
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
    ///
    /// # Errors
    ///
    /// A [`CallError`] when its router cannot end the subscription.
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
    ///
    /// # Errors
    ///
    /// A [`CallError`] when the subscribing call is refused, cancelled, disconnected or fails.
    pub fn register(
        &self,
        payload: Req::Value,
        callback: NotificationCallback<Not::Value>,
        options: &RegistrationOptions,
    ) -> BoxFuture<Result<NotificationRegistration, CallError>> {
        let shared = Arc::clone(&self.shared);
        let liked = shared.liked();
        // * decided as it is made: the first registration made is the one whose payload subscribes
        let (id, own, way) = {
            let mut state = locked(&shared.state);
            let id = state.next;

            state.next = state.next.saturating_add(1);
            // listening first, so a notification the registration lets through is not lost
            state.callbacks.push((id, callback));

            // ! a leave under way still has its router hold the notification: what comes after it
            // subscribes anew once it settled
            let is_held = state.unregistering.is_none()
                && liked.is_some_and(|liked| shared.router.has_notification(&liked));
            let way = match (state.registering.clone(), is_held) {
                (Some(registering), _) => Way::Joins(registering),
                (None, true) => Way::Held,
                (None, false) => {
                    let settling = Arc::new(Settling::default());

                    state.registering = Some(Arc::clone(&settling));

                    Way::Subscribes {
                        settling,
                        after: state.unregistering.clone(),
                    }
                }
            };

            (id, state.generation, way)
        };

        if matches!(way, Way::Held) {
            let unregistering: Arc<dyn Unregistering> = shared;

            return Box::pin(async move {
                Ok(NotificationRegistration {
                    shared: unregistering,
                    id,
                    own,
                })
            });
        }

        let (reply, outcome) = oneshot::channel();
        let options = options.clone();
        let registering = Arc::clone(&shared);

        // * the registration goes as it is made, in a task of its own: its future only waits, and
        // one dropped subscribes all the same
        shared.router.cover(Box::pin(async move {
            let shared = registering;
            let subscribed = match way {
                Way::Joins(registering) => registering.wait().await,
                Way::Held => Ok(()),
                Way::Subscribes { settling, after } => {
                    if let Some(unregistering) = after {
                        drop(unregistering.wait().await);
                    }

                    let registered = shared.register((payload, options)).await;

                    {
                        let mut state = locked(&shared.state);

                        if state
                            .registering
                            .as_ref()
                            .is_some_and(|held| Arc::ptr_eq(held, &settling))
                        {
                            state.registering = None;
                        }
                    }

                    // ! its own outcome told before the registrations that joined it hear theirs
                    let told = registered.clone();
                    let outcome = outcome_of(&shared, ((id, own), told));

                    drop(reply.send(outcome));
                    settling.settle(registered);

                    return;
                }
            };
            let outcome = outcome_of(&shared, ((id, own), subscribed));

            drop(reply.send(outcome));
        }));

        Box::pin(async move {
            outcome
                .await
                .unwrap_or_else(|_gone| Err(CallError::Disconnected(DISPOSED.to_owned())))
        })
    }
}

// how a registration is made, decided as it is: it joins the subscription under way, finds it
// held, or subscribes, once the leave under way settled
enum Way {
    Joins(Arc<Settling>),
    Held,
    Subscribes {
        settling: Arc<Settling>,
        after: Option<Arc<Settling>>,
    },
}

// a registration's outcome once its subscription settled: a callback whose subscription failed, or
// went with its connection meanwhile, listens no more
fn outcome_of<Req, Res, Not>(
    shared: &Arc<NotificationShared<Req, Res, Not>>,
    ((id, own), subscribed): ((u64, u64), Result<(), CallError>),
) -> Result<NotificationRegistration, CallError>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    let generation = locked(&shared.state).generation;
    let outcome = subscribed.and_then(|()| {
        // dropped with its connection meanwhile: nothing is left to listen to
        if own == generation {
            Ok(())
        } else {
            Err(CallError::Disconnected(format!(
                "{} was dropped with its connection",
                shared.procedure.procedure_name
            )))
        }
    });

    if let Err(error) = outcome {
        locked(&shared.state)
            .callbacks
            .retain(|(held, _)| *held != id);

        return Err(error);
    }

    let unregistering: Arc<dyn Unregistering> =
        Arc::<NotificationShared<Req, Res, Not>>::clone(shared);

    Ok(NotificationRegistration {
        shared: unregistering,
        id,
        own,
    })
}

/// A notification a manager made, kept for its life: asked for again, the same is given.
pub(super) struct Known {
    procedure: Procedure,
    window: Option<u64>,
    notification: Arc<dyn Any + Send + Sync>,
}

// what tells two declarations of one procedure apart
fn difference_of(known: &Procedure, asked: &Procedure) -> Option<String> {
    if known.procedure_kind != asked.procedure_kind {
        return Some(format!(
            "kind {:?}, not {:?}",
            known.procedure_kind, asked.procedure_kind
        ));
    }

    if known.maximum_payload_bytes != asked.maximum_payload_bytes {
        return Some(format!(
            "maximumPayloadBytes {:?}, not {:?}",
            known.maximum_payload_bytes, asked.maximum_payload_bytes
        ));
    }

    if known.procedure_name != asked.procedure_name {
        return Some(format!(
            "procedureName {}, not {}",
            known.procedure_name, asked.procedure_name
        ));
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
    // * the side first, then spec 16.10's reasons for its way, before the manager's own reasons
    manager.checked((procedure, Maker::Notification))?;

    let key = (procedure.service_id, procedure.procedure_id);
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
                procedure.service_id, procedure.procedure_id
            )));
        }

        return notification
            .downcast_ref::<Notification<Req, Res, Not>>()
            .cloned()
            .ok_or_else(|| {
                ProgrammerError::new(format!(
                    "{}/{} is already a notification of other payloads",
                    procedure.service_id, procedure.procedure_id
                ))
            });
    }

    if dependencies.window == Some(0) {
        return Err(ProgrammerError::new(
            "a window is a whole number above 0, not 0",
        ));
    }

    let requester = Request {
        shared: manager.requester_of(
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
        )?,
    };
    let shared = Arc::new(NotificationShared {
        manager: Arc::clone(&manager.inner),
        router: Arc::clone(&manager.inner.port),
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
