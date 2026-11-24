//! The frame meter (spec 15.3, 15.12, decision 0056): one per connection, on a server and on a
//! client, fed every raw read of its upgraded socket before tungstenite reads it. It reads each
//! frame's head itself, 2 to 14 bytes that may come split across reads (RFC 6455 §5.2), and never
//! unmasks a payload. It judges a head at the byte that draws its verdict: 1009 for a length that
//! takes its message past `maximumMessageBytes`, 1008 for the frame that takes it past
//! `maximumMessageFrames`, 1002 for a head RFC 6455 forbids. What a read brings before the frame so
//! judged is handed on; nothing from that frame on is.
//!
//! It hands tungstenite each data frame longer than 64 KiB as frames of 64 KiB at most (RFC 6455
//! §5.4, no extension negotiated), each piece's mask its frame's key turned by its offset, so the
//! payload passes as it came: tungstenite reserves what a head announces, and holds a single
//! frame's payload as one buffer, so a piece is the most it reserves or holds of one head. On a
//! server it charges each message partway to its budget and holds it to its rate, through its
//! [`Holding`]. It stamps every read that brings bytes on its connection's [`Reads`], what its
//! heartbeat counts its silence from: a part of a frame, a control frame and an unsolicited pong
//! each count, as the socket reads them (spec 15.3).

use core::fmt;
use core::pin::Pin;
use core::task::{Context, Poll};
use std::io;
use std::sync::Arc;

use bytes::{Buf, BytesMut};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::websocket::budget::{Holding, Outside, Partway};
use crate::websocket::connection::{MAXIMUM_MESSAGE_BYTES, Wire};
use crate::websocket::heartbeat::Reads;

#[cfg(test)]
mod tests;

/// The longest data frame the meter hands its platform's reader: a longer one goes on as frames of
/// this many bytes at most, the last of them taking what is left (RFC 6455 §5.4).
pub(crate) const PIECE_BYTES: u64 = 65_536;

/// What a frame's head is charged to a server's budget beyond its bytes, once whole (spec 15.12).
pub(crate) const FRAME_CHARGE: u64 = 128;

// a frame's longest head: 2 bytes, 8 of an extended length, 4 of a mask (RFC 6455 §5.2)
const HEAD_BYTES: usize = 14;

// the opcodes of RFC 6455 §5.2
const CONTINUATION: u8 = 0x0;
const TEXT: u8 = 0x1;
const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;

// a control frame's longest payload (RFC 6455 §5.5)
const CONTROL_BYTES: u64 = 125;

/// What a frame meter fails its connection with, and the bound or the rule a head broke.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) enum MeterVerdict {
    /// A head that takes its message past `maximumMessageBytes`, its value: 1009.
    TooBig(u64),
    /// The frame past `maximumMessageFrames`, its value: 1008.
    TooManyFrames(u64),
    /// A head that breaks RFC 6455 §5.2, §5.4 or §5.5, and the rule it broke: 1002.
    Protocol(String),
}

/// What a frame meter judges the frames it reads by.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub(crate) struct FrameMeterOptions {
    /// Whether the frames it reads are masked, as a client's are: a server's meter reads them so,
    /// and fails an unmasked one; a client's fails a masked one.
    pub(crate) masked: bool,
    /// The largest message it reads: [`MAXIMUM_MESSAGE_BYTES`] when none.
    pub(crate) maximum_message_bytes: Option<u64>,
    /// The frames one message may have: [`crate::MAXIMUM_MESSAGE_FRAMES`] when none.
    pub(crate) maximum_message_frames: Option<u64>,
}

impl FrameMeterOptions {
    /// A meter's options, of frames `masked` or not, its bounds the defaults.
    #[must_use]
    pub(crate) const fn new(masked: bool) -> Self {
        Self {
            masked,
            maximum_message_bytes: None,
            maximum_message_frames: None,
        }
    }
}

/// A frame's head as the meter hands it on: 2 to 14 bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameHead {
    bytes: [u8; HEAD_BYTES],
    length: usize,
}

impl fmt::Debug for FrameHead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("FrameHead")
            .field(&self.as_bytes())
            .finish()
    }
}

