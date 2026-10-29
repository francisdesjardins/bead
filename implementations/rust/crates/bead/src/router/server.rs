//! The server side of a router (spec 9 to 14): a connection's requests go to the resolvers
//! registered; a request of the router's own goes to the connection its options name, on an even call
//! id; a notification goes to each connection subscribed, paced where its request asked; a request
//! that names a destination goes on through the relay.

use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::call_session::{Carriage, connection_session_of, presented_credential_of, uncarried_of};
use crate::clock::{SharedClock, Timer};
use crate::constants::{CredentialScheme, ProtocolCode, RouterSide, SESSION_TOKEN_BYTES};
use crate::credentials::{
    CredentialRequest, CredentialResolver, Credentials, assert_limits_hold_jwt,
};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::duration::{LONGEST_TIMER, hold};
use crate::envelope::{
    Credential, CreditHeader, Envelope, FailureHeader, FailureRecord, Header, RequestHeader,
};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::{Failure, ProcedureAddress};
use crate::identity::{DeclarationWay, Procedure, check_declaration, check_procedure_kind};
use crate::managers::notification::{
    NotificationKey, NotificationManager, PacingLimitsOptions, PacingOutcome, SubscribingCall,
    pacing_limits_of,
};
use crate::metrics::{MetricsRegistry, NotificationSeries, ProcedureSeries, RouterMetrics};
use crate::ordered::Ordered;
use crate::owner::{Owner, WeakOwner};
use crate::router::core::{
    BeforeAnswer, Core, Dispatch, Disposal, Handler, Resolution, Resolved, Resolvers, Responded,
    SessionRequest, Side, Undo, Unresolved, is_answering, reported, reported_call, respond,
};
use crate::router::requester::CoreRequest;
use crate::router::types::{
    AccessRefusal, BoxFuture, CallAddress, CallSession, ConnectionHandle, Gauges,
    RequestCredential, ResolvedRequestOptions, RouterActivity, RouterAnswer, RouterError,
    RouterLimits, RouterLimitsOptions, RouterResult, SessionIdentifier, Signal, TransportMessage,
    limits_of, session_key_of,
};
use crate::session_token::SessionToken;
use crate::transport::{Sent, ServerListener, ServerTransport};

/// What hears what a server's router reports: an error, and the connection it came with.
pub type ErrorListener = Arc<dyn Fn(&RouterError, Option<&ConnectionHandle>) + Send + Sync>;

/// What hears each envelope a server's router sends or takes, its header redacted.
pub type EnvelopeListener = Arc<dyn Fn(DebugDirection, &TracedEnvelope) + Send + Sync>;

/// What hears each access a server's router refuses (spec 13.12).
pub type RefusalListener = Arc<dyn Fn(&AccessRefusal) + Send + Sync>;

/// What hears what a server's router did on a connection.
pub type ActivityListener = Arc<dyn Fn(RouterActivity, &ConnectionHandle) + Send + Sync>;

/// How a server's router is built, beyond its transport.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct RouterServerOptions {
    /// The clock it runs on: its transport's, which one given must be; the platform's when none.
    pub clock: Option<SharedClock>,
    /// The runtime its owner runs on: the current one when none.
    pub runtime: Option<Handle>,
    /// How much it reads, writes and holds.
    pub limits: Option<RouterLimitsOptions>,
    /// What it counts its calls into.
    pub metrics_registry: Option<MetricsRegistry>,
    /// What a paced subscription queues at most.
    pub pacing: Option<PacingLimitsOptions>,
    /// What resolves a `JWT` and an `ELSEWHERE`.
    pub credentials: Option<Credentials>,
    /// Its relay's options.
    pub relay: Option<crate::router::relay::RelayOptions>,
}

impl fmt::Debug for RouterServerOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouterServerOptions")
            .field("limits", &self.limits)
            .field("credentials", &self.credentials)
            .finish_non_exhaustive()
    }
}

// ── The credentials' sessions a server's connections keep ─────────────────────────────────

// a credential's session a connection keeps (spec 13.10): its identifier, its end, the later of
// those its calls resolved to, the timer toward it, how many times it was timed, and its calls
#[derive(Debug)]
pub(crate) struct Kept {
    id: u64,
    calls: Vec<u32>,
    end: Option<i64>,
    identifier: SessionIdentifier,
    timer: Option<Arc<dyn Timer>>,
    timing: u64,
}

// ── Subscription places ──────────────────────────────────────────────────────────────────

// a call answered while another holds its place
#[derive(Debug, Clone)]
pub(crate) struct Waiting {
    call: SubscribingCall,
    procedure: ProcedureAddress,
}

/// What a server's router holds, in its owner.
pub(crate) struct ServerState {
    pub(crate) core: Core<Self>,
    pub(crate) transport: Arc<dyn ServerTransport>,
    pub(crate) listener: Option<Arc<dyn ServerListener>>,
    // the connections it follows, in the order it heard of them
    pub(crate) connections: Ordered<ConnectionHandle, ()>,
    pub(crate) credentials: CredentialResolver,
    pub(crate) notifications: NotificationManager,
    // by connection, the calls subscribed that their answer still has to settle, and for each holder
    // in flight the first call answered meanwhile for its place
    pub(crate) in_flight: Ordered<ConnectionHandle, Vec<u32>>,
    pub(crate) waiting: Ordered<ConnectionHandle, Ordered<u32, Waiting>>,
    // by connection, then by the key the identifier gives
    pub(crate) kept: Ordered<ConnectionHandle, Ordered<String, Kept>>,
    // the request of each paced subscription its resolver subscribed in flight
    pub(crate) requests: BTreeMap<(ConnectionHandle, u32), Arc<Dispatch>>,
    pub(crate) notifyings: Arc<Mutex<BTreeMap<ProcedureAddress, NotificationSeries>>>,
    pub(crate) relay: crate::router::relay::Relay,
    pub(crate) listeners: Arc<ServerListeners>,
    pub(crate) facade: Option<crate::server::Facade>,
}

impl fmt::Debug for ServerState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerState")
            .field("connections", &self.connections.len())
            .finish_non_exhaustive()
    }
}

/// The listeners of a server's router.
#[derive(Default)]
pub(crate) struct ServerListeners {
    pub(crate) error: Mutex<Vec<ErrorListener>>,
    pub(crate) debug: Mutex<Vec<EnvelopeListener>>,
    pub(crate) access_refused: Mutex<Vec<RefusalListener>>,
    pub(crate) activity: Mutex<Vec<ActivityListener>>,
}

impl fmt::Debug for ServerListeners {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerListeners")
            .finish_non_exhaustive()
    }
}

fn all<T: Clone>(listeners: &Mutex<Vec<T>>) -> Vec<T> {
    listeners
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

impl ServerListeners {
    // each listener within a guard (spec 15.1): what one panics is reported, and the others heard
    fn guarded<T: Clone, C: Fn(&T)>(
        &self,
        (listeners, call): (&Mutex<Vec<T>>, C),
        handle: Option<&ConnectionHandle>,
    ) {
        for listener in all(listeners) {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&listener)));

            if let Err(panicked) = called {
                self.report(&crate::transport::panic_error(&*panicked), handle);
            }
        }
    }

    pub(crate) fn report(&self, error: &RouterError, handle: Option<&ConnectionHandle>) {
        for listener in all(&self.error) {
            // ! a listener of errors that panics would loop: its panic is dropped
            let called =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(error, handle)));

            drop(called);
        }
    }
}

impl Side for ServerState {
    fn core(&mut self) -> &mut Core<Self> {
        &mut self.core
    }

