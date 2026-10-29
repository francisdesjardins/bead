//! The calls a side starts (spec 9, 10, 12): each request drawn its call id and held until its
//! answer, its timer and its cancel, the answer and the result's transfer paired with it, and its
//! call id reserved once it ends.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::constants::{CredentialScheme, ProtocolCode};
use crate::duration::{NEVER, hold};
use crate::envelope::{
    CancelHeader, ChunkHeader, Credential, Envelope, Header, RequestHeader, header_bytes_of,
};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::{Failure, ProcedureAddress};
use crate::metrics::{CallEnding, ProcedureSeries};
use crate::router::core::{
    Answer, Deliver, Side, deliver, microseconds_of, receive_unplaced, reported, send_credits,
    send_reporting,
};
use crate::router::parts::{
    CallReply, OnSent, PendingRequest, Placed, Placement, Reservation, ResultReceiving, SendingFor,
    cancel_timer,
};
use crate::router::transfer::{Chunk, ChunkOutcome, OutgoingTransfer};
use crate::router::types::{
    CallAddress, ConnectionHandle, ResolvedRequestOptions, RouterActivity, RouterResult,
    reservation_of,
};

/// A call this side makes, as its router hands it to its core.
pub(crate) struct CoreRequest {
    pub(crate) connection_handle: ConnectionHandle,
    pub(crate) credential: Option<Credential>,
    pub(crate) on_call_id: Option<Box<dyn FnOnce(u32) + Send>>,
    pub(crate) on_sent: Option<OnSent>,
    pub(crate) opens_subscription: bool,
    pub(crate) paced: bool,
    pub(crate) options: ResolvedRequestOptions,
    pub(crate) procedure: ProcedureAddress,
    pub(crate) maximum_payload_bytes: Option<u64>,
    pub(crate) refusal: Option<CallError>,
    pub(crate) series: Option<ProcedureSeries>,
    pub(crate) transport_credential: Option<String>,
}

