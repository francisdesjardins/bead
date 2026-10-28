//! What a router takes and gives: a connection's handle, its limits, a call's options, a call's
//! session, a result, an answer, what a transport hands it, and what it tells.

use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::constants::CredentialScheme;
use crate::duration::{LONGEST_TIMER, hold_finite};
use crate::envelope::{FailureRecord, MAXIMUM_DETAIL_BYTES, MAXIMUM_ENVELOPE_BYTES, ResultHeader};
use crate::errors::ProgrammerError;
use crate::failure::Failure;

/// A future of Bead's, boxed, as an application's callback gives one.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Who a request came from, as a router names the connection: `server` on a client's; on a
/// server's, the handle its transport drew.
pub type ConnectionHandle = Arc<str>;

/// A call's place: the connection it is on, and its call id there.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CallAddress {
    /// Its connection.
    pub connection_handle: ConnectionHandle,
    /// Its call id.
    pub call_id: u32,
}

/// How much a router reads, writes and holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterLimits {
    /// The bytes every transfer the router receives holds together.
    pub buffered_bytes_budget: u64,
    /// A chunk's envelope, its header included, in bytes.
    pub chunk_bytes: u64,
    /// The calls a connection's peer has this side answer at once, and this side has wait.
    pub maximum_answering_calls: u64,
    /// The runs of bytes apart one transfer received may hold before it is whole.
    pub maximum_chunk_runs: u64,
    /// A failure's detail, in bytes, cut at a character's boundary.
    pub maximum_detail_bytes: u64,
    /// A whole envelope, its header included, in bytes.
    pub maximum_envelope_bytes: u64,
    /// A whole payload, in bytes, sent in one envelope or as a transfer.
    pub maximum_payload_bytes: u64,
    /// The transfers a connection receives at once; 0 sends and takes none.
    pub maximum_transfers: u64,
    /// How long a transfer waits for its next chunk or credit before it stalls.
    pub transfer_inactivity_timeout: Duration,
    /// How far past the bytes it received, contiguous, a receiver lets its sender send.
    pub window_bytes: u64,
}

/// A router's limits as its options give them: each left out, the default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct RouterLimitsOptions {
    /// See [`RouterLimits::buffered_bytes_budget`].
    pub buffered_bytes_budget: Option<u64>,
    /// See [`RouterLimits::chunk_bytes`].
    pub chunk_bytes: Option<u64>,
    /// See [`RouterLimits::maximum_answering_calls`].
    pub maximum_answering_calls: Option<u64>,
    /// See [`RouterLimits::maximum_chunk_runs`].
    pub maximum_chunk_runs: Option<u64>,
    /// See [`RouterLimits::maximum_detail_bytes`].
    pub maximum_detail_bytes: Option<u64>,
    /// See [`RouterLimits::maximum_envelope_bytes`].
    pub maximum_envelope_bytes: Option<u64>,
    /// See [`RouterLimits::maximum_payload_bytes`].
    pub maximum_payload_bytes: Option<u64>,
    /// See [`RouterLimits::maximum_transfers`].
    pub maximum_transfers: Option<u64>,
    /// See [`RouterLimits::transfer_inactivity_timeout`].
    pub transfer_inactivity_timeout: Option<Duration>,
    /// See [`RouterLimits::window_bytes`].
    pub window_bytes: Option<u64>,
}

/// How much a router reads, writes and holds when its options say nothing.
pub const LIMIT_DEFAULTS: RouterLimits = RouterLimits {
    buffered_bytes_budget: 268_435_456,
    chunk_bytes: 1_048_576,
    maximum_answering_calls: 64,
    maximum_chunk_runs: 1_024,
    maximum_detail_bytes: 1_024,
    maximum_envelope_bytes: 16_778_240,
    maximum_payload_bytes: 16_777_216,
    maximum_transfers: 4,
    transfer_inactivity_timeout: Duration::from_secs(30),
    window_bytes: 4_194_304,
};

const _: () = {
    assert!(
        MAXIMUM_DETAIL_BYTES == 1_024,
        "the detail's default is the limits'"
    );
    assert!(
        MAXIMUM_ENVELOPE_BYTES == 16_778_240,
        "the envelope's default is the limits'"
    );
};

