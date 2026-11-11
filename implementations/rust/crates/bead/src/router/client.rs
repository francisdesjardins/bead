//! The client side of a router (spec 9 to 13): its requests go to its one connection's server, on
//! odd call ids; the server's commands go to the resolvers registered; each notification goes to
//! the subscription of its call id, paced where it asked.

use core::fmt;
use core::time::Duration;
use std::collections::BTreeMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::call_session::{Carriage, connection_session_of, presented_credential_of, uncarried_of};
use crate::clock::SharedClock;
use crate::constants::{CredentialScheme, ProtocolCode, RouterSide, SERVER_CONNECTION_HANDLE};
use crate::credentials::{
    CredentialRequest, CredentialResolver, Credentials, assert_limits_hold_jwt,
};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{
    Credential, CreditHeader, Envelope, EnvelopeHeader, FailureHeader, FailureRecord,
    NotificationHeader,
};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::{Failure, FailureOrigin};
use crate::identity::{DeclarationWay, Procedure, check_declaration, check_procedure_kind};
use crate::metrics::{MetricsRegistry, NotificationSeries, ProcedureSeries, RouterMetrics};
use crate::owner::{Owner, WeakOwner};
use crate::router::core::{
    Core, Disposal, Handler, Resolution, Resolved, Resolvers, SessionRequest, Side,
};
use crate::router::intake::Intake;
use crate::router::relay::{RelayLeg, RelayRouter};
use crate::router::requester::{CoreRequest, OnDrawn};
use crate::router::server::Call;
use crate::router::types::{
    BoxFuture, CallAddress, ConnectionHandle, Gauges, IntakeLimitsOptions, RequestCredential,
    RouterActivity, RouterError, RouterLimits, RouterLimitsOptions, RouterRequest, RouterResult,
    Signal, TransportMessage, intake_limits_of, limits_of,
};
use crate::session_token::SessionToken;
use crate::transport::{
    ClientListener, Listened, ListenerId, Panicked, RouterClientTransport, Sent, caught,
};

/// A notification a client's router hears: its procedure, its window, and what hears each payload
/// and its drop.
pub trait NotificationLike: Send + Sync + fmt::Debug {
    /// Its procedure.
    fn procedure(&self) -> &Procedure;

    /// The notifications its subscription takes ahead of what its callbacks settled, when paced.
    fn window(&self) -> Option<u64> {
        None
    }

    /// Its subscription forgotten, with its connection or with a failure.
    fn drop_with(&self, _failure: Option<&Failure>) {}

    /// A payload heard: what each callback settles with, to wait on.
    ///
    /// # Errors
    ///
    /// A [`RouterError`] for a payload that does not decode, which its router reports.
    fn trigger(&self, payload: Bytes) -> Result<BoxFuture<Settled>, RouterError>;
}

/// What each callback of a notification settled with: nothing, or why it failed.
pub type Settled = Vec<Result<(), Arc<dyn Error + Send + Sync>>>;

// the notification registered for each procedure, shared by a router's handle and its owner
type Registered = Arc<Mutex<BTreeMap<(u16, u16), Arc<dyn NotificationLike>>>>;

/// What hears what a client's router reports.
pub type ClientErrorListener = Arc<dyn Fn(&RouterError) + Send + Sync>;

/// What hears each envelope a client's router sends or takes, its header redacted.
pub type ClientEnvelopeListener = Arc<dyn Fn(DebugDirection, &TracedEnvelope) + Send + Sync>;

/// What hears what a client's router did.
pub type ClientActivityListener = Arc<dyn Fn(RouterActivity) + Send + Sync>;

/// What hears the scheme of the default credential its router withdrew.
pub type WithdrawnListener = Arc<dyn Fn(CredentialScheme) + Send + Sync>;

/// How a client's router is built, beyond its transport.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct RouterClientOptions {
    /// The clock it runs on: its transport's, which one given must be.
    pub clock: Option<SharedClock>,
    /// The runtime its owner runs on: the current one when none.
    pub runtime: Option<Handle>,
    /// The credential every call presents but one that gives its own: a `JWT` or an `ELSEWHERE`.
    pub credential: Option<RequestCredential>,
    /// What resolves a command's `JWT` and `ELSEWHERE`.
    pub credentials: Option<Credentials>,
    /// How much it reads, writes and holds.
    pub limits: Option<RouterLimitsOptions>,
    /// The last call id it draws, of its own parity: its whole range when none.
    pub last_call_id: Option<u32>,
    /// What it counts its calls into.
    pub metrics_registry: Option<MetricsRegistry>,
    /// What it holds untaken of what its server sent, past which it pauses its transport (spec
    /// 15.12): [`crate::INTAKE_DEFAULTS`] where it says nothing.
    pub intake: Option<IntakeLimitsOptions>,
}

impl fmt::Debug for RouterClientOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouterClientOptions")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

/// How a client's router unregisters a notification.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct UnregisterNotificationOptions {
    /// Whether its subscription is cancelled at the server, or only forgotten: `true` when none.
    pub cancel: Option<bool>,
}

// a paced subscription's credit, and what its callbacks settled
#[derive(Debug, Clone, Copy)]
struct ClientPacing {
    credit_end: u64,
    settled: u64,
    window: u64,
}

// a subscription, by the call id that opened it
struct Bound {
    hearing: Option<NotificationSeries>,
    is_answered: bool,
    notification: Arc<dyn NotificationLike>,
    pacing: Option<ClientPacing>,
    timeout: Duration,
}

#[derive(Default)]
struct ClientListeners {
    error: Listened<ClientErrorListener>,
    debug: Listened<ClientEnvelopeListener>,
    activity: Listened<ClientActivityListener>,
    withdrawn: Listened<WithdrawnListener>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ClientListeners {
    fn report(&self, error: &RouterError) {
        for listener in self.error.all() {
            // ! a listener of errors that panics would loop: its panic is dropped (spec 15.1)
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(error)));

            drop(called);
        }
    }

    // each listener within a guard: what one panics is reported, and the others heard
    fn guarded<T: Clone, C: Fn(&T)>(&self, (listeners, call): (&Listened<T>, C)) {
        for listener in listeners.all() {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&listener)));

            if let Err(panicked) = called {
                self.report(&crate::transport::panic_error(&*panicked));
            }
        }
    }
}

