//! A client's incoming commands resolve their credentials and apply their admission refusals.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::client_commands::{command, failures, handler};
use super::{Scripted, locked, request_header_of, result_of, token};
use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::credentials::{Credentials, ElsewhereSession};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::failure::Failure;
use crate::router::client::RouterClientOptions;
use crate::router::core::{AdmissionRefusal, ResolveFn};
use crate::router::types::{CallSession, RouterAnswer, SessionIdentifier, TransportMessage};
use crate::testing::scripted::bytes_of;

fn echo() -> crate::identity::Procedure {
    crate::identity::Procedure {
        kind: Some(ProcedureKind::Command),
        ..crate::testing::pair::echo()
    }
}

type Sessions = Arc<Mutex<Vec<(u32, Option<CallSession>)>>>;

fn answering(sessions: &Sessions) -> ResolveFn {
    let sessions = Arc::clone(sessions);
    Arc::new(move |props| {
        locked(&sessions).push((props.header.call_id, props.session.as_deref().cloned()));
        Box::pin(async move {
            props
                .answerer
                .respond(RouterAnswer::Result(Bytes::new()))
                .await
                .map_err(crate::errors::ResolverError::other)
        })
    })
}

fn verifying() -> Scripted {
    Scripted::with(&RouterClientOptions {
        credentials: Some(Credentials {
            verify: Some(Arc::new(|carried, signal| {
                assert!(!signal.is_cancelled());
                Box::pin(async move {
                    Ok(Some(ElsewhereSession {
                        id: carried.clone(),
                        data: Some(serde_json::json!({ "sub": carried })),
                        end: None,
                    }))
                })
            })),
            ..Credentials::default()
        }),
        ..RouterClientOptions::default()
    })
}

fn elsewhere(scripted: &Scripted, (call_id, carried): (u32, Option<&str>)) {
    scripted.transport.deliver_message(&TransportMessage {
        data: bytes_of(&Envelope::Request {
            header: RequestHeader {
                credential: Some(Credential::Elsewhere),
                ..request_header_of(call_id)
            },
            payload: Bytes::new(),
        }),
        credential: carried.map(str::to_owned),
        ..TransportMessage::default()
    });
}

#[tokio::test]
async fn resolve_their_credential_as_a_server_does_none_and_the_session_it_learned_run_in_it_another_token_is_refused_session_required_a_jwt_credential_unsupported()
 {
    let scripted = Scripted::new();
    let sessions = Arc::new(Mutex::new(Vec::new()));
    scripted
        .router
        .register_resolver((&echo(), handler(answering(&sessions))))
        .expect("registered");
    command(&scripted, request_header_of(2));
    command(
        &scripted,
        RequestHeader {
            credential: Some(Credential::Opaque(token())),
            ..request_header_of(4)
        },
    );
    scripted.settle().await;
    scripted
        .transport
        .deliver(&result_of(99, Some(Credential::Opaque(token()))));
    command(&scripted, request_header_of(6));
    command(
        &scripted,
        RequestHeader {
            credential: Some(Credential::Opaque(token())),
            ..request_header_of(8)
        },
    );
    command(
        &scripted,
        RequestHeader {
            credential: Some(Credential::Opaque(
                crate::session_token::SessionToken::new([
                    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                ])
                .expect("another token"),
            )),
            ..request_header_of(10)
        },
    );
    command(
        &scripted,
        RequestHeader {
            credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            ..request_header_of(12)
        },
    );
    scripted.settle().await;
    assert_eq!(
        *locked(&sessions),
        [
            (2, None),
            (6, Some(CallSession::default())),
            (8, Some(CallSession::default()))
        ]
    );
    assert_eq!(
        failures(&scripted),
        [
            (
                4,
                ProtocolCode::SESSION_REQUIRED.get().get(),
                "the credential does not hold".to_owned()
            ),
            (
                10,
                ProtocolCode::SESSION_REQUIRED.get().get(),
                "the credential does not hold".to_owned()
            ),
            (
                12,
                ProtocolCode::CREDENTIAL_UNSUPPORTED.get().get(),
                "OPAQUE".to_owned()
            )
        ]
    );
    assert_eq!(scripted.transport.sent().len(), 6);
    assert!(scripted.transport.envelopes().iter().all(|envelope| matches!(
        envelope,
        Envelope::Result { header, .. } if header.credential.is_none()
    ) || matches!(envelope, Envelope::Failure { header, .. } if header.credential.is_none())));
}

#[tokio::test]
async fn answers_a_command_presenting_elsewhere_whose_transport_carried_nothing_session_required_no_credential_came_and_resolves_one_that_carried_a_value_by_its_verifier()
 {
    let scripted = verifying();
    let sessions = Arc::new(Mutex::new(Vec::new()));
    scripted
        .router
        .register_resolver((&echo(), handler(answering(&sessions))))
        .expect("registered");
    elsewhere(&scripted, (2, None));
    elsewhere(&scripted, (4, Some("ada")));
    scripted.settle().await;
    assert_eq!(
        *locked(&sessions),
        [(
            4,
            Some(CallSession {
                data: Some(serde_json::json!({ "sub": "ada" })),
                end: None,
                identifier: Some(SessionIdentifier::Elsewhere {
                    id: "ada".to_owned()
                }),
            })
        )]
    );
    assert_eq!(
        failures(&scripted),
        [(
            2,
            ProtocolCode::SESSION_REQUIRED.get().get(),
            "no credential came".to_owned()
        )]
    );
    assert_eq!(scripted.transport.sent().len(), 2);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn answers_a_command_that_presented_a_credential_whose_admission_refuses_session_required_access_denied_as_a_server_does()
 {
    let scripted = verifying();
    let mut refusing = handler(Arc::new(|_| panic!("a refused command never resolves")));
    refusing.admit = Some(Arc::new(|_| {
        Ok(Some(AdmissionRefusal {
            failure: Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Client)
                .saying("sign in first"),
            by: None,
        }))
    }));
    scripted
        .router
        .register_resolver((&echo(), refusing))
        .expect("registered");
    elsewhere(&scripted, (2, Some("ada")));
    command(&scripted, request_header_of(4));
    scripted.settle().await;
    let mut failures = failures(&scripted);
    failures.sort_by_key(|(call_id, _, _)| *call_id);
    assert_eq!(
        failures,
        [
            (
                2,
                ProtocolCode::ACCESS_DENIED.get().get(),
                "sign in first".to_owned()
            ),
            (
                4,
                ProtocolCode::SESSION_REQUIRED.get().get(),
                "sign in first".to_owned()
            ),
        ]
    );
    assert_eq!(scripted.transport.sent().len(), 2);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}
