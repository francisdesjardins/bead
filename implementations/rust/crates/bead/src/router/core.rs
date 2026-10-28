//! What both sides of a router do alike (spec 9 to 12): write what goes out, take what comes in —
//! read, checked, traced, then dispatched by kind — pair each answer with its call, send a payload
//! too large for one envelope as a transfer and put together one that comes as a transfer, and hand
//! each request to the handler registered for it. What sets a side apart is its [`Side`]: its
//! failures, how it sends, the session its answers announce, the call ids it holds, what it does
//! with a notification, and what an answer does first.
//!
//! Every function here runs in a turn of the router's owner, on its state: what waits — a resolver,
//! a verifier, a transport's send, a timer — runs off it and posts its outcome as a job of its own.

use core::fmt;
use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;

use crate::clock::{Schedule, SharedClock, Timer};
use crate::constants::{
    CredentialScheme, EnvelopeKind, EnvelopeLayout, FailureScope, ProtocolCode, RouterSide,
};
use crate::debug::DebugDirection;
use crate::envelope::{
    CancelHeader, Credential, CreditHeader, Envelope, FailureHeader, FailureRecord, Header,
    NotificationHeader, Prefix, ReadEnvelopeOptions, RequestHeader, ResultHeader, read_envelope,
    read_prefix, write_envelope,
};
use crate::errors::{CallError, CapacityError, ProgrammerError, ResolverError};
use crate::failure::Failure;
use crate::metrics::{CallEnding, ProcedureSeries, ResolverSeries, RouterMetrics};
use crate::owner::{Job, WeakOwner};
use crate::router::parts::{
    Announcements, Answering, AnsweringCalls, PendingCalls, Placed, Placement, ReceivingTransfers,
    RequestReceiving, SendingFor, SendingTransfers, cancel_timer,
};
use crate::router::transfer::{Chunk, ChunkOutcome};
use crate::router::types::{
    AccessRefusal, AccessRefusalStage, BoxFuture, CallAddress, CallSession, ConnectionHandle,
    Gauges, RouterActivity, RouterAnswer, RouterError, RouterLimits, Signal, SignalReason,
    TransportMessage,
};
use crate::session_token::SessionToken;
use crate::transport::Sent;
use crate::violations::detail_bound_of;

/// What a router's handlers are told the router was disposed with.
pub(crate) const DISPOSED: &str = "the router was disposed";

// SESSION_REQUIRED's details at a credential's resolution: one came and did not hold, or none came
const CREDENTIAL_NOT_HELD: &str = "the credential does not hold";
const NO_CREDENTIAL: &str = "no credential came";

// ── What a side gives its core ──────────────────────────────────────────────────────────────

/// What a request came with that a procedure is never handed (spec 13.1): its header as it came,
/// a `JWT`'s token in it, and what its transport carried beside it.
#[derive(Debug, Clone)]
pub(crate) struct Carried {
    pub(crate) header: RequestHeader,
    pub(crate) transport_credential: Option<String>,
}

/// A request as its admission sees it: where it came from, its header, the call's session.
#[derive(Clone)]
#[expect(
    clippy::partial_pub_fields,
    reason = "what its transport carried, a bearer's secret, stays the router's"
)]
pub struct AdmissionRequest {
    /// The connection it came from.
    pub connection_handle: ConnectionHandle,
    /// Its header, a `JWT`'s token left out.
    pub header: RequestHeader,
    /// The call's session; none when the call runs in none.
    pub session: Option<CallSession>,
    pub(crate) carried: Option<Carried>,
}

impl fmt::Debug for AdmissionRequest {
    // ! its public members alone: what its transport carried stays the router's, nor is it said
    // whether anything was
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdmissionRequest")
            .field("connection_handle", &self.connection_handle)
            .field("header", &self.header)
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

/// An admission's refusal: its failure, and the name of the admission Bead gives that refused it,
/// which an access refused tells (spec 13.12); none for an application's own.
#[derive(Debug, Clone)]
pub struct AdmissionRefusal {
    /// The failure answered.
    pub failure: Failure,
    /// The admission of Bead's that refused it.
    pub by: Option<String>,
}

/// An admission: none admits; a refusal refuses; an error refuses as failed, reported.
pub type AdmitFn =
    Arc<dyn Fn(&AdmissionRequest) -> Result<Option<AdmissionRefusal>, ResolverError> + Send + Sync>;

/// What answers a request once its payload is whole: a resolver, or a destination's handler.
pub(crate) type ResolveFn =
    Arc<dyn Fn(ResolverProps) -> BoxFuture<Result<(), ResolverError>> + Send + Sync>;

/// A request's handler, as a router keeps it: what answers it, its admission, its payload's
/// limit, whether it forwards a credential unresolved, and whether it notifies.
#[derive(Clone)]
pub(crate) struct Handler {
    pub(crate) resolve: ResolveFn,
    pub(crate) admit: Option<AdmitFn>,
    pub(crate) maximum_payload_bytes: Option<u64>,
    pub(crate) forwards_credentials: bool,
    pub(crate) notifies: bool,
}

impl fmt::Debug for Handler {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Handler")
            .field("maximum_payload_bytes", &self.maximum_payload_bytes)
            .field("forwards_credentials", &self.forwards_credentials)
            .field("notifies", &self.notifies)
            .finish_non_exhaustive()
    }
}

/// A request as a router dispatched it: what it is known by until nothing holds it.
#[derive(Debug)]
pub(crate) struct Dispatch {
    pub(crate) id: u64,
    pub(crate) connection_handle: ConnectionHandle,
    /// Its header as a procedure is handed it: a `JWT`'s scheme alone.
    pub(crate) header: RequestHeader,
    pub(crate) handler: Mutex<Option<Arc<Handler>>>,
    pub(crate) session: Mutex<Option<CallSession>>,
    pub(crate) answered: Mutex<Option<FailureRecord>>,
    pub(crate) origin: (Option<String>, Option<u16>),
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a request's handler answers its call by, from off the router's owner.
pub trait Answerer: Send + Sync {
    /// Answers the call; settles once the answer went, or as it could not.
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>>;

    /// The failure the router answered the call with in its handler's place, read as it answers.
    fn answered(&self) -> BoxFuture<Option<FailureRecord>>;

    /// Subscribes the call's connection to its procedure, on a server's router: the subscription's
    /// call id.
    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>>;
}

/// A request as a router hands it to its handler, its payload whole.
#[derive(Clone)]
#[expect(
    clippy::partial_pub_fields,
    reason = "what its transport carried, a bearer's secret, stays the router's"
)]
pub struct ResolverProps {
    /// The connection it came from.
    pub connection_handle: ConnectionHandle,
    /// Its header, a `JWT`'s token left out (spec 13.1).
    pub header: RequestHeader,
    /// Its payload, whole, still encoded.
    pub payload: Bytes,
    /// The call's session; none when the call runs in none.
    pub session: Option<CallSession>,
    /// Aborted when the call ends before its answer.
    pub signal: Signal,
    /// What answers the call.
    pub answerer: Arc<dyn Answerer>,
    pub(crate) carried: Option<Carried>,
}

impl fmt::Debug for ResolverProps {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolverProps")
            .field("connection_handle", &self.connection_handle)
            .field("header", &self.header)
            .finish_non_exhaustive()
    }
}

/// What a credential resolved to: a call's session, a refusal and why in one word, or none.
#[derive(Debug, Clone)]
pub(crate) enum Resolved {
    Session(CallSession),
    Refused(String),
    None,
}

/// Why a credential's resolution failed: a bound of the side's own, or anything else.
#[derive(Debug, Clone)]
pub(crate) enum Unresolved {
    Capacity(CapacityError),
    Other(Arc<dyn Error + Send + Sync>),
}

/// A credential's resolution: now, in the turn the request came, or in a later one.
pub(crate) enum Resolution {
    Now(Result<Resolved, Unresolved>),
    Later(BoxFuture<Result<Resolved, Unresolved>>),
}

/// A request as a side resolves its credential: where it came from, and what it came with.
#[derive(Debug, Clone)]
pub(crate) struct SessionRequest {
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) carried: Carried,
}

/// An answer about to be written, as its side is shown it before.
#[derive(Debug, Clone)]
pub(crate) struct BeforeAnswer {
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) header: RequestHeader,
    pub(crate) is_failure: bool,
    pub(crate) handler: Option<Arc<Handler>>,
    pub(crate) session: Option<CallSession>,
}

/// What undoes what a side did before an answer that did not go out.
pub(crate) type Undo<S> = Box<dyn FnOnce(&mut S) + Send>;

