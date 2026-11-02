//! A clock that runs one callback within its next wall reading, before giving the instant.

use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::testing::Activity;

/// A clock whose next wall reading can settle work while its reader is still on the stack.
pub struct ReadingClock {
    clock: SharedClock,
    on_read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl core::fmt::Debug for ReadingClock {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ReadingClock")
            .field("clock", &self.clock)
            .finish_non_exhaustive()
    }
}

impl ReadingClock {
    /// A wrapper of `clock`: its readings, timers and activity, with no callback armed.
    #[must_use]
    pub fn new(clock: SharedClock) -> Arc<Self> {
        Arc::new(Self {
            clock,
            on_read: Mutex::new(None),
        })
    }

    /// Runs `callback` once, within the next wall reading; a second replaces the first.
    pub fn on_wall_read<F: FnOnce() + Send + 'static>(&self, callback: F) {
        *self.on_read.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(callback));
    }

    /// Whether the next wall reading still has a callback to run.
    #[must_use]
    pub fn is_armed(&self) -> bool {
        self.on_read
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

impl Clock for ReadingClock {
    fn description(&self) -> &'static str {
        self.clock.description()
    }
    fn monotonic(&self) -> Duration {
        self.clock.monotonic()
    }
    fn wall(&self) -> SystemTime {
        let callback = self
            .on_read
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(callback) = callback {
            callback();
        }
        self.clock.wall()
    }
    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        self.clock.arm(schedule, callback)
    }
    fn activity(&self) -> Option<Arc<Activity>> {
        self.clock.activity()
    }
}
