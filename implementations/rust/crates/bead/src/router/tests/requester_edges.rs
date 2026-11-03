//! Late answers, a cancelled request whose cancel fails, and an answer received within the turn
//! that cancels its signal, through the core's scripted port.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::constants::{EnvelopeKind, ProtocolCode, RouterSide};
use crate::envelope::{Envelope, ResultHeader};
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{RouterError, RouterLimitsOptions, TransportMessage};
use crate::testing::core_port::{Peer, completed, request_of};
use crate::testing::scripted::bytes_of;

fn result(call_id: u32) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential: None,
        },
        payload: Bytes::new(),
    }
}

// Both sides of the union: the C# client on 1 and TypeScript's server on 2.
async fn late_answer() {
    for (side, call_id, payload) in [
        (RouterSide::Client, 1, Bytes::from_static(&[1])),
        (RouterSide::Server, 2, Bytes::new()),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let asked = peer.request((payload, request_of("a")));
        peer.settle().await;
        peer.clock.advance(Duration::from_secs(1)).await;
        assert!(
            matches!(completed(asked).await, Err(CallError::TimedOut(timeout))
            if timeout == Duration::from_secs(1))
        );
        peer.receive((result(call_id), Arc::from("a")));
        peer.settle().await;
        peer.owner
            .run(|state| assert!(state.reports.is_empty()))
            .await
            .expect("the port");
        peer.clock.advance(Duration::from_secs(1)).await;
        peer.owner
            .run(move |state| {
                assert!(!state.core.pending.is_reserved(call_id, &Arc::from("a")));
            })
            .await
            .expect("the reservation ended");
        peer.receive((result(call_id), Arc::from("a")));
        peer.settle().await;
        peer.owner
            .run(|state| {
                assert_eq!(state.reports.len(), 1);
                let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                    panic!("a protocol report")
                };
                assert_eq!(handle.as_ref(), "a");
                assert_eq!(failure.code(), ProtocolCode::CALL_UNKNOWN.get());
            })
            .await
            .expect("the late answer reported");
    }
}

#[tokio::test]
async fn take_an_answer_too_late_in_silence_while_its_call_id_is_reserved_then_report_it() {
    late_answer().await;
}

#[tokio::test]
async fn drops_a_late_answer_while_its_call_id_is_reserved_then_reports_it() {
    late_answer().await;
}

async fn refused_cancel() {
    for (side, call_id, words) in [
        (RouterSide::Client, 1, "the transport refused the cancel"),
        (RouterSide::Server, 2, "gone"),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let token = CancellationToken::new();
        let mut request = request_of("a");
        request.options.timeout = Duration::from_secs(5);
        request.options.signal = Some(token.clone());
        let asked = peer.request((Bytes::from_static(&[1]), request));
        peer.settle().await;
        let refused: Arc<dyn std::error::Error + Send + Sync> =
            Arc::new(std::io::Error::other(words));
        let sending = Arc::clone(&refused);
        peer.owner
            .run(move |state| {
                state.sending.push_back(Err(RouterError::Other(sending)));
            })
            .await
            .expect("the next send refuses");
        token.cancel();
        assert!(matches!(
            completed(asked).await,
            Err(CallError::Cancelled(_))
        ));
        peer.settle().await;
        assert_eq!(
            peer.sent()
                .await
                .iter()
                .map(|(handle, envelope)| (handle.as_ref(), envelope.kind(), envelope.call_id()))
                .collect::<Vec<_>>(),
            [
                ("a", EnvelopeKind::Request, call_id),
                ("a", EnvelopeKind::Cancel, call_id)
            ]
        );
        peer.owner
            .run(move |state| {
                assert_eq!(state.reports.len(), 1);
                let (handle, RouterError::Other(error)) = &state.reports[0] else {
                    panic!("the transport's report")
                };
                assert_eq!(handle.as_ref(), "a");
                assert_eq!(error.to_string(), words);
                assert!(Arc::ptr_eq(error, &refused));
            })
            .await
            .expect("the very transport error reported");
    }
}

#[tokio::test]
async fn cancel_a_request_its_signal_gives_up_once_sent_rejecting_with_its_own_reason_though_the_cancel_fails()
 {
    refused_cancel().await;
}

#[tokio::test]
async fn cancels_on_its_token_once_sent_throwing_its_own_reason_though_the_cancel_cannot_go_out() {
    refused_cancel().await;
}

