// ── Durations ─────────────────────────────────────────────────────────────────

// Bead's durations, `spec/durations.json`, played at every place that takes a duration an
// application gives this side, by every way its surface takes it: each built on a test clock with
// each input, and with none where a clause states its default. The C# side plays the same file.

// dependencies

import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from '@playwright/test';
import { createRelay } from '../../router/server/relay';
import { createSessionManager } from '../../router/server/session-manager';
import type { RelayTarget } from '../../router/server/types';
import { EnvelopeKind, LIMIT_DEFAULTS, SERVER_FAILURES } from '../../router/shared/constants';
import { createRouterCore } from '../../router/shared/router-core';
import { createServiceManager } from '../../router/shared/service-manager';
import type {
  IProcedure,
  IRequestHeader,
  IResolvedRequestOptions,
  IRouterCorePort,
  IRouterLike,
  IRouterResult,
} from '../../router/shared/types';
import { envelopeOf } from '../../router/shared/__tests__/fixtures';
import { createHTTPTransportClient } from '../../transport/client/http-transport-client';
import {
  createTransportClient,
  dispose,
  setReadyStateClosed,
  setReadyStateOpen,
  type ITransportClientAddressOptions,
} from '../../transport/client/transport-client';
import { createWorkerTransportClient } from '../../transport/client/worker-transport-client';
import { createWSTransportClient } from '../../transport/client/ws-transport-client';
import { createFakeFetch } from '../../transport/client/__tests__/fake-fetch';
import { createFakeWebSocket } from '../../transport/client/__tests__/fake-websocket';
import {
  AFTER_HEADER,
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  createHTTPTransportServer,
  type IHTTPTransportServerOptions,
  LISTEN_HEADER,
  WAIT_HEADER,
} from '../../transport/server/http-transport-server';
import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { createWSTransportServer } from '../../transport/server/ws-transport-server';
import { createFakeHTTPServer } from '../../transport/server/__tests__/fake-http-server';
import { createFakeWebSocketServer } from '../../transport/server/__tests__/fake-websocket-server';
import { LONGEST_TIMER } from '../../transport/shared/clock';
import { createEmitter } from '../../transport/shared/emitter';
import {
  CancelError,
  ConnectError,
  ProgrammerError,
  TimeoutError,
} from '../../transport/shared/errors';
import type { ITransportMessage } from '../../transport/shared/types';
import {
  DURATIONS,
  givenOf,
  isExcused,
  outcomeOf,
  refusalOf,
  type IDurationInput,
  type IDurationOutcome,
  type IDurationPlace,
  type IDurationWay,
} from '../../transport/shared/__tests__/durations';
import {
  createTestClock,
  delaysOn,
  timersBy,
  type TestClock,
} from '../../transport/shared/__tests__/fixtures';
import { createServer } from '../server';
import type { IServerTransportLike } from '../types';

// interfaces

/** A duration a way is given; none, where it leaves its duration out. */
interface IGiven {
  duration: number;
}

/**
 * What a way saw of the place it built: the whole milliseconds it holds — `Infinity` never, no timer
 * armed, and 0 at once — none at a place observed by its refusal; or the refusal it met, and what
 * moved as it did, each by its name.
 */
interface IReport {
  held?: number | undefined;
  moved?: string[];
  refusal?: unknown;
}

/** A place this side plays: its words for its duration, and each way it builds it by. */
interface IPlayed {
  phrase: string;
  ways: Readonly<Record<string, Way>>;
}

/** What a transport client shows of a connect, whichever its transport. */
interface IConnecting {
  isClosed(): boolean;
  isConnecting(): boolean;
  isUninitialized(): boolean;
  reconnect(): Promise<unknown>;
}

// types

/** Builds a place on a test clock, given its duration or none, and reports what it saw. */
type Way = (given?: IGiven) => Promise<IReport>;

type Handle = TransportServerConnectionHandle;

type FakeHTTPServer = ReturnType<typeof createFakeHTTPServer>;

type SessionTimeout = 'connectionInactivityTimeout' | 'sessionInactivityTimeout';

// constants

const first: Handle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';
const second: Handle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=1';
const host = '127.0.0.1';

const echo: IProcedure = Object.freeze({
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
});

/** Bytes as they are, both ways. */
const serializer = Object.freeze({
  decode: (bytes: Uint8Array) => {
    return bytes;
  },
  encode: (bytes: Uint8Array) => {
    return bytes;
  },
});

/** A request to destination 7, as a router hands it to its relay. */
const RELAYED: IRequestHeader = Object.freeze({
  callId: 1,
  destinationId: 7,
  kind: EnvelopeKind.REQUEST,
  procedureId: 1,
  serviceId: 2,
});

/** A request's envelope, as a client posts it to an HTTP server. */
const REQUEST = envelopeOf({
  header: { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 },
  kind: EnvelopeKind.REQUEST,
  payload: new Uint8Array(0),
});

// helpers

