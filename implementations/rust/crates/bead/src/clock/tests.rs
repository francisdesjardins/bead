//! The platform's clock: built on a runtime whose time driver is checked as it is built, the
//! current one or one given, never a panic inside a later timer (decision 0044).

use super::{SystemClock, SystemClockOptions};

#[test]
fn refuses_a_runtime_without_its_time_driver_as_it_is_built_the_current_one_or_one_given() {
    let timeless = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("a runtime without its time driver");
    let given = SystemClockOptions {
        runtime: Some(timeless.handle().clone()),
        ..SystemClockOptions::default()
    };

    assert_eq!(
        SystemClock::new(&given)
            .expect_err("a runtime given without its time driver")
            .message(),
        "a clock's runtime enables tokio's time driver",
        "one given refused as it is built"
    );

    let current = timeless.block_on(async { SystemClock::new(&SystemClockOptions::default()) });

    assert_eq!(
        current
            .expect_err("the current runtime without its time driver")
            .message(),
        "a clock's runtime enables tokio's time driver",
        "the current one refused alike"
    );
    assert_eq!(
        SystemClock::new(&SystemClockOptions::default())
            .expect_err("outside a runtime")
            .message(),
        "a clock is built within a tokio runtime, or given its handle",
        "none at all refused"
    );
}

#[test]
fn runs_on_a_runtime_given_with_its_time_driver() {
    let timed = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a runtime with its time driver");
    let given = SystemClockOptions {
        runtime: Some(timed.handle().clone()),
        ..SystemClockOptions::default()
    };

    SystemClock::new(&given).expect("built on the runtime given, outside it");
}
