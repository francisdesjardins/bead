//! The parts of a router's core, each a structure its owner alone touches: the calls it waits on and
//! the call ids it reserved, the calls it answers and those abandoned, the transfers it sends and
//! receives, and what its answers announced.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use bytes::Bytes;

use crate::clock::Timer;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{
    ChunkHeader, Envelope, Header, MAXIMUM_HEADER_BYTES, header_bytes_of, unbounded_header_bytes_of,
};
use crate::failure::{Failure, ProcedureAddress};
use crate::metrics::ProcedureSeries;
use crate::router::transfer::{
    Chunk, ChunkOutcome, IncomingBounds, IncomingTransfer, OutgoingTransfer,
};
use crate::router::types::{CallAddress, ConnectionHandle, Gauges, RouterLimits, Signal};
use crate::session_token::SessionToken;

/// A timer a part holds, cancelled as it goes.
pub(crate) type HeldTimer = Option<Arc<dyn Timer>>;

pub(crate) fn cancel_timer(timer: &mut HeldTimer) {
    if let Some(timer) = timer.take() {
        timer.cancel();
    }
}

fn count_of(count: usize) -> u64 {
    u64::try_from(count).unwrap_or(u64::MAX)
}

fn length_of(bytes: &[u8]) -> u64 {
    count_of(bytes.len())
}

// ── Payload placement ──────────────────────────────────────────────────────────────────────

/// How a payload goes, by the router's limits: whole, as a transfer, or refused.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Placement {
    pub(crate) side: RouterSide,
    pub(crate) limits: RouterLimits,
    /// The largest envelope a payload goes whole in.
    pub(crate) whole_bytes: u64,
    /// The bytes of a payload a chunk carries.
    pub(crate) payload_bytes_per_chunk: u64,
}

// what an answer's announcement adds to its header: a credential's head, then a session's token
const ANNOUNCEMENT_BYTES: u64 = 20;

/// How a payload goes: whole, or as a transfer.
#[derive(Debug)]
pub(crate) enum Placed {
    Whole,
    Transfer(OutgoingTransfer),
}

impl Placement {
    pub(crate) fn new(side: RouterSide, limits: RouterLimits) -> Self {
        let whole_bytes = limits.chunk_bytes.min(limits.maximum_envelope_bytes);
        let chunk_header = header_bytes_of(&Header::Chunk(ChunkHeader {
            call_id: 1,
            offset: 0,
            is_last: true,
        }))
        .map_or(16, count_of);

        Self {
            side,
            limits,
            whole_bytes,
            payload_bytes_per_chunk: whole_bytes.saturating_sub(chunk_header),
        }
    }

    /// The bytes a payload of a procedure holds at most: its own limit, within the router's.
    pub(crate) fn payload_limit_of(&self, maximum_payload_bytes: Option<u64>) -> u64 {
        maximum_payload_bytes
            .unwrap_or(u64::MAX)
            .min(self.limits.maximum_payload_bytes)
    }

