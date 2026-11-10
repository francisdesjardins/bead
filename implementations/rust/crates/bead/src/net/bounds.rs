//! What every server's transport over a socket bounds alike (spec 15.12), as the other sides'
//! `server-bounds.ts` and `ServerBounds.cs` bound it: its defaults, the counts it is given, held as
//! it is built, and the pace it holds what waits for a socket to.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::clock::{Schedule, SharedClock, Timer};
use crate::errors::ProgrammerError;
use crate::router::types::RouterError;

#[cfg(test)]
mod tests;

/// The slowest, by default, a socket may take what waits for it once its grace passed: 240 bytes a
/// second, Kestrel's `MinResponseDataRate` (spec 15.12).
pub const MINIMUM_SEND_BYTES_PER_SECOND: u64 = 240;

/// The least time, by default, an envelope is given to be taken by its socket: 5 seconds.
pub const SEND_GRACE_PERIOD: Duration = Duration::from_secs(5);

/// How long, by default, a request's head may take to come whole: 30 seconds (spec 15.12).
pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a socket closed in stages reads on and drops what still comes once its answer is
/// written, unless its client closes first: 2 seconds, as Apache httpd lingers (RFC 9112 §9.6).
pub(crate) const LINGER: Duration = Duration::from_secs(2);

/// How often what waits for a socket is judged against its deadline.
pub(crate) const CHECK: Duration = Duration::from_secs(1);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `value` held as a count of the option `name`: a whole number above 0.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the option for 0.
pub(crate) fn hold_count(name: &str, value: u64) -> Result<u64, ProgrammerError> {
    if value == 0 {
        return Err(ProgrammerError::new(format!(
            "{name} is a whole number above 0, not 0"
        )));
    }

    Ok(value)
}

/// A connection dropped behind a bound, as its server reports it on `error` (spec 15.1, 15.12):
/// its handle, then `why`, which names the bound in the spec's spelling and its value.
pub(crate) fn dropped_of(connection_handle: &str, why: &str) -> RouterError {
    RouterError::Other(Arc::new(std::io::Error::other(format!(
        "{connection_handle} is dropped: {why}"
    ))))
}

/// What a socket's pace is held to: the slowest it may take what waits, past a grace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SendPaceOptions {
    /// The slowest, in bytes a second, a socket may take what waits for it; 0 holds none.
    pub(crate) minimum_send_bytes_per_second: u64,
    /// The least time an envelope is given to be taken.
    pub(crate) send_grace_period: Duration,
}

/// Why a connection whose socket held what waits for it past its deadline is dropped, naming the
/// pace's bounds in the spec's spelling and their values (spec 15.12).
pub(crate) fn late_of(pace: &SendPaceOptions) -> String {
    format!(
        "what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond {} past sendGracePeriod {} ms",
        pace.minimum_send_bytes_per_second,
        pace.send_grace_period.as_millis()
    )
}

/// What a pace hears of its socket: what waits for it, and that what waits is late.
pub(crate) struct SendPaceHooks {
    /// What waits for the socket right now, in bytes.
    pub(crate) unsent: Box<dyn Fn() -> u64 + Send + Sync>,
    /// What waits passed its deadline: told once.
    pub(crate) late: Box<dyn Fn() + Send + Sync>,
}

struct PaceState {
    deadline: Option<Duration>,
    timer: Option<Arc<dyn Timer>>,
}

struct PaceInner {
    hooks: SendPaceHooks,
    options: SendPaceOptions,
    clock: SharedClock,
    state: Mutex<PaceState>,
}

/// Holds what waits for one socket to a pace, as Kestrel holds a response to its
/// `MinResponseDataRate` (spec 15.12): each envelope of _S_ bytes handed moves the deadline to the
/// later of now plus the longer of the grace and _S_ at the rate, and the deadline before plus that
/// time. While what it is told waits is more than none, it is judged each second, and it hears,
/// once, that what waits is past its deadline; nothing waiting, no deadline runs. A rate of 0 holds
/// none. Its clock is the platform's, whatever clock the server is given, since it bounds what the
/// platform's socket does, as the heartbeat does (decision 0011).
#[derive(Clone)]
pub(crate) struct SendPace {
    inner: Arc<PaceInner>,
}

impl fmt::Debug for SendPace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SendPace")
            .field("options", &self.inner.options)
            .finish_non_exhaustive()
    }
}

impl SendPace {
    /// A pace held to `options` on `clock`, telling `hooks`.
    pub(crate) fn new(
        hooks: SendPaceHooks,
        (options, clock): (SendPaceOptions, SharedClock),
    ) -> Self {
        Self {
            inner: Arc::new(PaceInner {
                hooks,
                options,
                clock,
                state: Mutex::new(PaceState {
                    deadline: None,
                    timer: None,
                }),
            }),
        }
    }

    /// An envelope of `bytes` handed to the socket: its deadline moved, its check armed.
    pub(crate) fn hand(&self, bytes: u64) {
        let inner = &self.inner;
        let rate = inner.options.minimum_send_bytes_per_second;

        if rate == 0 {
            return;
        }

        // its bytes at its rate, to the millisecond
        let takes =
            Duration::from_millis(bytes.saturating_mul(1_000).checked_div(rate).unwrap_or(0));
        let now = inner.clock.monotonic();
        let earliest = now.saturating_add(takes.max(inner.options.send_grace_period));
        let mut state = locked(&inner.state);

        state.deadline = Some(state.deadline.map_or(earliest, |before| {
            earliest.max(before.saturating_add(takes))
        }));

        if state.timer.is_none() {
            let weak = Arc::downgrade(inner);
            let armed = inner.clock.arm(
                Schedule::Every(CHECK),
                Box::new(move || {
                    if let Some(inner) = weak.upgrade() {
                        Self { inner }.judge();
                    }
                }),
            );

            // a clock that arms no timer holds no pace: nothing it could judge by
            state.timer = armed.ok();
        }
    }

    /// Whether it still judges what waits.
    #[cfg(feature = "http")]
    pub(crate) fn is_running(&self) -> bool {
        locked(&self.inner.state).timer.is_some()
    }

    /// Nothing more is judged: the socket is gone, or done.
    pub(crate) fn stop(&self) {
        let timer = {
            let mut state = locked(&self.inner.state);

            state.deadline = None;
            state.timer.take()
        };

        if let Some(timer) = timer {
            timer.cancel();
        }
    }

    // each second while it runs: nothing waiting, it stops; what waits past its deadline is late
    fn judge(&self) {
        let inner = &self.inner;

        if (inner.hooks.unsent)() == 0 {
            self.stop();

            return;
        }

        let is_late = locked(&inner.state)
            .deadline
            .is_some_and(|deadline| inner.clock.monotonic() > deadline);

        if is_late {
            self.stop();
            (inner.hooks.late)();
        }
    }
}
