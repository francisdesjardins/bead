//! What a WebSocket server holds each message partway to (spec 15.12, decision 0056): a budget of
//! what all its connections' messages partway hold, and a rate each must come at once its grace
//! passed.
//!
//! The budget is charged as bytes come, never as a head announces them: each payload byte of a
//! message partway as it is read, a control frame's between its frames among them, and each
//! frame's head once whole, its bytes and 128 more. A message's charge is released once it is
//! whole, or at once at its connection's verdict, which charges nothing after. A charge of _n_
//! decides as _n_ charges of one, each taking the room left. When none is left, the order is judged
//! for that one unit: the holder whose message holds the most first, the asking one's sum counting
//! that unit, as Redis evicts the clients that hold the most, then, among equal sums, the one whose
//! message began first. The one that comes first is cast off, and the next unit judged; the asking
//! holder is cast off only when it comes first, so a charge that passes the budget alone casts off
//! each holder before it, then its own. Each holder cast off fails with 1013, IANA's "Try Again
//! Later", its charge released at once. A holder with nothing charged is in no order.
//!
//! The rate is the body's of spec 15.12: a message that brought _R_ bytes of payload, and none more,
//! by its first byte plus the longer of `bodyGracePeriod` and _R_ at `minimumBodyBytesPerSecond`
//! fails with 1008. It runs on the server's clock (decision 0011), its time not counted while its
//! router holds its connection paused, which reads none of it then.

use core::cmp::Reverse;
use core::fmt;
use core::time::Duration;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::LONGEST_TIMER;

#[cfg(test)]
mod tests;

// no reading: no message under way, or no pause
const NONE: u64 = u64::MAX;

// what hears what comes to a connection from outside its reads
type Signal = Box<dyn Fn(Outside) + Send + Sync>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn nanoseconds_of(reading: Duration) -> u64 {
    u64::try_from(reading.as_nanos()).unwrap_or(NONE.saturating_sub(1))
}

/// What comes to a connection from outside its reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outside {
    /// Its server's budget cast it off.
    CastOff,
    /// Its rate's timer fired.
    Late,
}

/// What a server holds its messages partway to.
#[derive(Clone)]
pub(crate) struct MessageBounds {
    /// What they hold together, at most.
    pub(crate) message_bytes_budget: u64,
    /// The slowest, in bytes a second, a message may come once its grace passed.
    pub(crate) minimum_body_bytes_per_second: u64,
    /// How long a message comes before its rate is held.
    pub(crate) body_grace_period: Duration,
    /// The server's clock, which the rate runs on.
    pub(crate) clock: SharedClock,
}

// a message partway, charged
struct Entry {
    charge: u64,
    // the rank its message began at
    began: u64,
    partway: Arc<Partway>,
}

#[derive(Default)]
struct BudgetState {
    held: u64,
    // the holders charged, a message partway each
    holders: HashMap<u64, Entry>,
    // the last holder drawn
    drawn: u64,
}

/// A server's budget of what its messages partway hold, across its connections.
pub(crate) struct MessageBudget {
    bounds: MessageBounds,
    state: Mutex<BudgetState>,
    // the rank of the last message begun
    began: AtomicU64,
}

impl fmt::Debug for MessageBudget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MessageBudget")
            .field("budget", &self.bounds.message_bytes_budget)
            .field("held", &self.held())
            .finish_non_exhaustive()
    }
}

impl MessageBudget {
    /// A budget held to `bounds`, holding nothing yet.
    pub(crate) fn new(bounds: MessageBounds) -> Arc<Self> {
        Arc::new(Self {
            bounds,
            state: Mutex::new(BudgetState::default()),
            began: AtomicU64::new(0),
        })
    }

    /// What its messages partway hold right now: its gauge, `messageBytes`.
    pub(crate) fn held(&self) -> u64 {
        locked(&self.state).held
    }

    /// What they may hold together: its ceiling, `messageBytesBudget`.
    pub(crate) const fn budget(&self) -> u64 {
        self.bounds.message_bytes_budget
    }

