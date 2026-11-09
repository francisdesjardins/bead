use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::SystemTime;

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc};
use tungstenite::handshake::server::{
    Callback, ErrorResponse, Request as UpgradeRequest, Response as Answer,
};
use tungstenite::protocol::Message;

use super::*;
use crate::testing::{Instant, SteppingClock, patience, spawn, yield_now};
use crate::transport::TransportServerStartOptions;
use crate::websocket::server::{WebSocketTransportServer, WebSocketTransportServerOptions};
use crate::{ServerTransport, TransportServerAddress};

const PATIENCE: Duration = Duration::from_secs(10);

// a bearer credential, as RFC 6750 §2.1 writes one
const BEARER: &str = "Bearer mF_9.B5f-4.1JqM";

// the refusals a server answers an upgrade with: one of the transport's own, marked, and one
// unmarked
const FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\nbead-refusal: host-refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const BAD_GATEWAY: &str =
    "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

const LOOPBACK: &str = "127.0.0.1";

// ── What a client tells ──────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Told {
    messages: Vec<Bytes>,
    closes: Vec<(bool, bool)>,
    errors: Vec<String>,
    reconnects: usize,
}

#[derive(Default)]
struct Recorder {
    told: Mutex<Told>,
    changed: Notify,
}

impl Recorder {
    fn record<F: FnOnce(&mut Told)>(&self, record: F) {
        record(&mut self.told.lock().unwrap());
        self.changed.notify_waiters();
    }

    fn messages(&self) -> Vec<Bytes> {
        self.told.lock().unwrap().messages.clone()
    }

    fn closes(&self) -> Vec<(bool, bool)> {
        self.told.lock().unwrap().closes.clone()
    }

    fn errors(&self) -> Vec<String> {
        self.told.lock().unwrap().errors.clone()
    }
}

impl ClientListener for Recorder {
    fn on_message(&self, message: TransportMessage) {
        self.record(|told| told.messages.push(message.data));
    }

    fn on_close(&self, was_clean: bool, is_quick: bool) {
        self.record(|told| told.closes.push((was_clean, is_quick)));
    }

    fn on_reconnect(&self) {
        self.record(|told| told.reconnects = told.reconnects.saturating_add(1));
    }

    fn on_error(&self, error: &RouterError) {
        self.record(|told| told.errors.push(error.to_string()));
    }
}

fn recorded(client: &WebSocketTransportClient) -> Arc<Recorder> {
    let recorder = Arc::new(Recorder::default());

    client.listen(Arc::<Recorder>::clone(&recorder));

    recorder
}

// ── Clients and servers ──────────────────────────────────────────────────────────────────────

fn client_of(options: &WebSocketTransportClientOptions) -> WebSocketTransportClient {
    WebSocketTransportClient::new(options).unwrap()
}

fn client() -> WebSocketTransportClient {
    client_of(&WebSocketTransportClientOptions::default())
}

fn stepping() -> Arc<SteppingClock> {
    SteppingClock::new(SystemTime::UNIX_EPOCH)
}

fn stepping_client(clock: &Arc<SteppingClock>) -> WebSocketTransportClient {
    client_of(&WebSocketTransportClientOptions {
        clock: Some(Arc::<SteppingClock>::clone(clock)),
        ..WebSocketTransportClientOptions::default()
    })
}

fn to(port: u16) -> WebSocketTransportClientConnectOptions {
    WebSocketTransportClientConnectOptions::new(LOOPBACK, port)
}

async fn settled(connecting: Connect) -> Result<(), TransportError> {
    patience(PATIENCE, connecting)
        .await
        .expect("the connect settles within patience")
}

fn is_state(client: &WebSocketTransportClient, ready: ReadyState) -> bool {
    client.ready_state() == ready
}

// a port nothing listens on
async fn closed_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();

    listener.local_addr().unwrap().port()
}

// whether this machine has the IPv6 loopback
async fn has_ipv6_loopback() -> bool {
    TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await.is_ok()
}

// a provider that hands `credential` at once
fn handing(credential: &'static str) -> CredentialProvider {
    Arc::new(move |_signal| Box::pin(async move { Ok(credential.to_owned()) }))
}

/// A server that upgrades each request as `ws` does, answering the first subprotocol offered,
/// until it is told a refusal, then answers each upgrade with it; it holds each upgrade it took.
struct Hearing {
    port: u16,
    // the head of each upgrade it took
    heard: Arc<Mutex<Vec<UpgradeRequest>>>,
    // each socket that reached it, upgraded or not
    accepted: Arc<AtomicUsize>,
    upgraded: tokio::sync::Mutex<mpsc::UnboundedReceiver<WebSocketStream<TcpStream>>>,
    stop: CancellationToken,
}

impl Drop for Hearing {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Hearing {
    // the Authorization lines of each upgrade it took, as they came
    fn authorizations(&self) -> Vec<Vec<String>> {
        self.heard
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                request
                    .headers()
                    .get_all(AUTHORIZATION)
                    .iter()
                    .map(|value| value.to_str().unwrap().to_owned())
                    .collect()
            })
            .collect()
    }

    async fn next_upgraded(&self) -> WebSocketStream<TcpStream> {
        let mut upgraded = self.upgraded.lock().await;

        patience(PATIENCE, upgraded.recv()).await.unwrap().unwrap()
    }
}

// what hears an upgrade: its head kept, and the first subprotocol it offered answered, as ws answers
struct Heard(Arc<Mutex<Vec<UpgradeRequest>>>);

