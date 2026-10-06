// ── Identity ──────────────────────────────────────────────────────────────────

// What a side holds a procedure's identity to as it is declared, spec section 16: its ids and its
// revision in their ranges, its name in its form, its kind one its way takes, and when two names
// are one.

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { ProcedureKind } from './constants';
import type { IProcedure } from './types';

// types

/** A way a side declares a procedure, by `spec/identities.json`'s id. */
export type DeclarationWay = keyof typeof WAYS;

// constants

/** Why a declaration is refused, by spec 16.10, in the order a side checks them. */
export const IdentityRefusal = Object.freeze({
  OUT_OF_ITS_RANGE: 'out of its range',
  OFF_ITS_FORM: 'off its form',
  AGAINST_ITS_KIND: 'against its kind',
} as const);

/**
 * The kinds each way a side declares a procedure takes (spec 16.11), by `spec/identities.json`'s
 * ids, and what the way does, for a refusal's words.
 */
const WAYS = Object.freeze({
  'client-notification': {
    does: "a client's notification is of a request that notifies",
    takes: [ProcedureKind.NOTIFIES],
  },
  'client-requester': {
    does: "a client's router makes requests",
    takes: [ProcedureKind.REQUEST, ProcedureKind.NOTIFIES],
  },
  'client-resolver': { does: "a client's router answers commands", takes: [ProcedureKind.COMMAND] },
  'server-notification-resolver': {
    does: "a server's resolver that notifies answers a request that notifies",
    takes: [ProcedureKind.NOTIFIES],
  },
  'server-requester': { does: "a server's router makes commands", takes: [ProcedureKind.COMMAND] },
  'server-resolver': {
    does: "a server's resolver that notifies nothing answers a plain request",
    takes: [ProcedureKind.REQUEST],
  },
} as const);

// how a refusal names a procedure's kind
const KIND_WORDS = Object.freeze({
  [ProcedureKind.COMMAND]: 'a command',
  [ProcedureKind.NOTIFIES]: 'a request that notifies',
  [ProcedureKind.REQUEST]: 'a request',
} as const);

// the bounds of 16.2: an id on its 2 bytes, 0 the protocol's (16.3); a revision from 1 to 2³¹ − 1
const LARGEST_ID = 0xffff;
const LARGEST_REVISION = 2 ** 31 - 1;

// the characters of 16.4, by their codes
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const LONGEST_NAME = 63;

// helpers

const isLower = (code: number): boolean => {
  return code >= LOWER_A && code <= LOWER_Z;
};

const isUpper = (code: number): boolean => {
  return code >= UPPER_A && code <= UPPER_Z;
};

// a whole number from 1 to `largest`: no fraction, no string, no boolean, no null
const isInRange = (value: unknown, largest: number): boolean => {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= largest;
};

// `code` read as spec 16.6 reads it: an ASCII upper-case letter as its lower-case one, and nothing else
const foldedOf = (code: number): number => {
  return isUpper(code) ? code + (LOWER_A - UPPER_A) : code;
};

// definition

/**
 * Whether `name` is a procedure's name, spec 16.4: 1 to 63 characters of ASCII, a lower-case letter
 * and then letters and digits. It is read whole, a character at a time, never by a regular
 * expression, whose `$` may let a line feed by, nor by a case mapping, which reads U+212A as `k`
 * (16.5).
 */
export const isProcedureName = (name: unknown): boolean => {
  if (typeof name !== 'string' || name.length === 0 || name.length > LONGEST_NAME) {
    return false;
  }

  if (!isLower(name.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < name.length; index += 1) {
    const code = name.charCodeAt(index);

    if (!isLower(code) && !isUpper(code) && (code < DIGIT_ZERO || code > DIGIT_NINE)) {
      return false;
    }
  }

  return true;
};

/**
 * Whether `one` and `other` are one name, spec 16.6: equal once each ASCII upper-case letter is read
 * as its lower-case one, compared a character at a time, and nothing else changed — `café` and
 * `cafÉ` stay two. It builds no string, so a registry can compare in its loop.
 */
export const areOneName = (one: string, other: string): boolean => {
  if (one.length !== other.length) {
    return false;
  }

  for (let index = 0; index < one.length; index += 1) {
    if (foldedOf(one.charCodeAt(index)) !== foldedOf(other.charCodeAt(index))) {
      return false;
    }
  }

  return true;
};

/**
 * Refuses a declaration of `procedure` — a resolver registered, a requester made, a notification
 * registered — off spec section 16, with a {@link ProgrammerError} whose message ends with the
 * first reason of 16.10 that applies: its service id or its procedure id not a whole number from 1
 * to 65535, or its revision not one from 1 to 2³¹ − 1, `out of its range`; its name no procedure's
 * name, `off its form`. A function of the procedure alone, which holds nothing: a router runs it
 * before any reason of its own, and before its registry's.
 */
export const checkDeclaration = (procedure: IProcedure): void => {
  const { procedureId, procedureName, serviceId, serviceRevision } = procedure as Record<
    keyof IProcedure,
    unknown
  >;

  if (
    !isInRange(serviceId, LARGEST_ID) ||
    !isInRange(procedureId, LARGEST_ID) ||
    !isInRange(serviceRevision, LARGEST_REVISION)
  ) {
    throw new ProgrammerError(
      `a procedure is declared at a service and a procedure from 1 to 65535, of a revision from 1 to 2147483647, not at ${String(serviceId)}/${String(procedureId)} of revision ${String(serviceRevision)}: ${IdentityRefusal.OUT_OF_ITS_RANGE}`
    );
  }

  if (!isProcedureName(procedureName)) {
    throw new ProgrammerError(
      `a procedure's name is a lower-case ASCII letter, then 62 ASCII letters and digits at most, not ${JSON.stringify(procedureName)}: ${IdentityRefusal.OFF_ITS_FORM}`
    );
  }
};

/**
 * Refuses a declaration of `procedure` by `way` whose kind that way does not take (spec 16.11), with
 * a {@link ProgrammerError} whose message ends with `against its kind`: a requester on a client's
 * router takes a request, and one that notifies; on a server's, a command; a resolver on a server's,
 * a request where it notifies nothing and one that notifies where it notifies; on a client's, a
 * command; a notification on a client's, a request that notifies. A procedure that states no kind
 * is taken every way. Run after {@link checkDeclaration}, before any reason of the router's own.
 */
export const checkProcedureKind = (procedure: IProcedure, way: DeclarationWay): void => {
  const { procedureKind, procedureName } = procedure;
  const { does, takes } = WAYS[way];

  if (procedureKind === undefined || (takes as readonly ProcedureKind[]).includes(procedureKind)) {
    return;
  }

  // a caller without types may state a kind no table names
  const words =
    (KIND_WORDS as Readonly<Record<string, string>>)[procedureKind] ??
    `kind ${procedureKind as string}`;

  throw new ProgrammerError(
    `${procedureName} is ${words}; ${does}: ${IdentityRefusal.AGAINST_ITS_KIND}`
  );
};
