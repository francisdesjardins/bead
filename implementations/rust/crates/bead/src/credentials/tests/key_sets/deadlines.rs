//! A key set's deadline is reached by its reading, even when its timer runs late.

use core::sync::atomic::{AtomicI64, Ordering};
use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;

use super::{
    Fixture, Outcome, SET_ISSUER, assert_refused, assert_session, assert_waiting, claims, done,
    key, token,
};
use crate::clock::{Clock, Schedule, Timer, TimerCallback};
use crate::router::core::Unresolved;
use crate::testing::SteppingClock;

#[derive(Debug)]
struct LateClock {
    base: Arc<SteppingClock>,
    lag: AtomicI64,
}

impl Clock for LateClock {
    fn monotonic(&self) -> Duration {
        let lag = self.lag.load(Ordering::SeqCst);
        let by = Duration::from_millis(lag.unsigned_abs());
        if lag < 0 {
            self.base.monotonic().saturating_sub(by)
        } else {
            self.base.monotonic().saturating_add(by)
        }
    }

    fn wall(&self) -> SystemTime {
        self.base.wall()
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: TimerCallback,
    ) -> Result<Arc<dyn Timer>, crate::errors::ProgrammerError> {
        self.base.arm(schedule, callback)
    }

    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.base.activity()
    }
}

fn late(maximum: Option<u64>) -> (Fixture, Arc<LateClock>) {
    let mut fixture = Fixture::with(vec![], maximum);
    let clock = Arc::new(LateClock {
        base: Arc::clone(&fixture.clock),
        lag: AtomicI64::new(0),
    });
    Arc::get_mut(&mut fixture.resolver.inner)
        .expect("a resolver not shared")
        .clock = Arc::<LateClock>::clone(&clock);
    (fixture, clock)
}

async fn assert_deadline(outcome: Outcome) {
    let Err(Unresolved::Other(error)) = done(outcome).await else {
        panic!("an unsettled ask fails at its deadline");
    };
    assert_eq!(
        error.to_string(),
        format!("the key set's ask for {SET_ISSUER} was unsettled as its deadline was reached")
    );
}

#[tokio::test]
async fn aborts_the_signal_it_gives_its_key_sets_ask_at_the_asks_deadline_a_minute_after_it_went_and_not_before_failing_the_calls_that_wait_on_it()
 {
    let fixture = Fixture::new(vec![]);
    let mut waiting = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    assert!(!fixture.cancelled(0));
    assert_waiting(&mut waiting);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert!(fixture.cancelled(0));
    assert_deadline(waiting).await;
    let next = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    assert!(!fixture.cancelled(1));
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_session(done(next).await, SET_ISSUER);
    fixture.answer(0, vec![]);
    fixture.clock.settle().await;
}

#[tokio::test]
async fn drops_what_an_ask_settles_to_after_its_deadline_its_keys_are_never_held() {
    let fixture = Fixture::new(vec![]);
    let waiting = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_deadline(waiting).await;
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    fixture.clock.settle().await;
    let again = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![]);
    assert_refused(done(again).await);
}

#[tokio::test]
async fn lets_a_call_that_comes_past_a_deadline_its_timer_has_yet_to_reach_for_which_as_many_calls_wait_as_the_key_set_lets_let_the_ask_go_for_them_and_wait_on_it_with_them_never_refused()
 {
    let (fixture, clock) = late(Some(2));
    fixture.hold().await;
    let mut waiting = Vec::new();
    for _ in 0..2 {
        let mut outcome = fixture.named("set-2");
        fixture.clock.settle().await;
        assert_waiting(&mut outcome);
        waiting.push(outcome);
    }
    let excess = done(fixture.named("set-2")).await;
    assert!(matches!(excess, Err(Unresolved::Capacity(_))));
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    clock.lag.store(1, Ordering::SeqCst);
    let mut coming = fixture.named("set-2");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    assert_waiting(&mut coming);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1"))), key((2, Some("set-2")))]);
    waiting.push(coming);
    for outcome in waiting {
        assert_session(done(outcome).await, SET_ISSUER);
    }
}

