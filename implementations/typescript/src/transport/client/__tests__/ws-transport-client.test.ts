import { expect, test } from '@playwright/test';
import type { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import {
  CancelError,
  ConnectError,
  type Data,
  dispose,
  type ITransportClient,
  type ITransportClientInternal,
  LONGEST_TIMER,
  ProgrammerError,
  ReadyState,
  ReadyStateError,
  ReconnectError,
  TimeoutError,
  type TRANSPORT_CLIENT_EVENTS,
  type TransportClientEventMap,
} from '../transport-client';
import * as constants from '../../shared/constants';
import {
  allClosed,
  closedPort,
  createTestClock,
  durationsOf,
  host,
  IMPLEMENTATIONS,
  portOf,
  sockets,
  spyIntervals,
  startServer,
  stopServer,
} from '../../shared/__tests__/fixtures';
import {
  createWSTransportClient,
  HEARTBEAT,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IWebSocketConstructor,
  type WSTransportClient,
} from '../ws-transport-client';
import { createFakeWebSocket } from './fake-websocket';

/** The drop only an implementation reaches, as the base and the transport use it. */
const drop = (client: ITransportClient<object, never>): void => {
  (client as ITransportClientInternal<object, never>)[dispose]();
};

const nextEvent = <K extends TRANSPORT_CLIENT_EVENTS>(client: WSTransportClient, event: K) => {
  return new Promise<TransportClientEventMap[K]>((resolve) => {
    client.once(event, (...params) => {
      resolve(params);
    });
  });
};

const nextConnection = (server: WebSocketServer) => {
  return new Promise<{ socket: WsWebSocket; url: string | undefined }>((resolve) => {
    server.once('connection', (socket, request) => {
      resolve({ socket, url: request.url });
    });
  });
};

const nextMessage = (server: WebSocketServer) => {
  return new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
    server.once('connection', (socket) => {
      socket.once('message', (data: Buffer, isBinary) => {
        resolve({ data, isBinary });
      });
    });
  });
};

test('@francisdesjardins/bead/ws-transport-client re-exports the WebSocket binary type', () => {
  expect(TRANSPORT_WEBSOCKET_BINARYTYPE).toBe(constants.TRANSPORT_WEBSOCKET_BINARYTYPE);
});

