//! The in-memory transport (spec 15.13): a server and its clients in one process, each envelope
//! handed on whole, once and in order, in a later turn than its send, each close told to the other
//! end in a later turn; a connection secure and two-way, which carries a credential toward its
//! server and none toward its client.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock, SystemClock, Timer};
use crate::duration::hold;
use crate::errors::{ConnectError, ProgrammerError, ReadyStateError, TransportError};
use crate::ordered::Ordered;
use crate::owner::{Owner, WeakOwner};
use crate::platform::runtime_of;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    CONNECT_TIMEOUT, ClientListener, ClientTransport, Connect, DisconnectOptions, Listeners,
    RECONNECTION_CANCELLED, ReadyState, ReconnectOptions, Sent, ServerListener, ServerTransport,
    attempting, first_of, is_field_value,
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

fn later_on<J: FnOnce() + Send + 'static>(pipe: &WeakOwner<Pipe>, job: J) {
    pipe.offer(Box::new(move |_: &mut Pipe| job()));
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn wall_of(clock: &SharedClock) -> i64 {
    clock
        .wall()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

// ── The server ───────────────────────────────────────────────────────────────────────────────

/// How an in-memory transport server is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryServerOptions {
    /// The clock it runs on, which the layers above it run on too.
    pub clock: Option<SharedClock>,
    /// The runtime its later turns run on: the current one when none.
    pub runtime: Option<Handle>,
}

// a connection held, as the server keeps it
#[derive(Clone)]
struct Connection {
    serial: u64,
    address: String,
    port: Option<u16>,
    peer: Arc<ClientPeer>,
    last_activity: Option<i64>,
}

struct ServerState {
    ready: ReadyState,
    connections: Ordered<ConnectionHandle, Connection>,
    ordinal: u64,
    serial: u64,
}

struct ServerInner {
    given: Option<SharedClock>,
    clock: SharedClock,
    pipe: Owner<Pipe>,
    state: Mutex<ServerState>,
    listeners: Listeners<dyn ServerListener>,
}

/// An in-memory transport server: what its clients connect to, in the same process.
#[derive(Clone)]
pub struct MemoryServer {
    inner: Arc<ServerInner>,
}

impl fmt::Debug for MemoryServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryServer")
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
        let listeners = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn ServerListener + 'static)| call(listener),
            |error: RouterError| {
                for heard in &listeners {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error, connection_handle);
                    }))
                    .ok();
                }
            },
        ));
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
                drop(reply.send(Err(TransportError::Cancelled(
                    "the connect was cancelled".to_owned(),
                ))));

                return;
            }

            let drawn = {
                let mut state = locked(&server.state);

                if state.ready == ReadyState::Open {
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
                        },
                    );

                    Ok((handle, serial))
                } else {
                    Err(state.ready)
                }
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
}