impl Callback for Heard {
    fn on_request(
        self,
        request: &UpgradeRequest,
        mut answer: Answer,
    ) -> Result<Answer, ErrorResponse> {
        self.0.lock().unwrap().push(request.clone());

        if let Some(offered) = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|offered| offered.to_str().ok())
            .and_then(|offered| offered.split(',').next())
        {
            answer.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(offered.trim()).unwrap(),
            );
        }

        Ok(answer)
    }
}

async fn hearing(refusal: Option<&'static str>) -> Hearing {
    hearing_on((IpAddr::V4(Ipv4Addr::LOCALHOST), refusal)).await
}

async fn hearing_on((address, refusal): (IpAddr, Option<&'static str>)) -> Hearing {
    let listener = TcpListener::bind((address, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let heard: Arc<Mutex<Vec<UpgradeRequest>>> = Arc::default();
    let accepted = Arc::new(AtomicUsize::new(0));
    let (taken, upgraded) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let (hearing, counting, stopping) = (Arc::clone(&heard), Arc::clone(&accepted), stop.clone());

    spawn(async move {
        loop {
            let Some(Ok((mut socket, _))) = first_value(&stopping, listener.accept()).await else {
                return;
            };

            counting.fetch_add(1, Ordering::SeqCst);

            let refused = refusal;
            let hearing = Arc::clone(&hearing);
            let taken = taken.clone();

            spawn(async move {
                if let Some(refusal) = refused {
                    head_of(&mut socket).await;
                    socket.write_all(refusal.as_bytes()).await.ok();
                    socket.shutdown().await.ok();

                    return;
                }

                let upgrading = tokio_tungstenite::accept_hdr_async(socket, Heard(hearing));

                if let Ok(upgraded) = upgrading.await {
                    taken.send(upgraded).ok();
                }
            });
        }
    });

    Hearing {
        port,
        heard,
        accepted,
        upgraded: tokio::sync::Mutex::new(upgraded),
        stop,
    }
}

/// A listener that takes each socket and answers nothing: a handshake held for ever.
struct Holding {
    port: u16,
    held: mpsc::UnboundedReceiver<TcpStream>,
    stop: CancellationToken,
}

impl Drop for Holding {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Holding {
    async fn next(&mut self) -> TcpStream {
        patience(PATIENCE, self.held.recv()).await.unwrap().unwrap()
    }
}

async fn holding() -> Holding {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (take, held) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let stopping = stop.clone();

    spawn(async move {
        while let Some(Ok((socket, _))) = first_value(&stopping, listener.accept()).await {
            take.send(socket).ok();
        }
    });

    Holding { port, held, stop }
}

// `future`'s output, or none once `stop` is cancelled
async fn first_value<F: Future>(stop: &CancellationToken, future: F) -> Option<F::Output> {
    let mut cancelled = pin!(stop.cancelled());
    let mut future = pin!(future);

    poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }

        future.as_mut().poll(context).map(Some)
    })
    .await
}

// reads a request's head, to its blank line
async fn head_of(socket: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];

    while !head.ends_with(b"\r\n\r\n") {
        match socket.read(&mut byte).await {
            Ok(0) | Err(_) => break,
            Ok(_) => head.push(byte[0]),
        }
    }

    head
}

// whether a socket a client let go of ends, its peer's read meeting its end
async fn ends(socket: &mut TcpStream) -> bool {
    let mut chunk = [0_u8; 1_024];

    patience(PATIENCE, async {
        loop {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => return true,
                Ok(_) => {}
            }
        }
    })
    .await
    .unwrap_or(false)
}

fn is_cancelled(outcome: &Result<(), TransportError>) -> bool {
    matches!(outcome, Err(TransportError::Cancelled { .. }))
}

fn is_timed_out(outcome: &Result<(), TransportError>, after: Duration) -> bool {
    matches!(outcome, Err(TransportError::TimedOut(timeout)) if *timeout == after)
}

fn is_disposed(outcome: &Result<(), TransportError>) -> bool {
    matches!(outcome, Err(TransportError::Connect(error)) if error.message() == DISPOSED)
}

// the source of a connect's failure, as its message says it
fn source_of(outcome: &Result<(), TransportError>) -> Option<String> {
    match outcome {
        Err(TransportError::Connect(error)) => error.source().map(ToString::to_string),
        _ => None,
    }
}

// the three ways an attempt ends before its socket opens
#[derive(Debug, Clone, Copy)]
enum Ending {
    Cancel,
    Timeout,
    Dispose,
}

const ENDINGS: [Ending; 3] = [Ending::Cancel, Ending::Timeout, Ending::Dispose];

// what an attempt is ended by: its client, its clock and its signal
struct Ends<'a> {
    client: &'a WebSocketTransportClient,
    clock: &'a Arc<SteppingClock>,
    signal: &'a CancellationToken,
}

async fn end(ending: Ending, ends: &Ends<'_>) {
    match ending {
        Ending::Cancel => ends.signal.cancel(),
        Ending::Timeout => ends.clock.advance(Duration::from_millis(100)).await,
        Ending::Dispose => ends.client.dispose(),
    }
}

fn is_ended_by(ending: Ending, outcome: &Result<(), TransportError>) -> bool {
    match ending {
        Ending::Cancel => is_cancelled(outcome),
        Ending::Timeout => is_timed_out(outcome, Duration::from_millis(100)),
        Ending::Dispose => is_disposed(outcome),
    }
}