    fn credential_schemes(&self) -> Vec<CredentialScheme> {
        self.credentials.schemes()
    }

    fn activity(&mut self, activity: RouterActivity, connection_handle: &ConnectionHandle) {
        let listeners = Arc::clone(&self.listeners);

        listeners.guarded(
            (&listeners.activity, |listener: &ActivityListener| {
                listener(activity, connection_handle);
            }),
            Some(connection_handle),
        );
    }

    // a request of the peer's on a subscription's call id would answer that subscription
    fn is_call_id_in_use(&self, call_id: u32, connection_handle: &ConnectionHandle) -> bool {
        self.notifications.has(call_id, connection_handle)
    }

    fn handler_of_destination(&mut self, destination_id: u32) -> Option<Arc<Handler>> {
        crate::router::relay::handler_of(self, destination_id)
    }

    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        self.transport.is_two_way(connection_handle)
    }

    fn before_answer(&mut self, answer: BeforeAnswer) -> Option<Undo<Self>> {
        let BeforeAnswer {
            connection_handle,
            header,
            is_failure,
            handler,
            session,
        } = answer;
        let (end, identifier) = subscribing_of(session.as_ref());
        let call_id = header.call_id;

        // a call in flight whose credential's session ended meanwhile keeps it anew as its answer
        // subscribes it, once that answer went
        if !is_failure && let Some(identifier) = identifier.clone() {
            let handle = Arc::clone(&connection_handle);

            self.core.later(move |state: &mut Self| {
                held(state, (call_id, &handle, end, identifier));
            });
        }

        let procedure = ProcedureAddress {
            service_id: header.service_id,
            procedure_id: header.procedure_id,
        };
        let series = self.series_of_procedure(procedure);
        let notifies = header.opens_subscription
            && handler.is_some_and(|handler| handler.notifies)
            && self.connections.contains_key(&connection_handle);

        settle_place(
            self,
            (
                SubscribingCall {
                    call_id,
                    connection_handle,
                    end,
                    identifier,
                    paced: header.paced,
                    series,
                },
                (is_failure, notifies, procedure),
            ),
        )
    }

    // a cancel takes away what its call subscribed, established or still in flight
    fn on_cancel(&mut self, call_id: u32, connection_handle: &ConnectionHandle) {
        cancel_place(
            self,
            &CallAddress {
                connection_handle: Arc::clone(connection_handle),
                call_id,
            },
        );
    }

    fn sends_notifications(&self) -> bool {
        true
    }

    // a credit lets go what the subscription queued; one for a subscription gone may have crossed
    // its end, and is dropped in silence
    fn on_subscription_credit(
        &mut self,
        header: &CreditHeader,
        connection_handle: &ConnectionHandle,
    ) {
        let released = self
            .notifications
            .pacing_of(header.call_id, connection_handle)
            .map(|pacing| pacing.credit(header.credit_end))
            .unwrap_or_default();

        for payload in released {
            send_notification(
                self,
                (
                    payload,
                    CallAddress {
                        connection_handle: Arc::clone(connection_handle),
                        call_id: header.call_id,
                    },
                ),
            );
        }
    }

    fn is_tracing(&self) -> bool {
        !all(&self.listeners.debug).is_empty()
    }

    fn trace(
        &mut self,
        direction: DebugDirection,
        (connection_handle, header): (&ConnectionHandle, &Header),
    ) {
        let listeners = Arc::clone(&self.listeners);
        let traced = TracedEnvelope::of(connection_handle, header);

        listeners.guarded(
            (&listeners.debug, |listener: &EnvelopeListener| {
                listener(direction, &traced);
            }),
            Some(connection_handle),
        );
    }

    fn report(&mut self, error: RouterError, connection_handle: &ConnectionHandle) {
        self.listeners.report(&error, Some(connection_handle));
    }

    fn transmit(
        &mut self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.transport.send(message, connection_handle)
    }

    fn is_telling_refusals(&self) -> bool {
        !all(&self.listeners.access_refused).is_empty()
    }

    // * told within a guard (spec 15.1): what a listener panics is reported with the connection
    fn tell_refusal(&mut self, refusal: AccessRefusal) {
        let listeners = Arc::clone(&self.listeners);
        let handle = Arc::clone(&refusal.connection_handle);

        listeners.guarded(
            (&listeners.access_refused, |listener: &RefusalListener| {
                listener(&refusal);
            }),
            Some(&handle),
        );
    }

    fn session_of(&mut self, request: &SessionRequest, signal: &Signal) -> Resolution {
        let handle = &request.connection_handle;
        let header = &request.carried.header;
        let credential = header.credential.clone();

        if let Some(CredentialScheme::JWT | CredentialScheme::ELSEWHERE) =
            credential.as_ref().map(Credential::scheme)
        {
            let audiences = header
                .destination_id
                .map(|_| crate::router::relay::audiences(&self.relay));

            return Resolution::Later(self.credentials.resolve((
                CredentialRequest {
                    audiences,
                    credential: credential.unwrap_or(Credential::None),
                    transport_credential: request.carried.transport_credential.clone(),
                },
                signal.token().clone(),
            )));
        }

        let session = crate::server::sessions_of(self).and_then(|sessions| {
            connection_session_of(
                credential.as_ref(),
                (sessions.token_of(handle).as_ref(), sessions.data_of(handle)),
            )
        });

        // an OPAQUE no session holds on its connection is refused for its session
        Resolution::Now(Ok(match session {
            Some(session) => Resolved::Session(session),
            None if matches!(credential, Some(Credential::Opaque(_))) => {
                Resolved::Refused("session".to_owned())
            }
            None => Resolved::None,
        }))
    }

    fn session_token_of(&mut self, connection_handle: &ConnectionHandle) -> Option<SessionToken> {
        crate::server::sessions_of(self).and_then(|sessions| sessions.token_of(connection_handle))
    }

    fn subscribe(&mut self, dispatch: &Arc<Dispatch>) -> Result<u32, CallError> {
        subscribe(self, dispatch)
    }

    fn resolved(
        &mut self,
        session: CallSession,
        connection_handle: &ConnectionHandle,
    ) -> CallSession {
        resolved_session(self, (session, connection_handle))
    }
}

impl ServerState {
    // the series a subscription of `procedure` counts into, as it subscribes
    fn series_of_procedure(&self, procedure: ProcedureAddress) -> Option<NotificationSeries> {
        self.core.metrics.as_ref()?;
        self.notifyings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&procedure)
            .cloned()
    }
}

// what a subscribing call holds its subscription in, beside its address: a credential's session's
// end and identifier; nothing for its connection's
fn subscribing_of(session: Option<&CallSession>) -> (Option<i64>, Option<SessionIdentifier>) {
    match session.and_then(|session| {
        session
            .identifier
            .clone()
            .map(|identifier| (session.end, identifier))
    }) {
        Some((end, identifier)) => (end, Some(identifier)),
        None => (None, None),
    }
}

// ── Notifications, tracked: a credential's session kept from its first subscription to its last ──

fn register_tracked(
    state: &mut ServerState,
    (procedure, call): (ProcedureAddress, &SubscribingCall),
) -> Result<u32, ProgrammerError> {
    let call_id = state.notifications.register(procedure, call)?;

    if let Some(identifier) = call.identifier.clone() {
        keep(
            state,
            (call_id, &call.connection_handle, call.end, identifier),
        );
    }

    Ok(call_id)
}

