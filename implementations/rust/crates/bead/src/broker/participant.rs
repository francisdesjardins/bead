//! A participant (spec 15.16 to 15.24): one link of a side to a broker, over its adapter. Its
//! inbox, the topic every parcel of its connections reaches, is subscribed as its link starts,
//! before anything of it goes; its incarnation, 16 bytes drawn from a cryptographic source each
//! time its link connects, keeps no broker session; its connections, of its client and server
//! transports, are held by the pair of halves their ends drew; its will is a GONE its broker
//! publishes where its adapter offers one; and each connection has its heartbeat. When its link
//! goes down it closes each connection, unclean, and connects again as another incarnation, its
//! inbox and names subscribed anew before anything goes, then resets each peer it held a
//! connection with; when another link of its id takes its link over, it closes each connection
//! alike, reports it, and connects no more until it is started again. Its stop ends its link in
//! place, each connection closed with 1001 and no will gone, and what is under way with it; its
//! next link, at its application's word, is another incarnation, its transports kept. Its dispose
//! is final.
//!
//! The participant is an owner of its own (decision 0044): its connections, its connects awaiting
//! their answer and the departures it subscribes are one task's, each touched in its turn; what its
//! transports and its gauges read from any thread is kept beside it.
//!
//! A connection its router paused is held, never its link (spec 15.12, 15.23; decision 0046): each
//! envelope that comes whole for it waits in its held queue, in order, behind what is held, its
//! CLOSE behind them, acknowledged to its broker once held; a resume's release turn hands them on.
//! Past `maximumHeldEnvelopeBytes`, that connection alone is lost.

use core::fmt;
use core::future::Future;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::time::Duration;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerPublication, BrokerPublished, BrokerStart, BrokerSubscription,
};
use crate::broker::client::{BrokerTransportClient, BrokerTransportClientOptions};
use crate::broker::heartbeat::{Heartbeat, HeartbeatHooks};
use crate::broker::parcel::{
    LARGEST_BOUND, LARGEST_SEQUENCE, LAYOUT, LEAST_BOUND, Parcel, ParcelRead, codes, flags,
    hex_of_byte, is_advisory, is_kind_to_come, is_token, kind_named, kinds, read_parcel,
    write_parcel,
};
use crate::broker::sequence::{Budget, PartTaking, Parts, PartsBounds, Sequence, Taking, cut};
use crate::broker::server::{BrokerTransportServer, BrokerTransportServerOptions, ServerInner};
use crate::clock::{SharedClock, SystemClock};
use crate::debug::DebugDirection;
use crate::debug::participant::{ParcelVerdict, ParticipantDebugEvent, ParticipantDebugListener};
use crate::duration::{NEVER, hold, hold_finite};
use crate::errors::{ConnectError, ProgrammerError, TransportError};
use crate::owner::{Owner, WeakOwner};
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    ListenerId, Listeners, TransportClientReconnectOptions, attempting, hold_reconnection, joined,
};

/// How long a connection is silent before it is pinged, and a ping unanswered before it is closed,
/// by default (spec 15.23): 30 seconds.
pub const HEARTBEAT: Duration = Duration::from_secs(30);

/// What a participant holds in parts by default, across its connections (spec 15.23).
pub(crate) const HELD_BYTES_BUDGET: u64 = 268_435_456;

/// One envelope's parts together, at most, by default: the default envelope's limit (spec 15.23).
pub const MAXIMUM_ENVELOPE_PARTS_BYTES: u64 = 16_778_240;

/// How long parts come, by default, before their rate is held: 5 seconds (spec 15.12).
pub const BODY_GRACE_PERIOD: Duration = Duration::from_secs(5);

/// The slowest parts may come by default once their grace passed: 240 bytes a second (spec 15.12).
pub const MINIMUM_BODY_BYTES_PER_SECOND: u64 = 240;

/// Its topics' first token by default.
pub const ROOT: &str = "bead";

/// A connection's pair: the opener's half and the acceptor's.
pub(crate) type Pair = (u64, u64);

/// What hears what a participant reports of its own.
pub type ParticipantErrorListener = Arc<dyn Fn(&RouterError) + Send + Sync>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a participant reports: an error of its own, its message as the other sides word it.
pub(crate) fn reported(message: String) -> RouterError {
    RouterError::Other(Arc::new(std::io::Error::other(message)))
}

// its reconnection's end, reported in the other sides' words, what ended it its source: a
// duration's refusal among it, by its code
#[derive(Debug)]
struct ReconnectionEnded {
    message: String,
    cause: TransportError,
}

impl fmt::Display for ReconnectionEnded {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ReconnectionEnded {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

/// How a broker's participant is built (spec 15.21, 15.23).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct BrokerParticipantOptions {
    /// The first token of every topic, one for every participant of a deployment: [`ROOT`] when
    /// none; a token.
    pub root: Option<String>,
    /// What its stack runs on, the rate of parts and a server's accept timeout among them; the
    /// platform's clock when none. Its heartbeat runs on the platform's timer whatever it is.
    pub clock: Option<SharedClock>,
    /// The runtime it runs on: the current one when none.
    pub runtime: Option<Handle>,
    /// How long a connection is silent before it is pinged, and a ping unanswered before it is
    /// closed with 4001 (spec 15.21): [`HEARTBEAT`] when none, or [`NEVER`].
    pub heartbeat: Option<Duration>,
    /// What it holds in parts across its connections (spec 15.23): 256 MiB when none.
    pub held_bytes_budget: Option<u64>,
    /// One envelope's parts together (spec 15.23): [`MAXIMUM_ENVELOPE_PARTS_BYTES`] when none.
    pub maximum_envelope_parts_bytes: Option<u64>,
    /// The slowest parts may come, in bytes a second, once the grace passed since an envelope's
    /// first (spec 15.12): [`MINIMUM_BODY_BYTES_PER_SECOND`] when none; a whole number above 0.
    pub minimum_body_bytes_per_second: Option<u64>,
    /// How long an envelope's parts come before their rate is held (spec 15.12):
    /// [`BODY_GRACE_PERIOD`] when none; never is refused.
    pub body_grace_period: Option<Duration>,
    /// The delivery its application requires: an adapter that gives less is refused as it is
    /// built (spec 15.19); none when none.
    pub require_delivery: Option<BrokerDelivery>,
    /// How its link connects again once lost, each time a new incarnation (spec 15.21): a second
    /// between attempts when none; its attempts without end when it names none; its fixed delay
    /// held as it is built, whatever `reconnects`. Its signal is read before each attempt and during
    /// each wait, an attempt under way not cut short; a delay of 0 none, its next attempt in a later
    /// turn of its tokio runtime; a stop ends it at once, in a wait or once its attempt under way
    /// failed, no wait told after it, the stop its cause. Once it ends it is reported, what ended it
    /// the report's source, and the next start or connect links it anew.
    pub reconnect: Option<TransportClientReconnectOptions>,
    /// Whether its link connects again once lost, as `reconnect` says: true when none; false leaves
    /// it down, reported, until a start or a connect links it anew.
    pub reconnects: Option<bool>,
    /// What it holds of the envelopes of one connection its router paused, past which it loses that
    /// connection, a CLOSE of 4000 (spec 15.23); none bounds each by that connection's
    /// `maximumUnsentBytes`, its transport's. Charged to no budget of its parts.
    pub maximum_held_envelope_bytes: Option<u64>,
}

/// The peer of a broker's connection, as its OPEN or its ACCEPT named it (spec 15.18): its
/// participant's id, its incarnation, the largest parcel its inbox takes whole, and whether its own
/// leg is secure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Peer {
    pub(crate) id: String,
    pub(crate) incarnation: u128,
    pub(crate) bound: u64,
    pub(crate) is_secure: bool,
}

impl Peer {
    /// The peer an OPEN or an ACCEPT names.
    pub(crate) fn of(parcel: &Parcel) -> Self {
        Self {
            id: parcel.id.clone().unwrap_or_default(),
            incarnation: parcel.incarnation.unwrap_or(0),
            bound: parcel.bound.unwrap_or(LEAST_BOUND),
            is_secure: parcel.has(flags::SECURE),
        }
    }
}

/// How a connection ended: clean or not, and what it is reported for of its own.
pub(crate) type End = (bool, Option<RouterError>);

/// What an end of a broker connection is told of it: its client's or its server's transport. Each
/// is told in its participant's turn.
pub(crate) trait ConnectionOwner: Send + Sync {
    /// Whether it opened the connection: a client's, which takes no credential from its server
    /// (spec 15.22).
    fn is_opener(&self) -> bool;

    /// The acceptor's third leg came: the connection is proven and open, its router told of it,
    /// its handle drawn (spec 15.18).
    fn opened(&self, opened: (Pair, &Peer)) -> Option<ConnectionHandle>;

    /// An envelope came whole, with the credential its DATA carried.
    fn delivered(&self, pair: Pair, message: TransportMessage);

    /// The connection ended: clean or not, and what it is reported for of its own; a half-open one
    /// ends telling nothing.
    fn ended(&self, connection: (Pair, Option<ConnectionHandle>), end: End);
}

/// What a connection holds, read from any thread: its gauges' counts.
#[derive(Debug, Default)]
pub(crate) struct Counters {
    pub(crate) is_open: AtomicBool,
    pub(crate) unsent: AtomicU64,
    pub(crate) parts: Arc<AtomicU64>,
}

// how a connection stands, held
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    HalfOpen,
    Open,
}

// one end of a connection (spec 15.17 to 15.23), touched in its participant's turn alone: what its
// router paused it for held in order, its bytes counted apart from its parts', and the CLOSE that
// came behind them, whether clean
struct Connection {
    serial: u64,
    owner: Arc<dyn ConnectionOwner>,
    pair: Pair,
    peer: Peer,
    sent: u64,
    maximum_unsent: u64,
    sequence: Sequence,
    parts: Parts,
    heartbeat: Option<Heartbeat>,
    state: State,
    counters: Arc<Counters>,
    handle: Option<ConnectionHandle>,
    paused: Arc<AtomicBool>,
    held: VecDeque<TransportMessage>,
    held_bytes: u64,
    closing: Option<bool>,
}

impl Connection {
    fn trace_handle(&self) -> Option<ConnectionHandle> {
        if self.owner.is_opener() {
            Some(Arc::from("server"))
        } else {
            self.handle.clone()
        }
    }
}

/// What a connection is, as it is made.
pub(crate) struct Setup {
    /// What its end is told of it.
    pub(crate) owner: Arc<dyn ConnectionOwner>,
    /// Its pair.
    pub(crate) pair: Pair,
    /// Its peer, as its OPEN or its ACCEPT named it.
    pub(crate) peer: Peer,
    /// The last sequence this end sent: a client's OPEN, 1; none yet, 0, for a server's.
    pub(crate) sent: u64,
    /// What may wait for its broker on it.
    pub(crate) maximum_unsent: u64,
    /// Whether it is half-open, its third leg awaited; open otherwise.
    pub(crate) is_half_open: bool,
    /// Whether its router paused it, the flag its transport sets and clears (spec 15.12).
    pub(crate) paused: Arc<AtomicBool>,
}

/// What takes an ACCEPT naming a connect's half: its connection made, held and opened, in its
/// participant's turn.
pub(crate) type Accept = Box<dyn FnOnce(&mut ParticipantState, &Parcel) -> Pair + Send>;

/// A connect of a client transport, awaiting the first ACCEPT or REFUSE naming its half: what takes
/// one, in its participant's turn, and what it settles.
pub(crate) struct PendingConnect {
    /// Takes an ACCEPT naming its half: its connection made, held and opened, in that turn.
    pub(crate) accept: Accept,
    /// The connection it opened; failed when refused, or as its link went down.
    pub(crate) settled: oneshot::Sender<Result<Pair, TransportError>>,
}

/// What a broker's refusal of a connect says (spec 15.18): the REFUSE's reason, its status and a
/// 426's layouts its server reads; or `no-subscriber` alone, its broker saying no participant serves
/// the name.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BrokerRefusal {
    /// `malformed`, `layout-refused`, `busy`, or [`BrokerRefusedError::NO_SUBSCRIBER`].
    pub reason: String,
    /// The REFUSE's status: 400, 426 or 503; none for [`BrokerRefusedError::NO_SUBSCRIBER`].
    pub status: Option<u16>,
    /// The layouts a 426 names, those its server reads; none for any other.
    pub layouts: Option<Vec<u8>>,
}

