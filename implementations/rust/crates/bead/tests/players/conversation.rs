//! A conversation of `spec/conversations.json`, or an exit of `spec/metrics.json`, played against
//! the Rust side's server of the interop service: what its clients send, what it sends back and
//! reports, and, for an exit, what moved in its registry's exposition. The TypeScript and C# sides'
//! players play the same files.

use core::time::Duration;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use bead::testing::{SteppingClock, hexadecimal};
use bead::{
    BoxFuture, BrokerAdapter, BrokerClient, BrokerClientOptions, BrokerConnectOptions,
    BrokerParticipant, BrokerParticipantOptions, BrokerServer, BrokerServerOptions, ClientListener,
    ClientTransport, ConnectionHandle, Credential, CredentialScheme, DisconnectOptions, Envelope,
    EnvelopeKind, MemoryBroker, MemoryBrokerAdapterOptions, MemoryBrokerOptions, MemoryClient,
    MemoryClientOptions, MemoryConnectOptions, MemoryServer, MemoryServerOptions, MetricsRegistry,
    NEVER, PacingLimitsOptions, ReadEnvelopeOptions, RelayOptions, RouterError,
    RouterLimitsOptions, RouterSide, Sent, Server, ServerListener, ServerOptions, ServerTransport,
    SharedClock, TransportMessage, read_envelope, require_credential, require_session,
    share_leg_b_session,
};
use bytes::Bytes;
use serde_json::{Map, Value, json};

// the connection a conversation that opens none plays, opened before its first step
const ONLY_CONNECTION: &str = "connection";

// ! every key of a step this player reads: one it does not know fails the step, rather than pass it
// unplayed
const STEP_KEYS: [&str; 15] = [
    "advance", "carried", "carries", "close", "counted", "expect", "on", "open", "report",
    "secure", "send", "token", "twoWay", "until", "wall",
];

// how many times an until settles the side and looks again for its timer
const PATIENCE: usize = 1_000;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a conversation is played.
pub(crate) struct PlayOptions {
    /// Through a pair of the in-memory transport, rather than a transport the player scripts.
    pub(crate) in_memory: bool,
    /// Through a broker pair over the in-memory broker, as through an in-memory pair.
    pub(crate) over_broker: bool,
    /// The registry its server is given, which each counted step reads.
    pub(crate) metrics_registry: Option<MetricsRegistry>,
    /// The instant its file starts every case at.
    pub(crate) wall_clock: SystemTime,
}

// what a server reported, each with the connection it came with, in the order reported
type Reports = Mutex<VecDeque<(Value, Option<ConnectionHandle>)>>;

/// An envelope a server sent, and the credential its transport was given with it.
type SentEnvelope = (Bytes, Option<String>);

// ── The scripted connections ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Script {
    // by name, its port, the handle of the connection it opened last, and how many it opened;
    // every handle drawn, with its name
    ports: HashMap<String, u16>,
    handles: HashMap<String, ConnectionHandle>,
    opens: HashMap<String, u32>,
    drawn: Vec<(String, ConnectionHandle)>,
    opened: Vec<ConnectionHandle>,
    one_way: HashSet<ConnectionHandle>,
    carrying_none: HashSet<ConnectionHandle>,
    in_the_clear: HashSet<ConnectionHandle>,
    sent: HashMap<ConnectionHandle, VecDeque<SentEnvelope>>,
}

impl Script {
    // the handle of the connection `name` opened last, its ordinal how many it opened: the first
    // named on the port 50001, the next on 50002
    fn handle_of(&mut self, name: &str) -> ConnectionHandle {
        if let Some(known) = self.handles.get(name) {
            return Arc::clone(known);
        }

        let next = u16::try_from(self.ports.len()).unwrap_or(u16::MAX);
        let port = *self
            .ports
            .entry(name.to_owned())
            .or_insert_with(|| 50_001_u16.saturating_add(next));
        let ordinal = self.opens.get(name).copied().unwrap_or(0).max(1);
        let handle: ConnectionHandle = Arc::from(format!(
            "type=WS;ip=127.0.0.1;port={port};ordinal={ordinal}"
        ));

        self.handles.insert(name.to_owned(), Arc::clone(&handle));
        self.drawn.push((name.to_owned(), Arc::clone(&handle)));

        handle
    }
}

/// A transport server of the connections a conversation names, each under a handle of its own: it
/// records what it sends on each, with the credential it is given beside it, delivers what it is
/// given, and says what each carries, as its open declared.
#[derive(Default)]
struct Scripted {
    script: Mutex<Script>,
    listeners: Mutex<Vec<Arc<dyn ServerListener>>>,
}

impl core::fmt::Debug for Scripted {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("Scripted").finish_non_exhaustive()
    }
}

impl Scripted {
    fn tell<C: Fn(&dyn ServerListener)>(&self, call: C) {
        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            call(listener.as_ref());
        }
    }
}

