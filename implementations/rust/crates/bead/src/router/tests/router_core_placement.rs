//! Payloads at their envelope's edge, and a procedure's limit held within its router's.

use std::sync::Arc;

use bytes::Bytes;

use super::router_core_requester::{limits, quiet};
use super::router_core_sessions::{handler, receive};
use super::{Handed, locked};
use crate::constants::{EnvelopeKind, ProtocolCode, RouterSide};
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, request_of, scripted_header};
use crate::testing::pair::echo;

async fn serving(maximum: Option<u64>, options: &RouterLimitsOptions) -> (Peer, Handed) {
    let peer = Peer::new(RouterSide::Server, options);
    let handed = Handed::default();
    let mut handler = handler((&handed, &Arc::default()));
    handler.maximum_payload_bytes = maximum;
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), handler, None))
                .expect("echo registered");
        })
        .await
        .expect("the port ready");
    (peer, handed)
}

// spec 12.3.2
#[tokio::test]
async fn holds_a_procedure_whose_own_limit_is_larger_to_the_routers_both_ways() {
    let (peer, handed) = serving(
        Some(1_024),
        &RouterLimitsOptions {
            maximum_payload_bytes: Some(40),
            chunk_bytes: Some(64),
            ..RouterLimitsOptions::default()
        },
    )
    .await;
    peer.receive((
        Envelope::Request {
            header: scripted_header(1),
            payload: Bytes::from(vec![0; 45]),
        },
        Arc::from("a"),
    ));
    let mut request = request_of("a");
    request.maximum_payload_bytes = Some(1_024);
    let outcome = completed(peer.request((Bytes::from(vec![0; 200]), request))).await;
    assert!(
        matches!(outcome, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "a payload is 40 bytes at most, not 200")
    );
    peer.settle().await;
    assert!(locked(&handed).is_empty());
    assert_eq!(
        super::router_core_sessions::failures(&peer).await,
        [(
            1,
            ProtocolCode::PAYLOAD_TOO_LARGE.get().get(),
            "a payload is 40 bytes at most, not 45".to_owned()
        )]
    );
    quiet(&peer).await;
}

// spec 12.3.2: u64 represents no negative, fractional or non-finite limit.
#[tokio::test]
async fn refuses_a_procedures_limit_that_is_not_a_whole_number_above_0_drawing_nothing_and_takes_its_edge()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let drawn = Arc::new(std::sync::Mutex::new(Vec::new()));
    peer.owner
        .run(|state| {
            let mut invalid = handler((&Handed::default(), &Arc::default()));
            invalid.maximum_payload_bytes = Some(0);
            let error =
                router_core::register_resolver(&state.core.resolvers, (&echo(), invalid, None))
                    .expect_err("zero is no payload limit");
            assert_eq!(
                error.message(),
                "echo's payload limit is a whole number above 0, not 0"
            );
        })
        .await
        .expect("invalid registration refused");
    let mut invalid = request_of("a");
    invalid.maximum_payload_bytes = Some(0);
    let recording = Arc::clone(&drawn);
    invalid.on_call_id = Some(Box::new(move |id| locked(&recording).push(id)));
    assert!(
        matches!(completed(peer.request((Bytes::from_static(&[1]), invalid))).await, Err(CallError::Refused(error)) if error.message() == "a payload's limit is a whole number above 0, not 0")
    );
    assert!(locked(&drawn).is_empty());
    assert!(peer.sent().await.is_empty(), "no envelope is sent");
    peer.owner
        .run(|state| {
            let mut edge = handler((&Handed::default(), &Arc::default()));
            edge.maximum_payload_bytes = Some(1);
            router_core::register_resolver(&state.core.resolvers, (&echo(), edge, None))
                .expect("one is a payload limit");
        })
        .await
        .expect("the lower edge registered");
    let mut edge = request_of("a");
    edge.maximum_payload_bytes = Some(1);
    let recording = Arc::clone(&drawn);
    edge.on_call_id = Some(Box::new(move |id| locked(&recording).push(id)));
    let accepted = peer.request((Bytes::from_static(&[1]), edge));
    peer.settle().await;
    assert_eq!(*locked(&drawn), [2]);
    assert!(
        matches!(peer.sent().await.as_slice(), [(_, Envelope::Request { payload, .. })] if payload.as_ref() == [1])
    );
    quiet(&peer).await;
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    assert!(matches!(
        completed(accepted).await,
        Err(CallError::Disconnected(_))
    ));
}

// spec 12.3
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared request and result boundaries also prove the no-transfer refusal and cleanup"
)]
async fn sends_a_payload_in_one_envelope_to_its_limit_and_one_byte_more_as_a_transfer_or_not_at_all_where_none_is_sent()
 {
    let (peer, handed) = serving(None, &limits()).await;
    let first = peer.request((Bytes::from(vec![0; 52]), request_of("a")));
    let second = peer.request((Bytes::from(vec![0; 53]), request_of("a")));
    peer.owner
        .run(|state| {
            for id in [1, 3] {
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: scripted_header(id),
                            payload: Bytes::new(),
                        },
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("two incoming calls");
    peer.settle().await;
    let answers = locked(&handed)
        .iter()
        .map(|props| Arc::clone(&props.answerer))
        .collect::<Vec<_>>();
    answers[0]
        .respond(RouterAnswer::Result(Bytes::from(vec![0; 36])))
        .await
        .expect("one envelope sent");
    let transferring = answers[1].respond(RouterAnswer::Result(Bytes::from(vec![0; 37])));
    peer.settle().await;
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
                other @ (Envelope::Failure { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. }) => panic!("a request or a result, not {other:?}"),
            })
            .collect::<Vec<_>>(),
        [
            (EnvelopeKind::Request, 2, None, 52),
            (EnvelopeKind::Request, 4, Some(53), 44),
            (EnvelopeKind::Result, 1, None, 36),
            (EnvelopeKind::Result, 3, Some(37), 28),
        ]
    );
    let (none, handed) = serving(
        None,
        &RouterLimitsOptions {
            maximum_transfers: Some(0),
            ..limits()
        },
    )
    .await;
    none.receive((
        Envelope::Request {
            header: scripted_header(1),
            payload: Bytes::new(),
        },
        Arc::from("a"),
    ));
    none.settle().await;
    let refused = completed(none.request((Bytes::from(vec![0; 53]), request_of("a")))).await;
    assert!(
        matches!(refused, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "a payload of 53 bytes goes as a transfer, which this side sends none of")
    );
    let answer = Arc::clone(&locked(&handed)[0].answerer);
    assert!(
        matches!(answer.respond(RouterAnswer::Result(Bytes::from(vec![0; 37]))).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    assert!(none.sent().await.is_empty(), "no envelope is sent");
    quiet(&peer).await;
    quiet(&none).await;
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    assert!(matches!(
        completed(first).await,
        Err(CallError::Disconnected(_))
    ));
    assert!(matches!(
        completed(second).await,
        Err(CallError::Disconnected(_))
    ));
    assert!(matches!(
        transferring.await,
        Err(CallError::Disconnected(_))
    ));
}