// a connect on `clock` to `port`, with a timeout of 100 ms and `signal`
fn ending_target(port: u16, signal: &CancellationToken) -> WebSocketTransportClientConnectOptions {
    WebSocketTransportClientConnectOptions {
        timeout: Some(Duration::from_millis(100)),
        signal: Some(signal.clone()),
        ..to(port)
    }
}

// ── Its connect ──────────────────────────────────────────────────────────────────────────────

// spec 15.15
#[tokio::test]
async fn resolves_when_connecting_to_a_valid_endpoint() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

// spec 15.2
#[tokio::test]
async fn writes_no_origin_on_its_upgrade() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    // a page's browser writes its own, which the server judges; the client, none
    assert!(
        server.heard.lock().unwrap()[0]
            .headers()
            .get("origin")
            .is_none(),
        "no Origin"
    );
    client.dispose();
}

#[tokio::test]
async fn offers_no_extension_in_its_upgrade_permessage_deflate_among_them() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    assert!(
        server.heard.lock().unwrap()[0]
            .headers()
            .get("sec-websocket-extensions")
            .is_none(),
        "no extension offered"
    );
    client.dispose();
}

#[tokio::test]
async fn rejects_with_a_connect_error_when_nothing_listens() {
    let client = client();
    let refused = settled(client.connect(&to(closed_port().await))).await;

    assert!(
        matches!(refused, Err(TransportError::Connect(_))),
        "{refused:?}"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

#[tokio::test]
async fn keeps_the_error_the_implementation_reported_as_the_connect_error_cause() {
    let client = client();
    let refused = settled(client.connect(&to(closed_port().await))).await;
    let Err(TransportError::Connect(error)) = &refused else {
        panic!("a connect error: {refused:?}");
    };
    let cause = error
        .source()
        .and_then(|cause| cause.downcast_ref::<io::Error>())
        .map(io::Error::kind);

    // the system's error, as ws reports it
    assert_eq!(
        cause,
        Some(io::ErrorKind::ConnectionRefused),
        "the system's"
    );
}

#[tokio::test]
async fn rejects_with_a_programmer_error_when_connecting_twice() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let refused = settled(client.connect(&to(server.port))).await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client is already open"),
        "{refused:?}"
    );
    assert!(is_state(&client, ReadyState::Open), "still open");
    client.dispose();
}

#[tokio::test]
async fn rejects_a_second_connect_while_the_first_is_connecting_opening_one_socket_only() {
    let server = hearing(None).await;
    let client = client();
    let first = client.connect(&to(server.port));
    let second = settled(client.connect(&to(server.port))).await;

    assert!(
        matches!(second, Err(TransportError::Refused(_))),
        "{second:?}"
    );
    settled(first).await.unwrap();
    assert!(is_state(&client, ReadyState::Open), "open");
    assert_eq!(server.accepted.load(Ordering::SeqCst), 1, "one socket");
    client.dispose();
}

// spec 15.15
#[tokio::test]
async fn rejects_with_a_timeout_error_then_drops_a_socket_that_never_finished_its_handshake() {
    let mut held = holding().await;
    // its timeout on the test clock, which alone moves it
    let clock = stepping();
    let client = stepping_client(&clock);
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        timeout: Some(Duration::from_millis(100)),
        ..to(held.port)
    });
    // its handshake held at the server
    let mut socket = held.next().await;

    clock.advance(Duration::from_millis(100)).await;

    let refused = settled(connecting).await;

    assert!(
        is_timed_out(&refused, Duration::from_millis(100)),
        "{refused:?}"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
    // the socket closes on its own, with the server still holding its handshake
    assert!(ends(&mut socket).await, "dropped");
}

#[tokio::test]
async fn waits_on_its_handshake_without_end_with_an_infinite_timeout_until_its_signal_aborts() {
    let mut held = holding().await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let signal = CancellationToken::new();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        timeout: Some(NEVER),
        signal: Some(signal.clone()),
        ..to(held.port)
    });
    let _socket = held.next().await;

    // a day, where the 30 seconds a timeout left at its default would have passed: no timer
    // armed, and still connecting
    clock.advance(Duration::from_hours(24)).await;

    assert_eq!(
        (client.ready_state(), clock.dues()),
        (ReadyState::Connecting, vec![]),
        "connecting, nothing armed"
    );

    signal.cancel();

    assert!(is_cancelled(&settled(connecting).await), "cancelled");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// spec 15.15
#[tokio::test]
async fn rejects_with_a_cancel_error_closed_when_its_signal_aborts_during_the_handshake() {
    let mut held = holding().await;
    let client = client();
    let signal = CancellationToken::new();

    // one cancelled already refuses the connect before anything moves
    signal.cancel();

    assert!(
        is_cancelled(
            &settled(client.connect(&WebSocketTransportClientConnectOptions {
                signal: Some(signal),
                ..to(held.port)
            }))
            .await
        ),
        "cancelled already"
    );
    assert!(
        is_state(&client, ReadyState::Uninitialized),
        "nothing moved"
    );

    let signal = CancellationToken::new();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        signal: Some(signal.clone()),
        timeout: Some(NEVER),
        ..to(held.port)
    });
    let mut socket = held.next().await;

    signal.cancel();

    assert!(is_cancelled(&settled(connecting).await), "cancelled");
    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(ends(&mut socket).await, "its socket dropped");
}

// spec 15.15
#[tokio::test]
async fn dispose_while_connecting_rejects_the_connect_with_a_connect_error() {
    let mut held = holding().await;
    let client = client();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        timeout: Some(NEVER),
        ..to(held.port)
    });
    let mut socket = held.next().await;

    client.dispose();

    assert!(is_disposed(&settled(connecting).await), "disposed");
    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(ends(&mut socket).await, "its socket dropped");
}

