use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tungstenite::protocol::Message;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;

use super::*;
use crate::NEVER;
use crate::platform::JoinHandle;
use crate::testing::{Instant, SteppingClock, patience, rest};

const PATIENCE: Duration = Duration::from_secs(10);

// the date the test clock gives every refusal: 2026-01-01T00:00:00Z
const DATED: Duration = Duration::from_hours(490_896);

// an opening handshake's fields, from a host the servers below take
const HANDSHAKE_FIELDS: [&str; 5] = [
    "Host: bead.test",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
];

// what removes every field that asks an upgrade
const NO_UPGRADE: [&str; 4] = [
    "Upgrade",
    "Connection",
    "Sec-WebSocket-Key",
    "Sec-WebSocket-Version",
];

// ── What a server tells ────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Told {
    // the events told, by name, in their order
    order: Vec<&'static str>,
    connections: Vec<ConnectionHandle>,
    messages: Vec<(TransportMessage, ConnectionHandle)>,
    closes: Vec<(bool, ConnectionHandle)>,
    refusals: Vec<TransportServerRefusal>,
    errors: Vec<(String, Option<ConnectionHandle>)>,
}

#[derive(Default)]
struct Recorder {
    told: Mutex<Told>,
    changed: Notify,
}

impl Recorder {
    fn record<F: FnOnce(&mut Told)>(&self, (name, record): (&'static str, F)) {
        let mut told = self.told.lock().unwrap();

        told.order.push(name);
        record(&mut told);
        drop(told);
        self.changed.notify_waiters();
    }

    fn count(&self, of: fn(&Told) -> usize) -> usize {
        of(&self.told.lock().unwrap())
    }

    fn order(&self) -> Vec<&'static str> {
        self.told.lock().unwrap().order.clone()
    }

    // waits until `count` events of the kind `of` reads were told, and gives them
    async fn wait<T: Clone>(&self, count: usize, of: fn(&Told) -> &Vec<T>) -> Vec<T> {
        patience(PATIENCE, async {
            loop {
                let changed = self.changed.notified();
                let found = of(&self.told.lock().unwrap()).clone();

                if found.len() >= count {
                    return found;
                }

                changed.await;
            }
        })
        .await
        .expect("the events within patience")
    }

    async fn connections(&self, count: usize) -> Vec<ConnectionHandle> {
        self.wait(count, |told| &told.connections).await
    }

    async fn messages(&self, count: usize) -> Vec<(TransportMessage, ConnectionHandle)> {
        self.wait(count, |told| &told.messages).await
    }

    async fn closes(&self, count: usize) -> Vec<(bool, ConnectionHandle)> {
        self.wait(count, |told| &told.closes).await
    }

    async fn errors(&self, count: usize) -> Vec<(String, Option<ConnectionHandle>)> {
        self.wait(count, |told| &told.errors).await
    }

    fn refusals(&self) -> Vec<TransportServerRefusal> {
        self.told.lock().unwrap().refusals.clone()
    }
}

impl ServerListener for Recorder {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        self.record(("connection", |told: &mut Told| {
            told.connections.push(Arc::clone(connection_handle));
        }));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        self.record(("message", |told: &mut Told| {
            told.messages.push((message, Arc::clone(connection_handle)));
        }));
    }

    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        self.record(("close", |told: &mut Told| {
            told.closes.push((was_clean, Arc::clone(connection_handle)));
        }));
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        self.record(("refusal", |told: &mut Told| {
            told.refusals.push(refusal.clone());
        }));
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        self.record(("error", |told: &mut Told| {
            told.errors
                .push((error.to_string(), connection_handle.cloned()));
        }));
    }
}

// ── Servers and clients ────────────────────────────────────────────────────────────────────────

fn recorded(server: &WebSocketTransportServer) -> Arc<Recorder> {
    let recorder = Arc::new(Recorder::default());

    server.listen(Arc::<Recorder>::clone(&recorder));

    recorder
}

fn on_loopback() -> TransportServerStartOptions {
    TransportServerStartOptions {
        address: Some("127.0.0.1".to_owned()),
        find_open_port: Some(true),
        ..TransportServerStartOptions::default()
    }
}

// the options of a server whose close waits 100 ms on its peer: a stop does not wait out the
// default's 5 s on a raw peer that never answers its 1001, where the close timeout is not what a
// test holds
fn briefly_closing() -> WebSocketTransportServerOptions {
    WebSocketTransportServerOptions {
        close_timeout: Some(Duration::from_millis(100)),
        ..WebSocketTransportServerOptions::default()
    }
}

fn dated_at() -> SystemTime {
    SystemTime::UNIX_EPOCH.checked_add(DATED).unwrap()
}

fn dated() -> SharedClock {
    SteppingClock::new(dated_at())
}

// a server of `options`, started on the IPv4 loopback on a port the system drew, its recorder
async fn started(
    options: &WebSocketTransportServerOptions,
) -> (WebSocketTransportServer, Arc<Recorder>, u16) {
    let server = WebSocketTransportServer::new(options).unwrap();
    let recorder = recorded(&server);
    let bound = patience(PATIENCE, server.start(&on_loopback()))
        .await
        .unwrap()
        .unwrap();

    (server, recorder, bound.port)
}

async fn stopped(server: &WebSocketTransportServer) {
    patience(PATIENCE, server.stop()).await.unwrap().unwrap();
}

type Client = WebSocketStream<TcpStream>;

async fn client_with(port: u16, fields: &[(&str, &str)]) -> Client {
    let mut request = tungstenite::client::IntoClientRequest::into_client_request(format!(
        "ws://127.0.0.1:{port}/"
    ))
    .unwrap();

    for (name, value) in fields {
        request.headers_mut().append(
            http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            http::HeaderValue::from_str(value).unwrap(),
        );
    }

    let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (client, _) = patience(PATIENCE, tokio_tungstenite::client_async(request, socket))
        .await
        .unwrap()
        .unwrap();

    client
}

async fn client(port: u16) -> Client {
    client_with(port, &[]).await
}

async fn next_of(client: &mut Client) -> Option<Result<Message, tungstenite::Error>> {
    patience(PATIENCE, client.next()).await.unwrap()
}

// what the server answers `head` on a socket of its own: all of it once it closed the socket, or
// the head of a 101 once it came, and whether it closed it
async fn answer_of(port: u16, head: &str) -> (String, bool) {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

    socket.write_all(head.as_bytes()).await.unwrap();

    let mut text = Vec::new();
    let mut chunk = [0_u8; 4_096];

    patience(PATIENCE, async {
        loop {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => return (latin1(&text), true),
                Ok(read) => text.extend_from_slice(&chunk[..read]),
            }

            let read = latin1(&text);

            if read.starts_with("HTTP/1.1 101") && read.contains("\r\n\r\n") {
                return (read, false);
            }
        }
    })
    .await
    .unwrap()
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

// a request of `line` whose fields are an opening handshake's, changed by `changes`: a name alone
// removes its field, `Name: value` takes its place, and a name given twice gives two lines
fn request_of(line: &str, changes: &[&str]) -> String {
    let name_of = |field: &str| field.split(':').next().unwrap_or("").trim().to_lowercase();
    let removed: Vec<String> = changes.iter().map(|change| name_of(change)).collect();
    let mut request = format!("{line}\r\n");

    for field in HANDSHAKE_FIELDS
        .iter()
        .filter(|field| !removed.contains(&name_of(field)))
        .chain(changes.iter().filter(|change| change.contains(':')))
    {
        request.push_str(field);
        request.push_str("\r\n");
    }

    request.push_str("\r\n");
    request
}

// a refusal of the transport's own, whole, the test clock's date in it
fn refused_with(status: &str, (refusal, fields): (&str, &[&str])) -> String {
    let connection = if fields.iter().any(|field| field.starts_with("upgrade:")) {
        "upgrade, close"
    } else {
        "close"
    };
    let mut answer = format!(
        "HTTP/1.1 {status}\r\ndate: Thu, 01 Jan 2026 00:00:00 GMT\r\nbead-refusal: {refusal}\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\n"
    );

    for field in fields {
        answer.push_str(field);
        answer.push_str("\r\n");
    }

    answer.push_str("content-length: 0\r\nconnection: ");
    answer.push_str(connection);
    answer.push_str("\r\n\r\n");
    answer
}

async fn expect_answered(port: u16, (answer, requests): (&str, &[String])) {
    for request in requests {
        assert_eq!(
            answer_of(port, request).await,
            (answer.to_owned(), true),
            "the answer to {request:?}"
        );
    }
}

// a frame of `opcode` a client sends, masked as every client's is (RFC 6455 §5.2, §5.3), its
// payload under 126 bytes, `fin` when it ends its message
fn masked_frame(opcode: u8, (payload, fin): (&[u8], bool)) -> Vec<u8> {
    let mask = [0x37_u8, 0xfa, 0x21, 0x3d];
    let mut frame = vec![
        opcode | if fin { 0x80 } else { 0 },
        0x80 | u8::try_from(payload.len()).unwrap(),
    ];

    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

// a raw socket upgraded, the 101 read
async fn upgraded(port: u16) -> (TcpStream, String) {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

    socket
        .write_all(request_of("GET / HTTP/1.1", &["Host: 127.0.0.1"]).as_bytes())
        .await
        .unwrap();

    let head = read_head_of(&mut socket).await;

    (socket, head)
}

async fn read_head_of(socket: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];

    patience(PATIENCE, async {
        while !head.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).await.unwrap() == 0 {
                break;
            }

            head.push(byte[0]);
        }
    })
    .await
    .unwrap();

    latin1(&head)
}

fn binary(bytes: &[u8]) -> Message {
    Message::Binary(Bytes::copy_from_slice(bytes))
}

// ── Its life ───────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn starts_uninitialized_and_is_open_once_listening_on_a_port_the_system_picked() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();

    assert_eq!(server.ready_state(), ReadyState::Uninitialized, "before");

    let bound = server.start(&on_loopback()).await.unwrap();

    assert!(bound.port > 0, "a port drawn");
    assert_eq!(bound.address, "127.0.0.1", "where it listens");
    assert_eq!(server.ready_state(), ReadyState::Open, "open");
    assert_eq!(
        server.transport_type(),
        Some(TRANSPORT_WEBSOCKET),
        "its type"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn throws_on_a_port_taken_ending_closed_and_starts_again_on_a_free_one_and_after_a_stop() {
    let (server, _, port) = started(&briefly_closing()).await;
    let other = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let taken = TransportServerStartOptions {
        address: Some("127.0.0.1".to_owned()),
        port: Some(port),
        ..TransportServerStartOptions::default()
    };
    let refused = other.start(&taken).await.unwrap_err();
    let RouterError::Other(error) = refused else {
        panic!("an io error");
    };

    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::AddrInUse),
        "the port taken"
    );
    assert_eq!(other.ready_state(), ReadyState::Closed, "closed");

    let free = other.start(&on_loopback()).await.unwrap();

    assert_ne!(free.port, port, "another port");
    assert_eq!(other.ready_state(), ReadyState::Open, "open");
    stopped(&other).await;
    other.start(&on_loopback()).await.unwrap();

    assert_eq!(other.ready_state(), ReadyState::Open, "open again");
    stopped(&other).await;
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_second_start_and_keeps_serving() {
    let (server, recorder, port) = started(&briefly_closing()).await;

    assert_eq!(
        server.start(&on_loopback()).await.unwrap_err().to_string(),
        "the transport server is already open",
        "refused"
    );
    assert_eq!(server.ready_state(), ReadyState::Open, "still open");

    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    client.send(binary(&[1])).await.unwrap();

    assert_eq!(recorder.messages(1).await[0].1, handle, "heard on it");
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_second_start_while_the_first_is_still_starting() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let first = server.start(&on_loopback());
    let second = server.start(&on_loopback()).await.unwrap_err();

    assert_eq!(
        second.to_string(),
        "the transport server is already connecting",
        "refused while it starts"
    );
    first.await.unwrap();
    assert_eq!(server.ready_state(), ReadyState::Open, "the first started");
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_stop_while_starting_and_stops_once_started() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let starting = server.start(&on_loopback());

    assert_eq!(
        server.stop().await.unwrap_err().to_string(),
        "the transport server is starting",
        "refused"
    );
    starting.await.unwrap();
    stopped(&server).await;

    assert_eq!(server.ready_state(), ReadyState::Closed, "stopped");
}

