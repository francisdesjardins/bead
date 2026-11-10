//! Bead's Rust client against each side's server of the interop service, the TypeScript one, the
//! C# one and the Rust one, over WebSocket and over HTTP: the same procedures, failures and cancel,
//! a command the server asks, subscriptions, sessions and credentials. A trial a case, a transport
//! and a server, named by the TypeScript side's sentence in snake case; HTTP carries no transfer, so
//! the case of a transfer is WebSocket's alone.
//!
//! The trials run where `BEAD_INTEROP_RUST=1` asks, and are ignored otherwise, a trial saying so: the
//! TypeScript server starts by `node interop/serve.ts`, which its installed side bundles, the C#
//! server by `dotnet run --project interop/Bead.Interop.Server`, the Rust server from the binary
//! `BEAD_INTEROP_RUST_SERVER` names, else the one this package builds. Asked and unable to start a
//! server, its trials fail. The repository is `BEAD_INTEROP_ROOT`, else the directory above the
//! current one that holds `implementations/` and `spec/spec.md`. Each server is started once, at
//! its first trial, and stopped once every trial ran; the trials run one at a time unless
//! `--test-threads` says otherwise, as the other sides' run theirs, two on one server sharing its
//! relay's destinations.

#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a native target: each server's output read on a thread of std's, and its start and its stop waited for on std's instant"
)]

use core::time::Duration;
use std::collections::BTreeMap;
use std::error::Error;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Instant, UNIX_EPOCH};

use bead::testing::{patience, rest, wall_now};
use bead::{
    CallError, Client, ClientListener, ClientOptions, CodecRefusal, Failure, FailureOrigin,
    FailureScope, HttpTransportClient, HttpTransportClientConnectOptions,
    HttpTransportClientOptions, JsonCodec, NotificationCallback, NotificationDependencies,
    PayloadCodec, Procedure, ProtocolCode, RawCodec, ReadyState, RegistrationOptions,
    RequestCredential, RequestDependencies, RequestOptions, RouterClientTransport, RouterError,
    RouterSide, Sent, SharedClock, TransportMessage, WebSocketClient, WebSocketClientOptions,
    WebSocketTransportClientConnectOptions,
};
use bead_interop::{
    INTEROP_SERVICE, InteropDescriptor, InteropProcedures, interop_procedures, offer_interop_client,
};
use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use libtest_mimic::{Arguments, Failed, Trial};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

// how long a step waits for what it awaits
const PATIENCE: Duration = Duration::from_secs(10);

// how long a server is given to say its ports, a first `dotnet run` building it, before it is
// killed
const STARTING: Duration = Duration::from_secs(180);

// how long a server is given to end once its input closed, before it is killed
const ENDING: Duration = Duration::from_secs(10);

const HOST: &str = "127.0.0.1";

// a slow call that answers within the hour: one cancelled long before
const SLOW_MILLISECONDS: u64 = 3_600_000;

// three mebibytes, past one envelope: a transfer each way
const TRANSFERRED: usize = 3 * 1_048_576;

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SKIPPED: &str = "the interop against each side's server is skipped: BEAD_INTEROP_RUST=1 asks for it, which starts the TypeScript server with Node, the C# one with .NET and the Rust one";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hold<F: FnOnce() -> String>(is_held: bool, said: F) -> Result<(), String> {
    if is_held { Ok(()) } else { Err(said()) }
}

fn equal<T: PartialEq + core::fmt::Debug>(found: &T, expected: &T) -> Result<(), String> {
    hold(found == expected, || {
        format!("expected {expected:?}, found {found:?}")
    })
}

// ── The servers ──────────────────────────────────────────────────────────────────────────────────

// a side whose interop server the client calls
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    TypeScript,
    CSharp,
    Rust,
}

impl Side {
    const ALL: [Self; 3] = [Self::TypeScript, Self::CSharp, Self::Rust];

    const fn name(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::CSharp => "csharp",
            Self::Rust => "rust",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::TypeScript => "the TypeScript server",
            Self::CSharp => "the C# server",
            Self::Rust => "the Rust server",
        }
    }

    // how it starts: the command the other sides' interop tests run, from its side's folder
    fn command(self) -> Result<Command, String> {
        let root = root()?;
        let mut command = match self {
            Self::TypeScript => {
                let mut command = Command::new("node");

                command
                    .arg("interop/serve.ts")
                    .current_dir(root.join("implementations").join("typescript"));

                command
            }
            Self::CSharp => {
                let mut command = Command::new("dotnet");

                command
                    .args(["run", "--project", "interop/Bead.Interop.Server"])
                    .current_dir(root.join("implementations").join("dotnet"));

                command
            }
            Self::Rust => Command::new(std::env::var_os("BEAD_INTEROP_RUST_SERVER").map_or_else(
                || PathBuf::from(env!("CARGO_BIN_EXE_bead-interop-server")),
                PathBuf::from,
            )),
        };

        // ! over a broker, each side's server links as its participant of its own: one started
        // here would take over the one another run links, so none links
        command
            .env_remove("BEAD_MQTT_URL")
            .env_remove("BEAD_AMQP_URL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        Ok(command)
    }
}

// where a server listens, over WebSocket and over HTTP
#[derive(Debug, Clone, Copy)]
struct Ports {
    port: u16,
    http_port: u16,
}

// each server, once its first trial started it, and the processes to stop at the end
static STARTED: Mutex<BTreeMap<Side, Result<Ports, String>>> = Mutex::new(BTreeMap::new());
static RUNNING: Mutex<Vec<Child>> = Mutex::new(Vec::new());