// a duration given as the option `name`, or none
const optionOf = <Name extends string>(
  name: Name,
  given: IGiven | undefined
): Partial<Record<Name, number>> => {
  return given === undefined ? {} : ({ [name]: given.duration } as Record<Name, number>);
};

// the duration of a way the harness always gives one: its place reads no default by it
const durationOf = (given: IGiven | undefined): number => {
  if (given === undefined) {
    throw new Error('a way whose place reads no default by it is given its duration');
  }

  return given.duration;
};

// what moved, each by its name, of what a refusal leaves as it was
const movedOf = (moves: Record<string, boolean>): string[] => {
  return Object.entries(moves).flatMap(([name, hasMoved]) => {
    return hasMoved ? [name] : [];
  });
};

// what `build` builds, or what it throws
const attempt = <Built>(build: () => Built): { built: Built } | { refusal: unknown } => {
  try {
    return { built: build() };
  } catch (refusal) {
    return { refusal };
  }
};

// what `run` throws or rejects with, or none
const thrownBy = async (run: () => unknown): Promise<unknown> => {
  try {
    await run();

    return undefined;
  } catch (reason) {
    return reason;
  }
};

// `pending`, settled with what it resolves or rejects with, and whether it has settled yet
const watched = (pending: Promise<unknown>) => {
  const state = { isSettled: false };
  const settled = pending
    .catch((reason: unknown) => {
      return reason;
    })
    .finally(() => {
      state.isSettled = true;
    });

  return {
    isSettled: () => {
      return state.isSettled;
    },
    settled,
  };
};

// a turn of the event loop at a time, some at most, until `isDone`
const turnsUntil = async (isDone: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 50 && !isDone(); turn += 1) {
    await sleep(0);
  }

  expect(isDone(), 'what is waited on comes within some turns').toBe(true);
};

const delayOf = ({ delay }: { delay: number }): number => {
  return delay;
};

// the delay of the one timer among `delays`, or `Infinity` when none was armed
const dueOf = (delays: readonly number[]): number => {
  expect(delays.length, 'one timer at most').toBeLessThanOrEqual(1);

  return delays[0] ?? Infinity;
};

/**
 * The due of the one timer pending on `clock`, once what it ends ended at it and not a millisecond
 * before; `Infinity` where none is pending and nothing ended past the ceiling.
 */
const endedAt = async (clock: TestClock, isEnded: () => boolean): Promise<number> => {
  const due = dueOf(delaysOn(clock));

  await clock.tickAsync(due === Infinity ? LONGEST_TIMER : due - 1);
  await sleep(0);

  expect(isEnded(), 'ended before its due').toBe(false);

  if (due !== Infinity) {
    await clock.tickAsync(1);
    await turnsUntil(isEnded);
  }

  return due;
};

/** A router that answers each request with its payload, and keeps the options each was handed. */
const createFakeRouter = () => {
  const handed: IResolvedRequestOptions[] = [];
  const router: IRouterLike = {
    clock: createTestClock(),
    failures: SERVER_FAILURES,

    answeredOf: () => {
      return undefined;
    },
    declareRequester: () => {
      return undefined;
    },
    hasNotification: () => {
      return false;
    },
    notify: () => {
      return Promise.resolve();
    },
    registerNotification: () => {
      return Promise.resolve();
    },
    registerResolver: () => {
      return undefined;
    },
    report: () => {
      return undefined;
    },
    request: (payload, { options }): Promise<IRouterResult> => {
      handed.push(options);

      return Promise.resolve({ header: { callId: 2, kind: EnvelopeKind.RESULT }, payload });
    },
    respond: () => {
      return Promise.resolve();
    },
    subscribe: () => {
      return 2;
    },
    unregisterNotification: () => {
      return Promise.resolve();
    },
  };

  return { handed, router };
};

// a call's own timeout, as its manager applies its defaults: traced and handed on alike
const callOfManager: Way = async (given) => {
  const { handed, router } = createFakeRouter();
  const manager = createServiceManager(router);
  const traced: unknown[] = [];
  const deprecated: unknown[] = [];

  manager.on('debug', (_, info) => {
    traced.push(info.options?.timeout);
  });
  manager.on('deprecated', (procedure) => {
    deprecated.push(procedure);
  });

  const refusal = await thrownBy(() => {
    return manager.getRequest({ ...echo, deprecation: {} }, { serializer })(new Uint8Array(0))(
      optionOf('timeout', given)
    );
  });

  if (refusal !== undefined) {
    return {
      moved: movedOf({
        'a deprecation notice': deprecated.length > 0,
        'a request handed on': handed.length > 0,
        'a trace': traced.length > 0,
      }),
      refusal,
    };
  }

  expect(traced[0], 'traced as handed on').toBe(handed[0]?.timeout);

  return { held: handed[0]?.timeout };
};

