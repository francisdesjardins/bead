//! A credential that does not hold, and the distinction between a credential and an admission.

use core::num::NonZeroU16;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::router_core_requester::quiet;
use super::router_core_sessions::{failures, handler, receive, request, serving, session};
use super::{Handed, locked, token};
use crate::constants::{CredentialScheme, FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::failure::Failure;
use crate::router::core::{self as router_core, AdmissionRefusal, Resolution, Resolved};
use crate::router::types::RouterLimitsOptions;
use crate::testing::core_port::{Peer, scripted_header};
use crate::testing::pair::echo;

fn resolved(session: Option<crate::router::types::CallSession>) -> Resolution {
    Resolution::Now(Ok(session.map_or(Resolved::None, Resolved::Session)))
}

// spec 13.1
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared bare and fallback-session scenarios include each refused and admitted request"
)]
async fn a_credential_that_does_not_resolve_is_refused_session_required_whatever_its_procedure_requires_never_admitted_an_elsewhere_as_one_that_came_without_none_resolving_to_none_runs_in_none()
 {
    let (first, handed, admitted) = serving(Some(Box::new(|_, _| resolved(None)))).await;
    let (bare, bare_handed, bare_admitted) = serving(None).await;
    first
        .owner
        .run(|state| {
            for (id, credential, carried) in [
                (1, Some(Credential::Opaque(token())), None),
                (3, None, None),
                (5, Some(Credential::Elsewhere), None),
                (7, Some(Credential::Elsewhere), Some("Interop sub=Ada")),
            ] {
                receive(state, (request(id, credential), "a", carried));
            }
        })
        .await
        .expect("unresolved credentials received");
    bare.receive((
        request(1, Some(Credential::Opaque(token()))),
        Arc::from("a"),
    ));
    bare.receive((request(3, None), Arc::from("a")));
    first.settle().await;
    bare.settle().await;
    let required = ProtocolCode::SESSION_REQUIRED.get().get();
    assert_eq!(
        failures(&first).await,
        [
            (1, required, "the credential does not hold".to_owned()),
            (5, required, "no credential came".to_owned()),
            (7, required, "the credential does not hold".to_owned()),
        ]
    );
    assert_eq!(
        failures(&bare).await,
        [(1, required, "the credential does not hold".to_owned())]
    );
    for records in [&admitted, &bare_admitted] {
        assert!(
            matches!(locked(records).as_slice(), [only] if only.header.call_id == 3 && only.session.is_none())
        );
    }
    for records in [&handed, &bare_handed] {
        assert!(
            matches!(locked(records).as_slice(), [only] if only.header.call_id == 3 && only.session.is_none())
        );
    }
    quiet(&first).await;
    quiet(&bare).await;

    let held_token = Arc::new(Mutex::new(Some(token())));
    let resolving = Arc::clone(&held_token);
    let (fallback, handed, _) = serving(Some(Box::new(move |request, _| {
        resolved(crate::call_session::connection_session_of(
            request.carried.header.credential.as_ref(),
            (locked(&resolving).as_ref(), None),
        ))
    })))
    .await;
    // The connection token differs from the one presented first.
    let other = crate::session_token::SessionToken::new([1; 16]).expect("a different token");
    fallback
        .owner
        .run(move |state| {
            state.tokens.insert(Arc::from("a"), token());
            receive(
                state,
                (request(1, Some(Credential::Opaque(other))), "a", None),
            );
            receive(state, (request(3, Some(Credential::Elsewhere)), "a", None));
        })
        .await
        .expect("wrong or absent credentials");
    fallback.settle().await;
    *locked(&held_token) = None;
    fallback
        .owner
        .run(|state| {
            state.tokens.clear();
            receive(
                state,
                (request(5, Some(Credential::Opaque(token()))), "a", None),
            );
            receive(
                state,
                (
                    request(13, Some(Credential::Elsewhere)),
                    "a",
                    Some("Interop sub=ada"),
                ),
            );
        })
        .await
        .expect("no connection session");
    fallback.settle().await;
    *locked(&held_token) = Some(token());
    fallback
        .owner
        .run(|state| {
            state.tokens.insert(Arc::from("a"), token());
            receive(
                state,
                (request(7, Some(Credential::Opaque(token()))), "a", None),
            );
            receive(state, (request(9, None), "a", None));
        })
        .await
        .expect("connection session restored");
    *locked(&held_token) = None;
    fallback
        .owner
        .run(|state| {
            state.tokens.clear();
            receive(state, (request(11, None), "a", None));
        })
        .await
        .expect("NONE also runs without a session");
    fallback.settle().await;
    assert_eq!(
        failures(&fallback).await,
        [
            (1, required, "the credential does not hold".to_owned()),
            (3, required, "no credential came".to_owned()),
            (5, required, "the credential does not hold".to_owned()),
            (13, required, "the credential does not hold".to_owned()),
        ]
    );
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| (props.header.call_id, props.session.is_some()))
            .collect::<Vec<_>>(),
        [(7, true), (9, true), (11, false)]
    );
    quiet(&fallback).await;
}

