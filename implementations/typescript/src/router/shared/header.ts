// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { EnvelopeFlag, EnvelopeKind, EnvelopeLayout, SESSION_TOKEN_BYTES } from './constants';
import { FailureError } from './errors';
import { isSessionToken, toSessionToken, toSessionTokenBytes } from './identifiers';
import type {
  CallId,
  DestinationId,
  EnvelopeHeader,
  IEnvelopePrefix,
  IRouterFailures,
  SessionToken,
} from './types';

// interfaces

/** A header as it was read: the header, and where the payload starts. */
export interface IReadHeader {
  header: EnvelopeHeader;
  headerBytes: number;
}

// types

export type FIELD_MAXIMUMS = typeof FIELD_MAXIMUMS;

/** The failures reading a header raises. */
type ReadFailures = Pick<
  IRouterFailures,
  'envelopeMalformed' | 'kindUnsupported' | 'layoutUnsupported'
>;

// constants

/** The largest value each numbered field of a header holds; the smallest is 1. */
export const FIELD_MAXIMUMS = Object.freeze({
  callId: 0xffffffff,
  destinationId: 0xffffffff,
  procedureId: 0xffff,
  serviceId: 0xffff,
} as const);

// the prefix: layout, kind, flags, header words, then the call id at bytes 4 to 7
const PREFIX_BYTES = 8;

// the first byte of an envelope, from the one this layout is to the last one to come
const LAYOUTS = Object.freeze({ first: EnvelopeLayout.FIRST, last: 0xaf });

// below the first, never a kind; from the advisory one on, skipped; in between, the kinds this
// layout reads, and the others to come
const KINDS = Object.freeze({ first: EnvelopeKind.REQUEST, advisory: 0x80 });
const KINDS_READ: ReadonlySet<number> = new Set(Object.values(EnvelopeKind));

// each block's length, in the order of its bit: a session, a destination, a transfer's total
const BLOCK_BYTES: readonly (readonly [flag: number, bytes: number])[] = Object.freeze([
  [EnvelopeFlag.SESSION, SESSION_TOKEN_BYTES],
  [EnvelopeFlag.DESTINATION, 4],
  [EnvelopeFlag.TRANSFER, 8],
]);

// what follows the prefix before the blocks: a request's service and procedure, a chunk's offset,
// a credit's end
const KIND_PART_BYTES: Readonly<Record<number, number>> = Object.freeze({
  [EnvelopeKind.REQUEST]: 4,
  [EnvelopeKind.CHUNK]: 8,
  [EnvelopeKind.CREDIT]: 8,
});

// the flags each kind may carry; any other bit makes the envelope malformed
const ALLOWED_FLAGS: Readonly<Record<EnvelopeKind, number>> = Object.freeze({
  [EnvelopeKind.REQUEST]:
    EnvelopeFlag.SESSION |
    EnvelopeFlag.DESTINATION |
    EnvelopeFlag.TRANSFER |
    EnvelopeFlag.SUBSCRIPTION |
    EnvelopeFlag.PACED,
  // an answer names its call alone: a destination means something to its relay only, and the
  // requester knows where its call went
  [EnvelopeKind.RESULT]: EnvelopeFlag.SESSION | EnvelopeFlag.TRANSFER,
  [EnvelopeKind.FAILURE]: EnvelopeFlag.SESSION,
  [EnvelopeKind.NOTIFICATION]: 0,
  [EnvelopeKind.CHUNK]: EnvelopeFlag.MORE,
  // a credit counts a subscription's notifications, or a transfer's bytes
  [EnvelopeKind.CREDIT]: EnvelopeFlag.PACED,
  [EnvelopeKind.CANCEL]: 0,
});

// the high word of the largest value a 64-bit field holds: 2⁵³ − 1, the largest safe integer
const HIGH_MAXIMUM = 0x1f_ffff;

// what a request refused for its layout is told: the layouts this peer reads
const LAYOUTS_READ = Object.values(EnvelopeLayout)
  .map((layout) => {
    return `0x${layout.toString(16).toUpperCase()}`;
  })
  .join(', ');

// helpers

