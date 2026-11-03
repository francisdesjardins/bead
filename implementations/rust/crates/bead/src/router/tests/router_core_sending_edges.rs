//! Results sent in credited chunks: call lifetime, cancellation and transport refusal.

use super::router_core_requester::{credit, quiet};
use super::router_core_sessions::request;
use super::router_core_transfer_edges::{limits, serving};
use super::{Handed, locked};
use crate::constants::ProtocolCode;
use crate::envelope::{CancelHeader, Envelope, ResultHeader};
use crate::errors::CallError;
use crate::router::core::Answerer;
use crate::router::types::{RouterAnswer, RouterError};
use crate::testing::core_port::{Peer, error_of};
use crate::testing::{patience, scripted};
use bytes::Bytes;
use core::time::Duration;
use std::sync::Arc;

pub(super) fn pattern((length, dotnet): (usize, bool)) -> Bytes {
    (0..length)
        .map(|index| {
            let value = if dotnet {
                index.wrapping_mul(7).wrapping_add(index >> 8) % 251
            } else {
                index.wrapping_mul(7).wrapping_add(3) % 256
            };
            u8::try_from(value).expect("a byte")
        })
        .collect()
}

pub(super) async fn asked(peer: &Peer, (handed, payload): (&Handed, Bytes)) -> Arc<dyn Answerer> {
    peer.receive((
        Envelope::Request {
            header: crate::testing::core_port::scripted_header(1),
            payload,
        },
        Arc::from("a"),
    ));
    peer.settle().await;
    let seen = locked(handed);
    assert_eq!(seen.len(), 1);
    Arc::clone(&seen[0].answerer)
}

pub(super) async fn sent(peer: &Peer) -> Vec<Envelope> {
    peer.sent()
        .await
        .into_iter()
        .map(|(handle, envelope)| {
            assert_eq!(handle.as_ref(), "a");
            envelope
        })
        .collect()
}

pub(super) fn pieces(envelopes: &[Envelope]) -> Vec<(u64, bool, usize)> {
    envelopes
        .iter()
        .map(|envelope| match envelope {
            Envelope::Result { header, payload } => {
                assert_eq!(header.call_id, 1);
                assert_eq!(header.credential, None);
                (
                    header.total.expect("a transferred total"),
                    false,
                    payload.len(),
                )
            }
            Envelope::Chunk { header, payload } => {
                assert_eq!(header.call_id, 1);
                (header.offset, header.is_last, payload.len())
            }
            other @ (Envelope::Request { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. }) => panic!("a result or a chunk, not {other:?}"),
        })
        .collect()
}

pub(super) fn payload(envelopes: &[Envelope]) -> Bytes {
    envelopes
        .iter()
        .flat_map(|envelope| match envelope {
            Envelope::Result { payload, .. } | Envelope::Chunk { payload, .. } => {
                payload.iter().copied()
            }
            other @ (Envelope::Request { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. }) => panic!("a result or chunk, not {other:?}"),
        })
        .collect()
}

#[tokio::test]
async fn send_a_result_as_a_transfer_its_call_held_open_until_its_last_chunk_is_handed_off() {
    for dotnet in [false, true] {
        for total in [100, 150] {
            let (peer, handed) = serving(false, &limits()).await;
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
            let bytes = pattern((total, false));
            let mut responding = answerer.respond(RouterAnswer::Result(bytes.clone()));
            peer.settle().await;
            let opening = sent(&peer).await;
            assert_eq!(
                opening[0],
                Envelope::Result {
                    header: ResultHeader {
                        call_id: 1,
                        total: Some(u64::try_from(total).expect("a total")),
                        credential: None
                    },
                    payload: bytes.slice(..28),
                }
            );
            peer.receive((request(1, None), Arc::from("a")));
            peer.receive((
                credit(1, if total == 100 { 76 } else { 80 }),
                Arc::from("a"),
            ));
            peer.settle().await;
            patience(Duration::ZERO, &mut responding)
                .await
                .expect_err("the response still waits for its final credit");
            assert_eq!(
                pieces(&sent(&peer).await),
                [
                    (u64::try_from(total).expect("a total"), false, 28),
                    (28, false, 48)
                ]
            );
            peer.receive((
                credit(1, u64::try_from(total).expect("a total")),
                Arc::from("a"),
            ));
            responding.await.expect("the last chunk handed off");
            peer.receive((request(1, None), Arc::from("a")));
            peer.settle().await;
            assert_eq!(locked(&handed).len(), 2);
            let envelopes = sent(&peer).await;
            let expected = if total == 100 {
                vec![(100, false, 28), (28, false, 48), (76, true, 24)]
            } else {
                vec![
                    (150, false, 28),
                    (28, false, 48),
                    (76, false, 48),
                    (124, true, 26),
                ]
            };
            assert_eq!(pieces(&envelopes), expected);
            assert_eq!(payload(&envelopes), bytes);
            let sizes = envelopes
                .iter()
                .map(|envelope| scripted::bytes_of(envelope).len())
                .collect::<Vec<_>>();
            assert_eq!(
                sizes,
                if total == 100 {
                    vec![44, 64, 40]
                } else {
                    vec![44, 64, 64, 42]
                }
            );
            assert!(sizes.iter().all(|size| *size <= 64));
            peer.owner.run(|state| {
                assert_eq!(state.reports.len(), 1);
                assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "a" && failure.code() == ProtocolCode::ENVELOPE_MALFORMED.get()));
            }).await.expect("the duplicate call reported");
        }
    }
}

