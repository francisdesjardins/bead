//! The in-memory transport (spec 15.13): a server and its clients in one process, each envelope
//! handed on whole, once and in order, in a later turn than its send, each close told to the other
//! end in a later turn; a connection secure and two-way, which carries a credential toward its
//! server and none toward its client. An end its router paused holds what comes, in order and
//! without bound, its peer being its application's own code, and hands it on once resumed, in a
//! later turn of the pipe (spec 15.12, decision 0046).

use core::fmt;
use core::time::Duration;
use std::collections::{BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock, SystemClock, Timer};
use crate::duration::hold;
use crate::errors::{ConnectError, ProgrammerError, ReadyStateError, TransportError};
use crate::failure::ProcedureAddress;
use crate::identity::procedures_taken_of;
use crate::life::Life;
use crate::ordered::Ordered;
use crate::owner::{Owner, WeakOwner};
use crate::platform::runtime_of;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    CONNECT_TIMEOUT, ClientListener, Connect, Listeners, RECONNECTION_CANCELLED, ReadyState,
    RouterClientTransport, Sent, ServerListener, ServerTransport, TransportClientDisconnectOptions,
    TransportClientReconnectOptions, TransportServerAddress, TransportServerClient, attempting,
    first_of, hold_reconnection, is_field_value, refused_unless_open, tell_server,
};

#[cfg(test)]
mod tests;

/// The type an in-memory connection's handle names.
pub const TRANSPORT_MEMORY: &str = "MEMORY";

/// The address a connect gives when it names none.
pub const MEMORY_ADDRESS: &str = "local";

// ── The loop ─────────────────────────────────────────────────────────────────────────────────

// the later turns a server and its clients share: each job in the order it came, off the caller
struct Pipe;

// * a job of the pipe's that panics, a listener's being guarded, ends it: its connections' later
// turns refused from then on
impl crate::owner::Owned for Pipe {}

// ! at the pipe's queue's tail, one posted from within a turn of the pipe's too, as both other
// sides queue a later turn: what a listener sends or closes within it comes after what was sent
// before it (spec 15.13; decision 0045)
fn later_on<J: FnOnce() + Send + 'static>(pipe: &WeakOwner<Pipe>, job: J) {
    pipe.offer(Box::new(move |_: &mut Pipe| job()));
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── The server ───────────────────────────────────────────────────────────────────────────────

/// How an in-memory transport server is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryTransportServerOptions {
    /// The clock it runs on, which the layers above it run on too.
    pub clock: Option<SharedClock>,
    /// The runtime its later turns run on: the current one when none.
    pub runtime: Option<Handle>,
    /// The procedures each of its connections takes, by their addresses (spec 9.11): a request to
    /// any other is answered as one to no resolver. Every procedure when none; none when empty.
    pub procedures: Option<Vec<ProcedureAddress>>,
}

// a connection held, as the server keeps it: what its client sent while its router paused it held
// in order, dropped with it
struct Connection {
    serial: u64,
    address: String,
    port: Option<u16>,
    peer: Arc<ClientPeer>,
    last_activity: Option<SystemTime>,
    is_paused: bool,
    held: VecDeque<TransportMessage>,
}

struct ServerState {
    connections: Ordered<ConnectionHandle, Connection>,
    ordinal: u64,
    serial: u64,
}

struct ServerInner {
    given: Option<SharedClock>,
    // the procedures its connections take, every one when none
    procedures: Option<BTreeSet<ProcedureAddress>>,
    clock: SharedClock,
    pipe: Owner<Pipe>,
    life: Life,
    state: Mutex<ServerState>,
    listeners: Listeners<dyn ServerListener>,
}

/// An in-memory transport server: what its clients connect to, in the same process.
#[derive(Clone)]
pub struct MemoryTransportServer {
    inner: Arc<ServerInner>,
}

impl fmt::Debug for MemoryTransportServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryTransportServer")
            .finish_non_exhaustive()
    }
}

