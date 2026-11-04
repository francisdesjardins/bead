//! The broker's core's tests (spec 15.16 to 15.24): its parcel, its sequence and its parts, its
//! heartbeat, the in-memory broker, a participant, and the client's and the server's transports
//! over it; what of a broker no case of `spec/transports.json` reaches, by the other sides'
//! sentences.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;

use super::adapter::{BrokerAdapter, BrokerCapabilities, BrokerListener, BrokerMessage};
use super::client::{
    BrokerTransportClient, BrokerTransportClientConnectOptions, BrokerTransportClientOptions,
};
use super::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerOptions,
};
use super::parcel::{Parcel, ParcelRead, read_parcel};
use super::participant::{BrokerParticipant, BrokerParticipantOptions};
use super::server::{BrokerTransportServer, BrokerTransportServerOptions};
use crate::errors::{ProgrammerError, TransportError};
use crate::router::types::{ConnectionHandle, RouterError, TransportMessage};
use crate::testing::Instant;
use crate::transport::{
    ClientListener, ServerListener, ServerTransport, TransportClientReconnectDelay,
    TransportClientReconnectOptions, TransportServerRefusal,
};

mod adapter;
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
        crate::testing::yield_now().await;
    }

    crate::testing::rest(Duration::from_millis(20)).await;
}

