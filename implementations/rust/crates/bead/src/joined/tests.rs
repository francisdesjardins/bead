//! The joined transport's tests (spec 15.14): one server transport over the in-memory one, a
//! broker's and a WebSocket-typed one of the tests' own, each handle its transport's, each flag,
//! send and close asked of it, their stops and gauges taken together, and one server serving an
//! in-memory client and a broker's. The other sides' twins hold the same sentences.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use bytes::Bytes;

use super::JoinedServerTransport;
use crate::broker::adapter::BrokerAdapter;
use crate::broker::client::{BrokerClient, BrokerClientOptions, BrokerConnectOptions};
use crate::broker::memory::{MemoryBroker, MemoryBrokerAdapterOptions, MemoryBrokerOptions};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions};
use crate::broker::server::{BrokerServer, BrokerServerOptions};
use crate::client::{Client, ClientOptions};
use crate::clock::SharedClock;
use crate::debug::DebugDirection;
use crate::duration::NEVER;
use crate::managers::service::{
    DebugEvent, RequestDependencies, RequestOptions, ResolverDependencies, Response, TracedError,
};
use crate::memory::{
    MemoryClient, MemoryClientOptions, MemoryConnectOptions, MemoryServer, MemoryServerOptions,
};
use crate::payloads::TextCodec;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::server::{HealthStatus, Server, ServerOptions};
use crate::testing::pair::echo;
use crate::testing::{SteppingClock, hexadecimal};
use crate::transport::{
    ClientListener, ClientTransport, DisconnectOptions, Listeners, ReadyState, Sent,
    ServerListener, ServerTransport, TransportServerRefusal,
};

// the one connection of the WebSocket-typed transport
const SOCKET: &str = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn january_first() -> SystemTime {
    SystemTime::UNIX_EPOCH
}

// a WebSocket-typed transport of the tests' own: its flags as a test sets them, its events told
// when a test asks, and each of its calls recorded
struct Paired {
    kind: &'static str,
    handle: ConnectionHandle,
    clock: Option<SharedClock>,
    is_secured: bool,
    is_carrying: bool,
    is_both_ways: bool,
    held: Option<Gauges>,
    calls: Mutex<Vec<String>>,
    listeners: Listeners<dyn ServerListener>,
}

impl core::fmt::Debug for Paired {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Paired")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl Default for Paired {
    fn default() -> Self {
        Self {
            kind: "WS",
            handle: Arc::from(SOCKET),
            clock: None,
            is_secured: true,
            is_carrying: false,
            is_both_ways: true,
            held: None,
            calls: Mutex::default(),
            listeners: Listeners::default(),
        }
    }
}

impl Paired {
    fn tell<C: Fn(&dyn ServerListener)>(&self, call: C) {
        for listener in self.listeners.all() {
            call(&*listener);
        }
    }

    fn open(&self) {
        self.tell(|listener| listener.on_connection(&self.handle));
    }

    fn deliver(&self, data: &'static [u8]) {
        self.tell(|listener| {
            listener.on_message(
                TransportMessage {
                    data: Bytes::from_static(data),
                    ..TransportMessage::default()
                },
                &self.handle,
            );
        });
    }

    fn told(&self, is_held: bool) {
        self.tell(|listener| listener.on_listen(is_held, &self.handle));
    }

    fn refuse(&self, refusal: &TransportServerRefusal) {
        self.tell(|listener| listener.on_refusal(refusal));
    }

    fn fail(&self, message: &str) {
        let error = RouterError::Other(Arc::new(std::io::Error::other(message.to_owned())));

        self.tell(|listener| listener.on_error(&error, Some(&self.handle)));
    }

    fn closed(&self) {
        self.tell(|listener| listener.on_close(false, &self.handle));
    }

    fn calls(&self) -> Vec<String> {
        locked(&self.calls).clone()
    }
}

impl ServerTransport for Paired {
    fn send(
        &self,
        message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let bytes = hexadecimal::text_of(&message.data).replace(' ', "");

        locked(&self.calls).push(format!("send {bytes}"));

        Ok(Sent::Done)
    }

    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        locked(&self.calls).push(format!("close {connection_handle}"));

