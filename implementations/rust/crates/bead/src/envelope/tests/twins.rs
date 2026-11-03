//! Header blocks and envelope bounds, with the same byte examples as both other sides.

use core::num::NonZeroU16;

use bytes::Bytes;

use super::{request, result};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{
    CancelHeader, Credential, CreditHeader, Envelope, EnvelopeHeader, FailureHeader, FailureRecord,
    NotificationHeader, ReadEnvelopeOptions, RequestHeader, ResultHeader, header_bytes_of,
    read_envelope, read_failure, read_header, write_envelope, write_header,
};
use crate::failure::FailureOrigin;
use crate::session_token::SessionToken;
use crate::testing::{hexadecimal, vectors};

fn written(header: &EnvelopeHeader) -> Vec<u8> {
    let mut bytes = Vec::new();
    assert_eq!(
        write_header(header, &mut bytes).expect("a header written"),
        bytes.len()
    );
    bytes
}

fn sizes(headers: &[EnvelopeHeader]) -> Vec<usize> {
    headers
        .iter()
        .map(|header| header_bytes_of(header).expect("a header's size"))
        .collect()
}

#[test]
fn reads_name_and_writes_it_back() {
    let entries: Vec<vectors::HeaderVector> = vectors::of("headers").expect("header vectors");
    assert_ne!(entries.len(), 0);
    for vector in entries {
        let expected = vectors::bytes_of(&vector.bytes).expect("a vector's bytes");
        let header = vectors::header_of(&vector.header).expect("a vector's header");
        assert_eq!(written(&header), expected, "{}", vector.name);
        assert_eq!(header_bytes_of(&header).expect("sized"), expected.len());
        let read = read_header(&expected, RouterSide::Server)
            .expect("a header reads")
            .expect("a known kind");
        assert_eq!(read.header, header, "{}", vector.name);
        assert_eq!(read.header_bytes, expected.len());
    }
}

#[test]
fn size_each_header_by_its_kind_and_its_blocks() {
    let token = SessionToken::new([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        .expect("a session token");
    let plain = RequestHeader {
        call_id: 1,
        service_id: 1,
        procedure_id: 1,
        ..request(None)
    };
    let opaque = RequestHeader {
        credential: Some(Credential::Opaque(token)),
        ..plain
    };
    assert_eq!(
        sizes(&[
            EnvelopeHeader::Request(plain.clone()),
            EnvelopeHeader::Request(RequestHeader {
                destination_id: Some(1),
                ..plain.clone()
            }),
            EnvelopeHeader::Request(opaque.clone()),
            EnvelopeHeader::Request(RequestHeader {
                destination_id: Some(1),
                ..opaque
            }),
            EnvelopeHeader::Request(RequestHeader {
                credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                ..plain.clone()
            }),
            EnvelopeHeader::Request(RequestHeader {
                credential: Some(Credential::Elsewhere),
                ..plain
            }),
        ]),
        [12, 16, 32, 36, 24, 16]
    );
    assert_eq!(
        sizes(&[
            EnvelopeHeader::Result(result(None)),
            EnvelopeHeader::Result(result(Some(Credential::Opaque(token)))),
            EnvelopeHeader::Result(ResultHeader {
                total: Some(4_096),
                ..result(None)
            }),
            EnvelopeHeader::Result(ResultHeader {
                total: Some(4_096),
                ..result(Some(Credential::None))
            }),
        ]),
        [8, 28, 16, 20]
    );
    assert_eq!(
        header_bytes_of(&EnvelopeHeader::Notification(NotificationHeader {
            call_id: 1
        }))
        .expect("sized"),
        8
    );
    assert_eq!(
        header_bytes_of(&EnvelopeHeader::Cancel(CancelHeader { call_id: 1 })).expect("sized"),
        8
    );
}

#[test]
fn write_big_endian_and_read_every_call_id_unsigned() {
    assert_eq!(
        written(&EnvelopeHeader::Result(ResultHeader {
            call_id: 0x0102_0304,
            ..result(None)
        })),
        hexadecimal::bytes_of("A1 11 00 02 01 02 03 04").expect("hexadecimal")
    );
    for call_id in [1 << 31, u32::MAX, (1 << 31) + 1] {
        let header = EnvelopeHeader::Result(ResultHeader {
            call_id,
            ..result(None)
        });
        assert_eq!(
            read_header(&written(&header), RouterSide::Server)
                .expect("read")
                .expect("known kind")
                .header
                .call_id(),
            call_id
        );
    }
}

#[test]
fn reads_a_jwt_byte_0xe9_as_u_00e9_and_writes_it_back_as_the_same_byte() {
    let expected =
        hexadecimal::bytes_of("A1 10 08 05 00 00 00 03 00 02 00 01 00 02 00 01 E9 00 00 00")
            .expect("hexadecimal");
    let header =
        EnvelopeHeader::Request(request(Some(Credential::Jwt(Bytes::from_static(&[0xe9])))));
    let read = read_header(&expected, RouterSide::Server)
        .expect("read")
        .expect("known kind");
    assert_eq!(read.header, header);
    assert_eq!(read.header_bytes, expected.len());
    assert_eq!(written(&header), expected);
}

#[test]
fn writes_the_padding_over_whatever_the_bytes_held() {
    let header = EnvelopeHeader::Request(request(Some(Credential::Jwt(Bytes::from_static(b"a")))));
    let mut bytes = vec![0xff; 20];
    bytes.clear();
    assert_eq!(
        write_header(&header, &mut bytes).expect("written into reused capacity"),
        20
    );
    assert_eq!(
        bytes,
        hexadecimal::bytes_of("A1 10 08 05 00 00 00 03 00 02 00 01 00 02 00 01 61 00 00 00")
            .expect("hexadecimal")
    );
}

#[test]
fn carries_a_64_bit_field_whole_its_high_word_first_from_0_to_2_53_1() {
    for credit_end in [
        0,
        1 << 31,
        (1 << 32) - 1,
        1 << 32,
        (1 << 32) + 1,
        (1 << 53) - 1,
    ] {
        let header = EnvelopeHeader::Credit(CreditHeader {
            call_id: 1,
            credit_end,
            paced: false,
        });
        assert_eq!(
            read_header(&written(&header), RouterSide::Server)
                .expect("read")
                .expect("known kind")
                .header,
            header
        );
    }
    let bytes = written(&EnvelopeHeader::Credit(CreditHeader {
        call_id: 1,
        credit_end: (1 << 32) + 5,
        paced: false,
    }));
    assert_eq!(
        bytes.get(8..).expect("the 64-bit field"),
        hexadecimal::bytes_of("00 00 00 01 00 00 00 05").expect("hexadecimal")
    );
}

#[test]
fn raises_its_failures_as_the_side_of_the_table_it_is_given() {
    let bytes = hexadecimal::bytes_of("A1 11 00 02 00 00 00 00").expect("hexadecimal");
    let failure = read_header(&bytes, RouterSide::Client).expect_err("a call id of zero");
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Client));
}

