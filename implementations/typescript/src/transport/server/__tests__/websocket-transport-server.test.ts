import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'node:http';
import { connect as connectTcp, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  type ServerOptions,
  WebSocket as WsClient,
  type WebSocket as WsWebSocket,
  WebSocketServer,
} from 'ws';
import type {
  TRANSPORT_CLIENT_EVENTS,
  TransportClientEventMap,
} from '../../client/transport-client';
import {
  createWebSocketTransportClient,
  type WebSocketTransportClient,
} from '../../client/websocket-transport-client';
import * as constants from '../../shared/constants';
import { LONGEST_TIMER, PLATFORM, PLATFORM_CLOCK } from '../../shared/clock';
import { CancelError, ConnectError } from '../../shared/errors';
import {
  allClosed,
  createTestClock,
  duesOn,
  host,
  IMPLEMENTATIONS,
  trapUncaught,
} from '../../shared/__tests__/fixtures';
import {
  ProgrammerError,
  type ITransportServerRefusal,
  type TRANSPORT_SERVER_EVENTS,
  type TransportServerConnectionHandle,
  type TransportServerEventMap,
} from '../transport-server';
import {
  CLOSE_TIMEOUT,
  createWebSocketTransportServer,
  HEARTBEAT,
  MAXIMUM_MESSAGE_BYTES,
  MAXIMUM_MESSAGE_FRAMES,
  START_DEFAULTS,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IDrawingRequest,
  type IServerSocketLike,
  type IWebSocketTransportServerOptions,
  type WebSocketTransportServer,
} from '../websocket-transport-server';
import {
  bindError,
  hasIPv6Loopback,
  holdIPv6Loopback,
  isFreeOn,
  LISTENING_ADDRESSES,
  LISTENING_NAMES,
  NO_LISTENING_ADDRESSES,
} from './addresses';
import {
  createFakeSocket,
  createFakeWebSocketServer,
  createRefusingWebSocketServer,
  type IFakeSocket,
} from './fake-websocket-server';
import { frameOf, OPCODES, openExchange } from './http-peer';
import { closingAnswerOf } from './http-transport-server-fixtures';

type ServerEvents = TransportServerEventMap<IServerSocketLike, IDrawingRequest>;

const nextServerEvent = <K extends TRANSPORT_SERVER_EVENTS>(
  server: WebSocketTransportServer,
  event: K
) => {
  return new Promise<ServerEvents[K]>((resolve) => {
    server.once(event, (...params) => {
      resolve(params);
    });
  });
};

const nextClientEvent = <K extends TRANSPORT_CLIENT_EVENTS>(
  client: WebSocketTransportClient,
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

// a frame of its own first byte, FIN and opcode, a client sends, masked as every client's is
// (RFC 6455 §5.2, §5.3), its payload under 126 bytes
const maskedFrameOf = (head: number, payload: Uint8Array) => {
  const mask = randomBytes(4);
  const masked = payload.map((byte, index) => {
    return byte ^ (mask[index % 4] ?? 0);
  });

  return Buffer.concat([Buffer.from([head, 0x80 | payload.length]), mask, masked]);
};

// a frame of `opcode` a client sends, whole, its FIN set
const maskedFrame = (opcode: number, payload: Uint8Array) => {
  return maskedFrameOf(0x80 | opcode, payload);
};

// the frames a server sent after its 101, unmasked, as a server's are: each its first byte, then
// its payload, each under 126 bytes
const framesOf = (received: Buffer): [number, number[]][] => {
  const frames: [number, number[]][] = [];
  let rest = received.subarray(received.indexOf('\r\n\r\n') + 4);

  while (rest.length >= 2 && rest.length >= 2 + ((rest[1] ?? 0) & 0x7f)) {
    const length = (rest[1] ?? 0) & 0x7f;

    frames.push([rest[0] ?? 0, [...rest.subarray(2, 2 + length)]]);
    rest = rest.subarray(2 + length);
  }

  return frames;
};

// the code of the close a server sent right after its 101, once it came: its frame unmasked, as a
// server's is
const closeCodeOf = (received: Buffer): number | undefined => {
  const frame = received.subarray(received.indexOf('\r\n\r\n') + 4);

  return frame[0] === 0x88 && frame.length >= 4 ? frame.readUInt16BE(2) : undefined;
};

const encoder = new TextEncoder();

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

/** An opening handshake naming `authority`, with `fields` besides, of version 13 unless they say. */
const handshakeOf = (authority: string, fields: Record<string, string> = {}) => {
  const lines = Object.entries({ 'sec-websocket-version': '13', ...fields }).map(
    ([name, value]) => {
      return `${name}: ${value}\r\n`;
    }
  );

  return (
    `GET / HTTP/1.1\r\nHost: ${authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n${lines.join('')}\r\n`
  );
};

/**
 * What the server answers `head` on a socket of its own: all of it once the server closed the
 * socket, or the head of a 101 once it came; the socket is closed then.
 */
const answerOf = async (port: number, head: string) => {
  const socket = await openTcp(port);
  const answer = { isClosed: false, text: '' };

  socket.on('data', (chunk: Buffer) => {
    answer.text += chunk.toString('latin1');
  });
  socket.on('close', () => {
    answer.isClosed = true;
  });
  socket.write(head);
  await expect
    .poll(() => {
      return (
        answer.isClosed ||
        (answer.text.startsWith('HTTP/1.1 101') && answer.text.includes('\r\n\r\n'))
      );
    })
    .toBe(true);
  socket.destroy();

  return answer;
};

// the rank a handle names
const ordinalOf = (connectionHandle: string): number => {
  return Number(/;ordinal=(?<ordinal>\d+)$/u.exec(connectionHandle)?.groups?.['ordinal']);
};

// what a server's transport hands beside each envelope of a client on the loopback: its
// connection's address and port (spec 15.1)
const FROM = { address: host, port: expect.any(Number) as unknown };

// where a scripted server's HTTP server listens: for real, on a port the system picked
const SCRIPTED = { address: host, findOpenPort: true };

test('settles a send after its connection ends without writing or holding bytes', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    heartbeat: Infinity,
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const starting = server.start(SCRIPTED);
  fake.instances[0]?.emit('listening');
  await starting;
  const socket = createFakeSocket();
  const handle = fake.connect(socket, { server });
  (socket as { readyState: number }).readyState = 3;
  socket.hear('close', 1006);

  await server.send({ data: Uint8Array.of(1, 2, 3) }, handle);
  await server.close(handle);
  expect(socket.sent).toEqual([]);
  expect(socket.wasTerminated).toBe(false);
  expect(server.gauges().counts['unsentBytes']).toBe(0);
});

test('ends a read without delivering data once the socket is closed or closing', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    heartbeat: Infinity,
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const starting = server.start(SCRIPTED);
  fake.instances[0]?.emit('listening');
  await starting;
  const socket = createFakeSocket({ onClose: 'ignore' });
  const handle = fake.connect(socket, { server });
  const messages: unknown[] = [];
  server.on('message', (message) => {
    messages.push(message);
  });
  const closing = server.close(handle);
  (socket as { readyState: number }).readyState = 2;
  socket.hear('message', Uint8Array.of(1, 2), true);
  (socket as { readyState: number }).readyState = 3;
  socket.hear('close', 1000);
  await closing;
  await server.send({ data: Uint8Array.of(3) }, handle);

  expect(messages).toEqual([]);
  expect(socket.closeCodes).toEqual([1000]);
  expect(socket.sent).toEqual([]);
  expect(socket.wasTerminated).toBe(false);
  expect(server.gauges().counts['unsentBytes']).toBe(0);
});

test('settles a send after its queue bound drops the socket without aborting twice', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    heartbeat: Infinity,
    maximumUnsentBytes: 65_536,
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const starting = server.start(SCRIPTED);
  fake.instances[0]?.emit('listening');
  await starting;
  const socket = createFakeSocket();
  const terminate = socket.terminate.bind(socket);
  let drops = 0;
  socket.terminate = () => {
    drops += 1;
    terminate();
  };
  const handle = fake.connect(socket, { server });
  const errors: string[] = [];
  server.on('error', (error) => {
    errors.push(error.message);
  });

  await server.send({ data: new Uint8Array(65_537) }, handle);
  await server.send({ data: Uint8Array.of(1) }, handle);

  expect(drops).toBe(1);
  expect(socket.sent).toEqual([]);
  expect(server.gauges().counts['unsentBytes']).toBe(0);
  expect(errors).toEqual([
    `${handle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
  ]);
});

// the key of RFC 6455 §1.3's handshake
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

// the date the test clock gives every refusal
const DATED = Date.parse('2026-01-01T00:00:00Z');

// an opening handshake's fields, from a host the servers below take
const HANDSHAKE_FIELDS = [
  'Host: bead.test',
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Key: ${KEY}`,
  'Sec-WebSocket-Version: 13',
];

// what removes every field that asks an upgrade
const NO_UPGRADE = ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version'];

/**
 * A request of `line` whose fields are an opening handshake's, changed by `changes`: a name alone
 * removes its field, `Name: value` takes its place, and a name given twice gives two lines.
 */
const requestOf = (line: string, changes: readonly string[] = []) => {
  const nameOf = (field: string) => {
    return (field.split(':')[0] ?? '').trim().toLowerCase();
  };
  const changed = new Set(changes.map(nameOf));
  const fields = [
    ...HANDSHAKE_FIELDS.filter((field) => {
      return !changed.has(nameOf(field));
    }),
    ...changes.filter((change) => {
      return change.includes(':');
    }),
  ];

  return `${line}\r\n${fields
    .map((field) => {
      return `${field}\r\n`;
    })
    .join('')}\r\n`;
};

/** A refusal of the transport's own, whole, the test clock's date in it, its socket closed. */
const refusedWith = (
  status: string,
  { fields = [], refusal }: { fields?: readonly string[]; refusal: string }
) => {
  const connection = fields.some((field) => {
    return field.startsWith('upgrade:');
  })
    ? 'upgrade, close'
    : 'close';

  return {
    isClosed: true,
    text:
      `HTTP/1.1 ${status}\r\ndate: Thu, 01 Jan 2026 00:00:00 GMT\r\nbead-refusal: ${refusal}\r\n` +
      'cache-control: no-store\r\nx-content-type-options: nosniff\r\n' +
      fields
        .map((field) => {
          return `${field}\r\n`;
        })
        .join('') +
      `content-length: 0\r\nconnection: ${connection}\r\n\r\n`,
  };
};

/** A server of `options` on the test clock, on a port the system picked, stopped as it goes. */
const startDated = async (
  options: Omit<Partial<IWebSocketTransportServerOptions>, 'WebSocketServer'>
) => {
  const server = createWebSocketTransportServer({
    clock: createTestClock(DATED),
    ...options,
    WebSocketServer,
  });
  const { port } = await server.start({ address: host, findOpenPort: true });

  return {
    port,
    server,
    [Symbol.asyncDispose]: async () => {
      await server.stop();
      await allClosed();
    },
  };
};

/** Whether each of `requests` is answered `answer`, on a socket of its own. */
const expectAnswered = async (
  port: number,
  { answer, requests }: { answer: { isClosed: boolean; text: string }; requests: string[] }
) => {
  for (const request of requests) {
    expect(await answerOf(port, request), request).toEqual(answer);
  }
};

/** The status line of what the server answers `request`: a 101's when it upgrades. */
const statusLineOf = async (port: number, request: string) => {
  return (await answerOf(port, request)).text.split('\r\n')[0];
};

test('@francisdesjardins/bead/websocket-transport-server re-exports the WebSocket binary type', () => {
  expect(TRANSPORT_WEBSOCKET_BINARYTYPE).toBe(constants.TRANSPORT_WEBSOCKET_BINARYTYPE);
});

// spec 9.11
test('a WebSocket server transport takes the procedures it is given', async () => {
  const server = createWebSocketTransportServer({
    procedures: [{ procedureId: 1, serviceId: 2 }],
    WebSocketServer,
  });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const connection = nextServerEvent(server, 'connection');
  const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
  const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

  try {
    socket.addEventListener('error', () => {});
    await once(socket, 'open');

    const [, connectionHandle] = await connection;

    expect([
      server.takesProcedure?.(connectionHandle, { procedureId: 1, serviceId: 2 }),
      server.takesProcedure?.(connectionHandle, { procedureId: 2, serviceId: 2 }),
      server.takesProcedure?.(connectionHandle, { procedureId: 1, serviceId: 3 }),
    ]).toEqual([true, false, false]);
    // given none, it names none: its router never asks
    expect(createWebSocketTransportServer({ WebSocketServer }).takesProcedure).toBeUndefined();
  } finally {
    socket.close();
    await server.stop();
    await allClosed();
  }
});

test('refuses a second start while the first is still starting', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const first = server.start(SCRIPTED);

  await expect(server.start(SCRIPTED)).rejects.toThrow(
    new ProgrammerError('the transport server is already connecting')
  );
  expect(fake.instances).toHaveLength(1);
  fake.instances[0]?.emit('listening');
  await first;
  expect(server.isOpen()).toBe(true);
});

test('names a connection to its listeners by its handle and nothing of its credential', async () => {
  await using started = await startDated({});
  await using client = createWebSocketTransportClient({ WebSocket: WsClient });
  const connection = nextServerEvent(started.server, 'connection');

  await client.connect({ host, port: started.port, credential: 'Bearer secret' });
  const [, handle] = await connection;

  expect(handle).not.toContain('secret');
  expect(JSON.stringify(started.server.clients)).not.toContain('secret');
});

test('refuses a stop while starting and stops once started', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const starting = server.start(SCRIPTED);

  await expect(server.stop()).rejects.toThrow(
    new ProgrammerError('the transport server is starting')
  );
  fake.instances[0]?.emit('listening');
  await starting;
  await server.stop();
  expect(server.isClosed()).toBe(true);
});

test('a stop reentered from a close listener shares the stop in progress', async () => {
  const fake = createFakeWebSocketServer();
  await using server = createWebSocketTransportServer({
    WebSocketServer: fake.FakeWebSocketServer,
  });
  const starting = server.start(SCRIPTED);

  fake.instances[0]?.emit('listening');
  await starting;
  fake.connect(createFakeSocket(), { server });
  const reentered: Promise<void>[] = [];

  server.on('close', () => {
    reentered.push(server.stop());
  });
  await server.stop();
  expect(reentered).toHaveLength(1);
  await Promise.all(reentered);
  expect(server.isClosed()).toBe(true);
  expect(server.clients).toEqual([]);
});

test('refuses a close timeout past the longest timer and runs on the clock it is given', () => {
  expect(() => {
    createWebSocketTransportServer({ WebSocketServer, closeTimeout: LONGEST_TIMER + 1 });
  }).toThrow(/a close timeout/u);
  const clock = createTestClock();
  const server = createWebSocketTransportServer({ WebSocketServer, clock });

  expect(server.clock).toBe(clock);
  expect(createWebSocketTransportServer({ WebSocketServer }).clock).toBe(PLATFORM_CLOCK);
});