#[tokio::test]
async fn passes_the_protocols_to_the_handshake() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&WebSocketTransportClientConnectOptions {
        protocols: Some(vec!["echo".to_owned()]),
        ..to(server.port)
    }))
    .await
    .unwrap();

    assert_eq!(
        server.heard.lock().unwrap()[0]
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .map(|offered| offered.to_str().unwrap().to_owned()),
        Some("echo".to_owned()),
        "offered"
    );
    client.dispose();
}

#[tokio::test]
async fn requests_the_path_its_pathname_names() {
    let server = hearing(None).await;

    let pathnames = [(Some("rpc"), "/rpc"), (Some("/rpc"), "/rpc"), (None, "/")];

    for (pathname, _) in pathnames {
        let client = client();

        settled(client.connect(&WebSocketTransportClientConnectOptions {
            pathname: pathname.map(str::to_owned),
            ..to(server.port)
        }))
        .await
        .unwrap();
        client.dispose();
    }

    assert_eq!(
        server
            .heard
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.uri().path().to_owned())
            .collect::<Vec<_>>(),
        pathnames.map(|(_, expected)| expected),
        "each path"
    );
}

#[tokio::test]
async fn asks_for_wss_when_secured() {
    let client = client();
    let refused = settled(client.connect(&WebSocketTransportClientConnectOptions {
        secured: Some(true),
        ..to(closed_port().await)
    }))
    .await;

    assert!(
        matches!(refused, Err(TransportError::Connect(_))),
        "{refused:?}"
    );

    // its first byte a TLS handshake record's (RFC 8446 §5.1), never an HTTP request's
    let mut held = holding().await;
    let signal = CancellationToken::new();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        secured: Some(true),
        signal: Some(signal.clone()),
        ..to(held.port)
    });
    let mut socket = held.next().await;
    let mut hello = [0_u8; 1];

    patience(PATIENCE, socket.read_exact(&mut hello))
        .await
        .unwrap()
        .unwrap();
    signal.cancel();

    assert_eq!(hello, [0x16], "a ClientHello");
    assert!(is_cancelled(&settled(connecting).await), "cancelled");
}

#[tokio::test]
async fn brackets_an_ipv6_literal_host() {
    let server = hearing(None).await;

    for host in [LOOPBACK, "localhost"] {
        let client = client();

        settled(client.connect(&WebSocketTransportClientConnectOptions::new(
            host,
            server.port,
        )))
        .await
        .unwrap();
        client.dispose();
    }

    assert_eq!(
        server
            .heard
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.headers()["host"].to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        [
            format!("127.0.0.1:{}", server.port),
            format!("localhost:{}", server.port)
        ],
        "each Host as given"
    );

    if !has_ipv6_loopback().await {
        return;
    }

    // a server on the IPv6 loopback, reached by its address bare or bracketed, its Host bracketed
    let server = hearing_on((IpAddr::V6(Ipv6Addr::LOCALHOST), None)).await;
    let port = server.port;

    for host in ["::1", "[::1]"] {
        let client = client();

        settled(client.connect(&WebSocketTransportClientConnectOptions::new(host, port)))
            .await
            .unwrap();

        assert!(is_state(&client, ReadyState::Open), "open by {host}");
        client.dispose();
    }

    assert_eq!(
        server
            .heard
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.headers()["host"].to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        [format!("[::1]:{port}"), format!("[::1]:{port}")],
        "bracketed"
    );
}

// ── What it carries ──────────────────────────────────────────────────────────────────────────

// spec 15.15
#[tokio::test]
async fn bounds_an_unresponsive_websocket_handshake_by_cancellation_timeout_and_disposal() {
    for ending in ENDINGS {
        let mut held = holding().await;
        let clock = stepping();
        let client = stepping_client(&clock);
        let signal = CancellationToken::new();
        let connecting = client.connect(&ending_target(held.port, &signal));
        let mut socket = held.next().await;

        end(
            ending,
            &Ends {
                client: &client,
                clock: &clock,
                signal: &signal,
            },
        )
        .await;

        assert!(
            is_ended_by(ending, &settled(connecting).await),
            "{ending:?}"
        );
        assert!(is_state(&client, ReadyState::Closed), "closed: {ending:?}");
        assert!(ends(&mut socket).await, "dropped: {ending:?}");
    }
}

// spec 15.15
#[tokio::test]
async fn defers_its_credential_provider_until_after_connect_returns() {
    let server = hearing(None).await;
    let client = client();
    let called = Arc::new(AtomicBool::new(false));
    let calling = Arc::clone(&called);
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(move |_signal| {
            calling.store(true, Ordering::SeqCst);

            Box::pin(async { Ok(BEARER.to_owned()) })
        })),
        ..to(server.port)
    });

    assert!(!called.load(Ordering::SeqCst), "not called within connect");
    settled(connecting).await.unwrap();
    assert!(called.load(Ordering::SeqCst), "called");
    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

// spec 15.15
#[tokio::test]
async fn writes_no_credential_that_settles_in_the_turn_its_client_is_disposed() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);
    let disposing = client.clone();
    let refused = settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(move |_signal| {
            disposing.dispose();

            Box::pin(async { Ok(BEARER.to_owned()) })
        })),
        ..to(server.port)
    }))
    .await;

    assert!(is_disposed(&refused), "{refused:?}");

    // a round trip lets an upgrade built in the ending turn reach the server
    let probe = self::client();

    settled(probe.connect(&to(server.port))).await.unwrap();
    probe.dispose();

    assert_eq!(server.heard.lock().unwrap().len(), 1, "the probe's alone");
    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(!client.carries(BEARER), "carries none");
    assert!(recorder.messages().is_empty(), "no message");
}

