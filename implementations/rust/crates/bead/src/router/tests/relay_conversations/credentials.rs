//! A relay's unresolved credentials, connection sessions and admission, before leg B.

mod keys;

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::json;

use super::super::server::{first, header_of};
use super::super::{answered, locked};
use super::{Relayed, RelayedOptions, admitting, cancel, request};
use crate::call_session::connection_session_of;
use crate::constants::{CredentialScheme, EnvelopeKind, FailureScope, ProtocolCode};
use crate::envelope::{Credential, Envelope, FailureHeader, FailureRecord, ResultHeader};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::admissions::{BeforeRequest, require_session};
use crate::router::relay::RelayOptions;
use crate::router::server::RouterServerOptions;
use crate::router::types::{RequestCredential, TransportMessage};
use crate::session_token::SessionToken;
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::testing::scripted::bytes_of;

fn token() -> SessionToken {
    SessionToken::new([7; 16]).expect("the connection's token")
}

fn presenting(envelope: Envelope, credential: Credential) -> Envelope {
    let Envelope::Request {
        mut header,
        payload,
    } = envelope
    else {
        panic!("a request presents a credential")
    };
    header.credential = Some(credential);
    Envelope::Request { header, payload }
}

fn refused((id, code): (u32, ProtocolCode), detail: &str) -> (crate::ConnectionHandle, Envelope) {
    (
        first(),
        Envelope::Failure {
            header: FailureHeader {
                call_id: id,
                credential: None,
            },
            failure: FailureRecord {
                code: code.get(),
                scope: FailureScope::Protocol,
                detail: detail.to_owned(),
                relays: 0,
            },
        },
    )
}

