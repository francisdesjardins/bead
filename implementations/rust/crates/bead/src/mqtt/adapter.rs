//! The MQTT 5 adapter (spec 15.25 to 15.31; decisions 0041, 0050), Bead's own client, as the other
//! sides' `createMqttBrokerAdapter` and `MqttBrokerAdapter` hold it over MQTT.js and `MQTTnet`.
//!
//! Each start a new link, one network connection that keeps no session — Clean Start 1, no Session
//! Expiry Interval — its Client Identifier its id, authenticated by its Password under its id or by
//! its TLS client certificate, a Receive Maximum of 65,535, a Topic Alias Maximum of 0, its Maximum
//! Packet Size and its Keep Alive; its will the participant's GONE, `QoS` 1, RETAIN 0, a Will Delay
//! Interval of 0. Nothing reconnects, subscribes again or holds a publication while it is down.
//! Each subscription is of `QoS` 1, No Local 0, Retain As Published 0 and Retain Handling 2, a group's
//! its shared subscription, held once its SUBACK grants `QoS` 1; one let go once its UNSUBACK came
//! under 0x80, none within its connect timeout failing it, its link and its filter kept. Each
//! publication is of `QoS` 1, or 0 at most once, taken once its PUBLISH is written, RETAIN 0, a life
//! in whole seconds where asked and no other property, counted to its byte and refused past its
//! CONNACK's Maximum Packet Size, held to its CONNACK's Receive Maximum, later ones waiting in their
//! order, no other packet delayed for them; its PUBACK of 0x10 says no subscriber, of 0x80 or more
//! refuses it. Its Keep Alive counts from the last packet written. Each message is handed
//! on before its PUBACK, which goes once it is settled. A packet past its own Maximum Packet Size,
//! read at its Remaining Length, closes its network connection, no DISCONNECT, its link lost. A
//! DISCONNECT of 0x8E tells its link taken over; any other end, lost. Its stop takes no
//! publication, sends what waits on the quota and awaits each PUBACK, fails what has not gone by
//! then, sends an UNSUBSCRIBE for each filter its link asked or holds, one filter a packet, all at
//! once, and awaits their UNSUBACKs, all within one connect timeout of its call, then sends a
//! DISCONNECT of 0x00 within a connect timeout of its own, so that no will goes. Its leg is secure
//! under TLS or to the loopback.
//!
//! Its state is one owner's (decision 0044): each operation posts its job as it is made, and its
//! future only waits; its network connection's reads and its end come back to that owner as jobs
//! of their own, each gated by the incarnation it came on.

use core::fmt;
use core::future::Future;
use core::pin::pin;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use core::time::Duration;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use bytes::{Buf, Bytes, BytesMut};
use futures_util::future::{Either, select};
use rustls::ClientConfig;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerMessageOptions, BrokerPublication, BrokerPublished, BrokerStart,
    BrokerSubscription, Settle,
};
use crate::clock::{Schedule, SharedClock, SystemClock, Timer};
use crate::duration::{HoldWithinOptions, hold_finite, hold_within};
use crate::errors::ProgrammerError;
use crate::mqtt::link::{
    Address, OpenOptions, Opened, Reader, Writer, address_of, open, ready_reset,
};
use crate::mqtt::packets::{
    Connect, LARGEST_PACKET_SIZE, MAXIMUM_PACKET_SIZE, MqttAcknowledgement, MqttConnack,
    MqttPacket, MqttPublish, MqttPublishShapeOptions, MqttReading, Will, code_of, group_filter_of,
    largest_payload, publish_bytes, read_packet, reason_name_of, topic_of, write_connect,
    write_disconnect, write_pingreq, write_puback, write_publish, write_subscribe,
    write_unsubscribe,
};
use crate::mqtt::quota::{Queued, SendQuota};
use crate::net::credential::{CredentialProvider, CredentialProviderError};
use crate::net::racing::RacingOptions;
use crate::owner::{Owned, Owner, WeakOwner};
use crate::platform::{self, Handle};
use crate::router::types::BoxFuture;
use crate::transport::{Listeners, caught, caught_future};

/// How long an MQTT 5 adapter waits, by default: 30 seconds (spec 15.30).
///
/// Its start waits that long for its password, where it asks its provider, and its CONNACK, and its
/// stop for what it was handed and its UNSUBACKs, then for its DISCONNECT. The TypeScript side exports it as its module's `CONNECT_TIMEOUT`; the root's
/// [`crate::CONNECT_TIMEOUT`] is the transport client's.
pub const MQTT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Its Keep Alive, by default: 30 seconds, its will inside two heartbeats (spec 15.30).
pub const KEEP_ALIVE: Duration = Duration::from_secs(30);

/// The type an MQTT 5 adapter's handles begin with.
pub const TRANSPORT_MQTT: &str = "MQTT";

// the longest Keep Alive a CONNECT carries, a Two Byte Integer of seconds (MQTT 5.0 §3.1.2.10)
const LONGEST_KEEP_ALIVE: Duration = Duration::from_secs(65_535);

// a quota a CONNACK that names none gives (MQTT 5.0 §3.2.2.3.3)
const RECEIVE_MAXIMUM: u16 = 65_535;

// the Reason Codes the adapter reads a meaning in (MQTT 5.0 §2.4)
const SUCCESS: u8 = 0x00;
const GRANTED_QOS_1: u8 = 0x01;
const NO_MATCHING_SUBSCRIBERS: u8 = 0x10;
const REFUSED: u8 = 0x80;
const SESSION_TAKEN_OVER: u8 = 0x8E;
const SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: u8 = 0x9E;

// ! no refusal names the password it refuses: a word never carries the secret
const NOT_A_PASSWORD: &str = "a password is a non-empty string holding no NUL";

/// How an MQTT 5 adapter links: its broker, its id, how it authenticates, its bounds and its
/// timeouts.
#[derive(Clone)]
#[non_exhaustive]
pub struct MqttBrokerAdapterOptions {
    /// Its broker: `mqtt://`, `mqtts://`, or a WebSocket, `ws://` or `wss://`, of subprotocol
    /// `mqtt`.
    pub url: String,
    /// Its participant's id: its Client Identifier, and the User Name it authenticates by.
    pub id: String,
    /// Its Password, under its id as User Name, as given: UTF-8 text, never empty and holding no
    /// NUL (spec 15.26). Refused as it is built when it is not, beside a `password_provider`, and
    /// beside a client certificate. With neither, its CONNECT carries its User Name alone.
    pub password: Option<String>,
    /// What hands its Password at each link's start, before its network connection opens, given a
    /// signal cancelled as its start ends, linked or not: so that one that expires renews with each
    /// incarnation. Refused as `password` is, and beside it. Its start fails as it outlives the
    /// connect timeout, or as a stop meets it, a later answer serving nothing; what it fails with
    /// fails its start, its cause; an answer that is no password fails it, refused.
    pub password_provider: Option<CredentialProvider>,
    /// The TLS its `mqtts` or `wss` connection speaks, a client certificate its broker ties to its
    /// id among it where it holds one: rustls's over aws-lc-rs, the platform's verifier judging its
    /// broker, when none. Refused over `mqtt` and `ws`.
    pub tls: Option<Arc<ClientConfig>>,
    /// Its CONNECT's Maximum Packet Size, the largest packet its broker sends it, from 1 to
    /// 268,435,460 (spec 15.30): [`MAXIMUM_PACKET_SIZE`] when none.
    pub maximum_packet_size: Option<u32>,
    /// Its CONNECT's Keep Alive, sent in whole seconds rounded up, from 1 to 65,535 seconds (spec
    /// 15.30): [`KEEP_ALIVE`] when none.
    pub keep_alive: Option<Duration>,
    /// How long it waits: its start, for its password and its CONNACK; a subscription let go, for
    /// its UNSUBACK; its stop, for what it was handed and its UNSUBACKs, then for its DISCONNECT
    /// (spec 15.26, 15.27, 15.30): [`MQTT_CONNECT_TIMEOUT`] when none.
    pub connect_timeout: Option<Duration>,
    /// At least once by default, each publication of `QoS` 1; at most once, of `QoS` 0 (spec 15.28).
    pub delivery: Option<BrokerDelivery>,
    /// `false` where its broker is known to offer no shared subscription (spec 15.25): `true` when
    /// none.
    pub groups: Option<bool>,
    /// The clock its timers run on: the platform's when none.
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
}

impl MqttBrokerAdapterOptions {
    /// An adapter of `id` to the broker at `url`, every other option its default.
    #[must_use]
    pub fn new<U: Into<String>, I: Into<String>>(url: U, id: I) -> Self {
        Self {
            url: url.into(),
            id: id.into(),
            password: None,
            password_provider: None,
            tls: None,
            maximum_packet_size: None,
            keep_alive: None,
            connect_timeout: None,
            delivery: None,
            groups: None,
            clock: None,
            runtime: None,
        }
    }
}

impl fmt::Debug for MqttBrokerAdapterOptions {
    // ! whether it carries a password, never the password
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MqttBrokerAdapterOptions")
            .field("url", &self.url)
            .field("id", &self.id)
            .field("has_password", &self.password.is_some())
            .field("has_password_provider", &self.password_provider.is_some())
            .field("has_tls", &self.tls.is_some())
            .field("maximum_packet_size", &self.maximum_packet_size)
            .field("keep_alive", &self.keep_alive)
            .field("connect_timeout", &self.connect_timeout)
            .field("delivery", &self.delivery)
            .field("groups", &self.groups)
            .finish_non_exhaustive()
    }
}