/// What sets one side of a router apart, for its core: its port.
pub(crate) trait Side: Sized + Send + 'static {
    /// Its core.
    fn core(&mut self) -> &mut Core<Self>;

    /// The credential schemes it takes besides `OPAQUE`, which it always does.
    fn credential_schemes(&self) -> Vec<CredentialScheme> {
        Vec::new()
    }

    /// What the router did: sent a request, or took the response to one.
    fn activity(&mut self, _activity: RouterActivity, _connection_handle: &ConnectionHandle) {}

    /// Whether it holds `call_id` beyond what the core waits on — a subscription, say.
    fn is_call_id_in_use(&self, _call_id: u32, _connection_handle: &ConnectionHandle) -> bool {
        false
    }

    /// The handler of a request that names `destination_id`: a relay's.
    fn handler_of_destination(&mut self, _destination_id: u32) -> Option<Arc<Handler>> {
        None
    }

    /// Whether a connection carries both ways.
    fn is_two_way(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    /// An answer about to be written, and what undoes what it did should it not go out.
    fn before_answer(&mut self, _answer: BeforeAnswer) -> Option<Undo<Self>> {
        None
    }

    /// A cancel from `connection_handle`, once the call it cancels is forgotten.
    fn on_cancel(&mut self, _call_id: u32, _connection_handle: &ConnectionHandle) {}

    /// Whether it takes notifications.
    fn takes_notifications(&self) -> bool {
        false
    }

    /// A notification from `connection_handle`.
    fn on_notification(
        &mut self,
        _header: NotificationHeader,
        (_connection_handle, _payload): (&ConnectionHandle, Bytes),
    ) {
    }

    /// Whether it sends notifications, which a credit may count.
    fn sends_notifications(&self) -> bool {
        false
    }

    /// A credit that counts notifications.
    fn on_subscription_credit(
        &mut self,
        _header: &CreditHeader,
        _connection_handle: &ConnectionHandle,
    ) {
    }

    /// Every result and failure received, before it is paired with its call.
    fn on_answer_received(&mut self, _header: &Header, _connection_handle: &ConnectionHandle) {}

    /// A failure that answers no call waiting, which it takes or not.
    fn on_unpaired_failure(
        &mut self,
        (_header, _failure): (&FailureHeader, &FailureRecord),
        _connection_handle: &ConnectionHandle,
    ) -> bool {
        false
    }

    /// Whether anyone listens to the envelopes traced.
    fn is_tracing(&self) -> bool {
        false
    }

    /// Each envelope, out or in, its header redacted.
    fn trace(
        &mut self,
        _direction: DebugDirection,
        (_connection_handle, _header): (&ConnectionHandle, &Header),
    ) {
    }

    /// What went wrong that no call waits on.
    fn report(&mut self, error: RouterError, connection_handle: &ConnectionHandle);

    /// Hands an envelope's bytes over to the transport.
    fn transmit(
        &mut self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError>;

    /// Whether anyone listens for the calls it refuses as their credential resolves or as they are
    /// admitted.
    fn is_telling_refusals(&self) -> bool {
        false
    }

    /// Tells a call it refused (spec 13.12).
    fn tell_refusal(&mut self, _refusal: AccessRefusal) {}

    /// The call's session a request's credential resolves to.
    fn session_of(&mut self, _request: &SessionRequest, _signal: &Signal) -> Resolution {
        Resolution::Now(Ok(Resolved::None))
    }

    /// The session of `connection_handle`, which its next answer announces when it changed.
    fn session_token_of(&mut self, _connection_handle: &ConnectionHandle) -> Option<SessionToken> {
        None
    }

    /// The session a credential resolved to, as the side keeps it: a credential's session a
    /// connection keeps already takes the later of the two ends.
    fn resolved(
        &mut self,
        session: CallSession,
        _connection_handle: &ConnectionHandle,
    ) -> CallSession {
        session
    }

    /// Subscribes the connection a request came from to its procedure: a server's router does; a
    /// client's, which notifies nobody, cannot.
    fn subscribe(&mut self, _dispatch: &Arc<Dispatch>) -> Result<u32, CallError> {
        Err(CallError::Refused(ProgrammerError::new(
            "a client's router subscribes nothing: it notifies nobody",
        )))
    }
}

// ── The core ─────────────────────────────────────────────────────────────────────────────────

/// A resolver registered, and the series its calls count into.
#[derive(Debug, Clone)]
pub(crate) struct Registered {
    pub(crate) handler: Arc<Handler>,
    pub(crate) series: Option<ResolverSeries>,
}

/// What both sides of a router hold alike, in their owner's state.
pub(crate) struct Core<S> {
    pub(crate) side: RouterSide,
    pub(crate) limits: RouterLimits,
    pub(crate) clock: SharedClock,
    pub(crate) owner: WeakOwner<S>,
    pub(crate) metrics: Option<RouterMetrics>,
    pub(crate) placement: Placement,
    pub(crate) receivings: ReceivingTransfers,
    pub(crate) sendings: SendingTransfers,
    pub(crate) answering: AnsweringCalls,
    pub(crate) pending: PendingCalls,
    pub(crate) announcements: Announcements,
    pub(crate) resolvers: Resolvers,
    pub(crate) is_disposed: bool,
    // the receiving transfers of requests, by their transfer's id: the request as it waits, and
    // its handler
    pub(crate) receiving_requests: BTreeMap<u64, (Arc<Dispatch>, Arc<Handler>)>,
    // the results sent as a transfer, by their id, and what settles each once its last chunk went
    pub(crate) results: BTreeMap<u64, crate::router::answers::ResultSending<S>>,
    pub(crate) settled: BTreeMap<u64, Option<Responded<S>>>,
    pub(crate) next_id: u64,
}

impl<S> fmt::Debug for Core<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Core")
            .field("side", &self.side)
            .field("is_disposed", &self.is_disposed)
            .finish_non_exhaustive()
    }
}

impl<S: Side> Core<S> {
    pub(crate) fn new(
        owner: WeakOwner<S>,
        (side, limits, clock, metrics): (
            RouterSide,
            RouterLimits,
            SharedClock,
            Option<RouterMetrics>,
        ),
    ) -> Self {
        let placement = Placement::new(side, limits);

        Self {
            side,
            limits,
            clock,
            owner,
            metrics,
            placement,
            receivings: ReceivingTransfers::new(side, (limits, placement.payload_bytes_per_chunk)),
            sendings: SendingTransfers::default(),
            answering: AnsweringCalls {
                most: limits.maximum_answering_calls,
                ..AnsweringCalls::default()
            },
            pending: PendingCalls::new(side, None),
            announcements: Announcements::default(),
            resolvers: Resolvers::default(),
            is_disposed: false,
            receiving_requests: BTreeMap::new(),
            results: BTreeMap::new(),
            settled: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// A number never given before, which tells one thing from another of the same place.
    pub(crate) fn draw_id(&mut self) -> u64 {
        let id = self.next_id;

        self.next_id = self.next_id.saturating_add(1);

        id
    }

    /// A failure of the protocol's, raised by this side.
    pub(crate) fn failure(&self, code: ProtocolCode) -> Failure {
        Failure::protocol(code, self.side)
    }

    /// Arms a timer that runs `job` on the owner after `due`.
    pub(crate) fn after<J: FnOnce(&mut S) + Send + 'static>(
        &self,
        due: Duration,
        job: J,
    ) -> Arc<dyn Timer> {
        let owner = self.owner.clone();
        let mut job = Some(job);

        self.clock.arm(
            Schedule::Once(due),
            Box::new(move || {
                if let Some(job) = job.take() {
                    owner.offer(Box::new(job));
                }
            }),
        )
    }

    /// Posts `job` to the owner, to run in a later turn: as this one ends, when posted within it.
    pub(crate) fn later<J: FnOnce(&mut S) + Send + 'static>(&self, job: J) {
        self.owner.offer(Box::new(job));
    }

    /// The monotonic reading now.
    pub(crate) fn now(&self) -> Duration {
        self.clock.monotonic()
    }

    /// Gauges of every part.
    pub(crate) fn gauges(&self) -> Gauges {
        Gauges::merged(vec![
            self.pending.gauges(),
            self.answering.gauges(),
            self.sendings.gauges(),
            self.receivings.gauges(),
            self.announcements.gauges(),
        ])
    }
}

