//! A closed connection returns the receiving budget to other connections before disposal.

use super::locked;
use super::router_core_requester::{credit, pattern, quiet};
use super::router_core_sending_edges::asked;
use super::router_core_sessions::receive;
use super::router_core_transfer_edges::{Outgoing, limits, narrow, opening, outgoing, serving};
use crate::constants::RouterSide;
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, request_of};
use bytes::Bytes;
use std::sync::Arc;

// spec 12.10
#[tokio::test]
async fn end_the_transfers_it_sends_on_a_connection_that_goes_and_on_a_router_disposed_sending_nothing_more()
 {
    let (peer, handed) = serving(false, &limits()).await;
    let asking = peer.request((pattern(200), request_of("b")));
    peer.settle().await;
    let answerer = asked(&peer, (&handed, Bytes::new())).await;
    let responding = answerer.respond(RouterAnswer::Result(pattern(150)));
    peer.settle().await;
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("gone", Some(&Arc::from("a"))));
        })
        .await
        .expect("the result's connection closes");
    peer.receive((credit(1, 150), Arc::from("a")));
    assert!(matches!(responding.await, Err(CallError::Disconnected(_))));
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    peer.receive((credit(2, 200), Arc::from("b")));
    assert!(matches!(
        completed(asking).await,
        Err(CallError::Disconnected(_))
    ));
    peer.settle().await;
    let sent = peer.sent().await;
    assert_eq!(sent.len(), 2, "no chunk follows either opening");
    assert!(
        matches!(&sent[0], (handle, Envelope::Request { header, payload })
        if handle.as_ref() == "b" && header.call_id == 2 && header.total == Some(200) && payload.len() == 44)
    );
    assert!(
        matches!(&sent[1], (handle, Envelope::Result { header, payload })
        if handle.as_ref() == "a" && header.call_id == 1 && header.total == Some(150) && payload.len() == 28)
    );
    quiet(&peer).await;

    for dispose in [false, true] {
        let peer = Peer::new(RouterSide::Client, &limits());
        let asking = peer.request((pattern(300), request_of("a")));
        peer.owner
            .run(move |state| {
                if dispose {
                    router_core::dispose(state);
                } else {
                    router_core::reject_pending(
                        state,
                        ("the connection closed", Some(&Arc::from("a"))),
                    );
                }
            })
            .await
            .expect("the pending transfer ends");
        assert!(matches!(
            completed(asking).await,
            Err(CallError::Disconnected(_))
        ));
        peer.receive((credit(1, 300), Arc::from("a")));
        peer.settle().await;
        let sent = peer.sent().await;
        assert_eq!(sent.len(), 1, "a late credit sends no chunk");
        assert!(
            matches!(&sent[0], (handle, Envelope::Request { header, payload })
            if handle.as_ref() == "a" && header.call_id == 1 && header.total == Some(300) && payload.len() == 44)
        );
        quiet(&peer).await;
        peer.owner
            .run(router_core::dispose)
            .await
            .expect("disposed");
    }
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn end_the_transfers_of_a_connection_that_goes_before_their_budget_grants_any_credit_and_send_nothing_once_disposed()
 {
    let (peer, handed) = serving(false, &narrow()).await;
    peer.owner
        .run(|state| {
            for (id, handle, length, total) in
                [(1, "a", 40, 168), (3, "a", 16, 100), (1, "b", 16, 100)]
            {
                receive(
                    state,
                    (
                        opening(id, (Bytes::from(vec![0; length]), total)),
                        handle,
                        None,
                    ),
                );
            }
            router_core::reject_pending(state, ("gone", Some(&Arc::from("a"))));
            receive(
                state,
                (opening(3, (Bytes::from(vec![0; 44]), 200)), "b", None),
            );
            router_core::dispose(state);
        })
        .await
        .expect("the starved transfers released");
    peer.settle().await;
    assert_eq!(
        outgoing(&peer).await,
        [
            ("a".to_owned(), Outgoing::Credit(1, 168)),
            ("b".to_owned(), Outgoing::Credit(1, 100))
        ]
    );
    peer.owner
        .run(|state| assert!(state.reports.is_empty(), "{:?}", state.reports))
        .await
        .expect("no report");
    assert!(locked(&handed).is_empty());

    let (same, handed) = serving(
        false,
        &RouterLimitsOptions {
            buffered_bytes_budget: Some(256),
            maximum_payload_bytes: Some(256),
            ..limits()
        },
    )
    .await;
    same.owner
        .run(|state| {
            for id in [1, 3] {
                receive(
                    state,
                    (opening(id, (pattern(200).slice(..44), 200)), "a", None),
                );
            }
            router_core::reject_pending(state, ("the connection closed", Some(&Arc::from("a"))));
        })
        .await
        .expect("both transfers of the connection removed");
    assert_eq!(
        outgoing(&same).await,
        [("a".to_owned(), Outgoing::Credit(1, 172))]
    );
    same.owner
        .run(|state| {
            router_core::dispose(state);
            receive(
                state,
                (opening(5, (pattern(200).slice(..44), 200)), "a", None),
            );
        })
        .await
        .expect("a disposed router takes nothing");
    assert_eq!(
        outgoing(&same).await,
        [("a".to_owned(), Outgoing::Credit(1, 172))]
    );
    assert!(locked(&handed).is_empty());
}
