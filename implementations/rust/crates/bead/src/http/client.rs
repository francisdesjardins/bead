//! A transport client over HTTP (spec 15.6, 15.9, 15.10), as the other sides'
//! `createHTTPTransportClient` and `HttpTransportClient` hold it: on a connection its server draws,
//! each exchange one envelope of its own, what the server sends of its own heard by a listen, on
//! hyper's pooled client over a connector of Bead's, which races a host's addresses (RFC 8305) and
//! speaks TLS under `https`.

use core::convert::Infallible;
use core::fmt;
use core::future::{Future, poll_fn};
use core::pin::{Pin, pin};
use core::task::{Context, Poll};
use core::time::Duration;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use ::http::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use ::http::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{Notify, oneshot};
use tokio_rustls::client::TlsStream;
use tokio_util::sync::CancellationToken;

use crate::clock::{HyperTimer, Schedule, SharedClock, SystemClock, Timer};
use crate::duration::{LONGEST_TIMER, NEVER, hold, hold_delay};
use crate::errors::{ConnectError, ProgrammerError, ReadyStateError, TransportError};
use crate::http::fields::{
    AFTER_HEADER, BEAD_BATCH_MEDIA_TYPE, BEAD_MEDIA_TYPE, CONNECTION_TOKEN_HEADER, HTTP_REFUSALS,
    LISTEN_HEADER, REFUSAL_HEADER, REQUEST, SEQUENCE_HEADER, WAIT_HEADER,
};
use crate::http::server::{EXCHANGE_TIMEOUT, INACTIVITY_TIMEOUT, MAXIMUM_BODY_BYTES, PATHNAME};
use crate::http::wire::Spawner;
use crate::judgement::items::{BareItem, parse_item};
use crate::judgement::security::is_secure;
use crate::net::bounds::hold_count;
use crate::net::racing::{RacingOptions, connect_racing, host_of};
use crate::net::tls::{ClientTls, NO_TLS, TlsOptions, client_tls_of, connect_tls, http1_config_of};
use crate::platform::{self, Handle};
use crate::router::types::{BoxFuture, RouterError, TransportMessage};
use crate::transport::{
    ClientListener, Connect, Listeners, RECONNECTION_CANCELLED, ReadyState, RouterClientTransport,
    Sent, TransportClientDisconnectOptions, TransportClientReconnectOptions, attempting,
    hold_reconnection, is_field_value, refused_unless_open,
};

#[cfg(test)]
mod tests;

// how long a connect waits for its server when it names no timeout, as the other sides' HTTP
// clients wait
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a disconnect waits on its server's answer to its `DELETE`, on the platform's clock,
/// before it lets the connection go all the same.
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long each listen asks its server to wait, by default: 25 seconds, under a server's own cap
/// of 30 and an intermediary's 60.
const WAIT: Duration = Duration::from_secs(25);

// how long a listen lost waits before the next, its second loss on: from a second, twice as long
// each time, up to 30, each drawn between half of it and all of it
const FIRST_RETRY: Duration = Duration::from_secs(1);
const RETRY_CEILING: Duration = Duration::from_secs(30);

// how long a pooled connection goes unused before its pool closes it: under Node's 5 s
// `keepAliveTimeout`, as undici keeps 4 s
pub(crate) const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(4);

// what a `Retry-After` that says nothing readable asks: the server's own second
const RETRY_AFTER_DEFAULT: Duration = Duration::from_secs(1);

// a batch's length of each envelope, before it
const LENGTH_BYTES: usize = 4;

// where an envelope's kind stands in its prefix
const KIND_OFFSET: usize = 1;

const DISPOSED: &str = "the transport client was disposed as it connected";

const CANCELLED: &str = "the connect was cancelled";

const NO_FIELD_VALUE: &str =
    "a credential holds visible ASCII, spaces and tabs alone, none first or last";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How an HTTP transport client holds its connection.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpTransportClientOptions {
    /// The clock the stack built on it runs on, a connect's timeout, an exchange's resending, its
    /// listens' inactivity, their pause and a reconnection's delays among it: the platform's when
    /// none. Its disconnect's bound runs on the platform's clock, whatever it is given, since it
    /// bounds what the platform's socket does (decision 0011).
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
    /// How long an envelope that is no request, refused `busy`, is sent again from its first send,
    /// past which it rejects and its connection is lost: [`EXCHANGE_TIMEOUT`] when none;
    /// [`NEVER`] sends it again without end.
    pub exchange_timeout: Option<Duration>,
    /// How long its listens may go lost before its connection counts as lost:
    /// [`INACTIVITY_TIMEOUT`] when none; [`NEVER`] listens again without end.
    pub inactivity_timeout: Option<Duration>,
    /// Whether it listens for what its server sends of its own (spec 15.9): `true` when none.
    pub is_listening: Option<bool>,
    /// The largest envelope it reads, an answer's or one of a batch's, past which its connection is
    /// closed and the bound reported: [`MAXIMUM_BODY_BYTES`] when none.
    pub maximum_body_bytes: Option<u64>,
    /// How long it waits after a listen that brought nothing before the next: 0, at once, when
    /// none.
    pub pause: Option<Duration>,
    /// How long each listen asks its server to wait for something to bring back, in `bead-wait`:
    /// 25 seconds when none.
    pub wait: Option<Duration>,
    /// The TLS a secured connect speaks, the application's own, a copy of which offers HTTP/1.1
    /// alone by ALPN: of `tls` when none. Refused beside `tls`.
    pub client_config: Option<Arc<ClientConfig>>,
    /// The authorities a secured connect judges its server by and the certificate it presents when
    /// its server asks for one (spec 15.39), read as it is built: rustls's over aws-lc-rs, the
    /// platform's verifier judging its server, when none. Held in the clear, which a secured
    /// connect alone uses.
    pub tls: Option<TlsOptions>,
}

/// Where an HTTP transport client's connect goes, and how long it waits.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct HttpTransportClientConnectOptions {
    /// The server's host: a name, which is turned to ASCII as the URL Standard's host parser reads
    /// it (UTS #46) and resolved, or an IP address, an IPv6 one bracketed or not.
    pub host: String,
    /// The server's port.
    pub port: u16,
    /// The path the server answers on, given a single leading slash: `/bead` when none.
    pub pathname: Option<String>,
    /// Whether its exchanges go over TLS, `https`: `false` when none.
    pub secured: Option<bool>,
    /// How long it waits for its server to draw its connection: 30 seconds when none; [`NEVER`]
    /// waits without end.
    pub timeout: Option<Duration>,
    /// What gives the connect up: one cancelled already refuses it before anything moves. Its own
    /// connect's alone: a reconnection replays the rest of these options, never this signal.
    pub signal: Option<CancellationToken>,
}

impl HttpTransportClientConnectOptions {
    /// A connect to `host` and `port`, every other option its default.
    #[must_use]
    pub fn new<H: Into<String>>(host: H, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            pathname: None,
            secured: None,
            timeout: None,
            signal: None,
        }
    }
}

// ── Its exchanges ─────────────────────────────────────────────────────────────────────────────

// what a request carries: an envelope, or nothing
#[derive(Debug)]
pub(crate) struct Sending(pub(crate) Option<Bytes>);

