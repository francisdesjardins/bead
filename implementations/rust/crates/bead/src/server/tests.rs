//! The server's tests: its sessions kept on its router's owner, its gauges set against the
//! connections its transport holds, and the health they give.

use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::{HealthCheck, HealthStatus, LayerGauges, ServerGauges, health_of, layer_gauges_of};
use crate::managers::sessions::SessionEvent;
use crate::router::types::{ConnectionHandle, Gauges};
use crate::session_token::SessionToken;
use crate::testing::pair::{Pair, PairOptions};

mod facade;

async fn pair() -> Pair {
    Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions::default(),
    )
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

    let stored = sessions
        .set(session)
        .expect("taken as it is made")
        .await
        .expect("stored");

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
    let gauges = pair.server.gauges().await.expect("distinct counts");

    assert_eq!(gauges.router.orphans, 0, "the router keeps no orphan");
    assert_eq!(
        pair.server.health().await.expect("distinct counts").status,
        HealthStatus::Pass,
        "it passes"
    );
}

// the twins of `health.test.ts` and `HealthTests`
#[test]
fn keeps_a_layer_s_counts_ceilings_and_anomalies_and_counts_as_orphans_the_connections_held_nowhere_else()
 {
    let handle = |name: &str| -> ConnectionHandle { Arc::from(name) };
    let gauges = Gauges {
        anomalies: vec!["odd".to_owned()],
        ceilings: BTreeMap::from([("calls", 4)]),
        connection_handles: ["a", "b", "c"].map(handle).into_iter().collect(),
        counts: BTreeMap::from([("calls", 3)]),
    };

    assert_eq!(
        layer_gauges_of(gauges, &BTreeSet::from([handle("a")])),
        LayerGauges {
            anomalies: vec!["odd".to_owned()],
            ceilings: BTreeMap::from([("calls", 4)]),
            counts: BTreeMap::from([("calls", 3)]),
            orphans: 2,
        },
        "its counts, its ceilings, its anomalies, and its orphans, no handle among them"
    );
}

// a check of `observed`, saying `output` where it says something
fn check_of(
    (observed_value, status): (u64, HealthStatus),
    output: Option<&str>,
) -> Vec<HealthCheck> {
    vec![HealthCheck {
        observed_value,
        output: output.map(str::to_owned),
        status,
    }]
}

#[test]
fn passes_a_server_with_no_orphan_no_anomaly_and_each_count_under_its_ceiling() {
    let health = health_of(&ServerGauges {
        transport: LayerGauges {
            ceilings: BTreeMap::from([("connections", 10)]),
            counts: BTreeMap::from([("connections", 7), ("listens", 3)]),
            ..LayerGauges::default()
        },
        ..ServerGauges::default()
    });
    let quiet = check_of((0, HealthStatus::Pass), None);
    let mut checks: BTreeMap<String, Vec<HealthCheck>> =
        ["router", "server", "sessions", "transport"]
            .into_iter()
            .flat_map(|layer| {
                [
                    (format!("{layer}:anomalies"), quiet.clone()),
                    (format!("{layer}:orphans"), quiet.clone()),
                ]
            })
            .collect();

    checks.insert(
        "transport:connections".to_owned(),
        check_of((7, HealthStatus::Pass), Some("7 of 10")),
    );
    assert_eq!(health.checks, checks, "each check");
    assert_eq!(health.status, HealthStatus::Pass, "passed");
}

#[test]
fn warns_of_a_count_from_its_warning_share_of_its_ceiling_and_fails_an_orphan_or_an_anomaly_the_worst_standing()
 {
    let connections = |count: u64| LayerGauges {
        ceilings: BTreeMap::from([("connections", 10)]),
        counts: BTreeMap::from([("connections", count)]),
        ..LayerGauges::default()
    };
    let near = health_of(&ServerGauges {
        transport: connections(8),
        ..ServerGauges::default()
    });

    assert_eq!(
        (
            near.status,
            near.checks.get("transport:connections").cloned()
        ),
        (
            HealthStatus::Warn,
            Some(check_of((8, HealthStatus::Warn), Some("8 of 10")))
        ),
        "a count at its warning share"
    );
    assert!(
        (super::WARNING_RATIO - 0.8).abs() < f64::EPSILON,
        "four fifths"
    );

    let failing = health_of(&ServerGauges {
        router: LayerGauges {
            orphans: 2,
            ..LayerGauges::default()
        },
        sessions: LayerGauges {
            anomalies: vec!["one".to_owned(), "two".to_owned()],
            ..LayerGauges::default()
        },
        transport: connections(9),
        ..ServerGauges::default()
    });

    assert_eq!(failing.status, HealthStatus::Fail, "the worst standing");
    assert_eq!(
        (
            failing.checks.get("router:orphans").cloned(),
            failing.checks.get("sessions:anomalies").cloned()
        ),
        (
            Some(check_of(
                (2, HealthStatus::Fail),
                Some("2 connections kept that the transport no longer holds")
            )),
            Some(check_of((2, HealthStatus::Fail), Some("one; two")))
        ),
        "an orphan and an anomaly fail"
    );
    // a warning after a failure leaves it the worst
    assert_eq!(
        health_of(&ServerGauges {
            router: LayerGauges {
                orphans: 1,
                ..LayerGauges::default()
            },
            transport: LayerGauges {
                ceilings: BTreeMap::from([("connections", 1)]),
                counts: BTreeMap::from([("connections", 1)]),
                ..LayerGauges::default()
            },
            ..ServerGauges::default()
        })
        .status,
        HealthStatus::Fail,
        "the failure standing"
    );
}

