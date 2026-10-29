//! A broker in memory, in the core (spec 15.24): what its adapters link to, a participant over
//! each, in one process. It offers every capability — groups, wills, publications refused when no
//! subscriber takes them, a message's life — and hands each message on copied as it is published,
//! whole, in a later turn than its publish, in the order its publisher published it to that topic,
//! once; or, as a test asks, again, behind the next, never, or to another member of its group. It
//! holds a queue for each subscriber, bounded as it is given, past which it drops a message, and
//! publishes a link's will as the link is lost or taken over, never at a stop. Its handles' type is
//! `BROKER`, and it never leaves the process, so its legs are secure.

use core::fmt;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use tokio::runtime::Handle;

use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerMessageOptions, BrokerPublication, BrokerPublished, BrokerStart,
    BrokerSubscription,
};
use crate::broker::parcel::LARGEST_BOUND;
use crate::clock::{SharedClock, SystemClock};
use crate::errors::ProgrammerError;
use crate::owner::{Owner, WeakOwner};
use crate::router::types::BoxFuture;
use crate::transport::Listeners;

/// The type an in-memory broker's connections' handles name.
pub const TRANSPORT_BROKER: &str = "BROKER";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How an in-memory broker is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryBrokerOptions {
    /// What a message's life runs on; the platform's clock when none.
    pub clock: Option<SharedClock>,
    /// The runtime its turns run on: the current one when none.
    pub runtime: Option<Handle>,
    /// What every adapter gives but one given its own: at least once when none.
    pub delivery: Option<BrokerDelivery>,
    /// The largest payload a message carries, a publication past it refused; none when none.
    pub maximum_message_bytes: Option<u64>,
    /// The messages it holds for each subscriber, published to it and not yet handed on, past which
    /// it drops the one published, as a broker whose queue is full does; none when none.
    pub maximum_queued_messages: Option<u64>,
}

/// Who an in-memory broker's adapter is, and what it offers.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MemoryBrokerAdapterOptions {
    /// The identity its link is taken by, as a broker takes any name; its participant refuses one
    /// that is no token.
    pub id: String,
    /// What it offers of the optional capabilities: every one when none.
    pub capabilities: Option<BrokerCapabilities>,
    /// What it gives: its broker's when none.
    pub delivery: Option<BrokerDelivery>,
}

impl MemoryBrokerAdapterOptions {
    /// An adapter of `id`, offering every capability, giving its broker's delivery.
    #[must_use]
    pub fn of<I: Into<String>>(id: I) -> Self {
        Self {
            id: id.into(),
            capabilities: None,
            delivery: None,
        }
    }
}

/// What befalls the next message published, as a test asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum MemoryBrokerFault {
    /// Copied: it is handed on twice.
    Copy,
    /// Held behind the one after it on its topic: the next one published to that topic is handed
    /// on first.
    Hold,
    /// Dropped: it is handed on to none.
    Drop,
    /// Handed again to another member of its group, as a broker whose member's session ended
    /// unacknowledged does (MQTT 5 §4.8.2).
    Redeliver,
}

/// Which message a fault befalls.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MemoryBrokerFaultOptions {
    /// The topic of the next message it befalls; the next published to any when none.
    pub topic: Option<Vec<String>>,
}

// a message on its way to one link, copied as it was published, and when its life ends
#[derive(Clone)]
struct Routed {
    publication: BrokerPublication,
    is_retained: bool,
    expires: Option<SystemTime>,
}

// one adapter's link, as its broker holds it
struct Link {
    adapter: Weak<AdapterInner>,
    is_linked: bool,
    // its subscriptions, by a topic's key, each with its group or none
    subscriptions: HashMap<String, Option<String>>,
    // what its broker routed to it and has not handed on yet, in order
    queue: VecDeque<Routed>,
    will: Option<BrokerPublication>,
}