impl ServerInner {
    fn later<J: FnOnce() + Send + 'static>(&self, job: J) {
        later_on(&self.pipe.downgrade(), job);
    }

    // each listener within a guard (spec 15.1): what one panics is told as an error, with the
    // connection it was told of
    fn tell<C: Fn(&dyn ServerListener)>(
        &self,
        (call, connection_handle): (C, Option<&ConnectionHandle>),
    ) {
        tell_server(&self.listeners, (call, connection_handle));
    }

    fn is_held(&self, (handle, serial): (&ConnectionHandle, u64)) -> bool {
        locked(&self.state)
            .connections
            .get(handle)
            .is_some_and(|connection| connection.serial == serial)
    }

    // a connection held ends: closed at this end, clean, its client told in a later turn; or at its
    // client's, told here as its client closed it
    fn end(
        self: &Arc<Self>,
        (handle, serial): (&ConnectionHandle, u64),
        (is_closed_here, was_clean): (bool, bool),
    ) {
        let removed = {
            let mut state = locked(&self.state);

            match state.connections.get(handle) {
                Some(connection) if connection.serial == serial => state.connections.remove(handle),
                _ => None,
            }
        };
        let Some(connection) = removed else {
            return;
        };

        if is_closed_here {
            let peer = Arc::clone(&connection.peer);

            self.later(move || peer.close(true));
        }

        self.tell((
            |listener: &dyn ServerListener| listener.on_close(was_clean, handle),
            Some(handle),
        ));
    }

    // a connect, in a later turn than its call, so its client's router is never entered from it
    fn accept(
        self: &Arc<Self>,
        peer: Arc<ClientPeer>,
        given_up: CancellationToken,
    ) -> oneshot::Receiver<Result<ServerEnd, TransportError>> {
        let (reply, accepted) = oneshot::channel();
        let server = Arc::clone(self);

        self.later(move || {
            // a connect its client gave up on draws no connection
            if given_up.is_cancelled() {
                drop(reply.send(Err(TransportError::cancelled("the connect was cancelled"))));

                return;
            }

            let ready = server.life.ready_state();
            let drawn = if ready == ReadyState::Open {
                let mut state = locked(&server.state);

                state.ordinal = state.ordinal.saturating_add(1);
                state.serial = state.serial.saturating_add(1);

                let handle: ConnectionHandle = Arc::from(format!(
                    "type={TRANSPORT_MEMORY};ip={};ordinal={}",
                    peer.address, state.ordinal
                ));
                let serial = state.serial;

                state.connections.insert(
                    Arc::clone(&handle),
                    Connection {
                        serial,
                        address: peer.address.clone(),
                        port: peer.port,
                        peer: Arc::clone(&peer),
                        last_activity: None,
                        is_paused: false,
                        held: VecDeque::new(),
                    },
                );
                drop(state);

                Ok((handle, serial))
            } else {
                Err(ready)
            };

            match drawn {
                Err(ready) => {
                    drop(
                        reply.send(Err(TransportError::Connect(ConnectError::new(format!(
                            "the in-memory transport server is {}, not open",
                            ready.said()
                        ))))),
                    );
                }
                Ok((handle, serial)) => {
                    server.tell((
                        |listener: &dyn ServerListener| listener.on_connection(&handle),
                        Some(&handle),
                    ));
                    drop(reply.send(Ok(ServerEnd {
                        server: Arc::downgrade(&server),
                        handle,
                        serial,
                    })));
                }
            }
        });

        accepted
    }

    // in a turn of the pipe: what a connection held handed on, in order, each after asking whether
    // its router paused it again, which telling one may do
    fn release(&self, (handle, serial): (&ConnectionHandle, u64)) {
        loop {
            let next = {
                let mut state = locked(&self.state);

                match state.connections.get_mut(handle) {
                    Some(connection) if connection.serial == serial && !connection.is_paused => {
                        connection.held.pop_front()
                    }
                    _ => None,
                }
            };
            let Some(told) = next else {
                return;
            };

            self.tell((
                |listener: &dyn ServerListener| listener.on_message(told.clone(), handle),
                Some(handle),
            ));
        }
    }

    // its stop's body, its life closing: every connection ended in one later turn of the pipe, in
    // the order they came, each told, clean, and its client told in a turn of its own
    fn stopping(self: &Arc<Self>) -> BoxFuture<Result<(), RouterError>> {
        let (reply, stopped) = oneshot::channel::<()>();
        let inner = Arc::clone(self);

        self.later(move || {
            let held: Vec<(ConnectionHandle, u64)> = locked(&inner.state)
                .connections
                .iter()
                .map(|(handle, connection)| (Arc::clone(handle), connection.serial))
                .collect();

            for (handle, serial) in held {
                inner.end((&handle, serial), (true, true));
            }

            locked(&inner.state).connections.clear();
            reply.send(()).ok();
        });

        Box::pin(async move {
            drop(stopped.await);

            Ok(())
        })
    }
}

impl MemoryTransportServer {
    /// An in-memory transport server, not started.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time driver,
    /// or for procedures that name service 0 or an id 0 (spec 9.12).
    pub fn new(options: &MemoryTransportServerOptions) -> Result<Self, ProgrammerError> {
        let procedures = options
            .procedures
            .as_deref()
            .map(|procedures| procedures_taken_of(procedures, "an in-memory transport server"))
            .transpose()?;
        let runtime = runtime_of(options.runtime.as_ref(), "an in-memory transport")?;
        let clock: SharedClock = match &options.clock {
            Some(clock) => Arc::clone(clock),
            None => Arc::new(SystemClock::on(runtime.clone())),
        };
        let pipe = Owner::spawn((&runtime, &clock), |_: WeakOwner<Pipe>| Pipe);
        let covered = pipe.downgrade();

        Ok(Self {
            inner: Arc::new(ServerInner {
                given: options.clock.clone(),
                procedures,
                clock,
                pipe,
                life: Life::new(Box::new(move |future| covered.cover(future))),
                state: Mutex::new(ServerState {
                    connections: Ordered::new(),
                    ordinal: 0,
                    serial: 0,
                }),
                listeners: Listeners::default(),
            }),
        })
    }