#[tokio::test]
async fn refuses_a_start_once_disposed_its_state_kept_and_disposes_once_stopping_it_first() {
    let (server, _, port) = started(&briefly_closing()).await;

    patience(PATIENCE, server.dispose()).await.unwrap().unwrap();

    assert_eq!(server.ready_state(), ReadyState::Closed, "stopped first");
    assert_eq!(
        server.start(&on_loopback()).await.unwrap_err().to_string(),
        "the transport server is disposed",
        "refused"
    );
    assert_eq!(server.ready_state(), ReadyState::Closed, "its state kept");
    assert!(
        TcpStream::connect(("127.0.0.1", port)).await.is_err(),
        "it listens no more"
    );
    // a later dispose settles with the first
    server.dispose().await.unwrap();
}

#[tokio::test]
async fn stops_at_once_when_never_started_stops_twice_then_starts_again_and_accepts() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let recorder = recorded(&server);

    stopped(&server).await;

    assert_eq!(
        server.ready_state(),
        ReadyState::Uninitialized,
        "never started"
    );

    let first = server.start(&on_loopback()).await.unwrap();

    stopped(&server).await;
    stopped(&server).await;

    let second = server.start(&on_loopback()).await.unwrap();

    assert_ne!(first.port, second.port, "a new port");

    let _client = client(second.port).await;

    recorder.connections(1).await;
    stopped(&server).await;
}

#[tokio::test]
async fn shares_a_stop_already_in_progress() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;

    recorder.connections(1).await;

    let first = server.stop();
    let second = server.stop();

    // the client answers the stop's close, which both wait for
    while let Some(Ok(_)) = next_of(&mut client).await {}

    patience(PATIENCE, first).await.unwrap().unwrap();
    patience(PATIENCE, second).await.unwrap().unwrap();

    assert_eq!(recorder.closes(1).await.len(), 1, "one close, told once");
}

#[tokio::test]
async fn a_stop_reentered_from_a_close_listener_shares_the_stop_in_progress() {
    struct Restopping {
        server: Mutex<Option<WebSocketTransportServer>>,
        stops: Mutex<Vec<BoxFuture<Result<(), RouterError>>>>,
    }

    impl ServerListener for Restopping {
        fn on_close(&self, _was_clean: bool, _connection_handle: &ConnectionHandle) {
            if let Some(server) = self.server.lock().unwrap().as_ref() {
                self.stops.lock().unwrap().push(server.stop());
            }
        }
    }

    let (server, recorder, port) = started(&briefly_closing()).await;
    let restopping = Arc::new(Restopping {
        server: Mutex::new(Some(server.clone())),
        stops: Mutex::new(Vec::new()),
    });

    server.listen(Arc::<Restopping>::clone(&restopping));

    let mut client = client(port).await;

    recorder.connections(1).await;

    let stopping = server.stop();

    while let Some(Ok(_)) = next_of(&mut client).await {}

    patience(PATIENCE, stopping).await.unwrap().unwrap();

    let reentered: Vec<_> = restopping.stops.lock().unwrap().drain(..).collect();

    assert_eq!(reentered.len(), 1, "a stop from its close listener");

    for stop in reentered {
        patience(PATIENCE, stop).await.unwrap().unwrap();
    }

    restopping.server.lock().unwrap().take();
}

#[tokio::test]
async fn a_cancelled_start_throws_disposes_what_it_built_and_can_start_again() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let signal = CancellationToken::new();

    signal.cancel();

    let refused = server
        .start(&TransportServerStartOptions {
            signal: Some(signal),
            ..on_loopback()
        })
        .await
        .unwrap_err();

    assert_eq!(refused.to_string(), "the start was cancelled", "cancelled");
    assert_eq!(server.ready_state(), ReadyState::Closed, "closed");
    server.start(&on_loopback()).await.unwrap();
    stopped(&server).await;
}

// ── Where it listens ───────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn refuses_to_start_on_an_address_that_is_no_bare_ip_address_ending_closed() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();

    for (address, refusal) in [
        (
            "example.test",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"example.test\"",
        ),
        (
            "[::1]",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"[::1]\": write ::1, not [::1]",
        ),
        (
            "LOCALHOST",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"LOCALHOST\"",
        ),
    ] {
        let refused = server
            .start(&TransportServerStartOptions {
                address: Some(address.to_owned()),
                ..on_loopback()
            })
            .await
            .unwrap_err();

        assert_eq!(refused.to_string(), refusal, "{address} refused");
        assert_eq!(server.ready_state(), ReadyState::Closed, "closed");
    }
}

