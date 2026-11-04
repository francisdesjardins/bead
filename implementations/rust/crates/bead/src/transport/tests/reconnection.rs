//! The common reconnection loop's waits, tap and last failure.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};

use crate::clock::SharedClock;
use crate::errors::{ConnectError, TransportError};
use crate::testing::SteppingClock;
use crate::transport::{TransportClientReconnectDelay, TransportClientReconnectOptions};

#[tokio::test]
async fn waits_each_delay_on_its_clock_telling_its_tap_first_and_gives_up_past_its_attempts_the_last_failure_its_cause()
 {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let attempts = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&attempts);
    let taps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&taps);
    let options = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(
            |previous, attempt| {
                previous.unwrap_or(Duration::ZERO) + Duration::from_millis(u64::from(attempt) * 10)
            },
        ))),
        maximum_attempts: Some(3),
        tap: Some(Arc::new(move |delay, attempt| {
            hearing
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((delay, attempt));
        })),
        ..TransportClientReconnectOptions::default()
    };
    let reconnecting = crate::testing::spawn(async move {
        crate::transport::attempting((&shared, &options), move |_| {
            let number = counting.fetch_add(1, Ordering::SeqCst) + 1;

            core::future::ready(Err(TransportError::Connect(ConnectError::new(format!(
                "refused {number}"
            )))))
        })
        .await
    });

    clock.settle().await;
    for (number, delay) in [(1, 10), (2, 30)] {
        assert_eq!(attempts.load(Ordering::SeqCst), number);
        assert_eq!(clock.dues(), [Duration::from_millis(delay)]);
        assert_eq!(
            taps.lock().unwrap_or_else(PoisonError::into_inner).last(),
            Some(&(
                Duration::from_millis(delay),
                u32::try_from(number).expect("an attempt")
            ))
        );
        clock.advance(Duration::from_millis(delay)).await;
    }
    let failure = reconnecting
        .await
        .expect("settled")
        .expect_err("three attempts fail");

    assert!(matches!(&failure, TransportError::Reconnect(error) if error.attempts() == 3));
    assert_eq!(failure.to_string(), "attempt 3 reached");
    let cause = std::error::Error::source(&failure).expect("the last failure is its cause");

    assert!(matches!(
        cause.downcast_ref::<TransportError>(),
        Some(TransportError::Connect(_))
    ));
    assert_eq!(cause.to_string(), "refused 3");
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(
        *taps.lock().unwrap_or_else(PoisonError::into_inner),
        [
            (Duration::from_millis(10), 1),
            (Duration::from_millis(30), 2)
        ]
    );
    assert_eq!(clock.dues(), []);
}
