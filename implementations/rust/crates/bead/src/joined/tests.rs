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
use crate::broker::client::{
    BrokerTransportClient, BrokerTransportClientConnectOptions, BrokerTransportClientOptions,
};
use crate::broker::memory::{MemoryBroker, MemoryBrokerAdapterOptions, MemoryBrokerOptions};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions};
use crate::broker::server::{BrokerTransportServer, BrokerTransportServerOptions};
use crate::client::{Client, ClientOptions};
use crate::clock::SharedClock;
use crate::debug::DebugDirection;
use crate::duration::NEVER;
use crate::failure::ProcedureAddress;
use crate::managers::service::{
    DebugEvent, RequestDependencies, RequestOptions, RequestResolverDependencies, Response,
    TracedError,
};
use crate::memory::{
    MemoryTransportClient, MemoryTransportClientConnectOptions, MemoryTransportClientOptions,
    MemoryTransportServer, MemoryTransportServerOptions,
};
use crate::payloads::TextCodec;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::server::{HealthStatus, Server, ServerOptions};
use crate::testing::pair::echo;
use crate::testing::{SteppingClock, hexadecimal};
use crate::transport::{
    ClientListener, Listeners, ReadyState, RouterClientTransport, Sent, ServerListener,
    ServerTransport, TransportClientDisconnectOptions, TransportServerRefusal,
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
    // the procedures its connection takes, every one when none
    taking: Option<Vec<ProcedureAddress>>,
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
            taking: None,
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

    fn pause(&self, connection_handle: &ConnectionHandle) {
        locked(&self.calls).push(format!("pause {connection_handle}"));
    }

    fn resume(&self, connection_handle: &ConnectionHandle) {
        locked(&self.calls).push(format!("resume {connection_handle}"));
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

    fn names_procedures(&self) -> bool {
        self.taking.is_some()
    }

    fn takes_procedure(
        &self,
        connection_handle: &ConnectionHandle,
        address: ProcedureAddress,
    ) -> bool {
        locked(&self.calls).push(format!(
            "takes {}/{} {connection_handle}",
            address.service_id, address.procedure_id
        ));

        self.taking
            .as_ref()
            .is_none_or(|taking| taking.contains(&address))
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        locked(&self.calls).push("shutdown".to_owned());

        Box::pin(async { Ok(()) })
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

    fn pause(&self, _connection_handle: &ConnectionHandle) {
        locked(&self.calls).push("pause".to_owned());
    }

    fn resume(&self, _connection_handle: &ConnectionHandle) {
        locked(&self.calls).push("resume".to_owned());
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn transport_type(&self) -> Option<&str> {
        Some("HTTP")
    }
}

// an in-memory transport server on `clock`, started
async fn memory_on(clock: &SharedClock) -> MemoryTransportServer {
    let server = MemoryTransportServer::new(&MemoryTransportServerOptions {
        clock: Some(Arc::clone(clock)),
        runtime: None,
        procedures: None,
    })
    .expect("a server");

    server.start().await.expect("started");

    server
}

fn memory_client_of(clock: &SharedClock) -> MemoryTransportClient {
    MemoryTransportClient::new(&MemoryTransportClientOptions {
        clock: Some(Arc::clone(clock)),
    })
    .expect("a client")
}

// a broker on `clock`, the server's participant serving `interop` and a client's participant
struct Brokered {
    server_participant: BrokerParticipant,
    client_participant: BrokerParticipant,
    server: BrokerTransportServer,
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
                .adapter(&MemoryBrokerAdapterOptions::new(id))
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
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");

    Brokered {
        server_participant,
        client_participant,
        server,
    }
}

fn broker_client_of(brokered: &Brokered) -> BrokerTransportClient {
    brokered
        .client_participant
        .client(&BrokerTransportClientOptions::default())
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
    let client = memory_client_of(&shared);

    client
        .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
        .await
        .expect("connected");
    clock.settle().await;

    let drawn = memory
        .clients()
        .first()
        .map(|client| Arc::clone(&client.connection_handle))
        .expect("drawn");

    client
        .send(TransportMessage {
            data: Bytes::from_static(&[1]),
            ..TransportMessage::default()
        })
        .expect("sent");
    clock.settle().await;
    client
        .disconnect(&TransportClientDisconnectOptions::default())
        .expect("closed");
    clock.settle().await;

    // the broker's, its handle drawn at its third leg
    let broker_client = broker_client_of(&brokered);

    broker_client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    clock.settle().await;

    let by_broker = brokered
        .server
        .clients()
        .first()
        .map(|client| Arc::clone(&client.connection_handle))
        .expect("drawn");

    broker_client
        .send(TransportMessage {
            data: Bytes::from_static(&[2]),
            ..TransportMessage::default()
        })
        .expect("sent");
    clock.settle().await;
    broker_client
        .disconnect(&TransportClientDisconnectOptions::default())
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

    let client = memory_client_of(&shared);
    let broker_client = broker_client_of(&brokered);

    client.listen(Arc::new(Hearing(Arc::clone(&heard))));
    broker_client.listen(Arc::new(Hearing(Arc::clone(&heard))));
    client
        .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
        .await
        .expect("connected");
    broker_client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    clock.settle().await;
    paired.open();

    let drawn = memory
        .clients()
        .first()
        .map(|client| Arc::clone(&client.connection_handle))
        .expect("drawn");
    let by_broker = brokered
        .server
        .clients()
        .first()
        .map(|client| Arc::clone(&client.connection_handle))
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
    let first =
        MemoryTransportServer::new(&MemoryTransportServerOptions::default()).expect("a server");
    let second =
        MemoryTransportServer::new(&MemoryTransportServerOptions::default()).expect("a server");
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
    let elsewhere = MemoryTransportServer::new(&MemoryTransportServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
        procedures: None,
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
    let first = memory_client_of(&shared);
    let second = memory_client_of(&shared);

    first
        .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
        .await
        .expect("connected");
    second
        .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
        .await
        .expect("connected");
    clock.settle().await;
    uncounted.open();

    let gauges = joined.gauges().expect("its gauges");
    let mut handles: Vec<ConnectionHandle> = memory
        .clients()
        .into_iter()
        .map(|client| client.connection_handle)
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

    joined.stop().await.expect("stopped");
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
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
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

    let in_memory = memory_client_of(&shared);
    let by_broker = broker_client_of(&brokered);
    let by_memory =
        Client::new(Arc::new(in_memory.clone()), &ClientOptions::default()).expect("a client");
    let over_broker =
        Client::new(Arc::new(by_broker.clone()), &ClientOptions::default()).expect("a client");

    in_memory
        .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
        .await
        .expect("connected");
    by_broker
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    clock.settle().await;

    let call = |client: &Client, text: &str| {
        client
            .services()
            .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
            .expect("echo asked")
            .call(text.to_owned(), &RequestOptions::default())
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
    assert_eq!(
        server.health().await.expect("distinct counts").status,
        HealthStatus::Pass,
        "healthy"
    );

    let gauges = server.gauges().await.expect("distinct counts");

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

// what the join tells of each message, its first byte and its connection, as a line
struct Messages(Arc<Mutex<Vec<String>>>);

impl ServerListener for Messages {
    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        locked(&self.0).push(format!(
            "message {} {connection_handle}",
            message.data.first().copied().unwrap_or_default()
        ));
    }
}

// spec 15.12.17, 15.14: the twin of "a joined transport pauses the connection on the transport
// that drew it"
#[tokio::test]
async fn a_joined_transport_pauses_the_connection_on_the_transport_that_drew_it() {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let paired = Arc::new(Paired::default());
    let joined = JoinedServerTransport::new(vec![
        Arc::new(memory.clone()),
        Arc::<Paired>::clone(&paired),
    ])
    .expect("a join");
    let told: Arc<Mutex<Vec<String>>> = Arc::default();

    joined.listen(Arc::new(Messages(Arc::clone(&told))));

    let client = memory_client_of(&shared);
    let connecting = client.connect(&MemoryTransportClientConnectOptions::new(memory.clone()));

    clock.settle().await;
    connecting.await.expect("connected");
    paired.open();

    let local: ConnectionHandle = Arc::from("type=MEMORY;ip=local;ordinal=1");
    let socket: ConnectionHandle = Arc::from(SOCKET);

    // * the WebSocket-typed one's pause and resume asked of it alone
    joined.pause(&socket);
    joined.resume(&socket);

    assert_eq!(
        paired.calls(),
        [format!("pause {SOCKET}"), format!("resume {SOCKET}")],
        "asked of the transport that drew it"
    );

    // the in-memory one's held by it, in order, until resumed
    joined.pause(&local);

    for byte in [1_u8, 2] {
        client
            .send(TransportMessage {
                data: Bytes::copy_from_slice(&[byte]),
                ..TransportMessage::default()
            })
            .expect("sent");
    }

    clock.settle().await;

    assert!(locked(&told).is_empty(), "nothing told while paused");

    joined.resume(&local);
    clock.settle().await;

    assert_eq!(
        *locked(&told),
        [
            "message 1 type=MEMORY;ip=local;ordinal=1",
            "message 2 type=MEMORY;ip=local;ordinal=1"
        ],
        "each told, in order, once resumed"
    );
    assert_eq!(
        paired.calls(),
        [format!("pause {SOCKET}"), format!("resume {SOCKET}")],
        "nothing more asked of the other"
    );

    // a handle no transport of it drew is asked of none
    joined.pause(&Arc::from("type=HTTP;ip=127.0.0.1;port=50003;ordinal=1"));

    assert_eq!(paired.calls().len(), 2, "none asked");
}

// a procedure's address
const fn address_of(service_id: u16, procedure_id: u16) -> ProcedureAddress {
    ProcedureAddress {
        service_id,
        procedure_id,
    }
}

// spec 9.11, 15.14: the twin of "a joined transport answers whether a connection takes a procedure
// by the transport that drew its handle"
#[tokio::test]
async fn a_joined_transport_answers_whether_a_connection_takes_a_procedure_by_the_transport_that_drew_its_handle()
 {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = MemoryTransportServer::new(&MemoryTransportServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
        procedures: Some(vec![address_of(1, 1)]),
    })
    .expect("a server");
    let paired = Arc::new(Paired {
        taking: Some(vec![address_of(1, 2)]),
        ..Paired::default()
    });
    let joined = JoinedServerTransport::new(vec![Arc::new(memory), Arc::<Paired>::clone(&paired)])
        .expect("a join");
    let local: ConnectionHandle = Arc::from("type=MEMORY;ip=local;ordinal=1");
    let socket: ConnectionHandle = Arc::from(SOCKET);

    // * each asked of the transport that drew it, by its handle's type
    assert!(
        joined.takes_procedure(&local, address_of(1, 1)),
        "the in-memory one takes 1/1"
    );
    assert!(
        !joined.takes_procedure(&local, address_of(1, 2)),
        "the in-memory one does not take 1/2"
    );
    assert!(
        joined.takes_procedure(&socket, address_of(1, 2)),
        "the WebSocket-typed one takes 1/2"
    );
    assert!(
        !joined.takes_procedure(&socket, address_of(1, 1)),
        "the WebSocket-typed one does not take 1/1"
    );
    assert_eq!(
        paired.calls(),
        [format!("takes 1/2 {SOCKET}"), format!("takes 1/1 {SOCKET}")],
        "the other asked of its own connection alone"
    );

    // a handle no transport of it drew takes none, and is asked of none
    assert!(
        !joined.takes_procedure(
            &Arc::from("type=HTTP;ip=127.0.0.1;port=50003;ordinal=1"),
            address_of(1, 1)
        ),
        "a handle of no transport of it takes nothing"
    );
    assert_eq!(paired.calls().len(), 2, "none asked");
}

// spec 9.11, 15.14: the twin of "a joined transport asks of procedures only when one of its
// transports names them"
#[tokio::test]
async fn a_joined_transport_asks_of_procedures_only_when_one_of_its_transports_names_them() {
    let clock = SteppingClock::new(january_first());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let memory = memory_on(&shared).await;
    let unnamed =
        JoinedServerTransport::new(vec![Arc::new(memory.clone()), Arc::new(Paired::default())])
            .expect("a join");

    assert!(
        !unnamed.names_procedures(),
        "none of its transports names procedures"
    );

    let named = JoinedServerTransport::new(vec![
        Arc::new(memory),
        Arc::new(Paired {
            taking: Some(Vec::new()),
            ..Paired::default()
        }),
    ])
    .expect("a join");

    assert!(
        named.names_procedures(),
        "one of its transports names procedures"
    );
    // * the one that names none takes every procedure, as it would alone
    assert!(
        named.takes_procedure(
            &Arc::from("type=MEMORY;ip=local;ordinal=1"),
            address_of(9, 9)
        ),
        "the in-memory one takes every procedure"
    );
    assert!(
        !named.takes_procedure(&Arc::from(SOCKET), address_of(9, 9)),
        "the WebSocket-typed one, given none, takes none"
    );
}
