//! A call's session: the connection's a request runs in, what a call presents, and the credential
//! its transport cannot carry.

use super::{Carriage, connection_session_of, presented_credential_of, uncarried_of};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::CallError;
use crate::router::types::RequestCredential;
use crate::session_token::SessionToken;

fn token() -> SessionToken {
    SessionToken::new([3; 16]).expect("a token")
}

#[test]
fn runs_a_request_in_its_connection_s_session_when_it_presents_none_or_that_token() {
    let token = token();
    let other = SessionToken::new([4; 16]).expect("another token");

    assert!(
        connection_session_of(None, (Some(&token), None)).is_some(),
        "none presented"
    );
    assert!(
        connection_session_of(Some(&Credential::Opaque(token)), (Some(&token), None)).is_some(),
        "its token presented"
    );
    assert!(
        connection_session_of(Some(&Credential::Opaque(other)), (Some(&token), None)).is_none(),
        "another token presented"
    );
    assert!(
        connection_session_of(Some(&Credential::Elsewhere), (Some(&token), None)).is_none(),
        "a credential of its own"
    );
    assert!(
        connection_session_of(None, (None, None)).is_none(),
        "no session"
    );
}

#[test]
fn presents_what_a_call_asks_opaque_for_the_session_known_and_refuses_what_it_cannot() {
    let token = token();
    let side = RouterSide::Client;

    assert_eq!(
        presented_credential_of(Some(&RequestCredential::Opaque), (side, Some(&token)))
            .ok()
            .and_then(|presented| presented.credential),
        Some(Credential::Opaque(token)),
        "OPAQUE stands for the session known"
    );
    assert!(
        matches!(
            presented_credential_of(Some(&RequestCredential::Opaque), (side, None)),
            Err(CallError::Failure(failure)) if failure.protocol_code() == Some(ProtocolCode::SESSION_REQUIRED)
        ),
        "OPAQUE with no session known"
    );
    assert!(
        matches!(
            presented_credential_of(Some(&RequestCredential::Jwt(String::new())), (side, None)),
            Err(CallError::Refused(_))
        ),
        "a JWT of no token"
    );

    let elsewhere = presented_credential_of(
        Some(&RequestCredential::Elsewhere("x".to_owned())),
        (side, None),
    )
    .expect("an ELSEWHERE presented");

    assert_eq!(
        (elsewhere.credential, elsewhere.carried.as_deref()),
        (Some(Credential::Elsewhere), Some("x")),
        "carried beside it"
    );
}

#[test]
fn fails_a_credential_its_transport_cannot_carry_destination_unreachable() {
    let takes = |credential: &str| credential == "x";
    let code_of = |credential: Credential, (carried, is_secure): (Option<&str>, bool)| {
        let carriage = Carriage {
            carried,
            takes: &takes,
            side: RouterSide::Client,
            is_secure,
        };

        uncarried_of(Some(&credential), &carriage).and_then(|failure| failure.protocol_code())
    };
    let unreachable = Some(ProtocolCode::DESTINATION_UNREACHABLE);

    assert_eq!(
        code_of(Credential::Elsewhere, (Some("x"), true)),
        None,
        "carried"
    );
    assert_eq!(
        code_of(Credential::Elsewhere, (Some("y"), true)),
        unreachable,
        "another not taken"
    );
    assert_eq!(
        code_of(Credential::Elsewhere, (None, true)),
        unreachable,
        "none carried"
    );
    assert_eq!(
        code_of(Credential::Elsewhere, (Some("x"), false)),
        unreachable,
        "in the clear"
    );
    assert_eq!(
        code_of(
            Credential::Jwt(bytes::Bytes::from_static(b"a")),
            (None, false)
        ),
        unreachable,
        "a bearer in the clear"
    );
    assert_eq!(
        code_of(Credential::Opaque(token()), (None, false)),
        None,
        "a session's token crosses any transport"
    );
}
