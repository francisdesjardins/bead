//! One owner per router (decision 0044): a task of the application's runtime holds the router's
//! state and runs its jobs one at a time, in the order they came. A job is synchronous, so a turn
//! awaits nothing and no other job runs within it; what waits runs off the owner and posts its
//! outcome as a job of its own. A job posted within a turn of the same owner goes as that turn
//! ends, before any job queued after it.

use core::cell::Cell;
use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicUsize, Ordering};
use core::task::{Context, Poll};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::errors::Disposed;

#[cfg(test)]
mod tests;

/// A job of an owner's: what it runs, in its turn, on the state it holds.
pub(crate) type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

// each owner's own number, which a turn running marks on its thread
static OWNERS: AtomicUsize = AtomicUsize::new(1);

thread_local! {
    // the owner whose turn the current thread runs, 0 for none
    static CURRENT: Cell<usize> = const { Cell::new(0) };
}

struct Shared<S> {
    id: usize,
    jobs: mpsc::UnboundedSender<Job<S>>,
    // the jobs posted within a turn of this owner, which go as that turn ends
    turn: Mutex<VecDeque<Job<S>>>,
    runtime: Handle,
    #[cfg(any(test, feature = "testing"))]
    activity: Option<Arc<crate::testing::Activity>>,
}

/// A handle to an owner: what posts its jobs. Every handle dropped, its task ends.
pub(crate) struct Owner<S> {
    shared: Arc<Shared<S>>,
}

impl<S> Clone for Owner<S> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<S> fmt::Debug for Owner<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Owner")
            .field("id", &self.shared.id)
            .finish_non_exhaustive()
    }
}

/// A handle to an owner that keeps it from no end: what its own state holds to post its
/// continuations.
pub(crate) struct WeakOwner<S> {
    shared: Weak<Shared<S>>,
}

impl<S> Clone for WeakOwner<S> {
    fn clone(&self) -> Self {
        Self {
            shared: Weak::clone(&self.shared),
        }
    }
}

impl<S> fmt::Debug for WeakOwner<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("WeakOwner").finish_non_exhaustive()
    }
}

impl<S: Send + 'static> Owner<S> {
    /// An owner of `state` on `runtime`, its activity counted on `clock`'s when a test's clock
    /// counts one, its state made once its handle is known, by `make`.
    pub(crate) fn spawn<M: FnOnce(WeakOwner<S>) -> S>(
        (runtime, clock): (&Handle, &Arc<dyn Clock>),
        make: M,
    ) -> Self {
        let (jobs, queue) = mpsc::unbounded_channel::<Job<S>>();
        // the clock counts activity for a test's kit alone
        #[cfg(not(any(test, feature = "testing")))]
        let _: &Arc<dyn Clock> = clock;
        let shared = Arc::new(Shared {
            id: OWNERS.fetch_add(1, Ordering::Relaxed),
            jobs,
            turn: Mutex::new(VecDeque::new()),
            runtime: runtime.clone(),
            #[cfg(any(test, feature = "testing"))]
            activity: clock.activity(),
        });
        let state = make(WeakOwner {
            shared: Arc::downgrade(&shared),
        });

        runtime.spawn(run(state, (queue, Arc::downgrade(&shared))));

        Self { shared }
    }

    /// A handle that keeps it from no end.
    pub(crate) fn downgrade(&self) -> WeakOwner<S> {
        WeakOwner {
            shared: Arc::downgrade(&self.shared),
        }
    }

    /// Posts `job`: within a turn of this owner's, as that turn ends; else after every job queued.
    pub(crate) fn post(&self, job: Job<S>) -> Result<(), Disposed> {
        post(&self.shared, job)
    }

    /// Posts `job` as [`Owner::post`] does; an owner gone takes nothing, and the job goes with it.
    pub(crate) fn offer(&self, job: Job<S>) {
        self.post(job).ok();
    }

    /// Runs `job` on the owner, after what came before it, and gives what it gives.
    pub(crate) fn run<T: Send + 'static, J: FnOnce(&mut S) -> T + Send + 'static>(
        &self,
        job: J,
    ) -> Pending<T> {
        let (reply, answer) = oneshot::channel();
        let posted = self.post(Box::new(move |state| {
            reply.send(job(state)).ok();
        }));

        Pending {
            answer: posted.ok().map(|()| answer),
        }
    }

    /// Spawns `future` on its runtime, counted as the side's work while it can run, for what runs
    /// off the owner on its router's behalf and posts back: a resolver, a verifier.
    pub(crate) fn cover<F: Future<Output = ()> + Send + 'static>(&self, future: F) {
        cover(&self.shared, future);
    }
}

