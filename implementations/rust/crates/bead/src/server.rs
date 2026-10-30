//! A server: a transport server, its router, its sessions and its services, built together. A
//! connection without a session closes once silent for the server's own timeout; one with a session
//! follows its session's timers; a listen held stops both while it lasts.

use core::fmt;
use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::Value;
use tokio::runtime::Handle;

use crate::clock::{SharedClock, SystemClock, Timer, clock_of};
use crate::constants::ProtocolCode;
use crate::credentials::Credentials;
use crate::duration::{NEVER, hold};
use crate::errors::{CallError, ProgrammerError};
use crate::managers::notification::PacingLimitsOptions;
use crate::managers::service::{
    RequestDefaults, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::managers::sessions::{
    Arming, Inactivity, Session, SessionEvent, SessionManager, SessionManagerOptions,
};
use crate::metrics::MetricsRegistry;
use crate::ordered::Ordered;
use crate::owner::WeakOwner;
use crate::router::admissions::require_credential;
use crate::router::relay::RelayOptions;
use crate::router::server::{RouterServer, RouterServerOptions, ServerState, end_session};
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, RouterLimitsOptions};
use crate::session_token::SessionToken;
use crate::transport::{Listened, ListenerId, ServerTransport};

#[cfg(test)]
mod tests;

/// What hears what happens to a server's sessions.
pub type SessionListener = Arc<dyn Fn(&SessionEvent) + Send + Sync>;

/// How a server is built, beyond its transport.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ServerOptions {
    /// The clock every layer runs on: its transport's, which one given must be.
    pub clock: Option<SharedClock>,
    /// The runtime its owner runs on: the current one when none.
    pub runtime: Option<Handle>,
    /// What resolves a `JWT` and an `ELSEWHERE`.
    pub credentials: Option<Credentials>,
    /// Its router's limits.
    pub limits: Option<RouterLimitsOptions>,
    /// How long a connection without a session may stay silent: [`NEVER`] by default.
    pub connection_inactivity_timeout: Option<Duration>,
    /// Whether a command unanswered past its timeout closes its connection.
    pub close_on_command_timeout: Option<bool>,
    /// What its router counts its calls into.
    pub metrics_registry: Option<MetricsRegistry>,
    /// What a paced subscription queues at most.
    pub pacing: Option<PacingLimitsOptions>,
    /// Its router's relay's options: its admission, `require_credential` when none.
    pub relay: Option<RelayOptions>,
    /// Its sessions' defaults, and their clock, which must be its own.
    pub sessions: Option<SessionManagerOptions>,
}

impl fmt::Debug for ServerOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerOptions")
            .field("limits", &self.limits)
            .field(
                "connection_inactivity_timeout",
                &self.connection_inactivity_timeout,
            )
            .finish_non_exhaustive()
    }
}

/// What a server keeps beside its router, in its router's owner.
pub(crate) struct Facade {
    pub(crate) sessions: SessionManager,
    // the connections the transport holds: only these keep a session
    connections: Ordered<ConnectionHandle, ()>,
    // the connections being closed, so each is asked to close once
    closing: BTreeSet<ConnectionHandle>,
    // the connections with no session, each with the timer that closes it once silent
    idle: Ordered<ConnectionHandle, Option<Arc<dyn Timer>>>,
    // the listens each connection holds
    listens: Ordered<ConnectionHandle, u32>,
    connection_inactivity_timeout: Duration,
    listeners: Arc<Listened<SessionListener>>,
}

impl fmt::Debug for Facade {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Facade")
            .field("connections", &self.connections.len())
            .finish_non_exhaustive()
    }
}

// what arms a session's timers on the router's owner
struct SessionArming {
    owner: WeakOwner<ServerState>,
    clock: SharedClock,
}

impl Arming for SessionArming {
    fn arm(
        &self,
        due: Duration,
        (inactivity, connection_handle): (Inactivity, ConnectionHandle),
    ) -> Arc<dyn Timer> {
        // * cancelled once it fired, as a touch restarts it, its job does nothing
        self.owner
            .after((&self.clock, due), move |state: &mut ServerState| {
                reached(state, (inactivity, &connection_handle));
            })
    }
}

// the clock the sessions run on: the router's, which the server handed them
fn sessions_clock_of(state: &ServerState) -> &SharedClock {
    state
        .facade
        .as_ref()
        .map_or(&state.core.clock, |facade| facade.sessions.clock())
}

