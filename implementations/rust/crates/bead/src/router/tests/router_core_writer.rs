//! The writer's shared scenarios: session announcements as answers settle, and limits both ways.

use core::num::NonZeroU16;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::oneshot;

use super::token;
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, FailureRecord, NotificationHeader};
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{CallAddress, RouterAnswer, RouterLimitsOptions};
use crate::session_token::SessionToken;
use crate::testing::core_port::{Peer, completed, error_of, request_of, scripted_header};
use crate::transport::Sent;

fn call_of((call_id, handle): (u32, &str)) -> CallAddress {
    CallAddress {
        call_id,
        connection_handle: Arc::from(handle),
    }
}

fn empty() -> RouterAnswer {
    RouterAnswer::Result(Bytes::new())
}

fn denied() -> RouterAnswer {
    RouterAnswer::Failure(
        crate::failure::Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record(),
    )
}

fn small() -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    }
}

async fn token_of(peer: &Peer, current: Option<SessionToken>) {
    peer.owner
        .run(move |state| {
            if let Some(token) = current {
                state.tokens.insert(Arc::from("a"), token);
            } else {
                state.tokens.remove("a");
            }
        })
        .await
        .expect("the port lives");
}

async fn credentials_of(peer: &Peer) -> Vec<Option<Credential>> {
    peer.sent()
        .await
        .iter()
        .map(|(_, envelope)| match envelope {
            Envelope::Result { header, .. } => header.credential.clone(),
            Envelope::Failure { header, .. } => header.credential.clone(),
            other @ (Envelope::Request { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. }) => panic!("an answer expected: {other:?}"),
        })
        .collect()
}

// spec 13.4
#[tokio::test]
async fn announce_the_session_when_it_changes_and_only_then() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let other = SessionToken::new([2; 16]).expect("a token");
    for (index, current) in [Some(token()), Some(token()), Some(other), None, None]
        .into_iter()
        .enumerate()
    {
        token_of(&peer, current).await;
        let call_id = u32::try_from(index).expect("five answers") * 2 + 1;
        completed(peer.respond((
            if index % 2 == 0 { empty() } else { denied() },
            call_of((call_id, "a")),
        )))
        .await
        .expect("answered");
    }
    completed(peer.respond((empty(), call_of((1, "b")))))
        .await
        .expect("another connection answered");
    assert_eq!(
        credentials_of(&peer).await,
        [
            Some(Credential::Opaque(token())),
            None,
            Some(Credential::Opaque(other)),
            Some(Credential::None),
            None,
            None
        ]
    );
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| (envelope.kind(), envelope.call_id()))
            .collect::<Vec<_>>(),
        [
            (EnvelopeKind::Result, 1),
            (EnvelopeKind::Failure, 3),
            (EnvelopeKind::Result, 5),
            (EnvelopeKind::Failure, 7),
            (EnvelopeKind::Result, 9),
            (EnvelopeKind::Result, 1)
        ]
    );
}

// spec 13.4
#[tokio::test]
async fn announce_again_what_an_answer_that_did_not_go_out_announced() {
    for later in [false, true] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        token_of(&peer, Some(token())).await;
        peer.owner
            .run(move |state| {
                let error = error_of("gone");
                state.sending.push_back(if later {
                    Ok(Sent::Later(Box::pin(async { Err(error) })))
                } else {
                    Err(error)
                });
            })
            .await
            .expect("the send scripted");
        assert_eq!(
            completed(peer.respond((empty(), call_of((1, "a")))))
                .await
                .expect_err("the send fails")
                .to_string(),
            "gone"
        );
        completed(peer.respond((empty(), call_of((3, "a")))))
            .await
            .expect("answered");
        assert_eq!(
            credentials_of(&peer).await,
            [
                Some(Credential::Opaque(token())),
                Some(Credential::Opaque(token()))
            ]
        );
    }
}

// spec 13.4
#[tokio::test]
async fn keep_the_announcement_in_the_order_answers_were_written_whatever_order_they_settle_in() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let other = SessionToken::new([2; 16]).expect("a token");
    let (first, first_send) = oneshot::channel();
    let (second, second_send) = oneshot::channel();
    peer.owner
        .run(move |state| {
            state
                .sending
                .extend([first_send, second_send].map(|receive| {
                    Ok(Sent::Later(Box::pin(async {
                        receive.await.expect("the send released")
                    })))
                }));
        })
        .await
        .expect("sends held");
    token_of(&peer, Some(token())).await;
    let first_answer = peer.respond((empty(), call_of((1, "a"))));
    peer.settle().await;
    token_of(&peer, Some(other)).await;
    let second_answer = peer.respond((empty(), call_of((3, "a"))));
    peer.settle().await;
    second.send(Ok(())).expect("second send released");
    completed(second_answer).await.expect("second answered");
    first
        .send(Err(error_of("gone")))
        .expect("first send released");
    assert_eq!(
        completed(first_answer)
            .await
            .expect_err("first fails")
            .to_string(),
        "gone"
    );
    completed(peer.respond((empty(), call_of((5, "a")))))
        .await
        .expect("answered");
    assert_eq!(
        credentials_of(&peer).await,
        [
            Some(Credential::Opaque(token())),
            Some(Credential::Opaque(other)),
            None
        ]
    );
}

