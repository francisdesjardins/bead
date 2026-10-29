//! What a test takes from its platform: a task spawned, a rest, a patience, a monotonic instant and
//! the wall clock's reading, natively tokio's and std's (decision 0044). A test names no platform's
//! spawn or time of its own, as clippy's `disallowed-methods` and `disallowed-types` hold it, so a
//! test reads the same wherever the core runs.
#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test kit's funnel: the one place a test reaches tokio's spawn and time and std's"
)]

use core::future::{Future, IntoFuture};
use core::time::Duration;
use std::time::SystemTime;

use tokio::task::JoinHandle;
use tokio::time::{Sleep, Timeout};

/// Spawns `future` on the current runtime, as `tokio::spawn` does.
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(future)
}

/// Rests `duration` on the platform's timers, as `tokio::time::sleep` does.
pub fn rest(duration: Duration) -> Sleep {
    tokio::time::sleep(duration)
}

/// Waits for `future` at most `duration`, as `tokio::time::timeout` does: its output, or
/// `Elapsed`.
pub fn patience<F: IntoFuture>(duration: Duration, future: F) -> Timeout<F::IntoFuture> {
    tokio::time::timeout(duration, future)
}

/// The wall clock's reading, as `SystemTime::now` gives it.
#[must_use]
pub fn wall_now() -> SystemTime {
    SystemTime::now()
}

/// A monotonic instant a test measures with: std's natively, the kit's own type, so that a test
/// names no platform's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Instant(std::time::Instant);

impl Instant {
    /// Now.
    #[must_use]
    pub fn now() -> Self {
        Self(std::time::Instant::now())
    }

    /// The time since it.
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }

    /// The time from `earlier` to it, none when `earlier` is later.
    #[must_use]
    pub fn duration_since(&self, earlier: Self) -> Duration {
        self.0.saturating_duration_since(earlier.0)
    }
}
