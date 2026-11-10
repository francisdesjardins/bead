//! What the HTTP transport server's tests share, as the other sides'
//! `http-transport-server-fixtures.ts` and `HttpTransportServerTests`' helpers: a server started on
//! the loopback with the events it tells, and a client of the test's own, each exchange on a socket
//! of its own, written octet for octet.

use core::time::Duration;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;

pub(crate) use crate::http::fields::{
    BEAD_MEDIA_TYPE, CANCEL, CONNECTION_TOKEN_HEADER, REFUSAL_HEADER, REQUEST, RESULT,
};
use crate::http::server::{HttpTransportServer, HttpTransportServerOptions};
use crate::router::types::{ConnectionHandle, RouterError, TransportMessage};
use crate::testing::patience;
use crate::testing::wire::{Exchange, ExchangeOptions, Response, ResponseHead, ResponseReader};
use crate::transport::{
    ServerListener, ServerTransport, TransportServerRefusal, TransportServerStartOptions,
};

/// How long a test waits for what it expects.
pub(crate) const PATIENCE: Duration = Duration::from_secs(10);

/// The loopback every server of the tests listens on.
pub(crate) const HOST: &str = "127.0.0.1";

/// A credential a request carries.
pub(crate) const BEARER: &str = "Bearer mF_9.B5f-4.1JqM";

/// A page of another origin, which a server answers CORS to when `origins` names it.
pub(crate) const PAGE: &str = "https://page.test";

// ── What a server tells ────────────────────────────────────────────────────────────────────────

/// What a server told, in its order.
#[derive(Debug, Default, Clone)]
pub(crate) struct Told {
    /// The events told, by name, in their order.
    pub(crate) order: Vec<&'static str>,
    pub(crate) connections: Vec<ConnectionHandle>,
    pub(crate) messages: Vec<(TransportMessage, ConnectionHandle)>,
    pub(crate) closes: Vec<(bool, ConnectionHandle)>,
    pub(crate) refusals: Vec<TransportServerRefusal>,
    pub(crate) errors: Vec<(String, Option<ConnectionHandle>)>,
    pub(crate) listens: Vec<(bool, ConnectionHandle)>,
}

/// What hears a server's events.
#[derive(Debug, Default)]
pub(crate) struct Recorder {
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

    /// What it heard so far.
    pub(crate) fn told(&self) -> Told {
        self.told.lock().unwrap().clone()
    }

    /// Waits until `found` reads what it waits for in what was told, and gives it.
    pub(crate) async fn until<T: Send, F: Fn(&Told) -> Option<T> + Send + Sync>(
        &self,
        found: F,
    ) -> T {
        patience(PATIENCE, async {
            loop {
                let changed = self.changed.notified();
                let mut changed = core::pin::pin!(changed);

                changed.as_mut().enable();

                let seen = found(&self.told.lock().unwrap());

                if let Some(seen) = seen {
                    return seen;
                }

                changed.await;
            }
        })
        .await
        .expect("what was waited for, within patience")
    }

    /// The messages told, once `count` were.
    pub(crate) async fn messages(&self, count: usize) -> Vec<(TransportMessage, ConnectionHandle)> {
        self.until(|told| (told.messages.len() >= count).then(|| told.messages.clone()))
            .await
    }

    /// The closes told, once `count` were.
    pub(crate) async fn closes(&self, count: usize) -> Vec<(bool, ConnectionHandle)> {
        self.until(|told| (told.closes.len() >= count).then(|| told.closes.clone()))
            .await
    }

    /// The errors told, once `count` were.
    pub(crate) async fn errors(&self, count: usize) -> Vec<(String, Option<ConnectionHandle>)> {
        self.until(|told| (told.errors.len() >= count).then(|| told.errors.clone()))
            .await
    }