struct BrokerState {
    owner: WeakOwner<Self>,
    clock: SharedClock,
    maximum_queued_messages: Option<u64>,
    // each adapter's link, in the order the adapters were made
    links: Vec<Link>,
    // by a topic and its group, the member the next message goes to
    turns: HashMap<(String, String), usize>,
    // what befalls the next messages, each with the topic it waits for, or none for any
    faults: Vec<(Option<String>, MemoryBrokerFault)>,
    // by a topic, the message held behind the next one
    held: HashMap<String, Routed>,
}

struct BrokerInner {
    owner: Owner<BrokerState>,
    clock: SharedClock,
    delivery: BrokerDelivery,
    maximum_message_bytes: Option<u64>,
    // the adapters' ids, each one's index its place among them
    ids: Mutex<Vec<String>>,
}

/// A broker in memory (spec 15.24), each adapter a participant's link.
#[derive(Clone)]
pub struct MemoryBroker {
    inner: Arc<BrokerInner>,
}

impl fmt::Debug for MemoryBroker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryBroker")
            .finish_non_exhaustive()
    }
}

/// A topic's key, its tokens joined: what the broker matches a subscription by.
fn key_of(topic: &[String]) -> String {
    topic.join("/")
}

impl BrokerState {
    fn is_alive(&self, expires: Option<SystemTime>) -> bool {
        expires.is_none_or(|end| self.clock.wall() < end)
    }

    // the subscription a linked link holds to a topic's key, its group or none, or none at all
    fn subscription_of(&self, (index, topic): (usize, &str)) -> Option<&Option<String>> {
        self.links
            .get(index)
            .filter(|link| link.is_linked)
            .and_then(|link| link.subscriptions.get(topic))
    }

    // the member of a group whose turn it is
    fn member_of(&self, (topic, group): (&str, &str)) -> Option<usize> {
        let members: Vec<usize> = (0..self.links.len())
            .filter(|index| {
                self.subscription_of((*index, topic))
                    .is_some_and(|held| held.as_deref() == Some(group))
            })
            .collect();
        let turn = self
            .turns
            .get(&(topic.to_owned(), group.to_owned()))
            .copied()
            .unwrap_or(0);

        members.get(turn.checked_rem(members.len())?).copied()
    }

    // each subscription a message to a topic goes to: every one held alone, and, of each group, its
    // member in turn
    fn targets_of(&mut self, topic: &str) -> Vec<(usize, Option<String>)> {
        let mut targets = Vec::new();
        let mut groups = BTreeSet::new();

        for index in 0..self.links.len() {
            match self.subscription_of((index, topic)) {
                Some(Some(group)) => {
                    groups.insert(group.clone());
                }
                Some(None) => targets.push((index, None)),
                None => {}
            }
        }

        for group in groups {
            if let Some(member) = self.member_of((topic, &group)) {
                let turn = self
                    .turns
                    .entry((topic.to_owned(), group.clone()))
                    .or_insert(0);

                *turn = turn.saturating_add(1);
                targets.push((member, Some(group)));
            }
        }

        targets
    }

    // a message routed to a link, queued and handed on in a later turn, or dropped past its queue's
    // bound
    fn enqueue(&mut self, (index, routed): (usize, Routed)) {
        let bound = self.maximum_queued_messages;
        let Some(link) = self.links.get_mut(index) else {
            return;
        };

        if bound.is_some_and(|bound| u64::try_from(link.queue.len()).unwrap_or(u64::MAX) >= bound) {
            return;
        }

        link.queue.push_back(routed);
        self.owner
            .offer_behind(Box::new(move |state: &mut Self| state.hand_one(index)));
    }

