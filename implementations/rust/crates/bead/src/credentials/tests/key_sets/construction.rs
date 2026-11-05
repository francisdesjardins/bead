//! Credential configuration refusals and the ELSEWHERE verifier's session.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{AUDIENCE, Fixture, ISSUER, SET_ISSUER, application, locked, resolver};
use crate::clock::SharedClock;
use crate::constants::CredentialScheme;
use crate::credentials::{
    CredentialRequest, CredentialResolver, Credentials, ElsewhereSession, JwtKeySet,
    assert_limits_hold_jwt,
};
use crate::envelope::Credential;
use crate::router::core::Resolved;
use crate::router::types::{CallSession, LIMIT_DEFAULTS, RouterLimits, SessionIdentifier};
use crate::testing::surface::Consumer;

fn configured(
    fixture: &Fixture,
    credentials: &Credentials,
) -> Result<CredentialResolver, crate::errors::ProgrammerError> {
    let shared: SharedClock = Arc::<crate::testing::SteppingClock>::clone(&fixture.clock);
    CredentialResolver::new(
        credentials,
        (
            shared,
            crate::platform::runtime_of(None, "a credential test").expect("a runtime"),
        ),
    )
}

fn key_set(fixture: &Fixture) -> JwtKeySet {
    JwtKeySet {
        ask: fixture.resolver.inner.ask.clone().expect("an ask"),
        issuers: vec![SET_ISSUER.to_owned()],
        maximum_waiting_calls: None,
    }
}

#[tokio::test]
async fn refuses_as_it_is_built_a_key_set_whose_maximum_waiting_calls_is_not_a_whole_number_from_1_to_2147483647_and_takes_either_bound()
 {
    let fixture = Fixture::new(vec![]);
    let mut credentials = Credentials {
        audience: Some(AUDIENCE.to_owned()),
        key_set: Some(key_set(&fixture)),
        ..Credentials::default()
    };
    for bound in [0, 2_147_483_648] {
        credentials
            .key_set
            .as_mut()
            .expect("a set")
            .maximum_waiting_calls = Some(bound);
        let refused = configured(&fixture, &credentials).expect_err("a refusal");
        assert_eq!(
            refused.message(),
            format!(
                "a key set's maximumWaitingCalls is a whole number from 1 to 2147483647, not {bound}"
            )
        );
    }
    for bound in [Some(1), Some(2_147_483_647), None] {
        credentials
            .key_set
            .as_mut()
            .expect("a set")
            .maximum_waiting_calls = bound;
        assert!(
            configured(&fixture, &credentials)
                .expect("a bound that holds")
                .takes_jwt()
        );
    }
    let consumer = Consumer::new();
    consumer
        .accepts("pub fn check(mut set: bead::JwtKeySet) { set.maximum_waiting_calls = Some(1); }");
    consumer.refuses(
        "pub fn check(mut set: bead::JwtKeySet) { set.maximum_waiting_calls = Some(-1); }",
        ("E0600", "cannot apply unary operator"),
    );
    for invalid in ["1.5", "f64::NAN", "f64::INFINITY", "\"2\""] {
        consumer.refuses(&format!("pub fn check(mut set: bead::JwtKeySet) {{ set.maximum_waiting_calls = Some({invalid}); }}"), ("E0308", "mismatched types"));
    }
}

#[tokio::test]
async fn refuses_as_it_is_built_a_key_set_given_no_issuer_or_one_that_is_no_string() {
    let fixture = Fixture::new(vec![]);
    let mut set = key_set(&fixture);
    set.issuers.clear();
    let mut credentials = Credentials {
        audience: Some(AUDIENCE.to_owned()),
        key_set: Some(set),
        ..Credentials::default()
    };
    assert_eq!(
        configured(&fixture, &credentials)
            .expect_err("no issuer")
            .message(),
        "a key set is given with its ask and the issuers it answers for, one at least, each a string"
    );
    credentials
        .key_set
        .as_mut()
        .expect("a set")
        .issuers
        .push(SET_ISSUER.to_owned());
    assert_eq!(
        configured(&fixture, &credentials)
            .expect("named issuer")
            .schemes(),
        [CredentialScheme::JWT]
    );
    let consumer = Consumer::new();
    consumer.accepts(
        "pub fn check(mut set: bead::JwtKeySet) { set.issuers = vec![String::from(\"issuer\")]; }",
    );
    for invalid in ["vec![7]", "vec![String::from(\"issuer\"), None]", "None"] {
        consumer.refuses(
            &format!("pub fn check(mut set: bead::JwtKeySet) {{ set.issuers = {invalid}; }}"),
            ("E0308", "mismatched types"),
        );
    }
}

