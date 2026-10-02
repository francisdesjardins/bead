import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import type {
  TRANSPORT_CLIENT_EVENTS,
  TransportClientEventMap,
} from '../../client/transport-client';
import { createWSTransportClient, type WSTransportClient } from '../../client/ws-transport-client';
import * as constants from '../../shared/constants';
import { CancelError, ConnectError } from '../../shared/errors';
import { allClosed, host, IMPLEMENTATIONS, spyIntervals } from '../../shared/__tests__/fixtures';
import {
  ProgrammerError,
  type TRANSPORT_SERVER_EVENTS,
  type TransportServerEventMap,
} from '../transport-server';
import {
  createWSTransportServer,
  HEARTBEAT,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IIncomingMessageLike,
  type IServerSocketLike,
  type WSTransportServer,
} from '../ws-transport-server';
import { createFakeSocket, createFakeWebSocketServer } from './fake-websocket-server';

type ServerEvents = TransportServerEventMap<IServerSocketLike, IIncomingMessageLike>;

const nextServerEvent = <K extends TRANSPORT_SERVER_EVENTS>(
  server: WSTransportServer,
  event: K
) => {
  return new Promise<ServerEvents[K]>((resolve) => {
    server.once(event, (...params) => {
      resolve(params);
    });
  });
};

const nextClientEvent = <K extends TRANSPORT_CLIENT_EVENTS>(
  client: WSTransportClient,
  event: K
) => {
  return new Promise<TransportClientEventMap[K]>((resolve) => {
    client.once(event, (...params) => {
      resolve(params);
    });
  });
};

/** A masked client text frame, as a browser would send it. */
const textFrame = (text: string) => {
  const payload = new TextEncoder().encode(text);
  const mask = randomBytes(4);
  const masked = payload.map((byte, index) => {
    return byte ^ (mask[index % 4] ?? 0);
  });
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
};

