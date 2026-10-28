//! What the interop server resolves a request's credential with, as `spec/interop-service.json`
//! states it: its `JWT` keys, its audience, its key set, and its `ELSEWHERE` verifier. Every
//! implementation's interop server reads the same file.

use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicU64, Ordering};
use core::time::Duration;
use std::sync::Arc;

use bead::{
    BoxFuture, Credentials, ElsewhereSession, ElsewhereVerdict, ElsewhereVerifier, JWT_LIMIT_BYTES,
    JwtAlgorithm, JwtKey, JwtKeySet, JwtSetKey, KeySetAnswer, KeySetAsk, LIMIT_DEFAULTS,
    ProgrammerError, RouterLimitsOptions, Schedule, SharedClock,
};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

/// The interop service's behaviour, as every implementation's interop server reads it.
pub const INTEROP_SERVICE: &str = include_str!("../../../../../spec/interop-service.json");

// how long the key set takes to answer, on the server's clock, so a conversation sees each ask
const KEY_SET_MILLISECONDS: u64 = 1_000;

// the key set's issuers that answer otherwise than with their keys at every ask: one whose key is
// withdrawn after its first ask, and one whose ask never settles
const ROTATED_ISSUER: &str = "https://rotated.interop.bead.example";
const STALLED_ISSUER: &str = "https://stalled.interop.bead.example";

// the ELSEWHERE verifier's auth-scheme, compared without regard to case (RFC 9110 §11.1)
const ELSEWHERE_SCHEME: &str = "interop ";

// the bounds of its numbers: a delay a timer holds (spec 1.4), an instant every side holds (1.2)
const LONGEST_AFTER: u64 = 2_147_483_647;
const LATEST_END: u64 = 9_007_199_254_740_991;

fn service() -> Result<Value, ProgrammerError> {
    serde_json::from_str(INTEROP_SERVICE)
        .map_err(|error| ProgrammerError::new(format!("spec/interop-service.json: {error}")))
}

fn object_at<'value>(value: &'value Value, path: &[&str]) -> Option<&'value Map<String, Value>> {
    path.iter()
        .try_fold(value, |at, name| at.get(*name))
        .and_then(Value::as_object)
}

fn algorithm_of(key: &Map<String, Value>) -> Result<JwtAlgorithm, ProgrammerError> {
    key.get("algorithm")
        .and_then(Value::as_str)
        .and_then(JwtAlgorithm::named)
        .ok_or_else(|| ProgrammerError::new("an interop key names ES256 or HS256"))
}

fn jwk_of(key: &Map<String, Value>) -> Result<Map<String, Value>, ProgrammerError> {
    key.get("jwk")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| ProgrammerError::new("an interop key holds its JWK"))
}

// a value in a later turn, or once `milliseconds` passed on `clock`
fn after_on<T: Send + 'static>(
    clock: &SharedClock,
    (milliseconds, value): (Option<u64>, T),
) -> BoxFuture<T> {
    let Some(milliseconds) = milliseconds else {
        return Box::pin(async move {
            tokio::task::yield_now().await;

            value
        });
    };
    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);
    let timer = clock.arm(
        Schedule::Once(Duration::from_millis(milliseconds)),
        Box::new(move || {
            if let Some(woken) = woken.take() {
                woken.send(()).ok();
            }
        }),
    );

    Box::pin(async move {
        let _armed = timer;

        drop(wait.await);

        value
    })
}

// a run of digits, from 1 to 9 first, of at most `most` digits, and what follows it
fn digits_of(text: &str, most: usize) -> Option<(u64, &str)> {
    let end = text
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(text.len());
    let (digits, rest) = text.split_at(end);

    if digits.is_empty() || digits.len() > most || digits.starts_with('0') {
        return None;
    }

    digits.parse().ok().map(|number| (number, rest))
}