impl MemoryServer {
    /// An in-memory transport server, not started.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time driver.
    pub fn new(options: &MemoryServerOptions) -> Result<Self, ProgrammerError> {
        let runtime = runtime_of(options.runtime.as_ref(), "an in-memory transport")?;
        let clock: SharedClock = match &options.clock {
            Some(clock) => Arc::clone(clock),
            None => Arc::new(SystemClock::new(runtime.clone())),
        };
        let pipe = Owner::spawn((&runtime, &clock), |_: WeakOwner<Pipe>| Pipe);

        Ok(Self {
            inner: Arc::new(ServerInner {
                given: options.clock.clone(),
                clock,
                pipe,
                state: Mutex::new(ServerState {
                    ready: ReadyState::Uninitialized,
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
        locked(&self.inner.state).ready
    }

    /// The connections it holds, and the address and port each client gave, with its last
    /// activity.
    #[must_use]
    pub fn clients(&self) -> Vec<(ConnectionHandle, String, Option<u16>, Option<i64>)> {
        locked(&self.inner.state)
            .connections
            .iter()
            .map(|(handle, connection)| {
                (
                    Arc::clone(handle),
                    connection.address.clone(),
                    connection.port,
                    connection.last_activity,
                )
            })
            .collect()
    }
}

impl ServerTransport for MemoryServer {
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

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    fn transport_type(&self) -> Option<&str> {
        Some(TRANSPORT_MEMORY)
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        let refused = {
            let mut state = locked(&self.inner.state);

            if matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed) {
                state.ready = ReadyState::Open;

                None
            } else {
                Some(state.ready)
            }
        };

        Box::pin(async move {
            refused.map_or(Ok(()), |ready| {
                Err(RouterError::Other(Arc::new(ProgrammerError::new(format!(
                    "the transport server is already {}",
                    ready.said()
                )))))
            })
        })
    }

    // every connection ended in one later turn, in the order they came: none drawn in a turn
    // before it is left open, and none is drawn after it
    fn stop(&self) -> BoxFuture<()> {
        {
            let mut state = locked(&self.inner.state);

            if matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed) {
                return Box::pin(async {});
            }

            state.ready = ReadyState::Closing;
        }

        let (reply, stopped) = oneshot::channel::<()>();
        let inner = Arc::clone(&self.inner);

        self.inner.later(move || {
            let held: Vec<(ConnectionHandle, u64)> = locked(&inner.state)
                .connections
                .iter()
                .map(|(handle, connection)| (Arc::clone(handle), connection.serial))
                .collect();

            for (handle, serial) in held {
                inner.end((&handle, serial), (true, true));
            }

            {
                let mut state = locked(&inner.state);

                state.connections.clear();
                state.ready = ReadyState::Closed;
            }

            reply.send(()).ok();
        });

        Box::pin(async move {
            drop(stopped.await);
        })
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

    // what its client sent, told with the address and the port its client gave
    fn receive(&self, message: TransportMessage) {
        let Some(server) = self.server.upgrade() else {
            return;
        };
        let now = wall_of(&server.clock);
        let origin = {
            let mut state = locked(&server.state);

            match state.connections.get_mut(&self.handle) {
                Some(connection) if connection.serial == self.serial => {
                    connection.last_activity = Some(now);

                    Some((connection.address.clone(), connection.port))
                }
                _ => None,
            }
        };
        let Some((address, port)) = origin else {
            return;
        };
        let told = TransportMessage {
            address: Some(address),
            port,
            ..message
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
}

// ── The client ───────────────────────────────────────────────────────────────────────────────

/// How an in-memory transport client is built.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MemoryClientOptions {
    /// The clock it runs on: its connect's timeout and its reconnection's delays.
    pub clock: Option<SharedClock>,
    /// The server it connects to.
    pub server: MemoryServer,
}

impl MemoryClientOptions {
    /// A client of `server`, on the platform's clock.
    #[must_use]
    pub const fn of(server: MemoryServer) -> Self {
        Self {
            clock: None,
            server,
        }
    }
}

/// How an in-memory client connects.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryConnectOptions {
    /// The address it gives its server: [`MEMORY_ADDRESS`] when none.
    pub address: Option<String>,
    /// The port it gives its server.
    pub port: Option<u16>,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// How long it waits for its server: [`CONNECT_TIMEOUT`] when none.
    pub timeout: Option<Duration>,
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
    last_connect: Option<MemoryConnectOptions>,
    is_attempting: bool,
    attempt: Option<Arc<Attempt>>,
    serial: u64,
}

struct ClientInner {
    given: Option<SharedClock>,
    clock: SharedClock,
    runtime: Handle,
    server: MemoryServer,
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
    fn is_current(&self, client: &ClientInner) -> bool {
        locked(&client.state)
            .current
            .as_ref()
            .is_some_and(|(_, serial)| *serial == self.attempt.serial)
    }

    fn receive(&self, message: TransportMessage) {
        let Some(client) = self.client.upgrade() else {
            return;
        };

        if self.is_current(&client) {
            return client
                .tell(|listener: &dyn ClientListener| listener.on_message(message.clone()));
        }

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
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error);
                    }))
                    .ok();
                }
            },
        ));
    }

    fn later<J: FnOnce() + Send + 'static>(&self, job: J) {
        later_on(&self.server.inner.pipe.downgrade(), job);
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
                    self.later(move || end.close(false));
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
                Ok(_) if attempt.given_up.is_cancelled() => Err(TransportError::Cancelled(
                    "the connect was cancelled".to_owned(),
                )),
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
                    self.later(move || accepted.close(false));
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
                    state.ready = ReadyState::Open;

                    if state
                        .attempt
                        .as_ref()
                        .is_some_and(|held| Arc::ptr_eq(held, attempt))
                    {
                        state.attempt = None;
                    }
                }

                for message in early {
                    let is_current = locked(&self.state)
                        .current
                        .as_ref()
                        .is_some_and(|(_, serial)| *serial == attempt.serial);

                    if is_current {
                        self.tell(|listener: &dyn ClientListener| {
                            listener.on_message(message.clone());
                        });
                    }
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

    // drops the open connection
    fn drop_current(&self) -> Option<ServerEnd> {
        locked(&self.state).current.take().map(|(end, _)| end)
    }
}

/// An in-memory transport client: one connection at a time to its server.
#[derive(Clone)]
pub struct MemoryClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for MemoryClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryClient")
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

impl MemoryClient {
    /// A client of `options.server`, not connected.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, or on one without its time driver.
    pub fn new(options: &MemoryClientOptions) -> Result<Self, ProgrammerError> {
        let runtime = runtime_of(None, "an in-memory transport")?;
        let clock: SharedClock = match &options.clock {
            Some(clock) => Arc::clone(clock),
            None => Arc::new(SystemClock::new(runtime.clone())),
        };

        Ok(Self {
            inner: Arc::new(ClientInner {
                given: options.clock.clone(),
                clock,
                runtime,
                server: options.server.clone(),
                state: Mutex::new(ClientState {
                    ready: ReadyState::Uninitialized,
                    current: None,
                    last_connect: None,
                    is_attempting: false,
                    attempt: None,
                    serial: 0,
                }),
                listeners: Listeners::default(),
            }),
        })
    }