#[tokio::test]
async fn refuses_as_it_is_built_keys_or_a_key_set_given_without_an_audience() {
    let fixture = Fixture::new(vec![]);
    for credentials in [
        Credentials {
            keys: vec![application(ISSUER, (1, None))],
            ..Credentials::default()
        },
        Credentials {
            key_set: Some(key_set(&fixture)),
            ..Credentials::default()
        },
    ] {
        assert_eq!(
            configured(&fixture, &credentials)
                .expect_err("no audience")
                .message(),
            "a side given a JWT's keys or a key set is given its audience too"
        );
    }
    let credentials = Credentials {
        verify: Some(Arc::new(|_, _| Box::pin(async { Ok(None) }))),
        ..Credentials::default()
    };
    assert_eq!(
        configured(&fixture, &credentials)
            .expect("ELSEWHERE needs no audience")
            .schemes(),
        [CredentialScheme::ELSEWHERE]
    );
}

#[test]
fn refuses_limits_whose_chunk_or_envelope_is_under_1_024_bytes_and_takes_them_from_1_024() {
    assert_eq!(crate::credentials::JWT_LIMIT_BYTES, 1_024);
    for (chunk_bytes, maximum_envelope_bytes) in [(1_023, 4_096), (1_024, 1_023)] {
        let limits = RouterLimits {
            chunk_bytes,
            maximum_envelope_bytes,
            ..LIMIT_DEFAULTS
        };
        assert_eq!(
            assert_limits_hold_jwt(&limits)
                .expect_err("under 1024")
                .message(),
            "the router's limits do not hold together: a side that takes or presents a JWT holds a chunk's envelope and an envelope of 1,024 bytes at least"
        );
    }
    assert_limits_hold_jwt(&RouterLimits {
        chunk_bytes: 1_024,
        maximum_envelope_bytes: 1_024,
        ..LIMIT_DEFAULTS
    })
    .expect("1024 holds");
}

#[tokio::test]
async fn asks_the_elsewhere_verifier_once_with_exactly_what_its_transport_carried_and_the_calls_signal_and_never_for_one_that_carried_nothing()
 {
    let fixture = Fixture::new(vec![]);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = Arc::clone(&asked);
    let resolver = resolver(
        &Credentials {
            verify: Some(Arc::new(move |carried, signal| {
                locked(&asking).push((carried, signal));
                Box::pin(async {
                    Ok(Some(ElsewhereSession {
                        id: "ada".to_owned(),
                        data: Some(json!({"sub": "ada"})),
                        end: None,
                    }))
                })
            })),
            ..Credentials::default()
        },
        &fixture.clock,
    );
    let signal = CancellationToken::new();
    let request = |carried: Option<&str>| CredentialRequest {
        credential: Credential::Elsewhere,
        transport_credential: carried.map(str::to_owned),
        audiences: None,
    };
    let actual = resolver
        .resolve((request(Some(" \tInterop sub=ada")), signal.clone()))
        .await;
    assert!(
        matches!(actual, Ok(Resolved::Session(session)) if session == CallSession {
            data: Some(json!({"sub": "ada"})), end: None,
            identifier: Some(SessionIdentifier::Elsewhere { id: "ada".to_owned() }),
        })
    );
    assert!(matches!(
        resolver.resolve((request(None), signal.clone())).await,
        Ok(Resolved::None)
    ));
    assert_eq!(locked(&asked).len(), 1);
    assert_eq!(locked(&asked)[0].0, " \tInterop sub=ada");
    assert!(!locked(&asked)[0].1.is_cancelled());
    signal.cancel();
    assert!(locked(&asked)[0].1.is_cancelled());
}
