// ── Conversation player ───────────────────────────────────────────────────────

// A conversation of `spec/conversations.json`, or an exit of `spec/metrics.json`, played against
// Bead's TypeScript server of the interop service: what its clients send, what it sends back and
// reports, and, for an exit, what moved in its registry's exposition.

// dependencies

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { interopCredentialsOf, offerInterop } from '../../../../interop/offer';
import { createServer } from '../../../server/server';
import type { IServerTransportLike } from '../../../server/types';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createEmitter } from '../../../transport/shared/emitter';
import { createTestClock, duesOn } from '../../../transport/shared/__tests__/fixtures';
import type { Data, ITransportMessage } from '../../../transport/shared/types';
import { bytesOf } from '../../shared/envelope';
import type { IMetricsRegistry } from '../../shared/metrics-registry';
import type { RouterLimitsOptions } from '../../shared/types';
import { fromHexadecimal } from '../../shared/__tests__/vectors';
import {
  EnvelopeKind,
  FailureError,
  type IRelayOptions,
  type PacingLimitsOptions,
  requireSession,
  requireSessionOrCredential,
} from '../router-server';
import {
  announcedTokenOf,
  expectedOf,
  failureDetailOf,
  hexadecimalOf,
  type IExpected,
} from './expected-envelope';

// interfaces

/** One step of a conversation: what the test does, or what the server does next, on its connection. */
export interface IStep {
  advance?: number;
  /**
   * Beside a send, what the client's transport carried with it; beside a request's expect, what the
   * server's transport was given with it; none when absent.
   */
  carried?: string;
  /** Beside an open, false for a connection whose transport carries no credential. */
  carries?: false;
  close?: true;
  /**
   * An exit's: the line of every series that moved since the case began or the last counted, as
   * the registry's exposition writes it, in its order.
   */
  counted?: string[];
  expect?: IExpected;
  on?: string;
  open?: string;
  report?: number | 'exception';
  /** Beside an open, false for a connection that reaches off the machine in the clear. */
  secure?: false;
  send?: string;
  /** The name the token its expected answer announced takes, for a later `send` to present. */
  token?: string;
  twoWay?: false;
  until?: { timer: number };
  wall?: number;
}

/** A conversation, or an exit: its steps, and how its server is built. */
export interface IConversation {
  limits?: RouterLimitsOptions;
  pacing?: PacingLimitsOptions;
  name: string;
  /** The server's relay's options, its admission by the name both sides give it. */
  relay?: { beforeRoute?: 'requireSession' | 'requireSessionOrCredential'; verifies?: true };
  steps: IStep[];
}

/** What the server reported to its application, and the connection it came with. */
interface IReport {
  code: number | 'exception';
  connectionHandle: TransportServerConnectionHandle | undefined;
}

/** An envelope the server sent, and the credential its transport was given with it. */
interface ISent {
  bytes: Uint8Array;
  credential: string | undefined;
}

// constants

/** The instant every conversation's clock starts at, and every exit's. */
export const { wallClock: WALL_CLOCK } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/conversations.json', import.meta.url), 'utf8')
) as { wallClock: string };

// the connection a conversation that opens none plays, opened before its first step
const ONLY_CONNECTION = 'client';

// how long an until waits on the real clock for its timer, and an expect or a report for what the
// server sends: a JWT verified by Web Crypto settles off the event loop
const PATIENCE = 3_000;
const POLL = 5;

// a relay's admission, by the name a conversation gives it
const ADMISSIONS = Object.freeze({ requireSession, requireSessionOrCredential });

// a token named in a send, between angle brackets
const TOKEN_NAME = /<([a-z][a-z0-9]*)>/g;

// ! every key of a step this player reads: one it does not know fails the step, rather than pass it
// unplayed
const STEP_KEYS: ReadonlySet<string> = new Set([
  'advance',
  'carried',
  'carries',
  'close',
  'counted',
  'expect',
  'on',
  'open',
  'report',
  'secure',
  'send',
  'token',
  'twoWay',
  'until',
  'wall',
]);

// helpers

/**
 * A transport server of the connections a conversation names, each under a handle of its own that a
 * connection opened again under the same name takes: it records what it sends on each, with the
 * credential it is given beside it, delivers what it is given, with what its transport carried, and
 * says what each carries — a credential, and whether in the clear, as its open declared.
 */
