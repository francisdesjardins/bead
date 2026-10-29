//! `spec/transports.json`'s cases over a broker (spec 15.16 to 15.24), played against the Rust
//! side's broker transports over the in-memory broker: in the server role, the interop service's
//! server on a broker server transport over the participant `server`; in the client role, a broker
//! client transport alone over the participant `client`; the case's peers, adapters of the same
//! broker, publishing parcels and reading their inboxes. A trial a case; the cases over HTTP,
//! WebSocket, MQTT 5 and AMQP 1.0 are ahead, with the stages that bring their transports.

#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a native target: its trials run on tokio's timers and measure on std's instant"
)]

#[expect(
    dead_code,
    reason = "the cases read envelopes and limits as the conversations do, and play none"
)]
#[path = "players/conversation.rs"]
mod conversation;

use core::time::Duration;
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime};

use bead::testing::parcels::{self, ParcelFields, ParcelReading};
use bead::testing::{SteppingClock, files, hexadecimal, instants};
use bead::{
    BoxFuture, BrokerAdapter, BrokerCapabilities, BrokerClient, BrokerClientOptions,
    BrokerConnectOptions, BrokerDelivery, BrokerError, BrokerListener, BrokerMessage,
    BrokerParticipant, BrokerParticipantOptions, BrokerPublication, BrokerPublished,
    BrokerRefusedError, BrokerServer, BrokerServerOptions, BrokerStart, BrokerSubscription,
    ClientListener, ClientTransport, ConnectionHandle, MemoryBroker, MemoryBrokerAdapter,
    MemoryBrokerAdapterOptions, MemoryBrokerOptions, RouterError, Server, ServerListener,
    ServerOptions, ServerTransport, SharedClock, TransportError, TransportMessage,
    TransportServerRefusal,
};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde_json::{Map, Value, json};

// how long a step waits, on the real clock, for what it awaits, unless it says
const PATIENCE: Duration = Duration::from_secs(10);

// how often it looks again
const POLL: Duration = Duration::from_millis(5);

// a grace past the last OPEN placed, for one placed twice
const PLACED_GRACE: Duration = Duration::from_millis(100);

const ROOT: &str = "bead";

// ! every key of a case and of a step this player reads: one it does not know fails the case,
// rather than pass it unplayed
const CASE_KEYS: [&str; 9] = [
    "clauses",
    "limits",
    "name",
    "options",
    "peers",
    "realTime",
    "role",
    "steps",
    "transport",
];

const STEP_KEYS: [&str; 19] = [
    "advance",
    "at",
    "connect",
    "expect",
    "from",
    "leave",
    "lose",
    "on",
    "publish",
    "refused",
    "reported",
    "retained",
    "stop",
    "takeover",
    "to",
    "transportSend",
    "until",
    "wait",
    "within",
];

// the keys that modify a step's act rather than make one
const MODIFIERS: [&str; 7] = ["at", "from", "on", "refused", "retained", "to", "within"];

const OPTION_KEYS: [&str; 15] = [
    "acceptTimeout",
    "bodyGracePeriod",
    "group",
    "heartbeat",
    "heldBytesBudget",
    "maximumConnections",
    "maximumConnectionsPerAddress",
    "maximumEnvelopePartsBytes",
    "maximumQueuedMessages",
    "maximumUnsentBytes",
    "minimumBodyBytesPerSecond",
    "names",
    "timeout",
    "twin",
    "wills",
];

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// when a wait of `within` from now ends, on the real clock
fn deadline_of(within: Duration) -> Instant {
    let now = Instant::now();

    now.checked_add(within).unwrap_or(now)
}

fn hold<S: FnOnce() -> String>(holds: bool, said: S) -> Result<(), String> {
    if holds { Ok(()) } else { Err(said()) }
}

fn topic_of(tokens: [&str; 3]) -> Vec<String> {
    tokens.iter().map(|token| (*token).to_owned()).collect()
}

fn hexadecimal_of(text: &str) -> Result<String, String> {
    hexadecimal::bytes_of(text)
        .map(|bytes| hexadecimal::text_of(&bytes))
        .ok_or_else(|| format!("{text:?} is no hexadecimal"))
}

// hexadecimal with each `{name}` put in as the value captured under it
fn filled_of(text: &str, values: &HashMap<String, String>) -> Result<String, String> {
    let mut filled = String::new();
    let mut rest = text;

    while let Some(start) = rest.find('{') {
        let (before, after) = rest.split_at(start);
        let end = after
            .find('}')
            .ok_or_else(|| format!("a capture's name is not closed in {text}"))?;
        let name = after.get(1..end).unwrap_or_default();
        let value = values
            .get(name)
            .ok_or_else(|| format!("nothing captured under {name}"))?;

        filled.push_str(before);
        filled.push_str(value);
        rest = after.get(end.saturating_add(1)..).unwrap_or_default();
    }

    filled.push_str(rest);

    Ok(filled)
}

// ── The recording adapter ────────────────────────────────────────────────────────────────────

// the life the participant asks of each publication, by what it carries: an OPEN's, a DATA's that
// carries a credential, every other's
#[derive(Debug, Default)]
struct Lives {
    open: Vec<Option<u128>>,
    credential: Vec<Option<u128>>,
    other: Vec<Option<u128>>,
}

// the adapter under test wrapped, each publication's life noted as it goes
#[derive(Debug)]
struct Recording {
    inner: MemoryBrokerAdapter,
    lives: Mutex<Lives>,
}