// ── What it was built with ───────────────────────────────────────────────────────────────────

// how it authenticates: its password, its provider, or neither, its certificate where it has one
enum Secret {
    None,
    Given(String),
    Provided(CredentialProvider),
}

// what its owner and its callers share, read off the owner
struct Shared {
    id: String,
    address: Address,
    secret: Secret,
    has_certificate: bool,
    tls: Option<Arc<ClientConfig>>,
    maximum_packet_size: u32,
    keep_alive: Duration,
    connect_timeout: Duration,
    delivery: BrokerDelivery,
    groups: bool,
    capabilities: BrokerCapabilities,
    clock: SharedClock,
    racing: RacingOptions,
    listeners: Listeners<dyn BrokerListener>,
    // up: its CONNACK read, and neither stopped nor lost since
    is_linked: AtomicBool,
    unsettled: AtomicU64,
    // the live link's CONNACK's Maximum Packet Size, the last one's while it is down
    broker_maximum_packet_size: AtomicU32,
}

impl Shared {
    fn not_up(&self) -> BrokerError {
        BrokerError::failed(format!("the link of {} is not up", self.id))
    }

    fn stopped(&self) -> BrokerError {
        BrokerError::failed(format!("the link of {} stopped", self.id))
    }

    fn cancelled(&self, what: &str) -> BrokerError {
        BrokerError::failed(format!("{what} of the link of {} was cancelled", self.id))
    }

    fn timeout_millis(&self) -> u128 {
        self.connect_timeout.as_millis()
    }
}

// whether `password` is one: never empty and holding no NUL (spec 15.26)
fn is_password(password: &str) -> bool {
    !password.is_empty() && !password.contains('\0')
}

// a life in whole seconds, rounded up, 1 at least (spec 15.28)
fn seconds_of(life: Duration) -> u32 {
    let seconds = life
        .as_secs()
        .saturating_add(u64::from(life.subsec_nanos() > 0))
        .max(1);

    u32::try_from(seconds).unwrap_or(u32::MAX)
}

// what a Reason Code is called, after its value: `0x86, Bad User Name or Password`
fn reason_of(code: u8) -> String {
    format!("{}, {}", code_of(code), reason_name_of(code))
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

/// An adapter over MQTT 5 (spec 15.25 to 15.31): a broker adapter as any, its acknowledgements
/// counted, its client Bead's own over the core's sockets (decision 0050).
#[derive(Clone)]
pub struct MqttBrokerAdapter {
    shared: Arc<Shared>,
    owner: Owner<State>,
}

impl fmt::Debug for MqttBrokerAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MqttBrokerAdapter")
            .field("id", &self.shared.id)
            .field("url", &self.shared.address.host)
            .finish_non_exhaustive()
    }
}

// what a misuse is refused with
fn refused<M: Into<String>>(message: M) -> ProgrammerError {
    ProgrammerError::new(message)
}

impl MqttBrokerAdapter {
    /// An adapter, not yet linked, its options held.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for an id that is no Client Identifier, a URL none of its four schemes names, TLS
    /// over `mqtt` or `ws`, a password that is none, a password beside its provider or either beside
    /// a client certificate, a Maximum Packet Size outside 1 to 268,435,460, or a Keep Alive or a
    /// connect timeout spec 1.4 does not hold.
    pub fn new(options: &MqttBrokerAdapterOptions) -> Result<Self, ProgrammerError> {
        // * in whole seconds rounded up, as its CONNECT announces it and its link runs it (spec
        // 15.26)
        let keep_alive = Duration::from_secs(u64::from(seconds_of(hold_within(
            "keepAlive",
            options.keep_alive.unwrap_or(KEEP_ALIVE),
            &HoldWithinOptions::new(LONGEST_KEEP_ALIVE),
        )?)));
        let connect_timeout = hold_finite(
            "connectTimeout",
            options.connect_timeout.unwrap_or(MQTT_CONNECT_TIMEOUT),
        )?;
        let id = &options.id;

        if id.is_empty() || id.contains('\0') || id.len() > usize::from(u16::MAX) {
            return Err(refused(format!(
                "an MQTT 5 adapter's id is its Client Identifier, not {id:?}"
            )));
        }

        let maximum_packet_size = options.maximum_packet_size.unwrap_or(MAXIMUM_PACKET_SIZE);

        if !(1..=LARGEST_PACKET_SIZE).contains(&maximum_packet_size) {
            return Err(refused(format!(
                "maximumPacketSize is a whole number from 1 to {LARGEST_PACKET_SIZE}, not {maximum_packet_size}"
            )));
        }

        let url = &options.url;
        let address = address_of(url).ok_or_else(|| {
            refused(format!(
                "an MQTT 5 adapter's url is mqtt, mqtts, ws or wss, not {url}"
            ))
        })?;
        let has_certificate = options
            .tls
            .as_ref()
            .is_some_and(|tls| tls.client_auth_cert_resolver.has_certs());

        if options.tls.is_some() && !address.scheme.is_tls() {
            return Err(refused(if has_certificate {
                format!("a TLS client certificate is carried over mqtts or wss, not {url}")
            } else {
                format!("TLS is spoken over mqtts or wss, not {url}")
            }));
        }

        let secret = secret_of((options, has_certificate))?;
        let runtime = platform::socket_runtime_of(options.runtime.as_ref(), "an MQTT 5 adapter")?;
        let platform_clock: SharedClock = Arc::new(SystemClock::on(runtime.clone()));
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform_clock));
        let delivery = options.delivery.unwrap_or(BrokerDelivery::AtLeastOnce);
        let groups = options.groups.unwrap_or(true);
        let mut capabilities = BrokerCapabilities::WILL | BrokerCapabilities::EXPIRY;

        if groups {
            capabilities = capabilities | BrokerCapabilities::GROUPS;
        }

        // * QoS 0 has no PUBACK, so no word of a subscriber
        if delivery != BrokerDelivery::AtMostOnce {
            capabilities = capabilities | BrokerCapabilities::NO_SUBSCRIBER;
        }

        let shared = Arc::new(Shared {
            id: id.clone(),
            address,
            secret,
            has_certificate,
            tls: options.tls.clone(),
            maximum_packet_size,
            keep_alive,
            connect_timeout,
            delivery,
            groups,
            capabilities,
            racing: RacingOptions::on(platform_clock),
            clock: Arc::clone(&clock),
            listeners: Listeners::default(),
            is_linked: AtomicBool::new(false),
            unsettled: AtomicU64::new(0),
            broker_maximum_packet_size: AtomicU32::new(LARGEST_PACKET_SIZE),
        });
        let held = Arc::clone(&shared);
        let owner = Owner::spawn((&runtime, &clock), move |owner| State {
            shared: held,
            owner,
            starts: 0,
            asking: None,
            link: None,
            serial: 0,
            keys: 0,
            identifiers: 1,
        });

        Ok(Self { shared, owner })
    }

    /// Whether its link is up: its CONNACK read, and neither stopped nor lost since.
    #[must_use]
    pub fn is_linked(&self) -> bool {
        self.shared.is_linked.load(Ordering::SeqCst)
    }

    /// The messages it handed its participant at least once that are not acknowledged yet.
    #[must_use]
    pub fn unsettled(&self) -> u64 {
        self.shared.unsettled.load(Ordering::SeqCst)
    }

    // `job` run on its owner, its answer awaited; an owner gone, `gone`
    fn asked<T: Send + 'static, J: FnOnce(&mut State, oneshot::Sender<T>) + Send + 'static>(
        &self,
        (job, gone): (J, T),
    ) -> impl Future<Output = T> + Send + 'static {
        let (reply, answer) = oneshot::channel();

        self.owner
            .offer(Box::new(move |state: &mut State| job(state, reply)));

        async move { answer.await.unwrap_or(gone) }
    }
}

// what its link authenticates by, held as it is built: a password, its provider, or neither
fn secret_of(
    (options, has_certificate): (&MqttBrokerAdapterOptions, bool),
) -> Result<Secret, ProgrammerError> {
    if options.password.is_some() && options.password_provider.is_some() {
        return Err(refused(
            "a link takes a password or a password provider, not both",
        ));
    }

    if (options.password.is_some() || options.password_provider.is_some()) && has_certificate {
        return Err(refused(
            "a link authenticates by its client certificate or by a password, not both",
        ));
    }

    match (&options.password, &options.password_provider) {
        (Some(password), _) if !is_password(password) => Err(refused(NOT_A_PASSWORD)),
        (Some(password), _) => Ok(Secret::Given(password.clone())),
        (None, Some(provider)) => Ok(Secret::Provided(Arc::clone(provider))),
        (None, None) => Ok(Secret::None),
    }
}

fn gone() -> BrokerError {
    BrokerError::failed("the MQTT 5 adapter is gone")
}

impl BrokerAdapter for MqttBrokerAdapter {
    fn transport_type(&self) -> &str {
        TRANSPORT_MQTT
    }

    fn id(&self) -> &str {
        &self.shared.id
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.shared.capabilities
    }

    fn delivery(&self) -> BrokerDelivery {
        self.shared.delivery
    }

    fn is_secure(&self) -> bool {
        self.shared.address.is_secure()
    }

    // the largest payload of a message to its inbox within its own Maximum Packet Size, a life
    // counted (spec 15.30)
    fn receive_bound(&self, topic: &[String]) -> u64 {
        largest_payload(
            &topic_of(topic),
            u64::from(self.shared.maximum_packet_size),
            &MqttPublishShapeOptions::default(),
        )
        .unwrap_or_default()
    }