fn arming_of(state: &ServerState) -> SessionArming {
    SessionArming {
        owner: state.core.owner.clone(),
        clock: Arc::clone(sessions_clock_of(state)),
    }
}

fn wall_of(state: &ServerState) -> i64 {
    wall_milliseconds(sessions_clock_of(state))
}

fn wall_milliseconds(clock: &SharedClock) -> i64 {
    clock
        .wall()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

// what happened to the sessions, told: the server's own reaction first, which may tell more, then
// the application's listeners, each within a guard
fn told(state: &mut ServerState, events: Vec<SessionEvent>) {
    for event in events {
        react(state, &event);

        let Some(facade) = state.facade.as_ref() else {
            continue;
        };
        for listener in facade.listeners.all() {
            let called =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)));

            if let Err(panicked) = called {
                state
                    .listeners
                    .report(&crate::transport::panic_error(&*panicked), None);
            }
        }
    }
}

fn react(state: &mut ServerState, event: &SessionEvent) {
    match event {
        // a session stored once its connection was gone would outlive it; the session's own timers
        // take over from the idle one
        SessionEvent::Created(session) => {
            let handle = &session.connection_handle;
            let is_open = state
                .facade
                .as_ref()
                .is_some_and(|facade| facade.connections.contains_key(handle));

            if !is_open {
                let mut events = Vec::new();

                if let Some(facade) = state.facade.as_mut() {
                    facade.sessions.delete(handle, &mut events);
                }

                return told(state, events);
            }

            stop_waiting(state, handle);
            stored(state, handle);
        }
        SessionEvent::Updated(session) => stored(state, &session.connection_handle),
        // a session that ended takes with it what its connection subscribed to, and leaves the
        // connection the server's own timeout, counted from the end
        SessionEvent::Deleted(session) => {
            let handle = &session.connection_handle;
            let is_open = state
                .facade
                .as_ref()
                .is_some_and(|facade| facade.connections.contains_key(handle));

            if is_open {
                let failure = state.core.failure(ProtocolCode::SESSION_REQUIRED);

                end_session(state, (handle, None, Some(failure)));
                wait(state, handle);
            }
        }
        // a connection silent for too long is gone: closing it ends its session too; ! one whose
        // listen is held is not silent
        SessionEvent::ConnectionInactivityTimeoutReached(session) => {
            let handle = &session.connection_handle;
            let is_listening = state
                .facade
                .as_ref()
                .is_some_and(|facade| facade.listens.contains_key(handle));

            if !is_listening {
                close(state, handle);
            }
        }
        // a session unused for too long ends; its connection stays, to open another
        SessionEvent::SessionInactivityTimeoutReached(session) => {
            let mut events = Vec::new();

            if let Some(facade) = state.facade.as_mut() {
                facade
                    .sessions
                    .delete(&session.connection_handle, &mut events);
            }

            told(state, events);
        }
        SessionEvent::DataChanged(..)
        | SessionEvent::LastActivityChanged(..)
        | SessionEvent::ConnectionInactivityTimeoutChanged(..)
        | SessionEvent::SessionInactivityTimeoutChanged(..) => {}
    }
}

// a session stored anew restarts its connection timer, which a listen held keeps stopped
fn stored(state: &mut ServerState, handle: &ConnectionHandle) {
    let is_listening = state
        .facade
        .as_ref()
        .is_some_and(|facade| facade.listens.contains_key(handle));

    if is_listening {
        hold_session(state, handle);
    }
}

fn reached(state: &mut ServerState, (inactivity, handle): (Inactivity, &ConnectionHandle)) {
    let event = state
        .facade
        .as_ref()
        .and_then(|facade| facade.sessions.reached((inactivity, handle)));

    if let Some(event) = event {
        told(state, vec![event]);
    }
}

fn stop_waiting(state: &mut ServerState, handle: &ConnectionHandle) {
    if let Some(facade) = state.facade.as_mut()
        && let Some(Some(timer)) = facade.idle.remove(handle)
    {
        timer.cancel();
    }
}

// a connection that was never opened or is gone keeps nothing
fn forget_connection(state: &mut ServerState, handle: &ConnectionHandle) {
    let mut events = Vec::new();

    stop_waiting(state, handle);

    if let Some(facade) = state.facade.as_mut() {
        facade.connections.remove(handle);
        facade.listens.remove(handle);
        facade.sessions.delete(handle, &mut events);
    }

    told(state, events);
}

