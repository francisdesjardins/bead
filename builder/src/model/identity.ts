// ── Identity ──────────────────────────────────────────────────────────────────

// Section 16 as a blueprint meets it: when two names are one (16.6), and the order of 16.10's
// reasons, which orders a blueprint's findings on its identities. A name's form and an id's range
// are the format's schema's, whose refusals map to their rules by place.

// dependencies

import type { RuleName } from '../rules.ts';

// constants

/** 16.10's reasons, in its order, as `spec/identities.json` writes them. */
export const IdentityReason = Object.freeze({
  OUT_OF_ITS_RANGE: 'out of its range',
  OFF_ITS_FORM: 'off its form',
} as const);

export type IdentityReason = (typeof IdentityReason)[keyof typeof IdentityReason];

/** The rules that give each of 16.10's reasons, the first reason's first. */
export const RULES_OF_REASON: Readonly<Record<IdentityReason, readonly RuleName[]>> = Object.freeze(
  {
    [IdentityReason.OUT_OF_ITS_RANGE]: [
      'SERVICE_ID_RANGE',
      'PROCEDURE_ID_RANGE',
      'SERVICE_REVISION_RANGE',
    ],
    [IdentityReason.OFF_ITS_FORM]: ['NAME_FORM'],
  }
);

// the codes of A and Z, and how far a capital is from its small letter
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const TO_LOWER = 0x20;

// helpers

// `code` read as spec 16.6 reads it: an ASCII capital as its small letter, and nothing else
const foldedOf = (code: number): number => {
  return code >= UPPER_A && code <= UPPER_Z ? code + TO_LOWER : code;
};

// definition

/**
 * Whether `one` and `other` are one name, spec 16.6: equal once each ASCII capital is read as its
 * small letter, a character at a time, and nothing else changed: `café` and `cafÉ` stay two, and
 * the Kelvin sign is no `k`.
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

/** A name as 16.6 compares it, for a key: each ASCII capital its small letter. */
export const foldOf = (name: string): string => {
  return name.replace(/[A-Z]/gu, (capital) => {
    return String.fromCharCode(foldedOf(capital.charCodeAt(0)));
  });
};

/**
 * Where `rule` stands in 16.10's order: a range's rule first, a name's form next, every other rule,
 * buf's among them, after them.
 */
export const reasonRankOf = (rule: string): number => {
  const reasons = Object.values(IdentityReason);
  const rank = reasons.findIndex((reason) => {
    return (RULES_OF_REASON[reason] as readonly string[]).includes(rule);
  });

  return rank === -1 ? reasons.length : rank;
};
