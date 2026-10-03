import { EventEmitter } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import {
  connect as connectHTTP2,
  createSecureServer,
  createServer as createHTTP2Server,
} from 'node:http2';
import { request as requestHTTPS } from 'node:https';
import { expect, test } from '@playwright/test';
import {
  EnvelopeKind,
  LIMIT_DEFAULTS,
  RESERVATION_MILLISECONDS,
} from '../../../router/shared/constants';
import { CancelError, ProgrammerError } from '../../shared/errors';
import {
  createTestClock,
  durationsOf,
  tcpSocketsClosed,
  timersBy,
} from '../../shared/__tests__/fixtures';
import {
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  BODY_BYTES_BUDGET,
  BURIAL_MILLISECONDS,
  CONNECTION_TOKEN_HEADER,
  createHTTPTransportServer,
  ENVELOPE_KINDS,
  EXCHANGE_TIMEOUT,
  LISTEN_HEADER,
  MAXIMUM_BODY_BYTES,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_OUTBOX_BYTES,
  MAXIMUM_WAIT,
  REFUSAL_HEADER,
  REFUSALS,
  SEQUENCE_HEADER,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../http-transport-server';
import type { TransportServerConnectionHandle } from '../types';
import { createFakeHTTPServer } from './fake-http-server';
import { TLS_FIXTURE } from './tls-fixture';

// helpers

const host = '127.0.0.1';

/** An envelope as the transport reads it: its layout, its kind, its call id, and `extra` bytes. */
const envelopeOf = (
  kind: number,
  { callId, extra = 0, layout = 0xa1 }: { callId: number; extra?: number; layout?: number }
): Uint8Array => {
  const bytes = new Uint8Array(8 + extra).fill(7);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, layout);
  view.setUint8(1, kind);
  view.setUint32(4, callId);

  return bytes;
};

/** What a listen brings back of `envelopes`: each after its length in 4 bytes. */
const batchOf = (...envelopes: Uint8Array[]): number[] => {
  return envelopes.flatMap((envelope) => {
    const length = new Uint8Array(4);

    new DataView(length.buffer).setUint32(0, envelope.length);

    return [...length, ...envelope];
  });
};

/** The events a transport server emits, each as its name and what it carries. */
const recordOf = (server: HTTPTransportServer) => {
  const events: [string, ...unknown[]][] = [];

  server.on('connection', (...[shown, drawing, connectionHandle]) => {
    events.push(['connection', shown, drawing, connectionHandle]);
  });
  server.on('message', (data, connectionHandle) => {
    events.push(['message', [...(data as Uint8Array)], connectionHandle]);
  });
  server.on('close', (wasClean, connectionHandle) => {
    events.push(['close', wasClean, connectionHandle]);
  });
  server.on('error', (error, connectionHandle) => {
    events.push(['error', error.message, connectionHandle]);
  });

  return events;
};

const namesOf = (events: [string, ...unknown[]][], name: string) => {
  return events.filter(([each]) => {
    return each === name;
  });
};

/** A transport server on a free port, with the events it emitted, and its URL. */
const startTransport = async (options?: Partial<IHTTPTransportServerOptions>) => {
  const server = createHTTPTransportServer({
    createServer: (listener) => {
      return createServer(listener);
    },
    ...options,
  });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const events = recordOf(server);

  return {
    events,
    server,
    url: `http://${host}:${String(port)}/bead`,
    [Symbol.asyncDispose]: () => {
      return server.stop();
    },
  };
};

