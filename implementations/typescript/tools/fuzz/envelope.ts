// ── Fuzz target: the envelope reader ──────────────────────────────────────────

// Raw bytes, as a transport delivers them, read by each side's router as an envelope, its header
// then its body, and as a failure's record: each read returns, or refuses with a `FailureError`,
// as `envelope-fuzz.test.ts` holds of the vectors' mutations. What reads is written back, and from
// that writing on is written again as it was. The C# side's `EnvelopeTarget` and the Rust side's
// `envelope` target are its twins.

// dependencies

import {
  CLIENT_FAILURES,
  LIMIT_DEFAULTS,
  SERVER_FAILURES,
} from '../../src/router/shared/constants';
import { readEnvelope, readFailure, writeEnvelope } from '../../src/router/shared/envelope';
import { FailureError } from '../../src/router/shared/errors';
import type { Envelope } from '../../src/router/shared/types';
import { ProgrammerError } from '../../src/transport/shared/errors';
import { isRefused } from './refusal';

// helpers

const isSame = (one: Uint8Array, other: Uint8Array): boolean => {
  return (
    one.length === other.length &&
    one.every((byte, at) => {
      return byte === other[at];
    })
  );
};

// ! the first writing is the fixed point, not the input: a detail's bytes that are no UTF-8 read as
// U+FFFD (spec 7.3), three bytes each, and its writing cuts them again (7.4)
const rewrites = (envelope: Envelope, read: (bytes: Uint8Array) => Envelope | undefined): void => {
  const { maximumDetailBytes } = LIMIT_DEFAULTS;
  let written: Uint8Array | undefined;

  // what its writer refuses to write is no finding: an envelope it holds no form of
  isRefused(ProgrammerError, () => {
    written = writeEnvelope(envelope, maximumDetailBytes);
  });

  if (written === undefined) {
    return;
  }

  const normal = read(written);

  if (normal === undefined) {
    throw new Error(`what is written reads: ${JSON.stringify(envelope.header)}`);
  }

  if (!isSame(writeEnvelope(normal, maximumDetailBytes), written)) {
    throw new Error(`what is written back is written as it was: ${JSON.stringify(normal.header)}`);
  }
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const { maximumDetailBytes, maximumEnvelopeBytes } = LIMIT_DEFAULTS;

  for (const failures of [SERVER_FAILURES, CLIENT_FAILURES]) {
    const read = (bytes: Uint8Array): Envelope | undefined => {
      return readEnvelope(bytes, { failures, maximumDetailBytes, maximumEnvelopeBytes });
    };
    let envelope: Envelope | undefined;

    isRefused(FailureError, () => {
      envelope = read(data);
    });

    if (envelope !== undefined) {
      rewrites(envelope, read);
    }

    isRefused(FailureError, () => {
      readFailure(data, { failures, maximumDetailBytes });
    });
  }
};