impl FrameHead {
    const fn empty() -> Self {
        Self {
            bytes: [0; HEAD_BYTES],
            length: 0,
        }
    }

    // `byte` after those it holds; nothing past its longest
    fn push(&mut self, byte: u8) {
        if let Some(place) = self.bytes.get_mut(self.length) {
            *place = byte;
            self.length = self.length.saturating_add(1);
        }
    }

    /// Its bytes.
    #[must_use]
    pub(crate) fn as_bytes(&self) -> &[u8] {
        self.bytes.get(..self.length).unwrap_or_default()
    }

    fn at(&self, index: usize) -> u8 {
        self.bytes.get(index).copied().unwrap_or(0)
    }
}

/// What one step of a meter did with the bytes it was given.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) enum Handed {
    /// Bytes of a head not yet whole, held: nothing handed for them.
    Held,
    /// Payload bytes, handed as they came.
    AsCame,
    /// A head whole, handed in place of the bytes held and taken for it: the head as it came, or
    /// the first piece's of a data frame past 64 KiB; or, taking nothing, the next piece's.
    Head(FrameHead),
    /// A verdict at the head under way: nothing from its first byte on is handed.
    Verdict(MeterVerdict),
}

/// One step of a meter over the bytes it was given: what it took of them and handed for them, and
/// what they are of a message partway.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) struct MeterStep {
    /// The bytes it took, from the first.
    pub(crate) taken: usize,
    /// What it handed for them.
    pub(crate) handed: Handed,
    /// What they charge a server's budget: the payload bytes of a message partway, a control
    /// frame's between its frames among them, and a head's bytes and 128 more once it is whole,
    /// at its last byte (spec 15.12).
    pub(crate) charge: u64,
    /// The payload of a data frame they bring, which a server's rate counts.
    pub(crate) payload: u64,
    /// Whether a message begins at their first byte.
    pub(crate) begins: bool,
    /// Whether their last byte ends a message, which is whole with them.
    pub(crate) ends: bool,
}

impl MeterStep {
    const fn of(taken: usize, handed: Handed) -> Self {
        Self {
            taken,
            handed,
            charge: 0,
            payload: 0,
            begins: false,
            ends: false,
        }
    }
}

// a frame past its head: what is left of it, and of the piece it is handed in
#[derive(Debug, Clone)]
struct Frame {
    fin: bool,
    is_data: bool,
    is_charged: bool,
    left: u64,
    piece_left: u64,
    // the payload's bytes handed so far, which turn a piece's mask
    offset: u64,
    key: Option<[u8; 4]>,
}

// a message under way: the lengths its frames' heads announced, and its frames
#[derive(Debug, Clone, Copy)]
struct Message {
    announced: u64,
    frames: u64,
}

/// A WebSocket connection's frame meter, without its socket.
///
/// It is given the bytes its socket read, in order, and steps through them: a head held until
/// whole, then handed as it came or as the first of its pieces, a payload handed as it came, each
/// verdict at the byte that draws it.
#[derive(Debug, Clone)]
pub(crate) struct FrameMeter {
    masked: bool,
    maximum_message_bytes: u64,
    maximum_message_frames: u64,
    head: FrameHead,
    // whether the head under way is a message's, charged
    is_charged: bool,
    frame: Option<Frame>,
    message: Option<Message>,
    verdict: Option<MeterVerdict>,
}

impl FrameMeter {
    /// A meter that read nothing yet, judging by `options`.
    #[must_use]
    pub(crate) fn new(options: &FrameMeterOptions) -> Self {
        Self {
            masked: options.masked,
            maximum_message_bytes: options
                .maximum_message_bytes
                .unwrap_or(MAXIMUM_MESSAGE_BYTES),
            maximum_message_frames: options
                .maximum_message_frames
                .unwrap_or(crate::MAXIMUM_MESSAGE_FRAMES),
            head: FrameHead::empty(),
            is_charged: false,
            frame: None,
            message: None,
            verdict: None,
        }
    }