        Box::pin(async { true })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.listeners.remove(listener);
    }

    fn clock(&self) -> Option<SharedClock> {
        self.clock.clone()
    }

    fn is_two_way(&self, _connection_handle: &ConnectionHandle) -> bool {
        self.is_both_ways
    }

    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        self.is_secured
    }

    fn carries_credential(&self, _connection_handle: &ConnectionHandle) -> bool {
        self.is_carrying
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        locked(&self.calls).push("shutdown".to_owned());

        Box::pin(async {})
    }

    fn gauges(&self) -> Option<Gauges> {
        self.held.clone()
    }

    fn transport_type(&self) -> Option<&str> {
        Some(self.kind)
    }
}

// what a client hears, each envelope in hexadecimal
struct Hearing(Arc<Mutex<Vec<String>>>);

impl ClientListener for Hearing {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.0).push(hexadecimal::text_of(&message.data).replace(' ', ""));
    }
}

// a transport that says nothing of a flag: none carried, none secure, two-way
#[derive(Debug, Default)]
struct Silent {
    calls: Mutex<Vec<String>>,
}

impl ServerTransport for Silent {
    fn send(
        &self,
        _message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        locked(&self.calls).push("send".to_owned());

        Ok(Sent::Done)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        locked(&self.calls).push("close".to_owned());

        Box::pin(async { true })
    }

    fn listen(&self, _listener: Arc<dyn ServerListener>) {}

    fn unlisten(&self, _listener: &Arc<dyn ServerListener>) {}

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }

    fn transport_type(&self) -> Option<&str> {
        Some("HTTP")
    }
}

// an in-memory transport server on `clock`, started
async fn memory_on(clock: &SharedClock) -> MemoryServer {
    let server = MemoryServer::new(&MemoryServerOptions {
        clock: Some(Arc::clone(clock)),
        runtime: None,
    })
    .expect("a server");

    server.start().await.expect("started");

    server
}

fn memory_client_of((server, clock): (&MemoryServer, &SharedClock)) -> MemoryClient {
    MemoryClient::new(&MemoryClientOptions {
        clock: Some(Arc::clone(clock)),
        server: server.clone(),
    })
    .expect("a client")
}

// a broker on `clock`, the server's participant serving `interop` and a client's participant
struct Brokered {
    server_participant: BrokerParticipant,
    client_participant: BrokerParticipant,
    server: BrokerServer,
}

fn brokered(clock: &SharedClock) -> Brokered {
    let broker = MemoryBroker::new(&MemoryBrokerOptions {
        clock: Some(Arc::clone(clock)),
        ..MemoryBrokerOptions::default()
    })
    .expect("a broker");
    let participant_of = |id: &str| {
        let adapter: Arc<dyn BrokerAdapter> = Arc::new(
            broker
                .adapter(&MemoryBrokerAdapterOptions::of(id))
                .expect("an adapter"),
        );
        // * no heartbeat: its PINGs, on the platform's timer, would cross what a test counts
        let options = BrokerParticipantOptions {
            clock: Some(Arc::clone(clock)),
            heartbeat: Some(NEVER),
            ..BrokerParticipantOptions::default()
        };

        BrokerParticipant::new(adapter, &options).expect("a participant")
    };
    let server_participant = participant_of("server");
    let client_participant = participant_of("client");
    let server = server_participant
        .server(&BrokerServerOptions::of(["interop"]))
        .expect("a server");

    Brokered {
        server_participant,
        client_participant,
        server,
    }
}

fn broker_client_of(brokered: &Brokered) -> BrokerClient {
    brokered
        .client_participant
        .client(&BrokerClientOptions::default())
        .expect("a client")
}

// what the join tells, each as a line
struct Telling {
    told: Arc<Mutex<Vec<String>>>,
    // the first message's listener panics, once
    has_panicked: Mutex<bool>,
    refusal: Arc<Mutex<Option<TransportServerRefusal>>>,
}

