// ── Credentials ───────────────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../../transport/shared/clock';
import { createPromise } from '../../transport/shared/create-promise';
import { ProgrammerError, TimeoutError } from '../../transport/shared/errors';
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
import type { Credential, ICallSession, ICredentials, IJwtKeySet, IRouterLimits } from './types';

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
   * session, or a key set's ask the call waited on that failed; and with a `CancelError` as
   * `signal` aborts while it waits for a key set, whose ask goes on for the others. No rejection
   * carries the credential.
   */
  resolve(request: ICredentialRequest, signal: AbortSignal): Promise<ICallSession | undefined>;
}

/** One ask of a key set for an issuer. */
interface IKeySetAsk {
  /** What aborts its signal at its deadline, while it is unsettled. */
  readonly controller: AbortController;
  /** Settles once the ask answered or failed, never rejecting. */
  readonly done: Promise<void>;
  /** Why it failed, once it did. */
  failure: unknown;
  readonly issuer: string;
  /** Whether it answered or failed: what it settles to after is dropped. */
  isSettled: boolean;
  /** Settles it, failed with `failure`, or answered without one; once alone. */
  readonly settle: (failure?: unknown) => void;
}

/** The calls that wait for an issuer's deadline, and the ask that goes then, which they share. */
interface IDeadlineWait {
  readonly next: PromiseWithResolvers<IKeySetAsk>;
  waiters: number;
}

/** What a side holds of an issuer its key set names. */
interface IIssuerKeys {
  /** The monotonic reading as the keys held were answered. */
  answered: number;
  /** The ask under way, which every call that finds it waits on. */
  asking: IKeySetAsk | undefined;
  /** Before it, on the monotonic reading, no other ask goes for the issuer. */
  deadline: number;
  /** The keys the last answer gave, which serve ten minutes from it. */
  held: readonly IJwtKey[];
  readonly issuer: string;
  /** The deadline's timer, armed while an ask is unsettled or a call waits for the deadline. */
  timer: TimeoutId | undefined;
  /** The calls that wait for the deadline, while any does. */
  waiting: IDeadlineWait | undefined;
}

// constants

/** The least chunk and envelope, in bytes, of a side that takes or presents a `JWT` (spec 12.2). */
export const JWT_LIMIT_BYTES = 1_024;

// how long one ask of a key set keeps another from going for its issuer, its deadline, in
// milliseconds
const KEY_SET_INTERVAL = 60_000;

// how long the keys a key set answered serve, from its answer, in milliseconds
const KEY_SET_HOLD = 600_000;

// the refusals that come before a token's key is looked for: no key set's answer moves them
const BEFORE_KEY: ReadonlySet<JwtRefusal> = new Set([
  JwtRefusal.TOKEN,
  JwtRefusal.CRIT,
  JwtRefusal.TYP,
]);

// what a session's end is, at most, on either side of the epoch (spec 1.2)
const LARGEST_END = Number.MAX_SAFE_INTEGER;

// helpers

/** Whether `audience` is one a `JWT` is held to: a string of well-formed Unicode. */
const isAudience = (audience: unknown): audience is string => {
  return typeof audience === 'string' && audience.isWellFormed();
};

/**
 * The issuers `keySet` answers for, none without one: given with its ask and one issuer at least,
 * each a string; any other is a {@link ProgrammerError}, the application's fault, as the side is
 * built.
 */
const issuersOf = (keySet: IJwtKeySet | undefined): ReadonlySet<string> => {
  if (keySet === undefined) {
    return new Set();
  }

  const { ask, issuers } = keySet as Partial<IJwtKeySet>;

  if (
    typeof ask !== 'function' ||
    !Array.isArray(issuers) ||
    issuers.length === 0 ||
    !issuers.every((issuer) => {
      return typeof issuer === 'string';
    })
  ) {
    throw new ProgrammerError(
      'a key set is given with its ask and the issuers it answers for, one at least, each a string'
    );
  }

  return new Set(issuers);
};

/**
 * The keys a key set's answer gave for `issuer`, each frozen: what is not an array of keys shaped
 * for their algorithms throws a {@link ProgrammerError}, the ask's failure.
 */
