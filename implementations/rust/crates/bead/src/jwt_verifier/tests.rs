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
    let now = crate::testing::wall_now;
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

const HOLDING: &str = "sub alone, named by sub";

// the verdict vector that holds: its token, its keys, its audiences and its wall clock's reading
fn holding() -> (String, Vec<JwtKey>, Vec<String>, SystemTime) {
    let vectors: Vec<Value> = crate::testing::vectors::of("jwtVerdicts").expect("the vectors");
    let vector = vectors
        .into_iter()
        .find(|vector| vector.get("name") == Some(&Value::from(HOLDING)))
        .expect("the vector that holds");
    let text = |name: &str| {
        vector
            .get(name)
            .and_then(Value::as_str)
            .expect("a string")
            .to_owned()
    };
    let keys = vector
        .get("keys")
        .and_then(Value::as_array)
        .expect("its keys")
        .iter()
        .map(|key| JwtKey {
            algorithm: key
                .get("algorithm")
                .and_then(Value::as_str)
                .and_then(JwtAlgorithm::named)
                .expect("an algorithm"),
            issuer: key
                .get("issuer")
                .and_then(Value::as_str)
                .expect("an issuer")
                .to_owned(),
            jwk: key
                .get("jwk")
                .and_then(Value::as_object)
                .cloned()
                .expect("a jwk"),
        })
        .collect();
    let audiences = audiences_of(vector.get("audience"));
    let now = crate::testing::instants::instant_of(&text("now")).expect("an instant");

    (text("token"), keys, audiences, now)
}

#[test]
fn refuses_an_hs256_signature_of_the_wrong_byte_length_before_reading_the_clock() {
    let (token, keys, audiences, now) = holding();
    let reads = core::sync::atomic::AtomicUsize::new(0);
    let reading = || {
        reads.fetch_add(1, core::sync::atomic::Ordering::SeqCst);

        now
    };
    let against = JwtAgainst {
        audiences: &audiences,
        keys: &keys,
        now: &reading,
    };
    let (signed, signature) = token.rsplit_once('.').expect("three parts");
    let signature = base64url::decode(signature.as_bytes()).expect("a signature");

    assert_eq!(signature.len(), 32, "an HS256 signature");

    for length in [31_usize, 33] {
        let mut bytes = vec![0_u8; length];

        for (to, from) in bytes.iter_mut().zip(&signature) {
            *to = *from;
        }

        let malformed = format!("{signed}.{}", base64url::encode(&bytes));

        assert_eq!(
            verify_jwt(malformed.as_bytes(), &against).expect("judged"),
            JwtVerdict::Refused(JwtRefusal::Signature),
            "{length} bytes refused at signature"
        );
        assert_eq!(
            reads.load(core::sync::atomic::Ordering::SeqCst),
            0,
            "no clock read"
        );
    }

    assert!(
        matches!(
            verify_jwt(token.as_bytes(), &against).expect("judged"),
            JwtVerdict::Holds { .. }
        ),
        "its own holds"
    );
    assert_eq!(
        reads.load(core::sync::atomic::Ordering::SeqCst),
        1,
        "the clock read once"
    );
}

#[test]
fn reads_unverified_jwts_only_when_all_three_parts_decode() {
    let (token, ..) = holding();
    let mut parts = token.split('.');
    let (header, claims) = (
        parts.next().expect("a header"),
        parts.next().expect("claims"),
    );
    let encode = |text: &str| base64url::encode(text.as_bytes());

    for refused in [
        String::new(),
        "a.b".to_owned(),
        format!("{header}.{claims}.AA.extra"),
        format!("{}.{claims}.AA", encode("[]")),
        format!("{}.{claims}.AA", encode("no JSON")),
        format!("{header}.{}.AA", encode("[]")),
        format!("{header}.{}.AA", encode("no JSON")),
        format!("{header}.{claims}.*"),
    ] {
        assert!(
            read_jwt(refused.as_bytes()).is_none(),
            "{refused:?} not read"
        );
    }

    // * a one-byte signature is readable here: only the verifier judges its signature
    let (read_header, read_claims) =
        read_jwt(format!("{header}.{claims}.AA").as_bytes()).expect("read");
    let object = |part: &str| {
        serde_json::from_slice::<Value>(&base64url::decode(part.as_bytes()).expect("a part"))
            .expect("JSON")
    };

    assert_eq!(Value::Object(read_header), object(header), "its header");
    assert_eq!(Value::Object(read_claims), object(claims), "its claims");
}

#[test]
fn reads_the_wall_clock_once_the_signature_verifies_so_a_verification_that_waits_past_a_token_s_end_refuses_it_at_exp()
 {
    let (token, keys, audiences, _) = holding();
    let claims = read_jwt(token.as_bytes()).expect("read").1;
    let exp = claims.get("exp").and_then(Value::as_u64).expect("its exp");
    let reads = core::sync::atomic::AtomicUsize::new(0);
    // the reading taken as the signature verified stands for a wall clock that went past the
    // token's end meanwhile
    let reading = || {
        reads.fetch_add(1, core::sync::atomic::Ordering::SeqCst);

        // its end, exp plus 60 s, as its verdict gives it
        SystemTime::UNIX_EPOCH + core::time::Duration::from_secs(exp.saturating_add(60))
    };
    let against = JwtAgainst {
        audiences: &audiences,
        keys: &keys,
        now: &reading,
    };

    assert_eq!(
        (
            verify_jwt(token.as_bytes(), &against).expect("judged"),
            reads.load(core::sync::atomic::Ordering::SeqCst)
        ),
        (JwtVerdict::Refused(JwtRefusal::Exp), 1),
        "refused at exp, the clock read once"
    );

    // one refused before its signature verified reads none
    let (signed, _) = token.rsplit_once('.').expect("three parts");
    let forged = format!("{signed}.{}", "A".repeat(43));

    assert_eq!(
        (
            verify_jwt(forged.as_bytes(), &against).expect("judged"),
            reads.load(core::sync::atomic::Ordering::SeqCst)
        ),
        (JwtVerdict::Refused(JwtRefusal::Signature), 1),
        "refused at signature, no clock read"
    );
}
