//! A core's combined gauges and calls counted once, including an unreadable request's failed refusal.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::locked;
use super::router_core_sessions::{handler, receive, request};
use super::router_core_transfer_edges::serving;
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::router::core as router_core;
use crate::router::types::{RouterError, RouterLimitsOptions, TransportMessage};
use crate::testing::core_port::{Peer, State, completed, request_of};
use crate::testing::{hexadecimal, pair::echo};
use crate::transport::Sent;

fn registry() -> MetricsRegistry {
    MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry")
}

fn counts(registry: &MetricsRegistry) -> Vec<String> {
    let mut lines = registry
        .exposition()
        .text
        .lines()
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !line.contains("_bucket")
                && !line.ends_with(" 0")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    lines.sort();
    lines
}

#[tokio::test]
async fn count_what_its_pieces_hold_together_and_nothing_once_its_connections_went() {
    for dotnet in [false, true] {
        let (peer, _) = serving(false, &RouterLimitsOptions::default()).await;
        let mut options = request_of("a");
        options.options.timeout = core::time::Duration::from_secs(if dotnet { 5 } else { 1 });
        let waiting = peer.request((Bytes::new(), options));
        peer.owner
            .run(|state| {
                receive(state, (request(3, None), "b", None));
                let gauges = state.core.gauges().expect("the combined gauges");
                assert_eq!(gauges.anomalies, Vec::<String>::new());
                assert_eq!(
                    gauges.ceilings,
                    BTreeMap::from([
                        (
                            "bufferedBytes",
                            crate::router::types::LIMIT_DEFAULTS.buffered_bytes_budget
                        ),
                        ("largestAnsweringCalls", 64),
                    ])
                );
                assert_eq!(
                    gauges.connection_handles,
                    BTreeSet::from([Arc::from("a"), Arc::from("b")])
                );
                assert_eq!(
                    gauges.counts,
                    BTreeMap::from([
                        ("abandonedCalls", 0),
                        ("announced", 0),
                        ("answeringCalls", 1),
                        ("bufferedBytes", 0),
                        ("largestAnsweringCalls", 1),
                        ("pendingCalls", 1),
                        ("receivingTransfers", 0),
                        ("reservedCallIds", 0),
                        ("sendingTransfers", 0),
                    ])
                );
                router_core::reject_pending(state, ("all gone", None));
            })
            .await
            .expect("both connections counted, then closed");
        assert!(matches!(
            completed(waiting).await,
            Err(CallError::Disconnected(_))
        ));
        peer.owner
            .run(|state| {
                assert_eq!(
                    state
                        .core
                        .gauges()
                        .expect("the closed core's gauges")
                        .connection_handles,
                    BTreeSet::new()
                );
            })
            .await
            .expect("the core keeps no connection");
    }
}

#[tokio::test]
async fn count_a_call_that_carries_no_series_under_other_and_a_router_given_no_registry_counts_nothing()
 {
    for dotnet in [false, true] {
        let registry = registry();
        let metrics = registry.attach(RouterSide::Server);
        let declared = metrics.declare_requester(&echo()).expect("a named series");
        let counted = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        let uncounted = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        counted
            .owner
            .run(move |state| {
                state.core.metrics = Some(metrics);
            })
            .await
            .expect("the registry attached");
        uncounted
            .owner
            .run(|state| {
                assert!(
                    router_core::register_resolver(
                        &state.core.resolvers,
                        (
                            &echo(),
                            handler((&Arc::default(), &Arc::default())),
                            state.core.metrics.as_ref()
                        )
                    )
                    .expect("the resolver registered")
                    .is_none()
                );
            })
            .await
            .expect("an uncounted registration declares no series");
        let payload = if dotnet {
            Bytes::from_static(&[0])
        } else {
            Bytes::new()
        };
        let mut counted_options = request_of("a");
        if dotnet {
            counted_options.options.timeout = crate::duration::NEVER;
        }
        let asking = counted.request((payload.clone(), counted_options));
        let mut options = request_of("a");
        options.series = Some(declared);
        if dotnet {
            options.options.timeout = crate::duration::NEVER;
        }
        let uncounted_asking = uncounted.request((payload, options));
        counted.settle().await;
        uncounted.settle().await;
        assert_eq!(
            counts(&registry),
            [
                "bead_client_call_started_total{service=\"_OTHER\",procedure=\"_OTHER\",type=\"command\"} 1"
            ]
        );
        for (peer, waiting) in [(&counted, asking), (&uncounted, uncounted_asking)] {
            peer.owner
                .run(router_core::dispose)
                .await
                .expect("the waiting core disposed");
            assert!(matches!(
                completed(waiting).await,
                Err(CallError::Disconnected(_))
            ));
        }
    }
}

