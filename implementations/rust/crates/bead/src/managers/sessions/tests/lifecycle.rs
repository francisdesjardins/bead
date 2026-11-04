//! Complete session-token, event and orphan-timer gauge scenarios from the other sides.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;

use super::{FIRST, SECOND, Session, SessionEvent, SessionManager, handle, milliseconds, token_of};
use crate::managers::sessions::Timers;
use crate::router::types::Gauges;

#[test]
fn draws_a_token_for_a_session_without_one_anew_each_time_and_keeps_one_given() {
    let mut sessions = SessionManager::new();
    let first = sessions.stored(Session {
        data: Some(json!("ada")),
        ..SessionManager::create(FIRST)
    });
    let kept = sessions.stored(Session {
        data: Some(json!("bob")),
        ..first.clone()
    });
    let drawn = sessions.stored(Session {
        data: Some(json!("eve")),
        ..SessionManager::create(FIRST)
    });
    assert!(first.session_token.is_some());
    assert_eq!(first.session_token, kept.session_token);
    assert_ne!(first.session_token, drawn.session_token);
    assert_eq!(
        sessions.manager.token_of(&handle(FIRST)),
        drawn.session_token
    );
    assert_eq!(sessions.manager.all(), [drawn]);
    assert_eq!(sessions.manager.connection_handles(), [handle(FIRST)]);
}

#[test]
fn says_what_it_created_updated_changed_and_deleted() {
    let mut sessions = SessionManager::new();
    let first = sessions.stored(Session {
        data: Some(json!("ada")),
        ..SessionManager::create(FIRST)
    });
    sessions.stored(first.clone());
    let changed = sessions
        .manager
        .update_data((&handle(FIRST), Some(json!("bob"))), &mut sessions.told)
        .expect("a stored session");
    let replaced = sessions.stored(Session {
        data: Some(json!("eve")),
        ..SessionManager::create(FIRST)
    });
    assert!(sessions.manager.delete(&handle(FIRST), &mut sessions.told));
    assert!(!sessions.manager.delete(&handle(FIRST), &mut sessions.told));
    assert_eq!(
        sessions.taken(),
        [
            SessionEvent::Created(first),
            SessionEvent::DataChanged {
                session: changed,
                new_value: Some(json!("bob")),
                old_value: Some(json!("ada")),
            },
            SessionEvent::Updated(replaced.clone()),
            SessionEvent::Deleted(replaced),
        ]
    );
}

#[test]
fn count_the_sessions_and_the_connections_timed_and_tell_timers_kept_with_no_session() {
    let mut sessions = SessionManager::new();
    sessions.stored(Session {
        session_inactivity_timeout: Some(milliseconds(1_000)),
        ..SessionManager::create(FIRST)
    });
    let mut expected = Gauges {
        anomalies: Vec::new(),
        ceilings: BTreeMap::new(),
        connection_handles: BTreeSet::from([handle(FIRST)]),
        counts: BTreeMap::from([("sessions", 1), ("timedConnections", 1)]),
    };
    assert_eq!(sessions.manager.gauges().expect("gauges"), expected);
    let timers = Timers::arm(
        &sessions.arming,
        (&handle(SECOND), (Some(milliseconds(1_000)), None)),
    )
    .expect("an orphan timer armed");
    sessions.manager.timers.insert(handle(SECOND), timers);
    expected.anomalies = vec!["1 connections keep timers with no session".to_owned()];
    expected.connection_handles.insert(handle(SECOND));
    expected.counts.insert("timedConnections", 2);
    assert_eq!(sessions.manager.gauges().expect("gauges"), expected);
    sessions
        .manager
        .timers
        .remove(&handle(SECOND))
        .expect("the orphan")
        .clear();
    assert!(sessions.manager.delete(&handle(FIRST), &mut sessions.told));
    expected.anomalies.clear();
    expected.connection_handles.clear();
    expected.counts = BTreeMap::from([("sessions", 0), ("timedConnections", 0)]);
    assert_eq!(sessions.manager.gauges().expect("gauges"), expected);
    sessions.stored(Session {
        session_token: Some(token_of(7)),
        ..SessionManager::create(SECOND)
    });
    expected.connection_handles.insert(handle(SECOND));
    expected.counts = BTreeMap::from([("sessions", 1), ("timedConnections", 1)]);
    assert_eq!(sessions.manager.gauges().expect("gauges"), expected);
    assert_eq!(sessions.arming.live(), []);
}