impl ServerListener for Telling {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!("connection {connection_handle}"));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!(
            "message {} {connection_handle}",
            message.data.first().copied().unwrap_or_default()
        ));

        let is_first = !core::mem::replace(&mut *locked(&self.has_panicked), true);

        assert!(!is_first, "a message listener that throws");
    }

    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!("close {was_clean} {connection_handle}"));
    }

    fn on_listen(&self, is_held: bool, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!("listen {is_held} {connection_handle}"));
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        *locked(&self.refusal) = Some(refusal.clone());
        locked(&self.told).push(format!("refusal {}", refusal.reason));
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        let handle = connection_handle
            .map(ToString::to_string)
            .unwrap_or_default();

        locked(&self.told).push(format!("error {error} {handle}"));
    }
}

// * a listener that panics is reported with its connection, and the next is told all the same
struct Throwing;

impl ServerListener for Throwing {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        panic!("a listener of {connection_handle} throws");
    }
}

struct After(Arc<Mutex<Vec<String>>>);

impl ServerListener for After {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.0).push(format!("after {connection_handle}"));
    }
}

// spec 15.14
#[tokio::test]
async fn hands_on_each_transport_s_events_with_the_handle_it_drew() {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let brokered = brokered(&shared);
    let paired = Arc::new(Paired::default());
    let joined = JoinedServerTransport::new(vec![
        Arc::new(memory.clone()),
        Arc::new(brokered.server.clone()),
        Arc::<Paired>::clone(&paired),
    ])
    .expect("a join");
    let told: Arc<Mutex<Vec<String>>> = Arc::default();
    let refusal = TransportServerRefusal {
        address: Some("203.0.113.7".to_owned()),
        authority: Some("example.com".to_owned()),
        origin: None,
        port: Some(50_002),
        reason: "host-refused".to_owned(),
        status: 403,
    };
    let forwarded: Arc<Mutex<Option<TransportServerRefusal>>> = Arc::default();

    joined.listen(Arc::new(Telling {
        told: Arc::clone(&told),
        has_panicked: Mutex::new(true),
        refusal: Arc::default(),
    }));
    joined.listen(Arc::new(Throwing));
    joined.listen(Arc::new(After(Arc::clone(&told))));
    // and one that panics on the first message alone, reported with its connection
    joined.listen(Arc::new(Telling {
        told: Arc::default(),
        has_panicked: Mutex::new(false),
        refusal: Arc::clone(&forwarded),
    }));
    brokered.server.start().await.expect("started");

    // the in-memory transport's
    let client = memory_client_of((&memory, &shared));

    client
        .connect(MemoryConnectOptions::default())
        .await
        .expect("connected");
    clock.settle().await;

    let drawn = memory
        .clients()
        .first()
        .map(|(handle, ..)| Arc::clone(handle))
        .expect("drawn");

    client
        .send(TransportMessage {
            data: Bytes::from_static(&[1]),
            ..TransportMessage::default()
        })
        .expect("sent");
    clock.settle().await;
    client
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    clock.settle().await;

    // the broker's, its handle drawn at its third leg
    let broker_client = broker_client_of(&brokered);

    broker_client
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    clock.settle().await;

    let by_broker = brokered
        .server
        .clients()
        .first()
        .map(|(handle, ..)| Arc::clone(handle))
        .expect("drawn");

    broker_client
        .send(TransportMessage {
            data: Bytes::from_static(&[2]),
            ..TransportMessage::default()
        })
        .expect("sent");
    clock.settle().await;
    broker_client
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    clock.settle().await;

    // the WebSocket-typed one's, its listen, its refusal and its error among them
    paired.open();
    paired.deliver(&[3]);
    paired.told(true);
    paired.refuse(&refusal);
    paired.fail("a socket broke");
    paired.closed();

    let panicked =
        |handle: &str| format!("error a listener panicked: a listener of {handle} throws {handle}");

    assert_eq!(
        *locked(&told),
        [
            format!("connection {drawn}"),
            panicked(&drawn),
            format!("after {drawn}"),
            format!("message 1 {drawn}"),
            format!("error a listener panicked: a message listener that throws {drawn}"),
            format!("close true {drawn}"),
            format!("connection {by_broker}"),
            panicked(&by_broker),
            format!("after {by_broker}"),
            format!("message 2 {by_broker}"),
            format!("close true {by_broker}"),
            format!("connection {SOCKET}"),
            panicked(SOCKET),
            format!("after {SOCKET}"),
            format!("message 3 {SOCKET}"),
            format!("listen true {SOCKET}"),
            "refusal host-refused".to_owned(),
            format!("error a socket broke {SOCKET}"),
            format!("close false {SOCKET}"),
        ],
        "each told on, with its handle, in its order"
    );

    // * a refusal is told whole, every field as its transport gave it
    assert_eq!(*locked(&forwarded), Some(refusal), "the refusal whole");
    brokered.client_participant.stop().await;
    brokered.server_participant.stop().await;
}

