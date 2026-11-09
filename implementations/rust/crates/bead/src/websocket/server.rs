//! A transport server over WebSocket connections (spec 15.2, 15.12), as the other sides'
//! `createWebSocketTransportServer` and `WebSocketTransportServer` serve them, with no HTTP server
//! beneath: it reads each connection's one head itself, under 16 KiB and 100 fields and within its
//! headers timeout, judges it in the order of spec 15.2, writes its 101 or its refusal, and hands
//! its socket, what it read past the head first, to tungstenite.

use core::fmt;
use core::future::{Future, poll_fn};
use core::pin::pin;
use core::task::Poll;
use core::time::Duration;
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tungstenite::protocol::Role;

use crate::clock::{Schedule, SharedClock, SystemClock};
use crate::constants::{ProtocolCode, RouterSide};
use crate::duration::{hold, hold_finite};
use crate::errors::ProgrammerError;
use crate::failure::Failure;
use crate::judgement::handshake::{
    AnswerField, HandshakeRefusal, HandshakeRequest, HandshakeTaken, busy_handshake,
    refusal_of_handshake, told_of_handshake,
};
use crate::judgement::head::{Head, HeadRead, read_head};
use crate::judgement::hosts::{
    assert_hosts, assert_listening_address, assert_origins, credential_of,
};
use crate::life::Life;
use crate::net::bounds::{HEADERS_TIMEOUT, dropped_of, hold_count};
use crate::net::linger::close_in_stages;
use crate::net::loopbacks::{LOCALHOST, LoopbackBinding, bind_loopbacks, listener_on};
use crate::platform::{self, Handle, JoinHandle};
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    Listeners, ReadyState, Sent, ServerListener, ServerTransport, TransportServerAddress,
    TransportServerClient, TransportServerRefusal, TransportServerStartOptions, tell_server,
};
use crate::websocket::connection::{
    CLOSE_TIMEOUT, Commands, Connection, ConnectionBounds, ConnectionHooks, Ended, Failed,
    GOING_AWAY, MAXIMUM_MESSAGE_BYTES, NORMAL,
};
use crate::{MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS};

#[cfg(test)]
mod tests;

/// The type every handle a WebSocket transport server draws begins with (spec 15.1).
pub const TRANSPORT_WEBSOCKET: &str = "WS";

// the port a start names none of listens on, HTTP's
const PORT: u16 = 80;

// what a head is read by at once
const READ_BYTES: usize = 4_096;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a WebSocket transport server is built (spec 15.2, 15.12).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct WebSocketTransportServerOptions {
    /// The clock it stamps each connection's activity and dates each refusal on, which the layers
    /// above it run on too: the platform's when none. Its close timeout and its headers timeout
    /// run on the platform's clock, whatever it is given, since they bound what the platform's
    /// socket does (decision 0011).
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
    /// How long a close it begins waits for its peer's answer before it drops the socket:
    /// [`CLOSE_TIMEOUT`] when none; [`crate::NEVER`] waits without end, arming no timer.
    pub close_timeout: Option<Duration>,
    /// How long a request's head may take to come whole, past which it is answered 408:
    /// [`HEADERS_TIMEOUT`] when none; never is refused.
    pub headers_timeout: Option<Duration>,
    /// The hosts it takes besides those every server takes, the loopback's and its own (spec
    /// 15.12); `*` takes any. None when none.
    pub hosts: Option<Vec<String>>,
    /// The largest message it reads, past which it fails the connection with 1009 (spec 15.3):
    /// [`MAXIMUM_MESSAGE_BYTES`] when none.
    pub maximum_message_bytes: Option<u64>,
    /// The connections it holds at once, past which an upgrade is refused 503 `busy` (spec 15.12):
    /// [`MAXIMUM_CONNECTIONS`] when none.
    pub maximum_connections: Option<u64>,
    /// The connections one client address holds at once: [`MAXIMUM_CONNECTIONS_PER_ADDRESS`]
    /// when none.
    pub maximum_connections_per_address: Option<u64>,
    /// The origins it takes besides its own (spec 15.12). None when none.
    pub origins: Option<Vec<String>>,
    /// Whether its connections stay off the machine's clear, as its application says of what
    /// stands in front of it (spec 13.4): by the address it listens on when none, the loopback
    /// secure and any other not.
    pub secure: Option<bool>,
}

