import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createTestClock, durationsOf } from '../../../transport/shared/__tests__/fixtures';
import { type IClock, PLATFORM_CLOCK } from '../../../transport/shared/clock';
import { CancelError, TimeoutError } from '../../../transport/shared/errors';
import { createSessionManager } from '../../server/session-manager';
import { failureTableOf } from '../constants';
import {
  CLIENT_FAILURES,
  createServiceManager,
  DisconnectError,
  FailureError,
  FailureScope,
  ProgrammerError,
  ProtocolCode,
  REQUEST_DEFAULTS,
  resolveRequestOptions,
  SERVER_FAILURES,
  type IBeforeRequest,
  type IDebugEvent,
  type INotificationLike,
  type IProcedure,
  type IProcedureAddress,
  type IProtocolFailure,
  type IReceivedFailure,
  type IRequestHeader,
  type IRequestResolver,
  type IRequestResolverProps,
  type IResolvedRequestOptions,
  type IRouterResult,
  type IRouterLike,
  type IServiceManager,
  type NotificationKey,
  type RouterAnswer,
  type RouterSide,
} from '../service-manager';

// helpers

interface IText {
  text: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (value: unknown): Uint8Array => {
  return encoder.encode(JSON.stringify(value));
};

const decode = (bytes: Uint8Array): unknown => {
  return JSON.parse(decoder.decode(bytes));
};

/** JSON both ways, whichever side asks. */
const serializer = {
  decode: (bytes: Uint8Array) => {
    return decode(bytes) as IText;
  },
  encode: (value: IText) => {
    return encode(value);
  },
  decodeNotification: (bytes: Uint8Array) => {
    return decode(bytes) as IText;
  },
};

const serverSerializer = {
  ...serializer,
  encodeNotification: (notification: IText) => {
    return encode(notification);
  },
};

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
/** A request's header, as the router hands it over. */
const header: IRequestHeader = { callId: 7, kind: 0x10, procedureId: 1, serviceId: 2 };
const connectionHandle = 'type=WS;ip=127.0.0.1;port=50001';

/** A request as its router hands it to a resolver: on `header`, carrying `payload`. */
const propsOf = (
  payload: Uint8Array,
  signal = new AbortController().signal
): IRequestResolverProps<typeof connectionHandle> => {
  return { connectionHandle, header, payload, signal };
};

/** A result carrying `payload`, as the router resolves a request with it: call 7's. */
const answerOf = (payload: Uint8Array): IRouterResult => {
  return { header: { callId: 7, kind: 0x11 }, payload };
};

/**
 * A router that records every call, answers each request with `answer`, and holds notifications;
 * it raises the failures of its `side`, a server's unless given, subscribes a request under its own
 * call id, and runs on `clock`, the platform's unless given.
 */
const createFakeRouter = (side: RouterSide = 'server', clock: IClock = PLATFORM_CLOCK) => {
  const keyOf = ({ procedureId, serviceId }: IProcedureAddress) => {
    return `${String(serviceId)}/${String(procedureId)}`;
  };
  const notifications = new Map<string, INotificationLike>();
  const calls = {
    notify: [] as {
      filter: ((connectionHandle: string) => boolean) | undefined;
      key: NotificationKey | undefined;
      payload: IText;
      procedure: IProcedureAddress;
    }[],
    registerNotification: [] as string[],
    registerResolver: [] as IRequestResolver[],
    request: [] as {
      payload: IText;
      request: {
        options: IResolvedRequestOptions;
        procedure: IProcedure;
        subscribes?: INotificationLike | undefined;
      };
    }[],
    respond: [] as { request: object; response: RouterAnswer }[],
    subscribe: [] as object[],
    unregisterNotification: [] as string[],
    /** What each `unregisterNotification` was told, apart. */
    unregisterOptions: [] as unknown[],
  };
  const control = {
    /** What a request resolves to; an echo of its payload unless replaced. */
    answer: (payload: Uint8Array): Promise<IRouterResult> => {
      return Promise.resolve(answerOf(payload));
    },
    notifyError: undefined as Error | undefined,
    /** What a notify waits on once recorded, before it settles: with `notifyError`, when set. */
    notifyGate: Promise.resolve(),
    /** What `respond` rejects with, once it recorded the answer; none unless set. */
    respondError: undefined as Error | undefined,
    /** What a registration waits on once the router holds it, as a subscription would. */
    subscribeGate: Promise.resolve(),
    subscribeError: undefined as Error | undefined,
    /** What `unregisterNotification` waits on before it takes the notification out. */
    unregisterGate: Promise.resolve(),
  };

  const router: IRouterLike = {
    clock,
    failures: failureTableOf(side),

    hasNotification: (notification) => {
      return notifications.get(keyOf(notification)) === notification;
    },
    notify: async (payload, { filter, key, procedure }) => {
      calls.notify.push({ filter, key, payload: decode(payload) as IText, procedure });
      await control.notifyGate;

      if (control.notifyError !== undefined) {
        throw control.notifyError;
      }
    },
    registerNotification: async (notification) => {
      calls.registerNotification.push(notification.procedureName);

      if (notifications.has(keyOf(notification))) {
        throw new ProgrammerError('already registered');
      }

      // held first, then subscribed, as a router over a broker does
      notifications.set(keyOf(notification), notification);
      await control.subscribeGate;

      if (control.subscribeError !== undefined) {
        throw control.subscribeError;
      }
    },
    registerResolver: (resolver) => {
      calls.registerResolver.push(resolver);
    },
    request: (payload, request) => {
      calls.request.push({ payload: decode(payload) as IText, request });

      return control.answer(payload);
    },
    subscribe: (request) => {
      calls.subscribe.push(request);

      return request.header.callId;
    },
    respond: (response, request) => {
      calls.respond.push({ request, response });

      return control.respondError === undefined
        ? Promise.resolve()
        : Promise.reject(control.respondError);
    },
    unregisterNotification: async (notification, options) => {
      calls.unregisterNotification.push(notification.procedureName);
      calls.unregisterOptions.push(options);
      await control.unregisterGate;
      notifications.delete(keyOf(notification));
    },
  };

  /** What the router does with a notification for `procedureAddress`. */
  const deliver = (procedureAddress: IProcedureAddress, notification: IText) => {
    void notifications.get(keyOf(procedureAddress))?.trigger(encode(notification));
  };

  /**
   * What the router does when its connection closes, or the server ends each subscription with
   * `failure`: it lets go of each, and tells it.
   */
  const drop = (failure?: IReceivedFailure) => {
    const dropped = [...notifications.values()];

    notifications.clear();

    for (const notification of dropped) {
      notification.drop?.(failure);
    }
  };

  /** Whether the router holds a notification of `procedureAddress`, whichever it is. */
  const holds = (procedureAddress: IProcedureAddress) => {
    return notifications.has(keyOf(procedureAddress));
  };

  return { calls, control, deliver, drop, holds, router };
};

const recordDebug = <Handle extends string>(manager: IServiceManager<Handle>) => {
  const seen: { error: unknown; info: IDebugEvent }[] = [];

  manager.on('debug', (error, info) => {
    seen.push({ error, info });
  });

  return seen;
};

// definition

test.describe('resolveRequestOptions', () => {
  test('fills what the options leave out, and leaves the options alone', () => {
    const options = { connectionHandle, destinationId: undefined };

    expect(REQUEST_DEFAULTS).toEqual({ timeout: 5_000 });
    expect(resolveRequestOptions()).toEqual({ ...REQUEST_DEFAULTS });
    // a destination is the call's alone, passed on as it is, left undefined included
    expect(resolveRequestOptions(options)).toEqual({
      ...REQUEST_DEFAULTS,
      connectionHandle,
      destinationId: undefined,
    });
    expect(resolveRequestOptions({ destinationId: 4, timeout: 10 })).toEqual({
      destinationId: 4,
      timeout: 10,
    });
    // a close on timeout only where the call or the defaults have one
    expect(resolveRequestOptions(undefined, { ...REQUEST_DEFAULTS, closeOnTimeout: true })).toEqual(
      { ...REQUEST_DEFAULTS, closeOnTimeout: true }
    );
    expect(
      resolveRequestOptions(
        { closeOnTimeout: false },
        { ...REQUEST_DEFAULTS, closeOnTimeout: true }
      )
    ).toEqual({ ...REQUEST_DEFAULTS, closeOnTimeout: false });
    expect(options).toEqual({ connectionHandle, destinationId: undefined });
  });
});

test.describe('createServiceManager', () => {
  test.describe('getRequest', () => {
    test('is named after its procedure and carries it', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const request = manager.getRequest(echo, { serializer });

      expect(request.name).toBe('echo');
      expect({ ...request }).toEqual(echo);
    });

    test('sends the encoded payload with the resolved options, and decodes the answer', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const request = manager.getRequest(echo, { serializer });

      await expect(request({ text: 'hello' })({ timeout: 100 })).resolves.toEqual({
        text: 'hello',
      });
      expect(calls.request).toEqual([
        {
          payload: { text: 'hello' },
          request: {
            options: { timeout: 100 },
            procedure: echo,
            subscribes: undefined,
          },
        },
      ]);
    });

    test('takes the manager’s defaults where the call says nothing, and its signal as given', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router, { defaults: { timeout: 50 } });
      const request = manager.getRequest(echo, { serializer });
      const { signal } = new AbortController();

      await request({ text: 'a' })();
      await request({ text: 'b' })({ destinationId: 2, signal, timeout: 9 });
      await createServiceManager(router, {
        // @ts-expect-error: a destination is a call's own, never a default
        defaults: { destinationId: 4 },
      }).getRequest(echo, { serializer })({ text: 'c' })();

      expect(
        calls.request.map(({ request: { options } }) => {
          return options;
        })
      ).toEqual([
        { timeout: 50 },
        { destinationId: 2, signal, timeout: 9 },
        { timeout: REQUEST_DEFAULTS.timeout },
      ]);
    });