const post = (
  url: string,
  {
    body,
    connectionToken,
    headers,
    signal,
  }: {
    body?: Uint8Array | ReadableStream<Uint8Array>;
    connectionToken?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
) => {
  return fetch(url, {
    body,
    // a stream goes chunked, its length unknown
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    headers: {
      'content-type': BEAD_MEDIA_TYPE,
      ...(connectionToken === undefined ? {} : { [CONNECTION_TOKEN_HEADER]: connectionToken }),
      ...headers,
    },
    method: 'POST',
    signal,
  } as RequestInit);
};

/** Connects: the token the server drew, and the handle it named the connection by. */
const connect = async (url: string, server: HTTPTransportServer) => {
  const response = await post(url);

  return {
    connectionHandle: server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle,
    connectionToken: response.headers.get(CONNECTION_TOKEN_HEADER) ?? '',
    response,
  };
};

const bytesOf = async (response: Response) => {
  return [...new Uint8Array(await response.arrayBuffer())];
};

/** What a response says of itself: its status and its refusal's reason. */
const refusalOf = async (answered: Promise<Response>) => {
  const response = await answered;

  await response.arrayBuffer().catch(() => {});

  return [response.status, response.headers.get(REFUSAL_HEADER)];
};

/** A scripted transport server, listening, with the events it emitted. */
const startScripted = async (options?: Partial<IHTTPTransportServerOptions>) => {
  const fake = createFakeHTTPServer();
  const server = createHTTPTransportServer({ createServer: fake.createServer, ...options });
  const starting = server.start({ port: 4_321 });

  fake.listen();
  await starting;

  const events = recordOf(server);

  // a connect: its token, and the handle it drew; `isListening`, its client listens
  const connectScripted = (
    socket?: { remoteAddress?: string; remotePort?: number },
    { isListening = false }: { isListening?: boolean } = {}
  ) => {
    const { response } = fake.exchange({
      headers: {
        'content-type': BEAD_MEDIA_TYPE,
        ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
      },
      ...(socket === undefined ? {} : { socket }),
    });

    return {
      connectionHandle: server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle,
      connectionToken: response.headers?.[CONNECTION_TOKEN_HEADER] ?? '',
    };
  };

  // an exchange on a connection, its body fed by the test
  const exchangeOf = (connectionToken: string, headers: Record<string, string> = {}) => {
    return fake.exchange({
      headers: {
        'content-type': BEAD_MEDIA_TYPE,
        [CONNECTION_TOKEN_HEADER]: connectionToken,
        ...headers,
      },
    });
  };

  // a listen on a connection, what follows `?` its query
  const listenOf = (connectionToken: string, query = '') => {
    return fake.exchange({
      headers: { [CONNECTION_TOKEN_HEADER]: connectionToken },
      method: 'GET',
      url: `/bead?${query}`,
    });
  };

  return { connectScripted, events, exchangeOf, fake, listenOf, server };
};

// definition

test.describe('createHTTPTransportServer', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('keeps its constants in step with the router’s', () => {
    expect(ENVELOPE_KINDS).toEqual({
      CANCEL: EnvelopeKind.CANCEL,
      FAILURE: EnvelopeKind.FAILURE,
      REQUEST: EnvelopeKind.REQUEST,
      RESULT: EnvelopeKind.RESULT,
    });
    expect(BURIAL_MILLISECONDS).toBe(RESERVATION_MILLISECONDS);
    expect(MAXIMUM_BODY_BYTES).toBe(LIMIT_DEFAULTS.maximumEnvelopeBytes);
  });

  test('draws a connection on a connect: a token of 16 bytes, a 201, and "connection" first, showing neither', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const order: string[] = [];

    server.on('connection', () => {
      order.push('connection');
    });

    const { connectionHandle, connectionToken, response } = await connect(url, server);

    order.push('answered');

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(connectionToken).toMatch(/^[\w-]{22}$/u);
    expect(connectionHandle).toBe('type=HTTP;ip=127.0.0.1;ordinal=1');
    expect(events).toEqual([
      [
        'connection',
        { ordinal: 1 },
        { method: 'POST', remoteAddress: host, remotePort: expect.any(Number), url: '/bead' },
        connectionHandle,
      ],
    ]);
    expect(order).toEqual(['connection', 'answered']);
    expect(server.isTwoWay(connectionHandle)).toBe(false);
    expect(server.clients).toMatchObject([{ address: host, connectionHandle, type: 'HTTP' }]);
    // the token reaches no event, and no client listed
    expect(JSON.stringify([events, server.clients])).not.toContain(connectionToken);

    const second = await connect(url, server);

    expect(second.connectionHandle).toBe('type=HTTP;ip=127.0.0.1;ordinal=2');
    expect(second.connectionToken).not.toBe(connectionToken);
  });

  test('pairs each answer with the exchange of its request, whatever the order, the head going as the request is handed on', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const first = post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });
    const second = post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3, extra: 2 }),
      connectionToken,
    });

    // both heads arrive before any answer: the router has both
    const [firstHead, secondHead] = await Promise.all([first, second]);

    expect([firstHead.status, secondHead.status]).toEqual([200, 200]);
    expect(firstHead.headers.get('content-type')).toBe(BEAD_MEDIA_TYPE);
    expect(namesOf(events, 'message')).toHaveLength(2);

    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3, extra: 1 }), connectionHandle);
    await server.send(envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 1 }), connectionHandle);

    expect(await bytesOf(secondHead)).toEqual([
      ...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3, extra: 1 }),
    ]);
    expect(await bytesOf(firstHead)).toEqual([
      ...envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 1 }),
    ]);
    // an answer whose exchange ended is dropped, as one to a connection gone
    await expect(
      server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle)
    ).resolves.toBeUndefined();
  });

  test('answers an answer sent as its request is handed on in one go', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);

    server.on('message', () => {
      void server.send(envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 5 }), connectionHandle);
    });

    const response = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 5 }),
      connectionToken,
    });

    expect(response.headers.get('content-length')).toBe('8');
    expect(await bytesOf(response)).toEqual([...envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 5 })]);
  });

  test('hands on any other envelope, and ends its exchange 204 at once', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);

    for (const kind of [ENVELOPE_KINDS.RESULT, 0x80]) {
      const response = await post(url, { body: envelopeOf(kind, { callId: 2 }), connectionToken });

      expect(response.status, String(kind)).toBe(204);
    }

    expect(namesOf(events, 'message')).toEqual([
      ['message', [...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 2 })], connectionHandle],
      ['message', [...envelopeOf(0x80, { callId: 2 })], connectionHandle],
    ]);
  });

  test('ends the exchange a cancel names, empty, and drops a request its cancel came before', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const head = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });
    const cancel = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }),
      connectionToken,
    });

    // its head gone already: a 200 that ends with no body
    expect([head.status, cancel.status]).toEqual([200, 204]);
    expect(await bytesOf(head)).toEqual([]);

    // its cancel first, then the request: buried, never handed on
    const early = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 3 }),
      connectionToken,
    });
    const late = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
      connectionToken,
    });

    expect([early.status, late.status]).toEqual([204, 204]);
    expect(
      namesOf(events, 'message').map(([, bytes]) => {
        return (bytes as number[])[1];
      })
    ).toEqual([ENVELOPE_KINDS.REQUEST, ENVELOPE_KINDS.CANCEL, ENVELOPE_KINDS.CANCEL]);

    // the burial is spent: the call id may come again
    const again = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
      connectionToken,
    });

    expect(again.status).toBe(200);
    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }), connectionHandle);
    await again.arrayBuffer();
  });

  test('refuses what is not a Bead exchange with a status of its own, marked, and hands the router nothing', async () => {
    await using started = await startTransport({ origins: ['https://app.example'] });
    const { events, server, url } = started;
    const { connectionToken } = await connect(url, server);

    const refusals = [
      refusalOf(fetch(`${url}/else`, { method: 'POST' })),
      refusalOf(fetch(url, { method: 'PUT' })),
      refusalOf(post(url, { connectionToken, headers: { origin: 'https://elsewhere.example' } })),
      refusalOf(
        post(url, { connectionToken, headers: { 'content-type': 'application/octet-stream' } })
      ),
      refusalOf(post(url, { headers: { 'content-type': 'text/plain' } })),
      refusalOf(post(url, { connectionToken, headers: { 'content-encoding': 'gzip' } })),
      refusalOf(post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }) })),
      refusalOf(post(url, { connectionToken: 'not-a-token' })),
      refusalOf(post(url, { connectionToken: 'A'.repeat(22) })),
      refusalOf(fetch(url, { method: 'DELETE' })),
      refusalOf(post(url, { body: Uint8Array.of(0xa1, 0x10), connectionToken })),
      refusalOf(
        post(url, {
          body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, layout: 0x20 }),
          connectionToken,
        })
      ),
      refusalOf(
        post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 2 }), connectionToken })
      ),
      refusalOf(
        post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 0 }), connectionToken })
      ),
    ];

    expect(await Promise.all(refusals)).toEqual([
      [404, REFUSALS.PATH],
      [405, REFUSALS.METHOD],
      [403, REFUSALS.ORIGIN],
      [415, REFUSALS.TYPE],
      [415, REFUSALS.TYPE],
      [415, REFUSALS.TYPE],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [404, REFUSALS.CONNECTION_UNKNOWN],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
    ]);

    const method = await fetch(url, { method: 'PUT' });

    expect(method.headers.get('allow')).toBe('GET, POST, DELETE');

    // its own origin, and one it was told of, pass
    for (const origin of [new URL(url).origin, 'https://app.example']) {
      const response = await post(url, {
        body: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }),
        connectionToken,
        headers: { origin },
      });

      expect(response.status, origin).toBe(204);
    }

    expect(namesOf(events, 'message')).toHaveLength(2);
    // the connection stays: a refusal ends its exchange alone
    expect(namesOf(events, 'close')).toEqual([]);
  });

  test('refuses a request on a call id already waiting, 409', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const first = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 7 }),
      connectionToken,
    });
    const again = await refusalOf(
      post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 7 }), connectionToken })
    );

    expect([first.status, again]).toEqual([200, [409, REFUSALS.CALL_WAITING]]);
    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 7 }), connectionHandle);
    expect(await bytesOf(first)).toEqual([...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 7 })]);
  });

  test('refuses a body past its limit, 413, declared or counted, and hands the router nothing', async () => {
    await using started = await startTransport({ maximumBodyBytes: 64 });
    const { events, server, url } = started;
    const { connectionToken } = await connect(url, server);
    const declared = await refusalOf(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 57 }),
        connectionToken,
      })
    );
    const counted = await post(url, {
      body: new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3, extra: 40 }));
          controller.enqueue(new Uint8Array(40));
          controller.close();
        },
      }),
      connectionToken,
    }).catch((reason: unknown) => {
      return reason;
    });

    expect(declared).toEqual([413, REFUSALS.TOO_LARGE]);
    // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
    expect(counted instanceof Response ? String(counted.status) : 'reset').toMatch(
      /^(?:413|reset)$/u
    );
    expect(namesOf(events, 'message')).toEqual([]);
  });

  test('bounds its connections, and those of one address; the requests one waits on, and the bytes of body under way', async () => {
    await using started = await startTransport({
      bodyBytesBudget: 32,
      maximumConnections: 2,
      maximumConnectionsPerAddress: 1,
      maximumWaitingExchanges: 1,
    });
    const { server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const response = await post(url);

    // one address, one connection: busy, and told when to come back
    expect([response.status, response.headers.get('retry-after')]).toEqual([503, '1']);
    expect(response.headers.get(REFUSAL_HEADER)).toBe(REFUSALS.BUSY);

    const waiting = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });
    const crowded = await refusalOf(
      post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }), connectionToken })
    );
    // a cancel takes no place: it is never refused for the requests waiting
    const cancel = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 9 }),
      connectionToken,
    });

    expect([waiting.status, crowded, cancel.status]).toEqual([200, [429, REFUSALS.BUSY], 204]);
    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle);
    await waiting.arrayBuffer();

    const heavy = await refusalOf(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 5, extra: 32 }),
        connectionToken,
      })
    );

    expect(heavy).toEqual([503, REFUSALS.BUSY]);
  });

  test('closes a connection on its DELETE; a request handed on learns it by its exchange cut', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const waiting = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });
    const deleted = await fetch(url, {
      headers: { [CONNECTION_TOKEN_HEADER]: connectionToken },
      method: 'DELETE',
    });

    expect(deleted.status).toBe(204);
    // its head was out: nothing of a 404 can follow, so its body is cut, as a lost one's is
    await expect(waiting.arrayBuffer()).rejects.toThrow();
    expect(events.at(-1)).toEqual(['close', true, connectionHandle]);
    expect(server.clients).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(connectionToken);

    const after = await refusalOf(
      post(url, { body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }), connectionToken })
    );

    expect(after).toEqual([404, REFUSALS.CONNECTION_UNKNOWN]);
    // an answer for it goes nowhere
    await expect(
      server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle)
    ).resolves.toBeUndefined();
  });

  test('closes a connection the server closes, cutting the exchange of a request it handed on', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const waiting = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });

    await expect(server.close(connectionHandle)).resolves.toBe(true);
    await expect(waiting.arrayBuffer()).rejects.toThrow();
    expect(namesOf(events, 'message')).toHaveLength(1);
    expect(events.at(-1)).toEqual(['close', true, connectionHandle]);
  });

  test('closes a connection the server closes as the request is handed on, cutting its exchange after its head', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);

    server.on('message', () => {
      void server.close(connectionHandle);
    });

    const waiting = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    }).catch(() => {
      return undefined;
    });

    // the router had it, so never a refusal, which says nothing was tried: a 200 whose body is cut,
    // or, the cut overtaking its head, an exchange lost before any status, which its client counts so
    if (waiting !== undefined) {
      expect(waiting.status).toBe(200);
      expect(waiting.headers.get('content-type')).toBe(BEAD_MEDIA_TYPE);
      expect(waiting.headers.get('cache-control')).toBe('no-store');
      expect(waiting.headers.get(REFUSAL_HEADER)).toBeNull();
      await expect(waiting.arrayBuffer()).rejects.toThrow();
    }

    expect(namesOf(events, 'message')).toHaveLength(1);
    expect(events.at(-1)).toEqual(['close', true, connectionHandle]);
  });

  test('closes a connection whose exchange was lost before its answer', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const controller = new AbortController();
    const head = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
      signal: controller.signal,
    });

    void head.arrayBuffer().catch(() => {});
    controller.abort();

    await expect
      .poll(() => {
        return events.at(-1);
      })
      .toEqual(['close', false, connectionHandle]);
    // nor does a connection's end show its token: no event, message, close or error
    expect(JSON.stringify([events, server.clients])).not.toContain(connectionToken);
  });

  test('sends a connection that does not listen its answers alone: anything else of the server’s own rejects', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const { connectionHandle } = await connect(url, server);

    for (const kind of [EnvelopeKind.NOTIFICATION, EnvelopeKind.REQUEST, EnvelopeKind.CREDIT]) {
      await expect(
        server.send(envelopeOf(kind, { callId: 2 }), connectionHandle),
        String(kind)
      ).rejects.toThrow('this connection does not listen');
    }

    await expect(server.send('text', connectionHandle)).rejects.toBeInstanceOf(ProgrammerError);
    await expect(server.send(new ArrayBuffer(4), connectionHandle)).rejects.toBeInstanceOf(
      ProgrammerError
    );
  });

  test('stops with a client keeping its socket alive, each waiting exchange cut', async () => {
    const started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const waiting = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });
    const body = waiting.arrayBuffer().then(
      () => {
        return 'whole';
      },
      () => {
        return 'cut';
      }
    );

    await server.stop();

    expect(events.at(-1)).toEqual(['close', false, connectionHandle]);
    expect(await body).toBe('cut');
    expect(server.isClosed()).toBe(true);
  });

  test('answers each listen it holds the marked 404 as it stops, however many', async () => {
    const { server, url } = await startTransport();
    const held: Promise<Response>[] = [];

    for (let connection = 0; connection < 32; connection += 1) {
      const response = await post(url, { headers: { [LISTEN_HEADER]: '?1' } });

      held.push(
        fetch(`${url}?wait=20000`, {
          headers: {
            [CONNECTION_TOKEN_HEADER]: response.headers.get(CONNECTION_TOKEN_HEADER) ?? '',
          },
        })
      );
    }

    await expect
      .poll(() => {
        return server.gauges().counts['listens'];
      })
      .toBe(32);
    await server.stop();

    for (const listen of held) {
      expect(await refusalOf(listen)).toEqual([404, REFUSALS.CONNECTION_UNKNOWN]);
    }
  });

  test('refuses options it cannot hold', () => {
    for (const [name, value] of [
      ['bodyBytesBudget', 0],
      ['exchangeTimeout', 2 ** 31],
      ['exchangeTimeout', 0.5],
      ['inactivityTimeout', 0],
      ['inactivityTimeout', 1.5],
      ['maximumWait', 0.5],
      ['maximumBodyBytes', 1.5],
      ['maximumConnections', -1],
      ['maximumConnectionsPerAddress', 0],
      ['maximumWaitingExchanges', Number.NaN],
    ] as const) {
      expect(
        () => {
          return createHTTPTransportServer({
            createServer: (listener) => {
              return createServer(listener);
            },
            [name]: value,
          });
        },
        `${name} ${String(value)}`
      ).toThrow(ProgrammerError);
    }

    for (const timers of [
      { exchangeTimeout: Infinity, inactivityTimeout: Infinity },
      { exchangeTimeout: 1, inactivityTimeout: 1, maximumWait: 1 },
    ]) {
      expect(() => {
        return createHTTPTransportServer({
          createServer: (listener) => {
            return createServer(listener);
          },
          ...timers,
        });
      }).not.toThrow();
    }

    expect(EXCHANGE_TIMEOUT).toBe(300_000);
  });

  test('holds its timeouts and its longest wait to a whole number of milliseconds, refusing 0, Infinity for the timeouts alone', () => {
    for (const [option, never] of [
      ['exchangeTimeout', 'taken'],
      ['inactivityTimeout', 'taken'],
      ['maximumWait', 'refused'],
    ] as const) {
      for (const { given, outcome, refusal } of durationsOf(option, { never, zero: 'refused' })) {
        const building = () => {
          return createHTTPTransportServer({
            createServer: (listener) => {
              return createServer(listener);
            },
            [option]: given,
          });
        };

        if (outcome === 'refused') {
          expect(building, `${option} ${String(given)}`).toThrow(new ProgrammerError(refusal));
        } else {
          expect(building, `${option} ${String(given)}`).not.toThrow();
        }
      }
    }
  });
});