// an optional `, name=` number, and what follows it
fn parameter_of<'text>(
    text: &'text str,
    (name, most): (&str, usize),
) -> Option<(Option<u64>, &'text str)> {
    let prefix = format!(", {name}=");

    text.strip_prefix(prefix.as_str())
        .map_or(Some((None, text)), |rest| {
            digits_of(rest, most).map(|(number, rest)| (Some(number), rest))
        })
}

/// What a credential the interop verifier reads says: a holding one's sub, its delay and its end,
/// or a failing one's delay.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Words {
    Holding {
        sub: String,
        after: Option<u64>,
        end: Option<u64>,
    },
    Failing {
        after: Option<u64>,
    },
}

fn words_of(carried: &str) -> Option<Words> {
    let scheme = carried.get(..ELSEWHERE_SCHEME.len())?;

    if !scheme.eq_ignore_ascii_case(ELSEWHERE_SCHEME) {
        return None;
    }

    let words = carried.get(ELSEWHERE_SCHEME.len()..)?;

    if let Some(rest) = words.strip_prefix("fail=true") {
        let (after, rest) = parameter_of(rest, ("after", 10))?;

        return rest.is_empty().then_some(Words::Failing { after });
    }

    let rest = words.strip_prefix("sub=")?;
    let end = rest
        .bytes()
        .position(|byte| !byte.is_ascii_lowercase())
        .unwrap_or(rest.len());
    let (sub, rest) = rest.split_at(end);

    if sub.is_empty() || sub.len() > 32 {
        return None;
    }

    let (after, rest) = parameter_of(rest, ("after", 10))?;
    let (end, rest) = parameter_of(rest, ("end", 16))?;

    rest.is_empty().then(|| Words::Holding {
        sub: sub.to_owned(),
        after,
        end,
    })
}

/// The interop `ELSEWHERE` verifier, on `clock`: a credential `Interop sub=…`, its session; one
/// `Interop fail=true`, its failure; each after the delay it names.
#[must_use]
pub fn interop_verifier_of(clock: &SharedClock) -> ElsewhereVerifier {
    let clock = Arc::clone(clock);

    Arc::new(
        move |carried: String, _signal| -> BoxFuture<ElsewhereVerdict> {
            let words = words_of(&carried);
            let after = match &words {
                Some(Words::Holding { after, .. } | Words::Failing { after }) => *after,
                None => None,
            };
            let end = match &words {
                Some(Words::Holding { end, .. }) => *end,
                _ => None,
            };

            if after.unwrap_or(0) > LONGEST_AFTER || end.unwrap_or(0) > LATEST_END {
                return Box::pin(async { Ok(None) });
            }

            match words {
                None => Box::pin(async { Ok(None) }),
                Some(Words::Failing { after }) => {
                    let failed = after_on(&clock, (after, ()));

                    Box::pin(async move {
                        failed.await;

                        Err("this verifier fails, on purpose".into())
                    })
                }
                Some(Words::Holding { sub, after, end }) => {
                    let session = ElsewhereSession {
                        id: sub.clone(),
                        data: Some(serde_json::json!({ "sub": sub })),
                        end: end.and_then(|end| i64::try_from(end).ok()),
                    };
                    let held = after_on(&clock, (after, session));

                    Box::pin(async move { Ok(Some(held.await)) })
                }
            }
        },
    )
}

