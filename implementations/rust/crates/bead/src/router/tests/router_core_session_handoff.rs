//! A credential forwarded to a destination, and a resolution stopped before its call continues.

use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::router_core_requester::{limits, quiet};
use super::router_core_sessions::{handler, receive, request, serving, session};
use super::{Handed, locked};
use crate::constants::CredentialScheme;
use crate::envelope::{CancelHeader, Credential, Envelope, RequestHeader};
use crate::router::core::{self as router_core, Resolution, Resolved, Unresolved};
use crate::router::types::SignalReason;
use crate::testing::core_port::{Peer, scripted_header};

fn jwt() -> Credential {
    Credential::Jwt(Bytes::from_static(b"a.b.c"))
}

fn to_destination(
    call_id: u32,
    (credential, destination_id): (Option<Credential>, u32),
) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            credential,
            destination_id: Some(destination_id),
            ..scripted_header(call_id)
        },
        payload: Bytes::new(),
    }
}

// spec 13.1
#[tokio::test]
async fn a_credential_of_a_jwt_or_an_elsewhere_its_handler_forwards_resolves_to_none_in_a_later_turn_all_the_same_a_request_presenting_none_delivered_behind_it_taken_first()
 {
    for (destination, carried) in [(7, "Bearer a.b.c"), (9, "Bearer mF_9.B5f-4.1JqM")] {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let keeping = Arc::clone(&asked);
        let (peer, handed, admitted) = serving(Some(Box::new(move |request, _| {
            locked(&keeping).push(request.carried.header.call_id);
            Resolution::Now(Ok(Resolved::None))
        })))
        .await;
        let checking = Arc::clone(&admitted);
        let mut forwarding = handler((&handed, &admitted));
        forwarding.forwards_credentials = true;
        peer.owner
            .run(move |state| {
                state.schemes = vec![CredentialScheme::JWT];
                state.destination = Some(Arc::new(forwarding));
                for (id, credential, transported) in [
                    (1, Some(jwt()), None),
                    (3, None, None),
                    (5, Some(Credential::Elsewhere), Some(carried)),
                    (7, None, None),
                ] {
                    receive(
                        state,
                        (
                            to_destination(id, (credential, destination)),
                            "a",
                            transported,
                        ),
                    );
                }
                assert_eq!(
                    locked(&checking)
                        .iter()
                        .map(|r| r.header.call_id)
                        .collect::<Vec<_>>(),
                    [3, 7]
                );
            })
            .await
            .expect("credential-free requests admitted first");
        peer.settle().await;
        assert_eq!(
            locked(&admitted)
                .iter()
                .map(|r| r.header.call_id)
                .collect::<Vec<_>>(),
            [3, 7, 1, 5]
        );
        assert!(locked(&admitted).iter().all(|r| r.session.is_none()));
        assert!(locked(&handed).iter().all(|r| r.session.is_none()));
        assert_eq!(*locked(&asked), [3, 7]);
        assert!(peer.sent().await.is_empty(), "no envelope is sent");
        quiet(&peer).await;
    }
}