/// `given` over [`LIMIT_DEFAULTS`], where it says nothing.
///
/// # Errors
///
/// A [`ProgrammerError`] for a limit of 0 — but the transfers and the detail — for limits that do
/// not hold together, or for a transfer's inactivity spec 1.4 does not hold, held rounded.
pub fn limits_of(given: &RouterLimitsOptions) -> Result<RouterLimits, ProgrammerError> {
    let defaults = LIMIT_DEFAULTS;
    let limits = RouterLimits {
        buffered_bytes_budget: given
            .buffered_bytes_budget
            .unwrap_or(defaults.buffered_bytes_budget),
        chunk_bytes: given.chunk_bytes.unwrap_or(defaults.chunk_bytes),
        maximum_answering_calls: given
            .maximum_answering_calls
            .unwrap_or(defaults.maximum_answering_calls),
        maximum_chunk_runs: given
            .maximum_chunk_runs
            .unwrap_or(defaults.maximum_chunk_runs),
        maximum_detail_bytes: given
            .maximum_detail_bytes
            .unwrap_or(defaults.maximum_detail_bytes),
        maximum_envelope_bytes: given
            .maximum_envelope_bytes
            .unwrap_or(defaults.maximum_envelope_bytes),
        maximum_payload_bytes: given
            .maximum_payload_bytes
            .unwrap_or(defaults.maximum_payload_bytes),
        maximum_transfers: given
            .maximum_transfers
            .unwrap_or(defaults.maximum_transfers),
        transfer_inactivity_timeout: given
            .transfer_inactivity_timeout
            .unwrap_or(defaults.transfer_inactivity_timeout),
        window_bytes: given.window_bytes.unwrap_or(defaults.window_bytes),
    };

    for (name, value) in [
        ("bufferedBytesBudget", limits.buffered_bytes_budget),
        ("chunkBytes", limits.chunk_bytes),
        ("maximumAnsweringCalls", limits.maximum_answering_calls),
        ("maximumChunkRuns", limits.maximum_chunk_runs),
        ("maximumEnvelopeBytes", limits.maximum_envelope_bytes),
        ("maximumPayloadBytes", limits.maximum_payload_bytes),
        ("windowBytes", limits.window_bytes),
    ] {
        if value < 1 {
            return Err(ProgrammerError::new(format!(
                "{name} is a whole number above 0, not {value}"
            )));
        }
    }

    let rules: [(bool, &str); 4] = [
        (
            limits.maximum_envelope_bytes >= 64,
            "an envelope is 64 bytes at least",
        ),
        (
            limits.chunk_bytes >= 64 && limits.chunk_bytes <= limits.maximum_envelope_bytes,
            "a chunk's envelope is 64 bytes at least, and an envelope at most",
        ),
        (
            limits.window_bytes >= limits.chunk_bytes.saturating_mul(2),
            "a window holds two chunks at least, so a sender waits for no credit it is owed",
        ),
        (
            limits.maximum_payload_bytes <= limits.buffered_bytes_budget,
            "a payload fits in the budget of the transfers received",
        ),
    ];

    if let Some((_, rule)) = rules.iter().find(|(holds, _)| !holds) {
        return Err(ProgrammerError::new(format!(
            "the router's limits do not hold together: {rule}"
        )));
    }

    // never, refused: a silent transfer stalls in time, and the call id it keeps reserved goes free
    Ok(RouterLimits {
        transfer_inactivity_timeout: hold_finite(
            "a transfer's inactivity",
            limits.transfer_inactivity_timeout,
        )?,
        ..limits
    })
}

/// A router's limits over a transport that carries each envelope whole and no transfer.
///
/// No transfer either way, a payload up to what one envelope holds, and a window the limits'
/// rules want and nothing reads.
///
/// # Errors
///
/// A [`ProgrammerError`] for a transfer asked for.
pub fn whole_envelope_limits_of(
    limits: &RouterLimitsOptions,
) -> Result<RouterLimitsOptions, ProgrammerError> {
    let maximum_envelope_bytes = limits
        .maximum_envelope_bytes
        .unwrap_or(LIMIT_DEFAULTS.maximum_envelope_bytes);
    let maximum_transfers = limits.maximum_transfers.unwrap_or(0);

    if maximum_transfers != 0 {
        return Err(ProgrammerError::new(format!(
            "a transport of whole envelopes carries no transfer: maximumTransfers is 0, not {maximum_transfers}"
        )));
    }

    let mut whole = limits.clone();

    whole.chunk_bytes = Some(maximum_envelope_bytes);
    whole.maximum_envelope_bytes = Some(maximum_envelope_bytes);
    whole.maximum_transfers = Some(0);
    whole.window_bytes = Some(maximum_envelope_bytes.saturating_mul(2));

    Ok(whole)
}