for (const [label, TrackedWebSocket] of IMPLEMENTATIONS satisfies readonly (readonly [
  string,
  IWebSocketConstructor,
])[]) {
  test.describe(`on ${label}`, () => {
    let server: WebSocketServer;
    let port: number;
    let client: WSTransportClient;

    test.beforeEach(async () => {
      server = await startServer();
      port = portOf(server);
      client = createWSTransportClient({ WebSocket: TrackedWebSocket });
    });

    test.afterEach(async () => {
      if (client.isOpen()) {
        await client.disconnect();
      }
      await stopServer(server);
      await allClosed();
    });

    test.describe('WSTransportClient #connect', () => {
      test('resolves when connecting to a valid endpoint', async () => {
        await client.connect({ host, port });
        expect(client.isOpen()).toBe(true);
      });

      test('rejects with a ConnectError on a port no URL can hold', async () => {
        await expect(client.connect({ host, port: 100_000 })).rejects.toBeInstanceOf(ConnectError);
        expect(client.isClosed()).toBe(true);
      });

      test('rejects with a ConnectError when nothing listens', async () => {
        await expect(client.connect({ host, port: await closedPort() })).rejects.toBeInstanceOf(
          ConnectError
        );
        expect(client.isClosed()).toBe(true);
      });

      test('keeps the error the implementation reported as the ConnectError cause', async () => {
        const connecting = client.connect({ host, port: await closedPort() });

        await expect(connecting).rejects.toBeInstanceOf(ConnectError);
        // ws reports the system's error; the global WebSocket a TypeError that says nothing more
        await expect(connecting).rejects.toHaveProperty(
          'cause',
          label === 'ws'
            ? expect.objectContaining({ code: 'ECONNREFUSED' })
            : expect.objectContaining({ message: '', name: 'TypeError' })
        );
      });

      test('rejects with a ProgrammerError when connecting twice', async () => {
        await client.connect({ host, port });
        await expect(client.connect({ host, port })).rejects.toBeInstanceOf(ProgrammerError);
        expect(client.isOpen()).toBe(true);
      });

      test('rejects a second connect while the first is connecting, opening one socket only', async () => {
        const first = client.connect({ host, port });

        await expect(client.connect({ host, port })).rejects.toBeInstanceOf(ProgrammerError);
        await first;

        expect(client.isOpen()).toBe(true);
        expect(sockets.size).toBe(1);
      });

      test('rejects a connect while reconnecting', async () => {
        const controller = new AbortController();

        await client.connect({ host, port });
        await client.disconnect();
        const reconnecting = client.reconnect({ delay: 60_000, signal: controller.signal });

        await expect(client.connect({ host, port })).rejects.toBeInstanceOf(ProgrammerError);

        controller.abort();
        await expect(reconnecting).rejects.toBeInstanceOf(CancelError);
      });

      test('rejects a connect while a disconnect is pending', async () => {
        await client.connect({ host, port });
        const disconnecting = client.disconnect();

        await expect(client.connect({ host, port })).rejects.toBeInstanceOf(ProgrammerError);
        await disconnecting;
      });

      test('rejects with a TimeoutError, then drops a socket that never finished its handshake', async () => {
        const pendingHandshakes: ((result: boolean) => void)[] = [];
        const gatedServer = await startServer({
          verifyClient: (_info, done) => {
            pendingHandshakes.push(done);
          },
        });

        try {
          await expect(
            client.connect({ host, port: portOf(gatedServer), timeout: 100 })
          ).rejects.toBeInstanceOf(TimeoutError);
          expect(client.isClosed()).toBe(true);
          expect(client.socket).toBeNull();

          // the socket closes on its own, with the server still holding its handshake
          await allClosed();
        } finally {
          for (const done of pendingHandshakes) {
            done(false);
          }
          await stopServer(gatedServer);
        }
      });

      test('rejects with a CancelError, CLOSED, when its signal aborts during the handshake', async () => {
        const pendingHandshakes: ((result: boolean) => void)[] = [];
        const gatedServer = await startServer({
          verifyClient: (_info, done) => {
            pendingHandshakes.push(done);
          },
        });

        try {
          const controller = new AbortController();
          const connecting = client.connect({
            host,
            port: portOf(gatedServer),
            signal: controller.signal,
            timeout: Infinity,
          });
          controller.abort('why');

          await expect(connecting).rejects.toBeInstanceOf(CancelError);
          await expect(connecting).rejects.toHaveProperty('cause', 'why');
          expect(client.isClosed()).toBe(true);
          expect(client.socket).toBeNull();
          await allClosed();
        } finally {
          for (const done of pendingHandshakes) {
            done(false);
          }
          await stopServer(gatedServer);
        }
      });

      test('"[dispose]" while connecting rejects the connect with a ConnectError', async () => {
        const pendingHandshakes: ((result: boolean) => void)[] = [];
        const gatedServer = await startServer({
          verifyClient: (_info, done) => {
            pendingHandshakes.push(done);
          },
        });

        try {
          const connecting = client.connect({ host, port: portOf(gatedServer), timeout: Infinity });
          drop(client);

          await expect(connecting).rejects.toBeInstanceOf(ConnectError);
          expect(client.isClosed()).toBe(true);
          await allClosed();
        } finally {
          for (const done of pendingHandshakes) {
            done(false);
          }
          await stopServer(gatedServer);
        }
      });

      test('passes the protocols to the handshake', async () => {
        const connection = nextConnection(server);
        await client.connect({ host, port, protocols: ['echo'] });
        expect((await connection).socket.protocol).toBe('echo');
      });

      for (const [pathname, expected] of [
        ['rpc', '/rpc'],
        ['/rpc', '/rpc'],
        [undefined, '/'],
      ] as const) {
        test(`requests "${expected}" for the pathname ${pathname === undefined ? 'undefined' : `"${pathname}"`}`, async () => {
          const connection = nextConnection(server);
          await client.connect({ host, port, pathname });
          expect((await connection).url).toBe(expected);
        });
      }

      test('asks for wss when secured', async () => {
        await expect(
          client.connect({ host, port: await closedPort(), secured: true })
        ).rejects.toBeInstanceOf(ConnectError);

        expect([...sockets.keys()].at(-1)?.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/$/);
      });
    });

    test.describe('WSTransportClient #send', () => {
      const payloads: [string, () => Data][] = [
        [
          'string',
          () => {
            return 'hello';
          },
        ],
        [
          'ArrayBuffer',
          () => {
            return new TextEncoder().encode('hello').buffer;
          },
        ],
        [
          'Uint8Array',
          () => {
            return new TextEncoder().encode('hello');
          },
        ],
        [
          'Blob',
          () => {
            return new Blob(['hello']);
          },
        ],
      ];

      for (const [kind, payload] of payloads) {
        test(`delivers a ${kind}`, async () => {
          const received = nextMessage(server);

          await client.connect({ host, port });
          await client.send({ data: payload() });

          const { data, isBinary } = await received;
          expect(data.toString()).toBe('hello');
          expect(isBinary).toBe(kind !== 'string');
        });
      }

      test('carries no credential: the envelope alone goes', async () => {
        const received = nextMessage(server);

        await client.connect({ host, port });
        await client.send({
          credential: 'Bearer mF_9.B5f-4.1JqM',
          data: new TextEncoder().encode('hello'),
        });

        const { data, isBinary } = await received;
        expect([isBinary, data.toString()]).toEqual([true, 'hello']);
      });

      test('rejects with a ReadyStateError after disconnecting', async () => {
        await client.connect({ host, port });
        await client.disconnect();
        await expect(client.send({ data: 'HelloWorld' })).rejects.toBeInstanceOf(ReadyStateError);
      });
    });

    test.describe('WSTransportClient "message" event', () => {
      test('emits what the server sends — text as a string, binary as an ArrayBuffer', async () => {
        server.once('connection', (socket) => {
          socket.send('text');
          socket.send(Buffer.from('binary'));
        });

        const messages: unknown[] = [];
        const both = new Promise<void>((resolve) => {
          client.on('message', ({ data }) => {
            messages.push(data);
            if (messages.length === 2) {
              resolve();
            }
          });
        });

        await client.connect({ host, port });
        await both;

        expect(messages[0]).toBe('text');
        expect(messages[1]).toBeInstanceOf(ArrayBuffer);
        expect(new TextDecoder().decode(messages[1] as ArrayBuffer)).toBe('binary');
      });

      test('an undefined binaryType still delivers an ArrayBuffer', async () => {
        client = createWSTransportClient({ WebSocket: TrackedWebSocket, binaryType: undefined });
        server.once('connection', (socket) => {
          socket.send(Buffer.from('binary'));
        });

        const message = nextEvent(client, 'message');
        await client.connect({ host, port });
        const [{ data }] = await message;

        expect(data).toBeInstanceOf(ArrayBuffer);
      });

      test('delivers binary as a Blob with binaryType "blob"', async () => {
        client = createWSTransportClient({ WebSocket: TrackedWebSocket, binaryType: 'blob' });
        server.once('connection', (socket) => {
          socket.send(Buffer.from('binary'));
        });

        const message = nextEvent(client, 'message');
        await client.connect({ host, port });
        const [{ data }] = await message;

        expect(data).toBeInstanceOf(Blob);
        expect(await (data as Blob).text()).toBe('binary');
      });

      test('echoes a round trip', async () => {
        server.on('connection', (socket) => {
          socket.on('message', (data, isBinary) => {
            socket.send(data, { binary: isBinary });
          });
        });

        await client.connect({ host, port });
        const echoed = nextEvent(client, 'message');
        await client.send({ data: 'ping' });

        expect(await echoed).toEqual([{ credential: undefined, data: 'ping' }]);
      });

      test('emits no message once a disconnect has begun', async () => {
        const messages: unknown[] = [];
        client.on('message', ({ data }) => {
          messages.push(data);
        });

        await client.connect({ host, port });
        client.socket!.onmessage!({ data: 'early' });

        const disconnecting = client.disconnect();
        client.socket!.onmessage!({ data: 'late' });
        await disconnecting;

        expect(messages).toEqual(['early']);
      });
    });

    test.describe('WSTransportClient #disconnect', () => {
      test('resolves when disconnecting', async () => {
        await client.connect({ host, port });
        await client.disconnect();
        expect(client.isClosed()).toBe(true);
      });

      test('rejects with a ReadyStateError before connecting', async () => {
        await expect(client.disconnect()).rejects.toBeInstanceOf(ReadyStateError);
      });

      test('rejects with a ReadyStateError on a closed connection', async () => {
        await client.connect({ host, port });
        await client.disconnect();
        await expect(client.disconnect()).rejects.toBeInstanceOf(ReadyStateError);
      });

      test('emits "close" with wasClean=true and wasQuick=false when the client disconnects', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        await client.disconnect();

        expect(await closed).toEqual([true, false]);
        expect(client.isClosed()).toBe(true);
      });

      test('emits "close" with wasClean=true and wasQuick=true when the client quickly disconnects', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        await client.disconnect({ isClean: true, isQuick: true });

        expect(await closed).toEqual([true, true]);
        expect(client.isClosed()).toBe(true);
        expect(client.socket).toBeNull();
      });

      test('emits "close" with wasClean=false and wasQuick=false when the server disconnects', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        for (const socket of server.clients) {
          socket.close();
        }

        expect(await closed).toEqual([false, false]);
        expect(client.isClosed()).toBe(true);
      });

      test('"[dispose]" during a disconnect settles it without a close, and the client can connect again', async () => {
        const closes: unknown[] = [];

        client.on('close', (...params) => {
          closes.push(params);
        });

        await client.connect({ host, port });
        const disconnecting = client.disconnect();
        drop(client);

        await disconnecting;
        // dropped, not closed by a handshake
        expect(closes).toEqual([]);
        expect(client.isClosed()).toBe(true);

        await client.connect({ host, port });
        expect(client.isOpen()).toBe(true);
      });

      test('an explicit undefined disconnect option falls back to its default', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        await client.disconnect({ isClean: undefined, isQuick: undefined });

        expect(await closed).toEqual([true, false]);
      });

      test('"[dispose]" on a client never connected does nothing', () => {
        expect(() => {
          drop(client);
        }).not.toThrow();
        expect(client.isUninitialized()).toBe(true);
      });

      test('"[dispose]" on an open client leaves it CLOSED and ready to connect again', async () => {
        await client.connect({ host, port });
        drop(client);

        expect(client.isClosed()).toBe(true);
        await expect(client.send({ data: 'x' })).rejects.toHaveProperty('got', ReadyState.CLOSED);

        await client.connect({ host, port });
        expect(client.isOpen()).toBe(true);
      });
    });

    test.describe('WSTransportClient #reconnect', () => {
      test('reconnects after a disconnect', async () => {
        await client.connect({ host, port });
        await client.disconnect();
        await client.reconnect({ delay: 10, maxAttempts: 1 });
        expect(client.isOpen()).toBe(true);
      });

      test('reconnects an open transport without emitting "close"', async () => {
        let closeCount = 0;
        client.on('close', () => {
          closeCount += 1;
        });

        await client.connect({ host, port });
        await client.reconnect({ delay: 10 });

        expect(client.isOpen()).toBe(true);
        expect(closeCount).toBe(0);
      });

      test('reconnects to the target of the last accepted connect', async () => {
        let connectionCount = 0;
        server.on('connection', () => {
          connectionCount += 1;
        });

        await client.connect({ host, port });
        await expect(client.connect({ host, port: port + 1 })).rejects.toBeInstanceOf(
          ProgrammerError
        );
        await client.reconnect({ delay: 0 });

        expect(client.isOpen()).toBe(true);
        expect(connectionCount).toBe(2);
      });

      test('rejects while a disconnect is pending', async () => {
        await client.connect({ host, port });
        const disconnecting = client.disconnect();

        await expect(client.reconnect()).rejects.toThrow('cannot reconnect while closing');
        await disconnecting;
      });

      test('rejects while a connect is pending, and that connect still opens', async () => {
        await client.connect({ host, port });
        await client.disconnect();

        const connecting = client.connect({ host, port });

        await expect(client.reconnect()).rejects.toBeInstanceOf(ProgrammerError);
        await connecting;
        expect(client.isOpen()).toBe(true);
      });

      test('rejects with a ReconnectError caused by a ConnectError when the server is gone', async () => {
        const reconnectOutcome = new Promise<unknown>((resolve) => {
          client.once('close', () => {
            client.reconnect({ delay: 10, maxAttempts: 2 }).then(resolve, resolve);
          });
        });

        await client.connect({ host, port });
        await stopServer(server);

        const reason = await reconnectOutcome;
        expect(reason).toBeInstanceOf(ReconnectError);
        expect((reason as ReconnectError).cause).toBeInstanceOf(ConnectError);
        expect(client.isClosed()).toBe(true);
      });
    });

    test.describe('WSTransportClient ReadyState', () => {
      test('only one ready state is true at a time', async () => {
        const states = () => {
          return {
            closed: client.isClosed(),
            closing: client.isClosing(),
            connecting: client.isConnecting(),
            open: client.isOpen(),
            reconnecting: client.isReconnecting(),
            uninitialized: client.isUninitialized(),
          };
        };
        const only = (key: keyof ReturnType<typeof states>) => {
          return {
            ...Object.fromEntries(
              Object.keys(states()).map((k) => {
                return [k, false];
              })
            ),
            [key]: true,
          };
        };

        expect(states()).toEqual(only('uninitialized'));

        const connecting = client.connect({ host, port });
        expect(states()).toEqual(only('connecting'));

        await connecting;
        expect(states()).toEqual(only('open'));

        const disconnecting = client.disconnect();
        expect(states()).toEqual(only('closing'));

        await disconnecting;
        expect(states()).toEqual(only('closed'));
      });
    });
  });
}

