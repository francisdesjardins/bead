//! `spec/transports.json`'s cases over a socket, played against the Rust side's WebSocket server: a
//! server of the interop service, its options on its transport and its limits on its router, every
//! layer on the case's stepping clock, and the case's peers, each exchange on a socket of its own
//! written in exact octets by `bead::testing::wire`; and the responses every side's reader reads
//! alike, cut across reads.

use core::time::Duration;
use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime};

use bead::testing::wire::{
    BINARY, Exchange, ExchangeOptions, Frame, Heard, ResponseHead, ResponseReader, TEXT, latin1_of,
};
use bead::testing::{SteppingClock, hexadecimal};
use bead::{
    ConnectionHandle, RouterError, ServerListener, ServerOptions, ServerTransport, SharedClock,
    TransportServerRefusal, TransportServerStartOptions, WebSocketServer, WebSocketServerOptions,
    WebSocketTransportServerOptions,
};
use bytes::Bytes;
use serde_json::{Map, Value, json};

use crate::conversation;

// how long a step waits, on the real clock, for what it awaits, unless it says
const PATIENCE: Duration = Duration::from_secs(10);

// how often it looks again
const POLL: Duration = Duration::from_millis(5);

// the address every server of a case listens on, which every server takes
const HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;

// ! every key of a step and of an option this player reads over WebSocket: one it does not know
// fails the case, rather than pass it unplayed
const STEP_KEYS: [&str; 9] = [
    "advance", "after", "expect", "on", "report", "send", "stop", "until", "within",
];

// the keys that time a step or name its exchange rather than make an act
const MODIFIERS: [&str; 3] = ["after", "on", "within"];

const OPTION_KEYS: [&str; 12] = [
    "maximumMessageBytes",
    "heartbeat",
    "hosts",
    "origins",
    "trustedProxies",
    "unnamedProxies",
    "maximumConnections",
    "maximumConnectionsPerAddress",
    "minimumSendBytesPerSecond",
    "sendGracePeriod",
    "maximumUnsentBytes",
    "headersTimeout",
];

// what an expectation of a response reads, and of what a WebSocket heard
const RESPONSE_KEYS: [&str; 5] = ["status", "fields", "body", "envelope", "told"];
const HEARD_KEYS: [&str; 5] = ["envelope", "binary", "close", "ping", "end"];

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hold<S: FnOnce() -> String>(holds: bool, said: S) -> Result<(), String> {
    if holds { Ok(()) } else { Err(said()) }
}

// when a wait of `within` from now ends, on the real clock
fn deadline_of(within: Duration) -> Instant {
    let now = Instant::now();

    now.checked_add(within).unwrap_or(now)
}

async fn poll_within<F: Fn() -> bool>(holds: F) -> bool {
    let deadline = deadline_of(PATIENCE);

    while !holds() && Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
    }

    holds()
}

// hexadecimal as the codec's reader writes it, whatever spaces and bars it came with
fn canonical_of(text: &str) -> Result<String, String> {
    hexadecimal::bytes_of(text)
        .map(|bytes| hexadecimal::text_of(&bytes))
        .ok_or_else(|| format!("{text:?} is no hexadecimal"))
}