impl core::fmt::Debug for CoreRequest {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("CoreRequest")
            .field("connection_handle", &self.connection_handle)
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

/// How a call this side made ended, by what its router settled it with (spec/debugging.md 9.6).
pub(crate) fn made_ending_of(outcome: &Result<RouterResult, CallError>) -> CallEnding {
    match outcome {
        Ok(_) => CallEnding::Result,
        Err(CallError::Failure(failure)) => CallEnding::of_failure(failure.code(), failure.scope()),
        Err(CallError::TimedOut(_)) => CallEnding::Timeout,
        Err(CallError::Cancelled) => CallEnding::Cancelled,
        Err(CallError::Disconnected(_)) => CallEnding::Closed,
        Err(_) => CallEnding::Error,
    }
}

/// Refuses a credential no header of its request holds, whatever its payload (spec 4.4).
///
/// # Errors
///
/// A [`ProgrammerError`] for a header that would pass 1,020 bytes.
pub(crate) fn assert_header_holds(request: &CoreRequest) -> Result<(), ProgrammerError> {
    let is_asked = request.credential.as_ref().is_some_and(|credential| {
        !matches!(
            credential.scheme(),
            CredentialScheme::OPAQUE | CredentialScheme::ELSEWHERE
        )
    });

    header_bytes_of(&Header::Request(RequestHeader {
        call_id: 1,
        service_id: request.procedure.service_id.max(1),
        procedure_id: request.procedure.procedure_id.max(1),
        destination_id: request.options.destination_id,
        opens_subscription: request.opens_subscription,
        paced: request.paced,
        total: None,
        credential: if is_asked {
            request.credential.clone()
        } else {
            None
        },
    }))
    .map(|_| ())
}

// how long a call id stays reserved once its call ends: as its timeout says — and, once its result
// came in part, as long as the peer keeps the call abandoned, should that be longer
fn reserved_for(request: &PendingRequest, transfer_inactivity: Duration) -> Option<Duration> {
    if request.receiving.is_none() {
        request.timeout
    } else {
        Some(reservation_of(request.timeout).max(transfer_inactivity))
    }
}

/// Reserves this side's `call_id` on its connection for `timeout`, or the default time for none
/// or never: reserved twice, the later end stands.
pub(crate) fn reserve<S: Side>(state: &mut S, (call, timeout): (&CallAddress, Option<Duration>)) {
    let core = state.core();
    let lasts = reservation_of(timeout);
    let ends = core.now().saturating_add(lasts);
    let previous = core
        .pending
        .reservations
        .get(&call.connection_handle)
        .and_then(|reserved| reserved.get(&call.call_id))
        .map(|reservation| reservation.ends);

    if previous.is_some_and(|previous| previous >= ends) {
        return;
    }

    if let Some(mut previous) = core
        .pending
        .reservations
        .get_mut(&call.connection_handle)
        .and_then(|reserved| reserved.remove(&call.call_id))
    {
        cancel_timer(&mut previous.timer);
    }

    let id = core.draw_id();
    let forgotten = call.clone();
    let timer = core.after(lasts, move |state: &mut S| {
        state.core().pending.forget_reservation(&forgotten, id);
    });

    core.pending
        .reservations
        .entry(Arc::clone(&call.connection_handle))
        .or_default()
        .insert(
            call.call_id,
            Reservation {
                ends,
                id,
                timer: Some(timer),
            },
        );
}

// tells the peer a call this side opened is cancelled, once, and reserves its call id in the same
// turn, so nothing drawn meanwhile takes it
fn send_cancel<S: Side>(state: &mut S, (call, timeout): (&CallAddress, Option<Duration>)) {
    let core = state.core();

    // a disposed router sends nothing; a call id reserved already had its cancel
    if core.is_disposed()
        || core
            .pending
            .is_reserved(call.call_id, &call.connection_handle)
    {
        return;
    }

    reserve(state, (call, timeout));
    send_reporting(
        state,
        (
            Envelope::Cancel {
                header: CancelHeader {
                    call_id: call.call_id,
                },
            },
            &call.connection_handle,
        ),
    );
}

// takes a call out — only while it is the one of `only`, when given — what it holds going with it:
// its timer, and the transfers it sends and receives
fn forget<S: Side>(
    state: &mut S,
    (call, only): (&CallAddress, Option<u64>),
) -> Option<PendingRequest> {
    let core = state.core();
    let mut request = core.pending.forget(call, only)?;

    cancel_timer(&mut request.timer);

    if let Some(receiving) = &request.receiving {
        let credits = core.receivings.close(receiving.transfer);

        send_credits(state, credits);
    }

    if request.sending {
        state
            .core()
            .sendings
            .close(call, SendingFor::Request(request.id));
    }

    Some(request)
}

// settles a call this side made, once
fn settle(request: &mut PendingRequest, outcome: Result<RouterResult, CallError>) {
    if let Some(reply) = request.reply.take() {
        reply(outcome);
    }
}

// ends a call this side waits on before its answer came whole: forgotten first, so what it holds
// goes with it, then the peer told to cancel it, then the caller told; a call ended already ends no
// more
fn end_pending<S: Side>(state: &mut S, (reason, call, id): (CallError, &CallAddress, u64)) {
    let inactivity = state.core().limits.transfer_inactivity_timeout;
    let Some(mut request) = forget(state, (call, Some(id))) else {
        return;
    };

    send_cancel(state, (call, reserved_for(&request, inactivity)));
    settle(&mut request, Err(reason));
}

// sets a waiting call's timer going again: past `delay`, it times out; none for never, nor for a
// call ended already
fn wait<S: Side>(state: &mut S, (delay, call, id): (Option<Duration>, &CallAddress, u64)) {
    let core = state.core();

    if !core.pending.is(call, id) {
        return;
    }

    let timer = delay
        .filter(|&delay| delay != NEVER && !delay.is_zero())
        .map(|delay| {
            let ended = call.clone();

            core.after(delay, move |state: &mut S| {
                end_pending(state, (CallError::TimedOut(delay), &ended, id));
            })
        });

    if let Some(request) = state.core().pending.get_mut(call) {
        cancel_timer(&mut request.timer);
        request.timer = timer;
    } else if let Some(timer) = timer {
        timer.cancel();
    }
}

/// A request's transfer progressing: its call waits on its inactivity anew.
pub(crate) fn request_progress<S: Side>(state: &mut S, (call, id): (&CallAddress, u64)) {
    let inactivity = state.core().limits.transfer_inactivity_timeout;

    wait(state, (Some(inactivity), call, id));
}

/// Sends one chunk of a request's transfer: the last one handed off, its call waits on its timeout.
pub(crate) fn send_request_chunk<S: Side>(
    state: &mut S,
    (call, id, chunk): (&CallAddress, u64, Chunk),
) {
    let envelope = Placement::chunk_envelope_of(call.call_id, &chunk);
    let mut options = Deliver::to(&call.connection_handle);
    let is_last = chunk.is_last;
    let (handed, settled) = (call.clone(), call.clone());

    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        if is_last {
            // the last one handed off, the call waits on its timeout — unless a result opened as it
            // went, which waits on its own inactivity
            let timeout = state
                .core()
                .pending
                .get(&handed)
                .filter(|request| request.id == id && request.receiving.is_none())
                .map(|request| request.timeout);

            if let Some(timeout) = timeout {
                wait(state, (timeout, &handed, id));
            }
        } else {
            request_progress(state, (&handed, id));
        }
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            match outcome {
                Ok(()) if is_last => {
                    state.activity(RouterActivity::Request, &settled.connection_handle);
                }
                Ok(()) => {}
                // one that cannot go out ends the call: the peer, which holds a part of it, cancels it
                Err(error) => end_pending(state, (error, &settled, id)),
            }
        },
    ));
    deliver(state, (envelope, options));
}

