//! A broker connection's heartbeat (spec 15.21), the twin of the other sides': on the platform's
//! timer, in real time, whatever clock the side is given (decision 0011).

use core::fmt;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use core::time::Duration;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Instant, SystemTime};

use super::{locked, until};
use crate::broker::heartbeat::{Heartbeat, HeartbeatHooks};
use crate::clock::{Clock, Schedule, SharedClock, SystemClock, Timer, TimerCallback};
use crate::duration::{LONGEST_TIMER, NEVER};

fn platform() -> SharedClock {
    Arc::new(SystemClock::current().expect("a runtime"))
}

fn counting(count: &Arc<AtomicUsize>) -> Arc<dyn Fn() + Send + Sync> {
    let count = Arc::clone(count);

    Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
}

fn heartbeat_of(
    beat: Duration,
    (pings, drops): (&Arc<AtomicUsize>, &Arc<AtomicUsize>),
) -> Heartbeat {
    Heartbeat::start(
        beat,
        (
            platform(),
            HeartbeatHooks {
                ping: counting(pings),
                drop: counting(drops),
            },
        ),
    )
}

#[test]
fn drops_an_unanswered_ping_after_a_delayed_beat_without_arming_a_timer_for_less_than_nothing() {
    for crosses_deadline in [false, true] {
        let clock = Arc::new(DelayedClock::default());
        let (pings, drops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let shared: SharedClock = Arc::<DelayedClock>::clone(&clock);
        let heartbeat = Heartbeat::start(
            Duration::from_millis(100),
            (
                shared,
                HeartbeatHooks {
                    ping: counting(&pings),
                    drop: counting(&drops),
                },
            ),
        );
        let counts = || (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst));
        let dues = || {
            locked(&clock.state)
                .dues
                .iter()
                .map(Duration::as_millis)
                .collect::<Vec<_>>()
        };

        clock.fire(&[100]);
        assert_eq!(counts(), (1, 0), "pinged once");
        assert_eq!(dues(), [100, 100], "due at the ping's next heartbeat");

        if crosses_deadline {
            // * the ping's age reads 199; a second age read sees 201
            clock.fire(&[199, 201]);
            assert_eq!(counts(), (1, 0), "the ping has a millisecond left");
            assert_eq!(dues(), [100, 100, 1], "rearmed for that millisecond");
        }

        // * the timer due at 200 runs at 201: the unanswered ping is dropped at once
        clock.fire(&[201]);
        assert_eq!(counts(), (1, 1), "dropped once");
        assert_eq!(
            dues(),
            if crosses_deadline {
                vec![100, 100, 1]
            } else {
                vec![100, 100]
            },
            "nothing armed on dropping"
        );
        assert!(locked(&clock.state).pending.is_none(), "no timer remains");
        heartbeat.stop();
    }
}

// * a timer fired by hand: its readings can pass a deadline within one callback
#[derive(Default)]
struct DelayedState {
    now: Duration,
    readings: VecDeque<Duration>,
    dues: Vec<Duration>,
    pending: Option<(Arc<DelayedTimer>, TimerCallback)>,
}

#[derive(Default)]
struct DelayedClock {
    state: Mutex<DelayedState>,
}

impl fmt::Debug for DelayedClock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DelayedClock")
            .finish_non_exhaustive()
    }
}

impl DelayedClock {
    fn fire(&self, readings: &[u64]) {
        let (timer, mut callback) = {
            let mut state = locked(&self.state);

            state.readings = readings
                .iter()
                .copied()
                .map(Duration::from_millis)
                .collect();
            state.pending.take().expect("an armed timer")
        };

        assert!(!timer.cancelled.load(Ordering::SeqCst), "a live timer");
        callback();
    }
}

#[derive(Debug, Default)]
struct DelayedTimer {
    cancelled: AtomicBool,
}

impl Timer for DelayedTimer {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

impl Clock for DelayedClock {
    fn monotonic(&self) -> Duration {
        let mut state = locked(&self.state);

        if let Some(next) = state.readings.pop_front() {
            state.now = next;
        }

        state.now
    }