// what it was built with, held
#[derive(Debug)]
struct Settings {
    close_timeout: Duration,
    headers_timeout: Duration,
    hosts: Vec<String>,
    origins: Vec<String>,
    maximum_message_bytes: u64,
    maximum_connections: u64,
    maximum_per_address: u64,
    secure: Option<bool>,
}

// a connection it holds
struct Held {
    commands: Commands,
    address: String,
    port: u16,
    arrival: u64,
    last_activity: Option<SystemTime>,
}

// one address it listens on: whether that listener still serves what comes, and its accepting
struct Listening {
    serving: Arc<AtomicBool>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct ServerState {
    connections: HashMap<ConnectionHandle, Held>,
    listening: Vec<Listening>,
    // the rank of the last connection taken, across its starts: no handle is given twice
    ordinal: u64,
    // the places upgrades took, and those each client address took; an address that holds none is
    // not kept
    placed: u64,
    per_address: HashMap<String, u64>,
    // what it listens on, which says whether it is secure
    listens_on: Option<String>,
}

pub(crate) struct ServerInner {
    me: Weak<Self>,
    runtime: Handle,
    // the platform's clock, which its timers that bound the platform's socket run on
    platform: SharedClock,
    // the clock it stamps and dates on, and the one it was given
    clock: SharedClock,
    given: Option<SharedClock>,
    settings: Settings,
    life: Life,
    state: Mutex<ServerState>,
    listeners: Listeners<dyn ServerListener>,
}

/// A transport server over WebSocket connections.
///
/// It reads each connection's head itself, by its headers timeout on the platform's clock, past
/// which it answers 408, and under 16 KiB and 100 fields, past which it answers 431; a head that
/// does not read is answered 400. It judges a head in the order of spec 15.2: 400 as HTTP answers
/// it to a field holding a control character, a target spec 15.12 refuses, or a `Host` missing,
/// repeated or no host; 403 `host-refused` to a host it does not take; 405 `method-refused` to a
/// method but `GET` or `HEAD`; 426 `upgrade-required` to a request that asks no WebSocket, and
/// `version-refused` to a version but 13; 400 `malformed` to a malformed upgrade; 403
/// `origin-refused` to an `Origin` neither its own nor among `origins`; then 503 `busy` once its
/// stop began, or past its bounds, a place taken as its upgrade is judged and given back as its
/// socket closes. Every refusal closes its socket in stages, and a marked one, dated by its clock,
/// is told on `on_refusal` with the client's address and port.
///
/// An upgrade it takes is answered 101, with no subprotocol and no extension, and its connection
/// drawn under its handle, `type=WS;ip=…;port=…;ordinal=…`, told on `on_connection` before any
/// frame it read with the head. Each binary message is handed with the connection's address, its
/// port and its upgrade's credential: its `Authorization`, as it came and trimmed, unless it
/// carries an `Origin`, whose page's browser writes its own authentication; a text message is
/// `ENVELOPE_MALFORMED`, reported on `on_error`, handed nothing. A message past
/// `maximum_message_bytes` fails its connection with 1009, reported on `on_error` naming
/// `maximumMessageBytes`, then dropped at its peer's end or its close timeout, unclean; a protocol
/// error is reported alike, failed with 1002. A peer that drops without its closing handshake tells
/// its unclean close alone. A close is clean when its peer's carried 1000.
///
/// Its stop refuses what comes 503, closes each connection with 1001, and settles once each ended.
#[derive(Clone)]
pub struct WebSocketTransportServer {
    inner: Arc<ServerInner>,
}

impl fmt::Debug for WebSocketTransportServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketTransportServer")
            .field("ready_state", &self.inner.life.ready_state())
            .finish_non_exhaustive()
    }
}

// what an io error stands for, as a start reports it
fn io_error(error: io::Error) -> RouterError {
    RouterError::Other(Arc::new(error))
}

fn misuse(error: ProgrammerError) -> RouterError {
    RouterError::Other(Arc::new(error))
}

/// `future`'s output, or none once `token` is cancelled first.
async fn unless_cancelled<F: Future>(token: &CancellationToken, future: F) -> Option<F::Output> {
    let mut cancelled = pin!(token.cancelled());
    let mut future = pin!(future);

    poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }

        future.as_mut().poll(context).map(Some)
    })
    .await
}

