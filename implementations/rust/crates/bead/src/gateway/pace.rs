//! What a gateway writes a response with (spec/transcoding.md 10.2), as the other sides' writer of
//! a response holds it: its head held until its first slice passes `maximumUnsentBytes`, or until
//! it ends with none, so a response dropped before it writes nothing; each slice handed to its
//! body, taken as its host polls it, and held to the transport's send pace. On its own listener
//! what waits is the slices its body holds and what its watched socket holds; mounted, the slices
//! alone, a frame taken as its host polls it. A response past either bound is dropped and
//! reported, naming the bound.

use core::fmt;
use core::task::Waker;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::sync::oneshot;

use crate::clock::SharedClock;
use crate::http::wire::Flow;
use crate::net::bounds::{SendPace, SendPaceHooks, SendPaceOptions};
use crate::router::types::{BoxFuture, RouterError};

#[cfg(test)]
mod tests;

/// What a response is cut into, each slice its own deadline (transcoding 10.2).
pub(crate) const SLICE_BYTES: usize = 65_536;

/// What hears what a response's writing reports: a drop past a bound, in its words.
pub(crate) type Report = Arc<dyn Fn(RouterError) + Send + Sync>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A response's head: its status and its fields, in their order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Head {
    pub(crate) status: u16,
    pub(crate) fields: Vec<Field>,
}

/// A field of a response's head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Field {
    pub(crate) name: String,
    pub(crate) value: String,
}

impl Field {
    /// The field `name`, of `value`.
    pub(crate) fn of<N: Into<String>>(name: N, value: String) -> Self {
        Self {
            name: name.into(),
            value,
        }
    }
}

/// What a response's head comes to: written, its body to come, or cut before it, nothing written.
#[derive(Debug)]
pub(crate) enum Committed {
    /// Its head, written.
    Head(Head),
    /// Cut before its head.
    Cut,
}

/// What a response is held to, and where it reports.
pub(crate) struct OutletSettings {
    /// What may wait unsent, the slice it would add among it.
    pub(crate) maximum_unsent_bytes: u64,
    /// The pace its reader takes it at.
    pub(crate) pace: SendPaceOptions,
    /// The platform's clock, which the pace runs on.
    pub(crate) platform: SharedClock,
    /// Its socket's flow, on its own listener; none mounted.
    pub(crate) flow: Option<Arc<Flow>>,
    /// Where a drop is reported.
    pub(crate) report: Report,
}

// a slice handed to the body, and what tells its writer it was taken
struct Slice {
    bytes: Bytes,
    taken: oneshot::Sender<bool>,
}

#[derive(Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "a response's marks, each set apart from the others, as the other sides' writer holds them"
)]
struct OutletState {
    head: Option<Head>,
    committed: Option<oneshot::Sender<Committed>>,
    is_committed: bool,
    slices: VecDeque<Slice>,
    unsent: u64,
    is_ended: bool,
    is_cut: bool,
    is_gone: bool,
    waker: Option<Waker>,
    pace: Option<SendPace>,
    on_gone: Vec<Box<dyn FnOnce() + Send>>,
}

impl OutletState {
    // its head goes, once, where none went or was cut
    fn commit(&mut self) {
        if self.is_committed {
            return;
        }

        self.is_committed = true;

        if let Some(committed) = self.committed.take() {
            let head = self.head.take().unwrap_or(Head {
                status: 500,
                fields: Vec::new(),
            });

            committed.send(Committed::Head(head)).ok();
        }
    }

    fn wake(&mut self) {
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }

    // every slice not taken told so, and what waits on it let go
    fn let_go(&mut self) -> Option<SendPace> {
        for slice in self.slices.drain(..) {
            slice.taken.send(false).ok();
        }

        self.unsent = 0;
        self.pace.take()
    }
}

/// What both ends of a response share: its state, and what it is held to.
pub(crate) struct OutletShared {
    state: Mutex<OutletState>,
    settings: OutletSettings,
}

impl fmt::Debug for OutletShared {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OutletShared")
            .field("maximum_unsent_bytes", &self.settings.maximum_unsent_bytes)
            .finish_non_exhaustive()
    }
}