impl BrokerRefusal {
    /// A refusal for `reason`, of no status and no layouts.
    #[must_use]
    pub fn new<R: Into<String>>(reason: R) -> Self {
        Self {
            reason: reason.into(),
            status: None,
            layouts: None,
        }
    }
}

/// A connect's refusal (spec 15.18), named as section 15.6 names a refusal.
///
/// The REFUSE's status and reason, and a 426's layouts its server reads; or `no-subscriber`, its
/// broker saying no participant serves the name. It is the source of the [`ConnectError`] the
/// connect fails with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerRefusedError {
    reason: String,
    status: Option<u16>,
    layouts: Option<Vec<u8>>,
}

impl BrokerRefusedError {
    /// The reason a broker that says nothing serves the name gives.
    pub const NO_SUBSCRIBER: &str = "no-subscriber";

    /// The connect's failure `refusal` says.
    #[must_use]
    pub fn new(refusal: BrokerRefusal) -> Self {
        let BrokerRefusal {
            reason,
            status,
            layouts,
        } = refusal;

        Self {
            reason,
            status,
            layouts,
        }
    }

    /// `malformed`, `layout-refused`, `busy`, or [`Self::NO_SUBSCRIBER`].
    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// The REFUSE's status: 400, 426 or 503; none for [`Self::NO_SUBSCRIBER`].
    #[must_use]
    pub const fn status(&self) -> Option<u16> {
        self.status
    }

    /// The layouts a 426 names, those its server reads; none for any other.
    #[must_use]
    pub fn layouts(&self) -> Option<&[u8]> {
        self.layouts.as_deref()
    }

    /// A connect's failure, this refusal its source (spec 15.18).
    pub(crate) fn connect_error(self) -> TransportError {
        let message = self.to_string();

        TransportError::Connect(ConnectError::caused(message, Arc::new(self)))
    }
}

impl fmt::Display for BrokerRefusedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(
                formatter,
                "the server refused the connection: {status} {}",
                self.reason
            ),
            None => write!(formatter, "no participant serves the name: {}", self.reason),
        }
    }
}

impl std::error::Error for BrokerRefusedError {}

// a link's start, shared by every start until one fails, or its link went down and stays down: no
// reconnection, or one that ended
struct Starting {
    outcome: watch::Sender<Option<Result<(), BrokerError>>>,
}

impl Starting {
    fn is_failed(&self) -> bool {
        matches!(*self.outcome.borrow(), Some(Err(_)))
    }

    fn wait(self: &Arc<Self>) -> BoxFuture<Result<(), BrokerError>> {
        let mut outcome = self.outcome.subscribe();

        Box::pin(async move {
            outcome
                .wait_for(Option::is_some)
                .await
                .map_err(|_gone| BrokerError::failed("the participant is gone"))
                .and_then(|outcome| outcome.clone().unwrap_or(Ok(())))
        })
    }
}

/// One stop's record (spec 15.21): its mark, set as the stop is called, and its signal, cancelled
/// right after it, which its adapter's start under way gives up on and each reconnection ends at.
/// Each operation captures the record current at its call and reads that one alone, never the
/// participant's current one, so that what a stop ended is told as that stop's, though a start
/// follows it at once; the record is renewed as its stop settles, never at the next start.
#[derive(Debug, Default)]
pub(crate) struct StopRecord {
    is_marked: AtomicBool,
    signal: CancellationToken,
}

impl StopRecord {
    /// Whether its stop came.
    pub(crate) fn is_marked(&self) -> bool {
        self.is_marked.load(Ordering::SeqCst)
    }

    /// What its stop cancels, right after its mark.
    pub(crate) const fn signal(&self) -> &CancellationToken {
        &self.signal
    }

    fn mark(&self) {
        self.is_marked.store(true, Ordering::SeqCst);
    }
}

// where it stands toward its application's stop and dispose: running, linked or not; stopping, its
// stop under way; disposed, for good
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Running,
    Stopping,
    Disposed,
}

// what its link stands as, read from any thread
struct Status {
    incarnation: u128,
    phase: Phase,
    // ! the current stop's record, which each operation captures at its call
    record: Arc<StopRecord>,
    // the end of its last stop, which a stop called before its next link's start settles with
    stopped: Option<watch::Receiver<bool>>,
    // the end of its dispose, which a later dispose settles with
    disposed: Option<watch::Receiver<bool>>,
    // ! taken over by another link of its id: fenced, until its application starts it again, a
    // stop leaving that fence
    is_taken_over: bool,
    // its link went down as it connected: that attempt fails, rather than call it linked
    is_down_as_it_links: bool,
    starting: Option<Arc<Starting>>,
    // what gives up the reconnection under way, as its link is taken over or it stops; let go by
    // that reconnection alone while it holds it
    relinking: Option<Arc<CancellationToken>>,
}

/// What a participant keeps beside its owner: what it was built with, and what any thread reads.
pub(crate) struct Config {
    pub(crate) adapter: Arc<dyn BrokerAdapter>,
    pub(crate) id: String,
    pub(crate) root: String,
    pub(crate) clock: SharedClock,
    pub(crate) given: Option<SharedClock>,
    platform: SharedClock,
    pub(crate) heartbeat: Duration,
    pub(crate) receive_bound: u64,
    pub(crate) parts_bounds: Arc<PartsBounds>,
    // what it holds of one connection paused, past which it loses it; none, its maximumUnsentBytes
    maximum_held_envelope_bytes: Option<u64>,
    reconnect: TransportClientReconnectOptions,
    reconnects: bool,
    status: Mutex<Status>,
    // its adapter's starts under way, which its stop waits out
    under_way: watch::Sender<usize>,
    live: watch::Sender<bool>,
    // the connections held, their counts read for its gauges
    counted: Mutex<HashMap<Pair, Arc<Counters>>>,
    departures: AtomicU64,
    // the server transports over it, by each name they serve
    names: Mutex<HashMap<String, Weak<ServerInner>>>,
    servers: Mutex<Vec<Weak<ServerInner>>>,
    listeners: Listeners<dyn Fn(&RouterError) + Send + Sync>,
    debug_listeners: Listeners<dyn Fn(&ParticipantDebugEvent) + Send + Sync>,
    held_names: Mutex<BTreeSet<String>>,
}

impl Config {
    /// Builds and tells a trace only while watched, with no clock reading (debugging 13.10).
    pub(crate) fn debug<F: FnOnce() -> ParticipantDebugEvent>(&self, event: F) {
        if self.debug_listeners.is_empty() {
            return;
        }

        let event = event();

        self.debug_listeners.each((
            |listener: &(dyn Fn(&ParticipantDebugEvent) + Send + Sync + 'static)| listener(&event),
            |error| self.tell_error(&error),
        ));
    }

    /// A name held by its broker's word, after its acknowledgement (debugging 13.5).
    pub(crate) fn name_changed(&self, (name, is_held, group): (&str, bool, Option<&str>)) {
        {
            let mut names = locked(&self.held_names);

            if is_held {
                names.insert(name.to_owned());
            } else {
                names.remove(name);
            }
        }

        self.debug(|| ParticipantDebugEvent {
            event: "names",
            name: Some(name.to_owned()),
            is_held: Some(is_held),
            group: group.map(str::to_owned),
            ..ParticipantDebugEvent::default()
        });
    }

    fn transition(&self, state: &'static str, ended: Option<Vec<u64>>) {
        self.debug(|| ParticipantDebugEvent {
            event: "link",
            state: Some(state),
            incarnation: Some(format!("{:032x}", self.incarnation())),
            ended,
            ..ParticipantDebugEvent::default()
        });
    }

    /// A parcel attempted, before the adapter takes it, without reading its bytes again.
    pub(crate) fn trace_tx<F: FnOnce() -> Option<(u64, Option<ConnectionHandle>)>>(
        &self,
        (topic, payload, parcel): (&[String], &Bytes, &Parcel),
        connection: F,
    ) {
        self.debug(|| {
            let connection = connection();

            ParticipantDebugEvent {
                direction: Some(DebugDirection::Tx),
                flags: payload.get(2).copied(),
                has_credential: (parcel.kind == kinds::DATA).then(|| {
                    payload
                        .get(2)
                        .is_some_and(|flags| flags & flags::CREDENTIAL != 0)
                }),
                topic: Some(topic.to_vec()),
                bytes: Some(payload.len()),
                connection: connection.as_ref().map(|(serial, _)| *serial),
                connection_handle: connection.and_then(|(_, handle)| handle),
                ..ParticipantDebugEvent::parcel(parcel)
            }
        });
    }

    /// What the participant or a transport reports in its own words.
    pub(crate) fn trace_report<F: FnOnce() -> Option<(u64, Option<ConnectionHandle>)>>(
        &self,
        error: &RouterError,
        connection: F,
    ) {
        self.debug(|| {
            let connection = connection();

            ParticipantDebugEvent {
                event: "report",
                report: Some(error.to_string()),
                connection: connection.as_ref().map(|(serial, _)| *serial),
                connection_handle: connection.and_then(|(_, handle)| handle),
                ..ParticipantDebugEvent::default()
            }
        });
    }

    /// A participant's inbox: its root, `i` and its id (spec 15.16).
    pub(crate) fn inbox_of(&self, id: &str) -> Vec<String> {
        vec![self.root.clone(), "i".to_owned(), id.to_owned()]
    }

    /// A server's name: its root, `s` and the name.
    pub(crate) fn name_of(&self, name: &str) -> Vec<String> {
        vec![self.root.clone(), "s".to_owned(), name.to_owned()]
    }

    /// A participant's departure: its root, `d` and its id.
    pub(crate) fn departure_of(&self, id: &str) -> Vec<String> {
        vec![self.root.clone(), "d".to_owned(), id.to_owned()]
    }

    /// The largest payload its adapter publishes to `topic`, as a receive bound's field holds it.
    pub(crate) fn maximum_payload_bytes(&self, topic: &[String]) -> u64 {
        self.adapter.maximum_payload_bytes(topic).min(LARGEST_BOUND)
    }

    /// Its incarnation, drawn as its link last connected.
    pub(crate) fn incarnation(&self) -> u128 {
        locked(&self.status).incarnation
    }

    /// Whether its link went down as it connects, so that what failed then is its loss, not a
    /// refusal.
    pub(crate) fn is_down_as_it_links(&self) -> bool {
        locked(&self.status).is_down_as_it_links
    }

    /// Whether its link is up: started, and not lost since, or connected again.
    pub(crate) fn is_linked(&self) -> bool {
        *self.live.borrow()
    }

    /// The peers' departures it holds a subscription to.
    pub(crate) fn departures(&self) -> u64 {
        self.departures.load(Ordering::SeqCst)
    }

    /// What each connection of `pairs` it holds counts.
    pub(crate) fn counted_of(&self, pairs: &[Pair]) -> Vec<Arc<Counters>> {
        let counted = locked(&self.counted);

        pairs
            .iter()
            .filter_map(|pair| counted.get(pair).cloned())
            .collect()
    }

    /// A publication of its adapter's, living as long as given where its adapter offers a
    /// message's life.
    pub(crate) fn publish(
        &self,
        (topic, payload, expires_after): (Vec<String>, Bytes, Option<Duration>),
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        let mut publication = BrokerPublication::new(topic, payload);

        if self
            .adapter
            .capabilities()
            .contains(BrokerCapabilities::EXPIRY)
        {
            publication.expires_after = expires_after;
        }

        self.adapter.publish(publication)
    }

    /// What it ends no connection for, reported on its own and by each of its server's transports
    /// with no handle: a message that is no parcel, or an OPEN that does not read, which it drops
    /// (spec 15.1, 15.17).
    pub(crate) fn report(&self, error: &RouterError) {
        self.trace_report(error, || None);
        self.tell_error(error);

        for server in self.servers() {
            server.report((error, None));
        }
    }

    // ! a debug listener's panic reaches errors alone, so it cannot trace itself recursively
    fn tell_error(&self, error: &RouterError) {
        let heard = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn Fn(&RouterError) + Send + Sync + 'static)| listener(error),
            |panicked: RouterError| {
                for listener in &heard {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&panicked)))
                        .ok();
                }
            },
        ));
    }

    /// The server transports over it, while they stand.
    pub(crate) fn servers(&self) -> Vec<Arc<ServerInner>> {
        locked(&self.servers)
            .iter()
            .filter_map(Weak::upgrade)
            .collect()
    }

    fn taken_over(&self) -> String {
        format!(
            "the link of {} was taken over by another link of its id",
            self.id
        )
    }

    // a link its stop met as it connected: a failure of that link's, never a misuse, which a call
    // made once disposed is; what its adapter failed with as it stopped, its source
    fn stopped_as_it_started(&self, source: Option<BrokerError>) -> BrokerError {
        let message = format!("the participant {} stopped as it started", self.id);

        match source {
            Some(source) => BrokerError::caused(message, Arc::new(source)),
            None => BrokerError::failed(message),
        }
    }

    /// A connect its stop met before that stop settled, awaiting its link or its answer: a failure
    /// of that connect's, never the misuse a call made once disposed is.
    pub(crate) fn stopped_as_it_connected(&self) -> String {
        format!("the participant {} stopped as it connected", self.id)
    }

    /// A call made once it is disposed: its application's misuse, refused before anything moves
    /// (spec 15.21).
    pub(crate) fn disposed_refusal(&self) -> ProgrammerError {
        ProgrammerError::new(format!("the participant {} is disposed", self.id))
    }

    // a start made while its stop is under way: its application's misuse
    fn stopping_refusal(&self) -> ProgrammerError {
        ProgrammerError::new(format!("the participant {} is stopping", self.id))
    }

    /// Whether it is disposed: a call made since is its application's misuse.
    pub(crate) fn is_disposed(&self) -> bool {
        locked(&self.status).phase == Phase::Disposed
    }

    /// The current stop's record, which an operation that links it as it needs, a client's connect
    /// or reconnection, captures at its call: a stop called from then on stops what it links,
    /// never settles with the last one, so that what is under way as a stop is called ends with
    /// it, though its link has not started yet.
    pub(crate) fn linking_record(&self) -> Arc<StopRecord> {
        let mut status = locked(&self.status);

        if status.phase == Phase::Running && !status.is_taken_over {
            status.stopped = None;
        }

        Arc::clone(&status.record)
    }

    /// What a reconnection ends with: cancelled once the stop `record` names came, that stop its
    /// source (spec 15.21); any other end as it is.
    pub(crate) fn attributed(
        &self,
        (ended, record): (TransportError, &StopRecord),
    ) -> TransportError {
        if record.is_marked()
            && let TransportError::Cancelled {
                message,
                source: None,
            } = &ended
        {
            return TransportError::cancelled_by(
                message.clone(),
                Arc::new(BrokerError::failed(format!(
                    "the participant {} stopped",
                    self.id
                ))),
            );
        }

        ended
    }
}