// the repository: `BEAD_INTEROP_ROOT`, else the directory above the current one that holds
// `implementations/` and `spec/spec.md`, never where this test was built, which CI runs elsewhere
fn root() -> Result<PathBuf, String> {
    if let Some(given) = std::env::var_os("BEAD_INTEROP_ROOT") {
        return Ok(PathBuf::from(given));
    }

    let current =
        std::env::current_dir().map_err(|error| format!("no current directory: {error}"))?;

    current
        .ancestors()
        .find(|directory| {
            directory.join("implementations").is_dir()
                && directory.join("spec").join("spec.md").is_file()
        })
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            format!(
                "no repository above {}: BEAD_INTEROP_ROOT names it",
                current.display()
            )
        })
}

// the ports a line of a server says it listens on, `{"port":n,"httpPort":m,…}`; none for any
// other line, a build's among them
fn ports_of_line(line: &str) -> Option<Ports> {
    let said: Value = serde_json::from_str(line).ok()?;
    let port_of = |name: &str| {
        said.get(name)
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
    };

    Some(Ports {
        port: port_of("port")?,
        http_port: port_of("httpPort")?,
    })
}

// `side`'s server, started, and the ports it says it listens on: what comes before, a build's
// lines, is passed over
fn start(side: Side) -> Result<Ports, String> {
    let label = side.label();
    let mut child = side
        .command()?
        .spawn()
        .map_err(|error| format!("{label} did not start: {error}"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label} has no output"))?;
    let (said, heard) = mpsc::channel();

    // * its output read to its end on a thread of its own, its ports sent once said: a server that
    // never says them is killed past its patience, and one that writes on never fills its pipe
    drop(std::thread::spawn(move || {
        let mut is_said = false;

        for line in BufReader::new(output).lines() {
            let Ok(line) = line else {
                break;
            };

            if !is_said && let Some(ports) = ports_of_line(line.trim()) {
                is_said = true;
                said.send(ports).ok();
            }
        }
    }));

    match heard.recv_timeout(STARTING) {
        Ok(ports) => {
            locked(&RUNNING).push(child);

            Ok(ports)
        }
        Err(RecvTimeoutError::Timeout) => {
            child.kill().ok();
            child.wait().ok();

            Err(format!("{label} did not say its ports within {STARTING:?}"))
        }
        Err(RecvTimeoutError::Disconnected) => {
            let ended = child.wait().map_err(|error| error.to_string());

            Err(format!("{label} ended before it said its ports: {ended:?}"))
        }
    }
}

// `side`'s server's ports, started at its first trial; asked and unable to start, every trial of
// it fails, saying why
fn ports_of(side: Side) -> Result<Ports, String> {
    let mut started = locked(&STARTED);
    let ports = started.entry(side).or_insert_with(|| start(side)).clone();

    drop(started);

    ports
}

// every server let go of its input, as whoever started it does, waited for, then killed past its
// patience
fn stop_every_server() {
    let running: Vec<Child> = locked(&RUNNING).drain(..).collect();

    for mut child in running {
        drop(child.stdin.take());

        let since = Instant::now();

        while matches!(child.try_wait(), Ok(None)) && since.elapsed() < ENDING {
            std::thread::sleep(Duration::from_millis(50));
        }

        if matches!(child.try_wait(), Ok(None)) {
            child.kill().ok();
            child.wait().ok();
        }
    }
}

// ── A client ─────────────────────────────────────────────────────────────────────────────────────

// a transport a server is called over
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Over {
    WebSocket,
    Http,
}

impl Over {
    const ALL: [Self; 2] = [Self::WebSocket, Self::Http];

    const fn name(self) -> &'static str {
        match self {
            Self::WebSocket => "websocket",
            Self::Http => "http",
        }
    }
}

/// What an HTTP client's envelopes go through: one goes only once the server said it had the one
/// before, its answer's head come back (spec 15.7), as a socket keeps them in order, so a cancel
/// never overtakes its request, which the server would bury unseen; as the other sides' interop
/// tests order theirs, by a fetch and by a handler.
#[derive(Debug)]
struct InOrder {
    inner: Arc<HttpTransportClient>,
    // settled once the envelope handed on last is: the turn of the next
    last: Mutex<Option<oneshot::Receiver<()>>>,
}

impl RouterClientTransport for InOrder {
    // its turn taken as it is sent, so the order kept is the order sent
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let (turn, next) = oneshot::channel::<()>();
        let before = locked(&self.last).replace(next);
        let inner = Arc::clone(&self.inner);
        let (settled, outcome) = oneshot::channel();

        drop(tokio::spawn(async move {
            if let Some(before) = before {
                before.await.ok();
            }

            let sent = match inner.send(message) {
                Ok(Sent::Later(later)) => later.await,
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };

            drop(turn);
            settled.send(sent).ok();
        }));

        Ok(Sent::Later(Box::pin(async move {
            outcome.await.unwrap_or(Ok(()))
        })))
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.inner.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.inner.unlisten(listener);
    }

    fn pause(&self) {
        self.inner.pause();
    }

    fn resume(&self) {
        self.inner.resume();
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.clock()
    }

    fn is_secure(&self) -> bool {
        self.inner.is_secure()
    }

    fn carries(&self, credential: &str) -> bool {
        self.inner.carries(credential)
    }

    fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    fn ready_state(&self) -> ReadyState {
        self.inner.ready_state()
    }
}

// a client connected over one transport or the other, over HTTP its envelopes in order
enum Connected {
    WebSocket(WebSocketClient),
    Http {
        transport: Arc<HttpTransportClient>,
        client: Client,
    },
}