test.describe('WSTransportClient, with a scripted WebSocket', () => {
  test('keeps the cause an error event carries, and names the close by its reason', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });
    const cause = new Error('ECONNREFUSED');

    const connecting = client.connect({ host: 'h', port: 1 });

    sockets[0]?.fireError({ error: cause });
    sockets[0]?.fireClose({ code: 1006, reason: 'refused' });

    await expect(connecting).rejects.toThrow(ConnectError);
    await expect(connecting).rejects.toThrow('refused (1006)');
    await expect(connecting).rejects.toHaveProperty('cause', cause);
    expect(client.isClosed()).toBe(true);
  });

  test('an error event that carries nothing leaves the ConnectError without a cause', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });

    for (const event of [undefined, 'error', {}]) {
      const connecting = client.connect({ host: 'h', port: 1 });
      const socket = sockets.at(-1);

      socket?.fireError(event);
      socket?.fireClose({ code: 1006, reason: '' });

      const error = await connecting.then(
        () => {
          return undefined;
        },
        (reason: unknown) => {
          return reason;
        }
      );

      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).message).toBe('1006');
      expect((error as ConnectError).cause).toBeUndefined();
    }
  });

  test('a close that throws on disconnect drops the socket, ends CLOSED, and rejects with a ProgrammerError', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });
    const closes: unknown[] = [];

    client.on('close', (...params) => {
      closes.push(params);
    });

    const connecting = client.connect({ host: 'h', port: 1 });

    sockets[0]?.fireOpen();
    await connecting;

    if (sockets[0] !== undefined) {
      sockets[0].closeBehaviour = 'throw';
    }

    await expect(client.disconnect()).rejects.toBeInstanceOf(ProgrammerError);
    expect(client.isClosed()).toBe(true);
    expect(client.socket).toBeNull();
    expect(closes).toEqual([]);

    // and it can connect again
    const again = client.connect({ host: 'h', port: 1 });

    sockets[1]?.fireOpen();
    await again;

    expect(client.isOpen()).toBe(true);
  });

  test('a second disconnect, rejected, leaves the first for dispose to settle, with no close', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });
    const closes: unknown[] = [];

    client.on('close', (...params) => {
      closes.push(params);
    });

    const connecting = client.connect({ host: 'h', port: 1 });

    sockets[0]?.fireOpen();
    await connecting;

    if (sockets[0] !== undefined) {
      sockets[0].closeBehaviour = 'ignore';
    }

    // the peer never answers the first close
    const first = client.disconnect();

    await expect(client.disconnect()).rejects.toBeInstanceOf(ReadyStateError);

    drop(client);

    await expect(first).resolves.toBeUndefined();
    expect(client.isClosed()).toBe(true);
    // dropped without a handshake, as a dispose does: no close says otherwise
    expect(closes).toEqual([]);

    const again = client.connect({ host: 'h', port: 1 });

    sockets[1]?.fireOpen();
    await again;

    expect(client.isOpen()).toBe(true);
  });

  test('a dispose or a close between the open and the end of connect is not undone', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });
    const closes: unknown[] = [];

    client.on('close', (...params) => {
      closes.push(params);
    });

    const disposed = client.connect({ host: 'h', port: 1 });

    sockets[0]?.fireOpen();
    drop(client);

    await expect(disposed).rejects.toThrow('closed as it opened');
    expect(client.isOpen()).toBe(false);
    expect(client.socket).toBeNull();

    const closed = client.connect({ host: 'h', port: 1 });

    sockets[1]?.fireOpen();
    sockets[1]?.fireClose({ code: 1006, reason: '' });

    await expect(closed).rejects.toBeInstanceOf(ConnectError);
    expect(client.isClosed()).toBe(true);
    // the close of a connection that did open, once
    expect(closes).toEqual([[false, false]]);
  });

  test('holds its connect’s timeout to a whole number of milliseconds on its clock, rounded, Infinity never timing out, refusing 0 and any other and opening nothing', async () => {
    for (const { given, held, outcome, refusal } of durationsOf("a connect's timeout", {
      never: 'never',
      zero: 'refused',
    })) {
      const clock = createTestClock();
      const { FakeWebSocket, sockets: opened } = createFakeWebSocket();
      const client = createWSTransportClient({ clock, WebSocket: FakeWebSocket });
      const controller = new AbortController();
      const label = String(given);
      let isSettled = false;
      const connecting = client
        .connect({ host: 'h', port: 1, signal: controller.signal, timeout: given })
        .catch((reason: unknown) => {
          return reason;
        })
        .finally(() => {
          isSettled = true;
        });

      if (outcome === 'refused') {
        expect(await connecting, label).toEqual(new ProgrammerError(refusal));
        // nothing moved, and nothing is kept for a reconnection
        expect([opened, client.isUninitialized()], label).toEqual([[], true]);
        await expect(client.reconnect(), label).rejects.toThrow('transport was never connected');

        continue;
      }

      // a duration held times the connect out once it passed, its TimeoutError telling it; never
      // waits on past the longest
      if (outcome === 'taken' && held !== undefined) {
        await clock.tickAsync(held - 1);

        expect(client.isConnecting(), label).toBe(true);

        await clock.tickAsync(1);

        const ended = await connecting;

        expect(ended, label).toBeInstanceOf(TimeoutError);
        expect(ended, label).toHaveProperty('timeout', held);
      } else {
        await clock.tickAsync(LONGEST_TIMER);

        expect([isSettled, client.isConnecting()], label).toEqual([false, true]);

        controller.abort();

        expect(await connecting, label).toBeInstanceOf(CancelError);
      }

      expect(client.isClosed(), label).toBe(true);
    }
  });

  test('brackets an IPv6 literal host', async () => {
    const urls: string[] = [];
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const Recording = Object.assign(
      // oxlint-disable-next-line prefer-arrow-callback -- the transport calls it with `new`, which an arrow refuses
      function (url: string) {
        urls.push(url);

        return new (FakeWebSocket as unknown as new () => object)();
      },
      { CONNECTING: 0, OPEN: 1 }
    ) as unknown as typeof FakeWebSocket;
    const client = createWSTransportClient({ WebSocket: Recording });

    for (const host of ['::1', '[::1]', '127.0.0.1', 'example.test']) {
      const connecting = client.connect({ host, port: 8080 });

      sockets.at(-1)?.fireOpen();
      await connecting;
      await client.disconnect();
    }

    expect(urls).toEqual([
      'ws://[::1]:8080/',
      'ws://[::1]:8080/',
      'ws://127.0.0.1:8080/',
      'ws://example.test:8080/',
    ]);
  });

  test('dispose drops a connecting socket even when its close throws', async () => {
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });

    const connecting = client.connect({ host: 'h', port: 1 });

    if (sockets[0] !== undefined) {
      sockets[0].closeBehaviour = 'throw';
    }

    expect(() => {
      drop(client);
    }).not.toThrow();
    await expect(connecting).rejects.toThrow('disposed while connecting');
    expect(sockets[0]?.closeCodes).toEqual([undefined]);
    expect(client.socket).toBeNull();
  });
});

