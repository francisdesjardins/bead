//! One owner per router (decision 0044): a task of the application's runtime holds the router's
//! state and runs its jobs one at a time, in the order they came. A job is synchronous, so a turn
//! awaits nothing and no other job runs within it; what waits runs off the owner and posts its
//! outcome as a job of its own. A job posted within a turn of the same owner goes as that turn
//! ends, before any job queued after it: a call a listener makes. What a listener hands its router
//! back from within the turn that told it — an envelope its transport carries, a connection let go,
//! a dispose — goes behind every job queued, in a later turn, never within that one (spec 9.0).
//! A job that panics, the last resort past the guards at the sites the spec lets throw, ends its
//! owner at once: its state told, so what waits on it fails now with that panic for its reason, the
//! jobs left unrun, never going on over a state half changed (decision 0044).

use core::cell::Cell;
use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicUsize, Ordering};
use core::task::{Context, Poll};
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use tokio::sync::{mpsc, oneshot};

use crate::clock::Clock;
use crate::errors::Disposed;
use crate::platform::{self, Handle, JoinHandle};

#[cfg(test)]
mod tests;

/// A job of an owner's: what it runs, in its turn, on the state it holds.
pub(crate) type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

/// The state an owner holds, told as its owner ends on a job that panicked.
pub(crate) trait Owned: Send + 'static {
    /// Its owner ends: a job panicked with `panicked`, this state half changed with nothing to
    /// undo it; what waits on it is failed now, with that panic for its reason, before the state
    /// goes with its owner. Nothing, by default: what waits on it hears its owner gone.
    fn on_panic(&mut self, _panicked: &(dyn core::any::Any + Send)) {}
}

// each owner's own number, which a turn running marks on its thread
static OWNERS: AtomicUsize = AtomicUsize::new(1);

thread_local! {
    // the owner whose turn the current thread runs, 0 for none
    #[cfg_attr(
        all(windows, target_env = "gnu"),
        expect(
            clippy::missing_const_for_thread_local,
            reason = "the initializer is const; clippy misreads thread_local!'s expansion on windows-gnu"
        )
    )]
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
    ) -> Self
    where
        S: Owned,
    {
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

        platform::spawn(runtime, run(state, (queue, Arc::downgrade(&shared))));

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

    /// Posts `job` behind every job queued, within a turn of this owner's too: what a listener
    /// hands its router back is taken in a later turn, never within the one that told it (spec
    /// 9.0); an owner gone takes nothing, and the job goes with it.
    pub(crate) fn offer_behind(&self, job: Job<S>) {
        queue(&self.shared, job).ok();
    }

    /// Runs `job` on the owner behind every job queued, as [`Owner::offer_behind`] posts it, and
    /// gives what it gives.
    pub(crate) fn run_behind<T: Send + 'static, J: FnOnce(&mut S) -> T + Send + 'static>(
        &self,
        job: J,
    ) -> Pending<T> {
        let (reply, answer) = oneshot::channel();
        let posted = queue(
            &self.shared,
            Box::new(move |state| {
                reply.send(job(state)).ok();
            }),
        );

        Pending {
            answer: posted.ok().map(|()| answer),
        }
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

    /// Posts `job` behind every job queued, as [`Owner::offer_behind`] does, to an owner not gone.
    pub(crate) fn offer_behind(&self, job: Job<S>) {
        if let Some(shared) = self.shared.upgrade() {
            queue(&shared, job).ok();
        }
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
            return Some(platform::spawn(
                &shared.runtime,
                crate::testing::Tracked::new(future, Arc::clone(activity)),
            ));
        }

        Some(platform::spawn(&shared.runtime, future))
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
        platform::spawn(runtime, crate::testing::Tracked::new(future, activity));

        return;
    }

    // the clock counts activity for a test's kit alone
    #[cfg(not(any(test, feature = "testing")))]
    let _: &Arc<dyn Clock> = clock;

    platform::spawn(runtime, future);
}

// within a turn of this owner's, the job goes as that turn ends; else after every job queued
fn post<S>(shared: &Arc<Shared<S>>, job: Job<S>) -> Result<(), Disposed> {
    if CURRENT.with(Cell::get) != shared.id {
        return queue(shared, job);
    }

    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = &shared.activity {
        activity.begin();
    }

    shared
        .turn
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push_back(job);

    Ok(())
}

// the job goes after every job queued, in a turn of its own
fn queue<S>(shared: &Arc<Shared<S>>, job: Job<S>) -> Result<(), Disposed> {
    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = &shared.activity {
        activity.begin();
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
        platform::spawn(
            &shared.runtime,
            crate::testing::Tracked::new(future, Arc::clone(activity)),
        );

        return;
    }

    platform::spawn(&shared.runtime, future);
}

// the turn a thread runs, marked on it while the turn lasts: ! cleared as the turn ends, by a panic
// too, so no later post from that thread is taken for one of a turn that is over
struct Turn;

impl Turn {
    fn of(owner: usize) -> Self {
        CURRENT.with(|current| current.set(owner));

        Self
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        CURRENT.with(|current| current.set(0));
    }
}

// the owner's task: each job in its turn, then the jobs posted within it, until every handle is
// gone, or a job panics
async fn run<S: Owned>(
    mut state: S,
    (mut queue, shared): (mpsc::UnboundedReceiver<Job<S>>, Weak<Shared<S>>),
) {
    while let Some(job) = queue.recv().await {
        let Some(owner) = shared.upgrade() else {
            break;
        };
        let turn = Turn::of(owner.id);
        // ! the last resort: a job that panics leaves its state half changed, with nothing to undo
        // it, so its owner ends here, never going on over it (decision 0044)
        let mut panicked = catch_unwind(AssertUnwindSafe(|| job(&mut state))).err();
        let mut ran = 1_usize;

        while panicked.is_none() {
            let next = owner
                .turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .pop_front();
            let Some(next) = next else {
                break;
            };

            panicked = catch_unwind(AssertUnwindSafe(|| next(&mut state))).err();
            ran = ran.saturating_add(1);
        }

        if let Some(panicked) = panicked {
            // what the turn posted before its panic goes unrun; its state is told, once, a panic of
            // its own dropped; what telling it posted, the outcomes of what waited on it, goes
            // within the turn, each within a guard; and nothing queued runs
            let unrun = owner
                .turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .drain(..)
                .count();

            drop(catch_unwind(AssertUnwindSafe(|| {
                state.on_panic(&*panicked);
            })));

            loop {
                let next = owner
                    .turn
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .pop_front();
                let Some(next) = next else {
                    break;
                };

                drop(catch_unwind(AssertUnwindSafe(|| next(&mut state))));
                ran = ran.saturating_add(1);
            }

            queue.close();

            let mut queued = 0_usize;

            while queue.try_recv().is_ok() {
                queued = queued.saturating_add(1);
            }

            drop(turn);
            ended(&owner, ran.saturating_add(unrun).saturating_add(queued));

            break;
        }

        drop(turn);
        ended(&owner, ran);
    }
}

// the jobs a turn ran, or left unrun, counted done on a test's clock
fn ended<S>(owner: &Shared<S>, count: usize) {
    #[cfg(any(test, feature = "testing"))]
    if let Some(activity) = &owner.activity {
        for _ in 0..count {
            activity.end();
        }
    }

    #[cfg(not(any(test, feature = "testing")))]
    let _: (&Shared<S>, usize) = (owner, count);
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
