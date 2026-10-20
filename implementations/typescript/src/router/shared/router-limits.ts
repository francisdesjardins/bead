// ── Router limits ─────────────────────────────────────────────────────────────

// dependencies

import { assertHeldFinite } from '../../transport/shared/clock';
import { ProgrammerError } from '../../transport/shared/errors';
import { LIMIT_DEFAULTS } from './constants';
import type { IRouterLimits, RouterLimitsOptions } from './types';

// constants

// what the limits hold to together, each as the failure that says it does not
const LIMIT_RULES: readonly { holds: (limits: IRouterLimits) => boolean; rule: string }[] =
  Object.freeze([
    {
      holds: ({ maximumEnvelopeBytes }) => {
        return maximumEnvelopeBytes >= 64;
      },
      rule: 'an envelope is 64 bytes at least',
    },
    {
      holds: ({ chunkBytes, maximumEnvelopeBytes }) => {
        return chunkBytes >= 64 && chunkBytes <= maximumEnvelopeBytes;
      },
      rule: "a chunk's envelope is 64 bytes at least, and an envelope at most",
    },
    {
      holds: ({ chunkBytes, windowBytes }) => {
        return windowBytes >= 2 * chunkBytes;
      },
      rule: 'a window holds two chunks at least, so a sender waits for no credit it is owed',
    },
    {
      holds: ({ bufferedBytesBudget, maximumPayloadBytes }) => {
        return maximumPayloadBytes <= bufferedBytesBudget;
      },
      rule: 'a payload fits in the budget of the transfers received',
    },
  ]);

// the limits that may be 0: no transfer taken, and no detail told
const MAY_BE_NONE: ReadonlySet<keyof IRouterLimits> = new Set([
  'maximumDetailBytes',
  'maximumTransfers',
]);

// definition

/**
 * `given` over {@link LIMIT_DEFAULTS}, where it says nothing. A {@link ProgrammerError} for a limit
 * that is not a whole number — positive, but for the transfers and the detail — for limits that do
 * not hold together, or for a transfer's inactivity that is not from 1 to 2³¹ − 1 milliseconds, 0
 * and `Infinity` among them; the inactivity is held rounded to the nearest whole millisecond.
 */
export const limitsOf = (given: RouterLimitsOptions | undefined): IRouterLimits => {
  const keys = Object.keys(LIMIT_DEFAULTS) as (keyof IRouterLimits)[];
  const limits = Object.fromEntries(
    keys.map((key) => {
      return [key, given?.[key] ?? LIMIT_DEFAULTS[key]];
    })
  ) as unknown as IRouterLimits;

  for (const key of keys) {
    const value = limits[key];

    // a transfer's inactivity is a duration, held below as every other is
    if (
      key !== 'transferInactivityTimeout' &&
      (!Number.isSafeInteger(value) || value < (MAY_BE_NONE.has(key) ? 0 : 1))
    ) {
      throw new ProgrammerError(
        `${key} is a whole number${MAY_BE_NONE.has(key) ? '' : ' above 0'}, not ${String(value)}`
      );
    }
  }

  for (const { holds, rule } of LIMIT_RULES) {
    if (!holds(limits)) {
      throw new ProgrammerError(`the router's limits do not hold together: ${rule}`);
    }
  }

  // never, refused: a silent transfer stalls in time, and the call id it keeps reserved goes free;
  // held, as its failures' details say it on the wire
  return Object.freeze({
    ...limits,
    transferInactivityTimeout: assertHeldFinite(
      "a transfer's inactivity",
      limits.transferInactivityTimeout
    ),
  });
};