// the hand-off of a request, whole or a transfer's opening: sent, heard
fn on_request_hand_off<S: Side>(state: &mut S, (call, id): (&CallAddress, u64)) {
    if let Some(request) = state
        .core()
        .pending
        .get_mut(call)
        .filter(|request| request.id == id)
    {
        request.is_sent = true;

        if let Some(on_sent) = request.on_sent.as_mut() {
            on_sent(true);
        }
    }
}

// a request the transport refused, after it was handed over or before: heard, the call rejected
fn on_request_refused<S: Side>(state: &mut S, (call, id, error): (&CallAddress, u64, CallError)) {
    if let Some(mut request) = forget(state, (call, Some(id))) {
        // handed over, then refused by the transport: nothing of it went out
        if request.is_sent
            && let Some(on_sent) = request.on_sent.as_mut()
        {
            on_sent(false);
        }

        settle(&mut request, Err(error));
    }
}

/// Makes a call: it settles as its answer, its timer, its signal or its connection does.
#[expect(
    clippy::too_many_lines,
    reason = "a call made through each step of spec 9.1 in its order"
)]
pub(crate) fn request<S: Side>(
    state: &mut S,
    (payload, request, reply): (Bytes, CoreRequest, CallReply),
) {
    let core = state.core();
    let procedure = request.procedure;
    let destination_id = request.options.destination_id;
    let handle = Arc::clone(&request.connection_handle);
    let fail =
        |failure: Failure| CallError::Failure(failure.of_call(Some(procedure), destination_id));

    // what no call can take draws nothing, and is no call: it is not counted
    if request.maximum_payload_bytes == Some(0) {
        return reply(Err(CallError::Refused(ProgrammerError::new(
            "a payload's limit is a whole number above 0, not 0",
        ))));
    }

    let timeout = match hold("a call's timeout", request.options.timeout) {
        Ok(timeout) => timeout,
        Err(error) => return reply(Err(CallError::Refused(error))),
    };

    // ! a credential no header of its request holds, whatever its payload, is a programmer's
    // error, thrown before the call starts and not counted (spec 4.4)
    if let Err(error) = assert_header_holds(&request) {
        return reply(Err(CallError::Refused(error)));
    }

    // an aborted signal draws nothing
    if request
        .options
        .signal
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return reply(Err(CallError::Cancelled));
    }

    // the series it counts into, a requester's or _OTHER's; none while the router counts nothing
    let series = core.metrics.as_ref().map(|metrics| {
        request
            .series
            .clone()
            .unwrap_or_else(|| metrics.other_client().clone())
    });
    let clock = Arc::clone(&core.clock);
    // * read only for a call counted (spec/debugging.md 3.1)
    let started_at = if series.is_some() {
        core.now()
    } else {
        Duration::ZERO
    };

    // * the call starts once nothing makes it a programmer's error, and ends wherever its router
    // settles it, each refusal after counted
    if let Some(series) = &series {
        series.start();
    }

    let reply: CallReply = match series {
        None => reply,
        Some(series) => Box::new(move |outcome: Result<RouterResult, CallError>| {
            let elapsed = clock.monotonic().saturating_sub(started_at);

            series.end(made_ending_of(&outcome), microseconds_of(elapsed));
            reply(outcome);
        }),
    };

    if let Some(refusal) = request.refusal {
        return reply(Err(refusal));
    }

    let core = state.core();

    // ! past the calls its peer answers at once, it fails before it goes, drawing no call id
    if core.pending.count_on(&handle) >= core.limits.maximum_answering_calls {
        let failure = core
            .failure(ProtocolCode::CAPACITY_EXCEEDED)
            .saying(format!(
                "the calls waiting on {handle} are {} at most",
                core.limits.maximum_answering_calls
            ));

        return reply(Err(fail(failure)));
    }

    let Some(call_id) = draw_call_id(state, &handle) else {
        let failure = state
            .core()
            .failure(ProtocolCode::CAPACITY_EXCEEDED)
            .saying(format!("every call id of {handle} is in use"));

        return reply(Err(fail(failure)));
    };
    let header = RequestHeader {
        call_id,
        service_id: procedure.service_id,
        procedure_id: procedure.procedure_id,
        destination_id,
        opens_subscription: request.opens_subscription,
        paced: request.paced,
        total: None,
        credential: request.credential.clone(),
    };
    let core = state.core();
    // how it goes is decided before anything is kept of it: past its limit, nothing goes
    let maximum_payload_bytes = core
        .placement
        .payload_limit_of(request.maximum_payload_bytes);
    let placed = match core.placement.transfer_of(
        &payload,
        (&Header::Request(header.clone()), maximum_payload_bytes),
    ) {
        Ok(placed) => placed,
        Err(failure) => return reply(Err(fail(failure.about(&Header::Request(header))))),
    };
    let id = core.draw_id();
    let call = CallAddress {
        connection_handle: Arc::clone(&handle),
        call_id,
    };
    let (ended, watched) = oneshot::channel::<()>();

    core.pending.add(
        &call,
        PendingRequest {
            id,
            destination_id,
            is_sent: false,
            maximum_payload_bytes,
            on_sent: request.on_sent,
            procedure,
            receiving: None,
            reply: Some(Box::new(move |outcome| {
                drop(ended);
                reply(outcome);
            })),
            sending: false,
            timeout: Some(timeout),
            timer: None,
        },
    );

    if let Some(signal) = request.options.signal.clone() {
        watch_signal(state, ((signal, watched), (call.clone(), id)));
    }

    if let Some(on_call_id) = request.on_call_id {
        on_call_id(call_id);
    }

    let transport_credential = request.transport_credential;

    if let Placed::Transfer(outgoing) = placed {
        return send_request(
            state,
            ((outgoing, header), (transport_credential, &call, id)),
        );
    }

    wait(state, (Some(timeout), &call, id));

    let mut options = Deliver::to(&handle);
    let (handed, refused) = (call.clone(), call);

    options.credential = transport_credential;
    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        on_request_hand_off(state, (&handed, id));
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| match outcome {
            Ok(()) => state.activity(RouterActivity::Request, &refused.connection_handle),
            Err(error) => on_request_refused(state, (&refused, id, error)),
        },
    ));
    deliver(state, (Envelope::Request { header, payload }, options));
}

