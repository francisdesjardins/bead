use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::SystemTime;

use futures_util::{SinkExt, StreamExt};
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
    // the refusal it answers each upgrade with from now on, none upgrading
    refusal: Arc<Mutex<Option<&'static str>>>,
    upgraded: tokio::sync::Mutex<mpsc::UnboundedReceiver<Peer>>,
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

    async fn next_upgraded(&self) -> Peer {
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
    let refusal = Arc::new(Mutex::new(refusal));
    let (hearing, counting, refusing, stopping) = (
        Arc::clone(&heard),
        Arc::clone(&accepted),
        Arc::clone(&refusal),
        stop.clone(),
    );

    spawn(async move {
        loop {
            let Some(Ok((mut socket, _))) = first_value(&stopping, listener.accept()).await else {
                return;
            };

            counting.fetch_add(1, Ordering::SeqCst);

            let refused = *refusing.lock().unwrap();
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
                    taken.send(peer_of(upgraded)).ok();
                }
            });
        }
    });

    Hearing {
        port,
        heard,
        accepted,
        refusal,
        upgraded: tokio::sync::Mutex::new(upgraded),
        stop,
    }
}

/// A connection a server took, as `ws` holds one: read all along, its close answered at once.
/// What it reads is handed to the test, and what the test sends goes out on it; dropped, it drops
/// its socket.
struct Peer {
    inbound: mpsc::UnboundedReceiver<Message>,
    outbound: mpsc::UnboundedSender<Message>,
}

impl Peer {
    // the next message it read; none once its connection ended
    async fn next(&mut self) -> Option<Message> {
        patience(PATIENCE, self.inbound.recv())
            .await
            .expect("a message or the end within patience")
    }

    fn send(&self, message: Message) {
        self.outbound.send(message).ok();
    }

