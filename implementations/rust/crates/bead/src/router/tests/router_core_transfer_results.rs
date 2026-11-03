//! A result's transfer boundary, its side's callback and its session's opening credential.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::router_core_requester::credit;
use super::router_core_sending_edges::asked;
use super::router_core_transfer_edges::{limits, serving};
use super::router_core_transfer_refusals::{pattern, reports};
use crate::constants::ProtocolCode;
use crate::envelope::{Credential, Envelope, ResultHeader};
use crate::errors::CallError;
use crate::router::types::RouterAnswer;
use crate::session_token::SessionToken;
use crate::testing::core_port::scripted_header;
use crate::testing::scripted;

#[tokio::test]
async fn a_subscriptions_result_stays_within_one_envelope_before_the_side_hears_of_it() {
    for (length, request_payload) in [(37, Bytes::new()), (100, Bytes::from_static(&[1]))] {
        let (peer, handed) = serving(false, &limits()).await;
        peer.receive((
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    opens_subscription: true,
                    ..scripted_header(1)
                },
                payload: request_payload,
            },
            Arc::from("a"),
        ));
        peer.settle().await;
        let answerer = Arc::clone(&locked(&handed)[0].answerer);
        let outcome = answerer
            .respond(RouterAnswer::Result(Bytes::from(vec![0; length])))
            .await;
        let Err(CallError::Failure(failure)) = outcome else {
            panic!("a subscription's transferred result is refused: {outcome:?}");
        };
        assert_eq!(failure.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
        assert_eq!(
            failure.detail(),
            "a subscription's result goes in one envelope, of 64 bytes at most"
        );
        peer.owner
            .run(|state| assert!(state.before.is_empty()))
            .await
            .expect("the side hears no refused answer");
        assert_eq!(peer.sent().await, []);
        if length == 37 {
            answerer
                .respond(RouterAnswer::Result(Bytes::from(vec![0; 36])))
                .await
                .expect("the boundary result goes in one envelope");
            assert_eq!(
                peer.sent().await,
                [(
                    Arc::from("a"),
                    Envelope::Result {
                        header: ResultHeader {
                            call_id: 1,
                            total: None,
                            credential: None
                        },
                        payload: Bytes::from(vec![0; 36]),
                    }
                )]
            );
            peer.owner
                .run(|state| assert_eq!(state.before.len(), 1))
                .await
                .expect("the side hears the accepted answer once");
        }
        assert_eq!(reports(&peer).await, []);
    }
}

#[tokio::test]
async fn announce_a_session_on_a_results_opening_which_leaves_room_for_it_within_its_envelope() {
    for dotnet in [false, true] {
        let (peer, handed) = serving(false, &limits()).await;
        let token = if dotnet {
            SessionToken::new([1; 16]).expect("a nonzero token")
        } else {
            super::token()
        };
        peer.owner
            .run(move |state| {
                state.tokens.insert(Arc::from("a"), token);
            })
            .await
            .expect("the session announced");
        let answerer = asked(
            &peer,
            (
                &handed,
                if dotnet {
                    Bytes::from_static(&[1])
                } else {
                    Bytes::new()
                },
            ),
        )
        .await;
        let payload = pattern((100, dotnet));
        let responding = answerer.respond(RouterAnswer::Result(payload));
        peer.settle().await;
        let sent = peer.sent().await;
        assert_eq!(sent.len(), 1);
        let Envelope::Result { header, .. } = &sent[0].1 else {
            panic!("a result opening");
        };
        assert_eq!(
            *header,
            ResultHeader {
                call_id: 1,
                total: Some(100),
                credential: Some(Credential::Opaque(token))
            }
        );
        assert_eq!(scripted::bytes_of(&sent[0].1).len(), 64);
        peer.receive((credit(1, 100), Arc::from("a")));
        responding.await.expect("the transferred result handed off");
        assert_eq!(
            peer.sent()
                .await
                .iter()
                .map(|(_, envelope)| scripted::bytes_of(envelope).len())
                .collect::<Vec<_>>(),
            [64, 64, 40]
        );
        peer.owner
            .run(|state| {
                assert!(state.reports.is_empty(), "{:?}", state.reports);
                assert_eq!(state.before.len(), 1);
            })
            .await
            .expect("one result and no report");
    }
}
