//! Incoming subscriptions are admitted before connection policy; answers name only their call.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::router_core_requester::quiet;
use super::router_core_sessions::{failures, handler, receive, serving};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{Envelope, FailureHeader, FailureRecord, RequestHeader, ResultHeader};
use crate::failure::Failure;
use crate::router::core::{self as router_core, AdmissionRefusal};
use crate::router::types::RouterAnswer;
use crate::testing::core_port::scripted_header;
use crate::testing::pair::echo;

// spec 9.2
#[tokio::test]
async fn refuses_a_request_that_opens_a_subscription_on_a_connection_that_carries_one_way_once_admitted_and_asks_nothing_of_another()
 {
    let (peer, handed, admitted) = serving(None).await;
    let mut guarded = handler((&handed, &admitted));
    guarded.admit = Some(Arc::new(|_| {
        Ok(Some(AdmissionRefusal {
            failure: Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server),
            by: None,
        }))
    }));
    peer.owner
        .run(move |state| {
            state.one_way.push(Arc::from("a"));
            let mut procedure = echo();
            procedure.procedure_id = 2;
            procedure.procedure_name = "guarded".to_owned();
            router_core::register_resolver(&state.core.resolvers, (&procedure, guarded, None))
                .expect("guarded registered");
            for (call_id, procedure_id, opens_subscription, handle, total) in [
                (1, 1, true, "a", None),
                (3, 2, true, "a", None),
                (5, 1, false, "a", None),
                (7, 1, true, "b", None),
                (9, 1, true, "a", Some(400)),
            ] {
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: RequestHeader {
                                procedure_id,
                                opens_subscription,
                                total,
                                ..scripted_header(call_id)
                            },
                            payload: if total.is_some() {
                                Bytes::from_static(&[0; 4])
                            } else {
                                Bytes::new()
                            },
                        },
                        handle,
                        None,
                    ),
                );
            }
        })
        .await
        .expect("subscription requests received");
    peer.settle().await;
    assert_eq!(
        failures(&peer).await,
        [
            (
                1,
                ProtocolCode::SUBSCRIPTION_UNSUPPORTED.get().get(),
                "this connection carries no notification back".to_owned()
            ),
            (3, ProtocolCode::ACCESS_DENIED.get().get(), String::new()),
            (
                9,
                ProtocolCode::SUBSCRIPTION_UNSUPPORTED.get().get(),
                "this connection carries no notification back".to_owned()
            ),
        ]
    );
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|r| r.header.call_id)
            .collect::<Vec<_>>(),
        [5, 7]
    );
    peer.owner
        .run(|state| {
            assert_eq!(
                locked(&state.two_way_asked)
                    .iter()
                    .map(AsRef::as_ref)
                    .collect::<Vec<&str>>(),
                ["a", "b", "a"]
            );
            assert_eq!(
                state
                    .core
                    .receivings
                    .gauges()
                    .counts
                    .get("receivingTransfers"),
                Some(&0)
            );
        })
        .await
        .expect("only admitted subscriptions ask their connection, with no transfer credit");
    quiet(&peer).await;
}

// spec 9.0
#[tokio::test]
async fn its_answers_name_their_call_alone_a_result_with_its_payload_a_failure_with_its_record() {
    let (peer, handed, admitted) = serving(None).await;
    let forwarding = handler((&handed, &admitted));
    peer.owner
        .run(move |state| {
            state.destination = Some(Arc::new(forwarding));
            for (handle, destination_id) in [("b", None), ("a", Some(3))] {
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: RequestHeader {
                                destination_id,
                                ..scripted_header(77)
                            },
                            payload: Bytes::new(),
                        },
                        handle,
                        None,
                    ),
                );
            }
        })
        .await
        .expect("the two requests dispatched");
    peer.settle().await;
    let answerers = locked(&handed)
        .iter()
        .map(|r| Arc::clone(&r.answerer))
        .collect::<Vec<_>>();
    answerers[0]
        .respond(RouterAnswer::Result(Bytes::from_static(&[4])))
        .await
        .expect("result sent");
    let failure = FailureRecord {
        code: core::num::NonZeroU16::new(12).expect("12 is a code"),
        detail: "why".to_owned(),
        relays: 0,
        scope: FailureScope::Application,
    };
    answerers[1]
        .respond(RouterAnswer::Failure(failure.clone()))
        .await
        .expect("failure sent");
    assert_eq!(
        peer.sent().await,
        [
            (
                Arc::from("b"),
                Envelope::Result {
                    header: ResultHeader {
                        call_id: 77,
                        total: None,
                        credential: None
                    },
                    payload: Bytes::from_static(&[4])
                }
            ),
            (
                Arc::from("a"),
                Envelope::Failure {
                    header: FailureHeader {
                        call_id: 77,
                        credential: None
                    },
                    failure
                }
            ),
        ]
    );
    quiet(&peer).await;
}
