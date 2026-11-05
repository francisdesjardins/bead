//! JWT calls waiting for keys, cancelled or disposed, and a registered resolver's admission.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::server::{Served, first};
use super::{answered, cancel_of, locked, request_header_of};
use crate::NotificationResolverDependencies;
use crate::constants::{ProtocolCode, RouterSide};
use crate::credentials::{Credentials, JwtKeySet, JwtSetKey, KeySetAnswer};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::errors::CallError;
use crate::failure::Failure;
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::router::core::Handler;
use crate::router::server::RouterServerOptions;
use crate::router::types::{RequestCredential, RouterAnswer};
use crate::testing::pair::{Pair, PairOptions, echo};

const ISSUER: &str = "https://issuer.example";
const AUDIENCE: &str = "https://bead.example";
const NOW: i64 = 1_767_225_600;
const SECRET: [u8; 32] = [2; 32];

#[expect(
    clippy::too_many_lines,
    reason = "the twin checks all four credential schemes through the same admission"
)]
#[tokio::test]
async fn answers_an_admission_s_session_required_to_a_call_that_presented_a_credential_access_denied_and_to_one_that_presented_none_session_required()
 {
    use crate::credentials::ElsewhereSession;
    use crate::managers::service::{RequestResolverDependencies, Response};
    use crate::payloads::TextCodec;
    use crate::router::admissions::BeforeRequest;
    use crate::router::types::TransportMessage;
    use crate::testing::scripted::bytes_of;

    let clock = crate::testing::SteppingClock::new(super::january_first());
    let transport = crate::testing::scripted::ScriptedServer::new(Arc::<
        crate::testing::SteppingClock,
    >::clone(&clock));
    let served = crate::server::Server::new(
        Arc::<crate::testing::scripted::ScriptedServer>::clone(&transport),
        &crate::server::ServerOptions {
            credentials: Some(Credentials {
                audience: Some(AUDIENCE.to_owned()),
                keys: vec![JwtKey {
                    algorithm: JwtAlgorithm::Hs256,
                    issuer: ISSUER.to_owned(),
                    jwk: jwk(),
                }],
                verify: Some(Arc::new(|_, _| {
                    Box::pin(async {
                        Ok(Some(ElsewhereSession {
                            id: "ada".to_owned(),
                            data: None,
                            end: None,
                        }))
                    })
                })),
                ..Credentials::default()
            }),
            ..crate::server::ServerOptions::default()
        },
    )
    .expect("a server");
    transport.open(&first(), true);
    let mut session = served.sessions().create(first());
    session.data = Some(json!("leg A"));
    let stored = served
        .sessions()
        .set(session)
        .expect("a valid session")
        .await
        .expect("stored");
    let token = stored.session_token.expect("the connection's token");
    let reports = Arc::new(Mutex::new(Vec::<String>::new()));
    let reporting = Arc::clone(&reports);
    served.router().on_error(Arc::new(move |error, _| {
        locked(&reporting).push(error.to_string());
    }));
    let admitted = Arc::new(Mutex::new(Vec::new()));
    let admitting = Arc::clone(&admitted);
    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&admitting).push((request.header.call_id, request.session.is_some()));
            false
        },
        Some(
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server)
                .saying("not this one"),
        ),
    ));
    served
        .services()
        .get_request_resolver(&echo(), dependencies)
        .expect("echo resolved")
        .on(Arc::new(|_, response: Response<TextCodec>| {
            response.result("admitted".to_owned())
        }))
        .expect("registered");
    for (call_id, credential, carried) in [
        (1, None, None),
        (3, Some(Credential::Opaque(token)), None),
        (5, Some(Credential::Jwt(Bytes::from(jwt()))), None),
        (
            7,
            Some(Credential::Elsewhere),
            Some("Interop sub=ada".to_owned()),
        ),
    ] {
        transport.deliver_message(
            &TransportMessage {
                data: bytes_of(&Envelope::Request {
                    header: RequestHeader {
                        credential,
                        ..request_header_of(call_id)
                    },
                    payload: Bytes::new(),
                }),
                credential: carried,
                ..TransportMessage::default()
            },
            &first(),
        );
    }
    clock.settle().await;
    let mut failures = transport
        .take()
        .into_iter()
        .map(|(handle, envelope)| {
            assert_eq!(handle, first());
            let Envelope::Failure { header, failure } = envelope else {
                panic!("each call is refused")
            };
            (header.call_id, failure.code, failure.detail)
        })
        .collect::<Vec<_>>();
    failures.sort_by_key(|(call_id, _, _)| *call_id);
    assert_eq!(
        failures,
        [
            (
                1,
                ProtocolCode::SESSION_REQUIRED.get(),
                "not this one".to_owned()
            ),
            (
                3,
                ProtocolCode::ACCESS_DENIED.get(),
                "not this one".to_owned()
            ),
            (
                5,
                ProtocolCode::ACCESS_DENIED.get(),
                "not this one".to_owned()
            ),
            (
                7,
                ProtocolCode::ACCESS_DENIED.get(),
                "not this one".to_owned()
            ),
        ]
    );
    let mut admitted = locked(&admitted).clone();
    admitted.sort_unstable();
    assert_eq!(admitted, [(1, true), (3, true), (5, true), (7, true)]);
    assert_eq!(*locked(&reports), Vec::<String>::new());
    served.dispose().await.expect("disposed");
}

