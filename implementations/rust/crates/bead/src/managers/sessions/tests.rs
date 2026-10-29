//! The session manager's tests (spec 11): a session per connection under a token of its own, what
//! it tells as each changes, and its two timers kept in step with the timeouts it stores, armed
//! through an arming that records them.

use core::sync::atomic::{AtomicBool, Ordering};
use core::time::Duration;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use super::{Arming, Inactivity, Session, SessionEvent, SessionManager, SessionManagerOptions};
use crate::clock::{SharedClock, Timer};
use crate::duration::{LONGEST_TIMER, NEVER};
use crate::errors::CallError;
use crate::router::types::ConnectionHandle;
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::testing::pair::{Pair, PairOptions};

const FIRST: &str = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
const SECOND: &str = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";
const UNKNOWN: &str = "type=WS;ip=127.0.0.1;port=1;ordinal=1";

// 2026-01-01T00:00:00Z, in milliseconds since the epoch
const NEW_YEAR: i64 = 1_767_225_600_000;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn handle(text: &str) -> ConnectionHandle {
    Arc::from(text)
}

fn token_of(byte: u8) -> SessionToken {
    SessionToken::new([byte; 16]).expect("a token")
}

fn milliseconds(count: u64) -> Duration {
    Duration::from_millis(count)
}

// a clock stepped by hand, at 2026-01-01T00:00:00Z
fn stepping() -> SharedClock {
    SteppingClock::new(crate::testing::instants::new_year())
}

// a timer the arming made: its due, which of a session's timers it is, and whether it was stopped
#[derive(Debug)]
struct Armed {
    due: Duration,
    inactivity: Inactivity,
    connection_handle: ConnectionHandle,
    is_cancelled: AtomicBool,
}

impl Timer for Armed {
    fn cancel(&self) {
        self.is_cancelled.store(true, Ordering::SeqCst);
    }
}

// what arms a session's timers: each recorded, none ever fires of itself
#[derive(Debug, Default)]
struct Recorder {
    armed: Mutex<Vec<Arc<Armed>>>,
}

impl Arming for Recorder {
    fn arm(
        &self,
        due: Duration,
        (inactivity, connection_handle): (Inactivity, ConnectionHandle),
    ) -> Arc<dyn Timer> {
        let armed = Arc::new(Armed {
            due,
            inactivity,
            connection_handle,
            is_cancelled: AtomicBool::new(false),
        });

        locked(&self.armed).push(Arc::clone(&armed));

        armed
    }
}

impl Recorder {
    // the due of every timer armed, stopped or not, in order
    fn dues(&self) -> Vec<Duration> {
        locked(&self.armed).iter().map(|armed| armed.due).collect()
    }

    // the timers still going, each its due, its kind and its connection
    fn live(&self) -> Vec<(Duration, Inactivity, String)> {
        locked(&self.armed)
            .iter()
            .filter(|armed| !armed.is_cancelled.load(Ordering::SeqCst))
            .map(|armed| {
                (
                    armed.due,
                    armed.inactivity,
                    armed.connection_handle.to_string(),
                )
            })
            .collect()
    }
}

// a manager, what it arms, and what it tells
struct Sessions {
    manager: SessionManager,
    arming: Recorder,
    told: Vec<SessionEvent>,
}

impl Sessions {
    fn new() -> Self {
        Self::of(&SessionManagerOptions::default())
    }

    // a manager on a clock stepped by hand, unless its options give one
    fn of(options: &SessionManagerOptions) -> Self {
        let clock = options.clock.clone().unwrap_or_else(stepping);

        Self {
            manager: SessionManager::new(&SessionManagerOptions {
                clock: Some(clock),
                ..options.clone()
            })
            .expect("a manager"),
            arming: Recorder::default(),
            told: Vec::new(),
        }
    }

    fn create(connection: &str) -> Session {
        Session::new(handle(connection), NEW_YEAR)
    }

    fn set(&mut self, session: Session) -> Result<Session, CallError> {
        self.manager.set(session, (&self.arming, &mut self.told))
    }

    fn stored(&mut self, session: Session) -> Session {
        self.set(session).expect("stored")
    }

    // the session of a connection, stored once when it has none
    fn get_or_else_set(&mut self, connection: &str) -> Session {
        self.manager
            .get_or_else_set(&handle(connection), (&self.arming, &mut self.told))
            .expect("stored")
    }

