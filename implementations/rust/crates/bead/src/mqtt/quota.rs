//! The send quota of one incarnation of a link (MQTT 5.0 §4.9, [MQTT-3.3.4-7], [-8]; spec 15.28): at
//! most its CONNACK's Receive Maximum of its PUBLISH packets of `QoS` 1 unacknowledged, each PUBACK
//! replenishing it, later ones waiting in their order and handed back to be sent as it frees; no
//! other packet waits for it. A publication that waits and is given up leaves the queue, nothing
//! sent; the incarnation's end gives back every one that waits, to be failed, and takes none after
//! it. Its link's owner holds it, and sends what it hands back in the turn it is handed.

use std::collections::VecDeque;

use tokio_util::sync::CancellationToken;

#[cfg(test)]
mod tests;

/// What became of a publication asked of a quota.
#[derive(Debug)]
pub(crate) enum Queued<T> {
    /// Its room had place and nothing waited before it: to be sent now, counted in flight.
    Send(T),
    /// It waits for room, in its order.
    Waiting,
    /// Its signal was cancelled already: nothing sent, nothing queued.
    GivenUp(T),
    /// The quota ended: nothing sent, nothing queued.
    Ended(T),
}

/// The send quota of one incarnation.
#[derive(Debug)]
pub(crate) struct SendQuota<T> {
    receive_maximum: usize,
    in_flight: usize,
    waiting: VecDeque<(u64, T)>,
    is_ended: bool,
}

impl<T> SendQuota<T> {
    /// A quota of `receive_maximum` PUBLISH packets unacknowledged: 65,535 where a CONNACK names
    /// none, never 0, which a CONNACK never names.
    pub(crate) fn new(receive_maximum: u16) -> Self {
        Self {
            receive_maximum: usize::from(receive_maximum.max(1)),
            in_flight: 0,
            waiting: VecDeque::new(),
            is_ended: false,
        }
    }

    /// The PUBLISH packets sent and not yet acknowledged.
    #[cfg(test)]
    pub(crate) const fn in_flight(&self) -> usize {
        self.in_flight
    }

    /// The publications that wait for room.
    #[cfg(test)]
    pub(crate) fn queued(&self) -> usize {
        self.waiting.len()
    }

    /// Whether nothing waits and nothing sent is unacknowledged, or it ended: what its link's stop
    /// awaits before its UNSUBSCRIBEs and its DISCONNECT, so that what it was handed goes first
    /// (spec 15.24).
    pub(crate) fn is_drained(&self) -> bool {
        self.is_ended || (self.waiting.is_empty() && self.in_flight == 0)
    }

    /// Asks room for `item`, known by `key`, given up already where `signal` is cancelled: sent at
    /// once where its room has place and nothing waits before it, queued in its order otherwise.
    pub(crate) fn enqueue(
        &mut self,
        (key, item): (u64, T),
        signal: Option<&CancellationToken>,
    ) -> Queued<T> {
        if self.is_ended {
            return Queued::Ended(item);
        }

        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Queued::GivenUp(item);
        }

        if self.waiting.is_empty() && self.in_flight < self.receive_maximum {
            self.in_flight = self.in_flight.saturating_add(1);

            return Queued::Send(item);
        }

        self.waiting.push_back((key, item));

        Queued::Waiting
    }

    /// A PUBACK came: one more of room, and what waits handed back to be sent, in its order, each
    /// counted in flight.
    pub(crate) fn release(&mut self) -> Vec<T> {
        if self.is_ended {
            return Vec::new();
        }

        self.in_flight = self.in_flight.saturating_sub(1);

        let mut freed = Vec::new();

        while self.in_flight < self.receive_maximum
            && let Some((_, next)) = self.waiting.pop_front()
        {
            self.in_flight = self.in_flight.saturating_add(1);
            freed.push(next);
        }

        freed
    }

    /// The publication known by `key`, given up while it waits: out of the queue, nothing sent;
    /// none where it went already or is none of its own.
    pub(crate) fn leave(&mut self, key: u64) -> Option<T> {
        let index = self.waiting.iter().position(|(held, _)| *held == key)?;

        self.waiting.remove(index).map(|(_, item)| item)
    }

    /// The incarnation ended: every publication that waits handed back to be failed, and none
    /// taken after it; a second end hands back nothing.
    pub(crate) fn end(&mut self) -> Vec<T> {
        self.is_ended = true;

        self.waiting.drain(..).map(|(_, item)| item).collect()
    }
}
