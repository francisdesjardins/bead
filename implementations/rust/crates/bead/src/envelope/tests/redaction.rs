//! A retained OPAQUE scheme has no token, and cannot become a wire credential.

use super::{request, result};
use crate::constants::{CredentialScheme, ProtocolCode, RouterSide};
use crate::envelope::{
    Credential, EnvelopeHeader, FailureHeader, header_bytes_of, read_header, write_header,
};
use crate::session_token::SessionToken;

fn headers(credential: &Credential) -> [EnvelopeHeader; 3] {
    [
        EnvelopeHeader::Request(request(Some(credential.clone()))),
        EnvelopeHeader::Result(result(Some(credential.clone()))),
        EnvelopeHeader::Failure(FailureHeader {
            call_id: 3,
            credential: Some(credential.clone()),
        }),
    ]
}

#[test]
fn an_opaque_header_keeps_its_scheme_without_a_token_and_redacts_idempotently() {
    let token = SessionToken::new([7; 16]).expect("a token");
    let credential = Credential::Opaque(token);
    for header in headers(&credential) {
        let redacted = header.redacted();
        assert_eq!(
            redacted.credential(),
            Some(&Credential::Redacted {
                scheme: CredentialScheme::OPAQUE,
            })
        );
        assert_eq!(redacted.redacted(), redacted);
        assert_eq!(redacted.call_id(), header.call_id());
        assert_eq!(redacted.kind(), header.kind());
        assert_eq!(header.credential(), Some(&credential));
        assert!(!format!("{redacted:?}").contains(&token.to_string()));
    }
}

#[test]
fn a_scheme_alone_is_never_written_as_a_credential_nor_given_a_wire_size() {
    for scheme in [
        CredentialScheme::NONE,
        CredentialScheme::OPAQUE,
        CredentialScheme::JWT,
        CredentialScheme::ELSEWHERE,
        CredentialScheme::new(7),
    ] {
        let credential = Credential::Redacted { scheme };
        assert_eq!(credential.scheme(), scheme);
        for header in headers(&credential) {
            let mut written = vec![0xa1, 0x10, 0x00];
            header_bytes_of(&header).expect_err("a scheme alone has no wire size");
            write_header(&header, &mut written).expect_err("a scheme alone cannot be written");
            assert_eq!(written, [0xa1, 0x10, 0x00]);
            assert_eq!(header.redacted(), header);
        }
    }
}

#[test]
fn a_wire_opaque_credential_reads_with_its_token_and_never_as_a_redacted_value() {
    let credential = Credential::Opaque(SessionToken::new([9; 16]).expect("a token"));
    for header in headers(&credential) {
        let mut bytes = Vec::new();
        write_header(&header, &mut bytes).expect("a wire credential");
        let read = read_header(&bytes, RouterSide::Server)
            .expect("a header reads")
            .expect("a known kind");
        assert_eq!(read.header, header);
        assert_eq!(read.header.credential(), Some(&credential));
    }
    // ! a scheme alone on the wire is malformed, never a redacted credential to retain
    let mut bytes = Vec::new();
    write_header(
        &EnvelopeHeader::Result(result(Some(credential))),
        &mut bytes,
    )
    .expect("a result");
    bytes.truncate(12);
    bytes[3] = 3;
    bytes[10] = 0;
    bytes[11] = 0;
    let failure = read_header(&bytes, RouterSide::Client).expect_err("a token is required");
    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::ENVELOPE_MALFORMED)
    );
    assert_eq!(failure.detail(), "an OPAQUE token is 16 bytes, not 0");
}
