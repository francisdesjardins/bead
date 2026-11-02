//! What a router holds of each connection that its turns have not taken yet (spec 15.12, decision
//! 0046): each envelope its transport hands it, counted as it is handed, and released once the turn
//! that took it returned. The envelope that reaches a bound is taken; past it the connection is
//! paused, and resumed once both counts are at half their bound or below, as a pipe's writer pauses
//! at one threshold and resumes at another. What the router does of its own never meets the count.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::ordered::Ordered;
use crate::router::types::{ConnectionHandle, IntakeLimits};

#[cfg(test)]
mod tests;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// one connection's untaken envelopes, their bytes, and whether its transport is paused
#[derive(Debug, Clone, Copy, Default)]
struct Untaken {
    envelopes: u64,
    bytes: u64,
    is_paused: bool,
}

#[derive(Debug, Default)]
struct Counts {
    // by connection, in the order each was first counted, so an end resumes them in that order
    untaken: Ordered<ConnectionHandle, Untaken>,
    is_ended: bool,
}

/// What one router's transport handed it that no turn took yet, per connection, and the
/// connections it paused for it.
#[derive(Debug)]
pub(crate) struct Intake {
    limits: IntakeLimits,
    counts: Mutex<Counts>,
}

impl Intake {
    /// An intake of `limits`, nothing counted.
    pub(crate) fn new(limits: IntakeLimits) -> Arc<Self> {
        Arc::new(Self {
            limits,
            counts: Mutex::default(),
        })
    }

    // both counts at half their bound or below: with a bound of 1, half is 0
    const fn is_low(&self, untaken: Untaken) -> bool {
        untaken.envelopes <= self.limits.maximum_untaken_envelopes.div_euclid(2)
            && untaken.bytes <= self.limits.maximum_untaken_bytes.div_euclid(2)
    }

    /// An envelope of `bytes` its transport handed on `handle`: counted, and the connection paused
    /// by `pause` once either count reaches its bound, the envelope that reached it taken all the
    /// same. False once the intake ended, nothing counted.
    #[expect(
        clippy::significant_drop_tightening,
        reason = "the transport is paused under the lock, so a pause and a resume reach it in the order decided"
    )]
    pub(crate) fn handed<P: FnOnce(&ConnectionHandle)>(
        &self,
        (handle, bytes): (&ConnectionHandle, u64),
        pause: P,
    ) -> bool {
        let mut counts = locked(&self.counts);

        if counts.is_ended {
            return false;
        }

        let Some(untaken) = counts
            .untaken
            .entry_or_insert_with(Arc::clone(handle), Untaken::default)
        else {
            return false;
        };

        untaken.envelopes = untaken.envelopes.saturating_add(1);
        untaken.bytes = untaken.bytes.saturating_add(bytes);

        let is_reached = untaken.envelopes >= self.limits.maximum_untaken_envelopes
            || untaken.bytes >= self.limits.maximum_untaken_bytes;

        if is_reached && !untaken.is_paused {
            untaken.is_paused = true;
            // ! called under the lock that guards the counts, so a pause from a reader's thread and
            // a resume from the owner's turn reach the transport in the order they were decided: a
            // transport's pair takes no lock it holds while it tells a listener, and tells none
            pause(handle);
        }

        true
    }

    /// The envelope of `bytes` handed on `handle` taken: released, and the connection resumed by
    /// `resume` once both counts are at half their bound or below. Nothing for an intake ended, or
    /// a connection forgotten.
    pub(crate) fn taken<R: FnOnce(&ConnectionHandle)>(
        &self,
        (handle, bytes): (&ConnectionHandle, u64),
        resume: R,
    ) {
        let mut counts = locked(&self.counts);

        if counts.is_ended {
            return;
        }

        let Some(untaken) = counts.untaken.get_mut(handle) else {
            return;
        };

        untaken.envelopes = untaken.envelopes.saturating_sub(1);
        untaken.bytes = untaken.bytes.saturating_sub(bytes);

        let is_settled = untaken.envelopes == 0;
        let is_resumed = untaken.is_paused && self.is_low(*untaken);

        if is_resumed {
            untaken.is_paused = false;
            // ! under the lock, as `handed` pauses: see there
            resume(handle);
        }

        if is_settled && !untaken.is_paused {
            counts.untaken.remove(handle);
        }
    }

    /// Forgets what it counted of `handle`, a connection closed: its transport resumes nothing of
    /// it.
    pub(crate) fn forget(&self, handle: &ConnectionHandle) {
        locked(&self.counts).untaken.remove(handle);
    }

    /// Ends, its router ended: each connection it paused resumed by `resume`, in the order each was
    /// first counted, under the lock, and nothing counted from now on, so no pause comes after.
    pub(crate) fn end<R: FnMut(&ConnectionHandle)>(&self, mut resume: R) {
        let mut counts = locked(&self.counts);

        counts.is_ended = true;

        for (handle, untaken) in counts.untaken.drain() {
            if untaken.is_paused {
                // ! under the lock, as `handed` pauses: see there
                resume(&handle);
            }
        }
    }

    /// The connections it holds paused, in the order each was first counted.
    #[cfg(test)]
    pub(crate) fn paused(&self) -> Vec<ConnectionHandle> {
        locked(&self.counts)
            .untaken
            .iter()
            .filter(|(_, untaken)| untaken.is_paused)
            .map(|(handle, _)| Arc::clone(handle))
            .collect()
    }
}
