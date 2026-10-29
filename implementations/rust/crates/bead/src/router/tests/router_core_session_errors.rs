//! A credential's failed resolution and a resolution that waits where it must settle at once.

use std::sync::Arc;

use tokio::sync::oneshot;

use super::locked;
use super::router_core_sessions::{failures, receive, request, serving, session};
use crate::constants::ProtocolCode;
use crate::envelope::Credential;
use crate::router::core::{Resolution, Resolved, Unresolved};

fn broken(message: &str) -> Unresolved {
    Unresolved::Other(Arc::new(std::io::Error::other(message.to_owned())))
}

fn jwt() -> Credential {
    Credential::Jwt(bytes::Bytes::from_static(b"a.b.c"))
}

fn expected(ids: &[u32]) -> Vec<(u32, u16, String)> {
    ids.iter()
        .map(|id| {
            (
                *id,
                ProtocolCode::PROCEDURE_FAILED.get().get(),
                String::new(),
            )
        })
        .collect()
}

async fn reports(peer: &crate::testing::core_port::Peer) -> Vec<(String, bool)> {
    peer.owner
        .run(|state| {
            state
                .reports
                .iter()
                .map(|(handle, error)| {
                    assert_eq!(handle.as_ref(), "a");
                    (
                        error.to_string(),
                        matches!(error, crate::router::types::RouterError::Other(error) if error.downcast_ref::<crate::errors::ProgrammerError>().is_some()),
                    )
                })
                .collect()
        })
        .await
        .expect("reports read")
}

// spec 13.1
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared error-order, OPAQUE and NONE scenarios include each late settlement"
)]
async fn a_credential_whose_resolution_throws_or_rejects_or_promises_for_none_or_opaque_is_answered_procedure_failed_and_reported_a_jwts_in_a_later_turn()
 {
    let (peer, handed, admitted) = serving(Some(Box::new(|request, _| {
        match request.carried.header.call_id {
            1 | 3 | 7 => Resolution::Now(Err(broken("no verifier answers"))),
            _ => Resolution::Later(Box::pin(async { Ok(Resolved::Session(session())) })),
        }
    })))
    .await;
    peer.owner
        .run(|state| {
            receive(state, (request(1, None), "a", None));
            receive(state, (request(3, Some(jwt())), "a", None));
            receive(state, (request(7, Some(jwt())), "a", None));
            receive(
                state,
                (
                    request(5, Some(Credential::Opaque(super::token()))),
                    "a",
                    None,
                ),
            );
            assert_eq!(
                state
                    .sent
                    .iter()
                    .map(|(_, envelope)| envelope.header().call_id())
                    .collect::<Vec<_>>(),
                [1, 5]
            );
        })
        .await
        .expect("synchronous failures precede JWT failures");
    peer.settle().await;
    assert_eq!(failures(&peer).await, expected(&[1, 5, 3, 7]));
    let reported = reports(&peer).await;
    assert_eq!(reported[0], ("no verifier answers".to_owned(), false));
    assert!(
        reported[1].1,
        "an asynchronous OPAQUE is a programmer error"
    );
    assert_eq!(
        &reported[2..],
        [
            ("no verifier answers".to_owned(), false),
            ("no verifier answers".to_owned(), false)
        ]
    );
    assert!(locked(&handed).is_empty());
    assert!(locked(&admitted).is_empty());

    let (release, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let (legacy, handed, admitted) = serving(Some(Box::new(move |request, _| {
        match request.carried.header.call_id {
            1 => Resolution::Now(Err(broken("the key set cannot be reached"))),
            3 => Resolution::Later(Box::pin(async { Err(broken("the verifier broke")) })),
            _ => {
                let waiting = waiting.take().expect("one OPAQUE resolution");
                Resolution::Later(Box::pin(async move { waiting.await.expect("released") }))
            }
        }
    })))
    .await;
    legacy
        .owner
        .run(|state| {
            receive(state, (request(1, Some(jwt())), "a", None));
            receive(state, (request(3, Some(jwt())), "a", None));
            receive(
                state,
                (
                    request(5, Some(Credential::Opaque(super::token()))),
                    "a",
                    None,
                ),
            );
        })
        .await
        .expect("legacy resolutions received");
    legacy.settle().await;
    assert_eq!(failures(&legacy).await, expected(&[5, 1, 3]));
    let reported = reports(&legacy).await;
    assert!(reported[0].1);
    assert_eq!(
        &reported[1..],
        [
            ("the key set cannot be reached".to_owned(), false),
            ("the verifier broke".to_owned(), false)
        ]
    );
    release.send(Ok(Resolved::Session(session()))).ok();
    legacy.settle().await;
    assert_eq!(failures(&legacy).await, expected(&[5, 1, 3]));
    assert_eq!(reports(&legacy).await.len(), 3);
    assert!(locked(&handed).is_empty());
    assert!(locked(&admitted).is_empty());

    let (release, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let (none, handed, admitted) = serving(Some(Box::new(move |_, _| {
        let waiting = waiting.take().expect("one NONE resolution");
        Resolution::Later(Box::pin(async move { waiting.await.expect("released") }))
    })))
    .await;
    none.receive((request(1, None), Arc::from("a")));
    none.settle().await;
    assert_eq!(failures(&none).await, expected(&[1]));
    assert!(matches!(reports(&none).await.as_slice(), [(_, true)]));
    release.send(Ok(Resolved::Session(session()))).ok();
    none.settle().await;
    assert_eq!(failures(&none).await, expected(&[1]));
    assert_eq!(reports(&none).await.len(), 1);
    assert!(locked(&handed).is_empty());
    assert!(locked(&admitted).is_empty());
}