for (const [label, Tracked] of IMPLEMENTATIONS) {
  test.describe(`with a client on ${label}`, () => {
    let server: WebSocketTransportServer;
    let port: number;
    let client: WebSocketTransportClient;

    const connectClient = async (target: WebSocketTransportClient) => {
      const connection = nextServerEvent(server, 'connection');
      await target.connect({ host, port });
      return connection;
    };

    test.beforeEach(async () => {
      server = createWebSocketTransportServer({ WebSocketServer });
      expect(server.isUninitialized()).toBe(true);
      await server.stop();
      expect(server.isUninitialized()).toBe(true);
      ({ port } = await server.start({ address: host, findOpenPort: true }));
      client = createWebSocketTransportClient({ WebSocket: Tracked });
    });

    test.afterEach(async () => {
      if (client.isOpen()) {
        await client.disconnect();
      }
      await server.stop();
      await allClosed();
    });

    test.describe('WebSocketTransportServer #start', () => {
      test('starts uninitialized and is open once listening on a port the system picked', () => {
        expect(port).toBeGreaterThan(0);
        expect([server.address, server.port]).toEqual([host, port]);
        expect(server.isOpen()).toBe(true);
      });

      test('throws on a port taken, ending closed, and starts again on a free one and after a stop', async () => {
        const other = createWebSocketTransportServer({ WebSocketServer });

        await expect(other.start({ address: host, port })).rejects.toHaveProperty(
          'code',
          'EADDRINUSE'
        );
        expect(other.isClosed()).toBe(true);

        const free = await other.start({ address: host, findOpenPort: true });

        expect(free.port).not.toBe(port);
        expect(other.isOpen()).toBe(true);

        await other.stop();
        await other.start({ address: host, findOpenPort: true });

        expect(other.isOpen()).toBe(true);
        await other.stop();
      });

      test('refuses a second start and keeps serving', async () => {
        const refused = server.start();

        await expect(refused).rejects.toBeInstanceOf(ProgrammerError);
        await expect(refused).rejects.toHaveProperty(
          'message',
          'the transport server is already open'
        );
        expect(server.isOpen()).toBe(true);

        const [, connectionHandle] = await connectClient(client);
        const heard = nextServerEvent(server, 'message');

        await client.send({ data: Uint8Array.of(1) });

        expect((await heard)[1]).toBe(connectionHandle);
      });
    });

    test.describe('WebSocketTransportServer "connection" event', () => {
      test('meets a connection already registered and can send to it', async () => {
        const seen = new Promise<{ isRegistered: boolean; connectionHandle: string }>((resolve) => {
          server.once('connection', (...[{ socket }, connectionHandle]) => {
            const isRegistered =
              socket.readyState === 1 &&
              server.clients.some((connection) => {
                return connection.connectionHandle === connectionHandle;
              });

            void server.send({ data: 'hi' }, connectionHandle);
            resolve({ isRegistered, connectionHandle });
          });
        });
        const greeted = nextClientEvent(client, 'message');

        await client.connect({ host, port });
        const { isRegistered, connectionHandle } = await seen;

        expect(isRegistered).toBe(true);
        expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=\d+$/u);
        expect(await greeted).toEqual([{ credential: undefined, data: 'hi' }]);
      });

      test('keeps a connection whose connection listener throws, its messages heard, the throw reported with it', async () => {
        const thrown = new Error('a connection listener that throws');
        const reported = nextServerEvent(server, 'error');
        const closes: unknown[] = [];

        server.on('close', (...args) => {
          closes.push(args);
        });

        server.once('connection', () => {
          throw thrown;
        });

        // the listener after it, told all the same
        const [, connectionHandle] = await connectClient(client);

        const toldError = await reported;

        expect(toldError).toEqual([thrown, connectionHandle]);
        expect(toldError[0]).toBe(thrown);

        const heard = nextServerEvent(server, 'message');

        await client.send({ data: 'still here' });

        expect(await heard).toEqual([
          { ...FROM, credential: undefined, data: 'still here' },
          connectionHandle,
        ]);
        const binary = nextServerEvent(server, 'message');

        await client.send({ data: Uint8Array.of(1) });

        const binaryMessage = await binary;

        expect(binaryMessage).toEqual([
          { ...FROM, credential: undefined, data: expect.any(ArrayBuffer) },
          connectionHandle,
        ]);
        expect([...new Uint8Array(binaryMessage[0].data as ArrayBuffer)]).toEqual([1]);
        expect(server.clients).toHaveLength(1);
        expect(server.gauges().connectionHandles).toEqual(new Set([connectionHandle]));
        expect(closes).toEqual([]);
        expect(client.isOpen()).toBe(true);
      });
    });

    test.describe('WebSocketTransportServer "message" event', () => {
      test('delivers text as text and binary as bytes, stamping the activity', async () => {
        // a server of its own, on the test clock, whose stamps are its readings
        const clock = createTestClock(DATED);
        const dated = createWebSocketTransportServer({ clock, WebSocketServer });
        const { port: datedPort } = await dated.start({ address: host, findOpenPort: true });

        try {
          const connection = nextServerEvent(dated, 'connection');

          await client.connect({ host, port: datedPort });

          const [, connectionHandle] = await connection;

          expect(dated.clients[0]?.lastActivity).toBeUndefined();

          clock.tick(1_000);

          const text = nextServerEvent(dated, 'message');

          await client.send({ data: 'hello' });

          expect(await text).toEqual([
            { ...FROM, credential: undefined, data: 'hello' },
            connectionHandle,
          ]);
          expect(dated.clients[0]?.lastActivity).toBe(DATED + 1_000);

          // each message stamps it again
          clock.tick(1_000);

          const binary = nextServerEvent(dated, 'message');

          await client.send({ data: new TextEncoder().encode('bytes') });

          const [{ data }] = await binary;

          expect(data).toBeInstanceOf(ArrayBuffer);
          expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('bytes');
          expect(dated.clients[0]?.lastActivity).toBe(DATED + 2_000);
        } finally {
          await client.disconnect();
          await dated.stop();
        }
      });

      test('hears the next message after a message listener throws, the throw reported with its connection', async () => {
        const [, connectionHandle] = await connectClient(client);
        const thrown = new Error('a message listener that throws');
        const errors: unknown[][] = [];
        const closes: unknown[] = [];

        server.once('message', () => {
          throw thrown;
        });
        server.on('error', (...args) => {
          errors.push(args);
        });
        server.on('close', (...args) => {
          closes.push(args);
        });

        for (const data of ['first', Uint8Array.of(1), 'second', Uint8Array.of(2)]) {
          const heard = nextServerEvent(server, 'message');

          await client.send({ data });

          const message = await heard;

          expect(message).toEqual([
            {
              ...FROM,
              credential: undefined,
              data: typeof data === 'string' ? data : expect.any(ArrayBuffer),
            },
            connectionHandle,
          ]);
          if (typeof data !== 'string') {
            expect([...new Uint8Array(message[0].data as ArrayBuffer)]).toEqual([...data]);
          }
        }

        expect(errors).toEqual([[thrown, connectionHandle]]);
        expect(errors[0]?.[0]).toBe(thrown);
        expect(server.clients).toHaveLength(1);
        expect(server.gauges().connectionHandles).toEqual(new Set([connectionHandle]));
        expect(closes).toEqual([]);
        expect(client.isOpen()).toBe(true);
      });
    });

    test.describe('WebSocketTransportServer "events"', () => {
      test('reads the messages of a connection with "for await"', async () => {
        const controller = new AbortController();
        const received: string[] = [];

        await connectClient(client);
        const reading = (async () => {
          for await (const [{ data }] of server.events('message', { signal: controller.signal })) {
            received.push(typeof data === 'string' ? data : 'binary');
            if (received.length === 3) {
              controller.abort();
            }
          }
        })();

        await client.send({ data: 'a' });
        await client.send({ data: 'b' });
        await client.send({ data: 'c' });
        await reading;

        expect(received).toEqual(['a', 'b', 'c']);
      });
    });

    test.describe('WebSocketTransportServer #send', () => {
      test('sends to a connection in order, one message at a time', async () => {
        const [, connectionHandle] = await connectClient(client);
        const received: unknown[] = [];
        const all = new Promise<void>((resolve) => {
          client.on('message', ({ credential, data }) => {
            received.push([credential, [...new Uint8Array(data as ArrayBuffer)]]);

            if (received.length === 20) {
              resolve();
            }
          });
        });

        await Promise.all(
          Array.from({ length: 20 }, (_, index) => {
            return server.send({ data: Uint8Array.of(index + 1) }, connectionHandle);
          })
        );
        await all;

        expect(received).toEqual(
          Array.from({ length: 20 }, (_, index) => {
            return [undefined, [index + 1]];
          })
        );
      });

      test('resolves a send for a handle nobody holds', async () => {
        await connectClient(client);
        await expect(
          server.send({ data: 'hello' }, 'type=WS;ip=0.0.0.0;port=1;ordinal=1')
        ).resolves.toBeUndefined();
      });
    });

    test.describe('WebSocketTransportServer #close', () => {
      test('closes one connection, which is gone once it resolves', async () => {
        const [{ socket }] = await connectClient(client);
        const connectionHandle = server.clients[0]!.connectionHandle;
        const serverClosed = nextServerEvent(server, 'close');
        const clientClosed = nextClientEvent(client, 'close');
        const emitted: [boolean, string][] = [];
        const codes: number[] = [];
        server.on('close', (clean, handle) => {
          emitted.push([clean, handle]);
        });
        socket.on('close', (code) => {
          codes.push(code);
        });

        await expect(server.close(connectionHandle)).resolves.toBe(true);

        expect(emitted).toEqual([[true, connectionHandle]]);
        expect(server.clients).toHaveLength(0);
        expect(await serverClosed).toEqual([true, connectionHandle]);
        expect(await clientClosed).toEqual([false, false]);
        // its 1000, answered by its peer
        expect(codes).toEqual([1000]);
      });

      test('resolves false closing a handle nobody holds', async () => {
        const closes: unknown[] = [];

        server.on('close', (...args) => {
          closes.push(args);
        });

        await expect(server.close('type=WS;ip=0.0.0.0;port=1;ordinal=1')).resolves.toBe(false);
        expect(closes).toEqual([]);
      });
    });

    test.describe('WebSocketTransportServer #stop', () => {
      test('"await using" stops it, closing with 1001 and refusing what comes after', async () => {
        const [{ socket }] = await connectClient(client);
        const clientClosed = nextClientEvent(client, 'close');
        const code = new Promise<number>((resolve) => {
          socket.on('close', (status) => {
            resolve(status);
          });
        });

        {
          await using disposing = server;

          expect(disposing.isOpen()).toBe(true);
        }

        expect(await code).toBe(1001);
        expect(await clientClosed).toEqual([false, false]);
        expect(server.isClosed()).toBe(true);
        expect(server.clients).toEqual([]);

        const late = createWebSocketTransportClient({ WebSocket: Tracked });

        await expect(late.connect({ host, port })).rejects.toBeInstanceOf(ConnectError);
      });

      test('stop closes every connection, each raising its close before it resolves, and stops listening', async () => {
        const second = createWebSocketTransportClient({ WebSocket: Tracked });
        const closeEvents: [boolean, string][] = [];
        server.on('close', (clean, connectionHandle) => {
          closeEvents.push([clean, connectionHandle]);
        });

        const codes: number[] = [];

        for (const [{ socket }] of [await connectClient(client), await connectClient(second)]) {
          socket.on('close', (code) => {
            codes.push(code);
          });
        }

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
        expect(server.clients).toHaveLength(0);
        // its 1001, going away, answered by each peer
        expect(codes).toEqual([1001, 1001]);

        const late = createWebSocketTransportClient({ WebSocket: Tracked });
        await expect(late.connect({ host, port })).rejects.toBeInstanceOf(ConnectError);
      });

      test('stops at once when never started, stops twice, then starts again and accepts', async () => {
        const firstPort = port;
        const [, before] = await connectClient(client);
        const clientClosed = nextClientEvent(client, 'close');

        await server.stop();
        await server.stop();
        expect(await clientClosed).toEqual([false, false]);
        expect(client.isClosed()).toBe(true);

        ({ port } = await server.start({ address: host, findOpenPort: true }));
        expect(port).not.toBe(firstPort);
        const [, after] = await connectClient(client);

        expect(server.clients).toHaveLength(1);
        // ranked after every connection taken before the stop: no handle is given twice
        expect([before, after].map(ordinalOf)).toEqual([1, 2]);
      });
    });
  });
}

test.describe('WebSocketTransportServer, on the wire', () => {
  let server: WebSocketTransportServer;
  let port: number;

  test.beforeEach(async () => {
    server = createWebSocketTransportServer({ WebSocketServer });
    ({ port } = await server.start({ address: host, findOpenPort: true }));
  });

  test.afterEach(async () => {
    await server.stop();
    await allClosed();
  });

  test('delivers a message sent in frames as one, and names its connection', async () => {
    const connection = nextServerEvent(server, 'connection');
    const message = nextServerEvent(server, 'message');
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

    socket.addEventListener('error', () => {});
    await once(socket, 'open');

    // one binary message, its two fragments each a frame of its own (RFC 6455 §5.4)
    socket.send(Uint8Array.of(0xa1, 0x11), { fin: false });
    socket.send(Uint8Array.of(0x00, 0x02), { fin: true });

    const [, connectionHandle] = await connection;
    const [{ data }, heardOn] = await message;

    expect([[...new Uint8Array(data as ArrayBuffer)], heardOn]).toEqual([
      [0xa1, 0x11, 0x00, 0x02],
      connectionHandle,
    ]);
    expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=\d+$/u);
    socket.close();
  });

  test('answers a close at once and says it was clean', async () => {
    const connection = nextServerEvent(server, 'connection');
    const closed = nextServerEvent(server, 'close');
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

    socket.addEventListener('error', () => {});
    await once(socket, 'open');

    const [, connectionHandle] = await connection;
    const answered = once(socket, 'close');

    socket.close(1000);

    // its 1000 answered with 1000: a close waited out to its timeout would end unclean
    expect((await answered)[0]).toBe(1000);
    expect(await closed).toEqual([true, connectionHandle]);
    expect(server.clients).toEqual([]);
  });

  test('raises an error with the handle, then that connection’s close, on a protocol error', async () => {
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

  // RFC 6455 §8.1: `ws` judges a text message whole, failing one in fragments that is no UTF-8 with
  // 1007 at its last fragment, .NET and tungstenite at the first that breaks it; a close's reason,
  // 1007 here and on the Rust side, 1002 on .NET's; rows of docs/support.md
  test('closes with 1007 a text message in fragments that is no UTF-8 once its last fragment came, and with 1007 a close whose reason is no UTF-8', async () => {
    const codes: (number | undefined)[] = [];

    server.on('error', () => {});

    const open = async () => {
      const closed = nextServerEvent(server, 'close');
      const connection = nextServerEvent(server, 'connection');
      const socket = await openTcp(port);
      const received: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
      });
      socket.write(upgradeRequest());
      await connection;

      return {
        closed,
        // the frames it sent so far
        sent: () => {
          return framesOf(Buffer.concat(received));
        },
        socket,
      };
    };
    const closeCodeAmong = (frames: [number, number[]][]): number | undefined => {
      const [, payload] =
        frames.find(([head]) => {
          return head === 0x88;
        }) ?? [];

      return payload && payload.length >= 2
        ? ((payload[0] ?? 0) << 8) | (payload[1] ?? 0)
        : undefined;
    };

    // its first fragment, `FF` without FIN, then a ping, answered with a pong and no close
    const fragmented = await open();

    fragmented.socket.write(maskedFrameOf(0x01, Uint8Array.of(0xff)));
    fragmented.socket.write(maskedFrameOf(0x89, new Uint8Array(0)));
    await expect
      .poll(() => {
        return fragmented.sent();
      })
      .toEqual([[0x8a, []]]);

    // its last fragment, `FE` with FIN, the message whole: failed
    fragmented.socket.write(maskedFrameOf(0x80, Uint8Array.of(0xfe)));
    await expect
      .poll(() => {
        return closeCodeAmong(fragmented.sent());
      })
      .toBeDefined();
    codes.push(closeCodeAmong(fragmented.sent()));
    fragmented.socket.destroy();
    await fragmented.closed;

    const closing = await open();

    closing.socket.write(maskedFrame(0x8, Uint8Array.of(0x03, 0xe8, 0xff, 0xfe)));
    await expect
      .poll(() => {
        return closeCodeAmong(closing.sent());
      })
      .toBeDefined();
    codes.push(closeCodeAmong(closing.sent()));
    closing.socket.destroy();
    await closing.closed;

    expect(codes).toEqual([1007, 1007]);
  });

  test('tells a peer that drops without its closing handshake by its unclean close alone, no error', async () => {
    const errors: unknown[][] = [];
    const closes: unknown[][] = [];
    const handles: string[] = [];
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];

    server.on('error', (err, connectionHandle) => {
      errors.push([err, connectionHandle]);
    });
    server.on('close', (clean, connectionHandle) => {
      closes.push([clean, connectionHandle]);
    });

    // its socket ended with no close frame, then reset
    const drops = [
      async () => {
        const connection = nextServerEvent(server, 'connection');
        const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

        socket.addEventListener('error', () => {});

        const [[, connectionHandle]] = await Promise.all([connection, once(socket, 'open')]);

        socket.terminate();

        return connectionHandle;
      },
      async () => {
        const connection = nextServerEvent(server, 'connection');
        const socket = await openTcp(port);

        socket.write(upgradeRequest());

        const [, connectionHandle] = await connection;

        // a linger of 0: its close an abort, a reset sent rather than a FIN (RFC 9293 §3.10.5)
        socket.resetAndDestroy();

        return connectionHandle;
      },
    ];

    for (const drop of drops) {
      const closed = nextServerEvent(server, 'close');

      handles.push(await drop());
      await closed;
    }

    // and it keeps serving
    const next = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

    await once(next, 'open');

    const message = nextServerEvent(server, 'message');

    next.send('ping');

    const [{ data }, connectionHandle] = await message;

    expect([data, connectionHandle, closes, errors]).toEqual([
      'ping',
      server.clients[0]?.connectionHandle,
      handles.map((handle) => {
        return [false, handle];
      }),
      [],
    ]);
    next.close();
  });

  test('closes with 1009 a message past an envelope’s limit, 16778240 bytes, when told no bound', async () => {
    const connection = nextServerEvent(server, 'connection');
    const delivered: number[] = [];

    server.on('message', ({ data }) => {
      delivered.push((data as ArrayBuffer).byteLength);
    });
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

    socket.addEventListener('error', () => {});
    await once(socket, 'open');

    const whole = nextServerEvent(server, 'message');

    socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES));

    const [{ data }] = await whole;

    expect((data as ArrayBuffer).byteLength).toBe(16_778_240);

    const [, connectionHandle] = await connection;
    const serverClosed = nextServerEvent(server, 'close');
    const closed = once(socket, 'close');

    socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES + 1));

    expect((await closed)[0]).toBe(1009);
    expect(await serverClosed).toEqual([false, connectionHandle]);
    expect(delivered).toEqual([16_778_240]);
    expect(server.clients).toEqual([]);
    expect(server.gauges().connectionHandles).toEqual(new Set());
  });

  // spec 15.3
  test('writes 1 byte for a socket’s maximumMessageBytes of 1', async () => {
    await server.stop();
    server = createWebSocketTransportServer({ maxPayload: 1, WebSocketServer });
    ({ port } = await server.start({ address: host, findOpenPort: true }));

    const told: string[] = [];
    const connection = nextServerEvent(server, 'connection');
    const closed = nextServerEvent(server, 'close');
    const socket = await openTcp(port);

    server.on('error', (error) => {
      told.push(error.message);
    });
    socket.write(upgradeRequest());

    const [, connectionHandle] = await connection;

    socket.write(maskedFrame(0x2, new Uint8Array(2)));
    socket.end();
    await closed;

    expect(told).toEqual([
      `${connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 1 byte`,
    ]);
    socket.destroy();
  });

  test('fails with 1009 a message past its bound, telling one error that names maximumMessageBytes, then an unclean close, even when the peer answers 1000', async () => {
    await server.stop();
    server = createWebSocketTransportServer({ maxPayload: 64, WebSocketServer });
    ({ port } = await server.start({ address: host, findOpenPort: true }));

    const told: unknown[][] = [];
    const connection = nextServerEvent(server, 'connection');
    const closed = nextServerEvent(server, 'close');
    const socket = await openTcp(port);
    const received: Buffer[] = [];

    server.on('error', (error, connectionHandle) => {
      told.push([
        'error',
        error.message,
        (error.cause as NodeJS.ErrnoException | undefined)?.code,
        connectionHandle,
      ]);
    });
    server.on('close', (wasClean, connectionHandle) => {
      told.push([wasClean ? 'clean close' : 'close', connectionHandle]);
    });
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
    });
    socket.write(upgradeRequest());

    const [, connectionHandle] = await connection;

    socket.write(maskedFrame(0x2, new Uint8Array(100)));

    await expect
      .poll(() => {
        return closeCodeOf(Buffer.concat(received));
      })
      .toBe(1009);

    // ! the peer answers 1000, which the server does not read: the close is its own 1009's
    socket.write(maskedFrame(0x8, Uint8Array.of(0x03, 0xe8)));
    socket.end();
    await closed;

    // * judged at its head by the frame meter, before `ws` reads it: no error of `ws`'s its cause
    expect(told).toEqual([
      [
        'error',
        `${connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
        undefined,
        connectionHandle,
      ],
      ['close', connectionHandle],
    ]);
    socket.destroy();
  });

  // spec 15.3
  test('fails with 1009 a peer that never answers, telling one error, then an unclean close once its close timeout passed', async () => {
    await server.stop();
    server = createWebSocketTransportServer({ closeTimeout: 200, maxPayload: 64, WebSocketServer });
    ({ port } = await server.start({ address: host, findOpenPort: true }));

    const told: unknown[][] = [];
    const connection = nextServerEvent(server, 'connection');
    const closed = nextServerEvent(server, 'close');
    const socket = await openTcp(port);

    server.on('error', (error, connectionHandle) => {
      told.push(['error', error.message, connectionHandle]);
    });
    server.on('close', (wasClean, connectionHandle) => {
      told.push([wasClean ? 'clean close' : 'close', connectionHandle]);
    });
    socket.write(upgradeRequest());

    const [, connectionHandle] = await connection;
    const started = Date.now();

    // it never answers the 1009: dropped at the close timeout, 2 s well past the 200 ms asked, and
    // well before the 30 s `ws` waits on its own
    socket.write(maskedFrame(0x2, new Uint8Array(100)));

    expect(
      await Promise.race([
        closed,
        sleep(2_000).then(() => {
          return 'still open';
        }),
      ])
    ).toEqual([false, connectionHandle]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(told).toEqual([
      [
        'error',
        `${connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
        connectionHandle,
      ],
      ['close', connectionHandle],
    ]);
    socket.destroy();
  });

  // docs/support.md, "A WebSocket server's close"
  test('tells a close from its peer with no status code as its platform reads it, clean on .NET, which reads it as 1000, unclean on ws, which reads 1005', async () => {
    const connection = nextServerEvent(server, 'connection');
    const closed = nextServerEvent(server, 'close');
    const socket = await openTcp(port);

    socket.write(upgradeRequest());

    const [, connectionHandle] = await connection;

    // a close frame with no body, its TCP connection ended after it
    socket.end(maskedFrame(0x8, new Uint8Array(0)));

    expect(await closed).toEqual([false, connectionHandle]);
    socket.destroy();
  });

  test('raises connection before a frame that arrived with the upgrade request', async () => {
    const events: string[] = [];
    const message = nextServerEvent(server, 'message');
    server.on('connection', () => {
      events.push('connection');
    });
    server.on('message', ({ data }) => {
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

  test('names a client that comes over IPv4 to a dual-stack listener by its IPv4 address', async () => {
    const dualStack = createWebSocketTransportServer({ WebSocketServer });
    const { port: dualPort } = await dualStack.start({ address: '::', findOpenPort: true });
    const connection = nextServerEvent(dualStack, 'connection');
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://127.0.0.1:${String(dualPort)}`);

    try {
      await once(socket, 'open');

      const [{ request }, connectionHandle] = await connection;

      // the socket's own address, IPv4 mapped into IPv6, read as the IPv4 address it carries, as
      // the upgrade shown to a listener names it
      expect(request.remoteAddress).toBe('127.0.0.1');
      expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=1$/u);
      expect(dualStack.clients).toMatchObject([{ address: '127.0.0.1', connectionHandle }]);
    } finally {
      socket.close();
      await dualStack.stop();
    }
  });

  test('delivers binary as a Buffer with binaryType "nodebuffer", and text still as a string', async () => {
    await server.stop();
    server = createWebSocketTransportServer({ WebSocketServer, binaryType: 'nodebuffer' });
    ({ port } = await server.start({ address: host, findOpenPort: true }));

    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);
    await once(socket, 'open');

    const binary = nextServerEvent(server, 'message');
    socket.send(Buffer.from('bytes'));
    const [{ data }] = await binary;
    expect(Buffer.isBuffer(data)).toBe(true);

    const text = nextServerEvent(server, 'message');
    socket.send('text');
    expect((await text)[0].data).toBe('text');

    socket.close();
  });
});