// `text` with each `{name}` a word names put in as the value captured under it; `keep` names one
// left as it is
fn filled_of(
    text: &str,
    (values, keep): (&HashMap<String, String>, Option<&str>),
) -> Result<String, String> {
    let mut filled = String::new();
    let mut rest = text;

    while let Some(start) = rest.find('{') {
        let (before, after) = rest.split_at(start);
        let name_end = after
            .char_indices()
            .skip(1)
            .find(|(_, each)| !(each.is_ascii_alphanumeric() || *each == '_'));

        filled.push_str(before);

        match name_end {
            Some((end, '}')) if end > 1 => {
                let name = after.get(1..end).unwrap_or_default();

                if keep == Some(name) {
                    filled.push_str(after.get(..=end).unwrap_or_default());
                } else {
                    filled.push_str(
                        values
                            .get(name)
                            .ok_or_else(|| format!("nothing captured under {name}"))?,
                    );
                }

                rest = after.get(end.saturating_add(1)..).unwrap_or_default();
            }
            _ => {
                filled.push('{');
                rest = after.get(1..).unwrap_or_default();
            }
        }
    }

    filled.push_str(rest);

    Ok(filled)
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

// RFC 9110 §5.6.7's IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`
fn is_http_date(text: &str) -> bool {
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let parts: Vec<&str> = text.split(' ').collect();
    let [day, date, month, year, time, zone] = parts.as_slice() else {
        return false;
    };
    let clock: Vec<&str> = time.split(':').collect();

    day.strip_suffix(',').is_some_and(|day| DAYS.contains(&day))
        && date.len() == 2
        && is_digits(date)
        && MONTHS.contains(month)
        && year.len() == 4
        && is_digits(year)
        && clock.len() == 3
        && clock.iter().all(|part| part.len() == 2 && is_digits(part))
        && *zone == "GMT"
}

// 16 bytes in base64url without padding: 21 characters, then one whose low bits are none
fn is_token(text: &str) -> bool {
    let is_base64url = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_';

    text.len() == 22
        && text.bytes().take(21).all(is_base64url)
        && text.ends_with(['A', 'Q', 'g', 'w'])
}

fn is_shaped(value: &str, shape: &str) -> bool {
    match shape {
        "delay-seconds" => is_digits(value),
        "http-date" => is_http_date(value),
        "token" => is_token(value),
        _ => false,
    }
}

// ── The responses ────────────────────────────────────────────────────────────────────────────

/// Plays a response of the file's `responses`: its pieces fed one read each, read whole by its
/// length or de-chunked, its status, its fields and its body as it says.
pub(crate) fn read_response(response: &Value) -> Result<(), String> {
    let mut reader = ResponseReader::new();

    for piece in response
        .get("pieces")
        .and_then(Value::as_array)
        .ok_or("a response holds its pieces")?
    {
        let bytes = piece
            .as_str()
            .and_then(hexadecimal::bytes_of)
            .ok_or("a piece is hexadecimal")?;

        reader.feed(&bytes);
    }

    let read = reader
        .response()
        .ok_or_else(|| format!("no response read whole: {:?}", reader.failed()))?;
    let expected_fields = response
        .get("fields")
        .and_then(Value::as_object)
        .ok_or("a response names its fields")?;
    let fields: Map<String, Value> = expected_fields
        .keys()
        .map(|name| (name.clone(), json!(read.head.fields.get(name))))
        .collect();
    let seen = json!({
        "status": read.head.status,
        "fields": fields,
        "body": hexadecimal::text_of(&read.body),
    });
    let wanted = json!({
        "status": response.get("status"),
        "fields": expected_fields,
        "body": canonical_of(response.get("body").and_then(Value::as_str).unwrap_or_default())?,
    });

    hold(seen == wanted, || format!("read {seen}, not {wanted}"))
}

// ── The server under test ────────────────────────────────────────────────────────────────────

// what the server reported to its application, through its router or its transport, and the
// refusals its transport told
#[derive(Default)]
struct Told {
    reports: Mutex<VecDeque<(Value, Option<ConnectionHandle>)>>,
    refusals: Mutex<VecDeque<TransportServerRefusal>>,
}

fn code_of(error: &RouterError) -> Value {
    match error {
        RouterError::Failure(failure) => json!(failure.code().get()),
        RouterError::Other(_) | _ => json!("exception"),
    }
}

struct AtTransport(Arc<Told>);

impl ServerListener for AtTransport {
    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        locked(&self.0.refusals).push_back(refusal.clone());
    }

    // * what the transport reports is the server's report to its application, as its router's is:
    // a text message's ENVELOPE_MALFORMED among it
    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        locked(&self.0.reports).push_back((code_of(error), connection_handle.cloned()));
    }
}

fn duration_of(options: &Map<String, Value>, name: &str) -> Option<Duration> {
    options
        .get(name)
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
}

