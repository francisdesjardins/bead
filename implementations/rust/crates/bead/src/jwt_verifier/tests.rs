//! A `JWT`'s verification (spec 13.8): its algorithms by name, a key shaped for its own, a token
//! read without verifying, its audiences, and a token that is no token refused first.

use std::time::SystemTime;

use serde_json::{Value, json};

use super::{
    JwtAgainst, JwtAlgorithm, JwtKey, JwtRefusal, JwtVerdict, assert_jwt_key, audiences_of,
    read_jwt, verify_jwt,
};
use crate::base64url;

fn part_of(value: &Value) -> String {
    base64url::encode(value.to_string().as_bytes())
}

fn key_of(jwk: &Value) -> JwtKey {
    JwtKey {
        algorithm: JwtAlgorithm::Hs256,
        issuer: "https://issuer.example".to_owned(),
        jwk: jwk.as_object().cloned().unwrap_or_default(),
    }
}

#[test]
fn names_its_two_algorithms_and_no_other() {
    assert_eq!(
        JwtAlgorithm::named("ES256"),
        Some(JwtAlgorithm::Es256),
        "ES256"
    );
    assert_eq!(
        JwtAlgorithm::named("HS256"),
        Some(JwtAlgorithm::Hs256),
        "HS256"
    );
    assert_eq!(JwtAlgorithm::named("none"), None, "none is none");
    assert_eq!(JwtAlgorithm::named("hs256"), None, "its name exactly");
    assert_eq!(JwtAlgorithm::Es256.as_str(), "ES256", "named back");
}

#[test]
fn refuses_a_key_not_shaped_for_its_algorithm_naming_its_issuer() {
    assert!(
        assert_jwt_key(&key_of(
            &json!({ "kty": "oct", "k": base64url::encode(&[7; 32]) })
        ))
        .is_ok(),
        "a secret of 32 bytes"
    );

    let refused =
        assert_jwt_key(&key_of(&json!({ "kty": "EC" }))).expect_err("an EC key for HS256");

    assert!(
        refused.message().contains("https://issuer.example"),
        "names its issuer: {}",
        refused.message()
    );
}

#[test]
fn reads_a_token_s_header_and_claims_verifying_nothing_and_none_of_what_is_no_token() {
    let token = format!(
        "{}.{}.{}",
        part_of(&json!({ "alg": "HS256", "kid": "k1" })),
        part_of(&json!({ "iss": "https://issuer.example", "aud": ["a", "b"] })),
        base64url::encode(b"signature")
    );
    let (header, claims) = read_jwt(token.as_bytes()).expect("a token read");

    assert_eq!(header.get("kid"), Some(&Value::from("k1")), "its header");
    assert_eq!(audiences_of(claims.get("aud")), ["a", "b"], "its audiences");
    assert_eq!(audiences_of(Some(&Value::from("a"))), ["a"], "one audience");
    assert!(audiences_of(None).is_empty(), "none");

    for refused in ["", "a.b", "a.b.c.d", "!.!.!"] {
        assert!(
            read_jwt(refused.as_bytes()).is_none(),
            "{refused:?} no token"
        );
    }
}

#[test]
fn refuses_what_is_no_token_before_any_key_is_tried() {
    let now = SystemTime::now;
    let against = JwtAgainst {
        audiences: &[],
        keys: &[],
        now: &now,
    };

    assert_eq!(
        verify_jwt(b"not a token", &against).expect("judged"),
        JwtVerdict::Refused(JwtRefusal::Token),
        "refused as no token"
    );
    assert_eq!(
        JwtRefusal::Signature.to_string(),
        "signature",
        "a reason by its name"
    );
}
