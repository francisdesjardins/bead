//! A side's credentials: the limits a `JWT` needs, a router that takes one built only within
//! them, and the strings that write what carries one, none of them its bytes.

use std::sync::Arc;
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use serde_json::{Map, Value, json};

use super::{Credentials, JWT_LIMIT_BYTES, JwtSetKey, assert_limits_hold_jwt};
use crate::call_session::Presented;
use crate::clock::SharedClock;
use crate::envelope::{Credential, RequestHeader};
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::managers::service::RequestOptions;
use crate::managers::sessions::Session;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::core::{AdmissionRequest, Carried};
use crate::router::types::{
    ConnectionHandle, LIMIT_DEFAULTS, RequestCredential, RouterLimitsOptions, TransportMessage,
};
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::testing::scripted::ScriptedClient;
use crate::transport::ClientTransport;

#[test]
fn holds_a_jwt_s_header_in_a_chunk_and_an_envelope_of_1_024_bytes_at_least() {
    assert_eq!(JWT_LIMIT_BYTES, 1_024, "its bound");
    assert!(
        assert_limits_hold_jwt(&LIMIT_DEFAULTS).is_ok(),
        "the defaults hold it"
    );

    for limits in [
        crate::router::types::RouterLimits {
            chunk_bytes: 1_023,
            ..LIMIT_DEFAULTS
        },
        crate::router::types::RouterLimits {
            maximum_envelope_bytes: 1_023,
            chunk_bytes: 1_023,
            ..LIMIT_DEFAULTS
        },
    ] {
        assert!(
            assert_limits_hold_jwt(&limits).is_err(),
            "{limits:?} refused"
        );
    }
}

#[tokio::test]
async fn refuses_a_router_that_presents_a_jwt_by_default_within_limits_too_small_for_it() {
    let clock: SharedClock = SteppingClock::new(UNIX_EPOCH);
    let transport: Arc<dyn ClientTransport> = ScriptedClient::new(clock);
    let mut options = RouterClientOptions {
        credential: Some(RequestCredential::Jwt("a.b.c".to_owned())),
        limits: Some(RouterLimitsOptions {
            chunk_bytes: Some(512),
            maximum_envelope_bytes: Some(512),
            window_bytes: Some(1_024),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    };

    let refused = RouterClient::new(Arc::clone(&transport), &options).expect_err("refused");

    assert!(
        refused.message().contains("1,024 bytes at least"),
        "said why: {}",
        refused.message()
    );

    // credentials that take no JWT ask nothing of its limits
    options.credential = None;
    options.credentials = Some(Credentials::default());

    assert!(
        RouterClient::new(transport, &options).is_ok(),
        "built within them"
    );
}

fn token() -> SessionToken {
    SessionToken::new([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        .expect("a token of no zero alone")
}

fn handle() -> ConnectionHandle {
    Arc::from("first")
}

#[test]
fn writes_its_scheme_alone_in_a_string_never_its_bytes_nor_what_its_transport_carries() {
    assert_eq!(
        format!("{:?}", Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        "Credential(JWT)",
        "a JWT's"
    );
    assert_eq!(
        format!("{:?}", Credential::Opaque(token())),
        "Credential(OPAQUE)",
        "a session's token"
    );
    assert_eq!(
        format!("{:?}", RequestCredential::Jwt("a.b.c".to_owned())),
        "RequestCredential(JWT)",
        "a JWT a call presents"
    );
    assert_eq!(
        format!(
            "{:?}",
            RequestCredential::Elsewhere("Interop sub=ada".to_owned())
        ),
        "RequestCredential(ELSEWHERE)",
        "what an ELSEWHERE stands for"
    );

    let options = RequestOptions {
        credential: Some(RequestCredential::Jwt("a.b.c".to_owned())),
        ..RequestOptions::default()
    };

    assert!(
        !format!("{options:?}").contains("a.b.c"),
        "nor a call's options"
    );

    let presented = Presented {
        credential: Some(Credential::Elsewhere),
        carried: Some("Bearer SECRET".to_owned()),
    };

    assert_eq!(
        format!("{presented:?}"),
        "Presented { credential: Some(Credential(ELSEWHERE)), carried: carried }",
        "what a call presents, what its transport carried said to be there"
    );

    // a key's issuer and its algorithm alone: an HS256 key's secret is written in no string
    let jwk: Map<String, Value> = json!({ "kty": "oct", "k": "SECRET" })
        .as_object()
        .cloned()
        .unwrap_or_default();
    let key = JwtKey {
        algorithm: JwtAlgorithm::Hs256,
        issuer: "https://issuer.example".to_owned(),
        jwk: jwk.clone(),
    };

    assert!(!format!("{key:?}").contains("SECRET"), "a key's: {key:?}");
    assert!(
        !format!(
            "{:?}",
            JwtSetKey {
                algorithm: JwtAlgorithm::Hs256,
                jwk,
            }
        )
        .contains("SECRET"),
        "a key set's key's"
    );
}

#[test]
fn a_transport_message_writes_whether_its_transport_carried_a_credential_never_the_credential() {
    let carrying = TransportMessage {
        data: Bytes::from_static(&[1, 2, 3]),
        credential: Some("Bearer SECRET".to_owned()),
        may_overtake: true,
        ..TransportMessage::default()
    };

    assert_eq!(
        format!("{carrying:?}"),
        "TransportMessage { data: 3 bytes, address: None, port: None, may_overtake: true, credential: carried }",
        "its bytes counted, whether a credential came"
    );
    assert!(
        format!(
            "{:?}",
            TransportMessage {
                data: Bytes::from_static(&[1]),
                ..TransportMessage::default()
            }
        )
        .ends_with("may_overtake: false, credential: none }"),
        "none carried"
    );
}

#[test]
fn an_admission_s_request_writes_no_transport_credential_nor_whether_one_was_carried() {
    let header = RequestHeader {
        call_id: 1,
        service_id: 1,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: Some(Credential::Elsewhere),
    };
    let request = AdmissionRequest {
        connection_handle: handle(),
        header: header.clone(),
        session: None,
        carried: Some(Carried {
            header,
            transport_credential: Some("Bearer SECRET".to_owned()),
        }),
    };
    let written = format!("{request:?}");

    // its public members alone: what its transport carried is the router's
    assert!(
        written.starts_with("AdmissionRequest { connection_handle: \"first\", header: "),
        "its members: {written}"
    );
    assert!(
        !written.contains("SECRET") && !written.contains("carried"),
        "nothing of what its transport carried: {written}"
    );
    assert_eq!(
        written,
        format!(
            "{:?}",
            AdmissionRequest {
                carried: None,
                ..request
            }
        ),
        "nor whether it carried anything"
    );
}

#[test]
fn a_session_writes_whether_it_holds_a_token_never_the_token() {
    let mut session = Session::new(handle(), 0);

    session.data = Some(json!("ada"));
    session.session_token = Some(token());

    let written = format!("{session:?}");

    assert!(
        written.starts_with("Session { connection_handle: \"first\", "),
        "its members: {written}"
    );
    assert!(
        written.ends_with(", session_token: drawn }"),
        "a token there: {written}"
    );
    assert!(
        !written.contains(&token().to_string()),
        "never the token: {written}"
    );

    session.session_token = None;

    assert!(
        format!("{session:?}").ends_with(", session_token: none }"),
        "none there"
    );
}
