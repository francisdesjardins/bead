//! The requester's shared lifecycle: its timers, reservations and transfers as a call ends.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::result_of;
use super::router_core_requester::{
    chunk, credit, failed, limits, opening, pattern, pieces, quiet,
};
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode, RouterSide};
use crate::duration::NEVER;
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::parts::PendingCalls;
use crate::router::requester;
use crate::router::types::{CallAddress, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, error_of, request_of};
use crate::transport::Sent;

fn call_of(call_id: u32, handle: &str) -> CallAddress {
    CallAddress {
        call_id,
        connection_handle: Arc::from(handle),
    }
}

async fn cancel(peer: &Peer, call_id: u32) {
    peer.owner
        .run(move |state| {
            requester::cancel(state, (&call_of(call_id, "a"), None));
        })
        .await
        .expect("the call cancelled");
    peer.settle().await;
}

// spec 9.1, 10.1
#[tokio::test]
async fn times_out_and_rejects_never_throwing_what_its_payload_or_the_transport_fails_with() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let mut request = request_of("a");
    request.options.timeout = Duration::from_millis(10);
    let timing = peer.request((Bytes::new(), request));
    peer.clock.advance(Duration::from_millis(10)).await;
    let timed = completed(timing).await.expect_err("the call times out");
    assert!(matches!(timed, CallError::TimedOut(delay) if delay == Duration::from_millis(10)));
    assert_eq!(timed.to_string(), "no answer came in 10 milliseconds");
    peer.owner
        .run(|state| {
            state.sending.push_back(Err(error_of("gone")));
        })
        .await
        .expect("the transport refuses");
    assert_eq!(
        completed(peer.request((Bytes::new(), request_of("b"))))
            .await
            .expect_err("the send fails")
            .to_string(),
        "gone"
    );
    let before = peer.sent().await.len();
    let too_large = completed(peer.request((Bytes::from(vec![0; 0x100_0001]), request_of("a"))))
        .await
        .expect_err("the payload is past its limit");
    assert!(
        matches!(too_large, CallError::Failure(failure) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.origin() == crate::failure::FailureOrigin::Local)
    );
    assert_eq!(peer.sent().await.len(), before);
    let edge = peer.request((Bytes::from(vec![0; 0x100_0000]), request_of("a")));
    peer.settle().await;
    assert!(
        matches!(peer.sent().await.last(), Some((handle, Envelope::Request { header, .. })) if handle.as_ref() == "a" && header.total == Some(0x100_0000))
    );
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    assert!(matches!(
        completed(edge).await,
        Err(CallError::Disconnected(_))
    ));
    quiet(&peer).await;
}

// spec 10.1, 10.4
#[tokio::test]
async fn cancels_a_request_that_timed_out_before_its_caller_hears_so_one_made_again_goes_out_behind()
 {
    for side in [RouterSide::Client, RouterSide::Server] {
        for millis in [20, 1_000] {
            let peer = Peer::new(side, &RouterLimitsOptions::default());
            let first_id = if side == RouterSide::Client { 1 } else { 2 };
            let ask = || {
                let mut request = request_of("a");
                request.options.timeout = Duration::from_millis(millis);
                peer.request((
                    if side == RouterSide::Client {
                        Bytes::from_static(&[1])
                    } else {
                        Bytes::new()
                    },
                    request,
                ))
            };
            let first = ask();
            peer.clock.advance(Duration::from_millis(millis)).await;
            assert!(
                matches!(completed(first).await, Err(CallError::TimedOut(delay)) if delay == Duration::from_millis(millis))
            );
            let second = ask();
            peer.settle().await;
            assert_eq!(
                pieces(&peer)
                    .await
                    .iter()
                    .map(|(kind, id, _, _)| (*kind, *id))
                    .collect::<Vec<_>>(),
                [
                    (EnvelopeKind::Request, first_id),
                    (EnvelopeKind::Cancel, first_id),
                    (EnvelopeKind::Request, first_id + 2)
                ]
            );
            peer.clock.advance(Duration::from_millis(millis)).await;
            let timed = completed(second)
                .await
                .expect_err("the next call times out");
            assert!(
                matches!(timed, CallError::TimedOut(delay) if delay == Duration::from_millis(millis))
            );
            assert_eq!(
                timed.to_string(),
                format!("no answer came in {millis} milliseconds")
            );
            assert_eq!(
                pieces(&peer)
                    .await
                    .iter()
                    .map(|(kind, id, _, _)| (*kind, *id))
                    .collect::<Vec<_>>(),
                [
                    (EnvelopeKind::Request, first_id),
                    (EnvelopeKind::Cancel, first_id),
                    (EnvelopeKind::Request, first_id + 2),
                    (EnvelopeKind::Cancel, first_id + 2)
                ]
            );
            quiet(&peer).await;
        }
    }
}

