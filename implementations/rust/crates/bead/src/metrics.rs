//! A registry of Bead's metrics (`spec/debugging.md` 7 to 12): what the routers given it count,
//! summed, and its exposition in the Prometheus text format 0.0.4, byte for byte as both other
//! sides write it. Bead opens no port.

use core::fmt;
use core::num::NonZeroU16;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::errors::ProgrammerError;
use crate::identity::{Procedure, are_one_name};

#[cfg(test)]
mod tests;

/// What an exposition is given as.
pub const METRICS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

/// The procedures each group of families names at most, when nothing else is given.
pub const MAXIMUM_PROCEDURES: usize = 1_000;

/// How a call ended: its result, a protocol failure by its code, or one of the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum CallEnding {
    /// Its result.
    Result,
    /// No answer within its timeout, for a call made.
    Timeout,
    /// Cancelled.
    Cancelled,
    /// Its connection closed under it.
    Closed,
    /// Anything else.
    Error,
    /// A failure of the procedure's own.
    Application,
    /// A protocol failure of a code section 8 names none of.
    Other,
    /// A protocol failure of a code section 8 names.
    Failure(ProtocolCode),
}

impl CallEnding {
    /// The ending of a call that failed with a failure of `code` and `scope`.
    #[must_use]
    pub fn of_failure(code: NonZeroU16, scope: FailureScope) -> Self {
        if scope == FailureScope::Application {
            return Self::Application;
        }

        let code = ProtocolCode::new(code);

        if code.name().is_some() {
            Self::Failure(code)
        } else {
            Self::Other
        }
    }
}

/// How a registry is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MetricsRegistryOptions {
    /// The procedures its client families name at most, its server families as many, and its
    /// notification families as many: [`MAXIMUM_PROCEDURES`] when none, above 0.
    pub maximum_procedures: Option<usize>,
}

/// A registry's exposition: its media type, and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetricsExposition {
    /// [`METRICS_CONTENT_TYPE`], which Prometheus 3 requires of a target.
    pub content_type: &'static str,
    /// Every line ended by a line feed, the last too; empty while it holds no series.
    pub text: String,
}

// A66's bounds, in microseconds, and each one's `le`, then +Inf's (spec/debugging.md 11.3)
const BOUNDS: [u64; 41] = [
    0,
    10,
    50,
    100,
    300,
    600,
    800,
    1_000,
    2_000,
    3_000,
    4_000,
    5_000,
    6_000,
    8_000,
    10_000,
    13_000,
    16_000,
    20_000,
    25_000,
    30_000,
    40_000,
    50_000,
    65_000,
    80_000,
    100_000,
    130_000,
    160_000,
    200_000,
    250_000,
    300_000,
    400_000,
    500_000,
    650_000,
    800_000,
    1_000_000,
    2_000_000,
    5_000_000,
    10_000_000,
    20_000_000,
    50_000_000,
    100_000_000,
];
const LES: [&str; 42] = [
    "0.0", "1e-05", "5e-05", "0.0001", "0.0003", "0.0006", "0.0008", "0.001", "0.002", "0.003",
    "0.004", "0.005", "0.006", "0.008", "0.01", "0.013", "0.016", "0.02", "0.025", "0.03", "0.04",
    "0.05", "0.065", "0.08", "0.1", "0.13", "0.16", "0.2", "0.25", "0.3", "0.4", "0.5", "0.65",
    "0.8", "1.0", "2.0", "5.0", "10.0", "20.0", "50.0", "100.0", "+Inf",
];

const MICROSECONDS_PER_SECOND: u64 = 1_000_000;

// the codes a procedure's series in the server families can end with (7.6)
const ANSWERED_CODES: [ProtocolCode; 12] = [
    ProtocolCode::SUBSCRIPTION_UNSUPPORTED,
    ProtocolCode::SESSION_REQUIRED,
    ProtocolCode::ACCESS_DENIED,
    ProtocolCode::PAYLOAD_TOO_LARGE,
    ProtocolCode::CAPACITY_EXCEEDED,
    ProtocolCode::CREDENTIAL_UNSUPPORTED,
    ProtocolCode::CHUNK_INVALID,
    ProtocolCode::CREDIT_EXCEEDED,
    ProtocolCode::PAYLOAD_UNDECODABLE,
    ProtocolCode::TRANSFER_STALLED,
    ProtocolCode::PAYLOAD_INVALID,
    ProtocolCode::PROCEDURE_FAILED,
];