impl<S: Send + 'static> WeakOwner<S> {
    /// Posts `job`, as [`Owner::post`] does, to an owner not gone.
    pub(crate) fn post(&self, job: Job<S>) -> Result<(), Disposed> {
        self.shared
            .upgrade()
            .ok_or(Disposed)
            .and_then(|shared| post(&shared, job))
    }

    /// Posts `job` as [`WeakOwner::post`] does; an owner gone takes nothing, and the job goes with
    /// it.
    pub(crate) fn offer(&self, job: Job<S>) {
        self.post(job).ok();
    }

    /// Spawns `future`, as [`Owner::cover`] does, for an owner not gone.
    pub(crate) fn cover<F: Future<Output = ()> + Send + 'static>(&self, future: F) {
        if let Some(shared) = self.shared.upgrade() {
            cover(&shared, future);
        }
    }

    /// Spawns `future` on the owner's runtime, counted as the side's work while it can run, and
    /// gives its handle; none for an owner gone.
    pub(crate) fn spawn<F: Future + Send + 'static>(
        &self,
        future: F,
    ) -> Option<JoinHandle<F::Output>>
    where
        F::Output: Send + 'static,
    {
        let shared = self.shared.upgrade()?;

        #[cfg(any(test, feature = "testing"))]
        if let Some(activity) = &shared.activity {
            return Some(
                shared
                    .runtime
                    .spawn(crate::testing::Tracked::new(future, Arc::clone(activity))),
            );
        }

        Some(shared.runtime.spawn(future))
    }
}

/// Spawns `future` on `runtime`, counted as a side's work on `clock`'s activity when a test's clock
/// counts one: what runs on a side's behalf with no owner of its own, a key set's ask say.
pub(crate) fn spawn_counted<F: Future<Output = ()> + Send + 'static>(
    (runtime, clock): (&Handle, &Arc<dyn Clock>),
    future: F,
) {
    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = clock.activity() {
        runtime.spawn(crate::testing::Tracked::new(future, activity));

        return;
    }

    // the clock counts activity for a test's kit alone
    #[cfg(not(any(test, feature = "testing")))]
    let _: &Arc<dyn Clock> = clock;

    runtime.spawn(future);
}

fn post<S>(shared: &Arc<Shared<S>>, job: Job<S>) -> Result<(), Disposed> {
    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = &shared.activity {
        activity.begin();
    }

    if CURRENT.with(Cell::get) == shared.id {
        shared
            .turn
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(job);

        return Ok(());
    }

    shared.jobs.send(job).map_err(|_closed| {
        #[cfg(any(test, feature = "testing"))]
        if let Some(activity) = &shared.activity {
            activity.end();
        }

        Disposed
    })
}

fn cover<S, F: Future<Output = ()> + Send + 'static>(shared: &Arc<Shared<S>>, future: F) {
    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = &shared.activity {
        shared
            .runtime
            .spawn(crate::testing::Tracked::new(future, Arc::clone(activity)));

        return;
    }

    shared.runtime.spawn(future);
}

// the owner's task: each job in its turn, then the jobs posted within it, until every handle is gone
async fn run<S>(
    mut state: S,
    (mut queue, shared): (mpsc::UnboundedReceiver<Job<S>>, Weak<Shared<S>>),
) {
    while let Some(job) = queue.recv().await {
        let Some(owner) = shared.upgrade() else {
            break;
        };

        CURRENT.with(|current| current.set(owner.id));
        job(&mut state);
        #[cfg(any(test, feature = "testing"))]
        let mut ran = 1_usize;

        loop {
            let next = owner
                .turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .pop_front();
            let Some(next) = next else {
                break;
            };

            next(&mut state);
            #[cfg(any(test, feature = "testing"))]
            {
                ran = ran.saturating_add(1);
            }
        }

        CURRENT.with(|current| current.set(0));
        #[cfg(any(test, feature = "testing"))]
        if let Some(activity) = &owner.activity {
            for _ in 0..ran {
                activity.end();
            }
        }
    }
}

/// What a job run on an owner gives, to wait for.
#[derive(Debug)]
pub(crate) struct Pending<T> {
    answer: Option<oneshot::Receiver<T>>,
}

impl<T> Future for Pending<T> {
    type Output = Result<T, Disposed>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.answer
            .as_mut()
            .map_or(Poll::Ready(Err(Disposed)), |answer| {
                Pin::new(answer)
                    .poll(context)
                    .map(|answer| answer.map_err(|_dropped| Disposed))
            })
    }
}
