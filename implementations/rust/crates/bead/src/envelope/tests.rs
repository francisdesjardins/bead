//! The envelope's tests: the headers a writer refuses, writing nothing, and a failure's detail cut
//! at its bound.

use bytes::Bytes;

use super::{
    ChunkHeader, Credential, CreditHeader, FailureHeader, FailureRecord, Header, RequestHeader,
    ResultHeader, header_bytes_of, write_failure, write_header,
};
use crate::constants::{CredentialScheme, FailureScope};
use crate::router::types::LIMIT_DEFAULTS;
use crate::testing::hexadecimal;

const TWO_TO_53: u64 = 1 << 53;

fn request(credential: Option<Credential>) -> RequestHeader {
    RequestHeader {
        call_id: 3,
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential,
    }
}

fn result(credential: Option<Credential>) -> ResultHeader {
    ResultHeader {
        call_id: 2,
        total: None,
        credential,
    }
}

// spec 4.10
#[test]
fn refuses_to_write_a_header_and_writes_nothing() {
    let unwritable = [
        (
            "a call id of 0",
            Header::Result(ResultHeader {
                call_id: 0,
                ..result(None)
            }),
            "callId is an integer from 1 to 4294967295, got 0",
        ),
        (
            "a service id of 0",
            Header::Request(RequestHeader {
                service_id: 0,
                ..request(None)
            }),
            "serviceId is an integer from 1 to 65535, got 0",
        ),
        (
            "a procedure id of 0",
            Header::Request(RequestHeader {
                procedure_id: 0,
                ..request(None)
            }),
            "procedureId is an integer from 1 to 65535, got 0",
        ),
        (
            "a destination id of 0",
            Header::Request(RequestHeader {
                destination_id: Some(0),
                ..request(None)
            }),
            "destinationId is an integer from 1 to 4294967295, got 0",
        ),
        (
            "a request paced that opens no subscription",
            Header::Request(RequestHeader {
                paced: true,
                ..request(None)
            }),
            "a 0x10 header paces nothing: a request that opens a subscription does, or a credit",
        ),
        (
            "an offset of 2^53",
            Header::Chunk(ChunkHeader {
                call_id: 7,
                offset: TWO_TO_53,
                is_last: true,
            }),
            "offset is a whole number from 0 to 2⁵³ − 1, got 9007199254740992",
        ),
        (
            "an end of 2^53",
            Header::Credit(CreditHeader {
                call_id: 7,
                credit_end: TWO_TO_53,
                paced: false,
            }),
            "creditEnd is a whole number from 0 to 2⁵³ − 1, got 9007199254740992",
        ),
        (
            "a total of 2^53",
            Header::Result(ResultHeader {
                call_id: 3,
                total: Some(TWO_TO_53),
                credential: None,
            }),
            "total is a whole number from 0 to 2⁵³ − 1, got 9007199254740992",
        ),
    ];

    for (name, header, words) in unwritable {
        let mut written = Vec::new();
        let refusal = write_header(&header, &mut written).expect_err(name);

        assert!(
            refusal.message().starts_with(words),
            "{name}: refused as {}",
            refusal.message()
        );
        assert!(written.is_empty(), "{name}: nothing written");
    }
}