const upgradeRequest = () => {
  return (
    `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
};

const openTcp = async (port: number) => {
  const socket = connectTcp(port, host);
  await once(socket, 'connect');
  return socket;
};

test('@francisdesjardins/bead/ws-transport-server re-exports the WebSocket binary type', () => {
  expect(TRANSPORT_WEBSOCKET_BINARYTYPE).toBe(constants.TRANSPORT_WEBSOCKET_BINARYTYPE);
});

for (const [label, Tracked] of IMPLEMENTATIONS) {
  test.describe(`with a client on ${label}`, () => {
    let server: WSTransportServer;
    let port: number;
    let client: WSTransportClient;

    const connectClient = async (target: WSTransportClient) => {
      const connection = nextServerEvent(server, 'connection');
      await target.connect({ host, port });
      return connection;
    };

    test.beforeEach(async () => {
      server = createWSTransportServer({ WebSocketServer });
      ({ port } = await server.start({ address: host, findOpenPort: true }));
      client = createWSTransportClient({ WebSocket: Tracked });
    });

    test.afterEach(async () => {
      if (client.isOpen()) {
        await client.disconnect();
      }
      await server.stop();
      await allClosed();
    });

    test.describe('WSTransportServer #start', () => {
      test('listens on a port the system picked', () => {
        expect(port).toBeGreaterThan(0);
        expect([server.address, server.port]).toEqual([host, port]);
        expect(server.isOpen()).toBe(true);
      });

      test('rejects with EADDRINUSE on a port taken, ending CLOSED, and can start again', async () => {
        const other = createWSTransportServer({ WebSocketServer });

        await expect(other.start({ address: host, port })).rejects.toHaveProperty(
          'code',
          'EADDRINUSE'
        );
        expect(other.isClosed()).toBe(true);

        await other.start({ address: host, findOpenPort: true });
        expect(other.isOpen()).toBe(true);
        await other.stop();
      });

      test('rejects a second start with a ProgrammerError', async () => {
        await expect(server.start()).rejects.toBeInstanceOf(ProgrammerError);
      });
    });

    test.describe('WSTransportServer "connection" event', () => {
      test('meets a connection already registered and wired', async () => {
        const seen = new Promise<{ isRegistered: boolean; connectionHandle: string }>((resolve) => {
          server.once('connection', (...[socket, , connectionHandle]) => {
            const isRegistered =
              socket.readyState === 1 &&
              server.clients.some((connection) => {
                return connection.connectionHandle === connectionHandle;
              });

            void server.send('hi', connectionHandle);
            resolve({ isRegistered, connectionHandle });
          });
        });
        const greeted = nextClientEvent(client, 'message');

        await client.connect({ host, port });
        const { isRegistered, connectionHandle } = await seen;

        expect(isRegistered).toBe(true);
        expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+$/);
        expect(await greeted).toEqual(['hi']);
      });
    });

    test.describe('WSTransportServer "message" event', () => {
      test('delivers text as a string and binary as an ArrayBuffer, stamping the activity', async () => {
        await connectClient(client);
        const [before] = server.clients;
        expect(before?.lastActivityTimestamp).toBeUndefined();

        const text = nextServerEvent(server, 'message');
        await client.send('hello');
        expect(await text).toEqual(['hello', before?.connectionHandle]);

        const binary = nextServerEvent(server, 'message');
        await client.send(new TextEncoder().encode('bytes'));
        const [data] = await binary;
        expect(data).toBeInstanceOf(ArrayBuffer);
        expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('bytes');

        expect(server.clients[0]?.lastActivityTimestamp).toBeDefined();
      });
    });

    test.describe('WSTransportServer "events"', () => {
      test('reads the messages of a connection with "for await"', async () => {
        const controller = new AbortController();
        const received: string[] = [];

        await connectClient(client);
        const reading = (async () => {
          for await (const [data] of server.events('message', { signal: controller.signal })) {
            received.push(typeof data === 'string' ? data : 'binary');
            if (received.length === 3) {
              controller.abort();
            }
          }
        })();

        await client.send('a');
        await client.send('b');
        await client.send('c');
        await reading;

        expect(received).toEqual(['a', 'b', 'c']);
      });
    });

    test.describe('WSTransportServer #send', () => {
      test('reaches the client', async () => {
        await connectClient(client);
        const received = nextClientEvent(client, 'message');

        await server.send('hello', server.clients[0]!.connectionHandle);

        expect(await received).toEqual(['hello']);
      });

      test('resolves for a handle nobody holds', async () => {
        await connectClient(client);
        await expect(server.send('hello', 'type=WS;ip=0.0.0.0;port=1')).resolves.toBeUndefined();
      });
    });

    test.describe('WSTransportServer #close', () => {
      test('closes one connection, which is gone once it resolves', async () => {
        await connectClient(client);
        const connectionHandle = server.clients[0]!.connectionHandle;
        const serverClosed = nextServerEvent(server, 'close');
        const clientClosed = nextClientEvent(client, 'close');

        await expect(server.close(connectionHandle)).resolves.toBe(true);

        expect(server.clients).toHaveLength(0);
        expect(await serverClosed).toEqual([true, connectionHandle]);
        expect(await clientClosed).toEqual([false, false]);
      });

      test('resolves false for a handle nobody holds', async () => {
        await expect(server.close('type=WS;ip=0.0.0.0;port=1')).resolves.toBe(false);
      });

      test('"closeAll" closes every connection', async () => {
        const second = createWSTransportClient({ WebSocket: Tracked });
        const connectionHandles: string[] = [];
        server.on('close', (_, connectionHandle) => {
          connectionHandles.push(connectionHandle);
        });

        await connectClient(client);
        await connectClient(second);

        await expect(server.closeAll()).resolves.toEqual([true, true]);
        expect(connectionHandles).toHaveLength(2);
        expect(server.clients).toHaveLength(0);
      });
    });

    test.describe('WSTransportServer #stop', () => {
      test('closes every connection, each emitting its close, before it resolves, and stops listening', async () => {
        const second = createWSTransportClient({ WebSocket: Tracked });
        const closeEvents: [boolean, string][] = [];
        server.on('close', (clean, connectionHandle) => {
          closeEvents.push([clean, connectionHandle]);
        });

        await connectClient(client);
        await connectClient(second);
        const connectionHandles = server.clients.map((entry) => {
          return entry.connectionHandle;
        });
        const clientClosed = nextClientEvent(client, 'close');
        const secondClosed = nextClientEvent(second, 'close');

        await server.stop();

        expect(closeEvents).toEqual(
          expect.arrayContaining(
            connectionHandles.map((connectionHandle) => {
              return [false, connectionHandle];
            })
          )
        );
        expect(closeEvents).toHaveLength(2);
        expect(await clientClosed).toEqual([false, false]);
        expect(await secondClosed).toEqual([false, false]);
        expect(server.isClosed()).toBe(true);

        const late = createWSTransportClient({ WebSocket: Tracked });
        await expect(late.connect({ host, port })).rejects.toBeInstanceOf(ConnectError);
      });

      test('stops twice, then starts again on a new port', async () => {
        await server.stop();
        await server.stop();

        ({ port } = await server.start({ address: host, findOpenPort: true }));
        await connectClient(client);

        expect(server.clients).toHaveLength(1);
      });
    });
  });
}

test.describe('WSTransportServer, on the wire', () => {
  let server: WSTransportServer;
  let port: number;

  test.beforeEach(async () => {
    server = createWSTransportServer({ WebSocketServer });
    ({ port } = await server.start({ address: host, findOpenPort: true }));
  });

  test.afterEach(async () => {
    await server.stop();
    await allClosed();
  });

  test('emits "error" with the handle, then that connection\'s "close", on a protocol error', async () => {
    const events: unknown[][] = [];
    const closed = nextServerEvent(server, 'close');
    const connection = nextServerEvent(server, 'connection');

    server.on('error', (err, connectionHandle) => {
      events.push(['error', (err as NodeJS.ErrnoException).code, connectionHandle]);
    });
    server.on('close', (clean, connectionHandle) => {
      events.push(['close', clean, connectionHandle]);
    });

    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);
    socket.addEventListener('error', () => {});
    await Promise.all([connection, once(socket, 'open')]);
    const connectionHandle = server.clients[0]?.connectionHandle;

    // a text frame that is not UTF-8
    socket.send(new Uint8Array([0xff, 0xfe]), { binary: false });
    await closed;

    expect(events).toEqual([
      ['error', 'WS_ERR_INVALID_UTF8', connectionHandle],
      ['close', false, connectionHandle],
    ]);
  });

  test('emits "connection" before a frame that arrived with the upgrade request', async () => {
    const events: string[] = [];
    const message = nextServerEvent(server, 'message');
    server.on('connection', () => {
      events.push('connection');
    });
    server.on('message', (data) => {
      events.push(`message:${typeof data === 'string' ? data : 'binary'}`);
    });

    const socket = await openTcp(port);
    socket.write(Buffer.concat([Buffer.from(upgradeRequest()), textFrame('early')]));
    await message;
    socket.destroy();

    expect(events).toEqual(['connection', 'message:early']);
  });

  test('stops without waiting on a peer that never finished its HTTP request', async () => {
    const socket = await openTcp(port);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    // long enough for the server to start parsing it, which is what makes the connection busy
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    const started = Date.now();
    await server.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(server.isClosed()).toBe(true);
    socket.destroy();
  });

  test('delivers binary as a Buffer with binaryType "nodebuffer", and text still as a string', async () => {
    await server.stop();
    server = createWSTransportServer({ WebSocketServer, binaryType: 'nodebuffer' });
    ({ port } = await server.start({ address: host, findOpenPort: true }));

    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);
    await once(socket, 'open');

    const binary = nextServerEvent(server, 'message');
    socket.send(Buffer.from('bytes'));
    const [data] = await binary;
    expect(Buffer.isBuffer(data)).toBe(true);

    const text = nextServerEvent(server, 'message');
    socket.send('text');
    expect((await text)[0]).toBe('text');

    socket.close();
  });
});

test.describe('WSTransportServer, with a scripted WebSocketServer', () => {
  test('hands `maxPayload` to the WebSocketServer when given, and nothing of it otherwise', async () => {
    for (const maxPayload of [256, undefined]) {
      const fake = createFakeWebSocketServer();
      const server = createWSTransportServer({
        maxPayload,
        WebSocketServer: fake.FakeWebSocketServer,
      });

      const starting = server.start({ port: 4_321 });
      fake.instances[0]?.emit('listening');
      await starting;

      expect(fake.instances[0]?.options).toEqual(
        maxPayload === undefined
          ? { host: '0.0.0.0', port: 4_321 }
          : { host: '0.0.0.0', maxPayload, port: 4_321 }
      );
      expect(Object.hasOwn(fake.instances[0]?.options ?? {}, 'maxPayload')).toBe(
        maxPayload !== undefined
      );
      await server.stop();
    }
  });

  test('reports the port it was asked for when the server reports no port of its own', async () => {
    for (const address of ['/run/bead.sock', null]) {
      const fake = createFakeWebSocketServer({ address });
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

      const starting = server.start({ port: 4_321 });
      fake.instances[0]?.emit('listening');

      expect(await starting).toEqual({ address: '0.0.0.0', port: 4_321 });
      expect(server.port).toBe(4_321);
      await server.stop();
    }
  });

  test("an error after listening is the server's own, with an empty handle, and it stays open", async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start();
    fake.instances[0]?.emit('listening');
    await starting;

    const error = nextServerEvent(server, 'error');
    const failure = new Error('late');
    fake.instances[0]?.emit('error', failure);

    expect(await error).toEqual([failure, '']);
    expect(server.isOpen()).toBe(true);
    await server.stop();
  });

  test('an abort before listening rejects the start with a CancelError and closes what was opened', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const controller = new AbortController();

    const starting = server.start({ signal: controller.signal });
    controller.abort('why');

    await expect(starting).rejects.toBeInstanceOf(CancelError);
    await expect(starting).rejects.toHaveProperty('cause', 'why');
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);
  });

  test('an error before listening rejects the start and closes what was opened', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start();
    const failure = new Error('refused');
    fake.instances[0]?.emit('error', failure);

    await expect(starting).rejects.toBe(failure);
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);
  });

  test('leaves the connection a newer socket took the handle of alone when the older one closes', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const closes: unknown[] = [];
    const starting = server.start();

    fake.instances[0]?.emit('listening');
    await starting;
    server.on('close', (...params) => {
      closes.push(params);
    });

    const older = createFakeSocket();
    const newer = createFakeSocket();
    // the same port given again: the same handle
    const connectionHandle = fake.connect(older);

    fake.connect(newer);
    older.terminate();

    expect([closes, server.gauges().counts]).toEqual([[], { connections: 1 }]);

    newer.terminate();

    expect([closes, server.gauges().counts]).toEqual([
      [[false, connectionHandle]],
      { connections: 0 },
    ]);
    await server.stop();
  });

  test('takes no connection whose socket is gone already, and ends it', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const connections: unknown[] = [];
    const starting = server.start();

    fake.instances[0]?.emit('listening');
    await starting;
    server.on('connection', (...params) => {
      connections.push(params);
    });

    const first = createFakeSocket();
    const second = createFakeSocket();
    const live = createFakeSocket();
    const handle = fake.connect(live);

    fake.connectGone(first);
    fake.connectGone(second);
    await Promise.resolve();

    expect(first.wasTerminated).toBe(true);
    expect(second.wasTerminated).toBe(true);
    expect(
      server.clients.map(({ connectionHandle }) => {
        return connectionHandle;
      })
    ).toEqual([handle]);
    expect(connections).toHaveLength(1);

    await server.stop();
  });

  test('drops a connection that never answers its close once closeTimeout has passed', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({
      closeTimeout: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start();
    fake.instances[0]?.emit('listening');
    await starting;

    const silent = createFakeSocket({ onClose: 'ignore' });
    fake.connect(silent);

    const started = Date.now();
    await server.stop();

    expect(silent.closeCodes).toEqual([1001]);
    expect(silent.wasTerminated).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('drops a connection whose close throws, and still resolves "close" to true', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start();
    fake.instances[0]?.emit('listening');
    await starting;

    const stubborn = createFakeSocket({ onClose: 'throw' });
    const connectionHandle = fake.connect(stubborn);

    await expect(server.close(connectionHandle)).resolves.toBe(true);
    expect(stubborn.wasTerminated).toBe(true);
    expect(server.clients).toHaveLength(0);
    await server.stop();
  });
});

test.describe('WSTransportServer, heartbeat', () => {
  test('pings each connection every heartbeat, and drops one that left a ping unanswered, or could not be sent one', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({
      heartbeat: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const answering = createFakeSocket({ onPing: 'answer' });
    const silent = createFakeSocket();
    const closing = createFakeSocket();
    const closes: [wasClean: boolean, connectionHandle: string][] = [];

    const starting = server.start({ port: 4_321 });
    fake.instances[0]?.emit('listening');
    await starting;
    server.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });

    fake.connect(answering, 40_001);

    const silentHandle = fake.connect(silent, 40_002);
    const closingHandle = fake.connect(closing, 40_003);

    // a socket in its close handshake is sent no ping, and is dropped all the same
    (closing as { readyState: number }).readyState = 2;

    await expect
      .poll(() => {
        return [silent.wasTerminated, closing.wasTerminated];
      })
      .toEqual([true, true]);

    expect([silent.pings, closing.pings]).toEqual([1, 0]);
    expect(closes).toHaveLength(2);
    expect(closes).toEqual(
      expect.arrayContaining([
        [false, silentHandle],
        [false, closingHandle],
      ])
    );

    await expect
      .poll(() => {
        return answering.pings;
      })
      .toBeGreaterThan(2);

    expect(answering.wasTerminated).toBe(false);

    await server.stop();

    // closed, it beats no more
    const pings = answering.pings;

    await sleep(60);

    expect(answering.pings).toBe(pings);
  });

  test('beats every HEARTBEAT when told nothing', async () => {
    using timers = spyIntervals();
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start({ port: 4_321 });
    fake.instances[0]?.emit('listening');
    await starting;
    fake.connect(createFakeSocket());

    expect(
      timers.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([HEARTBEAT]);

    await server.stop();
  });

  test('beats nothing with a heartbeat of Infinity, and refuses one no timer holds', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({
      heartbeat: Infinity,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const socket = createFakeSocket();

    const starting = server.start({ port: 4_321 });
    fake.instances[0]?.emit('listening');
    await starting;
    fake.connect(socket);
    await sleep(60);

    expect([socket.pings, socket.wasTerminated]).toEqual([0, false]);

    await server.stop();

    for (const heartbeat of [0, 1.5, 2 ** 31]) {
      expect(() => {
        return createWSTransportServer({ heartbeat, WebSocketServer: fake.FakeWebSocketServer });
      }, String(heartbeat)).toThrow(ProgrammerError);
    }
  });

  test('keeps the clients that answer its pings — a browser’s as `ws`’s — and drops one that does not, on the wire', async () => {
    const server = createWSTransportServer({ heartbeat: 40, WebSocketServer });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const closes: boolean[] = [];

    try {
      server.on('close', (wasClean) => {
        closes.push(wasClean);
      });

      const url = `ws://${host}:${String(port)}`;
      const [[, GlobalWebSocket], [, TrackedWsWebSocket]] = IMPLEMENTATIONS;
      const opened = [
        new GlobalWebSocket(url),
        new TrackedWsWebSocket(url),
        new TrackedWsWebSocket(url, { autoPong: false }),
      ];

      for (const socket of opened) {
        socket.addEventListener('error', () => {});
      }

      await expect
        .poll(() => {
          return closes;
        })
        .toEqual([false]);
      // several beats more, and the two that answer are still there
      await sleep(200);

      expect(closes).toEqual([false]);
      expect(server.clients).toHaveLength(2);
    } finally {
      await server.stop();
      await allClosed();
    }
  });
});