impl ServerTransport for Scripted {
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        locked(&self.script)
            .sent
            .entry(Arc::clone(connection_handle))
            .or_default()
            .push_back((message.data, message.credential));

        Ok(Sent::Done)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        Box::pin(async { false })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        locked(&self.listeners).push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        locked(&self.listeners).retain(|held| !Arc::ptr_eq(held, listener));
    }

    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        !locked(&self.script).one_way.contains(connection_handle)
    }

    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        !locked(&self.script)
            .in_the_clear
            .contains(connection_handle)
    }

    fn carries_credential(&self, connection_handle: &ConnectionHandle) -> bool {
        !locked(&self.script)
            .carrying_none
            .contains(connection_handle)
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

// ── The in-memory connections ────────────────────────────────────────────────────────────────

// what a client's transport hears, kept for the steps that expect it
struct Hearing {
    name: String,
    heard: Arc<Mutex<HashMap<String, VecDeque<SentEnvelope>>>>,
}

impl ClientListener for Hearing {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.heard)
            .entry(self.name.clone())
            .or_default()
            .push_back((message.data, message.credential));
    }
}

// the handle the server drew last
struct Drawing {
    last: Arc<Mutex<Option<ConnectionHandle>>>,
}

impl ServerListener for Drawing {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        *locked(&self.last) = Some(Arc::clone(connection_handle));
    }
}

/// The connections a conversation names over a real in-memory transport server, a client of it for
/// each, from `127.0.0.1` and a port of its own, as the scripted transport names them.
struct InMemory {
    server: MemoryServer,
    clock: SharedClock,
    clients: HashMap<String, MemoryClient>,
    ports: HashMap<String, u16>,
    handles: HashMap<String, ConnectionHandle>,
    heard: Arc<Mutex<HashMap<String, VecDeque<SentEnvelope>>>>,
    drawn: Arc<Mutex<Option<ConnectionHandle>>>,
}

/// The connections a conversation names over a broker pair (spec 15.16 to 15.24): a broker server
/// transport over the in-memory broker, serving `interop`, and for each name a participant of its
/// own, its id the name, a broker client transport over it. The whole router runs over parcels,
/// sequences and parts.
struct OverBroker {
    broker: MemoryBroker,
    clock: SharedClock,
    server: BrokerParticipant,
    transport: BrokerServer,
    participants: HashMap<String, BrokerParticipant>,
    clients: HashMap<String, BrokerClient>,
    handles: HashMap<String, ConnectionHandle>,
    heard: Arc<Mutex<HashMap<String, VecDeque<SentEnvelope>>>>,
    drawn: Arc<Mutex<Option<ConnectionHandle>>>,
}

// ! no heartbeat: its PINGs, on the platform's timer, would cross what a step counts
fn participant_options(clock: &SharedClock) -> BrokerParticipantOptions {
    let mut options = BrokerParticipantOptions::default();

    options.clock = Some(Arc::clone(clock));
    options.heartbeat = Some(NEVER);

    options
}

impl OverBroker {
    fn of(clock: &SharedClock) -> Result<Self, String> {
        let mut options = MemoryBrokerOptions::default();

        options.clock = Some(Arc::clone(clock));

        let broker = MemoryBroker::new(&options).map_err(|error| error.to_string())?;
        let adapter: Arc<dyn BrokerAdapter> = Arc::new(
            broker
                .adapter(&MemoryBrokerAdapterOptions::of("server"))
                .map_err(|error| error.to_string())?,
        );
        let server = BrokerParticipant::new(adapter, &participant_options(clock))
            .map_err(|error| error.to_string())?;
        let transport = server
            .server(&BrokerServerOptions::of(["interop"]))
            .map_err(|error| error.to_string())?;
        let drawn = Arc::new(Mutex::new(None));

        transport.listen(Arc::new(Drawing {
            last: Arc::clone(&drawn),
        }));

        Ok(Self {
            broker,
            clock: Arc::clone(clock),
            server,
            transport,
            participants: HashMap::new(),
            clients: HashMap::new(),
            handles: HashMap::new(),
            heard: Arc::new(Mutex::new(HashMap::new())),
            drawn,
        })
    }

