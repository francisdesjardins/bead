//! A stream's call as Server-Sent Events of WHATWG HTML §9.2 (spec/transcoding.md 8): its result
//! first, each notification a plain event, the failure that ends it last, each an id, a comment
//! while nothing goes, and each notification credited once its event was taken.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::oneshot;

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::NEVER;
use crate::errors::ProgrammerError;
use crate::router::types::BoxFuture;
use crate::transcoding::problems::Problem;

#[cfg(test)]
mod tests;

/// The media type of a stream of events (WHATWG HTML §9.2).
pub const EVENT_STREAM_MEDIA_TYPE: &str = "text/event-stream";

/// A heartbeat's comment, which no `EventSource` dispatches (§9.2.6).
pub const HEARTBEAT_COMMENT: &str = ":\n";

/// An event as a stream writes it (8.5): its data, its id, and its name where it has one.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ServerSentEvent {
    /// `result` or `failure`; none for a notification, a plain event.
    pub name: Option<&'static str>,
    /// Its count in the stream, from 1.
    pub id: u64,
    /// One JSON text.
    pub data: String,
}

impl ServerSentEvent {
    /// The event of `data`, counted `id`, a plain one.
    #[must_use]
    pub const fn new(id: u64, data: String) -> Self {
        Self {
            name: None,
            id,
            data,
        }
    }

    /// Its lines (8.5): its name where it has one, its id, its data, then the empty line.
    #[must_use]
    pub fn text(&self) -> String {
        let name = self
            .name
            .map_or_else(String::new, |name| format!("event: {name}\n"));

        format!("{name}id: {}\ndata: {}\n\n", self.id, self.data)
    }
}

/// What a write gives: whether the response took it, written to its socket or its drain come.
pub type Taken = BoxFuture<bool>;

/// Where a stream goes: the response a gateway writes it on.
pub trait EventSink: Send + 'static {
    /// Answers a failure that came before its result, as any call's: a problem of its status.
    fn answer(&mut self, problem: Problem);
    /// Ends the response, once the failure that ends the stream went.
    fn end(&mut self);
    /// Writes the stream's head, 200 `text/event-stream`, before its first event.
    fn open(&mut self);
    /// Writes `text`, and tells once the response took it, or could not.
    fn write(&mut self, text: String) -> Taken;
}

// a notification that came before the result, and what settles its credit once its event is
// written: the taking of that write, or nothing where it is dropped
struct Held {
    data: String,
    settle: oneshot::Sender<Taken>,
}

struct State {
    sink: Box<dyn EventSink>,
    held: Vec<Held>,
    count: u64,
    is_open: bool,
    is_ended: bool,
    // whether its client went: what comes after is dropped, no bug of its caller's
    is_closed: bool,
    timer: Option<Arc<dyn Timer>>,
}

impl State {
    fn stop_beating(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }
    }

    fn event(&mut self, data: String, name: Option<&'static str>) -> String {
        self.count = self.count.saturating_add(1);

        ServerSentEvent {
            name,
            id: self.count,
            data,
        }
        .text()
    }
}

struct Shared {
    state: Mutex<State>,
    clock: SharedClock,
    every: Duration,
}

fn locked(shared: &Shared) -> MutexGuard<'_, State> {
    shared.state.lock().unwrap_or_else(PoisonError::into_inner)
}

// * re-armed by every write: a comment only while nothing else goes
fn beat(shared: &Arc<Shared>, state: &mut State) {
    state.stop_beating();

    if shared.every >= NEVER || state.is_ended {
        return;
    }

    let weak = Arc::downgrade(shared);
    let armed = shared.clock.arm(
        Schedule::Once(shared.every),
        Box::new(move || {
            let Some(shared) = weak.upgrade() else {
                return;
            };
            let mut state = locked(&shared);

            state.timer = None;

            if !state.is_ended {
                drop(state.sink.write(HEARTBEAT_COMMENT.to_owned()));
                beat(&shared, &mut state);
            }

            drop(state);
        }),
    );

    state.timer = armed.ok();
}

// writes `text`, its heartbeat re-armed
fn write(shared: &Arc<Shared>, (state, text): (&mut State, String)) -> Taken {
    let taken = state.sink.write(text);

    beat(shared, state);

    taken
}

/// What a stream's call is given, in order, and writes as its events (transcoding 8).
///
/// Nothing before its result; a notification that comes first held, then written after it, or dropped by a
/// failure; each event an id, its count from 1; a comment every `heartbeat` while nothing else
/// goes; each notification settled once its event was taken, the subscription's credit. A second
/// result, or a result or a notification once its failure ended it, is its caller's bug, a
/// [`ProgrammerError`]; once it is closed, its client gone, what comes is dropped.
#[derive(Clone)]
pub struct EventStream {
    shared: Arc<Shared>,
}

impl fmt::Debug for EventStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventStream")
            .field("every", &self.shared.every)
            .finish_non_exhaustive()
    }
}

/// The comment a stream writes while nothing else goes: its clock, and how often.
#[derive(Debug, Clone)]
pub struct EventHeartbeat {
    /// The clock its comments are timed on.
    pub clock: SharedClock,
    /// How often, [`NEVER`] for none.
    pub every: Duration,
}

