import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { CancelError, ProgrammerError } from '../../../transport/shared/errors';
import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { CredentialScheme } from '../constants';
import { assertLimitsHoldJwt, createCredentialResolver, JWT_LIMIT_BYTES } from '../credentials';
import type { IJwtKey } from '../jwt-verifier';
import type { IJwtSetKey } from '../types';

// constants

const NOW = Date.parse('2026-01-01T00:00:00Z');
const ISSUER = 'https://issuer.example';
const SET_ISSUER = 'https://keys.example';
const AUDIENCE = 'https://bead.example';

// keys of these tests' own, 32 bytes each, in base64url
const KEY_BYTES = Buffer.alloc(32, 1);
const SET_KEY_BYTES = Buffer.alloc(32, 2);

const KEY: IJwtKey = Object.freeze({
  algorithm: 'HS256',
  issuer: ISSUER,
  jwk: { k: KEY_BYTES.toString('base64url'), kty: 'oct' },
});
const SET_KEY: IJwtSetKey = Object.freeze({
  algorithm: 'HS256',
  jwk: { k: SET_KEY_BYTES.toString('base64url'), kid: 'set-1', kty: 'oct' },
});

// helpers

/** A token of `claims` signed with `key`, its header naming `kid` when given. */
const tokenOf = (
  claims: Record<string, unknown>,
  { key = KEY_BYTES, kid }: { key?: Buffer; kid?: string } = {}
): string => {
  const part = (value: object): string => {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  };
  const signingInput = `${part({ alg: 'HS256', typ: 'at+jwt', ...(kid === undefined ? {} : { kid }) })}.${part(claims)}`;

  return `${signingInput}.${createHmac('sha256', key).update(signingInput).digest('base64url')}`;
};

/** Claims that hold an hour from `NOW`, under `iss`, for `sub`. */
const claimsOf = (iss: string, sub = 'grace'): Record<string, unknown> => {
  return { aud: AUDIENCE, exp: NOW / 1_000 + 3_600, iss, sub };
};

const jwtOf = (token: string) => {
  return { credential: { scheme: CredentialScheme.JWT, token } } as const;
};

/** A key set that records each issuer asked, and answers as each ask is settled. */
const createKeySet = () => {
  const asks: { issuer: string; settle: PromiseWithResolvers<readonly IJwtSetKey[]> }[] = [];

  return {
    asks,
    keySet: (issuer: string) => {
      const settle = Promise.withResolvers<readonly IJwtSetKey[]>();

      asks.push({ issuer, settle });

      return settle.promise;
    },
  };
};

// definition

