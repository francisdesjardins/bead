//! A client's router of the test's own beneath a service manager, through the port it runs over, as
//! the TypeScript side's fake router is: it draws call 7 for each request, or none, and answers each
//! with its payload; it holds a notification as it registers it, then waits on a gate as a
//! subscription would, and fails it when told; it lets go of one as it unregisters it, then waits on
//! a gate of its own. Kept inside the crate: the port is.

use core::future::Future;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use tokio::sync::{Notify, oneshot, watch};

use crate::clock::SharedClock;
use crate::constants::RouterSide;
use crate::envelope::ResultHeader;
use crate::errors::{CallError, ProgrammerError};
use crate::identity::Procedure;
use crate::managers::service::{RouterLike, ServiceManager, ServiceManagerOptions, ServiceRouter};
use crate::metrics::ProcedureSeries;
use crate::router::client::{
    NotificationLike, RouterClient, RouterClientOptions, UnregisterNotificationOptions,
};
use crate::router::core::Handler;
use crate::router::server::Call;
use crate::router::types::{
    BoxFuture, ConnectionHandle, LIMIT_DEFAULTS, RouterError, RouterLimits, RouterRequest,
    RouterResult,
};
use crate::testing::scripted::ScriptedClient;
use crate::testing::{SteppingClock, instants};
use crate::transport::RouterClientTransport;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn key_of(procedure: &Procedure) -> (u16, u16) {
    (procedure.service_id, procedure.procedure_id)
}

/// What a step waits on: open, it lets each through at once; closed, it holds each until it opens.
#[derive(Debug)]
pub(crate) struct Gate(watch::Sender<bool>);

impl Gate {
    fn opened() -> Self {
        Self(watch::Sender::new(true))
    }

    /// Holds each step from now on, until it opens.
    pub(crate) fn close(&self) {
        self.0.send_replace(false);
    }

    /// Lets through each step it holds, and each after.
    pub(crate) fn open(&self) {
        self.0.send_replace(true);
    }

    // done once it is open
    fn passed(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut seen = self.0.subscribe();

        async move {
            drop(seen.wait_for(|open| *open).await);
        }
    }
}

/// What a fake router answers with, as its test sets it.
#[derive(Debug)]
pub(crate) struct Control {
    /// The id each request draws, heard through its `on_call_id`: 7 unless set, none for a router
    /// that draws none.
    pub(crate) call_id: Mutex<Option<u32>>,
    /// What a registration waits on once the router holds its notification, as a subscription
    /// would: open unless closed.
    pub(crate) subscribing: Gate,
    /// What a registration fails with once past its gate: none unless set.
    pub(crate) subscribe_error: Mutex<Option<CallError>>,
    /// What an unregistration waits on once the router let go of its notification: open unless
    /// closed.
    pub(crate) unregistering: Gate,
}

/// What a fake router was handed.
#[derive(Debug, Clone, Default)]
pub(crate) struct Calls {
    /// Each request, by its procedure's name, with its payload, in the order it was made.
    pub(crate) requests: Vec<(String, Bytes)>,
    /// Each notification it was told to let go of, by its procedure's name, with whether its
    /// subscription is cancelled at the other end.
    pub(crate) unregistered: Vec<(String, bool)>,
}

#[derive(Debug)]
struct Shared {
    clock: SharedClock,
    control: Control,
    calls: Mutex<Calls>,
    notifications: Mutex<BTreeMap<(u16, u16), Arc<dyn NotificationLike>>>,
    held: Notify,
}

/// A client's router of the test's own, through the port a service manager runs over.
#[derive(Debug, Clone)]
pub(crate) struct FakeRouter {
    shared: Arc<Shared>,
}

impl FakeRouter {
    /// A client's router on a stepping clock at the new year, which draws call 7 for each request and
    /// lets each registration and unregistration through at once.
    pub(crate) fn client() -> Self {
        let clock: SharedClock = SteppingClock::new(instants::new_year());

        Self {
            shared: Arc::new(Shared {
                clock,
                control: Control {
                    call_id: Mutex::new(Some(7)),
                    subscribing: Gate::opened(),
                    subscribe_error: Mutex::default(),
                    unregistering: Gate::opened(),
                },
                calls: Mutex::default(),
                notifications: Mutex::default(),
                held: Notify::new(),
            }),
        }
    }

    /// What it answers with, to set.
    pub(crate) fn control(&self) -> &Control {
        &self.shared.control
    }

    /// What it was handed so far.
    pub(crate) fn calls(&self) -> Calls {
        locked(&self.shared.calls).clone()
    }

    /// A manager over it. The router [`ServiceManager::router`] gives back is a client's of a
    /// scripted transport on its clock, which the manager never reads: the variant over the port is
    /// ahead.
    pub(crate) fn manager(&self) -> ServiceManager {
        let transport: Arc<dyn RouterClientTransport> =
            ScriptedClient::new(Arc::clone(&self.shared.clock));
        let router = RouterClient::new(transport, &RouterClientOptions::default())
            .expect("a client's router");
        let port: Arc<dyn RouterLike> = Arc::new(self.clone());

        ServiceManager::over(
            (ServiceRouter::Client(router), port),
            &ServiceManagerOptions::default(),
        )
        .expect("a manager over a fake router")
    }

