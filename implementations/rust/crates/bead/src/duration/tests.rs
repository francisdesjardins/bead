//! The durations' tests: how each is held, and what no `Duration` holds.

use core::time::Duration;

use super::{LONGEST_TIMER, NEVER, hold, hold_delay, hold_finite};

#[test]
fn holds_a_duration_under_a_ceiling_of_its_own_as_under_the_timers_refusing_one_past_it_in_the_same_message()
 {
    use super::{HoldWithinOptions, hold_within};
    use crate::duration::DurationRefusal;
    use crate::errors::Refusal;
    let ceiling = Duration::from_secs(65_535);
    let options = HoldWithinOptions::new(ceiling);
    let file = crate::testing::durations::Durations::read().expect("the shared durations");
    let place = file
        .places
        .iter()
        .find(|place| place.id == "mqttBrokerAdapter.keepAlive")
        .expect("the source's ceiling policy");
    let timer = file
        .places
        .iter()
        .find(|place| place.id == "router.transferInactivityTimeout")
        .expect("the same policy under the timer's ceiling");
    for ((input, outcome), timer_outcome) in
        file.inputs.iter().zip(&place.outcomes).zip(&timer.outcomes)
    {
        if input.is_excused || outcome.is_excused {
            continue;
        }
        let given = input.given.expect("an input a Duration holds");
        let held = hold_within("a duration", given, &options);
        if outcome.outcome == "refused" || given > ceiling {
            let refused = held.expect_err("the policy refuses this input");
            let reason = if given == NEVER {
                DurationRefusal::NeverRefused
            } else if given.is_zero() {
                DurationRefusal::ZeroRefused
            } else if given < Duration::from_millis(1) {
                DurationRefusal::UnderTheFloor
            } else {
                DurationRefusal::PastTheCeiling
            };
            assert_eq!(refused.reason(), Some(Refusal::Duration(reason)));
            assert!(
                refused.message().starts_with(
                    "a duration is a duration of whole milliseconds from 1 to 65535000, not "
                ),
                "{} names its ceiling and value: {}",
                input.name,
                refused.message()
            );
        } else {
            assert_eq!(
                held.expect("the duration held"),
                timer_outcome
                    .held
                    .expect("the timer policy's held milliseconds"),
                "{}",
                input.name
            );
            assert_eq!(
                hold_within("a duration", given, &options),
                hold_finite("a duration", given)
            );
        }
    }
    for given in [ceiling, ceiling.saturating_sub(Duration::from_micros(500))] {
        assert_eq!(
            hold_within("a duration", given, &options).expect("the ceiling held after rounding"),
            ceiling
        );
    }
    for (extra, written) in [
        (Duration::from_micros(500), "65535000.5"),
        (Duration::from_millis(1), "65535001"),
    ] {
        let given = ceiling.saturating_add(extra);
        assert_eq!(
            hold_within("a duration", given, &options)
                .expect_err("past the ceiling before rounding")
                .message(),
            format!(
                "a duration is a duration of whole milliseconds from 1 to 65535000, not {written} milliseconds"
            )
        );
    }
}

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
fn a_duration_of_1_ms_is_refused_on_the_typescript_side_and_never_on_the_c_side_scenario() {
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
fn a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_c_side_scenario()
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
        "a duration is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not 0.00001 milliseconds"
    );
    assert_eq!(
        hold("a duration", under)
            .expect_err("under a millisecond")
            .message(),
        "a duration is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not 0.00001 milliseconds"
    );
    assert!(
        hold("a duration", past)
            .expect_err("past the ceiling")
            .message()
            .starts_with("a duration is a duration of whole milliseconds from 1 to 2147483647")
    );
}

#[test]
fn writes_each_refused_value_in_milliseconds_without_losing_its_fraction() {
    for (given, written) in [
        (Duration::ZERO, "0"),
        (Duration::from_nanos(1), "0.000001"),
        (Duration::from_micros(500), "0.5"),
        (Duration::from_millis(2_147_483_648), "2147483648"),
    ] {
        assert_eq!(
            hold_finite("timeout", given)
                .expect_err("refused")
                .message(),
            format!(
                "timeout is a duration of whole milliseconds from 1 to 2147483647, not {written} milliseconds"
            )
        );
    }
}

type HoldDuration = fn(&str, Duration) -> Result<Duration, crate::errors::ProgrammerError>;