#[tokio::test]
async fn update_data_emits_nothing_for_equal_data() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let changed: Arc<Mutex<u32>> = Arc::default();
    let hearing = Arc::clone(&changed);

    sessions.on(Arc::new(move |event: &SessionEvent| {
        if matches!(event, SessionEvent::DataChanged { .. }) {
            *hearing.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        }
    }));
    sessions
        .set(sessions.create(Arc::clone(&pair.connection_handle)))
        .expect("taken as it is made")
        .await
        .expect("stored");

    // the TypeScript side compares data deep, the C# side by its equality; this side by a JSON
    // value's, which compares an object's members by name, whatever their order
    sessions
        .update_data({
            let mut session = sessions.create(Arc::clone(&pair.connection_handle));

            session.data = Some(json!({ "name": "guest", "tags": ["a", "b"] }));
            session
        })
        .await;
    sessions
        .update_data({
            let mut session = sessions.create(Arc::clone(&pair.connection_handle));

            session.data = Some(json!({ "tags": ["a", "b"], "name": "guest" }));
            session
        })
        .await;
    pair.settle().await;

    assert_eq!(
        *changed.lock().unwrap_or_else(PoisonError::into_inner),
        1,
        "changed once"
    );
}

// the Rust side's own: a listener taken off by the id its `on` gave hears nothing more, the others
// still hear, and an id taken off already changes nothing
#[tokio::test]
async fn off_takes_off_the_listener_its_id_names_and_no_other() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let handle = Arc::clone(&pair.connection_handle);
    let heard: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let listener_of = |name: &'static str| {
        let hearing = Arc::clone(&heard);

        Arc::new(move |event: &SessionEvent| {
            if matches!(event, SessionEvent::DataChanged { .. }) {
                hearing
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(name);
            }
        })
    };
    let taken = sessions.on(listener_of("taken"));

    sessions.on(listener_of("kept"));
    sessions
        .set(sessions.create(Arc::clone(&handle)))
        .expect("taken as it is made")
        .await
        .expect("stored");
    sessions
        .update_data({
            let mut session = sessions.create(Arc::clone(&handle));

            session.data = Some(json!({ "step": 1 }));
            session
        })
        .await;
    pair.settle().await;

    assert_eq!(
        *heard.lock().unwrap_or_else(PoisonError::into_inner),
        ["taken", "kept"],
        "both heard"
    );

    sessions.off(taken);
    sessions.off(taken);
    sessions
        .update_data({
            let mut session = sessions.create(Arc::clone(&handle));

            session.data = Some(json!({ "step": 2 }));
            session
        })
        .await;
    pair.settle().await;

    assert_eq!(
        *heard.lock().unwrap_or_else(PoisonError::into_inner),
        ["taken", "kept", "kept"],
        "the one taken off hears nothing more, the other still hears"
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
    sessions
        .set(timed)
        .expect("taken as it is made")
        .await
        .expect("stored");

    let gauges = sessions.gauges().await.expect("distinct counts");

    assert!(gauges.anomalies.is_empty(), "no anomaly");
    assert!(gauges.ceilings.is_empty(), "no ceiling");
    assert_eq!(
        gauges.connection_handles,
        BTreeSet::from([Arc::clone(&handle)]),
        "its connection"
    );
    assert_eq!(counts_of(&gauges), (Some(1), Some(1)), "one, timed");
    assert!(sessions.delete(Arc::clone(&handle)).await, "deleted");

    let gauges = sessions.gauges().await.expect("distinct counts");

    assert!(gauges.connection_handles.is_empty(), "no connection kept");
    assert_eq!(counts_of(&gauges), (Some(0), Some(0)), "none");

    // one stored with a token of its own, and no timeout, is timed as one drawn is
    let mut owning = sessions.create(Arc::clone(&handle));

    owning.session_token = Some(
        SessionToken::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
            .expect("a token of no zero alone"),
    );
    sessions
        .set(owning)
        .expect("taken as it is made")
        .await
        .expect("stored");

    assert_eq!(
        counts_of(&sessions.gauges().await.expect("distinct counts")),
        (Some(1), Some(1)),
        "one, timed"
    );
}

// decision 0044: what an operation refuses as it is made is its Err at once, as both other sides
// throw it as `set` is called, before anything is stored
#[tokio::test]
async fn set_refuses_a_timeout_spec_1_4_does_not_hold_as_it_is_made_and_stores_nothing() {
    let pair = pair().await;
    let sessions = pair.server.sessions();
    let handle = Arc::clone(&pair.connection_handle);

    for (connection, session) in [
        (Some(Duration::ZERO), None),
        (None, Some(Duration::from_millis(2_147_483_648))),
    ] {
        let mut refused = sessions.create(Arc::clone(&handle));

        refused.connection_inactivity_timeout = connection;
        refused.session_inactivity_timeout = session;

        let Err(error) = sessions.set(refused) else {
            panic!("refused as it is made: {connection:?} {session:?}");
        };

        assert!(
            error
                .message()
                .starts_with("an inactivity timeout is a duration of whole milliseconds"),
            "said why: {error}"
        );
    }

    pair.settle().await;

    assert!(
        !sessions.has(Arc::clone(&handle)).await,
        "nothing stored, its future never made"
    );
    sessions
        .set(sessions.create(Arc::clone(&handle)))
        .expect("a sound session taken as it is made")
        .await
        .expect("stored");
    assert!(sessions.has(handle).await, "a sound one stored");
}