/// `future`'s output, or none once `timeout` passed on `clock` first.
async fn within<F: Future>(
    clock: &SharedClock,
    (timeout, future): (Duration, F),
) -> Option<F::Output> {
    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);
    let timer = clock
        .arm(
            Schedule::Once(timeout),
            Box::new(move || {
                if let Some(woken) = woken.take() {
                    woken.send(()).ok();
                }
            }),
        )
        .ok();
    let mut wait = pin!(wait);
    let mut future = pin!(future);
    let outcome = poll_fn(|context| {
        if let Poll::Ready(output) = future.as_mut().poll(context) {
            return Poll::Ready(Some(output));
        }

        // a clock that arms no timer waits without end
        if timer.is_some() && wait.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }

        Poll::Pending
    })
    .await;

    if let Some(timer) = timer {
        timer.cancel();
    }

    outcome
}

/// An instant as an HTTP date, its IMF-fixdate (RFC 9110 §5.6.7).
#[expect(
    clippy::arithmetic_side_effects,
    reason = "a day's civil date: each operand is bounded by the days since the epoch, divided down"
)]
fn http_date(instant: SystemTime) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let seconds = instant
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let days = seconds / 86_400;
    let of_day = seconds % 86_400;
    // the civil date of a day since the epoch, by Howard Hinnant's algorithm
    let shifted = days.saturating_add(719_468);
    let era = shifted / 146_097;
    let of_era = shifted % 146_097;
    let year_of_era = (of_era - of_era / 1_460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * of_year + 2) / 153;
    let day = of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    let weekday = DAYS
        .get(usize::try_from(days % 7).unwrap_or(0))
        .copied()
        .unwrap_or_default();
    let month_name = MONTHS
        .get(usize::try_from(month.saturating_sub(1)).unwrap_or(0))
        .copied()
        .unwrap_or_default();

    format!(
        "{weekday}, {day:02} {month_name} {year} {:02}:{:02}:{:02} GMT",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60
    )
}

/// An answer's head: its status line, its date when it has one, then `fields` in their order.
fn answer_of(status: u16, (date, fields): (Option<String>, &[AnswerField])) -> String {
    let reason = http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or_default();
    let mut answer = format!("HTTP/1.1 {status} {reason}\r\n");

    if let Some(date) = date {
        answer.push_str("date: ");
        answer.push_str(&date);
        answer.push_str("\r\n");
    }

    for field in fields {
        answer.push_str(field.name);
        answer.push_str(": ");
        answer.push_str(field.value);
        answer.push_str("\r\n");
    }

    answer.push_str("\r\n");
    answer
}

// what HTTP answers of its own, unmarked, its connection closed: a head past its bounds, one that
// does not read, or one that did not come within its timeout
fn unmarked(status: u16) -> String {
    answer_of(
        status,
        (
            None,
            &[
                AnswerField {
                    name: "connection",
                    value: "close",
                },
                AnswerField {
                    name: "content-length",
                    value: "0",
                },
            ],
        ),
    )
}

// the values of each line of the field `name`, as they came
fn lines_of<'a>(fields: &[&'a str], name: &str) -> Vec<&'a str> {
    fields
        .as_chunks::<2>()
        .0
        .iter()
        .filter(|[field, _]| field.eq_ignore_ascii_case(name))
        .map(|[_, value]| *value)
        .collect()
}

// what a refusal at its address tells of its request, when it is marked (spec 15.1)
fn told_of(
    request: &HandshakeRequest<'_>,
    refusal: &HandshakeRefusal,
) -> Option<TransportServerRefusal> {
    refusal.refusal.map(|reason| {
        let of_request = told_of_handshake(request);
        let mut told = TransportServerRefusal::new(refusal.status, reason);

        told.authority = of_request.authority;
        told.origin = of_request.origin;

        told
    })
}

// whether `address`, what a server listens on, is the loopback: secure where nothing stands in
// front of it (spec 13.4)
fn is_loopback(address: &str) -> bool {
    address == LOCALHOST
        || address
            .parse::<IpAddr>()
            .is_ok_and(|parsed| parsed.is_loopback())
}

// a connection's client, as each of its messages is handed with it
struct Peer {
    address: String,
    port: u16,
    credential: Option<String>,
}

// what a head came as
enum HeadCame {
    Whole(Head, Vec<u8>),
    Refused(u16),
    TimedOut,
    Gone,
}

