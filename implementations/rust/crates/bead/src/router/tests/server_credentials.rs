//! The server's construction gate: JWT header room, valid keys, audiences and issuers.

use std::sync::Arc;

use crate::credentials::{Credentials, JwtKeySet};
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::router::relay::RelayOptions;
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::RouterLimitsOptions;
use crate::testing::SteppingClock;
use crate::testing::scripted::ScriptedServer;

fn key(length: usize) -> JwtKey {
    JwtKey {
        algorithm: JwtAlgorithm::Hs256,
        issuer: "https://issuer.example".to_owned(),
        jwk: serde_json::from_value(serde_json::json!({"k":"A".repeat(length),"kty":"oct"}))
            .expect("a key object"),
    }
}

fn key_set(issuers: Vec<String>) -> JwtKeySet {
    JwtKeySet {
        ask: Arc::new(|_, _| Box::pin(async { Ok(Vec::new()) })),
        issuers,
        maximum_waiting_calls: None,
    }
}

fn jwt_sources() -> [Credentials; 2] {
    [
        Credentials {
            keys: vec![key(43)],
            ..Credentials::default()
        },
        Credentials {
            key_set: Some(key_set(vec!["https://keys.example".to_owned()])),
            ..Credentials::default()
        },
    ]
}

#[tokio::test]
async fn refuses_as_it_is_built_limits_that_hold_no_header_of_1020_bytes_once_it_takes_a_jwt() {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedServer::new(clock);
    let limits = RouterLimitsOptions {
        chunk_bytes: Some(1_000),
        maximum_envelope_bytes: Some(1_000),
        window_bytes: Some(2_000),
        ..RouterLimitsOptions::default()
    };
    for mut credentials in jwt_sources() {
        credentials.audience = Some("https://bead.example".to_owned());
        let error = RouterServer::new(
            Arc::<ScriptedServer>::clone(&transport),
            &RouterServerOptions {
                credentials: Some(credentials),
                limits: Some(limits.clone()),
                ..RouterServerOptions::default()
            },
        )
        .expect_err("a JWT header needs its room");
        assert!(error.message().contains("limits do not hold together"));
    }
    RouterServer::new(
        Arc::<ScriptedServer>::clone(&transport),
        &RouterServerOptions {
            credentials: Some(Credentials {
                audience: Some("https://bead.example".to_owned()),
                keys: vec![key(42)],
                ..Credentials::default()
            }),
            ..RouterServerOptions::default()
        },
    )
    .expect_err("a short HS256 key is a programmer error");
    let router = RouterServer::new(
        transport,
        &RouterServerOptions {
            credentials: Some(Credentials {
                verify: Some(Arc::new(|_, _| Box::pin(async { Ok(None) }))),
                ..Credentials::default()
            }),
            limits: Some(limits),
            ..RouterServerOptions::default()
        },
    )
    .expect("an ELSEWHERE verifier needs no JWT header room");
    assert_eq!(router.limits().chunk_bytes, 1_000);
    router.dispose().await;
}

#[tokio::test]
async fn refuses_as_it_is_built_keys_or_a_key_set_without_an_audience_whatever_its_relay_does_and_a_key_set_given_no_issuer()
 {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedServer::new(clock);
    for credentials in jwt_sources() {
        for verifies in [None, Some(false), Some(true)] {
            RouterServer::new(
                Arc::<ScriptedServer>::clone(&transport),
                &RouterServerOptions {
                    credentials: Some(credentials.clone()),
                    relay: verifies.map(|verifies| RelayOptions {
                        verifies,
                        ..RelayOptions::default()
                    }),
                    ..RouterServerOptions::default()
                },
            )
            .expect_err("a server verifies its own audience whatever its relay does");
        }
    }
    RouterServer::new(
        Arc::<ScriptedServer>::clone(&transport),
        &RouterServerOptions {
            credentials: Some(Credentials {
                audience: Some("https://bead.example".to_owned()),
                key_set: Some(key_set(Vec::new())),
                ..Credentials::default()
            }),
            ..RouterServerOptions::default()
        },
    )
    .expect_err("a key set names at least one issuer");
    RouterServer::new(
        transport,
        &RouterServerOptions {
            credentials: Some(Credentials {
                verify: Some(Arc::new(|_, _| Box::pin(async { Ok(None) }))),
                ..Credentials::default()
            }),
            ..RouterServerOptions::default()
        },
    )
    .expect("an ELSEWHERE verifier needs no audience")
    .dispose()
    .await;
}

#[tokio::test]
async fn requests_run_in_none_without_a_session_of_and_one_presenting_a_credential_is_refused_session_required_or_credential_unsupported()
 {
    let served = super::server::Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(|_| Ok(Some(super::token())))),
        ..RouterServerOptions::default()
    });
    served
        .services
        .get_request_resolver(
            &crate::testing::pair::echo(),
            crate::managers::service::ResolverDependencies::of(
                crate::payloads::TextCodec,
                crate::payloads::TextCodec,
            ),
        )
        .expect("echo resolved")
        .on(Arc::new(
            |request, response: crate::managers::service::Response<crate::payloads::TextCodec>| {
                response.result(
                    if request.session.is_none() {
                        "none"
                    } else {
                        "a session"
                    }
                    .to_owned(),
                )
            },
        ))
        .expect("echo registered");
    for (call_id, credential) in [
        (1, None),
        (3, Some(crate::envelope::Credential::Opaque(super::token()))),
        (
            5,
            Some(crate::envelope::Credential::Jwt(bytes::Bytes::from_static(
                b"a.b.c",
            ))),
        ),
    ] {
        served.transport.deliver(
            &crate::envelope::Envelope::Request {
                header: crate::envelope::RequestHeader {
                    credential,
                    ..super::request_header_of(call_id)
                },
                payload: bytes::Bytes::new(),
            },
            &super::server::first(),
        );
        served.settle().await;
    }
    assert_eq!(
        served.sent_since(),
        [
            "first result 1 none",
            "first failure 3 SESSION_REQUIRED",
            "first failure 5 CREDENTIAL_UNSUPPORTED"
        ]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}
