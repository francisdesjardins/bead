//! A transport client over one WebSocket connection (RFC 6455), as the other sides'
//! `createWebSocketTransportClient` and `WebSocketTransportClient` hold it: its connect races the
//! addresses of its host (RFC 8305), speaks TLS under `wss`, writes its credential on its upgrade,
//! and names a refused upgrade by its status and its mark; once open, one envelope per binary
//! message, what goes out in order.

use core::fmt;
use core::future::{Future, poll_fn};
use core::pin::{Pin, pin};
use core::task::{Context, Poll};
use core::time::Duration;
use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use http::header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL};
use http::{HeaderValue, Response};
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch};
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tungstenite::client::IntoClientRequest;
use tungstenite::error::Error as WsError;

use crate::HEARTBEAT;
use crate::clock::{Schedule, SharedClock, SystemClock, Timer};
use crate::constants::{ProtocolCode, RouterSide};
use crate::duration::{NEVER, hold};
use crate::errors::{ConnectError, ProgrammerError, ReadyStateError, TransportError};
use crate::failure::Failure;
use crate::judgement::security::is_secure;
use crate::judgement::url_host::url_host_of;
use crate::net::bounds::hold_count;
use crate::net::racing::{RacingOptions, connect_racing};
use crate::net::tls::{connect_tls, upgrade_config_of};
use crate::platform::{self, Handle};
use crate::router::types::{BoxFuture, RouterError, TransportMessage};
use crate::transport::{
    ClientListener, Connect, Listeners, RECONNECTION_CANCELLED, ReadyState, RouterClientTransport,
    Sent, TransportClientDisconnectOptions, TransportClientReconnectOptions, attempting, caught,
    caught_future, hold_reconnection, is_field_value,
};
use crate::websocket::connection::{
    CLOSE_TIMEOUT, Commands, Connection, ConnectionBounds, ConnectionHooks, Ended, Failed,
    GOING_AWAY, MAXIMUM_MESSAGE_BYTES, NORMAL, Wire, config_of,
};
use crate::websocket::heartbeat::{Heartbeat, HeartbeatHooks, hold_heartbeat};

#[cfg(test)]
mod tests;

// how long a connect waits for its server when it names no timeout, as the other sides' WebSocket
// clients wait
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

// the path a connect asks for when it names none
const PATHNAME: &str = "/";

// what a connect given up by its client's dispose says
const DISPOSED: &str = "the transport client was disposed as it connected";

// what a connect its signal gave up says
const CANCELLED: &str = "the connect was cancelled";

// the field that marks a refusal of a transport's own (spec 15.6)
const REFUSAL_HEADER: &str = "bead-refusal";

// what a credential that no field can carry is refused with
const NO_FIELD_VALUE: &str =
    "a credential holds visible ASCII, spaces and tabs alone, none first or last";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a connect's credential provider fails with.
pub type CredentialProviderError = Box<dyn Error + Send + Sync>;

/// What hands the credential an attempt's upgrade carries.
///
/// Called at each attempt — the connect's, and each of a reconnection's — before its upgrade goes,
/// given a signal cancelled once the attempt ends, opened or not: a renewed credential reaches the
/// next connection.
pub type CredentialProvider = Arc<
    dyn Fn(CancellationToken) -> BoxFuture<Result<String, CredentialProviderError>> + Send + Sync,
>;

/// How a WebSocket transport client holds its connection.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct WebSocketTransportClientOptions {
    /// The clock the stack built on it runs on, a connect's timeout and a reconnection's delays
    /// among it: the platform's when none. Its close timeout and its heartbeat run on the
    /// platform's clock, whatever it is given, since they bound what the platform's socket does
    /// (decision 0011).
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
    /// How long a close it begins waits for its server's answer before it drops the socket:
    /// [`CLOSE_TIMEOUT`] when none; [`crate::NEVER`] waits without end, arming no timer.
    pub close_timeout: Option<Duration>,
    /// How often its connection is pinged, past which one that left a ping unanswered is dropped:
    /// [`HEARTBEAT`] when none; [`crate::NEVER`] beats none.
    pub heartbeat: Option<Duration>,
    /// The largest message it reads, past which it fails its connection with 1009 (spec 15.3):
    /// [`MAXIMUM_MESSAGE_BYTES`] when none.
    pub maximum_message_bytes: Option<u64>,
    /// The TLS a secured connect speaks, which a copy of offers HTTP/1.1 alone by ALPN: rustls's
    /// over aws-lc-rs, the platform's verifier judging its server, when none.
    pub tls: Option<Arc<ClientConfig>>,
}