impl Recording {
    // for each sort, the one life every publication of it was asked, or what was seen
    fn lives(&self) -> Value {
        let lives = locked(&self.lives);
        let of = |seen: &[Option<u128>]| {
            let mut distinct: Vec<Option<u128>> = Vec::new();

            for life in seen {
                if !distinct.contains(life) {
                    distinct.push(*life);
                }
            }

            match distinct.as_slice() {
                [one] => json!(one),
                _ => json!(distinct),
            }
        };

        json!({ "open": of(&lives.open), "credential": of(&lives.credential), "other": of(&lives.other) })
    }
}

impl BrokerAdapter for Recording {
    fn transport_type(&self) -> &str {
        self.inner.transport_type()
    }

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.inner.capabilities()
    }

    fn delivery(&self) -> BrokerDelivery {
        self.inner.delivery()
    }

    fn is_secure(&self) -> bool {
        self.inner.is_secure()
    }

    fn receive_bound(&self, topic: &[String]) -> u64 {
        self.inner.receive_bound(topic)
    }

    fn maximum_payload_bytes(&self, topic: &[String]) -> u64 {
        self.inner.maximum_payload_bytes(topic)
    }

    fn listen(&self, listener: Arc<dyn BrokerListener>) {
        self.inner.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        self.inner.unlisten(listener);
    }

    fn start(&self, options: BrokerStart) -> BoxFuture<Result<(), BrokerError>> {
        self.inner.start(options)
    }

    fn subscribe(
        &self,
        topic: &[String],
        options: BrokerSubscription,
    ) -> BoxFuture<Result<(), BrokerError>> {
        self.inner.subscribe(topic, options)
    }

    fn unsubscribe(&self, topic: &[String]) -> BoxFuture<Result<(), BrokerError>> {
        self.inner.unsubscribe(topic)
    }

    fn publish(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        let life = publication.expires_after.map(|life| life.as_millis());
        let parcel = parcels::read(&publication.payload);
        let mut lives = locked(&self.lives);
        let sort = match &parcel {
            ParcelReading::Parcel(fields) if fields.kind == 1 => &mut lives.open,
            ParcelReading::Parcel(fields) if fields.kind == 4 && fields.credential.is_some() => {
                &mut lives.credential
            }
            ParcelReading::Parcel(_)
            | ParcelReading::NoParcel(_)
            | ParcelReading::DoesNotRead(..) => &mut lives.other,
        };

        sort.push(life);
        drop(lives);

        self.inner.publish(publication)
    }

    fn stop(&self) -> BoxFuture<()> {
        self.inner.stop()
    }
}

// ── The peers ────────────────────────────────────────────────────────────────────────────────

// what a peer was handed, in order: on its inbox or the server's name, and at the departure of
// the participant under test
#[derive(Default)]
struct Heard {
    heard: Mutex<VecDeque<Bytes>>,
    departed: Mutex<VecDeque<Bytes>>,
}

struct PeerHearing {
    heard: Arc<Heard>,
    departure: String,
}

impl BrokerListener for PeerHearing {
    fn on_message(&self, message: &BrokerMessage) {
        message.settle();

        let queue = if message.topic().join("/") == self.departure {
            &self.heard.departed
        } else {
            &self.heard.heard
        };

        locked(queue).push_back(message.payload().clone());
    }
}

struct Peer {
    adapter: MemoryBrokerAdapter,
    heard: Arc<Heard>,
}

// the next message a peer is handed, or none within `within`: on its inbox or the server's name,
// or, at the departure, on the departure of the participant under test
async fn next_of(peer: &Peer, (at_departure, within): (bool, Duration)) -> Option<Bytes> {
    let deadline = deadline_of(within);

    loop {
        let queue = if at_departure {
            &peer.heard.departed
        } else {
            &peer.heard.heard
        };

        let next = locked(queue).pop_front();

        if next.is_some() {
            return next;
        }

        if Instant::now() >= deadline {
            return None;
        }

        tokio::time::sleep(POLL).await;
    }
}

// a peer of the case's own: started, a will left where `will` names its incarnation, its inbox
// subscribed; in the client role the server's name `interop` as well, and the departure of the
// participant under test
async fn peer_of(
    broker: &MemoryBroker,
    (id, under, is_client, will): (&str, &str, bool, Option<&str>),
) -> Result<Peer, String> {
    let adapter = broker
        .adapter(&MemoryBrokerAdapterOptions::of(id))
        .map_err(|error| error.to_string())?;
    let heard = Arc::new(Heard::default());

    adapter.listen(Arc::new(PeerHearing {
        heard: Arc::clone(&heard),
        departure: format!("{ROOT}/d/{under}"),
    }));

    let mut start = BrokerStart::default();

    if let Some(incarnation) = will {
        let gone = ParcelFields {
            layout: 0xB1,
            kind: 9,
            flags: Some(0),
            opener: "00 00 00 00 00 00 00 00".to_owned(),
            acceptor: "00 00 00 00 00 00 00 00".to_owned(),
            sequence: 0,
            id: Some(id.to_owned()),
            incarnation: Some(incarnation.to_owned()),
            bound: None,
            status: None,
            layouts: None,
            credential: None,
            carried: None,
            answers: None,
            code: None,
        };

        start.will = Some(BrokerPublication::of(
            [ROOT, "d", id],
            Bytes::from(parcels::encode(&gone)?),
        ));
    }

    adapter
        .start(start)
        .await
        .map_err(|error| error.to_string())?;

    let mut topics = vec![topic_of([ROOT, "i", id])];

    // * in the client role a peer plays the server: its name, and its departure where a will is
    // left
    if is_client {
        topics.push(topic_of([ROOT, "s", "interop"]));
        topics.push(topic_of([ROOT, "d", under]));
    }

    for topic in topics {
        adapter
            .subscribe(&topic, BrokerSubscription::default())
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(Peer { adapter, heard })
}

// the incarnation each peer's OPENs name in `steps`, which its will names where a case asks one
fn wills_of(steps: &[Value]) -> HashMap<String, String> {
    let mut wills = HashMap::new();

    for step in steps {
        let Some(from) = step.get("from").and_then(Value::as_str) else {
            continue;
        };

        for item in step
            .get("publish")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(incarnation) = item
                .get("parcel")
                .and_then(|parcel| parcel.get("incarnation"))
                .and_then(Value::as_str)
            {
                wills
                    .entry(from.to_owned())
                    .or_insert_with(|| incarnation.to_owned());
            }
        }
    }

    wills
}

