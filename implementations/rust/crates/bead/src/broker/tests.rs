//! The broker's core's tests (spec 15.16 to 15.24): its parcel, its sequence and its parts, its
//! heartbeat, the in-memory broker, a participant, and the client's and the server's transports
//! over it; what of a broker no case of `spec/transports.json` reaches, by the other sides'
//! sentences.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;

use super::adapter::{BrokerAdapter, BrokerCapabilities, BrokerListener, BrokerMessage};
use super::client::{BrokerClient, BrokerClientOptions, BrokerConnectOptions};
use super::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerOptions,
};
use super::parcel::{Parcel, ParcelRead, read_parcel};
use super::participant::{BrokerParticipant, BrokerParticipantOptions};
use super::server::{BrokerServer, BrokerServerOptions};
use crate::router::types::{ConnectionHandle, RouterError, TransportMessage};
use crate::testing::Instant;
use crate::transport::{
    ClientListener, ReconnectDelay, ReconnectOptions, ServerListener, ServerTransport,
    TransportServerRefusal,
};

mod client;
mod heartbeat;
mod memory;
mod message;
mod parcel;
mod participant;
mod sequence;
mod server;

/// How long a test waits, on the real clock, for what it awaits.
pub(super) const PATIENCE: Duration = Duration::from_secs(10);

pub(super) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Waits, on the real clock and within a patience, until `holds` does; fails saying `what`.
pub(super) async fn until<F: Fn() -> bool>(holds: F, what: &str) {
    let start = Instant::now();

    while !holds() && start.elapsed() < PATIENCE {
        crate::testing::rest(Duration::from_millis(5)).await;
    }

    assert!(holds(), "{what}");
}

/// A turn of the runtime, and a little of the real clock: past what a broker handed on in a later
/// one.
pub(super) async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    crate::testing::rest(Duration::from_millis(20)).await;
}

/// A broker of the test's own, on the platform's clock.
pub(super) fn broker() -> MemoryBroker {
    MemoryBroker::new(&MemoryBrokerOptions::default()).expect("a broker")
}

/// An adapter of `broker` of `id`.
pub(super) fn adapter_of(broker: &MemoryBroker, id: &str) -> MemoryBrokerAdapter {
    broker
        .adapter(&MemoryBrokerAdapterOptions::of(id))
        .expect("an adapter")
}

/// A participant over `adapter`, as `options` says.
pub(super) fn participant_of(
    adapter: &MemoryBrokerAdapter,
    options: &BrokerParticipantOptions,
) -> BrokerParticipant {
    let adapter: Arc<dyn BrokerAdapter> = Arc::new(adapter.clone());

    BrokerParticipant::new(adapter, options).expect("a participant")
}

/// What a message is read as, a parcel or none.
pub(super) fn parcel_of(payload: &Bytes) -> Option<Parcel> {
    match read_parcel(payload) {
        ParcelRead::Parcel(parcel) => Some(parcel),
        ParcelRead::NoParcel(_) | ParcelRead::DoesNotRead(..) => None,
    }
}

/// What an adapter's listener hears: each message, acknowledged as it comes, and each down.
#[derive(Default)]
pub(super) struct Heard {
    pub(super) messages: Mutex<Vec<(Vec<String>, Bytes, bool)>>,
    pub(super) downs: Mutex<Vec<bool>>,
}

impl Heard {
    /// The messages heard, each its topic joined and its payload.
    pub(super) fn messages(&self) -> Vec<(String, Bytes)> {
        locked(&self.messages)
            .iter()
            .map(|(topic, payload, _)| (topic.join("/"), payload.clone()))
            .collect()
    }

    /// The parcels heard, in order.
    pub(super) fn parcels(&self) -> Vec<Parcel> {
        locked(&self.messages)
            .iter()
            .filter_map(|(_, payload, _)| parcel_of(payload))
            .collect()
    }
}

/// A listener that writes down what it hears into `heard`.
pub(super) struct Hearing(pub(super) Arc<Heard>);

impl BrokerListener for Hearing {
    fn on_message(&self, message: &BrokerMessage) {
        message.settle();
        locked(&self.0.messages).push((
            message.topic().to_vec(),
            message.payload().clone(),
            message.is_retained(),
        ));
    }