// a close asked once; one the transport no longer holds tells no close, so what it left goes now
fn close(state: &mut ServerState, handle: &ConnectionHandle) {
    // a transport gone holds no connection: its owner is ending
    let Some(transport) = state.transport() else {
        return;
    };
    let Some(facade) = state.facade.as_mut() else {
        return;
    };

    if !facade.closing.insert(Arc::clone(handle)) {
        return;
    }

    let closing = transport.close(handle);
    let owner = state.core.owner.clone();
    let handle = Arc::clone(handle);

    state.core.owner.cover(async move {
        let is_closed = closing.await;
        owner.offer(Box::new(move |state: &mut ServerState| {
            if !is_closed {
                forget_connection(state, &handle);
            }

            if let Some(facade) = state.facade.as_mut() {
                facade.closing.remove(&handle);
            }
        }));
    });
}

// a connection without a session is closed once silent for the server's own timeout, counted
// afresh; ! none runs while a listen is held, whose end arms it
fn wait(state: &mut ServerState, handle: &ConnectionHandle) {
    stop_waiting(state, handle);

    let Some(facade) = state.facade.as_ref() else {
        return;
    };
    let timeout = facade.connection_inactivity_timeout;
    let timer = (timeout != NEVER && !facade.listens.contains_key(handle)).then(|| {
        let closed = Arc::clone(handle);

        state.core.after(timeout, move |state: &mut ServerState| {
            close(state, &closed);
        })
    });

    if let Some(facade) = state.facade.as_mut() {
        facade.idle.insert(Arc::clone(handle), timer);
    }
}

// a session's connection timer, stopped while a listen is held; its session timer runs on
fn hold_session(state: &mut ServerState, handle: &ConnectionHandle) {
    let arming = arming_of(state);

    if let Some(facade) = state.facade.as_mut() {
        let reset = facade
            .sessions
            .reset_connection_inactivity_timeout((handle, NEVER), &arming);

        drop(reset);
    }
}

/// A connection drawn: before the router's own, so a resolver that stores a session finds it open.
pub(crate) fn on_connection(state: &mut ServerState, handle: &ConnectionHandle) {
    let Some(facade) = state.facade.as_mut() else {
        return;
    };

    facade.connections.insert(Arc::clone(handle), ());
    wait(state, handle);
}

/// A message: each is activity, whatever the router makes of it; a connection that speaks is open.
pub(crate) fn on_message(state: &mut ServerState, handle: &ConnectionHandle) {
    // * a router with no facade reads no clock for a message (spec/debugging.md 3.1)
    if state.facade.is_none() {
        return;
    }

    let now = wall_of(state);
    let arming = arming_of(state);
    let mut events = Vec::new();
    let Some(facade) = state.facade.as_mut() else {
        return;
    };

    facade.connections.insert(Arc::clone(handle), ());

    let touched = facade
        .sessions
        .touch((handle, now), (&arming, &mut events))
        .is_some();
    let is_listening = facade.listens.contains_key(handle);

    if !touched {
        wait(state, handle);
    } else if is_listening {
        hold_session(state, handle);
    }

    told(state, events);
}

// the end of the last listen held: the connection's silence counts anew from it
fn resume(state: &mut ServerState, handle: &ConnectionHandle) {
    let arming = arming_of(state);
    let session = state
        .facade
        .as_ref()
        .and_then(|facade| facade.sessions.get(handle));
    let Some(session) = session else {
        return wait(state, handle);
    };

    if let Some(facade) = state.facade.as_mut() {
        let reset = facade.sessions.reset_connection_inactivity_timeout(
            (
                handle,
                session.connection_inactivity_timeout.unwrap_or(NEVER),
            ),
            &arming,
        );

        drop(reset);
    }
}

/// A listen held, or its end: the first held stops the connection's timers, and the end of the last
/// arms them afresh; a listen of a connection the server does not hold counts nothing.
pub(crate) fn on_listen(state: &mut ServerState, (is_held, handle): (bool, &ConnectionHandle)) {
    let Some(facade) = state.facade.as_mut() else {
        return;
    };
    let before = facade.listens.get(handle).copied().unwrap_or(0);
    let after = if is_held {
        Some(before.saturating_add(1))
    } else {
        before.checked_sub(1)
    };
    let Some(after) = after else {
        return;
    };

    if !facade.connections.contains_key(handle) {
        return;
    }

    if after == 0 {
        facade.listens.remove(handle);

        return resume(state, handle);
    }

    facade.listens.insert(Arc::clone(handle), after);

    let is_idle = facade.idle.contains_key(handle);

    if before == 0 && is_idle {
        wait(state, handle);
    } else if before == 0 {
        hold_session(state, handle);
    }
}

