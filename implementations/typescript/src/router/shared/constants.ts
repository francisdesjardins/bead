// dependencies

import type { IRouterFailures, IRouterLimits, RouterSide } from './types';

// constants

export const DEBUG_EVENT = 'debug';
export const DEPRECATED_EVENT = 'deprecated';
export const DROPPED_EVENT = 'dropped';
export const TRIGGER_EVENT = 'trigger';

/**
 * How an envelope's header is laid out, in its first byte. Only `FIRST` is read; 0xa2 to 0xaf are
 * the layouts to come, which a request is refused with `LAYOUT_UNSUPPORTED`; any other first byte
 * is not an envelope.
 */
export const EnvelopeLayout = Object.freeze({
  FIRST: 0xa1,
} as const);

/**
 * What an envelope is, in its second byte. CHUNK carries the next bytes of a payload a request or a
 * result opened as a transfer, at its offset; CREDIT lets the other end send a transfer's bytes up
 * to its end, and carries nothing else. CANCEL is a requester ending its call, 8 bytes and never
 * answered. 0x17 to 0x7f are the kinds to come, refused as `KIND_UNSUPPORTED`; 0x80 to 0xff are
 * advisory and ignored, and 0x00 to 0x0f are never a kind.
 */
export const EnvelopeKind = Object.freeze({
  REQUEST: 0x10,
  RESULT: 0x11,
  FAILURE: 0x12,
  NOTIFICATION: 0x13,
  CHUNK: 0x14,
  CREDIT: 0x15,
  CANCEL: 0x16,
} as const);

/**
 * The flags of an envelope's header, in its third byte. Those of the low nibble add a block, laid
 * out in the order of their bits: SESSION, the 16 bytes of a session token, on a request, a result
 * or a failure; DESTINATION, 4 bytes, on a request alone; TRANSFER, 8 bytes, the whole payload's
 * length, on a request or a result that opens a transfer; 0x08 is kept for a block to come. Those of
 * the high nibble add none: SUBSCRIPTION, on a request alone, says the request opens a subscription,
 * which a server subscribes no other request to; PACED, on that request, asks for its
 * notifications as credited, and on a credit says it counts notifications; MORE, on a chunk alone,
 * says more chunks follow it; 0x80 is kept. A flag its kind does not take makes the envelope
 * malformed.
 */
export const EnvelopeFlag = Object.freeze({
  SESSION: 0x01,
  DESTINATION: 0x02,
  TRANSFER: 0x04,
  SUBSCRIPTION: 0x10,
  PACED: 0x20,
  MORE: 0x40,
} as const);

/** Whose code a failure's is: the protocol's, or the procedure's own. */
export const FailureScope = Object.freeze({
  PROTOCOL: 0,
  APPLICATION: 1,
} as const);

/**
 * The protocol's own failures, in blocks of 16 by how far a request went: the envelope (1 to 15),
 * its route (16 to 31), its admission (32 to 47), its payload (48 to 63), then its procedure (64
 * to 79). A code read that none of these names stays a number.
 */
export const ProtocolCode = Object.freeze({
  ENVELOPE_MALFORMED: 1,
  LAYOUT_UNSUPPORTED: 2,
  KIND_UNSUPPORTED: 3,
  ENVELOPE_TOO_LARGE: 4,
  DESTINATION_UNKNOWN: 16,
  DESTINATION_UNREACHABLE: 17,
  SERVICE_UNKNOWN: 18,
  PROCEDURE_UNKNOWN: 19,
  CALL_UNKNOWN: 20,
  SUBSCRIPTION_UNKNOWN: 21,
  SUBSCRIPTION_UNSUPPORTED: 22,
  SESSION_REQUIRED: 32,
  ACCESS_DENIED: 33,
  PAYLOAD_TOO_LARGE: 34,
  CAPACITY_EXCEEDED: 35,
  CHUNK_INVALID: 48,
  CREDIT_EXCEEDED: 49,
  PAYLOAD_UNDECODABLE: 50,
  TRANSFER_STALLED: 51,
  PROCEDURE_FAILED: 64,
  DESTINATION_LOST: 65,
} as const);