// ── The parcels ──────────────────────────────────────────────────────────────────────────────

fn field_text(
    fields: &Map<String, Value>,
    (name, values): (&str, &HashMap<String, String>),
) -> Result<Option<String>, String> {
    match fields.get(name) {
        None => Ok(None),
        Some(Value::String(text)) => filled_of(text, values).map(Some),
        Some(other) => Err(format!(
            "a parcel published names no capture: {name} {other}"
        )),
    }
}

fn u64_of(fields: &Map<String, Value>, name: &str) -> Option<u64> {
    fields.get(name).and_then(Value::as_u64)
}

// the bytes a case's parcel writes, by this side's codec, held to nothing
fn parcel_bytes_of(
    fields: &Map<String, Value>,
    values: &HashMap<String, String>,
) -> Result<Vec<u8>, String> {
    let carried = match (fields.get("envelope"), fields.get("part")) {
        (Some(Value::String(envelope)), _) => Some(hexadecimal_of(envelope)?),
        (_, Some(Value::String(part))) => Some(hexadecimal_of(part)?),
        _ => None,
    };
    let byte_of = |name: &str| u64_of(fields, name).and_then(|value| u8::try_from(value).ok());
    let parcel = ParcelFields {
        layout: byte_of("layout").unwrap_or(0xB1),
        kind: byte_of("kind").ok_or("a parcel names its kind")?,
        flags: byte_of("flags"),
        opener: field_text(fields, ("opener", values))?
            .unwrap_or_else(|| "00 00 00 00 00 00 00 00".to_owned()),
        acceptor: field_text(fields, ("acceptor", values))?
            .unwrap_or_else(|| "00 00 00 00 00 00 00 00".to_owned()),
        sequence: u64_of(fields, "sequence").ok_or("a parcel names its sequence")?,
        id: fields.get("id").and_then(Value::as_str).map(str::to_owned),
        incarnation: field_text(fields, ("incarnation", values))?,
        bound: u64_of(fields, "bound"),
        status: u64_of(fields, "status").and_then(|status| u16::try_from(status).ok()),
        layouts: fields
            .get("layouts")
            .and_then(Value::as_array)
            .map(|layouts| {
                layouts
                    .iter()
                    .filter_map(|layout| {
                        layout.as_u64().and_then(|layout| u8::try_from(layout).ok())
                    })
                    .collect()
            }),
        credential: fields
            .get("credential")
            .and_then(Value::as_str)
            .map(str::to_owned),
        carried,
        answers: u64_of(fields, "answers"),
        code: u64_of(fields, "code").and_then(|code| u16::try_from(code).ok()),
    };

    parcels::encode(&parcel)
}

// a half or an incarnation as `expected` names it: the expected value, its `{name}` put in, or the
// capture it matched in shape and unlike the one it names, which `values` keeps; else itself
fn bytes_seen(
    (expected, actual): (Option<&Value>, &str),
    (values, captures): (&HashMap<String, String>, &mut Vec<(String, String)>),
) -> Result<Value, String> {
    let actual = hexadecimal_of(actual)?;

    match expected {
        Some(Value::Object(want)) => {
            let shape = want
                .get("shape")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let bytes = hexadecimal::bytes_of(&actual).unwrap_or_default();
            let length = if shape == "half" { 8 } else { 16 };
            let is_shaped = bytes.len() == length
                && (shape != "half" || bytes.iter().any(|byte| *byte != 0))
                && want
                    .get("unlike")
                    .and_then(Value::as_str)
                    .is_none_or(|unlike| values.get(unlike) != Some(&actual));

            if is_shaped {
                let name = want
                    .get("capture")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                captures.push((name.to_owned(), actual));

                Ok(Value::Object(want.clone()))
            } else {
                Ok(json!(actual))
            }
        }
        Some(Value::String(want)) if hexadecimal_of(&filled_of(want, values)?)? == actual => {
            Ok(json!(want))
        }
        Some(_) | None => Ok(json!(actual)),
    }
}