    /// The failure of a payload of `length` bytes, past `limit`.
    pub(crate) fn too_large_of(&self, length: u64, limit: u64) -> Failure {
        Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, self.side)
            .saying(format!("a payload is {limit} bytes at most, not {length}"))
    }

    /// How a payload goes after `header`, a request's or a result's: whole or as a transfer, a
    /// result's header counted with the announcement it may carry; or not at all.
    pub(crate) fn transfer_of(
        &self,
        payload: &Bytes,
        (header, maximum_payload_bytes): (&Header, u64),
    ) -> Result<Placed, Failure> {
        let length = length_of(payload);
        let announcement = if matches!(header, Header::Result(_)) {
            ANNOUNCEMENT_BYTES
        } else {
            0
        };
        let too_large = |detail: String| {
            Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, self.side).saying(detail)
        };

        if length > maximum_payload_bytes {
            return Err(self.too_large_of(length, maximum_payload_bytes));
        }

        let header_bytes = header_bytes_of(header).map_or(u64::MAX, count_of);

        if header_bytes
            .saturating_add(announcement)
            .saturating_add(length)
            <= self.whole_bytes
        {
            return Ok(Placed::Whole);
        }

        if self.limits.maximum_transfers == 0 {
            return Err(too_large(format!(
                "a payload of {length} bytes goes as a transfer, which this side sends none of"
            )));
        }

        let opening_header = with_total(header, length);
        let opening_header_bytes =
            unbounded_header_bytes_of(&opening_header).map_or(u64::MAX, count_of);
        let opening_bytes = self
            .whole_bytes
            .checked_sub(opening_header_bytes)
            .and_then(|left| left.checked_sub(announcement))
            .unwrap_or(0);

        // ! a header past 1,020 bytes no reader takes, and an opening without a byte of its payload
        // none places: a payload that needs such a transfer goes whole or not at all (spec 12.3)
        if opening_header_bytes > count_of(MAXIMUM_HEADER_BYTES) {
            return Err(too_large(format!(
                "a payload of {length} bytes goes as a transfer, whose opening's header of {opening_header_bytes} bytes passes {MAXIMUM_HEADER_BYTES}"
            )));
        }

        if opening_bytes < 1 {
            return Err(too_large(format!(
                "a payload of {length} bytes goes as a transfer, whose opening's header of {opening_header_bytes} bytes leaves it no byte within {}",
                self.whole_bytes
            )));
        }

        Ok(Placed::Transfer(OutgoingTransfer::new(
            payload.clone(),
            (opening_bytes, self.payload_bytes_per_chunk),
        )))
    }

    /// A chunk's envelope, on `call_id`.
    pub(crate) fn chunk_envelope_of(call_id: u32, chunk: &Chunk) -> Envelope {
        Envelope::Chunk {
            header: ChunkHeader {
                call_id,
                offset: chunk.offset,
                is_last: chunk.is_last,
            },
            payload: chunk.bytes.clone(),
        }
    }
}

/// `header`, a request's or a result's, declaring a transfer's `total`.
pub(crate) fn with_total(header: &Header, total: u64) -> Header {
    match header {
        Header::Request(request) => {
            let mut opening = request.clone();

            opening.total = Some(total);
            Header::Request(opening)
        }
        Header::Result(result) => {
            let mut opening = result.clone();

            opening.total = Some(total);
            Header::Result(opening)
        }
        Header::Failure(_)
        | Header::Notification(_)
        | Header::Chunk(_)
        | Header::Credit(_)
        | Header::Cancel(_) => header.clone(),
    }
}

// ── Sending transfers ──────────────────────────────────────────────────────────────────────

/// What a transfer this side sends is for: a request's payload, or a result's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendingFor {
    Request(u64),
    Result(u64),
}

#[derive(Debug)]
struct Sending {
    outgoing: OutgoingTransfer,
    purpose: SendingFor,
    is_pumping: bool,
}

/// The transfers a router sends, on every connection, each found by its call as a credit comes.
#[derive(Debug, Default)]
pub(crate) struct SendingTransfers {
    sent: BTreeMap<ConnectionHandle, BTreeMap<u32, Sending>>,
}

impl SendingTransfers {
    /// Keeps a transfer on `call` before its opening goes, so a credit that comes back finds it.
    pub(crate) fn open(
        &mut self,
        call: &CallAddress,
        (outgoing, purpose): (OutgoingTransfer, SendingFor),
    ) {
        self.sent
            .entry(Arc::clone(&call.connection_handle))
            .or_default()
            .insert(
                call.call_id,
                Sending {
                    outgoing,
                    purpose,
                    is_pumping: false,
                },
            );
    }

    /// Ends the transfer on `call` for `purpose`, when it is that one.
    pub(crate) fn close(&mut self, call: &CallAddress, purpose: SendingFor) {
        if let Some(calls) = self.sent.get_mut(&call.connection_handle)
            && calls
                .get(&call.call_id)
                .is_some_and(|sending| sending.purpose == purpose)
        {
            calls.remove(&call.call_id);

            if calls.is_empty() {
                self.sent.remove(&call.connection_handle);
            }
        }
    }

