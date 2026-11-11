//! The credential a request presents: routing, resolution, admission and the turn each takes.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::{Handed, locked, token};
use crate::constants::{CredentialScheme, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::errors::CapacityError;
use crate::failure::Failure;
use crate::router::core::{
    self as router_core, AdmissionRequest, Handler, Resolution, Resolved, Unresolved,
};
use crate::router::types::{CallSession, RouterLimitsOptions, TransportMessage};
use crate::testing::core_port::{Peer, SessionHook, scripted_header};
use crate::testing::{pair::echo, scripted};

type Admitted = Arc<Mutex<Vec<AdmissionRequest>>>;

pub(super) fn session() -> CallSession {
    CallSession {
        data: Some(serde_json::Value::String("ada".to_owned())),
        ..CallSession::default()
    }
}

pub(super) fn handler((handed, admitted): (&Handed, &Admitted)) -> Handler {
    let handed = Arc::clone(handed);
    let admitted = Arc::clone(admitted);
    Handler {
        resolve: Arc::new(move |props| {
            locked(&handed).push(props);
            Box::pin(async { Ok(()) })
        }),
        admit: Some(Arc::new(move |request| {
            locked(&admitted).push(request.clone());
            Ok(None)
        })),
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

pub(super) async fn serving(resolve: Option<SessionHook>) -> (Peer, Handed, Admitted) {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let handed = Handed::default();
    let admitted = Admitted::default();
    let handler = handler((&handed, &admitted));
    peer.owner
        .run(move |state| {
            state.session = resolve;
            state.schemes = vec![CredentialScheme::JWT, CredentialScheme::ELSEWHERE];
            router_core::register_resolver(&state.core.resolvers, (&echo(), handler, None))
                .expect("echo registered");
        })
        .await
        .expect("the port ready");
    (peer, handed, admitted)
}

pub(super) fn request(call_id: u32, credential: Option<Credential>) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            credential,
            ..scripted_header(call_id)
        },
        payload: Bytes::new(),
    }
}

fn jwt() -> Credential {
    Credential::Jwt(Bytes::from_static(b"a.b.c"))
}

fn future_scheme(scheme: u16, bytes: Bytes) -> Credential {
    Credential::ToCome {
        scheme: CredentialScheme::new(scheme),
        bytes,
    }
}

pub(super) fn receive(
    state: &mut crate::testing::core_port::State,
    (envelope, handle, carried): (Envelope, &str, Option<&str>),
) {
    router_core::receive(
        state,
        (
            TransportMessage {
                data: scripted::bytes_of(&envelope),
                credential: carried.map(str::to_owned),
                ..TransportMessage::default()
            },
            &Arc::from(handle),
        ),
    );
}

pub(super) async fn failures(peer: &Peer) -> Vec<(u32, u16, String)> {
    peer.sent()
        .await
        .into_iter()
        .map(|(_, envelope)| {
            let Envelope::Failure { header, failure } = envelope else {
                panic!("a failure, not {envelope:?}");
            };
            (header.call_id, failure.code.get(), failure.detail)
        })
        .collect()
}

fn ids(admitted: &Admitted) -> Vec<u32> {
    locked(admitted)
        .iter()
        .map(|request| request.header.call_id)
        .collect()
}