    fn wall(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        let Schedule::Once(due) = schedule else {
            panic!("a heartbeat arms a timer once");
        };

        assert!(
            (Duration::from_millis(1)..=LONGEST_TIMER).contains(&due),
            "a positive timer due, not {due:?}"
        );

        let timer = Arc::new(DelayedTimer::default());
        let mut state = locked(&self.state);

        state.dues.push(due);
        state.pending = Some((Arc::clone(&timer), callback));
        timer
    }
}

#[tokio::test]
async fn pings_a_connection_silent_for_its_heartbeat_on_the_platform_s_timer_and_drops_one_that_answered_nothing_by_the_next()
 {
    let beat = Duration::from_millis(200);
    let (pings, drops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let started = Instant::now();
    let heartbeat = heartbeat_of(beat, (&pings, &drops));

    // silent for a heartbeat: pinged, no sooner
    until(|| pings.load(Ordering::SeqCst) == 1, "pinged").await;
    assert!(
        started.elapsed() >= beat.saturating_sub(Duration::from_millis(20)),
        "pinged at {:?}",
        started.elapsed()
    );

    // answered nothing by the next: dropped, and beats no more
    until(|| drops.load(Ordering::SeqCst) == 1, "dropped").await;
    tokio::time::sleep(beat * 3).await;
    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (1, 1),
        "one ping, one drop"
    );
    heartbeat.stop();

    // a connection heard from every tenth of its heartbeat is never pinged
    let heard = Arc::new(AtomicUsize::new(0));
    let talking = heartbeat_of(beat * 10, (&heard, &heard));

    for _ in 0..10 {
        tokio::time::sleep(beat).await;
        talking.heard();
    }

    talking.stop();
    assert_eq!(heard.load(Ordering::SeqCst), 0, "never pinged");

    // anything heard answers the ping, and none beats once stopped
    let (answered_pings, answered_drops) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let answered = heartbeat_of(Duration::from_secs(1), (&answered_pings, &answered_drops));
    let told = || {
        (
            answered_pings.load(Ordering::SeqCst),
            answered_drops.load(Ordering::SeqCst),
        )
    };

    until(|| answered_pings.load(Ordering::SeqCst) == 1, "pinged").await;
    assert_eq!(told(), (1, 0), "pinged, not dropped");
    answered.heard();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(told(), (1, 0), "answered");
    answered.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(told(), (1, 0), "stopped");

    // without end, it arms nothing
    let never = heartbeat_of(NEVER, (&heard, &heard));

    tokio::time::sleep(beat * 2).await;
    never.stop();
    assert_eq!(heard.load(Ordering::SeqCst), 0, "nothing beaten");
}

#[tokio::test]
async fn starts_a_fresh_silence_after_anything_heard_answers_its_ping_then_drops_a_ping_left_unanswered()
 {
    let heard: Arc<Mutex<Vec<&str>>> = Arc::default();
    let (pinging, dropping) = (Arc::clone(&heard), Arc::clone(&heard));
    let heartbeat = Heartbeat::start(
        Duration::from_millis(100),
        (
            platform(),
            HeartbeatHooks {
                ping: Arc::new(move || locked(&pinging).push("ping")),
                drop: Arc::new(move || locked(&dropping).push("drop")),
            },
        ),
    );

    until(|| !locked(&heard).is_empty(), "pinged").await;
    assert_eq!(*locked(&heard), ["ping"], "pinged once");
    heartbeat.heard();
    until(|| locked(&heard).len() >= 3, "pinged anew and dropped").await;
    assert_eq!(*locked(&heard), ["ping", "ping", "drop"], "a fresh silence");
    heartbeat.stop();
}

#[tokio::test]
async fn beats_no_more_once_its_own_ping_stopped_it() {
    let (pings, drops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let beating: Arc<Mutex<Weak<Heartbeat>>> = Arc::default();
    let stopping = Arc::clone(&beating);
    let counted = Arc::clone(&pings);
    // * a ping that ends its connection, as one past what may wait for its broker does
    let heartbeat = Arc::new(Heartbeat::start(
        Duration::from_millis(100),
        (
            platform(),
            HeartbeatHooks {
                ping: Arc::new(move || {
                    counted.fetch_add(1, Ordering::SeqCst);

                    let heartbeat = locked(&stopping).upgrade();

                    if let Some(heartbeat) = heartbeat {
                        heartbeat.stop();
                    }
                }),
                drop: counting(&drops),
            },
        ),
    ));

    *locked(&beating) = Arc::downgrade(&heartbeat);
    until(|| pings.load(Ordering::SeqCst) == 1, "pinged").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (1, 0),
        "no more beats"
    );
}