    /// Ends every transfer, `connection_handle`'s alone when given.
    pub(crate) fn close_all(&mut self, connection_handle: Option<&ConnectionHandle>) {
        match connection_handle {
            Some(handle) => {
                self.sent.remove(handle);
            }
            None => self.sent.clear(),
        }
    }

    /// Whether the transfer on `call` is still the one for `purpose`.
    pub(crate) fn is_open(&self, call: &CallAddress, purpose: SendingFor) -> bool {
        self.sent
            .get(&call.connection_handle)
            .and_then(|calls| calls.get(&call.call_id))
            .is_some_and(|sending| sending.purpose == purpose)
    }

    /// A credit received on `call`: it raises the end of the transfer sent there, and gives what
    /// it is for and whether it granted anything; none for no transfer.
    pub(crate) fn credit(&mut self, call: &CallAddress, credit_end: u64) -> Option<SendingFor> {
        let sending = self
            .sent
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))?;
        let previous = sending.outgoing.credit_end();

        sending.outgoing.grant(credit_end);

        // late, repeated, or lower: it grants nothing
        (sending.outgoing.credit_end() != previous).then_some(sending.purpose)
    }

    /// Marks the transfer on `call` as sending its chunks now, or not; false when it was already.
    pub(crate) fn begin_pump(&mut self, call: &CallAddress) -> bool {
        self.sent
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))
            .is_some_and(|sending| !core::mem::replace(&mut sending.is_pumping, true))
    }

    /// Ends a pump begun.
    pub(crate) fn end_pump(&mut self, call: &CallAddress) {
        if let Some(sending) = self
            .sent
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))
        {
            sending.is_pumping = false;
        }
    }

    /// The next chunk the credit lets go on `call`'s transfer.
    pub(crate) fn next_chunk(&mut self, call: &CallAddress) -> Option<Chunk> {
        self.sent
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))
            .and_then(|sending| sending.outgoing.next_chunk())
    }

    /// The transfers sent, counted, and their connections.
    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();

        gauges.counts.insert(
            "sendingTransfers",
            self.sent.values().map(|calls| count_of(calls.len())).sum(),
        );
        gauges.connection_handles.extend(self.sent.keys().cloned());

        gauges
    }
}

// ── Receiving transfers ────────────────────────────────────────────────────────────────────

/// A transfer this side receives: its id, the call it belongs to, its bytes as they come.
#[derive(Debug)]
pub(crate) struct Receiving {
    pub(crate) call: CallAddress,
    pub(crate) incoming: IncomingTransfer,
    pub(crate) is_complete: bool,
    // the bytes of the budget it holds: its opening's, then each credit's
    reserved: u64,
    pub(crate) timer: HeldTimer,
}

/// The transfers a router receives, on every connection: the bytes they hold of its budget, the
/// places they take on their connection, the credit they grant.
#[derive(Debug)]
pub(crate) struct ReceivingTransfers {
    limits: RouterLimits,
    bounds: IncomingBounds,
    // the transfers open, by their id, in the order they opened
    held: BTreeMap<u64, Receiving>,
    connections: HashMap<ConnectionHandle, u64>,
    buffered: u64,
    next: u64,
}

impl ReceivingTransfers {
    pub(crate) fn new(
        side: RouterSide,
        (limits, payload_bytes_per_chunk): (RouterLimits, u64),
    ) -> Self {
        Self {
            limits,
            bounds: IncomingBounds {
                side,
                maximum_chunk_runs: limits.maximum_chunk_runs,
                window_bytes: limits.window_bytes,
                payload_bytes_per_chunk,
            },
            held: BTreeMap::new(),
            connections: HashMap::new(),
            buffered: 0,
            next: 0,
        }
    }

    /// The bytes of the budget no transfer holds.
    pub(crate) fn available(&self) -> u64 {
        self.limits
            .buffered_bytes_budget
            .saturating_sub(self.buffered)
    }

