// ── Fuzz target: the JWT verifier ─────────────────────────────────────────────

// Raw bytes as a `JWT`'s token, one character an octet, as the header's reader hands a `JWT`
// credential's bytes on in Latin-1, verified as section 13.8 states it, then read unverified, as a
// relay that does not verify reads it. A token of three parts is verified again with its first two
// signed by the HS256 key below, so a claims set the fuzzer changes reaches the steps past the
// signature. The keys, the audiences and the clock are the JWT verdicts' of spec/vectors.json, each
// well formed: every answer is a verdict, and anything thrown or rejected is a finding. The C#
// side's `JwtTarget` is its twin, with the same keys, audiences and clock.

// dependencies

import { createHmac } from 'node:crypto';

import {
  type IJwtKey,
  JwtAlgorithm,
  readJwt,
  verifyJwt,
} from '../../src/router/shared/jwt-verifier';

// constants

// the HS256 key's secret, in base64url, as its JWK writes it
const SECRET =
  'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow';

// an ES256 key of one issuer, an HS256 key of another, and the HS256 key again under a kid
const KEYS: readonly IJwtKey[] = Object.freeze([
  {
    algorithm: JwtAlgorithm.ES256,
    issuer: 'https://issuer.example',
    jwk: {
      crv: 'P-256',
      kty: 'EC',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    },
  },
  {
    algorithm: JwtAlgorithm.HS256,
    issuer: 'https://trust.example',
    jwk: { k: SECRET, kty: 'oct' },
  },
  {
    algorithm: JwtAlgorithm.HS256,
    issuer: 'https://trust.example',
    jwk: { k: SECRET, kid: 'k1', kty: 'oct' },
  },
]);

const AUDIENCES = Object.freeze(['https://bead.example', 'https://other.example']);

// the wall clock, 2026-10-03T12:01:00.000Z, in milliseconds since the epoch
const NOW = 1_791_028_860_000;

// helpers

const verify = async (token: string): Promise<void> => {
  await verifyJwt(token, {
    audience: AUDIENCES,
    keys: KEYS,
    now: () => {
      return NOW;
    },
  });
};

// `parts`' first two signed by the HS256 key, as an issuer of the trust domain signs them
const signedAgain = ([header = '', claims = '']: readonly string[]): string => {
  const signingInput = `${header}.${claims}`;
  const signature = createHmac('sha256', Buffer.from(SECRET, 'base64url'))
    .update(signingInput, 'latin1')
    .digest('base64url');

  return `${signingInput}.${signature}`;
};

// definition

export const fuzz = async (data: Uint8Array): Promise<void> => {
  const token = Buffer.from(data).toString('latin1');
  const parts = token.split('.');

  await verify(token);
  readJwt(token);

  if (parts.length === 3) {
    await verify(signedAgain(parts));
  }
};
