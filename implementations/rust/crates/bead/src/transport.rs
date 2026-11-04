//! What a router takes its envelopes from and hands them to (spec 15.1): a transport server's
//! connections, each under a handle it draws, and a transport client's one connection; the events
//! each tells, each listener called within a guard, so what one throws is reported and the transport
//! goes on as if it returned.

use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicU64, Ordering};
use core::task::{Context, Poll};
use core::time::Duration;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock};
use crate::duration::hold_delay;
use crate::errors::{ConnectError, ProgrammerError, ReconnectError, TransportError};
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};

#[cfg(test)]
mod tests;

/// What a transport's send gives: handed over and done, or handed over and settling later.
#[non_exhaustive]
pub enum Sent {
    /// Handed over, and done.
    Done,
    /// Handed over, settling later.
    Later(BoxFuture<Result<(), RouterError>>),
}

impl fmt::Debug for Sent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Done => formatter.write_str("Done"),
            Self::Later(_) => formatter.write_str("Later"),
        }
    }
}

/// Where a transport's end stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReadyState {
    /// Opening.
    Connecting,
    /// Open.
    Open,
    /// Closing.
    Closing,
    /// Closed.
    Closed,
    /// Never opened.
    Uninitialized,
    /// Reconnecting.
    Reconnecting,
}

impl ReadyState {
    /// Its name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Connecting => "CONNECTING",
            Self::Open => "OPEN",
            Self::Closing => "CLOSING",
            Self::Closed => "CLOSED",
            Self::Uninitialized => "UNINITIALIZED",
            Self::Reconnecting => "RECONNECTING",
        }
    }

    /// Its name, as a sentence says it.
    #[must_use]
    pub const fn said(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Open => "open",
            Self::Closing => "closing",
            Self::Closed => "closed",
            Self::Uninitialized => "uninitialized",
            Self::Reconnecting => "reconnecting",
        }
    }
}

/// A refusal a transport server judged of its own (spec 15.1).
///
/// A request it refused as it arrived, or whose body it refused as it came, marked in
/// `bead-refusal`; over a broker, an OPEN refused (spec 15.18). It carries nothing else of the
/// request, and names no connection, since a refusal is a request's.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TransportServerRefusal {
    /// The client's address, as its transport reads it: over a broker, the id its OPEN claims; none
    /// when its transport gives none.
    pub address: Option<String>,
    /// The request's authority as it came, its port included; none when it names none, and over a
    /// broker.
    pub authority: Option<String>,
    /// The request's `Origin` as it came; none when it sends none, and over a broker.
    pub origin: Option<String>,
    /// The client's port; none when its transport gives none, as over a broker.
    pub port: Option<u16>,
    /// The mark it was refused with: `busy`, `malformed`, `layout-refused`…
    pub reason: String,
    /// The status it was refused with.
    pub status: u16,
}

impl TransportServerRefusal {
    /// A refusal of `status` and `reason`, nothing else of it told.
    #[must_use]
    pub fn new<R: Into<String>>(status: u16, reason: R) -> Self {
        Self {
            address: None,
            authority: None,
            origin: None,
            port: None,
            reason: reason.into(),
            status,
        }
    }
}

/// A connection a transport server holds, as it tells it: its handle, the address and the port its
/// client gave, when it last delivered an envelope, and its transport's type.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TransportServerClient {
    /// The handle its transport drew.
    pub connection_handle: ConnectionHandle,
    /// The client's address, as its transport read it: over a broker, its participant's id.
    pub address: String,
    /// The client's port; none when its transport gives none, as over a broker.
    pub port: Option<u16>,
    /// When it last delivered an envelope, as its server's clock read it; none before its first.
    pub last_activity: Option<SystemTime>,
    /// Its transport's type: [`crate::TRANSPORT_MEMORY`] or [`crate::TRANSPORT_BROKER`].
    pub transport_type: &'static str,
}

/// What hears a transport server's events.
pub trait ServerListener: Send + Sync {
    /// A connection drawn, under its handle.
    fn on_connection(&self, _connection_handle: &ConnectionHandle) {}