    fn connection_timeout(&mut self, (connection, timeout): (&str, Option<Duration>)) -> Session {
        self.manager
            .update_connection_inactivity_timeout(
                (&handle(connection), timeout),
                (&self.arming, &mut self.told),
            )
            .expect("held")
            .expect("a session")
    }

    fn session_timeout(&mut self, (connection, timeout): (&str, Option<Duration>)) -> Session {
        self.manager
            .update_session_inactivity_timeout(
                (&handle(connection), timeout),
                (&self.arming, &mut self.told),
            )
            .expect("held")
            .expect("a session")
    }

    fn touch(&mut self, (connection, now): (&str, i64)) -> Option<Session> {
        self.manager
            .touch((&handle(connection), now), (&self.arming, &mut self.told))
    }

    fn tokens_of_both(&self) -> [Option<SessionToken>; 2] {
        [
            self.manager.token_of(&handle(FIRST)),
            self.manager.token_of(&handle(SECOND)),
        ]
    }

    fn taken(&mut self) -> Vec<SessionEvent> {
        core::mem::take(&mut self.told)
    }
}

#[test]
fn create_makes_a_session_without_storing_it_no_token_no_timeout_no_data() {
    let sessions = Sessions::new();
    let session = Sessions::create(FIRST);

    assert_eq!(
        session,
        Session {
            connection_handle: handle(FIRST),
            connection_inactivity_timeout: Some(NEVER),
            data: None,
            last_activity: NEW_YEAR,
            session_inactivity_timeout: Some(NEVER),
            session_token: None,
        },
        "no token, no timeout, no data"
    );
    assert!(!sessions.manager.has(&handle(FIRST)), "not stored");
}

#[test]
fn set_draws_a_token_emits_created_and_leaves_the_session_it_was_given_alone() {
    let mut sessions = Sessions::new();
    let draft = Sessions::create(FIRST);
    let stored = sessions.stored(draft.clone());

    assert!(stored.session_token.is_some(), "a token drawn");
    assert!(draft.session_token.is_none(), "the one given left alone");
    assert_eq!(
        sessions.taken(),
        [SessionEvent::Created(stored)],
        "created told"
    );
    assert!(sessions.manager.has(&handle(FIRST)), "stored");
}

#[test]
fn set_emits_updated_when_it_replaces_a_different_session_and_nothing_for_the_same() {
    let mut sessions = Sessions::new();
    let stored = sessions.stored(Sessions::create(FIRST));

    sessions.taken();
    sessions.stored(stored.clone());

    assert!(sessions.taken().is_empty(), "nothing for the same");

    let changed = sessions.stored(Session {
        data: Some(json!({ "roles": [], "username": "guest" })),
        ..stored.clone()
    });

    assert_eq!(
        sessions.taken(),
        [SessionEvent::Updated(changed.clone())],
        "updated told"
    );
    assert_eq!(
        changed.session_token, stored.session_token,
        "its token kept"
    );
}

#[test]
fn draws_tokens_the_wire_can_carry_each_its_own() {
    let mut sessions = Sessions::new();
    let mut drawn = BTreeSet::new();

    for connection in 0..200 {
        let stored = sessions.stored(Sessions::create(&format!(
            "type=WS;ip=127.0.0.1;port={connection};ordinal=1"
        )));

        drawn.insert(stored.session_token.expect("drawn").to_string());
    }

    assert_eq!(drawn.len(), 200, "each its own");
    assert!(
        drawn
            .iter()
            .all(|token| token.parse::<SessionToken>().is_ok()),
        "each one the wire carries"
    );
}

// a platform's shape: a SessionToken is one by its type, so what is no token is never given
#[test]
fn a_token_given_to_set_must_be_one_and_belong_to_no_other_connection_or_nothing_is_stored() {
    let mut sessions = Sessions::new();
    let first = sessions.get_or_else_set(FIRST);

    assert!(
        SessionToken::new([0; 16]).is_err(),
        "16 zero bytes no token"
    );
    assert!(
        "AQEBAQEBAQEBAQEBAQEBA".parse::<SessionToken>().is_err(),
        "a length not 16 bytes no token"
    );

    let taken = sessions.set(Session {
        session_token: first.session_token,
        ..Sessions::create(SECOND)
    });

    assert!(
        matches!(taken, Err(CallError::Refused(_))),
        "another's refused: {taken:?}"
    );
    assert!(!sessions.manager.has(&handle(SECOND)), "nothing stored");
    assert_eq!(
        sessions.tokens_of_both(),
        [first.session_token, None],
        "as they were"
    );

    // its own token, stored again, is still its own
    assert_eq!(
        sessions
            .stored(Session {
                data: Some(json!({ "roles": [], "username": "x" })),
                ..first.clone()
            })
            .session_token,
        first.session_token,
        "its own"
    );
    assert_eq!(
        sessions
            .stored(Session {
                session_token: Some(token_of(3)),
                ..Sessions::create(SECOND)
            })
            .session_token,
        Some(token_of(3)),
        "one of its own given"
    );
}

