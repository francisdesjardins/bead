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

// ── A callback that panics: its throw (decision 0044) ─────────────────────────────────────────

const SET_ISSUER: &str = "https://set.example";
const AUDIENCE: &str = "https://bead.example";
const SET_KEY_BYTES: [u8; 32] = [9; 32];

// a resolver of `credentials` on a stepping clock
fn resolver_of(credentials: &Credentials) -> (Arc<SteppingClock>, super::CredentialResolver) {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let runtime = crate::platform::runtime_of(None, "a test's resolver").expect("a runtime");
    let resolver =
        super::CredentialResolver::new(credentials, (shared, runtime)).expect("a resolver");

    (clock, resolver)
}

fn elsewhere_of(carried: &str) -> super::CredentialRequest {
    super::CredentialRequest {
        audiences: None,
        credential: Credential::Elsewhere,
        transport_credential: Some(carried.to_owned()),
    }
}

// what a resolution failed with, by its words
fn failed_with(
    resolved: Result<crate::router::core::Resolved, crate::router::core::Unresolved>,
) -> String {
    match resolved {
        Err(crate::router::core::Unresolved::Other(error)) => error.to_string(),
        Err(crate::router::core::Unresolved::Capacity(error)) => format!("capacity: {error}"),
        Ok(resolved) => format!("resolved: {resolved:?}"),
    }
}

// spec 13.11; decision 0044: a verifier's panic as it is called is its throw at once, which fails
// its call as one whose future fails, and so is one its future panics with
#[tokio::test]
async fn fails_a_verifier_that_throws_at_once_as_one_that_rejects() {
    let (_clock, resolver) = resolver_of(&Credentials {
        verify: Some(Arc::new(|carried: String, _signal| {
            assert!(carried != "throws", "this verifier fails, on purpose");

            Box::pin(async move {
                assert!(carried != "panics", "this verifier fails, on purpose");

                Err::<Option<super::ElsewhereSession>, _>("this verifier fails, on purpose".into())
            })
        })),
        ..Credentials::default()
    });

    for (carried, said) in [
        (
            "throws",
            "a verifier panicked: this verifier fails, on purpose",
        ),
        (
            "panics",
            "a verifier panicked: this verifier fails, on purpose",
        ),
        ("rejects", "this verifier fails, on purpose"),
    ] {
        let settled = crate::testing::patience(
            core::time::Duration::from_secs(10),
            resolver.resolve((
                elsewhere_of(carried),
                tokio_util::sync::CancellationToken::new(),
            )),
        )
        .await
        .expect("resolved within its patience");

        assert_eq!(failed_with(settled), said, "{carried}: failed alike");
    }
}

// a token of SET_ISSUER's, for AUDIENCE, signed with SET_KEY_BYTES under `set-1`, its subject
// `grace`, its end an hour past the stepping clock's start
fn set_token() -> Bytes {
    use hmac::{Hmac, KeyInit, Mac};

    let part_of = |value: &Value| crate::base64url::encode(value.to_string().as_bytes());
    let now = crate::testing::instants::new_year()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs();
    let signed = format!(
        "{}.{}",
        part_of(&json!({ "alg": "HS256", "typ": "at+jwt", "kid": "set-1" })),
        part_of(&json!({
            "iss": SET_ISSUER,
            "aud": AUDIENCE,
            "sub": "grace",
            "exp": now.saturating_add(3_600),
        }))
    );
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&SET_KEY_BYTES).expect("a secret");

    mac.update(signed.as_bytes());

    let signature = crate::base64url::encode(&mac.finalize().into_bytes());

    Bytes::from(format!("{signed}.{signature}"))
}

fn set_key() -> JwtSetKey {
    let mut jwk = Map::new();

    jwk.insert("kty".to_owned(), Value::from("oct"));
    jwk.insert("kid".to_owned(), Value::from("set-1"));
    jwk.insert(
        "k".to_owned(),
        Value::from(crate::base64url::encode(&SET_KEY_BYTES)),
    );

    JwtSetKey {
        algorithm: JwtAlgorithm::Hs256,
        jwk,
    }
}

