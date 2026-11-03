//! Count a manager's reads apart from its router's deadlines, on the same underlying clock.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use super::super::{ServiceManager, ServiceManagerOptions};
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};

#[derive(Debug)]
pub(crate) struct ReadClock {
    clock: SharedClock,
    walls: AtomicUsize,
    monotonics: AtomicUsize,
}

impl ReadClock {
    pub(crate) fn readings(&self) -> (usize, usize) {
        (
            self.walls.load(Ordering::SeqCst),
            self.monotonics.load(Ordering::SeqCst),
        )
    }
}

impl Clock for ReadClock {
    fn monotonic(&self) -> Duration {
        self.monotonics.fetch_add(1, Ordering::SeqCst);
        self.clock.monotonic()
    }

    fn wall(&self) -> SystemTime {
        self.walls.fetch_add(1, Ordering::SeqCst);
        self.clock.wall()
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        self.clock.arm(schedule, callback)
    }
}

pub(crate) fn clocked(manager: &ServiceManager) -> (ServiceManager, Arc<ReadClock>) {
    let mut manager = ServiceManager::new(
        manager.inner.router.clone(),
        &ServiceManagerOptions::default(),
    )
    .expect("the manager's router");
    let counted = Arc::new(ReadClock {
        clock: Arc::clone(&manager.inner.clock),
        walls: AtomicUsize::new(0),
        monotonics: AtomicUsize::new(0),
    });

    Arc::get_mut(&mut manager.inner)
        .expect("the manager is unshared")
        .clock = Arc::<ReadClock>::clone(&counted);

    (manager, counted)
}
