//! Credential refusals tell their stage and reason, whatever a listener does with the event.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::server::{Served, first, header_of, request_of, second};
use super::{locked, token};
use crate::clock::SharedClock;
use crate::constants::{CredentialScheme, ProtocolCode};
use crate::credentials::{Credentials, ElsewhereSession};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::managers::service::{RequestResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::admissions::{BeforeRequest, require_session};
use crate::router::relay::{DestinationOptions, RelayOptions, RelayTarget};
use crate::router::server::RouterServerOptions;
use crate::router::types::{AccessRefusal, AccessRefusalStage, RouterError, TransportMessage};
use crate::server::{Server, ServerOptions};
use crate::testing::pair::echo;
use crate::testing::scripted::{ScriptedServer, bytes_of};
use crate::testing::{SteppingClock, instants, vectors};

fn expected((code, scheme, reason): (u16, CredentialScheme, &str)) -> AccessRefusal {
    AccessRefusal {
        stage: AccessRefusalStage::Credential,
        code,
        credential_scheme: Some(scheme),
        reason: Some(reason.to_owned()),
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        connection_handle: first(),
        address: Some("192.0.2.40".to_owned()),
        port: Some(50_040),
    }
}

fn presenting((credential, destination_id): (Credential, Option<u32>)) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            credential: Some(credential),
            destination_id,
            ..header_of((1, &echo()))
        },
        payload: Bytes::new(),
    }
}

fn message(envelope: &Envelope, carried: Option<String>) -> TransportMessage {
    TransportMessage {
        data: bytes_of(envelope),
        credential: carried,
        address: Some("192.0.2.40".to_owned()),
        port: Some(50_040),
        ..TransportMessage::default()
    }
}

fn echoed(server: &Server) {
    server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo resolved")
        .on(Arc::new(|_, response: Response<TextCodec>| {
            response.result("ran".to_owned())
        }))
        .expect("echo registered");
}

#[derive(Deserialize)]
struct VectorKey {
    issuer: String,
    algorithm: String,
    jwk: Map<String, Value>,
}

#[derive(Deserialize)]
struct Verdict {
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audiences {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct JwtVector {
    name: String,
    token: String,
    keys: Vec<VectorKey>,
    audience: Audiences,
    now: String,
    verdict: Verdict,
}

fn jwt_vectors() -> (Vec<JwtVector>, usize) {
    let entries: Vec<JwtVector> = vectors::of("jwtVerdicts").expect("the JWT verdicts");
    let refused = entries
        .iter()
        .filter(|vector| vector.verdict.reason.is_some())
        .count();
    assert!(refused > 0, "the corpus holds refused verdicts");
    (entries, refused)
}

#[expect(
    clippy::too_many_lines,
    reason = "the twin plays every refusing verdict of the vectors in one pass"
)]
#[tokio::test]
async fn tells_a_jwt_refused_by_the_step_of_section_13_8_that_refused_it_for_every_verdict_of_spec_vectors_json_that_refuses()
 {
    let (entries, refused) = jwt_vectors();
    let mut played = 0;
    for vector in entries {
        let Some(reason) = vector.verdict.reason else {
            continue;
        };
        let clock =
            SteppingClock::new(instants::instant_of(&vector.now).expect("the vector's instant"));
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let (audience, audiences) = match vector.audience {
            Audiences::One(audience) => (audience, None),
            Audiences::Many(audiences) => (
                audiences.first().expect("at least one audience").clone(),
                Some(audiences),
            ),
        };
        let served = Served::on(
            (shared, clock),
            &RouterServerOptions {
                credentials: Some(Credentials {
                    audience: Some(audience),
                    keys: vector
                        .keys
                        .into_iter()
                        .map(|key| JwtKey {
                            issuer: key.issuer,
                            algorithm: JwtAlgorithm::named(&key.algorithm)
                                .expect("the vector's algorithm"),
                            jwk: key.jwk,
                        })
                        .collect(),
                    ..Credentials::default()
                }),
                relay: audiences.as_ref().map(|_| RelayOptions {
                    verifies: Some(true),
                    before_route: Some(BeforeRequest::new(|_| true, None)),
                    ..RelayOptions::default()
                }),
                ..RouterServerOptions::default()
            },
        );
        served.transport.open(&first(), true);
        let destination_id = audiences.map(|audiences| {
            served.transport.open(&second(), true);
            for (index, audience) in audiences.into_iter().enumerate() {
                served
                    .router
                    .register_destination(
                        RelayTarget::Connection(second()),
                        &DestinationOptions {
                            destination_id: Some(
                                7 + u32::try_from(index).expect("a destination id"),
                            ),
                            audience: Some(audience),
                            ..DestinationOptions::default()
                        },
                    )
                    .expect("the audience's destination registered");
            }
            7
        });
        served
            .services
            .get_request_resolver(
                &echo(),
                RequestResolverDependencies::new(TextCodec, TextCodec),
            )
            .expect("echo resolved")
            .on(Arc::new(|_, response: Response<TextCodec>| {
                response.result("ran".to_owned())
            }))
            .expect("echo registered");
        let told = Arc::new(Mutex::new(Vec::new()));
        let telling = Arc::clone(&told);
        served.router.on_access_refused(Arc::new(move |refusal| {
            locked(&telling).push(refusal.clone());
        }));
        served.transport.deliver_message(
            &message(
                &presenting((Credential::Jwt(Bytes::from(vector.token)), destination_id)),
                None,
            ),
            &first(),
        );
        served.settle().await;
        let mut refusal = expected((
            ProtocolCode::SESSION_REQUIRED.get().get(),
            CredentialScheme::JWT,
            &reason,
        ));
        refusal.destination_id = destination_id;
        assert_eq!(*locked(&told), [refusal], "{}", vector.name);
        assert_eq!(
            served.sent_since(),
            ["first failure 1 SESSION_REQUIRED"],
            "{}",
            vector.name
        );
        assert_eq!(served.reported(), Vec::<String>::new(), "{}", vector.name);
        served.router.dispose().await;
        played += 1;
    }
    assert_eq!(played, refused, "every refused verdict");
}