/// A family: its name, its help, and its type.
type Family = (&'static str, &'static str, &'static str);

const CLIENT_DURATION: Family = (
    "bead_client_call_duration_seconds",
    "How long each call this side made took, from its start to its end, in seconds.",
    "histogram",
);
const CLIENT_HANDLED: Family = (
    "bead_client_call_handled_total",
    "Each call this side made, as it ended, by its outcome.",
    "counter",
);
const CLIENT_STARTED: Family = (
    "bead_client_call_started_total",
    "Each call this side made, as its router took it.",
    "counter",
);
const HEARD: Family = (
    "bead_notifications_heard_total",
    "Each notification heard under a subscription this side holds.",
    "counter",
);
const SENT: Family = (
    "bead_notifications_sent_total",
    "Each notification for one subscription, handed to its transport or not.",
    "counter",
);
const SERVER_DURATION: Family = (
    "bead_server_call_duration_seconds",
    "How long each call this side answered took, from its arrival to its end, in seconds.",
    "histogram",
);
const SERVER_HANDLED: Family = (
    "bead_server_call_handled_total",
    "Each call this side answered, as it ended, by its outcome.",
    "counter",
);
const SERVER_STARTED: Family = (
    "bead_server_call_started_total",
    "Each call this side answered, as its request opened it.",
    "counter",
);
const DROPPED: Family = (
    "bead_subscriptions_dropped_total",
    "Each subscription ended other than by its client's cancel, at this end.",
    "counter",
);

// a slot of a call family's handled series: its outcome, and its code when it has one
#[derive(Debug, Clone)]
struct Slot {
    outcome: &'static str,
    code: Option<String>,
}

// the handled series a call family's series holds, in exposition order
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    // a procedure's in the server families: its codes
    Answered,
    // _OTHER's in the server families: every code
    AnsweredOther,
    // a procedure's, and _OTHER's, in the client families: every code, and timeout
    Made,
}

// every code, section 8's 23 by their numbers, then application and _OTHER
fn every_code() -> Vec<(CallEnding, String)> {
    let mut codes: Vec<(CallEnding, String)> = ProtocolCode::named()
        .into_iter()
        .map(|code| {
            (
                CallEnding::Failure(code),
                code.name().unwrap_or_default().to_owned(),
            )
        })
        .collect();

    codes.push((CallEnding::Application, "application".to_owned()));
    codes.push((CallEnding::Other, "_OTHER".to_owned()));

    codes
}

impl Layout {
    fn codes(self) -> Vec<(CallEnding, String)> {
        match self {
            Self::Answered => {
                let mut codes: Vec<(CallEnding, String)> = ANSWERED_CODES
                    .iter()
                    .map(|&code| {
                        (
                            CallEnding::Failure(code),
                            code.name().unwrap_or_default().to_owned(),
                        )
                    })
                    .collect();

                codes.push((CallEnding::Application, "application".to_owned()));

                codes
            }
            Self::AnsweredOther | Self::Made => every_code(),
        }
    }

    fn slots(self) -> Vec<Slot> {
        let mut slots = vec![Slot {
            outcome: "result",
            code: None,
        }];

        slots.extend(self.codes().into_iter().map(|(_, code)| Slot {
            outcome: "failure",
            code: Some(code),
        }));

        if self == Self::Made {
            slots.push(Slot {
                outcome: "timeout",
                code: None,
            });
        }

        for outcome in ["cancelled", "closed", "error"] {
            slots.push(Slot {
                outcome,
                code: None,
            });
        }

        slots
    }

    // the slot `ending` counts in: a failure the series holds no code of counts as the nearest it
    // holds, _OTHER, else PROCEDURE_FAILED (spec/debugging.md 9.8); a timeout on a call answered,
    // as an error
    fn slot_of(self, ending: CallEnding) -> usize {
        let codes = self.codes();
        let at = |wanted: CallEnding| {
            codes
                .iter()
                .position(|(code, _)| *code == wanted)
                .map(|index| index.saturating_add(1))
        };
        let count = self.slots().len();
        let error = count.saturating_sub(1);

        match ending {
            CallEnding::Result => 0,
            CallEnding::Timeout => {
                if self == Self::Made {
                    codes.len().saturating_add(1)
                } else {
                    error
                }
            }
            CallEnding::Cancelled => error.saturating_sub(2),
            CallEnding::Closed => error.saturating_sub(1),
            CallEnding::Error => error,
            CallEnding::Application | CallEnding::Other | CallEnding::Failure(_) => at(ending)
                .or_else(|| at(CallEnding::Other))
                .or_else(|| at(CallEnding::Failure(ProtocolCode::PROCEDURE_FAILED)))
                .unwrap_or(error),
        }
    }
}

