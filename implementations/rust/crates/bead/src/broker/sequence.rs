//! One direction of a broker connection (spec 15.19, 15.20): its sequence, as its receiver numbers
//! what comes, a copy dropped and a gap a loss; what a participant holds in parts across its
//! connections, bounded by its budget; and one direction's envelope in parts, whole once its last
//! part came, held to its bound, that budget and its rate.

use core::fmt;
use core::sync::atomic::{AtomicU64, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::{Bytes, BytesMut};

use crate::broker::parcel::{PREFIX_BYTES, codes};
use crate::clock::{Schedule, SharedClock, Timer};

/// What a parcel taken in one direction is to its sequence (spec 15.19).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Taking {
    /// The next one awaited: handed on.
    Next,
    /// Below the next one awaited: a copy, dropped in silence.
    Copy,
    /// Past the next one awaited: a loss, and the connection with it.
    Gap,
}

/// One direction of a connection, as its receiver numbers it (spec 15.19): the next sequence
/// awaited, the one number its duplicate window keeps. A parcel below it is a copy — a broker's
/// redelivery, a test's copy — and one past it a loss, since a broker keeps one publisher's order
/// on one topic (MQTT 5 §4.6) and resends nothing into a link that kept no session.
#[derive(Debug, Clone)]
pub(crate) struct Sequence {
    awaited: u64,
}

impl Sequence {
    /// A direction awaiting `awaited` next.
    pub(crate) const fn new(awaited: u64) -> Self {
        Self { awaited }
    }

    /// The next sequence awaited.
    #[cfg(test)]
    pub(crate) const fn awaited(&self) -> u64 {
        self.awaited
    }

    /// Takes a parcel of `sequence`: the next, moving the window by one; a copy; or a gap.
    pub(crate) fn take(&mut self, sequence: u64) -> Taking {
        if sequence < self.awaited {
            return Taking::Copy;
        }

        if sequence > self.awaited {
            return Taking::Gap;
        }

        self.awaited = self.awaited.saturating_add(1);

        Taking::Next
    }

    /// A gap, as its side reports it: the sequence awaited and the one that came (spec 15.19).
    pub(crate) fn gap_of(&self, came: u64) -> String {
        format!(
            "a parcel lost: {} was awaited, and {came} came",
            self.awaited
        )
    }
}

/// What a participant holds in parts across its connections (spec 15.20), bounded by its
/// `heldBytesBudget`: a part that would pass it loses its own connection. Charged in its
/// participant's turn alone, and read from any thread.
#[derive(Debug)]
pub(crate) struct Budget {
    budget: u64,
    held: AtomicU64,
}

impl Budget {
    /// A budget of `budget` bytes, nothing held.
    pub(crate) const fn new(budget: u64) -> Self {
        Self {
            budget,
            held: AtomicU64::new(0),
        }
    }

    /// The budget, in bytes.
    pub(crate) const fn budget(&self) -> u64 {
        self.budget
    }

    /// What is held in parts right now.
    pub(crate) fn held(&self) -> u64 {
        self.held.load(Ordering::SeqCst)
    }

    /// Charges `bytes`; false, nothing charged, when they would pass the budget.
    pub(crate) fn try_charge(&self, bytes: u64) -> bool {
        self.held
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                held.checked_add(bytes)
                    .filter(|charged| *charged <= self.budget)
            })
            .is_ok()
    }

    /// Lets `bytes` go, held no more.
    pub(crate) fn release(&self, bytes: u64) {
        self.held
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                Some(held.saturating_sub(bytes))
            })
            .ok();
    }
}

/// What an envelope's parts are held to (spec 15.20, 15.12).
#[derive(Debug, Clone)]
pub(crate) struct PartsBounds {
    /// One envelope's parts together: past it, the connection closes with 1009.
    pub(crate) maximum_envelope_parts_bytes: u64,
    /// The slowest parts may come once the grace passed since an envelope's first, in bytes a
    /// second.
    pub(crate) minimum_body_bytes_per_second: u64,
    /// How long an envelope's parts come before their rate is held.
    pub(crate) body_grace_period: Duration,
    /// What the participant holds in parts, across its connections.
    pub(crate) budget: Arc<Budget>,
    /// What the rate is held on: the clock the side is given (decision 0011).
    pub(crate) clock: SharedClock,
}