/// Where a client connects — `ws://host:port/pathname`, or `wss://` when secured — what it offers
/// there, and how long it waits.
#[derive(Clone)]
#[non_exhaustive]
pub struct WebSocketTransportClientConnectOptions {
    /// The server's host: a name, which is turned to ASCII as the URL Standard's host parser reads
    /// it (UTS #46) and resolved, or an IP address, an IPv6 one bracketed or not.
    pub host: String,
    /// The server's port.
    pub port: u16,
    /// The path the server listens on, given a single leading slash: `/` when none.
    pub pathname: Option<String>,
    /// Whether the connection is over TLS: `false` when none.
    pub secured: Option<bool>,
    /// How long it waits for its server: 30 seconds when none; [`NEVER`] waits without end.
    pub timeout: Option<Duration>,
    /// What gives the connect up: one cancelled already refuses it before anything moves. Its own
    /// connect's alone: a reconnection replays the rest of these options, never this signal.
    pub signal: Option<CancellationToken>,
    /// The credential its upgrade carries, written as given in its `Authorization` (spec 15.2),
    /// which its server hands beside every envelope of the connection; an empty one is none.
    /// Visible ASCII, spaces and tabs, none first or last (RFC 9110 §5.5), over `wss` or to a host
    /// on the loopback (spec 13.4): any other, or one given beside `credential_provider`, is refused
    /// as the connect is asked, nothing changed.
    pub credential: Option<String>,
    /// What hands the credential its upgrade carries, at each attempt, held to the rules of
    /// `credential` as the connect is asked. One call is pending per provider at a time: another
    /// attempt with the same provider waits for its earlier call to settle, then calls anew. What it
    /// fails with fails that attempt, its cause; a value that is no field value is refused, which a
    /// reconnection does not try again.
    pub credential_provider: Option<CredentialProvider>,
    /// The subprotocols its upgrade offers: none when none.
    pub protocols: Option<Vec<String>>,
}

impl WebSocketTransportClientConnectOptions {
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
            credential: None,
            credential_provider: None,
            protocols: None,
        }
    }
}

impl fmt::Debug for WebSocketTransportClientConnectOptions {
    // ! whether it carries a credential, never the credential
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketTransportClientConnectOptions")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("pathname", &self.pathname)
            .field("secured", &self.secured)
            .field("timeout", &self.timeout)
            .field("has_credential", &self.credential.is_some())
            .field(
                "has_credential_provider",
                &self.credential_provider.is_some(),
            )
            .field("protocols", &self.protocols)
            .finish_non_exhaustive()
    }
}

// ── Its socket ───────────────────────────────────────────────────────────────────────────────