impl Connected {
    // a client of the server at `ports`, connected over `over`, its upgrade carrying `credential`
    // over WebSocket
    async fn new(over: Over, (ports, credential): (Ports, Option<&str>)) -> Result<Self, String> {
        let connected = match over {
            Over::WebSocket => {
                let client = WebSocketClient::new(&WebSocketClientOptions::default())
                    .map_err(|error| error.to_string())?;
                let mut options = WebSocketTransportClientConnectOptions::new(HOST, ports.port);

                options.credential = credential.map(str::to_owned);

                let connect = client.connect(&options);

                (Self::WebSocket(client), connect)
            }
            Over::Http => {
                let transport = Arc::new(
                    HttpTransportClient::new(&HttpTransportClientOptions::default())
                        .map_err(|error| error.to_string())?,
                );
                let in_order = InOrder {
                    inner: Arc::clone(&transport),
                    last: Mutex::new(None),
                };
                let client = Client::new(Arc::new(in_order), &ClientOptions::default())
                    .map_err(|error| error.to_string())?;
                let connect = transport.connect(&HttpTransportClientConnectOptions::new(
                    HOST,
                    ports.http_port,
                ));

                (Self::Http { transport, client }, connect)
            }
        };
        let (client, connect) = connected;

        match patience(PATIENCE, connect).await {
            Ok(Ok(())) => Ok(client),
            Ok(Err(error)) => {
                client.dispose().await;

                Err(format!("not connected: {error}"))
            }
            Err(_) => {
                client.dispose().await;

                Err("not connected in time".to_owned())
            }
        }
    }

    const fn client(&self) -> &Client {
        match self {
            Self::WebSocket(client) => client.client(),
            Self::Http { client, .. } => client,
        }
    }

    async fn dispose(&self) {
        match self {
            Self::WebSocket(client) => client.dispose().await,
            Self::Http { transport, client } => {
                client.dispose().await;
                transport.dispose();
            }
        }
    }
}

// a codec that writes a byte no JSON begins with, as `json`
#[derive(Debug)]
struct NotJson;

impl PayloadCodec for NotJson {
    type Value = Value;

    fn decode(&self, bytes: &Bytes) -> Result<Value, CodecRefusal> {
        JsonCodec.decode(bytes)
    }