/// A part taken: the envelope whole once its last part came, with the credential its first part
/// carried; held; or the connection lost, with its code and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PartTaking {
    /// The envelope whole, and the credential its first part carried.
    Whole(Bytes, Option<String>),
    /// Held, more to come.
    Held,
    /// The connection lost: its CLOSE's code, and why.
    Lost(u16, String),
}

/// An envelope cut in parts toward a peer: each part's bytes, and whether it carries the credential.
pub(crate) type Cut = Vec<(Bytes, bool)>;

/// What hears that the parts came late: a timer's callback, judged in its participant's turn.
pub(crate) type Late = Arc<dyn Fn() + Send + Sync>;

/// One direction's envelope in parts (spec 15.20): DATA parcels one after the other, `MORE` on
/// each but the last, a credential on the first alone, handed on once the last came, whole, as a
/// WebSocket's message in fragments is one (RFC 6455 §5.4). Past `maximumEnvelopePartsBytes` the
/// connection closes with 1009; a part that would pass the participant's `heldBytesBudget`, or parts
/// that come slower than `minimumBodyBytesPerSecond` once `bodyGracePeriod` passed since the first,
/// on the clock given, lose it, a CLOSE of 4000: each naming the bound and its value. The rate is
/// held by one timer, armed at the grace by the first part, and, while the parts are on time, armed
/// again at the deadline the parts so far give: the time their bytes are owed by at the rate.
pub(crate) struct Parts {
    bounds: Arc<PartsBounds>,
    late: Late,
    held: BytesMut,
    credential: Option<String>,
    first_at: Option<Duration>,
    timer: Option<Arc<dyn Timer>>,
    // how much it holds, read from any thread
    bytes: Arc<AtomicU64>,
}

impl fmt::Debug for Parts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Parts")
            .field("held", &self.held.len())
            .finish_non_exhaustive()
    }
}

/// Whether a parcel of `limit` bytes leaves an envelope one byte at least beside a credential of
/// `credential_bytes`: a send it does not is refused before it goes, its connection kept.
pub(crate) fn fits((limit, credential_bytes): (u64, Option<usize>)) -> bool {
    room_of((limit, credential_bytes)).is_some_and(|(first, _)| first >= 1)
}

// the bytes of an envelope the first parcel holds beside its credential, and each next one
fn room_of((limit, credential_bytes): (u64, Option<usize>)) -> Option<(u64, u64)> {
    let prefix = u64::try_from(PREFIX_BYTES).ok()?;
    let credential = match credential_bytes {
        None => 0,
        Some(bytes) => u64::try_from(bytes).ok()?.checked_add(2)?,
    };
    let next = limit.checked_sub(prefix)?;

    Some((next.checked_sub(credential)?, next))
}

/// An envelope cut in DATA parcels toward a peer, unsequenced yet: whole where it fits `limit`,
/// the largest parcel toward that peer, in parts otherwise, each as large as that bound lets it but
/// the last, which takes what is left, of one byte at least, the credential on the first alone
/// (spec 15.20). None where the limit leaves no byte of the envelope beside the credential.
pub(crate) fn cut(envelope: &Bytes, (limit, credential_bytes): (u64, Option<usize>)) -> Cut {
    let Some((first, next)) = room_of((limit, credential_bytes)).filter(|(first, _)| *first >= 1)
    else {
        return Vec::new();
    };
    let first = usize::try_from(first).unwrap_or(usize::MAX);
    let next = usize::try_from(next).unwrap_or(usize::MAX);
    let mut parts = Vec::new();
    let mut at = 0_usize;

    while at < envelope.len() {
        let room = if at == 0 { first } else { next };
        let end = at.saturating_add(room).min(envelope.len());

        parts.push((
            envelope.slice(at..end),
            at == 0 && credential_bytes.is_some(),
        ));
        at = end;
    }

    parts
}

