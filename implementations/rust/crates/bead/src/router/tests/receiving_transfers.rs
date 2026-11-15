//! Transfers received: their places, budget, admission, credits and the bytes they return.

use std::sync::Arc;

use bytes::Bytes;

use crate::constants::{ProtocolCode, RouterSide};
use crate::failure::Failure;
use crate::router::parts::{Admitted, Opened, OpeningOf, ReceivingTransfers};
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

// an opening of `size` bytes, as many as its sender places in it
fn opened(
    receiving: &mut ReceivingTransfers,
    ((id, handle), (size, total)): ((u32, &str), (usize, u64)),
) -> Result<Opened, Failure> {
    receiving.open(
        &Bytes::from(vec![0; size]),
        OpeningOf {
            call: &call((id, handle)),
            total,
            opening_bytes: u64::try_from(size).expect("a size"),
        },
    )
}

fn open(
    receiving: &mut ReceivingTransfers,
    (id, handle, size, total): (u32, &str, usize, u64),
) -> u64 {
    opened(receiving, ((id, handle), (size, total)))
        .expect("an opening")
        .id
}

fn admitted(id: u64, (on, credit_end): ((u32, &str), u64)) -> Admitted {
    Admitted {
        id,
        call: call(on),
        credit_end: Some(credit_end),
    }
}

fn counts_of(receiving: &ReceivingTransfers) -> [Option<u64>; 4] {
    let gauges = receiving.gauges();

    [
        gauges.counts.get("reservedBytes").copied(),
        gauges.counts.get("bufferedBytes").copied(),
        gauges.counts.get("receivingTransfers").copied(),
        gauges.counts.get("waitingTransfers").copied(),
    ]
}

#[test]
fn refuses_an_opening_by_its_own_failure_and_holds_nothing_of_one_refused() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        maximum_payload_bytes: 50,
        ..LIMIT_DEFAULTS
    });
    for (size, placed, total, code, detail) in [
        (
            1,
            1,
            0,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a transfer declares its total, not 0",
        ),
        (
            1,
            1,
            51,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a payload is 50 bytes at most, not 51",
        ),
        (
            4,
            4,
            4,
            ProtocolCode::CHUNK_INVALID,
            "an opening of 4 bytes holds its whole total of 4",
        ),
        (
            3,
            4,
            8,
            ProtocolCode::CHUNK_INVALID,
            "an opening carries 4 bytes of its payload, not 3",
        ),
        (
            5,
            4,
            8,
            ProtocolCode::CHUNK_INVALID,
            "an opening carries 4 bytes of its payload, not 5",
        ),
    ] {
        let refused = receiving
            .open(
                &Bytes::from(vec![0; size]),
                OpeningOf {
                    call: &call((1, "a")),
                    total,
                    opening_bytes: placed,
                },
            )
            .expect_err("refused");
        assert_eq!(refused.code(), code.get());
        assert_eq!(refused.detail(), detail);
    }
    assert_eq!(receiving.available(), 64);
    assert_eq!(counts_of(&receiving), [Some(0), Some(0), Some(0), Some(0)]);
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
    let refused = opened(&mut none, ((1, "a"), (1, 8))).expect_err("none allowed");
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
    assert_eq!(
        opened(&mut receiving, ((5, "a"), (1, 8)))
            .expect_err("full")
            .code(),
        ProtocolCode::CAPACITY_EXCEEDED.get()
    );
    open(&mut receiving, (1, "b", 1, 8));
    receiving.complete(first);
    assert_eq!(
        opened(&mut receiving, ((5, "a"), (1, 8)))
            .expect_err("the place stays")
            .code(),
        ProtocolCode::CAPACITY_EXCEEDED.get()
    );
    receiving.close(first);
    opened(&mut receiving, ((5, "a"), (1, 8))).expect("the place comes back");
}

// spec 12.4
#[test]
fn admits_an_opening_whose_total_the_budget_left_holds_to_its_last_byte_and_has_one_a_byte_past_it_wait()
 {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        maximum_payload_bytes: 64,
        ..LIMIT_DEFAULTS
    });
    assert!(
        opened(&mut receiving, ((1, "a"), (4, 60)))
            .expect("an opening")
            .admitted
    );
    assert_eq!(receiving.available(), 4);
    let last = opened(&mut receiving, ((3, "a"), (1, 4))).expect("an opening");
    assert!(last.admitted, "its total holds the budget's last byte");
    assert_eq!(receiving.available(), 0);
    receiving.close(last.id);
    let past = opened(&mut receiving, ((3, "a"), (1, 5))).expect("an opening that waits");
    assert!(!past.admitted, "a byte past what the budget left holds");
    assert!(receiving.is_waiting(past.id));
    assert_eq!(receiving.grant(past.id), None);
    assert_eq!(receiving.available(), 4);
    assert_eq!(counts_of(&receiving), [Some(60), Some(5), Some(2), Some(1)]);
}