/// A client's socket: in the clear, or under TLS.
enum ClientSocket {
    Plain(TcpStream),
    Secured(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for ClientSocket {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_read(context, buffer),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for ClientSocket {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_write(context, bytes),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_write(context, bytes),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_flush(context),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_flush(context),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_shutdown(context),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_shutdown(context),
        }
    }
}

impl Wire for ClientSocket {
    fn abort(&self) {
        match self {
            Self::Plain(socket) => socket.abort(),
            Self::Secured(socket) => socket.get_ref().0.abort(),
        }
    }
}

// ── Its state ────────────────────────────────────────────────────────────────────────────────

// what it was built with, held
#[derive(Debug)]
struct Settings {
    close_timeout: Duration,
    heartbeat: Duration,
    maximum_message_bytes: u64,
    tls: Option<Arc<ClientConfig>>,
}

// a timer armed, and its wait
type Armed = (Arc<dyn Timer>, oneshot::Receiver<()>);

// a connect under way: given up once its client is disposed; its timeout, armed as it was asked
struct Attempt {
    given_up: CancellationToken,
    timeout: Duration,
    timer: Mutex<Option<Armed>>,
}

// the open connection: what it is asked by, its heartbeat, and the credential its upgrade carried
struct Open {
    serial: u64,
    commands: Commands,
    heartbeat: Heartbeat,
    carried: Option<String>,
}

// a close handshake under way on the open connection: what its close says, and its end to tell
// its waiter of
struct Disconnecting {
    serial: u64,
    is_clean: bool,
    done: oneshot::Sender<()>,
}

struct ClientState {
    ready: ReadyState,
    // the options of the last connect its guard let through, without their signal
    last_connect: Option<WebSocketTransportClientConnectOptions>,
    is_attempting: bool,
    attempt: Option<Arc<Attempt>>,
    serial: u64,
    current: Option<Open>,
    disconnecting: Option<Disconnecting>,
    // * paused whole by its router, a pause outlasting its connection (spec 15.12)
    is_paused: bool,
}

// a provider's call under way, which an attempt after it waits on before it calls anew
#[derive(Clone)]
struct Pending {
    call: u64,
    settled: watch::Receiver<bool>,
}

pub(crate) struct ClientInner {
    me: Weak<Self>,
    runtime: Handle,
    // the platform's clock, which its timers that bound the platform's socket run on
    platform: SharedClock,
    // the clock its connect's timeout runs on, and the one it was given
    clock: SharedClock,
    given: Option<SharedClock>,
    settings: Settings,
    racing: RacingOptions,
    // the TLS its secured connects speak, built at the first
    upgrade_tls: Mutex<Option<Arc<ClientConfig>>>,
    state: Mutex<ClientState>,
    listeners: Listeners<dyn ClientListener>,
    // one call per provider, by its identity; an earlier attempt's outcome serves none after it
    pending: Mutex<(u64, HashMap<usize, Pending>)>,
}

// a connection opened, its credential with it
struct Opened {
    socket: WebSocketStream<ClientSocket>,
    credential: Option<String>,
}

/// A transport client over one WebSocket connection: one envelope per binary message, what goes
/// out in order, one message at a time.
///
/// It goes from [`ReadyState::Uninitialized`] through connecting and open to closing and closed,
/// and connects again once closed. Its connect races the addresses of its host, its families
/// interleaved, an attempt every 250 ms on the platform's clock (RFC 8305); under `wss`, speaks TLS
/// on rustls, the platform's verifier judging its server; writes no `Origin`, offers no extension,
/// and writes its credential, or what its provider hands at each attempt, in its upgrade's
/// `Authorization`, which it carries beside every envelope of that connection. It follows no
/// redirect: an upgrade answered with anything but 101 fails its connect, named by its status and
/// its mark, "the server refused the upgrade: 403 host-refused" (spec 15.6). Its connect's timeout
/// runs on its clock; a connect given up by its timeout, its signal or its dispose drops what it
/// opened.
///
/// Once open, each binary message is handed on `on_message`; a text message is
/// `ENVELOPE_MALFORMED`, reported on `on_error`, handed nothing. A message past
/// `maximum_message_bytes` fails its connection with 1009, reported on `on_error` naming
/// `maximumMessageBytes`, then its unclean close; a protocol error is reported alike, failed with
/// 1002. A server gone without its closing handshake tells its unclean close alone.
///
/// Its connection is pinged every `heartbeat` on the platform's clock, and dropped, its close
/// unclean and no error told, at the beat after a ping it left unanswered. Its disconnect closes
/// with 1000 and waits on its server's answer `close_timeout` at most, then drops the socket, its
/// close told as the disconnect said. Paused by its router, it reads no more of its socket, so
/// TCP's window paces its server, a pause outlasting its connection; a close it begins reads on to
/// its server's Close (spec 15.12). Its reconnection connects again with the options of its last
/// connect, replacing an open connection without a close.
#[derive(Clone)]
pub struct WebSocketTransportClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for WebSocketTransportClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketTransportClient")
            .field("ready_state", &locked(&self.inner.state).ready)
            .finish_non_exhaustive()
    }
}

// a connect's credential, refused before anything moves: one a field cannot carry as it is, one
// beside a provider, and one its upgrade would carry off the machine in the clear (spec 13.4), the
// upgrade being where it would cross
fn assert_credential(
    options: &WebSocketTransportClientConnectOptions,
) -> Result<(), ProgrammerError> {
    if options.credential.is_some() && options.credential_provider.is_some() {
        return Err(ProgrammerError::new(
            "a connect takes a credential or a credential provider, not both",
        ));
    }

    if let Some(credential) = &options.credential
        && !is_field_value(credential)
    {
        return Err(ProgrammerError::new(NO_FIELD_VALUE));
    }

    if (options.credential.is_some() || options.credential_provider.is_some())
        && !is_secure(options.secured.unwrap_or(false), Some(&options.host))
    {
        return Err(ProgrammerError::new(
            "a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback",
        ));
    }

    Ok(())
}

// the host a connect names, as the URL Standard's host parser reads it, an IPv6 one bracketed:
// what its URL writes, and what it resolves or connects to, bare
fn host_of(host: &str) -> Result<(String, String), TransportError> {
    let bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let Some(parsed) = url_host_of(&bracketed) else {
        return Err(TransportError::Connect(ConnectError::new(format!(
            "{host} is no host a URL can name"
        ))));
    };
    let bare = parsed
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(&parsed)
        .to_owned();

    Ok((parsed, bare))
}