const createConnections = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: TransportServerConnectionHandle];
    connection: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ];
    message: [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle];
  }>();
  const handles = new Map<string, TransportServerConnectionHandle>();
  const opened = new Set<TransportServerConnectionHandle>();
  const oneWay = new Set<TransportServerConnectionHandle>();
  const carryingNone = new Set<TransportServerConnectionHandle>();
  const inTheClear = new Set<TransportServerConnectionHandle>();
  const sent = new Map<TransportServerConnectionHandle, ISent[]>();
  const handleOf = (name: string): TransportServerConnectionHandle => {
    const port = 50_001 + handles.size;
    const handle = handles.get(name) ?? (`type=WS;ip=127.0.0.1;port=${port}` as const);

    handles.set(name, handle);

    return handle;
  };
  const queueOf = (connectionHandle: TransportServerConnectionHandle) => {
    const queue = sent.get(connectionHandle) ?? [];

    sent.set(connectionHandle, queue);

    return queue;
  };
  const transport: IServerTransportLike = {
    carriesCredential: (connectionHandle) => {
      return !carryingNone.has(connectionHandle);
    },
    close: () => {
      return Promise.resolve(false);
    },
    isSecure: (connectionHandle) => {
      return !inTheClear.has(connectionHandle);
    },
    isTwoWay: (connectionHandle) => {
      return !oneWay.has(connectionHandle);
    },
    // oxlint-disable-next-line typescript/unbound-method -- `createEmitter` returns arrow functions, which have no `this` to lose
    off: emitter.off,
    // oxlint-disable-next-line typescript/unbound-method -- as above
    on: emitter.on,
    stop: () => {
      return Promise.resolve();
    },
    send: ({ credential, data }, connectionHandle) => {
      queueOf(connectionHandle).push({ bytes: bytesOf(data), credential });

      return Promise.resolve();
    },
  };

  return {
    close: (name: string): void => {
      opened.delete(handleOf(name));
      emitter.emit('close', false, handleOf(name));
    },
    /** Closes every connection still open. */
    closeAll: (): void => {
      for (const handle of opened) {
        emitter.emit('close', false, handle);
      }

      opened.clear();
    },
    /** How many envelopes were sent and are not taken yet, on every connection. */
    count: (): number => {
      return [...sent.values()].reduce((total, queue) => {
        return total + queue.length;
      }, 0);
    },
    handleOf,
    message: (name: string, { credential, data }: { credential?: string; data: Data }): void => {
      emitter.emit('message', { credential, data }, handleOf(name));
    },
    /** The next envelope sent on the connection `name`, and what its transport was given with it. */
    next: (name: string): ISent | undefined => {
      return queueOf(handleOf(name)).shift();
    },
    open: (
      name: string,
      {
        carriesCredential,
        isSecure,
        isTwoWay,
      }: { carriesCredential: boolean; isSecure: boolean; isTwoWay: boolean }
    ): void => {
      const handle = handleOf(name);

      for (const [set, is] of [
        [oneWay, isTwoWay],
        [carryingNone, carriesCredential],
        [inTheClear, isSecure],
      ] as const) {
        if (is) {
          set.delete(handle);
        } else {
          set.add(handle);
        }
      }

      opened.add(handle);
      emitter.emit('connection', {}, {}, handle);
    },
    transport,
    /** What was sent and not taken yet, by the name of its connection. */
    untaken: (): Record<string, (IExpected | undefined)[]> => {
      const untaken: Record<string, (IExpected | undefined)[]> = {};

      for (const [name, handle] of handles) {
        const queue = sent.get(handle) ?? [];

        if (queue.length > 0) {
          untaken[name] = queue.map(({ bytes }) => {
            return expectedOf(bytes);
          });
        }
      }

      return untaken;
    },
  };
};

/**
 * The envelope sent, as `expected` writes it: its failure's detail only where `expected` gives one,
 * informative elsewhere.
 */
const actualOf = (bytes: Uint8Array | undefined, expected: IExpected): IExpected | undefined => {
  const actual = bytes === undefined ? undefined : expectedOf(bytes);

  if (
    bytes === undefined ||
    actual?.failure === undefined ||
    expected.failure?.detail === undefined
  ) {
    return actual;
  }

  return { ...actual, failure: { ...actual.failure, detail: failureDetailOf(bytes) } };
};

/** `send` with each token it names, `<name>`, as the 16 bytes a step before kept under that name. */
const withTokens = (send: string, tokens: ReadonlyMap<string, Uint8Array>): string => {
  return send.replaceAll(TOKEN_NAME, (_, name: string) => {
    const token = tokens.get(name);

    if (token === undefined) {
      throw new Error(`no step before named a token ${name}`);
    }

    return hexadecimalOf(token);
  });
};

/**
 * What `take` gives, once it gives anything, or `undefined` once the patience is over: what the
 * server does as a JWT verifies, off the event loop, comes in its time.
 */
const within = async <Value>(take: () => Value | undefined): Promise<Value | undefined> => {
  const deadline = Date.now() + PATIENCE;

  for (let taken = take(); ; taken = take()) {
    if (taken !== undefined || Date.now() >= deadline) {
      return taken;
    }

    await sleep(POLL);
  }
};

