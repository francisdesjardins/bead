//! The session manager (spec 11): a session per connection, under a token the wire carries, its data,
//! its last activity, and two inactivity timeouts, each with its timer; and what happened to each,
//! told as it happens.

use core::fmt;
use core::time::Duration;
use std::sync::Arc;

use serde_json::Value;

use crate::clock::Timer;
use crate::duration::{NEVER, hold};
use crate::errors::{CallError, ProgrammerError};
use crate::ordered::Ordered;
use crate::router::types::{ConnectionHandle, Gauges};
use crate::session_token::SessionToken;

#[cfg(test)]
mod tests;

/// A connection's session.
#[derive(Clone, PartialEq, Eq)]
#[non_exhaustive]
#[expect(
    clippy::struct_field_names,
    reason = "a session's token and its own timeout, as every side names them"
)]
pub struct Session {
    /// Its connection.
    pub connection_handle: ConnectionHandle,
    /// How long its connection may stay silent; its manager's default when none.
    pub connection_inactivity_timeout: Option<Duration>,
    /// What it holds.
    pub data: Option<Value>,
    /// Its last activity, in milliseconds since the epoch, as its manager's clock read it.
    pub last_activity: i64,
    /// How long it may go unused; its manager's default when none.
    pub session_inactivity_timeout: Option<Duration>,
    /// Its token; one is drawn as it is first stored.
    pub session_token: Option<SessionToken>,
}

impl fmt::Debug for Session {
    // ! whether it holds a token, never the token: a bearer's, which no string a side writes
    // carries (spec 15.1)
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let session_token = if self.session_token.is_some() {
            "drawn"
        } else {
            "none"
        };

        formatter
            .debug_struct("Session")
            .field("connection_handle", &self.connection_handle)
            .field(
                "connection_inactivity_timeout",
                &self.connection_inactivity_timeout,
            )
            .field("data", &self.data)
            .field("last_activity", &self.last_activity)
            .field(
                "session_inactivity_timeout",
                &self.session_inactivity_timeout,
            )
            .field("session_token", &format_args!("{session_token}"))
            .finish()
    }
}

impl Session {
    /// A session of `connection_handle`, holding nothing, never timed out, its activity `now`.
    #[must_use]
    pub fn new(connection_handle: ConnectionHandle, now: i64) -> Self {
        Self {
            connection_handle,
            connection_inactivity_timeout: Some(NEVER),
            data: None,
            last_activity: now,
            session_inactivity_timeout: Some(NEVER),
            session_token: None,
        }
    }
}

/// What happened to a session, as its manager tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionEvent {
    /// Stored where none was.
    Created(Session),
    /// Stored anew, other than it was.
    Updated(Session),
    /// Deleted.
    Deleted(Session),
    /// Its data changed: the session, the new data and the old.
    DataChanged(Session, Option<Value>, Option<Value>),
    /// Its activity moved: the session, the new reading and the old.
    LastActivityChanged(Session, i64, i64),
    /// Its connection's timeout changed: the session, the new and the old.
    ConnectionInactivityTimeoutChanged(Session, Duration, Duration),
    /// Its own timeout changed: the session, the new and the old.
    SessionInactivityTimeoutChanged(Session, Duration, Duration),
    /// Its connection stayed silent for its timeout.
    ConnectionInactivityTimeoutReached(Session),
    /// It went unused for its timeout.
    SessionInactivityTimeoutReached(Session),
}

/// How a session manager is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct SessionManagerOptions {
    /// A session's connection's timeout when it names none: [`NEVER`] by default.
    pub connection_inactivity_timeout: Option<Duration>,
    /// A session's own timeout when it names none: [`NEVER`] by default.
    pub session_inactivity_timeout: Option<Duration>,
}

/// Which of a session's timers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Inactivity {
    Connection,
    Session,
}

/// What arms a session's timer, whose end its manager is told on its owner.
pub(crate) trait Arming {
    fn arm(&self, due: Duration, timer: (Inactivity, ConnectionHandle)) -> Arc<dyn Timer>;
}

#[derive(Default)]
struct Timers {
    connection: Option<Arc<dyn Timer>>,
    session: Option<Arc<dyn Timer>>,
}

impl fmt::Debug for Timers {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Timers")
            .field("connection", &self.connection.is_some())
            .field("session", &self.session.is_some())
            .finish()
    }
}

fn cancel(timer: &mut Option<Arc<dyn Timer>>) {
    if let Some(timer) = timer.take() {
        timer.cancel();
    }
}

impl Timers {
    fn clear(&mut self) {
        cancel(&mut self.connection);
        cancel(&mut self.session);
    }
}

// a session as the manager stores it: both its timeouts held
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stored {
    session: Session,
    connection_inactivity_timeout: Duration,
    session_inactivity_timeout: Duration,
}

