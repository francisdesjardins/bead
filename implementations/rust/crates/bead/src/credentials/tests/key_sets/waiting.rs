//! The places an issuer lets calls take while they wait for its next ask.

use core::time::Duration;

use tokio_util::sync::CancellationToken;

use super::{
    Fixture, SET_ISSUER, assert_session, assert_waiting, claims, done, key, locked, token,
};
use crate::router::core::{Resolved, Unresolved};

fn assert_capacity(outcome: Result<Resolved, Unresolved>, issuer: &str) {
    let Err(Unresolved::Capacity(error)) = outcome else {
        panic!("capacity refused: {outcome:?}");
    };
    assert_eq!(
        error.to_string(),
        format!("as many calls as its key set lets wait for the deadline of {issuer} wait already")
    );
}

#[tokio::test]
async fn lets_as_many_calls_wait_for_an_issuers_deadline_as_maximum_waiting_calls_says_64_when_not_given_and_refuses_one_more_capacity_exceeded_at_once_asking_nothing_more()
 {
    for (bound, most) in [(None, 64), (Some(3), 3)] {
        let fixture = Fixture::with(vec![], bound);
        fixture.hold().await;
        let mut waiting = Vec::new();
        for _ in 0..most {
            let mut outcome = fixture.named("set-2");
            fixture.clock.settle().await;
            assert_waiting(&mut outcome);
            waiting.push(outcome);
        }
        assert_capacity(done(fixture.named("set-2")).await, SET_ISSUER);
        assert_eq!(fixture.count(), 1);
        assert_eq!(waiting.len(), most);
        fixture.clock.advance(Duration::from_mins(1)).await;
        assert_eq!(fixture.count(), 2);
        fixture.answer(1, vec![key((2, Some("set-1"))), key((2, Some("set-2")))]);
        for outcome in waiting {
            assert_session(done(outcome).await, SET_ISSUER);
        }
    }
}

#[tokio::test]
async fn lets_every_call_that_waits_on_an_ask_under_way_wait_however_many_65_valid_tokens_at_a_cold_start_and_65_at_the_ten_minute_mark_all_verified()
 {
    let fixture = Fixture::new(vec![]);
    for (index, elapsed) in [Duration::ZERO, Duration::from_mins(10)]
        .into_iter()
        .enumerate()
    {
        fixture.clock.advance(elapsed).await;
        let mut waiting: Vec<_> = (0..65).map(|_| fixture.named("set-1")).collect();
        fixture.clock.settle().await;
        assert_eq!(fixture.count(), index.saturating_add(1));
        for outcome in &mut waiting {
            assert_waiting(outcome);
        }
        fixture.answer(index, vec![key((2, Some("set-1")))]);
        for outcome in waiting {
            assert_session(done(outcome).await, SET_ISSUER);
        }
    }
}

#[tokio::test]
async fn refuses_capacity_exceeded_a_call_an_answer_moves_onto_a_deadline_that_holds_as_many_as_its_key_set_lets_wait()
 {
    let fixture = Fixture::with(vec![], Some(2));
    let first = fixture.named("set-1");
    fixture.clock.settle().await;
    let mut waiting = Vec::new();
    for _ in 0..3 {
        let mut outcome = fixture.named("set-2");
        fixture.clock.settle().await;
        assert_waiting(&mut outcome);
        waiting.push(outcome);
    }
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    assert_session(done(first).await, SET_ISSUER);
    fixture.clock.settle().await;
    let excess = waiting.pop().expect("the last call");
    assert_capacity(done(excess).await, SET_ISSUER);
    for outcome in &mut waiting {
        assert_waiting(outcome);
    }
    assert_eq!(fixture.count(), 1);
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1"))), key((2, Some("set-2")))]);
    for outcome in waiting {
        assert_session(done(outcome).await, SET_ISSUER);
    }
}