    fn encode(&self, _value: &Value) -> Result<Bytes, CodecRefusal> {
        Ok(Bytes::from_static(&[0xff]))
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

// the call's outcome, within its patience
async fn outcome_of<T>(
    call: Result<bead::ServiceCall<T>, bead::ProgrammerError>,
) -> Result<Result<T, CallError>, String> {
    let call = call.map_err(|error| format!("refused as it was made: {error}"))?;

    patience(PATIENCE, call)
        .await
        .map_err(|_elapsed| "no answer in time".to_owned())
}

fn answer_of<T>(outcome: Result<T, CallError>) -> Result<T, String> {
    outcome.map_err(|error| format!("expected an answer, found {error}"))
}

fn failure_of<T: core::fmt::Debug>(outcome: Result<T, CallError>) -> Result<Failure, String> {
    match outcome {
        Err(CallError::Failure(failure)) => Ok(failure),
        Err(error) => Err(format!("expected a failure, found {error}")),
        Ok(value) => Err(format!("expected a failure, found the answer {value:?}")),
    }
}

// a case played: its client, the server's ports, the interop's descriptors
struct Case {
    over: Over,
    ports: Ports,
    connected: Connected,
    procedures: InteropProcedures,
}

impl Case {
    fn client(&self) -> &Client {
        self.connected.client()
    }

    // `descriptor` called with `payload` as `options` say
    async fn outcome(
        &self,
        (descriptor, payload): (&InteropDescriptor, Value),
        options: &RequestOptions,
    ) -> Result<Result<Value, CallError>, String> {
        let call = self
            .client()
            .services()
            .get_request(
                descriptor.procedure(),
                RequestDependencies::new(JsonCodec, JsonCodec),
            )
            .and_then(|requester| requester.call(payload, options));

        outcome_of(call).await
    }

    async fn answer(
        &self,
        called: (&InteropDescriptor, Value),
        options: &RequestOptions,
    ) -> Result<Value, String> {
        answer_of(self.outcome(called, options).await?)
    }

    async fn failure(
        &self,
        called: (&InteropDescriptor, Value),
        options: &RequestOptions,
    ) -> Result<Failure, String> {
        failure_of(self.outcome(called, options).await?)
    }

    // the calls to slow the connection cancelled, once the server counted `count` of them
    async fn cancellations_reaching(&self, count: u64) -> Result<Value, String> {
        let cancellations = &self.procedures.cancellations;

        for _ in 0..40 {
            let counted = self
                .answer((cancellations, Value::Null), &RequestOptions::default())
                .await?;

            if counted.as_u64() == Some(count) {
                return Ok(counted);
            }

            rest(Duration::from_millis(50)).await;
        }

        self.answer((cancellations, Value::Null), &RequestOptions::default())
            .await
    }
}

fn presenting(credential: RequestCredential) -> RequestOptions {
    let mut options = RequestOptions::default();

    options.credential = Some(credential);

    options
}

fn is_failure(
    failure: &Failure,
    (code, origin): (ProtocolCode, FailureOrigin),
) -> Result<(), String> {
    equal(&(failure.code(), failure.origin()), &(code.get(), origin))
}

fn is_code(failure: &Failure, code: ProtocolCode) -> Result<(), String> {
    equal(&failure.code(), &code.get())
}

// what the callbacks heard is `expected`, once they heard it, within the patience
async fn heard_reaching(heard: &Mutex<Vec<Value>>, expected: &[Value]) -> Result<(), String> {
    for _ in 0..500 {
        if locked(heard).as_slice() == expected {
            return Ok(());
        }

        rest(Duration::from_millis(20)).await;
    }

    let found = locked(heard).clone();

    equal(&found.as_slice(), &expected)
}

// ── base64url, and a JWT of the interop's issuer ─────────────────────────────────────────────────

// `bytes` in base64url, unpadded (RFC 4648 §5)
fn base64url_of(bytes: &[u8]) -> String {
    let mut text = String::new();

    for chunk in bytes.chunks(3) {
        let [first, second, third] = [0, 1, 2].map(|index| chunk.get(index).copied().unwrap_or(0));
        let group = u32::from_be_bytes([0, first, second, third]);

        for shift in [18_u32, 12, 6, 0]
            .into_iter()
            .take(chunk.len().saturating_add(1))
        {
            let sextet = group.checked_shr(shift).unwrap_or(0) & 0x3f;

            if let Some(&character) = usize::try_from(sextet)
                .ok()
                .and_then(|sextet| BASE64URL.get(sextet))
            {
                text.push(char::from(character));
            }
        }
    }

    text
}

// the bytes `text` spells in base64url, unpadded
fn bytes_of_base64url(text: &str) -> Result<Vec<u8>, String> {
    let sextets: Vec<u32> = text
        .bytes()
        .map(|character| {
            BASE64URL
                .iter()
                .position(|held| *held == character)
                .and_then(|sextet| u32::try_from(sextet).ok())
                .ok_or_else(|| format!("{text} is not base64url"))
        })
        .collect::<Result<_, _>>()?;
    let mut bytes = Vec::new();

    for chunk in sextets.chunks(4) {
        let group = chunk
            .iter()
            .zip([18_u32, 12, 6, 0])
            .fold(0_u32, |group, (sextet, shift)| {
                group | sextet.checked_shl(shift).unwrap_or(0)
            });
        let [_, first, second, third] = group.to_be_bytes();

        bytes.extend(
            [first, second, third]
                .into_iter()
                .take(chunk.len().saturating_sub(1)),
        );
    }

    Ok(bytes)
}

// an access token of the interop service's HS256 issuer for `sub`, holding an hour on the platform's
// clock, signed with its published test key: the server verifies it with the same
fn interop_token_of(sub: &str) -> Result<String, String> {
    let service: Value =
        serde_json::from_str(INTEROP_SERVICE).map_err(|error| error.to_string())?;
    let jwt = service
        .get("credentials")
        .and_then(|credentials| credentials.get("jwt"))
        .ok_or("the interop service holds its JWT's credentials")?;
    let key = jwt
        .get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| {
            keys.iter()
                .find(|key| key.get("algorithm").and_then(Value::as_str) == Some("HS256"))
        })
        .ok_or("the interop service holds an HS256 key")?;
    let secret = key
        .get("jwk")
        .and_then(|jwk| jwk.get("k"))
        .and_then(Value::as_str)
        .ok_or("its key holds its k")?;
    let now = wall_now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let header = json!({ "alg": "HS256", "typ": "at+jwt" });
    let claims = json!({
        "aud": jwt.get("audience"),
        "client_id": "bead-interop-client",
        "exp": now.saturating_add(3_600),
        "iat": now,
        "iss": key.get("issuer"),
        "jti": "at-interop-0001",
        "sub": sub,
    });
    let signing_input = format!(
        "{}.{}",
        base64url_of(header.to_string().as_bytes()),
        base64url_of(claims.to_string().as_bytes())
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(&bytes_of_base64url(secret)?)
        .map_err(|error| error.to_string())?;

    mac.update(signing_input.as_bytes());

    Ok(format!(
        "{signing_input}.{}",
        base64url_of(&mac.finalize().into_bytes())
    ))
}

// ── The cases ────────────────────────────────────────────────────────────────────────────────────

// a case of the interop, as the other sides' clients play it
#[derive(Debug, Clone, Copy)]
enum Which {
    Echo,
    OutsideAscii,
    Bytes,
    Fail,
    Unknown,
    Refused,
    Invalid,
    Checked,
    CancelledBySignal,
    PastTimeout,
    Command,
    Unpaced,
    Paced,
    Session,
    Presented,
    Jwt,
    Elsewhere,
    Durations,
    Transfer,
}

impl Which {
    const ALL: [Self; 19] = [
        Self::Echo,
        Self::OutsideAscii,
        Self::Bytes,
        Self::Fail,
        Self::Unknown,
        Self::Refused,
        Self::Invalid,
        Self::Checked,
        Self::CancelledBySignal,
        Self::PastTimeout,
        Self::Command,
        Self::Unpaced,
        Self::Paced,
        Self::Session,
        Self::Presented,
        Self::Jwt,
        Self::Elsewhere,
        Self::Durations,
        Self::Transfer,
    ];

    // the TypeScript side's sentence, in snake case
    const fn name(self) -> &'static str {
        match self {
            Self::Echo => "echo_answers_with_its_requests_payload",
            Self::OutsideAscii => "a_value_outside_ascii_its_members_in_another_order_echoed_equal",
            Self::Bytes => "bytes_answers_a_string_of_the_length_asked",
            Self::Fail => "fail_answers_with_its_own_failure_raised_by_the_server",
            Self::Unknown => {
                "a_procedure_unknown_and_a_service_unknown_are_refused_as_the_protocol_says"
            }
            Self::Refused => {
                "an_admission_that_refuses_a_resolver_that_throws_and_a_payload_that_is_not_json"
            }
            Self::Invalid => {
                "a_request_its_rules_refuse_is_answered_payload_invalid_its_violations_in_its_detail"
            }
            Self::Checked => "checked_answers_the_count_of_the_names_its_rules_take",
            Self::CancelledBySignal => {
                "a_call_cancelled_by_its_signal_is_cancelled_at_the_server_too"
            }
            Self::PastTimeout => "a_call_past_its_timeout_is_cancelled_at_the_server_too",
            Self::Command => "answers_the_command_the_server_asks",
            Self::Unpaced => "an_unpaced_subscription_hears_each_tick",
            Self::Paced => {
                "a_paced_subscription_waits_for_its_callback_to_settle_before_the_next_comes"
            }
            Self::Session => "learns_a_session_opened_from_its_answer_and_its_end_too",
            Self::Presented => {
                "a_call_presenting_the_session_it_learned_runs_in_it_the_session_opened_anew_presented_anew_and_none_presented_once_it_ended"
            }
            Self::Jwt => {
                "a_jwt_presented_by_default_runs_in_its_credentials_session_whoami_answers_its_sub_and_logout_is_refused_access_denied"
            }
            Self::Elsewhere => {
                "an_elsewhere_goes_in_each_posts_authorization_over_http_and_in_its_upgrades_over_a_websocket_whoami_answers_the_sub_it_names"
            }
            Self::Durations => {
                "login_and_register_hold_a_duration_as_section_1_4_does_a_fraction_rounded_one_under_a_millisecond_or_past_2_31_minus_1_refused_with_procedure_failed_nothing_opened_or_registered"
            }
            Self::Transfer => {
                "a_payload_that_goes_as_a_transfer_comes_back_as_one_and_so_does_a_result_too_large_for_one_envelope"
            }
        }
    }

    // HTTP carries no transfer: a payload is what one envelope holds
    fn is_played_over(self, over: Over) -> bool {
        !matches!(self, Self::Transfer) || over == Over::WebSocket
    }

    async fn play(self, case: &mut Case) -> Result<(), String> {
        match self {
            Self::Echo => echo(case).await,
            Self::OutsideAscii => outside_ascii(case).await,
            Self::Bytes => bytes(case).await,
            Self::Fail => fail(case).await,
            Self::Unknown => unknown(case).await,
            Self::Refused => refused(case).await,
            Self::Invalid => invalid(case).await,
            Self::Checked => checked(case).await,
            Self::CancelledBySignal => cancelled_by_signal(case).await,
            Self::PastTimeout => past_timeout(case).await,
            Self::Command => command(case).await,
            Self::Unpaced => unpaced(case).await,
            Self::Paced => paced(case).await,
            Self::Session => session(case).await,
            Self::Presented => presented(case).await,
            Self::Jwt => jwt(case).await,
            Self::Elsewhere => elsewhere(case).await,
            Self::Durations => durations(case).await,
            Self::Transfer => transfer(case).await,
        }
    }
}

async fn echo(case: &Case) -> Result<(), String> {
    let value = json!({ "a": [1, "two", null] });
    let none = RequestOptions::default();

    equal(
        &case
            .answer((&case.procedures.echo, value.clone()), &none)
            .await?,
        &value,
    )?;

    // and its bytes as the other side wrote them, its canonical form
    let written = Bytes::from_static(br#"{"a":[1,"two",null]}"#);
    let call = case
        .client()
        .services()
        .get_request(
            case.procedures.echo.procedure(),
            RequestDependencies::new(RawCodec, RawCodec),
        )
        .and_then(|requester| requester.call(written.clone(), &none));

    equal(&answer_of(outcome_of(call).await?)?, &written)
}

// the two codecs read each other's bytes: each side writes its members sorted, in UTF-8
async fn outside_ascii(case: &Case) -> Result<(), String> {
    let value = json!({ "z": "Jos\u{e9} \u{1f600}", "a": [1e21, 0.000_001] });

    equal(
        &case
            .answer(
                (&case.procedures.echo, value.clone()),
                &RequestOptions::default(),
            )
            .await?,
        &value,
    )
}

async fn bytes(case: &Case) -> Result<(), String> {
    let expected: String = core::iter::repeat_n('x', 1_000).collect();

    equal(
        &case
            .answer(
                (&case.procedures.bytes, json!({ "length": 1_000 })),
                &RequestOptions::default(),
            )
            .await?,
        &Value::String(expected),
    )
}

async fn fail(case: &Case) -> Result<(), String> {
    let failure = case
        .failure(
            (&case.procedures.fail, Value::Null),
            &RequestOptions::default(),
        )
        .await?;

    equal(&failure.code().get(), &7)?;
    equal(&failure.detail(), &"this procedure fails, on purpose")?;
    equal(&failure.origin(), &FailureOrigin::Peer)?;
    equal(&failure.scope(), &FailureScope::Application)?;
    equal(&failure.side(), &Some(RouterSide::Server))
}

async fn unknown(case: &Case) -> Result<(), String> {
    let echo = case.procedures.echo.procedure();
    let unknown = Procedure {
        procedure_id: 99,
        ..echo.clone()
    };
    let elsewhere = Procedure {
        service_id: 9,
        ..echo.clone()
    };

    for (procedure, code) in [
        (unknown, ProtocolCode::PROCEDURE_UNKNOWN),
        (elsewhere, ProtocolCode::SERVICE_UNKNOWN),
    ] {
        let call = case
            .client()
            .services()
            .get_request(&procedure, RequestDependencies::new(JsonCodec, JsonCodec))
            .and_then(|requester| requester.call(Value::Null, &RequestOptions::default()));
        let failure = failure_of(outcome_of(call).await?)?;

        is_code(&failure, code)?;
        equal(&failure.scope(), &FailureScope::Protocol)?;
    }

    Ok(())
}

async fn refused(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let denied = case
        .failure((&case.procedures.denied, Value::Null), &none)
        .await?;

    is_code(&denied, ProtocolCode::ACCESS_DENIED)?;
    equal(&denied.detail(), &"this procedure admits nobody")?;
    is_code(
        &case
            .failure((&case.procedures.broken, Value::Null), &none)
            .await?,
        ProtocolCode::PROCEDURE_FAILED,
    )?;

    let call = case
        .client()
        .services()
        .get_request(
            case.procedures.echo.procedure(),
            RequestDependencies::new(NotJson, JsonCodec),
        )
        .and_then(|requester| requester.call(Value::Null, &none));

    is_code(
        &failure_of(outcome_of(call).await?)?,
        ProtocolCode::PAYLOAD_UNDECODABLE,
    )
}

async fn invalid(case: &Case) -> Result<(), String> {
    let failure = case
        .failure(
            (
                &case.procedures.checked,
                json!({ "names": ["ab", "", "abcd"] }),
            ),
            &RequestOptions::default(),
        )
        .await?;

    is_code(&failure, ProtocolCode::PAYLOAD_INVALID)?;
    equal(&failure.scope(), &FailureScope::Protocol)?;
    // * the detail as the server writes it, lines of canonical JSON, byte for byte
    equal(
        &failure.detail(),
        &[
            r#"{"bounds":{"min_len":"1"},"fieldPath":"names[1]","message":"must be at least 1 characters","ruleId":"string.min_len"}"#,
            r#"{"bounds":{"max_len":"3"},"fieldPath":"names[2]","message":"must be at most 3 characters","ruleId":"string.max_len"}"#,
            r#"{"more":0}"#,
        ]
        .join("\n")
        .as_str(),
    )
}

async fn checked(case: &Case) -> Result<(), String> {
    equal(
        &case
            .answer(
                (&case.procedures.checked, json!({ "names": ["a", "bc"] })),
                &RequestOptions::default(),
            )
            .await?,
        &json!(2),
    )
}

async fn cancelled_by_signal(case: &Case) -> Result<(), String> {
    let signal = CancellationToken::new();
    let mut options = RequestOptions::default();

    options.signal = Some(signal.clone());

    let slow = case
        .client()
        .services()
        .get_request(
            case.procedures.slow.procedure(),
            RequestDependencies::new(JsonCodec, JsonCodec),
        )
        .and_then(|requester| {
            requester.call(json!({ "milliseconds": SLOW_MILLISECONDS }), &options)
        })
        .map_err(|error| format!("refused as it was made: {error}"))?;

    // a call after it answered: the server has it, where its cancel must find it, by the socket's
    // order, or by the exchanges'
    case.answer(
        (&case.procedures.echo, Value::Null),
        &RequestOptions::default(),
    )
    .await?;
    signal.cancel();

    let cancelled = patience(PATIENCE, slow)
        .await
        .map_err(|_elapsed| "not cancelled in time")?;

    hold(matches!(cancelled, Err(CallError::Cancelled(_))), || {
        format!("expected it cancelled, found {cancelled:?}")
    })?;
    equal(&case.cancellations_reaching(1).await?, &json!(1))
}

async fn past_timeout(case: &Case) -> Result<(), String> {
    let mut options = RequestOptions::default();

    options.timeout = Some(Duration::from_millis(200));

    let timed_out = case
        .outcome(
            (
                &case.procedures.slow,
                json!({ "milliseconds": SLOW_MILLISECONDS }),
            ),
            &options,
        )
        .await?;

    hold(matches!(timed_out, Err(CallError::TimedOut(_))), || {
        format!("expected it timed out, found {timed_out:?}")
    })?;
    equal(&case.cancellations_reaching(1).await?, &json!(1))
}

async fn command(case: &Case) -> Result<(), String> {
    offer_interop_client(case.client()).map_err(|error| error.to_string())?;

    equal(
        &case
            .answer(
                (&case.procedures.ask, Value::Null),
                &RequestOptions::default(),
            )
            .await?,
        &json!("noon"),
    )
}

// the ticks notification over the case's client, paced at `window` where one is given, each value
// it hears kept in `heard`, the first held until `released` is cancelled where one is given
async fn subscribed(
    case: &Case,
    (heard, released): (&Arc<Mutex<Vec<Value>>>, Option<&CancellationToken>),
) -> Result<bead::NotificationRegistration, String> {
    let mut dependencies =
        NotificationDependencies::new(RequestDependencies::new(JsonCodec, JsonCodec), JsonCodec);

    dependencies.window = released.is_some().then_some(1);

    let ticks = case
        .client()
        .services()
        .get_notification(case.procedures.ticks.descriptor().procedure(), dependencies)
        .map_err(|error| error.to_string())?;
    let hearing = Arc::clone(heard);
    let held = released.cloned();
    let callback: NotificationCallback<Value> = Arc::new(move |value| {
        let count = {
            let mut heard = locked(&hearing);

            heard.push(value);
            heard.len()
        };
        let held = held.clone();

        Box::pin(async move {
            if let Some(held) = held
                && count == 1
            {
                held.cancelled_owned().await;
            }

            Ok::<(), Arc<dyn Error + Send + Sync>>(())
        })
    });

    patience(
        PATIENCE,
        ticks.register(Value::Null, callback, &RegistrationOptions::default()),
    )
    .await
    .map_err(|_elapsed| "not registered in time".to_owned())?
    .map_err(|error| format!("not registered: {error}"))
}

async fn ticked(case: &Case) -> Result<(), String> {
    for value in [1, 2] {
        case.answer(
            (&case.procedures.tick, json!({ "value": value })),
            &RequestOptions::default(),
        )
        .await?;
    }

    Ok(())
}

async fn unregistered(registration: &bead::NotificationRegistration) -> Result<(), String> {
    patience(PATIENCE, registration.unregister())
        .await
        .map_err(|_elapsed| "not unregistered in time".to_owned())?
        .map_err(|error| format!("not unregistered: {error}"))
}

async fn unpaced(case: &Case) -> Result<(), String> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let registration = subscribed(case, (&heard, None)).await?;

    ticked(case).await?;
    heard_reaching(&heard, &[json!(1), json!(2)]).await?;
    unregistered(&registration).await
}

async fn paced(case: &Case) -> Result<(), String> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let released = CancellationToken::new();
    let registration = subscribed(case, (&heard, Some(&released))).await?;

