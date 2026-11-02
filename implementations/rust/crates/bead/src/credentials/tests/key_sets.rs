//! Credential resolution against application keys and an issuer's shared key set.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::SharedClock;
use crate::constants::CredentialScheme;
use crate::credentials::{
    CredentialRequest, CredentialResolver, Credentials, JwtKeySet, JwtSetKey, KeySetAnswer,
};
use crate::envelope::Credential;
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::router::core::{Resolved, Unresolved};
use crate::router::types::{CallSession, SessionIdentifier};
use crate::testing::{SteppingClock, instants, patience};

const ISSUER: &str = "https://issuer.example";
const SET_ISSUER: &str = "https://keys.example";
const AUDIENCE: &str = "https://bead.example";

mod construction;
mod deadlines;
mod failures;
mod waiting;

fn claims(issuer: &str) -> Value {
    json!({"aud": AUDIENCE, "exp": 1_767_229_200, "iss": issuer, "sub": "grace"})
}

fn token(claims: &Value, (byte, kid): (u8, Option<&str>)) -> Bytes {
    let mut header = json!({"alg": "HS256", "typ": "at+jwt"});
    if let Some(kid) = kid {
        header["kid"] = json!(kid);
    }
    let input = format!(
        "{}.{}",
        crate::base64url::encode(header.to_string().as_bytes()),
        crate::base64url::encode(claims.to_string().as_bytes())
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(&[byte; 32]).expect("a secret");
    mac.update(input.as_bytes());
    Bytes::from(format!(
        "{input}.{}",
        crate::base64url::encode(&mac.finalize().into_bytes())
    ))
}

fn key((byte, kid): (u8, Option<&str>)) -> JwtSetKey {
    let mut jwk = json!({"kty": "oct", "k": crate::base64url::encode(&[byte; 32])});
    if let Some(kid) = kid {
        jwk["kid"] = json!(kid);
    }
    JwtSetKey {
        algorithm: JwtAlgorithm::Hs256,
        jwk: jwk.as_object().expect("an object").clone(),
    }
}

fn application(issuer: &str, material: (u8, Option<&str>)) -> JwtKey {
    let key = key(material);
    JwtKey {
        algorithm: key.algorithm,
        issuer: issuer.to_owned(),
        jwk: key.jwk,
    }
}

struct Ask {
    issuer: String,
    signal: CancellationToken,
    answer: Option<oneshot::Sender<KeySetAnswer>>,
}

type Outcome = oneshot::Receiver<Result<Resolved, Unresolved>>;

struct Fixture {
    clock: Arc<SteppingClock>,
    asks: Arc<Mutex<Vec<Ask>>>,
    resolver: CredentialResolver,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("the test's state")
}

fn resolver(credentials: &Credentials, clock: &Arc<SteppingClock>) -> CredentialResolver {
    let shared: SharedClock = Arc::<SteppingClock>::clone(clock);
    CredentialResolver::new(
        credentials,
        (
            shared,
            crate::platform::runtime_of(None, "a credential test").expect("a runtime"),
        ),
    )
    .expect("credentials that hold")
}

impl Fixture {
    fn new(keys: Vec<JwtKey>) -> Self {
        Self::with(keys, None)
    }

    fn with(keys: Vec<JwtKey>, maximum_waiting_calls: Option<u64>) -> Self {
        Self::on(keys, (maximum_waiting_calls, vec![SET_ISSUER.to_owned()]))
    }

    fn on(keys: Vec<JwtKey>, (maximum_waiting_calls, issuers): (Option<u64>, Vec<String>)) -> Self {
        let clock = SteppingClock::new(instants::new_year());
        let asks: Arc<Mutex<Vec<Ask>>> = Arc::default();
        let asking = Arc::clone(&asks);
        let key_set = JwtKeySet {
            issuers,
            maximum_waiting_calls,
            ask: Arc::new(move |issuer, signal| {
                let (answer, receiver) = oneshot::channel();
                locked(&asking).push(Ask {
                    issuer,
                    signal,
                    answer: Some(answer),
                });
                Box::pin(async move { receiver.await.expect("the test answers the ask") })
            }),
        };
        let credentials = Credentials {
            audience: Some(AUDIENCE.to_owned()),
            keys,
            key_set: Some(key_set),
            ..Credentials::default()
        };
        Self {
            resolver: resolver(&credentials, &clock),
            clock,
            asks,
        }
    }

    fn start(&self, token: Bytes, signal: &CancellationToken) -> Outcome {
        let resolving = self.resolver.resolve((
            CredentialRequest {
                audiences: None,
                credential: Credential::Jwt(token),
                transport_credential: None,
            },
            signal.clone(),
        ));
        let (answer, outcome) = oneshot::channel();
        let shared: SharedClock = Arc::<SteppingClock>::clone(&self.clock);
        crate::owner::spawn_counted(
            (
                &crate::platform::runtime_of(None, "a credential test").expect("a runtime"),
                &shared,
            ),
            async move {
                answer.send(resolving.await).ok();
            },
        );
        outcome
    }

    fn named(&self, kid: &str) -> Outcome {
        self.start(
            token(&claims(SET_ISSUER), (2, Some(kid))),
            &CancellationToken::new(),
        )
    }

    fn count(&self) -> usize {
        locked(&self.asks).len()
    }

    fn answer(&self, index: usize, keys: Vec<JwtSetKey>) {
        locked(&self.asks)[index]
            .answer
            .take()
            .expect("an ask unsettled")
            .send(Ok(keys))
            .expect("a live ask");
    }

    fn cancelled(&self, index: usize) -> bool {
        locked(&self.asks)[index].signal.is_cancelled()
    }

    async fn hold(&self) {
        let first = self.named("set-1");
        self.clock.settle().await;
        assert_eq!(self.count(), 1);
        self.answer(0, vec![key((2, Some("set-1")))]);
        assert_session(done(first).await, SET_ISSUER);
        self.clock.settle().await;
        assert_eq!(self.clock.dues(), []);
    }
}

fn assert_waiting(outcome: &mut Outcome) {
    assert!(
        matches!(outcome.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "the call still waits"
    );
}

async fn done(outcome: Outcome) -> Result<Resolved, Unresolved> {
    patience(Duration::from_secs(10), outcome)
        .await
        .expect("the call settles")
        .expect("the call replies")
}

fn assert_session(outcome: Result<Resolved, Unresolved>, issuer: &str) -> CallSession {
    let Ok(Resolved::Session(session)) = outcome else {
        panic!("a session expected: {outcome:?}");
    };
    assert_eq!(
        session.identifier,
        Some(SessionIdentifier::JwtSub {
            issuer: issuer.to_owned(),
            sub: "grace".to_owned()
        })
    );
    session
}

fn assert_refused(outcome: Result<Resolved, Unresolved>) {
    let verdict = outcome.expect("a refusal is a verdict");
    assert!(
        matches!(verdict, Resolved::Refused(_) | Resolved::None),
        "{verdict:?}"
    );
}

#[tokio::test]
async fn refuses_a_token_without_a_string_issuer_without_asking_for_keys_and_accepts_a_named_issuer_afterward()
 {
    let fixture = Fixture::new(vec![]);
    for issuer in [
        None,
        Some(Value::Null),
        Some(json!(7)),
        Some(json!([])),
        Some(json!({})),
    ] {
        let mut claims = claims(SET_ISSUER);
        if let Some(issuer) = issuer {
            claims["iss"] = issuer;
        } else {
            claims.as_object_mut().expect("claims").remove("iss");
        }
        let outcome = done(fixture.start(
            token(&claims, (2, Some("set-1"))),
            &CancellationToken::new(),
        ))
        .await;
        assert!(matches!(outcome, Ok(Resolved::Refused(reason)) if reason == "kid"));
        assert_eq!(fixture.count(), 0);
        assert_eq!(fixture.clock.dues(), []);
    }
    fixture.hold().await;
    assert_eq!(locked(&fixture.asks)[0].issuer, SET_ISSUER);
}

#[tokio::test]
async fn takes_a_jwt_once_given_keys_or_a_key_set_an_elsewhere_once_given_its_verifier_and_nothing_else()
 {
    let fixture = Fixture::new(vec![]);
    let set = fixture.resolver.inner.ask.clone().expect("an ask");
    let cases = [
        (Credentials::default(), vec![], false),
        (
            Credentials {
                audience: Some(AUDIENCE.to_owned()),
                ..Credentials::default()
            },
            vec![],
            false,
        ),
        (
            Credentials {
                audience: Some(AUDIENCE.to_owned()),
                keys: vec![application(ISSUER, (1, None))],
                ..Credentials::default()
            },
            vec![CredentialScheme::JWT],
            true,
        ),
        (
            Credentials {
                audience: Some(AUDIENCE.to_owned()),
                key_set: Some(JwtKeySet {
                    ask: set,
                    issuers: vec![SET_ISSUER.to_owned()],
                    maximum_waiting_calls: None,
                }),
                ..Credentials::default()
            },
            vec![CredentialScheme::JWT],
            true,
        ),
        (
            Credentials {
                audience: Some(AUDIENCE.to_owned()),
                keys: vec![application(ISSUER, (1, None))],
                verify: Some(Arc::new(|_, _| Box::pin(async { Ok(None) }))),
                ..Credentials::default()
            },
            vec![CredentialScheme::JWT, CredentialScheme::ELSEWHERE],
            true,
        ),
    ];
    for (credentials, schemes, takes_jwt) in cases {
        let resolver = resolver(&credentials, &fixture.clock);
        assert_eq!(resolver.schemes(), schemes);
        assert_eq!(resolver.takes_jwt(), takes_jwt);
    }
}

#[tokio::test]
async fn resolves_a_jwt_that_verifies_to_its_credentials_session_its_claims_its_identifier_with_its_scheme_its_end_exp_plus_60_s_and_one_that_does_not_to_none()
 {
    let fixture = Fixture::new(vec![application(ISSUER, (1, None))]);
    let claims = claims(ISSUER);
    let session = assert_session(
        done(fixture.start(token(&claims, (1, None)), &CancellationToken::new())).await,
        ISSUER,
    );
    assert_eq!(session.data, Some(claims.clone()));
    assert_eq!(session.end, Some(1_767_229_260_000));
    let mut other = claims.clone();
    other["aud"] = json!("https://other.example");
    assert_refused(done(fixture.start(token(&other, (1, None)), &CancellationToken::new())).await);
    for audiences in [
        vec!["https://other.example".to_owned()],
        vec![],
        vec![AUDIENCE.to_owned()],
    ] {
        let holds = audiences == [AUDIENCE];
        let result = fixture
            .resolver
            .resolve((
                CredentialRequest {
                    audiences: Some(audiences),
                    credential: Credential::Jwt(token(&claims, (1, None))),
                    transport_credential: None,
                },
                CancellationToken::new(),
            ))
            .await;
        if holds {
            assert_eq!(assert_session(result, ISSUER).end, session.end);
        } else {
            assert_refused(result);
        }
    }
    assert_refused(done(fixture.start(token(&claims, (2, None)), &CancellationToken::new())).await);
    fixture.clock.advance(Duration::from_mins(61)).await;
    assert_refused(done(fixture.start(token(&claims, (1, None)), &CancellationToken::new())).await);
}

#[tokio::test]
async fn asks_its_key_set_once_a_minute_at_most_for_an_issuer_sharing_an_ask_under_way_a_kid_none_names_within_the_minute_waits_for_the_deadline_and_the_ask_then_refused_once_its_answer_does_not_name_it()
 {
    let fixture = Fixture::new(vec![]);
    let first = fixture.named("set-1");
    let second = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    for result in [first, second] {
        assert_session(done(result).await, SET_ISSUER);
    }
    assert_session(done(fixture.named("set-1")).await, SET_ISSUER);
    let mut unknown = fixture.named("set-2");
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_secs(60)]);
    fixture.clock.advance(Duration::from_millis(59_999)).await;
    assert_waiting(&mut unknown);
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        locked(&fixture.asks)
            .iter()
            .map(|ask| ask.issuer.as_str())
            .collect::<Vec<_>>(),
        [SET_ISSUER, SET_ISSUER]
    );
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_refused(done(unknown).await);
}

