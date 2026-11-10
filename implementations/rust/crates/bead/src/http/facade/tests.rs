//! The HTTP server and client an application starts from, end to end over the loopback: what each
//! builds, the bounds it gives its transport, and its layers together — sessions, calls in flight,
//! cancels, subscriptions, commands and relays — and against a server of the tests' own that
//! answers as each test scripts it.

mod client;
mod server;

use core::fmt::Write as _;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::{HttpClient, HttpClientOptions, HttpServer, HttpServerOptions};
use crate::constants::ProcedureKind;
use crate::errors::CallError;
use crate::http::client::{HttpTransportClientConnectOptions, HttpTransportClientOptions};
use crate::identity::Procedure;
use crate::managers::service::{
    RequestDependencies, RequestOptions, RequestResolverDependencies, ServiceCall,
};
use crate::payloads::TextCodec;
use crate::server::HealthStatus;
use crate::testing::{patience, rest};
use crate::transport::TransportServerStartOptions;

const PATIENCE: Duration = Duration::from_secs(10);

// what a registration keeps on purpose, whether its connection stands or not
const KEPT: [&str; 2] = ["closedDestinations", "destinations"];

const HOST: &str = "127.0.0.1";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn procedure(id: u16, (name, kind): (&str, Option<ProcedureKind>)) -> Procedure {
    Procedure {
        service_id: 1,
        procedure_id: id,
        procedure_name: name.to_owned(),
        service_revision: 1,
        procedure_kind: kind,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn open_session() -> Procedure {
    procedure(1, ("openSession", Some(ProcedureKind::Request)))
}

fn read() -> Procedure {
    procedure(2, ("read", Some(ProcedureKind::Request)))
}

fn upload() -> Procedure {
    procedure(3, ("upload", Some(ProcedureKind::Request)))
}

fn slow() -> Procedure {
    procedure(4, ("slow", Some(ProcedureKind::Request)))
}

fn news() -> Procedure {
    procedure(5, ("news", Some(ProcedureKind::Notifies)))
}

fn ping() -> Procedure {
    procedure(6, ("ping", Some(ProcedureKind::Command)))
}

fn echo() -> Procedure {
    // no kind: a request to a server, a command to a client the server relays it to
    procedure(7, ("echo", None))
}

fn text() -> RequestResolverDependencies<TextCodec, TextCodec> {
    RequestResolverDependencies::new(TextCodec, TextCodec)
}

fn asked() -> RequestDependencies<TextCodec, TextCodec> {
    RequestDependencies::new(TextCodec, TextCodec)
}

// whether it comes to hold within the patience, asked again and again
async fn eventually<F: FnMut() -> bool>(mut holds: F) -> bool {
    let started = crate::testing::Instant::now();

    while !holds() {
        if started.elapsed() > PATIENCE {
            return false;
        }

        rest(Duration::from_millis(10)).await;
    }

    true
}

// a call's outcome, within `within`
async fn outcome_of<T>(call: ServiceCall<T>, within: Duration) -> Result<T, CallError> {
    patience(within, call).await.expect("settled in time")
}

// a request of `value` to `procedure` through `client`'s services, its outcome
async fn ask(
    client: &HttpClient,
    (procedure, value): (&Procedure, &str),
    options: &RequestOptions,
) -> Result<String, CallError> {
    let call = client
        .services()
        .get_request(procedure, asked())
        .expect("a requester")
        .call(value.to_owned(), options)
        .expect("a call");

    outcome_of(call, PATIENCE).await
}

fn loopback() -> TransportServerStartOptions {
    TransportServerStartOptions {
        address: Some(HOST.to_owned()),
        find_open_port: Some(true),
        ..TransportServerStartOptions::default()
    }
}

// starts `server` on the IPv4 loopback, and gives its port
async fn port_of(server: &HttpServer) -> u16 {
    patience(PATIENCE, server.transport().start(&loopback()))
        .await
        .expect("started in time")
        .expect("started")
        .port
}

fn to(port: u16) -> HttpTransportClientConnectOptions {
    HttpTransportClientConnectOptions::new(HOST, port)
}

async fn connect(client: &HttpClient, port: u16) {
    patience(PATIENCE, client.connect(&to(port)))
        .await
        .expect("connected in time")
        .expect("connected");
}

// a client whose transport listens or not, under `limits`
fn client_of(
    (is_listening, limits): (bool, Option<crate::router::types::RouterLimitsOptions>),
) -> HttpClient {
    HttpClient::new(&HttpClientOptions {
        client: Some(crate::client::ClientOptions {
            limits,
            ..crate::client::ClientOptions::default()
        }),
        transport: Some(HttpTransportClientOptions {
            is_listening: Some(is_listening),
            ..HttpTransportClientOptions::default()
        }),
    })
    .expect("a client")
}

// what each layer still keeps, each as `layer:count value`, a registration's destinations aside
async fn kept_of(server: &HttpServer) -> Vec<String> {
    let gauges = server.gauges().await.expect("its gauges");

    [
        ("router", gauges.router),
        ("server", gauges.server),
        ("sessions", gauges.sessions),
        ("transport", gauges.transport),
    ]
    .into_iter()
    .flat_map(|(layer, gauges)| {
        gauges
            .counts
            .into_iter()
            .filter(|(name, count)| *count != 0 && !KEPT.contains(name))
            .map(move |(name, count)| format!("{layer}:{name} {count}"))
    })
    .collect()
}

// waits until each layer keeps nothing, then expects its health to pass: a leak fails it
async fn at_rest(server: &HttpServer) {
    let started = crate::testing::Instant::now();

    while !kept_of(server).await.is_empty() && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(10)).await;
    }

    assert_eq!(kept_of(server).await, Vec::<String>::new(), "nothing kept");
    assert_eq!(
        server.health().await.expect("its health").status,
        HealthStatus::Pass,
        "its health"
    );
}