    /// Whether it stands between two frames: no head begun, no payload left of the last.
    #[cfg(feature = "testing")]
    #[must_use]
    pub(crate) const fn is_between_frames(&self) -> bool {
        self.frame.is_none() && self.head.length == 0
    }

    /// What is left of the piece under way, in a data frame it hands in pieces; none otherwise.
    pub(crate) fn piece_left(&self) -> Option<u64> {
        self.frame
            .as_ref()
            .filter(|frame| frame.is_data && frame.piece_left > 0)
            .map(|frame| frame.piece_left)
    }

    /// Whether its next step is the next piece's head, which takes no byte.
    pub(crate) fn is_piece_due(&self) -> bool {
        self.verdict.is_none()
            && self
                .frame
                .as_ref()
                .is_some_and(|frame| frame.piece_left == 0 && frame.left > 0)
    }

    /// One step over `input`, the bytes that came after those it took before: a head's bytes held,
    /// a head whole handed, a payload's bytes handed, or the verdict a head drew. It takes none of
    /// `input` for the next piece's head, nor once it drew a verdict.
    pub(crate) fn step(&mut self, input: &[u8]) -> MeterStep {
        if let Some(verdict) = &self.verdict {
            return MeterStep::of(0, Handed::Verdict(verdict.clone()));
        }

        match self.frame.take() {
            Some(frame) => self.payload_of((frame, input)),
            None => self.head_of(input),
        }
    }

    fn payload_of(&mut self, (mut frame, input): (Frame, &[u8])) -> MeterStep {
        // * the next piece's head, in place of no byte: a continuation, final with its frame's last
        if frame.piece_left == 0 && frame.left > 0 {
            let length = frame.left.min(PIECE_BYTES);
            let is_last = length == frame.left;
            let head = head_of(
                (frame.fin && is_last, CONTINUATION),
                (length, frame.key.map(|key| turned(key, frame.offset))),
            );

            frame.piece_left = length;
            self.frame = Some(frame);

            return MeterStep::of(0, Handed::Head(head));
        }

        let available = u64::try_from(input.len()).unwrap_or(u64::MAX);
        let taken = available.min(frame.piece_left);
        let mut step = MeterStep::of(usize::try_from(taken).unwrap_or(0), Handed::AsCame);

        frame.left = frame.left.saturating_sub(taken);
        frame.piece_left = frame.piece_left.saturating_sub(taken);
        frame.offset = frame.offset.saturating_add(taken);

        if frame.is_charged {
            step.charge = taken;
        }

        if frame.is_data {
            step.payload = taken;
        }

        if frame.left > 0 {
            self.frame = Some(frame);
        } else {
            step.ends = self.frame_ended(&frame);
        }

        step
    }

    // a frame whole: its message whole with its last; whether it was
    fn frame_ended(&mut self, frame: &Frame) -> bool {
        if frame.is_data && frame.fin {
            self.message = None;

            return true;
        }

        false
    }

    fn head_of(&mut self, input: &[u8]) -> MeterStep {
        let mut taken = 0_usize;
        let begins = self.head.length == 0
            && input.first().is_some_and(|first| {
                self.message.is_none() && matches!(first & 0x0F, TEXT | BINARY)
            });

        if begins || (self.head.length == 0 && self.message.is_some()) {
            self.is_charged = true;
        }

        for byte in input {
            self.head.push(*byte);
            taken = taken.saturating_add(1);

            if let Some(verdict) = self.judge() {
                self.verdict = Some(verdict.clone());

                let mut step = MeterStep::of(taken, Handed::Verdict(verdict));

                step.begins = begins;

                return step;
            }

            if self.head.length == self.head_length() {
                return self.whole((taken, begins));
            }
        }

        // * a head not yet whole charges nothing: its bytes are charged once it is
        let mut step = MeterStep::of(taken, Handed::Held);

        step.begins = begins;

        step
    }

    // the length its head takes, once its second byte came: 2 until then
    fn head_length(&self) -> usize {
        if self.head.length < 2 {
            return 2;
        }

        let second = self.head.at(1);
        let extended = match second & 0x7F {
            126 => 2,
            127 => 8,
            _ => 0,
        };
        let mask = if second & 0x80 == 0 { 0 } else { 4 };

        2_usize.saturating_add(extended).saturating_add(mask)
    }

