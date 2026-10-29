//! The instant a made call is counted, and what answers hear before sending or after disposal.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::router_core_requester::{failed, quiet};
use super::{Handed, keeping, locked, result_of};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::duration::NEVER;
use crate::envelope::{Envelope, NotificationHeader};
use crate::errors::CallError;
use crate::failure::Failure;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::router::core::{self as router_core, Handler};
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, error_of, request_of, scripted_header};

async fn serving(maximum_payload_bytes: Option<u64>) -> (Peer, Handed) {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let handed = Handed::default();
    let resolve = keeping((&handed, None));
    peer.owner
        .run(move |state| {
            router_core::register_resolver(
                &state.core.resolvers,
                (
                    &crate::testing::pair::echo(),
                    Handler {
                        resolve,
                        admit: None,
                        maximum_payload_bytes,
                        forwards_credentials: false,
                        notifies: false,
                    },
                    None,
                ),
            )
            .expect("echo registered");
        })
        .await
        .expect("the resolver ready");
    (peer, handed)
}

async fn open(peer: &Peer, (call_id, handle): (u32, &str)) {
    peer.receive((
        Envelope::Request {
            header: scripted_header(call_id),
            payload: Bytes::from_static(&[1]),
        },
        Arc::from(handle),
    ));
    peer.settle().await;
}

fn assert_endings(registry: &MetricsRegistry, side: RouterSide) {
    let kind = if side == RouterSide::Server {
        "command"
    } else {
        "request"
    };
    let labels = format!("service=\"2\",procedure=\"echo\",type=\"{kind}\"");
    let line = |suffix: &str| {
        format!(
            "bead_client_call_{}",
            suffix
                .replace("{}", &format!("{{{labels}}}"))
                .replace("{outcome", &format!("{{{labels},outcome"))
        )
    };
    let mut actual = super::metrics::counts_of(registry);
    actual.sort();
    let mut expected = [
        "duration_seconds_bucket{le=\"0.0\"} 5",
        "duration_seconds_count{} 6",
        "handled_total{outcome=\"result\"} 1",
        "handled_total{outcome=\"failure\",code=\"application\"} 1",
        "handled_total{outcome=\"timeout\"} 1",
        "handled_total{outcome=\"cancelled\"} 1",
        "handled_total{outcome=\"closed\"} 1",
        "handled_total{outcome=\"error\"} 1",
        "started_total{} 6",
    ]
    .map(|suffix| line(suffix).replace("{le", &format!("{{{labels},le")));
    expected.sort();
    assert_eq!(actual, expected);
    assert!(
        registry
            .exposition()
            .text
            .lines()
            .any(|sample| sample == line("duration_seconds_sum{} 0.01"))
    );
}

// debugging 9.3, 9.6.3, 9.6.4
#[tokio::test]
async fn counts_a_call_it_makes_as_its_router_settles_it_timed_to_that_instant() {
    for side in [RouterSide::Server, RouterSide::Client] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let registry =
            MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
        let metrics = registry.attach(side);
        let series = metrics
            .declare_requester(&crate::testing::pair::echo())
            .expect("echo declared");
        peer.owner
            .run(move |state| {
                state.core.metrics = Some(metrics);
            })
            .await
            .expect("the core counts");
        let ask = |timeout, signal| {
            let mut request = request_of("a");
            request.options.timeout = timeout;
            request.options.signal = signal;
            request.series = Some(series.clone());
            peer.request((Bytes::new(), request))
        };
        let first = if side == RouterSide::Server { 2 } else { 1 };
        let result = ask(NEVER, None);
        let failure = ask(NEVER, None);
        let timed = ask(Duration::from_millis(10), None);
        peer.receive((result_of(first, None), Arc::from("a")));
        peer.receive((
            failed(first + 2, (9, FailureScope::Application, 0, "")),
            Arc::from("a"),
        ));
        peer.clock.advance(Duration::from_millis(10)).await;
        assert!(
            matches!(completed(timed).await, Err(CallError::TimedOut(delay)) if delay == Duration::from_millis(10))
        );
        let signal = CancellationToken::new();
        let cancelled = ask(NEVER, Some(signal.clone()));
        peer.settle().await;
        signal.cancel();
        assert!(matches!(
            completed(cancelled).await,
            Err(CallError::Cancelled)
        ));
        let closed = ask(NEVER, None);
        peer.owner
            .run(|state| {
                router_core::reject_pending(
                    state,
                    (
                        "the connection closed before the answer",
                        Some(&Arc::from("a")),
                    ),
                );
            })
            .await
            .expect("the connection closed");
        assert!(matches!(
            completed(closed).await,
            Err(CallError::Disconnected(_))
        ));
        peer.owner
            .run(|state| {
                state.sending.push_back(Err(error_of("refused")));
            })
            .await
            .expect("the transport refuses");
        assert_eq!(
            completed(ask(NEVER, None))
                .await
                .expect_err("the send fails")
                .to_string(),
            "refused"
        );
        completed(result).await.expect("result received");
        assert!(
            matches!(completed(failure).await, Err(CallError::Failure(failure)) if failure.code().get() == 9)
        );
        assert_endings(&registry, side);
        quiet(&peer).await;
    }
}

