//! A cancelled request leaves before its resolver hears the signal or attempts its last answer.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::locked;
use super::router_core_sessions::{handler, request};
use crate::constants::RouterSide;
use crate::envelope::{CancelHeader, Envelope};
use crate::errors::ResolverError;
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, RouterLimitsOptions, SignalReason};
use crate::testing::core_port::{Peer, completed};
use crate::testing::pair::echo;

#[tokio::test]
async fn forget_a_call_its_requester_cancels_then_abort_its_signal_nothing_answers_it_and_its_call_id_is_free()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let signals = Arc::new(Mutex::new(Vec::new()));
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let keeping = Arc::clone(&signals);
    let hearing = Arc::clone(&reasons);
    let (finished, stopped) = oneshot::channel();
    let finished = Mutex::new(Some(finished));
    let mut resolver = handler((&Arc::default(), &Arc::default()));
    resolver.resolve = Arc::new(move |props| {
        locked(&keeping).push((props.header.call_id, props.signal.clone()));
        let hearing = Arc::clone(&hearing);
        let finished = locked(&finished).take();
        Box::pin(async move {
            props.signal.token().cancelled().await;
            locked(&hearing).push(props.signal.reason());
            let outcome = props
                .answerer
                .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
                .await;
            if let Some(finished) = finished {
                finished.send(outcome).ok();
            }
            Err(ResolverError::other(std::io::Error::other("stopped")))
        })
    });
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), resolver, None))
                .expect("the cancellable resolver");
        })
        .await
        .expect("the resolver installed");
    peer.receive((request(5, None), Arc::from("a")));
    peer.settle().await;
    assert_eq!(locked(&signals).len(), 1);
    peer.receive((
        Envelope::Cancel {
            header: CancelHeader { call_id: 5 },
        },
        Arc::from("a"),
    ));
    completed(stopped)
        .await
        .expect("an answer from the cancelled resolver sends nothing");
    peer.receive((request(5, None), Arc::from("a")));
    peer.settle().await;

    assert_eq!(
        locked(&signals)
            .iter()
            .map(|(call_id, signal)| (*call_id, signal.reason()))
            .collect::<Vec<_>>(),
        [(5, Some(SignalReason::Cancelled)), (5, None)]
    );
    assert_eq!(*locked(&reasons), [Some(SignalReason::Cancelled)]);
    peer.owner
        .run(|state| {
            assert_eq!(state.cancels, [(5, Arc::from("a"))]);
            assert_eq!(state.sent, []);
            assert!(state.reports.is_empty());
            router_core::dispose(state);
        })
        .await
        .expect("the callback and its failure answer no call and report nothing");
}
