// ── Credentials ───────────────────────────────────────────────────────────────

// dependencies

import type { IClock } from '../../transport/shared/clock';
import { createPromise } from '../../transport/shared/create-promise';
import { ProgrammerError } from '../../transport/shared/errors';
import { CredentialScheme } from './constants';
import {
  assertJwtKey,
  type IJwtKey,
  type JwtVerdict,
  JwtRefusal,
  jwtStringOf,
  readJwt,
  verifyJwt,
} from './jwt-verifier';
import type { Credential, ICallSession, ICredentials, IRouterLimits } from './types';

// interfaces

/** A request whose credential a side resolves: what it presents, and what its transport carried. */
export interface ICredentialRequest {
  /**
   * The audience a `JWT` is held to: the side's own when not given; the set a relay that verifies
   * holds, those of its destinations, when given.
   */
  audience?: string | readonly string[] | undefined;
  credential: Credential;
  transportCredential?: string | undefined;
}

/** What a side resolves a `JWT` and an `ELSEWHERE` with, built from its credentials. */
export interface ICredentialResolver {
  /** The credential schemes it takes besides `OPAQUE`: a `JWT`, an `ELSEWHERE`, as it was given. */
  readonly schemes: readonly CredentialScheme[];
  /** Whether it takes a `JWT`: its limits must hold one (spec 12.2). */
  readonly takesJwt: boolean;

  /**
   * The credential's session a request presenting a `JWT` or an `ELSEWHERE` resolves to, frozen —
   * its identifier, its data, its end — or `undefined` when its credential does not hold. Rejects
   * when its verifier fails: an `ELSEWHERE`'s that throws, rejects or settles with what is no
   * session, or a key set whose ask for its issuer failed within the minute; and with a
   * `CancelError` as `signal` aborts while it waits on a key set's ask, which goes on for the
   * others. No rejection carries the credential.
   */
  resolve(request: ICredentialRequest, signal: AbortSignal): Promise<ICallSession | undefined>;
}

/** What a side holds of an issuer its key set was asked for. */
interface IIssuerKeys {
  /** The ask under way, which every call that finds it waits on. */
  asking: Promise<void> | undefined;
  /** Before it, on the monotonic reading, no other ask goes for the issuer. */
  deadline: number;
  /** Why the last ask failed, while it did. */
  failure: unknown;
  /** The keys the last answer gave, held for the issuer until the next. */
  held: readonly IJwtKey[];
}

// constants

/** The least chunk and envelope, in bytes, of a side that takes or presents a `JWT` (spec 12.2). */
export const JWT_LIMIT_BYTES = 1_024;

// how long one ask of a key set keeps another from going for its issuer, in milliseconds
const KEY_SET_INTERVAL = 60_000;

// what a session's end is, at most, on either side of the epoch (spec 1.2)
const LARGEST_END = Number.MAX_SAFE_INTEGER;

// helpers

/** Whether `audience` is one a `JWT` is held to: a string of well-formed Unicode. */
const isAudience = (audience: unknown): audience is string => {
  return typeof audience === 'string' && audience.isWellFormed();
};

/**
 * Throws a {@link ProgrammerError} for limits that do not hold a `JWT`'s header (spec 12.2): a side
 * that takes or presents one sets `chunkBytes` and `maximumEnvelopeBytes` to 1,024 bytes at least.
 */
export const assertLimitsHoldJwt = ({
  chunkBytes,
  maximumEnvelopeBytes,
}: Pick<IRouterLimits, 'chunkBytes' | 'maximumEnvelopeBytes'>): void => {
  if (chunkBytes < JWT_LIMIT_BYTES || maximumEnvelopeBytes < JWT_LIMIT_BYTES) {
    throw new ProgrammerError(
      "the router's limits do not hold together: a side that takes or presents a JWT sets chunkBytes and maximumEnvelopeBytes to 1,024 bytes at least"
    );
  }
};

// definition

