// ── Conversations ─────────────────────────────────────────────────────────────

// Bead's conversations, `spec/conversations.json`, played against Bead's TypeScript server of the interop
// service: what its clients send, on one connection or on each a conversation opens, what the server
// sends back on each and reports. The C# server plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  INTEROP_SERVICE,
  interopCredentialsOf,
  interopVerifierOf,
  type InteropServer,
  JSON_SERIALIZER,
  offerInterop,
  offerInteropClient,
  procedureOf,
} from '../../../../interop/offer';
import { createServer } from '../../../server/server';
import { createTestClock, duesOn } from '../../../transport/shared/__tests__/fixtures';
import type { IServerTransportLike } from '../../../server/types';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createEmitter } from '../../../transport/shared/emitter';
import type { Data, ITransportMessage } from '../../../transport/shared/types';
import { createRouterClient } from '../../client/router-client';
import { bytesOf } from '../../shared/envelope';
import { createServiceManager } from '../../shared/service-manager';
import { createPipedTransports } from '../../shared/__tests__/fixtures';
import type {
  IJwtSetKey,
  IProcedure,
  IServiceManager,
  RouterLimitsOptions,
  ServerConnectionHandle,
} from '../../shared/types';
import { fromHexadecimal } from '../../shared/__tests__/vectors';
import {
  createRouterServer,
  EnvelopeKind,
  FailureError,
  type IRelayOptions,
  type PacingLimitsOptions,
  requireSession,
  requireSessionOrCredential,
  SERVER_FAILURES,
} from '../router-server';
import { createSessionManager } from '../session-manager';
import {
  announcedTokenOf,
  expectedOf,
  failureDetailOf,
  hexadecimalOf,
  type IExpected,
} from './expected-envelope';

// interfaces

/** One step of a conversation: what the test does, or what the server does next, on its connection. */
interface IStep {
  advance?: number;
  /**
   * Beside a send, what the client's transport carried with it; beside a request's expect, what the
   * server's transport was given with it; none when absent.
   */
  carried?: string;
  /** Beside an open, false for a connection whose transport carries no credential. */
  carries?: false;
  close?: true;
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

/** What the server reported to its application, and the connection it came with. */
interface IReport {
  code: number | 'exception';
  connectionHandle: TransportServerConnectionHandle;
}

interface IConversation {
  limits?: RouterLimitsOptions;
  pacing?: PacingLimitsOptions;
  name: string;
  /** The server's relay's options, its admission by the name both sides give it. */
  relay?: { beforeRoute?: 'requireSession' | 'requireSessionOrCredential'; verifies?: true };
  steps: IStep[];
}

/** An envelope the server sent, and the credential its transport was given with it. */
interface ISent {
  bytes: Uint8Array;
  credential: string | undefined;
}

// constants

const { conversations: CONVERSATIONS, wallClock: WALL_CLOCK } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/conversations.json', import.meta.url), 'utf8')
) as { conversations: IConversation[]; wallClock: string };

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
    off: emitter.off,
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

/** A service manager that records the procedures given resolvers, and makes nothing else. */
const createRegistrations = <Handle extends string>() => {
  const names: string[] = [];
  const record = (procedure: IProcedure) => {
    names.push(procedure.procedureName);

    return () => {
      return undefined;
    };
  };
  const services = {
    getCommand: () => {
      return () => {
        return () => {
          return Promise.resolve();
        };
      };
    },
    getCommandResolver: record,
    getNotificationResolver: record,
    getRequestResolver: record,
  } as unknown as IServiceManager<Handle>;

  return { names, services };
};

// definition

