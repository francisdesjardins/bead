// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import type { Data } from '../../transport/shared/types';
import { EnvelopeKind, FailureScope, LIMIT_DEFAULTS } from './constants';
import { FailureError } from './errors';
import { headerBytesOf, readHeader, readPrefix, writeHeader } from './header';
import type {
  Envelope,
  IFailure,
  IReceivedFailure,
  IRouterFailures,
  IRouterLimits,
  OutgoingEnvelope,
} from './types';

// types

/** What reading an envelope refuses with. */
type ReadFailures = Pick<
  IRouterFailures,
  'envelopeMalformed' | 'envelopeTooLarge' | 'kindUnsupported' | 'layoutUnsupported'
>;

// constants

// a failure's record: its code, its relays, its flags, then its detail
const RECORD_BYTES = 4;

// the one flag of a failure's record this layout reads: the code is the procedure's own
const APPLICATION = 0x01;

// the scopes a record is written in; a caller without types may pass another
const SCOPES: ReadonlySet<number> = new Set(Object.values(FailureScope));

// a detail is text as it came: a leading U+FEFF is a character, and bytes that are not UTF-8 read
// as U+FFFD rather than fail the failure they explain
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

// helpers

/**
 * What follows an envelope's header: a failure's record, its detail cut to `maximumDetailBytes`;
 * nothing for a credit or a cancel; or its payload.
 */
const bodyOf = (envelope: OutgoingEnvelope, maximumDetailBytes: number): Uint8Array => {
  switch (envelope.kind) {
    case EnvelopeKind.CANCEL:
    case EnvelopeKind.CREDIT:
      return new Uint8Array(0);
    case EnvelopeKind.FAILURE:
      return writeFailure(envelope.failure, maximumDetailBytes);
    case EnvelopeKind.CHUNK:
    case EnvelopeKind.NOTIFICATION:
    case EnvelopeKind.REQUEST:
    case EnvelopeKind.RESULT:
      return envelope.payload;
  }
};

/**
 * A {@link FailureError} of `envelopeMalformed` for bytes after the header of a kind that carries
 * none, a credit or a cancel: they are bytes this layout does not define.
 */
const assertNothingAfter = (
  body: Uint8Array,
  { failures, what }: { failures: Pick<IRouterFailures, 'envelopeMalformed'>; what: string }
): void => {
  if (body.length > 0) {
    throw new FailureError({
      ...failures.envelopeMalformed,
      detail: `a ${what} carries no payload, not ${String(body.length)} bytes`,
    });
  }
};

/** Whether `byte` continues a UTF-8 character rather than starts one. */
const isContinuation = (byte: number | undefined): boolean => {
  return byte !== undefined && (byte & 0xc0) === 0x80;
};

// definition

/**
 * The bytes a transport delivered, as an envelope's, at their own offset in the buffer that holds
 * them; a string or a Blob is not an envelope, so a router needs its transport to deliver binary as
 * `'arraybuffer'` or `'nodebuffer'`. Throws a TypeError otherwise.
 */
export const bytesOf = (data: Data): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  throw new TypeError(
    `an envelope is binary, not ${typeof data === 'string' ? 'a string' : 'a Blob'}`
  );
};

/**
 * A failure's record, from a failure envelope's payload: its code, its relays as they came, its
 * scope, and its detail — cut to `maximumDetailBytes`, back to the start of the character the cut
 * fell in. Throws a {@link FailureError} of `envelopeMalformed` for fewer than 4 bytes, a code of
 * 0, or a flag other than the application's.
 */
