import { createHmac, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { type IJwtKey, type JwtAlgorithm, readJwt, verifyJwt } from '../jwt-verifier';
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

/** What reads the wall clock as `instant`: a vector's, or milliseconds since the epoch. */
const readingOf = (instant: number | string): (() => number) => {
  return () => {
    return typeof instant === 'string' ? Date.parse(instant) : instant;
  };
};

// definition

// the vectors play once, as the C# side plays them: a retry would hide what fails there
test.describe.configure({ retries: 0 });

test.describe('verifyJwt', () => {
  test('throws for a key without a string issuer before reading the clock', async () => {
    const { audience, keys, now, token } = HOLDING;
    const key = { ...keys[0], issuer: null } as unknown as IJwtKey;
    let reads = 0;
    const reading = (): number => {
      reads += 1;

      return readingOf(now)();
    };

    for (const presented of ['', token]) {
      await expect(
        verifyJwt(presented, { audience, keys: [...keys, key], now: reading })
      ).rejects.toThrow(ProgrammerError);
      expect(reads).toBe(0);
    }

    expect(await verifyJwt(token, { audience, keys, now: reading })).toMatchObject({ holds: true });
    expect(reads).toBe(1);
  });

  test('refuses an HS256 signature of the wrong byte length before reading the clock', async () => {
    const { audience, keys, now, token } = HOLDING;
    const [header = '', claims = '', encoded = ''] = token.split('.');
    const signature = Buffer.from(encoded, 'base64url');
    let reads = 0;
    const reading = (): number => {
      reads += 1;

      return readingOf(now)();
    };

    expect(signature).toHaveLength(32);

    for (const length of [31, 33]) {
      const bytes = Buffer.alloc(length);

      signature.copy(bytes);

      const malformed = `${header}.${claims}.${bytes.toString('base64url')}`;

      expect(await verifyJwt(malformed, { audience, keys, now: reading })).toEqual({
        holds: false,
        reason: 'signature',
      });
      expect(reads).toBe(0);
    }

    expect(await verifyJwt(token, { audience, keys, now: reading })).toMatchObject({ holds: true });
    expect(reads).toBe(1);
  });

  test('reads unverified JWTs only when all three parts decode', () => {
    const [header = '', claims = ''] = HOLDING.token.split('.');
    const encode = (text: string): string => {
      return Buffer.from(text).toString('base64url');
    };

    for (const token of [
      '',
      'a.b',
      `${header}.${claims}.AA.extra`,
      `${encode('[]')}.${claims}.AA`,
      `${encode('no JSON')}.${claims}.AA`,
      `${header}.${encode('[]')}.AA`,
      `${header}.${encode('no JSON')}.AA`,
      `${header}.${claims}.*`,
    ]) {
      expect(readJwt(token), token).toBeUndefined();
    }

    // * a one-byte signature is readable here: only the verifier judges its signature.
    expect(readJwt(`${header}.${claims}.AA`)).toEqual({
      claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as unknown,
      header: JSON.parse(Buffer.from(header, 'base64url').toString()) as unknown,
    });
  });

  for (const { audience, keys, name, now, token, verdict } of VECTORS.jwtVerdicts) {
    test(`gives each JWT its verdict: ${name}`, async () => {
      expect(await verifyJwt(token, { audience, keys, now: readingOf(now) })).toEqual(verdict);
    });
  }

  test('gives the claims set of a token that holds whole, frozen to its depth', async () => {
    const { audience, keys, now, token } = HOLDING;
    const claims = {
      ...(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as object),
      realm: { roles: ['reader'] },
    };
    const verdict = await verifyJwt(signed(claims), { audience, keys, now: readingOf(now) });

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
    test(`throws for a key not shaped for its algorithm, whatever the token: ${name}`, async () => {
      const key = {
        algorithm: algorithm as JwtAlgorithm,
        issuer: 'https://issuer.example',
        jwk,
      } as IJwtKey;

      await expect(
        verifyJwt('', {
          audience: HOLDING.audience,
          keys: [...HOLDING.keys, key],
          now: readingOf(0),
        })
      ).rejects.toThrow(ProgrammerError);
    });
  }

  test('throws for an audience that is not well-formed Unicode', async () => {
    const { keys, now, token } = HOLDING;

    await expect(
      verifyJwt(token, { audience: '\ud800', keys, now: readingOf(now) })
    ).rejects.toThrow(ProgrammerError);
  });

  test('refuses at key a key whose key_ops holds verify with a lone surrogate', async () => {
    const { audience, now, token } = HOLDING;
    const [key] = HOLDING.keys as [IJwtKey];
    const keys = [{ ...key, jwk: { ...key.jwk, key_ops: ['verify\ud800'] } }];

    expect(await verifyJwt(token, { audience, keys, now: readingOf(now) })).toEqual({
      holds: false,
      reason: 'key',
    });
  });

  test('refuses at crit a token whose header names crit with an escape, whatever a token of its shape held before', async () => {
    const { audience, keys, now, token } = HOLDING;
    const [, claims = '', signature = ''] = token.split('.');
    // * a name drawn per run, so that no header read before in this process has its shape
    const first = `onTheLedge${randomBytes(8).toString('hex')}`;
    const tokenOf = (header: string): string => {
      return `${Buffer.from(header).toString('base64url')}.${claims}.${signature}`;
    };

    // V8 reads the second header's last name as the first's, each of four characters once read, the
    // first holding a backslash
    await verifyJwt(tokenOf(`{"${first}":0,"alg":"HS256","typ":"at+jwt","\\\\u00":1}`), {
      audience,
      keys,
      now: readingOf(now),
    });

    expect(
      await verifyJwt(tokenOf(`{"${first}":0,"alg":"HS256","typ":"at+jwt","\\u0063rit":["exp"]}`), {
        audience,
        keys,
        now: readingOf(now),
      })
    ).toEqual({ holds: false, reason: 'crit' });
  });

  // ! the C# side's reading is a long, which holds no fraction: this side's type does not say so
  test('throws for a reading that is not a whole number of milliseconds', async () => {
    const { audience, keys, now, token } = HOLDING;

    await expect(
      verifyJwt(token, { audience, keys, now: readingOf(Date.parse(now) + 0.5) })
    ).rejects.toThrow(ProgrammerError);
  });

  test('reads the wall clock once the signature verifies, so a verification that waits past a token’s end refuses it at exp', async () => {
    const { audience, keys, now, token } = HOLDING;
    const [header = '', claims = ''] = token.split('.');
    const { exp } = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { exp: number };
    const readings: number[] = [];
    let reading = Date.parse(now);
    const readNow = (): number => {
      readings.push(reading);

      return reading;
    };

    // as it began, it held; it is judged as it ends, its end, exp plus 60 s, reached meanwhile
    const verifying = verifyJwt(token, { audience, keys, now: readNow });

    reading = Math.ceil(exp * 1_000) + 60_000;

    expect(await verifying).toEqual({ holds: false, reason: 'exp' });
    expect(readings).toEqual([reading]);

    // one refused before its signature verified reads nothing
    const forged = `${header}.${claims}.${'A'.repeat(43)}`;

    expect(await verifyJwt(forged, { audience, keys, now: readNow })).toEqual({
      holds: false,
      reason: 'signature',
    });
    expect(readings).toHaveLength(1);
  });
});