    fn on_down(&self, down: super::adapter::BrokerDown) {
        locked(&self.0.downs).push(down.is_taken_over);
    }
}

/// A peer of the test's own: an adapter of `broker`, started, whose inbox and `topics` are
/// subscribed, what it hears written down.
pub(super) async fn peer_of(
    broker: &MemoryBroker,
    (id, topics): (&str, &[&[&str]]),
) -> (MemoryBrokerAdapter, Arc<Heard>) {
    let adapter = adapter_of(broker, id);
    let heard = Arc::new(Heard::default());

    adapter.listen(Arc::new(Hearing(Arc::clone(&heard))));
    adapter
        .start(super::adapter::BrokerStart::default())
        .await
        .expect("started");
    adapter
        .subscribe(
            &["bead".to_owned(), "i".to_owned(), id.to_owned()],
            super::adapter::BrokerSubscription::default(),
        )
        .await
        .expect("subscribed");

    for topic in topics {
        let topic: Vec<String> = topic.iter().map(|token| (*token).to_owned()).collect();

        adapter
            .subscribe(&topic, super::adapter::BrokerSubscription::default())
            .await
            .expect("subscribed");
    }

    (adapter, heard)
}

/// An adapter around a memory broker's, passing every call on, that writes down each call its
/// participant makes of it, in order, and the life each publication asked, by what it carries: what
/// it publishes to a topic bounded by `room` when given, its leg secure as `secure` says when given;
/// and, when `grants` is, the subscription to its inbox held until a test grants it.
#[derive(Debug)]
pub(super) struct Calling {
    pub(super) inner: MemoryBrokerAdapter,
    pub(super) room: Option<u64>,
    pub(super) secure: Option<bool>,
    pub(super) grants: bool,
    pub(super) calls: Mutex<Vec<String>>,
    pub(super) lives: Mutex<Vec<(&'static str, Option<Duration>)>>,
    pub(super) inbox: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
}

impl Calling {
    pub(super) fn of(inner: MemoryBrokerAdapter) -> Self {
        Self {
            inner,
            room: None,
            secure: None,
            grants: false,
            calls: Mutex::default(),
            lives: Mutex::default(),
            inbox: Mutex::default(),
        }
    }

    pub(super) fn calls(&self) -> Vec<String> {
        locked(&self.calls).clone()
    }

    /// Grants the subscription to its inbox its participant asked first.
    pub(super) fn grant(&self) -> bool {
        let grant = {
            let mut inbox = locked(&self.inbox);

            (!inbox.is_empty()).then(|| inbox.remove(0))
        };

        grant.is_some_and(|grant| grant.send(()).is_ok())
    }

    pub(super) fn asked(&self) -> usize {
        locked(&self.inbox).len()
    }
}

impl BrokerAdapter for Calling {
    fn transport_type(&self) -> &str {
        self.inner.transport_type()
    }

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.inner.capabilities()
    }

    fn delivery(&self) -> super::adapter::BrokerDelivery {
        self.inner.delivery()
    }

    fn is_secure(&self) -> bool {
        self.secure.unwrap_or_else(|| self.inner.is_secure())
    }

    fn receive_bound(&self, topic: &[String]) -> u64 {
        self.inner.receive_bound(topic)
    }

    fn maximum_payload_bytes(&self, topic: &[String]) -> u64 {
        self.room
            .unwrap_or_else(|| self.inner.maximum_payload_bytes(topic))
    }

    fn listen(&self, listener: Arc<dyn BrokerListener>) {
        self.inner.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        self.inner.unlisten(listener);
    }

    fn start(
        &self,
        options: super::adapter::BrokerStart,
    ) -> crate::router::types::BoxFuture<Result<(), super::adapter::BrokerError>> {
        locked(&self.calls).push("start".to_owned());

        self.inner.start(options)
    }

    fn subscribe(
        &self,
        topic: &[String],
        options: super::adapter::BrokerSubscription,
    ) -> crate::router::types::BoxFuture<Result<(), super::adapter::BrokerError>> {
        locked(&self.calls).push(format!("subscribe {}", topic.join("/")));

        if self.grants && topic.get(1).is_some_and(|place| place == "i") {
            let (grant, granted) = tokio::sync::oneshot::channel();
            let inner = self.inner.clone();
            let topic = topic.to_vec();

            locked(&self.inbox).push(grant);

            return Box::pin(async move {
                granted.await.ok();

                // * granted before its loss was read: its SUBACK came all the same
                if !inner.is_linked() {
                    return Ok(());
                }

                inner.subscribe(&topic, options).await
            });
        }

        self.inner.subscribe(topic, options)
    }