impl Stored {
    fn copy(&self) -> Session {
        Session {
            connection_inactivity_timeout: Some(self.connection_inactivity_timeout),
            session_inactivity_timeout: Some(self.session_inactivity_timeout),
            ..self.session.clone()
        }
    }
}

/// A server's sessions, held in its owner.
#[derive(Debug)]
pub(crate) struct SessionManager {
    default_connection_inactivity_timeout: Duration,
    default_session_inactivity_timeout: Duration,
    // by token, in the order stored; by connection through the token each holds
    sessions: Ordered<SessionToken, Stored>,
    tokens: Ordered<ConnectionHandle, SessionToken>,
    timers: Ordered<ConnectionHandle, Timers>,
    is_disposed: bool,
}

fn held_or(timeout: Option<Duration>, fallback: Duration) -> Result<Duration, ProgrammerError> {
    timeout.map_or(Ok(fallback), |timeout| {
        hold("an inactivity timeout", timeout)
    })
}

impl SessionManager {
    /// A manager of no session yet.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a default timeout spec 1.4 does not hold.
    pub(crate) fn new(options: &SessionManagerOptions) -> Result<Self, ProgrammerError> {
        Ok(Self {
            default_connection_inactivity_timeout: hold(
                "connectionInactivityTimeout",
                options.connection_inactivity_timeout.unwrap_or(NEVER),
            )?,
            default_session_inactivity_timeout: hold(
                "sessionInactivityTimeout",
                options.session_inactivity_timeout.unwrap_or(NEVER),
            )?,
            sessions: Ordered::new(),
            tokens: Ordered::new(),
            timers: Ordered::new(),
            is_disposed: false,
        })
    }

    fn stored_of(&self, connection_handle: &ConnectionHandle) -> Option<&Stored> {
        self.tokens
            .get(connection_handle)
            .and_then(|token| self.sessions.get(token))
    }

    fn stored_of_mut(&mut self, connection_handle: &ConnectionHandle) -> Option<&mut Stored> {
        let token = *self.tokens.get(connection_handle)?;

        self.sessions.get_mut(&token)
    }

    /// The connections that hold a session.
    pub(crate) fn connection_handles(&self) -> Vec<ConnectionHandle> {
        self.tokens.keys().cloned().collect()
    }

    /// A copy of the session of `connection_handle`.
    pub(crate) fn get(&self, connection_handle: &ConnectionHandle) -> Option<Session> {
        self.stored_of(connection_handle).map(Stored::copy)
    }

    /// A copy of every session.
    pub(crate) fn all(&self) -> Vec<Session> {
        self.sessions.values().map(Stored::copy).collect()
    }

    /// Whether `connection_handle` holds a session.
    pub(crate) fn has(&self, connection_handle: &ConnectionHandle) -> bool {
        self.tokens.contains_key(connection_handle)
    }

    /// The token of the session of `connection_handle`.
    pub(crate) fn token_of(&self, connection_handle: &ConnectionHandle) -> Option<SessionToken> {
        self.tokens.get(connection_handle).copied()
    }

    /// The data of the session of `connection_handle`.
    pub(crate) fn data_of(&self, connection_handle: &ConnectionHandle) -> Option<Value> {
        self.stored_of(connection_handle)
            .and_then(|stored| stored.session.data.clone())
    }

    /// Deletes the session of `connection_handle`; whether there was one.
    pub(crate) fn delete(
        &mut self,
        connection_handle: &ConnectionHandle,
        told: &mut Vec<SessionEvent>,
    ) -> bool {
        let Some(token) = self.tokens.remove(connection_handle) else {
            return false;
        };
        let stored = self.sessions.remove(&token);

        // stop the timers first, then forget them
        if let Some(mut timers) = self.timers.remove(connection_handle) {
            timers.clear();
        }

        if let Some(stored) = stored {
            told.push(SessionEvent::Deleted(stored.copy()));
        }

        true
    }

    fn reset(
        &mut self,
        (inactivity, connection_handle, timeout): (Inactivity, &ConnectionHandle, Duration),
        arming: &dyn Arming,
    ) {
        let is_held = self.tokens.contains_key(connection_handle);
        let Some(timers) = self
            .timers
            .entry_or_insert_with(Arc::clone(connection_handle), Timers::default)
        else {
            return;
        };
        let timer = match inactivity {
            Inactivity::Connection => &mut timers.connection,
            Inactivity::Session => &mut timers.session,
        };

        cancel(timer);

        if is_held && timeout != NEVER {
            *timer = Some(arming.arm(timeout, (inactivity, Arc::clone(connection_handle))));
        }
    }