/// The interop credentials, on `clock`, under `limits`: none of a `JWT` under limits that hold
/// none.
///
/// # Errors
///
/// A [`ProgrammerError`] for a `spec/interop-service.json` that does not read.
#[expect(
    clippy::too_many_lines,
    reason = "the interop service's keys, key set and verifier, read from its file in one place"
)]
pub fn interop_credentials_of(
    clock: &SharedClock,
    limits: Option<&RouterLimitsOptions>,
) -> Result<Credentials, ProgrammerError> {
    let service = service()?;
    let jwt = object_at(&service, &["credentials", "jwt"]).ok_or_else(|| {
        ProgrammerError::new("spec/interop-service.json holds its JWT's credentials")
    })?;
    let chunk_bytes = limits
        .and_then(|limits| limits.chunk_bytes)
        .unwrap_or(LIMIT_DEFAULTS.chunk_bytes);
    let maximum_envelope_bytes = limits
        .and_then(|limits| limits.maximum_envelope_bytes)
        .unwrap_or(LIMIT_DEFAULTS.maximum_envelope_bytes);
    let mut credentials = Credentials::default();

    credentials.verify = Some(interop_verifier_of(clock));

    if chunk_bytes < JWT_LIMIT_BYTES || maximum_envelope_bytes < JWT_LIMIT_BYTES {
        return Ok(credentials);
    }

    let keys = jwt
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|key| {
            Ok(JwtKey {
                algorithm: algorithm_of(key)?,
                issuer: key
                    .get("issuer")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                jwk: jwk_of(key)?,
            })
        })
        .collect::<Result<Vec<_>, ProgrammerError>>()?;
    let key_set = jwt
        .get("keySet")
        .and_then(Value::as_object)
        .ok_or_else(|| ProgrammerError::new("spec/interop-service.json holds its key set"))?;
    let issuers: Vec<(String, Vec<JwtSetKey>)> = key_set
        .get("issuers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|answering| {
            let issuer = answering
                .get("issuer")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let keys = answering
                .get("keys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .map(|key| {
                    Ok(JwtSetKey {
                        algorithm: algorithm_of(key)?,
                        jwk: jwk_of(key)?,
                    })
                })
                .collect::<Result<Vec<_>, ProgrammerError>>()?;

            Ok((issuer, keys))
        })
        .collect::<Result<Vec<_>, ProgrammerError>>()?;
    let maximum_waiting_calls = key_set.get("maximumWaitingCalls").and_then(Value::as_u64);
    // the rotated issuer's asks, so far
    let rotated_asks = Arc::new(AtomicU64::new(0));
    let named = Arc::new(issuers.clone());
    let asking = Arc::clone(clock);
    let ask: KeySetAsk = Arc::new(move |issuer: String, _signal| -> BoxFuture<KeySetAnswer> {
        let Some((_, keys)) = named.iter().find(|(answering, _)| *answering == issuer) else {
            let refused: KeySetAnswer =
                Err(format!("the interop key set names no issuer {issuer}").into());

            return Box::pin(async move { refused });
        };

        if issuer == STALLED_ISSUER {
            let stalled: Pin<Box<dyn Future<Output = KeySetAnswer> + Send>> =
                Box::pin(core::future::pending());

            return stalled;
        }

        let is_withdrawn =
            issuer == ROTATED_ISSUER && rotated_asks.fetch_add(1, Ordering::AcqRel) >= 1;
        let answered = if is_withdrawn {
            Vec::new()
        } else {
            keys.clone()
        };
        let answering = after_on(&asking, (Some(KEY_SET_MILLISECONDS), answered));

        Box::pin(async move { Ok(answering.await) })
    });

    credentials.audience = jwt
        .get("audience")
        .and_then(Value::as_str)
        .map(str::to_owned);
    credentials.keys = keys;
    credentials.key_set = Some(JwtKeySet {
        ask,
        issuers: issuers.into_iter().map(|(issuer, _)| issuer).collect(),
        maximum_waiting_calls,
    });

    Ok(credentials)
}

#[cfg(test)]
mod tests {
    use super::{Words, words_of};

    #[test]
    fn reads_the_verifier_s_words_as_its_grammar_states_them() {
        assert_eq!(
            words_of("INTEROP sub=ada, after=5, end=17"),
            Some(Words::Holding {
                sub: "ada".to_owned(),
                after: Some(5),
                end: Some(17),
            })
        );
        assert_eq!(
            words_of("Interop fail=true"),
            Some(Words::Failing { after: None })
        );
        assert_eq!(words_of("Interop sub=Ada"), None);
        assert_eq!(words_of("Interop sub=ada, after=05"), None);
        assert_eq!(words_of("Bearer sub=ada"), None);
    }
}