// the default credential, and whether it was withdrawn
#[derive(Debug, Default)]
struct Default_ {
    credential: Option<RequestCredential>,
    is_withdrawn: bool,
}

// what a notification registered is keyed by: its procedure's address
fn key_of(notification: &dyn NotificationLike) -> (u16, u16) {
    let procedure = notification.procedure();

    (procedure.service_id, procedure.procedure_id)
}

/// What a client's router holds, in its owner.
pub(crate) struct ClientState {
    core: Core<Self>,
    // ! its transport and its bridge held weakly: the transport holds the bridge, which holds the
    // owner, so a strong edge back would keep the owner of its own (decision 0044); the handle holds
    // the transport strongly, so it goes only once nothing holds the router
    transport: Weak<dyn RouterClientTransport>,
    listener: Option<Weak<dyn ClientListener>>,
    // what its transport handed it that no turn took yet, its bridge's count, which its end resumes
    // (decision 0046)
    intake: Arc<Intake>,
    credentials: CredentialResolver,
    notifications: Registered,
    hearings: Arc<Mutex<BTreeMap<(u16, u16), NotificationSeries>>>,
    // each subscription by the call id that opened it, and each notification's call id
    subscriptions: BTreeMap<u32, Bound>,
    call_ids: BTreeMap<(u16, u16), u32>,
    session_token: Arc<Mutex<Option<SessionToken>>>,
    listeners: Arc<ClientListeners>,
}

impl fmt::Debug for ClientState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientState")
            .field("subscriptions", &self.subscriptions.len())
            .finish_non_exhaustive()
    }
}

const SERVER: &str = SERVER_CONNECTION_HANDLE;

fn server_handle() -> ConnectionHandle {
    Arc::from(SERVER)
}

impl ClientState {
    fn report_error(&self, error: &RouterError) {
        self.listeners.report(error);
    }

    // lets go of what it holds: its transport's events, its session, every call; its state marked
    // disposed first (decision 0045)
    fn dispose(&mut self) {
        self.core.mark_disposed();

        // * a transport outlives its router: resumed before it hears no more, and never paused
        // after (decision 0046)
        let transport = self.transport.upgrade();

        self.intake.end(|_server| {
            if let Some(transport) = &transport {
                caught(("a transport", || transport.resume())).ok();
            }
        });

        if let Some(listener) = self.listener.take().and_then(|listener| listener.upgrade())
            && let Some(transport) = transport
        {
            transport.unlisten(&listener);
        }

        *locked(&self.session_token) = None;
        crate::router::core::dispose(self);
        self.drop_notifications();
    }

    // a paced subscription credits as far as its window reaches past what settled, once that is
    // half a window past its credit; one unbound meanwhile credits nothing
    fn renew(&mut self, call_id: u32) {
        let Some(bound) = self.subscriptions.get_mut(&call_id) else {
            return;
        };
        let Some(pacing) = bound.pacing.as_mut() else {
            return;
        };
        let credit_end = pacing.settled.saturating_add(pacing.window);

        if credit_end
            .saturating_sub(pacing.credit_end)
            .saturating_mul(2)
            < pacing.window
        {
            return;
        }

        pacing.credit_end = credit_end;

        let handle = server_handle();

        crate::router::core::send_reporting(
            self,
            (
                Envelope::Credit {
                    header: CreditHeader {
                        call_id,
                        credit_end,
                        paced: true,
                    },
                },
                &handle,
            ),
        );
    }

    // unbinds the call a notification is bound to, and gives its call id and its timeout
    fn unbind(&mut self, key: (u16, u16)) -> Option<(u32, Duration)> {
        let call_id = self.call_ids.remove(&key)?;
        let bound = self.subscriptions.remove(&call_id)?;

        Some((call_id, bound.timeout))
    }

    // the server forgets a connection's subscriptions with it: so does the client, and tells each,
    // counting each answered dropped with no code
    fn drop_notifications(&mut self) {
        let dropped: Vec<Arc<dyn NotificationLike>> = {
            let mut notifications = locked(&self.notifications);
            let dropped = notifications.values().cloned().collect();

            // emptied first, so what a drop registers again is the next connection's
            notifications.clear();

            dropped
        };

        for bound in self.subscriptions.values() {
            if bound.is_answered
                && let Some(hearing) = &bound.hearing
            {
                hearing.dropped(None);
            }
        }

        self.subscriptions.clear();
        self.call_ids.clear();

        for notification in dropped {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                notification.drop_with(None);
            }));

            if let Err(panicked) = called {
                self.report_error(&crate::transport::panic_error(&*panicked));
            }
        }
    }

    fn on_close(&mut self, reason: &str) {
        *locked(&self.session_token) = None;
        crate::router::core::reject_pending(self, (reason, None));
        self.drop_notifications();
    }
}

impl Side for ClientState {
    fn core(&mut self) -> &mut Core<Self> {
        &mut self.core
    }

    fn credential_schemes(&self) -> Vec<CredentialScheme> {
        self.credentials.schemes()
    }

    fn activity(&mut self, activity: RouterActivity, _connection_handle: &ConnectionHandle) {
        let listeners = Arc::clone(&self.listeners);

        listeners.guarded((&listeners.activity, |listener: &ClientActivityListener| {
            listener(activity);
        }));
    }

    fn is_call_id_in_use(&self, call_id: u32, _connection_handle: &ConnectionHandle) -> bool {
        self.subscriptions.contains_key(&call_id)
    }

    fn takes_notifications(&self) -> bool {
        true
    }

