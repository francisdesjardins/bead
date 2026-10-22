import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IProcedure } from '../../../router/shared/types';
import { createServer } from '../../../server/server';
import { createMemoryTransportClient } from '../../client/memory-transport-client';
import { createWorkerTransportClient } from '../../client/worker-transport-client';
import { createEmitter } from '../../shared/emitter';
import { ProgrammerError } from '../../shared/errors';
import { gaugesOf } from '../../shared/gauges';
import { createTestClock } from '../../shared/__tests__/fixtures';
import type { ITransportMessage } from '../../shared/types';
import { joinTransports } from '../joined-transport-server';
import { createMemoryTransportServer } from '../memory-transport-server';
import type {
  IJoinableTransportServer,
  TransportServerConnectionHandle,
  TransportServerEventMap,
} from '../types';
import { createWorkerTransportServer } from '../worker-transport-server';

// constants

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 1,
};

// helpers

/** A turn of the event loop, past what each end handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

/**
 * A transport server of `type` the test drives: it tells what the test emits, says of each
 * connection what `flags` say, and records what it was asked to send, close and stop.
 */
const createFake = (
  type: string,
  {
    anomalies = [],
    counts = {},
    ceilings = {},
    flags,
    stopping = Promise.resolve(),
  }: {
    anomalies?: string[];
    ceilings?: Record<string, number>;
    counts?: Record<string, number>;
    flags: { carriesCredential?: boolean; isSecure?: boolean; isTwoWay?: boolean };
    stopping?: Promise<void>;
  }
) => {
  const emitter = createEmitter<TransportServerEventMap>();
  const asked: unknown[][] = [];
  const handles = new Set<TransportServerConnectionHandle>();
  const transport: IJoinableTransportServer = {
    type,

    ...(flags.carriesCredential === undefined
      ? {}
      : {
          carriesCredential: (connectionHandle: TransportServerConnectionHandle) => {
            asked.push(['carriesCredential', connectionHandle]);

            return flags.carriesCredential === true;
          },
        }),
    ...(flags.isSecure === undefined
      ? {}
      : {
          isSecure: (connectionHandle: TransportServerConnectionHandle) => {
            asked.push(['isSecure', connectionHandle]);

            return flags.isSecure === true;
          },
        }),
    ...(flags.isTwoWay === undefined
      ? {}
      : {
          isTwoWay: (connectionHandle: TransportServerConnectionHandle) => {
            asked.push(['isTwoWay', connectionHandle]);

            return flags.isTwoWay === true;
          },
        }),
    close: (connectionHandle) => {
      asked.push(['close', connectionHandle]);

      return Promise.resolve(true);
    },
    gauges: () => {
      return gaugesOf({ anomalies, ceilings, connectionHandles: handles, counts });
    },
    // oxlint-disable-next-line typescript/unbound-method -- `createEmitter` returns arrow functions, which have no `this` to lose
    off: emitter.off,
    // oxlint-disable-next-line typescript/unbound-method -- as above
    on: emitter.on,
    send: (message: ITransportMessage, connectionHandle) => {
      asked.push(['send', [...new Uint8Array(message.data as ArrayBuffer)], connectionHandle]);

      return Promise.resolve();
    },
    stop: () => {
      asked.push(['stop']);

      return stopping;
    },
  };

  return { asked, emitter, handles, transport };
};

/**
 * A worker transport server on a scope of its own — a port of a `MessageChannel` — and the worker a
 * page would post its connects to.
 */
const createWorker = (clock?: ReturnType<typeof createTestClock>) => {
  const scope = new MessageChannel();
  const server = createWorkerTransportServer({ clock, scope: scope.port1 });

  scope.port1.start();

  return {
    server,
    worker: {
      postMessage: (message: unknown, transfer: readonly unknown[]) => {
        scope.port2.postMessage(message, transfer as Transferable[]);
      },
    },
    [Symbol.dispose]: () => {
      scope.port1.close();
      scope.port2.close();
    },
  };
};

// definition

