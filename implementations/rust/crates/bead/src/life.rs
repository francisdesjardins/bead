//! The half of a transport server's life every server shares, whatever its transport, as the other
//! sides' `TransportServerLife` and `createTransportServer` keep it (decision 0049): its ready
//! state, and the guards around its start, its stop and its dispose. What starting and stopping do
//! is the transport's own.
//!
//! Each takes effect as it is called, and its future only waits: what the transport's start or stop
//! gives is awaited by its server's cover, so a future dropped leaves the server's life as it goes.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

use crate::errors::ProgrammerError;
use crate::router::types::{BoxFuture, RouterError};
use crate::transport::{ReadyState, TransportServerAddress};

#[cfg(test)]
mod tests;

/// What awaits what a life waits on: its server's owner, which counts it as the side's work while it
/// can run; a future it drops leaves its waiters told the runtime let it go.
pub(crate) type Cover = Box<dyn Fn(BoxFuture<()>) + Send + Sync>;

// what a stop or a dispose settled with, shared by each that waits on it: none while under way
type Settled = watch::Receiver<Option<Result<(), RouterError>>>;

struct LifeState {
    ready: ReadyState,
    // the stop under way, which a later stop shares
    stopping: Option<Settled>,
    // its dispose, which every later one shares: a start after it is refused
    disposed: Option<Settled>,
}

/// A transport server's life: Uninitialized until its first start.
pub(crate) struct Life {
    cover: Cover,
    state: Arc<Mutex<LifeState>>,
}

impl core::fmt::Debug for Life {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Life")
            .field("ready", &self.ready_state())
            .finish_non_exhaustive()
    }
}

fn locked(state: &Mutex<LifeState>) -> MutexGuard<'_, LifeState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

// what a refusal of the life's own is: its application's misuse
fn refused<T: Send + 'static>(message: String) -> BoxFuture<Result<T, RouterError>> {
    Box::pin(async move { Err(RouterError::Other(Arc::new(ProgrammerError::new(message)))) })
}

// what waits on a stop or a dispose under way: what it settled with, or nothing to tell once its
// runtime let it go
fn shared(mut settled: Settled) -> BoxFuture<Result<(), RouterError>> {
    Box::pin(async move {
        settled
            .wait_for(Option::is_some)
            .await
            .map_or(Ok(()), |outcome| outcome.clone().unwrap_or(Ok(())))
    })
}

impl Life {
    /// A life whose `cover` awaits what its transport's start and stop give.
    pub(crate) fn new(cover: Cover) -> Self {
        Self {
            cover,
            state: Arc::new(Mutex::new(LifeState {
                ready: ReadyState::Uninitialized,
                stopping: None,
                disposed: None,
            })),
        }
    }

    /// Where it is in its life.
    pub(crate) fn ready_state(&self) -> ReadyState {
        locked(&self.state).ready
    }

    /// Starts, as `starting` does, and gives where it listens. Refused once disposed, its state
    /// kept, before anything else (decision 0003); then unless Uninitialized or Closed, a second
    /// start even while the first is under way; one that fails ends Closed, ready to start again.
    pub(crate) fn start<S>(
        &self,
        starting: S,
    ) -> BoxFuture<Result<TransportServerAddress, RouterError>>
    where
        S: FnOnce() -> BoxFuture<Result<TransportServerAddress, RouterError>>,
    {
        {
            let mut state = locked(&self.state);

            if state.disposed.is_some() {
                return refused("the transport server is disposed".to_owned());
            }

            if !matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed) {
                return refused(format!(
                    "the transport server is already {}",
                    state.ready.said()
                ));
            }

            state.ready = ReadyState::Connecting;
        }

        // ! called outside the lock: what the transport does as it starts may read its state
        let started = starting();
        let state = Arc::clone(&self.state);
        let (reply, outcome) = tokio::sync::oneshot::channel();

        (self.cover)(Box::pin(async move {
            let bound = started.await;

            locked(&state).ready = if bound.is_ok() {
                ReadyState::Open
            } else {
                ReadyState::Closed
            };
            reply.send(bound).ok();
        }));

        Box::pin(async move {
            outcome.await.unwrap_or_else(|_dropped| {
                Err(RouterError::Other(Arc::new(ProgrammerError::new(
                    "the transport server's runtime let its start go",
                ))))
            })
        })
    }

    /// Stops, as `stopping` does; it ends Closed, even when that fails. It settles at once when
    /// Uninitialized or Closed; a second stop, or one from a listener of what the stop causes,
    /// shares the stop under way; one while starting is refused.
    pub(crate) fn stop<S>(&self, stopping: S) -> BoxFuture<Result<(), RouterError>>
    where
        S: FnOnce() -> BoxFuture<Result<(), RouterError>>,
    {
        let settle = {
            let mut state = locked(&self.state);

            if let Some(under_way) = &state.stopping {
                return shared(under_way.clone());
            }

            match state.ready {
                ReadyState::Uninitialized | ReadyState::Closed => {
                    return Box::pin(async { Ok(()) });
                }
                ReadyState::Connecting => {
                    return refused("the transport server is starting".to_owned());
                }
                ReadyState::Open | ReadyState::Closing | ReadyState::Reconnecting => {}
            }

            state.ready = ReadyState::Closing;

            let (settle, settled) = watch::channel(None);

            state.stopping = Some(settled);

            settle
        };
        let settled = settle.subscribe();
        // * called outside the lock, the stop already shared: a stop it causes shares this one
        let stopped = stopping();
        let state = Arc::clone(&self.state);

        (self.cover)(Box::pin(async move {
            let outcome = stopped.await;

            {
                let mut state = locked(&state);

                state.ready = ReadyState::Closed;
                state.stopping = None;
            }

            settle.send_replace(Some(outcome));
        }));

        shared(settled)
    }

    /// Stops it, as [`Life::stop`] does with `stopping`, then ends it for good: a start after it is
    /// its application's misuse (decision 0003). A later dispose settles with the first.
    pub(crate) fn dispose<S>(&self, stopping: S) -> BoxFuture<Result<(), RouterError>>
    where
        S: FnOnce() -> BoxFuture<Result<(), RouterError>>,
    {
        let settle = {
            let mut state = locked(&self.state);

            if let Some(disposed) = &state.disposed {
                return shared(disposed.clone());
            }

            let (settle, settled) = watch::channel(None);

            state.disposed = Some(settled);

            settle
        };
        let settled = settle.subscribe();
        let stopped = self.stop(stopping);

        (self.cover)(Box::pin(async move {
            settle.send_replace(Some(stopped.await));
        }));

        shared(settled)
    }
}