fn named() -> super::CredentialRequest {
    super::CredentialRequest {
        audiences: None,
        credential: Credential::Jwt(set_token()),
        transport_credential: None,
    }
}

type Asked = Arc<core::sync::atomic::AtomicUsize>;

// a key set whose first ask breaks as `breaks` says, and whose next answers its key
fn breaking(breaks: &'static str) -> (Asked, super::JwtKeySet) {
    let asked = Asked::default();
    let counting = Arc::clone(&asked);

    (
        asked,
        super::JwtKeySet {
            ask: Arc::new(move |_issuer: String, _signal| {
                let first = counting.fetch_add(1, core::sync::atomic::Ordering::SeqCst) == 0;

                assert!(
                    !(first && breaks == "as it is asked"),
                    "the key set cannot be reached"
                );

                Box::pin(async move {
                    assert!(
                        !(first && breaks == "as it is awaited"),
                        "the key set cannot be reached"
                    );

                    Ok(vec![set_key()])
                })
            }),
            issuers: vec![SET_ISSUER.to_owned()],
            maximum_waiting_calls: None,
        },
    )
}

// spec 13.9; decision 0044: a key set's panic, as it is asked or as its answer is awaited, is its
// throw: the call that waits on it fails at once, and the next within the minute waits for the
// deadline and the ask then
#[tokio::test]
async fn fails_a_call_alike_when_its_key_set_throws_as_it_is_asked_and_has_the_next_within_the_minute_wait_for_the_deadline_and_the_ask_then()
 {
    for breaks in ["as it is asked", "as it is awaited"] {
        let (asked, key_set) = breaking(breaks);
        let (clock, resolver) = resolver_of(&Credentials {
            audience: Some(AUDIENCE.to_owned()),
            key_set: Some(key_set),
            ..Credentials::default()
        });
        let resolving = crate::testing::spawn(
            resolver.resolve((named(), tokio_util::sync::CancellationToken::new())),
        );

        clock.settle().await;

        let refused = crate::testing::patience(core::time::Duration::from_secs(10), resolving)
            .await
            .expect("failed at once, not at its deadline")
            .expect("joined");

        assert_eq!(
            failed_with(refused),
            format!(
                "the key set's ask for {SET_ISSUER} failed: a key set's ask panicked: the key set cannot be reached"
            ),
            "{breaks}: failed with its throw"
        );

        // within the minute, the next waits for the deadline, asking nothing before it
        let next = crate::testing::spawn(
            resolver.resolve((named(), tokio_util::sync::CancellationToken::new())),
        );

        clock.settle().await;

        assert_eq!(
            clock.dues(),
            [core::time::Duration::from_secs(60)],
            "{breaks}: its deadline armed"
        );

        clock
            .advance(core::time::Duration::from_millis(59_999))
            .await;

        assert!(!next.is_finished(), "{breaks}: waiting");
        assert_eq!(
            asked.load(core::sync::atomic::Ordering::SeqCst),
            1,
            "{breaks}: asked once"
        );

        clock.advance(core::time::Duration::from_millis(1)).await;

        let held = crate::testing::patience(core::time::Duration::from_secs(10), next)
            .await
            .expect("resolved within its patience")
            .expect("joined");

        assert!(
            matches!(&held, Ok(crate::router::core::Resolved::Session(session))
            if session.identifier == Some(crate::router::types::SessionIdentifier::JwtSub {
                issuer: SET_ISSUER.to_owned(),
                sub: "grace".to_owned(),
            })),
            "{breaks}: the next held by the ask then: {held:?}"
        );
        assert_eq!(
            asked.load(core::sync::atomic::Ordering::SeqCst),
            2,
            "{breaks}: asked again at the deadline"
        );
    }
}