    fn on_notification(
        &mut self,
        header: NotificationHeader,
        (_connection_handle, payload): (&ConnectionHandle, Bytes),
    ) {
        let call_id = header.call_id;
        let Some(bound) = self.subscriptions.get(&call_id) else {
            let failure = self
                .core
                .failure(ProtocolCode::SUBSCRIPTION_UNKNOWN)
                .saying(format!("no subscription under call {call_id}"))
                .about(&EnvelopeHeader::Notification(header));

            return self.report_error(&RouterError::Failure(failure));
        };

        // heard as it is paired with its subscription, whether it decodes or not
        if let Some(hearing) = &bound.hearing {
            hearing.heard();
        }

        let notification = Arc::clone(&bound.notification);
        let triggered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            notification.trigger(payload)
        }));
        let settling = match triggered {
            Ok(Ok(settling)) => Some(settling),
            Ok(Err(error)) => {
                self.report_error(&error);

                None
            }
            Err(panicked) => {
                self.report_error(&crate::transport::panic_error(&*panicked));

                None
            }
        };
        let owner = self.core.owner.clone();
        let listeners = Arc::clone(&self.listeners);

        // a callback that fails is reported, and the notifications after it still arrive: a paced
        // subscription counts it done
        self.core.owner.cover(async move {
            if let Some(settling) = settling {
                for settled in settling.await {
                    if let Err(error) = settled {
                        listeners.report(&RouterError::Other(error));
                    }
                }
            }

            owner.offer(Box::new(move |state: &mut Self| {
                if let Some(pacing) = state
                    .subscriptions
                    .get_mut(&call_id)
                    .and_then(|bound| bound.pacing.as_mut())
                {
                    pacing.settled = pacing.settled.saturating_add(1);
                    state.renew(call_id);
                }
            }));
        });

        let handle = server_handle();

        self.activity(RouterActivity::Notification, &handle);
    }

    // a failure after its result ends a subscription the server ended: the notification is dropped
    // here too, and told, so the next registration asks anew
    fn on_unpaired_failure(
        &mut self,
        (header, failure): (&FailureHeader, &FailureRecord),
        _connection_handle: &ConnectionHandle,
    ) -> bool {
        let Some(bound) = self.subscriptions.get(&header.call_id) else {
            return false;
        };
        let (hearing, is_answered, notification) = (
            bound.hearing.clone(),
            bound.is_answered,
            Arc::clone(&bound.notification),
        );
        let key = key_of(notification.as_ref());
        let call = self.unbind(key);
        let received = Failure::received(failure, RouterSide::Client);

        // * dropped at this end once answered; one refused in its own answer is its call's failure
        if is_answered && let Some(hearing) = hearing {
            hearing.dropped(Some(&received));
        }

        {
            let mut notifications = locked(&self.notifications);

            if notifications
                .get(&key)
                .is_some_and(|held| Arc::ptr_eq(held, &notification))
            {
                notifications.remove(&key);
            }
        }

        // the server ended it: nothing is left there to cancel
        if let Some((call_id, timeout)) = call {
            crate::router::requester::reserve(
                self,
                (
                    &CallAddress {
                        connection_handle: server_handle(),
                        call_id,
                    },
                    Some(timeout),
                ),
            );
        }

        let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            notification.drop_with(Some(&received));
        }));

        if let Err(panicked) = called {
            self.report_error(&crate::transport::panic_error(&*panicked));
        }

        true
    }

    // the session is the server's to give: an answer announces it when it changes
    fn on_answer_received(
        &mut self,
        header: &EnvelopeHeader,
        _connection_handle: &ConnectionHandle,
    ) {
        if let Some(credential) = header.credential() {
            *locked(&self.session_token) = match credential {
                Credential::Opaque(token) => Some(*token),
                Credential::None
                | Credential::Jwt(_)
                | Credential::Elsewhere
                | Credential::Redacted { .. }
                | Credential::ToCome { .. } => None,
            };
        }
    }

    fn is_tracing(&self) -> bool {
        !self.listeners.debug.is_empty()
    }

    fn trace(
        &mut self,
        direction: DebugDirection,
        (connection_handle, header): (&ConnectionHandle, &EnvelopeHeader),
    ) {
        let listeners = Arc::clone(&self.listeners);
        let traced = TracedEnvelope::new(connection_handle, header);

        listeners.guarded((&listeners.debug, |listener: &ClientEnvelopeListener| {
            listener(direction, &traced);
        }));
    }

    fn report(&mut self, error: RouterError, _connection_handle: &ConnectionHandle) {
        self.report_error(&error);
    }

    // ! the application's transport, called within the turn: what it panics is its throw, the
    // transport's error, as the other sides' writers take a send that throws (spec 15.1)
    fn transmit(
        &mut self,
        message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let transport = self
            .transport
            .upgrade()
            .ok_or_else(crate::router::core::transport_gone)?;

        caught(("a transport", || transport.send(message)))
            .unwrap_or_else(|panicked| Err(panicked.into()))
    }

    // its calls failed with the panic, then let go of as its dispose does, the panic reported
    fn ended(&mut self, panicked: &Panicked) {
        crate::router::core::end(self, panicked);
        self.dispose();
        self.report_error(&panicked.clone().into());
    }

    // a command runs in the session this client learned; one presenting a JWT or an ELSEWHERE, in
    // the credential's session it resolves to
    fn session_of(&mut self, request: &SessionRequest, signal: &Signal) -> Resolution {
        let header = &request.carried.header;
        let credential = header.credential.clone();

        if let Some(CredentialScheme::JWT | CredentialScheme::ELSEWHERE) =
            credential.as_ref().map(Credential::scheme)
        {
            return Resolution::Later(self.credentials.resolve((
                CredentialRequest {
                    audiences: None,
                    credential: credential.unwrap_or(Credential::None),
                    transport_credential: request.carried.transport_credential.clone(),
                },
                signal.token().clone(),
            )));
        }

        let token = *locked(&self.session_token);
        let session = connection_session_of(credential.as_ref(), (token.as_ref(), None));

        Resolution::Now(Ok(match session {
            Some(session) => Resolved::Session(session),
            None if matches!(credential, Some(Credential::Opaque(_))) => {
                Resolved::Refused("session".to_owned())
            }
            None => Resolved::None,
        }))
    }
}

// what posts a transport's events at its router's owner's queue's tail, a transport that tells one
// from within its router's turn too, taken in a later turn (spec 9.0): ! a handle to the owner, so
// a router lives as long as its transport holds it; its state holds the bridge and its transport
// weakly, so neither keeps it of its own
struct Bridge {
    owner: Owner<ClientState>,
    disposal: Disposal,
    // what its transport handed and no turn took yet, under its one connection's name; its
    // transport, held weakly as its state holds it, paused and resumed by it (decision 0046)
    intake: Arc<Intake>,
    transport: Weak<dyn RouterClientTransport>,
}

