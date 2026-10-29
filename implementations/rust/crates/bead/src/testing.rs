//! The test kit (decision 0044): what the unit tests and the conformance players reach that the
//! API does not — the stepping clock, the activity it settles on, the files' typed readers, what a
//! test takes from its platform. No API: it is built under the feature `testing` alone, for the
//! tests.

use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicUsize, Ordering};
use core::task::{Context, Poll, Waker};
use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Wake;
use std::time::SystemTime;

use tokio::sync::Notify;

use crate::clock::{Clock, Schedule, Timer, TimerCallback};
use crate::duration::LONGEST_TIMER;

pub mod durations;
pub mod files;
pub mod hexadecimal;
pub mod instants;
pub mod pair;
pub mod parcels;
mod platform;
pub mod scripted;
pub mod validations;
pub mod vectors;

pub use platform::{Instant, patience, rest, spawn, wall_now};

/// What a side does on a test's clock: the jobs its owners hold queued or run, and the work they
/// cover while it can run. The side is settled once it is none.
#[derive(Debug, Default)]
pub struct Activity {
    count: AtomicUsize,
    notify: Notify,
}

impl Activity {
    /// One more piece of work, queued or able to run.
    pub fn begin(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }

    /// One piece of work done, or waiting.
    pub fn end(&self) {
        if self.count.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.notify.notify_waiters();
        }
    }

    /// How much work is under way.
    #[must_use]
    pub fn under_way(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// Done once the side did all it can without the clock moving.
    pub async fn settled(&self) {
        loop {
            let notified = self.notify.notified();
            let mut notified = core::pin::pin!(notified);

            notified.as_mut().enable();

            if self.count.load(Ordering::SeqCst) == 0 {
                // * a task woken by the last job may still run without posting: one turn more
                tokio::task::yield_now().await;

                if self.count.load(Ordering::SeqCst) == 0 {
                    return;
                }

                continue;
            }

            notified.await;
        }
    }
}

// whether a covered future can run, which its waker marks, counted on its activity meanwhile; and
// whether it is done, past which a wake counts nothing
#[derive(Default)]
struct Marks {
    is_scheduled: bool,
    is_done: bool,
    waker: Option<Waker>,
}

struct Scheduled {
    marks: Mutex<Marks>,
    activity: Arc<Activity>,
}

impl Scheduled {
    // marks it scheduled, counted, unless it is already or done
    fn schedule(&self) -> Option<Waker> {
        let mut marks = self.marks.lock().unwrap_or_else(PoisonError::into_inner);

        if marks.is_done {
            return None;
        }

        if !marks.is_scheduled {
            marks.is_scheduled = true;
            self.activity.begin();
        }

        let waker = marks.waker.clone();

        drop(marks);

        waker
    }

    // marks it waiting, or done, and counts it no more
    fn unschedule(&self, is_done: bool) {
        let mut marks = self.marks.lock().unwrap_or_else(PoisonError::into_inner);
        let was_scheduled = marks.is_scheduled;

        marks.is_done = marks.is_done || is_done;
        marks.is_scheduled = false;
        drop(marks);

        if was_scheduled {
            self.activity.end();
        }
    }
}

impl Wake for Scheduled {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if let Some(waker) = self.schedule() {
            waker.wake();
        }
    }
}

/// A future covered by an owner, counted on its activity from each wake until it waits again.
pub struct Tracked<F> {
    future: Pin<Box<F>>,
    scheduled: Arc<Scheduled>,
}

impl<F> core::fmt::Debug for Tracked<F> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("Tracked").finish_non_exhaustive()
    }
}

impl<F: Future> Tracked<F> {
    /// `future`, counted on `activity` until it first waits.
    pub fn new(future: F, activity: Arc<Activity>) -> Self {
        activity.begin();

        Self {
            future: Box::pin(future),
            scheduled: Arc::new(Scheduled {
                marks: Mutex::new(Marks {
                    is_scheduled: true,
                    is_done: false,
                    waker: None,
                }),
                activity,
            }),
        }
    }
}

