//! Who asked to be notified of which procedure (spec 11): each subscription under the call id of the
//! request that made it, held by a session of its connection's, one subscription a procedure for
//! each; and a paced subscription's credit and queue (spec 11.7 to 11.11).

use std::sync::Arc;

use bytes::Bytes;

use crate::errors::ProgrammerError;
use crate::failure::ProcedureAddress;
use crate::metrics::NotificationSeries;
use crate::ordered::Ordered;
use crate::router::types::{ConnectionHandle, Gauges, SessionIdentifier, session_key_of};

#[cfg(test)]
mod tests;

/// What a paced subscription queues at most.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacingLimits {
    /// The bytes of the notifications queued.
    pub maximum_queued_notification_bytes: u64,
    /// The notifications queued.
    pub maximum_queued_notifications: u64,
}

/// What a paced subscription queues at most, unless its router says otherwise.
pub const PACING_DEFAULTS: PacingLimits = PacingLimits {
    maximum_queued_notification_bytes: 1_048_576,
    maximum_queued_notifications: 64,
};

/// A paced subscription's limits as options give them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PacingLimitsOptions {
    /// See [`PacingLimits::maximum_queued_notification_bytes`].
    pub maximum_queued_notification_bytes: Option<u64>,
    /// See [`PacingLimits::maximum_queued_notifications`].
    pub maximum_queued_notifications: Option<u64>,
}

/// `options` over [`PACING_DEFAULTS`].
///
/// # Errors
///
/// A [`ProgrammerError`] for a limit of 0.
pub fn pacing_limits_of(options: &PacingLimitsOptions) -> Result<PacingLimits, ProgrammerError> {
    let limits = PacingLimits {
        maximum_queued_notification_bytes: options
            .maximum_queued_notification_bytes
            .unwrap_or(PACING_DEFAULTS.maximum_queued_notification_bytes),
        maximum_queued_notifications: options
            .maximum_queued_notifications
            .unwrap_or(PACING_DEFAULTS.maximum_queued_notifications),
    };

    for (name, value) in [
        (
            "maximumQueuedNotificationBytes",
            limits.maximum_queued_notification_bytes,
        ),
        (
            "maximumQueuedNotifications",
            limits.maximum_queued_notifications,
        ),
    ] {
        if value < 1 {
            return Err(ProgrammerError::new(format!(
                "{name} is a whole number above 0, not {value}"
            )));
        }
    }

    Ok(limits)
}

/// What a paced subscription does with a notification offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PacingOutcome {
    Send,
    Queued,
    Exceeded,
}

/// What a notification is about, for a paced subscription to keep the latest of each.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum NotificationKey {
    /// A number.
    Number(i64),
    /// A string.
    Text(String),
}

// a slot of a pacing's queue: a key given, or one of its own no other matches
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Slot {
    Keyed(NotificationKey),
    Unkeyed(u64),
}

/// One paced subscription's credit and queue: past its credit, a notification is queued, one with a
/// key taking the place of the one queued under that key, which keeps its place in the queue.
#[derive(Debug, Clone)]
pub(crate) struct Pacing {
    limits: PacingLimits,
    queue: Vec<(Slot, Bytes)>,
    credit_end: u64,
    queued_bytes: u64,
    sent: u64,
    unkeyed: u64,
}

impl Pacing {
    pub(crate) fn new(limits: PacingLimits) -> Self {
        Self {
            limits,
            queue: Vec::new(),
            credit_end: 1,
            queued_bytes: 0,
            sent: 0,
            unkeyed: 0,
        }
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.sent >= self.credit_end
    }

    pub(crate) fn queued_notification_bytes(&self) -> u64 {
        self.queued_bytes
    }

    pub(crate) fn queued_notifications(&self) -> u64 {
        u64::try_from(self.queue.len()).unwrap_or(u64::MAX)
    }

    /// Raises the count it may have been sent, and gives what the credit lets go, in order.
    pub(crate) fn credit(&mut self, end: u64) -> Vec<Bytes> {
        let mut released = Vec::new();

        self.credit_end = self.credit_end.max(end);

        while self.sent < self.credit_end && !self.queue.is_empty() {
            let (_, payload) = self.queue.remove(0);

            self.queued_bytes = self
                .queued_bytes
                .saturating_sub(u64::try_from(payload.len()).unwrap_or(u64::MAX));
            self.sent = self.sent.saturating_add(1);
            released.push(payload);
        }

        released
    }