impl Bridge {
    // ! what its transport tells once its handle is disposed is dropped, as both other sides stop
    // listening within their dispose: the rest of the dispose, its unlisten among it, comes in a
    // later turn (decision 0045)
    fn offer(&self, job: Box<dyn FnOnce(&mut ClientState) + Send>) {
        if !self.disposal.is_set() {
            self.owner.offer(job);
        }
    }
}

// the transport paused or resumed whole, what it panicked with given back to be reported as its
// error, as the other sides report a pause that throws: what the count decided holds whatever it
// does
fn paced(transport: &Weak<dyn RouterClientTransport>, is_paused: bool) -> Option<Panicked> {
    let transport = transport.upgrade()?;

    caught(("a transport", || {
        if is_paused {
            transport.pause();
        } else {
            transport.resume();
        }
    }))
    .err()
}

impl ClientListener for Bridge {
    // * counted as it is handed, one within a telling among them, and released once the turn that
    // takes it returned, whichever connection carried it: each is taken in its turn, in order, so a
    // close or a reconnection needs no count of its own; a turn that panics ends the owner, whose
    // end resumes its transport (decisions 0044 and 0046)
    fn on_message(&self, message: TransportMessage) {
        if self.disposal.is_set() {
            return;
        }

        let handle = server_handle();
        let bytes = u64::try_from(message.data.len()).unwrap_or(u64::MAX);
        // ! counted before its job is posted, so no turn releases what is not counted yet; the
        // transport paused under the count's lock, and its pair takes no lock it holds as it tells
        let mut broken = None;
        let is_counted = self.intake.handed((&handle, bytes), |_server| {
            broken = paced(&self.transport, true);
        });

        // what its transport panicked with as it paused, reported in a turn of its own
        if let Some(panicked) = broken {
            self.offer(Box::new(move |state: &mut ClientState| {
                state.report_error(&panicked.into());
            }));
        }

        let (intake, transport) = (Arc::clone(&self.intake), Weak::clone(&self.transport));
        let release = move |handle: &ConnectionHandle| {
            let mut broken = None;

            if is_counted {
                intake.taken((handle, bytes), |_server| {
                    broken = paced(&transport, false);
                });
            }

            broken
        };
        let releasing = release.clone();
        let posted = self.owner.post(Box::new(move |state: &mut ClientState| {
            crate::router::core::receive(state, (message, &handle));

            if let Some(panicked) = releasing(&handle) {
                state.report_error(&panicked.into());
            }
        }));

        // an owner gone takes nothing: what it counted is released at once, with no one to tell
        if posted.is_err() {
            drop(release(&server_handle()));
        }
    }

    fn on_close(&self, _was_clean: bool, _is_quick: bool) {
        self.offer(Box::new(|state: &mut ClientState| {
            state.on_close("the connection closed before the answer");
        }));
    }

    // a connection replaced emits no close, but nothing sent on it will be answered either
    fn on_reconnect(&self) {
        self.offer(Box::new(|state: &mut ClientState| {
            state.on_close("the connection was replaced before the answer");
        }));
    }

    // * what its transport reports is its transport's: an application hears it there, whichever
    // transport it built, as on the other sides (spec 15.1)
}

struct Shared {
    #[cfg(test)]
    requester_probe: Mutex<Option<crate::testing::scripted::RequesterProbe>>,
    owner: Owner<ClientState>,
    disposal: Disposal,
    clock: SharedClock,
    limits: RouterLimits,
    metrics: Option<RouterMetrics>,
    transport: Arc<dyn RouterClientTransport>,
    listeners: Arc<ClientListeners>,
    resolvers: Resolvers,
    notifications: Registered,
    hearings: Arc<Mutex<BTreeMap<(u16, u16), NotificationSeries>>>,
    session_token: Arc<Mutex<Option<SessionToken>>>,
    default: Arc<Mutex<Default_>>,
}

/// The client side of a router, over a transport client: a handle to its owner.
#[derive(Clone)]
pub struct RouterClient {
    shared: Arc<Shared>,
}

impl fmt::Debug for RouterClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouterClient")
            .finish_non_exhaustive()
    }
}

// a credential a client presents by default: a JWT or an ELSEWHERE, held as a call presents it
fn default_credential_of(
    credential: Option<RequestCredential>,
    limits: &RouterLimits,
) -> Result<Option<RequestCredential>, ProgrammerError> {
    let Some(credential) = credential else {
        return Ok(None);
    };

    match &credential {
        RequestCredential::Jwt(token) => {
            if token.is_empty() {
                return Err(ProgrammerError::new(
                    "a call that presents a JWT gives its token, a string",
                ));
            }

            assert_limits_hold_jwt(limits)?;
        }
        RequestCredential::Elsewhere(_) => {}
        RequestCredential::None | RequestCredential::Opaque => {
            return Err(ProgrammerError::new(
                "a client presents a JWT or an ELSEWHERE by default, never another scheme: OPAQUE goes on a call that asks for it",
            ));
        }
    }

    Ok(Some(credential))
}

