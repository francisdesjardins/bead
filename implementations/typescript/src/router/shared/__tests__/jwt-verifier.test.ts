import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { type IJwtKey, type JwtAlgorithm, verifyJwt } from '../jwt-verifier';
import { VECTORS } from './vectors';

// helpers

// a vector that holds, whose HS256 key signs the tokens these tests write
const HOLDING = (() => {
  const vector = VECTORS.jwtVerdicts.find(({ name }) => {
    return name === 'sub alone, named by sub';
  });

  if (vector === undefined) {
    throw new Error('no vector "sub alone, named by sub" in jwtVerdicts');
  }

  return vector;
})();

// 32 zero bytes, and 31, in base64url
const BYTES_32 = 'A'.repeat(43);
const BYTES_31 = 'A'.repeat(42);

// keys not shaped for their algorithm, each by its JWK's JSON
const UNSHAPED: Record<string, { algorithm: string; jwk: unknown }> = {
  'an ES256 key whose kty is oct': { algorithm: 'ES256', jwk: { k: BYTES_32, kty: 'oct' } },
  'an ES256 key on P-384': {
    algorithm: 'ES256',
    jwk: { crv: 'P-384', kty: 'EC', x: BYTES_32, y: BYTES_32 },
  },
  'an ES256 key whose x is 31 bytes': {
    algorithm: 'ES256',
    jwk: { crv: 'P-256', kty: 'EC', x: BYTES_31, y: BYTES_32 },
  },
  'an ES256 key whose y is no base64url': {
    algorithm: 'ES256',
    jwk: { crv: 'P-256', kty: 'EC', x: BYTES_32, y: 'y=' },
  },
  'an HS256 key whose kty is EC': {
    algorithm: 'HS256',
    jwk: { crv: 'P-256', kty: 'EC', x: BYTES_32, y: BYTES_32 },
  },
  'an HS256 key of 31 bytes': { algorithm: 'HS256', jwk: { k: BYTES_31, kty: 'oct' } },
  'an HS256 key with no k': { algorithm: 'HS256', jwk: { kty: 'oct' } },
  'a key whose kid is a number': { algorithm: 'HS256', jwk: { k: BYTES_32, kid: 7, kty: 'oct' } },
  'a key of an algorithm neither ES256 nor HS256': {
    algorithm: 'RS256',
    jwk: { k: BYTES_32, kty: 'oct' },
  },
  'a JWK that is not an object': { algorithm: 'HS256', jwk: [] },
};

/** A token of `claims` under the published HS256 key the vectors give its issuer. */
const signed = (claims: object): string => {
  const [{ jwk }] = HOLDING.keys as [IJwtKey];
  const part = (value: object): string => {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  };
  const signingInput = `${part({ alg: 'HS256', typ: 'at+jwt' })}.${part(claims)}`;
  const signature = createHmac('sha256', Buffer.from(jwk.k ?? '', 'base64url')).update(
    signingInput
  );

  return `${signingInput}.${signature.digest('base64url')}`;
};

// definition

// the vectors play once, as the C# side plays them: a retry would hide what fails there
test.describe.configure({ retries: 0 });

test.describe('verifyJwt', () => {
  for (const { audience, keys, name, now, token, verdict } of VECTORS.jwtVerdicts) {
    test(`give ${name} its verdict`, async () => {
      expect(await verifyJwt(token, { audience, keys, now: Date.parse(now) })).toEqual(verdict);
    });
  }

  test('give the claims set of a token that holds whole, frozen to its depth', async () => {
    const { audience, keys, now, token } = HOLDING;
    const claims = {
      ...(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as object),
      realm: { roles: ['reader'] },
    };
    const verdict = await verifyJwt(signed(claims), { audience, keys, now: Date.parse(now) });

    if (!verdict.holds) {
      throw new Error(`the token does not hold: ${verdict.reason}`);
    }

    const realm = verdict.claims['realm'] as { roles: string[] };

    expect(verdict.claims).toEqual(claims);
    expect(
      [verdict, verdict.claims, verdict.identifier, realm, realm.roles].every(Object.isFrozen)
    ).toBe(true);
  });

  for (const [name, { algorithm, jwk }] of Object.entries(UNSHAPED)) {
    test(`throw a ProgrammerError for ${name}, whatever the token`, async () => {
      const key = {
        algorithm: algorithm as JwtAlgorithm,
        issuer: 'https://issuer.example',
        jwk,
      } as IJwtKey;

      await expect(
        verifyJwt('', { audience: HOLDING.audience, keys: [...HOLDING.keys, key], now: 0 })
      ).rejects.toThrow(ProgrammerError);
    });
  }

  test('throw a ProgrammerError for an audience that is not well-formed Unicode', async () => {
    const { keys, now, token } = HOLDING;

    await expect(
      verifyJwt(token, { audience: '\ud800', keys, now: Date.parse(now) })
    ).rejects.toThrow(ProgrammerError);
  });

  // ! the C# side's reading is a long, which holds no fraction: this side's type does not say so
  test('throw a ProgrammerError for a reading that is not a whole number of milliseconds', async () => {
    const { audience, keys, now, token } = HOLDING;

    await expect(verifyJwt(token, { audience, keys, now: Date.parse(now) + 0.5 })).rejects.toThrow(
      ProgrammerError
    );
  });
});