    /// The holding of one connection, which holds nothing yet.
    pub(crate) fn holding(self: &Arc<Self>) -> Holding {
        let id = {
            let mut state = locked(&self.state);

            state.drawn = state.drawn.saturating_add(1);
            state.drawn
        };

        Holding {
            budget: Arc::clone(self),
            partway: Arc::new(Partway {
                clock: Arc::clone(&self.bounds.clock),
                first_at: AtomicU64::new(NONE),
                paused_then: AtomicU64::new(0),
                paused_at: AtomicU64::new(NONE),
                paused_for: AtomicU64::new(0),
                is_cast_off: AtomicBool::new(false),
                signal: Mutex::new(None),
            }),
            id,
            began: 0,
            payload: 0,
            is_entered: false,
            timer: None,
            armed: None,
            is_stopped: false,
        }
    }
}

/// What a connection's message partway is held by that others read: its rate's clock, which its
/// router's pause stops, and whether its budget cast it off.
pub(crate) struct Partway {
    clock: SharedClock,
    // the clock's reading at its message's first byte, and the time paused counted then
    first_at: AtomicU64,
    paused_then: AtomicU64,
    // when its router paused it, and the time paused before it, in nanoseconds
    paused_at: AtomicU64,
    paused_for: AtomicU64,
    is_cast_off: AtomicBool,
    signal: Mutex<Option<Signal>>,
}

impl fmt::Debug for Partway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Partway")
            .field("is_cast_off", &self.is_cast_off.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl Partway {
    /// Its router paused its connection, which reads none of it: its time is not counted from now.
    pub(crate) fn pause(&self) {
        let now = nanoseconds_of(self.clock.monotonic());

        self.paused_at
            .compare_exchange(NONE, now, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
    }

    /// Its router resumed its connection: its time is counted again.
    pub(crate) fn resume(&self) {
        let at = self.paused_at.swap(NONE, Ordering::SeqCst);

        if at != NONE {
            let now = nanoseconds_of(self.clock.monotonic());

            self.paused_for
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |paused| {
                    Some(paused.saturating_add(now.saturating_sub(at)))
                })
                .ok();
        }
    }

    /// Tells `signal` what comes from outside its connection's reads.
    pub(crate) fn listen(&self, signal: Signal) {
        *locked(&self.signal) = Some(signal);
    }

    fn tell(&self, outside: Outside) {
        if let Some(signal) = locked(&self.signal).as_ref() {
            signal(outside);
        }
    }

    fn is_paused(&self) -> bool {
        self.paused_at.load(Ordering::SeqCst) != NONE
    }

    // how long its message has come on its rate's clock, its time paused not counted; none with no
    // message under way
    fn elapsed(&self) -> Option<Duration> {
        let first = self.first_at.load(Ordering::SeqCst);

        if first == NONE {
            return None;
        }

        let now = nanoseconds_of(self.clock.monotonic());
        let paused_at = self.paused_at.load(Ordering::SeqCst);
        let mut paused_for = self.paused_for.load(Ordering::SeqCst);

        if paused_at != NONE {
            paused_for = paused_for.saturating_add(now.saturating_sub(paused_at));
        }

        let paused = paused_for.saturating_sub(self.paused_then.load(Ordering::SeqCst));

        Some(Duration::from_nanos(
            now.saturating_sub(first).saturating_sub(paused),
        ))
    }
}

/// One connection's charge to its server's budget and its message's rate, owned by its meter.
pub(crate) struct Holding {
    budget: Arc<MessageBudget>,
    partway: Arc<Partway>,
    id: u64,
    // the rank its message began at, the payload it brought, and whether its budget holds an entry
    // of it
    began: u64,
    payload: u64,
    is_entered: bool,
    timer: Option<Arc<dyn Timer>>,
    // the deadline its timer is armed for, from its message's first byte
    armed: Option<Duration>,
    is_stopped: bool,
}

impl fmt::Debug for Holding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Holding")
            .field("id", &self.id)
            .field("payload", &self.payload)
            .finish_non_exhaustive()
    }
}

impl Holding {
    /// What its message partway is held by, which others read.
    pub(crate) fn partway(&self) -> Arc<Partway> {
        Arc::clone(&self.partway)
    }

    /// Its server's budget.
    pub(crate) fn budget(&self) -> u64 {
        self.budget.budget()
    }