/**
 * The resolver of a side's `JWT`s and `ELSEWHERE`s, from its credentials, on its clock: a `JWT`
 * verified as section 13.8 states, the wall clock read as its signature has verified, its key found
 * among the keys given and those its key set answered for its issuer, a key set asked once a minute
 * at most for an issuer, an ask under way shared, and a call's cancel ending its own wait, never the
 * ask; an `ELSEWHERE` asked of its verifier with what its transport carried, its session's end held
 * rounded up, and one the wall clock reached as it settles not holding (section 13.10). A key not
 * shaped for its algorithm, an audience that is not a string of well-formed Unicode, and keys or a
 * key set given without an audience on a side whose relay does not verify — `relayVerifies`, which
 * holds the audiences of its destinations instead — are each a {@link ProgrammerError}, as the
 * resolver is built.
 */
export const createCredentialResolver = (
  credentials: ICredentials | undefined,
  { clock, relayVerifies = false }: { clock: IClock; relayVerifies?: boolean | undefined }
): ICredentialResolver => {
  const { audience, keySet, keys = [], verify } = credentials ?? {};
  const takesJwt = keys.length > 0 || keySet !== undefined;
  // what each issuer its key set was asked for holds
  const issuers = new Map<string, IIssuerKeys>();

  for (const key of keys) {
    assertJwtKey(key);
  }

  if (audience !== undefined && !isAudience(audience)) {
    throw new ProgrammerError('an audience is a string of well-formed Unicode');
  }

  // ! keys held to no audience would refuse every JWT SESSION_REQUIRED, which withdraws a client's
  // default: the application's fault, told as the side is built, never charged to a token
  if (takesJwt && audience === undefined && !relayVerifies) {
    throw new ProgrammerError(
      "a side given a JWT's keys or a key set is given its audience too, unless its relay verifies against those of its destinations"
    );
  }

  // the wall clock's reading, a whole number of milliseconds, a fraction dropped
  const wallNow = (): number => {
    return Math.floor(clock.Date.now());
  };

  // the keys the application gave, then those each issuer's key set answered
  const keysHeld = (): readonly IJwtKey[] => {
    return [
      ...keys,
      ...issuers.values().flatMap(({ held }) => {
        return held;
      }),
    ];
  };

  // one ask of the key set for `issuer`: its answer held in place of the last, or its failure kept,
  // never thrown, so that no call need wait on it for it to be observed
  const ask = async (issuer: string, entry: IIssuerKeys): Promise<void> => {
    try {
      const answered: unknown = await keySet?.(issuer);

      if (!Array.isArray(answered)) {
        throw new ProgrammerError('a key set answers an array of keys, each with its algorithm');
      }

      entry.held = (answered as unknown[]).map((answer) => {
        const { algorithm, jwk } = (answer ?? {}) as Partial<IJwtKey>;
        const key = { algorithm, issuer, jwk } as IJwtKey;

        assertJwtKey(key);

        return Object.freeze(key);
      });
      entry.failure = undefined;
    } catch (reason) {
      entry.failure = reason ?? new Error('the key set failed');
    }
  };

  // the key set's keys for `issuer`, asked once a minute at most: a call that finds an ask under way
  // waits on it, until its signal aborts; within the minute, none goes, and while the last failed,
  // the call fails
  const awaitKeySet = async (issuer: string, signal: AbortSignal): Promise<void> => {
    const now = clock.performance.now();
    let entry = issuers.get(issuer);

    if (entry === undefined || (entry.asking === undefined && now >= entry.deadline)) {
      // an issuer that holds nothing past its minute is forgotten, so tokens naming any issuer
      // keep nothing for long
      for (const [name, kept] of issuers) {
        if (kept.held.length === 0 && kept.asking === undefined && now >= kept.deadline) {
          issuers.delete(name);
        }
      }

      entry ??= { asking: undefined, deadline: 0, failure: undefined, held: [] };
      // ! let go by identity once settled: a key set that throws as it is asked settles before
      // its ask is kept
      const asking = ask(issuer, entry);
      const held = entry;

      held.deadline = now + KEY_SET_INTERVAL;
      held.asking = asking;
      issuers.set(issuer, held);
      void asking.then(() => {
        if (held.asking === asking) {
          held.asking = undefined;
        }
      });
    }

    const { asking } = entry;

    // * a call's cancel ends its own wait, never the ask the others wait on
    if (asking !== undefined) {
      await createPromise(
        (resolve) => {
          void asking.then(resolve);
        },
        { signal }
      );
    }

    if (entry.failure !== undefined) {
      throw new Error(`the key set's last ask for ${JSON.stringify(issuer)} failed`, {
        cause: entry.failure,
      });
    }
  };

  // a token's verdict against the keys held; a `kid` none names asks its issuer's key set, then the
  // token is verified again against what it answered, the wall clock read as each signature verified
  const verdictOf = async (
    token: string,
    { audiences, signal }: { audiences: string | readonly string[]; signal: AbortSignal }
  ): Promise<JwtVerdict> => {
    const verdict = await verifyJwt(token, {
      audience: audiences,
      keys: keysHeld(),
      now: wallNow,
    });

    if (verdict.holds || verdict.reason !== JwtRefusal.KID || keySet === undefined) {
      return verdict;
    }

    const read = readJwt(token);
    const kid = read === undefined ? undefined : jwtStringOf(read.header, 'kid');
    const issuer = read === undefined ? undefined : jwtStringOf(read.claims, 'iss');

    if (
      kid === undefined ||
      issuer === undefined ||
      keysHeld().some(({ jwk }) => {
        return jwk.kid === kid;
      })
    ) {
      return verdict;
    }

    await awaitKeySet(issuer, signal);

    return verifyJwt(token, { audience: audiences, keys: keysHeld(), now: wallNow });
  };

  const resolveJwt = async (
    token: string,
    request: { audiences: string | readonly string[]; signal: AbortSignal }
  ): Promise<ICallSession | undefined> => {
    const verdict = await verdictOf(token, request);

    if (!verdict.holds) {
      return undefined;
    }

    const { claims, end, identifier } = verdict;

    return Object.freeze({
      data: claims,
      end,
      identifier: Object.freeze({ ...identifier, scheme: CredentialScheme.JWT }),
    });
  };

  // ! a verifier that throws as it is asked fails as one that rejects: this function is async
  const resolveElsewhere = async (
    carried: string,
    signal: AbortSignal
  ): Promise<ICallSession | undefined> => {
    const session: unknown = await verify?.(carried, signal);

    if (session === undefined) {
      return undefined;
    }

    const { data, end, id } = (session ?? {}) as { data?: unknown; end?: unknown; id?: unknown };

    if (typeof id !== 'string') {
      throw new ProgrammerError(
        "an ELSEWHERE's verifier settles with a session whose id is a string"
      );
    }

    if (
      end !== undefined &&
      !(typeof end === 'number' && Number.isFinite(end) && Math.abs(end) <= LARGEST_END)
    ) {
      throw new ProgrammerError(
        `an ELSEWHERE's verifier settles with a session whose end is a number of milliseconds within ±${String(LARGEST_END)}`
      );
    }

    const held = end === undefined ? undefined : Math.ceil(end);

    // the wall clock read as the verifier settles: a session whose end it reached does not hold
    if (held !== undefined && wallNow() >= held) {
      return undefined;
    }

    return Object.freeze({
      data,
      end: held,
      identifier: Object.freeze({ id, scheme: CredentialScheme.ELSEWHERE }),
    });
  };

  return {
    schemes: Object.freeze([
      ...(takesJwt ? [CredentialScheme.JWT] : []),
      ...(verify === undefined ? [] : [CredentialScheme.ELSEWHERE]),
    ]),
    takesJwt,

    resolve: ({ audience: given, credential, transportCredential }, signal) => {
      if (credential.scheme === CredentialScheme.JWT && 'token' in credential) {
        return resolveJwt(credential.token, { audiences: given ?? audience ?? [], signal });
      }

      if (credential.scheme === CredentialScheme.ELSEWHERE && transportCredential !== undefined) {
        return resolveElsewhere(transportCredential, signal);
      }

      return Promise.resolve(undefined);
    },
  };
};
