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

#[test]
fn places_a_payload_whole_up_to_its_envelope_as_a_transfer_past_it_and_refuses_one_past_its_limit_a_procedures_held_within_the_routers()
 {
    use crate::envelope::{EnvelopeHeader, header_bytes_of};
    use crate::router::parts::{Placed, Placement};
    use crate::router::types::limits_of;

    let options = RouterLimitsOptions {
        buffered_bytes_budget: Some(1_024),
        maximum_payload_bytes: Some(1_024),
        ..limits()
    };
    let placement = Placement::new(RouterSide::Server, limits_of(&options).expect("the limits"));
    let header = EnvelopeHeader::Request(scripted_header(1));
    let whole = usize::try_from(placement.whole_bytes)
        .expect("a small envelope")
        .saturating_sub(header_bytes_of(&header).expect("the header fits"));
    assert_eq!(placement.whole_bytes, 64);
    assert!(matches!(
        placement.transfer_of(&Bytes::from(vec![0; whole]), (&header, 1_024)),
        Ok(Placed::Whole)
    ));
    let Ok(Placed::Transfer(transfer)) = placement.transfer_of(
        &Bytes::from(vec![0; whole.saturating_add(1)]),
        (&header, 1_024),
    ) else {
        panic!("one more byte goes as a transfer")
    };
    assert_eq!(
        transfer.total(),
        u64::try_from(whole)
            .expect("a small payload")
            .saturating_add(1)
    );
    let failure = placement
        .transfer_of(&Bytes::from(vec![0; 9]), (&header, 8))
        .expect_err("the payload exceeds its limit");
    assert_eq!(failure.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
    assert_eq!(failure.side(), Some(RouterSide::Server));
    assert_eq!(failure.scope(), crate::constants::FailureScope::Protocol);
    assert_eq!(failure.detail(), "a payload is 8 bytes at most, not 9");
    assert_eq!(
        [Some(8), Some(4_096), None].map(|bound| placement.payload_limit_of(bound)),
        [8, 1_024, 1_024]
    );
    for bound in [None, Some(1), Some(8)] {
        limits_of(&RouterLimitsOptions {
            maximum_payload_bytes: bound,
            ..RouterLimitsOptions::default()
        })
        .expect("a valid payload limit");
    }
    limits_of(&RouterLimitsOptions {
        maximum_payload_bytes: Some(0),
        ..RouterLimitsOptions::default()
    })
    .expect_err("zero is not a payload limit");
    // Option<u64> admits none, a positive integer or zero; negatives, fractions, strings and
    // null are not values of this API. Its runtime guard refuses the remaining invalid value.
}

#[test]
fn opens_every_transfer_with_one_byte_of_its_payload_at_least_and_leaves_one_at_least_past_its_opening()
 {
    use crate::envelope::{EnvelopeHeader, ResultHeader};
    use crate::router::parts::{Placed, Placement};
    use crate::router::types::limits_of;

    let mut destined = scripted_header(1);
    destined.destination_id = Some(u32::MAX);
    let headers = [
        EnvelopeHeader::Request(scripted_header(1)),
        EnvelopeHeader::Request(destined),
        EnvelopeHeader::Result(ResultHeader {
            call_id: 1,
            total: None,
            credential: None,
        }),
    ];
    for chunk_bytes in [64_u64, 1_024] {
        let placement = Placement::new(
            RouterSide::Server,
            limits_of(&RouterLimitsOptions {
                chunk_bytes: Some(chunk_bytes),
                maximum_envelope_bytes: Some(1_024),
                ..RouterLimitsOptions::default()
            })
            .expect("the limits"),
        );
        for header in &headers {
            let place = |length: u64| {
                placement
                    .transfer_of(
                        &Bytes::from(vec![0; usize::try_from(length).expect("a small payload")]),
                        (header, u64::MAX),
                    )
                    .expect("a payload within its limit")
            };
            let mut whole = 0_u64;
            while matches!(place(whole.saturating_add(1)), Placed::Whole) {
                whole = whole.saturating_add(1);
            }
            let mut transfers = 0_u32;
            for length in
                whole.saturating_add(1)..=whole.saturating_add(chunk_bytes).saturating_add(1)
            {
                let Placed::Transfer(transfer) = place(length) else {
                    panic!("{length} bytes past {whole} go whole");
                };
                let opening = u64::try_from(transfer.opening().len()).expect("an opening's length");
                assert!(opening >= 1, "{length} bytes open with none of them");
                assert!(
                    transfer.total().saturating_sub(opening) >= 1,
                    "{length} bytes open with every one of them"
                );
                transfers = transfers.saturating_add(1);
            }
            assert!(transfers >= 1, "{header:?} at {chunk_bytes} bytes a chunk");
        }
    }
}