    /// Whether it holds a notification of `procedure`, whichever it is.
    pub(crate) fn holds(&self, procedure: &Procedure) -> bool {
        locked(&self.shared.notifications).contains_key(&key_of(procedure))
    }

    /// Done once it holds a notification of `procedure`.
    pub(crate) async fn holding(&self, procedure: &Procedure) {
        loop {
            let notified = self.shared.held.notified();
            let mut notified = core::pin::pin!(notified);

            notified.as_mut().enable();

            if self.holds(procedure) {
                return;
            }

            notified.await;
        }
    }

    /// Hands `payload` to the notification it holds of `procedure`, as a notification come for its
    /// subscription, done once every callback settled; nothing for one it does not hold.
    pub(crate) async fn deliver(&self, procedure: &Procedure, payload: &'static [u8]) {
        let held = locked(&self.shared.notifications)
            .get(&key_of(procedure))
            .cloned();

        if let Some(settling) = held.and_then(|held| held.trigger(Bytes::from_static(payload)).ok())
        {
            drop(settling.await);
        }
    }
}

impl RouterLike for FakeRouter {
    fn side(&self) -> RouterSide {
        RouterSide::Client
    }

    fn limits(&self) -> RouterLimits {
        LIMIT_DEFAULTS
    }

    fn clock(&self) -> SharedClock {
        Arc::clone(&self.shared.clock)
    }

    fn report(&self, _error: &RouterError, _connection_handle: Option<&ConnectionHandle>) {}

    fn declare_requester(
        &self,
        _procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError> {
        Ok(None)
    }

    fn register_resolver(
        &self,
        _procedure: &Procedure,
        _handler: Handler,
    ) -> Result<(), ProgrammerError> {
        Ok(())
    }

    fn request(&self, payload: Bytes, mut request: RouterRequest) -> Result<Call, ProgrammerError> {
        // ! fired with the id it draws, or dropped unfired here, never kept: what waits on it reads
        // none, rather than waiting for a request no one lets go of
        let call_id = *locked(&self.shared.control.call_id);

        match (call_id, request.on_call_id.take()) {
            (Some(call_id), Some(on_call_id)) => on_call_id(call_id),
            (_, unfired) => drop(unfired),
        }

        locked(&self.shared.calls)
            .requests
            .push((request.procedure.procedure_name.clone(), payload.clone()));

        if let Some(refusal) = request.refusal {
            return Ok(Call::refused(refusal));
        }

        let (answer, answered) = oneshot::channel();

        drop(answer.send(Ok(RouterResult {
            header: ResultHeader {
                call_id: 7,
                total: None,
                credential: None,
            },
            payload,
        })));

        Ok(Call::of(answered))
    }

    fn cover(&self, future: BoxFuture<()>) {
        drop(crate::testing::spawn(future));
    }

    fn has_notification(&self, notification: &Arc<dyn NotificationLike>) -> bool {
        locked(&self.shared.notifications)
            .get(&key_of(notification.procedure()))
            .is_some_and(|held| Arc::ptr_eq(held, notification))
    }

    // * held first, then subscribed, as a router over a broker does
    fn register_notification(
        &self,
        notification: Arc<dyn NotificationLike>,
    ) -> Result<BoxFuture<Result<(), CallError>>, ProgrammerError> {
        let procedure = notification.procedure().clone();

        {
            let mut notifications = locked(&self.shared.notifications);

            if notifications.contains_key(&key_of(&procedure)) {
                return Err(ProgrammerError::new(format!(
                    "{} is already a registered notification",
                    procedure.procedure_name
                )));
            }

            notifications.insert(key_of(&procedure), notification);
        }

        self.shared.held.notify_waiters();

        let passed = self.shared.control.subscribing.passed();
        let shared = Arc::clone(&self.shared);

        Ok(Box::pin(async move {
            passed.await;

            locked(&shared.control.subscribe_error)
                .clone()
                .map_or(Ok(()), Err)
        }))
    }

    fn unregister_notification(
        &self,
        notification: &Arc<dyn NotificationLike>,
        options: &UnregisterNotificationOptions,
    ) -> BoxFuture<()> {
        let procedure = notification.procedure();

        locked(&self.shared.calls).unregistered.push((
            procedure.procedure_name.clone(),
            options.cancel.unwrap_or(true),
        ));

        {
            let mut notifications = locked(&self.shared.notifications);

            // another's of the same procedure stays: only what registered takes itself away
            if notifications
                .get(&key_of(procedure))
                .is_some_and(|held| Arc::ptr_eq(held, notification))
            {
                notifications.remove(&key_of(procedure));
            }
        }

        Box::pin(self.shared.control.unregistering.passed())
    }
}
