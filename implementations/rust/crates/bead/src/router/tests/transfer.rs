//! A transfer laid out and put together: the spec's 20 MiB byte by byte, and the runs of bytes
//! apart a receiver holds at most.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use bytes::Bytes;

use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{ChunkHeader, CreditHeader, Envelope, Header, RequestHeader, write_envelope};
use crate::router::parts::{Placed, Placement};
use crate::router::transfer::{ChunkOutcome, IncomingBounds, IncomingTransfer};
use crate::router::types::LIMIT_DEFAULTS;
use crate::testing::hexadecimal;

// bytes that differ from one to the next, so a byte out of place shows
fn pattern_of(length: usize) -> Bytes {
    Bytes::from(
        (0..length)
            .map(|index| u8::try_from(index % 251).unwrap_or(0))
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
            &Header::Request(request.clone()),
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