// spec 15.15
#[tokio::test]
async fn writes_no_credential_that_settles_in_the_turn_its_attempt_ends() {
    let server = hearing(None).await;

    for ending in ENDINGS {
        let clock = stepping();
        let client = stepping_client(&clock);
        let signal = CancellationToken::new();
        let entered = Arc::new(Notify::new());
        let (answer, answered) = oneshot::channel::<String>();
        let answered = Arc::new(Mutex::new(Some(answered)));
        let entering = Arc::clone(&entered);
        let connecting = client.connect(&WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::new(move |_signal| {
                entering.notify_one();

                let answered = answered.lock().unwrap().take();

                Box::pin(async move {
                    match answered {
                        Some(answered) => answered.await.map_err(CredentialProviderError::from),
                        None => Err("called twice".into()),
                    }
                })
            })),
            ..ending_target(server.port, &signal)
        });

        patience(PATIENCE, entered.notified()).await.unwrap();
        end(
            ending,
            &Ends {
                client: &client,
                clock: &clock,
                signal: &signal,
            },
        )
        .await;
        answer.send(BEARER.to_owned()).ok();

        assert!(
            is_ended_by(ending, &settled(connecting).await),
            "{ending:?}"
        );

        for _ in 0..8 {
            yield_now().await;
        }

        assert_eq!(server.accepted.load(Ordering::SeqCst), 0, "no socket");
        assert!(is_state(&client, ReadyState::Closed), "closed");
        assert!(!client.carries(BEARER), "carries none");
    }
}

// a provider whose first call waits for its answer, and says when it was entered and what signal
// it was given; each later call hands `later` at once
struct Waiting {
    calls: Arc<AtomicUsize>,
    entered: mpsc::UnboundedReceiver<CancellationToken>,
    answer: Option<oneshot::Sender<Result<String, CredentialProviderError>>>,
    provider: CredentialProvider,
}

fn waiting(later: &'static str) -> Waiting {
    let calls = Arc::new(AtomicUsize::new(0));
    let (entering, entered) = mpsc::unbounded_channel();
    let (answer, answered) = oneshot::channel::<Result<String, CredentialProviderError>>();
    let answered = Arc::new(Mutex::new(Some(answered)));
    let counting = Arc::clone(&calls);
    let provider: CredentialProvider = Arc::new(move |signal: CancellationToken| {
        let call = counting.fetch_add(1, Ordering::SeqCst);

        entering.send(signal).ok();

        let answered = (call == 0)
            .then(|| answered.lock().unwrap().take())
            .flatten();

        Box::pin(async move {
            match answered {
                Some(answered) => answered.await.unwrap_or_else(|_| Err("dropped".into())),
                None => Ok(later.to_owned()),
            }
        })
    });

    Waiting {
        calls,
        entered,
        answer: Some(answer),
        provider,
    }
}

impl Waiting {
    async fn entered(&mut self) -> CancellationToken {
        patience(PATIENCE, self.entered.recv())
            .await
            .unwrap()
            .unwrap()
    }

    fn answer(&mut self, answer: Result<String, CredentialProviderError>) {
        if let Some(answering) = self.answer.take() {
            answering.send(answer).ok();
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

// a late answer: a value, or a failure
fn late(is_value: bool, value: &str) -> Result<String, CredentialProviderError> {
    if is_value {
        Ok(value.to_owned())
    } else {
        Err("late provider failure".into())
    }
}

// spec 15.15
#[tokio::test]
async fn bounds_a_pending_credential_provider_by_cancellation_timeout_and_disposal() {
    let server = hearing(None).await;

    for ending in ENDINGS {
        for is_value in [true, false] {
            let clock = stepping();
            let client = stepping_client(&clock);
            let signal = CancellationToken::new();
            let mut provider = waiting(BEARER);
            let connecting = client.connect(&WebSocketTransportClientConnectOptions {
                credential_provider: Some(Arc::clone(&provider.provider)),
                ..ending_target(server.port, &signal)
            });
            let provider_signal = provider.entered().await;

            end(
                ending,
                &Ends {
                    client: &client,
                    clock: &clock,
                    signal: &signal,
                },
            )
            .await;

            assert!(
                is_ended_by(ending, &settled(connecting).await),
                "{ending:?}"
            );
            assert!(is_state(&client, ReadyState::Closed), "closed");
            assert!(!client.carries(BEARER), "carries none");

            provider.answer(late(is_value, BEARER));
            patience(PATIENCE, provider_signal.cancelled())
                .await
                .unwrap();

            for _ in 0..8 {
                yield_now().await;
            }

            assert_eq!(server.accepted.load(Ordering::SeqCst), 0, "no socket");
        }
    }
}

// spec 15.2, spec 15.15
#[tokio::test]
async fn asks_another_provider_while_an_earlier_source_stays_pending_and_holds_only_its_own_later_attempts()
 {
    for is_value in [true, false] {
        let server = hearing(None).await;
        let clock = stepping();
        let client = stepping_client(&clock);
        let mut provider = waiting("Bearer renewed");
        let signal = CancellationToken::new();
        let other_calls = Arc::new(AtomicUsize::new(0));
        let counting = Arc::clone(&other_calls);
        let first = client.connect(&WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::clone(&provider.provider)),
            signal: Some(signal.clone()),
            ..to(server.port)
        });

        provider.entered().await;
        signal.cancel();

        assert!(is_cancelled(&settled(first).await), "cancelled");

        settled(client.connect(&WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::new(move |_signal| {
                counting.fetch_add(1, Ordering::SeqCst);

                Box::pin(async { Ok(BEARER.to_owned()) })
            })),
            ..to(server.port)
        }))
        .await
        .unwrap();