impl<F> Drop for Tracked<F> {
    fn drop(&mut self) {
        self.scheduled.unschedule(true);
    }
}

impl<F: Future> Future for Tracked<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<F::Output> {
        let scheduled = Arc::clone(&self.scheduled);
        let was_scheduled = {
            let mut marks = scheduled
                .marks
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let was_scheduled = marks.is_scheduled;

            marks.waker = Some(context.waker().clone());
            marks.is_scheduled = false;

            was_scheduled
        };
        let waker = Waker::from(Arc::clone(&scheduled));
        // ! ended as the poll returns, or as it unwinds: a future that panics counts no more
        let _ending = Ending {
            activity: &scheduled.activity,
            is_armed: was_scheduled,
        };
        let polled = self.future.as_mut().poll(&mut Context::from_waker(&waker));

        if polled.is_ready() {
            scheduled.unschedule(true);
        }

        polled
    }
}

// what ends a poll's count on its activity, as it returns or unwinds
struct Ending<'activity> {
    activity: &'activity Activity,
    is_armed: bool,
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        if self.is_armed {
            self.activity.end();
        }
    }
}

// a timer armed on a stepping clock: its due on the clock's monotonic reading, its period, none for
// a timer that fires once
struct Stepped {
    number: usize,
    due: Duration,
    period: Option<Duration>,
    callback: Arc<Mutex<TimerCallback>>,
}

#[derive(Default)]
struct Readings {
    // how far the monotonic reading stands from the clock's making
    monotonic: Duration,
    // how far the wall reading stands from the monotonic one's
    wall: i128,
    // the timers live, in the order they were armed
    live: Vec<Stepped>,
    armed: usize,
    is_advancing: bool,
    walls_read: usize,
    monotonics_read: usize,
}

/// The clock the conformance files' players give the side under test (decision 0011).
///
/// As `tests/Shared/SteppingClock.cs` is the C# side's: an advance settles the side, takes the
/// earliest timer live due by its end, moves both readings to its due, fires it, settles, and so
/// on, then moves the readings to its end. Timers due at once fire in the order they were armed; a
/// periodic timer fires once for each period crossed, armed again as it is taken, before its
/// callback runs, last among those armed. A due is held in whole milliseconds, a fraction dropped.
/// The wall reading moves by a step of its own, alone, forward or back.
#[derive(Debug)]
pub struct SteppingClock {
    start: SystemTime,
    readings: Arc<Mutex<Readings>>,
    activity: Arc<Activity>,
}

