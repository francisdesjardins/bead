//! A connection's session announcement: its answers, restoration, forgetting and counts.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use bytes::Bytes;

use super::{failure_of, result_of, token};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope};
use crate::router::core::{self as router_core, Deliver};
use crate::router::parts::{Announced, Announcements};
use crate::router::types::{CallAddress, RouterAnswer, RouterLimitsOptions};
use crate::session_token::SessionToken;
use crate::testing::core_port::{Peer, completed, scripted_header};

fn announce(
    calls: &mut Announcements,
    (handle, current): (&str, SessionToken),
) -> (Credential, Announced) {
    calls
        .announce((&Arc::from(handle), Some(current)))
        .expect("the session changes")
}

async fn send(peer: &Peer, (envelope, handle): (Envelope, &str)) -> Option<Credential> {
    let handle: Arc<str> = Arc::from(handle);
    peer.owner
        .run(move |state| {
            router_core::deliver(state, (envelope, Deliver::to(&handle)));
        })
        .await
        .expect("the envelope delivered");
    peer.settle().await;
    peer.owner
        .run(|state| {
            assert!(state.reports.is_empty(), "{:?}", state.reports);
            state
                .sent
                .last()
                .expect("the envelope sent")
                .1
                .header()
                .credential()
                .cloned()
        })
        .await
        .expect("the announcement read")
}

async fn session(peer: &Peer, current: Option<SessionToken>) {
    peer.owner
        .run(move |state| {
            for handle in ["a", "b"] {
                if let Some(token) = current {
                    state.tokens.insert(Arc::from(handle), token);
                } else {
                    state.tokens.remove(handle);
                }
            }
        })
        .await
        .expect("the session set");
}

// spec 13.4
#[tokio::test]
async fn an_answer_carries_the_session_when_it_changed_a_result_or_a_failure_alike() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    session(&peer, Some(token())).await;
    assert_eq!(
        send(&peer, (result_of(1, None), "a")).await,
        Some(Credential::Opaque(token()))
    );
    assert_eq!(
        send(
            &peer,
            (failure_of(3, (ProtocolCode::ACCESS_DENIED, None)), "a")
        )
        .await,
        None
    );
    assert_eq!(
        send(&peer, (result_of(5, None), "b")).await,
        Some(Credential::Opaque(token()))
    );
    session(&peer, None).await;
    assert_eq!(
        send(
            &peer,
            (failure_of(7, (ProtocolCode::ACCESS_DENIED, None)), "a")
        )
        .await,
        Some(Credential::None)
    );
    assert_eq!(send(&peer, (result_of(9, None), "a")).await, None);
    assert_eq!(
        peer.sent().await,
        [
            (
                Arc::from("a"),
                result_of(1, Some(Credential::Opaque(token())))
            ),
            (
                Arc::from("a"),
                failure_of(3, (ProtocolCode::ACCESS_DENIED, None))
            ),
            (
                Arc::from("b"),
                result_of(5, Some(Credential::Opaque(token())))
            ),
            (
                Arc::from("a"),
                failure_of(7, (ProtocolCode::ACCESS_DENIED, Some(Credential::None)))
            ),
            (Arc::from("a"), result_of(9, None)),
        ]
    );
}

// spec 13.4
#[tokio::test]
async fn a_connection_never_told_of_a_session_hears_nothing_of_none_and_nothing_but_an_answer_says_one()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    assert_eq!(send(&peer, (result_of(1, None), "a")).await, None);
    session(&peer, Some(token())).await;
    let request = Envelope::Request {
        header: scripted_header(2),
        payload: Bytes::new(),
    };
    peer.owner
        .run(|state| {
            state.token = Some(Box::new(|_| {
                panic!("a request never asks for a session announcement")
            }));
        })
        .await
        .expect("the request must skip the provider");
    assert_eq!(send(&peer, (request.clone(), "a")).await, None);
    assert_eq!(peer.sent().await.last(), Some(&(Arc::from("a"), request)));
    peer.owner
        .run(|state| state.token = None)
        .await
        .expect("the session provider restored");
    assert_eq!(
        send(&peer, (result_of(3, None), "a")).await,
        Some(Credential::Opaque(token()))
    );
}