        assert_eq!(
            (other_calls.load(Ordering::SeqCst), provider.calls()),
            (1, 1),
            "the other asked at once"
        );
        assert!(is_state(&client, ReadyState::Open), "open");
        assert!(client.carries(BEARER), "the other's");
        client.dispose();

        let held = client.connect(&WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::clone(&provider.provider)),
            timeout: Some(Duration::from_millis(100)),
            ..to(server.port)
        });

        clock.advance(Duration::from_millis(100)).await;

        assert!(
            is_timed_out(&settled(held).await, Duration::from_millis(100)),
            "timed out waiting"
        );
        assert!(is_state(&client, ReadyState::Closed), "closed");
        assert_eq!(provider.calls(), 1, "not called anew");

        provider.answer(late(is_value, "Bearer abandoned"));
        settled(client.connect(&WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::clone(&provider.provider)),
            ..to(server.port)
        }))
        .await
        .unwrap();

        assert_eq!(
            (provider.calls(), other_calls.load(Ordering::SeqCst)),
            (2, 1),
            "called anew once settled"
        );
        assert!(is_state(&client, ReadyState::Open), "open");
        assert_eq!(
            [
                client.carries("Bearer renewed"),
                client.carries("Bearer abandoned"),
                client.carries(BEARER)
            ],
            [true, false, false],
            "the renewed one alone"
        );
        client.dispose();
    }
}

// spec 15.2
#[tokio::test]
async fn waits_for_an_abandoned_provider_call_to_settle_before_invoking_the_provider_anew() {
    for is_value in [true, false] {
        for is_next_value in [true, false] {
            let server = hearing(None).await;
            let client = client();
            let signal = CancellationToken::new();
            let calls = Arc::new(AtomicUsize::new(0));
            let settled_first = Arc::new(AtomicBool::new(false));
            let (entering, mut entered) = mpsc::unbounded_channel::<CancellationToken>();
            let (answer, answered) = oneshot::channel::<Result<String, CredentialProviderError>>();
            let (renew, renewed) = oneshot::channel::<Result<String, CredentialProviderError>>();
            let answers = Arc::new(Mutex::new((Some(answered), Some(renewed))));
            let (counting, settling) = (Arc::clone(&calls), Arc::clone(&settled_first));
            let provider: CredentialProvider = Arc::new(move |signal: CancellationToken| {
                let call = counting.fetch_add(1, Ordering::SeqCst);
                let settling = Arc::clone(&settling);
                let is_settled = settling.load(Ordering::SeqCst);

                entering.send(signal.clone()).ok();

                let mut held = answers.lock().unwrap();
                let waited = if call == 0 {
                    held.0.take()
                } else {
                    held.1.take()
                };

                drop(held);

                Box::pin(async move {
                    // * the second call comes once the first settled, its own signal live
                    if call > 0 && (!is_settled || signal.is_cancelled()) {
                        return Err("called anew too soon".into());
                    }

                    let value = match waited {
                        Some(waited) => waited.await.unwrap_or_else(|_| Err("dropped".into())),
                        None => Err("no answer".into()),
                    };

                    if call == 0 {
                        settling.store(true, Ordering::SeqCst);
                    }

                    if signal.is_cancelled() {
                        return Err("aborted".into());
                    }

                    value
                })
            });
            let first = client.connect(&WebSocketTransportClientConnectOptions {
                credential_provider: Some(Arc::clone(&provider)),
                signal: Some(signal.clone()),
                ..to(server.port)
            });
            let first_signal = patience(PATIENCE, entered.recv()).await.unwrap().unwrap();

            signal.cancel();

            assert!(is_cancelled(&settled(first).await), "cancelled");

            let second = client.connect(&WebSocketTransportClientConnectOptions {
                credential_provider: Some(Arc::clone(&provider)),
                ..to(server.port)
            });

            patience(PATIENCE, first_signal.cancelled()).await.unwrap();

            assert_eq!(calls.load(Ordering::SeqCst), 1, "not called anew yet");
            assert!(!settled_first.load(Ordering::SeqCst), "the first pending");
            assert!(is_state(&client, ReadyState::Connecting), "connecting");

            answer.send(late(is_value, "Bearer abandoned")).ok();

            let second_signal = patience(PATIENCE, entered.recv()).await.unwrap().unwrap();

            assert_eq!(calls.load(Ordering::SeqCst), 2, "called anew");
            assert!(!second_signal.is_cancelled(), "its own signal live");
            assert!(is_state(&client, ReadyState::Connecting), "connecting");

            if is_next_value {
                renew.send(Ok(BEARER.to_owned())).ok();
                settled(second).await.unwrap();

                assert!(is_state(&client, ReadyState::Open), "open");
                assert_eq!(
                    [client.carries(BEARER), client.carries("Bearer abandoned")],
                    [true, false],
                    "the renewed one"
                );
            } else {
                renew.send(Err("renewed provider failure".into())).ok();

                let failed = settled(second).await;

                assert!(
                    matches!(&failed, Err(TransportError::Connect(error)) if error.message() == "the credential provider failed"),
                    "{failed:?}"
                );
                assert_eq!(
                    source_of(&failed).as_deref(),
                    Some("renewed provider failure"),
                    "its cause"
                );
                assert!(is_state(&client, ReadyState::Closed), "closed");
            }

            assert_eq!(calls.load(Ordering::SeqCst), 2, "twice in all");
            client.dispose();
        }
    }
}