// spec 13.1
#[tokio::test]
async fn hands_a_destinations_handler_the_bearer_credentials_its_call_came_with_and_a_resolver_neither_its_admission_neither()
 {
    let (peer, handed, admitted) = serving(Some(Box::new(|_, _| {
        Resolution::Now(Ok(Resolved::Session(session())))
    })))
    .await;
    let forwarded = Handed::default();
    let forwarding_admitted = Arc::default();
    let mut forwarding = handler((&forwarded, &forwarding_admitted));
    forwarding.forwards_credentials = true;
    peer.owner
        .run(move |state| {
            state.destination = Some(Arc::new(forwarding));
            for (id, credential) in [
                (1, None),
                (3, Some(jwt())),
                (5, Some(Credential::Elsewhere)),
            ] {
                receive(state, (request(id, credential), "a", Some("Bearer e")));
            }
            receive(
                state,
                (to_destination(7, (Some(jwt()), 9)), "a", Some("Bearer e")),
            );
            receive(
                state,
                (
                    to_destination(9, (Some(Credential::Elsewhere), 9)),
                    "a",
                    Some("Bearer e"),
                ),
            );
        })
        .await
        .expect("local and forwarded requests received");
    peer.settle().await;
    let credential = |id| match id {
        1 => None,
        3 => Some(Credential::Jwt(Bytes::new())),
        5 | 9 => Some(Credential::Elsewhere),
        7 => Some(jwt()),
        _ => panic!("a scripted request"),
    };
    for (header, session, carried) in locked(&handed)
        .iter()
        .map(|r| (&r.header, &r.session, &r.carried))
        .chain(
            locked(&admitted)
                .iter()
                .map(|r| (&r.header, &r.session, &r.carried)),
        )
    {
        assert_eq!(header.credential, credential(header.call_id));
        assert_eq!(
            session.as_deref(),
            Some(&super::router_core_sessions::session())
        );
        assert!(carried.is_none(), "a procedure receives no bearer secret");
    }
    assert_eq!(locked(&handed).len(), 3);
    assert_eq!(locked(&admitted).len(), 3);
    for (header, session, carried) in locked(&forwarded)
        .iter()
        .map(|r| (&r.header, &r.session, &r.carried))
        .chain(
            locked(&forwarding_admitted)
                .iter()
                .map(|r| (&r.header, &r.session, &r.carried)),
        )
    {
        assert_eq!(header.credential, credential(header.call_id));
        assert!(session.is_none());
        let carried = carried.as_ref().expect("a destination's credentials");
        assert_eq!(carried.header.credential, header.credential);
        assert_eq!(
            carried.transport_credential.as_deref(),
            (header.call_id == 9).then_some("Bearer e")
        );
    }
    assert_eq!(locked(&forwarded).len(), 2);
    assert_eq!(locked(&forwarding_admitted).len(), 2);
    assert!(peer.sent().await.is_empty(), "no envelope is sent");
    quiet(&peer).await;
}

type Release = oneshot::Sender<Result<Resolved, Unresolved>>;