    // a broker pair stands for a connection secure and two-way alone, which carries no credential
    // toward its client; its server told once its third leg came
    async fn open(&mut self, (name, clock): (&str, &SteppingClock)) -> Result<(), String> {
        if !self.clients.contains_key(name) {
            let adapter: Arc<dyn BrokerAdapter> = Arc::new(
                self.broker
                    .adapter(&MemoryBrokerAdapterOptions::of(name))
                    .map_err(|error| error.to_string())?,
            );
            let participant = BrokerParticipant::new(adapter, &participant_options(&self.clock))
                .map_err(|error| error.to_string())?;
            let client = participant
                .client(&BrokerClientOptions::default())
                .map_err(|error| error.to_string())?;

            client.listen(Arc::new(Hearing {
                name: name.to_owned(),
                heard: Arc::clone(&self.heard),
            }));
            self.participants.insert(name.to_owned(), participant);
            self.clients.insert(name.to_owned(), client);
        }

        let client = self
            .clients
            .get(name)
            .ok_or_else(|| format!("no client for {name}"))?;

        client
            .connect(BrokerConnectOptions::of("interop"))
            .await
            .map_err(|error| format!("{name} did not connect: {error}"))?;
        clock.settle().await;

        let drawn = locked(&self.drawn).clone();

        if let Some(handle) = drawn {
            self.handles.insert(name.to_owned(), handle);
        }

        Ok(())
    }
}

enum Connections {
    Scripted(Arc<Scripted>),
    InMemory(Box<InMemory>),
    OverBroker(Box<OverBroker>),
}

impl Connections {
    fn transport(&self) -> Arc<dyn ServerTransport> {
        match self {
            Self::Scripted(scripted) => {
                let transport: Arc<dyn ServerTransport> = Arc::<Scripted>::clone(scripted);

                transport
            }
            Self::InMemory(memory) => Arc::new(memory.server.clone()),
            Self::OverBroker(broker) => Arc::new(broker.transport.clone()),
        }
    }

