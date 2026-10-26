import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createNodeServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { type WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import {
  CancelError,
  ConnectError,
  type Data,
  dispose,
  type ITransportClient,
  type ITransportClientInternal,
  PLATFORM_CLOCK,
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
  DURATIONS,
  givenOf,
  isExcused,
  outcomeOf,
  refusalOf,
} from '../../shared/__tests__/durations';
import {
  allClosed,
  closedPort,
  createTestClock,
  delaysOn,
  host,
  IMPLEMENTATIONS,
  portOf,
  reachedByLocalhost,
  sockets,
  spyIntervals,
  startServer,
  stopServer,
  trapUncaught,
} from '../../shared/__tests__/fixtures';
import {
  CLOSE_TIMEOUT,
  createWSTransportClient,
  HEARTBEAT,
  MAXIMUM_MESSAGE_BYTES,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IWebSocketConstructor,
  type WSTransportClient,
} from '../ws-transport-client';
import { createWSTransportServer } from '../../server/ws-transport-server';
import { hasIPv6Loopback } from '../../server/__tests__/addresses';
import { createFakeWebSocket } from './fake-websocket';

/** The drop only an implementation reaches, as the base and the transport use it. */
const drop = (client: ITransportClient<object, never>): void => {
  (client as ITransportClientInternal<object, never>)[dispose]();
};

/**
 * Whether a client carries a credential, and is secure, once a connect to `target` was tried — the
 * judgement made from the URL it was given, its socket refused.
 */
const judgedOf = async (target: { host: string; secured?: boolean; port?: number }) => {
  const client = createWSTransportClient({
    // no constructor at all: the socket it would open is refused as it is made
    WebSocket: (() => {
      return undefined;
    }) as unknown as IWebSocketConstructor,
  });

  await client.connect({ port: 8_080, ...target }).catch(() => {});

  return [client.carries(BEARER), client.isSecure];
};

/** What a reconnection its signal ended rejects with, as both sides word it. */
const RECONNECTION_CANCELLED = Object.freeze({
  message: 'the reconnection was cancelled',
  name: 'CancelError',
});

// a bearer credential, as RFC 6750 §2.1 writes one
const BEARER = 'Bearer mF_9.B5f-4.1JqM';

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

    test('releases a replacement opened by its close listener before dispose completes', async () => {
      const closes: boolean[][] = [];
      const errors: Error[] = [];
      let replacement: Promise<unknown> | undefined;

      client.on('close', (...flags) => {
        closes.push(flags);
        replacement = client.connect({ host, port }).catch((reason: unknown) => {
          return reason;
        });
      });
      client.on('error', (error) => {
        errors.push(error);
      });
      await client.connect({ host, port });

      try {
        await client[Symbol.asyncDispose]();
        expect(client.isClosed()).toBe(true);
        expect(replacement).toBeDefined();
        const outcome = await replacement;

        expect(outcome === undefined || outcome instanceof ConnectError).toBe(true);
        expect([client.isClosed(), client.socket, closes, errors]).toEqual([
          true,
          null,
          [[true, false]],
          [],
        ]);
        await expect
          .poll(() => {
            return server.clients.size;
          })
          .toBe(0);
      } finally {
        drop(client);
      }
    });

    test('cancels a reconnection whose last attempt closes before cancellation is checked', async () => {
      const cancelling = new AbortController();
      const reason = new Error('the attempt closes before the cancellation check');
      const closes: boolean[][] = [];
      const errors: Error[] = [];
      const closedAtServer: Promise<unknown>[] = [];

      server.on('connection', (socket) => {
        closedAtServer.push(once(socket, 'close'));
      });
      client.on('close', (...flags) => {
        closes.push(flags);
      });
      client.on('error', (error) => {
        errors.push(error);
      });
      await client.connect({ host, port });

      const connect = client.connect;
      let attempts = 0;

      client.connect = async (options) => {
        await connect(options);
        attempts += 1;
        expect(client.isOpen()).toBe(true);
        await client.disconnect({ isQuick: true });
        cancelling.abort(reason);
      };

      const cancelled: unknown = await client
        .reconnect({ maxAttempts: 1, signal: cancelling.signal })
        .catch((error: unknown) => {
          return error;
        });

      await Promise.all(closedAtServer);
      expect(cancelled).toBeInstanceOf(CancelError);
      expect(cancelled).toMatchObject({ cause: reason, message: 'the reconnection was cancelled' });
      expect([attempts, client.isClosed(), closes, errors, server.clients.size]).toEqual([
        1,
        true,
        [[true, true]],
        [],
        0,
      ]);
      expect(closedAtServer).toHaveLength(2);
    });

    test.describe('WSTransportClient #connect', () => {
      test('resolves when connecting to a valid endpoint', async () => {
        await client.connect({ host, port });
        expect(client.isOpen()).toBe(true);
      });

      // spec 15.2
      test('writes no Origin on its upgrade', async () => {
        const upgraded = new Promise<string | undefined>((resolve) => {
          server.once('connection', (_socket, request) => {
            resolve(request.headers.origin);
          });
        });

        await client.connect({ host, port });

        // a page's browser writes its own, which the server judges; the client, none
        expect(await upgraded).toBeUndefined();
      });

      if (label === 'ws') {
        test('offers no extension in its upgrade, permessage-deflate among them', async () => {
          const offer = Promise.withResolvers<string | string[] | undefined>();
          const refusing = await startServer({
            perMessageDeflate: true,
            verifyClient: (info, done) => {
              offer.resolve(info.req.headers['sec-websocket-extensions']);
              done(false, 503);
            },
          });

          try {
            await expect(client.connect({ host, port: portOf(refusing) })).rejects.toBeInstanceOf(
              ConnectError
            );
            expect(await offer.promise).toBeUndefined();
            expect(client.isClosed()).toBe(true);
          } finally {
            await stopServer(refusing);
          }
        });
      } else {
        test('leaves the global WebSocket’s extension offer to its platform', async () => {
          const offers: (string | string[] | undefined)[] = [];
          const extensions: string[] = [];

          server.on('connection', (socket, request) => {
            offers.push(request.headers['sec-websocket-extensions']);
            extensions.push(socket.extensions);
          });

          const direct = new WebSocket(`ws://${host}:${String(port)}/`);

          try {
            await once(direct, 'open');
            await client.connect({ host, port });
            expect(offers).toHaveLength(2);
            expect(offers[1]).toEqual(offers[0]);
            expect(extensions).toEqual(['', '']);
            expect(direct.extensions).toBe('');
            expect(client.socket).toHaveProperty('extensions', '');
            expect(client.isOpen()).toBe(true);
          } finally {
            if (direct.readyState === WebSocket.OPEN) {
              const closed = once(direct, 'close');

              direct.close();
              await closed;
            } else {
              direct.close();
            }
          }
        });
      }

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
        await expect(reconnecting).rejects.toMatchObject(RECONNECTION_CANCELLED);
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
        // its timeout on the test clock, which alone moves it
        const clock = createTestClock();
        const timed = createWSTransportClient({ clock, WebSocket: TrackedWebSocket });

        try {
          const connecting = timed.connect({ host, port: portOf(gatedServer), timeout: 100 });
          const refused = expect(connecting).rejects.toThrow(new TimeoutError(100));

          // its handshake held at the server
          await expect
            .poll(() => {
              return pendingHandshakes.length;
            })
            .toBe(1);
          await clock.tickAsync(100);
          await refused;

          expect(timed.isClosed()).toBe(true);
          expect(timed.socket).toBeNull();

          // the socket closes on its own, with the server still holding its handshake
          await allClosed();
        } finally {
          for (const done of pendingHandshakes) {
            done(false);
          }
          await stopServer(gatedServer);
        }
      });

      test('waits on its handshake without end with an infinite timeout until its signal aborts', async () => {
        const pendingHandshakes: ((result: boolean) => void)[] = [];
        const gatedServer = await startServer({
          verifyClient: (_info, done) => {
            pendingHandshakes.push(done);
          },
        });
        const clock = createTestClock();
        const waiting = createWSTransportClient({ clock, WebSocket: TrackedWebSocket });

        try {
          const controller = new AbortController();
          const connecting = waiting.connect({
            host,
            port: portOf(gatedServer),
            signal: controller.signal,
            timeout: Infinity,
          });
          const cancelled = expect(connecting).rejects.toBeInstanceOf(CancelError);

          await expect
            .poll(() => {
              return pendingHandshakes.length;
            })
            .toBe(1);

          // a day, where the 30 seconds a timeout left at its default would have passed: no timer
          // armed, and still connecting
          await clock.tickAsync(86_400_000);

          expect([waiting.isConnecting(), delaysOn(clock)]).toEqual([true, []]);

          controller.abort('why');
          await cancelled;

          expect(waiting.isClosed()).toBe(true);
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

        const hello = Promise.withResolvers<number>();
        let peer: Socket | undefined;
        const listener = createTcpServer((socket) => {
          peer = socket;
          socket.once('data', (bytes: Buffer) => {
            hello.resolve(bytes[0] ?? -1);
          });
          socket.on('error', () => {});
        });

        listener.listen(0, host);
        await once(listener, 'listening');

        const controller = new AbortController();
        const connecting = client
          .connect({
            host,
            port: (listener.address() as AddressInfo).port,
            secured: true,
            signal: controller.signal,
          })
          .catch((reason: unknown) => {
            return reason;
          });

        try {
          expect(await hello.promise).toBe(0x16);
          controller.abort();
          expect(await connecting).toBeInstanceOf(CancelError);
        } finally {
          peer?.destroy();
          await new Promise<void>((resolve) => {
            listener.close(() => {
              resolve();
            });
          });
        }
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

      test('delivers a fragmented message whole then the next message separately', async () => {
        server.once('connection', (socket) => {
          socket.send(Uint8Array.of(1, 2), { fin: false });
          socket.send(Uint8Array.of(3), { fin: true });
          socket.send(Uint8Array.of(4));
        });
        const messages: number[][] = [];
        const both = new Promise<void>((resolve) => {
          client.on('message', ({ data }) => {
            expect(data).toBeInstanceOf(ArrayBuffer);
            messages.push([...new Uint8Array(data as ArrayBuffer)]);
            if (messages.length === 2) {
              resolve();
            }
          });
        });

        await client.connect({ host, port });
        await both;

        expect(messages).toEqual([[1, 2, 3], [4]]);
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

      test('hears the next message after a message listener throws, the throw reported', async () => {
        const thrown = new Error('a message listener that throws');
        const reported: Error[] = [];
        const messages: unknown[] = [];

        server.once('connection', (socket) => {
          socket.send('first');
          socket.send(Uint8Array.of(1));
          socket.send('second');
          socket.send(Uint8Array.of(2));
        });
        client.once('message', () => {
          throw thrown;
        });
        client.on('error', (error) => {
          reported.push(error);
        });

        const both = new Promise<void>((resolve) => {
          client.on('message', ({ data }) => {
            messages.push(data);
            if (messages.length === 4) {
              resolve();
            }
          });
        });

        await client.connect({ host, port });
        await both;

        expect(messages).toEqual([
          'first',
          expect.any(ArrayBuffer),
          'second',
          expect.any(ArrayBuffer),
        ]);
        expect([...new Uint8Array(messages[1] as ArrayBuffer)]).toEqual([1]);
        expect([...new Uint8Array(messages[3] as ArrayBuffer)]).toEqual([2]);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toBe(thrown);
        expect(client.isOpen()).toBe(true);
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
        const connection = nextConnection(server);

        await client.connect({ host, port });

        const { socket } = await connection;
        const serverClosed = once(socket, 'close');

        await client.disconnect();

        expect(await closed).toEqual([true, false]);
        expect(client.isClosed()).toBe(true);
        // its 1000, at the server's end too
        expect((await serverClosed)[0]).toBe(1000);
      });

      test('emits "close" with wasClean=true and wasQuick=true when the client quickly disconnects', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        await client.disconnect({ isClean: true, isQuick: true });

        expect(await closed).toEqual([true, true]);
        expect(client.isClosed()).toBe(true);
        expect(client.socket).toBeNull();
      });

      test('emits "close" with wasClean=false and wasQuick=false when the server disconnects, and refuses a send after it', async () => {
        const closed = nextEvent(client, 'close');

        await client.connect({ host, port });
        for (const socket of server.clients) {
          socket.close();
        }

        expect(await closed).toEqual([false, false]);
        expect(client.isClosed()).toBe(true);
        await expect(client.send({ data: Uint8Array.of(1) })).rejects.toBeInstanceOf(
          ReadyStateError
        );
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

      test('reconnects though a reconnect listener throws, the throw reported, the next listener told', async () => {
        const reported: Error[] = [];
        let told = 0;

        client.on('reconnect', () => {
          throw new Error('a reconnect listener that throws');
        });
        client.on('reconnect', () => {
          told += 1;
        });
        client.on('error', (error) => {
          reported.push(error);
        });

        await client.connect({ host, port });
        await client.disconnect();
        await client.reconnect({ delay: 10, maxAttempts: 1 });

        expect(client.isOpen()).toBe(true);
        expect(told).toBe(1);
        expect(
          reported.map((error) => {
            return error.message;
          })
        ).toEqual(['a reconnect listener that throws']);
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

        await expect(client.reconnect()).rejects.toThrow(
          'the transport client cannot reconnect while closing'
        );
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

    for (const address of ['127.0.0.1', '::1']) {
      if (address === '::1' && !(await hasIPv6Loopback())) {
        continue;
      }

      const server = await startServer({ host: address });
      const real = createWSTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

      try {
        for (const host of address === '::1' ? ['::1', '[::1]'] : ['127.0.0.1', 'localhost']) {
          await real.connect({ host, port: portOf(server) });
          expect(real.isOpen()).toBe(true);
          await real.disconnect();
        }
      } finally {
        await stopServer(server);
        await allClosed();
      }
    }
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
    await expect(connecting).rejects.toThrow('the transport client was disposed as it connected');
    expect(sockets[0]?.closeCodes).toEqual([undefined]);
    expect(client.socket).toBeNull();
  });
});

test.describe('WSTransportClient, what it carries', () => {
  const [[, TrackedGlobal], [, TrackedWs]] = IMPLEMENTATIONS;
  const Ws = TrackedWs as unknown as IWebSocketConstructor;

  test('drops an upgrade disposed by its provider completion callback before it keeps a connection', async () => {
    const server = await startServer();
    const client = createWSTransportClient({ WebSocket: Ws });
    const closes: boolean[][] = [];
    const errors: Error[] = [];
    const serverCloses: Promise<unknown[]>[] = [];
    const completionStates: boolean[] = [];

    server.on('connection', (socket) => {
      serverCloses.push(once(socket, 'close'));
    });
    client.on('close', (...flags) => {
      closes.push(flags);
    });
    client.on('error', (error) => {
      errors.push(error);
    });

    try {
      const failure: unknown = await client
        .connect({
          host,
          port: portOf(server),
          credentialProvider: ({ signal }) => {
            signal.addEventListener(
              'abort',
              () => {
                completionStates.push(client.isConnecting());
                drop(client);
              },
              { once: true }
            );

            return BEARER;
          },
        })
        .catch((reason: unknown) => {
          return reason;
        });

      expect(failure).toBeInstanceOf(ConnectError);
      expect(failure).toMatchObject({ message: 'closed as it opened' });
      expect([completionStates, client.isClosed(), client.socket, closes, errors]).toEqual([
        [true],
        true,
        null,
        [],
        [],
      ]);
      await Promise.all(serverCloses);
      expect([serverCloses.length, server.clients.size]).toEqual([1, 0]);

      await client.connect({ host, port: portOf(server) });
      expect(client.isOpen()).toBe(true);
      await client.disconnect({ isQuick: true });
      await Promise.all(serverCloses);

      expect([client.isClosed(), closes, errors, server.clients.size]).toEqual([
        true,
        [[true, true]],
        [],
        0,
      ]);
    } finally {
      drop(client);
      await stopServer(server);
      await allClosed();
    }
  });

  // the Authorization lines of each upgrade `hearing` took, as they came
  const upgradesOf = (hearing: Awaited<ReturnType<typeof startRefusing>>) => {
    const heard: string[][] = [];

    hearing.upgrading.on('connection', (_socket, request) => {
      const { rawHeaders } = request;

      heard.push(
        rawHeaders.filter((_value, index) => {
          return index % 2 === 1 && rawHeaders[index - 1]?.toLowerCase() === 'authorization';
        })
      );
    });

    return heard;
  };

  test('carries no credential its upgrade did not carry, and is secure under wss or to a loopback host, judged by the URL it was given', async () => {
    const unstarted = createWSTransportClient();

    expect([unstarted.carries(BEARER), unstarted.isSecure]).toEqual([false, false]);
    expect(
      await Promise.all([
        judgedOf({ host: 'bead.example', secured: true }),
        judgedOf({ host: 'localhost' }),
        judgedOf({ host: '127.0.0.1' }),
        judgedOf({ host: '::1' }),
        judgedOf({ host: 'bead.example' }),
        judgedOf({ host: '192.0.2.1' }),
        judgedOf({ host: '192.0.2.1', secured: true }),
        judgedOf({ host: '192.0.2.1', port: 80 }),
        judgedOf({ host: '192.0.2.1', port: 443, secured: true }),
      ])
    ).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, false],
      [false, false],
      [false, true],
      [false, false],
      [false, true],
    ]);

    const server = await startServer();
    const connected = createWSTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

    try {
      await connected.connect({ host, port: portOf(server) });
      expect([connected.carries(BEARER), connected.isSecure]).toEqual([false, true]);
      await connected.disconnect();
    } finally {
      await stopServer(server);
      await allClosed();
    }
  });

  // spec 15.1 and 15.2
  test('writes the credential it is given on its upgrade, and carries those bytes alone', async () => {
    await using hearing = await startRefusing();
    const heard = upgradesOf(hearing);
    const client = createWSTransportClient({ WebSocket: Ws });

    // none before its first connect
    expect(client.carries(BEARER)).toBe(false);

    await client.connect({ credential: BEARER, host, port: hearing.port });

    // its Authorization, one line, as given
    expect(heard).toEqual([[BEARER]]);
    const received = once([...hearing.upgrading.clients][0]!, 'message') as Promise<
      [Buffer, boolean]
    >;
    await client.send({ credential: BEARER, data: new TextEncoder().encode('hello') });
    const [data, isBinary] = await received;
    expect([data.toString(), isBinary]).toEqual(['hello', true]);
    // those bytes alone, none a byte off, longer or shorter, nor trimmed of what a field cannot hold
    expect(client.carries(BEARER)).toBe(true);
    expect(
      [
        'Bearer mF_9.B5f-4.1JqN',
        `${BEARER}x`,
        BEARER.slice(0, -1),
        ` ${BEARER}`,
        '',
        'Bearer mF_9.B5f-4.1Jq?',
      ].map((other) => {
        return client.carries(other);
      })
    ).toEqual([false, false, false, false, false, false]);

    await client.disconnect();

    // none once its connection is gone
    expect(client.carries(BEARER)).toBe(false);

    // none on an upgrade given none, an empty one among them
    await client.connect({ host, port: hearing.port });
    expect([client.carries(''), client.carries(BEARER)]).toEqual([false, false]);
    await client.disconnect();
    for (const given of [undefined, '']) {
      const bare = createWSTransportClient({ WebSocket: Ws });

      await bare.connect({ credential: given, host, port: hearing.port });
      expect([bare.carries(''), bare.carries(BEARER)]).toEqual([false, false]);
      await bare.disconnect();
    }

    expect(heard).toEqual([[BEARER], [], [], []]);
  });

  // spec 15.2
  test('calls its credential provider at each attempt, a reconnection’s included, and carries the bytes it handed', async () => {
    await using hearing = await startRefusing();
    const heard = upgradesOf(hearing);
    const signals: AbortSignal[] = [];
    const away = new Error('the token store is away');
    let handed = 0;
    const client = createWSTransportClient({ WebSocket: Ws });

    await client.connect({
      credentialProvider: ({ signal }) => {
        signals.push(signal);
        handed += 1;

        // * its second call throws: that attempt fails, its throw the cause, and the next calls it
        // again
        if (handed === 2) {
          throw away;
        }

        return Promise.resolve(`Bearer token-${String(handed)}`);
      },
      host,
      port: hearing.port,
    });

    expect([heard, client.carries('Bearer token-1'), handed]).toEqual([
      [['Bearer token-1']],
      true,
      1,
    ]);

    await client.reconnect({ delay: 0, maxAttempts: 2 });

    // the failed attempt went nowhere: the next one carries what the provider handed it
    expect([
      heard,
      client.carries('Bearer token-1'),
      client.carries('Bearer token-3'),
      handed,
    ]).toEqual([[['Bearer token-1'], ['Bearer token-3']], false, true, 3]);
    // each told when its attempt is over
    expect(
      signals.map(({ aborted }) => {
        return aborted;
      })
    ).toEqual([true, true, true]);
    await client.disconnect();

    // a provider's throw fails the connect, its cause
    const failing = createWSTransportClient({ WebSocket: Ws });
    const reason: unknown = await failing
      .connect({
        credentialProvider: () => {
          throw away;
        },
        host,
        port: hearing.port,
      })
      .catch((error: unknown) => {
        return error;
      });

    expect([reason instanceof ConnectError, (reason as ConnectError).cause]).toEqual([true, away]);
    expect([failing.isClosed(), heard.length]).toEqual([true, 2]);
  });

  // spec 13.4, 15.2 and 15.5
  test('refuses a credential that is no field value, a space or a tab first or last among them, or over a URL in the clear off the loopback, before its upgrade goes', async () => {
    await using hearing = await startRefusing();
    const heard = upgradesOf(hearing);
    const client = createWSTransportClient({ WebSocket: Ws });
    const target = { host, port: hearing.port };

    for (const credential of [
      ` ${BEARER}`,
      `${BEARER} `,
      `\t${BEARER}`,
      `${BEARER}\t`,
      'Bearer a\r\nb',
      'Bearer é',
      'Bearer \u0000',
    ]) {
      await expect(
        client.connect({ ...target, credential }),
        JSON.stringify(credential)
      ).rejects.toThrow(
        new ProgrammerError(
          'a credential holds visible ASCII, spaces and tabs alone, none first or last'
        )
      );
    }

    // the upgrade itself would carry it in the clear, a provider's alike, which is never called
    let called = 0;
    const credentialProvider = () => {
      called += 1;

      return BEARER;
    };

    for (const faraway of [
      { ...target, credential: BEARER, host: '192.0.2.1' },
      { ...target, credentialProvider, host: 'example.com' },
    ]) {
      await expect(client.connect(faraway)).rejects.toThrow(
        new ProgrammerError(
          'a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback'
        )
      );
    }

    // nothing moved: no state, no target a reconnection replays, no upgrade sent
    expect([called, client.isUninitialized(), heard]).toEqual([0, true, []]);
    await expect(client.reconnect()).rejects.toThrow('the transport client was never connected');

    // a provider's value, held alike once handed: the connect fails, and a reconnection does not
    // try again what no attempt would mend
    let handed = BEARER;
    const provided = createWSTransportClient({ WebSocket: Ws });

    await provided.connect({
      ...target,
      credentialProvider: () => {
        called += 1;

        return handed;
      },
    });
    handed = `${BEARER} `;

    await expect(provided.reconnect({ delay: 0, maxAttempts: 3 })).rejects.toThrow(
      new ProgrammerError(
        'a credential holds visible ASCII, spaces and tabs alone, none first or last'
      )
    );
    expect([called, provided.isClosed(), heard]).toEqual([2, true, [[BEARER]]]);
  });

  test('opens no connection when its credential provider settles after cancellation', async () => {
    await using hearing = await startRefusing();
    const heard = upgradesOf(hearing);
    const entered = Promise.withResolvers<AbortSignal>();
    const answer = Promise.withResolvers<string>();
    const cancelling = new AbortController();
    const errors: Error[] = [];
    const closes: boolean[][] = [];
    const before = sockets.size;
    await using client = createWSTransportClient({ WebSocket: Ws });

    client.on('error', (error) => {
      errors.push(error);
    });
    client.on('close', (...flags) => {
      closes.push(flags);
    });

    const connecting = client.connect({
      credentialProvider: ({ signal }) => {
        entered.resolve(signal);

        return answer.promise;
      },
      host,
      port: hearing.port,
      signal: cancelling.signal,
    });
    const cancelled = expect(connecting).rejects.toBeInstanceOf(CancelError);
    const providerSignal = await entered.promise;

    try {
      cancelling.abort();
      await cancelled;
      expect(providerSignal.aborted).toBe(true);
    } finally {
      answer.resolve(BEARER);
    }

    // * past the provider's continuation: a cancelled attempt never constructs its socket.
    await new Promise(setImmediate);

    expect([client.isClosed(), client.carries(BEARER), heard, errors, closes]).toEqual([
      true,
      false,
      [],
      [],
      [],
    ]);
    expect(sockets.size).toBe(before);
  });

  test('refuses a credential and a credential provider given together', async () => {
    const client = createWSTransportClient({ WebSocket: Ws });

    await expect(
      client.connect({
        credential: BEARER,
        credentialProvider: () => {
          return BEARER;
        },
        host,
        port: 8_080,
      })
    ).rejects.toThrow(
      new ProgrammerError('a connect takes a credential or a credential provider, not both')
    );
    expect(client.isUninitialized()).toBe(true);
  });

  // a platform's: a page's script writes no field of its own choosing on an upgrade (WHATWG
  // WebSockets Standard), nor does Node's global but in a call shape of undici's own
  test('refuses a credential over a WebSocket constructor without ws’s shape, a page’s and Node’s global among them', async () => {
    await using hearing = await startRefusing();
    const heard = upgradesOf(hearing);
    let called = 0;
    // a subclass of the global, and a wrapper of it, as a page's script would build one
    const Subclass = class extends WebSocket {};
    const Wrapper = function (url: string, protocols?: string | string[]) {
      return new WebSocket(url, protocols);
    } as unknown as IWebSocketConstructor;

    for (const Constructor of [
      TrackedGlobal,
      Subclass as unknown as IWebSocketConstructor,
      Object.assign(Wrapper, { CONNECTING: 0, OPEN: 1 }),
    ]) {
      const client = createWSTransportClient({ WebSocket: Constructor });

      for (const given of [
        { credential: BEARER },
        {
          credentialProvider: () => {
            called += 1;

            return BEARER;
          },
        },
      ]) {
        await expect(client.connect({ ...given, host, port: hearing.port })).rejects.toThrow(
          "a credential is written on its upgrade by ws's WebSocket alone"
        );
      }

      expect(client.isUninitialized()).toBe(true);
    }

    // given none, the global connects as ever
    const plain = createWSTransportClient({ WebSocket: TrackedGlobal });

    await plain.connect({ host, port: hearing.port });
    await plain.disconnect();
    expect([called, heard]).toEqual([0, [[]]]);
  });

  // spec 15.6
  test('fails its connect on a redirect answered to its upgrade, naming its status', async () => {
    // to a server that would take the upgrade: followed, the connect would open there
    await using taking = await startRefusing();
    const heard = upgradesOf(taking);
    await using redirecting = await startRefusing(
      `HTTP/1.1 302 Found\r\nLocation: ws://${host}:${String(taking.port)}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    );

    for (const [Constructor, message] of [
      [Ws, 'the server refused the upgrade: 302'],
      [TrackedGlobal, '1006'],
    ] as const) {
      const client = createWSTransportClient({ WebSocket: Constructor });
      const reason: unknown = await client
        .connect({
          credential: Constructor === Ws ? BEARER : undefined,
          host,
          port: redirecting.port,
        })
        .catch((error: unknown) => {
          return error;
        });

      expect([reason instanceof ConnectError, (reason as ConnectError).message]).toEqual([
        true,
        message,
      ]);
      expect([client.isClosed(), client.carries(BEARER)]).toEqual([true, false]);
    }

    expect(heard).toEqual([]);
  });
});

test.describe('WSTransportClient, its message limit', () => {
  test('closes with 1009 a message past an envelope’s limit, 16,778,240 bytes, over `ws` when told no bound', async () => {
    const server = await startServer();
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const client = createWSTransportClient({ WebSocket: TrackedWsWebSocket });
    const connection = nextConnection(server);
    const delivered: number[] = [];

    client.on('message', ({ data }) => {
      delivered.push((data as ArrayBuffer).byteLength);
    });

    try {
      await client.connect({ host, port: portOf(server) });

      const { socket } = await connection;
      const whole = nextEvent(client, 'message');

      socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES));

      const [{ data }] = await whole;

      expect((data as ArrayBuffer).byteLength).toBe(16_778_240);

      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code: number) => {
          resolve(code);
        });
      });

      const clientClosed = nextEvent(client, 'close');

      socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES + 1));

      expect(await closed).toBe(1009);
      await clientClosed;
      expect(delivered).toEqual([16_778_240]);
      expect(client.isClosed()).toBe(true);
    } finally {
      await stopServer(server);
      await allClosed();
    }
  });
});

// a frame as a server writes it, unmasked, whole: its opcode, then its payload, up to 64 KiB
const frameOf = (opcode: number, payload: Uint8Array): Buffer => {
  const head =
    payload.length < 126
      ? [0x80 | opcode, payload.length]
      : [0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff];

  return Buffer.concat([Buffer.from(head), payload]);
};

// a frame of an opcode RFC 6455 reserves, which fails the connection that reads it (§5.2)
const RESERVED_FRAME = frameOf(0x3, Uint8Array.of(0x78));

// a close with 1009, as a server answers one
const CLOSE_1009 = frameOf(0x8, Uint8Array.of(0x03, 0xf1));

// the code of a close a client sent, its payload masked, once it came; none for any other frame
const closeCodeOfMasked = (frame: Buffer): number | undefined => {
  if (((frame[0] ?? 0) & 0x0f) !== 0x8 || frame.length < 8) {
    return undefined;
  }

  return (((frame[6] ?? 0) ^ (frame[2] ?? 0)) << 8) | ((frame[7] ?? 0) ^ (frame[3] ?? 0));
};

// a server that ends its socket, a FIN, once the client's close came, answering no close of its own
const endOnClose = (socket: Socket): void => {
  socket.on('data', (frame: Buffer) => {
    if (closeCodeOfMasked(frame) !== undefined) {
      socket.end();
    }
  });
};

/**
 * An HTTP server that completes each upgrade by hand and hands the test its socket, raw: what goes
 * after its 101 is the test's to write, and so is its end, its socket left half open once the client
 * ended its own, as Node's HTTP server leaves it.
 */
const startRaw = async () => {
  const http = createNodeServer();
  const upgraded = new Set<Socket>();

  // oxlint-disable-next-line bead/options-last -- Node's own, an `upgrade` listener's
  http.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(`${String(request.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    upgraded.add(socket as Socket);
    socket.on('error', () => {});
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });
  http.listen(0, host);
  await once(http, 'listening');

  return {
    // the next socket it upgrades, its 101 written
    next: () => {
      return new Promise<Socket>((resolve) => {
        // oxlint-disable-next-line bead/options-last -- Node's own, an `upgrade` listener's
        http.once('upgrade', (_request, socket) => {
          resolve(socket as Socket);
        });
      });
    },
    port: (http.address() as AddressInfo).port,
    [Symbol.asyncDispose]: async () => {
      for (const socket of upgraded) {
        socket.destroy();
      }

      await new Promise((resolve) => {
        http.close(resolve);
      });
      await allClosed();
    },
  };
};

// what a client tells once open, in order: each error's message, then its close
const toldBy = (client: WSTransportClient): unknown[][] => {
  const told: unknown[][] = [];

  client.on('error', (error) => {
    told.push(['error', error.message]);
  });
  client.on('close', (wasClean, wasQuick) => {
    told.push(['close', wasClean, wasQuick]);
  });

  return told;
};

// spec 15.1
test.describe('WSTransportClient, what its error tells', () => {
  const [[, TrackedGlobal], [, TrackedWs]] = IMPLEMENTATIONS;

  test('tells a server that drops without its closing handshake, by a FIN or a reset, by its unclean close alone, no error', async () => {
    await using raw = await startRaw();
    const drops = [
      (socket: Socket) => {
        socket.end();
      },
      // a linger of 0: its close an abort, a reset sent rather than a FIN (RFC 9293 §3.10.5)
      (socket: Socket) => {
        socket.resetAndDestroy();
      },
    ];

    for (const drop of drops) {
      const client = createWSTransportClient({ WebSocket: TrackedWs });
      const told = toldBy(client);
      const upgraded = raw.next();

      await client.connect({ host, port: raw.port });

      const closed = nextEvent(client, 'close');

      drop(await upgraded);
      await closed;

      expect(told).toEqual([['close', false, false]]);
    }
  });

  test('tells a protocol error on its connection once, then its unclean close', async () => {
    await using raw = await startRaw();
    const client = createWSTransportClient({ WebSocket: TrackedWs });
    const told: unknown[][] = [];
    const upgraded = raw.next();

    client.on('error', (error) => {
      told.push(['error', (error as Error & { code?: string }).code]);
    });
    client.on('close', (wasClean, wasQuick) => {
      told.push(['close', wasClean, wasQuick]);
    });
    await client.connect({ host, port: raw.port });

    const socket = await upgraded;
    const closed = nextEvent(client, 'close');

    // it ends its socket once the client's close came
    endOnClose(socket);
    socket.write(RESERVED_FRAME);
    socket.write(RESERVED_FRAME);
    await closed;

    expect(told).toEqual([
      ['error', 'WS_ERR_INVALID_OPCODE'],
      ['close', false, false],
    ]);
    expect(client.isClosed()).toBe(true);
  });

  test('fails with 1009 a message past its bound, telling one error that names maximumMessageBytes, then an unclean close, even when its server answers its close', async () => {
    await using raw = await startRaw();
    const client = createWSTransportClient({ maxPayload: 1_024, WebSocket: TrackedWs });
    const told = toldBy(client);
    const causes: unknown[] = [];
    const sent: (number | undefined)[] = [];
    const upgraded = raw.next();

    client.on('error', (error) => {
      causes.push((error.cause as { code?: string } | undefined)?.code);
    });
    await client.connect({ host, port: raw.port });

    const socket = await upgraded;
    const closed = nextEvent(client, 'close');

    // its close answered with a 1009 of its own, then its end
    socket.on('data', (frame: Buffer) => {
      const code = closeCodeOfMasked(frame);

      if (code !== undefined) {
        sent.push(code);
        socket.end(CLOSE_1009);
      }
    });
    socket.write(frameOf(0x2, new Uint8Array(4_096)));
    await closed;

    expect(told).toEqual([
      [
        'error',
        'the connection is closed with 1009: a message past its maximumMessageBytes, 1024 bytes',
      ],
      ['close', false, false],
    ]);
    expect([causes, sent]).toEqual([['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'], [1009]]);
  });

  test('fails with 1009 a message past its bound for a server that never answers, telling one error, then an unclean close once its close timeout passed', async () => {
    await using raw = await startRaw();
    const client = createWSTransportClient({
      closeTimeout: 200,
      maxPayload: 1_024,
      WebSocket: TrackedWs,
    });
    const told = toldBy(client);
    const upgraded = raw.next();

    await client.connect({ host, port: raw.port });

    const socket = await upgraded;
    const closed = nextEvent(client, 'close');
    const began = performance.now();

    // it reads its close and answers nothing, its socket held open
    socket.write(frameOf(0x2, new Uint8Array(4_096)));
    await closed;

    expect(performance.now() - began).toBeGreaterThanOrEqual(150);
    expect(told).toEqual([
      [
        'error',
        'the connection is closed with 1009: a message past its maximumMessageBytes, 1024 bytes',
      ],
      ['close', false, false],
    ]);
  });

  test('fails its connection on a protocol error whose error listener throws, telling its close all the same', async () => {
    using uncaught = trapUncaught();
    await using raw = await startRaw();
    const client = createWSTransportClient({ WebSocket: TrackedWs });
    const closes: unknown[][] = [];
    const upgraded = raw.next();

    client.on('error', () => {
      throw new Error('an error listener that throws');
    });
    client.on('close', (wasClean, wasQuick) => {
      closes.push([wasClean, wasQuick]);
    });
    await client.connect({ host, port: raw.port });

    const socket = await upgraded;

    endOnClose(socket);
    socket.write(RESERVED_FRAME);

    await expect
      .poll(() => {
        return closes;
      })
      .toEqual([[false, false]]);
    // what the listener threw was Node's, once
    expect(
      uncaught.thrown.map((error) => {
        return (error as Error).message;
      })
    ).toEqual(['an error listener that throws']);
    expect(client.isClosed()).toBe(true);
  });

  test('tells no error once open over the global WebSocket, its close alone, for a FIN, a reset or a protocol error', async () => {
    await using raw = await startRaw();
    const drops = [
      (socket: Socket) => {
        socket.end();
      },
      (socket: Socket) => {
        socket.resetAndDestroy();
      },
      (socket: Socket) => {
        endOnClose(socket);
        socket.write(RESERVED_FRAME);
      },
    ];

    for (const drop of drops) {
      const client = createWSTransportClient({ WebSocket: TrackedGlobal });
      const told = toldBy(client);
      const upgraded = raw.next();

      await client.connect({ host, port: raw.port });

      const closed = nextEvent(client, 'close');

      drop(await upgraded);
      await closed;

      expect(told).toEqual([['close', false, false]]);
    }
  });
});

// spec 15.3
test.describe('WSTransportClient, its close timeout', () => {
  const [, [, TrackedWs]] = IMPLEMENTATIONS;

  test('hands `maxPayload` and its close timeout to ws, an envelope’s limit and CLOSE_TIMEOUT when not given', async () => {
    const given: unknown[] = [];
    const client = createWSTransportClient({
      // no socket at all, refused as it is made: what the constructor is handed is all it reads
      WebSocket: function (_url: string, _protocols: unknown, options: { closeTimeout?: number }) {
        given.push(options);

        throw new Error('no socket');
      } as unknown as IWebSocketConstructor,
    });

    await client.connect({ host, port: 8_080 }).catch(() => {});

    expect(CLOSE_TIMEOUT).toBe(5_000);
    expect(given).toEqual([
      { closeTimeout: CLOSE_TIMEOUT, maxPayload: MAXIMUM_MESSAGE_BYTES, perMessageDeflate: false },
    ]);
  });

  test('holds its close timeout to a whole number of milliseconds, rounded, refusing zero, and runs on the clock it is given', async () => {
    const clock = createTestClock();

    expect(createWSTransportClient({ clock }).clock).toBe(clock);
    expect(createWSTransportClient().clock).toBe(PLATFORM_CLOCK);

    // a WebSocket's close timeout, its client's way, which the durations' harness plays by its
    // refusal; this loop holds, besides, what `ws` is handed
    const place = DURATIONS.places.find(({ id }) => {
      return id === 'webSocketTransport.closeTimeout';
    });
    const way = place?.ways.find(({ id }) => {
      return id === 'client';
    });

    expect(way).toBeDefined();

    for (const input of DURATIONS.inputs) {
      if (place === undefined || way === undefined || isExcused(place, { input, way })) {
        continue;
      }

      const duration = givenOf(input);
      const given: unknown[] = [];
      const building = (): WSTransportClient => {
        return createWSTransportClient({
          closeTimeout: duration,
          WebSocket: function (
            _url: string,
            _protocols: unknown,
            { closeTimeout }: { closeTimeout?: number }
          ) {
            given.push(closeTimeout);

            throw new Error('no socket');
          } as unknown as IWebSocketConstructor,
        });
      };

      if (outcomeOf(place, input).outcome === 'refused') {
        expect(building, input.name).toThrow(
          new ProgrammerError(refusalOf(place, { given: duration, phrase: 'a close timeout' }))
        );

        continue;
      }

      await building()
        .connect({ host, port: 8_080 })
        .catch(() => {});

      // `ws`'s timer holds what the transport holds, and never as the longest a timer holds
      expect(given, input.name).toEqual([
        duration === Infinity ? 2 ** 31 - 1 : Math.round(duration),
      ]);
    }
  });

  test('drops a server that never answers its disconnect once its close timeout passed, telling no error, its close as the disconnect said', async () => {
    await using raw = await startRaw();
    const client = createWSTransportClient({ closeTimeout: 200, WebSocket: TrackedWs });
    const told = toldBy(client);
    const sent: number[] = [];
    const upgraded = raw.next();

    await client.connect({ host, port: raw.port });

    const socket = await upgraded;

    // it reads its close and answers nothing, its socket held open
    socket.on('data', (frame: Buffer) => {
      const code = closeCodeOfMasked(frame);

      if (code !== undefined) {
        sent.push(code);
      }
    });

    const began = performance.now();

    await client.disconnect();

    expect(performance.now() - began).toBeGreaterThanOrEqual(150);
    expect([told, sent]).toEqual([[['close', true, false]], [1000]]);
    expect(client.isClosed()).toBe(true);
  });

  test('waits on its server without end for a close timeout of Infinity, closing once it answers', async () => {
    await using raw = await startRaw();
    // ! `ws` is handed the longest a timer holds, 2³¹ − 1 ms, which it arms on every close
    const client = createWSTransportClient({ closeTimeout: Infinity, WebSocket: TrackedWs });
    const told = toldBy(client);
    const sent: number[] = [];
    const upgraded = raw.next();

    await client.connect({ host, port: raw.port });

    const socket = await upgraded;

    // it reads its close and answers nothing, for longer than any close timeout of these tests
    socket.on('data', (frame: Buffer) => {
      const code = closeCodeOfMasked(frame);

      if (code !== undefined) {
        sent.push(code);
      }
    });

    let isSettled = false;
    const closing = client.disconnect().then(() => {
      isSettled = true;
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect([sent, isSettled]).toEqual([[1000], false]);

    // its answer, then its end, as a server ends the closing handshake
    socket.end(frameOf(0x8, Uint8Array.of(0x03, 0xe8)));
    await closing;

    expect(told).toEqual([['close', true, false]]);
    expect(client.isClosed()).toBe(true);
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

  test('beats nothing over a socket that cannot ping, a browser’s, nor with a heartbeat of Infinity', async () => {
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

  test('closes when its server leaves its pings unanswered, telling no error', async () => {
    const server = await startServer({ autoPong: false });
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const client = createWSTransportClient({
      heartbeat: 40,
      WebSocket: TrackedWsWebSocket as unknown as IWebSocketConstructor,
    });
    const errors: Error[] = [];

    client.on('error', (error) => {
      errors.push(error);
    });

    try {
      await client.connect({ host, port: portOf(server) });

      expect(await nextEvent(client, 'close')).toEqual([false, false]);
      expect(errors).toEqual([]);
    } finally {
      await stopServer(server);
      await allClosed();
    }
  });
});

// an upgrade refused by the server's transport, marked, and one by a gateway, unmarked
const FORBIDDEN =
  'HTTP/1.1 403 Forbidden\r\nbead-refusal: host-refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n';
const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n';

/**
 * An HTTP server that upgrades as `ws` does until `refusal` is set, then answers each upgrade with
 * it, raw.
 */
const startRefusing = async (refusal?: string) => {
  const http = createNodeServer();
  const upgrading = new WebSocketServer({ noServer: true });
  const state = { refusal };

  // oxlint-disable-next-line bead/options-last -- Node's own, an `upgrade` listener's
  http.on('upgrade', (request, socket, head) => {
    if (state.refusal !== undefined) {
      return (socket.end(state.refusal), undefined);
    }

    return (
      upgrading.handleUpgrade(request, socket, head, (upgraded) => {
        upgrading.emit('connection', upgraded, request);
      }),
      undefined
    );
  });
  http.listen(0, host);
  await once(http, 'listening');

  return {
    port: (http.address() as AddressInfo).port,
    state,
    upgrading,
    [Symbol.asyncDispose]: async () => {
      for (const socket of upgrading.clients) {
        socket.terminate();
      }

      http.closeAllConnections();
      await new Promise((resolve) => {
        http.close(resolve);
      });
      await allClosed();
    },
  };
};

test.describe('WSTransportClient, an upgrade refused', () => {
  const [[, TrackedGlobal], [, TrackedWs]] = IMPLEMENTATIONS;

  test('names the status and the reason of an upgrade refused', async () => {
    for (const [refusal, message] of [
      [FORBIDDEN, 'the server refused the upgrade: 403 host-refused'],
      [BAD_GATEWAY, 'the server refused the upgrade: 502'],
    ] as const) {
      await using refusing = await startRefusing(refusal);
      const client = createWSTransportClient({
        WebSocket: TrackedWs as unknown as IWebSocketConstructor,
      });
      const reason: unknown = await client
        .connect({ host, port: refusing.port })
        .catch((error: unknown) => {
          return error;
        });

      expect(reason).toBeInstanceOf(ConnectError);
      expect((reason as ConnectError).message).toBe(message);
      // `ws`'s own, which ended the socket
      expect((reason as ConnectError).cause).toBeInstanceOf(Error);
      expect(client.isClosed()).toBe(true);
    }
  });

  test('names nothing of an upgrade refused but its close, over the global WebSocket', async () => {
    await using refusing = await startRefusing(FORBIDDEN);
    const client = createWSTransportClient({ WebSocket: TrackedGlobal });

    const reason: unknown = await client
      .connect({ host, port: refusing.port })
      .catch((error: unknown) => {
        return error;
      });

    // its close's code alone, its error's message empty, as the WHATWG WebSockets Standard has it
    expect([reason instanceof ConnectError, (reason as ConnectError).message]).toEqual([
      true,
      '1006',
    ]);
    expect(client.isClosed()).toBe(true);
  });

  test('carries the last failure of a reconnect, an upgrade refused unmarked named by its status, over ws', async () => {
    await using refusing = await startRefusing();
    const client = createWSTransportClient({
      WebSocket: TrackedWs as unknown as IWebSocketConstructor,
    });
    const reconnectOutcome = new Promise<unknown>((resolve) => {
      client.once('close', () => {
        client.reconnect({ delay: 10, maxAttempts: 2 }).then(resolve, resolve);
      });
    });

    await client.connect({ host, port: refusing.port });
    refusing.state.refusal = BAD_GATEWAY;

    for (const socket of refusing.upgrading.clients) {
      socket.terminate();
    }

    const reason = await reconnectOutcome;

    expect(reason).toBeInstanceOf(ReconnectError);
    expect((reason as ReconnectError).cause).toEqual(
      new ConnectError('the server refused the upgrade: 502')
    );
    expect(client.isClosed()).toBe(true);
  });
});

test.describe('WSTransportClient, by a name', () => {
  test('connects by a name to a server that listens on one loopback family alone, whichever it is', async () => {
    for (const address of await reachedByLocalhost()) {
      const server = createWSTransportServer({ WebSocketServer });
      const { port } = await server.start({ address, findOpenPort: true });

      try {
        for (const [label, Tracked] of IMPLEMENTATIONS) {
          const client = createWSTransportClient({
            WebSocket: Tracked as unknown as IWebSocketConstructor,
          });
          const began = performance.now();

          await client.connect({ host: 'localhost', port });

          // the families raced, as RFC 8305 asks: no wait on the one that is refused
          expect([address, label, client.isOpen(), performance.now() - began < 1_500]).toEqual([
            address,
            label,
            true,
            true,
          ]);
          await client.disconnect();
        }
      } finally {
        await server.stop();
        await allClosed();
      }
    }
  });
});