test.describe('createCredentialResolver', () => {
  test('takes a JWT once given keys or a key set, an ELSEWHERE once given its verifier, and nothing else', () => {
    const clock = createTestClock(NOW);
    const schemesOf = (credentials: Parameters<typeof createCredentialResolver>[0]) => {
      const { schemes, takesJwt } = createCredentialResolver(credentials, { clock });

      return [schemes, takesJwt];
    };

    expect(schemesOf(undefined)).toEqual([[], false]);
    expect(schemesOf({ audience: AUDIENCE })).toEqual([[], false]);
    expect(schemesOf({ audience: AUDIENCE, keys: [KEY] })).toEqual([[CredentialScheme.JWT], true]);
    expect(schemesOf({ audience: AUDIENCE, keySet: createKeySet().keySet })).toEqual([
      [CredentialScheme.JWT],
      true,
    ]);
    expect(
      schemesOf({
        audience: AUDIENCE,
        keys: [KEY],
        verify: () => {
          return Promise.resolve(undefined);
        },
      })
    ).toEqual([[CredentialScheme.JWT, CredentialScheme.ELSEWHERE], true]);
  });

  test('resolves a JWT that verifies to its credential’s session — its claims, its identifier with its scheme, its end exp plus 60 s — and one that does not to none', async () => {
    const clock = createTestClock(NOW);
    const resolver = createCredentialResolver({ audience: AUDIENCE, keys: [KEY] }, { clock });
    const signal = new AbortController().signal;
    const claims = claimsOf(ISSUER);

    const session = await resolver.resolve(jwtOf(tokenOf(claims)), signal);

    expect(session).toEqual({
      data: claims,
      end: NOW + 3_660_000,
      identifier: { issuer: ISSUER, scheme: CredentialScheme.JWT, sub: 'grace' },
    });
    expect(Object.isFrozen(session) && Object.isFrozen(session?.identifier)).toBe(true);
    // another audience, or a set naming none, holds nothing
    expect(
      await resolver.resolve(
        { ...jwtOf(tokenOf({ ...claims, aud: 'https://other.example' })) },
        signal
      )
    ).toBeUndefined();
    expect(
      await resolver.resolve(
        { ...jwtOf(tokenOf(claims)), audience: ['https://other.example'] },
        signal
      )
    ).toBeUndefined();
    expect(
      await resolver.resolve({ ...jwtOf(tokenOf(claims)), audience: [AUDIENCE] }, signal)
    ).toMatchObject({ end: NOW + 3_660_000 });
  });

  test('asks its key set for a kid no key held names, once a minute at most for an issuer, sharing an ask under way and holding its answer until the next', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    // two calls find one ask under way, and wait on it
    const first = resolver.resolve(named, signal);
    const second = resolver.resolve(named, signal);

    await sleep(0);

    expect(
      asks.map(({ issuer }) => {
        return issuer;
      })
    ).toEqual([SET_ISSUER]);

    asks[0]?.settle.resolve([SET_KEY]);

    expect(await first).toMatchObject({ identifier: { issuer: SET_ISSUER, sub: 'grace' } });
    expect(await second).toMatchObject({ identifier: { issuer: SET_ISSUER, sub: 'grace' } });

    // its answer held, no ask goes; a kid none names, within the minute, is refused without one
    expect(await resolver.resolve(named, signal)).toBeDefined();
    expect(await resolver.resolve(unnamed, signal)).toBeUndefined();
    expect(asks).toHaveLength(1);

    // past the minute, on the monotonic reading, a kid none names asks again
    await clock.tickAsync(60_000);

    const again = resolver.resolve(unnamed, signal);

    await sleep(0);
    asks[1]?.settle.resolve([SET_KEY]);

    expect(await again).toBeUndefined();
    expect(
      asks.map(({ issuer }) => {
        return issuer;
      })
    ).toEqual([SET_ISSUER, SET_ISSUER]);
  });

  test('lets a call’s cancel end its own wait, never the ask the others wait on', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const cancelled = new AbortController();
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    const leaving = resolver.resolve(named, cancelled.signal);
    const waiting = resolver.resolve(named, new AbortController().signal);

    await sleep(0);
    cancelled.abort();

    // its wait ends at its cancel, before the ask settles
    await expect(leaving).rejects.toBeInstanceOf(CancelError);

    asks[0]?.settle.resolve([SET_KEY]);

    expect(await waiting).toMatchObject({ identifier: { sub: 'grace' } });
    expect(asks).toHaveLength(1);
  });

  test('fails a call while its issuer’s last ask failed, within the minute, and asks again past it', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    const failing = resolver.resolve(named, signal);

    await sleep(0);
    asks[0]?.settle.reject(new Error('the key set cannot be reached'));

    await expect(failing).rejects.toThrow(/key set/);
    await expect(resolver.resolve(named, signal)).rejects.toThrow(/key set/);
    expect(asks).toHaveLength(1);

    await clock.tickAsync(60_000);

    const again = resolver.resolve(named, signal);

    await sleep(0);
    asks[1]?.settle.resolve([SET_KEY]);

    expect(await again).toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('fails a call alike when its key set throws as it is asked, and asks again past the minute', async () => {
    const clock = createTestClock(NOW);
    let asked = 0;
    const resolver = createCredentialResolver(
      {
        audience: AUDIENCE,
        keySet: () => {
          asked += 1;

          if (asked === 1) {
            throw new Error('the key set cannot be reached');
          }

          return Promise.resolve([SET_KEY]);
        },
      },
      { clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    await expect(resolver.resolve(named, signal)).rejects.toThrow(/key set/);
    await expect(resolver.resolve(named, signal)).rejects.toThrow(/key set/);
    expect(asked).toBe(1);

    await clock.tickAsync(60_000);

    expect(await resolver.resolve(named, signal)).toMatchObject({ identifier: { sub: 'grace' } });
    expect(asked).toBe(2);
  });

  test('counts the keys held toward an issuer’s one key, for a token without a kid', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const kidless = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES }));

    // none held: refused, and no ask goes for a token that names no kid
    expect(await resolver.resolve(kidless, signal)).toBeUndefined();
    expect(asks).toHaveLength(0);

    const named = resolver.resolve(
      jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' })),
      signal
    );

    await sleep(0);
    asks[0]?.settle.resolve([SET_KEY]);
    await named;

    expect(await resolver.resolve(kidless, signal)).toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('asks the ELSEWHERE verifier once with exactly what its transport carried and the call’s signal, and never for one that carried nothing', async () => {
    const clock = createTestClock(NOW);
    const asked: unknown[] = [];
    const controller = new AbortController();
    const resolver = createCredentialResolver(
      {
        verify: (carried, signal) => {
          asked.push([carried, signal]);

          return Promise.resolve({ data: { sub: 'ada' }, id: 'ada' });
        },
      },
      { clock }
    );
    const elsewhere = { scheme: CredentialScheme.ELSEWHERE } as const;

    expect(
      await resolver.resolve(
        { credential: elsewhere, transportCredential: ' \tInterop sub=ada' },
        controller.signal
      )
    ).toEqual({
      data: { sub: 'ada' },
      end: undefined,
      identifier: { id: 'ada', scheme: CredentialScheme.ELSEWHERE },
    });
    expect(await resolver.resolve({ credential: elsewhere }, controller.signal)).toBeUndefined();
    expect(asked).toEqual([[' \tInterop sub=ada', controller.signal]]);
  });

  test('fails a verifier that throws at once as one that rejects', async () => {
    const clock = createTestClock(NOW);
    const resolver = createCredentialResolver(
      {
        verify: (carried) => {
          if (carried === 'throws') {
            throw new Error('this verifier throws');
          }

          return Promise.reject(new Error('this verifier rejects'));
        },
      },
      { clock }
    );
    const signal = new AbortController().signal;
    const credential = { scheme: CredentialScheme.ELSEWHERE } as const;
    // a throw as it is asked is a rejection: the call is never answered in the turn it came
    const throwing = resolver.resolve({ credential, transportCredential: 'throws' }, signal);

    await expect(throwing).rejects.toThrow('this verifier throws');
    await expect(
      resolver.resolve({ credential, transportCredential: 'rejects' }, signal)
    ).rejects.toThrow('this verifier rejects');
  });

  test('fails a session whose end is not a number within 2^53, and one whose id is no string', async () => {
    const clock = createTestClock(NOW);
    const sessions: unknown[] = [
      { id: 7 },
      { end: Number.NaN, id: 'ada' },
      { end: Infinity, id: 'ada' },
      { end: -Infinity, id: 'ada' },
      { end: 2 ** 53, id: 'ada' },
      { end: -(2 ** 53), id: 'ada' },
      { end: '1', id: 'ada' },
      'ada',
    ];
    const resolver = createCredentialResolver(
      {
        verify: (carried) => {
          return Promise.resolve(sessions[Number(carried)] as { id: string });
        },
      },
      { clock }
    );
    const signal = new AbortController().signal;

    for (const [index] of sessions.entries()) {
      await expect(
        resolver.resolve(
          {
            credential: { scheme: CredentialScheme.ELSEWHERE },
            transportCredential: String(index),
          },
          signal
        ),
        String(index)
      ).rejects.toThrow(ProgrammerError);
    }
  });

  test('rounds an end up to a millisecond: half a millisecond past the wall clock holds, and half short does not', async () => {
    const clock = createTestClock(NOW);
    const resolver = createCredentialResolver(
      {
        verify: (carried) => {
          return Promise.resolve({ data: carried, end: NOW + Number(carried), id: 'ada' });
        },
      },
      { clock }
    );
    const signal = new AbortController().signal;
    const resolve = (carried: string) => {
      return resolver.resolve(
        { credential: { scheme: CredentialScheme.ELSEWHERE }, transportCredential: carried },
        signal
      );
    };

    expect(await resolve('0.5')).toMatchObject({ end: NOW + 1 });
    expect(await resolve('-0.5')).toBeUndefined();
    expect(await resolve('0')).toBeUndefined();
    expect(await resolve(String(2 ** 53 - 1 - NOW))).toMatchObject({ end: 2 ** 53 - 1 });
  });

  test('refuses as it is built a key not shaped for its algorithm, and an audience not of well-formed Unicode', () => {
    const clock = createTestClock(NOW);

    expect(() => {
      return createCredentialResolver(
        { keys: [{ ...KEY, jwk: { k: 'A'.repeat(42), kty: 'oct' } }] },
        { clock }
      );
    }).toThrow(ProgrammerError);
    expect(() => {
      return createCredentialResolver({ audience: '\ud800', keys: [KEY] }, { clock });
    }).toThrow(ProgrammerError);
  });

  test('refuses as it is built keys or a key set given without an audience, unless its side’s relay verifies', () => {
    const clock = createTestClock(NOW);
    const { keySet } = createKeySet();

    for (const credentials of [{ keys: [KEY] }, { keySet }]) {
      expect(() => {
        return createCredentialResolver(credentials, { clock });
      }).toThrow(ProgrammerError);
      // a relay that verifies holds the audiences of its destinations instead
      expect(createCredentialResolver(credentials, { clock, relayVerifies: true }).takesJwt).toBe(
        true
      );
    }

    // an ELSEWHERE's verifier needs none
    expect(
      createCredentialResolver(
        {
          verify: () => {
            return Promise.resolve(undefined);
          },
        },
        { clock }
      ).schemes
    ).toEqual([CredentialScheme.ELSEWHERE]);
  });
});

test.describe('assertLimitsHoldJwt', () => {
  test('refuses limits whose chunk or envelope is under 1,024 bytes, and takes them from 1,024', () => {
    expect(JWT_LIMIT_BYTES).toBe(1_024);
    expect(() => {
      assertLimitsHoldJwt({ chunkBytes: 1_023, maximumEnvelopeBytes: 4_096 });
    }).toThrow(/limits do not hold together/);
    expect(() => {
      assertLimitsHoldJwt({ chunkBytes: 1_024, maximumEnvelopeBytes: 1_023 });
    }).toThrow(/limits do not hold together/);
    expect(() => {
      assertLimitsHoldJwt({ chunkBytes: 1_024, maximumEnvelopeBytes: 1_024 });
    }).not.toThrow();
  });
});