fn unregister_tracked(
    state: &mut ServerState,
    (call_id, handle): (u32, &ConnectionHandle),
) -> Option<u32> {
    let subscription = state.notifications.unregister(call_id, handle)?;

    release(state, (call_id, subscription.identifier.as_ref(), handle));

    Some(call_id)
}

fn clean_tracked(state: &mut ServerState, handle: &ConnectionHandle) {
    state.notifications.clean(handle);

    if let Some(sessions) = state.kept.remove(handle) {
        for (_, mut session) in sessions.into_iter_entries() {
            if let Some(timer) = session.timer.take() {
                timer.cancel();
            }
        }
    }
}

trait IntoEntries<K, V> {
    fn into_iter_entries(self) -> Vec<(K, V)>;
}

impl<K: PartialEq, V> IntoEntries<K, V> for Ordered<K, V> {
    fn into_iter_entries(mut self) -> Vec<(K, V)> {
        self.drain().collect()
    }
}

// ── Credential sessions ─────────────────────────────────────────────────────────────────────

fn later_of(first: Option<i64>, second: Option<i64>) -> Option<i64> {
    first.zip(second).map(|(first, second)| first.max(second))
}

fn wall_milliseconds(state: &ServerState) -> i64 {
    state
        .core
        .clock
        .wall()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

// * the wall clock read again, never counted down: the time left ends the session, or arms the
// timer toward its end in place of the one before
fn time(state: &mut ServerState, (handle, key): (&ConnectionHandle, &str)) {
    // * read only for a session that ends (spec/debugging.md 3.1)
    let now = state
        .kept
        .get(handle)
        .and_then(|sessions| sessions.get(&key.to_owned()))
        .and_then(|session| session.end)
        .map(|_end| wall_milliseconds(state));
    let Some(session) = state
        .kept
        .get_mut(handle)
        .and_then(|sessions| sessions.get_mut(&key.to_owned()))
    else {
        return;
    };

    if let Some(timer) = session.timer.take() {
        timer.cancel();
    }

    session.timing = session.timing.saturating_add(1);

    let (Some(end), Some(now)) = (session.end, now) else {
        return;
    };
    let remaining = end.saturating_sub(now);
    let (id, timing) = (session.id, session.timing);
    let (handle, key) = (Arc::clone(handle), key.to_owned());

    // ! ended in a turn of its own, no timer armed: a session kept by a subscribing call ends past
    // that answer; one timed again or forgotten meanwhile ends nothing
    if remaining <= 0 {
        return state.core.later(move |state: &mut ServerState| {
            let is_same = state
                .kept
                .get(&handle)
                .and_then(|sessions| sessions.get(&key))
                .is_some_and(|session| session.id == id && session.timing == timing);

            if is_same {
                end_kept(state, (&handle, &key));
            }
        });
    }

    let delay =
        Duration::from_millis(u64::try_from(remaining).unwrap_or(u64::MAX)).min(LONGEST_TIMER);
    let (timed_handle, timed_key) = (Arc::clone(&handle), key.clone());
    let timer = state.core.after(delay, move |state: &mut ServerState| {
        let is_same = state
            .kept
            .get(&timed_handle)
            .and_then(|sessions| sessions.get(&timed_key))
            .is_some_and(|session| session.id == id && session.timing == timing);

        if is_same {
            time(state, (&timed_handle, &timed_key));
        }
    });

    match state
        .kept
        .get_mut(&handle)
        .and_then(|sessions| sessions.get_mut(&key))
    {
        Some(session) => session.timer = Some(timer),
        None => timer.cancel(),
    }
}

// forgets a session kept, and stops its timer
fn forget_kept(state: &mut ServerState, (handle, key): (&ConnectionHandle, &str)) -> Option<Kept> {
    let sessions = state.kept.get_mut(handle)?;
    let mut session = sessions.remove(&key.to_owned())?;

    if sessions.is_empty() {
        state.kept.remove(handle);
    }

    if let Some(timer) = session.timer.take() {
        timer.cancel();
    }

    Some(session)
}

// ends a session kept: forgotten first, so what its end takes away finds nothing to release
fn end_kept(state: &mut ServerState, (handle, key): (&ConnectionHandle, &str)) {
    if let Some(session) = forget_kept(state, (handle, key)) {
        end_session(state, (handle, Some(&session.identifier), None));
    }
}

// a subscription of a call's session, kept from its first: its end the later of those it holds
fn keep(
    state: &mut ServerState,
    (call_id, handle, end, identifier): (u32, &ConnectionHandle, Option<i64>, SessionIdentifier),
) {
    let key = identifier.key();

    if let Some(session) = state
        .kept
        .get_mut(handle)
        .and_then(|sessions| sessions.get_mut(&key))
    {
        let moved = later_of(session.end, end);

        if !session.calls.contains(&call_id) {
            session.calls.push(call_id);
        }

        if moved != session.end {
            session.end = moved;
            time(state, (handle, &key));
        }

        return;
    }

    let id = state.core.draw_id();

    if let Some(sessions) = state
        .kept
        .entry_or_insert_with(Arc::clone(handle), Ordered::new)
    {
        sessions.insert(
            key.clone(),
            Kept {
                id,
                calls: vec![call_id],
                end,
                identifier,
                timer: None,
                timing: 0,
            },
        );
    }

    time(state, (handle, &key));
}

// a subscription gone: its session, once it holds none, is kept no more
fn release(
    state: &mut ServerState,
    (call_id, identifier, handle): (u32, Option<&SessionIdentifier>, &ConnectionHandle),
) {
    let Some(identifier) = identifier else {
        return;
    };
    let key = identifier.key();
    let is_empty = state
        .kept
        .get_mut(handle)
        .and_then(|sessions| sessions.get_mut(&key))
        .is_some_and(|session| {
            session.calls.retain(|held| *held != call_id);
            session.calls.is_empty()
        });

    if is_empty {
        forget_kept(state, (handle, &key));
    }
}

// a subscribing call answered, its subscription held: its session kept, should it have ended while
// the call was in flight
fn held(
    state: &mut ServerState,
    (call_id, handle, end, identifier): (u32, &ConnectionHandle, Option<i64>, SessionIdentifier),
) {
    let key = identifier.key();
    let subscription = state
        .notifications
        .subscriptions(Some(handle))
        .into_iter()
        .find(|subscription| subscription.call_id == call_id);
    let is_kept = state
        .kept
        .get(handle)
        .and_then(|sessions| sessions.get(&key))
        .is_some_and(|session| session.calls.contains(&call_id));

    // a call whose answer did not go out, or that holds no subscription of that session, keeps
    // nothing
    if subscription
        .is_none_or(|subscription| session_key_of(subscription.identifier.as_ref()) != key)
        || is_kept
    {
        return;
    }

    keep(state, (call_id, handle, end, identifier));
}

// the session a call of `handle` runs in, its credential resolved to `session`: one the connection
// keeps under its identifier takes the later of the two ends, timed anew
fn resolved_session(
    state: &mut ServerState,
    (session, handle): (CallSession, &ConnectionHandle),
) -> CallSession {
    let Some(key) = session.identifier.as_ref().map(SessionIdentifier::key) else {
        return session;
    };
    let Some(kept) = state
        .kept
        .get_mut(handle)
        .and_then(|sessions| sessions.get_mut(&key))
    else {
        return session;
    };
    let moved = later_of(kept.end, session.end);

    // a renewal moves the end, whatever the order resolutions settle in
    if moved != kept.end {
        kept.end = moved;
        time(state, (handle, &key));
    }

    let end = state
        .kept
        .get(handle)
        .and_then(|sessions| sessions.get(&key))
        .and_then(|kept| kept.end);

    CallSession { end, ..session }
}

/// Ends the credential's session `identifier` names on every connection that keeps it.
pub(crate) fn end_credential_session(state: &mut ServerState, identifier: &SessionIdentifier) {
    let key = identifier.key();
    let handles: Vec<ConnectionHandle> = state
        .kept
        .iter()
        .filter(|(_, sessions)| sessions.contains_key(&key))
        .map(|(handle, _)| Arc::clone(handle))
        .collect();

    for handle in handles {
        end_kept(state, (&handle, &key));
    }
}

/// Ends every `JWT`'s session whose identifier's issuer is `issuer`, on every connection.
pub(crate) fn end_sessions_of(state: &mut ServerState, issuer: &str) {
    let ending: Vec<(ConnectionHandle, String)> = state
        .kept
        .iter()
        .flat_map(|(handle, sessions)| {
            sessions
                .iter()
                .filter(|(_, session)| match &session.identifier {
                    SessionIdentifier::JwtSid { issuer: held, .. }
                    | SessionIdentifier::JwtSub { issuer: held, .. } => held == issuer,
                    SessionIdentifier::Elsewhere { .. } => false,
                })
                .map(|(key, _)| (Arc::clone(handle), key.clone()))
                .collect::<Vec<_>>()
        })
        .collect();

    for (handle, key) in ending {
        end_kept(state, (&handle, &key));
    }
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────

fn is_in_flight(state: &ServerState, call: &CallAddress) -> bool {
    state
        .in_flight
        .get(&call.connection_handle)
        .is_some_and(|calls| calls.contains(&call.call_id))
}

fn take_in_flight(state: &mut ServerState, call: &CallAddress) -> bool {
    let Some(calls) = state.in_flight.get_mut(&call.connection_handle) else {
        return false;
    };
    let was = calls.len();

    calls.retain(|held| *held != call.call_id);

    let taken = calls.len() != was;

    if calls.is_empty() {
        state.in_flight.remove(&call.connection_handle);
    }

    taken
}

fn take_waiting(state: &mut ServerState, holder: &CallAddress) -> Option<Waiting> {
    let calls = state.waiting.get_mut(&holder.connection_handle)?;
    let successor = calls.remove(&holder.call_id);

    if calls.is_empty() {
        state.waiting.remove(&holder.connection_handle);
    }

    successor
}

fn leave_waiting(state: &mut ServerState, call: &CallAddress) {
    if let Some(calls) = state.waiting.get_mut(&call.connection_handle) {
        calls.retain(|_, successor| successor.call.call_id != call.call_id);

        if calls.is_empty() {
            state.waiting.remove(&call.connection_handle);
        }
    }
}

// the place goes to the call that waited on it, while its connection is open and holds none
fn hand_over(state: &mut ServerState, (successor, handle): (Option<Waiting>, &ConnectionHandle)) {
    let Some(successor) = successor else {
        return;
    };

    if state.connections.contains_key(handle)
        && state
            .notifications
            .subscription_of(
                successor.procedure,
                (handle, successor.call.identifier.as_ref()),
            )
            .is_none()
    {
        let registered = register_tracked(state, (successor.procedure, &successor.call));

        drop(registered);
    }
}

fn cancel_place(state: &mut ServerState, call: &CallAddress) {
    take_in_flight(state, call);
    unregister_tracked(state, (call.call_id, &call.connection_handle));
    leave_waiting(state, call);

    let successor = take_waiting(state, call);

    hand_over(state, (successor, &call.connection_handle));
}

// the calls a session's end ends on its connection: each established subscription it holds, and
// each call of it waiting; a call in flight is left to its answer
fn drop_places(
    state: &mut ServerState,
    (handle, identifier): (&ConnectionHandle, Option<&SessionIdentifier>),
) -> Vec<(u32, Option<NotificationSeries>)> {
    let key = session_key_of(identifier);
    let mut successors: Vec<(u32, Option<NotificationSeries>)> = Vec::new();

    if let Some(calls) = state.waiting.get_mut(handle) {
        calls.retain(|_, successor| {
            let is_of = session_key_of(successor.call.identifier.as_ref()) == key;

            if is_of {
                successors.push((successor.call.call_id, successor.call.series.clone()));
            }

            !is_of
        });

        if calls.is_empty() {
            state.waiting.remove(handle);
        }
    }

    let mut dropped: Vec<(u32, Option<NotificationSeries>)> = state
        .notifications
        .subscriptions(Some(handle))
        .into_iter()
        .filter(|held| {
            session_key_of(held.identifier.as_ref()) == key
                && !is_in_flight(
                    state,
                    &CallAddress {
                        connection_handle: Arc::clone(handle),
                        call_id: held.call_id,
                    },
                )
        })
        .map(|held| {
            (
                held.call_id,
                state.notifications.series_of(held.call_id, handle),
            )
        })
        .collect();

    dropped.extend(successors);
    dropped
}

// every subscription a connection holds that was answered
fn subscribed_of(
    state: &ServerState,
    handle: &ConnectionHandle,
) -> Vec<(u32, Option<NotificationSeries>)> {
    let mut subscribed: Vec<(u32, Option<NotificationSeries>)> = state
        .notifications
        .subscriptions(Some(handle))
        .into_iter()
        .filter(|held| {
            !is_in_flight(
                state,
                &CallAddress {
                    connection_handle: Arc::clone(handle),
                    call_id: held.call_id,
                },
            )
        })
        .map(|held| {
            (
                held.call_id,
                state.notifications.series_of(held.call_id, handle),
            )
        })
        .collect();

    if let Some(calls) = state.waiting.get(handle) {
        subscribed.extend(
            calls
                .values()
                .map(|successor| (successor.call.call_id, successor.call.series.clone())),
        );
    }

    subscribed
}

// an answer about to go out for a call: a failure takes away what it subscribed; a success keeps it,
// subscribes the call when it notifies, or has it wait on a holder in flight
fn settle_place(
    state: &mut ServerState,
    (call, (is_failure, notifies, procedure)): (SubscribingCall, (bool, bool, ProcedureAddress)),
) -> Option<Undo<ServerState>> {
    let address = CallAddress {
        connection_handle: Arc::clone(&call.connection_handle),
        call_id: call.call_id,
    };
    let mut is_subscribed = take_in_flight(state, &address);

    // a failure subscribes nobody, whatever its resolver did before it, and leaves its place to the
    // call that waited on it
    if is_failure {
        if is_subscribed {
            unregister_tracked(state, (call.call_id, &call.connection_handle));

            let successor = take_waiting(state, &address);

            hand_over(state, (successor, &call.connection_handle));
        }

        return None;
    }

    let holder = notifies
        .then(|| {
            state.notifications.subscription_of(
                procedure,
                (&call.connection_handle, call.identifier.as_ref()),
            )
        })
        .flatten();

    // a notification's successful answer subscribes the connection under the request's call id,
    // when its resolver did not and the connection holds no place for it yet, before it goes out
    if notifies && holder.is_none() && register_tracked(state, (procedure, &call)).is_ok() {
        is_subscribed = true;
    }

    // answered while another call, still in flight, holds the place: the first answered waits
    if let Some(holder) = holder
        && holder != call.call_id
        && is_in_flight(
            state,
            &CallAddress {
                connection_handle: Arc::clone(&call.connection_handle),
                call_id: holder,
            },
        )
        && !state
            .waiting
            .get(&call.connection_handle)
            .is_some_and(|calls| calls.contains_key(&holder))
        && let Some(calls) = state
            .waiting
            .entry_or_insert_with(Arc::clone(&call.connection_handle), Ordered::new)
    {
        calls.insert(
            holder,
            Waiting {
                call: call.clone(),
                procedure,
            },
        );
    }

    if !is_subscribed {
        return None;
    }

    // answered, the call keeps its place: what waited on it waits no more, unless the answer does
    // not go out, which takes away what it subscribed and hands the place over
    let successor = take_waiting(state, &address);
    let handle = Arc::clone(&call.connection_handle);
    let call_id = call.call_id;

    Some(Box::new(move |state: &mut ServerState| {
        unregister_tracked(state, (call_id, &handle));
        hand_over(state, (successor, &handle));
    }))
}

// subscribes a call to its procedure, in its session, in flight until its answer settles it; a
// connection that holds the place in that session already gives the holder's
fn subscribe_place(
    state: &mut ServerState,
    (call, procedure): (&SubscribingCall, ProcedureAddress),
) -> Result<u32, CallError> {
    if let Some(holder) = state.notifications.subscription_of(
        procedure,
        (&call.connection_handle, call.identifier.as_ref()),
    ) {
        return Ok(holder);
    }

    // ! in flight before it is registered: what its registration sets going drops no call still
    // owed its answer
    if let Some(calls) = state
        .in_flight
        .entry_or_insert_with(Arc::clone(&call.connection_handle), Vec::new)
    {
        calls.push(call.call_id);
    }

    register_tracked(state, (procedure, call)).map_err(CallError::Refused)?;

    Ok(call.call_id)
}

// the server's subscribe: a request that opens a subscription, on a connection open, still owed its
// answer, subscribes its connection to its procedure
fn subscribe(state: &mut ServerState, dispatch: &Arc<Dispatch>) -> Result<u32, CallError> {
    let header = &dispatch.header;
    let handle = &dispatch.connection_handle;

    if !header.opens_subscription {
        return Err(CallError::Refused(ProgrammerError::new(format!(
            "call {} opens no subscription: an ordinary request to {}/{} subscribes nothing",
            header.call_id, header.service_id, header.procedure_id
        ))));
    }

    if !state.connections.contains_key(handle) {
        return Err(CallError::Disconnected(format!(
            "{handle} is not an open connection"
        )));
    }

    if !is_answering(state, dispatch) {
        return Err(CallError::Cancelled);
    }

    let procedure = ProcedureAddress {
        service_id: header.service_id,
        procedure_id: header.procedure_id,
    };
    let session = dispatch
        .session
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let (end, identifier) = subscribing_of(session.as_ref());
    let call = SubscribingCall {
        call_id: header.call_id,
        connection_handle: Arc::clone(handle),
        end,
        identifier,
        paced: header.paced,
        series: state.series_of_procedure(procedure),
    };
    let subscribed = subscribe_place(state, (&call, procedure))?;

    // the call took the place, in flight: its request answers it, should its queue go past its
    // bounds before its answer
    if subscribed == header.call_id && state.notifications.pacing_of(subscribed, handle).is_some() {
        state
            .requests
            .insert((Arc::clone(handle), subscribed), Arc::clone(dispatch));
    }

    Ok(subscribed)
}

// ── Notifying ────────────────────────────────────────────────────────────────────────────────

// one notification to one subscription, counted into its subscription's series
fn send_notification(state: &mut ServerState, (payload, call): (Bytes, CallAddress)) {
    let series = state.core.metrics.as_ref().and_then(|_| {
        state
            .notifications
            .series_of(call.call_id, &call.connection_handle)
    });
    let handle = Arc::clone(&call.connection_handle);

    crate::router::core::send_notification(
        state,
        (
            (payload, call, series),
            Some(Box::new(
                move |state: &mut ServerState, outcome: Result<(), CallError>| match outcome {
                    Ok(()) => state.activity(RouterActivity::Notification, &handle),
                    Err(error) => state.report(reported_call(error), &handle),
                },
            )),
        ),
    );
}

// ends an established subscription with `failure` on its call id, forgotten as the failure goes, so
// no notification follows it, and counted dropped at this end
fn end_subscription(
    state: &mut ServerState,
    (call, series, failure): (CallAddress, Option<NotificationSeries>, Failure),
) {
    if let Some(series) = &series {
        series.dropped(Some((failure.code(), failure.scope())));
    }

    let handle = Arc::clone(&call.connection_handle);

    crate::router::core::send_reporting(
        state,
        (
            Envelope::Failure {
                header: FailureHeader {
                    call_id: call.call_id,
                    credential: None,
                },
                failure: failure.record(),
            },
            &handle,
        ),
    );
    unregister_tracked(state, (call.call_id, &handle));
}

// a subscription that queued past its bounds ends: in flight, its call is answered with the failure;
// established, the failure follows its answer
fn exceed(state: &mut ServerState, call: CallAddress) {
    let failure = state
        .core
        .failure(ProtocolCode::CAPACITY_EXCEEDED)
        .saying(format!(
            "the notifications queued for call {} went past their bounds",
            call.call_id
        ));
    let request = state
        .requests
        .get(&(Arc::clone(&call.connection_handle), call.call_id))
        .cloned();

    match request.filter(|request| is_answering(state, request)) {
        None => {
            let series = state
                .notifications
                .series_of(call.call_id, &call.connection_handle);

            end_subscription(state, (call, series, failure));
        }
        Some(request) => {
            let handle = Arc::clone(&call.connection_handle);

            respond(
                state,
                (
                    RouterAnswer::Failure(failure.record()),
                    request,
                    Some(Box::new(
                        move |state: &mut ServerState, outcome: Result<(), CallError>| {
                            if let Err(error) = outcome {
                                state.report(reported_call(error), &handle);
                            }
                        },
                    )),
                ),
            );
        }
    }
}

/// Ends what a session bounds on its connection — its connection's, or a credential's by its
/// identifier: each established subscription, and each call waiting, with a failure on its call id.
pub(crate) fn end_session(
    state: &mut ServerState,
    (handle, identifier, failure): (
        &ConnectionHandle,
        Option<&SessionIdentifier>,
        Option<Failure>,
    ),
) {
    let failure = failure.unwrap_or_else(|| state.core.failure(ProtocolCode::SESSION_REQUIRED));

    for (call_id, series) in drop_places(state, (handle, identifier)) {
        end_subscription(
            state,
            (
                CallAddress {
                    connection_handle: Arc::clone(handle),
                    call_id,
                },
                series,
                failure.clone(),
            ),
        );
    }
}

/// Which subscriptions a notification goes to, and the key a paced queue keeps the last of.
pub(crate) type Notifying = (Option<NotifyFilter>, Option<NotificationKey>);

/// What a notification goes to: each subscription a filter keeps, by its subscriber.
pub type NotifyFilter =
    Arc<dyn Fn(&ConnectionHandle, Option<&SessionIdentifier>) -> bool + Send + Sync>;

/// Sends a notification's payload to each subscription its procedure holds that `filter` keeps; or,
/// given why its value does not write, sends it to none, counts it failed, and reports why once.
pub(crate) fn notify(
    state: &mut ServerState,
    (payload, procedure, (filter, key)): (Result<Bytes, RouterError>, ProcedureAddress, Notifying),
) {
    // who gets it is settled before any is sent
    let targets: Vec<_> = state
        .notifications
        .candidates(procedure)
        .into_iter()
        .filter(|subscription| {
            filter.as_ref().is_none_or(|filter| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    filter(
                        &subscription.connection_handle,
                        subscription.identifier.as_ref(),
                    )
                }))
                .unwrap_or(false)
            })
        })
        .collect();
    let payload = match payload {
        Ok(payload) => payload,
        // a value that does not write goes to none: each subscription it was for counts it failed,
        // and why is reported once (spec 17.2, item 6)
        Err(error) => {
            for target in &targets {
                if let Some(series) = state
                    .notifications
                    .series_of(target.call_id, &target.connection_handle)
                {
                    series.failed();
                }
            }

            state.listeners.report(&error, None);

            return;
        }
    };

    // offered in order, each before the next: a paced subscription sends it, queues it, or ends
    for target in targets {
        let call = CallAddress {
            connection_handle: Arc::clone(&target.connection_handle),
            call_id: target.call_id,
        };
        let outcome = state
            .notifications
            .pacing_of(call.call_id, &call.connection_handle)
            .map(|pacing| pacing.offer((key.clone(), payload.clone())));

        match outcome {
            None | Some(PacingOutcome::Send) => send_notification(state, (payload.clone(), call)),
            Some(PacingOutcome::Queued) => {}
            Some(PacingOutcome::Exceeded) => exceed(state, call),
        }
    }
}