    // a publication routed to each subscription that matches its topic — each alone, and one member
    // of each group, in turn — as the fault asked of it says; false when no subscription took it
    fn route(
        &mut self,
        (publication, is_retained): (BrokerPublication, bool),
        expires: Option<SystemTime>,
    ) -> bool {
        let topic = key_of(&publication.topic);
        let targets = self.targets_of(&topic);

        if targets.is_empty() {
            return false;
        }

        let fault = self
            .faults
            .iter()
            .position(|(asked, _)| asked.as_ref().is_none_or(|asked| *asked == topic))
            .map(|at| self.faults.remove(at).1);

        if fault == Some(MemoryBrokerFault::Drop) {
            return true;
        }

        let routed = Routed {
            publication,
            is_retained,
            expires,
        };

        if fault == Some(MemoryBrokerFault::Hold) {
            self.held.insert(topic, routed);

            return true;
        }

        for (index, group) in targets {
            self.enqueue((index, routed.clone()));

            if fault == Some(MemoryBrokerFault::Copy) {
                self.enqueue((index, routed.clone()));
            }

            // * again to another member of its group: the next in turn
            if fault == Some(MemoryBrokerFault::Redeliver)
                && let Some(group) = group
                && let Some(other) = self.member_of((&topic, &group))
                && other != index
            {
                self.enqueue((other, routed.clone()));
            }
        }

        // what was held behind this one, handed on after it
        if let Some(held) = self.held.remove(&topic) {
            for (index, _) in self.targets_of(&topic) {
                self.enqueue((
                    index,
                    Routed {
                        is_retained: false,
                        ..held.clone()
                    },
                ));
            }
        }

        true
    }