// a manager's default, as it is built: what its router is handed for a call given none
const defaultOfManager: Way = async (given) => {
  const { handed, router } = createFakeRouter();
  const building = attempt(() => {
    return createServiceManager(router, { defaults: optionOf('timeout', given) });
  });

  if ('refusal' in building) {
    return { moved: [], refusal: building.refusal };
  }

  await building.built.getRequest(echo, { serializer })(new Uint8Array(0))();

  return { held: handed[0]?.timeout };
};

/** A server's port that keeps each envelope its core sends. */
const createPort = () => {
  const sent: Uint8Array[] = [];
  const port: IRouterCorePort<Handle> = {
    failures: SERVER_FAILURES,

    activity: () => {},
    isTracing: () => {
      return false;
    },
    report: () => {},
    send: ({ data }) => {
      sent.push(data);

      return Promise.resolve();
    },
    trace: () => {},
  };

  return { port, sent };
};

// the options a router's request is given, resolved: the call ends at its timeout, telling it
const callOfRouter: Way = async (given) => {
  const clock = createTestClock();
  const { port, sent } = createPort();
  using core = createRouterCore(port, { clock });
  const drawn: number[] = [];
  const asking = watched(
    core.request(new Uint8Array(0), {
      connectionHandle: first,
      onCallId: (callId) => {
        drawn.push(callId);
      },
      options: { timeout: durationOf(given) },
      procedure: echo,
    })
  );

  await sleep(0);

  if (asking.isSettled()) {
    return {
      moved: movedOf({ 'a call id drawn': drawn.length > 0, 'an envelope sent': sent.length > 0 }),
      refusal: await asking.settled,
    };
  }

  expect(drawn).toEqual([2]);

  const held = await endedAt(clock, asking.isSettled);

  if (held !== Infinity) {
    const ended = await asking.settled;

    expect(ended).toBeInstanceOf(TimeoutError);
    expect(ended).toHaveProperty('timeout', held);
  }

  return { held };
};

// a call id a router reserves, or cancels with no call waiting on it: reserved until its due
const reservationOf = (act: 'cancel' | 'reserve'): Way => {
  return async (given) => {
    const clock = createTestClock();
    const { port, sent } = createPort();
    using core = createRouterCore(port, { clock });
    const call = { callId: 3, connectionHandle: first, ...optionOf('timeout', given) };
    const refusal = await thrownBy(() => {
      if (act === 'cancel') {
        core.cancel(call);
      } else {
        core.reserve(call);
      }
    });

    if (refusal !== undefined) {
      await sleep(0);

      return {
        moved: movedOf({
          'a call id reserved': core.isReserved(3, first),
          'a cancel sent': sent.length > 0,
        }),
        refusal,
      };
    }

    return {
      held: await endedAt(clock, () => {
        return !core.isReserved(3, first);
      }),
    };
  };
};

// a router's limit, as it is built, read back
const transferOfLimits: Way = (given) => {
  const { port } = createPort();
  const building = attempt(() => {
    return createRouterCore(port, { limits: optionOf('transferInactivityTimeout', given) });
  });

  if ('refusal' in building) {
    return Promise.resolve({ moved: [], refusal: building.refusal });
  }

  using core = building.built;

  return Promise.resolve({ held: core.limits.transferInactivityTimeout });
};

/**
 * A relay that admits every request, under `options`, and a destination's target that answers each
 * request leg B makes and keeps its timeout.
 */
const createRelayOf = (options: Partial<Record<'timeout', number>>) => {
  const asked: number[] = [];
  const target: RelayTarget = {
    limits: LIMIT_DEFAULTS,
    request: (payload, { onSent, options: { timeout } }) => {
      asked.push(timeout);
      onSent?.(true);

      return Promise.resolve({ header: { callId: 2, kind: EnvelopeKind.RESULT }, payload });
    },
  };
  const relay = createRelay({
    failures: SERVER_FAILURES,
    limits: LIMIT_DEFAULTS,
    options: {
      beforeRoute: () => {
        return true;
      },
      ...options,
    },
    report: () => {},
    request: () => {
      return Promise.reject(new Error('the relay calls no connection of its own'));
    },
    respond: () => {
      return Promise.resolve();
    },
  });

  return { asked, relay, target };
};

// what leg B waits for a request to destination 7, relayed
const legBOf = async ({ asked, relay }: ReturnType<typeof createRelayOf>): Promise<IReport> => {
  await relay.handlerOf(7)?.({
    connectionHandle: second,
    header: RELAYED,
    isAdmitted: true,
    payload: Uint8Array.of(1),
    signal: new AbortController().signal,
  });

  expect(asked).toHaveLength(1);

  return { held: asked[0] };
};

// the relay's own timeout, a destination registered with none
const relayOfOptions: Way = async (given) => {
  const building = attempt(() => {
    return createRelayOf(optionOf('timeout', given));
  });

  if ('refusal' in building) {
    return { moved: [], refusal: building.refusal };
  }

  building.built.relay.register(building.built.target, { destinationId: 7 });

  return legBOf(building.built);
};

