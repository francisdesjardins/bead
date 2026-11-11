//! A transport server over HTTP (spec 15.6, 15.12), as the other sides'
//! `createHTTPTransportServer` and `HttpTransportServer` serve it, on hyper's HTTP/1.1: a connection
//! it draws and keeps by a token, since HTTP keeps none, each exchange after its connect presenting
//! it, each `POST` carrying one envelope.

use core::fmt;
use core::future::poll_fn;
use core::pin::{Pin, pin};
use core::task::Poll;
use core::time::Duration;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use bytes::{Bytes, BytesMut};
use hyper::body::Body as _;
use hyper::body::Incoming;
use hyper::{Method, Request, Response, Version};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

use crate::base64url;
use crate::broker::participant::{BODY_GRACE_PERIOD, MINIMUM_BODY_BYTES_PER_SECOND};
use crate::clock::{Schedule, SharedClock, SystemClock, Timer};
use crate::duration::{NEVER, hold, hold_finite};
use crate::errors::ProgrammerError;
use crate::failure::ProcedureAddress;
use crate::http::exchange::{BodyBuffer, ExchangeState, Facts, Prefix, Responder};
use crate::http::fields::{
    AFTER_HEADER, CANCEL, CONNECTION_TOKEN_HEADER, End, FAILURE, FIRST_LAYOUT, HTTP_REFUSALS,
    LAST_LAYOUT, LISTEN_HEADER, REQUEST, RESULT, Request as Fields, WAIT_HEADER, busy, path_of,
    unknown_connection,
};
use crate::http::wire::{
    AnswerBody, Answered, Cut, Flow, Malformed, WireOptions, response_of, serve,
};
use crate::http_policy::HttpPolicy;
use crate::identity::procedures_taken_of;
use crate::judgement::hosts::{
    TakenOrigins, assert_hosts, assert_origins, credential_of, has_visible_fields,
    is_listed_origin, is_taken_host, is_taken_origin, is_visible_target, origin_of,
    own_authority_of,
};
use crate::judgement::proxies::{
    ClientAddressOptions, TrustedProxies, client_address_of, trusted_proxies_of,
};
use crate::judgement::security::is_loopback_host;
use crate::life::Life;
use crate::net::bounds::{
    HEADERS_TIMEOUT, MINIMUM_SEND_BYTES_PER_SECOND, SEND_GRACE_PERIOD, SendPace, SendPaceHooks,
    SendPaceOptions, dropped_of, hold_count, late_of,
};
use crate::net::listening::{Bound, Listening, accepting, bind};
use crate::net::tls::serving_config_of;
use crate::platform::{self, Handle};
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    Listeners, ReadyState, Sent, ServerListener, ServerTransport, TransportServerAddress,
    TransportServerClient, TransportServerRefusal, TransportServerStartOptions, tell_server,
};
use crate::{MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS};

#[cfg(test)]
mod tests;

/// The type every handle an HTTP transport server draws begins with (spec 15.1).
pub const TRANSPORT_HTTP: &str = "HTTP";

/// The bytes of body the exchanges under way may hold together, by default: 256 MiB.
pub const BODY_BYTES_BUDGET: u64 = 268_435_456;

/// The largest body by default: a router's largest envelope.
pub const MAXIMUM_BODY_BYTES: u64 = 16_778_240;

/// The requests one connection has waiting at once, by default.
pub const MAXIMUM_WAITING_EXCHANGES: u64 = 64;

/// The path the transport answers on, by default.
pub const PATHNAME: &str = "/bead";

/// How long a request handed on waits for its answer, by default: 5 minutes.
pub const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a connection may go with no exchange under way, by default: 5 minutes.
pub const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(300);

/// The bytes one connection's outbox holds, by default: two of the largest envelopes.
pub const MAXIMUM_OUTBOX_BYTES: u64 = 33_556_480;

/// The longest a listen waits for something to bring back, by default: 30 seconds, under the 60 an
/// intermediary such as nginx gives a request.
pub const MAXIMUM_WAIT: Duration = Duration::from_secs(30);

// the length before each envelope of a batch
const LENGTH_BYTES: usize = 4;

/// How long a cancel that came before its request buries that call id: 5 seconds, the least a
/// requester reserves one for. A request that comes later still runs, and its answer is dropped as
/// late by its requester.
const BURIAL: Duration = Duration::from_secs(5);

/// How long a request's head waits for its answer from its hand-off: 40 ms. An answer within them
/// goes whole, its head with it and its length in `content-length`; a request still unanswered
/// then gets its head alone, and its answer after it (spec 15.7). The exchange timeout counts from
/// the hand-off, those 40 ms within it.
const HEAD_DELAY: Duration = Duration::from_millis(40);