const heldOf = (answered: unknown, issuer: string): readonly IJwtKey[] => {
  if (!Array.isArray(answered)) {
    throw new ProgrammerError('a key set answers an array of keys, each with its algorithm');
  }

  return (answered as unknown[]).map((answer) => {
    const { algorithm, jwk } = (answer ?? {}) as Partial<IJwtKey>;
    const key = { algorithm, issuer, jwk } as IJwtKey;

    assertJwtKey(key);

    return Object.freeze(key);
  });
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
 * among the keys given and those its key set answered while they serve; an `ELSEWHERE` asked of its
 * verifier with what its transport carried, its session's end held rounded up, and one the wall
 * clock reached as it settles not holding (section 13.10).
 *
 * The key set is asked for the issuers it names alone, once a minute at most for an issuer, on the
 * monotonic reading: an ask sets that issuer's deadline a minute on, its signal aborting then, and
 * one still unsettled then has failed. Its answer serves ten minutes. A token waits for its issuer's
 * keys while its `kid` names none of them that serve — or, without a `kid`, while those held are
 * past their ten minutes — on the ask under way, else for the deadline and the ask then, shared,
 * else on an ask that goes at once; judged again as that ask answers, it is refused once an ask that
 * went after it came did not name its key. A call's cancel ends its own wait, never the ask. A key
 * not shaped for its algorithm, an audience that is not a string of well-formed Unicode, a key set
 * given without an issuer, and keys or a key set given without an audience, whatever the side's
 * relay does, are each a {@link ProgrammerError}, as the resolver is built.
 */
export const createCredentialResolver = (
  credentials: ICredentials | undefined,
  { clock }: { clock: IClock }
): ICredentialResolver => {
  const { audience, keySet, keys = [], verify } = credentials ?? {};
  const takesJwt = keys.length > 0 || keySet !== undefined;

  for (const key of keys) {
    assertJwtKey(key);
  }

  // what the side holds of each issuer its key set names, compared octet for octet
  const issuers = new Map(
    issuersOf(keySet)
      .values()
      .map((issuer): [string, IIssuerKeys] => {
        return [
          issuer,
          {
            answered: 0,
            asking: undefined,
            deadline: -Infinity,
            held: [],
            issuer,
            timer: undefined,
            waiting: undefined,
          },
        ];
      })
  );

  if (audience !== undefined && !isAudience(audience)) {
    throw new ProgrammerError('an audience is a string of well-formed Unicode');
  }

  // ! keys held to no audience would refuse every JWT SESSION_REQUIRED, which withdraws a client's
  // default: the application's fault, told as the side is built, never charged to a token. A relay
  // that verifies holds its destinations' audiences, but a request to the side itself holds its own
  if (takesJwt && audience === undefined) {
    throw new ProgrammerError("a side given a JWT's keys or a key set is given its audience too");
  }

  // the wall clock's reading, a whole number of milliseconds, a fraction dropped
  const wallNow = (): number => {
    return Math.floor(clock.Date.now());
  };

  // whether the keys an issuer's key set answered serve still: ten minutes from its answer
  const isServing = ({ answered }: IIssuerKeys): boolean => {
    return clock.performance.now() < answered + KEY_SET_HOLD;
  };

  // the keys that serve: the application's, held for good, then those each issuer's key set
  // answered, for their ten minutes
  const keysServing = (): readonly IJwtKey[] => {
    return [
      ...keys,
      ...issuers.values().flatMap((entry) => {
        return isServing(entry) ? entry.held : [];
      }),
    ];
  };

  const disarm = (entry: IIssuerKeys): void => {
    clock.clearTimeout(entry.timer);
    entry.timer = undefined;
  };

  // one ask of the key set for the issuer, at once, setting its deadline a minute on and taking the
  // calls that waited for one: its answer held, or its failure kept, never thrown
  const askNow = (entry: IIssuerKeys): IKeySetAsk => {
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const { waiting } = entry;
    const ask: IKeySetAsk = {
      controller: new AbortController(),
      done,
      failure: undefined,
      issuer: entry.issuer,
      isSettled: false,

      settle: (failure) => {
        if (ask.isSettled) {
          return;
        }

        ask.isSettled = true;
        ask.failure = failure;

        if (entry.asking === ask) {
          entry.asking = undefined;
        }

        if (entry.waiting === undefined) {
          disarm(entry);
        }

        resolve();
      },
    };

    disarm(entry);
    entry.asking = ask;
    entry.deadline = clock.performance.now() + KEY_SET_INTERVAL;
    entry.waiting = undefined;
    arm(entry);
    waiting?.next.resolve(ask);

    // ! a key set that throws as it is asked fails as one that rejects: this function is async
    void (async () => {
      try {
        const answered: unknown = await keySet?.ask(entry.issuer, ask.controller.signal);

        // ! what it settles to once it failed at its deadline is dropped: its keys are never held
        if (ask.isSettled) {
          return;
        }

        entry.held = heldOf(answered, entry.issuer);
        entry.answered = clock.performance.now();
        ask.settle();
      } catch (reason) {
        ask.settle(reason ?? new Error('the key set failed'));
      }
    })();

    return ask;
  };

  // the issuer's deadline: an ask unsettled then has failed, its signal aborted; the calls that
  // wait for it have the next ask go, and none goes for none
  const reachDeadline = (entry: IIssuerKeys): void => {
    const { asking, waiting } = entry;

    entry.timer = undefined;

    if (asking !== undefined) {
      const failure = new TimeoutError(KEY_SET_INTERVAL);

      asking.settle(failure);
      asking.controller.abort(failure);
    }

    if (waiting !== undefined) {
      askNow(entry);
    }
  };

  // the deadline's timer, armed once, its delay rounded up so that it never fires before, a
  // millisecond at least, as every timer Bead arms
  const arm = (entry: IIssuerKeys): void => {
    if (entry.timer !== undefined) {
      return;
    }

    const delay = Math.max(1, Math.ceil(entry.deadline - clock.performance.now()));

    entry.timer = clock.setTimeout(() => {
      reachDeadline(entry);
    }, delay);
    // a browser's timer has no `unref`
    (entry.timer as { unref?: () => unknown }).unref?.();
  };

  // waits on `ask` until it settles, or `signal` aborts: a call's cancel ends its own wait, never the
  // ask the others wait on. Rejects once the ask failed
  const waitOn = async (ask: IKeySetAsk, signal: AbortSignal): Promise<void> => {
    await createPromise(
      (resolve) => {
        void ask.done.then(resolve);
      },
      { signal }
    );

    if (ask.failure !== undefined) {
      throw new Error(`the key set's ask for ${JSON.stringify(ask.issuer)} failed`, {
        cause: ask.failure,
      });
    }
  };

  // waits for the issuer's deadline, and the ask that goes then, shared by every call that waits;
  // the last call that leaves before it leaves no deadline to keep
  const waitForDeadline = async (entry: IIssuerKeys, signal: AbortSignal): Promise<IKeySetAsk> => {
    const waiting = (entry.waiting ??= { next: Promise.withResolvers(), waiters: 0 });

    waiting.waiters += 1;
    arm(entry);

    try {
      return await createPromise<IKeySetAsk>(
        (resolve) => {
          void waiting.next.promise.then(resolve);
        },
        { signal }
      );
    } catch (reason) {
      waiting.waiters -= 1;

      if (waiting.waiters === 0 && entry.waiting === waiting) {
        entry.waiting = undefined;

        if (entry.asking === undefined) {
          disarm(entry);
        }
      }

      throw reason;
    }
  };

  // waits for the issuer's keys: on its ask under way, which went before the call came; else, before
  // its deadline, for the ask that goes then; else on one that goes at once. Whether the ask it
  // waited on went after the call came; rejects once that ask failed
  const awaitKeys = async (entry: IIssuerKeys, signal: AbortSignal): Promise<boolean> => {
    const { asking } = entry;

    if (asking !== undefined) {
      await waitOn(asking, signal);

      return false;
    }

    const ask =
      clock.performance.now() < entry.deadline
        ? await waitForDeadline(entry, signal)
        : askNow(entry);

    await waitOn(ask, signal);

    return true;
  };

  // the issuer whose keys a token waits for: one its key set names, while the token's kid names none
  // of that issuer's keys that serve, whatever another's names — or, without a kid, while those held
  // are past their ten minutes
  const awaitedOf = (token: string): IIssuerKeys | undefined => {
    const read = readJwt(token);
    const issuer = read === undefined ? undefined : jwtStringOf(read.claims, 'iss');
    const entry = issuer === undefined ? undefined : issuers.get(issuer);

    if (read === undefined || entry === undefined) {
      return undefined;
    }

    if (!Object.hasOwn(read.header, 'kid')) {
      return entry.held.length > 0 && !isServing(entry) ? entry : undefined;
    }

    // a kid that is no string names no key, whatever a key set answers
    const kid = jwtStringOf(read.header, 'kid');
    const isNamed = keysServing().some((key) => {
      return key.issuer === entry.issuer && key.jwk.kid === kid;
    });

    return kid === undefined || isNamed ? undefined : entry;
  };

  // a token's verdict against the keys that serve; while it waits for its issuer's keys, it is
  // judged again as each ask it waited on answers, until its key serves or an ask that went after it
  // came answered, the wall clock read as each signature verified
  const verdictOf = async (
    token: string,
    { audiences, signal }: { audiences: string | readonly string[]; signal: AbortSignal }
  ): Promise<JwtVerdict> => {
    const judge = (): Promise<JwtVerdict> => {
      return verifyJwt(token, { audience: audiences, keys: keysServing(), now: wallNow });
    };
    let verdict = await judge();
    // whether an ask that went after the token came answered: the token's last word
    let isLast = false;

    for (;;) {
      const entry =
        isLast || verdict.holds || BEFORE_KEY.has(verdict.reason) ? undefined : awaitedOf(token);

      if (entry === undefined) {
        return verdict;
      }

      isLast = await awaitKeys(entry, signal);
      verdict = await judge();
    }
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