    /// Where it stands.
    #[must_use]
    pub fn ready_state(&self) -> ReadyState {
        self.inner.life.ready_state()
    }

    /// Takes connects from now on, and gives where: [`MEMORY_ADDRESS`], port 0, since it serves no
    /// port.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] once it is disposed, its state kept (decision 0003); then unless
    /// Uninitialized or Closed, a second start even while the first is under way.
    pub fn start(&self) -> BoxFuture<Result<TransportServerAddress, RouterError>> {
        self.inner
            .life
            .start(|| Box::pin(async { Ok(TransportServerAddress::new(MEMORY_ADDRESS, 0)) }))
    }

    /// Stops it, as its stop does, then ends it for good: a start after it is its application's
    /// misuse (decision 0003); a later dispose settles with the first.
    ///
    /// # Errors
    ///
    /// What its stop is refused with: a dispose while it starts, say.
    pub fn dispose(&self) -> BoxFuture<Result<(), RouterError>> {
        let inner = Arc::clone(&self.inner);

        self.inner.life.dispose(move || inner.stopping())
    }

    /// Whether its router holds `connection_handle` paused, as a test reads it.
    #[cfg(test)]
    pub(crate) fn is_paused(&self, connection_handle: &ConnectionHandle) -> bool {
        locked(&self.inner.state)
            .connections
            .get(connection_handle)
            .is_some_and(|connection| connection.is_paused)
    }

    /// The connections it holds, and the address and port each client gave, with its last
    /// activity.
    #[must_use]
    pub fn clients(&self) -> Vec<TransportServerClient> {
        locked(&self.inner.state)
            .connections
            .iter()
            .map(|(handle, connection)| TransportServerClient {
                connection_handle: Arc::clone(handle),
                address: connection.address.clone(),
                port: connection.port,
                last_activity: connection.last_activity,
                transport_type: TRANSPORT_MEMORY,
            })
            .collect()
    }
}

impl ServerTransport for MemoryTransportServer {
    // a credential given here is not carried: the router fails a command that presents one its
    // transport cannot carry before it goes (decision 0010)
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let peer = locked(&self.inner.state)
            .connections
            .get(connection_handle)
            .map(|connection| Arc::clone(&connection.peer));

        if let Some(peer) = peer {
            let data = message.data;

            self.inner.later(move || {
                peer.receive(TransportMessage {
                    data,
                    ..TransportMessage::default()
                });
            });
        }

        Ok(Sent::Done)
    }

    // * its close told in a later turn, after what it sent before, so no router is entered again
    // from its own call; settled once told
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        let serial = locked(&self.inner.state)
            .connections
            .get(connection_handle)
            .map(|connection| connection.serial);
        let Some(serial) = serial else {
            return Box::pin(async { false });
        };
        let (reply, closed) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        let handle = Arc::clone(connection_handle);

        self.inner.later(move || {
            inner.end((&handle, serial), (true, true));
            reply.send(true).ok();
        });

        Box::pin(async move { closed.await.unwrap_or(true) })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.inner.listeners.remove(listener);
    }

    // ! its state's lock alone, which it never holds as it tells a listener: what comes on the
    // connection from now on is held, in order and without bound, its client being its
    // application's own code (spec 15.13)
    fn pause(&self, connection_handle: &ConnectionHandle) {
        if let Some(connection) = locked(&self.inner.state)
            .connections
            .get_mut(connection_handle)
        {
            connection.is_paused = true;
        }
    }

    // ! its state's lock alone, as `pause`: what the connection holds is handed on in a later turn
    // of the pipe, behind what is queued there, never within this call
    fn resume(&self, connection_handle: &ConnectionHandle) {
        let releasing = {
            let mut state = locked(&self.inner.state);

            state
                .connections
                .get_mut(connection_handle)
                .and_then(|connection| {
                    connection.is_paused = false;

                    (!connection.held.is_empty()).then_some(connection.serial)
                })
        };

        if let Some(serial) = releasing {
            let inner = Arc::clone(&self.inner);
            let handle = Arc::clone(connection_handle);

            self.inner.later(move || inner.release((&handle, serial)));
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    fn names_procedures(&self) -> bool {
        self.inner.procedures.is_some()
    }

    // every connection of its takes the one list it was given
    fn takes_procedure(
        &self,
        _connection_handle: &ConnectionHandle,
        address: ProcedureAddress,
    ) -> bool {
        self.inner
            .procedures
            .as_ref()
            .is_none_or(|procedures| procedures.contains(&address))
    }

    fn transport_type(&self) -> Option<&str> {
        Some(TRANSPORT_MEMORY)
    }

    // * its stop, its life's: every connection ended in one later turn, in the order they came, none
    // drawn after it
    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        let inner = Arc::clone(&self.inner);

        self.inner.life.stop(move || inner.stopping())
    }

    fn gauges(&self) -> Option<Gauges> {
        let handles: Vec<ConnectionHandle> = locked(&self.inner.state)
            .connections
            .keys()
            .cloned()
            .collect();
        let mut gauges = Gauges::default();

        gauges.counts.insert(
            "connections",
            u64::try_from(handles.len()).unwrap_or(u64::MAX),
        );
        gauges.connection_handles.extend(handles);

        Some(gauges)
    }
}

