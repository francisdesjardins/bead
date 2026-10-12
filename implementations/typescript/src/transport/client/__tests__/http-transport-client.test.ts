import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import {
  createHTTPTransportServer,
  ENVELOPE_KINDS,
  type HTTPTransportServer,
} from '../../server/http-transport-server';
import type { TransportServerConnectionHandle } from '../../server/types';
import {
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  TimeoutError,
} from '../../shared/errors';
import { createTestClock, tcpSocketsClosed, timersUntil } from '../../shared/__tests__/fixtures';
import {
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CONNECT_DEFAULTS,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  DISCONNECT_TIMEOUT,
  INACTIVITY_TIMEOUT,
  createHTTPTransportClient,
  LISTEN_HEADER,
  REFUSAL_HEADER,
  RETRY_DELAYS,
  SEQUENCE_HEADER,
  WAIT,
  type HTTPTransportClient,
  type IHTTPTransportClientOptions,
} from '../http-transport-client';
import { dispose } from '../transport-client';
import type { ITransportMessage } from '../../shared/types';
import type { ITransportClientInternal } from '../types';
import { createFakeFetch, responseOf } from './fake-fetch';

// helpers

const host = '127.0.0.1';

/** A bearer credential, RFC 6750's own example, its auth-scheme included. */
const BEARER = 'Bearer mF_9.B5f-4.1JqM';

/** An envelope as the transports read it: its layout, its kind, its call id, and `extra` bytes. */
const envelopeOf = (kind: number, { callId, extra = 0 }: { callId: number; extra?: number }) => {
  const bytes = new Uint8Array(8 + extra).fill(3);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, 0xa1);
  view.setUint8(1, kind);
  view.setUint32(4, callId);

  return bytes;
};

/** A transport server on a free port, and the handles of the connections it drew. */
const startServer = async () => {
  const server = createHTTPTransportServer({
    createServer: (listener) => {
      return createServer(listener);
    },
  });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const closes: [boolean, TransportServerConnectionHandle][] = [];

  server.on('close', (wasClean, connectionHandle) => {
    closes.push([wasClean, connectionHandle]);
  });

  return {
    closes,
    port,
    server,
    [Symbol.asyncDispose]: () => {
      return server.stop();
    },
  };
};

const nextEvent = (client: HTTPTransportClient, event: 'close' | 'message') => {
  return new Promise<unknown[]>((resolve) => {
    client.once(event, (...params) => {
      resolve(params);
    });
  });
};

/**
 * Whether a client carries a credential, and is secure, once a connect to `target` was tried — the
 * judgement made from the URL it was given, the network down.
 */
const judgedOf = async (target: { host: string; secured?: boolean }) => {
  const client = createHTTPTransportClient({
    fetch: () => {
      return Promise.reject(new Error('the network is down'));
    },
    isListening: false,
  });

  await client.connect({ ...target, port: 8_080 }).catch(() => {});

  return [client.carriesCredential, client.isSecure];
};

const handleOf = (server: HTTPTransportServer) => {
  return server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle;
};

/** A client on a fake fetch, connected: its first call drew the connection. */
const connectFake = async (respond?: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(respond);
  const client = createHTTPTransportClient({ isListening: false, fetch: fake.fetch });
  const connecting = client.connect({ host, port: 8_080 });

  if (respond === undefined) {
    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
  }

  await connecting;

  return { client, fake };
};

// definition

test.describe('createHTTPTransportClient, what it carries', () => {
  test('carries a credential beside an envelope, in its POST’s Authorization, and is secure under https or to a loopback host, judged by the URL it was given', async () => {
    expect(createHTTPTransportClient().isSecure).toBe(false);
    expect(
      await Promise.all([
        judgedOf({ host: 'bead.example', secured: true }),
        judgedOf({ host: 'localhost' }),
        judgedOf({ host: '127.0.0.1' }),
        judgedOf({ host: '::1' }),
        judgedOf({ host: 'bead.example' }),
        judgedOf({ host: '192.0.2.1' }),
      ])
    ).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [true, false],
      [true, false],
    ]);
  });
});

