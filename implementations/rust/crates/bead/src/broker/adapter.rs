//! An adapter (spec 15.24): one broker's client, as its participant takes it — the identity its
//! broker authenticates its link by, a link that keeps no broker session, publications said taken or
//! refused, subscriptions said held, each message with the topic it came to and its
//! acknowledgement, its link lost and whether another link of its identity took it over, the
//! largest payload a message to a topic carries, the delivery it gives, whether its leg is secure,
//! and what it offers besides. It depends on no part of Bead's but this contract, so a broker's
//! library stays its adapter's.

use core::fmt;
use core::ops::BitOr;
use core::sync::atomic::{AtomicBool, Ordering};
use core::time::Duration;
use std::error::Error;
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::errors::ProgrammerError;
use crate::router::types::BoxFuture;

/// What an adapter's broker gives its publications (spec 15.19).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BrokerDelivery {
    /// At least once: its broker acknowledges each publication it took, and its adapter holds what
    /// it publishes to the quota its broker gives (MQTT `QoS` 1; AMQP 1.0 an unsettled transfer).
    AtLeastOnce,
    /// At most once: nothing is acknowledged, and nothing paces the link.
    AtMostOnce,
}

/// What a broker said of a publication (spec 15.24).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BrokerPublished {
    /// Taken: at least once, its broker acknowledged it; at most once, it went.
    Taken,
    /// Refused for want of a subscriber, where its adapter offers
    /// [`BrokerCapabilities::NO_SUBSCRIBER`], as MQTT 5's PUBACK `0x10`.
    NoSubscriber,
}

/// What an adapter offers besides what every one offers (spec 15.24), as a set of flags.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct BrokerCapabilities(u8);

impl BrokerCapabilities {
    /// Nothing besides.
    pub const NONE: Self = Self(0);
    /// A subscription in a group, its broker handing each message to one member: a name served
    /// by several participants needs it.
    pub const GROUPS: Self = Self(1);
    /// A will, published by its broker once it loses the link without a clean end.
    pub const WILL: Self = Self(2);
    /// A publication refused when no subscriber takes it, as MQTT 5's PUBACK `0x10`.
    pub const NO_SUBSCRIBER: Self = Self(4);
    /// A message's life in its broker, past which it is deleted unsent (MQTT 5's Message Expiry).
    pub const EXPIRY: Self = Self(8);
    /// Every one of them.
    pub const ALL: Self = Self(15);

    /// Whether it offers every one of `other`.
    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl BitOr for BrokerCapabilities {
    type Output = Self;

    fn bitor(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// A publication: its payload, to a topic, and how long it may wait in its broker.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct BrokerPublication {
    /// The topic it goes to, by its tokens (spec 15.16): `bead`, `i`, `ada`, a participant's
    /// inbox; each adapter writes it as its broker's binding says.
    pub topic: Vec<String>,
    /// The message's payload: one parcel, its bytes the adapter's no more.
    pub payload: Bytes,
    /// How long it may wait in its broker before it is deleted unsent, where the adapter offers
    /// [`BrokerCapabilities::EXPIRY`]; none when none.
    pub expires_after: Option<Duration>,
    /// What gives up on the publication.
    pub signal: Option<CancellationToken>,
}

impl BrokerPublication {
    /// A publication of `payload` to `topic`, living as long as its broker keeps it.
    #[must_use]
    pub fn of<T: Into<String>, I: IntoIterator<Item = T>>(topic: I, payload: Bytes) -> Self {
        Self {
            topic: topic.into_iter().map(Into::into).collect(),
            payload,
            expires_after: None,
            signal: None,
        }
    }
}

/// How a link starts: its will, where the adapter offers one.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct BrokerStart {
    /// What its broker publishes once it loses the link without a clean end; none when none.
    pub will: Option<BrokerPublication>,
    /// What gives up on the start.
    pub signal: Option<CancellationToken>,
}

/// How a topic is subscribed: alone, or in a group.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct BrokerSubscription {
    /// The group it is held in, its broker handing each message to one of its members, where the
    /// adapter offers [`BrokerCapabilities::GROUPS`]; none for one held alone.
    pub group: Option<String>,
    /// What gives up on the subscription.
    pub signal: Option<CancellationToken>,
}

/// How a link went down: lost, or taken over by another link of its identity (spec 15.21).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct BrokerDown {
    /// Whether another link of its identity took it over, MQTT 5's DISCONNECT of `0x8E`: its
    /// participant connects no more until its application starts it again.
    pub is_taken_over: bool,
}

impl BrokerDown {
    /// A link lost, or taken over when `is_taken_over`.
    #[must_use]
    pub const fn of(is_taken_over: bool) -> Self {
        Self { is_taken_over }
    }
}

/// What acknowledges a message to its broker.
pub type Settle = Arc<dyn Fn() + Send + Sync>;

/// How an adapter hands a message on.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct BrokerMessageOptions {
    /// Whether its broker kept it retained.
    pub is_retained: Option<bool>,
    /// What acknowledges it to its broker; nothing when none, as at most once.
    pub settle: Option<Settle>,
}

impl fmt::Debug for BrokerMessageOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerMessageOptions")
            .field("is_retained", &self.is_retained)
            .field("settle", &self.settle.is_some())
            .finish()
    }
}