    /// The refusals told, once `count` were.
    pub(crate) async fn refusals(&self, count: usize) -> Vec<TransportServerRefusal> {
        self.until(|told| (told.refusals.len() >= count).then(|| told.refusals.clone()))
            .await
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

    fn on_listen(&self, is_held: bool, connection_handle: &ConnectionHandle) {
        self.record(("listen", |told: &mut Told| {
            told.listens.push((is_held, Arc::clone(connection_handle)));
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

// ── A server ───────────────────────────────────────────────────────────────────────────────────

/// A server started on the loopback, on a port the system drew, with what it tells.
pub(crate) struct Started {
    pub(crate) server: HttpTransportServer,
    pub(crate) recorder: Arc<Recorder>,
    pub(crate) port: u16,
}

impl Started {
    /// Stops it.
    pub(crate) async fn stop(&self) {
        patience(PATIENCE, self.server.stop())
            .await
            .expect("a stop within patience")
            .expect("a stop");
    }

    /// Sends `envelope` on `connection`, as its router would: its sending's outcome once settled.
    pub(crate) async fn send(
        &self,
        envelope: &[u8],
        connection: &ConnectionHandle,
    ) -> Result<(), RouterError> {
        let message = TransportMessage {
            data: Bytes::copy_from_slice(envelope),
            credential: None,
            address: None,
            port: None,
            may_overtake: false,
        };

        match self.server.send(message, connection)? {
            crate::transport::Sent::Done => Ok(()),
            crate::transport::Sent::Later(later) => patience(PATIENCE, later)
                .await
                .expect("a send settled within patience"),
        }
    }
}

/// A server of `options`, started on the IPv4 loopback on a port the system drew, its recorder
/// listening.
pub(crate) async fn started(options: &HttpTransportServerOptions) -> Started {
    let server = HttpTransportServer::new(options).unwrap();
    let recorder = Arc::new(Recorder::default());

    server.listen(Arc::<Recorder>::clone(&recorder));

    let bound = patience(
        PATIENCE,
        server.start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        }),
    )
    .await
    .unwrap()
    .unwrap();

    Started {
        server,
        recorder,
        port: bound.port,
    }
}

// ── A client ───────────────────────────────────────────────────────────────────────────────────

/// An envelope as the transport reads it: its layout, its kind, its call id, and `extra` bytes of
/// 7 after its prefix.
pub(crate) fn envelope_of(kind: u8, (call_id, extra): (u32, usize)) -> Vec<u8> {
    layout_of((0xA1, kind), (call_id, extra))
}

/// An envelope of `layout`.
pub(crate) fn layout_of((layout, kind): (u8, u8), (call_id, extra): (u32, usize)) -> Vec<u8> {
    let mut bytes = vec![7_u8; extra.checked_add(8).unwrap()];

    bytes[0] = layout;
    bytes[1] = kind;
    bytes[4..8].copy_from_slice(&call_id.to_be_bytes());

    bytes
}

/// A request's head, written as it says: `method` on `target`, `Host` the loopback's at `port`,
/// then `fields` in their order, each a line whole.
pub(crate) fn head_of((method, target): (&str, &str), (port, fields): (u16, &[&str])) -> String {
    let mut head = format!("{method} {target} HTTP/1.1\r\nHost: {HOST}:{port}\r\n");

    for field in fields {
        head.push_str(field);
        head.push_str("\r\n");
    }

    head.push_str("\r\n");
    head
}

/// What a `POST` carries: its token, its fields besides, and its body.
#[derive(Debug, Default, Clone)]
pub(crate) struct Post<'a> {
    pub(crate) token: Option<&'a str>,
    pub(crate) fields: Vec<String>,
    pub(crate) body: Vec<u8>,
    // its type left out
    pub(crate) untyped: bool,
}

impl Post<'_> {
    /// The request it is, written whole.
    pub(crate) fn request(&self, port: u16) -> Vec<u8> {
        let mut fields: Vec<String> = Vec::new();

        if !self.untyped {
            fields.push(format!("Content-Type: {BEAD_MEDIA_TYPE}"));
        }

        if let Some(token) = self.token {
            fields.push(format!("{CONNECTION_TOKEN_HEADER}: {token}"));
        }

        fields.extend(self.fields.iter().cloned());
        fields.push(format!("Content-Length: {}", self.body.len()));

        let lines: Vec<&str> = fields.iter().map(String::as_str).collect();
        let mut request = head_of(("POST", "/bead"), (port, &lines)).into_bytes();

        request.extend_from_slice(&self.body);
        request
    }
}

/// An exchange on a socket of its own, its request written whole at once.
pub(crate) async fn exchange_of(port: u16, request: &[u8]) -> Exchange {
    Exchange::open(
        request,
        &ExchangeOptions::new(SocketAddr::from(([127, 0, 0, 1], port))),
    )
    .await
    .unwrap()
}

/// A `POST` as `post` says, its response whole.
pub(crate) async fn posted(port: u16, sent: &Post<'_>) -> Response {
    exchange_of(port, &sent.request(port))
        .await
        .response(PATIENCE)
        .await
        .unwrap()
}

/// A `POST` whose answer waits on its server: its exchange, its head to come.
pub(crate) async fn posting(port: u16, sent: &Post<'_>) -> Exchange {
    exchange_of(port, &sent.request(port)).await
}

/// A connect: the handle its server drew, and its token.
pub(crate) async fn connect(started: &Started) -> (ConnectionHandle, String) {
    let response = posted(started.port, &Post::default()).await;

    assert_eq!(response.head.status, 201, "a connect drawn");

    let token = response.head.fields[CONNECTION_TOKEN_HEADER].clone();
    let handle = Arc::clone(
        &started
            .server
            .clients()
            .last()
            .expect("the connection drawn")
            .connection_handle,
    );

    (handle, token)
}

/// A response's status and its mark.
pub(crate) fn refusal_of(head: &ResponseHead) -> (u16, Option<String>) {
    (head.status, head.fields.get(REFUSAL_HEADER).cloned())
}

/// What a request written raw as `head` is answered: its head, read whole or as far as its socket
/// went, and the port it came from.
pub(crate) struct RawAnswer {
    pub(crate) status: u16,
    pub(crate) refusal: Option<String>,
    pub(crate) fields: BTreeMap<String, String>,
    pub(crate) local_port: u16,
}

/// What `request` written raw on `port` is answered, its head.
pub(crate) async fn raw_answer_of(port: u16, request: &[u8]) -> RawAnswer {
    let mut socket = TcpStream::connect((HOST, port)).await.unwrap();
    let local_port = socket.local_addr().unwrap().port();

    socket.write_all(request).await.unwrap();

    let mut read = Vec::new();
    let mut chunk = [0_u8; 4_096];

    patience(PATIENCE, async {
        while !read.windows(4).any(|window| window == b"\r\n\r\n") {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => read.extend_from_slice(&chunk[..count]),
            }
        }
    })
    .await
    .expect("a head within patience");

    let text: String = read.iter().map(|byte| char::from(*byte)).collect();
    let head = text.split("\r\n\r\n").next().unwrap_or_default();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|status| status.parse().ok())
        .unwrap_or(0);
    let fields: BTreeMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();