// a destination's, as it is registered, under a relay given none
const relayOfRegister: Way = async (given) => {
  const relayed = createRelayOf({});
  const refusal = await thrownBy(() => {
    relayed.relay.register(relayed.target, { destinationId: 7, ...optionOf('timeout', given) });
  });

  if (refusal !== undefined) {
    return {
      moved: movedOf({ 'a destination registered': relayed.relay.destinations().length > 0 }),
      refusal,
    };
  }

  return legBOf(relayed);
};

// a manager's default for `name`, as it is built: a session set with it left out holds it, its
// timer armed for it
const sessionsOf = (name: SessionTimeout): Way => {
  return (given) => {
    const clock = createTestClock();
    const building = attempt(() => {
      return createSessionManager({ clock, ...optionOf(name, given) });
    });

    if ('refusal' in building) {
      return Promise.resolve({ moved: [], refusal: building.refusal });
    }

    using sessions = building.built;
    const held = sessions.set({ ...sessions.create(first), [name]: undefined })[name];

    expect(delaysOn(clock)).toEqual(held === Infinity ? [] : [held]);

    return Promise.resolve({ held });
  };
};

// a session's `name`, as its manager sets a new session or updates one stored: the session it
// returns holds it, its timer armed for it; refused, nothing stored and the timers as they were
const sessionOf = ({ act, name }: { act: 'set' | 'update'; name: SessionTimeout }): Way => {
  return (given) => {
    const clock = createTestClock();
    using sessions = createSessionManager({ clock });
    const session = sessions.set(sessions.create(first));
    const acting = attempt(() => {
      if (act === 'set') {
        return sessions.set({ ...sessions.create(second), [name]: given?.duration });
      }

      return name === 'connectionInactivityTimeout'
        ? sessions.updateConnectionInactivityTimeout({ ...session, [name]: given?.duration })
        : sessions.updateSessionInactivityTimeout({ ...session, [name]: given?.duration });
    });

    if ('refusal' in acting) {
      return Promise.resolve({
        moved: movedOf({
          'a session stored': sessions.has(second),
          'a timer armed': delaysOn(clock).length > 0,
          'the session stored changed': !isDeepStrictEqual(sessions.get(first), session),
        }),
        refusal: acting.refusal,
      });
    }

    const held = acting.built?.[name];

    expect(delaysOn(clock)).toEqual(held === Infinity ? [] : [held]);

    return Promise.resolve({ held });
  };
};

// a reset of a session's timer for `name`, beside the other's of a second: the timer it arms
const resetOf = (name: SessionTimeout): Way => {
  return (given) => {
    const duration = durationOf(given);
    const clock = createTestClock();
    using sessions = createSessionManager({ clock });
    const isConnection = name === 'connectionInactivityTimeout';
    const session = sessions.set({
      ...sessions.create(first),
      ...(isConnection
        ? { sessionInactivityTimeout: 1_000 }
        : { connectionInactivityTimeout: 1_000 }),
    });
    const resetting = attempt(() => {
      return timersBy(clock, () => {
        if (isConnection) {
          sessions.resetConnectionInactivityTimeout(session, duration);
        } else {
          sessions.resetSessionInactivityTimeout(session, duration);
        }
      });
    });

    if ('refusal' in resetting) {
      return Promise.resolve({
        moved: movedOf({
          'a timer armed or cleared': !isDeepStrictEqual(delaysOn(clock), [1_000]),
        }),
        refusal: resetting.refusal,
      });
    }

    const held = dueOf(resetting.built.armed.map(delayOf));

    expect(delaysOn(clock)).toEqual(
      held === Infinity
        ? [1_000]
        : [held, 1_000].toSorted((a, b) => {
            return a - b;
          })
    );

    return Promise.resolve({ held });
  };
};

/** A transport server a test opens a connection on, which keeps each connection it closes. */
const createScriptedTransport = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: Handle];
    connection: [socket: unknown, request: unknown, connectionHandle: Handle];
    listen: [isHeld: boolean, connectionHandle: Handle];
    message: [message: ITransportMessage, connectionHandle: Handle];
  }>();
  const closed: Handle[] = [];
  const transport: IServerTransportLike = {
    off: emitter.off,
    on: emitter.on,
    close: (connectionHandle) => {
      closed.push(connectionHandle);

      return Promise.resolve(true);
    },
    send: () => {
      return Promise.resolve();
    },
    stop: () => {
      return Promise.resolve();
    },
  };

  return { closed, emitter, transport };
};

// a server layer's own, as it is built: a silent connection closed at its due
const serverOfOptions: Way = async (given) => {
  const clock = createTestClock();
  const { closed, emitter, transport } = createScriptedTransport();
  const building = attempt(() => {
    return createServer(
      { transport },
      { clock, ...optionOf('connectionInactivityTimeout', given) }
    );
  });

  if ('refusal' in building) {
    return {
      moved: movedOf({
        'a listener on its transport': (['close', 'connection', 'listen', 'message'] as const).some(
          (event) => {
            return emitter.listenerCount(event) > 0;
          }
        ),
      }),
      refusal: building.refusal,
    };
  }

  await using _server = building.built;

  emitter.emit('connection', {}, {}, first);

  return {
    held: await endedAt(clock, () => {
      return closed.length > 0;
    }),
  };
};

