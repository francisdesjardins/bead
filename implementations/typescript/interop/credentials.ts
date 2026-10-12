// ── Interop service, its credentials ──────────────────────────────────────────

// What the interop server of Bead's TypeScript implementation resolves a request's credential with,
// as `spec/interop-service.json` states it: its `JWT` keys, its audience, its key set, and its
// `ELSEWHERE` verifier. Every implementation's interop server reads the same file.

// dependencies

import { existsSync, readFileSync } from 'node:fs';
import { LIMIT_DEFAULTS } from '../src/router/shared/constants';
import { JWT_LIMIT_BYTES } from '../src/router/shared/credentials';
import type { IJwtKey } from '../src/router/shared/jwt-verifier';
import type {
  ICredentials,
  IElsewhereSession,
  IJwtSetKey,
  RouterLimitsOptions,
} from '../src/router/shared/types';
import type { IClock } from '../src/transport/shared/clock';

// interfaces

/** The interop service's relay and credentials, as its file states them. */
interface IInteropService {
  credentials: {
    jwt: {
      audience: string;
      keySet: {
        issuers: { issuer: string; keys: IJwtSetKey[] }[];
        maximumWaitingCalls: number;
      };
      keys: IJwtKey[];
    };
  };
}

// constants

// a file of spec/, found up from this module, wherever a bundle put it
const specFileOf = (name: string): URL => {
  for (let directory = new URL('./', import.meta.url); ; directory = new URL('../', directory)) {
    const candidate = new URL(`spec/${name}`, directory);

    if (existsSync(candidate)) {
      return candidate;
    }

    if (new URL('../', directory).href === directory.href) {
      throw new Error(`no spec/${name} above this module`);
    }
  }
};

/** The interop service's relay and credentials, which the interop servers of every implementation read. */
export const INTEROP_SERVICE = JSON.parse(
  readFileSync(specFileOf('interop-service.json'), 'utf8')
) as IInteropService;

// how long the key set takes to answer, on the server's clock, so a conversation sees each ask
const KEY_SET_MILLISECONDS = 1_000;

// the key set's issuers that answer otherwise than with their keys at every ask: one whose key is
// withdrawn after its first ask, and one whose ask never settles
const ROTATED_ISSUER = 'https://rotated.interop.bead.example';
const STALLED_ISSUER = 'https://stalled.interop.bead.example';

// the ELSEWHERE verifier's words, once its auth-scheme, compared without regard to case, is read
// (RFC 9110 §11.1): a holding value, or a failing one, each parameter's case its own (RFC 7405)
const ELSEWHERE_SCHEME = 'interop ';
const ELSEWHERE_HOLDING =
  /^sub=(?<sub>[a-z]{1,32})(?:, after=(?<after>[1-9][0-9]{0,9}))?(?:, end=(?<end>[1-9][0-9]{0,15}))?$/u;
const ELSEWHERE_FAILING = /^fail=true(?:, after=(?<after>[1-9][0-9]{0,9}))?$/u;

// the bounds of its numbers: a delay a timer holds (spec 1.4), an instant every side holds (1.2)
const LONGEST_AFTER = 2 ** 31 - 1;
const LATEST_END = Number.MAX_SAFE_INTEGER;

// helpers

/** Settles with `value` once `milliseconds` passed on `clock`, or at once without them. */
const afterOn = <Value>(
  clock: IClock,
  { milliseconds, value }: { milliseconds: number | undefined; value: () => Value }
): Promise<Value> => {
  if (milliseconds === undefined) {
    return Promise.resolve().then(value);
  }

  return new Promise((resolve) => {
    clock.setTimeout(() => {
      resolve(Promise.resolve().then(value));
    }, milliseconds);
  });
};

// definition

/**
 * The interop service's `ELSEWHERE` verifier, on `clock`, as `credentials.elsewhere` words it: a
 * holding value settles with the session of its `sub`, its data `{ sub }` frozen as a `JWT`'s claims
 * set is, and its `end` when it gives one; a failing value rejects; either once its `after` passed on
 * `clock`, whatever its signal, or at once without it; anything else settles with none.
 */
