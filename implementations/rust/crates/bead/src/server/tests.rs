//! The server's tests: its sessions kept on its router's owner, its gauges set against the
//! connections its transport holds, and the health they give.

use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::{HealthStatus, LayerGauges, ServerGauges, health_of, layer_gauges_of};
use crate::managers::sessions::SessionEvent;
use crate::router::types::{ConnectionHandle, Gauges};
use crate::session_token::SessionToken;
use crate::testing::pair::{Pair, PairOptions};

async fn pair() -> Pair {
    Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected")
}

#[tokio::test]
async fn keeps_a_session_per_connection_its_token_drawn_as_it_is_first_stored() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let mut session = sessions.create(Arc::clone(&pair.connection_handle));

    assert!(
        !sessions.has(Arc::clone(&pair.connection_handle)).await,
        "none until it is stored"
    );

    session.data = Some(json!({ "name": "ada" }));

    let stored = sessions.set(session).await.expect("stored");

    assert!(
        stored.session_token.is_some(),
        "its token drawn as it is stored"
    );
    assert!(
        sessions.has(Arc::clone(&pair.connection_handle)).await,
        "kept"
    );
    assert_eq!(
        sessions
            .get(Arc::clone(&pair.connection_handle))
            .await
            .and_then(|kept| kept.data),
        Some(json!({ "name": "ada" })),
        "what it holds"
    );
    assert_eq!(
        sessions.connection_handles().await,
        [Arc::clone(&pair.connection_handle)],
        "by its connection"
    );
    assert!(
        sessions.delete(Arc::clone(&pair.connection_handle)).await,
        "deleted"
    );
    assert!(
        !sessions.has(Arc::clone(&pair.connection_handle)).await,
        "no longer kept"
    );
    assert!(
        !sessions.delete(Arc::clone(&pair.connection_handle)).await,
        "none to delete again"
    );
}

#[tokio::test]
async fn gauges_each_layer_and_passes_a_server_that_keeps_nothing_it_should_not() {
    let pair = pair().await;
    let gauges = pair.server.gauges().await;

    assert_eq!(gauges.router.orphans, 0, "the router keeps no orphan");
    assert_eq!(
        pair.server.health().await.status,
        HealthStatus::Pass,
        "it passes"
    );
}

#[test]
fn sets_a_layer_s_gauges_against_the_connections_its_transport_holds() {
    let held: ConnectionHandle = Arc::from("type=MEMORY;ip=local;ordinal=1");
    let gone: ConnectionHandle = Arc::from("type=MEMORY;ip=local;ordinal=2");
    let gauges = Gauges {
        connection_handles: [Arc::clone(&held), gone].into_iter().collect(),
        ..Gauges::default()
    };

    assert_eq!(
        layer_gauges_of(gauges, &BTreeSet::from([held])).orphans,
        1,
        "the one its transport no longer holds"
    );
}

#[test]
fn warns_of_a_count_at_four_fifths_of_its_ceiling_and_fails_an_orphan_or_an_anomaly() {
    let layer = |(count, ceiling): (u64, u64)| LayerGauges {
        ceilings: BTreeMap::from([("transfers", ceiling)]),
        counts: BTreeMap::from([("transfers", count)]),
        ..LayerGauges::default()
    };
    let status_of = |router: LayerGauges| {
        health_of(&ServerGauges {
            router,
            ..ServerGauges::default()
        })
        .status
    };

    assert_eq!(
        status_of(layer((3, 4))),
        HealthStatus::Pass,
        "3 of 4 short of four fifths"
    );
    assert_eq!(
        status_of(layer((4, 5))),
        HealthStatus::Warn,
        "4 of 5 at four fifths"
    );
    assert_eq!(
        status_of(LayerGauges {
            orphans: 1,
            ..LayerGauges::default()
        }),
        HealthStatus::Fail,
        "an orphan fails"
    );

    let failed = health_of(&ServerGauges {
        sessions: LayerGauges {
            anomalies: vec!["a session of no connection".to_owned()],
            ..LayerGauges::default()
        },
        ..ServerGauges::default()
    });

    assert_eq!(failed.status, HealthStatus::Fail, "an anomaly fails");
    assert_eq!(
        failed
            .checks
            .get("sessions:anomalies")
            .and_then(|checks| checks.first())
            .and_then(|check| check.output.clone()),
        Some("a session of no connection".to_owned()),
        "said what it found"
    );
}

#[tokio::test]
async fn update_data_emits_nothing_for_equal_data() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let changed: Arc<Mutex<u32>> = Arc::default();
    let hearing = Arc::clone(&changed);

    sessions.on(Arc::new(move |event: &SessionEvent| {
        if matches!(event, SessionEvent::DataChanged(..)) {
            *hearing.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        }
    }));
    sessions
        .set(sessions.create(Arc::clone(&pair.connection_handle)))
        .await
        .expect("stored");

    // the TypeScript side compares data deep, the C# side by its equality; this side by a JSON
    // value's, which compares an object's members by name, whatever their order
    sessions
        .update_data((
            Arc::clone(&pair.connection_handle),
            Some(json!({ "name": "guest", "tags": ["a", "b"] })),
        ))
        .await;
    sessions
        .update_data((
            Arc::clone(&pair.connection_handle),
            Some(json!({ "tags": ["a", "b"], "name": "guest" })),
        ))
        .await;
    pair.settle().await;

    assert_eq!(
        *changed.lock().unwrap_or_else(PoisonError::into_inner),
        1,
        "changed once"
    );
}

#[tokio::test]
async fn count_the_sessions_and_the_connections_timed() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let handle = Arc::clone(&pair.connection_handle);
    let counts_of = |gauges: &Gauges| {
        (
            gauges.counts.get("sessions").copied(),
            gauges.counts.get("timedConnections").copied(),
        )
    };
    let mut timed = sessions.create(Arc::clone(&handle));

    timed.session_inactivity_timeout = Some(Duration::from_secs(1));
    sessions.set(timed).await.expect("stored");

    let gauges = sessions.gauges().await;

    assert!(gauges.anomalies.is_empty(), "no anomaly");
    assert!(gauges.ceilings.is_empty(), "no ceiling");
    assert_eq!(
        gauges.connection_handles,
        BTreeSet::from([Arc::clone(&handle)]),
        "its connection"
    );
    assert_eq!(counts_of(&gauges), (Some(1), Some(1)), "one, timed");
    assert!(sessions.delete(Arc::clone(&handle)).await, "deleted");

    let gauges = sessions.gauges().await;

    assert!(gauges.connection_handles.is_empty(), "no connection kept");
    assert_eq!(counts_of(&gauges), (Some(0), Some(0)), "none");

    // one stored with a token of its own, and no timeout, is timed as one drawn is
    let mut owning = sessions.create(Arc::clone(&handle));

    owning.session_token = Some(
        SessionToken::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
            .expect("a token of no zero alone"),
    );
    sessions.set(owning).await.expect("stored");

    assert_eq!(
        counts_of(&sessions.gauges().await),
        (Some(1), Some(1)),
        "one, timed"
    );
}