fn jwk() -> serde_json::Map<String, Value> {
    json!({"kty": "oct", "k": crate::base64url::encode(&SECRET), "kid": "set-key"})
        .as_object()
        .cloned()
        .expect("a JWK object")
}

fn jwt() -> String {
    jwt_of(&json!({}))
}

fn jwt_of(extra: &Value) -> String {
    jwt_with_kid(extra, "set-key")
}

fn jwt_with_kid(extra: &Value, kid: &str) -> String {
    let header = crate::base64url::encode(
        json!({"alg": "HS256", "typ": "at+jwt", "kid": kid})
            .to_string()
            .as_bytes(),
    );
    let mut claims =
        json!({"iss": ISSUER, "aud": AUDIENCE, "sub": "grace", "exp": NOW.saturating_add(3_600)});
    for (key, value) in extra.as_object().expect("extra claims") {
        claims[key] = value.clone();
    }
    let claims = crate::base64url::encode(claims.to_string().as_bytes());
    let signing = format!("{header}.{claims}");
    let mut mac = Hmac::<Sha256>::new_from_slice(&SECRET).expect("an HMAC key");
    mac.update(signing.as_bytes());
    format!(
        "{signing}.{}",
        crate::base64url::encode(&mac.finalize().into_bytes())
    )
}

type Ask = (String, CancellationToken, oneshot::Sender<KeySetAnswer>);
type Asks = Arc<Mutex<Vec<Ask>>>;

fn key_set() -> (JwtKeySet, Asks) {
    let asks = Asks::default();
    let asking = Arc::clone(&asks);
    (
        JwtKeySet {
            ask: Arc::new(move |issuer, signal| {
                let (reply, answer) = oneshot::channel();
                locked(&asking).push((issuer, signal, reply));
                Box::pin(async move { answer.await.expect("the test answers its ask") })
            }),
            issuers: vec![ISSUER.to_owned()],
            maximum_waiting_calls: None,
        },
        asks,
    )
}

fn release(asks: &Asks) {
    release_keys(
        asks,
        &[JwtSetKey {
            algorithm: JwtAlgorithm::Hs256,
            jwk: jwk(),
        }],
    );
}