    /// Offers a notification: sent at once while credit is left, queued otherwise.
    pub(crate) fn offer(
        &mut self,
        (key, payload): (Option<NotificationKey>, Bytes),
    ) -> PacingOutcome {
        // credit left means nothing is queued: what the credit let go went at once
        if self.sent < self.credit_end {
            self.sent = self.sent.saturating_add(1);

            return PacingOutcome::Send;
        }

        let slot = key.map_or_else(
            || {
                self.unkeyed = self.unkeyed.saturating_add(1);
                Slot::Unkeyed(self.unkeyed)
            },
            Slot::Keyed,
        );
        let length = u64::try_from(payload.len()).unwrap_or(u64::MAX);

        if let Some(queued) = self.queue.iter_mut().find(|(held, _)| *held == slot) {
            self.queued_bytes = self
                .queued_bytes
                .saturating_sub(u64::try_from(queued.1.len()).unwrap_or(u64::MAX))
                .saturating_add(length);
            queued.1 = payload;
        } else {
            self.queued_bytes = self.queued_bytes.saturating_add(length);
            self.queue.push((slot, payload));
        }

        if self.queued_notifications() > self.limits.maximum_queued_notifications
            || self.queued_bytes > self.limits.maximum_queued_notification_bytes
        {
            PacingOutcome::Exceeded
        } else {
            PacingOutcome::Queued
        }
    }
}

/// A subscription as it is handed out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Subscription {
    pub(crate) call_id: u32,
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) procedure: ProcedureAddress,
    pub(crate) identifier: Option<SessionIdentifier>,
}

/// A call that subscribes: where, in which session, until when, paced or not, counted where.
#[derive(Debug, Clone)]
pub(crate) struct SubscribingCall {
    pub(crate) call_id: u32,
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) end: Option<i64>,
    pub(crate) identifier: Option<SessionIdentifier>,
    pub(crate) paced: bool,
    pub(crate) series: Option<NotificationSeries>,
}

#[derive(Debug, Clone)]
struct Target {
    procedure: ProcedureAddress,
    identifier: Option<SessionIdentifier>,
    session_key: String,
    pacing: Option<Pacing>,
    series: Option<NotificationSeries>,
}

/// Who asked to be notified of which procedure, each subscription under the call id of the request
/// that made it.
#[derive(Debug)]
pub(crate) struct NotificationManager {
    limits: PacingLimits,
    // by procedure, then connection, then session key, each in the order it came: the call id
    candidates: Ordered<ProcedureAddress, Ordered<ConnectionHandle, Ordered<String, u32>>>,
    // by connection and call id, each in the order it came: the subscription
    targets: Ordered<ConnectionHandle, Ordered<u32, Target>>,
}

impl NotificationManager {
    pub(crate) fn new(limits: PacingLimits) -> Self {
        Self {
            limits,
            candidates: Ordered::new(),
            targets: Ordered::new(),
        }
    }

    pub(crate) fn has(&self, call_id: u32, handle: &ConnectionHandle) -> bool {
        self.targets
            .get(handle)
            .is_some_and(|calls| calls.contains_key(&call_id))
    }

    pub(crate) fn pacing_of(
        &mut self,
        call_id: u32,
        handle: &ConnectionHandle,
    ) -> Option<&mut Pacing> {
        self.targets
            .get_mut(handle)
            .and_then(|calls| calls.get_mut(&call_id))
            .and_then(|target| target.pacing.as_mut())
    }

    pub(crate) fn series_of(
        &self,
        call_id: u32,
        handle: &ConnectionHandle,
    ) -> Option<NotificationSeries> {
        self.targets
            .get(handle)
            .and_then(|calls| calls.get(&call_id))
            .and_then(|target| target.series.clone())
    }

    /// The call id of the subscription a connection holds to `procedure` in a session.
    pub(crate) fn subscription_of(
        &self,
        procedure: ProcedureAddress,
        (handle, identifier): (&ConnectionHandle, Option<&SessionIdentifier>),
    ) -> Option<u32> {
        self.candidates
            .get(&procedure)
            .and_then(|connections| connections.get(handle))
            .and_then(|sessions| sessions.get(&session_key_of(identifier)))
            .copied()
    }

    /// Every subscription of `procedure`, in order.
    pub(crate) fn candidates(&self, procedure: ProcedureAddress) -> Vec<Subscription> {
        self.candidates
            .get(&procedure)
            .map_or_else(Vec::new, |connections| {
                connections
                    .iter()
                    .flat_map(|(handle, sessions)| {
                        sessions.values().map(|&call_id| Subscription {
                            call_id,
                            connection_handle: Arc::clone(handle),
                            procedure,
                            identifier: self
                                .targets
                                .get(handle)
                                .and_then(|calls| calls.get(&call_id))
                                .and_then(|target| target.identifier.clone()),
                        })
                    })
                    .collect()
            })
    }

