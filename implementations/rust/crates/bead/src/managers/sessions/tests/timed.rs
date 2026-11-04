//! Session timers fire on the test clock, with no server facade ending a session for them.

use std::sync::{Arc, Mutex, Weak};

use super::{FIRST, SECOND, Session, SessionEvent, at, handle, locked, milliseconds};
use crate::clock::{Clock, Schedule, Timer};
use crate::errors::{CallError, ProgrammerError};
use crate::managers::sessions::{Arming, Inactivity, SessionManagerOptions, SessionState};
use crate::router::types::ConnectionHandle;
use crate::testing::SteppingClock;

struct ClockArming {
    armed: Mutex<Vec<core::time::Duration>>,
    clock: Arc<SteppingClock>,
    state: Weak<Mutex<SessionState>>,
    told: Arc<Mutex<Vec<SessionEvent>>>,
}

impl Arming for ClockArming {
    fn arm(
        &self,
        due: core::time::Duration,
        (inactivity, handle): (Inactivity, ConnectionHandle),
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        locked(&self.armed).push(due);
        let state = Weak::clone(&self.state);
        let told = Arc::clone(&self.told);
        self.clock.arm(
            Schedule::Once(due),
            Box::new(move || {
                if let Some(state) = state.upgrade() {
                    let event = locked(&state).reached((inactivity, &handle));
                    if let Some(event) = event {
                        locked(&told).push(event);
                    }
                }
            }),
        )
    }
}

struct Timed {
    state: Arc<Mutex<SessionState>>,
    arming: ClockArming,
}

impl Timed {
    fn new() -> Self {
        let clock = SteppingClock::new(at(0));
        let state = Arc::new(Mutex::new(
            SessionState::new(&SessionManagerOptions {
                clock: Some(Arc::<SteppingClock>::clone(&clock)),
                ..SessionManagerOptions::default()
            })
            .expect("a session manager"),
        ));
        Self {
            arming: ClockArming {
                armed: Mutex::default(),
                clock,
                state: Arc::downgrade(&state),
                told: Arc::default(),
            },
            state,
        }
    }

    fn set(&self, session: Session) -> Result<Session, CallError> {
        locked(&self.state).set(session, (&self.arming, &mut locked(&self.arming.told)))
    }

    fn taken(&self) -> Vec<SessionEvent> {
        core::mem::take(&mut locked(&self.arming.told))
    }

    fn reached(&self) -> Vec<&'static str> {
        locked(&self.arming.told)
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ConnectionInactivityTimeoutReached(_) => Some("connection"),
                SessionEvent::SessionInactivityTimeoutReached(_) => Some("session"),
                SessionEvent::Created(_)
                | SessionEvent::Updated(_)
                | SessionEvent::Deleted(_)
                | SessionEvent::DataChanged { .. }
                | SessionEvent::LastActivityChanged { .. }
                | SessionEvent::ConnectionInactivityTimeoutChanged { .. }
                | SessionEvent::SessionInactivityTimeoutChanged { .. } => None,
            })
            .collect()
    }
}