// a duration in whole microseconds, its fraction dropped (spec/debugging.md 11.1)
pub(crate) fn microseconds_of(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

/// The error a failure reported stands for.
pub(crate) fn reported(failure: Failure) -> RouterError {
    RouterError::Failure(failure)
}

/// What a resolver's error is reported as: a call's failure, a router's error, as it is; any other,
/// as itself.
pub(crate) fn reported_error_of(error: Box<dyn Error + Send + Sync>) -> RouterError {
    let error = match error.downcast::<CallError>() {
        Ok(call) => return reported_call(*call),
        Err(error) => error,
    };

    match error.downcast::<RouterError>() {
        Ok(router) => *router,
        Err(error) => RouterError::Other(Arc::from(error)),
    }
}

/// What a call's failure is reported as.
pub(crate) fn reported_call(error: CallError) -> RouterError {
    match error {
        CallError::Failure(failure) => RouterError::Failure(failure),
        other @ (CallError::Cancelled
        | CallError::Disconnected(_)
        | CallError::TimedOut(_)
        | CallError::Refused(_)
        | CallError::Other(_)) => RouterError::Other(Arc::new(other)),
    }
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

/// What a delivered envelope goes with: its transport's credential, what runs as its transport
/// has it, and what hears whether it went.
pub(crate) struct Deliver<S> {
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) credential: Option<String>,
    pub(crate) on_hand_off: Option<Job<S>>,
    pub(crate) then: Option<Then<S>>,
}

/// What hears whether an envelope went.
pub(crate) type Then<S> = Box<dyn FnOnce(&mut S, Result<(), CallError>) + Send>;

impl<S> Deliver<S> {
    pub(crate) fn to(connection_handle: &ConnectionHandle) -> Self {
        Self {
            connection_handle: Arc::clone(connection_handle),
            credential: None,
            on_hand_off: None,
            then: None,
        }
    }
}

// the credential an answer announces, and what restores the announcement should it not go out
fn announce<S: Side>(
    state: &mut S,
    (envelope, handle): (Envelope, &ConnectionHandle),
) -> (Envelope, Option<crate::router::parts::Announced>) {
    if !matches!(envelope, Envelope::Result { .. } | Envelope::Failure { .. }) {
        return (envelope, None);
    }

    let current = state.session_token_of(handle);
    let Some((credential, announced)) = state.core().announcements.announce((handle, current))
    else {
        return (envelope, None);
    };

    let envelope = match envelope {
        Envelope::Result {
            mut header,
            payload,
        } => {
            header.credential = Some(credential);
            Envelope::Result { header, payload }
        }
        Envelope::Failure {
            mut header,
            failure,
        } => {
            header.credential = Some(credential);
            Envelope::Failure { header, failure }
        }
        other @ (Envelope::Request { .. }
        | Envelope::Notification { .. }
        | Envelope::Chunk { .. }
        | Envelope::Credit { .. }
        | Envelope::Cancel { .. }) => other,
    };

    (envelope, Some(announced))
}

/// Sends an envelope, within its limits, announced, traced and handed to the transport; `then`
/// hears, in a later turn, whether it went.
#[expect(
    clippy::too_many_lines,
    reason = "an envelope written, announced, traced and handed over, in the order spec 15.1 takes"
)]
pub(crate) fn deliver<S: Side>(state: &mut S, (envelope, options): (Envelope, Deliver<S>)) {
    let Deliver {
        connection_handle,
        credential,
        on_hand_off,
        then,
    } = options;
    let settle = |state: &mut S, outcome: Result<(), CallError>, then: Option<Then<S>>| {
        if let Some(then) = then {
            state.core().later(move |state| then(state, outcome));
        }
    };
    let core = state.core();

    // a disposed router is done with its transport: nothing more goes out on it
    if core.is_disposed {
        return settle(
            state,
            Err(CallError::Disconnected(DISPOSED.to_owned())),
            then,
        );
    }

    let limits = core.limits;
    let payload_length = match &envelope {
        Envelope::Request { payload, .. }
        | Envelope::Result { payload, .. }
        | Envelope::Notification { payload, .. }
        | Envelope::Chunk { payload, .. } => Some(u64::try_from(payload.len()).unwrap_or(u64::MAX)),
        Envelope::Failure { .. } | Envelope::Credit { .. } | Envelope::Cancel { .. } => None,
    };

    // a failure, a credit and a cancel carry no payload of their own
    if let Some(length) = payload_length.filter(|&length| length > limits.maximum_payload_bytes) {
        let failure = core
            .placement
            .too_large_of(length, limits.maximum_payload_bytes)
            .about(&envelope.header());

        return settle(state, Err(CallError::Failure(failure)), then);
    }

    let (envelope, announced) = announce(state, (envelope, &connection_handle));
    let detail_bytes = detail_bound_of(
        usize::try_from(limits.maximum_detail_bytes).unwrap_or(usize::MAX),
        usize::try_from(limits.maximum_envelope_bytes).unwrap_or(usize::MAX),
    );
    let written = write_envelope(&envelope, detail_bytes)
        .map_err(CallError::Refused)
        .and_then(|bytes| {
            let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

            // one past its limit, the peer would refuse: a notification too large for one envelope
            if length > limits.maximum_envelope_bytes {
                return Err(CallError::Failure(
                    Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, limits_side(state))
                        .saying(format!(
                            "an envelope is {} bytes at most, not {length}",
                            limits.maximum_envelope_bytes
                        ))
                        .about(&envelope.header()),
                ));
            }

            Ok(bytes)
        });
    let bytes = match written {
        Ok(bytes) => bytes,
        Err(error) => {
            if let Some(announced) = announced {
                state.core().announcements.restore(announced);
            }

            return settle(state, Err(error), then);
        }
    };

    // * one check an envelope while nobody listens: no redacted header is built
    if state.is_tracing() {
        let header = envelope.header().redacted();

        state.trace(DebugDirection::Tx, (&connection_handle, &header));
    }

    let message = TransportMessage {
        data: bytes,
        credential,
        ..TransportMessage::default()
    };

    match state.transmit(message, &connection_handle) {
        Err(error) => {
            if let Some(announced) = announced {
                state.core().announcements.restore(announced);
            }

            settle(state, Err(call_error_of(error)), then);
        }
        Ok(sent) => {
            if let Some(on_hand_off) = on_hand_off {
                on_hand_off(state);
            }

            match sent {
                Sent::Done => settle(state, Ok(()), then),
                Sent::Later(sending) => {
                    let owner = state.core().owner.clone();

                    state.core().owner.cover(async move {
                        let outcome = sending.await;
                        owner.offer(Box::new(move |state: &mut S| {
                            if outcome.is_err()
                                && let Some(announced) = announced
                            {
                                state.core().announcements.restore(announced);
                            }

                            if let Some(then) = then {
                                then(state, outcome.map_err(call_error_of));
                            }
                        }));
                    });
                }
            }
        }
    }
}

fn limits_side<S: Side>(state: &mut S) -> RouterSide {
    state.core().side
}

/// The call error a router's error stands for.
pub(crate) fn call_error_of(error: RouterError) -> CallError {
    match error {
        RouterError::Failure(failure) => CallError::Failure(failure),
        RouterError::Other(error) => CallError::Other(error),
    }
}

/// Sends an envelope no call waits on: what keeps it from going out is reported.
pub(crate) fn send_reporting<S: Side>(
    state: &mut S,
    (envelope, handle): (Envelope, &ConnectionHandle),
) {
    let reported_on = Arc::clone(handle);
    let mut options = Deliver::to(handle);

    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            if let Err(error) = outcome {
                state.report(reported_call(error), &reported_on);
            }
        },
    ));
    deliver(state, (envelope, options));
}

// a failure the core raises itself, on what came in, for the side to hear
fn report_failure<S: Side>(
    state: &mut S,
    (failure, (handle, header)): (Failure, (&ConnectionHandle, &Header)),
) {
    state.report(reported(failure.about(header)), handle);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

/// Takes a message from `handle`: read, traced, then dispatched by kind.
pub(crate) fn receive<S: Side>(
    state: &mut S,
    (message, handle): (TransportMessage, &ConnectionHandle),
) {
    let core = state.core();
    let side = core.side;
    let limits = core.limits;
    let TransportMessage {
        data,
        credential: transport_credential,
        address,
        port,
        may_overtake,
    } = message;
    let prefix = match read_prefix(&data, side) {
        Ok(prefix) => prefix,
        // what is not an envelope's prefix has no call to answer: it is reported
        Err(failure) => return state.report(reported(failure), handle),
    };
    let options = ReadEnvelopeOptions {
        chunk_bytes: usize::try_from(limits.chunk_bytes).ok(),
        maximum_detail_bytes: usize::try_from(limits.maximum_detail_bytes).ok(),
        maximum_envelope_bytes: usize::try_from(limits.maximum_envelope_bytes).ok(),
    };

    let envelope = match read_envelope(&data, side, &options) {
        Ok(Some(envelope)) => envelope,
        // an advisory kind is skipped
        Ok(None) => return,
        Err(failure) => return gate(state, ((failure, handle, prefix), false)),
    };

    if state.is_tracing() {
        let header = envelope.header().redacted();

        state.trace(DebugDirection::Rx, (handle, &header));
    }

    match envelope {
        Envelope::Request { header, payload } => receive_request(
            state,
            (
                (header, payload),
                (handle, transport_credential, (address, port)),
            ),
        ),
        Envelope::Result { header, payload } => {
            crate::router::requester::receive_answer(
                state,
                (Answer::Result(header, payload), handle, may_overtake),
            );
        }
        Envelope::Failure { header, failure } => {
            crate::router::requester::receive_answer(
                state,
                (Answer::Failure(header, failure), handle, may_overtake),
            );
        }
        Envelope::Notification { header, payload } => {
            receive_notification(state, (header, payload, handle));
        }
        Envelope::Chunk { header, payload } => {
            let chunk = Chunk {
                bytes: payload,
                is_last: header.is_last,
                offset: header.offset,
            };
            let call = CallAddress {
                connection_handle: Arc::clone(handle),
                call_id: header.call_id,
            };

            if RouterSide::of_call_id(header.call_id) == Some(side) {
                crate::router::requester::receive_result_chunk(state, (header, call, chunk));
            } else {
                receive_request_chunk(state, (header, call, chunk));
            }
        }
        // one for no transfer this side sends, or no subscription, may have crossed its end
        Envelope::Credit { header } => {
            if header.paced {
                if state.sends_notifications() {
                    state.on_subscription_credit(&header, handle);
                } else {
                    let failure = state
                        .core()
                        .failure(ProtocolCode::KIND_UNSUPPORTED)
                        .saying("this side sends no notification");

                    report_failure(state, (failure, (handle, &Header::Credit(header))));
                }
            } else {
                credit_sending(state, (handle, header.call_id, header.credit_end));
            }
        }
        Envelope::Cancel { header } => receive_cancel(state, (header, handle)),
    }
}

/// An answer, a result or a failure, as it came.
#[derive(Debug, Clone)]
pub(crate) enum Answer {
    Result(ResultHeader, Bytes),
    Failure(FailureHeader, FailureRecord),
}

// whether a call id is the peer's to open on this connection, and free: a refusal on it is answered
fn is_answerable<S: Side>(state: &mut S, (call_id, handle): (u32, &ConnectionHandle)) -> bool {
    let core = state.core();
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };
    let is_peers = RouterSide::of_call_id(call_id) == Some(core.side.peer());
    let is_open = core.answering.has(&call);

    is_peers && !is_open && !state.is_call_id_in_use(call_id, handle)
}

// what did not read: a request of the peer's on a free call id is answered; an answer or a chunk of
// this layout ends the call or the transfer it is for; anything else is reported, once
fn gate<S: Side>(
    state: &mut S,
    ((failure, handle, prefix), is_reported): ((Failure, &ConnectionHandle, Prefix), bool),
) {
    let Prefix {
        call_id,
        kind,
        layout,
    } = prefix;
    let is_first = layout == EnvelopeLayout::First.byte();

    if kind == EnvelopeKind::Request.byte() && is_answerable(state, (call_id, handle)) {
        return refuse_unread(state, (failure, call_id, handle));
    }

    if kind == EnvelopeKind::Chunk.byte() && is_first {
        return gate_chunk(state, ((failure, call_id, handle), is_reported));
    }

    if (kind == EnvelopeKind::Result.byte() || kind == EnvelopeKind::Failure.byte()) && is_first {
        return crate::router::requester::gate_malformed_answer(
            state,
            ((failure, call_id, handle), is_reported),
        );
    }

    if !is_reported {
        state.report(reported(failure), handle);
    }
}