test.describe('createHTTPTransportClient', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('draws its connection, sends an envelope settled on the head of its answer, and hears the answer as a message', async () => {
    await using started = await startServer();
    const { port, server } = started;
    const client = createHTTPTransportClient({ isListening: false });
    const heard: unknown[] = [];

    client.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);
    });
    await client.connect({ host, port });

    expect(client.isOpen()).toBe(true);
    expect(client.socket).toEqual({ url: `http://${host}:${String(port)}/bead` });
    expect(JSON.stringify(client.socket)).not.toContain(CONNECTION_TOKEN_HEADER);

    // settled once the server has it, before any answer
    await client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    expect(heard).toEqual([]);

    const message = nextEvent(client, 'message');

    await server.send(
      { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1, extra: 2 }) },
      handleOf(server)
    );
    await message;

    expect(heard).toEqual([[...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1, extra: 2 })]]);

    // a cancel ends empty: nothing is heard
    await client.send({ data: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }) });
    await client.disconnect();

    expect(heard).toHaveLength(1);
  });

  test('rejects an exchange the server refused, nothing tried, and stays open', async () => {
    await using started = await startServer();
    const client = createHTTPTransportClient({ isListening: false });

    await client.connect({ host, port: started.port });

    // a request on the server's own parity
    await expect(
      client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 2 }) })
    ).rejects.toThrow(new GenericError('the server refused the exchange: 400 malformed'));
    expect(client.isOpen()).toBe(true);
    await client.disconnect();
  });

  test('carries its credential in the Authorization of its POST, which the server hands on with the request, and hears the answer with none', async () => {
    await using started = await startServer();
    const { port, server } = started;
    const client = createHTTPTransportClient({ isListening: false });
    const taken: unknown[] = [];

    server.on('message', ({ credential }, connectionHandle) => {
      taken.push(credential);
      void server.send(
        { credential: BEARER, data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) },
        connectionHandle
      );
    });
    await client.connect({ host, port });

    const message = nextEvent(client, 'message');

    await client.send({
      credential: BEARER,
      data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
    });

    const [{ credential }] = (await message) as [ITransportMessage];

    expect([taken, credential]).toEqual([[BEARER], undefined]);
    await client.disconnect();
  });

  test('writes Authorization only with a credential, and refuses one no field carries before it goes, its connection kept', async () => {
    const { client, fake } = await connectFake();
    const carrying = client.send({
      credential: BEARER,
      data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
    });

    fake.calls[1]?.answer({ status: 204 });
    await carrying;

    const bare = client.send({ data: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }) });

    fake.calls[2]?.answer({ status: 204 });
    await bare;

    expect(fake.calls[1]?.init.headers).toMatchObject({ authorization: BEARER });
    expect(fake.calls[2]?.init.headers).not.toHaveProperty('authorization');

    for (const credential of ['Bearer a\r\nb', 'Bearer é', 'Bearer \u0000']) {
      await expect(
        client.send({ credential, data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }) }),
        JSON.stringify(credential)
      ).rejects.toThrow(
        new ProgrammerError('a credential holds visible ASCII, spaces and tabs alone')
      );
    }

    expect([fake.calls.length, client.isOpen()]).toEqual([3, true]);
  });

  test('disconnects by a DELETE, the server closing first, and closes clean', async () => {
    await using started = await startServer();
    const { closes, port, server } = started;
    const client = createHTTPTransportClient({ isListening: false });

    await client.connect({ host, port });

    const connectionHandle = handleOf(server);
    const closed = nextEvent(client, 'close');

    await client.disconnect({ isClean: true });

    expect(await closed).toEqual([true, false]);
    expect(closes).toEqual([[true, connectionHandle]]);
    expect(client.isClosed()).toBe(true);
    expect(client.socket).toBeNull();
    await expect(client.disconnect()).rejects.toBeInstanceOf(ReadyStateError);
    await expect(client.send({ data: new Uint8Array(8) })).rejects.toBeInstanceOf(ReadyStateError);
  });

  test('closes once the server says the connection is gone, after rejecting the exchange that learned it', async () => {
    await using started = await startServer();
    const { port, server } = started;
    const client = createHTTPTransportClient({ isListening: false });
    const order: string[] = [];

    await client.connect({ host, port });
    client.on('close', (...params) => {
      order.push(`close ${JSON.stringify(params)}`);
    });
    await server.close(handleOf(server));

    await client
      .send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) })
      .catch((reason: unknown) => {
        order.push(`rejected ${(reason as Error).message}`);
      });
    await expect
      .poll(() => {
        return order;
      })
      .toEqual([
        'rejected the server refused the exchange: 404 connection-unknown',
        'close [false,false]',
      ]);
    expect(client.isClosed()).toBe(true);
  });

  test('closes, and tells the server, when the server is lost under an exchange, which counts as handed over', async () => {
    const { client, fake } = await connectFake();
    const closed = nextEvent(client, 'close');
    const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    fake.calls[1]?.fail();

    await expect(sending).resolves.toBeUndefined();
    expect(await closed).toEqual([false, false]);
    expect(
      fake.calls.map(({ init }) => {
        return [init.method, init.headers[CONNECTION_TOKEN_HEADER], init.keepalive];
      })
    ).toEqual([
      ['POST', undefined, undefined],
      ['POST', 'T'.repeat(22), undefined],
      ['DELETE', 'T'.repeat(22), true],
    ]);
  });

  test('counts a status nothing marked — a gateway’s, a proxy’s — as an exchange lost, which may have run', async () => {
    for (const status of [404, 502, 504]) {
      const { client, fake } = await connectFake();
      const closed = nextEvent(client, 'close');
      const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

      fake.calls[1]?.answer({ status });

      await expect(sending, String(status)).resolves.toBeUndefined();
      expect(await closed).toEqual([false, false]);
      // the server is told, when it can be
      expect(fake.calls[2]?.init).toMatchObject({ keepalive: true, method: 'DELETE' });
    }
  });

  test('rejects a refusal the server marked, and keeps its connection', async () => {
    const { client, fake } = await connectFake();
    const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    fake.calls[1]?.answer({ headers: { [REFUSAL_HEADER]: 'busy' }, status: 429 });

    await expect(sending).rejects.toThrow('the server refused the exchange: 429 busy');
    expect(client.isOpen()).toBe(true);
  });

  test('closes on an answer that is no envelope, or larger than an envelope, and hears nothing of it', async () => {
    for (const answer of [
      { body: new TextEncoder().encode('<html>'), headers: { 'content-type': 'text/html' } },
      {
        body: new Uint8Array(9),
        headers: { 'content-length': '9', 'content-type': BEAD_MEDIA_TYPE },
      },
      { body: new Uint8Array(9), headers: { 'content-type': BEAD_MEDIA_TYPE } },
    ]) {
      const fake = createFakeFetch();
      const client = createHTTPTransportClient({
        isListening: false,
        fetch: fake.fetch,
        maximumBodyBytes: 8,
      });
      const heard: unknown[] = [];
      const connecting = client.connect({ host, port: 80 });

      fake.calls[0]?.answer({
        headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) },
        status: 201,
      });
      await connecting;
      client.on('message', ({ data }) => {
        heard.push(data);
      });

      const closed = nextEvent(client, 'close');

      const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

      fake.calls[1]?.answer({ ...answer, status: 200 });
      await sending;

      expect(await closed).toEqual([false, false]);
      expect(heard).toEqual([]);
    }
  });

  test('reads an answer of its type whatever its case or parameters, up to its limit exactly, and closes on one declared past it, unread', async () => {
    const answers = [
      {
        body: new Uint8Array(16).fill(1),
        headers: { 'content-length': '16', 'content-type': 'Application/PRS.Bead; charset=binary' },
      },
      // its length said wrong: past the limit, whatever comes
      {
        body: new Uint8Array(16).fill(2),
        headers: { 'content-length': '17', 'content-type': BEAD_MEDIA_TYPE },
      },
    ];
    const heard: number[] = [];
    let isClosed = false;

    for (const answer of answers) {
      const fake = createFakeFetch();
      const client = createHTTPTransportClient({
        isListening: false,
        fetch: fake.fetch,
        maximumBodyBytes: 16,
      });
      const connecting = client.connect({ host, port: 80 });

      fake.calls[0]?.answer({
        headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) },
        status: 201,
      });
      await connecting;
      client.on('message', ({ data }) => {
        heard.push(new Uint8Array(data as ArrayBuffer)[0] ?? 0);
      });
      client.on('close', () => {
        isClosed = true;
      });

      const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

      fake.calls[1]?.answer({ ...answer, status: 200 });
      await sending;
      await expect
        .poll(() => {
          return heard.length > 0 || isClosed;
        })
        .toBe(true);
    }

    expect([heard, isClosed]).toEqual([[1], true]);
  });

  test('hears nothing of an answer ended empty, nor of one whose connection went while it came', async () => {
    const { client, fake } = await connectFake();
    const heard: unknown[] = [];

    client.on('message', ({ data }) => {
      heard.push(data);
    });

    // cancelled: its exchange ends with no body
    const cancelled = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    fake.calls[1]?.answer({ headers: { 'content-type': BEAD_MEDIA_TYPE }, status: 200 });
    await cancelled;

    const { promise: later, resolve: bodyCame } = Promise.withResolvers<Uint8Array>();
    const coming = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }) });

    fake.calls[2]?.answer({ headers: { 'content-type': BEAD_MEDIA_TYPE }, later, status: 200 });
    await coming;

    // another exchange lost: the connection goes, and the answer still coming with it
    const closed = nextEvent(client, 'close');
    const lost = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 5 }) });

    fake.calls[3]?.fail();
    await lost;
    await closed;
    bodyCame(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }));
    await later;
    await Promise.resolve();

    expect(heard).toEqual([]);
  });

  test('reports a listener that throws on an answer, and stays open', async () => {
    const { client, fake } = await connectFake();
    const thrown = new Error('a listener that throws');
    const reported: Error[] = [];
    const told: unknown[] = [];

    client.on('message', () => {
      throw thrown;
    });
    client.on('message', ({ data }) => {
      told.push(data);
    });
    client.on('error', (error) => {
      reported.push(error);
    });

    const sent = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    fake.calls[1]?.answer({
      body: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }),
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      status: 200,
    });
    await sent;
    await expect
      .poll(() => {
        return told.length;
      })
      .toBe(1);

    // the listener after it told all the same, the throw reported as it was thrown
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(thrown);
    expect(client.isOpen()).toBe(true);
    await client.disconnect({ isQuick: true });
  });

  test('closes once, telling the server once, however many exchanges learn it is lost; tells a server that said it is gone nothing', async () => {
    const { client, fake } = await connectFake();
    const closes: unknown[] = [];

    client.on('close', (...params) => {
      closes.push(params);
    });

    const first = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });
    const second = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }) });

    fake.calls[1]?.fail();
    fake.calls[2]?.fail();
    await Promise.all([first, second]);

    const deletes = fake.calls.filter(({ init }) => {
      return init.method === 'DELETE';
    });

    expect([closes, deletes.length]).toEqual([[[false, false]], 1]);

    const told = await connectFake();
    const closed = nextEvent(told.client, 'close');
    const refused = told.client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    told.fake.calls[1]?.answer({
      headers: { [REFUSAL_HEADER]: CONNECTION_UNKNOWN },
      status: 404,
    });

    await expect(refused).rejects.toBeInstanceOf(GenericError);
    await closed;
    expect(
      told.fake.calls.map(({ init }) => {
        return init.method;
      })
    ).toEqual(['POST', 'POST']);
  });

  test('closes on an answer with no type, or whose body is lost on its way', async () => {
    for (const answer of [
      { headers: {} },
      { headers: { 'content-type': BEAD_MEDIA_TYPE }, isBodyLost: true },
    ]) {
      const { client, fake } = await connectFake();
      const closed = nextEvent(client, 'close');
      const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

      fake.calls[1]?.answer({ ...answer, status: 200 });
      await sending;

      expect(await closed).toEqual([false, false]);
    }
  });

  test('lets go of a connection drawn as its connect gave up, and closes even when the server cannot hear its DELETE', async () => {
    const drawn = createFakeFetch();
    const client = createHTTPTransportClient({ isListening: false, fetch: drawn.fetch });
    const connecting = client.connect({ host, port: 80 });

    // drawn, then dropped before the connect heard it
    drawn.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    (client as ITransportClientInternal<object, never>)[dispose]();

    await expect(connecting).rejects.toThrow(new ConnectError('disposed while connecting'));
    expect(drawn.calls[1]?.init).toMatchObject({
      headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) },
      method: 'DELETE',
    });

    const { client: connected, fake } = await connectFake();
    // how long it waits on the server, at most
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'timeout'
    ) as PropertyDescriptor;
    const timeoutOf = AbortSignal.timeout.bind(AbortSignal);
    const delays: number[] = [];

    AbortSignal.timeout = (delay) => {
      delays.push(delay);

      return timeoutOf(delay);
    };

    try {
      const disconnecting = connected.disconnect();

      fake.calls[1]?.fail();

      await disconnecting;
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', descriptor);
    }

    expect([connected.isClosed(), delays]).toEqual([true, [DISCONNECT_TIMEOUT]]);
  });

  test('bounds its disconnect on the real clock, whatever its own: a server that never answers the DELETE is let go once DISCONNECT_TIMEOUT has passed', async () => {
    // played in real time, as a platform's own bound is: no clock given moves it
    test.setTimeout(DISCONNECT_TIMEOUT * 4);

    const clock = createTestClock();
    const fake = createFakeFetch();
    const client = createHTTPTransportClient({ clock, fetch: fake.fetch, isListening: false });
    const connecting = client.connect({ host, port: 8_080 });

    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    await connecting;

    const started = performance.now();
    const { armed } = await timersUntil(clock, () => {
      return client.disconnect();
    });

    expect(fake.calls[1]?.init.method).toBe('DELETE');
    expect(fake.calls[1]?.init.signal?.aborted).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(DISCONNECT_TIMEOUT - 50);
    expect([client.isClosed(), armed]).toEqual([true, []]);
  });

  test('settles its send on the head of the answer, before its body is in, and hears the answer once it is', async () => {
    const answer = envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 });
    const { promise: later, resolve: bodyCame } = Promise.withResolvers<Uint8Array>();
    const { client } = await connectFake((init) => {
      return init.body === undefined
        ? responseOf({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 })
        : responseOf({ headers: { 'content-type': BEAD_MEDIA_TYPE }, later, status: 200 });
    });
    const heard: string[] = [];

    client.on('message', () => {
      heard.push('message');
    });

    const sending = client
      .send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) })
      .then(() => {
        heard.push('settled');
      });

    heard.push('sent');
    await sending;

    expect(heard).toEqual(['sent', 'settled']);

    bodyCame(answer);

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['sent', 'settled', 'message']);
  });

  test('refuses to connect where no connection is drawn, and lets go of one drawn as it gave up', async () => {
    const refused = createFakeFetch();
    const client = createHTTPTransportClient({ isListening: false, fetch: refused.fetch });
    const connecting = client.connect({ host: '::1', pathname: 'api', port: 8_080, secured: true });

    refused.calls[0]?.answer({ status: 503 });

    await expect(connecting).rejects.toThrow(
      new ConnectError('the server drew no connection: 503')
    );

    // a token without its 201, or a 201 without its token, draws nothing
    for (const answer of [
      { headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 200 },
      { status: 201 },
    ]) {
      const odd = createFakeFetch();
      const oddly = createHTTPTransportClient({ isListening: false, fetch: odd.fetch }).connect({
        host,
        port: 80,
      });

      odd.calls[0]?.answer(answer);

      await expect(oddly).rejects.toThrow(
        new ConnectError(`the server drew no connection: ${String(answer.status)}`)
      );
    }
    expect(refused.calls[0]?.url).toBe('https://[::1]:8080/api');
    expect(client.isClosed()).toBe(true);

    const unreachable = createFakeFetch();
    const failed = createHTTPTransportClient({ isListening: false, fetch: unreachable.fetch });
    const failing = failed.connect({ host, port: 1 });

    unreachable.calls[0]?.fail(new TypeError('connect ECONNREFUSED'));

    await expect(failing).rejects.toThrow('connect ECONNREFUSED');
    await expect(failing).rejects.toBeInstanceOf(ConnectError);

    // timed out: its fetch aborted, and a token drawn meanwhile deleted
    const slow = createFakeFetch();
    const late = createHTTPTransportClient({ isListening: false, fetch: slow.fetch });

    await expect(late.connect({ host, port: 80, timeout: 20 })).rejects.toBeInstanceOf(
      TimeoutError
    );
    expect(slow.calls[0]?.init.signal?.aborted).toBe(true);
    expect(CONNECT_DEFAULTS.pathname).toBe('/bead');
  });

  test('a drop aborts what is in flight, tells the server, and a dispose while connecting rejects the connect', async () => {
    const { client, fake } = await connectFake();
    const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    (client as ITransportClientInternal<object, never>)[dispose]();

    await expect(sending).resolves.toBeUndefined();
    expect(fake.calls[1]?.init.signal?.aborted).toBe(true);
    expect(fake.calls[2]?.init).toMatchObject({ keepalive: true, method: 'DELETE' });
    expect(client.socket).toBeNull();

    const connecting = createFakeFetch();
    const disposed = createHTTPTransportClient({ isListening: false, fetch: connecting.fetch });
    const attempt = disposed.connect({ host, port: 80 });

    (disposed as ITransportClientInternal<object, never>)[dispose]();

    await expect(attempt).rejects.toThrow(new ConnectError('disposed while connecting'));
  });

  test('disconnects quickly without waiting on the server, which is told all the same', async () => {
    const { client, fake } = await connectFake();
    const closed = nextEvent(client, 'close');

    await client.disconnect({ isClean: false, isQuick: true });

    expect(await closed).toEqual([false, true]);
    expect(fake.calls[1]?.init).toMatchObject({ keepalive: true, method: 'DELETE' });
  });

  test('reconnects to a connection drawn anew', async () => {
    await using started = await startServer();
    const { port, server } = started;
    const client = createHTTPTransportClient({ isListening: false });

    await client.connect({ host, port });

    const first = handleOf(server);

    await client.reconnect();

    expect(client.isOpen()).toBe(true);
    expect(handleOf(server)).not.toBe(first);
    await client.disconnect();
  });

  test('marks its refusals as the server does', () => {
    expect([REFUSAL_HEADER, CONNECTION_UNKNOWN]).toEqual(['bead-refusal', 'connection-unknown']);
  });
});

