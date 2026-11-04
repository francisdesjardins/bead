//! The codec's unit twins play each source group's complete vector table through its own entry.

use bytes::Bytes;

use crate::constants::{FailureScope, RouterSide};
use crate::envelope::{
    ChunkHeader, Envelope, EnvelopeHeader, ReadEnvelopeOptions, RequestHeader, read_envelope,
    read_failure, read_header, read_prefix, write_envelope, write_header,
};
use crate::failure::{Failure, FailureOrigin};
use crate::testing::vectors;

fn options() -> ReadEnvelopeOptions {
    ReadEnvelopeOptions {
        maximum_envelope_bytes: Some(64),
        ..ReadEnvelopeOptions::default()
    }
}

fn refusal(failure: &Failure, (code, side): (u16, RouterSide)) {
    assert_eq!(failure.code().get(), code);
    assert_eq!(failure.scope(), FailureScope::Protocol);
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(side));
}

#[test]
fn reads_an_envelope_and_writes_it_back() {
    let entries: Vec<vectors::EnvelopeVector> = vectors::of("envelopes").expect("envelopes");
    assert!(!entries.is_empty());
    for vector in entries {
        let bytes = vectors::bytes_of(&vector.bytes).expect("vector bytes");
        let expected = vectors::envelope_of(&vector.envelope).expect("vector envelope");
        let read = read_envelope(&bytes, RouterSide::Server, &options())
            .expect("an envelope reads")
            .expect("a known kind");
        assert_eq!(read, expected, "{}", vector.name);
        assert_eq!(
            write_envelope(&read, 1_024).expect("written"),
            bytes,
            "{}",
            vector.name
        );
    }
}

#[test]
fn refuses_an_envelope() {
    let entries: Vec<vectors::RefusalVector> =
        vectors::of("envelopeRefusals").expect("envelope refusals");
    assert!(!entries.is_empty());
    for vector in entries {
        let options = ReadEnvelopeOptions {
            maximum_envelope_bytes: vector.maximum_envelope_bytes.or(Some(64)),
            ..options()
        };
        let failure = read_envelope(
            &vectors::bytes_of(&vector.bytes).expect("vector bytes"),
            RouterSide::Server,
            &options,
        )
        .expect_err(&vector.name);
        refusal(&failure, (vector.code, RouterSide::Server));
        if let Some(detail) = vector.detail {
            assert_eq!(failure.detail(), detail, "{}", vector.name);
        }
    }
}

#[test]
fn reads_a_failure() {
    let entries: Vec<vectors::FailureVector> = vectors::of("failures").expect("failures");
    assert!(!entries.is_empty());
    for vector in entries {
        let expected = vectors::record_of(&vector.failure).expect("vector failure");
        let options = ReadEnvelopeOptions {
            maximum_detail_bytes: vector.maximum_detail_bytes,
            ..options()
        };
        assert_eq!(
            read_failure(
                &vectors::bytes_of(&vector.record).expect("record bytes"),
                RouterSide::Server,
                &options,
            )
            .expect("the failure reads"),
            expected,
            "{}",
            vector.name
        );
    }
}

#[test]
fn refuses_a_failure() {
    let entries: Vec<vectors::FailureRefusalVector> =
        vectors::of("failureRefusals").expect("failure refusals");
    assert!(!entries.is_empty());
    for vector in entries {
        let failure = read_failure(
            &vectors::bytes_of(&vector.record).expect("record bytes"),
            RouterSide::Server,
            &options(),
        )
        .expect_err(&vector.name);
        refusal(&failure, (vector.code, RouterSide::Server));
    }
}

#[test]
fn reads_what_a_writer_need_not_write() {
    let entries: Vec<vectors::ReadVector> = vectors::of("reads").expect("headers read");
    assert!(!entries.is_empty());
    for vector in entries {
        let bytes = vectors::bytes_of(&vector.bytes).expect("vector bytes");
        let read = read_header(&bytes, vectors::side_of(&vector.side).expect("a side"))
            .expect("a header reads");
        if let Some(header) = vector.header {
            let read = read.expect("a known kind");
            assert_eq!(
                read.header,
                vectors::header_of(&header).expect("vector header")
            );
            assert_eq!(read.header_bytes, bytes.len(), "{}", vector.name);
        } else {
            assert!(read.is_none(), "{}", vector.name);
        }
    }
}

#[test]
fn reads_the_prefix_of_any_layout() {
    let entries: Vec<vectors::PrefixVector> = vectors::of("prefixes").expect("prefixes");
    assert!(!entries.is_empty());
    for vector in entries {
        let prefix = read_prefix(
            &vectors::bytes_of(&vector.bytes).expect("vector bytes"),
            RouterSide::Client,
        )
        .expect("a prefix reads");
        assert_eq!(prefix.call_id, vector.prefix.call_id, "{}", vector.name);
        assert_eq!(prefix.kind, vector.prefix.kind, "{}", vector.name);
        assert_eq!(prefix.layout, vector.prefix.layout, "{}", vector.name);
    }
}

#[test]
fn refuses_a_prefix() {
    let entries: Vec<vectors::RefusalVector> =
        vectors::of("prefixRefusals").expect("prefix refusals");
    assert!(!entries.is_empty());
    for vector in entries {
        let failure = read_prefix(
            &vectors::bytes_of(&vector.bytes).expect("vector bytes"),
            RouterSide::Client,
        )
        .expect_err(&vector.name);
        assert_eq!(failure.code().get(), vector.code, "{}", vector.name);
        assert_eq!(failure.side(), Some(RouterSide::Client));
    }
}

#[test]
fn refuses_a_header() {
    for group in ["prefixRefusals", "headerRefusals"] {
        let entries: Vec<vectors::RefusalVector> = vectors::of(group).expect("header refusals");
        assert!(!entries.is_empty());
        for vector in entries {
            let failure = read_header(
                &vectors::bytes_of(&vector.bytes).expect("vector bytes"),
                RouterSide::Server,
            )
            .expect_err(&vector.name);
            refusal(&failure, (vector.code, RouterSide::Server));
            if let Some(detail) = vector.detail {
                assert_eq!(failure.detail(), detail, "{}", vector.name);
            }
        }
    }
}

#[test]
fn write_no_chunk_without_a_byte() {
    let envelope = Envelope::Chunk {
        header: ChunkHeader {
            call_id: 7,
            offset: 0,
            is_last: true,
        },
        payload: Bytes::new(),
    };
    write_envelope(&envelope, 1_024).expect_err("a chunk needs a byte");
}

#[test]
fn writes_no_destination_block_for_a_destination_left_undefined() {
    let header = EnvelopeHeader::Request(RequestHeader {
        call_id: 1,
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        ..super::request(None)
    });
    let mut bytes = Vec::new();
    assert_eq!(write_header(&header, &mut bytes).expect("written"), 12);
    assert_eq!(
        bytes,
        vectors::bytes_of("A1 10 00 03 00 00 00 01 00 02 00 01").expect("bytes")
    );
}