    RawAnswer {
        refusal: fields.get(REFUSAL_HEADER).cloned(),
        status,
        fields,
        local_port,
    }
}

/// A socket of the test's own on `port`, what it reads read by a reader of one response.
pub(crate) struct RawSocket {
    pub(crate) socket: TcpStream,
    pub(crate) reader: ResponseReader,
    pub(crate) is_closed: bool,
}

impl RawSocket {
    /// A socket on `port`.
    pub(crate) async fn on(port: u16) -> Self {
        Self {
            socket: TcpStream::connect((HOST, port)).await.unwrap(),
            reader: ResponseReader::new(),
            is_closed: false,
        }
    }

    /// A socket on `port` whose own buffer takes 4 KiB at most, so what it does not read stays
    /// with its server.
    pub(crate) async fn reading_little(port: u16) -> Self {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();

        socket.set_recv_buffer_size(4_096).unwrap();

        Self {
            socket: socket
                .connect(SocketAddr::from(([127, 0, 0, 1], port)))
                .await
                .unwrap(),
            reader: ResponseReader::new(),
            is_closed: false,
        }
    }

    /// Ends its socket with a reset, as a client gone at once does.
    pub(crate) fn reset(self) {
        socket2::SockRef::from(&self.socket)
            .set_linger(Some(Duration::ZERO))
            .unwrap();
    }

