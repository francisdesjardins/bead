// ── Interop service, offered ──────────────────────────────────────────────────

// The procedures of Bead's interop service, `spec/interop-service.json`, as Bead's TypeScript implementation offers them:
// what a client of any implementation calls, and what `spec/conversations.json` plays against.

// dependencies

import { existsSync, readFileSync } from 'node:fs';
import type { IDestinationRegistration } from '../src/router/server/types';
import { sessionKeyOf } from '../src/router/shared/call-session';
import { CredentialScheme, LIMIT_DEFAULTS } from '../src/router/shared/constants';
import { JWT_LIMIT_BYTES } from '../src/router/shared/credentials';
import type { IJwtKey } from '../src/router/shared/jwt-verifier';
import type {
  IBeforeRequest,
  ICallSession,
  ICredentials,
  IElsewhereSession,
  IJwtSetKey,
  IProcedure,
  IServiceManager,
  RouterLimitsOptions,
  ServerConnectionHandle,
  SessionIdentifier,
} from '../src/router/shared/types';
import type { IServer, IServerTransportLike } from '../src/server/types';
import type { TransportServerConnectionHandle } from '../src/transport/server/types';
import { assertHeldFinite, type IClock } from '../src/transport/shared/clock';

// interfaces

/** The interop service, as its manifest names it. */
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
  procedures: { offeredBy?: 'client'; procedureId: number; procedureName: string }[];
  serviceId: number;
  serviceRevision: number;
}

// constants

// the manifest, found up from this module, wherever a bundle put it
const MANIFEST = ((): URL => {
  for (let directory = new URL('./', import.meta.url); ; directory = new URL('../', directory)) {
    const candidate = new URL('spec/interop-service.json', directory);

    if (existsSync(candidate)) {
      return candidate;
    }

    if (new URL('../', directory).href === directory.href) {
      throw new Error('no spec/interop-service.json above this module');
    }
  }
})();

/** The manifest the interop servers of every implementation read. */
export const INTEROP_SERVICE = JSON.parse(readFileSync(MANIFEST, 'utf8')) as IInteropService;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What the interop service's payloads are: JSON, in UTF-8. What is not JSON throws. */
export const JSON_SERIALIZER = Object.freeze({
  decode: (bytes: Uint8Array): unknown => {
    return JSON.parse(decoder.decode(bytes));
  },
  encode: (value: unknown): Uint8Array => {
    return encoder.encode(JSON.stringify(value));
  },
});

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

/**
 * A duration a payload gives, in milliseconds, held as spec 1.4 holds one given: rounded, and
 * refused under a millisecond or past 2³¹ − 1, as given, by a throw its server answers with
 * PROCEDURE_FAILED. `undefined` when not given; JSON writes no never, so a number past the ceiling,
 * `Infinity` once parsed, is refused too.
 */
const durationOf = (name: string, given: unknown): number | undefined => {
  return given === undefined ? undefined : assertHeldFinite(name, given);
};

/** The name a call's session holds: the one `login` gave, or the `sub` of a credential's data. */
const nameOf = (session: ICallSession | undefined): unknown => {
  if (session?.identifier === undefined) {
    return session?.data ?? null;
  }

  return (session.data as { sub?: unknown } | undefined)?.sub ?? null;
};

/**
 * The identifier `endSession` names: `{"issuer":i,"sub":s}` or `{"issuer":i,"sid":s}`, a `JWT`'s;
 * `{"id":d}`, an `ELSEWHERE`'s; of these members alone, each a string. Anything else throws, which
 * its server answers with PROCEDURE_FAILED and reports.
 */
