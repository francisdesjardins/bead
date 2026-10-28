//! A payload sent or received as a transfer (spec 12): its opening, then its chunks, as the credit
//! lets them go and as they come.

use bytes::{Bytes, BytesMut};

use crate::constants::{ProtocolCode, RouterSide};
use crate::failure::Failure;

/// One chunk to send: its bytes, where they start in the whole payload, and whether they end it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) bytes: Bytes,
    pub(crate) is_last: bool,
    pub(crate) offset: u64,
}

/// What placing a chunk did: placed its bytes, placed none since it had them, or completed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChunkOutcome {
    Placed,
    Duplicate,
    Complete,
}

/// A payload as its sender sends it: the opening carries its first bytes, without credit; each
/// chunk after carries `payload_bytes_per_chunk` of it, or the last of it, as the credit allows.
#[derive(Debug, Clone)]
pub(crate) struct OutgoingTransfer {
    payload: Bytes,
    opening_bytes: u64,
    payload_bytes_per_chunk: u64,
    credit_end: u64,
    sent: u64,
}

fn length_of(bytes: &[u8]) -> u64 {
    u64::try_from(bytes.len()).unwrap_or(u64::MAX)
}

fn index_of(offset: u64) -> usize {
    usize::try_from(offset).unwrap_or(usize::MAX)
}

impl OutgoingTransfer {
    pub(crate) fn new(
        payload: Bytes,
        (opening_bytes, payload_bytes_per_chunk): (u64, u64),
    ) -> Self {
        Self {
            payload,
            opening_bytes,
            payload_bytes_per_chunk,
            credit_end: opening_bytes,
            sent: opening_bytes,
        }
    }

    /// The whole payload's length.
    pub(crate) fn total(&self) -> u64 {
        length_of(&self.payload)
    }

    /// The end below which the receiver lets it send.
    pub(crate) fn credit_end(&self) -> u64 {
        self.credit_end
    }

    /// The bytes the opening carries.
    pub(crate) fn opening(&self) -> Bytes {
        self.payload
            .slice(..index_of(self.opening_bytes).min(self.payload.len()))
    }

    /// Raises the end the receiver granted, the total at most; a lower one grants nothing.
    pub(crate) fn grant(&mut self, credit_end: u64) {
        self.credit_end = self.credit_end.max(credit_end.min(self.total()));
    }

    /// The next chunk the credit lets go out: a full one, or the last; none when neither fits.
    pub(crate) fn next_chunk(&mut self) -> Option<Chunk> {
        let total = self.total();
        let end = self
            .sent
            .saturating_add(self.payload_bytes_per_chunk)
            .min(total);

        // a full chunk, or the last one, and only under the credit
        if self.sent == total || end > self.credit_end {
            return None;
        }

        let chunk = Chunk {
            bytes: self.payload.slice(index_of(self.sent)..index_of(end)),
            is_last: end == total,
            offset: self.sent,
        };

        self.sent = end;

        Some(chunk)
    }
}

/// What an incoming transfer is held to: the failures of its side, its runs and its window.
#[derive(Debug, Clone, Copy)]
pub(crate) struct IncomingBounds {
    pub(crate) side: RouterSide,
    pub(crate) maximum_chunk_runs: u64,
    pub(crate) window_bytes: u64,
    pub(crate) payload_bytes_per_chunk: u64,
}

/// A payload as its receiver receives it: `total` bytes, the opening's first, each chunk placed at
/// its offset, in any order, and joined once whole.
#[derive(Debug, Clone)]
pub(crate) struct IncomingTransfer {
    bounds: IncomingBounds,
    total: u64,
    // the runs of bytes received, apart and in order, each [start, end)
    runs: Vec<(u64, u64)>,
    // the bytes themselves, each received once, where they go, until they are joined
    pieces: Vec<(u64, Bytes)>,
    whole: Option<Bytes>,
    credit_end: u64,
}

impl IncomingTransfer {
    /// A transfer from its opening, or the failure that refuses it.
    pub(crate) fn new(
        opening: &Bytes,
        (total, bounds): (u64, IncomingBounds),
    ) -> Result<Self, Failure> {
        let invalid = |detail: String| {
            Failure::protocol(ProtocolCode::CHUNK_INVALID, bounds.side).saying(detail)
        };
        let opening_length = length_of(opening);

        // an opening carries one byte of its payload at least (spec 12.3)
        if opening.is_empty() {
            return Err(invalid(
                "an opening carries one byte of its payload at least, not 0".to_owned(),
            ));
        }

        // an opening that holds the whole payload opens no transfer
        if opening_length >= total {
            return Err(invalid(format!(
                "an opening of {opening_length} bytes holds its whole total of {total}"
            )));
        }

        let mut transfer = Self {
            bounds,
            total,
            runs: Vec::new(),
            pieces: Vec::new(),
            whole: None,
            credit_end: opening_length,
        };

        transfer.receive(opening.clone(), 0);

        Ok(transfer)
    }

    /// The end below which it lets its sender send.
    pub(crate) fn credit_end(&self) -> u64 {
        self.credit_end
    }

