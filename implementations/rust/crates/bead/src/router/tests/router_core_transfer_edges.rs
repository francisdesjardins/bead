//! Incoming transfers through the core: ordered credit, a call's held place, the shared budget,
//! cancellation and inactivity after the payload is complete.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;

use super::router_core_requester::{limits as envelope_limits, pattern};
use super::router_core_sessions::{handler, receive};
use super::{Handed, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{CancelHeader, ChunkHeader, Envelope, RequestHeader};
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, RouterError, RouterLimitsOptions};
use crate::testing::core_port::{Peer, scripted_header};
use crate::testing::pair::echo;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Outgoing {
    Credit(u32, u64),
    Result(u32, Bytes),
    Failure(u32, u16),
}

pub(super) fn limits() -> RouterLimitsOptions {
    RouterLimitsOptions {
        buffered_bytes_budget: Some(1_024),
        maximum_payload_bytes: Some(1_024),
        ..envelope_limits()
    }
}

pub(super) async fn serving(unresolved: bool, options: &RouterLimitsOptions) -> (Peer, Handed) {
    let peer = Peer::new(RouterSide::Server, options);
    let handed = Handed::default();
    let mut handler = handler((&handed, &Arc::default()));
    if unresolved {
        let seen = Arc::clone(&handed);
        handler.resolve = Arc::new(move |props| {
            locked(&seen).push(props);
            Box::pin(core::future::pending())
        });
    }
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), handler, None))
                .expect("echo registered");
        })
        .await
        .expect("the port ready");
    (peer, handed)
}

pub(super) fn opening(call_id: u32, (payload, total): (Bytes, u64)) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            total: Some(total),
            ..scripted_header(call_id)
        },
        payload,
    }
}

pub(super) fn chunk(call_id: u32, (offset, payload, total): (u64, Bytes, u64)) -> Envelope {
    Envelope::Chunk {
        header: ChunkHeader {
            call_id,
            offset,
            is_last: offset.saturating_add(u64::try_from(payload.len()).expect("a payload"))
                == total,
        },
        payload,
    }
}