/// What a frame polled of a response's body is.
#[derive(Debug)]
pub(crate) enum Polled {
    /// A slice.
    Slice(Bytes),
    /// Its end, whole.
    Ended,
    /// Cut before its end.
    Cut,
    /// Nothing yet: its waker kept.
    Pending,
}

impl OutletShared {
    /// The next frame of its body, `waker` kept where none came yet.
    pub(crate) fn poll(&self, waker: &Waker) -> Polled {
        let mut state = locked(&self.state);

        if let Some(slice) = state.slices.pop_front() {
            let length = u64::try_from(slice.bytes.len()).unwrap_or(u64::MAX);

            state.unsent = state.unsent.saturating_sub(length);
            slice.taken.send(true).ok();

            return Polled::Slice(slice.bytes);
        }

        if state.is_cut {
            return Polled::Cut;
        }

        if state.is_ended {
            return Polled::Ended;
        }

        state.waker = Some(waker.clone());

        Polled::Pending
    }

    /// Whether its body ends with nothing more: ended, every slice taken.
    pub(crate) fn is_end_stream(&self) -> bool {
        let state = locked(&self.state);

        state.is_ended && !state.is_cut && state.slices.is_empty()
    }

    /// Its response is over, its body let go or its head never asked: what waits is let go, and
    /// what hears its end is told, once.
    pub(crate) fn gone(&self) {
        let (pace, heard) = {
            let mut state = locked(&self.state);

            if state.is_gone {
                return;
            }

            state.is_gone = true;
            state.committed = None;

            let pace = state.let_go();

            (pace, core::mem::take(&mut state.on_gone))
        };

        // ! on its own listener the pace outlives its body: hyper lets a body go once it gave its
        // end, its bytes still in the socket, which its flow judges until its connection ends
        if let Some(pace) = pace
            && self.settings.flow.is_none()
        {
            pace.stop();
        }

        // ! told outside its lock: what hears it may write again, or release what it holds
        for hear in heard {
            hear();
        }
    }
}

/// What writes a response, once its exchange is judged: its head, its slices, its end, or its
/// cut. Cloned, it writes the same response.
#[derive(Clone, Debug)]
pub(crate) struct Outlet {
    shared: Arc<OutletShared>,
}

impl Outlet {
    /// A response held to `settings`, and what its head comes to.
    pub(crate) fn new(settings: OutletSettings) -> (Self, oneshot::Receiver<Committed>) {
        let (committed, head) = oneshot::channel();
        let state = OutletState {
            committed: Some(committed),
            ..OutletState::default()
        };

        (
            Self {
                shared: Arc::new(OutletShared {
                    state: Mutex::new(state),
                    settings,
                }),
            },
            head,
        )
    }

    /// What its body reads from.
    pub(crate) fn shared(&self) -> Arc<OutletShared> {
        Arc::clone(&self.shared)
    }

    /// Its head, written with its first slice or its end; the first given stands.
    pub(crate) fn head(&self, head: Head) {
        let mut state = locked(&self.shared.state);

        if !state.is_committed && state.head.is_none() {
            state.head = Some(head);
        }
    }

    /// Writes `bytes` as one slice, its head first where it has not gone: true once its body took
    /// it, false once it never will. A slice that would leave more than `maximumUnsentBytes`
    /// unsent drops the response before it is written, reported.
    pub(crate) fn write(&self, bytes: Bytes) -> BoxFuture<bool> {
        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let maximum = self.shared.settings.maximum_unsent_bytes;
        let (taken, waiting) = oneshot::channel();
        let pace = {
            let mut state = locked(&self.shared.state);

            if state.is_gone || state.is_cut || state.is_ended {
                return Box::pin(async { false });
            }

            // ! judged before the slice goes, what its socket holds among what waits (10.2)
            if self.unsent_of(&state).saturating_add(length) > maximum {
                drop(state);
                self.cut(Some(format!(
                    "the response is dropped: maximumUnsentBytes {maximum} bytes"
                )));

                return Box::pin(async { false });
            }

            state.commit();
            state.unsent = state.unsent.saturating_add(length);
            state.slices.push_back(Slice { bytes, taken });
            state.wake();

            if state.pace.is_none() {
                state.pace = Some(self.pace_of());
            }

            state.pace.clone()
        };

        if let Some(pace) = pace {
            pace.hand(length);
        }

        Box::pin(async move { waiting.await.unwrap_or(false) })
    }

