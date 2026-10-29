//! A joined transport (spec 15.14): one server transport over several, so one server — its router,
//! its admission, its sessions, its services, each offered once — takes its connections from each:
//! an in-memory transport beside a broker's, say. Each handle is the one its transport drew, and the
//! join refuses, as it is built, two transports of one type, whose handles might be one; each
//! connection's flags, its sending and its closing are asked of the transport that drew it, known
//! by its handle's type. Each transport's events are told on, with its handle, in the order that
//! transport told them, each listener within the join's guard; its stop stops every one, and
//! settles once all have; its gauges are their sum. It starts nothing: an application starts each
//! transport it joined, and the join serves no port of its own, one port for two coming from a
//! proxy in front of them.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use crate::clock::SharedClock;
use crate::errors::ProgrammerError;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{Listeners, Sent, ServerListener, ServerTransport, TransportServerRefusal};

#[cfg(test)]
mod tests;

// what every handle begins with, its type then a semicolon (spec 15.1)
const TYPE_PREFIX: &str = "type=";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct JoinedInner {
    transports: Vec<Arc<dyn ServerTransport>>,
    // each transport by the type its handles begin with
    by_type: HashMap<String, usize>,
    clock: Option<SharedClock>,
    listeners: Listeners<dyn ServerListener>,
    // each transport's connections as its events told them, what it is counted by when it counts
    // nothing itself
    told: Vec<Mutex<BTreeSet<ConnectionHandle>>>,
}

impl JoinedInner {
    // each listener of the join's within its guard: what one panics is reported through its errors,
    // with its connection
    fn tell<C: Fn(&dyn ServerListener)>(
        &self,
        (call, connection_handle): (C, Option<&ConnectionHandle>),
    ) {
        let listeners = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn ServerListener + 'static)| call(listener),
            |error: RouterError| {
                for heard in &listeners {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error, connection_handle);
                    }))
                    .ok();
                }
            },
        ));
    }

    // the transport that drew a handle, by the type it begins with; none for one of another type
    fn owner_of(&self, connection_handle: &ConnectionHandle) -> Option<&Arc<dyn ServerTransport>> {
        let typed = connection_handle.strip_prefix(TYPE_PREFIX)?;
        let kind = typed.split(';').next()?;

        self.by_type
            .get(kind)
            .and_then(|index| self.transports.get(*index))
    }
}

// what one transport tells, told on by the join
struct Forwarding {
    joined: Weak<JoinedInner>,
    index: usize,
}

impl Forwarding {
    fn told(&self) -> Option<Arc<JoinedInner>> {
        self.joined.upgrade()
    }
}

impl ServerListener for Forwarding {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        let Some(joined) = self.told() else {
            return;
        };

        // counted before the join's listeners hear of it, so a gauge they read holds it
        if let Some(told) = joined.told.get(self.index) {
            locked(told).insert(Arc::clone(connection_handle));
        }

        joined.tell((
            |listener: &dyn ServerListener| listener.on_connection(connection_handle),
            Some(connection_handle),
        ));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        if let Some(joined) = self.told() {
            joined.tell((
                |listener: &dyn ServerListener| {
                    listener.on_message(message.clone(), connection_handle);
                },
                Some(connection_handle),
            ));
        }
    }

    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        let Some(joined) = self.told() else {
            return;
        };

        if let Some(told) = joined.told.get(self.index) {
            locked(told).remove(connection_handle);
        }

        joined.tell((
            |listener: &dyn ServerListener| listener.on_close(was_clean, connection_handle),
            Some(connection_handle),
        ));
    }

    fn on_listen(&self, is_held: bool, connection_handle: &ConnectionHandle) {
        if let Some(joined) = self.told() {
            joined.tell((
                |listener: &dyn ServerListener| listener.on_listen(is_held, connection_handle),
                Some(connection_handle),
            ));
        }
    }

    // ! a refusal names no connection: what its listener panics is reported with none
    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        if let Some(joined) = self.told() {
            joined.tell((
                |listener: &dyn ServerListener| listener.on_refusal(refusal),
                None,
            ));
        }
    }

    // ! told on as it came, outside the guard: a listener of errors that panics would be reported
    // to itself
    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        if let Some(joined) = self.told() {
            for listener in joined.listeners.all() {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    listener.on_error(error, connection_handle);
                }))
                .ok();
            }
        }
    }
}

/// One server transport over several (spec 15.14), so that one server takes its connections from
/// each of them.
#[derive(Clone)]
pub struct JoinedServerTransport {
    inner: Arc<JoinedInner>,
}

impl fmt::Debug for JoinedServerTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JoinedServerTransport")
            .field("transports", &self.inner.transports)
            .finish_non_exhaustive()
    }
}