// answers a request whose header does not read: a call of _OTHER's, counted, that starts and ends
// in one turn as its answer is handed off
fn refuse_unread<S: Side>(
    state: &mut S,
    (failure, call_id, handle): (Failure, u32, &ConnectionHandle),
) {
    let refusal = Envelope::Failure {
        header: FailureHeader {
            call_id,
            credential: None,
        },
        failure: failure.record(),
    };
    let series = state
        .core()
        .metrics
        .as_ref()
        .map(|metrics| metrics.other_server().clone());
    let Some(series) = series else {
        return send_reporting(state, (refusal, handle));
    };

    series.start();

    let started_at = state.core().now();
    let ended = Arc::new(Mutex::new(false));
    let ending = CallEnding::of_failure(failure.code(), failure.scope());
    let mut options = Deliver::to(handle);
    let (on_end, on_error) = (Arc::clone(&ended), Arc::clone(&ended));
    let (series_handed, series_failed) = (series.clone(), series);
    let reported_on = Arc::clone(handle);

    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        if !core::mem::replace(&mut *locked(&on_end), true) {
            let elapsed = state.core().now().saturating_sub(started_at);

            series_handed.end(ending, microseconds_of(elapsed));
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            if let Err(error) = outcome {
                if !core::mem::replace(&mut *locked(&on_error), true) {
                    let elapsed = state.core().now().saturating_sub(started_at);

                    series_failed.end(CallEnding::Error, microseconds_of(elapsed));
                }

                state.report(reported_call(error), &reported_on);
            }
        },
    ));
    deliver(state, (refusal, options));
}

// a chunk that did not read ends the transfer it was for, as invalid — unless its payload came
// whole already; on a call id reserved or abandoned, it is late, and dropped in silence
fn gate_chunk<S: Side>(
    state: &mut S,
    ((failure, call_id, handle), is_reported): ((Failure, u32, &ConnectionHandle), bool),
) {
    let core = state.core();
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };

    if RouterSide::of_call_id(call_id) == Some(core.side) {
        return crate::router::requester::gate_malformed_result_chunk(
            state,
            ((failure, call_id, handle), is_reported),
        );
    }

    let invalid = core
        .failure(ProtocolCode::CHUNK_INVALID)
        .saying(failure.detail().to_owned());
    let receiving = core
        .answering
        .get(&call)
        .and_then(|answering| answering.receiving.clone());

    if let Some(RequestReceiving { transfer }) = receiving {
        let is_whole = core
            .receivings
            .get(transfer)
            .is_none_or(|receiving| receiving.incoming.is_whole());

        if !is_whole && let Some((dispatch, _)) = core.receiving_requests.get(&transfer).cloned() {
            return refuse(state, (invalid, &dispatch));
        }
    }

    if state.core().answering.abandoned_end_of(&call).is_some() {
        return;
    }

    if !is_reported {
        state.report(reported(failure), handle);
    }
}

// a cancel from the peer ends a call it opened: forgotten first, so an answer from what hears the
// signal finds no call to answer, then offered to the side, then the signal aborted
fn receive_cancel<S: Side>(state: &mut S, (header, handle): (CancelHeader, &ConnectionHandle)) {
    let core = state.core();
    let call_id = header.call_id;

    if RouterSide::of_call_id(call_id) == Some(core.side) {
        let failure = core
            .failure(ProtocolCode::ENVELOPE_MALFORMED)
            .saying(format!(
                "call {call_id} is this side's, which the peer cannot cancel"
            ));

        return report_failure(state, (failure, (handle, &Header::Cancel(header))));
    }

    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };
    let taken = take_answering(state, &call);

    state.on_cancel(call_id, handle);

    if let Some(answering) = taken {
        answering.signal.abort(SignalReason::Cancelled);
    }
}

fn receive_notification<S: Side>(
    state: &mut S,
    (header, payload, handle): (NotificationHeader, Bytes, &ConnectionHandle),
) {
    if !state.takes_notifications() {
        let failure = state
            .core()
            .failure(ProtocolCode::KIND_UNSUPPORTED)
            .saying("this side takes no notification");

        return report_failure(state, (failure, (handle, &Header::Notification(header))));
    }

    // one on a call id reserved was on its way, and is dropped in silence
    if state.core().pending.is_reserved(header.call_id, handle) {
        return;
    }

    state.on_notification(header, (handle, payload));
}

// a credit on a transfer this side sends: its end raised, then the chunks it lets go sent
fn credit_sending<S: Side>(
    state: &mut S,
    (handle, call_id, credit_end): (&ConnectionHandle, u32, u64),
) {
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };
    let Some(purpose) = state.core().sendings.credit(&call, credit_end) else {
        return;
    };

    match purpose {
        SendingFor::Request(id) => crate::router::requester::request_progress(state, (&call, id)),
        SendingFor::Result(id) => result_progress(state, (&call, id)),
    }

    pump(state, (&call, purpose));
}

/// Sends the chunks the credit lets go on `call`'s transfer, one after the other, while it is open.
pub(crate) fn pump<S: Side>(state: &mut S, (call, purpose): (&CallAddress, SendingFor)) {
    if !state.core().sendings.begin_pump(call) {
        return;
    }

    while state.core().sendings.is_open(call, purpose) {
        let Some(chunk) = state.core().sendings.next_chunk(call) else {
            break;
        };

        match purpose {
            SendingFor::Request(id) => {
                crate::router::requester::send_request_chunk(state, (call, id, chunk));
            }
            SendingFor::Result(id) => send_result_chunk(state, (call, id, chunk)),
        }
    }

    state.core().sendings.end_pump(call);
}

// ── Answering ────────────────────────────────────────────────────────────────────────────────

// counts a call ended, once, timed to now
fn ended<S: Side>(state: &mut S, (call, ending): (&CallAddress, CallEnding)) {
    let core = state.core();

    if let Some(answering) = core.answering.get_mut(call)
        && !answering.is_ended
        && let Some(series) = answering.series.clone()
    {
        // * read only for a call counted (spec/debugging.md 3.1)
        let now = core.clock.monotonic();

        answering.is_ended = true;
        series.end(
            ending,
            microseconds_of(now.saturating_sub(answering.started_at)),
        );
    }
}

// counts the call of a request ended, as `ending` says, while it is the one `dispatch` opened
fn end_answering<S: Side>(state: &mut S, (dispatch, ending): (&Dispatch, CallEnding)) {
    let call = CallAddress {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        call_id: dispatch.header.call_id,
    };
    let is_its = state
        .core()
        .answering
        .get(&call)
        .is_some_and(|answering| answering.dispatched == dispatch.id);

    if is_its {
        ended(state, (&call, ending));
    }
}

// keeps a call abandoned until its timer fires, the oldest of its connection's yielding
fn abandon<S: Side>(state: &mut S, (call, credit_end): (&CallAddress, u64)) {
    let core = state.core();
    let maximum = core.limits.maximum_transfers;
    let timeout = core.limits.transfer_inactivity_timeout;
    let oldest: Vec<u32> = core
        .answering
        .abandoned
        .get(&call.connection_handle)
        .map(|calls| calls.keys().copied().collect())
        .unwrap_or_default();
    let mut count = u64::try_from(oldest.len()).unwrap_or(u64::MAX);

    for call_id in oldest {
        if count < maximum {
            break;
        }

        core.answering.forget_abandoned(
            &CallAddress {
                connection_handle: Arc::clone(&call.connection_handle),
                call_id,
            },
            None,
        );
        count = count.saturating_sub(1);
    }

    let id = core.draw_id();
    let forgotten = call.clone();
    let timer = core.after(timeout, move |state: &mut S| {
        state
            .core()
            .answering
            .forget_abandoned(&forgotten, Some(id));
    });

    core.answering
        .abandoned
        .entry(Arc::clone(&call.connection_handle))
        .or_default()
        .insert(
            call.call_id,
            crate::router::parts::Abandoned {
                credit_end,
                id,
                timer: Some(timer),
            },
        );
}

// takes a call out — only while `only` dispatched it, when given — what it received leaving with it,
// its call abandoned
fn forget_answering<S: Side>(
    state: &mut S,
    (call, only): (&CallAddress, Option<u64>),
) -> Option<Answering> {
    let answering = state.core().answering.forget(call, only)?;

    if let Some(receiving) = &answering.receiving {
        let core = state.core();
        let credit_end = core
            .receivings
            .get(receiving.transfer)
            .map_or(0, |receiving| receiving.incoming.credit_end());

        abandon(state, (call, credit_end));

        let core = state.core();

        core.receiving_requests.remove(&receiving.transfer);

        let credits = core.receivings.close(receiving.transfer);

        send_credits(state, credits);
    }

    Some(answering)
}

/// Sends each credit the budget let a transfer grant.
pub(crate) fn send_credits<S: Side>(state: &mut S, credits: Vec<(CallAddress, u64)>) {
    for (call, credit_end) in credits {
        send_reporting(
            state,
            (
                Envelope::Credit {
                    header: CreditHeader {
                        call_id: call.call_id,
                        credit_end,
                        paced: false,
                    },
                },
                &call.connection_handle,
            ),
        );
    }
}

// takes a call out, cancelled, counted so
fn take_answering<S: Side>(state: &mut S, call: &CallAddress) -> Option<Answering> {
    ended(state, (call, CallEnding::Cancelled));
    forget_answering(state, (call, None))
}