test.describe('createHTTPTransportServer, over HTTP/2', () => {
  test('draws a connection, pairs an answer, takes a same-origin browser’s exchange by its authority, and closes on a stream reset', async () => {
    const server = createHTTPTransportServer({
      createServer: (listener) => {
        return createHTTP2Server((request, response) => {
          listener(request, response);
        });
      },
    });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const events = recordOf(server);
    const session = connectHTTP2(`http://${host}:${String(port)}`);
    const exchange = (headers: Record<string, string>, body?: Uint8Array) => {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/bead',
        'content-type': BEAD_MEDIA_TYPE,
        ...headers,
      });
      const head = new Promise<Record<string, unknown>>((resolve) => {
        stream.once('response', resolve);
      });
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      const whole = new Promise<number[]>((resolve) => {
        stream.once('end', () => {
          resolve(Array.from(Buffer.concat(chunks)));
        });
      });

      stream.on('error', () => {});
      stream.end(body);

      return { head, stream, whole };
    };

    try {
      const drawing = exchange({ origin: `http://${host}:${String(port)}` });
      const drew = await drawing.head;
      const connectionToken = String(drew[CONNECTION_TOKEN_HEADER]);
      const connectionHandle = server.clients[0]
        ?.connectionHandle as TransportServerConnectionHandle;

      expect(drew[':status']).toBe(201);

      const asking = exchange(
        { [CONNECTION_TOKEN_HEADER]: connectionToken },
        envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })
      );

      expect((await asking.head)[':status']).toBe(200);
      await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle);
      expect(await asking.whole).toEqual([...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 })]);

      // a request waiting, its stream reset by its client: lost, and its connection with it
      const waiting = exchange(
        { [CONNECTION_TOKEN_HEADER]: connectionToken },
        envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 })
      );

      await waiting.head;
      waiting.stream.close();

      await expect
        .poll(() => {
          return events.at(-1);
        })
        .toEqual(['close', false, connectionHandle]);
      // an answer after it goes nowhere, and never hangs
      await expect(
        server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }), connectionHandle)
      ).resolves.toBeUndefined();
    } finally {
      session.close();
      await server.stop();
    }
  });
});

/** A `POST` over HTTP/1.1 and TLS, trusting the fixture's certificate alone: its status, head and body. */
const postHTTPS = (
  port: number,
  { body, headers }: { body?: Uint8Array; headers: Record<string, string> }
) => {
  return new Promise<{ body: number[]; headers: IncomingHttpHeaders; status: number | undefined }>(
    (resolve, reject) => {
      const request = requestHTTPS(
        {
          ca: TLS_FIXTURE.cert,
          headers: { 'content-type': BEAD_MEDIA_TYPE, ...headers },
          host,
          method: 'POST',
          path: '/bead',
          port,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              body: Array.from(Buffer.concat(chunks)),
              headers: response.headers,
              status: response.statusCode,
            });
          });
        }
      );

      request.on('error', reject);
      request.end(body);
    }
  );
};

