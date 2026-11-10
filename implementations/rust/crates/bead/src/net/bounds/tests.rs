use core::fmt;
use core::time::Duration;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::*;
use crate::clock::{Clock, TimerCallback};

type Armed = Vec<(Schedule, Arc<Mutex<TimerCallback>>, Arc<AtomicBool>)>;

// * the platform's timers, read for their period and fired by hand, and its reading moved by hand:
// the other sides' `spyIntervals`
#[derive(Default)]
struct HandClock {
    now: AtomicU64,
    armed: Mutex<Armed>,
}

impl fmt::Debug for HandClock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("HandClock").finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct HandTimer(Arc<AtomicBool>);

impl Timer for HandTimer {
    fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Clock for HandClock {
    fn monotonic(&self) -> Duration {
        Duration::from_millis(self.now.load(Ordering::SeqCst))
    }

    fn wall(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: TimerCallback,
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        let cancelled = Arc::new(AtomicBool::new(false));

        self.armed.lock().unwrap().push((
            schedule,
            Arc::new(Mutex::new(callback)),
            Arc::clone(&cancelled),
        ));

        Ok(Arc::new(HandTimer(cancelled)))
    }
}

impl HandClock {
    fn pass(&self, milliseconds: u64) {
        self.now.fetch_add(milliseconds, Ordering::SeqCst);
    }

    fn schedules(&self) -> Vec<Schedule> {
        self.armed
            .lock()
            .unwrap()
            .iter()
            .map(|(schedule, ..)| *schedule)
            .collect()
    }

    fn is_cancelled(&self, index: usize) -> bool {
        self.armed.lock().unwrap()[index].2.load(Ordering::SeqCst)
    }

    // a beat of the timer armed `index`th, unless it was cancelled
    fn beat(&self, index: usize) {
        let (callback, cancelled) = {
            let armed = self.armed.lock().unwrap();

            (Arc::clone(&armed[index].1), Arc::clone(&armed[index].2))
        };

        if !cancelled.load(Ordering::SeqCst) {
            (callback.lock().unwrap())();
        }
    }
}

fn options_of(rate: u64, grace: u64) -> SendPaceOptions {
    SendPaceOptions {
        minimum_send_bytes_per_second: rate,
        send_grace_period: Duration::from_millis(grace),
    }
}

fn pace_of(
    clock: &Arc<HandClock>,
    (unsent, late): (&Arc<AtomicU64>, Box<dyn Fn() + Send + Sync>),
    options: &SendPaceOptions,
) -> SendPace {
    let unsent = Arc::clone(unsent);
    let shared: SharedClock = Arc::<HandClock>::clone(clock);

    SendPace::new(
        SendPaceHooks {
            unsent: Box::new(move || unsent.load(Ordering::SeqCst)),
            late,
        },
        (*options, shared),
    )
}

#[test]
fn holds_what_waits_to_its_pace_a_deadline_the_longer_of_its_grace_and_its_bytes_at_its_rate_judged_each_second_late_once_past_it()
 {
    let clock = Arc::new(HandClock::default());
    let unsent = Arc::new(AtomicU64::new(0));
    let lates = Arc::new(Mutex::new(Vec::new()));
    let told = Arc::clone(&lates);
    let seen = Arc::clone(&unsent);
    let pace = pace_of(
        &clock,
        (
            &unsent,
            Box::new(move || told.lock().unwrap().push(seen.load(Ordering::SeqCst))),
        ),
        &options_of(1_000, 40),
    );

    // 10 bytes take 10 ms at its rate: its grace stands
    unsent.store(10, Ordering::SeqCst);
    pace.hand(10);

    assert_eq!(
        clock.schedules(),
        vec![Schedule::Every(CHECK)],
        "one check, each second"
    );

    clock.beat(0);

    assert!(lates.lock().unwrap().is_empty(), "within its grace");

    clock.pass(60);
    clock.beat(0);

    // late once, and judged no more
    assert_eq!(*lates.lock().unwrap(), vec![10], "late once");
    assert!(clock.is_cancelled(0), "its check stopped");
}

#[test]
fn moves_its_deadline_by_the_time_each_envelope_takes_the_later_of_now_and_the_deadline_before_and_runs_none_while_nothing_waits()
 {
    let clock = Arc::new(HandClock::default());
    let unsent = Arc::new(AtomicU64::new(0));
    let is_late = Arc::new(AtomicBool::new(false));
    let late = Arc::clone(&is_late);
    let pace = pace_of(
        &clock,
        (
            &unsent,
            Box::new(move || late.store(true, Ordering::SeqCst)),
        ),
        &options_of(1_000, 20),
    );

    // two envelopes of 50 bytes: 50 ms each, the second after the first
    unsent.store(100, Ordering::SeqCst);
    pace.hand(50);
    pace.hand(50);
    clock.pass(60);
    clock.beat(0);

    assert!(!is_late.load(Ordering::SeqCst), "within its 100 ms");

    clock.pass(60);
    clock.beat(0);

    assert!(is_late.load(Ordering::SeqCst), "past its 100 ms");

    // nothing waiting, its check stops, and the next envelope starts from now
    let next = pace_of(
        &clock,
        (&unsent, Box::new(|| panic!("nothing waited"))),
        &options_of(1_000, 20),
    );

    unsent.store(0, Ordering::SeqCst);
    next.hand(10);
    clock.beat(1);

    assert!(clock.is_cancelled(1), "its check stopped");
}

#[test]
fn holds_none_at_a_rate_of_0_and_its_defaults_are_kestrel_s_240_bytes_a_second_past_5_s() {
    let clock = Arc::new(HandClock::default());
    let unsent = Arc::new(AtomicU64::new(1));
    let pace = pace_of(
        &clock,
        (&unsent, Box::new(|| panic!("no pace held"))),
        &options_of(0, 1),
    );

    pace.hand(1_000_000);

    assert!(clock.schedules().is_empty(), "no check armed");
    assert_eq!(
        (
            MINIMUM_SEND_BYTES_PER_SECOND,
            SEND_GRACE_PERIOD,
            HEADERS_TIMEOUT
        ),
        (240, Duration::from_secs(5), Duration::from_secs(30)),
        "its defaults"
    );
}

// spec 15.1, 15.12
#[test]
fn reports_a_connection_dropped_behind_its_pace_by_its_handle_naming_minimum_send_bytes_per_second_and_send_grace_period_with_their_values()
 {
    let dropped = dropped_of(
        "type=HTTP;ip=192.0.2.9;ordinal=1",
        &late_of(&SendPaceOptions {
            minimum_send_bytes_per_second: 240,
            send_grace_period: Duration::from_secs(5),
        }),
    );

    assert_eq!(
        dropped.to_string(),
        "type=HTTP;ip=192.0.2.9;ordinal=1 is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 240 past sendGracePeriod 5000 ms",
        "its words"
    );
}

#[test]
fn holds_a_whole_number_above_0_and_refuses_0_naming_its_option() {
    assert_eq!(hold_count("n", 1).unwrap(), 1, "a whole number above 0");
    assert_eq!(
        hold_count("n", 0).unwrap_err().to_string(),
        "n is a whole number above 0, not 0",
        "0 refused, its option named"
    );
}