    async fn open(
        &mut self,
        (name, clock): (&str, &SteppingClock),
        (carries_credential, is_secure, is_two_way): (bool, bool, bool),
    ) -> Result<(), String> {
        match self {
            Self::OverBroker(broker) => broker.open((name, clock)).await,
            Self::Scripted(scripted) => {
                let handle = {
                    let mut script = locked(&scripted.script);
                    // * a name opened before opens a new connection, under a handle never given
                    let count = script
                        .opens
                        .get(name)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1);

                    script.opens.insert(name.to_owned(), count);

                    if count > 1 {
                        script.handles.remove(name);
                    }

                    let handle = script.handle_of(name);

                    let Script {
                        one_way,
                        carrying_none,
                        in_the_clear,
                        ..
                    } = &mut *script;

                    for (set, is) in [
                        (one_way, is_two_way),
                        (carrying_none, carries_credential),
                        (in_the_clear, is_secure),
                    ] {
                        if is {
                            set.remove(&handle);
                        } else {
                            set.insert(Arc::clone(&handle));
                        }
                    }

                    script.opened.push(Arc::clone(&handle));

                    handle
                };

                scripted.tell(|listener| listener.on_connection(&handle));

                Ok(())
            }
            Self::InMemory(memory) => {
                let next = u16::try_from(memory.ports.len()).unwrap_or(u16::MAX);
                let port = *memory
                    .ports
                    .entry(name.to_owned())
                    .or_insert_with(|| 50_001_u16.saturating_add(next));

                if !memory.clients.contains_key(name) {
                    let mut options = MemoryClientOptions::of(memory.server.clone());

                    options.clock = Some(Arc::clone(&memory.clock));

                    let client = MemoryClient::new(&options).map_err(|error| error.to_string())?;

                    client.listen(Arc::new(Hearing {
                        name: name.to_owned(),
                        heard: Arc::clone(&memory.heard),
                    }));
                    memory.clients.insert(name.to_owned(), client);
                }

                let client = memory
                    .clients
                    .get(name)
                    .ok_or_else(|| format!("no client for {name}"))?;
                let mut options = MemoryConnectOptions::default();

                options.address = Some("127.0.0.1".to_owned());
                options.port = Some(port);
                client
                    .connect(options)
                    .await
                    .map_err(|error| format!("{name} did not connect: {error}"))?;

                let drawn = locked(&memory.drawn).clone();

                if let Some(handle) = drawn {
                    memory.handles.insert(name.to_owned(), handle);
                }

                Ok(())
            }
        }
    }

    fn message(
        &self,
        name: &str,
        (credential, data): (Option<String>, Bytes),
    ) -> Result<(), String> {
        match self {
            Self::Scripted(scripted) => {
                let handle = locked(&scripted.script).handle_of(name);

                scripted.tell(|listener| {
                    listener.on_message(
                        TransportMessage {
                            data: data.clone(),
                            credential: credential.clone(),
                            ..TransportMessage::default()
                        },
                        &handle,
                    );
                });

                Ok(())
            }
            Self::InMemory(memory) => {
                let client = memory
                    .clients
                    .get(name)
                    .ok_or_else(|| format!("no step opened {name}"))?;

                client
                    .send(TransportMessage {
                        data,
                        credential,
                        ..TransportMessage::default()
                    })
                    .map(drop)
                    .map_err(|error| error.to_string())
            }
            Self::OverBroker(broker) => {
                let client = broker
                    .clients
                    .get(name)
                    .ok_or_else(|| format!("no step opened {name}"))?;

                client
                    .send(TransportMessage {
                        data,
                        credential,
                        ..TransportMessage::default()
                    })
                    .map(drop)
                    .map_err(|error| error.to_string())
            }
        }
    }

    fn close(&self, name: &str) -> Result<(), String> {
        match self {
            Self::Scripted(scripted) => {
                let handle = {
                    let mut script = locked(&scripted.script);
                    let handle = script.handle_of(name);

                    script.opened.retain(|held| *held != handle);

                    handle
                };

                scripted.tell(|listener| listener.on_close(false, &handle));

                Ok(())
            }
            Self::InMemory(memory) => {
                let client = memory
                    .clients
                    .get(name)
                    .ok_or_else(|| format!("no step opened {name}"))?;
                let mut options = DisconnectOptions::default();

                options.is_clean = Some(false);

                client
                    .disconnect(options)
                    .map_err(|error| error.to_string())
            }
            // unclean, as the scripted connections close
            Self::OverBroker(broker) => {
                let client = broker
                    .clients
                    .get(name)
                    .ok_or_else(|| format!("no step opened {name}"))?;
                let mut options = DisconnectOptions::default();

                options.is_clean = Some(false);

                client
                    .disconnect(options)
                    .map_err(|error| error.to_string())
            }
        }
    }

    fn close_all(&self) {
        match self {
            Self::Scripted(scripted) => {
                let opened = core::mem::take(&mut locked(&scripted.script).opened);

                for handle in opened {
                    scripted.tell(|listener| listener.on_close(false, &handle));
                }
            }
            Self::InMemory(memory) => {
                for client in memory.clients.values() {
                    client.close();
                }
            }
            // * each stop takes effect as it is made: its future only waits
            Self::OverBroker(broker) => {
                for client in broker.clients.values() {
                    client.close();
                }

                for participant in broker.participants.values() {
                    drop(participant.stop());
                }

                drop(broker.server.stop());
            }
        }
    }

    fn handle_of(&self, name: &str) -> Option<ConnectionHandle> {
        match self {
            Self::Scripted(scripted) => Some(locked(&scripted.script).handle_of(name)),
            Self::InMemory(memory) => memory.handles.get(name).cloned(),
            Self::OverBroker(broker) => broker.handles.get(name).cloned(),
        }
    }

    fn next(&self, name: &str) -> Option<SentEnvelope> {
        match self {
            Self::Scripted(scripted) => {
                let mut script = locked(&scripted.script);
                let handle = script.handle_of(name);

                script.sent.get_mut(&handle).and_then(VecDeque::pop_front)
            }
            Self::InMemory(memory) => locked(&memory.heard)
                .get_mut(name)
                .and_then(VecDeque::pop_front),
            Self::OverBroker(broker) => locked(&broker.heard)
                .get_mut(name)
                .and_then(VecDeque::pop_front),
        }
    }

    // what was sent and not taken yet, by the name of its connection
    fn untaken(&self) -> BTreeMap<String, Vec<Option<Value>>> {
        let mut untaken = BTreeMap::new();

        match self {
            Self::Scripted(scripted) => {
                let script = locked(&scripted.script);

                for (name, handle) in &script.drawn {
                    if let Some(queue) = script.sent.get(handle)
                        && !queue.is_empty()
                    {
                        untaken.insert(
                            name.clone(),
                            queue.iter().map(|(bytes, _)| expected_of(bytes)).collect(),
                        );
                    }
                }
            }
            Self::InMemory(memory) => {
                for (name, queue) in locked(&memory.heard).iter() {
                    if !queue.is_empty() {
                        untaken.insert(
                            name.clone(),
                            queue.iter().map(|(bytes, _)| expected_of(bytes)).collect(),
                        );
                    }
                }
            }
            Self::OverBroker(broker) => {
                for (name, queue) in locked(&broker.heard).iter() {
                    if !queue.is_empty() {
                        untaken.insert(
                            name.clone(),
                            queue.iter().map(|(bytes, _)| expected_of(bytes)).collect(),
                        );
                    }
                }
            }
        }

        untaken
    }
}

// ── The envelopes, as a conversation expects them ────────────────────────────────────────────

fn envelope_of(bytes: &Bytes) -> Option<Envelope> {
    let mut options = ReadEnvelopeOptions::default();

    options.maximum_envelope_bytes = Some(usize::MAX);

    read_envelope(bytes, RouterSide::Client, &options)
        .ok()
        .flatten()
}

fn announcement_of(credential: &Credential) -> Value {
    match credential {
        Credential::None => json!("NONE"),
        Credential::Opaque(_)
        | Credential::Jwt(_)
        | Credential::Elsewhere
        | Credential::ToCome { .. }
        | _ => {
            json!("OPAQUE")
        }
    }
}

