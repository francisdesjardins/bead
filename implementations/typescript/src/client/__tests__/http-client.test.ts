import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createHTTPServer } from '../../server/http-server';
import { createTestClock } from '../../transport/shared/__tests__/fixtures';
import type { IClock } from '../../transport/shared/clock';
import { EnvelopeKind, LIMIT_DEFAULTS } from '../../router/shared/constants';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { createFakeFetch, responseOf } from '../../transport/client/__tests__/fake-fetch';
import {
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
} from '../../transport/client/http-transport-client';
import { ReadyState } from '../../transport/shared/ready-state';
import {
  createHTTPClient,
  CancelError,
  DisconnectError,
  ReadyStateError,
  SERVER_FAILURES,
  TimeoutError,
} from '../http-client';

// helpers

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

const echo = { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 };

/** A real HTTP facade whose echo waits for cancellation when asked to wait. */
const served = async (clock?: IClock) => {
  const server = createHTTPServer({ transport: { createServer } });
  const entered = Promise.withResolvers<void>();

  server.services.getRequestResolver(echo, { serializer: text })((request, response) => {
    if (request.payload !== 'wait') {
      return response(request.payload);
    }
    entered.resolve();

    return new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => {
          resolve(undefined);
        },
        { once: true }
      );
    });
  });
  const { port } = await server.transport.start({ address: '127.0.0.1', findOpenPort: true });
  const client = createHTTPClient({ transport: { clock, isListening: false } });

  await client.connect({ host: '127.0.0.1', port });

  return {
    client,
    entered: entered.promise,
    port,
    server,
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    },
  };
};

// definition