// ── A server of the tests' own ─────────────────────────────────────────────────────────────────

// a request it read: its request line, its fields' lines and its body
#[derive(Debug, Clone)]
struct Heard {
    line: String,
    fields: Vec<String>,
    body: Vec<u8>,
}

impl Heard {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields.iter().find_map(|line| {
            let (field, value) = line.split_once(':')?;

            field
                .trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim())
        })
    }
}

// what it does with a request: answers it, its bytes whole, or loses it, its socket closed with
// nothing written
enum Scripted {
    Answer(Vec<u8>),
    Lose,
}

// an answer of `status`, its fields as given, its body, `connection: close` its last field
fn answer_of(status: u16, (fields, body): (&[(&str, &str)], &[u8])) -> Scripted {
    let mut head = format!("HTTP/1.1 {status} Scripted\r\n");

    for (name, value) in fields {
        write!(head, "{name}: {value}\r\n").ok();
    }

    if !matches!(status, 204 | 304) {
        write!(head, "content-length: {}\r\n", body.len()).ok();
    }

    head.push_str("connection: close\r\n\r\n");

    let mut bytes = head.into_bytes();

    bytes.extend_from_slice(body);

    Scripted::Answer(bytes)
}

// the 201 that draws a connection
fn drawn() -> Scripted {
    answer_of(
        201,
        (
            &[(
                crate::http::fields::CONNECTION_TOKEN_HEADER,
                "TTTTTTTTTTTTTTTTTTTTTQ",
            )],
            &[],
        ),
    )
}

type Answering = Arc<dyn Fn(&Heard, usize) -> Scripted + Send + Sync>;

// the server of the tests' own on the loopback: each request it read, in order, answered as
// `answering` says of it and of its rank, each socket closed behind its answer
struct Script {
    port: u16,
    heard: Arc<Mutex<Vec<Heard>>>,
    stop: CancellationToken,
}

impl Drop for Script {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Script {
    fn heard(&self) -> Vec<Heard> {
        locked(&self.heard).clone()
    }
}

// a request read whole from `socket`, its body by its content-length, or none at its end
async fn request_of(socket: &mut tokio::net::TcpStream) -> Option<Heard> {
    let mut read = Vec::new();
    let mut buffer = [0_u8; 4_096];
    let end = loop {
        if let Some(end) = read.windows(4).position(|four| four == b"\r\n\r\n") {
            break end;
        }

        let count = socket.read(&mut buffer).await.ok()?;

        if count == 0 {
            return None;
        }

        read.extend_from_slice(buffer.get(..count)?);
    };
    let head = String::from_utf8_lossy(read.get(..end)?).into_owned();
    let mut lines = head.split("\r\n").map(str::to_owned);
    let line = lines.next()?;
    let fields: Vec<String> = lines.collect();
    let mut request = Heard {
        line,
        fields,
        body: read.get(end.saturating_add(4)..)?.to_vec(),
    };
    let length: usize = request
        .field("content-length")
        .and_then(|length| length.parse().ok())
        .unwrap_or(0);

    while request.body.len() < length {
        let count = socket.read(&mut buffer).await.ok()?;

        if count == 0 {
            return None;
        }

        request.body.extend_from_slice(buffer.get(..count)?);
    }

    Some(request)
}

async fn scripted(answering: Answering) -> Script {
    let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
    let port = listener.local_addr().expect("its address").port();
    let heard: Arc<Mutex<Vec<Heard>>> = Arc::default();
    let stop = CancellationToken::new();
    let keeping = Arc::clone(&heard);
    let stopped = stop.clone();

    drop(crate::testing::spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = stopped.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            let Ok((mut socket, _)) = accepted else {
                return;
            };
            let keeping = Arc::clone(&keeping);
            let answering = Arc::clone(&answering);

            drop(crate::testing::spawn(async move {
                let Some(request) = request_of(&mut socket).await else {
                    return;
                };
                let rank = {
                    let mut kept = locked(&keeping);

                    kept.push(request.clone());
                    kept.len().saturating_sub(1)
                };

                if let Scripted::Answer(bytes) = answering(&request, rank) {
                    socket.write_all(&bytes).await.ok();
                    socket.shutdown().await.ok();
                }
            }));
        }
    }));

    Script { port, heard, stop }
}

// a request's call id and payload, read as a server reads it
fn request_in(body: &[u8]) -> Option<(u32, Bytes)> {
    match crate::envelope::read_envelope(
        &Bytes::copy_from_slice(body),
        crate::constants::RouterSide::Server,
        &crate::envelope::ReadEnvelopeOptions::default(),
    ) {
        Ok(Some(crate::envelope::Envelope::Request { header, payload })) => {
            Some((header.call_id, payload))
        }
        _ => None,
    }
}

// a result of `payload` to `call_id`, written
fn result_of(call_id: u32, payload: &[u8]) -> Vec<u8> {
    crate::envelope::write_envelope(
        &crate::envelope::Envelope::Result {
            header: crate::envelope::ResultHeader {
                call_id,
                total: None,
                credential: None,
            },
            payload: Bytes::copy_from_slice(payload),
        },
        1_024,
    )
    .expect("written")
    .to_vec()
}