// an adapter's start under way, counted from its link's first step to the start's end, whatever
// ends it; counted under its participant's status lock, where its stop is marked, so that a stop
// either refuses it or waits it out: the stop the record its link captured names, or one under way
struct UnderWay<'config>(&'config watch::Sender<usize>);

impl<'config> UnderWay<'config> {
    fn of((config, record): (&'config Config, &StopRecord)) -> Result<Self, BrokerError> {
        let status = locked(&config.status);

        if record.is_marked() || status.phase != Phase::Running {
            return Err(config.stopped_as_it_started(None));
        }

        // ! the count under the status lock, the watch's own lock after it and never before it
        config
            .under_way
            .send_modify(|count| *count = count.saturating_add(1));
        drop(status);

        Ok(Self(&config.under_way))
    }
}

impl Drop for UnderWay<'_> {
    fn drop(&mut self) {
        self.0.send_modify(|count| *count = count.saturating_sub(1));
    }
}

// a stop's end, as its task ends, whatever ends it: its turns done, a panic of its adapter's stop,
// or its runtime gone before it ran. Its record renewed under the status lock, unless disposed, then
// told to every stop that shares it, so that a start made as the stop settles links anew
struct Ended {
    config: Arc<Config>,
    told: watch::Sender<bool>,
}

impl Drop for Ended {
    fn drop(&mut self) {
        {
            let mut status = locked(&self.config.status);

            if status.phase == Phase::Stopping {
                status.phase = Phase::Running;
                status.record = Arc::default();
            }
        }

        self.told.send_replace(true);
    }
}

// * a job of the participant's that panics, a listener's being guarded, ends it: what waits on it
// hears it gone
impl crate::owner::Owned for ParticipantState {}

/// What a participant's owner holds: its connections, the connects awaiting their answer, the
/// departures it subscribes. Touched in its turn alone.
pub(crate) struct ParticipantState {
    pub(crate) config: Arc<Config>,
    pub(crate) owner: WeakOwner<Self>,
    connections: HashMap<Pair, Connection>,
    connects: HashMap<u64, PendingConnect>,
    departures: HashMap<String, u32>,
    serial: u64,
    // each peer whose CLOSE its broker did not take as it last stopped, reset at its next link
    unreset: Vec<(String, Pair)>,
}

// a parcel of a connection handed to its adapter: what its broker says of it, and what it counts
// until then
struct Handed {
    published: BoxFuture<Result<BrokerPublished, BrokerError>>,
    counters: Arc<Counters>,
    length: u64,
    serial: u64,
}

// what a stop's CLOSE to a peer settles to, its peer and its pair beside it
type Closing = (
    String,
    Pair,
    BoxFuture<Result<BrokerPublished, BrokerError>>,
);

impl ParticipantState {
    fn trace_rx(
        &self,
        (message, parcel): (&BrokerMessage, Option<&Parcel>),
        (verdict, pair): (ParcelVerdict, Option<Pair>),
    ) {
        self.config.debug(|| {
            let connection = pair.and_then(|pair| self.connections.get(&pair));
            let mut event = parcel.map_or_else(
                || ParticipantDebugEvent {
                    event: "parcel",
                    ..ParticipantDebugEvent::default()
                },
                ParticipantDebugEvent::parcel,
            );

            event.direction = Some(DebugDirection::Rx);
            event.topic = Some(message.topic().to_vec());
            event.bytes = Some(message.payload().len());
            event.verdict = Some(verdict);
            event.flags = parcel.and_then(|_| message.payload().get(2).copied());
            event.connection = connection.map(|connection| connection.serial);
            event.connection_handle = connection.and_then(Connection::trace_handle);

            if verdict == ParcelVerdict::Loss {
                event.awaited = connection.map(|connection| connection.sequence.awaited());
                event.came = parcel.map(|parcel| parcel.sequence);
            }

            event
        });
    }

    fn ordinals(&self) -> Option<Vec<u64>> {
        (!self.config.debug_listeners.is_empty()).then(|| {
            let mut ended: Vec<_> = self
                .connections
                .values()
                .map(|connection| connection.serial)
                .collect();

            ended.sort_unstable();
            ended
        })
    }

    /// A half drawn from a cryptographic source, never all zero, none it holds already (spec
    /// 15.17); none when the system's source gives nothing.
    pub(crate) fn draw_half(&self) -> Option<u64> {
        for _ in 0..64 {
            let mut bytes = [0_u8; 8];

            getrandom::fill(&mut bytes).ok()?;

            let half = u64::from_be_bytes(bytes);
            let is_held = half == 0
                || self.connects.contains_key(&half)
                || self
                    .connections
                    .keys()
                    .any(|(opener, acceptor)| *opener == half || *acceptor == half);

            if !is_held {
                return Some(half);
            }
        }

        None
    }

    /// Awaits the first ACCEPT or REFUSE naming `opener`'s half.
    pub(crate) fn await_answer(&mut self, (opener, pending): (u64, PendingConnect)) {
        self.connects.insert(opener, pending);
    }

    /// Gives up on a connect's answer, so a late ACCEPT of it is reset.
    pub(crate) fn give_up(&mut self, opener: u64) {
        self.connects.remove(&opener);
    }

    /// Whether the connection of `pair` stands open.
    pub(crate) fn is_open(&self, pair: Pair) -> bool {
        self.connections
            .get(&pair)
            .is_some_and(|connection| connection.state == State::Open)
    }

    /// Whether the connection of `pair` stands half-open.
    pub(crate) fn is_half_open(&self, pair: Pair) -> bool {
        self.connections
            .get(&pair)
            .is_some_and(|connection| connection.state == State::HalfOpen)
    }

    /// The largest parcel toward the peer of `pair`: the smaller of its peer's bound and what its
    /// adapter publishes to its peer's inbox (spec 15.20).
    pub(crate) fn room_of(&self, pair: Pair) -> Option<u64> {
        self.connections
            .get(&pair)
            .map(|connection| self.room(&connection.peer))
    }

    fn room(&self, peer: &Peer) -> u64 {
        peer.bound.min(
            self.config
                .maximum_payload_bytes(&self.config.inbox_of(&peer.id)),
        )
    }

    /// A RESET of a pair, to its peer's inbox, whatever its broker says of it.
    pub(crate) fn reset_peer(&self, (peer, pair): (&str, Pair)) {
        let mut reset = Parcel::of(kinds::RESET);

        (reset.opener, reset.acceptor) = pair;
        self.quietly((self.config.inbox_of(peer), &reset));
    }

    /// A parcel published to `topic`, whatever its broker says of it.
    pub(crate) fn quietly(&self, (topic, parcel): (Vec<String>, &Parcel)) {
        let Ok(payload) = write_parcel(parcel) else {
            return;
        };
        self.config.trace_tx((&topic, &payload, parcel), || None);
        let published = self.config.publish((topic, payload, None));

        self.owner.cover(async move {
            published.await.ok();
        });
    }

    /// A connection made: held, half-open or open, its first parcel the next it sends.
    pub(crate) fn hold(&mut self, setup: Setup) {
        self.serial = self.serial.saturating_add(1);

        let serial = self.serial;
        let pair = setup.pair;
        let late_owner = self.owner.clone();
        let parts = Parts::new(
            Arc::clone(&self.config.parts_bounds),
            Arc::new(move || {
                late_owner.offer(Box::new(move |state: &mut Self| {
                    state.parts_late((pair, serial));
                }));
            }),
        );
        let counters = Arc::new(Counters {
            is_open: AtomicBool::new(!setup.is_half_open),
            unsent: AtomicU64::new(0),
            parts: parts.counted(),
        });

        locked(&self.config.counted).insert(pair, Arc::clone(&counters));
        self.connections.insert(
            pair,
            Connection {
                serial,
                owner: setup.owner,
                pair,
                peer: setup.peer,
                sent: setup.sent,
                maximum_unsent: setup.maximum_unsent,
                sequence: Sequence::new(2),
                parts,
                heartbeat: None,
                state: if setup.is_half_open {
                    State::HalfOpen
                } else {
                    State::Open
                },
                counters,
                handle: None,
                paused: setup.paused,
                held: VecDeque::new(),
                held_bytes: 0,
                closing: None,
            },
        );
    }

    /// Opens a connection: its heartbeat started, its peer's departure subscribed (spec 15.21).
    pub(crate) fn open(&mut self, pair: Pair) {
        let heartbeat = self.config.heartbeat;
        let platform = Arc::clone(&self.config.platform);
        let Some(connection) = self.connections.get_mut(&pair) else {
            return;
        };
        let serial = connection.serial;
        let peer = connection.peer.id.clone();

        connection.state = State::Open;
        connection.counters.is_open.store(true, Ordering::SeqCst);

        if heartbeat != NEVER {
            let (pinging, dropping) = (self.owner.clone(), self.owner.clone());

            connection.heartbeat = Some(Heartbeat::start(
                heartbeat,
                (
                    platform,
                    HeartbeatHooks {
                        ping: Arc::new(move || {
                            pinging.offer(Box::new(move |state: &mut Self| {
                                if state.is_serial((pair, serial)) && state.is_open(pair) {
                                    state.publish_on(pair, (Parcel::of(kinds::PING), None));
                                }
                            }));
                        }),
                        drop: Arc::new(move || {
                            dropping.offer(Box::new(move |state: &mut Self| {
                                if state.is_serial((pair, serial)) && state.is_open(pair) {
                                    let mut close = Parcel::of(kinds::CLOSE);

                                    close.code = Some(codes::UNANSWERED);
                                    state.publish_on(pair, (close, None));
                                    state.ended(pair, (false, None));
                                }
                            }));
                        }),
                    },
                ),
            ));
        }

        self.depart((&peer, true));
    }