impl Body for Sending {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        Poll::Ready(self.get_mut().0.take().map(|bytes| Ok(Frame::data(bytes))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(
            self.0
                .as_ref()
                .map_or(0, |bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
        )
    }
}

// a socket of the connector's, in clear or under TLS
pub(crate) enum Socket {
    Plain(TcpStream),
    Secured(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for Socket {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_read(context, buffer),
            Self::Secured(socket) => Pin::new(socket).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for Socket {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_write(context, buffer),
            Self::Secured(socket) => Pin::new(socket).poll_write(context, buffer),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_flush(context),
            Self::Secured(socket) => Pin::new(socket).poll_flush(context),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_shutdown(context),
            Self::Secured(socket) => Pin::new(socket).poll_shutdown(context),
        }
    }
}

impl Connection for Socket {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

// hyper's connector: a host's addresses raced (RFC 8305), then TLS for `https`, HTTP/1.1 alone
// asked by ALPN; the TLS given, of its `tls`, or the platform's, built at the first secured connect
#[derive(Clone)]
pub(crate) struct Connector {
    racing: RacingOptions,
    given: ClientTls,
    tls: Arc<Mutex<Option<Arc<ClientConfig>>>>,
}

impl fmt::Debug for Connector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Connector").finish_non_exhaustive()
    }
}

impl Connector {
    // a connector under the TLS given, of its `tls`, or the platform's, racing by `racing`
    pub(crate) fn new(given: ClientTls, racing: &RacingOptions) -> Self {
        Self {
            racing: racing.clone(),
            given,
            tls: Arc::default(),
        }
    }

    fn tls(&self) -> io::Result<Arc<ClientConfig>> {
        let mut held = locked(&self.tls);

        if let Some(config) = held.as_ref() {
            return Ok(Arc::clone(config));
        }

        let config = http1_config_of(&self.given).map_err(io::Error::other)?;

        *held = Some(Arc::clone(&config));
        drop(held);

        Ok(config)
    }

    async fn connected(self, uri: Uri) -> io::Result<TokioIo<Socket>> {
        let host = uri
            .host()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a URL with no host"))?;
        let bare = host
            .strip_prefix('[')
            .and_then(|inner| inner.strip_suffix(']'))
            .unwrap_or(host)
            .to_owned();
        let is_secured = uri.scheme_str() == Some("https");
        let port = uri.port_u16().unwrap_or(if is_secured { 443 } else { 80 });
        let socket = connect_racing((&bare, port), &self.racing).await?;
        let socket = if is_secured {
            let config = self.tls()?;

            Socket::Secured(Box::new(connect_tls((socket, &bare), &config).await?))
        } else {
            Socket::Plain(socket)
        };

        Ok(TokioIo::new(socket))
    }
}

impl tower_service::Service<Uri> for Connector {
    type Response = TokioIo<Socket>;
    type Error = io::Error;
    type Future = BoxFuture<io::Result<TokioIo<Socket>>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        Box::pin(self.clone().connected(uri))
    }
}

// the media type of a response, its parameters aside
fn type_of(response: &Response<Incoming>) -> Option<String> {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
}

// a field's value read as an Item of RFC 9651, its parameters aside: its bare item
fn bare_item_of(headers: &HeaderMap, name: &str) -> Option<BareItem> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_item)
        .map(|item| item.bare_item)
}

// a field's value: whether it is the Boolean true
fn is_true(headers: &HeaderMap, name: &str) -> bool {
    matches!(bare_item_of(headers, name), Some(BareItem::Boolean(true)))
}

// a field's value: its Integer, or none
fn integer_of(headers: &HeaderMap, name: &str) -> Option<i64> {
    match bare_item_of(headers, name) {
        Some(BareItem::Integer(value)) => Some(value),
        _ => None,
    }
}

// a field's value as it came, or none
fn header_of<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

// a redirect, Fetch's redirect statuses, judged as any status that is not 2xx, never followed: the
// connection's token would go where it was not judged (spec 15.6)
fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

// the mark of a refusal of the transport's own; a redirect's is left unread, since no refusal of
// the transport's own is one
fn refusal_of(response: &Response<Incoming>) -> Option<String> {
    (!is_redirect(response.status()))
        .then(|| header_of(response.headers(), REFUSAL_HEADER).map(str::to_owned))
        .flatten()
}

/// The time a `Retry-After` asks to be waited, from `now`: its seconds, or until its date (RFC
/// 9110 §10.2.3); one that does not read, or none, the server's own second.
fn retry_after_of(value: Option<&str>, now: SystemTime) -> Duration {
    let Some(value) = value.map(str::trim) else {
        return RETRY_AFTER_DEFAULT;
    };

    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return value
            .parse::<u64>()
            .map_or(LONGEST_TIMER, Duration::from_secs);
    }

    httpdate::parse_http_date(value).map_or(RETRY_AFTER_DEFAULT, |date| {
        date.duration_since(now).unwrap_or(Duration::ZERO)
    })
}

// how long to wait before listening again after `losses` listens lost in a row, drawn apart so the
// clients one restart dropped together come back apart, as EventSource's do; in whole milliseconds
fn retry_delay_of(losses: u32) -> Duration {
    if losses <= 1 {
        return Duration::ZERO;
    }

    let doubled = 1_u32
        .checked_shl(losses.saturating_sub(2))
        .unwrap_or(u32::MAX);
    let delay = FIRST_RETRY.saturating_mul(doubled).min(RETRY_CEILING);
    let millis = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
    let mut drawn = [0_u8; 8];

    getrandom::fill(&mut drawn).ok();

    let half = millis / 2;
    let spread = millis.saturating_sub(half);
    let extra = if spread == 0 {
        0
    } else {
        u64::from_be_bytes(drawn)
            .checked_rem(spread.saturating_add(1))
            .unwrap_or(0)
    };

    Duration::from_millis(half.saturating_add(extra))
}

// a duration in whole milliseconds, a fraction rounded to the nearest
fn millis_of(duration: Duration) -> u128 {
    duration.as_micros().saturating_add(500) / 1_000
}

// * what this side closes a connection for of its own, as its `on_error` tells it before its close
// (spec 15.1): an envelope past its bound, named with its value
fn past_bound_of(maximum_body_bytes: u64) -> RouterError {
    RouterError::Other(Arc::new(io::Error::other(format!(
        "the connection is closed: an envelope past its maximumBodyBytes, {maximum_body_bytes} bytes"
    ))))
}

// and a batch that does not read, saying what of it does not
fn unread_of(why: &str) -> RouterError {
    RouterError::Other(Arc::new(io::Error::other(format!(
        "the connection is closed: a batch that does not read, {why}"
    ))))
}

// what a connect that failed on its way says, its cause kept
fn connect_error(error: hyper_util::client::legacy::Error) -> TransportError {
    let mut message = error.to_string();
    let mut source = core::error::Error::source(&error);

    // * the innermost cause names the failure: a refused connection, a certificate
    while let Some(cause) = source {
        message = cause.to_string();
        source = cause.source();
    }

    TransportError::Connect(ConnectError::caused(message, Arc::new(error)))
}

/// A timer of `timeout` on `clock`, its wait to poll: none for [`NEVER`], nor where the clock arms
/// none.
fn timer_of(clock: &SharedClock, timeout: Duration) -> Option<Armed> {
    if timeout == NEVER {
        return None;
    }

    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);

    clock
        .arm(
            Schedule::Once(timeout),
            Box::new(move || {
                if let Some(woken) = woken.take() {
                    woken.send(()).ok();
                }
            }),
        )
        .ok()
        .map(|timer| (timer, wait))
}