    /// Connects to its server, started as it is called: open once its server drew the connection.
    pub fn connect(&self, options: MemoryConnectOptions) -> Connect {
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
        options: MemoryConnectOptions,
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
            state.last_connect = Some(MemoryConnectOptions {
                signal: None,
                ..options.clone()
            });

            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::Cancelled(
                    "the connect was cancelled".to_owned(),
                ));
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

        if let Some(timer) = timer {
            locked(&attempt.state).timer = Some(timer);
        }

        // its signal: cancelled, the connect gives up
        if let Some(signal) = options.signal {
            let client = Arc::downgrade(inner);
            let attempt = Arc::clone(&attempt);

            crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
                let is_cancelled =
                    first_of((signal.cancelled(), attempt.given_up.cancelled())).await;

                if is_cancelled && let Some(client) = client.upgrade() {
                    client.settle((
                        &attempt,
                        Err(TransportError::Cancelled(
                            "the connect was cancelled".to_owned(),
                        )),
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
        let accepting = inner.server.inner.accept(peer, attempt.given_up.clone());
        let client = Arc::downgrade(inner);

        crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
            let accepted = accepting.await.unwrap_or_else(|_dropped| {
                Err(TransportError::Connect(ConnectError::new(
                    "the in-memory transport server is gone",
                )))
            });
            let Some(client) = client.upgrade() else {
                return;
            };

            if let Ok(end) = &accepted {
                let mut held = locked(&attempt.state);

                // a connection drawn once its connect was given up on is closed at once
                if held.is_given_up {
                    let end = end.clone();

                    drop(held);
                    client.later(move || end.close(false));
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
    pub fn disconnect(&self, options: DisconnectOptions) -> Result<(), TransportError> {
        let inner = &self.inner;
        let is_clean = options.is_clean.unwrap_or(true);
        let is_quick = options.is_quick.unwrap_or(false);
        let end = {
            let mut state = locked(&inner.state);

            if state.ready != ReadyState::Open || state.current.is_none() {
                return Err(TransportError::ReadyState(ReadyStateError::new(
                    state.ready.name(),
                    ReadyState::Open.name(),
                )));
            }

            state.ready = ReadyState::Closing;

            let end = state.current.take().map(|(end, _)| end);

            state.ready = ReadyState::Closed;

            end
        };

        if let Some(end) = end {
            inner.later(move || end.close(is_clean));
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
            inner.later(move || end.close(false));
        }

        let mut state = locked(&inner.state);

        if state.ready == ReadyState::Open {
            state.ready = ReadyState::Closed;
        }
    }

    /// Closes its connection cleanly when it is open, then lets go of everything.
    pub fn close(&self) {
        if self.ready_state() == ReadyState::Open {
            drop(self.disconnect(DisconnectOptions::default()));
        }

        self.dispose();
    }

    /// Reconnects to the server it connected to last, started as it is called.
    ///
    /// # Errors
    ///
    /// A [`TransportError`] for a reconnection under way, a client never connected, one connecting
    /// or closing, or a signal cancelled already.
    pub fn reconnect(
        &self,
        options: ReconnectOptions,
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

            drop(state);

            target
        };

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
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

        crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
            let reconnected = client.reconnecting((target, options)).await;

            if reconnected.is_err() {
                locked(&client.inner.state).ready = ReadyState::Closed;
            }

            drop(reply.send(reconnected));
        });

        Ok(Box::pin(async move {
            outcome.await.unwrap_or_else(|_dropped| {
                Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()))
            })
        }))
    }

    async fn reconnecting(
        &self,
        (target, options): (MemoryConnectOptions, ReconnectOptions),
    ) -> Result<(), TransportError> {
        let inner = &self.inner;

        attempting((&inner.clock, &options), |signal| {
            locked(&inner.state).is_attempting = true;

            let connecting = self.connect(MemoryConnectOptions {
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
            drop(self.disconnect(DisconnectOptions::default()));

            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
        }

        Ok(())
    }
}

impl ClientTransport for MemoryClient {
    // ! the bytes held now, so a sender that reuses its buffer changes nothing on its way
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let end = {
            let state = locked(&self.inner.state);

            match (&state.current, state.ready) {
                (Some((end, _)), ReadyState::Open) => end.clone(),
                (_, ready) => {
                    return Err(RouterError::Other(Arc::new(ReadyStateError::new(
                        ready.name(),
                        ReadyState::Open.name(),
                    ))));
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