impl RouterClient {
    /// A client's router over `transport`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime or on one without its time driver, for a clock
    /// given that differs from its transport's, limits that do not hold together, credentials that
    /// do not hold, or a default credential that is no `JWT` or `ELSEWHERE`.
    pub fn new(
        transport: Arc<dyn RouterClientTransport>,
        options: &RouterClientOptions,
    ) -> Result<Self, ProgrammerError> {
        let pending = options.last_call_id.map_or_else(
            || Ok(crate::router::parts::PendingCalls::new(RouterSide::Client)),
            |last| crate::router::parts::PendingCalls::bounded(RouterSide::Client, last),
        )?;
        let runtime = crate::platform::runtime_of(options.runtime.as_ref(), "a router")?;
        let clock = crate::clock::clock_of(&crate::clock::LayeredClocks {
            beneath: transport.clock().as_ref(),
            given: options.clock.as_ref(),
            layer: "a client's router",
            below: "its transport",
        })?
        .unwrap_or_else(|| {
            let platform: SharedClock = Arc::new(crate::clock::SystemClock::on(runtime.clone()));

            platform
        });
        let limits = limits_of(&options.limits.clone().unwrap_or_default())?;
        let intake = Intake::new(intake_limits_of(
            &options.intake.clone().unwrap_or_default(),
        )?);
        let credentials = CredentialResolver::new(
            &options.credentials.clone().unwrap_or_default(),
            (Arc::clone(&clock), runtime.clone()),
        )?;

        // a router that takes a JWT holds its header: its limits hold 1,024 bytes at least
        if credentials.takes_jwt() {
            assert_limits_hold_jwt(&limits)?;
        }

        let default = default_credential_of(options.credential.clone(), &limits)?;
        let metrics = options
            .metrics_registry
            .as_ref()
            .map(|registry| registry.attach(RouterSide::Client));
        let listeners = Arc::new(ClientListeners::default());
        let resolvers = Resolvers::default();
        let notifications = Arc::new(Mutex::new(BTreeMap::new()));
        let hearings = Arc::new(Mutex::new(BTreeMap::new()));
        let session_token = Arc::new(Mutex::new(None));
        let disposal = Disposal::default();
        let owner = Owner::spawn((&runtime, &clock), |weak: WeakOwner<ClientState>| {
            ClientState {
                core: Core {
                    pending,
                    resolvers: Arc::clone(&resolvers),
                    disposal: disposal.clone(),
                    ..Core::new(
                        weak,
                        (
                            RouterSide::Client,
                            limits,
                            Arc::clone(&clock),
                            metrics.clone(),
                        ),
                    )
                },
                transport: Arc::downgrade(&transport),
                listener: None,
                intake: Arc::clone(&intake),
                credentials,
                notifications: Arc::clone(&notifications),
                hearings: Arc::clone(&hearings),
                subscriptions: BTreeMap::new(),
                call_ids: BTreeMap::new(),
                session_token: Arc::clone(&session_token),
                listeners: Arc::clone(&listeners),
            }
        });
        let listener: Arc<dyn ClientListener> = Arc::new(Bridge {
            owner: owner.clone(),
            disposal: disposal.clone(),
            intake,
            transport: Arc::downgrade(&transport),
        });

        let held = Arc::downgrade(&listener);

        transport.listen(listener);

        owner.offer(Box::new(move |state: &mut ClientState| {
            state.listener = Some(held);
        }));

        Ok(Self {
            shared: Arc::new(Shared {
                #[cfg(test)]
                requester_probe: Mutex::new(None),
                owner,
                disposal,
                clock,
                limits,
                metrics,
                transport,
                listeners,
                resolvers,
                notifications,
                hearings,
                session_token,
                default: Arc::new(Mutex::new(Default_ {
                    credential: default,
                    is_withdrawn: false,
                })),
            }),
        })
    }

    pub(crate) fn owner(&self) -> &Owner<ClientState> {
        &self.shared.owner
    }

    #[cfg(test)]
    pub(crate) fn observe_requester(&self, probe: crate::testing::scripted::RequesterProbe) {
        *self
            .shared
            .requester_probe
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(probe);
    }