    ticked(case).await?;
    heard_reaching(&heard, &[json!(1)]).await?;
    rest(Duration::from_millis(100)).await;

    let held = locked(&heard).clone();

    equal(&held, &vec![json!(1)])?;
    released.cancel();
    heard_reaching(&heard, &[json!(1), json!(2)]).await?;
    unregistered(&registration).await
}

async fn session(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let procedures = &case.procedures;

    is_code(
        &case
            .failure((&procedures.whoami, Value::Null), &none)
            .await?,
        ProtocolCode::SESSION_REQUIRED,
    )?;
    equal(
        &case
            .answer((&procedures.login, json!({ "name": "ada" })), &none)
            .await?,
        &json!("ada"),
    )?;

    let token = case
        .client()
        .router()
        .session_token()
        .map(|token| token.to_string())
        .unwrap_or_default();

    hold(
        token.len() == 22
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        || {
            format!(
                "a session token of 22 base64url characters, found {} of them",
                token.len()
            )
        },
    )?;
    equal(
        &case
            .answer((&procedures.whoami, Value::Null), &none)
            .await?,
        &json!("ada"),
    )?;
    equal(
        &case
            .answer((&procedures.logout, Value::Null), &none)
            .await?,
        &Value::Null,
    )?;
    hold(case.client().router().session_token().is_none(), || {
        "its session token kept past its end".to_owned()
    })
}