// spec 13.4
#[tokio::test]
async fn announce_nothing_without_a_session_to_ask_for() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let result = result_of(1, None);
    assert_eq!(send(&peer, (result.clone(), "a")).await, None);
    assert_eq!(peer.sent().await, [(Arc::from("a"), result)]);
    peer.owner
        .run(|state| {
            assert!(state.token.is_none());
            assert!(state.tokens.is_empty());
            assert_eq!(
                state.core.announcements.gauges().counts,
                BTreeMap::from([("announced", 0)])
            );
        })
        .await
        .expect("no session or announcement held");
}

// spec 13.4
#[test]
fn restore_undoes_an_announcement_unless_another_was_recorded_since_or_the_connection_forgotten() {
    let mut calls = Announcements::default();
    let other: SessionToken = "DwAOAQ0CDAMLBAoFCQYIBw".parse().expect("the other session");
    let (_, initial) = announce(&mut calls, ("a", token()));
    calls.restore(initial);
    let (credential, first) = announce(&mut calls, ("a", token()));
    assert_eq!(credential, Credential::Opaque(token()));
    let (_, second) = announce(&mut calls, ("a", other));
    calls.restore(first);
    calls.restore(second);
    assert!(calls.announce((&Arc::from("a"), Some(token()))).is_none());
    let (_, forgotten) = announce(&mut calls, ("a", other));
    calls.forget(Some(&Arc::from("a")));
    calls.restore(forgotten);
    assert_eq!(
        announce(&mut calls, ("a", other)).0,
        Credential::Opaque(other)
    );
}

// spec 13.4
#[test]
fn forget_what_a_connection_was_told_or_every_connection() {
    let mut calls = Announcements::default();
    announce(&mut calls, ("a", token()));
    announce(&mut calls, ("b", token()));
    calls.forget(Some(&Arc::from("a")));
    assert_eq!(
        announce(&mut calls, ("a", token())).0,
        Credential::Opaque(token())
    );
    assert!(calls.announce((&Arc::from("b"), Some(token()))).is_none());
    calls.forget(None);
    assert_eq!(
        announce(&mut calls, ("a", token())).0,
        Credential::Opaque(token())
    );
    assert_eq!(
        announce(&mut calls, ("b", token())).0,
        Credential::Opaque(token())
    );
}

// spec 13.4
#[tokio::test]
async fn counts_the_connections_told_of_a_session_until_each_is_forgotten() {
    let mut calls = Announcements::default();
    announce(&mut calls, ("a", token()));
    announce(&mut calls, ("b", token()));
    let gauges = calls.gauges();
    assert_eq!(
        gauges.connection_handles,
        BTreeSet::from([Arc::from("a"), Arc::from("b")])
    );
    assert_eq!(gauges.counts, BTreeMap::from([("announced", 2)]));
    calls.forget(Some(&Arc::from("a")));
    assert_eq!(calls.gauges().counts, BTreeMap::from([("announced", 1)]));

    // The core's combined snapshot includes the announcement, until the connection goes.
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    session(&peer, Some(token())).await;
    for (call_id, handle) in [(1, "a"), (3, "b")] {
        completed(peer.respond((
            RouterAnswer::Result(Bytes::new()),
            CallAddress {
                call_id,
                connection_handle: Arc::from(handle),
            },
        )))
        .await
        .expect("the core answers");
    }
    peer.owner
        .run(|state| {
            let gauges = state.core.gauges().expect("the core's gauges combine");
            assert_eq!(
                gauges.connection_handles,
                BTreeSet::from([Arc::from("a"), Arc::from("b")])
            );
            assert_eq!(gauges.counts.get("announced"), Some(&2));
            router_core::reject_pending(state, ("gone", Some(&Arc::from("a"))));
            assert_eq!(
                state
                    .core
                    .gauges()
                    .expect("the core's gauges combine")
                    .counts
                    .get("announced"),
                Some(&1)
            );
        })
        .await
        .expect("the core's counts follow the connection");
}