impl core::fmt::Debug for Readings {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Readings")
            .field("monotonic", &self.monotonic)
            .field("live", &self.live.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct SteppedTimer {
    number: usize,
    readings: std::sync::Weak<Mutex<Readings>>,
}

impl Timer for SteppedTimer {
    fn cancel(&self) {
        if let Some(readings) = self.readings.upgrade() {
            readings
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .live
                .retain(|timer| timer.number != self.number);
        }
    }
}

// a time in whole milliseconds, a fraction dropped, as the system's timers read it
fn whole_of(time: Duration) -> Duration {
    Duration::from_millis(u64::try_from(time.as_millis()).unwrap_or(u64::MAX))
}

impl SteppingClock {
    /// A clock whose wall reading starts at `start`.
    #[must_use]
    pub fn new(start: SystemTime) -> Arc<Self> {
        Arc::new(Self {
            start,
            readings: Arc::new(Mutex::new(Readings::default())),
            activity: Arc::new(Activity::default()),
        })
    }

    /// What the side does on it.
    #[must_use]
    pub fn work(&self) -> Arc<Activity> {
        Arc::clone(&self.activity)
    }

    /// Done once the side did all it can without the clock moving.
    pub async fn settle(&self) {
        self.activity.settled().await;
    }

    /// How far each timer live is due from now, in the order they were armed.
    #[must_use]
    pub fn dues(&self) -> Vec<Duration> {
        let readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        readings
            .live
            .iter()
            .map(|timer| timer.due.saturating_sub(readings.monotonic))
            .collect()
    }

    /// How many readings the side took of it since it was made, of the wall clock and of the
    /// monotonic one, each apart.
    #[must_use]
    pub fn readings(&self) -> (usize, usize) {
        let readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        (readings.walls_read, readings.monotonics_read)
    }

    /// Moves the wall reading alone `by` milliseconds, forward or back: the monotonic one and the
    /// timers stay.
    pub fn wall_by(&self, by: i64) {
        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        readings.wall = readings
            .wall
            .saturating_add(i128::from(by).saturating_mul(1_000_000));
    }

    // the earliest timer live due by `end`, the first armed among those due at once, the readings
    // moved to its due, and taken off, or due a period later and last among those armed; none once
    // none is, the readings moved to the end
    fn next(&self, end: Duration) -> Option<Arc<Mutex<TimerCallback>>> {
        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);
        let mut next: Option<usize> = None;

        for (index, timer) in readings.live.iter().enumerate() {
            let is_earlier = next
                .and_then(|chosen| readings.live.get(chosen))
                .is_none_or(|chosen| timer.due < chosen.due);

            if timer.due <= end && is_earlier {
                next = Some(index);
            }
        }

        let Some(index) = next else {
            readings.monotonic = end;
            drop(readings);

            return None;
        };
        let mut timer = readings.live.remove(index);
        let callback = Arc::clone(&timer.callback);

        readings.monotonic = timer.due;

        if let Some(period) = timer.period {
            timer.due = timer.due.saturating_add(period);
            readings.live.push(timer);
        }

        drop(readings);

        Some(callback)
    }

    /// Steps both readings `by`, from due to due: each timer due within fires at its own, the side
    /// settled before it and after it. One advance at a time.
    ///
    /// # Panics
    ///
    /// For an advance within another, which would move the clock back.
    pub async fn advance(&self, by: Duration) {
        let end = {
            let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

            assert!(
                !readings.is_advancing,
                "a test clock advances once at a time: an advance within another would move it back"
            );
            readings.is_advancing = true;
            readings.monotonic.saturating_add(by)
        };

        self.settle().await;

        while let Some(callback) = self.next(end) {
            (callback.lock().unwrap_or_else(PoisonError::into_inner))();
            self.settle().await;
        }

        self.readings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_advancing = false;
    }
}

impl Clock for SteppingClock {
    fn monotonic(&self) -> Duration {
        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        readings.monotonics_read = readings.monotonics_read.saturating_add(1);

        let monotonic = readings.monotonic;

        drop(readings);

        monotonic
    }

    fn wall(&self) -> SystemTime {
        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        readings.walls_read = readings.walls_read.saturating_add(1);

        let at = i128::try_from(readings.monotonic.as_nanos())
            .unwrap_or(i128::MAX)
            .saturating_add(readings.wall);

        drop(readings);

        if at >= 0 {
            self.start
                .checked_add(Duration::from_nanos(u64::try_from(at).unwrap_or(u64::MAX)))
                .unwrap_or(self.start)
        } else {
            self.start
                .checked_sub(Duration::from_nanos(
                    u64::try_from(at.unsigned_abs()).unwrap_or(u64::MAX),
                ))
                .unwrap_or(self.start)
        }
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        let (due, period) = match schedule {
            Schedule::Once(due) => (due, None),
            Schedule::Every(period) => (period, Some(period)),
        };

        assert!(
            due >= Duration::from_millis(1) && due <= LONGEST_TIMER,
            "a test clock arms a timer for 1 to {} milliseconds, as Bead does, not {due:?}",
            LONGEST_TIMER.as_millis()
        );

        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);

        readings.armed = readings.armed.saturating_add(1);

        let number = readings.armed;
        let at = readings.monotonic.saturating_add(whole_of(due));

        readings.live.push(Stepped {
            number,
            due: at,
            period: period.map(whole_of),
            callback: Arc::new(Mutex::new(callback)),
        });
        drop(readings);

        Arc::new(SteppedTimer {
            number,
            readings: Arc::downgrade(&self.readings),
        })
    }

    fn activity(&self) -> Option<Arc<Activity>> {
        Some(Arc::clone(&self.activity))
    }
}