    // the status of the close it read, the messages before it passed; none once its connection
    // ended without one
    async fn close_code(&mut self) -> Option<u16> {
        loop {
            if let Message::Close(frame) = self.next().await? {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
    }

    // waits for the end of its connection
    async fn ended(&mut self) {
        while self.next().await.is_some() {}
    }
}

fn peer_of(upgraded: WebSocketStream<TcpStream>) -> Peer {
    let (inbound_sender, inbound) = mpsc::unbounded_channel();
    let (outbound, mut outbound_receiver) = mpsc::unbounded_channel::<Message>();

    spawn(async move {
        let (mut sink, mut stream) = upgraded.split();

        loop {
            tokio::select! {
                read = stream.next() => match read {
                    Some(Ok(message)) => {
                        inbound_sender.send(message).ok();
                    }
                    Some(Err(_)) | None => return,
                },
                sent = outbound_receiver.recv() => match sent {
                    Some(message) => {
                        if sink.send(message).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                },
            }
        }
    });

    Peer { inbound, outbound }
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
        upgraded.next().await,
        Some(Message::Binary(Bytes::from_static(b"hello"))),
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

// ── A raw server ─────────────────────────────────────────────────────────────────────────────

/// A server that completes each upgrade by hand and hands the test its socket, raw: what goes
/// after its 101 is the test's to write, and so is its end.
struct Raw {
    port: u16,
    upgraded: mpsc::UnboundedReceiver<TcpStream>,
    stop: CancellationToken,
}

impl Drop for Raw {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Raw {
    // the next socket it upgraded, its 101 written
    async fn next(&mut self) -> TcpStream {
        patience(PATIENCE, self.upgraded.recv())
            .await
            .unwrap()
            .unwrap()
    }
}

async fn raw() -> Raw {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (take, upgraded) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let stopping = stop.clone();

    spawn(async move {
        while let Some(Ok((mut socket, _))) = first_value(&stopping, listener.accept()).await {
            let head = String::from_utf8(head_of(&mut socket).await).unwrap();
            let key = head
                .split("\r\n")
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-key"))
                        .map(|(_, key)| key.trim().to_owned())
                })
                .unwrap_or_default();
            let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());

            socket
                .write_all(
                    format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            take.send(socket).ok();
        }
    });

    Raw {
        port,
        upgraded,
        stop,
    }
}

// a frame as a server writes it, unmasked, whole: its opcode, then its payload, up to 64 KiB
fn frame_of(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x80 | opcode];

    if let Ok(short) = u8::try_from(payload.len())
        && short < 126
    {
        frame.push(short);
    } else {
        frame.push(126);
        frame.extend_from_slice(&u16::try_from(payload.len()).unwrap().to_be_bytes());
    }

    frame.extend_from_slice(payload);
    frame
}

// a frame of an opcode RFC 6455 reserves, which fails the connection that reads it (§5.2)
fn reserved_frame() -> Vec<u8> {
    frame_of(0x3, &[0x78])
}

// a close of `code`, as a server sends one
fn close_frame(code: u16) -> Vec<u8> {
    frame_of(0x8, &code.to_be_bytes())
}

// the next frame a client sent, its payload unmasked: its opcode and its payload; none once the
// socket ended
async fn frame_from(socket: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let mut head = [0_u8; 2];

    socket.read_exact(&mut head).await.ok()?;

    let length = match head[1] & 0x7f {
        126 => {
            let mut extended = [0_u8; 2];

            socket.read_exact(&mut extended).await.ok()?;
            usize::from(u16::from_be_bytes(extended))
        }
        127 => {
            let mut extended = [0_u8; 8];

            socket.read_exact(&mut extended).await.ok()?;
            usize::try_from(u64::from_be_bytes(extended)).ok()?
        }
        short => usize::from(short),
    };
    let mut mask = [0_u8; 4];
    let mut payload = vec![0_u8; length];

    socket.read_exact(&mut mask).await.ok()?;
    socket.read_exact(&mut payload).await.ok()?;

    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }

    Some((head[0] & 0x0f, payload))
}

// the code of a close a client sent, once it came, each other frame read past; none once the
// socket ended
async fn close_code_from(socket: &mut TcpStream) -> Option<u16> {
    patience(PATIENCE, async {
        loop {
            let (opcode, payload) = frame_from(socket).await?;

            if opcode == 0x8 {
                return Some(u16::from_be_bytes([
                    payload.first().copied().unwrap_or(0),
                    payload.get(1).copied().unwrap_or(0),
                ]));
            }
        }
    })
    .await
    .expect("a close within patience")
}

// what a client tells, in order: each error's message, then its close
fn told_of(recorder: &Recorder) -> Vec<String> {
    let told = recorder.told.lock().unwrap();
    let mut said: Vec<String> = told
        .errors
        .iter()
        .map(|error| format!("error: {error}"))
        .collect();

    said.extend(
        told.closes
            .iter()
            .map(|(was_clean, is_quick)| format!("close: {was_clean} {is_quick}")),
    );
    said
}

async fn closes_within(recorder: &Recorder, count: usize) -> Vec<(bool, bool)> {
    patience(PATIENCE, async {
        loop {
            let changed = recorder.changed.notified();
            let closes = recorder.closes();

            if closes.len() >= count {
                return closes;
            }

            changed.await;
        }
    })
    .await
    .expect("the closes within patience")
}

async fn messages_within(recorder: &Recorder, count: usize) -> Vec<Bytes> {
    patience(PATIENCE, async {
        loop {
            let changed = recorder.changed.notified();
            let messages = recorder.messages();

            if messages.len() >= count {
                return messages;
            }

            changed.await;
        }
    })
    .await
    .expect("the messages within patience")
}

// a client whose timers that bound its socket run on `platform`, a test's clock
fn on_platform(
    platform: &Arc<SteppingClock>,
    options: &WebSocketTransportClientOptions,
) -> WebSocketTransportClient {
    let runtime = platform::socket_runtime_of(None, "a test's client").unwrap();

    WebSocketTransportClient::on_platform((runtime, Arc::<SteppingClock>::clone(platform)), options)
        .unwrap()
}

async fn disconnected(client: &WebSocketTransportClient) -> Result<(), TransportError> {
    patience(
        PATIENCE,
        client.disconnect(&TransportClientDisconnectOptions::default()),
    )
    .await
    .expect("the close within patience")
}

async fn reconnected(
    client: &WebSocketTransportClient,
    options: &TransportClientReconnectOptions,
) -> Result<(), TransportError> {
    let reconnecting = client.reconnect(options)?;

    patience(PATIENCE, reconnecting)
        .await
        .expect("the reconnection within patience")
}

fn reconnecting_by((delay, maximum_attempts): (Duration, u32)) -> TransportClientReconnectOptions {
    TransportClientReconnectOptions {
        delay: Some(crate::TransportClientReconnectDelay::Fixed(delay)),
        maximum_attempts: Some(maximum_attempts),
        ..TransportClientReconnectOptions::default()
    }
}

fn binary(bytes: &'static [u8]) -> TransportMessage {
    TransportMessage {
        data: Bytes::from_static(bytes),
        ..TransportMessage::default()
    }
}

// ── Its connect, alongside a reconnection or a close ─────────────────────────────────────────

#[tokio::test]
async fn rejects_a_connect_while_reconnecting() {
    let server = hearing(None).await;
    let client = client();
    let signal = CancellationToken::new();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();

    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            signal: Some(signal.clone()),
            ..reconnecting_by((Duration::from_mins(1), 5))
        })
        .unwrap();
    let refused = settled(client.connect(&to(server.port))).await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client is already reconnecting"),
        "{refused:?}"
    );

    signal.cancel();

    let cancelled = patience(PATIENCE, reconnecting).await.unwrap();

    assert!(
        matches!(&cancelled, Err(TransportError::Cancelled { message, .. }) if message == RECONNECTION_CANCELLED),
        "{cancelled:?}"
    );
    client.dispose();
}

#[tokio::test]
async fn rejects_a_connect_while_a_disconnect_is_pending() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let _upgraded = server.next_upgraded().await;
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());
    let refused = settled(client.connect(&to(server.port))).await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client is already closing"),
        "{refused:?}"
    );
    client.dispose();
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();
}

// ── Its send ─────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn delivers_a_uint8_array() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;

    client.send(binary(b"hello")).unwrap();

    assert_eq!(
        upgraded.next().await,
        Some(Message::Binary(Bytes::from_static(b"hello"))),
        "binary"
    );
    client.dispose();
}

#[tokio::test]
async fn carries_no_credential_the_envelope_alone_goes() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;

    client
        .send(TransportMessage {
            credential: Some(BEARER.to_owned()),
            ..binary(b"hello")
        })
        .unwrap();

    assert_eq!(
        upgraded.next().await,
        Some(Message::Binary(Bytes::from_static(b"hello"))),
        "the envelope alone"
    );
    client.dispose();
}

#[tokio::test]
async fn rejects_with_a_ready_state_error_after_disconnecting() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();

    let refused = client.send(binary(b"HelloWorld"));

    assert!(
        matches!(&refused, Err(RouterError::Other(error)) if error.downcast_ref::<ReadyStateError>().is_some()),
        "{refused:?}"
    );
}