    /// Writes `bytes`, whatever the server made of what came before.
    pub(crate) async fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.socket.write_all(bytes).await
    }

    /// Reads what comes within `within`, until its response's head, or its socket's end.
    pub(crate) async fn head(&mut self, within: Duration) -> Option<ResponseHead> {
        let mut chunk = [0_u8; 4_096];

        patience(within, async {
            while self.reader.head().is_none() && !self.is_closed {
                match self.socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        self.is_closed = true;
                        self.reader.end();
                    }
                    Ok(count) => self.reader.feed(&chunk[..count]),
                }
            }
        })
        .await
        .ok();

        self.reader.head().cloned()
    }

    /// Reads on until its socket ends, within `within`: whether it ended.
    pub(crate) async fn ended(&mut self, within: Duration) -> bool {
        let mut chunk = [0_u8; 4_096];

        patience(within, async {
            while !self.is_closed {
                match self.socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        self.is_closed = true;
                        self.reader.end();
                    }
                    Ok(count) => self.reader.feed(&chunk[..count]),
                }
            }
        })
        .await
        .ok();

        self.is_closed
    }

    /// Its response, once whole within `within`.
    pub(crate) async fn response(&mut self, within: Duration) -> Option<Response> {
        let mut chunk = [0_u8; 4_096];

        patience(within, async {
            while self.reader.response().is_none() && !self.is_closed {
                match self.socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        self.is_closed = true;
                        self.reader.end();
                    }
                    Ok(count) => self.reader.feed(&chunk[..count]),
                }
            }
        })
        .await
        .ok();

        self.reader.response().cloned()
    }

    /// Reads a next response on the same socket, the one before read whole.
    pub(crate) fn next(&mut self) {
        let rest = self.reader.take_rest();

        self.reader = ResponseReader::new();
        self.reader.feed(&rest);
    }
}

/// A `POST`'s head on a connection, declaring `length` bytes of body.
pub(crate) fn post_head_of(port: u16, (token, length): (&str, usize)) -> String {
    head_of(
        ("POST", "/bead"),
        (
            port,
            &[
                &format!("Content-Type: {BEAD_MEDIA_TYPE}"),
                &format!("{CONNECTION_TOKEN_HEADER}: {token}"),
                &format!("Content-Length: {length}"),
            ],
        ),
    )
}

/// A `POST`'s head on a connection, its body in chunks.
pub(crate) fn chunked_head_of(port: u16, token: &str) -> String {
    head_of(
        ("POST", "/bead"),
        (
            port,
            &[
                &format!("Content-Type: {BEAD_MEDIA_TYPE}"),
                &format!("{CONNECTION_TOKEN_HEADER}: {token}"),
                "Transfer-Encoding: chunked",
            ],
        ),
    )
}

/// `bytes` as one chunk (RFC 9112 §7.1).
pub(crate) fn chunk_of(bytes: &[u8]) -> Vec<u8> {
    let mut chunk = format!("{:x}\r\n", bytes.len()).into_bytes();

    chunk.extend_from_slice(bytes);
    chunk.extend_from_slice(b"\r\n");
    chunk
}

/// What a server counts of `name` right now.
pub(crate) fn gauge(server: &HttpTransportServer, name: &str) -> u64 {
    server
        .gauges()
        .and_then(|gauges| gauges.counts.get(name).copied())
        .unwrap_or(0)
}

