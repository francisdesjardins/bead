//! The HTTP transport client, the twin of `http-transport-client.test.ts` and
//! `HttpTransportClientTests`: against the transport server, and against a server of the tests'
//! own, the other sides' fake fetch, which answers each exchange octet for octet as its test says.

use core::fmt::Write as _;
use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::SystemTime;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};

use super::*;
use crate::http::peer::{BEARER, HOST, PATIENCE, batch_of, envelope_of, started};
use crate::http::server::HttpTransportServerOptions;
use crate::testing::{SteppingClock, patience, rest, spawn};

mod busy;
mod by_a_name;
mod client;
mod definition;
mod guards;
mod listening;
mod redirects;
mod tls;

/// The token the server of the tests' own draws.
const TOKEN: &str = "TTTTTTTTTTTTTTTTTTTTTT";

/// How long a test waits to say something did not come.
const WHILE: Duration = Duration::from_millis(60);

// ── What a client tells ──────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Told {
    messages: Vec<TransportMessage>,
    closes: Vec<(bool, bool)>,
    errors: Vec<String>,
    reconnects: usize,
    // each error's message and each close, in their order
    events: Vec<String>,
}

#[derive(Default)]
struct Recorder {
    told: Mutex<Told>,
}

impl Recorder {
    fn messages(&self) -> Vec<TransportMessage> {
        locked(&self.told).messages.clone()
    }

    fn heard(&self) -> Vec<Vec<u8>> {
        locked(&self.told)
            .messages
            .iter()
            .map(|message| message.data.to_vec())
            .collect()
    }

    fn closes(&self) -> Vec<(bool, bool)> {
        locked(&self.told).closes.clone()
    }

    fn errors(&self) -> Vec<String> {
        locked(&self.told).errors.clone()
    }

    fn events(&self) -> Vec<String> {
        locked(&self.told).events.clone()
    }

    fn reconnects(&self) -> usize {
        locked(&self.told).reconnects
    }

    /// The closes told, once `count` were.
    async fn closed(&self, count: usize) -> Vec<(bool, bool)> {
        until(|| self.closes().len() >= count).await;

        self.closes()
    }
}

impl ClientListener for Recorder {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.told).messages.push(message);
    }

    fn on_close(&self, was_clean: bool, is_quick: bool) {
        let mut told = locked(&self.told);

        told.closes.push((was_clean, is_quick));
        told.events.push(format!("close {was_clean} {is_quick}"));
        drop(told);
    }

    fn on_reconnect(&self) {
        let mut told = locked(&self.told);

        told.reconnects = told.reconnects.saturating_add(1);
    }

    fn on_error(&self, error: &RouterError) {
        let mut told = locked(&self.told);

        told.errors.push(error.to_string());
        told.events.push(format!("error {error}"));
        drop(told);
    }
}

fn recorded(client: &HttpTransportClient) -> Arc<Recorder> {
    let recorder = Arc::new(Recorder::default());

    client.listen(Arc::<Recorder>::clone(&recorder));

    recorder
}

/// A listener that panics on its first `count` messages, as one that throws, then hears the rest.
struct Throwing {
    count: Mutex<usize>,
}

impl Throwing {
    fn times(count: usize) -> Arc<Self> {
        Arc::new(Self {
            count: Mutex::new(count),
        })
    }
}

impl ClientListener for Throwing {
    fn on_message(&self, _message: TransportMessage) {
        let mut count = locked(&self.count);

        if *count == 0 {
            return;
        }

        *count = count.saturating_sub(1);
        drop(count);
        panic!("a listener that throws");
    }
}

