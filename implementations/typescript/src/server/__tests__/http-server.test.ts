import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createHTTPClient, type HTTPClient } from '../../client/http-client';
import { createWSClient } from '../../client/ws-client';
import type { IProcedure } from '../../router/shared/types';
import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { createFakeFetch } from '../../transport/client/__tests__/fake-fetch';
import { createTestClock, timersBy } from '../../transport/shared/__tests__/fixtures';
import {
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  REFUSAL_HEADER,
} from '../../transport/client/http-transport-client';
import {
  allClosed,
  IMPLEMENTATIONS,
  tcpSocketsClosed,
} from '../../transport/shared/__tests__/fixtures';
import {
  CancelError,
  CONNECTION_INACTIVITY_TIMEOUT,
  createHTTPServer,
  FailureError,
  ProgrammerError,
  ProtocolCode,
  type HTTPServer,
} from '../http-server';
import { createWSServer } from '../ws-server';
import { expectAtRest } from './fixtures';

// helpers

const host = '127.0.0.1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
};
const bytes = {
  decode: (payload: Uint8Array) => {
    return payload;
  },
  encode: (payload: Uint8Array) => {
    return payload;
  },
};

const procedureOf = (procedureId: number, procedureName: string): IProcedure => {
  return { procedureId, procedureName, serviceId: 1, serviceRevision: 1 };
};

const openSession = procedureOf(1, 'openSession');
const read = procedureOf(2, 'read');
const upload = procedureOf(3, 'upload');
const slow = procedureOf(4, 'slow');
const news = procedureOf(5, 'news');
const ping = procedureOf(6, 'ping');
const echo = procedureOf(7, 'echo');

const digestOf = (payload: Uint8Array) => {
  return createHash('sha256').update(payload).digest('hex');
};

/**
 * An HTTP server on a free port — a session opened by `openSession`, of `sessionInactivityTimeout`,
 * `read` behind it, `upload` answering its payload's digest, `slow` waiting on its signal, `news` a
 * subscription — and an HTTP client connected to it. `await using` takes them apart.
 */
const connectHTTP = async ({
  isListening = true,
  server: given,
  sessionInactivityTimeout = Infinity,
}: {
  isListening?: boolean;
  server?: Partial<Parameters<typeof createHTTPServer>[0]>;
  sessionInactivityTimeout?: number;
} = {}) => {
  const server: HTTPServer = createHTTPServer({
    transport: {
      createServer: (listener) => {
        return createServer(listener);
      },
    },
    ...given,
  });
  const { services, sessions } = server;
  const aborted: unknown[] = [];

  services.getRequestResolver(openSession, { serializer: text })((request, response) => {
    sessions.set({ ...sessions.create(request.connectionHandle), sessionInactivityTimeout });

    return response('opened');
  });
  services.getRequestResolver(read, { beforeRequest: server.requireSession, serializer: text })(
    async (request, response) => {
      // the later a call comes, the sooner it answers: the answers come out of order
      await sleep(Number(request.payload));

      return response(request.payload);
    }
  );
  services.getRequestResolver(upload, { beforeRequest: server.requireSession, serializer: bytes })(
    (request, response) => {
      return response(encoder.encode(digestOf(request.payload)));
    }
  );
  services.getRequestResolver(slow, { serializer: text })((request) => {
    return new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => {
          aborted.push(request.signal.reason);
          resolve(undefined);
        },
        { once: true }
      );
    });
  });
  const newsChanges = services.getNotificationResolver(news, {
    serializer: { ...text, encodeNotification: text.encode },
  })((_request, response) => {
    response.registerNotification();

    return response('subscribed');
  });

  const { port } = await server.transport.start({ address: host, findOpenPort: true });
  const client: HTTPClient = createHTTPClient({ transport: { isListening } });

  await client.connect({ host, port });

  return {
    aborted,
    client,
    // what tells the subscribers to `news`
    notify: (value: string) => {
      return newsChanges.notify(value);
    },
    port,
    server,
    // taken apart once each layer keeps nothing of the client gone
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await expectAtRest(server);
      await server[Symbol.asyncDispose]();
    },
  };
};

// definition