fn presented_of(credential: &Credential) -> Value {
    match credential {
        Credential::Jwt(token) => json!({
            "scheme": "JWT",
            "token": token.iter().map(|&byte| char::from(byte)).collect::<String>(),
        }),
        Credential::Elsewhere => json!({ "scheme": "ELSEWHERE" }),
        Credential::Opaque(token) => json!({
            "bytes": hexadecimal::text_of(token.bytes()),
            "scheme": "OPAQUE",
        }),
        Credential::None => json!({ "bytes": "", "scheme": CredentialScheme::NONE.get() }),
        Credential::ToCome { scheme, bytes } => json!({
            "bytes": hexadecimal::text_of(bytes),
            "scheme": scheme.get(),
        }),
        _ => Value::Null,
    }
}

/// The envelope `bytes` hold, as a conversation writes what it expects.
pub(crate) fn expected_of(bytes: &Bytes) -> Option<Value> {
    let envelope = envelope_of(bytes)?;
    let mut expected = Map::new();

    expected.insert("callId".to_owned(), json!(envelope.call_id()));
    expected.insert("kind".to_owned(), json!(envelope.kind().byte()));

    match &envelope {
        Envelope::Failure { header, failure } => {
            expected.insert(
                "failure".to_owned(),
                json!({ "code": failure.code, "relays": failure.relays, "scope": failure.scope.number() }),
            );

            if let Some(credential) = &header.credential {
                expected.insert("credential".to_owned(), announcement_of(credential));
            }
        }
        Envelope::Result { header, payload } => {
            expected.insert("payload".to_owned(), json!(hexadecimal::text_of(payload)));

            if let Some(credential) = &header.credential {
                expected.insert("credential".to_owned(), announcement_of(credential));
            }

            if let Some(total) = header.total {
                expected.insert("total".to_owned(), json!(total));
            }
        }
        Envelope::Notification { payload, .. } => {
            expected.insert("payload".to_owned(), json!(hexadecimal::text_of(payload)));
        }
        Envelope::Chunk { header, payload } => {
            expected.insert("isLast".to_owned(), json!(header.is_last));
            expected.insert("offset".to_owned(), json!(header.offset));
            expected.insert("payload".to_owned(), json!(hexadecimal::text_of(payload)));
        }
        Envelope::Credit { header } => {
            expected.insert("creditEnd".to_owned(), json!(header.credit_end));
            expected.insert("paced".to_owned(), json!(header.paced));
        }
        // a command the server sends its client, or a relay's leg B, its flags the byte after its
        // kind
        Envelope::Request { header, payload } => {
            expected.insert(
                "flags".to_owned(),
                json!(bytes.get(2).copied().unwrap_or(0)),
            );
            expected.insert("payload".to_owned(), json!(hexadecimal::text_of(payload)));
            expected.insert("procedureId".to_owned(), json!(header.procedure_id));
            expected.insert("serviceId".to_owned(), json!(header.service_id));

            if let Some(credential) = &header.credential {
                expected.insert("credential".to_owned(), presented_of(credential));
            }
        }
        Envelope::Cancel { .. } | _ => {}
    }

    Some(Value::Object(expected))
}

// the session token an answer announced
fn announced_token_of(bytes: &Bytes) -> Option<Vec<u8>> {
    let credential = match envelope_of(bytes)? {
        Envelope::Result { header, .. } => header.credential,
        Envelope::Failure { header, .. } => header.credential,
        Envelope::Request { .. }
        | Envelope::Notification { .. }
        | Envelope::Chunk { .. }
        | Envelope::Credit { .. }
        | Envelope::Cancel { .. }
        | _ => None,
    };

    if let Some(Credential::Opaque(token)) = credential {
        Some(token.bytes().to_vec())
    } else {
        None
    }
}

// the envelope sent, as `expected` writes it: its failure's detail only where `expected` gives one
pub(crate) fn actual_of(bytes: Option<&Bytes>, expected: &Value) -> Option<Value> {
    let bytes = bytes?;
    let mut actual = expected_of(bytes)?;
    let wants_detail = expected
        .get("failure")
        .and_then(|failure| failure.get("detail"))
        .is_some();

    if wants_detail
        && let Some(Envelope::Failure { failure, .. }) = envelope_of(bytes)
        && let Some(told) = actual.get_mut("failure").and_then(Value::as_object_mut)
    {
        told.insert("detail".to_owned(), json!(failure.detail));
    }

    Some(actual)
}

// ── Building the server ──────────────────────────────────────────────────────────────────────