test('every procedure of the interop manifest is offered, on the side it names', () => {
  const server = createRegistrations<TransportServerConnectionHandle>();
  const client = createRegistrations<ServerConnectionHandle>();
  const namesOf = (isOfferedByClient: boolean): string[] => {
    return INTEROP_SERVICE.procedures
      .filter(({ offeredBy }) => {
        return (offeredBy === 'client') === isOfferedByClient;
      })
      .map(({ procedureName }) => {
        return procedureName;
      })
      .toSorted();
  };

  offerInterop({
    requireSession: Object.assign(
      () => {
        return true;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    ),
    router: { failures: SERVER_FAILURES },
    services: server.services,
    sessions: {},
  } as unknown as InteropServer);
  offerInteropClient(client.services);

  expect(server.names.toSorted()).toEqual(namesOf(false));
  expect(client.names.toSorted()).toEqual(namesOf(true));
});

test("slow waits on its server's clock, which its router runs on, and answers once it has passed", async () => {
  const clock = createTestClock();
  const pipe = createPipedTransports({ connectionHandle: 'type=WS;ip=127.0.0.1;port=50001' });
  using router = createRouterServer(pipe.server, { clock });
  using sessions = createSessionManager<string>({ clock });
  using caller = createRouterClient(pipe.client);
  let answered: unknown;

  offerInterop({
    requireSession: Object.assign(
      () => {
        return true;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    ),
    router,
    services: createServiceManager(router),
    sessions,
  } as unknown as InteropServer);
  pipe.open();

  const slow = createServiceManager(caller)
    .getRequest(procedureOf('slow'), { serializer: JSON_SERIALIZER })({ milliseconds: 1_000 })()
    .then((payload) => {
      answered = payload;
    });

  await clock.tickAsync(999);

  expect(answered).toBeUndefined();

  await clock.tickAsync(1);
  await slow;

  expect(answered).toBe(1_000);
});

test('the interop service’s ELSEWHERE verifier holds, refuses and fails each value as its words say, at its time on its server’s clock', async () => {
  const clock = createTestClock(Date.parse(WALL_CLOCK));
  const verify = interopVerifierOf(clock);
  const letters = 'abcdefghijklmnopqrstuvwxyzabcdef';
  // a value, and what it settles with: its sub and its end, none, or a rejection; and after how long
  const rows: [string, unknown, number?][] = [
    ['Interop sub=ada', ['ada', undefined]],
    ['interop sub=ada', ['ada', undefined]],
    ['INTEROP sub=ada', ['ada', undefined]],
    ['Interop sub=a', ['a', undefined]],
    [`Interop sub=${letters}`, [letters, undefined]],
    [`Interop sub=${letters}a`, 'none'],
    ['Interop sub=Ada', 'none'],
    ['Interop  sub=ada', 'none'],
    ['Interop sub=ada,after=1', 'none'],
    ['Interop sub=ada, after=0', 'none'],
    ['Interop sub=ada, after=2147483647', ['ada', undefined], 2_147_483_647],
    ['Interop sub=ada, after=2147483648', 'none'],
    ['Interop sub=ada, end=9007199254740991', ['ada', 9_007_199_254_740_991]],
    ['Interop sub=ada, end=9007199254740992', 'none'],
    ['Interop sub=ada, end=1, after=1', 'none'],
    ['Interop sub=ada, SUB=x', 'none'],
    ['Interop fail=true', 'rejects'],
    ['Interop fail=true, after=5', 'rejects', 5],
    ['Interop fail=TRUE', 'none'],
    ['Interop sub=ada, fail=true', 'none'],
    ['Interop', 'none'],
    ['Interop ', 'none'],
    ['Bearer mF_9.B5f-4.1JqM', 'none'],
    ['Basic YWRh', 'none'],
  ];

  for (const [carried, expected, after] of rows) {
    let outcome: unknown = 'pending';

    void verify(carried).then(
      (session) => {
        outcome =
          session === undefined
            ? 'none'
            : [
                (session.data as { sub: string }).sub === session.id ? session.id : 'data?',
                session.end,
              ];
      },
      (reason: unknown) => {
        outcome =
          (reason as Error).message === 'this verifier fails, on purpose' ? 'rejects' : reason;
      }
    );

    if (after !== undefined) {
      await clock.tickAsync(after - 1);

      expect(outcome, `${carried}, a millisecond short`).toBe('pending');

      await clock.tickAsync(1);
    }

    await sleep(0);

    expect(outcome, carried).toEqual(expected);
  }
});

test("the interop service's key set answers each issuer it names as its words say, on its server's clock, whatever its signal, and fails at once for any other", async () => {
  const keysIssuer = 'https://keys.interop.bead.example';
  const rotatedIssuer = 'https://rotated.interop.bead.example';
  const stalledIssuer = 'https://stalled.interop.bead.example';
  const kid = '018c0ae5-4d9b-471b-bfd6-eef314bc7037';
  const second = 1_000;
  const clock = createTestClock();
  const keySet = interopCredentialsOf(clock).keySet!;
  // the signal of every ask, aborted before it goes
  const signal = AbortSignal.abort();
  // what each ask came to, in the order they went: its keys, or nothing yet
  const answers: (readonly IJwtSetKey[] | 'pending')[] = [];
  const ask = (issuer: string): Promise<readonly IJwtSetKey[]> => {
    const index = answers.push('pending') - 1;

    return Promise.resolve(keySet.ask(issuer, signal)).then((keys) => {
      answers[index] = keys;

      return keys;
    });
  };

  expect(keySet.issuers).toEqual([keysIssuer, rotatedIssuer, stalledIssuer]);

  // the rotated issuer's keys at its first ask alone; the stalled one's never, no timer armed
  const asked = [ask(keysIssuer), ask(rotatedIssuer), ask(rotatedIssuer)];

  void ask(stalledIssuer);

  expect(duesOn(clock)).toEqual([second, second, second]);

  await clock.tickAsync(second - 1);

  expect(answers).toEqual(['pending', 'pending', 'pending', 'pending']);

  await clock.tickAsync(1);

  const answered = await Promise.all(asked);

  expect(
    answered.map((keys) => {
      return keys.length;
    })
  ).toEqual([1, 1, 0]);
  expect([answered[0]?.[0]?.jwk.kid, answered[1]?.[0]?.jwk.kid]).toEqual([kid, kid]);
  expect(answered[0]?.[0]?.jwk.k).not.toBe(answered[1]?.[0]?.jwk.k);
  expect(answers[3]).toBe('pending');
  expect(duesOn(clock)).toEqual([]);

  // its asks counted per key set built: another server's answers its first anew
  const another = interopCredentialsOf(clock).keySet!.ask(rotatedIssuer, signal);

  await clock.tickAsync(second);

  expect(await another).toHaveLength(1);

  // asked for an issuer it does not name, it fails at once, its clock unmoved and no timer armed
  let failure: unknown = 'pending';

  void Promise.resolve(keySet.ask('https://unnamed.interop.bead.example', signal)).catch(
    (reason: unknown) => {
      failure = (reason as Error).message;
    }
  );
  await sleep(0);

  expect(duesOn(clock)).toEqual([]);
  expect(failure).toBe(
    'the interop key set answers for no issuer https://unnamed.interop.bead.example'
  );
});

test.describe('the conversations', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  for (const { limits, name, pacing, relay, steps } of CONVERSATIONS) {
    test(name, async () => {
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
        }

        expectNothingMore('at the end');
      } finally {
        connections.closeAll();
        await server[Symbol.asyncDispose]();
      }
    });
  }
});
