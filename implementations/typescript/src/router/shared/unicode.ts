// ── Unicode ──────────────────────────────────────────────────────────────────
// The numbers of UTF-8 (RFC 3629) and UTF-16 (RFC 2781) a scan of a text reads, and JSON's byte
// order mark (RFC 8259 §8.1), named as their standards name them (decision 0057).

// UTF-8 (RFC 3629 §3, §4)

/** RFC 3629 §3: the two top bits of a byte, which tell a continuation byte, `10xxxxxx`. */
export const CONTINUATION_MASK = 0xc0;

/** RFC 3629 §3: the bits a continuation byte holds under its mask, `10`. */
export const CONTINUATION_PREFIX = 0x80;

/** RFC 3629 §4: the first byte that leads a character of two bytes, `UTF8-2`. */
export const FIRST_TWO_BYTE_LEAD = 0xc2;

/** RFC 3629 §4: the last byte that leads a character of two bytes. */
export const LAST_TWO_BYTE_LEAD = 0xdf;

/** RFC 3629 §4: the first byte that leads a character of three bytes, `UTF8-3`. */
export const FIRST_THREE_BYTE_LEAD = 0xe0;

/** RFC 3629 §4: the last byte that leads a character of three bytes. */
export const LAST_THREE_BYTE_LEAD = 0xef;

/** RFC 3629 §4: the first byte that leads a character of four bytes, `UTF8-4`. */
export const FIRST_FOUR_BYTE_LEAD = 0xf0;

/** RFC 3629 §4: the last byte that leads a character of four bytes, U+10FFFF's. */
export const LAST_FOUR_BYTE_LEAD = 0xf4;

/** RFC 3629 §3: the first code point UTF-8 writes in two bytes, U+0080. */
export const FIRST_TWO_BYTE_CODE_POINT = 0x80;

/** RFC 3629 §3: the first code point UTF-8 writes in three bytes, U+0800. */
export const FIRST_THREE_BYTE_CODE_POINT = 0x800;

// UTF-16 (RFC 2781 §2.2)

/** RFC 2781 §2.2: the first high surrogate, W1's least. */
export const FIRST_HIGH_SURROGATE = 0xd800;

/** RFC 2781 §2.2: the last high surrogate, W1's greatest. */
export const LAST_HIGH_SURROGATE = 0xdbff;

/** RFC 2781 §2.2: the first low surrogate, W2's least. */
export const FIRST_LOW_SURROGATE = 0xdc00;

/** RFC 2781 §2.2: the last low surrogate, W2's greatest, and the surrogates' end. */
export const LAST_LOW_SURROGATE = 0xdfff;

/** RFC 2781 §2.2: the top six bits of a unit, which tell a high surrogate from a low one. */
export const SURROGATE_MASK = 0xfc00;

// JSON (RFC 8259 §8.1)

/** RFC 8259 §8.1: the byte order mark, U+FEFF, as the one UTF-16 unit a text reads it as. */
export const BYTE_ORDER_MARK = 0xfeff;
