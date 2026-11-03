//! A transfer laid out and put together: the spec's 20 MiB byte by byte, and the runs of bytes
//! apart a receiver holds at most.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use bytes::Bytes;

use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{
    ChunkHeader, Credential, CreditHeader, Envelope, EnvelopeHeader, RequestHeader, ResultHeader,
    header_bytes_of, write_envelope,
};
use crate::router::parts::{Placed, Placement};
use crate::router::transfer::{ChunkOutcome, IncomingBounds, IncomingTransfer, OutgoingTransfer};
use crate::router::types::LIMIT_DEFAULTS;
use crate::testing::hexadecimal;

#[test]
fn clamps_an_outgoing_opening_to_its_payload_and_sends_no_chunk_past_its_end() {
    for opening in [3, 4, u64::MAX] {
        let mut outgoing = OutgoingTransfer::new(Bytes::from_static(b"abc"), (opening, 8));
        assert_eq!(outgoing.opening(), Bytes::from_static(b"abc"));
        assert_eq!(outgoing.credit_end(), 3);
        outgoing.grant(u64::MAX);
        assert_eq!(outgoing.next_chunk(), None);
    }
}

// bytes that differ from one to the next, so a byte out of place shows
fn pattern_of(length: usize) -> Bytes {
    Bytes::from(
        (0..length)
            .map(|index| {
                u8::try_from(index.saturating_mul(7).saturating_add(index >> 8) % 251)
                    .expect("a pattern byte")
            })
            .collect::<Vec<u8>>(),
    )
}

fn hexadecimal_of(bytes: &[u8], count: usize) -> String {
    hexadecimal::text_of(bytes.get(..count).unwrap_or(bytes))
}

fn written(envelope: &Envelope) -> Bytes {
    write_envelope(envelope, 1_024).expect("an envelope written")
}

// spec 12.11
#[test]
fn lays_the_spec_s_20_mib_out_byte_by_byte_its_opening_a_credit_a_chunk_with_more_the_last() {
    const TOTAL: u64 = 20_971_520;

    let limits = LIMIT_DEFAULTS;
    let placement = Placement::new(RouterSide::Client, limits);
    let payload = pattern_of(usize::try_from(TOTAL).unwrap_or(0));
    let request = RequestHeader {
        call_id: 7,
        service_id: 2,
        procedure_id: 5,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: None,
    };
    let Ok(Placed::Transfer(mut outgoing)) = placement.transfer_of(
        &payload,
        (
            &EnvelopeHeader::Request(request.clone()),
            limits.maximum_payload_bytes * 2,
        ),
    ) else {
        panic!("20 MiB goes as a transfer");
    };
    let opening = written(&Envelope::Request {
        header: RequestHeader {
            total: Some(TOTAL),
            ..request
        },
        payload: outgoing.opening(),
    });

    assert_eq!(opening.len(), 1_048_576, "its opening fills a chunk");
    assert_eq!(
        hexadecimal_of(&opening, 20),
        "A1 10 04 05 00 00 00 07 00 02 00 05 00 00 00 00 01 40 00 00",
        "its opening's header"
    );

    let mut incoming = IncomingTransfer::new(
        &outgoing.opening(),
        (
            TOTAL,
            IncomingBounds {
                side: RouterSide::Server,
                maximum_chunk_runs: limits.maximum_chunk_runs,
                window_bytes: limits.window_bytes,
                payload_bytes_per_chunk: placement.payload_bytes_per_chunk,
            },
        ),
    )
    .expect("its opening placed");
    let credit_end = incoming.credit_to_grant(u64::MAX).unwrap_or(0);

    assert_eq!(credit_end, 5_242_860, "a window past its opening");
    assert_eq!(
        hexadecimal::text_of(&written(&Envelope::Credit {
            header: CreditHeader {
                call_id: 7,
                credit_end,
                paced: false,
            },
        })),
        "A1 15 00 04 00 00 00 07 00 00 00 00 00 4F FF EC",
        "its credit"
    );

    outgoing.grant(credit_end);

    let mut chunks = Vec::new();

    while let Some(chunk) = outgoing.next_chunk() {
        chunks.push(chunk);
    }

    // four full chunks under the credit; the fifth would pass it, so it waits
    assert_eq!(
        chunks.iter().map(|chunk| chunk.offset).collect::<Vec<_>>(),
        [1_048_556, 2_097_116, 3_145_676, 4_194_236],
        "four under the credit"
    );

    let first = chunks.first().cloned().expect("a chunk");

    assert_eq!(
        hexadecimal_of(
            &written(&Envelope::Chunk {
                header: ChunkHeader {
                    call_id: 7,
                    offset: first.offset,
                    is_last: false,
                },
                payload: first.bytes,
            }),
            16
        ),
        "A1 14 40 04 00 00 00 07 00 00 00 00 00 0F FF EC",
        "a chunk with more"
    );

    outgoing.grant(TOTAL);

    let mut count = 4;
    let mut last = outgoing.next_chunk().expect("a chunk");

    while !last.is_last {
        count += 1;
        last = outgoing.next_chunk().expect("a chunk");
    }

    // 19 full chunks after the opening, then 324 bytes
    assert_eq!(count, 19, "19 full chunks");
    assert_eq!(last.offset, 20_971_196, "the last's offset");
    assert_eq!(last.bytes.len(), 324, "the last's bytes");
    assert_eq!(
        hexadecimal_of(
            &written(&Envelope::Chunk {
                header: ChunkHeader {
                    call_id: 7,
                    offset: last.offset,
                    is_last: true,
                },
                payload: last.bytes,
            }),
            16
        ),
        "A1 14 00 04 00 00 00 07 00 00 00 00 01 3F FE BC",
        "the last chunk"
    );
    assert_eq!(outgoing.next_chunk(), None, "nothing after the last");
}