// spec 15.14
#[tokio::test]
async fn asks_each_connection_s_flags_of_the_transport_that_drew_it_and_sends_and_closes_through_it()
 {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let brokered = brokered(&shared);
    let paired = Arc::new(Paired {
        is_secured: false,
        is_carrying: true,
        is_both_ways: false,
        ..Paired::default()
    });
    // a transport that says nothing of a flag: none carried, none secure, two-way
    let silent = Arc::new(Silent::default());
    let joined = JoinedServerTransport::new(vec![
        Arc::new(memory.clone()),
        Arc::new(brokered.server.clone()),
        Arc::<Paired>::clone(&paired),
        Arc::<Silent>::clone(&silent),
    ])
    .expect("a join");
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();

    brokered.server.start().await.expect("started");

    let client = memory_client_of((&memory, &shared));
    let broker_client = broker_client_of(&brokered);

    client.listen(Arc::new(Hearing(Arc::clone(&heard))));
    broker_client.listen(Arc::new(Hearing(Arc::clone(&heard))));
    client
        .connect(MemoryConnectOptions::default())
        .await
        .expect("connected");
    broker_client
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    clock.settle().await;
    paired.open();

    let drawn = memory
        .clients()
        .first()
        .map(|(handle, ..)| Arc::clone(handle))
        .expect("drawn");
    let by_broker = brokered
        .server
        .clients()
        .first()
        .map(|(handle, ..)| Arc::clone(handle))
        .expect("drawn");
    let socket: ConnectionHandle = Arc::from(SOCKET);
    let silent_handle: ConnectionHandle = Arc::from("type=HTTP;ip=127.0.0.1;ordinal=1");
    let flags = |handle: &ConnectionHandle| {
        (
            joined.is_secure(handle),
            joined.carries_credential(handle),
            joined.is_two_way(handle),
        )
    };

    assert_eq!(flags(&drawn), (true, false, true), "the in-memory one's");
    assert_eq!(flags(&by_broker), (true, false, true), "the broker's");
    assert_eq!(flags(&socket), (false, true, false), "the paired one's");
    assert_eq!(
        flags(&silent_handle),
        (false, false, true),
        "the silent one's"
    );

    // a handle none of them drew is none of theirs, nor one no handle's form holds: neither secure,
    // nor carrying, nor two-way, and closes nothing
    let elsewhere: ConnectionHandle = Arc::from("type=AMQP;participant=x;ordinal=1");
    let formless: ConnectionHandle = Arc::from("nothing");

    assert_eq!(
        flags(&elsewhere),
        (false, false, false),
        "a handle of no type joined"
    );
    assert_eq!(
        flags(&formless),
        (false, false, false),
        "a handle of no form"
    );

    for (handle, byte) in [
        (&drawn, 1_u8),
        (&by_broker, 2),
        (&socket, 3),
        (&elsewhere, 4),
    ] {
        joined
            .send(
                TransportMessage {
                    data: Bytes::from(vec![byte]),
                    ..TransportMessage::default()
                },
                handle,
            )
            .expect("sent");
    }

    clock.settle().await;
    heard
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .sort_unstable();
    assert_eq!(
        *locked(&heard),
        ["01", "02"],
        "each through the transport that drew it"
    );
    assert_eq!(paired.calls(), ["send 03"], "the paired one's send");

    assert!(joined.close(&drawn).await, "closed in memory");
    assert!(joined.close(&by_broker).await, "closed over the broker");
    assert!(joined.close(&socket).await, "closed by the paired one");
    assert!(!joined.close(&elsewhere).await, "none closed elsewhere");
    clock.settle().await;

    assert_eq!(
        (
            client.ready_state(),
            broker_client.ready_state(),
            memory.clients().len()
        ),
        (ReadyState::Closed, ReadyState::Closed, 0),
        "each closed"
    );
    assert_eq!(
        paired.calls(),
        ["send 03".to_owned(), format!("close {SOCKET}")],
        "the paired one's"
    );
    assert!(
        locked(&silent.calls).is_empty(),
        "nothing of the silent one's"
    );
    brokered.client_participant.stop().await;
    brokered.server_participant.stop().await;
}

