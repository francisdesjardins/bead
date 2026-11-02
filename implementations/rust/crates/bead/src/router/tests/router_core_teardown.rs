//! A closing connection with resolvers awaiting commands, their results held for credit.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::locked;
use super::router_core_requester::{limits, pattern};
use crate::constants::RouterSide;
use crate::duration::NEVER;
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::router::core::{self as router_core, Handler};
use crate::router::requester;
use crate::router::types::{Gauges, RouterAnswer, Signal, SignalReason};
use crate::testing::core_port::{Peer, completed, request_of, scripted_header};
use crate::testing::pair::echo;

#[derive(Default)]
struct Heard {
    signals: Vec<Signal>,
    rejected: Vec<(bool, CallError)>,
    answered: Vec<Result<(), CallError>>,
    // The command's reply runs before aborting its resolver's signal; its awaiting application
    // resumes after that signal is aborted.
    replies: Vec<bool>,
}

fn detached(gauges: &Gauges) {
    for name in [
        "answeringCalls",
        "pendingCalls",
        "receivingTransfers",
        "sendingTransfers",
    ] {
        assert_eq!(gauges.counts.get(name), Some(&0), "{name}: {gauges:?}");
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the teardown twin observes admission, transfer, counted close and application callbacks"
)]
async fn close_awaiting((forward, incoming): (bool, u32)) {
    let peer = Peer::new(RouterSide::Server, &limits());
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let metrics = registry.attach(RouterSide::Server);
    let heard = Arc::new(Mutex::new(Heard::default()));
    let hearing = Arc::clone(&heard);
    let owner = peer.owner.clone();
    let made = metrics
        .declare_requester(&echo())
        .expect("commands counted");
    peer.owner
        .run(move |state| {
            state.core.metrics = Some(metrics.clone());
            router_core::register_resolver(
                &state.core.resolvers,
                (
                    &echo(),
                    Handler {
                        resolve: Arc::new(move |props| {
                            let owner = owner.clone();
                            let hearing = Arc::clone(&hearing);
                            let made = made.clone();
                            locked(&hearing).signals.push(props.signal.clone());
                            Box::pin(async move {
                                let (reply, outgoing) = oneshot::channel();
                                let handle = Arc::clone(&props.connection_handle);
                                let signal = props.signal.clone();
                                let replying = Arc::clone(&hearing);
                                let replied_signal = signal.clone();
                                owner
                                    .run(move |state| {
                                        let mut request = request_of(&handle);
                                        request.options.timeout = NEVER;
                                        request.options.signal =
                                            forward.then(|| signal.token().clone());
                                        request.series = Some(made);
                                        requester::request(
                                            state,
                                            (
                                                Bytes::new(),
                                                request,
                                                Box::new(move |outcome| {
                                                    locked(&replying)
                                                        .replies
                                                        .push(replied_signal.is_aborted());
                                                    reply.send(outcome).ok();
                                                }),
                                            ),
                                        );
                                    })
                                    .await
                                    .expect("the command made");
                                let answered =
                                    props.answerer.respond(RouterAnswer::Result(pattern(200)));
                                let outcome = completed(outgoing)
                                    .await
                                    .expect_err("the connection closes");
                                locked(&hearing)
                                    .rejected
                                    .push((props.signal.is_aborted(), outcome));
                                let outcome = answered.await;
                                locked(&hearing).answered.push(outcome);
                                Ok(())
                            })
                        }),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                    Some(&metrics),
                ),
            )
            .expect("echo registered");
        })
        .await
        .expect("the resolver installed");
    for index in 0..incoming {
        peer.receive((
            Envelope::Request {
                header: scripted_header(index.saturating_mul(2).saturating_add(1)),
                payload: Bytes::new(),
            },
            Arc::from("a"),
        ));
    }
    peer.settle().await;
    let before = peer
        .owner
        .run(|state| state.core.gauges())
        .await
        .expect("gauges");
    for name in ["answeringCalls", "pendingCalls", "sendingTransfers"] {
        assert_eq!(
            before.counts.get(name),
            Some(&u64::from(incoming)),
            "{name}"
        );
    }
    let sent_before = peer.sent().await.len();
    let reads: Arc<Mutex<Vec<Gauges>>> = Arc::default();
    let observing = Arc::clone(&reads);
    let at_return = Arc::clone(&heard);
    peer.owner
        .run(move |state| {
            state.core.observed_reads = Some(observing);
            router_core::reject_pending(state, ("the connection closed", Some(&Arc::from("a"))));
            state.core.observed_reads = None;
            detached(&state.core.gauges());
            let heard = locked(&at_return);
            assert_eq!(
                heard.replies,
                vec![false; usize::try_from(incoming).expect("small count")],
                "the commands rejected before their incoming signals abort"
            );
            assert!(
                heard.signals.iter().all(Signal::is_aborted),
                "signals abort before returning"
            );
            drop(heard);
        })
        .await
        .expect("the connection closed");
    peer.settle().await;

    // * Rust takes one time reading for the whole incoming batch. Each call still ends once;
    // every transfer and both sets of calls are out before that first counted end.
    {
        let reads = locked(&reads);
        assert_eq!(
            reads.len(),
            1,
            "the counted incoming batch reads its clock once"
        );
        detached(&reads[0]);
    }
    {
        let heard = locked(&heard);
        let count = usize::try_from(incoming).expect("small count");
        assert_eq!(heard.rejected.len(), count);
        assert_eq!(heard.answered.len(), count);
        for (aborted, error) in &heard.rejected {
            assert!(
                *aborted,
                "its signal aborted before the awaiting resolver resumes"
            );
            assert!(
                matches!(error, CallError::Disconnected(reason) if reason == "the connection closed"),
                "closed, never cancelled: {error:?}"
            );
        }
        for answer in &heard.answered {
            assert!(
                matches!(answer, Err(CallError::Disconnected(reason)) if reason == "the connection closed")
            );
        }
        for signal in &heard.signals {
            assert_eq!(
                signal.reason(),
                Some(SignalReason::Disconnected(
                    "the connection closed".to_owned()
                ))
            );
        }
    }
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("closed again", Some(&Arc::from("a"))));
            assert!(state.reports.is_empty());
        })
        .await
        .expect("a second close");
    peer.settle().await;
    assert_eq!(
        peer.sent().await.len(),
        sent_before,
        "no answer, cancel or credit after closing"
    );
    let text = registry.exposition().text;
    for (family, kind) in [("server", "request"), ("client", "command")] {
        for suffix in [
            format!(
                "handled_total{{service=\"2\",procedure=\"echo\",type=\"{kind}\",outcome=\"closed\"}} {incoming}\n"
            ),
            format!(
                "duration_seconds_count{{service=\"2\",procedure=\"echo\",type=\"{kind}\"}} {incoming}\n"
            ),
        ] {
            assert!(
                text.contains(&format!("bead_{family}_call_{suffix}")),
                "{text}"
            );
        }
    }
    assert!(
        !text
            .lines()
            .any(|line| line.contains("outcome=\"cancelled\"") && !line.ends_with(" 0")),
        "{text}"
    );
    assert_eq!(peer.clock.dues(), Vec::<Duration>::new());
}

// debugging 9.7
#[tokio::test]
async fn detach_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_given_its_signal_and_fail_that_call_as_closed_never_as_a_cancel()
 {
    close_awaiting((true, 1)).await;
}

#[tokio::test]
async fn detach_every_transfer_of_a_closing_connection_before_counting_any_of_its_calls_two_incoming_calls_each_answering_as_a_transfer()
 {
    close_awaiting((false, 2)).await;
}