// a platform's shape: what the other sides refuse besides, no value here holds. An OPAQUE token of
// 16 zero bytes: SessionToken refuses it as it is made. A JWT of a character past U+00FF: a JWT is
// its bytes. A negative offset, end or total: a u64 holds none
// spec 4.10
#[test]
fn refuses_a_credential_its_kind_does_not_take_or_its_scheme_does_not_hold() {
    let unwritable = [
        (
            "NONE on a request",
            Header::Request(request(Some(Credential::None))),
        ),
        (
            "a JWT on a result",
            Header::Result(result(Some(Credential::Jwt(Bytes::from_static(b"a"))))),
        ),
        (
            "ELSEWHERE on a failure",
            Header::Failure(FailureHeader {
                call_id: 2,
                credential: Some(Credential::Elsewhere),
            }),
        ),
        (
            "a scheme to come on a result",
            Header::Result(result(Some(Credential::ToCome {
                scheme: CredentialScheme::new(4),
                bytes: Bytes::new(),
            }))),
        ),
        (
            "a JWT of no character",
            Header::Request(request(Some(Credential::Jwt(Bytes::new())))),
        ),
        (
            "a JWT of 1,005 characters",
            Header::Request(request(Some(Credential::Jwt(Bytes::from(vec![
                b'a';
                1_005
            ]))))),
        ),
        (
            "a scheme to come numbered as one the protocol names",
            Header::Request(request(Some(Credential::ToCome {
                scheme: CredentialScheme::JWT,
                bytes: Bytes::from_static(b"a"),
            }))),
        ),
    ];

    for (name, header) in unwritable {
        let mut written = Vec::new();

        assert!(
            write_header(&header, &mut written).is_err(),
            "{name}: refused"
        );
        assert!(
            header_bytes_of(&header).is_err(),
            "{name}: refused as it is sized"
        );
        assert!(written.is_empty(), "{name}: nothing written");
    }
}

fn detail_of(detail: &str) -> String {
    let record = write_failure(
        &FailureRecord {
            code: core::num::NonZeroU16::MIN,
            scope: FailureScope::Protocol,
            detail: detail.to_owned(),
            relays: 0,
        },
        usize::try_from(LIMIT_DEFAULTS.maximum_detail_bytes).unwrap_or(usize::MAX),
    );

    String::from_utf8(record.get(4..).unwrap_or_default().to_vec()).expect("a detail in UTF-8")
}

fn letters(count: usize) -> String {
    "a".repeat(count)
}

// spec 7.4
#[test]
fn cuts_the_detail_at_the_limit_at_a_character_s_boundary() {
    assert_eq!(
        LIMIT_DEFAULTS.maximum_detail_bytes, 1_024,
        "the bound by default"
    );
    assert_eq!(
        detail_of(&letters(1_100)),
        letters(1_024),
        "cut at the bound"
    );
    assert_eq!(
        detail_of(&format!("{}é", letters(1_022))),
        format!("{}é", letters(1_022)),
        "a character that ends at the bound kept"
    );
    assert_eq!(
        detail_of(&format!("{}é", letters(1_023))),
        letters(1_023),
        "one across it dropped"
    );
    assert_eq!(
        detail_of(&format!("{}€", letters(1_022))),
        letters(1_022),
        "three bytes across it"
    );
    assert_eq!(
        detail_of(&format!("{}😀", letters(1_021))),
        letters(1_021),
        "four bytes across it"
    );
    assert_eq!(
        detail_of(&format!("{}😀", letters(1_020))),
        format!("{}😀", letters(1_020)),
        "four bytes that end at it"
    );
    assert_eq!(detail_of(""), "", "no detail");

    let record = FailureRecord {
        code: core::num::NonZeroU16::MIN,
        scope: FailureScope::Protocol,
        detail: "abcdef".to_owned(),
        relays: 0,
    };

    assert_eq!(
        hexadecimal::text_of(&write_failure(&record, 3)),
        "00 01 00 00 61 62 63",
        "cut at a bound of its own"
    );
}

// a platform's shape: a Rust string holds no surrogate alone, so one a side's text held arrives as
// U+FFFD, the replacement a UTF-16 decoder gives it, and is written as its three bytes
// spec 7.4
#[test]
fn writes_a_lone_surrogate_as_u_fffd() {
    let detail = String::from_utf16_lossy(&[0x61, 0xD800, 0x62]);
    let record = FailureRecord {
        code: core::num::NonZeroU16::new(19).expect("19 is no zero"),
        scope: FailureScope::Protocol,
        detail,
        relays: 0,
    };

    assert_eq!(
        hexadecimal::text_of(&write_failure(&record, 1_024)),
        "00 13 00 00 61 EF BF BD 62",
        "the surrogate written as U+FFFD"
    );
}