#[tokio::test]
async fn a_timeout_longer_than_a_timer_holds_is_refused_and_nothing_is_stored_the_longest_one_fires_at_its_due()
 {
    use crate::duration::{LONGEST_TIMER, NEVER};

    let fixture = Timed::new();
    let first = handle(FIRST);
    let second = handle(SECOND);
    let session = fixture
        .set(Session {
            session_inactivity_timeout: Some(milliseconds(1_000)),
            ..Session::new(Arc::clone(&first), at(0))
        })
        .expect("stored");
    let longer = LONGEST_TIMER + milliseconds(1);

    assert!(matches!(
        fixture.set(Session {
            connection_inactivity_timeout: Some(longer),
            ..Session::new(Arc::clone(&second), at(0))
        }),
        Err(CallError::Refused(_))
    ));
    {
        let mut state = locked(&fixture.state);
        let mut told = locked(&fixture.arming.told);
        state
            .update_connection_inactivity_timeout(
                (&first, Some(longer)),
                (&fixture.arming, &mut told),
            )
            .expect_err("the connection timeout is past the longest timer");
        state
            .update_session_inactivity_timeout((&first, Some(longer)), (&fixture.arming, &mut told))
            .expect_err("the session timeout is past the longest timer");
        state
            .reset_connection_inactivity_timeout((&first, longer), &fixture.arming)
            .expect_err("the connection timer is past its longest due");
        assert_eq!(
            state
                .reset_session_inactivity_timeout((&first, longer), &fixture.arming)
                .expect_err("the session timer is past its longest due")
                .message(),
            "a session inactivity timeout is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not 2147483648 milliseconds"
        );
        assert!(!state.has(&second));
        assert_eq!(state.get(&first), Some(session));
    }
    assert_eq!(fixture.arming.clock.dues(), [milliseconds(1_000)]);
    {
        let mut state = locked(&fixture.state);
        state
            .reset_connection_inactivity_timeout((&first, LONGEST_TIMER), &fixture.arming)
            .expect("the longest connection timer holds");
        state
            .reset_session_inactivity_timeout((&first, NEVER), &fixture.arming)
            .expect("the session timer ends");
    }
    assert_eq!(fixture.arming.clock.dues(), [LONGEST_TIMER]);
    fixture
        .arming
        .clock
        .advance(
            LONGEST_TIMER
                .checked_sub(milliseconds(1))
                .expect("a positive due"),
        )
        .await;
    assert_eq!(fixture.reached(), Vec::<&str>::new());
    fixture.arming.clock.advance(milliseconds(1)).await;
    assert_eq!(fixture.reached(), ["connection"]);
}

#[tokio::test]
async fn reaches_its_timeouts_unless_its_connection_speaks_which_starts_both_anew() {
    let fixture = Timed::new();
    fixture
        .set(Session {
            connection_inactivity_timeout: Some(milliseconds(5_000)),
            session_inactivity_timeout: Some(milliseconds(2_000)),
            ..Session::new(handle(FIRST), at(0))
        })
        .expect("stored");
    fixture.arming.clock.advance(milliseconds(1_000)).await;
    assert!(
        locked(&fixture.state)
            .touch(
                (&handle(FIRST), at(1_000)),
                (&fixture.arming, &mut locked(&fixture.arming.told)),
            )
            .expect("timers restarted")
            .is_some()
    );
    fixture.arming.clock.advance(milliseconds(1_500)).await;
    assert_eq!(fixture.reached(), Vec::<&str>::new());
    fixture.arming.clock.advance(milliseconds(500)).await;
    assert_eq!(fixture.reached(), ["session"]);
    fixture.arming.clock.advance(milliseconds(2_500)).await;
    assert_eq!(fixture.reached(), ["session"]);
    fixture.arming.clock.advance(milliseconds(500)).await;
    assert_eq!(fixture.reached(), ["session", "connection"]);
    assert!(
        locked(&fixture.state)
            .touch(
                (&handle(SECOND), at(6_000)),
                (&fixture.arming, &mut locked(&fixture.arming.told)),
            )
            .expect("an unknown connection changes nothing")
            .is_none()
    );
}