pub(super) async fn outgoing(peer: &Peer) -> Vec<(String, Outgoing)> {
    peer.sent()
        .await
        .into_iter()
        .map(|(handle, envelope)| {
            let sent = match envelope {
                Envelope::Credit { header } => {
                    assert!(!header.paced);
                    Outgoing::Credit(header.call_id, header.credit_end)
                }
                Envelope::Result { header, payload } => {
                    assert_eq!(header.total, None);
                    assert_eq!(header.credential, None);
                    Outgoing::Result(header.call_id, payload)
                }
                Envelope::Failure { header, failure } => {
                    assert_eq!(header.credential, None);
                    Outgoing::Failure(header.call_id, failure.code.get())
                }
                other @ (Envelope::Request { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Cancel { .. }) => {
                    panic!("a transfer's credit or answer, not {other:?}")
                }
            };
            (handle.to_string(), sent)
        })
        .collect()
}

pub(super) fn narrow() -> RouterLimitsOptions {
    RouterLimitsOptions {
        buffered_bytes_budget: Some(200),
        maximum_payload_bytes: Some(200),
        ..limits()
    }
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn assemble_a_requests_payload_from_full_chunks_in_any_order_credited_half_a_window_at_least_at_a_time_then_dispatch_it()
 {
    let (peer, handed) = serving(false, &limits()).await;
    let payload = pattern(300);
    let sent_payload = payload.clone();
    peer.owner
        .run(move |state| {
            receive(
                state,
                (opening(1, (sent_payload.slice(..40), 300)), "a", None),
            );
            for (start, end) in [
                (88, 136),
                (40, 88),
                (184, 232),
                (136, 184),
                (40, 88),
                (280, 300),
            ] {
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(start).expect("an offset"),
                                sent_payload.slice(start..end),
                                300,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("the chunks placed out of order");
    assert!(locked(&handed).is_empty());
    peer.receive((
        chunk(1, (232, payload.slice(232..280), 300)),
        Arc::from("a"),
    ));
    peer.settle().await;
    let answerer = {
        let seen = locked(&handed);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].header.total, Some(300));
        assert_eq!(seen[0].payload, payload);
        Arc::clone(&seen[0].answerer)
    };
    answerer
        .respond(RouterAnswer::Result(Bytes::from_static(&[9])))
        .await
        .expect("answered");
    peer.receive((
        chunk(1, (232, payload.slice(232..280), 300)),
        Arc::from("a"),
    ));
    peer.receive((
        chunk(1, (290, Bytes::from(vec![0; 48]), 1_024)),
        Arc::from("a"),
    ));
    peer.settle().await;
    assert_eq!(
        outgoing(&peer).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 168)),
            ("a".to_owned(), Outgoing::Credit(1, 264)),
            ("a".to_owned(), Outgoing::Credit(1, 300)),
            (
                "a".to_owned(),
                Outgoing::Result(1, Bytes::from_static(&[9]))
            ),
        ]
    );
    peer.owner
        .run(|state| {
            assert_eq!(state.reports.len(), 1);
            let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                panic!("a protocol report")
            };
            assert_eq!(handle.as_ref(), "a");
            assert_eq!(failure.code(), ProtocolCode::CREDIT_EXCEEDED.get());
        })
        .await
        .expect("the excessive chunk reported");
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin plays both opening sizes and the refusal before, and acceptance after, the call ends"
)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn hold_a_connections_place_for_a_transfer_until_its_call_ends_not_once_its_payload_is_whole()
{
    for (first, middle, answer, next_total) in [(40, 88, 9, 8), (44, 92, 1, 100)] {
        let (peer, handed) = serving(
            false,
            &RouterLimitsOptions {
                maximum_transfers: Some(1),
                ..limits()
            },
        )
        .await;
        let payload = pattern(100);
        peer.owner
            .run(move |state| {
                receive(
                    state,
                    (opening(1, (payload.slice(..first), 100)), "a", None),
                );
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(first).expect("an offset"),
                                payload.slice(first..middle),
                                100,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(middle).expect("an offset"),
                                payload.slice(middle..),
                                100,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
                receive(
                    state,
                    (
                        opening(
                            3,
                            (
                                if next_total == 8 {
                                    Bytes::from_static(&[1])
                                } else {
                                    payload.slice(..44)
                                },
                                next_total,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
            })
            .await
            .expect("the payload is whole while its call stays open");
        peer.settle().await;
        let answerer = {
            let seen = locked(&handed);
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].payload, pattern(100));
            Arc::clone(&seen[0].answerer)
        };
        answerer
            .respond(RouterAnswer::Result(Bytes::from(vec![answer])))
            .await
            .expect("answered");
        peer.receive((
            opening(
                5,
                (
                    if next_total == 8 {
                        Bytes::from_static(&[1])
                    } else {
                        pattern(100).slice(..44)
                    },
                    next_total,
                ),
            ),
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(
            outgoing(&peer).await,
            [
                ("a".to_owned(), Outgoing::Credit(1, 100)),
                (
                    "a".to_owned(),
                    Outgoing::Failure(3, ProtocolCode::CAPACITY_EXCEEDED.get().get())
                ),
                (
                    "a".to_owned(),
                    Outgoing::Result(1, Bytes::from(vec![answer]))
                ),
                ("a".to_owned(), Outgoing::Credit(5, next_total)),
            ]
        );
        peer.owner
            .run(|state| {
                assert!(state.reports.is_empty());
            })
            .await
            .expect("nothing reported");
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin plays both connections sharing a budget and the same connection's incremental grants"
)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn give_the_budget_back_once_a_payload_is_whole_and_grant_the_transfer_it_starved() {
    let (peer, handed) = serving(false, &narrow()).await;
    let payload = pattern(168);
    peer.owner
        .run(move |state| {
            receive(state, (opening(1, (payload.slice(..40), 168)), "a", None));
            receive(
                state,
                (opening(3, (Bytes::from(vec![0; 32]), 100)), "b", None),
            );
            receive(
                state,
                (opening(5, (Bytes::from_static(&[1]), 8)), "a", None),
            );
            for offset in [40, 88, 136] {
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(offset).expect("an offset"),
                                payload.slice(offset..(offset + 48).min(168)),
                                168,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("the first transfer made whole");
    peer.settle().await;
    assert_eq!(locked(&handed).len(), 1);
    assert_eq!(
        outgoing(&peer).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 168)),
            (
                "a".to_owned(),
                Outgoing::Failure(5, ProtocolCode::CAPACITY_EXCEEDED.get().get())
            ),
            ("b".to_owned(), Outgoing::Credit(3, 100)),
        ]
    );
    let (same, _) = serving(
        false,
        &RouterLimitsOptions {
            buffered_bytes_budget: Some(256),
            maximum_payload_bytes: Some(256),
            ..limits()
        },
    )
    .await;
    let payload = pattern(200);
    same.owner
        .run(move |state| {
            receive(state, (opening(1, (payload.slice(..44), 200)), "a", None));
            receive(state, (opening(3, (payload.slice(..44), 200)), "a", None));
        })
        .await
        .expect("the second transfer waits");
    assert_eq!(
        outgoing(&same).await,
        [("a".to_owned(), Outgoing::Credit(1, 172))]
    );
    let payload = pattern(200);
    same.owner
        .run(move |state| {
            for offset in [44, 92] {
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(offset).expect("an offset"),
                                payload.slice(offset..offset + 48),
                                200,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("the first transfer progresses");
    assert_eq!(
        outgoing(&same).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 172)),
            ("a".to_owned(), Outgoing::Credit(1, 200))
        ]
    );
    let payload = pattern(200);
    same.owner
        .run(move |state| {
            for offset in [140, 188] {
                receive(
                    state,
                    (
                        chunk(
                            1,
                            (
                                u64::try_from(offset).expect("an offset"),
                                payload.slice(offset..(offset + 48).min(200)),
                                200,
                            ),
                        ),
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("the first payload is complete");
    assert_eq!(
        outgoing(&same).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 172)),
            ("a".to_owned(), Outgoing::Credit(1, 200)),
            ("a".to_owned(), Outgoing::Credit(3, 172)),
        ]
    );
}

#[tokio::test]
async fn end_a_requests_transfer_its_requester_cancels_giving_the_budget_back() {
    let (peer, handed) = serving(false, &narrow()).await;
    peer.owner
        .run(|state| {
            receive(
                state,
                (opening(1, (Bytes::from(vec![0; 40]), 200)), "a", None),
            );
            receive(
                state,
                (
                    Envelope::Cancel {
                        header: CancelHeader { call_id: 1 },
                    },
                    "a",
                    None,
                ),
            );
            receive(
                state,
                (chunk(1, (40, Bytes::from(vec![0; 48]), 200)), "a", None),
            );
            receive(
                state,
                (opening(3, (Bytes::from(vec![0; 40]), 200)), "a", None),
            );
        })
        .await
        .expect("cancelled, then another opening");
    peer.settle().await;
    assert_eq!(
        outgoing(&peer).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 168)),
            ("a".to_owned(), Outgoing::Credit(3, 168)),
        ]
    );
    assert!(locked(&handed).is_empty());
    peer.owner
        .run(|state| {
            assert!(state.reports.is_empty());
        })
        .await
        .expect("the late chunk is silent");
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn stall_no_request_whose_payload_came_whole_however_long_its_resolver_takes() {
    let (peer, handed) = serving(
        true,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(250)),
            ..limits()
        },
    )
    .await;
    peer.owner
        .run(|state| {
            receive(state, (opening(1, (pattern(40), 60)), "a", None));
            receive(state, (chunk(1, (40, pattern(20), 60)), "a", None));
        })
        .await
        .expect("the payload complete");
    peer.settle().await;
    peer.clock.advance(Duration::from_secs(10)).await;
    assert_eq!(
        outgoing(&peer).await,
        [("a".to_owned(), Outgoing::Credit(1, 60))]
    );
    assert_eq!(locked(&handed).len(), 1);
    assert!(!locked(&handed)[0].signal.is_aborted());

    let (whole, handed) = serving(
        false,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_secs(2)),
            ..limits()
        },
    )
    .await;
    let payload = pattern(100);
    let received = payload.clone();
    whole
        .owner
        .run(move |state| {
            receive(state, (opening(1, (received.slice(..44), 100)), "a", None));
            receive(
                state,
                (chunk(1, (44, received.slice(44..92), 100)), "a", None),
            );
            receive(
                state,
                (chunk(1, (92, received.slice(92..), 100)), "a", None),
            );
        })
        .await
        .expect("the second payload complete");
    whole.settle().await;
    let answerer = {
        let seen = locked(&handed);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].payload, payload);
        Arc::clone(&seen[0].answerer)
    };
    whole.clock.advance(Duration::from_secs(10)).await;
    whole.receive((
        chunk(1, (100, Bytes::from_static(&[1]), 101)),
        Arc::from("a"),
    ));
    whole.settle().await;
    whole
        .owner
        .run(|state| {
            assert_eq!(state.reports.len(), 1);
            let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                panic!("a protocol report")
            };
            assert_eq!(handle.as_ref(), "a");
            assert_eq!(failure.code(), ProtocolCode::CHUNK_INVALID.get());
        })
        .await
        .expect("the unplaced chunk reported");
    assert_eq!(
        outgoing(&whole).await,
        [("a".to_owned(), Outgoing::Credit(1, 100))]
    );
    answerer
        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
        .await
        .expect("answered after the timer");
    assert_eq!(
        outgoing(&whole).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 100)),
            (
                "a".to_owned(),
                Outgoing::Result(1, Bytes::from_static(&[1]))
            )
        ]
    );
}