test.describe('WebSocketTransportServer, the credential its upgrade carries', () => {
  const BEARER = 'Bearer mF_9.B5f-4.1JqM';

  // a socket of `ws`'s on `port`, its upgrade carrying `headers`, open
  const openWith = async (port: number, headers: Record<string, string>) => {
    const [, TrackedWs] = IMPLEMENTATIONS[1];
    const socket: WsWebSocket = new TrackedWs(`ws://${host}:${String(port)}`, { headers });

    await once(socket, 'open');

    return socket;
  };

  // spec 15.1 and 15.2
  test('hands every envelope of a connection its upgrade’s Authorization, as it came and trimmed, and carries none toward its client', async () => {
    await using started = await startDated({});
    const { port, server } = started;
    const messages: unknown[] = [];

    server.on('message', (message) => {
      messages.push(message);
    });

    // a client of Bead's, given the credential at its connect, and one whose upgrade pads it
    const client = createWebSocketTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

    await client.connect({ credential: BEARER, host, port });

    const received = nextClientEvent(client, 'message');

    await client.send({ data: 'one' });
    await client.send({ credential: 'Bearer another', data: 'two' });
    await expect
      .poll(() => {
        return messages.length;
      })
      .toBe(2);

    // nothing toward its client, whatever a send is given
    await server.send({ credential: BEARER, data: 'down' }, server.clients[0]!.connectionHandle);
    expect(await received).toEqual([{ credential: undefined, data: 'down' }]);
    const binary = nextClientEvent(client, 'message');
    await server.send(
      { credential: BEARER, data: new TextEncoder().encode('down') },
      server.clients[0]!.connectionHandle
    );
    const [packet] = await binary;
    expect(packet.credential).toBeUndefined();
    expect(new TextDecoder().decode(packet.data as ArrayBuffer)).toBe('down');

    const padded = await openWith(port, { authorization: ' \tInterop sub=bob\t ' });

    padded.send('three');

    // none, nor from an empty one
    const bare = await openWith(port, {});
    const empty = await openWith(port, { authorization: '' });

    bare.send('four');
    empty.send('five');

    await expect
      .poll(() => {
        return messages.length;
      })
      .toBe(5);
    expect(messages).toEqual([
      { ...FROM, credential: BEARER, data: 'one' },
      { ...FROM, credential: BEARER, data: 'two' },
      { ...FROM, credential: 'Interop sub=bob', data: 'three' },
      { ...FROM, credential: undefined, data: 'four' },
      { ...FROM, credential: undefined, data: 'five' },
    ]);

    await client.disconnect();

    for (const socket of [padded, bare, empty]) {
      socket.close();
    }

    const fake = createFakeWebSocketServer();
    const snapshot = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = snapshot.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;
    const remembered: unknown[] = [];
    snapshot.on('message', ({ credential, data }) => {
      remembered.push([credential, data]);
    });
    const socket = createFakeSocket();
    const request = {
      headers: { authorization: BEARER },
      rawHeaders: ['Authorization', BEARER],
      httpVersion: '1.1',
      socket: { remoteAddress: host, remotePort: 40_000 },
    };
    fake.instances[0]?.emit('connection', socket, request);
    socket.hear('message', Buffer.from('first'), false);
    socket.hear('message', Buffer.from('second'), false);
    request.headers.authorization = 'Bearer another';
    request.rawHeaders[1] = 'Bearer another';
    socket.hear('message', Buffer.from('after'), false);
    expect(remembered).toEqual([
      [BEARER, 'first'],
      [BEARER, 'second'],
      [BEARER, 'after'],
    ]);
    await snapshot.stop();
  });

  // spec 15.2, Fetch's credentials mode include
  test('carries no credential from an upgrade that carries an Origin, its own or one it takes, whatever its Authorization', async () => {
    await using started = await startDated({ origins: ['https://bead.test'] });
    const { port, server } = started;
    const messages: unknown[] = [];

    server.on('message', (message) => {
      messages.push(message);
    });

    const sockets = [
      await openWith(port, { authorization: BEARER, origin: 'https://bead.test' }),
      await openWith(port, { authorization: BEARER, origin: `http://${host}:${String(port)}` }),
      await openWith(port, { authorization: BEARER }),
    ];

    for (const [index, socket] of sockets.entries()) {
      socket.send(String(index));
      await expect
        .poll(() => {
          return messages.length;
        })
        .toBe(index + 1);
    }

    expect(messages).toEqual([
      { ...FROM, credential: undefined, data: '0' },
      { ...FROM, credential: undefined, data: '1' },
      { ...FROM, credential: BEARER, data: '2' },
    ]);

    for (const socket of sockets) {
      socket.close();
    }
  });

  // spec 15.1: no event carries the credential
  test('shows a connection’s upgrade to its listeners headers aside', async () => {
    await using started = await startDated({});
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const socket = await openWith(port, { authorization: BEARER });
    const [opened, connectionHandle] = await connection;
    const { request: upgrade } = opened;

    // * one record, the socket and the upgrade, then the handle: two values, as every event
    expect([Object.isFrozen(opened), Object.keys(opened).toSorted()]).toEqual([
      true,
      ['request', 'socket'],
    ]);
    expect([Object.isFrozen(upgrade), upgrade]).toEqual([
      true,
      { method: 'GET', remoteAddress: '127.0.0.1', remotePort: expect.any(Number), url: '/' },
    ]);
    expect(JSON.stringify(upgrade)).not.toContain(BEARER);
    expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=1$/u);

    socket.close();
  });
});

test.describe('WebSocketTransportServer, its hosts and origins', () => {
  test('refuses an upgrade 403 before its handshake, marked host-refused for a host it does not take and origin-refused for an origin neither its own nor among those it takes, its body empty, its date written, whatever its method, its upgrade or its form', async () => {
    await using started = await startDated({
      hosts: ['bead.test'],
      origins: ['https://bead.example'],
    });
    const { port, server } = started;

    // a host not taken, whatever else the request holds: a page that rebinds its name reaches
    // the address with any method and no upgrade
    await expectAnswered(port, {
      answer: refusedWith('403 Forbidden', { refusal: 'host-refused' }),
      requests: [
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', 'Origin: http://elsewhere.test']),
        requestOf('POST / HTTP/1.1', ['Host: elsewhere.test']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', ...NO_UPGRADE]),
        requestOf('POST / HTTP/1.1', ['Host: elsewhere.test', ...NO_UPGRADE, 'Content-Length: 0']),
        requestOf('PUT /bead HTTP/1.1', [
          'Host: elsewhere.test',
          ...NO_UPGRADE,
          'Content-Length: 0',
        ]),
        requestOf('HEAD / HTTP/1.1', ['Host: elsewhere.test']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', 'Sec-WebSocket-Key: dGVzdA==']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', 'Sec-WebSocket-Version: 8']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', 'Sec-WebSocket-Version: 14']),
        requestOf('GET / HTTP/1.1', ['Host: ']),
      ],
    });

    // a host taken, from an origin neither its own nor among those it takes
    await expectAnswered(port, {
      answer: refusedWith('403 Forbidden', { refusal: 'origin-refused' }),
      requests: [
        requestOf('GET / HTTP/1.1', ['Origin: https://elsewhere.test']),
        requestOf('GET / HTTP/1.1', ['Origin: http://elsewhere.test:80']),
      ],
    });
    expect(server.clients).toHaveLength(0);
  });

  test('takes an upgrade with no Origin, from its own origin, and from one among those it takes', async () => {
    const server = createWebSocketTransportServer({
      origins: ['https://bead.test'],
      WebSocketServer,
    });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const authority = `${host}:${String(port)}`;

    try {
      for (const fields of [
        {},
        { origin: `http://${authority}` },
        { origin: 'https://bead.test' },
      ]) {
        const { text } = await answerOf(port, handshakeOf(authority, fields));

        expect(text.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
      }
    } finally {
      await server.stop();
      await allClosed();
    }
  });

  test('reads the Host of an upgrade as it came: an IDN page’s own in punycode, and one of invalid punycode taken, or refused host-refused, never a 500', async () => {
    // the status line and the mark of an upgrade from each `[Host, Origin]`, on a server given `hosts`
    const answersOf = async (
      hosts: readonly string[] | undefined,
      upgrades: readonly (readonly [string, string?])[]
    ) => {
      const server = createWebSocketTransportServer({ hosts, WebSocketServer });
      const { port } = await server.start({ address: host, findOpenPort: true });
      const answers: [string | undefined, string | undefined][] = [];

      try {
        for (const [authority, origin] of upgrades) {
          const { text } = await answerOf(
            port,
            handshakeOf(authority, origin === undefined ? {} : { origin })
          );

          answers.push([text.split('\r\n')[0], /bead-refusal: (.*)\r\n/u.exec(text)?.[1]]);
        }
      } finally {
        await server.stop();
        await allClosed();
      }

      return answers;
    };
    const taken = ['HTTP/1.1 101 Switching Protocols', undefined];
    const refused = ['HTTP/1.1 403 Forbidden', 'host-refused'];
    const notOwn = ['HTTP/1.1 403 Forbidden', 'origin-refused'];

    // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
    // and a Host of punycode that decodes to none, taken where every host is; under *, no page is
    // the server's own by a host * alone takes (spec 15.12)
    const page = ['xn--bad-bma.test:8080', 'http://xn--bad-bma.test:8080'] as const;

    expect(
      await answersOf(
        ['*'],
        [page, ['xn--a', 'http://xn--a'], ['xn--a'], ['xn--a.test'], ['xn---bad-cpa.test']]
      )
    ).toEqual([notOwn, notOwn, taken, taken, taken]);

    // hosts name an IDN host as the field carries it, in punycode, and none past them is taken
    expect(
      await answersOf(
        ['xn--bad-bma.test'],
        [page, ['XN--BAD-BMA.test:8080'], ['xn--a.test'], ['xn---bad-cpa.test'], ['xn--a']]
      )
    ).toEqual([taken, taken, refused, refused, refused]);
  });

  // spec 15.12
  test('refuses as it is built a hosts entry with a port, and an origins entry that is a star or null', () => {
    const built = (options: Partial<IWebSocketTransportServerOptions>) => {
      return () => {
        return createWebSocketTransportServer({ ...options, WebSocketServer });
      };
    };

    expect(built({ hosts: ['bead.test:8080'] })).toThrow(ProgrammerError);
    expect(built({ hosts: ['bead.test', 'bead.test:8080'] })).toThrow('bead.test:8080');
    expect(built({ hosts: ['bead.test', '*'] })).toThrow(ProgrammerError);
    expect(built({ origins: ['*'] })).toThrow(ProgrammerError);
    expect(built({ origins: ['*'] })).toThrow('no wildcard');
    expect(built({ origins: ['null'] })).toThrow('a sandboxed frame of any site');
    expect(built({ origins: ['https://bead.test/'] })).toThrow(ProgrammerError);
    expect(built({ hosts: ['*'], origins: ['https://bead.test', 'null'] })).toThrow(
      ProgrammerError
    );
    expect(built({ hosts: ['*'], origins: ['https://bead.test'] })).not.toThrow();
  });

  // spec 15.12
  test('refuses as it is built a trustedProxies entry that is a name or a network of prefix 0, or an unnamedProxies past 8', () => {
    const built = (trustedProxies: readonly string[], unnamedProxies?: number) => {
      return () => {
        return createWebSocketTransportServer({ trustedProxies, unnamedProxies, WebSocketServer });
      };
    };

    expect(built(['127.0.0.1', 'proxy.internal'])).toThrow(ProgrammerError);
    expect(built(['127.0.0.1', 'proxy.internal'])).toThrow('proxy.internal');
    for (const everyone of ['0.0.0.0/0', '::/0']) {
      expect(built([everyone]), everyone).toThrow('it would trust what every client writes');
    }
    expect(built(['127.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8'])).not.toThrow();
    // the proxies it counts, those the list does not name, 8 at most
    expect(built([], 9)).toThrow(ProgrammerError);
    expect(built([], Infinity)).toThrow('it would trust what every client writes');
    expect(built(['10.0.0.0/8'], 8)).not.toThrow();
  });
});

test.describe('WebSocketTransportServer, its handshake', () => {
  test('refuses a method but GET or HEAD 405, after its host and before its upgrade is read, its Allow naming GET and HEAD, marked method-refused', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;

    // a handshake under another method, one of version 8 among them, or none at all; a CONNECT,
    // which Node raises apart from a request
    await expectAnswered(port, {
      answer: refusedWith('405 Method Not Allowed', {
        fields: ['allow: GET, HEAD'],
        refusal: 'method-refused',
      }),
      requests: [
        requestOf('POST / HTTP/1.1'),
        requestOf('PUT / HTTP/1.1'),
        requestOf('OPTIONS / HTTP/1.1'),
        requestOf('POST / HTTP/1.1', ['Sec-WebSocket-Version: 8']),
        requestOf('DELETE / HTTP/1.1', [...NO_UPGRADE]),
        requestOf('POST / HTTP/1.1', [...NO_UPGRADE, 'Content-Length: 0']),
        requestOf('CONNECT bead.test:80 HTTP/1.1', ['Host: bead.test:80']),
      ],
    });
    expect(server.clients).toHaveLength(0);
  });

  test('answers a request that asks no WebSocket 426, marked upgrade-required, its Upgrade naming websocket, its Connection upgrade and close', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;

    // no upgrade at all; an Upgrade missing or naming no websocket; a Connection missing or
    // naming no upgrade; a HEAD, which cannot switch, its body none and its length 0; an
    // HTTP/1.0 request, whose Upgrade is ignored
    await expectAnswered(port, {
      answer: refusedWith('426 Upgrade Required', {
        fields: ['upgrade: websocket'],
        refusal: 'upgrade-required',
      }),
      requests: [
        requestOf('GET / HTTP/1.1', [...NO_UPGRADE]),
        requestOf('GET / HTTP/1.1', ['Upgrade: h2c']),
        requestOf('GET / HTTP/1.1', ['Upgrade']),
        requestOf('GET / HTTP/1.1', ['Upgrade: websocket/13']),
        requestOf('GET / HTTP/1.1', ['Connection']),
        requestOf('GET / HTTP/1.1', ['Connection: keep-alive']),
        requestOf('GET / HTTP/1.1', ['Connection: upgraded']),
        requestOf('GET / HTTP/1.1', ['Upgrade: h2c', 'Sec-WebSocket-Version: 8']),
        requestOf('GET / HTTP/1.1', ['Upgrade', 'Sec-WebSocket-Version: 8']),
        requestOf('HEAD / HTTP/1.1'),
        requestOf('HEAD / HTTP/1.1', [...NO_UPGRADE]),
        requestOf('GET / HTTP/1.0'),
        requestOf('GET / HTTP/1.0', ['Upgrade: websocket, h2c']),
        requestOf('GET / HTTP/1.0', [...NO_UPGRADE]),
      ],
    });
    expect(server.clients).toHaveLength(0);
  });

  test('refuses a malformed upgrade 400, marked malformed, before its origin is judged, its body empty', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const bearer = 'Bearer mF_9.B5f-4.1JqM';

    // a key missing, not base64, of 4 or 17 bytes, twice, empty, or with a space inside; two
    // versions; subprotocols that are no list of tokens, or none; content, by its length or in
    // chunks; a bad key from an origin not taken
    await expectAnswered(port, {
      answer: refusedWith('400 Bad Request', { refusal: 'malformed' }),
      requests: [
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: not a key at all!!!!!==']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: dGVzdA==']),
        requestOf('GET / HTTP/1.1', [`Sec-WebSocket-Key: ${randomBytes(17).toString('base64')}`]),
        requestOf('GET / HTTP/1.1', [`Sec-WebSocket-Key: ${KEY}`, `Sec-WebSocket-Key: ${KEY}`]),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: ']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: dGhlIHNhbXBs ZSBub25jZQ==']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 13', 'Sec-WebSocket-Version: 13']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Protocol: a b']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Protocol: ']),
        `${requestOf('GET / HTTP/1.1', ['Content-Length: 5'])}hello`,
        `${requestOf('GET / HTTP/1.1', ['Transfer-Encoding: chunked'])}5\r\nhello\r\n0\r\n\r\n`,
        requestOf('GET / HTTP/1.1', [
          'Sec-WebSocket-Key: dGVzdA==',
          'Origin: https://elsewhere.test',
        ]),
        requestOf('GET / HTTP/1.1', [`Authorization: ${bearer}`, `Authorization: ${bearer}`]),
        requestOf('GET / HTTP/1.1', [
          `Authorization: ${bearer}`,
          `Authorization: ${bearer}`,
          'Origin: https://elsewhere.test',
        ]),
      ],
    });
    expect(server.clients).toHaveLength(0);
  });

  // spec 15.2.8
  test('refuses an upgrade that comes as it stops, 503 busy, told when to come back', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const peer = new TrackedWsWebSocket(`ws://${host}:${String(port)}`, {
      headers: { host: 'bead.test' },
    });

    await once(peer, 'open');

    const connectionHandle = server.clients[0]?.connectionHandle;
    const peerClosed = once(peer, 'close');
    const transportClosed = nextServerEvent(server, 'close');
    const socket = await openTcp(port);
    const answer = { isClosed: false, text: '' };
    const head = requestOf('GET / HTTP/1.1');
    const cut = head.indexOf('Sec-WebSocket-Version');

    socket.on('data', (chunk: Buffer) => {
      answer.text += chunk.toString('latin1');
    });
    socket.on('close', () => {
      answer.isClosed = true;
    });

    // its head in two writes, one each side of the stop: long enough for the server to start
    // parsing the first, which keeps its connection past the stop
    socket.write(head.slice(0, cut));
    await sleep(100);
    await server.stop();
    socket.write(head.slice(cut));

    await expect
      .poll(() => {
        return answer.isClosed;
      })
      .toBe(true);
    socket.destroy();

    expect(answer).toEqual(
      refusedWith('503 Service Unavailable', { fields: ['retry-after: 1'], refusal: 'busy' })
    );
    expect((await peerClosed)[0]).toBe(1001);
    expect(await transportClosed).toEqual([false, connectionHandle]);
    expect(server.clients).toHaveLength(0);
  });

  test('answers 426 to an upgrade of a version but 13 or of none, marked version-refused, naming version 13 and websocket, before its key and its origin are judged', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;

    // version 8, which RFC 6455 left behind and no browser sends, from an origin not taken, with
    // its own origin's field, or with a bad key; any other, none, or a list in one field line
    await expectAnswered(port, {
      answer: refusedWith('426 Upgrade Required', {
        fields: ['upgrade: websocket', 'sec-websocket-version: 13'],
        refusal: 'version-refused',
      }),
      requests: [
        requestOf('GET / HTTP/1.1', ['Origin: https://elsewhere.test', 'Sec-WebSocket-Version: 8']),
        requestOf('GET / HTTP/1.1', [
          'Sec-WebSocket-Origin: http://bead.test',
          'Sec-WebSocket-Version: 8',
        ]),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 8']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: dGVzdA==', 'Sec-WebSocket-Version: 8']),
        requestOf('GET / HTTP/1.1', ['Origin: https://elsewhere.test', 'Sec-WebSocket-Version: 7']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 013']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 13, 8']),
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 8, 13']),
      ],
    });
    expect(server.clients).toHaveLength(0);

    // version 13, from the server's own origin, upgrades
    expect(
      await statusLineOf(port, requestOf('GET / HTTP/1.1', ['Origin: http://bead.test']))
    ).toBe('HTTP/1.1 101 Switching Protocols');
  });

  test('answers a request without a Host, with two, or with one that is no host, 400 as HTTP does, unmarked', async () => {
    // the status, the mark and the body of what the server answers `request`, its socket closed; a
    // body in chunks read whole
    const answeredOf = async (port: number, request: string) => {
      const { isClosed, text } = await answerOf(port, request);
      const [head = '', body = ''] = text.split(/\r\n\r\n(?<body>.*)/su);

      return [
        isClosed,
        Number(head.split(' ')[1]),
        /bead-refusal/iu.test(head),
        /transfer-encoding: chunked/iu.test(head) && body === '0\r\n\r\n' ? '' : body,
      ];
    };

    // its head is the HTTP server's own, Node's for a Host missing, whether the server takes every
    // host or names some
    for (const hosts of [undefined, ['bead.test']]) {
      await using started = await startDated({ hosts });
      const { port, server } = started;

      for (const request of [
        requestOf('GET / HTTP/1.1', ['Host']),
        requestOf('GET / HTTP/1.1', ['Host: bead.test', 'Host: elsewhere.test']),
        requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', 'Host: bead.test']),
        requestOf('GET / HTTP/1.1', ['Host: bad host']),
      ]) {
        expect(await answeredOf(port, request), request).toEqual([true, 400, false, '']);
      }
      expect(server.clients).toHaveLength(0);
    }
  });

  test('takes an upgrade whose Upgrade lists websocket in any case, in one field line or several, whose Connection names upgrade among other tokens, with no content', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port } = started;

    for (const request of [
      requestOf('GET / HTTP/1.1', ['Upgrade: WebSocket']),
      requestOf('GET / HTTP/1.1', ['Upgrade: h2c, websocket']),
      requestOf('GET / HTTP/1.1', ['Upgrade: websocket, h2c']),
      requestOf('GET / HTTP/1.1', ['Upgrade: h2c', 'Upgrade: websocket']),
      requestOf('GET / HTTP/1.1', ['Connection: keep-alive, upgrade']),
      requestOf('GET / HTTP/1.1', ['Connection: UPGRADE']),
      requestOf('GET / HTTP/1.1', ['Connection: keep-alive', 'Connection: upgrade']),
      requestOf('GET / HTTP/1.1', ['Content-Length: 0']),
      requestOf('GET / HTTP/1.1', ['Content-Length: 00']),
      requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==']),
    ]) {
      expect(await statusLineOf(port, request), request).toBe('HTTP/1.1 101 Switching Protocols');
    }
  });

  // spec 15.2, 15.12
  test('closes in stages a refusal of an upgrade whose body is still coming, its client reading the refusal as it goes on sending', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    // * a client that sends on past the server's end of its write side, as one still sending does
    const socket = connectTcp({ allowHalfOpen: true, host, port });
    const answer = { answered: 0, closed: 0, isReset: false, text: '' };

    await once(socket, 'connect');
    socket.on('data', (chunk: Buffer) => {
      answer.text += chunk.toString('latin1');

      if (answer.answered === 0 && answer.text.includes('\r\n\r\n')) {
        answer.answered = performance.now();
      }
    });
    socket.on('error', () => {
      answer.isReset ||= answer.answered === 0;
    });
    socket.on('close', () => {
      answer.closed = performance.now();
    });

    // its head alone, at its own host, a body in chunks declared, and a chunk of it every 200 ms
    socket.write(requestOf('GET / HTTP/1.1', ['Transfer-Encoding: gzip, chunked']));

    const sending = setInterval(() => {
      if (!socket.destroyed) {
        socket.write('1\r\na\r\n');
      }
    }, 200);

    try {
      await expect
        .poll(
          () => {
            return answer.closed;
          },
          { timeout: 5_000 }
        )
        .toBeGreaterThan(0);
    } finally {
      clearInterval(sending);
      socket.destroy();
    }

    // the refusal whole, unmarked, read before any reset, which closes its connection; then what
    // still came read on and dropped, its socket closed once the linger's 2 s passed
    const head = (answer.text.split('\r\n\r\n')[0] ?? '').toLowerCase();

    expect(answer.text).toMatch(/^HTTP\/1\.1 400 /u);
    expect(head).toContain('connection: close');
    expect(head).not.toContain('bead-refusal');
    expect(answer.isReset).toBe(false);
    expect(answer.closed - answer.answered).toBeGreaterThan(1_000);
    expect(answer.closed - answer.answered).toBeLessThan(3_000);
    expect(server.clients).toHaveLength(0);
  });
});