impl ServerInner {
    fn tell<C: Fn(&dyn ServerListener)>(
        &self,
        (call, connection_handle): (C, Option<&ConnectionHandle>),
    ) {
        tell_server(&self.listeners, (call, connection_handle));
    }

    // what it reports of its own, with the connection it came on
    fn report(&self, (error, connection_handle): (&RouterError, Option<&ConnectionHandle>)) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics would loop: its panic is dropped
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener.on_error(error, connection_handle);
            }))
            .ok();
        }
    }

    // binds where `options` says, and serves what comes there
    fn listen(
        self: &Arc<Self>,
        options: &TransportServerStartOptions,
    ) -> Result<TransportServerAddress, RouterError> {
        let address = options
            .address
            .clone()
            .unwrap_or_else(|| LOCALHOST.to_owned());

        assert_listening_address(&address).map_err(misuse)?;

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(RouterError::Other(Arc::new(
                crate::errors::TransportError::cancelled("the start was cancelled"),
            )));
        }

        let port = options.port.unwrap_or(PORT);
        let find_open_port = options.find_open_port.unwrap_or(false);
        let (bound, reported) = if address == LOCALHOST {
            let bound = bind_loopbacks(
                |addresses: &[IpAddr], port| {
                    addresses
                        .iter()
                        .map(|address| listener_on(*address, port))
                        .collect::<io::Result<Vec<_>>>()
                },
                &LoopbackBinding::new(port, find_open_port),
            )
            .map_err(io_error)?;

            (bound.started, bound.address.to_owned())
        } else {
            let ip: IpAddr = address.parse().map_err(|_unparsed| {
                misuse(ProgrammerError::new(format!(
                    "a server listens on an IP address, or on localhost, not \"{address}\""
                )))
            })?;
            let listener =
                listener_on(ip, if find_open_port { 0 } else { port }).map_err(io_error)?;

            (vec![listener], address)
        };
        let port = bound
            .first()
            .map(std::net::TcpListener::local_addr)
            .transpose()
            .map_err(io_error)?
            .map_or(port, |local| local.port());
        let listeners = {
            let _entered = self.runtime.enter();

            bound
                .into_iter()
                .map(TcpListener::from_std)
                .collect::<io::Result<Vec<_>>>()
                .map_err(io_error)?
        };
        let listening: Vec<Listening> = listeners
            .into_iter()
            .map(|listener| {
                let serving = Arc::new(AtomicBool::new(true));
                let stop = CancellationToken::new();
                let task = platform::spawn(
                    &self.runtime,
                    accept(
                        (Weak::clone(&self.me), listener),
                        (Arc::clone(&serving), stop.clone()),
                    ),
                );

                Listening {
                    serving,
                    stop,
                    task,
                }
            })
            .collect();
        let mut state = locked(&self.state);

        state.listening.extend(listening);
        state.listens_on = Some(reported.clone());
        drop(state);

        Ok(TransportServerAddress::new(reported, port))
    }

    // its stop's body: no upgrade served from now, each listener let go, then each connection
    // closed with 1001; settled once each listener and each connection ended
    fn stopping(self: &Arc<Self>) -> BoxFuture<Result<(), RouterError>> {
        let (listening, held): (Vec<Listening>, Vec<Commands>) = {
            let mut state = locked(&self.state);

            (
                core::mem::take(&mut state.listening),
                state
                    .connections
                    .values()
                    .map(|held| held.commands.clone())
                    .collect(),
            )
        };

        for listener in &listening {
            listener.serving.store(false, Ordering::SeqCst);
            listener.stop.cancel();
        }

        for commands in &held {
            commands.close(GOING_AWAY);
        }

        Box::pin(async move {
            for listener in listening {
                listener.task.await.ok();
            }

            for commands in held {
                commands.ended().await;
            }

            Ok(())
        })
    }

    // * a place is taken as its upgrade is judged, before its 101, and given back once its socket
    // closes, whatever became of it, so upgrades that cross take no more than are left (spec 15.2,
    // step 8)
    fn place(&self, address: &str) -> bool {
        let mut state = locked(&self.state);
        let of_address = state.per_address.get(address).copied().unwrap_or(0);

        if state.placed >= self.settings.maximum_connections
            || of_address >= self.settings.maximum_per_address
        {
            return false;
        }

        state.placed = state.placed.saturating_add(1);
        state
            .per_address
            .insert(address.to_owned(), of_address.saturating_add(1));

        true
    }

    fn unplace(&self, address: &str) {
        let mut state = locked(&self.state);

        state.placed = state.placed.saturating_sub(1);

        let others = state
            .per_address
            .get(address)
            .copied()
            .unwrap_or(0)
            .saturating_sub(1);

        if others == 0 {
            state.per_address.remove(address);
        } else {
            state.per_address.insert(address.to_owned(), others);
        }
    }

    // reads a head from `socket`, within its headers timeout on the platform's clock
    async fn head_of(&self, socket: &mut TcpStream) -> HeadCame {
        let reading = async {
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = [0_u8; READ_BYTES];

            loop {
                match socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => return HeadCame::Gone,
                    Ok(read) => buffer.extend_from_slice(chunk.get(..read).unwrap_or_default()),
                }

                match read_head(&buffer) {
                    HeadRead::Partial => {}
                    HeadRead::Refused(status) => return HeadCame::Refused(status),
                    HeadRead::Whole(head) => {
                        let rest = buffer.get(head.length..).unwrap_or_default().to_vec();

                        return HeadCame::Whole(head, rest);
                    }
                }
            }
        };

        within(&self.platform, (self.settings.headers_timeout, reading))
            .await
            .unwrap_or(HeadCame::TimedOut)
    }

    // serves one socket accepted: its head read and judged, then refused, or upgraded and run
    async fn serve(
        self: Arc<Self>,
        (mut socket, peer): (TcpStream, SocketAddr),
        serving: Arc<AtomicBool>,
    ) {
        socket.set_nodelay(true).ok();

        let (head, read) = match self.head_of(&mut socket).await {
            HeadCame::Whole(head, read) => (head, read),
            HeadCame::Refused(status) => return self.answer(socket, unmarked(status)).await,
            HeadCame::TimedOut => return self.answer(socket, unmarked(408)).await,
            HeadCame::Gone => return,
        };
        let address = peer.ip().to_canonical().to_string();
        let port = peer.port();
        let fields = head.fields();
        let request = HandshakeRequest {
            http_version: head.http_version,
            method: Some(&head.method),
            raw_fields: &fields,
            target: Some(&head.target),
        };
        let judged = refusal_of_handshake(
            &request,
            &HandshakeTaken::new(&self.settings.hosts, &self.settings.origins),
        );
        // its bounds judged after its origin, and once its stop began, busy
        let refusal = judged.or_else(|| {
            (!serving.load(Ordering::SeqCst)
                || self.life.ready_state() != ReadyState::Open
                || !self.place(&address))
            .then(busy_handshake)
        });

        if let Some(refusal) = refusal {
            let mut told = told_of(&request, &refusal);

            if let Some(told) = told.as_mut() {
                told.address = Some(address);
                told.port = Some(port);
            }

            return self.refuse(socket, (refusal, told)).await;
        }

        let upgraded = self.upgrade(&mut socket, &fields).await;

        if upgraded.is_err() {
            self.unplace(&address);

            return;
        }

        // ! an upgrade that carries an `Origin` carries no credential: a page's browser writes its
        // own authentication on it (Fetch, credentials mode `include`)
        let credential = lines_of(&fields, "origin")
            .is_empty()
            .then(|| credential_of(&lines_of(&fields, "authorization")).map(str::to_owned))
            .flatten();

        self.run(
            (socket, read),
            Peer {
                address,
                port,
                credential,
            },
        )
        .await;
    }

    // writes a refusal, then tells it, when it is marked, the transport's own (spec 15.1); its
    // socket closed in stages
    async fn refuse(
        &self,
        socket: TcpStream,
        (refusal, told): (HandshakeRefusal, Option<TransportServerRefusal>),
    ) {
        let HandshakeRefusal {
            fields,
            refusal: reason,
            status,
        } = refusal;
        let date = reason.map(|_| http_date(self.clock.wall()));

        self.answer(socket, answer_of(status, (date, &fields)))
            .await;

        if let Some(told) = told {
            self.tell((
                |listener: &dyn ServerListener| listener.on_refusal(&told),
                None,
            ));
        }
    }

    // writes `answer` whole, then closes the socket in stages
    async fn answer(&self, mut socket: TcpStream, answer: String) {
        if socket.write_all(answer.as_bytes()).await.is_ok() {
            // ! closed in stages on the platform's clock, never awaited by a stop
            let platform = Arc::clone(&self.platform);

            platform::spawn(&self.runtime, async move {
                close_in_stages(socket, &platform).await;
            });
        }
    }

    // the 101 of an upgrade taken (RFC 6455 §4.2.2): no subprotocol, no extension
    async fn upgrade(&self, socket: &mut TcpStream, fields: &[&str]) -> io::Result<()> {
        let key = lines_of(fields, "sec-websocket-key")
            .first()
            .map(|key| key.trim_matches([' ', '\t']).to_owned())
            .unwrap_or_default();
        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
        let answer = format!(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
        );

        socket.write_all(answer.as_bytes()).await
    }

    // runs a connection upgraded: drawn and told, then each message handed on, then its end told
    async fn run(self: Arc<Self>, (socket, read): (TcpStream, Vec<u8>), peer: Peer) {
        let Peer { address, port, .. } = &peer;
        let (address, port) = (address.clone(), *port);
        let bounds = ConnectionBounds {
            maximum_message_bytes: self.settings.maximum_message_bytes,
            close_timeout: self.settings.close_timeout,
            pacing: None,
            platform: Arc::clone(&self.platform),
        };
        let (connection, commands) = Connection::open((socket, read), (Role::Server, bounds)).await;
        // * drawn as it is taken, never from the peer's address alone, which another socket may
        // share (spec 15.1, decision 0025)
        let handle: ConnectionHandle = {
            let mut state = locked(&self.state);

            state.ordinal = state.ordinal.saturating_add(1);

            let arrival = state.ordinal;
            let handle: ConnectionHandle = Arc::from(format!(
                "type={TRANSPORT_WEBSOCKET};ip={address};port={port};ordinal={arrival}"
            ));

            state.connections.insert(
                Arc::clone(&handle),
                Held {
                    commands: commands.clone(),
                    address: address.clone(),
                    port,
                    arrival,
                    last_activity: None,
                },
            );

            handle
        };

        // ! a stop that began as it registered closes it with its own, going away: its snapshot of
        // the connections was taken already
        if self.life.ready_state() != ReadyState::Open {
            commands.close(GOING_AWAY);
        }

        // last before it reads: a listener meets a connection already registered, and before any
        // frame that arrived with the upgrade
        self.tell((
            |listener: &dyn ServerListener| listener.on_connection(&handle),
            Some(&handle),
        ));

        let delivering = Arc::clone(&self);
        let delivered = Arc::clone(&handle);
        let hooks = ConnectionHooks {
            deliver: Box::new(move |data: Bytes, is_text: bool| {
                delivering.deliver((&delivered, &peer), (data, is_text));
            }),
            answered: Box::new(|| {}),
        };
        let ended = connection.run(hooks).await;

        self.ended(&handle, &ended);
    }

    // a message whole, handed on with its connection's address and port and its upgrade's
    // credential; a text one reported, as no envelope
    fn deliver(&self, (handle, peer): (&ConnectionHandle, &Peer), (data, is_text): (Bytes, bool)) {
        if is_text {
            let error = RouterError::Failure(
                Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, RouterSide::Server)
                    .saying("an envelope is binary, not a string"),
            );

            self.report((&error, Some(handle)));

            return;
        }

        let now = self.clock.wall();

        if let Some(held) = locked(&self.state).connections.get_mut(handle) {
            held.last_activity = Some(now);
        }

        let message = TransportMessage {
            data,
            credential: peer.credential.clone(),
            address: Some(peer.address.clone()),
            port: Some(peer.port),
            may_overtake: false,
        };

        self.tell((
            |listener: &dyn ServerListener| listener.on_message(message.clone(), handle),
            Some(handle),
        ));
    }

    // * its end: its one error, then its close, unclean once it failed (spec 15.1)
    fn ended(&self, handle: &ConnectionHandle, ended: &Ended) {
        let held = locked(&self.state).connections.remove(handle);
        let Some(held) = held else {
            return;
        };

        self.unplace(&held.address);

        if let Some(failure) = &ended.failure {
            let error = match failure {
                Failed::TooBig(maximum) => RouterError::Other(Arc::new(io::Error::other(format!(
                    "{handle} is closed with 1009: a message past its maximumMessageBytes, {maximum} bytes"
                )))),
                Failed::Protocol(why) => RouterError::Other(Arc::new(io::Error::other(format!(
                    "{handle} is closed with 1002: {why}"
                )))),
                Failed::Dropped(why) => dropped_of(handle, why),
            };

            self.report((&error, Some(handle)));
        }

        let is_clean = ended.is_clean();

        self.tell((
            |listener: &dyn ServerListener| listener.on_close(is_clean, handle),
            Some(handle),
        ));
    }
}