/// Waits until `holds` holds, within patience.
async fn until<F: Fn() -> bool + Send + Sync>(holds: F) {
    patience(PATIENCE, async {
        while !holds() {
            rest(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("what was waited for, within patience");
}

// ── Clients ──────────────────────────────────────────────────────────────────────────────────

fn client_of(options: &HttpTransportClientOptions) -> HttpTransportClient {
    HttpTransportClient::new(options).unwrap()
}

fn not_listening() -> HttpTransportClientOptions {
    HttpTransportClientOptions {
        is_listening: Some(false),
        ..HttpTransportClientOptions::default()
    }
}

fn stepping() -> Arc<SteppingClock> {
    SteppingClock::new(SystemTime::UNIX_EPOCH)
}

// 2026-01-01T00:00:00Z, as the other sides' clocks start where a date is read: 490 896 hours
// after the epoch
fn stepping_from_2026() -> Arc<SteppingClock> {
    SteppingClock::new(
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_hours(490_896))
            .unwrap(),
    )
}

fn on_clock(clock: &Arc<SteppingClock>) -> SharedClock {
    Arc::<SteppingClock>::clone(clock)
}

fn to(port: u16) -> HttpTransportClientConnectOptions {
    HttpTransportClientConnectOptions::new(HOST, port)
}

async fn settled(connecting: Connect) -> Result<(), TransportError> {
    patience(PATIENCE, connecting)
        .await
        .expect("the connect settles within patience")
}

async fn sent(client: &HttpTransportClient, message: TransportMessage) -> Result<(), RouterError> {
    match client.send(message)? {
        Sent::Done => Ok(()),
        Sent::Later(later) => patience(PATIENCE, later)
            .await
            .expect("a send settled within patience"),
    }
}

/// A send under way, its outcome to wait on.
fn sending(
    client: &HttpTransportClient,
    message: TransportMessage,
) -> BoxFuture<Result<(), RouterError>> {
    match client.send(message) {
        Err(refused) => Box::pin(async move { Err(refused) }),
        Ok(Sent::Done) => Box::pin(async { Ok(()) }),
        Ok(Sent::Later(later)) => later,
    }
}

async fn within<T, F: Future<Output = T>>(future: F) -> T {
    patience(PATIENCE, future)
        .await
        .expect("what was waited for, within patience")
}

async fn disconnected(client: &HttpTransportClient, options: &TransportClientDisconnectOptions) {
    within(client.disconnect(options).unwrap()).await;
}

fn quick() -> TransportClientDisconnectOptions {
    TransportClientDisconnectOptions {
        is_quick: Some(true),
        ..TransportClientDisconnectOptions::default()
    }
}

fn envelope(bytes: Vec<u8>) -> TransportMessage {
    TransportMessage {
        data: Bytes::from(bytes),
        ..TransportMessage::default()
    }
}

/// A request of call id `call_id`, as a message.
fn request(call_id: u32) -> TransportMessage {
    envelope(envelope_of(REQUEST, (call_id, 0)))
}

/// A cancel of call id `call_id`, as a message.
fn cancel(call_id: u32) -> TransportMessage {
    envelope(envelope_of(crate::http::fields::CANCEL, (call_id, 0)))
}

/// An envelope the server sends of its own, which a listen brings back.
fn pushed(call_id: u32) -> Vec<u8> {
    envelope_of(0x13, (call_id, 0))
}

// ── A server of the tests' own ───────────────────────────────────────────────────────────────

/// How a scripted answer's body ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Ending {
    /// Whole, its length declared.
    #[default]
    Declared,
    /// Short of its declared length, its socket closed: a body lost on its way.
    Cut,
    /// Its length declared nowhere, its socket's close its end.
    Undeclared,
}

/// What a call is answered: its status, its fields as written, its body and how it comes.
#[derive(Debug, Clone, Default)]
struct Answer {
    status: u16,
    fields: Vec<(String, String)>,
    // its body, written in pieces a rest apart when there are more than one
    pieces: Vec<Vec<u8>>,
    ending: Ending,
    // its head alone, its body written later by its test
    is_later: bool,
}

impl Answer {
    fn of(status: u16) -> Self {
        Self {
            status,
            ..Self::default()
        }
    }

    fn with(mut self, name: &str, value: &str) -> Self {
        self.fields.push((name.to_owned(), value.to_owned()));
        self
    }

    fn carrying(mut self, body: &[u8]) -> Self {
        self.pieces = vec![body.to_vec()];
        self
    }

    fn in_pieces(mut self, pieces: Vec<Vec<u8>>) -> Self {
        self.pieces = pieces;
        self
    }

    fn ending(mut self, ending: Ending) -> Self {
        self.ending = ending;
        self
    }

    fn later(mut self) -> Self {
        self.is_later = true;
        self
    }

    fn length(&self) -> usize {
        self.pieces.iter().map(Vec::len).sum()
    }

    // its head, `connection: close` its last field: the socket goes with the answer
    fn head(&self) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {} Scripted\r\n", self.status);
        let is_declared = self
            .fields
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-length"));
        let is_bodiless = matches!(self.status, 100..=199 | 204 | 304);

        for (name, value) in &self.fields {
            write!(head, "{name}: {value}\r\n").ok();
        }

        if !is_declared && !is_bodiless {
            match self.ending {
                Ending::Declared => {
                    write!(head, "content-length: {}\r\n", self.length()).ok();
                }
                Ending::Cut => {
                    write!(
                        head,
                        "content-length: {}\r\n",
                        self.length().saturating_add(1)
                    )
                    .ok();
                }
                Ending::Undeclared => {}
            }
        }

        head.push_str("connection: close\r\n\r\n");
        head.into_bytes()
    }
}

/// The 201 that draws a connection, its listen said back when `is_listening`.
fn drawn(is_listening: bool) -> Answer {
    let answer = Answer::of(201).with(CONNECTION_TOKEN_HEADER, TOKEN);

    if is_listening {
        answer.with(LISTEN_HEADER, "?1")
    } else {
        answer
    }
}

/// A 200 of the transport's type carrying `body`.
fn bead(body: &[u8]) -> Answer {
    Answer::of(200)
        .with("content-type", BEAD_MEDIA_TYPE)
        .carrying(body)
}

/// A batch of `envelopes`, the first numbered `first`.
fn batch(first: u64, envelopes: &[&[u8]]) -> Answer {
    Answer::of(200)
        .with("content-type", BEAD_BATCH_MEDIA_TYPE)
        .with(SEQUENCE_HEADER, &first.to_string())
        .carrying(&batch_of(envelopes))
}

/// A refusal of the transport's own, `status` marked `mark`.
fn refusal(status: u16, mark: &str) -> Answer {
    Answer::of(status).with(REFUSAL_HEADER, mark)
}

// what the socket of a call is told to do next
#[derive(Debug)]
enum Piece {
    Write(Vec<u8>),
    Rest(Duration),
    // its socket closed once what came before was written
    End,
    // its socket reset, as a network that failed
    Reset,
}

// what a call's socket meets next: a piece its test told, or what its client wrote, none at its end
enum Next {
    Piece(Option<Piece>),
    Read(usize),
}

/// One exchange a client made, as the server of the tests' own read it, answered as its test says.
struct Call {
    method: String,
    target: String,
    fields: BTreeMap<String, String>,
    body: Vec<u8>,
    socket: mpsc::UnboundedSender<Piece>,
    // its client let go of its socket before its answer was whole
    aborted: CancellationToken,
}

impl Call {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }

    fn tell(&self, piece: Piece) {
        self.socket.send(piece).ok();
    }

    /// Answers it as `answer` says.
    fn answer(&self, answer: &Answer) {
        self.tell(Piece::Write(answer.head()));

        if answer.is_later {
            return;
        }

        let is_paced = answer.pieces.len() > 1;

        for piece in &answer.pieces {
            self.tell(Piece::Write(piece.clone()));

            if is_paced {
                self.tell(Piece::Rest(Duration::from_millis(2)));
            }
        }

        self.tell(Piece::End);
    }

    /// Writes `bytes` of an answer whose head went alone.
    fn write(&self, bytes: &[u8]) {
        self.tell(Piece::Write(bytes.to_vec()));
    }

    /// Closes its socket, its answer written.
    fn end(&self) {
        self.tell(Piece::End);
    }

    /// Fails it, as a network that failed: its socket reset, nothing answered.
    fn fail(&self) {
        self.tell(Piece::Reset);
    }

    /// Whether its client let go of it, within patience.
    async fn is_aborted(&self) -> bool {
        patience(PATIENCE, self.aborted.cancelled()).await.is_ok()
    }
}