    /// A message from a connection, and what came beside it.
    fn on_message(&self, _message: TransportMessage, _connection_handle: &ConnectionHandle) {}

    /// A connection closed: `was_clean` when by its own word.
    fn on_close(&self, _was_clean: bool, _connection_handle: &ConnectionHandle) {}

    /// A listen held on a connection, `is_held`, and its end.
    fn on_listen(&self, _is_held: bool, _connection_handle: &ConnectionHandle) {}

    /// A refusal the transport judged of its own (spec 15.1), which names no connection.
    fn on_refusal(&self, _refusal: &TransportServerRefusal) {}

    /// What went wrong on a connection, or what a listener threw; none for the transport's own.
    fn on_error(&self, _error: &RouterError, _connection_handle: Option<&ConnectionHandle>) {}
}

/// A transport server, as a router reaches it.
pub trait ServerTransport: Send + Sync + fmt::Debug {
    /// Hands an envelope's bytes over for `connection_handle`, with the credential it carries.
    ///
    /// # Errors
    ///
    /// What refuses it before it is handed over: a connection not open, say.
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError>;

    /// Closes a connection; settles with whether it held it.
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool>;

    /// Hears its events from now on.
    fn listen(&self, listener: Arc<dyn ServerListener>);

    /// Hears its events no more.
    fn unlisten(&self, listener: &Arc<dyn ServerListener>);

    /// Pauses `connection_handle`, its router behind on it (spec 15.12, decision 0046): it hands
    /// nothing more of that connection, and holds what it already received, whole or still
    /// arriving, in order, until it is resumed; while it holds anything, what comes next waits
    /// behind it, paused or not, so nothing overtakes what is held. A transport whose peer is its
    /// application's own code holds without bound, and says so.
    ///
    /// Idempotent, it never blocks and tells no listener within it. Its router calls it under the
    /// lock of its counts, from a reader's thread or its own turn, so it takes no lock that this
    /// transport holds while it tells a listener.
    fn pause(&self, connection_handle: &ConnectionHandle);

    /// Resumes `connection_handle`: what it holds it hands on, in order, from a later step of its
    /// own, never within this call, asking before each hand whether it was paused again. As
    /// [`ServerTransport::pause`], idempotent, never blocking, telling no listener within it, and
    /// taking no lock this transport holds while it tells one.
    fn resume(&self, connection_handle: &ConnectionHandle);

    /// The clock it runs on, which the layers above it run on too.
    fn clock(&self) -> Option<SharedClock> {
        None
    }

    /// Whether a connection carries both ways.
    fn is_two_way(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    /// Whether a connection stays off the machine's clear: under TLS, on the loopback, in memory.
    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        false
    }

    /// Whether a connection carries a credential beside an envelope the router sends.
    fn carries_credential(&self, _connection_handle: &ConnectionHandle) -> bool {
        false
    }

    /// Starts it.
    ///
    /// # Errors
    ///
    /// A [`RouterError`] when its options or state are refused, or its listener cannot start.
    fn start(&self) -> BoxFuture<Result<(), RouterError>>;

    /// Stops it, closing every connection; settles at once when it never started or stopped
    /// already, and shares a stop under way.
    ///
    /// # Errors
    ///
    /// A stop while it starts, refused as the other sides' transport server refuses it: `the
    /// transport server is starting`.
    fn stop(&self) -> BoxFuture<Result<(), RouterError>>;

    /// What it holds, counted.
    fn gauges(&self) -> Option<Gauges> {
        None
    }

    /// The type every handle it draws begins with (spec 15.1), which tells its connections from
    /// another type's: `MEMORY`, `BROKER`; none for one whose handles are of several types, a join's,
    /// which no join takes.
    fn transport_type(&self) -> Option<&str> {
        None
    }
}

/// What hears a transport client's events.
pub trait ClientListener: Send + Sync {
    /// A message from its server.
    fn on_message(&self, _message: TransportMessage) {}

    /// Its connection closed: `was_clean` when by its own word, `is_quick` when without a wait.
    fn on_close(&self, _was_clean: bool, _is_quick: bool) {}

    /// A reconnection began.
    fn on_reconnect(&self) {}