// what a message reads as, in the terms `expected` names it by
fn seen_of(
    payload: &[u8],
    (expected, values): (&Map<String, Value>, &mut HashMap<String, String>),
) -> Result<Value, String> {
    let read = match parcels::read(payload) {
        ParcelReading::Parcel(read) => read,
        ParcelReading::NoParcel(reason) | ParcelReading::DoesNotRead(_, reason) => {
            return Ok(json!({ "bytes": hexadecimal::text_of(payload), "refused": reason }));
        }
    };
    let mut captures = Vec::new();
    let mut seen = Map::new();

    seen.insert("kind".to_owned(), json!(read.kind));

    if let Some(flags) = read.flags {
        seen.insert("flags".to_owned(), json!(flags));
    }

    seen.insert("sequence".to_owned(), json!(read.sequence));
    seen.insert(
        "opener".to_owned(),
        bytes_seen(
            (expected.get("opener"), &read.opener),
            (values, &mut captures),
        )?,
    );
    seen.insert(
        "acceptor".to_owned(),
        bytes_seen(
            (expected.get("acceptor"), &read.acceptor),
            (values, &mut captures),
        )?,
    );

    if let Some(incarnation) = &read.incarnation {
        seen.insert(
            "incarnation".to_owned(),
            bytes_seen(
                (expected.get("incarnation"), incarnation),
                (values, &mut captures),
            )?,
        );
    }

    for (name, value) in [
        ("id", read.id.map(|id| json!(id))),
        ("bound", read.bound.map(|bound| json!(bound))),
        ("status", read.status.map(|status| json!(status))),
        ("layouts", read.layouts.map(|layouts| json!(layouts))),
        (
            "credential",
            read.credential.map(|credential| json!(credential)),
        ),
        ("answers", read.answers.map(|answers| json!(answers))),
        ("code", read.code.map(|code| json!(code))),
    ] {
        if let Some(value) = value {
            seen.insert(name.to_owned(), value);
        }
    }

    if let Some(carried) = &read.carried {
        let bytes = Bytes::from(hexadecimal::bytes_of(carried).unwrap_or_default());

        match expected.get("envelope") {
            Some(want @ Value::Object(_)) => {
                let actual = conversation::actual_of(Some(&bytes), want)
                    .unwrap_or_else(|| json!(hexadecimal::text_of(&bytes)));

                seen.insert("envelope".to_owned(), actual);
            }
            Some(_) => {
                seen.insert("envelope".to_owned(), json!(carried));
            }
            None => {
                seen.insert("part".to_owned(), json!(carried));
            }
        }
    }

    for (name, hex) in captures {
        values.entry(name).or_insert(hex);
    }

    Ok(Value::Object(seen))
}

// `expected` as `seen_of` shows a match: its envelope's and its part's bytes as the codec writes them
fn expected_seen_of(expected: &Map<String, Value>) -> Result<Value, String> {
    let mut seen = expected.clone();

    for name in ["envelope", "part"] {
        if let Some(Value::String(text)) = expected.get(name) {
            seen.insert(name.to_owned(), json!(hexadecimal_of(text)?));
        }
    }

    Ok(Value::Object(seen))
}

// ── The side under test ──────────────────────────────────────────────────────────────────────

// what the transport under test told, reported and the server's router reported
#[derive(Default)]
struct Told {
    reports: Mutex<Vec<Value>>,
    refusals: Mutex<VecDeque<TransportServerRefusal>>,
    errors: Mutex<VecDeque<(String, Option<ConnectionHandle>)>>,
    closes: Mutex<Vec<(Option<String>, bool)>>,
    received: Mutex<VecDeque<Bytes>>,
}

// the participant a handle names, as the server draws it
fn participant_of_handle(handle: &str) -> Option<String> {
    handle
        .split(';')
        .find_map(|part| part.strip_prefix("participant="))
        .map(str::to_owned)
}

struct AtServer(Arc<Told>);

impl ServerListener for AtServer {
    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.0.closes).push((participant_of_handle(connection_handle), was_clean));
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        locked(&self.0.refusals).push_back(refusal.clone());
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        locked(&self.0.errors).push_back((error.to_string(), connection_handle.cloned()));
    }
}

struct AtClient(Arc<Told>);

impl ClientListener for AtClient {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.0.received).push_back(message.data);
    }

    fn on_close(&self, was_clean: bool, _is_quick: bool) {
        locked(&self.0.closes).push((None, was_clean));
    }

    fn on_error(&self, error: &RouterError) {
        locked(&self.0.errors).push_back((error.to_string(), None));
    }
}

async fn next_in<T, F: Fn() -> Option<T>>(take: F, within: Duration) -> Option<T> {
    let deadline = deadline_of(within);

    loop {
        if let Some(next) = take() {
            return Some(next);
        }

        if Instant::now() >= deadline {
            return None;
        }

        tokio::time::sleep(POLL).await;
    }
}

async fn poll_within<F: Fn() -> bool>(holds: F) -> bool {
    let deadline = deadline_of(PATIENCE);

    while !holds() && Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
    }

    holds()
}

fn duration_of(options: &Map<String, Value>, name: &str) -> Option<Duration> {
    options
        .get(name)
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
}

// what a case built, as its steps reach it
struct Case {
    clock: Arc<SteppingClock>,
    recording: Arc<Recording>,
    participant: BrokerParticipant,
    server: Option<(Server, BrokerServer)>,
    client: Option<BrokerClient>,
    connecting: Option<tokio::task::JoinHandle<Result<(), TransportError>>>,
    peers: HashMap<String, Peer>,
    twin: Option<Peer>,
    told: Arc<Told>,
    adapters: HashMap<String, MemoryBrokerAdapter>,
    // the connect's time, in the client role
    timeout: Option<Duration>,
}