impl Parts {
    /// One direction's parts, held to `bounds`, `late` hearing its rate's timer.
    pub(crate) fn new(bounds: Arc<PartsBounds>, late: Late) -> Self {
        Self {
            bounds,
            late,
            held: BytesMut::new(),
            credential: None,
            first_at: None,
            timer: None,
            bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    /// What it holds in parts right now.
    pub(crate) fn held_bytes(&self) -> u64 {
        u64::try_from(self.held.len()).unwrap_or(u64::MAX)
    }

    /// What it holds in parts, read from any thread.
    pub(crate) fn counted(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.bytes)
    }

    /// Why parts that came too slowly lost their connection.
    pub(crate) fn late_of(&self) -> String {
        format!(
            "an envelope's parts came slower than minimumBodyBytesPerSecond, {} bytes a second, past bodyGracePeriod, {} ms",
            self.bounds.minimum_body_bytes_per_second,
            self.bounds.body_grace_period.as_millis()
        )
    }

    /// Takes a DATA's envelope or part, `is_more` when more come after it: the envelope whole,
    /// with the credential its first part carried; held; or its connection lost.
    pub(crate) fn take(
        &mut self,
        (carried, is_more, credential): (Bytes, bool, Option<String>),
    ) -> PartTaking {
        // a DATA that is no part is handed on as it came, held nowhere
        if self.first_at.is_none() && !is_more {
            return PartTaking::Whole(carried, credential);
        }

        // ! a credential on the first part alone (spec 15.20)
        if self.first_at.is_some() && credential.is_some() {
            self.stop();

            return PartTaking::Lost(
                codes::PROTOCOL_ERROR,
                "a part past the first of an envelope carries a credential".to_owned(),
            );
        }

        let length = u64::try_from(carried.len()).unwrap_or(u64::MAX);

        if self.held_bytes().saturating_add(length) > self.bounds.maximum_envelope_parts_bytes {
            self.stop();

            return PartTaking::Lost(
                codes::TOO_BIG,
                format!(
                    "an envelope's parts would pass maximumEnvelopePartsBytes, {} bytes",
                    self.bounds.maximum_envelope_parts_bytes
                ),
            );
        }

        // * each part charged, the last among them, until its envelope is whole
        if !self.bounds.budget.try_charge(length) {
            self.stop();

            return PartTaking::Lost(
                codes::LOST,
                format!(
                    "a part would pass its participant's heldBytesBudget, {} bytes",
                    self.bounds.budget.budget()
                ),
            );
        }

        if self.first_at.is_none() {
            self.first_at = Some(self.bounds.clock.monotonic());
            self.credential = credential;
        }

        self.held.extend_from_slice(&carried);
        self.bytes.store(self.held_bytes(), Ordering::SeqCst);

        if is_more {
            // * armed at the grace by the first part; judged then, and armed again while on time
            if self.timer.is_none() {
                self.rearm();
            }

            return PartTaking::Held;
        }

        let credential = self.credential.take();
        let whole = Bytes::copy_from_slice(&self.held);

        // the envelope whole, its parts given back to the budget
        self.stop();

        PartTaking::Whole(whole, credential)
    }

    /// Whether its parts are owed more than came, now: they came too slowly.
    pub(crate) fn is_late(&self) -> bool {
        self.first_at.is_some_and(|first| {
            self.bounds.clock.monotonic().saturating_sub(first) >= self.deadline_of()
        })
    }

    /// Lets go of what it holds, its budget freed and its timer disarmed.
    pub(crate) fn stop(&mut self) {
        self.bounds.budget.release(self.held_bytes());
        self.held.clear();
        self.bytes.store(0, Ordering::SeqCst);
        self.credential = None;
        self.first_at = None;

        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }
    }

    // when, from the first part, the parts so far are owed by: the grace, or their bytes at the rate
    fn deadline_of(&self) -> Duration {
        let owed_milliseconds = self
            .held_bytes()
            .saturating_mul(1_000)
            .saturating_add(self.bounds.minimum_body_bytes_per_second / 2)
            .checked_div(self.bounds.minimum_body_bytes_per_second)
            .unwrap_or(u64::MAX);
        let owed = Duration::from_millis(owed_milliseconds);

        owed.max(self.bounds.body_grace_period)
    }

    /// The one timer, armed at the grace first, then at the deadline the parts so far give, from
    /// now.
    pub(crate) fn rearm(&mut self) {
        let Some(first) = self.first_at else {
            return;
        };
        // the first at the grace itself, as a body's rate is held from its grace (spec 15.12)
        let deadline = if self.timer.is_none() {
            self.bounds.body_grace_period
        } else {
            self.deadline_of()
        };
        let elapsed = self.bounds.clock.monotonic().saturating_sub(first);
        let due = deadline
            .saturating_sub(elapsed)
            .max(Duration::from_millis(1))
            .min(crate::duration::LONGEST_TIMER);
        let late = Arc::clone(&self.late);
        let fired = Arc::new(Mutex::new(Some(())));

        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }

        self.timer = Some(self.bounds.clock.arm(
            Schedule::Once(due),
            Box::new(move || {
                if fired
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take()
                    .is_some()
                {
                    late();
                }
            }),
        ));
    }
}