// a token: 16 bytes drawn from the system's random source, in base64url without padding, as a
// session's
const TOKEN_BYTES: usize = 16;
const TOKEN_LENGTH: usize = 22;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How an HTTP transport server is built (spec 15.6, 15.12).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpTransportServerOptions {
    /// The clock it stamps each connection's activity on and holds each body's rate by, which the
    /// layers above it run on too: the platform's when none. Its headers timeout and the pace its
    /// answers are held to run on the platform's clock, whatever it is given, since they bound
    /// what the platform's socket does (decision 0011).
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
    /// The procedures each of its connections takes, by their addresses (spec 9.11): a request to
    /// any other is answered as one to no resolver. Every procedure when none; none when empty.
    pub procedures: Option<Vec<ProcedureAddress>>,
    /// What it judges a request by first, given once to every listener of an application (spec
    /// 15.12, decision 0037): each member it gives is the option of its name, which is then given
    /// here no more.
    pub policy: Option<HttpPolicy>,
    /// The bytes of body the exchanges under way may hold together, past which an exchange is
    /// refused 503 `busy`: [`BODY_BYTES_BUDGET`] when none.
    pub body_bytes_budget: Option<u64>,
    /// How long a body comes, from its head, before its rate is held:
    /// [`crate::BODY_GRACE_PERIOD`] when none; never is refused.
    pub body_grace_period: Option<Duration>,
    /// How long a request handed on waits for its answer, from its hand-off, past which its
    /// connection is closed, as lost: [`EXCHANGE_TIMEOUT`] when none; [`crate::NEVER`] waits
    /// without end, arming no timer past its head's 40 ms.
    pub exchange_timeout: Option<Duration>,
    /// How long a request's head may take to come whole, past which it is answered 408:
    /// [`HEADERS_TIMEOUT`] when none; never is refused.
    pub headers_timeout: Option<Duration>,
    /// The hosts it takes besides those every server takes, the loopback's and its own (spec
    /// 15.12); `*` takes any. None when none.
    pub hosts: Option<Vec<String>>,
    /// How long a connection may go with no exchange under way, a listen among them, past which it
    /// is closed, as lost: [`INACTIVITY_TIMEOUT`] when none; [`crate::NEVER`] waits without end.
    pub inactivity_timeout: Option<Duration>,
    /// The largest body it reads, past which it refuses an exchange 413 `too-large`:
    /// [`MAXIMUM_BODY_BYTES`] when none.
    pub maximum_body_bytes: Option<u64>,
    /// The connections it holds at once, past which a connect is refused 503 `busy` (spec 15.12):
    /// [`MAXIMUM_CONNECTIONS`] when none.
    pub maximum_connections: Option<u64>,
    /// The connections one client address holds at once: [`MAXIMUM_CONNECTIONS_PER_ADDRESS`]
    /// when none.
    pub maximum_connections_per_address: Option<u64>,
    /// What one connection's outbox holds of what the server sent of its own, past which the
    /// connection is dropped, its client behind, and reported (spec 15.9):
    /// [`MAXIMUM_OUTBOX_BYTES`] when none.
    pub maximum_outbox_bytes: Option<u64>,
    /// The longest a listen waits for something to bring back, whatever its `bead-wait`:
    /// [`MAXIMUM_WAIT`] when none; never is refused.
    pub maximum_wait: Option<Duration>,
    /// The requests one connection has waiting at once, past which one is refused 429 `busy`, and
    /// half the exchanges it has under way at once: [`MAXIMUM_WAITING_EXCHANGES`] when none.
    pub maximum_waiting_exchanges: Option<u64>,
    /// The slowest, in bytes a second, a body may come once its grace passed, past which it is
    /// refused 408 `too-slow` (spec 15.12): [`crate::MINIMUM_BODY_BYTES_PER_SECOND`] when none.
    pub minimum_body_bytes_per_second: Option<u64>,
    /// The slowest, in bytes a second, a socket may take an answer once its grace passed, past
    /// which its exchange is lost and its connection dropped and reported (spec 15.12):
    /// [`MINIMUM_SEND_BYTES_PER_SECOND`] when none; 0 holds none.
    pub minimum_send_bytes_per_second: Option<u64>,
    /// The origins it answers, and answers CORS to, besides its own (spec 15.12). None when none.
    pub origins: Option<Vec<String>>,
    /// The path it answers on: [`PATHNAME`] when none.
    pub pathname: Option<String>,
    /// Whether its connections stay off the machine's clear, as its application says of what
    /// stands in front of it (spec 13.4): by the address it listens on when none, the loopback
    /// secure and any other not.
    pub secure: Option<bool>,
    /// The least time an answer is given to be taken by its socket: [`SEND_GRACE_PERIOD`] when
    /// none; never is refused.
    pub send_grace_period: Option<Duration>,
    /// The proxies whose `X-Forwarded-For` it believes, each an IP address or a network in CIDR
    /// (spec 15.12): a connection and a refusal name the client's address the walk reaches. None
    /// trusts no proxy, the loopback among them.
    pub trusted_proxies: Option<Vec<String>>,
    /// The proxies on every path to it that `trusted_proxies` does not name, 8 at most: 0 when
    /// none.
    pub unnamed_proxies: Option<u64>,
    /// The TLS it serves under, the application's config, its certificate and key among it: it
    /// serves a copy that offers HTTP/2, then HTTP/1.1, by ALPN (RFC 7301), both on one port, and
    /// each of its connections is secure (spec 13.4) but where `secure` says otherwise. In clear when
    /// none, HTTP/1.1 alone.
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

// a member given in the policy and beside it, refused, so that a listener never takes one value of
// two in silence
fn given_once<T: Clone>(
    name: &str,
    (beside, in_policy): (Option<&T>, Option<T>),
) -> Result<Option<T>, ProgrammerError> {
    match (beside, in_policy) {
        (Some(_), Some(_)) => Err(ProgrammerError::new(format!(
            "{name} is given in the policy and beside it: give it once"
        ))),
        (Some(beside), None) => Ok(Some(beside.clone())),
        (None, in_policy) => Ok(in_policy),
    }
}

impl HttpTransportServerOptions {
    /// Its policy's members in their places, each given once, there or beside it, the policy gone.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] naming a member given both in its policy and beside it.
    pub(crate) fn with_policy(&self) -> Result<Self, ProgrammerError> {
        let Some(policy) = &self.policy else {
            return Ok(self.clone());
        };

        Ok(Self {
            policy: None,
            body_bytes_budget: given_once(
                "bodyBytesBudget",
                (self.body_bytes_budget.as_ref(), policy.body_bytes_budget()),
            )?,
            body_grace_period: given_once(
                "bodyGracePeriod",
                (self.body_grace_period.as_ref(), policy.body_grace_period()),
            )?,
            headers_timeout: given_once(
                "headersTimeout",
                (self.headers_timeout.as_ref(), policy.headers_timeout()),
            )?,
            hosts: given_once(
                "hosts",
                (self.hosts.as_ref(), policy.hosts().map(<[String]>::to_vec)),
            )?,
            maximum_body_bytes: given_once(
                "maximumBodyBytes",
                (
                    self.maximum_body_bytes.as_ref(),
                    policy.maximum_body_bytes(),
                ),
            )?,
            maximum_connections: given_once(
                "maximumConnections",
                (
                    self.maximum_connections.as_ref(),
                    policy.maximum_connections(),
                ),
            )?,
            maximum_connections_per_address: given_once(
                "maximumConnectionsPerAddress",
                (
                    self.maximum_connections_per_address.as_ref(),
                    policy.maximum_connections_per_address(),
                ),
            )?,
            minimum_body_bytes_per_second: given_once(
                "minimumBodyBytesPerSecond",
                (
                    self.minimum_body_bytes_per_second.as_ref(),
                    policy.minimum_body_bytes_per_second(),
                ),
            )?,
            minimum_send_bytes_per_second: given_once(
                "minimumSendBytesPerSecond",
                (
                    self.minimum_send_bytes_per_second.as_ref(),
                    policy.minimum_send_bytes_per_second(),
                ),
            )?,
            origins: given_once(
                "origins",
                (
                    self.origins.as_ref(),
                    policy.origins().map(<[String]>::to_vec),
                ),
            )?,
            send_grace_period: given_once(
                "sendGracePeriod",
                (self.send_grace_period.as_ref(), policy.send_grace_period()),
            )?,
            trusted_proxies: given_once(
                "trustedProxies",
                (
                    self.trusted_proxies.as_ref(),
                    policy.trusted_proxies().map(<[String]>::to_vec),
                ),
            )?,
            unnamed_proxies: given_once(
                "unnamedProxies",
                (self.unnamed_proxies.as_ref(), policy.unnamed_proxies()),
            )?,
            ..self.clone()
        })
    }
}

// what it was built with, held
#[derive(Debug)]
struct Settings {
    headers_timeout: Duration,
    hosts: Vec<String>,
    origins: Vec<String>,
    maximum_connections: u64,
    maximum_per_address: u64,
    secure: Option<bool>,
    pace: SendPaceOptions,
    // the procedures a connection takes, every one when none
    procedures: Option<BTreeSet<ProcedureAddress>>,
    proxies: TrustedProxies,
    // the config it serves under, ALPN's protocols Bead's; in clear when none
    tls: Option<Arc<rustls::ServerConfig>>,
    body_bytes_budget: u64,
    body_grace_period: Duration,
    maximum_body_bytes: u64,
    maximum_waiting_exchanges: u64,
    minimum_body_bytes_per_second: u64,
    pathname: String,
    exchange_timeout: Duration,
    inactivity_timeout: Duration,
    maximum_outbox_bytes: u64,
    maximum_wait: Duration,
}

// what a connection's gate holds while its router paused it, or while it holds anything: the
// exchanges read whole, in order (spec 15.12)
#[derive(Debug, Default)]
struct Gate {
    is_paused: bool,
    held: VecDeque<u64>,
}

// a connection it drew, which nothing outside the transport reaches: what its registry holds for
// it, as a socket transport's holds its socket
#[derive(Default)]
struct Drawn {
    address: String,
    port: u16,
    token: String,
    arrival: u64,
    // its client said at connect that it listens
    is_listening: bool,
    // the exchanges under way, whatever they carry
    open: u64,
    // the call ids of the client's a cancel came for before their request, each until it lapses
    buried: HashMap<u32, Arc<dyn Timer>>,
    // the exchanges of requests, by call id, from their first 8 bytes to their answer
    waiting: HashMap<u32, u64>,
    last_activity: Option<SystemTime>,
    gate: Gate,
    // its timer while no exchange is under way
    idle: Option<Arc<dyn Timer>>,
    // the listen held, when one is
    listen: Option<u64>,
    // what the server sent of its own and no listen acknowledged yet, in order, each numbered
    outbox: VecDeque<(u64, Bytes)>,
    outbox_bytes: u64,
    // the number of the last envelope put in its outbox; the first is 1
    sequence: u64,
}

// a listen held until something comes for it, or its wait is over
struct Listen {
    connection: ConnectionHandle,
    responder: Responder,
    timer: Option<Arc<dyn Timer>>,
    flow: Arc<Flow>,
    // whether hyper took its batch, which its pace reads
    taken: Arc<AtomicBool>,
}

// what a listen's future holds of it until its head: a future dropped first ends its listen
struct ListenGuard {
    server: Weak<ServerInner>,
    id: u64,
    is_open: bool,
}

impl Drop for ListenGuard {
    fn drop(&mut self) {
        if self.is_open
            && let Some(inner) = self.server.upgrade()
        {
            inner.listen_closed(self.id);
        }
    }
}

#[derive(Default)]
struct ServerState {
    drawn: HashMap<ConnectionHandle, Drawn>,
    by_token: HashMap<String, ConnectionHandle>,
    // the connections each address holds; an address that holds none is not kept
    per_address: HashMap<String, u64>,
    exchanges: HashMap<u64, ExchangeState>,
    // the listens under way, each until its response closes
    listens: HashMap<u64, Listen>,
    next_exchange: u64,
    // the rank of the last connection drawn, across its starts: no handle is given twice
    ordinal: u64,
    // the bytes of body the exchanges under way hold, all together, counted as they come
    body_bytes: u64,
    listening: Vec<Listening>,
    // each socket it serves, until its end
    flows: HashMap<u64, Arc<Flow>>,
    next_flow: u64,
    // what it listens on, which says whether it is secure
    listens_on: Option<String>,
}

// how an exchange is answered: the origin its answers name, `origins`' own, and its socket's flow
struct Answering {
    listed: Option<String>,
    flow: Arc<Flow>,
}

impl Answering {
    const fn of(listed: Option<String>, flow: Arc<Flow>) -> Self {
        Self { listed, flow }
    }
}

// an exchange of one envelope, as its body is read: what it tells of its request, how it is
// answered, its `Authorization` lines, and the length it declares
struct Receiving {
    facts: Facts,
    answering: Answering,
    authorizations: Vec<String>,
    declared: Option<u64>,
}

// what it tells once its state is let go, in order
enum Told {
    Connection(ConnectionHandle),
    Message(TransportMessage, ConnectionHandle),
    Close(bool, ConnectionHandle),
    Refusal(TransportServerRefusal),
    Listen(bool, ConnectionHandle),
    // a connection dropped behind a bound: its error, then its close, unclean, told all the same
    Dropped(RouterError, ConnectionHandle),
}

pub(crate) struct ServerInner {
    me: Weak<Self>,
    runtime: Handle,
    // the platform's clock, which its timers that bound the platform's socket run on
    platform: SharedClock,
    // the clock it stamps and times bodies on, and the one it was given
    clock: SharedClock,
    given: Option<SharedClock>,
    settings: Settings,
    life: Life,
    state: Mutex<ServerState>,
    listeners: Listeners<dyn ServerListener>,
}

/// A transport server over HTTP, which keeps no connection and so draws one.
///
/// A `POST` with no body and no token connects: the server draws a 16-byte connection token from
/// the system's random source, tells `on_connection`, and answers 201 with it in
/// `bead-connection-token`; each exchange after presents the token, and a `DELETE` ends the
/// connection. The router, the sessions and the relays see a connection, as over a socket; the
/// token, a secret, enters no handle, event or report.
///
/// Each `POST` carries one envelope, of type `application/prs.bead`. The transport reads its
/// layout, kind and call id, and nothing else: a request's exchange waits under its call id — from
/// its first 8 bytes — for the answer the router sends on it: one within 40 ms of its hand-off goes
/// whole, and a request still unanswered then gets its head alone, so its requester knows the
/// router has it; any other envelope is handed on and its exchange ends 204. A request is handed
/// on with its credential, the `Authorization` field of its `POST` as it came, trimmed, and none
/// when the field is empty or absent; no other exchange's is read, and a `POST` with two is refused
/// 400. An answer carries none. A cancel ends the exchange of its call; one that comes before its
/// request buries that call id for 5 seconds. Each refusal of the transport's own is marked in
/// `bead-refusal`, and told on `on_refusal`. To a page of an origin `origins` names, it answers
/// CORS (spec 15.12): its preflight 204, and every answer once its origin is judged naming it and
/// exposing every field, no credential allowed. An exchange lost — its response closed before the
/// transport ended it — closes the connection, as a socket that drops does; so do a request
/// unanswered past `exchange_timeout`, counted from its hand-off, and a connection idle past
/// `inactivity_timeout`, on its clock.
///
/// What the server sends of its own reaches a client that said at connect that it listens —
/// `bead-listen: ?1`, which the 201 says back (spec 15.9). It waits in the connection's outbox,
/// numbered, until a listen — a `GET` with the token, its `bead-after` and `bead-wait` — brings back
/// all that waits, in a batch of `application/prs.bead-batch`, the number of its first in
/// `bead-sequence`; the next listen acknowledges by `bead-after` what its client heard whole, and
/// what it did not comes again. A listen waits up to `bead-wait` milliseconds, 0 when left out, no
/// longer than `maximum_wait`, for something to bring back; a second takes the first's place. Each
/// listen held, once past its refusals, is told on `on_listen` held, and its end, while its
/// connection stands, not held. An outbox past `maximum_outbox_bytes` drops its connection,
/// reported on `on_error`. A connection whose client does not listen carries answers alone:
/// anything else is refused as it is sent.
///
/// A body is read to `maximum_body_bytes`, at `minimum_body_bytes_per_second` once
/// `body_grace_period` passed, refused 413 `too-large` past the one and 408 `too-slow` behind the
/// other, and charged to `body_bytes_budget` with every body under way. An answer written before
/// its request's body is whole says `connection: close`, and its socket closes in stages. A head
/// that does not come whole within `headers_timeout`, on the platform's clock, is answered 408,
/// unmarked; a connection kept alive that goes idle that long is let go.
///
/// A connection its router paused hands on nothing (spec 15.12): each envelope read whole waits at
/// its gate, in order, its body still charged, its request's head and any other's 204 going once
/// it is handed on, as its router resumes it. An answer is held to `minimum_send_bytes_per_second`
/// past `send_grace_period`: one its socket holds past its deadline is lost, its connection
/// dropped and reported on `on_error` naming the bound.
///
/// Its stop closes each connection, unclean: each exchange still waiting is told by the marked 404
/// until its request is handed on, then cut past its head, and each listen held is answered the
/// marked 404; an exchange that comes as it stops learns its connection is gone, and a connect is
/// refused 503 `busy`.
#[derive(Clone)]
pub struct HttpTransportServer {
    inner: Arc<ServerInner>,
}

impl fmt::Debug for HttpTransportServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpTransportServer")
            .field("ready_state", &self.inner.life.ready_state())
            .finish_non_exhaustive()
    }
}

