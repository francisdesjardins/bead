use std::sync::atomic::AtomicUsize;
use std::time::SystemTime;

use super::*;
use crate::testing::SteppingClock;

type Counted = Arc<AtomicUsize>;

fn counting(count: &Counted) -> Box<dyn Fn() + Send + Sync> {
    let count = Arc::clone(count);

    Box::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
}

fn beating(clock: &Arc<SteppingClock>, heartbeat: Duration) -> (Heartbeat, Counted, Counted) {
    let pings = Counted::default();
    let drops = Counted::default();
    let shared: SharedClock = Arc::<SteppingClock>::clone(clock);
    let heartbeat = Heartbeat::new(
        HeartbeatHooks {
            ping: counting(&pings),
            drop: counting(&drops),
        },
        (heartbeat, &shared),
    );

    (heartbeat, pings, drops)
}

#[test]
fn takes_a_duration_a_timer_holds_or_never_for_none_and_refuses_zero_and_one_past_the_longest_timer()
 {
    assert_eq!(
        hold_heartbeat(Duration::from_millis(20)).unwrap(),
        Duration::from_millis(20),
        "a duration a timer holds"
    );
    assert_eq!(hold_heartbeat(NEVER).unwrap(), NEVER, "never, for none");

    for refused in [
        Duration::ZERO,
        crate::LONGEST_TIMER.saturating_add(Duration::from_millis(1)),
    ] {
        assert!(
            hold_heartbeat(refused)
                .unwrap_err()
                .to_string()
                .starts_with("a heartbeat "),
            "{refused:?} refused, named"
        );
    }
}

#[test]
fn pings_at_each_beat_while_the_peer_answers_and_drops_it_at_the_beat_after_a_ping_it_left_unanswered()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (heartbeat, pings, drops) = beating(&clock, Duration::from_millis(20));

    assert_eq!(
        clock.dues(),
        vec![Duration::from_millis(20)],
        "one beat armed"
    );

    clock.tick(Duration::from_millis(20));
    heartbeat.answer();
    clock.tick(Duration::from_millis(20));

    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (2, 0),
        "pinged while it answers"
    );

    // its second ping left unanswered: dropped at the next beat, which beats no more
    clock.tick(Duration::from_millis(20));

    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (2, 1),
        "dropped"
    );
    assert!(clock.dues().is_empty(), "its timer cleared");
}

#[test]
fn arms_nothing_for_never_and_a_stop_clears_the_timer() {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (_never, _, _) = beating(&clock, NEVER);

    assert!(clock.dues().is_empty(), "nothing armed for never");

    let (heartbeat, pings, _) = beating(&clock, Duration::from_millis(20));

    heartbeat.stop();
    clock.tick(Duration::from_millis(40));

    assert!(clock.dues().is_empty(), "its timer cleared");
    assert_eq!(pings.load(Ordering::SeqCst), 0, "no beat");
}