    fn unsubscribe(
        &self,
        topic: &[String],
    ) -> crate::router::types::BoxFuture<Result<(), super::adapter::BrokerError>> {
        locked(&self.calls).push(format!("unsubscribe {}", topic.join("/")));

        self.inner.unsubscribe(topic)
    }

    fn publish(
        &self,
        publication: super::adapter::BrokerPublication,
    ) -> crate::router::types::BoxFuture<
        Result<super::adapter::BrokerPublished, super::adapter::BrokerError>,
    > {
        let kind = match parcel_of(&publication.payload) {
            Some(parcel) if parcel.kind == super::parcel::kinds::OPEN => "open",
            Some(parcel)
                if parcel.kind == super::parcel::kinds::DATA && parcel.credential.is_some() =>
            {
                "credential"
            }
            Some(_) | None => "other",
        };

        locked(&self.calls).push(format!("publish {}", publication.topic.join("/")));
        locked(&self.lives).push((kind, publication.expires_after));

        self.inner.publish(publication)
    }

    fn stop(&self) -> crate::router::types::BoxFuture<()> {
        locked(&self.calls).push("stop".to_owned());

        self.inner.stop()
    }
}

/// The acceptor's half, a test's own peer's.
pub(super) const ACCEPTOR_HALF: u64 = 0xA100_0000_0000_0001;

/// A peer of the test's own, serving interop, that accepts the connect of `client`, a client of a
/// participant of the id `ada`, its bound given:
/// what it hears from then on, and the client's half.
pub(super) async fn accepted_of(
    (broker, client): (&MemoryBroker, &BrokerClient),
    bound: u64,
) -> (MemoryBrokerAdapter, Arc<Heard>, u64) {
    let (acceptor, heard) = peer_of(broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let connecting = crate::testing::spawn(client.connect(BrokerConnectOptions::of("interop")));

    until(|| heard.parcels().len() == 1, "its OPEN reaches the name").await;

    let open = heard.parcels().remove(0);

    locked(&heard.messages).clear();

    let accept = Parcel {
        flags: Some(super::parcel::flags::SECURE),
        opener: open.opener,
        acceptor: ACCEPTOR_HALF,
        sequence: 1,
        id: Some("acceptor".to_owned()),
        incarnation: Some(0xC0),
        bound: Some(bound),
        ..Parcel::of(super::parcel::kinds::ACCEPT)
    };

    acceptor
        .publish(super::adapter::BrokerPublication::of(
            ["bead", "i", "ada"],
            super::parcel::write_parcel(&accept).expect("written"),
        ))
        .await
        .expect("published");
    connecting.await.expect("joined").expect("connected");
    until(|| heard.parcels().len() == 1, "its third leg's PING").await;

    let ping = heard.parcels().remove(0);

    assert_eq!(
        (ping.kind, ping.sequence),
        (super::parcel::kinds::PING, 2),
        "its third leg's PING, the second of its sequence"
    );
    locked(&heard.messages).clear();

    (acceptor, heard, open.opener)
}

/// Publishes `parcel`'s bytes, as written or encoded, to `topic`.
pub(super) async fn publish_to(
    adapter: &MemoryBrokerAdapter,
    (topic, payload): ([&str; 3], Vec<u8>),
) -> super::adapter::BrokerPublished {
    adapter
        .publish(super::adapter::BrokerPublication::of(
            topic,
            Bytes::from(payload),
        ))
        .await
        .expect("published")
}

/// What a server's transport told, each as a line, and its handles drawn.
#[derive(Default)]
pub(super) struct ServerTold {
    pub(super) opened: Mutex<Vec<ConnectionHandle>>,
    pub(super) closed: Mutex<Vec<(bool, ConnectionHandle)>>,
    pub(super) messages: Mutex<Vec<(TransportMessage, ConnectionHandle)>>,
    pub(super) refusals: Mutex<Vec<TransportServerRefusal>>,
    pub(super) errors: Mutex<Vec<(String, Option<ConnectionHandle>)>>,
}

pub(super) struct AtServer(pub(super) Arc<ServerTold>);

impl ServerListener for AtServer {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.0.opened).push(Arc::clone(connection_handle));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        locked(&self.0.messages).push((message, Arc::clone(connection_handle)));
    }

    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.0.closed).push((was_clean, Arc::clone(connection_handle)));
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        locked(&self.0.refusals).push(refusal.clone());
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        locked(&self.0.errors).push((error.to_string(), connection_handle.cloned()));
    }
}