#[tokio::test]
async fn listens_on_localhost_when_given_no_address_both_loopbacks_on_one_port_reached_by_127_0_0_1_by_the_ipv6_loopback_and_by_localhost_reports_localhost_and_is_secure_there()
 {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let recorder = recorded(&server);
    let bound = server
        .start(&TransportServerStartOptions {
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    // a host without the IPv6 loopback listens on 127.0.0.1 alone, and says so
    let has_ipv6 = bound.address == "localhost";

    assert!(
        has_ipv6 || bound.address == "127.0.0.1",
        "where it listens: {}",
        bound.address
    );

    let _ipv4 = client(bound.port).await;

    recorder.connections(1).await;

    if has_ipv6 {
        let socket = TcpStream::connect(("::1", bound.port)).await.unwrap();
        let (_ipv6, _) =
            tokio_tungstenite::client_async(format!("ws://[::1]:{}/", bound.port), socket)
                .await
                .unwrap();
        let handles = recorder.connections(2).await;

        assert!(
            handles[1].starts_with("type=WS;ip=::1;"),
            "the IPv6 loopback"
        );
    }

    assert!(
        server.is_secure(&recorder.connections(1).await[0]),
        "secure on the loopback"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_to_start_on_localhost_when_another_socket_holds_the_other_loopback_s_port_ending_closed()
 {
    let Ok(holder) = std::net::TcpListener::bind(("::1", 0)) else {
        // no IPv6 loopback here: nothing holds its port
        return;
    };
    let port = holder.local_addr().unwrap().port();
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let refused = server
        .start(&TransportServerStartOptions {
            port: Some(port),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap_err();
    let RouterError::Other(error) = refused else {
        panic!("an io error");
    };

    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::AddrInUse),
        "the IPv6 loopback's port held"
    );
    assert_eq!(server.ready_state(), ReadyState::Closed, "closed");
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
        "the IPv4 loopback let go"
    );
}

#[tokio::test]
async fn is_secure_on_the_ipv6_loopback_or_an_address_in_127_0_0_0_8_and_not_on_a_wildcard() {
    for (address, is_secure) in [("127.0.0.1", true), ("::1", true), ("0.0.0.0", false)] {
        let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
        let recorder = recorded(&server);
        let Ok(bound) = server
            .start(&TransportServerStartOptions {
                address: Some(address.to_owned()),
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            })
            .await
        else {
            // no IPv6 loopback here
            continue;
        };
        let reached = if address == "::1" { "::1" } else { "127.0.0.1" };
        let socket = TcpStream::connect((reached, bound.port)).await.unwrap();
        let _client = tokio_tungstenite::client_async(
            format!(
                "ws://{}/",
                if address == "::1" {
                    format!("[::1]:{}", bound.port)
                } else {
                    format!("127.0.0.1:{}", bound.port)
                }
            ),
            socket,
        )
        .await
        .unwrap();
        let handle = recorder.connections(1).await.remove(0);

        assert_eq!(server.is_secure(&handle), is_secure, "on {address}");
        stopped(&server).await;
    }
}

#[tokio::test]
async fn is_secure_as_its_application_says_what_stands_in_front_of_it_whatever_it_listens_on_and_by_what_it_listens_on_when_it_says_nothing()
 {
    for (secure, is_secure) in [(Some(false), false), (Some(true), true), (None, true)] {
        let (server, recorder, port) = started(&WebSocketTransportServerOptions {
            secure,
            ..briefly_closing()
        })
        .await;
        let _client = client(port).await;
        let handle = recorder.connections(1).await.remove(0);

        assert_eq!(server.is_secure(&handle), is_secure, "told {secure:?}");
        assert!(
            !server.is_secure(&Arc::from("type=WS;ip=127.0.0.1;port=1;ordinal=99")),
            "a handle it does not hold"
        );
        assert!(
            !server.carries_credential(&handle),
            "no credential toward a client"
        );
        stopped(&server).await;
    }
}

#[tokio::test]
async fn names_a_client_that_comes_over_ipv4_to_a_dual_stack_listener_by_its_ipv4_address() {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let recorder = recorded(&server);
    let Ok(bound) = server
        .start(&TransportServerStartOptions {
            address: Some("::".to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
    else {
        // no IPv6 here
        return;
    };
    let _client = client(bound.port).await;
    let handle = recorder.connections(1).await.remove(0);

    assert!(
        handle.starts_with("type=WS;ip=127.0.0.1;port="),
        "its IPv4 address: {handle}"
    );
    assert_eq!(server.clients()[0].address, "127.0.0.1", "its address");
    stopped(&server).await;
}

// ── Its connections ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn meets_a_connection_already_registered_and_can_send_to_it() {
    struct Greeting {
        server: Mutex<Option<WebSocketTransportServer>>,
        is_registered: Mutex<Option<bool>>,
    }

    impl ServerListener for Greeting {
        fn on_connection(&self, connection_handle: &ConnectionHandle) {
            let server = self.server.lock().unwrap().take().unwrap();
            let is_registered = server
                .clients()
                .iter()
                .any(|client| client.connection_handle == *connection_handle);

            server
                .send(
                    TransportMessage {
                        data: Bytes::from_static(b"hi"),
                        ..TransportMessage::default()
                    },
                    connection_handle,
                )
                .unwrap();
            *self.is_registered.lock().unwrap() = Some(is_registered);
        }
    }

    let (server, recorder, port) = started(&briefly_closing()).await;
    let greeting = Arc::new(Greeting {
        server: Mutex::new(Some(server.clone())),
        is_registered: Mutex::new(None),
    });

    server.listen(Arc::<Greeting>::clone(&greeting));

    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    assert_eq!(
        next_of(&mut client).await.unwrap().unwrap(),
        binary(b"hi"),
        "greeted"
    );
    assert_eq!(
        *greeting.is_registered.lock().unwrap(),
        Some(true),
        "registered"
    );
    assert!(
        handle.starts_with("type=WS;ip=127.0.0.1;port=") && handle.contains(";ordinal="),
        "its handle: {handle}"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn keeps_a_connection_whose_connection_listener_throws_its_messages_heard_the_throw_reported_with_it()
 {
    struct Throwing;

    impl ServerListener for Throwing {
        fn on_connection(&self, _connection_handle: &ConnectionHandle) {
            panic!("a connection listener that throws");
        }
    }

    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();

    server.listen(Arc::new(Throwing));

    let recorder = recorded(&server);
    let port = server.start(&on_loopback()).await.unwrap().port;
    let mut client = client(port).await;
    // the listener after it, told all the same
    let handle = recorder.connections(1).await.remove(0);
    let errors = recorder.errors(1).await;

    assert_eq!(
        errors,
        vec![(
            "a listener panicked: a connection listener that throws".to_owned(),
            Some(Arc::clone(&handle))
        )],
        "the throw reported with it"
    );

    client.send(binary(&[1])).await.unwrap();

    let (message, on) = recorder.messages(1).await.remove(0);

    assert_eq!(
        (&*message.data, on),
        (&[1_u8][..], Arc::clone(&handle)),
        "heard"
    );
    assert_eq!(server.clients().len(), 1, "held");
    assert!(
        server
            .gauges()
            .unwrap()
            .connection_handles
            .contains(&handle),
        "gauged"
    );
    assert_eq!(recorder.count(|told| told.closes.len()), 0, "no close");
    stopped(&server).await;
}

// spec 15.2
#[tokio::test]
async fn delivers_text_as_text_and_binary_as_bytes_stamping_the_activity() {
    let stepping = SteppingClock::new(dated_at());
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        clock: Some(Arc::<SteppingClock>::clone(&stepping)),
        ..briefly_closing()
    })
    .await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);
    let second = Duration::from_secs(1);

    assert_eq!(server.clients()[0].last_activity, None, "none before");

    stepping.advance(second).await;
    client.send(Message::text("hi")).await.unwrap();

    // * a text message is handed on as it came, marked so, for its router to judge: its transport
    // reports nothing of it
    let (text, on) = recorder.messages(1).await.remove(0);

    assert_eq!(&*text.data, b"hi", "the text, as its bytes");
    assert!(text.is_text, "marked text");
    assert_eq!(on, handle, "its connection");
    assert_eq!(text.address.as_deref(), Some("127.0.0.1"), "its address");
    assert_eq!(
        text.port,
        Some(server.clients()[0].port.unwrap()),
        "its port"
    );
    assert_eq!(text.credential, None, "no credential");
    assert_eq!(
        server.clients()[0].last_activity,
        dated_at().checked_add(second),
        "stamped by the text, on its clock"
    );

    // each message stamps it again
    stepping.advance(second).await;
    client.send(binary(&[1, 2])).await.unwrap();

    let (bytes, on) = recorder.messages(2).await.remove(1);

    assert_eq!(&*bytes.data, &[1, 2], "the binary one");
    assert!(!bytes.is_text, "not marked text");
    assert_eq!(on, handle, "its connection");
    assert_eq!(
        server.clients()[0].last_activity,
        dated_at().checked_add(second * 2),
        "stamped by the binary"
    );
    assert_eq!(
        recorder.count(|told| told.errors.len()),
        0,
        "nothing reported"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn hears_the_next_message_after_a_message_listener_throws_the_throw_reported_with_its_connection()
 {
    struct Throwing;

    impl ServerListener for Throwing {
        fn on_message(&self, message: TransportMessage, _connection_handle: &ConnectionHandle) {
            assert!(*message.data != [1], "a message listener that throws");
        }
    }

    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();

    server.listen(Arc::new(Throwing));

    let recorder = recorded(&server);
    let port = server.start(&on_loopback()).await.unwrap().port;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    client.send(binary(&[1])).await.unwrap();
    client.send(binary(&[2])).await.unwrap();

    let messages = recorder.messages(2).await;

    assert_eq!(
        messages
            .iter()
            .map(|(message, _)| message.data.to_vec())
            .collect::<Vec<_>>(),
        vec![vec![1], vec![2]],
        "both heard"
    );
    assert_eq!(
        recorder.errors(1).await,
        vec![(
            "a listener panicked: a message listener that throws".to_owned(),
            Some(handle)
        )],
        "reported with its connection"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn delivers_a_message_sent_in_frames_as_one_and_names_its_connection() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let (mut socket, head) = upgraded(port).await;

    assert!(
        head.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "upgraded"
    );

    let handle = recorder.connections(1).await.remove(0);
    let mut frames = masked_frame(0x2, (&[1, 2], false));

    frames.extend(masked_frame(0x0, (&[3], false)));
    frames.extend(masked_frame(0x0, (&[4], true)));
    socket.write_all(&frames).await.unwrap();

    let (message, on) = recorder.messages(1).await.remove(0);

    assert_eq!(
        (&*message.data, on),
        (&[1_u8, 2, 3, 4][..], handle),
        "one message"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn emits_connection_before_a_frame_that_arrived_with_the_upgrade_request() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut request = request_of("GET / HTTP/1.1", &["Host: 127.0.0.1"]).into_bytes();

    request.extend(masked_frame(0x2, (&[7], true)));
    socket.write_all(&request).await.unwrap();

    let messages = recorder.messages(1).await;

    assert_eq!(
        recorder.order()[..2],
        ["connection", "message"],
        "its connection told first"
    );
    assert_eq!(
        messages[0].1,
        recorder.connections(1).await[0],
        "on that connection"
    );
    assert_eq!(&*messages[0].0.data, &[7], "the frame read with the head");
    stopped(&server).await;
}

#[tokio::test]
async fn sends_to_a_connection_in_order_one_message_at_a_time() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    for index in 0..20_u8 {
        server
            .send(
                TransportMessage {
                    data: Bytes::from(vec![index; 1_000]),
                    ..TransportMessage::default()
                },
                &handle,
            )
            .unwrap();
    }

    for index in 0..20_u8 {
        assert_eq!(
            next_of(&mut client).await.unwrap().unwrap(),
            binary(&[index; 1_000]),
            "message {index} in its order"
        );
    }

    stopped(&server).await;
}

#[tokio::test]
async fn resolves_a_send_for_a_handle_nobody_holds() {
    let (server, _, _) = started(&briefly_closing()).await;
    let sent = server.send(
        TransportMessage {
            data: Bytes::from_static(&[1]),
            ..TransportMessage::default()
        },
        &Arc::from("type=WS;ip=127.0.0.1;port=1;ordinal=99"),
    );

    assert!(matches!(sent, Ok(Sent::Done)), "done");
    stopped(&server).await;
}

#[tokio::test]
async fn closes_one_connection_which_is_gone_once_it_resolves() {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions::default()).await;
    let mut first = client(port).await;
    let _second = client(port).await;
    let handles = recorder.connections(2).await;
    let closing = server.close(&handles[0]);
    let frame = next_of(&mut first).await.unwrap().unwrap();

    assert_eq!(
        frame,
        Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "".into()
        })),
        "its close, 1000"
    );

    // its client answers as it reads on
    while let Some(Ok(_)) = next_of(&mut first).await {}

    assert!(patience(PATIENCE, closing).await.unwrap(), "it held it");
    assert_eq!(
        server
            .clients()
            .iter()
            .map(|client| Arc::clone(&client.connection_handle))
            .collect::<Vec<_>>(),
        vec![Arc::clone(&handles[1])],
        "gone once it resolves"
    );
    assert_eq!(
        recorder.closes(1).await,
        vec![(true, Arc::clone(&handles[0]))],
        "its close told clean"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn resolves_false_closing_a_handle_nobody_holds() {
    let (server, _, _) = started(&briefly_closing()).await;

    assert!(
        !server
            .close(&Arc::from("type=WS;ip=127.0.0.1;port=1;ordinal=99"))
            .await,
        "nobody holds it"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn counts_the_connections_it_holds_and_gives_their_handles_for_no_one_outside_the_process() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let _first = client(port).await;
    let _second = client(port).await;
    let handles = recorder.connections(2).await;
    let gauges = server.gauges().unwrap();

    assert_eq!(gauges.counts.get("connections"), Some(&2), "two held");
    assert_eq!(
        gauges.counts.get("largestAddressConnections"),
        Some(&2),
        "both of one address"
    );
    assert_eq!(
        gauges.ceilings.get("connections"),
        Some(&10_000),
        "its bound"
    );
    assert_eq!(
        gauges.ceilings.get("largestAddressConnections"),
        Some(&64),
        "its bound by address"
    );
    assert_eq!(
        gauges.connection_handles,
        handles.into_iter().collect(),
        "their handles"
    );
    assert_eq!(
        server
            .clients()
            .iter()
            .map(|client| client.transport_type)
            .collect::<Vec<_>>(),
        vec!["WS", "WS"],
        "its type"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn names_each_connection_by_its_peer_s_port_and_the_rank_it_came_at_two_sockets_from_one_address_and_port_among_them_and_gives_no_handle_twice()
 {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let first = client(port).await;
    let second = client(port).await;
    let handles = recorder.connections(2).await;
    let ports = [
        first.get_ref().local_addr().unwrap().port(),
        second.get_ref().local_addr().unwrap().port(),
    ];

    for (index, handle) in handles.iter().enumerate() {
        assert_eq!(
            **handle,
            format!(
                "type=WS;ip=127.0.0.1;port={};ordinal={}",
                ports[index],
                index + 1
            ),
            "its port and its rank"
        );
    }

    stopped(&server).await;

    // across its starts
    let port = server.start(&on_loopback()).await.unwrap().port;
    let _third = client(port).await;
    let third = recorder.connections(3).await.remove(2);

    assert!(third.ends_with(";ordinal=3"), "no handle twice: {third}");
    stopped(&server).await;

    if cfg!(target_os = "macos") {
        // macOS routes no second address of 127.0.0.0/8 to the loopback
        return;
    }

    for clean in [true, false] {
        let SocketServer {
            server,
            recorder,
            port,
        } = on_every_address().await;
        let first = client_from(SocketAddr::from(([127, 0, 0, 1], 0)), ("127.0.0.1", port)).await;
        let local = first.get_ref().local_addr().unwrap();
        let mut second = client_from(local, ("127.0.0.2", port)).await;
        let handles = recorder.connections(2).await;

        end_client(first, clean).await;
        assert_eq!(recorder.closes(1).await, [(clean, Arc::clone(&handles[0]))]);

        let third = client_from(local, ("127.0.0.3", port)).await;
        let handles = recorder.connections(3).await;

        for (index, handle) in handles.iter().enumerate() {
            assert_eq!(
                **handle,
                format!(
                    "type=WS;ip=127.0.0.1;port={};ordinal={}",
                    local.port(),
                    index + 1
                )
            );
        }
        assert_eq!(
            server
                .clients()
                .iter()
                .map(|client| Arc::clone(&client.connection_handle))
                .collect::<Vec<_>>(),
            handles[1..]
        );
        assert_eq!(server.gauges().unwrap().counts["connections"], 2);
        assert!(
            !server.close(&handles[0]).await,
            "the first names no socket"
        );

        let closing = server.close(&handles[1]);
        assert_eq!(
            next_of(&mut second).await.unwrap().unwrap(),
            Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "".into(),
            }))
        );
        while let Some(Ok(_)) = next_of(&mut second).await {}
        assert!(patience(PATIENCE, closing).await.unwrap());
        assert_eq!(recorder.closes(2).await[1], (true, Arc::clone(&handles[1])));
        assert_eq!(
            server.gauges().unwrap().connection_handles,
            [Arc::clone(&handles[2])].into()
        );
        server.send(message_of(vec![1]), &handles[2]).unwrap();
        let mut third = third;
        assert_eq!(next_of(&mut third).await.unwrap().unwrap(), binary(&[1]));
        stopped(&server).await;
    }
}

// Windows and Linux route both addresses to one listener, so the peer's address and port are
// identical on two live sockets, as in the facade's two-session twin.
struct SocketServer {
    server: WebSocketTransportServer,
    recorder: Arc<Recorder>,
    port: u16,
}

async fn on_every_address() -> SocketServer {
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
    let recorder = recorded(&server);
    let bound = server
        .start(&TransportServerStartOptions {
            address: Some("0.0.0.0".to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    SocketServer {
        server,
        recorder,
        port: bound.port,
    }
}

async fn client_from(local: SocketAddr, (remote, port): (&str, u16)) -> Client {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();

    socket.set_reuseaddr(true).unwrap();
    socket.bind(local).unwrap();

    let stream = socket
        .connect(format!("{remote}:{port}").parse().unwrap())
        .await
        .unwrap();

    patience(
        PATIENCE,
        tokio_tungstenite::client_async(format!("ws://{remote}:{port}/"), stream),
    )
    .await
    .unwrap()
    .unwrap()
    .0
}

async fn end_client(mut client: Client, clean: bool) {
    if clean {
        client
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "".into(),
            })))
            .await
            .unwrap();
        assert!(matches!(
            next_of(&mut client).await,
            Some(Ok(Message::Close(_)))
        ));
    }
}

#[tokio::test]
async fn closes_each_of_two_sockets_from_one_address_and_port_on_its_own_each_its_own_close_told() {
    if cfg!(target_os = "macos") {
        // macOS routes no second address of 127.0.0.0/8 to the loopback
        return;
    }

    for clean in [true, false] {
        let SocketServer {
            server,
            recorder,
            port,
        } = on_every_address().await;
        let older = client_from(SocketAddr::from(([127, 0, 0, 1], 0)), ("127.0.0.1", port)).await;
        let local = older.get_ref().local_addr().unwrap();
        let mut newer = client_from(local, ("127.0.0.2", port)).await;
        let handles = recorder.connections(2).await;

        assert_ne!(handles[0], handles[1]);
        end_client(older, clean).await;
        assert_eq!(recorder.closes(1).await, [(clean, Arc::clone(&handles[0]))]);
        assert_eq!(
            server.gauges().unwrap().counts,
            [
                ("connections", 1),
                ("largestAddressConnections", 1),
                ("largestUnsentBytes", 0),
                ("unsentBytes", 0),
            ]
            .into()
        );
        server.send(message_of(vec![1]), &handles[1]).unwrap();
        assert_eq!(next_of(&mut newer).await.unwrap().unwrap(), binary(&[1]));
        assert_eq!(server.clients()[0].connection_handle, handles[1]);
        assert_eq!(server.clients().len(), 1);

        end_client(newer, clean).await;
        assert_eq!(
            recorder.closes(2).await,
            [
                (clean, Arc::clone(&handles[0])),
                (clean, Arc::clone(&handles[1]))
            ]
        );
        assert_eq!(
            server.gauges().unwrap().counts,
            [
                ("connections", 0),
                ("largestAddressConnections", 0),
                ("largestUnsentBytes", 0),
                ("unsentBytes", 0),
            ]
            .into()
        );
        assert!(server.clients().is_empty(), "no client stands");
        assert_eq!(recorder.count(|told| told.errors.len()), 0);
        stopped(&server).await;
    }
}

// ── Its closes ─────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn answers_a_close_at_once_and_says_it_was_clean() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    client
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        })))
        .await
        .unwrap();

    assert!(
        matches!(
            next_of(&mut client).await,
            Some(Ok(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                ..
            }))))
        ),
        "its answer"
    );
    assert_eq!(recorder.closes(1).await, vec![(true, handle)], "clean");
    assert!(server.clients().is_empty(), "gone");
    stopped(&server).await;
}

