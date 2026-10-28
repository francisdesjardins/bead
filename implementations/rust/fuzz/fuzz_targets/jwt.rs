//! `jwt`: raw bytes as a `JWT`'s token, verified as spec 13.8 states it, then read unverified, as
//! a relay that does not verify reads it. A token of three parts is verified again with its first
//! two signed by the HS256 key below, so a claims set the fuzzer changes reaches the steps past the
//! signature. The keys, the audiences and the clock are the JWT verdicts' of `spec/vectors.json`,
//! as the other sides' twins take them: every answer is a verdict, and a panic is a finding.

#![no_main]

use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use bead::{JwtAgainst, JwtAlgorithm, JwtKey, read_jwt, verify_jwt};
use hmac::{Hmac, KeyInit, Mac};
use libfuzzer_sys::fuzz_target;
use serde_json::{Map, Value};
use sha2::Sha256;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// the wall clock, 2026-10-03T12:01:00.000Z
fn now() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(1_791_028_860_000)
}

fn encoded(bytes: &[u8]) -> String {
    let mut text = String::new();

    for group in bytes.chunks(3) {
        let word = group.iter().enumerate().fold(0_u32, |word, (index, byte)| {
            word | (u32::from(*byte) << (16 - 8 * index))
        });
        let characters = group.len() + 1;

        for index in 0..characters {
            let value = (word >> (18 - 6 * index)) & 0x3f;

            text.push(char::from(ALPHABET[value as usize]));
        }
    }

    text
}

fn decoded(text: &str) -> Vec<u8> {
    let values: Vec<u32> = text
        .bytes()
        .filter_map(|byte| ALPHABET.iter().position(|&each| each == byte))
        .map(|value| value as u32)
        .collect();
    let mut bytes = Vec::new();

    for group in values.chunks(4) {
        let word = group
            .iter()
            .enumerate()
            .fold(0_u32, |word, (index, value)| {
                word | (value << (18 - 6 * index))
            });

        for index in 0..group.len().saturating_sub(1) {
            bytes.push((word >> (16 - 8 * index)) as u8);
        }
    }

    bytes
}

/// What every input is held to: the keys, the audiences, the clock, and the HS256 key's secret.
struct Held {
    keys: Vec<JwtKey>,
    secret: Vec<u8>,
}

fn key_of(key: &Value, jwk: Map<String, Value>) -> JwtKey {
    JwtKey {
        algorithm: match key.get("algorithm").and_then(Value::as_str) {
            Some("ES256") => JwtAlgorithm::Es256,
            _ => JwtAlgorithm::Hs256,
        },
        issuer: key
            .get("issuer")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        jwk,
    }
}

// the first key of an issuer under an algorithm and no kid, as the verdicts write it
fn vector_key_of<'keys>(keys: &'keys [Value], (issuer, algorithm): (&str, &str)) -> &'keys Value {
    keys.iter()
        .find(|key| {
            key.get("issuer").and_then(Value::as_str) == Some(issuer)
                && key.get("algorithm").and_then(Value::as_str) == Some(algorithm)
                && key.get("jwk").and_then(|jwk| jwk.get("kid")).is_none()
        })
        .unwrap_or_else(|| panic!("spec/vectors.json holds no {algorithm} key of {issuer}"))
}

fn held() -> &'static Held {
    static HELD: OnceLock<Held> = OnceLock::new();

    HELD.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../spec/vectors.json");
        let vectors: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("spec/vectors.json read"))
                .expect("spec/vectors.json parsed");
        let keys: Vec<Value> = vectors
            .get("jwtVerdicts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|verdict| {
                verdict
                    .get("keys")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();
        let es256 = vector_key_of(&keys, ("https://issuer.example", "ES256"));
        let hs256 = vector_key_of(&keys, ("https://trust.example", "HS256"));
        let jwk_of = |key: &Value| {
            key.get("jwk")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        let mut kid = jwk_of(hs256);

        kid.insert("kid".to_owned(), Value::from("k1"));

        let secret = decoded(
            jwk_of(hs256)
                .get("k")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );

        Held {
            keys: vec![
                key_of(es256, jwk_of(es256)),
                key_of(hs256, jwk_of(hs256)),
                key_of(hs256, kid),
            ],
            secret,
        }
    })
}

// the parts' first two signed by the HS256 key, as an issuer of the trust domain signs them
fn signed_again(token: &[u8], secret: &[u8]) -> Option<Vec<u8>> {
    let parts: Vec<&[u8]> = token.split(|&byte| byte == b'.').collect();
    let [header, claims, _] = parts.as_slice() else {
        return None;
    };
    let input = [*header, b".", *claims].concat();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;

    mac.update(&input);

    Some(
        [
            input,
            b".".to_vec(),
            encoded(&mac.finalize().into_bytes()).into_bytes(),
        ]
        .concat(),
    )
}

fuzz_target!(|data: &[u8]| {
    let held = held();
    let audiences = [
        "https://bead.example".to_owned(),
        "https://other.example".to_owned(),
    ];
    let against = JwtAgainst {
        audiences: &audiences,
        keys: &held.keys,
        now: &now,
    };

    assert!(
        verify_jwt(data, &against).is_ok(),
        "every key well formed: each answer a verdict"
    );
    drop(read_jwt(data));

    if let Some(signed) = signed_again(data, &held.secret) {
        assert!(
            verify_jwt(&signed, &against).is_ok(),
            "every key well formed: each answer a verdict"
        );
    }
});