fn result(id: u32, payload: &'static [u8]) -> (crate::ConnectionHandle, Envelope) {
    (
        first(),
        Envelope::Result {
            header: ResultHeader {
                call_id: id,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(payload),
        },
    )
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin keeps both sources' credential matrices and their distinct delivery orders"
)]
async fn hands_before_route_a_jwt_unresolved_refusing_a_scheme_to_come_credential_unsupported_and_an_elsewhere_that_carried_nothing_session_required_before_it_opaque_resolves_to_leg_as_connections_session_which_before_route_reads()
 {
    for batched in [false, true] {
        let held = if batched {
            token()
        } else {
            super::super::token()
        };
        let admitted = Arc::new(Mutex::new(Vec::new()));
        let admitting = Arc::clone(&admitted);
        let relayed = Relayed::new(&RelayedOptions {
            relay: RelayOptions {
                before_route: Some(BeforeRequest::new(
                    move |request| {
                        locked(&admitting).push((
                            request.header.call_id,
                            request
                                .session
                                .as_ref()
                                .and_then(|session| session.data.clone()),
                        ));
                        true
                    },
                    None,
                )),
                ..RelayOptions::default()
            },
            server: RouterServerOptions {
                session_of: Some(Arc::new(move |request, _| {
                    Ok(connection_session_of(
                        request.header.credential.as_ref(),
                        (Some(&held), Some(json!("ada"))),
                    ))
                })),
                ..RouterServerOptions::default()
            },
            ..RelayedOptions::default()
        })
        .await;
        for (id, destination, credential) in [
            (1, 7, Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            (3, 7, Credential::Elsewhere),
            (
                5,
                8,
                Credential::ToCome {
                    scheme: CredentialScheme::new(7),
                    bytes: Bytes::new(),
                },
            ),
        ] {
            relayed.deliver(&presenting(
                request((id, destination), (&echo(), "")),
                credential,
            ));
            if !batched {
                relayed.served.settle().await;
            }
        }
        relayed.served.settle().await;
        let jwt = refused(
            (1, ProtocolCode::DESTINATION_UNREACHABLE),
            "destination 7 is unreachable: it verifies another audience than the one the token names, or none",
        );
        let elsewhere = refused((3, ProtocolCode::SESSION_REQUIRED), "no credential came");
        let future = refused(
            (5, ProtocolCode::CREDENTIAL_UNSUPPORTED),
            "OPAQUE, JWT, ELSEWHERE",
        );
        assert_eq!(
            relayed.served.transport.take(),
            if batched {
                vec![future, jwt, elsewhere]
            } else {
                vec![jwt, elsewhere, future]
            }
        );
        assert_eq!(core::mem::take(&mut *locked(&admitted)), [(1, None)]);
        assert!(locked(&relayed.sent).is_empty());
        let other = if batched {
            SessionToken::new([8; 16]).expect("another token")
        } else {
            "AQIDBAUGBwgJCgsMDQ4PEA"
                .parse::<SessionToken>()
                .expect("another token")
        };
        for envelope in [
            request((7, 7), (&echo(), "hi")),
            presenting(request((9, 7), (&echo(), "ho")), Credential::Opaque(held)),
            presenting(request((11, 7), (&echo(), "")), Credential::Opaque(other)),
        ] {
            relayed.deliver(&envelope);
            if !batched {
                relayed.served.settle().await;
            }
        }
        relayed.served.settle().await;
        let invalid = refused(
            (11, ProtocolCode::SESSION_REQUIRED),
            "the credential does not hold",
        );
        assert_eq!(
            relayed.served.transport.take(),
            if batched {
                vec![invalid, result(7, b"HI"), result(9, b"HO")]
            } else {
                vec![result(7, b"HI"), result(9, b"HO"), invalid]
            }
        );
        assert_eq!(
            *locked(&admitted),
            [(7, Some(json!("ada"))), (9, Some(json!("ada")))]
        );
        assert_eq!(
            *locked(&relayed.received),
            [
                (header_of((1, &echo())), Bytes::from_static(b"hi")),
                (header_of((3, &echo())), Bytes::from_static(b"ho")),
            ]
        );
        assert_eq!(*locked(&relayed.sent), [EnvelopeKind::Request; 2]);
        assert_eq!(relayed.served.reported(), Vec::<String>::new());
        relayed.dispose().await;
    }
}

#[tokio::test]
async fn answers_a_jwt_and_an_elsewhere_it_forwards_without_verifying_access_denied_once_before_route_is_require_session_a_call_in_none_session_required_and_relays_an_opaque_that_holds()
 {
    let relayed = Relayed::new(&RelayedOptions {
        relay: RelayOptions {
            before_route: Some(require_session()),
            ..RelayOptions::default()
        },
        server: RouterServerOptions {
            session_of: Some(Arc::new(|request, _| {
                Ok(request.header.credential.as_ref().and_then(|credential| {
                    connection_session_of(Some(credential), (Some(&token()), Some(json!("leg A"))))
                }))
            })),
            ..RouterServerOptions::default()
        },
        ..RelayedOptions::default()
    })
    .await;
    relayed.deliver(&presenting(
        request((1, 7), (&echo(), "")),
        Credential::Jwt(Bytes::from_static(b"a.b.c")),
    ));
    relayed.served.transport.deliver_message(
        &TransportMessage {
            data: bytes_of(&presenting(
                request((3, 7), (&echo(), "")),
                Credential::Elsewhere,
            )),
            credential: Some("Bearer mF_9.B5f-4.1JqM".to_owned()),
            ..TransportMessage::default()
        },
        &first(),
    );
    relayed.deliver(&request((5, 7), (&echo(), "")));
    relayed.deliver(&presenting(
        request((7, 7), (&echo(), "hi")),
        Credential::Opaque(token()),
    ));
    relayed.served.settle().await;
    let mut sent = relayed.served.transport.take();
    sent.sort_by_key(|(_, envelope)| envelope.call_id());
    for ((handle, envelope), (id, expected)) in sent.iter().zip([
        (1, ProtocolCode::ACCESS_DENIED),
        (3, ProtocolCode::ACCESS_DENIED),
        (5, ProtocolCode::SESSION_REQUIRED),
    ]) {
        assert_eq!(handle, &first());
        let Envelope::Failure { header, failure } = envelope else {
            panic!("the call is refused")
        };
        assert_eq!(
            *header,
            FailureHeader {
                call_id: id,
                credential: None
            }
        );
        assert_eq!(
            (failure.code, failure.scope, failure.relays),
            (expected.get(), FailureScope::Protocol, 0)
        );
    }
    assert_eq!(sent.len(), 4);
    assert_eq!(sent.last(), Some(&result(7, b"HI")));
    assert_eq!(
        *locked(&relayed.received),
        [(header_of((1, &echo())), Bytes::from_static(b"hi"))]
    );
    assert_eq!(*locked(&relayed.sent), [EnvelopeKind::Request]);
    assert_eq!(relayed.served.reported(), Vec::<String>::new());
    relayed.dispose().await;
}

#[tokio::test]
async fn keeps_the_default_jwt_a_client_presents_through_a_relay_whose_before_route_is_require_session_its_access_denied_withdraws_nothing()
 {
    let behind = Relayed::new(&RelayedOptions {
        relay: admitting(),
        ..RelayedOptions::default()
    })
    .await;
    let credential = RequestCredential::Jwt("a.b.c".to_owned());
    let leg_a = Pair::connected(
        super::super::january_first(),
        &PairOptions {
            server: Some(crate::server::ServerOptions {
                relay: Some(RelayOptions {
                    before_route: Some(require_session()),
                    ..RelayOptions::default()
                }),
                ..crate::server::ServerOptions::default()
            }),
            client: Some(crate::client::ClientOptions {
                credential: Some(credential.clone()),
                ..crate::client::ClientOptions::default()
            }),
        },
    )
    .await
    .expect("leg A connected");
    leg_a
        .server
        .router()
        .register_destination(
            behind.device.client.router().as_relay_target(),
            &crate::router::relay::DestinationOptions {
                destination_id: Some(7),
                ..crate::router::relay::DestinationOptions::default()
            },
        )
        .expect("the target registered");
    let withdrawn = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&withdrawn);
    leg_a
        .client
        .router()
        .on_credential_withdrawn(Arc::new(move |scheme| locked(&hearing).push(scheme)));
    let mut options = super::super::request_of((None, Duration::from_secs(5)));
    options.options.destination_id = Some(7);
    let calling = leg_a
        .client
        .router()
        .request(Bytes::from_static(b"hi"), options)
        .expect("a request");
    let Err(CallError::Failure(failure)) = answered(calling).await else {
        panic!("the relay denies the unresolved JWT")
    };
    assert_eq!(
        (failure.code(), failure.relays(), failure.origin()),
        (ProtocolCode::ACCESS_DENIED.get(), 0, FailureOrigin::Peer)
    );
    assert!(locked(&withdrawn).is_empty());
    assert_eq!(leg_a.client.router().credential(), Some(credential));
    assert!(locked(&behind.sent).is_empty());
    assert!(locked(&leg_a.server_reports).is_empty());
    leg_a.client.dispose().await;
    leg_a.server.dispose().await.expect("the server disposed");
    behind.dispose().await;
}

