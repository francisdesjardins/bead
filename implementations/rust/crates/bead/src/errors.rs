//! The errors Bead's operations return beside a [`Failure`]: a misuse refused as it is made, a
//! call's end other than its answer, a connection that could not open or reopen, a bound reached,
//! a transport asked for what its state does not allow, and what a resolver fails with.

use core::fmt;
use core::time::Duration;
use std::error::Error;
use std::sync::Arc;

use crate::debug::FilterRefusal;
use crate::duration::DurationRefusal;
use crate::failure::Failure;
use crate::identity::IdentityRefusal;

/// Why a misuse is refused, where a conformance file derives a reason a side checks by its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Refusal {
    /// A duration spec 1.4 does not hold.
    Duration(DurationRefusal),
    /// A procedure's declaration spec 16.10 refuses.
    Identity(IdentityRefusal),
    /// A debug filter `spec/debugging.md` 6.7 refuses.
    Filter(FilterRefusal),
}

/// A misuse of the API, refused as it is made and before anything is done: its message, and its
/// reason where a conformance file derives one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgrammerError {
    message: String,
    reason: Option<Refusal>,
}

impl ProgrammerError {
    /// A misuse, saying `message`.
    #[must_use]
    pub fn new<M: Into<String>>(message: M) -> Self {
        Self {
            message: message.into(),
            reason: None,
        }
    }

    /// A misuse of a reason a conformance file derives, saying `message`.
    #[must_use]
    pub fn refused<M: Into<String>>(reason: Refusal, message: M) -> Self {
        Self {
            message: message.into(),
            reason: Some(reason),
        }
    }

    /// What it says.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Its reason, where a conformance file derives one.
    #[must_use]
    pub fn reason(&self) -> Option<Refusal> {
        self.reason
    }
}

impl fmt::Display for ProgrammerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ProgrammerError {}

/// How a call ended, other than with its result.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum CallError {
    /// A failure answered, or raised here before or as it went.
    Failure(Failure),
    /// Cancelled by its signal: its answer is not waited on, and the peer, once it went, is sent a
    /// cancel.
    Cancelled,
    /// Its connection closed before its answer came, or its router was disposed, saying why.
    Disconnected(String),
    /// No answer came within its timeout.
    TimedOut(Duration),
    /// Refused as it started, before it went, as its side judged it.
    Refused(ProgrammerError),
    /// What its transport, or an application's code, failed with.
    Other(Arc<dyn Error + Send + Sync>),
}

impl From<Failure> for CallError {
    fn from(failure: Failure) -> Self {
        Self::Failure(failure)
    }
}

impl From<ProgrammerError> for CallError {
    fn from(error: ProgrammerError) -> Self {
        Self::Refused(error)
    }
}

impl fmt::Display for CallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failure(failure) => write!(formatter, "{failure}"),
            Self::Cancelled => formatter.write_str("the call was cancelled"),
            Self::Disconnected(reason) => formatter.write_str(reason),
            Self::TimedOut(timeout) => {
                write!(formatter, "no answer came within {}ms", timeout.as_millis())
            }
            Self::Refused(error) => write!(formatter, "{error}"),
            Self::Other(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for CallError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Failure(failure) => Some(failure),
            Self::Refused(error) => Some(error),
            Self::Other(error) => {
                let source: &(dyn Error + 'static) = error.as_ref();
                Some(source)
            }
            Self::Cancelled | Self::Disconnected(_) | Self::TimedOut(_) => None,
        }
    }
}

/// A connection that could not be opened, saying why.
#[derive(Debug, Clone)]
pub struct ConnectError {
    message: String,
    source: Option<Arc<dyn Error + Send + Sync>>,
}

impl ConnectError {
    /// A connect that failed, saying `message`.
    #[must_use]
    pub fn new<M: Into<String>>(message: M) -> Self {
        Self {
            message: message.into(),
            source: None,
        }
    }

    /// A connect that failed, saying `message`, caused by `source`.
    #[must_use]
    pub fn caused<M: Into<String>>(message: M, source: Arc<dyn Error + Send + Sync>) -> Self {
        Self {
            message: message.into(),
            source: Some(source),
        }
    }

    /// What it says.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ConnectError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| {
            let source: &(dyn Error + 'static) = source;
            source
        })
    }
}

/// A reconnection that ran out of attempts, the last attempt's error its source.
#[derive(Debug, Clone)]
pub struct ReconnectError {
    attempts: u32,
    last: Option<Arc<dyn Error + Send + Sync>>,
}