#[test]
fn reserves_a_transfer_s_whole_total_as_it_admits_it_and_nothing_more_as_it_credits_it() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 100,
        ..LIMIT_DEFAULTS
    });
    let opened = open(&mut receiving, (1, "a", 4, 40));
    assert_eq!(receiving.available(), 60);
    assert_eq!(receiving.grant(opened), Some((call((1, "a")), 20)));
    assert_eq!(receiving.grant(opened), None);
    assert_eq!(receiving.available(), 60);
}

#[test]
fn gives_a_transfer_s_bytes_back_as_its_payload_goes_on_whole_and_all_it_holds_once_closed() {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 100,
        ..LIMIT_DEFAULTS
    });
    let opened = receiving
        .open(
            &Bytes::from_static(&[1, 2]),
            OpeningOf {
                call: &call((1, "a")),
                total: 4,
                opening_bytes: 2,
            },
        )
        .expect("opened")
        .id;
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
    let (whole, admitted) = receiving.complete(opened);
    assert_eq!(whole, Bytes::from_static(&[1, 2, 3, 4]));
    assert_eq!(admitted, []);
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

// spec 12.4
#[test]
fn admits_the_openings_that_wait_in_the_order_they_opened_one_that_fits_waiting_behind_one_before_it()
 {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 30,
        maximum_payload_bytes: 30,
        ..LIMIT_DEFAULTS
    });
    let first = open(&mut receiving, (1, "a", 4, 20));
    assert_eq!(receiving.grant(first), Some((call((1, "a")), 20)));
    let second = open(&mut receiving, (1, "b", 4, 20));
    // * the 10 bytes left hold its total, yet it waits behind the one before it
    let third = opened(&mut receiving, ((3, "a"), (1, 8))).expect("an opening");
    assert!(!third.admitted);
    assert_eq!(receiving.available(), 10);
    assert_eq!(
        receiving.close(first),
        [
            admitted(second, ((1, "b"), 20)),
            admitted(third.id, ((3, "a"), 8))
        ]
    );
    assert_eq!(receiving.available(), 2);
    let fourth = open(&mut receiving, (5, "a", 1, 10));
    let fifth = opened(&mut receiving, ((1, "c"), (1, 2))).expect("an opening");
    assert!(
        !fifth.admitted,
        "the 2 bytes left hold it, behind one that waits"
    );
    // the walk stops at the first opening the budget left does not hold
    assert_eq!(
        receiving.close(third.id),
        [admitted(fourth, ((5, "a"), 10))]
    );
    assert!(receiving.is_waiting(fifth.id));
    assert_eq!(receiving.available(), 0);
    assert_eq!(receiving.close(second), [admitted(fifth.id, ((1, "c"), 2))]);
    assert_eq!(receiving.available(), 18);
}

// spec 12.10
#[test]
fn ends_every_transfer_of_a_connection_or_of_every_one_waiting_or_admitted_before_it_admits_an_opening_the_budget_given_back_holds()
 {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 48,
        maximum_payload_bytes: 24,
        ..LIMIT_DEFAULTS
    });
    let first = open(&mut receiving, (1, "a", 4, 24));
    assert_eq!(receiving.grant(first), Some((call((1, "a")), 20)));
    open(&mut receiving, (3, "a", 4, 24));
    let waiting = open(&mut receiving, (1, "b", 4, 24));
    open(&mut receiving, (5, "a", 4, 24));
    assert_eq!(receiving.grant(waiting), None);
    assert_eq!(
        counts_of(&receiving),
        [Some(48), Some(16), Some(4), Some(2)]
    );
    // its own waiting opening ends with it, and the budget it gives back admits another's
    assert_eq!(
        receiving.close_all(Some(&Arc::from("a"))),
        [admitted(waiting, ((1, "b"), 20))]
    );
    assert_eq!(receiving.available(), 24);
    assert_eq!(counts_of(&receiving), [Some(24), Some(4), Some(1), Some(0)]);
    open(&mut receiving, (7, "a", 4, 24));
    open(&mut receiving, (9, "a", 4, 24));
    assert_eq!(receiving.close_all(None), []);
    assert_eq!(receiving.available(), 48);
    assert_eq!(counts_of(&receiving), [Some(0), Some(0), Some(0), Some(0)]);
}