    /// Opens a transfer on `call` from its opening, or gives the failure that refuses it.
    pub(crate) fn open(
        &mut self,
        opening: &Bytes,
        (call, total): (&CallAddress, u64),
    ) -> Result<u64, Failure> {
        let side = self.bounds.side;
        let transfers = self
            .connections
            .get(&call.connection_handle)
            .copied()
            .unwrap_or(0);
        let available = self.available();
        let too_large = |detail: String| {
            Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, side).saying(detail)
        };
        let exceeded = |detail: String| {
            Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, side).saying(detail)
        };

        if self.limits.maximum_transfers == 0 {
            return Err(too_large("this peer takes no transfer".to_owned()));
        }

        if total == 0 {
            return Err(too_large("a transfer declares its total, not 0".to_owned()));
        }

        if total > self.limits.maximum_payload_bytes {
            return Err(too_large(format!(
                "a payload is {} bytes at most, not {total}",
                self.limits.maximum_payload_bytes
            )));
        }

        if transfers >= self.limits.maximum_transfers {
            return Err(exceeded(format!(
                "the transfers a connection receives at once are {} at most",
                self.limits.maximum_transfers
            )));
        }

        if length_of(opening) > available {
            return Err(exceeded(format!(
                "the transfers received hold the budget but {available} bytes"
            )));
        }

        let incoming = IncomingTransfer::new(opening, (total, self.bounds))?;
        let id = self.next;

        self.next = self.next.saturating_add(1);
        self.held.insert(
            id,
            Receiving {
                call: call.clone(),
                incoming,
                is_complete: false,
                reserved: length_of(opening),
                timer: None,
            },
        );
        self.connections.insert(
            Arc::clone(&call.connection_handle),
            transfers.saturating_add(1),
        );
        self.buffered = self.buffered.saturating_add(length_of(opening));

        Ok(id)
    }

    pub(crate) fn get(&self, id: u64) -> Option<&Receiving> {
        self.held.get(&id)
    }

    pub(crate) fn get_mut(&mut self, id: u64) -> Option<&mut Receiving> {
        self.held.get_mut(&id)
    }

    /// The credit transfer `id` may grant now, within the budget left, reserved; none for none.
    pub(crate) fn grant(&mut self, id: u64) -> Option<(CallAddress, u64)> {
        let available = self.available();
        let receiving = self.held.get_mut(&id)?;

        if receiving.is_complete {
            return None;
        }

        let previous = receiving.incoming.credit_end();
        let credit_end = receiving.incoming.credit_to_grant(available)?;
        let granted = credit_end.saturating_sub(previous);

        receiving.reserved = receiving.reserved.saturating_add(granted);
        self.buffered = self.buffered.saturating_add(granted);

        Some((receiving.call.clone(), credit_end))
    }

    /// The credits the budget gave back lets the transfers it starved grant, in the order they
    /// opened.
    #[expect(
        clippy::needless_collect,
        reason = "the ids taken before the grants, each of which changes what holds them"
    )]
    pub(crate) fn grant_starved(&mut self) -> Vec<(CallAddress, u64)> {
        let ids: Vec<u64> = self.held.keys().copied().collect();

        ids.into_iter().filter_map(|id| self.grant(id)).collect()
    }

    // ends a transfer, and gives back what it holds: its bytes, its place, its timer
    fn end(&mut self, id: u64) {
        if let Some(mut receiving) = self.held.remove(&id) {
            cancel_timer(&mut receiving.timer);
            self.buffered = self.buffered.saturating_sub(receiving.reserved);

            let handle = receiving.call.connection_handle;

            if let Some(transfers) = self.connections.get_mut(&handle) {
                *transfers = transfers.saturating_sub(1);

                if *transfers == 0 {
                    self.connections.remove(&handle);
                }
            }
        }
    }

    /// Ends a transfer, and gives the credits the transfers it starved may grant now.
    pub(crate) fn close(&mut self, id: u64) -> Vec<(CallAddress, u64)> {
        if !self.held.contains_key(&id) {
            return Vec::new();
        }

        self.end(id);
        self.grant_starved()
    }

    /// Ends every transfer, `connection_handle`'s alone when given, then gives the credits the
    /// transfers it starved may grant.
    pub(crate) fn close_all(
        &mut self,
        connection_handle: Option<&ConnectionHandle>,
    ) -> Vec<(CallAddress, u64)> {
        let ids: Vec<u64> = self
            .held
            .iter()
            .filter(|(_, receiving)| {
                connection_handle.is_none_or(|handle| *handle == receiving.call.connection_handle)
            })
            .map(|(&id, _)| id)
            .collect();

        for id in ids {
            self.end(id);
        }

        self.grant_starved()
    }

    /// The payload of a transfer placed whole: its bytes leave the budget, its timer stops.
    pub(crate) fn complete(&mut self, id: u64) -> (Bytes, Vec<(CallAddress, u64)>) {
        let Some(receiving) = self.held.get_mut(&id) else {
            return (Bytes::new(), Vec::new());
        };
        let payload = receiving.incoming.payload();

        receiving.is_complete = true;
        cancel_timer(&mut receiving.timer);

        let reserved = core::mem::take(&mut receiving.reserved);

        self.buffered = self.buffered.saturating_sub(reserved);

        (payload, self.grant_starved())
    }

    /// Places a chunk on transfer `id`.
    pub(crate) fn place(&mut self, id: u64, chunk: &Chunk) -> Result<ChunkOutcome, Failure> {
        let Some(receiving) = self.held.get_mut(&id) else {
            return Ok(ChunkOutcome::Duplicate);
        };

        receiving
            .incoming
            .place(&chunk.bytes, (chunk.is_last, chunk.offset))
    }

    /// The transfers received and the bytes of the budget they hold, counted, and their
    /// connections.
    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();

        gauges
            .ceilings
            .insert("bufferedBytes", self.limits.buffered_bytes_budget);
        gauges.counts.insert("bufferedBytes", self.buffered);
        gauges
            .counts
            .insert("receivingTransfers", count_of(self.held.len()));
        gauges
            .connection_handles
            .extend(self.connections.keys().cloned());

        gauges
    }
}