fn options_of(case: &Value) -> Map<String, Value> {
    case.get("options")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[expect(
    clippy::too_many_lines,
    reason = "the side under test built in its role, its peers and its twin, as the other sides' players build them"
)]
async fn case_of((case, wall): (&Value, SystemTime)) -> Result<Case, String> {
    let options = options_of(case);
    let is_client = case.get("role").and_then(Value::as_str) == Some("client");
    let under = if is_client { "client" } else { "server" };
    let clock = SteppingClock::new(wall);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let mut broker_options = MemoryBrokerOptions::default();

    broker_options.clock = Some(Arc::clone(&shared));
    broker_options.maximum_queued_messages =
        options.get("maximumQueuedMessages").and_then(Value::as_u64);

    let broker = MemoryBroker::new(&broker_options).map_err(|error| error.to_string())?;
    let inner = broker
        .adapter(&MemoryBrokerAdapterOptions::of(under))
        .map_err(|error| error.to_string())?;
    let mut adapters = HashMap::new();

    adapters.insert(under.to_owned(), inner.clone());

    let recording = Arc::new(Recording {
        inner,
        lives: Mutex::new(Lives::default()),
    });
    let limits = conversation::limits_of(case)?;
    let mut participant_options = BrokerParticipantOptions::default();

    participant_options.clock = Some(Arc::clone(&shared));
    participant_options.heartbeat = duration_of(&options, "heartbeat");
    participant_options.body_grace_period = duration_of(&options, "bodyGracePeriod");
    participant_options.held_bytes_budget = options.get("heldBytesBudget").and_then(Value::as_u64);
    participant_options.maximum_envelope_parts_bytes = options
        .get("maximumEnvelopePartsBytes")
        .and_then(Value::as_u64)
        .or(limits.maximum_envelope_bytes);
    participant_options.minimum_body_bytes_per_second = options
        .get("minimumBodyBytesPerSecond")
        .and_then(Value::as_u64);
    participant_options.is_reconnecting = Some(!is_client);

    let adapter: Arc<dyn BrokerAdapter> = Arc::<Recording>::clone(&recording);
    let participant =
        BrokerParticipant::new(adapter, &participant_options).map_err(|error| error.to_string())?;
    let told = Arc::new(Told::default());
    let mut server = None;
    let mut client = None;
    let mut twin = None;

    if is_client {
        let built = participant
            .client(&BrokerClientOptions::default())
            .map_err(|error| error.to_string())?;

        built.listen(Arc::new(AtClient(Arc::clone(&told))));
        client = Some(built);
    } else {
        let names: Vec<String> = options.get("names").and_then(Value::as_array).map_or_else(
            || vec!["interop".to_owned()],
            |names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            },
        );
        let mut transport_options = BrokerServerOptions::of(names.clone());

        transport_options.accept_timeout = duration_of(&options, "acceptTimeout");
        transport_options.is_in_group = options.get("group").and_then(Value::as_bool);
        transport_options.maximum_connections =
            options.get("maximumConnections").and_then(Value::as_u64);
        transport_options.maximum_connections_per_address = options
            .get("maximumConnectionsPerAddress")
            .and_then(Value::as_u64);
        transport_options.maximum_unsent_bytes =
            options.get("maximumUnsentBytes").and_then(Value::as_u64);

        let transport = participant
            .server(&transport_options)
            .map_err(|error| error.to_string())?;
        let mut server_options = ServerOptions::default();

        server_options.clock = Some(Arc::clone(&shared));
        server_options.credentials = Some(
            bead_interop::interop_credentials_of(&shared, Some(&limits))
                .map_err(|error| error.to_string())?,
        );
        server_options.limits = Some(limits);

        let facade = Server::new(Arc::new(transport.clone()), &server_options)
            .map_err(|error| error.to_string())?;
        let reporting = Arc::clone(&told);

        facade.router().on_error(Arc::new(
            move |error: &RouterError, _handle: Option<&ConnectionHandle>| {
                let code = match error {
                    RouterError::Failure(failure) => json!(failure.code().get()),
                    RouterError::Other(_) | _ => json!("exception"),
                };

                locked(&reporting.reports).push(code);
            },
        ));
        transport.listen(Arc::new(AtServer(Arc::clone(&told))));
        bead_interop::offer_interop(&facade).map_err(|error| error.to_string())?;

        // * a twin serves the names in their group beside the server, reading each OPEN it is
        // handed
        if let Some(id) = options.get("twin").and_then(Value::as_str) {
            let peer = peer_of(&broker, (id, under, false, None)).await?;

            for name in &names {
                let mut subscription = BrokerSubscription::default();

                subscription.group = Some(name.clone());

                peer.adapter
                    .subscribe(&topic_of([ROOT, "s", name]), subscription)
                    .await
                    .map_err(|error| error.to_string())?;
            }

            adapters.insert(id.to_owned(), peer.adapter.clone());
            twin = Some(peer);
        }

        transport.start().await.map_err(|error| error.to_string())?;
        server = Some((facade, transport));
    }

    let wills = if options.get("wills") == Some(&Value::Bool(true)) {
        case.get("steps")
            .and_then(Value::as_array)
            .map(|steps| wills_of(steps))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    let ids: Vec<String> = case.get("peers").and_then(Value::as_array).map_or_else(
        || vec!["peer".to_owned()],
        |peers| {
            peers
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        },
    );
    let mut peers = HashMap::new();

    for id in ids {
        let peer = peer_of(
            &broker,
            (&id, under, is_client, wills.get(&id).map(String::as_str)),
        )
        .await?;

        adapters.insert(id.clone(), peer.adapter.clone());
        peers.insert(id, peer);
    }

    Ok(Case {
        clock,
        recording,
        participant,
        server,
        client,
        connecting: None,
        peers,
        twin,
        told,
        adapters,
        timeout: duration_of(&options, "timeout"),
    })
}

impl Case {
    fn peer(&self, id: &str) -> Result<&Peer, String> {
        self.peers
            .get(id)
            .ok_or_else(|| format!("no peer {id} in the case"))
    }

    fn nothing_reported(&self, when: &str) -> Result<(), String> {
        let reports = locked(&self.told.reports).clone();
        let refusals: Vec<TransportServerRefusal> =
            locked(&self.told.refusals).iter().cloned().collect();
        let errors: Vec<String> = locked(&self.told.errors)
            .iter()
            .map(|(message, _)| message.clone())
            .collect();

        hold(
            reports.is_empty() && refusals.is_empty() && errors.is_empty(),
            || format!("{when}: reported {reports:?}, told {refusals:?}, and {errors:?}"),
        )
    }

    // what a peer publishes in one turn, each in its order, none awaited before the next
    async fn publish(
        &self,
        (step, values): (&Value, &HashMap<String, String>),
    ) -> Result<Vec<BrokerPublished>, String> {
        let from = step.get("from").and_then(Value::as_str).unwrap_or("peer");
        let peer = self.peer(from)?;
        let topic = match step.get("to").and_then(Value::as_str) {
            Some("departure") => topic_of([ROOT, "d", from]),
            Some("inbox") => topic_of([
                ROOT,
                "i",
                if self.client.is_some() {
                    "client"
                } else {
                    "server"
                },
            ]),
            Some("name") => topic_of([ROOT, "s", "interop"]),
            other => return Err(format!("a publication to {other:?}")),
        };
        let is_retained = step.get("retained") == Some(&Value::Bool(true));
        let mut publishing = Vec::new();

        for item in step
            .get("publish")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let payload = match (item.get("parcel"), item.get("bytes")) {
                (Some(Value::Object(fields)), _) => parcel_bytes_of(fields, values)?,
                (_, Some(Value::String(bytes))) => {
                    hexadecimal::bytes_of(&filled_of(bytes, values)?)
                        .ok_or("bytes that are no hexadecimal")?
                }
                _ => {
                    return Err(format!(
                        "a publication of neither a parcel nor bytes: {item}"
                    ));
                }
            };
            let publication = BrokerPublication::of(topic.clone(), Bytes::from(payload));

            publishing.push(if is_retained {
                peer.adapter.publish_retained(publication)
            } else {
                peer.adapter.publish(publication)
            });
        }

        let mut published = Vec::new();

        for each in publishing {
            published.push(each.await.map_err(|error| error.to_string())?);
        }

        Ok(published)
    }

    fn gauge(&self, name: &str) -> Option<u64> {
        if name == "unsettled" {
            return Some(self.recording.inner.unsettled());
        }

        self.server
            .as_ref()
            .and_then(|(_, transport)| transport.gauges())
            .and_then(|gauges| gauges.counts.get(name).copied())
    }

    async fn stop(&self) {
        for peer in self.peers.values().chain(self.twin.as_ref()) {
            peer.adapter.stop().await;
        }

        if let Some((facade, transport)) = &self.server {
            transport.stop().await;
            facade.dispose().await;
        }

        if let Some(client) = &self.client {
            client.close();
        }

        self.participant.stop().await;
    }
}

