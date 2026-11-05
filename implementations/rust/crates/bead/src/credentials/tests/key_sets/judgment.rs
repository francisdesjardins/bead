//! A key set's answer takes effect during a token's first judgment, before its refusal can leave.

use core::time::Duration;
use std::sync::{Arc, Mutex, mpsc};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{
    AUDIENCE, Ask, Fixture, ISSUER, SET_ISSUER, application, assert_session, claims, done, key,
    locked, token,
};
use crate::clock::SharedClock;
use crate::credentials::{CredentialRequest, CredentialResolver, Credentials, JwtKeySet};
use crate::envelope::Credential;
use crate::testing::{ReadingClock, SteppingClock, instants, patience, spawn};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn judges_a_token_again_when_its_key_comes_to_serve_during_its_first_judgment_never_answering_the_refusal_it_had_before()
 {
    let clock = SteppingClock::new(instants::new_year());
    let reading = ReadingClock::new(Arc::<SteppingClock>::clone(&clock));
    let asks: Arc<Mutex<Vec<Ask>>> = Arc::default();
    let asking = Arc::clone(&asks);
    let credentials = Credentials {
        audience: Some(AUDIENCE.to_owned()),
        keys: vec![application(ISSUER, (2, Some("set-1")))],
        key_set: Some(JwtKeySet {
            issuers: vec![SET_ISSUER.to_owned()],
            maximum_waiting_calls: None,
            ask: Arc::new(move |issuer, signal| {
                let (answer, receiver) = oneshot::channel();
                locked(&asking).push(Ask {
                    issuer,
                    signal,
                    answer: Some(answer),
                });
                Box::pin(async move { receiver.await.expect("the ask is answered") })
            }),
        }),
        ..Credentials::default()
    };
    let shared: SharedClock = Arc::<ReadingClock>::clone(&reading);
    let fixture = Fixture {
        resolver: CredentialResolver::new(
            &credentials,
            (
                shared,
                crate::platform::runtime_of(None, "a credential test").expect("a runtime"),
            ),
        )
        .expect("credentials that hold"),
        clock,
        asks,
    };
    let named = token(&claims(SET_ISSUER), (2, Some("set-1")));
    let first = fixture.start(named.clone(), &CancellationToken::new());
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);

    // The first call's successful judgment confirms that the key serves before the reading
    // returns. The runtime's workers settle the real ask while this thread reads the wall clock.
    let (served, judged) = mpsc::sync_channel(1);
    let first = spawn(async move {
        let outcome = done(first).await;
        served.send(()).expect("the reading waits");
        outcome
    });
    let answer = locked(&fixture.asks)[0]
        .answer
        .take()
        .expect("the pending ask");
    reading.on_wall_read(move || {
        answer
            .send(Ok(vec![key((2, Some("set-1")))]))
            .expect("a live ask");
        judged
            .recv_timeout(Duration::from_secs(10))
            .expect("the key serves within this judgment");
    });
    let again = patience(
        Duration::from_secs(10),
        fixture.resolver.resolve((
            CredentialRequest {
                audiences: None,
                credential: Credential::Jwt(named),
                transport_credential: None,
            },
            CancellationToken::new(),
        )),
    )
    .await
    .expect("the judgment settles");
    assert_session(again, SET_ISSUER);
    assert_session(
        patience(Duration::from_secs(10), first)
            .await
            .expect("the first judgment settles")
            .expect("the task returns"),
        SET_ISSUER,
    );
    assert!(!reading.is_armed());
    assert_eq!(fixture.count(), 1);
}