fn strings_of(options: &Map<String, Value>, name: &str) -> Option<Vec<String>> {
    options.get(name).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

// the interop service's server on WebSocket, the case's options on its transport and its limits on
// its router, every layer on `clock`, its reports and refusals heard
fn server_of(
    case: &Value,
    (clock, told): (&SharedClock, &Arc<Told>),
) -> Result<WebSocketServer, String> {
    let options = case
        .get("options")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let unread: Vec<&String> = options
        .keys()
        .filter(|key| !OPTION_KEYS.contains(&key.as_str()))
        .collect();

    hold(unread.is_empty(), || {
        format!("a case sets an option no test reads: {unread:?}")
    })?;

    let limits = conversation::limits_of(case)?;
    let count = |name: &str| options.get(name).and_then(Value::as_u64);
    let mut transport = WebSocketTransportServerOptions::default();

    transport.clock = Some(Arc::clone(clock));
    transport.headers_timeout = duration_of(&options, "headersTimeout");
    transport.heartbeat = duration_of(&options, "heartbeat");
    transport.hosts = strings_of(&options, "hosts");
    transport.origins = strings_of(&options, "origins");
    transport.trusted_proxies = strings_of(&options, "trustedProxies");
    transport.unnamed_proxies = count("unnamedProxies");
    transport.maximum_message_bytes = count("maximumMessageBytes");
    transport.maximum_connections = count("maximumConnections");
    transport.maximum_connections_per_address = count("maximumConnectionsPerAddress");
    transport.maximum_unsent_bytes = count("maximumUnsentBytes");
    transport.minimum_send_bytes_per_second = count("minimumSendBytesPerSecond");
    transport.send_grace_period = duration_of(&options, "sendGracePeriod");

    let mut server = ServerOptions::default();

    server.credentials = Some(
        bead_interop::interop_credentials_of(clock, &limits).map_err(|error| error.to_string())?,
    );
    server.limits = Some(limits);

    let mut facade = WebSocketServerOptions::default();

    facade.server = Some(server);
    facade.transport = Some(transport);

    let built = WebSocketServer::new(&facade).map_err(|error| error.to_string())?;
    let reporting = Arc::clone(told);

    built.router().on_error(Arc::new(
        move |error: &RouterError, handle: Option<&ConnectionHandle>| {
            locked(&reporting.reports).push_back((code_of(error), handle.cloned()));
        },
    ));
    built
        .transport()
        .listen(Arc::new(AtTransport(Arc::clone(told))));
    bead_interop::offer_interop(built.server()).map_err(|error| error.to_string())?;

    Ok(built)
}

// ── A case's steps ───────────────────────────────────────────────────────────────────────────

// when a step started, and how long it waits, no sooner than `after` for what it reads
#[derive(Clone, Copy)]
struct Timing {
    started: Instant,
    within: Option<Duration>,
    after: Option<Duration>,
}

impl Timing {
    fn wait(self) -> Duration {
        self.within.unwrap_or(PATIENCE)
    }

    fn left(self) -> Duration {
        self.wait().saturating_sub(self.started.elapsed())
    }

    // what came at `came`, too soon for its `after`
    fn too_soon(self, came: Instant) -> Option<String> {
        let at = came.saturating_duration_since(self.started);

        self.after.filter(|after| at < *after).map(|after| {
            format!(
                "came at {} ms, before its {} ms",
                at.as_millis(),
                after.as_millis()
            )
        })
    }
}

// where a step acts, what names it in a failure, and when it started
struct Act<'a> {
    on: &'a str,
    at: &'a str,
    timing: Timing,
}

struct Played {
    clock: Arc<SteppingClock>,
    server: WebSocketServer,
    told: Arc<Told>,
    exchanges: HashMap<String, Exchange>,
    values: HashMap<String, String>,
    port: u16,
    answers_pings: bool,
    is_stopped: bool,
}

impl Played {
    fn exchange(&self, (on, at): (&str, &str)) -> Result<&Exchange, String> {
        self.exchanges
            .get(on)
            .ok_or_else(|| format!("{at}: no exchange {on} was sent"))
    }

    fn nothing_reported(&self, when: &str) -> Result<(), String> {
        let reports: Vec<Value> = locked(&self.told.reports)
            .iter()
            .map(|(code, _)| code.clone())
            .collect();
        let refusals: Vec<TransportServerRefusal> =
            locked(&self.told.refusals).iter().cloned().collect();

        hold(reports.is_empty() && refusals.is_empty(), || {
            format!("{when}: reported {reports:?}, and told {refusals:?}")
        })
    }

