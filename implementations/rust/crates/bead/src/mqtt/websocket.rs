//! MQTT 5 over a WebSocket of subprotocol `mqtt` (MQTT 5.0 §6; spec 15.25), its frames read and
//! written by the link itself over the core's socket: its upgrade written and its 101 judged as
//! RFC 6455 §4.1 has a client judge one, no extension offered; each packet the client writes is one
//! binary message, one frame, never fragmented, masked (§5.3); what it reads is each binary frame's
//! payload as its bytes come, handed to the packet reader as a TCP read is, so a packet across
//! messages or fragments is read whole, several in one frame each read, and no message is bounded
//! but by the packets it holds (spec 15.29). A ping is answered with its pong, a close with a close,
//! and a text frame, or any frame RFC 6455 refuses, fails the link.

#[cfg(test)]
mod tests;

use std::io::{self, Cursor};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tungstenite::handshake::client::generate_key;
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::frame::coding::{Control, Data, OpCode};
use tungstenite::protocol::frame::{Frame, FrameHeader};

use crate::judgement::head::{MAXIMUM_HEAD_BYTES, MAXIMUM_HEAD_FIELDS};
use crate::mqtt::link::{Address, READ_BYTES};
use crate::net::dial::ClientSocket;

// the subprotocol MQTT names over a WebSocket (MQTT 5.0 §6)
const SUBPROTOCOL: &str = "mqtt";

// the payload a control frame holds at most (RFC 6455 §5.5)
const CONTROL_BYTES: u64 = 125;

// ── Its frames, read ─────────────────────────────────────────────────────────────────────────

/// What a server's frames give, read by an [`MqttFrameReader`]: a piece of a binary message, in its
/// order, or a control frame whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MqttFrameEvent {
    /// The next bytes of a binary message's payload, a frame's or a continuation's, as they came.
    Bytes(Bytes),
    /// A ping, its payload, which its pong carries back.
    Ping(Bytes),
    /// A pong.
    Pong,
    /// A close, its body not judged: the link ends either way.
    Close,
}

/// A frame a client refuses from its server, MQTT 5 over a WebSocket negotiating no extension
/// (RFC 6455 §5; MQTT 5.0 §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MqttFrameRefusal {
    /// A frame masked, which a server never sends (RFC 6455 §5.1).
    Masked,
    /// A frame with a reserved bit set, no extension being negotiated (§5.2).
    ReservedBits,
    /// A frame of a reserved opcode (§5.2): the opcode.
    ReservedOpcode(u8),
    /// A 64-bit payload length whose most significant bit is set (§5.2).
    LengthPastItsBound,
    /// A control frame not final (§5.5).
    FragmentedControl,
    /// A control frame of more than 125 bytes (§5.5).
    LongControl,
    /// A continuation outside a fragmented message (§5.4).
    ContinuationOutsideAMessage,
    /// A text or binary frame inside a fragmented message (§5.4).
    DataInsideAMessage,
    /// A text frame, which MQTT over a WebSocket never sends ([MQTT-6.0.0-1]).
    Text,
}

impl core::fmt::Display for MqttFrameRefusal {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Masked => formatter.write_str("a masked frame, which a server never sends"),
            Self::ReservedBits => {
                formatter.write_str("a frame with a reserved bit set, no extension negotiated")
            }
            Self::ReservedOpcode(opcode) => {
                write!(formatter, "a frame of the reserved opcode {opcode:#x}")
            }
            Self::LengthPastItsBound => {
                formatter.write_str("a frame whose length sets its most significant bit")
            }
            Self::FragmentedControl => formatter.write_str("a control frame not final"),
            Self::LongControl => formatter.write_str("a control frame of more than 125 bytes"),
            Self::ContinuationOutsideAMessage => {
                formatter.write_str("a continuation frame outside a fragmented message")
            }
            Self::DataInsideAMessage => {
                formatter.write_str("a data frame inside a fragmented message")
            }
            Self::Text => {
                formatter.write_str("a text message, which MQTT over a WebSocket never sends")
            }
        }
    }
}

