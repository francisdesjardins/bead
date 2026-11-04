//! The common reconnection loop's waits, tap and last failure.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};

use tokio_util::sync::CancellationToken;

use crate::clock::SharedClock;
use crate::errors::{ConnectError, ProgrammerError, TransportError};
use crate::testing::SteppingClock;
use crate::transport::{
    RECONNECTION_CANCELLED, TransportClientReconnectDelay, TransportClientReconnectOptions,
    attempting,
};

/// An attempt that fails `failures` times with a connect's failure, then opens: each one's signal
/// kept.
#[derive(Clone)]
struct Failing {
    failures: usize,
    signals: Arc<Mutex<Vec<Option<CancellationToken>>>>,
}

impl Failing {
    fn of(failures: usize) -> Self {
        Self {
            failures,
            signals: Arc::default(),
        }
    }

    fn attempt(
        &self,
    ) -> impl FnMut(Option<CancellationToken>) -> core::future::Ready<Result<(), TransportError>>
    {
        let failing = self.clone();

        move |signal| {
            let made = {
                let mut signals = failing
                    .signals
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                signals.push(signal);

                signals.len()
            };

            core::future::ready(if made > failing.failures {
                Ok(())
            } else {
                Err(TransportError::Connect(ConnectError::new(format!(
                    "refused {made}"
                ))))
            })
        }
    }

    fn signals(&self) -> Vec<Option<CancellationToken>> {
        self.signals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

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
        attempting((&shared, &options), move |_| {
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

#[tokio::test]
async fn reads_its_signal_before_each_attempt_the_first_included_and_hands_it_to_each() {
    let clock: SharedClock = SteppingClock::new(crate::testing::instants::new_year());

    // * cancelled before any attempt: none made
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let never = Failing::of(0);
    let refused = attempting(
        (
            &clock,
            &TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
                maximum_attempts: Some(5),
                signal: Some(cancelled),
                ..TransportClientReconnectOptions::default()
            },
        ),
        never.attempt(),
    )
    .await
    .expect_err("cancelled before it starts");
    assert!(
        matches!(&refused, TransportError::Cancelled { message, .. } if message == RECONNECTION_CANCELLED)
    );
    assert_eq!(never.signals().len(), 0);

    // cancelled by the tap of its first failure: the wait cut short, no attempt after it
    let cancelling = CancellationToken::new();
    let cancel = cancelling.clone();
    let once = Failing::of(1);
    let refused = attempting(
        (
            &clock,
            &TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_mins(1))),
                maximum_attempts: Some(5),
                signal: Some(cancelling.clone()),
                tap: Some(Arc::new(move |_, _| cancel.cancel())),
                ..TransportClientReconnectOptions::default()
            },
        ),
        once.attempt(),
    )
    .await
    .expect_err("cancelled mid-wait");
    assert!(matches!(refused, TransportError::Cancelled { .. }));

    // the one attempt was handed the reconnection's signal, which its cancel reached
    let signals = once.signals();
    assert_eq!(signals.len(), 1);
    assert!(
        signals
            .first()
            .and_then(Option::as_ref)
            .is_some_and(CancellationToken::is_cancelled)
    );
}

#[tokio::test]
async fn ends_at_once_on_a_misuse_an_attempt_meets_a_functions_answer_out_of_bounds_or_what_its_tap_throws()
 {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let attempts = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&attempts);
    let misused = attempting(
        (
            &shared,
            &TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
                maximum_attempts: Some(u32::MAX),
                ..TransportClientReconnectOptions::default()
            },
        ),
        move |_| {
            counting.fetch_add(1, Ordering::SeqCst);

            core::future::ready(Err(TransportError::Refused(ProgrammerError::new(
                "a misuse",
            ))))
        },
    )
    .await
    .expect_err("a misuse");
    assert!(matches!(&misused, TransportError::Refused(error) if error.message() == "a misuse"));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);

    // * a delay a function gives past what a timer holds
    let out_of_bounds = attempting(
        (
            &shared,
            &TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(|_, _| {
                    crate::duration::NEVER
                }))),
                maximum_attempts: Some(u32::MAX),
                ..TransportClientReconnectOptions::default()
            },
        ),
        Failing::of(usize::MAX).attempt(),
    )
    .await
    .expect_err("a delay out of bounds");
    assert_eq!(
        out_of_bounds.to_string(),
        "a delay is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not Duration::MAX"
    );

    // * what its tap panics with, no wait left armed
    let broken = attempting(
        (
            &shared,
            &TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(1))),
                maximum_attempts: Some(u32::MAX),
                tap: Some(Arc::new(|_, _| panic!("its tap broke"))),
                ..TransportClientReconnectOptions::default()
            },
        ),
        Failing::of(usize::MAX).attempt(),
    )
    .await
    .expect_err("its tap broke");
    assert!(
        matches!(&broken, TransportError::Refused(error) if error.message() == "its tap broke")
    );
    assert_eq!(clock.dues(), []);
}