    #[cfg(test)]
    fn requester_probe(&self) -> Option<crate::testing::scripted::RequesterProbe> {
        self.shared
            .requester_probe
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// What a relay's destination names to call through it.
    #[must_use]
    pub fn as_relay_target(&self) -> crate::router::relay::RelayTarget {
        crate::router::relay::RelayTarget::Router(Arc::new(Through(self.clone())))
    }

    /// The clock it runs on.
    #[must_use]
    pub fn clock(&self) -> SharedClock {
        Arc::clone(&self.shared.clock)
    }

    /// What it reads, writes and holds by.
    #[must_use]
    pub fn limits(&self) -> RouterLimits {
        self.shared.limits
    }

    /// The transport it is over.
    #[must_use]
    pub fn transport(&self) -> Arc<dyn RouterClientTransport> {
        Arc::clone(&self.shared.transport)
    }

    /// The credential every call presents but one that gives its own.
    #[must_use]
    pub fn credential(&self) -> Option<RequestCredential> {
        locked(&self.shared.default).credential.clone()
    }

    /// Sets the credential every call presents, or none: a credential withdrawn is presented again.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a credential that is no `JWT` or `ELSEWHERE`.
    pub fn set_credential(
        &self,
        credential: Option<RequestCredential>,
    ) -> Result<(), ProgrammerError> {
        let credential = default_credential_of(credential, &self.shared.limits)?;

        *locked(&self.shared.default) = Default_ {
            credential,
            is_withdrawn: false,
        };

        Ok(())
    }

    /// Whether the default credential was withdrawn, refused `SESSION_REQUIRED`.
    #[must_use]
    pub fn is_credential_withdrawn(&self) -> bool {
        locked(&self.shared.default).is_withdrawn
    }

    /// The session its server announced last.
    #[must_use]
    pub fn session_token(&self) -> Option<SessionToken> {
        *locked(&self.shared.session_token)
    }

    /// Hears what it reports from now on; the id given takes it off again, with
    /// [`RouterClient::off`].
    pub fn on_error(&self, listener: ClientErrorListener) -> ListenerId {
        self.shared.listeners.error.add(listener)
    }

    /// Hears each envelope it sends or takes from now on; the id given takes it off again, with
    /// [`RouterClient::off`].
    pub fn on_debug(&self, listener: ClientEnvelopeListener) -> ListenerId {
        self.shared.listeners.debug.add(listener)
    }

    /// Hears what it did from now on; the id given takes it off again, with
    /// [`RouterClient::off`].
    pub fn on_activity(&self, listener: ClientActivityListener) -> ListenerId {
        self.shared.listeners.activity.add(listener)
    }

    /// Hears the scheme of each default credential it withdraws from now on; the id given takes it
    /// off again, with [`RouterClient::off`].
    pub fn on_credential_withdrawn(&self, listener: WithdrawnListener) -> ListenerId {
        self.shared.listeners.withdrawn.add(listener)
    }

    /// Hears no more with the listener `listener` names, whichever of its events it heard: one
    /// taken off already, or of another part, changes nothing.
    pub fn off(&self, listener: ListenerId) {
        let listeners = &self.shared.listeners;

        listeners.error.off(listener);
        listeners.debug.off(listener);
        listeners.activity.off(listener);
        listeners.withdrawn.off(listener);
    }

    /// Reports what went wrong that no call waits on.
    pub fn report(&self, error: &RouterError) {
        self.shared.listeners.report(error);
    }

    /// Declares a requester of `procedure` to its metrics, as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, or one its registry refuses.
    pub fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError> {
        check_declaration(procedure)?;
        check_procedure_kind(procedure, DeclarationWay::ClientRequester)?;

        let series = self
            .shared
            .metrics
            .as_ref()
            .map(|metrics| metrics.declare_requester(procedure))
            .transpose()?;
        #[cfg(test)]
        if let Some(probe) = self.requester_probe() {
            (probe.declared)(procedure, series.as_ref());
        }
        Ok(series)
    }

    /// Registers a resolver of the command `procedure`.
    pub(crate) fn register_resolver(
        &self,
        (procedure, handler): (&Procedure, Handler),
    ) -> Result<(), ProgrammerError> {
        check_declaration(procedure)?;
        check_procedure_kind(procedure, DeclarationWay::ClientResolver)?;
        crate::router::core::register_resolver(
            &self.shared.resolvers,
            (procedure, handler, self.shared.metrics.as_ref()),
        )
        .map(drop)
    }

    /// Whether `notification` is the one it holds for its procedure.
    #[must_use]
    pub fn has_notification(&self, notification: &Arc<dyn NotificationLike>) -> bool {
        locked(&self.shared.notifications)
            .get(&key_of(notification.as_ref()))
            .is_some_and(|held| Arc::ptr_eq(held, notification))
    }

    /// Registers `notification`, declared to its metrics as it is.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, one of another kind, one already
    /// registered, or one its registry refuses.
    pub fn register_notification(
        &self,
        notification: Arc<dyn NotificationLike>,
    ) -> Result<(), ProgrammerError> {
        let procedure = notification.procedure().clone();

        // * spec 16.10: its identity first, then its kind, before the router's reasons and its
        // registry's
        check_declaration(&procedure)?;
        check_procedure_kind(&procedure, DeclarationWay::ClientNotification)?;

        let key = key_of(notification.as_ref());
        let mut notifications = locked(&self.shared.notifications);

        if notifications.contains_key(&key) {
            drop(notifications);

            return Err(ProgrammerError::new(format!(
                "{} is already a registered notification",
                procedure.procedure_name
            )));
        }

        // declared as it is registered: one the registry refuses is not registered either
        if let Some(metrics) = &self.shared.metrics {
            let hearing = metrics.declare_notification(&procedure)?;

            locked(&self.shared.hearings).insert(key, hearing);
        }

        notifications.insert(key, notification);
        drop(notifications);

        Ok(())
    }

    /// Unregisters `notification`, its subscription cancelled at the server, or only forgotten when
    /// its options' `cancel` is false.
    pub fn unregister_notification(
        &self,
        notification: &Arc<dyn NotificationLike>,
        options: &UnregisterNotificationOptions,
    ) -> BoxFuture<()> {
        let key = key_of(notification.as_ref());
        let cancel = options.cancel.unwrap_or(true);

        {
            let mut notifications = locked(&self.shared.notifications);

            // another's of the same procedure stays: only what registered takes itself away
            if !notifications
                .get(&key)
                .is_some_and(|held| Arc::ptr_eq(held, notification))
            {
                return Box::pin(async {});
            }

            notifications.remove(&key);
        }

        // ! its handle's mark, read as its job would be posted: once disposed, its cancel goes
        // nowhere, and the dispose's job lets its subscription go
        if self.shared.disposal.is_set() {
            return Box::pin(async {});
        }

        let posted = self.shared.owner.run(move |state: &mut ClientState| {
            if let Some((call_id, timeout)) = state.unbind(key) {
                let call = CallAddress {
                    connection_handle: server_handle(),
                    call_id,
                };

                if cancel {
                    crate::router::requester::cancel(state, (&call, Some(timeout)));
                } else {
                    crate::router::requester::reserve(state, (&call, Some(timeout)));
                }
            }
        });

        Box::pin(async move {
            posted.await.ok();
        })
    }

    /// Makes a call, sent as it is made. Dropping its future cancels nothing: its signal or
    /// an explicit cancel ends the call.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a notification it subscribes that its router does not hold, or a
    /// credential asked of the wrong shape.
    #[expect(
        clippy::too_many_lines,
        reason = "a call held to its credential, its subscription and its refusals, as the other sides hold it"
    )]
    pub fn request(&self, payload: Bytes, request: RouterRequest) -> Result<Call, ProgrammerError> {
        let shared = &self.shared;
        let RouterRequest {
            procedure,
            options,
            series,
            refusal: judged,
            subscribes,
            on_call_id,
            on_sent,
        } = request;

        // ! a programmer's error first, before the call starts, so it is never counted
        if let Some(subscribes) = &subscribes
            && (procedure.address() != subscribes.procedure().address()
                || !self.has_notification(subscribes))
        {
            return Err(ProgrammerError::new(format!(
                "{} is not the notification this router holds for {}",
                subscribes.procedure().procedure_name,
                procedure.procedure_name
            )));
        }

        // the call's own credential, or the default, as it is now
        let (presented_default, is_withdrawn) = {
            let default = locked(&shared.default);

            (
                options
                    .credential
                    .is_none()
                    .then(|| default.credential.clone())
                    .flatten(),
                default.is_withdrawn,
            )
        };
        let token = *locked(&shared.session_token);
        let asked = options
            .credential
            .clone()
            .or_else(|| presented_default.clone());
        let mut refusal: Option<CallError> = None;
        let presented =
            match presented_credential_of(asked.as_ref(), (RouterSide::Client, token.as_ref())) {
                Ok(presented) => presented,
                Err(CallError::Refused(error)) => return Err(error),
                Err(error) => {
                    refusal = Some(error);

                    crate::call_session::Presented::default()
                }
            };
        let address = procedure.address();
        let transport = Arc::clone(&shared.transport);
        // a credential its transport cannot carry fails the call before it goes
        let uncarried = uncarried_of(
            presented.credential.as_ref(),
            &Carriage {
                carried: presented.carried.as_deref(),
                takes: &|credential: &str| transport.carries(credential),
                side: RouterSide::Client,
                is_secure: transport.is_secure(),
            },
        );

        if refusal.is_none()
            && let Some(uncarried) = uncarried
        {
            refusal = Some(CallError::Failure(
                uncarried.of_call(Some(address), options.destination_id),
            ));
        }

        // a call that would present a default withdrawn fails before it goes, withdrawing nothing
        if refusal.is_none() && is_withdrawn && options.credential.is_none() {
            refusal = Some(CallError::Failure(
                Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Client)
                    .saying("the default credential was withdrawn")
                    .of_call(Some(address), options.destination_id),
            ));
        }

        // ! its handle's mark, read once, as its job is posted: one made after its router's dispose
        // fails unsent, whatever thread or turn it is made on; one made before goes (spec 9.1)
        if shared.disposal.is_set() {
            return Ok(Call::refused(CallError::Disconnected(
                crate::router::core::DISPOSED.to_owned(),
            )));
        }

        let (reply, answer) = oneshot::channel();
        let default = Arc::clone(&shared.default);
        let listeners = Arc::clone(&shared.listeners);
        let timeout = options.timeout;
        let subscribing = subscribes.clone();
        let posted = shared.owner.post(Box::new(move |state: &mut ClientState| {
            let drawn: Arc<Mutex<Option<u32>>> = Arc::default();
            let told = Arc::clone(&drawn);
            let deferral = state.core.deferral.clone();
            let is_subscribing = subscribing.is_some();
            let paced = subscribing
                .as_ref()
                .is_some_and(|notification| notification.window().is_some());
            // ! bound as its call id is drawn, before the request goes out, so a notification right
            // behind its result is heard, and the call bound before is cancelled ahead of it
            let on_drawn = is_subscribing.then(|| -> OnDrawn<ClientState> {
                Box::new(move |state: &mut ClientState, call_id: u32| {
                    *locked(&told) = Some(call_id);
                    let held = locked(&state.notifications)
                        .get(&(address.service_id, address.procedure_id))
                        .cloned();

                    if let Some(notification) = held {
                        bind(state, (notification, call_id, timeout));
                    }
                })
            });

            crate::router::requester::request(
                state,
                (
                    payload,
                    CoreRequest {
                        connection_handle: server_handle(),
                        credential: presented.credential,
                        on_drawn,
                        on_call_id,
                        on_sent,
                        opens_subscription: is_subscribing,
                        paced,
                        options,
                        procedure: address,
                        maximum_payload_bytes: procedure.maximum_payload_bytes,
                        // * its requester's refusal before the router's own
                        refusal: judged.or(refusal),
                        series,
                        transport_credential: presented.carried,
                    },
                    Box::new(move |outcome: Result<RouterResult, CallError>| {
                        let call_id = *locked(&drawn);
                        // ! the call owns a result already received, even if a queued turn panics
                        // before its subscription's settlement; only that side effect waits
                        let reply = if outcome.is_ok() {
                            drop(reply.send(outcome.clone()));
                            None
                        } else {
                            Some(reply)
                        };
                        // settled in a later turn than the one it came in: as its router ends
                        // too, with what ended it for its reason
                        deferral.offer(Box::new(move |state: &mut ClientState| {
                            settled(
                                state,
                                (
                                    (outcome, reply),
                                    (subscribing, call_id, presented_default, default, listeners),
                                ),
                            );
                        }));
                    }),
                ),
            );
        }));

        if posted.is_err() {
            return Ok(Call::refused(CallError::Disconnected(
                crate::router::core::DISPOSED.to_owned(),
            )));
        }

        Ok(Call::of(answer))
    }

    /// What it holds right now, for diagnosis.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] when two parts name the same count.
    pub fn gauges(&self) -> BoxFuture<Result<Gauges, ProgrammerError>> {
        let gauged = self.shared.owner.run(|state: &mut ClientState| {
            let mut own = Gauges::default();

            own.counts.insert(
                "subscriptions",
                u64::try_from(state.subscriptions.len()).unwrap_or(u64::MAX),
            );

            Gauges::merge(vec![own, state.core.gauges()?])
        });

        Box::pin(async move { gauged.await.unwrap_or_else(|_| Ok(Gauges::default())) })
    }

    /// Disposes of it: every call ends, and nothing more goes out. Disposed at once, a call made
    /// after it fails unsent; what it holds is let go in a later turn, behind what came before it,
    /// a call made before it among it, and a listener's dispose too (spec 9.0, 9.1).
    pub fn dispose(&self) -> BoxFuture<()> {
        self.shared.disposal.set();

        let disposed = self
            .shared
            .owner
            .run(|state: &mut ClientState| state.dispose());

        Box::pin(async move {
            disposed.await.ok();
        })
    }

    /// Reserves `call_id` for `timeout`, its default for none or never, as a cancel of a call no
    /// call waits on does.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    #[cfg(any(test, feature = "testing"))]
    #[doc(hidden)]
    pub fn reserve(
        &self,
        call_id: u32,
        timeout: Option<Duration>,
    ) -> Result<BoxFuture<()>, ProgrammerError> {
        let timeout = timeout
            .map(|timeout| crate::duration::hold("a call id's reservation", timeout))
            .transpose()?;

        let posted = self.shared.owner.run(move |state: &mut ClientState| {
            let call = CallAddress {
                connection_handle: server_handle(),
                call_id,
            };

            crate::router::requester::reserve(state, (&call, timeout));
        });

        Ok(Box::pin(async move {
            posted.await.ok();
        }))
    }

    /// Cancels `call_id`, which no call waits on: its cancel sent, and reserved as a reserve is.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    #[cfg(any(test, feature = "testing"))]
    #[doc(hidden)]
    pub fn cancel(
        &self,
        call_id: u32,
        timeout: Option<Duration>,
    ) -> Result<BoxFuture<()>, ProgrammerError> {
        let timeout = timeout
            .map(|timeout| crate::duration::hold("a call id's reservation", timeout))
            .transpose()?;

        // ! its handle's mark, read as its job would be posted: once disposed, nothing goes
        if self.shared.disposal.is_set() {
            return Ok(Box::pin(async {}));
        }

        let posted = self.shared.owner.run(move |state: &mut ClientState| {
            let call = CallAddress {
                connection_handle: server_handle(),
                call_id,
            };

            crate::router::requester::cancel(state, (&call, timeout));
        });

        Ok(Box::pin(async move {
            posted.await.ok();
        }))
    }

    /// Whether `call_id` is reserved.
    #[cfg(any(test, feature = "testing"))]
    #[doc(hidden)]
    pub fn is_reserved(&self, call_id: u32) -> BoxFuture<bool> {
        let asked = self.shared.owner.run(move |state: &mut ClientState| {
            crate::router::requester::is_reserved(state, (call_id, &server_handle()))
        });

        Box::pin(async move { asked.await.unwrap_or(false) })
    }

    /// Whether the side settled: nothing queued, nothing running, nothing covered on a test's clock.
    #[cfg(any(test, feature = "testing"))]
    #[doc(hidden)]
    pub async fn settle(&self) {
        if let Some(activity) = self.shared.clock.activity() {
            activity.settled().await;
        }
    }
}