    /// Why a message that came too slowly failed its connection, naming the rate's bounds in the
    /// spec's spelling and their values (spec 15.12).
    pub(crate) fn late_of(&self) -> String {
        let bounds = &self.budget.bounds;

        format!(
            "a message came slower than minimumBodyBytesPerSecond, {} a second, past bodyGracePeriod, {} ms",
            crate::failure::byte_count_of(bounds.minimum_body_bytes_per_second),
            bounds.body_grace_period.as_millis()
        )
    }

    /// Whether its server's budget cast it off.
    pub(crate) fn is_cast_off(&self) -> bool {
        self.partway.is_cast_off.load(Ordering::SeqCst)
    }

    /// A message begins: its rate's clock starts, and its rank is drawn. Nothing is locked nor
    /// armed: its first charge enters it in the budget, and the end of the read its timer.
    pub(crate) fn begin(&mut self) {
        if self.is_stopped || self.is_cast_off() {
            return;
        }

        let partway = &self.partway;

        partway
            .first_at
            .store(nanoseconds_of(partway.clock.monotonic()), Ordering::SeqCst);
        partway
            .paused_then
            .store(partway.paused_for.load(Ordering::SeqCst), Ordering::SeqCst);
        self.began = self
            .budget
            .began
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        self.payload = 0;
    }

    /// Charges `bytes` of its message partway, unit by unit, casting off the holders that come
    /// before it when no room is left: false once it is cast off itself, its charge released.
    pub(crate) fn charge(&mut self, bytes: u64) -> bool {
        if self.is_stopped || self.is_cast_off() {
            return false;
        }

        // no message under way: nothing to charge
        if self.partway.first_at.load(Ordering::SeqCst) == NONE {
            return true;
        }

        let budget = &self.budget;
        let ceiling = budget.budget();
        let (cast, is_kept) = {
            let mut state = locked(&budget.state);

            if self.is_cast_off() {
                return false;
            }

            state.holders.entry(self.id).or_insert_with(|| Entry {
                charge: 0,
                began: self.began,
                partway: Arc::clone(&self.partway),
            });
            self.is_entered = true;

            if state.held.saturating_add(bytes) <= ceiling {
                take(&mut state, (self.id, bytes));

                return true;
            }

            // * the others in the order a unit is judged by: the most first, then the message
            // begun first; their sums stay as they are while this charge is decided
            let mut order: Vec<(Reverse<u64>, u64, u64)> = state
                .holders
                .iter()
                .filter(|(id, entry)| **id != self.id && entry.charge > 0)
                .map(|(id, entry)| (Reverse(entry.charge), entry.began, *id))
                .collect();

            order.sort_unstable();

            let mut others = order.into_iter().peekable();
            let mut left = bytes;
            let mut cast = Vec::new();
            let is_kept = loop {
                let taken = ceiling.saturating_sub(state.held).min(left);

                take(&mut state, (self.id, taken));
                left = left.saturating_sub(taken);

                if left == 0 {
                    break true;
                }

                // * the next unit judged: the asking holder, its sum counting it, against the
                // first of the others
                let unit = state
                    .holders
                    .get(&self.id)
                    .map_or(0, |entry| entry.charge)
                    .saturating_add(1);
                let is_first = others.peek().is_none_or(|(Reverse(sum), began, _)| {
                    unit > *sum || (unit == *sum && self.began < *began)
                });

                if is_first {
                    if let Some(entry) = state.holders.remove(&self.id) {
                        state.held = state.held.saturating_sub(entry.charge);
                    }

                    self.is_entered = false;
                    self.partway.is_cast_off.store(true, Ordering::SeqCst);

                    break false;
                }

                if let Some((_, _, id)) = others.next()
                    && let Some(entry) = state.holders.remove(&id)
                {
                    state.held = state.held.saturating_sub(entry.charge);
                    entry.partway.is_cast_off.store(true, Ordering::SeqCst);
                    cast.push(entry.partway);
                }
            };

            drop(state);

            (cast, is_kept)
        };

        // * told outside the budget's lock: each takes effect in its own connection's turn
        for partway in cast {
            partway.tell(Outside::CastOff);
        }

        // cast off by its own charge: its rate's clock stopped, its timer disarmed
        if !is_kept {
            self.end();
        }

        is_kept
    }