// spec 10.4
#[tokio::test]
async fn reserves_a_call_id_as_long_as_its_call_was_given_or_5_s_when_it_was_given_no_time_or_waited_without_end_on_its_clock()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| {
            for (call_id, timeout) in [
                (2, None),
                (4, Some(Duration::from_millis(250))),
                (6, Some(NEVER)),
                (8, None),
            ] {
                requester::reserve(state, (&call_of(call_id, "a"), timeout));
            }
        })
        .await
        .expect("the call ids reserved");
    assert_eq!(
        peer.armed(),
        [5_000, 250, 5_000, 5_000].map(Duration::from_millis)
    );
    peer.clock.advance(Duration::from_millis(250)).await;
    peer.owner
        .run(|state| {
            assert!(state.core.pending.is_reserved(2, &Arc::from("a")));
            assert!(!state.core.pending.is_reserved(4, &Arc::from("a")));
        })
        .await
        .expect("the shorter reservation ended");
}

// spec 10.4
#[tokio::test]
async fn draws_no_call_id_reserved_and_none_at_all_when_every_one_is() {
    for last in [4, 2] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        peer.owner
            .run(move |state| {
                state.core.pending = PendingCalls::new(RouterSide::Server, Some(last));
            })
            .await
            .expect("the call id range set");
        let given = peer.request((Bytes::new(), request_of("a")));
        peer.settle().await;
        cancel(&peer, 2).await;
        assert!(matches!(completed(given).await, Err(CallError::Cancelled)));
        if last == 4 {
            for _ in 0..2 {
                let next = peer.request((Bytes::new(), request_of("a")));
                peer.receive((result_of(4, None), Arc::from("a")));
                completed(next).await.expect("call 4 answered");
            }
            assert_eq!(
                pieces(&peer)
                    .await
                    .iter()
                    .filter(|(kind, _, _, _)| *kind == EnvelopeKind::Request)
                    .map(|(_, id, _, _)| *id)
                    .collect::<Vec<_>>(),
                [2, 4, 4]
            );
        } else {
            assert!(
                matches!(completed(peer.request((Bytes::new(), request_of("a")))).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get())
            );
            assert_eq!(pieces(&peer).await.len(), 2);
        }
        quiet(&peer).await;
    }
}

// spec 10.4
#[tokio::test]
async fn reserves_by_connection_and_forgets_the_reservations_of_a_connection_or_of_every_one_as_they_go()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| requester::reserve(state, (&call_of(2, "a"), None)))
        .await
        .expect("a reserved");
    peer.receive((result_of(2, None), Arc::from("b")));
    peer.owner
        .run(|state| {
            requester::reserve(state, (&call_of(2, "b"), None));
            router_core::reject_pending(state, ("b closed", Some(&Arc::from("b"))));
        })
        .await
        .expect("b closed");
    peer.receive((result_of(2, None), Arc::from("a")));
    peer.receive((result_of(2, None), Arc::from("b")));
    peer.owner
        .run(|state| router_core::reject_pending(state, ("all closed", None)))
        .await
        .expect("all closed");
    peer.receive((result_of(2, None), Arc::from("a")));
    peer.settle().await;
    peer.owner
        .run(|state| {
            assert_eq!(
                state
                    .reports
                    .iter()
                    .map(|(handle, error)| match error {
                        crate::router::types::RouterError::Failure(failure) =>
                            (handle.as_ref(), failure.code()),
                        other @ crate::router::types::RouterError::Other(_) =>
                            panic!("a protocol failure expected: {other:?}"),
                    })
                    .collect::<Vec<_>>(),
                [
                    ("b", ProtocolCode::CALL_UNKNOWN.get()),
                    ("b", ProtocolCode::CALL_UNKNOWN.get()),
                    ("a", ProtocolCode::CALL_UNKNOWN.get())
                ]
            );
            assert!(state.core.pending.reservations.is_empty());
        })
        .await
        .expect("the reports checked");
    assert_eq!(peer.clock.dues(), Vec::<Duration>::new());
}

