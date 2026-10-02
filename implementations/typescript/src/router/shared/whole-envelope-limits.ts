// ── Whole-envelope limits ─────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { LIMIT_DEFAULTS } from './constants';
import type { RouterLimitsOptions } from './types';

// definition

/**
 * A router's limits over a transport that carries each envelope whole and no transfer — HTTP's,
 * whose body is the envelope: no transfer either way, a payload up to what one envelope holds, and a
 * window the limits' rules want and nothing reads. A transfer asked for is a {@link ProgrammerError}:
 * a request's body goes to the server before its answer comes, so no credit could come back.
 *
 * @example
 * const limits = wholeEnvelopeLimitsOf({ maximumEnvelopeBytes: 1_048_576 });
 * // { chunkBytes: 1_048_576, maximumEnvelopeBytes: 1_048_576, maximumTransfers: 0, windowBytes: 2_097_152 }
 */
export const wholeEnvelopeLimitsOf = (
  limits: RouterLimitsOptions | undefined
): RouterLimitsOptions & { maximumEnvelopeBytes: number } => {
  const maximumEnvelopeBytes = limits?.maximumEnvelopeBytes ?? LIMIT_DEFAULTS.maximumEnvelopeBytes;
  const maximumTransfers = limits?.maximumTransfers ?? 0;

  if (maximumTransfers !== 0) {
    throw new ProgrammerError(
      `a transport of whole envelopes carries no transfer: maximumTransfers is 0, not ${String(maximumTransfers)}`
    );
  }

  return {
    ...limits,
    chunkBytes: maximumEnvelopeBytes,
    maximumEnvelopeBytes,
    maximumTransfers: 0,
    windowBytes: 2 * maximumEnvelopeBytes,
  };
};
