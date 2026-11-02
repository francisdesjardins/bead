//! A failure's scope, code and known side, its message and its redacted context.

use core::num::NonZeroU16;

use super::Failure;
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::FailureRecord;

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