/// Waits until `holds` holds, within patience.
pub(crate) async fn until<F: Fn() -> bool + Send + Sync>(holds: F) {
    patience(PATIENCE, async {
        while !holds() {
            crate::testing::rest(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("what was waited for, within patience");
}

/// A socket of the test's own whose writing goes on at full speed, a mebibyte at a time, until
/// its socket fails or `limit` bytes went, while what comes is read.
pub(crate) struct Pumped {
    reading: tokio::net::tcp::OwnedReadHalf,
    reader: ResponseReader,
    is_closed: bool,
    pumping: tokio::task::JoinHandle<()>,
}

impl Pumped {
    /// `head` written on a socket on `port`, then bytes at full speed, `limit` at most.
    pub(crate) async fn on(port: u16, (head, limit): (&[u8], usize)) -> Self {
        let socket = TcpStream::connect((HOST, port)).await.unwrap();
        let (reading, mut writing) = socket.into_split();

        writing.write_all(head).await.unwrap();

        let pumping = crate::testing::spawn(async move {
            let chunk = vec![0_u8; 1_048_576];
            let mut sent = 0_usize;

            while sent < limit {
                let piece = &chunk[..chunk.len().min(limit.saturating_sub(sent))];

                if writing.write_all(piece).await.is_err() {
                    return;
                }

                sent = sent.saturating_add(piece.len());
            }

            // the rest held open, as a client still sending holds it
            core::future::pending::<()>().await;
        });

        Self {
            reading,
            reader: ResponseReader::new(),
            is_closed: false,
            pumping,
        }
    }

    async fn read_until<F: Fn(&Self) -> bool + Send + Sync>(
        &mut self,
        (done, within): (F, Duration),
    ) {
        let mut chunk = vec![0_u8; 65_536];

        patience(within, async {
            while !done(self) && !self.is_closed {
                match self.reading.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        self.is_closed = true;
                        self.reader.end();
                    }
                    Ok(count) => self.reader.feed(&chunk[..count]),
                }
            }
        })
        .await
        .ok();
    }

    /// Its response's head, once read within `within`.
    pub(crate) async fn head(&mut self, within: Duration) -> Option<ResponseHead> {
        self.read_until((|pumped: &Self| pumped.reader.head().is_some(), within))
            .await;
        self.reader.head().cloned()
    }

    /// Whether its socket ended within `within`.
    pub(crate) async fn ended(&mut self, within: Duration) -> bool {
        self.read_until((|_: &Self| false, within)).await;
        self.is_closed
    }
}

impl Drop for Pumped {
    fn drop(&mut self) {
        self.pumping.abort();
    }
}

/// A connect whose client says it listens: the handle its server drew, and its token.
pub(crate) async fn connect_listening(started: &Started) -> (ConnectionHandle, String) {
    let response = posted(
        started.port,
        &Post {
            fields: vec!["bead-listen: ?1".to_owned()],
            ..Post::default()
        },
    )
    .await;

    assert_eq!(response.head.status, 201, "a connect drawn");

    let token = response.head.fields[CONNECTION_TOKEN_HEADER].clone();
    let handle = Arc::clone(
        &started
            .server
            .clients()
            .last()
            .expect("the connection drawn")
            .connection_handle,
    );

    (handle, token)
}

/// A listen on `token`'s connection, its `bead-after` and its `bead-wait` as given, each left out
/// where none.
pub(crate) async fn listen_of(
    port: u16,
    (token, (after, wait)): (&str, (Option<&str>, Option<&str>)),
) -> Exchange {
    let token_field = format!("{CONNECTION_TOKEN_HEADER}: {token}");
    let after_field = after.map(|after| format!("bead-after: {after}"));
    let wait_field = wait.map(|wait| format!("bead-wait: {wait}"));
    let fields: Vec<&str> = [
        Some(token_field.as_str()),
        after_field.as_deref(),
        wait_field.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();

    exchange_of(port, head_of(("GET", "/bead"), (port, &fields)).as_bytes()).await
}

/// What a listen brings back of `envelopes`: each after its length in 4 bytes.
pub(crate) fn batch_of(envelopes: &[&[u8]]) -> Vec<u8> {
    envelopes
        .iter()
        .flat_map(|envelope| {
            u32::try_from(envelope.len())
                .unwrap()
                .to_be_bytes()
                .into_iter()
                .chain(envelope.iter().copied())
        })
        .collect()
}