pub(crate) fn limits_of(conversation: &Value) -> Result<RouterLimitsOptions, String> {
    let mut limits = RouterLimitsOptions::default();
    let Some(given) = conversation.get("limits").and_then(Value::as_object) else {
        return Ok(limits);
    };

    for (name, value) in given {
        let value = value
            .as_u64()
            .ok_or_else(|| format!("a conversation's limit {name} is a whole number"))?;

        match name.as_str() {
            "bufferedBytesBudget" => limits.buffered_bytes_budget = Some(value),
            "chunkBytes" => limits.chunk_bytes = Some(value),
            "maximumAnsweringCalls" => limits.maximum_answering_calls = Some(value),
            "maximumChunkRuns" => limits.maximum_chunk_runs = Some(value),
            "maximumDetailBytes" => limits.maximum_detail_bytes = Some(value),
            "maximumEnvelopeBytes" => limits.maximum_envelope_bytes = Some(value),
            "maximumPayloadBytes" => limits.maximum_payload_bytes = Some(value),
            "maximumTransfers" => limits.maximum_transfers = Some(value),
            "transferInactivityTimeout" => {
                limits.transfer_inactivity_timeout = Some(Duration::from_millis(value));
            }
            "windowBytes" => limits.window_bytes = Some(value),
            _ => return Err(format!("a conversation sets a limit no test reads: {name}")),
        }
    }

    Ok(limits)
}

fn pacing_of(conversation: &Value) -> Result<Option<PacingLimitsOptions>, String> {
    let Some(given) = conversation.get("pacing").and_then(Value::as_object) else {
        return Ok(None);
    };
    let mut pacing = PacingLimitsOptions::default();

    for (name, value) in given {
        let value = value
            .as_u64()
            .ok_or_else(|| format!("a conversation's pacing {name} is a whole number"))?;

        match name.as_str() {
            "maximumQueuedNotifications" => pacing.maximum_queued_notifications = Some(value),
            "maximumQueuedNotificationBytes" => {
                pacing.maximum_queued_notification_bytes = Some(value);
            }
            _ => {
                return Err(format!(
                    "a conversation paces by a limit no test reads: {name}"
                ));
            }
        }
    }

    Ok(Some(pacing))
}

// the server's relay, the conversation's where it gives it: whether it verifies, and its admission
// by the name both sides give it
fn relay_of(conversation: &Value) -> Result<Option<RelayOptions>, String> {
    let Some(given) = conversation.get("relay").and_then(Value::as_object) else {
        return Ok(None);
    };
    let mut relay = RelayOptions::default();

    relay.verifies = given
        .get("verifies")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    relay.before_route = match given.get("beforeRoute").and_then(Value::as_str) {
        None => None,
        Some("requireCredential") => Some(require_credential()),
        Some("requireSession") => Some(require_session()),
        Some("shareLegBSession") => Some(share_leg_b_session()),
        Some(other) => {
            return Err(format!(
                "a conversation's relay admits by a name no test reads: {other}"
            ));
        }
    };

    Ok(Some(relay))
}

/// Whether a pair of the in-memory transport stands for each connection `conversation` opens (spec
/// 15.13): every one secure and two-way, and none a request its server sends expects carried toward
/// its client.
pub(crate) fn is_played_in_memory(conversation: &Value) -> bool {
    conversation
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .all(|step| {
            step.get("secure") != Some(&Value::Bool(false))
                && step.get("twoWay") != Some(&Value::Bool(false))
                && !(step
                    .get("expect")
                    .and_then(|expect| expect.get("kind"))
                    .and_then(Value::as_u64)
                    == Some(u64::from(EnvelopeKind::Request.byte()))
                    && step.get("carried").is_some())
        })
}

// `send` with each token it names, `<name>`, as the 16 bytes a step before kept under that name
fn with_tokens(send: &str, tokens: &HashMap<String, Vec<u8>>) -> Result<String, String> {
    let mut written = String::new();
    let mut rest = send;

    while let Some(start) = rest.find('<') {
        let (before, after) = rest.split_at(start);
        let end = after
            .find('>')
            .ok_or_else(|| format!("a token's name is not closed in {send}"))?;
        let name = after.get(1..end).unwrap_or_default();
        let token = tokens
            .get(name)
            .ok_or_else(|| format!("no step before named a token {name}"))?;

        written.push_str(before);
        written.push_str(&hexadecimal::text_of(token));
        rest = after.get(end.saturating_add(1)..).unwrap_or_default();
    }

    written.push_str(rest);

    Ok(written)
}

// an exposition's lines, each by its series — its name and its labels — in its order
fn series_of(text: &str) -> Vec<(String, String)> {
    text.split('\n')
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let at = line.rfind(' ').unwrap_or(line.len());

            (line.get(..at).unwrap_or(line).to_owned(), line.to_owned())
        })
        .collect()
}

fn exposed_of(registry: Option<&MetricsRegistry>) -> Vec<(String, String)> {
    registry.map_or_else(Vec::new, |registry| series_of(&registry.exposition().text))
}

// a check that holds, or says what it found
fn hold<S: FnOnce() -> String>(holds: bool, said: S) -> Result<(), String> {
    if holds { Ok(()) } else { Err(said()) }
}

