//! One connection's heartbeat over a broker (spec 15.21): it pings a connection once nothing of it
//! has come for its heartbeat, and drops it when nothing of it has come by a heartbeat after that
//! ping; anything heard of it answers, as TCP sends a keep-alive only when nothing came within its
//! interval (RFC 9293 §3.8.4). It runs on the platform's timer, never the clock a side is given, as
//! a WebSocket's ping does on every side (decision 0011); without end, it arms nothing.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::{LONGEST_TIMER, NEVER};

/// What a heartbeat does of a silent connection: ping it, and drop it once it answered nothing.
pub(crate) type Hook = Arc<dyn Fn() + Send + Sync>;

/// What a heartbeat does: ping a silent connection, and drop one that answered nothing.
#[derive(Clone)]
pub(crate) struct HeartbeatHooks {
    /// Pings the connection: nothing of it came for a heartbeat.
    pub(crate) ping: Hook,
    /// Drops the connection: nothing of it came for a heartbeat after its ping.
    pub(crate) drop: Hook,
}

struct BeatState {
    last_heard: Duration,
    pinged_at: Option<Duration>,
    is_stopped: bool,
    timer: Option<Arc<dyn Timer>>,
}

struct Inner {
    heartbeat: Duration,
    clock: SharedClock,
    hooks: HeartbeatHooks,
    state: Mutex<BeatState>,
}

/// One connection's heartbeat, its timer armed on the platform's clock.
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

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Heartbeat {
    /// A heartbeat of `heartbeat`, held already, on `clock`, the platform's: its timer armed; none
    /// for [`NEVER`].
    pub(crate) fn start(
        heartbeat: Duration,
        (clock, hooks): (SharedClock, HeartbeatHooks),
    ) -> Self {
        let inner = Arc::new(Inner {
            heartbeat,
            state: Mutex::new(BeatState {
                last_heard: clock.monotonic(),
                pinged_at: None,
                is_stopped: heartbeat == NEVER,
                timer: None,
            }),
            clock,
            hooks,
        });

        if heartbeat != NEVER {
            let timer = arm((&inner, heartbeat));

            locked(&inner.state).timer = Some(timer);
        }

        Self { inner }
    }

    /// Something of the connection came: it is alive, and its silence starts again.
    pub(crate) fn heard(&self) {
        let mut state = locked(&self.inner.state);

        state.last_heard = self.inner.clock.monotonic();
        state.pinged_at = None;
    }

    /// Nothing more is beaten: the connection ended.
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
fn arm((inner, due): (&Arc<Inner>, Duration)) -> Arc<dyn Timer> {
    let beating: Weak<Inner> = Arc::downgrade(inner);

    inner.clock.arm(
        Schedule::Once(due.clamp(Duration::from_millis(1), LONGEST_TIMER)),
        Box::new(move || {
            if let Some(inner) = beating.upgrade() {
                beat(&inner);
            }
        }),
    )
}

// its timer's: a ping once silent for a heartbeat, a drop once silent for one past its ping, else
// armed again for what is left of the silence it waits
fn beat(inner: &Arc<Inner>) {
    let act = {
        let mut state = locked(&inner.state);

        if state.is_stopped {
            return;
        }

        let now = inner.clock.monotonic();
        let silent = now.saturating_sub(state.last_heard);
        let (act, next) = match state.pinged_at {
            Some(pinged_at) if now.saturating_sub(pinged_at) >= inner.heartbeat => {
                state.is_stopped = true;

                (Some(Arc::clone(&inner.hooks.drop)), None)
            }
            Some(pinged_at) => (
                None,
                Some(
                    inner
                        .heartbeat
                        .saturating_sub(now.saturating_sub(pinged_at)),
                ),
            ),
            None if silent >= inner.heartbeat => {
                state.pinged_at = Some(now);

                (Some(Arc::clone(&inner.hooks.ping)), Some(inner.heartbeat))
            }
            None => (None, Some(inner.heartbeat.saturating_sub(silent))),
        };

        // * armed before it acts, so a hook that stops it finds the timer to cancel
        state.timer = next.map(|next| arm((inner, next)));

        act
    };

    if let Some(act) = act {
        act();
    }
}