    // the next message queued for a link, handed on while its link stands and its life lasts, its
    // acknowledgement counted until given, at least once
    fn hand_one(&mut self, index: usize) {
        let next = self.links.get_mut(index).and_then(|link| {
            let next = link.queue.pop_front()?;

            link.is_linked.then_some(next).zip(link.adapter.upgrade())
        });
        let Some((next, adapter)) = next else {
            return;
        };

        if !self.is_alive(next.expires) {
            return;
        }

        let is_counted = adapter.delivery == BrokerDelivery::AtLeastOnce;
        let epoch = adapter.epoch.load(Ordering::SeqCst);

        if is_counted {
            adapter.unsettled.fetch_add(1, Ordering::SeqCst);
        }

        let settling = Arc::downgrade(&adapter);
        let options = BrokerMessageOptions {
            is_retained: Some(next.is_retained),
            settle: Some(Arc::new(move || {
                if let Some(adapter) = settling.upgrade()
                    && is_counted
                    && adapter.epoch.load(Ordering::SeqCst) == epoch
                {
                    adapter
                        .unsettled
                        .try_update(Ordering::SeqCst, Ordering::SeqCst, |unsettled| {
                            Some(unsettled.saturating_sub(1))
                        })
                        .ok();
                }
            })),
        };
        let message = BrokerMessage::new(next.publication, options);

        adapter.listeners.each((
            |listener: &(dyn BrokerListener + 'static)| listener.on_message(&message),
            |_panicked| {},
        ));
    }

    // a link lost or taken over, its will published, its down told
    fn lost(&mut self, (index, down): (usize, BrokerDown)) {
        let Some(link) = self.links.get_mut(index) else {
            return;
        };

        if !link.is_linked {
            return;
        }

        link.is_linked = false;
        link.subscriptions.clear();
        link.queue.clear();

        let will = link.will.take();
        let adapter = link.adapter.upgrade();

        if let Some(adapter) = &adapter {
            adapter.unlinked();
        }

        if let Some(will) = will {
            self.route((will, false), None);
        }

        if let Some(adapter) = adapter {
            adapter.listeners.each((
                |listener: &(dyn BrokerListener + 'static)| listener.on_down(down),
                |_panicked| {},
            ));
        }
    }
}

impl MemoryBroker {
    /// A broker, holding no link yet.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, on one without its time driver,
    /// or for a bound under 1.
    pub fn new(options: &MemoryBrokerOptions) -> Result<Self, ProgrammerError> {
        for (name, bound) in [
            ("maximumMessageBytes", options.maximum_message_bytes),
            ("maximumQueuedMessages", options.maximum_queued_messages),
        ] {
            if bound == Some(0) {
                return Err(ProgrammerError::new(format!(
                    "{name} is a whole number above 0, not 0"
                )));
            }
        }

        let runtime = crate::platform::runtime_of(options.runtime.as_ref(), "an in-memory broker")?;
        let clock: SharedClock = match &options.clock {
            Some(clock) => Arc::clone(clock),
            None => Arc::new(SystemClock::new(runtime.clone())),
        };
        let maximum_queued_messages = options.maximum_queued_messages;
        let owner = Owner::spawn((&runtime, &clock), |owner| BrokerState {
            owner,
            clock: Arc::clone(&clock),
            maximum_queued_messages,
            links: Vec::new(),
            turns: HashMap::new(),
            faults: Vec::new(),
            held: HashMap::new(),
        });

        Ok(Self {
            inner: Arc::new(BrokerInner {
                owner,
                clock,
                delivery: options.delivery.unwrap_or(BrokerDelivery::AtLeastOnce),
                maximum_message_bytes: options.maximum_message_bytes,
                ids: Mutex::new(Vec::new()),
            }),
        })
    }

    /// An adapter of the broker, its link known by its id.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a second adapter of one id.
    pub fn adapter(
        &self,
        options: &MemoryBrokerAdapterOptions,
    ) -> Result<MemoryBrokerAdapter, ProgrammerError> {
        let index = {
            let mut ids = locked(&self.inner.ids);

            if ids.contains(&options.id) {
                return Err(ProgrammerError::new(format!(
                    "an adapter of this broker is {} already",
                    options.id
                )));
            }

            ids.push(options.id.clone());
            ids.len().saturating_sub(1)
        };
        let adapter = Arc::new(AdapterInner {
            broker: Arc::clone(&self.inner),
            index,
            id: options.id.clone(),
            capabilities: options.capabilities.unwrap_or(BrokerCapabilities::ALL),
            delivery: options.delivery.unwrap_or(self.inner.delivery),
            listeners: Listeners::default(),
            is_linked: AtomicBool::new(false),
            unsettled: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
        });
        let held = Arc::downgrade(&adapter);

        // * its link held from now, in the order the adapters are made, before any of its calls
        self.inner
            .owner
            .offer(Box::new(move |state: &mut BrokerState| {
                while state.links.len() <= index {
                    state.links.push(Link {
                        adapter: Weak::new(),
                        is_linked: false,
                        subscriptions: HashMap::new(),
                        queue: VecDeque::new(),
                        will: None,
                    });
                }

                if let Some(link) = state.links.get_mut(index) {
                    link.adapter = held;
                }
            }));

        Ok(MemoryBrokerAdapter { inner: adapter })
    }

    /// What befalls the next message published, to its topic where one is given, as a test asks:
    /// copied, held behind the one after it on its topic, dropped, or handed again to another member
    /// of its group. Each fault asked befalls one message, in the order they were asked.
    pub fn fault(&self, fault: MemoryBrokerFault, options: &MemoryBrokerFaultOptions) {
        let topic = options.topic.as_deref().map(key_of);

        self.inner
            .owner
            .offer(Box::new(move |state: &mut BrokerState| {
                state.faults.push((topic, fault));
            }));
    }
}

struct AdapterInner {
    broker: Arc<BrokerInner>,
    index: usize,
    id: String,
    capabilities: BrokerCapabilities,
    delivery: BrokerDelivery,
    listeners: Listeners<dyn BrokerListener>,
    is_linked: AtomicBool,
    unsettled: AtomicU64,
    // its links, each a new incarnation: an acknowledgement counts on the link that handed it on
    epoch: AtomicU64,
}

impl AdapterInner {
    // its link gone: nothing it held is unsettled any more
    fn unlinked(&self) {
        self.is_linked.store(false, Ordering::SeqCst);
        self.unsettled.store(0, Ordering::SeqCst);
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    fn not_up(&self) -> BrokerError {
        BrokerError::failed(format!("the link of {} is not up", self.id))
    }

    // a job on its broker, in a turn of its own, whose outcome its future gives
    fn turn<
        T: Send + 'static,
        J: FnOnce(&mut BrokerState) -> Result<T, BrokerError> + Send + 'static,
    >(
        &self,
        job: J,
    ) -> BoxFuture<Result<T, BrokerError>> {
        let pending = self.broker.owner.run(job);

        Box::pin(async move {
            pending
                .await
                .unwrap_or_else(|_gone| Err(BrokerError::failed("the in-memory broker is gone")))
        })
    }

    fn publishing(
        self: &Arc<Self>,
        (publication, is_retained): (BrokerPublication, bool),
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        let adapter = Arc::clone(self);
        // * its life from its publish, on its broker's clock
        let expires = publication
            .expires_after
            .and_then(|life| self.broker.clock.wall().checked_add(life));

        self.turn(move |state| {
            let index = adapter.index;
            let is_linked = state.links.get(index).is_some_and(|link| link.is_linked);

            if !is_linked {
                return Err(adapter.not_up());
            }

            let length = u64::try_from(publication.payload.len()).unwrap_or(u64::MAX);

            if let Some(bound) = adapter.broker.maximum_message_bytes
                && length > bound
            {
                return Err(BrokerError::failed(format!(
                    "a payload of {length} bytes, past the broker's maximumMessageBytes, {bound} bytes"
                )));
            }

            if publication
                .signal
                .as_ref()
                .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
            {
                return Err(BrokerError::failed("the publication was given up on"));
            }

            let is_routed = state.route((publication, is_retained), expires);

            Ok(
                if !is_routed && adapter.capabilities.contains(BrokerCapabilities::NO_SUBSCRIBER) {
                    BrokerPublished::NoSubscriber
                } else {
                    BrokerPublished::Taken
                },
            )
        })
    }
}

/// One link to a [`MemoryBroker`] (spec 15.24): the adapter its participant is built over, its
/// acknowledgements counted, and, on a test's word, its link lost or taken over.
#[derive(Clone)]
pub struct MemoryBrokerAdapter {
    inner: Arc<AdapterInner>,
}

impl fmt::Debug for MemoryBrokerAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemoryBrokerAdapter")
            .field("id", &self.inner.id)
            .finish_non_exhaustive()
    }
}

impl MemoryBrokerAdapter {
    /// Whether its link is up: started, and neither stopped nor lost.
    #[must_use]
    pub fn is_linked(&self) -> bool {
        self.inner.is_linked.load(Ordering::SeqCst)
    }