#[test]
fn a_token_is_free_again_once_its_session_is_deleted_or_replaced() {
    let mut sessions = Sessions::new();
    let deleted = sessions.get_or_else_set(FIRST);
    let mut told = Vec::new();

    sessions.manager.delete(&handle(FIRST), &mut told);

    assert_eq!(
        sessions
            .stored(Session {
                session_token: deleted.session_token,
                ..Sessions::create(SECOND)
            })
            .session_token,
        deleted.session_token,
        "a deleted one's"
    );

    let replaced = sessions.get_or_else_set(FIRST);

    sessions.stored(Sessions::create(FIRST));
    sessions.manager.delete(&handle(SECOND), &mut told);

    assert_eq!(
        sessions
            .stored(Session {
                session_token: replaced.session_token,
                ..Sessions::create(SECOND)
            })
            .session_token,
        replaced.session_token,
        "a replaced one's"
    );
}

// a platform's shape: an update is handed its connection and its value alone, never a token
#[test]
fn keeps_each_connection_to_its_token_through_every_change_and_no_update_changes_it() {
    let mut sessions = Sessions::new();

    sessions.stored(Session {
        session_token: Some(token_of(1)),
        ..Sessions::create(FIRST)
    });
    sessions.manager.update_data(
        (
            &handle(FIRST),
            Some(json!({ "roles": [], "username": "guest" })),
        ),
        &mut sessions.told,
    );
    sessions.connection_timeout((FIRST, Some(milliseconds(5_000))));
    sessions.session_timeout((FIRST, Some(milliseconds(5_000))));
    sessions.touch((FIRST, NEW_YEAR + 5));

    assert_eq!(
        sessions.tokens_of_both(),
        [Some(token_of(1)), None],
        "its token kept"
    );

    let stored = sessions.manager.get(&handle(FIRST)).expect("a session");

    sessions.stored(Session {
        session_token: Some(token_of(2)),
        ..stored
    });

    assert_eq!(
        sessions.tokens_of_both(),
        [Some(token_of(2)), None],
        "a set changes it"
    );

    // the token it let go of is free for another
    sessions.stored(Session {
        session_token: Some(token_of(1)),
        ..Sessions::create(SECOND)
    });

    assert_eq!(
        sessions.tokens_of_both(),
        [Some(token_of(2)), Some(token_of(1))],
        "free for another"
    );
}

#[tokio::test]
async fn get_or_else_set_stores_a_session_once_then_returns_it() {
    let pair = Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected");
    let sessions = pair.server.sessions();
    let created = Arc::new(Mutex::new(0_usize));
    let hearing = Arc::clone(&created);

    sessions.on(Arc::new(move |event: &SessionEvent| {
        if matches!(event, SessionEvent::Created(_)) {
            *locked(&hearing) += 1;
        }
    }));

    let session = sessions
        .get_or_else_set(Arc::clone(&pair.connection_handle))
        .await
        .expect("stored");
    let again = sessions
        .get_or_else_set(Arc::clone(&pair.connection_handle))
        .await
        .expect("returned");

    pair.settle().await;

    assert!(session.session_token.is_some(), "its token drawn");
    assert_eq!(again.session_token, session.session_token, "the same one");
    assert_eq!(*locked(&created), 1, "created once");
}

#[test]
fn get_all_connection_handles_and_has_list_what_is_stored() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.get_or_else_set(SECOND);

    assert_eq!(
        sessions.manager.connection_handles(),
        [handle(FIRST), handle(SECOND)],
        "in order"
    );
    assert_eq!(
        sessions
            .manager
            .all()
            .into_iter()
            .map(|session| session.connection_handle)
            .collect::<Vec<_>>(),
        [handle(FIRST), handle(SECOND)],
        "in order"
    );
    assert!(sessions.manager.has(&handle(SECOND)), "stored");
    assert!(sessions.manager.get(&handle(UNKNOWN)).is_none(), "unknown");
}