// spec 9.0, 12.2
#[tokio::test]
async fn tells_the_side_of_each_answer_before_it_goes_out_and_undoes_it_when_it_does_not_go_out() {
    let (peer, handed) = serving(None).await;
    for (call_id, handle) in [(1, "a"), (3, "a"), (5, "b"), (7, "a")] {
        open(&peer, (call_id, handle)).await;
    }
    let answers = locked(&handed)
        .iter()
        .map(|props| Arc::clone(&props.answerer))
        .collect::<Vec<_>>();
    answers[0]
        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
        .await
        .expect("result sent");
    answers[1]
        .respond(RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record(),
        ))
        .await
        .expect("failure sent");
    peer.owner
        .run(|state| {
            state.sending.push_back(Err(error_of("gone")));
        })
        .await
        .expect("the third send refuses");
    assert_eq!(
        answers[2]
            .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
            .await
            .expect_err("the send failed")
            .to_string(),
        "gone"
    );
    assert!(
        matches!(answers[3].respond(RouterAnswer::Result(Bytes::from(vec![0; 0x100_0001]))).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    peer.owner
        .run(|state| {
            assert_eq!(state.before_sent, [0, 1, 2]);
            assert_eq!(
                state
                    .before
                    .iter()
                    .map(|answer| {
                        assert!(answer.handler.is_some(), "the registered echo resolver");
                        (
                            answer.header.call_id,
                            answer.connection_handle.as_ref(),
                            answer.is_failure,
                        )
                    })
                    .collect::<Vec<_>>(),
                [(1, "a", false), (3, "a", true), (5, "b", false)]
            );
            assert_eq!(state.undone, [5]);
        })
        .await
        .expect("the callback order checked");
    quiet(&peer).await;

    let (bounded, handed) = serving(Some(10)).await;
    open(&bounded, (1, "a")).await;
    let answer = Arc::clone(&locked(&handed)[0].answerer);
    bounded
        .owner
        .run(|state| {
            state
                .sending
                .push_back(Err(error_of("the transport refused the result")));
        })
        .await
        .expect("the send refuses");
    assert_eq!(
        answer
            .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
            .await
            .expect_err("the result refused")
            .to_string(),
        "the transport refused the result"
    );
    open(&bounded, (3, "a")).await;
    let answer = Arc::clone(&locked(&handed)[1].answerer);
    assert!(
        matches!(answer.respond(RouterAnswer::Result(Bytes::from(vec![0; 11]))).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    bounded
        .owner
        .run(|state| {
            assert_eq!(state.before.len(), 1);
            assert_eq!(state.undone, [1]);
        })
        .await
        .expect("a payload past its limit calls no hook");
    quiet(&bounded).await;
}

// spec 9.0
#[tokio::test]
async fn once_disposed_rejects_what_waits_and_sends_nothing_more() {
    for side in [RouterSide::Server, RouterSide::Client] {
        let (peer, handed) = if side == RouterSide::Server {
            serving(None).await
        } else {
            (
                Peer::new(side, &RouterLimitsOptions::default()),
                Handed::default(),
            )
        };
        let waiting = peer.request((Bytes::new(), request_of("a")));
        if side == RouterSide::Server {
            open(&peer, (5, "a")).await;
        }
        peer.settle().await;
        peer.owner
            .run(|state| {
                assert!(!state.core.is_disposed());
                router_core::dispose(state);
                assert!(state.core.is_disposed());
            })
            .await
            .expect("disposed");
        assert_eq!(
            completed(waiting)
                .await
                .expect_err("the pending call closes")
                .to_string(),
            "the router was disposed before the answer"
        );
        if side == RouterSide::Server {
            let answer = Arc::clone(&locked(&handed)[0].answerer);
            assert!(matches!(
                answer.respond(RouterAnswer::Result(Bytes::new())).await,
                Err(CallError::Disconnected(_))
            ));
        }
        peer.owner
            .run(|state| {
                crate::router::requester::cancel(
                    state,
                    (
                        &crate::router::types::CallAddress {
                            call_id: 2,
                            connection_handle: Arc::from("a"),
                        },
                        None,
                    ),
                );
                assert_eq!(state.core.pending.reservations.len(), 0);
            })
            .await
            .expect("a cancel reserves nothing");
        assert!(matches!(
            completed(peer.request((Bytes::new(), request_of("a")))).await,
            Err(CallError::Disconnected(_))
        ));
        assert!(matches!(
            completed(peer.respond((
                RouterAnswer::Result(Bytes::new()),
                crate::router::types::CallAddress {
                    call_id: 1,
                    connection_handle: Arc::from("a")
                }
            )))
            .await,
            Err(CallError::Disconnected(_))
        ));
        assert!(matches!(
            completed(peer.send((
                Envelope::Notification {
                    header: NotificationHeader { call_id: 1 },
                    payload: Bytes::new()
                },
                Arc::from("a")
            )))
            .await,
            Err(CallError::Disconnected(_))
        ));
        assert_eq!(peer.sent().await.len(), 1);
        assert_eq!(peer.clock.dues(), Vec::<Duration>::new());
        quiet(&peer).await;
    }
}