// closes the call `dispatch` opened, none that took its call id since: unanswered, counted an error
pub(crate) fn close_answering<S: Side>(state: &mut S, dispatch: &Dispatch) {
    let call = CallAddress {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        call_id: dispatch.header.call_id,
    };
    let is_its = state
        .core()
        .answering
        .get(&call)
        .is_some_and(|answering| answering.dispatched == dispatch.id);

    if is_its {
        ended(state, (&call, CallEnding::Error));
        forget_answering(state, (&call, Some(dispatch.id)));
    }
}

/// Whether the call `dispatch` opened is still to be answered.
pub(crate) fn is_answering<S: Side>(state: &mut S, dispatch: &Dispatch) -> bool {
    let call = CallAddress {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        call_id: dispatch.header.call_id,
    };

    state
        .core()
        .answering
        .get(&call)
        .is_some_and(|answering| answering.dispatched == dispatch.id && !answering.is_answered)
}

/// The signal of the call `dispatch` opened, while it is open.
pub(crate) fn signal_of<S: Side>(state: &mut S, dispatch: &Dispatch) -> Option<Signal> {
    let call = CallAddress {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        call_id: dispatch.header.call_id,
    };

    state
        .core()
        .answering
        .get(&call)
        .filter(|answering| answering.dispatched == dispatch.id)
        .map(|answering| answering.signal.clone())
}

/// What settles once an answer went, or could not.
pub(crate) type Responded<S> = Box<dyn FnOnce(&mut S, Result<(), CallError>) + Send>;

/// Answers a request, on its call id alone, while its call is open; once cancelled, or gone with
/// its connection, nothing goes out.
#[expect(
    clippy::too_many_lines,
    reason = "an answer held to its limits and its subscription, then written or sent as a transfer"
)]
pub(crate) fn respond<S: Side>(
    state: &mut S,
    (answer, dispatch, done): (RouterAnswer, Arc<Dispatch>, Option<Responded<S>>),
) {
    let core = state.core();
    let handle = Arc::clone(&dispatch.connection_handle);
    let call_id = dispatch.header.call_id;
    let finish = |state: &mut S, outcome: Result<(), CallError>, done: Option<Responded<S>>| {
        if let Some(done) = done {
            state.core().later(move |state| done(state, outcome));
        }
    };

    // a call its requester cancelled, its connection took away, or whose call id another request
    // opened since, is answered by nothing; once disposed, the answer goes on, to reject
    if !core.is_disposed && !is_answering(state, &dispatch) {
        return finish(state, Ok(()), done);
    }

    let core = state.core();
    let handler = locked(&dispatch.handler).clone();
    let maximum_payload_bytes = core.placement.payload_limit_of(
        handler
            .as_ref()
            .and_then(|handler| handler.maximum_payload_bytes),
    );
    let result_header = ResultHeader {
        call_id,
        total: None,
        credential: None,
    };
    let is_failure = matches!(answer, RouterAnswer::Failure(_));
    let transfer = match &answer {
        RouterAnswer::Result(payload) => {
            match core.placement.transfer_of(
                payload,
                (
                    &Header::Result(result_header.clone()),
                    maximum_payload_bytes,
                ),
            ) {
                Ok(Placed::Whole) => None,
                Ok(Placed::Transfer(outgoing)) => {
                    if dispatch.header.opens_subscription {
                        let failure = core
                            .failure(ProtocolCode::PAYLOAD_TOO_LARGE)
                            .saying(format!(
                                "a subscription's result goes in one envelope, of {} bytes at most",
                                core.placement.whole_bytes
                            ))
                            .about(&Header::Result(result_header));

                        return finish(state, Err(CallError::Failure(failure)), done);
                    }

                    Some(outgoing)
                }
                Err(failure) => {
                    let failure = failure.about(&Header::Result(result_header));

                    return finish(state, Err(CallError::Failure(failure)), done);
                }
            }
        }
        RouterAnswer::Failure(_) => None,
    };
    let session = locked(&dispatch.session).clone();
    let undo = state.before_answer(BeforeAnswer {
        connection_handle: Arc::clone(&handle),
        header: dispatch.header.clone(),
        is_failure,
        handler,
        session,
    });
    let call = CallAddress {
        connection_handle: Arc::clone(&handle),
        call_id,
    };
    let is_its = state
        .core()
        .answering
        .get(&call)
        .is_some_and(|answering| answering.dispatched == dispatch.id);

    // its answer going out: a second goes nowhere, and this one closes the call once done
    if is_its && let Some(answering) = state.core().answering.get_mut(&call) {
        answering.is_answered = true;
    }

    if let RouterAnswer::Failure(failure) = &answer
        && is_its
    {
        *locked(&dispatch.answered) = Some(failure.clone());
    }

    let ending = match &answer {
        RouterAnswer::Result(_) => CallEnding::Result,
        RouterAnswer::Failure(failure) => CallEnding::of_failure(failure.code, failure.scope),
    };
    let failed = {
        let dispatch = Arc::clone(&dispatch);

        move |state: &mut S, error: CallError, undo: Option<Undo<S>>| {
            // an answer that did not go out leaves nothing done for it behind, and its call closed
            if let Some(undo) = undo {
                undo(state);
            }

            close_answering(state, &dispatch);

            Err::<(), CallError>(error)
        }
    };

    if let Some(outgoing) = transfer {
        return crate::router::answers::send_result(state, (outgoing, dispatch, (undo, done)));
    }

    let envelope = match answer {
        RouterAnswer::Result(payload) => Envelope::Result {
            header: result_header,
            payload,
        },
        RouterAnswer::Failure(failure) => Envelope::Failure {
            header: FailureHeader {
                call_id,
                credential: None,
            },
            failure,
        },
    };
    let mut options = Deliver::to(&handle);
    let handed = Arc::clone(&dispatch);

    // answered: the call id is the peer's to open again
    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        if is_its {
            end_answering(state, (&handed, ending));
            close_answering(state, &handed);
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            let outcome = match outcome {
                Ok(()) => Ok(()),
                Err(error) => failed(state, error, undo),
            };

            if let Some(done) = done {
                done(state, outcome);
            }
        },
    ));
    deliver(state, (envelope, options));
}

// a refusal answers a request of the peer's; the answer that cannot go out is reported
pub(crate) fn refuse<S: Side>(state: &mut S, (failure, dispatch): (Failure, &Arc<Dispatch>)) {
    let reported_on = Arc::clone(&dispatch.connection_handle);
    let closing = Arc::clone(dispatch);

    respond(
        state,
        (
            RouterAnswer::Failure(failure.record()),
            Arc::clone(dispatch),
            Some(Box::new(
                move |state: &mut S, outcome: Result<(), CallError>| {
                    if let Err(error) = outcome {
                        // a refusal that never reached the transport leaves no call open behind it
                        close_answering(state, &closing);
                        state.report(reported_call(error), &reported_on);
                    }
                },
            )),
        ),
    );
}

// a result's transfer progressing sets its timer going again
fn result_progress<S: Side>(state: &mut S, (call, id): (&CallAddress, u64)) {
    crate::router::answers::progress(state, (call, id));
}

fn send_result_chunk<S: Side>(state: &mut S, (call, id, chunk): (&CallAddress, u64, Chunk)) {
    crate::router::answers::send_chunk(state, (call, id, chunk));
}

// ── Dispatching ──────────────────────────────────────────────────────────────────────────────

// * tells the side a call refused as its credential resolved or as it was admitted, in the turn its
// refusal is answered, built only while someone listens; never the credential (spec 13.12)
fn tell_refused<S: Side>(
    state: &mut S,
    (dispatch, code, reason, refused_at): (&Dispatch, u16, Option<String>, AccessRefusalStage),
) {
    if !state.is_telling_refusals() {
        return;
    }

    let header = &dispatch.header;

    state.tell_refusal(AccessRefusal {
        stage: refused_at,
        code,
        reason,
        credential_scheme: header.credential.as_ref().map(Credential::scheme),
        service_id: header.service_id,
        procedure_id: header.procedure_id,
        destination_id: header.destination_id,
        connection_handle: Arc::clone(&dispatch.connection_handle),
        address: dispatch.origin.0.clone(),
        port: dispatch.origin.1,
    });
}

// what answers a call's handler in its place: its responder, posting to the owner
struct CallAnswerer<S> {
    owner: WeakOwner<S>,
    dispatch: Arc<Dispatch>,
}

impl<S: Side> Answerer for CallAnswerer<S> {
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>> {
        let (reply, answered) = ::tokio::sync::oneshot::channel();
        let dispatch = Arc::clone(&self.dispatch);
        let posted = self.owner.post(Box::new(move |state: &mut S| {
            respond(
                state,
                (
                    answer,
                    dispatch,
                    Some(Box::new(move |_state: &mut S, outcome| {
                        drop(reply.send(outcome));
                    })),
                ),
            );
        }));

        Box::pin(async move {
            if posted.is_err() {
                return Err(CallError::Disconnected(DISPOSED.to_owned()));
            }

            answered
                .await
                .unwrap_or_else(|_closed| Err(CallError::Disconnected(DISPOSED.to_owned())))
        })
    }

    fn answered(&self) -> BoxFuture<Option<FailureRecord>> {
        let answered = locked(&self.dispatch.answered).clone();

        Box::pin(async move { answered })
    }

    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>> {
        let (reply, subscribed) = ::tokio::sync::oneshot::channel();
        let dispatch = Arc::clone(&self.dispatch);
        let posted = self.owner.post(Box::new(move |state: &mut S| {
            drop(reply.send(state.subscribe(&dispatch)));
        }));

        Box::pin(async move {
            if posted.is_err() {
                return Err(CallError::Disconnected(DISPOSED.to_owned()));
            }

            subscribed
                .await
                .unwrap_or_else(|_closed| Err(CallError::Disconnected(DISPOSED.to_owned())))
        })
    }
}