/// A connection closed.
pub(crate) fn on_close(state: &mut ServerState, handle: &ConnectionHandle) {
    if state.facade.is_some() {
        forget_connection(state, handle);
    }
}

// the server's own gauges
fn facade_gauges(facade: &Facade) -> Gauges {
    let mut gauges = Gauges::default();

    gauges
        .connection_handles
        .extend(facade.connections.keys().cloned());
    gauges
        .connection_handles
        .extend(facade.idle.keys().cloned());
    gauges
        .connection_handles
        .extend(facade.listens.keys().cloned());

    for (name, count) in [
        ("closing", facade.closing.len()),
        ("connections", facade.connections.len()),
        ("idle", facade.idle.len()),
        ("listening", facade.listens.len()),
    ] {
        gauges
            .counts
            .insert(name, u64::try_from(count).unwrap_or(u64::MAX));
    }

    gauges
}

fn dispose_facade(state: &mut ServerState) {
    if let Some(facade) = state.facade.as_mut() {
        for (_, timer) in facade.idle.drain() {
            if let Some(timer) = timer {
                timer.cancel();
            }
        }

        facade.listens.clear();
        facade.connections.clear();
        // the closes still under way settle on their own: the server asks nothing more of them
        facade.closing.clear();
    }
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────

/// The ratio of a ceiling past which a count warns.
pub const WARNING_RATIO: f64 = 0.8;

/// A layer's gauges, set against the connections its transport holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct LayerGauges {
    /// What it found that should never be.
    pub anomalies: Vec<String>,
    /// What it holds at most, by name.
    pub ceilings: BTreeMap<&'static str, u64>,
    /// What it holds, by name.
    pub counts: BTreeMap<&'static str, u64>,
    /// The connections it keeps that the transport no longer holds.
    pub orphans: u64,
}

/// Each layer's gauges.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ServerGauges {
    /// The router's.
    pub router: LayerGauges,
    /// The server's own.
    pub server: LayerGauges,
    /// The sessions'.
    pub sessions: LayerGauges,
    /// The transport's.
    pub transport: LayerGauges,
}

/// A check's status, worst last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub enum HealthStatus {
    /// All is well.
    Pass,
    /// A count nears its ceiling.
    Warn,
    /// Something kept should not be.
    Fail,
}

impl HealthStatus {
    /// Its name, as a health check writes it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Warn => "warn",
            Self::Fail => "fail",
        }
    }
}

/// One check of a server's health.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HealthCheck {
    /// What it observed.
    pub observed_value: u64,
    /// What it says of it.
    pub output: Option<String>,
    /// Its status.
    pub status: HealthStatus,
}

/// A server's health: each check, and the worst status.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Health {
    /// Each check, by name.
    pub checks: BTreeMap<String, Vec<HealthCheck>>,
    /// The worst status.
    pub status: HealthStatus,
}

/// A layer's gauges, set against `held`, the connections its transport holds.
#[must_use]
pub fn layer_gauges_of(gauges: Gauges, held: &BTreeSet<ConnectionHandle>) -> LayerGauges {
    let orphans = gauges
        .connection_handles
        .iter()
        .filter(|handle| !held.contains(*handle))
        .count();

    LayerGauges {
        anomalies: gauges.anomalies,
        ceilings: gauges.ceilings,
        counts: gauges.counts,
        orphans: u64::try_from(orphans).unwrap_or(u64::MAX),
    }
}

