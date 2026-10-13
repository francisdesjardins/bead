// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import {
  CredentialScheme,
  EnvelopeFlag,
  EnvelopeKind,
  EnvelopeLayout,
  SESSION_TOKEN_BYTES,
} from './constants';
import { FailureError } from './errors';
import { isSessionToken, toSessionToken, toSessionTokenBytes } from './identifiers';
import type {
  Announcement,
  CallId,
  Credential,
  DestinationId,
  EnvelopeHeader,
  IEnvelopePrefix,
  IRouterFailures,
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

/** The bytes a header takes at most: the 255 words its fourth byte counts. */
export const MAXIMUM_HEADER_BYTES = 1_020;

// the prefix: layout, kind, flags, header words, then the call id at bytes 4 to 7
const PREFIX_BYTES = 8;

// the first byte of an envelope, from the one this layout is to the last one to come
const LAYOUTS = Object.freeze({ first: EnvelopeLayout.FIRST, last: 0xaf });

// below the first, never a kind; from the advisory one on, skipped; in between, the kinds this
// layout reads, and the others to come
const KINDS = Object.freeze({ first: EnvelopeKind.REQUEST, advisory: 0x80 });
const KINDS_READ: ReadonlySet<number> = new Set(Object.values(EnvelopeKind));

// each block of a fixed length, in the order of its bit: a destination, a transfer's total; the
// credential's, whose length varies, comes after them
const BLOCK_BYTES: readonly (readonly [flag: number, bytes: number])[] = Object.freeze([
  [EnvelopeFlag.DESTINATION, 4],
  [EnvelopeFlag.TRANSFER, 8],
]);

// a credential's head, as a TLS extension's (RFC 8446 §4.2): its scheme, then its length, 2 bytes
// each
const CREDENTIAL_HEAD_BYTES = 4;

// each credential scheme's name, for a detail
const SCHEME_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(CredentialScheme).map(([name, scheme]) => {
    return [scheme, name];
  })
);

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
    EnvelopeFlag.DESTINATION |
    EnvelopeFlag.TRANSFER |
    EnvelopeFlag.CREDENTIAL |
    EnvelopeFlag.SUBSCRIPTION |
    EnvelopeFlag.PACED,
  // an answer names its call alone: a destination means something to its relay only, and the
  // requester knows where its call went
  [EnvelopeKind.RESULT]: EnvelopeFlag.TRANSFER | EnvelopeFlag.CREDENTIAL,
  [EnvelopeKind.FAILURE]: EnvelopeFlag.CREDENTIAL,
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

const isZero = (bytes: Uint8Array): boolean => {
  return bytes.every((byte) => {
    return byte === 0;
  });
};

/** A credential scheme's name, or its number for a scheme to come. */
const schemeNameOf = (scheme: number): string => {
  return SCHEME_NAMES.get(scheme) ?? `scheme ${String(scheme)}`;
};

/**
 * How far a header of `kind` with `flags` runs before its credential: the prefix, the kind's own
 * part, then each block of a fixed length.
 */
const fixedSizeOf = (kind: number, flags: number): number => {
  return BLOCK_BYTES.reduce(
    (bytes, [flag, blockBytes]) => {
      return (flags & flag) === 0 ? bytes : bytes + blockBytes;
    },
    PREFIX_BYTES + (KIND_PART_BYTES[kind] ?? 0)
  );
};

/** `length` bytes and the zero bytes that pad them to the next 4-byte word, which byte 3 counts. */
const paddedOf = (length: number): number => {
  return length + ((4 - (length % 4)) % 4);
};

/**
 * Bytes as text, one character per byte, as ISO 8859-1 maps them: `TextDecoder` reads `latin1` as
 * windows-1252, which maps 0x80 to 0x9f elsewhere.
 */
const latin1Of = (bytes: Uint8Array): string => {
  return String.fromCharCode(...bytes);
};

/** The bytes `text` spells, one per character; `undefined` for a character past U+00FF. */
const latin1BytesOf = (text: string): Uint8Array | undefined => {
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code > 0xff) {
      return undefined;
    }

    bytes[index] = code;
  }

  return bytes;
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
 * The flags `header` writes: the blocks it carries — a destination, a transfer's total, a credential
 * — which its kind must allow; whether it opens a subscription, which only a request does; whether it
 * is paced, which only a request that opens one is, or a credit; and, for a chunk, whether more
 * follow it.
 */