// ── Transport events ─────────────────────────────────────────────────────────────────────────

// the subscriptions a connection held, answered, dropped with it at this end, with no code
fn drop_with(state: &ServerState, handle: &ConnectionHandle) {
    if state.core.metrics.is_some() {
        for (_, series) in subscribed_of(state, handle) {
            if let Some(series) = series {
                series.dropped(None);
            }
        }
    }
}

pub(crate) fn on_message(
    state: &mut ServerState,
    (message, handle): (TransportMessage, &ConnectionHandle),
) {
    // a connection that speaks is open, even one opened before the router was built
    state.connections.insert(Arc::clone(handle), ());
    crate::router::relay::opened(&state.relay, handle);
    crate::router::core::receive(state, (message, handle));
}

pub(crate) fn on_connection(state: &mut ServerState, handle: &ConnectionHandle) {
    state.connections.insert(Arc::clone(handle), ());
    crate::router::relay::opened(&state.relay, handle);
}

pub(crate) fn on_close(state: &mut ServerState, handle: &ConnectionHandle) {
    drop_with(state, handle);
    state.connections.remove(handle);
    // its destinations stay unreachable until each is registered anew, on another connection
    crate::router::relay::close_connection(&state.relay, handle);
    state.in_flight.remove(handle);
    state.waiting.remove(handle);
    clean_tracked(state, handle);
    state.requests.retain(|(held, _), _| held != handle);
    crate::router::core::reject_pending(
        state,
        ("the connection closed before the answer", Some(handle)),
    );
}

