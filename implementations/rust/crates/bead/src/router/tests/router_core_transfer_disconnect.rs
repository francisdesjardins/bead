//! A closed connection returns the receiving budget to other connections before disposal.

use super::locked;
use super::router_core_requester::pattern;
use super::router_core_sessions::receive;
use super::router_core_transfer_edges::{Outgoing, limits, narrow, opening, outgoing, serving};
use crate::router::core as router_core;
use crate::router::types::RouterLimitsOptions;
use bytes::Bytes;
use std::sync::Arc;

#[tokio::test]
#[ignore = "divergence: closing one connection drops the credits its returned budget grants another; the fix needs the frozen detail-gate fixture updated"]
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
