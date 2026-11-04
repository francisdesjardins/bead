//! A failure's scope, code and known side, its message and its redacted context.

use core::num::NonZeroU16;

use super::{Failure, FailureOrigin, ProcedureAddress};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{Credential, EnvelopeHeader, FailureHeader, FailureRecord};

fn received((code, scope, relays): (u16, FailureScope, u8)) -> Failure {
    Failure::received(
        &FailureRecord {
            code: NonZeroU16::new(code).expect("a failure code"),
            scope,
            relays,
            detail: String::new(),
        },
        RouterSide::Client,
    )
}

#[test]
fn is_of_no_known_side_through_a_relay_and_names_where_its_call_went() {
    let header = EnvelopeHeader::Failure(FailureHeader {
        call_id: 3,
        credential: None,
    });
    let failure = received((18, FailureScope::Protocol, 1))
        .of_call(None, Some(4))
        .about(&header);
    assert_eq!(failure.destination_id(), Some(4));
    assert_eq!(failure.origin(), FailureOrigin::Relayed);
    assert_eq!(failure.relays(), 1);
    assert_eq!(failure.side(), None);
    assert_eq!(failure.header(), Some(&header));
}

#[test]
fn is_of_no_known_side_when_received_through_a_relay() {
    let failure = received((18, FailureScope::Protocol, 1));
    assert_eq!(
        (failure.origin(), failure.side(), failure.relays()),
        (FailureOrigin::Relayed, None, 1)
    );
}

#[test]
fn matches_failure_code_sets_by_scope_code_and_the_known_side() {
    for error in [
        received((21, FailureScope::Protocol, 0)),
        received((21, FailureScope::Application, 0)),
        received((21, FailureScope::Protocol, 1)),
    ] {
        let is_protocol = error.scope() == FailureScope::Protocol;
        let codes = [ProtocolCode::SUBSCRIPTION_UNKNOWN];
        assert_eq!(error.is_protocol_code(&codes), is_protocol);
        assert_eq!(
            error.is_protocol_code_from(&codes, RouterSide::Server),
            is_protocol && error.side() == Some(RouterSide::Server)
        );
        assert!(!error.is_protocol_code_from(&codes, RouterSide::Client));
        assert!(!error.is_protocol_code(&[ProtocolCode::SERVICE_UNKNOWN]));
        assert!(!error.is_protocol_code(&[]));
        assert_eq!(error.is_application_code(&[21]), !is_protocol);
        assert!(!error.is_application_code(&[7]));
        assert!(!error.is_application_code(&[]));
    }
}

#[test]
fn is_protocol_matches_the_protocol_codes_and_the_side_when_given_through_a_relay_the_code_alone() {
    let error = received((18, FailureScope::Protocol, 0));
    assert!(error.is_protocol_code(&[ProtocolCode::SERVICE_UNKNOWN]));
    assert!(error.is_protocol_code(&[
        ProtocolCode::PROCEDURE_UNKNOWN,
        ProtocolCode::SERVICE_UNKNOWN,
    ]));
    assert!(!error.is_protocol_code(&[ProtocolCode::PROCEDURE_UNKNOWN]));
    assert!(error.is_protocol_code_from(&[ProtocolCode::SERVICE_UNKNOWN], RouterSide::Server));
    assert!(!error.is_protocol_code_from(&[ProtocolCode::SERVICE_UNKNOWN], RouterSide::Client));
    assert!(!error.is_application());
    let relayed = received((18, FailureScope::Protocol, 1));
    assert!(relayed.is_protocol_code(&[ProtocolCode::SERVICE_UNKNOWN]));
    assert!(!relayed.is_protocol_code(&[ProtocolCode::PROCEDURE_UNKNOWN]));
    for side in [RouterSide::Client, RouterSide::Server] {
        assert!(!relayed.is_protocol_code_from(&[ProtocolCode::SERVICE_UNKNOWN], side));
    }
}

#[test]
fn is_application_matches_the_procedure_s_own_codes_never_a_protocol_code_of_the_same_number() {
    let error = received((21, FailureScope::Application, 0));
    assert!(error.is_application());
    assert!(error.is_application_code(&[21]));
    assert!(error.is_application_code(&[7, 21]));
    assert!(!error.is_application_code(&[7]));
    assert!(!error.is_protocol_code(&[ProtocolCode::SUBSCRIPTION_UNKNOWN]));
    let protocol = Failure::protocol(ProtocolCode::SUBSCRIPTION_UNKNOWN, RouterSide::Server);
    assert!(!protocol.is_application());
    assert!(!protocol.is_application_code(&[21]));
}

#[test]
fn carries_no_header_when_none_is_supplied_explicitly() {
    let error = received((21, FailureScope::Application, 0));
    assert_eq!(error.header(), None);
    assert_eq!(error.to_string(), "server application failure 21");
}