/// What answers each call at once, or fails it with none.
type Responder = Arc<dyn Fn(&Call) -> Option<Answer> + Send + Sync>;

/// How the server of the tests' own answers.
#[derive(Clone, Default)]
struct ScriptOptions {
    /// Answers each call at once: none leaves each to its test.
    responder: Option<Responder>,
    /// A `DELETE` waits for its test, as any other call: one is answered 204 at once otherwise.
    is_delete_held: bool,
    /// The address it listens on: the IPv4 loopback when none.
    address: Option<&'static str>,
    /// The TLS it speaks, under `https`: none speaks in the clear.
    tls: Option<Arc<rustls::ServerConfig>>,
}

// a socket the server of the tests' own answers on, in clear or under TLS
trait Wire: AsyncRead + AsyncWrite + Unpin + Send + 'static {
    // ends it at once, as a network that failed
    fn reset(self);
}

impl Wire for TcpStream {
    fn reset(self) {
        socket2::SockRef::from(&self)
            .set_linger(Some(Duration::ZERO))
            .ok();
    }
}

impl Wire for tokio_rustls::server::TlsStream<TcpStream> {
    fn reset(self) {
        self.into_inner().0.reset();
    }
}

struct Script {
    calls: Mutex<Vec<Arc<Call>>>,
    made: Notify,
    options: ScriptOptions,
}

