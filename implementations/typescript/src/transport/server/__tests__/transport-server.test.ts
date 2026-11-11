import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import type { IProcedureAddress } from '../../../router/shared/types';
import * as clocks from '../../shared/clock';
import * as constants from '../../shared/constants';
import * as errors from '../../shared/errors';
import * as readyState from '../../shared/ready-state';
import * as entry from '../transport-server';
import { createTestClock } from '../../shared/__tests__/fixtures';
import { noop } from '../../shared/noop';
import { createHTTPTransportServer } from '../http-transport-server';
import { createMemoryTransportServer } from '../memory-transport-server';
import {
  createTransportServer,
  generateHandle,
  listenOn,
  ProgrammerError,
  type ITransportServer,
  type ITransportServerAddress,
  type ITransportServerDefineOptions,
  type TransportServerConnectionHandle,
} from '../transport-server';
import { createWebSocketTransportServer } from '../websocket-transport-server';
import { createWorkerTransportServer } from '../worker-transport-server';

const A = generateHandle({ ip: '10.0.0.1', ordinal: 1, port: 1, type: 'WS' });
const B = generateHandle({ ip: '10.0.0.2', ordinal: 2, port: 2, type: 'WS' });

// every transport server of this package that takes one list of procedures, built with `procedures`:
// none starts, so none listens
const TAKING = Object.freeze({
  http: (procedures?: readonly IProcedureAddress[]) => {
    return createHTTPTransportServer({
      createServer: (listener) => {
        return createServer(listener);
      },
      procedures,
    });
  },
  memory: (procedures?: readonly IProcedureAddress[]) => {
    return createMemoryTransportServer({ procedures });
  },
  webSocket: (procedures?: readonly IProcedureAddress[]) => {
    return createWebSocketTransportServer({ procedures, WebSocketServer });
  },
  worker: (procedures?: readonly IProcedureAddress[]) => {
    return createWorkerTransportServer({
      procedures,
      scope: { addEventListener: noop, removeEventListener: noop },
    });
  },
} satisfies Record<string, (procedures?: readonly IProcedureAddress[]) => ITransportServer>);

// whether `server` takes each of `addresses` on a connection it never drew: one list stands for
// every connection
const takenBy = (
  server: ITransportServer,
  addresses: readonly IProcedureAddress[]
): (boolean | undefined)[] => {
  return addresses.map((address) => {
    return server.takesProcedure?.(A, address);
  });
};

test('draws another port for an occupied loopback in the platform bind failure', async () => {
  const reason = Object.assign(new Error('bind'), { code: 'EADDRINUSE' });
  const calls: { address: string; port: number }[] = [];
  let draws = 0;
  let closed = 0;
  const result = await listenOn(
    (address, port) => {
      calls.push({ address, port });
      if (address === '::1' && port === 42000) {
        return Promise.reject(reason);
      }
      return Promise.resolve({
        port: address === '127.0.0.1' ? 42000 + draws++ : port,
        close: () => {
          closed += 1;
        },
      });
    },
    { address: 'localhost', findOpenPort: true, port: 0 }
  );

  expect(result).toEqual({ address: 'localhost', port: 42001 });
  expect(draws).toBe(2);
  expect(closed).toBe(1);
  expect(calls).toEqual([
    { address: '127.0.0.1', port: 0 },
    { address: '::1', port: 42000 },
    { address: '127.0.0.1', port: 0 },
    { address: '::1', port: 42001 },
  ]);
});

test('falls back to IPv4 only for an absent loopback in the platform bind failure', async () => {
  for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
    const reason = Object.assign(new Error('bind'), { code });
    const calls: { address: string; port: number }[] = [];
    let closed = 0;
    const result = await listenOn(
      (address, port) => {
        calls.push({ address, port });
        if (address === '::1') {
          return Promise.reject(reason);
        }
        return Promise.resolve({
          port: 42000,
          close: () => {
            closed += 1;
          },
        });
      },
      { address: 'localhost', findOpenPort: true, port: 0 }
    );

    expect(result).toEqual({ address: '127.0.0.1', port: 42000 });
    expect(calls).toEqual([
      { address: '127.0.0.1', port: 0 },
      { address: '::1', port: 42000 },
    ]);
    expect(closed).toBe(0);
  }
});