    fn is_serial(&self, (pair, serial): (Pair, u64)) -> bool {
        self.connections
            .get(&pair)
            .is_some_and(|connection| connection.serial == serial)
    }

    // * a peer's departure subscribed while a connection with it is held, where a will can be left,
    // never awaited (spec 15.21)
    fn depart(&mut self, (peer, is_more): (&str, bool)) {
        let adapter = Arc::clone(&self.config.adapter);

        if !adapter.capabilities().contains(BrokerCapabilities::WILL) {
            return;
        }

        let topic = self.config.departure_of(peer);
        let held = self.departures.get(peer).copied().unwrap_or(0);
        let held = if is_more {
            held.saturating_add(1)
        } else {
            held.saturating_sub(1)
        };

        if held > 0 {
            if !self.departures.contains_key(peer) {
                let subscribing = adapter.subscribe(&topic, BrokerSubscription::default());

                self.owner.cover(async move {
                    subscribing.await.ok();
                });
            }

            self.departures.insert(peer.to_owned(), held);
        } else if self.departures.remove(peer).is_some() {
            let unsubscribing = adapter.unsubscribe(&topic);

            self.owner.cover(async move {
                unsubscribing.await.ok();
            });
        }

        self.config.departures.store(
            u64::try_from(self.departures.len()).unwrap_or(u64::MAX),
            Ordering::SeqCst,
        );
    }

    /// Sends a PING, the next of its sequence: the client's third leg (spec 15.18).
    pub(crate) fn ping(&mut self, pair: Pair) {
        self.publish_on(pair, (Parcel::of(kinds::PING), None));
    }

    /// Publishes the ACCEPT of a connection half-open, its first parcel.
    pub(crate) fn accept_on(&mut self, (pair, is_secure): (Pair, bool)) {
        let mut accept = Parcel::of(kinds::ACCEPT);

        accept.flags = Some(if is_secure { flags::SECURE } else { 0 });
        accept.id = Some(self.config.id.clone());
        accept.incarnation = Some(self.config.incarnation());
        accept.bound = Some(self.config.receive_bound);
        self.publish_on(pair, (accept, None));
    }