// a call id of this side's for `handle`, skipping those waited on, reserved, or in use by the side
fn draw_call_id<S: Side>(state: &mut S, handle: &ConnectionHandle) -> Option<u32> {
    let mut candidate = state.core().pending.draw((handle, |_| false))?;
    let first = candidate;

    // the side's own call ids in use, a subscription's, are skipped too
    loop {
        if !state.is_call_id_in_use(candidate, handle) {
            return Some(candidate);
        }

        candidate = state.core().pending.draw((handle, |_| false))?;

        if candidate == first {
            return None;
        }
    }
}

// a call's signal: cancelled, the call ends — the peer told first, when its request went out
fn watch_signal<S: Side>(
    state: &mut S,
    ((signal, watched), (call, id)): (
        (CancellationToken, oneshot::Receiver<()>),
        (CallAddress, u64),
    ),
) {
    let owner = state.core().owner.clone();

    state.core().owner.cover(async move {
        // * waits no longer than its call: settled, the call drops what it was watched by
        let ended = CancellationToken::new();
        let watching = ended.clone();
        let cancelled_first = watching
            .run_until_cancelled(async move {
                tokio::pin!(watched);

                let cancel = signal.cancelled();

                tokio::pin!(cancel);

                core::future::poll_fn(|context| {
                    use core::future::Future;

                    if cancel.as_mut().poll(context).is_ready() {
                        return core::task::Poll::Ready(true);
                    }

                    watched.as_mut().poll(context).map(|_ended| false)
                })
                .await
            })
            .await;

        drop(ended);

        if cancelled_first == Some(true) {
            owner.offer(Box::new(move |state: &mut S| {
                cancelled(state, (&call, id));
            }));
        }
    });
}