async fn presented(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let presenting = presenting(RequestCredential::Opaque);
    let procedures = &case.procedures;

    is_failure(
        &case
            .failure((&procedures.login, json!({ "name": "ada" })), &presenting)
            .await?,
        (ProtocolCode::SESSION_REQUIRED, FailureOrigin::Local),
    )?;
    equal(
        &case
            .answer((&procedures.login, json!({ "name": "ada" })), &none)
            .await?,
        &json!("ada"),
    )?;
    equal(
        &case
            .answer((&procedures.whoami, Value::Null), &presenting)
            .await?,
        &json!("ada"),
    )?;
    equal(
        &case
            .answer((&procedures.login, json!({ "name": "bob" })), &presenting)
            .await?,
        &json!("bob"),
    )?;
    equal(
        &case
            .answer((&procedures.whoami, Value::Null), &presenting)
            .await?,
        &json!("bob"),
    )?;
    equal(
        &case
            .answer((&procedures.logout, Value::Null), &presenting)
            .await?,
        &Value::Null,
    )?;
    is_failure(
        &case
            .failure((&procedures.whoami, Value::Null), &presenting)
            .await?,
        (ProtocolCode::SESSION_REQUIRED, FailureOrigin::Local),
    )
}

async fn jwt(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let procedures = &case.procedures;
    let credential = RequestCredential::Jwt(interop_token_of("grace")?);

    case.client()
        .router()
        .set_credential(Some(credential.clone()))
        .map_err(|error| error.to_string())?;

    // a login opens the connection's session, whatever the call presents
    equal(
        &case
            .answer((&procedures.login, json!({ "name": "ada" })), &none)
            .await?,
        &json!("ada"),
    )?;
    equal(
        &case
            .answer((&procedures.whoami, Value::Null), &none)
            .await?,
        &json!("grace"),
    )?;

    let refused = case
        .failure((&procedures.logout, Value::Null), &none)
        .await?;

    is_failure(&refused, (ProtocolCode::ACCESS_DENIED, FailureOrigin::Peer))?;
    equal(
        &refused.detail(),
        &"a call in a credential's session ends no connection's session",
    )?;
    equal(&case.client().router().credential(), &Some(credential))?;

    // the connection's session stays, a call presenting none running in it
    equal(
        &case
            .answer(
                (&procedures.whoami, Value::Null),
                &presenting(RequestCredential::None),
            )
            .await?,
        &json!("ada"),
    )
}