#[test]
fn counts_the_transfers_received_and_those_waiting_the_bytes_of_the_budget_they_reserve_under_its_ceiling_and_the_bytes_they_hold()
 {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        ..LIMIT_DEFAULTS
    });
    let opened = open(&mut receiving, (1, "a", 4, 40));
    receiving.grant(opened);
    open(&mut receiving, (3, "a", 2, 30));
    assert_eq!(
        receiving
            .place(
                opened,
                &Chunk {
                    bytes: Bytes::from_static(&[1]),
                    offset: 4,
                    is_last: false
                }
            )
            .expect("placed"),
        ChunkOutcome::Placed
    );
    let gauges = receiving.gauges();
    assert_eq!(gauges.anomalies, Vec::<String>::new());
    assert_eq!(
        gauges.ceilings,
        std::collections::BTreeMap::from([("reservedBytes", 64)])
    );
    // the waiting one's opening is held, outside the budget, which reserves the admitted total
    assert_eq!(
        gauges.counts,
        std::collections::BTreeMap::from([
            ("bufferedBytes", 7),
            ("outlivingTransfers", 0),
            ("receivingTransfers", 2),
            ("reservedBytes", 40),
            ("waitingTransfers", 1)
        ])
    );
    assert_eq!(
        gauges.connection_handles,
        std::collections::BTreeSet::from([Arc::from("a")])
    );
    receiving.close_all(None);
    let gauges = receiving.gauges();
    assert!(gauges.connection_handles.is_empty());
    assert_eq!(
        gauges.counts,
        std::collections::BTreeMap::from([
            ("bufferedBytes", 0),
            ("outlivingTransfers", 0),
            ("receivingTransfers", 0),
            ("reservedBytes", 0),
            ("waitingTransfers", 0)
        ])
    );
}

// spec 12.3
#[test]
fn holds_a_received_transfer_s_place_while_its_call_s_resolver_outlives_the_call_among_twice_maximum_transfers_and_gives_it_back_as_that_resolver_settles()
 {
    let mut receiving = receiving(RouterLimits {
        buffered_bytes_budget: 64,
        maximum_transfers: 1,
        ..LIMIT_DEFAULTS
    });
    let a: crate::router::types::ConnectionHandle = Arc::from("a");
    let open = |receiving: &mut ReceivingTransfers, (call_id, handle): (u32, &str)| {
        opened(receiving, ((call_id, handle), (1, 2)))
    };
    let refusal_of = |opened: Result<Opened, Failure>| {
        let refused = opened.expect_err("refused");

        (refused.code(), refused.detail().to_owned())
    };
    let past_both = (
        ProtocolCode::CAPACITY_EXCEEDED.get(),
        "the transfers a connection receives and those its resolvers outlive are 2 at most"
            .to_owned(),
    );
    // its call ends while the resolver of its dispatch runs on, as the core ends it
    let outlive = |receiving: &mut ReceivingTransfers, (transfer, dispatched): (u64, u64)| {
        receiving.outlive((&a, dispatched));
        receiving.close(transfer);
    };
    let first = open(&mut receiving, (1, "a")).expect("an opening").id;

    // its call ends while its resolver runs on: its bytes go back, its place among the transfers
    // the connection receives too, but not among those and the ones its resolvers outlive
    outlive(&mut receiving, (first, 11));

    let gauges = receiving.gauges();

    assert_eq!(
        gauges.connection_handles,
        std::collections::BTreeSet::from([Arc::clone(&a)])
    );
    assert_eq!(
        [
            gauges.counts.get("bufferedBytes").copied(),
            gauges.counts.get("outlivingTransfers").copied(),
            gauges.counts.get("receivingTransfers").copied()
        ],
        [Some(0), Some(1), Some(0)]
    );

    let second = open(&mut receiving, (3, "a")).expect("an opening").id;

    // * past maximumTransfers first, then past twice as many with those its resolvers outlive,
    // checked first, its detail its own; another connection's are its own
    assert_eq!(refusal_of(open(&mut receiving, (5, "a"))), past_both);

    outlive(&mut receiving, (second, 13));

    assert_eq!(refusal_of(open(&mut receiving, (5, "a"))), past_both);
    assert_eq!(
        receiving.gauges().counts.get("outlivingTransfers"),
        Some(&2)
    );
    open(&mut receiving, (1, "b")).expect("another connection's");

    // the resolver settles: its place goes back, once, and the next opening is taken
    receiving.settle((&a, 11));
    receiving.settle((&a, 11));

    assert_eq!(
        receiving.gauges().counts.get("outlivingTransfers"),
        Some(&1)
    );

    let third = open(&mut receiving, (5, "a")).expect("an opening").id;

    assert_eq!(refusal_of(open(&mut receiving, (7, "a"))), past_both);

    receiving.settle((&a, 13));

    assert_eq!(
        refusal_of(open(&mut receiving, (7, "a"))),
        (
            ProtocolCode::CAPACITY_EXCEEDED.get(),
            "the transfers a connection receives at once are 1 at most".to_owned()
        )
    );

    // its connection closes: the places its resolvers outlive end with it, and settle to nothing
    outlive(&mut receiving, (third, 15));
    receiving.close_all(Some(&a));

    let gauges = receiving.gauges();

    assert_eq!(
        gauges.connection_handles,
        std::collections::BTreeSet::from([Arc::from("b")])
    );
    assert_eq!(
        [
            gauges.counts.get("outlivingTransfers").copied(),
            gauges.counts.get("receivingTransfers").copied()
        ],
        [Some(0), Some(1)]
    );

    receiving.settle((&a, 15));
    open(&mut receiving, (9, "a")).expect("an opening");
}