// spec 13.1
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared cancellation scenarios cover stale resolutions, replacements and connection isolation"
)]
async fn a_credential_resolving_its_calls_cancel_or_its_connections_close_tells_session_of_by_the_calls_signal_and_what_it_settles_to_then_is_dropped()
 {
    for replaces_with_none in [false, true] {
        let pending: Arc<Mutex<BTreeMap<u32, Release>>> = Arc::default();
        let signals = Arc::new(Mutex::new(Vec::new()));
        let releases = Arc::clone(&pending);
        let keeping = Arc::clone(&signals);
        let (peer, handed, admitted) = serving(Some(Box::new(move |request, signal| {
            locked(&keeping).push(signal.clone());
            if request.carried.header.credential.is_none() {
                return Resolution::Now(Ok(Resolved::Session(session())));
            }
            let (release, waiting) = oneshot::channel();
            locked(&releases).insert(request.carried.header.call_id, release);
            Resolution::Later(Box::pin(async move {
                waiting.await.expect("resolution released")
            }))
        })))
        .await;
        peer.receive((request(1, Some(jwt())), Arc::from("a")));
        peer.settle().await;
        assert!(!locked(&signals)[0].is_aborted());
        peer.receive((
            Envelope::Cancel {
                header: CancelHeader { call_id: 1 },
            },
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(locked(&signals)[0].reason(), Some(SignalReason::Cancelled));
        if replaces_with_none {
            peer.receive((request(1, None), Arc::from("a")));
            peer.settle().await;
            locked(&pending)
                .remove(&1)
                .expect("first resolution")
                .send(Ok(Resolved::Session(session())))
                .expect("released");
            peer.settle().await;
            peer.receive((request(3, Some(jwt())), Arc::from("b")));
            peer.receive((request(5, Some(jwt())), Arc::from("a")));
            peer.settle().await;
            peer.owner
                .run(|state| {
                    router_core::reject_pending(
                        state,
                        ("the connection closed", Some(&Arc::from("b"))),
                    );
                })
                .await
                .expect("b closed");
            assert_eq!(
                locked(&signals)[2].reason(),
                Some(SignalReason::Disconnected(
                    "the connection closed".to_owned()
                ))
            );
            assert!(!locked(&signals)[3].is_aborted());
        } else {
            peer.receive((request(3, Some(jwt())), Arc::from("a")));
            peer.receive((request(5, Some(jwt())), Arc::from("a")));
            peer.settle().await;
            peer.owner
                .run(|state| {
                    router_core::reject_pending(state, ("a closed", Some(&Arc::from("a"))));
                })
                .await
                .expect("a closed");
            assert_eq!(
                locked(&signals)[1].reason(),
                Some(SignalReason::Disconnected("a closed".to_owned()))
            );
            assert_eq!(
                locked(&signals)[2].reason(),
                Some(SignalReason::Disconnected("a closed".to_owned()))
            );
            locked(&pending)
                .remove(&1)
                .expect("first")
                .send(Ok(Resolved::Session(session())))
                .expect("released");
        }
        locked(&pending)
            .remove(&3)
            .expect("third")
            .send(Err(Unresolved::Other(Arc::new(std::io::Error::other(
                "stopped",
            )))))
            .expect("released");
        if !replaces_with_none {
            locked(&pending)
                .remove(&5)
                .expect("fifth")
                .send(Ok(Resolved::None))
                .expect("released");
        }
        peer.settle().await;
        assert!(peer.sent().await.is_empty(), "no envelope is sent");
        quiet(&peer).await;
        assert_eq!(locked(&handed).len(), usize::from(replaces_with_none));
        if replaces_with_none {
            locked(&pending)
                .remove(&5)
                .expect("fifth")
                .send(Ok(Resolved::Session(session())))
                .expect("released");
        } else {
            peer.receive((request(1, Some(jwt())), Arc::from("a")));
            peer.settle().await;
            locked(&pending)
                .remove(&1)
                .expect("replacement")
                .send(Ok(Resolved::Session(session())))
                .expect("released");
        }
        peer.settle().await;
        let expected = if replaces_with_none {
            vec![1, 5]
        } else {
            vec![1]
        };
        assert_eq!(
            locked(&admitted)
                .iter()
                .map(|r| r.header.call_id)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            locked(&handed)
                .iter()
                .map(|r| r.header.call_id)
                .collect::<Vec<_>>(),
            expected
        );
        assert!(peer.sent().await.is_empty(), "no envelope is sent");
        quiet(&peer).await;
    }
}

// spec 13.1, 12.3
#[tokio::test]
async fn a_credential_resolving_a_transfers_opening_gets_no_credit_until_its_resolution_and_its_admission_settle()
 {
    for (total, opening) in [(100, 8), (300, 20)] {
        let peer = Peer::new(crate::constants::RouterSide::Server, &limits());
        let handed = Handed::default();
        let admitted = Arc::default();
        let checking = Arc::clone(&admitted);
        let handler = handler((&handed, &admitted));
        let (release, waiting) = oneshot::channel();
        let mut waiting = Some(waiting);
        peer.owner
            .run(move |state| {
                state.schemes = vec![CredentialScheme::JWT];
                state.session = Some(Box::new(move |_, _| {
                    let waiting = waiting.take().expect("one opening");
                    Resolution::Later(Box::pin(async move { waiting.await.expect("released") }))
                }));
                router_core::register_resolver(
                    &state.core.resolvers,
                    (&crate::testing::pair::echo(), handler, None),
                )
                .expect("echo registered");
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: RequestHeader {
                                total: Some(total),
                                credential: Some(jwt()),
                                ..scripted_header(1)
                            },
                            payload: Bytes::from(vec![0; opening]),
                        },
                        "a",
                        None,
                    ),
                );
                assert!(locked(&checking).is_empty());
            })
            .await
            .expect("opening resolving");
        peer.clock.advance(Duration::from_secs(1)).await;
        assert!(peer.sent().await.is_empty(), "no envelope is sent");
        assert!(locked(&admitted).is_empty());
        release
            .send(Ok(Resolved::Session(session())))
            .expect("released");
        peer.settle().await;
        assert_eq!(locked(&admitted).len(), 1);
        assert!(locked(&handed).is_empty());
        let expected = total.min(u64::try_from(opening).expect("small opening") + 128);
        assert!(
            matches!(peer.sent().await.as_slice(), [(_, Envelope::Credit { header })] if header.call_id == 1 && header.credit_end == expected)
        );
        quiet(&peer).await;
    }
}