#[test]
fn carries_the_failure_and_where_it_belongs_and_keeps_a_redacted_copy_of_the_header() {
    let token = crate::session_token::SessionToken::new([7; 16]).expect("a token");
    let mut header = EnvelopeHeader::Failure(FailureHeader {
        call_id: 3,
        credential: Some(Credential::Opaque(token)),
    });
    let cause: std::sync::Arc<dyn std::error::Error + Send + Sync> =
        std::sync::Arc::new(std::io::Error::other("underneath"));
    let error = received((19, FailureScope::Protocol, 0))
        .saying("no procedure 1 in service 2")
        .of_call(
            Some(ProcedureAddress {
                service_id: 2,
                procedure_id: 1,
            }),
            Some(5),
        )
        .about(&header)
        .caused_by(std::sync::Arc::clone(&cause));
    if let EnvelopeHeader::Failure(header) = &mut header {
        header.call_id = 99;
    }
    assert_eq!(error.code().get(), 19);
    assert_eq!(error.destination_id(), Some(5));
    assert_eq!(error.detail(), "no procedure 1 in service 2");
    assert_eq!(error.origin(), FailureOrigin::Peer);
    assert_eq!(
        error.procedure(),
        Some(ProcedureAddress {
            service_id: 2,
            procedure_id: 1
        })
    );
    assert_eq!(error.relays(), 0);
    assert_eq!(error.scope(), FailureScope::Protocol);
    assert_eq!(error.side(), Some(RouterSide::Server));
    let source: &dyn std::error::Error = cause.as_ref();
    assert!(std::ptr::eq(
        std::error::Error::source(&error).expect("the cause"),
        source,
    ));
    let header = error.header().expect("the header");
    assert_eq!(header.call_id(), 3);
    assert_eq!(header.kind(), crate::constants::EnvelopeKind::Failure);
    assert_eq!(
        header.credential().map(Credential::scheme),
        Some(crate::constants::CredentialScheme::OPAQUE)
    );
    assert_ne!(
        header.credential(),
        Some(&Credential::Opaque(token)),
        "the token is absent from the kept header"
    );
    assert!(!format!("{error:?}").contains(&token.to_string()));
}

#[test]
fn is_local_through_no_relay_with_no_detail_and_nothing_it_belongs_to_when_not_told() {
    let error = Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Client);
    assert_eq!(error.code().get(), 34);
    assert_eq!(error.destination_id(), None);
    assert_eq!(error.detail(), "");
    assert_eq!(error.header(), None);
    assert_eq!(error.origin(), FailureOrigin::Local);
    assert_eq!(error.procedure(), None);
    assert_eq!(error.relays(), 0);
    assert_eq!(error.side(), Some(RouterSide::Client));
    assert_eq!(
        error.to_string(),
        "local client protocol failure 34 PAYLOAD_TOO_LARGE"
    );
}

#[test]
fn says_a_local_protocol_failure_by_its_side_its_code_and_its_name() {
    assert_eq!(
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
            .saying("")
            .to_string(),
        "local server protocol failure 33 ACCESS_DENIED"
    );
    assert_eq!(
        Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, RouterSide::Client)
            .saying("a call id is never 0")
            .to_string(),
        "local client protocol failure 1 ENVELOPE_MALFORMED: a call id is never 0"
    );
    assert_eq!(
        received((19, FailureScope::Protocol, 0))
            .saying("no procedure 1 in service 2")
            .to_string(),
        "server protocol failure 19 PROCEDURE_UNKNOWN: no procedure 1 in service 2"
    );
}

#[test]
fn says_a_failure_relayed_has_no_side_it_knows() {
    assert_eq!(
        received((18, FailureScope::Protocol, 1)).to_string(),
        "unknown side protocol failure 18 SERVICE_UNKNOWN, through 1 relay"
    );
    assert_eq!(
        received((18, FailureScope::Protocol, 2))
            .saying("gone")
            .to_string(),
        "unknown side protocol failure 18 SERVICE_UNKNOWN, through 2 relays: gone"
    );
}

#[test]
fn is_the_peer_s_of_the_other_side_through_no_relay_when_received() {
    let error = received((19, FailureScope::Protocol, 0));
    assert_eq!(error.origin(), FailureOrigin::Peer);
    assert_eq!(error.side(), Some(RouterSide::Server));
    assert_eq!(error.relays(), 0);
    assert_eq!(
        Failure::received(&error.record(), RouterSide::Server).side(),
        Some(RouterSide::Client)
    );
}

#[test]
fn leaves_the_credential_out_and_says_its_scheme_alone_when_there_was_one() {
    use crate::constants::CredentialScheme;
    use crate::envelope::{NotificationHeader, RequestHeader, ResultHeader};
    use bytes::Bytes;

    let token = crate::session_token::SessionToken::new([9; 16]).expect("a token");
    let result = EnvelopeHeader::Result(ResultHeader {
        call_id: 2,
        total: None,
        credential: Some(Credential::Opaque(token)),
    });
    let redacted = result.redacted();
    assert_eq!(redacted.call_id(), 2);
    assert_eq!(
        redacted.credential().map(Credential::scheme),
        Some(CredentialScheme::OPAQUE)
    );
    assert_ne!(
        redacted.credential(),
        result.credential(),
        "a token is left out"
    );
    let ended = EnvelopeHeader::Result(ResultHeader {
        call_id: 2,
        total: None,
        credential: Some(Credential::None),
    });
    assert_eq!(ended.redacted(), ended);
    let notification = EnvelopeHeader::Notification(NotificationHeader { call_id: 3 });
    assert_eq!(notification.redacted(), notification);
    for (credential, expected) in [
        (
            Credential::Jwt(Bytes::from_static(b"a.b.c")),
            Credential::Jwt(Bytes::new()),
        ),
        (
            Credential::ToCome {
                scheme: CredentialScheme::new(7),
                bytes: Bytes::from_static(&[1, 2]),
            },
            Credential::ToCome {
                scheme: CredentialScheme::new(7),
                bytes: Bytes::new(),
            },
        ),
    ] {
        let request = EnvelopeHeader::Request(RequestHeader {
            call_id: 1,
            service_id: 2,
            procedure_id: 1,
            destination_id: None,
            total: None,
            credential: Some(credential.clone()),
            opens_subscription: false,
            paced: false,
        });
        let redacted = request.redacted();
        assert_eq!(redacted.call_id(), 1);
        assert_eq!(
            redacted.credential().map(Credential::scheme),
            Some(credential.scheme())
        );
        assert_eq!(redacted.credential(), Some(&expected));
    }
}