fn holds_every_duration_input_by_its_policy() {
    struct Policy {
        hold: HoldDuration,
        place: &'static str,
        sentence: &'static str,
    }
    let file = crate::testing::durations::Durations::read().expect("the source duration inputs");
    assert_eq!(LONGEST_TIMER, Duration::from_millis(2_147_483_647));
    assert_eq!(file.inputs.len(), 19);
    assert_eq!(
        file.inputs
            .iter()
            .filter(|input| input.is_excused)
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["-2 ms", "-1 ms", "NaN", "\"1000\"", "true"]
    );
    for policy in [
        Policy {
            hold,
            place: "call.timeout",
            sentence: "a duration is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not ",
        },
        Policy {
            hold: hold_finite,
            place: "router.transferInactivityTimeout",
            sentence: "a duration is a duration of whole milliseconds from 1 to 2147483647, not ",
        },
        Policy {
            hold: hold_delay,
            place: "httpTransportClient.wait",
            sentence: "a duration is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not ",
        },
    ] {
        let place = file
            .places
            .iter()
            .find(|place| place.id == policy.place)
            .expect("the source policy");
        assert_eq!(place.outcomes.len(), file.inputs.len());
        let mut played = 0_usize;
        for (input, outcome) in file.inputs.iter().zip(&place.outcomes) {
            assert_eq!(input.name, outcome.input);
            if input.is_excused {
                assert_eq!(input.given, None);
                continue;
            }
            assert!(!outcome.is_excused, "{} {}", policy.place, input.name);
            played = played.saturating_add(1);
            let held = (policy.hold)("a duration", input.given.expect("a representable duration"));
            if outcome.outcome == "refused" {
                let refusal = held.expect_err("the source policy refuses this input");
                let written = match input.name.as_str() {
                    "0" => "0 milliseconds",
                    "0.00001 ms, under a tick" => "0.00001 milliseconds",
                    "half a millisecond" => "0.5 milliseconds",
                    "0.00001 ms past the ceiling" => "2147483647.00001 milliseconds",
                    "0.4 ms past the ceiling" => "2147483647.4 milliseconds",
                    "half a millisecond past the ceiling" => "2147483647.5 milliseconds",
                    "never" => "Duration::MAX",
                    other => panic!("an unlisted refusal input: {other}"),
                };
                assert_eq!(refusal.message(), format!("{}{written}", policy.sentence));
                let Some(crate::errors::Refusal::Duration(reason)) = refusal.reason() else {
                    panic!("a duration refusal");
                };
                assert_eq!(Some(reason.as_str()), outcome.reason.as_deref());
            } else {
                let expected = match outcome.outcome.as_str() {
                    "at once" => Duration::ZERO,
                    "never" => NEVER,
                    "held" => outcome.held.expect("the expected held duration"),
                    other => panic!("an unexpected policy outcome: {other}"),
                };
                assert_eq!(
                    held.expect("the source policy accepts this input"),
                    expected,
                    "{} {}",
                    policy.place,
                    input.name
                );
            }
        }
        assert_eq!(played, 14);
    }
}

#[test]
fn rounds_a_half_up_never_to_the_even() {
    let given = Duration::from_micros(2_500);
    for held in [
        hold("a duration", given),
        hold_finite("a duration", given),
        hold_delay("a duration", given),
    ] {
        assert_eq!(held.expect("a half up"), Duration::from_millis(3));
    }
}

fn a_non_number_has_no_duration() {
    let file = crate::testing::durations::Durations::read().expect("the source inputs");
    for name in ["NaN", "\"1000\"", "true"] {
        let input = file
            .inputs
            .iter()
            .find(|input| input.name == name)
            .expect("the source input");
        assert!(input.is_excused);
        assert_eq!(input.given, None);
    }
    Duration::try_from_secs_f64(f64::NAN).expect_err("no NaN duration");
}

#[test]
fn a_duration_of_1_ms_is_refused_on_the_typescript_side_and_never_on_the_c_side() {
    a_duration_of_1_ms_is_refused_on_the_typescript_side_and_never_on_the_c_side_scenario();
}

#[test]
fn a_duration_of_minus_1_ms_is_refused_on_the_typescript_side_and_never_on_the_csharp_side() {
    a_duration_of_1_ms_is_refused_on_the_typescript_side_and_never_on_the_c_side_scenario();
}

#[test]
fn a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_c_side()
 {
    a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_c_side_scenario();
}

#[test]
fn a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_csharp_side()
 {
    a_duration_finer_than_a_tick_is_held_as_written_on_the_typescript_side_and_truncated_to_its_ticks_on_the_c_side_scenario();
}

#[test]
fn holds_a_duration_as_a_whole_number_of_milliseconds_from_1_to_2_31_1_a_fraction_rounded_to_the_nearest_a_half_up_0_at_once_for_a_delay_and_never_where_never_has_a_meaning_refusing_any_other_in_one_message()
 {
    holds_every_duration_input_by_its_policy();
}

#[test]
fn a_duration_that_is_not_a_number_is_refused_on_the_typescript_side_and_no_time_span_on_the_c_side()
 {
    a_non_number_has_no_duration();
}

#[test]
fn holds_a_duration_as_a_whole_number_of_milliseconds_from_1_to_2_31_minus_1_a_fraction_rounded_to_the_nearest_a_half_up_0_at_once_for_a_delay_and_never_where_never_has_a_meaning_refusing_any_other_in_one_message()
 {
    holds_every_duration_input_by_its_policy();
}

#[test]
fn a_duration_that_is_not_a_number_is_refused_on_the_typescript_side_and_no_time_span_on_the_csharp_side()
 {
    a_non_number_has_no_duration();
}