    // the handle the exchange `on`'s connection has on the server: the one it holds from the port
    // the exchange's socket came from
    fn handle_of(&self, (on, at): (&str, &str)) -> Result<ConnectionHandle, String> {
        let port = self.exchange((on, at))?.local_port();

        self.server
            .transport()
            .clients()
            .into_iter()
            .find(|client| client.port == Some(port))
            .map(|client| client.connection_handle)
            .ok_or_else(|| format!("{at}: the exchange {on} names no connection the server holds"))
    }

    async fn send(
        &mut self,
        send: &Map<String, Value>,
        (on, at): (&str, &str),
    ) -> Result<(), String> {
        if let Some(head) = send.get("head").and_then(Value::as_str) {
            let filled = filled_of(head, (&self.values, None))?;
            let mut request =
                latin1_of(&filled).ok_or_else(|| format!("{at}: a head past ISO-8859-1"))?;

            if let Some(body) = send.get("body").and_then(Value::as_str) {
                request.extend(
                    hexadecimal::bytes_of(body)
                        .ok_or_else(|| format!("{at}: a body that is no hexadecimal"))?,
                );
            }

            if let Some(before) = self.exchanges.remove(on) {
                before.destroy();
            }

            let mut options = ExchangeOptions::new(SocketAddr::from((HOST, self.port)));

            options.answers_pings = Some(self.answers_pings);

            let exchange = Exchange::open(&request, &options)
                .await
                .map_err(|error| format!("{at}: {error}"))?;

            self.exchanges.insert(on.to_owned(), exchange);

            return Ok(());
        }

        let frames = frames_of(send).map_err(|error| format!("{at}: {error}"))?;

        self.exchange((on, at))?
            .send(&frames)
            .await
            .map_err(|error| format!("{at}: {error}"))
    }
}

// the frames a message is written in: one, but those a case gives itself
fn frames_of(send: &Map<String, Value>) -> Result<Vec<Frame>, String> {
    if let Some(binary) = send.get("binary").and_then(Value::as_str) {
        let bytes =
            hexadecimal::bytes_of(binary).ok_or("a binary message that is no hexadecimal")?;

        return Ok(vec![Frame::whole(BINARY, bytes)]);
    }

    if let Some(text) = send.get("text").and_then(Value::as_str) {
        return Ok(vec![Frame::whole(TEXT, text.as_bytes().to_vec())]);
    }

    if let Some(code) = send.get("close").and_then(Value::as_u64) {
        let code = u16::try_from(code).map_err(|error| error.to_string())?;

        return Ok(vec![Frame::close(code)]);
    }

    send.get("frames")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("a send of nothing this player writes: {send:?}"))?
        .iter()
        .map(|frame| {
            let opcode = frame
                .get("opcode")
                .and_then(Value::as_u64)
                .and_then(|opcode| u8::try_from(opcode).ok())
                .ok_or("a frame names its opcode")?;
            let fin = frame
                .get("fin")
                .and_then(Value::as_bool)
                .ok_or("a frame says whether it ends its message")?;
            let payload = frame
                .get("payload")
                .and_then(Value::as_str)
                .and_then(hexadecimal::bytes_of)
                .ok_or("a frame's payload is hexadecimal")?;

            Ok(Frame {
                fin,
                opcode,
                payload,
            })
        })
        .collect()
}

// what a response shows of what `expected` names, in its terms: a field of the shape expected shows
// as that shape, so a comparison tells a value drawn from a value wrong
fn seen_of((head, body): (&ResponseHead, Option<&[u8]>), expected: &Map<String, Value>) -> Value {
    let mut seen = Map::new();

    seen.insert("status".to_owned(), json!(head.status));

    if let Some(Value::Object(fields)) = expected.get("fields") {
        let shown: Map<String, Value> = fields
            .iter()
            .map(|(name, want)| {
                let value = head.fields.get(&name.to_ascii_lowercase());
                let shaped = value.is_some_and(|value| {
                    want.get("shape")
                        .and_then(Value::as_str)
                        .is_some_and(|shape| is_shaped(value, shape))
                });

                (
                    name.clone(),
                    if shaped { want.clone() } else { json!(value) },
                )
            })
            .collect();

        seen.insert("fields".to_owned(), Value::Object(shown));
    }

    let body = body.unwrap_or_default();

    if expected.contains_key("body") {
        seen.insert("body".to_owned(), json!(hexadecimal::text_of(body)));
    }

    if let Some(want) = expected.get("envelope") {
        let bytes = Bytes::copy_from_slice(body);

        seen.insert(
            "envelope".to_owned(),
            conversation::actual_of(Some(&bytes), want)
                .unwrap_or_else(|| json!(hexadecimal::text_of(body))),
        );
    }

    Value::Object(seen)
}