test('propagates a bind failure whose platform errors name no absent loopback or occupied port', async () => {
  const reason = Object.assign(new Error('bind'), { code: 'EACCES' });
  const calls: { address: string; port: number }[] = [];
  let closed = 0;
  await expect(
    listenOn(
      (address, port) => {
        calls.push({ address, port });
        if (address === '::1') {
          return Promise.reject(reason);
        }
        return Promise.resolve({
          port: 42000,
          close: () => {
            closed += 1;
          },
        });
      },
      { address: 'localhost', findOpenPort: true, port: 0 }
    )
  ).rejects.toBe(reason);

  expect(calls).toEqual([
    { address: '127.0.0.1', port: 0 },
    { address: '::1', port: 42000 },
  ]);
  expect(closed).toBe(1);
});

type StubDefineOptions = ITransportServerDefineOptions<{ id: string }, undefined>;

/**
 * A transport with no socket: it records its calls, `start` waits on `gate` when one is set, and
 * `assertStart`, when given, refuses a start first.
 */
const createStubServer = (options?: {
  assertStart?: () => void;
  gate?: Promise<ITransportServerAddress>;
  startError?: Error;
  onStop?: () => Promise<void>;
}) => {
  const calls: string[] = [];
  // the stub fails its starts while this holds an error
  let startError = options?.startError;
  let register: (connectionHandle: TransportServerConnectionHandle) => void = noop;
  let defineOptions: StubDefineOptions | undefined;

  const server = createTransportServer<{ id: string }, undefined>(
    (end, connections, given: StubDefineOptions) => {
      defineOptions = given;
      register = (connectionHandle) => {
        connections.set(connectionHandle, {
          address: '127.0.0.1',
          connectionHandle,
          lastActivity: undefined,
          port: 1,
          socket: { id: connectionHandle },
          type: 'WS',
        });
      };

      return {
        defaults: { address: '0.0.0.0', findOpenPort: false, port: 80 },
        type: 'WS',
        ...(options?.assertStart === undefined ? {} : { assertStart: options.assertStart }),
        close: ({ connectionHandle }) => {
          calls.push(`close:${connectionHandle}`);
          connections.delete(connectionHandle);
          end.emit('close', true, connectionHandle);
          return Promise.resolve();
        },
        pause: noop,
        resume: noop,
        send: (_, { connectionHandle }) => {
          calls.push(`send:${connectionHandle}`);
          return Promise.resolve();
        },
        start: ({ address, findOpenPort, port }) => {
          calls.push('start');
          if (startError !== undefined) {
            return Promise.reject(startError);
          }
          return options?.gate ?? Promise.resolve({ address, port: findOpenPort ? 50_000 : port });
        },
        stop: () => {
          calls.push('stop');
          return options?.onStop?.() ?? Promise.resolve();
        },
      };
    }
  );

  const recover = () => {
    startError = undefined;
  };

  return {
    calls,
    defineOptions: defineOptions as StubDefineOptions,
    recover,
    register: (connectionHandle: TransportServerConnectionHandle) => {
      register(connectionHandle);
    },
    server,
  };
};