async fn answered_as_cancelled() {
    for (side, call_id) in [(RouterSide::Client, 1), (RouterSide::Server, 2)] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let token = CancellationToken::new();
        let mut request = request_of("a");
        request.options.signal = Some(token.clone());
        let asked = peer.request((Bytes::from_static(&[1]), request));
        peer.settle().await;
        peer.owner
            .run(move |state| {
                // The result is read before the cancellation's deferred owner operation can run.
                token.cancel();
                router_core::receive(
                    state,
                    (
                        TransportMessage {
                            data: bytes_of(&result(call_id)),
                            ..TransportMessage::default()
                        },
                        &Arc::from("a"),
                    ),
                );
            })
            .await
            .expect("cancelled and answered within one turn");
        assert!(matches!(
            completed(asked).await,
            Err(CallError::Cancelled(_))
        ));
        peer.settle().await;
        assert_eq!(
            peer.sent()
                .await
                .iter()
                .map(|(_, envelope)| envelope.kind())
                .collect::<Vec<_>>(),
            [EnvelopeKind::Request]
        );
        peer.owner
            .run(move |state| {
                assert!(!state.core.pending.is_reserved(call_id, &Arc::from("a")));
            })
            .await
            .expect("no reservation");
        peer.receive((result(call_id), Arc::from("a")));
        peer.settle().await;
        peer.owner
            .run(|state| {
                assert_eq!(state.reports.len(), 1);
                let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                    panic!("a protocol report")
                };
                assert_eq!(handle.as_ref(), "a");
                assert_eq!(failure.code(), ProtocolCode::CALL_UNKNOWN.get());
            })
            .await
            .expect("the repeated answer finds no call");
    }
}

#[tokio::test]
async fn send_no_cancel_for_a_call_answered_in_the_turn_its_signal_gives_it_up_nor_reserve_its_call_id()
 {
    answered_as_cancelled().await;
}

#[tokio::test]
async fn sends_no_cancel_for_a_call_answered_in_the_turn_its_token_is_cancelled_nor_reserves_its_call_id()
 {
    answered_as_cancelled().await;
}

async fn malformed_reserved_answer() {
    for (side, call_id, malformed, future) in [
        (
            RouterSide::Client,
            1,
            "A1 12 00 02 00 00 00 01 00",
            "A2 11 00 02 00 00 00 01",
        ),
        (
            RouterSide::Server,
            2,
            "A1 12 00 02 00 00 00 02 00 13 00",
            "A2 12 00 02 00 00 00 02 00 13 00 00",
        ),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        peer.owner
            .run(move |state| {
                crate::router::requester::reserve(
                    state,
                    (
                        &crate::router::types::CallAddress {
                            connection_handle: Arc::from("a"),
                            call_id,
                        },
                        Some(Duration::from_secs(5)),
                    ),
                );
            })
            .await
            .expect("the id reserved");
        let bytes = crate::testing::hexadecimal::bytes_of(malformed).expect("the malformed bytes");
        peer.owner
            .run(move |state| {
                router_core::receive(
                    state,
                    (
                        TransportMessage {
                            data: Bytes::from(bytes),
                            ..TransportMessage::default()
                        },
                        &Arc::from("a"),
                    ),
                );
                assert!(state.reports.is_empty());
            })
            .await
            .expect("this layout's answer dropped in silence");
        let bytes =
            crate::testing::hexadecimal::bytes_of(future).expect("the future layout's bytes");
        peer.owner
            .run(move |state| {
                router_core::receive(
                    state,
                    (
                        TransportMessage {
                            data: Bytes::from(bytes),
                            ..TransportMessage::default()
                        },
                        &Arc::from("a"),
                    ),
                );
                assert_eq!(state.reports.len(), 1);
                let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                    panic!("the layout's report")
                };
                assert_eq!(handle.as_ref(), "a");
                assert_eq!(failure.code(), ProtocolCode::LAYOUT_UNSUPPORTED.get());
            })
            .await
            .expect("the untrusted layout reported");
        assert_eq!(peer.sent().await, []);
    }
}

#[tokio::test]
async fn take_an_answer_of_this_layout_that_does_not_read_on_a_call_id_reserved_in_silence_and_report_one_of_a_layout_to_come()
 {
    malformed_reserved_answer().await;
}

#[tokio::test]
async fn drops_an_answer_that_does_not_read_on_a_call_id_reserved_and_reports_one_of_a_layout_to_come()
 {
    malformed_reserved_answer().await;
}