/// The server of the tests' own, on the loopback: each call it took, in order, each on a socket
/// of its own.
struct Fake {
    port: u16,
    script: Arc<Script>,
    stop: CancellationToken,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Fake {
    async fn call_of(&self, index: usize) -> Arc<Call> {
        within(async {
            loop {
                let made = self.script.made.notified();
                let mut made = pin!(made);

                made.as_mut().enable();

                if let Some(call) = locked(&self.script.calls).get(index) {
                    return Arc::clone(call);
                }

                made.await;
            }
        })
        .await
    }

    /// Whether no call of rank `index` was made within a while.
    async fn makes_no_call_of(&self, index: usize) -> bool {
        rest(WHILE).await;

        self.count() <= index
    }

    fn calls(&self) -> Vec<Arc<Call>> {
        locked(&self.script.calls).clone()
    }

    fn count(&self) -> usize {
        locked(&self.script.calls).len()
    }

    fn methods(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call.method.clone())
            .collect()
    }

    fn listens(&self) -> usize {
        self.calls()
            .iter()
            .filter(|call| call.method == "GET")
            .count()
    }
}

async fn fake() -> Fake {
    fake_of(&ScriptOptions::default()).await
}

async fn fake_of(options: &ScriptOptions) -> Fake {
    let listener = TcpListener::bind((options.address.unwrap_or(HOST), 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = Arc::new(Script {
        calls: Mutex::default(),
        made: Notify::new(),
        options: options.clone(),
    });
    let stop = CancellationToken::new();
    let (taking, ending) = (Arc::clone(&script), stop.clone());

    drop(spawn(async move {
        while let Some(Ok((socket, _))) = unless_ended(&ending, listener.accept()).await {
            let (script, stop) = (Arc::clone(&taking), ending.clone());

            drop(spawn(async move {
                match script.options.tls.clone() {
                    None => Box::pin(serving(socket, (script, stop))).await,
                    Some(config) => {
                        let accepting = tokio_rustls::TlsAcceptor::from(config).accept(socket);

                        if let Some(Ok(secured)) = unless_ended(&stop, accepting).await {
                            Box::pin(serving(secured, (script, stop))).await;
                        }
                    }
                }
            }));
        }
    }));

    Fake { port, script, stop }
}

// a request's head and body, read whole
async fn request_of<S: Wire>(socket: &mut S) -> Option<(Vec<u8>, usize)> {
    let mut read = Vec::new();
    let mut chunk = [0_u8; 4_096];

    loop {
        if let Some(end) = read.windows(4).position(|window| window == b"\r\n\r\n") {
            return Some((read, end.saturating_add(4)));
        }

        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(count) => read.extend_from_slice(&chunk[..count]),
        }
    }
}

// one socket of a client's: its one request read, its call made, then answered as its test says
async fn serving<S: Wire>(mut socket: S, (script, stop): (Arc<Script>, CancellationToken)) {
    let Some(Some((mut read, head_length))) = unless_ended(&stop, request_of(&mut socket)).await
    else {
        return;
    };
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);

    parsed.parse(&read).unwrap();

    let method = parsed.method.unwrap_or_default().to_owned();
    let target = parsed.path.unwrap_or_default().to_owned();
    let fields: BTreeMap<String, String> = parsed
        .headers
        .iter()
        .map(|header| {
            (
                header.name.to_ascii_lowercase(),
                String::from_utf8_lossy(header.value).into_owned(),
            )
        })
        .collect();
    let length: usize = fields
        .get("content-length")
        .and_then(|length| length.parse().ok())
        .unwrap_or(0);
    let mut chunk = [0_u8; 4_096];

    while read.len() < head_length.saturating_add(length) {
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(count) => read.extend_from_slice(&chunk[..count]),
        }
    }

    let body = read[head_length..head_length.saturating_add(length)].to_vec();
    let (writing, mut pieces) = mpsc::unbounded_channel();
    let call = Arc::new(Call {
        method,
        target,
        fields,
        body,
        socket: writing,
        aborted: CancellationToken::new(),
    });

    locked(&script.calls).push(Arc::clone(&call));
    script.made.notify_waiters();

    if let Some(responder) = &script.options.responder {
        match responder(&call) {
            Some(answer) => call.answer(&answer),
            None => call.fail(),
        }
    } else if call.method == "DELETE" && !script.options.is_delete_held {
        call.answer(&Answer::of(204));
    }

    let mut is_read_ended = false;

    loop {
        let next = {
            let mut piece = pin!(pieces.recv());
            let mut reading = pin!(socket.read(&mut chunk));

            unless_ended(
                &stop,
                poll_fn(|context| {
                    if let Poll::Ready(piece) = piece.as_mut().poll(context) {
                        return Poll::Ready(Next::Piece(piece));
                    }

                    if !is_read_ended && let Poll::Ready(read) = reading.as_mut().poll(context) {
                        return Poll::Ready(Next::Read(read.unwrap_or(0)));
                    }

                    Poll::Pending
                }),
            )
            .await
        };

        match next {
            None | Some(Next::Piece(None | Some(Piece::End))) => {
                socket.shutdown().await.ok();

                return;
            }
            Some(Next::Piece(Some(Piece::Reset))) => {
                socket.reset();

                return;
            }
            Some(Next::Piece(Some(Piece::Write(bytes)))) => {
                if socket.write_all(&bytes).await.is_ok() {
                    socket.flush().await.ok();
                }
            }
            Some(Next::Piece(Some(Piece::Rest(duration)))) => rest(duration).await,
            // its client let go of it: what is still written goes nowhere
            Some(Next::Read(0)) => {
                is_read_ended = true;
                call.aborted.cancel();
            }
            Some(Next::Read(_)) => {}
        }
    }
}