    /// Its message brought `payload` bytes more, which move its deadline: its timer is armed
    /// again at the end of the read.
    pub(crate) fn brought(&mut self, payload: u64) {
        self.payload = self.payload.saturating_add(payload);
    }

    /// Its message is whole with `bytes` more: charged, then released at once, one lock taken
    /// where they fit; false, nothing charged, once it is cast off itself.
    pub(crate) fn finish(&mut self, bytes: u64) -> bool {
        if self.is_stopped {
            return false;
        }

        {
            let mut state = locked(&self.budget.state);

            if self.is_cast_off() {
                return false;
            }

            if state.held.saturating_add(bytes) <= self.budget.budget() {
                if let Some(entry) = state.holders.remove(&self.id) {
                    state.held = state.held.saturating_sub(entry.charge);
                }

                drop(state);
                self.is_entered = false;
                self.end();

                return true;
            }
        }

        let is_taken = self.charge(bytes);

        if is_taken {
            self.end();
        }

        is_taken
    }

    /// Its message is whole: its charge released, its timer disarmed.
    pub(crate) fn end(&mut self) {
        if core::mem::take(&mut self.is_entered) {
            let mut state = locked(&self.budget.state);

            if let Some(entry) = state.holders.remove(&self.id) {
                state.held = state.held.saturating_sub(entry.charge);
            }
        }

        self.partway.first_at.store(NONE, Ordering::SeqCst);
        self.payload = 0;
        self.disarm();
    }

    /// Its connection's verdict: its charge released, its timer disarmed, nothing charged after.
    pub(crate) fn stop(&mut self) {
        self.is_stopped = true;
        self.end();
    }

    /// Its timer fired: whether its message came too slowly; its timer armed again for what is
    /// left otherwise, but while its router pauses it, which a resume arms again.
    pub(crate) fn judge_late(&mut self) -> bool {
        self.disarm();

        let Some(elapsed) = self.partway.elapsed() else {
            return false;
        };

        if self.is_stopped || self.partway.is_paused() {
            return false;
        }

        if elapsed >= self.deadline() {
            return true;
        }

        self.rearm();

        false
    }

    /// Its timer armed at its message's deadline, from now: none with no message under way, nor
    /// while its router pauses it; unchanged where it stands.
    pub(crate) fn rearm(&mut self) {
        let Some(elapsed) = self.partway.elapsed() else {
            return;
        };

        if self.is_stopped || self.partway.is_paused() {
            return;
        }

        let deadline = self.deadline();

        if self.timer.is_some() && self.armed == Some(deadline) {
            return;
        }

        self.disarm();

        // ! a millisecond at least, counted whole: Bead arms no timer for less (decision 0011)
        let left = deadline.saturating_sub(elapsed);
        let due = Duration::from_millis(
            u64::try_from(left.as_nanos().div_ceil(1_000_000))
                .unwrap_or(u64::MAX)
                .max(1),
        )
        .min(LONGEST_TIMER);
        let partway: Weak<Partway> = Arc::downgrade(&self.partway);

        self.timer = self
            .budget
            .bounds
            .clock
            .arm(
                Schedule::Once(due),
                Box::new(move || {
                    if let Some(partway) = partway.upgrade() {
                        partway.tell(Outside::Late);
                    }
                }),
            )
            .ok();
        self.armed = Some(deadline);
    }

    fn disarm(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }

        self.armed = None;
    }

    // when its message is due, from its first byte: the longer of its grace and its payload at its
    // rate
    fn deadline(&self) -> Duration {
        let bounds = &self.budget.bounds;
        let rate = bounds.minimum_body_bytes_per_second.max(1);
        let takes = Duration::from_millis(self.payload.saturating_mul(1_000).div_ceil(rate));

        bounds.body_grace_period.max(takes)
    }
}

impl Drop for Holding {
    fn drop(&mut self) {
        self.stop();
    }
}

// `bytes` charged to the holder `id`, which fit
fn take(state: &mut BudgetState, (id, bytes): (u64, u64)) {
    if let Some(entry) = state.holders.get_mut(&id) {
        entry.charge = entry.charge.saturating_add(bytes);
        state.held = state.held.saturating_add(bytes);
    }
}
