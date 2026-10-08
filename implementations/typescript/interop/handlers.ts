// ── Interop service, its handlers ─────────────────────────────────────────────

// The resolvers of Bead's interop service, its API `spec/interop-blueprint.json`, generated into
// `generated/interop_bead.ts`, and its behaviour `spec/interop-service.json`, as Bead's TypeScript
// implementation answers them: what a client of any implementation calls, and what
// `spec/conversations.json` plays against. Only the resolvers and the hook are written here.

// dependencies

import type { IDestinationRegistration } from '../src/router/server/types';
import { sessionKeyOf } from '../src/router/shared/call-session';
import { CredentialScheme } from '../src/router/shared/constants';
import type { ICallSession, SessionIdentifier } from '../src/router/shared/types';
import type { IServer, IServerTransportLike } from '../src/server/types';
import type { TransportServerConnectionHandle } from '../src/transport/server/types';
import { assertHeldFinite } from '../src/transport/shared/clock';
import { type InteropClient, InteropFailures, InteropServer } from './generated/interop_bead';

// interfaces

/** A `ticks` answer held: the ticks it waits for still, and what lets it answer, then says it did. */
interface IHold {
  release: () => Promise<void>;
  remaining: number;
}

// constants

/** The question `ask` puts to its client's `clock`, and how long it waits for the answer. */
const QUESTION = 'What time is it where you are?';
const CLOCK_MILLISECONDS = 10_000;

// helpers

/**
 * A duration a payload gives, in milliseconds, held as spec 1.4 holds one given: rounded, and
 * refused under a millisecond or past 2³¹ − 1, as given, by a throw its server answers with
 * PROCEDURE_FAILED. `undefined` when not given; JSON writes no never.
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

// definition

/**
 * The interop service, served on `server`, its resolvers registered and offered there. The calls to
 * `slow` each connection cancelled are counted per connection, for `cancellations` to answer; a
 * connection's session holds the name its `login` gave, whatever its call presents, and `whoami`
 * answers the name its call's session holds, a credential's `sub`; `ticks` and `tick` hold per
 * connection and per session, its connection's or a credential's; the destination each connection
 * registered last is kept past its close, for `unregister` to take out from whichever connection
 * takes its handle next. Its relay and its credentials are its server's, as it was built. One
 * service a server: the counts are its connections'.
 */
export const offerInterop = (
  server: IServer<IServerTransportLike, string>
): InteropServer<string> => {
  const { router, sessions } = server;
  const { failures } = router;
  const interop = new InteropServer<string>({
    admissions: {
      nobody: {
        admits: () => {
          return false;
        },
        detail: 'this procedure admits nobody',
      },
    },
  });
  const cancellations = new Map<TransportServerConnectionHandle, number>();
  // by connection, the destination it registered last
  const destinations = new Map<TransportServerConnectionHandle, IDestinationRegistration>();
  // by connection and session, the ticks answers held, in the order they came
  const holds = new Map<string, IHold[]>();

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

  interop.on('echo', (request, response) => {
    return response(request.payload);
  });

  interop.on('fail', (_request, response) => {
    return response(null, InteropFailures.of('ON_PURPOSE', 'this procedure fails, on purpose'));
  });

  // cancelled first, it answers all the same, an answer its router must not send; it waits on its
  // server's clock, which its router runs on
  interop.on('slow', async (request, response) => {
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
  });

  interop.on('cancellations', (request, response) => {
    return response(cancellations.get(request.connectionHandle) ?? 0);
  });

  interop.on('denied', (_request, response) => {
    return response(null);
  });

  interop.on('broken', () => {
    throw new Error('this procedure breaks, on purpose');
  });

  interop.on('bytes', (request, response) => {
    const { length } = request.payload as { length: number };

    return response('x'.repeat(length));
  });

  // held, it subscribes its requester first, in its call's session, then answers once that
  // session's ticks on its connection notified
  interop.on('ticks', async (request, response) => {
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
        ? response(null, InteropFailures.of('ON_PURPOSE', 'this procedure fails, on purpose'))
        : response(null));
    } finally {
      answered.resolve();
    }
  });

  // notifies the subscription its call's session holds on its connection, then lets the ticks of
  // that session it was the last for answer, before it does
  interop.on('tick', async (request, response) => {
    const { key, value } = request.payload as { key?: string; value: unknown };
    const { connectionHandle, session } = request;
    const sessionKey = sessionKeyOf(session?.identifier);
    const held = holdsKeyOf(request);

    await interop.notify.ticks(value, {
      filter: (subscriber) => {
        return (
          subscriber.connectionHandle === connectionHandle &&
          sessionKeyOf(subscriber.identifier) === sessionKey
        );
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
  });

  // a new session each time, as the one it replaces ends: its token is drawn anew. A timeout not
  // given is left out, for the sessions' default, without end
  interop.on('login', (request, response) => {
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
  });

  // ended before it answers, so its answer — or the failure ending a subscription — announces it. A
  // call in a credential's session is denied: SESSION_REQUIRED would have its client withdraw a
  // credential that holds
  interop.on('logout', (request, response) => {
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
  interop.on('whoami', (request, response) => {
    return response(nameOf(request.session));
  });

  // the server asks its client back, by a command, before it answers
  interop.on('ask', async (request, response) => {
    const time = await interop.command.clock(QUESTION)({
      connectionHandle: request.connectionHandle,
      timeout: CLOCK_MILLISECONDS,
    });

    return response(time);
  });

  // its caller's connection, as the destination it names, with the audience it verifies: one
  // registered already, closed or not, is the caller's to hear about, not a mistake of the server's
  interop.on('register', (request, response) => {
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
      return response(
        null,
        InteropFailures.of('REGISTERED_ALREADY', 'that destination is registered already')
      );
    }

    destinations.set(
      connectionHandle,
      router.registerDestination(
        { connectionHandle },
        { audience, destinationId: destination, timeout }
      )
    );

    return response(destination);
  });

  interop.on('unregister', (request, response) => {
    const registration = destinations.get(request.connectionHandle);

    destinations.delete(request.connectionHandle);

    return response(registration?.unregister() ?? false);
  });

  // ends a credential's session by its identifier on every connection that keeps it, and nothing
  // else, and answers once it did
  interop.on('endSession', async (request, response) => {
    await router.endSession(identifierOf(request.payload));

    return response(null);
  });

  // ends every credential's session of an issuer on every connection that keeps one, and nothing
  // else, and answers once it did
  interop.on('endSessionsOf', async (request, response) => {
    await router.endSessionsOf(issuerOf(request.payload));

    return response(null);
  });

  interop.offer(server);

  return interop;
};

/** What a client of the interop service answers its server: the `clock` command, `"noon"`. */
export const offerInteropClient = (interop: InteropClient): void => {
  interop.on('clock', (_request, response) => {
    return response('noon');
  });
};