// what a case writes for the port of the socket its exchange was sent on
const LOCAL_PORT: &str = concat!("{", "port}");

// a refusal told, in a case's terms: its port as the local port's mark where it is the socket's the
// exchange was sent on
fn told_of(refusal: &TransportServerRefusal, local_port: u16) -> Value {
    json!({
        "status": refusal.status,
        "reason": refusal.reason,
        "authority": refusal.authority,
        "origin": refusal.origin,
        "address": refusal.address,
        "port": refusal.port.map(|port| if port == local_port {
            LOCAL_PORT.to_owned()
        } else {
            port.to_string()
        }),
    })
}

async fn expect_response(
    played: &mut Played,
    (expected, act): (&Map<String, Value>, &Act<'_>),
) -> Result<(), String> {
    let Act { on, at, timing } = *act;
    let exchange = played.exchange((on, at))?;
    let head = exchange
        .head(timing.wait())
        .await
        .map_err(|error| format!("{at}: the response's head: {error}"))?;

    if let Some(soon) = timing.too_soon(Instant::now()) {
        return Err(format!("{at}: the response's head {soon}"));
    }

    let has_body = expected.contains_key("body") || expected.contains_key("envelope");
    let body = if has_body {
        Some(
            exchange
                .response(timing.left())
                .await
                .map_err(|error| format!("{at}: the response: {error}"))?
                .body,
        )
    } else {
        None
    };
    let seen = seen_of((&head, body.as_deref()), expected);
    let mut wanted = expected.clone();

    wanted.remove("told");

    if let Some(Value::String(body)) = expected.get("body") {
        wanted.insert("body".to_owned(), json!(canonical_of(body)?));
    }

    let wanted = Value::Object(wanted);

    hold(seen == wanted, || format!("{at}: {seen}, not {wanted}"))?;

    for (name, want) in expected
        .get("fields")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if let (Some(capture), Some(value)) = (
            want.get("capture").and_then(Value::as_str),
            head.fields.get(&name.to_ascii_lowercase()),
        ) {
            played.values.insert(capture.to_owned(), value.clone());
        }
    }

    let local_port = played.exchange((on, at))?.local_port();

    // ! a refusal is told once written, so none told by now is none at all
    match expected.get("told") {
        None => Ok(()),
        Some(Value::Null) => {
            let refusals: Vec<TransportServerRefusal> =
                locked(&played.told.refusals).iter().cloned().collect();

            hold(refusals.is_empty(), || {
                format!("{at}: the refusals told, {refusals:?}")
            })
        }
        Some(Value::Object(told)) => {
            let told_now = Arc::clone(&played.told);

            poll_within(|| !locked(&told_now.refusals).is_empty()).await;

            let refusal = locked(&played.told.refusals).pop_front();
            let seen = refusal.map_or_else(
                || json!("none told"),
                |refusal| told_of(&refusal, local_port),
            );
            let mut wanted = Map::new();

            for (name, value) in told {
                let filled = if let Value::String(text) = value {
                    json!(filled_of(text, (&played.values, Some("port")))?)
                } else {
                    value.clone()
                };

                wanted.insert(name.clone(), filled);
            }

            let wanted = Value::Object(wanted);

            hold(seen == wanted, || {
                format!("{at}: the refusal told, {seen}, not {wanted}")
            })
        }
        Some(other) => Err(format!("{at}: a told of {other}")),
    }
}

