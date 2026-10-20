// ── Fuzz target: the envelope reader ──────────────────────────────────────────

// Raw bytes, as a transport delivers them, read by each side's router as an envelope, its header
// then its body, and as a failure's record: each read returns, or refuses with a `FailureError`,
// as `envelope-fuzz.test.ts` holds of the vectors' mutations. The C# side's `EnvelopeTarget` is its
// twin.

// dependencies

import {
  CLIENT_FAILURES,
  LIMIT_DEFAULTS,
  SERVER_FAILURES,
} from '../../src/router/shared/constants';
import { readEnvelope, readFailure } from '../../src/router/shared/envelope';
import { FailureError } from '../../src/router/shared/errors';
import { isRefused } from './refusal';

// definition

export const fuzz = (data: Uint8Array): void => {
  const { maximumDetailBytes, maximumEnvelopeBytes } = LIMIT_DEFAULTS;

  for (const failures of [SERVER_FAILURES, CLIENT_FAILURES]) {
    isRefused(FailureError, () => {
      readEnvelope(data, { failures, maximumDetailBytes, maximumEnvelopeBytes });
    });
    isRefused(FailureError, () => {
      readFailure(data, { failures, maximumDetailBytes });
    });
  }
};