#[tokio::test]
async fn tells_a_close_from_its_peer_with_no_status_code_as_its_platform_reads_it_clean_on_net_which_reads_it_as_1000_unclean_on_ws_which_reads_1005()
 {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    client.send(Message::Close(None)).await.unwrap();

    while let Some(Ok(_)) = next_of(&mut client).await {}

    assert_eq!(recorder.closes(1).await, vec![(false, handle)], "unclean");
    assert_eq!(recorder.count(|told| told.errors.len()), 0, "no error");
    stopped(&server).await;
}

#[tokio::test]
async fn emits_error_with_the_handle_then_that_connection_s_close_on_a_protocol_error() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let (mut socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);

    // a frame of an opcode RFC 6455 reserves
    socket
        .write_all(&masked_frame(0x3, (&[1], true)))
        .await
        .unwrap();

    let closes = recorder.closes(1).await;
    let errors = recorder.errors(1).await;
    let order = recorder.order();

    assert_eq!(
        order[order.len() - 2..],
        ["error", "close"],
        "its error, then its close"
    );
    assert_eq!(
        errors[0].1.as_ref(),
        Some(&handle),
        "its error's connection"
    );
    assert!(
        errors[0]
            .0
            .starts_with(&format!("{handle} is closed with 1002: ")),
        "its error: {}",
        errors[0].0
    );
    assert_eq!(closes, vec![(false, handle)], "unclean");
    stopped(&server).await;
}

// ! tungstenite raises one `Error::Utf8` for a text message and for a close's reason that is no
// UTF-8, so both close with 1002, where RFC 6455 §7.4.1 gives the first 1007: `ws` sends 1007 for
// both, .NET 1007 for the text and 1002 for the reason, a row of docs/support.md
#[tokio::test]
async fn closes_with_1002_a_text_message_that_is_no_utf_8_and_a_close_whose_reason_is_no_utf_8() {
    let (server, recorder, port) = started(&briefly_closing()).await;

    for (index, frame) in [
        masked_frame(0x1, (&[0xff, 0xfe], true)),
        masked_frame(0x8, (&[0x03, 0xe8, 0xff, 0xfe], true)),
    ]
    .into_iter()
    .enumerate()
    {
        let (mut socket, _) = upgraded(port).await;

        socket.write_all(&frame).await.unwrap();

        let mut peer = WebSocketStream::from_raw_socket(socket, Role::Client, None).await;

        assert!(
            matches!(
                next_of(&mut peer).await,
                Some(Ok(Message::Close(Some(CloseFrame {
                    code: CloseCode::Protocol,
                    ..
                }))))
            ),
            "1002, case {index}"
        );
        recorder.closes(index + 1).await;
    }

    assert_eq!(recorder.errors(2).await.len(), 2, "each reported");
    stopped(&server).await;
}

#[tokio::test]
async fn tells_a_peer_that_drops_without_its_closing_handshake_by_its_unclean_close_alone_no_error()
{
    let (server, recorder, port) = started(&briefly_closing()).await;
    let (socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);

    drop(socket);

    assert_eq!(recorder.closes(1).await, vec![(false, handle)], "unclean");
    assert_eq!(recorder.count(|told| told.errors.len()), 0, "no error");
    stopped(&server).await;
}

#[tokio::test]
async fn fails_with_1009_a_message_past_its_bound_telling_one_error_that_names_maximum_message_bytes_then_an_unclean_close_even_when_the_peer_answers_1000()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        maximum_message_bytes: Some(8),
        ..briefly_closing()
    })
    .await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    client.send(binary(&[0; 9])).await.unwrap();

    assert!(
        matches!(
            next_of(&mut client).await,
            Some(Ok(Message::Close(Some(CloseFrame {
                code: CloseCode::Size,
                ..
            }))))
        ),
        "1009"
    );

    // its client answers it, 1000 at that, as it reads on
    while let Some(Ok(_)) = next_of(&mut client).await {}

    assert_eq!(
        recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "unclean"
    );
    assert_eq!(
        recorder.errors(1).await,
        vec![(
            format!(
                "{handle} is closed with 1009: a message past its maximumMessageBytes, 8 bytes"
            ),
            Some(handle)
        )],
        "one error, naming its bound"
    );
    assert_eq!(
        recorder.count(|told| told.messages.len()),
        0,
        "nothing handed"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn closes_with_1009_a_message_past_an_envelope_s_limit_16_778_240_bytes_when_told_no_bound() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);
    let past = usize::try_from(MAXIMUM_MESSAGE_BYTES).unwrap() + 1;

    client.send(binary(&vec![0; past])).await.unwrap();

    while let Some(Ok(_)) = next_of(&mut client).await {}

    assert_eq!(
        recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "unclean"
    );
    assert_eq!(
        recorder.errors(1).await[0].0,
        format!(
            "{handle} is closed with 1009: a message past its maximumMessageBytes, 16778240 bytes"
        ),
        "an envelope's limit"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn fails_with_1009_a_peer_that_never_answers_telling_one_error_then_an_unclean_close_once_its_close_timeout_passed()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        maximum_message_bytes: Some(8),
        close_timeout: Some(Duration::from_millis(100)),
        ..WebSocketTransportServerOptions::default()
    })
    .await;
    let (mut socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);
    let begun = Instant::now();

    // a raw peer that reads nothing more, and answers nothing
    socket
        .write_all(&masked_frame(0x2, (&[0; 9], true)))
        .await
        .unwrap();

    assert_eq!(
        recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "unclean"
    );
    assert!(
        begun.elapsed() >= Duration::from_millis(100),
        "once its close timeout passed"
    );
    assert_eq!(recorder.errors(1).await.len(), 1, "one error");
    stopped(&server).await;
}

#[tokio::test]
async fn drops_a_connection_that_never_answers_its_close_once_the_timeout_passed_telling_no_error()
{
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        close_timeout: Some(Duration::from_millis(100)),
        ..WebSocketTransportServerOptions::default()
    })
    .await;
    let (_socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);
    let begun = Instant::now();

    assert!(
        patience(PATIENCE, server.close(&handle)).await.unwrap(),
        "held"
    );
    assert!(
        begun.elapsed() >= Duration::from_millis(100),
        "its timeout passed"
    );
    assert_eq!(recorder.closes(1).await, vec![(false, handle)], "unclean");
    assert_eq!(recorder.count(|told| told.errors.len()), 0, "no error");
    stopped(&server).await;
}

#[tokio::test]
async fn waits_on_its_peer_without_end_for_a_close_timeout_of_infinity_arming_no_timer() {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        close_timeout: Some(NEVER),
        ..WebSocketTransportServerOptions::default()
    })
    .await;
    let (mut socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);
    let closing = server.close(&handle);

    rest(Duration::from_millis(200)).await;

    assert_eq!(server.clients().len(), 1, "still waiting on its peer");

    // its peer's close, at last
    socket
        .write_all(&masked_frame(0x8, (&[0x03, 0xe8], true)))
        .await
        .unwrap();

    assert!(patience(PATIENCE, closing).await.unwrap(), "closed");
    assert_eq!(recorder.closes(1).await, vec![(true, handle)], "clean");
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_close_timeout_past_the_longest_timer_and_runs_on_the_clock_it_is_given() {
    let refused = WebSocketTransportServer::new(&WebSocketTransportServerOptions {
        close_timeout: Some(crate::LONGEST_TIMER + Duration::from_millis(1)),
        ..WebSocketTransportServerOptions::default()
    })
    .unwrap_err();

    assert!(
        refused.to_string().starts_with("a close timeout "),
        "refused: {refused}"
    );

    let clock = dated();
    let server = WebSocketTransportServer::new(&WebSocketTransportServerOptions {
        clock: Some(Arc::clone(&clock)),
        ..WebSocketTransportServerOptions::default()
    })
    .unwrap();

    assert!(
        server
            .clock()
            .is_some_and(|given| Arc::ptr_eq(&given, &clock)),
        "the clock it was given"
    );
    assert!(
        WebSocketTransportServer::new(&WebSocketTransportServerOptions::default())
            .unwrap()
            .clock()
            .is_none(),
        "none given"
    );
}

#[tokio::test]
async fn stamps_the_activity_on_its_clock_and_bounds_a_close_on_the_real_one_which_the_clock_given_never_times()
 {
    let stepping = SteppingClock::new(dated_at());
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        clock: Some(Arc::<SteppingClock>::clone(&stepping)),
        close_timeout: Some(Duration::from_millis(100)),
        ..WebSocketTransportServerOptions::default()
    })
    .await;
    let (mut socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);

    socket
        .write_all(&masked_frame(0x2, (&[1], true)))
        .await
        .unwrap();
    recorder.messages(1).await;

    assert_eq!(
        server.clients()[0].last_activity,
        Some(dated_at()),
        "its clock's"
    );

    // the clock given never moves: the close is bounded on the platform's
    assert!(
        patience(PATIENCE, server.close(&handle)).await.unwrap(),
        "dropped"
    );
    assert!(
        stepping.dues().is_empty(),
        "nothing armed on the clock given"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn stop_closes_every_connection_each_raising_its_close_before_it_resolves_and_stops_listening()
 {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut first = client(port).await;
    let mut second = client(port).await;

    recorder.connections(2).await;

    let stopping = server.stop();

    for client in [&mut first, &mut second] {
        assert!(
            matches!(
                next_of(client).await,
                Some(Ok(Message::Close(Some(CloseFrame {
                    code: CloseCode::Away,
                    ..
                }))))
            ),
            "1001"
        );

        while let Some(Ok(_)) = next_of(client).await {}
    }

    patience(PATIENCE, stopping).await.unwrap().unwrap();

    let closes = recorder.closes(2).await;

    assert!(
        closes.iter().all(|(is_clean, _)| !is_clean),
        "each told, going away"
    );
    assert!(server.clients().is_empty(), "none held");
    assert!(
        TcpStream::connect(("127.0.0.1", port)).await.is_err(),
        "it listens no more"
    );
}

#[tokio::test]
async fn dispose_stops_it_closing_with_1001_and_refusing_what_comes_after() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let mut client = client(port).await;

    recorder.connections(1).await;

    let disposing = server.dispose();

    assert!(
        matches!(
            next_of(&mut client).await,
            Some(Ok(Message::Close(Some(CloseFrame {
                code: CloseCode::Away,
                ..
            }))))
        ),
        "1001"
    );

    while let Some(Ok(_)) = next_of(&mut client).await {}

    patience(PATIENCE, disposing).await.unwrap().unwrap();

    assert_eq!(
        server.start(&on_loopback()).await.unwrap_err().to_string(),
        "the transport server is disposed",
        "refused after"
    );
}

#[tokio::test]
async fn stops_without_waiting_on_a_peer_that_never_finished_its_http_request() {
    let (server, _, port) = started(&briefly_closing()).await;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

    socket
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n")
        .await
        .unwrap();
    rest(Duration::from_millis(50)).await;

    let begun = Instant::now();

    stopped(&server).await;

    assert!(begun.elapsed() < Duration::from_secs(1), "at once");
}

#[tokio::test]
async fn answers_408_a_head_that_did_not_come_within_its_headers_timeout_unmarked() {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        headers_timeout: Some(Duration::from_millis(100)),
        ..briefly_closing()
    })
    .await;

    assert_eq!(
        answer_of(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n").await,
        (
            "HTTP/1.1 408 Request Timeout\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"
                .to_owned(),
            true
        ),
        "408"
    );
    assert!(recorder.refusals().is_empty(), "nothing told");
    stopped(&server).await;
}

// ── Its judgement ──────────────────────────────────────────────────────────────────────────────