test.describe('joinTransports', () => {
  // spec 15.14
  test('hands on each transport’s events with the handle it drew', async () => {
    using worker = createWorker();
    const memory = createMemoryTransportServer();
    const http = createFake('HTTP', { flags: {} });
    const joined = joinTransports([memory, worker.server, http.transport]);
    await using byMemory = createMemoryTransportClient({ server: memory });
    await using byWorker = createWorkerTransportClient({ worker: worker.worker });
    const heard: unknown[][] = [];
    const thrown = new Error('a listener that throws');

    for (const event of ['close', 'connection', 'listen', 'message', 'refusal'] as const) {
      joined.on(event, (...params: TransportServerEventMap[typeof event]) => {
        heard.push([
          event,
          ...params.map((param) => {
            if (param instanceof ArrayBuffer) {
              return [...new Uint8Array(param)];
            }

            return typeof param === 'object' && param !== null && 'data' in param
              ? [...new Uint8Array(param.data as ArrayBuffer)]
              : param;
          }),
        ]);
      });
    }

    // * what a listener throws is reported with its connection, and the next is told all the same
    joined.on('connection', (...[, , connectionHandle]) => {
      throw new Error(`a listener of ${connectionHandle} throws`);
    });
    joined.on('connection', (...[, , connectionHandle]) => {
      heard.push(['after', connectionHandle]);
    });
    joined.once('message', () => {
      throw thrown;
    });
    joined.on('error', (error, connectionHandle) => {
      heard.push(['error', error.message, connectionHandle]);
    });

    await memory.start();
    await worker.server.start();
    await byMemory.connect({});
    await byWorker.connect({});
    await byMemory.send({ data: new Uint8Array([1]) });
    await byWorker.send({ data: new Uint8Array([2]) });
    // a port delivers in a task of its own
    await expect
      .poll(() => {
        return heard.length;
      })
      .toBe(9);
    http.emitter.emit('listen', true, 'type=HTTP;ip=127.0.0.1;ordinal=1');
    http.emitter.emit('refusal', {
      address: '127.0.0.1',
      authority: undefined,
      origin: undefined,
      port: 50_000,
      reason: 'busy',
      status: 503,
    });
    // and what a transport reports of its own
    http.emitter.emit('error', new Error('a socket broke'), 'type=HTTP;ip=127.0.0.1;ordinal=1');
    await byMemory.disconnect();
    await byWorker.disconnect();
    await expect
      .poll(() => {
        return heard.length;
      })
      .toBe(14);

    const memoryHandle = 'type=MEMORY;ip=local;ordinal=1';
    const workerHandle = 'type=WORKER;ip=local;ordinal=1';

    expect(
      heard.map((entry) => {
        // a connection's socket and request are its transport's own
        return entry[0] === 'connection' ? [entry[0], entry[3]] : entry;
      })
    ).toEqual([
      ['connection', memoryHandle],
      ['error', `a listener of ${memoryHandle} throws`, memoryHandle],
      ['after', memoryHandle],
      ['connection', workerHandle],
      ['error', `a listener of ${workerHandle} throws`, workerHandle],
      ['after', workerHandle],
      ['message', [1], memoryHandle],
      ['error', 'a listener that throws', memoryHandle],
      ['message', [2], workerHandle],
      ['listen', true, 'type=HTTP;ip=127.0.0.1;ordinal=1'],
      [
        'refusal',
        {
          address: '127.0.0.1',
          authority: undefined,
          origin: undefined,
          port: 50_000,
          reason: 'busy',
          status: 503,
        },
      ],
      ['error', 'a socket broke', 'type=HTTP;ip=127.0.0.1;ordinal=1'],
      ['close', true, memoryHandle],
      ['close', true, workerHandle],
    ]);

    await joined.stop();
  });

  // spec 15.14
  test('asks each connection’s flags of the transport that drew it, and sends and closes through it', async () => {
    const webSocket = createFake('WS', {
      flags: { carriesCredential: true, isSecure: false, isTwoWay: true },
    });
    const http = createFake('HTTP', {
      flags: { carriesCredential: false, isSecure: true, isTwoWay: false },
    });
    // a transport that says nothing of a flag: none carried, none secure, two-way
    const silent = createFake('WORKER', { flags: {} });
    const memory = createMemoryTransportServer();
    const joined = joinTransports([webSocket.transport, http.transport, silent.transport, memory]);
    await using client = createMemoryTransportClient({ server: memory });
    const heard: unknown[] = [];
    const toWebSocket = 'type=WS;ip=127.0.0.1;port=50000;ordinal=1';
    const toHTTP = 'type=HTTP;ip=127.0.0.1;ordinal=1';
    const toWorker = 'type=WORKER;ip=local;ordinal=1';
    const toMemory = 'type=MEMORY;ip=local;ordinal=1';
    // a handle no transport joined draws, and one no handle's form holds
    const unknown = 'type=OTHER;ip=local;ordinal=1' as TransportServerConnectionHandle;
    const formless = 'nothing' as TransportServerConnectionHandle;

    client.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);
    });
    await memory.start();
    await client.connect({});

    const flagsOf = (connectionHandle: TransportServerConnectionHandle) => {
      return [
        joined.carriesCredential(connectionHandle),
        joined.isSecure(connectionHandle),
        joined.isTwoWay(connectionHandle),
      ];
    };

    expect(
      [toWebSocket, toHTTP, toWorker, toMemory, unknown, formless].map((connectionHandle) => {
        return flagsOf(connectionHandle as TransportServerConnectionHandle);
      })
    ).toEqual([
      [true, false, true],
      [false, true, false],
      [false, false, true],
      [false, true, true],
      [false, false, false],
      [false, false, false],
    ]);

    await joined.send({ data: new Uint8Array([1]) }, toWebSocket);
    await joined.send({ data: new Uint8Array([2]) }, toHTTP);
    await joined.send({ data: new Uint8Array([3]) }, toMemory);
    await joined.send({ data: new Uint8Array([4]) }, unknown);
    await turn();

    expect([
      await joined.close(toHTTP),
      await joined.close(unknown),
      await joined.close(toMemory),
    ]).toEqual([true, false, true]);
    await turn();

    expect(webSocket.asked).toEqual([
      ['carriesCredential', toWebSocket],
      ['isSecure', toWebSocket],
      ['isTwoWay', toWebSocket],
      ['send', [1], toWebSocket],
    ]);
    expect(http.asked).toEqual([
      ['carriesCredential', toHTTP],
      ['isSecure', toHTTP],
      ['isTwoWay', toHTTP],
      ['send', [2], toHTTP],
      ['close', toHTTP],
    ]);
    expect(silent.asked).toEqual([]);
    expect([heard, memory.clients, client.isClosed()]).toEqual([[[3]], [], true]);
  });

  // spec 15.14
  test('refuses to join two transports of one type', () => {
    const clock = createTestClock();

    expect(() => {
      return joinTransports([createMemoryTransportServer(), createMemoryTransportServer()]);
    }).toThrow(
      new ProgrammerError(
        'a join takes one transport of each type: two are MEMORY, whose handles might be one'
      )
    );
    expect(() => {
      return joinTransports([]);
    }).toThrow(new ProgrammerError('a join takes one transport at least'));
    expect(() => {
      return joinTransports([
        createMemoryTransportServer({ clock }),
        createWorkerTransportServer({
          clock: createTestClock(),
          scope: new MessageChannel().port1,
        }),
      ]);
    }).toThrow(new ProgrammerError("a join's transports run on one clock"));

    // one clock, or none named beside it, is the join's
    const joined = joinTransports([
      createMemoryTransportServer({ clock }),
      createFake('WS', { flags: {} }).transport,
    ]);

    expect(joined.clock).toBe(clock);

    // * a join names no type of its own, so no join takes it, past the types
    expect('type' in joined).toBe(false);
    expect(() => {
      return joinTransports([joined as never, createFake('HTTP', { flags: {} }).transport]);
    }).toThrow(
      new ProgrammerError(
        'a join takes transports that name the type of their handles, never a join'
      )
    );
  });

  // spec 15.14
  test('stops every transport it joined, and sums their gauges', async () => {
    using worker = createWorker();
    const memory = createMemoryTransportServer();
    const http = createFake('HTTP', {
      anomalies: ['a socket held twice'],
      ceilings: { connections: 64, exchanges: 128 },
      counts: { connections: 0, exchanges: 2 },
      flags: {},
    });
    // what counts nothing: its connections as its events told them
    const { gauges: _, ...uncounted } = createFake('WS', { flags: {} }).transport;
    const uncountedEmitter = createEmitter<TransportServerEventMap>();
    const counting = {
      ...uncounted,
      // oxlint-disable-next-line typescript/unbound-method -- `createEmitter` returns arrow functions, which have no `this` to lose
      off: uncountedEmitter.off,
      // oxlint-disable-next-line typescript/unbound-method -- as above
      on: uncountedEmitter.on,
    };
    const joined = joinTransports([memory, worker.server, http.transport, counting]);
    await using first = createMemoryTransportClient({ server: memory });
    await using second = createMemoryTransportClient({ server: memory });
    await using third = createWorkerTransportClient({ worker: worker.worker });
    const webSocketHandle = 'type=WS;ip=127.0.0.1;port=50000;ordinal=1';

    await memory.start();
    await worker.server.start();
    await first.connect({});
    await second.connect({});
    await third.connect({});
    uncountedEmitter.emit('connection', {}, {}, webSocketHandle);

    const gauges = joined.gauges();

    expect([
      gauges.counts,
      gauges.ceilings,
      [...gauges.connectionHandles].toSorted(),
      gauges.anomalies,
    ]).toEqual([
      { connections: 4, exchanges: 2 },
      { connections: 64, exchanges: 128 },
      [
        'type=MEMORY;ip=local;ordinal=1',
        'type=MEMORY;ip=local;ordinal=2',
        'type=WORKER;ip=local;ordinal=1',
        webSocketHandle,
      ],
      ['a socket held twice'],
    ]);

    uncountedEmitter.emit('close', false, webSocketHandle);

    expect(joined.gauges().counts).toEqual({ connections: 3, exchanges: 2 });

    await joined.stop();
    await turn();

    expect([memory.isClosed(), worker.server.isClosed(), http.asked]).toEqual([
      true,
      true,
      [['stop']],
    ]);
    expect([first.isClosed(), second.isClosed(), third.isClosed()]).toEqual([true, true, true]);
    expect(joined.gauges().counts).toEqual({ connections: 0, exchanges: 2 });

    // one that fails to stop fails the join's, once every other settled
    const failing = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const failingFake = createFake('HTTP', { flags: {}, stopping: failing.promise });
    const lateFake = createFake('WS', { flags: {}, stopping: late.promise });
    let settled: unknown = 'pending';

    joinTransports([failingFake.transport, lateFake.transport])
      .stop()
      .then(
        () => {
          settled = 'stopped';
        },
        (reason: unknown) => {
          settled = reason;
        }
      );
    failing.reject(new Error('a stop that fails'));
    await turn();

    expect([settled, failingFake.asked, lateFake.asked]).toEqual([
      'pending',
      [['stop']],
      [['stop']],
    ]);

    late.resolve();
    await turn();

    expect(settled).toEqual(new Error('a stop that fails'));
  });

  // spec 15.14
  test('serves one service offered once to a client of each transport', async () => {
    const clock = createTestClock();
    using worker = createWorker(clock);
    const memory = createMemoryTransportServer({ clock });
    const joined = joinTransports([memory, worker.server]);
    await using server = createServer({ transport: joined });
    await using byMemory = createMemoryTransportClient({ clock, server: memory });
    await using byWorker = createWorkerTransportClient({ clock, worker: worker.worker });
    using memoryRouter = createRouterClient(byMemory);
    using workerRouter = createRouterClient(byWorker);
    const callers: string[] = [];

    server.services.getRequestResolver(echo, { serializer: PAYLOAD_CODECS.text })(
      (request, response) => {
        callers.push(request.connectionHandle);

        return response(`${request.payload}, through ${request.connectionHandle.split(';')[0]}`);
      }
    );
    await memory.start();
    await worker.server.start();
    await byMemory.connect({});
    await byWorker.connect({});

    const call = (router: typeof memoryRouter | typeof workerRouter, payload: string) => {
      return createServiceManager(router).getRequest(echo, { serializer: PAYLOAD_CODECS.text })(
        payload
      )();
    };

    expect(await Promise.all([call(memoryRouter, 'one'), call(workerRouter, 'two')])).toEqual([
      'one, through type=MEMORY',
      'two, through type=WORKER',
    ]);
    expect(callers.toSorted()).toEqual([
      'type=MEMORY;ip=local;ordinal=1',
      'type=WORKER;ip=local;ordinal=1',
    ]);
    expect([server.router.clock, server.health().status]).toEqual([clock, 'pass']);
    expect(server.transport).toBe(joined);

    // both transports' connections counted as one transport's, and none of the router's left out
    const { router, transport } = server.gauges();

    expect([transport.counts['connections'], router.orphans]).toEqual([2, 0]);
  });
});