// what a refused upgrade is named by: its status, then its mark where it has one (spec 15.6)
fn refusal_of(response: &Response<Option<Vec<u8>>>) -> String {
    let status = response.status().as_u16();

    response
        .headers()
        .get(REFUSAL_HEADER)
        .and_then(|mark| mark.to_str().ok())
        .map_or_else(|| status.to_string(), |mark| format!("{status} {mark}"))
}

// what an upgrade that did not open failed with
fn upgrade_error(error: WsError) -> TransportError {
    if let WsError::Http(response) = error {
        return TransportError::Connect(ConnectError::new(format!(
            "the server refused the upgrade: {}",
            refusal_of(&response)
        )));
    }

    let message = error.to_string();

    TransportError::Connect(ConnectError::caused(message, Arc::new(error)))
}

fn connect_error(error: io::Error) -> TransportError {
    let message = error.to_string();

    TransportError::Connect(ConnectError::caused(message, Arc::new(error)))
}

// a connection's end, as an error, when this side failed it of its own
fn failure_of(failed: &Failed) -> RouterError {
    let message = match failed {
        Failed::TooBig(maximum) => format!(
            "the connection is closed with 1009: a message past its maximumMessageBytes, {maximum} bytes"
        ),
        Failed::Protocol(why) => format!("the connection is closed with 1002: {why}"),
        Failed::Dropped(why) => format!("the connection is dropped: {why}"),
    };

    RouterError::Other(Arc::new(io::Error::other(message)))
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

    fn report(&self, error: &RouterError) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics is dropped, as its throw goes to no one
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener.on_error(error)))
                .ok();
        }
    }

    // the TLS a secured connect speaks: the one given, or the platform's, built once
    fn upgrade_tls(&self) -> Result<Arc<ClientConfig>, TransportError> {
        let mut held = locked(&self.upgrade_tls);

        if let Some(config) = held.as_ref() {
            return Ok(Arc::clone(config));
        }

        let config = upgrade_config_of(self.settings.tls.as_ref()).map_err(|refused| {
            let message = refused.to_string();

            TransportError::Connect(ConnectError::caused(message, Arc::new(refused)))
        })?;

        *held = Some(Arc::clone(&config));
        drop(held);

        Ok(config)
    }

    // the credential an attempt's upgrade carries: the one given, or what its provider hands, one
    // call per provider at a time; none for an empty one
    async fn credential_of(
        &self,
        (options, signal): (&WebSocketTransportClientConnectOptions, &CancellationToken),
    ) -> Result<Option<String>, TransportError> {
        let credential = match &options.credential_provider {
            None => options.credential.clone(),
            Some(provider) => Some(self.provided(provider, signal).await?),
        };

        Ok(credential.filter(|credential| !credential.is_empty()))
    }

    async fn provided(
        &self,
        provider: &CredentialProvider,
        signal: &CancellationToken,
    ) -> Result<String, TransportError> {
        let key = Arc::as_ptr(provider).cast::<()>().addr();

        loop {
            // an abandoned call settles before another starts; its outcome serves nothing
            let pending = locked(&self.pending).1.get(&key).cloned();

            if let Some(mut pending) = pending {
                pending.settled.wait_for(|settled| *settled).await.ok();

                continue;
            }

            let (settle, settled) = watch::channel(false);
            let call = {
                let mut pending = locked(&self.pending);

                pending.0 = pending.0.saturating_add(1);

                let call = pending.0;

                pending.1.insert(key, Pending { call, settled });

                call
            };
            let (answer, answered) = oneshot::channel();
            // * the call published before the provider runs, which runs outside the client's lock
            let asked = caught(("a credential provider", || provider(signal.clone())));
            let me = Weak::clone(&self.me);

            drop(platform::spawn(&self.runtime, async move {
                let outcome = match asked {
                    Ok(providing) => caught_future(("a credential provider", providing))
                        .await
                        .unwrap_or_else(|panicked| Err(CredentialProviderError::from(panicked))),
                    Err(panicked) => Err(CredentialProviderError::from(panicked)),
                };

                if let Some(inner) = me.upgrade() {
                    let mut pending = locked(&inner.pending);

                    if pending.1.get(&key).is_some_and(|held| held.call == call) {
                        pending.1.remove(&key);
                    }
                }

                settle.send_replace(true);
                answer.send(outcome).ok();
            }));

            return match answered.await {
                Ok(Ok(credential)) if is_field_value(&credential) => Ok(credential),
                Ok(Ok(_)) => Err(TransportError::Refused(ProgrammerError::new(
                    NO_FIELD_VALUE,
                ))),
                Ok(Err(failed)) => Err(TransportError::Connect(ConnectError::caused(
                    "the credential provider failed",
                    Arc::from(failed),
                ))),
                Err(_dropped) => Err(TransportError::Connect(ConnectError::new(
                    "the credential provider failed",
                ))),
            };
        }
    }

    // an attempt's connection: its credential, its socket raced, TLS under `wss`, and its upgrade
    async fn opening(
        &self,
        (options, signal): (&WebSocketTransportClientConnectOptions, &CancellationToken),
    ) -> Result<Opened, TransportError> {
        let credential = self.credential_of((options, signal)).await?;
        let (host, bare) = host_of(&options.host)?;
        let is_secured = options.secured.unwrap_or(false);
        let pathname = options.pathname.as_deref().unwrap_or(PATHNAME);
        let path = if pathname.starts_with('/') {
            pathname.to_owned()
        } else {
            format!("/{pathname}")
        };
        let scheme = if is_secured { "wss" } else { "ws" };
        let url = format!("{scheme}://{host}:{}{path}", options.port);
        let mut request = url.as_str().into_client_request().map_err(upgrade_error)?;
        let headers = request.headers_mut();

        if let Some(credential) = &credential {
            let value = HeaderValue::from_str(credential).map_err(|_refused| {
                TransportError::Refused(ProgrammerError::new(NO_FIELD_VALUE))
            })?;

            headers.insert(AUTHORIZATION, value);
        }

        if let Some(protocols) = options
            .protocols
            .as_ref()
            .filter(|protocols| !protocols.is_empty())
        {
            let value = HeaderValue::from_str(&protocols.join(", ")).map_err(|_refused| {
                TransportError::Refused(ProgrammerError::new(
                    "a subprotocol is a token (RFC 6455 §4.1)",
                ))
            })?;

            headers.insert(SEC_WEBSOCKET_PROTOCOL, value);
        }

        let socket = connect_racing((&bare, options.port), &self.racing)
            .await
            .map_err(connect_error)?;
        let socket = if is_secured {
            let config = self.upgrade_tls()?;

            ClientSocket::Secured(Box::new(
                connect_tls((socket, &bare), &config)
                    .await
                    .map_err(connect_error)?,
            ))
        } else {
            ClientSocket::Plain(socket)
        };
        // ! no redirect followed: tungstenite fails an upgrade answered with anything but 101
        let (socket, _response) = tokio_tungstenite::client_async_with_config(
            request,
            socket,
            Some(config_of(self.settings.maximum_message_bytes)),
        )
        .await
        .map_err(upgrade_error)?;

        Ok(Opened { socket, credential })
    }

    // an attempt run to its end: open, or failed, timed out, cancelled or given up, whichever comes
    // first; what it opened once it was ended is dropped with it
    async fn attempted(
        self: Arc<Self>,
        (attempt, options): (Arc<Attempt>, WebSocketTransportClientConnectOptions),
        reply: oneshot::Sender<Result<(), TransportError>>,
    ) {
        // the provider's signal, cancelled once the attempt is over, an open one's included
        let provider_signal = CancellationToken::new();
        let timeout = attempt.timeout;
        let timer = locked(&attempt.timer).take();
        let (armed, timed_out) =
            timer.map_or((None, None), |(timer, wait)| (Some(timer), Some(wait)));
        let signal = options.signal.clone().unwrap_or_default();
        let outcome = {
            let mut opening = pin!(self.opening((&options, &provider_signal)));
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

                opening.as_mut().poll(context)
            })
            .await
        };

        if let Some(timer) = armed {
            timer.cancel();
        }

        self.settle((&attempt, outcome), reply);

        // * after the connect settled: what the provider does once told runs outside its ending
        provider_signal.cancel();
    }

    // the connect settles: open, unless given up on meanwhile
    fn settle(
        &self,
        (attempt, outcome): (&Arc<Attempt>, Result<Opened, TransportError>),
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
            // given up as it opened: what it opened is dropped
            Ok(opened) if !is_current || attempt.given_up.is_cancelled() => {
                opened.socket.get_ref().abort();

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
            Ok(Opened { socket, credential }) => {
                state.serial = state.serial.saturating_add(1);

                let serial = state.serial;
                let bounds = ConnectionBounds {
                    maximum_message_bytes: self.settings.maximum_message_bytes,
                    close_timeout: self.settings.close_timeout,
                    pacing: None,
                    platform: Arc::clone(&self.platform),
                };
                let (connection, commands) = Connection::over(socket, bounds);

                // a pause outlasts the connection it was made on
                if state.is_paused {
                    commands.pause();
                }

                // * a drop closes as a network does, and its end tells it
                let (pinging, dropping) = (commands.clone(), commands.clone());
                let heartbeat = Heartbeat::new(
                    HeartbeatHooks {
                        ping: Box::new(move || pinging.ping()),
                        drop: Box::new(move || dropping.drop_now()),
                    },
                    (self.settings.heartbeat, &self.platform),
                );
                let answering = heartbeat.clone();

                state.current = Some(Open {
                    serial,
                    commands,
                    heartbeat,
                    carried: credential,
                });
                state.ready = ReadyState::Open;
                drop(state);

                let me = Weak::clone(&self.me);

                drop(platform::spawn(&self.runtime, async move {
                    let delivering = Weak::clone(&me);
                    let hooks = ConnectionHooks {
                        deliver: Box::new(move |data: Bytes, is_text: bool| {
                            if let Some(inner) = delivering.upgrade() {
                                inner.deliver(serial, (data, is_text));
                            }
                        }),
                        answered: Box::new(move || answering.answer()),
                    };
                    let ended = connection.run(hooks).await;

                    if let Some(inner) = me.upgrade() {
                        inner.ended(serial, &ended);
                    }
                }));

                reply.send(Ok(())).ok();
            }
        }
    }

    // a message whole, handed on unless its connection is gone or closing; a text one reported,
    // as no envelope
    fn deliver(&self, serial: u64, (data, is_text): (Bytes, bool)) {
        {
            let state = locked(&self.state);
            let is_heard = state.ready != ReadyState::Closing
                && state
                    .current
                    .as_ref()
                    .is_some_and(|open| open.serial == serial);

            drop(state);

            if !is_heard {
                return;
            }
        }

        if is_text {
            self.report(&RouterError::Failure(
                Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, RouterSide::Client)
                    .saying("an envelope is binary, not a string"),
            ));

            return;
        }

        let message = TransportMessage {
            data,
            ..TransportMessage::default()
        };

        self.tell(|listener: &dyn ClientListener| listener.on_message(message.clone()));
    }

    // * its end: told to the close under way, which tells its close as it said; or as a close of
    // the server's or the network's, its one error first when this side failed it of its own, then
    // its unclean close, told even when a listener of its error panics (spec 15.1); a connection
    // dropped or replaced tells nothing
    fn ended(&self, serial: u64, ended: &Ended) {
        let disconnecting = {
            let mut state = locked(&self.state);

            if state
                .current
                .as_ref()
                .is_none_or(|open| open.serial != serial)
            {
                return;
            }

            if let Some(open) = state.current.take() {
                open.heartbeat.stop();
            }

            let disconnecting = state
                .disconnecting
                .take_if(|disconnecting| disconnecting.serial == serial);

            if disconnecting.is_none() && state.ready == ReadyState::Reconnecting {
                return;
            }

            state.ready = ReadyState::Closed;
            drop(state);

            disconnecting
        };

        if let Some(Disconnecting { is_clean, done, .. }) = disconnecting {
            self.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, false));
            done.send(()).ok();

            return;
        }

        if let Some(failed) = &ended.failure {
            self.report(&failure_of(failed));
        }

        self.tell(|listener: &dyn ClientListener| listener.on_close(false, false));
    }

    // gives up on the connect under way, and drops the open connection, its close going out going
    // away, 1001, unwaited: what it ends tells nothing; a close under way settles, its close told
    // to no one
    fn drop_all(&self) {
        let (attempt, open, disconnecting) = {
            let mut state = locked(&self.state);
            let attempt = state.attempt.take();
            let open = state.current.take();
            let disconnecting = state.disconnecting.take();

            if disconnecting.is_some()
                || matches!(state.ready, ReadyState::Open | ReadyState::Connecting)
            {
                state.ready = ReadyState::Closed;
            }

            drop(state);

            (attempt, open, disconnecting)
        };

        if let Some(attempt) = attempt {
            attempt.given_up.cancel();
        }

        if let Some(open) = open {
            released(&open);
        }

        if let Some(disconnecting) = disconnecting {
            disconnecting.done.send(()).ok();
        }
    }
}