    /// What went wrong, or what a listener threw.
    fn on_error(&self, _error: &RouterError) {}
}

/// A transport client, as a router reaches it.
pub trait RouterClientTransport: Send + Sync + fmt::Debug {
    /// Hands an envelope's bytes over, with the credential it carries beside it.
    ///
    /// # Errors
    ///
    /// What refuses it before it is handed over: a connection not open, say.
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError>;

    /// Hears its events from now on.
    fn listen(&self, listener: Arc<dyn ClientListener>);

    /// Hears its events no more.
    fn unlisten(&self, listener: &Arc<dyn ClientListener>);

    /// Pauses it whole, its router behind (spec 15.12, decision 0046): it hands nothing more, and
    /// holds what it already received, whole or still arriving, in order, until it is resumed;
    /// while it holds anything, what comes next waits behind it, paused or not. What it holds of a
    /// connection is dropped with that connection; a pause outlasts it, until a resume. A transport
    /// whose peer is its application's own code holds without bound, and says so.
    ///
    /// Idempotent, it never blocks and tells no listener within it. Its router calls it under the
    /// lock of its counts, from a reader's thread or its own turn, so it takes no lock that this
    /// transport holds while it tells a listener.
    fn pause(&self);

    /// Resumes it: what it holds it hands on, in order, from a later step of its own, never within
    /// this call, asking before each hand whether it was paused again. As
    /// [`RouterClientTransport::pause`], idempotent, never blocking, telling no listener within it, and
    /// taking no lock this transport holds while it tells one.
    fn resume(&self);

    /// The clock it runs on.
    fn clock(&self) -> Option<SharedClock> {
        None
    }

    /// Whether it stays off the machine's clear.
    fn is_secure(&self) -> bool {
        false
    }

    /// Whether it carries `credential` beside an envelope.
    fn carries(&self, _credential: &str) -> bool {
        false
    }

    /// Whether it is open.
    fn is_open(&self) -> bool {
        self.ready_state() == ReadyState::Open
    }

    /// Where it stands.
    fn ready_state(&self) -> ReadyState;
}

/// How a transport client's connection closes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct TransportClientDisconnectOptions {
    /// Whether by its own word: `true` when none.
    pub is_clean: Option<bool>,
    /// Whether without a wait: `false` when none.
    pub is_quick: Option<bool>,
}

/// What gives the delay before an attempt of a reconnection, from the delay before it, none before
/// the first, and the attempt's number, from 1.
pub type TransportClientReconnectDelayResolver =
    Arc<dyn Fn(Option<Duration>, u32) -> Duration + Send + Sync>;

/// The delay between two attempts of a reconnection: one for all, or one its resolver gives each
/// attempt.
#[derive(Clone)]
#[non_exhaustive]
pub enum TransportClientReconnectDelay {
    /// The same delay each time.
    Fixed(Duration),
    /// A delay its resolver gives each attempt.
    Resolver(TransportClientReconnectDelayResolver),
}

impl fmt::Debug for TransportClientReconnectDelay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fixed(delay) => formatter.debug_tuple("Fixed").field(delay).finish(),
            Self::Resolver(_) => formatter.write_str("Resolver"),
        }
    }
}

/// How long a connect waits for its server when it names no timeout.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The delay between two attempts when none is given.
pub const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// The attempts a transport client's reconnection makes when none is given; a broker participant's
/// goes without end.
pub const RECONNECT_ATTEMPTS: u32 = 5;

/// How a transport client reconnects, or a broker participant's link.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct TransportClientReconnectOptions {
    /// The delay between two attempts: [`RECONNECT_DELAY`] when none. A fixed one out of bounds is
    /// refused where it is given (spec 1.4); a resolver's answer is held at each attempt. One of 0
    /// arms no timer, its next attempt in a later turn of its tokio runtime.
    pub delay: Option<TransportClientReconnectDelay>,
    /// The attempts it makes at most: its owner's default when none, [`RECONNECT_ATTEMPTS`] for a
    /// transport client's reconnection, without end for a broker participant's.
    pub maximum_attempts: Option<u32>,
    /// What cancels it, read before each attempt and during each wait: a transport client's attempt
    /// under way is handed it, a broker participant's is not cut short.
    pub signal: Option<CancellationToken>,
    /// Hears each delay as it is armed, and the attempt it follows.
    pub tap: Option<Arc<dyn Fn(Duration, u32) + Send + Sync>>,
}