const viewOf = (bytes: Uint8Array): DataView => {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

const hexadecimalOf = (value: number): string => {
  return `0x${value.toString(16).padStart(2, '0')}`;
};

/** How long a header of `kind` with `flags` is: the prefix, the kind's own part, then each block. */
const sizeOf = (kind: number, flags: number): number => {
  return BLOCK_BYTES.reduce(
    (bytes, [flag, blockBytes]) => {
      return (flags & flag) === 0 ? bytes : bytes + blockBytes;
    },
    PREFIX_BYTES + (KIND_PART_BYTES[kind] ?? 0)
  );
};

/** A {@link ProgrammerError} when `value` is not an integer from 1 to its field's maximum. */
const assertField = (field: keyof FIELD_MAXIMUMS, value: unknown): void => {
  const maximum = FIELD_MAXIMUMS[field];

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ProgrammerError(
      `${field} is an integer from 1 to ${String(maximum)}, got ${typeof value === 'number' ? String(value) : typeof value}`
    );
  }
};

/** A {@link ProgrammerError} when `value` is not a whole number from 0 to 2⁵³ − 1. */
const assertUint53 = (field: string, value: unknown): void => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProgrammerError(
      `${field} is a whole number from 0 to 2⁵³ − 1, got ${typeof value === 'number' ? String(value) : typeof value}`
    );
  }
};

/** A 64-bit field, its high word first; `undefined` for 2⁵³ or more, which no safe integer is. */
const readUint53 = (view: DataView, offset: number): number | undefined => {
  const high = view.getUint32(offset);

  return high > HIGH_MAXIMUM ? undefined : high * 2 ** 32 + view.getUint32(offset + 4);
};

/** Writes a 64-bit field, its high word first, without an operator that would cut it to 32 bits. */
const writeUint53 = (
  view: DataView,
  { offset, value }: { offset: number; value: number }
): void => {
  view.setUint32(offset, Math.floor(value / 2 ** 32));
  view.setUint32(offset + 4, value % 2 ** 32);
};

/**
 * The flags `header` writes: the blocks it carries — a session, a destination, a transfer's total —
 * which its kind must allow; whether it opens a subscription, which only a request does; whether it
 * is paced, which only a request that opens one is, or a credit; and, for a chunk, whether more
 * follow it.
 */
const flagsOf = (header: EnvelopeHeader): number => {
  const { destinationId, isLast, opensSubscription, paced, sessionToken, total } = header as {
    destinationId?: unknown;
    isLast?: unknown;
    opensSubscription?: unknown;
    paced?: unknown;
    sessionToken?: unknown;
    total?: unknown;
  };
  let flags = 0;

  if (sessionToken !== undefined) {
    flags |= EnvelopeFlag.SESSION;
  }

  if (destinationId !== undefined) {
    flags |= EnvelopeFlag.DESTINATION;
  }

  if (total !== undefined) {
    flags |= EnvelopeFlag.TRANSFER;
  }

  // a caller without types may name a kind the table does not have
  if (!Object.hasOwn(ALLOWED_FLAGS, header.kind)) {
    throw new ProgrammerError(`${hexadecimalOf(header.kind)} is not a kind this layout writes`);
  }

  if ((flags & ~ALLOWED_FLAGS[header.kind]) !== 0) {
    throw new ProgrammerError(
      `a ${hexadecimalOf(header.kind)} header carries no block ${hexadecimalOf(flags & ~ALLOWED_FLAGS[header.kind])}`
    );
  }

  if (opensSubscription === true) {
    if (header.kind !== EnvelopeKind.REQUEST) {
      throw new ProgrammerError(`a ${hexadecimalOf(header.kind)} header opens no subscription`);
    }

    flags |= EnvelopeFlag.SUBSCRIPTION;
  }

  if (paced === true) {
    if (header.kind !== EnvelopeKind.CREDIT && (flags & EnvelopeFlag.SUBSCRIPTION) === 0) {
      throw new ProgrammerError(
        `a ${hexadecimalOf(header.kind)} header paces nothing: a request that opens a subscription does, or a credit`
      );
    }

    flags |= EnvelopeFlag.PACED;
  }

  if (header.kind === EnvelopeKind.CHUNK) {
    if (typeof isLast !== 'boolean') {
      throw new ProgrammerError('a chunk says whether it is the last');
    }

    flags |= isLast ? 0 : EnvelopeFlag.MORE;
  }

  return flags;
};

// definition

/**
 * The first 8 bytes of an envelope, which every layout keeps where they are. Throws a
 * {@link FailureError} of `envelopeMalformed` for fewer bytes, or a first byte no layout is.
 */