#[tokio::test]
async fn starts_no_key_set_ask_for_a_call_whose_signal_is_cancelled_already() {
    let fixture = Fixture::new(vec![]);
    let signal = CancellationToken::new();
    signal.cancel();
    let outcome =
        done(fixture.start(token(&claims(SET_ISSUER), (2, Some("set-1"))), &signal)).await;
    assert!(
        matches!(outcome, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
    );
    assert_eq!(fixture.count(), 0);
    assert_eq!(fixture.clock.dues(), []);
    let next = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    assert!(!fixture.cancelled(0));
    assert_eq!(locked(&fixture.asks)[0].issuer, SET_ISSUER);
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    assert_session(done(next).await, SET_ISSUER);
    assert_eq!(fixture.count(), 1);
}

#[tokio::test]
async fn lets_a_calls_cancel_end_its_own_wait_never_the_ask_the_others_wait_on() {
    let fixture = Fixture::new(vec![]);
    let signal = CancellationToken::new();
    let leaving = fixture.start(token(&claims(SET_ISSUER), (2, Some("set-1"))), &signal);
    let mut waiting = fixture.named("set-1");
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    signal.cancel();
    assert!(
        matches!(done(leaving).await, Err(Unresolved::Other(error)) if error.to_string() == "the call was cancelled as it waited")
    );
    assert_waiting(&mut waiting);
    assert!(!fixture.cancelled(0));
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    assert_session(done(waiting).await, SET_ISSUER);
    assert_eq!(fixture.count(), 1);
}

#[tokio::test]
async fn has_a_token_without_a_kid_wait_on_a_new_ask_once_the_keys_held_for_its_issuer_are_past_their_ten_minutes_a_millisecond_either_side()
 {
    let fixture = Fixture::new(vec![]);
    fixture.hold().await;
    fixture.clock.advance(Duration::from_millis(599_999)).await;
    assert_session(
        done(fixture.start(
            token(&claims(SET_ISSUER), (2, None)),
            &CancellationToken::new(),
        ))
        .await,
        SET_ISSUER,
    );
    assert_eq!(fixture.count(), 1);
    fixture.clock.advance(Duration::from_millis(1)).await;
    let stale = fixture.start(
        token(&claims(SET_ISSUER), (2, None)),
        &CancellationToken::new(),
    );
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 2);
    fixture.answer(1, vec![key((2, Some("set-1")))]);
    assert_session(done(stale).await, SET_ISSUER);
}

