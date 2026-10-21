import { expect, test } from '@playwright/test';
import * as clocks from '../../shared/clock';
import * as constants from '../../shared/constants';
import * as errors from '../../shared/errors';
import * as readyState from '../../shared/ready-state';
import * as entry from '../transport-server';
import { createTestClock } from '../../shared/__tests__/fixtures';
import { noop } from '../../shared/noop';
import {
  createTransportServer,
  generateHandle,
  ProgrammerError,
  type ITransportServerAddress,
  type ITransportServerDefineOptions,
  type TransportServerConnectionHandle,
} from '../transport-server';

const A = generateHandle({ ip: '10.0.0.1', ordinal: 1, port: 1, type: 'WS' });
const B = generateHandle({ ip: '10.0.0.2', ordinal: 2, port: 2, type: 'WS' });

type StubDefineOptions = ITransportServerDefineOptions<{ id: string }, undefined>;

/** A transport with no socket: it records its calls, and `start` waits on `gate` when one is set. */
const createStubServer = (options?: {
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
        close: ({ connectionHandle }) => {
          calls.push(`close:${connectionHandle}`);
          connections.delete(connectionHandle);
          end.emit('close', true, connectionHandle);
          return Promise.resolve();
        },
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
      'TRANSPORT_WS',
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
    await expect(server.start()).rejects.toThrow('server is already open');
    expect(calls).toEqual(['start']);
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
    await expect(server.start()).rejects.toThrow('server is already connecting');

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

  test('"closeAll" closes every connection, and resolves to nothing without one', async () => {
    const { calls, register, server } = createStubServer();
    const closed: [boolean, string][] = [];

    server.on('close', (clean, connectionHandle) => {
      closed.push([clean, connectionHandle]);
    });

    await server.start();
    await expect(server.closeAll()).resolves.toEqual([]);

    register(A);
    register(B);
    await expect(server.closeAll()).resolves.toEqual([true, true]);
    expect(server.clients).toHaveLength(0);
    expect(closed).toEqual([
      [true, A],
      [true, B],
    ]);
    expect(calls).toEqual(['start', `close:${A}`, `close:${B}`]);
    expect(server.isOpen()).toBe(true);
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
    server.on('connection', (...[, , connectionHandle]) => {
      lifecycle.push(['connection', connectionHandle]);
    });
    server.on('close', () => {
      throw thrown;
    });
    server.on('close', (clean, connectionHandle) => {
      lifecycle.push(['close', clean, connectionHandle]);
    });

    expect(defineOptions.tell('connection', [{ id: handle }, undefined, handle])).toBe(true);
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