// spec 15.14
#[tokio::test]
async fn refuses_to_join_two_transports_of_one_type() {
    let first = MemoryServer::new(&MemoryServerOptions::default()).expect("a server");
    let second = MemoryServer::new(&MemoryServerOptions::default()).expect("a server");
    let paired = Arc::new(Paired::default());

    assert!(
        JoinedServerTransport::new(vec![
            Arc::new(first.clone()),
            Arc::<Paired>::clone(&paired),
            Arc::new(second),
        ])
        .expect_err("refused")
        .message()
        .starts_with(
            "a join takes one transport of each type: two are MEMORY, whose handles might be one"
        ),
        "two of one type"
    );

    // a join names no type of its own, so no join takes it; nor is none taken, nor one on another
    // clock than the others
    let joined = JoinedServerTransport::new(vec![Arc::new(first)]).expect("a join");

    assert_eq!(joined.transport_type(), None, "no type of its own");
    assert!(
        JoinedServerTransport::new(vec![Arc::new(joined), Arc::<Paired>::clone(&paired)]).is_err(),
        "a join among them"
    );
    assert!(JoinedServerTransport::new(Vec::new()).is_err(), "none");

    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let elsewhere = MemoryServer::new(&MemoryServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
    })
    .expect("a server");
    let other: SharedClock = SteppingClock::new(january_first());

    assert!(
        JoinedServerTransport::new(vec![
            Arc::new(Paired {
                clock: Some(other),
                ..Paired::default()
            }),
            Arc::new(elsewhere.clone()),
        ])
        .is_err(),
        "two clocks"
    );

    // * one clock is the join's
    let together = JoinedServerTransport::new(vec![
        Arc::new(elsewhere),
        Arc::new(Paired {
            clock: Some(Arc::clone(&shared)),
            ..Paired::default()
        }),
    ])
    .expect("a join");

    assert!(
        together
            .clock()
            .is_some_and(|clock| Arc::ptr_eq(&clock, &shared)),
        "its one clock"
    );
}

// spec 15.14
#[tokio::test]
async fn stops_every_transport_it_joined_and_sums_their_gauges() {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let held = Gauges {
        anomalies: vec!["a socket held twice".to_owned()],
        ceilings: BTreeMap::from([("connections", 10_000), ("largestAddressConnections", 64)]),
        connection_handles: core::iter::once(Arc::from(SOCKET)).collect(),
        counts: BTreeMap::from([("connections", 1), ("largestAddressConnections", 1)]),
    };

    let paired = Arc::new(Paired {
        held: Some(held),
        ..Paired::default()
    });
    // what counts nothing: its connections as its events told them
    let uncounted = Arc::new(Paired {
        kind: "HTTP",
        handle: Arc::from("type=HTTP;ip=127.0.0.1;port=50002;ordinal=1"),
        ..Paired::default()
    });
    let joined = JoinedServerTransport::new(vec![
        Arc::new(memory.clone()),
        Arc::<Paired>::clone(&paired),
        Arc::<Paired>::clone(&uncounted),
    ])
    .expect("a join");
    let first = memory_client_of((&memory, &shared));
    let second = memory_client_of((&memory, &shared));

    first
        .connect(MemoryConnectOptions::default())
        .await
        .expect("connected");
    second
        .connect(MemoryConnectOptions::default())
        .await
        .expect("connected");
    clock.settle().await;
    uncounted.open();

    let gauges = joined.gauges().expect("its gauges");
    let mut handles: Vec<ConnectionHandle> = memory
        .clients()
        .into_iter()
        .map(|(handle, ..)| handle)
        .collect();

    handles.push(Arc::from(SOCKET));
    handles.push(Arc::clone(&uncounted.handle));
    handles.sort();

    assert_eq!(
        gauges.counts,
        BTreeMap::from([("connections", 4), ("largestAddressConnections", 1)]),
        "their counts summed"
    );
    assert_eq!(
        gauges.ceilings,
        BTreeMap::from([("connections", 10_000), ("largestAddressConnections", 64)]),
        "their ceilings summed"
    );
    assert_eq!(
        gauges.connection_handles.into_iter().collect::<Vec<_>>(),
        handles,
        "every connection"
    );
    assert_eq!(gauges.anomalies, ["a socket held twice"], "every anomaly");

    uncounted.closed();
    assert_eq!(
        joined
            .gauges()
            .expect("its gauges")
            .counts
            .get("connections"),
        Some(&3),
        "one closed, counted by its events"
    );

    joined.stop().await;
    clock.settle().await;

    assert_eq!(
        (
            memory.ready_state(),
            first.ready_state(),
            second.ready_state()
        ),
        (ReadyState::Closed, ReadyState::Closed, ReadyState::Closed),
        "each stopped"
    );
    assert_eq!(paired.calls(), ["shutdown"], "the paired one stopped");
    assert_eq!(uncounted.calls(), ["shutdown"], "the uncounted one stopped");

    // what each counts once stopped: none of the memory's left, the paired one's as it says
    assert_eq!(
        joined.gauges().expect("its gauges").counts,
        BTreeMap::from([("connections", 1), ("largestAddressConnections", 1)]),
        "what each counts once stopped"
    );
}