/// Disposes of the router: what each connection held is dropped, and every call ends.
pub(crate) fn dispose(state: &mut ServerState) {
    let followed: Vec<ConnectionHandle> = state.connections.keys().cloned().collect();

    for handle in &followed {
        drop_with(state, handle);
    }

    if let Some(listener) = state.listener.take() {
        state.transport.unlisten(&listener);
    }

    state.connections.clear();
    state.in_flight.clear();
    state.waiting.clear();

    for (_, sessions) in state.kept.drain() {
        for (_, mut session) in sessions.into_iter_entries() {
            if let Some(timer) = session.timer.take() {
                timer.cancel();
            }
        }
    }

    crate::router::core::dispose(state);

    for handle in &followed {
        state.notifications.clean(handle);
    }
}

// what posts a transport's events to the router's owner, in the order the transport tells them,
// behind every job queued, one told from within its router's turn too (spec 9.0): ! a handle to
// the owner, so a router lives as long as its transport holds it (decision 0044)
struct Bridge {
    owner: Owner<ServerState>,
}

impl ServerListener for Bridge {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        let handle = Arc::clone(connection_handle);
        self.owner
            .offer_behind(Box::new(move |state: &mut ServerState| {
                crate::server::on_connection(state, &handle);
                on_connection(state, &handle);
            }));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        let handle = Arc::clone(connection_handle);
        self.owner
            .offer_behind(Box::new(move |state: &mut ServerState| {
                crate::server::on_message(state, &handle);
                on_message(state, (message, &handle));
            }));
    }

    fn on_close(&self, _was_clean: bool, connection_handle: &ConnectionHandle) {
        let handle = Arc::clone(connection_handle);
        self.owner
            .offer_behind(Box::new(move |state: &mut ServerState| {
                crate::server::on_close(state, &handle);
                on_close(state, &handle);
            }));
    }

    fn on_listen(&self, is_held: bool, connection_handle: &ConnectionHandle) {
        let handle = Arc::clone(connection_handle);
        self.owner
            .offer_behind(Box::new(move |state: &mut ServerState| {
                crate::server::on_listen(state, (is_held, &handle));
            }));
    }

    // * what its transport reports is its transport's: an application hears it there, whichever
    // transport it built, as on the other sides (spec 15.1)
}

