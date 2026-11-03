//! ELSEWHERE credentials through the server facade: exact input, turns, cancellation and secrecy.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::server::{Served, first, second};
use super::{cancel_of, locked, request_header_of, token};
use crate::NotificationResolverDependencies;
use crate::constants::{CredentialScheme, ProtocolCode};
use crate::credentials::{Credentials, ElsewhereSession, ElsewhereVerdict, ElsewhereVerifier};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::router::core::Handler;
use crate::router::server::RouterServerOptions;
use crate::router::types::{ConnectionHandle, RouterAnswer, TransportMessage};
use crate::testing::pair::echo;
use crate::testing::scripted::bytes_of;

fn session(carried: String) -> ElsewhereSession {
    ElsewhereSession {
        id: carried.clone(),
        data: Some(serde_json::Value::String(carried)),
        end: None,
    }
}

#[tokio::test]
async fn moves_the_end_of_a_session_kept_by_a_call_whose_credential_renews_it_and_by_none_that_settles_once_its_call_ended()
 {
    use core::time::Duration;
    use std::collections::BTreeMap;

    use super::server::{news, subscribing_of};
    use crate::managers::service::{RequestResolverDependencies, Response};
    use crate::payloads::TextCodec;

    let settling = Arc::new(Mutex::new(BTreeMap::new()));
    let asking = Arc::clone(&settling);
    let served = verifying(Arc::new(move |carried, _| {
        let (reply, answer) = oneshot::channel();
        locked(&asking).insert(carried, reply);
        Box::pin(async move { answer.await.expect("the test settles each resolution") })
    }));
    served
        .services
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("news resolved")
        .on(Arc::new(|_, response: Response<TextCodec>| {
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(crate::errors::ResolverError::other)?;
                response.result("subscribed".to_owned()).await
            })
        }))
        .expect("news registered");
    let Envelope::Request {
        mut header,
        payload,
    } = subscribing_of(1)
    else {
        panic!("a subscription")
    };
    header.credential = Some(Credential::Elsewhere);
    served.transport.deliver_message(
        &TransportMessage {
            data: bytes_of(&Envelope::Request { header, payload }),
            credential: Some("kept".to_owned()),
            ..TransportMessage::default()
        },
        &first(),
    );
    deliver(
        &served,
        (3, &first(), Some(Credential::Elsewhere), Some("late")),
    );
    deliver(
        &served,
        (5, &first(), Some(Credential::Elsewhere), Some("renewed")),
    );
    served.settle().await;
    let settle = |(carried, after): (&str, i64)| {
        locked(&settling)
            .remove(carried)
            .expect("a resolution waits")
            .send(Ok(Some(ElsewhereSession {
                id: "ada".to_owned(),
                data: Some(serde_json::json!("ada")),
                end: serde_json::Value::from(1_767_225_600_000 + after).as_f64(),
            })))
            .expect("the resolving call waits on its verdict");
    };
    settle(("kept", 60_000));
    served.settle().await;
    assert_eq!(served.clock.dues(), [Duration::from_secs(60)]);
    served.transport.deliver(&cancel_of(3), &first());
    served.settle().await;
    settle(("late", 120_000));
    served.settle().await;
    assert_eq!(served.clock.dues(), [Duration::from_secs(60)]);
    settle(("renewed", 90_000));
    served.settle().await;
    assert_eq!(served.clock.dues(), [Duration::from_secs(90)]);
    assert_eq!(
        served.sent_since(),
        ["first result 1 subscribed", "first result 5 \"ada\""]
    );
    served.clock.advance(Duration::from_millis(89_999)).await;
    assert_eq!(served.sent_since(), Vec::<String>::new());
    served.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(served.sent_since(), ["first failure 1 SESSION_REQUIRED"]);
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
    assert_eq!(served.clock.dues(), Vec::<Duration>::new());
}