    // * the live link's bound, the last link's while it is down, a start under way among it
    fn maximum_payload_bytes(&self, topic: &[String]) -> u64 {
        let shape = MqttPublishShapeOptions {
            is_at_most_once: Some(self.shared.delivery == BrokerDelivery::AtMostOnce),
            ..MqttPublishShapeOptions::default()
        };

        largest_payload(
            &topic_of(topic),
            u64::from(
                self.shared
                    .broker_maximum_packet_size
                    .load(Ordering::SeqCst),
            ),
            &shape,
        )
        .unwrap_or_default()
    }

    fn listen(&self, listener: Arc<dyn BrokerListener>) {
        self.shared.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        self.shared.listeners.remove(listener);
    }

    fn start(&self, options: BrokerStart) -> BoxFuture<Result<(), BrokerError>> {
        Box::pin(self.asked((
            move |state: &mut State, reply| state.start((options, reply)),
            Err(gone()),
        )))
    }

    fn subscribe(
        &self,
        topic: &[String],
        options: BrokerSubscription,
    ) -> BoxFuture<Result<(), BrokerError>> {
        let topic = topic.to_vec();

        Box::pin(self.asked((
            move |state: &mut State, reply| state.subscribe((topic, options), reply),
            Err(gone()),
        )))
    }

    fn unsubscribe(&self, topic: &[String]) -> BoxFuture<Result<(), BrokerError>> {
        let topic = topic.to_vec();

        Box::pin(self.asked((
            move |state: &mut State, reply| state.unsubscribe(&topic, reply),
            Err(gone()),
        )))
    }

    fn publish(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        Box::pin(self.asked((
            move |state: &mut State, reply| state.publish(publication, reply),
            Err(gone()),
        )))
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(self.asked((move |state: &mut State, reply| state.stop(reply), ())))
    }
}

// ── Its network connection's tasks ───────────────────────────────────────────────────────────

// what its writer is handed
enum Outgoing {
    // a packet, the key of the publication at most once it takes where it is one's
    Packet {
        packet: Vec<u8>,
        publication: Option<u64>,
    },
    // its side ended once what was written went, then told
    Close,
}

// the first of `work` and `ended`; none once `ended` is cancelled
async fn unless_ended<F: Future>(work: F, ended: &CancellationToken) -> Option<F::Output> {
    let work = pin!(work);
    let ended = pin!(ended.cancelled());

    match select(work, ended).await {
        Either::Left((output, _)) => Some(output),
        Either::Right(((), _)) => None,
    }
}

// a task of one incarnation's connection: the owner it posts to, the incarnation it is of, and what
// lets it go
struct Tasked {
    owner: WeakOwner<State>,
    serial: u64,
    ended: CancellationToken,
}

// what comes on the connection, handed to its owner as it comes, until it ends or is let go
async fn reading(mut reader: Reader, tasked: Tasked) {
    let Tasked {
        owner,
        serial,
        ended,
    } = tasked;

    loop {
        match unless_ended(reader.next(), &ended).await {
            None => return,
            Some(Ok(Some(bytes))) => owner.offer(Box::new(move |state: &mut State| {
                state.read((serial, bytes));
            })),
            Some(Ok(None)) => {
                owner.offer(Box::new(move |state: &mut State| {
                    state.lost((serial, "its broker ended its network connection".to_owned()));
                }));

                return;
            }
            Some(Err(error)) => {
                let reason = error.to_string();

                owner.offer(Box::new(move |state: &mut State| {
                    state.lost((serial, reason));
                }));

                return;
            }
        }
    }
}

// what the owner writes, in its order, until it closes or the connection is let go
async fn writing(
    (mut writer, mut outgoing): (Writer, mpsc::UnboundedReceiver<Outgoing>),
    tasked: Tasked,
) {
    let Tasked {
        owner,
        serial,
        ended: aborted,
    } = tasked;

    loop {
        let next = match unless_ended(outgoing.recv(), &aborted).await {
            None | Some(None) => return,
            Some(Some(next)) => next,
        };

        match next {
            Outgoing::Packet {
                packet,
                publication,
            } => match unless_ended(writer.send(packet), &aborted).await {
                None => return,
                // * told its owner as it is written: what dates its keep alive, and what takes a
                // publication at most once
                Some(Ok(())) => owner.offer(Box::new(move |state: &mut State| {
                    state.written((serial, publication));
                })),
                Some(Err(error)) => {
                    let reason = error.to_string();

                    owner.offer(Box::new(move |state: &mut State| {
                        state.lost((serial, reason));
                    }));

                    return;
                }
            },
            Outgoing::Close => {
                unless_ended(writer.close(), &aborted).await;
                owner.offer(Box::new(move |state: &mut State| state.closed(serial)));

                return;
            }
        }
    }
}

// ── Its owner's state ────────────────────────────────────────────────────────────────────────

// what waits for a signal of its operation's: cancelled once it settles, which ends the watch
struct Watch(CancellationToken);

impl Drop for Watch {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

// a publication of QoS 1, waiting on the quota or sent
struct Publication {
    key: u64,
    publish: MqttPublish,
    reply: oneshot::Sender<Result<BrokerPublished, BrokerError>>,
    // dropped as it settles
    _watch: Option<Watch>,
}

// a publication at most once, its PUBLISH of QoS 0 handed to its writer and not yet written
struct Unwritten {
    key: u64,
    reply: oneshot::Sender<Result<BrokerPublished, BrokerError>>,
    // dropped as it settles
    _watch: Option<Watch>,
}

// a SUBSCRIBE sent, awaiting its SUBACK
struct Subscribing {
    key: String,
    record: u64,
    filter: String,
    reply: oneshot::Sender<Result<(), BrokerError>>,
    // dropped as it settles
    _watch: Option<Watch>,
}

// an UNSUBSCRIBE sent, awaiting its UNSUBACK: its caller's, or its stop's, which no one awaits
struct Unsubscribing {
    key: String,
    record: Option<u64>,
    filter: String,
    reply: Option<oneshot::Sender<Result<(), BrokerError>>>,
    timer: Option<Arc<dyn Timer>>,
}

// the filter a topic's SUBSCRIBE named, from its SUBSCRIBE until its UNSUBACK: each SUBSCRIBE's
// own record, so that the UNSUBACK of a former one never forgets a later one
struct FilterRecord {
    key: String,
    filter: String,
    record: u64,
}

// where its stop is
#[derive(Clone, Copy, PartialEq, Eq)]
enum StopStep {
    // what it was handed sent and answered first
    Draining,
    // each filter let go, its UNSUBACKs awaited
    LettingGo,
    // its DISCONNECT written, its side closing
    Disconnecting,
}

enum Phase {
    // its CONNECT sent, its CONNACK awaited
    Connecting {
        reply: StartReply,
        timer: Option<Arc<dyn Timer>>,
        watch: Option<Watch>,
    },
    Linked,
    Stopping {
        replies: Vec<oneshot::Sender<()>>,
        step: StopStep,
        timer: Option<Arc<dyn Timer>>,
        letting_go: HashSet<u16>,
    },
}

// one network connection, from its CONNECT to its end
struct Link {
    serial: u64,
    phase: Phase,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    // its reader let go, and its writer's, at its end
    ended: CancellationToken,
    aborted: CancellationToken,
    resetter: Option<socket2::Socket>,
    buffer: BytesMut,
    // its CONNACK's Maximum Packet Size, the bound of what it publishes
    maximum_packet_size: u32,
    // its broker said no shared subscription, by its CONNACK or a SUBACK of 0x9E
    is_shared_refused: bool,
    // ended by its broker for another link of its id, DISCONNECT 0x8E
    is_taken_over: bool,
    quota: SendQuota<Publication>,
    in_flight: HashMap<u16, Publication>,
    // in the order they were handed to its writer
    unwritten: VecDeque<Unwritten>,
    subscribing: HashMap<u16, Subscribing>,
    unsubscribing: HashMap<u16, Unsubscribing>,
    filters: Vec<FilterRecord>,
    next_identifier: u16,
    keep_alive: Duration,
    // when its writer last wrote a packet
    last_sent: Duration,
    is_pinged: bool,
    keep_alive_timer: Option<Arc<dyn Timer>>,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.ended.cancel();
    }
}

impl Link {
    fn send(&self, packet: Vec<u8>) {
        self.outgoing
            .send(Outgoing::Packet {
                packet,
                publication: None,
            })
            .ok();
    }

    // a PUBLISH of QoS 0 handed to its writer, its publication taken once it is written
    fn send_at_most_once(&mut self, (packet, unwritten): (Vec<u8>, Unwritten)) {
        let publication = Some(unwritten.key);

        self.unwritten.push_back(unwritten);
        self.outgoing
            .send(Outgoing::Packet {
                packet,
                publication,
            })
            .ok();
    }

    // a Packet Identifier no packet awaiting its answer holds (MQTT 5.0 §2.2.1)
    fn identifier(&mut self) -> Option<u16> {
        for _ in 0..=u16::MAX {
            let candidate = self.next_identifier.max(1);

            self.next_identifier = candidate.checked_add(1).unwrap_or(1);

            if !self.in_flight.contains_key(&candidate)
                && !self.subscribing.contains_key(&candidate)
                && !self.unsubscribing.contains_key(&candidate)
            {
                return Some(candidate);
            }
        }

        None
    }