// ended by its signal: gone out and unanswered, the peer is told before the caller hears of it,
// so a call made again in its place goes out behind the cancel
fn cancelled<S: Side>(state: &mut S, (call, id): (&CallAddress, u64)) {
    let inactivity = state.core().limits.transfer_inactivity_timeout;
    let Some(mut request) = forget(state, (call, Some(id))) else {
        return;
    };

    if request.is_sent {
        send_cancel(state, (call, reserved_for(&request, inactivity)));
    }

    settle(&mut request, Err(CallError::Cancelled));
}

// a request as a transfer: its opening, then each chunk credited; the call waits on the transfer's
// inactivity, then on its own timeout once the last chunk is handed off
fn send_request<S: Side>(
    state: &mut S,
    ((outgoing, header), (transport_credential, call, id)): (
        (OutgoingTransfer, RequestHeader),
        (Option<String>, &CallAddress, u64),
    ),
) {
    let opening = outgoing.opening();
    let total = outgoing.total();

    request_progress(state, (call, id));

    // kept before its opening goes, so a credit that comes back as it goes finds it
    let core = state.core();

    core.sendings
        .open(call, (outgoing, SendingFor::Request(id)));

    if let Some(request) = core.pending.get_mut(call) {
        request.sending = true;
    }

    let mut options = Deliver::to(&call.connection_handle);
    let (handed, refused) = (call.clone(), call.clone());

    options.credential = transport_credential;
    options.on_hand_off = Some(Box::new(move |state: &mut S| {
        on_request_hand_off(state, (&handed, id));
    }));
    options.then = Some(Box::new(
        move |state: &mut S, outcome: Result<(), CallError>| {
            if let Err(error) = outcome {
                on_request_refused(state, (&refused, id, error));
            }
        },
    ));
    deliver(
        state,
        (
            Envelope::Request {
                header: RequestHeader {
                    total: Some(total),
                    ..header
                },
                payload: opening,
            },
            options,
        ),
    );
}

/// Cancels a call this side opened: one still waiting is rejected, the peer is sent a cancel, and
/// the call id is reserved for `timeout`, the call's own when it is waiting and none is given.
pub(crate) fn cancel<S: Side>(state: &mut S, (call, timeout): (&CallAddress, Option<Duration>)) {
    let inactivity = state.core().limits.transfer_inactivity_timeout;
    let request = forget(state, (call, None));

    // a request the transport never had leaves nothing at the other end to cancel
    match request {
        None => send_cancel(state, (call, timeout)),
        Some(mut request) => {
            if request.is_sent {
                let timeout = timeout.or(request.timeout);
                let reserved = if request.receiving.is_none() {
                    timeout
                } else {
                    Some(reservation_of(timeout).max(inactivity))
                };

                send_cancel(state, (call, reserved));
            }

            // heard after the cancel went out, so a call made again in its place goes out behind it
            settle(&mut request, Err(CallError::Cancelled));
        }
    }
}