fn release_keys(asks: &Asks, keys: &[JwtSetKey]) {
    for (issuer, signal, reply) in core::mem::take(&mut *locked(asks)) {
        assert_eq!(issuer, ISSUER);
        assert!(
            !signal.is_cancelled(),
            "a call's end does not cancel the issuer's shared ask"
        );
        reply
            .send(Ok(keys.to_owned()))
            .expect("the issuer's ask still waits");
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the twin primes the held keys, fills their waiting bound, then settles the deadline and checks the client's credential"
)]
#[tokio::test]
async fn answers_a_jwt_call_past_the_calls_its_key_set_lets_wait_for_an_issuers_deadline_capacity_exceeded_reporting_nothing_and_its_client_keeps_its_default()
 {
    let (mut key_set, asks) = key_set();
    key_set.maximum_waiting_calls = Some(1);
    let credential = RequestCredential::Jwt(jwt_with_kid(&json!({}), "set-2"));
    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            server: Some(crate::server::ServerOptions {
                credentials: Some(Credentials {
                    audience: Some(AUDIENCE.to_owned()),
                    key_set: Some(key_set),
                    ..Credentials::default()
                }),
                ..crate::server::ServerOptions::default()
            }),
            client: Some(crate::client::ClientOptions {
                credential: Some(credential.clone()),
                ..crate::client::ClientOptions::default()
            }),
        },
    )
    .await
    .expect("a connected pair");
    let ran = Arc::new(AtomicUsize::new(0));
    pair.server
        .router()
        .register_resolver((&echo(), handler(&ran)))
        .expect("echo registered");
    let withdrawn = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&withdrawn);
    pair.client
        .router()
        .on_credential_withdrawn(Arc::new(move |scheme| locked(&hearing).push(scheme)));
    let mut holding = super::request_of((None, super::TIMEOUT));
    holding.options.credential = Some(RequestCredential::Jwt(jwt()));
    let holding = pair
        .client
        .router()
        .request(Bytes::new(), holding)
        .expect("a holding call");
    pair.settle().await;
    assert_eq!(locked(&asks).len(), 1);
    release(&asks);
    pair.settle().await;
    assert_eq!(
        answered(holding)
            .await
            .expect("the named key holds")
            .payload,
        Bytes::from_static(b"grace")
    );
    let call = || {
        pair.client
            .router()
            .request(
                Bytes::new(),
                super::request_of((None, core::time::Duration::from_secs(120))),
            )
            .expect("a call using its default")
    };
    let waiting = call();
    let refused = call();
    pair.settle().await;
    let failure = answered(refused)
        .await
        .expect_err("one call is past the waiting bound");
    assert!(
        matches!(failure, CallError::Failure(failure) if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get() && failure.origin() == crate::failure::FailureOrigin::Peer)
    );
    assert_eq!(
        locked(&asks).len(),
        0,
        "the held keys' deadline has not come"
    );
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    pair.clock
        .advance(core::time::Duration::from_secs(60))
        .await;
    assert_eq!(
        locked(&asks).len(),
        1,
        "a single ask at the issuer's deadline"
    );
    let mut second = jwk();
    second.insert("kid".to_owned(), json!("set-2"));
    release_keys(
        &asks,
        &[jwk(), second]
            .into_iter()
            .map(|jwk| JwtSetKey {
                algorithm: JwtAlgorithm::Hs256,
                jwk,
            })
            .collect::<Vec<_>>(),
    );
    pair.settle().await;
    assert_eq!(
        answered(waiting).await.expect("the new key holds").payload,
        Bytes::from_static(b"grace")
    );
    assert_eq!(ran.load(Ordering::SeqCst), 2);
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(pair.client.router().credential(), Some(credential));
    assert_eq!(locked(&pair.server_reports).len(), 0);
    assert_eq!(locked(&pair.client_reports).len(), 0);
    pair.client.dispose().await;
    pair.server.dispose().await.expect("the server disposed");
}

