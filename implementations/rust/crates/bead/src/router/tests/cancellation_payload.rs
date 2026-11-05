//! A verifier that keeps working holds no cancelled request's payload.

use core::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::constants::{CredentialScheme, RouterSide};
use crate::envelope::{Credential, Envelope};
use crate::router::core::{self as router_core, Resolution, Resolved};
use crate::router::types::RouterLimitsOptions;
use crate::testing::core_port::Peer;
use crate::testing::pair::echo;

use super::router_core_sessions::{handler, request};

struct Payload {
    bytes: Vec<u8>,
    dropped: Arc<AtomicBool>,
}

impl AsRef<[u8]> for Payload {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for Payload {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn lets_go_of_a_cancelled_calls_payload_while_its_verifier_keeps_working() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let dropped = Arc::new(AtomicBool::new(false));
    let released = CancellationToken::new();
    let started = CancellationToken::new();
    let ended = CancellationToken::new();
    let (release, start, end) = (released.clone(), started.clone(), ended.clone());
    let payload = Bytes::from_owner(Payload {
        bytes: vec![0; 1_024],
        dropped: Arc::clone(&dropped),
    });

    peer.owner
        .run(move |state| {
            state.schemes = vec![CredentialScheme::JWT];
            state.session = Some(Box::new(move |_request, _signal| {
                let (release, start, end) = (release.clone(), start.clone(), end.clone());
                let verifier = crate::testing::spawn(async move {
                    start.cancel();
                    release.cancelled().await;
                    end.cancel();
                    Ok(Resolved::None)
                });
                Resolution::Later(Box::pin(async move {
                    verifier.await.expect("the verifier settles")
                }))
            }));
            state.reader = Some(Box::new(move |_bytes| {
                let Envelope::Request { header, .. } =
                    request(1, Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))))
                else {
                    panic!("a request")
                };
                Ok(Some(Envelope::Request { header, payload }))
            }));
            router_core::register_resolver(
                &state.core.resolvers,
                (&echo(), handler((&Arc::default(), &Arc::default())), None),
            )
            .expect("the resolver registered");
        })
        .await
        .expect("the port ready");

    peer.receive((
        request(1, Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))),
        Arc::from("a"),
    ));
    crate::testing::patience(core::time::Duration::from_secs(10), started.cancelled())
        .await
        .expect("the verifier starts");
    peer.settle().await;
    assert!(
        !dropped.load(Ordering::SeqCst),
        "the live call holds its payload"
    );

    peer.receive((super::cancel_of(1), Arc::from("a")));
    peer.settle().await;

    assert!(
        dropped.load(Ordering::SeqCst),
        "the cancelled call lets go of its payload"
    );
    assert!(!ended.is_cancelled(), "the verifier keeps working");
    peer.owner
        .run(|state| {
            assert!(
                state
                    .core
                    .answering
                    .answering
                    .values()
                    .all(std::collections::BTreeMap::is_empty),
                "no answering call held"
            );
            assert!(state.sent.is_empty(), "no answer to the cancelled call");
            assert!(state.reports.is_empty(), "no verifier error reported");
        })
        .await
        .expect("the cancelled call forgotten");

    released.cancel();
    crate::testing::patience(core::time::Duration::from_secs(10), ended.cancelled())
        .await
        .expect("the verifier ends");
    peer.settle().await;
}
