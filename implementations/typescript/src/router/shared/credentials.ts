// ── Credentials ───────────────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../../transport/shared/clock';
import { ProgrammerError, TimeoutError, toCancelError } from '../../transport/shared/errors';
import { CredentialScheme } from './constants';
import { CapacityError } from './errors';
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
  /**
   * Hears why a credential that does not hold was refused, in the one word an access refused tells
   * (spec 13.12): for a `JWT`, the step of section 13.8 that refused it; for an `ELSEWHERE`,
   * `verifier` when its verifier made no session of it, `end` when its end had come as it settled.
   */
  onRefused?: ((reason: string) => void) | undefined;
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
   * session, or a key set's ask the call waited on that failed; with a {@link CapacityError} when it
   * would wait for its issuer's deadline past the calls its key set lets wait for it, as it comes or
   * as an answer moves it there; and with a `CancelError` as `signal` aborts while it waits for a key
   * set, whose ask goes on for the others.
   * No rejection carries the credential.
   */
  resolve(request: ICredentialRequest, signal: AbortSignal): Promise<ICallSession | undefined>;
}

/**
 * A call that waits for its issuer's keys: on an ask, uncounted, or for the deadline, where it holds
 * its place among those its key set lets wait.
 */
interface IWaiter {
  /** The calls it waits among, its ask's or its deadline's; none once it left them. */
  among: Set<IWaiter> | undefined;
  /** Whether its token's header carries a `kid`. */
  readonly hasKid: boolean;
  /** Whether the ask it waits on went after its token came: that ask's answer is its last word. */
  isAfter: boolean;
  /** Its token's `kid`; none for one that is no string, which names no key. */
  readonly kid: string | undefined;
  /** Settles once it is to be judged again; rejects once its ask failed, or as it leaves. */
  readonly released: PromiseWithResolvers<void>;
}

/** One ask of a key set for an issuer, and the calls that wait on it. */
interface IKeySetAsk {
  /** What aborts its signal as its deadline is reached, while it is unsettled. */
  readonly controller: AbortController;
  /** Whether it answered or failed: what it settles to after is dropped. */
  isSettled: boolean;
  readonly waiters: Set<IWaiter>;
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
  /** The calls that wait for the deadline, and the ask that goes then. */
  next: Set<IWaiter>;
  /** The deadline's timer, armed while an ask is unsettled or a call waits for the deadline. */
  timer: TimeoutId | undefined;
}

/** What an ask settled to: its keys, or why it failed, which fails each call on it. */
type AskOutcome = { failure: Error } | { keys: readonly IJwtKey[] };

// constants

/** The least chunk and envelope, in bytes, of a side that takes or presents a `JWT` (spec 12.2). */
export const JWT_LIMIT_BYTES = 1_024;

// how long one ask of a key set keeps another from going for its issuer, its deadline, in
// milliseconds
const KEY_SET_INTERVAL = 60_000;

// how long the keys a key set answered serve, from its answer, in milliseconds
const KEY_SET_HOLD = 600_000;

// the most calls that wait for one issuer's deadline at once: when its key set does not say, and ever
const KEY_SET_WAITING_CALLS = 64;
const MOST_WAITING_CALLS = 2_147_483_647;

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
 * The issuers `keySet` answers for, none without one, and the most calls that wait for one issuer's
 * deadline at once: given with its ask and one issuer at least, each a string, and that most a whole
 * number from 1 to 2³¹ − 1, 64 when not given; any other is a {@link ProgrammerError}, the
 * application's fault, as the side is built.
 */
const keySetOf = (
  keySet: IJwtKeySet | undefined
): { issuers: ReadonlySet<string>; maximumWaitingCalls: number } => {
  if (keySet === undefined) {
    return { issuers: new Set(), maximumWaitingCalls: KEY_SET_WAITING_CALLS };
  }

  const {
    ask,
    issuers,
    maximumWaitingCalls = KEY_SET_WAITING_CALLS,
  } = keySet as Partial<IJwtKeySet>;

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

  if (
    !Number.isInteger(maximumWaitingCalls) ||
    maximumWaitingCalls < 1 ||
    maximumWaitingCalls > MOST_WAITING_CALLS
  ) {
    throw new ProgrammerError(
      `a key set's maximumWaitingCalls is a whole number from 1 to ${String(MOST_WAITING_CALLS)}, not ${String(maximumWaitingCalls)}`
    );
  }

  return { issuers: new Set(issuers), maximumWaitingCalls };
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
      "the router's limits do not hold together: a side that takes or presents a JWT holds a chunk's envelope and an envelope of 1,024 bytes at least"
    );
  }
};