// a connect on a fake HTTP server, its client listening or not: the connection token it draws
const connectOn = (fake: FakeHTTPServer, isListening: boolean): string => {
  const { response } = fake.exchange({
    headers: {
      'content-type': BEAD_MEDIA_TYPE,
      ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
    },
  });

  return response.headers?.[CONNECTION_TOKEN_HEADER] ?? '';
};

/**
 * What an HTTP server on its clock, its bounds as `options` say, holds: the due of the timer it arms
 * as `measured` acts on the connection `drawn` makes; none built, refused.
 */
const heldByHTTPServer = async (
  {
    drawn,
    measured,
  }: {
    drawn: (fake: FakeHTTPServer) => string;
    measured: (fake: FakeHTTPServer, connectionToken: string) => void;
  },
  options?: Partial<IHTTPTransportServerOptions>
): Promise<IReport> => {
  const clock = createTestClock();
  const fake = createFakeHTTPServer();
  const building = attempt(() => {
    return createHTTPTransportServer({ clock, createServer: fake.createServer, ...options });
  });

  if ('refusal' in building) {
    return {
      moved: movedOf({ 'a server made': fake.servers.length > 0 }),
      refusal: building.refusal,
    };
  }

  const server = building.built;
  const starting = server.start({ port: 4_321 });

  fake.listen();
  await starting;

  try {
    const connectionToken = drawn(fake);
    const { armed } = timersBy(clock, () => {
      measured(fake, connectionToken);
    });

    return { held: dueOf(armed.map(delayOf)) };
  } finally {
    await server.stop();
  }
};

// an exchange handed on, waiting its answer, its connection's rest without end
const exchangeOfOptions: Way = (given) => {
  return heldByHTTPServer(
    {
      drawn: (fake) => {
        return connectOn(fake, false);
      },
      measured: (fake, connectionToken) => {
        const { request } = fake.exchange({
          headers: { 'content-type': BEAD_MEDIA_TYPE, [CONNECTION_TOKEN_HEADER]: connectionToken },
        });

        fake.feed(request, [REQUEST]);
      },
    },
    { inactivityTimeout: Infinity, ...optionOf('exchangeTimeout', given) }
  );
};

// a connection drawn, with no exchange under way
const restOfOptions: Way = (given) => {
  return heldByHTTPServer(
    {
      drawn: () => {
        return '';
      },
      measured: (fake) => {
        connectOn(fake, false);
      },
    },
    { exchangeTimeout: Infinity, ...optionOf('inactivityTimeout', given) }
  );
};

// a listen asking a longer wait, held to the longest
const maximumWaitOfOptions: Way = (given) => {
  return heldByHTTPServer(
    {
      drawn: (fake) => {
        return connectOn(fake, true);
      },
      measured: (fake, connectionToken) => {
        fake.exchange({
          headers: {
            [AFTER_HEADER]: '0',
            [CONNECTION_TOKEN_HEADER]: connectionToken,
            [WAIT_HEADER]: '999999999999999',
          },
          method: 'GET',
        });
      },
    },
    { exchangeTimeout: Infinity, inactivityTimeout: Infinity, ...optionOf('maximumWait', given) }
  );
};

/**
 * An HTTP client on its clock and a fake fetch, given `options`, connected, its server saying its
 * listen back, once its first listen went; none built, refused.
 */
const listeningOf = async (options: Record<string, number>) => {
  const clock = createTestClock();
  const fake = createFakeFetch();
  const building = attempt(() => {
    return createHTTPTransportClient({ clock, fetch: fake.fetch, ...options });
  });

  if ('refusal' in building) {
    return { moved: movedOf({ 'a fetch': fake.calls.length > 0 }), refusal: building.refusal };
  }

  const client = building.built;
  const connecting = client.connect({ host, port: 8_080 });

  fake.calls[0]?.answer({
    headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22), [LISTEN_HEADER]: '?1' },
    status: 201,
  });
  await connecting;
  await turnsUntil(() => {
    return fake.calls.length > 1;
  });

  return { client, clock, fake };
};

// a client's own inactivity: the timer armed at its listens' first loss
const clientRestOfOptions: Way = async (given) => {
  const listening = await listeningOf(optionOf('inactivityTimeout', given));

  if ('refusal' in listening) {
    return listening;
  }

  const { client, clock, fake } = listening;

  fake.calls[1]?.fail();
  await turnsUntil(() => {
    return fake.calls.length > 2;
  });

  const held = dueOf(delaysOn(clock));

  await client.disconnect({ isQuick: true });

  return { held };
};