#[test]
fn every_update_of_a_connection_with_no_session_is_null() {
    let mut sessions = Sessions::new();
    let first = handle(FIRST);

    assert_eq!(
        sessions.manager.update_connection_inactivity_timeout(
            (&first, Some(milliseconds(1))),
            (&sessions.arming, &mut sessions.told)
        ),
        Ok(None),
        "its connection's timeout"
    );
    assert_eq!(
        sessions
            .manager
            .update_data((&first, Some(Value::Null)), &mut sessions.told),
        None,
        "its data"
    );
    assert_eq!(sessions.touch((FIRST, NEW_YEAR)), None, "its activity");
    assert_eq!(
        sessions.manager.update_session_inactivity_timeout(
            (&first, Some(milliseconds(1))),
            (&sessions.arming, &mut sessions.told)
        ),
        Ok(None),
        "its own timeout"
    );
    assert!(sessions.taken().is_empty(), "nothing told");
}

#[test]
fn gives_a_timeout_left_out_the_default() {
    let mut sessions = Sessions::of(&SessionManagerOptions {
        session_inactivity_timeout: Some(milliseconds(7_000)),
        ..SessionManagerOptions::default()
    });
    let session = sessions.stored(Session {
        session_inactivity_timeout: None,
        ..Sessions::create(FIRST)
    });

    assert_eq!(
        (
            session.session_inactivity_timeout,
            session.connection_inactivity_timeout
        ),
        (Some(milliseconds(7_000)), Some(NEVER)),
        "the default for the one left out"
    );
}

#[test]
fn says_nothing_of_a_session_timeout_given_the_one_it_has() {
    let mut sessions = Sessions::new();
    let session = sessions.stored(Session {
        session_inactivity_timeout: Some(milliseconds(2_000)),
        ..Sessions::create(FIRST)
    });

    sessions.taken();

    assert_eq!(
        sessions.session_timeout((FIRST, Some(milliseconds(2_000)))),
        session,
        "as it was"
    );
    assert!(sessions.taken().is_empty(), "nothing told");
}

#[tokio::test]
async fn runs_on_the_clock_its_options_give_the_system_s_when_none() {
    let clock = stepping();
    let given = SessionManager::new(&SessionManagerOptions {
        clock: Some(Arc::clone(&clock)),
        ..SessionManagerOptions::default()
    })
    .expect("a manager on the clock given");
    let none = SessionManager::new(&SessionManagerOptions::default()).expect("a manager");
    let system = crate::testing::wall_now();
    let read = none.clock().wall();
    let apart = read
        .duration_since(system)
        .or_else(|_| system.duration_since(read))
        .unwrap_or(Duration::MAX);

    assert!(Arc::ptr_eq(given.clock(), &clock), "the clock given");
    assert!(
        apart < Duration::from_secs(5),
        "the system's when none: {apart:?} apart"
    );
    assert_eq!(
        given.create(handle(FIRST)).last_activity,
        NEW_YEAR,
        "its activity read on the clock given"
    );
}

#[test]
fn a_timeout_left_out_takes_the_default_the_manager_s_own_or_its_options() {
    let mut sessions = Sessions::new();
    let mut tuned = Sessions::of(&SessionManagerOptions {
        connection_inactivity_timeout: Some(milliseconds(1_000)),
        session_inactivity_timeout: Some(milliseconds(2_000)),
        ..SessionManagerOptions::default()
    });

    sessions.get_or_else_set(FIRST);
    tuned.get_or_else_set(FIRST);

    assert_eq!(
        sessions
            .connection_timeout((FIRST, None))
            .connection_inactivity_timeout,
        Some(NEVER),
        "the manager's own"
    );
    assert_eq!(
        sessions
            .session_timeout((FIRST, None))
            .session_inactivity_timeout,
        Some(NEVER),
        "the manager's own"
    );
    assert_eq!(
        tuned
            .connection_timeout((FIRST, None))
            .connection_inactivity_timeout,
        Some(milliseconds(1_000)),
        "its options'"
    );
    assert_eq!(
        tuned
            .session_timeout((FIRST, None))
            .session_inactivity_timeout,
        Some(milliseconds(2_000)),
        "its options'"
    );
}