// what the server sent on a WebSocket, in the terms `expected` names it by: a pong, which no case
// expects, as itself, so that it fails the step it comes in
fn heard_of(heard: &Heard, expected: &Map<String, Value>) -> Result<Value, String> {
    Ok(match heard {
        Heard::Binary(bytes) => expected.get("envelope").map_or_else(
            || json!({ "binary": hexadecimal::text_of(bytes) }),
            |want| {
                let bytes = Bytes::copy_from_slice(bytes);
                let envelope = conversation::actual_of(Some(&bytes), want)
                    .unwrap_or_else(|| json!(hexadecimal::text_of(&bytes)));

                json!({ "envelope": envelope })
            },
        ),
        Heard::Text(text) => json!({ "text": text }),
        Heard::Close(code) => json!({ "close": code }),
        Heard::Ping(_) => json!({ "ping": true }),
        Heard::Pong(_) => json!({ "pong": true }),
        Heard::End => json!({ "end": true }),
        Heard::Failed(error) => return Err(error.clone()),
        other => json!({ "unknown": format!("{other:?}") }),
    })
}

async fn expect_heard(
    played: &Played,
    (expected, act): (&Map<String, Value>, &Act<'_>),
) -> Result<(), String> {
    let Act { on, at, timing } = *act;
    let exchange = played.exchange((on, at))?;
    let heard = exchange.next(timing.wait()).await;
    let came = Instant::now();
    let Some(heard) = heard else {
        let late = if timing.within.is_some() {
            match exchange.next(PATIENCE).await {
                Some(late) => format!(
                    ": {} came at {} ms",
                    heard_of(&late, expected)?,
                    timing.started.elapsed().as_millis()
                ),
                None => format!(", nor in the {} ms past it", PATIENCE.as_millis()),
            }
        } else {
            String::new()
        };

        return Err(format!(
            "{at}: nothing within {} ms{late}",
            timing.wait().as_millis()
        ));
    };
    let seen = heard_of(&heard, expected).map_err(|error| format!("{at}: {error}"))?;

    if let Some(soon) = timing.too_soon(came) {
        return Err(format!("{at}: {seen} {soon}"));
    }

    let mut wanted = expected.clone();

    if let Some(Value::String(binary)) = expected.get("binary") {
        wanted.insert("binary".to_owned(), json!(canonical_of(binary)?));
    }

    let wanted = Value::Object(wanted);

    hold(seen == wanted, || format!("{at}: {seen}, not {wanted}"))
}

#[expect(
    clippy::too_many_lines,
    reason = "one branch per step's key, as the player of each side reads them"
)]
async fn play_steps(played: &mut Played, steps: &[Value]) -> Result<(), String> {
    for (index, step) in steps.iter().enumerate() {
        let at = format!("step {}", index.saturating_add(1));
        let object = step.as_object().ok_or("a step is an object")?;
        let unknown: Vec<&String> = object
            .keys()
            .filter(|key| !STEP_KEYS.contains(&key.as_str()))
            .collect();
        let acts = object
            .keys()
            .filter(|key| !MODIFIERS.contains(&key.as_str()))
            .count();

        hold(unknown.is_empty(), || {
            format!("{at}: the keys this player does not read: {unknown:?}")
        })?;
        // a step is one act: one that holds a second fails, never passes with it left unplayed
        hold(acts == 1, || format!("{at}: {acts} acts, not one"))?;

        let timing = Timing {
            started: Instant::now(),
            within: step
                .get("within")
                .and_then(Value::as_u64)
                .map(Duration::from_millis),
            after: step
                .get("after")
                .and_then(Value::as_u64)
                .map(Duration::from_millis),
        };
        let on = step.get("on").and_then(Value::as_str).unwrap_or_default();

        if let Some(send) = step.get("send") {
            played.nothing_reported(&format!("before {at}"))?;

            let send = send.as_object().ok_or("a send is an object")?;

            played.send(send, (on, &at)).await?;
        }

        if let Some(expected) = step.get("expect") {
            let expected = expected.as_object().ok_or("an expect is an object")?;

            if expected.contains_key("status") {
                let unread: Vec<&String> = expected
                    .keys()
                    .filter(|key| !RESPONSE_KEYS.contains(&key.as_str()))
                    .collect();

                hold(unread.is_empty(), || {
                    format!("{at}: what this player does not read of a response: {unread:?}")
                })?;
                expect_response(
                    played,
                    (
                        expected,
                        &Act {
                            on,
                            at: &at,
                            timing,
                        },
                    ),
                )
                .await?;
            } else {
                let unread: Vec<&String> = expected
                    .keys()
                    .filter(|key| !HEARD_KEYS.contains(&key.as_str()))
                    .collect();

                hold(unread.is_empty(), || {
                    format!("{at}: what this player does not read of a WebSocket: {unread:?}")
                })?;
                expect_heard(
                    played,
                    (
                        expected,
                        &Act {
                            on,
                            at: &at,
                            timing,
                        },
                    ),
                )
                .await?;
            }
        }

        if let Some(until) = step.get("until") {
            if let Some(timer) = until.get("timer").and_then(Value::as_u64) {
                let timer = Duration::from_millis(timer);
                // ! the earliest timer live, and the only one so due: one armed before it and not
                // yet cleared, on the server's threads, would fire first as the clock advances
                let is_earliest = || {
                    let mut dues = played.clock.dues();

                    dues.sort_unstable();

                    matches!(dues.as_slice(), [first, rest @ ..] if *first == timer && rest.first() != Some(&timer))
                };

                hold(poll_within(is_earliest).await, || {
                    format!(
                        "{at}: the earliest timer armed, alone so due, among {:?}",
                        played.clock.dues()
                    )
                })?;
            } else {
                let gauge = until
                    .get("gauge")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let is = until.get("is").and_then(Value::as_u64);
                let value = || {
                    played
                        .server
                        .transport()
                        .gauges()
                        .and_then(|gauges| gauges.counts.get(gauge).copied())
                };

                hold(poll_within(|| value() == is).await, || {
                    format!("{at}: {gauge} is {:?}, not {is:?}", value())
                })?;
            }
        }

        if let Some(advance) = step.get("advance").and_then(Value::as_u64) {
            played.clock.advance(Duration::from_millis(advance)).await;
        }

        if let Some(report) = step.get("report") {
            let told = Arc::clone(&played.told);

            poll_within(|| !locked(&told.reports).is_empty()).await;

            let reported = locked(&played.told.reports).pop_front();
            let (code, handle) = reported.ok_or_else(|| format!("{at}: nothing reported"))?;

            hold(code == *report, || {
                format!("{at}: the report, {code}, not {report}")
            })?;

            if step.get("on").is_some() {
                let expected = played.handle_of((on, &at))?;

                hold(handle.as_ref() == Some(&expected), || {
                    format!("{at}: the report's connection, {handle:?}, not {expected}")
                })?;
            }
        }

        if step.get("stop") == Some(&Value::Bool(true)) {
            played.is_stopped = true;
            played
                .server
                .dispose()
                .await
                .map_err(|error| format!("{at}: its stop: {error}"))?;
        }
    }

    played.nothing_reported("at the end")
}

