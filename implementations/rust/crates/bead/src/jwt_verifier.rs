//! A `JWT`'s verification (spec 13.8): an access token of RFC 9068's profile in JWS Compact
//! Serialization (RFC 7515), verified step by step, the first that fails naming the verdict's
//! reason; ES256 by `p256` and HS256 by `hmac`, pure Rust (decision 0044).

use core::fmt;
use core::time::Duration;
use std::time::SystemTime;

use hmac::{Hmac, KeyInit, Mac};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Map, Value};
use sha2::Sha256;

use crate::base64url;
use crate::errors::ProgrammerError;
use crate::json::{self, LoneSurrogates, ReadJsonOptions};

#[cfg(test)]
mod tests;

/// The algorithms a `JWT`'s key verifies with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum JwtAlgorithm {
    /// ES256 (RFC 7518 §3.4), for keys the services that trust one issuer share by their public
    /// half.
    Es256,
    /// HS256 (RFC 7518 §3.2), for one trust domain.
    Hs256,
}

impl JwtAlgorithm {
    /// The algorithm as a token's `alg` names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Es256 => "ES256",
            Self::Hs256 => "HS256",
        }
    }

    /// The algorithm `name` names.
    #[must_use]
    pub fn named(name: &str) -> Option<Self> {
        match name {
            "ES256" => Some(Self::Es256),
            "HS256" => Some(Self::Hs256),
            _ => None,
        }
    }
}

/// A key a `JWT` is verified with: a JWK (RFC 7517), its issuer, and its one algorithm.
#[derive(Clone, PartialEq, Eq)]
pub struct JwtKey {
    /// Its one algorithm, which the application names (RFC 8725 §3.1).
    pub algorithm: JwtAlgorithm,
    /// The issuer whose tokens it signs.
    pub issuer: String,
    /// Its JWK, as a key set writes it.
    pub jwk: Map<String, Value>,
}

impl fmt::Debug for JwtKey {
    // ! its issuer and its algorithm alone: an HS256 key's secret is written in no string
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JwtKey")
            .field("issuer", &self.issuer)
            .field("algorithm", &self.algorithm)
            .finish_non_exhaustive()
    }
}

/// Why a `JWT` does not hold: the step of section 13.8 that refused it, in their order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum JwtRefusal {
    /// It does not read.
    Token,
    /// It names a header parameter it requires its receiver to understand.
    Crit,
    /// It is not typed an access token.
    Typ,
    /// No one key of the keys is the one it names.
    Kid,
    /// Its `alg` is not its key's.
    Alg,
    /// Its key does not serve to verify.
    Key,
    /// Its signature does not verify.
    Signature,
    /// Its `iss` is not its key's issuer.
    Iss,
    /// Its `exp` passed, or is no `NumericDate`.
    Exp,
    /// Its `nbf` has not come, or is no `NumericDate`.
    Nbf,
    /// Its `aud` names no audience of the receiver's.
    Aud,
    /// Its `sid` is no string.
    Sid,
    /// It names neither a `sid` nor a `sub`.
    Sub,
}

impl JwtRefusal {
    /// The reason as the verdict vectors name it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Crit => "crit",
            Self::Typ => "typ",
            Self::Kid => "kid",
            Self::Alg => "alg",
            Self::Key => "key",
            Self::Signature => "signature",
            Self::Iss => "iss",
            Self::Exp => "exp",
            Self::Nbf => "nbf",
            Self::Aud => "aud",
            Self::Sid => "sid",
            Self::Sub => "sub",
        }
    }
}

impl fmt::Display for JwtRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A `JWT`'s session's identifier: its issuer with its `sid`, else with its `sub`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum JwtSessionIdentifier {
    /// Its issuer and its `sid`.
    Sid {
        /// Its issuer.
        issuer: String,
        /// Its `sid`.
        sid: String,
    },
    /// Its issuer and its `sub`.
    Sub {
        /// Its issuer.
        issuer: String,
        /// Its `sub`.
        sub: String,
    },
}

/// A `JWT`'s verdict: it holds, or it does not, with the step of section 13.8 that refused it.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum JwtVerdict {
    /// It holds: its session's identifier, its claims set and its end.
    Holds {
        /// Its claims set.
        claims: Map<String, Value>,
        /// Its end, _E_, in milliseconds since the epoch.
        end: i64,
        /// Its session's identifier.
        identifier: JwtSessionIdentifier,
    },
    /// It does not hold.
    Refused(JwtRefusal),
}