// ── Pending calls and reservations ─────────────────────────────────────────────────────────

/// A result that comes in a transfer: the header that opened it, and its transfer.
#[derive(Debug, Clone)]
pub(crate) struct ResultReceiving {
    pub(crate) header: crate::envelope::ResultHeader,
    pub(crate) transfer: u64,
}

/// What settles a call this side made.
pub(crate) type CallReply =
    Box<dyn FnOnce(Result<crate::router::types::RouterResult, crate::errors::CallError>) + Send>;

/// What hears a request handed to its transport, and its transport refuse it.
pub(crate) type OnSent = Box<dyn FnMut(bool) + Send>;

/// A request waiting for its response.
pub(crate) struct PendingRequest {
    pub(crate) id: u64,
    pub(crate) destination_id: Option<u32>,
    pub(crate) is_sent: bool,
    pub(crate) maximum_payload_bytes: u64,
    pub(crate) on_sent: Option<OnSent>,
    pub(crate) procedure: ProcedureAddress,
    pub(crate) receiving: Option<ResultReceiving>,
    pub(crate) reply: Option<CallReply>,
    pub(crate) sending: bool,
    pub(crate) timeout: Option<core::time::Duration>,
    pub(crate) timer: HeldTimer,
}

impl core::fmt::Debug for PendingRequest {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("PendingRequest")
            .field("id", &self.id)
            .field("is_sent", &self.is_sent)
            .finish_non_exhaustive()
    }
}

/// A call id reserved: when it is free again, on the monotonic reading, its id, and its timer.
#[derive(Debug)]
pub(crate) struct Reservation {
    pub(crate) ends: core::time::Duration,
    pub(crate) id: u64,
    pub(crate) timer: HeldTimer,
}

/// The calls one side opened and waits on, and the call ids it reserved, by connection.
#[derive(Debug)]
pub(crate) struct PendingCalls {
    first: u32,
    last: u32,
    next: u32,
    pub(crate) pending: BTreeMap<ConnectionHandle, BTreeMap<u32, PendingRequest>>,
    pub(crate) reservations: BTreeMap<ConnectionHandle, BTreeMap<u32, Reservation>>,
}