async fn signal_cancellation() {
    for (side, call_id) in [(RouterSide::Client, 1), (RouterSide::Server, 2)] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let token = CancellationToken::new();
        let drawn = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cancellable = || {
            let mut request = request_of("a");
            request.options.signal = Some(token.clone());
            let drawn = Arc::clone(&drawn);
            request.on_call_id = Some(Box::new(move |id| {
                drawn.lock().expect("drawn ids").push(id);
            }));
            request
        };
        let asked = peer.request((Bytes::new(), cancellable()));
        peer.settle().await;
        token.cancel();
        assert!(matches!(
            completed(asked).await,
            Err(CallError::Cancelled(_))
        ));
        assert_eq!(
            peer.sent().await,
            [
                (
                    Arc::from("a"),
                    Envelope::Request {
                        header: crate::testing::core_port::scripted_header(call_id),
                        payload: Bytes::new(),
                    }
                ),
                (
                    Arc::from("a"),
                    Envelope::Cancel {
                        header: crate::envelope::CancelHeader { call_id },
                    }
                ),
            ]
        );
        peer.receive((result(call_id), Arc::from("a")));
        peer.settle().await;
        peer.owner
            .run(|state| {
                assert!(state.reports.is_empty());
                state.sent.clear();
            })
            .await
            .expect("the late answer dropped");
        let already = peer.request((Bytes::new(), cancellable()));
        assert!(matches!(
            completed(already).await,
            Err(CallError::Cancelled(_))
        ));
        peer.settle().await;
        assert_eq!(peer.sent().await, []);
        assert_eq!(*drawn.lock().expect("drawn ids"), [call_id]);
    }
}

#[tokio::test]
async fn are_cancelled_by_their_signal_at_once_drawing_nothing_or_once_sent_telling_the_peer() {
    signal_cancellation().await;
}

#[tokio::test]
async fn cancels_its_requests_by_their_token_at_once_drawing_nothing_or_once_sent_telling_the_peer()
{
    signal_cancellation().await;
}

async fn disconnected_requests() {
    for (side, call_id, payload) in [
        (RouterSide::Client, 3, Bytes::from_static(&[1])),
        (RouterSide::Server, 4, Bytes::new()),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let gone = peer.request((payload.clone(), request_of("a")));
        let kept = peer.request((payload.clone(), request_of("b")));
        let mut again = peer.request((payload, request_of("b")));
        peer.settle().await;
        peer.owner
            .run(|state| {
                router_core::reject_pending(state, ("a closed", Some(&Arc::from("a"))));
            })
            .await
            .expect("a closed");
        assert!(
            matches!(completed(gone).await, Err(CallError::Disconnected(reason)) if reason == "a closed")
        );
        assert!(matches!(
            again.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        peer.receive((result(call_id), Arc::from("b")));
        assert_eq!(
            completed(kept).await.expect("b's result").header.call_id,
            call_id
        );
        peer.owner
            .run(|state| {
                router_core::reject_pending(state, ("all gone", None));
            })
            .await
            .expect("all closed");
        assert!(
            matches!(completed(again).await, Err(CallError::Disconnected(reason)) if reason == "all gone")
        );
        peer.owner
            .run(|state| {
                assert!(state.reports.is_empty());
                assert_eq!(state.core.pending.gauges().counts["pendingCalls"], 0);
            })
            .await
            .expect("nothing pending");
    }
}

#[tokio::test]
async fn are_rejected_with_a_disconnect_error_those_of_one_connection_or_all() {
    disconnected_requests().await;
}

#[tokio::test]
async fn rejects_with_a_disconnect_exception_what_waits_on_one_connection_or_on_every_one() {
    disconnected_requests().await;
}

#[tokio::test]
async fn cancel_a_call_still_waiting_once_rejected_told_and_its_call_id_reserved_on_its_connection_alone()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let asked = peer.request((Bytes::new(), request_of("a")));
    peer.settle().await;
    peer.owner
        .run(|state| {
            let call = crate::router::types::CallAddress {
                connection_handle: Arc::from("a"),
                call_id: 2,
            };
            crate::router::requester::cancel(state, (&call, None));
            crate::router::requester::cancel(state, (&call, None));
            assert!(state.core.pending.is_reserved(2, &Arc::from("a")));
            assert!(!state.core.pending.is_reserved(2, &Arc::from("b")));
        })
        .await
        .expect("cancelled twice");
    assert!(matches!(
        completed(asked).await,
        Err(CallError::Cancelled(_))
    ));
    assert_eq!(
        peer.sent().await,
        [
            (
                Arc::from("a"),
                Envelope::Request {
                    header: crate::testing::core_port::scripted_header(2),
                    payload: Bytes::new(),
                }
            ),
            (
                Arc::from("a"),
                Envelope::Cancel {
                    header: crate::envelope::CancelHeader { call_id: 2 },
                }
            ),
        ]
    );
}