impl fmt::Debug for TransportClientReconnectOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransportClientReconnectOptions")
            .field("delay", &self.delay)
            .field("maximum_attempts", &self.maximum_attempts)
            .finish_non_exhaustive()
    }
}

/// Whether `value` is a field's value, and so a credential a transport carries (RFC 9110 §5.5):
/// visible ASCII, spaces and tabs alone, none first or last.
#[must_use]
pub fn is_field_value(value: &str) -> bool {
    let bytes = value.as_bytes();
    let is_visible = |byte: &u8| (b'!'..=b'~').contains(byte);

    match (bytes.first(), bytes.last()) {
        (None, _) | (_, None) => true,
        (Some(first), Some(last)) => {
            is_visible(first)
                && is_visible(last)
                && bytes
                    .iter()
                    .all(|byte| *byte == b'\t' || (b' '..=b'~').contains(byte))
        }
    }
}

/// What a listener's registration gives: the id its part's `off` takes it off again by, as the
/// other sides' `off` and `-=` take a listener off. Dropped, the listener stays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ListenerId(u64);

// each registration's own id, never given twice in a process
static LISTENER_IDS: AtomicU64 = AtomicU64::new(1);

/// The listeners of one event, each under the id its registration gave, called in the order they
/// came.
pub(crate) struct Listened<T> {
    listeners: Mutex<Vec<(ListenerId, T)>>,
}

impl<T> Default for Listened<T> {
    fn default() -> Self {
        Self {
            listeners: Mutex::new(Vec::new()),
        }
    }
}

impl<T> fmt::Debug for Listened<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Listened").finish_non_exhaustive()
    }
}

impl<T: Clone> Listened<T> {
    /// Whether nobody listens, without copying the listener list.
    pub(crate) fn is_empty(&self) -> bool {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    /// Hears from now on, under the id it gives.
    pub(crate) fn add(&self, listener: T) -> ListenerId {
        let id = ListenerId(LISTENER_IDS.fetch_add(1, Ordering::Relaxed));

        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((id, listener));

        id
    }

    /// Takes off the listener `id` names, if it listens here.
    pub(crate) fn off(&self, id: ListenerId) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(held, _)| *held != id);
    }

    /// Each listener, in the order they came: a copy, so one added or taken off meanwhile changes
    /// the next telling, not this one.
    pub(crate) fn all(&self) -> Vec<T> {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect()
    }
}

/// The listeners of one end, each called within a guard (spec 15.1).
pub(crate) type Listeners<L> = Listened<Arc<L>>;

impl<L: ?Sized> Listened<Arc<L>> {
    /// Takes `listener` off, as the one given: a transport's `unlisten`.
    pub(crate) fn remove(&self, listener: &Arc<L>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(_, held)| !Arc::ptr_eq(held, listener));
    }

    /// Calls each listener within a guard: what one panics is given to `on_error`, and the
    /// listeners after it are called all the same.
    pub(crate) fn each<C: Fn(&L), E: Fn(RouterError)>(&self, (call, on_error): (C, E)) {
        for listener in self.all() {
            if let Err(panicked) = catch_unwind(AssertUnwindSafe(|| call(&listener))) {
                on_error(panic_error(&*panicked));
            }
        }
    }
}

/// What the application's code panicked with, as an error a side reports: what panicked, and its
/// message.
#[derive(Debug, Clone)]
pub(crate) struct Panicked {
    what: &'static str,
    message: String,
}

impl Panicked {
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Panicked {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} panicked: {}", self.what, self.message)
    }
}

impl std::error::Error for Panicked {}

impl From<Panicked> for RouterError {
    fn from(panicked: Panicked) -> Self {
        Self::Other(Arc::new(panicked))
    }
}

/// The error a listener's panic stands for, as its throw is reported.
pub(crate) fn panic_error(panicked: &(dyn core::any::Any + Send)) -> RouterError {
    RouterError::Other(Arc::new(panicked_of(("a listener", panicked))))
}