// hands a request to its handler: one that fails before it answers is answered PROCEDURE_FAILED,
// reported unless its call was cancelled or went with its connection
fn dispatch_to<S: Side>(
    state: &mut S,
    (handler, dispatch, payload): (Arc<Handler>, Arc<Dispatch>, Bytes),
) {
    let Some(signal) = signal_of(state, &dispatch) else {
        return;
    };
    let core = state.core();
    let owner = core.owner.clone();
    let session = locked(&dispatch.session).clone();
    let props = ResolverProps {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        header: dispatch.header.clone(),
        payload,
        session,
        signal: signal.clone(),
        answerer: Arc::new(CallAnswerer {
            owner: owner.clone(),
            dispatch: Arc::clone(&dispatch),
        }),
        carried: None,
    };
    // * off the owner, on the runtime: one that blocks its thread stalls a worker, never the router
    let resolving = (handler.resolve)(props);
    let Some(running) = owner.spawn(resolving) else {
        return;
    };

    core.owner.cover(async move {
        // ! a resolver's panic is seen on its handle, and answered as any other error is
        let outcome = match running.await {
            Ok(outcome) => outcome,
            Err(joined) => Err(ResolverError::Other(
                format!("the resolver panicked: {joined}").into(),
            )),
        };

        if let Err(error) = outcome {
            owner.offer(Box::new(move |state: &mut S| {
                resolver_failed(state, (&dispatch, &signal, error));
            }));
        }
    });
}

// a resolver that failed: reported unless its call was cancelled or went with its connection, and
// answered PROCEDURE_FAILED while it still answers
fn resolver_failed<S: Side>(
    state: &mut S,
    (dispatch, signal, error): (&Arc<Dispatch>, &Signal, ResolverError),
) {
    let still = is_answering(state, dispatch);
    let handle = Arc::clone(&dispatch.connection_handle);

    match error {
        // ! a resolver's own failure is answered as it is, as a thrown FailureError is
        ResolverError::Failure(failure) if still && !signal.is_aborted() => {
            return respond_failure_as_is(state, (failure, dispatch));
        }
        ResolverError::Failure(failure) => {
            if !signal.is_aborted() {
                state.report(reported(failure), &handle);
            }
        }
        ResolverError::Other(error) => {
            if !signal.is_aborted() {
                state.report(reported_error_of(error), &handle);
            }
        }
    }

    // ! a resolver that fails before it answers is answered PROCEDURE_FAILED (spec 9.5); a call
    // cancelled, or gone with its connection, is answered nothing, and one answered keeps its answer
    if still && !signal.is_aborted() {
        let failure = state.core().failure(ProtocolCode::PROCEDURE_FAILED);

        return refuse(state, (failure, dispatch));
    }

    if still {
        close_answering(state, dispatch);
    }
}

fn respond_failure_as_is<S: Side>(state: &mut S, (failure, dispatch): (Failure, &Arc<Dispatch>)) {
    refuse(state, (failure, dispatch));
}

// an admission's refusal as it is answered: never SESSION_REQUIRED to a call that presented a
// credential, whatever its handler — the credential may hold, and its requester would withdraw it
fn answered_of<S: Side>(
    state: &mut S,
    (refusal, request): (Failure, &AdmissionRequest),
) -> Failure {
    if !refusal.is_protocol_code(&[ProtocolCode::SESSION_REQUIRED])
        || request.header.credential.is_none()
    {
        return refusal;
    }

    let denied = state.core().failure(ProtocolCode::ACCESS_DENIED);

    if refusal.detail().is_empty() {
        denied
    } else {
        denied.saying(refusal.detail().to_owned())
    }
}

// whether a failure is of the admission's block, 32 to 47, the protocol's (spec 8.1)
fn is_admission_code(failure: &Failure) -> bool {
    failure.scope() == FailureScope::Protocol && (32..=47).contains(&failure.code().get())
}

// a request admitted on the call's session, then where it goes: refused, dispatched, or its
// transfer opened, whose first credit goes only now
fn admit_routed<S: Side>(
    state: &mut S,
    (dispatch, payload, handler): (Arc<Dispatch>, Bytes, Arc<Handler>),
) {
    let handle = Arc::clone(&dispatch.connection_handle);
    let session = locked(&dispatch.session).clone();
    let request = AdmissionRequest {
        connection_handle: Arc::clone(&handle),
        header: dispatch.header.clone(),
        session,
        carried: None,
    };

    if let Some(admit) = &handler.admit {
        match admit(&request) {
            Err(error) => {
                let reported_error = match error {
                    ResolverError::Failure(failure) => reported(failure),
                    ResolverError::Other(error) => RouterError::Other(Arc::from(error)),
                };

                state.report(reported_error, &handle);

                let failure = state.core().failure(ProtocolCode::PROCEDURE_FAILED);

                return refuse(state, (failure, &dispatch));
            }
            Ok(Some(refusal)) => {
                let told = is_admission_code(&refusal.failure).then_some(refusal.by.clone());
                let failure = answered_of(state, (refusal.failure, &request));
                let code = failure.code().get();

                refuse(state, (failure, &dispatch));

                if let Some(reason) = told {
                    tell_refused(
                        state,
                        (&dispatch, code, reason, AccessRefusalStage::Admission),
                    );
                }

                return;
            }
            Ok(None) => {}
        }
    }

    let header = &dispatch.header;

    // admitted, one that opens a subscription where nothing this side sends of its own goes is
    // refused: no notification could reach it
    if header.opens_subscription && !state.is_two_way(&handle) {
        let failure = state
            .core()
            .failure(ProtocolCode::SUBSCRIPTION_UNSUPPORTED)
            .saying("this connection carries no notification back");

        return refuse(state, (failure, &dispatch));
    }

    let core = state.core();
    let maximum_payload_bytes = core
        .placement
        .payload_limit_of(handler.maximum_payload_bytes);
    let length = header
        .total
        .unwrap_or_else(|| u64::try_from(payload.len()).unwrap_or(u64::MAX));

    if length > maximum_payload_bytes {
        let failure = core.placement.too_large_of(length, maximum_payload_bytes);

        return refuse(state, (failure, &dispatch));
    }

    let Some(total) = header.total else {
        return dispatch_to(state, (handler, dispatch, payload));
    };
    let call = CallAddress {
        connection_handle: Arc::clone(&handle),
        call_id: header.call_id,
    };
    let transfer = match core.receivings.open(&payload, (&call, total)) {
        Ok(transfer) => transfer,
        Err(failure) => return refuse(state, (failure, &dispatch)),
    };
    let timeout = core.limits.transfer_inactivity_timeout;

    core.receiving_requests
        .insert(transfer, (Arc::clone(&dispatch), Arc::clone(&handler)));

    // kept before its first credit goes, so a chunk that credit brings at once finds it
    if let Some(answering) = core.answering.get_mut(&call) {
        answering.receiving = Some(RequestReceiving { transfer });
    }

    touch_request_transfer(state, (transfer, timeout));

    let credits = state
        .core()
        .receivings
        .grant(transfer)
        .into_iter()
        .collect();

    send_credits(state, credits);
}

// sets a request's transfer's timer going again: silent too long, it is refused
fn touch_request_transfer<S: Side>(state: &mut S, (transfer, timeout): (u64, Duration)) {
    let core = state.core();
    let timer = core.after(timeout, move |state: &mut S| {
        let core = state.core();
        let Some((dispatch, _)) = core.receiving_requests.get(&transfer).cloned() else {
            return;
        };
        let failure = core.failure(ProtocolCode::TRANSFER_STALLED).saying(format!(
            "nothing came for {} milliseconds",
            timeout.as_millis()
        ));

        refuse(state, (failure, &dispatch));
    });

    if let Some(receiving) = state.core().receivings.get_mut(transfer) {
        cancel_timer(&mut receiving.timer);
        receiving.timer = Some(timer);
    } else {
        timer.cancel();
    }
}