test.describe('@francisdesjardins/bead/transport-server', () => {
  test('re-exports the shared internals as the same bindings', () => {
    for (const name of [
      'CLOSE_EVENT',
      'CONNECTION_EVENT',
      'ERROR_EVENT',
      'MESSAGE_EVENT',
      'REFUSAL_EVENT',
      'TRANSPORT_HTTP',
      'TRANSPORT_WEBSOCKET',
    ] as const) {
      expect(entry[name]).toBe(constants[name]);
    }
    for (const name of [
      'CancelError',
      'ConnectError',
      'GenericError',
      'ProgrammerError',
      'ReadyStateError',
      'ReconnectError',
      'TimeoutError',
    ] as const) {
      expect(entry[name]).toBe(errors[name]);
    }
    for (const name of [
      'getReadyState',
      'isReadyStateClosed',
      'isReadyStateClosing',
      'isReadyStateConnecting',
      'isReadyStateOpen',
      'isReadyStateReconnecting',
      'isReadyStateUninitialized',
      'READY_STATE_NAMES',
      'setReadyStateClosed',
      'setReadyStateClosing',
      'setReadyStateConnecting',
      'ReadyState',
      'setReadyStateOpen',
      'setReadyStateReconnecting',
      'setReadyStateUninitialized',
    ] as const) {
      expect(entry[name]).toBe(readyState[name]);
    }
    expect([entry.LONGEST_TIMER, entry.PLATFORM_CLOCK]).toEqual([
      clocks.LONGEST_TIMER,
      clocks.PLATFORM_CLOCK,
    ]);
  });

  test('runs on the clock its transport supplies, the platform’s when it supplies none', () => {
    const clock = createTestClock();
    const implementation = {
      defaults: { address: '0.0.0.0', findOpenPort: false, port: 80 },
      type: 'WS',
      close: () => {
        return Promise.resolve();
      },
      pause: noop,
      resume: noop,
      send: () => {
        return Promise.resolve();
      },
      start: ({ address, port }: ITransportServerAddress) => {
        return Promise.resolve({ address, port });
      },
      stop: () => {
        return Promise.resolve();
      },
    } as const;

    expect(
      createTransportServer(() => {
        return { ...implementation, clock };
      }).clock
    ).toBe(clock);
    expect(
      createTransportServer(() => {
        return implementation;
      }).clock
    ).toBe(clocks.PLATFORM_CLOCK);
  });

  test('carries no credential toward a connection, and is secure on a loopback host it listens on, or as its transport says', async () => {
    const securedBy = async (address: string, isSecure?: true) => {
      await using server = createTransportServer<object, undefined>(() => {
        return {
          defaults: { address: '0.0.0.0', findOpenPort: false, port: 80 },
          ...(isSecure === undefined ? {} : { isSecure }),
          type: 'WS',
          close: () => {
            return Promise.resolve();
          },
          pause: noop,
          resume: noop,
          send: () => {
            return Promise.resolve();
          },
          start: ({ port }) => {
            return Promise.resolve({ address, port });
          },
          stop: () => {
            return Promise.resolve();
          },
        };
      });

      expect([server.carriesCredential(A), server.isSecure(A)]).toEqual([false, isSecure === true]);
      await server.start({ address });

      return [server.carriesCredential(A), server.isSecure(A)];
    };

    expect(
      await Promise.all([
        securedBy('127.0.0.1'),
        securedBy('::1'),
        securedBy('localhost'),
        securedBy('0.0.0.0'),
        securedBy('192.0.2.1'),
        securedBy('192.0.2.1', true),
      ])
    ).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, false],
      [false, false],
      [false, true],
    ]);
  });

  test('names a connection by its type, its address, its peer’s port when it has a socket of its own, and the rank it was taken at', () => {
    expect([
      generateHandle({ ip: '127.0.0.1', ordinal: 3, port: 50_000, type: 'WS' }),
      generateHandle({ ip: '127.0.0.1', ordinal: 7, type: 'HTTP' }),
      generateHandle({ ip: 'local', ordinal: 1, port: undefined, type: 'WORKER' }),
    ]).toEqual([
      'type=WS;ip=127.0.0.1;port=50000;ordinal=3',
      'type=HTTP;ip=127.0.0.1;ordinal=7',
      'type=WORKER;ip=local;ordinal=1',
    ]);
  });
});

