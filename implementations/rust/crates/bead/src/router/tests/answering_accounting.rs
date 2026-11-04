//! A call's ending belongs to its dispatch, and its series counts that ending once.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{
    Dispatch, Handler, close_answering, end_answering, register_resolver, reject_pending,
    take_answering,
};
use crate::constants::RouterSide;
use crate::envelope::Envelope;
use crate::metrics::{CallEnding, MetricsRegistry, MetricsRegistryOptions};
use crate::router::types::{CallAddress, RouterLimitsOptions};
use crate::testing::core_port::{Peer, scripted_header};

async fn counted() -> (Peer, MetricsRegistry) {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let metrics = registry.attach(RouterSide::Server);
    peer.owner
        .run(move |state| {
            register_resolver(
                &state.core.resolvers,
                (
                    &crate::testing::pair::echo(),
                    Handler {
                        resolve: Arc::new(|_| Box::pin(core::future::pending())),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                    None,
                ),
            )
            .expect("echo registered");
            state.core.metrics = Some(metrics);
        })
        .await
        .expect("the counted port ready");
    (peer, registry)
}

fn dispatch((call_id, name): (u32, &str), id: u64) -> Dispatch {
    Dispatch {
        id,
        connection_handle: Arc::from(name),
        header: scripted_header(call_id),
        handler: Mutex::new(None),
        session: Mutex::new(None),
        answered: Mutex::new(None),
        origin: (None, None),
    }
}

async fn open(peer: &Peer, (call_id, name): (u32, &str)) -> Arc<Dispatch> {
    peer.receive((
        Envelope::Request {
            header: scripted_header(call_id),
            payload: Bytes::new(),
        },
        Arc::from(name),
    ));
    peer.settle().await;
    let handle: Arc<str> = Arc::from(name);
    peer.owner
        .run(move |state| {
            let id = state
                .core
                .answering
                .get(&CallAddress {
                    connection_handle: Arc::clone(&handle),
                    call_id,
                })
                .expect("the request opened")
                .dispatched;
            Arc::new(dispatch((call_id, &handle), id))
        })
        .await
        .expect("the dispatch read")
}

// what a registry's call series hold: the calls started, each ending's count, and their seconds
struct Counts<'a> {
    started: u64,
    endings: &'a [(&'a str, u64)],
    seconds: &'a str,
}