// the server's end of a connection, as its client holds it
#[derive(Clone)]
struct ServerEnd {
    server: Weak<ServerInner>,
    handle: ConnectionHandle,
    serial: u64,
}

impl ServerEnd {
    // its client closed it
    fn close(&self, was_clean: bool) {
        if let Some(server) = self.server.upgrade()
            && server.is_held((&self.handle, self.serial))
        {
            server.end((&self.handle, self.serial), (false, was_clean));
        }
    }

    // what its client sent, told with the address and the port its client gave; held behind what
    // the connection holds, while its router paused it or anything is held (spec 15.12)
    fn receive(&self, message: TransportMessage) {
        let Some(server) = self.server.upgrade() else {
            return;
        };
        let now = server.clock.wall();
        let told = {
            let mut state = locked(&server.state);

            match state.connections.get_mut(&self.handle) {
                Some(connection) if connection.serial == self.serial => {
                    connection.last_activity = Some(now);

                    let told = TransportMessage {
                        address: Some(connection.address.clone()),
                        port: connection.port,
                        ..message
                    };

                    if connection.is_paused || !connection.held.is_empty() {
                        connection.held.push_back(told);

                        None
                    } else {
                        Some(told)
                    }
                }
                _ => None,
            }
        };
        let Some(told) = told else {
            return;
        };
        let handle = &self.handle;

        server.tell((
            |listener: &dyn ServerListener| listener.on_message(told.clone(), handle),
            Some(handle),
        ));
    }

    fn pipe(&self) -> Option<WeakOwner<Pipe>> {
        self.server.upgrade().map(|server| server.pipe.downgrade())
    }

    // closed by its client in a later turn of its server's pipe; nothing once that server is gone,
    // whose ends went with it
    fn close_later(self, was_clean: bool) {
        if let Some(pipe) = self.pipe() {
            later_on(&pipe, move || self.close(was_clean));
        }
    }
}

// ── The client ───────────────────────────────────────────────────────────────────────────────

/// How an in-memory transport client is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryTransportClientOptions {
    /// The clock it runs on: its connect's timeout and its reconnection's delays.
    pub clock: Option<SharedClock>,
}

/// How an in-memory client connects: to its server, which a reconnection connects to again.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MemoryTransportClientConnectOptions {
    /// The server it connects to.
    pub server: MemoryTransportServer,
    /// The address it gives its server: [`MEMORY_ADDRESS`] when none.
    pub address: Option<String>,
    /// The port it gives its server.
    pub port: Option<u16>,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// How long it waits for its server: [`CONNECT_TIMEOUT`] when none.
    pub timeout: Option<Duration>,
}

impl MemoryTransportClientConnectOptions {
    /// A connect to `server`, every other option its default.
    #[must_use]
    pub const fn new(server: MemoryTransportServer) -> Self {
        Self {
            server,
            address: None,
            port: None,
            signal: None,
            timeout: None,
        }
    }
}

// a connect under way
struct Attempt {
    serial: u64,
    state: Mutex<AttemptState>,
    given_up: CancellationToken,
}

#[derive(Default)]
struct AttemptState {
    accepted: Option<ServerEnd>,
    is_given_up: bool,
    is_closed_early: bool,
    is_opened: bool,
    // what the server sent before this end opened, heard once it has, in its order
    early: Vec<TransportMessage>,
    reply: Option<oneshot::Sender<Result<(), TransportError>>>,
    timer: Option<Arc<dyn Timer>>,
}

struct ClientState {
    ready: ReadyState,
    current: Option<(ServerEnd, u64)>,
    last_connect: Option<MemoryTransportClientConnectOptions>,
    is_attempting: bool,
    attempt: Option<Arc<Attempt>>,
    serial: u64,
    // its router's pause, whole, which outlasts a connection; what the current connection brought
    // meanwhile, in order, dropped with it
    is_paused: bool,
    held: VecDeque<TransportMessage>,
}