    /// The messages handed it, at least once, that it has not acknowledged.
    #[must_use]
    pub fn unsettled(&self) -> u64 {
        self.inner.unsettled.load(Ordering::SeqCst)
    }

    /// As [`BrokerAdapter::publish`], handed on marked retained, as a broker hands a message it
    /// kept, as a test asks.
    pub fn publish_retained(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        self.inner.publishing((publication, true))
    }

    /// Its link lost, as a test asks: its subscriptions and its queue let go of, its will
    /// published, then its down told, in a later turn of its broker's.
    pub fn lose(&self) {
        let index = self.inner.index;

        self.inner
            .broker
            .owner
            .offer(Box::new(move |state: &mut BrokerState| {
                state.lost((index, BrokerDown::of(false)));
            }));
    }

    /// Its link taken over by another link of its id, as a test asks: as [`Self::lose`], its
    /// subscriptions dropped, since the link that takes it over holds none, and its will published,
    /// then its down told taken over. Its broker keeps one adapter to an id.
    pub fn take_over(&self) {
        let index = self.inner.index;

        self.inner
            .broker
            .owner
            .offer(Box::new(move |state: &mut BrokerState| {
                state.lost((index, BrokerDown::of(true)));
            }));
    }
}

impl BrokerAdapter for MemoryBrokerAdapter {
    fn transport_type(&self) -> &str {
        TRANSPORT_BROKER
    }

