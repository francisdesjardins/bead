//! The clock a side takes its time from (decision 0011): its monotonic reading, which a deadline of
//! Bead's own is compared on; its wall clock's, which an instant a side reports is; and its timers.
//! A stack has one clock, set where it starts and read upward.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Instant, SystemTime};

use tokio::runtime::Handle;
use tokio::task::AbortHandle;

use crate::errors::ProgrammerError;

/// When a timer fires: once, after its due, or every period, its first after one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Schedule {
    /// Once, after this long.
    Once(Duration),
    /// Every this long, the first after one.
    Every(Duration),
}

/// What a timer calls each time it fires.
pub type TimerCallback = Box<dyn FnMut() + Send>;

/// A timer armed on a clock, which only it cancels.
pub trait Timer: Send + Sync + fmt::Debug {
    /// Cancels it: it fires no more.
    fn cancel(&self);
}

/// What Bead takes its time from: the platform's, [`SystemClock`], or a test's.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Its monotonic reading, since an origin of its own: what a deadline of Bead's own is
    /// compared on.
    fn monotonic(&self) -> Duration;

    /// Its wall clock's reading: what an instant a side reports is.
    fn wall(&self) -> SystemTime;

    /// Arms a timer that calls `callback` as `schedule` says.
    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer>;

    /// What the side does on it, which a test's clock settles on: none for any other.
    #[cfg(any(test, feature = "testing"))]
    #[doc(hidden)]
    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        None
    }
}

/// A clock as a stack shares it.
pub type SharedClock = Arc<dyn Clock>;

/// The platform's clock, on tokio's timers and the system's wall clock.
#[derive(Debug, Clone)]
pub struct SystemClock {
    handle: Handle,
    origin: Instant,
}

impl SystemClock {
    /// The platform's clock, on the runtime `handle`.
    #[must_use]
    pub fn new(handle: Handle) -> Self {
        Self {
            handle,
            origin: Instant::now(),
        }
    }

    /// The platform's clock, on the current runtime.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime.
    pub fn current() -> Result<Self, ProgrammerError> {
        Handle::try_current().map(Self::new).map_err(|_none| {
            ProgrammerError::new("a clock is built within a tokio runtime, or given its handle")
        })
    }
}

/// A timer of [`SystemClock`]'s, a task of its runtime.
#[derive(Debug)]
struct SystemTimer {
    task: Mutex<Option<AbortHandle>>,
}

impl Timer for SystemTimer {
    fn cancel(&self) {
        let task = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();

        if let Some(task) = task {
            task.abort();
        }
    }
}

impl Clock for SystemClock {
    fn monotonic(&self) -> Duration {
        self.origin.elapsed()
    }

    fn wall(&self) -> SystemTime {
        SystemTime::now()
    }

    fn arm(&self, schedule: Schedule, mut callback: TimerCallback) -> Arc<dyn Timer> {
        let task = match schedule {
            Schedule::Once(due) => self.handle.spawn(async move {
                tokio::time::sleep(due).await;
                callback();
            }),
            Schedule::Every(period) => self.handle.spawn(async move {
                let start = tokio::time::Instant::now()
                    .checked_add(period)
                    .unwrap_or_else(tokio::time::Instant::now);
                let mut interval = tokio::time::interval_at(start, period);

                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

                loop {
                    interval.tick().await;
                    callback();
                }
            }),
        };

        Arc::new(SystemTimer {
            task: Mutex::new(Some(task.abort_handle())),
        })
    }
}

/// The clock of a layer built on another: the one beneath it, unless it was given one — the one
/// given when there is none beneath.
///
/// # Errors
///
/// A [`ProgrammerError`] naming both when one given differs from the one beneath: `a server runs
/// on the clock of its transport, and was given another`.
pub fn clock_of(
    (beneath, given): (Option<&SharedClock>, Option<&SharedClock>),
    (layer, below): (&str, &str),
) -> Result<Option<SharedClock>, ProgrammerError> {
    match (beneath, given) {
        (Some(beneath), Some(given)) if !Arc::ptr_eq(beneath, given) => Err(ProgrammerError::new(
            format!("{layer} runs on the clock of {below}, and was given another"),
        )),
        (Some(clock), _) | (None, Some(clock)) => Ok(Some(Arc::clone(clock))),
        (None, None) => Ok(None),
    }
}