// the server's ACCEPT, or the twin's OPEN, naming an opener's half, placed with it
fn take_placed(
    placed: &mut [(String, Vec<&'static str>)],
    (message, kind, where_): (Option<Bytes>, u8, &'static str),
) {
    if let Some(message) = message
        && let ParcelReading::Parcel(read) = parcels::read(&message)
        && read.kind == kind
        && let Some((_, places)) = placed.iter_mut().find(|(opener, _)| *opener == read.opener)
    {
        places.push(where_);
    }
}

// where each OPEN of `openers` went, read on the peer's inbox, the server's ACCEPT naming it, and on
// the twin's, the OPEN itself: once each was placed, a grace for one placed twice
async fn placed_of(
    case: &Case,
    (on, openers, within): (&str, &[String], Duration),
) -> Result<Vec<Vec<&'static str>>, String> {
    let peer = case.peer(on)?;
    let twin = case
        .twin
        .as_ref()
        .ok_or("a case that places names its twin")?;
    let mut placed: Vec<(String, Vec<&'static str>)> = openers
        .iter()
        .map(|opener| hexadecimal_of(opener).map(|opener| (opener, Vec::new())))
        .collect::<Result<_, _>>()?;
    let deadline = deadline_of(within);

    while placed.iter().any(|(_, places)| places.is_empty()) && Instant::now() < deadline {
        let server = next_of(peer, (false, POLL)).await;
        let from_twin = next_of(twin, (false, POLL)).await;

        take_placed(&mut placed, (server, 2, "server"));
        take_placed(&mut placed, (from_twin, 1, "twin"));
    }

    let grace = deadline_of(PLACED_GRACE);

    while Instant::now() < grace {
        let server = next_of(peer, (false, POLL)).await;
        let from_twin = next_of(twin, (false, POLL)).await;

        take_placed(&mut placed, (server, 2, "server"));
        take_placed(&mut placed, (from_twin, 1, "twin"));
    }

    Ok(placed.into_iter().map(|(_, places)| places).collect())
}

// what a connect settled to, as a case reads it
fn connect_seen(outcome: &Result<(), TransportError>) -> Value {
    match outcome {
        Ok(()) => json!({ "opened": true }),
        Err(TransportError::Connect(error)) => {
            let refused = std::error::Error::source(error)
                .and_then(|source| source.downcast_ref::<BrokerRefusedError>());

            refused.map_or_else(
                || json!({ "error": error.to_string() }),
                |refused| {
                    let mut failed = Map::new();

                    if let Some(layouts) = refused.layouts() {
                        failed.insert("layouts".to_owned(), json!(layouts));
                    }

                    failed.insert("reason".to_owned(), json!(refused.reason()));

                    if let Some(status) = refused.status() {
                        failed.insert("status".to_owned(), json!(status));
                    }

                    json!({ "failed": failed })
                },
            )
        }
        Err(other) => json!({ "error": other.to_string() }),
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one branch per step's key, as the player of each side reads them"
)]
async fn play_steps(case: &mut Case, steps: &[Value]) -> Result<(), String> {
    let mut values: HashMap<String, String> = HashMap::new();
    let is_client = case.client.is_some();

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
        hold(acts == 1, || format!("{at}: {acts} acts, not one"))?;

        let within = step
            .get("within")
            .and_then(Value::as_u64)
            .map_or(PATIENCE, Duration::from_millis);
        let on = step.get("on").and_then(Value::as_str).unwrap_or("peer");

        if step.get("publish").is_some() || step.get("stop").is_some() {
            case.nothing_reported(&format!("before {at}"))?;
        }

        if step.get("publish").is_some() {
            let published = case.publish((step, &values)).await?;
            let expected = match step.get("refused").and_then(Value::as_str) {
                Some("no-subscriber") => BrokerPublished::NoSubscriber,
                _ => BrokerPublished::Taken,
            };

            hold(published.iter().all(|each| *each == expected), || {
                format!("{at}: the broker said {published:?}")
            })?;
        }

        if let Some(stop) = step.get("stop") {
            // * what crosses the stop is published in the turn it begins, before it
            let crossing = stop
                .get("crossing")
                .map(|crossing| case.publish((crossing, &values)));
            let stopping = case.server.as_ref().map(|(_, transport)| transport.stop());

            if let Some(crossing) = crossing {
                crossing.await?;
            }

            if let Some(stopping) = stopping {
                stopping.await;
            }
        }

        if let Some(wait) = step.get("wait").and_then(Value::as_u64) {
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }

        if let Some(id) = step.get("lose").and_then(Value::as_str) {
            case.adapters
                .get(id)
                .ok_or_else(|| format!("{at}: no participant {id}"))?
                .lose();
        }

        if let Some(id) = step.get("takeover").and_then(Value::as_str) {
            case.adapters
                .get(id)
                .ok_or_else(|| format!("{at}: no participant {id}"))?
                .take_over();
        }

        if let Some(id) = step.get("leave").and_then(Value::as_str) {
            case.peer(id)?
                .adapter
                .unsubscribe(&topic_of([ROOT, "i", id]))
                .await
                .map_err(|error| error.to_string())?;
        }

        if let Some(server) = step.get("connect").and_then(Value::as_str)
            && let Some(client) = &case.client
        {
            let mut options = BrokerConnectOptions::of(server);

            options.timeout = case.timeout;
            case.connecting = Some(tokio::spawn(client.connect(options)));
        }

        if let Some(send) = step.get("transportSend")
            && let Some(client) = &case.client
        {
            let envelope = send
                .get("envelope")
                .and_then(Value::as_str)
                .and_then(hexadecimal::bytes_of)
                .ok_or("a send's envelope")?;

            client
                .send(TransportMessage {
                    data: Bytes::from(envelope),
                    credential: send
                        .get("credential")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    ..TransportMessage::default()
                })
                .map_err(|error| format!("{at}: {error}"))?;
        }

        let expectation = step.get("expect").and_then(Value::as_object);

        if let Some(expected) = expectation
            .and_then(|expected| expected.get("parcel"))
            .and_then(Value::as_object)
        {
            let peer = case.peer(on)?;
            let at_departure = step.get("at").and_then(Value::as_str) == Some("departure");
            let message = next_of(peer, (at_departure, within)).await;
            let seen = match &message {
                None => json!(format!("nothing within {} ms", within.as_millis())),
                Some(payload) => seen_of(payload, (expected, &mut values))?,
            };
            let wanted = expected_seen_of(expected)?;

            hold(seen == wanted, || {
                format!("{at}: the parcel {on} reads, {seen}, not {wanted}")
            })?;

            if let Some(told) = expectation.and_then(|expected| expected.get("told")) {
                let refusal = next_in(|| locked(&case.told.refusals).pop_front(), PATIENCE).await;
                let address = told
                    .get("address")
                    .and_then(Value::as_str)
                    .map(|address| filled_of(address, &values))
                    .transpose()?;
                let seen = refusal.as_ref().map(|refusal| {
                    json!({
                        "status": refusal.status,
                        "reason": refusal.reason,
                        "address": refusal.address,
                    })
                });
                let wanted = json!({
                    "status": told.get("status"),
                    "reason": told.get("reason"),
                    "address": address,
                });

                hold(seen.as_ref() == Some(&wanted), || {
                    format!("{at}: the refusal told, {seen:?}, not {wanted}")
                })?;
                hold(
                    refusal.is_some_and(|refusal| {
                        refusal.authority.is_none()
                            && refusal.origin.is_none()
                            && refusal.port.is_none()
                    }),
                    || format!("{at}: what the refusal tells besides"),
                )?;
            }
        }

        if let Some(placed) = expectation.and_then(|expected| expected.get("placed")) {
            let openers: Vec<String> = placed
                .get("openers")
                .and_then(Value::as_array)
                .map(|openers| {
                    openers
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let places = placed_of(case, (on, &openers, within)).await?;

            hold(places.iter().all(|places| places.len() == 1), || {
                format!("{at}: where each OPEN was placed, {places:?}")
            })?;
        }

        if let Some(lives) = expectation.and_then(|expected| expected.get("lives")) {
            let seen = case.recording.lives();

            hold(seen == *lives, || {
                format!("{at}: the lives its adapter was asked, {seen}, not {lives}")
            })?;
        }

        if let Some(closed) = expectation.and_then(|expected| expected.get("closed")) {
            let is_theirs = |address: &Option<String>| is_client || address.as_deref() == Some(on);
            let close = next_in(
                || {
                    let mut closes = locked(&case.told.closes);
                    let found = closes.iter().position(|(address, _)| is_theirs(address))?;

                    Some(closes.remove(found))
                },
                within,
            )
            .await;
            let seen = close.map(|(_, was_clean)| json!({ "clean": was_clean }));

            hold(seen.as_ref() == Some(closed), || {
                format!("{at}: the close told, {seen:?}, not {closed}")
            })?;
        }

        if expectation.is_some_and(|expected| {
            expected.contains_key("opened") || expected.contains_key("failed")
        }) {
            let connecting = case.connecting.take().ok_or("no connect under way")?;
            let outcome = tokio::time::timeout(within, connecting)
                .await
                .map_err(|_late| format!("{at}: the connect did not settle"))?
                .map_err(|error| error.to_string())?;
            let seen = connect_seen(&outcome);
            let wanted = expectation
                .and_then(|expected| expected.get("failed"))
                .map_or_else(
                    || json!({ "opened": true }),
                    |failed| json!({ "failed": failed }),
                );

            hold(seen == wanted, || {
                format!("{at}: the connect, {seen}, not {wanted}")
            })?;
        }

        if let Some(received) = expectation.and_then(|expected| expected.get("received")) {
            let bytes = next_in(|| locked(&case.told.received).pop_front(), within).await;
            let seen = conversation::actual_of(bytes.as_ref(), received);

            hold(seen.as_ref() == Some(received), || {
                format!("{at}: the envelope received, {seen:?}, not {received}")
            })?;
        }

        if let Some(secure) = expectation.and_then(|expected| expected.get("secure")) {
            let seen = case.client.as_ref().map(ClientTransport::is_secure);

            hold(seen.as_ref() == secure.as_bool().as_ref(), || {
                format!("{at}: secure {seen:?}, not {secure}")
            })?;
        }

        if let Some(words) = step.get("reported").and_then(Value::as_array) {
            let reported = next_in(|| locked(&case.told.errors).pop_front(), PATIENCE)
                .await
                .ok_or_else(|| format!("{at}: nothing reported"))?;
            let (message, handle) = reported;
            let is_named = !is_client && step.get("on").is_some();
            let named = if is_named {
                handle.as_deref().and_then(participant_of_handle)
            } else {
                handle.as_deref().map(str::to_owned)
            };
            let wanted = is_named.then(|| on.to_owned());

            hold(named == wanted, || {
                format!("{at}: the connection reported, {named:?}, not {wanted:?}")
            })?;

            for word in words.iter().filter_map(Value::as_str) {
                hold(message.contains(word), || {
                    format!("{at}: the report {message:?} names no {word}")
                })?;
            }
        }

        if let Some(until) = step.get("until") {
            if let Some(timer) = until.get("timer").and_then(Value::as_u64) {
                let timer = Duration::from_millis(timer);
                let is_earliest = || {
                    let mut dues = case.clock.dues();

                    dues.sort_unstable();

                    matches!(dues.as_slice(), [first, rest @ ..] if *first == timer && rest.first() != Some(&timer))
                };

                hold(poll_within(is_earliest).await, || {
                    format!(
                        "{at}: the earliest timer armed, alone so due, among {:?}",
                        case.clock.dues()
                    )
                })?;
            } else {
                let gauge = until
                    .get("gauge")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let is = until.get("is").and_then(Value::as_u64);
                let value = || case.gauge(gauge);

                hold(poll_within(|| value() == is).await, || {
                    format!("{at}: {gauge} is {:?}, not {is:?}", value())
                })?;
            }
        }

        if let Some(advance) = step.get("advance").and_then(Value::as_u64) {
            case.clock.advance(Duration::from_millis(advance)).await;
        }
    }

    case.nothing_reported("at the end")
}

async fn play((case, wall): (&Value, SystemTime)) -> Result<(), String> {
    let keys: Vec<&String> = case
        .as_object()
        .map(|case| {
            case.keys()
                .filter(|key| !CASE_KEYS.contains(&key.as_str()))
                .collect()
        })
        .unwrap_or_default();

    hold(keys.is_empty(), || {
        format!("the keys of the case this player does not read: {keys:?}")
    })?;

    let options = options_of(case);
    let unread: Vec<&String> = options
        .keys()
        .filter(|key| !OPTION_KEYS.contains(&key.as_str()))
        .collect();

    hold(unread.is_empty(), || {
        format!("a case sets an option no test reads: {unread:?}")
    })?;

    let steps = case
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("a case holds its steps")?;
    let mut played = case_of((case, wall)).await?;
    let outcome = play_steps(&mut played, steps).await;

    played.stop().await;

    outcome
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: Value = files::read("transports.json")?;
    let wall = file
        .get("wallClock")
        .and_then(Value::as_str)
        .and_then(instants::instant_of)
        .ok_or("transports.json starts its cases at an instant")?;
    let cases: Vec<Arc<Value>> = file
        .get("cases")
        .and_then(Value::as_array)
        .ok_or("transports.json holds its cases")?
        .iter()
        .filter(|case| case.get("transport").and_then(Value::as_str) == Some("broker"))
        .cloned()
        .map(Arc::new)
        .collect();
    let mut trials = Vec::new();
    let count = cases.len();
    let names: HashSet<String> = cases
        .iter()
        .filter_map(|case| case.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();

    // no broker case a row of the support matrix excuses this side from: each played, once
    trials.push(Trial::test(
        "plays every broker case but those a row of the support matrix excuses this side from",
        move || {
            hold(count > 0 && names.len() == count, || {
                format!("{} names for {count} cases", names.len())
            })
            .map_err(Failed::from)
        },
    ));

    for case in cases {
        let name = case
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        trials.push(
            Trial::test(name, move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?;

                runtime.block_on(play((&case, wall))).map_err(Failed::from)
            })
            .with_kind("broker"),
        );
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();

    match trials() {
        Ok(trials) => libtest_mimic::run(&arguments, trials).exit_code(),
        Err(reason) => {
            let trial = Trial::test("spec/transports.json reads", move || Err(reason.into()));

            libtest_mimic::run(&arguments, vec![trial]).exit_code()
        }
    }
}