impl PendingCalls {
    pub(crate) fn new(side: RouterSide, last_call_id: Option<u32>) -> Self {
        let (first, last) = side.call_ids();

        Self {
            first,
            last: last_call_id.unwrap_or(last),
            next: first,
            pending: BTreeMap::new(),
            reservations: BTreeMap::new(),
        }
    }

    pub(crate) fn count_on(&self, handle: &ConnectionHandle) -> u64 {
        self.pending
            .get(handle)
            .map_or(0, |calls| count_of(calls.len()))
    }

    /// A call id of this side's for `handle`, skipping those waited on, reserved, or in use.
    pub(crate) fn draw<F: Fn(u32) -> bool>(
        &mut self,
        (handle, is_in_use): (&ConnectionHandle, F),
    ) -> Option<u32> {
        let count = (self.last.saturating_sub(self.first) / 2).saturating_add(1);

        for _ in 0..count {
            let call_id = self.next;

            self.next = if call_id >= self.last {
                self.first
            } else {
                call_id.saturating_add(2)
            };

            let is_taken = self
                .pending
                .get(handle)
                .is_some_and(|calls| calls.contains_key(&call_id))
                || self.is_reserved(call_id, handle)
                || is_in_use(call_id);

            if !is_taken {
                return Some(call_id);
            }
        }

        None
    }

    pub(crate) fn add(&mut self, call: &CallAddress, request: PendingRequest) {
        self.pending
            .entry(Arc::clone(&call.connection_handle))
            .or_default()
            .insert(call.call_id, request);
    }

    pub(crate) fn get(&self, call: &CallAddress) -> Option<&PendingRequest> {
        self.pending
            .get(&call.connection_handle)
            .and_then(|calls| calls.get(&call.call_id))
    }

    pub(crate) fn get_mut(&mut self, call: &CallAddress) -> Option<&mut PendingRequest> {
        self.pending
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))
    }

    /// Whether the call on `call` is still the one of `id`.
    pub(crate) fn is(&self, call: &CallAddress, id: u64) -> bool {
        self.get(call).is_some_and(|request| request.id == id)
    }

    /// Takes a call out — only while `only` is its request, when given.
    pub(crate) fn forget(
        &mut self,
        call: &CallAddress,
        only: Option<u64>,
    ) -> Option<PendingRequest> {
        let calls = self.pending.get_mut(&call.connection_handle)?;

        if only.is_some_and(|id| {
            calls
                .get(&call.call_id)
                .is_none_or(|request| request.id != id)
        }) {
            return None;
        }

        let request = calls.remove(&call.call_id);

        if calls.is_empty() {
            self.pending.remove(&call.connection_handle);
        }

        request
    }

    pub(crate) fn is_reserved(&self, call_id: u32, handle: &ConnectionHandle) -> bool {
        self.reservations
            .get(handle)
            .is_some_and(|reserved| reserved.contains_key(&call_id))
    }

    /// Takes a reservation out, while it is the one of `id`.
    pub(crate) fn forget_reservation(&mut self, call: &CallAddress, id: u64) {
        if let Some(reserved) = self.reservations.get_mut(&call.connection_handle)
            && reserved
                .get(&call.call_id)
                .is_some_and(|reservation| reservation.id == id)
        {
            reserved.remove(&call.call_id);

            if reserved.is_empty() {
                self.reservations.remove(&call.connection_handle);
            }
        }
    }

    /// Takes out every call waited on and every call id reserved, `handle`'s alone when given, and
    /// gives the requests that were waiting.
    pub(crate) fn take_all(&mut self, handle: Option<&ConnectionHandle>) -> Vec<PendingRequest> {
        let (waiting, reserved) = match handle {
            Some(handle) => (
                self.pending.remove(handle).into_iter().collect::<Vec<_>>(),
                self.reservations
                    .remove(handle)
                    .into_iter()
                    .collect::<Vec<_>>(),
            ),
            None => (
                core::mem::take(&mut self.pending).into_values().collect(),
                core::mem::take(&mut self.reservations)
                    .into_values()
                    .collect(),
            ),
        };

        for calls in reserved {
            for (_, mut reservation) in calls {
                cancel_timer(&mut reservation.timer);
            }
        }

        waiting
            .into_iter()
            .flat_map(BTreeMap::into_values)
            .collect()
    }

    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();

        gauges.counts.insert(
            "pendingCalls",
            self.pending
                .values()
                .map(|calls| count_of(calls.len()))
                .sum(),
        );
        gauges.counts.insert(
            "reservedCallIds",
            self.reservations
                .values()
                .map(|calls| count_of(calls.len()))
                .sum(),
        );
        gauges
            .connection_handles
            .extend(self.pending.keys().cloned());
        gauges
            .connection_handles
            .extend(self.reservations.keys().cloned());

        gauges
    }
}