// a server whose transfers are held to a window of 16 bytes, a byte a chunk, `budget` bytes in all,
// and an inactivity of 250 milliseconds: its openings carry one byte, as its placement says
async fn timed_peer_within(budget: u64) -> crate::testing::core_port::Peer {
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
        .run(move |state| {
            let mut limits = state.core.limits;
            limits.window_bytes = 16;
            limits.buffered_bytes_budget = budget;
            state.core.receivings = ReceivingTransfers::new(RouterSide::Server, (limits, 1));
            super::place_a_byte_in_each_opening(state);
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

async fn timed_peer() -> crate::testing::core_port::Peer {
    timed_peer_within(LIMIT_DEFAULTS.buffered_bytes_budget).await
}

// an opening of the byte its sender places in it
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

async fn credits(peer: &crate::testing::core_port::Peer) -> Vec<(u32, u64)> {
    peer.sent()
        .await
        .into_iter()
        .filter_map(|(_, envelope)| {
            if let crate::envelope::Envelope::Credit { header } = envelope {
                Some((header.call_id, header.credit_end))
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
                    .open(
                        &Bytes::from_static(&[0]),
                        OpeningOf {
                            call: &call((3, "a")),
                            total: 8,
                            opening_bytes: 1,
                        },
                    )
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

// spec 12.4
#[tokio::test]
async fn refuses_an_opening_still_waiting_at_half_the_inactivity_allowed_capacity_exceeded_and_admits_the_one_behind_it()
 {
    use core::time::Duration;

    let peer = timed_peer_within(10).await;
    peer.receive((opening((1, 8)), Arc::from("a")));
    // * the budget's 2 bytes left hold neither the 8 of the second nor, behind it, the third's 2
    peer.receive((opening((3, 8)), Arc::from("a")));
    peer.settle().await;
    peer.clock.advance(Duration::from_millis(60)).await;
    peer.receive((opening((5, 2)), Arc::from("b")));
    peer.settle().await;
    // the first's inactivity, then each waiting opening's wait, half of it
    assert_eq!(
        peer.armed(),
        [
            Duration::from_millis(250),
            Duration::from_millis(125),
            Duration::from_millis(125)
        ]
    );
    peer.clock.advance(Duration::from_millis(64)).await;
    assert_eq!(failures(&peer).await, []);
    peer.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        failures(&peer).await,
        [(
            3,
            ProtocolCode::CAPACITY_EXCEEDED.get().get(),
            "a total of 8 bytes waited 125 milliseconds for the budget".to_owned()
        )]
    );
    // its call held abandoned (spec 12.9); the one behind it admitted, its wait stopped, its
    // inactivity set going
    assert_eq!(credits(&peer).await, [(1, 8), (5, 2)]);
    assert_eq!(
        peer.armed(),
        [
            Duration::from_millis(250),
            Duration::from_millis(125),
            Duration::from_millis(125),
            Duration::from_millis(250),
            Duration::from_millis(250)
        ]
    );
    assert_eq!(
        peer.clock.dues(),
        [
            Duration::from_millis(125),
            Duration::from_millis(250),
            Duration::from_millis(250)
        ]
    );
    let sent = peer.sent().await;
    assert!(
        matches!(
            sent.as_slice(),
            [
                _,
                (_, crate::envelope::Envelope::Failure { .. }),
                (_, crate::envelope::Envelope::Credit { .. })
            ]
        ),
        "the refusal goes before the credit it lets through: {sent:?}"
    );
    peer.owner
        .run(crate::router::core::dispose)
        .await
        .expect("disposed");

    // a refusal its transport refuses closes its call in a later turn: the one behind it is
    // admitted in the turn its wait passed all the same
    let peer = timed_peer_within(10).await;
    let credited_by_then = Arc::new(std::sync::Mutex::new(None));
    let seen = Arc::clone(&credited_by_then);
    peer.owner
        .run(move |state| {
            state.sending.extend([
                Ok(crate::transport::Sent::Done),
                Err(crate::testing::core_port::error_of("refused")),
            ]);
            state.on_transmit = Some(Box::new(move |state, envelope| {
                if matches!(envelope, crate::envelope::Envelope::Failure { header, .. } if header.call_id == 3)
                {
                    let seen = Arc::clone(&seen);
                    state.core.later(move |state: &mut crate::testing::core_port::State| {
                        let credited = state.sent.iter().any(|(_, envelope)| {
                            matches!(envelope, crate::envelope::Envelope::Credit { header } if header.call_id == 5)
                        });
                        *seen.lock().expect("the flag") = Some(credited);
                    });
                }
            }));
        })
        .await
        .expect("the refusal's send refused");
    peer.receive((opening((1, 8)), Arc::from("a")));
    peer.receive((opening((3, 8)), Arc::from("a")));
    peer.receive((opening((5, 2)), Arc::from("b")));
    peer.settle().await;
    peer.clock.advance(Duration::from_millis(125)).await;
    assert_eq!(*credited_by_then.lock().expect("the flag"), Some(true));
    assert_eq!(credits(&peer).await, [(1, 8), (5, 2)]);
    peer.owner
        .run(crate::router::core::dispose)
        .await
        .expect("disposed");
}

// spec 12.4, 12.8
#[tokio::test]
async fn sets_a_transfer_s_timer_going_as_it_admits_it_never_while_it_waits() {
    use core::time::Duration;

    let peer = timed_peer_within(10).await;
    peer.receive((opening((1, 8)), Arc::from("a")));
    peer.receive((opening((3, 8)), Arc::from("a")));
    peer.settle().await;
    // a waiting opening arms its wait alone, never its inactivity
    assert_eq!(
        peer.armed(),
        [Duration::from_millis(250), Duration::from_millis(125)]
    );
    peer.clock.advance(Duration::from_millis(100)).await;
    peer.receive((
        crate::envelope::Envelope::Cancel {
            header: crate::envelope::CancelHeader { call_id: 1 },
        },
        Arc::from("a"),
    ));
    peer.settle().await;
    // the first's call held abandoned (spec 12.9), then the second's inactivity set going
    assert_eq!(credits(&peer).await, [(1, 8), (3, 8)]);
    assert_eq!(
        peer.armed(),
        [
            Duration::from_millis(250),
            Duration::from_millis(125),
            Duration::from_millis(250),
            Duration::from_millis(250)
        ]
    );
    // its inactivity runs from its admission, its wait stopped with it
    assert_eq!(peer.clock.dues(), [Duration::from_millis(250); 2]);
    peer.clock.advance(Duration::from_millis(249)).await;
    assert_eq!(failures(&peer).await, []);
    peer.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        failures(&peer).await,
        [(
            3,
            ProtocolCode::TRANSFER_STALLED.get().get(),
            "nothing came for 250 milliseconds".to_owned()
        )]
    );
    peer.owner
        .run(crate::router::core::dispose)
        .await
        .expect("disposed");
}

#[tokio::test]
async fn stops_a_transfer_s_timer_once_its_payload_is_whole_and_once_it_is_closed() {
    use core::time::Duration;

    let peer = timed_peer().await;
    peer.receive((opening((1, 2)), Arc::from("a")));
    peer.settle().await;
    peer.receive((byte((1, true)), Arc::from("a")));
    peer.settle().await;
    // the chunk that made it whole stopped its timer, and set none going
    assert_eq!(peer.armed(), [Duration::from_millis(250)]);
    assert_eq!(peer.clock.dues(), []);
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
    // the opening's and the second transfer's: none left
    assert_eq!(peer.armed(), [Duration::from_millis(250); 2]);
    assert_eq!(peer.clock.dues(), []);
    peer.clock.advance(Duration::from_millis(1_000)).await;
    assert_eq!(failures(&peer).await, []);
    peer.owner
        .run(crate::router::core::dispose)
        .await
        .expect("disposed");
}