fn handler(ran: &Arc<AtomicUsize>) -> Handler {
    let ran = Arc::clone(ran);
    Handler {
        resolve: Arc::new(move |props| {
            ran.fetch_add(1, Ordering::SeqCst);
            let sub = props
                .session
                .as_ref()
                .and_then(|session| session.data.as_ref())
                .and_then(|claims| claims.get("sub"))
                .and_then(Value::as_str)
                .expect("verified claims")
                .to_owned();
            Box::pin(async move {
                props
                    .answerer
                    .respond(RouterAnswer::Result(Bytes::from(sub)))
                    .await
                    .map_err(crate::errors::ResolverError::other)
            })
        }),
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

fn serving(key_set: JwtKeySet, ran: &Arc<AtomicUsize>) -> Served {
    let served = Served::new(&RouterServerOptions {
        credentials: Some(Credentials {
            audience: Some(AUDIENCE.to_owned()),
            key_set: Some(key_set),
            ..Credentials::default()
        }),
        ..RouterServerOptions::default()
    });
    served.transport.open(&first(), true);
    served
        .router
        .register_resolver((&echo(), handler(ran)))
        .expect("echo registered");
    served
}

fn request(call_id: u32) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            credential: Some(Credential::Jwt(Bytes::from(jwt()))),
            ..request_header_of(call_id)
        },
        payload: Bytes::new(),
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the twin checks both a wall-clock leap and a timer advance with two subscription paths and both peers' observations"
)]
#[tokio::test]
async fn answers_a_subscribing_call_whose_jwts_end_passes_before_its_answer_with_its_result_then_session_required_and_its_client_withdraws_nothing()
 {
    use core::time::Duration;

    use super::client::Notified;
    use super::server::news;
    use crate::constants::EnvelopeKind;
    use crate::debug::DebugDirection;
    use crate::managers::service::{RequestResolverDependencies, Response};
    use crate::payloads::TextCodec;

    for (seconds, advance_clock) in [(120, false), (1, true)] {
        let credential = RequestCredential::Jwt(jwt_of(&json!({"exp": NOW + seconds - 60})));
        let pair = Pair::connected(
            crate::testing::instants::new_year(),
            &PairOptions {
                server: Some(crate::server::ServerOptions {
                    credentials: Some(Credentials {
                        audience: Some(AUDIENCE.to_owned()),
                        keys: vec![JwtKey {
                            algorithm: JwtAlgorithm::Hs256,
                            issuer: ISSUER.to_owned(),
                            jwk: jwk(),
                        }],
                        ..Credentials::default()
                    }),
                    ..crate::server::ServerOptions::default()
                }),
                client: Some(crate::client::ClientOptions {
                    credential: Some(credential.clone()),
                    ..crate::client::ClientOptions::default()
                }),
            },
        )
        .await
        .expect("a connected pair");
        let released = CancellationToken::new();
        let entered = Arc::new(AtomicUsize::new(0));
        let flash = crate::identity::Procedure {
            procedure_id: 7,
            procedure_name: "flash".to_owned(),
            ..news()
        };
        for (procedure, explicit) in [(news(), true), (flash.clone(), false)] {
            let released = released.clone();
            let entered = Arc::clone(&entered);
            pair.server
                .services()
                .get_notification_resolver(
                    &procedure,
                    NotificationResolverDependencies::new(
                        RequestResolverDependencies::new(TextCodec, TextCodec),
                        TextCodec,
                    ),
                )
                .expect("the notification resolved")
                .on(Arc::new(move |_, response: Response<TextCodec>| {
                    entered.fetch_add(1, Ordering::SeqCst);
                    let released = released.clone();
                    Box::pin(async move {
                        released.cancelled().await;
                        if explicit {
                            response
                                .register_notification()
                                .await
                                .map_err(crate::errors::ResolverError::other)?;
                            crate::testing::rest(Duration::ZERO).await;
                        }
                        response.result("subscribed".to_owned()).await
                    })
                }))
                .expect("the notification registered");
        }
        let sent = Arc::new(Mutex::new(Vec::new()));
        let seeing = Arc::clone(&sent);
        pair.server
            .router()
            .on_debug(Arc::new(move |direction, envelope| {
                if direction == DebugDirection::Tx {
                    locked(&seeing).push(envelope.header.clone());
                }
            }));
        let withdrawn = Arc::new(Mutex::new(Vec::new()));
        let hearing = Arc::clone(&withdrawn);
        pair.client
            .router()
            .on_credential_withdrawn(Arc::new(move |scheme| {
                locked(&hearing).push(scheme);
            }));
        let notifications = [Notified::of(news()), Notified::of(flash)];
        let mut calls = Vec::new();
        for notification in &notifications {
            let like = notification.like();
            pair.client
                .router()
                .register_notification(Arc::clone(&like))
                .expect("a client notification registered");
            let mut request = super::request_of((None, Duration::from_secs(5)));
            request.procedure = like.procedure().clone();
            request.subscribes = Some(like);
            calls.push(
                pair.client
                    .router()
                    .request(Bytes::new(), request)
                    .expect("a subscribing call"),
            );
        }
        pair.settle().await;
        assert_eq!(entered.load(Ordering::SeqCst), 2);
        if advance_clock {
            pair.clock.advance(Duration::from_secs(1)).await;
        } else {
            pair.clock.wall_by(120_000);
        }
        released.cancel();
        pair.settle().await;
        for call in calls {
            assert_eq!(
                answered(call)
                    .await
                    .expect("the result comes first")
                    .payload,
                Bytes::from_static(b"subscribed")
            );
        }
        pair.settle().await;
        let sent = locked(&sent).clone();
        assert_eq!(sent.len(), 4);
        for call_id in [1, 3] {
            assert_eq!(
                sent.iter()
                    .filter(|header| header.call_id() == call_id)
                    .map(crate::envelope::EnvelopeHeader::kind)
                    .collect::<Vec<_>>(),
                [EnvelopeKind::Result, EnvelopeKind::Failure]
            );
        }
        for notification in notifications {
            assert_eq!(
                notification.dropped(),
                [Some(ProtocolCode::SESSION_REQUIRED.get().get())]
            );
        }
        assert_eq!(*locked(&withdrawn), Vec::new());
        assert_eq!(pair.client.router().credential(), Some(credential));
        assert_eq!(locked(&pair.client_reports).len(), 0);
        assert_eq!(locked(&pair.server_reports).len(), 0);
        pair.client.dispose().await;
        pair.server.dispose().await.expect("the server disposed");
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the twin plays both an abandoned ask and held keys, then an admission failure, a verifier failure and the waiting bound"
)]
#[tokio::test]
async fn tells_nothing_of_a_verifier_or_an_admission_that_fails_or_of_a_call_past_those_let_wait_for_an_issuer()
 {
    for prime_keys in [false, true] {
        let (mut key_set, asks) = key_set();
        key_set.maximum_waiting_calls = Some(1);
        let served = Served::new(&RouterServerOptions {
            credentials: Some(Credentials {
                audience: Some(AUDIENCE.to_owned()),
                key_set: Some(key_set),
                verify: Some(Arc::new(|_, _| {
                    Box::pin(async { Err(std::io::Error::other("the verifier fails").into()) })
                })),
                ..Credentials::default()
            }),
            ..RouterServerOptions::default()
        });
        served.transport.open(&first(), true);
        let ran = Arc::new(AtomicUsize::new(0));
        let mut resolver = handler(&ran);
        resolver.admit = Some(Arc::new(|request| {
            if request.header.call_id == 3 {
                Err(crate::errors::ResolverError::other(std::io::Error::other(
                    "the admission fails",
                )))
            } else {
                Ok(None)
            }
        }));
        served
            .router
            .register_resolver((&echo(), resolver))
            .expect("echo registered");
        let told = Arc::new(Mutex::new(Vec::new()));
        let telling = Arc::clone(&told);
        served.router.on_access_refused(Arc::new(move |refusal| {
            locked(&telling).push(refusal.clone());
        }));
        let prime_id = if prime_keys { 1 } else { 5 };
        let verifier_id = if prime_keys { 5 } else { 1 };
        let fail = || {
            served
                .transport
                .deliver(&super::server::request_of((3, &echo(), "")), &first());
            served.transport.deliver_message(
                &crate::router::types::TransportMessage {
                    data: crate::testing::scripted::bytes_of(&Envelope::Request {
                        header: RequestHeader {
                            credential: Some(Credential::Elsewhere),
                            ..request_header_of(verifier_id)
                        },
                        payload: Bytes::new(),
                    }),
                    credential: Some("Interop sub=ada".to_owned()),
                    ..crate::router::types::TransportMessage::default()
                },
                &first(),
            );
        };
        if !prime_keys {
            fail();
        }
        served.transport.deliver(&request(prime_id), &first());
        served.settle().await;
        assert_eq!(locked(&asks).len(), 1);
        if !prime_keys {
            served.transport.deliver(&cancel_of(prime_id), &first());
            served.settle().await;
        }
        if prime_keys {
            release(&asks);
        } else {
            release_keys(&asks, &[]);
        }
        served.settle().await;
        if prime_keys {
            fail();
        }
        for call_id in [7, 9] {
            served.transport.deliver(
                &Envelope::Request {
                    header: RequestHeader {
                        credential: Some(Credential::Jwt(Bytes::from(jwt_with_kid(
                            &json!({}),
                            "second",
                        )))),
                        ..request_header_of(call_id)
                    },
                    payload: Bytes::new(),
                },
                &first(),
            );
            served.settle().await;
        }
        let mut sent = served.sent_since();
        sent.sort();
        let expected = if prime_keys {
            vec![
                "first result 1 grace",
                "first failure 3 PROCEDURE_FAILED",
                "first failure 5 PROCEDURE_FAILED",
                "first failure 9 CAPACITY_EXCEEDED",
            ]
        } else {
            vec![
                "first failure 1 PROCEDURE_FAILED",
                "first failure 3 PROCEDURE_FAILED",
                "first failure 9 CAPACITY_EXCEEDED",
            ]
        };
        let mut expected = expected;
        expected.sort_unstable();
        assert_eq!(sent, expected);
        assert_eq!(
            served.reported(),
            ["the admission fails first", "the verifier fails first"]
        );
        assert_eq!(locked(&told).len(), 0);
        assert_eq!(
            locked(&asks).len(),
            0,
            "no ask before the issuer's minute ends"
        );
        assert_eq!(ran.load(Ordering::SeqCst), usize::from(prime_keys));
        served.router.dispose().await;
    }
}