/// A chunk of a call's result: the call is this side's.
pub(crate) fn receive_result_chunk<S: Side>(
    state: &mut S,
    (header, call, chunk): (ChunkHeader, CallAddress, Chunk),
) {
    let core = state.core();
    let handle = Arc::clone(&call.connection_handle);
    let length = u64::try_from(chunk.bytes.len()).unwrap_or(u64::MAX);
    let pending = core.pending.get(&call).map(|request| {
        (
            request.id,
            request.receiving.clone(),
            request.procedure,
            request.destination_id,
        )
    });
    let Some((id, Some(receiving), procedure, destination_id)) = pending else {
        // one on a call id reserved was on its way, and is dropped in silence
        if core.pending.is_reserved(call.call_id, &handle) {
            return;
        }

        let is_open = pending.is_some();

        return receive_unplaced(state, ((header, length, &handle), (None, is_open)));
    };
    let ResultReceiving {
        header: result_header,
        transfer,
    } = receiving;

    match core.receivings.place(transfer, &chunk) {
        Err(failure) => {
            let reason = CallError::Failure(failure.of_call(Some(procedure), destination_id));

            end_pending(state, (reason, &call, id));
        }
        // bytes placed are progress
        Ok(ChunkOutcome::Placed) => {
            request_progress(state, (&call, id));

            let credits = state
                .core()
                .receivings
                .grant(transfer)
                .into_iter()
                .collect();

            send_credits(state, credits);
        }
        Ok(ChunkOutcome::Complete) => {
            let core = state.core();
            let inactivity = core.limits.transfer_inactivity_timeout;
            let (payload, credits) = core.receivings.complete(transfer);

            send_credits(state, credits);

            // out before it settles; what its credit let the peer send may still come, and its call
            // id stays reserved, for it to be dropped in silence
            if let Some(mut request) = forget(state, (&call, Some(id))) {
                reserve(state, (&call, reserved_for(&request, inactivity)));
                settle(
                    &mut request,
                    Ok(RouterResult {
                        header: result_header,
                        payload,
                    }),
                );
                state.activity(RouterActivity::Response, &handle);
            }
        }
        // a chunk that brings nothing new is dropped in silence
        Ok(ChunkOutcome::Duplicate) => {}
    }
}

/// A result or a failure from the peer, paired with the call it answers.
#[expect(
    clippy::too_many_lines,
    reason = "an answer paired with its call, whole or as a transfer, as the other sides pair it"
)]
pub(crate) fn receive_answer<S: Side>(
    state: &mut S,
    (answer, handle, may_overtake): (Answer, &ConnectionHandle, bool),
) {
    let header = match &answer {
        Answer::Result(header, _) => Header::Result(header.clone()),
        Answer::Failure(header, _) => Header::Failure(header.clone()),
    };
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id: header.call_id(),
    };

    state.on_answer_received(&header, handle);

    let core = state.core();
    let side = core.side;
    let inactivity = core.limits.transfer_inactivity_timeout;
    let pending = core.pending.get(&call).map(|request| {
        (
            request.id,
            request.receiving.is_some(),
            request.procedure,
            request.destination_id,
            request.maximum_payload_bytes,
        )
    });
    let Some((id, is_receiving, procedure, destination_id, maximum_payload_bytes)) = pending else {
        // a failure may end a call the side keeps open once answered — a subscription — which the
        // side takes; anything else answers no call
        if let Answer::Failure(failure_header, failure) = &answer
            && state.on_unpaired_failure((failure_header, failure), handle)
        {
            return;
        }

        // one on a call id reserved is late, and dropped in silence
        if state.core().pending.is_reserved(call.call_id, handle) {
            return;
        }

        let failure = state
            .core()
            .failure(ProtocolCode::CALL_UNKNOWN)
            .about(&header);

        return state.report(reported(failure), handle);
    };

    match answer {
        Answer::Failure(failure_header, record) => {
            // out before it settles, so the same response again pairs with nothing; a result it
            // received in part goes with it, its call id reserved
            if let Some(mut request) = forget(state, (&call, Some(id))) {
                if is_receiving {
                    reserve(state, (&call, reserved_for(&request, inactivity)));
                }

                let failure = Failure::received(&record, side)
                    .of_call(Some(procedure), destination_id)
                    .overtaking(may_overtake)
                    .about(&Header::Failure(failure_header));

                settle(&mut request, Err(CallError::Failure(failure)));
                state.activity(RouterActivity::Response, handle);
            }
        }
        Answer::Result(result_header, payload) => {
            // a result that comes in a transfer answered the call: another answers nothing
            if is_receiving {
                let failure = state
                    .core()
                    .failure(ProtocolCode::ENVELOPE_MALFORMED)
                    .saying(format!(
                        "call {} is answered already, by a transfer",
                        call.call_id
                    ))
                    .about(&header);

                return state.report(reported(failure), handle);
            }

            let Some(total) = result_header.total else {
                if let Some(mut request) = forget(state, (&call, Some(id))) {
                    settle(
                        &mut request,
                        Ok(RouterResult {
                            header: result_header,
                            payload,
                        }),
                    );
                    state.activity(RouterActivity::Response, handle);
                }

                return;
            };

            // a transfer's opening is not its result: one refused ends the call, and the peer is
            // told to cancel it; opened, the call waits on the rest
            let core = state.core();
            let opened = if total > maximum_payload_bytes {
                Err(core.placement.too_large_of(total, maximum_payload_bytes))
            } else {
                core.receivings.open(&payload, (&call, total))
            };
            let transfer = match opened {
                Ok(transfer) => transfer,
                Err(failure) => {
                    let reason = CallError::Failure(
                        failure
                            .of_call(Some(procedure), destination_id)
                            .about(&Header::Result(result_header)),
                    );

                    return end_pending(state, (reason, &call, id));
                }
            };

            request_progress(state, (&call, id));

            // kept before its first credit goes, so a chunk that credit brings at once finds it
            if let Some(request) = state.core().pending.get_mut(&call) {
                request.receiving = Some(ResultReceiving {
                    header: result_header,
                    transfer,
                });
            }

            let credits = state
                .core()
                .receivings
                .grant(transfer)
                .into_iter()
                .collect();

            send_credits(state, credits);
        }
    }
}