// spec 13.4
#[tokio::test]
async fn forget_the_announcement_with_the_connection_even_with_an_answer_in_flight() {
    for fails in [false, true] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        let (release, receive) = oneshot::channel();
        token_of(&peer, Some(token())).await;
        peer.owner
            .run(move |state| {
                state.sending.push_back(Ok(Sent::Later(Box::pin(async {
                    receive.await.expect("the send released")
                }))));
            })
            .await
            .expect("send held");
        let in_flight = peer.respond((empty(), call_of((1, "a"))));
        peer.settle().await;
        peer.owner
            .run(|state| {
                router_core::reject_pending(state, ("a closed", Some(&Arc::from("a"))));
            })
            .await
            .expect("connection closed");
        release
            .send(if fails { Err(error_of("gone")) } else { Ok(()) })
            .expect("send released");
        assert_eq!(completed(in_flight).await.is_err(), fails);
        completed(peer.respond((empty(), call_of((3, "a")))))
            .await
            .expect("answered");
        assert_eq!(
            credentials_of(&peer).await,
            [
                Some(Credential::Opaque(token())),
                Some(Credential::Opaque(token()))
            ]
        );
    }
}

// spec 12.2
#[tokio::test]
async fn refuse_a_payload_past_its_own_limit_and_an_envelope_past_its_own() {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            maximum_payload_bytes: Some(8),
            ..small()
        },
    );
    let request = peer.request((Bytes::from(vec![0; 9]), request_of("a")));
    let notification = peer.send((
        Envelope::Notification {
            header: NotificationHeader { call_id: 2 },
            payload: Bytes::from(vec![0; 9]),
        },
        Arc::from("a"),
    ));
    for outcome in [
        request.await.expect("request replies").map(|_| ()),
        completed(notification).await,
    ] {
        assert!(
            matches!(outcome, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "a payload is 8 bytes at most, not 9")
        );
    }
    peer.receive((
        Envelope::Request {
            header: scripted_header(1),
            payload: Bytes::from(vec![0; 53]),
        },
        Arc::from("a"),
    ));
    peer.settle().await;
    let sent = peer.sent().await;
    assert_eq!(sent.len(), 1);
    assert!(
        matches!(&sent[0].1, Envelope::Failure { header, failure } if header.call_id == 1 && failure.code == ProtocolCode::ENVELOPE_TOO_LARGE.get())
    );
}

// spec 9.2, 12.2
#[tokio::test]
async fn cut_a_failures_detail_to_its_envelopes_room_and_to_its_own_limit_both_ways() {
    let record = FailureRecord {
        code: NonZeroU16::new(7).expect("an application code"),
        scope: FailureScope::Application,
        detail: "x".repeat(100),
        relays: 0,
    };
    for (limits, expected) in [
        (small(), 32),
        (
            RouterLimitsOptions {
                maximum_detail_bytes: Some(10),
                ..RouterLimitsOptions::default()
            },
            10,
        ),
    ] {
        let peer = Peer::new(RouterSide::Server, &limits);
        completed(peer.respond((RouterAnswer::Failure(record.clone()), call_of((1, "a")))))
            .await
            .expect("failure answered");
        let sent = peer.sent().await;
        assert!(
            matches!(&sent[0].1, Envelope::Failure { failure, .. } if failure.detail == "x".repeat(expected))
        );
    }
    for (side, bound, call_id) in [(RouterSide::Server, 4, 2), (RouterSide::Client, 10, 1)] {
        let peer = Peer::new(
            side,
            &RouterLimitsOptions {
                maximum_detail_bytes: Some(bound),
                ..RouterLimitsOptions::default()
            },
        );
        let asked = peer.request((Bytes::new(), request_of("a")));
        let envelope = if side == RouterSide::Server {
            Envelope::Failure {
                header: crate::envelope::FailureHeader {
                    call_id,
                    credential: None,
                },
                failure: FailureRecord {
                    detail: "abcdefgh".to_owned(),
                    ..record.clone()
                },
            }
        } else {
            Envelope::Failure {
                header: crate::envelope::FailureHeader {
                    call_id,
                    credential: None,
                },
                failure: record.clone(),
            }
        };
        peer.receive((envelope, Arc::from("a")));
        let error = completed(asked).await.expect_err("peer's failure");
        let expected = if side == RouterSide::Server {
            "abcd".to_owned()
        } else {
            "x".repeat(10)
        };
        assert!(matches!(error, CallError::Failure(failure) if failure.detail() == expected));
    }
}

// spec 12.2
#[tokio::test]
async fn refuse_a_notification_too_large_for_one_envelope_and_send_one_that_fits() {
    let peer = Peer::new(RouterSide::Server, &small());
    for call_id in [1, 2] {
        let notification = |length| Envelope::Notification {
            header: NotificationHeader { call_id },
            payload: Bytes::from(vec![0; length]),
        };
        let error = completed(peer.send((notification(57), Arc::from("a"))))
            .await
            .expect_err("one byte too large");
        assert!(
            matches!(error, CallError::Failure(failure) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "an envelope is 64 bytes at most, not 65")
        );
        completed(peer.send((notification(56), Arc::from("a"))))
            .await
            .expect("fits");
    }
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| (envelope.kind(), envelope.call_id()))
            .collect::<Vec<_>>(),
        [
            (EnvelopeKind::Notification, 1),
            (EnvelopeKind::Notification, 2)
        ]
    );
}