// ── Clients on it ────────────────────────────────────────────────────────────────────────────

/// A client on the server of the tests' own, connected: its first call drew the connection.
struct Faked {
    client: HttpTransportClient,
    fake: Fake,
    told: Arc<Recorder>,
}

impl Drop for Faked {
    fn drop(&mut self) {
        self.client.dispose();
    }
}

/// A client of `options` connected to `fake`, its connection drawn by its first call, which `fake`
/// answers itself when it has a responder; its listen said back as it asked.
async fn connected(fake: Fake, options: &HttpTransportClientOptions) -> Faked {
    let client = client_of(options);
    let told = recorded(&client);
    let connecting = client.connect(&to(fake.port));

    if fake.script.options.responder.is_none() {
        fake.call_of(0)
            .await
            .answer(&drawn(options.is_listening.unwrap_or(true)));
    }

    settled(connecting).await.unwrap();

    Faked { client, fake, told }
}

/// A client that listens on a server of the tests' own, connected.
async fn connected_listening(options: &HttpTransportClientOptions) -> Faked {
    connected(
        fake().await,
        &HttpTransportClientOptions {
            is_listening: Some(true),
            ..options.clone()
        },
    )
    .await
}

/// A responder whose first `lost` listens are lost, and any after told their connection is gone:
/// it draws a listening connection, and takes its `DELETE`.
fn losing(lost: usize) -> ScriptOptions {
    let listens = AtomicUsize::new(0);

    ScriptOptions {
        responder: Some(Arc::new(move |call: &Call| match call.method.as_str() {
            "GET" => (listens.fetch_add(1, Ordering::SeqCst) >= lost)
                .then(|| refusal(404, HTTP_REFUSALS.connection_unknown)),
            "POST" => Some(drawn(true)),
            _ => Some(Answer::of(204)),
        })),
        ..ScriptOptions::default()
    }
}