fn judging(hosts: &[&str], origins: &[&str]) -> WebSocketTransportServerOptions {
    WebSocketTransportServerOptions {
        clock: Some(dated()),
        hosts: Some(hosts.iter().map(|host| (*host).to_owned()).collect()),
        origins: Some(origins.iter().map(|origin| (*origin).to_owned()).collect()),
        ..briefly_closing()
    }
}

#[tokio::test]
async fn refuses_an_upgrade_403_before_its_handshake_marked_host_refused_for_a_host_it_does_not_take_and_origin_refused_for_an_origin_neither_its_own_nor_among_those_it_takes_its_body_empty_its_date_written_whatever_its_method_its_upgrade_or_its_form()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &["https://bead.example"])).await;
    let mut no_upgrade = vec!["Host: elsewhere.test"];

    no_upgrade.extend(NO_UPGRADE);

    let mut with_body = no_upgrade.clone();

    with_body.push("Content-Length: 0");

    // a host not taken, whatever else the request holds
    expect_answered(
        port,
        (
            &refused_with("403 Forbidden", ("host-refused", &[])),
            &[
                request_of("GET / HTTP/1.1", &["Host: elsewhere.test"]),
                request_of(
                    "GET / HTTP/1.1",
                    &["Host: elsewhere.test", "Origin: http://elsewhere.test"],
                ),
                request_of("POST / HTTP/1.1", &["Host: elsewhere.test"]),
                request_of("GET / HTTP/1.1", &no_upgrade),
                request_of("POST / HTTP/1.1", &with_body),
                request_of("PUT /bead HTTP/1.1", &with_body),
                request_of("HEAD / HTTP/1.1", &["Host: elsewhere.test"]),
                request_of(
                    "GET / HTTP/1.1",
                    &["Host: elsewhere.test", "Sec-WebSocket-Key: dGVzdA=="],
                ),
                request_of(
                    "GET / HTTP/1.1",
                    &["Host: elsewhere.test", "Sec-WebSocket-Version: 8"],
                ),
                request_of("GET / HTTP/1.1", &["Host: "]),
            ],
        ),
    )
    .await;
    // a host taken, from an origin neither its own nor among those it takes
    expect_answered(
        port,
        (
            &refused_with("403 Forbidden", ("origin-refused", &[])),
            &[
                request_of("GET / HTTP/1.1", &["Origin: https://elsewhere.test"]),
                request_of("GET / HTTP/1.1", &["Origin: http://elsewhere.test:80"]),
            ],
        ),
    )
    .await;

    assert!(server.clients().is_empty(), "none taken");
    stopped(&server).await;
}

#[tokio::test]
async fn takes_an_upgrade_with_no_origin_from_its_own_origin_and_from_one_among_those_it_takes() {
    let (server, _, port) = started(&judging(&["bead.test"], &["https://bead.example"])).await;

    for origin in [
        None,
        Some("http://bead.test"),
        Some("https://bead.test"),
        Some("https://bead.example"),
    ] {
        let mut changes = vec![];
        let line = origin.map(|origin| format!("Origin: {origin}"));

        if let Some(line) = &line {
            changes.push(line.as_str());
        }

        let (answer, is_closed) = answer_of(port, &request_of("GET / HTTP/1.1", &changes)).await;

        assert!(
            answer.starts_with("HTTP/1.1 101 ") && !is_closed,
            "taken from {origin:?}: {answer}"
        );
    }

    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_method_but_get_or_head_405_after_its_host_and_before_its_upgrade_is_read_its_allow_naming_get_and_head_marked_method_refused()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    expect_answered(
        port,
        (
            &refused_with(
                "405 Method Not Allowed",
                ("method-refused", &["allow: GET, HEAD"]),
            ),
            &[
                request_of("POST / HTTP/1.1", &[]),
                request_of("PUT / HTTP/1.1", &NO_UPGRADE),
                request_of("DELETE / HTTP/1.1", &["Sec-WebSocket-Version: 8"]),
            ],
        ),
    )
    .await;
    stopped(&server).await;
}

#[tokio::test]
async fn answers_a_request_that_asks_no_websocket_426_marked_upgrade_required_its_upgrade_naming_websocket_its_connection_upgrade_and_close()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    expect_answered(
        port,
        (
            &refused_with(
                "426 Upgrade Required",
                ("upgrade-required", &["upgrade: websocket"]),
            ),
            &[
                request_of("GET / HTTP/1.1", &NO_UPGRADE),
                request_of("GET / HTTP/1.1", &["Upgrade: h2c"]),
                request_of("GET / HTTP/1.1", &["Connection: keep-alive"]),
                request_of("HEAD / HTTP/1.1", &[]),
                request_of("GET / HTTP/1.0", &[]),
            ],
        ),
    )
    .await;
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_a_malformed_upgrade_400_marked_malformed_before_its_origin_is_judged_its_body_empty()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    expect_answered(
        port,
        (
            &refused_with("400 Bad Request", ("malformed", &[])),
            &[
                request_of(
                    "GET / HTTP/1.1",
                    &[
                        "Sec-WebSocket-Key: dGVzdA==",
                        "Origin: https://elsewhere.test",
                    ],
                ),
                request_of("GET / HTTP/1.1", &["Sec-WebSocket-Key"]),
                request_of(
                    "GET / HTTP/1.1",
                    &["Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 13"],
                ),
                request_of("GET / HTTP/1.1", &["Content-Length: 1"]),
                request_of(
                    "GET / HTTP/1.1",
                    &["Authorization: Bearer a", "Authorization: Bearer b"],
                ),
            ],
        ),
    )
    .await;
    stopped(&server).await;
}

#[tokio::test]
async fn answers_426_to_an_upgrade_of_a_version_but_13_or_of_none_marked_version_refused_naming_version_13_and_websocket_before_its_key_and_its_origin_are_judged()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    expect_answered(
        port,
        (
            &refused_with(
                "426 Upgrade Required",
                (
                    "version-refused",
                    &["upgrade: websocket", "sec-websocket-version: 13"],
                ),
            ),
            &[
                request_of("GET / HTTP/1.1", &["Sec-WebSocket-Version: 8"]),
                request_of("GET / HTTP/1.1", &["Sec-WebSocket-Version"]),
                request_of(
                    "GET / HTTP/1.1",
                    &[
                        "Sec-WebSocket-Version: 14",
                        "Sec-WebSocket-Key: dGVzdA==",
                        "Origin: https://elsewhere.test",
                    ],
                ),
            ],
        ),
    )
    .await;
    stopped(&server).await;
}

#[tokio::test]
async fn answers_a_request_without_a_host_with_two_or_with_one_that_is_no_host_400_as_http_does_unmarked()
 {
    for hosts in [&[][..], &["bead.test"][..]] {
        let (server, recorder, port) = started(&judging(hosts, &[])).await;

        for request in [
            request_of("GET / HTTP/1.1", &["Host"]),
            request_of(
                "GET / HTTP/1.1",
                &["Host: bead.test", "Host: elsewhere.test"],
            ),
            request_of(
                "GET / HTTP/1.1",
                &["Host: elsewhere.test", "Host: bead.test"],
            ),
            request_of("GET / HTTP/1.1", &["Host: bad host"]),
        ] {
            assert_eq!(
                answer_of(port, &request).await,
                (
                    "HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_owned(),
                    true
                ),
                "{request:?}"
            );
        }

        assert!(recorder.refusals().is_empty(), "nothing told");
        assert!(server.clients().is_empty(), "none taken");
        stopped(&server).await;
    }
}

#[tokio::test]
async fn answers_400_unmarked_with_none_of_the_path_s_fields_a_field_holding_a_control_character_other_than_htab_or_an_octet_past_ascii_and_tells_nothing()
 {
    let (server, recorder, port) = started(&judging(&["bead.test"], &[])).await;

    for change in ["X-Note: a\u{1}b", "X-Note: caf\u{e9}", "X-Note: a\u{7f}b"] {
        let request: Vec<u8> = request_of("GET / HTTP/1.1", &[change])
            .chars()
            .map(|character| u8::try_from(u32::from(character)).unwrap())
            .collect();
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        socket.write_all(&request).await.unwrap();

        let mut answer = Vec::new();

        patience(PATIENCE, socket.read_to_end(&mut answer))
            .await
            .unwrap()
            .ok();

        assert!(
            latin1(&answer).starts_with("HTTP/1.1 400 Bad Request\r\n")
                && !latin1(&answer).contains("bead-refusal"),
            "{change:?}: {}",
            latin1(&answer)
        );
    }

    assert!(recorder.refusals().is_empty(), "nothing told");
    stopped(&server).await;
}

#[tokio::test]
async fn takes_an_upgrade_whose_upgrade_lists_websocket_in_any_case_in_one_field_line_or_several_whose_connection_names_upgrade_among_other_tokens_with_no_content()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    for changes in [
        &["Upgrade: WebSocket"][..],
        &["Upgrade: h2c, websocket"][..],
        &["Upgrade: h2c", "Upgrade: websocket"][..],
        &["Connection: keep-alive, Upgrade"][..],
        &["Connection: keep-alive", "Connection: upgrade"][..],
        &["Content-Length: 0"][..],
    ] {
        let (answer, _) = answer_of(port, &request_of("GET / HTTP/1.1", changes)).await;

        assert!(answer.starts_with("HTTP/1.1 101 "), "{changes:?}: {answer}");
    }

    stopped(&server).await;
}

#[tokio::test]
async fn takes_whatever_its_hosts_the_hosts_every_server_takes_and_any_page_of_its_own_and_refuses_403_any_other_host_an_empty_one_and_none_before_its_method_and_its_upgrade()
 {
    let (server, _, port) = started(&judging(&["bead.test"], &[])).await;

    for host in [
        "bead.test",
        "BEAD.test:8080",
        "127.0.0.1",
        "localhost",
        "[::1]",
    ] {
        let (answer, _) = answer_of(
            port,
            &request_of("GET / HTTP/1.1", &[&format!("Host: {host}")]),
        )
        .await;

        assert!(answer.starts_with("HTTP/1.1 101 "), "{host}: {answer}");
    }

    expect_answered(
        port,
        (
            &refused_with("403 Forbidden", ("host-refused", &[])),
            &[
                request_of("POST / HTTP/1.1", &["Host: elsewhere.test", "Upgrade"]),
                request_of("GET / HTTP/1.1", &["Host: "]),
            ],
        ),
    )
    .await;
    stopped(&server).await;
}

// the status line and the mark of an upgrade from each `(Host, Origin)`, on a server given `hosts`
async fn answers_of(
    hosts: &[&str],
    upgrades: &[(&str, Option<&str>)],
) -> Vec<(String, Option<String>)> {
    let (server, _, port) = started(&judging(hosts, &[])).await;
    let mut answers = Vec::new();

    for (authority, origin) in upgrades {
        let host = format!("Host: {authority}");
        let origin = origin.map(|origin| format!("Origin: {origin}"));
        let mut changes = vec![host.as_str()];

        changes.extend(origin.as_deref());

        let (text, _) = answer_of(port, &request_of("GET / HTTP/1.1", &changes)).await;
        let status = text.split("\r\n").next().unwrap_or_default().to_owned();
        let mark = text
            .split("\r\n")
            .find_map(|line| line.strip_prefix("bead-refusal: "))
            .map(str::to_owned);

        answers.push((status, mark));
    }

    stopped(&server).await;

    answers
}

#[tokio::test]
async fn reads_the_host_of_an_upgrade_as_it_came_an_idn_page_s_own_in_punycode_and_one_of_invalid_punycode_taken_or_refused_host_refused_never_a_500()
 {
    let taken = ("HTTP/1.1 101 Switching Protocols".to_owned(), None);
    let refused = (
        "HTTP/1.1 403 Forbidden".to_owned(),
        Some("host-refused".to_owned()),
    );
    let not_own = (
        "HTTP/1.1 403 Forbidden".to_owned(),
        Some("origin-refused".to_owned()),
    );
    // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
    // and a Host of punycode that decodes to none, taken where every host is; under *, no page is
    // the server's own by a host * alone takes (spec 15.12)
    let page = (
        "xn--bad-bma.test:8080",
        Some("http://xn--bad-bma.test:8080"),
    );

    assert_eq!(
        answers_of(
            &["*"],
            &[
                page,
                ("xn--a", Some("http://xn--a")),
                ("xn--a", None),
                ("xn--a.test", None),
                ("xn---bad-cpa.test", None),
            ],
        )
        .await,
        [
            not_own.clone(),
            not_own,
            taken.clone(),
            taken.clone(),
            taken.clone()
        ],
        "under *"
    );
    // hosts name an IDN host as the field carries it, in punycode, and none past them is taken
    assert_eq!(
        answers_of(
            &["xn--bad-bma.test"],
            &[
                page,
                ("XN--BAD-BMA.test:8080", None),
                ("xn--a.test", None),
                ("xn---bad-cpa.test", None),
                ("xn--a", None),
            ],
        )
        .await,
        [
            taken.clone(),
            taken,
            refused.clone(),
            refused.clone(),
            refused
        ],
        "named"
    );
}

