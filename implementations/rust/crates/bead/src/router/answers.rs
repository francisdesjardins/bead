//! A result too large for one envelope, sent as a transfer (spec 12): its opening, then each chunk
//! credited; its call stays open until the last chunk is handed off, and the answer settles once
//! that one went, which ends the call.

use std::sync::Arc;

use crate::constants::ProtocolCode;
use crate::envelope::{Envelope, FailureHeader, ResultHeader};
use crate::errors::CallError;
use crate::metrics::CallEnding;
use crate::router::core::{
    Deliver, Dispatch, Responded, Side, Undo, close_answering, deliver, send_reporting, signal_of,
};
use crate::router::parts::{HeldTimer, Placement, SendingFor, cancel_timer};
use crate::router::transfer::{Chunk, OutgoingTransfer};
use crate::router::types::{CallAddress, SignalReason};

/// A result sent as a transfer, while it is: the request it answers, its timer, what settles it.
pub(crate) struct ResultSending<S> {
    pub(crate) dispatch: Arc<Dispatch>,
    pub(crate) timer: HeldTimer,
    pub(crate) finished: tokio_util::sync::CancellationToken,
    pub(crate) undo: Option<Undo<S>>,
    pub(crate) done: Option<Responded<S>>,
}

impl<S> core::fmt::Debug for ResultSending<S> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ResultSending")
            .field("dispatch", &self.dispatch.id)
            .finish_non_exhaustive()
    }
}

fn call_of(dispatch: &Dispatch) -> CallAddress {
    CallAddress {
        connection_handle: Arc::clone(&dispatch.connection_handle),
        call_id: dispatch.header.call_id,
    }
}

// nothing more goes, and nothing more ends it: what it held taken out
fn stop<S: Side>(state: &mut S, id: u64) -> Option<ResultSending<S>> {
    let core = state.core();
    let mut sending = core.results.remove(&id)?;

    core.sendings
        .close(&call_of(&sending.dispatch), SendingFor::Result(id));
    cancel_timer(&mut sending.timer);
    sending.finished.cancel();

    Some(sending)
}

// the call goes with it: its call id is the peer's to open again; what did not go out is undone
fn fail<S: Side>(state: &mut S, (id, error): (u64, CallError)) {
    let Some(sending) = stop(state, id) else {
        return;
    };

    if let Some(undo) = sending.undo {
        undo(state);
    }

    close_answering(state, &sending.dispatch);

    if let Some(done) = sending.done {
        done(state, Err(error));
    }
}

/// What the transfer does sets its timer going again; silent too long, it ends, and the peer is
/// told.
pub(crate) fn progress<S: Side>(state: &mut S, (_call, id): (&CallAddress, u64)) {
    let core = state.core();

    if !core.results.contains_key(&id) {
        return;
    }

    let timeout = core.limits.transfer_inactivity_timeout;
    let timer = core.after(timeout, move |state: &mut S| {
        let core = state.core();
        let Some(dispatch) = core
            .results
            .get(&id)
            .map(|sending| Arc::clone(&sending.dispatch))
        else {
            return;
        };
        let stalled = core.failure(ProtocolCode::TRANSFER_STALLED).saying(format!(
            "no credit came for {} milliseconds",
            timeout.as_millis()
        ));
        let call = call_of(&dispatch);

        end_counted(
            state,
            (
                &dispatch,
                CallEnding::of_failure(stalled.code(), stalled.scope()),
            ),
        );
        fail(state, (id, CallError::Failure(stalled.clone())));
        send_reporting(
            state,
            (
                Envelope::Failure {
                    header: FailureHeader {
                        call_id: call.call_id,
                        credential: None,
                    },
                    failure: stalled.record(),
                },
                &call.connection_handle,
            ),
        );
    });

    if let Some(sending) = state.core().results.get_mut(&id) {
        cancel_timer(&mut sending.timer);
        sending.timer = Some(timer);
    } else {
        timer.cancel();
    }
}