#[tokio::test]
async fn delivers_a_fragmented_message_whole_then_the_next_message_separately() {
    let mut server = raw().await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;
    // its first two bytes a frame that does not end the message, its third the continuation
    let mut frames = vec![0x02, 2, 1, 2];

    frames.extend(frame_of(0x0, &[3]));
    frames.extend(frame_of(0x2, &[4]));
    socket.write_all(&frames).await.unwrap();

    assert_eq!(
        messages_within(&recorder, 2).await,
        [Bytes::from_static(&[1, 2, 3]), Bytes::from_static(&[4])],
        "whole, then the next"
    );
    client.dispose();
}

// ── Its "message" event ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn emits_what_the_server_sends_text_as_a_string_binary_as_an_array_buffer() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let upgraded = server.next_upgraded().await;

    upgraded.send(Message::text("text"));
    upgraded.send(Message::Binary(Bytes::from_static(b"binary")));

    // * a text message is no envelope: reported, handed nothing; a binary one handed whole
    assert_eq!(
        messages_within(&recorder, 1).await,
        [Bytes::from_static(b"binary")],
        "the binary one"
    );
    assert_eq!(
        recorder
            .errors()
            .iter()
            .map(|error| error.ends_with("ENVELOPE_MALFORMED: an envelope is binary, not a string"))
            .collect::<Vec<_>>(),
        [true],
        "the text one reported"
    );
    client.dispose();
}

#[tokio::test]
async fn echoes_a_round_trip() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;

    client.send(binary(b"ping")).unwrap();

    let echoed = upgraded.next().await.unwrap();

    upgraded.send(echoed);

    assert_eq!(
        messages_within(&recorder, 1).await,
        [Bytes::from_static(b"ping")],
        "echoed"
    );
    client.dispose();
}

#[tokio::test]
async fn hears_the_next_message_after_a_message_listener_throws_the_throw_reported() {
    struct Throwing(AtomicBool);

    impl ClientListener for Throwing {
        fn on_message(&self, _message: TransportMessage) {
            assert!(
                self.0.swap(true, Ordering::SeqCst),
                "a message listener that throws"
            );
        }
    }

    let server = hearing(None).await;
    let client = client();

    client.listen(Arc::new(Throwing(AtomicBool::new(false))));

    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let upgraded = server.next_upgraded().await;

    for byte in [&[1_u8][..], &[2]] {
        upgraded.send(Message::Binary(Bytes::copy_from_slice(byte)));
    }

    assert_eq!(
        messages_within(&recorder, 2).await,
        [Bytes::from_static(&[1]), Bytes::from_static(&[2])],
        "both heard"
    );
    assert_eq!(recorder.errors().len(), 1, "the throw reported once");
    assert!(
        recorder.errors()[0].contains("a message listener that throws"),
        "{:?}",
        recorder.errors()
    );
    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

#[tokio::test]
async fn emits_no_message_once_a_disconnect_has_begun() {
    let mut server = raw().await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;

    socket.write_all(&frame_of(0x2, b"early")).await.unwrap();
    messages_within(&recorder, 1).await;

    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());

    // what comes once its close went out, then its server's answer
    assert_eq!(close_code_from(&mut socket).await, Some(1000), "its close");
    socket.write_all(&frame_of(0x2, b"late")).await.unwrap();
    socket.write_all(&close_frame(1000)).await.unwrap();
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    assert_eq!(
        recorder.messages(),
        [Bytes::from_static(b"early")],
        "the early one alone"
    );
}

// ── Its disconnect ───────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn resolves_when_disconnecting() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();

    assert!(is_state(&client, ReadyState::Closed), "closed");
}

#[tokio::test]
async fn rejects_with_a_ready_state_error_before_connecting() {
    assert!(
        matches!(
            disconnected(&client()).await,
            Err(TransportError::ReadyState(_))
        ),
        "refused"
    );
}

#[tokio::test]
async fn rejects_with_a_ready_state_error_on_a_closed_connection() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();

    assert!(
        matches!(
            disconnected(&client).await,
            Err(TransportError::ReadyState(_))
        ),
        "refused"
    );
}

#[tokio::test]
async fn emits_close_with_was_clean_true_and_was_quick_false_when_the_client_disconnects() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());
    // its 1000, at the server's end too
    let code = upgraded.close_code().await;

    upgraded.ended().await;
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    assert_eq!(recorder.closes(), [(true, false)], "clean, not quick");
    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert_eq!(code, Some(1000), "1000");
}

#[tokio::test]
async fn emits_close_with_was_clean_true_and_was_quick_true_when_the_client_quickly_disconnects() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    patience(
        PATIENCE,
        client.disconnect(&TransportClientDisconnectOptions {
            is_clean: Some(true),
            is_quick: Some(true),
        }),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(recorder.closes(), [(true, true)], "clean and quick");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

#[tokio::test]
async fn emits_close_with_was_clean_false_and_was_quick_false_when_the_server_disconnects_and_refuses_a_send_after_it()
 {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let upgraded = server.next_upgraded().await;

    upgraded.send(Message::Close(None));

    assert_eq!(
        closes_within(&recorder, 1).await,
        [(false, false)],
        "unclean"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(client.send(binary(&[1])).is_err(), "refused");
}

#[tokio::test]
async fn dispose_during_a_disconnect_settles_it_without_a_close_and_the_client_can_connect_again() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());

    client.dispose();
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    // dropped, not closed by a handshake
    assert!(recorder.closes().is_empty(), "no close");
    assert!(is_state(&client, ReadyState::Closed), "closed");

    settled(client.connect(&to(server.port))).await.unwrap();

    assert!(is_state(&client, ReadyState::Open), "open again");
    client.dispose();
}