impl EventStream {
    /// A stream written on `sink`, a comment every `heartbeat.every` on its clock while nothing else
    /// goes, [`NEVER`] for none, held as a gateway holds it.
    #[must_use]
    pub fn new(sink: Box<dyn EventSink>, heartbeat: EventHeartbeat) -> Self {
        let EventHeartbeat {
            clock,
            every: heartbeat,
        } = heartbeat;

        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    sink,
                    held: Vec::new(),
                    count: 0,
                    is_open: false,
                    is_ended: false,
                    is_closed: false,
                    timer: None,
                }),
                clock,
                every: heartbeat,
            }),
        }
    }

    /// Whether it ended: by its failure, before its result or after, or closed.
    #[must_use]
    pub fn is_ended(&self) -> bool {
        locked(&self.shared).is_ended
    }

    /// Stops it with nothing more written: its client went, its heartbeat stopped.
    pub fn close(&self) {
        let mut state = locked(&self.shared);

        state.is_ended = true;
        state.is_closed = true;
        state.stop_beating();
        state.held.clear();
    }

    /// Its call's failure: a problem before its result, its last event after, its end either way.
    pub fn failure(&self, problem: Problem) {
        let mut state = locked(&self.shared);

        if state.is_ended {
            return;
        }

        state.is_ended = true;
        state.stop_beating();

        if !state.is_open {
            state.held.clear();
            state.sink.answer(problem);

            return;
        }

        let text = state.event(problem.body, Some("failure"));

        drop(state.sink.write(text));
        state.sink.end();
    }

    /// A notification's data, one JSON text: held until its result, and written after it; its
    /// future ends once the response took its event, which credits the next (8.8), or once the
    /// stream could not take it, its credit moot: dropped by the failure that ends it, or closed.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a notification once the failure that ended the stream went.
    pub fn notification(&self, data: String) -> Result<BoxFuture<()>, ProgrammerError> {
        let mut state = locked(&self.shared);

        if state.is_closed {
            return Ok(Box::pin(async {}));
        }

        // ! a notification once the failure that ended the stream went is its caller's bug
        if state.is_ended {
            return Err(ProgrammerError::new(
                "a notification after the stream ended",
            ));
        }

        if !state.is_open {
            let (settle, settled) = oneshot::channel::<Taken>();

            state.held.push(Held { data, settle });
            drop(state);

            return Ok(Box::pin(async move {
                if let Ok(taken) = settled.await {
                    taken.await;
                }
            }));
        }

        let text = state.event(data, None);
        // * its credit moot once the stream could not take its event: settled either way
        let taken = write(&self.shared, (&mut state, text));

        drop(state);

        Ok(Box::pin(async move {
            taken.await;
        }))
    }

    /// Its call's result, one JSON text: the stream opens, its first event.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a second result, or one once its failure ended it.
    pub fn result(&self, data: String) -> Result<(), ProgrammerError> {
        let mut state = locked(&self.shared);

        if state.is_closed {
            return Ok(());
        }

        // ! a stream has one result, before its end: another is its caller's bug
        if state.is_ended || state.is_open {
            return Err(ProgrammerError::new(
                "a stream has one result, before its end",
            ));
        }

        state.is_open = true;
        state.sink.open();

        let text = state.event(data, Some("result"));

        drop(write(&self.shared, (&mut state, text)));

        for held in core::mem::take(&mut state.held) {
            let text = state.event(held.data, None);
            let taken = write(&self.shared, (&mut state, text));

            // * settled once taken, or once the stream could not take it, its credit moot
            drop(held.settle.send(taken));
        }

        drop(state);

        Ok(())
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `bytes` in base64 of RFC 4648 §4, padded, as protobuf's JSON writes `bytes` and an event writes
/// a `raw` payload's data.
#[must_use]
pub fn base64_of(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3).saturating_mul(4));

    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or_default();
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        let indices = [
            first >> 2,
            ((first & 0x03) << 4) | (second >> 4),
            ((second & 0x0f) << 2) | (third >> 6),
            third & 0x3f,
        ];
        let written = chunk.len().saturating_add(1);

        for (at, index) in indices.iter().enumerate() {
            if at < written {
                text.push(char::from(
                    BASE64.get(usize::from(*index)).copied().unwrap_or(b'A'),
                ));
            } else {
                text.push('=');
            }
        }
    }

    text
}

/// `text` read as base64 of RFC 4648 §4, padded and canonical, its unused bits 0: none for any
/// other text.
#[must_use]
pub fn bytes_of_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();

    if !bytes.len().is_multiple_of(4) {
        return None;
    }

    let mut decoded = Vec::with_capacity(bytes.len());
    let quads = bytes.chunks(4);
    let last = quads.len().saturating_sub(1);

    for (at, quad) in quads.enumerate() {
        let pads = quad.iter().rev().take_while(|byte| **byte == b'=').count();

        if pads > 2 || (pads > 0 && at != last) {
            return None;
        }

        let mut values = [0_u8; 4];

        for (index, byte) in quad.iter().enumerate().take(4_usize.saturating_sub(pads)) {
            let value = BASE64.iter().position(|letter| letter == byte)?;

            *values.get_mut(index)? = u8::try_from(value).ok()?;
        }

        let [a, b, c, d] = values;
        let octets = [(a << 2) | (b >> 4), (b << 4) | (c >> 2), (c << 6) | d];

        // ! the bits a padded quad leaves unused are 0, or the text is not canonical
        if (pads == 1 && c & 0x03 != 0) || (pads == 2 && b & 0x0f != 0) {
            return None;
        }

        decoded.extend_from_slice(octets.get(..3_usize.saturating_sub(pads))?);
    }

    Some(decoded)
}

/// A `text` payload's event data, its UTF-8 text as one JSON string; none where it is no UTF-8.
#[must_use]
pub fn text_data_of(payload: &[u8]) -> Option<String> {
    let text = core::str::from_utf8(payload).ok()?;

    crate::json::write(&serde_json::Value::from(text))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// A `raw` payload's event data, its bytes in base64 as one JSON string.
#[must_use]
pub fn raw_data_of(payload: &[u8]) -> String {
    format!("\"{}\"", base64_of(payload))
}
