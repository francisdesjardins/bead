//! A WebSocket frame's numbers (RFC 6455 §5.2, §5.5, §7.4.1, and IANA's WebSocket Close Code
//! Number Registry), each named after its standard (decision 0057): what the frame meter, MQTT over
//! a WebSocket, a connection's close and a broker parcel's CLOSE read. Each is compiled where the
//! code that reads it is: a parcel's codes everywhere, the rest under the features of their readers.

// ── Its opcodes ──────────────────────────────────────────────────────────────────────────────

/// RFC 6455 §5.2: the opcode of a continuation frame.
#[cfg(feature = "websocket")]
pub(crate) const CONTINUATION: u8 = 0x0;

/// RFC 6455 §5.2: the opcode of a text frame.
#[cfg(feature = "websocket")]
pub(crate) const TEXT: u8 = 0x1;

/// RFC 6455 §5.2: the opcode of a binary frame.
#[cfg(feature = "websocket")]
pub(crate) const BINARY: u8 = 0x2;

/// RFC 6455 §5.2: the opcode of a close, the first control frame's.
#[cfg(feature = "websocket")]
pub(crate) const CLOSE: u8 = 0x8;

/// RFC 6455 §5.2: the opcode of a ping.
#[cfg(feature = "websocket")]
pub(crate) const PING: u8 = 0x9;

/// RFC 6455 §5.2: the opcode of a pong, the last control frame's.
#[cfg(feature = "websocket")]
pub(crate) const PONG: u8 = 0xA;

// ── Its head ─────────────────────────────────────────────────────────────────────────────────

/// RFC 6455 §5.2: the FIN bit, a frame's first byte's top bit, set on a message's last frame.
#[cfg(feature = "websocket")]
pub(crate) const FIN_BIT: u8 = 0x80;

/// RFC 6455 §5.2: RSV1, RSV2 and RSV3, a frame's first byte's three bits after FIN.
#[cfg(feature = "websocket")]
pub(crate) const RESERVED_MASK: u8 = 0x70;

/// RFC 6455 §5.2: the opcode, the low four bits of a frame's first byte.
#[cfg(any(feature = "websocket", feature = "mqtt"))]
pub(crate) const OPCODE_MASK: u8 = 0x0F;

/// RFC 6455 §5.5: the opcode's bit that a control frame's opcode sets.
#[cfg(feature = "websocket")]
pub(crate) const CONTROL_BIT: u8 = 0x08;

/// RFC 6455 §5.2: the Mask bit, a frame's second byte's top bit, set on a masked payload.
#[cfg(feature = "websocket")]
pub(crate) const MASK_BIT: u8 = 0x80;

/// RFC 6455 §5.2: the payload length, the low seven bits of a frame's second byte.
#[cfg(feature = "websocket")]
pub(crate) const PAYLOAD_LENGTH_MASK: u8 = 0x7F;

/// RFC 6455 §5.2: the payload length that a 16-bit length follows.
#[cfg(feature = "websocket")]
pub(crate) const EXTENDED_LENGTH_16: u8 = 126;

/// RFC 6455 §5.2: the payload length that a 64-bit length follows.
#[cfg(feature = "websocket")]
pub(crate) const EXTENDED_LENGTH_64: u8 = 127;

/// RFC 6455 §5.2: a 64-bit length's most significant bit, which is 0, the top bit of its first
/// byte.
#[cfg(feature = "websocket")]
pub(crate) const LENGTH_TOP_BIT: u8 = 0x80;

/// RFC 6455 §5.5: the longest payload a control frame holds.
#[cfg(any(feature = "websocket", feature = "mqtt"))]
pub(crate) const LONGEST_CONTROL_PAYLOAD: u64 = 125;

/// RFC 6455 §5.2: the masking key's bytes.
#[cfg(feature = "websocket")]
pub(crate) const MASKING_KEY_BYTES: usize = 4;

/// RFC 6455 §5.2: a frame's longest head, 2 bytes, 8 of a 64-bit length and 4 of a masking key.
#[cfg(feature = "websocket")]
pub(crate) const LONGEST_HEAD_BYTES: usize = 14;

// ── Its close codes ──────────────────────────────────────────────────────────────────────────

/// RFC 6455 §7.4.1: a close's status, its end by its own word, the purpose it was opened for
/// fulfilled.
pub(crate) const NORMAL_CLOSURE: u16 = 1000;

/// RFC 6455 §7.4.1: a close's status, its end going away, a server's stop among them.
pub(crate) const GOING_AWAY: u16 = 1001;

/// RFC 6455 §7.4.1: a close's status, its end failing the connection for a protocol error.
pub(crate) const PROTOCOL_ERROR: u16 = 1002;

/// RFC 6455 §7.4.1: what a close with no status reads as; never sent.
#[cfg(feature = "websocket")]
pub(crate) const NO_STATUS_RECEIVED: u16 = 1005;

/// RFC 6455 §7.4.1: what a connection closed with no close frame reads as; never sent.
#[cfg(feature = "websocket")]
pub(crate) const ABNORMAL_CLOSURE: u16 = 1006;

/// RFC 6455 §7.4.1: a close's status, a message's data inconsistent with its type, a text's
/// UTF-8 broken among them.
#[cfg(feature = "websocket")]
pub(crate) const INVALID_FRAME_PAYLOAD_DATA: u16 = 1007;

/// RFC 6455 §7.4.1: a close's status, a message that breaks its end's policy.
#[cfg(feature = "websocket")]
pub(crate) const POLICY_VIOLATION: u16 = 1008;

/// RFC 6455 §7.4.1: a close's status, a message too big for its end to process.
pub(crate) const MESSAGE_TOO_BIG: u16 = 1009;

/// IANA's WebSocket Close Code Number Registry: a close's status, its end overloaded, the peer to
/// try again later.
#[cfg(feature = "websocket")]
pub(crate) const TRY_AGAIN_LATER: u16 = 1013;
