//! A kidless token uses its issuer's application key or waits for its next key-set answer.

use core::time::Duration;

use tokio_util::sync::CancellationToken;

use super::{
    Fixture, ISSUER, SET_ISSUER, application, assert_refused, assert_session, assert_waiting,
    claims, done, key, locked, token,
};

#[tokio::test]
async fn has_a_token_without_a_kid_wait_for_nothing_when_its_issuer_has_a_key_of_the_applications_and_for_the_deadline_and_the_ask_then_after_an_answer_that_gave_its_issuer_none()
 {
    for byte in [1, 2] {
        let fixture = Fixture::on(
            vec![application(ISSUER, (1, None))],
            (None, vec![SET_ISSUER.to_owned(), ISSUER.to_owned()]),
        );
        let signal = CancellationToken::new();
        assert_session(
            done(fixture.start(token(&claims(ISSUER), (1, None)), &signal)).await,
            ISSUER,
        );
        assert_refused(done(fixture.start(token(&claims(ISSUER), (2, None)), &signal)).await);
        assert_eq!(fixture.count(), 0);
        let kidless = token(&claims(SET_ISSUER), (byte, None));
        let cold = fixture.start(kidless.clone(), &signal);
        fixture.clock.settle().await;
        assert_eq!(fixture.count(), 1);
        fixture.answer(0, vec![]);
        assert_refused(done(cold).await);
        let mut next = fixture.start(kidless, &signal);
        fixture.clock.settle().await;
        assert_eq!(fixture.clock.dues(), [Duration::from_mins(1)]);
        fixture.clock.advance(Duration::from_millis(59_999)).await;
        assert_waiting(&mut next);
        assert_eq!(fixture.count(), 1);
        fixture.clock.advance(Duration::from_millis(1)).await;
        assert_eq!(fixture.count(), 2);
        assert_eq!(
            locked(&fixture.asks)
                .iter()
                .map(|ask| ask.issuer.clone())
                .collect::<Vec<_>>(),
            [SET_ISSUER, SET_ISSUER]
        );
        fixture.answer(1, vec![key((byte, Some("set-1")))]);
        assert_session(done(next).await, SET_ISSUER);
        fixture.clock.settle().await;
        assert_eq!(fixture.clock.dues(), []);
    }
}