#[derive(Deserialize)]
struct CredentialVector {
    name: String,
    scheme: Value,
    situation: String,
    code: u16,
    reason: String,
}

fn credentials_for(situation: &str) -> Credentials {
    Credentials {
        verify: (situation != "no-verifier").then(|| {
            let verifier: crate::credentials::ElsewhereVerifier = Arc::new(|carried: String, _| {
                Box::pin(async move {
                    Ok(match carried.as_str() {
                        "none" => None,
                        _ => Some(ElsewhereSession {
                            id: "ada".to_owned(),
                            data: None,
                            end: (carried == "ended").then_some(1_767_225_600_000.0),
                        }),
                    })
                })
            });
            verifier
        }),
        ..Credentials::default()
    }
}

#[tokio::test]
async fn tells_each_credential_refused_by_the_reason_spec_vectors_jsons_credential_refusals_gives_it()
 {
    let entries: Vec<CredentialVector> =
        vectors::of("credentialRefusals").expect("the credential refusals");
    let count = entries.len();
    for vector in entries {
        let clock = SteppingClock::new(instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = ScriptedServer::new(shared);
        let credentials = credentials_for(&vector.situation);
        let carried: Arc<dyn crate::transport::ServerTransport> =
            Arc::<ScriptedServer>::clone(&transport);
        let server = Server::new(
            carried,
            &ServerOptions {
                credentials: Some(credentials),
                ..ServerOptions::default()
            },
        )
        .expect("a server");
        echoed(&server);
        transport.open(&first(), true);
        transport.open(&second(), true);
        clock.settle().await;
        let stored = server
            .sessions()
            .set(server.sessions().create(second()))
            .expect("a session can be set")
            .await
            .expect("a session stored");
        let credential = match vector.situation.as_str() {
            "another-connections-session" => {
                Credential::Opaque(stored.session_token.expect("a stored token"))
            }
            "no-session" => Credential::Opaque(token()),
            "no-keys" => Credential::Jwt(Bytes::from_static(b"a.b.c")),
            "scheme-to-come" => Credential::ToCome {
                scheme: CredentialScheme::new(
                    u16::try_from(vector.scheme.as_u64().expect("a scheme number"))
                        .expect("a u16 scheme"),
                ),
                bytes: Bytes::new(),
            },
            _ => Credential::Elsewhere,
        };
        let scheme = credential.scheme();
        let carried = match vector.situation.as_str() {
            "verifier-makes-none" => Some("none".to_owned()),
            "end-come" => Some("ended".to_owned()),
            "no-verifier" => Some("Interop sub=ada".to_owned()),
            _ => None,
        };
        let told = Arc::new(Mutex::new(Vec::new()));
        let telling = Arc::clone(&told);
        server.router().on_access_refused(Arc::new(move |refusal| {
            locked(&telling).push(refusal.clone());
        }));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let reporting = Arc::clone(&reports);
        server.router().on_error(Arc::new(move |error, handle| {
            locked(&reporting).push((error.clone(), handle.cloned()));
        }));
        transport.deliver_message(&message(&presenting((credential, None)), carried), &first());
        clock.settle().await;
        let sent = transport.take();
        assert_eq!(sent.len(), 1, "{}", vector.name);
        let Envelope::Failure { header, failure } = &sent[0].1 else {
            panic!("a credential's refusal")
        };
        assert_eq!(sent[0].0, first());
        assert_eq!(
            (header.call_id, failure.code.get()),
            (1, vector.code),
            "{}",
            vector.name
        );
        assert_eq!(
            *locked(&told),
            [expected((vector.code, scheme, &vector.reason))],
            "{}",
            vector.name
        );
        assert_eq!(locked(&reports).len(), 0, "{}", vector.name);
        server.dispose().await.expect("the server disposed");
    }
    assert_eq!(count, 8, "every credential refusal");
}

#[tokio::test]
async fn refuses_as_it_would_though_an_access_refused_listener_throws_the_throw_reported_with_its_connection()
 {
    for in_admission in [true, false] {
        let served = Served::new(&RouterServerOptions::default());
        served.transport.open(&first(), true);
        let guarded = crate::identity::Procedure {
            procedure_id: 2,
            procedure_name: "guarded".to_owned(),
            ..echo()
        };
        let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
        dependencies.before_request = Some(require_session());
        served
            .services
            .get_request_resolver(&guarded, dependencies)
            .expect("guarded resolved")
            .on(Arc::new(|_, response: Response<TextCodec>| {
                response.result("unreached".to_owned())
            }))
            .expect("guarded registered");
        served
            .services
            .get_request_resolver(
                &echo(),
                RequestResolverDependencies::new(TextCodec, TextCodec),
            )
            .expect("echo resolved")
            .on(Arc::new(|_, response: Response<TextCodec>| {
                response.result("ok".to_owned())
            }))
            .expect("echo registered");
        served
            .router
            .on_access_refused(Arc::new(|_| panic!("the listener broke")));
        let after = Arc::new(Mutex::new(Vec::new()));
        let hearing = Arc::clone(&after);
        served.router.on_access_refused(Arc::new(move |refusal| {
            locked(&hearing).push(refusal.clone());
        }));
        let refused = if in_admission {
            request_of((1, &guarded, ""))
        } else {
            presenting((
                Credential::ToCome {
                    scheme: CredentialScheme::new(4),
                    bytes: Bytes::new(),
                },
                None,
            ))
        };
        served.transport.deliver(&refused, &first());
        served
            .transport
            .deliver(&request_of((3, &echo(), "")), &first());
        served.settle().await;
        let code = if in_admission {
            "SESSION_REQUIRED"
        } else {
            "CREDENTIAL_UNSUPPORTED"
        };
        assert_eq!(
            served.sent_since(),
            [
                format!("first failure 1 {code}"),
                "first result 3 ok".to_owned()
            ]
        );
        assert_eq!(locked(&after).len(), 1);
        assert_eq!(
            locked(&after)[0].stage,
            if in_admission {
                AccessRefusalStage::Admission
            } else {
                AccessRefusalStage::Credential
            }
        );
        {
            let reports = locked(&served.reports);
            assert_eq!(reports.len(), 1);
            assert_eq!(reports[0].1, Some(first()));
            assert!(
                matches!(&reports[0].0, RouterError::Other(error) if error.to_string().contains("the listener broke"))
            );
            drop(reports);
        }
        served.router.dispose().await;
    }
}