struct ClientInner {
    given: Option<SharedClock>,
    clock: SharedClock,
    runtime: Handle,
    state: Mutex<ClientState>,
    listeners: Listeners<dyn ClientListener>,
}

// the client's end of a connection, as its server holds it
struct ClientPeer {
    client: Weak<ClientInner>,
    attempt: Arc<Attempt>,
    address: String,
    port: Option<u16>,
}

impl ClientPeer {
    fn receive(&self, message: TransportMessage) {
        let Some(client) = self.client.upgrade() else {
            return;
        };
        let Some(message) = client.hand((self.attempt.serial, message)) else {
            return;
        };

        // what comes once this end closed is dropped, as a socket's would be
        let mut attempt = locked(&self.attempt.state);

        if !attempt.is_given_up && !attempt.is_closed_early && !attempt.is_opened {
            attempt.early.push(message);
        }
    }

    // the server closed it: closed, as a socket the peer closed, not clean at this end
    fn close(&self, _was_clean: bool) {
        let Some(client) = self.client.upgrade() else {
            return;
        };
        let told = {
            let mut state = locked(&client.state);
            let is_current = state
                .current
                .as_ref()
                .is_some_and(|(_, serial)| *serial == self.attempt.serial);

            let told = is_current.then(|| {
                state.current = None;
                state.held.clear();

                let is_reconnecting = state.ready == ReadyState::Reconnecting;

                if !is_reconnecting {
                    state.ready = ReadyState::Closed;
                }

                !is_reconnecting
            });

            drop(state);

            told
        };

        match told {
            Some(true) => {
                client.tell(|listener: &dyn ClientListener| listener.on_close(false, false));
            }
            Some(false) => {}
            None => locked(&self.attempt.state).is_closed_early = true,
        }
    }
}

impl ClientInner {
    fn tell<C: Fn(&dyn ClientListener)>(&self, call: C) {
        let listeners = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn ClientListener + 'static)| call(listener),
            |error: RouterError| {
                for heard in &listeners {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    // (spec 15.1)
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error);
                    }))
                    .ok();
                }
            },
        ));
    }

    // a message of the connection `serial` names told, or held behind what is held while its
    // router paused it or anything is held (spec 15.12); given back when that connection is not
    // the current one
    fn hand(&self, (serial, message): (u64, TransportMessage)) -> Option<TransportMessage> {
        let told = {
            let mut state = locked(&self.state);
            let is_current = state
                .current
                .as_ref()
                .is_some_and(|(_, current)| *current == serial);

            if !is_current {
                return Some(message);
            }

            if state.is_paused || !state.held.is_empty() {
                state.held.push_back(message);

                return None;
            }

            drop(state);

            message
        };

        self.tell(|listener: &dyn ClientListener| listener.on_message(told.clone()));

        None
    }

    // in a turn of the pipe: what it held handed on, in order, each after asking whether its
    // router paused it again, which telling one may do
    fn release(&self) {
        loop {
            let next = {
                let mut state = locked(&self.state);

                if state.is_paused {
                    None
                } else {
                    state.held.pop_front()
                }
            };
            let Some(told) = next else {
                return;
            };

            self.tell(|listener: &dyn ClientListener| listener.on_message(told.clone()));
        }
    }

    // the connect settles: opened, unless given up on or closed by its server meanwhile
    fn settle(
        self: &Arc<Self>,
        (attempt, outcome): (&Arc<Attempt>, Result<ServerEnd, TransportError>),
    ) {
        let (reply, outcome, early) = {
            let mut held = locked(&attempt.state);
            let Some(reply) = held.reply.take() else {
                // settled already: a connection drawn after is closed at once, unclean
                if let Ok(end) = outcome {
                    drop(held);
                    end.close_later(false);
                }

                return;
            };

            if let Some(timer) = held.timer.take() {
                timer.cancel();
            }

            let outcome = match outcome {
                Ok(_) if held.is_given_up => Err(TransportError::Connect(ConnectError::new(
                    "the transport client was disposed as it connected",
                ))),
                Ok(_) if held.is_closed_early => Err(TransportError::Connect(ConnectError::new(
                    "the in-memory transport server closed the connection as it opened",
                ))),
                // its signal cancelled in the turn its server drew it, before it settled: the
                // cancel holds, and what was drawn is closed at once, unclean
                Ok(_) if attempt.given_up.is_cancelled() => {
                    Err(TransportError::cancelled("the connect was cancelled"))
                }
                outcome => outcome,
            };

            if outcome.is_ok() {
                held.is_opened = true;
            } else {
                held.is_given_up = true;
            }

            (reply, outcome, core::mem::take(&mut held.early))
        };

        attempt.given_up.cancel();

        match outcome {
            Err(reason) => {
                // ! a connection its server drew as the connect was given up on: closed at once,
                // unclean
                let accepted = locked(&attempt.state).accepted.take();

                if let Some(accepted) = accepted {
                    accepted.close_later(false);
                }

                {
                    let mut state = locked(&self.state);

                    if state.ready != ReadyState::Reconnecting {
                        state.ready = ReadyState::Closed;
                    }

                    if state
                        .attempt
                        .as_ref()
                        .is_some_and(|held| Arc::ptr_eq(held, attempt))
                    {
                        state.attempt = None;
                    }
                }

                drop(reply.send(Err(reason)));
            }
            Ok(end) => {
                {
                    let mut state = locked(&self.state);

                    state.current = Some((end, attempt.serial));
                    state.held.clear();
                    state.ready = ReadyState::Open;

                    if state
                        .attempt
                        .as_ref()
                        .is_some_and(|held| Arc::ptr_eq(held, attempt))
                    {
                        state.attempt = None;
                    }
                }

                // * held as any other, while its router paused it: none overtakes another
                for message in early {
                    drop(self.hand((attempt.serial, message)));
                }

                drop(reply.send(Ok(())));
            }
        }
    }

    // gives up on the connect in flight, so a dispose under it cannot leave it pending
    fn give_up(self: &Arc<Self>, reason: TransportError) {
        let attempt = locked(&self.state).attempt.take();

        if let Some(attempt) = attempt {
            locked(&attempt.state).is_given_up = true;
            attempt.given_up.cancel();
            self.settle((&attempt, Err(reason)));
        }
    }

    // drops the open connection, and what it held
    fn drop_current(&self) -> Option<ServerEnd> {
        let mut state = locked(&self.state);

        state.held.clear();
        state.current.take().map(|(end, _)| end)
    }
}