// the call's session, from what its request came with, then its admission on it; while it
// resolves, its call id stays held, and what settles once its call ended is dropped
#[expect(
    clippy::type_complexity,
    clippy::too_many_lines,
    reason = "a request, its handler and how it came, resolved and admitted in one place, as the other sides do"
)]
fn resolve_session<S: Side>(
    state: &mut S,
    ((dispatch, payload, handler), (carried, is_forwarded)): (
        (Arc<Dispatch>, Bytes, Arc<Handler>),
        (Carried, bool),
    ),
) {
    let Some(signal) = signal_of(state, &dispatch) else {
        return;
    };
    let credential_scheme = carried.header.credential.as_ref().map(Credential::scheme);
    let has_credential = carried.header.credential.is_some();
    let is_later = matches!(
        credential_scheme,
        Some(CredentialScheme::JWT | CredentialScheme::ELSEWHERE)
    );

    // an ELSEWHERE its transport carried nothing beside has nothing to resolve: no credential came,
    // in a later turn all the same
    if credential_scheme == Some(CredentialScheme::ELSEWHERE)
        && carried.transport_credential.is_none()
    {
        return state.core().later(move |state: &mut S| {
            if !signal.is_aborted() {
                let failure = state
                    .core()
                    .failure(ProtocolCode::SESSION_REQUIRED)
                    .saying(NO_CREDENTIAL);
                let code = failure.code().get();

                refuse(state, (failure, &dispatch));
                tell_refused(
                    state,
                    (
                        &dispatch,
                        code,
                        Some("nothing-carried".to_owned()),
                        AccessRefusalStage::Credential,
                    ),
                );
            }
        });
    }

    // a JWT, or an ELSEWHERE carried, that its destination's handler forwards resolves to none here,
    // its destination's to verify, in a later turn all the same
    if is_later && is_forwarded {
        return state.core().later(move |state: &mut S| {
            if !signal.is_aborted() {
                admit_routed(state, (dispatch, payload, handler));
            }
        });
    }

    let request = SessionRequest {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        carried,
    };
    let resolution = state.session_of(&request, &signal);
    let settle = move |state: &mut S, resolved: Result<Resolved, Unresolved>| {
        match resolved {
            Ok(resolved) => {
                let (session, refused) = match resolved {
                    Resolved::Session(session) => {
                        let handle = Arc::clone(&dispatch.connection_handle);

                        (Some(state.resolved(session, &handle)), None)
                    }
                    Resolved::Refused(reason) => (None, Some(reason)),
                    Resolved::None => (None, None),
                };

                // a credential that does not hold refuses its call, whatever the procedure
                // requires, told with why when its resolution said
                if session.is_none() && has_credential {
                    let failure = state
                        .core()
                        .failure(ProtocolCode::SESSION_REQUIRED)
                        .saying(CREDENTIAL_NOT_HELD);
                    let code = failure.code().get();

                    refuse(state, (failure, &dispatch));
                    tell_refused(
                        state,
                        (&dispatch, code, refused, AccessRefusalStage::Credential),
                    );

                    return;
                }

                *locked(&dispatch.session) = session;
                admit_routed(state, (dispatch, payload, handler));
            }
            // a bound of the side's own refuses the call: nothing failed, so nothing is reported
            Err(Unresolved::Capacity(error)) => {
                let failure = state
                    .core()
                    .failure(ProtocolCode::CAPACITY_EXCEEDED)
                    .saying(error.message().to_owned());

                refuse(state, (failure, &dispatch));
            }
            Err(Unresolved::Other(error)) => {
                let handle = Arc::clone(&dispatch.connection_handle);

                state.report(RouterError::Other(error), &handle);

                let failure = state.core().failure(ProtocolCode::PROCEDURE_FAILED);

                refuse(state, (failure, &dispatch));
            }
        }
    };

    match resolution {
        Resolution::Now(resolved) if !is_later => settle(state, resolved),
        // ! a later turn, whether it waits or not, so the order of answers never turns on a
        // verifier
        Resolution::Now(resolved) => state.core().later(move |state: &mut S| {
            if !signal.is_aborted() {
                settle(state, resolved);
            }
        }),
        Resolution::Later(resolving) => {
            let owner = state.core().owner.clone();

            state.core().owner.cover(async move {
                let resolved = resolving.await;
                owner.offer(Box::new(move |state: &mut S| {
                    if !signal.is_aborted() {
                        settle(state, resolved);
                    }
                }));
            });
        }
    }
}

// the schemes the side takes, OPAQUE always, and the detail that names them
fn schemes_detail_of(schemes: &BTreeSet<u16>) -> String {
    schemes
        .iter()
        .map(|&scheme| CredentialScheme::new(scheme).to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// `CREDENTIAL_UNSUPPORTED`'s detail, as a 401 names its schemes (RFC 9110 §11.6.1).
#[must_use]
pub fn credential_schemes_detail_of(schemes: &[CredentialScheme]) -> String {
    schemes_detail_of(&schemes.iter().map(|scheme| scheme.get()).collect())
}

// a request's header as its side hands it to a procedure and its admission (spec 13.1): a `JWT`'s
// credential says its scheme alone
pub(crate) fn handed_header_of(header: &RequestHeader) -> RequestHeader {
    match &header.credential {
        Some(Credential::Jwt(_)) => RequestHeader {
            credential: Some(Credential::Jwt(Bytes::new())),
            ..header.clone()
        },
        Some(_) | None => header.clone(),
    }
}

// the schemes a destination's handler that forwards credentials unresolved takes
const FORWARDED_SCHEMES: [u16; 3] = [1, 2, 3];

#[expect(
    clippy::too_many_lines,
    clippy::type_complexity,
    reason = "a request taken through each step of spec 9.2 in its order, with how it came"
)]
fn receive_request<S: Side>(
    state: &mut S,
    ((header, payload), (handle, transport_credential, origin)): (
        (RequestHeader, Bytes),
        (
            &ConnectionHandle,
            Option<String>,
            (Option<String>, Option<u16>),
        ),
    ),
) {
    let core = state.core();
    let side = core.side;
    let call_id = header.call_id;
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };

    // a request of this side's own parity, or on a call id in use, would answer another call
    if RouterSide::of_call_id(call_id) == Some(side) {
        let failure = core
            .failure(ProtocolCode::ENVELOPE_MALFORMED)
            .saying(format!(
                "call {call_id} is this side's to open, not the peer's"
            ));

        return report_failure(state, (failure, (handle, &Header::Request(header))));
    }

    let is_open = core.answering.has(&call);

    if is_open || state.is_call_id_in_use(call_id, handle) {
        let failure = state
            .core()
            .failure(ProtocolCode::ENVELOPE_MALFORMED)
            .saying(format!("call {call_id} is open already"));

        return report_failure(state, (failure, (handle, &Header::Request(header))));
    }

    let core = state.core();
    // past the calls its connection has this side answer at once, it is refused before anything
    // else of it is read, and counted all the same
    let is_past_bound = core.answering.count_on(handle) >= core.limits.maximum_answering_calls;
    let registered = header
        .destination_id
        .is_none()
        .then(|| {
            locked(&core.resolvers)
                .get(&(header.service_id, header.procedure_id))
                .cloned()
        })
        .flatten();
    let series: Option<ProcedureSeries> = core.metrics.as_ref().map(|metrics| {
        registered
            .as_ref()
            .and_then(|registered| {
                registered
                    .series
                    .as_ref()
                    .map(|series| series.calls.clone())
            })
            .unwrap_or_else(|| metrics.other_server().clone())
    });
    let handed = if header.destination_id.is_none() {
        handed_header_of(&header)
    } else {
        header.clone()
    };
    let id = core.draw_id();
    let dispatch = Arc::new(Dispatch {
        id,
        connection_handle: Arc::clone(handle),
        header: handed,
        handler: Mutex::new(None),
        session: Mutex::new(None),
        answered: Mutex::new(None),
        origin,
    });

    // * its call starts as its request opens it, timed from its arrival
    if let Some(series) = &series {
        series.start();
    }

    let started_at = if series.is_some() {
        core.now()
    } else {
        Duration::ZERO
    };

    core.answering.forget_abandoned(&call, None);
    core.answering
        .answering
        .entry(Arc::clone(handle))
        .or_default()
        .insert(
            call_id,
            Answering {
                dispatched: id,
                signal: Signal::new(),
                is_answered: false,
                is_ended: false,
                receiving: None,
                series,
                started_at,
            },
        );

    // ! what its transport carried stands for ELSEWHERE alone (spec 13.1, 15.1)
    let carried = Carried {
        transport_credential: (header.credential.as_ref().map(Credential::scheme)
            == Some(CredentialScheme::ELSEWHERE))
        .then_some(transport_credential)
        .flatten(),
        header: header.clone(),
    };

    // ! opened and refused in one turn, as HTTP/2 refuses a stream past those it lets its peer open
    if is_past_bound {
        let failure = core
            .failure(ProtocolCode::CAPACITY_EXCEEDED)
            .saying(format!(
                "the calls a connection has answered at once are {} at most",
                core.limits.maximum_answering_calls
            ));

        return refuse(state, (failure, &dispatch));
    }

    // one that names a destination goes to the handler this side has for it — a relay's
    let destination = header
        .destination_id
        .and_then(|destination_id| state.handler_of_destination(destination_id));
    let is_destination = destination.is_some();
    let handler = destination.or_else(|| registered.map(|registered| registered.handler));

    let Some(handler) = handler else {
        let core = state.core();
        let failure = if let Some(destination_id) = header.destination_id {
            core.failure(ProtocolCode::DESTINATION_UNKNOWN)
                .saying(format!(
                    "this peer relays nothing, to {destination_id} or elsewhere"
                ))
        } else if !locked(&core.resolvers)
            .keys()
            .any(|&(service, _)| service == header.service_id)
        {
            core.failure(ProtocolCode::SERVICE_UNKNOWN)
                .saying(format!("no service {}", header.service_id))
        } else {
            core.failure(ProtocolCode::PROCEDURE_UNKNOWN)
                .saying(format!(
                    "no procedure {} in service {}",
                    header.procedure_id, header.service_id
                ))
        };

        return refuse(state, (failure, &dispatch));
    };

    *locked(&dispatch.handler) = Some(Arc::clone(&handler));

    // routed, a credential of a scheme this side takes none of — or its destination's handler
    // forwards none of — is refused before it resolves, the schemes it takes named
    let is_forwarded = is_destination && handler.forwards_credentials;
    let taken: BTreeSet<u16> = if is_forwarded {
        FORWARDED_SCHEMES.into_iter().collect()
    } else {
        let mut taken: BTreeSet<u16> = state
            .credential_schemes()
            .into_iter()
            .map(CredentialScheme::get)
            .collect();

        taken.insert(CredentialScheme::OPAQUE.get());
        taken
    };

    if let Some(scheme) = header.credential.as_ref().map(Credential::scheme)
        && !taken.contains(&scheme.get())
    {
        let failure = state
            .core()
            .failure(ProtocolCode::CREDENTIAL_UNSUPPORTED)
            .saying(schemes_detail_of(&taken));
        let unsupported = failure.code().get();

        refuse(state, (failure, &dispatch));
        tell_refused(
            state,
            (
                &dispatch,
                unsupported,
                Some("scheme".to_owned()),
                AccessRefusalStage::Credential,
            ),
        );

        return;
    }

    let handler = if is_destination {
        Arc::new(Handler {
            resolve: carrying_of(&handler, &carried),
            admit: handler
                .admit
                .clone()
                .map(|admit| admit_carrying(admit, carried.clone())),
            ..(*handler).clone()
        })
    } else {
        handler
    };

    resolve_session(
        state,
        ((dispatch, payload, handler), (carried, is_forwarded)),
    );
}