// accepts what comes to `listener` until its stop, each socket served by a task of its own
async fn accept(
    (server, listener): (Weak<ServerInner>, TcpListener),
    (serving, stop): (Arc<AtomicBool>, CancellationToken),
) {
    while let Some(accepted) = unless_cancelled(&stop, listener.accept()).await {
        let Some(inner) = server.upgrade() else {
            return;
        };

        match accepted {
            Ok((socket, peer)) => {
                let runtime = inner.runtime.clone();

                drop(platform::spawn(
                    &runtime,
                    inner.serve((socket, peer), Arc::clone(&serving)),
                ));
            }
            // a socket gone before it was taken, or the system short of descriptors: the next is
            // taken in a later turn
            Err(_) => platform::yield_now().await,
        }
    }
}

impl WebSocketTransportServer {
    /// A WebSocket transport server, which listens once started.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for a close timeout or a headers timeout spec 1.4 does not hold, never among them
    /// for the headers timeout; a bound of 0; a hosts entry with a port; an origins entry that is
    /// `*` or `null`.
    pub fn new(options: &WebSocketTransportServerOptions) -> Result<Self, ProgrammerError> {
        let runtime =
            platform::socket_runtime_of(options.runtime.as_ref(), "a WebSocket transport server")?;
        let close_timeout = hold(
            "a close timeout",
            options.close_timeout.unwrap_or(CLOSE_TIMEOUT),
        )?;
        let headers_timeout = hold_finite(
            "headersTimeout",
            options.headers_timeout.unwrap_or(HEADERS_TIMEOUT),
        )?;
        let maximum_message_bytes = hold_count(
            "maximumMessageBytes",
            options
                .maximum_message_bytes
                .unwrap_or(MAXIMUM_MESSAGE_BYTES),
        )?;
        let maximum_connections = hold_count(
            "maximumConnections",
            options.maximum_connections.unwrap_or(MAXIMUM_CONNECTIONS),
        )?;
        let maximum_per_address = hold_count(
            "maximumConnectionsPerAddress",
            options
                .maximum_connections_per_address
                .unwrap_or(MAXIMUM_CONNECTIONS_PER_ADDRESS),
        )?;
        let hosts = options.hosts.clone().unwrap_or_default();
        let origins = options.origins.clone().unwrap_or_default();

        assert_hosts(&hosts)?;
        assert_origins(&origins)?;

        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform));
        let covering = runtime.clone();
        let inner = Arc::new_cyclic(|me| ServerInner {
            me: Weak::clone(me),
            runtime,
            platform,
            clock,
            given: options.clock.clone(),
            settings: Settings {
                close_timeout,
                headers_timeout,
                hosts,
                origins,
                maximum_message_bytes,
                maximum_connections,
                maximum_per_address,
                secure: options.secure,
            },
            life: Life::new(Box::new(move |future| {
                drop(platform::spawn(&covering, future));
            })),
            state: Mutex::new(ServerState::default()),
            listeners: Listeners::default(),
        });

        Ok(Self { inner })
    }

    /// Where it stands.
    #[must_use]
    pub fn ready_state(&self) -> ReadyState {
        self.inner.life.ready_state()
    }

    /// Starts it where `options` says, and gives where it listens: the address it bound, and its
    /// port, the one the system drew among them.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] once it is disposed, its state kept, before anything else (decision
    /// 0003); then unless Uninitialized or Closed, a second start even while the first is under
    /// way; an address that is no bare IP address nor `localhost`; a start its signal gave up; what
    /// the platform refuses the bind with, a port another socket holds among it. Each but the
    /// first two ends Closed, ready to start again.
    pub fn start(
        &self,
        options: &TransportServerStartOptions,
    ) -> BoxFuture<Result<TransportServerAddress, RouterError>> {
        let server = Arc::clone(&self.inner);
        let options = options.clone();

        self.inner
            .life
            .start(move || Box::pin(async move { server.listen(&options) }))
    }

    /// Stops it, as its stop does, then ends it for good: a start after it is its application's
    /// misuse (decision 0003); a later dispose settles with the first.
    ///
    /// # Errors
    ///
    /// What its stop is refused with: a dispose while it starts, say.
    pub fn dispose(&self) -> BoxFuture<Result<(), RouterError>> {
        let server = Arc::clone(&self.inner);

        self.inner.life.dispose(move || server.stopping())
    }

    /// The connections it holds, in the order they came: each its handle, its client's address and
    /// port, and when it last delivered an envelope, by its clock.
    #[must_use]
    pub fn clients(&self) -> Vec<TransportServerClient> {
        let mut held: Vec<_> = locked(&self.inner.state)
            .connections
            .iter()
            .map(|(handle, held)| {
                (
                    held.arrival,
                    TransportServerClient {
                        connection_handle: Arc::clone(handle),
                        address: held.address.clone(),
                        port: Some(held.port),
                        last_activity: held.last_activity,
                        transport_type: TRANSPORT_WEBSOCKET,
                    },
                )
            })
            .collect();

        held.sort_by_key(|(arrival, _)| *arrival);
        held.into_iter().map(|(_, client)| client).collect()
    }

    // what it holds of `handle`'s connection, its commands
    fn commands_of(&self, connection_handle: &ConnectionHandle) -> Option<Commands> {
        locked(&self.inner.state)
            .connections
            .get(connection_handle)
            .map(|held| held.commands.clone())
    }
}