/// The leeway for clock skew on `exp` and `nbf`: a constant on every side, never an option.
pub const JWT_LEEWAY: Duration = Duration::from_secs(60);

const LEEWAY_MILLISECONDS: i64 = 60_000;

// the largest integer every side holds exactly
const LARGEST_SAFE: i64 = 9_007_199_254_740_991;

/// What [`verify_jwt`] holds a token to.
pub struct JwtAgainst<'keys> {
    /// The receiver's audiences, any of which a token's `aud` may name: one, or a relay's set.
    pub audiences: &'keys [String],
    /// The keys.
    pub keys: &'keys [JwtKey],
    /// What reads the wall clock, _W_, once the token's signature verified.
    pub now: &'keys (dyn Fn() -> SystemTime + Send + Sync),
}

impl fmt::Debug for JwtAgainst<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JwtAgainst")
            .field("audiences", &self.audiences)
            .field("keys", &self.keys.len())
            .finish_non_exhaustive()
    }
}

fn string_of<'object>(object: &'object Map<String, Value>, name: &str) -> Option<&'object str> {
    match object.get(name) {
        Some(Value::String(text)) => Some(text),
        Some(_) | None => None,
    }
}

// a header or a claims set: a JSON object in UTF-8 that names each member once, a string holding a
// surrogate alone read as a value that names nothing
fn object_of(part: &[u8]) -> Option<Map<String, Value>> {
    let bytes = base64url::decode(part)?;
    let options = ReadJsonOptions {
        lone_surrogates: Some(LoneSurrogates::AsNull),
    };

    match json::read_with(&bytes, &options) {
        Ok(Value::Object(members)) => Some(members),
        Ok(_) | Err(_) => None,
    }
}

/// Refuses a key not shaped for its algorithm, the application's fault, never the token's.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the key's issuer.
pub fn assert_jwt_key(key: &JwtKey) -> Result<(), ProgrammerError> {
    let fault = |what: &str| {
        ProgrammerError::new(format!(
            "a JWT's key {what}, for the issuer {:?}",
            key.issuer
        ))
    };

    if key.jwk.get("kid").is_some_and(|kid| !kid.is_string()) {
        return Err(fault("names its kid by a string"));
    }

    let bytes_of = |name: &str| {
        string_of(&key.jwk, name)
            .and_then(|text| base64url::decode(text.as_bytes()))
            .map(|bytes| bytes.len())
    };

    match key.algorithm {
        JwtAlgorithm::Es256 => {
            if string_of(&key.jwk, "kty") != Some("EC")
                || string_of(&key.jwk, "crv") != Some("P-256")
                || bytes_of("x") != Some(32)
                || bytes_of("y") != Some(32)
            {
                return Err(fault(
                    "of ES256 is EC on P-256, its x and y of 32 bytes each",
                ));
            }
        }
        JwtAlgorithm::Hs256 => {
            if string_of(&key.jwk, "kty") != Some("oct")
                || bytes_of("k").is_none_or(|bytes| bytes < 32)
            {
                return Err(fault(
                    "of HS256 is oct, its k of 32 bytes at least (RFC 7518 §3.2)",
                ));
            }
        }
    }

    Ok(())
}

// the members RFC 7638 §3.2 hashes into a key's thumbprint, by its kty
fn thumbprint_members(kty: Option<&str>) -> Option<&'static [&'static str]> {
    match kty {
        Some("EC") => Some(&["crv", "kty", "x", "y"]),
        Some("oct") => Some(&["k", "kty"]),
        Some(_) | None => None,
    }
}

// whether two keys are one key: of one issuer, and of one material
fn is_one_material(key: &JwtKey, other: &JwtKey) -> bool {
    key.issuer == other.issuer
        && thumbprint_members(string_of(&key.jwk, "kty")).is_some_and(|members| {
            members
                .iter()
                .all(|name| string_of(&key.jwk, name) == string_of(&other.jwk, name))
        })
}

// the first key of each material alone, in their order
fn first_of_each_material<'keys>(keys: &[&'keys JwtKey]) -> Vec<&'keys JwtKey> {
    let mut first: Vec<&JwtKey> = Vec::new();

    for &key in keys {
        if !first.iter().any(|kept| is_one_material(kept, key)) {
            first.push(key);
        }
    }

    first
}

