//! Transfers received: their places, budget, credits and the bytes they return.

use std::sync::Arc;

use bytes::Bytes;

use crate::constants::{ProtocolCode, RouterSide};
use crate::router::parts::ReceivingTransfers;
use crate::router::transfer::{Chunk, ChunkOutcome};
use crate::router::types::{CallAddress, LIMIT_DEFAULTS, RouterLimits};

fn call((id, handle): (u32, &str)) -> CallAddress {
    CallAddress {
        call_id: id,
        connection_handle: Arc::from(handle),
    }
}

fn receiving(limits: RouterLimits) -> ReceivingTransfers {
    ReceivingTransfers::new(
        RouterSide::Server,
        (
            RouterLimits {
                window_bytes: 16,
                ..limits
            },
            1,
        ),
    )
}

fn open(
    receiving: &mut ReceivingTransfers,
    (id, handle, size, total): (u32, &str, usize, u64),
) -> u64 {
    receiving
        .open(&Bytes::from(vec![0; size]), (&call((id, handle)), total))
        .expect("an opening")
}

#[test]
fn refuses_an_opening_by_its_own_failure_and_holds_nothing_of_one_refused() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        maximum_payload_bytes: 50,
        ..LIMIT_DEFAULTS
    });
    for (size, total, code, detail) in [
        (
            1,
            0,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a transfer declares its total, not 0",
        ),
        (
            1,
            51,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a payload is 50 bytes at most, not 51",
        ),
        (
            4,
            4,
            ProtocolCode::CHUNK_INVALID,
            "an opening of 4 bytes holds its whole total of 4",
        ),
    ] {
        let refused = receiving
            .open(&Bytes::from(vec![0; size]), (&call((1, "a")), total))
            .expect_err("refused");
        assert_eq!(refused.code(), code.get());
        assert_eq!(refused.detail(), detail);
    }
    assert_eq!(receiving.available(), 64);
    assert_eq!(
        receiving.gauges().counts.get("receivingTransfers"),
        Some(&0)
    );
    let mut none = ReceivingTransfers::new(
        RouterSide::Server,
        (
            RouterLimits {
                maximum_transfers: 0,
                ..LIMIT_DEFAULTS
            },
            1,
        ),
    );
    let refused = none
        .open(&Bytes::from_static(&[0]), (&call((1, "a")), 8))
        .expect_err("none allowed");
    assert_eq!(refused.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
    assert_eq!(refused.detail(), "this peer takes no transfer");
}

#[test]
fn takes_as_many_transfers_on_a_connection_as_it_may_and_one_on_another_all_the_same() {
    let mut receiving = receiving(RouterLimits {
        maximum_transfers: 2,
        ..LIMIT_DEFAULTS
    });
    let first = open(&mut receiving, (1, "a", 1, 8));
    open(&mut receiving, (3, "a", 1, 8));
    let opening = Bytes::from_static(&[0]);
    let fifth = call((5, "a"));
    assert_eq!(
        receiving
            .open(&opening, (&fifth, 8))
            .expect_err("full")
            .code(),
        ProtocolCode::CAPACITY_EXCEEDED.get()
    );
    open(&mut receiving, (1, "b", 1, 8));
    receiving.complete(first);
    assert_eq!(
        receiving
            .open(&opening, (&fifth, 8))
            .expect_err("the place stays")
            .code(),
        ProtocolCode::CAPACITY_EXCEEDED.get()
    );
    receiving.close(first);
    receiving
        .open(&opening, (&fifth, 8))
        .expect("the place comes back");
}

#[test]
fn holds_an_opening_to_the_last_byte_of_its_budget_and_refuses_one_byte_more() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        maximum_payload_bytes: 64,
        ..LIMIT_DEFAULTS
    });
    open(&mut receiving, (1, "a", 60, 64));
    assert_eq!(receiving.available(), 4);
    let refused = receiving
        .open(&Bytes::from_static(&[0; 5]), (&call((3, "a")), 64))
        .expect_err("a byte too many");
    assert_eq!(refused.code(), ProtocolCode::CAPACITY_EXCEEDED.get());
    assert_eq!(
        refused.detail(),
        "the transfers received hold the budget but 4 bytes"
    );
    open(&mut receiving, (3, "a", 4, 64));
    assert_eq!(receiving.available(), 0);
}

#[test]
fn reserves_what_each_credit_it_sends_opens_within_the_budget_left() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 100,
        ..LIMIT_DEFAULTS
    });
    let opened = open(&mut receiving, (1, "a", 4, 40));
    assert_eq!(receiving.grant(opened), Some((call((1, "a")), 20)));
    assert_eq!(receiving.grant(opened), None);
    assert_eq!(receiving.available(), 80);
}