    /// Publishes a parcel of a connection to its peer's inbox, the one way each of its parcels
    /// goes: the next of its sequence, a RESET unnumbered, what waits for its broker counted until
    /// it is taken. A parcel but a CLOSE that would take that past `maximumUnsentBytes` loses the
    /// connection instead, a CLOSE of 4000, reported naming the bound (spec 15.23); once it ended,
    /// or its peer's CLOSE came, held behind what it holds, none goes.
    pub(crate) fn publish_on(
        &mut self,
        pair: Pair,
        (parcel, expires_after): (Parcel, Option<Duration>),
    ) {
        let Some(Handed {
            published,
            counters,
            length,
            serial,
        }) = self.handed(pair, (parcel, expires_after))
        else {
            return;
        };
        let owner = self.owner.clone();

        self.owner.cover(async move {
            let published = published.await;

            owner.offer(Box::new(move |state: &mut Self| {
                counters
                    .unsent
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |unsent| {
                        Some(unsent.saturating_sub(length))
                    })
                    .ok();

                // a parcel its broker refused, or no subscriber took: its peer's inbox is gone, as a
                // dropped socket's
                if !matches!(published, Ok(BrokerPublished::Taken))
                    && state.is_serial((pair, serial))
                {
                    state.ended(pair, (false, None));
                }
            }));
        });
    }

    // a parcel of a connection numbered, counted and handed to its adapter, as `publish_on` says;
    // none once it ended, its peer's CLOSE held, or lost past maximumUnsentBytes instead
    fn handed(
        &mut self,
        pair: Pair,
        (parcel, expires_after): (Parcel, Option<Duration>),
    ) -> Option<Handed> {
        let connection = self
            .connections
            .get_mut(&pair)
            .filter(|connection| connection.closing.is_none())?;
        let is_reset = parcel.kind == kinds::RESET;
        let is_close = parcel.kind == kinds::CLOSE;
        let sequence = if is_reset {
            0
        } else {
            connection.sent.saturating_add(1)
        };
        let parcel = Parcel {
            opener: pair.0,
            acceptor: pair.1,
            sequence,
            ..parcel
        };
        let bytes = write_parcel(&parcel).ok()?;
        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let unsent = connection.counters.unsent.load(Ordering::SeqCst);

        // ! held before its sequence is taken: the CLOSE that loses the connection is the next,
        // with no gap before it
        if !is_close && unsent.saturating_add(length) > connection.maximum_unsent {
            let why = format!(
                "what waits for its broker would pass maximumUnsentBytes, {} bytes",
                connection.maximum_unsent
            );

            self.lose(pair, (codes::LOST, why));

            return None;
        }

        if !is_reset {
            connection.sent = sequence;
        }

        connection
            .counters
            .unsent
            .store(unsent.saturating_add(length), Ordering::SeqCst);

        let serial = connection.serial;
        let counters = Arc::clone(&connection.counters);
        let topic = self.config.inbox_of(&connection.peer.id);

        self.config.trace_tx((&topic, &bytes, &parcel), || {
            Some((serial, connection.trace_handle()))
        });

        Some(Handed {
            published: self.config.publish((topic, bytes, expires_after)),
            counters,
            length,
            serial,
        })
    }

    /// Sends an envelope in DATA parcels: whole where it fits the smaller of its peer's bound and
    /// what its adapter publishes to its peer's inbox, in parts otherwise, each as large as that
    /// bound lets it but the last, the credential on the first (spec 15.20); each held to what may
    /// wait for its broker. The part that carries a credential lives in its broker twice its
    /// heartbeat, none when its heartbeat is never (spec 15.22).
    pub(crate) fn send_on(&mut self, pair: Pair, message: &TransportMessage) {
        let Some(peer) = self
            .connections
            .get(&pair)
            .filter(|connection| connection.state == State::Open)
            .map(|connection| connection.peer.clone())
        else {
            return;
        };
        let credential = message
            .credential
            .clone()
            .filter(|credential| !credential.is_empty());
        let parts = cut(
            &message.data,
            (self.room(&peer), credential.as_ref().map(String::len)),
        );
        let life =
            (self.config.heartbeat != NEVER).then(|| self.config.heartbeat.saturating_mul(2));
        let count = parts.len();

        for (index, (part, carries)) in parts.into_iter().enumerate() {
            let mut data = Parcel::of(kinds::DATA);
            let is_more = index.saturating_add(1) < count;

            data.flags = Some(if is_more { flags::MORE } else { 0 });
            data.credential = if carries { credential.clone() } else { None };
            data.carried = Some(part);
            self.publish_on(pair, (data, if carries { life } else { None }));
        }
    }

    /// Closes a connection of this end's own: a CLOSE of `code` sent, its other end told, a
    /// half-open one's among them; this end's owner told as `is_clean` says.
    pub(crate) fn close(&mut self, pair: Pair, (code, is_clean): (u16, bool)) {
        if !self.connections.contains_key(&pair) {
            return;
        }

        let mut close = Parcel::of(kinds::CLOSE);

        close.code = Some(code);
        self.publish_on(pair, (close, None));
        self.ended(pair, (is_clean, None));
    }

    /// Lets go of a connection at once, sending nothing, unclean: its link lost, its peer gone, or a
    /// half-open one forgotten.
    pub(crate) fn drop_connection(&mut self, pair: Pair) {
        self.ended(pair, (false, None));
    }

    /// Sends a RESET of a connection's pair to its peer, unsequenced, and lets go of it, unclean.
    pub(crate) fn reset(&mut self, pair: Pair) {
        if !self.connections.contains_key(&pair) {
            return;
        }

        self.publish_on(pair, (Parcel::of(kinds::RESET), None));
        self.ended(pair, (false, None));
    }

    // lost of its own: a CLOSE of its code, its end unclean, reported naming why (spec 15.1)
    fn lose(&mut self, pair: Pair, (code, why): (u16, String)) {
        let Some(connection) = self.connections.get(&pair) else {
            return;
        };
        let subject = connection.handle.as_ref().map_or_else(
            || {
                if connection.owner.is_opener() {
                    format!("the connection to {}", connection.peer.id)
                } else {
                    format!("a half-open connection of {}", connection.peer.id)
                }
            },
            ToString::to_string,
        );
        let mut close = Parcel::of(kinds::CLOSE);

        close.code = Some(code);
        self.publish_on(pair, (close, None));
        self.ended(
            pair,
            (
                false,
                Some(reported(format!("{subject} is closed with {code}: {why}"))),
            ),
        );
    }

    // its end, once: its heartbeat and its parts let go of, its participant and its owner told
    fn ended(&mut self, pair: Pair, end: End) {
        let Some(mut connection) = self.connections.remove(&pair) else {
            return;
        };

        locked(&self.config.counted).remove(&pair);

        if let Some(heartbeat) = connection.heartbeat.take() {
            heartbeat.stop();
        }

        connection.parts.stop();

        if let Some(error) = &end.1 {
            self.config.trace_report(error, || {
                Some((connection.serial, connection.trace_handle()))
            });
        }

        if connection.state == State::Open {
            self.depart((&connection.peer.id, false));
        }

        connection
            .owner
            .ended((pair, connection.handle.clone()), end);
    }

    // its parts' timer, judged in its turn, lost when late
    fn parts_late(&mut self, (pair, serial): (Pair, u64)) {
        let Some(connection) = self
            .connections
            .get_mut(&pair)
            .filter(|connection| connection.serial == serial && connection.parts.held_bytes() > 0)
        else {
            return;
        };

        if connection.parts.is_late() {
            let why = connection.parts.late_of();

            self.lose(pair, (codes::LOST, why));
        } else if let Err(error) = connection.parts.rearm() {
            self.config.report(&RouterError::Other(Arc::new(error)));
            self.lose(pair, (codes::LOST, "the clock refused a timer".to_owned()));
        }
    }

    // whether a sequence is the next awaited; a copy dropped, a gap a loss
    fn is_next(&mut self, pair: Pair, (parcel, message): (&Parcel, &BrokerMessage)) -> bool {
        let Some(connection) = self.connections.get_mut(&pair) else {
            return false;
        };

        match connection.sequence.take(parcel.sequence) {
            Taking::Next => true,
            Taking::Copy => {
                self.trace_rx((message, Some(parcel)), (ParcelVerdict::Copy, Some(pair)));
                false
            }
            Taking::Gap => {
                let why = connection.sequence.gap_of(parcel.sequence);

                self.trace_rx((message, Some(parcel)), (ParcelVerdict::Loss, Some(pair)));

                self.lose(pair, (codes::LOST, why));

                false
            }
        }
    }

    // a parcel naming a pair it holds, that reads: a RESET ends it at once, and one of a layout to
    // come closes it with 1002; any other is taken in its sequence, a copy dropped, a gap a loss,
    // and the next handed on by its kind, an advisory one skipped, and an OPEN, an ACCEPT, a
    // REFUSE, a GONE, or anything but a DATA between an envelope's parts, closing it with 1002
    fn take_on(&mut self, pair: Pair, (parcel, message): (Parcel, &BrokerMessage)) {
        let Some(connection) = self.connections.get(&pair) else {
            return;
        };

        if let Some(heartbeat) = &connection.heartbeat {
            heartbeat.heard();
        }

        if parcel.kind == kinds::RESET {
            self.trace_rx((message, Some(&parcel)), (ParcelVerdict::Taken, Some(pair)));
            self.ended(pair, (false, None));

            return;
        }

        // * its peer closed it, its CLOSE held behind what it holds: nothing comes after a CLOSE
        if connection.closing.is_some() {
            return;
        }

        if parcel.layout != LAYOUT {
            self.trace_rx((message, Some(&parcel)), (ParcelVerdict::Taken, Some(pair)));
            let why = format!(
                "a parcel of a layout to come, {}",
                hex_of_byte(parcel.layout)
            );

            self.lose(pair, (codes::PROTOCOL_ERROR, why));

            return;
        }

        if !self.is_next(pair, (&parcel, message)) {
            return;
        }

        // * the third leg: the opener's first parcel naming both halves proves it reads its inbox
        if self.is_half_open(pair) {
            self.open(pair);

            let opened = self
                .connections
                .get(&pair)
                .map(|connection| (Arc::clone(&connection.owner), connection.peer.clone()));

            if let Some((owner, peer)) = opened {
                let handle = owner.opened((pair, &peer));

                if let Some(connection) = self.connections.get_mut(&pair) {
                    connection.handle = handle;
                }
            }

            if !self.is_open(pair) {
                return;
            }
        }

        self.trace_rx(
            (message, Some(&parcel)),
            (
                if is_advisory(parcel.kind) {
                    ParcelVerdict::Advisory
                } else {
                    ParcelVerdict::Taken
                },
                Some(pair),
            ),
        );

        if is_advisory(parcel.kind) {
            return;
        }

        let is_holding = self
            .connections
            .get(&pair)
            .is_some_and(|connection| connection.parts.held_bytes() > 0);

        if is_holding && parcel.kind != kinds::DATA {
            let why = format!("{} between an envelope's parts", kind_named(parcel.kind));

            self.lose(pair, (codes::PROTOCOL_ERROR, why));

            return;
        }

        match parcel.kind {
            kinds::DATA => self.take_data(pair, parcel),
            kinds::PING => {
                let mut pong = Parcel::of(kinds::PONG);

                pong.answers = Some(parcel.sequence);
                self.publish_on(pair, (pong, None));
            }
            // a PONG answers what it heard
            kinds::PONG => {}
            kinds::CLOSE => self.take_close(pair, parcel.code == Some(codes::NORMAL)),
            _ => {
                let why = format!("{} on a connection open", kind_named(parcel.kind));

                self.lose(pair, (codes::PROTOCOL_ERROR, why));
            }
        }
    }

    // a parcel naming a pair it holds that does not read: a kind to come taken in its order, a copy
    // dropped and a gap a loss (spec 15.17); then the connection closed with 1002, reported naming
    // it
    fn take_unread(
        &mut self,
        pair: Pair,
        (prefix, why, message): (Parcel, String, &BrokerMessage),
    ) {
        // * nothing comes after a CLOSE: what comes once one is held behind what it holds is
        // dropped
        let Some(connection) = self
            .connections
            .get(&pair)
            .filter(|connection| connection.closing.is_none())
        else {
            return;
        };

        if let Some(heartbeat) = &connection.heartbeat {
            heartbeat.heard();
        }

        // * a kind to come is taken in its order, a copy dropped and a gap a loss; any other closes
        // at once
        if is_kind_to_come(prefix.kind)
            && prefix.sequence <= LARGEST_SEQUENCE
            && !self.is_next(pair, (&prefix, message))
        {
            return;
        }

        self.trace_rx(
            (message, Some(&prefix)),
            (ParcelVerdict::DoesNotRead, Some(pair)),
        );
        self.lose(
            pair,
            (
                codes::PROTOCOL_ERROR,
                format!("a parcel that does not read: {why}"),
            ),
        );
    }

    fn take_data(&mut self, pair: Pair, parcel: Parcel) {
        let Some(connection) = self.connections.get_mut(&pair) else {
            return;
        };
        let is_opener = connection.owner.is_opener();

        // ! nothing is carried toward an opener (spec 15.22)
        if is_opener && parcel.credential.is_some() {
            self.lose(
                pair,
                (
                    codes::PROTOCOL_ERROR,
                    "a DATA toward its client carries a credential, which no server's does"
                        .to_owned(),
                ),
            );

            return;
        }

        let is_more = parcel.has(flags::MORE);
        let taking = connection.parts.take((
            parcel.carried.unwrap_or_default(),
            is_more,
            parcel.credential,
        ));

        match taking {
            PartTaking::Lost(code, why) => self.lose(pair, (code, why)),
            PartTaking::Held => {}
            PartTaking::Whole(envelope, credential) => {
                let address = (!is_opener).then(|| connection.peer.id.clone());

                self.hand(
                    pair,
                    TransportMessage {
                        data: envelope,
                        credential,
                        address,
                        ..TransportMessage::default()
                    },
                );
            }
        }
    }

    // a CLOSE ends its connection once all before it was handed on (spec 15.21): at once, unless
    // what its router paused it for is held, which it then waits behind, its heartbeat stopped
    fn take_close(&mut self, pair: Pair, is_clean: bool) {
        let Some(connection) = self.connections.get_mut(&pair) else {
            return;
        };

        if connection.held.is_empty() {
            self.ended(pair, (is_clean, None));

            return;
        }

        connection.closing = Some(is_clean);

        if let Some(heartbeat) = connection.heartbeat.take() {
            heartbeat.stop();
        }
    }

    /// Hands an envelope come whole for `pair` on to that connection's end; or, while its router
    /// paused it or anything is held, holds it behind what is held, in order (spec 15.12). One that
    /// would take what the connection holds past `maximumHeldEnvelopeBytes` loses it instead, a
    /// CLOSE of 4000, reported naming the bound, and no other connection (spec 15.23).
    pub(crate) fn hand(&mut self, pair: Pair, message: TransportMessage) {
        let bound = self.config.maximum_held_envelope_bytes;
        let Some(connection) = self.connections.get_mut(&pair) else {
            return;
        };

        // ! asked anew for each envelope: what is held goes first, whatever the flag says now
        if !connection.paused.load(Ordering::SeqCst) && connection.held.is_empty() {
            let owner = Arc::clone(&connection.owner);

            owner.delivered(pair, message);

            return;
        }

        let bound = bound.unwrap_or(connection.maximum_unsent);
        let length = u64::try_from(message.data.len()).unwrap_or(u64::MAX);

        match connection.held_bytes.checked_add(length) {
            Some(held) if held <= bound => {
                connection.held_bytes = held;
                connection.held.push_back(message);
            }
            Some(_) | None => {
                let why = format!(
                    "what it holds for its router, paused, would pass maximumHeldEnvelopeBytes, {bound} bytes"
                );

                self.lose(pair, (codes::LOST, why));
            }
        }
    }

    /// A resume's turn: what `pair` holds handed on, in order, each after asking whether its
    /// router paused it again, which handing one may do; then a CLOSE held behind them ends it. A
    /// `take_data` queued ahead of this turn held its envelope behind what was held, so none
    /// overtakes another.
    pub(crate) fn release(&mut self, pair: Pair) {
        loop {
            let Some(connection) = self.connections.get_mut(&pair) else {
                return;
            };

            if connection.paused.load(Ordering::SeqCst) {
                return;
            }

            let Some(message) = connection.held.pop_front() else {
                break;
            };

            connection.held_bytes = connection
                .held_bytes
                .saturating_sub(u64::try_from(message.data.len()).unwrap_or(u64::MAX));

            let owner = Arc::clone(&connection.owner);

            owner.delivered(pair, message);
        }

        let closing = self
            .connections
            .get(&pair)
            .and_then(|connection| connection.closing);

        if let Some(is_clean) = closing {
            self.ended(pair, (is_clean, None));
        }
    }

    // a message its adapter received, taken, then acknowledged — never once its router is done
    // with it (spec 15.19)
    fn take(&mut self, message: &BrokerMessage) {
        // ! no parcel is retained: one that comes so is dropped in silence (spec 15.23)
        let is_held = match message.topic() {
            [root, place, name] if !message.is_retained() && *root == self.config.root => {
                match place.as_str() {
                    "i" => *name == self.config.id,
                    "s" => locked(&self.config.names).contains_key(name),
                    "d" => self.departures.contains_key(name),
                    _ => false,
                }
            }
            _ => false,
        };

        if is_held && let [_, place, name] = message.topic() {
            match place.as_str() {
                "i" => self.take_inbox(message),
                "s" => self.take_name(name, message),
                "d" => self.take_gone(message),
                _ => {}
            }
        } else {
            self.trace_rx(
                (message, None),
                (
                    if message.is_retained() {
                        ParcelVerdict::Retained
                    } else {
                        ParcelVerdict::OffTopic
                    },
                    None,
                ),
            );
        }

        message.settle();
    }

    // what reaches its inbox: each parcel of its connections, an ACCEPT or a REFUSE among them
    fn take_inbox(&mut self, message: &BrokerMessage) {
        match read_parcel(message.payload()) {
            ParcelRead::NoParcel(why) => {
                self.trace_rx((message, None), (ParcelVerdict::NoParcel, None));
                let error = reported(format!(
                    "a message to the inbox of {} is no parcel: {why}",
                    self.config.id
                ));

                self.config.report(&error);
            }
            ParcelRead::DoesNotRead(prefix, why) => {
                let pair = (prefix.opener, prefix.acceptor);

                if self.connections.contains_key(&pair) {
                    self.take_unread(pair, (prefix, why, message));
                } else {
                    self.trace_rx((message, Some(&prefix)), (ParcelVerdict::DoesNotRead, None));
                }
            }
            ParcelRead::Parcel(parcel) => {
                let pair = (parcel.opener, parcel.acceptor);

                if self.connections.contains_key(&pair) {
                    self.take_on(pair, (parcel, message));

                    return;
                }

                let verdict = if self.connects.contains_key(&parcel.opener)
                    && matches!(parcel.kind, kinds::ACCEPT | kinds::REFUSE)
                {
                    ParcelVerdict::Taken
                } else {
                    ParcelVerdict::PairNotHeld
                };

                self.trace_rx((message, Some(&parcel)), (verdict, None));

                match parcel.kind {
                    kinds::ACCEPT if parcel.layout == LAYOUT => {
                        if let Some(pending) = self.connects.remove(&parcel.opener) {
                            let opened = (pending.accept)(self, &parcel);

                            pending.settled.send(Ok(opened)).ok();
                        } else {
                            // * an ACCEPT of a connect that took another, ended or never was
                            // (spec 15.18)
                            self.reset_peer((parcel.id.as_deref().unwrap_or_default(), pair));
                        }
                    }
                    kinds::REFUSE => {
                        if let Some(pending) = self.connects.remove(&parcel.opener) {
                            let status = parcel.status.unwrap_or(503);
                            let reason =
                                crate::broker::parcel::refuse_reason_of(status).unwrap_or("busy");

                            pending
                                .settled
                                .send(Err(BrokerRefusedError::new({
                                    let mut refusal = BrokerRefusal::new(reason);

                                    refusal.status = Some(status);
                                    refusal.layouts = parcel.layouts;
                                    refusal
                                })
                                .connect_error()))
                                .ok();
                        }
                    }
                    // a parcel of a pair it does not hold matches nothing (spec 15.21)
                    _ => {}
                }
            }
        }
    }

    // what reaches a server's name: an OPEN, for the server transport serving it, or refused 503
    // when none does
    fn take_name(&mut self, name: &str, message: &BrokerMessage) {
        let server = locked(&self.config.names).get(name).and_then(Weak::upgrade);
        let read = read_parcel(message.payload());

        self.trace_read(message, &read);

        match server {
            Some(server) => server.take_open(self, (name, read)),
            None => {
                if let ParcelRead::Parcel(open) = read
                    && open.kind == kinds::OPEN
                {
                    crate::broker::server::refuse_open(self, (&open, 503));
                }
            }
        }
    }

    // a GONE to a peer's departure: each connection bound to the id and the incarnation it names
    // closed, unclean, never one bound to another (spec 15.21)
    fn take_gone(&mut self, message: &BrokerMessage) {
        let read = read_parcel(message.payload());

        self.trace_read(message, &read);

        let ParcelRead::Parcel(gone) = read else {
            return;
        };

        if gone.kind != kinds::GONE {
            return;
        }

        let bound: Vec<Pair> = self
            .connections
            .values()
            .filter(|connection| {
                Some(&connection.peer.id) == gone.id.as_ref()
                    && Some(connection.peer.incarnation) == gone.incarnation
            })
            .map(|connection| connection.pair)
            .collect();

        for pair in bound {
            self.drop_connection(pair);
        }
    }

    fn trace_read(&self, message: &BrokerMessage, read: &ParcelRead) {
        let (parcel, verdict) = match read {
            ParcelRead::NoParcel(_) => (None, ParcelVerdict::NoParcel),
            ParcelRead::DoesNotRead(prefix, _) => (Some(prefix), ParcelVerdict::DoesNotRead),
            ParcelRead::Parcel(parcel) => (
                Some(parcel),
                if is_advisory(parcel.kind) {
                    ParcelVerdict::Advisory
                } else {
                    ParcelVerdict::Taken
                },
            ),
        };

        self.trace_rx((message, parcel), (verdict, None));
    }

    // its link lost: each connection closed, unclean, each connect failed, then its link connected
    // again as another incarnation, and each peer it held a connection with reset; or taken over:
    // each connection closed alike, reported, and fenced
    fn link_down(&mut self, (down, participant): (BrokerDown, Weak<ParticipantInner>)) {
        let config = Arc::clone(&self.config);
        let ended = self.ordinals();

        // ! the stop current as it went down, which its reconnection captures: none under way
        let record = {
            let mut status = locked(&config.status);

            // * a stop under way ends the link itself
            if status.phase != Phase::Running || status.is_taken_over {
                return;
            }

            if !*config.live.borrow() {
                // * down as it connects: the attempt under way fails; taken over, none follows it
                status.is_down_as_it_links = true;

                if down.is_taken_over {
                    drop(status);
                    locked(&config.held_names).clear();
                    self.fence(ended);
                }

                return;
            }

            Arc::clone(&status.record)
        };

        config.live.send_replace(false);

        let peers: Vec<(String, Pair)> = self
            .connections
            .values()
            .map(|connection| (connection.peer.id.clone(), connection.pair))
            .collect();

        for (_, pair) in &peers {
            self.drop_connection(*pair);
        }

        let why = if down.is_taken_over {
            format!("{} as it connected", config.taken_over())
        } else {
            format!("the link of {} went down as it connected", config.id)
        };

        for (_, pending) in self.connects.drain() {
            pending
                .settled
                .send(Err(TransportError::Connect(ConnectError::new(why.clone()))))
                .ok();
        }

        self.departures.clear();
        config.departures.store(0, Ordering::SeqCst);

        for server in config.servers() {
            server.unlinked();
        }

        locked(&config.held_names).clear();

        // * taken over: it connects no more, its server's transports taking no OPEN and its
        // clients' connects failing, until its application starts it again (spec 15.21)
        if down.is_taken_over {
            self.fence(ended);

            return;
        }

        config.transition("down", ended);

        // * no reconnection: it stays down, said so, and the next start or connect links it anew
        if !config.reconnects {
            locked(&config.status).starting = None;
            config.report(&reported(format!("the link of {} went down", config.id)));

            return;
        }

        // * ended by its application's signal, by a takeover, or at once by its stop: a child of
        // the stop's record it captured, its application's signal joined
        let (fenced, watching) = joined(record.signal(), config.reconnect.signal.clone());
        let fenced = Arc::new(fenced);

        if let Some(watching) = watching {
            self.owner.cover(watching);
        }

        locked(&config.status).relinking = Some(Arc::clone(&fenced));
        self.owner
            .cover(relinking((participant, peers), (fenced, record)));
    }

    // its link taken over, reported once, its reconnection under way given up and its next start a
    // link anew
    fn fence(&self, ended: Option<Vec<u64>>) {
        {
            let mut status = locked(&self.config.status);

            if status.is_taken_over {
                return;
            }

            status.is_taken_over = true;
            status.starting = None;

            if let Some(relinking) = status.relinking.take() {
                relinking.cancel();
            }
        }

        self.config.transition("taken-over", ended);

        self.owner.offer(Box::new(|state: &mut Self| {
            let error = reported(state.config.taken_over());

            state.config.report(&error);
        }));
    }

    /// Stops: each connection closed with a CLOSE of 1001, handed to its adapter before its stop,
    /// what each CLOSE's publication settles to given back with its peer and its pair; each connect
    /// awaiting its answer failed, stopped as it connected.
    fn stopping(&mut self) -> Vec<Closing> {
        self.config.live.send_replace(false);

        let held: Vec<Pair> = self.connections.keys().copied().collect();
        let mut closing = Vec::new();

        for pair in held {
            let peer = self
                .connections
                .get(&pair)
                .map(|connection| connection.peer.id.clone());
            let mut close = Parcel::of(kinds::CLOSE);

            close.code = Some(codes::GOING_AWAY);

            if let (Some(peer), Some(handed)) = (peer, self.handed(pair, (close, None))) {
                closing.push((peer, pair, handed.published));
            }

            self.ended(pair, (false, None));
        }

        let why = self.config.stopped_as_it_connected();

        for (_, pending) in self.connects.drain() {
            pending
                .settled
                .send(Err(TransportError::Connect(ConnectError::new(why.clone()))))
                .ok();
        }

        closing
    }
}