// one series of the call families: its counts, its buckets, its sum, under its layout
#[derive(Debug, Clone)]
struct CallData {
    layout: Layout,
    buckets: Vec<u64>,
    count: u64,
    handled: Vec<u64>,
    started: u64,
    // its _sum, held exactly: whole seconds, and whole microseconds under one second
    sum_seconds: u64,
    sum_microseconds: u64,
}

impl CallData {
    fn new(layout: Layout) -> Self {
        Self {
            layout,
            buckets: vec![0; LES.len()],
            count: 0,
            handled: vec![0; layout.slots().len()],
            started: 0,
            sum_seconds: 0,
            sum_microseconds: 0,
        }
    }

    fn end(&mut self, ending: CallEnding, microseconds: u64) {
        let slot = self.layout.slot_of(ending);
        let under = microseconds % MICROSECONDS_PER_SECOND;
        let bucket = BOUNDS
            .iter()
            .position(|&bound| microseconds <= bound)
            .unwrap_or(BOUNDS.len());

        if let Some(handled) = self.handled.get_mut(slot) {
            *handled = handled.saturating_add(1);
        }

        if let Some(counted) = self.buckets.get_mut(bucket) {
            *counted = counted.saturating_add(1);
        }

        self.count = self.count.saturating_add(1);
        self.sum_seconds = self
            .sum_seconds
            .saturating_add(microseconds / MICROSECONDS_PER_SECOND);
        self.sum_microseconds = self.sum_microseconds.saturating_add(under);

        if self.sum_microseconds >= MICROSECONDS_PER_SECOND {
            self.sum_microseconds = self
                .sum_microseconds
                .saturating_sub(MICROSECONDS_PER_SECOND);
            self.sum_seconds = self.sum_seconds.saturating_add(1);
        }
    }

    // a _sum of whole seconds and microseconds, written exactly: never an exponent (12.5)
    fn sum(&self) -> String {
        if self.sum_microseconds == 0 {
            return self.sum_seconds.to_string();
        }

        let fraction = format!("{:06}", self.sum_microseconds);

        format!("{}.{}", self.sum_seconds, fraction.trim_end_matches('0'))
    }
}

// a call's type, by its router's side
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum CallType {
    Request,
    Command,
}

impl CallType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Command => "command",
        }
    }
}

// a procedure the registry holds: its one name, and its series in each family, by their place in
// the registry's arena
#[derive(Debug, Default)]
struct Entry {
    name: String,
    made: BTreeMap<CallType, usize>,
    answered: BTreeMap<CallType, usize>,
    // its subscriptions dropped, none first, then under every code
    dropped: Option<Vec<u64>>,
    heard: Option<u64>,
    sent: Option<(u64, u64)>,
}

#[derive(Debug, Default)]
struct State {
    maximum: usize,
    entries: BTreeMap<(u16, u16), Entry>,
    // each group's procedures: the client families', the server families', the notifications'
    made_keys: HashSet<(u16, u16)>,
    answered_keys: HashSet<(u16, u16)>,
    notification_keys: HashSet<(u16, u16)>,
    // each service's names, and the procedure each names
    names: HashMap<u16, Vec<(String, u16)>>,
    // every call series, and _OTHER's in each role, by type
    calls: Vec<CallData>,
    other_made: BTreeMap<CallType, usize>,
    other_answered: BTreeMap<CallType, usize>,
}

// the groups a declaration counts against
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Made,
    Answered,
    Notifications,
}

impl State {
    fn keys_of(&mut self, group: Group) -> &mut HashSet<(u16, u16)> {
        match group {
            Group::Made => &mut self.made_keys,
            Group::Answered => &mut self.answered_keys,
            Group::Notifications => &mut self.notification_keys,
        }
    }