    test('holds its default timeout as it is built, rounded, refusing 0, Infinity waiting on, building nothing for one refused', async () => {
      for (const { given, held, outcome, refusal } of durationsOf("a call's default timeout", {
        never: 'never',
        zero: 'refused',
      })) {
        const { calls, router } = createFakeRouter();
        const building = () => {
          return createServiceManager(router, { defaults: { timeout: given } });
        };

        if (outcome === 'refused') {
          expect(building, String(given)).toThrow(new ProgrammerError(refusal));

          continue;
        }

        await building().getRequest(echo, { serializer })({ text: 'a' })();

        expect(calls.request[0]?.request.options.timeout, String(given)).toBe(held);
      }
    });

    test('holds a call’s own timeout as it applies the defaults, traced and sent alike, refusing 0 before the trace and the deprecation, Infinity waiting on', async () => {
      for (const { given, held, outcome, refusal } of durationsOf("a call's timeout", {
        never: 'never',
        zero: 'refused',
      })) {
        const { calls, router } = createFakeRouter();
        const manager = createServiceManager(router);
        const seen = recordDebug(manager);
        const deprecated: unknown[] = [];
        const label = String(given);

        manager.on('deprecated', (procedure) => {
          deprecated.push(procedure);
        });

        const calling = manager.getRequest(
          { ...echo, deprecation: {} },
          { serializer }
        )({ text: 'a' })({ timeout: given });

        if (outcome === 'refused') {
          await expect(calling, label).rejects.toThrow(new ProgrammerError(refusal));
          expect([seen, deprecated, calls.request], label).toEqual([[], [], []]);

          continue;
        }

        await calling;

        // 1.4 ms is traced as 1, the very timeout the router is handed
        expect(
          [seen[0]?.info.options?.timeout, calls.request[0]?.request.options.timeout],
          label
        ).toEqual([held, held]);
      }
    });