// spec 15.14
#[tokio::test]
async fn serves_one_service_offered_once_to_a_client_of_each_transport() {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let brokered = brokered(&shared);
    let joined: Arc<dyn ServerTransport> = Arc::new(
        JoinedServerTransport::new(vec![
            Arc::new(memory.clone()),
            Arc::new(brokered.server.clone()),
        ])
        .expect("a join"),
    );
    let options = ServerOptions {
        clock: Some(Arc::clone(&shared)),
        ..ServerOptions::default()
    };
    let server = Server::new(Arc::clone(&joined), &options).expect("a server");
    let callers: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&callers);

    // * offered once, on the one server: each transport's client reaches it, both at once
    server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(TextCodec, TextCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");
    server.services().on_debug(Arc::new(
        move |_error: Option<&TracedError>, step: &DebugEvent| {
            if step.direction == DebugDirection::Rx
                && let Some(handle) = &step.connection_handle
            {
                locked(&hearing).push(handle.to_string());
            }
        },
    ));
    brokered.server.start().await.expect("started");

    let in_memory = memory_client_of((&memory, &shared));
    let by_broker = broker_client_of(&brokered);
    let by_memory =
        Client::new(Arc::new(in_memory.clone()), &ClientOptions::default()).expect("a client");
    let over_broker =
        Client::new(Arc::new(by_broker.clone()), &ClientOptions::default()).expect("a client");

    in_memory
        .connect(MemoryConnectOptions::default())
        .await
        .expect("connected");
    by_broker
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    clock.settle().await;

    let call = |client: &Client, text: &str| {
        client
            .services()
            .get_request(&echo(), RequestDependencies::of(TextCodec, TextCodec))
            .expect("echo asked")
            .call(text.to_owned(), RequestOptions::default())
            .expect("echo called")
    };
    let from_memory = call(&by_memory, "from memory");
    let from_broker = call(&over_broker, "from a broker");

    clock.settle().await;
    assert_eq!(
        (
            from_memory.await.expect("echoed"),
            from_broker.await.expect("echoed")
        ),
        ("from memory".to_owned(), "from a broker".to_owned()),
        "each echoed"
    );

    let mut heard = locked(&callers).clone();

    heard.sort_unstable();
    assert_eq!(
        heard,
        [
            "type=BROKER;participant=client;ordinal=1",
            "type=MEMORY;ip=local;ordinal=1"
        ],
        "each through its transport"
    );
    assert!(
        Arc::ptr_eq(&server.transport(), &joined),
        "the join its transport"
    );
    assert_eq!(server.health().await.status, HealthStatus::Pass, "healthy");

    let gauges = server.gauges().await;

    // both transports' connections counted as one transport's, and none of the router's left out
    assert_eq!(
        (
            gauges.transport.counts.get("connections").copied(),
            gauges.router.orphans
        ),
        (Some(2), 0),
        "both counted"
    );
    brokered.client_participant.stop().await;
    brokered.server_participant.stop().await;
}