// spec 10.4, 12.3
#[tokio::test]
async fn stops_a_request_the_peer_answers_or_its_caller_gives_up_and_sends_nothing_more_of_it() {
    for (ending, total, timeout, initial, code, side) in [
        ("failure", 200, 1, Some(92), 21, RouterSide::Server),
        ("cancel", 200, 1, Some(92), 0, RouterSide::Server),
        ("signal", 200, 1, Some(92), 0, RouterSide::Server),
        ("failure", 300, 5, Some(100), 7, RouterSide::Client),
        ("signal", 300, 5, None, 0, RouterSide::Client),
    ] {
        let peer = Peer::new(side, &limits());
        let call_id = if side == RouterSide::Client { 1 } else { 2 };
        let signal = CancellationToken::new();
        let mut request = request_of("a");
        request.options.timeout = Duration::from_secs(timeout);
        request.options.signal = Some(signal.clone());
        let asked = peer.request((pattern(total), request));
        if let Some(initial) = initial {
            peer.receive((credit(call_id, initial), Arc::from("a")));
        }
        peer.settle().await;
        match ending {
            "failure" => peer.receive((
                failed(call_id, (code, FailureScope::Application, 0, "")),
                Arc::from("a"),
            )),
            "cancel" => cancel(&peer, call_id).await,
            "signal" => signal.cancel(),
            _ => panic!("an ending from the cases above"),
        }
        let outcome = completed(asked).await;
        if ending == "failure" {
            assert!(
                matches!(outcome, Err(CallError::Failure(failure)) if failure.code().get() == code && failure.origin() == crate::failure::FailureOrigin::Peer)
            );
        } else {
            assert!(matches!(outcome, Err(CallError::Cancelled)));
        }
        peer.receive((
            credit(call_id, u64::try_from(total).expect("a small payload")),
            Arc::from("a"),
        ));
        peer.settle().await;
        let mut expected = vec![(
            EnvelopeKind::Request,
            call_id,
            Some(u64::try_from(total).expect("a small payload")),
            44,
        )];
        if initial.is_some() {
            expected.push((EnvelopeKind::Chunk, call_id, Some(44), 48));
        }
        if ending != "failure" {
            expected.push((EnvelopeKind::Cancel, call_id, None, 0));
        }
        assert_eq!(pieces(&peer).await, expected);
        assert!(
            matches!(peer.sent().await.first(), Some((_, Envelope::Request { payload, .. })) if *payload == pattern(44))
        );
        quiet(&peer).await;
    }
}

// spec 12.3
#[tokio::test]
async fn ends_nothing_more_by_a_chunk_whose_send_failed_behind_its_answer() {
    for side in [RouterSide::Server, RouterSide::Client] {
        let peer = Peer::new(side, &limits());
        let call_id = if side == RouterSide::Client { 1 } else { 2 };
        let asked = peer.request((
            pattern(if side == RouterSide::Client { 300 } else { 200 }),
            request_of("a"),
        ));
        peer.settle().await;
        let (release, held) = oneshot::channel();
        peer.owner
            .run(move |state| {
                state.sending.push_back(Ok(Sent::Later(Box::pin(async {
                    held.await.expect("the send released")
                }))));
            })
            .await
            .expect("the chunk held");
        peer.receive((credit(call_id, 100), Arc::from("a")));
        peer.settle().await;
        if side == RouterSide::Server {
            peer.receive((
                failed(call_id, (21, FailureScope::Application, 0, "")),
                Arc::from("a"),
            ));
            assert!(
                matches!(completed(asked).await, Err(CallError::Failure(failure)) if failure.code().get() == 21)
            );
        } else {
            peer.receive((result_of(call_id, None), Arc::from("a")));
            completed(asked).await.expect("the peer answers");
        }
        release
            .send(Err(error_of("the transport lost the chunk")))
            .expect("the send fails");
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (
                    EnvelopeKind::Request,
                    call_id,
                    Some(if side == RouterSide::Client { 300 } else { 200 }),
                    44
                ),
                (EnvelopeKind::Chunk, call_id, Some(44), 48)
            ]
        );
        quiet(&peer).await;
    }
}

