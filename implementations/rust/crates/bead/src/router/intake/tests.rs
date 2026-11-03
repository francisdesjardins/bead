//! The intake's tests (spec 15.12, decision 0046): what it counts, when it pauses a connection and
//! when it resumes it, and what an end resumes.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::Intake;
use crate::router::types::{ConnectionHandle, IntakeLimits};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn handle(name: &str) -> ConnectionHandle {
    Arc::from(name)
}

// what an intake asked of its transport, each call as a line
#[derive(Default)]
struct Calls(Mutex<Vec<String>>);

impl Calls {
    fn pause(&self, handle: &ConnectionHandle) {
        locked(&self.0).push(format!("pause {handle}"));
    }

    fn resume(&self, handle: &ConnectionHandle) {
        locked(&self.0).push(format!("resume {handle}"));
    }

    fn taken(&self) -> Vec<String> {
        core::mem::take(&mut *locked(&self.0))
    }
}

fn intake_of((envelopes, bytes): (u64, u64)) -> Arc<Intake> {
    Intake::new(IntakeLimits {
        maximum_untaken_envelopes: envelopes,
        maximum_untaken_bytes: bytes,
    })
}

#[test]
fn pauses_a_connection_once_what_it_handed_within_one_task_reaches_either_bound_once() {
    let intake = intake_of((3, 100));
    let calls = Calls::default();
    let (a, b) = (handle("a"), handle("b"));
    for (connection, bytes) in [(&a, 10), (&a, 10), (&b, 100)] {
        assert!(intake.handed((connection, bytes), |held| calls.pause(held)));
    }
    assert_eq!(*locked(&calls.0), ["pause b"]);
    assert_eq!(intake.paused(), [Arc::clone(&b)]);
    // The source's ArrayBuffer and ASCII text carry ten and four bytes here.
    for (connection, bytes) in [(&a, 10), (&a, 4), (&b, 1)] {
        assert!(intake.handed((connection, bytes), |held| calls.pause(held)));
    }
    assert_eq!(*locked(&calls.0), ["pause b", "pause a"]);
    assert_eq!(intake.paused(), [Arc::clone(&a), Arc::clone(&b)]);
    intake.end(|held| calls.resume(held));
}

#[tokio::test]
async fn resumes_what_it_paused_as_it_ends_and_counts_nothing_after() {
    let intake = intake_of((1, 1_048_576));
    let calls = Calls::default();
    let (a, b) = (handle("a"), handle("b"));
    assert!(intake.handed((&a, 1), |held| calls.pause(held)));
    intake.end(|held| calls.resume(held));
    intake.end(|held| calls.resume(held));
    assert!(!intake.handed((&b, 1), |held| calls.pause(held)));
    crate::testing::rest(core::time::Duration::ZERO).await;
    assert_eq!(*locked(&calls.0), ["pause a", "resume a"]);
    assert_eq!(intake.paused(), Vec::<ConnectionHandle>::new());
}

// spec 15.12.17, 15.12.18
#[test]
fn pauses_at_the_envelope_that_reaches_a_bound_and_resumes_once_both_counts_are_at_half() {
    let intake = intake_of((4, 1_000));
    let calls = Calls::default();
    let first = handle("first");

    for _ in 0..3 {
        assert!(
            intake.handed((&first, 10), |held| calls.pause(held)),
            "counted"
        );
    }

    assert!(calls.taken().is_empty(), "under its bounds, nothing paused");

    intake.handed((&first, 10), |held| calls.pause(held));

    assert_eq!(calls.taken(), ["pause first"], "paused at the fourth");

    // * once paused, a fifth handed all the same pauses nothing again
    intake.handed((&first, 10), |held| calls.pause(held));

    assert!(calls.taken().is_empty(), "a pause is asked once");
    assert_eq!(intake.paused(), [Arc::clone(&first)], "held paused");

    for left in [4, 3] {
        intake.taken((&first, 10), |held| calls.resume(held));

        assert!(calls.taken().is_empty(), "{left} untaken: still paused");
    }

    intake.taken((&first, 10), |held| calls.resume(held));

    assert_eq!(
        calls.taken(),
        ["resume first"],
        "resumed at 2 untaken, half of 4"
    );

    intake.taken((&first, 10), |held| calls.resume(held));
    intake.taken((&first, 10), |held| calls.resume(held));

    assert!(calls.taken().is_empty(), "resumed once");
    assert!(intake.paused().is_empty(), "nothing paused");

    // * its bytes alike: one envelope past the byte bound pauses, and is released whole
    intake.handed((&first, 5_000), |held| calls.pause(held));

    assert_eq!(calls.taken(), ["pause first"], "paused by its bytes");

    intake.taken((&first, 5_000), |held| calls.resume(held));

    assert_eq!(calls.taken(), ["resume first"], "resumed once taken");
}

// spec 15.12.17, 15.12.18
#[test]
fn resumes_only_once_both_counts_are_at_half_and_a_bound_of_1_at_0() {
    let intake = intake_of((10, 100));
    let calls = Calls::default();
    let first = handle("first");

    // * paused by its bytes, its envelopes under their half: resumed once its bytes are at 50
    intake.handed((&first, 60), |held| calls.pause(held));
    intake.handed((&first, 40), |held| calls.pause(held));

    assert_eq!(calls.taken(), ["pause first"], "paused at 100 bytes");

    intake.taken((&first, 40), |held| calls.resume(held));

    assert!(calls.taken().is_empty(), "60 bytes untaken, past half");

    intake.taken((&first, 60), |held| calls.resume(held));

    assert_eq!(
        calls.taken(),
        ["resume first"],
        "resumed with nothing untaken"
    );

    // * a bound of 1: each envelope pauses, and its release resumes
    let single = intake_of((1, 1_048_576));

    single.handed((&first, 1), |held| calls.pause(held));
    single.handed((&first, 1), |held| calls.pause(held));
    single.taken((&first, 1), |held| calls.resume(held));

    assert_eq!(
        calls.taken(),
        ["pause first"],
        "one untaken, past half of 1"
    );

    single.taken((&first, 1), |held| calls.resume(held));

    assert_eq!(calls.taken(), ["resume first"], "resumed at 0, half of 1");
}

#[test]
fn counts_each_connection_apart_and_an_end_resumes_each_paused_and_counts_nothing_more() {
    let intake = intake_of((2, 1_048_576));
    let calls = Calls::default();
    let (first, second, third) = (handle("first"), handle("second"), handle("third"));

    for held in [&first, &second, &first, &third, &second] {
        intake.handed((held, 1), |paused| calls.pause(paused));
    }

    assert_eq!(
        calls.taken(),
        ["pause first", "pause second"],
        "each paused at its own bound"
    );

    // * a connection forgotten resumes nothing, and its release finds nothing
    intake.forget(&second);
    intake.taken((&second, 1), |resumed| calls.resume(resumed));

    assert!(
        calls.taken().is_empty(),
        "nothing resumed of a connection gone"
    );

    intake.end(|resumed| calls.resume(resumed));

    assert_eq!(
        calls.taken(),
        ["resume first"],
        "each connection paused, resumed"
    );
    assert!(
        !intake.handed((&first, 1), |paused| calls.pause(paused))
            && !intake.handed((&first, 1), |paused| calls.pause(paused)),
        "nothing counted once it ended"
    );
    intake.taken((&third, 1), |resumed| calls.resume(resumed));

    assert!(calls.taken().is_empty(), "no pause after its end");
}