fn unreadable(state: &mut State) {
    router_core::receive(
        state,
        (
            TransportMessage {
                data: Bytes::from(
                    hexadecimal::bytes_of("A1 10 00 02 00 00 00 01")
                        .expect("a readable prefix without procedure fields"),
                ),
                ..TransportMessage::default()
            },
            &Arc::from("a"),
        ),
    );
}

#[tokio::test]
async fn counts_an_unreadable_request_once_when_its_refusal_transport_throws_or_rejects() {
    for is_thrown in [true, false] {
        let registry = registry();
        let metrics = registry.attach(RouterSide::Server);
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        let failure = Arc::new(std::io::Error::other("the refusal transport failed"));
        let refused: Arc<dyn std::error::Error + Send + Sync> = failure;
        let failed = Arc::clone(&refused);
        let recorded: Arc<Mutex<Vec<Envelope>>> = Arc::default();
        let sent = Arc::clone(&recorded);
        peer.owner
            .run(move |state| {
                state.core.metrics = Some(metrics);
                let error = RouterError::Other(failed);
                state.sending.push_back(if is_thrown {
                    Err(error)
                } else {
                    Ok(Sent::Later(Box::pin(async move { Err(error) })))
                });
                // The source's recorder is reached only after a synchronous throw has been ruled out.
                state.on_transmit = Some(Box::new(move |_, envelope| {
                    if !is_thrown {
                        locked(&sent).push(envelope.clone());
                    }
                }));
                unreadable(state);
            })
            .await
            .expect("the unreadable request refused through a failing transport");
        peer.settle().await;
        assert_eq!(locked(&recorded).len(), usize::from(!is_thrown));
        let reported = Arc::clone(&refused);
        peer.owner.run(move |state| {
            let matches = state.reports.iter().filter(|(handle, error)| {
                handle.as_ref() == "a" && matches!(error, RouterError::Other(error) if Arc::ptr_eq(error, &reported))
            }).count();
            assert_eq!(matches, 1);
            assert_eq!(state.core.gauges().expect("the gauges").counts.get("answeringCalls"), Some(&0));
        }).await.expect("the exact transport error reported once");
        let sent = Arc::clone(&recorded);
        peer.owner
            .run(move |state| {
                state.on_transmit = Some(Box::new(move |_, envelope| {
                    locked(&sent).push(envelope.clone());
                }));
                unreadable(state);
                assert_eq!(
                    state
                        .core
                        .gauges()
                        .expect("the gauges")
                        .counts
                        .get("answeringCalls"),
                    Some(&0)
                );
            })
            .await
            .expect("the same unreadable call refused through the restored transport");
        peer.settle().await;
        let sent = locked(&recorded).clone();
        assert_eq!(sent.len(), if is_thrown { 1 } else { 2 });
        let Envelope::Failure { header, failure } = sent.last().expect("the refusal sent") else {
            panic!("a failure");
        };
        assert_eq!(header.call_id, 1);
        assert_eq!(header.credential, None);
        assert_eq!(failure.relays, 0);
        assert_eq!(failure.code, ProtocolCode::ENVELOPE_MALFORMED.get());
        assert_eq!(failure.scope, FailureScope::Protocol);
        assert_eq!(
            failure.detail,
            "a 0x10 header of flags 0x00 is 12 bytes, not 8 of 8"
        );
        let mut expected = vec![
            "bead_server_call_duration_seconds_count{service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\"} 2".to_owned(),
            format!("bead_server_call_handled_total{{service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\",outcome=\"failure\",code=\"ENVELOPE_MALFORMED\"}} {}", if is_thrown { 1 } else { 2 }),
            "bead_server_call_started_total{service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\"} 2".to_owned(),
        ];
        if is_thrown {
            expected.push("bead_server_call_handled_total{service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\",outcome=\"error\"} 1".to_owned());
        }
        expected.sort();
        assert_eq!(counts(&registry), expected);
    }
}