test.describe('an HTTP server and client', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('open a session by a request, and answer within it, refusing before it', async () => {
    await using connected = await connectHTTP();
    const { client } = connected;
    const reading = client.services.getRequest(read, { serializer: text });

    await expect(reading('0')()).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
    await expect(
      client.services.getRequest(openSession, { serializer: text })('me')()
    ).resolves.toBe('opened');
    // the session announced on that answer, and kept by the connection drawn
    expect(client.router.sessionToken).toBeDefined();
    await expect(reading('0')()).resolves.toBe('0');

    // each layer counts the one connection, the transport's own counts among them, and holds up
    const gauges = connected.server.gauges();

    expect([
      gauges.transport.counts['connections'],
      gauges.server.counts['connections'],
      gauges.sessions.counts['sessions'],
      connected.server.health().status,
    ]).toEqual([1, 1, 1, 'pass']);
  });

  test('answer calls in flight together, each by its own call id, whatever the order they end in', async () => {
    await using connected = await connectHTTP();
    const { client } = connected;

    await client.services.getRequest(openSession, { serializer: text })('me')();

    const reading = client.services.getRequest(read, { serializer: text });

    const answered = await Promise.all(
      ['60', '30', '0'].map((wait) => {
        return reading(wait)();
      })
    );

    expect(answered).toEqual(['60', '30', '0']);
  });

  test('upload 8 MiB in one exchange, and refuse on the client what one envelope cannot hold', async () => {
    await using connected = await connectHTTP();
    const { client } = connected;
    const payload = new Uint8Array(8 * 1_048_576).map((_, index) => {
      return index % 251;
    });
    const uploading = client.services.getRequest(upload, { serializer: bytes });

    await client.services.getRequest(openSession, { serializer: text })('me')();

    expect(decoder.decode(await uploading(payload)({ timeout: 30_000 }))).toBe(digestOf(payload));
    expect([
      client.router.limits.maximumTransfers,
      connected.server.router.limits.maximumTransfers,
    ]).toEqual([0, 0]);

    // no transfer over HTTP: past what one envelope holds, refused before anything goes
    const small = createHTTPClient({ limits: { maximumEnvelopeBytes: 1_024 } });

    try {
      await small.connect({ host, port: connected.port });
      await small.services.getRequest(openSession, { serializer: text })('me')();
      await expect(
        small.services.getRequest(upload, { serializer: bytes })(new Uint8Array(2_000))()
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload of 2000 bytes goes as a transfer, which this side sends none of',
        origin: 'local',
      });
    } finally {
      await small[Symbol.asyncDispose]();
    }
  });

  test('cancel a call on its server when it times out on the client', async () => {
    await using connected = await connectHTTP();
    const { aborted, client } = connected;

    await expect(
      // long enough for the call to reach the server before its cancel, which goes on a request
      // of its own
      client.services.getRequest(slow, { serializer: text })('wait')({ timeout: 500 })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect
      .poll(() => {
        return aborted;
      })
      .toEqual([expect.any(CancelError)]);
  });

  test('refuse a subscription to a client that does not listen, which nothing brings back, and a command, which nothing carries', async () => {
    await using connected = await connectHTTP({ isListening: false });
    const { client, server } = connected;
    const refused = await client.services
      .getNotification(news, { serializer: { ...text, decodeNotification: text.decode } })(
        'subscribe',
        () => {}
      )()
      .catch((reason: unknown) => {
        return reason;
      });

    expect(refused).toBeInstanceOf(FailureError);
    expect(refused).toMatchObject({ code: ProtocolCode.SUBSCRIPTION_UNSUPPORTED, side: 'server' });

    const connectionHandle = server.transport.clients[0]?.connectionHandle;

    await expect(
      server.services.getCommand(ping, { serializer: text })('ping')({
        connectionHandle: connectionHandle ?? 'type=HTTP;ip=127.0.0.1;ordinal=1',
        timeout: 1_000,
      })
    ).rejects.toThrow('this connection does not listen');
  });

  test('close a connection that opened no session within its timeout, 30 s by default', async () => {
    // a client that does not listen: one that does holds a listen, which is no silence
    await using connected = await connectHTTP({
      isListening: false,
      server: { connectionInactivityTimeout: 50 },
    });
    const { client } = connected;
    const closed = new Promise((resolve) => {
      client.transport.once('close', (...params) => {
        resolve(params);
      });
    });

    // the connection is gone: the next exchange learns it, and the client closes
    await expect
      .poll(() => {
        return connected.server.transport.clients;
      })
      .toEqual([]);
    await client.services
      .getRequest(read, { serializer: text })('0')()
      .catch(() => {});

    expect(await closed).toEqual([false, false]);

    // by default, the timer a connection arms on a server built with no timeout, on the clock its
    // transport is given; nothing listens
    const clock = createTestClock();
    await using server = createHTTPServer({
      transport: {
        clock,
        createServer: (listener) => {
          return createServer(listener);
        },
      },
    });
    const { armed } = timersBy(clock, () => {
      server.transport.emit(
        'connection',
        { ordinal: 1 },
        { method: 'POST', remoteAddress: host, remotePort: 40_000, url: '/bead' },
        'type=HTTP;ip=127.0.0.1;ordinal=1'
      );
    });

    expect(
      armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([CONNECTION_INACTIVITY_TIMEOUT]);
    expect(CONNECTION_INACTIVITY_TIMEOUT).toBe(30_000);
  });

  test('end a session past its session timeout while its client holds a listen, which brings back the failure of its subscription, the connection staying', async () => {
    const clock = createTestClock();

    await using connected = await connectHTTP({
      server: {
        transport: {
          clock,
          createServer: (listener) => {
            return createServer(listener);
          },
        },
      },
      sessionInactivityTimeout: 1_000,
    });
    const { client, server } = connected;
    const dropped = Promise.withResolvers<unknown>();

    client.services.on('dropped', (procedure, failure) => {
      dropped.resolve([procedure.procedureName, failure?.code]);
    });
    await client.services.getRequest(openSession, { serializer: text })('me')();
    await client.services.getNotification(news, {
      serializer: { ...text, decodeNotification: text.decode },
    })('subscribe', () => {})();

    // the client holds a listen, which the server's clock, the test's, never ends by itself
    await expect
      .poll(() => {
        return server.transport.gauges().counts['listens'];
      })
      .toBe(1);
    clock.tick(1_000);

    await expect(dropped.promise).resolves.toEqual(['news', ProtocolCode.SESSION_REQUIRED]);
    expect([server.sessions.getAll(), server.transport.clients]).toEqual([[], [expect.anything()]]);
  });

  test('bring a client that listens what the server sends of its own: a subscription’s notifications, a command, a call relayed to it', async () => {
    await using connected = await connectHTTP();
    const { client, server } = connected;
    const heard: string[] = [];
    const connectionHandle = server.transport.clients[0]
      ?.connectionHandle as TransportServerConnectionHandle;

    await using subscribed = await client.services.getNotification(news, {
      serializer: { ...text, decodeNotification: text.decode },
    })('subscribe', (notification) => {
      heard.push(notification);
    })();

    expect(subscribed.unregister).toBeInstanceOf(Function);
    await connected.notify('first');
    await connected.notify('second');
    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['first', 'second']);

    // the server asks, and the client answers
    client.services.getRequestResolver(ping, { serializer: text })((request, response) => {
      return response(`${request.payload} pong`);
    });

    await expect(
      server.services.getCommand(ping, { serializer: text })('ping')({
        connectionHandle,
        timeout: 5_000,
      })
    ).resolves.toBe('ping pong');

    // a call another client makes, relayed to this one
    const requester = createHTTPClient();

    client.services.getRequestResolver(echo, { serializer: text })((request, response) => {
      return response(request.payload.toUpperCase());
    });
    server.router.registerDestination({ connectionHandle }, { destinationId: 5 });

    try {
      await requester.connect({ host, port: connected.port });
      await requester.services.getRequest(openSession, { serializer: text })('me')();
      await expect(
        requester.services.getRequest(echo, { serializer: text })('hi')({ destinationId: 5 })
      ).resolves.toBe('HI');
    } finally {
      await requester[Symbol.asyncDispose]();
    }
  });

  test('relay a call from an HTTP requester to a target behind a WebSocket, once a session admits it', async () => {
    const target = createWSServer({ transport: { WebSocketServer } });
    const { port: targetPort } = await target.transport.start({
      address: host,
      findOpenPort: true,
    });
    const [, TrackedWebSocket] = IMPLEMENTATIONS[1];
    const toTarget = createWSClient({ transport: { WebSocket: TrackedWebSocket } });

    target.services.getRequestResolver(echo, { serializer: text })((request, response) => {
      return response(request.payload.toUpperCase());
    });
    await toTarget.connect({ host, port: targetPort });

    try {
      await using connected = await connectHTTP();
      const { client, server } = connected;
      const echoing = client.services.getRequest(echo, { serializer: text });

      server.router.registerDestination(toTarget.router, { destinationId: 7 });

      await expect(echoing('hi')({ destinationId: 7 })).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
      });
      await client.services.getRequest(openSession, { serializer: text })('me')();
      await expect(echoing('hi')({ destinationId: 7 })).resolves.toBe('HI');
    } finally {
      await toTarget[Symbol.asyncDispose]();
      await target[Symbol.asyncDispose]();
      await allClosed();
    }
  });

  test('pass nothing on to a connection drawn over HTTP whose client does not listen, which takes no request of the server’s', async () => {
    await using connected = await connectHTTP({ isListening: false });
    const { client, server } = connected;
    const connectionHandle = server.transport.clients[0]?.connectionHandle;

    if (connectionHandle !== undefined) {
      server.router.registerDestination({ connectionHandle }, { destinationId: 9 });
    }

    await client.services.getRequest(openSession, { serializer: text })('me')();

    await expect(
      client.services.getRequest(echo, { serializer: text })('hi')({ destinationId: 9 })
    ).rejects.toMatchObject({
      code: ProtocolCode.DESTINATION_UNREACHABLE,
      detail: 'destination 9 is unreachable: its connection carries no request',
    });
  });

  test('relay a call whose leg B goes over HTTP: refused there, nothing tried; lost there, it may have run', async () => {
    await using connected = await connectHTTP();
    const { client, server } = connected;
    const fake = createFakeFetch();
    const legB = createHTTPClient({ transport: { fetch: fake.fetch, isListening: false } });
    const connecting = legB.connect({ host, port: 1 });

    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    await connecting;
    server.router.registerDestination(legB.router, { destinationId: 7 });
    await client.services.getRequest(openSession, { serializer: text })('me')();

    const echoing = client.services.getRequest(echo, { serializer: text });
    const nextCall = async (count: number) => {
      await expect
        .poll(() => {
          return fake.calls.length;
        })
        .toBe(count);

      return fake.calls[count - 1];
    };

    const refused = echoing('hi')({ destinationId: 7 });

    (await nextCall(2))?.answer({ headers: { [REFUSAL_HEADER]: 'busy' }, status: 429 });

    await expect(refused).rejects.toMatchObject({
      code: ProtocolCode.DESTINATION_UNREACHABLE,
      relays: 0,
    });

    const lost = echoing('hi')({ destinationId: 7 });

    (await nextCall(3))?.fail();

    await expect(lost).rejects.toMatchObject({ code: ProtocolCode.DESTINATION_LOST, relays: 0 });
    legB.transport.removeAllListeners();
  });

  test('refuse a body past the envelope its router takes, 413, before the router reads any of it', async () => {
    await using connected = await connectHTTP({
      server: { limits: { maximumEnvelopeBytes: 1_024 } },
    });
    const url = `http://${host}:${String(connected.port)}/bead`;
    const drawn = await fetch(url, {
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      method: 'POST',
    });
    const outcome = await fetch(url, {
      body: new Uint8Array(1_025),
      headers: {
        'content-type': BEAD_MEDIA_TYPE,
        [CONNECTION_TOKEN_HEADER]: drawn.headers.get(CONNECTION_TOKEN_HEADER) ?? '',
      },
      method: 'POST',
    }).then(
      (refused) => {
        return `${String(refused.status)} ${String(refused.headers.get(REFUSAL_HEADER))}`;
      },
      () => {
        return 'reset';
      }
    );

    // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
    expect(outcome).toMatch(/^(?:413 too-large|reset)$/u);

    // the connection drawn by hand, ended by hand
    await fetch(url, {
      headers: { [CONNECTION_TOKEN_HEADER]: drawn.headers.get(CONNECTION_TOKEN_HEADER) ?? '' },
      method: 'DELETE',
    });
  });

  test('build its router with the pacing its options give', async () => {
    await using server = createHTTPServer({
      pacing: { maximumQueuedNotifications: 3 },
      transport: {
        createServer: (listener) => {
          return createServer(listener);
        },
      },
    });

    expect(server.gauges().router.ceilings).toMatchObject({ largestQueuedNotifications: 3 });
  });

  test('refuse limits that ask for a transfer', () => {
    expect(() => {
      return createHTTPServer({
        limits: { maximumTransfers: 2 },
        transport: {
          createServer: (listener) => {
            return createServer(listener);
          },
        },
      });
    }).toThrow(ProgrammerError);
    expect(() => {
      return createHTTPClient({ limits: { maximumTransfers: 2 } });
    }).toThrow(ProgrammerError);
  });

  test('refuse an inactivity timeout of 0, which its default does not stand in for', () => {
    expect(() => {
      return createHTTPServer({
        connectionInactivityTimeout: 0,
        transport: {
          createServer: (listener) => {
            return createServer(listener);
          },
        },
      });
    }).toThrow(
      "a connection's inactivity timeout is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 0"
    );
  });
});