    fn id(&self) -> &str {
        &self.inner.id
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.inner.capabilities
    }

    fn delivery(&self) -> BrokerDelivery {
        self.inner.delivery
    }

    // it never leaves the process
    fn is_secure(&self) -> bool {
        true
    }

    // its broker's bound on a message, whatever its inbox's topic, or the largest a receive bound's
    // field holds when none: it has no packet to count
    fn receive_bound(&self, _topic: &[String]) -> u64 {
        self.inner
            .broker
            .maximum_message_bytes
            .unwrap_or(LARGEST_BOUND)
    }

    fn maximum_payload_bytes(&self, _topic: &[String]) -> u64 {
        self.inner.broker.maximum_message_bytes.unwrap_or(u64::MAX)
    }

    fn listen(&self, listener: Arc<dyn BrokerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        self.inner.listeners.remove(listener);
    }

    // links, its will kept for a loss, no subscription held from a link before: a link keeps no
    // session
    fn start(&self, options: BrokerStart) -> BoxFuture<Result<(), BrokerError>> {
        let adapter = Arc::clone(&self.inner);

        self.inner.turn(move |state| {
            let Some(link) = state.links.get_mut(adapter.index) else {
                return Err(adapter.not_up());
            };

            if link.is_linked {
                return Err(BrokerError::Refused(ProgrammerError::new(format!(
                    "the link of {} is up already",
                    adapter.id
                ))));
            }

            if options.will.is_some() && !adapter.capabilities.contains(BrokerCapabilities::WILL) {
                return Err(BrokerError::Refused(ProgrammerError::new(format!(
                    "the adapter of {} takes no will",
                    adapter.id
                ))));
            }

            link.subscriptions.clear();
            link.queue.clear();
            link.will = options.will;
            link.is_linked = true;
            adapter.epoch.fetch_add(1, Ordering::SeqCst);
            adapter.is_linked.store(true, Ordering::SeqCst);

            Ok(())
        })
    }

    // from the next message published to it
    fn subscribe(
        &self,
        topic: &[String],
        options: BrokerSubscription,
    ) -> BoxFuture<Result<(), BrokerError>> {
        let adapter = Arc::clone(&self.inner);
        let key = key_of(topic);

        self.inner.turn(move |state| {
            let Some(link) = state
                .links
                .get_mut(adapter.index)
                .filter(|link| link.is_linked)
            else {
                return Err(adapter.not_up());
            };

            if options.group.is_some() && !adapter.capabilities.contains(BrokerCapabilities::GROUPS)
            {
                return Err(BrokerError::Refused(ProgrammerError::new(format!(
                    "the adapter of {} offers no groups",
                    adapter.id
                ))));
            }

            link.subscriptions.insert(key, options.group);

            Ok(())
        })
    }

    // what was routed to it before is handed on all the same
    fn unsubscribe(&self, topic: &[String]) -> BoxFuture<Result<(), BrokerError>> {
        let index = self.inner.index;
        let key = key_of(topic);

        self.inner.turn(move |state| {
            if let Some(link) = state.links.get_mut(index) {
                link.subscriptions.remove(&key);
            }

            Ok(())
        })
    }

    // routed in a turn of the broker's, copied as it is published; settles once routed
    fn publish(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        self.inner.publishing((publication, false))
    }

    // its subscriptions and its queue let go of, no will published
    fn stop(&self) -> BoxFuture<()> {
        let adapter = Arc::clone(&self.inner);
        let stopping = self.inner.turn(move |state| {
            if let Some(link) = state.links.get_mut(adapter.index) {
                link.is_linked = false;
                link.will = None;
                link.subscriptions.clear();
                link.queue.clear();
            }

            adapter.unlinked();

            Ok(())
        });

        Box::pin(async move {
            stopping.await.ok();
        })
    }
}
