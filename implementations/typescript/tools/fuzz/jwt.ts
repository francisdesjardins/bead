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
import { readFileSync } from 'node:fs';

import {
  type IJwtKey,
  JwtAlgorithm,
  readJwt,
  verifyJwt,
} from '../../src/router/shared/jwt-verifier';

// types

/** A key as spec/vectors.json's JWT verdicts write it. */
interface IVectorKey {
  algorithm: string;
  issuer: string;
  jwk: Record<string, string>;
}

// constants

// ! the published test keys are read from spec/vectors.json, which tools/fuzz.mjs names in
// BEAD_VECTORS: no file but spec/, the tests and the interop service writes one out
const VECTORS = process.env['BEAD_VECTORS'];

if (VECTORS === undefined) {
  throw new Error('BEAD_VECTORS names spec/vectors.json: run this target by tools/fuzz.mjs');
}

const VECTOR_KEYS = (
  JSON.parse(readFileSync(VECTORS, 'utf8')) as { jwtVerdicts: { keys: IVectorKey[] }[] }
).jwtVerdicts.flatMap(({ keys }) => {
  return keys;
});

// the first key of `issuer` under `algorithm` and no kid, as the verdicts write it
const vectorKeyOf = (issuer: string, algorithm: string): IVectorKey => {
  const found = VECTOR_KEYS.find((key) => {
    return key.issuer === issuer && key.algorithm === algorithm && key.jwk['kid'] === undefined;
  });

  if (found === undefined) {
    throw new Error(`spec/vectors.json holds no ${algorithm} key of ${issuer}`);
  }

  return found;
};

const ES256 = vectorKeyOf('https://issuer.example', 'ES256');
const HS256 = vectorKeyOf('https://trust.example', 'HS256');

// the HS256 key's secret, in base64url, as its JWK writes it
const SECRET = HS256.jwk['k'] ?? '';

// an ES256 key of one issuer, an HS256 key of another, and the HS256 key again under a kid
const KEYS: readonly IJwtKey[] = Object.freeze([
  { algorithm: JwtAlgorithm.ES256, issuer: ES256.issuer, jwk: ES256.jwk },
  { algorithm: JwtAlgorithm.HS256, issuer: HS256.issuer, jwk: HS256.jwk },
  { algorithm: JwtAlgorithm.HS256, issuer: HS256.issuer, jwk: { ...HS256.jwk, kid: 'k1' } },
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