/// Plays `conversation` against a server of the interop service, on a stepping clock only its
/// steps move.
pub(crate) async fn play(conversation: &Value, options: PlayOptions) -> Result<(), String> {
    let steps = conversation
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("a conversation holds its steps")?;
    let clock = SteppingClock::new(options.wall_clock);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);

    if (options.in_memory || options.over_broker) && !is_played_in_memory(conversation) {
        return Err("a pair stands for no connection of this conversation".to_owned());
    }

    let mut connections = if options.over_broker {
        Connections::OverBroker(Box::new(OverBroker::of(&shared)?))
    } else if options.in_memory {
        let mut server_options = MemoryServerOptions::default();

        server_options.clock = Some(Arc::clone(&shared));

        let server = MemoryServer::new(&server_options).map_err(|error| error.to_string())?;
        let drawn = Arc::new(Mutex::new(None));

        server.listen(Arc::new(Drawing {
            last: Arc::clone(&drawn),
        }));

        Connections::InMemory(Box::new(InMemory {
            server,
            clock: Arc::clone(&shared),
            clients: HashMap::new(),
            ports: HashMap::new(),
            handles: HashMap::new(),
            heard: Arc::new(Mutex::new(HashMap::new())),
            drawn,
        }))
    } else {
        Connections::Scripted(Arc::new(Scripted::default()))
    };
    let limits = limits_of(conversation)?;
    let mut server_options = ServerOptions::default();

    server_options.clock = Some(Arc::clone(&shared));
    // the interop service's, none of a JWT under limits that hold none
    server_options.credentials = Some(
        bead_interop::interop_credentials_of(&shared, Some(&limits))
            .map_err(|error| error.to_string())?,
    );
    server_options.limits = Some(limits);
    server_options.metrics_registry = options.metrics_registry.clone();
    server_options.pacing = pacing_of(conversation)?;
    server_options.relay = relay_of(conversation)?;

    let transport = connections.transport();
    let server =
        Server::new(Arc::clone(&transport), &server_options).map_err(|error| error.to_string())?;
    // what the server reported to its application, and the connection it came with
    let reports: Arc<Reports> = Arc::new(Mutex::new(VecDeque::new()));
    let reporting = Arc::clone(&reports);

    server.router().on_error(Arc::new(
        move |error: &RouterError, handle: Option<&ConnectionHandle>| {
            let code = match error {
                RouterError::Failure(failure) => json!(failure.code().get()),
                RouterError::Other(_) | _ => json!("exception"),
            };

            locked(&reporting).push_back((code, handle.cloned()));
        },
    ));

    let _interop = bead_interop::offer_interop(&server).map_err(|error| error.to_string())?;

    transport.start().await.map_err(|error| error.to_string())?;

    let played = play_steps(
        (steps, &mut connections),
        (&clock, &reports, options.metrics_registry.as_ref()),
    )
    .await;

    connections.close_all();
    clock.settle().await;
    server.dispose().await;
    clock.settle().await;

    played
}

// what the server did that its conversation did not expect, once it settled: nothing, between
// steps
async fn expect_nothing_more(
    connections: &Connections,
    ((clock, reports), when): ((&SteppingClock, &Reports), &str),
) -> Result<(), String> {
    clock.settle().await;

    let reported: Vec<Value> = locked(reports)
        .iter()
        .map(|(code, _)| code.clone())
        .collect();
    let untaken = connections.untaken();

    hold(reported.is_empty() && untaken.is_empty(), || {
        format!("{when}: reported {reported:?}, sent and not taken {untaken:?}")
    })
}