// the wait its listen asks
const waitOfOptions: Way = async (given) => {
  const listening = await listeningOf(optionOf('wait', given));

  if ('refusal' in listening) {
    return listening;
  }

  const { client, fake } = listening;
  const asked = fake.calls[1]?.init.headers[WAIT_HEADER];

  await client.disconnect({ isQuick: true });

  return { held: Number(asked) };
};

// the pause between a listen that brought nothing and the next: its timer, and the next listen at
// its due; at once, none armed, and the next listen at once
const pauseOfOptions: Way = async (given) => {
  const listening = await listeningOf(optionOf('pause', given));

  if ('refusal' in listening) {
    return listening;
  }

  const { client, clock, fake } = listening;

  fake.calls[1]?.answer({ status: 204 });
  await turnsUntil(() => {
    return fake.calls.length > 2 || delaysOn(clock).length > 0;
  });

  const [held = 0] = delaysOn(clock);

  if (held > 0) {
    await clock.tickAsync(held - 1);
    await sleep(0);

    expect(fake.calls, 'listened again before its pause').toHaveLength(2);

    await clock.tickAsync(1);
    await turnsUntil(() => {
      return fake.calls.length > 2;
    });
  }

  await client.disconnect({ isQuick: true });

  return { held };
};

// a WebSocket client's heartbeat, as it is built
const heartbeatOfClient: Way = (given) => {
  const { FakeWebSocket, sockets } = createFakeWebSocket();
  const building = attempt(() => {
    return createWSTransportClient({ WebSocket: FakeWebSocket, ...optionOf('heartbeat', given) });
  });

  return Promise.resolve(
    'refusal' in building
      ? { moved: movedOf({ 'a socket opened': sockets.length > 0 }), refusal: building.refusal }
      : {}
  );
};

// a WebSocket server's option `name`, as it is built
const ofWSServer = (name: 'closeTimeout' | 'heartbeat'): Way => {
  return (given) => {
    const fake = createFakeWebSocketServer();
    const building = attempt(() => {
      return createWSTransportServer({
        WebSocketServer: fake.FakeWebSocketServer,
        ...optionOf(name, given),
      });
    });

    return Promise.resolve(
      'refusal' in building
        ? {
            moved: movedOf({ 'a WebSocket server made': fake.instances.length > 0 }),
            refusal: building.refusal,
          }
        : {}
    );
  };
};

/**
 * A connect `connect` starts on `client`, timed on `clock`: connecting until its due, ended at it by
 * a `TimeoutError` telling it, then closed; never, connecting until aborted. Refused, nothing
 * `hasMoved` says, the client uninitialized, and no target kept for a reconnection.
 */
const connectTimed = async (
  { client, clock }: { client: IConnecting; clock: TestClock },
  {
    connect,
    given,
    hasMoved,
  }: {
    connect: (options: { signal: AbortSignal; timeout?: number }) => Promise<unknown>;
    given: IGiven | undefined;
    hasMoved: () => boolean;
  }
): Promise<IReport> => {
  const controller = new AbortController();
  const connecting = watched(connect({ signal: controller.signal, ...optionOf('timeout', given) }));

  await sleep(0);

  if (connecting.isSettled()) {
    const reconnection = await thrownBy(() => {
      return client.reconnect();
    });

    return {
      moved: movedOf({
        'a connection started': hasMoved(),
        'a target kept for a reconnection': !(
          reconnection instanceof ProgrammerError &&
          reconnection.message === 'transport was never connected'
        ),
        'the client initialized': !client.isUninitialized(),
      }),
      refusal: await connecting.settled,
    };
  }

  const held = await endedAt(clock, () => {
    return connecting.isSettled() || !client.isConnecting();
  });

  if (held === Infinity) {
    controller.abort();
  }

  const ended = await connecting.settled;

  if (held === Infinity) {
    expect(ended).toBeInstanceOf(CancelError);
  } else {
    expect(ended).toBeInstanceOf(TimeoutError);
    expect(ended).toHaveProperty('timeout', held);
  }

  expect(client.isClosed()).toBe(true);

  return { held };
};

// an HTTP client's connect, its fetch never answered
const connectOfHTTP: Way = (given) => {
  const clock = createTestClock();
  const fake = createFakeFetch();
  const client = createHTTPTransportClient({ clock, fetch: fake.fetch, isListening: false });

  return connectTimed(
    { client, clock },
    {
      connect: (options) => {
        return client.connect({ host, port: 8_080, ...options });
      },
      given,
      hasMoved: () => {
        return fake.calls.length > 0;
      },
    }
  );
};

// a WebSocket client's connect, its socket never opened
const connectOfWebSocket: Way = (given) => {
  const clock = createTestClock();
  const { FakeWebSocket, sockets } = createFakeWebSocket();
  const client = createWSTransportClient({ clock, WebSocket: FakeWebSocket });

  return connectTimed(
    { client, clock },
    {
      connect: (options) => {
        return client.connect({ host: 'h', port: 1, ...options });
      },
      given,
      hasMoved: () => {
        return sockets.length > 0;
      },
    }
  );
};