#[tokio::test]
async fn an_explicit_undefined_disconnect_option_falls_back_to_its_default() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    patience(
        PATIENCE,
        client.disconnect(&TransportClientDisconnectOptions {
            is_clean: None,
            is_quick: None,
        }),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(recorder.closes(), [(true, false)], "its defaults");
}

#[tokio::test]
async fn dispose_on_a_client_never_connected_does_nothing() {
    let client = client();

    client.dispose();

    assert!(
        is_state(&client, ReadyState::Uninitialized),
        "uninitialized"
    );
}

#[tokio::test]
async fn dispose_on_an_open_client_leaves_it_closed_and_ready_to_connect_again() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    client.dispose();

    assert!(is_state(&client, ReadyState::Closed), "closed");
    assert!(
        matches!(client.send(binary(b"x")), Err(RouterError::Other(error)) if error.to_string() == "the transport client is closed, not open"),
        "refused, closed"
    );

    settled(client.connect(&to(server.port))).await.unwrap();

    assert!(is_state(&client, ReadyState::Open), "open again");
    client.dispose();
}

#[tokio::test]
async fn a_second_disconnect_rejected_leaves_the_first_for_dispose_to_settle_with_no_close() {
    let mut server = raw().await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    // the server never answers the first close
    let _socket = server.next().await;
    let first = client.disconnect(&TransportClientDisconnectOptions::default());

    assert!(
        matches!(
            disconnected(&client).await,
            Err(TransportError::ReadyState(_))
        ),
        "the second refused"
    );

    client.dispose();
    patience(PATIENCE, first).await.unwrap().unwrap();

    assert!(is_state(&client, ReadyState::Closed), "closed");
    // dropped without a handshake, as a dispose does: no close says otherwise
    assert!(recorder.closes().is_empty(), "no close");

    settled(client.connect(&to(server.port))).await.unwrap();

    assert!(is_state(&client, ReadyState::Open), "open again");
    client.dispose();
}

// ── Its reconnect ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn reconnects_after_a_disconnect() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();
    reconnected(&client, &reconnecting_by((Duration::from_millis(10), 1)))
        .await
        .unwrap();

    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

#[tokio::test]
async fn reconnects_though_a_reconnect_listener_throws_the_throw_reported_the_next_listener_told() {
    struct Throwing;

    impl ClientListener for Throwing {
        fn on_reconnect(&self) {
            panic!("a reconnect listener that throws");
        }
    }

    let server = hearing(None).await;
    let client = client();

    client.listen(Arc::new(Throwing));

    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();
    reconnected(&client, &reconnecting_by((Duration::from_millis(10), 1)))
        .await
        .unwrap();

    assert!(is_state(&client, ReadyState::Open), "open");
    assert_eq!(
        recorder.told.lock().unwrap().reconnects,
        1,
        "the next one told"
    );
    assert_eq!(recorder.errors().len(), 1, "the throw reported");
    assert!(
        recorder.errors()[0].contains("a reconnect listener that throws"),
        "{:?}",
        recorder.errors()
    );
    client.dispose();
}

#[tokio::test]
async fn reconnects_an_open_transport_without_emitting_close() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(crate::TransportClientReconnectDelay::Fixed(
                Duration::from_millis(10),
            )),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await
    .unwrap();

    assert!(is_state(&client, ReadyState::Open), "open");
    assert!(recorder.closes().is_empty(), "no close");
    client.dispose();
}

#[tokio::test]
async fn reconnects_to_the_target_of_the_last_accepted_connect() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let refused = settled(client.connect(&to(server.port.wrapping_add(1)))).await;

    assert!(
        matches!(refused, Err(TransportError::Refused(_))),
        "{refused:?}"
    );

    reconnected(&client, &reconnecting_by((Duration::ZERO, 5)))
        .await
        .unwrap();

    assert!(is_state(&client, ReadyState::Open), "open");
    assert_eq!(server.heard.lock().unwrap().len(), 2, "both to it");
    client.dispose();
}

#[tokio::test]
async fn rejects_while_a_disconnect_is_pending() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();

    let _upgraded = server.next_upgraded().await;
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());
    let refused = client.reconnect(&TransportClientReconnectOptions::default());

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client cannot reconnect while closing"),
        "refused"
    );
    client.dispose();
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();
}

#[tokio::test]
async fn rejects_while_a_connect_is_pending_and_that_connect_still_opens() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();

    let connecting = client.connect(&to(server.port));

    assert!(
        matches!(
            client.reconnect(&TransportClientReconnectOptions::default()),
            Err(TransportError::Refused(_))
        ),
        "refused"
    );
    settled(connecting).await.unwrap();
    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

#[tokio::test]
async fn rejects_with_a_reconnect_error_caused_by_a_connect_error_when_the_server_is_gone() {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let upgraded = server.next_upgraded().await;

    drop(server);
    drop(upgraded);
    closes_within(&recorder, 1).await;

    let failed = reconnected(&client, &reconnecting_by((Duration::from_millis(10), 2))).await;
    let Err(TransportError::Reconnect(error)) = &failed else {
        panic!("a reconnect error: {failed:?}");
    };

    assert!(
        matches!(
            error
                .source()
                .and_then(|cause| cause.downcast_ref::<TransportError>()),
            Some(TransportError::Connect(_))
        ),
        "caused by a connect error"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// ── Its ready state ──────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn only_one_ready_state_is_true_at_a_time() {
    let server = hearing(None).await;
    let client = client();

    assert_eq!(client.ready_state(), ReadyState::Uninitialized, "first");

    let connecting = client.connect(&to(server.port));

    assert_eq!(client.ready_state(), ReadyState::Connecting, "connecting");
    settled(connecting).await.unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open, "open");

    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());

    assert_eq!(client.ready_state(), ReadyState::Closing, "closing");
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
}