/// An in-memory transport client: one connection at a time to its server.
#[derive(Clone)]
pub struct MemoryTransportClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for MemoryTransportClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryTransportClient")
            .finish_non_exhaustive()
    }
}

// an address a handle can name: visible ASCII but `;`, which ends a handle's part
fn is_address(address: &str) -> bool {
    !address.is_empty()
        && address
            .bytes()
            .all(|byte| (b'!'..=b'~').contains(&byte) && byte != b';')
}

impl MemoryTransportClient {
    /// A client, not connected: its connect names its server.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, or on one without its time driver.
    pub fn new(options: &MemoryTransportClientOptions) -> Result<Self, ProgrammerError> {
        let runtime = runtime_of(None, "an in-memory transport")?;
        let clock: SharedClock = match &options.clock {
            Some(clock) => Arc::clone(clock),
            None => Arc::new(SystemClock::on(runtime.clone())),
        };

        Ok(Self {
            inner: Arc::new(ClientInner {
                given: options.clock.clone(),
                clock,
                runtime,
                state: Mutex::new(ClientState {
                    ready: ReadyState::Uninitialized,
                    current: None,
                    last_connect: None,
                    is_attempting: false,
                    attempt: None,
                    serial: 0,
                    is_paused: false,
                    held: VecDeque::new(),
                }),
                listeners: Listeners::default(),
            }),
        })
    }

    /// Connects to its server, started as it is called: open once its server drew the connection.
    pub fn connect(&self, options: &MemoryTransportClientConnectOptions) -> Connect {
        match self.start_connect(options) {
            Ok(outcome) => Connect::of(outcome),
            Err(error) => Connect::refused(error),
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "a connect checked, armed, watched and asked of its server, in the order the other sides take"
    )]
    fn start_connect(
        &self,
        options: &MemoryTransportClientConnectOptions,
    ) -> Result<oneshot::Receiver<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;
        // held here, before anything moves or is kept for a reconnection
        let timeout = match options.timeout {
            Some(timeout) => hold("a connect's timeout", timeout)?,
            None => CONNECT_TIMEOUT,
        };
        let address = options
            .address
            .clone()
            .unwrap_or_else(|| MEMORY_ADDRESS.to_owned());

        if !is_address(&address) {
            return Err(TransportError::Refused(ProgrammerError::new(
                "an in-memory connect's address is visible ASCII but ';', at least one character",
            )));
        }

        let (attempt, reply) = {
            let mut state = locked(&inner.state);

            if !state.is_attempting
                && !matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed)
            {
                return Err(TransportError::Refused(ProgrammerError::new(format!(
                    "the transport client is already {}",
                    state.ready.said()
                ))));
            }