#[tokio::test]
async fn refuses_at_once_asking_nothing_a_token_of_an_issuer_its_key_set_does_not_name_the_applications_own_among_them_whose_kid_another_issuers_held_key_names()
 {
    let fixture = Fixture::new(vec![application(ISSUER, (1, None))]);
    fixture.hold().await;
    for issuer in ["https://other.example", ISSUER] {
        for byte in [1, 2] {
            assert_refused(
                done(fixture.start(
                    token(&claims(issuer), (byte, Some("set-1"))),
                    &CancellationToken::new(),
                ))
                .await,
            );
        }
    }
    assert_eq!(fixture.count(), 1);
}

#[tokio::test]
async fn has_a_token_without_a_kid_wait_on_its_issuers_keys_at_a_cold_start_and_counts_the_keys_held_toward_its_issuers_one_key()
 {
    let fixture = Fixture::new(vec![]);
    let mut first = fixture.start(
        token(&claims(SET_ISSUER), (2, None)),
        &CancellationToken::new(),
    );
    fixture.clock.settle().await;
    assert_eq!(fixture.count(), 1);
    assert_waiting(&mut first);
    fixture.answer(0, vec![key((2, Some("set-1")))]);
    assert_session(done(first).await, SET_ISSUER);
    for kid in [Some("set-1"), None] {
        assert_session(
            done(fixture.start(
                token(&claims(SET_ISSUER), (2, kid)),
                &CancellationToken::new(),
            ))
            .await,
            SET_ISSUER,
        );
    }
    assert_eq!(fixture.count(), 1);
    let two = Fixture::new(vec![application(SET_ISSUER, (1, Some("app-1")))]);
    two.hold().await;
    assert_refused(
        done(two.start(
            token(&claims(SET_ISSUER), (1, None)),
            &CancellationToken::new(),
        ))
        .await,
    );
    assert_eq!(two.count(), 1);
}