// ── What it carries, across a reconnection ───────────────────────────────────────────────────

// spec 15.2, 15.15
#[tokio::test]
async fn calls_its_credential_provider_at_each_attempt_a_reconnection_s_included_and_carries_the_bytes_it_handed()
 {
    let server = hearing(None).await;
    let client = client();
    let signals: Arc<Mutex<Vec<CancellationToken>>> = Arc::default();
    let handed = Arc::new(AtomicUsize::new(0));
    let (keeping, counting) = (Arc::clone(&signals), Arc::clone(&handed));

    settled(client.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(move |signal: CancellationToken| {
            keeping.lock().unwrap().push(signal);

            let call = counting.fetch_add(1, Ordering::SeqCst).saturating_add(1);

            // * its second call fails: that attempt fails, its failure the cause, and the next
            // calls it again
            Box::pin(async move {
                if call == 2 {
                    return Err("the token store is away".into());
                }

                Ok(format!("Bearer token-{call}"))
            })
        })),
        ..to(server.port)
    }))
    .await
    .unwrap();

    assert_eq!(
        (
            server.authorizations(),
            client.carries("Bearer token-1"),
            handed.load(Ordering::SeqCst)
        ),
        (vec![vec!["Bearer token-1".to_owned()]], true, 1),
        "the first"
    );

    reconnected(&client, &reconnecting_by((Duration::ZERO, 2)))
        .await
        .unwrap();

    // the failed attempt went nowhere: the next one carries what the provider handed it
    assert_eq!(
        (
            server.authorizations(),
            client.carries("Bearer token-1"),
            client.carries("Bearer token-3"),
            handed.load(Ordering::SeqCst)
        ),
        (
            vec![
                vec!["Bearer token-1".to_owned()],
                vec!["Bearer token-3".to_owned()]
            ],
            false,
            true,
            3
        ),
        "the third"
    );

    // each told when its attempt is over
    let told = signals.lock().unwrap().clone();

    for signal in &told {
        patience(PATIENCE, signal.cancelled()).await.unwrap();
    }

    assert_eq!(told.len(), 3, "three attempts");
    client.dispose();

    // a provider's failure fails the connect, its cause
    let failing = self::client();
    let failed = settled(failing.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(|_signal| {
            Box::pin(async { Err("the token store is away".into()) })
        })),
        ..to(server.port)
    }))
    .await;

    assert_eq!(
        source_of(&failed).as_deref(),
        Some("the token store is away"),
        "its cause"
    );
    assert_eq!(
        (
            is_state(&failing, ReadyState::Closed),
            server.authorizations().len()
        ),
        (true, 2),
        "closed, no upgrade"
    );
}

// spec 13.4, 15.2 and 15.5
#[tokio::test]
async fn refuses_a_credential_that_is_no_field_value_a_space_or_a_tab_first_or_last_among_them_or_over_a_url_in_the_clear_off_the_loopback_before_its_upgrade_goes()
 {
    let server = hearing(None).await;
    let client = client();

    for credential in [
        format!(" {BEARER}"),
        format!("{BEARER} "),
        format!("\t{BEARER}"),
        format!("{BEARER}\t"),
        "Bearer a\r\nb".to_owned(),
        "Bearer \u{e9}".to_owned(),
        "Bearer \u{0}".to_owned(),
    ] {
        let refused = settled(client.connect(&WebSocketTransportClientConnectOptions {
            credential: Some(credential.clone()),
            ..to(server.port)
        }))
        .await;

        assert!(
            matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == NO_FIELD_VALUE),
            "{credential:?}: {refused:?}"
        );
    }

    // the upgrade itself would carry it in the clear, a provider's alike, which is never called
    let called = Arc::new(AtomicUsize::new(0));
    let calling = Arc::clone(&called);
    let provider: CredentialProvider = Arc::new(move |_signal| {
        calling.fetch_add(1, Ordering::SeqCst);

        Box::pin(async { Ok(BEARER.to_owned()) })
    });

    for faraway in [
        WebSocketTransportClientConnectOptions {
            credential: Some(BEARER.to_owned()),
            ..WebSocketTransportClientConnectOptions::new("192.0.2.1", server.port)
        },
        WebSocketTransportClientConnectOptions {
            credential_provider: Some(Arc::clone(&provider)),
            ..WebSocketTransportClientConnectOptions::new("example.com", server.port)
        },
    ] {
        let refused = settled(client.connect(&faraway)).await;

        assert!(
            matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback"),
            "{refused:?}"
        );
    }

    // nothing moved: no state, no target a reconnection replays, no upgrade sent
    assert_eq!(
        (
            called.load(Ordering::SeqCst),
            client.ready_state(),
            server.heard.lock().unwrap().len()
        ),
        (0, ReadyState::Uninitialized, 0),
        "nothing moved"
    );
    assert!(
        matches!(&client.reconnect(&TransportClientReconnectOptions::default()), Err(TransportError::Refused(error)) if error.to_string() == "the transport client was never connected"),
        "never connected"
    );

    // a provider's value, held alike once handed: the connect fails, and a reconnection does not
    // try again what no attempt would mend
    let handed = Arc::new(Mutex::new(BEARER.to_owned()));
    let (handing, calling) = (Arc::clone(&handed), Arc::clone(&called));
    let renewing = self::client();

    settled(renewing.connect(&WebSocketTransportClientConnectOptions {
        credential_provider: Some(Arc::new(move |_signal| {
            calling.fetch_add(1, Ordering::SeqCst);

            let credential = handing.lock().unwrap().clone();

            Box::pin(async move { Ok(credential) })
        })),
        ..to(server.port)
    }))
    .await
    .unwrap();
    *handed.lock().unwrap() = format!("{BEARER} ");

    let refused = reconnected(&renewing, &reconnecting_by((Duration::ZERO, 3))).await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == NO_FIELD_VALUE),
        "{refused:?}"
    );
    assert_eq!(
        (
            called.load(Ordering::SeqCst),
            renewing.ready_state(),
            server.authorizations()
        ),
        (2, ReadyState::Closed, vec![vec![BEARER.to_owned()]]),
        "once each"
    );
}