            // without its signal: a reconnection brings its own
            state.last_connect = Some(MemoryTransportClientConnectOptions {
                signal: None,
                ..options.clone()
            });

            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::cancelled("the connect was cancelled"));
            }

            if state.ready != ReadyState::Reconnecting {
                state.ready = ReadyState::Connecting;
            }

            state.serial = state.serial.saturating_add(1);

            let (reply, outcome) = oneshot::channel();
            let given_up = options
                .signal
                .as_ref()
                .map_or_else(CancellationToken::new, CancellationToken::child_token);
            let attempt = Arc::new(Attempt {
                serial: state.serial,
                state: Mutex::new(AttemptState {
                    reply: Some(reply),
                    ..AttemptState::default()
                }),
                given_up,
            });

            state.attempt = Some(Arc::clone(&attempt));
            drop(state);

            (attempt, outcome)
        };
        // its timeout, on the client's clock; none for never
        let timer = (timeout != crate::duration::NEVER).then(|| {
            let client = Arc::downgrade(inner);
            let attempt = Arc::clone(&attempt);
            let mut fired = Some(());

            inner.clock.arm(
                Schedule::Once(timeout),
                Box::new(move || {
                    if fired.take().is_some()
                        && let Some(client) = client.upgrade()
                    {
                        client.settle((&attempt, Err(TransportError::TimedOut(timeout))));
                    }
                }),
            )
        });

        match timer.transpose() {
            Ok(timer) => locked(&attempt.state).timer = timer,
            Err(error) => {
                inner.settle((&attempt, Err(TransportError::Refused(error.clone()))));
                return Err(error.into());
            }
        }

        // its signal: cancelled, the connect gives up
        if let Some(signal) = options.signal.clone() {
            let client = Arc::downgrade(inner);
            let attempt = Arc::clone(&attempt);

            crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
                let is_cancelled =
                    first_of((signal.cancelled(), attempt.given_up.cancelled())).await;

                if is_cancelled && let Some(client) = client.upgrade() {
                    client.settle((
                        &attempt,
                        Err(TransportError::cancelled("the connect was cancelled")),
                    ));
                }
            });
        }

        let peer = Arc::new(ClientPeer {
            client: Arc::downgrade(inner),
            attempt: Arc::clone(&attempt),
            address,
            port: options.port,
        });
        let accepting = options.server.inner.accept(peer, attempt.given_up.clone());
        let client = Arc::downgrade(inner);
        let pipe = options.server.inner.pipe.downgrade();

        crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
            let accepted = accepting.await.unwrap_or_else(|_dropped| {
                Err(TransportError::Connect(ConnectError::new(
                    "the in-memory transport server is gone",
                )))
            });
            let Some(client) = client.upgrade() else {
                // ! a connection drawn for a client let go meanwhile is closed at once, unclean,
                // its server told (spec 15.15): its end reaches its server alone
                if let Ok(end) = accepted {
                    later_on(&pipe, move || end.close(false));
                }

                return;
            };

            if let Ok(end) = &accepted {
                let mut held = locked(&attempt.state);

                // a connection drawn once its connect was given up on is closed at once
                if held.is_given_up {
                    let end = end.clone();

                    drop(held);
                    end.close_later(false);
                } else {
                    held.accepted = Some(end.clone());
                }
            }

            client.settle((&attempt, accepted));
        });

        Ok(reply)
    }

    /// Closes its connection, its server told in a later turn.
    ///
    /// # Errors
    ///
    /// A [`TransportError`] when it is not open.
    pub fn disconnect(
        &self,
        options: &TransportClientDisconnectOptions,
    ) -> Result<(), TransportError> {
        let inner = &self.inner;
        let is_clean = options.is_clean.unwrap_or(true);
        let is_quick = options.is_quick.unwrap_or(false);
        let end = {
            let mut state = locked(&inner.state);

            if state.ready != ReadyState::Open || state.current.is_none() {
                return Err(TransportError::ReadyState(ReadyStateError::new(
                    state.ready,
                    ReadyState::Open,
                )));
            }

            state.ready = ReadyState::Closing;
            state.held.clear();

            let end = state.current.take().map(|(end, _)| end);

            state.ready = ReadyState::Closed;

            end
        };

        if let Some(end) = end {
            end.close_later(is_clean);
        }

        inner.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, is_quick));

        Ok(())
    }

    /// Lets go of its connection at once, its server told as of a connection dropped, and of a
    /// connect under way.
    pub fn dispose(&self) {
        let inner = &self.inner;

        inner.give_up(TransportError::Connect(ConnectError::new(
            "the transport client was disposed as it connected",
        )));

        let end = inner.drop_current();

        if let Some(end) = end {
            end.close_later(false);
        }

        let mut state = locked(&inner.state);

        if state.ready == ReadyState::Open {
            state.ready = ReadyState::Closed;
        }
    }

    /// Closes its connection cleanly when it is open, then lets go of everything.
    pub fn close(&self) {
        if self.ready_state() == ReadyState::Open {
            drop(self.disconnect(&TransportClientDisconnectOptions::default()));
        }

        self.dispose();
    }

    /// Reconnects to the server it connected to last, started as it is called.
    ///
    /// # Errors
    ///
    /// A [`TransportError`] for a reconnection under way, a client never connected, one connecting
    /// or closing, a fixed delay out of bounds (spec 1.4), or a signal cancelled already: each
    /// refused before anything moves, in that order.
    pub fn reconnect(
        &self,
        options: &TransportClientReconnectOptions,
    ) -> Result<BoxFuture<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;
        let target = {
            let state = locked(&inner.state);

            if state.ready == ReadyState::Reconnecting {
                return Err(TransportError::Refused(ProgrammerError::new(
                    "the transport client is already reconnecting",
                )));
            }

            let Some(target) = state.last_connect.clone() else {
                return Err(TransportError::Refused(ProgrammerError::new(
                    "the transport client was never connected",
                )));
            };

            if matches!(state.ready, ReadyState::Connecting | ReadyState::Closing) {
                return Err(TransportError::Refused(ProgrammerError::new(format!(
                    "the transport client cannot reconnect while {}",
                    state.ready.said()
                ))));
            }

            // * a fixed delay out of bounds refused as it is given, before anything moves
            hold_reconnection(options)?;
            drop(state);

            target
        };

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(TransportError::cancelled(RECONNECTION_CANCELLED));
        }

        inner.tell(|listener: &dyn ClientListener| listener.on_reconnect());

        if self.ready_state() == ReadyState::Open {
            // dropped without a handshake, so no close reaches the listeners for a connection
            // replaced
            self.dispose();
        }

        locked(&inner.state).ready = ReadyState::Reconnecting;

        let (reply, outcome) = oneshot::channel();
        let client = self.clone();
        let options = options.clone();

        crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
            let reconnected = client.reconnecting((target, options)).await;

            if reconnected.is_err() {
                locked(&client.inner.state).ready = ReadyState::Closed;
            }

            drop(reply.send(reconnected));
        });

        Ok(Box::pin(async move {
            outcome
                .await
                .unwrap_or_else(|_dropped| Err(TransportError::cancelled(RECONNECTION_CANCELLED)))
        }))
    }

    async fn reconnecting(
        &self,
        (target, options): (
            MemoryTransportClientConnectOptions,
            TransportClientReconnectOptions,
        ),
    ) -> Result<(), TransportError> {
        let inner = &self.inner;

        attempting((&inner.clock, &options), |signal| {
            locked(&inner.state).is_attempting = true;

            let connecting = self.connect(&MemoryTransportClientConnectOptions {
                signal,
                ..target.clone()
            });

            locked(&inner.state).is_attempting = false;

            connecting
        })
        .await?;

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            drop(self.disconnect(&TransportClientDisconnectOptions::default()));

            return Err(TransportError::cancelled(RECONNECTION_CANCELLED));
        }

        Ok(())
    }
}