// waits `delay` on `clock`, or until `ended` is cancelled; a delay of 0 a turn of the runtime's
async fn paused_for(clock: &SharedClock, (delay, ended): (Duration, &CancellationToken)) {
    if delay.is_zero() {
        platform::yield_now().await;

        return;
    }

    let Some((timer, wait)) = timer_of(clock, delay) else {
        ended.cancelled().await;

        return;
    };
    let mut wait = pin!(wait);
    let mut cancelled = pin!(ended.cancelled());

    poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() || wait.as_mut().poll(context).is_ready() {
            return Poll::Ready(());
        }

        Poll::Pending
    })
    .await;
    timer.cancel();
}

// `future`'s output, or none once `ended` is cancelled first
async fn unless_ended<F: Future>(ended: &CancellationToken, future: F) -> Option<F::Output> {
    crate::net::listening::unless_cancelled(ended, future).await
}

// the next data of a body, none at its end
pub(crate) async fn chunk_of(body: &mut Incoming) -> Result<Option<Bytes>, hyper::Error> {
    loop {
        match poll_fn(|context| Pin::new(&mut *body).poll_frame(context)).await {
            None => return Ok(None),
            Some(Err(error)) => return Err(error),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    return Ok(Some(data));
                }
            }
        }
    }
}

// a body read whole, none past `limit` bytes
async fn whole_of(body: &mut Incoming, limit: u64) -> Result<Option<Vec<u8>>, hyper::Error> {
    let mut whole = Vec::new();

    while let Some(chunk) = chunk_of(body).await? {
        whole.extend_from_slice(&chunk);

        if u64::try_from(whole.len()).unwrap_or(u64::MAX) > limit {
            return Ok(None);
        }
    }

    Ok(Some(whole))
}

// a batch as a listen reads it: the length being read, then the envelope it announced, filling
#[derive(Default)]
struct Reading {
    length: Vec<u8>,
    envelope: Option<(usize, Vec<u8>)>,
}

impl Reading {
    // the envelopes a chunk of a batch completes, in order, what is left of it kept for the next
    // chunk; none at all when a length announces nothing, or more than `limit`, which fails the
    // connection
    fn envelopes_of(&mut self, (chunk, limit): (&[u8], u64)) -> Result<Vec<Bytes>, RouterError> {
        let mut envelopes = Vec::new();
        let mut rest = chunk;

        while !rest.is_empty() {
            if let Some((length, envelope)) = self.envelope.as_mut() {
                let taken = length.saturating_sub(envelope.len()).min(rest.len());
                let Some((filling, after)) = rest.split_at_checked(taken) else {
                    break;
                };

                envelope.extend_from_slice(filling);
                rest = after;

                if envelope.len() == *length {
                    envelopes.push(Bytes::from(core::mem::take(envelope)));
                    self.envelope = None;
                }

                continue;
            }

            let taken = LENGTH_BYTES
                .saturating_sub(self.length.len())
                .min(rest.len());
            let Some((filling, after)) = rest.split_at_checked(taken) else {
                break;
            };

            self.length.extend_from_slice(filling);
            rest = after;

            if let Ok(length) = <[u8; LENGTH_BYTES]>::try_from(self.length.as_slice()) {
                let length = u32::from_be_bytes(length);

                self.length.clear();

                if length == 0 {
                    return Err(unread_of("an envelope of 0 bytes"));
                }

                if u64::from(length) > limit {
                    return Err(past_bound_of(limit));
                }

                let length = usize::try_from(length).unwrap_or(usize::MAX);

                self.envelope = Some((length, Vec::with_capacity(length.min(65_536))));
            }
        }

        Ok(envelopes)
    }

    // whether it stopped within an envelope, or its length
    fn is_within(&self) -> bool {
        self.envelope.is_some() || !self.length.is_empty()
    }
}

// what a listen came to
enum Listened {
    // something heard, each envelope as it came whole
    Heard,
    // nothing to bring back
    Nothing,
    // lost on its way: listened again
    Lost,
    // its connection gone, the server said
    Gone,
    // refused of the transport's own
    Refused,
    // what fails the connection of this side's own
    Failed(RouterError),
}

// ── Its state ─────────────────────────────────────────────────────────────────────────────────

// what it was built with, held
#[derive(Debug)]
struct Settings {
    exchange_timeout: Duration,
    inactivity_timeout: Duration,
    is_listening: bool,
    maximum_body_bytes: u64,
    pause: Duration,
    wait: Duration,
}

// a timer armed, and its wait
type Armed = (Arc<dyn Timer>, oneshot::Receiver<()>);

// a connect under way: given up once its client is disposed; its timeout, armed as it was asked
struct Attempt {
    given_up: CancellationToken,
    timeout: Duration,
    timer: Mutex<Option<Armed>>,
}

// a connection its server drew: where its exchanges go, its token, and what ends them
struct Drawn {
    url: Uri,
    token: String,
    is_listening: bool,
    ended: CancellationToken,
}

struct ClientState {
    ready: ReadyState,
    // the options of the last connect its guard let through, without their signal
    last_connect: Option<HttpTransportClientConnectOptions>,
    is_attempting: bool,
    attempt: Option<Arc<Attempt>>,
    drawn: Option<Arc<Drawn>>,
    // whether the URL of the last connect is secure
    is_secure: bool,
    hold: Hold,
}

// * paused whole by its router, a pause outlasting its connection; what an answer or a batch
// brought meanwhile held, in order, and handed on once resumed, from a step of its own (spec 15.12)
#[derive(Default)]
struct Hold {
    is_paused: bool,
    is_handing: bool,
    held: VecDeque<TransportMessage>,
}

impl Hold {
    // whether what comes is heard at once: nothing paused, held, or handed on
    fn is_open(&self) -> bool {
        !self.is_paused && !self.is_handing && self.held.is_empty()
    }
}

pub(crate) struct ClientInner {
    me: Weak<Self>,
    runtime: Handle,
    // the platform's clock, which its disconnect's bound runs on
    platform: SharedClock,
    // the clock its timers run on, and the one it was given
    clock: SharedClock,
    given: Option<SharedClock>,
    settings: Settings,
    client: Client<Connector, Sending>,
    state: Mutex<ClientState>,
    // told each time what it holds is let go, or its pause lifted
    intake: Notify,
    listeners: Listeners<dyn ClientListener>,
}