// spec 15.2, 15.15
#[tokio::test]
async fn bounds_the_wait_for_an_abandoned_provider_call_by_cancellation_timeout_and_disposal() {
    for ending in ENDINGS {
        for is_value in [true, false] {
            let server = hearing(None).await;
            let clock = stepping();
            let client = stepping_client(&clock);
            let mut provider = waiting(BEARER);
            let cancelling = CancellationToken::new();
            let first = client.connect(&WebSocketTransportClientConnectOptions {
                credential_provider: Some(Arc::clone(&provider.provider)),
                signal: Some(cancelling.clone()),
                ..to(server.port)
            });
            let first_signal = provider.entered().await;

            cancelling.cancel();

            assert!(is_cancelled(&settled(first).await), "cancelled");
            patience(PATIENCE, first_signal.cancelled()).await.unwrap();

            let signal = CancellationToken::new();
            let second = client.connect(&WebSocketTransportClientConnectOptions {
                credential_provider: Some(Arc::clone(&provider.provider)),
                ..ending_target(server.port, &signal)
            });

            assert!(is_state(&client, ReadyState::Connecting), "connecting");
            assert_eq!(provider.calls(), 1, "waiting on the first");

            end(
                ending,
                &Ends {
                    client: &client,
                    clock: &clock,
                    signal: &signal,
                },
            )
            .await;

            assert!(is_ended_by(ending, &settled(second).await), "{ending:?}");
            assert!(is_state(&client, ReadyState::Closed), "closed");

            provider.answer(late(is_value, BEARER));
            settled(client.connect(&to(server.port))).await.unwrap();

            assert!(is_state(&client, ReadyState::Open), "open");
            assert!(!client.carries(BEARER), "carries none");
            assert_eq!(provider.calls(), 1, "never called anew");
            client.dispose();
        }
    }
}

#[tokio::test]
async fn treats_a_provider_own_cancellation_as_its_failure_while_the_attempt_stays_live() {
    let client = client();
    let failed = settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(|_signal| {
            Box::pin(async { Err("provider cancelled".into()) })
        })),
        ..to(8_080)
    }))
    .await;

    assert!(
        matches!(&failed, Err(TransportError::Connect(error)) if error.message() == "the credential provider failed"),
        "{failed:?}"
    );
    assert_eq!(
        source_of(&failed).as_deref(),
        Some("provider cancelled"),
        "its cause"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

#[tokio::test]
async fn carries_no_credential_its_upgrade_did_not_carry_and_is_secure_under_wss_or_to_a_loopback_host_judged_by_the_url_it_was_given()
 {
    // the judgement made from what a connect was given, its socket given up at once
    async fn judged_of(target: &WebSocketTransportClientConnectOptions) -> [bool; 2] {
        let client = client();
        let connecting = client.connect(target);

        client.dispose();
        drop(settled(connecting).await);

        [client.carries(BEARER), client.is_secure()]
    }

    let unstarted = client();

    assert_eq!(
        [unstarted.carries(BEARER), unstarted.is_secure()],
        [false, false],
        "none before a connect"
    );

    let mut judged = Vec::new();

    for (host, secured, port) in [
        ("bead.example", true, 8_080),
        ("localhost", false, 8_080),
        (LOOPBACK, false, 8_080),
        ("::1", false, 8_080),
        ("bead.example", false, 8_080),
        ("192.0.2.1", false, 8_080),
        ("192.0.2.1", true, 8_080),
        ("192.0.2.1", false, 80),
        ("192.0.2.1", true, 443),
    ] {
        judged.push(
            judged_of(&WebSocketTransportClientConnectOptions {
                secured: Some(secured),
                ..WebSocketTransportClientConnectOptions::new(host, port)
            })
            .await,
        );
    }

    assert_eq!(
        judged,
        [
            [false, true],
            [false, true],
            [false, true],
            [false, true],
            [false, false],
            [false, false],
            [false, true],
            [false, false],
            [false, true],
        ],
        "each judged by what it was given"
    );

    let server = hearing(None).await;
    let connected = client();

    settled(connected.connect(&to(server.port))).await.unwrap();

    assert_eq!(
        [connected.carries(BEARER), connected.is_secure()],
        [false, true],
        "connected on the loopback"
    );
    connected.dispose();
}

// spec 15.1 and 15.2
#[tokio::test]
async fn writes_the_credential_it_is_given_on_its_upgrade_and_carries_those_bytes_alone() {
    let server = hearing(None).await;
    let client = client();

    // none before its first connect
    assert!(!client.carries(BEARER), "none before");

    settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential: Some(BEARER.to_owned()),
        ..to(server.port)
    }))
    .await
    .unwrap();

    // its Authorization, one line, as given
    assert_eq!(server.authorizations(), [vec![BEARER.to_owned()]], "heard");

    let mut upgraded = server.next_upgraded().await;

    client
        .send(TransportMessage {
            data: Bytes::from_static(b"hello"),
            credential: Some(BEARER.to_owned()),
            ..TransportMessage::default()
        })
        .unwrap();

    assert_eq!(
        patience(PATIENCE, upgraded.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Message::Binary(Bytes::from_static(b"hello")),
        "the envelope alone, binary"
    );
    // those bytes alone, none a byte off, longer or shorter, nor trimmed of what a field cannot
    // hold
    assert!(client.carries(BEARER), "carried");
    assert_eq!(
        [
            "Bearer mF_9.B5f-4.1JqN",
            &format!("{BEARER}x"),
            BEARER.strip_suffix('M').unwrap(),
            &format!(" {BEARER}"),
            "",
            "Bearer mF_9.B5f-4.1Jq?",
        ]
        .map(|other| client.carries(other)),
        [false; 6],
        "no other"
    );

    client.dispose();

    // none once its connection is gone
    assert!(!client.carries(BEARER), "none once gone");

    // none on an upgrade given none, an empty one among them
    for given in [None, Some(String::new())] {
        let bare = self::client();

        settled(bare.connect(&WebSocketTransportClientConnectOptions {
            credential: given,
            ..to(server.port)
        }))
        .await
        .unwrap();

        assert_eq!(
            [bare.carries(""), bare.carries(BEARER)],
            [false, false],
            "carries none"
        );
        bare.dispose();
    }

    assert_eq!(
        server.authorizations(),
        [vec![BEARER.to_owned()], vec![], vec![]],
        "none written but the one given"
    );
}