/// An answer of this layout that does not read: it ends the call it answers, if one waits.
pub(crate) fn gate_malformed_answer<S: Side>(
    state: &mut S,
    ((failure, call_id, handle), is_reported): ((Failure, u32, &ConnectionHandle), bool),
) {
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };
    let pending = state
        .core()
        .pending
        .get(&call)
        .map(|request| (request.id, request.procedure, request.destination_id));
    let Some((id, procedure, destination_id)) = pending else {
        // an answer of this layout on a call id reserved is late, and dropped in silence
        if state.core().pending.is_reserved(call_id, handle) {
            return;
        }

        if !is_reported {
            state.report(reported(failure), handle);
        }

        return;
    };

    // the call it answers would otherwise wait out its timeout; the peer is told
    end_pending(
        state,
        (
            CallError::Failure(failure.of_call(Some(procedure), destination_id)),
            &call,
            id,
        ),
    );
}

/// A chunk of this layout that does not read: it ends the result's transfer it was for.
pub(crate) fn gate_malformed_result_chunk<S: Side>(
    state: &mut S,
    ((failure, call_id, handle), is_reported): ((Failure, u32, &ConnectionHandle), bool),
) {
    let call = CallAddress {
        connection_handle: Arc::clone(handle),
        call_id,
    };
    let core = state.core();
    let invalid = core
        .failure(ProtocolCode::CHUNK_INVALID)
        .saying(failure.detail().to_owned());
    let pending = core
        .pending
        .get(&call)
        .filter(|request| request.receiving.is_some())
        .map(|request| (request.id, request.procedure, request.destination_id));

    if let Some((id, procedure, destination_id)) = pending {
        return end_pending(
            state,
            (
                CallError::Failure(invalid.of_call(Some(procedure), destination_id)),
                &call,
                id,
            ),
        );
    }

    if state.core().pending.is_reserved(call_id, handle) {
        return;
    }

    if !is_reported {
        state.report(reported(failure), handle);
    }
}

/// Takes every call waiting on one connection, or on all, out of the pending calls, and gives what
/// settles each, for them to be rejected after.
pub(crate) fn take_all<S: Side>(
    state: &mut S,
    handle: Option<&ConnectionHandle>,
) -> Vec<CallReply> {
    let core = state.core();
    let waiting = core.pending.take_all(handle);

    waiting
        .into_iter()
        .filter_map(|mut request| {
            cancel_timer(&mut request.timer);
            request.reply.take()
        })
        .collect()
}

/// Whether `call_id` of this side's is reserved on `handle`.
#[cfg(any(test, feature = "testing"))]
pub(crate) fn is_reserved<S: Side>(
    state: &mut S,
    (call_id, handle): (u32, &ConnectionHandle),
) -> bool {
    state.core().pending.is_reserved(call_id, handle)
}