impl ReconnectError {
    /// A reconnection that ended after `attempts`, the last one failing with `last`.
    #[must_use]
    pub fn new(attempts: u32, last: Option<Arc<dyn Error + Send + Sync>>) -> Self {
        Self { attempts, last }
    }

    /// The attempts it made.
    #[must_use]
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

impl fmt::Display for ReconnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "attempt {} reached", self.attempts)
    }
}

impl Error for ReconnectError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.last.as_deref().map(|last| {
            let source: &(dyn Error + 'static) = last;
            source
        })
    }
}

/// A bound of the side's own, reached (spec 8.2): its router answers the call it refuses
/// `CAPACITY_EXCEEDED`, its message for detail, and reports nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityError {
    message: String,
}

impl CapacityError {
    /// A bound reached, saying `message`.
    #[must_use]
    pub fn new<M: Into<String>>(message: M) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// What it says.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CapacityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CapacityError {}

/// A transport client asked for what its state does not allow: `the transport client is
/// uninitialized, not open`, in the other sides' words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyStateError {
    got: &'static str,
    expected: &'static str,
}

impl ReadyStateError {
    /// A state `got` where `expected` was needed, each by its name.
    #[must_use]
    pub fn new(got: &'static str, expected: &'static str) -> Self {
        Self { got, expected }
    }
}

impl fmt::Display for ReadyStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "the transport client is {}, not {}",
            self.got.to_lowercase(),
            self.expected.to_lowercase()
        )
    }
}

impl Error for ReadyStateError {}

/// What a resolver, an admission, a verifier or a codec the application gives fails with.
///
/// The procedure's own failure, answered as it is, or any other error, answered `PROCEDURE_FAILED`
/// with no detail and reported (spec 9.0).
#[derive(Debug)]
#[non_exhaustive]
pub enum ResolverError {
    /// The procedure's own failure, answered as it is.
    Failure(Failure),
    /// Anything else, answered `PROCEDURE_FAILED` with no detail and reported.
    Other(Box<dyn Error + Send + Sync>),
}

impl ResolverError {
    /// Any other error, answered `PROCEDURE_FAILED` with no detail and reported:
    /// `.map_err(ResolverError::other)?` from any error.
    #[must_use]
    pub fn other<E: Into<Box<dyn Error + Send + Sync>>>(error: E) -> Self {
        Self::Other(error.into())
    }
}

impl From<Failure> for ResolverError {
    fn from(failure: Failure) -> Self {
        Self::Failure(failure)
    }
}

impl fmt::Display for ResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failure(failure) => write!(formatter, "{failure}"),
            Self::Other(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for ResolverError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Failure(failure) => Some(failure),
            Self::Other(error) => {
                let source: &(dyn Error + 'static) = error.as_ref();
                Some(source)
            }
        }
    }
}

/// What an owner refuses once its router is disposed, or gone: nothing more is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Disposed;

impl fmt::Display for Disposed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the router is disposed")
    }
}

impl Error for Disposed {}

/// How a transport's connect, reconnection or disconnect ended, other than as asked.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum TransportError {
    /// Refused as it was made: its options, or a state it cannot start from.
    Refused(ProgrammerError),
    /// Cancelled by its signal.
    Cancelled(String),
    /// Not open within its timeout.
    TimedOut(Duration),
    /// The connection could not be opened.
    Connect(ConnectError),
    /// The transport was in another state.
    ReadyState(ReadyStateError),
    /// The reconnection ran out of attempts.
    Reconnect(ReconnectError),
}

impl From<ProgrammerError> for TransportError {
    fn from(error: ProgrammerError) -> Self {
        Self::Refused(error)
    }
}

impl From<ConnectError> for TransportError {
    fn from(error: ConnectError) -> Self {
        Self::Connect(error)
    }
}

impl From<ReadyStateError> for TransportError {
    fn from(error: ReadyStateError) -> Self {
        Self::ReadyState(error)
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(error) => write!(formatter, "{error}"),
            Self::Cancelled(reason) => formatter.write_str(reason),
            Self::TimedOut(timeout) => write!(
                formatter,
                "the connect did not open in {} milliseconds",
                timeout.as_millis()
            ),
            Self::Connect(error) => write!(formatter, "{error}"),
            Self::ReadyState(error) => write!(formatter, "{error}"),
            Self::Reconnect(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for TransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Refused(error) => Some(error),
            Self::Connect(error) => Some(error),
            Self::ReadyState(error) => Some(error),
            Self::Reconnect(error) => Some(error),
            Self::Cancelled(_) | Self::TimedOut(_) => None,
        }
    }
}
