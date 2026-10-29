//! NONE and OPAQUE resolve and reach their admission and resolver within the receive turn.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::router_core_sessions::{handler, receive, request, session};
use super::{Handed, locked, token};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::router::core::{self as router_core, Resolution, Resolved};
use crate::router::types::RouterLimitsOptions;
use crate::testing::core_port::{Peer, scripted_header};
use crate::testing::pair::echo;

// spec 13.1: an owned header is compared by value; cloned tokens identify the same cancellation.
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared immediate and fallback scenarios prove the receive checkpoints, sessions, header values and signal identities together"
)]
async fn a_credential_of_none_or_opaque_resolves_in_the_turn_it_came_the_calls_session_handed_to_its_admission_then_to_its_resolver()
 {
    for none_has_session in [false, true] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let resolutions = Arc::new(Mutex::new(Vec::new()));
        let handed = Handed::default();
        let admitted = Arc::default();
        let mut handling = handler((&handed, &admitted));
        let admitting = Arc::clone(&admitted);
        let logging = Arc::clone(&order);
        handling.admit = Some(Arc::new(move |request| {
            locked(&logging).push(format!(
                "admit {} {:?}",
                request.header.call_id,
                request
                    .session
                    .as_ref()
                    .and_then(|session| session.data.as_ref())
            ));
            locked(&admitting).push(request.clone());
            Ok(None)
        }));
        let resolving = Arc::clone(&resolutions);
        let logging = Arc::clone(&order);
        let checking = Arc::clone(&order);
        let dispatched = Arc::clone(&handed);
        peer.owner
            .run(move |state| {
                let owner = state.core.owner.clone();
                state.session = Some(Box::new(move |request, signal| {
                    assert!(!signal.is_aborted());
                    let header = &request.carried.header;
                    locked(&logging).push(format!(
                        "resolve {} {}",
                        request.connection_handle, header.call_id
                    ));
                    locked(&resolving).push((request.clone(), signal.clone()));
                    let checkpoint = Arc::clone(&logging);
                    let id = header.call_id;
                    owner.offer(Box::new(move |_| {
                        locked(&checkpoint).push(format!("checkpoint {id}"));
                    }));
                    let result = if none_has_session {
                        let data = if header.credential.is_none() {
                            "none"
                        } else {
                            "OPAQUE"
                        };
                        Resolved::Session(crate::router::types::CallSession {
                            data: Some(serde_json::Value::String(data.to_owned())),
                            ..session()
                        })
                    } else if header.credential.is_none() {
                        Resolved::None
                    } else {
                        Resolved::Session(session())
                    };
                    Resolution::Now(Ok(result))
                }));
                router_core::register_resolver(&state.core.resolvers, (&echo(), handling, None))
                    .expect("echo registered");
                receive(state, (request(1, None), "a", None));
                receive(
                    state,
                    (
                        request(3, Some(Credential::Opaque(token()))),
                        if none_has_session { "a" } else { "b" },
                        None,
                    ),
                );
                assert_eq!(
                    locked(&dispatched).len(),
                    2,
                    "both dispatched before a checkpoint"
                );
                assert_eq!(
                    locked(&checking).len(),
                    4,
                    "each resolves, then admits, within this turn"
                );
                if none_has_session {
                    receive(state, (request(1, None), "a", None));
                    receive(
                        state,
                        (
                            Envelope::Request {
                                header: RequestHeader {
                                    service_id: 9,
                                    ..scripted_header(5)
                                },
                                payload: Bytes::from_static(&[1]),
                            },
                            "a",
                            None,
                        ),
                    );
                }
            })
            .await
            .expect("synchronous resolution and admission");
        peer.settle().await;
        {
            let resolved = locked(&resolutions);
            let dispatched = locked(&handed);
            let admitted = locked(&admitted);
            assert_eq!(
                resolved.len(),
                2,
                "duplicates and unknown routes never resolve"
            );
            for (index, (resolved, signal)) in resolved.iter().enumerate() {
                assert_eq!(resolved.carried.header, dispatched[index].header);
                assert_eq!(
                    resolved.connection_handle,
                    dispatched[index].connection_handle
                );
                assert_eq!(
                    signal.token(),
                    dispatched[index].signal.token(),
                    "the very call's cancellation"
                );
                assert_eq!(admitted[index].session, dispatched[index].session);
            }
            drop(resolved);
            drop(admitted);
            let data = dispatched
                .iter()
                .map(|props| {
                    props
                        .session
                        .as_ref()
                        .and_then(|session| session.data.clone())
                })
                .collect::<Vec<_>>();
            drop(dispatched);
            let expected = if none_has_session {
                vec![
                    Some(serde_json::json!("none")),
                    Some(serde_json::json!("OPAQUE")),
                ]
            } else {
                vec![None, Some(serde_json::json!("ada"))]
            };
            assert_eq!(data, expected);
            let expected = if none_has_session {
                vec![
                    "resolve a 1",
                    "admit 1 Some(String(\"none\"))",
                    "resolve a 3",
                    "admit 3 Some(String(\"OPAQUE\"))",
                    "checkpoint 1",
                    "checkpoint 3",
                ]
            } else {
                vec![
                    "resolve a 1",
                    "admit 1 None",
                    "resolve b 3",
                    "admit 3 Some(String(\"ada\"))",
                    "checkpoint 1",
                    "checkpoint 3",
                ]
            };
            assert_eq!(*locked(&order), expected);
        }
        peer.owner.run(move |state| {
            if none_has_session {
                assert!(matches!(state.reports.as_slice(), [(_, crate::router::types::RouterError::Failure(failure))] if failure.code() == ProtocolCode::ENVELOPE_MALFORMED.get()));
                assert!(matches!(state.sent.as_slice(), [(_, Envelope::Failure { failure, .. })] if failure.code == ProtocolCode::SERVICE_UNKNOWN.get()));
            } else {
                assert!(state.reports.is_empty(), "{:?}", state.reports);
                assert!(state.sent.is_empty(), "{:?}", state.sent);
            }
        }).await.expect("only the duplicate and unknown route are refused");
    }
}