    // * each rule judged at the byte that draws it, the head's last byte just pushed
    fn judge(&self) -> Option<MeterVerdict> {
        match self.head.length {
            1 => self.judge_first(self.head.at(0)),
            2 => {
                let second = self.head.at(1);
                let is_masked = second & 0x80 != 0;

                if self.masked && !is_masked {
                    return Some(protocol("an unmasked frame"));
                }

                if !self.masked && is_masked {
                    return Some(protocol("a masked frame"));
                }

                // ! a control frame's length is judged in its 7 bits: a longer form, whatever its
                // value, breaks RFC 6455 §5.2's minimal form, and every side refuses it alike
                if self.head.at(0) & 0x08 != 0 && u64::from(second & 0x7F) > CONTROL_BYTES {
                    return Some(protocol("a control frame longer than 125 bytes"));
                }

                self.judge_length()
            }
            // ! RFC 6455 §5.2: a 64-bit length's most significant bit is 0
            3 if self.head.at(1) & 0x7F == 127 && self.head.at(2) & 0x80 != 0 => {
                Some(protocol("a 64-bit length with its top bit set"))
            }
            4 | 10 => self.judge_length(),
            _ => None,
        }
    }

    fn judge_first(&self, first: u8) -> Option<MeterVerdict> {
        let opcode = first & 0x0F;
        let is_final = first & 0x80 != 0;

        // * no extension negotiated (spec 15.2): every reserved bit is 0
        if first & 0x70 != 0 {
            return Some(protocol("a reserved bit set"));
        }

        match opcode {
            3..=7 | 11..=15 => Some(MeterVerdict::Protocol(format!(
                "a reserved opcode, {opcode}"
            ))),
            CLOSE..=10 if !is_final => Some(protocol("a control frame not final")),
            CONTINUATION if self.message.is_none() => {
                Some(protocol("a continuation with no message under way"))
            }
            TEXT | BINARY if self.message.is_some() => Some(protocol(
                "a data frame that is not a continuation while a message is under way",
            )),
            CONTINUATION | TEXT | BINARY => {
                let frames = self
                    .message
                    .map_or(0, |message| message.frames)
                    .saturating_add(1);

                (frames > self.maximum_message_frames)
                    .then_some(MeterVerdict::TooManyFrames(self.maximum_message_frames))
            }
            _ => None,
        }
    }

    // the length a data frame's head announces, once it came, its form minimal or not, against its
    // message's bound; a control frame's was judged in its 7 bits
    fn judge_length(&self) -> Option<MeterVerdict> {
        let opcode = self.head.at(0) & 0x0F;
        let length = announced_of(&self.head)?;

        if opcode & 0x08 != 0 {
            return None;
        }

        let before = if opcode == CONTINUATION {
            self.message.map_or(0, |message| message.announced)
        } else {
            0
        };

        (before.saturating_add(length) > self.maximum_message_bytes)
            .then_some(MeterVerdict::TooBig(self.maximum_message_bytes))
    }

