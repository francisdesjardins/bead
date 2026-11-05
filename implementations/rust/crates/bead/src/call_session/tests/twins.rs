//! The call's credential and session, with the cases both other sides play.

use std::collections::BTreeSet;
use std::sync::Arc;

use bytes::Bytes;
use serde_json::json;

use super::super::{
    Carriage, Presented, connection_session_of, presented_credential_of, uncarried_of,
};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::managers::service::Subscriber;
use crate::router::core::handed_header_of;
use crate::router::types::{CallSession, RequestCredential, SessionIdentifier, session_key_of};
use crate::session_token::SessionToken;
use crate::testing::core_port::scripted_header;
use crate::testing::surface::Consumer;

type Transport<'a> = (&'a dyn Fn(&str) -> bool, bool);

fn token(byte: u8) -> SessionToken {
    SessionToken::new([byte; 16]).expect("a token")
}

#[test]
fn runs_none_in_the_connection_s_session_whenever_it_has_one_and_opaque_when_it_is_its_token_nothing_else()
 {
    let held = token(1);
    for credential in [None, Some(Credential::Opaque(held))] {
        assert_eq!(
            connection_session_of(credential.as_ref(), (Some(&held), Some(json!("ada")))),
            Some(CallSession {
                data: Some(json!("ada")),
                ..CallSession::default()
            })
        );
    }
    assert_eq!(
        connection_session_of(None, (Some(&held), None)),
        Some(CallSession::default())
    );
    for (credential, known) in [
        (None, None),
        (Some(Credential::Opaque(held)), None),
        (Some(Credential::Opaque(token(2))), Some(&held)),
        (
            Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            Some(&held),
        ),
        (Some(Credential::Elsewhere), Some(&held)),
    ] {
        assert_eq!(
            connection_session_of(credential.as_ref(), (known, Some(json!("ada")))),
            None
        );
    }
}

#[test]
fn keeps_of_a_jwt_its_scheme_alone_in_a_copy_and_hands_any_other_header_as_it_came() {
    let mut jwt = scripted_header(1);
    jwt.credential = Some(Credential::Jwt(Bytes::from_static(b"a.b.c")));
    let handed = handed_header_of(&jwt);
    let mut expected = scripted_header(1);
    expected.credential = Some(Credential::Jwt(Bytes::new()));
    assert_eq!(handed, expected);
    assert_eq!(
        jwt.credential,
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))
    );
    assert_eq!(handed_header_of(&handed), handed);
    for credential in [
        None,
        Some(Credential::Opaque(token(1))),
        Some(Credential::Elsewhere),
    ] {
        let mut other = scripted_header(1);
        other.credential = credential;
        assert_eq!(handed_header_of(&other), other);
    }
}

#[test]
fn presents_none_unless_asked_opaque_with_the_token_learned_and_fails_a_call_that_asks_before_any_session_session_required()
 {
    let known = token(1);
    for side in [RouterSide::Client, RouterSide::Server] {
        assert_eq!(
            presented_credential_of(None, (side, Some(&known))).expect("none"),
            Presented::default()
        );
        assert_eq!(
            presented_credential_of(Some(&RequestCredential::Opaque), (side, Some(&known)))
                .expect("opaque"),
            Presented {
                credential: Some(Credential::Opaque(known)),
                carried: None
            }
        );
        let Err(CallError::Failure(failure)) =
            presented_credential_of(Some(&RequestCredential::Opaque), (side, None))
        else {
            panic!("OPAQUE with no session fails");
        };
        assert_eq!(
            failure.protocol_code(),
            Some(ProtocolCode::SESSION_REQUIRED)
        );
        assert_eq!(
            failure.detail(),
            "no session is known for OPAQUE to stand for"
        );
        assert_eq!(failure.origin(), FailureOrigin::Local);
        assert_eq!(failure.side(), Some(side));
    }
    let consumer = Consumer::new();
    consumer.accepts(
        "pub fn check() { let _ = bead::RequestCredential::Jwt(String::from(\"a.b.c\")); }",
    );
    consumer.refuses("pub fn check() { let _ = bead::RequestCredential::Jwt; let _: bead::RequestCredential = bead::RequestCredential::Jwt; }", ("E0308", "mismatched types"));
}

#[test]
fn presents_none_as_none_a_jwt_as_given_and_an_elsewhere_as_its_scheme_its_value_beside_it_for_its_transport()
 {
    let present = |credential: &RequestCredential| {
        presented_credential_of(Some(credential), (RouterSide::Client, None))
    };
    assert_eq!(
        present(&RequestCredential::None).expect("NONE"),
        Presented::default()
    );
    assert_eq!(
        present(&RequestCredential::Jwt("a.b.c".to_owned())).expect("JWT"),
        Presented {
            credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            carried: None,
        }
    );
    for carried in ["Bearer mF_9.B5f-4.1JqM", "Interop sub=ada"] {
        assert_eq!(
            present(&RequestCredential::Elsewhere(carried.to_owned())).expect("ELSEWHERE"),
            Presented {
                credential: Some(Credential::Elsewhere),
                carried: Some(carried.to_owned()),
            }
        );
    }
    assert!(matches!(
        present(&RequestCredential::Jwt(String::new())),
        Err(CallError::Refused(_))
    ));
    let consumer = Consumer::new();
    consumer.accepts("pub fn check() { let _: bead::RequestCredential = bead::RequestCredential::Elsewhere(String::from(\"x\")); }");
    consumer.refuses(
        "pub fn check() { let _: bead::RequestCredential = bead::RequestCredential::Elsewhere; }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        "pub fn check() { let _: bead::RequestCredential = 4; }",
        ("E0308", "mismatched types"),
    );
}

