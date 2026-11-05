//! The platform's clock: built on a runtime whose time driver is checked as it is built, the
//! current one or one given, never a panic inside a later timer (decision 0044).

use super::{SystemClock, SystemClockOptions};

mod twins;

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

#[test]
fn refuses_a_zero_period_and_an_overflowing_deadline_at_the_call_without_keeping_its_callback() {
    use crate::clock::{Clock, Schedule};
    use core::time::Duration;
    use std::sync::Arc;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a timed runtime");
    let clock = SystemClock::new(&SystemClockOptions {
        runtime: Some(runtime.handle().clone()),
    })
    .expect("the clock");
    let held = Arc::new(());
    for (schedule, words) in [
        (
            Schedule::Every(Duration::ZERO),
            "a clock's timer period is positive",
        ),
        (
            Schedule::Every(Duration::MAX),
            "a clock's timer deadline fits the platform's range",
        ),
        (
            Schedule::Once(Duration::MAX),
            "a clock's timer deadline fits the platform's range",
        ),
        (
            Schedule::Every(Duration::MAX.saturating_sub(Duration::from_secs(1))),
            "a clock's timer deadline fits the platform's range",
        ),
    ] {
        let captured = Arc::clone(&held);
        let refused = clock
            .arm(
                schedule,
                Box::new(move || {
                    drop(Arc::clone(&captured));
                    panic!("a refused timer never fires");
                }),
            )
            .expect_err("refused before any task runs");
        assert_eq!(refused.message(), words);
        assert_eq!(Arc::strong_count(&held), 1, "its callback released at once");
    }
}

#[tokio::test]
async fn arms_a_zero_due_and_a_positive_period_and_cancels_them() {
    use crate::clock::{Clock, Schedule};
    use crate::testing::{patience, rest};
    use core::sync::atomic::{AtomicUsize, Ordering};
    use core::time::Duration;
    use std::sync::Arc;

    let clock = SystemClock::current().expect("the clock");
    let (sent, received) = tokio::sync::oneshot::channel();
    let mut sent = Some(sent);
    let once = clock
        .arm(
            Schedule::Once(Duration::ZERO),
            Box::new(move || {
                if let Some(sent) = sent.take() {
                    sent.send(()).ok();
                }
            }),
        )
        .expect("a zero due fires at once");
    patience(Duration::from_secs(10), received)
        .await
        .expect("the once fires")
        .expect("the callback answers");
    once.cancel();
    once.cancel();

    let fired = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&fired);
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let every = clock
        .arm(
            Schedule::Every(Duration::from_millis(1)),
            Box::new(move || {
                counting.fetch_add(1, Ordering::SeqCst);
                sent.send(()).ok();
            }),
        )
        .expect("a positive period");
    assert_eq!(fired.load(Ordering::SeqCst), 0, "no callback at the call");
    for _ in 0..2 {
        patience(Duration::from_secs(10), received.recv())
            .await
            .expect("a period passes")
            .expect("the callback answers");
    }
    every.cancel();
    every.cancel();
    let stopped_at = fired.load(Ordering::SeqCst);
    rest(Duration::from_millis(5)).await;
    assert_eq!(
        fired.load(Ordering::SeqCst),
        stopped_at,
        "cancelled, it fires no more"
    );
}