test.describe('createHTTPTransportServer, over TLS', () => {
  test('serves HTTP/2 and HTTP/1.1 on one port, a call over each, and closes its sessions as it stops', async () => {
    const server = createHTTPTransportServer({
      createServer: (listener) => {
        return createSecureServer({ ...TLS_FIXTURE, allowHTTP1: true }, (request, response) => {
          listener(request, response);
        });
      },
    });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const session = connectHTTP2(`https://${host}:${String(port)}`, { ca: TLS_FIXTURE.cert });
    const sessionClosed = new Promise((resolve) => {
      session.once('close', resolve);
    });

    // each request answered by its result, as a router would
    server.on('message', (data, connectionHandle) => {
      const envelope = data as Uint8Array;
      const callId = new DataView(envelope.buffer, envelope.byteOffset).getUint32(4);

      void server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId }), connectionHandle);
    });
    session.on('error', () => {});

    const overHTTP2 = (headers: Record<string, string>, body?: Uint8Array) => {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/bead',
        'content-type': BEAD_MEDIA_TYPE,
        ...headers,
      });
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.end(body);

      return Promise.all([
        new Promise<Record<string, unknown>>((resolve) => {
          stream.once('response', resolve);
        }),
        new Promise<number[]>((resolve) => {
          stream.once('end', () => {
            resolve(Array.from(Buffer.concat(chunks)));
          });
        }),
      ]);
    };

    try {
      const [drew] = await overHTTP2({});
      const [asked, answer] = await overHTTP2(
        { [CONNECTION_TOKEN_HEADER]: String(drew[CONNECTION_TOKEN_HEADER]) },
        envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })
      );

      expect([drew[':status'], asked[':status'], answer]).toEqual([
        201,
        200,
        [...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 })],
      ]);

      const drawn = await postHTTPS(port, { headers: {} });
      const called = await postHTTPS(port, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
        headers: { [CONNECTION_TOKEN_HEADER]: String(drawn.headers[CONNECTION_TOKEN_HEADER]) },
      });

      expect([drawn.status, called.status, called.body]).toEqual([
        201,
        200,
        [...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 })],
      ]);
      expect(
        server.clients.map(({ connectionHandle }) => {
          return connectionHandle;
        })
      ).toEqual(['type=HTTP;ip=127.0.0.1;ordinal=1', 'type=HTTP;ip=127.0.0.1;ordinal=2']);
    } finally {
      await server.stop();
    }

    // the HTTP/2 session the server held is closed as it stops
    await sessionClosed;
    expect(session.closed).toBe(true);
  });

  test('draws a connection over HTTP/2 before its empty body ends', async () => {
    const server = createHTTPTransportServer({
      createServer: (listener) => {
        return createSecureServer({ ...TLS_FIXTURE, allowHTTP1: true }, (request, response) => {
          listener(request, response);
        });
      },
    });
    const { port } = await server.start({ address: host, findOpenPort: true });
    const session = connectHTTP2(`https://${host}:${String(port)}`, { ca: TLS_FIXTURE.cert });

    session.on('error', () => {});

    try {
      // its head says its body is empty, and its stream ends later: whether a connect has a body is
      // read from its head, never from an end of stream still to come
      const stream = session.request({
        ':method': 'POST',
        ':path': '/bead',
        'content-type': BEAD_MEDIA_TYPE,
        'content-length': '0',
      });
      const drew = await new Promise<Record<string, unknown>>((resolve) => {
        stream.once('response', resolve);
      });

      expect(drew[':status']).toBe(201);
      stream.end();
    } finally {
      session.close();
      await server.stop();
    }
  });
});