/// A transport client over HTTP, on a connection its server draws for it (spec 15.6).
///
/// Its connect posts no envelope and takes the connection token its server answers 201 with; each
/// send posts one envelope with that token, its credential, when it has one, in its `Authorization`
/// as it is given; its disconnect deletes the connection. Its exchanges go on hyper's pooled
/// client, HTTP/1.1 alone, over a connector of Bead's that races a host's addresses (RFC 8305) and
/// speaks TLS on rustls under `https`, its server judged by the platform's verifier or by the
/// authorities its `tls` names, its certificate presented where its server asks. It writes no
/// `Origin`, and follows no redirect: a connect answered with one fails, naming its status, "the
/// server drew no connection: 302".
///
/// A send settles on the head of its answer: a 2xx is handed over, and an answer comes as a message
/// when it does; a refusal the transport marks in `bead-refusal` is refused, nothing having been
/// tried, and the one that says its connection is gone closes it once its refusal is heard.
/// Anything else — a status nothing marked, an answer of another type, a network that failed, a
/// redirect — counts as handed over, and closes its connection, as a socket that drops does. An
/// envelope that is no request, refused `busy`, is sent again once its `Retry-After` passed, its
/// seconds or its date, a second when it says none, until `exchange_timeout` from its first send.
///
/// What its server sends of its own, a client that listens hears by a listen at its connection's
/// URL, `bead-after` acknowledging what it heard and `bead-wait` asking its server to wait: each
/// envelope of a batch heard as it comes whole, bounded alone by `maximum_body_bytes`. A listen that
/// brings nothing is followed by another after `pause`; one lost is listened again at once, then
/// later and later, drawn apart, until one reaches its server, or until `inactivity_timeout` passed,
/// which loses its connection. Paused by its router, it asks no listen and holds what came, in
/// order, handing it on once resumed.
///
/// Its error tells what it closes its connection for of its own (spec 15.1), an envelope past
/// `maximum_body_bytes` or a batch that does not read, before its close.
#[derive(Clone)]
pub struct HttpTransportClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for HttpTransportClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpTransportClient")
            .field("ready_state", &locked(&self.inner.state).ready)
            .finish_non_exhaustive()
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

    fn report(&self, error: &RouterError) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics is dropped, as its throw goes to no one
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener.on_error(error)))
                .ok();
        }
    }

    fn is_current(&self, drawn: &Arc<Drawn>) -> bool {
        locked(&self.state)
            .drawn
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, drawn))
    }

    // a request of `method` at `url`, its token and its fields, carrying `body`
    fn request_of(
        (method, drawn): (Method, &Drawn),
        (fields, body): (&[(&str, String)], Option<Bytes>),
    ) -> Option<Request<Sending>> {
        let mut request = Request::builder()
            .method(method)
            .uri(drawn.url.clone())
            .header(CONNECTION_TOKEN_HEADER, drawn.token.as_str());

        for (name, value) in fields {
            request = request.header(*name, value.as_str());
        }

        request.body(Sending(body)).ok()
    }

    // a DELETE nobody waits on
    fn release(&self, drawn: &Drawn) {
        let Some(request) = Self::request_of((Method::DELETE, drawn), (&[], None)) else {
            return;
        };
        let sending = self.client.request(request);

        drop(platform::spawn(&self.runtime, async move {
            drop(sending.await);
        }));
    }

    // * the connection is gone: its exchanges end, and the client closes, as over a socket dropped;
    // one this side failed of its own tells why on `on_error` first, then its close all the same
    fn lose(&self, drawn: &Arc<Drawn>, (failure, is_released): (Option<RouterError>, bool)) {
        let is_told = {
            let mut state = locked(&self.state);

            if !state
                .drawn
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, drawn))
            {
                return;
            }

            state.drawn = None;
            state.hold.held.clear();

            let is_told = state.ready != ReadyState::Reconnecting;

            if is_told {
                state.ready = ReadyState::Closed;
            }

            is_told
        };

        drawn.ended.cancel();
        self.intake.notify_waiters();

        if is_released {
            self.release(drawn);
        }

        if is_told {
            if let Some(failure) = failure {
                self.report(&failure);
            }

            self.tell(|listener: &dyn ClientListener| listener.on_close(false, false));
        }
    }

    // an envelope an answer or a listen brought back, which carry no credential, what a listen
    // brought marked as what may overtake an answer: held while its router paused it, or while it
    // holds anything
    fn hear(&self, drawn: &Arc<Drawn>, (data, may_overtake): (Bytes, bool)) {
        let message = TransportMessage {
            data,
            may_overtake,
            ..TransportMessage::default()
        };
        let mut state = locked(&self.state);

        if !state
            .drawn
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, drawn))
        {
            return;
        }

        if !state.hold.is_open() {
            state.hold.held.push_back(message);

            return;
        }

        drop(state);
        self.tell(|listener: &dyn ClientListener| listener.on_message(message.clone()));
    }

    // what it holds handed on, in order, asking before each whether it was paused again; once
    // nothing is held, its listen goes on
    async fn handing(self: Arc<Self>) {
        loop {
            platform::yield_now().await;

            let message = {
                let mut state = locked(&self.state);
                let message = (!state.hold.is_paused)
                    .then(|| state.hold.held.pop_front())
                    .flatten();

                if message.is_none() {
                    state.hold.is_handing = false;
                }

                message
            };
            let Some(message) = message else {
                self.intake.notify_waiters();

                return;
            };

            self.tell(|listener: &dyn ClientListener| listener.on_message(message.clone()));
        }
    }

    // settles once nothing is held and its router paused it no more, or once its connection ends
    async fn intake_open(&self, drawn: &Drawn) {
        loop {
            let notified = self.intake.notified();
            let mut notified = pin!(notified);

            notified.as_mut().enable();

            {
                if locked(&self.state).hold.is_open() {
                    return;
                }
            }

            if unless_ended(&drawn.ended, notified).await.is_none() {
                return;
            }
        }
    }

    // the answer a 200 carries, read up to an envelope's limit; anything else of its type, or past
    // its limit, loses the connection
    async fn read_answer(&self, drawn: &Arc<Drawn>, response: Response<Incoming>) {
        if response.status() != StatusCode::OK {
            return;
        }

        let limit = self.settings.maximum_body_bytes;

        if type_of(&response).as_deref() != Some(BEAD_MEDIA_TYPE) {
            return self.lose(drawn, (None, true));
        }

        let declared = header_of(response.headers(), "content-length")
            .and_then(|length| length.trim().parse::<u64>().ok());

        if declared.is_some_and(|declared| declared > limit) {
            return self.lose(drawn, (Some(past_bound_of(limit)), true));
        }

        let mut body = response.into_body();
        let read = unless_ended(&drawn.ended, whole_of(&mut body, limit)).await;

        match read {
            Some(Err(_cut)) => self.lose(drawn, (None, true)),
            Some(Ok(None)) => self.lose(drawn, (Some(past_bound_of(limit)), true)),
            Some(Ok(Some(body))) if !body.is_empty() => {
                self.hear(drawn, (Bytes::from(body), false));
            }
            // its connection gone as it came, no answer of this one's; or an exchange ended
            // empty — cancelled — which has nothing to say
            None | Some(Ok(Some(_))) => {}
        }
    }

    // one exchange of `message`, settled on the head of its answer; an envelope that is no request,
    // refused busy, sent again once its `Retry-After` passed
    async fn exchanging(
        self: Arc<Self>,
        (drawn, message): (Arc<Drawn>, TransportMessage),
        settled: oneshot::Sender<Result<(), RouterError>>,
    ) {
        // ! what is not a request may be sent again: nothing of it was tried, and exchanges keep no
        // order (spec 15.6, 15.7)
        let is_resent = message.data.get(KIND_OFFSET) != Some(&REQUEST);
        let first_at = self.clock.monotonic();
        let mut fields = vec![("content-type", BEAD_MEDIA_TYPE.to_owned())];

        if let Some(credential) = &message.credential {
            fields.push((AUTHORIZATION.as_str(), credential.clone()));
        }

        loop {
            let Some(request) = Self::request_of(
                (Method::POST, &drawn),
                (&fields, Some(message.data.clone())),
            ) else {
                settled.send(Ok(())).ok();

                return self.lose(&drawn, (None, true));
            };
            let answered = unless_ended(&drawn.ended, self.client.request(request)).await;
            let response = match answered {
                // its connection gone meanwhile: as any send whose connection drops
                None => {
                    settled.send(Ok(())).ok();

                    return;
                }
                // lost before its head: whether the server had it is not known, so it counts as
                // handed over, and the connection closes, as a dropped socket's
                Some(Err(_lost)) => {
                    settled.send(Ok(())).ok();

                    return self.lose(&drawn, (None, true));
                }
                Some(Ok(response)) => response,
            };

            if response.status().is_success() {
                settled.send(Ok(())).ok();

                return self.read_answer(&drawn, response).await;
            }

            // a status nothing marked — a gateway's — or a redirect says nothing of whether the
            // server had it: lost
            let Some(refusal) = refusal_of(&response) else {
                settled.send(Ok(())).ok();

                return self.lose(&drawn, (None, true));
            };
            let status = response.status().as_u16();
            let is_busy = refusal == HTTP_REFUSALS.busy && matches!(status, 429 | 503);
            let elapsed = self.clock.monotonic().saturating_sub(first_at);

            if is_busy && is_resent && elapsed < self.settings.exchange_timeout {
                // ! no longer than what is left of its exchange's time, nor than a timer holds: a
                // date far off resends once, as the time runs out
                let asked = retry_after_of(
                    header_of(response.headers(), RETRY_AFTER.as_str()),
                    self.clock.wall(),
                );
                let left = self.settings.exchange_timeout.saturating_sub(elapsed);
                let delay = asked.min(left).min(LONGEST_TIMER);

                drop(response);
                paused_for(&self.clock, (delay, &drawn.ended)).await;

                if !self.is_current(&drawn) {
                    settled.send(Ok(())).ok();

                    return;
                }

                continue;
            }

            // refused by the transport before the router saw it: nothing of it was tried
            settled
                .send(Err(RouterError::Other(Arc::new(io::Error::other(
                    format!("the server refused the exchange: {status} {refusal}"),
                )))))
                .ok();

            // its connection gone, or its exchange lost, still busy past its timeout: told after the
            // refusal is heard, so its caller learns first that it was never tried
            if refusal == HTTP_REFUSALS.connection_unknown || (is_busy && is_resent) {
                platform::yield_now().await;
                self.lose(&drawn, (None, refusal != HTTP_REFUSALS.connection_unknown));
            }

            return;
        }
    }

    // one listen: each envelope heard as it comes whole, `after` advanced before — or what came
    // instead, what fails the connection among it
    async fn listen_once(&self, drawn: &Arc<Drawn>, after: &mut u64) -> Listened {
        let fields = [
            (AFTER_HEADER, after.to_string()),
            (WAIT_HEADER, millis_of(self.settings.wait).to_string()),
        ];
        // * at the connection's one URL, its counts in fields: a moving URL is a preflight each time
        // for a page of another origin, whose browser caches the answer by URL (Fetch §4.9)
        let Some(request) = Self::request_of((Method::GET, drawn), (&fields, None)) else {
            return Listened::Lost;
        };
        let Some(Ok(response)) = unless_ended(&drawn.ended, self.client.request(request)).await
        else {
            return Listened::Lost;
        };

        if response.status() != StatusCode::OK
            || type_of(&response).as_deref() != Some(BEAD_BATCH_MEDIA_TYPE)
        {
            if response.status() == StatusCode::NO_CONTENT {
                return Listened::Nothing;
            }

            return match refusal_of(&response) {
                None => Listened::Lost,
                Some(refusal) if refusal == HTTP_REFUSALS.connection_unknown => Listened::Gone,
                Some(_) => Listened::Refused,
            };
        }

        // numbered from the one after the last it heard, or it is no batch of this listen's
        let next = after.saturating_add(1);

        if integer_of(response.headers(), SEQUENCE_HEADER)
            .and_then(|sequence| u64::try_from(sequence).ok())
            != Some(next)
        {
            return Listened::Failed(unread_of(&format!("its bead-sequence not {next}")));
        }

        let limit = self.settings.maximum_body_bytes;
        let mut body = response.into_body();
        let mut reading = Reading::default();
        let mut heard = 0_u64;

        loop {
            let chunk = match unless_ended(&drawn.ended, chunk_of(&mut body)).await {
                None => return Listened::Heard,
                Some(Ok(Some(chunk))) => chunk,
                Some(Ok(None)) => break,
                // cut on its way: what came whole was heard, and the rest comes again
                Some(Err(_cut)) => {
                    return if heard > 0 {
                        Listened::Heard
                    } else {
                        Listened::Lost
                    };
                }
            };
            let envelopes = match reading.envelopes_of((&chunk, limit)) {
                Ok(envelopes) => envelopes,
                Err(failure) => return Listened::Failed(failure),
            };

            for envelope in envelopes {
                // gone as it was heard: what is left goes unheard
                if !self.is_current(drawn) {
                    return Listened::Heard;
                }

                *after = after.saturating_add(1);
                heard = heard.saturating_add(1);
                self.hear(drawn, (envelope, true));
            }
        }

        // ended where an envelope ends, one at least; anything else is no batch
        if reading.is_within() {
            return Listened::Failed(unread_of("it ends within an envelope"));
        }

        if heard > 0 {
            Listened::Heard
        } else {
            Listened::Failed(unread_of("it holds no envelope"))
        }
    }

    // listened for while the connection stands. A listen lost is listened again from where it was
    // — at once, then later and later — until one reaches the server, or until
    // `inactivity_timeout` has passed since the first was lost: the wait under way ends, and the
    // next listen is the last
    async fn listening(self: Arc<Self>, drawn: Arc<Drawn>) {
        let mut after = 0_u64;
        let mut losses = 0_u32;
        // a timer measures the timeout, never a reading of the clock, which a clock set or a
        // machine woken from sleep moves: the listens it allows are the same on any machine
        let mut expiry: Option<(CancellationToken, Option<Arc<dyn Timer>>)> = None;

        while self.is_current(&drawn) {
            // ! no listen while its router paused it, or while it holds what came: the server's
            // outbox holds the rest, its bound pacing this side (spec 15.9, 15.12)
            self.intake_open(&drawn).await;

            if !self.is_current(&drawn) {
                break;
            }

            let listened = self.listen_once(&drawn, &mut after).await;

            // its connection gone meanwhile — disconnected, disposed: nothing is counted on it
            if !self.is_current(&drawn) {
                break;
            }

            match listened {
                Listened::Lost => {
                    losses = losses.saturating_add(1);

                    let (expired, _) = expiry.get_or_insert_with(|| {
                        let expired = drawn.ended.child_token();
                        let timer = (self.settings.inactivity_timeout != NEVER)
                            .then(|| {
                                let ending = expired.clone();

                                self.clock
                                    .arm(
                                        Schedule::Once(self.settings.inactivity_timeout),
                                        Box::new(move || ending.cancel()),
                                    )
                                    .ok()
                            })
                            .flatten();

                        (expired, timer)
                    });

                    if expired.is_cancelled() {
                        self.lose(&drawn, (None, true));

                        break;
                    }

                    let expired = expired.clone();

                    paused_for(&self.clock, (retry_delay_of(losses), &expired)).await;
                }
                Listened::Failed(failure) => {
                    self.lose(&drawn, (Some(failure), true));

                    break;
                }
                Listened::Gone => {
                    self.lose(&drawn, (None, false));

                    break;
                }
                Listened::Refused => {
                    self.lose(&drawn, (None, true));

                    break;
                }
                Listened::Heard | Listened::Nothing => {
                    // it reached the server: the count ends, and its timeout with it
                    if let Some((_, Some(timer))) = expiry.take() {
                        timer.cancel();
                    }

                    losses = 0;

                    if matches!(listened, Listened::Nothing) {
                        paused_for(&self.clock, (self.settings.pause, &drawn.ended)).await;
                    }
                }
            }
        }

        // the connection's end disarms it, so nothing fires after
        if let Some((_, Some(timer))) = expiry {
            timer.cancel();
        }
    }

    // the connection drawn by a connect to `options`
    async fn drawing(
        &self,
        options: &HttpTransportClientConnectOptions,
    ) -> Result<Arc<Drawn>, TransportError> {
        let (host, _) = host_of(&options.host)?;
        let is_secured = options.secured.unwrap_or(false);
        let pathname = options.pathname.as_deref().unwrap_or(PATHNAME);
        let path = format!("/{}", pathname.trim_start_matches('/'));
        let scheme = if is_secured { "https" } else { "http" };
        let url = format!("{scheme}://{host}:{}{path}", options.port)
            .parse::<Uri>()
            .map_err(|refused| {
                TransportError::Connect(ConnectError::caused(
                    format!("{host} and {path} make no URL"),
                    Arc::new(refused),
                ))
            })?;
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(url.clone())
            .header(CONTENT_TYPE, BEAD_MEDIA_TYPE);

        if self.settings.is_listening {
            request = request.header(LISTEN_HEADER, "?1");
        }

        let request = request
            .body(Sending(Some(Bytes::new())))
            .map_err(|refused| {
                TransportError::Connect(ConnectError::caused(
                    "the connect makes no request",
                    Arc::new(refused),
                ))
            })?;
        let response = self.client.request(request).await.map_err(connect_error)?;
        let status = response.status();

        // its status alone, its mark unread
        if is_redirect(status) {
            return Err(TransportError::Connect(ConnectError::new(format!(
                "the server drew no connection: {}",
                status.as_u16()
            ))));
        }

        let token = header_of(response.headers(), CONNECTION_TOKEN_HEADER).map(str::to_owned);
        let Some(token) = token.filter(|_| status == StatusCode::CREATED) else {
            // its status, and its reason where the server marked it (spec 15.6)
            let refused = header_of(response.headers(), REFUSAL_HEADER).map_or_else(
                || status.as_u16().to_string(),
                |mark| format!("{} {mark}", status.as_u16()),
            );

            return Err(TransportError::Connect(ConnectError::new(format!(
                "the server drew no connection: {refused}"
            ))));
        };

        Ok(Arc::new(Drawn {
            url,
            token,
            // taken where the server said it back, and nowhere else
            is_listening: self.settings.is_listening && is_true(response.headers(), LISTEN_HEADER),
            ended: CancellationToken::new(),
        }))
    }

    // an attempt run to its end: drawn, or failed, timed out, cancelled or given up, whichever
    // comes first; what it drew once it was ended is let go with it
    async fn attempted(
        self: Arc<Self>,
        (attempt, options): (Arc<Attempt>, HttpTransportClientConnectOptions),
        reply: oneshot::Sender<Result<(), TransportError>>,
    ) {
        let timeout = attempt.timeout;
        let timer = locked(&attempt.timer).take();
        let (armed, timed_out) =
            timer.map_or((None, None), |(timer, wait)| (Some(timer), Some(wait)));
        let signal = options.signal.clone().unwrap_or_default();
        let mut drawing: BoxFuture<Result<Arc<Drawn>, TransportError>> = {
            let inner = Arc::clone(&self);
            let options = options.clone();

            Box::pin(async move { inner.drawing(&options).await })
        };
        let mut is_settled = false;
        let outcome = {
            let mut cancelled = pin!(signal.cancelled());
            let mut given_up = pin!(attempt.given_up.cancelled());
            let mut timed_out = timed_out;

            poll_fn(|context| {
                if cancelled.as_mut().poll(context).is_ready() {
                    return Poll::Ready(Err(TransportError::cancelled(CANCELLED)));
                }

                if given_up.as_mut().poll(context).is_ready() {
                    return Poll::Ready(Err(TransportError::Connect(ConnectError::new(DISPOSED))));
                }

                if let Some(wait) = timed_out.as_mut()
                    && Pin::new(wait).poll(context).is_ready()
                {
                    return Poll::Ready(Err(TransportError::TimedOut(timeout)));
                }

                let drawn = drawing.as_mut().poll(context);

                is_settled = drawn.is_ready();

                drawn
            })
            .await
        };

        // * given up as it came — timed out, cancelled, disposed — its exchange still goes on, its
        // server's answer awaited on the platform's clock as a disconnect's: the connection drawn
        // meanwhile is let go, and the server told
        if !is_settled {
            self.release_late(drawing);
        }

        if let Some(timer) = armed {
            timer.cancel();
        }

        self.settle((&attempt, outcome), reply);
    }

    // a connect given up whose exchange goes on: what it draws is let go, told by a DELETE; its
    // server's answer awaited DISCONNECT_TIMEOUT at most, on the platform's clock
    fn release_late(&self, drawing: BoxFuture<Result<Arc<Drawn>, TransportError>>) {
        let Some(inner) = self.me.upgrade() else {
            return;
        };
        let bound = timer_of(&self.platform, DISCONNECT_TIMEOUT)
            .map_or((None, None), |(timer, wait)| (Some(timer), Some(wait)));

        drop(platform::spawn(&self.runtime, async move {
            let (timer, mut wait) = bound;
            let mut drawing = drawing;
            let drawn = poll_fn(|context| {
                if wait
                    .as_mut()
                    .is_some_and(|wait| Pin::new(wait).poll(context).is_ready())
                {
                    return Poll::Ready(None);
                }

                drawing.as_mut().poll(context).map(Some)
            })
            .await;

            if let Some(timer) = timer {
                timer.cancel();
            }

            if let Some(Ok(drawn)) = drawn {
                inner.release(&drawn);
            }
        }));
    }

    // the connect settles: open, unless given up on meanwhile, which lets go of what it drew
    fn settle(
        &self,
        (attempt, outcome): (&Arc<Attempt>, Result<Arc<Drawn>, TransportError>),
        reply: oneshot::Sender<Result<(), TransportError>>,
    ) {
        let mut state = locked(&self.state);
        let is_current = state
            .attempt
            .as_ref()
            .is_some_and(|held| Arc::ptr_eq(held, attempt));

        if is_current {
            state.attempt = None;
        }

        let outcome = match outcome {
            Ok(drawn) if !is_current || attempt.given_up.is_cancelled() => {
                drop(state);
                self.release(&drawn);
                state = locked(&self.state);

                Err(TransportError::Connect(ConnectError::new(DISPOSED)))
            }
            outcome => outcome,
        };

        match outcome {
            Err(reason) => {
                if is_current && state.ready != ReadyState::Reconnecting {
                    state.ready = ReadyState::Closed;
                }

                drop(state);
                reply.send(Err(reason)).ok();
            }
            Ok(drawn) => {
                state.drawn = Some(Arc::clone(&drawn));
                state.ready = ReadyState::Open;
                drop(state);

                if drawn.is_listening
                    && let Some(inner) = self.me.upgrade()
                {
                    drop(platform::spawn(&self.runtime, inner.listening(drawn)));
                }

                reply.send(Ok(())).ok();
            }
        }
    }

    // gives up on the connect under way, and lets go of its connection, told by a DELETE nobody
    // waits on: what it ends tells nothing
    fn drop_all(&self) {
        let (attempt, drawn) = {
            let mut state = locked(&self.state);
            let attempt = state.attempt.take();
            let drawn = state.drawn.take();

            state.hold.held.clear();

            if matches!(state.ready, ReadyState::Open | ReadyState::Connecting) {
                state.ready = ReadyState::Closed;
            }

            drop(state);

            (attempt, drawn)
        };

        if let Some(attempt) = attempt {
            attempt.given_up.cancel();
        }

        if let Some(drawn) = drawn {
            drawn.ended.cancel();
            self.release(&drawn);
        }

        self.intake.notify_waiters();
    }
}

