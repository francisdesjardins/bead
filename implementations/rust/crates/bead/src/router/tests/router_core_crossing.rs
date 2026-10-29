//! A transport that hands an envelope back inside its send: which timer the call keeps, or none.

use core::time::Duration;
use std::collections::BTreeSet;
use std::sync::Arc;

use tokio::sync::oneshot;

use super::router_core_requester::{credit, failed, limits, opening, pattern, pieces, quiet};
use crate::constants::{EnvelopeKind, FailureScope, RouterSide};
use crate::envelope::{CancelHeader, Envelope};
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{CallAddress, RouterAnswer, RouterLimitsOptions, TransportMessage};
use crate::testing::core_port::{Peer, State, completed, request_of};
use crate::testing::scripted;
use crate::transport::Sent;

fn receive(state: &mut State, envelope: &Envelope) {
    router_core::receive(
        state,
        (
            TransportMessage {
                data: scripted::bytes_of(envelope),
                ..TransportMessage::default()
            },
            &Arc::from("a"),
        ),
    );
}

// spec 10.1, 12.3
#[tokio::test]
async fn arms_no_timer_for_a_call_its_own_send_ended_by_a_failure_or_a_cancel_handed_back_as_a_chunk_went()
 {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(250)),
            ..limits()
        },
    );
    peer.owner
        .run(|state| {
            let mut handed_back = BTreeSet::new();
            state.on_transmit = Some(Box::new(move |state, envelope| {
                if let Envelope::Chunk { header, .. } = envelope
                    && handed_back.insert(header.call_id)
                {
                    let ending = if header.call_id == 2 {
                        failed(2, (21, FailureScope::Application, 0, ""))
                    } else {
                        Envelope::Cancel {
                            header: CancelHeader {
                                call_id: header.call_id,
                            },
                        }
                    };
                    receive(state, &ending);
                }
            }));
        })
        .await
        .expect("the transport hands each call its ending");
    let request = peer.request((pattern(200), request_of("a")));
    let answer = peer.respond((
        RouterAnswer::Result(pattern(150)),
        CallAddress {
            call_id: 1,
            connection_handle: Arc::from("a"),
        },
    ));
    peer.settle().await;
    peer.receive((credit(2, 92), Arc::from("a")));
    peer.receive((credit(1, 80), Arc::from("a")));
    assert!(
        matches!(completed(request).await, Err(CallError::Failure(failure)) if failure.code().get() == 21)
    );
    assert!(matches!(completed(answer).await, Err(CallError::Cancelled)));
    peer.settle().await;
    assert_eq!(peer.clock.dues(), Vec::<Duration>::new());
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| match envelope {
                Envelope::Request { header, payload } => (
                    EnvelopeKind::Request,
                    header.call_id,
                    header.total,
                    payload.len()
                ),
                Envelope::Result { header, payload } => (
                    EnvelopeKind::Result,
                    header.call_id,
                    header.total,
                    payload.len()
                ),
                Envelope::Chunk { header, payload } => (
                    EnvelopeKind::Chunk,
                    header.call_id,
                    Some(header.offset),
                    payload.len()
                ),
                other @ (Envelope::Failure { .. }
                | Envelope::Notification { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. }) => panic!("a transfer's piece expected: {other:?}"),
            })
            .collect::<Vec<_>>(),
        [
            (EnvelopeKind::Request, 2, Some(200), 44),
            (EnvelopeKind::Result, 1, Some(150), 28),
            (EnvelopeKind::Chunk, 2, Some(44), 48),
            (EnvelopeKind::Chunk, 1, Some(28), 48)
        ]
    );
    peer.clock.advance(Duration::from_secs(2)).await;
    assert_eq!(peer.sent().await.len(), 4, "no stall follows an ended call");
    quiet(&peer).await;
}

// spec 10.1, 12.3, 12.4
#[tokio::test]
async fn keeps_the_inactivity_of_a_result_that_opens_as_the_last_chunk_of_its_request_goes() {
    for hold_last_send in [false, true] {
        let peer = Peer::new(
            RouterSide::Server,
            &RouterLimitsOptions {
                transfer_inactivity_timeout: Some(Duration::from_secs(30)),
                ..limits()
            },
        );
        let (release, held) = oneshot::channel();
        peer.owner
            .run(move |state| {
                state.sending.extend([
                    Ok(Sent::Done),
                    Ok(Sent::Done),
                    Ok(Sent::Done),
                    Ok(Sent::Done),
                    if hold_last_send {
                        Ok(Sent::Later(Box::pin(async {
                            held.await.expect("the last send released")
                        })))
                    } else {
                        Ok(Sent::Done)
                    },
                ]);
                state.on_transmit = Some(Box::new(|state, envelope| {
                    if matches!(envelope, Envelope::Chunk { header, .. } if header.is_last) {
                        receive(state, &opening(2, (pattern(32), 100)));
                    }
                }));
            })
            .await
            .expect("a result opens inside the last send");
        let asked = peer.request((pattern(200), request_of("a")));
        peer.receive((credit(2, 200), Arc::from("a")));
        peer.settle().await;
        assert_eq!(peer.clock.dues(), [Duration::from_secs(30)]);
        peer.owner.run(|state| {
            assert_eq!(state.sent.iter().filter(|(_, envelope)| matches!(envelope, Envelope::Chunk { header, .. } if header.is_last)).count(), 1);
            assert_eq!(state.traces.iter().filter(|(direction, trace)| *direction == crate::debug::DebugDirection::Rx && trace.header.kind() == EnvelopeKind::Result).count(), 1);
        }).await.expect("one result opened");
        if hold_last_send {
            release.send(Ok(())).expect("the last send completes");
        }
        peer.settle().await;
        assert_eq!(peer.clock.dues(), [Duration::from_secs(30)]);
        peer.owner
            .run(router_core::dispose)
            .await
            .expect("disposed");
        assert!(matches!(
            completed(asked).await,
            Err(CallError::Disconnected(_))
        ));
        quiet(&peer).await;
    }

    let peer = Peer::new(
        RouterSide::Client,
        &RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_secs(2)),
            ..limits()
        },
    );
    let mut asked = peer.request((pattern(300), request_of("a")));
    peer.receive((credit(1, 172), Arc::from("a")));
    peer.receive((opening(1, (pattern(32), 300)), Arc::from("a")));
    peer.receive((credit(1, 300), Arc::from("a")));
    peer.settle().await;
    assert!(
        peer.sent().await.iter().any(
            |(_, envelope)| matches!(envelope, Envelope::Chunk { header, .. } if header.is_last)
        )
    );
    peer.clock.advance(Duration::from_millis(1_500)).await;
    assert!(matches!(
        asked.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    peer.clock.advance(Duration::from_millis(500)).await;
    let timed = completed(asked).await.expect_err("the result stalls");
    assert!(matches!(timed, CallError::TimedOut(delay) if delay == Duration::from_secs(2)));
    assert_eq!(timed.to_string(), "no answer came in 2000 milliseconds");
    assert_eq!(
        pieces(&peer).await.last(),
        Some(&(EnvelopeKind::Cancel, 1, None, 0))
    );
    quiet(&peer).await;
}