test.describe('createHTTPTransportServer, its edges', () => {
  test('listens on the port it was asked for, reports it when the server reports none, takes a late error as its own, and closes its sessions as it stops', async () => {
    const fake = createFakeHTTPServer({ address: null });
    const server = createHTTPTransportServer({ createServer: fake.createServer });
    const errors: [string, string][] = [];
    const starting = server.start({ address: host, port: 4_321 });
    let closed = 0;

    fake.listen();

    await expect(starting).resolves.toEqual({ address: host, port: 4_321 });
    expect(fake.servers[0]?.listened).toEqual([4_321, host]);

    server.on('error', (error, connectionHandle) => {
      errors.push([error.message, connectionHandle]);
    });
    fake.servers[0]?.emit('error', new Error('late'));

    // an HTTP/2 session is kept until it ends, or the server stops
    const sessionOf = () => {
      return Object.assign(new EventEmitter(), {
        close: () => {
          closed += 1;
        },
      });
    };
    const ended = sessionOf();

    fake.servers[0]?.emit('session', ended);
    fake.servers[0]?.emit('session', sessionOf());

    expect(server.gauges().counts['http2Sessions']).toBe(2);

    ended.emit('close');

    expect(errors).toEqual([['late', '']]);
    expect(server.isOpen()).toBe(true);
    expect(server.gauges().counts['http2Sessions']).toBe(1);

    await server.stop();

    expect([fake.servers[0]?.closes, closed]).toEqual([1, 1]);
  });

  test('an error before listening, or an abort, rejects the start and closes what was opened', async () => {
    const failing = createFakeHTTPServer();
    const server = createHTTPTransportServer({ createServer: failing.createServer });
    const refused = new Error('EADDRINUSE');
    const starting = server.start({ port: 4_321 });

    failing.servers[0]?.emit('error', refused);

    await expect(starting).rejects.toBe(refused);
    expect([failing.servers[0]?.closes, server.isClosed()]).toEqual([1, true]);

    const aborting = createFakeHTTPServer();
    const aborted = createHTTPTransportServer({ createServer: aborting.createServer });
    const controller = new AbortController();
    const abortedStart = aborted.start({ port: 4_321, signal: controller.signal });

    controller.abort();

    await expect(abortedStart).rejects.toBeInstanceOf(CancelError);
    expect(aborting.servers[0]?.closes).toBe(1);
  });

  test('reads any target without throwing, a header given twice by its first, and HTTP/2’s authority as the host', async () => {
    const { fake, server } = await startScripted({ hosts: ['bead.example', 'bead.example:8443'] });
    const statusOf = (
      headers: Record<string, string | string[]>,
      { url, httpVersionMajor }: { httpVersionMajor?: number; url?: string } = {}
    ) => {
      const { response } = fake.exchange({
        headers: { host: 'bead.example', ...headers },
        ...(httpVersionMajor === undefined ? {} : { httpVersionMajor }),
        ...(url === undefined ? {} : { url }),
      });

      return [response.status, response.headers?.[REFUSAL_HEADER]];
    };
    const bead = { 'content-type': BEAD_MEDIA_TYPE };

    expect([
      statusOf({ 'content-type': [BEAD_MEDIA_TYPE, 'text/plain'] }),
      statusOf(bead, { url: '//:99999/bead' }),
      statusOf(bead, { url: '//[' }),
      statusOf(bead, { url: '/bead?after=1' }),
      statusOf({ ...bead, origin: 'not an origin' }),
      statusOf({ ...bead, host: 'rebound.example' }),
      statusOf({ 'content-type': BEAD_MEDIA_TYPE, host: [] as unknown as string }),
      // HTTP/2 names its host by its authority, and a browser's origin matches it
      statusOf(
        {
          ':authority': 'bead.example:8443',
          'content-type': BEAD_MEDIA_TYPE,
          host: undefined as unknown as string,
          origin: 'https://bead.example:8443',
        },
        { httpVersionMajor: 2 }
      ),
      statusOf({}),
    ]).toEqual([
      [201, undefined],
      [404, REFUSALS.PATH],
      [404, REFUSALS.PATH],
      [201, undefined],
      [403, REFUSALS.ORIGIN],
      [403, REFUSALS.HOST],
      [403, REFUSALS.HOST],
      [201, undefined],
      [415, REFUSALS.TYPE],
    ]);

    const { response } = fake.exchange({ headers: bead });
    // no target at all: the root, which is not the path
    const untargeted = fake.exchange({
      headers: { ...bead, host: 'bead.example' },
      url: undefined,
    });

    // no host at all, where hosts are listed
    expect(response.status).toBe(403);
    expect(untargeted.response.headers?.[REFUSAL_HEADER]).toBe(REFUSALS.PATH);
    await server.stop();
  });

  test('takes a proxy’s last forwarded address when told to, and bounds the connections of each address', async () => {
    const { connectScripted, fake, server } = await startScripted({
      isProxyTrusted: true,
      maximumConnectionsPerAddress: 1,
    });
    const behind = { remoteAddress: '127.0.0.1', remotePort: 40_001 };
    const drawOf = (forwarded: string, socket = behind) => {
      const { response } = fake.exchange({
        headers: { 'content-type': BEAD_MEDIA_TYPE, 'x-forwarded-for': forwarded },
        socket,
      });

      return [response.status, server.clients.at(-1)?.connectionHandle];
    };

    expect(drawOf('203.0.113.9, 198.51.100.7')).toEqual([
      201,
      'type=HTTP;ip=198.51.100.7;ordinal=1',
    ]);
    // one address, one connection
    expect(drawOf('198.51.100.7')[0]).toBe(503);
    // what is no address is not taken, nor what a peer not on this machine forwards
    expect(drawOf('evil;ordinal=1')).toEqual([201, 'type=HTTP;ip=127.0.0.1;ordinal=2']);
    expect(drawOf('192.0.2.1', { remoteAddress: '10.0.0.3', remotePort: 1 })).toEqual([
      201,
      'type=HTTP;ip=10.0.0.3;ordinal=3',
    ]);

    // a socket gone before its address was read cannot connect; one with no port is port 0
    expect(
      fake.exchange({ headers: { 'content-type': BEAD_MEDIA_TYPE }, socket: {} }).response.status
    ).toBe(400);
    connectScripted({ remoteAddress: '10.0.0.4' });

    expect(server.clients.at(-1)?.port).toBe(0);
    await server.stop();
  });

  test('puts a body together from as many pieces as it comes in, and hands on one envelope', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted();
    const { connectionToken } = connectScripted();
    const envelope = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 70_000 });
    const { request } = exchangeOf(connectionToken);

    fake.feed(
      request,
      Array.from({ length: Math.ceil(envelope.length / 1_000) }, (_, index) => {
        return envelope.subarray(index * 1_000, (index + 1) * 1_000);
      })
    );

    expect(namesOf(events, 'message')).toEqual([['message', [...envelope], expect.any(String)]]);
    await server.stop();
  });

  test('ends an upload whose cancel came as it came, never handing it on, and one past its limit, reading no more of it', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted({
      maximumBodyBytes: 64,
    });
    const { connectionToken } = connectScripted();
    const request = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 40 });
    const upload = exchangeOf(connectionToken);

    upload.request.emit('data', request.subarray(0, 16));

    const cancel = exchangeOf(connectionToken);

    fake.feed(cancel.request, [envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 })]);
    fake.feed(upload.request, [request.subarray(16)]);

    expect([cancel.response.status, upload.response.status]).toEqual([204, 204]);

    // cancelled, and still coming past the limit: refused, and read no more
    const endless = exchangeOf(connectionToken);

    endless.request.emit('data', request.subarray(0, 16));
    fake.feed(exchangeOf(connectionToken).request, [
      envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }),
    ]);
    endless.request.emit('data', new Uint8Array(64));

    expect([endless.response.status, endless.request.isDestroyed]).toEqual([413, true]);
    expect(
      namesOf(events, 'message').map(([, bytes]) => {
        return (bytes as number[])[1];
      })
    ).toEqual([ENVELOPE_KINDS.CANCEL, ENVELOPE_KINDS.CANCEL]);
    await server.stop();
  });

  test('lets a burial lapse, buries only the client’s call ids and so many of them, and answers a body still coming as its connection closes', async () => {
    const clock = createTestClock();
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted({
      clock,
      maximumWaitingExchanges: 2,
    });
    const { connectionHandle, connectionToken } = connectScripted();

    // a cancel before its request, whose burial lapses on its clock: the request that comes after
    // goes on
    fake.feed(exchangeOf(connectionToken).request, [
      envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 5 }),
    ]);
    clock.tick(BURIAL_MILLISECONDS);

    // an even call id is no client's, and two burials are all a connection holds here
    for (const callId of [2, 7, 9, 11]) {
      fake.feed(exchangeOf(connectionToken).request, [
        envelopeOf(ENVELOPE_KINDS.CANCEL, { callId }),
      ]);
    }

    const burials = clock.armed.filter(({ delay }) => {
      return delay === BURIAL_MILLISECONDS;
    }).length;

    const late = exchangeOf(connectionToken);

    fake.feed(late.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 5 })]);

    expect([late.response.status, burials]).toEqual([200, 3]);

    // a cancel still coming as its connection closes learns the connection is gone
    const coming = exchangeOf(connectionToken);

    coming.request.emit('data', envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 13 }));
    await server.close(connectionHandle);
    coming.request.emit('end');

    expect([
      late.response.isDestroyed,
      coming.response.status,
      coming.response.headers?.[REFUSAL_HEADER],
    ]).toEqual([true, 404, REFUSALS.CONNECTION_UNKNOWN]);
    expect(namesOf(events, 'close')).toEqual([['close', true, connectionHandle]]);
    await server.stop();
  });

  test('closes, as lost, a connection whose request waited past its timeout, and one idle past its own, never while an exchange is under way', async () => {
    const clock = createTestClock();
    const started = await startScripted({
      clock,
      exchangeTimeout: 1_000,
      inactivityTimeout: 2_000,
    });
    const { connectScripted, events, exchangeOf, fake, server } = started;

    try {
      const unanswered = connectScripted();
      const idle = connectScripted();
      const asking = exchangeOf(unanswered.connectionToken);

      fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);

      // one idle timer per connection as drawn; the one asking lost its own as its exchange came
      const delays = clock.armed.map(({ delay }) => {
        return delay;
      });

      expect(delays).toEqual([2_000, 2_000, 1_000]);
      expect(clock.cleared).toEqual([clock.armed[0]?.handle]);

      clock.tick(999);

      expect(namesOf(events, 'close')).toEqual([]);

      clock.tick(1_001);

      expect(asking.response.isDestroyed).toBe(true);
      expect(namesOf(events, 'close')).toEqual([
        ['close', false, unanswered.connectionHandle],
        ['close', false, idle.connectionHandle],
      ]);
    } finally {
      await server.stop();
    }
  });

  test('keeps a connection whose refused exchange lost its socket, and closes one whose answer could not be written', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted();
    const refused = exchangeOf(connectionToken);

    refused.response.isFinishing = false;
    fake.feed(refused.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 2 })]);
    refused.response.close();

    expect([refused.response.status, namesOf(events, 'close')]).toEqual([400, []]);

    const asking = exchangeOf(connectionToken);

    fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    asking.response.isFinishing = false;

    const sending = server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle);

    asking.response.close();

    await expect(sending).rejects.toThrow('the exchange closed before its answer went out');

    // a request that failed as it came lets go of what it held, and its connection is lost
    const broken = exchangeOf(connectionToken);

    broken.request.emit('data', envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }));
    broken.request.emit('error', new Error('reset'));
    broken.response.close();

    expect(namesOf(events, 'close')).toEqual([['close', false, connectionHandle]]);
    await server.stop();
  });

  test('bounds the exchanges under way on one connection, bodies still coming included, and closes it once, however many it loses after', async () => {
    const { connectScripted, events, exchangeOf, server } = await startScripted({
      maximumWaitingExchanges: 1,
    });
    const { connectionHandle, connectionToken } = connectScripted();
    // two bodies still coming, their prefix unread: under way, waiting for nothing yet
    const first = exchangeOf(connectionToken);
    const second = exchangeOf(connectionToken);
    const third = exchangeOf(connectionToken);

    expect([third.response.status, third.response.headers?.[REFUSAL_HEADER]]).toEqual([
      429,
      REFUSALS.BUSY,
    ]);

    // closed, then each body's socket gone: the connection closes once
    await server.close(connectionHandle);
    first.response.close();
    second.response.close();

    expect(namesOf(events, 'close')).toEqual([['close', true, connectionHandle]]);
    await server.stop();
  });

  test('closes the socket behind a refusal of a body it will not read, over HTTP/1 alone', async () => {
    const { fake, server } = await startScripted();
    const headersOf = (httpVersionMajor: number, headers: Record<string, string>) => {
      return fake.exchange({
        headers: { 'content-type': 'text/plain', ...headers },
        httpVersionMajor,
      }).response.headers;
    };

    // a 400 is a refusal too
    const malformed = headersOf(1, {
      'content-length': '8',
      'content-type': BEAD_MEDIA_TYPE,
      [CONNECTION_TOKEN_HEADER]: 'not-a-token',
    });

    expect([
      headersOf(1, { 'content-length': '8' })?.['connection'],
      headersOf(2, { 'content-length': '8' })?.['connection'],
      // a body of no declared length, chunked, is a body all the same
      headersOf(1, { 'transfer-encoding': 'chunked' })?.['connection'],
      [malformed?.[REFUSAL_HEADER], malformed?.['connection']],
    ]).toEqual(['close', undefined, 'close', [REFUSALS.MALFORMED, 'close']]);
    await server.stop();
  });

  test('reads a body up to its limit exactly, declared or counted, refuses one declared past it before any of it, and gives back the bytes each held', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted({
      bodyBytesBudget: 24,
      maximumBodyBytes: 16,
    });
    const { connectionToken } = connectScripted();
    const full = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 8 });
    const declared = exchangeOf(connectionToken, { 'content-length': '16' });
    const past = exchangeOf(connectionToken, { 'content-length': '17' });

    // the one past its limit is refused as it comes; the one at it waits for its body
    expect([declared.response.status, past.response.status]).toEqual([undefined, 413]);

    fake.feed(declared.request, [full]);

    // counted, with no length declared: its 16 bytes, once the first 16 were given back
    const counted = exchangeOf(connectionToken, { 'transfer-encoding': 'chunked' });

    fake.feed(counted.request, [
      envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
      new Uint8Array(8),
    ]);

    expect([declared.response.status, counted.response.status]).toEqual([200, 200]);
    expect(namesOf(events, 'message')).toHaveLength(2);
    await server.stop();
  });

  test('bounds its connections all together, whichever address each comes from', async () => {
    const { connectScripted, fake, server } = await startScripted({ maximumConnections: 1 });

    connectScripted({ remoteAddress: '10.0.0.1', remotePort: 40_000 });

    const { response } = fake.exchange({
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      socket: { remoteAddress: '10.0.0.2', remotePort: 40_001 },
    });

    expect([response.status, response.headers?.[REFUSAL_HEADER]]).toEqual([503, REFUSALS.BUSY]);
    await server.stop();
  });

  test('buries the client’s call ids alone: a cancel of the server’s takes no place', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted({
      maximumWaitingExchanges: 1,
    });
    const { connectionToken } = connectScripted();
    const post = (envelope: Uint8Array) => {
      const exchange = exchangeOf(connectionToken);

      fake.feed(exchange.request, [envelope]);

      return exchange.response.status;
    };

    expect([
      post(envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 2 })),
      post(envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 3 })),
      // its cancel came first: dropped
      post(envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 })),
    ]).toEqual([204, 204, 204]);
    // the two cancels, handed on; the request, never
    expect(namesOf(events, 'message')).toHaveLength(2);
    await server.stop();
  });

  test('ends a request whose connection closes as its body comes with the marked 404, its head not out yet', async () => {
    const { connectScripted, exchangeOf, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted();
    const coming = exchangeOf(connectionToken);

    // its prefix read: it waits under its call id, its body not whole
    coming.request.emit(
      'data',
      envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 8 }).subarray(0, 12)
    );
    await server.close(connectionHandle);

    expect([
      coming.response.status,
      coming.response.headers?.[REFUSAL_HEADER],
      coming.response.isDestroyed,
    ]).toEqual([404, REFUSALS.CONNECTION_UNKNOWN, false]);

    // the rest of it changes nothing
    coming.request.emit('end');

    expect(coming.response.status).toBe(404);
    await server.stop();
  });

  test('rests a connection once none of its exchanges is under way, and arms no timer that is Infinity', async () => {
    const clock = createTestClock();
    const started = await startScripted({ clock, inactivityTimeout: 2_000 });
    const { connectScripted, exchangeOf, fake, server } = started;
    const { connectionHandle, connectionToken } = connectScripted();
    const first = exchangeOf(connectionToken);
    const second = exchangeOf(connectionToken);

    fake.feed(first.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    fake.feed(second.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 })]);

    const before = clock.armed.length;

    // one answered, the other still waiting: no rest yet
    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }), connectionHandle);

    expect(clock.armed.slice(before)).toEqual([]);

    await server.send(envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }), connectionHandle);

    expect(
      clock.armed.slice(before).map(({ delay }) => {
        return delay;
      })
    ).toEqual([2_000]);
    await server.stop();

    // a request waits for its answer for ever, and a connection rests for ever: no timer
    const foreverClock = createTestClock();
    const forever = await startScripted({
      clock: foreverClock,
      exchangeTimeout: Infinity,
      inactivityTimeout: Infinity,
    });
    const { connectionToken: foreverToken } = forever.connectScripted();
    const asking = forever.exchangeOf(foreverToken);
    const { armed: armedForever } = timersBy(foreverClock, () => {
      forever.fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    });

    expect([asking.response.status, armedForever]).toEqual([200, []]);
    await forever.server.stop();
  });

  test('keeps the socket of an exchange whose connection closed as its body came, read whole, and closes the one of a refusal whose body goes unread', async () => {
    const { connectScripted, exchangeOf, fake, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted();
    const coming = exchangeOf(connectionToken, { 'content-length': '16' });

    coming.request.emit('data', envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 3 }));
    await server.close(connectionHandle);
    fake.feed(coming.request, [new Uint8Array(8)]);

    // what comes after on its token, a body it will not read
    const after = exchangeOf(connectionToken, { 'content-length': '8' });

    expect(
      [coming, after].map(({ response }) => {
        return [
          response.status,
          response.headers?.[REFUSAL_HEADER],
          response.headers?.['connection'],
        ];
      })
    ).toEqual([
      [404, REFUSALS.CONNECTION_UNKNOWN, undefined],
      [404, REFUSALS.CONNECTION_UNKNOWN, 'close'],
    ]);
    await server.stop();
  });

  test('answers a request an answer comes for as its body still comes, at once, never handing it on', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted();
    const coming = exchangeOf(connectionToken, { 'content-length': '16' });
    const request = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 8 });
    const answer = envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 });

    coming.request.emit('data', request.subarray(0, 12));
    await server.send(answer, connectionHandle);

    expect([coming.response.status, [...(coming.response.body ?? [])]]).toEqual([200, [...answer]]);

    // the rest of it changes nothing: it is never handed on
    fake.feed(coming.request, [request.subarray(12)]);

    expect(namesOf(events, 'message')).toEqual([]);
    await server.stop();
  });

  test('tells a header given empty from one absent: an empty token is malformed, an empty origin or encoding refused, an empty listen none', async () => {
    const { connectScripted, fake, server } = await startScripted();
    const { connectionToken } = connectScripted();
    const statusOf = (headers: Record<string, string>) => {
      const { response } = fake.exchange({
        headers: { 'content-type': BEAD_MEDIA_TYPE, ...headers },
      });

      return [response.status, response.headers?.[REFUSAL_HEADER]];
    };

    expect([
      statusOf({ [CONNECTION_TOKEN_HEADER]: '' }),
      statusOf({ origin: '' }),
      statusOf({ [CONNECTION_TOKEN_HEADER]: connectionToken, 'content-encoding': '' }),
      statusOf({ [LISTEN_HEADER]: '' }),
    ]).toEqual([
      [400, REFUSALS.MALFORMED],
      [403, REFUSALS.ORIGIN],
      [415, REFUSALS.TYPE],
      [400, REFUSALS.MALFORMED],
    ]);
    await server.stop();
  });
});