#[tokio::test]
async fn takes_the_applications_copy_of_a_key_its_key_set_answers_again_beside_another_under_its_kid_and_refuses_a_token_without_a_kid_there()
 {
    let fixture = Fixture::new(vec![application(SET_ISSUER, (1, Some("app-1")))]);
    let first = fixture.named("set-1");
    fixture.clock.settle().await;
    let mut unused = key((1, Some("app-1")));
    unused.jwk.insert("use".to_owned(), json!("enc"));
    fixture.answer(0, vec![unused, key((2, Some("set-1")))]);
    assert_session(done(first).await, SET_ISSUER);
    assert_session(
        done(fixture.start(
            token(&claims(SET_ISSUER), (1, Some("app-1"))),
            &CancellationToken::new(),
        ))
        .await,
        SET_ISSUER,
    );
    assert_refused(
        done(fixture.start(
            token(&claims(SET_ISSUER), (1, None)),
            &CancellationToken::new(),
        ))
        .await,
    );
    assert_eq!(fixture.count(), 1);
}

#[tokio::test]
async fn takes_a_token_without_a_kid_once_its_key_set_answers_the_applications_key_alone_again_under_another_kid()
 {
    let fixture = Fixture::new(vec![application(SET_ISSUER, (1, Some("app-1")))]);
    let first = fixture.start(
        token(&claims(SET_ISSUER), (1, Some("app-2"))),
        &CancellationToken::new(),
    );
    fixture.clock.settle().await;
    fixture.answer(0, vec![key((1, Some("app-2")))]);
    assert_session(done(first).await, SET_ISSUER);
    for kid in [Some("app-1"), Some("app-2"), None] {
        assert_session(
            done(fixture.start(
                token(&claims(SET_ISSUER), (1, kid)),
                &CancellationToken::new(),
            ))
            .await,
            SET_ISSUER,
        );
    }
    assert_eq!(fixture.count(), 1);
}