impl HttpTransportClient {
    /// A transport client, not yet connected, its options held.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for a duration spec 1.4 does not hold; a bound of 0; for a `tls` beside a
    /// `client_config`, or one that does not read (spec 15.39).
    pub fn new(options: &HttpTransportClientOptions) -> Result<Self, ProgrammerError> {
        let runtime =
            platform::socket_runtime_of(options.runtime.as_ref(), "an HTTP transport client")?;
        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));

        Self::on_platform((runtime, platform), options)
    }

    // a client on `runtime`, its timers that bound the platform's socket on `platform`: the
    // platform's clock, but in a test
    fn on_platform(
        (runtime, platform): (Handle, SharedClock),
        options: &HttpTransportClientOptions,
    ) -> Result<Self, ProgrammerError> {
        let settings = Settings {
            exchange_timeout: hold(
                "exchangeTimeout",
                options.exchange_timeout.unwrap_or(EXCHANGE_TIMEOUT),
            )?,
            inactivity_timeout: hold(
                "inactivityTimeout",
                options.inactivity_timeout.unwrap_or(INACTIVITY_TIMEOUT),
            )?,
            is_listening: options.is_listening.unwrap_or(true),
            maximum_body_bytes: hold_count(
                "maximumBodyBytes",
                options.maximum_body_bytes.unwrap_or(MAXIMUM_BODY_BYTES),
            )?,
            // 0 is at once: a listen again at once, and a listen the server answers at once, which
            // polls
            pause: hold_delay("pause", options.pause.unwrap_or(Duration::ZERO))?,
            wait: hold_delay("wait", options.wait.unwrap_or(WAIT))?,
        };
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform));
        let connector = Connector::new(
            client_tls_of(
                options.client_config.as_ref(),
                options.tls.as_ref().unwrap_or(&NO_TLS),
            )?,
            &RacingOptions::on(Arc::clone(&platform)),
        );
        // * HTTP/1.1 alone, a pooled connection let go once idle on Bead's timer, its executor
        // Bead's; a request no byte of which was written, on a reused connection found closed, sent
        // again: its server never saw it
        let client = Client::builder(Spawner::on(runtime.clone()))
            .pool_timer(HyperTimer::on(runtime.clone()))
            .pool_idle_timeout(POOL_IDLE_TIMEOUT)
            .retry_canceled_requests(true)
            .set_host(true)
            .build(connector);

        Ok(Self {
            inner: Arc::new_cyclic(|me| ClientInner {
                me: Weak::clone(me),
                runtime,
                platform,
                clock,
                given: options.clock.clone(),
                settings,
                client,
                state: Mutex::new(ClientState {
                    ready: ReadyState::Uninitialized,
                    last_connect: None,
                    is_attempting: false,
                    attempt: None,
                    drawn: None,
                    is_secure: false,
                    hold: Hold::default(),
                }),
                intake: Notify::new(),
                listeners: Listeners::default(),
            }),
        })
    }

    /// Connects to its server, started as it is called: open once its server drew a connection,
    /// answering 201 with its token.
    pub fn connect(&self, options: &HttpTransportClientConnectOptions) -> Connect {
        match self.start_connect(options) {
            Ok(outcome) => Connect::of(outcome),
            Err(error) => Connect::refused(error),
        }
    }

    fn start_connect(
        &self,
        options: &HttpTransportClientConnectOptions,
    ) -> Result<oneshot::Receiver<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;
        let timeout = hold(
            "a connect's timeout",
            options.timeout.unwrap_or(CONNECT_TIMEOUT),
        )?;
        let attempt = {
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
            state.last_connect = Some(HttpTransportClientConnectOptions {
                signal: None,
                ..options.clone()
            });

            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::cancelled(CANCELLED));
            }

            if state.ready != ReadyState::Reconnecting {
                state.ready = ReadyState::Connecting;
            }

            state.is_secure = is_secure(options.secured.unwrap_or(false), Some(&options.host));

            // * armed as the connect is asked, on its clock: whoever moves the clock once the
            // connect returned moves it past its timeout
            let attempt = Arc::new(Attempt {
                given_up: CancellationToken::new(),
                timeout,
                timer: Mutex::new(timer_of(&inner.clock, timeout)),
            });

            state.attempt = Some(Arc::clone(&attempt));

            attempt
        };
        let (reply, outcome) = oneshot::channel();

        drop(platform::spawn(
            &inner.runtime,
            Arc::clone(inner).attempted((attempt, options.clone()), reply),
        ));

        Ok(outcome)
    }

    /// Deletes its connection and tells its close, which says it was clean and quick as its
    /// options say: the server ends it first, so what waits there learns it, its `DELETE` waited on
    /// 5 seconds at most on the platform's clock; or, quick, at once, its `DELETE`
    /// unwaited. What its connection still had under way ends. It ends closed. Its close starts as
    /// it is called, the future only waiting for its end.
    ///
    /// # Errors
    ///
    /// A [`TransportError::ReadyState`] when it is not open, refused as it is called, nothing
    /// changed.
    #[expect(
        clippy::same_name_method,
        reason = "the router's disconnect, of its own accord, is this one with its default options, named as on the other sides"
    )]
    pub fn disconnect(
        &self,
        options: &TransportClientDisconnectOptions,
    ) -> Result<BoxFuture<()>, TransportError> {
        let inner = &self.inner;
        let is_clean = options.is_clean.unwrap_or(true);
        let is_quick = options.is_quick.unwrap_or(false);
        let drawn = {
            let mut state = locked(&inner.state);
            let drawn = if state.ready == ReadyState::Open {
                state.drawn.take()
            } else {
                None
            };
            let Some(drawn) = drawn else {
                return Err(TransportError::ReadyState(ReadyStateError::new(
                    state.ready,
                    ReadyState::Open,
                )));
            };

            state.hold.held.clear();
            state.ready = if is_quick {
                ReadyState::Closed
            } else {
                ReadyState::Closing
            };

            drawn
        };

        inner.intake.notify_waiters();

        if is_quick {
            drawn.ended.cancel();
            inner.release(&drawn);
            inner.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, true));

            return Ok(Box::pin(async {}));
        }

        let deleting = ClientInner::request_of((Method::DELETE, &drawn), (&[], None))
            .map(|request| inner.client.request(request));
        let client = Arc::clone(inner);
        let (done, ended) = oneshot::channel();

        drop(platform::spawn(&inner.runtime, async move {
            // ! its bound is the platform's, as a close handshake's: it bounds the platform's own
            // exchange with a server that does not answer (decision 0011)
            if let Some(deleting) = deleting {
                let (timer, wait) = timer_of(&client.platform, DISCONNECT_TIMEOUT)
                    .map_or((None, None), |(timer, wait)| (Some(timer), Some(wait)));
                let mut deleting = pin!(deleting);
                let mut wait = wait;

                poll_fn(|context| {
                    let is_bounded = wait
                        .as_mut()
                        .is_some_and(|wait| Pin::new(wait).poll(context).is_ready());

                    if is_bounded || deleting.as_mut().poll(context).is_ready() {
                        return Poll::Ready(());
                    }

                    Poll::Pending
                })
                .await;

                if let Some(timer) = timer {
                    timer.cancel();
                }
            }

            drawn.ended.cancel();

            {
                let mut state = locked(&client.state);

                if state.ready == ReadyState::Closing {
                    state.ready = ReadyState::Closed;
                }
            }

            client.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, false));
            done.send(()).ok();
        }));

        Ok(Box::pin(async move {
            ended.await.ok();
        }))
    }

    /// Lets go of its connection at once, told by a `DELETE` nobody waits on, and of a connect
    /// under way, which fails; nothing is told. A reconnection under way is not stopped by it, only
    /// the attempt it is making: cancel its signal.
    pub fn dispose(&self) {
        self.inner.drop_all();
    }

    /// Disconnects cleanly when it is open, as its disconnect does, telling its close, then lets go
    /// of everything, as its dispose does; not open, it lets go at once. It starts as it is called,
    /// the future only waiting for its end.
    pub fn close(&self) -> BoxFuture<()> {
        let Ok(closing) = self.disconnect(&TransportClientDisconnectOptions::default()) else {
            self.inner.drop_all();

            return Box::pin(async {});
        };
        let inner = Arc::clone(&self.inner);
        let (done, ended) = oneshot::channel();

        drop(platform::spawn(&self.inner.runtime, async move {
            closing.await;
            inner.drop_all();
            done.send(()).ok();
        }));

        Box::pin(async move {
            ended.await.ok();
        })
    }

    /// Connects again with the options of the last connect its guard let through, replacing an
    /// open connection without a close, its server told by a `DELETE` nobody waits on, and tells
    /// `on_reconnect` as it starts. The first attempt goes at once, each next one after its delay;
    /// attempts that run out end it closed, with a [`TransportError::Reconnect`]; a cancel stops
    /// them, ending it closed, and one after an attempt opened disconnects, which tells a close.
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
        let (target, replaced) = {
            let mut state = locked(&inner.state);

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

            // before the drop below, so a signal cancelled already leaves an open connection alone
            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::cancelled(RECONNECTION_CANCELLED));
            }

            // taken out as it turns to reconnecting, so its end, however soon, tells nothing
            let replaced = state.drawn.take();

            state.hold.held.clear();
            state.ready = ReadyState::Reconnecting;
            drop(state);

            (target, replaced)
        };

        // each listener within its guard, its panic reported; the connection replaced goes
        // whatever a listener does
        inner.tell(|listener: &dyn ClientListener| listener.on_reconnect());

        if let Some(replaced) = replaced {
            replaced.ended.cancel();
            inner.release(&replaced);
        }

        let (reply, outcome) = oneshot::channel();
        let client = self.clone();
        let options = options.clone();

        drop(platform::spawn(&inner.runtime, async move {
            let reconnected = client.reconnecting((target, options)).await;

            if reconnected.is_err() {
                locked(&client.inner.state).ready = ReadyState::Closed;
            }

            reply.send(reconnected).ok();
        }));

        Ok(Box::pin(async move {
            outcome
                .await
                .unwrap_or_else(|_dropped| Err(TransportError::cancelled(RECONNECTION_CANCELLED)))
        }))
    }

    async fn reconnecting(
        &self,
        (target, options): (
            HttpTransportClientConnectOptions,
            TransportClientReconnectOptions,
        ),
    ) -> Result<(), TransportError> {
        let inner = &self.inner;

        attempting((&inner.clock, &options), |signal| {
            locked(&inner.state).is_attempting = true;

            let connecting = self.connect(&HttpTransportClientConnectOptions {
                signal,
                ..target.clone()
            });

            locked(&inner.state).is_attempting = false;

            connecting
        })
        .await?;

        // the last attempt opened as its signal was cancelled: what it opened goes with it
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

impl RouterClientTransport for HttpTransportClient {
    // each envelope an exchange of its own, settled on the head of its answer
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let inner = &self.inner;
        let drawn = {
            let state = locked(&inner.state);

            match (&state.drawn, state.ready) {
                (Some(drawn), ReadyState::Open) => Arc::clone(drawn),
                (_, ready) => {
                    return Err(refused_unless_open(ready));
                }
            }
        };

        // refused before it goes, the connection kept: a field could not carry it as it is, and
        // one with a space or a tab first or last the server would read trimmed
        if message
            .credential
            .as_deref()
            .is_some_and(|credential| !is_field_value(credential))
        {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(
                NO_FIELD_VALUE,
            ))));
        }

        let (settled, outcome) = oneshot::channel();

        drop(platform::spawn(
            &inner.runtime,
            Arc::clone(inner).exchanging((drawn, message), settled),
        ));

        Ok(Sent::Later(Box::pin(async move {
            outcome.await.unwrap_or(Ok(()))
        })))
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.inner.listeners.remove(listener);
    }

    // * its close starts as it is called, the future only waiting for its end; not open, nothing
    fn disconnect(&self) {
        drop(Self::disconnect(
            self,
            &TransportClientDisconnectOptions::default(),
        ));
    }

    // ! no listen asked while paused: what an answer or a batch already read brought is held, in
    // order
    fn pause(&self) {
        locked(&self.inner.state).hold.is_paused = true;
    }

    // what it held handed on from a step of its own, its listen asked again once nothing is held
    fn resume(&self) {
        let inner = &self.inner;
        let is_handing = {
            let hold = &mut locked(&inner.state).hold;

            hold.is_paused = false;

            let is_handing = !hold.is_handing && !hold.held.is_empty();

            hold.is_handing = hold.is_handing || is_handing;

            is_handing
        };

        if is_handing {
            drop(platform::spawn(&inner.runtime, Arc::clone(inner).handing()));
        } else {
            inner.intake.notify_waiters();
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    // by the URL its last connect named: under `https`, or to a host on the loopback
    fn is_secure(&self) -> bool {
        locked(&self.inner.state).is_secure
    }

    // * any field value, in each `POST`'s `Authorization`
    fn carries(&self, credential: &str) -> bool {
        is_field_value(credential)
    }

    fn ready_state(&self) -> ReadyState {
        locked(&self.inner.state).ready
    }
}
