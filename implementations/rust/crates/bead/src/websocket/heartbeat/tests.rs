use std::sync::Mutex as Held;
use std::time::SystemTime;

use super::*;
use crate::testing::SteppingClock;

// what a heartbeat did, in order: a ping and its data, or a drop
type Heard = Arc<Held<Vec<Option<Vec<u8>>>>>;

fn beating(clock: &Arc<SteppingClock>, heartbeat: Duration) -> (Heartbeat, Arc<Reads>, Heard) {
    let heard = Heard::default();
    let shared: SharedClock = Arc::<SteppingClock>::clone(clock);
    let reads = Reads::new(shared);
    let (pinged, dropped) = (Arc::clone(&heard), Arc::clone(&heard));
    let heartbeat = Heartbeat::new(
        HeartbeatHooks {
            ping: Box::new(move |data: Bytes| locked(&pinged).push(Some(data.to_vec()))),
            drop: Box::new(move || locked(&dropped).push(None)),
        },
        (heartbeat, &reads),
    );

    (heartbeat, reads, heard)
}

fn count_of(count: u8) -> Vec<u8> {
    vec![0, 0, 0, 0, 0, 0, 0, count]
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
        LONGEST_TIMER.saturating_add(Duration::from_millis(1)),
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
fn pings_once_nothing_was_read_for_its_heartbeat_again_after_each_echo_and_drops_its_connection_once_a_ping_s_echo_has_not_come_within_its_heartbeat()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (heartbeat, reads, heard) = beating(&clock, Duration::from_millis(250));

    // what is read within each heartbeat keeps it from a ping
    for _ in 0..4 {
        clock.tick(Duration::from_millis(200));
        reads.stamp();
    }

    assert!(locked(&heard).is_empty(), "never pinged while read");

    // silent for its heartbeat: pinged, and kept by the echo
    clock.tick(Duration::from_millis(250));
    assert_eq!(*locked(&heard), vec![Some(count_of(1))], "pinged");
    heartbeat.answer(&count_of(1));

    // silent again for its heartbeat after the echo: pinged again; what is read, the echo of none,
    // answers nothing, and it is dropped a heartbeat past its ping
    clock.tick(Duration::from_millis(250));
    clock.tick(Duration::from_millis(100));
    reads.stamp();
    clock.tick(Duration::from_millis(149));
    assert_eq!(
        *locked(&heard),
        vec![Some(count_of(1)), Some(count_of(2))],
        "pinged again, not yet dropped"
    );
    clock.tick(Duration::from_millis(1));
    assert_eq!(
        *locked(&heard),
        vec![Some(count_of(1)), Some(count_of(2)), None],
        "dropped"
    );

    // dropped, it beats no more
    clock.tick(Duration::from_millis(1_000));
    assert_eq!(locked(&heard).len(), 3, "no beat more");
    assert!(clock.dues().is_empty(), "its timer cleared");
}

#[test]
fn takes_only_the_pong_that_echoes_its_ping_8_bytes_of_a_count_from_1_never_an_empty_one_another_s_or_an_earlier_ping_s()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (heartbeat, _reads, heard) = beating(&clock, Duration::from_millis(100));

    clock.tick(Duration::from_millis(100));
    heartbeat.answer(&count_of(1));
    clock.tick(Duration::from_millis(100));

    // a new count at each ping; an empty pong, another's and the first ping's echo answer nothing
    heartbeat.answer(&[]);
    heartbeat.answer(b"other");
    heartbeat.answer(&count_of(1));
    clock.tick(Duration::from_millis(100));

    assert_eq!(
        *locked(&heard),
        vec![Some(count_of(1)), Some(count_of(2)), None]
    );
}

fn arms_nothing_for_never_and_a_stop_clears_the_timer_scenario() {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (_never, _, _) = beating(&clock, NEVER);

    assert!(clock.dues().is_empty(), "nothing armed for never");

    let (heartbeat, _, heard) = beating(&clock, Duration::from_millis(20));

    heartbeat.stop();
    clock.tick(Duration::from_millis(40));

    assert!(clock.dues().is_empty(), "its timer cleared");
    assert!(locked(&heard).is_empty(), "no beat");
}

#[test]
fn arms_nothing_for_never_and_a_stop_clears_the_timer() {
    arms_nothing_for_never_and_a_stop_clears_the_timer_scenario();
}

#[test]
fn arms_nothing_for_infinity_and_a_stop_clears_the_timer() {
    arms_nothing_for_never_and_a_stop_clears_the_timer_scenario();
}

#[test]
fn takes_a_number_of_milliseconds_a_timer_holds_rounded_to_the_nearest_whole_one_or_infinity_for_none_and_refuses_infinity_which_the_durations_file_holds_no_input_of()
 {
    for (given, held) in [
        (Duration::from_millis(1), Duration::from_millis(1)),
        (Duration::from_micros(1_500), Duration::from_millis(2)),
        (Duration::from_secs(30), Duration::from_secs(30)),
        (LONGEST_TIMER, LONGEST_TIMER),
        (NEVER, NEVER),
    ] {
        assert_eq!(hold_heartbeat(given).expect("a source heartbeat"), held);
    }
    assert_eq!(crate::HEARTBEAT, Duration::from_secs(30));
    Duration::try_from_secs_f64(f64::NEG_INFINITY).expect_err("no negative infinity duration");
}