impl RouterClientTransport for MemoryTransportClient {
    // ! the bytes held now, so a sender that reuses its buffer changes nothing on its way
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let end = {
            let state = locked(&self.inner.state);

            match (&state.current, state.ready) {
                (Some((end, _)), ReadyState::Open) => end.clone(),
                (_, ready) => {
                    return Err(refused_unless_open(ready));
                }
            }
        };

        // refused before it goes, the connection kept: a field could not carry it as it is
        if let Some(credential) = &message.credential
            && !is_field_value(credential)
        {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(
                "a credential holds visible ASCII, spaces and tabs alone, none first or last",
            ))));
        }

        // an empty credential carries none, as an empty field does
        let credential = message
            .credential
            .filter(|credential| !credential.is_empty());
        let data: Bytes = message.data;
        let Some(pipe) = end.pipe() else {
            return Ok(Sent::Done);
        };

        later_on(&pipe, move || {
            end.receive(TransportMessage {
                data,
                credential,
                ..TransportMessage::default()
            });
        });

        Ok(Sent::Done)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.inner.listeners.remove(listener);
    }

    // ! its state's lock alone, which it never holds as it tells a listener: what comes from now on
    // is held, in order and without bound, its server being its application's own code (spec
    // 15.13); the pause outlasts a connection
    fn pause(&self) {
        locked(&self.inner.state).is_paused = true;
    }

    // ! its state's lock alone, as `pause`: what it holds is handed on in a later turn of the pipe,
    // behind what is queued there, never within this call
    fn resume(&self) {
        // the pipe of its connection's server, when it holds anything: what it held went with
        // any connection before it
        let pipe = {
            let mut state = locked(&self.inner.state);

            state.is_paused = false;

            if state.held.is_empty() {
                None
            } else {
                state.current.as_ref().and_then(|(end, _)| end.pipe())
            }
        };

        if let Some(pipe) = pipe {
            let inner = Arc::clone(&self.inner);

            later_on(&pipe, move || inner.release());
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    fn is_secure(&self) -> bool {
        true
    }

    fn carries(&self, credential: &str) -> bool {
        is_field_value(credential)
    }

    fn ready_state(&self) -> ReadyState {
        locked(&self.inner.state).ready
    }
}