// the key the token names among `keys` alone: by its `kid`, the one key of that `kid`, or of
// several the one of its `iss`; without a `kid`, its `iss`'s one key
fn key_of<'keys>(
    header: &Map<String, Value>,
    (claims, keys): (&Map<String, Value>, &'keys [JwtKey]),
) -> Option<&'keys JwtKey> {
    let issuer = string_of(claims, "iss");
    let of_issuer = |key: &&JwtKey| Some(key.issuer.as_str()) == issuer;

    let found = if header.contains_key("kid") {
        let kid = string_of(header, "kid");
        let named: Vec<&JwtKey> = keys
            .iter()
            .filter(|key| kid.is_some() && string_of(&key.jwk, "kid") == kid)
            .collect();

        if named.len() > 1 {
            let of_it: Vec<&JwtKey> = named.into_iter().filter(of_issuer).collect();

            first_of_each_material(&of_it)
        } else {
            named
        }
    } else {
        let of_it: Vec<&JwtKey> = keys.iter().filter(of_issuer).collect();

        first_of_each_material(&of_it)
    };

    match found.as_slice() {
        [key] => Some(key),
        _ => None,
    }
}

// whether a key's JWK serves to verify: its `alg`, `use` and `key_ops`, each when present
fn serves(key: &JwtKey) -> bool {
    let jwk = &key.jwk;

    (!jwk.contains_key("alg") || string_of(jwk, "alg") == Some(key.algorithm.as_str()))
        && (!jwk.contains_key("use") || string_of(jwk, "use") == Some("sig"))
        && match jwk.get("key_ops") {
            None => true,
            Some(Value::Array(operations)) => operations
                .iter()
                .any(|operation| operation.as_str() == Some("verify")),
            Some(_) => false,
        }
}

// * ES256's signature is R then S, 64 bytes (RFC 7518 §3.4): never DER
fn verifies(key: &JwtKey, (signature, signing_input): (&[u8], &[u8])) -> bool {
    let decoded = |name: &str| {
        string_of(&key.jwk, name)
            .and_then(|text| base64url::decode(text.as_bytes()))
            .unwrap_or_default()
    };

    match key.algorithm {
        JwtAlgorithm::Es256 => {
            if signature.len() != 64 {
                return false;
            }

            let mut point = vec![0x04];

            point.extend(decoded("x"));
            point.extend(decoded("y"));

            let (Ok(verifying), Ok(signature)) = (
                VerifyingKey::from_sec1_bytes(&point),
                Signature::from_slice(signature),
            ) else {
                return false;
            };

            verifying.verify(signing_input, &signature).is_ok()
        }
        JwtAlgorithm::Hs256 => {
            if signature.len() != 32 {
                return false;
            }

            let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&decoded("k")) else {
                return false;
            };

            mac.update(signing_input);
            mac.verify_slice(signature).is_ok()
        }
    }
}

// a NumericDate's milliseconds, rounded up, when it is a JSON number every side holds exactly
fn milliseconds_of(value: Option<&Value>) -> Option<i64> {
    let seconds = value?.as_f64()?;

    json::integer_of((seconds * 1000.0).ceil())
}

