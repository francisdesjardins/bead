//! What a router takes its envelopes from and hands them to (spec 15.1): a transport server's
//! connections, each under a handle it draws, and a transport client's one connection; the events
//! each tells, each listener called within a guard, so what one throws is reported and the transport
//! goes on as if it returned.

use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, PoisonError};

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
    /// A refusal of `status` and `reason` of the client at `address`, nothing else of it told.
    #[must_use]
    pub fn of<R: Into<String>>((status, reason): (u16, R), address: Option<String>) -> Self {
        Self {
            address,
            authority: None,
            origin: None,
            port: None,
            reason: reason.into(),
            status,
        }
    }
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
    fn start(&self) -> BoxFuture<Result<(), RouterError>>;

    /// Stops it, closing every connection.
    fn stop(&self) -> BoxFuture<()>;

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
pub trait ClientTransport: Send + Sync + fmt::Debug {
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct DisconnectOptions {
    /// Whether by its own word: `true` when none.
    pub is_clean: Option<bool>,
    /// Whether without a wait: `false` when none.
    pub is_quick: Option<bool>,
}

/// The delay between two attempts of a reconnection: one for all, or one each attempt gives,
/// from the delay before it and its number.
#[derive(Clone)]
#[non_exhaustive]
pub enum ReconnectDelay {
    /// The same delay each time.
    Fixed(Duration),
    /// A delay each attempt gives.
    Computed(Arc<dyn Fn(Option<Duration>, u32) -> Duration + Send + Sync>),
}

impl fmt::Debug for ReconnectDelay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fixed(delay) => formatter.debug_tuple("Fixed").field(delay).finish(),
            Self::Computed(_) => formatter.write_str("Computed"),
        }
    }
}

/// How long a connect waits for its server when it names no timeout.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The delay between two attempts when none is given.
pub const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// The attempts a reconnection makes when none is given.
pub const RECONNECT_ATTEMPTS: u32 = 5;

/// How a transport client reconnects.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ReconnectOptions {
    /// The delay between two attempts: [`RECONNECT_DELAY`] when none.
    pub delay: Option<ReconnectDelay>,
    /// The attempts it makes at most: [`RECONNECT_ATTEMPTS`] when none.
    pub maximum_attempts: Option<u32>,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// Hears each delay as it is armed, and the attempt it follows.
    pub tap: Option<Arc<dyn Fn(Duration, u32) + Send + Sync>>,
}

impl fmt::Debug for ReconnectOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReconnectOptions")
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

/// The listeners of one end, each called within a guard (spec 15.1).
pub(crate) struct Listeners<L: ?Sized> {
    listeners: Mutex<Vec<Arc<L>>>,
}

impl<L: ?Sized> Default for Listeners<L> {
    fn default() -> Self {
        Self {
            listeners: Mutex::new(Vec::new()),
        }
    }
}

impl<L: ?Sized> fmt::Debug for Listeners<L> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Listeners").finish_non_exhaustive()
    }
}

impl<L: ?Sized> Listeners<L> {
    /// Whether nobody listens, without copying the listener list.
    pub(crate) fn is_empty(&self) -> bool {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    pub(crate) fn add(&self, listener: Arc<L>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    pub(crate) fn remove(&self, listener: &Arc<L>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|held| !Arc::ptr_eq(held, listener));
    }

    pub(crate) fn all(&self) -> Vec<Arc<L>> {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
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

impl fmt::Display for Panicked {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} panicked: {}", self.what, self.message)
    }
}

impl std::error::Error for Panicked {}

/// The error a listener's panic stands for, as its throw is reported.
pub(crate) fn panic_error(panicked: &(dyn core::any::Any + Send)) -> RouterError {
    RouterError::Other(Arc::new(panicked_of(("a listener", panicked))))
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
/// its delay, each made by `attempt`, given the reconnection's signal. It ends once one opened; with
/// a [`TransportError::Reconnect`] once its attempts ran out; at once for a misuse an attempt met,
/// which the next would meet again; and cancelled once its signal is.
///
/// # Errors
///
/// As above.
pub(crate) async fn attempting<A, F>(
    (clock, options): (&SharedClock, &ReconnectOptions),
    mut attempt: A,
) -> Result<(), TransportError>
where
    A: FnMut(Option<CancellationToken>) -> F,
    F: Future<Output = Result<(), TransportError>>,
{
    let delay = options
        .delay
        .clone()
        .unwrap_or(ReconnectDelay::Fixed(RECONNECT_DELAY));
    let maximum_attempts = options.maximum_attempts.unwrap_or(RECONNECT_ATTEMPTS);
    let signal = options.signal.clone();
    let is_cancelled = || signal.as_ref().is_some_and(CancellationToken::is_cancelled);
    let mut previous: Option<Duration> = None;
    let mut number = 0_u32;

    loop {
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
            ReconnectDelay::Fixed(delay) => *delay,
            ReconnectDelay::Computed(delay_of) => {
                let computed = catch_unwind(AssertUnwindSafe(|| delay_of(previous, number)));

                computed.map_err(|_panicked| {
                    TransportError::Refused(ProgrammerError::new("a reconnection's delay panicked"))
                })?
            }
        };
        // held before tap hears it: 0 waits none, and never would wait for ever
        let next = hold_delay("a delay", next)?;
        // armed before tap is told, so whoever moves the clock once told moves it past the wait;
        // none armed for at once
        let (woken, wait) = oneshot::channel::<()>();
        let mut woken = Some(woken);
        let timer = if next.is_zero() {
            if let Some(woken) = woken.take() {
                woken.send(()).ok();
            }

            None
        } else {
            Some(clock.arm(
                Schedule::Once(next),
                Box::new(move || {
                    if let Some(woken) = woken.take() {
                        woken.send(()).ok();
                    }
                }),
            ))
        };
        let cancel_timer = || {
            if let Some(timer) = &timer {
                timer.cancel();
            }
        };

        if let Some(tap) = &options.tap {
            let tapped = catch_unwind(AssertUnwindSafe(|| tap(next, number)));

            if tapped.is_err() {
                cancel_timer();

                return Err(TransportError::Refused(ProgrammerError::new(
                    "a reconnection's tap panicked",
                )));
            }
        }

        previous = Some(next);

        let is_woken = match &signal {
            Some(signal) => !first_of((signal.cancelled(), wait)).await,
            None => wait.await.is_ok(),
        };

        if !is_woken {
            cancel_timer();

            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
        }
    }
}
