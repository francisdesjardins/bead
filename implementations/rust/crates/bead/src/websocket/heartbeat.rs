//! One WebSocket connection's heartbeat, as the other sides' `createHeartbeat` and the C# side's
//! keep-alive beat it: a ping every heartbeat, and a drop at the beat after a ping its peer left
//! unanswered, so a peer gone without a word — a network cut, a machine asleep — ends in a close
//! rather than never. It lives below the protocol, a WebSocket's own PING and PONG frames (RFC 6455
//! §5.5.2), which a page's browser answers by itself, and runs on the platform's clock, never the
//! clock a side is given, as a ping plays in real time on every side (decision 0011); without end,
//! it arms nothing.

use core::fmt;
use core::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::{NEVER, hold};
use crate::errors::ProgrammerError;

#[cfg(test)]
mod tests;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `heartbeat` held: a duration a timer holds, whole milliseconds, or [`NEVER`] for none; zero, or
/// past the longest timer, is a [`ProgrammerError`].
///
/// # Errors
///
/// As above, its reason a duration's refusal.
pub(crate) fn hold_heartbeat(heartbeat: Duration) -> Result<Duration, ProgrammerError> {
    hold("a heartbeat", heartbeat)
}

/// What a heartbeat does of its connection: ping it, and drop it once a ping went unanswered.
pub(crate) struct HeartbeatHooks {
    /// Pings the connection.
    pub(crate) ping: Box<dyn Fn() + Send + Sync>,
    /// Drops the connection: it left the ping before unanswered.
    pub(crate) drop: Box<dyn Fn() + Send + Sync>,
}

struct Inner {
    hooks: HeartbeatHooks,
    is_answered: AtomicBool,
    timer: Mutex<Option<Arc<dyn Timer>>>,
}

/// One connection's heartbeat, its timer armed on the platform's clock.
#[derive(Clone)]
pub(crate) struct Heartbeat {
    inner: Arc<Inner>,
}

impl fmt::Debug for Heartbeat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Heartbeat").finish_non_exhaustive()
    }
}

impl Heartbeat {
    /// A heartbeat of `heartbeat`, held already, beating on `clock`, the platform's: every
    /// `heartbeat`, it drops its connection when the ping before went unanswered, and pings it
    /// otherwise; nothing at all for [`NEVER`].
    pub(crate) fn new(hooks: HeartbeatHooks, (heartbeat, clock): (Duration, &SharedClock)) -> Self {
        let beating = Self {
            inner: Arc::new(Inner {
                hooks,
                is_answered: AtomicBool::new(true),
                timer: Mutex::new(None),
            }),
        };

        if heartbeat != NEVER {
            let weak = Arc::downgrade(&beating.inner);
            // a clock that arms no timer beats nothing
            let timer = clock
                .arm(
                    Schedule::Every(heartbeat),
                    Box::new(move || {
                        if let Some(inner) = weak.upgrade() {
                            Self { inner }.beat();
                        }
                    }),
                )
                .ok();

            *locked(&beating.inner.timer) = timer;
        }

        beating
    }

    /// Its peer answered a ping: the connection is alive.
    pub(crate) fn answer(&self) {
        self.inner.is_answered.store(true, Ordering::SeqCst);
    }

    /// It beats no more: its connection ended.
    pub(crate) fn stop(&self) {
        let timer = locked(&self.inner.timer).take();

        if let Some(timer) = timer {
            timer.cancel();
        }
    }

    fn beat(&self) {
        if !self.inner.is_answered.swap(false, Ordering::SeqCst) {
            self.stop();
            (self.inner.hooks.drop)();

            return;
        }

        (self.inner.hooks.ping)();
    }
}