// drops a connection this side let go of, without waiting on it: its close goes out going away,
// 1001, and its close timeout drops one whose server never answers; its end tells nothing
fn released(open: &Open) {
    open.heartbeat.stop();
    open.commands.close(GOING_AWAY);
}

impl WebSocketTransportClient {
    /// A transport client, not yet connected, its options held.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for a close timeout or a heartbeat spec 1.4 does not hold; a bound of 0.
    pub fn new(options: &WebSocketTransportClientOptions) -> Result<Self, ProgrammerError> {
        let runtime =
            platform::socket_runtime_of(options.runtime.as_ref(), "a WebSocket transport client")?;
        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));

        Self::on_platform((runtime, platform), options)
    }

    // a client on `runtime`, its timers that bound the platform's socket on `platform`: the
    // platform's clock, but in a test
    fn on_platform(
        (runtime, platform): (Handle, SharedClock),
        options: &WebSocketTransportClientOptions,
    ) -> Result<Self, ProgrammerError> {
        let close_timeout = hold(
            "a close timeout",
            options.close_timeout.unwrap_or(CLOSE_TIMEOUT),
        )?;
        let heartbeat = hold_heartbeat(options.heartbeat.unwrap_or(HEARTBEAT))?;
        let maximum_message_bytes = hold_count(
            "maximumMessageBytes",
            options
                .maximum_message_bytes
                .unwrap_or(MAXIMUM_MESSAGE_BYTES),
        )?;
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform));
        let racing = RacingOptions::on(Arc::clone(&platform));

        Ok(Self {
            inner: Arc::new_cyclic(|me| ClientInner {
                me: Weak::clone(me),
                runtime,
                platform,
                clock,
                given: options.clock.clone(),
                settings: Settings {
                    close_timeout,
                    heartbeat,
                    maximum_message_bytes,
                    tls: options.tls.clone(),
                },
                racing,
                upgrade_tls: Mutex::new(None),
                state: Mutex::new(ClientState {
                    ready: ReadyState::Uninitialized,
                    last_connect: None,
                    is_attempting: false,
                    attempt: None,
                    serial: 0,
                    current: None,
                    disconnecting: None,
                    is_paused: false,
                }),
                listeners: Listeners::default(),
                pending: Mutex::new((0, HashMap::new())),
            }),
        })
    }

    /// Connects to its server, started as it is called: open once its upgrade was answered 101.
    pub fn connect(&self, options: &WebSocketTransportClientConnectOptions) -> Connect {
        match self.start_connect(options) {
            Ok(outcome) => Connect::of(outcome),
            Err(error) => Connect::refused(error),
        }
    }

    fn start_connect(
        &self,
        options: &WebSocketTransportClientConnectOptions,
    ) -> Result<oneshot::Receiver<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;

        // * held before anything moves or is kept, so a reconnection connects again with them held
        assert_credential(options)?;

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
            state.last_connect = Some(WebSocketTransportClientConnectOptions {
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

    /// Closes its connection and tells its close, which says it was clean as its options say: with
    /// 1000, settling once its server answered or its close timeout passed; or, quick, at once, its
    /// socket dropped, its close going out going away, 1001, unwaited. A dispose meanwhile drops the
    /// socket, and no close is told. It ends closed. Its close starts as it is called, the future
    /// only waiting for its end.
    ///
    /// # Errors
    ///
    /// A [`TransportError::ReadyState`] when it is not open, refused as it is called, nothing
    /// changed.
    pub fn disconnect(
        &self,
        options: &TransportClientDisconnectOptions,
    ) -> Result<BoxFuture<()>, TransportError> {
        let inner = &self.inner;
        let is_clean = options.is_clean.unwrap_or(true);
        let is_quick = options.is_quick.unwrap_or(false);
        let (done, ended) = oneshot::channel();
        let open = {
            let mut state = locked(&inner.state);
            let open = if state.ready == ReadyState::Open {
                state.current.take()
            } else {
                None
            };
            let Some(open) = open else {
                return Err(TransportError::ReadyState(ReadyStateError::new(
                    state.ready.name(),
                    ReadyState::Open.name(),
                )));
            };

            if is_quick {
                // a connection dropped tells nothing of its end: this close tells it
                state.ready = ReadyState::Closed;
                drop(state);

                open
            } else {
                // ! a socket that closes reads on to its peer's Close, so its handshake never waits
                // on its own pause (RFC 6455 §7.1.1); its end settles this close
                state.ready = ReadyState::Closing;
                state.disconnecting = Some(Disconnecting {
                    serial: open.serial,
                    is_clean,
                    done,
                });
                open.heartbeat.stop();
                open.commands.close(NORMAL);
                state.current = Some(open);
                drop(state);

                return Ok(Box::pin(async move {
                    ended.await.ok();
                }));
            }
        };

        released(&open);
        inner.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, true));

        Ok(Box::pin(async {}))
    }

    /// Lets go of its connection at once, its close going out going away, 1001, unwaited and told
    /// to no listener; of a close under way, which settles telling none; and of a connect under
    /// way, which fails. A reconnection under way is not stopped by it, only the attempt it is
    /// making: cancel its signal.
    pub fn dispose(&self) {
        self.inner.drop_all();
    }

    /// Closes its connection cleanly when it is open, as its disconnect does, telling its close,
    /// then lets go of everything, as its dispose does; not open, it lets go at once. It starts as
    /// it is called, the future only waiting for its end: where the memory and broker clients'
    /// disconnect waits on nothing, this one's waits on its server's answer.
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
    /// open connection without a close, and tells `on_reconnect` as it starts. The first attempt
    /// goes at once, each next one after its delay; attempts that run out end it closed, with a
    /// [`TransportError::Reconnect`]; a cancel stops them, ending it closed, and one after an
    /// attempt opened disconnects, which tells a close.
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
            let replaced = state.current.take();

            state.ready = ReadyState::Reconnecting;
            drop(state);

            (target, replaced)
        };

        // each listener within its guard, its panic reported; the connection replaced goes
        // whatever a listener does
        inner.tell(|listener: &dyn ClientListener| listener.on_reconnect());

        if let Some(replaced) = replaced {
            released(&replaced);
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
            WebSocketTransportClientConnectOptions,
            TransportClientReconnectOptions,
        ),
    ) -> Result<(), TransportError> {
        let inner = &self.inner;

        attempting((&inner.clock, &options), |signal| {
            locked(&inner.state).is_attempting = true;

            let connecting = self.connect(&WebSocketTransportClientConnectOptions {
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

impl RouterClientTransport for WebSocketTransportClient {
    // a credential given here is not carried: its upgrade's is, and its router fails a call that
    // presents another before it goes (decision 0032)
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let state = locked(&self.inner.state);

        match (&state.current, state.ready) {
            (Some(open), ReadyState::Open) => {
                open.commands.send(message.data);

                Ok(Sent::Done)
            }
            (_, ready) => Err(RouterError::Other(Arc::new(ReadyStateError::new(
                ready.name(),
                ReadyState::Open.name(),
            )))),
        }
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.inner.listeners.remove(listener);
    }

    // ! its state's lock alone, which it never holds as it tells a listener: its socket read no
    // more, so TCP's window paces its server; the pause outlasts a connection
    fn pause(&self) {
        let mut state = locked(&self.inner.state);

        state.is_paused = true;

        if let Some(open) = &state.current {
            open.commands.pause();
        }
    }

    // ! as `pause`: its socket read again from its connection's own step, never within this call
    fn resume(&self) {
        let mut state = locked(&self.inner.state);

        state.is_paused = false;

        if let Some(open) = &state.current {
            open.commands.resume();
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.given.clone()
    }

    // * judged from the options of its last connect, never from what its host resolves to (spec
    // 13.4): `wss`, or a host on the loopback; none before its first connect
    fn is_secure(&self) -> bool {
        locked(&self.inner.state)
            .last_connect
            .as_ref()
            .is_some_and(|given| is_secure(given.secured.unwrap_or(false), Some(&given.host)))
    }

    // * the bytes the upgrade of its open connection carried alone, compared in constant time
    // (spec 15.1): every byte of what it carried is read, wherever the two differ, so time tells at
    // most its length; none before its first connect, nor once its connection is gone
    fn carries(&self, credential: &str) -> bool {
        let carried = {
            let state = locked(&self.inner.state);

            state
                .current
                .as_ref()
                .filter(|_| state.ready == ReadyState::Open)
                .and_then(|open| open.carried.clone())
        };
        let Some(carried) = carried else {
            return false;
        };
        let presented = credential.as_bytes();
        let held = carried.as_bytes();
        // the lengths' difference, folded into one byte that is 0 alone when they are equal
        let lengths = (presented.len() ^ held.len())
            .to_le_bytes()
            .iter()
            .fold(0_u8, |difference, byte| difference | byte);

        held.iter()
            .enumerate()
            .fold(lengths, |difference, (index, byte)| {
                difference | (byte ^ presented.get(index).copied().unwrap_or(0))
            })
            == 0
    }

    fn ready_state(&self) -> ReadyState {
        locked(&self.inner.state).ready
    }
}