impl std::error::Error for MqttFrameRefusal {}

/// A reader of the frames an MQTT 5 WebSocket's server sends (RFC 6455 §5), with no I/O of its own.
///
/// Each read takes from the front of the bytes it is given what it can, and gives the next event,
/// or none while more bytes are wanted. A binary message's payload is given as its bytes come,
/// never held; a control frame's is held until whole, 125 bytes at most.
///
/// Once a read gives none, the bytes it was given hold less than a whole frame head, or a control
/// frame's head and less than its payload: it reserves nothing at a frame's head, and bounds no
/// message.
#[derive(Debug, Default)]
pub struct MqttFrameReader {
    // the payload bytes of the data frame under way still to come
    remaining: u64,
    // whether a fragmented message is open, its final frame not yet read
    is_in_message: bool,
}

impl MqttFrameReader {
    /// A reader at the start of a server's frames.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The next event of `bytes`, taken from its front; none while more bytes are wanted.
    ///
    /// # Errors
    ///
    /// A frame RFC 6455 refuses from a server, or a text frame, as [`MqttFrameRefusal`] names
    /// them; the link fails on the first.
    pub fn read(
        &mut self,
        bytes: &mut BytesMut,
    ) -> Result<Option<MqttFrameEvent>, MqttFrameRefusal> {
        loop {
            if self.remaining > 0 {
                if bytes.is_empty() {
                    return Ok(None);
                }

                let taken = usize::try_from(self.remaining)
                    .map_or(bytes.len(), |left| left.min(bytes.len()));

                self.remaining = self
                    .remaining
                    .saturating_sub(u64::try_from(taken).unwrap_or(u64::MAX));

                return Ok(Some(MqttFrameEvent::Bytes(front_of(bytes, taken).freeze())));
            }

            let mut cursor = Cursor::new(bytes.as_ref());
            let (head, length) = match FrameHeader::parse(&mut cursor) {
                Ok(Some(parsed)) => parsed,
                Ok(None) => return Ok(None),
                // * the one refusal tungstenite's parse gives, a reserved opcode
                Err(_) => {
                    let opcode = bytes.first().map_or(0, |first| first & 0x0F);

                    return Err(MqttFrameRefusal::ReservedOpcode(opcode));
                }
            };
            let head_bytes = usize::try_from(cursor.position()).unwrap_or(usize::MAX);

            judge_head(&head, length)?;

            match head.opcode {
                OpCode::Control(control) => {
                    // ! held in `bytes` until its payload is whole, 125 bytes at most, judged first
                    let payload = usize::try_from(length).unwrap_or(usize::MAX);

                    if bytes.len() < head_bytes.saturating_add(payload) {
                        return Ok(None);
                    }

                    bytes.advance(head_bytes);

                    let payload = front_of(bytes, payload).freeze();

                    return match control {
                        Control::Ping => Ok(Some(MqttFrameEvent::Ping(payload))),
                        Control::Pong => Ok(Some(MqttFrameEvent::Pong)),
                        Control::Close => Ok(Some(MqttFrameEvent::Close)),
                        Control::Reserved(opcode) => Err(MqttFrameRefusal::ReservedOpcode(opcode)),
                    };
                }
                OpCode::Data(data) => {
                    match (data, self.is_in_message) {
                        (Data::Text, _) => return Err(MqttFrameRefusal::Text),
                        (Data::Reserved(opcode), _) => {
                            return Err(MqttFrameRefusal::ReservedOpcode(opcode));
                        }
                        (Data::Continue, false) => {
                            return Err(MqttFrameRefusal::ContinuationOutsideAMessage);
                        }
                        (Data::Binary, true) => return Err(MqttFrameRefusal::DataInsideAMessage),
                        (Data::Continue, true) | (Data::Binary, false) => {}
                    }

                    bytes.advance(head_bytes);
                    self.remaining = length;
                    self.is_in_message = !head.is_final;
                }
            }
        }
    }
}