#[tokio::test]
async fn refuses_as_it_is_built_a_hosts_entry_with_a_port_and_an_origins_entry_that_is_a_star_or_null()
 {
    for (options, refusal) in [
        (judging(&["bead.test:8080"], &[]), "a hosts entry"),
        (judging(&[], &["*"]), "an origins entry"),
        (judging(&[], &["null"]), "an origins entry"),
    ] {
        let refused = WebSocketTransportServer::new(&options).unwrap_err();

        assert!(
            refused.to_string().contains(refusal) || refused.to_string().contains("origin"),
            "refused: {refused}"
        );
    }
}

#[tokio::test]
async fn refuses_a_maximum_connections_or_a_maximum_connections_per_address_that_is_not_a_whole_number_above_0()
 {
    for (options, refusal) in [
        (
            WebSocketTransportServerOptions {
                maximum_connections: Some(0),
                ..briefly_closing()
            },
            "maximumConnections is a whole number above 0, not 0",
        ),
        (
            WebSocketTransportServerOptions {
                maximum_connections_per_address: Some(0),
                ..briefly_closing()
            },
            "maximumConnectionsPerAddress is a whole number above 0, not 0",
        ),
    ] {
        assert_eq!(
            WebSocketTransportServer::new(&options)
                .unwrap_err()
                .to_string(),
            refusal,
            "refused"
        );
    }
}

#[tokio::test]
async fn refuses_an_upgrade_that_comes_as_it_stops_503_busy_told_when_to_come_back() {
    let (server, recorder, port) = started(&judging(&["bead.test"], &[])).await;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

    // its head under way as the stop begins, whole after it
    let request = request_of("GET / HTTP/1.1", &[]);
    let (first, second) = request.split_at(10);

    socket.write_all(first.as_bytes()).await.unwrap();
    rest(Duration::from_millis(50)).await;
    stopped(&server).await;
    socket.write_all(second.as_bytes()).await.unwrap();

    let mut answer = Vec::new();

    patience(PATIENCE, socket.read_to_end(&mut answer))
        .await
        .unwrap()
        .ok();

    assert_eq!(
        latin1(&answer),
        refused_with("503 Service Unavailable", ("busy", &["retry-after: 1"])),
        "busy"
    );
    assert_eq!(recorder.refusals()[0].reason, "busy", "told");
}

#[tokio::test]
async fn bounds_its_connections_and_those_of_one_address_refusing_an_upgrade_past_them_503_busy_before_its_101_with_retry_after_and_takes_one_once_a_connection_closes()
 {
    for (maximum_connections, maximum_connections_per_address) in [(Some(1), None), (None, Some(1))]
    {
        let (server, recorder, port) = started(&WebSocketTransportServerOptions {
            clock: Some(dated()),
            maximum_connections,
            maximum_connections_per_address,
            ..briefly_closing()
        })
        .await;
        let mut first = client(port).await;
        let handle = recorder.connections(1).await.remove(0);

        assert_eq!(
            answer_of(port, &request_of("GET / HTTP/1.1", &["Host: 127.0.0.1"])).await,
            (
                refused_with("503 Service Unavailable", ("busy", &["retry-after: 1"])),
                true
            ),
            "busy past its bound"
        );

        first.close(None).await.unwrap();

        while let Some(Ok(_)) = next_of(&mut first).await {}

        recorder.closes(1).await;

        assert_eq!(server.clients().len(), 0, "{handle} gone");

        let _next = client(port).await;

        recorder.connections(2).await;
        stopped(&server).await;
    }
}

#[tokio::test]
async fn takes_no_more_upgrades_than_its_places_when_they_cross() {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        maximum_connections: Some(3),
        ..briefly_closing()
    })
    .await;
    let answers = futures_util::future::join_all((0..8).map(|_| async move {
        answer_of(port, &request_of("GET / HTTP/1.1", &["Host: 127.0.0.1"])).await
    }))
    .await;
    let taken = answers
        .iter()
        .filter(|(answer, _)| answer.starts_with("HTTP/1.1 101 "))
        .count();

    assert_eq!(taken, 3, "its places alone");
    assert_eq!(
        recorder
            .refusals()
            .iter()
            .filter(|refusal| refusal.reason == "busy")
            .count(),
        5,
        "the rest busy"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn tells_each_refusal_it_judges_of_its_own_its_status_its_reason_the_request_s_authority_and_origin_and_the_client_s_address_and_port_and_nothing_of_http_s_own_at_its_address()
 {
    let (server, recorder, port) = started(&judging(&["bead.test", "127.0.0.1"], &[])).await;
    let mut expected = Vec::new();

    for (request, status, reason, authority, origin) in [
        (
            request_of(
                "GET / HTTP/1.1",
                &[
                    "Host: elsewhere.test:8080",
                    "Origin: http://elsewhere.test:8080",
                    "Origin: null",
                ],
            ),
            403,
            "host-refused",
            Some("elsewhere.test:8080"),
            Some("http://elsewhere.test:8080, null"),
        ),
        (
            request_of("POST / HTTP/1.1", &[]),
            405,
            "method-refused",
            Some("bead.test"),
            None,
        ),
        (
            request_of("GET / HTTP/1.1", &NO_UPGRADE),
            426,
            "upgrade-required",
            Some("bead.test"),
            None,
        ),
        (
            request_of("GET / HTTP/1.1", &["Sec-WebSocket-Version: 8"]),
            426,
            "version-refused",
            Some("bead.test"),
            None,
        ),
        (
            request_of("GET / HTTP/1.1", &["Sec-WebSocket-Key"]),
            400,
            "malformed",
            Some("bead.test"),
            None,
        ),
        (
            request_of("GET / HTTP/1.1", &["Origin: https://elsewhere.test"]),
            403,
            "origin-refused",
            Some("bead.test"),
            Some("https://elsewhere.test"),
        ),
        // HTTP's own: nothing told
        (request_of("GET / HTTP/1.1", &["Host"]), 400, "", None, None),
    ] {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let local_port = socket.local_addr().unwrap().port();

        socket.write_all(request.as_bytes()).await.unwrap();

        let mut answer = Vec::new();

        patience(PATIENCE, socket.read_to_end(&mut answer))
            .await
            .unwrap()
            .ok();

        if !reason.is_empty() {
            let mut told = TransportServerRefusal::new(status, reason);

            told.address = Some("127.0.0.1".to_owned());
            told.authority = authority.map(str::to_owned);
            told.origin = origin.map(str::to_owned);
            told.port = Some(local_port);
            expected.push(told);
        }
    }

    assert_eq!(recorder.refusals(), expected, "each told, in its order");
    stopped(&server).await;
}

#[tokio::test]
async fn refuses_as_it_would_though_a_refusal_listener_throws_the_throw_reported_with_no_connection()
 {
    struct Throwing;

    impl ServerListener for Throwing {
        fn on_refusal(&self, _refusal: &TransportServerRefusal) {
            panic!("a refusal listener that throws");
        }
    }

    let server = WebSocketTransportServer::new(&judging(&["bead.test"], &[])).unwrap();

    server.listen(Arc::new(Throwing));

    let recorder = recorded(&server);
    let port = server.start(&on_loopback()).await.unwrap().port;

    assert_eq!(
        answer_of(port, &request_of("POST / HTTP/1.1", &[])).await,
        (
            refused_with(
                "405 Method Not Allowed",
                ("method-refused", &["allow: GET, HEAD"])
            ),
            true
        ),
        "refused as it would"
    );
    assert_eq!(
        recorder.errors(1).await,
        vec![(
            "a listener panicked: a refusal listener that throws".to_owned(),
            None
        )],
        "reported with no connection"
    );
    assert_eq!(recorder.refusals().len(), 1, "the listener after it told");
    stopped(&server).await;
}

// ── Its credential ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn hands_every_envelope_of_a_connection_its_upgrade_s_authorization_as_it_came_and_trimmed_and_carries_none_toward_its_client()
 {
    let (server, recorder, port) = started(&briefly_closing()).await;

    for (given, carried) in [
        (Some("Bearer a.b.c"), Some("Bearer a.b.c")),
        (Some("  Basic  dXNlcg==  "), Some("Basic  dXNlcg==")),
        (Some(""), None),
        (None, None),
    ] {
        let fields: Vec<(&str, &str)> = given
            .map(|given| ("authorization", given))
            .into_iter()
            .collect();
        let mut client = client_with(port, &fields).await;
        let count = recorder.count(|told| told.messages.len());

        client.send(binary(&[1])).await.unwrap();
        client.send(binary(&[2])).await.unwrap();

        let messages = recorder.messages(count + 2).await;

        for (message, handle) in &messages[count..] {
            assert_eq!(message.credential.as_deref(), carried, "{given:?}");
            assert!(!server.carries_credential(handle), "none toward its client");
        }

        client.close(None).await.ok();
    }

    stopped(&server).await;
}

#[tokio::test]
async fn carries_no_credential_from_an_upgrade_that_carries_an_origin_its_own_or_one_it_takes_whatever_its_authorization()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        origins: Some(vec!["https://bead.example".to_owned()]),
        ..briefly_closing()
    })
    .await;

    for origin in [
        format!("http://127.0.0.1:{port}"),
        "https://bead.example".to_owned(),
    ] {
        let mut client = client_with(
            port,
            &[("origin", &origin), ("authorization", "Bearer a.b.c")],
        )
        .await;
        let count = recorder.count(|told| told.messages.len());

        client.send(binary(&[1])).await.unwrap();

        let (message, _) = recorder.messages(count + 1).await.remove(count);

        assert_eq!(message.credential, None, "none from {origin}");
        client.close(None).await.ok();
    }

    stopped(&server).await;
}

#[tokio::test]
async fn names_a_connection_to_its_listeners_by_its_handle_and_nothing_of_its_credential() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    let _client = client_with(port, &[("authorization", "Bearer secret")]).await;
    let handle = recorder.connections(1).await.remove(0);

    assert!(!handle.contains("secret"), "its handle: {handle}");
    assert!(
        !format!("{:?}", server.clients()).contains("secret"),
        "nothing of it in its clients"
    );
    stopped(&server).await;
}

// ── Its pace: its heartbeat, its sends and its pause ───────────────────────────────────────────

// a server of `options` whose timers that bound the platform's socket run on `platform`, started
// on the IPv4 loopback
async fn started_on(
    platform: SharedClock,
    options: &WebSocketTransportServerOptions,
) -> (WebSocketTransportServer, Arc<Recorder>, u16) {
    let runtime = platform::runtime_of(None, "a test").unwrap();
    let server = WebSocketTransportServer::on_platform((runtime, platform), options).unwrap();
    let recorder = recorded(&server);
    let bound = patience(PATIENCE, server.start(&on_loopback()))
        .await
        .unwrap()
        .unwrap();

    (server, recorder, bound.port)
}

// a client whose frames are read, so it answers each ping, until its server closes it
fn reading(mut client: Client) -> JoinHandle<()> {
    crate::testing::spawn(async move { while let Some(Ok(_)) = client.next().await {} })
}

fn message_of(bytes: Vec<u8>) -> TransportMessage {
    TransportMessage {
        data: Bytes::from(bytes),
        ..TransportMessage::default()
    }
}

#[tokio::test]
async fn a_websocket_server_transport_takes_the_procedures_it_is_given() {
    let address = |service_id: u16, procedure_id: u16| ProcedureAddress {
        service_id,
        procedure_id,
    };
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        procedures: Some(vec![address(2, 1)]),
        ..briefly_closing()
    })
    .await;
    let _client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    assert!(server.names_procedures(), "it names them");
    assert_eq!(
        [
            server.takes_procedure(&handle, address(2, 1)),
            server.takes_procedure(&handle, address(2, 2)),
            server.takes_procedure(&handle, address(3, 1)),
        ],
        [true, false, false],
        "the one it was given"
    );
    // given none, it names none: its router never asks
    assert!(
        !WebSocketTransportServer::new(&briefly_closing())
            .unwrap()
            .names_procedures(),
        "none named"
    );
    stopped(&server).await;
}