// spec 12.6.5
#[test]
fn refuses_more_runs_of_bytes_apart_than_its_bound_one_byte_at_a_time() {
    let mut incoming = IncomingTransfer::new(
        &pattern_of(1),
        (
            20,
            IncomingBounds {
                side: RouterSide::Server,
                maximum_chunk_runs: 3,
                window_bytes: 40,
                payload_bytes_per_chunk: 1,
            },
        ),
    )
    .expect("its opening placed");
    let one = Bytes::from_static(&[1]);

    incoming.credit_to_grant(u64::MAX);

    assert_eq!(
        incoming
            .place(&one, (false, 2))
            .map_err(|failure| failure.protocol_code()),
        Ok(ChunkOutcome::Placed),
        "a second run"
    );
    assert_eq!(
        incoming
            .place(&one, (false, 4))
            .map_err(|failure| failure.protocol_code()),
        Ok(ChunkOutcome::Placed),
        "a third run"
    );
    assert_eq!(
        incoming
            .place(&one, (false, 6))
            .map_err(|failure| failure.protocol_code()),
        Err(Some(ProtocolCode::CHUNK_INVALID)),
        "a fourth refused"
    );
}

fn incoming(opening: &Bytes, (total, per_chunk, window): (u64, u64, u64)) -> IncomingTransfer {
    IncomingTransfer::new(
        opening,
        (
            total,
            IncomingBounds {
                side: RouterSide::Server,
                maximum_chunk_runs: 1_024,
                window_bytes: window,
                payload_bytes_per_chunk: per_chunk,
            },
        ),
    )
    .expect("an opening")
}