#[test]
fn fails_an_elsewhere_over_a_transport_that_carries_none_and_a_jwt_or_an_elsewhere_over_one_not_secure_destination_unreachable_none_or_opaque_goes_over_any()
 {
    let every = |_: &str| true;
    let none = |_: &str| false;
    let one = |value: &str| value == "Interop sub=ada";
    let transports: [Transport<'_>; 6] = [
        (&every, true),
        (&none, true),
        (&none, true),
        (&one, true),
        (&every, false),
        (&none, false),
    ];
    let unreachable = Some(ProtocolCode::DESTINATION_UNREACHABLE);
    let credentials = [
        None,
        Some(Credential::Opaque(token(1))),
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        Some(Credential::Elsewhere),
    ];
    let expected = [
        [None; 6],
        [None; 6],
        [None, None, None, None, unreachable, unreachable],
        [
            None,
            unreachable,
            unreachable,
            unreachable,
            unreachable,
            unreachable,
        ],
    ];
    for (credential, expected) in credentials.iter().zip(expected) {
        let actual: Vec<_> = transports
            .iter()
            .map(|&(takes, is_secure)| {
                uncarried_of(
                    credential.as_ref(),
                    &Carriage {
                        carried: matches!(credential, Some(Credential::Elsewhere))
                            .then_some("Interop sub=bob"),
                        takes,
                        side: RouterSide::Client,
                        is_secure,
                    },
                )
                .and_then(|failure| failure.protocol_code())
            })
            .collect();
        assert_eq!(actual, expected);
    }
    let mut carriage = Carriage {
        carried: Some("Interop sub=ada"),
        takes: &one,
        side: RouterSide::Client,
        is_secure: true,
    };
    assert!(uncarried_of(Some(&Credential::Elsewhere), &carriage).is_none());
    carriage.carried = Some("Interop sub=bob");
    assert_eq!(
        uncarried_of(Some(&Credential::Elsewhere), &carriage)
            .expect("another credential")
            .detail(),
        "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"
    );
    carriage.carried = None;
    assert!(uncarried_of(Some(&Credential::Elsewhere), &carriage).is_some());
    carriage.carried = Some("Interop sub=ada");
    carriage.takes = &every;
    carriage.is_secure = false;
    for credential in [
        Credential::Jwt(Bytes::from_static(b"a.b.c")),
        Credential::Elsewhere,
    ] {
        assert_eq!(
            uncarried_of(Some(&credential), &carriage)
                .expect("clear transport")
                .detail(),
            "its transport leaves the machine in the clear, which a bearer credential never crosses"
        );
    }
}

#[test]
fn keys_a_session_by_its_scheme_its_claim_and_its_values_one_sub_under_two_issuers_sid_and_sub_and_the_connection_s_session_apart()
 {
    let grace = SessionIdentifier::JwtSub {
        issuer: "https://a.example".to_owned(),
        sub: "grace".to_owned(),
    };
    let identifiers = [
        None,
        Some(grace.clone()),
        Some(SessionIdentifier::JwtSub {
            issuer: "https://b.example".to_owned(),
            sub: "grace".to_owned(),
        }),
        Some(SessionIdentifier::JwtSid {
            issuer: "https://a.example".to_owned(),
            sid: "grace".to_owned(),
        }),
        Some(SessionIdentifier::Elsewhere {
            id: "grace".to_owned(),
        }),
        Some(SessionIdentifier::JwtSub {
            issuer: "https://a.example".to_owned(),
            sub: "Grace".to_owned(),
        }),
        Some(SessionIdentifier::Elsewhere {
            id: "é".to_owned()
        }),
        Some(SessionIdentifier::Elsewhere {
            id: "e\u{301}".to_owned(),
        }),
    ];
    let keys: BTreeSet<_> = identifiers
        .iter()
        .map(|id| session_key_of(id.as_ref()))
        .collect();
    assert_eq!(keys.len(), identifiers.len());
    assert_eq!(
        session_key_of(Some(&grace)),
        session_key_of(identifiers[1].as_ref())
    );
    assert_eq!(
        identifiers.iter().collect::<BTreeSet<_>>().len(),
        identifiers.len()
    );
    let first = Subscriber {
        connection_handle: Arc::from("first"),
        identifier: Some(grace.clone()),
    };
    assert_ne!(
        Subscriber {
            identifier: None,
            ..first.clone()
        },
        first
    );
    assert_eq!(
        Subscriber {
            identifier: Some(grace.clone()),
            ..first.clone()
        },
        first
    );
    assert_ne!(
        Subscriber {
            connection_handle: Arc::from("second"),
            identifier: Some(grace)
        },
        first
    );
}