/** Each failure a router raises, by the key its table has it under. */
export const FAILURE_KEYS = Object.freeze({
  envelopeMalformed: ProtocolCode.ENVELOPE_MALFORMED,
  layoutUnsupported: ProtocolCode.LAYOUT_UNSUPPORTED,
  kindUnsupported: ProtocolCode.KIND_UNSUPPORTED,
  envelopeTooLarge: ProtocolCode.ENVELOPE_TOO_LARGE,
  destinationUnknown: ProtocolCode.DESTINATION_UNKNOWN,
  destinationUnreachable: ProtocolCode.DESTINATION_UNREACHABLE,
  serviceUnknown: ProtocolCode.SERVICE_UNKNOWN,
  procedureUnknown: ProtocolCode.PROCEDURE_UNKNOWN,
  callUnknown: ProtocolCode.CALL_UNKNOWN,
  subscriptionUnknown: ProtocolCode.SUBSCRIPTION_UNKNOWN,
  subscriptionUnsupported: ProtocolCode.SUBSCRIPTION_UNSUPPORTED,
  sessionRequired: ProtocolCode.SESSION_REQUIRED,
  accessDenied: ProtocolCode.ACCESS_DENIED,
  payloadTooLarge: ProtocolCode.PAYLOAD_TOO_LARGE,
  capacityExceeded: ProtocolCode.CAPACITY_EXCEEDED,
  chunkInvalid: ProtocolCode.CHUNK_INVALID,
  creditExceeded: ProtocolCode.CREDIT_EXCEEDED,
  payloadUndecodable: ProtocolCode.PAYLOAD_UNDECODABLE,
  transferStalled: ProtocolCode.TRANSFER_STALLED,
  procedureFailed: ProtocolCode.PROCEDURE_FAILED,
  destinationLost: ProtocolCode.DESTINATION_LOST,
} as const);

/**
 * The call ids each side draws: odd from a client, even from a server, as HTTP/2 numbers its
 * streams, so the two never draw the same one.
 */
export const CALL_ID_RANGES = Object.freeze({
  client: Object.freeze({ first: 1, last: 0xffffffff, step: 2 }),
  server: Object.freeze({ first: 2, last: 0xfffffffe, step: 2 }),
} as const);

/** A session token's length, in bytes: 128 bits drawn from `crypto`. */
export const SESSION_TOKEN_BYTES = 16;

/** The longest a timer waits, in milliseconds: longer, it would fire at once. */
export const TIMEOUT_MAX = 2 ** 31 - 1;

/** How long a call id stays reserved when its call gave no timeout a timer can hold. */
export const RESERVATION_MILLISECONDS = 5_000;

/**
 * How much a router reads, writes and holds, when its options say nothing: a failure's detail, a
 * whole envelope, a whole payload, a chunk's envelope, the window ahead of what arrived, and the
 * bytes every transfer received holds together, in bytes; the transfers a connection holds at once,
 * and the runs of bytes apart one of them holds; how long a transfer waits on its peer, in
 * milliseconds.
 */
export const LIMIT_DEFAULTS: IRouterLimits = Object.freeze({
  bufferedBytesBudget: 268_435_456,
  chunkBytes: 1_048_576,
  maximumChunkRuns: 1_024,
  maximumDetailBytes: 1_024,
  maximumEnvelopeBytes: 16_778_240,
  maximumPayloadBytes: 16_777_216,
  maximumTransfers: 4,
  transferInactivityTimeout: 30_000,
  windowBytes: 4_194_304,
});

// definition

/**
 * The failures a router of `side` raises, one frozen entry per key of {@link FAILURE_KEYS}: each
 * says which side raised it, so the two tables differ by `side` alone.
 */
export const failureTableOf = (side: RouterSide): IRouterFailures => {
  const entries = Object.entries(FAILURE_KEYS).map(([key, code]) => {
    return [key, Object.freeze({ code, scope: FailureScope.PROTOCOL, side })];
  });

  // `Object.fromEntries` loses the keys, which the entries above hold one for one
  return Object.freeze({ ...Object.fromEntries(entries), side }) as IRouterFailures;
};

/** What a client's router raises and answers with. */
export const CLIENT_FAILURES = failureTableOf('client');

/** What a server's router raises and answers with. */
export const SERVER_FAILURES = failureTableOf('server');

// types

export type DEBUG_EVENT = typeof DEBUG_EVENT;
export type DEPRECATED_EVENT = typeof DEPRECATED_EVENT;
export type DROPPED_EVENT = typeof DROPPED_EVENT;
export type TRIGGER_EVENT = typeof TRIGGER_EVENT;

export type CALL_ID_RANGES = typeof CALL_ID_RANGES;
export type EnvelopeFlag = (typeof EnvelopeFlag)[keyof typeof EnvelopeFlag];
export type EnvelopeKind = (typeof EnvelopeKind)[keyof typeof EnvelopeKind];
export type EnvelopeLayout = (typeof EnvelopeLayout)[keyof typeof EnvelopeLayout];
export type FAILURE_KEYS = typeof FAILURE_KEYS;
export type FailureScope = (typeof FailureScope)[keyof typeof FailureScope];
export type ProtocolCode = (typeof ProtocolCode)[keyof typeof ProtocolCode];