#[tokio::test]
async fn says_what_each_timeout_changed_to_and_from_and_reaches_it() {
    let fixture = Timed::new();
    fixture
        .set(Session::new(handle(FIRST), at(0)))
        .expect("stored");
    fixture.taken();
    let update_connection = |handle: &ConnectionHandle, timeout| {
        locked(&fixture.state)
            .update_connection_inactivity_timeout(
                (handle, timeout),
                (&fixture.arming, &mut locked(&fixture.arming.told)),
            )
            .expect("a held connection timeout")
    };
    let update_session = |handle: &ConnectionHandle, timeout| {
        locked(&fixture.state)
            .update_session_inactivity_timeout(
                (handle, timeout),
                (&fixture.arming, &mut locked(&fixture.arming.told)),
            )
            .expect("a held session timeout")
    };
    let connection =
        update_connection(&handle(FIRST), Some(milliseconds(3_000))).expect("the connection timed");
    update_connection(&handle(FIRST), Some(milliseconds(3_000)));
    let stored =
        update_session(&handle(FIRST), Some(milliseconds(2_000))).expect("the session timed");
    assert_eq!(
        stored.connection_inactivity_timeout,
        Some(milliseconds(3_000))
    );
    assert_eq!(
        fixture.taken(),
        [
            SessionEvent::ConnectionInactivityTimeoutChanged {
                session: connection,
                new_value: milliseconds(3_000),
                old_value: crate::duration::NEVER,
            },
            SessionEvent::SessionInactivityTimeoutChanged {
                session: stored,
                new_value: milliseconds(2_000),
                old_value: crate::duration::NEVER,
            },
        ]
    );
    fixture.arming.clock.advance(milliseconds(2_000)).await;
    assert_eq!(fixture.reached(), ["session"]);
    fixture.arming.clock.advance(milliseconds(1_000)).await;
    assert_eq!(fixture.reached(), ["session", "connection"]);
    assert!(update_connection(&handle(SECOND), None).is_none());
    assert!(update_session(&handle(SECOND), None).is_none());
}

#[tokio::test]
async fn stops_its_timers_with_a_session_deleted_and_stores_nothing_once_disposed() {
    let fixture = Timed::new();
    let stored = fixture
        .set(Session {
            session_inactivity_timeout: Some(milliseconds(1_000)),
            ..Session::new(handle(FIRST), at(0))
        })
        .expect("stored");
    fixture.taken();
    assert!(locked(&fixture.state).delete(&handle(FIRST), &mut locked(&fixture.arming.told)));
    assert_eq!(fixture.taken(), [SessionEvent::Deleted(stored)]);
    assert!(!locked(&fixture.state).delete(&handle(SECOND), &mut locked(&fixture.arming.told)));
    assert_eq!(
        locked(&fixture.state).gauges().expect("gauges").counts["timedConnections"],
        0
    );
    fixture.arming.clock.advance(milliseconds(2_000)).await;
    assert_eq!(fixture.reached(), Vec::<&str>::new());
    locked(&fixture.state).dispose();
    assert!(matches!(
        fixture.set(Session::new(handle(FIRST), at(2_000))),
        Err(CallError::Disconnected(_))
    ));
    assert_eq!(locked(&fixture.state).all(), []);
}

#[tokio::test]
async fn touch_stamps_activity_and_restarts_the_timers_as_update_last_activity_does_without_a_copy()
{
    let fixture = Timed::new();
    let session = fixture
        .set(Session::new(handle(FIRST), at(0)))
        .expect("stored");
    locked(&fixture.state)
        .update_connection_inactivity_timeout(
            (&handle(FIRST), Some(milliseconds(200))),
            (&fixture.arming, &mut locked(&fixture.arming.told)),
        )
        .expect("a held timeout");
    fixture.taken();
    fixture.arming.clock.advance(milliseconds(5)).await;
    let now = fixture.arming.clock.wall();
    let touched = locked(&fixture.state)
        .touch(
            (&handle(FIRST), now),
            (&fixture.arming, &mut locked(&fixture.arming.told)),
        )
        .expect("timers restarted")
        .expect("a known connection");
    assert!(
        locked(&fixture.state)
            .touch(
                (&handle(SECOND), now),
                (&fixture.arming, &mut locked(&fixture.arming.told)),
            )
            .expect("an unknown connection changes nothing")
            .is_none()
    );
    assert_eq!(touched.last_activity, at(5));
    assert_eq!(session.last_activity, at(0));
    assert_eq!(
        locked(&fixture.state)
            .get(&handle(FIRST))
            .expect("stored")
            .last_activity,
        at(5)
    );
    assert_eq!(
        fixture.taken(),
        [SessionEvent::LastActivityChanged {
            session: touched,
            new_value: at(5),
            old_value: at(0),
        }]
    );
    assert_eq!(*locked(&fixture.arming.armed), [milliseconds(200); 2]);
    fixture.arming.clock.advance(milliseconds(200)).await;
    assert_eq!(fixture.reached(), ["connection"]);
}
