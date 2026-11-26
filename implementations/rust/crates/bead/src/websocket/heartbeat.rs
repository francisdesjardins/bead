//! One WebSocket connection's heartbeat, as the TypeScript side's `createHeartbeat` beats it: a ping
//! once nothing of the connection has been read for its heartbeat, a part of a frame as its socket
//! reads it, a control frame and an unsolicited pong each counting; and a drop once the pong that
//! echoes that ping's data has not come within a heartbeat of the ping, no other frame answering it
//! and no other ping going before (spec 15.3, RFC 6455 §5.5.3). So a peer gone without a word — a
//! network cut, a machine asleep — is dropped rather than kept for ever. Each ping carries 8 bytes
//! of its own, a count from 1, big-endian, as .NET's keep-alive writes its own. It lives below the
//! protocol, a WebSocket's own PING and PONG frames (RFC 6455 §5.5.2), which a page's browser
//! answers by itself, and runs on its stack's platform clock, never the clock a side is given
//! (decision 0011), which a test replaces through its transport's `on_platform`; without end, it
//! arms nothing.

use core::fmt;
use core::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::{LONGEST_TIMER, NEVER, hold};
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

/// When a connection's socket was last read, on the platform's clock: what its heartbeat counts its
/// silence from.
pub(crate) struct Reads {
    clock: SharedClock,
    // the clock's monotonic reading at the last read, in nanoseconds
    last: AtomicU64,
}

impl fmt::Debug for Reads {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Reads").finish_non_exhaustive()
    }
}

fn nanoseconds_of(reading: Duration) -> u64 {
    u64::try_from(reading.as_nanos()).unwrap_or(u64::MAX)
}

impl Reads {
    /// The reads of a connection on `clock`, the platform's: its silence starts now.
    pub(crate) fn new(clock: SharedClock) -> Arc<Self> {
        let last = AtomicU64::new(nanoseconds_of(clock.monotonic()));

        Arc::new(Self { clock, last })
    }

    /// Something of the connection was read: its silence starts again.
    pub(crate) fn stamp(&self) {
        self.last
            .store(nanoseconds_of(self.clock.monotonic()), Ordering::SeqCst);
    }

    fn last(&self) -> Duration {
        Duration::from_nanos(self.last.load(Ordering::SeqCst))
    }
}

/// What a heartbeat does of its connection: ping it, and drop it once a ping's echo did not come.
pub(crate) struct HeartbeatHooks {
    /// Pings the connection with its data, ahead of what the connection holds unsent.
    pub(crate) ping: Box<dyn Fn(Bytes) + Send + Sync>,
    /// Drops the connection: the echo of its ping did not come within a heartbeat.
    pub(crate) drop: Box<dyn Fn() + Send + Sync>,
}

struct BeatState {
    // the ping out: when it went, and its data
    pinged: Option<(Duration, [u8; 8])>,
    count: u64,
    is_stopped: bool,
    timer: Option<Arc<dyn Timer>>,
}

struct Inner {
    heartbeat: Duration,
    reads: Arc<Reads>,
    hooks: HeartbeatHooks,
    state: Mutex<BeatState>,
}

/// One connection's heartbeat, its timer armed on the platform's clock.
#[derive(Clone)]
pub(crate) struct Heartbeat {
    inner: Arc<Inner>,
}

impl fmt::Debug for Heartbeat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Heartbeat")
            .field("heartbeat", &self.inner.heartbeat)
            .finish_non_exhaustive()
    }
}

impl Heartbeat {
    /// A heartbeat of `heartbeat`, held already, counting its silence from `reads`, on their clock:
    /// its timer armed; none for [`NEVER`].
    pub(crate) fn new(hooks: HeartbeatHooks, (heartbeat, reads): (Duration, &Arc<Reads>)) -> Self {
        let inner = Arc::new(Inner {
            heartbeat,
            reads: Arc::clone(reads),
            hooks,
            state: Mutex::new(BeatState {
                pinged: None,
                count: 0,
                is_stopped: heartbeat == NEVER,
                timer: None,
            }),
        });

        if heartbeat != NEVER {
            // a clock that arms no timer beats nothing
            let timer = arm((&inner, heartbeat)).ok();

            locked(&inner.state).timer = timer;
        }

        Self { inner }
    }

    /// A pong came: it answers the ping out when it echoes that ping's data, and nothing otherwise.
    pub(crate) fn answer(&self, data: &[u8]) {
        let mut state = locked(&self.inner.state);

        if state
            .pinged
            .is_some_and(|(_, pinged)| pinged.as_slice() == data)
        {
            state.pinged = None;
        }
    }

    /// Whether no ping of its waits for its echo: none went, or the last one's came.
    #[cfg(test)]
    pub(crate) fn is_answered(&self) -> bool {
        locked(&self.inner.state).pinged.is_none()
    }

    /// It beats no more: its connection ended.
    pub(crate) fn stop(&self) {
        let timer = {
            let mut state = locked(&self.inner.state);

            state.is_stopped = true;
            state.timer.take()
        };

        if let Some(timer) = timer {
            timer.cancel();
        }
    }
}

// its timer, armed for `due`, a millisecond at least
fn arm((inner, due): (&Arc<Inner>, Duration)) -> Result<Arc<dyn Timer>, ProgrammerError> {
    let beating: Weak<Inner> = Arc::downgrade(inner);

    inner.reads.clock.arm(
        Schedule::Once(due.clamp(Duration::from_millis(1), LONGEST_TIMER)),
        Box::new(move || {
            if let Some(inner) = beating.upgrade() {
                beat(&inner);
            }
        }),
    )
}

// what a beat does: a drop, or a ping and its data
enum Act {
    Drop,
    Ping(Bytes),
}

// its timer's: a ping out waits a heartbeat for its echo, then drops its connection; none out, the
// connection is pinged once silent for a heartbeat; either armed again for what is left
fn beat(inner: &Arc<Inner>) {
    let act = {
        let mut state = locked(&inner.state);

        if state.is_stopped {
            return;
        }

        let now = inner.reads.clock.monotonic();
        let (act, next) = match state.pinged {
            Some((at, _)) if now.saturating_sub(at) >= inner.heartbeat => {
                state.is_stopped = true;

                (Some(Act::Drop), None)
            }
            Some((at, _)) => (
                None,
                Some(inner.heartbeat.saturating_sub(now.saturating_sub(at))),
            ),
            None => {
                let silent = now.saturating_sub(inner.reads.last());

                if silent >= inner.heartbeat {
                    state.count = state.count.saturating_add(1);

                    let data = state.count.to_be_bytes();

                    state.pinged = Some((now, data));

                    (
                        Some(Act::Ping(Bytes::copy_from_slice(&data))),
                        Some(inner.heartbeat),
                    )
                } else {
                    (None, Some(inner.heartbeat.saturating_sub(silent)))
                }
            }
        };

        // * armed before it acts, so a hook that stops it finds the timer to cancel
        if let Ok(timer) = next.map(|next| arm((inner, next))).transpose() {
            state.timer = timer;
            drop(state);
            act
        } else {
            state.is_stopped = true;
            drop(state);
            Some(Act::Drop)
        }
    };

    match act {
        Some(Act::Drop) => (inner.hooks.drop)(),
        Some(Act::Ping(data)) => (inner.hooks.ping)(data),
        None => {}
    }
}