// a destination's handler as the core hands it a request: with what the request came with
fn carrying_of(handler: &Handler, carried: &Carried) -> ResolveFn {
    let resolve = Arc::clone(&handler.resolve);
    let carried = carried.clone();

    Arc::new(move |mut props: ResolverProps| {
        props.carried = Some(carried.clone());
        resolve(props)
    })
}

fn admit_carrying(admit: AdmitFn, carried: Carried) -> AdmitFn {
    Arc::new(move |request: &AdmissionRequest| {
        let mut request = request.clone();

        request.carried = Some(carried.clone());
        admit(&request)
    })
}

// a chunk no transfer takes: on a call abandoned, one under the credit it granted is late, and
// dropped in silence, and one past it was never granted; on a call open without a transfer, or on
// none, it is reported
pub(crate) fn receive_unplaced<S: Side>(
    state: &mut S,
    ((header, payload_length, handle), (credit_end, is_open)): (
        (crate::envelope::ChunkHeader, u64, &ConnectionHandle),
        (Option<u64>, bool),
    ),
) {
    let core = state.core();
    let call_id = header.call_id;
    let offset = header.offset;

    if let Some(credit_end) = credit_end {
        if payload_length <= credit_end.saturating_sub(offset) {
            return;
        }

        let failure = core.failure(ProtocolCode::CREDIT_EXCEEDED).saying(format!(
            "bytes from {offset} run past the credit's end of {credit_end}"
        ));

        return report_failure(state, (failure, (handle, &Header::Chunk(header))));
    }

    let failure = if is_open {
        core.failure(ProtocolCode::ENVELOPE_MALFORMED)
            .saying(format!("call {call_id} receives no transfer"))
    } else {
        core.failure(ProtocolCode::CALL_UNKNOWN)
    };

    report_failure(state, (failure, (handle, &Header::Chunk(header))));
}

// a chunk of a request's payload: the call is the peer's
fn receive_request_chunk<S: Side>(
    state: &mut S,
    (header, call, chunk): (crate::envelope::ChunkHeader, CallAddress, Chunk),
) {
    let core = state.core();
    let handle = Arc::clone(&call.connection_handle);
    let receiving = core
        .answering
        .get(&call)
        .and_then(|answering| answering.receiving.clone());
    let length = u64::try_from(chunk.bytes.len()).unwrap_or(u64::MAX);
    let Some(RequestReceiving { transfer }) = receiving else {
        let credit_end = core.answering.abandoned_end_of(&call);
        let is_open = core.answering.has(&call);

        return receive_unplaced(state, ((header, length, &handle), (credit_end, is_open)));
    };
    let Some((dispatch, handler)) = core.receiving_requests.get(&transfer).cloned() else {
        return;
    };
    // once whole, the payload went on to the resolver, which answers the call: a chunk ends nothing
    let was_whole = core
        .receivings
        .get(transfer)
        .is_some_and(|receiving| receiving.incoming.is_whole());
    let outcome = core.receivings.place(transfer, &chunk);
    let timeout = core.limits.transfer_inactivity_timeout;

    match outcome {
        Err(failure) => {
            if was_whole {
                report_failure(state, (failure, (&handle, &Header::Chunk(header))));
            } else {
                refuse(state, (failure, &dispatch));
            }
        }
        Ok(ChunkOutcome::Placed) => {
            touch_request_transfer(state, (transfer, timeout));

            let credits = state
                .core()
                .receivings
                .grant(transfer)
                .into_iter()
                .collect();

            send_credits(state, credits);
        }
        Ok(ChunkOutcome::Complete) => {
            let (payload, credits) = state.core().receivings.complete(transfer);

            send_credits(state, credits);
            dispatch_to(state, (handler, dispatch, payload));
        }
        // a chunk that brings nothing new is dropped in silence
        Ok(ChunkOutcome::Duplicate) => {}
    }
}

// ── Registering, ending ──────────────────────────────────────────────────────────────────────

/// The resolvers a router holds, by service and procedure: shared by its handle, which registers
/// them as it is asked, and its owner, which finds them.
pub(crate) type Resolvers = Arc<Mutex<BTreeMap<(u16, u16), Registered>>>;

/// Registers a handler for a procedure in `resolvers`, declared to the router's `metrics`.
pub(crate) fn register_resolver(
    resolvers: &Resolvers,
    (procedure, handler, metrics): (&crate::identity::Procedure, Handler, Option<&RouterMetrics>),
) -> Result<Option<ResolverSeries>, ProgrammerError> {
    let address = (procedure.service_id, procedure.id);

    if handler.maximum_payload_bytes == Some(0) {
        return Err(ProgrammerError::new(format!(
            "{}'s payload limit is a whole number above 0, not 0",
            procedure.name
        )));
    }

    let mut registered = locked(resolvers);

    if registered.contains_key(&address) {
        return Err(ProgrammerError::new(format!(
            "{} is already a registered resolver",
            procedure.name
        )));
    }

    // declared as it is registered: one the registry refuses is not registered either
    let series = metrics
        .map(|metrics| metrics.declare_resolver(procedure, handler.notifies))
        .transpose()?;

    registered.insert(
        address,
        Registered {
            handler: Arc::new(handler),
            series: series.clone(),
        },
    );
    drop(registered);

    Ok(series)
}

/// Rejects what waits for an answer — from `handle` only, when given — saying `reason`, forgets
/// the calls the connection opened, the call ids it reserved, and the session announced to it;
/// then the signal of each call it opened is aborted.
pub(crate) fn reject_pending<S: Side>(
    state: &mut S,
    (reason, handle): (&str, Option<&ConnectionHandle>),
) {
    let core = state.core();
    let credits = core.receivings.close_all(handle);

    drop(credits);
    core.sendings.close_all(handle);
    core.receiving_requests.retain(|_, (dispatch, _)| {
        handle.is_some_and(|handle| *handle != dispatch.connection_handle)
    });

    let rejected = crate::router::requester::take_all(state, handle);
    let core = state.core();

    core.announcements.forget(handle);

    // ! the calls it answers taken last, each counted closed once all are out
    let handles: Vec<ConnectionHandle> = handle.map_or_else(
        || {
            let mut handles: BTreeSet<ConnectionHandle> =
                core.answering.answering.keys().cloned().collect();

            handles.extend(core.answering.abandoned.keys().cloned());
            handles.into_iter().collect()
        },
        |handle| vec![Arc::clone(handle)],
    );
    let mut taken: Vec<(CallAddress, Answering)> = Vec::new();

    for handle in handles {
        if let Some(calls) = core.answering.answering.remove(&handle) {
            for (call_id, answering) in calls {
                taken.push((
                    CallAddress {
                        connection_handle: Arc::clone(&handle),
                        call_id,
                    },
                    answering,
                ));
            }
        }

        if let Some(calls) = core.answering.abandoned.remove(&handle) {
            for (_, mut abandoned) in calls {
                cancel_timer(&mut abandoned.timer);
            }
        }
    }

    // * read only when a call it takes is counted (spec/debugging.md 3.1)
    let now = if taken
        .iter()
        .any(|(_, answering)| !answering.is_ended && answering.series.is_some())
    {
        core.now()
    } else {
        Duration::ZERO
    };

    for (_, answering) in &mut taken {
        if !answering.is_ended
            && let Some(series) = &answering.series
        {
            answering.is_ended = true;
            series.end(
                CallEnding::Closed,
                microseconds_of(now.saturating_sub(answering.started_at)),
            );
        }
    }

    // then each call waiting settled, and each signal aborted, application code last
    for reply in rejected {
        reply(Err(CallError::Disconnected(reason.to_owned())));
    }

    for (_, answering) in taken {
        answering
            .signal
            .abort(SignalReason::Disconnected(reason.to_owned()));
    }
}

/// Rejects what still waits, aborts the signal of each call it still answers, and sends nothing
/// more: no cancel either.
pub(crate) fn dispose<S: Side>(state: &mut S) {
    state.core().is_disposed = true;
    reject_pending(state, (&format!("{DISPOSED} before the answer"), None));
}

/// Sends a notification to one subscription, counted: sent once its transport has it, whatever the
/// transport does with it after; failed when it could not be handed to it.
pub(crate) fn send_notification<S: Side>(
    state: &mut S,
    ((payload, call, series), done): (
        (
            Bytes,
            CallAddress,
            Option<crate::metrics::NotificationSeries>,
        ),
        Option<Responded<S>>,
    ),
) {
    let handed = Arc::new(Mutex::new(false));
    let mut options = Deliver::to(&call.connection_handle);
    let (on_handed, on_then) = (Arc::clone(&handed), handed);
    let (sent_series, failed_series) = (series.clone(), series);

    options.on_hand_off = Some(Box::new(move |_state: &mut S| {
        *locked(&on_handed) = true;

        if let Some(series) = &sent_series {
            series.sent();
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            // ! handed to its transport, and refused by it after, it keeps its count as sent
            if outcome.is_err()
                && !*locked(&on_then)
                && let Some(series) = &failed_series
            {
                series.failed();
            }

            if let Some(done) = done {
                done(state, outcome);
            }
        },
    ));
    deliver(
        state,
        (
            Envelope::Notification {
                header: NotificationHeader {
                    call_id: call.call_id,
                },
                payload,
            },
            options,
        ),
    );
}
