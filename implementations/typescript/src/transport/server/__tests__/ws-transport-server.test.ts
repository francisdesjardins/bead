import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'node:http';
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
import {
  allClosed,
  createTestClock,
  host,
  IMPLEMENTATIONS,
  spyIntervals,
} from '../../shared/__tests__/fixtures';
import {
  ProgrammerError,
  type TRANSPORT_SERVER_EVENTS,
  type TransportServerEventMap,
} from '../transport-server';
import {
  createWSTransportServer,
  HEARTBEAT,
  MAXIMUM_MESSAGE_BYTES,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  type IIncomingMessageLike,
  type IServerSocketLike,
  type IWSTransportServerOptions,
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
        expect(connectionHandle).toMatch(/^type=WS;ip=127\.0\.0\.1;port=\d+$/);
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
          { credential: undefined, data: 'still here' },
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
          { credential: undefined, data: 'hello' },
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

        expect(await first).toEqual([{ credential: undefined, data: 'first' }, connectionHandle]);
        expect(await reported).toEqual([thrown, connectionHandle]);

        const second = nextServerEvent(server, 'message');

        await client.send({ data: 'second' });

        expect(await second).toEqual([{ credential: undefined, data: 'second' }, connectionHandle]);
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

      test('carries no credential, either way', async () => {
        await connectClient(client);
        const taken = nextServerEvent(server, 'message');
        const received = nextClientEvent(client, 'message');

        await client.send({ credential: 'Bearer mF_9.B5f-4.1JqM', data: 'up' });
        expect((await taken)[0]).toEqual({ credential: undefined, data: 'up' });

        await server.send(
          { credential: 'Bearer mF_9.B5f-4.1JqM', data: 'down' },
          server.clients[0]!.connectionHandle
        );
        expect(await received).toEqual([{ credential: undefined, data: 'down' }]);
      });

      test('resolves for a handle nobody holds', async () => {
        await connectClient(client);
        await expect(
          server.send({ data: 'hello' }, 'type=WS;ip=0.0.0.0;port=1')
        ).resolves.toBeUndefined();
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

    // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
    // and a Host of punycode that decodes to none, taken where no host is named
    const page = ['xn--bad-bma.test:8080', 'http://xn--bad-bma.test:8080'] as const;

    expect(
      await answersOf(undefined, [page, ['xn--a'], ['xn--a.test'], ['xn---bad-cpa.test']])
    ).toEqual([taken, taken, taken, taken]);

    // hosts name an IDN host as the field carries it, in punycode
    expect(
      await answersOf(
        ['xn--bad-bma.test:8080'],
        [page, ['XN--BAD-BMA.test:8080'], ['xn--a.test'], ['xn---bad-cpa.test']]
      )
    ).toEqual([taken, taken, refused, refused]);
  });
});

test.describe('WSTransportServer, its handshake', () => {
  test('refuses a method but GET or HEAD 405, after its host and before its upgrade is read, its Allow naming GET and HEAD, marked method-refused', async () => {
    await using started = await startDated({ hosts: ['bead.test', 'bead.test:80'] });
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
      ],
    });
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
  test('hands `maxPayload` to the WebSocketServer, an envelope’s limit when not given', async () => {
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

      const { server: given, ...options } = (fake.instances[0]?.options ?? {}) as Record<
        string,
        unknown
      >;

      // the transport's own HTTP server, which judges each request before ws reads it
      expect(options).toEqual({ maxPayload: expected });
      expect(given).toBeInstanceOf(Server);
      await server.stop();
    }

    expect(MAXIMUM_MESSAGE_BYTES).toBe(16_778_240);
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
        return server.isSecure(fake.connect(createFakeSocket()));
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

  test('leaves the connection a newer socket took the handle of alone when the older one closes', async () => {
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
    const starting = server.start(SCRIPTED);

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
    const starting = server.start(SCRIPTED);
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
    const closing = server.close(fake.connect(silent));

    await sleep(50);

    expect(silent.wasTerminated).toBe(false);

    silent.hear('close', 1000);

    await expect(closing).resolves.toBe(true);
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

    fake.connect(silent);
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

    const starting = server.start(SCRIPTED);
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
    fake.connect(createFakeSocket());

    expect(
      timers.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([HEARTBEAT]);

    await server.stop();
  });

  test('beats nothing with a heartbeat of Infinity', async () => {
    using timers = spyIntervals();
    const fake = createFakeWebSocketServer();
    const server = createWSTransportServer({
      heartbeat: Infinity,
      WebSocketServer: fake.FakeWebSocketServer,
    });
    const socket = createFakeSocket();

    const starting = server.start(SCRIPTED);
    fake.instances[0]?.emit('listening');
    await starting;
    fake.connect(socket);

    // no interval at all: Node would beat one of Infinity every millisecond
    expect([timers.armed, socket.pings, socket.wasTerminated]).toEqual([[], 0, false]);

    await server.stop();
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
