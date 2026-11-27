// ── WebSocket frame ──────────────────────────────────────────────────────────
// The numbers of RFC 6455 a WebSocket's frame and close carry, named as the RFC names them
// (decision 0057): its readers take them from here, and no module holds a number of its own.

// opcodes (RFC 6455 §5.2)

/** RFC 6455 §5.2: the opcode of a continuation frame. */
export const CONTINUATION = 0x0;

/** RFC 6455 §5.2: the opcode of a text frame. */
export const TEXT = 0x1;

/** RFC 6455 §5.2: the opcode of a binary frame. */
export const BINARY = 0x2;

/** RFC 6455 §5.2: the opcode of a connection close. */
export const CLOSE = 0x8;

/** RFC 6455 §5.2: the opcode of a ping. */
export const PING = 0x9;

/** RFC 6455 §5.2: the opcode of a pong. */
export const PONG = 0xa;

// the head's first byte (RFC 6455 §5.2, §5.5)

/** RFC 6455 §5.2: FIN, the top bit of a frame's first byte, set on a message's final fragment. */
export const FIN_BIT = 0x80;

/** RFC 6455 §5.2: RSV1, RSV2 and RSV3, the three bits below FIN, zero with no extension. */
export const RESERVED_MASK = 0x70;

/** RFC 6455 §5.2: the opcode, the low four bits of a frame's first byte. */
export const OPCODE_MASK = 0x0f;

/** RFC 6455 §5.5: the opcode's bit a control frame sets, and a data frame clears. */
export const CONTROL_BIT = 0x08;

// the head's second byte and its length (RFC 6455 §5.2, §5.5)

/** RFC 6455 §5.2: Mask, the top bit of a frame's second byte, set when a masking key follows. */
export const MASK_BIT = 0x80;

/** RFC 6455 §5.2: Payload len, the low seven bits of a frame's second byte. */
export const PAYLOAD_LENGTH_MASK = 0x7f;

/** RFC 6455 §5.2: the Payload len that announces a 16-bit length after it. */
export const EXTENDED_LENGTH_16 = 126;

/** RFC 6455 §5.2: the Payload len that announces a 64-bit length after it. */
export const EXTENDED_LENGTH_64 = 127;

/** RFC 6455 §5.2: the top bit of a 64-bit length's first byte, which must be 0. */
export const LENGTH_TOP_BIT = 0x80;

/** RFC 6455 §5.5: the longest payload of a control frame, in bytes. */
export const LONGEST_CONTROL_PAYLOAD = 125;

/** RFC 6455 §5.2: the bytes of a masking key. */
export const MASKING_KEY_BYTES = 4;

/** RFC 6455 §5.2: the longest head of a frame, in bytes: two, a 64-bit length's 8, a masking key's 4. */
export const LONGEST_HEAD_BYTES = 14;

// close codes (RFC 6455 §7.4.1; IANA's WebSocket Close Code Number Registry)

/** RFC 6455 §7.4.1: a normal closure, the purpose of the connection fulfilled. */
export const NORMAL_CLOSURE = 1000;

/** RFC 6455 §7.4.1: an endpoint going away, a server going down or a page left. */
export const GOING_AWAY = 1001;

/** RFC 6455 §7.4.1: an endpoint terminating the connection for a protocol error. */
export const PROTOCOL_ERROR = 1002;

/** RFC 6455 §7.4.1: a connection closed abnormally, with no close frame; never sent in one. */
export const ABNORMAL_CLOSURE = 1006;

/** RFC 6455 §7.4.1: an endpoint terminating the connection for a message that violates its policy. */
export const POLICY_VIOLATION = 1008;

/** RFC 6455 §7.4.1: an endpoint terminating the connection for a message too big to process. */
export const MESSAGE_TOO_BIG = 1009;

/** IANA's WebSocket Close Code Number Registry, 1013: Try Again Later, a server overloaded. */
export const TRY_AGAIN_LATER = 1013;