// a Web Worker client's connect, its worker never answering
const connectOfWorker: Way = async (given) => {
  const clock = createTestClock();
  const posted: MessagePort[] = [];
  const client = createWorkerTransportClient({
    clock,
    worker: {
      postMessage: (_, transfer) => {
        posted.push(transfer[0] as MessagePort);
      },
    },
  });

  try {
    return await connectTimed(
      { client, clock },
      {
        connect: (options) => {
          return client.connect(options);
        },
        given,
        hasMoved: () => {
          return posted.length > 0;
        },
      }
    );
  } finally {
    for (const port of posted) {
      port.close();
    }
  }
};

/** A transport with no socket, on `clock`, whose first two connects fail. */
const createFailingClient = (clock: TestClock) => {
  const connects: string[] = [];
  let failures = 2;
  const client = createTransportClient<object, ITransportClientAddressOptions>((self) => {
    return {
      clock,

      connect: () => {
        connects.push('connect');

        if (failures > 0) {
          failures -= 1;

          return Promise.reject(new ConnectError('refused'));
        }

        setReadyStateOpen(self);

        return Promise.resolve();
      },
      disconnect: () => {
        setReadyStateClosed(self);

        return Promise.resolve();
      },
      send: () => {
        return Promise.resolve();
      },
      [dispose]: () => {},
    };
  });

  return { client, connects };
};

// a reconnection's delay, a function's answer or a number: its tap hears it, its wait is due at it,
// and the attempt comes then, not before; refused, nothing heard, no attempt more, and closed
const reconnectionOf = (as: 'function' | 'number'): Way => {
  return async (given) => {
    const clock = createTestClock();
    const { client, connects } = createFailingClient(clock);
    const taps: number[] = [];
    const duration = durationOf(given);

    await expect(client.connect({ host, port: 1 })).rejects.toBeInstanceOf(ConnectError);

    const reconnecting = watched(
      client.reconnect({
        delay:
          as === 'number'
            ? duration
            : () => {
                return duration;
              },
        tap: (nextDelay) => {
          taps.push(nextDelay);
        },
      })
    );

    await turnsUntil(() => {
      return reconnecting.isSettled() || taps.length > 0;
    });

    if (taps.length === 0) {
      return {
        moved: movedOf({
          'an attempt more': connects.length > 2,
          'the client open': !client.isClosed(),
        }),
        refusal: await reconnecting.settled,
      };
    }

    const [held = 0] = taps;

    if (held > 0) {
      expect(delaysOn(clock)).toEqual([held]);

      await clock.tickAsync(held - 1);
      await sleep(0);

      expect(connects, 'attempted before its delay').toHaveLength(2);

      await clock.tickAsync(1);
    }

    expect(await reconnecting.settled).toBeUndefined();
    expect([connects.length, taps]).toEqual([3, [held]]);

    return { held };
  };
};

// what a way reports of an outcome the file holds, but a refusal
const reportOf = ({ held, outcome }: IDurationOutcome): IReport => {
  switch (outcome) {
    case 'at once':
      return { held: 0 };
    case 'never':
      return { held: Infinity };
    case 'taken':
      return {};
    case 'default':
    case 'held':
      return { held };
    case 'refused':
      throw new Error('a refusal is held to its words, not to a report');
  }
};

// definition

/**
 * Each place this side plays, keyed by the file's id: its words for its duration, in its own case,
 * and each way it builds it by, keyed by the way's id.
 */