export const readPrefix = (
  bytes: Uint8Array,
  failures: Pick<IRouterFailures, 'envelopeMalformed'>
): IEnvelopePrefix => {
  if (bytes.length < PREFIX_BYTES) {
    throw new FailureError({
      ...failures.envelopeMalformed,
      detail: `an envelope is at least ${String(PREFIX_BYTES)} bytes, not ${String(bytes.length)}`,
    });
  }

  const view = viewOf(bytes);
  const layout = view.getUint8(0);

  if (layout < LAYOUTS.first || layout > LAYOUTS.last) {
    throw new FailureError({
      ...failures.envelopeMalformed,
      detail: `${hexadecimalOf(layout)} is not an envelope's first byte`,
    });
  }

  return { callId: view.getUint32(4), kind: view.getUint8(1), layout };
};

/** A {@link FailureError} of `failures`' `envelopeMalformed`, saying why. */
const malformedOf = (
  failures: Pick<IRouterFailures, 'envelopeMalformed'>,
  detail: string
): FailureError => {
  return new FailureError({ ...failures.envelopeMalformed, detail });
};

/**
 * The prefix of an envelope of this layout, of a kind this peer takes; `undefined` for an advisory
 * kind, skipped. Throws, in this order, for a layout to come, a byte that is never a kind, a kind to
 * come, and a call id of 0.
 */
const checkPrefix = (
  bytes: Uint8Array,
  failures: ReadFailures
): (IEnvelopePrefix & { kind: EnvelopeKind }) | undefined => {
  const { callId, kind, layout } = readPrefix(bytes, failures);

  if (layout !== EnvelopeLayout.FIRST) {
    throw new FailureError({ ...failures.layoutUnsupported, detail: LAYOUTS_READ });
  }

  if (kind >= KINDS.advisory) {
    return undefined;
  }

  if (kind < KINDS.first) {
    throw malformedOf(failures, `${hexadecimalOf(kind)} is never a kind`);
  }

  if (!KINDS_READ.has(kind)) {
    throw new FailureError({
      ...failures.kindUnsupported,
      detail: `${hexadecimalOf(kind)} is not a kind this peer takes`,
    });
  }

  if (callId === 0) {
    throw malformedOf(failures, 'a call id is never 0');
  }

  // a kind this layout reads, checked above
  return { callId, kind: kind as EnvelopeKind, layout };
};

/**
 * The flags of a header of `kind`, and its length. Throws for a flag its kind does not carry, then
 * for a length that is not its blocks', or that runs past the message.
 */
const checkLength = (
  bytes: Uint8Array,
  { failures, kind }: { failures: ReadFailures; kind: EnvelopeKind }
): { flags: number; headerBytes: number } => {
  const view = viewOf(bytes);
  const flags = view.getUint8(2);
  const allowed = ALLOWED_FLAGS[kind];

  if ((flags & ~allowed) !== 0) {
    throw malformedOf(
      failures,
      `a ${hexadecimalOf(kind)} envelope carries no flag ${hexadecimalOf(flags & ~allowed)}`
    );
  }

  const headerBytes = view.getUint8(3) * 4;
  const expected = sizeOf(kind, flags);

  if (headerBytes !== expected || headerBytes > bytes.length) {
    throw malformedOf(
      failures,
      `a ${hexadecimalOf(kind)} header of flags ${hexadecimalOf(flags)} is ${String(expected)} bytes, not ${String(headerBytes)} of ${String(bytes.length)}`
    );
  }

  return { flags, headerBytes };
};

/**
 * The blocks a header of `kind` carries, in the order of their bits: its session, its destination,
 * then a transfer's total. Throws for the end of a session on a request, for a destination of 0,
 * and for a total of 2⁵³ or more.
 */
