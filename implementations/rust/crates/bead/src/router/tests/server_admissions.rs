//! The supplied admissions ask a call's session and its credential's scheme, and hand an
//! application's predicate only the request's public admission data.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{locked, token};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, RequestHeader};
use crate::failure::Failure;
use crate::router::admissions::{
    BeforeRequest, require_credential, require_session, share_leg_b_session,
};
use crate::router::core::{AdmissionRequest, Carried};
use crate::router::types::CallSession;
use crate::testing::core_port::scripted_header;

fn credentials() -> [Option<Credential>; 5] {
    [
        None,
        Some(Credential::None),
        Some(Credential::Opaque(token())),
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        Some(Credential::Elsewhere),
    ]
}

fn request(credential: Option<Credential>, session: Option<Arc<CallSession>>) -> AdmissionRequest {
    AdmissionRequest {
        connection_handle: Arc::from("a"),
        header: RequestHeader {
            credential,
            ..scripted_header(1)
        },
        session,
        carried: None,
    }
}

fn session() -> Arc<CallSession> {
    Arc::new(CallSession {
        data: Some(serde_json::json!("ada")),
        ..CallSession::default()
    })
}

fn admitted(admission: &BeforeRequest) -> Vec<[bool; 2]> {
    let admit = admission.admission(RouterSide::Server);
    credentials()
        .into_iter()
        .map(|credential| {
            [Some(session()), None].map(|session| {
                admit(&request(credential.clone(), session))
                    .expect("the admission answers")
                    .is_none()
            })
        })
        .collect()
}

fn refusal(admission: &BeforeRequest, code: ProtocolCode) {
    let held = admission.refusal().expect("a supplied refusal");
    assert_eq!(held.protocol_code(), Some(code));
    assert_eq!(held.side(), Some(RouterSide::Server));
}

#[test]
fn admits_a_call_with_a_session_its_calls_whatever_its_header_presents_and_refuses_one_in_none_session_required()
 {
    let admission = require_session();
    assert_eq!(admitted(&admission), [[true, false]; 5]);
    refusal(&admission, ProtocolCode::SESSION_REQUIRED);
    assert_eq!(admission.refusal().expect("a refusal").detail(), "");
}

#[test]
fn admits_a_call_presenting_a_jwt_or_an_elsewhere_by_its_scheme_alone_and_refuses_none_and_opaque_in_a_session_or_in_none_access_denied_with_its_detail()
 {
    let admission = require_credential();
    assert_eq!(
        admitted(&admission),
        [
            [false, false],
            [false, false],
            [false, false],
            [true, true],
            [true, true]
        ]
    );
    refusal(&admission, ProtocolCode::ACCESS_DENIED);
    assert_eq!(
        admission.refusal().expect("a refusal").detail(),
        "a relay admits by default only a credential it forwards"
    );
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(admission: &bead::BeforeRequest) { *admission.refusal().unwrap() = bead::Failure::protocol(bead::ProtocolCode::ACCESS_DENIED, bead::RouterSide::Server); }",
        ("E0594", "cannot assign"),
    );
}

#[test]
fn admits_a_call_in_a_session_or_presenting_a_jwt_or_an_elsewhere_by_its_scheme_alone_and_refuses_any_other_in_none_session_required()
 {
    let admission = share_leg_b_session();
    assert_eq!(
        admitted(&admission),
        [
            [true, false],
            [true, false],
            [true, false],
            [true, true],
            [true, true]
        ]
    );
    refusal(&admission, ProtocolCode::SESSION_REQUIRED);
    assert_eq!(admission.refusal().expect("a refusal").detail(), "");
}

#[test]
fn admits_on_true_alone_and_refuses_anything_else_with_its_refusal_or_access_denied() {
    let asked: Arc<Mutex<Vec<AdmissionRequest>>> = Arc::default();
    let keep = Arc::clone(&asked);
    let answers = Mutex::new([true, false].into_iter());
    let plain = BeforeRequest::new(
        move |request| {
            locked(&keep).push(request.clone());
            locked(&answers).next().expect("one answer per call")
        },
        None,
    );
    let admit = plain.admission(RouterSide::Server);
    assert!(admit(&request(None, None)).expect("admitted").is_none());
    let refused = admit(&request(None, None))
        .expect("refused")
        .expect("a refusal");
    assert_eq!(
        refused.failure.protocol_code(),
        Some(ProtocolCode::ACCESS_DENIED)
    );
    assert_eq!(refused.failure.side(), Some(RouterSide::Server));
    assert_eq!(refused.by, None);
    let asked = locked(&asked).clone();
    assert_eq!(asked.len(), 2);
    for seen in &asked {
        assert_eq!(seen.connection_handle.as_ref(), "a");
        assert_eq!(seen.header, scripted_header(1));
        assert!(seen.session.is_none());
    }
    let supplied = BeforeRequest::new(
        |_| false,
        Some(Failure::protocol(
            ProtocolCode::SESSION_REQUIRED,
            RouterSide::Server,
        )),
    );
    let refused = supplied.admission(RouterSide::Server)(&request(None, None))
        .expect("refused")
        .expect("the supplied refusal");
    assert_eq!(
        refused.failure.protocol_code(),
        Some(ProtocolCode::SESSION_REQUIRED)
    );
    let consumer = crate::testing::surface::Consumer::new();
    for value in ["1", "\"yes\"", "()"] {
        consumer.refuses(
            &format!("pub fn check() {{ bead::BeforeRequest::new(|_| {value}, None); }}"),
            ("E0308", "mismatched types"),
        );
    }
}

