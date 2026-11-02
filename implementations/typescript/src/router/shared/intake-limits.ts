// ── Intake limits ─────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { INTAKE_DEFAULTS } from './constants';
import type { IIntakeLimits, IntakeLimitsOptions } from './types';

// definition

/**
 * `options` over {@link INTAKE_DEFAULTS}, where they say nothing, frozen (spec 15.12). A limit that
 * is not a whole number of 1 at least is a {@link ProgrammerError}: a bound of 0 would pause a
 * connection before its first envelope.
 */
export const intakeLimitsOf = (options?: IntakeLimitsOptions): IIntakeLimits => {
  const limits = { ...INTAKE_DEFAULTS };

  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ProgrammerError(`${name} is a whole number above 0, not ${String(value)}`);
    }

    limits[name as keyof IIntakeLimits] = value;
  }

  return Object.freeze(limits);
};
