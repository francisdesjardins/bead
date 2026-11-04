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

fn hash_of(credential: &Credential) -> u64 {
    use core::hash::{Hash as _, Hasher as _};

    let mut hasher = std::hash::DefaultHasher::new();
    credential.hash(&mut hasher);

    hasher.finish()
}

#[test]
fn holds_a_scheme_to_come_by_its_number_its_bytes_copied_and_compared_byte_for_byte() {
    let mut bytes = vec![1, 2, 3];
    let to_come = |scheme: u16, bytes: &[u8]| Credential::ToCome {
        scheme: CredentialScheme::new(scheme),
        bytes: Bytes::copy_from_slice(bytes),
    };
    let credential = to_come(65_535, &bytes);

    bytes[0] = 9;

    assert_eq!(credential.scheme(), CredentialScheme::new(65_535));
    assert!(matches!(&credential, Credential::ToCome { bytes, .. } if bytes.as_ref() == [1, 2, 3]));
    assert_eq!(to_come(65_535, &[1, 2, 3]), credential);
    assert_eq!(hash_of(&to_come(65_535, &[1, 2, 3])), hash_of(&credential));
    assert_ne!(to_come(4, &[1, 2, 3]), credential);
    assert_ne!(to_come(65_535, &[1, 2]), credential);
}

// a scheme to come is any value of its enum on this side, refused as its header is written when it
// names one the protocol names
// spec 4.10
#[test]
fn refuses_a_scheme_it_names_as_one_to_come() {
    use crate::envelope::{EnvelopeHeader, RequestHeader, write_header};

    for scheme in [
        CredentialScheme::NONE,
        CredentialScheme::OPAQUE,
        CredentialScheme::JWT,
        CredentialScheme::ELSEWHERE,
    ] {
        let mut written = Vec::new();
        write_header(
            &EnvelopeHeader::Request(RequestHeader {
                call_id: 1,
                service_id: 1,
                procedure_id: 1,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
                credential: Some(Credential::ToCome {
                    scheme,
                    bytes: Bytes::new(),
                }),
            }),
            &mut written,
        )
        .expect_err("a scheme the protocol names");
        assert!(written.is_empty(), "{scheme}: nothing written");
    }
}