const identifierOf = (request: unknown): SessionIdentifier => {
  const named = (
    typeof request === 'object' && request !== null && !Array.isArray(request) ? request : {}
  ) as Record<string, unknown>;
  const names = Object.keys(named).toSorted().join(',');
  const { id, issuer, sid, sub } = named;

  if (names === 'issuer,sub' && typeof issuer === 'string' && typeof sub === 'string') {
    return { issuer, scheme: CredentialScheme.JWT, sub };
  }

  if (names === 'issuer,sid' && typeof issuer === 'string' && typeof sid === 'string') {
    return { issuer, scheme: CredentialScheme.JWT, sid };
  }

  if (names === 'id' && typeof id === 'string') {
    return { id, scheme: CredentialScheme.ELSEWHERE };
  }

  throw new Error(
    'endSession names a session by {"issuer","sub"}, {"issuer","sid"} or {"id"} alone'
  );
};

/**
 * The issuer `endSessionsOf` names: `{"issuer":i}`, of this member alone, a string. Anything else
 * throws, which its server answers with PROCEDURE_FAILED and reports.
 */
export const issuerOf = (request: unknown): string => {
  const named = (
    typeof request === 'object' && request !== null && !Array.isArray(request) ? request : {}
  ) as Record<string, unknown>;
  const { issuer } = named;

  if (Object.keys(named).join(',') !== 'issuer' || typeof issuer !== 'string') {
    throw new Error('endSessionsOf names an issuer by {"issuer"} alone, a string');
  }

  return issuer;
};

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

/** The procedure of the interop service named `procedureName`. */
export const procedureOf = (procedureName: string): IProcedure => {
  const found = INTEROP_SERVICE.procedures.find((procedure) => {
    return procedure.procedureName === procedureName;
  });

  if (found === undefined) {
    throw new Error(`the interop service has no procedure ${procedureName}`);
  }

  return {
    procedureId: found.procedureId,
    procedureName,
    serviceId: INTEROP_SERVICE.serviceId,
    serviceRevision: INTEROP_SERVICE.serviceRevision,
  };
};

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
 * its manifest says: its `JWT` keys, its audience and its key set, with the most calls that wait
 * for one issuer's keys, but under limits that hold no `JWT` (spec 12.2); and its `ELSEWHERE`
 * verifier. The key set answers for the manifest's issuers, each once a second passed on `clock`,
 * whatever its signal: the rotated one its keys at its first ask, counted per key set, so per
 * server, and none after; the stalled one never, arming no timer; any other, the kid-less one among
 * them, its keys at every ask. Asked for an issuer the manifest does not name, it fails at once.
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

// definition

/** A `ticks` answer held: the ticks it waits for still, and what lets it answer, then says it did. */
interface IHold {
  release: () => Promise<void>;
  remaining: number;
}

/** What `ticks` reads and writes, its notifications included: JSON, in UTF-8. */
export const JSON_NOTIFIED = Object.freeze({
  ...JSON_SERIALIZER,
  encodeNotification: JSON_SERIALIZER.encode,
});

/** The question `ask` puts to its client's `clock`, and how long it waits for the answer. */
const QUESTION = 'What time is it where you are?';
const CLOCK_MILLISECONDS = 10_000;

/** What the interop service needs of a server: its services, its failures, and its sessions. */
export type InteropServer = Pick<
  IServer<IServerTransportLike, string>,
  'requireSession' | 'router' | 'services' | 'sessions'
>;

/**
 * Registers the interop service's resolvers on `server`. The calls to `slow` each connection
 * cancelled are counted per connection, for `cancellations` to answer; a connection's session holds
 * the name its `login` gave, whatever its call presents, and `whoami` answers the name its call's
 * session holds, a credential's `sub`; `ticks` and `tick` hold per connection and per session, its
 * connection's or a credential's; the destination each connection registered last is kept past its
 * close, for `unregister` to take out from whichever connection takes its handle next. Its relay
 * and its credentials are its server's, as it was built.
 */