// ── Answering calls ────────────────────────────────────────────────────────────────────────

/// What a call to answer receives of its payload: its transfer, and the request as it waits.
#[derive(Debug, Clone)]
pub(crate) struct RequestReceiving {
    pub(crate) transfer: u64,
}

/// A call to answer: the request that opened it, its signal, whether its answer is going out,
/// what it receives of its payload; and, counted, its series and when it started.
#[derive(Debug)]
pub(crate) struct Answering {
    pub(crate) dispatched: u64,
    pub(crate) signal: Signal,
    pub(crate) is_answered: bool,
    pub(crate) is_ended: bool,
    pub(crate) receiving: Option<RequestReceiving>,
    pub(crate) series: Option<ProcedureSeries>,
    pub(crate) started_at: core::time::Duration,
}

/// A call whose transfer ended: the end its credit reached, and what forgets it.
#[derive(Debug)]
pub(crate) struct Abandoned {
    pub(crate) credit_end: u64,
    pub(crate) id: u64,
    pub(crate) timer: HeldTimer,
}

/// The calls the peer opened that this side has not answered yet, by connection, and those
/// abandoned once their transfer ended.
#[derive(Debug, Default)]
pub(crate) struct AnsweringCalls {
    pub(crate) answering: BTreeMap<ConnectionHandle, BTreeMap<u32, Answering>>,
    pub(crate) abandoned: BTreeMap<ConnectionHandle, BTreeMap<u32, Abandoned>>,
    pub(crate) most: u64,
}

impl AnsweringCalls {
    pub(crate) fn get(&self, call: &CallAddress) -> Option<&Answering> {
        self.answering
            .get(&call.connection_handle)
            .and_then(|calls| calls.get(&call.call_id))
    }

    pub(crate) fn get_mut(&mut self, call: &CallAddress) -> Option<&mut Answering> {
        self.answering
            .get_mut(&call.connection_handle)
            .and_then(|calls| calls.get_mut(&call.call_id))
    }

    pub(crate) fn has(&self, call: &CallAddress) -> bool {
        self.get(call).is_some()
    }

    pub(crate) fn count_on(&self, handle: &ConnectionHandle) -> u64 {
        self.answering
            .get(handle)
            .map_or(0, |calls| count_of(calls.len()))
    }

    pub(crate) fn abandoned_end_of(&self, call: &CallAddress) -> Option<u64> {
        self.abandoned
            .get(&call.connection_handle)
            .and_then(|calls| calls.get(&call.call_id))
            .map(|abandoned| abandoned.credit_end)
    }

    /// Forgets a call abandoned, and its timer, while it is the one of `only`, when given.
    pub(crate) fn forget_abandoned(&mut self, call: &CallAddress, only: Option<u64>) {
        if let Some(calls) = self.abandoned.get_mut(&call.connection_handle)
            && calls
                .get(&call.call_id)
                .is_some_and(|abandoned| only.is_none_or(|id| abandoned.id == id))
        {
            if let Some(mut abandoned) = calls.remove(&call.call_id) {
                cancel_timer(&mut abandoned.timer);
            }

            if calls.is_empty() {
                self.abandoned.remove(&call.connection_handle);
            }
        }
    }