// ── Its message limit ────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn closes_with_1009_a_message_past_an_envelope_s_limit_16_778_240_bytes_over_ws_when_told_no_bound()
 {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;
    let maximum = usize::try_from(MAXIMUM_MESSAGE_BYTES).unwrap();

    upgraded.send(Message::Binary(Bytes::from(vec![0_u8; maximum])));

    assert_eq!(
        messages_within(&recorder, 1).await[0].len(),
        16_778_240,
        "whole"
    );

    upgraded.send(Message::Binary(Bytes::from(vec![0_u8; maximum + 1])));

    let code = upgraded.close_code().await;

    assert_eq!(code, Some(1009), "1009");
    closes_within(&recorder, 1).await;
    assert_eq!(recorder.messages().len(), 1, "the first alone");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// ── What its error tells ─────────────────────────────────────────────────────────────────────

// spec 15.1
#[tokio::test]
async fn tells_a_server_that_drops_without_its_closing_handshake_by_a_fin_or_a_reset_by_its_unclean_close_alone_no_error()
 {
    let mut server = raw().await;

    for is_reset in [false, true] {
        let client = client();
        let recorder = recorded(&client);

        settled(client.connect(&to(server.port))).await.unwrap();

        let mut socket = server.next().await;

        if is_reset {
            // a linger of 0: its close an abort, a reset sent rather than a FIN (RFC 9293 §3.10.5)
            socket2::SockRef::from(&socket)
                .set_linger(Some(Duration::ZERO))
                .unwrap();
            drop(socket);
        } else {
            socket.shutdown().await.unwrap();
        }

        closes_within(&recorder, 1).await;

        assert_eq!(
            told_of(&recorder),
            ["close: false false"],
            "its close alone"
        );
    }
}

// spec 15.1
#[tokio::test]
async fn tells_a_protocol_error_on_its_connection_once_then_its_unclean_close() {
    let mut server = raw().await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;

    socket.write_all(&reserved_frame()).await.unwrap();
    socket.write_all(&reserved_frame()).await.unwrap();

    // it ends its socket once the client's close came
    assert_eq!(close_code_from(&mut socket).await, Some(1002), "1002");
    socket.shutdown().await.unwrap();
    closes_within(&recorder, 1).await;

    let told = told_of(&recorder);

    assert_eq!(told.len(), 2, "{told:?}");
    assert!(
        told[0].starts_with("error: the connection is closed with 1002"),
        "{told:?}"
    );
    assert_eq!(told[1], "close: false false", "unclean");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// spec 15.1
#[tokio::test]
async fn fails_with_1009_a_message_past_its_bound_telling_one_error_that_names_maximum_message_bytes_then_an_unclean_close_even_when_its_server_answers_its_close()
 {
    let mut server = raw().await;
    let client = client_of(&WebSocketTransportClientOptions {
        maximum_message_bytes: Some(1_024),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;

    socket
        .write_all(&frame_of(0x2, &[0_u8; 4_096]))
        .await
        .unwrap();

    // its close answered with a 1009 of its own, then its end
    let sent = close_code_from(&mut socket).await;

    socket.write_all(&close_frame(1009)).await.unwrap();
    socket.shutdown().await.unwrap();
    closes_within(&recorder, 1).await;

    assert_eq!(
        told_of(&recorder),
        [
            "error: the connection is closed with 1009: a message past its maximumMessageBytes, 1024 bytes",
            "close: false false"
        ],
        "one error, then its close"
    );
    assert_eq!(sent, Some(1009), "1009 sent");
}

// spec 15.1
#[tokio::test]
async fn fails_with_1009_a_message_past_its_bound_for_a_server_that_never_answers_telling_one_error_then_an_unclean_close_once_its_close_timeout_passed()
 {
    let mut server = raw().await;
    let client = client_of(&WebSocketTransportClientOptions {
        close_timeout: Some(Duration::from_millis(200)),
        maximum_message_bytes: Some(1_024),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;
    let began = Instant::now();

    // it reads its close and answers nothing, its socket held open
    socket
        .write_all(&frame_of(0x2, &[0_u8; 4_096]))
        .await
        .unwrap();
    closes_within(&recorder, 1).await;

    assert!(
        began.elapsed() >= Duration::from_millis(150),
        "its close timeout"
    );
    assert_eq!(
        told_of(&recorder),
        [
            "error: the connection is closed with 1009: a message past its maximumMessageBytes, 1024 bytes",
            "close: false false"
        ],
        "one error, then its close"
    );
}

// spec 15.1
#[tokio::test]
async fn fails_its_connection_on_a_protocol_error_whose_error_listener_throws_telling_its_close_all_the_same()
 {
    struct Throwing;

    impl ClientListener for Throwing {
        fn on_error(&self, _error: &RouterError) {
            panic!("an error listener that throws");
        }
    }

    let mut server = raw().await;
    let client = client();

    client.listen(Arc::new(Throwing));

    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;

    socket.write_all(&reserved_frame()).await.unwrap();
    close_code_from(&mut socket).await;
    socket.shutdown().await.unwrap();

    assert_eq!(
        closes_within(&recorder, 1).await,
        [(false, false)],
        "its close all the same"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// ── Its close timeout ────────────────────────────────────────────────────────────────────────

// spec 15.3
#[tokio::test]
async fn holds_its_close_timeout_to_a_whole_number_of_milliseconds_rounded_refusing_zero_and_runs_on_the_clock_it_is_given()
 {
    let clock = stepping();
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);

    assert!(
        stepping_client(&clock)
            .clock()
            .is_some_and(|given| Arc::ptr_eq(&given, &shared)),
        "the clock it was given"
    );
    assert!(client().clock().is_none(), "none given");

    for (given, held) in [
        (Duration::from_micros(1_400), true),
        (Duration::from_millis(1), true),
        (NEVER, true),
        (Duration::ZERO, false),
        (Duration::from_micros(400), false),
        (crate::LONGEST_TIMER + Duration::from_millis(1), false),
    ] {
        let built = WebSocketTransportClient::new(&WebSocketTransportClientOptions {
            close_timeout: Some(given),
            ..WebSocketTransportClientOptions::default()
        });

        assert_eq!(built.is_ok(), held, "{given:?}");

        if let Err(refused) = built {
            assert!(
                refused.to_string().starts_with("a close timeout "),
                "{refused}"
            );
        }
    }
}

// spec 15.3
#[tokio::test]
async fn drops_a_server_that_never_answers_its_disconnect_once_its_close_timeout_passed_telling_no_error_its_close_as_the_disconnect_said()
 {
    let mut server = raw().await;
    let client = client_of(&WebSocketTransportClientOptions {
        close_timeout: Some(Duration::from_millis(200)),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;
    let began = Instant::now();
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());

    // it reads its close and answers nothing, its socket held open
    let sent = close_code_from(&mut socket).await;

    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    assert!(
        began.elapsed() >= Duration::from_millis(150),
        "its close timeout"
    );
    assert_eq!(
        (told_of(&recorder), sent),
        (vec!["close: true false".to_owned()], Some(1000)),
        "its close as said"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// spec 15.3
#[tokio::test]
async fn waits_on_its_server_without_end_for_a_close_timeout_of_infinity_closing_once_it_answers() {
    let mut server = raw().await;
    let client = client_of(&WebSocketTransportClientOptions {
        close_timeout: Some(NEVER),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());
    let sent = close_code_from(&mut socket).await;

    // it answers nothing for longer than any close timeout of these tests
    let waited = patience(Duration::from_millis(300), async {
        loop {
            if client.ready_state() != ReadyState::Closing {
                return;
            }

            yield_now().await;
        }
    })
    .await;

    assert_eq!((sent, waited.is_err()), (Some(1000), true), "still closing");

    // its answer, then its end, as a server ends the closing handshake
    socket.write_all(&close_frame(1000)).await.unwrap();
    socket.shutdown().await.unwrap();
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    assert_eq!(told_of(&recorder), ["close: true false"], "clean");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// ── Its heartbeat ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn pings_its_server_every_heartbeat_over_a_socket_that_can_and_closes_at_the_beat_after_a_ping_it_left_unanswered()
 {
    let mut server = raw().await;
    let platform = stepping();
    let client = on_platform(
        &platform,
        &WebSocketTransportClientOptions {
            heartbeat: Some(Duration::from_millis(20)),
            ..WebSocketTransportClientOptions::default()
        },
    );
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut socket = server.next().await;
    let mut pings = 0_usize;

    // three answered, the fourth not
    for beat in 1..=4 {
        platform.advance(Duration::from_millis(20)).await;

        let (opcode, payload) = patience(PATIENCE, frame_from(&mut socket))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(opcode, 0x9, "a ping at beat {beat}");
        pings = pings.saturating_add(1);

        if beat < 4 {
            socket.write_all(&frame_of(0xa, &payload)).await.unwrap();

            // its pong read before the next beat
            crate::testing::rest(Duration::from_millis(50)).await;
        }
    }

    // dropped at the beat after, as a network drops it
    platform.advance(Duration::from_millis(20)).await;

    assert_eq!(
        closes_within(&recorder, 1).await,
        [(false, false)],
        "dropped"
    );
    assert_eq!(pings, 4, "four pings");
    assert!(ends(&mut socket).await, "its socket gone");
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

#[tokio::test]
async fn beats_every_heartbeat_when_told_nothing() {
    let server = hearing(None).await;
    let platform = stepping();
    let client = on_platform(&platform, &WebSocketTransportClientOptions::default());
    let connecting = client.connect(&to(server.port));

    // its connect within 30 seconds, on the platform's clock when it is given none
    assert_eq!(platform.dues(), [Duration::from_secs(30)], "its connect's");
    settled(connecting).await.unwrap();
    // then its heartbeat
    assert_eq!(platform.dues(), [HEARTBEAT], "its heartbeat's");
    // it asks for the root
    assert_eq!(
        server.heard.lock().unwrap()[0].uri().path(),
        "/",
        "the root"
    );
    client.dispose();
}

#[tokio::test]
async fn beats_nothing_over_a_socket_that_cannot_ping_a_browser_s_nor_with_a_heartbeat_of_infinity()
{
    let mut server = raw().await;
    let platform = stepping();
    let client = on_platform(
        &platform,
        &WebSocketTransportClientOptions {
            heartbeat: Some(NEVER),
            ..WebSocketTransportClientOptions::default()
        },
    );

    settled(client.connect(&to(server.port))).await.unwrap();

    let _socket = server.next().await;

    assert!(platform.dues().is_empty(), "nothing armed");
    platform.advance(Duration::from_hours(24)).await;
    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}

#[tokio::test]
async fn stops_beating_once_disconnected_dropped_or_closed_by_its_server_and_pings_no_socket_that_is_closing()
 {
    let server = hearing(None).await;
    let platform = stepping();
    let options = WebSocketTransportClientOptions {
        heartbeat: Some(Duration::from_millis(20)),
        close_timeout: Some(NEVER),
        ..WebSocketTransportClientOptions::default()
    };
    let disconnected_one = on_platform(&platform, &options);
    let dropped = on_platform(&platform, &options);
    let closed = on_platform(&platform, &options);
    let recorder = recorded(&closed);
    let mut upgraded = Vec::new();

    for client in [&disconnected_one, &dropped, &closed] {
        settled(client.connect(&to(server.port))).await.unwrap();
        upgraded.push(server.next_upgraded().await);
    }

    assert_eq!(platform.dues().len(), 3, "three beating");

    let disconnecting = disconnected_one.disconnect(&TransportClientDisconnectOptions::default());

    dropped.dispose();
    upgraded[2].send(Message::Close(None));
    closes_within(&recorder, 1).await;

    // those that closed beat no more, their timers gone
    assert!(platform.dues().is_empty(), "none beating");
    drop(upgraded);
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    // the server started its close handshake: no ping goes on it, and it is dropped all the same
    let mut raw = raw().await;
    let closing = on_platform(&platform, &options);
    let recorder = recorded(&closing);

    settled(closing.connect(&to(raw.port))).await.unwrap();

    let mut socket = raw.next().await;

    socket.write_all(&close_frame(1001)).await.unwrap();

    // its answer to the server's close
    assert_eq!(close_code_from(&mut socket).await, Some(1001), "its answer");

    platform.advance(Duration::from_millis(20)).await;
    platform.advance(Duration::from_millis(20)).await;

    assert_eq!(
        closes_within(&recorder, 1).await,
        [(false, false)],
        "dropped"
    );
    // nothing went after its answer, no ping among it
    assert_eq!(
        patience(PATIENCE, frame_from(&mut socket)).await.unwrap(),
        None,
        "no ping"
    );
}

#[tokio::test]
async fn closes_when_its_server_leaves_its_pings_unanswered_telling_no_error() {
    let mut server = raw().await;
    let client = client_of(&WebSocketTransportClientOptions {
        heartbeat: Some(Duration::from_millis(40)),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let _socket = server.next().await;

    assert_eq!(
        closes_within(&recorder, 1).await,
        [(false, false)],
        "dropped"
    );
    assert!(recorder.errors().is_empty(), "no error");
}

// ── An upgrade refused ───────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn carries_the_last_failure_of_a_reconnect_an_upgrade_refused_unmarked_named_by_its_status_over_ws()
 {
    let server = hearing(None).await;
    let client = client();
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    *server.refusal.lock().unwrap() = Some(BAD_GATEWAY);
    drop(server.next_upgraded().await);
    closes_within(&recorder, 1).await;

    let failed = reconnected(&client, &reconnecting_by((Duration::from_millis(10), 2))).await;
    let Err(TransportError::Reconnect(error)) = &failed else {
        panic!("a reconnect error: {failed:?}");
    };

    assert!(
        matches!(
            error
                .source()
                .and_then(|cause| cause.downcast_ref::<TransportError>()),
            Some(TransportError::Connect(cause)) if cause.message() == "the server refused the upgrade: 502"
        ),
        "{error:?}"
    );
    assert!(is_state(&client, ReadyState::Closed), "closed");
}

// ── Paused by its router ─────────────────────────────────────────────────────────────────────

// spec 15.12.17; RFC 6455 §7.1.1
#[tokio::test]
async fn a_paused_connection_closes_cleanly() {
    let server = hearing(None).await;
    let client = client_of(&WebSocketTransportClientOptions {
        close_timeout: Some(Duration::from_secs(2)),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let mut upgraded = server.next_upgraded().await;

    client.pause();
    upgraded.send(Message::Binary(Bytes::from_static(&[0; 4])));
    crate::testing::rest(Duration::from_millis(50)).await;

    // * paused, its socket reads no more, what it brought held
    assert!(recorder.messages().is_empty(), "held");

    let began = Instant::now();
    let disconnecting = client.disconnect(&TransportClientDisconnectOptions::default());

    upgraded.ended().await;
    patience(PATIENCE, disconnecting).await.unwrap().unwrap();

    // it read its server's Close, its own pause opened: clean, long before its close timeout
    assert_eq!(recorder.closes(), [(true, false)], "clean");
    assert!(
        began.elapsed() < Duration::from_millis(1_500),
        "before its timeout"
    );
    assert!(recorder.messages().is_empty(), "nothing handed");

    // * its pause outlasts the connection: one connected after holds until resumed
    settled(client.connect(&to(server.port))).await.unwrap();

    let again = server.next_upgraded().await;

    again.send(Message::Binary(Bytes::from_static(&[7])));
    crate::testing::rest(Duration::from_millis(50)).await;

    assert!(recorder.messages().is_empty(), "held again");

    client.resume();

    assert_eq!(
        messages_within(&recorder, 1).await,
        [Bytes::from_static(&[7])],
        "handed once resumed"
    );
    client.dispose();
}