const PLAYED: Readonly<Record<string, IPlayed>> = Object.freeze({
  // ! each id a quoted literal, which spec/check.py finds here: an id built would hide a place
  'call.timeout': {
    phrase: "a call's timeout",
    ways: { router: callOfRouter, serviceManager: callOfManager },
  },
  'serviceManager.defaultTimeout': {
    phrase: "a call's default timeout",
    ways: { options: defaultOfManager },
  },
  'router.reservation': {
    phrase: "a call id's reservation",
    ways: { cancel: reservationOf('cancel'), reserve: reservationOf('reserve') },
  },
  'router.transferInactivityTimeout': {
    phrase: "a transfer's inactivity",
    ways: { limits: transferOfLimits },
  },
  'relay.timeout': {
    phrase: "a relay's timeout",
    ways: { register: relayOfRegister, relay: relayOfOptions },
  },
  'sessionManager.connectionInactivityTimeout': {
    phrase: 'connectionInactivityTimeout',
    ways: { options: sessionsOf('connectionInactivityTimeout') },
  },
  'sessionManager.sessionInactivityTimeout': {
    phrase: 'sessionInactivityTimeout',
    ways: { options: sessionsOf('sessionInactivityTimeout') },
  },
  'session.inactivityTimeouts': {
    phrase: 'an inactivity timeout',
    ways: {
      setConnection: sessionOf({ act: 'set', name: 'connectionInactivityTimeout' }),
      setSession: sessionOf({ act: 'set', name: 'sessionInactivityTimeout' }),
      updateConnection: sessionOf({ act: 'update', name: 'connectionInactivityTimeout' }),
      updateSession: sessionOf({ act: 'update', name: 'sessionInactivityTimeout' }),
    },
  },
  'sessionManager.resetConnectionInactivityTimeout': {
    phrase: 'a connection inactivity timeout',
    ways: { reset: resetOf('connectionInactivityTimeout') },
  },
  'sessionManager.resetSessionInactivityTimeout': {
    phrase: 'a session inactivity timeout',
    ways: { reset: resetOf('sessionInactivityTimeout') },
  },
  'server.connectionInactivityTimeout': {
    phrase: "a connection's inactivity timeout",
    ways: { options: serverOfOptions },
  },
  'httpTransportServer.exchangeTimeout': {
    phrase: 'exchangeTimeout',
    ways: { options: exchangeOfOptions },
  },
  'httpTransportServer.inactivityTimeout': {
    phrase: 'inactivityTimeout',
    ways: { options: restOfOptions },
  },
  'httpTransportServer.maximumWait': {
    phrase: 'maximumWait',
    ways: { options: maximumWaitOfOptions },
  },
  'httpTransportClient.inactivityTimeout': {
    phrase: 'inactivityTimeout',
    ways: { options: clientRestOfOptions },
  },
  'httpTransportClient.wait': {
    phrase: 'wait',
    ways: { options: waitOfOptions },
  },
  'httpTransportClient.pause': {
    phrase: 'pause',
    ways: { options: pauseOfOptions },
  },
  'webSocketTransport.heartbeat': {
    phrase: 'a heartbeat',
    ways: { client: heartbeatOfClient, server: ofWSServer('heartbeat') },
  },
  'transportClient.connectTimeout': {
    phrase: "a connect's timeout",
    ways: { http: connectOfHTTP, webSocket: connectOfWebSocket, worker: connectOfWorker },
  },
  'transportClient.reconnectionDelay': {
    phrase: 'a delay',
    ways: { function: reconnectionOf('function'), number: reconnectionOf('number') },
  },
  'webSocketTransportServer.closeTimeout': {
    phrase: 'a close timeout',
    ways: { options: ofWSServer('closeTimeout') },
  },
});

// the ways of `place` this side plays, by their ids
const wayIdsOf = (place: IDurationPlace): string[] => {
  return place.ways
    .filter((way) => {
      return !isExcused(place, { way });
    })
    .map(({ id }) => {
      return id;
    });
};

// how this side builds `place` by `way`
const playOf = (place: IDurationPlace, way: IDurationWay): IPlayed & { play: Way } => {
  const played = PLAYED[place.id];
  const play = played?.ways[way.id];

  if (played === undefined || play === undefined) {
    throw new Error(`the table plays no ${place.id} by ${way.id}`);
  }

  return { ...played, play };
};

/**
 * What `play` reports of `input` at `place`, held to the file's outcome; a refusal, to this side's one
 * sentence for it, a `ProgrammerError`, with nothing moved.
 */
const expectOutcome = async (
  place: IDurationPlace,
  {
    input,
    label,
    phrase,
    play,
  }: { input: IDurationInput; label: string; phrase: string; play: Way }
): Promise<void> => {
  const given = givenOf(input);
  const outcome = outcomeOf(place, input);
  const report = await play({ duration: given });

  if (outcome.outcome !== 'refused') {
    expect(report, label).toEqual(reportOf(outcome));

    return;
  }

  expect(report.refusal, label).toBeInstanceOf(ProgrammerError);
  expect({ ...report, refusal: (report.refusal as Error).message }, label).toEqual({
    moved: [],
    refusal: refusalOf(place, { given, phrase }),
  });
};

test.describe('the durations', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  test('its table plays every place of the file, each by every way the file gives it, and no other', () => {
    expect(
      Object.fromEntries(
        Object.entries(PLAYED).map(([id, { ways }]) => {
          return [id, Object.keys(ways).toSorted()];
        })
      )
    ).toEqual(
      Object.fromEntries(
        DURATIONS.places.map((place) => {
          return [place.id, wayIdsOf(place).toSorted()];
        })
      )
    );
  });

  for (const place of DURATIONS.places) {
    test(place.id, async () => {
      for (const way of place.ways) {
        if (isExcused(place, { way })) {
          continue;
        }

        const { phrase, play } = playOf(place, way);

        for (const input of DURATIONS.inputs) {
          if (isExcused(place, { input, way })) {
            continue;
          }

          const label = `${way.id}, ${input.name}`;

          await test.step(label, async () => {
            await expectOutcome(place, { input, label, phrase, play });
          });
        }

        const byDefault = place.default;

        if (byDefault?.ways.includes(way.id) === true) {
          const label = `${way.id}, none given`;

          await test.step(label, async () => {
            expect(await play(), label).toEqual({ held: byDefault.milliseconds ?? Infinity });
          });
        }
      }
    });
  }
});