    // a head whole, `taken` of the input completing it: its frame under way, handed as it came or
    // as its first piece
    fn whole(&mut self, (taken, begins): (usize, bool)) -> MeterStep {
        let head = core::mem::replace(&mut self.head, FrameHead::empty());
        let is_charged = core::mem::take(&mut self.is_charged);
        let first = head.at(0);
        let opcode = first & 0x0F;
        let is_data = opcode & 0x08 == 0;
        let fin = first & 0x80 != 0;
        let length = announced_of(&head).unwrap_or(0);
        let key = (head.at(1) & 0x80 != 0).then(|| {
            let at = head.length.saturating_sub(4);

            [
                head.at(at),
                head.at(at.saturating_add(1)),
                head.at(at.saturating_add(2)),
                head.at(at.saturating_add(3)),
            ]
        });

        if is_data {
            let message = self.message.get_or_insert(Message {
                announced: 0,
                frames: 0,
            });

            message.announced = message.announced.saturating_add(length);
            message.frames = message.frames.saturating_add(1);
        }

        // * a data frame past a piece goes on in pieces: its first keeps its opcode, never final
        let (handed, piece_left) = if is_data && length > PIECE_BYTES {
            (head_of((false, opcode), (PIECE_BYTES, key)), PIECE_BYTES)
        } else {
            (head, length)
        };
        let frame = Frame {
            fin,
            is_data,
            is_charged,
            left: length,
            piece_left,
            offset: 0,
            key,
        };
        let mut step = MeterStep::of(taken, Handed::Head(handed));

        // * a head whole: every byte of it, those of the reads before among them, and 128
        if is_charged {
            step.charge = u64::try_from(head.length)
                .unwrap_or(u64::MAX)
                .saturating_add(FRAME_CHARGE);
        }

        step.begins = begins;

        if length == 0 {
            step.ends = self.frame_ended(&frame);
        } else {
            self.frame = Some(frame);
        }

        step
    }
}

// the length `head` announces, once its length's bytes came
fn announced_of(head: &FrameHead) -> Option<u64> {
    match head.at(1) & 0x7F {
        126 => (head.length >= 4).then(|| u64::from(u16::from_be_bytes([head.at(2), head.at(3)]))),
        127 => (head.length >= 10).then(|| {
            let mut length = [0_u8; 8];

            for (index, place) in length.iter_mut().enumerate() {
                *place = head.at(index.saturating_add(2));
            }

            u64::from_be_bytes(length)
        }),
        short => (head.length >= 2).then_some(u64::from(short)),
    }
}

fn protocol(why: &str) -> MeterVerdict {
    MeterVerdict::Protocol(why.to_owned())
}

// a mask key turned by `offset`, so its piece's payload unmasks as the frame's would there
fn turned(key: [u8; 4], offset: u64) -> [u8; 4] {
    let by = usize::try_from(offset.checked_rem(4).unwrap_or(0)).unwrap_or(0);
    let mut turned = key;

    turned.rotate_left(by);
    turned
}

// a head of its own: `fin` and `opcode`, its length in 7, 16 or 64 bits as it needs, and its key
fn head_of((fin, opcode): (bool, u8), (length, key): (u64, Option<[u8; 4]>)) -> FrameHead {
    let mut head = FrameHead::empty();
    let mask = if key.is_some() { 0x80 } else { 0 };

    head.push(if fin { 0x80 } else { 0 } | opcode);

    if let Ok(short) = u8::try_from(length)
        && u64::from(short) <= CONTROL_BYTES
    {
        head.push(mask | short);
    } else if let Ok(medium) = u16::try_from(length) {
        head.push(mask | 0x7E);

        for byte in medium.to_be_bytes() {
            head.push(byte);
        }
    } else {
        head.push(mask | 0x7F);

        for byte in length.to_be_bytes() {
            head.push(byte);
        }
    }

    for byte in key.into_iter().flatten() {
        head.push(byte);
    }

    head
}

// ── Its socket ───────────────────────────────────────────────────────────────────────────────

// where a meter's socket stands
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    // a client's upgrade under way: its response's head handed whole, nothing past it, and the
    // count of the bytes of its last line's end seen
    Upgrading(u8),
    // its frames metered
    Metering,
    // a verdict drawn: its reader is told so, and handed nothing more
    Judged,
    // its connection failing: what comes passes raw, parsed by none
    Raw,
}

/// How a meter is set over its socket.
pub(crate) struct Metering {
    /// What came past the upgrade's head with it, read before anything of the socket.
    pub(crate) read: Vec<u8>,
    /// Where each read is stamped.
    pub(crate) reads: Arc<Reads>,
    /// What its frames are judged by.
    pub(crate) frames: FrameMeterOptions,
    /// A server's charge and rate; none for a client.
    pub(crate) holding: Option<Holding>,
    /// Whether it begins under a client's upgrade, which tungstenite reads over it.
    pub(crate) is_upgrading: bool,
}