fn assert_counts(
    registry: &MetricsRegistry,
    &Counts {
        started,
        endings,
        seconds,
    }: &Counts<'_>,
) {
    let mut actual = registry
        .exposition()
        .text
        .lines()
        .filter(|line| {
            line.starts_with("bead_server_call_")
                && !line.contains("_bucket")
                && !line.ends_with(" 0")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let labels = "service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\"";
    let ended: u64 = endings.iter().map(|(_, count)| count).sum();
    let mut expected = Vec::new();
    if started > 0 {
        expected.push(format!(
            "bead_server_call_started_total{{{labels}}} {started}"
        ));
    }
    if ended > 0 {
        expected.push(format!(
            "bead_server_call_duration_seconds_count{{{labels}}} {ended}"
        ));
    }
    if seconds != "0" {
        expected.push(format!(
            "bead_server_call_duration_seconds_sum{{{labels}}} {seconds}"
        ));
    }
    for (ending, count) in endings {
        expected.push(format!(
            "bead_server_call_handled_total{{{labels},outcome=\"{ending}\"}} {count}"
        ));
    }
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn counts_no_ending_for_an_absent_call_or_a_stale_header_on_a_replacement_call() {
    let (peer, registry) = counted().await;
    peer.owner
        .run(|state| end_answering(state, (&dispatch((1, "a"), 0), CallEnding::Result)))
        .await
        .expect("an absent call ends nothing");
    assert_counts(
        &registry,
        &Counts {
            started: 0,
            endings: &[],
            seconds: "0",
        },
    );
    let first = open(&peer, (1, "a")).await;
    let ending = Arc::clone(&first);
    peer.owner
        .run(move |state| {
            end_answering(state, (&dispatch((1, "b"), ending.id), CallEnding::Result));
            end_answering(state, (&dispatch((1, "a"), u64::MAX), CallEnding::Result));
        })
        .await
        .expect("another connection and an undispatched header end nothing");
    assert_counts(
        &registry,
        &Counts {
            started: 1,
            endings: &[],
            seconds: "0",
        },
    );
    peer.owner
        .run(|state| {
            take_answering(
                state,
                &CallAddress {
                    call_id: 1,
                    connection_handle: Arc::from("a"),
                },
            )
            .expect("the first call taken");
        })
        .await
        .expect("the first call cancelled");
    let ending = Arc::clone(&first);
    peer.owner
        .run(move |state| end_answering(state, (&ending, CallEnding::Result)))
        .await
        .expect("the taken call ends nothing more");
    let next = open(&peer, (1, "a")).await;
    let checking = Arc::clone(&next);
    peer.owner
        .run(move |state| {
            end_answering(state, (&first, CallEnding::Result));
            end_answering(state, (&dispatch((3, "a"), 0), CallEnding::Error));
            let call = CallAddress {
                call_id: 1,
                connection_handle: Arc::from("a"),
            };
            assert!(
                state
                    .core
                    .answering
                    .signal_of((&call, checking.id))
                    .is_some()
            );
            assert_eq!(state.core.answering.count_on(&Arc::from("a")), 1);
        })
        .await
        .expect("stale and absent headers leave the replacement open");
    assert_counts(
        &registry,
        &Counts {
            started: 2,
            endings: &[("cancelled", 1)],
            seconds: "0",
        },
    );
    peer.owner
        .run(move |state| {
            end_answering(state, (&next, CallEnding::Result));
            close_answering(state, &next);
            end_answering(state, (&next, CallEnding::Error));
            assert_eq!(state.core.answering.count_on(&Arc::from("a")), 0);
        })
        .await
        .expect("the replacement ends once");
    assert_counts(
        &registry,
        &Counts {
            started: 2,
            endings: &[("cancelled", 1), ("result", 1)],
            seconds: "0",
        },
    );
    peer.owner.run(super::dispose).await.expect("disposed");
}

#[tokio::test]
async fn count_a_call_opened_with_a_series_once_as_its_end_says_else_cancelled_as_it_is_taken_closed_with_its_connection_an_error_as_it_is_closed_unanswered()
 {
    let (peer, registry) = counted().await;
    let ended = open(&peer, (1, "a")).await;
    let _taken = open(&peer, (3, "a")).await;
    let _closed = open(&peer, (5, "b")).await;
    let unanswered = open(&peer, (7, "a")).await;
    assert_counts(
        &registry,
        &Counts {
            started: 4,
            endings: &[],
            seconds: "0",
        },
    );
    peer.clock.advance(Duration::from_millis(2)).await;
    peer.owner
        .run(move |state| {
            end_answering(state, (&ended, CallEnding::Result));
            end_answering(state, (&ended, CallEnding::Error));
            close_answering(state, &ended);
        })
        .await
        .expect("the answered call ends once");
    assert_counts(
        &registry,
        &Counts {
            started: 4,
            endings: &[("result", 1)],
            seconds: "0.002",
        },
    );
    peer.owner
        .run(|state| {
            take_answering(
                state,
                &CallAddress {
                    call_id: 3,
                    connection_handle: Arc::from("a"),
                },
            )
            .expect("call 3 taken");
        })
        .await
        .expect("the taken call counts as cancelled");
    assert_counts(
        &registry,
        &Counts {
            started: 4,
            endings: &[("result", 1), ("cancelled", 1)],
            seconds: "0.004",
        },
    );
    peer.owner
        .run(|state| {
            reject_pending(state, ("b closed", Some(&Arc::from("b"))));
        })
        .await
        .expect("the connection's call counts as closed");
    assert_counts(
        &registry,
        &Counts {
            started: 4,
            endings: &[("result", 1), ("cancelled", 1), ("closed", 1)],
            seconds: "0.006",
        },
    );
    peer.owner
        .run(move |state| {
            close_answering(state, &unanswered);
            assert!(state.core.answering.take_all(None).is_empty());
        })
        .await
        .expect("the four endings counted");
    assert_counts(
        &registry,
        &Counts {
            started: 4,
            endings: &[("result", 1), ("cancelled", 1), ("closed", 1), ("error", 1)],
            seconds: "0.008",
        },
    );
    peer.owner.run(super::dispose).await.expect("disposed");
}
