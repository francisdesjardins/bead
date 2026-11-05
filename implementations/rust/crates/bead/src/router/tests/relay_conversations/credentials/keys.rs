//! Each source's issuer, key and claims, with answers held until the test releases them.

use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use hmac::{Hmac, KeyInit, Mac};
use serde_json::json;
use sha2::Sha256;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::locked;
use crate::credentials::{JwtKeySet, JwtSetKey, KeySetAnswer};
use crate::jwt_verifier::JwtAlgorithm;

type Answer = (CancellationToken, Option<oneshot::Sender<KeySetAnswer>>);

pub(super) struct Keys {
    pub(super) audience: &'static str,
    issuer: &'static str,
    kid: &'static str,
    subject: &'static str,
    secret: u8,
    now: i64,
    asks: Arc<Mutex<Vec<Answer>>>,
}

impl Keys {
    pub(super) fn new(dotnet: bool) -> Self {
        Self {
            audience: if dotnet {
                "bead-interop"
            } else {
                "https://bead.example"
            },
            issuer: if dotnet {
                "https://hs256.example"
            } else {
                "https://keys.example"
            },
            kid: if dotnet { "first" } else { "set-1" },
            subject: if dotnet { "ada" } else { "grace" },
            secret: if dotnet { 1 } else { 2 },
            now: if dotnet { 946_684_800 } else { 1_767_225_600 },
            asks: Arc::default(),
        }
    }

    pub(super) fn start(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_secs(
                u64::try_from(self.now).expect("a positive epoch"),
            ))
            .expect("the source clock's epoch fits")
    }

    pub(super) fn jwt(&self) -> String {
        let header = crate::base64url::encode(
            json!({"alg": "HS256", "typ": "at+jwt", "kid": self.kid})
                .to_string()
                .as_bytes(),
        );
        let claims = crate::base64url::encode(json!({"iss": self.issuer, "aud": self.audience, "sub": self.subject, "exp": self.now.saturating_add(3_600)}).to_string().as_bytes());
        let signing = format!("{header}.{claims}");
        let mut mac = Hmac::<Sha256>::new_from_slice(&[self.secret; 32]).expect("an HMAC key");
        mac.update(signing.as_bytes());
        format!(
            "{signing}.{}",
            crate::base64url::encode(&mac.finalize().into_bytes())
        )
    }

    pub(super) fn key_set(&self) -> JwtKeySet {
        let asks = Arc::clone(&self.asks);
        let expected = self.issuer;
        JwtKeySet {
            ask: Arc::new(move |issuer, signal| {
                assert_eq!(issuer, expected);
                let (reply, answer) = oneshot::channel();
                locked(&asks).push((signal, Some(reply)));
                Box::pin(async move { answer.await.expect("the test answers its ask") })
            }),
            issuers: vec![self.issuer.to_owned()],
            maximum_waiting_calls: Some(1),
        }
    }

    pub(super) fn asked(&self) -> usize {
        locked(&self.asks).len()
    }

    pub(super) fn release(&self, empty: bool) {
        let keys = if empty {
            Vec::new()
        } else {
            vec![JwtSetKey {
                algorithm: JwtAlgorithm::Hs256,
                jwk: json!({"kty": "oct", "k": crate::base64url::encode(&[self.secret; 32]), "kid": self.kid}).as_object().cloned().expect("a JWK"),
            }]
        };
        let (signal, reply) = locked(&self.asks)
            .iter_mut()
            .find_map(|(signal, reply)| reply.take().map(|reply| (signal.clone(), reply)))
            .expect("an ask waits for its answer");
        assert!(
            !signal.is_cancelled(),
            "ending a call leaves the shared issuer's ask alive"
        );
        reply.send(Ok(keys)).expect("the issuer still waits");
    }
}