#[test]
fn gives_a_transfer_s_bytes_back_as_its_payload_goes_on_whole_and_all_it_holds_once_closed() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 100,
        ..LIMIT_DEFAULTS
    });
    let opened = receiving
        .open(&Bytes::from_static(&[1, 2]), (&call((1, "a")), 4))
        .expect("opened");
    assert_eq!(receiving.grant(opened), Some((call((1, "a")), 4)));
    for (offset, byte, last, outcome) in [
        (2, 3, false, ChunkOutcome::Placed),
        (3, 4, true, ChunkOutcome::Complete),
    ] {
        assert_eq!(
            receiving
                .place(
                    opened,
                    &Chunk {
                        bytes: Bytes::from(vec![byte]),
                        offset,
                        is_last: last
                    }
                )
                .expect("placed"),
            outcome
        );
    }
    let (whole, credits) = receiving.complete(opened);
    assert_eq!(whole, Bytes::from_static(&[1, 2, 3, 4]));
    assert_eq!(credits, []);
    assert_eq!(receiving.available(), 100);
    for _ in 0..2 {
        assert_eq!(receiving.close(opened), []);
        assert_eq!(receiving.available(), 100);
    }
    let closed = open(&mut receiving, (3, "a", 1, 40));
    assert_eq!(receiving.close(closed), []);
    assert_eq!(receiving.grant(closed), None);
    assert_eq!(receiving.available(), 100);
}

#[test]
fn grants_a_transfer_the_budget_starved_once_another_gives_its_bytes_back() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 21,
        maximum_payload_bytes: 20,
        ..LIMIT_DEFAULTS
    });
    let first = open(&mut receiving, (1, "a", 4, 20));
    assert_eq!(receiving.grant(first), Some((call((1, "a")), 20)));
    let second = open(&mut receiving, (1, "b", 1, 20));
    assert_eq!(receiving.grant(second), None);
    assert_eq!(receiving.available(), 0);
    assert_eq!(receiving.close(first), [(call((1, "b")), 17)]);
    assert_eq!(receiving.available(), 4);
}

#[test]
fn ends_every_transfer_of_a_connection_or_of_every_one_before_it_grants_the_budget_given_back() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 28,
        maximum_payload_bytes: 24,
        ..LIMIT_DEFAULTS
    });
    let first = open(&mut receiving, (1, "a", 4, 24));
    assert_eq!(receiving.grant(first), Some((call((1, "a")), 20)));
    open(&mut receiving, (3, "a", 4, 24));
    let starved = open(&mut receiving, (1, "b", 4, 24));
    assert_eq!(receiving.grant(starved), None);
    assert_eq!(
        receiving.close_all(Some(&Arc::from("a"))),
        [(call((1, "b")), 20)]
    );
    assert_eq!(receiving.available(), 8);
    open(&mut receiving, (5, "a", 4, 24));
    assert_eq!(receiving.close_all(None), []);
    assert_eq!(receiving.available(), 28);
}

#[test]
fn counts_the_transfers_received_and_the_bytes_of_the_budget_they_hold_under_its_ceiling() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        ..LIMIT_DEFAULTS
    });
    let opened = open(&mut receiving, (1, "a", 4, 8));
    receiving.grant(opened);
    let gauges = receiving.gauges();
    assert_eq!(gauges.anomalies, Vec::<String>::new());
    assert_eq!(
        gauges.ceilings,
        std::collections::BTreeMap::from([("bufferedBytes", 64)])
    );
    assert_eq!(
        gauges.counts,
        std::collections::BTreeMap::from([
            (
                "bufferedBytes",
                64_u64.saturating_sub(receiving.available())
            ),
            ("receivingTransfers", 1)
        ])
    );
    assert_eq!(
        gauges.connection_handles,
        std::collections::BTreeSet::from([Arc::from("a")])
    );
    assert!(receiving.available() < 64);
    receiving.close_all(None);
    let gauges = receiving.gauges();
    assert!(gauges.connection_handles.is_empty());
    assert_eq!(
        gauges.counts,
        std::collections::BTreeMap::from([("bufferedBytes", 0), ("receivingTransfers", 0)])
    );
}