#[tokio::test]
async fn pings_each_connection_every_heartbeat_and_drops_one_that_left_a_ping_unanswered_or_could_not_be_sent_one()
 {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (server, recorder, port) = started_on(
        Arc::<SteppingClock>::clone(&stepping),
        &WebSocketTransportServerOptions {
            heartbeat: Some(Duration::from_millis(20)),
            ..briefly_closing()
        },
    )
    .await;
    let answering = reading(client(port).await);
    let (mut silent, _) = upgraded(port).await;
    let handles = recorder.connections(2).await;

    // a beat: each pinged
    stepping.tick(Duration::from_millis(20));

    let mut ping = [0_u8; 2];

    patience(PATIENCE, silent.read_exact(&mut ping))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(ping, [0x89, 0x00], "an empty ping");

    // the answering one's pong read before the next beat
    rest(Duration::from_millis(200)).await;
    stepping.tick(Duration::from_millis(20));

    assert_eq!(
        recorder.closes(1).await,
        vec![(false, Arc::clone(&handles[1]))],
        "the silent one dropped, unclean"
    );
    assert_eq!(recorder.count(|told| told.errors.len()), 0, "no error");
    assert_eq!(server.clients().len(), 1, "the answering one kept");
    stopped(&server).await;
    answering.await.unwrap();
}

#[tokio::test]
async fn drops_a_peer_that_never_answers_its_pings_and_keeps_one_that_does() {
    // beats wide enough that a pong never misses one on a loaded machine
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        heartbeat: Some(Duration::from_millis(200)),
        ..briefly_closing()
    })
    .await;
    let answering = reading(client(port).await);
    let (_silent, _) = upgraded(port).await;
    let handles = recorder.connections(2).await;

    assert_eq!(
        recorder.closes(1).await,
        vec![(false, Arc::clone(&handles[1]))],
        "the silent one dropped"
    );

    rest(Duration::from_millis(600)).await;

    assert_eq!(
        server
            .clients()
            .iter()
            .map(|client| Arc::clone(&client.connection_handle))
            .collect::<Vec<_>>(),
        vec![Arc::clone(&handles[0])],
        "the answering one kept"
    );
    stopped(&server).await;
    answering.await.unwrap();
}

#[tokio::test]
async fn beats_every_heartbeat_when_told_nothing() {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (server, recorder, port) =
        started_on(Arc::<SteppingClock>::clone(&stepping), &briefly_closing()).await;
    let reader = reading(client(port).await);

    recorder.connections(1).await;

    assert_eq!(HEARTBEAT, Duration::from_secs(30), "its default");
    assert_eq!(stepping.dues(), vec![HEARTBEAT], "one beat armed");
    stopped(&server).await;
    reader.await.unwrap();
}

#[tokio::test]
async fn pings_nothing_with_a_heartbeat_of_infinity() {
    for (heartbeat, dues) in [
        (Duration::from_millis(200), vec![Duration::from_millis(200)]),
        (NEVER, vec![]),
    ] {
        let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
        let (server, recorder, port) = started_on(
            Arc::<SteppingClock>::clone(&stepping),
            &WebSocketTransportServerOptions {
                heartbeat: Some(heartbeat),
                ..briefly_closing()
            },
        )
        .await;
        let reader = reading(client(port).await);

        recorder.connections(1).await;

        assert_eq!(stepping.dues(), dues, "beats of {heartbeat:?}");
        stopped(&server).await;
        reader.await.unwrap();
    }
}

#[tokio::test]
async fn takes_a_client_s_address_from_x_forwarded_for_only_from_a_proxy_it_names_and_names_its_connection_by_it()
 {
    for (trusted, named) in [("127.0.0.1", "203.0.113.7"), ("192.0.2.0/24", "127.0.0.1")] {
        let (server, recorder, port) = started(&WebSocketTransportServerOptions {
            clock: Some(dated()),
            hosts: Some(vec!["bead.test".to_owned()]),
            trusted_proxies: Some(vec![trusted.to_owned()]),
            ..briefly_closing()
        })
        .await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let local_port = socket.local_addr().unwrap().port();

        socket
            .write_all(
                request_of(
                    "GET / HTTP/1.1",
                    &["X-Forwarded-For: 198.51.100.1, 203.0.113.7"],
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        read_head_of(&mut socket).await;
        socket
            .write_all(&masked_frame(0x2, (&[1], true)))
            .await
            .unwrap();

        let handle = recorder.connections(1).await.remove(0);
        let (message, _) = recorder.messages(1).await.remove(0);

        assert_eq!(
            *handle,
            format!("type=WS;ip={named};port={local_port};ordinal=1"),
            "behind {trusted}"
        );
        assert_eq!(message.address.as_deref(), Some(named), "its envelopes'");

        // and a refusal names it alike
        let mut refused = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        refused
            .write_all(
                request_of(
                    "POST / HTTP/1.1",
                    &["X-Forwarded-For: 198.51.100.1, 203.0.113.7"],
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        read_head_of(&mut refused).await;

        assert_eq!(
            recorder.refusals()[0].address.as_deref(),
            Some(named),
            "its refusal's"
        );
        stopped(&server).await;
    }
}

#[tokio::test]
async fn refuses_as_it_is_built_a_trusted_proxies_entry_that_is_a_name_or_a_network_of_prefix_0_or_an_unnamed_proxies_past_8()
 {
    for (trusted_proxies, unnamed_proxies) in [
        (vec!["proxy.test".to_owned()], None),
        (vec!["0.0.0.0/0".to_owned()], None),
        (vec![], Some(9)),
    ] {
        assert!(
            WebSocketTransportServer::new(&WebSocketTransportServerOptions {
                trusted_proxies: Some(trusted_proxies.clone()),
                unnamed_proxies,
                ..briefly_closing()
            })
            .is_err(),
            "{trusted_proxies:?}, {unnamed_proxies:?} refused"
        );
    }
}

#[tokio::test]
async fn keeps_a_client_that_reads_through_a_burst_of_answers_to_the_calls_it_has_it_answer_each_of_chunk_bytes()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        send_grace_period: Some(Duration::from_millis(100)),
        ..briefly_closing()
    })
    .await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    for index in 0..64_u8 {
        server
            .send(message_of(vec![index; 65_536]), &handle)
            .unwrap();
    }

    for index in 0..64_u8 {
        assert_eq!(
            next_of(&mut client).await.unwrap().unwrap(),
            binary(&vec![index; 65_536]),
            "chunk {index}"
        );
    }

    rest(Duration::from_millis(1_200)).await;

    assert_eq!(recorder.count(|told| told.closes.len()), 0, "kept");
    assert_eq!(
        recorder.count(|told| told.errors.len()),
        0,
        "nothing reported"
    );
    stopped(&server).await;
}

// spec 15.12.11 and 15.12.12
#[tokio::test]
async fn drops_a_client_that_stops_reading_once_its_socket_holds_what_waits_for_it_past_its_deadline_and_reports_it()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        maximum_unsent_bytes: Some(1 << 30),
        minimum_send_bytes_per_second: Some(1_000_000_000),
        send_grace_period: Some(Duration::from_millis(100)),
        heartbeat: Some(NEVER),
        ..briefly_closing()
    })
    .await;
    // a client that reads nothing past its 101
    let (_socket, _) = upgraded(port).await;
    let handle = recorder.connections(1).await.remove(0);

    for _ in 0..64 {
        server.send(message_of(vec![0; 1 << 20]), &handle).unwrap();
    }

    assert_eq!(
        recorder.errors(1).await,
        vec![(
            format!(
                "{handle} is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 1000000000 past sendGracePeriod 100 ms"
            ),
            Some(Arc::clone(&handle))
        )],
        "reported, naming its pace"
    );
    assert_eq!(recorder.closes(1).await, vec![(false, handle)], "unclean");
    assert_eq!(
        recorder.order()[recorder.order().len() - 2..],
        ["error", "close"],
        "its error first"
    );
    stopped(&server).await;
}

// spec 15.12.13
#[tokio::test]
async fn drops_a_client_once_what_waits_for_it_would_pass_maximum_unsent_bytes_the_bytes_it_holds_never_past_them_its_close_unclean_and_reports_it()
 {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        maximum_unsent_bytes: Some(1_000),
        ..briefly_closing()
    })
    .await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    // * both within one turn: the first still waits as the second comes
    server.send(message_of(vec![1; 600]), &handle).unwrap();

    assert_eq!(
        server.gauges().unwrap().counts.get("unsentBytes"),
        Some(&600),
        "what waits"
    );

    server.send(message_of(vec![2; 600]), &handle).unwrap();

    assert_eq!(
        server.gauges().unwrap().ceilings.get("largestUnsentBytes"),
        Some(&1_000),
        "its bound"
    );

    let mut received = Vec::new();

    while let Some(Ok(message)) = next_of(&mut client).await {
        received.push(message);
    }

    assert!(
        received.iter().all(|message| *message != binary(&[2; 600])),
        "the second never sent"
    );
    assert_eq!(
        recorder.errors(1).await,
        vec![(
            format!(
                "{handle} is dropped: what waits for its socket would pass maximumUnsentBytes, 1000 bytes"
            ),
            Some(Arc::clone(&handle))
        )],
        "reported, naming its bound"
    );
    assert_eq!(recorder.closes(1).await, vec![(false, handle)], "unclean");
    stopped(&server).await;
}

// spec 15.1
// * an error listener that panics is caught as it tells and its panic dropped, as every side drops
// it: the listener after it, its recorder, hears each error alone
#[tokio::test]
async fn closes_with_1009_and_drops_behind_maximum_unsent_bytes_a_connection_whose_error_listener_throws_telling_its_close_all_the_same_and_dropping_what_it_threw()
 {
    struct Throwing;

    impl ServerListener for Throwing {
        fn on_error(&self, _error: &RouterError, _connection_handle: Option<&ConnectionHandle>) {
            panic!("an error listener that throws");
        }
    }

    let server = WebSocketTransportServer::new(&WebSocketTransportServerOptions {
        maximum_message_bytes: Some(8),
        maximum_unsent_bytes: Some(1_000),
        ..briefly_closing()
    })
    .unwrap();

    server.listen(Arc::new(Throwing));

    let recorder = recorded(&server);
    let port = server.start(&on_loopback()).await.unwrap().port;
    // past its message bound
    let mut first = client(port).await;

    first.send(binary(&[0; 9])).await.unwrap();

    while let Some(Ok(_)) = next_of(&mut first).await {}

    let failed = recorder.connections(1).await.remove(0);

    assert_eq!(recorder.closes(1).await.len(), 1, "its close told");

    // past what may wait for it
    let second = reading(client(port).await);
    let handle = recorder.connections(2).await.remove(1);

    server.send(message_of(vec![1; 600]), &handle).unwrap();
    server.send(message_of(vec![2; 600]), &handle).unwrap();

    assert_eq!(
        recorder.closes(2).await[1],
        (false, Arc::clone(&handle)),
        "its close told all the same"
    );
    assert_eq!(
        recorder.errors(2).await,
        vec![
            (
                format!(
                    "{failed} is closed with 1009: a message past its maximumMessageBytes, 8 bytes"
                ),
                Some(Arc::clone(&failed))
            ),
            (
                format!(
                    "{handle} is dropped: what waits for its socket would pass maximumUnsentBytes, 1000 bytes"
                ),
                Some(Arc::clone(&handle))
            )
        ],
        "each error alone, no throw told"
    );
    stopped(&server).await;
    second.await.unwrap();
}

#[tokio::test]
async fn refuses_a_maximum_unsent_bytes_a_minimum_send_bytes_per_second_or_a_send_grace_period_it_cannot_hold_as_it_is_built()
 {
    for (options, refusal) in [
        (
            WebSocketTransportServerOptions {
                maximum_unsent_bytes: Some(0),
                ..briefly_closing()
            },
            "maximumUnsentBytes",
        ),
        (
            WebSocketTransportServerOptions {
                send_grace_period: Some(NEVER),
                ..briefly_closing()
            },
            "sendGracePeriod",
        ),
        (
            WebSocketTransportServerOptions {
                send_grace_period: Some(Duration::ZERO),
                ..briefly_closing()
            },
            "sendGracePeriod",
        ),
    ] {
        let refused = WebSocketTransportServer::new(&options)
            .unwrap_err()
            .to_string();

        assert!(refused.starts_with(refusal), "{refusal}: {refused}");
    }

    // a rate of 0 holds none
    assert!(
        WebSocketTransportServer::new(&WebSocketTransportServerOptions {
            minimum_send_bytes_per_second: Some(0),
            ..briefly_closing()
        })
        .is_ok(),
        "0 taken"
    );
}