    /// Ends it whole once its slices are taken, its head first where it has not gone.
    pub(crate) fn end(&self) {
        let mut state = locked(&self.shared.state);

        if state.is_gone || state.is_cut || state.is_ended {
            return;
        }

        state.is_ended = true;
        state.commit();
        state.wake();
    }

    /// Cuts it: before its head, nothing is written; after, its body fails. `why`, where given,
    /// is reported, once.
    pub(crate) fn cut(&self, why: Option<String>) {
        let pace = {
            let mut state = locked(&self.shared.state);

            if state.is_gone || state.is_cut || (state.is_ended && state.slices.is_empty()) {
                return;
            }

            state.is_cut = true;

            if !state.is_committed {
                state.is_committed = true;

                if let Some(committed) = state.committed.take() {
                    committed.send(Committed::Cut).ok();
                }
            }

            let pace = state.let_go();

            state.wake();
            pace
        };

        if let Some(pace) = pace {
            pace.stop();
        }

        if let Some(why) = why {
            (self.shared.settings.report)(RouterError::Other(Arc::new(std::io::Error::other(why))));
        }
    }

    /// Calls `hear` once its response is over, at once where it is already.
    pub(crate) fn on_gone(&self, hear: Box<dyn FnOnce() + Send>) {
        let mut state = locked(&self.shared.state);

        if state.is_gone {
            drop(state);
            hear();

            return;
        }

        state.on_gone.push(hear);
    }

    // whether its response is over: its body let go, or cut
    fn is_over(&self) -> bool {
        let state = locked(&self.shared.state);

        state.is_gone || state.is_cut
    }

    // what waits for its reader: its slices, and on its own listener a socket that holds what was
    // written to it
    fn unsent_of(&self, state: &OutletState) -> u64 {
        let blocked = self
            .shared
            .settings
            .flow
            .as_ref()
            .is_some_and(|flow| flow.is_blocked());

        state.unsent.saturating_add(u64::from(blocked))
    }

    // the pace its reader is held to: late, the response is dropped, and on its own listener its
    // socket with it
    fn pace_of(&self) -> SendPace {
        let settings = &self.shared.settings;
        let options = settings.pace;
        let unsent: Weak<OutletShared> = Arc::downgrade(&self.shared);
        let late: Weak<OutletShared> = Arc::downgrade(&self.shared);
        let (watched, flow) = (settings.flow.clone(), settings.flow.clone());
        let report = Arc::clone(&settings.report);
        let pace = SendPace::new(
            SendPaceHooks {
                // * once its body is let go, what its socket still holds alone
                unsent: Box::new(move || {
                    unsent.upgrade().map_or_else(
                        || u64::from(watched.as_ref().is_some_and(|flow| flow.is_blocked())),
                        |shared| {
                            let outlet = Self { shared };
                            let state = locked(&outlet.shared.state);

                            outlet.unsent_of(&state)
                        },
                    )
                }),
                late: Box::new(move || {
                    let why = format!(
                        "the response is dropped: minimumSendBytesPerSecond {} after sendGracePeriod {}ms",
                        options.minimum_send_bytes_per_second,
                        options.send_grace_period.as_millis()
                    );
                    let outlet = late.upgrade().map(|shared| Self { shared });

                    // * a response its body still writes is cut, which reports it; one its body
                    // let go, its bytes in its socket, is reported here
                    match outlet.filter(|outlet| !outlet.is_over()) {
                        Some(outlet) => outlet.cut(Some(why)),
                        None => report(RouterError::Other(Arc::new(std::io::Error::other(why)))),
                    }

                    if let Some(flow) = &flow {
                        flow.abort();
                    }
                }),
            },
            (options, Arc::clone(&settings.platform)),
        );

        if let Some(flow) = &settings.flow {
            flow.pace(pace.clone());
        }

        pace
    }
}