#[test]
fn set_takes_the_default_for_a_timeout_left_out_never_which_arms_no_timer() {
    let mut sessions = Sessions::new();
    let stored = sessions.stored(Session {
        connection_inactivity_timeout: None,
        ..Sessions::create(FIRST)
    });

    assert_eq!(stored.connection_inactivity_timeout, Some(NEVER), "never");
    assert!(sessions.arming.dues().is_empty(), "no timer armed");
}

#[test]
fn a_session_built_without_naming_its_timeouts_holds_both_without_end_as_one_made_by_create_does() {
    let mut sessions = Sessions::new();
    let built = sessions.stored(Session {
        connection_inactivity_timeout: None,
        session_inactivity_timeout: None,
        ..Sessions::create(FIRST)
    });
    let created = sessions.stored(Sessions::create(SECOND));
    let both = |session: &Session| {
        (
            session.connection_inactivity_timeout,
            session.session_inactivity_timeout,
        )
    };

    assert_eq!(both(&built), (Some(NEVER), Some(NEVER)), "without end");
    assert_eq!(both(&created), (Some(NEVER), Some(NEVER)), "without end");
}

#[test]
fn the_session_a_timer_reaches_is_the_one_stored_when_it_fires() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.session_timeout((FIRST, Some(milliseconds(30))));
    sessions.manager.update_data(
        (
            &handle(FIRST),
            Some(json!({ "roles": [], "username": "later" })),
        ),
        &mut sessions.told,
    );

    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(30), Inactivity::Session, FIRST.to_owned())],
        "its timer armed"
    );

    let reached = sessions
        .manager
        .reached((Inactivity::Session, &handle(FIRST)));

    assert!(
        matches!(
            &reached,
            Some(SessionEvent::SessionInactivityTimeoutReached(session))
                if session.data == Some(json!({ "roles": [], "username": "later" }))
        ),
        "the one stored as it fires: {reached:?}"
    );
}

#[test]
fn infinite_stops_a_running_timer() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.connection_timeout((FIRST, Some(milliseconds(20))));
    sessions.connection_timeout((FIRST, Some(NEVER)));

    assert_eq!(sessions.arming.dues(), [milliseconds(20)], "one armed");
    assert!(sessions.arming.live().is_empty(), "stopped");
}

#[test]
fn activity_within_the_same_millisecond_restarts_both_timers_and_emits_nothing() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.connection_timeout((FIRST, Some(milliseconds(200))));
    sessions.session_timeout((FIRST, Some(milliseconds(200))));
    sessions.taken();

    // the clock held on one millisecond
    sessions.touch((FIRST, NEW_YEAR + 1));
    sessions.touch((FIRST, NEW_YEAR + 1));

    // each touch stopped the timer before it and set another going
    assert_eq!(
        sessions.arming.dues(),
        [milliseconds(200); 6],
        "two each time"
    );
    assert_eq!(
        sessions.arming.live(),
        [
            (milliseconds(200), Inactivity::Connection, FIRST.to_owned()),
            (milliseconds(200), Inactivity::Session, FIRST.to_owned()),
        ],
        "the last two going"
    );
    assert_eq!(
        sessions
            .taken()
            .into_iter()
            .filter(|event| matches!(event, SessionEvent::LastActivityChanged(..)))
            .count(),
        1,
        "told once"
    );
}

#[tokio::test]
async fn the_activity_it_reports_reads_the_wall_clock_which_a_clock_set_by_hand_moves_alone() {
    const DAY: i64 = 86_400_000;

    let pair = Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected");
    let sessions = pair.server.sessions();
    let told: Arc<Mutex<Vec<(i64, i64)>>> = Arc::default();
    let hearing = Arc::clone(&told);

    sessions.on(Arc::new(move |event: &SessionEvent| {
        if let SessionEvent::LastActivityChanged(_, new, old) = event {
            locked(&hearing).push((*new, *old));
        }
    }));

    let mut session = sessions.create(Arc::clone(&pair.connection_handle));

    session.session_inactivity_timeout = Some(milliseconds(200));
    sessions
        .set(session)
        .expect("taken as it is made")
        .await
        .expect("stored");

    // back a day, the instant reported with it; the timer counts its 200 ms all the same
    pair.clock.wall_by(-DAY);
    sessions.touch(Arc::clone(&pair.connection_handle)).await;
    pair.settle().await;

    assert_eq!(
        *locked(&told),
        [(NEW_YEAR - DAY, NEW_YEAR)],
        "the wall clock's reading"
    );
    assert!(
        pair.clock.dues().contains(&milliseconds(200)),
        "its timer at 200 ms: {:?}",
        pair.clock.dues()
    );
}

