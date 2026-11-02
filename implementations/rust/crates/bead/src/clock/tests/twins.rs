//! The shared clock kit refuses invalid timers and nested advances, and truncates dues.

use core::future::poll_fn;
use core::task::Poll;
use core::time::Duration;
use std::sync::{Arc, Mutex};

use crate::clock::{Clock, Schedule, SharedClock, SystemClock, clock_of};
use crate::duration::LONGEST_TIMER;
use crate::testing::{SteppingClock, instants};
use crate::transport::{caught, caught_future};

#[test]
fn refuses_a_timer_or_a_period_bead_never_arms_under_a_millisecond_or_past_the_ceiling_naming_it() {
    let clock = SteppingClock::new(instants::new_year());
    for due in [
        Duration::ZERO,
        Duration::from_micros(500),
        LONGEST_TIMER.saturating_add(Duration::from_millis(1)),
    ] {
        for schedule in [Schedule::Once(due), Schedule::Every(due)] {
            let refused = caught(("a test timer", || clock.arm(schedule, Box::new(|| {}))))
                .expect_err("an invalid delay");
            assert!(refused.to_string().ends_with(&format!("a test clock arms a timer for 1 to 2147483647 milliseconds, as Bead does, not {due:?}")));
        }
    }
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn counts_a_due_in_whole_milliseconds_a_fraction_dropped_from_1_to_the_ceiling() {
    let clock = SteppingClock::new(instants::new_year());
    let fired = Arc::new(Mutex::new(Vec::new()));
    let mut timers = Vec::new();
    for due in [Duration::from_micros(1_900), LONGEST_TIMER] {
        let reading = Arc::clone(&clock);
        let firing = Arc::clone(&fired);
        timers.push(clock.arm(
            Schedule::Once(due),
            Box::new(move || {
                firing
                    .lock()
                    .expect("the readings")
                    .push(reading.monotonic().as_millis());
            }),
        ));
    }
    clock.advance(Duration::from_millis(1)).await;
    clock
        .advance(LONGEST_TIMER.saturating_sub(Duration::from_millis(1)))
        .await;
    assert_eq!(*fired.lock().expect("the readings"), [1, 2_147_483_647]);
    for timer in timers {
        timer.cancel();
    }
}

#[tokio::test]
async fn refuses_an_advance_within_another_and_takes_one_once_it_ends() {
    let clock = SteppingClock::new(instants::new_year());
    let mut advancing = Box::pin(clock.advance(Duration::from_millis(1_000)));
    assert!(
        poll_fn(|context| Poll::Ready(advancing.as_mut().poll(context)))
            .await
            .is_pending()
    );
    let refused = caught_future(("a clock advance", clock.advance(Duration::from_millis(1))))
        .await
        .expect_err("a nested advance");
    assert!(refused.to_string().ends_with(
        "a test clock advances once at a time: an advance within another would move it back"
    ));
    advancing.await;
    clock.advance(Duration::from_millis(1)).await;
    assert_eq!(clock.monotonic(), Duration::from_millis(1_001));
}

#[tokio::test]
async fn describes_the_platform_s_clock_and_one_of_the_application_s_own() {
    let own = SteppingClock::new(instants::new_year());
    let platform = SystemClock::current().expect("a platform clock");
    assert_eq!(own.description(), "one of its own");
    assert_eq!(platform.description(), "the platform's");
}

#[tokio::test]
async fn a_layer_runs_on_the_clock_of_the_one_beneath_it_unless_given_one_and_refuses_one_that_differs_naming_both()
 {
    let beneath: SharedClock = SteppingClock::new(instants::new_year());
    let given: SharedClock = SteppingClock::new(instants::new_year());
    let platform: SharedClock = Arc::new(SystemClock::current().expect("a platform clock"));
    let names = ("a server", "its transport");
    for (below, own, expected) in [
        (Some(&beneath), None, &beneath),
        (Some(&beneath), Some(&beneath), &beneath),
        (None, Some(&given), &given),
    ] {
        assert!(Arc::ptr_eq(
            &clock_of((below, own), names)
                .expect("one clock")
                .expect("a clock selected"),
            expected
        ));
    }
    assert!(
        clock_of((None, None), names)
            .expect("the builder supplies its platform clock")
            .is_none()
    );
    for (given, description) in [(&given, "one of its own"), (&platform, "the platform's")] {
        assert_eq!(
            clock_of((Some(&beneath), Some(given)), names)
                .expect_err("two clocks")
                .message(),
            format!(
                "a server runs on the clock of its transport, one of its own, and was given another, {description}"
            )
        );
    }
}