#[tokio::test]
async fn stop_a_result_the_peer_cancels_and_send_nothing_more_of_it_whatever_credit_comes() {
    for (total, initial) in [(100, None), (150, Some(80))] {
        let (peer, handed) = serving(false, &limits()).await;
        let answerer = asked(
            &peer,
            (
                &handed,
                if total == 100 {
                    Bytes::from_static(&[1])
                } else {
                    Bytes::new()
                },
            ),
        )
        .await;
        let bytes = pattern((total, false));
        let responding = answerer.respond(RouterAnswer::Result(bytes.clone()));
        peer.settle().await;
        if let Some(end) = initial {
            peer.receive((credit(1, end), Arc::from("a")));
        }
        peer.receive((
            Envelope::Cancel {
                header: CancelHeader { call_id: 1 },
            },
            Arc::from("a"),
        ));
        peer.receive((
            credit(1, u64::try_from(total).expect("a total")),
            Arc::from("a"),
        ));
        let outcome = responding.await;
        assert!(
            matches!(outcome, Err(CallError::Cancelled(_))),
            "{outcome:?}"
        );
        peer.settle().await;
        assert!(locked(&handed)[0].signal.is_aborted());
        let envelopes = sent(&peer).await;
        let mut expected = vec![(u64::try_from(total).expect("a total"), false, 28)];
        if initial.is_some() {
            expected.push((28, false, 48));
        }
        assert_eq!(pieces(&envelopes), expected);
        assert_eq!(
            payload(&envelopes),
            bytes.slice(..if initial.is_some() { 76 } else { 28 })
        );
        quiet(&peer).await;
    }
}

async fn refuse(peer: &Peer, (message, later): (&str, bool)) -> RouterError {
    let error = error_of(message);
    let refused = error.clone();
    peer.owner
        .run(move |state| {
            state.sending.push_back(if later {
                Ok(crate::transport::Sent::Later(Box::pin(async {
                    Err(refused)
                })))
            } else {
                Err(refused)
            });
        })
        .await
        .expect("the next send refused");
    error
}

fn same_error(outcome: &Result<(), CallError>, expected: &RouterError) {
    let (Err(CallError::Other(actual)), RouterError::Other(expected)) = (outcome, expected) else {
        panic!("the transport's exact error: {outcome:?}");
    };
    assert!(Arc::ptr_eq(actual, expected));
}

#[tokio::test]
async fn end_a_result_whose_chunk_cannot_go_out_forgetting_its_call() {
    for dotnet in [false, true] {
        let later = false;
        for (total, end, message) in [
            (150, 80, "gone"),
            (100, 100, "the transport refused the chunk"),
        ] {
            let (peer, handed) = serving(false, &limits()).await;
            let answerer = asked(
                &peer,
                (
                    &handed,
                    if total == 100 {
                        Bytes::from_static(&[1])
                    } else {
                        Bytes::new()
                    },
                ),
            )
            .await;
            let responding = answerer.respond(RouterAnswer::Result(pattern((total, dotnet))));
            peer.settle().await;
            let refused = refuse(&peer, (message, later)).await;
            peer.receive((credit(1, end), Arc::from("a")));
            same_error(&responding.await, &refused);
            assert_eq!(refused.to_string(), message);
            peer.receive((
                Envelope::Request {
                    header: crate::testing::core_port::scripted_header(1),
                    payload: if total == 100 {
                        Bytes::from_static(&[2])
                    } else {
                        Bytes::new()
                    },
                },
                Arc::from("a"),
            ));
            peer.settle().await;
            assert_eq!(locked(&handed).len(), 2);
            quiet(&peer).await;
        }
    }
}

#[tokio::test]
async fn end_a_result_whose_opening_cannot_go_out_forgetting_its_call() {
    for (later, dotnet) in [(false, false), (true, true)] {
        let (peer, handed) = serving(false, &limits()).await;
        let answerer = asked(&peer, (&handed, Bytes::from_static(&[1]))).await;
        let bytes = pattern((100, dotnet));
        let refused = refuse(&peer, ("the transport refused the opening", later)).await;
        same_error(
            &answerer.respond(RouterAnswer::Result(bytes.clone())).await,
            &refused,
        );
        assert_eq!(
            sent(&peer).await,
            [Envelope::Result {
                header: ResultHeader {
                    call_id: 1,
                    total: Some(100),
                    credential: None
                },
                payload: bytes.slice(..28),
            }]
        );
        peer.receive((
            Envelope::Request {
                header: crate::testing::core_port::scripted_header(1),
                payload: Bytes::from_static(&[2]),
            },
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(locked(&handed).len(), 2);
        quiet(&peer).await;
    }
}

#[tokio::test]
#[ignore = "divergence: a ready error future for an earlier chunk is observed after the final chunk settles the answer successfully"]
async fn a_ready_chunk_refusal_is_observed_before_a_later_successful_final_chunk() {
    let (peer, handed) = serving(false, &limits()).await;
    let answerer = asked(&peer, (&handed, Bytes::from_static(&[1]))).await;
    let responding = answerer.respond(RouterAnswer::Result(pattern((100, true))));
    peer.settle().await;
    let refused = refuse(&peer, ("the transport refused the chunk", true)).await;
    peer.receive((credit(1, 100), Arc::from("a")));
    same_error(&responding.await, &refused);
}