test.describe('WebSocketTransportServer, with a scripted WebSocketServer', () => {
  test('hands `maxPayload` and its close timeout to the WebSocketServer, an envelope’s limit and CLOSE_TIMEOUT when not given', async () => {
    for (const [maxPayload, expected] of [
      [256, 256],
      [undefined, 16_778_240],
    ] as const) {
      const fake = createFakeWebSocketServer();
      const server = createWebSocketTransportServer({
        maxPayload,
        WebSocketServer: fake.FakeWebSocketServer,
      });

      const starting = server.start(SCRIPTED);
      fake.instances[0]?.emit('listening');
      await starting;

      const {
        handleProtocols,
        server: given,
        ...options
      } = (fake.instances[0]?.options ?? {}) as {
        closeTimeout: number;
        handleProtocols: () => false;
        maxFragments: number;
        maxPayload: number;
        server: Server;
      };

      // the transport's own HTTP server, which judges each request before ws reads it; no
      // subprotocol selected (spec 15.2); its bounds behind the frame meter's
      expect(options).toEqual({
        closeTimeout: CLOSE_TIMEOUT,
        maxFragments: MAXIMUM_MESSAGE_FRAMES,
        maxPayload: expected,
      });
      expect(handleProtocols()).toBe(false);
      expect(given).toBeInstanceOf(Server);
      // the scripted bind opens no TCP socket, even once Node can finish a real listen
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect([given.listening, given.address(), fake.instances[0]?.listened]).toEqual([
        false,
        null,
        [0, host],
      ]);
      await server.stop();
    }

    expect(MAXIMUM_MESSAGE_BYTES).toBe(16_778_240);
  });

  test('closes going away a connection whose accept a stop crossed', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      closeTimeout: 50,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const closes: ServerEvents['close'][] = [];
    // a peer that never answers its close holds the stop past its snapshot of the connections
    const silent = createFakeSocket({ onClose: 'ignore' });

    server.on('close', (...params) => {
      closes.push(params);
    });
    const silentHandle = fake.connect(silent, { remotePort: 40_000, server });

    const stopping = server.stop();

    await expect
      .poll(() => {
        return silent.closeCodes;
      })
      .toEqual([1001]);

    // a WebSocketServer that delivers a connection after its close, past the snapshot
    const late = createFakeSocket();
    const lateHandle = fake.connect(late, { remotePort: 40_001, server });

    await stopping;

    expect(late.closeCodes).toEqual([1001]);
    expect(closes).toContainEqual([false, silentHandle]);
    expect(closes).toContainEqual([false, lateHandle]);
    expect(closes).toHaveLength(2);
    expect(server.clients).toEqual([]);
    expect(server.isClosed()).toBe(true);

    // a stop inside the accept, before its connection enters the registry
    const crossing = createFakeWebSocketServer();
    const crossed = createWebSocketTransportServer({
      WebSocketServer: crossing.FakeWebSocketServer,
    });
    const opening = crossed.start(SCRIPTED);

    crossing.instances[0]?.emit('listening');
    await opening;

    const ended: ServerEvents['close'][] = [];
    let ending = Promise.resolve();

    crossed.on('close', (...params) => {
      ended.push(params);
    });
    crossing.instances[0]?.prependListener('connection', () => {
      ending = crossed.stop();
    });

    const arriving = createFakeSocket();
    const arrivingHandle = crossing.connect(arriving, { server: crossed });

    await ending;

    expect(arriving.closeCodes).toEqual([1001]);
    expect(ended).toEqual([[false, arrivingHandle]]);
    expect(crossed.clients).toEqual([]);
    expect(crossed.isClosed()).toBe(true);
  });

  test('is secure as its application says what stands in front of it, whatever it listens on, and by what it listens on when it says nothing', async () => {
    const securedBy = async ({ address, secure }: { address: string; secure?: boolean }) => {
      const fake = createFakeWebSocketServer({ address: { address, port: 4_321 } });
      const server = createWebSocketTransportServer({
        ...(secure === undefined ? {} : { secure }),
        WebSocketServer: fake.FakeWebSocketServer,
      });
      const starting = server.start({ address, findOpenPort: true });

      fake.instances[0]?.emit('listening');
      await starting;

      try {
        return server.isSecure(fake.connect(createFakeSocket(), { server }));
      } finally {
        await server.stop();
      }
    };

    expect(
      await Promise.all([
        securedBy({ address: '127.0.0.1' }),
        securedBy({ address: '0.0.0.0' }),
        // TLS terminated before it, on another host
        securedBy({ address: '0.0.0.0', secure: true }),
        // a proxy on the machine that serves the network in the clear
        securedBy({ address: '127.0.0.1', secure: false }),
        securedBy({ address: '127.0.0.1', secure: true }),
        securedBy({ address: '0.0.0.0', secure: false }),
      ])
    ).toEqual([true, false, true, false, true, false]);
  });

  test('reports the port it was asked for when the server reports no port of its own', async () => {
    for (const address of ['/run/bead.sock', null]) {
      const fake = createFakeWebSocketServer({ address });
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

      const starting = server.start({ ...SCRIPTED, port: 4_321 });
      fake.instances[0]?.emit('listening');

      expect(await starting).toEqual({ address: host, port: 4_321 });
      expect(server.port).toBe(4_321);
      await server.stop();
    }
  });

  test("an error after listening is the server's own, with an empty handle, and it stays open", async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const error = nextServerEvent(server, 'error');
    const failure = new Error('late');
    fake.instances[0]?.emit('error', failure);

    expect(await error).toEqual([failure, '']);
    expect(server.isOpen()).toBe(true);
    await server.stop();
  });

  test('a cancelled start throws, disposes what it built, and can start again', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const controller = new AbortController();

    const starting = server.start({ ...SCRIPTED, signal: controller.signal });
    controller.abort('why');

    await expect(starting).rejects.toBeInstanceOf(CancelError);
    await expect(starting).rejects.toHaveProperty('cause', 'why');
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);

    const again = server.start(SCRIPTED);

    fake.instances[1]?.emit('listening');
    await again;

    expect(server.isOpen()).toBe(true);
    await server.stop();
  });

  test('an error before listening rejects the start and closes what was opened', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start(SCRIPTED);
    const failure = new Error('refused');
    fake.instances[0]?.emit('error', failure);

    await expect(starting).rejects.toBe(failure);
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);
  });

  test('names each connection by its peer’s port and the rank it came at, two sockets from one address and port among them, and gives no handle twice', async () => {
    for (const wasClean of [true, false]) {
      const fake = createFakeWebSocketServer();
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
      const starting = server.start(SCRIPTED);

      fake.instances[0]?.emit('listening');
      await starting;

      const [first, second, third] = [createFakeSocket(), createFakeSocket(), createFakeSocket()];
      const closed: unknown[] = [];

      server.on('close', (...args) => {
        closed.push(args);
      });
      // three sockets from one address and port, the first closed before the third came
      const firstHandle = fake.connect(first, { server });
      const secondHandle = fake.connect(second, { server });

      if (wasClean) {
        first.close(1000);
      } else {
        first.terminate();
      }

      expect(closed).toEqual([[wasClean, firstHandle]]);

      const thirdHandle = fake.connect(third, { server });

      expect([firstHandle, secondHandle, thirdHandle]).toEqual([
        'type=WS;ip=10.0.0.1;port=40000;ordinal=1',
        'type=WS;ip=10.0.0.1;port=40000;ordinal=2',
        'type=WS;ip=10.0.0.1;port=40000;ordinal=3',
      ]);
      expect(server.clients).toMatchObject([
        { address: '10.0.0.1', connectionHandle: secondHandle, port: 40_000 },
        { address: '10.0.0.1', connectionHandle: thirdHandle, port: 40_000 },
      ]);

      expect(server.gauges().counts['connections']).toBe(2);
      expect(server.gauges().connectionHandles).toEqual(new Set([secondHandle, thirdHandle]));

      // each its own: a close reaches its socket alone, and the first's handle names none
      await expect(server.close(firstHandle)).resolves.toBe(false);
      await expect(server.close(secondHandle)).resolves.toBe(true);
      expect([second.closeCodes, third.closeCodes]).toEqual([[1000], []]);
      expect(server.gauges().connectionHandles).toEqual(new Set([thirdHandle]));
      await server.stop();
    }
  });

  test('closes each of two sockets from one address and port on its own, each its own close told', async () => {
    // each ending in turn: its peer's close, clean, and its socket gone, unclean
    const endings = [
      {
        end: (socket: IFakeSocket) => {
          socket.hear('close', 1000);
        },
        wasClean: true,
      },
      {
        end: (socket: IFakeSocket) => {
          socket.terminate();
        },
        wasClean: false,
      },
    ];

    for (const { end, wasClean } of endings) {
      const fake = createFakeWebSocketServer();
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
      const closes: unknown[] = [];
      const starting = server.start(SCRIPTED);

      fake.instances[0]?.emit('listening');
      await starting;
      server.on('close', (...params) => {
        closes.push(params);
      });

      const older = createFakeSocket();
      const newer = createFakeSocket();
      // the same port given again: another connection, another handle
      const olderHandle = fake.connect(older, { server });
      const newerHandle = fake.connect(newer, { server });

      expect(olderHandle).not.toBe(newerHandle);

      end(older);

      expect([wasClean, closes, server.gauges().counts]).toEqual([
        wasClean,
        [[wasClean, olderHandle]],
        {
          connections: 1,
          largestAddressConnections: 0,
          largestUnsentBytes: 0,
          messageBytes: 0,
          unsentBytes: 0,
        },
      ]);

      // the newer stands, and is sent to
      await server.send({ data: new Uint8Array([1]) }, newerHandle);

      expect([
        older.sent,
        newer.sent,
        server.clients.map(({ connectionHandle }) => {
          return connectionHandle;
        }),
      ]).toEqual([[], [new Uint8Array([1])], [newerHandle]]);

      end(newer);

      expect([wasClean, closes, server.gauges().counts]).toEqual([
        wasClean,
        [
          [wasClean, olderHandle],
          [wasClean, newerHandle],
        ],
        {
          connections: 0,
          largestAddressConnections: 0,
          largestUnsentBytes: 0,
          messageBytes: 0,
          unsentBytes: 0,
        },
      ]);
      await server.stop();
    }
  });

  test('takes no connection whose socket is gone already, and ends it', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const connections: unknown[] = [];
    const starting = server.start(SCRIPTED);

    fake.instances[0]?.emit('listening');
    await starting;
    server.on('connection', (...params) => {
      connections.push(params);
    });

    const first = createFakeSocket();
    const second = createFakeSocket();
    const live = createFakeSocket();
    const handle = fake.connect(live, { server });

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

  test('drops a connection that never answers its close once the timeout passed, telling no error', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      closeTimeout: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const errors: unknown[] = [];
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    server.on('error', (error) => {
      errors.push(error);
    });

    const silent = createFakeSocket({ onClose: 'ignore' });
    fake.connect(silent, { server });

    const started = Date.now();
    await server.stop();

    expect(silent.closeCodes).toEqual([1001]);
    expect(silent.wasTerminated).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // its own abort, past its close timeout, is no error on the connection
    expect(errors).toEqual([]);
    // and `ws` is given the same bound, which it arms on a close of its own, its 1009
    expect(fake.instances[0]?.options).toMatchObject({ closeTimeout: 20 });
  });

  test('waits on its peer without end for a close timeout of Infinity, arming no timer', async () => {
    const fake = createFakeWebSocketServer();

    // Infinity arms no timer, where Node's would take it for 1 ms and drop the peer at once
    const server = createWebSocketTransportServer({
      closeTimeout: Infinity,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);

    fake.instances.at(-1)?.emit('listening');
    await starting;

    const silent = createFakeSocket({ onClose: 'ignore' });
    const closing = server.close(fake.connect(silent, { server }));
    let isCompleted = false;
    void closing.then(() => {
      isCompleted = true;
    });

    await sleep(50);

    expect(silent.wasTerminated).toBe(false);
    expect(isCompleted).toBe(false);

    silent.hear('close', 1000);

    await expect(closing).resolves.toBe(true);
    // ! `ws` arms a timer of its own on every close, which it is given the longest a timer holds
    expect(fake.instances.at(-1)?.options).toMatchObject({ closeTimeout: 2 ** 31 - 1 });
    await server.stop();
  });

  test('stamps the activity on its clock, and bounds a close on the real one, which the clock given never times', async () => {
    const clock = createTestClock(Date.UTC(2026, 0, 1));
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      clock,
      closeTimeout: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const silent = createFakeSocket({ onClose: 'ignore' });

    fake.connect(silent, { server });
    clock.tick(5);
    silent.hear('message', Buffer.from('bytes'), true);

    expect(server.clock).toBe(clock);
    expect(server.clients[0]?.lastActivity).toBe(Date.UTC(2026, 0, 1) + 5);

    // its 20 ms pass on the real clock, the clock given never advanced
    await server.stop();

    expect(silent.wasTerminated).toBe(true);
    expect(clock.armed).toEqual([]);
  });

  test('drops a connection whose close throws, and still resolves "close" to true', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const closes: unknown[] = [];
    const errors: unknown[] = [];

    server.on('close', (...args) => {
      closes.push(args);
    });
    server.on('error', (error, handle) => {
      errors.push([error.message, handle]);
    });
    const stubborn = createFakeSocket({ onClose: 'throw' });
    const connectionHandle = fake.connect(stubborn, { server });

    await expect(server.close(connectionHandle)).resolves.toBe(true);
    expect(stubborn.wasTerminated).toBe(true);
    expect(server.clients).toHaveLength(0);
    expect(server.gauges().connectionHandles).toEqual(new Set());
    // what its close threw is its error
    expect(errors).toEqual([['close refused', connectionHandle]]);
    expect(closes).toEqual([[false, connectionHandle]]);
    await server.stop();
  });

  test('ends a connection whose drop throws at its close timeout, telling what it threw once and its close, at a close and at a stop', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      closeTimeout: 10,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const closes: unknown[] = [];
    const errors: unknown[] = [];

    server.on('close', (...args) => {
      closes.push(args);
    });
    server.on('error', (error, connectionHandle) => {
      errors.push([error.message, connectionHandle]);
    });

    // neither answers its close, and neither closes as it is terminated
    const closed = createFakeSocket({ onClose: 'ignore', onTerminate: 'throw' });
    const stopped = createFakeSocket({ onClose: 'ignore', onTerminate: 'throw' });
    const closedHandle = fake.connect(closed, { remotePort: 40_001, server });
    const stoppedHandle = fake.connect(stopped, { remotePort: 40_002, server });

    await expect(server.close(closedHandle)).resolves.toBe(true);
    await server.stop();

    expect([closed.wasTerminated, stopped.wasTerminated]).toEqual([true, true]);
    expect(server.clients).toHaveLength(0);
    expect(closes).toEqual([
      [false, closedHandle],
      [false, stoppedHandle],
    ]);
    expect(errors).toEqual([
      ['terminate refused', closedHandle],
      ['terminate refused', stoppedHandle],
    ]);

    // a socket that closes after its connection ended tells nothing more
    closed.hear('close', 1006);
    expect([closes.length, errors.length]).toEqual([2, 2]);
  });

  test('ends a connection dropped behind a bound whose drop throws, telling the bound, not what its drop threw, and its close', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      maximumUnsentBytes: 65_536,
      minimumSendBytesPerSecond: 0,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const told: unknown[] = [];

    server.on('error', (error, handle) => {
      told.push(['error', error.message, handle]);
    });
    server.on('close', (wasClean, handle) => {
      told.push(['close', wasClean, handle]);
    });

    // a socket that never closes as it is terminated, sent more than its bound holds
    const behind = createFakeSocket({ onTerminate: 'throw' });
    const connectionHandle = fake.connect(behind, { server });

    await server.send({ data: new Uint8Array(65_537) }, connectionHandle);

    expect(behind.wasTerminated).toBe(true);
    expect(server.clients).toHaveLength(0);
    expect(told).toEqual([
      [
        'error',
        `${connectionHandle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
        connectionHandle,
      ],
      ['close', false, connectionHandle],
    ]);
    await server.stop();
  });

  test('ends a connection whose close and drop both throw, telling what its close threw, not its drop’s, and its close', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const told: unknown[] = [];

    server.on('error', (error, handle) => {
      told.push(['error', error.message, handle]);
    });
    server.on('close', (wasClean, handle) => {
      told.push(['close', wasClean, handle]);
    });

    const stubborn = createFakeSocket({ onClose: 'throw', onTerminate: 'throw' });
    const connectionHandle = fake.connect(stubborn, { server });

    await expect(server.close(connectionHandle)).resolves.toBe(true);
    expect(stubborn.wasTerminated).toBe(true);
    expect(server.clients).toHaveLength(0);
    expect(told).toEqual([
      ['error', 'close refused', connectionHandle],
      ['close', false, connectionHandle],
    ]);
    await server.stop();
  });
});

test.describe('WebSocketTransportServer, heartbeat', () => {
  test('pings each connection silent for its heartbeat with data of its own, keeps one that echoes it, and drops one that left it unanswered, or could not be sent one', async () => {
    // * its heartbeat runs on its platform's clock, here a test's, stepped a heartbeat at a time
    const platform = createTestClock();
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      [PLATFORM]: platform,
      heartbeat: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const pinged: Uint8Array[] = [];
    const answering = createFakeSocket({ onPing: 'answer' });
    const silent = createFakeSocket();
    const closing = createFakeSocket();
    const closes: [wasClean: boolean, connectionHandle: string][] = [];
    const errors: unknown[] = [];
    const { ping } = answering;

    answering.ping = (data) => {
      pinged.push(data);
      ping(data);
    };

    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;
    server.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });
    server.on('error', (error) => {
      errors.push(error);
    });

    fake.connect(answering, { remotePort: 40_001, server });

    const silentHandle = fake.connect(silent, { remotePort: 40_002, server });
    const closingHandle = fake.connect(closing, { remotePort: 40_003, server });

    // a socket in its close handshake is sent no ping, and is dropped all the same
    (closing as { readyState: number }).readyState = 2;

    // a heartbeat past the ping each left unanswered, its peer dropped
    await platform.tickAsync(40);

    expect(closes).toHaveLength(2);
    expect(
      closes.map(([, handle]) => {
        return handle;
      })
    ).toEqual(expect.arrayContaining([silentHandle, closingHandle]));
    expect(
      closes.map(([wasClean]) => {
        return wasClean;
      })
    ).toEqual([false, false]);
    expect([silent.pings, closing.pings, silent.wasTerminated, closing.wasTerminated]).toEqual([
      1,
      0,
      true,
      true,
    ]);
    // a peer the heartbeat dropped, gone without a word, is no error on its connection
    expect(errors).toEqual([]);

    // the one that echoes is pinged again once silent, each ping 8 bytes of a count from 1
    await platform.tickAsync(20);

    expect([answering.pings, answering.wasTerminated]).toEqual([3, false]);
    expect(pinged.slice(0, 3)).toEqual([
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1),
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 2),
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 3),
    ]);

    await server.stop();
  });

  test('pings once silent for HEARTBEAT when told nothing', async () => {
    const platform = createTestClock();
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      [PLATFORM]: platform,
      WebSocketServer: fake.FakeWebSocketServer,
    });

    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const before = platform.armed.length;

    fake.connect(createFakeSocket(), { server });

    expect(
      platform.armed.slice(before).map(({ delay }) => {
        return delay;
      })
    ).toEqual([HEARTBEAT]);

    await server.stop();
  });

  test('pings nothing with a heartbeat of infinity', async () => {
    // a heartbeat of 200 ms first, which arms its timer, then Infinity, which arms nothing
    for (const [heartbeat, delays] of [
      [200, [200]],
      [Infinity, []],
    ] as const) {
      const platform = createTestClock();
      const fake = createFakeWebSocketServer();
      const server = createWebSocketTransportServer({
        [PLATFORM]: platform,
        heartbeat,
        WebSocketServer: fake.FakeWebSocketServer,
      });
      const socket = createFakeSocket();

      const starting = server.start(SCRIPTED);
      fake.instances[0]?.emit('listening');
      await starting;

      const before = platform.armed.length;
      const connectionHandle = fake.connect(socket, { server });

      // no timer at all for Infinity: Node would fire one of Infinity at once
      expect([
        heartbeat,
        platform.armed.slice(before).map(({ delay }) => {
          return delay;
        }),
      ]).toEqual([heartbeat, delays]);
      expect([
        heartbeat,
        socket.pings,
        socket.wasTerminated,
        server.clients.map(({ connectionHandle: held }) => {
          return held;
        }),
      ]).toEqual([heartbeat, 0, false, [connectionHandle]]);

      await server.stop();
    }
  });

  // spec 15.3 and 15.12
  test('drops a connection it pauses past twice its heartbeat by its own heartbeat, its peer answering every ping', async () => {
    await using started = await startDated({ heartbeat: 200 });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange({ host, port }, encoder.encode(upgradeRequest()));
    const [, connectionHandle] = await connection;
    const closed = nextServerEvent(server, 'close');

    // * paused within the hand of a message, as a router at its bound pauses: it reads nothing more
    // of its peer, the echo of its ping among it
    server.on('message', (_message, handle) => {
      server.pause(handle);
    });

    try {
      exchange.send([{ fin: true, opcode: OPCODES.BINARY, payload: Uint8Array.of(1) }]);

      expect(await exchange.next(2_000)).toEqual({ ping: expect.any(Uint8Array) as unknown });
      expect(await exchange.next(2_000)).toEqual({ end: true });

      // told closed, unclean, while still paused
      expect(await closed).toEqual([false, connectionHandle]);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3 and 15.12
  test('drops a connection it pauses between messages past twice its heartbeat by its own heartbeat, its peer answering every ping', async () => {
    await using started = await startDated({ heartbeat: 200 });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange({ host, port }, encoder.encode(upgradeRequest()));
    const [, connectionHandle] = await connection;
    const closed = nextServerEvent(server, 'close');

    try {
      let heard = await exchange.next(2_000);

      expect(heard).toEqual({ ping: expect.any(Uint8Array) as unknown });

      // * paused once it pinged, outside the hand of a message, as a router pauses on another
      // connection's turn: its read already waits on its peer, and reads nothing more of it
      server.pause(connectionHandle);

      for (let pings = 0; heard !== undefined && 'ping' in heard && pings < 20; pings += 1) {
        heard = await exchange.next(2_000);
      }

      expect(heard).toEqual({ end: true });

      // told closed, unclean, while still paused
      expect(await closed).toEqual([false, connectionHandle]);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3 and 15.12: a paused connection reads nothing of its socket, whose end it meets at once
  // all the same
  test('tells the close of a connection it pauses at once when its peer ends it, by a FIN or a reset', async () => {
    // * no heartbeat, never resumed: its socket's end alone tells its close
    await using started = await startDated({ heartbeat: Infinity });
    const { port, server } = started;
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
      const connection = nextServerEvent(server, 'connection');
      const socket = await openTcp(port);

      socket.on('error', () => {});
      socket.write(upgradeRequest());

      const [, connectionHandle] = await connection;
      const closed = nextServerEvent(server, 'close');

      try {
        server.pause(connectionHandle);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        drop(socket);

        expect(await closed).toEqual([false, connectionHandle]);
      } finally {
        socket.destroy();
      }
    }
  });

  // spec 15.1 and 15.12: its socket's end, which ends a paused connection at once, drops nothing of
  // one not paused
  test('delivers each of 300 messages its peer sends in one write with its close and its end, then tells its close clean', async () => {
    await using started = await startDated({});
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange({ host, port }, encoder.encode(upgradeRequest()));
    const [, connectionHandle] = await connection;
    const closed = nextServerEvent(server, 'close');
    const delivered: Uint8Array[] = [];
    const frames = Array.from({ length: 300 }, (_, index) => {
      return {
        fin: true,
        opcode: OPCODES.BINARY,
        payload: Uint8Array.of(index >> 8, index & 0xff),
      };
    });

    server.on('message', ({ data }) => {
      delivered.push(new Uint8Array(data as ArrayBuffer));
    });

    try {
      exchange.send([
        ...frames,
        { fin: true, opcode: OPCODES.CLOSE, payload: Uint8Array.of(0x03, 0xe8) },
      ]);
      exchange.end();

      expect(await closed).toEqual([true, connectionHandle]);
      expect(delivered).toEqual(
        frames.map(({ payload }) => {
          return payload;
        })
      );
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3
  test('pings with 8 bytes of a count from 1, new at each ping, and drops a peer that answers with an empty pong or an earlier ping’s echo', async () => {
    await using started = await startDated({ heartbeat: 200 });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange(
      { answersPings: false, host, port },
      encoder.encode(upgradeRequest())
    );
    const [, connectionHandle] = await connection;
    const closed = nextServerEvent(server, 'close');
    const pongOf = (payload: Uint8Array) => {
      return { fin: true, opcode: OPCODES.PONG, payload };
    };
    const first = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1);

    try {
      expect(await exchange.next(2_000)).toEqual({ ping: first });
      exchange.send([pongOf(first)]);
      expect(await exchange.next(2_000)).toEqual({
        ping: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 2),
      });
      exchange.send([pongOf(new Uint8Array()), pongOf(first)]);
      expect(await exchange.next(2_000)).toEqual({ end: true });
      expect(await closed).toEqual([false, connectionHandle]);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3: the ping goes behind what its socket holds alone, so the 400 messages of 64 KiB the
  // transport holds pass what any loopback's buffers hold
  test('pings ahead of what it holds unsent, so a silent reader behind a backlog reads the ping before the backlog’s end and is kept', async () => {
    await using started = await startDated({
      heartbeat: 1_000,
      maximumUnsentBytes: 67_108_864,
      minimumSendBytesPerSecond: 0,
    });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const { socket } = await upgradeOn(port, upgradeRequest());
    const [, connectionHandle] = await connection;
    const closes: unknown[] = [];
    // what it read, in order, and what it has not read whole yet
    const order: string[] = [];
    let rest = Buffer.alloc(0);

    server.on('close', (wasClean, handle) => {
      closes.push([wasClean, handle]);
    });

    try {
      socket.pause();

      for (let index = 0; index < 400; index += 1) {
        void server.send({ data: new Uint8Array(65_536) }, connectionHandle);
      }

      // its ping out, a heartbeat and a half past its last read, .NET's keep-alive pinging up to a quarter
      // of a heartbeat late, it reads all, echoing the ping as it comes
      await sleep(1_500);
      socket.on('data', (chunk: Buffer) => {
        rest = Buffer.concat([rest, chunk]);

        for (;;) {
          const length = rest.length < 2 ? undefined : (rest[1] ?? 0) & 0x7f;
          const at = length === 126 ? 4 : length === 127 ? 10 : 2;

          // ! a chunk may end inside a header's extended length: read it once it is whole
          if (length === undefined || rest.length < at) {
            break;
          }

          const size =
            length === 126
              ? rest.readUInt16BE(2)
              : length === 127
                ? Number(rest.readBigUInt64BE(2))
                : length;

          if (rest.length < at + size) {
            break;
          }

          const opcode = (rest[0] ?? 0) & 0x0f;
          const payload = rest.subarray(at, at + size);

          if (opcode === OPCODES.PING) {
            order.push('ping');
            socket.write(maskedFrame(OPCODES.PONG, payload));
          } else {
            order.push(opcode === OPCODES.BINARY ? 'binary' : String(opcode));
          }

          rest = rest.subarray(at + size);
        }
      });
      socket.resume();

      await expect
        .poll(
          () => {
            return order.length;
          },
          { timeout: 10_000 }
        )
        .toBeGreaterThanOrEqual(401);

      const ping = order.indexOf('ping');

      expect([ping >= 0, ping < 400, order.length]).toEqual([true, true, 401]);

      // its echo read within its heartbeat: kept
      await sleep(1_200);
      expect(closes).toEqual([]);
    } finally {
      socket.destroy();
    }
  });

  // docs/support.md, "Leveled down": every side takes the echo alone, which waits behind the frame
  test('drops a peer whose echo waits behind a frame longer than its heartbeat, the echo alone answering its ping', async () => {
    await using started = await startDated({ heartbeat: 300 });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange(
      { answersPings: false, host, port },
      encoder.encode(upgradeRequest())
    );
    const [, connectionHandle] = await connection;
    const closed = nextServerEvent(server, 'close');

    try {
      const pinged = await exchange.next(2_000);

      expect(pinged).toEqual({ ping: expect.any(Uint8Array) as unknown });

      // a frame of 4,096 bytes in 16 parts, one every 30 ms, past its heartbeat, its echo after it
      const frame = frameOf({ fin: true, opcode: OPCODES.BINARY, payload: new Uint8Array(4_096) });
      const part = Math.ceil(frame.length / 16);

      for (let at = 0; at < frame.length; at += part) {
        exchange.write(frame.subarray(at, at + part));
        await sleep(30);
      }

      if (pinged !== undefined && 'ping' in pinged) {
        exchange.send([{ fin: true, opcode: OPCODES.PONG, payload: pinged.ping }]);
      }

      expect(await exchange.next(2_000)).toEqual({ end: true });
      expect(await closed).toEqual([false, connectionHandle]);
    } finally {
      exchange.destroy();
    }
  });

  test('drops a peer that never answers its pings and keeps one that does', async () => {
    // beats wide enough that a pong never misses one on a loaded machine
    const server = createWebSocketTransportServer({ heartbeat: 200, WebSocketServer });
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
      // three beats more, and the two that answer are still there
      await sleep(600);

      expect(closes).toEqual([false]);
      expect(server.clients).toHaveLength(2);
    } finally {
      await server.stop();
      await allClosed();
    }
  });

  test('ends a connection whose heartbeat’s drop throws, telling what it threw once and its close', async () => {
    const platform = createTestClock();
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      [PLATFORM]: platform,
      heartbeat: 20,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const told: unknown[] = [];

    server.on('error', (error, handle) => {
      told.push(['error', error.message, handle]);
    });
    server.on('close', (wasClean, handle) => {
      told.push(['close', wasClean, handle]);
    });

    // no ping answered, and a socket that never closes as it is terminated
    const silent = createFakeSocket({ onTerminate: 'throw' });
    const connectionHandle = fake.connect(silent, { server });

    // a ping, then its drop a heartbeat past it
    await platform.tickAsync(20);

    expect([silent.pings, silent.wasTerminated]).toEqual([1, false]);

    await platform.tickAsync(20);

    expect(silent.wasTerminated).toBe(true);
    expect(server.clients).toHaveLength(0);
    expect(told).toEqual([
      ['error', 'terminate refused', connectionHandle],
      ['close', false, connectionHandle],
    ]);

    // a socket that closes after its connection ended tells nothing more
    silent.hear('close', 1006);
    expect(told).toHaveLength(2);
    await server.stop();
  });
});

/** What the server answers `head` on a socket of its own, as `answerOf` reads it, and that socket's port. */
const answerFromOf = async (port: number, head: string) => {
  const socket = await openTcp(port);
  const { localPort } = socket;
  const answer = { isClosed: false, text: '' };

  socket.on('data', (chunk: Buffer) => {
    answer.text += chunk.toString('latin1');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    answer.isClosed = true;
  });
  socket.write(Buffer.from(head, 'latin1'));
  await expect
    .poll(() => {
      return answer.isClosed || answer.text.includes('\r\n\r\n');
    })
    .toBe(true);
  socket.destroy();

  return {
    answer: [
      Number(answer.text.split(' ')[1]),
      /bead-refusal: (?<mark>.*)\r\n/u.exec(answer.text)?.groups?.['mark'] ?? null,
    ],
    // the names of the fields its head carries, in lower case
    fields: answer.text
      .split('\r\n\r\n')[0]
      ?.split('\r\n')
      .slice(1)
      .map((line) => {
        return (line.split(':')[0] ?? '').toLowerCase();
      }),
    localPort,
  };
};

/** Each refusal `server` tells from now on. */
const refusalsOf = (server: WebSocketTransportServer) => {
  const refusals: ITransportServerRefusal[] = [];

  server.on('refusal', (refusal) => {
    refusals.push(refusal);
  });

  return refusals;
};

test.describe('WebSocketTransportServer, the refusals it tells', () => {
  test('tells each refusal it judges of its own, its status, its reason, the request’s authority and origin and the client’s address and port, and nothing of HTTP’s own, at its address', async () => {
    await using started = await startDated({ hosts: ['bead.test', host] });
    const { port, server } = started;
    const refusals = refusalsOf(server);
    const told = (
      localPort: number | undefined,
      refusal: Pick<ITransportServerRefusal, 'reason' | 'status'> & Partial<ITransportServerRefusal>
    ) => {
      return {
        address: host,
        authority: 'bead.test',
        origin: undefined,
        port: localPort,
        ...refusal,
      };
    };
    const expected: unknown[] = [];
    const own = `${host}:${String(port)}`;

    // each refusal of its own, in the order of its judgement, a CONNECT's among them
    for (const [request, refusal] of [
      [
        requestOf('GET / HTTP/1.1', [
          'Host: elsewhere.test:8080',
          'Origin: http://elsewhere.test:8080',
          'Origin: null',
        ]),
        {
          authority: 'elsewhere.test:8080',
          origin: 'http://elsewhere.test:8080, null',
          reason: 'host-refused',
          status: 403,
        },
      ],
      [
        requestOf('GET http://elsewhere.test:81/ HTTP/1.1', []),
        { authority: 'elsewhere.test:81', origin: undefined, reason: 'host-refused', status: 403 },
      ],
      [
        requestOf('POST / HTTP/1.1', []),
        { authority: 'bead.test', origin: undefined, reason: 'method-refused', status: 405 },
      ],
      [
        requestOf('CONNECT bead.test:80 HTTP/1.1', ['Host: bead.test:80']),
        { authority: 'bead.test:80', origin: undefined, reason: 'method-refused', status: 405 },
      ],
      [
        requestOf('GET / HTTP/1.1', [
          'Upgrade',
          'Connection',
          'Sec-WebSocket-Key',
          'Sec-WebSocket-Version',
        ]),
        { authority: 'bead.test', origin: undefined, reason: 'upgrade-required', status: 426 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 8']),
        { authority: 'bead.test', origin: undefined, reason: 'version-refused', status: 426 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: dGVzdA==']),
        { authority: 'bead.test', origin: undefined, reason: 'malformed', status: 400 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Origin: https://elsewhere.test']),
        {
          authority: 'bead.test',
          origin: 'https://elsewhere.test',
          reason: 'origin-refused',
          status: 403,
        },
      ],
      [
        requestOf('GET / HTTP/1.1', [
          'Host: rebind.example:8080',
          'Origin: http://a.example',
          'Origin: http://b.example',
        ]),
        {
          authority: 'rebind.example:8080',
          origin: 'http://a.example, http://b.example',
          reason: 'host-refused',
          status: 403,
        },
      ],
      [
        requestOf('GET http://rebind.example/ HTTP/1.1', [`Host: ${own}`]),
        { authority: 'rebind.example', origin: undefined, reason: 'host-refused', status: 403 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Host: ']),
        { authority: '', origin: undefined, reason: 'host-refused', status: 403 },
      ],
      [
        requestOf('GET / HTTP/1.0', [
          'Host',
          'Upgrade',
          'Connection',
          'Sec-WebSocket-Key',
          'Sec-WebSocket-Version',
        ]),
        { authority: undefined, origin: undefined, reason: 'host-refused', status: 403 },
      ],
      [
        requestOf('PUT / HTTP/1.1', [
          `Host: ${own}`,
          'Upgrade',
          'Connection',
          'Sec-WebSocket-Key',
          'Sec-WebSocket-Version',
          'Content-Length: 0',
        ]),
        { authority: own, origin: undefined, reason: 'method-refused', status: 405 },
      ],
      [
        requestOf('GET / HTTP/1.1', [
          `Host: ${own}`,
          'Upgrade',
          'Connection',
          'Sec-WebSocket-Key',
          'Sec-WebSocket-Version',
        ]),
        { authority: own, origin: undefined, reason: 'upgrade-required', status: 426 },
      ],
      [
        requestOf('GET / HTTP/1.1', [`Host: ${own}`, 'Sec-WebSocket-Version: 8']),
        { authority: own, origin: undefined, reason: 'version-refused', status: 426 },
      ],
      [
        requestOf('GET / HTTP/1.1', [`Host: ${own}`, 'Sec-WebSocket-Key']),
        { authority: own, origin: undefined, reason: 'malformed', status: 400 },
      ],
      [
        requestOf('GET / HTTP/1.1', [`Host: ${own}`, 'Origin: http://elsewhere.example']),
        {
          authority: own,
          origin: 'http://elsewhere.example',
          reason: 'origin-refused',
          status: 403,
        },
      ],
    ] as const) {
      const { answer, localPort } = await answerFromOf(port, request);

      expect(answer, request).toEqual([refusal.status, refusal.reason]);
      expected.push(told(localPort, refusal));
    }

    // what HTTP refuses of its own, told by none: two hosts, an octet past ASCII
    for (const request of [
      requestOf('GET / HTTP/1.1', ['Host: bead.test', 'Host: elsewhere.test']),
      requestOf('GET / HTTP/1.1', ['X-Other: café']),
      requestOf('GET / HTTP/1.1', ['Host: localhost:']),
      requestOf('GET / HTTP/1.1', ['Host: a.test', 'Host: b.test']),
      'GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n',
    ]) {
      expect((await answerFromOf(port, request)).answer, request).toEqual([400, null]);
    }

    // nor an upgrade it takes
    expect(await statusLineOf(port, requestOf('GET / HTTP/1.1'))).toBe(
      'HTTP/1.1 101 Switching Protocols'
    );
    expect(refusals).toEqual(expected);

    // the stop's 503, an upgrade's head in two writes, one each side of the stop
    const socket = await openTcp(port);
    const { localPort } = socket;
    const head = requestOf('GET / HTTP/1.1');
    const cut = head.indexOf('Sec-WebSocket-Version');
    let isClosed = false;

    socket.on('close', () => {
      isClosed = true;
    });
    socket.on('data', () => {});
    socket.write(head.slice(0, cut));
    await sleep(100);
    refusals.length = 0;
    await server.stop();
    socket.write(head.slice(cut));
    await expect
      .poll(() => {
        return isClosed;
      })
      .toBe(true);

    expect(refusals).toEqual([told(localPort, { reason: 'busy', status: 503 })]);
  });

  // spec 15.12
  test('takes a client’s address from X-Forwarded-For only from a proxy it names, and names its connection by it', async () => {
    await using behind = await startDated({ hosts: ['bead.test'], trustedProxies: ['127.0.0.1'] });
    // a peer no trustedProxies entry holds, the loopback here
    await using before = await startDated({
      hosts: ['bead.test'],
      trustedProxies: ['192.0.2.0/24'],
    });
    const sockets: Socket[] = [];
    // an upgrade carrying `forwarded`, taken: the handle its connection is named by, beside its
    // socket's own port, which the server sees as its peer's
    const drawOf = async (
      { port, server }: { port: number; server: WebSocketTransportServer },
      forwarded: string
    ) => {
      const connection = nextServerEvent(server, 'connection');
      const socket = await openTcp(port);

      sockets.push(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.write(requestOf('GET / HTTP/1.1', [`X-Forwarded-For: ${forwarded}`]));

      const [, connectionHandle] = await connection;

      return { connectionHandle, port: socket.localPort };
    };

    try {
      const walked = await drawOf(behind, '203.0.113.9, 198.51.100.7');
      // what is no address is not taken, nor what only a lenient parse reads as one
      const noAddress = await drawOf(behind, 'evil;ordinal=1');
      const lenient = await drawOf(behind, '1');
      // an IPv6 address as RFC 7239 writes a node, its port dropped, held as RFC 5952 writes it
      const bracketed = await drawOf(behind, '[2001:DB8::1]:443');
      // nor what a peer it does not name forwards
      const foreign = await drawOf(before, '192.0.2.1');

      expect(
        [walked, noAddress, lenient, bracketed, foreign].map(({ connectionHandle }) => {
          return connectionHandle;
        })
      ).toEqual([
        `type=WS;ip=198.51.100.7;port=${String(walked.port)};ordinal=1`,
        `type=WS;ip=${host};port=${String(noAddress.port)};ordinal=2`,
        `type=WS;ip=${host};port=${String(lenient.port)};ordinal=3`,
        `type=WS;ip=2001:db8::1;port=${String(bracketed.port)};ordinal=4`,
        `type=WS;ip=${host};port=${String(foreign.port)};ordinal=1`,
      ]);
      expect(
        [...behind.server.clients, ...before.server.clients].map(({ address, port }) => {
          return [address, port];
        })
      ).toEqual([
        ['198.51.100.7', walked.port],
        [host, noAddress.port],
        [host, lenient.port],
        ['2001:db8::1', bracketed.port],
        [host, foreign.port],
      ]);

      // and a refusal tells the client's address so read, its field's lines joined, beside the
      // socket's port; what is no address ends the walk at the proxy that wrote it
      const refusals = refusalsOf(behind.server);
      const lines = await answerFromOf(
        behind.port,
        requestOf('GET / HTTP/1.1', [
          'Host: rebind.example',
          'X-Forwarded-For: 203.0.113.9',
          'X-Forwarded-For: 198.51.100.7',
        ])
      );
      const unknown = await answerFromOf(
        behind.port,
        requestOf('GET / HTTP/1.1', ['Host: rebind.example', 'X-Forwarded-For: unknown'])
      );

      expect([lines.answer, unknown.answer]).toEqual([
        [403, 'host-refused'],
        [403, 'host-refused'],
      ]);
      expect(refusals).toEqual([
        {
          address: '198.51.100.7',
          authority: 'rebind.example',
          origin: undefined,
          port: lines.localPort,
          reason: 'host-refused',
          status: 403,
        },
        {
          address: host,
          authority: 'rebind.example',
          origin: undefined,
          port: unknown.localPort,
          reason: 'host-refused',
          status: 403,
        },
      ]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  });

  test('answers 400 unmarked, with none of the path’s fields, a field holding a control character other than HTAB or an octet past ASCII, and tells nothing', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const refusals = refusalsOf(server);
    // in Origin and in a field the transport never reads: an escape sequence, BEL, DEL, and an
    // octet past ASCII, written as the one octet 0xE9; Node's parser answers the first three
    const fields = [
      'Origin: http://a.example\u001B[2J',
      'X-Other: a\u0007b',
      'Origin: http://a.example\u007F',
      'Origin: http://café.example',
      'X-Other: café',
      'X-Other: caf\u00c3\u00a9',
    ];

    for (const field of fields) {
      const request = requestOf('GET / HTTP/1.1', [field]);
      const { answer, fields: names } = await answerFromOf(port, request);

      expect(answer, request).toEqual([400, null]);
      // none of what a refusal of the server's own carries
      expect(
        names?.filter((name) => {
          return ['cache-control', 'vary', 'x-content-type-options'].includes(name);
        }),
        request
      ).toEqual([]);
    }

    expect([refusals, server.clients]).toEqual([[], []]);

    // a tab is taken, and the origin judged as any other
    const tabbed = await answerFromOf(
      port,
      requestOf('GET / HTTP/1.1', ['Origin: http://a.example\tb'])
    );

    expect(tabbed.answer).toEqual([403, 'origin-refused']);
    expect(refusals).toEqual([
      {
        address: host,
        authority: 'bead.test',
        origin: 'http://a.example\tb',
        port: tabbed.localPort,
        reason: 'origin-refused',
        status: 403,
      },
    ]);
    expect(server.clients).toEqual([]);
  });

  test('refuses as it would though a refusal listener throws, the throw reported with no connection', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const errors: ServerEvents['error'][] = [];

    server.on('refusal', () => {
      throw new Error('a refusal listener that throws');
    });

    // a listener after it is told all the same
    const after = refusalsOf(server);

    server.on('error', (...params) => {
      errors.push(params);
    });

    expect(
      (await answerFromOf(port, requestOf('GET / HTTP/1.1', ['Host: elsewhere.test']))).answer
    ).toEqual([403, 'host-refused']);
    expect((await answerFromOf(port, requestOf('POST / HTTP/1.1'))).answer).toEqual([
      405,
      'method-refused',
    ]);
    expect(after).toHaveLength(2);
    expect(
      errors.map(([error, connectionHandle]) => {
        return [error.message, connectionHandle];
      })
    ).toEqual([
      ['a refusal listener that throws', ''],
      ['a refusal listener that throws', ''],
    ]);
    // and it upgrades as before
    expect(await statusLineOf(port, requestOf('GET / HTTP/1.1'))).toBe(
      'HTTP/1.1 101 Switching Protocols'
    );
  });
});

test.describe('WebSocketTransportServer, the address it listens on', () => {
  test('listens on localhost, port 80, and pings once silent for 30 seconds when told nothing', async () => {
    const platform = createTestClock();
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({
      [PLATFORM]: platform,
      WebSocketServer: fake.FakeWebSocketServer,
    });

    expect([server.address, server.port, START_DEFAULTS]).toEqual([
      'localhost',
      80,
      { address: 'localhost', findOpenPort: false, port: 80 },
    ]);
    expect([HEARTBEAT, CLOSE_TIMEOUT, MAXIMUM_MESSAGE_BYTES]).toEqual([30_000, 5_000, 16_778_240]);

    const starting = server.start({ findOpenPort: true });

    await fake.listenEach(2);
    await starting;

    const before = platform.armed.length;

    fake.connect(createFakeSocket(), { server });

    expect([
      server.address,
      platform.armed.slice(before).map(({ delay }) => {
        return delay;
      }),
    ]).toEqual(['localhost', [30_000]]);

    await server.stop();
  });

  test('listens on localhost when given no address, both loopbacks on one port, reached by 127.0.0.1, by the IPv6 loopback and by localhost, reports localhost, and is secure there', async () => {
    const server = createWebSocketTransportServer({ WebSocketServer });
    const clients: WebSocketTransportClient[] = [];

    try {
      const { address, port } = await server.start({ findOpenPort: true });

      expect([address, server.address]).toEqual(['localhost', 'localhost']);

      for (const name of [host, '::1', 'localhost']) {
        const client = createWebSocketTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

        clients.push(client);
        await client.connect({ host: name, port });
        expect(client.isOpen()).toBe(true);
      }

      expect(
        server.clients.map(({ address: from, connectionHandle }) => {
          return [from, server.isSecure(connectionHandle)];
        })
      ).toEqual([
        ['127.0.0.1', true],
        ['::1', true],
        [expect.stringMatching(/^(?:127\.0\.0\.1|::1)$/u), true],
      ]);
    } finally {
      for (const client of clients) {
        await client.disconnect().catch(() => {});
      }

      await server.stop();
      await allClosed();
    }

    // both let go
    expect(await isFreeOn('::1', server.port)).toBe(true);
  });

  test('refuses to start on localhost when another socket holds the other loopback’s port, ending closed', async () => {
    await using held = await holdIPv6Loopback();
    const server = createWebSocketTransportServer({ WebSocketServer });

    await expect(server.start({ port: held.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // the IPv4 loopback's port let go
    expect([server.isClosed(), await isFreeOn(host, held.port)]).toEqual([true, true]);
  });

  test('draws a port on localhost again when the IPv6 loopback holds the one drawn on IPv4', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start({ findOpenPort: true });

    // the port drawn on 127.0.0.1 is held on ::1: both let go, and a pair bound again
    await fake.listenEach(1);
    (await fake.builtAt(1))?.emit('error', bindError('EADDRINUSE'));
    await fake.listenEach(2, 2);

    expect(await starting).toEqual({ address: 'localhost', port: 50_000 });
    expect(
      fake.instances.map(({ listened }) => {
        return listened;
      })
    ).toEqual([
      [0, host],
      [50_000, '::1'],
      [0, host],
      [50_000, '::1'],
    ]);
    expect(
      fake.instances.map(({ closeCount }) => {
        return closeCount;
      })
    ).toEqual([1, 1, 0, 0]);
    await server.stop();
    expect(
      fake.instances.map(({ closeCount }) => {
        return closeCount;
      })
    ).toEqual([1, 1, 1, 1]);

    // eight draws at most, then the last error
    const held = createFakeWebSocketServer();
    const refused = createWebSocketTransportServer({ WebSocketServer: held.FakeWebSocketServer });
    const refusing = refused.start({ findOpenPort: true });

    for (let draw = 0; draw < 8; draw += 1) {
      await held.listenEach(1, draw * 2);
      (await held.builtAt(draw * 2 + 1))?.emit('error', bindError('EADDRINUSE'));
    }

    await expect(refusing).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect([refused.isClosed(), held.instances.length]).toEqual([true, 16]);
    expect(
      held.instances.map(({ closeCount }) => {
        return closeCount;
      })
    ).toEqual(
      Array.from({ length: 16 }, () => {
        return 1;
      })
    );

    // a port it was given is never drawn again
    const given = createFakeWebSocketServer();
    const fixed = createWebSocketTransportServer({ WebSocketServer: given.FakeWebSocketServer });
    const fixing = fixed.start({ port: 4_321 });

    await given.listenEach(1);
    (await given.builtAt(1))?.emit('error', bindError('EADDRINUSE'));

    await expect(fixing).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect([fixed.isClosed(), given.instances.length]).toEqual([true, 2]);
    expect(
      given.instances.map(({ closeCount }) => {
        return closeCount;
      })
    ).toEqual([1, 1]);
  });

  test('listens on 127.0.0.1 alone where the IPv6 loopback is absent, and reports 127.0.0.1', async () => {
    for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
      const fake = createFakeWebSocketServer();
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
      const starting = server.start({ findOpenPort: true });

      await fake.listenEach(1);
      (await fake.builtAt(1))?.emit('error', bindError(code));

      expect([code, await starting, server.address]).toEqual([
        code,
        { address: '127.0.0.1', port: 50_000 },
        '127.0.0.1',
      ]);
      expect(
        fake.instances.map(({ listened }) => {
          return listened;
        })
      ).toEqual([
        [0, host],
        [50_000, '::1'],
      ]);
      // the IPv6 one let go, the IPv4 one serving, secure there
      expect([
        fake.instances[0]?.closeCount,
        fake.instances[1]?.closeCount,
        server.isSecure(fake.connect(createFakeSocket(), { server })),
      ]).toEqual([0, 1, true]);
      await server.stop();
    }

    // on real sockets: its IPv4 loopback reached, the IPv6 loopback's port left alone where it is
    const isIPv6 = await hasIPv6Loopback();

    for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
      const server = createWebSocketTransportServer({
        WebSocketServer: createRefusingWebSocketServer('::1', bindError(code)),
      });
      const client = createWebSocketTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

      try {
        const { address, port } = await server.start({ findOpenPort: true });

        await client.connect({ host, port });

        expect([
          code,
          address,
          server.address,
          client.isOpen(),
          server.isSecure(server.clients[0]!.connectionHandle),
          await isFreeOn('::1', port),
        ]).toEqual([code, '127.0.0.1', '127.0.0.1', true, true, isIPv6]);
      } finally {
        await client.disconnect().catch(() => {});
        await server.stop();
        await allClosed();
      }
    }
  });

  test('refuses to start on an address that is no bare IP address, ending closed', async () => {
    const startedOn = async (address: string) => {
      const fake = createFakeWebSocketServer({ address: { address, port: 4_321 } });
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
      const outcome = server.start({ address, findOpenPort: true }).then(
        () => {
          return 'listening';
        },
        (reason: unknown) => {
          return reason instanceof ProgrammerError ? reason.message : String(reason);
        }
      );

      // localhost binds both loopbacks
      if (server.isConnecting()) {
        await fake.listenEach(LISTENING_NAMES.includes(address) ? 2 : 1);
      }

      const told = await outcome;

      await server.stop();

      // a server refused opened nothing
      return [address, told, server.isClosed(), fake.instances.length];
    };

    expect(await Promise.all(LISTENING_ADDRESSES.map(startedOn))).toEqual(
      LISTENING_ADDRESSES.map((address) => {
        return [address, 'listening', true, 1];
      })
    );
    expect(await Promise.all(LISTENING_NAMES.map(startedOn))).toEqual(
      LISTENING_NAMES.map((address) => {
        return [address, 'listening', true, 2];
      })
    );
    expect(await Promise.all(NO_LISTENING_ADDRESSES.map(startedOn))).toEqual(
      NO_LISTENING_ADDRESSES.map((address) => {
        return [
          address,
          address === '[::1]'
            ? 'a server listens on an IP address, or on localhost, both loopbacks, not "[::1]": write ::1, not [::1]'
            : `a server listens on an IP address, or on localhost, both loopbacks, not "${address}"`,
          true,
          0,
        ];
      })
    );
  });

  test('is secure on the IPv6 loopback or an address in 127.0.0.0/8, and not on a wildcard', async () => {
    const securedOn = async (address: string) => {
      const fake = createFakeWebSocketServer({ address: { address, port: 4_321 } });
      const server = createWebSocketTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
      const starting = server.start({ address, findOpenPort: true });

      fake.instances[0]?.emit('listening');
      await starting;

      try {
        return [address, server.isSecure(fake.connect(createFakeSocket(), { server }))];
      } finally {
        await server.stop();
      }
    };

    expect(
      await Promise.all(['::1', '127.0.0.1', '127.0.0.2', '0.0.0.0', '::'].map(securedOn))
    ).toEqual([
      ['::1', true],
      ['127.0.0.1', true],
      ['127.0.0.2', true],
      ['0.0.0.0', false],
      ['::', false],
    ]);
  });
});

/**
 * An upgrade `head` on a socket of its own, kept open: its status once its head came, and the
 * socket, which reads on in silence, or not at all once paused.
 */
const upgradeOn = async (port: number, head: string) => {
  const socket = await openTcp(port);
  let text = '';

  socket.on('data', (chunk: Buffer) => {
    if (!text.includes('\r\n\r\n')) {
      text += chunk.toString('latin1');
    }
  });
  socket.on('error', () => {});
  socket.write(head);
  await expect
    .poll(() => {
      return text.includes('\r\n\r\n') || socket.destroyed;
    })
    .toBe(true);

  return { socket, status: text.split('\r\n')[0], text };
};

test.describe('WebSocketTransportServer, its bounds', () => {
  test('bounds its connections, and those of one address, refusing an upgrade past them 503 busy before its 101, with Retry-After, and takes one once a connection closes', async () => {
    await using started = await startDated({
      hosts: ['bead.test'],
      maximumConnections: 2,
      maximumConnectionsPerAddress: 1,
      trustedProxies: ['127.0.0.1'],
    });
    const { port, server } = started;
    const refusals: ITransportServerRefusal[] = [];
    const from = (address: string) => {
      return requestOf('GET / HTTP/1.1', [`X-Forwarded-For: ${address}`]);
    };

    server.on('refusal', (refusal) => {
      refusals.push(refusal);
    });

    const first = await upgradeOn(port, from('192.0.2.1'));
    // its address holds its one place, whatever its socket
    const again = await upgradeOn(port, from('192.0.2.1'));
    const other = await upgradeOn(port, from('192.0.2.2'));
    // every place taken
    const third = await upgradeOn(port, from('192.0.2.3'));

    expect([first.status, again.status, other.status, third.status]).toEqual([
      'HTTP/1.1 101 Switching Protocols',
      'HTTP/1.1 503 Service Unavailable',
      'HTTP/1.1 101 Switching Protocols',
      'HTTP/1.1 503 Service Unavailable',
    ]);
    expect(again.text).toContain('\r\nretry-after: 1\r\n');
    expect(again.text).toContain('\r\nbead-refusal: busy\r\n');
    expect(
      refusals.map(({ address, reason, status }) => {
        return [status, reason, address];
      })
    ).toEqual([
      [503, 'busy', '192.0.2.1'],
      [503, 'busy', '192.0.2.3'],
    ]);
    expect(server.gauges()).toMatchObject({
      ceilings: { connections: 2, largestAddressConnections: 1 },
      counts: { connections: 2, largestAddressConnections: 1 },
    });

    // a connection gone gives its place back
    first.socket.destroy();
    await expect
      .poll(() => {
        return server.clients.length;
      })
      .toBe(1);

    const back = await upgradeOn(port, from('192.0.2.1'));

    expect(back.status).toBe('HTTP/1.1 101 Switching Protocols');

    for (const { socket } of [again, other, third, back]) {
      socket.destroy();
    }
  });

  test('gives back the place of a connection whose drop throws before its close is told, and ends its TCP connection', async () => {
    // `ws`'s own server, whose sockets send no close and throw as they are terminated
    const StubbornWebSocketServer = class extends WebSocketServer {
      constructor(options: ServerOptions) {
        super(options);
        this.on('connection', (socket: WsWebSocket) => {
          socket.close = () => {};
          socket.terminate = () => {
            throw new Error('terminate refused');
          };
        });
      }
    };
    const server = createWebSocketTransportServer({
      closeTimeout: 50,
      heartbeat: Infinity,
      maximumConnectionsPerAddress: 1,
      WebSocketServer: StubbornWebSocketServer,
    });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const told: unknown[] = [];

    try {
      server.on('error', (error, handle) => {
        told.push(['error', error.message, handle]);
      });
      // the places its address holds as its close is told
      server.on('close', (wasClean, handle) => {
        told.push(['close', wasClean, handle, server.gauges().counts['largestAddressConnections']]);
      });

      const connection = nextServerEvent(server, 'connection');
      const first = await upgradeOn(port, upgradeRequest());
      const [, connectionHandle] = await connection;

      // its close never goes out, and its drop at the close timeout throws
      await expect(server.close(connectionHandle)).resolves.toBe(true);

      expect(told).toEqual([
        ['error', 'terminate refused', connectionHandle],
        ['close', false, connectionHandle, 0],
      ]);
      // its TCP connection ended by the server
      await expect
        .poll(() => {
          return first.socket.closed;
        })
        .toBe(true);

      // its address's one place is free again
      const again = await upgradeOn(port, upgradeRequest());

      expect(again.status).toBe('HTTP/1.1 101 Switching Protocols');
      again.socket.destroy();
    } finally {
      await server.stop();
      await allClosed();
    }
  });

  test('takes no more upgrades than its places when they cross', async () => {
    await using started = await startDated({ hosts: ['bead.test'], maximumConnections: 4 });
    const { port } = started;
    const sockets = await Promise.all(
      Array.from({ length: 16 }, () => {
        return openTcp(port);
      })
    );
    const answers = sockets.map(() => {
      return { text: '' };
    });

    for (const [index, socket] of sockets.entries()) {
      socket.on('data', (chunk: Buffer) => {
        const answer = answers[index];

        if (answer !== undefined && !answer.text.includes('\r\n\r\n')) {
          answer.text += chunk.toString('latin1');
        }
      });
      socket.on('error', () => {});
    }

    // every head written in one turn: they cross at the server
    for (const socket of sockets) {
      socket.write(requestOf('GET / HTTP/1.1'));
    }

    await expect
      .poll(() => {
        return answers.every(({ text }) => {
          return text.includes('\r\n\r\n');
        });
      })
      .toBe(true);

    const statuses = answers.map(({ text }) => {
      return text.split(' ')[1];
    });

    expect(
      statuses.filter((status) => {
        return status === '101';
      })
    ).toHaveLength(4);
    expect(
      statuses.filter((status) => {
        return status === '503';
      })
    ).toHaveLength(12);

    for (const socket of sockets) {
      socket.destroy();
    }
  });

  test('refuses a maximumConnections or a maximumConnectionsPerAddress that is not a whole number above 0', () => {
    for (const name of ['maximumConnections', 'maximumConnectionsPerAddress'] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
        expect(
          () => {
            return createWebSocketTransportServer({ [name]: value, WebSocketServer });
          },
          `${name} ${String(value)}`
        ).toThrow(new ProgrammerError(`${name} is a whole number above 0, not ${String(value)}`));
      }
    }
  });

  test('keeps a client that reads through a burst of answers to the calls it has it answer, each of chunkBytes', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const client = new WsClient(`ws://${host}:${String(port)}`);
    const errors: unknown[] = [];
    let received = 0;
    let largest = 0;

    server.on('error', (error) => {
      errors.push(error);
    });
    client.on('message', () => {
      received += 1;
    });

    const [, connectionHandle] = await connection;

    // an answer of a chunk to each of the 64 calls its peer may have it answer, in one turn
    for (let index = 0; index < 64; index += 1) {
      void server.send({ data: new Uint8Array(1_048_576) }, connectionHandle);
      largest = Math.max(largest, server.gauges().counts['largestUnsentBytes'] ?? 0);
    }

    await expect
      .poll(
        () => {
          return received;
        },
        { timeout: 15_000 }
      )
      .toBe(64);

    // far past what a bound judged at once would have let wait, and kept all the same
    expect(largest).toBeGreaterThan(33_556_480);
    expect([errors, server.clients.length]).toEqual([[], 1]);
    client.close();
  });

  // spec 15.12.11 and 15.12.12
  test('drops a client that stops reading once its socket holds what waits for it past its deadline, and reports it', async () => {
    await using started = await startDated({
      heartbeat: Infinity,
      minimumSendBytesPerSecond: 100_000_000,
      sendGracePeriod: 200,
    });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const { socket } = await upgradeOn(port, upgradeRequest());
    const [, connectionHandle] = await connection;
    const reported = nextServerEvent(server, 'error');
    const closed = nextServerEvent(server, 'close');

    // it reads nothing more: what the platform does not hold waits for its socket
    socket.pause();

    for (let index = 0; index < 32; index += 1) {
      void server.send({ data: new Uint8Array(1_048_576) }, connectionHandle);
    }

    const [error, reportedHandle] = await reported;

    expect([reportedHandle, error.message]).toEqual([
      connectionHandle,
      `${connectionHandle} is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 100000000 past sendGracePeriod 200 ms`,
    ]);
    expect(await closed).toEqual([false, connectionHandle]);
    socket.destroy();
  });

  // spec 15.12.13
  test('drops a client once what waits for it would pass maximumUnsentBytes, the bytes it holds never past them, its close unclean, and reports it', async () => {
    await using started = await startDated({
      heartbeat: Infinity,
      maximumUnsentBytes: 65_536,
      minimumSendBytesPerSecond: 0,
    });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const { socket } = await upgradeOn(port, upgradeRequest());
    const [, connectionHandle] = await connection;
    const reported: unknown[] = [];
    const closes: unknown[] = [];
    let largest = 0;

    server.on('error', (error, handle) => {
      reported.push([handle, error.message]);
    });
    server.on('close', (wasClean, handle) => {
      closes.push([wasClean, handle]);
    });
    socket.pause();

    // until it is dropped, what waits sampled after each send; the platform's buffers fill first
    for (let index = 0; index < 8_192 && closes.length === 0; index += 1) {
      await server.send({ data: new Uint8Array(16_384) }, connectionHandle);
      largest = Math.max(largest, server.gauges().counts['largestUnsentBytes'] ?? 0);
      await sleep(0);
    }

    await expect
      .poll(() => {
        return closes;
      })
      .toEqual([[false, connectionHandle]]);
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(65_536);
    expect(reported).toEqual([
      [
        connectionHandle,
        `${connectionHandle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
      ],
    ]);
    socket.destroy();
  });

  // spec 15.1
  test('closes with 1009, and drops behind maximumUnsentBytes, a connection whose error listener throws, telling its close all the same and dropping what it threw', async () => {
    using uncaught = trapUncaught();
    await using started = await startDated({
      heartbeat: Infinity,
      maxPayload: 64,
      maximumUnsentBytes: 65_536,
      minimumSendBytesPerSecond: 0,
    });
    const { port, server } = started;
    const reported: string[] = [];
    const heard: string[] = [];
    const closes: unknown[] = [];

    server.on('error', (error) => {
      reported.push(error.message);

      throw new Error('an error listener that throws');
    });
    server.on('error', (error) => {
      heard.push(error.message);
    });
    server.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });

    // past its message bound: closed with 1009 all the same
    const tooBigConnection = nextServerEvent(server, 'connection');
    const tooBig = new WsClient(`ws://${host}:${String(port)}`);

    tooBig.on('error', () => {});
    await once(tooBig, 'open');

    const [, tooBigHandle] = await tooBigConnection;
    const tooBigClosed = once(tooBig, 'close');

    tooBig.send(new Uint8Array(100));

    expect((await tooBigClosed)[0]).toBe(1009);
    await expect
      .poll(() => {
        return closes;
      })
      .toEqual([[false, tooBigHandle]]);

    // behind maximumUnsentBytes: dropped all the same
    const behindConnection = nextServerEvent(server, 'connection');
    const { socket } = await upgradeOn(port, upgradeRequest());
    const [, behindHandle] = await behindConnection;

    socket.pause();

    for (let index = 0; index < 8_192 && closes.length === 1; index += 1) {
      await server.send({ data: new Uint8Array(16_384) }, behindHandle);
      await sleep(0);
    }

    await expect
      .poll(() => {
        return closes;
      })
      .toEqual([
        [false, tooBigHandle],
        [false, behindHandle],
      ]);
    // * what the listener threw is dropped: the listener after it told each error, and nothing else
    expect([reported, heard]).toEqual([
      [
        `${tooBigHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
        `${behindHandle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
      ],
      [
        `${tooBigHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
        `${behindHandle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
      ],
    ]);
    expect([uncaught.thrown, server.clients]).toEqual([[], []]);
    socket.destroy();
  });

  test('refuses a maximumUnsentBytes, a minimumSendBytesPerSecond or a sendGracePeriod it cannot hold, as it is built', () => {
    for (const [options, refusal] of [
      [{ maximumUnsentBytes: 0 }, 'maximumUnsentBytes is a whole number above 0, not 0'],
      [{ minimumSendBytesPerSecond: -1 }, 'minimumSendBytesPerSecond is a whole number, not -1'],
      [
        { sendGracePeriod: Infinity },
        'sendGracePeriod is a number of milliseconds from 1 to 2147483647, not Infinity',
      ],
    ] as const) {
      expect(() => {
        return createWebSocketTransportServer({ ...options, WebSocketServer });
      }).toThrow(new ProgrammerError(refusal));
    }
  });
});

test.describe('WebSocketTransportServer, a connection its router paused', () => {
  // spec 15.12.17
  test('reads no message of a paused connection, holds the rest of its read, and hands it in order once resumed', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const client = new WsClient(`ws://${host}:${String(port)}`);
    const heard: number[] = [];

    await once(client, 'open');

    const [{ socket }, connectionHandle] = await connection;

    server.on('message', ({ data }) => {
      heard.push(new DataView(data as ArrayBuffer).getUint32(0));

      // * a router at its bound pauses within the hand, ws emitting the rest of its read
      if (heard.length === 3) {
        server.pause(connectionHandle);
      }
    });

    // many messages, coalesced into the reads of its socket
    for (let index = 0; index < 2_000; index += 1) {
      const bytes = new Uint8Array(4);

      new DataView(bytes.buffer).setUint32(0, index);
      client.send(bytes);
    }

    await expect
      .poll(() => {
        return heard.length;
      })
      .toBe(3);
    await sleep(100);

    // its socket read no more, and what ws emitted of the read under way was held
    expect([heard.length, (socket as unknown as WsWebSocket).isPaused]).toEqual([3, true]);

    server.resume(connectionHandle);

    await expect
      .poll(() => {
        return heard.length;
      })
      .toBe(2_000);
    expect(heard).toEqual(
      Array.from({ length: 2_000 }, (_, index) => {
        return index;
      })
    );
    expect((socket as unknown as WsWebSocket).isPaused).toBe(false);
    client.close();
  });

  // spec 15.12.17; RFC 6455 §7.1.1
  test('a paused connection closes cleanly', async () => {
    await using started = await startDated({ closeTimeout: 2_000, heartbeat: Infinity });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const client = new WsClient(`ws://${host}:${String(port)}`);
    const heard: unknown[] = [];

    await once(client, 'open');

    const [{ socket }, connectionHandle] = await connection;
    const codes = new Promise<number>((resolve) => {
      (socket as unknown as WsWebSocket).once('close', (code: number) => {
        resolve(code);
      });
    });

    server.on('message', ({ data }) => {
      heard.push(data);
    });
    server.pause(connectionHandle);
    client.send(new Uint8Array(4));
    await sleep(50);

    const closed = nextServerEvent(server, 'close');
    const startedAt = performance.now();

    const closing = server.close(connectionHandle);

    // a pause its router asks as it closes is let be
    server.pause(connectionHandle);
    await closing;

    // * it read its peer's Close, its own pause opened: clean, long before its close timeout
    expect(await codes).toBe(1000);
    expect(await closed).toEqual([true, connectionHandle]);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    // what it held dropped with it
    expect(heard).toEqual([]);
  });
});

// * the head is Node's to read: what it takes, waits for and refuses, as the Rust side's own read
test.describe('WebSocketTransportServer, the head it reads', () => {
  test('reads a head whole, its method, its target and its fields as they came, an octet past ASCII refused 400 unmarked', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const connection = nextServerEvent(server, 'connection');
    const opened = await answerFromOf(
      port,
      requestOf('GET /bead?x=1 HTTP/1.1', ['X-Other:  caf\t'])
    );
    const [{ request }] = await connection;

    expect([opened.answer, request.method, request.url]).toEqual([[101, null], 'GET', '/bead?x=1']);
    expect(
      (await answerFromOf(port, requestOf('GET / HTTP/1.1', ['X-Other: café']))).answer
    ).toEqual([400, null]);
  });

  // spec 15.2, 15.12; RFC 9110 §8.6
  test('answers 400 unmarked a Content-Length past 2⁶³ − 1, before its host is judged, and closes its connection', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });

    // 2⁶³ − 1 is a length: the host is judged
    expect(
      (
        await answerFromOf(
          started.port,
          requestOf('GET / HTTP/1.1', [
            'Host: elsewhere.test',
            'Connection: close',
            'Content-Length: 9223372036854775807',
          ])
        )
      ).answer
    ).toEqual([403, 'host-refused']);

    // 2⁶³, in 19 digits and in 23; 19 nines; 2⁶⁴ − 2 and 2⁶⁴ − 1, which Node's parser hands on; and
    // 2⁶⁴ and 23 nines, which it answers itself; each on an upgrade from a host it does not take
    const answers: unknown[] = [];

    for (const length of [
      '9223372036854775808',
      '00009223372036854775808',
      '9'.repeat(19),
      '18446744073709551614',
      '18446744073709551615',
      '18446744073709551616',
      '9'.repeat(23),
    ]) {
      answers.push(
        await closingAnswerOf(
          started.port,
          requestOf('GET / HTTP/1.1', ['Host: elsewhere.test', `Content-Length: ${length}`])
        )
      );
    }

    expect(answers).toEqual(
      Array.from({ length: 7 }, () => {
        return [400, null];
      })
    );
    expect(started.server.clients).toEqual([]);
  });

  test('waits for a head not whole', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const whole = requestOf('GET / HTTP/1.1');
    const socket = await openTcp(port);
    let answer = '';

    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
    });
    socket.write(whole.slice(0, -1));
    await sleep(200);

    expect([answer, server.clients]).toEqual(['', []]);
    socket.write(whole.slice(-1));
    await expect
      .poll(() => {
        return answer.split('\r\n')[0];
      })
      .toBe('HTTP/1.1 101 Switching Protocols');
    socket.destroy();
  });

  test('answers 408 a head that did not come within its headers timeout, unmarked', async () => {
    await using started = await startDated({ headersTimeout: 100, hosts: ['bead.test'] });
    const { port, server } = started;
    const refusals = refusalsOf(server);
    const { answer } = await answerFromOf(port, 'GET / HTTP/1.1\r\nHost: bead.test\r\n');

    expect([answer, refusals]).toEqual([[408, null], []]);
  });

  test('refuses 431 a head past 16 KiB, its request line among it, as Node’s maxHeaderSize bounds it, and takes 101 fields', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port } = started;
    const length = requestOf('GET / HTTP/1.1').length;
    const padded = (total: number) => {
      return requestOf('GET / HTTP/1.1', [`X-Pad: ${'a'.repeat(total - length - 9)}`]);
    };
    const fields = Array.from({ length: 96 }, (_, index) => {
      return `X-${String(index)}: ${String(index)}`;
    });

    expect((await answerFromOf(port, padded(16_384))).answer).toEqual([101, null]);
    expect((await answerFromOf(port, padded(16_640))).answer).toEqual([431, null]);
    expect(
      (await answerFromOf(port, requestOf(`GET /${'a'.repeat(16_640)} HTTP/1.1`))).answer
    ).toEqual([431, null]);
    expect((await answerFromOf(port, requestOf('GET / HTTP/1.1', fields))).answer).toEqual([
      101,
      null,
    ]);
  });

  test('refuses 400 a head HTTP does not read, a control character in its target or a value among it, and answers a version but 1.1 426 upgrade-required', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    const { port, server } = started;
    const answers: unknown[] = [];

    for (const malformed of [
      requestOf('GET /a\u0001b HTTP/1.1'),
      requestOf('GET /a\u007fb HTTP/1.1'),
      requestOf('GET /a b HTTP/1.1'),
      requestOf('GET / HTTP/1.1', ['X-Other: a\u0007b']),
      requestOf('GET / HTTP/1.1').replace('\r\n\r\n', '\r\nno colon\r\n\r\n'),
      requestOf('GET / HTTP/1.1', ['bad name: x']),
      requestOf('G(T / HTTP/1.1'),
    ]) {
      answers.push((await answerFromOf(port, malformed)).answer);
    }

    expect(answers).toEqual(
      Array.from({ length: 7 }, () => {
        return [400, null];
      })
    );
    expect((await answerFromOf(port, requestOf('GET / HTTP/2.0'))).answer).toEqual([
      426,
      'upgrade-required',
    ]);
    expect(server.clients).toHaveLength(0);
  });
});