/// Plays a case over WebSocket against a server of the interop service, started on the IPv4
/// loopback on a port the system draws, every layer on a stepping clock from `wall`.
pub(crate) async fn play(case: &Value, wall: SystemTime) -> Result<(), String> {
    let steps = case
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("a case holds its steps")?;
    // the clock every layer runs on: only a step that moves time moves it; a platform's own timers,
    // a ping's among them, stay on the real clock
    let clock = SteppingClock::new(wall);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let told = Arc::new(Told::default());
    let server = server_of(case, (&shared, &told))?;
    let mut start = TransportServerStartOptions::default();

    start.address = Some(HOST.to_string());
    start.find_open_port = Some(true);

    let started = server
        .transport()
        .start(&start)
        .await
        .map_err(|error| error.to_string())?;
    let mut played = Played {
        clock,
        server,
        told,
        exchanges: HashMap::new(),
        values: HashMap::from([("host".to_owned(), format!("{HOST}:{}", started.port))]),
        port: started.port,
        answers_pings: case.get("answersPings") != Some(&Value::Bool(false)),
        is_stopped: false,
    };
    let outcome = play_steps(&mut played, steps).await;

    for exchange in played.exchanges.values() {
        exchange.destroy();
    }

    let stopped = if played.is_stopped {
        Ok(())
    } else {
        played
            .server
            .dispose()
            .await
            .map_err(|error| format!("its stop: {error}"))
    };

    outcome.and(stopped)
}