/** What a listen brings back of `envelopes`: each after its length in 4 bytes. */
const batchOf = (...envelopes: Uint8Array[]): Uint8Array => {
  return Uint8Array.from(
    envelopes.flatMap((envelope) => {
      const length = new Uint8Array(4);

      new DataView(length.buffer).setUint32(0, envelope.length);

      return [...length, ...envelope];
    })
  );
};

/** A client that listens, on a fake fetch, connected; what it heard; the call of rank `index`, once made. */
const connectListening = async (options?: Partial<IHTTPTransportClientOptions>) => {
  const fake = createFakeFetch();
  const client = createHTTPTransportClient({ fetch: fake.fetch, ...options });
  const heard: number[][] = [];
  const connecting = client.connect({ host, port: 8_080 });

  fake.calls[0]?.answer({
    headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22), [LISTEN_HEADER]: '?1' },
    status: 201,
  });
  await connecting;
  client.on('message', ({ data }) => {
    heard.push([...new Uint8Array(data as ArrayBuffer)]);
  });

  const callOf = async (index: number) => {
    await expect
      .poll(() => {
        return fake.calls.length;
      })
      .toBeGreaterThan(index);

    return fake.calls[index];
  };

  return { callOf, client, fake, heard };
};

/** A batch of `envelopes`, the first numbered `first`. */
const batch = (first: number, ...envelopes: Uint8Array[]) => {
  return {
    body: batchOf(...envelopes),
    headers: { 'content-type': BEAD_BATCH_MEDIA_TYPE, [SEQUENCE_HEADER]: String(first) },
    status: 200,
  };
};

