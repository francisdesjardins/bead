//! The calls a core keeps abandoned: the oldest of a connection yields, and their timers end.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;

use crate::constants::RouterSide;
use crate::envelope::{CancelHeader, Envelope, RequestHeader};
use crate::router::core::{self as router_core, Handler};
use crate::router::types::{CallAddress, RouterLimitsOptions};
use crate::testing::core_port::{Peer, scripted_header};

async fn peer() -> Peer {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            maximum_transfers: Some(2),
            transfer_inactivity_timeout: Some(Duration::from_millis(250)),
            ..RouterLimitsOptions::default()
        },
    );
    peer.owner
        .run(|state| {
            router_core::register_resolver(
                &state.core.resolvers,
                (
                    &crate::testing::pair::echo(),
                    Handler {
                        resolve: Arc::new(|_| Box::pin(async { Ok(()) })),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                    None,
                ),
            )
            .expect("echo registered");
        })
        .await
        .expect("the port ready");
    peer
}

async fn open(peer: &Peer, (call_id, handle, total): (u32, &str, Option<u64>)) {
    peer.receive((
        Envelope::Request {
            header: RequestHeader {
                total,
                ..scripted_header(call_id)
            },
            payload: if total.is_some() {
                Bytes::from_static(&[1])
            } else {
                Bytes::new()
            },
        },
        Arc::from(handle),
    ));
    peer.settle().await;
}

async fn end(peer: &Peer, (call_id, handle, total, is_taken): (u32, &str, Option<u64>, bool)) {
    open(peer, (call_id, handle, total)).await;
    if is_taken {
        peer.receive((
            Envelope::Cancel {
                header: CancelHeader { call_id },
            },
            Arc::from(handle),
        ));
    } else {
        let handle = handle.to_owned();
        peer.owner
            .run(move |state| {
                let dispatch = state
                    .core
                    .receiving_requests
                    .values()
                    .find(|(dispatch, _)| {
                        dispatch.header.call_id == call_id
                            && dispatch.connection_handle.as_ref() == handle
                    })
                    .map(|(dispatch, _)| Arc::clone(dispatch));
                if let Some(dispatch) = dispatch {
                    router_core::close_answering(state, &dispatch);
                } else {
                    state.core.answering.forget(
                        &CallAddress {
                            call_id,
                            connection_handle: Arc::from(handle),
                        },
                        None,
                    );
                }
            })
            .await
            .expect("the call closed");
    }
    peer.settle().await;
    peer.owner
        .run(|state| {
            assert!(state.reports.is_empty(), "{:?}", state.reports);
        })
        .await
        .expect("the port reports nothing");
}

async fn ends(peer: &Peer, (handle, ids): (&str, Vec<u32>)) -> Vec<Option<u64>> {
    let handle: Arc<str> = Arc::from(handle);
    peer.owner
        .run(move |state| {
            ids.iter()
                .map(|&call_id| {
                    state.core.answering.abandoned_end_of(&CallAddress {
                        call_id,
                        connection_handle: Arc::clone(&handle),
                    })
                })
                .collect()
        })
        .await
        .expect("the abandoned calls read")
}

// spec 12.5
#[tokio::test]
async fn keeps_a_call_that_received_a_transfer_abandoned_once_it_ends_the_oldest_of_a_connection_yielding()
 {
    let peer = peer().await;
    end(&peer, (1, "a", Some(10), false)).await;
    end(&peer, (3, "a", Some(20), true)).await;
    end(&peer, (1, "b", Some(40), false)).await;
    end(&peer, (7, "a", None, false)).await;
    assert_eq!(
        ends(&peer, ("a", vec![1, 3, 7])).await,
        [Some(10), Some(20), None]
    );
    peer.owner
        .run(|state| {
            assert!(!state.core.answering.has(&CallAddress {
                call_id: 1,
                connection_handle: Arc::from("a")
            }));
        })
        .await
        .expect("an abandoned call is not open");

    open(&peer, (1, "a", None)).await;
    assert_eq!(ends(&peer, ("a", vec![1])).await, [None]);
    peer.receive((
        Envelope::Cancel {
            header: CancelHeader { call_id: 1 },
        },
        Arc::from("a"),
    ));
    peer.settle().await;
    end(&peer, (1, "a", Some(15), true)).await;
    end(&peer, (5, "a", Some(30), false)).await;
    assert_eq!(
        ends(&peer, ("a", vec![1, 3, 5])).await,
        [Some(15), None, Some(30)]
    );
    assert_eq!(ends(&peer, ("b", vec![1])).await, [Some(40)]);

    open(&peer, (9, "a", Some(50))).await;
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("a closed", Some(&Arc::from("a"))));
        })
        .await
        .expect("a closed");
    assert_eq!(ends(&peer, ("a", vec![1, 5, 9])).await, [None, None, None]);
    assert_eq!(ends(&peer, ("b", vec![1])).await, [Some(40)]);
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("all closed", None));
        })
        .await
        .expect("all closed");
    assert_eq!(ends(&peer, ("b", vec![1])).await, [None]);
}

// spec 12.5
#[tokio::test]
async fn forgets_a_call_abandoned_once_its_transfers_inactivity_is_over() {
    let peer = peer().await;
    for call_id in [1, 3] {
        end(&peer, (call_id, "a", Some(10), true)).await;
    }
    assert_eq!(
        peer.clock.dues(),
        [Duration::from_millis(250), Duration::from_millis(250)]
    );
    open(&peer, (3, "a", None)).await;
    assert_eq!(peer.clock.dues(), [Duration::from_millis(250)]);
    peer.clock.advance(Duration::from_millis(249)).await;
    assert_eq!(ends(&peer, ("a", vec![1])).await, [Some(10)]);
    peer.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(ends(&peer, ("a", vec![1, 3])).await, [None, None]);
}