const flagsOf = (header: EnvelopeHeader): number => {
  const { credential, destinationId, isLast, opensSubscription, paced, total } = header as {
    credential?: unknown;
    destinationId?: unknown;
    isLast?: unknown;
    opensSubscription?: unknown;
    paced?: unknown;
    total?: unknown;
  };
  let flags = 0;

  if (destinationId !== undefined) {
    flags |= EnvelopeFlag.DESTINATION;
  }

  if (total !== undefined) {
    flags |= EnvelopeFlag.TRANSFER;
  }

  if (credential !== undefined) {
    flags |= EnvelopeFlag.CREDENTIAL;
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

/**
 * The scheme and the bytes `credential` writes on a header of `kind`, which carries one. Throws a
 * {@link ProgrammerError} for a scheme its kind does not take — `NONE` on a request, any but
 * `OPAQUE` and `NONE` on an answer — or what its scheme does not hold: an `OPAQUE` that is no session
 * token, a `JWT` of no character or of one past U+00FF, and bytes beside a scheme from 0 to 3.
 */
const credentialOf = (
  credential: unknown,
  kind: EnvelopeKind
): { bytes: Uint8Array; scheme: number } => {
  // a caller without types may give anything
  const { bytes, scheme, token } = (
    typeof credential === 'object' && credential !== null ? credential : {}
  ) as { bytes?: unknown; scheme?: unknown; token?: unknown };

  if (typeof scheme !== 'number' || !Number.isInteger(scheme) || scheme < 0 || scheme > 0xffff) {
    throw new ProgrammerError(
      `a credential's scheme is an integer from 0 to 65535, got ${typeof scheme === 'number' ? String(scheme) : typeof scheme}`
    );
  }

  if (kind === EnvelopeKind.REQUEST && scheme === CredentialScheme.NONE) {
    throw new ProgrammerError('a request presents a credential, never NONE');
  }

  if (kind !== EnvelopeKind.REQUEST && scheme > CredentialScheme.OPAQUE) {
    throw new ProgrammerError(`an answer announces OPAQUE or NONE, not ${schemeNameOf(scheme)}`);
  }

  if (scheme <= CredentialScheme.ELSEWHERE && bytes !== undefined) {
    throw new ProgrammerError(`${schemeNameOf(scheme)} holds no bytes: a scheme to come does`);
  }

  switch (scheme) {
    case CredentialScheme.NONE:
    case CredentialScheme.ELSEWHERE:
      return { bytes: new Uint8Array(0), scheme };
    case CredentialScheme.OPAQUE:
      if (!isSessionToken(token)) {
        throw new ProgrammerError(
          'an OPAQUE token is a session token: 16 bytes in unpadded base64url, not all zero'
        );
      }

      return { bytes: toSessionTokenBytes(token), scheme };
    case CredentialScheme.JWT: {
      const written =
        typeof token === 'string' && token.length > 0 ? latin1BytesOf(token) : undefined;

      if (written === undefined) {
        throw new ProgrammerError(
          'a JWT is 1 character at least, each from U+0000 to U+00FF, a byte each'
        );
      }

      return { bytes: written, scheme };
    }
    default:
      if (!(bytes instanceof Uint8Array)) {
        throw new ProgrammerError(`${schemeNameOf(scheme)} holds its bytes, in a Uint8Array`);
      }

      return { bytes, scheme };
  }
};

/**
 * How `header` is laid out: its flags, its credential as written, and its length, to the end of
 * the credential's padding, its bound unchecked. Throws a {@link ProgrammerError} for a kind this
 * layout does not write, a block its kind does not carry, and a credential {@link credentialOf}
 * refuses.
 */
const unboundedLayoutOf = (
  header: EnvelopeHeader
): {
  credential: { bytes: Uint8Array; scheme: number } | undefined;
  flags: number;
  headerBytes: number;
} => {
  const flags = flagsOf(header);
  const given = (header as { credential?: unknown }).credential;
  const credential = given === undefined ? undefined : credentialOf(given, header.kind);
  const headerBytes =
    fixedSizeOf(header.kind, flags) +
    (credential === undefined ? 0 : CREDENTIAL_HEAD_BYTES + paddedOf(credential.bytes.length));

  return { credential, flags, headerBytes };
};

/**
 * How `header` is laid out, as {@link unboundedLayoutOf} lays it out. Throws as it does, and a
 * {@link ProgrammerError} for a header past 1,020 bytes.
 */
const layoutOf = (header: EnvelopeHeader): ReturnType<typeof unboundedLayoutOf> => {
  const layout = unboundedLayoutOf(header);
  const { headerBytes } = layout;

  if (headerBytes > MAXIMUM_HEADER_BYTES) {
    throw new ProgrammerError(
      `a header is ${String(MAXIMUM_HEADER_BYTES)} bytes at most, not ${String(headerBytes)}`
    );
  }

  return layout;
};

/**
 * Why `held`, the bytes of a credential of `scheme`, are not its scheme's: a length not its own,
 * or an `OPAQUE` of 16 zero bytes; `undefined` when they are.
 */
const brokenRuleOf = (scheme: number, held: Uint8Array): string | undefined => {
  switch (scheme) {
    case CredentialScheme.NONE:
    case CredentialScheme.ELSEWHERE:
      return held.length === 0
        ? undefined
        : `${schemeNameOf(scheme)} holds no byte, not ${String(held.length)}`;
    case CredentialScheme.OPAQUE:
      if (held.length !== SESSION_TOKEN_BYTES) {
        return `an OPAQUE token is ${String(SESSION_TOKEN_BYTES)} bytes, not ${String(held.length)}`;
      }

      return isZero(held) ? 'an OPAQUE token is never all zero' : undefined;
    case CredentialScheme.JWT:
      return held.length === 0 ? 'a JWT is 1 byte at least' : undefined;
    default:
      return undefined;
  }
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
 * for a length that is not its blocks', to the end of its credential's padding, or that runs past
 * the message.
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
  const fixedBytes = fixedSizeOf(kind, flags);
  const hasCredential = (flags & EnvelopeFlag.CREDENTIAL) !== 0;
  const lengthOf = (expected: number): FailureError => {
    return malformedOf(
      failures,
      `a ${hexadecimalOf(kind)} header of flags ${hexadecimalOf(flags)} is ${String(expected)} bytes, not ${String(headerBytes)} of ${String(bytes.length)}`
    );
  };

  if (!hasCredential && (headerBytes !== fixedBytes || headerBytes > bytes.length)) {
    throw lengthOf(fixedBytes);
  }

  if (hasCredential) {
    if (headerBytes > bytes.length) {
      throw malformedOf(
        failures,
        `a ${hexadecimalOf(kind)} header of ${String(headerBytes)} bytes runs past its message of ${String(bytes.length)}`
      );
    }

    // the credential's head states its length, which the header's own must hold before it is read
    if (headerBytes < fixedBytes + CREDENTIAL_HEAD_BYTES) {
      throw malformedOf(
        failures,
        `a ${hexadecimalOf(kind)} header of flags ${hexadecimalOf(flags)} holds its credential's head: ${String(fixedBytes + CREDENTIAL_HEAD_BYTES)} bytes at least, not ${String(headerBytes)}`
      );
    }

    const expected = fixedBytes + CREDENTIAL_HEAD_BYTES + paddedOf(view.getUint16(fixedBytes + 2));

    if (headerBytes !== expected) {
      throw lengthOf(expected);
    }
  }

  return { flags, headerBytes };
};

/**
 * The credential a header of `kind` carries from `offset`, its length checked with the header's.
 * Throws for a scheme its kind does not take — `NONE` on a request, any but `OPAQUE` and `NONE` on
 * an answer — for bytes that are not its scheme's, and for padding that is not zero.
 */
const readCredential = (
  bytes: Uint8Array,
  { failures, kind, offset }: { failures: ReadFailures; kind: EnvelopeKind; offset: number }
): Credential => {
  const view = viewOf(bytes);
  const scheme = view.getUint16(offset);
  const start = offset + CREDENTIAL_HEAD_BYTES;
  const length = view.getUint16(offset + 2);
  const held = bytes.subarray(start, start + length);

  if (kind === EnvelopeKind.REQUEST && scheme === CredentialScheme.NONE) {
    throw malformedOf(failures, 'a request presents a credential, never NONE');
  }

  if (kind !== EnvelopeKind.REQUEST && scheme > CredentialScheme.OPAQUE) {
    throw malformedOf(failures, `an answer announces OPAQUE or NONE, not ${schemeNameOf(scheme)}`);
  }

  const brokenRule = brokenRuleOf(scheme, held);

  if (brokenRule !== undefined) {
    throw malformedOf(failures, brokenRule);
  }

  if (!isZero(bytes.subarray(start + length, start + paddedOf(length)))) {
    throw malformedOf(failures, "a credential's padding is zero bytes");
  }

  switch (scheme) {
    case CredentialScheme.NONE:
      return { scheme: CredentialScheme.NONE };
    case CredentialScheme.OPAQUE:
      return { scheme: CredentialScheme.OPAQUE, token: toSessionToken(held) };
    // a relay passes the same bytes on, whatever they are: a token past ASCII never verifies
    case CredentialScheme.JWT:
      return { scheme: CredentialScheme.JWT, token: latin1Of(held) };
    case CredentialScheme.ELSEWHERE:
      return { scheme: CredentialScheme.ELSEWHERE };
    default:
      // a copy: the message's buffer may be a pool's
      return { bytes: held.slice(), scheme };
  }
};

/**
 * The blocks a header of `kind` carries, in the order of their bits: its destination, a transfer's
 * total, then its credential. Throws for a destination of 0, for a total of 2⁵³ or more, and for a
 * credential {@link readCredential} refuses.
 */
const readBlocks = (
  bytes: Uint8Array,
  { failures, flags, kind }: { failures: ReadFailures; flags: number; kind: EnvelopeKind }
): { credential?: Credential; destinationId?: DestinationId; total?: number } => {
  const view = viewOf(bytes);
  let offset = PREFIX_BYTES + (KIND_PART_BYTES[kind] ?? 0);
  let credential: Credential | undefined;
  let destinationId: DestinationId | undefined;
  let total: number | undefined;

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

    offset += 8;
  }

  if ((flags & EnvelopeFlag.CREDENTIAL) !== 0) {
    credential = readCredential(bytes, { failures, kind, offset });
  }

  return {
    ...(credential === undefined ? {} : { credential }),
    ...(destinationId === undefined ? {} : { destinationId }),
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
      const { credential, destinationId, total } = blocks;

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
        ...(total === undefined ? {} : { total }),
        ...(credential === undefined ? {} : { credential }),
      };
    }
    case EnvelopeKind.RESULT: {
      // a result carries no destination: its flag is refused with the others; and announces
      // `OPAQUE` or `NONE` alone, any other scheme refused with its blocks
      const { credential, total } = blocks as { credential?: Announcement; total?: number };

      return {
        callId,
        kind,
        ...(total === undefined ? {} : { total }),
        ...(credential === undefined ? {} : { credential }),
      };
    }
    case EnvelopeKind.FAILURE: {
      // a failure carries no destination and no total: their flags are refused with the others; and
      // announces as a result does
      const { credential } = blocks as { credential?: Announcement };

      return { callId, kind, ...(credential === undefined ? {} : { credential }) };
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
 * call id of 0, a flag its kind does not carry, a length that is not its blocks', a credential that
 * is not its scheme's or its kind's, or a field that names nothing.
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

/**
 * Where, in a header of `kind` with `flags` that carries a credential, the credential's own bytes
 * start: after the fixed blocks and the credential's head, its scheme and its length.
 */
export const credentialBytesAt = (kind: number, flags: number): number => {
  return fixedSizeOf(kind, flags) + CREDENTIAL_HEAD_BYTES;
};

/**
 * How long `header` is once written. Throws as {@link writeHeader} does for a block its kind lacks,
 * a credential that is not one, or a header past 1,020 bytes.
 */
export const headerBytesOf = (header: EnvelopeHeader): number => {
  return layoutOf(header).headerBytes;
};

/**
 * The bytes `header` takes, as {@link headerBytesOf} counts them, its bound of 1,020 bytes
 * unchecked: what a writer asks of a header it may refuse with a protocol failure. Throws as
 * {@link headerBytesOf} does for anything else.
 */
export const unboundedHeaderBytesOf = (header: EnvelopeHeader): number => {
  return unboundedLayoutOf(header).headerBytes;
};

/**
 * Writes `header` at the start of `bytes`, and gives its length. Throws a {@link ProgrammerError},
 * before anything is written, for a kind this layout does not write, a block its kind does not
 * carry, a field that is not an integer from 1 to its maximum — from 0 to 2⁵³ − 1 for an offset, an
 * end or a total — a credential of a scheme its kind does not take or that its scheme does not hold,
 * or a header past 1,020 bytes.
 */
export const writeHeader = (header: EnvelopeHeader, bytes: Uint8Array): number => {
  const { credential, flags, headerBytes } = layoutOf(header);
  const { destinationId, total } = header as { destinationId?: number; total?: number };

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

  if (destinationId !== undefined) {
    view.setUint32(offset, destinationId);
    offset += 4;
  }

  if (total !== undefined) {
    writeUint53(view, { offset, value: total });
    offset += 8;
  }

  if (credential !== undefined) {
    const start = offset + CREDENTIAL_HEAD_BYTES;

    view.setUint16(offset, credential.scheme);
    view.setUint16(offset + 2, credential.bytes.length);
    bytes.set(credential.bytes, start);
    // a pooled buffer holds what it held before: the padding is written, never assumed
    bytes.fill(0, start + credential.bytes.length, headerBytes);
  }

  return headerBytes;
};