// ── The handle ───────────────────────────────────────────────────────────────────────────────

/// A call's outcome, to wait for: the call went when it was made, and dropping this sends nothing
/// more and cancels nothing.
#[must_use = "the call is sent already; its future only waits for its answer"]
#[derive(Debug)]
pub struct Call {
    answer: Option<oneshot::Receiver<Result<RouterResult, CallError>>>,
}

impl Call {
    pub(crate) fn of(answer: oneshot::Receiver<Result<RouterResult, CallError>>) -> Self {
        Self {
            answer: Some(answer),
        }
    }

    /// A call that ended before it went, with `error`: what a router of the application's own gives
    /// for a call it refuses.
    pub fn refused(error: CallError) -> Self {
        let (reply, answer) = oneshot::channel();

        drop(reply.send(Err(error)));

        Self::of(answer)
    }
}

impl Future for Call {
    type Output = Result<RouterResult, CallError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let Some(answer) = self.answer.as_mut() else {
            return Poll::Ready(Err(CallError::Disconnected(
                crate::router::core::DISPOSED.to_owned(),
            )));
        };

        Pin::new(answer).poll(context).map(|answer| {
            answer.unwrap_or_else(|_dropped| {
                Err(CallError::Disconnected(
                    crate::router::core::DISPOSED.to_owned(),
                ))
            })
        })
    }
}

/// A call of the server's own, to a connection its options name.
#[derive(Debug, Clone)]
pub struct ServerRequest {
    /// The procedure it calls.
    pub procedure: ProcedureAddress,
    /// The bytes a payload of it holds at most.
    pub maximum_payload_bytes: Option<u64>,
    /// Its options, resolved: the connection it goes to among them.
    pub options: ResolvedRequestOptions,
    /// The series it counts into: its requester's.
    pub series: Option<ProcedureSeries>,
    /// What refuses it once it started, as its requester judged it.
    pub refusal: Option<CallError>,
}

/// What hears a call's id, and its hand-off to its transport.
#[derive(Default)]
#[non_exhaustive]
pub struct CallHooks {
    /// Hears the call's id once its router drew it.
    pub on_call_id: Option<Box<dyn FnOnce(u32) + Send>>,
    /// Hears whether its transport took it.
    pub on_sent: Option<Box<dyn FnMut(bool) + Send>>,
}

impl fmt::Debug for CallHooks {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("CallHooks").finish_non_exhaustive()
    }
}

struct Shared {
    owner: Owner<ServerState>,
    disposal: Disposal,
    clock: SharedClock,
    limits: RouterLimits,
    metrics: Option<RouterMetrics>,
    resolvers: Resolvers,
    transport: Arc<dyn ServerTransport>,
    listeners: Arc<ServerListeners>,
    notifyings: Arc<Mutex<BTreeMap<ProcedureAddress, NotificationSeries>>>,
    relay: crate::router::relay::Relay,
}

