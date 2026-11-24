//! The properties of the `websocket-frames` fuzz target (decision 0056).
//!
//! Its target and the side's mutation test hold them alike. The input's first byte picks the side
//! that reads, a server by its low bit clear, and where the rest is cut in two reads, by its other
//! bits; the rest is the stream. Fed to the frame meter and to tungstenite, which reads them from a
//! cursor, they agree on the bounds of each frame, on the end of each message, and on whether the
//! stream fails, and at which frame. The meter hands the same bytes whether its input comes whole
//! or cut, and never panics.

use std::io::{self, Cursor};

use tungstenite::error::{CapacityError, Error, ProtocolError};
use tungstenite::protocol::frame::FrameSocket;
use tungstenite::protocol::{Message, Role, WebSocket, WebSocketConfig};

use crate::websocket::meter::{FrameMeter, FrameMeterOptions, Handed, MeterVerdict};

/// The largest message both readers read.
pub const MAXIMUM_MESSAGE_BYTES: u64 = 1 << 20;

// a socket of bytes to read, whose writes go nowhere
struct Input(Cursor<Vec<u8>>);

impl io::Read for Input {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut self.0, buffer)
    }
}

impl io::Write for Input {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// a frame as each reader bounds it: its opcode, whether it is final, and its payload's length
type Bounds = (u8, bool, u64);

// what the meter made of its input: what it handed, each frame it read whole, and its verdict
#[derive(Debug, PartialEq, Eq)]
struct Metered {
    handed: Vec<u8>,
    frames: Vec<Bounds>,
    verdict: Option<MeterVerdict>,
}

// the meter of a server, or of a client, fed `pieces` in turn, each a read
fn metered(pieces: &[&[u8]], is_server: bool) -> Metered {
    let mut options = FrameMeterOptions::new(is_server);

    options.maximum_message_bytes = Some(MAXIMUM_MESSAGE_BYTES);
    options.maximum_message_frames = Some(u64::MAX);

    let mut meter = FrameMeter::new(&options);
    let mut metered = Metered {
        handed: Vec::new(),
        frames: Vec::new(),
        verdict: None,
    };
    let mut frame: Option<Bounds> = None;

    for piece in pieces {
        let mut at = 0_usize;

        loop {
            let input = piece.get(at..).unwrap_or_default();

            if input.is_empty() && !meter.is_piece_due() {
                break;
            }

            let step = meter.step(input);
            let taken = input.get(..step.taken).unwrap_or_default();

            if frame.is_none()
                && let Some(first) = taken.first()
            {
                frame = Some((first & 0x0F, first & 0x80 != 0, 0));
            }

            match step.handed {
                Handed::Held => {}
                Handed::AsCame => {
                    metered.handed.extend_from_slice(taken);

                    if let Some((_, _, payload)) = frame.as_mut() {
                        *payload = payload.saturating_add(u64::try_from(taken.len()).unwrap_or(0));
                    }
                }
                Handed::Head(head) => metered.handed.extend_from_slice(head.as_bytes()),
                Handed::Verdict(verdict) => {
                    metered.verdict = Some(verdict);

                    return metered;
                }
            }

            if meter.is_between_frames()
                && let Some(whole) = frame.take()
            {
                metered.frames.push(whole);
            }

            at = at.saturating_add(step.taken);
        }
    }

    metered
}

// the frames tungstenite bounds in `bytes`, unjudged, to the first it cannot read
fn frames_of(bytes: &[u8]) -> Vec<Bounds> {
    let mut socket = FrameSocket::new(Input(Cursor::new(bytes.to_vec())));
    let mut frames = Vec::new();

    while let Ok(Some(frame)) = socket.read(usize::try_from(MAXIMUM_MESSAGE_BYTES).ok()) {
        let header = frame.header();

        frames.push((
            u8::from(header.opcode),
            header.is_final,
            u64::try_from(frame.payload().len()).unwrap_or(u64::MAX),
        ));
    }

    frames
}

// how tungstenite's reading ended: at a frame's head, which the meter judges too; or otherwise
#[derive(Debug, PartialEq, Eq)]
enum Ending {
    Head(String),
    Otherwise,
}

// what tungstenite reads of `bytes` in `role`: each message and control frame, then its ending
fn read_of(bytes: &[u8], role: Role) -> (Vec<Message>, Ending) {
    let config = WebSocketConfig::default()
        .max_message_size(usize::try_from(MAXIMUM_MESSAGE_BYTES).ok())
        .max_frame_size(usize::try_from(MAXIMUM_MESSAGE_BYTES).ok());
    let mut socket =
        WebSocket::from_raw_socket(Input(Cursor::new(bytes.to_vec())), role, Some(config));
    let mut read = Vec::new();

    loop {
        match socket.read() {
            Ok(message) => read.push(message),
            Err(
                error @ (Error::Capacity(CapacityError::MessageTooLong { .. })
                | Error::Protocol(
                    ProtocolError::NonZeroReservedBits
                    | ProtocolError::UnmaskedFrameFromClient
                    | ProtocolError::MaskedFrameFromServer
                    | ProtocolError::FragmentedControlFrame
                    | ProtocolError::ControlFrameTooBig
                    | ProtocolError::UnknownControlFrameType(_)
                    | ProtocolError::UnknownDataFrameType(_)
                    | ProtocolError::UnexpectedContinueFrame
                    | ProtocolError::ExpectedFragment(_),
                )),
            ) => return (read, Ending::Head(error.to_string())),
            Err(_) => return (read, Ending::Otherwise),
        }
    }
}

/// What `input`, the byte that picks the side and the cut, then a peer's frames, breaks of the
/// target's properties: none where it holds them.
#[must_use]
pub fn broken(input: &[u8]) -> Option<String> {
    let (first, input) = input.split_first()?;
    let is_server = first & 1 == 0;
    let role = if is_server {
        Role::Server
    } else {
        Role::Client
    };
    let whole = metered(&[input], is_server);
    let at = usize::from(first >> 1)
        .checked_rem(input.len().saturating_add(1))
        .unwrap_or(0);
    let pieces: [&[u8]; 2] = input.split_at(at.min(input.len())).into();
    let cut = metered(&pieces, is_server);

    if whole != cut {
        return Some(format!(
            "metered whole as {whole:?}, cut at {at} as {cut:?}"
        ));
    }

    // * the bounds of each frame the meter read whole, as tungstenite bounds them
    let frames = frames_of(input);

    if frames.get(..whole.frames.len()) != Some(whole.frames.as_slice()) {
        return Some(format!(
            "the meter bounds frames as {:?}, tungstenite as {frames:?}",
            whole.frames
        ));
    }

    // * the end of each message, and where the stream fails
    let (original, ending) = read_of(input, role);
    let (handed, _) = read_of(&whole.handed, role);
    // ! a control frame whose length takes a longer form than its 7 bits fails the meter, as on
    // every side, where tungstenite takes one of 125 bytes or fewer and reads on past it
    let is_long_control = whole.verdict
        == Some(MeterVerdict::Protocol(
            "a control frame longer than 125 bytes".to_owned(),
        ));
    let is_read_alike = if is_long_control {
        original.get(..handed.len()) == Some(handed.as_slice())
    } else {
        original == handed
    };

    if !is_read_alike {
        return Some(format!(
            "tungstenite reads {original:?} of the input, {handed:?} of what the meter handed"
        ));
    }

    if let Ending::Head(error) = ending
        && whole.verdict.is_none()
    {
        return Some(format!(
            "tungstenite fails at a frame's head, {error}, which the meter let pass"
        ));
    }

    None
}