#[test]
fn session_token_of_gives_the_token_the_router_announces_to_a_connection_none_without_a_session() {
    let mut sessions = Sessions::new();
    let stored = sessions.stored(Session {
        session_token: Some(token_of(42)),
        ..Sessions::create(FIRST)
    });

    assert_eq!(
        sessions.tokens_of_both(),
        [Some(token_of(42)), None],
        "its own"
    );

    sessions
        .manager
        .delete(&stored.connection_handle, &mut sessions.told);

    assert_eq!(sessions.tokens_of_both(), [None, None], "none once deleted");
}

#[test]
fn a_session_stored_with_a_token_of_its_own_gets_its_timers_all_the_same() {
    let mut sessions = Sessions::new();

    sessions.stored(Session {
        session_token: Some(token_of(7)),
        ..Sessions::create(SECOND)
    });
    sessions.connection_timeout((SECOND, Some(milliseconds(20))));

    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(20), Inactivity::Connection, SECOND.to_owned())],
        "armed"
    );
    assert!(
        matches!(
            sessions.manager.reached((Inactivity::Connection, &handle(SECOND))),
            Some(SessionEvent::ConnectionInactivityTimeoutReached(session))
                if session.session_token == Some(token_of(7))
        ),
        "reached with its own token"
    );
}

#[test]
fn a_new_session_set_on_a_connection_stops_the_timers_of_the_one_it_replaces() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.connection_timeout((FIRST, Some(milliseconds(20))));
    sessions.stored(Sessions::create(FIRST));

    assert_eq!(sessions.arming.dues(), [milliseconds(20)], "one armed");
    assert!(sessions.arming.live().is_empty(), "stopped");
}

#[test]
fn set_keeps_the_timers_in_step_with_the_timeouts_it_stores() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);

    // a timeout set to never stops the timer that was running
    sessions.connection_timeout((FIRST, Some(milliseconds(20))));

    let running = sessions.manager.get(&handle(FIRST)).expect("a session");

    sessions.stored(Session {
        connection_inactivity_timeout: Some(NEVER),
        ..running
    });

    // a new session with a timeout of its own is armed with it
    let armed = sessions.stored(Session {
        connection_inactivity_timeout: Some(milliseconds(20)),
        ..Sessions::create(SECOND)
    });

    // the timer stopped is gone: the one armed alone runs
    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(20), Inactivity::Connection, SECOND.to_owned())],
        "the one armed alone"
    );
    assert_eq!(
        sessions
            .manager
            .reached((Inactivity::Connection, &handle(SECOND))),
        Some(SessionEvent::ConnectionInactivityTimeoutReached(armed)),
        "it reaches the one armed"
    );
}

#[test]
fn a_new_session_with_the_timeout_of_the_one_it_replaces_is_armed_anew() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.connection_timeout((FIRST, Some(milliseconds(30))));
    sessions.stored(Session {
        connection_inactivity_timeout: Some(milliseconds(30)),
        ..Sessions::create(FIRST)
    });

    // its timer went with it, and another is armed for the one replacing it
    assert_eq!(
        sessions.arming.dues(),
        [milliseconds(30), milliseconds(30)],
        "armed anew"
    );
    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(30), Inactivity::Connection, FIRST.to_owned())],
        "the new one alone"
    );
}

#[test]
fn a_reset_for_a_connection_with_no_session_arms_nothing() {
    let mut sessions = Sessions::new();
    let first = handle(FIRST);

    sessions
        .manager
        .reset_connection_inactivity_timeout((&first, milliseconds(10)), &sessions.arming)
        .expect("held");
    sessions
        .manager
        .reset_session_inactivity_timeout((&first, milliseconds(10)), &sessions.arming)
        .expect("held");

    assert!(sessions.arming.dues().is_empty(), "nothing armed");
    assert_eq!(
        sessions.manager.gauges().counts.get("sessions").copied(),
        Some(0),
        "no session"
    );
}

