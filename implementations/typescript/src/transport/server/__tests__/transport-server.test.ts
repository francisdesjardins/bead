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
  generateDrawnHandle,
  generateHandle,
  ProgrammerError,
  type ITransportServerAddress,
  type TransportServerConnectionHandle,
} from '../transport-server';

const A = generateHandle({ ip: '10.0.0.1', port: 1, type: 'WS' });
const B = generateHandle({ ip: '10.0.0.2', port: 2, type: 'WS' });

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

  const server = createTransportServer<{ id: string }, undefined>((end, connections) => {
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
  });

  const recover = () => {
    startError = undefined;
  };

  return {
    calls,
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

  test('names a connection by its type, address and port', () => {
    expect(generateHandle({ ip: '127.0.0.1', port: 50_000, type: 'WS' })).toBe(
      'type=WS;ip=127.0.0.1;port=50000'
    );
  });

  test('names a connection it drew by its type, address and the rank it was drawn at', () => {
    expect(generateDrawnHandle({ ip: '127.0.0.1', ordinal: 7, type: 'HTTP' })).toBe(
      'type=HTTP;ip=127.0.0.1;ordinal=7'
    );
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

    await expect(server.start({ address: '127.0.0.1', findOpenPort: true })).resolves.toEqual({
      address: '127.0.0.1',
      port: 50_000,
    });
    expect([server.address, server.port]).toEqual(['127.0.0.1', 50_000]);
    expect(server.isOpen()).toBe(true);
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
    const { calls, server } = createStubServer();

    await server.start();
    const first = server.stop();
    const second = server.stop();

    expect(second).toBe(first);
    await first;
    expect(calls).toEqual(['start', 'stop']);
  });

  test('rejects a stop while starting', async () => {
    const gate = Promise.withResolvers<ITransportServerAddress>();
    const { server } = createStubServer({ gate: gate.promise });

    const starting = server.start();
    await expect(server.stop()).rejects.toBeInstanceOf(ProgrammerError);
    expect(server.isConnecting()).toBe(true);

    gate.resolve({ address: '0.0.0.0', port: 80 });
    await starting;
    await server.stop();
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
    const C = generateHandle({ ip: '10.0.0.0', port: 3, type: 'WS' });
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
    const { register, server } = createStubServer();

    await server.start();
    await expect(server.closeAll()).resolves.toEqual([]);

    register(A);
    register(B);
    await expect(server.closeAll()).resolves.toEqual([true, true]);
    expect(server.clients).toHaveLength(0);
  });

  test('"send" to an unknown handle resolves without reaching the transport', async () => {
    const { calls, register, server } = createStubServer();

    await server.start();
    register(A);

    await server.send('x', B);
    await server.send('x', A);
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