/// What a link's failure fails a connect with, hoisted, never nested: a failure's message and its
/// source, or a misuse's words and the misuse its source, so that its kind is found.
pub(crate) fn connect_error_of(error: BrokerError) -> ConnectError {
    match error {
        BrokerError::Refused(misuse) => ConnectError::caused(misuse.to_string(), Arc::new(misuse)),
        BrokerError::Failed {
            message,
            source: Some(source),
        } => ConnectError::caused(message, source),
        BrokerError::Failed {
            message,
            source: None,
        } => ConnectError::new(message),
    }
}

// its link connected again as another incarnation, by its own reconnection; then a RESET to each
// peer it held a connection with. The stop `record` names ends it at once, in a wait or once its
// attempt under way failed, no wait told after it, the stop its cause (spec 15.21)
async fn relinking(
    (participant, peers): (Weak<ParticipantInner>, Vec<(String, Pair)>),
    (fenced, record): (Arc<CancellationToken>, Arc<StopRecord>),
) {
    // ! cancelled as it returns, which ends the watch of its application's signal
    let _ended = CancellationToken::clone(&fenced).drop_guard();
    let Some(inner) = participant.upgrade() else {
        return;
    };
    let config = Arc::clone(&inner.config);
    let mut options = config.reconnect.clone();

    // * without end unless its application bounds it
    options.maximum_attempts = Some(options.maximum_attempts.unwrap_or(u32::MAX));
    options.signal = Some(CancellationToken::clone(&fenced));

    // the attempts made, which its end's words count
    let mut attempts = 0_u32;
    let relinked = attempting((&config.clock, &options), |_signal| {
        let linking = participant.upgrade();
        let (record, ending) = (Arc::clone(&record), CancellationToken::clone(&fenced));

        attempts = attempts.saturating_add(1);

        async move {
            let Some(inner) = linking else {
                return Err(TransportError::Refused(ProgrammerError::new(
                    "the participant is gone",
                )));
            };

            link(&inner, &record).await.map_err(|error| {
                // ! its stop is marked before its signal is cancelled: an attempt that failed with
                // its stop come cancels it itself, so it ends at once, no wait told after it
                if record.is_marked() {
                    ending.cancel();
                }

                TransportError::Connect(connect_error_of(error))
            })
        }
    })
    .await
    .map_err(|ended| config.attributed((ended, &record)));

    {
        let mut status = locked(&config.status);

        // * ended: it stays down, and the next start or connect links it anew; what a stop or a
        // takeover let go of already, or a later link holds, is left as it is
        if status
            .relinking
            .as_ref()
            .is_some_and(|held| Arc::ptr_eq(held, &fenced))
        {
            status.relinking = None;

            if relinked.is_err() {
                status.starting = None;
            }
        }

        // taken over as it connected again: its fence reported it
        if status.is_taken_over {
            return;
        }
    }

    let cause = match relinked {
        Ok(()) => {
            inner
                .owner
                .offer(Box::new(move |state: &mut ParticipantState| {
                    for (peer, pair) in &peers {
                        state.reset_peer((peer, *pair));
                    }
                }));

            return;
        }
        Err(cause) => cause,
    };
    let message = if matches!(cause, TransportError::Reconnect(_)) {
        format!(
            "the link of {} went down, and {attempts} attempts did not bring it back",
            config.id
        )
    } else {
        format!(
            "the link of {} went down, and its reconnection ended: {cause}",
            config.id
        )
    };
    let ended = RouterError::Other(Arc::new(ReconnectionEnded { message, cause }));

    inner
        .owner
        .offer(Box::new(move |state: &mut ParticipantState| {
            state.config.report(&ended);
        }));
}

// in its turn's stead: its link connected, a new incarnation, its inbox and its names subscribed
// before anything goes, then each peer whose CLOSE its broker did not take as it last stopped reset;
// the stop `record` names, which the operation that links it captured, met as it connects fails it,
// stopped as it started, nothing of it going on
async fn link(inner: &Arc<ParticipantInner>, record: &Arc<StopRecord>) -> Result<(), BrokerError> {
    let config = &inner.config;
    // * checked as it begins, where a turn can pass since its caller's check: a stop either refuses
    // it here or waits its adapter's start out
    let under_way = UnderWay::of((config, record))?;
    let mut bytes = [0_u8; 16];

    getrandom::fill(&mut bytes)
        .map_err(|error| BrokerError::failed(format!("no incarnation was drawn: {error}")))?;

    let incarnation = u128::from_be_bytes(bytes);

    {
        let mut status = locked(&config.status);

        status.is_down_as_it_links = false;
        status.incarnation = incarnation;
    }

    // * its stop's signal to its start alone: a SUBSCRIBE given up by a signal retires its link with
    // no DISCONNECT, so its will would go; its adapter's stop ends that one cleanly
    let mut start = BrokerStart {
        signal: Some(record.signal().child_token()),
        ..BrokerStart::default()
    };

    if config
        .adapter
        .capabilities()
        .contains(BrokerCapabilities::WILL)
    {
        let mut gone = Parcel::of(kinds::GONE);

        gone.incarnation = Some(incarnation);
        gone.id = Some(config.id.clone());
        start.will = Some(BrokerPublication::new(
            config.departure_of(&config.id),
            write_parcel(&gone)?,
        ));
    }

    let started = config.adapter.start(start).await;

    drop(under_way);

    // ! stopped as it started: its inbox never subscribed, and its stop ends what that start
    // brought up; what its start failed with, its source
    if record.is_marked() {
        return Err(config.stopped_as_it_started(started.err()));
    }

    started?;

    // * a link keeps no session: what a former link held, its stop's or its loss's, is held no more
    locked(&config.held_names).clear();

    for server in config.servers() {
        server.unlinked();
    }

    let subscribed = config
        .adapter
        .subscribe(&config.inbox_of(&config.id), BrokerSubscription::default())
        .await;

    if record.is_marked() {
        return Err(config.stopped_as_it_started(subscribed.err()));
    }

    subscribed?;

    for server in config.servers() {
        server.relink().await?;
    }

    // ! a link that went down as it connected is none: this attempt fails, and the next links anew,
    // rather than call it up and miss its loss
    if locked(&config.status).is_down_as_it_links {
        return Err(BrokerError::failed(format!(
            "the link of {} went down as it connected",
            config.id
        )));
    }

    let record = Arc::clone(record);

    inner
        .owner
        .run(move |state| {
            let is_down = {
                let status = locked(&state.config.status);

                status.is_down_as_it_links || status.is_taken_over
            };

            // * never up once its stop is marked: its stop tells none after its stopped
            if record.is_marked() {
                return Err(state.config.stopped_as_it_started(None));
            }

            if is_down {
                return Err(BrokerError::failed(format!(
                    "the link of {} went down as it connected",
                    state.config.id
                )));
            }

            state.config.live.send_replace(true);
            state.config.transition("up", None);

            // * each peer whose CLOSE its broker did not take as it last stopped, reset once its
            // names are subscribed again (spec 15.21): one that let its pair go drops it in silence
            for (peer, pair) in core::mem::take(&mut state.unreset) {
                state.reset_peer((&peer, pair));
            }

            Ok(())
        })
        .await
        .map_err(|_gone| BrokerError::failed("the participant is gone"))?
}

// what its adapter hands it, each taken in its turn
struct Hearing {
    owner: WeakOwner<ParticipantState>,
    participant: Weak<ParticipantInner>,
}

impl BrokerListener for Hearing {
    fn on_message(&self, message: &BrokerMessage) {
        let message = message.clone();

        self.owner
            .offer(Box::new(move |state: &mut ParticipantState| {
                state.take(&message);
            }));
    }

    fn on_down(&self, down: BrokerDown) {
        let participant = Weak::clone(&self.participant);

        self.owner
            .offer(Box::new(move |state: &mut ParticipantState| {
                state.link_down((down, participant));
            }));
    }
}