    fn filter_of(&self, key: &str) -> Option<&FilterRecord> {
        self.filters.iter().find(|held| held.key == key)
    }

    // `filter` recorded for `key`: in place of a former one's record, in its place
    fn record(&mut self, filter: FilterRecord) {
        match self.filters.iter_mut().find(|held| held.key == filter.key) {
            Some(held) => *held = filter,
            None => self.filters.push(filter),
        }
    }

    // the record of `key` forgotten, where it is `record` still
    fn forget(&mut self, (key, record): (&str, u64)) {
        self.filters
            .retain(|held| held.key != key || held.record != record);
    }

    const fn is_stopping(&self) -> bool {
        matches!(self.phase, Phase::Stopping { .. })
    }

    const fn is_up(&self) -> bool {
        matches!(self.phase, Phase::Linked)
    }
}

// how an incarnation ends
struct End {
    // what its awaited operations fail with
    reason: BrokerError,
    // its socket reset at once, no clean end
    reset: bool,
}

struct State {
    shared: Arc<Shared>,
    owner: WeakOwner<Self>,
    // each start and each stop its own, so that a stop as a start asks its password ends that start
    starts: u64,
    // the start under way, its number and its ask, which its stop cancels
    asking: Option<(u64, CancellationToken)>,
    link: Option<Link>,
    serial: u64,
    keys: u64,
    // ! the next Packet Identifier, carried from one incarnation to the next, so that an answer a
    // former link's broker sent late names none of the next one's
    identifiers: u16,
}

impl Owned for State {}

// what settles a start: its answer, then its provider's signal cancelled in a later turn, outside
// the turn that settles it, linked or not
struct StartReply {
    reply: oneshot::Sender<Result<(), BrokerError>>,
    ask: CancellationToken,
    owner: WeakOwner<State>,
}

impl StartReply {
    fn settle(self, outcome: Result<(), BrokerError>) {
        let Self { reply, ask, owner } = self;

        reply.send(outcome).ok();
        owner.offer(Box::new(move |_state: &mut State| ask.cancel()));
    }
}

// what a start hands its linking
struct Linking {
    asked: u64,
    will: Option<BrokerPublication>,
    signal: Option<CancellationToken>,
    ask: CancellationToken,
    deadline: Duration,
    reply: StartReply,
}

// what a start's CONNECT goes with, once its connection opened
struct Started {
    will: Option<BrokerPublication>,
    signal: Option<CancellationToken>,
    deadline: Duration,
    reply: StartReply,
}

// why a linking's wait ended before its work
enum Interrupted {
    Cancelled,
    Stopped,
    Expired,
}

// what ends a start's wait before its work: its signal, its stop, and its deadline
struct Interruptions<'tokens> {
    signal: &'tokens CancellationToken,
    ask: &'tokens CancellationToken,
    expired: &'tokens CancellationToken,
}

// `work`, unless the start's signal, its stop or its deadline comes first
async fn raced<F: Future>(
    work: F,
    interruptions: &Interruptions<'_>,
) -> Result<F::Output, Interrupted> {
    let Interruptions {
        signal,
        ask,
        expired,
    } = interruptions;
    let work = pin!(work);
    let interrupted = pin!(async {
        let cancelled = pin!(signal.cancelled());
        let stopped = pin!(ask.cancelled());
        let expired = pin!(expired.cancelled());

        match select(cancelled, select(stopped, expired)).await {
            Either::Left(_) => Interrupted::Cancelled,
            Either::Right((Either::Left(_), _)) => Interrupted::Stopped,
            Either::Right((Either::Right(_), _)) => Interrupted::Expired,
        }
    });

    match select(work, interrupted).await {
        Either::Left((output, _)) => Ok(output),
        Either::Right((interrupted, _)) => Err(interrupted),
    }
}

// what a linking ends with: its password, and its network connection open
type LinkingOutcome = Result<(Option<String>, Opened), BrokerError>;

// its password asked of its provider, given the start's ask for its signal
async fn provided(
    (provider, ask): (&CredentialProvider, &CancellationToken),
) -> Result<String, BrokerError> {
    let outcome = match caught(("a password provider", || provider(ask.clone()))) {
        Ok(providing) => caught_future(("a password provider", providing))
            .await
            .unwrap_or_else(|panicked| Err(CredentialProviderError::from(panicked))),
        Err(panicked) => Err(CredentialProviderError::from(panicked)),
    };

    match outcome {
        Ok(password) if is_password(&password) => Ok(password),
        Ok(_) => Err(BrokerError::Refused(refused(NOT_A_PASSWORD))),
        Err(failed) => Err(BrokerError::caused(
            "the password provider failed",
            Arc::from(failed),
        )),
    }
}

// a start's password, then its network connection, each raced against its signal, its stop and
// its deadline; posted back to the owner, which sends its CONNECT
async fn linking((shared, owner): (Arc<Shared>, WeakOwner<State>), linking: Linking) {
    let signal = linking.signal.clone().unwrap_or_default();
    let ask = linking.ask.clone();
    let expired = CancellationToken::new();
    let left = linking.deadline.saturating_sub(shared.clock.monotonic());
    let firing = expired.clone();
    let timer = shared
        .clock
        .arm(
            Schedule::Once(left.max(Duration::from_millis(1))),
            Box::new(move || firing.cancel()),
        )
        .ok();
    let id = shared.id.clone();
    let timeout = shared.timeout_millis();
    let interrupted = |interrupted: Interrupted, waited: &str| match interrupted {
        Interrupted::Cancelled => shared.cancelled("the start"),
        Interrupted::Stopped => {
            BrokerError::failed(format!("the link of {id} stopped as it started"))
        }
        Interrupted::Expired => BrokerError::failed(format!(
            "the link of {id} had no {waited} within {timeout} ms, its connectTimeout"
        )),
    };
    let outcome: LinkingOutcome = async {
        let password = match &shared.secret {
            Secret::None => None,
            Secret::Given(password) => Some(password.clone()),
            Secret::Provided(provider) => Some(
                raced(
                    provided((provider, &ask)),
                    &Interruptions {
                        signal: &signal,
                        ask: &ask,
                        expired: &expired,
                    },
                )
                .await
                .map_err(|stop| interrupted(stop, "password"))??,
            ),
        };
        let options = OpenOptions {
            racing: &shared.racing,
            tls: shared.tls.as_ref(),
            maximum_packet_size: shared.maximum_packet_size,
        };
        let opened = raced(
            open(&shared.address, &options),
            &Interruptions {
                signal: &signal,
                ask: &ask,
                expired: &expired,
            },
        )
        .await
        .map_err(|stop| interrupted(stop, "CONNACK"))?
        .map_err(|error| {
            BrokerError::caused(
                format!("the link of {id} ended before its CONNACK: {error}"),
                Arc::new(error),
            )
        })?;

        Ok((password, opened))
    }
    .await;

    if let Some(timer) = timer {
        timer.cancel();
    }

    owner.offer(Box::new(move |state: &mut State| {
        state.linked((linking, outcome));
    }));
}

// what watches `signal`, posting `job` once it is cancelled, until its operation settles
fn watch<J: FnOnce(&mut State) + Send + 'static>(
    (owner, signal): (&WeakOwner<State>, CancellationToken),
    job: J,
) -> Watch {
    let done = CancellationToken::new();
    let settled = done.clone();
    let posting = owner.clone();

    owner.cover(async move {
        let cancelled = pin!(signal.cancelled());
        let settled = pin!(settled.cancelled());

        if let Either::Left(_) = select(cancelled, settled).await {
            posting.offer(Box::new(job));
        }
    });

    Watch(done)
}

impl State {
    fn now(&self) -> Duration {
        self.shared.clock.monotonic()
    }

    fn key(&mut self) -> u64 {
        self.keys = self.keys.saturating_add(1);

        self.keys
    }

    // the link of `serial`, where it is the current one
    fn link_of(&mut self, serial: u64) -> Option<&mut Link> {
        self.link.as_mut().filter(|link| link.serial == serial)
    }