/// A credential's session's identifier (spec 13.10): its scheme and its claim.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum SessionIdentifier {
    /// An `ELSEWHERE`'s verifier's `id`.
    Elsewhere {
        /// Its id.
        id: String,
    },
    /// A `JWT`'s `iss` with its `sid`.
    JwtSid {
        /// Its issuer.
        issuer: String,
        /// Its `sid`.
        sid: String,
    },
    /// A `JWT`'s `iss` with its `sub`.
    JwtSub {
        /// Its issuer.
        issuer: String,
        /// Its `sub`.
        sub: String,
    },
}

impl SessionIdentifier {
    /// The key a session is held under, per connection (spec 11.3, 13.10): two keys are one exactly
    /// when the identifiers are one, octet for octet.
    #[must_use]
    pub fn key(&self) -> String {
        let written = match self {
            Self::Elsewhere { id } => {
                serde_json::json!([CredentialScheme::ELSEWHERE.get(), "id", id])
            }
            Self::JwtSid { issuer, sid } => {
                serde_json::json!([CredentialScheme::JWT.get(), "sid", issuer, sid])
            }
            Self::JwtSub { issuer, sub } => {
                serde_json::json!([CredentialScheme::JWT.get(), "sub", issuer, sub])
            }
        };

        written.to_string()
    }
}

/// The key a session is held under: empty for a connection's session.
#[must_use]
pub fn session_key_of(identifier: Option<&SessionIdentifier>) -> String {
    identifier.map(SessionIdentifier::key).unwrap_or_default()
}

/// The session a call runs in, its credential resolved (spec 13.1).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CallSession {
    /// What the session holds: a connection's session's data, a `JWT`'s claims set, or what an
    /// `ELSEWHERE`'s verifier gave.
    pub data: Option<Value>,
    /// A credential's session's end, in whole milliseconds since the epoch (spec 13.10).
    pub end: Option<i64>,
    /// A credential's session's identifier; none for a connection's session.
    pub identifier: Option<SessionIdentifier>,
}

/// The credential a call presents, among its options.
#[derive(Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RequestCredential {
    /// None, whatever the default.
    None,
    /// The session its router learned.
    Opaque,
    /// A `JWT`, its token.
    Jwt(String),
    /// An `ELSEWHERE`: what its transport carries beside the request.
    Elsewhere(String),
}

impl fmt::Debug for RequestCredential {
    // ! a bearer credential is never written out: its scheme alone
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scheme = match self {
            Self::None => CredentialScheme::NONE,
            Self::Opaque => CredentialScheme::OPAQUE,
            Self::Jwt(_) => CredentialScheme::JWT,
            Self::Elsewhere(_) => CredentialScheme::ELSEWHERE,
        };

        write!(formatter, "RequestCredential({scheme})")
    }
}

/// A call's signal: cancelled when the call ends before its answer, saying why.
#[derive(Debug, Clone, Default)]
pub struct Signal {
    token: CancellationToken,
    reason: Arc<Mutex<Option<SignalReason>>>,
}

/// Why a call's signal was aborted.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SignalReason {
    /// Its requester cancelled it.
    Cancelled,
    /// Its connection closed, or its router was disposed, saying why.
    Disconnected(String),
}

impl Signal {
    /// A signal not aborted.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Aborts it, saying why: the first reason stands.
    pub fn abort(&self, reason: SignalReason) {
        {
            let mut held = self.reason.lock().unwrap_or_else(PoisonError::into_inner);

            if held.is_none() {
                *held = Some(reason);
            }
        }

        self.token.cancel();
    }

    /// Whether it was aborted.
    #[must_use]
    pub fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Why it was aborted.
    #[must_use]
    pub fn reason(&self) -> Option<SignalReason> {
        self.reason
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The token it cancels.
    #[must_use]
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

/// A request's options, with its manager's defaults applied.
#[derive(Debug, Clone)]
pub struct ResolvedRequestOptions {
    /// The call's timeout, held; [`crate::NEVER`] waits on.
    pub timeout: Duration,
    /// What the request is for behind the peer; the peer itself when none.
    pub destination_id: Option<u32>,
    /// The connection it goes to, for a router with more than one.
    pub connection_handle: Option<ConnectionHandle>,
    /// The credential it presents, for this call alone.
    pub credential: Option<RequestCredential>,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// Whether the connection it names is closed when it goes unanswered past its timeout.
    pub close_on_timeout: bool,
}

/// A result, as a request resolves with it: its header, and its payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterResult {
    /// Its header.
    pub header: ResultHeader,
    /// Its payload, whole.
    pub payload: Bytes,
}

/// An answer to a request: its result's payload, or a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RouterAnswer {
    /// A result, its payload.
    Result(Bytes),
    /// A failure.
    Failure(FailureRecord),
}