#[test]
fn sizes_a_chunk_as_what_an_envelope_of_the_chunk_size_holds_past_its_header_an_envelope_at_most() {
    let chunk = EnvelopeHeader::Chunk(ChunkHeader {
        call_id: 1,
        offset: 0,
        is_last: true,
    });
    assert_eq!(header_bytes_of(&chunk).expect("a chunk header"), 16);
    let placement = Placement::new(RouterSide::Server, LIMIT_DEFAULTS);
    assert_eq!(placement.payload_bytes_per_chunk, 1_048_560);
    let payload = pattern_of(2_097_152);
    let openings = [
        EnvelopeHeader::Request(RequestHeader {
            total: Some(0),
            ..super::request_header_of(1)
        }),
        EnvelopeHeader::Request(RequestHeader {
            destination_id: Some(1),
            total: Some(0),
            ..super::request_header_of(1)
        }),
        EnvelopeHeader::Result(ResultHeader {
            call_id: 2,
            credential: Some(Credential::Opaque(super::token())),
            total: Some(0),
        }),
    ];
    assert_eq!(
        openings
            .iter()
            .map(|header| header_bytes_of(header).expect("a header"))
            .collect::<Vec<_>>(),
        [20, 24, 36]
    );
    // Placement budgets the result's possible announcement separately from its bare header.
    let sizes = openings
        .iter()
        .map(|header| {
            let bare = match header {
                EnvelopeHeader::Result(result) => EnvelopeHeader::Result(ResultHeader {
                    credential: None,
                    ..result.clone()
                }),
                EnvelopeHeader::Request(_)
                | EnvelopeHeader::Failure(_)
                | EnvelopeHeader::Notification(_)
                | EnvelopeHeader::Chunk(_)
                | EnvelopeHeader::Credit(_)
                | EnvelopeHeader::Cancel(_) => header.clone(),
            };
            let Placed::Transfer(outgoing) = placement
                .transfer_of(&payload, (&bare, u64::MAX))
                .expect("a transfer")
            else {
                panic!("the payload goes in parts")
            };
            outgoing.opening().len()
        })
        .collect::<Vec<_>>();
    assert_eq!(sizes, [1_048_556, 1_048_552, 1_048_540]);
    for (chunk_bytes, envelope_bytes) in [(1_024, 16_778_240), (4_096, 1_024)] {
        let placement = Placement::new(
            RouterSide::Server,
            crate::router::types::RouterLimits {
                chunk_bytes,
                maximum_envelope_bytes: envelope_bytes,
                ..LIMIT_DEFAULTS
            },
        );
        assert_eq!(placement.payload_bytes_per_chunk, 1_008);
    }
}

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
fn sends_no_small_chunk_a_full_one_or_the_last_and_waits_for_the_credit_either_needs() {
    let whole = pattern_of(25);
    let mut outgoing = OutgoingTransfer::new(whole.clone(), (4, 6));
    assert_eq!(outgoing.opening(), whole.slice(..4));
    assert_eq!((outgoing.credit_end(), outgoing.total()), (4, 25));
    assert_eq!(outgoing.next_chunk(), None);
    outgoing.grant(9);
    assert_eq!(outgoing.next_chunk(), None);
    outgoing.grant(10);
    let first = outgoing.next_chunk().expect("a full chunk fits");
    assert_eq!(
        (first.is_last, first.offset, first.bytes.len()),
        (false, 4, 6)
    );
    assert_eq!(outgoing.next_chunk(), None);
    outgoing.grant(100);
    let mut rest = Vec::new();
    while let Some(chunk) = outgoing.next_chunk() {
        rest.push(chunk);
    }
    assert_eq!(
        rest.iter()
            .map(|chunk| chunk.bytes.len())
            .collect::<Vec<_>>(),
        [6, 6, 3]
    );
    assert!(rest.last().expect("the last").is_last);
    assert_eq!(rest.last().expect("the last").offset, 22);
    assert_eq!(outgoing.next_chunk(), None);
}

#[test]
fn keeps_the_highest_credit_the_total_at_most_a_credit_late_or_repeated_grants_nothing() {
    let mut outgoing = OutgoingTransfer::new(pattern_of(20), (2, 4));
    outgoing.grant(14);
    outgoing.grant(6);
    assert_eq!(outgoing.credit_end(), 14);
    outgoing.grant(14);
    assert_eq!(outgoing.credit_end(), 14);
    outgoing.grant(1_000);
    assert_eq!(outgoing.credit_end(), 20);
}

#[test]
fn refuses_an_opening_that_holds_its_whole_total_and_one_without_a_byte_of_its_payload() {
    for (opening, detail) in [
        (
            pattern_of(4),
            "an opening of 4 bytes holds its whole total of 4",
        ),
        (
            Bytes::new(),
            "an opening carries one byte of its payload at least, not 0",
        ),
    ] {
        let failure = IncomingTransfer::new(
            &opening,
            (
                4,
                IncomingBounds {
                    side: RouterSide::Server,
                    maximum_chunk_runs: 4,
                    window_bytes: 8,
                    payload_bytes_per_chunk: 1,
                },
            ),
        )
        .expect_err("no transfer");
        assert_eq!(failure.code(), ProtocolCode::CHUNK_INVALID.get());
        assert_eq!(failure.side(), Some(RouterSide::Server));
        assert_eq!(failure.scope(), crate::constants::FailureScope::Protocol);
        assert_eq!(failure.detail(), detail);
    }
    let one = incoming(&pattern_of(1), (4, 1, 8));
    assert_eq!(
        (one.contiguous(), one.credit_end(), one.is_whole()),
        (1, 1, false)
    );
}