// spec 10.1, 12.3
#[tokio::test]
async fn waits_on_a_requests_own_timer_the_inactivity_while_it_goes_as_a_transfer_then_its_timeout_for_its_answer()
 {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(250)),
            ..limits()
        },
    );
    let small = peer.request((Bytes::new(), request_of("a")));
    let transfer = peer.request((pattern(200), request_of("a")));
    peer.receive((credit(4, 140), Arc::from("a")));
    peer.receive((credit(4, 200), Arc::from("a")));
    peer.settle().await;
    assert_eq!(
        peer.armed(),
        [1_000, 250, 250, 250, 250, 250, 250, 1_000].map(Duration::from_millis)
    );
    assert_eq!(peer.clock.dues(), [Duration::from_secs(1); 2]);
    peer.clock.advance(Duration::from_secs(1)).await;
    for asked in [small, transfer] {
        assert!(
            matches!(completed(asked).await, Err(CallError::TimedOut(delay)) if delay == Duration::from_secs(1))
        );
    }
    let sent = pieces(&peer).await;
    assert_eq!(
        &sent[sent.len() - 2..],
        [
            (EnvelopeKind::Cancel, 2, None, 0),
            (EnvelopeKind::Cancel, 4, None, 0)
        ]
    );
    quiet(&peer).await;

    let client = Peer::new(
        RouterSide::Client,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_secs(2)),
            ..limits()
        },
    );
    let mut asked = client.request((pattern(300), request_of("a")));
    client.clock.advance(Duration::from_millis(1_500)).await;
    client.receive((credit(1, 80), Arc::from("a")));
    client.settle().await;
    assert_eq!(
        pieces(&client).await,
        [(EnvelopeKind::Request, 1, Some(300), 44)]
    );
    client.clock.advance(Duration::from_millis(1_500)).await;
    assert!(matches!(
        asked.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    client.receive((credit(1, 300), Arc::from("a")));
    client.settle().await;
    assert_eq!(client.clock.dues(), [Duration::from_secs(1)]);
    client.clock.advance(Duration::from_millis(900)).await;
    assert!(matches!(
        asked.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    client.clock.advance(Duration::from_millis(100)).await;
    assert!(
        matches!(completed(asked).await, Err(CallError::TimedOut(delay)) if delay == Duration::from_secs(1))
    );
    assert_eq!(
        pieces(&client).await.last(),
        Some(&(EnvelopeKind::Cancel, 1, None, 0))
    );
    quiet(&client).await;
}

// spec 10.1
#[tokio::test]
async fn stops_a_calls_timer_as_the_call_leaves_whichever_way_so_none_keeps_the_process_waiting() {
    let peer = Peer::new(RouterSide::Server, &limits());
    let result = peer.request((Bytes::new(), request_of("a")));
    let cancelled = peer.request((Bytes::new(), request_of("a")));
    let failure = peer.request((Bytes::new(), request_of("a")));
    peer.settle().await;
    assert_eq!(peer.clock.dues(), [Duration::from_secs(1); 3]);
    peer.receive((result_of(2, None), Arc::from("a")));
    cancel(&peer, 4).await;
    peer.receive((
        failed(6, (21, FailureScope::Application, 0, "")),
        Arc::from("a"),
    ));
    completed(result).await.expect("result received");
    assert!(matches!(
        completed(cancelled).await,
        Err(CallError::Cancelled)
    ));
    assert!(
        matches!(completed(failure).await, Err(CallError::Failure(failure)) if failure.code().get() == 21)
    );
    peer.settle().await;
    assert_eq!(
        peer.clock.dues(),
        [Duration::from_secs(1)],
        "only the cancellation's reservation stays"
    );
    assert_eq!(peer.armed(), [Duration::from_secs(1); 4]);
    peer.clock.advance(Duration::from_secs(1)).await;
    assert_eq!(peer.clock.dues(), Vec::<Duration>::new());
    assert_eq!(pieces(&peer).await.len(), 4);
    quiet(&peer).await;
}

// spec 10.4, 12.4
#[tokio::test]
async fn ends_a_result_it_receives_as_its_caller_ends_the_call_its_budget_and_place_given_back_the_peer_told_its_call_id_reserved()
 {
    for ending in ["cancel", "signal", "timer"] {
        let peer = Peer::new(
            RouterSide::Server,
            &RouterLimitsOptions {
                buffered_bytes_budget: Some(200),
                maximum_payload_bytes: Some(200),
                maximum_transfers: Some(1),
                transfer_inactivity_timeout: Some(Duration::from_millis(250)),
                ..limits()
            },
        );
        let signal = CancellationToken::new();
        let mut request = request_of("a");
        request.options.signal = Some(signal.clone());
        let asked = peer.request((Bytes::new(), request));
        peer.receive((opening(2, (pattern(32), 200)), Arc::from("a")));
        peer.settle().await;
        assert_eq!(peer.clock.dues(), [Duration::from_millis(250)]);
        match ending {
            "cancel" => cancel(&peer, 2).await,
            "signal" => signal.cancel(),
            "timer" => peer.clock.advance(Duration::from_millis(250)).await,
            _ => panic!("an ending from the cases above"),
        }
        let outcome = completed(asked).await;
        if ending == "timer" {
            assert!(
                matches!(outcome, Err(CallError::TimedOut(delay)) if delay == Duration::from_millis(250))
            );
        } else {
            assert!(matches!(outcome, Err(CallError::Cancelled)));
        }
        peer.owner
            .run(|state| {
                assert!(state.core.pending.is_reserved(2, &Arc::from("a")));
                assert_eq!(
                    state.core.receivings.gauges().counts.get("bufferedBytes"),
                    Some(&0)
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
            .expect("the budget and place given back");
        let next = peer.request((Bytes::new(), request_of("a")));
        peer.receive((opening(4, (pattern(32), 200)), Arc::from("a")));
        peer.settle().await;
        cancel(&peer, 4).await;
        assert!(matches!(completed(next).await, Err(CallError::Cancelled)));
        assert_eq!(
            pieces(&peer).await,
            [
                (EnvelopeKind::Request, 2, None, 0),
                (EnvelopeKind::Credit, 2, Some(160), 0),
                (EnvelopeKind::Cancel, 2, None, 0),
                (EnvelopeKind::Request, 4, None, 0),
                (EnvelopeKind::Credit, 4, Some(160), 0),
                (EnvelopeKind::Cancel, 4, None, 0),
            ]
        );
        quiet(&peer).await;
    }
}

// spec 10.4, 12.4
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared reservation scenarios and their late-chunk boundary"
)]
async fn reserves_the_call_id_of_a_result_it_received_in_part_as_long_as_the_peer_keeps_its_call_abandoned_or_its_timeout_when_longer()
 {
    for (ending, timeout, reservation) in [
        ("whole", Some(1_000), 4_000),
        ("failure", Some(1_000), 4_000),
        ("invalid", Some(1_000), 4_000),
        ("cancel", Some(1_000), 4_000),
        ("cancel given time", Some(1_000), 9_000),
        ("signal", Some(1_000), 4_000),
        ("whole", Some(9_000), 9_000),
        ("whole", None, 5_000),
    ] {
        let peer = Peer::new(
            RouterSide::Server,
            &RouterLimitsOptions {
                transfer_inactivity_timeout: Some(Duration::from_secs(4)),
                ..limits()
            },
        );
        let signal = CancellationToken::new();
        let mut request = request_of("a");
        request.options.timeout = timeout.map_or(NEVER, Duration::from_millis);
        request.options.signal = Some(signal.clone());
        let asked = peer.request((Bytes::from_static(&[1]), request));
        peer.receive((opening(2, (pattern(32), 40)), Arc::from("a")));
        peer.settle().await;
        let before = peer.armed().len();
        match ending {
            "whole" => peer.receive((chunk(2, (pattern(8), 32, true)), Arc::from("a"))),
            "failure" => peer.receive((
                failed(2, (21, FailureScope::Application, 0, "")),
                Arc::from("a"),
            )),
            "invalid" => peer.receive((chunk(2, (pattern(9), 32, true)), Arc::from("a"))),
            "signal" => signal.cancel(),
            "cancel" | "cancel given time" => {
                peer.owner
                    .run(move |state| {
                        requester::cancel(
                            state,
                            (
                                &call_of(2, "a"),
                                (ending == "cancel given time").then_some(Duration::from_secs(9)),
                            ),
                        );
                    })
                    .await
                    .expect("cancelled");
            }
            _ => panic!("an ending from the cases above"),
        }
        let outcome = completed(asked).await;
        match ending {
            "whole" => assert_eq!(
                outcome.expect("the result is whole").payload,
                [pattern(32), pattern(8)].concat()
            ),
            "failure" | "invalid" => {
                let (code, origin) = if ending == "failure" {
                    (21, crate::failure::FailureOrigin::Peer)
                } else {
                    (
                        ProtocolCode::CHUNK_INVALID.get().get(),
                        crate::failure::FailureOrigin::Local,
                    )
                };
                assert!(
                    matches!(outcome, Err(CallError::Failure(failure)) if failure.code().get() == code && failure.origin() == origin)
                );
            }
            _ => assert!(matches!(outcome, Err(CallError::Cancelled))),
        }
        peer.settle().await;
        assert_eq!(
            &peer.armed()[before..],
            [Duration::from_millis(reservation)],
            "{ending}, {timeout:?}"
        );
        assert_eq!(peer.clock.dues(), [Duration::from_millis(reservation)]);
        quiet(&peer).await;
    }

    let client = Peer::new(
        RouterSide::Client,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_secs(2)),
            ..limits()
        },
    );
    client
        .owner
        .run(|state| {
            state.core.pending = PendingCalls::new(RouterSide::Client, Some(3));
        })
        .await
        .expect("two call ids");
    let signal = CancellationToken::new();
    let mut request = request_of("a");
    request.options.signal = Some(signal.clone());
    let asked = client.request((Bytes::from_static(&[1]), request));
    client.receive((opening(1, (pattern(32), 300)), Arc::from("a")));
    client.settle().await;
    signal.cancel();
    assert!(matches!(completed(asked).await, Err(CallError::Cancelled)));
    client.clock.advance(Duration::from_millis(1_500)).await;
    client.receive((chunk(1, (pattern(48), 32, false)), Arc::from("a")));
    client.settle().await;
    quiet(&client).await;
    let mut request = request_of("a");
    request.options.timeout = Duration::from_secs(5);
    let next = client.request((Bytes::from_static(&[1]), request));
    client.settle().await;
    assert!(
        matches!(client.sent().await.last(), Some((_, Envelope::Request { header, .. })) if header.call_id == 3)
    );
    client.clock.advance(Duration::from_millis(500)).await;
    client.receive((chunk(1, (pattern(48), 32, false)), Arc::from("a")));
    client.settle().await;
    client.owner.run(|state| {
        assert!(matches!(state.reports.as_slice(), [(handle, crate::router::types::RouterError::Failure(failure))] if handle.as_ref() == "a" && failure.code() == ProtocolCode::CALL_UNKNOWN.get()));
        router_core::dispose(state);
    }).await.expect("the late chunk reported");
    assert!(matches!(
        completed(next).await,
        Err(CallError::Disconnected(_))
    ));
}

// spec 9.1, 11
#[tokio::test]
async fn says_whether_its_requests_open_a_subscription_and_whether_it_is_paced() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let mut calls = Vec::new();
    for (opens, paced) in [
        (true, false),
        (false, false),
        (false, false),
        (true, true),
        (true, false),
    ] {
        let mut request = request_of("a");
        request.opens_subscription = opens;
        request.paced = paced;
        calls.push(peer.request((Bytes::new(), request)));
    }
    peer.settle().await;
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(handle, envelope)| match envelope {
                Envelope::Request { header, payload } => {
                    assert_eq!(handle.as_ref(), "a");
                    assert!(payload.is_empty());
                    assert_eq!((header.service_id, header.procedure_id), (2, 1));
                    assert_eq!(
                        (
                            header.destination_id,
                            header.total,
                            header.credential.as_ref()
                        ),
                        (None, None, None)
                    );
                    (header.call_id, header.opens_subscription, header.paced)
                }
                other @ (Envelope::Result { .. }
                | Envelope::Failure { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. }) => panic!("a request expected: {other:?}"),
            })
            .collect::<Vec<_>>(),
        [
            (2, true, false),
            (4, false, false),
            (6, false, false),
            (8, true, true),
            (10, true, false)
        ]
    );
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    for call in calls {
        assert!(matches!(
            completed(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
    quiet(&peer).await;
}

// spec 9.1
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared hand-off and refusal scenarios, with their callback orderings"
)]
async fn hears_its_request_handed_to_the_transport_whole_or_its_transfers_opening_then_refused_by_it_and_nothing_of_one_never_handed()
 {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            maximum_payload_bytes: Some(1_024),
            buffered_bytes_budget: Some(1_024),
            ..limits()
        },
    );
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ask = |length, handle: &str| {
        let telling = Arc::clone(&heard);
        let handle = handle.to_owned();
        let mut request = request_of(&handle);
        request.on_sent = Some(Box::new(move |handed| {
            telling
                .lock()
                .expect("sent events")
                .push((length, handle.clone(), handed));
        }));
        peer.request((pattern(length), request))
    };
    let (first, first_send) = oneshot::channel();
    let (second, second_send) = oneshot::channel();
    peer.owner
        .run(move |state| {
            state.sending.extend([first_send, second_send].map(|held| {
                Ok(Sent::Later(Box::pin(async {
                    held.await.expect("the send released")
                })))
            }));
        })
        .await
        .expect("the sends held");
    let refused = [ask(8, "a"), ask(200, "a")];
    peer.settle().await;
    assert_eq!(
        *heard.lock().expect("sent events"),
        [(8, "a".to_owned(), true), (200, "a".to_owned(), true)]
    );
    first
        .send(Err(error_of("the socket is closed")))
        .expect("first refused");
    peer.settle().await;
    second
        .send(Err(error_of("the socket is closed")))
        .expect("second refused");
    for request in refused {
        assert_eq!(
            completed(request)
                .await
                .expect_err("the send refused")
                .to_string(),
            "the socket is closed"
        );
    }
    peer.settle().await;
    assert_eq!(
        *heard.lock().expect("sent events"),
        [
            (8, "a".to_owned(), true),
            (200, "a".to_owned(), true),
            (8, "a".to_owned(), false),
            (200, "a".to_owned(), false)
        ]
    );
    heard.lock().expect("sent events").clear();
    peer.owner
        .run(|state| {
            state.sending.extend([
                Ok(Sent::Done),
                Ok(Sent::Done),
                Err(error_of("the transport is closing")),
            ]);
        })
        .await
        .expect("two sends accepted and one refused outright");
    let small = ask(8, "a");
    let transfer = ask(200, "a");
    let too_large = ask(2_000, "a");
    let refused = ask(8, "b");
    assert!(
        matches!(completed(too_large).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    assert_eq!(
        completed(refused)
            .await
            .expect_err("the transport refuses outright")
            .to_string(),
        "the transport is closing"
    );
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    for request in [small, transfer] {
        assert!(matches!(
            completed(request).await,
            Err(CallError::Disconnected(_))
        ));
    }
    assert_eq!(
        *heard.lock().expect("sent events"),
        [(8, "a".to_owned(), true), (200, "a".to_owned(), true)]
    );
    assert_eq!(peer.sent().await.len(), 5);
    quiet(&peer).await;
}
