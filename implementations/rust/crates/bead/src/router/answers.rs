//! A result too large for one envelope, sent as a transfer (spec 12): its opening, then each chunk
//! credited; its call stays open until the last chunk is handed off, and the answer settles once
//! every envelope of it went, the first refusal to come failing it (spec 12.7).

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

/// A result sent as a transfer, while it is: the request it answers, its timer, what undoes it.
pub(crate) struct ResultSending<S> {
    pub(crate) dispatch: Arc<Dispatch>,
    pub(crate) timer: HeldTimer,
    pub(crate) finished: tokio_util::sync::CancellationToken,
    pub(crate) undo: Option<Undo<S>>,
}

/// What settles a result sent as a transfer: its answer, the sends handed to its transport and not
/// heard back from, and whether its last chunk went.
pub(crate) struct Settling<S> {
    done: Option<Responded<S>>,
    pending: u32,
    is_last_gone: bool,
}

impl<S> core::fmt::Debug for Settling<S> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Settling")
            .field("pending", &self.pending)
            .field("is_last_gone", &self.is_last_gone)
            .finish_non_exhaustive()
    }
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

// one more envelope of the transfer handed to its transport, not yet heard back from
fn went<S: Side>(state: &mut S, id: u64) {
    if let Some(settling) = state.core().settling.get_mut(&id) {
        settling.pending = settling.pending.saturating_add(1);
    }
}

// the answer settles, once: with the first outcome to come, nothing after it
fn answer<S: Side>(state: &mut S, (id, outcome): (u64, Result<(), CallError>)) {
    if let Some(Settling {
        done: Some(done), ..
    }) = state.core().settling.remove(&id)
    {
        done(state, outcome);
    }
}

// what the transport said of one envelope of the transfer: a refusal fails it; the last one heard
// once the last chunk went answers it
fn heard<S: Side>(state: &mut S, (id, outcome): (u64, Result<(), CallError>)) {
    if let Err(error) = outcome {
        return fail(state, (id, error));
    }

    let Some(settling) = state.core().settling.get_mut(&id) else {
        return;
    };

    settling.pending = settling.pending.saturating_sub(1);

    if settling.is_last_gone && settling.pending == 0 {
        answer(state, (id, Ok(())));
    }
}

/// Stops a result as its requester cancels, before another queued credit can send more.
pub(crate) fn cancel<S: Side>(state: &mut S, call: &CallAddress) {
    let Some(SendingFor::Result(id)) = state.core().sendings.purpose_of(call) else {
        return;
    };

    if stop(state, id).is_some() {
        answer(state, (id, Err(CallError::Cancelled(Some(call.call_id)))));
    }
}

// the call goes with it: its call id is the peer's to open again; what did not go out is undone
fn fail<S: Side>(state: &mut S, (id, error): (u64, CallError)) {
    if let Some(sending) = stop(state, id) {
        if let Some(undo) = sending.undo {
            undo(state);
        }

        close_answering(state, &sending.dispatch);
    }

    // ! a refusal fails the answer whenever it comes, the first to come told (spec 12.7)
    answer(state, (id, Err(error)));
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

    let timer = match timer {
        Ok(timer) => timer,
        Err(error) => {
            fail(state, (id, CallError::Refused(error)));
            return;
        }
    };
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

    if let Some(answering) = core.answering.answering_of_mut((&call, dispatch.id)) {
        answering.end(ending, || core.clock.monotonic());
    }
}

/// Sends one chunk of a result's transfer: the last one handed off ends the call.
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

            // * the answer waits for every envelope of the transfer, this one counted already
            if let Some(settling) = state.core().settling.get_mut(&id) {
                settling.is_last_gone = true;
            }
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            heard(state, (id, outcome));
        },
    ));
    went(state, id);
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
        },
    );
    core.settling.insert(
        id,
        Settling {
            done,
            pending: 0,
            is_last_gone: false,
        },
    );

    // the call's signal ends it: a cancel, the connection gone
    if let Some(signal) = signal {
        let owner = core.owner.clone();
        let call_id = call.call_id;

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
                Some(SignalReason::Cancelled) | None => CallError::Cancelled(Some(call_id)),
                Some(SignalReason::Disconnected(reason)) => CallError::Disconnected(reason),
            };
            // ! a transfer still open alone: past its last chunk, only a refusal its transport
            // gives fails it
            owner.offer(Box::new(move |state: &mut S| {
                if stop(state, id).is_some() {
                    answer(state, (id, Err(reason)));
                }
            }));
        });
    }

    progress(state, (&call, id));

    let mut options = Deliver::to(&call.connection_handle);

    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            heard(state, (id, outcome));
        },
    ));
    went(state, id);
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