test.describe('createTransportServer', () => {
  test('before its first start, reports the defaults and takes listeners, chained', () => {
    const { server } = createStubServer();

    expect([server.address, server.port, server.type]).toEqual(['0.0.0.0', 80, 'WS']);
    expect(server.isUninitialized()).toBe(true);
    expect(server.on('close', noop).on('message', noop)).toBe(server);
  });

  test('starts, reporting where it listens', async () => {
    const { server } = createStubServer();

    expect(server.isUninitialized()).toBe(true);

    await expect(server.start({ address: '127.0.0.1', findOpenPort: true })).resolves.toEqual({
      address: '127.0.0.1',
      port: 50_000,
    });
    expect([server.address, server.port]).toEqual(['127.0.0.1', 50_000]);
    expect(server.isOpen()).toBe(true);
    expect(server.isClosing()).toBe(false);
  });

  test('an explicit undefined start option falls back to its default', async () => {
    const { server } = createStubServer();

    await server.start({ address: undefined, findOpenPort: undefined, port: undefined });
    expect([server.address, server.port]).toEqual(['0.0.0.0', 80]);
  });

  test('rejects a second start with a ProgrammerError, without reaching the transport', async () => {
    const { calls, server } = createStubServer();

    await server.start();
    await expect(server.start()).rejects.toThrow('the transport server is already open');
    expect(calls).toEqual(['start']);
  });

  test('refuses a start its implementation’s assertStart refuses, its state kept', async () => {
    let isRefusing = true;
    const { calls, server } = createStubServer({
      assertStart: () => {
        if (isRefusing) {
          throw new ProgrammerError('its owner forbids it');
        }
      },
    });

    // * refused before anything moves: its state kept, its transport never reached
    await expect(server.start()).rejects.toThrow(new ProgrammerError('its owner forbids it'));
    expect([server.isUninitialized(), calls]).toEqual([true, []]);

    // ! asked before its state's own guard: an open server refused alike, open still
    isRefusing = false;
    await server.start();
    isRefusing = true;
    await expect(server.start()).rejects.toThrow(new ProgrammerError('its owner forbids it'));
    expect([server.isOpen(), calls]).toEqual([true, ['start']]);
  });

  test('ends CLOSED when the transport cannot start, and can start again', async () => {
    const { recover, server } = createStubServer({ startError: new Error('taken') });

    await expect(server.start()).rejects.toThrow('taken');
    expect(server.isClosed()).toBe(true);

    recover();
    await server.start();
    expect(server.isOpen()).toBe(true);

    await server.stop();
    await server.start();
    expect(server.isOpen()).toBe(true);
  });

  test('rejects a second start while the first is still starting', async () => {
    const gate = Promise.withResolvers<ITransportServerAddress>();
    const { calls, server } = createStubServer({ gate: gate.promise });

    const starting = server.start();
    await expect(server.start()).rejects.toThrow('the transport server is already connecting');

    gate.resolve({ address: '0.0.0.0', port: 80 });
    await starting;
    expect(calls).toEqual(['start']);
  });

  test('stops at once when never started or already stopped', async () => {
    const { calls, server } = createStubServer();

    await server.stop();
    await server.start();
    await server.stop();
    await server.stop();

    expect(calls).toEqual(['start', 'stop']);
    expect(server.isClosed()).toBe(true);
  });

  test('shares a stop already in progress', async () => {
    const gate = Promise.withResolvers<void>();
    const { calls, server } = createStubServer({
      onStop: () => {
        return gate.promise;
      },
    });

    await server.start();
    const first = server.stop();
    const second = server.stop();

    expect(second).toBe(first);
    expect(server.isClosing()).toBe(true);
    await expect
      .poll(() => {
        return calls;
      })
      .toEqual(['start', 'stop']);
    expect(server.isClosing()).toBe(true);
    gate.resolve();
    await first;
    expect(server.isClosed()).toBe(true);
    expect(calls).toEqual(['start', 'stop']);
  });

  test('rejects a stop while starting', async () => {
    const gate = Promise.withResolvers<ITransportServerAddress>();
    const { server } = createStubServer({ gate: gate.promise });

    const starting = server.start();
    const refused = server.stop();

    await expect(refused).rejects.toBeInstanceOf(ProgrammerError);
    expect(server.isConnecting()).toBe(true);

    gate.resolve({ address: '0.0.0.0', port: 80 });
    await starting;
    await server.stop();
    expect(server.isClosed()).toBe(true);
    await expect(refused).rejects.toHaveProperty('message', 'the transport server is starting');
  });

  test('a transport stop that throws still ends CLOSED, as a rejection', async () => {
    const { server } = createStubServer({
      onStop: () => {
        throw new Error('stop failed');
      },
    });

    await server.start();
    await expect(server.stop()).rejects.toThrow('stop failed');
    expect(server.isClosed()).toBe(true);
  });

  test('a stop re-entered from a close listener shares the stop in progress', async () => {
    const stops: Promise<void>[] = [];
    const { calls, register, server } = createStubServer({
      onStop: () => {
        server.emit('close', false, A);
        return Promise.resolve();
      },
    });

    await server.start();
    register(A);
    server.on('close', () => {
      stops.push(server.stop());
    });

    const stopping = server.stop();
    await stopping;

    expect(stops).toEqual([stopping]);
    expect(calls).toEqual(['start', 'stop']);
  });

  test('"clients" is a copy without the sockets', async () => {
    const { register, server } = createStubServer();

    await server.start();
    register(A);

    const clients = server.clients;
    expect(clients).toEqual([
      {
        address: '127.0.0.1',
        connectionHandle: A,
        lastActivity: undefined,
        port: 1,
        type: 'WS',
      },
    ]);

    clients.pop();
    expect(server.clients).toHaveLength(1);

    // in the order the connections came, whichever went in between; the copy taken before stays
    const C = generateHandle({ ip: '10.0.0.0', ordinal: 3, port: 3, type: 'WS' });
    const before = server.clients;
    const handlesOf = (listed: typeof clients) => {
      return listed.map(({ connectionHandle }) => {
        return connectionHandle;
      });
    };

    register(B);
    await server.close(A);
    register(C);

    expect([handlesOf(server.clients), handlesOf(before)]).toEqual([[B, C], [A]]);

    const D = generateHandle({ ip: '10.0.0.4', ordinal: 4, port: 4, type: 'WS' });
    const E = generateHandle({ ip: '10.0.0.5', ordinal: 5, port: 5, type: 'WS' });

    register(D);
    register(E);
    expect([handlesOf(server.clients), handlesOf(before)]).toEqual([[B, C, D, E], [A]]);
  });

  test('"close" resolves false for an unknown handle without reaching the transport', async () => {
    const { calls, register, server } = createStubServer();

    await server.start();
    register(A);

    await expect(server.close(B)).resolves.toBe(false);
    await expect(server.close(A)).resolves.toBe(true);
    expect(calls).toEqual(['start', `close:${A}`]);
    expect(server.clients).toHaveLength(0);
  });

  test('"send" to an unknown handle resolves without reaching the transport', async () => {
    const { calls, register, server } = createStubServer();

    await server.start();
    register(A);

    await server.send({ data: 'x' }, B);
    await server.send({ data: 'x' }, A);
    expect(calls).toEqual(['start', `send:${A}`]);
  });

  test('"await using" stops it', async () => {
    const { calls, server: started } = createStubServer();
    {
      await using server = started;
      await server.start();
    }
    expect(calls).toEqual(['start', 'stop']);
    expect(started.isClosed()).toBe(true);
  });

  // decision 0003
  test('refuses a start once disposed, its state kept, and disposes once, stopping it first', async () => {
    const gate = Promise.withResolvers<void>();
    const { calls, server } = createStubServer({
      onStop: () => {
        return gate.promise;
      },
    });

    await server.start();

    // * two disposes: one stop, which both settle with
    const disposes = [server[Symbol.asyncDispose](), server[Symbol.asyncDispose]()];
    const settledDisposes: number[] = [];

    for (const [index, disposing] of disposes.entries()) {
      void disposing.then(() => {
        settledDisposes.push(index);
      });
    }

    await Promise.resolve();
    expect([server.isClosing(), settledDisposes], 'stopping, neither settled').toEqual([true, []]);
    gate.resolve();
    await Promise.all(disposes);
    expect([calls, server.isClosed()], 'stopped first, once').toEqual([['start', 'stop'], true]);

    // * a start once disposed: its application's misuse, refused before anything moves
    const refused = server.start();

    await expect(refused, 'a misuse').rejects.toBeInstanceOf(ProgrammerError);
    await expect(refused, 'its words').rejects.toThrow('the transport server is disposed');
    expect([server.isClosed(), calls], 'its state kept, its transport never reached').toEqual([
      true,
      ['start', 'stop'],
    ]);

    // * a stop or a dispose after it settles at once, nothing asked of its transport
    await server.stop();
    await server[Symbol.asyncDispose]();
    expect(calls, 'nothing more asked').toEqual(['start', 'stop']);
  });

  test('"stop" forgets every connection', async () => {
    const { register, server } = createStubServer();

    await server.start();
    register(A);
    await server.stop();

    expect(server.clients).toHaveLength(0);
  });

  test('calls each listener though one throws, reporting the throw with its connection', () => {
    const { defineOptions, server } = createStubServer();
    const thrown = new Error('a listener that throws');
    const told: TransportServerConnectionHandle[] = [];
    const values: unknown[] = [];
    const reported: [Error, string][] = [];

    server.on('message', () => {
      throw thrown;
    });
    server.on('message', ({ data }, connectionHandle) => {
      told.push(connectionHandle);
      values.push((data as Uint8Array)[0]);
    });
    server.on('error', (error, connectionHandle) => {
      reported.push([error, connectionHandle]);
    });

    expect(defineOptions.tell('message', [{ data: new Uint8Array([1]) }, A])).toBe(true);
    expect(defineOptions.tell('message', [{ data: new Uint8Array([2]) }, B])).toBe(true);

    expect(told).toEqual([A, B]);
    expect(values).toEqual([1, 2]);
    expect(reported).toEqual([
      [thrown, A],
      [thrown, B],
    ]);
    expect(reported[0]?.[0]).toBe(thrown);
    const handle = 'type=WS;ip=127.0.0.1;port=1;ordinal=1';
    const lifecycle: unknown[][] = [];

    server.on('connection', () => {
      throw thrown;
    });
    server.on('connection', (...[, connectionHandle]) => {
      lifecycle.push(['connection', connectionHandle]);
    });
    server.on('close', () => {
      throw thrown;
    });
    server.on('close', (clean, connectionHandle) => {
      lifecycle.push(['close', clean, connectionHandle]);
    });

    expect(
      defineOptions.tell('connection', [{ request: undefined, socket: { id: handle } }, handle])
    ).toBe(true);
    expect(defineOptions.tell('close', [false, handle])).toBe(true);
    expect(lifecycle).toEqual([
      ['connection', handle],
      ['close', false, handle],
    ]);
    expect(reported).toEqual([
      [thrown, A],
      [thrown, B],
      [thrown, handle],
      [thrown, handle],
    ]);
    server.removeAllListeners('message');
    expect(defineOptions.tell('message', [{ data: new Uint8Array([3]) }, A])).toBe(false);
    expect(reported).toHaveLength(4);
  });

  test('reports a throw of a listener told no connection with the empty handle', () => {
    const { defineOptions, server } = createStubServer();
    const thrown = new Error('a refusal listener that throws');
    const refusal = {
      address: '127.0.0.1',
      authority: 'rebind.example',
      origin: undefined,
      port: 50_000,
      reason: 'host-refused',
      status: 403,
    };
    const told: unknown[] = [];
    const reported: [Error, string][] = [];

    expect(defineOptions.isHeard('refusal')).toBe(false);

    server.on('refusal', () => {
      throw thrown;
    });
    server.on('refusal', (given) => {
      told.push(given);
    });
    server.on('error', (error, connectionHandle) => {
      reported.push([error, connectionHandle]);
    });

    expect(defineOptions.isHeard('refusal')).toBe(true);
    expect(defineOptions.tell('refusal', [refusal])).toBe(true);

    expect(told).toEqual([refusal]);
    expect(reported).toEqual([[thrown, '']]);
  });

  test('counts the connections it holds, and gives their handles, for no one outside the process', () => {
    const { register, server } = createStubServer();

    register(A);
    register(B);

    expect(server.gauges()).toEqual({
      anomalies: [],
      ceilings: {},
      connectionHandles: new Set([A, B]),
      counts: { connections: 2 },
    });
  });
});