const readBlocks = (
  bytes: Uint8Array,
  { failures, flags, kind }: { failures: ReadFailures; flags: number; kind: EnvelopeKind }
): { destinationId?: DestinationId; sessionToken?: SessionToken | null; total?: number } => {
  const view = viewOf(bytes);
  let offset = PREFIX_BYTES + (KIND_PART_BYTES[kind] ?? 0);
  let sessionToken: SessionToken | null | undefined;
  let destinationId: DestinationId | undefined;
  let total: number | undefined;

  if ((flags & EnvelopeFlag.SESSION) !== 0) {
    const token = bytes.subarray(offset, offset + SESSION_TOKEN_BYTES);
    const isEnded = token.every((byte) => {
      return byte === 0;
    });

    // 16 zero bytes announce that a session ended, which only an answer does
    if (isEnded && kind === EnvelopeKind.REQUEST) {
      throw malformedOf(failures, 'a request presents no ended session');
    }

    sessionToken = isEnded ? null : toSessionToken(token);
    offset += SESSION_TOKEN_BYTES;
  }

  if ((flags & EnvelopeFlag.DESTINATION) !== 0) {
    destinationId = view.getUint32(offset);

    if (destinationId === 0) {
      throw malformedOf(failures, 'a destination id is never 0');
    }

    offset += 4;
  }

  if ((flags & EnvelopeFlag.TRANSFER) !== 0) {
    total = readUint53(view, offset);

    if (total === undefined) {
      throw malformedOf(failures, 'a total is below 2⁵³');
    }
  }

  return {
    ...(destinationId === undefined ? {} : { destinationId }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(total === undefined ? {} : { total }),
  };
};

/**
 * The header of `kind`: its call, its kind's own part — a request's service and procedure, and
 * whether it opens a subscription, paced; a chunk's offset, and whether it is the last; a credit's
 * end, and whether it counts notifications — and its blocks. Throws for a procedure of 0, for a
 * request paced that opens no subscription, and for an offset or an end of 2⁵³ or more.
 */
const headerOf = (
  bytes: Uint8Array,
  {
    blocks,
    callId,
    failures,
    flags,
    kind,
  }: {
    blocks: ReturnType<typeof readBlocks>;
    callId: CallId;
    failures: ReadFailures;
    flags: number;
    kind: EnvelopeKind;
  }
): EnvelopeHeader => {
  const view = viewOf(bytes);

  switch (kind) {
    case EnvelopeKind.REQUEST: {
      const procedureId = view.getUint16(PREFIX_BYTES + 2);
      const { destinationId, sessionToken, total } = blocks;

      if (procedureId === 0) {
        throw malformedOf(failures, 'a procedure id is never 0');
      }

      // pacing is a subscription's: a request that opens none has nothing to pace
      if ((flags & EnvelopeFlag.PACED) !== 0 && (flags & EnvelopeFlag.SUBSCRIPTION) === 0) {
        throw malformedOf(failures, 'a request paced opens a subscription');
      }

      return {
        callId,
        kind,
        procedureId,
        serviceId: view.getUint16(PREFIX_BYTES),
        ...(destinationId === undefined ? {} : { destinationId }),
        ...((flags & EnvelopeFlag.SUBSCRIPTION) === 0 ? {} : { opensSubscription: true }),
        ...((flags & EnvelopeFlag.PACED) === 0 ? {} : { paced: true }),
        // a request's token is never the end of a session, refused with its blocks
        ...(sessionToken === undefined || sessionToken === null ? {} : { sessionToken }),
        ...(total === undefined ? {} : { total }),
      };
    }
    case EnvelopeKind.RESULT: {
      // a result carries no destination: its flag is refused with the others
      const { sessionToken, total } = blocks;

      return {
        callId,
        kind,
        ...(sessionToken === undefined ? {} : { sessionToken }),
        ...(total === undefined ? {} : { total }),
      };
    }
    case EnvelopeKind.FAILURE: {
      // a failure carries no destination and no total: their flags are refused with the others
      const { sessionToken } = blocks;

      return { callId, kind, ...(sessionToken === undefined ? {} : { sessionToken }) };
    }
    case EnvelopeKind.NOTIFICATION:
      return { callId, kind };
    case EnvelopeKind.CHUNK: {
      const offset = readUint53(view, PREFIX_BYTES);

      if (offset === undefined) {
        throw malformedOf(failures, "a chunk's offset is below 2⁵³");
      }

      return { callId, isLast: (flags & EnvelopeFlag.MORE) === 0, kind, offset };
    }
    case EnvelopeKind.CREDIT: {
      const creditEnd = readUint53(view, PREFIX_BYTES);

      if (creditEnd === undefined) {
        throw malformedOf(failures, "a credit's end is below 2⁵³");
      }

      return {
        callId,
        creditEnd,
        kind,
        ...((flags & EnvelopeFlag.PACED) === 0 ? {} : { paced: true }),
      };
    }
    case EnvelopeKind.CANCEL:
      return { callId, kind };
  }
};

/**
 * An envelope's header, as `failures`' router reads it: `undefined` for an advisory kind, which is
 * skipped. Read in the order `writeHeader` writes it — the prefix, the flags and the length, the
 * blocks, then the header — and checked in that order, so the failure raised is the first one met:
 * a layout it does not read, a kind it does not take, or a header that does not hold together — a
 * call id of 0, a flag its kind does not carry, a length that is not its blocks', or a field that
 * names nothing.
 */
export const readHeader = (bytes: Uint8Array, failures: ReadFailures): IReadHeader | undefined => {
  const prefix = checkPrefix(bytes, failures);

  if (prefix === undefined) {
    return undefined;
  }

  const { callId, kind } = prefix;
  const { flags, headerBytes } = checkLength(bytes, { failures, kind });
  const blocks = readBlocks(bytes, { failures, flags, kind });

  return { header: headerOf(bytes, { blocks, callId, failures, flags, kind }), headerBytes };
};

/** How long `header` is once written. Throws as {@link writeHeader} does for a block its kind lacks. */
export const headerBytesOf = (header: EnvelopeHeader): number => {
  return sizeOf(header.kind, flagsOf(header));
};

/**
 * Writes `header` at the start of `bytes`, and gives its length. Throws a {@link ProgrammerError},
 * before anything is written, for a kind this layout does not write, a block its kind does not
 * carry, a field that is not an integer from 1 to its maximum — from 0 to 2⁵³ − 1 for an offset, an
 * end or a total — or a token that is not one — a `null` token, the end of a session, only on an
 * answer.
 */
export const writeHeader = (header: EnvelopeHeader, bytes: Uint8Array): number => {
  const flags = flagsOf(header);
  const headerBytes = sizeOf(header.kind, flags);
  const { destinationId, sessionToken, total } = header as {
    destinationId?: number;
    sessionToken?: SessionToken | null;
    total?: number;
  };

  assertField('callId', header.callId);

  if (header.kind === EnvelopeKind.REQUEST) {
    assertField('serviceId', header.serviceId);
    assertField('procedureId', header.procedureId);
  }

  if (header.kind === EnvelopeKind.CHUNK) {
    assertUint53('offset', header.offset);
  }

  if (header.kind === EnvelopeKind.CREDIT) {
    assertUint53('creditEnd', header.creditEnd);
  }

  if (destinationId !== undefined) {
    assertField('destinationId', destinationId);
  }

  if (total !== undefined) {
    assertUint53('total', total);
  }

  if (
    sessionToken !== undefined &&
    !(sessionToken === null ? header.kind !== EnvelopeKind.REQUEST : isSessionToken(sessionToken))
  ) {
    throw new ProgrammerError(
      sessionToken === null
        ? 'only an answer announces that a session ended'
        : 'a session token is 16 bytes in unpadded base64url'
    );
  }

  if (bytes.length < headerBytes) {
    throw new ProgrammerError(
      `a ${String(headerBytes)}-byte header does not fit in ${String(bytes.length)} bytes`
    );
  }

  const view = viewOf(bytes);
  let offset = PREFIX_BYTES;

  view.setUint8(0, EnvelopeLayout.FIRST);
  view.setUint8(1, header.kind);
  view.setUint8(2, flags);
  view.setUint8(3, headerBytes / 4);
  view.setUint32(4, header.callId);

  if (header.kind === EnvelopeKind.REQUEST) {
    view.setUint16(offset, header.serviceId);
    view.setUint16(offset + 2, header.procedureId);
    offset += 4;
  }

  if (header.kind === EnvelopeKind.CHUNK) {
    writeUint53(view, { offset, value: header.offset });
    offset += 8;
  }

  if (header.kind === EnvelopeKind.CREDIT) {
    writeUint53(view, { offset, value: header.creditEnd });
    offset += 8;
  }

  if (sessionToken !== undefined) {
    bytes.set(
      sessionToken === null
        ? new Uint8Array(SESSION_TOKEN_BYTES)
        : toSessionTokenBytes(sessionToken),
      offset
    );
    offset += SESSION_TOKEN_BYTES;
  }

  if (destinationId !== undefined) {
    view.setUint32(offset, destinationId);
    offset += 4;
  }

  if (total !== undefined) {
    writeUint53(view, { offset, value: total });
  }

  return headerBytes;
};