    /// Restarts the connection's timer of `connection_handle`'s session at `timeout`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub(crate) fn reset_connection_inactivity_timeout(
        &mut self,
        (connection_handle, timeout): (&ConnectionHandle, Duration),
        arming: &dyn Arming,
    ) -> Result<(), ProgrammerError> {
        let timeout = hold("a connection inactivity timeout", timeout)?;

        self.reset((Inactivity::Connection, connection_handle, timeout), arming);

        Ok(())
    }

    /// Restarts the session's own timer of `connection_handle` at `timeout`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub(crate) fn reset_session_inactivity_timeout(
        &mut self,
        (connection_handle, timeout): (&ConnectionHandle, Duration),
        arming: &dyn Arming,
    ) -> Result<(), ProgrammerError> {
        let timeout = hold("a session inactivity timeout", timeout)?;

        self.reset((Inactivity::Session, connection_handle, timeout), arming);

        Ok(())
    }

    /// The session as it is now, a timer's end told: none when it is gone.
    pub(crate) fn reached(
        &self,
        (inactivity, connection_handle): (Inactivity, &ConnectionHandle),
    ) -> Option<SessionEvent> {
        let session = self.get(connection_handle)?;

        Some(match inactivity {
            Inactivity::Connection => SessionEvent::ConnectionInactivityTimeoutReached(session),
            Inactivity::Session => SessionEvent::SessionInactivityTimeoutReached(session),
        })
    }

    /// Stamps a session's activity `now` and restarts both its timers; whether there was one.
    pub(crate) fn touch(
        &mut self,
        (connection_handle, now): (&ConnectionHandle, i64),
        (arming, told): (&dyn Arming, &mut Vec<SessionEvent>),
    ) -> Option<Session> {
        let stored = self.stored_of_mut(connection_handle)?;
        let old = stored.session.last_activity;

        stored.session.last_activity = now;

        let (connection, session) = (
            stored.connection_inactivity_timeout,
            stored.session_inactivity_timeout,
        );
        let copy = stored.copy();

        // activity restarts both timers, even within the same millisecond
        self.reset(
            (Inactivity::Connection, connection_handle, connection),
            arming,
        );
        self.reset((Inactivity::Session, connection_handle, session), arming);

        if now != old {
            told.push(SessionEvent::LastActivityChanged(copy.clone(), now, old));
        }

        Some(copy)
    }

    /// Stores `session`, its token drawn when it has none.
    ///
    /// # Errors
    ///
    /// A [`CallError`] once the manager is disposed, refused for a token another connection holds,
    /// or a timeout spec 1.4 does not hold.
    pub(crate) fn set(
        &mut self,
        session: Session,
        (arming, told): (&dyn Arming, &mut Vec<SessionEvent>),
    ) -> Result<Session, CallError> {
        // a resolver that finishes once its server is gone has nowhere left to store a session
        if self.is_disposed {
            return Err(CallError::Disconnected(
                "the sessions were disposed".to_owned(),
            ));
        }

        let connection_handle = Arc::clone(&session.connection_handle);
        let previous = self.stored_of(&connection_handle).cloned();
        let is_new = session.session_token.is_none();

        // everything that can refuse runs before anything is stored
        if let Some(token) = session.session_token
            && let Some(holder) = self.sessions.get(&token)
            && holder.session.connection_handle != connection_handle
        {
            return Err(CallError::Refused(ProgrammerError::new(
                "this session token belongs to another connection",
            )));
        }

        let connection_inactivity_timeout = held_or(
            session.connection_inactivity_timeout,
            self.default_connection_inactivity_timeout,
        )
        .map_err(CallError::Refused)?;
        let session_inactivity_timeout = held_or(
            session.session_inactivity_timeout,
            self.default_session_inactivity_timeout,
        )
        .map_err(CallError::Refused)?;
        let token = match session.session_token {
            Some(token) => token,
            None => SessionToken::draw(|token| self.sessions.contains_key(token))
                .map_err(|error| CallError::Other(Arc::new(error)))?,
        };
        let next = Stored {
            session: Session {
                session_token: Some(token),
                connection_inactivity_timeout: Some(connection_inactivity_timeout),
                session_inactivity_timeout: Some(session_inactivity_timeout),
                ..session
            },
            connection_inactivity_timeout,
            session_inactivity_timeout,
        };
        let is_similar = previous.as_ref().is_some_and(|previous| *previous == next);

        if let Some(previous_token) = previous
            .as_ref()
            .and_then(|previous| previous.session.session_token)
        {
            self.sessions.remove(&previous_token);
        }

        self.sessions.insert(token, next.clone());
        self.tokens.insert(Arc::clone(&connection_handle), token);

        // the timers follow what is stored: a new session, or one where none was, starts over with
        // no timer, and a timeout that changed restarts its own
        if is_new || previous.is_none() {
            if let Some(mut timers) = self.timers.remove(&connection_handle) {
                timers.clear();
            }

            self.timers
                .insert(Arc::clone(&connection_handle), Timers::default());
        }

        if is_new
            || previous.as_ref().is_none_or(|previous| {
                previous.connection_inactivity_timeout != connection_inactivity_timeout
            })
        {
            self.reset(
                (
                    Inactivity::Connection,
                    &connection_handle,
                    connection_inactivity_timeout,
                ),
                arming,
            );
        }

        if is_new
            || previous.as_ref().is_none_or(|previous| {
                previous.session_inactivity_timeout != session_inactivity_timeout
            })
        {
            self.reset(
                (
                    Inactivity::Session,
                    &connection_handle,
                    session_inactivity_timeout,
                ),
                arming,
            );
        }

        let copy = next.copy();

        if previous.is_none() {
            told.push(SessionEvent::Created(copy.clone()));
        } else if !is_similar {
            told.push(SessionEvent::Updated(copy.clone()));
        }

        Ok(copy)
    }

    /// Stores `data` in the session of `connection_handle`.
    pub(crate) fn update_data(
        &mut self,
        (connection_handle, data): (&ConnectionHandle, Option<Value>),
        told: &mut Vec<SessionEvent>,
    ) -> Option<Session> {
        let stored = self.stored_of_mut(connection_handle)?;
        let old = stored.session.data.clone();
        let is_similar = old == data;

        stored.session.data.clone_from(&data);

        let copy = stored.copy();

        if !is_similar {
            told.push(SessionEvent::DataChanged(copy.clone(), data, old));
        }

        Some(copy)
    }

    /// Sets the connection's timeout of the session of `connection_handle`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub(crate) fn update_connection_inactivity_timeout(
        &mut self,
        (connection_handle, timeout): (&ConnectionHandle, Option<Duration>),
        (arming, told): (&dyn Arming, &mut Vec<SessionEvent>),
    ) -> Result<Option<Session>, ProgrammerError> {
        let fallback = self.default_connection_inactivity_timeout;
        let new = held_or(timeout, fallback)?;
        let Some(stored) = self.stored_of_mut(connection_handle) else {
            return Ok(None);
        };
        let old = stored.connection_inactivity_timeout;

        stored.connection_inactivity_timeout = new;
        stored.session.connection_inactivity_timeout = Some(new);

        let copy = stored.copy();

        if new != old {
            self.reset((Inactivity::Connection, connection_handle, new), arming);
            told.push(SessionEvent::ConnectionInactivityTimeoutChanged(
                copy.clone(),
                new,
                old,
            ));
        }

        Ok(Some(copy))
    }

    /// Sets the session's own timeout of the session of `connection_handle`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold.
    pub(crate) fn update_session_inactivity_timeout(
        &mut self,
        (connection_handle, timeout): (&ConnectionHandle, Option<Duration>),
        (arming, told): (&dyn Arming, &mut Vec<SessionEvent>),
    ) -> Result<Option<Session>, ProgrammerError> {
        let fallback = self.default_session_inactivity_timeout;
        let new = held_or(timeout, fallback)?;
        let Some(stored) = self.stored_of_mut(connection_handle) else {
            return Ok(None);
        };
        let old = stored.session_inactivity_timeout;

        stored.session_inactivity_timeout = new;
        stored.session.session_inactivity_timeout = Some(new);

        let copy = stored.copy();

        if new != old {
            self.reset((Inactivity::Session, connection_handle, new), arming);
            told.push(SessionEvent::SessionInactivityTimeoutChanged(
                copy.clone(),
                new,
                old,
            ));
        }

        Ok(Some(copy))
    }

    /// Its sessions and its timers, counted.
    pub(crate) fn gauges(&self) -> Gauges {
        let untied = self
            .timers
            .keys()
            .filter(|handle| !self.tokens.contains_key(handle))
            .count();
        let mut own = Gauges::default();

        if untied > 0 {
            own.anomalies
                .push(format!("{untied} connections keep timers with no session"));
        }

        own.connection_handles.extend(self.tokens.keys().cloned());
        own.counts.insert(
            "sessions",
            u64::try_from(self.sessions.len()).unwrap_or(u64::MAX),
        );

        let mut timed = Gauges::default();

        timed.connection_handles.extend(self.timers.keys().cloned());
        timed.counts.insert(
            "timedConnections",
            u64::try_from(self.timers.len()).unwrap_or(u64::MAX),
        );

        Gauges::merged(vec![own, timed])
    }

    /// Lets go of every session and stops every timer: what is stored after is refused.
    pub(crate) fn dispose(&mut self) {
        self.is_disposed = true;

        for (_, mut timers) in self.timers.drain() {
            timers.clear();
        }

        self.sessions.clear();
        self.tokens.clear();
    }
}