    test('on a server’s router, names the connection it goes to, as the types require', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
      const request = manager.getRequest(echo, { serializer })({ text: 'a' });

      await request({ connectionHandle });

      // @ts-expect-error: a server's request names the connection it goes to
      await request();

      expect(calls.request[0]?.request.options.connectionHandle).toBe(connectionHandle);
    });

    test('rethrows what the router rejects with, and tells debug its failure, and only a failure’s', async () => {
      const { control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const failure = new FailureError({
        ...CLIENT_FAILURES.accessDenied,
        detail: 'no',
        origin: 'peer',
      });
      // what merely looks like a failure is not one
      const lookalike = Object.assign(new Error('reset'), { code: 'ECONNRESET', scope: 0 });

      control.answer = () => {
        return Promise.reject(failure);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(failure);
      expect(
        seen.map(({ error }) => {
          return error;
        })
      ).toEqual([null, failure]);
      expect(seen[1]?.info.rx).toEqual({ code: 33, detail: 'no', scope: FailureScope.PROTOCOL });

      control.answer = () => {
        return Promise.reject(lookalike);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(
        lookalike
      );
      expect(seen[3]?.info.rx).toBeUndefined();
    });

    test('a deprecated procedure emits "deprecated" at each call, and only a deprecated one', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const seen: unknown[][] = [];

      manager.on('deprecated', (...params) => {
        seen.push(params);
      });

      const old = manager.getRequest(
        { ...echo, deprecation: { message: 'use echo2' } },
        { serializer }
      );

      await old({ text: 'a' })();
      await old({ text: 'b' })();
      await manager.getRequest(echo, { serializer })({ text: 'c' })();
      // present, even empty, is deprecated
      await manager.getRequest({ ...echo, deprecation: {} }, { serializer })({ text: 'd' })();

      expect(seen).toEqual([
        [{ ...echo, deprecation: { message: 'use echo2' } }],
        [{ ...echo, deprecation: { message: 'use echo2' } }],
        [{ ...echo, deprecation: {} }],
      ]);
    });
  });

  test.describe('debug', () => {
    test('is on only while someone listens', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const listener = () => {
        return undefined;
      };

      expect(manager.debug).toBe(false);

      manager.on('debug', listener);
      expect(manager.debug).toBe(true);

      manager.off('debug', listener);
      expect(manager.debug).toBe(false);
    });

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

    test("refuses a clock that differs from its router's", () => {
      const { router } = createFakeRouter('server', createTestClock());

      expect(createServiceManager(router, { clock: router.clock })).toBeDefined();
      expect(() => {
        createServiceManager(router, { clock: PLATFORM_CLOCK });
      }).toThrow(
        new ProgrammerError(
          "a service manager runs on the clock of its router, one of its own, and was given another, the platform's"
        )
      );
    });

    test('a debug listener that throws on the answer rejects the call once, with no second trace', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const seen: string[] = [];
      const failure = new Error('listener bug');

      manager.on('debug', (_error, info) => {
        seen.push(info.direction);

        if (info.direction === 'rx') {
          throw failure;
        }
      });

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(failure);
      expect(seen).toEqual(['tx', 'rx']);
    });

    test('an answer that does not decode fails the call here, with its header and its call', async () => {
      const { control, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const answer = answerOf(encoder.encode('{not json'));

      control.answer = () => {
        return Promise.resolve(answer);
      };

      const failing = manager.getRequest(echo, { serializer })({ text: 'x' })({ destinationId: 4 });

      await expect(failing).rejects.toBeInstanceOf(FailureError);
      await expect(failing).rejects.toMatchObject({
        cause: expect.any(SyntaxError),
        code: ProtocolCode.PAYLOAD_UNDECODABLE,
        destinationId: 4,
        header: { callId: 7, kind: 0x11 },
        origin: 'local',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        scope: FailureScope.PROTOCOL,
        side: 'client',
      });
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, error instanceof FailureError, info.rx];
        })
      ).toEqual([
        ['tx', false, undefined],
        ['rx', true, expect.objectContaining({ code: ProtocolCode.PAYLOAD_UNDECODABLE })],
      ]);
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

  test.describe('getRequestResolver', () => {
    test('hands the router a procedure’s payload limit, with its requests and its resolver, and nothing else it carries', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const limited = { ...echo, extra: 'kept here', maximumPayloadBytes: 64 };

      manager.getRequestResolver(limited, { serializer: serverSerializer })(() => {
        return Promise.resolve();
      });
      await manager.getRequest(limited, { serializer })({ text: 'hi' })();

      expect([
        calls.registerResolver[0]?.maximumPayloadBytes,
        calls.request[0]?.request.procedure,
      ]).toEqual([64, { ...echo, maximumPayloadBytes: 64 }]);
      expect(calls.registerResolver[0]).not.toHaveProperty('extra');
    });

    test('makes and registers the resolver only once it is given its callback', () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const define = manager.getRequestResolver(echo, { serializer: serverSerializer });

      expect(calls.registerResolver).toEqual([]);

      const resolver = define(() => {
        return Promise.resolve();
      });

      expect(calls.registerResolver).toEqual([resolver]);
      expect(resolver.name).toBe('echo');
      expect(resolver.procedureId).toBe(1);
    });

    test('hands the callback a frozen, decoded request, and sends its answer back', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      let frozen = false;

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        frozen = Object.isFrozen(request);

        return response({ text: `${request.payload.text}!` });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(frozen).toBe(true);
      expect(calls.respond).toEqual([
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi!' }) } },
      ]);
    });

    test('hands the callback the signal of its call, which its cancel aborts', async () => {
      const { router } = createFakeRouter();
      const manager = createServiceManager(router);
      const controller = new AbortController();
      const seen: boolean[] = [];

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        seen.push(request.signal.aborted);
        await Promise.resolve();
        controller.abort();
        seen.push(request.signal.aborted);

        return response({ text: 'late' });
      });

      await resolver(propsOf(encode({ text: 'hi' }), controller.signal));

      expect(seen).toEqual([false, true]);
    });

    test('an answer with a failure of the procedure’s own sends it as the application’s', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        _request,
        response
      ) => {
        return response(null, { code: 7, detail: 'why' });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond[0]?.response).toEqual({
        failure: { code: 7, detail: 'why', scope: FailureScope.APPLICATION },
      });
    });

    test('a payload that does not decode is answered as undecodable, with no detail, never reaching the callback', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      let reached = false;

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(() => {
        reached = true;

        return Promise.resolve();
      });

      await resolver(propsOf(encoder.encode('{not json')));

      expect(reached).toBe(false);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.payloadUndecodable },
        },
      ]);
    });

    test('a request "beforeRequest" refuses is answered with an access denied, seen on its header alone', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const reached: string[] = [];
      const seen: string[][] = [];

      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: (request) => {
          seen.push(Object.keys(request));

          return request.header.callId === 9;
        },
        serializer: serverSerializer,
      })((request, response) => {
        reached.push(request.payload.text);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'refused' })));
      await resolver({ ...propsOf(encode({ text: 'allowed' })), header: { ...header, callId: 9 } });

      expect(reached).toEqual(['allowed']);
      expect(seen).toEqual([
        ['connectionHandle', 'header'],
        ['connectionHandle', 'header'],
      ]);
      expect(calls.respond[0]?.response).toEqual({ failure: SERVER_FAILURES.accessDenied });
    });

    test('on a client’s router, a refusal is the client’s', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      // refused before it is read, one that does not decode as well
      await resolver(propsOf(encoder.encode('{not json')));
      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual([CLIENT_FAILURES.accessDenied, CLIENT_FAILURES.accessDenied]);
    });

    test('a request is answered once: a second answer is a programmer error, and sends nothing', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const second: unknown[] = [];

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        await response(request.payload);
        second.push(
          await response(request.payload).catch((reason: unknown) => {
            return reason;
          }),
          await response(null, { code: 1 }).catch((reason: unknown) => {
            return reason;
          })
        );
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond).toHaveLength(1);
      expect(second).toEqual([expect.any(ProgrammerError), expect.any(ProgrammerError)]);
    });

    test('a callback that fails before it answers is answered as failed, and its reason goes on to the router', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const thrown = new Error('thrown');
      const rejected = new Error('rejected');

      const throwing = manager.getRequestResolver(echo, { serializer: serverSerializer })(() => {
        throw thrown;
      });
      const rejecting = manager.getRequestResolver(
        { ...echo, procedureId: 2 },
        { serializer: serverSerializer }
      )(() => {
        return Promise.reject(rejected);
      });
      const refusing = manager.getRequestResolver(
        { ...echo, procedureId: 3 },
        {
          beforeRequest: () => {
            throw thrown;
          },
          serializer: serverSerializer,
        }
      )(() => {
        return Promise.resolve();
      });

      const request = propsOf(encode({ text: 'hi' }));

      await expect(throwing(request)).rejects.toBe(thrown);
      await expect(rejecting(request)).rejects.toBe(rejected);
      await expect(refusing(request)).rejects.toBe(thrown);

      // the reason stays with the router: what the requester hears is only that it failed
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
      ]);
    });

    test('an answer that cannot go out leaves the request to be answered as failed', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failures: unknown[] = [];
      const answers: {
        failure?: { code: number; scope?: number; side?: string };
        payload?: IText;
      }[] = [
        // an answer the serializer cannot encode
        { payload: { text: 'unencodable' } },
        // a code of the procedure's own outside 1 to 65535
        { failure: { code: 0 } },
        { failure: { code: 0x10000 } },
        { failure: { code: 1.5 } },
        // a protocol failure other than an admission's, or of the other side's table
        { failure: SERVER_FAILURES.serviceUnknown },
        { failure: CLIENT_FAILURES.accessDenied },
        { failure: { code: 21, scope: FailureScope.APPLICATION } },
      ];

      for (const [index, answer] of answers.entries()) {
        const resolver = manager.getRequestResolver(
          { ...echo, procedureId: 10 + index },
          {
            serializer: {
              ...serverSerializer,
              encode: (value: IText) => {
                if (value.text === 'unencodable') {
                  throw new TypeError('cannot encode');
                }

                return encode(value);
              },
            },
          }
        )((_request, response) => {
          // what a caller without types may answer
          return answer.failure === undefined
            ? response(answer.payload ?? { text: '' })
            : response(null, answer.failure as unknown as { code: number });
        });

        failures.push(
          await resolver(propsOf(encode({ text: 'hi' }))).catch((reason: unknown) => {
            return reason;
          })
        );
      }

      expect(failures).toEqual([
        expect.any(TypeError),
        ...Array<unknown>(6).fill(expect.any(ProgrammerError)),
      ]);
      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual(Array(7).fill(SERVER_FAILURES.procedureFailed));
    });

    test('an answer the router cannot send is answered as failed, and the callback hears why', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const tooLong = new FailureError(SERVER_FAILURES.payloadTooLarge);
      const respond = router.respond;
      let heard: unknown;

      // the payload answer goes nowhere; a failure goes out
      router.respond = (response, request) => {
        return response.failure === undefined
          ? Promise.reject(tooLong)
          : respond(response, request);
      };

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        heard = await response(request.payload).catch((reason: unknown) => {
          return reason;
        });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(heard).toBe(tooLong);
      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual([SERVER_FAILURES.procedureFailed]);
    });

    test('a refusal that cannot go out is not answered again', async () => {
      const { calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const gone = new Error('gone');

      control.respondError = gone;

      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      await expect(resolver(propsOf(encode({ text: 'hi' })))).rejects.toBe(gone);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.accessDenied },
        },
      ]);
    });

    test('a callback that fails after it answered is not answered again', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failure = new Error('after');

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        await response(request.payload);

        throw failure;
      });

      await expect(resolver(propsOf(encode({ text: 'hi' })))).rejects.toBe(failure);
      expect(calls.respond).toEqual([
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi' }) } },
      ]);
    });

    test('tells debug the request it received and the answer it sent', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const seen = recordDebug(manager);

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        return response({ text: `${request.payload.text}!` });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        seen.map(({ info }) => {
          return [info.direction, info.rx, info.tx, info.duration === undefined];
        })
      ).toEqual([
        ['rx', { text: 'hi' }, undefined, true],
        ['tx', { text: 'hi' }, { text: 'hi!' }, false],
      ]);
      expect(seen[1]?.info.duration).toBeLessThan(1_000);
    });

    test('a received call starts as it arrives: its admission and its decoding count in its duration', async () => {
      const start = Date.UTC(2026, 0, 1);
      const clock = createTestClock(start);
      const manager = createServiceManager(createFakeRouter('server', clock).router);
      const seen = recordDebug(manager);

      // its admission takes 20 ms, and its callback 10 more
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          clock.tick(20);

          return true;
        },
        serializer: serverSerializer,
      })(async (request, response) => {
        await clock.tickAsync(10);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        seen.map(({ info: { direction, duration, startedAt } }) => {
          return [direction, startedAt, duration];
        })
      ).toEqual([
        ['rx', start, undefined],
        ['tx', start, 30],
      ]);
    });
  });

  test.describe('commands', () => {
    test('one unanswered in time closes its connection, as the call or else the manager says; nothing else does', async () => {
      const { control, router } = createFakeRouter();
      const closed: string[] = [];
      const closeConnection = (handle: string) => {
        closed.push(handle);
      };
      const byDefault = createServiceManager(
        router as IRouterLike<TransportServerConnectionHandle>,
        {
          closeConnection,
          defaults: { closeOnTimeout: true },
        }
      );
      const unlessAsked = createServiceManager(
        router as IRouterLike<TransportServerConnectionHandle>,
        {
          closeConnection,
        }
      );
      const unable = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>, {
        defaults: { closeOnTimeout: true },
      });
      const late = new TimeoutError(10);
      const refused = new FailureError({ ...CLIENT_FAILURES.procedureFailed, origin: 'peer' });
      let failure: Error = late;

      control.answer = () => {
        return Promise.reject(failure);
      };

      const call = async (
        manager: typeof byDefault,
        closeOnTimeout?: boolean
      ): Promise<unknown> => {
        return manager
          .getCommand(echo, { serializer })({ text: 'run' })({
            closeOnTimeout,
            connectionHandle,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      // the call rejects with what went wrong either way
      expect(await call(byDefault)).toBe(late);
      expect(closed).toEqual([connectionHandle]);

      expect(await call(byDefault, false)).toBe(late);
      expect(await call(unlessAsked)).toBe(late);
      expect(await call(unable)).toBe(late);
      expect(closed).toEqual([connectionHandle]);

      expect(await call(unlessAsked, true)).toBe(late);
      expect(closed).toEqual([connectionHandle, connectionHandle]);

      // a request that names no connection has none to close
      const unnamed = createServiceManager(router, {
        closeConnection,
        defaults: { closeOnTimeout: true },
      });

      await expect(unnamed.getRequest(echo, { serializer })({ text: 'run' })()).rejects.toBe(late);
      expect(closed).toHaveLength(2);

      // an answer, even a refusal, is not silence; nor is a connection gone, or a caller that gave up
      for (const other of [refused, new DisconnectError('gone'), new CancelError()]) {
        failure = other;

        expect(await call(byDefault)).toBe(other);
      }

      expect(closed).toHaveLength(2);
    });

    test('getCommand asks one connection, as a server’s request does, and tells debug it is a command', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
      const seen = recordDebug(manager);
      const command = manager.getCommand(echo, { serializer });

      await expect(command({ text: 'run' })({ connectionHandle })).resolves.toEqual({
        text: 'run',
      });

      // @ts-expect-error: a command names the connection it goes to
      await command({ text: 'run' })().catch(() => {
        return undefined;
      });

      expect(command.name).toBe('echo');
      expect(calls.request[0]?.request.options.connectionHandle).toBe(connectionHandle);
      expect(
        seen.slice(0, 2).map(({ info }) => {
          return [info.direction, info.type];
        })
      ).toEqual([
        ['tx', 'command'],
        ['rx', 'command'],
      ]);
    });

    test('tells debug the close on timeout that applies, the call’s or else the manager’s', async () => {
      const { router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>, {
        closeConnection: () => {
          return undefined;
        },
        defaults: { closeOnTimeout: true },
      });
      const seen = recordDebug(manager);
      const command = manager.getCommand(echo, { serializer })({ text: 'run' });

      await command({ connectionHandle });
      await command({ closeOnTimeout: false, connectionHandle });

      expect(
        seen
          .filter(({ info }) => {
            return info.direction === 'tx';
          })
          .map(({ info }) => {
            return info.options?.closeOnTimeout;
          })
      ).toEqual([true, false]);
    });

    test('a client’s calls, and a notification’s, take no close on timeout: they name no connection', async () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router as IRouterLike<'server'>);

      await manager
        .getRequest(echo, { serializer })({ text: 'a' })(
          // @ts-expect-error: a client's call names no connection to close
          { closeOnTimeout: true }
        )
        .catch(() => {
          return undefined;
        });
      await manager
        .getNotification(echo, { serializer })({ text: 'a' }, () => {
          return undefined;
        })(
          // @ts-expect-error: a notification's registration names no connection to close
          { closeOnTimeout: true }
        )
        .catch(() => {
          return undefined;
        });
    });

    test('getCommandResolver runs the server’s request, registered in the router, and tells debug it is a command', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);

      const resolver = manager.getCommandResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        return response({ text: `${request.payload.text} done` });
      });

      await resolver(propsOf(encode({ text: 'run' })));

      expect(calls.registerResolver).toEqual([resolver]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'run done' }) });
      expect(
        seen.map(({ info }) => {
          return [info.direction, info.type];
        })
      ).toEqual([
        ['rx', 'command'],
        ['tx', 'command'],
      ]);
    });
  });

  test.describe('getNotificationResolver', () => {
    test('notifies through the router with the encoded notification', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await resolver.notify({ text: 'news' });

      expect(calls.registerResolver).toEqual([resolver]);
      expect(calls.notify).toEqual([
        { filter: undefined, key: undefined, payload: { text: 'news' }, procedure: echo },
      ]);
    });

    test('its callback may subscribe the requester before answering, and is given the call id; not after', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const late: unknown[] = [];

      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        async (_request, response) => {
          const callId = response.registerNotification();

          await response({ text: String(callId) });

          try {
            response.registerNotification();
          } catch (reason) {
            late.push(reason);
          }
        }
      );

      await resolver(propsOf(encode({ text: 'subscribe' })));

      expect(calls.subscribe).toEqual([{ connectionHandle, header }]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: '7' }) });
      expect(late).toEqual([expect.any(ProgrammerError)]);
    });

    test('tells the router whom its options keep: none excluded, and those the filter keeps', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );
      const handles = ['a', 'b', 'c'];

      await resolver.notify({ text: 'news' }, {});
      await resolver.notify({ text: 'news' }, { exclude: 'b' });
      await resolver.notify(
        { text: 'news' },
        {
          filter: (handle) => {
            return handle !== 'a';
          },
        }
      );
      await resolver.notify(
        { text: 'news' },
        {
          exclude: 'c',
          filter: (handle) => {
            return handle !== 'a';
          },
        }
      );

      expect(
        calls.notify.map(({ filter }) => {
          return filter === undefined ? 'each' : handles.filter(filter);
        })
      ).toEqual(['each', ['a', 'c'], ['b', 'c'], ['b']]);
    });

    test('tells the router what a notification is about, for a paced subscription to keep its latest', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await resolver.notify({ text: 'news' }, { key: 7 });
      await resolver.notify({ text: 'news' }, { key: 'seven' });

      expect(
        calls.notify.map(({ key }) => {
          return key;
        })
      ).toEqual([7, 'seven']);
    });

    test('a failed notify resolves all the same, and only debug hears of it', async () => {
      const { control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const failure = new Error('gone');

      control.notifyError = failure;

      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await expect(resolver.notify({ text: 'news' })).resolves.toBeUndefined();
      expect(
        seen.map(({ error }) => {
          return error;
        })
      ).toEqual([null, failure]);
    });
  });

  test.describe('getNotification', () => {
    test('the first registration requests, registers, and then hears each notification', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(text);
      })();
      deliver(echo, { text: 'one' });
      deliver(echo, { text: 'two' });

      expect(calls.request.length).toBe(1);
      expect(calls.request[0]?.request.subscribes).toBe(notification);
      expect(calls.registerNotification).toEqual(['echo']);
      expect(heard).toEqual(['one', 'two']);
    });

    test('its request takes the destination and the timeout it is given, and names the notification it subscribes', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 's' }, () => {
        return undefined;
      })({ destinationId: 3, timeout: 50 });

      expect(calls.request[0]?.request).toEqual({
        options: { destinationId: 3, signal: undefined, timeout: 50 },
        procedure: echo,
        subscribes: notification,
      });
    });

    test('the router holds it before its request goes out, so a notification right behind the answer is heard', async () => {
      const { control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];

      // the notification comes with the answer, before anything waiting on the answer runs
      control.answer = (payload) => {
        deliver(echo, { text: 'right behind' });

        return Promise.resolve(answerOf(payload));
      };

      await manager.getNotification(echo, { serializer })({ text: 's' }, ({ text }) => {
        heard.push(text);
      })();

      expect(heard).toEqual(['right behind']);
    });

    test('once registered, another callback joins without a request', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(1);
      expect(heard).toEqual(['first news', 'second news']);
    });

    test('callbacks registering at once share one request and one registration', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await Promise.all([
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })(),
        notification({ text: 'b' }, ({ text }) => {
          heard.push(`b ${text}`);
        })(),
      ]);
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(1);
      expect(calls.registerNotification).toEqual(['echo']);
      expect(heard).toEqual(['a news', 'b news']);
    });

    test('a failed request rejects and keeps nothing: the next registration asks again', async () => {
      const { holds, calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const failure = new Error('refused');

      control.answer = () => {
        return Promise.reject(failure);
      };

      await expect(
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })()
      ).rejects.toBe(failure);
      expect(holds(echo)).toBe(false);

      control.answer = (payload) => {
        return Promise.resolve(answerOf(payload));
      };

      await notification({ text: 'b' }, ({ text }) => {
        heard.push(`b ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(2);
      expect(heard).toEqual(['b news']);
      // the router cancels, by default, whatever its call may have left at the other end
      expect(calls.unregisterOptions).toEqual([undefined]);
    });

    test('an answer to its subscription that does not decode lets go of it, the router cancelling its call', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      control.answer = () => {
        return Promise.resolve(answerOf(encoder.encode('{not json')));
      };

      await expect(
        notification({ text: 'a' }, () => {
          return undefined;
        })()
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
      expect(holds(echo)).toBe(false);
      expect(calls.unregisterOptions).toEqual([undefined]);
    });

    test('the last callback taken away unregisters the notification; taking one away twice does nothing', async () => {
      const { holds, calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      const first = await notification({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      const second = await notification({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();

      await first.unregister();
      await first.unregister();
      deliver(echo, { text: 'one' });

      expect(calls.unregisterNotification).toEqual([]);

      await second.unregister();

      expect(calls.unregisterNotification).toEqual(['echo']);
      // with no unsubscription to tell the other end, the router cancels its call
      expect(calls.unregisterOptions).toEqual([{ cancel: true }]);
      expect(holds(echo)).toBe(false);
      expect(heard).toEqual(['second one']);
    });

    test('the last callback out unsubscribes with the call id and the answer that subscribed, before the router lets go of it', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const told: string[] = [];

      control.answer = () => {
        return Promise.resolve(answerOf(encode({ text: 'subscription 7' })));
      };

      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: (callId, response) => {
          told.push(`${String(callId)}: ${response.text}, held ${String(holds(echo))}`);

          return Promise.resolve();
        },
      });
      const first = await notification({ text: 's' }, () => {
        return undefined;
      })();
      const second = await notification({ text: 's' }, () => {
        return undefined;
      })();

      await first.unregister();

      expect(told).toEqual([]);

      await second.unregister();

      expect(told).toEqual(['7: subscription 7, held true']);
      expect(calls.unregisterNotification).toEqual(['echo']);
      // taken away at the other end, acknowledged: nothing is left there to cancel
      expect(calls.unregisterOptions).toEqual([{ cancel: false }]);
    });

    test('an unsubscription that fails rejects the last unregister, once the router let go all the same', async () => {
      const { holds, calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failure = new Error('refused');
      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: () => {
          return Promise.reject(failure);
        },
      });
      const registration = await notification({ text: 's' }, () => {
        return undefined;
      })();

      await expect(registration.unregister()).rejects.toBe(failure);
      expect(holds(echo)).toBe(false);
      // the other end may hold it still: the router cancels its call
      expect(calls.unregisterOptions).toEqual([{ cancel: true }]);

      // what comes next is not held back by it
      await notification({ text: 's' }, () => {
        return undefined;
      })();

      expect(calls.request.length).toBe(2);
    });

    test('dropped with its connection, it tells "dropped", hears nothing more, has nothing to take away, and asks anew', async () => {
      const { calls, deliver, drop, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const dropped: unknown[] = [];
      const unsubscribed: unknown[] = [];

      manager.on('dropped', (procedure, failure) => {
        dropped.push([procedure, failure]);
      });

      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: (_callId, response) => {
          unsubscribed.push(response);

          return Promise.resolve();
        },
      });
      const registration = await notification({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();

      drop();
      await registration.unregister();

      expect(dropped).toEqual([[echo, undefined]]);
      expect(unsubscribed).toEqual([]);
      expect(calls.unregisterNotification).toEqual([]);

      await notification({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['second news']);
      expect(calls.request.length).toBe(2);

      // ended by the server: "dropped" says with what
      const failure = { ...SERVER_FAILURES.capacityExceeded, detail: 'queued', relays: 0 };

      drop(failure);

      expect(dropped).toEqual([
        [echo, undefined],
        [echo, failure],
      ]);
    });

    test('makes a notification with the window its dependencies give, paced by it', () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router);

      expect(manager.getNotification(echo, { serializer, window: 2 }).window).toBe(2);
      expect(
        manager.getNotification({ ...echo, procedureId: 9 }, { serializer }).window
      ).toBeUndefined();
    });

    test('a registration under way when its notification is dropped fails with a DisconnectError', async () => {
      const { control, deliver, drop, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const answered = Promise.withResolvers<IRouterResult>();

      control.answer = () => {
        return answered.promise;
      };

      const registering = manager.getNotification(echo, { serializer })(
        { text: 's' },
        ({ text }) => {
          heard.push(text);
        }
      )();

      await sleep(0);
      drop();
      answered.resolve(answerOf(encode({ text: 'ok' })));

      await expect(registering).rejects.toBeInstanceOf(DisconnectError);

      deliver(echo, { text: 'news' });

      expect(heard).toEqual([]);
    });

    test('"await using" takes the callback away', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      {
        await using registration = await notification({ text: 's' }, () => {
          return undefined;
        })();

        expect(registration).toBeDefined();
      }

      expect(calls.unregisterNotification).toEqual(['echo']);
    });

    test('a registration while the last one is leaving waits for it, then registers anew', async () => {
      const { calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const gate = Promise.withResolvers<undefined>();

      const leaving = await notification({ text: 's' }, () => {
        return undefined;
      })();

      control.unregisterGate = gate.promise;

      const left = leaving.unregister();
      const joining = notification({ text: 's' }, ({ text }) => {
        heard.push(text);
      })();

      gate.resolve(undefined);
      await left;
      await joining;
      deliver(echo, { text: 'news' });

      expect(calls.registerNotification).toEqual(['echo', 'echo']);
      expect(heard).toEqual(['news']);
    });

    test('taking the same registration away twice leaves another of the same callback alone', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const callback = ({ text }: IText) => {
        heard.push(text);
      };

      const first = await notification({ text: 's' }, callback)();
      const second = await notification({ text: 's' }, callback)();

      await first.unregister();
      await first.unregister();
      deliver(echo, { text: 'one' });

      expect(calls.unregisterNotification).toEqual([]);
      expect(heard).toEqual(['one']);

      await second.unregister();
      await second.unregister();

      expect(calls.unregisterNotification).toEqual(['echo']);
    });

    test('a registration arriving while the router subscribes waits for the subscription', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });
      const gate = Promise.withResolvers<undefined>();
      const settled: string[] = [];

      control.subscribeGate = gate.promise;

      const first = notification({ text: 'a' }, () => {
        return undefined;
      })().then(() => {
        settled.push('first');
      });

      // the router holds it now, and is still subscribing
      await sleep(0);
      expect(holds(echo)).toBe(true);

      const second = notification({ text: 'b' }, () => {
        return undefined;
      })().then(() => {
        settled.push('second');
      });

      await sleep(10);
      expect(settled).toEqual([]);

      gate.resolve(undefined);
      await Promise.all([first, second]);

      expect(settled).toEqual(['first', 'second']);
      expect(calls.request.length).toBe(1);
    });

    test('a subscription that fails is undone, so the next registration starts over', async () => {
      const { holds, calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      control.subscribeError = new Error('refused by the broker');

      await expect(
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })()
      ).rejects.toThrow('refused by the broker');
      expect(holds(echo)).toBe(false);
      expect(calls.unregisterNotification).toEqual(['echo']);

      control.subscribeError = undefined;

      await notification({ text: 'b' }, ({ text }) => {
        heard.push(`b ${text}`);
      })();
      deliver(echo, { text: 'news' });

      // the first never asked: the router could not hold it
      expect(calls.request.length).toBe(1);
      expect(heard).toEqual(['b news']);
    });

    test('a second manager on the same router cannot take its procedure over, nor away', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const first = createServiceManager(router);
      const second = createServiceManager(router);
      const heard: string[] = [];

      const registration = await first.getNotification(echo, { serializer })(
        { text: 's' },
        ({ text }) => {
          heard.push(text);
        }
      )();

      await expect(
        second.getNotification(echo, { serializer })({ text: 's' }, () => {
          return undefined;
        })()
      ).rejects.toBeInstanceOf(ProgrammerError);

      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['news']);
      expect(calls.unregisterNotification).toEqual([]);

      await registration.unregister();
    });

    test('the same procedure gives the same notification, so every callback is heard', async () => {
      const { deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const first = manager.getNotification(echo, { serializer });
      const second = manager.getNotification(echo, { serializer });

      expect(second).toBe(first);

      await first({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      await second({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['first news', 'second news']);
    });

    test('the same procedure under another name, revision, deprecation or limit is a programmer error', () => {
      const manager = createServiceManager(createFakeRouter().router);

      manager.getNotification(echo, { serializer });

      for (const asked of [
        { ...echo, procedureName: 'echo2' },
        { ...echo, serviceRevision: 4 },
        { ...echo, deprecation: {} },
        { ...echo, deprecation: { message: 'soon' } },
        { ...echo, maximumPayloadBytes: 8 },
      ]) {
        expect(() => {
          return manager.getNotification(asked, { serializer });
        }).toThrow(ProgrammerError);
      }

      // the same deprecation, asked again, is the same ask
      const deprecated = { ...echo, deprecation: { message: 'use news2' }, procedureId: 70 };

      expect(manager.getNotification(deprecated, { serializer })).toBe(
        manager.getNotification(
          { ...deprecated, deprecation: { message: 'use news2' } },
          { serializer }
        )
      );

      // a serializer of its own, for the same ask, gets the same notification
      expect(manager.getNotification(echo, { serializer: { ...serializer } })).toBe(
        manager.getNotification(echo, { serializer })
      );
    });

    test('a trigger the router never registered is a programmer error', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const notification = manager.getNotification(echo, { serializer });

      expect(() => {
        void notification.trigger(encode({ text: 'stray' }));
      }).toThrow(ProgrammerError);
    });

    test('tells debug each notification it hears', async () => {
      const { deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 's' }, () => {
        return undefined;
      })();

      const seen = recordDebug(manager);

      deliver(echo, { text: 'news' });

      expect(
        seen.map(({ info }) => {
          return [info.direction, info.type, info.rx];
        })
      ).toEqual([['rx', 'notification', { text: 'news' }]]);
    });

    test('a notification that does not decode fails here, for the router to report', async () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const heard: unknown[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 's' }, (payload) => {
        heard.push(payload);
      })();

      const seen = recordDebug(manager);
      let failure: unknown;

      try {
        void notification.trigger(encoder.encode('{not json'));
      } catch (reason) {
        failure = reason;
      }

      expect(failure).toBeInstanceOf(FailureError);
      expect(failure).toMatchObject({
        cause: expect.any(SyntaxError),
        code: ProtocolCode.PAYLOAD_UNDECODABLE,
        header: undefined,
        origin: 'local',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        side: 'client',
      });
      expect(heard).toEqual([]);
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.type, error];
        })
      ).toEqual([['rx', 'notification', failure]]);
    });
  });

  test.describe('admission', () => {
    const admit = async (beforeRequest: IBeforeRequest) => {
      const { calls, router } = createFakeRouter();
      const reached: string[] = [];
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        beforeRequest,
        serializer: serverSerializer,
      })((request, response) => {
        reached.push(request.payload.text);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      return { reached, response: calls.respond[0]?.response };
    };

    test('refuses with an access denied what is not admitted with `true`', async () => {
      expect(
        await admit(() => {
          return false;
        })
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      // a caller without types that returns nothing, or a failure
      expect(
        await admit((() => {
          return undefined;
        }) as unknown as () => boolean)
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      expect(
        await admit((() => {
          return SERVER_FAILURES.sessionRequired;
        }) as unknown as () => boolean)
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      expect(
        await admit(() => {
          return true;
        })
      ).toEqual({ reached: ['hi'], response: { payload: encode({ text: 'hi' }) } });
    });

    test('refuses with the refusal a `beforeRequest` carries, and never reaches the callback', async () => {
      const requireSession: IBeforeRequest = Object.assign(
        (): boolean => {
          return false;
        },
        { refusal: SERVER_FAILURES.sessionRequired }
      );

      expect(await admit(requireSession)).toEqual({
        reached: [],
        response: { failure: SERVER_FAILURES.sessionRequired },
      });

      // composed with `&&`, the refusal is lost: the composition refuses as access denied
      expect(
        await admit((request) => {
          return requireSession(request) && request.header.callId === 7;
        })
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
    });

    test('is asked before the payload is read: a request refused is refused undecodable, and never traced', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      await resolver(propsOf(encoder.encode('{not json')));

      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.accessDenied },
        },
      ]);
      expect(seen).toEqual([]);
    });

    test('is the resolver’s to answer for its router: nothing admits, a failure refuses, a throw goes on', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const thrown = new Error('thrown');
      const callback = () => {
        return Promise.resolve();
      };
      const resolverOf = (procedureId: number, beforeRequest?: IBeforeRequest) => {
        return manager.getRequestResolver(
          { ...echo, procedureId },
          {
            ...(beforeRequest === undefined ? {} : { beforeRequest }),
            serializer: serverSerializer,
          }
        )(callback);
      };
      const request = { connectionHandle, header };

      expect([
        resolverOf(1).admit?.(request),
        resolverOf(2, () => {
          return true;
        }).admit?.(request),
        resolverOf(3, () => {
          return false;
        }).admit?.(request),
        resolverOf(
          4,
          Object.assign(
            () => {
              return false;
            },
            { refusal: SERVER_FAILURES.sessionRequired }
          )
        ).admit?.(request),
      ]).toEqual([
        undefined,
        undefined,
        SERVER_FAILURES.accessDenied,
        SERVER_FAILURES.sessionRequired,
      ]);
      expect(() => {
        return resolverOf(5, () => {
          throw thrown;
        }).admit?.(request);
      }).toThrow(thrown);
    });

    test('is not asked again of a request its router admitted', async () => {
      const { calls, router } = createFakeRouter();
      const asked: number[] = [];
      const handed: string[][] = [];
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        beforeRequest: ({ header: { callId } }) => {
          asked.push(callId);

          return false;
        },
        serializer: serverSerializer,
      })((request, response) => {
        handed.push(Object.keys(request));

        return response(request.payload);
      });

      await resolver({ ...propsOf(encode({ text: 'hi' })), isAdmitted: true });

      expect(asked).toEqual([]);
      // the callback is handed the request, and nothing of its admission
      expect(handed).toEqual([['connectionHandle', 'header', 'payload', 'signal']]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'hi' }) });
    });

    test('a refusal that is not an admission of the router’s side is a programmer error, as the resolver is made', () => {
      const manager = createServiceManager(createFakeRouter().router);

      for (const refusal of [
        CLIENT_FAILURES.sessionRequired,
        SERVER_FAILURES.procedureUnknown,
        { code: 33, scope: FailureScope.APPLICATION, side: 'server' },
      ]) {
        expect(() => {
          return manager.getRequestResolver(echo, {
            beforeRequest: Object.assign(
              () => {
                return false;
              },
              { refusal: refusal as unknown as typeof SERVER_FAILURES.accessDenied }
            ),
            serializer: serverSerializer,
          });
        }, JSON.stringify(refusal)).toThrow(ProgrammerError);
      }

      expect(() => {
        return manager.getNotificationResolver(echo, {
          beforeRequest: Object.assign(
            () => {
              return false;
            },
            { refusal: CLIENT_FAILURES.accessDenied }
          ),
          serializer: serverSerializer,
        });
      }).toThrow(ProgrammerError);
    });
  });

  test.describe('a resolver’s failures', () => {
    const answerWith = async (failure: unknown) => {
      const { calls, router } = createFakeRouter();
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        serializer: serverSerializer,
      })((_request, response) => {
        return response(null, failure as { code: number });
      });

      await resolver(propsOf(encode({ text: 'hi' }))).catch(() => {
        return undefined;
      });

      return calls.respond[0]?.response;
    };

    test('are the procedure’s own from 1 to 65535, and nothing outside', async () => {
      for (const code of [1, 0x1000, 0xffff]) {
        expect(await answerWith({ code })).toEqual({
          failure: { code, scope: FailureScope.APPLICATION },
        });
      }

      for (const code of [0, 0x10000, 1.5, -1]) {
        expect(await answerWith({ code }), String(code)).toEqual({
          failure: SERVER_FAILURES.procedureFailed,
        });
      }
    });

    test('are nothing but objects, from a caller without types', async () => {
      expect(await answerWith(7)).toEqual({ failure: SERVER_FAILURES.procedureFailed });
      expect(() => {
        return createServiceManager(createFakeRouter().router).getRequestResolver(echo, {
          beforeRequest: Object.assign(
            () => {
              return false;
            },
            { refusal: null as unknown as typeof SERVER_FAILURES.accessDenied }
          ),
          serializer: serverSerializer,
        });
      }).toThrow(ProgrammerError);
    });

    test('may be a refusal of admission of the router’s side, with a detail', async () => {
      expect(await answerWith(SERVER_FAILURES.sessionRequired)).toEqual({
        failure: { code: 32, scope: FailureScope.PROTOCOL },
      });
      expect(await answerWith({ ...SERVER_FAILURES.accessDenied, detail: 'admins only' })).toEqual({
        failure: { code: 33, detail: 'admins only', scope: FailureScope.PROTOCOL },
      });
      expect(await answerWith(CLIENT_FAILURES.accessDenied)).toEqual({
        failure: SERVER_FAILURES.procedureFailed,
      });
    });

    test('are typed: a refusal of admission or the procedure’s own, and no other', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const widened: IProtocolFailure = SERVER_FAILURES.serviceUnknown;

      manager.getRequestResolver(
        { ...echo, procedureId: 90 },
        { serializer: serverSerializer }
      )(async (_request, response) => {
        await response(null, SERVER_FAILURES.sessionRequired);
        await response(null, { code: 21 });
        await response(null, { ...SERVER_FAILURES.accessDenied, detail: 'admins only' });
        // @ts-expect-error: a routing failure is the router's to answer, never a resolver's
        await response(null, SERVER_FAILURES.serviceUnknown);
        // @ts-expect-error: nor is a protocol failure whose code is not known to be an admission's
        await response(null, widened);
      });

      expect(() => {
        return manager.getRequestResolver(
          { ...echo, procedureId: 91 },
          {
            // @ts-expect-error: a refusal is an admission failure
            beforeRequest: Object.assign(
              () => {
                return false;
              },
              { refusal: SERVER_FAILURES.procedureUnknown }
            ),
            serializer: serverSerializer,
          }
        );
      }).toThrow(ProgrammerError);
    });
  });

  test('a router’s own handle type reaches the callback, for the session manager to take', async () => {
    const { calls, router } = createFakeRouter();
    const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
    using sessions = createSessionManager();

    sessions.getOrElseSet(connectionHandle);

    const resolver = manager.getRequestResolver(echo, {
      beforeRequest: (request) => {
        return sessions.has(request.connectionHandle);
      },
      serializer: serverSerializer,
    })((request, response) => {
      return response(request.payload);
    });

    await resolver(propsOf(encode({ text: 'hi' })));

    expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'hi' }) });
  });
});