export const interopVerifierOf = (
  clock: IClock
): ((carried: string) => Promise<IElsewhereSession | undefined>) => {
  return (carried) => {
    const words =
      carried.slice(0, ELSEWHERE_SCHEME.length).toLowerCase() === ELSEWHERE_SCHEME
        ? carried.slice(ELSEWHERE_SCHEME.length)
        : '';
    const holding = ELSEWHERE_HOLDING.exec(words)?.groups;
    const failing = ELSEWHERE_FAILING.exec(words)?.groups;
    const after = Number(holding?.['after'] ?? failing?.['after'] ?? 0) || undefined;
    const end = holding?.['end'] === undefined ? undefined : Number(holding['end']);
    const sub = holding?.['sub'];

    if ((after ?? 0) > LONGEST_AFTER || (end ?? 0) > LATEST_END) {
      return Promise.resolve(undefined);
    }

    if (failing !== undefined) {
      return afterOn(clock, {
        milliseconds: after,
        value: () => {
          throw new Error('this verifier fails, on purpose');
        },
      });
    }

    if (sub === undefined) {
      return Promise.resolve(undefined);
    }

    return afterOn(clock, {
      milliseconds: after,
      value: () => {
        return Object.freeze({
          data: Object.freeze({ sub }),
          id: sub,
          ...(end === undefined ? {} : { end }),
        });
      },
    });
  };
};

/**
 * What the interop server resolves a request's credential with, on `clock`, as `credentials` in
 * its file says: its `JWT` keys, its audience and its key set, with the most calls that wait
 * for one issuer's keys, but under limits that hold no `JWT` (spec 12.2); and its `ELSEWHERE`
 * verifier. The key set answers for its file's issuers, each once a second passed on `clock`,
 * whatever its signal: the rotated one its keys at its first ask, counted per key set, so per
 * server, and none after; the stalled one never, arming no timer; any other, the kid-less one among
 * them, its keys at every ask. Asked for an issuer its file does not name, it fails at once.
 */
export const interopCredentialsOf = (clock: IClock, limits?: RouterLimitsOptions): ICredentials => {
  const { audience, keySet, keys } = INTEROP_SERVICE.credentials.jwt;
  const chunkBytes = limits?.chunkBytes ?? LIMIT_DEFAULTS.chunkBytes;
  const maximumEnvelopeBytes = limits?.maximumEnvelopeBytes ?? LIMIT_DEFAULTS.maximumEnvelopeBytes;
  const verify = interopVerifierOf(clock);
  // the rotated issuer's asks, so far
  let rotatedAsks = 0;

  if (chunkBytes < JWT_LIMIT_BYTES || maximumEnvelopeBytes < JWT_LIMIT_BYTES) {
    return { verify };
  }

  return {
    audience,
    keySet: {
      ask: (issuer) => {
        const named = keySet.issuers.find((answering) => {
          return answering.issuer === issuer;
        });

        if (named === undefined) {
          return Promise.reject(new Error(`the interop key set answers for no issuer ${issuer}`));
        }

        if (issuer === STALLED_ISSUER) {
          return Promise.withResolvers<IJwtSetKey[]>().promise;
        }

        rotatedAsks += issuer === ROTATED_ISSUER ? 1 : 0;

        const isWithdrawn = issuer === ROTATED_ISSUER && rotatedAsks > 1;

        return afterOn(clock, {
          milliseconds: KEY_SET_MILLISECONDS,
          value: () => {
            return isWithdrawn ? [] : named.keys;
          },
        });
      },
      issuers: keySet.issuers.map(({ issuer }) => {
        return issuer;
      }),
      maximumWaitingCalls: keySet.maximumWaitingCalls,
    },
    keys,
    verify,
  };
};