/// Counts the call `dispatch` opened ended, as `ending` says, while it is its.
pub(crate) fn end_counted<S: Side>(state: &mut S, (dispatch, ending): (&Dispatch, CallEnding)) {
    let call = call_of(dispatch);
    let core = state.core();

    if let Some(answering) = core.answering.get_mut(&call)
        && answering.dispatched == dispatch.id
        && !answering.is_ended
        && let Some(series) = answering.series.clone()
    {
        // * read only for a call counted (spec/debugging.md 3.1)
        let now = core.clock.monotonic();

        answering.is_ended = true;
        series.end(
            ending,
            crate::router::core::microseconds_of(now.saturating_sub(answering.started_at)),
        );
    }
}

/// Sends one chunk of a result's transfer: the last one handed off answers the call.
pub(crate) fn send_chunk<S: Side>(state: &mut S, (call, id, chunk): (&CallAddress, u64, Chunk)) {
    let envelope = Placement::chunk_envelope_of(call.call_id, &chunk);
    let mut options = Deliver::to(&call.connection_handle);
    let is_last = chunk.is_last;
    let handed = call.clone();

    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        if !is_last {
            return progress(state, (&handed, id));
        }

        if let Some(sending) = stop(state, id) {
            end_counted(state, (&sending.dispatch, CallEnding::Result));
            close_answering(state, &sending.dispatch);

            // the answer settles once the last chunk went
            let done = sending.done;

            state.core().settled.insert(id, done);
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| match outcome {
            Ok(()) => {
                if is_last && let Some(Some(done)) = state.core().settled.remove(&id) {
                    done(state, Ok(()));
                }
            }
            Err(error) => {
                if let Some(Some(done)) = state.core().settled.remove(&id) {
                    done(state, Err(error));
                } else {
                    fail(state, (id, error));
                }
            }
        },
    ));
    deliver(state, (envelope, options));
}

/// What undoes a result's side effects should it not go, and what hears whether it went.
pub(crate) type Completion<S> = (Option<Undo<S>>, Option<Responded<S>>);

/// Sends a result as a transfer: its opening, then each chunk credited.
pub(crate) fn send_result<S: Side>(
    state: &mut S,
    (outgoing, dispatch, (undo, done)): (OutgoingTransfer, Arc<Dispatch>, Completion<S>),
) {
    let call = call_of(&dispatch);
    let id = state.core().draw_id();
    let opening = outgoing.opening();
    let total = outgoing.total();
    let signal = signal_of(state, &dispatch);
    let core = state.core();
    let finished = tokio_util::sync::CancellationToken::new();

    // kept before its opening goes, so a credit that comes back as it goes finds it
    core.sendings
        .open(&call, (outgoing, SendingFor::Result(id)));
    core.results.insert(
        id,
        ResultSending {
            dispatch: Arc::clone(&dispatch),
            timer: None,
            finished: finished.clone(),
            undo,
            done,
        },
    );

    // the call's signal ends it: a cancel, the connection gone
    if let Some(signal) = signal {
        let owner = core.owner.clone();

        core.owner.cover(async move {
            let token = signal.token().clone();

            // * waits no longer than the transfer
            if finished
                .run_until_cancelled(token.cancelled())
                .await
                .is_none()
            {
                return;
            }

            let reason = match signal.reason() {
                Some(SignalReason::Cancelled) | None => CallError::Cancelled,
                Some(SignalReason::Disconnected(reason)) => CallError::Disconnected(reason),
            };
            owner.offer(Box::new(move |state: &mut S| {
                if let Some(sending) = stop(state, id)
                    && let Some(done) = sending.done
                {
                    done(state, Err(reason));
                }
            }));
        });
    }

    progress(state, (&call, id));

    let mut options = Deliver::to(&call.connection_handle);

    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            if let Err(error) = outcome {
                fail(state, (id, error));
            }
        },
    ));
    deliver(
        state,
        (
            Envelope::Result {
                header: ResultHeader {
                    call_id: call.call_id,
                    total: Some(total),
                    credential: None,
                },
                payload: opening,
            },
            options,
        ),
    );
}