    /// Registers a subscription; the first of a session wins.
    pub(crate) fn register(
        &mut self,
        procedure: ProcedureAddress,
        call: &SubscribingCall,
    ) -> Result<u32, ProgrammerError> {
        let handle = &call.connection_handle;

        if let Some(holder) = self.subscription_of(procedure, (handle, call.identifier.as_ref())) {
            return Err(ProgrammerError::new(format!(
                "{handle} is subscribed to {}/{} in that session under call {holder} already",
                procedure.service_id, procedure.procedure_id
            )));
        }

        if self.has(call.call_id, handle) {
            return Err(ProgrammerError::new(format!(
                "{handle} holds call {} already",
                call.call_id
            )));
        }

        let session_key = session_key_of(call.identifier.as_ref());

        let limits = self.limits;

        if let Some(sessions) = self
            .candidates
            .entry_or_insert_with(procedure, Ordered::new)
            .and_then(|connections| {
                connections.entry_or_insert_with(Arc::clone(handle), Ordered::new)
            })
        {
            sessions.insert(session_key.clone(), call.call_id);
        }

        if let Some(calls) = self
            .targets
            .entry_or_insert_with(Arc::clone(handle), Ordered::new)
        {
            calls.insert(
                call.call_id,
                Target {
                    procedure,
                    identifier: call.identifier.clone(),
                    session_key,
                    pacing: call.paced.then(|| Pacing::new(limits)),
                    series: call.series.clone(),
                },
            );
        }

        Ok(call.call_id)
    }

    fn remove(&mut self, (handle, call_id): (&ConnectionHandle, u32)) -> Option<Target> {
        let calls = self.targets.get_mut(handle)?;
        let target = calls.remove(&call_id)?;

        if calls.is_empty() {
            self.targets.remove(handle);
        }

        if let Some(connections) = self.candidates.get_mut(&target.procedure) {
            if let Some(sessions) = connections.get_mut(handle) {
                sessions.remove(&target.session_key);

                if sessions.is_empty() {
                    connections.remove(handle);
                }
            }

            if connections.is_empty() {
                self.candidates.remove(&target.procedure);
            }
        }

        Some(target)
    }

    /// Takes a subscription out: its call id, or none for one the connection does not hold.
    pub(crate) fn unregister(
        &mut self,
        call_id: u32,
        handle: &ConnectionHandle,
    ) -> Option<Subscription> {
        self.remove((handle, call_id)).map(|target| Subscription {
            call_id,
            connection_handle: Arc::clone(handle),
            procedure: target.procedure,
            identifier: target.identifier,
        })
    }

    /// Every subscription a connection holds, or every connection's.
    pub(crate) fn subscriptions(&self, handle: Option<&ConnectionHandle>) -> Vec<Subscription> {
        self.targets
            .iter()
            .filter(|(held, _)| handle.is_none_or(|handle| *held == handle))
            .flat_map(|(held, calls)| {
                calls.iter().map(|(&call_id, target)| Subscription {
                    call_id,
                    connection_handle: Arc::clone(held),
                    procedure: target.procedure,
                    identifier: target.identifier.clone(),
                })
            })
            .collect()
    }

    /// Forgets what a connection holds, as it closes.
    pub(crate) fn clean(&mut self, handle: &ConnectionHandle) {
        let calls: Vec<u32> = self
            .targets
            .get(handle)
            .map(|calls| calls.keys().copied().collect())
            .unwrap_or_default();

        for call_id in calls {
            self.remove((handle, call_id));
        }
    }

    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();
        let (mut largest_bytes, mut largest, mut paused, mut bytes, mut queued) =
            (0, 0, 0_u64, 0_u64, 0_u64);
        let mut subscribed = 0_u64;

        for calls in self.targets.values() {
            for target in calls.values() {
                subscribed = subscribed.saturating_add(1);

                if let Some(pacing) = &target.pacing {
                    largest_bytes = largest_bytes.max(pacing.queued_notification_bytes());
                    largest = largest.max(pacing.queued_notifications());
                    paused = paused.saturating_add(u64::from(pacing.is_paused()));
                    bytes = bytes.saturating_add(pacing.queued_notification_bytes());
                    queued = queued.saturating_add(pacing.queued_notifications());
                }
            }
        }

        gauges.ceilings.insert(
            "largestQueuedNotificationBytes",
            self.limits.maximum_queued_notification_bytes,
        );
        gauges.ceilings.insert(
            "largestQueuedNotifications",
            self.limits.maximum_queued_notifications,
        );
        gauges
            .counts
            .insert("largestQueuedNotificationBytes", largest_bytes);
        gauges.counts.insert("largestQueuedNotifications", largest);
        gauges.counts.insert("pausedSubscriptions", paused);
        gauges.counts.insert("queuedNotificationBytes", bytes);
        gauges.counts.insert("queuedNotifications", queued);
        gauges.counts.insert("notifiedSubscriptions", subscribed);
        gauges
            .connection_handles
            .extend(self.targets.keys().cloned());

        gauges
    }
}
