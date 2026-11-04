//! The calls a core answers: whether the call of a request is open still, and those it keeps
//! abandoned, the oldest of a connection yielding, and their timers ending.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::router_core_transfer_edges::serving;
use super::{Handed, locked};
use crate::constants::RouterSide;
use crate::envelope::{CancelHeader, Envelope, RequestHeader};
use crate::router::core::{self as router_core, Dispatch, Handler};
use crate::router::types::{CallAddress, ConnectionHandle, RouterAnswer, RouterLimitsOptions};
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

// the dispatch each request `handed` came with, as its router drew it: its id, its header handed
async fn dispatches_of(peer: &Peer, handed: &Handed) -> Vec<Arc<Dispatch>> {
    let requests: Vec<(ConnectionHandle, RequestHeader)> = locked(handed)
        .iter()
        .map(|props| (Arc::clone(&props.connection_handle), props.header.clone()))
        .collect();

    peer.owner
        .run(move |state| {
            requests
                .into_iter()
                .map(|(connection_handle, header)| {
                    let call = CallAddress {
                        connection_handle: Arc::clone(&connection_handle),
                        call_id: header.call_id,
                    };

                    Arc::new(Dispatch {
                        id: state
                            .core
                            .answering
                            .get(&call)
                            .expect("an open call")
                            .dispatched,
                        ..dispatch_of((connection_handle, header))
                    })
                })
                .collect()
        })
        .await
        .expect("the dispatches read")
}

// a dispatch of `header` on `connection_handle`, its id one its router never drew
fn dispatch_of((connection_handle, header): (ConnectionHandle, RequestHeader)) -> Dispatch {
    Dispatch {
        id: u64::MAX,
        connection_handle,
        header,
        handler: Mutex::new(None),
        session: Mutex::new(None),
        answered: Mutex::new(None),
        origin: (None, None),
    }
}

// whether the call each of `dispatches` opened is open still, as its router asks
async fn open_still(peer: &Peer, dispatches: Vec<Arc<Dispatch>>) -> Vec<bool> {
    peer.owner
        .run(move |state| {
            dispatches
                .iter()
                .map(|dispatch| router_core::is_answering(state, dispatch))
                .collect()
        })
        .await
        .expect("the calls read")
}

// ! a request is known by the id its dispatch drew, as the other sides know it by the very header
// dispatched: a request never dispatched is open to none, on every side
// spec 9.3, 9.4
#[tokio::test]
async fn say_whether_the_call_of_a_request_is_open_still() {
    let (peer, handed) = serving(true, &RouterLimitsOptions::default()).await;

    peer.receive((
        Envelope::Request {
            header: scripted_header(5),
            payload: Bytes::new(),
        },
        Arc::from("a"),
    ));
    peer.receive((
        Envelope::Request {
            header: scripted_header(7),
            payload: Bytes::new(),
        },
        Arc::from("a"),
    ));
    peer.settle().await;

    let dispatches = dispatches_of(&peer, &handed).await;

    assert_eq!(
        dispatches
            .iter()
            .map(|dispatch| dispatch.header.call_id)
            .collect::<Vec<_>>(),
        [5, 7],
        "both requests reach the resolver"
    );
    assert_eq!(
        open_still(&peer, dispatches.clone()).await,
        [true, true],
        "both open"
    );

    peer.receive((
        Envelope::Cancel {
            header: CancelHeader { call_id: 5 },
        },
        Arc::from("a"),
    ));

    let answerer = Arc::clone(&locked(&handed)[1].answerer);
    let answering = answerer.respond(RouterAnswer::Result(Bytes::new()));

    peer.settle().await;
    answering.await.expect("answered");

    assert_eq!(
        open_still(&peer, dispatches).await,
        [false, false],
        "cancelled, then answered"
    );
    // a request never dispatched says nothing for it
    assert_eq!(
        open_still(
            &peer,
            vec![Arc::new(dispatch_of((Arc::from("a"), scripted_header(9))))]
        )
        .await,
        [false],
        "never dispatched"
    );
}
