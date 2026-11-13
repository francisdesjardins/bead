//! A failed session announcement leaves no call id or partial announcement behind it.

use std::sync::Arc;

use bytes::Bytes;

use crate::constants::RouterSide;
use crate::envelope::Envelope;
use crate::errors::{CallError, ProgrammerError};
use crate::router::types::{CallAddress, RouterAnswer, RouterError, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, error_of, scripted_header};

#[tokio::test]
async fn lets_go_of_the_call_id_of_a_refusal_that_cannot_go_out_so_the_same_request_is_refused_again()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| {
            state.token = Some(Box::new(|handle| {
                assert_eq!(handle.as_ref(), "a");
                Err(error_of("no session"))
            }));
        })
        .await
        .expect("the provider fails");
    for _ in 0..2 {
        peer.receive((
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    service_id: 8,
                    ..scripted_header(5)
                },
                payload: Bytes::new(),
            },
            Arc::from("a"),
        ));
        peer.settle().await;
    }
    peer.owner
        .run(|state| {
            assert_eq!(
                state
                    .reports
                    .iter()
                    .map(|(handle, error)| (handle.as_ref(), error.to_string()))
                    .collect::<Vec<_>>(),
                [
                    ("a", "no session".to_owned()),
                    ("a", "no session".to_owned())
                ]
            );
            assert_eq!(state.sent, Vec::new());
            assert!(!state.core.answering.has(&CallAddress {
                call_id: 5,
                connection_handle: Arc::from("a")
            }));
        })
        .await
        .expect("both refusals fail in the provider, never as a duplicate call");
}

async fn missing_token_provider() {
    for source in [false, true] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        let message = if source {
            "no session to tell"
        } else {
            "no session"
        };
        let expected: Arc<dyn std::error::Error + Send + Sync> =
            Arc::new(ProgrammerError::new(message));
        let error = RouterError::Other(Arc::clone(&expected));
        peer.owner
            .run(move |state| {
                state.token = Some(Box::new(move |_| Err(error.clone())));
            })
            .await
            .expect("the provider fails");
        let call = || CallAddress {
            call_id: 1,
            connection_handle: Arc::from("a"),
        };
        let payload = if source {
            Bytes::from_static(&[1])
        } else {
            Bytes::new()
        };
        let returned = completed(peer.respond((RouterAnswer::Result(payload), call())))
            .await
            .expect_err("the answer cannot announce its session");
        assert_eq!(returned.to_string(), message);
        assert!(
            matches!(returned, CallError::Other(error) if Arc::ptr_eq(&error, &expected)),
            "the provider's error returns unchanged"
        );
        assert_eq!(peer.sent().await, Vec::new());
        peer.owner
            .run(|state| {
                state.token = None;
            })
            .await
            .expect("no provider");
        completed(peer.respond((RouterAnswer::Result(Bytes::new()), call())))
            .await
            .expect("a bare result");
        assert_eq!(
            peer.sent().await,
            [(Arc::from("a"), super::result_of(1, None))]
        );
    }
    super::router_core_port_defaults::assert_sessionless_answer().await;
}

#[tokio::test]
async fn fail_the_answer_whose_session_cannot_be_told_and_announce_nothing_without_a_way_to() {
    missing_token_provider().await;
}

#[tokio::test]
async fn fails_the_answer_whose_session_cannot_be_told_and_announces_nothing_without_a_way_to() {
    missing_token_provider().await;
}