    /// Takes a call out — only while it is the one `only` dispatched, when given.
    pub(crate) fn forget(&mut self, call: &CallAddress, only: Option<u64>) -> Option<Answering> {
        let calls = self.answering.get_mut(&call.connection_handle)?;

        if only.is_some_and(|dispatched| {
            calls
                .get(&call.call_id)
                .is_none_or(|answering| answering.dispatched != dispatched)
        }) {
            return None;
        }

        let answering = calls.remove(&call.call_id);

        if calls.is_empty() {
            self.answering.remove(&call.connection_handle);
        }

        answering
    }

    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();
        let largest = self
            .answering
            .values()
            .map(|calls| count_of(calls.len()))
            .max()
            .unwrap_or(0);

        gauges.ceilings.insert("largestAnsweringCalls", self.most);
        gauges.counts.insert(
            "abandonedCalls",
            self.abandoned
                .values()
                .map(|calls| count_of(calls.len()))
                .sum(),
        );
        gauges.counts.insert(
            "answeringCalls",
            self.answering
                .values()
                .map(|calls| count_of(calls.len()))
                .sum(),
        );
        gauges.counts.insert("largestAnsweringCalls", largest);
        gauges
            .connection_handles
            .extend(self.answering.keys().cloned());
        gauges
            .connection_handles
            .extend(self.abandoned.keys().cloned());

        gauges
    }
}

// ── Announcements ──────────────────────────────────────────────────────────────────────────

/// What the side's answers announced of each connection's session: a token, none once it was told
/// its session ended, and nothing for a connection never told.
#[derive(Debug, Default)]
pub(crate) struct Announcements {
    announced: HashMap<ConnectionHandle, Option<SessionToken>>,
}

/// What an announcement recorded, to undo should its answer not go out.
#[derive(Debug, Clone)]
pub(crate) struct Announced {
    handle: ConnectionHandle,
    current: Option<SessionToken>,
    previous: Previous,
}

// what a connection was told before an announcement: nothing, or a session or none
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Previous {
    Untold,
    Told(Option<SessionToken>),
}

impl Announcements {
    /// The credential an answer to `handle` announces now, the session being `current`: none when
    /// it changed nothing since the last announced.
    pub(crate) fn announce(
        &mut self,
        (handle, current): (&ConnectionHandle, Option<SessionToken>),
    ) -> Option<(crate::envelope::Credential, Announced)> {
        let previous = self
            .announced
            .get(handle)
            .copied()
            .map_or(Previous::Untold, Previous::Told);
        let is_unchanged = match previous {
            Previous::Told(told) => told == current,
            Previous::Untold => current.is_none(),
        };

        if is_unchanged {
            return None;
        }

        self.announced.insert(Arc::clone(handle), current);

        let credential = current.map_or(
            crate::envelope::Credential::None,
            crate::envelope::Credential::Opaque,
        );

        Some((
            credential,
            Announced {
                handle: Arc::clone(handle),
                current,
                previous,
            },
        ))
    }

    /// Undoes what an announcement recorded, unless something since recorded over it or forgot it.
    pub(crate) fn restore(&mut self, announced: Announced) {
        if self.announced.get(&announced.handle) == Some(&announced.current) {
            match announced.previous {
                Previous::Told(previous) => {
                    self.announced.insert(announced.handle, previous);
                }
                Previous::Untold => {
                    self.announced.remove(&announced.handle);
                }
            }
        }
    }

    pub(crate) fn forget(&mut self, handle: Option<&ConnectionHandle>) {
        match handle {
            Some(handle) => {
                self.announced.remove(handle);
            }
            None => self.announced.clear(),
        }
    }

    pub(crate) fn gauges(&self) -> Gauges {
        let mut gauges = Gauges::default();

        gauges
            .counts
            .insert("announced", count_of(self.announced.len()));
        gauges
            .connection_handles
            .extend(self.announced.keys().cloned());

        gauges
    }
}
