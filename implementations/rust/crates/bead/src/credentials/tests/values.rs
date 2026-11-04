//! A credential's held value: an announcement, a JWT, or an ELSEWHERE scheme alone.

use bytes::Bytes;

use crate::constants::CredentialScheme;
use crate::envelope::Credential;
use crate::session_token::SessionToken;

fn session_token(credential: &Credential) -> Option<SessionToken> {
    match credential {
        Credential::Opaque(token) => Some(*token),
        Credential::None
        | Credential::Jwt(_)
        | Credential::Elsewhere
        | Credential::ToCome { .. }
        | Credential::Redacted { .. } => None,
    }
}

#[test]
fn announces_a_token_or_the_end_of_its_session() {
    let token: SessionToken = "AAECAwQFBgcICQoLDA0ODw".parse().expect("the source token");
    let announced = Credential::Opaque(token);
    assert_eq!(announced.scheme(), CredentialScheme::OPAQUE);
    assert_eq!(session_token(&announced), Some(token));
    assert_eq!(announced, Credential::Opaque(token));
    assert_eq!(Credential::None.scheme(), CredentialScheme::NONE);
    assert_eq!(session_token(&Credential::None), None);
    // C#'s default credential announces NONE; Rust spells that enum variant explicitly.
    assert_ne!(announced, Credential::None);
}

#[test]
fn holds_a_jwt_by_its_token_and_elsewhere_by_its_scheme_alone() {
    let jwt = Credential::Jwt(Bytes::from_static(b"a.b.c"));
    assert_eq!(jwt.scheme(), CredentialScheme::JWT);
    assert!(matches!(&jwt, Credential::Jwt(token) if token.as_ref() == b"a.b.c"));
    assert_eq!(session_token(&jwt), None);
    assert_eq!(jwt, Credential::Jwt(Bytes::from_static(b"a.b.c")));
    assert_ne!(jwt, Credential::Jwt(Bytes::from_static(b"a.b.d")));
    assert_eq!(Credential::Elsewhere.scheme(), CredentialScheme::ELSEWHERE);
    // ELSEWHERE has no field that could hold bytes on Rust's surface.
    assert_ne!(jwt, Credential::Elsewhere);
}