/// The misuse `error` is, or the first its sources carry.
pub(super) fn misuse_in(error: &(dyn Error + 'static)) -> Option<ProgrammerError> {
    let mut source = Some(error);

    while let Some(cause) = source {
        if let Some(misuse) = cause.downcast_ref::<ProgrammerError>() {
            return Some(misuse.clone());
        }
        if let Some(TransportError::Refused(misuse)) = cause.downcast_ref::<TransportError>() {
            return Some(misuse.clone());
        }

        source = cause.source();
    }

    None
}

/// A broker of the test's own, on the platform's clock.
pub(super) fn broker() -> MemoryBroker {
    MemoryBroker::new(&MemoryBrokerOptions::default()).expect("a broker")
}

/// An adapter of `broker` of `id`.
pub(super) fn adapter_of(broker: &MemoryBroker, id: &str) -> MemoryBrokerAdapter {
    broker
        .adapter(&MemoryBrokerAdapterOptions::new(id))
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
/// each start after its first `starts` refused as it returns, when given; each start after its
/// first `holds` held, heeding no signal, until a test releases it, when given; when `grants` is,
/// the subscription to its inbox held until a test grants it; when `holds_stops` is, each stop held
/// until a test releases it; and the CLOSE of the opener `drops_close` names, when it names one,
/// answered no subscriber and never handed on, as its broker would leave one it did not take. It
/// writes down each listener it is asked to let go of, and counts those it holds.
#[derive(Debug)]
pub(super) struct Calling {
    pub(super) inner: MemoryBrokerAdapter,
    pub(super) room: Option<u64>,
    pub(super) secure: Option<bool>,
    pub(super) starts: Option<usize>,
    pub(super) holds: Option<usize>,
    // its first starts refused as a misuse, as an adapter whose link is up already refuses one
    pub(super) refuses: Option<usize>,
    // its start awaits its signal, then fails: a start its stop overtakes
    pub(super) gives_up: bool,
    pub(super) grants: bool,
    pub(super) holds_stops: bool,
    pub(super) drops_close: Mutex<Option<u64>>,
    pub(super) calls: Mutex<Vec<String>>,
    pub(super) lives: Mutex<Vec<(&'static str, Option<Duration>)>>,
    pub(super) held: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    pub(super) inbox: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    pub(super) stops: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    pub(super) listening: AtomicUsize,
}

impl Calling {
    pub(super) fn of(inner: MemoryBrokerAdapter) -> Self {
        Self {
            inner,
            room: None,
            secure: None,
            starts: None,
            holds: None,
            refuses: None,
            gives_up: false,
            grants: false,
            holds_stops: false,
            drops_close: Mutex::new(None),
            calls: Mutex::default(),
            lives: Mutex::default(),
            held: Mutex::default(),
            inbox: Mutex::default(),
            stops: Mutex::default(),
            listening: AtomicUsize::new(0),
        }
    }

    /// Releases the stop its participant asked first of those it holds.
    pub(super) fn release_stop(&self) -> bool {
        let release = {
            let mut stops = locked(&self.stops);

            (!stops.is_empty()).then(|| stops.remove(0))
        };

        release.is_some_and(|release| release.send(()).is_ok())
    }

    /// The stops it holds, unreleased.
    pub(super) fn stopping(&self) -> usize {
        locked(&self.stops).len()
    }

    /// The listeners it holds.
    pub(super) fn listening(&self) -> usize {
        self.listening.load(Ordering::SeqCst)
    }

    /// Releases the start its participant asked first of those it holds.
    pub(super) fn release(&self) -> bool {
        let release = {
            let mut held = locked(&self.held);

            (!held.is_empty()).then(|| held.remove(0))
        };

        release.is_some_and(|release| release.send(()).is_ok())
    }

    /// The starts it holds, unreleased.
    pub(super) fn holding(&self) -> usize {
        locked(&self.held).len()
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
        self.listening.fetch_add(1, Ordering::SeqCst);
        self.inner.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        locked(&self.calls).push("unlisten".to_owned());
        self.listening.fetch_sub(1, Ordering::SeqCst);
        self.inner.unlisten(listener);
    }

    fn start(
        &self,
        options: super::adapter::BrokerStart,
    ) -> crate::router::types::BoxFuture<Result<(), super::adapter::BrokerError>> {
        let started = {
            let mut calls = locked(&self.calls);

            calls.push("start".to_owned());
            calls.iter().filter(|call| *call == "start").count()
        };

        if self.starts.is_some_and(|starts| started > starts) {
            return Box::pin(async { Err(super::adapter::BrokerError::failed("refused at once")) });
        }

        if self.refuses.is_some_and(|refuses| started <= refuses) {
            let refused = ProgrammerError::new(format!("the link of {} is up already", self.id()));

            return Box::pin(async move { Err(super::adapter::BrokerError::from(refused)) });
        }

        if self.gives_up {
            let signal = options.signal.unwrap_or_default();

            // * it waits for its stop's signal, then fails, saying so
            return Box::pin(async move {
                signal.cancelled().await;

                Err(super::adapter::BrokerError::failed(
                    "the adapter gave up its start",
                ))
            });
        }

        if self.holds.is_some_and(|holds| started > holds) {
            let (release, released) = tokio::sync::oneshot::channel();
            let inner = self.inner.clone();

            locked(&self.held).push(release);

            // * held as it is asked, its signal unheard: it goes on once the test releases it
            return Box::pin(async move {
                released.await.ok();
                inner.start(options).await
            });
        }

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

        let is_dropped = parcel_of(&publication.payload).is_some_and(|parcel| {
            parcel.kind == super::parcel::kinds::CLOSE
                && *locked(&self.drops_close) == Some(parcel.opener)
        });

        // * a CLOSE its broker did not take: answered, never handed on
        if is_dropped {
            return Box::pin(async { Ok(super::adapter::BrokerPublished::NoSubscriber) });
        }

        self.inner.publish(publication)
    }

    fn stop(&self) -> crate::router::types::BoxFuture<()> {
        locked(&self.calls).push("stop".to_owned());

        if self.holds_stops {
            let (release, released) = tokio::sync::oneshot::channel();
            let inner = self.inner.clone();

            locked(&self.stops).push(release);

            // * held as it is asked: it goes on once the test releases it
            return Box::pin(async move {
                released.await.ok();
                inner.stop().await;
            });
        }

        self.inner.stop()
    }
}

/// The acceptor's half, a test's own peer's.
pub(super) const ACCEPTOR_HALF: u64 = 0xA100_0000_0000_0001;

/// A peer of the test's own, serving interop, that accepts the connect of `client`, a client of a
/// participant of the id `ada`, its bound given:
/// what it hears from then on, and the client's half.
pub(super) async fn accepted_of(
    (broker, client): (&MemoryBroker, &BrokerTransportClient),
    bound: u64,
) -> (MemoryBrokerAdapter, Arc<Heard>, u64) {
    let (acceptor, heard) = peer_of(broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let connecting =
        crate::testing::spawn(client.connect(&BrokerTransportClientConnectOptions::new("interop")));

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
        .publish(super::adapter::BrokerPublication::new(
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
        .publish(super::adapter::BrokerPublication::new(
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

/// How a broker pair is built: its client's adapter's capabilities, and its heartbeat; its
/// broker's bound on a message, and its server participant's on what it holds.
#[derive(Default)]
pub(super) struct BrokerPairOptions {
    pub(super) client_capabilities: Option<BrokerCapabilities>,
    pub(super) heartbeat: Option<Duration>,
    pub(super) maximum_message_bytes: Option<u64>,
    pub(super) held_bytes_budget: Option<u64>,
    pub(super) maximum_held_envelope_bytes: Option<u64>,
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
    pub(super) server: BrokerTransportServer,
    pub(super) told: Arc<ServerTold>,
}

impl BrokerPair {
    pub(super) async fn of(options: &BrokerPairOptions) -> Self {
        let broker = MemoryBroker::new(&MemoryBrokerOptions {
            maximum_message_bytes: options.maximum_message_bytes,
            ..MemoryBrokerOptions::default()
        })
        .expect("a broker");
        let server_adapter = adapter_of(&broker, "server");
        let mut client_options = MemoryBrokerAdapterOptions::new("client");

        client_options.capabilities = options.client_capabilities;

        let client_adapter = broker.adapter(&client_options).expect("an adapter");
        let server_participant_options = BrokerParticipantOptions {
            heartbeat: options.heartbeat,
            held_bytes_budget: options.held_bytes_budget,
            maximum_held_envelope_bytes: options.maximum_held_envelope_bytes,
            ..BrokerParticipantOptions::default()
        };
        let server_participant = participant_of(&server_adapter, &server_participant_options);
        let client_participant_options = BrokerParticipantOptions {
            heartbeat: options.heartbeat,
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
                maximum_attempts: Some(u32::MAX),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        };

        let client_participant = participant_of(&client_adapter, &client_participant_options);
        let server = server_participant
            .server(&BrokerTransportServerOptions::new(["interop"]))
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
    pub(super) async fn connect(&self) -> BrokerTransportClient {
        let before = locked(&self.told.opened).len();
        let client = self
            .client_participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client");

        client
            .connect(&BrokerTransportClientConnectOptions::new("interop"))
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
        self.server.stop().await.expect("stopped");
        self.client_participant.stop().await;
        self.server_participant.stop().await;
    }
}

// ── What a participant holds for a connection its router paused (spec 15.12, 15.23) ───────────

// the twins of a participant's hold: by the other sides' sentences, over the in-memory broker, a
// server's transport paused and resumed as its router would
mod held {
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;

    use super::{BrokerPair, BrokerPairOptions, PATIENCE, locked, settle, until};
    use crate::broker::participant::BrokerParticipant;
    use crate::router::types::{ConnectionHandle, TransportMessage};
    use crate::testing::Instant;
    use crate::transport::{
        RouterClientTransport, ServerListener, ServerTransport, TransportClientDisconnectOptions,
    };

    // an envelope of `length` bytes, each `byte`
    fn data_of(byte: u8, length: usize) -> TransportMessage {
        TransportMessage {
            data: Bytes::from(vec![byte; length]),
            ..TransportMessage::default()
        }
    }

    // what a server's transport told, in order: each message's connection's rank, its first byte
    // and its length, and each close
    struct Logged(Arc<Mutex<Vec<String>>>);

    fn rank_of(connection_handle: &ConnectionHandle) -> &str {
        connection_handle.rsplit('=').next().unwrap_or_default()
    }

    impl ServerListener for Logged {
        fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
            locked(&self.0).push(format!(
                "{} {:02X} {}",
                rank_of(connection_handle),
                message.data.first().copied().unwrap_or_default(),
                message.data.len()
            ));
        }

        fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
            locked(&self.0).push(format!("{} closed {was_clean}", rank_of(connection_handle)));
        }
    }

    fn logged(pair: &BrokerPair) -> Arc<Mutex<Vec<String>>> {
        let log: Arc<Mutex<Vec<String>>> = Arc::default();

        pair.server.listen(Arc::new(Logged(Arc::clone(&log))));

        log
    }

    fn log_of(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        locked(log).clone()
    }

    // waits, within a patience, until what each connection of `participant` holds is `held`
    async fn until_held(participant: &BrokerParticipant, held: &[(usize, bool)]) {
        let start = Instant::now();

        while participant.held().await != held && start.elapsed() < PATIENCE {
            crate::testing::rest(core::time::Duration::from_millis(5)).await;
        }

        assert_eq!(participant.held().await, held, "what its participant holds");
    }

    // the handles its server's transport drew, in order
    fn handles_of(pair: &BrokerPair) -> Vec<ConnectionHandle> {
        locked(&pair.told.opened).clone()
    }

    // spec 15.12.17, 15.23.5: the twin of "holds what comes for a paused connection, in order, and
    // loses it alone past maximumHeldEnvelopeBytes"
    #[tokio::test]
    async fn holds_what_comes_for_a_paused_connection_in_order_and_loses_it_alone_past_maximum_held_envelope_bytes()
     {
        let pair = BrokerPair::of(&BrokerPairOptions {
            maximum_held_envelope_bytes: Some(100),
            ..BrokerPairOptions::default()
        })
        .await;
        let log = logged(&pair);
        let first = pair.connect().await;
        let second = pair.connect().await;
        let handles = handles_of(&pair);

        pair.server.pause(&handles[0]);

        for byte in [1, 2, 3] {
            first.send(data_of(byte, 30)).expect("sent");
        }

        until_held(&pair.server_participant, &[(3, false), (0, false)]).await;
        second.send(data_of(9, 30)).expect("sent");
        until(|| log_of(&log).len() == 1, "the other connection's told").await;

        assert_eq!(
            log_of(&log),
            ["2 09 30"],
            "nothing of the paused connection told, the other's at once"
        );

        pair.server.resume(&handles[0]);
        until(|| log_of(&log).len() == 4, "what it held told").await;

        assert_eq!(
            log_of(&log),
            ["2 09 30", "1 01 30", "1 02 30", "1 03 30"],
            "what it held, in order, once resumed"
        );

        // * past its bound, 120 bytes against 100: that connection lost, a CLOSE of 4000, alone
        pair.server.pause(&handles[0]);

        for byte in [4, 5, 6, 7] {
            first.send(data_of(byte, 30)).expect("sent");
        }

        until(
            || log_of(&log).contains(&"1 closed false".to_owned()),
            "the paused connection lost",
        )
        .await;
        second.send(data_of(10, 30)).expect("sent");
        until(
            || log_of(&log).contains(&"2 0A 30".to_owned()),
            "the other connection goes on",
        )
        .await;

        assert_eq!(
            log_of(&log),
            [
                "2 09 30",
                "1 01 30",
                "1 02 30",
                "1 03 30",
                "1 closed false",
                "2 0A 30"
            ],
            "nothing it held told, the other connection told on"
        );
        assert!(
            locked(&pair.told.errors).iter().any(|(error, handle)| {
                error.ends_with(
                    "is closed with 4000: what it holds for its router, paused, would pass maximumHeldEnvelopeBytes, 100 bytes",
                ) && handle.as_ref() == handles.first()
            }),
            "reported naming the bound, with its connection: {:?}",
            locked(&pair.told.errors)
        );

        pair.stop().await;
    }

    // spec 15.12.17, 15.23.5: the twin of "a resume with a hand already queued keeps the order of
    // what is held": a take queued in the participant's turns ahead of the resume's release holds
    // its envelope behind what is held
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_with_a_hand_already_queued_keeps_the_order_of_what_is_held() {
        let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
        let log = logged(&pair);
        let first = pair.connect().await;
        let handles = handles_of(&pair);

        pair.server.pause(&handles[0]);

        for byte in [1, 2] {
            first.send(data_of(byte, 30)).expect("sent");
        }

        until_held(&pair.server_participant, &[(2, false)]).await;

        // * its participant kept in a turn of its own while the next envelope's take is queued,
        // then the resume's release behind it
        let (started, starting) = tokio::sync::oneshot::channel::<()>();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let holding = Arc::clone(&gate);

        pair.server_participant.post(move |_state| {
            started.send(()).ok();
            holding.wait();
        });
        starting.await.expect("its turn started");
        first.send(data_of(3, 30)).expect("sent");
        until(
            || pair.server_adapter.unsettled() > 0,
            "the third handed to its participant",
        )
        .await;
        settle().await;
        pair.server.resume(&handles[0]);
        gate.wait();
        until(|| log_of(&log).len() == 3, "each told").await;

        assert_eq!(
            log_of(&log),
            ["1 01 30", "1 02 30", "1 03 30"],
            "the one queued ahead of the release behind what was held"
        );

        pair.stop().await;
    }

    // spec 15.12.17, 15.21: the twin of "a CLOSE behind held envelopes comes after them, and a
    // RESET drops them"
    #[tokio::test]
    async fn a_close_behind_held_envelopes_comes_after_them_and_a_reset_drops_them() {
        let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
        let log = logged(&pair);
        let first = pair.connect().await;
        let second = pair.connect().await;
        let handles = handles_of(&pair);

        pair.server.pause(&handles[0]);

        for byte in [1, 2] {
            first.send(data_of(byte, 30)).expect("sent");
        }

        until_held(&pair.server_participant, &[(2, false), (0, false)]).await;
        first
            .disconnect(&TransportClientDisconnectOptions::default())
            .expect("disconnected");
        until_held(&pair.server_participant, &[(2, true), (0, false)]).await;

        assert!(log_of(&log).is_empty(), "nothing told, its close among it");

        pair.server.resume(&handles[0]);
        until(|| log_of(&log).len() == 3, "what it held, then its close").await;

        assert_eq!(
            log_of(&log),
            ["1 01 30", "1 02 30", "1 closed true"],
            "its CLOSE once all before it was handed on"
        );

        // * a RESET ends it at once, whatever its order: what it held lost with it
        pair.server.pause(&handles[1]);
        second.send(data_of(5, 30)).expect("sent");
        until_held(&pair.server_participant, &[(1, false)]).await;
        second.dispose();
        until(
            || log_of(&log).contains(&"2 closed false".to_owned()),
            "ended by its RESET",
        )
        .await;
        pair.server.resume(&handles[1]);
        settle().await;

        assert_eq!(
            log_of(&log),
            ["1 01 30", "1 02 30", "1 closed true", "2 closed false"],
            "nothing of what it held told"
        );

        pair.stop().await;
    }

    // spec 15.23.4, 15.23.5: the twin of "one connection held to its bound fails the parts of no
    // other connection": what a connection holds paused is charged to no budget of the parts
    #[tokio::test]
    async fn one_connection_held_to_its_bound_fails_the_parts_of_no_other_connection() {
        let pair = BrokerPair::of(&BrokerPairOptions {
            maximum_message_bytes: Some(1_024),
            held_bytes_budget: Some(4_096),
            ..BrokerPairOptions::default()
        })
        .await;
        let log = logged(&pair);
        let first = pair.connect().await;
        let second = pair.connect().await;
        let handles = handles_of(&pair);

        pair.server.pause(&handles[0]);

        // * 8,000 bytes held, past the budget of the parts, each envelope whole
        for byte in 1..=10 {
            first.send(data_of(byte, 800)).expect("sent");
        }

        until_held(&pair.server_participant, &[(10, false), (0, false)]).await;

        // the other's envelope in parts, which the budget holds
        second.send(data_of(0x20, 3_000)).expect("sent");
        until(|| log_of(&log).len() == 1, "the other's envelope told").await;

        assert_eq!(log_of(&log), ["2 20 3000"], "its parts taken whole");
        assert!(
            locked(&pair.told.errors).is_empty(),
            "nothing lost: {:?}",
            locked(&pair.told.errors)
        );

        pair.server.resume(&handles[0]);
        until(|| log_of(&log).len() == 11, "what it held told").await;

        assert_eq!(
            log_of(&log).split_off(1),
            (1..=10_u8)
                .map(|byte| format!("1 {byte:02X} 800"))
                .collect::<Vec<_>>(),
            "what it held, in order"
        );

        pair.stop().await;
    }
}