#[test]
fn dispose_stops_every_timer_and_forgets_every_session_without_events() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);
    sessions.session_timeout((FIRST, Some(milliseconds(20))));
    sessions.taken();
    sessions.manager.dispose();

    assert!(
        sessions.manager.connection_handles().is_empty(),
        "every session forgotten"
    );
    assert!(sessions.arming.live().is_empty(), "every timer stopped");
    assert!(
        sessions
            .manager
            .reached((Inactivity::Session, &handle(FIRST)))
            .is_none(),
        "nothing to reach"
    );
    assert!(sessions.taken().is_empty(), "nothing told");
}

#[test]
fn a_set_once_disposed_is_a_disconnect_error_and_stores_nothing() {
    let mut sessions = Sessions::new();

    sessions.manager.dispose();

    let refused = sessions.set(Sessions::create(FIRST));

    assert!(
        matches!(refused, Err(CallError::Disconnected(_))),
        "a disconnect's error: {refused:?}"
    );
    assert!(sessions.manager.all().is_empty(), "nothing stored");
}

#[test]
fn delete_emits_deleted_and_stops_the_timers_an_unknown_connection_is_false() {
    let mut sessions = Sessions::new();

    sessions.get_or_else_set(FIRST);

    let timed = sessions.connection_timeout((FIRST, Some(milliseconds(20))));
    let mut told = Vec::new();

    sessions.taken();

    assert!(
        sessions.manager.delete(&handle(FIRST), &mut told),
        "deleted"
    );
    assert!(
        !sessions.manager.delete(&handle(FIRST), &mut told),
        "unknown"
    );
    assert_eq!(told, [SessionEvent::Deleted(timed)], "deleted told");
    assert!(sessions.arming.live().is_empty(), "its timer stopped");
    assert_eq!(
        sessions
            .manager
            .gauges()
            .counts
            .get("timedConnections")
            .copied(),
        Some(0),
        "the timer itself gone"
    );
}

#[test]
fn a_new_session_on_a_connection_gets_a_token_of_its_own() {
    let mut sessions = Sessions::new();
    let before = sessions.stored(Sessions::create(FIRST));
    let after = sessions.stored(Sessions::create(FIRST));

    // the one over it told as an update, not a session created
    assert_eq!(
        sessions.taken(),
        [
            SessionEvent::Created(before.clone()),
            SessionEvent::Updated(after.clone())
        ],
        "created, then updated"
    );
    assert_ne!(after.session_token, before.session_token, "a token anew");
    assert_eq!(
        sessions.tokens_of_both(),
        [after.session_token, None],
        "the new one's"
    );
    assert_eq!(
        sessions.manager.connection_handles(),
        [handle(FIRST)],
        "one connection"
    );
    assert_eq!(sessions.manager.all(), [after], "one session");
}

#[test]
fn update_connection_inactivity_timeout_stores_the_timeout_emits_its_change_and_arms_the_timer() {
    let mut sessions = Sessions::new();
    let session = sessions.get_or_else_set(FIRST);

    sessions.taken();

    let stored = sessions.connection_timeout((FIRST, Some(milliseconds(30))));

    sessions.connection_timeout((FIRST, Some(milliseconds(30))));

    assert_eq!(
        sessions.taken(),
        [SessionEvent::ConnectionInactivityTimeoutChanged(
            stored.clone(),
            milliseconds(30),
            NEVER
        )],
        "its change told once"
    );
    assert_eq!(
        stored.session_inactivity_timeout,
        Some(NEVER),
        "the other kept"
    );
    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(30), Inactivity::Connection, FIRST.to_owned())],
        "armed"
    );
    assert!(
        matches!(
            sessions.manager.reached((Inactivity::Connection, &handle(FIRST))),
            Some(SessionEvent::ConnectionInactivityTimeoutReached(reached))
                if reached.session_token == session.session_token
        ),
        "reached"
    );
}

#[test]
fn update_session_inactivity_timeout_stores_the_timeout_emits_its_change_and_arms_the_timer() {
    let mut sessions = Sessions::new();
    let session = sessions.get_or_else_set(FIRST);

    sessions.taken();

    let stored = sessions.session_timeout((FIRST, Some(milliseconds(30))));

    assert_eq!(
        sessions.taken(),
        [SessionEvent::SessionInactivityTimeoutChanged(
            stored.clone(),
            milliseconds(30),
            NEVER
        )],
        "its change told"
    );
    assert_eq!(
        stored.connection_inactivity_timeout,
        Some(NEVER),
        "the other kept"
    );
    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(30), Inactivity::Session, FIRST.to_owned())],
        "armed"
    );
    assert!(
        matches!(
            sessions.manager.reached((Inactivity::Session, &handle(FIRST))),
            Some(SessionEvent::SessionInactivityTimeoutReached(reached))
                if reached.session_token == session.session_token
        ),
        "reached"
    );
}