/** Lets what the server does settle: turns of the event loop, until three in a row add nothing. */
const settle = async (count: () => number): Promise<void> => {
  let quiet = 0;
  let last = count();

  while (quiet < 3) {
    await new Promise(setImmediate);

    const now = count();

    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
};

/** An exposition's lines, each by its series — its name and its labels — in its order. */
const seriesOf = (text: string): Map<string, string> => {
  return new Map(
    text
      .split('\n')
      .filter((line) => {
        return line !== '' && !line.startsWith('#');
      })
      .map((line) => {
        return [line.slice(0, line.lastIndexOf(' ')), line];
      })
  );
};

// definition

/**
 * Plays `conversation` against a server of the interop service, on a test clock only its steps
 * move, given `metricsRegistry` when there is one: each `counted` step reads its exposition once
 * the step before settled, and expects the lines of the series that moved since the case began, or
 * the last counted, every other series unmoved, none made or gone.
 */
export const playConversation = async (
  { limits, pacing, relay, steps }: IConversation,
  { metricsRegistry }: { metricsRegistry?: IMetricsRegistry | undefined }
): Promise<void> => {
  // the clock every layer runs on: only a step that moves time moves it
  const clock = createTestClock(Date.parse(WALL_CLOCK));
  const connections = createConnections();
  const relayOptions: IRelayOptions = {
    ...(relay?.beforeRoute === undefined ? {} : { beforeRoute: ADMISSIONS[relay.beforeRoute] }),
    ...(relay?.verifies === undefined ? {} : { verifies: relay.verifies }),
  };
  const server = createServer<IServerTransportLike, string>(
    { transport: connections.transport },
    {
      clock,
      // the interop service's, none of a JWT under limits that hold none
      credentials: interopCredentialsOf(clock, limits),
      limits,
      metricsRegistry,
      pacing,
      relay: relayOptions,
    }
  );
  const { router } = server;
  const reports: IReport[] = [];
  // the tokens its answers announced, by the names its steps gave them
  const tokens = new Map<string, Uint8Array>();
  const count = (): number => {
    return connections.count() + reports.length;
  };
  // what the server did that its conversation did not expect: nothing, between steps
  const expectNothingMore = (when: string): void => {
    expect({ reports, sent: connections.untaken() }, when).toEqual({ reports: [], sent: {} });
  };

  router.on('error', (error, connectionHandle) => {
    reports.push({
      code: error instanceof FailureError ? error.code : 'exception',
      connectionHandle,
    });
  });
  offerInterop(server);

  // every series at 0 as the case begins, once the server is built
  let exposed = seriesOf(metricsRegistry?.exposition().text ?? '');

  if (
    steps.every((step) => {
      return step.open === undefined;
    })
  ) {
    connections.open(ONLY_CONNECTION, {
      carriesCredential: true,
      isSecure: true,
      isTwoWay: true,
    });
  }

  try {
    for (const [index, step] of steps.entries()) {
      const at = `step ${String(index + 1)}`;
      const on = step.on ?? ONLY_CONNECTION;

      expect(
        Object.keys(step).filter((key) => {
          return !STEP_KEYS.has(key);
        }),
        `${at}: the keys this player does not read`
      ).toEqual([]);

      if (step.open !== undefined || step.send !== undefined || step.close === true) {
        expectNothingMore(`before ${at}`);
      }

      if (step.open !== undefined) {
        connections.open(step.open, {
          carriesCredential: step.carries !== false,
          isSecure: step.secure !== false,
          isTwoWay: step.twoWay !== false,
        });
        await settle(count);
      }

      if (step.send !== undefined) {
        connections.message(on, {
          ...(step.carried === undefined ? {} : { credential: step.carried }),
          data: fromHexadecimal(withTokens(step.send, tokens)),
        });
        await settle(count);
      }

      if (step.close === true) {
        connections.close(on);
        await settle(count);
      }

      if (step.expect !== undefined) {
        const next = await within(() => {
          return connections.next(on);
        });
        const bytes = next?.bytes;

        expect(actualOf(bytes, step.expect), at).toEqual(step.expect);

        // a request the server sends — a command, a relay's leg B — beside what its transport
        // was given
        if (step.expect.kind === EnvelopeKind.REQUEST) {
          expect(next?.credential, `${at}: what its transport carried`).toBe(step.carried);
        }

        const token = bytes === undefined ? undefined : announcedTokenOf(bytes);

        if (step.token !== undefined && token !== undefined) {
          tokens.set(step.token, token);
        }
      }

      if (step.report !== undefined) {
        const report = await within(() => {
          return reports.shift();
        });

        expect(report?.code, at).toBe(step.report);

        if (step.on !== undefined) {
          expect(report?.connectionHandle, at).toBe(connections.handleOf(step.on));
        }
      }

      if (step.until !== undefined) {
        await expect
          .poll(
            () => {
              return duesOn(clock);
            },
            { message: `${at}: the timers armed`, timeout: PATIENCE }
          )
          .toContain(step.until.timer);
      }

      if (step.advance !== undefined) {
        await clock.tickAsync(step.advance);
        await settle(count);
      }

      if (step.wall !== undefined) {
        clock.setSystemTime(clock.Date.now() + step.wall);
      }

      if (step.counted !== undefined) {
        await settle(count);

        const now = seriesOf(metricsRegistry?.exposition().text ?? '');

        expect([...now.keys()], `${at}: the series, none made or gone`).toEqual([
          ...exposed.keys(),
        ]);
        expect(
          [...now].flatMap(([series, line]) => {
            return exposed.get(series) === line ? [] : [line];
          }),
          `${at}: the series that moved`
        ).toEqual(step.counted);
        exposed = now;
      }
    }

    expectNothingMore('at the end');
  } finally {
    connections.closeAll();
    await server[Symbol.asyncDispose]();
  }
};