    // the entry `procedure` is declared as, to `groups`, refused as spec/debugging.md 7.3 says
    fn admit(
        &mut self,
        procedure: &Procedure,
        groups: &[Group],
    ) -> Result<(u16, u16), ProgrammerError> {
        let key = (procedure.service_id, procedure.id);
        let at = format!("{}/{}", procedure.service_id, procedure.id);
        let quoted = |name: &str| serde_json::to_string(name).unwrap_or_default();

        // * a name held at its address is taken as it is, exactly, with no fold
        if let Some(held) = self.entries.get(&key)
            && held.name != procedure.name
        {
            return Err(ProgrammerError::new(format!(
                "the metrics registry holds {at} as {}, and is given {}: another name at its address",
                quoted(&held.name),
                quoted(&procedure.name)
            )));
        }

        if !self.entries.contains_key(&key)
            && let Some((name, procedure_id)) =
                self.names.get(&procedure.service_id).and_then(|named| {
                    named
                        .iter()
                        .find(|(name, _)| are_one_name(name, &procedure.name))
                })
        {
            return Err(ProgrammerError::new(format!(
                "the metrics registry holds {} at {}/{procedure_id}, and is given {} at {at}: its name at another address",
                quoted(name),
                procedure.service_id,
                quoted(&procedure.name)
            )));
        }

        let maximum = self.maximum;

        for &group in groups {
            let what = match group {
                Group::Made => "client families",
                Group::Answered => "server families",
                Group::Notifications => "notification families",
            };
            let keys = self.keys_of(group);

            if !keys.contains(&key) && keys.len() >= maximum {
                return Err(ProgrammerError::new(format!(
                    "the metrics registry's {what} name {maximum} procedures at most, and {at} is one more: past the ceiling"
                )));
            }
        }

        for &group in groups {
            self.keys_of(group).insert(key);
        }

        if !self.entries.contains_key(&key) {
            self.names
                .entry(procedure.service_id)
                .or_default()
                .push((procedure.name.clone(), procedure.id));
            self.entries.insert(
                key,
                Entry {
                    name: procedure.name.clone(),
                    ..Entry::default()
                },
            );
        }

        Ok(key)
    }

    fn new_calls(&mut self, layout: Layout) -> usize {
        self.calls.push(CallData::new(layout));
        self.calls.len().saturating_sub(1)
    }
}

/// A registry of Bead's metrics, which a router counts into once given it; one given to two
/// routers sums them.
#[derive(Clone)]
pub struct MetricsRegistry {
    state: Arc<Mutex<State>>,
}

impl fmt::Debug for MetricsRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MetricsRegistry")
            .finish_non_exhaustive()
    }
}

fn locked(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A procedure's series in the call families of one role, under one type: what a router counts a
/// call into, as it starts and as it ends.
#[derive(Clone)]
pub struct ProcedureSeries {
    state: Arc<Mutex<State>>,
    at: usize,
}

impl fmt::Debug for ProcedureSeries {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcedureSeries")
            .field("at", &self.at)
            .finish_non_exhaustive()
    }
}

impl ProcedureSeries {
    /// Counts a call started.
    pub fn start(&self) {
        if let Some(data) = locked(&self.state).calls.get_mut(self.at) {
            data.started = data.started.saturating_add(1);
        }
    }

    /// Counts a call ended, as `ending` says, after `microseconds`, whole.
    pub fn end(&self, ending: CallEnding, microseconds: u64) {
        if let Some(data) = locked(&self.state).calls.get_mut(self.at) {
            data.end(ending, microseconds);
        }
    }
}

/// What a router counts of a procedure's notifications: at the side that notifies, its sent and
/// failed; at the side that hears, its heard; at both, its subscriptions dropped.
#[derive(Clone)]
pub struct NotificationSeries {
    state: Arc<Mutex<State>>,
    key: (u16, u16),
}

impl fmt::Debug for NotificationSeries {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationSeries")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

// the slot a subscription dropped by a failure counts in: its code's, or none's
fn drop_slot_of(failure: Option<(NonZeroU16, FailureScope)>) -> usize {
    let codes = ProtocolCode::named();

    match failure.map(|(code, scope)| CallEnding::of_failure(code, scope)) {
        None => 0,
        Some(CallEnding::Application) => codes.len().saturating_add(1),
        Some(CallEnding::Failure(code)) => {
            codes.iter().position(|named| *named == code).map_or_else(
                || codes.len().saturating_add(2),
                |index| index.saturating_add(1),
            )
        }
        Some(_) => codes.len().saturating_add(2),
    }
}

impl NotificationSeries {
    fn with<F: FnOnce(&mut Entry)>(&self, change: F) {
        if let Some(entry) = locked(&self.state).entries.get_mut(&self.key) {
            change(entry);
        }
    }