impl ServerTransport for WebSocketTransportServer {
    // a credential given here is not carried: nothing is toward a client, and the router fails a
    // command that presents one before it goes (decision 0032)
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        if let Some(commands) = self.commands_of(connection_handle) {
            commands.send(message.data);
        }

        Ok(Sent::Done)
    }

    // closed with 1000; settles once it ended, false when it held none by that handle
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        let Some(commands) = self.commands_of(connection_handle) else {
            return Box::pin(async { false });
        };

        commands.close(NORMAL);

        Box::pin(async move {
            commands.ended().await;

            true
        })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.inner.listeners.remove(listener);
    }

    // ! no lock held but its state's, never held as it tells a listener: what the socket holds
    // stays there, so TCP's window paces its peer
    fn pause(&self, connection_handle: &ConnectionHandle) {
        if let Some(commands) = self.commands_of(connection_handle) {
            commands.pause();
        }
    }

    fn resume(&self, connection_handle: &ConnectionHandle) {
        if let Some(commands) = self.commands_of(connection_handle) {
            commands.resume();
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    // as its application says of what stands in front of it, else by what it listens on
    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        let state = locked(&self.inner.state);

        state.connections.contains_key(connection_handle)
            && self
                .inner
                .settings
                .secure
                .unwrap_or_else(|| state.listens_on.as_deref().is_some_and(is_loopback))
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        let server = Arc::clone(&self.inner);

        self.inner.life.stop(move || server.stopping())
    }

    // what waits for each socket, all together and the most one holds, and the places upgrades
    // hold, the busiest address's among them, each under its ceiling
    fn gauges(&self) -> Option<Gauges> {
        let (unsent, handles, largest_address): (Vec<u64>, Vec<ConnectionHandle>, u64) = {
            let state = locked(&self.inner.state);

            (
                state
                    .connections
                    .values()
                    .map(|held| held.commands.unsent_bytes())
                    .collect(),
                state.connections.keys().cloned().collect(),
                state.per_address.values().copied().max().unwrap_or(0),
            )
        };
        let mut gauges = Gauges::default();

        gauges.counts.insert(
            "connections",
            u64::try_from(handles.len()).unwrap_or(u64::MAX),
        );
        gauges
            .counts
            .insert("largestAddressConnections", largest_address);
        gauges.counts.insert(
            "largestUnsentBytes",
            unsent.iter().copied().max().unwrap_or(0),
        );
        gauges.counts.insert(
            "unsentBytes",
            unsent.iter().copied().fold(0, u64::saturating_add),
        );
        gauges
            .ceilings
            .insert("connections", self.inner.settings.maximum_connections);
        gauges.ceilings.insert(
            "largestAddressConnections",
            self.inner.settings.maximum_per_address,
        );
        gauges.connection_handles.extend(handles);

        Some(gauges)
    }

    fn transport_type(&self) -> Option<&str> {
        Some(TRANSPORT_WEBSOCKET)
    }
}