/// A socket whose every read is metered before tungstenite reads it, and stamped.
pub(crate) struct Meter<S> {
    socket: S,
    reads: Arc<Reads>,
    frames: FrameMeter,
    phase: Phase,
    // bytes read and not yet stepped through, and bytes stepped through not yet handed
    held: BytesMut,
    queue: BytesMut,
    holding: Option<Holding>,
    verdict: Option<Verdict>,
}

impl<S> fmt::Debug for Meter<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Meter")
            .field("phase", &self.phase)
            .field("verdict", &self.verdict)
            .finish_non_exhaustive()
    }
}

/// What failed a connection through its meter: a head's verdict, or one that came from outside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// A head's.
    Head(MeterVerdict),
    /// Cast off by its server's budget, of this many bytes: 1013.
    CastOff(u64),
    /// Its message came slower than its rate, and why: 1008.
    Slow(String),
}

impl<S> Meter<S> {
    /// `socket`, metered as `metering` says.
    pub(crate) fn new(socket: S, metering: Metering) -> Self {
        let Metering {
            read,
            reads,
            frames,
            holding,
            is_upgrading,
        } = metering;

        Self {
            socket,
            reads,
            frames: FrameMeter::new(&frames),
            phase: if is_upgrading {
                Phase::Upgrading(0)
            } else {
                Phase::Metering
            },
            held: BytesMut::from(read.as_slice()),
            queue: BytesMut::new(),
            holding,
            verdict: None,
        }
    }

    /// Its verdict, once it drew one.
    pub(crate) const fn verdict(&self) -> Option<&Verdict> {
        self.verdict.as_ref()
    }

    /// What its message partway is held by, a server's, which its router's pause stamps.
    pub(crate) fn partway(&self) -> Option<Arc<Partway>> {
        self.holding.as_ref().map(Holding::partway)
    }

    /// Tells `signal` what comes from outside it: a cast-off, its rate's timer.
    pub(crate) fn on_outside(&self, signal: Box<dyn Fn(Outside) + Send + Sync>) {
        if let Some(holding) = &self.holding {
            holding.partway().listen(signal);
        }
    }

    /// Its connection's router resumed it: its rate's clock runs again.
    pub(crate) fn resumed(&mut self) {
        if self.phase == Phase::Metering
            && let Some(holding) = self.holding.as_mut()
        {
            holding.rearm();
        }
    }

    /// Judges its message against its rate, its timer fired: a verdict, its message too slow, or
    /// its timer armed again for what is left.
    pub(crate) fn judge_late(&mut self) -> Option<Verdict> {
        if self.phase != Phase::Metering {
            return None;
        }

        let holding = self.holding.as_mut()?;

        if !holding.judge_late() {
            return None;
        }

        let why = holding.late_of();

        Some(self.draw(Verdict::Slow(why)))
    }

    /// Judges whether its server's budget cast it off: its verdict if it did.
    pub(crate) fn judge_cast_off(&mut self) -> Option<Verdict> {
        if self.phase != Phase::Metering {
            return None;
        }

        let budget = self
            .holding
            .as_ref()
            .filter(|holding| holding.is_cast_off())
            .map(Holding::budget)?;

        Some(self.draw(Verdict::CastOff(budget)))
    }

    /// It meters no more: what comes passes raw, parsed by none; its charge released, its rate's
    /// timer disarmed, and nothing charged after it.
    pub(crate) fn stop(&mut self) {
        self.release();
        self.phase = Phase::Raw;
    }

    // what it holds dropped, unparsed, its charge released and its rate's timer disarmed
    fn release(&mut self) {
        self.held = BytesMut::new();
        self.queue = BytesMut::new();

        if let Some(holding) = self.holding.as_mut() {
            holding.stop();
        }
    }

    // a verdict drawn: kept, its reader told, and nothing more metered nor charged
    fn draw(&mut self, verdict: Verdict) -> Verdict {
        self.verdict.get_or_insert_with(|| verdict.clone());
        self.release();

        if self.phase != Phase::Raw {
            self.phase = Phase::Judged;
        }

        verdict
    }