/// The server side of a router, over a transport server: a handle to its owner.
#[derive(Clone)]
pub struct RouterServer {
    shared: Arc<Shared>,
}

impl fmt::Debug for RouterServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouterServer")
            .finish_non_exhaustive()
    }
}

/// The time driver's check: a router's runtime enables tokio's time driver (decision 0044).
pub(crate) fn runtime_of(given: Option<&Handle>) -> Result<Handle, ProgrammerError> {
    let runtime = match given {
        Some(runtime) => runtime.clone(),
        None => Handle::try_current().map_err(|_none| {
            ProgrammerError::new("a router is built within a tokio runtime, or given its handle")
        })?,
    };
    let entered = runtime.enter();
    // ! what tokio panics as a timer is armed on a runtime without its time driver is caught here,
    // once, as the router is built, never inside a later call
    let armed = std::panic::catch_unwind(|| {
        drop(tokio::time::sleep(Duration::ZERO));
    });

    drop(entered);

    if armed.is_err() {
        return Err(ProgrammerError::new(
            "a router's runtime enables tokio's time driver",
        ));
    }

    Ok(runtime)
}

impl RouterServer {
    /// A server's router over `transport`, built before the transport starts, so it sees every
    /// connection.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime or on one without its time driver, for a clock
    /// given that differs from its transport's, for limits that do not hold together, or for
    /// credentials that do not hold.
    pub fn new(
        transport: Arc<dyn ServerTransport>,
        options: &RouterServerOptions,
    ) -> Result<Self, ProgrammerError> {
        Self::build(transport, (options, None))
    }

    pub(crate) fn build(
        transport: Arc<dyn ServerTransport>,
        (options, facade): (&RouterServerOptions, Option<crate::server::Facade>),
    ) -> Result<Self, ProgrammerError> {
        let runtime = runtime_of(options.runtime.as_ref())?;
        let clock = crate::clock::clock_of(
            (transport.clock().as_ref(), options.clock.as_ref()),
            ("a server's router", "its transport"),
        )?
        .unwrap_or_else(|| {
            let platform: SharedClock = Arc::new(crate::clock::SystemClock::new(runtime.clone()));

            platform
        });
        let limits = limits_of(&options.limits.clone().unwrap_or_default())?;
        let pacing = pacing_limits_of(&options.pacing.clone().unwrap_or_default())?;
        let credentials = CredentialResolver::new(
            &options.credentials.clone().unwrap_or_default(),
            (Arc::clone(&clock), runtime.clone()),
        )?;

        // a router that takes a JWT holds its header: its limits hold 1,024 bytes at least
        if credentials.takes_jwt() {
            assert_limits_hold_jwt(&limits)?;
        }

        let relay = crate::router::relay::Relay::new(
            (RouterSide::Server, limits),
            options.relay.clone().unwrap_or_default(),
        )?;
        let metrics = options
            .metrics_registry
            .as_ref()
            .map(|registry| registry.attach(RouterSide::Server));
        let listeners = Arc::new(ServerListeners::default());
        let notifyings = Arc::new(Mutex::new(BTreeMap::new()));
        let resolvers = Resolvers::default();
        let disposal = Disposal::default();
        let owner = Owner::spawn((&runtime, &clock), |weak: WeakOwner<ServerState>| {
            ServerState {
                core: Core {
                    resolvers: Arc::clone(&resolvers),
                    disposal: disposal.clone(),
                    ..Core::new(
                        weak,
                        (
                            RouterSide::Server,
                            limits,
                            Arc::clone(&clock),
                            metrics.clone(),
                        ),
                    )
                },
                transport: Arc::clone(&transport),
                listener: None,
                connections: Ordered::new(),
                credentials,
                notifications: NotificationManager::new(pacing),
                in_flight: Ordered::new(),
                waiting: Ordered::new(),
                kept: Ordered::new(),
                requests: BTreeMap::new(),
                notifyings: Arc::clone(&notifyings),
                relay: relay.clone(),
                listeners: Arc::clone(&listeners),
                facade,
            }
        });
        let listener: Arc<dyn ServerListener> = Arc::new(Bridge {
            owner: owner.clone(),
        });

        transport.listen(Arc::clone(&listener));

        owner.offer(Box::new(move |state: &mut ServerState| {
            state.listener = Some(listener);
        }));

        Ok(Self {
            shared: Arc::new(Shared {
                owner,
                disposal,
                clock,
                limits,
                metrics,
                resolvers,
                transport,
                listeners,
                notifyings,
                relay,
            }),
        })
    }

    pub(crate) fn owner(&self) -> &Owner<ServerState> {
        &self.shared.owner
    }

    // marks it disposed at once, before what it holds is let go in a later turn (spec 9.0)
    pub(crate) fn mark_disposed(&self) {
        self.shared.disposal.set();
    }

    /// The clock it runs on, its transport's.
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
    pub fn transport(&self) -> Arc<dyn ServerTransport> {
        Arc::clone(&self.shared.transport)
    }