/// Calls `call`, the application's code a side runs within its turn, within a guard: what it panics
/// is its throw, the error it stands for (decision 0044), named by `what`, `a transport` say.
pub(crate) fn caught<T, C: FnOnce() -> T>((what, call): (&'static str, C)) -> Result<T, Panicked> {
    catch_unwind(AssertUnwindSafe(call)).map_err(|panicked| panicked_of((what, &*panicked)))
}

/// What a future of the application's gives, or what it panicked with as it was polled: its
/// throw, named by `what`. Polled no more once it gave either.
pub(crate) struct Caught<F> {
    future: Pin<Box<F>>,
    what: &'static str,
}

impl<F> fmt::Debug for Caught<F> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Caught")
            .field("what", &self.what)
            .finish_non_exhaustive()
    }
}

impl<F: Future> Future for Caught<F> {
    type Output = Result<F::Output, Panicked>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let what = self.what;

        match catch_unwind(AssertUnwindSafe(|| self.future.as_mut().poll(context))) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(panicked) => Poll::Ready(Err(panicked_of((what, &*panicked)))),
        }
    }
}

/// `future`, its panic its throw, named by `what`.
pub(crate) fn caught_future<F: Future>((what, future): (&'static str, F)) -> Caught<F> {
    Caught {
        future: Box::pin(future),
        what,
    }
}

/// What `what` panicked with, as an error.
pub(crate) fn panicked_of(
    (what, panicked): (&'static str, &(dyn core::any::Any + Send)),
) -> Panicked {
    let message = panicked
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panicked.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic of no message".to_owned());

    Panicked { what, message }
}

// ── A connect, and a reconnection's attempts ─────────────────────────────────────────────────

/// What a reconnection that its signal cancelled says.
pub(crate) const RECONNECTION_CANCELLED: &str = "the reconnection was cancelled";

/// A connect's outcome, to wait for: it started when it was made.
#[must_use = "the connect started already; its future only waits for its outcome"]
#[derive(Debug)]
pub struct Connect {
    outcome: Option<oneshot::Receiver<Result<(), TransportError>>>,
    refused: Option<TransportError>,
}

impl Connect {
    /// A connect under way, whose outcome `outcome` gives.
    pub(crate) const fn of(outcome: oneshot::Receiver<Result<(), TransportError>>) -> Self {
        Self {
            outcome: Some(outcome),
            refused: None,
        }
    }

    /// A connect refused as it was made.
    pub(crate) const fn refused(error: TransportError) -> Self {
        Self {
            outcome: None,
            refused: Some(error),
        }
    }
}

impl Future for Connect {
    type Output = Result<(), TransportError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(refused) = self.refused.take() {
            return Poll::Ready(Err(refused));
        }

        let Some(outcome) = self.outcome.as_mut() else {
            return Poll::Ready(Err(TransportError::Connect(ConnectError::new(
                "the connect was polled after it settled",
            ))));
        };

        Pin::new(outcome).poll(context).map(|outcome| {
            outcome.unwrap_or_else(|_dropped| {
                Err(TransportError::Connect(ConnectError::new(
                    "the transport client was disposed as it connected",
                )))
            })
        })
    }
}

/// Holds the delay `options` gives, where it is given: a fixed one out of bounds is refused (spec
/// 1.4); a resolver's answer is held at each attempt.
///
/// # Errors
///
/// A [`ProgrammerError`] whose reason is a duration's refusal.
pub(crate) fn hold_reconnection(
    options: &TransportClientReconnectOptions,
) -> Result<(), ProgrammerError> {
    match &options.delay {
        Some(TransportClientReconnectDelay::Fixed(delay)) => {
            hold_delay("a delay", *delay).map(drop)
        }
        Some(TransportClientReconnectDelay::Resolver(_)) | None => Ok(()),
    }
}

/// Whether `first` settles before `second`.
pub(crate) async fn first_of<A: Future, B: Future>((first, second): (A, B)) -> bool {
    let mut first = core::pin::pin!(first);
    let mut second = core::pin::pin!(second);

    core::future::poll_fn(|context| {
        if first.as_mut().poll(context).is_ready() {
            return Poll::Ready(true);
        }

        if second.as_mut().poll(context).is_ready() {
            return Poll::Ready(false);
        }

        Poll::Pending
    })
    .await
}

/// A reconnection's attempts, on `clock`, as `options` says: the first at once, each next one after
/// its delay, at a delay of 0 in a later turn of its runtime, never within the one its last failed
/// in, each made by `attempt`, given the reconnection's signal, which is read before each. It
/// ends once one opened; with a [`TransportError::Reconnect`] once its attempts ran out; at once for
/// a misuse an attempt met, which the next would meet again, or a delay or a tap that panicked; and
/// cancelled once its signal is.
///
/// # Errors
///
/// As above.
pub(crate) async fn attempting<A, F>(
    (clock, options): (&SharedClock, &TransportClientReconnectOptions),
    mut attempt: A,
) -> Result<(), TransportError>
where
    A: FnMut(Option<CancellationToken>) -> F,
    F: Future<Output = Result<(), TransportError>>,
{
    let delay = options
        .delay
        .clone()
        .unwrap_or(TransportClientReconnectDelay::Fixed(RECONNECT_DELAY));
    let maximum_attempts = options.maximum_attempts.unwrap_or(RECONNECT_ATTEMPTS);
    let signal = options.signal.clone();
    let is_cancelled = || signal.as_ref().is_some_and(CancellationToken::is_cancelled);
    let mut previous: Option<Duration> = None;
    let mut number = 0_u32;

    loop {
        // * read before each attempt, the first included: an attempt under way is not cut short
        if is_cancelled() {
            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
        }

        number = number.saturating_add(1);

        match attempt(signal.clone()).await {
            Ok(()) => return Ok(()),
            Err(reason) => {
                if is_cancelled() {
                    return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
                }

                // a misuse an attempt met, the next would meet again
                if matches!(reason, TransportError::Refused(_)) {
                    return Err(reason);
                }

                if number >= maximum_attempts {
                    return Err(TransportError::Reconnect(ReconnectError::new(
                        maximum_attempts,
                        Some(Arc::new(reason)),
                    )));
                }
            }
        }

        let next = match &delay {
            TransportClientReconnectDelay::Fixed(delay) => *delay,
            TransportClientReconnectDelay::Resolver(delay_of) => {
                // * what it panicked with alone, as the other sides report what it throws
                caught(("a reconnection's delay", || delay_of(previous, number))).map_err(
                    |panicked| TransportError::Refused(ProgrammerError::new(panicked.message())),
                )?
            }
        };
        // held before tap hears it: 0 arms none, and never would wait for ever
        let next = hold_delay("a delay", next)?;
        // armed before tap is told, so whoever moves the clock once told moves it past the wait;
        // none at 0, which takes a turn of its runtime once told instead
        let armed = (!next.is_zero())
            .then(|| {
                let (woken, wait) = oneshot::channel::<()>();
                let mut woken = Some(woken);
                let timer = clock.arm(
                    Schedule::Once(next),
                    Box::new(move || {
                        if let Some(woken) = woken.take() {
                            woken.send(()).ok();
                        }
                    }),
                );

                timer.map(|timer| (timer, wait))
            })
            .transpose()?;

        if let Some(tap) = &options.tap
            && let Err(panicked) = caught(("a reconnection's tap", || tap(next, number)))
        {
            if let Some((timer, _wait)) = &armed {
                timer.cancel();
            }

            return Err(TransportError::Refused(ProgrammerError::new(
                panicked.message(),
            )));
        }

        previous = Some(next);

        // * at 0, a turn of its runtime between two attempts, never none: an attempt refused at once
        // would otherwise run the reconnection within one poll, broken by tokio's budget alone
        let Some((timer, wait)) = armed else {
            crate::platform::yield_now().await;

            continue;
        };
        let is_woken = match &signal {
            Some(signal) => !first_of((signal.cancelled(), wait)).await,
            None => wait.await.is_ok(),
        };

        if !is_woken {
            timer.cancel();

            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
        }
    }
}
