import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { IClock } from '../../../transport/shared/clock';
import { CancelError, ProgrammerError, TimeoutError } from '../../../transport/shared/errors';
import {
  createTestClock,
  duesOn,
  type TestClock,
} from '../../../transport/shared/__tests__/fixtures';
import { CredentialScheme } from '../constants';
import {
  assertLimitsHoldJwt,
  createCredentialResolver,
  type ICredentialResolver,
  JWT_LIMIT_BYTES,
} from '../credentials';
import { CapacityError } from '../errors';
import type { IJwtKey } from '../jwt-verifier';
import type { ICallSession, IJwtKeySet, IJwtSetKey } from '../types';

// constants

const NOW = Date.parse('2026-01-01T00:00:00Z');
const ISSUER = 'https://issuer.example';
const SET_ISSUER = 'https://keys.example';
const OTHER_SET_ISSUER = 'https://other-keys.example';
const TOO_SMALL_FOR_A_JWT =
  "the router's limits do not hold together: a side that takes or presents a JWT holds a chunk's envelope and an envelope of 1,024 bytes at least";
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
// the material of KEY, of the key set's issuer, under a kid of the application's
const APP_KEY: IJwtKey = Object.freeze({
  algorithm: 'HS256',
  issuer: SET_ISSUER,
  jwk: { k: KEY_BYTES.toString('base64url'), kid: 'app-1', kty: 'oct' },
});
// the same key under the kid the key set's first answer does not name
const SET_KEY_2: IJwtSetKey = Object.freeze({
  algorithm: 'HS256',
  jwk: { k: SET_KEY_BYTES.toString('base64url'), kid: 'set-2', kty: 'oct' },
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

/** A key set for {@link SET_ISSUER} that records each ask and its signal, and answers as each is settled. */
const createKeySet = () => {
  const asks: {
    issuer: string;
    settle: PromiseWithResolvers<readonly IJwtSetKey[]>;
    signal: AbortSignal;
  }[] = [];
  const keySet: IJwtKeySet = {
    ask: (issuer, signal) => {
      const settle = Promise.withResolvers<readonly IJwtSetKey[]>();

      asks.push({ issuer, settle, signal });

      return settle.promise;
    },
    issuers: [SET_ISSUER],
  };

  return { asks, keySet };
};

/**
 * `clock`, its monotonic reading `lag` milliseconds past the test clock's, which fires its timers by
 * its own: a test moves the reading past a due without the timer firing, as a late timer does.
 */
const createLateClock = (clock: TestClock): { clock: IClock; lag: number } => {
  const base: IClock = clock;
  const late: { clock: IClock; lag: number } = {
    clock: {
      Date: base.Date,
      performance: {
        now: () => {
          return base.performance.now() + late.lag;
        },
      },
      clearInterval: (timer) => {
        base.clearInterval(timer);
      },
      clearTimeout: (timer) => {
        base.clearTimeout(timer);
      },
      setInterval: (callback, delay) => {
        return base.setInterval(callback, delay);
      },
      setTimeout: (callback, delay) => {
        return base.setTimeout(callback, delay);
      },
    },
    lag: 0,
  };

  return late;
};

/** Has `resolver` hold {@link SET_KEY} for {@link SET_ISSUER}: a call naming set-1, and its ask's answer. */
const heldOn = async (
  resolver: ICredentialResolver,
  asks: ReturnType<typeof createKeySet>['asks']
): Promise<void> => {
  const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
  const first = resolver.resolve(named, new AbortController().signal);

  await expect
    .poll(() => {
      return asks.length;
    })
    .toBe(1);
  asks[0]?.settle.resolve([SET_KEY]);

  expect(await first).toMatchObject({ identifier: { sub: 'grace' } });
};

/** What `resolution` settled to, once it did: its session, none, or its reason; `'waiting'` before. */
const outcomeOf = (resolution: Promise<unknown>): { current: unknown } => {
  const outcome: { current: unknown } = { current: 'waiting' };

  void resolution.then(
    (session) => {
      outcome.current = session;
    },
    (reason: unknown) => {
      outcome.current = reason;
    }
  );

  return outcome;
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

  test('asks its key set once a minute at most for an issuer, sharing an ask under way: a kid none names within the minute waits for the deadline and the ask then, refused once its answer does not name it', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    // two calls find one ask under way, and wait on it
    const first = resolver.resolve(named, signal);
    const second = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([SET_KEY]);

    expect(await first).toMatchObject({ identifier: { issuer: SET_ISSUER, sub: 'grace' } });
    expect(await second).toMatchObject({ identifier: { issuer: SET_ISSUER, sub: 'grace' } });

    // its answer held, no ask goes; a kid none names waits for the deadline, a minute after the
    // ask went, on the monotonic reading
    expect(await resolver.resolve(named, signal)).toBeDefined();

    const unknown = outcomeOf(resolver.resolve(unnamed, signal));

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);
    await clock.tickAsync(59_999);

    expect([unknown.current, asks.length]).toEqual(['waiting', 1]);

    // the ask goes at the deadline, for the issuer, and its answer names no set-2
    await clock.tickAsync(1);

    expect(
      asks.map(({ issuer }) => {
        return issuer;
      })
    ).toEqual([SET_ISSUER, SET_ISSUER]);

    asks[1]?.settle.resolve([SET_KEY]);

    await expect
      .poll(() => {
        return unknown.current;
      })
      .toBeUndefined();
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

  test('fails the calls that wait on an ask that rejects, and has a token within the minute wait for the deadline and the ask then', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    const failing = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.reject(new Error('the key set cannot be reached'));

    await expect(failing).rejects.toThrow(/key set/);

    // within the minute, the next waits for the deadline, asking nothing before it
    const next = outcomeOf(resolver.resolve(named, signal));

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);

    expect([next.current, asks.length]).toEqual(['waiting', 1]);

    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(2);

    asks[1]?.settle.resolve([SET_KEY]);

    await expect
      .poll(() => {
        return next.current;
      })
      .toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('fails a call alike when its key set throws as it is asked, and has the next within the minute wait for the deadline and the ask then', async () => {
    const clock = createTestClock(NOW);
    let asked = 0;
    const resolver = createCredentialResolver(
      {
        audience: AUDIENCE,
        keySet: {
          ask: () => {
            asked += 1;

            if (asked === 1) {
              throw new Error('the key set cannot be reached');
            }

            return Promise.resolve([SET_KEY]);
          },
          issuers: [SET_ISSUER],
        },
      },
      { clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    await expect(resolver.resolve(named, signal)).rejects.toThrow(/key set/);

    const next = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);

    expect(asked).toBe(1);

    await clock.tickAsync(60_000);

    expect(await next).toMatchObject({ identifier: { sub: 'grace' } });
    expect(asked).toBe(2);
  });

  test('aborts the signal it gives its key set’s ask at the ask’s deadline, a minute after it went, and not before, failing the calls that wait on it', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const waiting = outcomeOf(resolver.resolve(named, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    await clock.tickAsync(59_999);

    expect([asks[0]?.signal.aborted, waiting.current]).toEqual([false, 'waiting']);

    // unsettled at its deadline, it has failed, whatever it does with its signal
    await clock.tickAsync(1);

    expect(asks[0]?.signal.aborted).toBe(true);

    await expect
      .poll(() => {
        return (waiting.current as Error | undefined)?.message;
      })
      .toBe(`the key set's ask for ${SET_ISSUER} was unsettled as its deadline was reached`);
    expect(waiting.current).toBeInstanceOf(TimeoutError);

    // the next ask goes at once, its own signal live
    const next = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);

    expect(asks[1]?.signal.aborted).toBe(false);

    asks[1]?.settle.resolve([SET_KEY]);

    expect(await next).toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('drops what an ask settles to after its deadline: its keys are never held', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const late = outcomeOf(resolver.resolve(named, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    await clock.tickAsync(60_000);
    await expect
      .poll(() => {
        return (late.current as Error | undefined)?.message;
      })
      .toMatch(/key set/);

    asks[0]?.settle.resolve([SET_KEY]);
    await sleep(0);

    // nothing held: a token of that kid asks anew, and holds only once that ask names it
    const again = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);
    asks[1]?.settle.resolve([]);

    expect(await again).toBeUndefined();
  });

  test('has a token without a kid wait on a new ask once the keys held for its issuer are past their ten minutes, a millisecond either side', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const kidless = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES }));
    const first = resolver.resolve(
      jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' })),
      signal
    );

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([SET_KEY]);
    await first;
    await clock.tickAsync(599_999);

    // a millisecond short of ten minutes from the answer, its keys serve: no ask
    expect(await resolver.resolve(kidless, signal)).toMatchObject({ identifier: { sub: 'grace' } });
    expect(asks).toHaveLength(1);

    // ten minutes from it, they serve no more: the token waits on a new ask, which serves anew
    await clock.tickAsync(1);

    const stale = resolver.resolve(kidless, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);
    asks[1]?.settle.resolve([SET_KEY]);

    expect(await stale).toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('refuses at once, asking nothing, a token of an issuer its key set does not name, the application’s own among them, whose kid another issuer’s held key names', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet, keys: [KEY] },
      { clock }
    );
    const signal = new AbortController().signal;
    const first = resolver.resolve(
      jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' })),
      signal
    );

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([SET_KEY]);

    expect(await first).toMatchObject({ identifier: { issuer: SET_ISSUER } });

    // set-1 is held for the key set's issuer alone: each of these is judged by the keys there are
    for (const issuer of ['https://other.example', ISSUER]) {
      for (const key of [SET_KEY_BYTES, KEY_BYTES]) {
        expect(
          await resolver.resolve(jwtOf(tokenOf(claimsOf(issuer), { key, kid: 'set-1' })), signal)
        ).toBeUndefined();
      }
    }

    expect(asks).toHaveLength(1);
  });

  test('judges a token again when its key comes to serve during its first judgment, never answering the refusal it had before', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    // the wall clock runs what the test gives it as it is next read, once: as a token's signature
    // has verified, its first judgment under way
    const onRead: { current: (() => void) | undefined } = { current: undefined };
    const reading: IClock = {
      ...clock,
      Date: {
        now: () => {
          const read = onRead.current;

          onRead.current = undefined;
          read?.();

          return clock.Date.now();
        },
      },
    };
    // set-1 names the application's key of another issuer too: a token of the key set's issuer
    // naming it verifies by that key, and is refused at its iss while its own does not serve
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet, keys: [{ ...SET_KEY, issuer: ISSUER }] },
      { clock: reading }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const first = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);

    // the answer naming set-1 settles as the next is judged: its key serves once it is refused,
    // and it is judged again by the keys that serve
    onRead.current = () => {
      asks[0]?.settle.resolve([SET_KEY]);
    };

    expect(await resolver.resolve(named, signal)).toMatchObject({
      identifier: { issuer: SET_ISSUER, sub: 'grace' },
    });
    expect(await first).toMatchObject({ identifier: { issuer: SET_ISSUER, sub: 'grace' } });
    expect([onRead.current, asks.length]).toEqual([undefined, 1]);
  });

  test('has a token without a kid wait on its issuer’s keys at a cold start, and counts the keys held toward its issuer’s one key', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const kidless = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES }));

    // none of its issuer's keys serve: it waits on an ask that goes at once
    const first = resolver.resolve(kidless, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([SET_KEY]);

    expect(await first).toMatchObject({ identifier: { sub: 'grace' } });
    expect(await resolver.resolve(kidless, signal)).toMatchObject({ identifier: { sub: 'grace' } });
    expect(asks).toHaveLength(1);
  });

  test('has a token without a kid wait for nothing when its issuer has a key of the application’s, and for the deadline and the ask then after an answer that gave its issuer none', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet: { ...keySet, issuers: [SET_ISSUER, ISSUER] }, keys: [KEY] },
      { clock }
    );
    const signal = new AbortController().signal;
    const kidless = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES }));

    // the application's key of its issuer serves: refused at its signature, asking nothing
    expect(
      await resolver.resolve(jwtOf(tokenOf(claimsOf(ISSUER), { key: SET_KEY_BYTES })), signal)
    ).toBeUndefined();
    expect(asks).toHaveLength(0);

    // an answer that gives its issuer no key refuses the token that set it off
    const cold = resolver.resolve(kidless, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([]);

    expect(await cold).toBeUndefined();

    // the next, within the minute, waits for the deadline and the ask then, never refused at once
    const next = outcomeOf(resolver.resolve(kidless, signal));

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);
    await clock.tickAsync(59_999);

    expect([next.current, asks.length]).toEqual(['waiting', 1]);

    await clock.tickAsync(1);

    expect(asks).toHaveLength(2);

    asks[1]?.settle.resolve([SET_KEY]);

    await expect
      .poll(() => {
        return next.current;
      })
      .toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('takes the application’s copy of a key its key set answers again beside another, under its kid, and refuses a token without a kid there', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet, keys: [APP_KEY] },
      { clock }
    );
    const signal = new AbortController().signal;
    const first = resolver.resolve(
      jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' })),
      signal
    );

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    // the application's key again, which does not serve, beside another of its issuer
    asks[0]?.settle.resolve([{ algorithm: 'HS256', jwk: { ...APP_KEY.jwk, use: 'enc' } }, SET_KEY]);

    expect(await first).toMatchObject({ identifier: { sub: 'grace' } });
    expect(
      await resolver.resolve(jwtOf(tokenOf(claimsOf(SET_ISSUER), { kid: 'app-1' })), signal)
    ).toMatchObject({ identifier: { sub: 'grace' } });

    // its issuer has keys of two materials: refused at once, waiting for nothing
    expect(await resolver.resolve(jwtOf(tokenOf(claimsOf(SET_ISSUER))), signal)).toBeUndefined();
    expect(asks).toHaveLength(1);
  });

  test('takes a token without a kid once its key set answers the application’s key alone again, under another kid', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet, keys: [APP_KEY] },
      { clock }
    );
    const signal = new AbortController().signal;
    const first = resolver.resolve(jwtOf(tokenOf(claimsOf(SET_ISSUER), { kid: 'app-2' })), signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    asks[0]?.settle.resolve([{ algorithm: 'HS256', jwk: { ...APP_KEY.jwk, kid: 'app-2' } }]);

    expect(await first).toMatchObject({ identifier: { sub: 'grace' } });

    for (const kid of ['app-1', 'app-2', undefined]) {
      expect(
        await resolver.resolve(
          jwtOf(tokenOf(claimsOf(SET_ISSUER), kid === undefined ? {} : { kid })),
          signal
        )
      ).toMatchObject({ identifier: { sub: 'grace' } });
    }

    expect(asks).toHaveLength(1);
  });

  test('refuses as it is built a key set whose maximumWaitingCalls is not a whole number from 1 to 2147483647, and takes either bound', () => {
    const clock = createTestClock(NOW);
    const { keySet } = createKeySet();
    const resolverOf = (maximumWaitingCalls: unknown) => {
      return createCredentialResolver(
        {
          audience: AUDIENCE,
          keySet: { ...keySet, maximumWaitingCalls } as unknown as IJwtKeySet,
        },
        { clock }
      );
    };

    for (const maximumWaitingCalls of [0, -1, 1.5, 2 ** 31, Number.NaN, Infinity, '2', null]) {
      expect(() => {
        return resolverOf(maximumWaitingCalls);
      }, String(maximumWaitingCalls)).toThrow(ProgrammerError);
    }

    for (const maximumWaitingCalls of [1, 2 ** 31 - 1, undefined]) {
      expect(resolverOf(maximumWaitingCalls).takesJwt, String(maximumWaitingCalls)).toBe(true);
    }
  });

  test('lets as many calls wait for an issuer’s deadline as maximumWaitingCalls says, 64 when not given, and refuses one more CAPACITY_EXCEEDED at once, asking nothing more', async () => {
    const signal = new AbortController().signal;
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    for (const [maximumWaitingCalls, most] of [
      [undefined, 64],
      [3, 3],
    ] as const) {
      const clock = createTestClock(NOW);
      const { asks, keySet } = createKeySet();
      const resolver = createCredentialResolver(
        {
          audience: AUDIENCE,
          keySet: {
            ...keySet,
            ...(maximumWaitingCalls === undefined ? {} : { maximumWaitingCalls }),
          },
        },
        { clock }
      );

      await heldOn(resolver, asks);

      const outcomes = Array.from({ length: most + 1 }, () => {
        return outcomeOf(resolver.resolve(unnamed, signal));
      });
      const refused = () => {
        return outcomes.filter(({ current }) => {
          return current instanceof CapacityError;
        });
      };

      // whichever came last to wait for the deadline, as the others wait for it
      await expect.poll(refused).toHaveLength(1);

      expect(refused()[0]?.current).toMatchObject({
        message: `as many calls as its key set lets wait for the deadline of ${SET_ISSUER} wait already`,
      });
      expect(
        outcomes.filter(({ current }) => {
          return current === 'waiting';
        })
      ).toHaveLength(most);
      expect(asks).toHaveLength(1);

      // the ask at the deadline names set-2: those that waited are verified
      await clock.tickAsync(60_000);

      expect(asks).toHaveLength(2);

      asks[1]?.settle.resolve([SET_KEY, SET_KEY_2]);

      await expect
        .poll(() => {
          return outcomes.filter(({ current }) => {
            return (current as ICallSession | undefined)?.identifier !== undefined;
          }).length;
        })
        .toBe(most);
    }
  });

  test('lets every call that waits on an ask under way wait, however many: 65 valid tokens at a cold start, and 65 at the ten-minute mark, all verified', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    // 64 wait for a deadline at most, the key set saying nothing
    const resolver = createCredentialResolver({ audience: AUDIENCE, keySet }, { clock });
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));

    // at a cold start, then once the keys held are past their ten minutes: no key serves, and every
    // call waits on the one ask the first sets off, none refused
    for (const [round, held] of [
      ['cold start', 0],
      ['ten-minute mark', 600_000],
    ] as const) {
      await clock.tickAsync(held);

      const outcomes = Array.from({ length: 65 }, () => {
        return outcomeOf(resolver.resolve(named, signal));
      });

      await expect
        .poll(
          () => {
            return asks.length;
          },
          { message: round }
        )
        .toBe(held === 0 ? 1 : 2);
      // ! refused at its key as it is first judged, which no await comes before: one turn lets every
      // call reach its wait
      await sleep(0);

      expect(
        outcomes.filter(({ current }) => {
          return current === 'waiting';
        }),
        round
      ).toHaveLength(65);

      asks.at(-1)?.settle.resolve([SET_KEY]);

      await expect
        .poll(
          () => {
            return outcomes.filter(({ current }) => {
              return current === 'waiting';
            }).length;
          },
          { message: round }
        )
        .toBe(0);

      for (const { current } of outcomes) {
        expect(current, round).toMatchObject({ identifier: { sub: 'grace' } });
      }
    }
  });

  test('refuses CAPACITY_EXCEEDED a call an answer moves onto a deadline that holds as many as its key set lets wait', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet: { ...keySet, maximumWaitingCalls: 2 } },
      { clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    // the ask goes for a kid it names; three kids none names come while it is under way, which went
    // before they came, and wait on it, uncounted
    const first = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);

    const outcomes = Array.from({ length: 3 }, () => {
      return outcomeOf(resolver.resolve(unnamed, signal));
    });

    await sleep(0);

    expect(
      outcomes.map(({ current }) => {
        return current;
      })
    ).toEqual(['waiting', 'waiting', 'waiting']);

    // its answer names no set-2: the first two it moves onto the deadline take its places, and the
    // third is refused as it moves
    asks[0]?.settle.resolve([SET_KEY]);

    expect(await first).toMatchObject({ identifier: { sub: 'grace' } });
    await expect
      .poll(() => {
        return outcomes.map(({ current }) => {
          return current instanceof CapacityError ? current.message : current;
        });
      })
      .toEqual([
        'waiting',
        'waiting',
        `as many calls as its key set lets wait for the deadline of ${SET_ISSUER} wait already`,
      ]);
    expect([asks.length, duesOn(clock)]).toEqual([1, [60_000]]);

    // at the deadline the two wait on the ask then, whose answer names set-2
    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(2);

    asks[1]?.settle.resolve([SET_KEY, SET_KEY_2]);

    await expect
      .poll(() => {
        return outcomes.filter(({ current }) => {
          return (current as ICallSession | undefined)?.identifier !== undefined;
        }).length;
      })
      .toBe(2);
  });

  test('gives a call a place as an answer moves it from its issuer’s ask onto the deadline, refusing one that comes past the bound then, and frees it as the call leaves', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet: { ...keySet, maximumWaitingCalls: 1 } },
      { clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));
    // the ask goes for a call that leaves: the ask goes on, for a token that comes to find it
    const leaving = new AbortController();
    const left = outcomeOf(resolver.resolve(named, leaving.signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    leaving.abort();
    await expect
      .poll(() => {
        return left.current;
      })
      .toBeInstanceOf(CancelError);

    // a kid none names finds the ask under way, which went before it came, and waits on it
    const moving = new AbortController();
    const moved = outcomeOf(resolver.resolve(unnamed, moving.signal));

    // its answer names no set-2: it moves onto the deadline, taking its one place, and the next that
    // comes is refused
    asks[0]?.settle.resolve([SET_KEY]);
    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);

    expect(moved.current).toBe('waiting');
    await expect(resolver.resolve(unnamed, signal)).rejects.toBeInstanceOf(CapacityError);

    // gone, it frees its place: the next waits in it
    moving.abort();
    await expect
      .poll(() => {
        return moved.current;
      })
      .toBeInstanceOf(CancelError);

    const next = outcomeOf(resolver.resolve(unnamed, signal));

    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(2);

    asks[1]?.settle.resolve([SET_KEY, SET_KEY_2]);

    await expect
      .poll(() => {
        return next.current;
      })
      .toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('counts the calls that wait for each issuer’s deadline apart', async () => {
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      {
        audience: AUDIENCE,
        keySet: { ...keySet, issuers: [SET_ISSUER, OTHER_SET_ISSUER], maximumWaitingCalls: 1 },
      },
      { clock }
    );
    const signal = new AbortController().signal;
    const issuers = [SET_ISSUER, OTHER_SET_ISSUER];
    const tokenFor = (issuer: string, kid: string) => {
      return jwtOf(tokenOf(claimsOf(issuer), { key: SET_KEY_BYTES, kid }));
    };
    // each issuer's keys held, from an ask of its own
    const held = issuers.map((issuer) => {
      return resolver.resolve(tokenFor(issuer, 'set-1'), signal);
    });

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);

    for (const ask of asks) {
      ask.settle.resolve([SET_KEY]);
    }

    expect(await Promise.all(held)).toMatchObject([
      { identifier: { issuer: SET_ISSUER } },
      { identifier: { issuer: OTHER_SET_ISSUER } },
    ]);

    // one of each waits for its issuer's deadline, whatever the other's holds; one more of each is
    // refused
    const waiting = issuers.map((issuer) => {
      return resolver.resolve(tokenFor(issuer, 'set-2'), signal);
    });

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000, 60_000]);

    for (const issuer of issuers) {
      await expect(resolver.resolve(tokenFor(issuer, 'set-2'), signal)).rejects.toBeInstanceOf(
        CapacityError
      );
    }

    // at the deadlines, each issuer's ask names set-2
    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(4);

    for (const ask of asks.slice(2)) {
      ask.settle.resolve([SET_KEY, SET_KEY_2]);
    }

    expect(await Promise.all(waiting)).toMatchObject([
      { identifier: { issuer: SET_ISSUER } },
      { identifier: { issuer: OTHER_SET_ISSUER } },
    ]);
  });

  test('lets a call that comes past a deadline its timer has yet to reach, for which as many calls wait as the key set lets, let the ask go for them and wait on it with them, never refused', async () => {
    const clock = createTestClock(NOW);
    const late = createLateClock(clock);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet: { ...keySet, maximumWaitingCalls: 2 } },
      { clock: late.clock }
    );
    const signal = new AbortController().signal;
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    await heldOn(resolver, asks);

    // two wait for the deadline, the third refused
    const outcomes = Array.from({ length: 3 }, () => {
      return outcomeOf(resolver.resolve(unnamed, signal));
    });

    await expect
      .poll(() => {
        return outcomes.some(({ current }) => {
          return current instanceof CapacityError;
        });
      })
      .toBe(true);

    // the reading reaches the deadline, its timer yet to fire: the call that comes lets the ask go for
    // the two, and waits on it with them, uncounted
    await clock.tickAsync(59_999);
    late.lag = 1;

    const coming = outcomeOf(resolver.resolve(unnamed, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);
    await sleep(0);

    expect(coming.current).toBe('waiting');

    // the late timer does nothing more
    await clock.tickAsync(1);

    expect(asks).toHaveLength(2);

    asks[1]?.settle.resolve([SET_KEY, SET_KEY_2]);

    await expect
      .poll(() => {
        return [...outcomes, coming].filter(({ current }) => {
          return (current as ICallSession | undefined)?.identifier !== undefined;
        }).length;
      })
      .toBe(3);
  });

  test('drops an answer that comes as the reading reaches its ask’s deadline, its timer yet to fire: the calls that wait on it fail, nothing is held, and the late timer does nothing more', async () => {
    const clock = createTestClock(NOW);
    const late = createLateClock(clock);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet },
      { clock: late.clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const waiting = outcomeOf(resolver.resolve(named, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    await clock.tickAsync(59_999);
    late.lag = 1;
    asks[0]?.settle.resolve([SET_KEY]);

    await expect
      .poll(() => {
        return (waiting.current as Error | undefined)?.message;
      })
      .toMatch(/key set/);

    expect([asks[0]?.signal.aborted, duesOn(clock)]).toEqual([true, []]);

    await clock.tickAsync(1);

    // nothing held: the next asks anew, and holds once that ask names its kid
    const next = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);
    asks[1]?.settle.resolve([]);

    expect(await next).toBeUndefined();
  });

  test('fails an ask still unsettled as a call comes past its deadline, its timer yet to fire, aborting its signal, and judges that call by a new ask with a live signal; the late timer does nothing more', async () => {
    const clock = createTestClock(NOW);
    const late = createLateClock(clock);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet },
      { clock: late.clock }
    );
    const signal = new AbortController().signal;
    const named = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-1' }));
    const doomed = outcomeOf(resolver.resolve(named, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(1);
    await clock.tickAsync(59_999);
    late.lag = 1;

    const coming = resolver.resolve(named, signal);

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);

    expect([asks[0]?.signal.aborted, asks[1]?.signal.aborted]).toEqual([true, false]);
    await expect
      .poll(() => {
        return (doomed.current as Error | undefined)?.message;
      })
      .toMatch(/key set/);
    // the new ask's deadline, a minute past the reading at which it went, alone
    expect(duesOn(clock)).toEqual([60_000]);

    asks[1]?.settle.resolve([SET_KEY]);

    expect(await coming).toMatchObject({ identifier: { sub: 'grace' } });

    await clock.tickAsync(1);
    asks[0]?.settle.resolve([]);
    await sleep(0);

    expect(asks).toHaveLength(2);
    expect(await resolver.resolve(named, signal)).toMatchObject({ identifier: { sub: 'grace' } });
  });

  test('lets the deadline’s ask go as a call comes past it, its timer yet to fire, and refuses that call at once once that ask’s answer does not name its kid; the late timer does nothing more', async () => {
    const clock = createTestClock(NOW);
    const late = createLateClock(clock);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet },
      { clock: late.clock }
    );
    const signal = new AbortController().signal;
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    await heldOn(resolver, asks);

    const waiting = outcomeOf(resolver.resolve(unnamed, signal));

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);
    await clock.tickAsync(59_999);
    late.lag = 1;

    // its coming lets the ask go, after it came: that answer is its last word
    const coming = outcomeOf(resolver.resolve(unnamed, signal));

    await expect
      .poll(() => {
        return asks.length;
      })
      .toBe(2);
    asks[1]?.settle.resolve([SET_KEY]);

    await expect
      .poll(() => {
        return [waiting.current, coming.current];
      })
      .toEqual([undefined, undefined]);

    expect(duesOn(clock)).toEqual([]);

    await clock.tickAsync(1);

    expect(asks).toHaveLength(2);
  });

  test('lets no ask go as the last call that waits for a deadline leaves past it, its timer yet to fire, then or as the timer fires', async () => {
    const clock = createTestClock(NOW);
    const late = createLateClock(clock);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet },
      { clock: late.clock }
    );
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));
    const leaving = new AbortController();

    await heldOn(resolver, asks);

    const left = outcomeOf(resolver.resolve(unnamed, leaving.signal));

    await expect
      .poll(() => {
        return duesOn(clock);
      })
      .toEqual([60_000]);

    // a timer that fires a millisecond before the reading reaches the deadline does nothing, and
    // waits on for the rest
    late.lag = -1;
    await clock.tickAsync(60_000);

    expect([left.current, asks.length, duesOn(clock)]).toEqual(['waiting', 1, [1]]);

    // the reading at the deadline, that timer yet to fire, the last call leaves
    late.lag = 0;
    leaving.abort();

    await expect
      .poll(() => {
        return left.current;
      })
      .toBeInstanceOf(CancelError);

    expect([asks.length, duesOn(clock)]).toEqual([1, []]);

    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(1);
  });

  test('frees the place of each call that leaves its wait: 10,000 that leave as their connection closes wait again, none refused, and no ask goes at a deadline none waits for', async () => {
    test.setTimeout(60_000);

    const most = 10_000;
    const clock = createTestClock(NOW);
    const { asks, keySet } = createKeySet();
    const resolver = createCredentialResolver(
      { audience: AUDIENCE, keySet: { ...keySet, maximumWaitingCalls: most } },
      { clock }
    );
    const unnamed = jwtOf(tokenOf(claimsOf(SET_ISSUER), { key: SET_KEY_BYTES, kid: 'set-2' }));

    await heldOn(resolver, asks);

    // twice: as many wait for the deadline as the bound lets, the one more refused, and all leave
    for (const round of ['first', 'second']) {
      const connection = new AbortController();
      const outcomes = Array.from({ length: most + 1 }, () => {
        return outcomeOf(resolver.resolve(unnamed, connection.signal));
      });

      await expect
        .poll(
          () => {
            return outcomes.filter(({ current }) => {
              return current instanceof CapacityError;
            }).length;
          },
          { message: round, timeout: 30_000 }
        )
        .toBe(1);

      expect(
        outcomes.filter(({ current }) => {
          return current === 'waiting';
        }),
        round
      ).toHaveLength(most);

      connection.abort();

      await expect
        .poll(() => {
          return outcomes.filter(({ current }) => {
            return current instanceof CancelError;
          }).length;
        })
        .toBe(most);
    }

    expect(duesOn(clock)).toEqual([]);

    await clock.tickAsync(60_000);

    expect(asks).toHaveLength(1);
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

  test('refuses as it is built a key set given no issuer, or one that is no string', () => {
    const clock = createTestClock(NOW);
    const { keySet } = createKeySet();

    for (const issuers of [[], [7], [SET_ISSUER, undefined], undefined]) {
      expect(() => {
        return createCredentialResolver(
          { audience: AUDIENCE, keySet: { ...keySet, issuers } as unknown as IJwtKeySet },
          { clock }
        );
      }, String(issuers)).toThrow(ProgrammerError);
    }

    expect(createCredentialResolver({ audience: AUDIENCE, keySet }, { clock }).schemes).toEqual([
      CredentialScheme.JWT,
    ]);
  });

  test('refuses as it is built keys or a key set given without an audience', () => {
    const clock = createTestClock(NOW);
    const { keySet } = createKeySet();

    for (const credentials of [{ keys: [KEY] }, { keySet }]) {
      expect(() => {
        return createCredentialResolver(credentials, { clock });
      }).toThrow(ProgrammerError);
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
    }).toThrow(new ProgrammerError(TOO_SMALL_FOR_A_JWT));
    expect(() => {
      assertLimitsHoldJwt({ chunkBytes: 1_024, maximumEnvelopeBytes: 1_023 });
    }).toThrow(new ProgrammerError(TOO_SMALL_FOR_A_JWT));
    expect(() => {
      assertLimitsHoldJwt({ chunkBytes: 1_024, maximumEnvelopeBytes: 1_024 });
    }).not.toThrow();
  });
});