// spec 9.2, 13.1
#[tokio::test]
async fn a_credential_of_a_scheme_the_side_takes_none_of_is_refused_credential_unsupported_naming_those_it_takes_past_its_route_and_before_it_resolves()
 {
    let resolve = || -> SessionHook {
        Box::new(|_, _| panic!("unsupported credentials never reach session resolution"))
    };
    let (first, handed, admitted) = serving(Some(resolve())).await;
    let (second, other_handed, other_admitted) = serving(Some(resolve())).await;
    first
        .owner
        .run(|state| state.schemes.clear())
        .await
        .expect("OPAQUE alone");
    first
        .owner
        .run(|state| {
            for (id, credential) in [
                (1, jwt()),
                (3, Credential::Elsewhere),
                (5, future_scheme(0xffff, Bytes::from_static(&[1, 2]))),
                (11, future_scheme(7, Bytes::from_static(&[1, 2]))),
            ] {
                receive(state, (request(id, Some(credential)), "a", None));
            }
            for (id, service_id, procedure_id) in [(7, 2, 99), (9, 9, 1)] {
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: RequestHeader {
                                service_id,
                                procedure_id,
                                credential: Some(future_scheme(7, Bytes::new())),
                                ..scripted_header(id)
                            },
                            payload: Bytes::new(),
                        },
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("unsupported requests received");
    second
        .owner
        .run(|state| {
            for (id, scheme) in [(1, 4), (3, 0xffff)] {
                receive(
                    state,
                    (
                        request(id, Some(future_scheme(scheme, Bytes::new()))),
                        "a",
                        None,
                    ),
                );
            }
        })
        .await
        .expect("unsupported requests received");
    first.settle().await;
    second.settle().await;
    let unsupported = ProtocolCode::CREDENTIAL_UNSUPPORTED.get().get();
    assert_eq!(
        failures(&first).await,
        [
            (1, unsupported, "OPAQUE".to_owned()),
            (3, unsupported, "OPAQUE".to_owned()),
            (5, unsupported, "OPAQUE".to_owned()),
            (11, unsupported, "OPAQUE".to_owned()),
            (
                7,
                ProtocolCode::PROCEDURE_UNKNOWN.get().get(),
                "no procedure 99 in service 2".to_owned()
            ),
            (
                9,
                ProtocolCode::SERVICE_UNKNOWN.get().get(),
                "no service 9".to_owned()
            ),
        ]
    );
    assert_eq!(
        failures(&second).await,
        [
            (1, unsupported, "OPAQUE, JWT, ELSEWHERE".to_owned()),
            (3, unsupported, "OPAQUE, JWT, ELSEWHERE".to_owned()),
        ]
    );
    assert!(locked(&handed).is_empty());
    assert!(locked(&admitted).is_empty());
    assert!(locked(&other_handed).is_empty());
    assert!(locked(&other_admitted).is_empty());
    super::router_core_requester::quiet(&first).await;
    super::router_core_requester::quiet(&second).await;
}

// spec 13.1
#[tokio::test]
async fn hands_session_of_what_its_transport_carried_for_an_elsewhere_alone_what_came_beside_any_other_staying_here()
 {
    let carried = Arc::new(Mutex::new(Vec::new()));
    let keeping = Arc::clone(&carried);
    let (peer, handed, admitted) = serving(Some(Box::new(move |request, _| {
        locked(&keeping).push((
            request.carried.header.call_id,
            request.carried.transport_credential.clone(),
        ));
        Resolution::Now(Ok(Resolved::Session(session())))
    })))
    .await;
    peer.owner
        .run(|state| {
            for (id, credential, carried) in [
                (1, None, "Bearer a"),
                (3, Some(Credential::Opaque(token())), "Bearer b"),
                (5, Some(jwt()), "Bearer c"),
                (7, Some(Credential::Elsewhere), "Bearer d"),
            ] {
                receive(state, (request(id, credential), "a", Some(carried)));
            }
        })
        .await
        .expect("the four schemes received together");
    peer.settle().await;
    assert_eq!(
        *locked(&carried),
        [
            (1, None),
            (3, None),
            (5, None),
            (7, Some("Bearer d".to_owned()))
        ]
    );
    assert_eq!(locked(&handed).len(), 4);
    assert_eq!(locked(&admitted).len(), 4);
    super::router_core_requester::quiet(&peer).await;
}

// spec 13.1
#[tokio::test]
async fn whose_resolution_rejects_with_a_capacity_error_is_answered_capacity_exceeded_its_message_for_detail_and_reported_nowhere_a_failure_error_of_that_code_stays_procedure_failed_reported()
 {
    for message in ["as many calls wait already", "too many"] {
        let (peer, handed, admitted) = serving(Some(Box::new(move |request, _| {
            let error = if request.carried.header.call_id == 1 {
                Unresolved::Capacity(CapacityError::new(message))
            } else {
                Unresolved::Other(Arc::new(
                    Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, RouterSide::Server)
                        .saying("too many"),
                ))
            };
            Resolution::Later(Box::pin(async move { Err(error) }))
        })))
        .await;
        peer.owner
            .run(|state| {
                receive(state, (request(1, Some(jwt())), "a", None));
                receive(state, (request(3, Some(jwt())), "a", None));
            })
            .await
            .expect("both failures received");
        peer.settle().await;
        assert_eq!(
            failures(&peer).await,
            [
                (
                    1,
                    ProtocolCode::CAPACITY_EXCEEDED.get().get(),
                    message.to_owned()
                ),
                (3, ProtocolCode::PROCEDURE_FAILED.get().get(), String::new()),
            ]
        );
        peer.owner.run(|state| {
            assert!(matches!(state.reports.as_slice(), [(handle, crate::router::types::RouterError::Other(error))] if handle.as_ref() == "a" && error.downcast_ref::<Failure>().is_some()));
        }).await.expect("only the failure object is reported");
        assert!(locked(&handed).is_empty());
        assert!(locked(&admitted).is_empty());
    }
}

// spec 13.1
#[tokio::test]
async fn a_credential_of_a_jwt_or_an_elsewhere_resolves_in_a_later_turn_whether_its_resolution_waits_or_not_its_call_id_held_meanwhile()
 {
    let (release, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let resolved = Arc::new(Mutex::new(Vec::new()));
    let keeping = Arc::clone(&resolved);
    let (peer, handed, admitted) = serving(Some(Box::new(move |request, _| {
        locked(&keeping).push((
            request.carried.header.call_id,
            request.carried.transport_credential.clone(),
        ));
        if request.carried.header.call_id == 9 {
            let waiting = waiting.take().expect("one waiting resolution");
            Resolution::Later(Box::pin(async move { waiting.await.expect("released") }))
        } else {
            Resolution::Now(Ok(Resolved::Session(session())))
        }
    })))
    .await;
    let inspecting = Arc::clone(&admitted);
    let resolving = Arc::clone(&resolved);
    peer.owner
        .run(move |state| {
            receive(state, (request(1, Some(jwt())), "a", None));
            receive(state, (request(3, None), "a", None));
            receive(
                state,
                (
                    request(5, Some(Credential::Elsewhere)),
                    "a",
                    Some("Bearer a.b.c"),
                ),
            );
            receive(
                state,
                (request(7, Some(Credential::Opaque(token()))), "a", None),
            );
            receive(state, (request(1, None), "a", None));
            assert_eq!(ids(&inspecting), [3, 7]);
            assert_eq!(
                locked(&resolving)
                    .iter()
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>(),
                [1, 3, 5, 7]
            );
        })
        .await
        .expect("NONE and OPAQUE admitted in the receive turn");
    peer.settle().await;
    assert_eq!(ids(&admitted), [3, 7, 1, 5]);
    peer.owner.run(|state| {
        receive(state, (request(9, Some(jwt())), "a", None));
        receive(state, (request(9, Some(jwt())), "a", None));
        assert_eq!(state.reports.len(), 2);
        assert!(state.reports.iter().all(|(handle, error)| handle.as_ref() == "a" && matches!(error, crate::router::types::RouterError::Failure(failure) if failure.code() == ProtocolCode::ENVELOPE_MALFORMED.get())));
    }).await.expect("a resolving call holds its id");
    release
        .send(Ok(Resolved::Session(session())))
        .expect("resolution released");
    peer.settle().await;
    assert_eq!(ids(&admitted), [3, 7, 1, 5, 9]);
    assert_eq!(locked(&handed).len(), 5);
    assert_eq!(
        *locked(&resolved),
        [
            (1, None),
            (3, None),
            (5, Some("Bearer a.b.c".to_owned())),
            (7, None),
            (9, None)
        ]
    );
    assert!(peer.sent().await.is_empty(), "no envelope is sent");
}