    /// Hears what it reports from now on: an error, and the connection it came with.
    pub fn on_error(&self, listener: ErrorListener) {
        self.shared
            .listeners
            .error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Hears each envelope it sends or takes from now on.
    pub fn on_debug(&self, listener: EnvelopeListener) {
        self.shared
            .listeners
            .debug
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Hears each access it refuses from now on (spec 13.12).
    pub fn on_access_refused(&self, listener: RefusalListener) {
        self.shared
            .listeners
            .access_refused
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Hears what it did on a connection from now on.
    pub fn on_activity(&self, listener: ActivityListener) {
        self.shared
            .listeners
            .activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Reports what went wrong that no call waits on, with the connection it came with.
    pub fn report(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        self.shared.listeners.report(error, connection_handle);
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
        check_procedure_kind(procedure, DeclarationWay::ServerRequester)?;

        self.shared
            .metrics
            .as_ref()
            .map(|metrics| metrics.declare_requester(procedure))
            .transpose()
    }

    /// Registers a resolver of `procedure`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, a second one for its procedure,
    /// or a declaration its registry refuses.
    pub(crate) fn register_resolver(
        &self,
        (procedure, handler): (&Procedure, Handler),
    ) -> Result<(), ProgrammerError> {
        check_declaration(procedure)?;
        check_procedure_kind(
            procedure,
            if handler.notifies {
                DeclarationWay::ServerNotificationResolver
            } else {
                DeclarationWay::ServerResolver
            },
        )?;

        let series = crate::router::core::register_resolver(
            &self.shared.resolvers,
            (procedure, handler, self.shared.metrics.as_ref()),
        )?;

        if let Some(notifying) = series.and_then(|series| series.notifying) {
            self.shared
                .notifyings
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(procedure.address(), notifying);
        }

        Ok(())
    }

    /// Makes a call of the server's own to the connection its options name, sent as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for options that name no connection, or a timeout spec 1.4 does not
    /// hold.
    pub fn request(
        &self,
        payload: Bytes,
        (request, hooks): (ServerRequest, CallHooks),
    ) -> Result<Call, ProgrammerError> {
        request_on(&self.shared.owner.downgrade(), (payload, request, hooks))
    }

    /// Sends a notification's payload to each subscription its procedure holds that `filter`
    /// keeps; or, given why its value does not write, to none.
    pub fn notify(
        &self,
        payload: Result<Bytes, RouterError>,
        (procedure, filter, key): (
            ProcedureAddress,
            Option<NotifyFilter>,
            Option<NotificationKey>,
        ),
    ) -> BoxFuture<()> {
        let posted = self.shared.owner.run(move |state: &mut ServerState| {
            notify(state, (payload, procedure, (filter, key)));
        });

        Box::pin(async move {
            posted.await.ok();
        })
    }

    /// Ends the credential's session `identifier` names on every connection that keeps it.
    pub fn end_session(&self, identifier: SessionIdentifier) -> BoxFuture<()> {
        let posted = self.shared.owner.run(move |state: &mut ServerState| {
            end_credential_session(state, &identifier);
        });

        Box::pin(async move {
            posted.await.ok();
        })
    }

    /// Ends every `JWT`'s session whose identifier's issuer is `issuer`.
    pub fn end_sessions_of(&self, issuer: String) -> BoxFuture<()> {
        let posted = self.shared.owner.run(move |state: &mut ServerState| {
            end_sessions_of(state, &issuer);
        });

        Box::pin(async move {
            posted.await.ok();
        })
    }

    /// Ends the subscriptions of a connection's session, with `failure`.
    pub fn drop_subscriptions(
        &self,
        (connection_handle, failure): (ConnectionHandle, Failure),
    ) -> BoxFuture<()> {
        let posted = self.shared.owner.run(move |state: &mut ServerState| {
            end_session(state, (&connection_handle, None, Some(failure)));
        });

        Box::pin(async move {
            posted.await.ok();
        })
    }

    /// Registers a destination of its relay.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] as the relay refuses it.
    pub fn register_destination(
        &self,
        (target, options): (
            crate::router::relay::RelayTarget,
            crate::router::relay::DestinationOptions,
        ),
    ) -> Result<crate::router::relay::DestinationRegistration, ProgrammerError> {
        crate::router::relay::register(&self.shared.relay, (target, options))
    }

    /// The destinations registered.
    #[must_use]
    pub fn destinations(&self) -> Vec<crate::router::relay::Destination> {
        crate::router::relay::destinations(&self.shared.relay)
    }

    /// What it holds right now, for diagnosis.
    pub fn gauges(&self) -> BoxFuture<Gauges> {
        let gauged = self
            .shared
            .owner
            .run(|state: &mut ServerState| gauges(state));

        Box::pin(async move { gauged.await.unwrap_or_default() })
    }

    /// Disposes of it: every call ends, and nothing more goes out. Disposed at once, it lets go of
    /// what it holds in a later turn, behind what came before it, a listener's dispose too (spec
    /// 9.0).
    pub fn dispose(&self) -> BoxFuture<()> {
        self.shared.disposal.set();

        let disposed = self.shared.owner.run_behind(dispose);

        Box::pin(async move {
            disposed.await.ok();
        })
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

/// What a server's router holds, merged.
pub(crate) fn gauges(state: &ServerState) -> Gauges {
    let mut own = Gauges::default();

    own.counts.insert(
        "connections",
        u64::try_from(state.connections.len()).unwrap_or(u64::MAX),
    );
    own.connection_handles
        .extend(state.connections.keys().cloned());

    let mut places = Gauges::default();

    places.counts.insert(
        "subscriptionsInFlight",
        state
            .in_flight
            .values()
            .map(|calls| u64::try_from(calls.len()).unwrap_or(u64::MAX))
            .sum(),
    );
    places.counts.insert(
        "subscriptionsWaiting",
        state
            .waiting
            .values()
            .map(|calls| u64::try_from(calls.len()).unwrap_or(u64::MAX))
            .sum(),
    );
    places
        .connection_handles
        .extend(state.in_flight.keys().cloned());

    let mut sessions = Gauges::default();
    let timed: u64 = state
        .kept
        .values()
        .flat_map(Ordered::values)
        .map(|kept| u64::from(kept.timer.is_some()))
        .sum();

    sessions.counts.insert(
        "credentialSessions",
        state
            .kept
            .values()
            .map(|sessions| u64::try_from(sessions.len()).unwrap_or(u64::MAX))
            .sum(),
    );
    sessions.counts.insert("timedCredentialSessions", timed);
    sessions
        .connection_handles
        .extend(state.kept.keys().cloned());

    Gauges::merged(vec![
        own,
        state.core.gauges(),
        places,
        state.notifications.gauges(),
        sessions,
        crate::router::relay::gauges(&state.relay),
    ])
}

/// Makes a call of the server's own on the owner `owner`, sent as it is made.
pub(crate) fn request_on(
    owner: &WeakOwner<ServerState>,
    (payload, request, hooks): (Bytes, ServerRequest, CallHooks),
) -> Result<Call, ProgrammerError> {
    let ServerRequest {
        procedure,
        maximum_payload_bytes,
        options,
        series,
        refusal,
    } = request;
    let Some(named) = options.connection_handle.clone() else {
        return Err(ProgrammerError::new(
            "a server request names the connection it goes to",
        ));
    };

    hold("a call's timeout", options.timeout)?;

    if let Some(RequestCredential::Jwt(token)) = &options.credential
        && token.is_empty()
    {
        return Err(ProgrammerError::new(
            "a call that presents a JWT gives its token, a string",
        ));
    }

    let (reply, answer) = oneshot::channel();
    let posted = owner.post(Box::new(move |state: &mut ServerState| {
        let is_open = state.connections.contains_key(&named);
        // OPAQUE, the connection's session, as its answers announce it; a JWT, or an ELSEWHERE
        // beside it; OPAQUE with no session refuses the call once it started
        let token =
            crate::server::sessions_of(state).and_then(|sessions| sessions.token_of(&named));
        let mut own_refusal: Option<CallError> = None;
        let (credential, carried) = match presented_credential_of(
            options.credential.as_ref(),
            (RouterSide::Server, token.as_ref()),
        ) {
            Ok(presented) => (presented.credential, presented.carried),
            Err(error) => {
                own_refusal = Some(error);

                (None, None)
            }
        };
        // a credential its transport cannot carry fails the call before it goes: nothing was tried
        let uncarried = is_open
            .then(|| {
                let transport = Arc::clone(&state.transport);

                uncarried_of(
                    credential.as_ref(),
                    &Carriage {
                        carried: carried.as_deref(),
                        takes: &|_carried: &str| transport.carries_credential(&named),
                        side: RouterSide::Server,
                        is_secure: transport.is_secure(&named),
                    },
                )
            })
            .flatten();

        if !is_open {
            own_refusal = Some(CallError::Disconnected(format!(
                "{named} is not an open connection"
            )));
        } else if own_refusal.is_none()
            && let Some(uncarried) = uncarried
        {
            own_refusal = Some(CallError::Failure(
                uncarried.of_call(Some(procedure), options.destination_id),
            ));
        }

        crate::router::requester::request(
            state,
            (
                payload,
                CoreRequest {
                    connection_handle: named,
                    credential,
                    on_call_id: hooks.on_call_id,
                    on_sent: hooks.on_sent,
                    opens_subscription: false,
                    paced: false,
                    options,
                    procedure,
                    maximum_payload_bytes,
                    // * its requester's refusal before the router's own
                    refusal: refusal.or(own_refusal),
                    series,
                    transport_credential: carried,
                },
                Box::new(move |outcome| {
                    drop(reply.send(outcome));
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

// keeps the types a later stage names in use
const _: usize = SESSION_TOKEN_BYTES;
const _: Option<fn(&RequestHeader)> = None;
const _: Option<FailureRecord> = None;
const _: Option<Responded<ServerState>> = None;
const _: fn(Failure) -> RouterError = reported;
const _: Option<Unresolved> = None;