#[test]
fn keeps_its_refusal_session_required_whatever_the_call_presented_for_its_router_to_answer() {
    for side in [RouterSide::Server, RouterSide::Client] {
        let admission = BeforeRequest::new(
            |_| false,
            Some(Failure::protocol(ProtocolCode::SESSION_REQUIRED, side).saying("sign in first")),
        );
        for credential in credentials() {
            let refused = admission.admission(side)(&request(credential, None))
                .expect("refused")
                .expect("the refusal");
            assert_eq!(
                refused.failure.protocol_code(),
                Some(ProtocolCode::SESSION_REQUIRED)
            );
            assert_eq!(refused.failure.side(), Some(side));
            assert_eq!(refused.failure.detail(), "sign in first");
            assert_eq!(refused.by, None);
        }
    }
}

#[test]
fn hands_before_request_the_connection_the_header_and_the_calls_session_alone_never_a_bearer_credential_its_call_came_with()
 {
    let asked: Arc<Mutex<Vec<AdmissionRequest>>> = Arc::default();
    let keep = Arc::clone(&asked);
    let admission = BeforeRequest::new(
        move |request| {
            locked(&keep).push(request.clone());
            true
        },
        None,
    );
    let session = session();
    let mut carried = request(
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        Some(Arc::clone(&session)),
    );
    carried.carried = Some(Carried {
        header: carried.header.clone(),
        transport_credential: Some("Bearer e".to_owned()),
    });
    assert!(
        admission.admission(RouterSide::Server)(&carried)
            .expect("admitted")
            .is_none()
    );
    let asked = locked(&asked).clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].connection_handle.as_ref(), "a");
    assert_eq!(
        asked[0].header,
        RequestHeader {
            credential: Some(Credential::Jwt(Bytes::new())),
            ..scripted_header(1)
        }
    );
    assert!(Arc::ptr_eq(
        asked[0].session.as_ref().expect("the session"),
        &session
    ));
    assert_eq!(session.data, Some(serde_json::json!("ada")));
    assert_eq!(
        carried.header.credential,
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))
    );
    assert_eq!(
        carried
            .carried
            .as_ref()
            .expect("carried")
            .transport_credential
            .as_deref(),
        Some("Bearer e")
    );
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(request: &bead::AdmissionRequest) { let _ = &request.carried; }",
        ("E0616", "private"),
    );
}

// no table of failures on this side to ask: a relay's before_route is refused as its router is
// built unless its refusal is one of the two of its own side, and no value but a failure is given
#[tokio::test]
async fn is_one_of_the_two_admission_failures_of_the_tables_own_side_and_nothing_else() {
    use crate::constants::ProtocolCode;
    use crate::router::relay::RelayOptions;
    use crate::router::server::{RouterServer, RouterServerOptions};
    use crate::testing::SteppingClock;
    use crate::testing::scripted::ScriptedServer;

    let transport = ScriptedServer::new(SteppingClock::new(super::january_first()));
    let built = |refusal: Failure| {
        RouterServer::new(
            Arc::<ScriptedServer>::clone(&transport),
            &RouterServerOptions {
                relay: Some(RelayOptions {
                    before_route: Some(BeforeRequest::new(|_| false, Some(refusal))),
                    ..RelayOptions::default()
                }),
                ..RouterServerOptions::default()
            },
        )
    };

    for code in [ProtocolCode::ACCESS_DENIED, ProtocolCode::SESSION_REQUIRED] {
        built(Failure::protocol(code, RouterSide::Server))
            .expect("an admission failure of its own side")
            .dispose()
            .await;
    }

    // the other side's, another code, or the procedure's own
    for refusal in [
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Client),
        Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Server),
        Failure::application(ProtocolCode::ACCESS_DENIED.get(), ""),
    ] {
        assert_eq!(
            built(refusal)
                .expect_err("no admission failure of its own side")
                .to_string(),
            "a relay refuses with a failure that is not an admission's of the server's table"
        );
    }
    assert_eq!(transport.listener_count(), 0);
}

// what the admission panics with, as this side's admissions say what they throw: an error, which
// its router answers PROCEDURE_FAILED and reports
#[test]
fn throws_what_the_admission_throws() {
    let throwing = BeforeRequest::new(|_| panic!("no admission today"), None);
    let thrown = throwing.admission(RouterSide::Server)(&request(None, None))
        .expect_err("what it panicked with");

    assert!(
        matches!(&thrown, crate::errors::ResolverError::Other(error) if error.to_string() == "an admission panicked: no admission today"),
        "{thrown:?}"
    );
}