// a token drawn from the system's random source; none where it gives none
fn draw_token() -> Option<String> {
    let mut bytes = [0_u8; TOKEN_BYTES];

    getrandom::fill(&mut bytes).ok()?;

    Some(base64url::encode(&bytes))
}

// whether a token is of the form the server draws
fn is_token(token: &str) -> bool {
    token.len() == TOKEN_LENGTH
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

// what HTTP refuses of its own (RFC 9112 §3.2, §3.2.2; RFC 9110 §5.5), as HTTP answers it,
// unmarked, with none of the path's fields; over HTTP/2, its stream reset, `PROTOCOL_ERROR`,
// nothing written (RFC 9113 §8.1.1)
fn malformed(flow: &Arc<Flow>) -> Response<AnswerBody> {
    let mut response = response_of(
        400,
        (
            &[
                ("connection", "close".to_owned()),
                ("content-length", "0".to_owned()),
            ],
            AnswerBody::whole(None).settling(flow),
        ),
    );

    response.extensions_mut().insert(Malformed);

    response
}

// an exchange the server answers at once, its head ready
fn ready(response: Response<AnswerBody>) -> Answered {
    Box::pin(async move { Ok(response) })
}

// the client's port, as a refusal and a connection tell it
const fn port_of(peer: SocketAddr) -> u16 {
    peer.port()
}

// ends an exchange the transport answers itself, telling a refusal once written (spec 15.1); over
// HTTP/1, a refusal of a body it will not read closes its socket in stages, lest the rest read as
// the next request
fn finish((facts, responder): (&Facts, &mut Responder), end: &End) -> Vec<Told> {
    let is_closing = end.status >= 400 && facts.is_http1 && facts.has_body;

    if is_closing {
        responder.end_closing(end);
    } else {
        responder.end(end);
    }

    facts
        .refusal_of(end)
        .map(Told::Refusal)
        .into_iter()
        .collect()
}

// what an exchange's future holds of it until it is done: its request and its response, each
// told done once, a future dropped before either ends its exchange as lost
struct Guard {
    server: Weak<ServerInner>,
    id: u64,
    is_request_open: bool,
    is_response_open: bool,
}

impl Guard {
    fn request_done(&mut self) {
        if core::mem::take(&mut self.is_request_open)
            && let Some(inner) = self.server.upgrade()
        {
            inner.request_done(self.id);
        }
    }

    // the head hyper is given: once it has one, its body tells its end
    fn answered(
        &mut self,
        head: Result<Response<AnswerBody>, oneshot::error::RecvError>,
    ) -> Result<Response<AnswerBody>, Cut> {
        let response = head.map_err(|_dropped| Cut)?;

        self.is_response_open = false;

        Ok(response)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.request_done();

        if core::mem::take(&mut self.is_response_open)
            && let Some(inner) = self.server.upgrade()
        {
            inner.response_closed(self.id, false);
        }
    }
}

impl ServerInner {
    fn tell(&self, told: Vec<Told>) {
        for each in told {
            match each {
                Told::Connection(handle) => tell_server(
                    &self.listeners,
                    (
                        |listener: &dyn ServerListener| listener.on_connection(&handle),
                        Some(&handle),
                    ),
                ),
                Told::Message(message, handle) => tell_server(
                    &self.listeners,
                    (
                        |listener: &dyn ServerListener| {
                            listener.on_message(message.clone(), &handle);
                        },
                        Some(&handle),
                    ),
                ),
                Told::Close(is_clean, handle) => tell_server(
                    &self.listeners,
                    (
                        |listener: &dyn ServerListener| listener.on_close(is_clean, &handle),
                        Some(&handle),
                    ),
                ),
                Told::Listen(is_held, handle) => tell_server(
                    &self.listeners,
                    (
                        |listener: &dyn ServerListener| listener.on_listen(is_held, &handle),
                        Some(&handle),
                    ),
                ),
                Told::Refusal(refusal) => tell_server(
                    &self.listeners,
                    (
                        |listener: &dyn ServerListener| listener.on_refusal(&refusal),
                        None,
                    ),
                ),
                Told::Dropped(error, handle) => {
                    self.report((&error, Some(&handle)));
                    tell_server(
                        &self.listeners,
                        (
                            |listener: &dyn ServerListener| listener.on_close(false, &handle),
                            Some(&handle),
                        ),
                    );
                }
            }
        }
    }

    // what it reports of its own, with the connection it came on
    fn report(&self, (error, connection_handle): (&RouterError, Option<&ConnectionHandle>)) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics would loop: its panic is dropped (spec 15.1)
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
        let Bound { listeners, address } = bind(&self.runtime, options)?;
        let listening: Vec<Listening> = listeners
            .into_iter()
            .map(|listener| {
                let server = Weak::clone(&self.me);

                accepting(
                    &self.runtime,
                    (listener, move |accepted, _serving: &Arc<AtomicBool>| {
                        let Some(inner) = server.upgrade() else {
                            return false;
                        };
                        let runtime = inner.runtime.clone();

                        drop(platform::spawn(&runtime, inner.serve(accepted)));

                        true
                    }),
                )
            })
            .collect();
        let mut state = locked(&self.state);

        state.listening.extend(listening);
        state.listens_on = Some(address.address.clone());
        drop(state);

        Ok(address)
    }

    // serves one socket accepted, each of its requests an exchange, until it ends
    async fn serve(self: Arc<Self>, (socket, peer): (TcpStream, SocketAddr)) {
        let flow = Arc::new(Flow::default());
        let key = {
            let mut state = locked(&self.state);

            state.next_flow = state.next_flow.saturating_add(1);

            let key = state.next_flow;

            state.flows.insert(key, Arc::clone(&flow));
            key
        };

        // ! a socket accepted as its stop began is let go with the others
        if self.life.ready_state() != ReadyState::Open {
            flow.stop();
        }

        let server = Weak::clone(&self.me);
        let options = WireOptions {
            runtime: self.runtime.clone(),
            platform: Arc::clone(&self.platform),
            headers_timeout: self.settings.headers_timeout,
            tls: self.settings.tls.clone(),
        };

        serve(
            (socket, flow),
            (
                options,
                move |request: Request<Incoming>, flow: &Arc<Flow>| match server.upgrade() {
                    Some(inner) => inner.exchange((request, Arc::clone(flow)), peer),
                    None => Box::pin(async { Err(Cut) }),
                },
            ),
        )
        .await;

        locked(&self.state).flows.remove(&key);
    }

    // the client's address: the socket's, in the one form, or, behind the proxies it names and
    // counts, the `X-Forwarded-For` entry the walk reaches (spec 15.12)
    fn address_of(&self, (request, peer): (&Fields<'_>, SocketAddr)) -> String {
        let forwarded = request.lines_of("x-forwarded-for").join(", ");

        client_address_of(
            &peer.ip().to_string(),
            &ClientAddressOptions {
                forwarded: (!forwarded.is_empty()).then_some(forwarded.as_str()),
                trusted_proxies: Some(&self.settings.proxies),
            },
        )
    }

    // an exchange judged at once, before any of its body: its head and its tellings
    fn finished(&self, (facts, answering): (&Facts, Answering), end: &End) -> Answered {
        let (head, answered) = oneshot::channel();
        let mut responder = Responder::new(head, (answering.listed, answering.flow));
        let told = finish((facts, &mut responder), end);

        self.tell(told);

        Box::pin(async move { answered.await.map_err(|_dropped| Cut) })
    }

    // one exchange: judged in spec 15.6's order, then answered, or its body read and handed on
    fn exchange(
        self: Arc<Self>,
        (request, flow): (Request<Incoming>, Arc<Flow>),
        peer: SocketAddr,
    ) -> Answered {
        let (parts, body) = request.into_parts();

        self.judge((&parts, Some(body)), (flow, peer))
    }

    // an exchange of `parts` judged, its body read where it is one to read; a body none gives
    // stands for one ended already
    fn judge(
        self: Arc<Self>,
        (parts, body): (&::http::request::Parts, Option<Incoming>),
        (flow, peer): (Arc<Flow>, SocketAddr),
    ) -> Answered {
        let fields = Fields {
            is_http1: parts.version < Version::HTTP_2,
            is_http11: parts.version == Version::HTTP_11,
            method: &parts.method,
            uri: &parts.uri,
            headers: &parts.headers,
        };
        let target = fields.target();

        // * a field or a target past visible ASCII before anything else, as HTTP answers it
        let is_visible = fields
            .raw_fields()
            .is_some_and(|raw| has_visible_fields(&raw))
            && is_visible_target(Some(&target));
        let Some(authority) = is_visible.then(|| fields.authority(&target)).flatten() else {
            return ready(malformed(&flow));
        };
        let authority = authority.authority.map(str::to_owned);
        let facts = Facts {
            address: Some(self.address_of((&fields, peer))),
            port: port_of(peer),
            authority: authority.clone(),
            origin: origin_of(&fields.lines_of("origin")),
            is_http1: fields.is_http1,
            has_body: fields.has_body(),
        };
        let hosts = &self.settings.hosts;

        if !is_taken_host(authority.as_deref(), hosts) {
            return self.finished(
                (&facts, Answering::of(None, flow)),
                &End::refused(403, HTTP_REFUSALS.host),
            );
        }

        if path_of(&target) != Some(self.settings.pathname.as_str()) {
            return self.finished(
                (&facts, Answering::of(None, flow)),
                &End::refused(404, HTTP_REFUSALS.path),
            );
        }

        // an exchange from the server's own origin, by a host it takes by name, or one it was
        // told; one with no `Origin` comes from anywhere
        let origin = fields.header_of("origin");
        let origins = &self.settings.origins;

        if !is_taken_origin(
            origin,
            &TakenOrigins::new(own_authority_of(authority.as_deref(), hosts), origins),
        ) {
            return self.finished(
                (&facts, Answering::of(None, flow)),
                &End::refused(403, HTTP_REFUSALS.origin),
            );
        }

        // * every answer a page `origins` names can read carries it, a refusal's too, which its
        // client reads; one judged before the origin answers a preflight no browser reads
        let listed = is_listed_origin(origin, origins)
            .then(|| origin.map(str::to_owned))
            .flatten();

        self.on_path((&fields, facts), (body, Answering::of(listed, flow)))
    }

    // an exchange on its path, from a host and an origin it takes: a preflight, a connect, or an
    // exchange on a connection, by its method and its token
    fn on_path(
        self: Arc<Self>,
        (fields, facts): (&Fields<'_>, Facts),
        (body, answering): (Option<Incoming>, Answering),
    ) -> Answered {
        let Answering { listed, flow } = answering;
        let method = fields.method;

        // a preflight is no refusal: nothing tells it
        if listed.is_some()
            && method == Method::OPTIONS
            && fields.header_of("access-control-request-method").is_some()
        {
            let (head, answered) = oneshot::channel();

            Responder::new(head, (listed, flow)).end(&fields.preflight());

            return Box::pin(async move { answered.await.map_err(|_dropped| Cut) });
        }

        if method != Method::GET && method != Method::POST && method != Method::DELETE {
            let refused = End::refused(405, HTTP_REFUSALS.method)
                .with(("allow", "GET, POST, DELETE".to_owned()));

            return self.finished((&facts, Answering::of(listed, flow)), &refused);
        }

        let token = fields.header_of(CONNECTION_TOKEN_HEADER);

        if token.is_none() && method == Method::POST {
            if !fields.is_bead_body() {
                return self.finished(
                    (&facts, Answering::of(listed, flow)),
                    &End::refused(415, HTTP_REFUSALS.type_refused),
                );
            }

            return self.connect((fields, &facts), Answering::of(listed, flow));
        }

        let Some(token) = token.filter(|token| is_token(token)) else {
            return self.finished(
                (&facts, Answering::of(listed, flow)),
                &End::refused(400, HTTP_REFUSALS.malformed),
            );
        };
        // none is held once a stop began: an exchange learns its connection is gone, as the
        // stop's close would tell it, nothing of it handed on
        let handle = (self.life.ready_state() == ReadyState::Open)
            .then(|| locked(&self.state).by_token.get(token).cloned())
            .flatten();
        let Some(handle) = handle else {
            return self.finished((&facts, Answering::of(listed, flow)), &unknown_connection());
        };

        if method == Method::DELETE {
            self.close_drawn(&handle, true);

            return self.finished((&facts, Answering::of(listed, flow)), &End::of(204));
        }

        if method == Method::GET {
            return self.listen_on(&handle, ((fields, &facts), Answering::of(listed, flow)));
        }

        if !fields.is_bead_body() {
            return self.finished(
                (&facts, Answering::of(listed, flow)),
                &End::refused(415, HTTP_REFUSALS.type_refused),
            );
        }

        let authorizations: Vec<String> = fields
            .lines_of("authorization")
            .into_iter()
            .map(str::to_owned)
            .collect();
        let declared = fields.declared_length();

        self.receive(
            (body, &handle),
            Receiving {
                facts,
                answering: Answering::of(listed, flow),
                authorizations,
                declared,
            },
        )
    }

    // a listen: what it acknowledges goes, and it brings back what is left — at once, or once
    // something comes within its wait. One listen at a time: a second ends the first, empty, and
    // takes its place. A listen its client loses closes nothing: what it carried comes again
    fn listen_on(
        self: Arc<Self>,
        handle: &ConnectionHandle,
        ((fields, facts), answering): ((&Fields<'_>, &Facts), Answering),
    ) -> Answered {
        let after = fields.count_of((AFTER_HEADER, true));
        let wait = fields.count_of((WAIT_HEADER, false));
        let Answering { listed, flow } = answering;
        let mut state = locked(&self.state);
        let Some(drawn) = state.drawn.get_mut(handle) else {
            drop(state);

            return self.finished((facts, Answering::of(listed, flow)), &unknown_connection());
        };

        if !drawn.is_listening {
            drop(state);

            return self.finished(
                (facts, Answering::of(listed, flow)),
                &End::refused(409, HTTP_REFUSALS.listen_undeclared),
            );
        }

        let asked = after
            .zip(wait)
            .filter(|(after, _)| !facts.has_body && *after <= drawn.sequence);
        let Some((after, wait)) = asked else {
            drop(state);

            return self.finished(
                (facts, Answering::of(listed, flow)),
                &End::refused(400, HTTP_REFUSALS.malformed),
            );
        };

        // what it acknowledges goes
        drawn.outbox.retain(|(sequence, _)| *sequence > after);
        drawn.outbox_bytes = drawn
            .outbox
            .iter()
            .map(|(_, bytes)| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .fold(0, u64::saturating_add);
        drawn.open = drawn.open.saturating_add(1);
        drawn.last_activity = Some(self.clock.wall());

        if let Some(idle) = drawn.idle.take() {
            idle.cancel();
        }

        let replaced = drawn.listen.take();
        let is_brought = !drawn.outbox.is_empty() || wait == 0;

        state.next_exchange = state.next_exchange.saturating_add(1);

        let id = state.next_exchange;
        let (head, answered) = oneshot::channel();
        let server = Weak::clone(&self.me);
        let runtime = self.runtime.clone();
        let responder =
            Responder::new(head, (listed, Arc::clone(&flow))).telling(Box::new(move |_| {
                // ! told from a turn of its own, as an exchange's end is
                drop(platform::spawn(&runtime, async move {
                    if let Some(inner) = server.upgrade() {
                        inner.listen_closed(id);
                    }
                }));
            }));

        state.listens.insert(
            id,
            Listen {
                connection: Arc::clone(handle),
                responder,
                timer: None,
                flow,
                taken: Arc::new(AtomicBool::new(false)),
            },
        );

        if let Some(replaced) = replaced {
            self.answer_listen((&mut state, replaced), &End::of(204));
        }

        if is_brought {
            self.answer_listen((&mut state, id), &End::of(204));
        } else {
            self.hold_listen((&mut state, id), (handle, wait));
        }

        drop(state);
        // said before the listen it replaces ends, so a second keeps its connection held
        // throughout
        self.tell(vec![Told::Listen(true, Arc::clone(handle))]);

        let guard = ListenGuard {
            server: Weak::clone(&self.me),
            id,
            is_open: true,
        };

        Box::pin(async move {
            // * the guard whole, never its field alone, goes with the future
            let mut guard = guard;
            let head = answered.await.map_err(|_dropped| Cut)?;

            guard.is_open = false;

            Ok(head)
        })
    }

    // a listen held for what comes within its wait, no longer than its limit
    fn hold_listen(
        &self,
        (state, id): (&mut ServerState, u64),
        (handle, wait): (&ConnectionHandle, u64),
    ) {
        if let Some(drawn) = state.drawn.get_mut(handle) {
            drawn.listen = Some(id);
        }

        let server = Weak::clone(&self.me);
        let armed = self.clock.arm(
            Schedule::Once(Duration::from_millis(wait).min(self.settings.maximum_wait)),
            Box::new(move || {
                if let Some(inner) = server.upgrade() {
                    let mut state = locked(&inner.state);

                    inner.answer_listen((&mut state, id), &End::of(204));
                    drop(state);
                }
            }),
        );

        if let Some(listen) = state.listens.get_mut(&id) {
            listen.timer = armed.ok();
        }
    }

    // a listen ends: with what waits for it, as a batch, or, nothing waiting, with `end`; once
    fn answer_listen(&self, (state, id): (&mut ServerState, u64), end: &End) {
        let Some(listen) = state.listens.get_mut(&id) else {
            return;
        };

        if let Some(timer) = listen.timer.take() {
            timer.cancel();
        }

        let connection = Arc::clone(&listen.connection);
        let drawn = state.drawn.get_mut(&connection);
        let waiting = drawn.map(|drawn| {
            if drawn.listen == Some(id) {
                drawn.listen = None;
            }

            let first = drawn
                .sequence
                .saturating_sub(u64::try_from(drawn.outbox.len()).unwrap_or(u64::MAX))
                .saturating_add(1);
            let mut batch = BytesMut::new();

            // what waits follows what was acknowledged, one by one, each after its length
            for (_, bytes) in &drawn.outbox {
                batch.extend_from_slice(
                    &u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes(),
                );
                batch.extend_from_slice(bytes);
            }

            (batch.freeze(), first)
        });
        let Some(listen) = state.listens.get_mut(&id) else {
            return;
        };

        match waiting.filter(|(batch, _)| batch.len() >= LENGTH_BYTES) {
            None => listen.responder.end(end),
            Some((batch, first)) => {
                let length = u64::try_from(batch.len()).unwrap_or(u64::MAX);
                let flow = Arc::clone(&listen.flow);
                let taken = Arc::clone(&listen.taken);

                listen.responder.batch((batch, first));
                // ! held to its pace: one past its deadline is an answer that could not be
                // written, which drops its connection at both ends (spec 15.7, 15.12)
                self.pace((connection, flow), (length, taken));
            }
        }
    }

    // a listen's response closed, its listen done: its connection rests once nothing else is
    // under way, and tells its end while it stands
    fn listen_closed(&self, id: u64) {
        let mut state = locked(&self.state);
        let Some(listen) = state.listens.remove(&id) else {
            return;
        };

        if let Some(timer) = &listen.timer {
            timer.cancel();
        }

        listen.taken.store(true, Ordering::SeqCst);

        let connection = listen.connection;
        let Some(drawn) = state.drawn.get_mut(&connection) else {
            return;
        };

        if drawn.listen == Some(id) {
            drawn.listen = None;
        }

        drawn.open = drawn.open.saturating_sub(1);
        self.rest((&mut state, &connection));
        drop(state);
        self.tell(vec![Told::Listen(false, connection)]);
    }

    // an envelope of the server's own waits in its connection's outbox, numbered, for a listen to
    // bring it back; past the outbox's bound the connection is dropped, its client behind (spec
    // 15.9): false then
    fn enqueue(
        &self,
        (state, handle): (&mut ServerState, &ConnectionHandle),
        bytes: Bytes,
    ) -> bool {
        let maximum = self.settings.maximum_outbox_bytes;
        let Some(drawn) = state.drawn.get_mut(handle) else {
            return true;
        };
        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

        if drawn.outbox_bytes.saturating_add(length) > maximum {
            return false;
        }

        drawn.sequence = drawn.sequence.saturating_add(1);
        drawn.outbox.push_back((drawn.sequence, bytes));
        drawn.outbox_bytes = drawn.outbox_bytes.saturating_add(length);

        if let Some(id) = drawn.listen {
            self.answer_listen((state, id), &End::of(204));
        }

        true
    }

    // a connection idle — no exchange under way — closes past its timeout, as lost
    fn rest(&self, (state, handle): (&mut ServerState, &ConnectionHandle)) {
        let Some(drawn) = state.drawn.get_mut(handle) else {
            return;
        };

        if let Some(idle) = drawn.idle.take() {
            idle.cancel();
        }

        if self.settings.inactivity_timeout == NEVER || drawn.open > 0 {
            return;
        }

        let server = Weak::clone(&self.me);
        let resting = Arc::clone(handle);
        let armed = self.clock.arm(
            Schedule::Once(self.settings.inactivity_timeout),
            Box::new(move || {
                if let Some(inner) = server.upgrade() {
                    inner.close_drawn(&resting, false);
                }
            }),
        );

        drawn.idle = armed.ok();
    }

    // a connect: a connection drawn, its token said back in a 201
    fn connect(&self, (fields, facts): (&Fields<'_>, &Facts), answering: Answering) -> Answered {
        let Answering { listed, flow } = answering;
        let address = facts.address.clone().unwrap_or_default();
        let is_listening = fields.listening();

        // a connect carries no body, and says whether it listens in the one way
        let Some(is_listening) = is_listening.filter(|_| !facts.has_body) else {
            return self.finished(
                (facts, Answering::of(listed, flow)),
                &End::refused(400, HTTP_REFUSALS.malformed),
            );
        };
        let drawn = {
            let mut state = locked(&self.state);
            let of_address = state.per_address.get(&address).copied().unwrap_or(0);
            let is_full = u64::try_from(state.drawn.len()).unwrap_or(u64::MAX)
                >= self.settings.maximum_connections
                || of_address >= self.settings.maximum_per_address;

            // none is drawn once a stop began, as none past the bounds
            let drawn = if is_full || self.life.ready_state() != ReadyState::Open {
                None
            } else {
                draw_token().map(|token| {
                    state.ordinal = state.ordinal.saturating_add(1);

                    let arrival = state.ordinal;
                    let handle: ConnectionHandle = Arc::from(format!(
                        "type={TRANSPORT_HTTP};ip={address};ordinal={arrival}"
                    ));

                    state.drawn.insert(
                        Arc::clone(&handle),
                        Drawn {
                            address: address.clone(),
                            port: facts.port,
                            token: token.clone(),
                            arrival,
                            is_listening,
                            ..Drawn::default()
                        },
                    );
                    self.rest((&mut state, &handle));
                    state.by_token.insert(token.clone(), Arc::clone(&handle));
                    state
                        .per_address
                        .insert(address.clone(), of_address.saturating_add(1));

                    (handle, token)
                })
            };

            drop(state);
            drawn
        };
        let Some((handle, token)) = drawn else {
            return self.finished((facts, Answering::of(listed, flow)), &busy(503));
        };

        // a listener meets the connection registered, before its client has its token
        self.tell(vec![Told::Connection(handle)]);

        // the listen taken, said back, so a client whose field something on the way dropped never
        // listens where it would be refused
        let mut drew = End::of(201).with((CONNECTION_TOKEN_HEADER, token));

        if is_listening {
            drew = drew.with((LISTEN_HEADER, "?1".to_owned()));
        }

        self.finished((facts, Answering::of(listed, flow)), &drew)
    }

    // a connection's end begun, false once begun already: out of the registry, each exchange still
    // waiting told by the marked 404 until its request is handed on, then by its socket cut after
    // its head, as a lost exchange's: a request handed on ran, which no refusal may deny
    fn take_drawn(&self, handle: &ConnectionHandle) -> bool {
        let mut state = locked(&self.state);
        let Some(drawn) = state.drawn.remove(handle) else {
            return false;
        };

        state.by_token.remove(&drawn.token);

        let others = state
            .per_address
            .get(&drawn.address)
            .copied()
            .unwrap_or(0)
            .saturating_sub(1);

        if others == 0 {
            state.per_address.remove(&drawn.address);
        } else {
            state.per_address.insert(drawn.address.clone(), others);
        }

        for burial in drawn.buried.values() {
            burial.cancel();
        }

        if let Some(idle) = &drawn.idle {
            idle.cancel();
        }

        for id in drawn.waiting.values() {
            if let Some(exchange) = state.exchanges.get_mut(id) {
                exchange.is_ended = true;

                if let Some(slow) = exchange.slow.take() {
                    slow.cancel();
                }

                if let Some(timer) = exchange.timer.take() {
                    timer.cancel();
                }

                if exchange.is_delivered {
                    exchange.responder.head();
                }

                // * one whose body still comes is answered before it is whole: its socket closes
                // in stages
                if exchange.responder.is_head_sent() {
                    exchange.responder.cut();
                } else {
                    exchange.responder.end_closing(&unknown_connection());
                }
            }
        }

        // what waited at its gate goes with it, its charge released, a request ended with it, any
        // other told it is gone
        let mut released = 0_u64;

        for id in &drawn.gate.held {
            if let Some(exchange) = state.exchanges.get_mut(id) {
                exchange.is_held_back = false;
                exchange.envelope = None;
                released = released.saturating_add(core::mem::take(&mut exchange.charged));

                if !exchange.is_ended {
                    exchange.is_ended = true;
                    exchange.responder.end(&unknown_connection());
                }
            }
        }

        state.body_bytes = state.body_bytes.saturating_sub(released);

        // its listen learns it is gone, its outbox gone with it
        if let Some(listen) = drawn.listen {
            self.answer_listen((&mut state, listen), &unknown_connection());
        }

        drop(state);

        true
    }

    // a connection's end, told once, clean or not
    fn close_drawn(&self, handle: &ConnectionHandle, is_clean: bool) {
        if self.take_drawn(handle) {
            self.tell(vec![Told::Close(is_clean, Arc::clone(handle))]);
        }
    }

    // ! a connection behind its bounds is dropped, its close unclean, then reported, naming the
    // bound, so an operator tells it from a network that failed; once, as it ends
    fn drop_drawn(&self, handle: &ConnectionHandle, why: &str) {
        if self.take_drawn(handle) {
            self.tell(vec![Told::Dropped(
                dropped_of(handle, why),
                Arc::clone(handle),
            )]);
        }
    }

    // a cancel that came before its request: the request, when it comes, is dropped; only the
    // client's call ids, and so many as a connection has requests waiting
    fn bury(&self, (state, handle): (&mut ServerState, &ConnectionHandle), call_id: u32) {
        let maximum = self.settings.maximum_waiting_exchanges;
        let Some(drawn) = state.drawn.get_mut(handle) else {
            return;
        };

        if call_id.is_multiple_of(2)
            || u64::try_from(drawn.buried.len()).unwrap_or(u64::MAX) >= maximum
        {
            return;
        }

        if let Some(before) = drawn.buried.remove(&call_id) {
            before.cancel();
        }

        let server = Weak::clone(&self.me);
        let buried = Arc::clone(handle);
        let burial = self.clock.arm(
            Schedule::Once(BURIAL),
            Box::new(move || {
                if let Some(inner) = server.upgrade()
                    && let Some(drawn) = locked(&inner.state).drawn.get_mut(&buried)
                {
                    drawn.buried.remove(&call_id);
                }
            }),
        );

        // a clock that arms no timer buries for good, as long as its connection lasts
        if let Ok(burial) = burial {
            drawn.buried.insert(call_id, burial);
        }
    }

    // one envelope: read into one buffer under its bounds, its prefix judged from its first 8
    // bytes, then handed on; a request's answer written by `send`, its head with it or, 40 ms
    // after its hand-off, alone before it
    fn receive(
        self: Arc<Self>,
        (body, handle): (Option<Incoming>, &ConnectionHandle),
        receiving: Receiving,
    ) -> Answered {
        let Receiving {
            facts,
            answering: Answering { listed, flow },
            authorizations,
            declared,
        } = receiving;
        let maximum = self.settings.maximum_body_bytes;

        // ! a field that is no list is not combined (RFC 9110 §5.3): two are refused before either
        // could be taken for the other
        if authorizations.len() > 1 {
            return self.finished(
                (&facts, Answering::of(listed, flow)),
                &End::refused(400, HTTP_REFUSALS.malformed),
            );
        }

        if declared.is_some_and(|declared| declared > maximum) {
            return self.finished(
                (&facts, Answering::of(listed, flow)),
                &End::refused(413, HTTP_REFUSALS.too_large),
            );
        }

        let (head, answered) = oneshot::channel();
        let responder = Responder::new(head, (listed.clone(), Arc::clone(&flow)));
        let id = {
            let mut state = locked(&self.state);
            let now = self.clock.wall();
            let Some(drawn) = state.drawn.get_mut(handle) else {
                drop(state);

                return self.finished((&facts, Answering::of(listed, flow)), &unknown_connection());
            };

            // a bound on what one connection has under way, cancels included, well past what its
            // waiting requests may be: those are refused at their prefix
            if drawn.open >= self.settings.maximum_waiting_exchanges.saturating_mul(2) {
                drop(state);

                return self.finished((&facts, Answering::of(listed, flow)), &busy(429));
            }

            drawn.open = drawn.open.saturating_add(1);
            drawn.last_activity = Some(now);

            if let Some(idle) = drawn.idle.take() {
                idle.cancel();
            }

            state.next_exchange = state.next_exchange.saturating_add(1);

            let id = state.next_exchange;
            let server = Weak::clone(&self.me);
            let runtime = self.runtime.clone();

            state.exchanges.insert(
                id,
                ExchangeState {
                    connection: Arc::clone(handle),
                    facts,
                    // ! told from a turn of its own: a body hyper never took is let go where the
                    // server's state is held
                    responder: responder.telling(Box::new(move |is_whole| {
                        drop(platform::spawn(&runtime, async move {
                            if let Some(inner) = server.upgrade() {
                                inner.response_closed(id, is_whole);
                            }
                        }));
                    })),
                    prefix: None,
                    is_cancelled: false,
                    is_delivered: false,
                    is_ended: false,
                    is_whole: false,
                    is_held_back: false,
                    charged: 0,
                    received: 0,
                    slow: None,
                    timer: None,
                    envelope: None,
                    credential: credential_of(
                        &authorizations
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                    )
                    .map(str::to_owned),

                    taken: None,
                    answered: None,
                    sides: 2,
                },
            );

            id
        };
        let head_at = self.clock.monotonic();

        self.pace_body(id, head_at);
        self.read_body((id, (head_at, declared)), (body, answered))
    }

    // an exchange's body, read as it comes until it is whole or its exchange ends, then its head
    fn read_body(
        self: Arc<Self>,
        (id, (head_at, declared)): (u64, (Duration, Option<u64>)),
        (body, answered): (Option<Incoming>, oneshot::Receiver<Response<AnswerBody>>),
    ) -> Answered {
        Box::pin(async move {
            let mut guard = Guard {
                server: Weak::clone(&self.me),
                id,
                is_response_open: true,
                is_request_open: true,
            };
            let mut buffer = BodyBuffer::new(declared);
            let mut body = body;
            let mut answered = pin!(answered);

            loop {
                // * what ends the exchange before its body is whole writes its head at once, and
                // what still comes of it is left to its socket's end
                let next = poll_fn(|context| {
                    if let Poll::Ready(head) = answered.as_mut().poll(context) {
                        return Poll::Ready(Err(head));
                    }

                    body.as_mut()
                        .map_or(Poll::Ready(None), |body| Pin::new(body).poll_frame(context))
                        .map(Ok)
                })
                .await;

                match next {
                    Err(head) => {
                        guard.request_done();

                        return guard.answered(head);
                    }
                    Ok(Some(Ok(frame))) => {
                        if let Ok(piece) = frame.into_data() {
                            self.take_piece((id, head_at), (&mut buffer, piece.as_ref()));
                        }
                    }
                    Ok(Some(Err(error))) => {
                        let is_answered = self.body_failed(id, &error);

                        guard.request_done();

                        if !is_answered {
                            return Err(Cut);
                        }

                        break;
                    }
                    Ok(None) => {
                        self.body_ended(id, buffer);
                        guard.request_done();

                        break;
                    }
                }
            }

            let head = answered.await;

            guard.answered(head)
        })
    }

    // its body's pace, on its clock from its head's reading: due by the longer of its grace and
    // what its bytes take at its rate (spec 15.12); past it, refused 408
    fn pace_body(&self, id: u64, head_at: Duration) {
        let mut state = locked(&self.state);

        self.repace((&mut state, id), head_at);
    }

    fn repace(&self, (state, id): (&mut ServerState, u64), head_at: Duration) {
        let Some(exchange) = state.exchanges.get_mut(&id) else {
            return;
        };

        if let Some(slow) = exchange.slow.take() {
            slow.cancel();
        }

        if exchange.is_ended {
            return;
        }

        let rate = self.settings.minimum_body_bytes_per_second.max(1);
        let takes = Duration::from_millis(exchange.received.saturating_mul(1_000).div_ceil(rate));
        let due = head_at.saturating_add(self.settings.body_grace_period.max(takes));
        // ! a millisecond at least, counted whole: Bead arms no timer for less (decision 0011)
        let left = due.saturating_sub(self.clock.monotonic());
        let wait = Duration::from_millis(
            u64::try_from(left.as_nanos().div_ceil(1_000_000))
                .unwrap_or(u64::MAX)
                .max(1),
        );
        let server = Weak::clone(&self.me);
        let armed = self.clock.arm(
            Schedule::Once(wait),
            Box::new(move || {
                if let Some(inner) = server.upgrade() {
                    inner.too_slow(id);
                }
            }),
        );

        exchange.slow = armed.ok();
    }

    // a body behind its rate: refused 408, its charge released, what still comes dropped
    fn too_slow(&self, id: u64) {
        let told = {
            let mut state = locked(&self.state);
            let Some(exchange) = state.exchanges.get_mut(&id) else {
                return;
            };

            exchange.slow = None;

            if exchange.is_ended {
                return;
            }

            release((&mut state, id));

            let told = end_early((&mut state, id), &End::refused(408, HTTP_REFUSALS.too_slow));

            drop(state);
            told
        };

        self.tell(told);
    }

    // a piece of a body: charged, bounded, paced, and kept; its first 8 bytes judged once they
    // came
    fn take_piece(
        &self,
        (id, head_at): (u64, Duration),
        (buffer, piece): (&mut BodyBuffer, &[u8]),
    ) {
        let maximum = self.settings.maximum_body_bytes;
        let told = {
            let mut state = locked(&self.state);
            let Some(exchange) = state.exchanges.get_mut(&id) else {
                return;
            };

            // ! what comes once it ended is dropped, and charged nothing: an answer written before
            // its body is whole reads on until its client closes, and a body refused holds no
            // budget
            if exchange.is_ended {
                if let Some(slow) = exchange.slow.take() {
                    slow.cancel();
                }

                return;
            }

            let count = u64::try_from(piece.len()).unwrap_or(u64::MAX);

            exchange.received = exchange.received.saturating_add(count);
            exchange.charged = exchange.charged.saturating_add(count);

            let received = exchange.received;
            let is_cancelled = exchange.is_cancelled;

            state.body_bytes = state.body_bytes.saturating_add(count);

            let told = if received > maximum {
                release((&mut state, id));
                end_early(
                    (&mut state, id),
                    &End::refused(413, HTTP_REFUSALS.too_large),
                )
            } else if state.body_bytes > self.settings.body_bytes_budget {
                release((&mut state, id));
                end_early((&mut state, id), &busy(503))
            } else {
                self.repace((&mut state, id), head_at);

                if is_cancelled {
                    return;
                }

                buffer.append((piece, usize::try_from(maximum).unwrap_or(usize::MAX)));

                let is_judged = state
                    .exchanges
                    .get(&id)
                    .is_some_and(|exchange| exchange.prefix.is_some());

                let refused = Prefix::of(buffer.as_slice())
                    .filter(|_| !is_judged)
                    .and_then(|prefix| self.classify((&mut state, id), prefix));

                refused.map_or_else(Vec::new, |refused| end_early((&mut state, id), &refused))
            };

            drop(state);
            told
        };

        self.tell(told);
    }

    // what the first 8 bytes say: a request waits under its call id from now on; or its refusal
    fn classify(&self, (state, id): (&mut ServerState, u64), prefix: Prefix) -> Option<End> {
        if !(FIRST_LAYOUT..=LAST_LAYOUT).contains(&prefix.layout) {
            return Some(End::refused(400, HTTP_REFUSALS.malformed));
        }

        let exchange = state.exchanges.get_mut(&id)?;

        if prefix.kind != REQUEST {
            exchange.prefix = Some(prefix);

            return None;
        }

        // a client's call ids are odd, and none is 0
        if prefix.call_id.is_multiple_of(2) {
            return Some(End::refused(400, HTTP_REFUSALS.malformed));
        }

        let connection = Arc::clone(&exchange.connection);
        let drawn = state.drawn.get_mut(&connection)?;

        if drawn.waiting.contains_key(&prefix.call_id) {
            return Some(End::refused(409, HTTP_REFUSALS.call_waiting));
        }

        if u64::try_from(drawn.waiting.len()).unwrap_or(u64::MAX)
            >= self.settings.maximum_waiting_exchanges
        {
            return Some(busy(429));
        }

        let burial = drawn.buried.remove(&prefix.call_id);

        drawn.waiting.insert(prefix.call_id, id);

        if let Some(burial) = &burial {
            burial.cancel();
        }

        if let Some(exchange) = state.exchanges.get_mut(&id) {
            exchange.prefix = Some(prefix);
            exchange.is_cancelled = exchange.is_cancelled || burial.is_some();
        }

        None
    }

    // a body whose read failed, a malformed chunked one: answered 400 as HTTP answers it, its
    // exchange lost, which closes its connection; false where no socket is left to answer on
    fn body_failed(&self, id: u64, error: &hyper::Error) -> bool {
        let is_gone = error.is_incomplete_message()
            || core::error::Error::source(error)
                .and_then(|source| source.downcast_ref::<io::Error>())
                .is_some_and(|error| error.kind() == io::ErrorKind::UnexpectedEof);
        let mut state = locked(&self.state);
        let Some(exchange) = state.exchanges.get_mut(&id) else {
            return false;
        };

        if let Some(slow) = exchange.slow.take() {
            slow.cancel();
        }

        let is_held_back = exchange.is_held_back;

        if !is_held_back {
            release((&mut state, id));
        }

        if is_gone {
            return false;
        }

        if let Some(exchange) = state.exchanges.get_mut(&id) {
            exchange.responder.refuse_malformed();
        }

        drop(state);

        true
    }

    // a body read whole: ended as it came, its connection gone, or to go on, at its connection's
    // gate
    fn body_ended(&self, id: u64, buffer: BodyBuffer) {
        let (told, hand) = {
            let mut state = locked(&self.state);
            let Some(exchange) = state.exchanges.get_mut(&id) else {
                return;
            };

            if let Some(slow) = exchange.slow.take() {
                slow.cancel();
            }

            exchange.is_whole = true;

            let connection = Arc::clone(&exchange.connection);
            let (is_ended, is_cancelled, has_prefix) = (
                exchange.is_ended,
                exchange.is_cancelled,
                exchange.prefix.is_some(),
            );

            if is_ended {
                release((&mut state, id));

                return;
            }

            if !state.drawn.contains_key(&connection) {
                // its connection closed while its body came: its client learns it is gone
                release((&mut state, id));

                if let Some(exchange) = state.exchanges.get_mut(&id) {
                    exchange.is_ended = true;
                    exchange.responder.end(&unknown_connection());
                }

                return;
            }

            let ended = if !has_prefix {
                release((&mut state, id));

                (
                    end_early(
                        (&mut state, id),
                        &End::refused(400, HTTP_REFUSALS.malformed),
                    ),
                    false,
                )
            } else if is_cancelled {
                // its cancel came first, or while it came: dropped, and ended empty
                release((&mut state, id));

                (end_early((&mut state, id), &End::of(204)), false)
            } else {
                if let Some(exchange) = state.exchanges.get_mut(&id) {
                    exchange.envelope = Some(buffer.into_bytes());
                    exchange.is_held_back = true;
                }

                // * at its connection's gate, while its router paused it or while it holds any:
                // in order, its body charged until handed on (spec 15.5, 15.12)
                match state.drawn.get_mut(&connection) {
                    Some(drawn) if drawn.gate.is_paused || !drawn.gate.held.is_empty() => {
                        drawn.gate.held.push_back(id);

                        (Vec::new(), false)
                    }
                    Some(_) => (Vec::new(), true),
                    None => (Vec::new(), false),
                }
            };

            drop(state);
            ended
        };

        self.tell(told);

        if hand {
            self.hand(id);
        }
    }

    // an envelope read whole, handed on: a request with the credential its exchange carried, its
    // head waiting 40 ms for its answer once its router has it; any other with none, its exchange
    // ended 204
    fn hand(&self, id: u64) {
        let handed = {
            let mut state = locked(&self.state);
            let Some(exchange) = state.exchanges.get_mut(&id) else {
                return;
            };
            let Some((envelope, prefix)) = exchange.envelope.take().zip(exchange.prefix) else {
                return;
            };

            exchange.is_held_back = false;

            let is_request = prefix.kind == REQUEST;

            if is_request {
                exchange.is_delivered = true;
            }

            let message = TransportMessage {
                data: envelope,
                credential: exchange.credential.clone().filter(|_| is_request),
                address: exchange.facts.address.clone(),
                port: Some(exchange.facts.port),
                may_overtake: false,
                is_text: false,
            };
            let connection = Arc::clone(&exchange.connection);

            release((&mut state, id));
            drop(state);

            (message, connection, prefix)
        };
        let (message, connection, prefix) = handed;

        self.tell(vec![Told::Message(message, Arc::clone(&connection))]);

        let told = {
            let mut state = locked(&self.state);

            if prefix.kind == REQUEST {
                // still waiting — not answered as it came — its head waits 40 ms for its answer,
                // then goes alone, so its client knows the router has it
                let is_waiting = state
                    .drawn
                    .get(&connection)
                    .is_some_and(|drawn| drawn.waiting.get(&prefix.call_id) == Some(&id));

                if is_waiting && let Some(exchange) = state.exchanges.get_mut(&id) {
                    // * one timer from the hand-off: the head's delay first, then what is left of
                    // the exchange timeout; one of 40 ms or less is the exchange timer alone, whose
                    // close sends the head and cuts the exchange (spec 15.7)
                    let timeout = self.settings.exchange_timeout;
                    let server = Weak::clone(&self.me);
                    let waited = Arc::clone(&connection);

                    exchange.timer = self
                        .clock
                        .arm(
                            Schedule::Once(timeout.min(HEAD_DELAY)),
                            Box::new(move || {
                                if let Some(inner) = server.upgrade() {
                                    if timeout <= HEAD_DELAY {
                                        inner.close_drawn(&waited, false);
                                    } else {
                                        inner.head_due((&waited, id));
                                    }
                                }
                            }),
                        )
                        .ok();
                }

                drop(state);

                Vec::new()
            } else {
                if prefix.kind == CANCEL {
                    self.cancel((&mut state, &connection), prefix.call_id);
                }

                let told = end_early((&mut state, id), &End::of(204));

                drop(state);
                told
            }
        };

        self.tell(told);
    }

    // a request still unanswered 40 ms after its hand-off: its head goes alone, and its timer is
    // armed again for what is left of its exchange timeout, none under a timeout of never
    fn head_due(&self, (connection, id): (&ConnectionHandle, u64)) {
        let mut state = locked(&self.state);
        let call_id = state
            .exchanges
            .get(&id)
            .and_then(|exchange| exchange.prefix)
            .map(|prefix| prefix.call_id);
        let is_waiting = call_id.is_some_and(|call_id| {
            state
                .drawn
                .get(connection)
                .is_some_and(|drawn| drawn.waiting.get(&call_id) == Some(&id))
        });
        let timeout = self.settings.exchange_timeout;

        if let Some(exchange) = state.exchanges.get_mut(&id) {
            exchange.timer = None;

            if is_waiting && !exchange.is_ended {
                exchange.responder.head();

                if timeout != NEVER {
                    let server = Weak::clone(&self.me);
                    let waited = Arc::clone(connection);

                    exchange.timer = self
                        .clock
                        .arm(
                            Schedule::Once(timeout.saturating_sub(HEAD_DELAY)),
                            Box::new(move || {
                                if let Some(inner) = server.upgrade() {
                                    inner.close_drawn(&waited, false);
                                }
                            }),
                        )
                        .ok();
                }
            }
        }

        drop(state);
    }

    // a cancel is never answered: the exchange of its call ends empty — a 200 with no body once
    // its head went — or, its body still coming, once whole; one that has not come is buried
    fn cancel(&self, (state, connection): (&mut ServerState, &ConnectionHandle), call_id: u32) {
        let cancelled = state
            .drawn
            .get(connection)
            .and_then(|drawn| drawn.waiting.get(&call_id).copied());
        let Some(cancelled) = cancelled else {
            self.bury((state, connection), call_id);

            return;
        };
        let Some(exchange) = state.exchanges.get_mut(&cancelled) else {
            return;
        };

        if exchange.is_delivered {
            exchange.is_ended = true;
            exchange.responder.end(&End::of(204));

            if let Some(drawn) = state.drawn.get_mut(connection) {
                drawn.waiting.remove(&call_id);
            }
        } else {
            exchange.is_cancelled = true;
        }
    }

    // what waited at a connection's gate, handed on in order from a later step, asking before each
    // whether it was paused again
    fn release_gate(&self, connection: &ConnectionHandle) {
        let server = Weak::clone(&self.me);
        let connection = Arc::clone(connection);

        drop(platform::spawn(&self.runtime, async move {
            loop {
                let Some(inner) = server.upgrade() else {
                    return;
                };
                let next = {
                    let mut state = locked(&inner.state);
                    let Some(drawn) = state.drawn.get_mut(&connection) else {
                        return;
                    };

                    if drawn.gate.is_paused {
                        return;
                    }

                    let next = drawn.gate.held.pop_front();

                    drop(state);
                    next
                };
                let Some(id) = next else {
                    return;
                };

                inner.hand(id);
            }
        }));
    }

    // an exchange's request done, read whole or not
    fn request_done(&self, id: u64) {
        let mut state = locked(&self.state);
        let Some(exchange) = state.exchanges.get_mut(&id) else {
            return;
        };

        if let Some(slow) = exchange.slow.take() {
            slow.cancel();
        }

        if !exchange.is_held_back {
            release((&mut state, id));
        }

        if let Some(connection) = side_done((&mut state, id)) {
            self.rest((&mut state, &connection));
        }

        drop(state);
    }

    // an exchange's response done, `is_whole` when taken whole: closed before the transport ended
    // the exchange, it is lost, as a dropped socket's frames are, which closes its connection
    fn response_closed(&self, id: u64, is_whole: bool) {
        let lost = {
            let mut state = locked(&self.state);
            let Some(exchange) = state.exchanges.get_mut(&id) else {
                return;
            };

            if let Some(slow) = exchange.slow.take() {
                slow.cancel();
            }

            if let Some(taken) = &exchange.taken {
                taken.store(true, Ordering::SeqCst);
            }

            if let Some(answered) = exchange.answered.take() {
                answered.send(is_whole).ok();
            }

            let lost = (!exchange.is_ended).then(|| Arc::clone(&exchange.connection));

            release((&mut state, id));

            if let Some(connection) = side_done((&mut state, id)) {
                self.rest((&mut state, &connection));
            }

            drop(state);

            lost
        };

        if let Some(connection) = lost {
            self.close_drawn(&connection, false);
        }
    }

    // its stop's body: no exchange served from now, each listener let go, each connection closed,
    // unclean, each socket ended once what it answers went
    fn stopping(&self) -> BoxFuture<Result<(), RouterError>> {
        let (listening, handles, flows) = {
            let mut state = locked(&self.state);
            let listening: Vec<Listening> = core::mem::take(&mut state.listening);
            // each closed in the order it was drawn
            let mut drawn: Vec<(u64, ConnectionHandle)> = state
                .drawn
                .iter()
                .map(|(handle, drawn)| (drawn.arrival, Arc::clone(handle)))
                .collect();

            drawn.sort_by_key(|(arrival, _)| *arrival);

            let handles: Vec<ConnectionHandle> =
                drawn.into_iter().map(|(_, handle)| handle).collect();
            let flows: Vec<Arc<Flow>> = state.flows.values().cloned().collect();

            drop(state);

            (listening, handles, flows)
        };

        for listener in &listening {
            listener.let_go();
        }

        for handle in &handles {
            self.close_drawn(handle, false);
        }

        for flow in &flows {
            flow.stop();
        }

        Box::pin(async move {
            for listener in listening {
                listener.ended().await;
            }

            Ok(())
        })
    }

    // an answer's bytes, held to the pace its socket takes them at
    fn pace_answer(&self, (state, id): (&mut ServerState, u64), (bytes, flow): (u64, Arc<Flow>)) {
        let Some(exchange) = state.exchanges.get_mut(&id) else {
            return;
        };
        let taken = Arc::new(AtomicBool::new(false));

        exchange.taken = Some(Arc::clone(&taken));
        self.pace((Arc::clone(&exchange.connection), flow), (bytes, taken));
    }

    // `bytes` held to the pace `connection`'s socket takes them at, until `taken` says hyper took
    // them whole and its socket holds nothing more; one its socket still holds past its deadline
    // is lost, which drops its connection at both ends (spec 15.7, 15.12)
    fn pace(
        &self,
        (connection, flow): (ConnectionHandle, Arc<Flow>),
        (bytes, taken): (u64, Arc<AtomicBool>),
    ) {
        let server = Weak::clone(&self.me);
        let options = self.settings.pace;
        let (held, unsent, kept) = (taken, Arc::clone(&flow), Arc::clone(&flow));
        let pace = SendPace::new(
            SendPaceHooks {
                unsent: Box::new(move || {
                    u64::from(!held.load(Ordering::SeqCst) || unsent.is_blocked())
                }),
                late: Box::new(move || {
                    flow.abort();

                    if let Some(inner) = server.upgrade() {
                        inner.drop_drawn(&connection, &late_of(&options));
                    }
                }),
            },
            (options, Arc::clone(&self.platform)),
        );

        pace.hand(bytes);
        kept.pace(pace);
    }
}

// what an exchange holds of the server's budget, given back
fn release((state, id): (&mut ServerState, u64)) {
    let Some(exchange) = state.exchanges.get_mut(&id) else {
        return;
    };
    let charged = core::mem::take(&mut exchange.charged);

    state.body_bytes = state.body_bytes.saturating_sub(charged);
}

// ends an exchange now, before its body or its answer; what still comes is dropped
fn end_early((state, id): (&mut ServerState, u64), end: &End) -> Vec<Told> {
    let Some(exchange) = state.exchanges.get_mut(&id) else {
        return Vec::new();
    };

    if let Some(slow) = exchange.slow.take() {
        slow.cancel();
    }

    exchange.is_ended = true;

    let told = finish((&exchange.facts, &mut exchange.responder), end);
    let (prefix, connection) = (exchange.prefix, Arc::clone(&exchange.connection));

    if let Some(prefix) = prefix
        && let Some(drawn) = state.drawn.get_mut(&connection)
        && drawn.waiting.get(&prefix.call_id) == Some(&id)
    {
        drawn.waiting.remove(&prefix.call_id);
    }

    told
}

// one side of an exchange done; both done, it is over, and its connection, which it gives, has
// one less under way
fn side_done((state, id): (&mut ServerState, u64)) -> Option<ConnectionHandle> {
    let exchange = state.exchanges.get_mut(&id)?;

    exchange.sides = exchange.sides.saturating_sub(1);

    if exchange.sides > 0 {
        return None;
    }

    let connection = Arc::clone(&exchange.connection);
    let prefix = exchange.prefix;
    let timer = exchange.timer.take();

    state.exchanges.remove(&id);

    if let Some(timer) = timer {
        timer.cancel();
    }

    let drawn = state.drawn.get_mut(&connection)?;

    drawn.open = drawn.open.saturating_sub(1);

    if let Some(prefix) = prefix
        && drawn.waiting.get(&prefix.call_id) == Some(&id)
    {
        drawn.waiting.remove(&prefix.call_id);
    }

    Some(connection)
}

impl HttpTransportServer {
    /// An HTTP transport server, which listens once started.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for a member given both in its policy and beside it; a duration spec 1.4 does not
    /// hold, never among them for its headers timeout, its body's grace and its send grace; a bound
    /// or a rate of 0, but the send rate; a hosts entry with a port; an origins entry that is `*`
    /// or `null`.
    pub fn new(options: &HttpTransportServerOptions) -> Result<Self, ProgrammerError> {
        let runtime =
            platform::socket_runtime_of(options.runtime.as_ref(), "an HTTP transport server")?;
        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));

        Self::on_platform((runtime, platform), options)
    }

    // what it is built with, each option held as the other sides hold it, a policy's members in
    // their places
    fn settings_of(given: &HttpTransportServerOptions) -> Result<Settings, ProgrammerError> {
        // * a policy's members in its place, each given once, there or beside it
        let options = given.with_policy()?;
        let body_bytes_budget = hold_count(
            "bodyBytesBudget",
            options.body_bytes_budget.unwrap_or(BODY_BYTES_BUDGET),
        )?;
        let maximum_body_bytes = hold_count(
            "maximumBodyBytes",
            options.maximum_body_bytes.unwrap_or(MAXIMUM_BODY_BYTES),
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
        let maximum_waiting_exchanges = hold_count(
            "maximumWaitingExchanges",
            options
                .maximum_waiting_exchanges
                .unwrap_or(MAXIMUM_WAITING_EXCHANGES),
        )?;
        let headers_timeout = hold_finite(
            "headersTimeout",
            options.headers_timeout.unwrap_or(HEADERS_TIMEOUT),
        )?;
        let minimum_body_bytes_per_second = hold_count(
            "minimumBodyBytesPerSecond",
            options
                .minimum_body_bytes_per_second
                .unwrap_or(MINIMUM_BODY_BYTES_PER_SECOND),
        )?;
        let body_grace_period = hold_finite(
            "bodyGracePeriod",
            options.body_grace_period.unwrap_or(BODY_GRACE_PERIOD),
        )?;
        let send_grace_period = hold_finite(
            "sendGracePeriod",
            options.send_grace_period.unwrap_or(SEND_GRACE_PERIOD),
        )?;
        let exchange_timeout = hold(
            "exchangeTimeout",
            options.exchange_timeout.unwrap_or(EXCHANGE_TIMEOUT),
        )?;
        let inactivity_timeout = hold(
            "inactivityTimeout",
            options.inactivity_timeout.unwrap_or(INACTIVITY_TIMEOUT),
        )?;
        let maximum_outbox_bytes = hold_count(
            "maximumOutboxBytes",
            options.maximum_outbox_bytes.unwrap_or(MAXIMUM_OUTBOX_BYTES),
        )?;
        let maximum_wait =
            hold_finite("maximumWait", options.maximum_wait.unwrap_or(MAXIMUM_WAIT))?;
        let hosts = options.hosts.clone().unwrap_or_default();
        let origins = options.origins.clone().unwrap_or_default();
        let procedures = options
            .procedures
            .as_deref()
            .map(|procedures| procedures_taken_of(procedures, "an HTTP transport server"))
            .transpose()?;
        let proxies = trusted_proxies_of(
            options.trusted_proxies.as_deref().unwrap_or_default(),
            options.unnamed_proxies,
        )?;

        assert_hosts(&hosts)?;
        assert_origins(&origins)?;

        Ok(Settings {
            headers_timeout,
            hosts,
            origins,
            maximum_connections,
            maximum_per_address,
            secure: options.secure,
            pace: SendPaceOptions {
                minimum_send_bytes_per_second: options
                    .minimum_send_bytes_per_second
                    .unwrap_or(MINIMUM_SEND_BYTES_PER_SECOND),
                send_grace_period,
            },
            procedures,
            proxies,
            tls: options.tls.as_ref().map(serving_config_of),
            body_bytes_budget,
            body_grace_period,
            maximum_body_bytes,
            maximum_waiting_exchanges,
            minimum_body_bytes_per_second,
            pathname: options.pathname.unwrap_or_else(|| PATHNAME.to_owned()),
            exchange_timeout,
            inactivity_timeout,
            maximum_outbox_bytes,
            maximum_wait,
        })
    }

    // a server on `runtime`, its timers that bound the platform's socket on `platform`: the
    // platform's clock, but in a test
    fn on_platform(
        (runtime, platform): (Handle, SharedClock),
        given: &HttpTransportServerOptions,
    ) -> Result<Self, ProgrammerError> {
        let settings = Self::settings_of(given)?;
        let options = given;
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
            settings,
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

    /// The connections it holds, in the order they were drawn: each its handle, its client's
    /// address and port, and when an exchange of its last began, by its clock.
    #[must_use]
    pub fn clients(&self) -> Vec<TransportServerClient> {
        let mut held: Vec<_> = locked(&self.inner.state)
            .drawn
            .iter()
            .map(|(handle, drawn)| {
                (
                    drawn.arrival,
                    TransportServerClient {
                        connection_handle: Arc::clone(handle),
                        address: drawn.address.clone(),
                        port: Some(drawn.port),
                        last_activity: drawn.last_activity,
                        transport_type: TRANSPORT_HTTP,
                    },
                )
            })
            .collect();

        held.sort_by_key(|(arrival, _)| *arrival);
        held.into_iter().map(|(_, client)| client).collect()
    }
}

/// An exchange of `parts` from `peer`, judged as one that came would be, its body none: what
/// below hyper's parser no socket can carry, a field's value with spaces at its edges, say.
#[cfg(test)]
pub(crate) fn judged(
    server: &HttpTransportServer,
    (parts, peer): (&::http::request::Parts, SocketAddr),
) -> Answered {
    Arc::clone(&server.inner).judge((parts, None), (Arc::new(Flow::default()), peer))
}

impl ServerTransport for HttpTransportServer {
    // an answer ends the exchange of its request; anything else goes nowhere on a connection that
    // does not listen. Neither carries a credential: the router fails a command that presents one
    // before it goes (decision 0010)
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let bytes: Bytes = message.data;
        let Some(prefix) = Prefix::of(&bytes) else {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(
                "an HTTP exchange carries one envelope, as bytes",
            ))));
        };
        let inner = &self.inner;
        let is_answer = prefix.kind == RESULT || prefix.kind == FAILURE;
        let mut state = locked(&inner.state);
        let Some(drawn) = state.drawn.get_mut(connection_handle) else {
            return Ok(Sent::Done);
        };
        let waiting = is_answer
            .then(|| drawn.waiting.remove(&prefix.call_id))
            .flatten();
        let is_listening = drawn.is_listening;
        let Some(id) = waiting else {
            if is_listening {
                let is_kept = inner.enqueue((&mut state, connection_handle), bytes);

                drop(state);

                if !is_kept {
                    inner.drop_drawn(
                        connection_handle,
                        &format!(
                            "its outbox would pass maximumOutboxBytes, {} bytes",
                            inner.settings.maximum_outbox_bytes
                        ),
                    );
                }

                return Ok(Sent::Done);
            }

            if is_answer {
                return Ok(Sent::Done);
            }

            return Err(RouterError::Other(Arc::new(io::Error::other(format!(
                "this connection does not listen: an envelope of kind 0x{:x} goes nowhere",
                prefix.kind
            )))));
        };
        let Some(exchange) = state.exchanges.get_mut(&id) else {
            return Ok(Sent::Done);
        };
        let (taken, answered) = oneshot::channel();
        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let closing = exchange.facts.is_http1 && !exchange.is_whole;
        let flow = exchange.responder.flow();

        exchange.is_ended = true;
        exchange.answered = Some(taken);

        if let Some(slow) = exchange.slow.take() {
            slow.cancel();
        }

        if let Some(timer) = exchange.timer.take() {
            timer.cancel();
        }

        exchange.responder.answer((bytes, closing));
        inner.pace_answer((&mut state, id), (length, flow));
        drop(state);

        Ok(Sent::Later(Box::pin(async move {
            match answered.await {
                Ok(true) => Ok(()),
                Ok(false) | Err(_) => Err(RouterError::Other(Arc::new(io::Error::other(
                    "the exchange closed before its answer went out",
                )))),
            }
        })))
    }

    // closed by its own word; settles at once, false when it held none by that handle
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        let held = locked(&self.inner.state)
            .drawn
            .contains_key(connection_handle);

        self.inner.close_drawn(connection_handle, true);

        Box::pin(async move { held })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.inner.listeners.remove(listener);
    }

    // ! its gate alone, never a telling: its exchanges wait there, under the bounds on what is
    // under way (spec 15.12)
    fn pause(&self, connection_handle: &ConnectionHandle) {
        if let Some(drawn) = locked(&self.inner.state).drawn.get_mut(connection_handle) {
            drawn.gate.is_paused = true;
        }
    }

    // what waited at its gate handed on from a later step, in order
    fn resume(&self, connection_handle: &ConnectionHandle) {
        let was_paused = locked(&self.inner.state)
            .drawn
            .get_mut(connection_handle)
            .is_some_and(|drawn| core::mem::replace(&mut drawn.gate.is_paused, false));

        if was_paused {
            self.inner.release_gate(connection_handle);
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    // its client said at connect that it listens: the server may send of its own
    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        locked(&self.inner.state)
            .drawn
            .get(connection_handle)
            .is_some_and(|drawn| drawn.is_listening)
    }

    // as its application says of what stands in front of it, else under TLS, or by what it
    // listens on
    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        let state = locked(&self.inner.state);
        let settings = &self.inner.settings;

        state.drawn.contains_key(connection_handle)
            && settings.secure.unwrap_or_else(|| {
                settings.tls.is_some() || state.listens_on.as_deref().is_some_and(is_loopback_host)
            })
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        let server = Arc::clone(&self.inner);

        self.inner.life.stop(move || server.stopping())
    }

    // what it keeps of its connections, at its ceilings where it has them
    fn gauges(&self) -> Option<Gauges> {
        let state = locked(&self.inner.state);
        let settings = &self.inner.settings;
        let mut gauges = Gauges::default();
        let count = |count: usize| u64::try_from(count).unwrap_or(u64::MAX);

        gauges
            .counts
            .insert("connections", count(state.drawn.len()));
        gauges
            .counts
            .insert("addresses", count(state.per_address.len()));
        gauges.counts.insert("bodyBytes", state.body_bytes);
        gauges.counts.insert(
            "buriedCallIds",
            count(state.drawn.values().map(|drawn| drawn.buried.len()).sum()),
        );
        gauges.counts.insert(
            "largestAddressConnections",
            state.per_address.values().copied().max().unwrap_or(0),
        );
        gauges.counts.insert(
            "waitingExchanges",
            count(state.drawn.values().map(|drawn| drawn.waiting.len()).sum()),
        );
        gauges.counts.insert(
            "listens",
            count(
                state
                    .drawn
                    .values()
                    .filter(|drawn| drawn.listen.is_some())
                    .count(),
            ),
        );
        gauges.counts.insert(
            "outboxBytes",
            state
                .drawn
                .values()
                .map(|drawn| drawn.outbox_bytes)
                .fold(0, u64::saturating_add),
        );
        gauges.counts.insert(
            "outboxEnvelopes",
            count(state.drawn.values().map(|drawn| drawn.outbox.len()).sum()),
        );
        gauges.counts.insert(
            "largestOutboxBytes",
            state
                .drawn
                .values()
                .map(|drawn| drawn.outbox_bytes)
                .max()
                .unwrap_or(0),
        );
        gauges
            .ceilings
            .insert("largestOutboxBytes", settings.maximum_outbox_bytes);
        // the sockets that serve an HTTP/2 session, none in clear
        gauges.counts.insert(
            "http2Sessions",
            count(state.flows.values().filter(|flow| flow.is_http2()).count()),
        );
        gauges
            .ceilings
            .insert("bodyBytes", settings.body_bytes_budget);
        gauges
            .ceilings
            .insert("connections", settings.maximum_connections);
        gauges
            .ceilings
            .insert("largestAddressConnections", settings.maximum_per_address);
        gauges
            .connection_handles
            .extend(state.drawn.keys().cloned());
        drop(state);

        Some(gauges)
    }

    fn names_procedures(&self) -> bool {
        self.inner.settings.procedures.is_some()
    }

    // false for a handle it does not hold
    fn takes_procedure(
        &self,
        connection_handle: &ConnectionHandle,
        address: ProcedureAddress,
    ) -> bool {
        locked(&self.inner.state)
            .drawn
            .contains_key(connection_handle)
            && self
                .inner
                .settings
                .procedures
                .as_ref()
                .is_none_or(|procedures| procedures.contains(&address))
    }

    fn transport_type(&self) -> Option<&str> {
        Some(TRANSPORT_HTTP)
    }
}
