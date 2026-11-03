//! An unreadable chunk ends only the transfer it belongs to, never a whole or abandoned call.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::router_core_requester::opening as result_opening;
use super::router_core_sessions::receive;
use super::router_core_transfer_edges::{chunk, limits, opening, serving};
use super::router_core_transfer_refusals::{pattern, reports};
use crate::constants::{EnvelopeKind, ProtocolCode, RouterSide};
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, TransportMessage};
use crate::testing::core_port::{Peer, State, completed, request_of};
use crate::testing::hexadecimal;

fn raw(state: &mut State, text: &str) {
    router_core::receive(
        state,
        (
            TransportMessage {
                data: Bytes::from(
                    hexadecimal::bytes_of(text).expect("the malformed envelope's bytes"),
                ),
                ..TransportMessage::default()
            },
            &Arc::from("a"),
        ),
    );
}

fn unreadable(state: &mut State, call_id: u32) {
    raw(
        state,
        &format!("A1 14 40 04  00 00 00 {call_id:02X}  00 20 00 00 00 00 00 00 | 01"),
    );
}

async fn traffic(peer: &Peer) -> Vec<(EnvelopeKind, u32, u64)> {
    peer.sent()
        .await
        .into_iter()
        .map(|(handle, envelope)| {
            assert_eq!(handle.as_ref(), "a");
            let value = match &envelope {
                Envelope::Credit { header } => header.credit_end,
                Envelope::Failure { failure, .. } => u64::from(failure.code.get()),
                Envelope::Request { .. }
                | Envelope::Result { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Cancel { .. } => 0,
            };
            (envelope.kind(), envelope.call_id(), value)
        })
        .collect()
}

fn invalid(outcome: Result<crate::RouterResult, CallError>, side: RouterSide) {
    let Err(CallError::Failure(failure)) = outcome else {
        panic!("the unreadable chunk ends its transfer: {outcome:?}");
    };
    assert_eq!(failure.code(), ProtocolCode::CHUNK_INVALID.get());
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(side));
}

#[tokio::test]
async fn end_the_transfer_a_chunk_that_does_not_read_was_for_but_where_it_is_late_or_its_payload_whole()
 {
    simultaneous().await;
    unreadable_result().await;
    whole_and_abandoned().await;
}

async fn simultaneous() {
    let (peer, handed) = serving(false, &limits()).await;
    let asking = peer.request((Bytes::new(), request_of("a")));
    peer.owner
        .run(|state| {
            let payload = pattern((200, false));
            receive(state, (opening(1, (payload.slice(..40), 200)), "a", None));
            receive(
                state,
                (result_opening(2, (payload.slice(..32), 200)), "a", None),
            );
            receive(state, (opening(3, (payload.slice(..40), 60)), "a", None));
            receive(
                state,
                (chunk(3, (40, payload.slice(40..60), 60)), "a", None),
            );
            for call_id in [1, 1, 2, 2, 3, 5] {
                raw(
                    state,
                    &format!("A1 14 00 04  00 00 00 {call_id:02X}  00 00 00 00 00 00 00 00"),
                );
            }
            raw(
                state,
                "A1 15 00 04  00 00 00 01  00 00 00 00 00 00 00 08  01",
            );
            receive(
                state,
                (chunk(3, (50, Bytes::from(vec![0; 20]), 1_024)), "a", None),
            );
        })
        .await
        .expect("unreadable chunks and a credit received");
    peer.settle().await;
    let answerer = {
        let seen = locked(&handed);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].header.call_id, 3);
        assert_eq!(seen[0].header.total, Some(60));
        assert_eq!(seen[0].payload, pattern((200, false)).slice(..60));
        Arc::clone(&seen[0].answerer)
    };
    answerer
        .respond(RouterAnswer::Result(Bytes::from_static(&[9])))
        .await
        .expect("the whole request answered");
    invalid(completed(asking).await, RouterSide::Server);
    assert_eq!(
        traffic(&peer).await,
        [
            (EnvelopeKind::Request, 2, 0),
            (EnvelopeKind::Credit, 1, 168),
            (EnvelopeKind::Credit, 2, 160),
            (EnvelopeKind::Credit, 3, 60),
            (
                EnvelopeKind::Failure,
                1,
                u64::from(ProtocolCode::CHUNK_INVALID.get().get())
            ),
            (EnvelopeKind::Cancel, 2, 0),
            (EnvelopeKind::Result, 3, 0),
        ]
    );
    let sent = peer.sent().await;
    assert!(
        matches!(&sent.last().expect("the result").1, Envelope::Result { payload, .. } if payload.as_ref() == [9])
    );
    assert_eq!(
        reports(&peer).await,
        [
            ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
            ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
            ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
            ("a".to_owned(), ProtocolCode::CHUNK_INVALID),
        ]
    );
}

async fn unreadable_result() {
    let peer = Peer::new(RouterSide::Client, &limits());
    let mut options = request_of("a");
    options.options.timeout = core::time::Duration::from_secs(5);
    let asking = peer.request((Bytes::from_static(&[1]), options));
    peer.owner
        .run(|state| {
            receive(
                state,
                (
                    result_opening(1, (pattern((300, false)).slice(..32), 300)),
                    "a",
                    None,
                ),
            );
            unreadable(state, 1);
        })
        .await
        .expect("the oversized offset received");
    invalid(completed(asking).await, RouterSide::Client);
    assert_eq!(
        traffic(&peer).await,
        [
            (EnvelopeKind::Request, 1, 0),
            (EnvelopeKind::Credit, 1, 160),
            (EnvelopeKind::Cancel, 1, 0),
        ]
    );
    peer.owner
        .run(|state| unreadable(state, 1))
        .await
        .expect("the reserved call's late chunk");
    assert_eq!(reports(&peer).await, []);
    peer.owner
        .run(|state| unreadable(state, 5))
        .await
        .expect("an unknown call's unreadable chunk");
    assert_eq!(
        reports(&peer).await,
        [("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED)]
    );
}

async fn whole_and_abandoned() {
    let (peer, handed) = serving(false, &limits()).await;
    peer.owner
        .run(|state| {
            let payload = pattern((100, false));
            receive(state, (opening(1, (payload.slice(..44), 100)), "a", None));
            receive(
                state,
                (chunk(1, (44, payload.slice(44..92), 100)), "a", None),
            );
            receive(state, (chunk(1, (92, payload.slice(92..), 100)), "a", None));
            unreadable(state, 1);
            assert_eq!(state.reports.len(), 1);
            receive(state, (opening(3, (payload.slice(..44), 100)), "a", None));
            receive(
                state,
                (chunk(3, (44, payload.slice(44..64), 100)), "a", None),
            );
            unreadable(state, 3);
            assert_eq!(state.reports.len(), 1);
            unreadable(state, 5);
        })
        .await
        .expect("whole and abandoned transfers receive unreadable chunks");
    peer.settle().await;
    assert_eq!(
        reports(&peer).await,
        [
            ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
            ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
        ]
    );
    assert_eq!(
        traffic(&peer).await,
        [
            (EnvelopeKind::Credit, 1, 100),
            (EnvelopeKind::Credit, 3, 100),
            (
                EnvelopeKind::Failure,
                3,
                u64::from(ProtocolCode::CHUNK_INVALID.get().get())
            ),
        ]
    );
    let seen = locked(&handed);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header.call_id, 1);
    assert_eq!(seen[0].payload, pattern((100, false)));
}
