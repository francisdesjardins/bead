//! Failed asks retain their cause and release every waiter before a later ask succeeds.

use core::time::Duration;
use std::sync::Arc;

use super::{Fixture, SET_ISSUER, assert_session, assert_waiting, done, key, locked};
use crate::router::core::{Resolved, Unresolved};
use crate::testing::surface::Consumer;

fn failed(outcome: Result<Resolved, Unresolved>) -> Arc<dyn std::error::Error + Send + Sync> {
    let Err(Unresolved::Other(error)) = outcome else {
        panic!("an ask failure expected: {outcome:?}");
    };
    assert_eq!(
        error.to_string(),
        format!("the key set's ask for {SET_ISSUER} failed")
    );
    assert!(
        error.source().is_some(),
        "the ask's cause remains available"
    );
    error
}

async fn recovers(fixture: &Fixture) {
    let mut next = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    assert_waiting(&mut next);
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_session(done(next).await, SET_ISSUER);
    assert_session(done(fixture.named("set-1")).await, SET_ISSUER);
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    assert_eq!(fixture.clock.dues(), []);
}

#[tokio::test]
async fn fails_every_waiter_on_a_malformed_key_set_answer_and_accepts_a_valid_answer_at_the_next_deadline()
 {
    let consumer = Consumer::new();
    consumer.accepts("pub fn answer() -> bead::KeySetAnswer { Ok(Vec::new()) }");
    consumer.refuses(
        "pub fn answer() -> bead::KeySetAnswer { Ok(None) }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        "pub fn answer() -> bead::KeySetAnswer { Ok(vec![None]) }",
        ("E0308", "mismatched types"),
    );
    let fixture = Fixture::new(vec![]);
    let first = fixture.named("set-1");
    let second = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    let mut malformed = key((2, Some("set-1")));
    malformed.jwk["k"] = serde_json::json!(crate::base64url::encode(&[2; 31]));
    fixture.answer(0, vec![malformed]);
    let first = failed(done(first).await);
    let second = failed(done(second).await);
    assert!(
        Arc::ptr_eq(&first, &second),
        "the same failure reaches both calls"
    );
    assert!(
        first
            .source()
            .expect("a cause")
            .is::<crate::errors::ProgrammerError>()
    );
    recovers(&fixture).await;
}

#[tokio::test]
async fn fails_the_calls_that_wait_on_an_ask_that_rejects_and_has_a_token_within_the_minute_wait_for_the_deadline_and_the_ask_then()
 {
    let fixture = Fixture::new(vec![]);
    let waiting = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    let cause = Arc::new(std::io::Error::other("the key set cannot be reached"));
    locked(&fixture.asks)[0]
        .answer
        .take()
        .expect("an unsettled ask")
        .send(Err(Box::new(Arc::clone(&cause))))
        .expect("a live ask");
    let failure = failed(done(waiting).await);
    let source = failure
        .source()
        .expect("the ask's cause")
        .downcast_ref::<Arc<std::io::Error>>()
        .expect("the error returned by the ask");
    assert!(Arc::ptr_eq(source, &cause));
    recovers(&fixture).await;
}