test('dispose stops it closing with 1001 and refusing what comes after', async () => {
  const server = createWebSocketTransportServer({ WebSocketServer });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const socket = new WsClient(`ws://${host}:${String(port)}`);

  try {
    await once(socket, 'open');
    const closing = once(socket, 'close');

    await server[Symbol.asyncDispose]();

    expect((await closing)[0]).toBe(1001);
    await expect(server.start({ address: host, findOpenPort: true })).rejects.toThrow();
    expect(server.isClosed()).toBe(true);
  } finally {
    socket.terminate();
    await server[Symbol.asyncDispose]();
  }
});

// * a message partway, read below `ws` by the frame meter: its frames judged at their heads (spec
// 15.3), its bytes charged to the budget and held to its rate (spec 15.12), decision 0056
test.describe('WebSocketTransportServer, a message partway', () => {
  // a connection over a socket of the test's, its upgrade answered, and its handle
  const connectOn = async ({
    port,
    server,
  }: {
    port: number;
    server: WebSocketTransportServer;
  }) => {
    const connection = nextServerEvent(server, 'connection');
    const exchange = openExchange({ host, port }, encoder.encode(upgradeRequest()));
    const [, connectionHandle] = await connection;

    return { connectionHandle, exchange };
  };

  // what the server tells, each error and close by its connection's handle
  const toldOf = (server: WebSocketTransportServer) => {
    const told: string[] = [];

    server.on('error', (error, connectionHandle) => {
      told.push(`error: ${error.message}${connectionHandle === '' ? ' (no connection)' : ''}`);
    });
    server.on('close', (wasClean, connectionHandle) => {
      told.push(`${wasClean ? 'clean close' : 'close'}: ${connectionHandle}`);
    });

    return told;
  };

  // the messages the server hands on, as text, or a binary one by its length
  const heardOf = (server: WebSocketTransportServer) => {
    const heard: string[] = [];

    server.on('message', ({ data }) => {
      heard.push(
        typeof data === 'string' ? data : `${String((data as ArrayBuffer).byteLength)} bytes`
      );
    });

    return heard;
  };

  // the bytes of messages partway the server holds
  const chargedOf = (server: WebSocketTransportServer): number | undefined => {
    return server.gauges().counts['messageBytes'];
  };

  test('fails a peer’s close of a status no end sends as a protocol error answered 1002', async () => {
    await using started = await startDated({ heartbeat: Infinity, closeTimeout: 100 });
    const errors: Error[] = [];
    started.server.on('error', (error) => {
      errors.push(error);
    });
    for (const status of [1005, 1006, 999, 1002]) {
      const before = errors.length;
      const { exchange } = await connectOn(started);
      const closed = nextServerEvent(started.server, 'close');
      try {
        exchange.send([
          { fin: true, opcode: OPCODES.CLOSE, payload: Uint8Array.of(status >> 8, status & 0xff) },
        ]);
        expect(await exchange.next(2_000)).toEqual({ close: 1002 });
        exchange.end();
        await closed;
        expect(errors.length - before).toBe(status === 1002 ? 0 : 1);
        if (status !== 1002) {
          expect(errors.at(-1)).toMatchObject({ code: 'WS_ERR_INVALID_CLOSE_CODE' });
        }
      } finally {
        exchange.destroy();
      }
    }
  });

  test('takes whatever its hosts, the hosts every server takes, and any page of its own, and refuses 403 any other host, an empty one and none, before its method and its upgrade', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
    for (const authority of ['bead.test', 'BEAD.test:8080', '127.0.0.1', 'localhost', '[::1]']) {
      const { text } = await answerOf(
        started.port,
        requestOf('GET / HTTP/1.1', [`Host: ${authority}`])
      );
      expect(text.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    }
    await expectAnswered(started.port, {
      answer: refusedWith('403 Forbidden', { refusal: 'host-refused' }),
      requests: [
        requestOf('POST / HTTP/1.1', ['Host: elsewhere.test', 'Upgrade']),
        requestOf('GET / HTTP/1.1', ['Host: ']),
      ],
    });
  });

  test('fails a text message or a close’s reason that is no UTF-8, answered 1007', async () => {
    await using started = await startDated({ heartbeat: Infinity, closeTimeout: 100 });
    const heard = heardOf(started.server);
    const errors: Error[] = [];
    started.server.on('error', (error) => {
      errors.push(error);
    });
    for (const [opcode, payload] of [
      [OPCODES.TEXT, [0xff, 0xfe]],
      [OPCODES.CLOSE, [0x03, 0xe8, 0xff, 0xfe]],
    ] as const) {
      const { exchange } = await connectOn(started);
      const closed = nextServerEvent(started.server, 'close');
      try {
        exchange.send([{ fin: true, opcode, payload: Uint8Array.from(payload) }]);
        expect(await exchange.next(2_000)).toEqual({ close: 1007 });
        exchange.end();
        expect((await closed)[0]).toBe(false);
        expect(errors.at(-1)).toMatchObject({ code: 'WS_ERR_INVALID_UTF8' });
        expect(heard).toEqual([]);
      } finally {
        exchange.destroy();
      }
    }
  });

  test('discards more data after a message passes its bound before the peer answers its close', async () => {
    await using started = await startDated({
      heartbeat: Infinity,
      maxPayload: 64,
      closeTimeout: 100,
    });
    const heard = heardOf(started.server);
    const errors: Error[] = [];
    started.server.on('error', (error) => {
      errors.push(error);
    });
    const { exchange } = await connectOn(started);
    const closed = nextServerEvent(started.server, 'close');
    try {
      exchange.write(
        Buffer.concat([
          maskedFrame(OPCODES.BINARY, new Uint8Array(65)),
          maskedFrame(OPCODES.BINARY, Uint8Array.of(1)),
        ])
      );
      expect(await exchange.next(2_000)).toEqual({ close: 1009 });
      exchange.end();
      expect((await closed)[0]).toBe(false);
      expect(heard).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('maximumMessageBytes, 64 bytes');
    } finally {
      exchange.destroy();
    }
  });

  test('shuts its write side once its failing close went so a peer that answers and waits ends it', async () => {
    await using started = await startDated({
      heartbeat: Infinity,
      maxPayload: 64,
      closeTimeout: Infinity,
    });
    const connection = nextServerEvent(started.server, 'connection');
    const socket = connectTcp({ allowHalfOpen: true, host, port: started.port });
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
    });
    socket.on('error', () => {});
    const ended = once(socket, 'end');
    socket.write(upgradeRequest());
    const [, handle] = await connection;
    const closed = nextServerEvent(started.server, 'close');
    const heard = heardOf(started.server);
    const errors: Error[] = [];
    started.server.on('error', (error) => {
      errors.push(error);
    });
    try {
      socket.write(maskedFrame(OPCODES.BINARY, new Uint8Array(65)));
      await ended;
      expect(closeCodeOf(Buffer.concat(received))).toBe(1009);
      socket.end(maskedFrame(OPCODES.CLOSE, Uint8Array.of(0x03, 0xf1)));

      expect(await closed).toEqual([false, handle]);
      expect(framesOf(Buffer.concat(received))).toEqual([[0x88, [0x03, 0xf1]]]);
      expect(heard).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('maximumMessageBytes, 64 bytes');
    } finally {
      socket.destroy();
    }
  });

  // a binary frame of `bytes` bytes, whole or a first fragment, a client's, masked
  const binaryOf = (
    bytes: number,
    { fin = true, length }: { fin?: boolean; length?: number } = {}
  ) => {
    return frameOf({ fin, length, opcode: OPCODES.BINARY, payload: new Uint8Array(bytes) });
  };

  // spec 15.12
  test('fails with 1008 a message slower than minimumBodyBytesPerSecond once bodyGracePeriod passed since its first byte, its payload alone counting', async () => {
    const clock = createTestClock(DATED);
    await using started = await startDated({ clock, heartbeat: Infinity });
    const { server } = started;
    const told = toldOf(server);
    const { connectionHandle, exchange } = await connectOn(started);

    try {
      // 2,400 bytes of payload, then 40 pongs of 125 bytes between its frames: due 10 s from its
      // first byte, what the payload takes at 240 bytes a second, the pongs counting for nothing
      exchange.write(binaryOf(2_400, { fin: false }));

      for (let index = 0; index < 40; index += 1) {
        exchange.send([{ fin: true, opcode: OPCODES.PONG, payload: new Uint8Array(125) }]);
      }

      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(2_400 + 8 + 128 + 40 * (6 + 125 + 128));
      expect(duesOn(clock)).toEqual([10_000]);

      await clock.tickAsync(9_999);
      expect(await exchange.next(100)).toBeUndefined();

      await clock.tickAsync(1);
      expect(await exchange.next(2_000)).toEqual({ close: 1008 });
      await expect
        .poll(() => {
          return told;
        })
        .toEqual([
          `error: ${connectionHandle} is closed with 1008: a message came slower than minimumBodyBytesPerSecond, 240 bytes a second, past bodyGracePeriod, 5000 ms`,
          `close: ${connectionHandle}`,
        ]);
      expect(chargedOf(server)).toBe(0);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.12, decision 0046
  test('counts a message’s time only while its connection is not paused', async () => {
    const clock = createTestClock(DATED);
    await using started = await startDated({ clock, heartbeat: Infinity, bodyGracePeriod: 3_000 });
    const { server } = started;
    const { connectionHandle, exchange } = await connectOn(started);

    try {
      exchange.write(binaryOf(10, { fin: false, length: 100 }));
      await expect
        .poll(() => {
          return duesOn(clock);
        })
        .toEqual([3_000]);
      await clock.tickAsync(1_000);
      server.pause(connectionHandle);
      expect(duesOn(clock)).toEqual([]);
      await clock.tickAsync(9_000);
      expect(await exchange.next(100)).toBeUndefined();
      server.resume(connectionHandle);
      await expect
        .poll(() => {
          return duesOn(clock);
        })
        .toEqual([2_000]);
      await clock.tickAsync(1_999);
      expect(await exchange.next(100)).toBeUndefined();
      await clock.tickAsync(1);
      expect(await exchange.next(2_000)).toEqual({ close: 1008 });
    } finally {
      exchange.destroy();
    }
  });

  test('counts the time of a message partway only while it reads its connection', async () => {
    const clock = createTestClock(DATED);
    await using started = await startDated({ clock, heartbeat: Infinity });
    const { server } = started;
    const { connectionHandle, exchange } = await connectOn(started);

    try {
      // its first frame's head alone: due at its grace, 5 s from it
      exchange.write(binaryOf(0, { fin: false, length: 100 }));
      await expect
        .poll(() => {
          return duesOn(clock);
        })
        .toEqual([5_000]);

      await clock.tickAsync(2_000);
      server.pause(connectionHandle);

      // paused, its clock stops: no timer, and 10 s pass for nothing
      expect(duesOn(clock)).toEqual([]);
      await clock.tickAsync(10_000);
      expect(await exchange.next(100)).toBeUndefined();

      // read again, it is due 3 s on, what its grace still held
      server.resume(connectionHandle);
      await expect
        .poll(() => {
          return duesOn(clock);
        })
        .toEqual([3_000]);

      await clock.tickAsync(3_000);
      expect(await exchange.next(2_000)).toEqual({ close: 1008 });
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.12
  test('charges a message partway every byte its frames bring and 128 a frame, pongs between them among it, never what a head announces', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { server } = started;
    const heard = heardOf(server);
    const { exchange } = await connectOn(started);
    const first = binaryOf(10, { fin: false, length: 1_000 });

    try {
      // its head of 8 bytes charges nothing until whole, then its bytes and 128, then the 10 bytes
      // of payload come: the 1,000 it announces charge nothing
      exchange.write(first.subarray(0, 3));
      await sleep(100);
      expect(chargedOf(server)).toBe(0);

      exchange.write(first.subarray(3, 8));
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(8 + 128);

      exchange.write(first.subarray(8));
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(8 + 128 + 10);

      // the rest of its payload, a pong between its frames, then its last frame
      exchange.write(new Uint8Array(990));
      exchange.send([{ fin: true, opcode: OPCODES.PONG, payload: Uint8Array.of(1, 2, 3, 4) }]);
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(8 + 128 + 1_000 + (6 + 4 + 128));

      // whole, handed on, its charge released
      exchange.send([{ fin: true, opcode: OPCODES.CONTINUATION, payload: new Uint8Array(3) }]);
      await expect
        .poll(() => {
          return heard;
        })
        .toEqual(['1003 bytes']);
      expect(chargedOf(server)).toBe(0);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.12; IANA's WebSocket Close Code Number Registry, 1013
  test('casts off with 1013 the connections whose messages hold the most when a charge would pass messageBytesBudget, its own only when it comes first', async () => {
    await using started = await startDated({ heartbeat: Infinity, messageBytesBudget: 500 });
    const { server } = started;
    const told = toldOf(server);
    const [ada, bob, carol, dave] = [
      await connectOn(started),
      await connectOn(started),
      await connectOn(started),
      await connectOn(started),
    ];

    try {
      // ada 194, bob 146, his head's 1,000 announced charging nothing
      ada.exchange.write(binaryOf(60, { fin: false }));
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(194);
      bob.exchange.write(binaryOf(10, { fin: false, length: 1_000 }));
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(340);

      // carol's 174 passes it: ada, who holds the most, is cast off
      carol.exchange.write(binaryOf(40, { fin: false }));
      expect(await ada.exchange.next(2_000)).toEqual({ close: 1013 });
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(320);

      // dave's 234 passes it: at its 181st byte, he holds more than any other, and he alone is cast
      // off
      dave.exchange.write(binaryOf(100, { fin: false }));
      expect(await dave.exchange.next(2_000)).toEqual({ close: 1013 });
      await expect
        .poll(() => {
          return told.filter((line) => {
            return line.startsWith('error');
          });
        })
        .toEqual(
          [ada, dave].map(({ connectionHandle }) => {
            return `error: ${connectionHandle} is closed with 1013: the messages partway would pass messageBytesBudget, 500 bytes`;
          })
        );
      expect([
        chargedOf(server),
        await bob.exchange.next(100),
        await carol.exchange.next(100),
      ]).toEqual([320, undefined, undefined]);
    } finally {
      for (const { exchange } of [ada, bob, carol, dave]) {
        exchange.destroy();
      }
    }
  });

  // spec 15.12; img-M5's paused-whole
  test('charges what a paused connection’s read brought, as an unpaused one’s', async () => {
    await using started = await startDated({ heartbeat: Infinity, messageBytesBudget: 1_050 });
    const { server } = started;
    const heard = heardOf(server);
    const paused = await connectOn(started);
    const asking = await connectOn(started);

    server.on('message', ({ data }) => {
      if (data === 'whole') {
        server.pause(paused.connectionHandle);
      }
    });

    try {
      // * one read: a message whole, which its router pauses on, then a frame of 400 bytes of the
      // next, 8 + 400 + 128 charged though its router reads none of it
      paused.exchange.write(
        Buffer.concat([
          frameOf({ fin: true, opcode: OPCODES.TEXT, payload: encoder.encode('whole') }),
          binaryOf(400, { fin: false }),
        ])
      );
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(536);

      // a message whole of 600 charged: its 515th byte finds the paused one holding the most
      asking.exchange.write(binaryOf(600 - 8 - 128));
      expect(await paused.exchange.next(2_000)).toEqual({ close: 1013 });
      await expect
        .poll(() => {
          return heard;
        })
        .toEqual(['whole', '464 bytes']);
      expect(chargedOf(server)).toBe(0);
    } finally {
      paused.exchange.destroy();
      asking.exchange.destroy();
    }
  });

  // spec 15.3, 15.12; RFC 6455 §7.1.7
  test('closes at once a connection whose verdict falls behind a message its router paused on, dropping what the pause holds', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { server } = started;
    const heard = heardOf(server);
    const told = toldOf(server);
    const reserved = frameOf({ fin: true, opcode: 0x3, payload: new Uint8Array(0) });
    const handles: TransportServerConnectionHandle[] = [];

    server.on('message', ({ data }) => {
      const last = handles.at(-1);

      if (data === 'paused' && last !== undefined) {
        server.pause(last);
      }
    });

    // * the head right behind the paused message, then a second message past 125 bytes between
    for (const between of [[], [binaryOf(200)]]) {
      const { connectionHandle, exchange } = await connectOn(started);

      handles.push(connectionHandle);

      try {
        exchange.write(
          Buffer.concat([
            frameOf({ fin: true, opcode: OPCODES.TEXT, payload: encoder.encode('paused') }),
            ...between,
            reserved,
          ])
        );

        // never resumed: its verdict closes it all the same
        expect(await exchange.next(2_000)).toEqual({ close: 1002 });
        await expect
          .poll(() => {
            return told.at(-1);
          })
          .toBe(`close: ${connectionHandle}`);
      } finally {
        exchange.destroy();
      }
    }

    await sleep(100);
    expect(heard).toEqual(['paused', 'paused']);
    expect(
      told.filter((line) => {
        return line.startsWith('error');
      }).length
    ).toBe(2);
  });

  // spec 15.12
  test('releases a charge at its connection’s verdict and charges nothing that comes after it', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { server } = started;
    const { exchange } = await connectOn(started);

    try {
      exchange.write(binaryOf(10, { fin: false }));
      await expect
        .poll(() => {
          return chargedOf(server);
        })
        .toBe(6 + 10 + 128);

      // a text frame while its message is under way: 1002, its charge released, and a frame of
      // 1,000 bytes after it charged nothing
      exchange.write(
        Buffer.concat([
          frameOf({ fin: true, opcode: OPCODES.TEXT, payload: new Uint8Array(1) }),
          binaryOf(1_000),
        ])
      );
      expect(await exchange.next(2_000)).toEqual({ close: 1002 });
      expect(chargedOf(server)).toBe(0);
      exchange.write(binaryOf(1_000, { fin: false }));
      await sleep(100);
      expect(chargedOf(server)).toBe(0);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3
  test('fails with 1009 at its head, without waiting for its payload, a frame that would take its message past maximumMessageBytes, a continuation among them', async () => {
    await using started = await startDated({ heartbeat: Infinity, maxPayload: 64 });
    const { server } = started;
    const told = toldOf(server);
    const whole = await connectOn(started);
    const continued = await connectOn(started);

    try {
      // a head that announces 100 bytes, none of them sent
      whole.exchange.write(binaryOf(0, { length: 100 }));
      expect(await whole.exchange.next(2_000)).toEqual({ close: 1009 });

      // 12 bytes, then a continuation's head that announces 60: 72 past 64
      continued.exchange.write(binaryOf(12, { fin: false }));
      continued.exchange.write(
        frameOf({
          fin: true,
          length: 60,
          opcode: OPCODES.CONTINUATION,
          payload: new Uint8Array(0),
        })
      );
      expect(await continued.exchange.next(2_000)).toEqual({ close: 1009 });
      await expect
        .poll(() => {
          return told.filter((line) => {
            return line.startsWith('error');
          });
        })
        .toEqual(
          [whole, continued].map(({ connectionHandle }) => {
            return `error: ${connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`;
          })
        );
    } finally {
      whole.exchange.destroy();
      continued.exchange.destroy();
    }
  });

  // spec 15.3
  test('hands on a message whole ahead of a frame that draws a verdict in the same read, and nothing from that frame on', async () => {
    await using started = await startDated({ heartbeat: Infinity, maxPayload: 64 });
    const { server } = started;
    const heard = heardOf(server);
    const { exchange } = await connectOn(started);

    try {
      // one write: a text message whole, a head past 64 bytes, then a text message after it
      exchange.write(
        Buffer.concat([
          frameOf({ fin: true, opcode: OPCODES.TEXT, payload: encoder.encode('ahead') }),
          binaryOf(0, { length: 100 }),
          frameOf({ fin: true, opcode: OPCODES.TEXT, payload: encoder.encode('after') }),
        ])
      );
      expect(await exchange.next(2_000)).toEqual({ close: 1009 });
      await sleep(100);
      expect(heard).toEqual(['ahead']);
    } finally {
      exchange.destroy();
    }
  });

  // spec 15.3
  test('fails with 1008 the frame past maximumMessageFrames at its head, an empty frame counting', async () => {
    await using started = await startDated({ heartbeat: Infinity, maximumMessageFrames: 4 });
    const { server } = started;
    const told = toldOf(server);
    const heard = heardOf(server);
    const whole = await connectOn(started);
    const past = await connectOn(started);
    const continuation = (bytes: number, fin = false) => {
      return { fin, opcode: OPCODES.CONTINUATION, payload: new Uint8Array(bytes) };
    };

    try {
      // four frames, two of them empty: one message
      whole.exchange.send([
        { fin: false, opcode: OPCODES.BINARY, payload: new Uint8Array(1) },
        continuation(0),
        continuation(0),
        continuation(1, true),
      ]);
      await expect
        .poll(() => {
          return heard;
        })
        .toEqual(['2 bytes']);

      // four frames, then a fifth's head that announces 10 bytes, none of them sent
      past.exchange.send([
        { fin: false, opcode: OPCODES.BINARY, payload: new Uint8Array(1) },
        continuation(0),
        continuation(0),
        continuation(0),
      ]);
      past.exchange.write(frameOf({ ...continuation(0), length: 10 }));
      expect(await past.exchange.next(2_000)).toEqual({ close: 1008 });
      await expect
        .poll(() => {
          return told[0];
        })
        .toBe(
          `error: ${past.connectionHandle} is closed with 1008: a message past its maximumMessageFrames, 4 frames`
        );
    } finally {
      whole.exchange.destroy();
      past.exchange.destroy();
    }
  });

  // RFC 6455 §5.2, §5.4, §5.5; spec 15.3
  test('fails with 1002 a frame head RFC 6455 forbids before its platform reads it', async () => {
    await using started = await startDated({ heartbeat: Infinity });
    const { server } = started;
    const told = toldOf(server);
    const masked = (first: number, rest: readonly number[] = []) => {
      return Uint8Array.of(first, ...rest);
    };
    const forbidden: [string, Uint8Array][] = [
      ['a reserved bit set', masked(0xc2, [0x80, 0, 0, 0, 0])],
      ['a reserved opcode, 3', masked(0x83, [0x80, 0, 0, 0, 0])],
      ['a reserved opcode, 11', masked(0x8b, [0x80, 0, 0, 0, 0])],
      ['a control frame not final', masked(0x09, [0x80, 0, 0, 0, 0])],
      ['a continuation with no message under way', masked(0x80, [0x80, 0, 0, 0, 0])],
      [
        'a data frame that is not a continuation while a message is under way',
        Buffer.concat([binaryOf(1, { fin: false }), binaryOf(1)]),
      ],
      ['an unmasked frame', masked(0x82, [0x00])],
      // its length's 16-bit form, whatever value follows
      ['a control frame longer than 125 bytes', masked(0x89, [0x80 | 126, 0, 5])],
      [
        'a 64-bit length with its top bit set',
        masked(0x82, [0x80 | 127, 0x80, 0, 0, 0, 0, 0, 0, 0]),
      ],
    ];

    for (const [reason, bytes] of forbidden) {
      const { connectionHandle, exchange } = await connectOn(started);

      try {
        exchange.write(bytes);
        expect(await exchange.next(2_000), reason).toEqual({ close: 1002 });
        await expect
          .poll(() => {
            return told.at(-1);
          })
          .toBe(`close: ${connectionHandle}`);
        // * Bead's own, naming the rule, never `ws`'s
        expect(told.at(-2), reason).toBe(
          `error: ${connectionHandle} is closed with 1002: a frame head RFC 6455 forbids, ${reason}`
        );
      } finally {
        exchange.destroy();
      }
    }
  });

  // RFC 6455 §7.1.7; spec 15.3
  test('sends its close, ends its writing and drops what still comes unparsed until its peer ends or its close timeout passed, once a verdict failed it', async () => {
    await using started = await startDated({ closeTimeout: 300, heartbeat: Infinity });
    const { port, server } = started;
    const told = toldOf(server);
    const heard = heardOf(server);
    // a socket that keeps writing once the server ended its own, and ends when the test says
    const halfOpen = async () => {
      const connection = nextServerEvent(server, 'connection');
      const socket = connectTcp({ allowHalfOpen: true, host, port });
      const received: Buffer[] = [];
      let isEnded = false;

      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
      });
      socket.on('end', () => {
        isEnded = true;
      });
      socket.write(upgradeRequest());

      const [, connectionHandle] = await connection;

      return {
        connectionHandle,
        // the close it read, once the server ended its writing after it
        ended: async () => {
          await expect
            .poll(() => {
              return isEnded;
            })
            .toBe(true);

          return closeCodeOf(Buffer.concat(received));
        },
        socket,
      };
    };

    const ending = await halfOpen();
    const silent = await halfOpen();

    try {
      // a continuation with no message under way: its close, then its FIN, both read
      ending.socket.write(maskedFrame(0x0, new Uint8Array(1)));
      silent.socket.write(maskedFrame(0x0, new Uint8Array(1)));
      expect([await ending.ended(), await silent.ended()]).toEqual([1002, 1002]);

      // what the peer still sends, a message and its close among it, is dropped unread
      const closed = nextServerEvent(server, 'close');

      ending.socket.end(
        Buffer.concat([textFrame('after'), maskedFrame(0x8, Uint8Array.of(0x03, 0xe8))])
      );
      expect(await closed).toEqual([false, ending.connectionHandle]);

      // the peer that never ends is dropped at its close timeout
      expect(await nextServerEvent(server, 'close')).toEqual([false, silent.connectionHandle]);
      expect(heard).toEqual([]);
      expect(
        told.filter((line) => {
          return line.startsWith('error');
        })
      ).toEqual(
        [ending, silent].map(({ connectionHandle }) => {
          return `error: ${connectionHandle} is closed with 1002: a frame head RFC 6455 forbids, a continuation with no message under way`;
        })
      );
    } finally {
      ending.socket.destroy();
      silent.socket.destroy();
    }
  });

  // spec 15.3; docs/support.md, "A single WebSocket frame read slower than its heartbeat"
  test('reads a single frame trickled within each heartbeat as its platform counts its reads', async () => {
    await using started = await startDated({ heartbeat: 200 });
    const { server } = started;
    const told = toldOf(server);
    const heard = heardOf(server);
    const { exchange } = await connectOn(started);
    const frame = binaryOf(4_096);
    const part = Math.ceil(frame.length / 12);

    try {
      // one frame in 12 parts, one every 60 ms, past three heartbeats: each read counts
      for (let at = 0; at < frame.length; at += part) {
        exchange.write(frame.subarray(at, at + part));
        await sleep(60);
      }

      await expect
        .poll(() => {
          return heard;
        })
        .toEqual(['4096 bytes']);
      expect(told).toEqual([]);
    } finally {
      exchange.destroy();
    }
  });
});