/// One message an adapter received, and its acknowledgement.
///
/// The topic it came to, its payload, whether its broker kept it retained, and its acknowledgement,
/// which its participant gives as it takes it (spec 15.19). Its clones share its acknowledgement,
/// given once.
#[derive(Clone)]
pub struct BrokerMessage {
    topic: Vec<String>,
    payload: Bytes,
    is_retained: bool,
    settle: Option<Settle>,
    is_settled: Arc<AtomicBool>,
}

impl fmt::Debug for BrokerMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerMessage")
            .field("topic", &self.topic)
            .field("payload", &format_args!("{} bytes", self.payload.len()))
            .field("is_retained", &self.is_retained)
            .finish_non_exhaustive()
    }
}

impl BrokerMessage {
    /// A message of `publication`'s topic and payload, and what acknowledges it to its broker.
    #[must_use]
    pub fn new(publication: BrokerPublication, options: BrokerMessageOptions) -> Self {
        Self {
            topic: publication.topic,
            payload: publication.payload,
            is_retained: options.is_retained.unwrap_or(false),
            settle: options.settle,
            is_settled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The topic it came to, by its tokens.
    #[must_use]
    pub fn topic(&self) -> &[String] {
        &self.topic
    }

    /// Its payload.
    #[must_use]
    pub fn payload(&self) -> &Bytes {
        &self.payload
    }

    /// Whether its broker handed it on as one it kept retained, which no parcel is (spec 15.23).
    #[must_use]
    pub const fn is_retained(&self) -> bool {
        self.is_retained
    }

    /// Acknowledges it to its broker, once: a second call does nothing.
    pub fn settle(&self) {
        if !self.is_settled.swap(true, Ordering::SeqCst)
            && let Some(settle) = &self.settle
        {
            settle();
        }
    }
}

/// What a broker's adapter, or a participant over it, fails with.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum BrokerError {
    /// A misuse, refused as it was made.
    Refused(ProgrammerError),
    /// What its broker or its link failed with, saying why.
    Failed(String),
}

impl BrokerError {
    /// A failure, saying `message`.
    #[must_use]
    pub fn failed<M: Into<String>>(message: M) -> Self {
        Self::Failed(message.into())
    }
}

impl From<ProgrammerError> for BrokerError {
    fn from(error: ProgrammerError) -> Self {
        Self::Refused(error)
    }
}

impl fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(error) => write!(formatter, "{error}"),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl Error for BrokerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Refused(error) => Some(error),
            Self::Failed(_) => None,
        }
    }
}

/// What hears an adapter: each message it received, in the order its broker handed them, and its
/// link down.
pub trait BrokerListener: Send + Sync {
    /// A message its broker handed it.
    fn on_message(&self, _message: &BrokerMessage) {}

    /// Its link down, once an incarnation: lost, its participant closes each connection and starts
    /// it again; or taken over, and its participant connects no more until it is started again.
    fn on_down(&self, _down: BrokerDown) {}
}

/// One broker's client, as its participant takes it (spec 15.24).
pub trait BrokerAdapter: Send + Sync + fmt::Debug {
    /// The type its handles begin with: `BROKER` in memory, `MQTT`, `AMQP`.
    fn transport_type(&self) -> &str;

    /// The identity its broker authenticates its link by, a token (spec 15.16): never one Bead
    /// draws.
    fn id(&self) -> &str;

    /// What it offers besides what every adapter offers.
    fn capabilities(&self) -> BrokerCapabilities;

    /// The delivery its broker gives its publications.
    fn delivery(&self) -> BrokerDelivery;

    /// Whether its leg is secure: its connection under TLS, its broker on the loopback, or in
    /// memory (spec 15.22).
    fn is_secure(&self) -> bool;

    /// The largest payload a message to `topic`, its own inbox, carries whole: the receive bound
    /// its participant announces, asked once, as it is built.
    fn receive_bound(&self, topic: &[String]) -> u64;

    /// The largest payload a message it publishes to `topic` carries whole, its own bytes
    /// deducted.
    fn maximum_payload_bytes(&self, topic: &[String]) -> u64;

    /// Hears its messages and its link down from now on.
    fn listen(&self, listener: Arc<dyn BrokerListener>);

    /// Hears them no more.
    fn unlisten(&self, listener: &Arc<dyn BrokerListener>);

    /// Connects a link that keeps no broker session, its will set where it offers one; settles once
    /// its broker took it.
    fn start(&self, options: BrokerStart) -> BoxFuture<Result<(), BrokerError>>;

    /// Holds a subscription to `topic`, alone or in a group; settles once its broker holds it.
    fn subscribe(
        &self,
        topic: &[String],
        options: BrokerSubscription,
    ) -> BoxFuture<Result<(), BrokerError>>;

    /// Lets the subscription to `topic` go.
    fn unsubscribe(&self, topic: &[String]) -> BoxFuture<Result<(), BrokerError>>;

    /// Publishes a payload; settles once its broker took it, at least once, or as it goes, at most
    /// once, [`BrokerPublished::Taken`]; or [`BrokerPublished::NoSubscriber`] when no subscriber
    /// takes it, where its broker says so.
    fn publish(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>>;

    /// Ends its link cleanly, so its broker publishes no will.
    fn stop(&self) -> BoxFuture<()>;
}