test.describe('createHTTPTransportServer, listening', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('brings back what the server sent of its own, in order and numbered, again until a listen acknowledges it', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const drawn = await post(url, { headers: { [LISTEN_HEADER]: '?1' } });
    const connectionToken = drawn.headers.get(CONNECTION_TOKEN_HEADER) ?? '';
    const connectionHandle = server.clients.at(-1)
      ?.connectionHandle as TransportServerConnectionHandle;
    const first = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });
    const second = envelopeOf(EnvelopeKind.REQUEST, { callId: 2, extra: 3 });
    const listen = (query: string) => {
      return fetch(`${url}?${query}`, { headers: { [CONNECTION_TOKEN_HEADER]: connectionToken } });
    };

    // the listen taken, said back
    expect([drawn.headers.get(LISTEN_HEADER), server.isTwoWay(connectionHandle)]).toEqual([
      '?1',
      true,
    ]);
    await server.send(first, connectionHandle);
    await server.send(second, connectionHandle);

    const brought = await listen('after=0&wait=0');

    expect([
      brought.status,
      brought.headers.get('content-type'),
      brought.headers.get(SEQUENCE_HEADER),
      brought.headers.get('cache-control'),
    ]).toEqual([200, BEAD_BATCH_MEDIA_TYPE, '1', 'no-store']);
    expect(await bytesOf(brought)).toEqual(batchOf(first, second));

    // not acknowledged: brought back again
    expect(await bytesOf(await listen('after=0'))).toEqual(batchOf(first, second));

    // acknowledged: gone, and nothing left
    const empty = await listen('after=2&wait=0');

    expect([empty.status, await bytesOf(empty)]).toEqual([204, []]);
  });

  test('holds a listen until something comes within its wait, no longer than its limit, and ends it empty past it', async () => {
    const clock = createTestClock();
    const { connectScripted, listenOf, server } = await startScripted({
      clock,
      inactivityTimeout: Infinity,
      maximumWait: 1_000,
    });
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const lapsing = listenOf(connectionToken, 'wait=60000');

    // waiting, as long as the server lets it
    expect([
      lapsing.response.status,
      clock.armed.map(({ delay }) => {
        return delay;
      }),
    ]).toEqual([undefined, [1_000]]);

    clock.tick(1_000);

    expect(lapsing.response.status).toBe(204);

    const held = listenOf(connectionToken, 'after=0&wait=500');
    const envelope = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });

    await server.send(envelope, connectionHandle);

    expect([
      held.response.status,
      held.response.headers?.[SEQUENCE_HEADER],
      [...(held.response.body ?? [])],
    ]).toEqual([200, '1', batchOf(envelope)]);
    // its timer went with it
    expect(clock.armed[1]?.delay).toBe(500);
    expect(clock.cleared).toContain(clock.armed[1]?.handle);
    await server.stop();
  });

  test('lets a second listen take the place of the first, which ends empty; a listen lost closes nothing, and what it carried comes again', async () => {
    const { connectScripted, events, listenOf, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const first = listenOf(connectionToken, 'wait=20000');
    const second = listenOf(connectionToken, 'wait=20000');

    expect([first.response.status, second.response.status]).toEqual([204, undefined]);

    // what the second brings back goes nowhere: it is lost, and brought back to the next
    const envelope = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });

    second.response.isFinishing = false;
    await server.send(envelope, connectionHandle);
    second.response.close();

    const third = listenOf(connectionToken, 'after=0&wait=0');

    expect([third.response.status, [...(third.response.body ?? [])]]).toEqual([
      200,
      batchOf(envelope),
    ]);

    // a listen held, lost: what comes next waits for the one after it
    const dropped = listenOf(connectionToken, 'after=1&wait=20000');

    dropped.response.close();
    await server.send(envelope, connectionHandle);

    expect(dropped.response.status).toBeUndefined();
    expect(namesOf(events, 'close')).toEqual([]);
    await server.stop();
  });

  test('brings back all that waits in one batch, however large, numbered from its first', async () => {
    const { connectScripted, listenOf, server } = await startScripted({ maximumBodyBytes: 32 });
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const envelopes = [8, 8, 32].map((extra, index) => {
      return envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 2 * index + 1, extra });
    });

    for (const envelope of envelopes) {
      await server.send(envelope, connectionHandle);
    }

    // past the body limit together, and one alone: a batch is read as it comes, each bounded alone
    const all = listenOf(connectionToken, 'wait=0').response;
    const rest = listenOf(connectionToken, 'after=1&wait=0').response;

    expect([
      [all.headers?.[SEQUENCE_HEADER], [...(all.body ?? [])]],
      [rest.headers?.[SEQUENCE_HEADER], [...(rest.body ?? [])]],
      rest.headers?.['content-length'],
    ]).toEqual([
      ['1', batchOf(...envelopes)],
      ['2', batchOf(...envelopes.slice(1))],
      String(4 + 16 + 4 + 40),
    ]);
    await server.stop();
  });

  test('keeps for a listen an answer whose exchange ended, and anything else the server sends; one that does not listen drops the one, and rejects the other', async () => {
    const { connectScripted, listenOf, server } = await startScripted();
    const listening = connectScripted(undefined, { isListening: true });
    const deaf = connectScripted();
    const late = envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 });
    const command = envelopeOf(EnvelopeKind.REQUEST, { callId: 2 });

    await server.send(late, listening.connectionHandle);
    await server.send(command, listening.connectionHandle);
    await expect(server.send(late, deaf.connectionHandle)).resolves.toBeUndefined();
    await expect(server.send(command, deaf.connectionHandle)).rejects.toThrow(
      'this connection does not listen: an envelope of kind 0x10 goes nowhere'
    );

    const { response } = listenOf(listening.connectionToken, 'wait=0');

    expect([...(response.body ?? [])]).toEqual(batchOf(late, command));
    expect([
      server.isTwoWay(listening.connectionHandle),
      server.isTwoWay(deaf.connectionHandle),
      server.isTwoWay('type=HTTP;ip=127.0.0.1;ordinal=99'),
    ]).toEqual([true, false, false]);
    await server.stop();
  });

  test('refuses a listen where none was declared, 409, and one that asks what it cannot, 400; a connect that says it listens in any other way', async () => {
    const { connectScripted, fake, listenOf, server } = await startScripted();
    const listening = connectScripted(undefined, { isListening: true });
    const deaf = connectScripted();
    const statusOf = (exchange: ReturnType<typeof listenOf>) => {
      return [exchange.response.status, exchange.response.headers?.[REFUSAL_HEADER]];
    };
    const withBody = fake.exchange({
      headers: {
        [CONNECTION_TOKEN_HEADER]: listening.connectionToken,
        'content-length': '8',
      },
      method: 'GET',
    });
    const oddly = fake.exchange({
      headers: { 'content-type': BEAD_MEDIA_TYPE, [LISTEN_HEADER]: 'yes' },
    });
    const untold = fake.exchange({ headers: {}, method: 'GET' });

    expect([
      statusOf(listenOf(deaf.connectionToken)),
      statusOf(withBody),
      statusOf(listenOf(listening.connectionToken, 'after=one')),
      statusOf(listenOf(listening.connectionToken, 'wait=-1')),
      statusOf(listenOf(listening.connectionToken, 'after=1')),
      statusOf(oddly),
      statusOf(untold),
    ]).toEqual([
      [409, REFUSALS.LISTEN_UNDECLARED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
      [400, REFUSALS.MALFORMED],
    ]);

    // `?0` says it does not
    const declined = fake.exchange({
      headers: { 'content-type': BEAD_MEDIA_TYPE, [LISTEN_HEADER]: '?0' },
    });

    expect([declined.response.status, declined.response.headers?.[LISTEN_HEADER]]).toEqual([
      201,
      undefined,
    ]);
    expect(
      server.isTwoWay(server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle)
    ).toBe(false);
    await server.stop();
  });

  test('stamps a connection’s activity as an exchange of an envelope or a listen begins, never at its connect nor at a listen refused', async () => {
    const clock = createTestClock(1_000_250);
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted({ clock });
    const stampsOf = () => {
      return server.clients.map(({ lastActivity }) => {
        return lastActivity;
      });
    };
    const deaf = connectScripted();
    const listening = connectScripted(undefined, { isListening: true });

    expect([listenOf(deaf.connectionToken).response.status, stampsOf()]).toEqual([
      409,
      [undefined, undefined],
    ]);

    // an envelope's, as its exchange begins: not as its body ends
    clock.tick(1_000);
    const coming = exchangeOf(listening.connectionToken);
    clock.tick(1_000);
    fake.feed(coming.request, [envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 2 })]);

    expect([coming.response.status, stampsOf()]).toEqual([204, [undefined, 1_001_250]]);

    // a listen's, as it is held
    clock.tick(1_000);
    listenOf(listening.connectionToken, 'wait=0');

    expect(stampsOf()).toEqual([undefined, 1_003_250]);

    await server.stop();
  });

  test('closes a connection whose outbox holds more than its bound, and its listen learns it is gone', async () => {
    const { connectScripted, events, listenOf, server } = await startScripted({
      maximumOutboxBytes: 20,
    });
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const envelope = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1, extra: 2 });

    // 10 bytes, then 20: held
    await server.send(envelope, connectionHandle);
    await server.send(envelope, connectionHandle);

    expect(namesOf(events, 'close')).toEqual([]);

    // acknowledged, 10 bytes again; then 30: past it
    listenOf(connectionToken, 'after=2&wait=0');
    await server.send(envelope, connectionHandle);

    const held = listenOf(connectionToken, 'after=3&wait=20000');

    await server.send(envelope, connectionHandle);
    held.response.isFinishing = true;

    expect(held.response.status).toBe(200);

    await server.send(envelope, connectionHandle);
    await server.send(envelope, connectionHandle);

    expect(namesOf(events, 'close')).toEqual([['close', false, connectionHandle]]);

    // a listen held as its connection closes learns it is gone
    const other = connectScripted(undefined, { isListening: true });
    const waiting = listenOf(other.connectionToken, 'wait=20000');

    await server.close(other.connectionHandle);

    expect([waiting.response.status, waiting.response.headers?.[REFUSAL_HEADER]]).toEqual([
      404,
      REFUSALS.CONNECTION_UNKNOWN,
    ]);
    expect([MAXIMUM_OUTBOX_BYTES, MAXIMUM_WAIT]).toEqual([2 * MAXIMUM_BODY_BYTES, 30_000]);
    await server.stop();
  });

  test('answers a listen held once: what comes after, or its wait running out, before its response closes, waits for the next', async () => {
    const clock = createTestClock();
    let started: Awaited<ReturnType<typeof startScripted>> | undefined;

    try {
      started = await startScripted({ clock, inactivityTimeout: Infinity });

      const { connectScripted, listenOf, server } = started;
      const { connectionHandle, connectionToken } = connectScripted(undefined, {
        isListening: true,
      });
      const held = listenOf(connectionToken, 'wait=20000');
      const first = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });
      const second = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 3 });
      const third = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 5 });
      const changing = new Uint8Array(third);

      // its response closes later, as a real one does
      held.response.isFinishing = false;
      await server.send(first, connectionHandle);
      await server.send(second, connectionHandle);

      expect([...(held.response.body ?? [])]).toEqual(batchOf(first));
      expect(clock.cleared).toContain(clock.armed[0]?.handle);

      // what waits is a copy: changed after its send, it goes as it was
      await server.send(changing, connectionHandle);
      changing.fill(0);

      expect([...(listenOf(connectionToken, 'after=1&wait=0').response.body ?? [])]).toEqual(
        batchOf(second, third)
      );
    } finally {
      await started?.server.stop();
    }
  });

  test('ends a listen asked not to wait at once, with nothing, arming no timer', async () => {
    const clock = createTestClock();
    const { connectScripted, listenOf, server } = await startScripted({
      clock,
      inactivityTimeout: Infinity,
    });
    const { connectionToken } = connectScripted(undefined, { isListening: true });
    let status: number | undefined;
    const { armed } = timersBy(clock, () => {
      status = listenOf(connectionToken, 'wait=0').response.status;
    });

    expect([status, armed]).toEqual([204, []]);
    await server.stop();
  });

  test('keeps a notification for a listen, even on the call id of a request still waiting, which it never answers', async () => {
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const asking = exchangeOf(connectionToken);
    const notification = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });

    fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    await server.send(notification, connectionHandle);

    expect([asking.response.status, asking.response.body]).toEqual([200, undefined]);
    expect([...(listenOf(connectionToken, 'wait=0').response.body ?? [])]).toEqual(
      batchOf(notification)
    );
    await server.stop();
  });

  test('does not rest a connection whose listen is held when another of its exchanges ends', async () => {
    const clock = createTestClock();
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted({
      clock,
      inactivityTimeout: 2_000,
    });
    const { connectionToken } = connectScripted(undefined, { isListening: true });

    listenOf(connectionToken, 'wait=20000');

    const cancel = exchangeOf(connectionToken);
    // a cancel, handed on and ended at once: the listen still holds the connection awake
    const { armed } = timersBy(clock, () => {
      fake.feed(cancel.request, [envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 })]);
    });

    expect([
      cancel.response.status,
      armed.map(({ delay }) => {
        return delay;
      }),
    ]).toEqual([204, [BURIAL_MILLISECONDS]]);
    await server.stop();
  });

  test('counts a listen held as an exchange under way: its connection does not rest while it waits', async () => {
    const clock = createTestClock();
    const { connectScripted, listenOf, server } = await startScripted({
      clock,
      inactivityTimeout: 2_000,
    });
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });
    const before = clock.armed.length;
    const held = listenOf(connectionToken, 'wait=20000');
    const delays = () => {
      return clock.armed.slice(before).map(({ delay }) => {
        return delay;
      });
    };

    // its wait alone, no rest
    expect(delays()).toEqual([20_000]);

    await server.send(envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }), connectionHandle);

    // answered: the connection rests
    expect([held.response.status, delays()]).toEqual([200, [20_000, 2_000]]);
    await server.stop();
  });

  test('counts what it keeps of its connections, at the ceilings it has', async () => {
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted({
      maximumOutboxBytes: 64,
    });
    const listening = connectScripted(undefined, { isListening: true });
    const queued = connectScripted(
      { remoteAddress: '10.0.0.1', remotePort: 40_001 },
      {
        isListening: true,
      }
    );
    const other = connectScripted({ remoteAddress: '10.0.0.2', remotePort: 40_002 });
    const smaller = connectScripted(
      { remoteAddress: '10.0.0.1', remotePort: 40_003 },
      {
        isListening: true,
      }
    );
    const asking = exchangeOf(other.connectionToken);
    const cancelling = exchangeOf(other.connectionToken);
    const coming = exchangeOf(other.connectionToken);

    // a request waiting, a cancel before its request, a body still coming, a listen held, and an
    // outbox of two envelopes
    fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    fake.feed(cancelling.request, [envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 3 })]);
    coming.request.emit('data', Uint8Array.of(0xa1, 0x10, 0, 0));
    listenOf(listening.connectionToken, 'wait=20000');
    await server.send(
      envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }),
      queued.connectionHandle
    );
    await server.send(
      envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 3, extra: 4 }),
      queued.connectionHandle
    );
    await server.send(
      envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 5 }),
      smaller.connectionHandle
    );

    expect(server.gauges()).toEqual({
      anomalies: [],
      ceilings: {
        bodyBytes: BODY_BYTES_BUDGET,
        connections: MAXIMUM_CONNECTIONS,
        largestOutboxBytes: 64,
      },
      connectionHandles: new Set([
        listening.connectionHandle,
        queued.connectionHandle,
        other.connectionHandle,
        smaller.connectionHandle,
      ]),
      counts: {
        addresses: 2,
        bodyBytes: 4,
        buriedCallIds: 1,
        connections: 4,
        http2Sessions: 0,
        largestOutboxBytes: 20,
        listens: 1,
        outboxBytes: 28,
        outboxEnvelopes: 3,
        waitingExchanges: 1,
      },
    });

    // what a body held goes back as its request ends; what the connections held goes with them
    coming.request.emit('close');
    await server.stop();

    expect(server.gauges().counts).toMatchObject({
      addresses: 0,
      bodyBytes: 0,
      connections: 0,
      listens: 0,
      outboxBytes: 0,
      waitingExchanges: 0,
    });
  });

  test('refuses a listen on a connection gone, 404, as any exchange on it', async () => {
    const { connectScripted, listenOf, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted(undefined, {
      isListening: true,
    });

    await server.close(connectionHandle);

    const { response } = listenOf(connectionToken, 'wait=20000');

    expect([response.status, response.headers?.[REFUSAL_HEADER]]).toEqual([
      404,
      REFUSALS.CONNECTION_UNKNOWN,
    ]);
    await server.stop();
  });
});