#[tokio::test]
async fn answers_nothing_to_a_call_cancelled_while_it_waits_on_its_key_set_whose_ask_goes_on_for_the_others()
 {
    let (key_set, asks) = key_set();
    let ran = Arc::new(AtomicUsize::new(0));
    let served = serving(key_set, &ran);
    served.transport.deliver(&request(1), &first());
    served.transport.deliver(&request(3), &first());
    served.settle().await;
    assert_eq!(locked(&asks).len(), 1);
    served.transport.deliver(&cancel_of(1), &first());
    served.settle().await;
    release(&asks);
    served.settle().await;
    assert_eq!(served.sent_since(), ["first result 3 grace"]);
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    assert_eq!(locked(&asks).len(), 0, "no second ask");
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn dispatches_nothing_and_runs_no_resolver_for_a_jwt_call_that_waits_on_its_key_set_as_the_router_is_disposed()
 {
    let (key_set, asks) = key_set();
    let ran = Arc::new(AtomicUsize::new(0));
    let live_ran = Arc::new(AtomicUsize::new(0));
    let served = serving(key_set.clone(), &ran);
    let live = serving(key_set, &live_ran);
    served.transport.deliver(&request(1), &first());
    live.transport.deliver(&request(1), &first());
    served.settle().await;
    live.settle().await;
    assert_eq!(locked(&asks).len(), 2);
    served.router.dispose().await;
    release(&asks);
    served.settle().await;
    live.settle().await;
    assert_eq!(live.sent_since(), ["first result 1 grace"]);
    assert_eq!(live_ran.load(Ordering::SeqCst), 1);
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!(served.sent_since(), Vec::<String>::new());
    assert_eq!(served.reported(), Vec::<String>::new());
    assert_eq!(live.reported(), Vec::<String>::new());
    live.router.dispose().await;
}

#[tokio::test]
async fn answers_session_required_from_the_admission_of_a_resolver_registered_on_it_access_denied_to_a_call_that_presented_a_jwt_that_holds_whose_client_keeps_its_default_and_session_required_to_one_that_presented_none()
 {
    let credential = RequestCredential::Jwt(jwt());
    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            server: Some(crate::server::ServerOptions {
                credentials: Some(Credentials {
                    audience: Some(AUDIENCE.to_owned()),
                    keys: vec![JwtKey {
                        algorithm: JwtAlgorithm::Hs256,
                        issuer: ISSUER.to_owned(),
                        jwk: jwk(),
                    }],
                    ..Credentials::default()
                }),
                ..crate::server::ServerOptions::default()
            }),
            client: Some(crate::client::ClientOptions {
                credential: Some(credential.clone()),
                ..crate::client::ClientOptions::default()
            }),
        },
    )
    .await
    .expect("a connected pair");
    pair.server
        .router()
        .register_resolver((
            &echo(),
            Handler {
                resolve: Arc::new(|_| {
                    Box::pin(async { panic!("a refused call reaches no resolver") })
                }),
                admit: Some(Arc::new(|_| {
                    Ok(Some(crate::router::core::AdmissionRefusal {
                        failure: Failure::protocol(
                            ProtocolCode::SESSION_REQUIRED,
                            RouterSide::Server,
                        )
                        .saying("sign in first"),
                        by: None,
                    }))
                })),
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("a raw resolver registered");
    let withdrawn = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&withdrawn);
    pair.client
        .router()
        .on_credential_withdrawn(Arc::new(move |scheme| locked(&hearing).push(scheme)));
    for (presented, expected) in [
        (None, ProtocolCode::ACCESS_DENIED),
        (
            Some(RequestCredential::None),
            ProtocolCode::SESSION_REQUIRED,
        ),
    ] {
        let mut request = super::request_of((None, super::TIMEOUT));
        request.options.credential = presented;
        let call = pair
            .client
            .router()
            .request(Bytes::new(), request)
            .expect("a request");
        pair.settle().await;
        let error = answered(call).await.expect_err("the admission refuses");
        assert!(
            matches!(error, CallError::Failure(failure) if failure.code() == expected.get() && failure.detail() == "sign in first")
        );
    }
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(pair.client.router().credential(), Some(credential));
    assert_eq!(locked(&pair.server_reports).len(), 0);
    assert_eq!(locked(&pair.client_reports).len(), 0);
}

#[expect(
    clippy::too_many_lines,
    reason = "the issuer twin checks two identifier kinds, two connections and an unaffected issuer and scheme"
)]
#[tokio::test]
async fn ends_every_credentials_session_of_an_issuer_by_that_issuer_on_every_connection_its_sids_and_its_subs_alike_and_nothing_of_another_issuers_nor_an_elsewheres_whose_id_is_that_issuer_an_issuer_none_names_ends_nothing()
 {
    use super::server::{header_of, news, second};
    use crate::credentials::ElsewhereSession;
    use crate::router::types::{SessionIdentifier, TransportMessage};

    let other = "https://other.example";
    let served = Served::new(&RouterServerOptions {
        credentials: Some(Credentials {
            audience: Some(AUDIENCE.to_owned()),
            keys: [ISSUER, other]
                .into_iter()
                .map(|issuer| JwtKey {
                    algorithm: JwtAlgorithm::Hs256,
                    issuer: issuer.to_owned(),
                    jwk: jwk(),
                })
                .collect(),
            verify: Some(Arc::new(|carried, _| {
                Box::pin(async move {
                    Ok(Some(ElsewhereSession {
                        id: carried.clone(),
                        data: Some(json!(carried)),
                        end: None,
                    }))
                })
            })),
            ..Credentials::default()
        }),
        ..RouterServerOptions::default()
    });
    for handle in [first(), second()] {
        served.transport.open(&handle, true);
    }
    served
        .router
        .register_resolver((
            &news(),
            Handler {
                resolve: Arc::new(|props| {
                    Box::pin(async move {
                        props
                            .answerer
                            .respond(RouterAnswer::Result(Bytes::from_static(b"subscribed")))
                            .await
                            .map_err(crate::errors::ResolverError::other)
                    })
                }),
                admit: None,
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: true,
            },
        ))
        .expect("news registered");
    let subscribe = |(call_id, handle, credential, carried): (u32, _, _, Option<&str>)| {
        served.transport.deliver_message(
            &TransportMessage {
                data: crate::testing::scripted::bytes_of(&Envelope::Request {
                    header: RequestHeader {
                        opens_subscription: true,
                        credential: Some(credential),
                        ..header_of((call_id, &news()))
                    },
                    payload: Bytes::new(),
                }),
                credential: carried.map(str::to_owned),
                ..TransportMessage::default()
            },
            &handle,
        );
    };
    for (id, handle, claims) in [
        (1, first(), json!({})),
        (3, first(), json!({"sid":"one"})),
        (5, first(), json!({"iss":other})),
        (1, second(), json!({"sub":"carol"})),
    ] {
        subscribe((
            id,
            handle,
            Credential::Jwt(Bytes::from(jwt_of(&claims))),
            None,
        ));
    }
    subscribe((7, first(), Credential::Elsewhere, Some(ISSUER)));
    served.settle().await;
    let mut sent = served.sent_since();
    sent.sort();
    assert_eq!(
        sent,
        [
            "first result 1 subscribed",
            "first result 3 subscribed",
            "first result 5 subscribed",
            "first result 7 subscribed",
            "second result 1 subscribed"
        ]
    );
    served.router.end_sessions_of(ISSUER.to_uppercase()).await;
    assert_eq!(served.sent_since(), Vec::<String>::new());
    for issuer in [ISSUER, ISSUER, "https://unnamed.example"] {
        served.router.end_sessions_of(issuer.to_owned()).await;
    }
    served.settle().await;
    let mut sent = served.sent_since();
    sent.sort();
    assert_eq!(
        sent,
        [
            "first failure 1 SESSION_REQUIRED",
            "first failure 3 SESSION_REQUIRED",
            "second failure 1 SESSION_REQUIRED"
        ]
    );
    served
        .router
        .owner()
        .run(move |state| {
            let mut subscriptions = state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|call| (call.connection_handle, call.call_id, call.identifier))
                .collect::<Vec<_>>();
            subscriptions.sort_by_key(|(_, call_id, _)| *call_id);
            assert_eq!(
                subscriptions,
                [
                    (
                        first(),
                        5,
                        Some(SessionIdentifier::JwtSub {
                            issuer: other.to_owned(),
                            sub: "grace".to_owned()
                        })
                    ),
                    (
                        first(),
                        7,
                        Some(SessionIdentifier::Elsewhere {
                            id: ISSUER.to_owned()
                        })
                    ),
                ]
            );
        })
        .await
        .expect("only the other issuer and scheme remain");
    subscribe((
        9,
        first(),
        Credential::Jwt(Bytes::from(jwt_of(&json!({"sid":"one"})))),
        None,
    ));
    served.settle().await;
    assert_eq!(served.sent_since(), ["first result 9 subscribed"]);
    served
        .router
        .owner()
        .run(|state| {
            let mut ids = state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|call| call.call_id)
                .collect::<Vec<_>>();
            ids.sort_unstable();
            assert_eq!(ids, [5, 7, 9]);
        })
        .await
        .expect("a still-valid credential opens its session again");
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
    assert_eq!(served.clock.dues(), Vec::<core::time::Duration>::new());
}