/**
 * A fake fetch on which the first `lost` listens are lost, and any after is told its connection is
 * gone: it draws a listening connection, and takes its DELETE.
 */
const losingFetch = (lost = Infinity) => {
  let listens = 0;

  return createFakeFetch((init) => {
    if (init.method === 'GET') {
      listens += 1;

      if (listens > lost) {
        return responseOf({ headers: { [REFUSAL_HEADER]: CONNECTION_UNKNOWN }, status: 404 });
      }

      throw new TypeError('fetch failed');
    }

    return init.method === 'POST'
      ? responseOf({
          headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22), [LISTEN_HEADER]: '?1' },
          status: 201,
        })
      : responseOf({ status: 204 });
  });
};

/** The methods of `fake`'s calls, and how many listens of them there were. */
const methodsOf = (fake: ReturnType<typeof createFakeFetch>) => {
  const methods = fake.calls.map(({ init }) => {
    return init.method;
  });
  const listens = methods.filter((method) => {
    return method === 'GET';
  }).length;

  return { last: methods.at(-1), listens };
};

/** The closes `client` tells, as they come: read when wanted, never waited on. */
const closesOf = (client: HTTPTransportClient) => {
  const closes: unknown[][] = [];

  client.on('close', (...params) => {
    closes.push(params);
  });

  return closes;
};