/// What a client's transport told, each as it came.
#[derive(Default)]
pub(super) struct ClientTold {
    pub(super) messages: Mutex<Vec<TransportMessage>>,
    pub(super) closes: Mutex<Vec<(bool, bool)>>,
    pub(super) errors: Mutex<Vec<String>>,
    pub(super) reconnects: Mutex<usize>,
}

pub(super) struct AtClient(pub(super) Arc<ClientTold>);

impl ClientListener for AtClient {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.0.messages).push(message);
    }

    fn on_close(&self, was_clean: bool, is_quick: bool) {
        locked(&self.0.closes).push((was_clean, is_quick));
    }

    fn on_reconnect(&self) {
        let mut reconnects = locked(&self.0.reconnects);

        *reconnects = reconnects.saturating_add(1);
    }

    fn on_error(&self, error: &RouterError) {
        locked(&self.0.errors).push(error.to_string());
    }
}

/// How a broker pair is built: its client's adapter's capabilities, and its heartbeat.
#[derive(Default)]
pub(super) struct BrokerPairOptions {
    pub(super) client_capabilities: Option<BrokerCapabilities>,
    pub(super) heartbeat: Option<Duration>,
}

/// A server's transport and its clients' participant over one in-memory broker: the server's
/// participant `server` serving `interop`, the clients' `client`, and what the server's transport
/// told, in order.
pub(super) struct BrokerPair {
    pub(super) broker: MemoryBroker,
    pub(super) server_adapter: MemoryBrokerAdapter,
    pub(super) client_adapter: MemoryBrokerAdapter,
    pub(super) server_participant: BrokerParticipant,
    pub(super) client_participant: BrokerParticipant,
    pub(super) server: BrokerServer,
    pub(super) told: Arc<ServerTold>,
}

impl BrokerPair {
    pub(super) async fn of(options: BrokerPairOptions) -> Self {
        let broker = broker();
        let server_adapter = adapter_of(&broker, "server");
        let mut client_options = MemoryBrokerAdapterOptions::of("client");

        client_options.capabilities = options.client_capabilities;

        let client_adapter = broker.adapter(&client_options).expect("an adapter");
        let server_participant_options = BrokerParticipantOptions {
            heartbeat: options.heartbeat,
            ..BrokerParticipantOptions::default()
        };
        let server_participant = participant_of(&server_adapter, &server_participant_options);
        let client_participant_options = BrokerParticipantOptions {
            heartbeat: options.heartbeat,
            reconnect: Some(ReconnectOptions {
                delay: Some(ReconnectDelay::Fixed(Duration::ZERO)),
                maximum_attempts: Some(u32::MAX),
                ..ReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        };

        let client_participant = participant_of(&client_adapter, &client_participant_options);
        let server = server_participant
            .server(&BrokerServerOptions::of(["interop"]))
            .expect("a server");
        let told = Arc::new(ServerTold::default());

        server.listen(Arc::new(AtServer(Arc::clone(&told))));
        server.start().await.expect("started");
        client_participant.start().await.expect("started");

        Self {
            broker,
            server_adapter,
            client_adapter,
            server_participant,
            client_participant,
            server,
            told,
        }
    }

    /// A client of the clients' participant, connected to `interop`, its connection told open at
    /// the server.
    pub(super) async fn connect(&self) -> BrokerClient {
        let before = locked(&self.told.opened).len();
        let client = self
            .client_participant
            .client(&BrokerClientOptions::default())
            .expect("a client");

        client
            .connect(BrokerConnectOptions::of("interop"))
            .await
            .expect("connected");
        until(
            || locked(&self.told.opened).len() > before,
            "the server tells the connection open",
        )
        .await;

        client
    }

    /// Stops what it built.
    pub(super) async fn stop(&self) {
        self.server.stop().await;
        self.client_participant.stop().await;
        self.server_participant.stop().await;
    }
}