#[tokio::test]
async fn gives_a_call_a_place_as_an_answer_moves_it_from_its_issuers_ask_onto_the_deadline_refusing_one_that_comes_past_the_bound_then_and_frees_it_as_the_call_leaves()
 {
    let fixture = Fixture::with(vec![], Some(1));
    let leaving = CancellationToken::new();
    let first = fixture.start(token(&claims(SET_ISSUER), (2, Some("set-1"))), &leaving);
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    leaving.cancel();
    assert!(
        matches!(done(first).await, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
    );
    assert!(!fixture.cancelled(0));
    let moving = CancellationToken::new();
    let mut moved = fixture.start(token(&claims(SET_ISSUER), (2, Some("set-2"))), &moving);
    fixture.clock.settle().await;
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    fixture.clock.settle().await;
    assert_waiting(&mut moved);
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    assert_capacity(done(fixture.named("set-2")).await, SET_ISSUER);
    moving.cancel();
    assert!(
        matches!(done(moved).await, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
    );
    let mut next = fixture.named("set-2");
    fixture.clock.settle().await;
    assert_waiting(&mut next);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1"))), key((2, Some("set-2")))]);
    assert_session(done(next).await, SET_ISSUER);
}

#[tokio::test]
async fn counts_the_calls_that_wait_for_each_issuers_deadline_apart() {
    let issuers = [SET_ISSUER, "https://other-keys.example"];
    let fixture = Fixture::on(
        vec![],
        (
            Some(1),
            issuers.iter().map(|issuer| (*issuer).to_owned()).collect(),
        ),
    );
    let mut first = Vec::new();
    for issuer in issuers {
        first.push(fixture.start(
            token(&claims(issuer), (2, Some("set-1"))),
            &CancellationToken::new(),
        ));
        fixture.clock.settle().await;
    }
    assert_eq!(fixture.count(), 2);
    assert_eq!(
        locked(&fixture.asks)
            .iter()
            .map(|ask| ask.issuer.clone())
            .collect::<Vec<_>>(),
        issuers
    );
    for index in 0..2 {
        fixture.answer(index, vec![key((2, Some("set-1")))]);
    }
    for (outcome, issuer) in first.into_iter().zip(issuers) {
        assert_session(done(outcome).await, issuer);
    }
    let mut waiting = Vec::new();
    for issuer in issuers {
        waiting.push(fixture.start(
            token(&claims(issuer), (2, Some("set-2"))),
            &CancellationToken::new(),
        ));
        fixture.clock.settle().await;
    }
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1); 2]);
    for issuer in issuers {
        assert_capacity(
            done(fixture.start(
                token(&claims(issuer), (2, Some("set-2"))),
                &CancellationToken::new(),
            ))
            .await,
            issuer,
        );
    }
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_eq!(fixture.count(), 4);
    for index in 2..4 {
        fixture.answer(
            index,
            vec![key((2, Some("set-1"))), key((2, Some("set-2")))],
        );
    }
    for (outcome, issuer) in waiting.into_iter().zip(issuers) {
        assert_session(done(outcome).await, issuer);
    }
}

#[tokio::test]
async fn frees_the_place_of_each_call_that_leaves_its_wait_10_000_that_leave_as_their_connection_closes_wait_again_none_refused_and_no_ask_goes_at_a_deadline_none_waits_for()
 {
    let fixture = Fixture::with(vec![], Some(10_000));
    fixture.hold().await;
    let unnamed = token(&claims(SET_ISSUER), (2, Some("set-2")));
    for _ in 0..2 {
        let connection = CancellationToken::new();
        let mut waiting: Vec<_> = (0..10_000)
            .map(|_| fixture.start(unnamed.clone(), &connection))
            .collect();
        fixture.clock.settle().await;
        for outcome in &mut waiting {
            assert_waiting(outcome);
        }
        assert_capacity(
            done(fixture.start(unnamed.clone(), &connection)).await,
            SET_ISSUER,
        );
        assert_eq!(fixture.count(), 1);
        connection.cancel();
        for outcome in waiting {
            assert!(
                matches!(done(outcome).await, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
            );
        }
    }
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), []);
    fixture.clock.advance(Duration::from_mins(1)).await;
    assert_eq!(fixture.count(), 1);
}
