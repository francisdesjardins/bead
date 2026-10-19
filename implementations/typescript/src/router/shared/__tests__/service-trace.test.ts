import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { type IClock } from '../../../transport/shared/clock';
import { SERVER_CONNECTION_HANDLE } from '../constants';
import {
  CLIENT_FAILURES,
  createServiceManager,
  FailureError,
  type IRouterLike,
} from '../service-manager';
import { createServiceTrace, tracedFailureOf } from '../service-trace';
import type { IDebugEvent } from '../types';
import {
  answerOf,
  connectionHandle,
  createFakeRouter,
  echo,
  encode,
  header,
  propsOf,
  recordDebug,
  serializer,
  serverSerializer,
} from './service-manager-fixtures';

// definition

test.describe('createServiceManager', () => {
  test.describe('debug', () => {
    test('is on only while someone listens', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const listener = () => {
        return undefined;
      };

      expect(manager.isDebugging).toBe(false);

      manager.on('debug', listener);
      expect(manager.isDebugging).toBe(true);

      manager.off('debug', listener);
      expect(manager.isDebugging).toBe(false);
    });

    // debugging 4.1, 4.1.1, 4.1.2, 4.1.3, 4.1.4, 4.1.6 and 4.1.8
    test('tells each step of a request, with copies and, once answered, a duration', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const seen = recordDebug(manager);
      const payload = { text: 'hello' };

      await manager.getRequest(echo, { serializer })(payload)();
      payload.text = 'changed after';

      expect(
        seen.map(({ info }) => {
          return [info.direction, info.type, info.tx, info.rx];
        })
      ).toEqual([
        ['tx', 'request', { text: 'hello' }, undefined],
        ['rx', 'request', { text: 'hello' }, { text: 'hello' }],
      ]);
      expect(seen[0]?.info.duration).toBeUndefined();
      expect(seen[1]?.info.duration).toBeGreaterThanOrEqual(0);
      expect(seen[1]?.info.duration).toBeLessThan(1_000);
      expect(seen[1]?.info).toMatchObject({
        procedureId: 1,
        procedureName: 'echo',
        serviceId: 2,
        serviceRevision: 3,
      });
    });

    // debugging 4.1.10, 4.2.1 and 4.2.2
    test('tells a call made and its answer with the call id its router drew, and their connection', async () => {
      const client = createFakeRouter('client');
      const server = createFakeRouter('server');
      const asking = createServiceManager(client.router);
      const commanding = createServiceManager(
        server.router as IRouterLike<TransportServerConnectionHandle>
      );
      const seen = recordDebug(asking);
      const commanded = recordDebug(commanding);
      // how many calls the router took as each step is told
      const taken: number[] = [];

      asking.on('debug', () => {
        taken.push(client.calls.request.length);
      });

      await asking.getRequest(echo, { serializer })({ text: 'a' })();
      await commanding.getCommand(echo, { serializer })({ text: 'b' })({ connectionHandle });

      expect(
        [...seen, ...commanded].map(({ info }) => {
          return [info.direction, info.callId, info.connectionHandle];
        })
      ).toEqual([
        ['tx', 7, 'server'],
        ['rx', 7, 'server'],
        ['tx', 7, connectionHandle],
        ['rx', 7, connectionHandle],
      ]);
      // * the tx step comes once the router took the call, which drew its id
      expect(taken).toEqual([1, 1]);
    });

    // debugging 4.2.1 and 4.4
    test('tells a call its router refuses before drawing an id with none, its tx step then its rx step', async () => {
      const { control, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const refusal = new FailureError({ ...CLIENT_FAILURES.sessionRequired, origin: 'local' });

      control.callId = undefined;
      control.answer = () => {
        return Promise.reject(refusal);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(refusal);
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.callId, info.connectionHandle, error];
        })
      ).toEqual([
        ['tx', undefined, undefined, null],
        ['rx', undefined, undefined, refusal],
      ]);
    });

    // debugging 4.4
    test('tells a call made over a router that draws no id with none, its tx step then its rx step', async () => {
      const { control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);

      control.callId = undefined;

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).resolves.toEqual({
        text: 'x',
      });
      expect(
        seen.map(({ info }) => {
          return [info.direction, info.callId, info.rx];
        })
      ).toEqual([
        ['tx', undefined, undefined],
        ['rx', undefined, { text: 'x' }],
      ]);
    });

    test('raises deprecated before the call’s tx step', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const heard: string[] = [];

      manager.on('deprecated', () => {
        heard.push('deprecated');
      });
      manager.on('debug', (_error, { direction }) => {
        heard.push(direction);
      });

      await manager.getRequest(
        { ...echo, deprecation: { message: 'use echo2' } },
        { serializer }
      )({
        text: 'a',
      })();

      expect(heard).toEqual(['deprecated', 'tx', 'rx']);
    });

    // debugging 3.2, 4.1.5 and 4.1.6
    test("reads its router's clock: a call's start on the wall clock, its duration on the monotonic reading", async () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      const { control, router } = createFakeRouter('server', clock);
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);

      control.answer = (payload) => {
        return new Promise((resolve) => {
          clock.setTimeout(() => {
            resolve(answerOf(payload));
          }, 250);
        });
      };

      const answering = manager.getRequest(echo, { serializer })({ text: 'hello' })();

      // a wall clock set back by hand moves no duration
      clock.setSystemTime(Date.UTC(2025, 11, 31));
      await clock.tickAsync(250);
      await answering;

      expect(
        seen.map(({ info: { duration, startedAt } }) => {
          return { duration, startedAt };
        })
      ).toEqual([
        { duration: undefined, startedAt: Date.UTC(2026, 0, 1) },
        { duration: 250, startedAt: Date.UTC(2026, 0, 1) },
      ]);
    });

    // debugging 4.1.6
    test('tells a duration in whole milliseconds, its fraction dropped', async () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      const { control, router } = createFakeRouter('server', clock);
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      // the readings, as Bead reads them
      const given: IClock = clock;
      const before = given.performance.now();

      control.answer = async (payload) => {
        await clock.tickAsync(30.6);

        return answerOf(payload);
      };

      await manager.getRequest(echo, { serializer })({ text: 'hello' })();

      // the call took 30.6 ms of the monotonic reading, and is told as 30
      expect(given.performance.now() - before).toBeCloseTo(30.6);
      expect(
        seen.map(({ info }) => {
          return info.duration;
        })
      ).toEqual([undefined, 30]);
    });

    // debugging 4.1.5, 4.2.5 and 4.2.6
    test('a notification starts as it is heard or sent, and a failed notify tells its failure at that same start', async () => {
      const start = Date.UTC(2026, 0, 1);
      const clock = createTestClock(start);
      const client = createFakeRouter('client', clock);
      const server = createFakeRouter('server', clock);
      const hearing = createServiceManager(client.router);
      const notifying = createServiceManager(server.router);
      const notification = hearing.getNotification(echo, { serializer });
      const resolver = notifying.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );
      const failure = new Error('gone');
      const { promise: gate, resolve: open } = Promise.withResolvers<void>();

      await notification({ text: 's' }, () => {
        return undefined;
      })();

      const heard = recordDebug(hearing);
      const sent = recordDebug(notifying);

      await clock.tickAsync(10);
      client.deliver(echo, { text: 'news' });
      await clock.tickAsync(10);

      // the router fails the notify 30 ms after it was sent
      server.control.notifyError = failure;
      server.control.notifyGate = gate;

      const failing = resolver.notify({ text: 'late' });

      await clock.tickAsync(30);
      open();
      await failing;

      expect(
        heard.map(({ info: { direction, duration, startedAt } }) => {
          return [direction, startedAt, duration];
        })
      ).toEqual([['rx', start + 10, undefined]]);
      expect(
        sent.map(({ error, info: { duration, startedAt } }) => {
          return [error, startedAt, duration];
        })
      ).toEqual([
        [null, start + 20, undefined],
        [failure, start + 20, undefined],
      ]);
    });

    // debugging 3.1, 3.2 and 3.4
    test('reads no clock for a call made, a request answered, a notification sent and one heard while nobody listens, and three for a call with a listener', async () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      const client = createFakeRouter('client', clock);
      const server = createFakeRouter('server', clock);
      const hearing = createServiceManager(client.router);
      const notifying = createServiceManager(server.router);
      const notification = hearing.getNotification(echo, { serializer });
      const resolver = notifying.getNotificationResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        return response(request.payload);
      });
      const asking = hearing.getRequest(echo, { serializer });
      // the readings `run` takes of the wall clock and of the monotonic one, each apart
      const readingsOf = async (run: () => Promise<unknown>): Promise<[number, number]> => {
        const { monotonic, wall } = clock.readings;

        await run();

        return [clock.readings.wall - wall, clock.readings.monotonic - monotonic];
      };
      const readEach = async (): Promise<[number, number][]> => {
        return [
          await readingsOf(() => {
            return asking({ text: 'x' })();
          }),
          await readingsOf(() => {
            return resolver(propsOf(encode({ text: 'hi' })));
          }),
          await readingsOf(() => {
            return resolver.notify({ text: 'news' });
          }),
          await readingsOf(async () => {
            client.deliver(echo, { text: 'news' });
            await sleep(0);
          }),
        ];
      };

      await notification({ text: 's' }, () => {
        return undefined;
      })();

      expect(await readEach()).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ]);

      for (const manager of [hearing, notifying]) {
        manager.on('debug', () => {
          return undefined;
        });
      }

      // a call's start on both clocks, and its end on the monotonic one; a notification's on the
      // wall clock alone (spec/debugging.md 3.2)
      expect(await readEach()).toEqual([
        [1, 2],
        [1, 2],
        [1, 0],
        [1, 0],
      ]);
    });

    // debugging 2.2 and 2.3
    test('a debug listener that throws on the answer is reported through the router, and the call resolves with its result, each step told', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen: string[] = [];
      const heard: string[] = [];
      const failure = new Error('listener bug');

      manager.on('debug', (_error, info) => {
        seen.push(info.direction);

        if (info.direction === 'rx') {
          throw failure;
        }
      });
      // a listener after it hears each step all the same
      manager.on('debug', (_error, info) => {
        heard.push(info.direction);
      });

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).resolves.toEqual({
        text: 'x',
      });
      expect(seen).toEqual(['tx', 'rx']);
      expect(heard).toEqual(['tx', 'rx']);
      expect(calls.report).toEqual([{ connectionHandle: undefined, error: failure }]);
    });

    // debugging 2.2 and 2.3
    test('a request is answered as a debug listener throws on its rx step, the error reported through the router with its connection', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failure = new Error('listener bug');

      manager.on('debug', (_error, info) => {
        if (info.direction === 'rx') {
          throw failure;
        }
      });

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond).toEqual([
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi' }) } },
      ]);
      expect(calls.report).toEqual([{ connectionHandle, error: failure }]);
    });

    test('a payload debug cannot copy is told as it is, and the call goes on', async () => {
      const { control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const odd = {
        text: 'x',
        toJSON: () => {
          return { text: 'x' };
        },
      };

      control.answer = () => {
        return Promise.resolve(answerOf(encode({ text: 'y' })));
      };

      await expect(manager.getRequest(echo, { serializer })(odd)()).resolves.toEqual({
        text: 'y',
      });
      expect(seen[0]?.info.tx).toBe(odd);
    });
  });
});

