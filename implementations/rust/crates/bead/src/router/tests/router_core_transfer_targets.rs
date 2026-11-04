//! A transferred result requires its dispatched request and cannot open a subscription.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::router_core_transfer_edges::{limits, serving};
use crate::constants::ProtocolCode;
use crate::envelope::{Envelope, RequestHeader, ResultHeader};
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::RouterAnswer;
use crate::testing::core_port::scripted_header;

#[tokio::test]
async fn refuse_a_transfer_for_a_subscriptions_result_before_the_side_hears_of_it() {
    for (request_payload, too_large, boundary) in [
        (Bytes::new(), Bytes::from(vec![0; 37]), true),
        (
            Bytes::from_static(&[1]),
            super::router_core_transfer_refusals::pattern((100, false)),
            false,
        ),
        (
            Bytes::from_static(&[1]),
            super::router_core_transfer_refusals::pattern((100, true)),
            false,
        ),
    ] {
        let (peer, handed) = serving(true, &limits()).await;
        peer.receive((
            Envelope::Request {
                header: RequestHeader {
                    opens_subscription: true,
                    ..scripted_header(1)
                },
                payload: request_payload,
            },
            Arc::from("a"),
        ));
        peer.settle().await;
        let answerer = Arc::clone(&locked(&handed)[0].answerer);
        let error = answerer
            .respond(RouterAnswer::Result(too_large.clone()))
            .await
            .expect_err("a subscription's result goes in one envelope");
        let CallError::Failure(failure) = error else {
            panic!("a payload failure");
        };
        assert_eq!(failure.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
        assert_eq!(
            failure.detail(),
            "a subscription's result goes in one envelope, of 64 bytes at most"
        );
        peer.owner
            .run(|state| {
                assert!(state.before.is_empty());
                assert_eq!(state.sent, []);
                assert!(state.reports.is_empty());
            })
            .await
            .expect("the oversized subscription result never reaches the side");
        if boundary {
            answerer
                .respond(RouterAnswer::Result(Bytes::from(vec![0; 36])))
                .await
                .expect("the boundary goes in one envelope");
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
                .run(|state| {
                    assert_eq!(state.before.len(), 1);
                    assert!(state.reports.is_empty());
                })
                .await
                .expect("only the whole result reaches the side");
        }
        peer.owner
            .run(router_core::dispose)
            .await
            .expect("disposed");
    }
}