// what a server's frame head is refused for, beside the reserved opcode its parse refuses
fn judge_head(head: &FrameHeader, length: u64) -> Result<(), MqttFrameRefusal> {
    if head.mask.is_some() {
        return Err(MqttFrameRefusal::Masked);
    }

    if head.rsv1 || head.rsv2 || head.rsv3 {
        return Err(MqttFrameRefusal::ReservedBits);
    }

    if length > i64::MAX.unsigned_abs() {
        return Err(MqttFrameRefusal::LengthPastItsBound);
    }

    if matches!(head.opcode, OpCode::Control(_)) {
        if !head.is_final {
            return Err(MqttFrameRefusal::FragmentedControl);
        }

        if length > CONTROL_BYTES {
            return Err(MqttFrameRefusal::LongControl);
        }
    }

    Ok(())
}

// the first `taken` bytes of `bytes`, split from it without a copy
#[expect(
    clippy::disallowed_methods,
    reason = "every caller splits within what `bytes` holds: a payload's piece bounded by its \
              length, a control frame's payload once it is whole"
)]
fn front_of(bytes: &mut BytesMut, taken: usize) -> BytesMut {
    bytes.split_to(taken.min(bytes.len()))
}

// ── Its upgrade ──────────────────────────────────────────────────────────────────────────────

/// The WebSocket of subprotocol `mqtt` to `address`, upgraded over `socket`: its socket, and the
/// bytes its broker sent past its 101, its first frames'.
pub(crate) async fn open(
    (address, mut socket): (&Address, ClientSocket),
) -> io::Result<(ClientSocket, BytesMut)> {
    let key = generate_key();
    let request = request_of(address, &key)?;
    let accept = derive_accept_key(key.as_bytes());
    let mut buffer = BytesMut::with_capacity(READ_BYTES);

    socket.write_all(request.as_bytes()).await?;
    socket.flush().await?;

    loop {
        if let Some(length) = judged(&buffer, &accept)? {
            buffer.advance(length);

            return Ok((socket, buffer));
        }

        buffer.reserve(READ_BYTES);

        if socket.read_buf(&mut buffer).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "its broker ended its network connection before it answered its upgrade",
            ));
        }
    }
}

/// The upgrade asked of `address`, under `key` (RFC 6455 §4.1): its subprotocol `mqtt`, no
/// extension offered.
pub(crate) fn request_of(address: &Address, key: &str) -> io::Result<String> {
    // ! a target written as it came: a byte past visible ASCII would split the request
    if !address.path.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "its broker's URL holds a path that is no request target",
        ));
    }

    let host = if address.port == address.scheme.port() {
        address.host.clone()
    } else {
        format!("{}:{}", address.host, address.port)
    };

    Ok(format!(
        "GET {} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: {SUBPROTOCOL}\r\n\r\n",
        address.path
    ))
}

/// The answer's head in `bytes` judged as RFC 6455 §4.1 has a client judge one, `accept` the
/// `Sec-WebSocket-Accept` its key asks: the bytes it took once whole and accepted, none while more
/// are wanted, under the bounds of a head (spec 15.12).
pub(crate) fn judged(bytes: &[u8], accept: &str) -> io::Result<Option<usize>> {
    let mut fields = [httparse::EMPTY_HEADER; MAXIMUM_HEAD_FIELDS];
    let mut response = httparse::Response::new(&mut fields);

    match response.parse(bytes) {
        Ok(httparse::Status::Complete(length)) if length > MAXIMUM_HEAD_BYTES => {
            Err(refused(&format!("a head past {MAXIMUM_HEAD_BYTES} bytes")))
        }
        Ok(httparse::Status::Complete(length)) => {
            judge(&response, accept)?;

            Ok(Some(length))
        }
        // * a head still coming past its bounds can only end past them
        Ok(httparse::Status::Partial) if bytes.len() >= MAXIMUM_HEAD_BYTES => {
            Err(refused(&format!("a head past {MAXIMUM_HEAD_BYTES} bytes")))
        }
        Ok(httparse::Status::Partial) => Ok(None),
        Err(httparse::Error::TooManyHeaders) => Err(refused(&format!(
            "a head of more than {MAXIMUM_HEAD_FIELDS} fields"
        ))),
        Err(error) => Err(refused(&format!("no HTTP response, {error}"))),
    }
}