    // bytes clear of every byte received, placed, and the runs joined around them
    fn receive(&mut self, bytes: Bytes, offset: u64) {
        let end = offset.saturating_add(length_of(&bytes));
        let mut runs = self.runs.clone();
        let mut joined: Vec<(u64, u64)> = Vec::new();

        self.pieces.push((offset, bytes));
        runs.push((offset, end));
        runs.sort_unstable();

        for run in runs {
            match joined.last_mut() {
                Some(last) if run.0 <= last.1 => last.1 = last.1.max(run.1),
                Some(_) | None => joined.push(run),
            }
        }

        self.runs = joined;
    }

    /// The bytes received from the start, one after the other.
    pub(crate) fn contiguous(&self) -> u64 {
        match self.runs.first() {
            Some(&(0, end)) => end,
            Some(_) | None => 0,
        }
    }

    /// Whether every byte came.
    pub(crate) fn is_whole(&self) -> bool {
        self.contiguous() == self.total
    }

    /// The end of a credit to grant now, and granted: a window past the bytes received, once half
    /// of the last was used, within `available` bytes past the last end granted.
    pub(crate) fn credit_to_grant(&mut self, available: u64) -> Option<u64> {
        let next = self
            .total
            .min(self.contiguous().saturating_add(self.bounds.window_bytes))
            .min(self.credit_end.saturating_add(available));
        let granted = next.saturating_sub(self.credit_end);
        let rest = self.total.saturating_sub(self.credit_end);

        // a credit waits until half a window can go at once — or the rest of the payload, when less
        if (granted.saturating_mul(2) < self.bounds.window_bytes && granted < rest)
            || next <= self.credit_end
        {
            return None;
        }

        self.credit_end = next;

        Some(next)
    }

    /// The whole payload, once every byte came: each byte copied once, and its pieces let go.
    pub(crate) fn payload(&mut self) -> Bytes {
        if let Some(whole) = &self.whole {
            return whole.clone();
        }

        let mut whole = BytesMut::zeroed(index_of(self.total));

        for (offset, bytes) in self.pieces.drain(..) {
            let start = index_of(offset);

            if let Some(place) = whole.get_mut(start..start.saturating_add(bytes.len())) {
                place.copy_from_slice(&bytes);
            }
        }

        let whole = whole.freeze();

        self.whole = Some(whole.clone());

        whole
    }

    /// Places a chunk's bytes, checked in order: within the total, not empty, last as it reaches
    /// the total, full; within the credit; received already, whole; clear of every byte received.
    pub(crate) fn place(
        &mut self,
        bytes: &Bytes,
        (is_last, offset): (bool, u64),
    ) -> Result<ChunkOutcome, Failure> {
        let side = self.bounds.side;
        let invalid =
            |detail: String| Failure::protocol(ProtocolCode::CHUNK_INVALID, side).saying(detail);
        let length = length_of(bytes);
        let total = self.total;
        let per_chunk = self.bounds.payload_bytes_per_chunk;

        // bounds written as differences, so no sum runs past what an integer holds
        if offset >= total || length > total.saturating_sub(offset) {
            return Err(invalid(format!(
                "bytes from {offset} run past the total of {total}"
            )));
        }

        if bytes.is_empty() {
            return Err(invalid("a chunk carries one byte at least".to_owned()));
        }

        if is_last != (length == total.saturating_sub(offset)) {
            return Err(invalid(if is_last {
                format!("a last chunk from {offset} ends before the total of {total}")
            } else {
                format!("a chunk from {offset} reaches the total, yet says more follow")
            }));
        }

        // ! a chunk before the last is full, exactly, and the last full at most, as its sender sends
        // them: no small chunk is held, and no CHUNK's envelope passes chunkBytes (spec 12.6.1)
        if if is_last {
            length > per_chunk
        } else {
            length != per_chunk
        } {
            return Err(invalid(if is_last {
                format!("a last chunk carries {per_chunk} bytes at most, not {length}")
            } else {
                format!("a chunk before the last carries {per_chunk} bytes, not {length}")
            }));
        }

        if length > self.credit_end.saturating_sub(offset) {
            return Err(
                Failure::protocol(ProtocolCode::CREDIT_EXCEEDED, side).saying(format!(
                    "bytes from {offset} run past the credit's end of {}",
                    self.credit_end
                )),
            );
        }

        let end = offset.saturating_add(length);

        if self
            .runs
            .iter()
            .any(|&(start, run_end)| start <= offset && end <= run_end)
        {
            return Ok(ChunkOutcome::Duplicate);
        }

        // in part over bytes received, it would hold its whole buffer for a sliver of new bytes
        if self
            .runs
            .iter()
            .any(|&(start, run_end)| start < end && offset < run_end)
        {
            return Err(invalid(format!(
                "bytes from {offset} overlap bytes received in part"
            )));
        }

        self.receive(bytes.clone(), offset);

        if length_of_runs(&self.runs) > self.bounds.maximum_chunk_runs {
            return Err(invalid(format!(
                "more than {} runs of bytes apart",
                self.bounds.maximum_chunk_runs
            )));
        }

        Ok(if self.is_whole() {
            ChunkOutcome::Complete
        } else {
            ChunkOutcome::Placed
        })
    }
}

fn length_of_runs(runs: &[(u64, u64)]) -> u64 {
    u64::try_from(runs.len()).unwrap_or(u64::MAX)
}