    // a job posted after the delay `due` on its clock, for the link of `serial`
    fn after<J: FnOnce(&mut Self) + Send + 'static>(
        &self,
        due: Duration,
        job: J,
    ) -> Option<Arc<dyn Timer>> {
        self.owner
            .after((&self.shared.clock, due.max(Duration::from_millis(1))), job)
            .ok()
    }

    // ── Its start ────────────────────────────────────────────────────────────────────────────

    fn start(&mut self, (options, reply): (BrokerStart, oneshot::Sender<Result<(), BrokerError>>)) {
        let id = &self.shared.id;

        if self.link.is_some() || self.asking.is_some() {
            reply
                .send(Err(BrokerError::Refused(refused(format!(
                    "the link of {id} is up already"
                )))))
                .ok();

            return;
        }

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            reply.send(Err(self.shared.cancelled("the start"))).ok();

            return;
        }

        let ask = CancellationToken::new();
        let asked = self.starts;

        self.asking = Some((asked, ask.clone()));

        let deadline = self.now().saturating_add(self.shared.connect_timeout);
        let linked = Linking {
            asked,
            will: options.will,
            signal: options.signal,
            ask: ask.clone(),
            deadline,
            reply: StartReply {
                reply,
                ask,
                owner: self.owner.clone(),
            },
        };

        self.owner.cover(linking(
            (Arc::clone(&self.shared), self.owner.clone()),
            linked,
        ));
    }

    // a start's linking ended: its CONNECT sent over the connection it opened, unless it was
    // stopped meanwhile
    fn linked(&mut self, (linking, outcome): (Linking, LinkingOutcome)) {
        let Linking {
            asked,
            will,
            signal,
            ask,
            deadline,
            reply,
        } = linking;

        // * its ask ended, the start under way now its link's; its provider's signal cancelled as
        // its start settles
        if self.asking.as_ref().is_some_and(|(held, _)| *held == asked) {
            self.asking = None;
        }

        drop(ask);

        if self.starts != asked {
            reply.settle(Err(BrokerError::failed(format!(
                "the link of {} stopped as it started",
                self.shared.id
            ))));

            return;
        }

        match outcome {
            Err(error) => reply.settle(Err(error)),
            Ok((password, opened)) => self.connect(
                (password, opened),
                Started {
                    will,
                    signal,
                    deadline,
                    reply,
                },
            ),
        }
    }

    // its CONNECT sent over `opened`, its CONNACK awaited until `deadline`
    fn connect(&mut self, (password, opened): (Option<String>, Opened), started: Started) {
        let Started {
            will,
            signal,
            deadline,
            reply,
        } = started;
        let shared = Arc::clone(&self.shared);
        let keep_alive_seconds = u16::try_from(seconds_of(shared.keep_alive)).unwrap_or(u16::MAX);
        let connect = Connect {
            client_identifier: shared.id.clone(),
            user_name: (!shared.has_certificate).then(|| shared.id.clone()),
            password,
            keep_alive: keep_alive_seconds,
            maximum_packet_size: shared.maximum_packet_size,
            will: will.map(|will| Will {
                topic: topic_of(&will.topic),
                payload: will.payload,
            }),
        };
        let written = match write_connect(&connect) {
            Ok(written) => written,
            Err(refusal) => {
                reply.settle(Err(BrokerError::Refused(refused(format!(
                    "the link of {} writes no CONNECT: {refusal}",
                    shared.id
                )))));

                return;
            }
        };

        self.serial = self.serial.saturating_add(1);

        let serial = self.serial;
        let (outgoing, queue) = mpsc::unbounded_channel();
        let ended = CancellationToken::new();
        let aborted = CancellationToken::new();
        let Opened {
            reader,
            writer,
            resetter,
        } = opened;

        self.owner.cover(reading(
            reader,
            Tasked {
                owner: self.owner.clone(),
                serial,
                ended: ended.clone(),
            },
        ));
        self.owner.cover(writing(
            (writer, queue),
            Tasked {
                owner: self.owner.clone(),
                serial,
                ended: aborted.clone(),
            },
        ));

        let timer = self.after(deadline.saturating_sub(self.now()), move |state| {
            state.connack_timed_out(serial);
        });
        let watch = signal.map(|signal| {
            watch((&self.owner, signal), move |state: &mut Self| {
                state.start_given_up(serial);
            })
        });
        let link = Link {
            serial,
            phase: Phase::Connecting {
                reply,
                timer,
                watch,
            },
            outgoing,
            ended,
            aborted,
            resetter,
            buffer: BytesMut::new(),
            maximum_packet_size: LARGEST_PACKET_SIZE,
            is_shared_refused: false,
            is_taken_over: false,
            quota: SendQuota::new(RECEIVE_MAXIMUM),
            in_flight: HashMap::new(),
            unwritten: VecDeque::new(),
            subscribing: HashMap::new(),
            unsubscribing: HashMap::new(),
            filters: Vec::new(),
            next_identifier: self.identifiers,
            keep_alive: shared.keep_alive,
            last_sent: Duration::ZERO,
            is_pinged: false,
            keep_alive_timer: None,
        };

        link.send(written);
        self.link = Some(link);
    }

    fn connack_timed_out(&mut self, serial: u64) {
        let reason = BrokerError::failed(format!(
            "the link of {} had no CONNACK within {} ms, its connectTimeout",
            self.shared.id,
            self.shared.timeout_millis()
        ));

        if self
            .link_of(serial)
            .is_some_and(|link| matches!(link.phase, Phase::Connecting { .. }))
        {
            self.retire((
                serial,
                End {
                    reason,
                    reset: false,
                },
            ));
        }
    }

    fn start_given_up(&mut self, serial: u64) {
        if self
            .link_of(serial)
            .is_some_and(|link| matches!(link.phase, Phase::Connecting { .. }))
        {
            let reason = self.shared.cancelled("the start");

            self.retire((
                serial,
                End {
                    reason,
                    reset: false,
                },
            ));
        }
    }

    fn connacked(&mut self, (serial, connack): (u64, MqttConnack)) {
        let shared = Arc::clone(&self.shared);

        if self.link_of(serial).is_none() {
            return;
        }

        let refusal = if connack.reason_code != SUCCESS {
            // * MQTT 5 names no CONNACK Reason Code under 0x80 but its Success (MQTT 5.0 §3.2.2.2)
            let reason = if connack.reason_code >= REFUSED {
                reason_of(connack.reason_code)
            } else {
                code_of(connack.reason_code)
            };

            Some(BrokerError::failed(format!(
                "its broker refused the link of {}: CONNACK {reason}",
                shared.id
            )))
        } else if connack.maximum_qos == Some(0) {
            // * its subscriptions and its will are of QoS 1, which a broker of Maximum QoS 0 refuses
            Some(BrokerError::failed(format!(
                "the broker of {} says Maximum QoS 0, and its link is of QoS 1",
                shared.id
            )))
        } else {
            None
        };

        if let Some(reason) = refusal {
            self.retire((
                serial,
                End {
                    reason,
                    reset: false,
                },
            ));

            return;
        }

        let Some(link) = self.link_of(serial) else {
            return;
        };
        let phase = core::mem::replace(&mut link.phase, Phase::Linked);
        let maximum_packet_size = connack.maximum_packet_size.unwrap_or(LARGEST_PACKET_SIZE);

        link.maximum_packet_size = maximum_packet_size;
        link.quota = SendQuota::new(connack.receive_maximum.unwrap_or(RECEIVE_MAXIMUM));
        link.is_shared_refused = connack.shared_subscription_available == Some(false);

        if let Some(seconds) = connack.server_keep_alive {
            link.keep_alive = Duration::from_secs(u64::from(seconds));
        }

        shared
            .broker_maximum_packet_size
            .store(maximum_packet_size, Ordering::SeqCst);
        shared.is_linked.store(true, Ordering::SeqCst);

        let keep_alive = link.keep_alive;

        if let Phase::Connecting {
            reply,
            timer,
            watch,
        } = phase
        {
            if let Some(timer) = timer {
                timer.cancel();
            }

            drop(watch);
            reply.settle(Ok(()));
        }

        if !keep_alive.is_zero() {
            self.arm_keep_alive((serial, keep_alive));
        }
    }

    // ── Its keep alive ───────────────────────────────────────────────────────────────────────

    fn arm_keep_alive(&mut self, (serial, due): (u64, Duration)) {
        let timer = self.after(due, move |state| state.keep_alive(serial));

        if let Some(link) = self.link_of(serial) {
            link.keep_alive_timer = timer;
        }
    }

    // * a PINGREQ once nothing went for its Keep Alive; a PINGREQ left unanswered by the next one,
    // its link lost (MQTT 5.0 §3.1.2.10)
    fn keep_alive(&mut self, serial: u64) {
        let now = self.now();
        let Some(link) = self.link_of(serial) else {
            return;
        };

        if link.is_pinged {
            let reason = BrokerError::failed(format!(
                "the link of {} had no PINGRESP within its Keep Alive",
                self.shared.id
            ));

            self.retire((
                serial,
                End {
                    reason,
                    reset: true,
                },
            ));

            return;
        }

        let since = now.saturating_sub(link.last_sent);
        let due = if since >= link.keep_alive {
            link.is_pinged = true;
            link.send(write_pingreq());

            link.keep_alive
        } else {
            link.keep_alive.saturating_sub(since)
        };

        self.arm_keep_alive((serial, due));
    }

    // its writer wrote a packet: the last sent, and the publication at most once it took
    fn written(&mut self, (serial, publication): (u64, Option<u64>)) {
        let now = self.now();
        let Some(link) = self.link_of(serial) else {
            return;
        };

        link.last_sent = now;

        let Some(key) = publication else {
            return;
        };
        let written = link.unwritten.iter().position(|held| held.key == key);

        if let Some(publication) = written.and_then(|index| link.unwritten.remove(index)) {
            publication.reply.send(Ok(BrokerPublished::Taken)).ok();
        }
    }

    // ── What it reads ────────────────────────────────────────────────────────────────────────

    fn read(&mut self, (serial, bytes): (u64, Bytes)) {
        let maximum = self.shared.maximum_packet_size;
        let Some(link) = self.link_of(serial) else {
            return;
        };

        link.buffer.extend_from_slice(&bytes);

        loop {
            let Some(link) = self.link_of(serial) else {
                return;
            };

            match read_packet(&link.buffer, maximum) {
                Ok(MqttReading::Partial) => return,
                Ok(MqttReading::Packet { packet, length }) => {
                    if length <= link.buffer.len() {
                        link.buffer.advance(length);
                    } else {
                        link.buffer.clear();
                    }

                    self.on_packet((serial, packet));
                }
                // ! past its own bound, or malformed: its network connection closed, no
                // DISCONNECT, its link lost (spec 15.29)
                Err(refusal) => {
                    let reason = BrokerError::failed(format!(
                        "the link of {} went down: its broker sent {refusal}",
                        self.shared.id
                    ));

                    self.retire((
                        serial,
                        End {
                            reason,
                            reset: true,
                        },
                    ));

                    return;
                }
            }
        }
    }

    fn on_packet(&mut self, (serial, packet): (u64, MqttPacket)) {
        let id = self.shared.id.clone();
        let Some(link) = self.link_of(serial) else {
            return;
        };
        let is_connecting = matches!(link.phase, Phase::Connecting { .. });
        let is_up = link.is_up();

        match packet {
            MqttPacket::Connack(connack) if is_connecting => self.connacked((serial, connack)),
            MqttPacket::Disconnect(disconnect) if is_connecting => {
                let reason = BrokerError::failed(format!(
                    "the link of {id} ended before its CONNACK: DISCONNECT {}",
                    reason_of(disconnect.reason_code)
                ));

                self.retire((
                    serial,
                    End {
                        reason,
                        reset: false,
                    },
                ));
            }
            MqttPacket::Connack(_)
            | MqttPacket::Publish(_)
            | MqttPacket::Puback(_)
            | MqttPacket::Suback(_)
            | MqttPacket::Unsuback(_)
            | MqttPacket::Pingresp
                if is_connecting =>
            {
                let reason = BrokerError::failed(format!(
                    "the link of {id} ended before its CONNACK: its broker sent another packet first"
                ));

                self.retire((
                    serial,
                    End {
                        reason,
                        reset: true,
                    },
                ));
            }
            MqttPacket::Connack(_) => {
                let reason = BrokerError::failed(format!(
                    "the link of {id} went down: its broker sent a second CONNACK"
                ));

                self.retire((
                    serial,
                    End {
                        reason,
                        reset: true,
                    },
                ));
            }
            MqttPacket::Publish(publish) => self.hand_on((serial, publish)),
            MqttPacket::Puback(acknowledgement) => self.pubacked((serial, &acknowledgement)),
            MqttPacket::Suback(acknowledgement) => self.subacked((serial, &acknowledgement)),
            MqttPacket::Unsuback(acknowledgement) => self.unsubacked((serial, &acknowledgement)),
            MqttPacket::Pingresp => {
                if let Some(link) = self.link_of(serial) {
                    link.is_pinged = false;
                }
            }
            MqttPacket::Disconnect(disconnect) => {
                let is_taken_over = disconnect.reason_code == SESSION_TAKEN_OVER && is_up;

                if let Some(link) = self.link_of(serial) {
                    link.is_taken_over = is_taken_over;
                }

                let reason = BrokerError::failed(if is_taken_over {
                    format!("the link of {id} was taken over")
                } else {
                    format!(
                        "the link of {id} was lost: DISCONNECT {}",
                        reason_of(disconnect.reason_code)
                    )
                });

                self.retire((
                    serial,
                    End {
                        reason,
                        reset: false,
                    },
                ));
            }
        }
    }

    // * handed on before its PUBACK, which goes once it is settled, and once; one of QoS 0 with
    // nothing to acknowledge (spec 15.29)
    fn hand_on(&self, (serial, publish): (u64, MqttPublish)) {
        let settle = publish.packet_identifier.map(|identifier| {
            self.shared.unsettled.fetch_add(1, Ordering::SeqCst);

            let owner = self.owner.clone();
            let settle: Settle = Arc::new(move || {
                owner.offer(Box::new(move |state: &mut Self| {
                    state.settled((serial, identifier));
                }));
            });

            settle
        });
        let topic: Vec<String> = publish.topic.split('/').map(str::to_owned).collect();
        let options = BrokerMessageOptions {
            is_retained: Some(publish.retain),
            settle,
        };

        let message = BrokerMessage::new(BrokerPublication::new(topic, publish.payload), &options);

        self.shared.listeners.each((
            |listener: &(dyn BrokerListener + 'static)| listener.on_message(&message),
            |_panicked| {},
        ));
    }

    // * a message of a lost link is never acknowledged on the next one
    fn settled(&mut self, (serial, identifier): (u64, u16)) {
        let shared = Arc::clone(&self.shared);
        let Some(link) = self.link_of(serial) else {
            return;
        };

        shared
            .unsettled
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                Some(held.saturating_sub(1))
            })
            .ok();
        link.send(write_puback(identifier));
    }

    // ── Its publications ─────────────────────────────────────────────────────────────────────

    fn publish(
        &mut self,
        publication: BrokerPublication,
        reply: oneshot::Sender<Result<BrokerPublished, BrokerError>>,
    ) {
        let shared = Arc::clone(&self.shared);
        let key = self.key();
        let owner = self.owner.clone();
        let Some(link) = self.link.as_mut().filter(|link| link.is_up()) else {
            reply.send(Err(shared.not_up())).ok();

            return;
        };
        let name = topic_of(&publication.topic);
        let is_at_most_once = shared.delivery == BrokerDelivery::AtMostOnce;
        let shape = MqttPublishShapeOptions {
            is_at_most_once: Some(is_at_most_once),
            has_life: Some(publication.expires_after.is_some()),
        };

        let bytes = publish_bytes(
            u64::try_from(name.len()).unwrap_or(u64::MAX),
            u64::try_from(publication.payload.len()).unwrap_or(u64::MAX),
            &shape,
        );

        // ! counted before it goes: its broker ends the whole link on one past its bound
        if bytes > u64::from(link.maximum_packet_size) {
            reply
                .send(Err(BrokerError::failed(format!(
                    "a PUBLISH of {bytes} bytes to {name}, past its broker's Maximum Packet Size, {} bytes",
                    link.maximum_packet_size
                ))))
                .ok();

            return;
        }

        if publication
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            reply.send(Err(shared.cancelled("a publication"))).ok();

            return;
        }

        let publish = MqttPublish {
            topic: name,
            message_expiry_interval: publication.expires_after.map(seconds_of),
            payload: publication.payload,
            ..MqttPublish::default()
        };

        let serial = link.serial;

        // * taken once its writer wrote it, so that what its connection has not taken stays
        // counted as unsent (spec 15.23); given up before, its link retired, since it may go yet
        if is_at_most_once {
            match write_publish(&publish) {
                Ok(written) => {
                    let watch = publication.signal.map(|signal| {
                        watch((&owner, signal), move |state: &mut Self| {
                            state.publication_given_up((serial, key));
                        })
                    });

                    link.send_at_most_once((
                        written,
                        Unwritten {
                            key,
                            reply,
                            _watch: watch,
                        },
                    ));
                }
                Err(refusal) => {
                    reply
                        .send(Err(BrokerError::failed(refusal.to_string())))
                        .ok();
                }
            }

            return;
        }

        let watch = publication.signal.clone().map(|signal| {
            watch((&owner, signal), move |state: &mut Self| {
                state.publication_given_up((serial, key));
            })
        });
        let queued = link.quota.enqueue(
            (
                key,
                Publication {
                    key,
                    publish,
                    reply,
                    _watch: watch,
                },
            ),
            publication.signal.as_ref(),
        );

        match queued {
            Queued::Send(publication) => self.send_publication((serial, publication)),
            Queued::Waiting => {}
            Queued::GivenUp(publication) => {
                publication
                    .reply
                    .send(Err(shared.cancelled("a publication")))
                    .ok();
            }
            Queued::Ended(publication) => {
                publication.reply.send(Err(shared.not_up())).ok();
            }
        }
    }

    // a publication its quota took sent: its PUBLISH of QoS 1 written, its PUBACK awaited
    fn send_publication(&mut self, (serial, mut publication): (u64, Publication)) {
        let Some(link) = self.link_of(serial) else {
            return;
        };
        let Some(identifier) = link.identifier() else {
            publication
                .reply
                .send(Err(BrokerError::failed(
                    "every Packet Identifier of its link awaits an answer",
                )))
                .ok();
            link.quota.release();

            return;
        };

        publication.publish.packet_identifier = Some(identifier);

        match write_publish(&publication.publish) {
            Ok(written) => {
                link.send(written);
                link.in_flight.insert(identifier, publication);
            }
            Err(refusal) => {
                publication
                    .reply
                    .send(Err(BrokerError::failed(refusal.to_string())))
                    .ok();

                let freed = link.quota.release();

                for next in freed {
                    self.send_publication((serial, next));
                }
            }
        }
    }

    fn pubacked(&mut self, (serial, acknowledgement): (u64, &MqttAcknowledgement)) {
        let id = self.shared.id.clone();
        let Some(link) = self.link_of(serial) else {
            return;
        };
        // * a PUBACK of no publication of its own, a former link's among them, says nothing
        let Some(publication) = link.in_flight.remove(&acknowledgement.packet_identifier) else {
            return;
        };
        let code = acknowledgement.reason_code();
        let outcome = if code >= REFUSED {
            Err(BrokerError::failed(format!(
                "the broker of {id} refused a publication to {}: {}",
                publication.publish.topic,
                code_of(code)
            )))
        } else if code == NO_MATCHING_SUBSCRIBERS {
            Ok(BrokerPublished::NoSubscriber)
        } else {
            Ok(BrokerPublished::Taken)
        };

        publication.reply.send(outcome).ok();

        let freed = link.quota.release();

        for next in freed {
            self.send_publication((serial, next));
        }

        self.drained(serial);
    }

    // * a publication that waits on the quota leaves it unsent as its signal is cancelled, its link
    // kept; one that went retires its link, since it may have gone
    fn publication_given_up(&mut self, (serial, key): (u64, u64)) {
        let shared = Arc::clone(&self.shared);
        let Some(link) = self.link_of(serial) else {
            return;
        };

        if let Some(publication) = link.quota.leave(key) {
            publication
                .reply
                .send(Err(shared.cancelled("a publication")))
                .ok();
            self.drained(serial);

            return;
        }

        let sent = link
            .in_flight
            .iter()
            .find(|(_, held)| held.key == key)
            .map(|(identifier, _)| *identifier);

        if let Some(publication) = sent.and_then(|identifier| link.in_flight.remove(&identifier)) {
            publication
                .reply
                .send(Err(shared.cancelled("a publication")))
                .ok();
            self.given_up(serial);

            return;
        }

        let unwritten = link.unwritten.iter().position(|held| held.key == key);

        if let Some(publication) = unwritten.and_then(|index| link.unwritten.remove(index)) {
            publication
                .reply
                .send(Err(shared.cancelled("a publication")))
                .ok();
            self.given_up(serial);
        }
    }

    // its link retired once what it was asked was given up once it may have gone
    fn given_up(&mut self, serial: u64) {
        let reason = BrokerError::failed(format!(
            "the link of {} was retired: what it was asked was given up once it may have gone",
            self.shared.id
        ));

        self.retire((
            serial,
            End {
                reason,
                reset: false,
            },
        ));
    }

    // ── Its subscriptions ────────────────────────────────────────────────────────────────────

    fn subscribe(
        &mut self,
        (topic, options): (Vec<String>, BrokerSubscription),
        reply: oneshot::Sender<Result<(), BrokerError>>,
    ) {
        let shared = Arc::clone(&self.shared);
        let id = &shared.id;
        let record = self.key();
        let owner = self.owner.clone();

        if options.group.is_some() && !shared.groups {
            reply
                .send(Err(BrokerError::Refused(refused(format!(
                    "the adapter of {id} offers no groups"
                )))))
                .ok();

            return;
        }

        let Some(link) = self.link.as_mut().filter(|link| link.is_up()) else {
            reply.send(Err(shared.not_up())).ok();

            return;
        };

        if options.group.is_some() && link.is_shared_refused {
            reply
                .send(Err(BrokerError::failed(format!(
                    "the broker of {id} offers no shared subscription, so no group"
                ))))
                .ok();

            return;
        }

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            reply.send(Err(shared.cancelled("a subscription"))).ok();

            return;
        }

        let key = topic_of(&topic);
        let filter = options
            .group
            .as_ref()
            .map_or_else(|| key.clone(), |group| group_filter_of(group, &topic));
        let Some(identifier) = link.identifier() else {
            reply
                .send(Err(BrokerError::failed(
                    "every Packet Identifier of its link awaits an answer",
                )))
                .ok();

            return;
        };
        let written = match write_subscribe((identifier, &filter)) {
            Ok(written) => written,
            Err(refusal) => {
                reply
                    .send(Err(BrokerError::failed(refusal.to_string())))
                    .ok();

                return;
            }
        };
        let serial = link.serial;
        let watch = options.signal.map(|signal| {
            watch((&owner, signal), move |state: &mut Self| {
                state.subscription_given_up((serial, record));
            })
        });

        // * recorded as its SUBSCRIBE goes, so that a stop before its SUBACK lets it go: its
        // broker, reading the link's packets in their order, installs it before that UNSUBSCRIBE
        link.record(FilterRecord {
            key: key.clone(),
            filter: filter.clone(),
            record,
        });
        link.send(written);
        link.subscribing.insert(
            identifier,
            Subscribing {
                key,
                record,
                filter,
                reply,
                _watch: watch,
            },
        );
    }

    fn subacked(&mut self, (serial, acknowledgement): (u64, &MqttAcknowledgement)) {
        let id = self.shared.id.clone();
        let Some(link) = self.link_of(serial) else {
            return;
        };
        let Some(subscribing) = link.subscribing.remove(&acknowledgement.packet_identifier) else {
            return;
        };
        let code = acknowledgement.reason_code();

        if code == GRANTED_QOS_1 {
            subscribing.reply.send(Ok(())).ok();

            return;
        }

        // ! kept where its broker may hold it, QoS 0 granted among it, which its stop lets go; a
        // code of 0x80 or more installed nothing
        if code >= REFUSED {
            link.forget((&subscribing.key, subscribing.record));
        }

        if code == SHARED_SUBSCRIPTIONS_NOT_SUPPORTED {
            link.is_shared_refused = true;
        }

        subscribing
            .reply
            .send(Err(BrokerError::failed(format!(
                "the broker of {id} refused the subscription to {}: {}",
                subscribing.filter,
                code_of(code)
            ))))
            .ok();
    }

    // * a subscription given up once its SUBSCRIBE went retires its link
    fn subscription_given_up(&mut self, (serial, record): (u64, u64)) {
        let shared = Arc::clone(&self.shared);
        let Some(link) = self.link_of(serial) else {
            return;
        };
        let sent = link
            .subscribing
            .iter()
            .find(|(_, held)| held.record == record)
            .map(|(identifier, _)| *identifier);

        if let Some(subscribing) = sent.and_then(|identifier| link.subscribing.remove(&identifier))
        {
            subscribing
                .reply
                .send(Err(shared.cancelled("a subscription")))
                .ok();
            self.given_up(serial);
        }
    }

    fn unsubscribe(&mut self, topic: &[String], reply: oneshot::Sender<Result<(), BrokerError>>) {
        let shared = Arc::clone(&self.shared);
        let Some(link) = self.link.as_mut().filter(|link| link.is_up()) else {
            reply.send(Err(shared.not_up())).ok();

            return;
        };
        let key = topic_of(topic);
        let record = link.filter_of(&key).map(|held| held.record);
        let filter = link
            .filter_of(&key)
            .map_or_else(|| key.clone(), |held| held.filter.clone());
        let Some(identifier) = link.identifier() else {
            reply
                .send(Err(BrokerError::failed(
                    "every Packet Identifier of its link awaits an answer",
                )))
                .ok();

            return;
        };
        let written = match write_unsubscribe((identifier, &filter)) {
            Ok(written) => written,
            Err(refusal) => {
                reply
                    .send(Err(BrokerError::failed(refusal.to_string())))
                    .ok();

                return;
            }
        };
        let serial = link.serial;

        link.send(written);
        link.unsubscribing.insert(
            identifier,
            Unsubscribing {
                key,
                record,
                filter,
                reply: Some(reply),
                timer: None,
            },
        );

        // * its UNSUBACK awaited within its connect timeout, past which it fails, its link kept so
        // that no will goes, and its filter kept, which its stop lets go (spec 15.27)
        let timer = self.after(shared.connect_timeout, move |state| {
            state.unsuback_timed_out((serial, identifier));
        });

        if let Some(unsubscribing) = self
            .link_of(serial)
            .and_then(|link| link.unsubscribing.get_mut(&identifier))
        {
            unsubscribing.timer = timer;
        }
    }

    fn unsuback_timed_out(&mut self, (serial, identifier): (u64, u16)) {
        let shared = Arc::clone(&self.shared);
        let Some(unsubscribing) = self
            .link_of(serial)
            .and_then(|link| link.unsubscribing.get_mut(&identifier))
        else {
            return;
        };

        // ! its request never given up: a late UNSUBACK is read, which drops its record
        if let Some(reply) = unsubscribing.reply.take() {
            reply
                .send(Err(BrokerError::failed(format!(
                    "the subscription of {} to {} had no UNSUBACK within {} ms, its connectTimeout",
                    shared.id,
                    unsubscribing.filter,
                    shared.timeout_millis()
                ))))
                .ok();
        }
    }

    fn unsubacked(&mut self, (serial, acknowledgement): (u64, &MqttAcknowledgement)) {
        let id = self.shared.id.clone();
        let Some(link) = self.link_of(serial) else {
            return;
        };
        let identifier = acknowledgement.packet_identifier;
        let Some(unsubscribing) = link.unsubscribing.remove(&identifier) else {
            return;
        };

        if let Some(timer) = &unsubscribing.timer {
            timer.cancel();
        }

        // * the UNSUBACK's own code: 0x00, or 0x11 where its broker held none, lets it go
        let code = acknowledgement.reason_code();
        let outcome = if code >= REFUSED {
            Err(BrokerError::failed(format!(
                "the broker of {id} refused to let the subscription to {} go: {}",
                unsubscribing.filter,
                code_of(code)
            )))
        } else {
            // ! the record it let go alone: a SUBSCRIBE asked again meanwhile keeps its own
            if let Some(record) = unsubscribing.record {
                link.forget((&unsubscribing.key, record));
            }

            Ok(())
        };

        if let Some(reply) = unsubscribing.reply {
            reply.send(outcome).ok();
        }

        let is_let_go = if let Phase::Stopping {
            step: StopStep::LettingGo,
            letting_go,
            ..
        } = &mut link.phase
        {
            letting_go.remove(&identifier);
            letting_go.is_empty()
        } else {
            false
        };

        if is_let_go {
            self.disconnect(serial);
        }
    }

    // ── Its stop ─────────────────────────────────────────────────────────────────────────────

    // * its stop, once: no down told, a stop is no loss, and no publication taken from it; what it
    // was handed sent first, what is left failed, each filter let go, then its DISCONNECT of 0x00
    fn stop(&mut self, done: oneshot::Sender<()>) {
        let shared = Arc::clone(&self.shared);

        self.starts = self.starts.saturating_add(1);

        // * a start that asks its password, or opens its connection, ends at once, whether or
        // not its provider hears its signal, and the next start links and asks anew
        if let Some((_, ask)) = self.asking.take() {
            ask.cancel();
        }

        let Some(link) = self.link.as_mut() else {
            done.send(()).ok();

            return;
        };
        let serial = link.serial;

        match &mut link.phase {
            Phase::Stopping { replies, .. } => replies.push(done),
            Phase::Connecting { .. } => {
                let reason = BrokerError::failed(format!(
                    "the link of {} ended before its CONNACK: it stopped",
                    shared.id
                ));

                self.retire((
                    serial,
                    End {
                        reason,
                        reset: false,
                    },
                ));
                done.send(()).ok();
            }
            Phase::Linked => {
                shared.is_linked.store(false, Ordering::SeqCst);

                // * one connect timeout from its call: what it was handed, then its UNSUBACKs
                link.phase = Phase::Stopping {
                    replies: vec![done],
                    step: StopStep::Draining,
                    timer: None,
                    letting_go: HashSet::new(),
                };

                let timer = self.after(shared.connect_timeout, move |state| {
                    state.stop_timed_out(serial);
                });

                if let Some(Phase::Stopping { timer: held, .. }) =
                    self.link_of(serial).map(|link| &mut link.phase)
                {
                    *held = timer;
                }

                self.drained(serial);
            }
        }
    }

    // * what it was handed to publish before its stop, sent and answered first: once nothing waits
    // on the quota and every PUBACK came, each filter is let go (spec 15.24)
    fn drained(&mut self, serial: u64) {
        let Some(link) = self.link_of(serial) else {
            return;
        };

        if matches!(
            link.phase,
            Phase::Stopping {
                step: StopStep::Draining,
                ..
            }
        ) && link.quota.is_drained()
        {
            self.let_go(serial);
        }
    }

    // its connect timeout passed: what it was handed and has not gone failed, each filter let go
    // all the same, then its DISCONNECT
    fn stop_timed_out(&mut self, serial: u64) {
        let Some(step) = self.link_of(serial).and_then(|link| match link.phase {
            Phase::Stopping { step, .. } => Some(step),
            Phase::Connecting { .. } | Phase::Linked => None,
        }) else {
            return;
        };

        if step == StopStep::Draining {
            self.let_go(serial);
        }

        if let Some(Phase::Stopping {
            step: StopStep::LettingGo,
            ..
        }) = self.link_of(serial).map(|link| &link.phase)
        {
            self.disconnect(serial);
        }
    }

    // * each filter its link asked or holds let go, one UNSUBSCRIBE each, all sent at once, after
    // what was failed that has not gone: settles once every UNSUBACK came, whatever its code, its
    // link ended, or its connect timeout passed (spec 15.26, 15.27)
    fn let_go(&mut self, serial: u64) {
        let stopped = self.shared.stopped();
        let Some(link) = self.link_of(serial) else {
            return;
        };

        for publication in link.quota.end() {
            publication.reply.send(Err(stopped.clone())).ok();
        }

        for (_, publication) in link.in_flight.drain() {
            publication.reply.send(Err(stopped.clone())).ok();
        }

        for (_, subscribing) in link.subscribing.drain() {
            subscribing.reply.send(Err(stopped.clone())).ok();
        }

        for unsubscribing in link.unsubscribing.values_mut() {
            if let Some(reply) = unsubscribing.reply.take() {
                reply.send(Err(stopped.clone())).ok();
            }
        }

        // ! one filter a packet: one UNSUBSCRIBE of them all may pass its CONNACK's Maximum Packet
        // Size, which its broker ends the link for, its will published
        let mut filters: Vec<String> = Vec::new();

        for held in &link.filters {
            if !filters.contains(&held.filter) {
                filters.push(held.filter.clone());
            }
        }

        let mut letting_go = HashSet::new();

        for filter in filters {
            let Some(identifier) = link.identifier() else {
                break;
            };

            if let Ok(written) = write_unsubscribe((identifier, &filter)) {
                link.send(written);
                link.unsubscribing.insert(
                    identifier,
                    Unsubscribing {
                        key: filter.clone(),
                        record: None,
                        filter,
                        reply: None,
                        timer: None,
                    },
                );
                letting_go.insert(identifier);
            }
        }

        let is_none = letting_go.is_empty();

        if let Phase::Stopping {
            step,
            letting_go: held,
            ..
        } = &mut link.phase
        {
            *step = StopStep::LettingGo;
            *held = letting_go;
        }

        if is_none {
            self.disconnect(serial);
        }
    }

    // * its DISCONNECT of 0x00, so that no will goes, within a connect timeout of its own: then
    // its network connection ended at once, its broker never answering
    fn disconnect(&mut self, serial: u64) {
        let timeout = self.shared.connect_timeout;
        let Some(link) = self.link_of(serial) else {
            return;
        };

        if let Phase::Stopping { step, timer, .. } = &mut link.phase {
            if *step == StopStep::Disconnecting {
                return;
            }

            *step = StopStep::Disconnecting;

            if let Some(timer) = timer.take() {
                timer.cancel();
            }
        }

        link.send(write_disconnect());
        link.outgoing.send(Outgoing::Close).ok();

        let timer = self.after(timeout, move |state| state.disconnect_timed_out(serial));

        if let Some(Phase::Stopping { timer: held, .. }) =
            self.link_of(serial).map(|link| &mut link.phase)
        {
            *held = timer;
        }
    }

    fn disconnect_timed_out(&mut self, serial: u64) {
        let stopped = self.shared.stopped();

        if self.link_of(serial).is_some_and(|link| link.is_stopping()) {
            self.retire((
                serial,
                End {
                    reason: stopped,
                    reset: true,
                },
            ));
        }
    }

    // its writer closed its side
    fn closed(&mut self, serial: u64) {
        let stopped = self.shared.stopped();

        self.retire((
            serial,
            End {
                reason: stopped,
                reset: false,
            },
        ));
    }

    // * its link lost: once, as its network connection ends; a stop's end once its DISCONNECT went
    fn lost(&mut self, (serial, why): (u64, String)) {
        let id = &self.shared.id;
        let is_connecting = self
            .link
            .as_ref()
            .is_some_and(|link| matches!(link.phase, Phase::Connecting { .. }));
        let reason = BrokerError::failed(if is_connecting {
            format!("the link of {id} ended before its CONNACK: {why}")
        } else {
            format!("the link of {id} went down: {why}")
        });
        // * its broker closing once it read its DISCONNECT is a clean end
        let is_disconnecting = self.link_of(serial).is_some_and(|link| {
            matches!(
                link.phase,
                Phase::Stopping {
                    step: StopStep::Disconnecting,
                    ..
                }
            )
        });

        self.retire((
            serial,
            End {
                reason,
                reset: !is_disconnecting,
            },
        ));
    }

    // * an incarnation ended: what it awaits failed, what it holds let go, its connection closed;
    // its down told once, where it was up, its stops told they settled
    fn retire(&mut self, (serial, end): (u64, End)) {
        if self.link.as_ref().is_none_or(|link| link.serial != serial) {
            return;
        }

        let Some(mut link) = self.link.take() else {
            return;
        };
        let shared = Arc::clone(&self.shared);
        let was_linked = link.is_up();
        let End { reason, reset } = end;

        self.identifiers = link.next_identifier;

        shared.is_linked.store(false, Ordering::SeqCst);
        shared.unsettled.store(0, Ordering::SeqCst);

        if let Some(timer) = link.keep_alive_timer.take() {
            timer.cancel();
        }

        match core::mem::replace(&mut link.phase, Phase::Linked) {
            Phase::Connecting {
                reply,
                timer,
                watch,
            } => {
                if let Some(timer) = timer {
                    timer.cancel();
                }

                drop(watch);
                reply.settle(Err(reason.clone()));
            }
            Phase::Stopping { replies, timer, .. } => {
                if let Some(timer) = timer {
                    timer.cancel();
                }

                for reply in replies {
                    reply.send(()).ok();
                }
            }
            Phase::Linked => {}
        }

        for publication in link.quota.end() {
            publication.reply.send(Err(reason.clone())).ok();
        }

        for (_, publication) in link.in_flight.drain() {
            publication.reply.send(Err(reason.clone())).ok();
        }

        for publication in link.unwritten.drain(..) {
            publication.reply.send(Err(reason.clone())).ok();
        }

        for (_, subscribing) in link.subscribing.drain() {
            subscribing.reply.send(Err(reason.clone())).ok();
        }

        for (_, unsubscribing) in link.unsubscribing.drain() {
            if let Some(timer) = unsubscribing.timer {
                timer.cancel();
            }

            if let Some(reply) = unsubscribing.reply {
                reply.send(Err(reason.clone())).ok();
            }
        }

        if reset {
            ready_reset(link.resetter.as_ref());
            link.aborted.cancel();
        } else {
            // * its side closed once what was written went, unless it closes already
            link.outgoing.send(Outgoing::Close).ok();
        }

        link.ended.cancel();

        let is_taken_over = link.is_taken_over;

        drop(link);

        if was_linked {
            let down = BrokerDown::new(is_taken_over);

            shared.listeners.each((
                |listener: &(dyn BrokerListener + 'static)| listener.on_down(down),
                |_panicked| {},
            ));
        }
    }
}