#[tokio::test]
async fn answers_a_jwt_past_the_calls_its_key_set_lets_wait_capacity_exceeded_at_its_first_step_reporting_nothing_as_a_relay_that_verifies()
 {
    use crate::credentials::Credentials;
    use crate::router::relay::DestinationOptions;

    for dotnet in [false, true] {
        let keys = keys::Keys::new(dotnet);
        let relayed = Relayed::new(&RelayedOptions {
            relay: RelayOptions {
                verifies: Some(true),
                ..admitting()
            },
            server: RouterServerOptions {
                credentials: Some(Credentials {
                    audience: Some(keys.audience.to_owned()),
                    key_set: Some(keys.key_set()),
                    ..Credentials::default()
                }),
                ..RouterServerOptions::default()
            },
            destination: DestinationOptions {
                audience: Some(keys.audience.to_owned()),
                ..DestinationOptions::default()
            },
            start: Some(keys.start()),
            ..RelayedOptions::default()
        })
        .await;
        let presenting_jwt = |id, payload| {
            presenting(
                request((id, 7), (&echo(), payload)),
                Credential::Jwt(Bytes::from(keys.jwt())),
            )
        };
        relayed.deliver(&presenting_jwt(1, "hi"));
        relayed.served.settle().await;
        assert_eq!(keys.asked(), 1);
        relayed.deliver(&cancel(1));
        relayed.served.settle().await;
        keys.release(true);
        relayed.served.settle().await;
        relayed.deliver(&presenting_jwt(3, if dotnet { "ho" } else { "hi" }));
        relayed.deliver(&presenting_jwt(5, if dotnet { "hu" } else { "hi" }));
        relayed.served.settle().await;
        let sent = relayed.served.transport.take();
        assert_eq!(sent.len(), 1);
        let (handle, Envelope::Failure { header, failure }) = &sent[0] else {
            panic!("the call past the bound is refused")
        };
        assert_eq!(handle, &first());
        assert_eq!(
            *header,
            FailureHeader {
                call_id: 5,
                credential: None
            }
        );
        assert_eq!(
            (failure.code, failure.scope, failure.relays),
            (
                ProtocolCode::CAPACITY_EXCEEDED.get(),
                FailureScope::Protocol,
                0
            )
        );
        assert_eq!(
            keys.asked(),
            1,
            "the first ask's keys are held until the deadline"
        );
        assert!(locked(&relayed.sent).is_empty());
        relayed.device.clock.advance(Duration::from_secs(60)).await;
        assert_eq!(keys.asked(), 2, "one more ask at the deadline");
        keys.release(false);
        relayed.served.settle().await;
        assert_eq!(*locked(&relayed.sent), [EnvelopeKind::Request]);
        let answer = relayed.served.transport.take();
        assert_eq!(answer.len(), 1);
        assert_eq!(answer[0].0, first());
        assert_eq!(answer[0].1.call_id(), 3);
        assert!(matches!(
            answer[0].1,
            Envelope::Result { .. } | Envelope::Failure { .. }
        ));
        assert_eq!(relayed.served.reported(), Vec::<String>::new());
        relayed.dispose().await;
    }
}