/// The audiences a token's `aud` names (RFC 7519 §4.1.3): itself, a string; each of an array of
/// strings; none for anything else.
#[must_use]
pub fn audiences_of(aud: Option<&Value>) -> Vec<String> {
    match aud {
        Some(Value::String(audience)) => vec![audience.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()
            .unwrap_or_default(),
        Some(_) | None => Vec::new(),
    }
}

// steps 8 to 13 of section 13.8, on a token whose signature verified under `key`
fn verdict_of(
    claims: Map<String, Value>,
    (audiences, key, now): (&[String], &JwtKey, i64),
) -> JwtVerdict {
    if string_of(&claims, "iss") != Some(key.issuer.as_str()) {
        return JwtVerdict::Refused(JwtRefusal::Iss);
    }

    let Some(expiry) = milliseconds_of(claims.get("exp"))
        .filter(|&expiry| expiry <= LARGEST_SAFE.saturating_sub(LEEWAY_MILLISECONDS))
    else {
        return JwtVerdict::Refused(JwtRefusal::Exp);
    };
    let end = expiry.saturating_add(LEEWAY_MILLISECONDS);

    if now >= end {
        return JwtVerdict::Refused(JwtRefusal::Exp);
    }

    if claims.contains_key("nbf") {
        let held = milliseconds_of(claims.get("nbf"));

        if held.is_none_or(|start| now.saturating_add(LEEWAY_MILLISECONDS) < start) {
            return JwtVerdict::Refused(JwtRefusal::Nbf);
        }
    }

    if !audiences_of(claims.get("aud"))
        .iter()
        .any(|named| audiences.contains(named))
    {
        return JwtVerdict::Refused(JwtRefusal::Aud);
    }

    let sid = string_of(&claims, "sid").map(str::to_owned);
    let sub = string_of(&claims, "sub").map(str::to_owned);

    if claims.contains_key("sid") && sid.is_none() {
        return JwtVerdict::Refused(JwtRefusal::Sid);
    }

    let identifier = match (sid, sub) {
        (Some(sid), _) => JwtSessionIdentifier::Sid {
            issuer: key.issuer.clone(),
            sid,
        },
        (None, Some(sub)) => JwtSessionIdentifier::Sub {
            issuer: key.issuer.clone(),
            sub,
        },
        (None, None) => return JwtVerdict::Refused(JwtRefusal::Sub),
    };

    JwtVerdict::Holds {
        claims,
        end,
        identifier,
    }
}

/// A token's parts, split at its dots: its header, its claims set and its signature, each as it
/// came; none for a token of another count of parts.
fn parts_of(token: &[u8]) -> Option<[&[u8]; 3]> {
    let mut parts = token.split(|&byte| byte == b'.');
    let header = parts.next()?;
    let claims = parts.next()?;
    let signature = parts.next()?;

    parts
        .next()
        .is_none()
        .then_some([header, claims, signature])
}

/// A token's header and claims set as step 1 of section 13.8 reads them, verifying nothing.
///
/// What a relay that does not verify reads its `aud` from, and a key set's ask its `kid` and its
/// `iss`; none for a token that does not read.
#[must_use]
pub fn read_jwt(token: &[u8]) -> Option<(Map<String, Value>, Map<String, Value>)> {
    let [header, claims, signature] = parts_of(token)?;
    let header = object_of(header)?;
    let claims = object_of(claims)?;

    base64url::decode(signature)?;

    Some((header, claims))
}

// milliseconds since the epoch of a wall clock's reading
fn milliseconds_since_epoch(at: SystemTime) -> i64 {
    match at.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
        Err(before) => {
            i64::try_from(before.duration().as_millis()).map_or(i64::MIN, i64::saturating_neg)
        }
    }
}

/// The verdict on `token`, a `JWT`, verified as section 13.8 states, step by step.
///
/// The first step that fails names the verdict's reason. The wall clock is read once, as its
/// signature has verified.
///
/// # Errors
///
/// A [`ProgrammerError`] for a key not shaped for its algorithm.
pub fn verify_jwt(token: &[u8], against: &JwtAgainst<'_>) -> Result<JwtVerdict, ProgrammerError> {
    for key in against.keys {
        assert_jwt_key(key)?;
    }

    let Some([encoded_header, encoded_claims, encoded_signature]) = parts_of(token) else {
        return Ok(JwtVerdict::Refused(JwtRefusal::Token));
    };
    let (Some(header), Some(claims), Some(signature)) = (
        object_of(encoded_header),
        object_of(encoded_claims),
        base64url::decode(encoded_signature),
    ) else {
        return Ok(JwtVerdict::Refused(JwtRefusal::Token));
    };

    // ! jwk, jku, x5u and x5c are never read: a token names no key of its own
    if header.contains_key("crit") {
        return Ok(JwtVerdict::Refused(JwtRefusal::Crit));
    }

    if !matches!(
        string_of(&header, "typ"),
        Some("at+jwt" | "application/at+jwt")
    ) {
        return Ok(JwtVerdict::Refused(JwtRefusal::Typ));
    }

    let Some(key) = key_of(&header, (&claims, against.keys)) else {
        return Ok(JwtVerdict::Refused(JwtRefusal::Kid));
    };

    if string_of(&header, "alg") != Some(key.algorithm.as_str()) {
        return Ok(JwtVerdict::Refused(JwtRefusal::Alg));
    }

    if !serves(key) {
        return Ok(JwtVerdict::Refused(JwtRefusal::Key));
    }

    let signed = token
        .get(
            ..encoded_header
                .len()
                .saturating_add(1)
                .saturating_add(encoded_claims.len()),
        )
        .unwrap_or_default();

    if !verifies(key, (&signature, signed)) {
        return Ok(JwtVerdict::Refused(JwtRefusal::Signature));
    }

    // * W read once, as the signature has verified
    let now = milliseconds_since_epoch((against.now)());

    Ok(verdict_of(claims, (against.audiences, key, now)))
}