#[test]
fn skip_an_advisory_envelope() {
    let bytes =
        Bytes::from(hexadecimal::bytes_of("A1 80 00 02 00 00 00 03 01").expect("hexadecimal"));
    assert_eq!(
        read_envelope(&bytes, RouterSide::Server, &ReadEnvelopeOptions::default())
            .expect("an advisory kind"),
        None
    );
}

#[test]
fn cut_a_failures_detail_to_the_bytes_it_is_given_a_character_whole() {
    let envelope = Envelope::Failure {
        header: FailureHeader {
            call_id: 3,
            credential: None,
        },
        failure: FailureRecord {
            code: NonZeroU16::MIN,
            detail: "abcdéf".to_owned(),
            scope: FailureScope::Protocol,
            relays: 0,
        },
    };
    let written = write_envelope(&envelope, 5).expect("written");
    let read = read_envelope(
        &written,
        RouterSide::Server,
        &ReadEnvelopeOptions::default(),
    )
    .expect("read")
    .expect("an envelope");
    assert!(matches!(read, Envelope::Failure { failure, .. } if failure.detail == "abcd"));
}

#[test]
fn take_an_envelope_of_the_largest_size_and_refuse_one_byte_more() {
    let options = ReadEnvelopeOptions {
        maximum_envelope_bytes: Some(64),
        ..ReadEnvelopeOptions::default()
    };
    let mut exact = written(&EnvelopeHeader::Result(ResultHeader {
        call_id: 3,
        ..result(None)
    }));
    exact.resize(64, 0);
    assert!(matches!(
        read_envelope(&Bytes::from(exact.clone()), RouterSide::Server, &options)
            .expect("exactly the bound"),
        Some(Envelope::Result { .. })
    ));
    exact.push(0);
    let failure = read_envelope(&Bytes::from(exact), RouterSide::Server, &options)
        .expect_err("one byte over");
    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::ENVELOPE_TOO_LARGE)
    );
    assert_eq!(failure.side(), Some(RouterSide::Server));
}

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
fn cuts_a_long_detail_at_the_default_limit_back_to_the_start_of_the_character_cut() {
    for (detail, expected) in [
        ("a".repeat(1_025), "a".repeat(1_024)),
        (format!("{}😀", "a".repeat(1_021)), "a".repeat(1_021)),
        (
            format!("{}😀", "a".repeat(1_020)),
            format!("{}😀", "a".repeat(1_020)),
        ),
    ] {
        let mut record = vec![0, 19, 0, 0];
        record.extend_from_slice(detail.as_bytes());
        assert_eq!(
            read_failure(&record, RouterSide::Server, &ReadEnvelopeOptions::default())
                .expect("read under the default bound")
                .detail,
            expected
        );
    }
}