/**
 * A test clock whose timers end a millisecond before they are due, as a timer can against a clock
 * read on a loaded machine.
 */
const hastyClockOf = () => {
  const clock = createTestClock();
  const { setTimeout: onTime } = clock;

  clock.setTimeout = (callback, delay = 0) => {
    return onTime(callback, delay > 0 ? delay - 1 : delay);
  };

  return clock;
};

test.describe('createHTTPTransportClient, listening', () => {
  test('says at connect that it listens, then listens: a batch heard in order, acknowledged by the next listen', async () => {
    const { callOf, client, fake, heard } = await connectListening({ wait: 1_000 });
    const first = envelopeOf(0x13, { callId: 1 });
    const second = envelopeOf(0x10, { callId: 2, extra: 2 });
    const credentials: unknown[] = [];

    // what a listen brings back carries no credential
    client.on('message', ({ credential }) => {
      credentials.push(credential);
    });

    expect(fake.calls[0]?.init.headers).toMatchObject({ [LISTEN_HEADER]: '?1' });
    expect([(await callOf(1))?.url, (await callOf(1))?.init]).toMatchObject([
      `http://${host}:8080/bead?after=0&wait=1000`,
      { headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, method: 'GET', redirect: 'error' },
    ]);

    (await callOf(1))?.answer(batch(1, first, second));

    expect((await callOf(2))?.url).toContain('?after=2&');
    expect([heard, credentials]).toEqual([
      [[...first], [...second]],
      [undefined, undefined],
    ]);

    // nothing, and it listens again at the same point
    (await callOf(2))?.answer({ status: 204 });

    expect((await callOf(3))?.url).toContain('?after=2&');
    await client.disconnect({ isQuick: true });
    expect(fake.calls[3]?.init.signal?.aborted).toBe(true);
    expect(WAIT).toBe(25_000);
  });

  test('marks what a listen brings back as what may overtake, and never what a POST’s body brings', async () => {
    const { client, fake } = await connectListening({ wait: 1_000 });
    const marks: unknown[] = [];
    const callBy = async (method: string) => {
      await expect
        .poll(() => {
          return fake.calls.slice(1).some(({ init }) => {
            return init.method === method;
          });
        })
        .toBe(true);

      return fake.calls.slice(1).find(({ init }) => {
        return init.method === method;
      });
    };

    client.on('message', ({ mayOvertake }) => {
      marks.push(mayOvertake);
    });

    const sending = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    (await callBy('POST'))?.answer({
      body: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }),
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      status: 200,
    });
    await sending;
    await expect
      .poll(() => {
        return marks.length;
      })
      .toBe(1);
    (await callBy('GET'))?.answer(batch(1, envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 })));
    await expect
      .poll(() => {
        return marks.length;
      })
      .toBe(2);

    expect(marks).toEqual([undefined, true]);
    await client.disconnect({ isQuick: true });
  });

  test('listens again from where it was when a listen is lost — at once, then later and later, drawn apart — and one that reaches the server ends the losses', async () => {
    const clock = createTestClock();
    const { callOf, client, fake, heard } = await connectListening({ clock });
    // what the connect armed, its timeout, stays out of what the listens arm
    const connected = clock.armed.length;
    const first = await callOf(1);
    const envelope = envelopeOf(0x13, { callId: 1 });
    // each wait drawn between half of what it may be and all of it: short of its half, no listen;
    // at all of it, the next
    const waitOut = async (wait: number) => {
      const calls = fake.calls.length;

      await clock.tickAsync(wait / 2 - 1);

      expect(fake.calls.length).toBe(calls);

      await clock.tickAsync(wait / 2 + 1);
      await callOf(calls);
    };

    first?.fail();
    await callOf(2);

    for (const [losses, wait] of [
      [2, 1_000],
      [3, 2_000],
      [4, 4_000],
      [5, 8_000],
      [6, 16_000],
      [7, 30_000],
      [8, 30_000],
    ] as const) {
      // a batch cut before anything came whole is a loss as well
      if (losses === 3) {
        fake.calls.at(-1)?.answer({ ...batch(1, envelope), isBodyLost: true });
      } else {
        fake.calls.at(-1)?.fail();
      }

      await waitOut(wait);
    }

    // a 200 of another type — a proxy's page — is lost too, its body unread
    fake.calls.at(-1)?.answer({
      body: new TextEncoder().encode('<html>'),
      headers: { 'content-type': 'text/html' },
      status: 200,
    });
    await waitOut(30_000);

    // it reaches the server: the losses end, and the next is listened again at once
    fake.calls.at(-1)?.answer({ status: 204 });
    await callOf(11);
    fake.calls.at(-1)?.fail();
    await callOf(12);

    // the inactivity timeout armed at the first loss of each count, then the waits between, each
    // within its bounds
    const delays = clock.armed.slice(connected).map(({ delay }) => {
      return delay;
    });

    expect([delays[0], delays.at(-1), delays.length]).toEqual([
      INACTIVITY_TIMEOUT,
      INACTIVITY_TIMEOUT,
      10,
    ]);
    expect(
      delays.slice(1, -1).map((delay, index) => {
        const wait = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000][index] ?? 0;

        return delay >= wait / 2 && delay <= wait;
      })
    ).toEqual(
      Array.from({ length: 8 }, () => {
        return true;
      })
    );
    expect([client.isOpen(), fake.calls.length]).toEqual([true, 13]);

    // what was cut on its way comes whole at last, and is heard once
    (await callOf(12))?.answer(batch(1, envelope));

    expect((await callOf(13))?.url).toContain('?after=1&');
    expect(heard).toEqual([[...envelope]]);
    expect(RETRY_DELAYS).toEqual({ ceiling: 30_000, first: 1_000 });
    await client.disconnect({ isQuick: true });
  });

  test('counts its connection lost once its listens were lost for its inactivity timeout, and tells the server', async () => {
    const fake = losingFetch();
    const clock = createTestClock();
    const client = createHTTPTransportClient({ clock, fetch: fake.fetch, inactivityTimeout: 40 });
    const closes = closesOf(client);

    await client.connect({ host, port: 80 });

    // its last wait ends at its timeout, never after it
    await clock.tickAsync(39);

    expect([client.isOpen(), methodsOf(fake).listens]).toEqual([true, 2]);

    await clock.tickAsync(1);

    expect(closes).toEqual([[false, false]]);
    // at once, then no later than its timeout, then no more
    expect(methodsOf(fake)).toEqual({ last: 'DELETE', listens: 3 });
    expect(INACTIVITY_TIMEOUT).toBe(300_000);

    // a timeout within the second wait's range: whichever is drawn, it ends at its timeout
    for (let draws = 0; draws < 20; draws += 1) {
      const drawn = createHTTPTransportClient({
        clock,
        fetch: fake.fetch,
        inactivityTimeout: 700,
      });
      const closesDrawn = closesOf(drawn);

      await drawn.connect({ host, port: 80 });
      await clock.tickAsync(699);

      expect(drawn.isOpen()).toBe(true);

      await clock.tickAsync(1);

      expect(closesDrawn).toEqual([[false, false]]);
    }
  });

  test('times its inactivity on a timer, never on a reading of the wall clock: whether that leaps or goes back, the connection is lost at its timeout', async () => {
    for (const leap of [3_600_000, -3_600_000]) {
      // a wall clock moved an hour at each step — a machine woken from sleep, a clock set — buys
      // nothing and costs nothing: three listens, the last at its timeout
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      const leaping = losingFetch();
      const client = createHTTPTransportClient({
        clock,
        fetch: leaping.fetch,
        inactivityTimeout: 40,
      });
      const closes = closesOf(client);

      await client.connect({ host, port: 80 });

      for (let step = 0; step < 39; step += 1) {
        clock.setSystemTime(clock.Date.now() + leap);
        await clock.tickAsync(1);
      }

      expect([client.isOpen(), methodsOf(leaping).listens]).toEqual([true, 2]);

      clock.setSystemTime(clock.Date.now() + leap);
      await clock.tickAsync(1);

      expect([closes, methodsOf(leaping)]).toEqual([
        [[false, false]],
        { last: 'DELETE', listens: 3 },
      ]);
    }
  });

  // its timeout ends on its own timer, so a timer that ends early ends it early, and buys no listen
  // more
  test('listens three times within its inactivity timeout, even on timers that end early, and never a fourth', async () => {
    // a fourth is one too many: told gone, so that a burst ends there
    const fake = losingFetch(3);
    const clock = hastyClockOf();
    const client = createHTTPTransportClient({ clock, fetch: fake.fetch, inactivityTimeout: 40 });
    const closes = closesOf(client);

    await client.connect({ host, port: 80 });
    await clock.tickAsync(38);

    expect([client.isOpen(), methodsOf(fake).listens]).toEqual([true, 2]);

    await clock.tickAsync(1);

    expect(closes).toEqual([[false, false]]);

    // and nothing after it
    await clock.tickAsync(60_000);

    expect(methodsOf(fake)).toEqual({ last: 'DELETE', listens: 3 });
  });

  test('a listen heard ends the count, and its inactivity timeout runs again from the next first loss', async () => {
    const clock = createTestClock();
    const { callOf, client, fake } = await connectListening({ clock, inactivityTimeout: 40 });
    const first = await callOf(1);
    const closes = closesOf(client);

    // lost, listened again at once, and heard 30 ms later
    first?.fail();
    await clock.tickAsync(30);
    fake.calls[2]?.answer(batch(1, envelopeOf(0x13, { callId: 1 })));
    await clock.tickAsync(0);

    // past where the first count would have ended, lost twice again
    await clock.tickAsync(20);
    fake.calls[3]?.fail();
    await clock.tickAsync(0);
    fake.calls[4]?.fail();

    // 40 ms from this first loss, not from the one before
    await clock.tickAsync(39);

    expect([client.isOpen(), fake.calls.length]).toEqual([true, 5]);

    await clock.tickAsync(1);
    fake.calls[5]?.fail();
    await clock.tickAsync(0);

    expect(closes).toEqual([[false, false]]);
    expect(fake.calls[6]?.init.method).toBe('DELETE');
  });

  test('loses the connection on a batch that does not read, and on a refusal of its listen; told it is gone, it tells the server nothing', async () => {
    const envelope = envelopeOf(0x13, { callId: 1 });
    const framed = batchOf(envelope);
    const numbered = (first: string) => {
      return {
        ...batch(1, envelope),
        headers: { 'content-type': BEAD_BATCH_MEDIA_TYPE, [SEQUENCE_HEADER]: first },
      };
    };
    const answers = [
      { ...batch(1, envelope), headers: { 'content-type': BEAD_BATCH_MEDIA_TYPE } },
      // numbered other than from the one after the last it heard
      numbered('one'),
      numbered('01'),
      numbered('2'),
      { ...batch(1), body: Uint8Array.of(0, 0, 0, 0, ...framed) },
      { ...batch(1), body: new Uint8Array(0) },
      { ...batch(1), isBodiless: true },
      // ended in the middle of a length, or of an envelope
      { ...batch(1), body: Uint8Array.of(...framed, 0, 0) },
      { ...batch(1), body: Uint8Array.of(...framed, ...framed.slice(0, 6)) },
      // an envelope past the client's limit, however whole
      { ...batch(1), body: Uint8Array.of(0, 0, 0, 25, ...new Uint8Array(25)) },
      { headers: { [REFUSAL_HEADER]: 'listen-undeclared' }, status: 409 },
      { headers: { [REFUSAL_HEADER]: CONNECTION_UNKNOWN }, status: 404 },
    ];
    const told: boolean[] = [];
    const heardOf: number[] = [];

    for (const answer of answers) {
      const { callOf, client, fake, heard } = await connectListening({ maximumBodyBytes: 24 });
      const closed = nextEvent(client, 'close');

      (await callOf(1))?.answer(answer);

      expect(await closed, JSON.stringify(answer.headers)).toEqual([false, false]);
      heardOf.push(heard.length);
      told.push(
        fake.calls.some(({ init }) => {
          return init.method === 'DELETE';
        })
      );
    }

    expect(told).toEqual([true, true, true, true, true, true, true, true, true, true, true, false]);
    // what came whole before what does not read was heard, as it came
    expect(heardOf).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0]);

    // one of the limit exactly is heard
    const atLimit = await connectListening({ maximumBodyBytes: 24 });
    const largest = envelopeOf(0x13, { callId: 1, extra: 16 });

    (await atLimit.callOf(1))?.answer(batch(1, largest));

    expect((await atLimit.callOf(2))?.url).toContain('?after=1&');
    expect(atLimit.heard).toEqual([[...largest]]);
    await atLimit.client.disconnect({ isQuick: true });
  });

  test('asks the server to wait its wait held, a fraction rounded to the nearest whole millisecond', async () => {
    const { callOf, client } = await connectListening({ wait: 1.5 });

    expect((await callOf(1))?.url).toMatch(/&wait=2$/u);
    await client.disconnect({ isQuick: true });
  });

  test('pauses between listens that bring nothing, and listens no more once its connection went', async () => {
    const { callOf, client, fake } = await connectListening({ pause: 60, wait: 0 });

    expect((await callOf(1))?.url).toMatch(/&wait=0$/u);
    (await callOf(1))?.answer({ status: 204 });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    // not yet
    expect(fake.calls).toHaveLength(2);
    await callOf(2);

    // gone while it listens: what its listen brings back is heard by nobody, and it listens no more
    const closed = nextEvent(client, 'close');
    const lost = client.send({ data: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) });

    (await callOf(3))?.fail();
    await lost;
    await closed;
    fake.calls[2]?.answer(batch(1, envelopeOf(0x13, { callId: 1 })));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(
      fake.calls.map(({ init }) => {
        return init.method;
      })
    ).toEqual(['POST', 'GET', 'GET', 'POST', 'DELETE']);
  });

  test('hears the rest of a batch when a listener throws, the throw reported', async () => {
    const { callOf, client, heard } = await connectListening();
    const thrown = new Error('a listener that throws');
    const reported: Error[] = [];
    const told: unknown[] = [];
    let isFirst = true;

    client.on('message', () => {
      if (isFirst) {
        isFirst = false;

        throw thrown;
      }
    });
    client.on('message', ({ data }) => {
      told.push(data);
    });
    client.on('error', (error) => {
      reported.push(error);
    });

    (await callOf(1))?.answer(
      batch(1, envelopeOf(0x13, { callId: 1 }), envelopeOf(0x13, { callId: 3 }))
    );
    await expect
      .poll(() => {
        return heard.length;
      })
      .toBe(2);

    // the listener after it told of both, the throw reported once, as it was thrown
    expect(told).toHaveLength(2);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(thrown);
    await client.disconnect({ isQuick: true });
  });

  test('hears no more of a batch once its connection went while it was heard', async () => {
    const { callOf, client, heard } = await connectListening();
    const first = envelopeOf(0x13, { callId: 1 });

    client.once('message', () => {
      void client.disconnect({ isQuick: true });
    });
    (await callOf(1))?.answer(batch(1, first, envelopeOf(0x13, { callId: 3 })));

    await expect
      .poll(() => {
        return client.isClosed();
      })
      .toBe(true);
    expect(heard).toEqual([[...first]]);
  });

  test('listens again after a status nothing marked — a gateway’s 502 — as after a listen lost', async () => {
    const { callOf, client, heard } = await connectListening();
    const envelope = envelopeOf(0x13, { callId: 1 });

    (await callOf(1))?.answer({ status: 502 });
    (await callOf(2))?.answer(batch(1, envelope));

    expect((await callOf(3))?.url).toContain('?after=1&');
    expect([heard, client.isOpen()]).toEqual([[[...envelope]], true]);
    await client.disconnect({ isQuick: true });
  });

  test('reads a batch as it comes, a byte at a time, each envelope heard as soon as it is whole', async () => {
    const { callOf, client, heard } = await connectListening();
    const first = envelopeOf(0x13, { callId: 1 });
    const second = envelopeOf(0x13, { callId: 3, extra: 5 });
    const pieces = Array.from(batchOf(first, second), (byte) => {
      return Uint8Array.of(byte);
    });
    // the first envelope's length and bytes, then the batch ends
    const cut = 4 + first.length;

    (await callOf(1))?.answer({ ...batch(1), pieces: pieces.slice(0, cut) });

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([[...first]]);

    // the rest, in the next listen: from the one after the first
    expect((await callOf(2))?.url).toContain('?after=1&');
    (await callOf(2))?.answer({ ...batch(2), pieces: pieces.slice(cut) });

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([[...first], [...second]]);
    expect((await callOf(3))?.url).toContain('?after=2&');
    await client.disconnect({ isQuick: true });
  });

  test('hears what came whole of a batch cut on its way, and listens again from there, as no loss', async () => {
    const { callOf, client, heard } = await connectListening();
    const first = envelopeOf(0x13, { callId: 1 });
    const framed = batchOf(first, envelopeOf(0x13, { callId: 3 }));

    (await callOf(1))?.answer({
      ...batch(1),
      pieces: [framed.slice(0, 4 + first.length + 2), new TypeError('terminated')],
    });

    expect((await callOf(2))?.url).toContain('?after=1&');

    // one loss after it is the first in a row: listened again
    (await callOf(2))?.fail();

    expect((await callOf(3))?.url).toContain('?after=1&');
    expect([heard, client.isOpen()]).toEqual([[[...first]], true]);
    await client.disconnect({ isQuick: true });
  });

  test('never listens where the server did not say its listen back', async () => {
    const fake = createFakeFetch();
    const client = createHTTPTransportClient({ fetch: fake.fetch });
    const connecting = client.connect({ host, port: 80 });

    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    await connecting;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect([fake.calls[0]?.init.headers[LISTEN_HEADER], fake.calls.length]).toEqual(['?1', 1]);
    await client.disconnect({ isQuick: true });
  });

  test('says nothing of listening, and never listens, when told not to', async () => {
    const fake = createFakeFetch();
    const client = createHTTPTransportClient({ fetch: fake.fetch, isListening: false });
    const connecting = client.connect({ host, port: 80 });

    // a server that says a listen back all the same takes none from a client that asked for none
    fake.calls[0]?.answer({
      headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22), [LISTEN_HEADER]: '?1' },
      status: 201,
    });
    await connecting;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect([fake.calls.length, fake.calls[0]?.init.headers[LISTEN_HEADER]]).toEqual([1, undefined]);
    await client.disconnect({ isQuick: true });
  });
});
