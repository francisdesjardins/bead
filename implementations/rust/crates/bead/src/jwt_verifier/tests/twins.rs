//! JWT refusal scenarios both other sides hold beside the conformance vectors.

use serde_json::json;

use super::holding;
use crate::jwt_verifier::{JwtAgainst, JwtAlgorithm, JwtKey, JwtRefusal, JwtVerdict, verify_jwt};
use crate::testing::surface::Consumer;

#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
fn throws_for_a_key_not_shaped_for_its_algorithm_whatever_the_token_name() {
    let (_, keys, audiences, now) = holding();
    let bytes_32 = "A".repeat(43);
    let bytes_31 = "A".repeat(42);
    let cases = [
        (
            "an ES256 key whose kty is oct",
            JwtAlgorithm::Es256,
            json!({"k": bytes_32, "kty": "oct"}),
        ),
        (
            "an ES256 key on P-384",
            JwtAlgorithm::Es256,
            json!({"crv": "P-384", "kty": "EC", "x": bytes_32, "y": bytes_32}),
        ),
        (
            "an ES256 key whose x is 31 bytes",
            JwtAlgorithm::Es256,
            json!({"crv": "P-256", "kty": "EC", "x": bytes_31, "y": bytes_32}),
        ),
        (
            "an ES256 key whose y is no base64url",
            JwtAlgorithm::Es256,
            json!({"crv": "P-256", "kty": "EC", "x": bytes_32, "y": "y="}),
        ),
        (
            "an HS256 key whose kty is EC",
            JwtAlgorithm::Hs256,
            json!({"crv": "P-256", "kty": "EC", "x": bytes_32, "y": bytes_32}),
        ),
        (
            "an HS256 key of 31 bytes",
            JwtAlgorithm::Hs256,
            json!({"k": bytes_31, "kty": "oct"}),
        ),
        (
            "an HS256 key with no k",
            JwtAlgorithm::Hs256,
            json!({"kty": "oct"}),
        ),
        (
            "a key whose kid is a number",
            JwtAlgorithm::Hs256,
            json!({"k": bytes_32, "kid": 7, "kty": "oct"}),
        ),
    ];
    for (name, algorithm, jwk) in cases {
        let mut keys = keys.clone();
        keys.push(JwtKey {
            algorithm,
            issuer: "https://issuer.example".to_owned(),
            jwk: jwk.as_object().expect("a JWK").clone(),
        });
        let refused = verify_jwt(
            b"",
            &JwtAgainst {
                audiences: &audiences,
                keys: &keys,
                now: &|| now,
            },
        );
        assert!(
            refused.is_err(),
            "{name}: a misuse is refused before the token"
        );
    }
    assert_eq!(JwtAlgorithm::named("RS256"), None);
    let consumer = Consumer::new();
    consumer.accepts(
        "pub fn check(mut key: bead::JwtKey) { key.algorithm = bead::JwtAlgorithm::Hs256; }",
    );
    consumer.refuses(
        "pub fn check(mut key: bead::JwtKey) { key.algorithm = bead::JwtAlgorithm::Rs256; }",
        ("E0599", "Rs256"),
    );
    consumer.refuses(
        "pub fn check(mut key: bead::JwtKey) { key.jwk = Vec::new(); }",
        ("E0308", "mismatched types"),
    );
}

#[test]
fn refuses_at_crit_a_token_whose_header_names_crit_with_an_escape_whatever_a_token_of_its_shape_held_before()
 {
    let (token, keys, audiences, now) = holding();
    let (_, rest) = token.split_once('.').expect("a header and two parts");
    let mut random = [0; 8];
    getrandom::fill(&mut random).expect("a name drawn for this run");
    let first = format!("onTheLedge{}", crate::base64url::encode(&random));
    let headed = |header: &str| format!("{}.{rest}", crate::base64url::encode(header.as_bytes()));
    let against = JwtAgainst {
        audiences: &audiences,
        keys: &keys,
        now: &|| now,
    };
    let priming = format!(r#"{{"{first}":0,"alg":"HS256","typ":"at+jwt","\\u00":1}}"#);
    verify_jwt(headed(&priming).as_bytes(), &against).expect("the priming header reads");
    let escaped = format!(r#"{{"{first}":0,"alg":"HS256","typ":"at+jwt","\u0063rit":["exp"]}}"#);
    assert_eq!(
        verify_jwt(headed(&escaped).as_bytes(), &against).expect("judged"),
        JwtVerdict::Refused(JwtRefusal::Crit)
    );
}