#[expect(
    clippy::too_many_lines,
    reason = "one branch per step's key, as the player of each side reads them"
)]
#[expect(
    clippy::disallowed_methods,
    reason = "a native player: a timer's step waits, in real milliseconds, for the side to arm it"
)]
async fn play_steps(
    (steps, connections): (&[Value], &mut Connections),
    (clock, reports, registry): (&SteppingClock, &Reports, Option<&MetricsRegistry>),
) -> Result<(), String> {
    // the tokens its answers announced, by the names its steps gave them
    let mut tokens: HashMap<String, Vec<u8>> = HashMap::new();
    // every series at 0 as the case begins, once the server is built
    let mut exposed = exposed_of(registry);

    if steps.iter().all(|step| step.get("open").is_none()) {
        connections
            .open((ONLY_CONNECTION, clock), (true, true, true))
            .await?;
    }

    for (index, step) in steps.iter().enumerate() {
        let at = format!("step {}", index.saturating_add(1));
        let on = step
            .get("on")
            .and_then(Value::as_str)
            .unwrap_or(ONLY_CONNECTION);
        let unknown: Vec<&String> = step
            .as_object()
            .map(|step| {
                step.keys()
                    .filter(|key| !STEP_KEYS.contains(&key.as_str()))
                    .collect()
            })
            .unwrap_or_default();

        hold(unknown.is_empty(), || {
            format!("{at}: the keys this player does not read: {unknown:?}")
        })?;

        if step.get("open").is_some()
            || step.get("send").is_some()
            || step.get("close") == Some(&Value::Bool(true))
        {
            expect_nothing_more(connections, ((clock, reports), &format!("before {at}"))).await?;
        }

        if let Some(name) = step.get("open").and_then(Value::as_str) {
            let flags = (
                step.get("carries") != Some(&Value::Bool(false)),
                step.get("secure") != Some(&Value::Bool(false)),
                step.get("twoWay") != Some(&Value::Bool(false)),
            );

            connections.open((name, clock), flags).await?;
            clock.settle().await;
        }

        if let Some(send) = step.get("send").and_then(Value::as_str) {
            let data = hexadecimal::bytes_of(&with_tokens(send, &tokens)?)
                .ok_or_else(|| format!("{at}: a send that is not hexadecimal"))?;
            let carried = step
                .get("carried")
                .and_then(Value::as_str)
                .map(str::to_owned);

            connections.message(on, (carried, Bytes::from(data)))?;
            clock.settle().await;
        }

        if step.get("close") == Some(&Value::Bool(true)) {
            connections.close(on)?;
            clock.settle().await;
        }

        // * what the server sends and reports is taken once it settled, at once
        if let Some(expected) = step.get("expect") {
            clock.settle().await;

            let next = connections.next(on);
            let bytes = next.as_ref().map(|(bytes, _)| bytes);
            let actual = actual_of(bytes, expected);

            hold(actual.as_ref() == Some(expected), || {
                format!("{at}: sent {actual:?}, expected {expected}")
            })?;

            // a request the server sends — a command, a relay's leg B — beside what its transport
            // was given
            if expected.get("kind").and_then(Value::as_u64)
                == Some(u64::from(EnvelopeKind::Request.byte()))
            {
                let carried = next.as_ref().and_then(|(_, credential)| credential.clone());
                let expected_carried = step
                    .get("carried")
                    .and_then(Value::as_str)
                    .map(str::to_owned);

                hold(carried == expected_carried, || {
                    format!("{at}: its transport carried {carried:?}, not {expected_carried:?}")
                })?;
            }

            if let Some(name) = step.get("token").and_then(Value::as_str)
                && let Some(token) = bytes.and_then(announced_token_of)
            {
                tokens.insert(name.to_owned(), token);
            }
        }

        if let Some(expected) = step.get("report") {
            clock.settle().await;

            let report = locked(reports).pop_front();

            hold(
                report.as_ref().map(|(code, _)| code) == Some(expected),
                || format!("{at}: reported {report:?}, not {expected}"),
            )?;

            if let Some(name) = step.get("on").and_then(Value::as_str) {
                let handle = connections.handle_of(name);
                let reported = report.and_then(|(_, handle)| handle);

                hold(reported == handle, || {
                    format!("{at}: reported with {reported:?}, not {handle:?}")
                })?;
            }
        }

        if let Some(timer) = step
            .get("until")
            .and_then(|until| until.get("timer"))
            .and_then(Value::as_u64)
        {
            let due = Duration::from_millis(timer);
            let mut is_armed = false;

            for _ in 0..PATIENCE {
                clock.settle().await;

                if clock.dues().contains(&due) {
                    is_armed = true;

                    break;
                }

                tokio::time::sleep(Duration::from_millis(1)).await;
            }

            hold(is_armed, || {
                format!(
                    "{at}: the timers armed, {:?}, hold none of {timer}",
                    clock.dues()
                )
            })?;
        }

        if let Some(advance) = step.get("advance").and_then(Value::as_u64) {
            clock.advance(Duration::from_millis(advance)).await;
            clock.settle().await;
        }

        if let Some(wall) = step.get("wall").and_then(Value::as_i64) {
            clock.wall_by(wall);
        }

        if let Some(counted) = step.get("counted").and_then(Value::as_array) {
            clock.settle().await;

            let now = exposed_of(registry);
            let names = |series: &[(String, String)]| {
                series
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>()
            };

            hold(names(&now) == names(&exposed), || {
                format!(
                    "{at}: the series, none made or gone: {:?}, not {:?}",
                    names(&now),
                    names(&exposed)
                )
            })?;

            let moved: Vec<Value> = now
                .iter()
                .filter(|(series, line)| {
                    exposed
                        .iter()
                        .find(|(before, _)| before == series)
                        .is_none_or(|(_, before)| before != line)
                })
                .map(|(_, line)| Value::String(line.clone()))
                .collect();

            hold(moved == *counted, || {
                format!("{at}: the series that moved: {moved:?}, not {counted:?}")
            })?;
            exposed = now;
        }
    }

    expect_nothing_more(connections, ((clock, reports), "at the end")).await
}