#[tokio::test]
async fn drops_an_answer_that_comes_as_the_reading_reaches_its_asks_deadline_its_timer_yet_to_fire_the_calls_that_wait_on_it_fail_nothing_is_held_and_the_late_timer_does_nothing_more()
 {
    let (fixture, clock) = late(None);
    let waiting = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    clock.lag.store(1, Ordering::SeqCst);
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    assert_deadline(waiting).await;
    assert!(fixture.cancelled(0));
    assert_eq!(fixture.clock.dues(), []);
    fixture.clock.advance(Duration::from_millis(1)).await;
    let next = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![]);
    assert_refused(done(next).await);
}

#[tokio::test]
async fn fails_an_ask_still_unsettled_as_a_call_comes_past_its_deadline_its_timer_yet_to_fire_aborting_its_signal_and_judges_that_call_by_a_new_ask_with_a_live_signal_the_late_timer_does_nothing_more()
 {
    let (fixture, clock) = late(None);
    let doomed = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    clock.lag.store(1, Ordering::SeqCst);
    let coming = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    assert!(fixture.cancelled(0));
    assert!(!fixture.cancelled(1));
    assert_deadline(doomed).await;
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_session(done(coming).await, SET_ISSUER);
    fixture.clock.advance(Duration::from_millis(1)).await;
    fixture.answer(0, vec![]);
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    assert_session(done(fixture.named("set-1")).await, SET_ISSUER);
}

#[tokio::test]
async fn lets_the_deadlines_ask_go_as_a_call_comes_past_it_its_timer_yet_to_fire_and_refuses_that_call_at_once_once_that_asks_answer_does_not_name_its_kid_the_late_timer_does_nothing_more()
 {
    let (fixture, clock) = late(None);
    fixture.hold().await;
    let mut waiting = fixture.named("set-2");
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    assert_waiting(&mut waiting);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    clock.lag.store(1, Ordering::SeqCst);
    let coming = fixture.named("set-2");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_refused(done(waiting).await);
    assert_refused(done(coming).await);
    assert_eq!(fixture.clock.dues(), []);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(fixture.count(), 2);
}

#[tokio::test]
async fn lets_no_ask_go_as_the_last_call_that_waits_for_a_deadline_leaves_past_it_its_timer_yet_to_fire_then_or_as_the_timer_fires()
 {
    let (fixture, clock) = late(None);
    fixture.hold().await;
    let leaving = CancellationToken::new();
    let mut left = fixture.start(token(&claims(SET_ISSUER), (2, Some("set-2"))), &leaving);
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    clock.lag.store(-1, Ordering::SeqCst);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_waiting(&mut left);
    assert_eq!(fixture.count(), 1);
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(1)]);
    clock.lag.store(0, Ordering::SeqCst);
    leaving.cancel();
    assert!(
        matches!(done(left).await, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
    );
    assert_eq!(fixture.count(), 1);
    assert_eq!(fixture.clock.dues(), []);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_eq!(fixture.count(), 1);
}

#[derive(Debug)]
struct RefusingClock(Arc<SteppingClock>);

impl Clock for RefusingClock {
    fn monotonic(&self) -> Duration {
        self.0.monotonic()
    }
    fn wall(&self) -> SystemTime {
        self.0.wall()
    }
    fn arm(
        &self,
        _schedule: Schedule,
        _callback: TimerCallback,
    ) -> Result<Arc<dyn Timer>, crate::errors::ProgrammerError> {
        Err(crate::errors::ProgrammerError::new(
            "the clock refuses this timer",
        ))
    }
    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.0.activity()
    }
}

#[tokio::test]
async fn a_timer_refusal_releases_the_waiting_call_without_starting_an_unbounded_key_set_ask() {
    let mut fixture = Fixture::with(vec![], None);
    Arc::get_mut(&mut fixture.resolver.inner)
        .expect("not shared")
        .clock = Arc::new(RefusingClock(Arc::clone(&fixture.clock)));
    let Err(Unresolved::Other(error)) = done(fixture.named("a key")).await else {
        panic!("the timer refusal fails the call");
    };
    assert_eq!(
        error.to_string(),
        format!("the key set's ask for {SET_ISSUER} failed")
    );
    assert_eq!(
        error.source().expect("the clock's cause").to_string(),
        "the clock refuses this timer"
    );
    assert_eq!(fixture.count(), 0, "no ask started without its deadline");
    assert_eq!(fixture.clock.dues(), [], "no timer held");
}
