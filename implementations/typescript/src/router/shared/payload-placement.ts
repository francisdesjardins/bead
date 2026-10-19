// ── Payload placement ─────────────────────────────────────────────────────────

// dependencies

import { EnvelopeKind, SESSION_TOKEN_BYTES } from './constants';
import { headerBytesOf, MAXIMUM_HEADER_BYTES, unboundedHeaderBytesOf } from './header';
import {
  chunkPayloadBytes,
  createOutgoingTransfer,
  type IChunk,
  type IOutgoingTransfer,
} from './transfer';
import type {
  CallId,
  Envelope,
  IProcedure,
  IProtocolFailure,
  IRequestHeader,
  IResultHeader,
  IRouterFailures,
  IRouterLimits,
  OutgoingEnvelope,
} from './types';

// interfaces

/**
 * How a payload goes, by the router's limits: whole, as a transfer, or refused PAYLOAD_TOO_LARGE,
 * within a procedure's own limit.
 */
export interface IPayloadPlacement {
  /** A chunk's envelope, on `callId`. */
  chunkEnvelopeOf: (callId: CallId, chunk: IChunk) => OutgoingEnvelope;
  /** The bytes of a payload a chunk carries. */
  readonly payloadBytesPerChunk: number;
  /** The bytes a payload of `procedure` holds at most: its own limit, within the router's. */
  payloadLimitOf: (procedure: Pick<IProcedure, 'maximumPayloadBytes'> | undefined) => number;
  /** The failure of a payload of `length` bytes, past `limit`. */
  tooLargeOf: (length: number, limit: number) => IProtocolFailure;
  /**
   * How a payload goes after `header`: whole — `undefined` — or as a transfer; or not at all, and
   * the failure says why.
   */
  transferOf: (
    payload: Uint8Array,
    options: { header: IRequestHeader | IResultHeader; maximumPayloadBytes: number }
  ) => IOutgoingTransfer | IProtocolFailure | undefined;
  /** The largest envelope a payload goes whole in. */
  readonly wholeBytes: number;
}

// types

/** A chunk as it is read: the envelope of one piece of a transfer. */
export type ChunkEnvelope = Extract<Envelope, { kind: typeof EnvelopeKind.CHUNK }>;

// constants

// a chunk's header: its prefix, then its offset
const CHUNK_HEADER_BYTES = headerBytesOf({
  callId: 1,
  isLast: true,
  kind: EnvelopeKind.CHUNK,
  offset: 0,
});

// what an answer's announcement adds to its header: a credential's head, then a session's token
const ANNOUNCEMENT_BYTES = 4 + SESSION_TOKEN_BYTES;

// helpers

/** Whether `value` limits a procedure's payloads: none, or a whole number above 0. */
export const isPayloadLimit = (value: unknown): boolean => {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1);
};

// definition

/**
 * How a payload goes, by `limits`: whole in one envelope, as a transfer of chunks, or not at all,
 * PAYLOAD_TOO_LARGE as `failures` has it, a procedure's own limit held within the router's.
 */
export const createPayloadPlacement = (
  failures: Pick<IRouterFailures, 'payloadTooLarge'>,
  limits: IRouterLimits
): IPayloadPlacement => {
  // the largest envelope a payload goes whole in, and the bytes a chunk carries
  const wholeBytes = Math.min(limits.chunkBytes, limits.maximumEnvelopeBytes);
  const payloadBytesPerChunk = chunkPayloadBytes(limits, CHUNK_HEADER_BYTES);

  // the bytes a payload of `procedure` holds at most: its own limit, within the router's
  const payloadLimitOf = (
    procedure: Pick<IProcedure, 'maximumPayloadBytes'> | undefined
  ): number => {
    return Math.min(procedure?.maximumPayloadBytes ?? Infinity, limits.maximumPayloadBytes);
  };

  // the failure of a payload of `length` bytes, past `limit`
  const tooLargeOf = (length: number, limit: number): IProtocolFailure => {
    return {
      ...failures.payloadTooLarge,
      detail: `a payload is ${String(limit)} bytes at most, not ${String(length)}`,
    };
  };

  // how a payload goes after `header`: whole — `undefined` — or as a transfer, a result's header
  // counted with the announcement it may carry; or not at all, and the failure says why
  const transferOf = (
    payload: Uint8Array,
    {
      header,
      maximumPayloadBytes,
    }: { header: IRequestHeader | IResultHeader; maximumPayloadBytes: number }
  ): IOutgoingTransfer | IProtocolFailure | undefined => {
    const announcementBytes = header.kind === EnvelopeKind.RESULT ? ANNOUNCEMENT_BYTES : 0;

    if (payload.length > maximumPayloadBytes) {
      return tooLargeOf(payload.length, maximumPayloadBytes);
    }

    if (headerBytesOf(header) + announcementBytes + payload.length <= wholeBytes) {
      return undefined;
    }

    if (limits.maximumTransfers === 0) {
      return {
        ...failures.payloadTooLarge,
        detail: `a payload of ${String(payload.length)} bytes goes as a transfer, which this side sends none of`,
      };
    }

    const openingHeaderBytes = unboundedHeaderBytesOf({ ...header, total: payload.length });
    const openingBytes = wholeBytes - openingHeaderBytes - announcementBytes;

    // ! a header past 1,020 bytes no reader takes, and an opening without a byte of its payload
    // none places: a payload that needs such a transfer goes whole or not at all (spec 12.3)
    if (openingHeaderBytes > MAXIMUM_HEADER_BYTES || openingBytes < 1) {
      return {
        ...failures.payloadTooLarge,
        detail:
          openingHeaderBytes > MAXIMUM_HEADER_BYTES
            ? `a payload of ${String(payload.length)} bytes goes as a transfer, whose opening's header of ${String(openingHeaderBytes)} bytes passes ${String(MAXIMUM_HEADER_BYTES)}`
            : `a payload of ${String(payload.length)} bytes goes as a transfer, whose opening's header of ${String(openingHeaderBytes)} bytes leaves it no byte within ${String(wholeBytes)}`,
      };
    }

    return createOutgoingTransfer(payload, { openingBytes, payloadBytesPerChunk });
  };

  // a chunk's envelope, on `callId`
  const chunkEnvelopeOf = (callId: CallId, { bytes, isLast, offset }: IChunk): OutgoingEnvelope => {
    return {
      header: { callId, isLast, kind: EnvelopeKind.CHUNK, offset },
      kind: EnvelopeKind.CHUNK,
      payload: bytes,
    };
  };

  return {
    chunkEnvelopeOf,
    payloadBytesPerChunk,
    payloadLimitOf,
    tooLargeOf,
    transferOf,
    wholeBytes,
  };
};
