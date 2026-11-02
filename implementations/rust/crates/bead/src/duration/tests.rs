//! The durations' tests: how each is held, and what no `Duration` holds.

use core::time::Duration;

use super::{LONGEST_TIMER, NEVER, hold, hold_delay, hold_finite};

#[test]
fn holds_a_duration_to_the_nearest_millisecond_from_1_ms_to_its_ceiling_never_and_0_as_each_place_takes_them()
 {
    assert_eq!(
        hold("a timeout", Duration::from_micros(1_500)).ok(),
        Some(Duration::from_millis(2)),
        "a half up"
    );
    assert_eq!(
        hold("a timeout", Duration::from_micros(1_499)).ok(),
        Some(Duration::from_millis(1)),
        "under a half down"
    );
    assert_eq!(
        hold("a timeout", NEVER).ok(),
        Some(NEVER),
        "never where it is taken"
    );
    assert_eq!(
        hold_delay("a delay", Duration::ZERO).ok(),
        Some(Duration::ZERO),
        "0 a delay at once"
    );

    for (refused, name) in [
        (hold("a timeout", Duration::ZERO), "a timeout"),
        (hold("a timeout", Duration::from_micros(999)), "a timeout"),
        (
            hold("a timeout", LONGEST_TIMER + Duration::from_millis(1)),
            "a timeout",
        ),
        (hold_finite("a period", NEVER), "a period"),
        (hold_delay("a delay", NEVER), "a delay"),
    ] {
        let message = refused.expect_err("refused").message().to_owned();

        assert!(message.starts_with(name), "{message} names {name}");
    }
}

// a platform's shape: a `Duration` is unsigned, so the conformance files' durations under zero have
// none to stand for them, and what would make one is refused before a router sees it
#[test]
fn a_duration_under_zero_is_no_duration_on_the_rust_side() {
    assert!(
        Duration::try_from_secs_f64(-0.001).is_err(),
        "no Duration under zero"
    );
    assert_eq!(
        Duration::ZERO.checked_sub(Duration::from_millis(1)),
        None,
        "none below zero"
    );
}

// a platform's shape: a `Duration` is a count, so a duration that is not a number has none to stand
// for it
#[test]
fn a_duration_that_is_not_a_number_is_no_duration_on_the_rust_side() {
    assert!(
        Duration::try_from_secs_f64(f64::NAN).is_err(),
        "no Duration of NaN"
    );
    assert!(
        Duration::try_from_secs_f64(f64::INFINITY).is_err(),
        "no Duration of infinity"
    );
}

// Rust's Duration holds no negative value: -1 ms cannot become its never sentinel either.
#[test]
fn a_duration_of_1_ms_is_refused_on_the_typescript_side_and_never_on_the_c_side() {
    let file = crate::testing::durations::Durations::read().expect("shared duration inputs");
    assert_eq!(
        file.inputs
            .iter()
            .find(|input| input.name == "-1 ms")
            .expect("the shared -1 ms")
            .given,
        None
    );
    Duration::try_from_secs_f64(-0.001).expect_err("no negative Duration");
    assert_eq!(Duration::ZERO.checked_sub(Duration::from_millis(1)), None);
    assert_eq!(hold("a duration", NEVER).expect("Rust's never"), NEVER);
    assert_eq!(
        hold_finite("a duration", NEVER)
            .expect_err("a finite duration")
            .message(),
        "a duration is a duration of whole milliseconds from 1 to 2147483647, not Duration::MAX"
    );
}

// A Rust tick is a nanosecond, so the same 10 ns fraction stays representable at both boundaries.
#[test]
fn a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_c_side()
 {
    let under = Duration::from_nanos(10);
    let past = LONGEST_TIMER.saturating_add(under);
    let file = crate::testing::durations::Durations::read().expect("shared duration inputs");
    for (name, expected) in [
        ("0.00001 ms, under a tick", under),
        ("0.00001 ms past the ceiling", past),
    ] {
        assert_eq!(
            file.inputs
                .iter()
                .find(|input| input.name == name)
                .expect("a shared boundary input")
                .given,
            Some(expected)
        );
    }
    assert_eq!(under.as_nanos(), 10);
    assert_eq!(past.saturating_sub(LONGEST_TIMER), under);
    assert_eq!(
        hold_delay("a duration", under)
            .expect_err("under a millisecond")
            .message(),
        "a duration is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not 10ns"
    );
    assert_eq!(
        hold("a duration", under)
            .expect_err("under a millisecond")
            .message(),
        "a duration is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not 10ns"
    );
    assert!(
        hold("a duration", past)
            .expect_err("past the ceiling")
            .message()
            .starts_with("a duration is a duration of whole milliseconds from 1 to 2147483647")
    );
}