/// What a transport hands its router of one message: an envelope's bytes, and what came beside it.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TransportMessage {
    /// The envelope's bytes.
    pub data: Bytes,
    /// The credential its transport carried beside it, which an `ELSEWHERE` stands for.
    pub credential: Option<String>,
    /// The client's address, as its transport read it.
    pub address: Option<String>,
    /// The client's port, as its transport read it.
    pub port: Option<u16>,
    /// Whether it came by a way that keeps no order with its call's answer.
    pub may_overtake: bool,
}

impl fmt::Debug for TransportMessage {
    // ! whether its transport carried a credential, never the credential; its envelope's bytes
    // counted, never written, a header's credential among them
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransportMessage")
            .field("data", &format_args!("{} bytes", self.data.len()))
            .field("address", &self.address)
            .field("port", &self.port)
            .field("may_overtake", &self.may_overtake)
            .field(
                "credential",
                &format_args!("{}", carried_or_none(self.credential.as_ref())),
            )
            .finish()
    }
}

/// How a string writes what a transport carried beside a request: whether it did, never what.
pub(crate) const fn carried_or_none(credential: Option<&String>) -> &'static str {
    if credential.is_some() {
        "carried"
    } else {
        "none"
    }
}

/// What a router did: sent or took a request, a response, or a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RouterActivity {
    /// A notification.
    Notification,
    /// A request.
    Request,
    /// A response.
    Response,
}

/// The stage of a request's that refused it, told (spec 13.12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AccessRefusalStage {
    /// Its admission.
    Admission,
    /// Its credential.
    Credential,
}

/// A call a server refused as its credential resolved or as it was admitted, as it tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRefusal {
    /// The stage that refused it.
    pub stage: AccessRefusalStage,
    /// The failure answered.
    pub code: u16,
    /// Why, in one word.
    pub reason: Option<String>,
    /// The scheme its header named.
    pub credential_scheme: Option<CredentialScheme>,
    /// Its service.
    pub service_id: u16,
    /// Its procedure.
    pub procedure_id: u16,
    /// The destination it named.
    pub destination_id: Option<u32>,
    /// Its connection.
    pub connection_handle: ConnectionHandle,
    /// The client's address of the request.
    pub address: Option<String>,
    /// The client's port of the request.
    pub port: Option<u16>,
}

/// What went wrong that no call waits on, as a router reports it.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RouterError {
    /// A failure of the protocol's, raised or received.
    Failure(Failure),
    /// Anything else: what an application's code failed with, or a transport's error.
    Other(Arc<dyn Error + Send + Sync>),
}

impl fmt::Display for RouterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failure(failure) => write!(formatter, "{failure}"),
            Self::Other(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for RouterError {}

/// What a part holds right now, for diagnosis: its counts and ceilings, the connections it keeps
/// anything for, and what it found that should never be.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Gauges {
    /// What it holds, by name.
    pub counts: BTreeMap<&'static str, u64>,
    /// What it holds at most, by name.
    pub ceilings: BTreeMap<&'static str, u64>,
    /// The connections it keeps anything for.
    pub connection_handles: BTreeSet<ConnectionHandle>,
    /// What it found that should never be.
    pub anomalies: Vec<String>,
}

impl Gauges {
    /// The gauges of several parts as one.
    #[must_use]
    pub fn merged(parts: Vec<Self>) -> Self {
        let mut merged = Self::default();

        for part in parts {
            merged.counts.extend(part.counts);
            merged.ceilings.extend(part.ceilings);
            merged.connection_handles.extend(part.connection_handles);
            merged.anomalies.extend(part.anomalies);
        }

        merged
    }
}

/// The longest a call id is reserved for, its call's timeout held, or the default for none.
#[must_use]
pub(crate) fn reservation_of(timeout: Option<Duration>) -> Duration {
    timeout
        .filter(|&timeout| timeout <= LONGEST_TIMER)
        .unwrap_or(crate::constants::RESERVATION)
}