// spec 13.1, 9.2
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "both sides and every credential exercise each protocol and application refusal, with both NONE session outcomes"
)]
async fn answers_an_admissions_session_required_to_a_request_that_presented_a_credential_access_denied_its_detail_kept_and_to_one_that_presented_none_session_required_whatever_its_handler()
 {
    for side in [RouterSide::Server, RouterSide::Client] {
        for none_has_session in [false, true] {
            let peer = Peer::new(side, &RouterLimitsOptions::default());
            let admitted = Arc::new(Mutex::new(0));
            let counting = Arc::clone(&admitted);
            peer.owner
                .run(move |state| {
                    state.schemes = vec![CredentialScheme::JWT, CredentialScheme::ELSEWHERE];
                    state.session = Some(Box::new(move |request, _| {
                        resolved(
                            (request.carried.header.credential.is_some() || none_has_session)
                                .then(session),
                        )
                    }));
                    for (id, detail, application) in [
                        (1, "", false),
                        (4, "sign in first", false),
                        (5, "its own", true),
                        (6, "short of its scope", false),
                        (7, "", true),
                    ] {
                        let mut procedure = echo();
                        procedure.id = id;
                        let mut refusing = handler((&Handed::default(), &Arc::default()));
                        let counting = Arc::clone(&counting);
                        refusing.admit = Some(Arc::new(move |_| {
                            *locked(&counting) += 1;
                            let failure = if application {
                                Failure::application(NonZeroU16::new(32).expect("a code"), detail)
                            } else {
                                Failure::protocol(ProtocolCode::SESSION_REQUIRED, side)
                                    .saying(detail)
                            };
                            Ok(Some(AdmissionRefusal { failure, by: None }))
                        }));
                        router_core::register_resolver(
                            &state.core.resolvers,
                            (&procedure, refusing, None),
                        )
                        .expect("refusing procedure registered");
                    }
                })
                .await
                .expect("refusing handlers ready");
            let first = if side == RouterSide::Server { 1 } else { 2 };
            peer.owner
                .run(move |state| {
                    let mut id = first;
                    for procedure_id in [1, 4, 6] {
                        for credential in [
                            None,
                            Some(Credential::Opaque(token())),
                            Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                            Some(Credential::Elsewhere),
                        ] {
                            receive(
                                state,
                                (
                                    Envelope::Request {
                                        header: RequestHeader {
                                            procedure_id,
                                            credential,
                                            ..scripted_header(id)
                                        },
                                        payload: Bytes::new(),
                                    },
                                    "a",
                                    Some("carried"),
                                ),
                            );
                            id += 2;
                        }
                    }
                    for procedure_id in [5, 7] {
                        receive(
                            state,
                            (
                                Envelope::Request {
                                    header: RequestHeader {
                                        procedure_id,
                                        credential: Some(Credential::Jwt(Bytes::from_static(
                                            b"a.b.c",
                                        ))),
                                        ..scripted_header(id)
                                    },
                                    payload: Bytes::new(),
                                },
                                "a",
                                None,
                            ),
                        );
                        id += 2;
                    }
                })
                .await
                .expect("every credential presented to each refusal");
            peer.settle().await;
            let mut actual = peer
                .sent()
                .await
                .into_iter()
                .map(|(_, envelope)| {
                    let Envelope::Failure { header, failure } = envelope else {
                        panic!("a refusal");
                    };
                    (
                        header.call_id,
                        failure.code.get(),
                        failure.scope,
                        failure.detail,
                    )
                })
                .collect::<Vec<_>>();
            actual.sort_by_key(|(id, ..)| *id);
            let mut expected = Vec::new();
            let mut id = first;
            for detail in ["", "sign in first", "short of its scope"] {
                for credential in 0..4 {
                    expected.push((
                        id,
                        if credential == 0 {
                            ProtocolCode::SESSION_REQUIRED.get().get()
                        } else {
                            ProtocolCode::ACCESS_DENIED.get().get()
                        },
                        FailureScope::Protocol,
                        detail.to_owned(),
                    ));
                    id += 2;
                }
            }
            for detail in ["its own", ""] {
                expected.push((id, 32, FailureScope::Application, detail.to_owned()));
                id += 2;
            }
            assert_eq!(actual, expected);
            assert_eq!(*locked(&admitted), 14);
            quiet(&peer).await;
        }
    }
}