async fn elsewhere(case: &mut Case) -> Result<(), String> {
    let ada = presenting(RequestCredential::Elsewhere("Interop sub=ada".to_owned()));

    if case.over == Over::WebSocket {
        // its upgrade carries none yet: a call presenting one fails before it goes
        is_failure(
            &case
                .failure((&case.procedures.whoami, Value::Null), &ada)
                .await?,
            (ProtocolCode::DESTINATION_UNREACHABLE, FailureOrigin::Local),
        )?;

        // given the credential at its connect, which writes it on the upgrade
        case.connected.dispose().await;
        case.connected = Connected::new(case.over, (case.ports, Some("Interop sub=ada"))).await?;
    }

    equal(
        &case
            .answer((&case.procedures.whoami, Value::Null), &ada)
            .await?,
        &json!("ada"),
    )?;

    if case.over == Over::WebSocket {
        // over a WebSocket, those bytes alone: another credential fails before it goes
        let bob = presenting(RequestCredential::Elsewhere("Interop sub=bob".to_owned()));

        is_failure(
            &case
                .failure((&case.procedures.whoami, Value::Null), &bob)
                .await?,
            (ProtocolCode::DESTINATION_UNREACHABLE, FailureOrigin::Local),
        )?;
    }

    Ok(())
}