// spec 15.15
#[tokio::test]
async fn opens_no_connection_when_its_credential_provider_settles_after_cancellation() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);
    let mut provider = waiting(BEARER);
    let signal = CancellationToken::new();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::clone(&provider.provider)),
        signal: Some(signal.clone()),
        ..to(server.port)
    });
    let provider_signal = provider.entered().await;

    signal.cancel();

    assert!(is_cancelled(&settled(connecting).await), "cancelled");
    patience(PATIENCE, provider_signal.cancelled())
        .await
        .unwrap();
    provider.answer(Ok(BEARER.to_owned()));

    // * past the provider's continuation: a cancelled attempt never opens its socket
    for _ in 0..8 {
        yield_now().await;
    }

    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(!client.carries(BEARER), "carries none");
    assert_eq!(server.accepted.load(Ordering::SeqCst), 0, "no socket");
    assert_eq!(
        (recorder.errors(), recorder.closes()),
        (vec![], vec![]),
        "nothing told"
    );
}

#[tokio::test]
async fn refuses_a_credential_and_a_credential_provider_given_together() {
    let client = client();
    let refused = settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential: Some(BEARER.to_owned()),
        credential_provider: Some(handing(BEARER)),
        ..to(8_080)
    }))
    .await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "a connect takes a credential or a credential provider, not both"),
        "{refused:?}"
    );
    assert!(
        is_state(&client, ReadyState::Uninitialized),
        "nothing moved"
    );
}

// spec 15.6
#[tokio::test]
async fn fails_its_connect_on_a_redirect_answered_to_its_upgrade_naming_its_status() {
    // to a server that would take the upgrade: followed, the connect would open there
    let taking = hearing(None).await;
    let redirect: &'static str = Box::leak(
        format!(
            "HTTP/1.1 302 Found\r\nLocation: ws://{LOOPBACK}:{}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            taking.port
        )
        .into_boxed_str(),
    );
    let redirecting = hearing(Some(redirect)).await;
    let client = client();
    let refused = settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential: Some(BEARER.to_owned()),
        ..to(redirecting.port)
    }))
    .await;

    assert!(
        matches!(&refused, Err(TransportError::Connect(error)) if error.message() == "the server refused the upgrade: 302"),
        "{refused:?}"
    );
    assert_eq!(
        [
            is_state(&client, ReadyState::Closed),
            client.carries(BEARER)
        ],
        [true, false],
        "closed, carrying none"
    );
    assert!(taking.heard.lock().unwrap().is_empty(), "never followed");
}

// ── An upgrade refused ───────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn names_the_status_and_the_reason_of_an_upgrade_refused() {
    for (refusal, message) in [
        (
            FORBIDDEN,
            "the server refused the upgrade: 403 host-refused",
        ),
        (BAD_GATEWAY, "the server refused the upgrade: 502"),
    ] {
        let refusing = hearing(Some(refusal)).await;
        let client = client();
        let refused = settled(client.connect(&to(refusing.port))).await;

        assert!(
            matches!(&refused, Err(TransportError::Connect(error)) if error.message() == message),
            "{refused:?}"
        );
        assert!(is_state(&client, ReadyState::Closed), "closed");
    }
}

// ── By a name ────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn connects_by_a_name_to_a_server_that_listens_on_one_loopback_family_alone_whichever_it_is()
{
    let mut addresses = vec![LOOPBACK];

    if has_ipv6_loopback().await {
        addresses.push("::1");
    }

    for address in addresses {
        let server = WebSocketTransportServer::new(&WebSocketTransportServerOptions {
            close_timeout: Some(Duration::from_millis(100)),
            ..WebSocketTransportServerOptions::default()
        })
        .unwrap();
        let TransportServerAddress { port, .. } = patience(
            PATIENCE,
            server.start(&TransportServerStartOptions {
                address: Some(address.to_owned()),
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            }),
        )
        .await
        .unwrap()
        .unwrap();
        let client = client();
        let began = Instant::now();

        settled(client.connect(&WebSocketTransportClientConnectOptions::new(
            "localhost",
            port,
        )))
        .await
        .unwrap();

        // the families raced, as RFC 8305 asks: no wait on the one that is refused
        assert_eq!(
            (
                address,
                client.ready_state(),
                began.elapsed() < Duration::from_millis(1_500)
            ),
            (address, ReadyState::Open, true),
            "raced"
        );
        client.dispose();
        patience(PATIENCE, server.stop()).await.unwrap().unwrap();
    }
}
