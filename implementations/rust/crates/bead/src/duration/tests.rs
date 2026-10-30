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