// spec 15.12.17
#[tokio::test]
async fn reads_no_message_of_a_paused_connection_holds_the_rest_of_its_read_and_hands_it_in_order_once_resumed()
 {
    struct Pausing {
        server: Mutex<Option<WebSocketTransportServer>>,
        heard: Mutex<Vec<u32>>,
    }

    impl ServerListener for Pausing {
        fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
            let mut heard = self.heard.lock().unwrap();

            heard.push(u32::from_be_bytes(message.data[..4].try_into().unwrap()));

            // * a router at its bound pauses within the hand
            if heard.len() == 3
                && let Some(server) = self.server.lock().unwrap().as_ref()
            {
                server.pause(connection_handle);
            }
        }
    }

    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        heartbeat: Some(NEVER),
        ..briefly_closing()
    })
    .await;
    let pausing = Arc::new(Pausing {
        server: Mutex::new(Some(server.clone())),
        heard: Mutex::new(Vec::new()),
    });

    server.listen(Arc::<Pausing>::clone(&pausing));

    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    for index in 0..2_000_u32 {
        client.feed(binary(&index.to_be_bytes())).await.unwrap();
    }

    client.flush().await.unwrap();
    recorder.messages(3).await;
    rest(Duration::from_millis(100)).await;

    assert_eq!(pausing.heard.lock().unwrap().len(), 3, "read no more");

    server.resume(&handle);
    recorder.messages(2_000).await;

    assert_eq!(
        *pausing.heard.lock().unwrap(),
        (0..2_000).collect::<Vec<u32>>(),
        "each, in order"
    );
    pausing.server.lock().unwrap().take();
    stopped(&server).await;
}

// spec 15.12.17; RFC 6455 §7.1.1
#[tokio::test]
async fn a_paused_connection_closes_cleanly() {
    let (server, recorder, port) = started(&WebSocketTransportServerOptions {
        close_timeout: Some(Duration::from_secs(2)),
        heartbeat: Some(NEVER),
        ..WebSocketTransportServerOptions::default()
    })
    .await;
    let mut client = client(port).await;
    let handle = recorder.connections(1).await.remove(0);

    server.pause(&handle);
    client.send(binary(&[0; 4])).await.unwrap();
    rest(Duration::from_millis(50)).await;

    let begun = Instant::now();
    let closing = server.close(&handle);

    // a pause its router asks as it closes is let be
    server.pause(&handle);

    while let Some(Ok(_)) = next_of(&mut client).await {}

    assert!(patience(PATIENCE, closing).await.unwrap(), "closed");
    // * it read its peer's Close, its own pause opened: clean, long before its close timeout
    assert_eq!(recorder.closes(1).await, vec![(true, handle)], "clean");
    assert!(
        begun.elapsed() < Duration::from_millis(1_500),
        "before its timeout"
    );
    // what it held dropped with it
    assert_eq!(
        recorder.count(|told| told.messages.len()),
        0,
        "nothing handed"
    );
    stopped(&server).await;
}

// the twin of `"clients" is a copy without the sockets`: each entry what its connection looked like
// as it was taken, a later change leaving the copy as it was
#[tokio::test]
async fn clients_is_a_copy_without_the_sockets() {
    let (server, recorder, port) = started(&briefly_closing()).await;
    // a socket of the test's own, whose port is known
    let (first, _) = upgraded(port).await;
    let first_handle = recorder.connections(1).await.remove(0);
    let first_port = first.local_addr().unwrap().port();
    let clients = server.clients();

    assert_eq!(
        clients
            .iter()
            .map(|client| (
                Arc::clone(&client.connection_handle),
                client.address.clone(),
                client.port,
                client.last_activity,
                client.transport_type
            ))
            .collect::<Vec<_>>(),
        [(
            Arc::clone(&first_handle),
            "127.0.0.1".to_owned(),
            Some(first_port),
            None,
            TRANSPORT_WEBSOCKET
        )],
        "what it held then"
    );

    // in the order the connections came, whichever went in between; the copy taken before stays
    let second = client(port).await;
    let second_handle = recorder.connections(2).await.remove(1);

    drop(first);
    recorder.closes(1).await;

    let third = client(port).await;
    let third_handle = recorder.connections(3).await.remove(2);
    let handles_of = |clients: &[TransportServerClient]| {
        clients
            .iter()
            .map(|client| Arc::clone(&client.connection_handle))
            .collect::<Vec<_>>()
    };

    assert_eq!(
        handles_of(&server.clients()),
        [second_handle, third_handle],
        "those it holds now, in order"
    );
    assert_eq!(handles_of(&clients), [first_handle], "the copy as it was");
    drop((second, third));
    stopped(&server).await;
}

#[tokio::test]
async fn draws_a_port_on_localhost_again_when_the_ipv6_loopback_holds_the_one_drawn_on_ipv4() {
    use crate::net::loopbacks::{LoopbackBinding, draw_port, listener_on};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let Ok(holder) = listener_on("::1".parse().unwrap(), 0) else {
        return;
    };
    let occupied = holder.local_addr().unwrap().port();
    let draws = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&draws);
    let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();

    *locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
        port: 0,
        find_open_port: true,
        draw_port: Box::new(move || {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(occupied)
            } else {
                loop {
                    let port = draw_port()?;
                    if port != occupied {
                        break Ok(port);
                    }
                }
            }
        }),
        ipv6_refusal: None,
    });
    let bound = server
        .start(&TransportServerStartOptions {
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    assert_eq!(draws.load(Ordering::SeqCst), 2, "a second draw");
    assert_eq!(bound.address, "localhost");
    assert_ne!(bound.port, occupied);
    assert_eq!(server.ready_state(), ReadyState::Open);
    assert!(
        listener_on("127.0.0.1".parse().unwrap(), occupied).is_ok(),
        "the first IPv4 listener let go"
    );
    let recorder = recorded(&server);
    let _ipv4 = client(bound.port).await;
    let socket = TcpStream::connect(("::1", bound.port)).await.unwrap();
    let (_ipv6, _) = tokio_tungstenite::client_async(format!("ws://[::1]:{}/", bound.port), socket)
        .await
        .unwrap();
    let handles = recorder.connections(2).await;
    assert!(
        handles.iter().all(|handle| server.is_secure(handle)),
        "both secure"
    );
    server.stop().await.unwrap();
    for address in ["127.0.0.1", "::1"] {
        assert!(
            listener_on(address.parse().unwrap(), bound.port).is_ok(),
            "{address} let go"
        );
    }

    // eight draws at most, then the last error; a given port is tried once
    for find_open_port in [true, false] {
        let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
        let refusals = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&refusals);
        *locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
            port: occupied,
            find_open_port,
            draw_port: Box::new(move || Ok(occupied)),
            ipv6_refusal: Some(Box::new(move |_port| {
                count.fetch_add(1, Ordering::SeqCst);
                Some(io::Error::from(io::ErrorKind::AddrInUse))
            })),
        });
        let refused = server
            .start(&TransportServerStartOptions {
                port: Some(occupied),
                find_open_port: Some(find_open_port),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap_err();
        let RouterError::Other(error) = refused else {
            panic!("an io error")
        };
        assert_eq!(
            error.downcast_ref::<io::Error>().map(io::Error::kind),
            Some(io::ErrorKind::AddrInUse)
        );
        assert_eq!(
            refusals.load(Ordering::SeqCst),
            if find_open_port { 8 } else { 1 }
        );
        assert_eq!(server.ready_state(), ReadyState::Closed);
        assert!(
            listener_on("127.0.0.1".parse().unwrap(), occupied).is_ok(),
            "no listener left"
        );
    }
}

#[tokio::test]
async fn listens_on_127_0_0_1_alone_where_the_ipv6_loopback_is_absent_and_reports_127_0_0_1() {
    use crate::net::loopbacks::{FAMILY_NOT_SUPPORTED, LoopbackBinding, draw_port, listener_on};
    use std::sync::atomic::{AtomicUsize, Ordering};

    for error in [
        io::Error::from(io::ErrorKind::AddrNotAvailable),
        io::Error::from_raw_os_error(FAMILY_NOT_SUPPORTED),
    ] {
        let server = WebSocketTransportServer::new(&briefly_closing()).unwrap();
        let draws = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&draws);
        let kind = error.kind();
        let raw = error.raw_os_error();
        *locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
            port: 0,
            find_open_port: true,
            draw_port: Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                draw_port()
            }),
            ipv6_refusal: Some(Box::new(move |_port| {
                Some(raw.map_or_else(|| io::Error::from(kind), io::Error::from_raw_os_error))
            })),
        });
        let bound = server
            .start(&TransportServerStartOptions {
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap();
        assert_eq!(bound.address, "127.0.0.1");
        assert_eq!(draws.load(Ordering::SeqCst), 1);
        assert_eq!(server.ready_state(), ReadyState::Open);
        let recorder = recorded(&server);
        let _client = client(bound.port).await;
        let handle = recorder.connections(1).await.remove(0);
        assert!(server.is_secure(&handle));
        if listener_on("::1".parse().unwrap(), 0).is_ok() {
            assert!(
                listener_on("::1".parse().unwrap(), bound.port).is_ok(),
                "IPv6 left alone"
            );
        }
        server.stop().await.unwrap();
        assert!(
            listener_on("127.0.0.1".parse().unwrap(), bound.port).is_ok(),
            "IPv4 let go"
        );
    }
}

#[tokio::test]
async fn closes_going_away_a_connection_whose_accept_a_stop_crossed() {
    // a silent peer holds the stop past its snapshot; the empty snapshot plays the crossing too
    for with_silent in [true, false] {
        let (server, recorder, port) = started(&WebSocketTransportServerOptions {
            close_timeout: Some(NEVER),
            ..WebSocketTransportServerOptions::default()
        })
        .await;
        let mut silent = if with_silent {
            Some(client(port).await)
        } else {
            None
        };
        if with_silent {
            recorder.connections(1).await;
        }
        let stopping = server.stop();
        assert_eq!(server.ready_state(), ReadyState::Closing);
        if let Some(silent) = &mut silent {
            assert!(
                matches!(
                    next_of(silent).await,
                    Some(Ok(Message::Close(Some(CloseFrame {
                        code: CloseCode::Away,
                        ..
                    }))))
                ),
                "the snapshot's 1001"
            );
        }

        // * this socket's accept crosses the snapshot, before its connection is registered
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let mut late = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        let inner = Arc::clone(&server.inner);
        let running = crate::testing::spawn(async move {
            inner.take_socket_after_stop(accepted).await;
        });
        let mut late = WebSocketStream::from_raw_socket(&mut late, Role::Client, None).await;
        let handles = recorder.connections(if with_silent { 2 } else { 1 }).await;
        let late_handle = handles.last().unwrap();
        let close = patience(PATIENCE, late.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                close,
                Message::Close(Some(CloseFrame {
                    code: CloseCode::Away,
                    ..
                }))
            ),
            "the arrival's 1001"
        );
        late.flush().await.unwrap();
        patience(PATIENCE, running).await.unwrap().unwrap();
        if let Some(silent) = &mut silent {
            // its reply releases the stop only after the late connection ended
            silent.flush().await.unwrap();
        }
        patience(PATIENCE, stopping).await.unwrap().unwrap();
        let closes = recorder.closes(handles.len()).await;
        assert_eq!(closes.len(), handles.len(), "each close once");
        assert!(
            closes.contains(&(false, Arc::clone(late_handle))),
            "the late close told"
        );
        for handle in handles {
            assert!(
                closes.contains(&(false, handle)),
                "going away, each its own handle"
            );
        }
        assert!(server.clients().is_empty(), "none held");
        assert_eq!(server.ready_state(), ReadyState::Closed);
        assert_eq!(recorder.count(|told| told.errors.len()), 0);
    }
}

// whether `port` of the IPv4 loopback comes to be bound again within the patience
async fn is_let_go(port: u16) -> bool {
    patience(PATIENCE, async {
        while std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            rest(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn lets_its_port_go_once_its_last_handle_is_dropped_idle_without_its_stop() {
    let (server, _recorder, port) = started(&WebSocketTransportServerOptions::default()).await;

    drop(server);

    assert!(is_let_go(port).await, "its port let go");
}
