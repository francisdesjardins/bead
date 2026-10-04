// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { SESSION_TOKEN_BYTES } from './constants';
import type { CallId, DestinationId, RouterSide, SessionToken } from './types';

// constants

// 16 bytes are 22 characters, the last of which holds 2 bits: A, Q, g or w
const SESSION_TOKEN_PATTERN = /^[\w-]{21}[AQgw]$/;

// 16 zero bytes, which no session's token is
const ZERO_TOKEN = 'A'.repeat(22);

// helpers

const isZero = (bytes: Uint8Array): boolean => {
  return bytes.every((byte) => {
    return byte === 0;
  });
};

// definition

/**
 * A drawer of call ids from `first` to `last`, `step` apart, then from `first` again: each draw
 * starts where the last one stopped and skips the ids `isInUse` holds, walking the range once at
 * most; `undefined` when every one is taken. Throws a {@link ProgrammerError} for a range that is
 * not of integers from 1 to 0xffffffff, whose `last` comes before its `first`, or that `step` does
 * not walk exactly.
 */
export const createSequence = ({
  first,
  last,
  step,
}: {
  first: number;
  last: number;
  step: number;
}): ((isInUse: (callId: CallId) => boolean) => CallId | undefined) => {
  const isCallId = (value: number): boolean => {
    return Number.isInteger(value) && value >= 1 && value <= 0xffffffff;
  };

  if (
    !isCallId(first) ||
    !isCallId(last) ||
    !Number.isInteger(step) ||
    step < 1 ||
    last < first ||
    (last - first) % step !== 0
  ) {
    throw new ProgrammerError(
      `a sequence walks call ids from 1 to 0xffffffff by a whole step, got ${String(first)} to ${String(last)} by ${String(step)}`
    );
  }

  const count = (last - first) / step + 1;
  let next = first;

  return (isInUse) => {
    for (let tries = 0; tries < count; tries += 1) {
      const callId = next;

      next = callId === last ? first : callId + step;

      if (!isInUse(callId)) {
        return callId;
      }
    }

    return undefined;
  };
};

/**
 * A destination not `isInUse`, from 4 bytes of `fill` — `crypto`'s own, unless a test gives
 * another; 0, which the wire refuses, or a destination in use, is drawn again.
 */
export const drawDestinationId = (
  isInUse: (destinationId: DestinationId) => boolean,
  fill: (bytes: Uint8Array<ArrayBuffer>) => unknown = (bytes) => {
    return crypto.getRandomValues(bytes);
  }
): DestinationId => {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);

  for (;;) {
    fill(bytes);

    const destinationId = view.getUint32(0);

    if (destinationId !== 0 && !isInUse(destinationId)) {
      return destinationId;
    }
  }
};

/**
 * A session token not `isInUse`, from 16 bytes of `fill` — `crypto`'s own, unless a test gives
 * another; bytes that are all zero, or a token in use, are drawn again.
 */
export const drawSessionToken = (
  isInUse: (token: SessionToken) => boolean,
  fill: (bytes: Uint8Array<ArrayBuffer>) => unknown = (bytes) => {
    return crypto.getRandomValues(bytes);
  }
): SessionToken => {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);

  for (;;) {
    fill(bytes);

    if (!isZero(bytes)) {
      const token = toSessionToken(bytes);

      if (!isInUse(token)) {
        return token;
      }
    }
  }
};

/**
 * Whether `value` is a session token as the wire gives one: 16 bytes in unpadded base64url, and not
 * all of them zero.
 */
export const isSessionToken = (value: unknown): value is SessionToken => {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value) && value !== ZERO_TOKEN;
};

/**
 * Whether `presented` is the token `held`, compared in constant time (spec 9.2, step 5): every
 * character of `held` is read, wherever the two differ. Base64url spells 16 bytes one way only, so
 * comparing the characters compares the bytes.
 */
export const isSameSessionToken = (presented: string, held: SessionToken): boolean => {
  let difference = presented.length ^ held.length;

  for (let index = 0; index < held.length; index += 1) {
    // ! past the end of `presented`, NaN reads as 0, and its length already differs
    difference |= presented.charCodeAt(index) ^ held.charCodeAt(index);
  }

  return difference === 0;
};

/** Which side opened the call `callId` names: odd, a client; even, a server; `undefined` for none. */
export const sideOfCallId = (callId: CallId): RouterSide | undefined => {
  if (!Number.isInteger(callId) || callId < 1 || callId > 0xffffffff) {
    return undefined;
  }

  return callId % 2 === 1 ? 'client' : 'server';
};

/**
 * The session token 16 bytes spell, in unpadded base64url; a {@link ProgrammerError} for any other
 * length, or for 16 zero bytes, which no token is.
 */
export const toSessionToken = (bytes: Uint8Array): SessionToken => {
  if (bytes.length !== SESSION_TOKEN_BYTES || isZero(bytes)) {
    throw new ProgrammerError(
      `a session token is ${String(SESSION_TOKEN_BYTES)} bytes, not all zero; got ${String(bytes.length)}`
    );
  }

  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

  return token as SessionToken;
};

/** The 16 bytes a session token spells; a {@link ProgrammerError} for anything but a token. */
export const toSessionTokenBytes = (token: SessionToken): Uint8Array => {
  if (!isSessionToken(token)) {
    throw new ProgrammerError(`${JSON.stringify(token)} is not a session token`);
  }

  const binary = atob(`${token.replaceAll('-', '+').replaceAll('_', '/')}==`);

  return Uint8Array.from(binary, (character) => {
    return character.charCodeAt(0);
  });
};