export const offerInterop = (server: InteropServer): void => {
  const { requireSession, router, services, sessions } = server;
  const { failures } = router;
  const cancellations = new Map<TransportServerConnectionHandle, number>();
  // by connection, the destination it registered last
  const destinations = new Map<TransportServerConnectionHandle, IDestinationRegistration>();
  // by connection and session, the ticks answers held, in the order they came
  const holds = new Map<string, IHold[]>();
  const clock = services.getCommand(procedureOf('clock'), { serializer: JSON_SERIALIZER });
  const nobody: IBeforeRequest<TransportServerConnectionHandle> = Object.assign(
    () => {
      return false;
    },
    { refusal: { ...failures.accessDenied, detail: 'this procedure admits nobody' } }
  );

  // the key a call's ticks are held under: its connection's, in its call's session
  const holdsKeyOf = ({
    connectionHandle,
    session,
  }: {
    connectionHandle: TransportServerConnectionHandle;
    session?: ICallSession | undefined;
  }): string => {
    return JSON.stringify([connectionHandle, sessionKeyOf(session?.identifier)]);
  };

  services.getRequestResolver(procedureOf('echo'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      return response(request.payload);
    }
  );

  services.getRequestResolver(procedureOf('fail'), { serializer: JSON_SERIALIZER })(
    (_request, response) => {
      return response(null, { code: 7, detail: 'this procedure fails, on purpose' });
    }
  );

  // cancelled first, it answers all the same, an answer its router must not send; it waits on its
  // server's clock, which its router runs on
  services.getRequestResolver(procedureOf('slow'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const { milliseconds } = request.payload as { milliseconds: number };
      const { clock: serverClock } = router;

      await new Promise((resolve) => {
        const timer = serverClock.setTimeout(() => {
          resolve(undefined);
        }, milliseconds);

        request.signal.addEventListener(
          'abort',
          () => {
            serverClock.clearTimeout(timer);
            cancellations.set(
              request.connectionHandle,
              (cancellations.get(request.connectionHandle) ?? 0) + 1
            );
            resolve(undefined);
          },
          { once: true }
        );
      });

      return response(milliseconds);
    }
  );

  services.getRequestResolver(procedureOf('cancellations'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      return response(cancellations.get(request.connectionHandle) ?? 0);
    }
  );

  services.getRequestResolver(procedureOf('denied'), {
    beforeRequest: nobody,
    serializer: JSON_SERIALIZER,
  })((_request, response) => {
    return response(null);
  });

  services.getRequestResolver(procedureOf('broken'), { serializer: JSON_SERIALIZER })(() => {
    throw new Error('this procedure breaks, on purpose');
  });

  services.getRequestResolver(procedureOf('bytes'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const { length } = request.payload as { length: number };

      return response('x'.repeat(length));
    }
  );

  // held, it subscribes its requester first, in its call's session, then answers once that
  // session's ticks on its connection notified
  const ticks = services.getNotificationResolver(procedureOf('ticks'), {
    serializer: JSON_NOTIFIED,
  })(async (request, response) => {
    const { fail, hold } = (request.payload as { fail?: unknown; hold?: unknown } | null) ?? {};

    if (typeof hold !== 'number' || hold < 1) {
      return response(null);
    }

    response.registerNotification();

    const released = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    const key = holdsKeyOf(request);
    const sessionHolds = holds.get(key) ?? [];

    sessionHolds.push({
      release: () => {
        released.resolve();

        return answered.promise;
      },
      remaining: hold,
    });
    holds.set(key, sessionHolds);
    await released.promise;

    try {
      await (fail === true
        ? response(null, { code: 7, detail: 'this procedure fails, on purpose' })
        : response(null));
    } finally {
      answered.resolve();
    }
  });

  // notifies the subscription its call's session holds on its connection, then lets the ticks of
  // that session it was the last for answer, before it does
  services.getRequestResolver(procedureOf('tick'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const { key, value } = request.payload as { key?: string; value: unknown };
      const { connectionHandle, session } = request;
      const sessionKey = sessionKeyOf(session?.identifier);
      const held = holdsKeyOf(request);

      await ticks.notify(value, {
        filter: (handle, identifier) => {
          return handle === connectionHandle && sessionKeyOf(identifier) === sessionKey;
        },
        ...(key === undefined ? {} : { key }),
      });

      const due: IHold[] = [];
      const still: IHold[] = [];

      for (const hold of holds.get(held) ?? []) {
        hold.remaining -= 1;
        (hold.remaining === 0 ? due : still).push(hold);
      }

      holds.set(held, still);
      await Promise.all(
        due.map((hold) => {
          return hold.release();
        })
      );

      return response(null);
    }
  );

  // a new session each time, as the one it replaces ends: its token is drawn anew. A timeout not
  // given is left out, for the sessions' default, without end
  services.getRequestResolver(procedureOf('login'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const { connectionTimeout, name, sessionTimeout } = request.payload as {
        connectionTimeout?: unknown;
        name: string;
        sessionTimeout?: unknown;
      };

      sessions.set({
        ...sessions.create(request.connectionHandle),
        connectionInactivityTimeout: durationOf('connectionTimeout', connectionTimeout),
        data: name,
        sessionInactivityTimeout: durationOf('sessionTimeout', sessionTimeout),
      });

      return response(name);
    }
  );

  // ended before it answers, so its answer — or the failure ending a subscription — announces it. A
  // call in a credential's session is denied: SESSION_REQUIRED would have its client withdraw a
  // credential that holds
  services.getRequestResolver(procedureOf('logout'), {
    beforeRequest: requireSession,
    serializer: JSON_SERIALIZER,
  })((request, response) => {
    if (request.session?.identifier !== undefined) {
      return response(null, {
        ...failures.accessDenied,
        detail: "a call in a credential's session ends no connection's session",
      });
    }

    sessions.delete(request.connectionHandle);

    return response(null);
  });

  // the name its call's session holds, whatever its connection's holds meanwhile
  services.getRequestResolver(procedureOf('whoami'), {
    beforeRequest: requireSession,
    serializer: JSON_SERIALIZER,
  })((request, response) => {
    return response(nameOf(request.session));
  });

  // the server asks its client back, by a command, before it answers
  services.getRequestResolver(procedureOf('ask'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const time = await clock(QUESTION)({
        connectionHandle: request.connectionHandle,
        timeout: CLOCK_MILLISECONDS,
      });

      return response(time);
    }
  );

  // its caller's connection, as the destination it names, with the audience it verifies: one
  // registered already, closed or not, is the caller's to hear about, not a mistake of the server's
  services.getRequestResolver(procedureOf('register'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const {
        audience,
        destination,
        timeout: given,
      } = request.payload as {
        audience?: string;
        destination: number;
        timeout?: unknown;
      };
      const { connectionHandle } = request;
      const timeout = durationOf('timeout', given);
      const isRegistered = router.destinations().some(({ destinationId }) => {
        return destinationId === destination;
      });

      if (isRegistered) {
        return response(null, { code: 8, detail: 'that destination is registered already' });
      }

      destinations.set(
        connectionHandle,
        router.registerDestination(
          { connectionHandle },
          { audience, destinationId: destination, timeout }
        )
      );

      return response(destination);
    }
  );

  services.getRequestResolver(procedureOf('unregister'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const registration = destinations.get(request.connectionHandle);

      destinations.delete(request.connectionHandle);

      return response(registration?.unregister() ?? false);
    }
  );

  // ends a credential's session by its identifier on every connection that keeps it, and nothing
  // else, and answers once it did
  services.getRequestResolver(procedureOf('endSession'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      await router.endSession(identifierOf(request.payload));

      return response(null);
    }
  );

  // ends every credential's session of an issuer on every connection that keeps one, and nothing
  // else, and answers once it did
  services.getRequestResolver(procedureOf('endSessionsOf'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      await router.endSessionsOf(issuerOf(request.payload));

      return response(null);
    }
  );
};

/** Registers what a client of the interop service offers its server: the `clock` command. */
export const offerInteropClient = (services: IServiceManager<ServerConnectionHandle>): void => {
  services.getCommandResolver(procedureOf('clock'), { serializer: JSON_SERIALIZER })(
    (_request, response) => {
      return response('noon');
    }
  );
};