    // the bytes of `region` stepped through in place, those it hands moved to its front: how many
    // it hands; a head that needs more room than the bytes it took goes to the queue, what follows
    // it back to what is held
    fn meter(&mut self, region: &mut [u8]) -> usize {
        let mut read = 0_usize;
        let mut written = 0_usize;
        // the charge and the payload of the message these bytes bring, and where its bytes begin
        // among those handed
        let mut charge = 0_u64;
        let mut payload = 0_u64;
        let mut charged_from = 0_usize;

        while read < region.len() {
            let step = self.frames.step(region.get(read..).unwrap_or_default());
            let end = read.saturating_add(step.taken);
            let mut is_overflowing = false;

            if step.begins {
                payload = 0;
                charged_from = written;

                if let Some(holding) = self.holding.as_mut() {
                    holding.begin();
                }
            }

            charge = charge.saturating_add(step.charge);
            payload = payload.saturating_add(step.payload);

            match step.handed {
                Handed::Held => {}
                Handed::AsCame => {
                    if written != read {
                        region.copy_within(read..end, written);
                    }

                    written = written.saturating_add(step.taken);
                }
                Handed::Head(head) => {
                    let bytes = head.as_bytes();
                    let after = written.saturating_add(bytes.len());

                    if after <= end
                        && let Some(place) = region.get_mut(written..after)
                    {
                        place.copy_from_slice(bytes);
                        written = after;
                    } else {
                        // * no room before what it took: the head waits in the queue, the rest of
                        // the region before what was held
                        let mut rest = BytesMut::from(region.get(end..).unwrap_or_default());

                        rest.extend_from_slice(&self.held);
                        self.held = rest;
                        self.queue.extend_from_slice(bytes);
                        is_overflowing = true;
                    }
                }
                // ! what the region brought before the judged frame is charged first: a cast-off
                // at an earlier byte wins over the verdict, whose head charges nothing
                Handed::Verdict(verdict) => {
                    if !self.charge(charge) {
                        return charged_from;
                    }

                    self.draw(Verdict::Head(verdict));

                    return written;
                }
            }

            read = end;

            // * a message whole: its last charge taken, then released at once
            if step.ends {
                let last = core::mem::take(&mut charge);
                let is_taken = self
                    .holding
                    .as_mut()
                    .is_none_or(|holding| holding.finish(last));

                if !is_taken {
                    self.cast_off_itself();

                    return charged_from;
                }

                payload = 0;
            }

            if is_overflowing {
                break;
            }
        }

        if !self.charge(charge) {
            return charged_from;
        }

        // * its rate's timer armed once a read, for a message still partway
        if let Some(holding) = self.holding.as_mut() {
            holding.brought(payload);
            holding.rearm();
        }

        written
    }

    // `charge` asked of its budget; false, its verdict drawn, once the budget cast it off
    fn charge(&mut self, charge: u64) -> bool {
        if charge == 0 {
            return true;
        }

        let is_taken = self
            .holding
            .as_mut()
            .is_none_or(|holding| holding.charge(charge));

        if !is_taken {
            self.cast_off_itself();
        }

        is_taken
    }

    // its own charge cast it off: its verdict drawn
    fn cast_off_itself(&mut self) {
        let budget = self.holding.as_ref().map_or(0, Holding::budget);

        self.draw(Verdict::CastOff(budget));
    }
}

// what a meter hands its reader once it drew a verdict: an error, which its connection reads as
// that verdict
fn verdict_error() -> io::Error {
    io::Error::other("the frame meter drew a verdict")
}