async fn durations(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let procedures = &case.procedures;

    for refused in [
        json!({ "name": "ada", "sessionTimeout": 0.4 }),
        json!({ "connectionTimeout": 2_147_483_648_u64, "name": "ada" }),
        json!({ "name": "ada", "sessionTimeout": -1 }),
    ] {
        is_code(
            &case.failure((&procedures.login, refused), &none).await?,
            ProtocolCode::PROCEDURE_FAILED,
        )?;
    }

    is_code(
        &case
            .failure((&procedures.whoami, Value::Null), &none)
            .await?,
        ProtocolCode::SESSION_REQUIRED,
    )?;
    is_code(
        &case
            .failure(
                (
                    &procedures.register,
                    json!({ "destination": 41, "timeout": 0 }),
                ),
                &none,
            )
            .await?,
        ProtocolCode::PROCEDURE_FAILED,
    )?;
    equal(
        &case
            .answer(
                (
                    &procedures.register,
                    json!({ "destination": 41, "timeout": 1.5 }),
                ),
                &none,
            )
            .await?,
        &json!(41),
    )?;
    equal(
        &case
            .answer((&procedures.unregister, Value::Null), &none)
            .await?,
        &json!(true),
    )?;

    // a session timeout given ends its session once past, rounded; silence counts it alone
    equal(
        &case
            .answer(
                (
                    &procedures.login,
                    json!({ "connectionTimeout": 2_147_483_647_u64, "name": "ada", "sessionTimeout": 99.6 }),
                ),
                &none,
            )
            .await?,
        &json!("ada"),
    )?;

    // ! the other side's timer may not have fired on a loaded runner, and an ask that finds the
    // session still there counts afresh: ask again after each silence, until one ends it
    let mut code = None;

    for _ in 0..10 {
        rest(Duration::from_millis(400)).await;

        if let Err(CallError::Failure(failure)) = case
            .outcome((&procedures.whoami, Value::Null), &none)
            .await?
        {
            code = Some(failure.code());
        }

        if code == Some(ProtocolCode::SESSION_REQUIRED.get()) {
            break;
        }
    }

    equal(&code, &Some(ProtocolCode::SESSION_REQUIRED.get()))
}

async fn transfer(case: &Case) -> Result<(), String> {
    let none = RequestOptions::default();
    let long: String = core::iter::repeat_n('x', TRANSFERRED).collect();
    let echoed = case
        .answer((&case.procedures.echo, Value::String(long.clone())), &none)
        .await?;
    let sent = case
        .answer(
            (&case.procedures.bytes, json!({ "length": TRANSFERRED })),
            &none,
        )
        .await?;

    // compared, not diffed: three mebibytes would bury a failure
    hold(echoed.as_str() == Some(long.as_str()), || {
        "echoed otherwise".to_owned()
    })?;
    hold(sent.as_str() == Some(long.as_str()), || {
        "sent otherwise".to_owned()
    })
}

// ── The trials ───────────────────────────────────────────────────────────────────────────────────

// a trial a case, a transport and a server
#[derive(Debug, Clone, Copy)]
struct Played {
    side: Side,
    over: Over,
    which: Which,
}

impl Played {
    fn name(self) -> String {
        format!(
            "{}::{}::{}",
            self.side.name(),
            self.over.name(),
            self.which.name()
        )
    }

    // its server's ports, then the case on a client of its own, let go of whatever it found
    fn run(self) -> Result<(), String> {
        let ports = ports_of(self.side)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;

        runtime.block_on(async move {
            let connected = Connected::new(self.over, (ports, None)).await?;
            let mut case = Case {
                over: self.over,
                ports,
                connected,
                procedures: interop_procedures(None).map_err(|error| error.to_string())?,
            };
            let outcome = self.which.play(&mut case).await;

            case.connected.dispose().await;

            outcome
        })
    }
}

fn main() -> ExitCode {
    let mut arguments = Arguments::from_args();
    let is_asked = std::env::var_os("BEAD_INTEROP_RUST").is_some_and(|value| value == "1");
    let mut trials = Vec::new();

    // * one at a time, as the other sides' interop runs: two cases on one server share its relay
    arguments.test_threads.get_or_insert(1);

    if !is_asked {
        trials.push(Trial::test(SKIPPED, || Ok(())).with_ignored_flag(true));
    }

    for side in Side::ALL {
        for over in Over::ALL {
            for which in Which::ALL
                .into_iter()
                .filter(|which| which.is_played_over(over))
            {
                let played = Played { side, over, which };

                trials.push(
                    Trial::test(played.name(), move || played.run().map_err(Failed::from))
                        .with_ignored_flag(!is_asked),
                );
            }
        }
    }

    let conclusion = libtest_mimic::run(&arguments, trials);

    stop_every_server();

    conclusion.exit_code()
}