// binds a subscription's call as its call id is drawn: the call it was bound to before is
// cancelled, so the server holds it no longer
fn bind(
    state: &mut ClientState,
    (notification, call_id, timeout): (Arc<dyn NotificationLike>, u32, Duration),
) {
    let key = key_of(notification.as_ref());

    if let Some((previous, previous_timeout)) = state.unbind(key) {
        crate::router::requester::cancel(
            state,
            (
                &CallAddress {
                    connection_handle: server_handle(),
                    call_id: previous,
                },
                Some(previous_timeout),
            ),
        );
    }

    let hearing = locked(&state.hearings).get(&key).cloned();
    let pacing = notification.window().map(|window| ClientPacing {
        credit_end: 1,
        settled: 0,
        window,
    });

    state.subscriptions.insert(
        call_id,
        Bound {
            hearing,
            is_answered: false,
            notification,
            pacing,
            timeout,
        },
    );
    state.call_ids.insert(key, call_id);
}

// a call settled: a subscription answered is one, and opens its window; one that did not take
// holds nothing; a default refused SESSION_REQUIRED is withdrawn
#[expect(
    clippy::type_complexity,
    reason = "what a call settles with, and what it settles"
)]
fn settled(
    state: &mut ClientState,
    ((outcome, reply), (subscribing, bound_call_id, presented, default, listeners)): (
        (
            Result<RouterResult, CallError>,
            Option<oneshot::Sender<Result<RouterResult, CallError>>>,
        ),
        (
            Option<Arc<dyn NotificationLike>>,
            Option<u32>,
            Option<RequestCredential>,
            Arc<Mutex<Default_>>,
            Arc<ClientListeners>,
        ),
    ),
) {
    if let Some(notification) = &subscribing {
        let key = key_of(notification.as_ref());

        match &outcome {
            Ok(result) => {
                let call_id = result.header.call_id;

                if let Some(bound) = state.subscriptions.get_mut(&call_id) {
                    bound.is_answered = true;
                }

                // the settlement follows the read's envelopes, so a subscription ended in that
                // read opens no window
                state.renew(call_id);
            }
            Err(_) => {
                // a subscription that did not take holds nothing, whatever ended it
                if let Some(call_id) = bound_call_id
                    && state.call_ids.get(&key) == Some(&call_id)
                    && state
                        .subscriptions
                        .get(&call_id)
                        .is_some_and(|bound| Arc::ptr_eq(&bound.notification, notification))
                {
                    state.unbind(key);
                }
            }
        }
    }

    if let Err(reason) = &outcome {
        withdraw((reason, presented.as_ref()), (&default, &listeners));
    }

    if let Some(reply) = reply {
        drop(reply.send(outcome));
    }
}