#[test]
fn a_timeout_past_the_longest_a_timer_waits_is_refused_by_a_reset_a_store_an_update_and_a_default_and_nothing_changes()
 {
    let mut sessions = Sessions::new();
    let session = sessions.stored(Session {
        session_inactivity_timeout: Some(milliseconds(1_000)),
        ..Sessions::create(FIRST)
    });
    let first = handle(FIRST);
    let past = milliseconds(2_147_483_648);

    assert!(
        sessions
            .manager
            .reset_connection_inactivity_timeout((&first, past), &sessions.arming)
            .is_err(),
        "a reset of its connection's"
    );
    // its words this side's, a Duration's: refused, naming what it is
    assert!(
        sessions
            .manager
            .reset_session_inactivity_timeout((&first, past), &sessions.arming)
            .is_err_and(|refused| refused
                .to_string()
                .starts_with("a session inactivity timeout is a duration of whole milliseconds from 1 to 2147483647")),
        "a reset of its own, said"
    );
    assert!(
        sessions
            .set(Session {
                connection_inactivity_timeout: Some(past),
                ..Sessions::create(SECOND)
            })
            .is_err(),
        "a store"
    );
    assert!(
        sessions
            .manager
            .update_connection_inactivity_timeout(
                (&first, Some(past)),
                (&sessions.arming, &mut sessions.told)
            )
            .is_err(),
        "an update of its connection's"
    );
    assert!(
        sessions
            .manager
            .update_session_inactivity_timeout(
                (&first, Some(past)),
                (&sessions.arming, &mut sessions.told)
            )
            .is_err(),
        "an update of its own"
    );

    for options in [
        SessionManagerOptions {
            clock: Some(stepping()),
            connection_inactivity_timeout: Some(past),
            ..SessionManagerOptions::default()
        },
        SessionManagerOptions {
            clock: Some(stepping()),
            session_inactivity_timeout: Some(past),
            ..SessionManagerOptions::default()
        },
    ] {
        assert!(SessionManager::new(&options).is_err(), "a default");
    }

    // the timer running is left as it was, and nothing was stored
    assert_eq!(
        sessions.arming.live(),
        [(milliseconds(1_000), Inactivity::Session, FIRST.to_owned())],
        "as it was"
    );
    assert!(!sessions.manager.has(&handle(SECOND)), "nothing stored");
    assert_eq!(
        sessions.manager.get(&first),
        Some(session),
        "nothing changed"
    );

    // the longest a timer waits is armed, and never is no timer at all
    sessions
        .manager
        .reset_connection_inactivity_timeout((&first, LONGEST_TIMER), &sessions.arming)
        .expect("held");
    sessions
        .manager
        .reset_session_inactivity_timeout((&first, NEVER), &sessions.arming)
        .expect("held");

    assert_eq!(
        sessions.arming.live(),
        [(LONGEST_TIMER, Inactivity::Connection, FIRST.to_owned())],
        "the longest alone"
    );
}

#[test]
fn activity_restarts_both_timers_on_its_clock_and_emits_last_activity_changed() {
    let mut sessions = Sessions::new();
    let session = sessions.get_or_else_set(FIRST);

    sessions.connection_timeout((FIRST, Some(milliseconds(200))));
    sessions.session_timeout((FIRST, Some(milliseconds(200))));
    sessions.taken();

    // a later millisecond, so the activity is a change
    let stored = sessions.touch((FIRST, NEW_YEAR + 5)).expect("a session");

    assert_eq!(
        sessions.taken(),
        [SessionEvent::LastActivityChanged(
            stored.clone(),
            NEW_YEAR + 5,
            NEW_YEAR
        )],
        "its change told"
    );
    assert_eq!(stored.last_activity, NEW_YEAR + 5, "stamped");
    assert_eq!(
        session.last_activity, NEW_YEAR,
        "the one handed before left alone"
    );

    // the first two stopped, two more of the same delay going
    assert_eq!(sessions.arming.dues(), [milliseconds(200); 4], "four armed");
    assert_eq!(sessions.arming.live().len(), 2, "two going");
}