    /// Counts a subscription ended, other than by its client's cancel, by the code and the scope
    /// of its failure, or with none.
    pub fn dropped(&self, failure: Option<(NonZeroU16, FailureScope)>) {
        let slot = drop_slot_of(failure);

        self.with(|entry| {
            if let Some(dropped) = entry
                .dropped
                .as_mut()
                .and_then(|dropped| dropped.get_mut(slot))
            {
                *dropped = dropped.saturating_add(1);
            }
        });
    }

    /// Counts a notification handed to its transport for one subscription.
    pub fn sent(&self) {
        self.with(|entry| {
            if let Some((sent, _)) = entry.sent.as_mut() {
                *sent = sent.saturating_add(1);
            }
        });
    }

    /// Counts a notification that could not be handed to its transport for one subscription.
    pub fn failed(&self) {
        self.with(|entry| {
            if let Some((_, failed)) = entry.sent.as_mut() {
                *failed = failed.saturating_add(1);
            }
        });
    }

    /// Counts a notification paired with a subscription its router holds.
    pub fn heard(&self) {
        self.with(|entry| {
            if let Some(heard) = entry.heard.as_mut() {
                *heard = heard.saturating_add(1);
            }
        });
    }
}

/// What a resolver declared counts into: its calls, and its notifications when it notifies.
#[derive(Debug, Clone)]
pub struct ResolverSeries {
    /// Its calls.
    pub calls: ProcedureSeries,
    /// Its notifications, at the side that notifies.
    pub notifying: Option<NotificationSeries>,
}

/// What a router given a registry counts through: its side's declarations, and `_OTHER`'s.
#[derive(Debug, Clone)]
pub struct RouterMetrics {
    registry: MetricsRegistry,
    side: RouterSide,
    other_client: ProcedureSeries,
    other_server: ProcedureSeries,
}

impl RouterMetrics {
    /// `_OTHER`'s series among the calls its side makes.
    #[must_use]
    pub const fn other_client(&self) -> &ProcedureSeries {
        &self.other_client
    }

    /// `_OTHER`'s series among the calls its side answers.
    #[must_use]
    pub const fn other_server(&self) -> &ProcedureSeries {
        &self.other_server
    }

    // the types a router of its side makes and answers (8.2)
    fn types(&self) -> (CallType, CallType) {
        match self.side {
            RouterSide::Client => (CallType::Request, CallType::Command),
            RouterSide::Server => (CallType::Command, CallType::Request),
        }
    }

    /// A requester made, its series in the families of the calls its side makes.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a declaration the registry refuses (spec/debugging.md 7.3).
    pub fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<ProcedureSeries, ProgrammerError> {
        let (made, _) = self.types();
        let mut state = locked(&self.registry.state);
        let key = state.admit(procedure, &[Group::Made])?;
        let known = state
            .entries
            .get(&key)
            .and_then(|entry| entry.made.get(&made).copied());
        let at = known.unwrap_or_else(|| {
            let at = state.new_calls(Layout::Made);

            if let Some(entry) = state.entries.get_mut(&key) {
                entry.made.insert(made, at);
            }

            at
        });

        drop(state);

        Ok(ProcedureSeries {
            state: Arc::clone(&self.registry.state),
            at,
        })
    }

    /// A resolver registered, its series in the families of the calls its side answers; and, when
    /// its procedure `notifies`, in those of the side that notifies.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a declaration the registry refuses (spec/debugging.md 7.3).
    pub fn declare_resolver(
        &self,
        procedure: &Procedure,
        notifies: bool,
    ) -> Result<ResolverSeries, ProgrammerError> {
        let (_, answered) = self.types();
        let mut state = locked(&self.registry.state);
        let groups: &[Group] = if notifies {
            &[Group::Answered, Group::Notifications]
        } else {
            &[Group::Answered]
        };
        let key = state.admit(procedure, groups)?;
        let known = state
            .entries
            .get(&key)
            .and_then(|entry| entry.answered.get(&answered).copied());
        let at = known.unwrap_or_else(|| {
            let at = state.new_calls(Layout::Answered);

            if let Some(entry) = state.entries.get_mut(&key) {
                entry.answered.insert(answered, at);
            }

            at
        });

        if notifies && let Some(entry) = state.entries.get_mut(&key) {
            entry.sent.get_or_insert((0, 0));
            entry
                .dropped
                .get_or_insert_with(|| vec![0; ProtocolCode::named().len().saturating_add(3)]);
        }

        drop(state);

        Ok(ResolverSeries {
            calls: ProcedureSeries {
                state: Arc::clone(&self.registry.state),
                at,
            },
            notifying: notifies.then(|| NotificationSeries {
                state: Arc::clone(&self.registry.state),
                key,
            }),
        })
    }