// what its broker's upgrade answered that fails it
fn refused(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("its broker's upgrade answered {what}"),
    )
}

// the values of `response`'s fields named `name`, trimmed
fn values_of<'response>(
    response: &'response httparse::Response<'_, '_>,
    name: &'response str,
) -> impl Iterator<Item = &'response [u8]> {
    response
        .headers
        .iter()
        .filter(move |field| field.name.eq_ignore_ascii_case(name))
        .map(|field| field.value.trim_ascii())
}

// whether `values` are one, and that one `is_value`
fn is_one<'value, I, F>(mut values: I, is_value: F) -> bool
where
    I: Iterator<Item = &'value [u8]>,
    F: Fn(&[u8]) -> bool,
{
    values.next().is_some_and(is_value) && values.next().is_none()
}

fn judge(response: &httparse::Response<'_, '_>, accept: &str) -> io::Result<()> {
    // ! no redirect followed: anything but a 101 fails the start
    if response.code != Some(101) {
        let code = response
            .code
            .map_or_else(String::new, |code| code.to_string());

        return Err(refused(&format!("{code}, not 101")));
    }

    if !is_one(values_of(response, "upgrade"), |value| {
        value.eq_ignore_ascii_case(b"websocket")
    }) {
        return Err(refused("no Upgrade of websocket"));
    }

    // * a list of tokens, its own among them (RFC 9110 §7.6.1)
    let is_upgrade = values_of(response, "connection").any(|value| {
        value
            .split(|byte| *byte == b',')
            .any(|token| token.trim_ascii().eq_ignore_ascii_case(b"upgrade"))
    });

    if !is_upgrade {
        return Err(refused("no Connection listing upgrade"));
    }

    if !is_one(values_of(response, "sec-websocket-accept"), |value| {
        value == accept.as_bytes()
    }) {
        return Err(refused("no Sec-WebSocket-Accept of its key"));
    }

    if !is_one(values_of(response, "sec-websocket-protocol"), |value| {
        value == SUBPROTOCOL.as_bytes()
    }) {
        return Err(refused(&format!("no subprotocol {SUBPROTOCOL}")));
    }

    if let Some(extension) = values_of(response, "sec-websocket-extensions").next() {
        return Err(refused(&format!(
            "the extension {}, none offered",
            String::from_utf8_lossy(extension)
        )));
    }

    Ok(())
}

// ── Its frames, written ──────────────────────────────────────────────────────────────────────

/// `payload` as one final frame of `opcode`, masked by a fresh key (RFC 6455 §5.3).
fn frame_of(opcode: OpCode, payload: Bytes) -> io::Result<Vec<u8>> {
    let mut mask = [0; 4];

    getrandom::fill(&mut mask).map_err(io::Error::other)?;

    let header = FrameHeader {
        is_final: true,
        rsv1: false,
        rsv2: false,
        rsv3: false,
        opcode,
        mask: Some(mask),
    };
    let length = u64::try_from(payload.len()).unwrap_or(u64::MAX);
    let mut written = Vec::with_capacity(header.len(length).saturating_add(payload.len()));

    Frame::from_payload(header, payload)
        .format(&mut written)
        .map_err(io::Error::other)?;

    Ok(written)
}

/// `packet` as one binary message, one frame.
pub(crate) fn binary_of(packet: Vec<u8>) -> io::Result<Vec<u8>> {
    frame_of(OpCode::Data(Data::Binary), Bytes::from(packet))
}

/// The pong of a ping's `payload`.
pub(crate) fn pong_of(payload: Bytes) -> io::Result<Vec<u8>> {
    frame_of(OpCode::Control(Control::Pong), payload)
}

/// A close of no body.
pub(crate) fn close_of() -> io::Result<Vec<u8>> {
    frame_of(OpCode::Control(Control::Close), Bytes::new())
}