test.describe('WSTransportClient, heartbeat', () => {
  test('pings its server every heartbeat over a socket that can, and closes at the beat after a ping it left unanswered', async () => {
    const { FakeWebSocket, sockets: made } = createFakeWebSocket({ canPing: true });
    const client = createWSTransportClient({ heartbeat: 20, WebSocket: FakeWebSocket });
    const connecting = client.connect({ host, port: 80 });
    const socket = made[0];
    const closed = nextEvent(client, 'close');

    // three answered, the fourth not
    if (socket !== undefined) {
      socket.answeredPings = 3;
    }

    socket?.fireOpen();
    await connecting;

    // dropped at the beat after, as a network drops it
    expect(await closed).toEqual([false, false]);
    expect([socket?.pings, socket?.wasTerminated]).toEqual([4, true]);
    expect(client.isClosed()).toBe(true);
  });

  test('beats every HEARTBEAT when told nothing', async () => {
    using timers = spyIntervals();
    const { FakeWebSocket, sockets: made } = createFakeWebSocket({ canPing: true });
    const client = createWSTransportClient({ WebSocket: FakeWebSocket });
    const connecting = client.connect({ host, port: 80 });

    made[0]?.fireOpen();
    await connecting;

    expect(
      timers.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([HEARTBEAT]);

    await client.disconnect();
  });

  test('beats nothing over a socket that cannot ping, a browser’s, nor with a heartbeat of Infinity; refuses one no timer holds', async () => {
    const browser = createFakeWebSocket();
    const pinging = createFakeWebSocket({ canPing: true });
    const clients = [
      createWSTransportClient({ heartbeat: 20, WebSocket: browser.FakeWebSocket }),
      createWSTransportClient({ heartbeat: Infinity, WebSocket: pinging.FakeWebSocket }),
    ];

    for (const [index, client] of clients.entries()) {
      const connecting = client.connect({ host, port: 80 });

      [browser, pinging][index]?.sockets[0]?.fireOpen();
      await connecting;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(
      clients.map((client) => {
        return client.isOpen();
      })
    ).toEqual([true, true]);
    expect(pinging.sockets[0]?.pings).toBe(0);

    for (const heartbeat of [0, 0.5, 2 ** 31]) {
      expect(() => {
        return createWSTransportClient({ heartbeat, WebSocket: pinging.FakeWebSocket });
      }, String(heartbeat)).toThrow(ProgrammerError);
    }
  });

  test('stops beating once disconnected, dropped or closed by its server, and pings no socket that is closing', async () => {
    const { FakeWebSocket, sockets: made } = createFakeWebSocket({ canPing: true });
    const disconnected = createWSTransportClient({ heartbeat: 20, WebSocket: FakeWebSocket });
    const dropped = createWSTransportClient({ heartbeat: 20, WebSocket: FakeWebSocket });
    const closing = createWSTransportClient({ heartbeat: 20, WebSocket: FakeWebSocket });
    const closed = createWSTransportClient({ heartbeat: 20, WebSocket: FakeWebSocket });

    for (const [index, client] of [disconnected, dropped, closing, closed].entries()) {
      const connecting = client.connect({ host, port: 80 });

      made[index]?.fireOpen();
      await connecting;
    }

    await disconnected.disconnect();
    drop(dropped);
    made[3]?.fireClose({ code: 1001, reason: '' });

    // the server started its close handshake: no ping goes on it, and it is dropped all the same
    (made[2] as { readyState: number }).readyState = 2;

    await expect
      .poll(() => {
        return made[2]?.wasTerminated;
      })
      .toBe(true);

    // those that closed are never dropped, as a heartbeat still going would drop them
    expect(
      made.map((socket) => {
        return [socket.pings, socket.wasTerminated];
      })
    ).toEqual([
      [0, false],
      [0, false],
      [0, true],
      [0, false],
    ]);
  });

  test('closes when its server leaves its pings unanswered, over ws', async () => {
    const server = await startServer({ autoPong: false });
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const client = createWSTransportClient({
      heartbeat: 40,
      WebSocket: TrackedWsWebSocket as unknown as IWebSocketConstructor,
    });

    try {
      await client.connect({ host, port: portOf(server) });

      expect(await nextEvent(client, 'close')).toEqual([false, false]);
    } finally {
      await stopServer(server);
      await allClosed();
    }
  });
});