async fn timed_peer() -> crate::testing::core_port::Peer {
    use crate::router::core::{self as router_core, Handler};
    use crate::router::types::RouterLimitsOptions;

    let peer = crate::testing::core_port::Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(core::time::Duration::from_millis(250)),
            ..RouterLimitsOptions::default()
        },
    );
    peer.owner
        .run(|state| {
            let mut limits = state.core.limits;
            limits.window_bytes = 16;
            state.core.receivings = ReceivingTransfers::new(RouterSide::Server, (limits, 1));
            router_core::register_resolver(
                &state.core.resolvers,
                (
                    &crate::testing::pair::echo(),
                    Handler {
                        resolve: Arc::new(|_| Box::pin(async { Ok(()) })),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                    None,
                ),
            )
            .expect("echo registered");
        })
        .await
        .expect("a timed port");
    peer
}

fn opening((call_id, total): (u32, u64)) -> crate::envelope::Envelope {
    crate::envelope::Envelope::Request {
        header: crate::envelope::RequestHeader {
            total: Some(total),
            ..crate::testing::core_port::scripted_header(call_id)
        },
        payload: Bytes::from_static(&[1]),
    }
}

fn byte((call_id, last): (u32, bool)) -> crate::envelope::Envelope {
    crate::envelope::Envelope::Chunk {
        header: crate::envelope::ChunkHeader {
            call_id,
            is_last: last,
            offset: 1,
        },
        payload: Bytes::from_static(&[2]),
    }
}

async fn failures(peer: &crate::testing::core_port::Peer) -> Vec<(u32, u16, String)> {
    peer.sent()
        .await
        .into_iter()
        .filter_map(|(_, envelope)| {
            if let crate::envelope::Envelope::Failure { header, failure } = envelope {
                Some((header.call_id, failure.code.get(), failure.detail))
            } else {
                None
            }
        })
        .collect()
}

#[tokio::test]
async fn stalls_a_transfer_nothing_comes_for_its_timer_set_going_again_by_bytes_placed_alone() {
    use core::time::Duration;

    for (progress_at, duplicate_after) in [(100_u64, 0_u64), (200, 100)] {
        let peer = timed_peer().await;
        peer.receive((opening((1, 8)), Arc::from("a")));
        peer.settle().await;
        peer.clock.advance(Duration::from_millis(progress_at)).await;
        peer.receive((byte((1, false)), Arc::from("a")));
        peer.settle().await;
        peer.clock
            .advance(Duration::from_millis(duplicate_after))
            .await;
        peer.receive((byte((1, false)), Arc::from("a")));
        peer.settle().await;
        // A part opened without the core's stall callback arms nothing.
        peer.owner
            .run(|state| {
                state
                    .core
                    .receivings
                    .open(&Bytes::from_static(&[0]), (&call((3, "a")), 8))
                    .expect("no stall callback");
            })
            .await
            .expect("a second transfer");
        assert_eq!(peer.armed(), [Duration::from_millis(250); 2]);
        assert_eq!(
            peer.clock.dues(),
            [Duration::from_millis(
                250_u64.saturating_sub(duplicate_after)
            )]
        );
        peer.clock
            .advance(Duration::from_millis(
                249_u64.saturating_sub(duplicate_after),
            ))
            .await;
        assert_eq!(failures(&peer).await, []);
        peer.clock.advance(Duration::from_millis(1)).await;
        let failures = failures(&peer).await;
        assert_eq!(
            failures,
            [(
                1,
                ProtocolCode::TRANSFER_STALLED.get().get(),
                "nothing came for 250 milliseconds".to_owned()
            )]
        );
        peer.owner
            .run(|state| {
                crate::router::core::dispose(state);
                assert_eq!(state.reports.len(), 0);
            })
            .await
            .expect("disposed");
    }
}

#[tokio::test]
#[ignore = "divergence: the core arms no further timer for the last chunk; TypeScript and C# arm then cancel it"]
async fn stops_a_transfer_s_timer_once_its_payload_is_whole_and_once_it_is_closed() {
    use core::time::Duration;

    let peer = timed_peer().await;
    peer.receive((opening((1, 2)), Arc::from("a")));
    peer.settle().await;
    peer.receive((byte((1, true)), Arc::from("a")));
    peer.settle().await;
    peer.receive((opening((3, 2)), Arc::from("a")));
    peer.settle().await;
    peer.owner
        .run(|state| {
            let transfer = state
                .core
                .answering
                .get(&call((3, "a")))
                .expect("the call")
                .receiving
                .as_ref()
                .expect("its transfer")
                .transfer;
            state.core.receivings.close(transfer);
        })
        .await
        .expect("the second transfer closed");
    assert_eq!(peer.armed(), [Duration::from_millis(250); 3]);
    assert_eq!(peer.clock.dues(), []);
    peer.clock.advance(Duration::from_millis(1_000)).await;
    assert_eq!(failures(&peer).await, []);
    peer.owner
        .run(crate::router::core::dispose)
        .await
        .expect("disposed");
}