#[test]
fn checks_a_chunk_in_order_its_bounds_its_bytes_its_last_then_its_credit_then_whether_it_came() {
    let mut incoming = incoming(&pattern_of(2), (10, 2, 8));
    for (length, last, offset, code) in [
        (3, true, 10, ProtocolCode::CHUNK_INVALID),
        (9, true, 2, ProtocolCode::CHUNK_INVALID),
        (0, false, 5, ProtocolCode::CHUNK_INVALID),
        (3, true, 2, ProtocolCode::CHUNK_INVALID),
        (8, false, 2, ProtocolCode::CHUNK_INVALID),
        (2, false, 2, ProtocolCode::CREDIT_EXCEEDED),
    ] {
        assert_eq!(
            incoming
                .place(&pattern_of(length), (last, offset))
                .expect_err("the first failed check")
                .code(),
            code.get()
        );
    }
    assert_eq!(
        incoming
            .place(&pattern_of(2), (false, 0))
            .expect("already received"),
        ChunkOutcome::Duplicate
    );
}

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
fn joins_the_whole_out_of_order_once_and_gives_the_same_whole_when_asked_again() {
    let whole = pattern_of(28);
    let mut incoming = incoming(&whole.slice(..4), (28, 5, 60));
    assert_eq!(incoming.credit_to_grant(u64::MAX), Some(28));
    let outcomes: Vec<ChunkOutcome> = [19_usize, 9, 24, 4, 14]
        .into_iter()
        .map(|offset| {
            let end = offset.saturating_add(5).min(28);
            incoming
                .place(
                    &whole.slice(offset..end),
                    (end == 28, u64::try_from(offset).expect("an offset")),
                )
                .expect("placed")
        })
        .collect();
    assert_eq!(
        outcomes,
        [
            ChunkOutcome::Placed,
            ChunkOutcome::Placed,
            ChunkOutcome::Placed,
            ChunkOutcome::Placed,
            ChunkOutcome::Complete
        ]
    );
    assert_eq!(incoming.contiguous(), 28);
    assert!(incoming.is_whole());
    let joined = incoming.payload();
    assert_eq!(joined, whole);
    let again = incoming.payload();
    assert_eq!(again, joined);
    assert_eq!(again.as_ptr(), joined.as_ptr());
}

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
fn refuses_a_chunk_before_the_last_that_is_not_full_and_one_over_bytes_received_in_part() {
    let whole = pattern_of(19);
    let mut incoming = incoming(&whole.slice(..4), (19, 4, 40));
    incoming.credit_to_grant(u64::MAX);
    let outcomes: Vec<Result<ChunkOutcome, Option<ProtocolCode>>> = [
        (4_usize, 3_usize),
        (8, 4),
        (2, 4),
        (6, 4),
        (8, 4),
        (0, 4),
        (16, 3),
        (4, 4),
        (12, 4),
    ]
    .into_iter()
    .map(|(offset, length)| {
        let end = offset.saturating_add(length);
        incoming
            .place(
                &whole.slice(offset..end),
                (end == 19, u64::try_from(offset).expect("an offset")),
            )
            .map_err(|failure| failure.protocol_code())
    })
    .collect();
    assert_eq!(
        outcomes,
        [
            Err(Some(ProtocolCode::CHUNK_INVALID)),
            Ok(ChunkOutcome::Placed),
            Err(Some(ProtocolCode::CHUNK_INVALID)),
            Err(Some(ProtocolCode::CHUNK_INVALID)),
            Ok(ChunkOutcome::Duplicate),
            Ok(ChunkOutcome::Duplicate),
            Ok(ChunkOutcome::Placed),
            Ok(ChunkOutcome::Placed),
            Ok(ChunkOutcome::Complete),
        ]
    );
    assert_eq!(incoming.payload(), whole);
}

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
fn refuses_a_chunk_past_full_before_the_last_or_the_last_chunk_invalid_and_places_a_full_one_and_a_last_one_full_at_most()
 {
    let whole = pattern_of(16);
    let mut incoming = incoming(&whole.slice(..4), (16, 4, 40));
    assert_eq!(incoming.credit_to_grant(u64::MAX), Some(16));
    for (offset, last, detail) in [
        (4, false, "a chunk before the last carries 4 bytes, not 5"),
        (11, true, "a last chunk carries 4 bytes at most, not 5"),
    ] {
        let failure = incoming
            .place(&pattern_of(5), (last, offset))
            .expect_err("past full");
        assert_eq!(failure.code(), ProtocolCode::CHUNK_INVALID.get());
        assert_eq!(failure.detail(), detail);
    }
    for (offset, outcome) in [
        (4_usize, ChunkOutcome::Placed),
        (8, ChunkOutcome::Placed),
        (12, ChunkOutcome::Complete),
    ] {
        assert_eq!(
            incoming
                .place(
                    &whole.slice(offset..offset.saturating_add(4)),
                    (offset == 12, u64::try_from(offset).expect("offset"))
                )
                .expect("full"),
            outcome
        );
    }
    assert_eq!(incoming.payload(), whole);
}