export const readFailure = (
  payload: Uint8Array,
  {
    failures,
    maximumDetailBytes = LIMIT_DEFAULTS.maximumDetailBytes,
  }: {
    failures: Pick<IRouterFailures, 'envelopeMalformed'>;
    maximumDetailBytes?: number | undefined;
  }
): IReceivedFailure => {
  const malformed = (detail: string): FailureError => {
    return new FailureError({ ...failures.envelopeMalformed, detail });
  };

  if (payload.length < RECORD_BYTES) {
    throw malformed(`a failure's record is ${String(RECORD_BYTES)} bytes at least`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = view.getUint16(0);
  const flags = view.getUint8(3);

  if (code === 0) {
    throw malformed('a failure is never of code 0');
  }

  if ((flags & ~APPLICATION) !== 0) {
    throw malformed(`a failure's record carries no flag 0x${(flags & ~APPLICATION).toString(16)}`);
  }

  let end = Math.min(payload.length, RECORD_BYTES + maximumDetailBytes);

  // a cut inside a character drops the whole character; past the end there is nothing to continue
  while (end > RECORD_BYTES && isContinuation(payload[end])) {
    end -= 1;
  }

  return {
    code,
    detail: decoder.decode(payload.subarray(RECORD_BYTES, end)),
    relays: view.getUint8(2),
    scope: (flags & APPLICATION) === 0 ? FailureScope.PROTOCOL : FailureScope.APPLICATION,
  };
};

/**
 * An envelope, as `failures`' router reads it from `bytes`: `undefined` for an advisory kind. Its
 * payload is a copy, so the transport's buffer is not held. Throws a {@link FailureError} for bytes
 * that are not an envelope, one larger than `maximumEnvelopeBytes`, or one it does not read.
 */
export const readEnvelope = (
  bytes: Uint8Array,
  {
    failures,
    maximumDetailBytes,
    maximumEnvelopeBytes,
  }: Pick<IRouterLimits, 'maximumEnvelopeBytes'> & {
    failures: ReadFailures;
    maximumDetailBytes?: number | undefined;
  }
): Envelope | undefined => {
  // the first byte says whether these are an envelope's at all, whatever their length
  readPrefix(bytes, failures);

  if (bytes.length > maximumEnvelopeBytes) {
    throw new FailureError({
      ...failures.envelopeTooLarge,
      detail: `an envelope is ${String(maximumEnvelopeBytes)} bytes at most, not ${String(bytes.length)}`,
    });
  }

  const read = readHeader(bytes, failures);

  if (read === undefined) {
    return undefined;
  }

  const { header, headerBytes } = read;
  const body = bytes.subarray(headerBytes);

  switch (header.kind) {
    case EnvelopeKind.FAILURE:
      return {
        failure: readFailure(body, { failures, maximumDetailBytes }),
        header,
        kind: header.kind,
      };
    case EnvelopeKind.NOTIFICATION:
      return { header, kind: header.kind, payload: new Uint8Array(body) };
    case EnvelopeKind.REQUEST:
      return { header, kind: header.kind, payload: new Uint8Array(body) };
    case EnvelopeKind.RESULT:
      return { header, kind: header.kind, payload: new Uint8Array(body) };
    case EnvelopeKind.CHUNK:
      // a chunk carries the next bytes of its payload: without any, it moves nothing on
      if (body.length === 0) {
        throw new FailureError({
          ...failures.envelopeMalformed,
          detail: 'a chunk carries one byte at least',
        });
      }

      return { header, kind: header.kind, payload: new Uint8Array(body) };
    case EnvelopeKind.CREDIT:
      assertNothingAfter(body, { failures, what: 'credit' });

      return { header, kind: header.kind };
    case EnvelopeKind.CANCEL:
      assertNothingAfter(body, { failures, what: 'cancel' });

      return { header, kind: header.kind };
  }
};

/**
 * A failure's record, to send: its code, the relays it crossed, its scope, and its detail cut to
 * `maximumDetailBytes` at a character's boundary. Throws a {@link ProgrammerError} for a code that
 * is not an integer from 1 to 65535, relays crossed that are not an integer from 0 to 255, or a
 * scope that is neither.
 */
export const writeFailure = (
  failure: IFailure,
  maximumDetailBytes: number = LIMIT_DEFAULTS.maximumDetailBytes
): Uint8Array => {
  const { code, detail = '', relays = 0, scope } = failure;

  if (!Number.isInteger(code) || code < 1 || code > 0xffff) {
    throw new ProgrammerError(
      `a failure's code is an integer from 1 to 65535, not ${String(code)}`
    );
  }

  if (!Number.isInteger(relays) || relays < 0 || relays > 0xff) {
    throw new ProgrammerError(
      `a failure crossed an integer from 0 to 255 relays, not ${String(relays)}`
    );
  }

  if (!SCOPES.has(scope)) {
    throw new ProgrammerError(`a failure's scope is the protocol's or the application's`);
  }

  // no character takes more than 3 bytes per UTF-16 unit, and `encodeInto` stops at a boundary
  const record = new Uint8Array(RECORD_BYTES + Math.min(maximumDetailBytes, detail.length * 3));
  const view = new DataView(record.buffer);
  const { written } = encoder.encodeInto(detail, record.subarray(RECORD_BYTES));

  view.setUint16(0, code);
  view.setUint8(2, relays);
  view.setUint8(3, scope === FailureScope.APPLICATION ? APPLICATION : 0);

  return record.subarray(0, RECORD_BYTES + written);
};

/**
 * An envelope's bytes: its header, then its payload — a failure's record, its detail cut to
 * `maximumDetailBytes`, for a failure. Throws a {@link ProgrammerError} as its header and its
 * failure do, when its kind is not its header's, or for a chunk without a byte.
 */
export const writeEnvelope = (
  envelope: OutgoingEnvelope,
  maximumDetailBytes: number = LIMIT_DEFAULTS.maximumDetailBytes
): Uint8Array => {
  if (envelope.kind !== envelope.header.kind) {
    throw new ProgrammerError(
      `an envelope of kind ${String(envelope.kind)} has a header of kind ${String(envelope.header.kind)}`
    );
  }

  if (envelope.kind === EnvelopeKind.CHUNK && envelope.payload.length === 0) {
    throw new ProgrammerError('a chunk carries one byte at least');
  }

  const body = bodyOf(envelope, maximumDetailBytes);
  const headerBytes = headerBytesOf(envelope.header);
  const bytes = new Uint8Array(headerBytes + body.length);

  writeHeader(envelope.header, bytes);
  bytes.set(body, headerBytes);

  return bytes;
};
