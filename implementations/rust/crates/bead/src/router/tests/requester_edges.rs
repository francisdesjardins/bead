//! An answer received within the turn that cancels its signal, through the core's scripted port.

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
        assert!(matches!(completed(asked).await, Err(CallError::Cancelled)));
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