pub(crate) struct ParticipantInner {
    pub(crate) config: Arc<Config>,
    pub(crate) owner: Owner<ParticipantState>,
    // what hears its adapter, let go of as it is disposed
    hearing: Arc<dyn BrokerListener>,
}

/// One link of a side to a broker (spec 15.16, 15.21), over its adapter.
///
/// A server's transport over it serves names, and each client's transport over it holds one
/// connection; both draw their connections through it, which numbers their parcels, cuts their
/// envelopes in parts, holds their heartbeat and ends them as its link ends.
#[derive(Clone)]
pub struct BrokerParticipant {
    pub(crate) inner: Arc<ParticipantInner>,
}

impl fmt::Debug for BrokerParticipant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerParticipant")
            .field("id", &self.inner.config.id)
            .finish_non_exhaustive()
    }
}

// a bound that is a whole number above 0
fn count_of((name, value): (&str, Option<u64>), default: u64) -> Result<u64, ProgrammerError> {
    match value {
        Some(0) => Err(ProgrammerError::new(format!(
            "{name} is a whole number above 0, not 0"
        ))),
        Some(value) => Ok(value),
        None => Ok(default),
    }
}

impl BrokerParticipant {
    /// A participant over `adapter`, not yet started.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for an adapter whose id is no token, a root that is none, an adapter
    /// that delivers at most once where at least once is required, an inbox that takes a parcel
    /// under 1,024 bytes, a bound out of its range, outside a tokio runtime, given none, or on one
    /// without its time driver.
    #[expect(
        clippy::too_many_lines,
        reason = "each option held and refused in the order the other sides hold them, then the participant built"
    )]
    pub fn new(
        adapter: Arc<dyn BrokerAdapter>,
        options: &BrokerParticipantOptions,
    ) -> Result<Self, ProgrammerError> {
        let id = adapter.id().to_owned();
        let root = options.root.clone().unwrap_or_else(|| ROOT.to_owned());

        if !is_token(&id) {
            return Err(ProgrammerError::new(format!(
                "a participant's id is a token of base64url's alphabet, 1 to 64 characters, not \"{id}\""
            )));
        }

        if !is_token(&root) {
            return Err(ProgrammerError::new(format!(
                "a participant's root is a token of base64url's alphabet, 1 to 64 characters, not \"{root}\""
            )));
        }

        if options.require_delivery == Some(BrokerDelivery::AtLeastOnce)
            && adapter.delivery() == BrokerDelivery::AtMostOnce
        {
            return Err(ProgrammerError::new(format!(
                "its application requires delivery at least once, and the adapter of {id} gives it at most once"
            )));
        }

        let held_bytes_budget = count_of(
            ("heldBytesBudget", options.held_bytes_budget),
            HELD_BYTES_BUDGET,
        )?;
        let maximum_envelope_parts_bytes = count_of(
            (
                "maximumEnvelopePartsBytes",
                options.maximum_envelope_parts_bytes,
            ),
            MAXIMUM_ENVELOPE_PARTS_BYTES,
        )?;
        let minimum_body_bytes_per_second = count_of(
            (
                "minimumBodyBytesPerSecond",
                options.minimum_body_bytes_per_second,
            ),
            MINIMUM_BODY_BYTES_PER_SECOND,
        )?;

        if options.maximum_held_envelope_bytes == Some(0) {
            return Err(ProgrammerError::new(
                "maximumHeldEnvelopeBytes is a whole number above 0, not 0",
            ));
        }

        let heartbeat = hold("a heartbeat", options.heartbeat.unwrap_or(HEARTBEAT))?;
        let body_grace_period = hold_finite(
            "bodyGracePeriod",
            options.body_grace_period.unwrap_or(BODY_GRACE_PERIOD),
        )?;
        let reconnect = options.reconnect.clone().unwrap_or_default();

        // * a fixed delay held as it is given, whether or not it reconnects (spec 1.4)
        hold_reconnection(&reconnect)?;

        let inbox = vec![root.clone(), "i".to_owned(), id.clone()];
        // * asked by its inbox's topic, which a broker that counts a packet's every byte needs
        let receive_bound = adapter.receive_bound(&inbox).min(LARGEST_BOUND);

        if receive_bound < LEAST_BOUND {
            return Err(ProgrammerError::new(format!(
                "a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of {id} takes {receive_bound}"
            )));
        }

        let runtime =
            crate::platform::runtime_of(options.runtime.as_ref(), "a broker's participant")?;
        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform));
        let config = Arc::new(Config {
            adapter,
            id,
            root,
            parts_bounds: Arc::new(PartsBounds {
                maximum_envelope_parts_bytes,
                minimum_body_bytes_per_second,
                body_grace_period,
                budget: Arc::new(Budget::new(held_bytes_budget)),
                clock: Arc::clone(&clock),
            }),
            clock: Arc::clone(&clock),
            given: options.clock.clone(),
            platform,
            heartbeat,
            receive_bound,
            maximum_held_envelope_bytes: options.maximum_held_envelope_bytes,
            reconnect,
            reconnects: options.reconnects.unwrap_or(true),
            status: Mutex::new(Status {
                incarnation: 0,
                phase: Phase::Running,
                record: Arc::default(),
                stopped: None,
                disposed: None,
                is_taken_over: false,
                is_down_as_it_links: false,
                starting: None,
                relinking: None,
            }),
            under_way: watch::Sender::new(0),
            live: watch::Sender::new(false),
            counted: Mutex::new(HashMap::new()),
            departures: AtomicU64::new(0),
            names: Mutex::new(HashMap::new()),
            servers: Mutex::new(Vec::new()),
            listeners: Listeners::default(),
            debug_listeners: Listeners::default(),
            held_names: Mutex::default(),
        });
        let held_config = Arc::clone(&config);
        let owner = Owner::spawn((&runtime, &clock), move |owner| ParticipantState {
            config: held_config,
            owner,
            connections: HashMap::new(),
            connects: HashMap::new(),
            departures: HashMap::new(),
            serial: 0,
            unreset: Vec::new(),
        });
        let inner = Arc::new_cyclic(|participant: &Weak<ParticipantInner>| {
            let hearing: Arc<dyn BrokerListener> = Arc::new(Hearing {
                owner: owner.downgrade(),
                participant: Weak::clone(participant),
            });

            ParticipantInner {
                config,
                owner,
                hearing,
            }
        });

        inner.config.adapter.listen(Arc::clone(&inner.hearing));

        Ok(Self { inner })
    }

    /// The identity its broker authenticates its link by: its adapter's.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.inner.config.id
    }

    /// The first token of each of its topics.
    #[must_use]
    pub fn root(&self) -> &str {
        &self.inner.config.root
    }

    /// Its adapter.
    #[must_use]
    pub fn adapter(&self) -> Arc<dyn BrokerAdapter> {
        Arc::clone(&self.inner.config.adapter)
    }

    /// What its stack runs on: the clock its options gave, the platform's when none.
    #[must_use]
    pub fn clock(&self) -> SharedClock {
        Arc::clone(&self.inner.config.clock)
    }

    /// Whether its link is up: started, and not lost since, or connected again.
    #[must_use]
    pub fn is_linked(&self) -> bool {
        self.inner.config.is_linked()
    }

    /// Whether somebody watches its trace of parcels (debugging 13.10).
    #[must_use]
    pub fn is_debugging(&self) -> bool {
        !self.inner.config.debug_listeners.is_empty()
    }

    /// Hears each parcel's verdict, completed link transition, held name and report; the id given
    /// takes it off again, with [`BrokerParticipant::off`].
    pub fn on_debug(&self, listener: ParticipantDebugListener) -> ListenerId {
        self.inner.config.debug_listeners.add(listener)
    }

    /// The names acknowledged held on this link, read by pull (debugging 13.8).
    #[must_use]
    pub fn names(&self) -> BTreeSet<String> {
        locked(&self.inner.config.held_names).clone()
    }

    /// Its logical inbox's topic tokens, read by pull.
    #[must_use]
    pub fn inbox(&self) -> Vec<String> {
        self.inner.config.inbox_of(self.id())
    }

    /// Hears what it reports of its own: a message to it that is no parcel, which it drops, its link
    /// given up on, or its link taken over; the id given takes it off again, with
    /// [`BrokerParticipant::off`].
    pub fn on_error(&self, listener: ParticipantErrorListener) -> ListenerId {
        self.inner.config.listeners.add(listener)
    }

    /// Hears no more with the listener `listener` names, its trace's or its reports': one taken
    /// off already, or of another part, changes nothing.
    pub fn off(&self, listener: ListenerId) {
        let config = &self.inner.config;

        config.debug_listeners.off(listener);
        config.listeners.off(listener);
    }

    /// What it holds: `connections`, those of its transports open, and `halfOpen`, those whose third
    /// leg has not come; `partsBytes`, what it holds in parts, and `unsentBytes`, what waits for its
    /// broker, with the largest of each one connection holds; `departures`, the peers' departures
    /// it subscribes.
    #[must_use]
    pub fn gauges(&self) -> Gauges {
        let config = &self.inner.config;
        let held: Vec<Arc<Counters>> = locked(&config.counted).values().cloned().collect();
        let mut gauges = Gauges::default();
        let open = held
            .iter()
            .filter(|counters| counters.is_open.load(Ordering::SeqCst))
            .count();
        let largest_parts = held
            .iter()
            .map(|counters| counters.parts.load(Ordering::SeqCst))
            .max()
            .unwrap_or(0);
        let largest_unsent = held
            .iter()
            .map(|counters| counters.unsent.load(Ordering::SeqCst))
            .max()
            .unwrap_or(0);
        let unsent = held
            .iter()
            .map(|counters| counters.unsent.load(Ordering::SeqCst))
            .fold(0_u64, u64::saturating_add);

        gauges
            .counts
            .insert("connections", u64::try_from(open).unwrap_or(u64::MAX));
        gauges
            .counts
            .insert("departures", config.departures.load(Ordering::SeqCst));
        gauges.counts.insert(
            "halfOpen",
            u64::try_from(held.len().saturating_sub(open)).unwrap_or(u64::MAX),
        );
        gauges.counts.insert("largestPartsBytes", largest_parts);
        gauges.counts.insert("largestUnsentBytes", largest_unsent);
        gauges
            .counts
            .insert("partsBytes", config.parts_bounds.budget.held());
        gauges.counts.insert("unsentBytes", unsent);
        gauges.ceilings.insert(
            "largestPartsBytes",
            config.parts_bounds.maximum_envelope_parts_bytes,
        );
        gauges
            .ceilings
            .insert("partsBytes", config.parts_bounds.budget.budget());

        gauges
    }

    /// A server transport over it, serving its options' names.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a name another of its server transports serves, or for options it
    /// refuses.
    pub fn server(
        &self,
        options: &BrokerTransportServerOptions,
    ) -> Result<BrokerTransportServer, ProgrammerError> {
        BrokerTransportServer::new(self, options)
    }

    /// A client transport over it, of one connection at a time.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for options it refuses.
    pub fn client(
        &self,
        options: &BrokerTransportClientOptions,
    ) -> Result<BrokerTransportClient, ProgrammerError> {
        BrokerTransportClient::new(self, options)
    }

    /// Holds `names` for `server`, each served by one server transport of it alone.
    pub(crate) fn reserve(
        &self,
        (names, server): (&[String], &Arc<ServerInner>),
    ) -> Result<(), ProgrammerError> {
        let mut held = locked(&self.inner.config.names);

        for name in names {
            if held.get(name).is_some_and(|other| other.strong_count() > 0) {
                return Err(ProgrammerError::new(format!(
                    "the name {name} is served already by a server transport of this participant"
                )));
            }
        }

        for name in names {
            held.insert(name.clone(), Arc::downgrade(server));
        }

        drop(held);
        locked(&self.inner.config.servers).push(Arc::downgrade(server));

        Ok(())
    }

    /// Starts its link: its incarnation drawn, its adapter started, its will set where it offers
    /// one, its inbox subscribed and the names of its server transports that serve; settles once
    /// all of it is held. A second start shares the first, or starts anew once the first failed,
    /// once its link went down and stays down, once its link was taken over, its application's
    /// start lifting the fence a takeover set, or once its stop settled: another incarnation, its
    /// transports kept (spec 15.21).
    ///
    /// # Errors
    ///
    /// A [`BrokerError::Refused`] while its stop is under way, or once it is disposed, refused
    /// before anything moves (spec 15.21). A [`BrokerError::Failed`] for a link that failed, what
    /// failed it its source where it knows, its stop met as it started among them.
    pub fn start(&self) -> BoxFuture<Result<(), BrokerError>> {
        self.starting(None)
    }

    // its start; for a connect, given the stop's record it captured, failed once that stop came,
    // so that a connect a stop overtook links nothing after it
    fn starting(&self, captured: Option<&StopRecord>) -> BoxFuture<Result<(), BrokerError>> {
        let starting = {
            let config = &self.inner.config;
            let mut status = locked(&config.status);
            let refused = match status.phase {
                Phase::Disposed => Some(BrokerError::from(config.disposed_refusal())),
                Phase::Stopping => Some(BrokerError::from(config.stopping_refusal())),
                Phase::Running => captured
                    .filter(|captured| captured.is_marked())
                    .map(|_| config.stopped_as_it_started(None)),
            };

            if let Some(refused) = refused {
                return Box::pin(async move { Err(refused) });
            }

            status.is_taken_over = false;

            match &status.starting {
                Some(starting) if !starting.is_failed() => Arc::clone(starting),
                _ => {
                    let starting = Arc::new(Starting {
                        outcome: watch::Sender::new(None),
                    });
                    let reply = Arc::clone(&starting);
                    let inner = Arc::clone(&self.inner);
                    let record = Arc::clone(&status.record);

                    // * a link starts: the last stop is shared no more, and a stop called from
                    // now on stops this link
                    status.stopped = None;
                    status.starting = Some(Arc::clone(&starting));
                    drop(status);
                    self.inner.owner.cover(async move {
                        let linked = link(&inner, &record).await;

                        reply.outcome.send_replace(Some(linked));
                    });

                    starting
                }
            }
        };

        starting.wait()
    }

    /// Settles once its link is up, started or connected again; its signal ends the wait. The stop
    /// `record` names, the one current as its connect was called, fails it at once, stopped as it
    /// connected, whether it awaits its link or its start, before its takeover is read; its link
    /// taken over, it fails at once naming it: a connect never lifts the fence, which its
    /// application's start alone does. A failure its link meets, its adapter's misuse among them,
    /// fails the connect, which another attempt may mend.
    pub(crate) async fn linked(
        &self,
        (record, signal): (Arc<StopRecord>, Option<CancellationToken>),
    ) -> Result<(), TransportError> {
        let config = &self.inner.config;
        let stopped = || {
            TransportError::Connect(ConnectError::new(
                self.inner.config.stopped_as_it_connected(),
            ))
        };

        // * the stop first: a connect it overtook fails, never the misuse a call made once disposed
        // is, nor the takeover's words
        if record.is_marked() {
            return Err(stopped());
        }

        if locked(&config.status).is_taken_over {
            return Err(TransportError::Connect(ConnectError::new(format!(
                "{}, and connects no more until it is started again",
                config.taken_over()
            ))));
        }

        let started = self.starting(Some(&record));
        let captured = Arc::clone(&record);
        let config = Arc::clone(config);
        let mut live = config.live.subscribe();
        let waiting = async move {
            started.await.map_err(|error| {
                // ! its stop met as it linked, the stop's own refusal racing this check among it:
                // stopped as it connected, hoisted, what its adapter failed with its source, and
                // the stop's misuse never carried as a link's failure
                if captured.is_marked() {
                    let message = config.stopped_as_it_connected();

                    return TransportError::Connect(match error {
                        BrokerError::Failed {
                            source: Some(source),
                            ..
                        } => ConnectError::caused(message, source),
                        BrokerError::Failed { .. } | BrokerError::Refused(_) => {
                            ConnectError::new(message)
                        }
                    });
                }

                TransportError::Connect(connect_error_of(error))
            })?;
            live.wait_for(|is_live| *is_live)
                .await
                .map(|_live| ())
                .map_err(|_gone| {
                    TransportError::Connect(ConnectError::new("the participant is gone"))
                })
        };
        let mut waiting = core::pin::pin!(waiting);
        // * its stop at once, its link's own end awaited by the stop alone (spec 15.21)
        let mut stopping = core::pin::pin!(record.signal().cancelled());
        let mut cancelled = core::pin::pin!(async move {
            match signal {
                Some(signal) => signal.cancelled_owned().await,
                None => core::future::pending().await,
            }
        });

        core::future::poll_fn(|context| {
            if let core::task::Poll::Ready(linked) = waiting.as_mut().poll(context) {
                return core::task::Poll::Ready(linked);
            }

            if stopping.as_mut().poll(context).is_ready() {
                return core::task::Poll::Ready(Err(stopped()));
            }

            cancelled
                .as_mut()
                .poll(context)
                .map(|()| Err(TransportError::cancelled("the connect was cancelled")))
        })
        .await
    }

    /// Ends its link in place, and with it what is under way as it is called (spec 15.21): gives up
    /// its link's start under way and awaits it, closes each connection with a CLOSE of 1001, then
    /// stops its adapter, which sends those CLOSEs before it ends the link, so its broker publishes
    /// no will of a link it held; a connect awaiting its link or its answer fails, stopped as it
    /// connected, and a reconnection, its own or a client's, ends at once, the stop its cause. Once
    /// it settled, its start, a server's start over it, or a client's connect or reconnection over
    /// it links it anew as another incarnation, its transports kept, and resets each peer whose
    /// CLOSE its broker did not take. A stop called again before its next link's start settles
    /// with the first, and tells nothing; a participant no longer in use is disposed.
    pub fn stop(&self) -> BoxFuture<()> {
        let config = &self.inner.config;
        let (record, told, relinking) = {
            let mut status = locked(&config.status);

            // * a stop under way, or one settled with no link started since: this one settles
            // with it
            if let Some(stopped) = &status.stopped {
                let mut stopped = stopped.clone();

                return Box::pin(async move {
                    stopped.wait_for(|is_ended| *is_ended).await.ok();
                });
            }

            let record = Arc::clone(&status.record);
            let (told, stopped) = watch::channel(false);

            record.mark();

            if status.phase == Phase::Running {
                status.phase = Phase::Stopping;
            }

            // ! a start shared no more: a link up before the stop is the next start's to make anew
            status.starting = None;
            status.stopped = Some(stopped);

            (record, told, status.relinking.take())
        };

        // * right after its mark: its adapter's start under way gives up, and each reconnection
        // and each connect awaiting its link ends at once
        record.signal().cancel();

        if let Some(relinking) = relinking {
            relinking.cancel();
        }

        let mut ended = told.subscribe();
        // ! read once its stop is marked: a start counted before it is waited out, and none is
        // counted after it
        let mut under_way = config.under_way.subscribe();
        let closing = self.inner.owner.run(|state| {
            let ended = state.ordinals();
            let closing = state.stopping();

            (ended, closing)
        });
        let adapter = Arc::clone(&config.adapter);
        let inner = Arc::clone(&self.inner);
        let ending = Ended {
            config: Arc::clone(config),
            told,
        };

        self.inner.owner.cover(async move {
            let (ended, closing) = closing.await.unwrap_or_default();

            // * its adapter's start under way, given up, settles before its stop: the two never
            // overlap, and what that start brought up after the stop ends with it
            under_way.wait_for(|count| *count == 0).await.ok();
            // * its stop sends what it was handed before it, each CLOSE among it, within a bound of
            // its own, and fails what has not gone by then (spec 15.24)
            adapter.stop().await;

            let mut unreset = Vec::new();

            for (peer, pair, published) in closing {
                if !matches!(published.await, Ok(BrokerPublished::Taken)) {
                    unreset.push((peer, pair));
                }
            }

            inner
                .owner
                .run(move |state| {
                    locked(&state.config.held_names).clear();

                    // ! an OPEN its link took as it ended, after its CLOSEs went, holds a connection
                    // on a link ended: dropped, unclean, a half-open one telling nothing
                    let held: Vec<Pair> = state.connections.keys().copied().collect();

                    for pair in held {
                        state.drop_connection(pair);
                    }

                    // * its server transports kept, their names wanted and held no more
                    for server in state.config.servers() {
                        server.unlinked();
                    }

                    state.unreset.extend(unreset);

                    if !locked(&state.config.status).is_taken_over {
                        state.config.transition("stopped", ended);
                    }
                })
                .await
                .ok();
            drop(ending);
        });

        Box::pin(async move {
            ended.wait_for(|is_ended| *is_ended).await.ok();
        })
    }

    /// Stops it, then ends it for good (spec 15.21): its listener on its adapter let go of, its
    /// adapter the application's to dispose. Its start, and a client's connect or reconnection or a
    /// server's start over it, made after it, is its application's misuse, refused before anything
    /// moves; a stop or a dispose after it settles with it.
    pub fn dispose(&self) -> BoxFuture<()> {
        let config = &self.inner.config;
        let (record, told) = {
            let mut status = locked(&config.status);

            if let Some(disposed) = &status.disposed {
                let mut disposed = disposed.clone();

                return Box::pin(async move {
                    disposed.wait_for(|is_disposed| *is_disposed).await.ok();
                });
            }

            let (told, disposed) = watch::channel(false);
            let record = Arc::clone(&status.record);

            // ! what is under way as it is called ends with it, though a stop settled before it
            record.mark();
            status.phase = Phase::Disposed;
            status.disposed = Some(disposed);
            drop(status);

            (record, told)
        };

        record.signal().cancel();

        let mut disposed = told.subscribe();
        let stopping = self.stop();
        let adapter = Arc::clone(&config.adapter);
        let hearing = Arc::clone(&self.inner.hearing);

        // * in a task of its own: its future only waits, and dropping it lets go of nothing less
        self.inner.owner.cover(async move {
            stopping.await;
            adapter.unlisten(&hearing);
            told.send_replace(true);
        });

        Box::pin(async move {
            disposed.wait_for(|is_disposed| *is_disposed).await.ok();
        })
    }

    /// Its incarnation, drawn as its link last connected.
    #[must_use]
    pub fn incarnation(&self) -> u128 {
        self.inner.config.incarnation()
    }

    /// Whether it is disposed: a call made since is its application's misuse.
    pub(crate) fn is_disposed(&self) -> bool {
        self.inner.config.is_disposed()
    }

    /// A half drawn in its turn, as a connect draws one.
    #[cfg(test)]
    pub(crate) async fn draw_half(&self) -> Option<u64> {
        self.inner
            .owner
            .run(|state| state.draw_half())
            .await
            .ok()
            .flatten()
    }

    /// Runs `job` in its turn, behind every job queued, and gives what it gives.
    pub(crate) fn run<T: Send + 'static, J: FnOnce(&mut ParticipantState) -> T + Send + 'static>(
        &self,
        job: J,
    ) -> crate::owner::Pending<T> {
        self.inner.owner.run(job)
    }

    /// What each connection holds for its router, paused, and whether its peer's CLOSE waits behind
    /// it, in the order the connections were made, as a test reads it.
    #[cfg(test)]
    pub(crate) async fn held(&self) -> Vec<(usize, bool)> {
        let held = self.run(|state: &mut ParticipantState| {
            let mut held: Vec<(u64, usize, bool)> = state
                .connections
                .values()
                .map(|connection| {
                    (
                        connection.serial,
                        connection.held.len(),
                        connection.closing.is_some(),
                    )
                })
                .collect();

            held.sort_unstable();
            held.into_iter()
                .map(|(_, count, is_closing)| (count, is_closing))
                .collect()
        });

        held.await.unwrap_or_default()
    }

    /// Posts `job`, in its turn, after what came before it.
    pub(crate) fn post<J: FnOnce(&mut ParticipantState) + Send + 'static>(&self, job: J) {
        self.inner.owner.offer(Box::new(job));
    }

    /// Spawns `future`, counted as the participant's work while it can run.
    pub(crate) fn cover<F: core::future::Future<Output = ()> + Send + 'static>(&self, future: F) {
        self.inner.owner.cover(future);
    }

    /// What it keeps beside its owner.
    pub(crate) fn config(&self) -> &Arc<Config> {
        &self.inner.config
    }
}