/// The health its gauges give.
#[must_use]
pub fn health_of(gauges: &ServerGauges) -> Health {
    let mut checks = BTreeMap::new();
    let mut status = HealthStatus::Pass;
    let mut check = |name: String, found: HealthCheck| {
        status = status.max(found.status);
        checks.insert(name, vec![found]);
    };

    for (layer, gauges) in [
        ("router", &gauges.router),
        ("server", &gauges.server),
        ("sessions", &gauges.sessions),
        ("transport", &gauges.transport),
    ] {
        check(
            format!("{layer}:orphans"),
            if gauges.orphans == 0 {
                HealthCheck {
                    observed_value: 0,
                    output: None,
                    status: HealthStatus::Pass,
                }
            } else {
                HealthCheck {
                    observed_value: gauges.orphans,
                    output: Some(format!(
                        "{} connections kept that the transport no longer holds",
                        gauges.orphans
                    )),
                    status: HealthStatus::Fail,
                }
            },
        );
        check(
            format!("{layer}:anomalies"),
            if gauges.anomalies.is_empty() {
                HealthCheck {
                    observed_value: 0,
                    output: None,
                    status: HealthStatus::Pass,
                }
            } else {
                HealthCheck {
                    observed_value: u64::try_from(gauges.anomalies.len()).unwrap_or(u64::MAX),
                    output: Some(gauges.anomalies.join("; ")),
                    status: HealthStatus::Fail,
                }
            },
        );

        for (name, &count) in &gauges.counts {
            if let Some(&ceiling) = gauges.ceilings.get(name) {
                // * the ratio of 0.8 held in whole numbers: a count at 4 fifths of its ceiling or past
                let is_near =
                    u128::from(count).saturating_mul(5) >= u128::from(ceiling).saturating_mul(4);

                check(
                    format!("{layer}:{name}"),
                    HealthCheck {
                        observed_value: count,
                        output: Some(format!("{count} of {ceiling}")),
                        status: if is_near {
                            HealthStatus::Warn
                        } else {
                            HealthStatus::Pass
                        },
                    },
                );
            }
        }
    }

    Health { checks, status }
}

// ── The sessions' handle ─────────────────────────────────────────────────────────────────────

/// A server's sessions: a handle to its router's owner, which holds them.
#[derive(Clone)]
pub struct Sessions {
    router: RouterServer,
    listeners: Arc<Listened<SessionListener>>,
}

impl fmt::Debug for Sessions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Sessions").finish_non_exhaustive()
    }
}

fn on_owner<T: Send + 'static, J: FnOnce(&mut ServerState) -> T + Send + 'static>(
    router: &RouterServer,
    (job, otherwise): (J, T),
) -> BoxFuture<T> {
    let pending = router.owner().run(job);

    Box::pin(async move { pending.await.unwrap_or(otherwise) })
}

impl Sessions {
    /// A session of `connection_handle`, not stored: holding nothing, never timed out, its
    /// activity now.
    #[must_use]
    pub fn create(&self, connection_handle: ConnectionHandle) -> Session {
        Session::new(connection_handle, wall_milliseconds(&self.router.clock()))
    }

    /// Hears what happens to its sessions from now on; the id given takes it off again, with
    /// [`Sessions::off`].
    pub fn on(&self, listener: SessionListener) -> ListenerId {
        self.listeners.add(listener)
    }

    /// Hears no more with the listener `listener` names: one taken off already, or of another
    /// part, changes nothing.
    pub fn off(&self, listener: ListenerId) {
        self.listeners.off(listener);
    }