impl<S: AsyncRead + Unpin> Meter<S> {
    // reads its socket into `buffer`, at most `most` bytes: how many came, 0 at its end
    fn poll_socket(
        &mut self,
        context: &mut Context<'_>,
        (buffer, most): (&mut ReadBuf<'_>, usize),
    ) -> Poll<io::Result<usize>> {
        let unfilled = buffer.initialize_unfilled_to(most.min(buffer.remaining()));
        let mut limited = ReadBuf::new(unfilled);

        match Pin::new(&mut self.socket).poll_read(context, &mut limited) {
            Poll::Ready(Ok(())) => {}
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Pending => return Poll::Pending,
        }

        let came = limited.filled().len();

        buffer.advance(came);

        if came > 0 {
            self.reads.stamp();
        }

        Poll::Ready(Ok(came))
    }

    // a client's upgrade: its response handed up to its head's end, an empty line, and what came
    // past it held for the meter
    fn poll_upgrading(
        &mut self,
        context: &mut Context<'_>,
        (buffer, seen): (&mut ReadBuf<'_>, u8),
    ) -> Poll<io::Result<()>> {
        let start = buffer.filled().len();
        match self.poll_socket(context, (buffer, usize::MAX)) {
            Poll::Ready(Ok(_)) => {}
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Pending => return Poll::Pending,
        }

        let mut seen = seen;
        let mut end = None;

        for (index, byte) in buffer
            .filled()
            .get(start..)
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            // * a line's end is LF, after CR or not: two in a row, a CR between them or not, end
            // the head
            seen = match (seen, *byte) {
                (1 | 2, b'\n') => {
                    end = Some(index.saturating_add(1));
                    break;
                }
                (1, b'\r') => 2,
                (_, b'\n') => 1,
                _ => 0,
            };
        }

        match end {
            Some(end) => {
                let at = start.saturating_add(end);

                self.held
                    .extend_from_slice(buffer.filled().get(at..).unwrap_or_default());
                buffer.set_filled(at);
                self.phase = Phase::Metering;
            }
            None => self.phase = Phase::Upgrading(seen),
        }

        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Meter<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let meter = self.get_mut();

        match meter.phase {
            Phase::Judged => return Poll::Ready(Err(verdict_error())),
            Phase::Raw => {
                return meter
                    .poll_socket(context, (buffer, usize::MAX))
                    .map(|read| read.map(|_| ()));
            }
            Phase::Upgrading(seen) => return meter.poll_upgrading(context, (buffer, seen)),
            Phase::Metering => {}
        }

        loop {
            if buffer.remaining() == 0 {
                return Poll::Ready(Ok(()));
            }

            // * a cast-off takes effect at once: nothing more handed
            if meter.judge_cast_off().is_some() {
                return Poll::Ready(Err(verdict_error()));
            }

            if !meter.queue.is_empty() {
                let length = meter.queue.len().min(buffer.remaining());

                buffer.put_slice(meter.queue.get(..length).unwrap_or_default());
                meter.queue.advance(length);

                return Poll::Ready(Ok(()));
            }

            if meter.frames.is_piece_due() {
                let step = meter.frames.step(&[]);

                if let Handed::Head(head) = step.handed {
                    meter.queue.extend_from_slice(head.as_bytes());
                }

                continue;
            }

            let start = buffer.filled().len();

            if meter.held.is_empty() {
                // * a piece's payload read alone, so the next piece's head goes at a read's start
                let most = meter.frames.piece_left().map_or(usize::MAX, |left| {
                    usize::try_from(left).unwrap_or(usize::MAX)
                });

                match meter.poll_socket(context, (buffer, most)) {
                    Poll::Ready(Ok(0)) => return Poll::Ready(Ok(())),
                    Poll::Ready(Ok(_)) => {}
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Pending => return Poll::Pending,
                }
            } else {
                let length = meter.held.len().min(buffer.remaining());

                buffer.put_slice(meter.held.get(..length).unwrap_or_default());
                meter.held.advance(length);
            }

            let handed = buffer
                .filled_mut()
                .get_mut(start..)
                .map_or(0, |region| meter.meter(region));

            buffer.set_filled(start.saturating_add(handed));

            if handed > 0 {
                return Poll::Ready(Ok(()));
            }

            if meter.verdict.is_some() {
                return Poll::Ready(Err(verdict_error()));
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Meter<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(context, bytes)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write_vectored(context, buffers)
    }

    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(context)
    }
}

impl<S: Wire> Wire for Meter<S> {
    fn abort(&self) {
        self.socket.abort();
    }

    // ! never stamped: what it sees of its socket is no read
    fn poll_ended(&self, context: &mut Context<'_>) -> Poll<()> {
        self.socket.poll_ended(context)
    }
}