// a call that presented the default, refused SESSION_REQUIRED, withdraws it while it is still that
// credential by value
fn withdraw(
    (reason, presented): (&CallError, Option<&RequestCredential>),
    (default, listeners): (&Mutex<Default_>, &ClientListeners),
) {
    let Some(presented) = presented else {
        return;
    };
    let CallError::Failure(failure) = reason else {
        return;
    };

    // ! a failure that overtook its result in a listen's batch withdraws nothing (spec 13.4, 15.9)
    if failure.origin() == FailureOrigin::Local
        || failure.may_overtake()
        || !failure.is_protocol_code(&[ProtocolCode::SESSION_REQUIRED])
    {
        return;
    }

    let scheme = {
        let mut held = locked(default);

        if held.credential.as_ref() != Some(presented) {
            return;
        }

        held.credential = None;
        held.is_withdrawn = true;
        drop(held);

        match presented {
            RequestCredential::Jwt(_) => CredentialScheme::JWT,
            RequestCredential::None
            | RequestCredential::Opaque
            | RequestCredential::Elsewhere(_) => CredentialScheme::ELSEWHERE,
        }
    };

    listeners.guarded((&listeners.withdrawn, |listener: &WithdrawnListener| {
        listener(scheme);
    }));
}

// a client's router as a relay calls through it, to a server behind the relay
#[derive(Debug)]
struct Through(RouterClient);

impl RelayRouter for Through {
    fn limits(&self) -> RouterLimits {
        self.0.shared.limits
    }

    fn request(&self, payload: Bytes, leg: RelayLeg) -> Result<Call, ProgrammerError> {
        let RelayLeg {
            procedure,
            options,
            on_sent,
        } = leg;

        RouterClient::request(&self.0, payload, {
            let mut request = RouterRequest::new(procedure, &options);

            request.on_sent = Some(on_sent);
            request
        })
    }

    fn carries(&self, credential: &str) -> bool {
        self.0.shared.transport.carries(credential)
    }

    fn is_secure(&self) -> bool {
        self.0.shared.transport.is_secure()
    }
}