    /// A copy of the session of `connection_handle`.
    pub fn get(&self, connection_handle: ConnectionHandle) -> BoxFuture<Option<Session>> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .and_then(|facade| facade.sessions.get(&connection_handle))
                },
                None,
            ),
        )
    }

    /// A copy of every session.
    pub fn all(&self) -> BoxFuture<Vec<Session>> {
        on_owner(
            &self.router,
            (
                |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .map(|facade| facade.sessions.all())
                        .unwrap_or_default()
                },
                Vec::new(),
            ),
        )
    }

    /// The connections that hold a session.
    pub fn connection_handles(&self) -> BoxFuture<Vec<ConnectionHandle>> {
        on_owner(
            &self.router,
            (
                |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .map(|facade| facade.sessions.connection_handles())
                        .unwrap_or_default()
                },
                Vec::new(),
            ),
        )
    }

    /// Whether `connection_handle` holds a session.
    pub fn has(&self, connection_handle: ConnectionHandle) -> BoxFuture<bool> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .is_some_and(|facade| facade.sessions.has(&connection_handle))
                },
                false,
            ),
        )
    }

    /// The token of the session of `connection_handle`.
    pub fn session_token_of(
        &self,
        connection_handle: ConnectionHandle,
    ) -> BoxFuture<Option<SessionToken>> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .and_then(|facade| facade.sessions.token_of(&connection_handle))
                },
                None,
            ),
        )
    }

    /// Stores `session`, its token drawn when it has none: stored as it is called, its timeouts
    /// judged first, as both other sides judge them; its future gives the session stored.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] at once for a timeout spec 1.4 does not hold, before anything is
    /// stored. Its future fails [`CallError::Refused`] for a token another connection's session
    /// holds, which only the sessions held can tell, and [`CallError::Disconnected`] once its
    /// server is disposed.
    pub fn set(
        &self,
        session: Session,
    ) -> Result<BoxFuture<Result<Session, CallError>>, ProgrammerError> {
        // * what needs no session held is refused as it is made; a timeout left out takes the
        // default its manager held as it was built
        for timeout in [
            session.connection_inactivity_timeout,
            session.session_inactivity_timeout,
        ]
        .into_iter()
        .flatten()
        {
            hold("an inactivity timeout", timeout)?;
        }

        Ok(on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);
                    let mut events = Vec::new();
                    let stored = match state.facade.as_mut() {
                        Some(facade) => facade.sessions.set(session, (&arming, &mut events)),
                        None => Err(CallError::Disconnected(
                            "the sessions were disposed".to_owned(),
                        )),
                    };

                    told(state, events);

                    stored
                },
                Err(CallError::Disconnected(
                    "the sessions were disposed".to_owned(),
                )),
            ),
        ))
    }

    /// The session of `connection_handle`, stored first, its activity now, when it has none.
    pub fn get_or_else_set(
        &self,
        connection_handle: ConnectionHandle,
    ) -> BoxFuture<Result<Session, CallError>> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);
                    let mut events = Vec::new();
                    let session = match state.facade.as_mut() {
                        Some(facade) => facade
                            .sessions
                            .get_or_else_set(&connection_handle, (&arming, &mut events)),
                        None => Err(CallError::Disconnected(
                            "the sessions were disposed".to_owned(),
                        )),
                    };

                    told(state, events);

                    session
                },
                Err(CallError::Disconnected(
                    "the sessions were disposed".to_owned(),
                )),
            ),
        )
    }

    /// Deletes the session of `connection_handle`; whether there was one.
    pub fn delete(&self, connection_handle: ConnectionHandle) -> BoxFuture<bool> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let mut events = Vec::new();
                    let deleted = state.facade.as_mut().is_some_and(|facade| {
                        facade.sessions.delete(&connection_handle, &mut events)
                    });

                    told(state, events);

                    deleted
                },
                false,
            ),
        )
    }

    /// Stamps the activity of `connection_handle`'s session now, restarting its timers.
    pub fn touch(&self, connection_handle: ConnectionHandle) -> BoxFuture<Option<Session>> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let (now, arming) = (wall_of(state), arming_of(state));
                    let mut events = Vec::new();
                    let touched = state.facade.as_mut().and_then(|facade| {
                        facade
                            .sessions
                            .touch((&connection_handle, now), (&arming, &mut events))
                    });

                    told(state, events);

                    touched
                },
                None,
            ),
        )
    }

    /// Stores `data` in the session of `connection_handle`.
    pub fn update_data(
        &self,
        (connection_handle, data): (ConnectionHandle, Option<Value>),
    ) -> BoxFuture<Option<Session>> {
        on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let mut events = Vec::new();
                    let updated = state.facade.as_mut().and_then(|facade| {
                        facade
                            .sessions
                            .update_data((&connection_handle, data), &mut events)
                    });

                    told(state, events);

                    updated
                },
                None,
            ),
        )
    }

    /// Sets the connection's timeout of `connection_handle`'s session, its manager's default when
    /// none.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub fn update_connection_inactivity_timeout(
        &self,
        (connection_handle, timeout): (ConnectionHandle, Option<Duration>),
    ) -> Result<BoxFuture<Option<Session>>, ProgrammerError> {
        if let Some(timeout) = timeout {
            hold("an inactivity timeout", timeout)?;
        }

        Ok(on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);
                    let mut events = Vec::new();
                    let updated = state.facade.as_mut().and_then(|facade| {
                        facade
                            .sessions
                            .update_connection_inactivity_timeout(
                                (&connection_handle, timeout),
                                (&arming, &mut events),
                            )
                            .ok()
                            .flatten()
                    });

                    told(state, events);

                    updated
                },
                None,
            ),
        ))
    }

    /// Sets the session's own timeout of `connection_handle`'s session, its manager's default when
    /// none.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub fn update_session_inactivity_timeout(
        &self,
        (connection_handle, timeout): (ConnectionHandle, Option<Duration>),
    ) -> Result<BoxFuture<Option<Session>>, ProgrammerError> {
        if let Some(timeout) = timeout {
            hold("an inactivity timeout", timeout)?;
        }

        Ok(on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);
                    let mut events = Vec::new();
                    let updated = state.facade.as_mut().and_then(|facade| {
                        facade
                            .sessions
                            .update_session_inactivity_timeout(
                                (&connection_handle, timeout),
                                (&arming, &mut events),
                            )
                            .ok()
                            .flatten()
                    });

                    told(state, events);

                    updated
                },
                None,
            ),
        ))
    }

    /// Restarts the connection's timer of `connection_handle`'s session at `timeout`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub fn reset_connection_inactivity_timeout(
        &self,
        (connection_handle, timeout): (ConnectionHandle, Duration),
    ) -> Result<BoxFuture<()>, ProgrammerError> {
        let timeout = hold("a connection inactivity timeout", timeout)?;

        Ok(on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);

                    if let Some(facade) = state.facade.as_mut() {
                        let reset = facade.sessions.reset_connection_inactivity_timeout(
                            (&connection_handle, timeout),
                            &arming,
                        );

                        drop(reset);
                    }
                },
                (),
            ),
        ))
    }

    /// Restarts the session's own timer of `connection_handle` at `timeout`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub fn reset_session_inactivity_timeout(
        &self,
        (connection_handle, timeout): (ConnectionHandle, Duration),
    ) -> Result<BoxFuture<()>, ProgrammerError> {
        let timeout = hold("a session inactivity timeout", timeout)?;

        Ok(on_owner(
            &self.router,
            (
                move |state: &mut ServerState| {
                    let arming = arming_of(state);

                    if let Some(facade) = state.facade.as_mut() {
                        let reset = facade.sessions.reset_session_inactivity_timeout(
                            (&connection_handle, timeout),
                            &arming,
                        );

                        drop(reset);
                    }
                },
                (),
            ),
        ))
    }

    /// Its sessions and its timers, counted.
    pub fn gauges(&self) -> BoxFuture<Gauges> {
        on_owner(
            &self.router,
            (
                |state: &mut ServerState| {
                    state
                        .facade
                        .as_ref()
                        .map(|facade| facade.sessions.gauges())
                        .unwrap_or_default()
                },
                Gauges::default(),
            ),
        )
    }
}