test.describe('createServiceTrace', () => {
  test('tells its observer each step while someone listens, the server named on a client, its duration once answered, and nothing while nobody does', async () => {
    const clock = createTestClock(Date.UTC(2026, 0, 1));
    const emitted: { connectionHandle: string | undefined; error: unknown; info: IDebugEvent }[] =
      [];
    let isListening = false;
    const serviceTrace = createServiceTrace<string>(
      {
        emit: (event) => {
          emitted.push(event);
        },
        isDebugging: () => {
          return isListening;
        },
      },
      {
        clock,
        side: () => {
          return 'client';
        },
      }
    );
    const started = serviceTrace.startedNow();

    serviceTrace.trace(echo, {
      callId: 1,
      direction: 'tx',
      started,
      tx: { text: 'hi' },
      type: 'request',
    });
    expect(serviceTrace.isDebugging()).toBe(false);
    expect(emitted).toEqual([]);

    isListening = true;
    await clock.tickAsync(250);
    serviceTrace.trace(echo, {
      callId: 1,
      direction: 'rx',
      isAnswered: true,
      rx: { text: 'hi!' },
      started,
      type: 'request',
    });

    expect(serviceTrace.isDebugging()).toBe(true);
    expect(emitted).toEqual([
      {
        connectionHandle: undefined,
        error: null,
        info: expect.objectContaining({
          callId: 1,
          connectionHandle: SERVER_CONNECTION_HANDLE,
          direction: 'rx',
          duration: 250,
          procedureName: 'echo',
          rx: { text: 'hi!' },
          startedAt: Date.UTC(2026, 0, 1),
        }),
      },
    ]);
    expect(tracedFailureOf(new Error('no failure'))).toBeUndefined();
  });
});