    /// A notification registered, on the side that hears.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a declaration the registry refuses (spec/debugging.md 7.3).
    pub fn declare_notification(
        &self,
        procedure: &Procedure,
    ) -> Result<NotificationSeries, ProgrammerError> {
        let mut state = locked(&self.registry.state);
        let key = state.admit(procedure, &[Group::Notifications])?;

        if let Some(entry) = state.entries.get_mut(&key) {
            entry.heard.get_or_insert(0);
            entry
                .dropped
                .get_or_insert_with(|| vec![0; ProtocolCode::named().len().saturating_add(3)]);
        }

        drop(state);

        Ok(NotificationSeries {
            state: Arc::clone(&self.registry.state),
            key,
        })
    }
}

// a label's value as 0.0.4 writes one: `\`, `"` and line feed escaped
fn label_value_of(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

impl MetricsRegistry {
    /// A registry, its ceiling as `options` say.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a ceiling of 0.
    pub fn new(options: &MetricsRegistryOptions) -> Result<Self, ProgrammerError> {
        let maximum = options.maximum_procedures.unwrap_or(MAXIMUM_PROCEDURES);

        if maximum < 1 {
            return Err(ProgrammerError::new(format!(
                "maximumProcedures is a whole number above 0, not {maximum}"
            )));
        }

        Ok(Self {
            state: Arc::new(Mutex::new(State {
                maximum,
                ..State::default()
            })),
        })
    }

    /// What a router of `side` given the registry counts through, its `_OTHER` series made at 0 as
    /// it is given it; a router calls it as it is built.
    #[must_use]
    pub fn attach(&self, side: RouterSide) -> RouterMetrics {
        let (made, answered) = match side {
            RouterSide::Client => (CallType::Request, CallType::Command),
            RouterSide::Server => (CallType::Command, CallType::Request),
        };
        let mut state = locked(&self.state);
        let other_client = if let Some(&at) = state.other_made.get(&made) {
            at
        } else {
            let at = state.new_calls(Layout::Made);

            state.other_made.insert(made, at);
            at
        };
        let other_server = if let Some(&at) = state.other_answered.get(&answered) {
            at
        } else {
            let at = state.new_calls(Layout::AnsweredOther);

            state.other_answered.insert(answered, at);
            at
        };

        drop(state);

        RouterMetrics {
            registry: self.clone(),
            side,
            other_client: ProcedureSeries {
                state: Arc::clone(&self.state),
                at: other_client,
            },
            other_server: ProcedureSeries {
                state: Arc::clone(&self.state),
                at: other_server,
            },
        }
    }

    /// Every series it holds, written as Prometheus scrapes 0.0.4, with its media type.
    #[must_use]
    #[expect(
        clippy::too_many_lines,
        reason = "one exposition, its families in the order the text format writes them"
    )]
    pub fn exposition(&self) -> MetricsExposition {
        let state = locked(&self.state);
        let mut lines: Vec<String> = Vec::new();
        let labels_of = |key: Option<&(u16, u16)>| -> String {
            match key.and_then(|key| state.entries.get(key).map(|entry| (key.0, &entry.name))) {
                Some((service, name)) => {
                    format!(
                        "service=\"{service}\",procedure=\"{}\"",
                        label_value_of(name)
                    )
                }
                None => "service=\"_OTHER\",procedure=\"_OTHER\"".to_owned(),
            }
        };
        let mut write_family = |(name, help, family): Family, samples: Vec<String>| {
            if !samples.is_empty() {
                lines.push(format!("# HELP {name} {help}"));
                lines.push(format!("# TYPE {name} {family}"));
                lines.extend(samples);
            }
        };
        let call_series = |is_made: bool| -> Vec<(String, &CallData)> {
            let mut series = Vec::new();
            let mut each = |key: Option<&(u16, u16)>, by_type: &BTreeMap<CallType, usize>| {
                for call_type in [CallType::Request, CallType::Command] {
                    if let Some(data) = by_type.get(&call_type).and_then(|&at| state.calls.get(at))
                    {
                        series.push((
                            format!("{},type=\"{}\"", labels_of(key), call_type.as_str()),
                            data,
                        ));
                    }
                }
            };

            for (key, entry) in &state.entries {
                each(
                    Some(key),
                    if is_made {
                        &entry.made
                    } else {
                        &entry.answered
                    },
                );
            }

            each(
                None,
                if is_made {
                    &state.other_made
                } else {
                    &state.other_answered
                },
            );

            series
        };
        let calls = |is_made: bool, (duration, handled, started): (Family, Family, Family)| {
            let series = call_series(is_made);
            let durations = series
                .iter()
                .flat_map(|(labels, data)| {
                    let mut running = 0_u64;
                    let mut samples: Vec<String> = LES
                        .iter()
                        .enumerate()
                        .map(|(index, le)| {
                            running = running
                                .saturating_add(data.buckets.get(index).copied().unwrap_or(0));

                            format!("{}_bucket{{{labels},le=\"{le}\"}} {running}", duration.0)
                        })
                        .collect();

                    samples.push(format!("{}_sum{{{labels}}} {}", duration.0, data.sum()));
                    samples.push(format!("{}_count{{{labels}}} {}", duration.0, data.count));

                    samples
                })
                .collect::<Vec<_>>();
            let handles = series
                .iter()
                .flat_map(|(labels, data)| {
                    data.layout
                        .slots()
                        .into_iter()
                        .enumerate()
                        .map(|(slot, Slot { outcome, code })| {
                            let coded = code
                                .map(|code| format!(",code=\"{code}\""))
                                .unwrap_or_default();

                            format!(
                                "{}{{{labels},outcome=\"{outcome}\"{coded}}} {}",
                                handled.0,
                                data.handled.get(slot).copied().unwrap_or(0)
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let starts = series
                .iter()
                .map(|(labels, data)| format!("{}{{{labels}}} {}", started.0, data.started))
                .collect::<Vec<_>>();

            [(duration, durations), (handled, handles), (started, starts)]
        };

        for (family, samples) in calls(true, (CLIENT_DURATION, CLIENT_HANDLED, CLIENT_STARTED)) {
            write_family(family, samples);
        }

        write_family(
            HEARD,
            state
                .entries
                .iter()
                .filter_map(|(key, entry)| {
                    entry
                        .heard
                        .map(|heard| format!("{}{{{}}} {heard}", HEARD.0, labels_of(Some(key))))
                })
                .collect(),
        );
        write_family(
            SENT,
            state
                .entries
                .iter()
                .flat_map(|(key, entry)| {
                    entry.sent.map_or_else(Vec::new, |(sent, failed)| {
                        vec![
                            format!(
                                "{}{{{},outcome=\"sent\"}} {sent}",
                                SENT.0,
                                labels_of(Some(key))
                            ),
                            format!(
                                "{}{{{},outcome=\"failed\"}} {failed}",
                                SENT.0,
                                labels_of(Some(key))
                            ),
                        ]
                    })
                })
                .collect(),
        );

        for (family, samples) in calls(false, (SERVER_DURATION, SERVER_HANDLED, SERVER_STARTED)) {
            write_family(family, samples);
        }

        let codes = ProtocolCode::named();

        write_family(
            DROPPED,
            state
                .entries
                .iter()
                .flat_map(|(key, entry)| {
                    entry.dropped.as_ref().map_or_else(Vec::new, |dropped| {
                        dropped
                            .iter()
                            .enumerate()
                            .map(|(slot, count)| {
                                let code = if slot == 0 {
                                    String::new()
                                } else if slot == codes.len().saturating_add(1) {
                                    ",code=\"application\"".to_owned()
                                } else if slot == codes.len().saturating_add(2) {
                                    ",code=\"_OTHER\"".to_owned()
                                } else {
                                    let name = codes
                                        .get(slot.saturating_sub(1))
                                        .and_then(|code| code.name())
                                        .unwrap_or_default();

                                    format!(",code=\"{name}\"")
                                };

                                format!("{}{{{}{code}}} {count}", DROPPED.0, labels_of(Some(key)))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect(),
        );

        drop(state);

        MetricsExposition {
            content_type: METRICS_CONTENT_TYPE,
            text: if lines.is_empty() {
                String::new()
            } else {
                format!("{}\n", lines.join("\n"))
            },
        }
    }
}