test.describe('createHTTPClient', () => {
  test('runs its router on its transport’s clock, which times a request out', async () => {
    const clock = createTestClock();
    await using active = await served(clock);
    const { client } = active;

    expect([client.transport.clock, client.router.clock]).toEqual([clock, clock]);
    const calling = client.services.getRequest(echo, { serializer: text })('wait')({
      timeout: 1_000,
    });
    const refused = expect(calling).rejects.toBeInstanceOf(TimeoutError);

    await active.entered;
    clock.tick(1_000);
    await refused;
  });

  test('connects, disconnects and reconnects through its transport, with the options given', async () => {
    await using active = await served();
    const { client } = active;
    const closes: boolean[][] = [];

    client.transport.on('close', (...flags) => {
      closes.push(flags);
    });
    await client.disconnect({ isClean: false });
    expect(closes).toEqual([[false, false]]);
    expect(client.transport.isClosed()).toBe(true);
    const controller = new AbortController();

    controller.abort();
    await expect(client.reconnect({ signal: controller.signal })).rejects.toBeInstanceOf(
      CancelError
    );
    expect(client.transport.isClosed()).toBe(true);
    await client.reconnect({ maximumAttempts: 1 });
    expect(client.transport.isOpen()).toBe(true);
    expect(client.router.transport).toBe(client.transport);
    await expect(client.services.getRequest(echo, { serializer: text })('a')()).resolves.toBe('a');
  });

  test('a dispose cancels a reconnection under way, and a token given still cancels it too', async () => {
    await using active = await served();
    const { client, port, server } = active;
    await using other = createHTTPClient({ transport: { isListening: false } });

    await other.connect({ host: '127.0.0.1', port });
    await server.transport.stop();
    const controller = new AbortController();
    const byDispose = expect(client.reconnect({ delay: 60_000 })).rejects.toBeInstanceOf(
      CancelError
    );
    const bySignal = expect(
      other.reconnect({ delay: 60_000, signal: controller.signal })
    ).rejects.toBeInstanceOf(CancelError);

    await client[Symbol.asyncDispose]();
    controller.abort();
    await byDispose;
    await bySignal;
    expect([client.transport.isClosed(), other.transport.isClosed()]).toEqual([true, true]);
  });

  test('rejects what waits as replaced once its transport reconnects', async () => {
    await using active = await served();
    const { client } = active;
    const calling = client.services.getRequest(echo, { serializer: text })('wait')();
    const refused = expect(calling).rejects.toThrow(
      'the connection was replaced before the answer'
    );

    await active.entered;
    await client.reconnect();
    await refused;
    expect(client.transport.isOpen()).toBe(true);
    await expect(client.services.getRequest(echo, { serializer: text })('a')()).resolves.toBe('a');
  });
  test('builds on an HTTP transport with the fetch it is given, one envelope per exchange, and no transfer', async () => {
    // a server that draws the connection, then answers each request with its payload in upper case
    const fake = createFakeFetch((init) => {
      if (init.body === undefined) {
        return responseOf({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
      }

      const request = readEnvelope(bytesOf(init.body as Uint8Array), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      });

      if (request?.kind !== EnvelopeKind.REQUEST) {
        return responseOf({ status: 204 });
      }

      return responseOf({
        body: writeEnvelope(
          {
            header: { callId: request.header.callId, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: encoder.encode(decoder.decode(request.payload).toUpperCase()),
          },
          LIMIT_DEFAULTS.maximumDetailBytes
        ),
        headers: { 'content-type': BEAD_MEDIA_TYPE },
        status: 200,
      });
    });
    const client = createHTTPClient({
      limits: { maximumEnvelopeBytes: 4_096 },
      transport: { fetch: fake.fetch, isListening: false },
    });

    await client.connect({ host: 'localhost', port: 8_080 });

    await expect(client.services.getRequest(echo, { serializer: text })('hi')()).resolves.toBe(
      'HI'
    );
    expect(client.router.limits).toMatchObject({
      chunkBytes: 4_096,
      maximumEnvelopeBytes: 4_096,
      maximumTransfers: 0,
      windowBytes: 8_192,
    });
    expect(
      fake.calls.map(({ init, url }) => {
        return [init.method, url];
      })
    ).toEqual([
      ['POST', 'http://localhost:8080/bead'],
      ['POST', 'http://localhost:8080/bead'],
    ]);
    await client.transport.disconnect();
  });

  test('builds with nothing given: the global fetch, one envelope of the default size, no transfer', () => {
    const client = createHTTPClient();

    expect(client.router.limits).toMatchObject({
      maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      maximumTransfers: 0,
    });
    expect(client.transport.isUninitialized()).toBe(true);
  });

  test('reads an answer no larger than the envelope its router takes, and closes on one past it', async () => {
    const fake = createFakeFetch();
    const client = createHTTPClient({
      limits: { maximumEnvelopeBytes: 1_024 },
      transport: { fetch: fake.fetch, isListening: false },
    });
    const connecting = client.connect({ host: 'localhost', port: 8_080 });

    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    await connecting;

    const calling = client.services.getRequest(echo, { serializer: text })('hi')();

    await expect
      .poll(() => {
        return fake.calls.length;
      })
      .toBe(2);
    fake.calls[1]?.answer({
      body: new Uint8Array(1_025),
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      status: 200,
    });

    await expect(calling).rejects.toThrow();
    expect(client.transport.isClosed()).toBe(true);
  });

  // debugging 9.7
  test('fails a call before it connects by its ready state, sending nothing', async () => {
    const fake = createFakeFetch();
    await using client = createHTTPClient({ transport: { fetch: fake.fetch, isListening: false } });
    const failing = client.services.getRequest(echo, { serializer: text })('hi')();

    await expect(failing).rejects.toBeInstanceOf(ReadyStateError);
    await expect(failing).rejects.toMatchObject({
      expected: ReadyState.OPEN,
      got: ReadyState.UNINITIALIZED,
    });
    expect(fake.calls).toEqual([]);
  });

  // debugging 9.7
  test('fails a call once disconnected as a disconnection, sending nothing', async () => {
    // a server that draws the connection and lets it go
    const fake = createFakeFetch((init) => {
      return init.method === 'POST'
        ? responseOf({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 })
        : responseOf({ status: 204 });
    });
    await using client = createHTTPClient({ transport: { fetch: fake.fetch, isListening: false } });

    await client.connect({ host: 'localhost', port: 8_080 });
    await client.transport.disconnect();

    const failing = client.services.getRequest(echo, { serializer: text })('hi')();

    await expect(failing).rejects.toBeInstanceOf(DisconnectError);
    await expect(failing).rejects.toThrow('the transport client is closed, not open');
    expect(
      fake.calls.map(({ init }) => {
        return init.method;
      })
    ).toEqual(['POST', 'DELETE']);
  });
});