/// Several parts' gauges as one, each count and each ceiling of one name added.
fn summed(parts: Vec<Gauges>) -> Gauges {
    let mut counts: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut ceilings: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut sum = Gauges::default();

    for part in parts {
        for (name, count) in part.counts {
            let held = counts.entry(name).or_insert(0);

            *held = held.saturating_add(count);
        }

        for (name, ceiling) in part.ceilings {
            let held = ceilings.entry(name).or_insert(0);

            *held = held.saturating_add(ceiling);
        }

        sum.connection_handles.extend(part.connection_handles);
        sum.anomalies.extend(part.anomalies);
    }

    sum.counts = counts;
    sum.ceilings = ceilings;

    sum
}

impl JoinedServerTransport {
    /// A join of `transports`, each told on from now.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for none, one that names no type — a join among them — two of one type,
    /// and two on different clocks.
    pub fn new(transports: Vec<Arc<dyn ServerTransport>>) -> Result<Self, ProgrammerError> {
        if transports.is_empty() {
            return Err(ProgrammerError::new("a join takes one transport at least"));
        }

        let mut by_type: HashMap<String, usize> = HashMap::new();
        let mut clock: Option<SharedClock> = None;

        for (index, transport) in transports.iter().enumerate() {
            let Some(kind) = transport.transport_type() else {
                return Err(ProgrammerError::new(
                    "a join takes transports that name the type of their handles, never a join",
                ));
            };

            // ! a handle tells two types apart, never two transports of one type, whose ranks each
            // count from 1 (decision 0025)
            if by_type.insert(kind.to_owned(), index).is_some() {
                return Err(ProgrammerError::new(format!(
                    "a join takes one transport of each type: two are {kind}, whose handles might be one"
                )));
            }

            if let Some(given) = transport.clock() {
                match &clock {
                    Some(held) if !Arc::ptr_eq(held, &given) => {
                        return Err(ProgrammerError::new("a join's transports run on one clock"));
                    }
                    Some(_) => {}
                    None => clock = Some(given),
                }
            }
        }

        let told = transports
            .iter()
            .map(|_| Mutex::new(BTreeSet::new()))
            .collect();
        let inner = Arc::new(JoinedInner {
            transports,
            by_type,
            clock,
            listeners: Listeners::default(),
            told,
        });

        for (index, transport) in inner.transports.iter().enumerate() {
            transport.listen(Arc::new(Forwarding {
                joined: Arc::downgrade(&inner),
                index,
            }));
        }

        Ok(Self { inner })
    }

    /// The transports it joins, in the order it was given them.
    #[must_use]
    pub fn transports(&self) -> &[Arc<dyn ServerTransport>] {
        &self.inner.transports
    }
}

impl ServerTransport for JoinedServerTransport {
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.inner
            .owner_of(connection_handle)
            .map_or(Ok(Sent::Done), |owner| {
                owner.send(message, connection_handle)
            })
    }

    // through the transport that drew it; false when none holds it
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        match self.inner.owner_of(connection_handle) {
            Some(owner) => owner.close(connection_handle),
            None => Box::pin(async { false }),
        }
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.inner.listeners.remove(listener);
    }

    // the one clock of its transports
    fn clock(&self) -> Option<SharedClock> {
        self.inner.clock.clone()
    }

    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        self.inner
            .owner_of(connection_handle)
            .is_some_and(|owner| owner.is_two_way(connection_handle))
    }

    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        self.inner
            .owner_of(connection_handle)
            .is_some_and(|owner| owner.is_secure(connection_handle))
    }

    fn carries_credential(&self, connection_handle: &ConnectionHandle) -> bool {
        self.inner
            .owner_of(connection_handle)
            .is_some_and(|owner| owner.carries_credential(connection_handle))
    }

    // * it starts nothing: an application starts each transport it joined, where it listens
    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    // every transport it joined, settled once all have
    fn stop(&self) -> BoxFuture<()> {
        let stopping: Vec<BoxFuture<()>> = self
            .inner
            .transports
            .iter()
            .map(|transport| transport.stop())
            .collect();

        Box::pin(async move {
            for stop in stopping {
                stop.await;
            }
        })
    }

    // what its transports hold, summed: each count and each ceiling added by its name, the
    // connections any of them keeps anything for; one that counts nothing counted by its
    // connections, as its events told them
    fn gauges(&self) -> Option<Gauges> {
        let parts = self
            .inner
            .transports
            .iter()
            .zip(&self.inner.told)
            .map(|(transport, told)| {
                transport.gauges().unwrap_or_else(|| {
                    let handles = locked(told).clone();
                    let mut gauges = Gauges::default();

                    gauges.counts.insert(
                        "connections",
                        u64::try_from(handles.len()).unwrap_or(u64::MAX),
                    );
                    gauges.connection_handles = handles;

                    gauges
                })
            })
            .collect();

        Some(summed(parts))
    }

    // none: its handles are of several types, its transports'
    fn transport_type(&self) -> Option<&str> {
        None
    }
}