#[test]
fn grants_a_window_past_the_bytes_received_once_half_of_it_can_go_the_rest_at_the_end() {
    let mut incoming = incoming(&pattern_of(4), (22, 2, 8));
    assert_eq!(incoming.credit_to_grant(u64::MAX), Some(12));
    assert_eq!(incoming.credit_to_grant(u64::MAX), None);
    assert_eq!(
        incoming.place(&pattern_of(2), (false, 4)).expect("placed"),
        ChunkOutcome::Placed
    );
    assert_eq!(incoming.credit_to_grant(u64::MAX), None);
    for offset in [6, 8, 10] {
        assert_eq!(
            incoming
                .place(&pattern_of(2), (false, offset))
                .expect("placed"),
            ChunkOutcome::Placed
        );
    }
    assert_eq!(incoming.credit_to_grant(u64::MAX), Some(20));
    for offset in [12, 14, 16, 18] {
        assert_eq!(
            incoming
                .place(&pattern_of(2), (false, offset))
                .expect("placed"),
            ChunkOutcome::Placed
        );
    }
    assert_eq!(incoming.credit_to_grant(u64::MAX), Some(22));
    assert_eq!(incoming.credit_to_grant(u64::MAX), None);
    assert_eq!(
        incoming.place(&pattern_of(2), (true, 20)).expect("whole"),
        ChunkOutcome::Complete
    );
}

#[test]
fn grants_no_more_than_the_bytes_it_is_told_are_available() {
    let mut incoming = incoming(&pattern_of(4), (30, 1, 8));
    assert_eq!(incoming.credit_to_grant(2), None);
    assert_eq!(incoming.credit_to_grant(5), Some(9));
    assert_eq!(incoming.credit_end(), 9);
}

#[test]
fn halves_an_odd_window_exactly_64_bytes_short_of_half_of_129_and_65_not() {
    let mut incoming = incoming(&pattern_of(1), (1_000, 1, 129));
    assert_eq!(incoming.credit_to_grant(64), None);
    assert_eq!(incoming.credit_to_grant(65), Some(66));
}

#[test]
fn carries_100_kib_through_envelopes_of_1024_bytes_and_a_window_of_8_kib_a_few_credits_apart() {
    let whole = pattern_of(102_400);
    let mut outgoing = OutgoingTransfer::new(whole.clone(), (1_004, 1_008));
    let mut incoming = incoming(&outgoing.opening(), (102_400, 1_008, 8_192));
    let (mut credits, mut chunks) = (0_u32, 0_u32);
    loop {
        if let Some(granted) = incoming.credit_to_grant(u64::MAX) {
            credits = credits.saturating_add(1);
            outgoing.grant(granted);
        }
        let Some(chunk) = outgoing.next_chunk() else {
            break;
        };
        chunks = chunks.saturating_add(1);
        assert!(chunk.bytes.len().saturating_add(16) <= 1_024);
        incoming
            .place(&chunk.bytes, (chunk.is_last, chunk.offset))
            .expect("placed");
    }
    assert!(incoming.is_whole());
    assert_eq!(incoming.contiguous(), 102_400);
    assert_eq!(incoming.payload(), whole);
    assert_eq!((chunks, credits), (101, 20));
    assert_eq!(outgoing.next_chunk(), None);
}