// ── The server ───────────────────────────────────────────────────────────────────────────────

struct Shared {
    router: RouterServer,
    services: ServiceManager,
    sessions: Sessions,
    transport: Arc<dyn ServerTransport>,
}

/// A server: its transport, its router, its sessions and its services.
#[derive(Clone)]
pub struct Server {
    shared: Arc<Shared>,
}

impl fmt::Debug for Server {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Server").finish_non_exhaustive()
    }
}

impl Server {
    /// A server over `transport`, built before the transport starts.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] as its router, its sessions or its services refuse their options.
    pub fn new(
        transport: Arc<dyn ServerTransport>,
        options: &ServerOptions,
    ) -> Result<Self, ProgrammerError> {
        let connection_inactivity_timeout = hold(
            "a connection's inactivity timeout",
            options.connection_inactivity_timeout.unwrap_or(NEVER),
        )?;
        // * one clock for every layer: the transport's, or the one given, which the sessions and
        // the router are both handed
        let runtime = crate::platform::runtime_of(options.runtime.as_ref(), "a router")?;
        let clock = clock_of(
            (transport.clock().as_ref(), options.clock.as_ref()),
            ("a server's router", "its transport"),
        )?
        .unwrap_or_else(|| {
            let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));

            platform
        });
        let sessions_options = options.sessions.clone().unwrap_or_default();
        let sessions = SessionManager::new(&SessionManagerOptions {
            clock: clock_of(
                (Some(&clock), sessions_options.clock.as_ref()),
                ("a server's sessions", "its server"),
            )?,
            ..sessions_options
        })?;
        let listeners: Arc<Listened<SessionListener>> = Arc::default();
        let facade = Facade {
            sessions,
            connections: Ordered::new(),
            closing: BTreeSet::new(),
            idle: Ordered::new(),
            listens: Ordered::new(),
            connection_inactivity_timeout,
            listeners: Arc::clone(&listeners),
        };
        // a server's relay admits by default a credential it forwards, for its destination to
        // verify, and no session of leg A's
        let mut relay = options.relay.clone().unwrap_or_default();

        if relay.before_route.is_none() {
            relay.before_route = Some(require_credential());
        }

        let router = RouterServer::build(
            Arc::clone(&transport),
            (
                &RouterServerOptions {
                    clock: Some(clock),
                    runtime: Some(runtime),
                    limits: options.limits.clone(),
                    metrics_registry: options.metrics_registry.clone(),
                    pacing: options.pacing.clone(),
                    credentials: options.credentials.clone(),
                    relay: Some(relay),
                },
                Some(facade),
            ),
        )?;
        let closing = router.clone();
        let services = ServiceManager::new(
            ServiceRouter::Server(router.clone()),
            &ServiceManagerOptions {
                close_connection: Some(Arc::new(move |handle: &ConnectionHandle| {
                    let handle = Arc::clone(handle);
                    closing
                        .owner()
                        .offer(Box::new(move |state: &mut ServerState| {
                            close(state, &handle);
                        }));
                })),
                defaults: Some(RequestDefaults {
                    close_on_timeout: options.close_on_command_timeout,
                    timeout: None,
                }),
                clock: None,
            },
        )?;

        Ok(Self {
            shared: Arc::new(Shared {
                sessions: Sessions {
                    router: router.clone(),
                    listeners,
                },
                router,
                services,
                transport,
            }),
        })
    }

    /// Its router.
    #[must_use]
    pub fn router(&self) -> &RouterServer {
        &self.shared.router
    }

    /// Its services.
    #[must_use]
    pub fn services(&self) -> &ServiceManager {
        &self.shared.services
    }

    /// Its sessions.
    #[must_use]
    pub fn sessions(&self) -> &Sessions {
        &self.shared.sessions
    }

    /// Its transport.
    #[must_use]
    pub fn transport(&self) -> Arc<dyn ServerTransport> {
        Arc::clone(&self.shared.transport)
    }

    /// Each layer's gauges, set against the connections the transport holds.
    pub fn gauges(&self) -> BoxFuture<ServerGauges> {
        let transport = Arc::clone(&self.shared.transport);
        let gauged = self
            .shared
            .router
            .owner()
            .run(move |state: &mut ServerState| {
                let router = crate::router::server::gauges(state);
                let (own, sessions) = state.facade.as_ref().map_or_else(
                    || (Gauges::default(), Gauges::default()),
                    |facade| (facade_gauges(facade), facade.sessions.gauges()),
                );
                let held = transport.gauges().unwrap_or_else(|| {
                    let mut held = Gauges::default();

                    if let Some(facade) = state.facade.as_ref() {
                        held.connection_handles
                            .extend(facade.connections.keys().cloned());
                    }

                    held
                });
                let handles = held.connection_handles.clone();

                ServerGauges {
                    router: layer_gauges_of(router, &handles),
                    server: layer_gauges_of(own, &handles),
                    sessions: layer_gauges_of(sessions, &handles),
                    transport: layer_gauges_of(held, &handles),
                }
            });

        Box::pin(async move { gauged.await.unwrap_or_default() })
    }

    /// Its health, from its gauges.
    pub fn health(&self) -> BoxFuture<Health> {
        let gauges = self.gauges();

        Box::pin(async move { health_of(&gauges.await) })
    }

    /// Disposes of it: its router, its sessions, then its transport, stopped. Its router disposed
    /// at once, what it holds is let go in a later turn, behind what came before it, a listener's
    /// dispose too (spec 9.0).
    ///
    /// # Errors
    ///
    /// What its transport refuses its stop with, its router and its sessions disposed all the same:
    /// a transport still starting, say.
    pub fn dispose(&self) -> BoxFuture<Result<(), RouterError>> {
        self.shared.router.mark_disposed();

        let disposed = self
            .shared
            .router
            .owner()
            .run_behind(|state: &mut ServerState| {
                dispose_facade(state);
                crate::router::server::dispose(state);

                if let Some(facade) = state.facade.as_mut() {
                    facade.sessions.dispose();
                }
            });
        let transport = Arc::clone(&self.shared.transport);

        Box::pin(async move {
            disposed.await.ok();
            transport.stop().await
        })
    }

    /// Reports what went wrong that no call waits on, through its router.
    pub fn report(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        self.shared.router.report(error, connection_handle);
    }
}

pub(crate) fn sessions_of(state: &ServerState) -> Option<&SessionManager> {
    state.facade.as_ref().map(|facade| &facade.sessions)
}