// definition

/**
 * The resolver of a side's `JWT`s and `ELSEWHERE`s, from its credentials, on its clock: a `JWT`
 * verified as section 13.8 states, the wall clock read as its signature has verified, its key found
 * among the keys given and those its key set answered while they serve; an `ELSEWHERE` asked of its
 * verifier with what its transport carried, its session's end held rounded up, and one the wall
 * clock reached as it settles not holding (section 13.11).
 *
 * The key set is asked for the issuers it names alone, once a minute at most for an issuer, on the
 * monotonic reading: an ask sets that issuer's deadline a minute past the reading at which it goes.
 * The deadline is reached once the reading is at it or past it, wherever that issuer's state is read
 * — as a call comes to wait, as an answer comes, as its timer fires — and never as a call leaves:
 * an ask still unsettled then has failed, its signal aborted, what it settles to dropped, and the
 * calls that waited for the deadline have the next ask go. An answer serves ten minutes. A token
 * refused at its key or past it waits for its issuer's keys while its `kid` names none of them that
 * serve — or, without a `kid`, while none of them serve — on the ask under way, else for the
 * deadline and the ask then, shared, else on an ask that goes at once; as that ask answers, it is
 * judged again once its key serves or the ask went after it came, and waits on for the deadline
 * otherwise. At most `maximumWaitingCalls` wait for one issuer's deadline at once, a call on an ask
 * never counted: one more is refused with a {@link CapacityError}, in the turn it would have waited,
 * as it comes or as an answer moves it there. A call's cancel ends its own wait, never the ask. A
 * key not shaped for its algorithm, an audience that is not a string of well-formed Unicode, a key
 * set given without an issuer or with a `maximumWaitingCalls` out of its bounds, and keys or a key
 * set given without an audience, whatever the side's relay does, are each a
 * {@link ProgrammerError}, as the resolver is built.
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

  const { issuers: named, maximumWaitingCalls } = keySetOf(keySet);
  // what the side holds of each issuer its key set names, compared octet for octet
  const issuers = new Map(
    named.values().map((issuer): [string, IIssuerKeys] => {
      return [
        issuer,
        {
          answered: 0,
          asking: undefined,
          deadline: -Infinity,
          held: [],
          issuer,
          next: new Set(),
          timer: undefined,
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

  // the keys that serve, in the order 13.8's step 4 searches (13.9.4): the application's, held for
  // good, in the order given, then those each issuer's key set answered, in its answer's order, for
  // their ten minutes
  const keysServing = (): readonly IJwtKey[] => {
    return [
      ...keys,
      ...issuers.values().flatMap((entry) => {
        return isServing(entry) ? entry.held : [];
      }),
    ];
  };

  // the keys of an issuer that serve: the application's of that issuer, and those its key set
  // answered, for their ten minutes
  const issuerKeysOf = (entry: IIssuerKeys): readonly IJwtKey[] => {
    return [
      ...keys.filter((key) => {
        return key.issuer === entry.issuer;
      }),
      ...(isServing(entry) ? entry.held : []),
    ];
  };

  // whether a token's key does not serve among `serving`, its issuer's keys, so that it waits for
  // them: its kid names none of them, whatever another's names; without a kid, there are none. A kid
  // that is no string names none, and waits for nothing
  const needs = (
    serving: readonly IJwtKey[],
    { hasKid, kid }: Pick<IWaiter, 'hasKid' | 'kid'>
  ): boolean => {
    if (!hasKid) {
      return serving.length === 0;
    }

    return (
      kid !== undefined &&
      !serving.some((key) => {
        return key.jwk.kid === kid;
      })
    );
  };

  // ! the refusal of a call past the calls its key set lets wait for the deadline, as it comes or as
  // an answer moves it there; never of one on an ask, which the key set's latency bounds, and the
  // ask's deadline
  const refusalOf = ({ issuer, next }: IIssuerKeys): CapacityError | undefined => {
    return next.size < maximumWaitingCalls
      ? undefined
      : new CapacityError(
          `as many calls as its key set lets wait for the deadline of ${issuer} wait already`
        );
  };

  const disarm = (entry: IIssuerKeys): void => {
    clock.clearTimeout(entry.timer);
    entry.timer = undefined;
  };

  // an ask settled: its answer replaces the keys held; its failure replaces none, and fails every
  // call on it. Otherwise each is judged again once its key serves or the ask went after it came,
  // else moves onto the deadline in the order they came, refused once it is full
  const settle = (
    entry: IIssuerKeys,
    { ask, outcome }: { ask: IKeySetAsk; outcome: AskOutcome }
  ): void => {
    ask.isSettled = true;
    entry.asking = undefined;

    if ('keys' in outcome) {
      entry.held = outcome.keys;
      entry.answered = clock.performance.now();
    }

    for (const waiter of ask.waiters) {
      waiter.among = undefined;

      if ('failure' in outcome) {
        waiter.released.reject(outcome.failure);
      } else if (waiter.isAfter || !needs(issuerKeysOf(entry), waiter)) {
        waiter.released.resolve();
      } else {
        const refused = refusalOf(entry);

        if (refused === undefined) {
          waiter.among = entry.next;
          entry.next.add(waiter);
        } else {
          waiter.released.reject(refused);
        }
      }
    }

    ask.waiters.clear();

    if (entry.next.size === 0) {
      disarm(entry);
    }
  };

  // ! a key set that throws as it is asked fails as one that rejects: this function is async. It
  // settles the ask with the answer, unless a deadline that answer reached settled it first
  const answer = async (entry: IIssuerKeys, ask: IKeySetAsk): Promise<void> => {
    let outcome: AskOutcome;

    try {
      const answered: unknown = await keySet?.ask(entry.issuer, ask.controller.signal);

      outcome = { keys: heldOf(answered, entry.issuer) };
    } catch (reason) {
      outcome = {
        failure: new Error(`the key set's ask for ${entry.issuer} failed`, {
          cause: reason ?? new Error('the key set failed'),
        }),
      };
    }

    // ! an answer at its deadline or past it is dropped: its ask failed there, its keys never held
    reach(entry);

    if (!ask.isSettled) {
      settle(entry, { ask, outcome });
    }
  };

  // one ask of the key set for the issuer, at once, for the calls that waited for its deadline and
  // `joining`, each come before it went; its deadline a minute past `now`
  const askNow = (
    entry: IIssuerKeys,
    { joining, now }: { joining?: IWaiter; now: number }
  ): IKeySetAsk => {
    const { next: waiters } = entry;
    const ask: IKeySetAsk = { controller: new AbortController(), isSettled: false, waiters };

    if (joining !== undefined) {
      waiters.add(joining);
    }

    for (const waiter of waiters) {
      waiter.among = waiters;
      waiter.isAfter = true;
    }

    entry.next = new Set();
    disarm(entry);
    entry.asking = ask;
    entry.deadline = now + KEY_SET_INTERVAL;
    arm(entry);
    void answer(entry, ask);

    return ask;
  };

  // the issuer's deadline, once the reading `now` is at it or past it: an ask unsettled then has
  // failed, its signal aborted, and the calls that waited for it have the next ask go, which it
  // gives, and wait on it, holding no place; for none, none goes
  const reach = (
    entry: IIssuerKeys,
    now: number = clock.performance.now()
  ): IKeySetAsk | undefined => {
    if (now < entry.deadline) {
      return undefined;
    }

    const { asking } = entry;

    if (asking !== undefined) {
      const failure = new TimeoutError(
        KEY_SET_INTERVAL,
        `the key set's ask for ${entry.issuer} was unsettled as its deadline was reached`
      );

      settle(entry, { ask: asking, outcome: { failure } });
      asking.controller.abort(failure);
    }

    return entry.next.size === 0 ? undefined : askNow(entry, { now });
  };

  // * the deadline's timer only makes sure the deadline is reached when nothing else reads it: armed
  // once, its delay rounded up, a millisecond at least, as every timer Bead arms; one that fires
  // before the reading reaches the deadline arms again for the rest
  const arm = (entry: IIssuerKeys): void => {
    if (entry.timer !== undefined) {
      return;
    }

    const delay = Math.max(1, Math.ceil(entry.deadline - clock.performance.now()));

    entry.timer = clock.setTimeout(() => {
      entry.timer = undefined;
      reach(entry);

      if (entry.asking !== undefined || entry.next.size > 0) {
        arm(entry);
      }
    }, delay);
    // a browser's timer has no `unref`
    (entry.timer as { unref?: () => unknown }).unref?.();
  };

  // a call that leaves its wait by its own signal reaches nothing: it frees its place, and the last
  // that waited for the deadline leaves no timer behind
  const leave = (entry: IIssuerKeys, waiter: IWaiter): void => {
    const { among } = waiter;

    among?.delete(waiter);
    waiter.among = undefined;

    if (among === entry.next && among.size === 0 && entry.asking === undefined) {
      disarm(entry);
    }
  };

  // a call's wait, until it is to be judged again: its own signal ends it, its alone
  const waitAs = async (
    entry: IIssuerKeys,
    { signal, waiter }: { signal: AbortSignal; waiter: IWaiter }
  ): Promise<void> => {
    const onAbort = (): void => {
      leave(entry, waiter);
      waiter.released.reject(toCancelError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await waiter.released.promise;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  // the wait of a token of an issuer the key set names, in the order 13.9.5 takes: a deadline the
  // reading reached, then whether its key serves, then the bound. None for a token of another issuer,
  // or whose key served when judged; a call that left already reads nothing
  const waitOf = (
    token: string,
    { judged, signal }: { judged: readonly IJwtKey[]; signal: AbortSignal }
  ): Promise<void> | undefined => {
    const read = readJwt(token);
    const issuer = read === undefined ? undefined : jwtStringOf(read.claims, 'iss');
    const entry = issuer === undefined ? undefined : issuers.get(issuer);

    if (read === undefined || entry === undefined) {
      return undefined;
    }

    if (signal.aborted) {
      return Promise.reject(toCancelError(signal));
    }

    const now = clock.performance.now();
    const letGo = reach(entry, now);
    const waiter: IWaiter = {
      among: undefined,
      hasKid: Object.hasOwn(read.header, 'kid'),
      isAfter: false,
      kid: jwtStringOf(read.header, 'kid'),
      released: Promise.withResolvers(),
    };

    // ! a key that came to serve as it was judged, an answer settling meanwhile: it is judged again
    // by the keys that serve, never answered with the refusal it had
    if (!needs(issuerKeysOf(entry), waiter)) {
      // its issuer's keys that served as it was judged
      const served = judged.filter((key) => {
        return key.issuer === entry.issuer;
      });

      return needs(served, waiter) ? Promise.resolve() : undefined;
    }

    const { asking } = entry;

    // on the ask under way, which went before it came unless its own reach let it go; before the
    // deadline, for it and the ask then, past the bound refused; otherwise on an ask that goes at once
    if (asking !== undefined) {
      waiter.among = asking.waiters;
      waiter.isAfter = asking === letGo;
      asking.waiters.add(waiter);
    } else if (now < entry.deadline) {
      const refused = refusalOf(entry);

      if (refused !== undefined) {
        throw refused;
      }

      waiter.among = entry.next;
      entry.next.add(waiter);
      arm(entry);
    } else {
      askNow(entry, { joining: waiter, now });
    }

    return waitAs(entry, { signal, waiter });
  };

  // a token's verdict against the keys that serve, the wall clock read as its signature verified;
  // one refused at its key or past it waits for its issuer's keys while its key does not serve, and
  // is judged again, its last word
  const verdictOf = async (
    token: string,
    { audiences, signal }: { audiences: string | readonly string[]; signal: AbortSignal }
  ): Promise<JwtVerdict> => {
    const judge = (keys: readonly IJwtKey[]): Promise<JwtVerdict> => {
      return verifyJwt(token, { audience: audiences, keys, now: wallNow });
    };
    const judged = keysServing();
    const verdict = await judge(judged);
    const waiting =
      verdict.holds || BEFORE_KEY.has(verdict.reason)
        ? undefined
        : waitOf(token, { judged, signal });

    if (waiting === undefined) {
      return verdict;
    }

    await waiting;

    return judge(keysServing());
  };

  const resolveJwt = async (
    token: string,
    {
      onRefused,
      ...request
    }: {
      audiences: string | readonly string[];
      onRefused: ((reason: string) => void) | undefined;
      signal: AbortSignal;
    }
  ): Promise<ICallSession | undefined> => {
    const verdict = await verdictOf(token, request);

    // refused by the step of section 13.8 that refused it, which an access refused tells
    if (!verdict.holds) {
      return (onRefused?.(verdict.reason), undefined);
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
    {
      onRefused,
      signal,
    }: { onRefused: ((reason: string) => void) | undefined; signal: AbortSignal }
  ): Promise<ICallSession | undefined> => {
    const session: unknown = await verify?.(carried, signal);

    if (session === undefined) {
      return (onRefused?.('verifier'), undefined);
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
      return (onRefused?.('end'), undefined);
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

    resolve: ({ audience: given, credential, onRefused, transportCredential }, signal) => {
      if (credential.scheme === CredentialScheme.JWT && 'token' in credential) {
        return resolveJwt(credential.token, {
          audiences: given ?? audience ?? [],
          onRefused,
          signal,
        });
      }

      if (credential.scheme === CredentialScheme.ELSEWHERE && transportCredential !== undefined) {
        return resolveElsewhere(transportCredential, { onRefused, signal });
      }

      return Promise.resolve(undefined);
    },
  };
};