fn verifying(verify: ElsewhereVerifier) -> Served {
    let served = Served::new(&RouterServerOptions {
        credentials: Some(Credentials {
            verify: Some(verify),
            ..Credentials::default()
        }),
        ..RouterServerOptions::default()
    });
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .router
        .register_resolver((
            &echo(),
            Handler {
                resolve: Arc::new(|props| {
                    let payload = props
                        .session
                        .as_ref()
                        .and_then(|session| session.data.as_ref())
                        .map_or_else(|| "none".to_owned(), ToString::to_string);
                    Box::pin(async move {
                        props
                            .answerer
                            .respond(RouterAnswer::Result(Bytes::from(payload)))
                            .await
                            .map_err(crate::errors::ResolverError::other)
                    })
                }),
                admit: None,
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("echo registered");
    served
}

fn deliver(
    served: &Served,
    (call_id, handle, credential, carried): (
        u32,
        &ConnectionHandle,
        Option<Credential>,
        Option<&str>,
    ),
) {
    served.transport.deliver_message(
        &TransportMessage {
            data: bytes_of(&Envelope::Request {
                header: RequestHeader {
                    credential,
                    ..request_header_of(call_id)
                },
                payload: Bytes::new(),
            }),
            credential: carried.map(str::to_owned),
            ..TransportMessage::default()
        },
        handle,
    );
}

#[tokio::test]
async fn asks_verify_once_per_request_with_exactly_what_its_transport_carried_and_a_live_signal_never_for_none_opaque_or_an_elsewhere_that_carried_nothing()
 {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = Arc::clone(&asked);
    let served = verifying(Arc::new(move |carried, signal| {
        locked(&asking).push((carried.clone(), signal.is_cancelled()));
        Box::pin(async move { Ok(Some(session(carried))) })
    }));
    let carried = " \tInterop sub=ada";
    deliver(
        &served,
        (1, &first(), Some(Credential::Elsewhere), Some(carried)),
    );
    deliver(&served, (3, &first(), None, Some(carried)));
    deliver(
        &served,
        (
            5,
            &first(),
            Some(Credential::Opaque(token())),
            Some(carried),
        ),
    );
    deliver(
        &served,
        (
            9,
            &first(),
            Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            Some(carried),
        ),
    );
    deliver(&served, (7, &first(), Some(Credential::Elsewhere), None));
    served.settle().await;
    let failures = served
        .transport
        .envelopes(&first())
        .into_iter()
        .filter_map(|envelope| match envelope {
            Envelope::Failure { header, failure } => {
                Some((header.call_id, failure.code, failure.detail))
            }
            Envelope::Request { .. }
            | Envelope::Result { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        })
        .collect::<Vec<_>>();
    let answers = served.sent_since();
    let at = |call_id: &str| {
        answers
            .iter()
            .position(|answer| answer.split(' ').nth(2) == Some(call_id))
            .expect("an answer on the call")
    };
    let mut sorted = answers.clone();
    sorted.sort();
    assert_eq!(*locked(&asked), [(carried.to_owned(), false)]);
    assert_eq!(
        sorted,
        [
            "first failure 5 SESSION_REQUIRED".to_owned(),
            "first failure 7 SESSION_REQUIRED".to_owned(),
            "first failure 9 CREDENTIAL_UNSUPPORTED".to_owned(),
            format!(
                "first result 1 {}",
                serde_json::Value::String(carried.to_owned())
            ),
            "first result 3 none".to_owned(),
        ]
    );
    // * the refusals in the turns their requests came, in their order, and a later request's
    // refusal before the answer a resolver gives at once, which it is handed in a later turn
    // (decision 0010); 3 and 7 keep no order between them
    assert!(at("5") < at("9"));
    assert!(at("9") < at("3"));
    assert!(at("9") < at("7"));
    // 3 before 1 and 7 before 1 are what this side's turns give, not an order the spec states
    assert!(at("3") < at("1"));
    assert!(at("7") < at("1"));
    assert_eq!(
        failures,
        [
            (
                5,
                ProtocolCode::SESSION_REQUIRED.get(),
                "the credential does not hold".to_owned()
            ),
            (
                9,
                ProtocolCode::CREDENTIAL_UNSUPPORTED.get(),
                "OPAQUE, ELSEWHERE".to_owned()
            ),
            (
                7,
                ProtocolCode::SESSION_REQUIRED.get(),
                "no credential came".to_owned()
            ),
        ]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn resolves_an_elsewhere_whose_verifier_settles_at_once_in_a_later_turn_answering_a_request_presenting_none_delivered_behind_it_first()
 {
    let served = verifying(Arc::new(|carried, _| {
        Box::pin(async move { Ok(Some(session(carried))) })
    }));
    deliver(
        &served,
        (1, &first(), Some(Credential::Elsewhere), Some("ada")),
    );
    deliver(&served, (3, &first(), None, None));
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        ["first result 3 none", "first result 1 \"ada\""]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

type Pending = (CancellationToken, oneshot::Sender<ElsewhereVerdict>);

#[tokio::test]
async fn a_cancel_and_a_close_during_resolution_abort_the_signal_and_what_the_verifier_settles_to_after_is_dropped_in_silence()
 {
    let pending: Arc<Mutex<Vec<Pending>>> = Arc::default();
    let keeping = Arc::clone(&pending);
    let served = verifying(Arc::new(move |_, signal| {
        let (reply, answer) = oneshot::channel();
        locked(&keeping).push((signal, reply));
        Box::pin(async move { answer.await.expect("the test releases its verifier") })
    }));
    for (id, handle) in [(1, first()), (3, first()), (1, second())] {
        deliver(
            &served,
            (id, &handle, Some(Credential::Elsewhere), Some("ada")),
        );
    }
    served.settle().await;
    served.transport.deliver(&cancel_of(1), &first());
    deliver(&served, (1, &first(), None, None));
    served.transport.close_connection(&second());
    served.settle().await;
    assert_eq!(
        locked(&pending)
            .iter()
            .map(|(signal, _)| signal.is_cancelled())
            .collect::<Vec<_>>(),
        [true, false, true]
    );
    let mut pending = core::mem::take(&mut *locked(&pending)).into_iter();
    pending
        .next()
        .expect("cancelled")
        .1
        .send(Ok(Some(session("ada".to_owned()))))
        .expect("the verifier still waits");
    let other = pending.next().expect("still open").1;
    pending
        .next()
        .expect("closed")
        .1
        .send(Err(
            std::io::Error::other("a verifier that fails late").into()
        ))
        .expect("the verifier still waits");
    other.send(Ok(None)).expect("the verifier still waits");
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        ["first result 1 none", "first failure 3 SESSION_REQUIRED"]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn reports_and_traces_no_carried_value_of_an_elsewhere_only_its_scheme() {
    let served = verifying(Arc::new(|_, _| {
        Box::pin(async { Err(std::io::Error::other("this verifier fails, on purpose").into()) })
    }));
    let traced = Arc::new(Mutex::new(Vec::new()));
    let tracing = Arc::clone(&traced);
    served.router.on_debug(Arc::new(move |direction, envelope| {
        locked(&tracing).push((direction, envelope.clone()));
    }));
    let secret = "Interop sub=secret";
    deliver(
        &served,
        (1, &first(), Some(Credential::Elsewhere), Some(secret)),
    );
    deliver(
        &served,
        (
            3,
            &first(),
            Some(Credential::ToCome {
                scheme: CredentialScheme::new(9),
                bytes: Bytes::new(),
            }),
            Some(secret),
        ),
    );
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "first failure 3 CREDENTIAL_UNSUPPORTED",
            "first failure 1 PROCEDURE_FAILED"
        ]
    );
    assert_eq!(
        locked(&traced)
            .iter()
            .map(|(_, envelope)| envelope.credential_scheme)
            .collect::<Vec<_>>(),
        [
            Some(CredentialScheme::ELSEWHERE),
            Some(CredentialScheme::new(9)),
            None,
            None
        ]
    );
    let text = format!(
        "{:?} {:?} {:?}",
        locked(&traced),
        locked(&served.reports),
        served.transport.envelopes(&first())
    );
    assert!(
        !text.contains("secret"),
        "no carried value reaches an error, a trace or an envelope: {text}"
    );
    assert_eq!(served.reported(), ["this verifier fails, on purpose first"]);
}
