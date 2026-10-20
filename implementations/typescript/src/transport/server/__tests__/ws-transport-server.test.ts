import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'node:http';
import { connect as connectTcp, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocket as WsClient, type WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import type {
  TRANSPORT_CLIENT_EVENTS,
  TransportClientEventMap,
} from '../../client/transport-client';
import { createWSTransportClient, type WSTransportClient } from '../../client/ws-transport-client';
import * as constants from '../../shared/constants';
import { CancelError, ConnectError } from '../../shared/errors';
import {
  allClosed,
  createTestClock,
  host,
  IMPLEMENTATIONS,
  spyIntervals,
} from '../../shared/__tests__/fixtures';
import {
  ProgrammerError,
  type ITransportServerRefusal,
  type TRANSPORT_SERVER_EVENTS,
  type TransportServerEventMap,
} from '../transport-server';
import {
  CLOSE_TIMEOUT,
  createWSTransportServer,
  HEARTBEAT,
  MAXIMUM_MESSAGE_BYTES,
  START_DEFAULTS,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IDrawingRequest,
  type IServerSocketLike,
  type IWSTransportServerOptions,
  type WSTransportServer,
} from '../ws-transport-server';
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

type ServerEvents = TransportServerEventMap<IServerSocketLike, IDrawingRequest>;

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

// a frame of `opcode` a client sends, masked as every client's is (RFC 6455 §5.2, §5.3), its
// payload under 126 bytes
const maskedFrame = (opcode: number, payload: Uint8Array) => {
  const mask = randomBytes(4);
  const masked = payload.map((byte, index) => {
    return byte ^ (mask[index % 4] ?? 0);
  });

  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
};

// the code of the close a server sent right after its 101, once it came: its frame unmasked, as a
// server's is
const closeCodeOf = (received: Buffer): number | undefined => {
  const frame = received.subarray(received.indexOf('\r\n\r\n') + 4);

  return frame[0] === 0x88 && frame.length >= 4 ? frame.readUInt16BE(2) : undefined;
};

// what a test's listeners throw meanwhile, which reaches Node as an uncaught exception: taken from
// the runner's own listeners, which would fail the test, and given back to them once it ends
const trapUncaught = (): Disposable & { thrown: unknown[] } => {
  const thrown: unknown[] = [];
  const runners = process.rawListeners('uncaughtException');
  const trap = (error: unknown): void => {
    thrown.push(error);
  };

  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', trap);

  return {
    thrown,
    [Symbol.dispose]: () => {
      process.off('uncaughtException', trap);

      for (const runner of runners) {
        process.on('uncaughtException', runner as (error: Error) => void);
      }
    },
  };
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
const startDated = async (options: Omit<Partial<IWSTransportServerOptions>, 'WebSocketServer'>) => {
  const server = createWSTransportServer({
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

        server.once('connection', () => {
          throw thrown;
        });

        // the listener after it, told all the same
        const [, , connectionHandle] = await connectClient(client);

        expect(await reported).toEqual([thrown, connectionHandle]);

        const heard = nextServerEvent(server, 'message');

        await client.send({ data: 'still here' });

        expect(await heard).toEqual([
          { ...FROM, credential: undefined, data: 'still here' },
          connectionHandle,
        ]);
        expect(server.clients).toHaveLength(1);
      });
    });

    test.describe('WSTransportServer "message" event', () => {
      test('delivers text as a string and binary as an ArrayBuffer, stamping the activity', async () => {
        await connectClient(client);
        const [before] = server.clients;
        expect(before?.lastActivity).toBeUndefined();

        const text = nextServerEvent(server, 'message');
        await client.send({ data: 'hello' });
        expect(await text).toEqual([
          { ...FROM, credential: undefined, data: 'hello' },
          before?.connectionHandle,
        ]);

        const binary = nextServerEvent(server, 'message');
        await client.send({ data: new TextEncoder().encode('bytes') });
        const [{ data }] = await binary;
        expect(data).toBeInstanceOf(ArrayBuffer);
        expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('bytes');

        expect(server.clients[0]?.lastActivity).toBeGreaterThan(0);
      });

      test('hears the next message after a message listener throws, the throw reported with its connection', async () => {
        const [, , connectionHandle] = await connectClient(client);
        const thrown = new Error('a message listener that throws');

        server.once('message', () => {
          throw thrown;
        });

        const reported = nextServerEvent(server, 'error');
        const first = nextServerEvent(server, 'message');

        await client.send({ data: 'first' });

        expect(await first).toEqual([
          { ...FROM, credential: undefined, data: 'first' },
          connectionHandle,
        ]);
        expect(await reported).toEqual([thrown, connectionHandle]);

        const second = nextServerEvent(server, 'message');

        await client.send({ data: 'second' });

        expect(await second).toEqual([
          { ...FROM, credential: undefined, data: 'second' },
          connectionHandle,
        ]);
        expect(server.clients).toHaveLength(1);
      });
    });

    test.describe('WSTransportServer "events"', () => {
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

    test.describe('WSTransportServer #send', () => {
      test('reaches the client', async () => {
        await connectClient(client);
        const received = nextClientEvent(client, 'message');

        await server.send({ data: 'hello' }, server.clients[0]!.connectionHandle);

        expect(await received).toEqual([{ credential: undefined, data: 'hello' }]);
      });

      test('resolves for a handle nobody holds', async () => {
        await connectClient(client);
        await expect(
          server.send({ data: 'hello' }, 'type=WS;ip=0.0.0.0;port=1;ordinal=1')
        ).resolves.toBeUndefined();
      });
    });

    test.describe('WSTransportServer #close', () => {
      test('closes one connection, which is gone once it resolves', async () => {
        const [socket] = await connectClient(client);
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

      test('resolves false for a handle nobody holds', async () => {
        await expect(server.close('type=WS;ip=0.0.0.0;port=1;ordinal=1')).resolves.toBe(false);
      });

      test('"closeAll" closes every connection', async () => {
        await expect(server.closeAll()).resolves.toEqual([]);
        const second = createWSTransportClient({ WebSocket: Tracked });
        const connectionHandles: string[] = [];
        const closed: [boolean, string][] = [];
        const codes: number[] = [];
        server.on('connection', (socket) => {
          socket.on('close', (code) => {
            codes.push(code);
          });
        });
        server.on('close', (clean, connectionHandle) => {
          connectionHandles.push(connectionHandle);
          closed.push([clean, connectionHandle]);
        });

        await connectClient(client);
        await connectClient(second);
        const handles = server.clients.map(({ connectionHandle }) => {
          return connectionHandle;
        });

        await expect(server.closeAll()).resolves.toEqual([true, true]);
        expect(connectionHandles).toHaveLength(2);
        expect(server.clients).toHaveLength(0);
        expect(closed).toEqual(
          expect.arrayContaining(
            handles.map((handle) => {
              return [true, handle];
            })
          )
        );
        expect(server.isOpen()).toBe(true);
        expect(codes).toEqual([1000, 1000]);
      });
    });

    test.describe('WSTransportServer #stop', () => {
      test('closes every connection, each emitting its close, before it resolves, and stops listening', async () => {
        const second = createWSTransportClient({ WebSocket: Tracked });
        const closeEvents: [boolean, string][] = [];
        server.on('close', (clean, connectionHandle) => {
          closeEvents.push([clean, connectionHandle]);
        });

        const codes: number[] = [];

        for (const [socket] of [await connectClient(client), await connectClient(second)]) {
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

        const late = createWSTransportClient({ WebSocket: Tracked });
        await expect(late.connect({ host, port })).rejects.toBeInstanceOf(ConnectError);
      });

      test('stops twice, then starts again on a new port', async () => {
        const [, , before] = await connectClient(client);
        const clientClosed = nextClientEvent(client, 'close');

        await server.stop();
        await server.stop();
        await clientClosed;

        ({ port } = await server.start({ address: host, findOpenPort: true }));
        const [, , after] = await connectClient(client);

        expect(server.clients).toHaveLength(1);
        // ranked after every connection taken before the stop: no handle is given twice
        expect([before, after].map(ordinalOf)).toEqual([1, 2]);
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

        const [[, , connectionHandle]] = await Promise.all([connection, once(socket, 'open')]);

        socket.terminate();

        return connectionHandle;
      },
      async () => {
        const connection = nextServerEvent(server, 'connection');
        const socket = await openTcp(port);

        socket.write(upgradeRequest());

        const [, , connectionHandle] = await connection;

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

  test('closes with 1009 a message past an envelope’s limit, 16,778,240 bytes, when told no bound', async () => {
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://${host}:${String(port)}`);

    socket.addEventListener('error', () => {});
    await once(socket, 'open');

    const whole = nextServerEvent(server, 'message');

    socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES));

    const [{ data }] = await whole;

    expect((data as ArrayBuffer).byteLength).toBe(16_778_240);

    const closed = once(socket, 'close');

    socket.send(new Uint8Array(MAXIMUM_MESSAGE_BYTES + 1));

    expect((await closed)[0]).toBe(1009);
  });

  // spec 15.3
  test('fails with 1009 a message past its bound, telling one error that names maximumMessageBytes, then an unclean close, even when the peer answers 1000', async () => {
    await server.stop();
    server = createWSTransportServer({ maxPayload: 64, WebSocketServer });
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

    const [, , connectionHandle] = await connection;

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

    expect(told).toEqual([
      [
        'error',
        `${connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
        'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
        connectionHandle,
      ],
      ['close', connectionHandle],
    ]);
    socket.destroy();
  });

  // spec 15.3
  test('fails with 1009 a peer that never answers, telling one error, then an unclean close once its close timeout passed', async () => {
    await server.stop();
    server = createWSTransportServer({ closeTimeout: 200, maxPayload: 64, WebSocketServer });
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

    const [, , connectionHandle] = await connection;
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

    const [, , connectionHandle] = await connection;

    // a close frame with no body, its TCP connection ended after it
    socket.end(maskedFrame(0x8, new Uint8Array(0)));

    expect(await closed).toEqual([false, connectionHandle]);
    socket.destroy();
  });

  test('emits "connection" before a frame that arrived with the upgrade request', async () => {
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
    const dualStack = createWSTransportServer({ WebSocketServer });
    const { port: dualPort } = await dualStack.start({ address: '::', findOpenPort: true });
    const connection = nextServerEvent(dualStack, 'connection');
    const [, TrackedWsWebSocket] = IMPLEMENTATIONS[1];
    const socket = new TrackedWsWebSocket(`ws://127.0.0.1:${String(dualPort)}`);

    try {
      await once(socket, 'open');

      const [, request, connectionHandle] = await connection;

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
    server = createWSTransportServer({ WebSocketServer, binaryType: 'nodebuffer' });
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

test.describe('WSTransportServer, the credential its upgrade carries', () => {
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
    const client = createWSTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

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
    const snapshot = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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
    const [, upgrade, connectionHandle] = await connection;

    expect([Object.isFrozen(upgrade), upgrade]).toEqual([
      true,
      { method: 'GET', remoteAddress: '127.0.0.1', remotePort: expect.any(Number), url: '/' },
    ]);
    expect(JSON.stringify(upgrade)).not.toContain(BEARER);
    expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=1$/u);

    socket.close();
  });
});

test.describe('WSTransportServer, its hosts and origins', () => {
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
    const server = createWSTransportServer({ origins: ['https://bead.test'], WebSocketServer });
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
      const server = createWSTransportServer({ hosts, WebSocketServer });
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
  test('refuses as it is built a hosts entry with a port, and an origins entry that is * or null', () => {
    const built = (options: Partial<IWSTransportServerOptions>) => {
      return () => {
        return createWSTransportServer({ ...options, WebSocketServer });
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
        return createWSTransportServer({ trustedProxies, unnamedProxies, WebSocketServer });
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

test.describe('WSTransportServer, its handshake', () => {
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
});

test.describe('WSTransportServer, with a scripted WebSocketServer', () => {
  test('hands `maxPayload` and its close timeout to the WebSocketServer, an envelope’s limit and CLOSE_TIMEOUT when not given', async () => {
    for (const [maxPayload, expected] of [
      [256, 256],
      [undefined, 16_778_240],
    ] as const) {
      const fake = createFakeWebSocketServer();
      const server = createWSTransportServer({
        maxPayload,
        WebSocketServer: fake.FakeWebSocketServer,
      });

      const starting = server.start(SCRIPTED);
      fake.instances[0]?.emit('listening');
      await starting;

      const { server: given, ...options } = (fake.instances[0]?.options ?? {}) as {
        closeTimeout: number;
        maxPayload: number;
        server: Server;
      };

      // the transport's own HTTP server, which judges each request before ws reads it
      expect(options).toEqual({ closeTimeout: CLOSE_TIMEOUT, maxPayload: expected });
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
    const server = createWSTransportServer({
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
    const crossed = createWSTransportServer({ WebSocketServer: crossing.FakeWebSocketServer });
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
      const server = createWSTransportServer({
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
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

      const starting = server.start({ ...SCRIPTED, port: 4_321 });
      fake.instances[0]?.emit('listening');

      expect(await starting).toEqual({ address: host, port: 4_321 });
      expect(server.port).toBe(4_321);
      await server.stop();
    }
  });

  test("an error after listening is the server's own, with an empty handle, and it stays open", async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

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

  test('an abort before listening rejects the start with a CancelError and closes what was opened', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const controller = new AbortController();

    const starting = server.start({ ...SCRIPTED, signal: controller.signal });
    controller.abort('why');

    await expect(starting).rejects.toBeInstanceOf(CancelError);
    await expect(starting).rejects.toHaveProperty('cause', 'why');
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);
  });

  test('an error before listening rejects the start and closes what was opened', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start(SCRIPTED);
    const failure = new Error('refused');
    fake.instances[0]?.emit('error', failure);

    await expect(starting).rejects.toBe(failure);
    expect(fake.instances[0]?.closeCount).toBe(1);
    expect(server.isClosed()).toBe(true);
  });

  test('names each connection by its peer’s port and the rank it came at, two sockets from one address and port among them, and gives no handle twice', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start(SCRIPTED);

    fake.instances[0]?.emit('listening');
    await starting;

    const [first, second, third] = [createFakeSocket(), createFakeSocket(), createFakeSocket()];
    // three sockets from one address and port, the first closed before the third came
    const firstHandle = fake.connect(first, { server });
    const secondHandle = fake.connect(second, { server });

    first.terminate();

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

    // each its own: a close reaches its socket alone, and the first's handle names none
    await expect(server.close(firstHandle)).resolves.toBe(false);
    await expect(server.close(secondHandle)).resolves.toBe(true);
    expect([second.closeCodes, third.closeCodes]).toEqual([[1000], []]);
    await server.stop();
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
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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
        { connections: 1, largestAddressConnections: 0, largestUnsentBytes: 0, unsentBytes: 0 },
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
        { connections: 0, largestAddressConnections: 0, largestUnsentBytes: 0, unsentBytes: 0 },
      ]);
      await server.stop();
    }
  });

  test('takes no connection whose socket is gone already, and ends it', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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

  test('drops a connection that never answers its close once closeTimeout has passed, telling no error', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({
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
    const server = createWSTransportServer({
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
    const server = createWSTransportServer({
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
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;

    const stubborn = createFakeSocket({ onClose: 'throw' });
    const connectionHandle = fake.connect(stubborn, { server });

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
    const errors: unknown[] = [];

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
    // a peer the heartbeat dropped, gone without a word, is no error on its connection
    expect(errors).toEqual([]);

    await expect
      .poll(() => {
        return answering.pings;
      })
      .toBeGreaterThan(2);

    expect(answering.wasTerminated).toBe(false);

    await server.stop();

    // closed, it beats no more: five of its beats pass, and none pings
    const pings = answering.pings;

    await sleep(100);

    expect(answering.pings).toBe(pings);
  });

  test('beats every HEARTBEAT when told nothing', async () => {
    using timers = spyIntervals();
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;
    fake.connect(createFakeSocket(), { server });

    expect(
      timers.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([HEARTBEAT]);

    await server.stop();
  });

  test('beats nothing with a heartbeat of Infinity', async () => {
    // a heartbeat of 200 ms first, which beats, then Infinity, which arms nothing
    for (const [heartbeat, delays] of [
      [200, [200]],
      [Infinity, []],
    ] as const) {
      using timers = spyIntervals();
      const fake = createFakeWebSocketServer();
      const server = createWSTransportServer({
        heartbeat,
        WebSocketServer: fake.FakeWebSocketServer,
      });
      const socket = createFakeSocket();

      const starting = server.start(SCRIPTED);
      fake.instances[0]?.emit('listening');
      await starting;

      const connectionHandle = fake.connect(socket, { server });

      // no interval at all for Infinity: Node would beat one of Infinity every millisecond
      expect([
        heartbeat,
        timers.armed.map(({ delay }) => {
          return delay;
        }),
      ]).toEqual([heartbeat, delays]);

      // each beat it armed, played once: a ping, its peer kept
      for (const { beat } of timers.armed) {
        beat();
      }

      expect([
        heartbeat,
        socket.pings,
        socket.wasTerminated,
        server.clients.map(({ connectionHandle: held }) => {
          return held;
        }),
      ]).toEqual([heartbeat, delays.length, false, [connectionHandle]]);

      await server.stop();
    }
  });

  test('keeps the clients that answer its pings — a browser’s as `ws`’s — and drops one that does not, on the wire', async () => {
    // beats wide enough that a pong never misses one on a loaded machine
    const server = createWSTransportServer({ heartbeat: 200, WebSocketServer });
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
const refusalsOf = (server: WSTransportServer) => {
  const refusals: ITransportServerRefusal[] = [];

  server.on('refusal', (refusal) => {
    refusals.push(refusal);
  });

  return refusals;
};

test.describe('WSTransportServer, the refusals it tells', () => {
  test('tells each refusal it judges of its own, its status, its reason, the request’s authority and origin and the client’s address and port, and nothing of HTTP’s own, at its address', async () => {
    await using started = await startDated({ hosts: ['bead.test'] });
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
        requestOf('GET http://elsewhere.test:81/ HTTP/1.1'),
        { authority: 'elsewhere.test:81', reason: 'host-refused', status: 403 },
      ],
      [requestOf('POST / HTTP/1.1'), { reason: 'method-refused', status: 405 }],
      [
        requestOf('CONNECT bead.test:80 HTTP/1.1', ['Host: bead.test:80']),
        { authority: 'bead.test:80', reason: 'method-refused', status: 405 },
      ],
      [requestOf('GET / HTTP/1.1', [...NO_UPGRADE]), { reason: 'upgrade-required', status: 426 }],
      [
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Version: 8']),
        { reason: 'version-refused', status: 426 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Sec-WebSocket-Key: dGVzdA==']),
        { reason: 'malformed', status: 400 },
      ],
      [
        requestOf('GET / HTTP/1.1', ['Origin: https://elsewhere.test']),
        { origin: 'https://elsewhere.test', reason: 'origin-refused', status: 403 },
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
      { port, server }: { port: number; server: WSTransportServer },
      forwarded: string
    ) => {
      const connection = nextServerEvent(server, 'connection');
      const socket = await openTcp(port);

      sockets.push(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.write(requestOf('GET / HTTP/1.1', [`X-Forwarded-For: ${forwarded}`]));

      const [, , connectionHandle] = await connection;

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

test.describe('WSTransportServer, the address it listens on', () => {
  test('listens on localhost, port 80, and beats every 30 seconds when told nothing', async () => {
    using timers = spyIntervals();
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });

    expect([server.address, server.port, START_DEFAULTS]).toEqual([
      'localhost',
      80,
      { address: 'localhost', findOpenPort: false, port: 80 },
    ]);
    expect([HEARTBEAT, CLOSE_TIMEOUT, MAXIMUM_MESSAGE_BYTES]).toEqual([30_000, 5_000, 16_778_240]);

    const starting = server.start({ findOpenPort: true });

    await fake.listenEach(2);
    await starting;
    fake.connect(createFakeSocket(), { server });

    expect([
      server.address,
      timers.armed.map(({ delay }) => {
        return delay;
      }),
    ]).toEqual(['localhost', [30_000]]);

    await server.stop();
  });

  test('listens on localhost when given no address, both loopbacks on one port, reached by 127.0.0.1, by [::1] and by localhost, reports localhost, and is secure there', async () => {
    const server = createWSTransportServer({ WebSocketServer });
    const clients: WSTransportClient[] = [];

    try {
      const { address, port } = await server.start({ findOpenPort: true });

      expect([address, server.address]).toEqual(['localhost', 'localhost']);

      for (const name of [host, '::1', 'localhost']) {
        const client = createWSTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

        clients.push(client);
        await client.connect({ host: name, port });
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
    const server = createWSTransportServer({ WebSocketServer });

    await expect(server.start({ port: held.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // the IPv4 loopback's port let go
    expect([server.isClosed(), await isFreeOn(host, held.port)]).toEqual([true, true]);
  });

  test('draws a port on localhost again when the IPv6 loopback holds the one drawn on IPv4', async () => {
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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
    const refused = createWSTransportServer({ WebSocketServer: held.FakeWebSocketServer });
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
    const fixed = createWSTransportServer({ WebSocketServer: given.FakeWebSocketServer });
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
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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
      const server = createWSTransportServer({
        WebSocketServer: createRefusingWebSocketServer('::1', bindError(code)),
      });
      const client = createWSTransportClient({ WebSocket: IMPLEMENTATIONS[1][1] });

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
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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
      const server = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
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

test.describe('WSTransportServer, its bounds', () => {
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
            return createWSTransportServer({ [name]: value, WebSocketServer });
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

    const [, , connectionHandle] = await connection;

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
    const [, , connectionHandle] = await connection;
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
    const [, , connectionHandle] = await connection;
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
  test('closes with 1009, and drops behind maximumUnsentBytes, a connection whose error listener throws, telling its close all the same', async () => {
    using uncaught = trapUncaught();
    await using started = await startDated({
      heartbeat: Infinity,
      maxPayload: 64,
      maximumUnsentBytes: 65_536,
      minimumSendBytesPerSecond: 0,
    });
    const { port, server } = started;
    const reported: string[] = [];
    const closes: unknown[] = [];

    server.on('error', (error) => {
      reported.push(error.message);

      throw new Error('an error listener that throws');
    });
    server.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });

    // past its message bound: closed with 1009 all the same
    const tooBigConnection = nextServerEvent(server, 'connection');
    const tooBig = new WsClient(`ws://${host}:${String(port)}`);

    tooBig.on('error', () => {});
    await once(tooBig, 'open');

    const [, , tooBigHandle] = await tooBigConnection;
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
    const [, , behindHandle] = await behindConnection;

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
    expect(reported).toEqual([
      `${tooBigHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes`,
      `${behindHandle} is dropped: what waits for its socket would pass maximumUnsentBytes, 65536 bytes`,
    ]);
    // what the listener threw was Node's, once each
    expect(
      uncaught.thrown.map((error) => {
        return (error as Error).message;
      })
    ).toEqual(['an error listener that throws', 'an error listener that throws']);
    expect(server.clients).toEqual([]);
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
        return createWSTransportServer({ ...options, WebSocketServer });
      }).toThrow(new ProgrammerError(refusal));
    }
  });
});