// spec 9.11, 9.12
test.describe('the procedures a transport server takes', () => {
  test('refuses procedures that name an id out of its range or service 0, as the transport is built (spec 9.12)', () => {
    const refused = [
      { procedureId: 1, serviceId: 0 },
      { procedureId: 0, serviceId: 2 },
      { procedureId: 1, serviceId: 65_536 },
      { procedureId: 65_536, serviceId: 2 },
      { procedureId: 1.5, serviceId: 2 },
      { procedureId: -1, serviceId: 2 },
      { procedureId: 1, serviceId: '2' },
      { procedureId: Number.NaN, serviceId: 2 },
    ] as unknown as IProcedureAddress[];

    for (const [name, build] of Object.entries(TAKING)) {
      for (const address of refused) {
        expect(
          () => {
            return build([{ procedureId: 1, serviceId: 2 }, address]);
          },
          `${name} ${JSON.stringify(address)}`
        ).toThrow(ProgrammerError);
      }

      // its bounds taken
      expect(
        takenBy(build([{ procedureId: 65_535, serviceId: 1 }]), [
          { procedureId: 65_535, serviceId: 1 },
        ]),
        name
      ).toEqual([true]);
    }

    expect(() => {
      return createMemoryTransportServer({ procedures: [{ procedureId: 1, serviceId: 0 }] });
    }).toThrow(
      new ProgrammerError(
        "an in-memory transport server takes 0/1, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3)"
      )
    );
  });

  test('takes an address named twice as one (spec 9.12)', () => {
    for (const [name, build] of Object.entries(TAKING)) {
      const server = build([
        { procedureId: 1, serviceId: 2 },
        { procedureId: 1, serviceId: 2 },
        { procedureId: 2, serviceId: 2 },
      ]);

      expect(
        takenBy(server, [
          { procedureId: 1, serviceId: 2 },
          { procedureId: 2, serviceId: 2 },
          { procedureId: 3, serviceId: 2 },
          { procedureId: 2, serviceId: 1 },
        ]),
        name
      ).toEqual([true, true, false, false]);
    }
  });

  test('a transport given no list takes every procedure, and one given an empty list takes none (spec 9.11)', () => {
    for (const [name, build] of Object.entries(TAKING)) {
      // * given none, it names none: its router never asks, and every procedure is taken
      expect(build().takesProcedure, name).toBeUndefined();
      expect(build(undefined).takesProcedure, name).toBeUndefined();
      expect(
        takenBy(build([]), [
          { procedureId: 1, serviceId: 1 },
          { procedureId: 65_535, serviceId: 65_535 },
        ]),
        name
      ).toEqual([false, false]);
    }

    // the shared half has one only when its transport gives one, and asks it by the handle
    const asked: [TransportServerConnectionHandle, IProcedureAddress][] = [];
    const define = (takes: boolean) => {
      return () => {
        return {
          defaults: { address: '0.0.0.0', findOpenPort: false, port: 80 },
          type: 'WS' as const,
          close: () => {
            return Promise.resolve();
          },
          pause: noop,
          resume: noop,
          send: () => {
            return Promise.resolve();
          },
          start: ({ address, port }: ITransportServerAddress) => {
            return Promise.resolve({ address, port });
          },
          stop: () => {
            return Promise.resolve();
          },
          ...(takes
            ? {
                takesProcedure: (
                  connectionHandle: TransportServerConnectionHandle,
                  address: IProcedureAddress
                ) => {
                  asked.push([connectionHandle, address]);

                  return false;
                },
              }
            : {}),
        };
      };
    };

    expect(createTransportServer(define(false)).takesProcedure).toBeUndefined();
    expect(
      createTransportServer(define(true)).takesProcedure?.(B, { procedureId: 1, serviceId: 2 })
    ).toBe(false);
    expect(asked).toEqual([[B, { procedureId: 1, serviceId: 2 }]]);
  });
});
