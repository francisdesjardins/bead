import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import {
  type ClientHttp2Session,
  connect as connectHTTP2,
  constants as http2Constants,
  createSecureServer,
  createServer as createHTTP2Server,
} from 'node:http2';
import { request as requestHTTPS } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { expect, test } from '@playwright/test';
import {
  EnvelopeKind,
  LIMIT_DEFAULTS,
  RESERVATION_MILLISECONDS,
} from '../../../router/shared/constants';
import { CancelError, ProgrammerError } from '../../shared/errors';
import { createTestClock, tcpSocketsClosed, timersBy } from '../../shared/__tests__/fixtures';
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
  START_DEFAULTS,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../http-transport-server';
import type { ITransportServerRefusal, TransportServerConnectionHandle } from '../types';
import { LISTENING_ADDRESSES, NO_LISTENING_ADDRESSES } from './addresses';
import { createFakeHTTPServer } from './fake-http-server';
import { TLS_FIXTURE } from './tls-fixture';

// helpers

const host = '127.0.0.1';

/** HTTP/2's error code of a malformed request (RFC 9113 §7). */
const PROTOCOL_ERROR = http2Constants.NGHTTP2_PROTOCOL_ERROR;

/** A bearer credential, RFC 6750's own example, its auth-scheme included. */
const BEARER = 'Bearer mF_9.B5f-4.1JqM';

/** A page of another origin, which a server answers CORS to when `origins` names it. */
const PAGE = 'https://page.test';

/** The fields every response on the path carries but HTTP's own 400, and the one CORS names. */
const PATH_FIELDS = [
  'access-control-allow-origin',
  'cache-control',
  'vary',
  'x-content-type-options',
] as const;

/** What a preflight from {@link PAGE} is answered, whatever it asks for, beside its 204. */
const PREFLIGHT_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-headers': 'authorization, *',
  'access-control-allow-methods': 'GET, POST, DELETE',
  'access-control-allow-origin': PAGE,
  'access-control-expose-headers': '*',
  'access-control-max-age': '7200',
  'bead-refusal': null,
  'cache-control': 'no-store',
  vary: 'Origin',
  'x-content-type-options': 'nosniff',
});

/** What every answer to {@link PAGE} carries of CORS once its origin is judged, but a preflight's. */
const NAMED_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-methods': null,
  'access-control-allow-origin': PAGE,
  'access-control-expose-headers': '*',
  vary: 'Origin',
});

/** What an answer that names no origin carries of CORS. */
const UNNAMED_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-methods': null,
  'access-control-allow-origin': null,
  'access-control-expose-headers': null,
  vary: 'Origin',
});

/** The fields `expected` names, as `headers` carries them: each one's value, or null when absent. */
const fieldsOf = (
  headers: { get(name: string): string | null | undefined },
  expected: Readonly<Record<string, string | null>>
) => {
  return Object.fromEntries(
    Object.keys(expected).map((name) => {
      return [name, headers.get(name) ?? null];
    })
  );
};

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
  server.on('message', ({ data }, connectionHandle) => {
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
  const connectScripted = ({
    isListening = false,
    socket,
  }: {
    isListening?: boolean;
    socket?: { remoteAddress?: string; remotePort?: number };
  } = {}) => {
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

  // spec 15.12.4
  test('keeps its constants in step with the router’s', () => {
    expect(ENVELOPE_KINDS).toEqual({
      CANCEL: EnvelopeKind.CANCEL,
      FAILURE: EnvelopeKind.FAILURE,
      REQUEST: EnvelopeKind.REQUEST,
      RESULT: EnvelopeKind.RESULT,
    });
    expect(BURIAL_MILLISECONDS).toBe(RESERVATION_MILLISECONDS);
    expect(MAXIMUM_BODY_BYTES).toBe(LIMIT_DEFAULTS.maximumEnvelopeBytes);
    expect(START_DEFAULTS).toEqual({ address: '127.0.0.1', findOpenPort: false, port: 80 });
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

    await server.send(
      { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3, extra: 1 }) },
      connectionHandle
    );
    await server.send(
      { data: envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 1 }) },
      connectionHandle
    );

    expect(await bytesOf(secondHead)).toEqual([
      ...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3, extra: 1 }),
    ]);
    expect(await bytesOf(firstHead)).toEqual([
      ...envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 1 }),
    ]);
    // an answer whose exchange ended is dropped, as one to a connection gone
    await expect(
      server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle)
    ).resolves.toBeUndefined();
  });

  test('answers an answer sent as its request is handed on in one go', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);

    server.on('message', () => {
      void server.send(
        { data: envelopeOf(ENVELOPE_KINDS.FAILURE, { callId: 5 }) },
        connectionHandle
      );
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

  test('hands a request on with its Authorization, whole, and any other envelope with none', async () => {
    await using started = await startTransport();
    const { server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const taken: unknown[] = [];

    server.on('message', ({ credential, data }) => {
      const kind = (data as Uint8Array)[1];

      taken.push([kind, credential]);

      if (kind === ENVELOPE_KINDS.REQUEST) {
        void server.send(
          { credential: BEARER, data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) },
          connectionHandle
        );
      }
    });

    const answered = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
      headers: { authorization: BEARER },
    });
    const cancelled = await post(url, {
      body: envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 }),
      connectionToken,
      headers: { authorization: BEARER },
    });

    await answered.arrayBuffer();

    // an answer carries none
    expect([answered.status, answered.headers.get('authorization'), cancelled.status]).toEqual([
      200,
      null,
      204,
    ]);
    expect(taken).toEqual([
      [ENVELOPE_KINDS.REQUEST, BEARER],
      [ENVELOPE_KINDS.CANCEL, undefined],
    ]);
  });

  test('takes an Authorization as it came, its surrounding spaces and tabs removed, an empty one carrying none', async () => {
    const { connectScripted, exchangeOf, fake, server } = await startScripted();
    const { connectionToken } = connectScripted();
    const taken: unknown[] = [];

    server.on('message', ({ credential }) => {
      taken.push(credential);
    });

    for (const [callId, authorization] of [
      [1, ' \tBearer  mF_9.B5f-4.1JqM \t'],
      [3, 'basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='],
      [5, ''],
      [7, ' \t '],
    ] as const) {
      fake.feed(exchangeOf(connectionToken, { authorization }).request, [
        envelopeOf(ENVELOPE_KINDS.REQUEST, { callId }),
      ]);
    }

    fake.feed(exchangeOf(connectionToken).request, [
      envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 9 }),
    ]);

    expect(taken).toEqual([
      'Bearer  mF_9.B5f-4.1JqM',
      'basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      undefined,
      undefined,
      undefined,
    ]);
    await server.stop();
  });

  test('refuses a POST with two Authorization fields 400, malformed, before reading its body, and hands the router nothing', async () => {
    const { connectScripted, events, fake, server } = await startScripted();
    const { connectionToken } = connectScripted();
    const twice = (authorization: string[]) => {
      const { request, response } = fake.exchange({
        headers: {
          authorization,
          'content-length': '8',
          'content-type': BEAD_MEDIA_TYPE,
          [CONNECTION_TOKEN_HEADER]: connectionToken,
        },
      });

      fake.feed(request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);

      return [
        response.status,
        response.headers?.[REFUSAL_HEADER],
        response.headers?.['connection'],
      ];
    };

    expect([twice([BEARER, BEARER]), twice([BEARER, ''])]).toEqual([
      [400, REFUSALS.MALFORMED, 'close'],
      [400, REFUSALS.MALFORMED, 'close'],
    ]);
    expect(namesOf(events, 'message')).toEqual([]);
    await server.stop();
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
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) }, connectionHandle);
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

  test('reads the Host as it came: an IDN page’s own in punycode, and one of invalid punycode taken, or refused host-refused, never a 500', async () => {
    // the status and the mark of a connect from each `[Host, Origin]`, on a server given `hosts`
    const answersOf = async (
      hosts: readonly string[] | undefined,
      connects: readonly (readonly [string, string?])[]
    ) => {
      await using started = await startTransport({ hosts });
      const { port } = new URL(started.url);
      const answers: [number, string | null][] = [];

      for (const [authority, origin] of connects) {
        const socket = connectTcp(Number(port), host);
        let text = '';

        socket.on('data', (chunk: Buffer) => {
          text += chunk.toString('latin1');
        });
        await once(socket, 'connect');
        socket.write(
          `POST /bead HTTP/1.1\r\nHost: ${authority}\r\n` +
            (origin === undefined ? '' : `Origin: ${origin}\r\n`) +
            `Content-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
        );
        await expect
          .poll(() => {
            return text.includes('\r\n\r\n');
          })
          .toBe(true);
        socket.destroy();

        answers.push([
          Number(text.split(' ')[1]),
          new RegExp(`${REFUSAL_HEADER}: (.*)\r\n`, 'iu').exec(text)?.[1] ?? null,
        ]);
      }

      return answers;
    };

    // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
    // and a Host of punycode that decodes to none, taken where every host is
    const page = ['xn--bad-bma.test:8080', 'http://xn--bad-bma.test:8080'] as const;

    expect(
      await answersOf(['*'], [page, ['xn--a'], ['xn--a.test'], ['xn---bad-cpa.test']])
    ).toEqual([
      [201, null],
      [201, null],
      [201, null],
      [201, null],
    ]);

    // hosts name an IDN host as the field carries it, in punycode, and none past them is taken
    expect(
      await answersOf(
        ['xn--bad-bma.test'],
        [page, ['XN--BAD-BMA.test:8080'], ['xn--a.test'], ['xn---bad-cpa.test'], ['xn--a']]
      )
    ).toEqual([
      [201, null],
      [201, null],
      [403, REFUSALS.HOST],
      [403, REFUSALS.HOST],
      [403, REFUSALS.HOST],
    ]);
  });

  test('answers a request without a Host, with two, or with one that is no host, 400 as HTTP does, unmarked', async () => {
    // the status, the mark and the body of a connect whose `Host` lines are `hosts`, once the
    // server closed its socket; a body in chunks read whole
    const answerOf = async (port: number, hostLines: readonly string[]) => {
      const socket = connectTcp(port, host);
      let text = '';

      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('latin1');
      });
      await once(socket, 'connect');
      socket.write(
        'POST /bead HTTP/1.1\r\n' +
          hostLines
            .map((line) => {
              return `Host: ${line}\r\n`;
            })
            .join('') +
          `Content-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
      );
      await once(socket, 'close');

      const [head = '', body = ''] = text.split(/\r\n\r\n(?<body>.*)/su);

      return [
        Number(head.split(' ')[1]),
        new RegExp(`${REFUSAL_HEADER}: (.*)\r\n`, 'iu').exec(head)?.[1] ?? null,
        /transfer-encoding: chunked/iu.test(head) && body === '0\r\n\r\n' ? '' : body,
      ];
    };

    // its head is the HTTP server's own, Node's for a `Host` missing, whether the server takes
    // every host or names some
    for (const hosts of [undefined, ['bead.test']]) {
      await using started = await startTransport({ hosts });
      const port = Number(new URL(started.url).port);

      expect(
        await Promise.all(
          [
            [],
            ['bead.test', 'elsewhere.test'],
            ['elsewhere.test', 'bead.test'],
            ['bead.test', 'bead.test'],
            ['bad host'],
          ].map((hostLines) => {
            return answerOf(port, hostLines);
          })
        )
      ).toEqual(
        Array.from({ length: 5 }, () => {
          return [400, null, ''];
        })
      );
      expect(namesOf(started.events, 'connection')).toEqual([]);
    }
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
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 7 }) }, connectionHandle);
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

  // spec 15.12.4
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
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle);
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
      server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle)
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
        server.send({ data: envelopeOf(kind, { callId: 2 }) }, connectionHandle),
        String(kind)
      ).rejects.toThrow('this connection does not listen');
    }

    await expect(server.send({ data: 'text' }, connectionHandle)).rejects.toBeInstanceOf(
      ProgrammerError
    );
    await expect(
      server.send({ data: new ArrayBuffer(4) }, connectionHandle)
    ).rejects.toBeInstanceOf(ProgrammerError);
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

  test('draws a connection whose connection listener throws, the next listener told, the throw reported with it', async () => {
    const { events, fake, server } = await startScripted();
    const thrown = new Error('a connection listener that throws');
    const told: TransportServerConnectionHandle[] = [];

    server.on('connection', () => {
      throw thrown;
    });
    server.on('connection', (...[, , connectionHandle]) => {
      told.push(connectionHandle);
    });

    const { response } = fake.exchange({ headers: { 'content-type': BEAD_MEDIA_TYPE } });
    const connectionHandle = server.clients.at(-1)?.connectionHandle;

    // drawn and given out: its 201 and its token, the connection among those it holds
    expect(response.status).toBe(201);
    expect(response.headers?.[CONNECTION_TOKEN_HEADER]).toMatch(/^[\w-]{22}$/u);
    expect(connectionHandle).toBeDefined();
    expect(told).toEqual([connectionHandle]);
    expect(namesOf(events, 'error')).toEqual([['error', thrown.message, connectionHandle]]);
    expect(namesOf(events, 'close')).toEqual([]);
  });

  test('hands on a request whose message listener throws, its answer still written, the throw reported with its connection', async () => {
    const { connectScripted, events, exchangeOf, fake, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted();
    const thrown = new Error('a message listener that throws');
    const heard: TransportServerConnectionHandle[] = [];

    server.on('message', () => {
      throw thrown;
    });
    server.on('message', (_, handle) => {
      heard.push(handle);
    });

    const asking = exchangeOf(connectionToken);

    fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);

    // the listener after it heard it, and its exchange still waits for its answer
    expect(heard).toEqual([connectionHandle]);
    expect(server.gauges().counts['waitingExchanges']).toBe(1);

    await server.send(
      { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1, extra: 1 }) },
      connectionHandle
    );

    expect(asking.response.status).toBe(200);
    expect([...(asking.response.body ?? [])]).toEqual([
      ...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1, extra: 1 }),
    ]);
    expect(namesOf(events, 'error')).toEqual([['error', thrown.message, connectionHandle]]);
    expect(server.clients).toHaveLength(1);
  });

  test('stops though a close listener throws: each connection still ends, its close told, the throw reported', async () => {
    const { connectScripted, events, server } = await startScripted();
    const first = connectScripted();
    const second = connectScripted();
    const thrown = new Error('a close listener that throws');
    const told: TransportServerConnectionHandle[] = [];

    server.on('close', () => {
      throw thrown;
    });
    server.on('close', (_, connectionHandle) => {
      told.push(connectionHandle);
    });

    await server.stop();

    expect(told).toEqual([first.connectionHandle, second.connectionHandle]);
    expect(namesOf(events, 'error')).toEqual([
      ['error', thrown.message, first.connectionHandle],
      ['error', thrown.message, second.connectionHandle],
    ]);
    expect(server.isClosed()).toBe(true);
  });

  test('closes a connection idle past its timeout though a close listener throws, the throw reported', async () => {
    const clock = createTestClock();
    const { connectScripted, events, server } = await startScripted({
      clock,
      inactivityTimeout: 2_000,
    });
    const thrown = new Error('a close listener that throws');

    try {
      const { connectionHandle } = connectScripted();

      server.on('close', () => {
        throw thrown;
      });

      clock.tick(2_000);

      expect(server.clients).toEqual([]);
      expect(namesOf(events, 'close')).toEqual([['close', false, connectionHandle]]);
      expect(namesOf(events, 'error')).toEqual([['error', thrown.message, connectionHandle]]);
    } finally {
      await server.stop();
    }
  });

  test('refuses a connect that comes as it stops, busy, told when to come back, drawing nothing', async () => {
    const { connectScripted, fake, server } = await startScripted();
    const answers: unknown[][] = [];

    connectScripted();

    // the stop calls it as it closes the connection it held, its own stop under way
    server.on('close', () => {
      const { response } = fake.exchange({ headers: { 'content-type': BEAD_MEDIA_TYPE } });

      answers.push([
        response.status,
        response.headers?.[REFUSAL_HEADER],
        response.headers?.['retry-after'],
        server.gauges().counts['connections'],
      ]);

      // what a connect is comes before when it came: another type, then a body
      for (const headers of [
        { 'content-type': 'text/plain' },
        { 'content-length': '5', 'content-type': BEAD_MEDIA_TYPE },
      ]) {
        const refused = fake.exchange({ headers }).response;

        answers.push([refused.status, refused.headers?.[REFUSAL_HEADER]]);
      }
    });

    await server.stop();

    expect(answers).toEqual([
      [503, REFUSALS.BUSY, '1', 0],
      [415, REFUSALS.TYPE],
      [400, REFUSALS.MALFORMED],
    ]);
  });

  test('answers the 404 marked connection-unknown an exchange that comes as it stops, its connection not yet closed, nothing handed on', async () => {
    const { connectScripted, events, exchangeOf, fake, listenOf, server } = await startScripted({
      origins: ['https://app.example'],
    });
    const answers: unknown[][] = [];

    connectScripted();

    const second = connectScripted();

    // the stop calls it as it closes the first connection, the second still held
    server.once('close', () => {
      const isHeld = server.clients.some(({ connectionHandle }) => {
        return connectionHandle === second.connectionHandle;
      });
      const asking = exchangeOf(second.connectionToken);

      fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
      answers.push([isHeld, asking.response.status, asking.response.headers?.[REFUSAL_HEADER]]);

      // what a request is comes before when it came; what is judged of an exchange against its
      // connection comes after the lookup a stopping server answers, in spec 15.6's order
      for (const { response } of [
        exchangeOf('not-a-token'),
        exchangeOf(second.connectionToken, { origin: 'https://elsewhere.example' }),
        exchangeOf(second.connectionToken, { 'content-type': 'text/plain' }),
        fake.exchange({
          headers: {
            authorization: ['Bearer a', 'Bearer b'],
            'content-type': BEAD_MEDIA_TYPE,
            [CONNECTION_TOKEN_HEADER]: second.connectionToken,
          },
        }),
        exchangeOf(second.connectionToken, { 'content-length': String(2 ** 31) }),
        listenOf(second.connectionToken, 'after=x'),
      ]) {
        answers.push([response.status, response.headers?.[REFUSAL_HEADER]]);
      }
    });

    await server.stop();

    expect(answers).toEqual([
      [true, 404, REFUSALS.CONNECTION_UNKNOWN],
      [400, REFUSALS.MALFORMED],
      [403, REFUSALS.ORIGIN],
      [404, REFUSALS.CONNECTION_UNKNOWN],
      [404, REFUSALS.CONNECTION_UNKNOWN],
      [404, REFUSALS.CONNECTION_UNKNOWN],
      [404, REFUSALS.CONNECTION_UNKNOWN],
    ]);
    expect(namesOf(events, 'message')).toEqual([]);
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
      ['inactivityTimeout', -2],
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

  test('refuses as it is built a hosts entry with a port, and an origins entry that is *', () => {
    const built = (options: Partial<IHTTPTransportServerOptions>) => {
      return () => {
        return createHTTPTransportServer({
          createServer: (listener) => {
            return createServer(listener);
          },
          ...options,
        });
      };
    };

    expect(built({ hosts: ['bead.test:8080'] })).toThrow(ProgrammerError);
    expect(built({ hosts: ['bead.test', '*'] })).toThrow(ProgrammerError);
    expect(built({ origins: ['*'] })).toThrow(ProgrammerError);
    expect(built({ origins: ['https://bead.test/'] })).toThrow(ProgrammerError);
    expect(built({ hosts: ['*'], origins: ['https://bead.test', 'null'] })).not.toThrow();
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
      await server.send(
        { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) },
        connectionHandle
      );
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
        server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) }, connectionHandle)
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

/**
 * How the server ends a `POST` over HTTP/2 of `headers`: its status and its `bead-refusal`, or the
 * code its stream was reset with, nothing written.
 */
const answerOverHTTP2 = (session: ClientHttp2Session, headers: Record<string, string>) => {
  return new Promise<[number | undefined, unknown] | number>((resolve) => {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/bead',
      'content-type': BEAD_MEDIA_TYPE,
      ...headers,
    });
    let head: [number | undefined, unknown] | undefined;

    stream.once('response', (response) => {
      head = [response[':status'], response[REFUSAL_HEADER]];
    });
    stream.on('data', () => {});
    stream.on('error', () => {});
    stream.once('close', () => {
      resolve(head ?? stream.rstCode);
    });
    stream.end();
  });
};

/** The code the server reset a `POST` over HTTP/2 of `headers` with; none when it answered it. */
const resetOf = async (session: ClientHttp2Session, headers: Record<string, string>) => {
  const answer = await answerOverHTTP2(session, headers);

  return typeof answer === 'number' ? answer : undefined;
};

/** A transport server under TLS, HTTP/2 and HTTP/1.1 on one port, and a session to it. */
const startSecure = async (options: Partial<IHTTPTransportServerOptions> = {}) => {
  const server = createHTTPTransportServer({
    createServer: (listener) => {
      return createSecureServer({ ...TLS_FIXTURE, allowHTTP1: true }, (request, response) => {
        listener(request, response);
      });
    },
    ...options,
  });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const session = connectHTTP2(`https://${host}:${String(port)}`, { ca: TLS_FIXTURE.cert });

  session.on('error', () => {});

  return {
    port,
    server,
    session,
    [Symbol.asyncDispose]: async () => {
      session.close();
      await server.stop();
    },
  };
};

test.describe('createHTTPTransportServer, over TLS', () => {
  // spec 15.12
  test('answers a preflight over HTTP/2 as over HTTP/1.1', async () => {
    await using started = await startSecure({ origins: [PAGE] });
    const { port, server, session } = started;
    const refusals: unknown[] = [];
    const asked = {
      'access-control-request-headers': 'authorization,content-type',
      'access-control-request-method': 'POST',
      origin: PAGE,
    };

    server.on('refusal', (refusal) => {
      refusals.push(refusal);
    });

    // its status, and the fields it carries
    type Answer = [number | undefined, IncomingHttpHeaders];

    // over HTTP/2
    const overHTTP2 = await new Promise<Answer>((resolve, reject) => {
      const stream = session.request({ ':method': 'OPTIONS', ':path': '/bead', ...asked });

      stream.once('response', (headers) => {
        resolve([headers[':status'], headers]);
      });
      stream.on('data', () => {});
      stream.on('error', reject);
      stream.end();
    });
    // over HTTP/1.1, on the same port
    const overHTTP1 = await new Promise<Answer>((resolve, reject) => {
      const request = requestHTTPS(
        { ca: TLS_FIXTURE.cert, headers: asked, host, method: 'OPTIONS', path: '/bead', port },
        (response) => {
          response.resume();
          resolve([response.statusCode, response.headers]);
        }
      );

      request.on('error', reject);
      request.end();
    });

    for (const [status, headers] of [overHTTP2, overHTTP1]) {
      const fields = {
        get: (name: string) => {
          return headers[name] as string | undefined;
        },
      };

      expect([status, fieldsOf(fields, PREFLIGHT_ANSWER)]).toEqual([204, PREFLIGHT_ANSWER]);
    }

    expect(refusals).toEqual([]);
  });

  test('names its host over HTTP/2 by its :authority, a host beside it ignored, for the host and the own origin', async () => {
    await using started = await startSecure({ hosts: ['bead.test'] });
    const { session } = started;

    expect(
      await Promise.all([
        answerOverHTTP2(session, { ':authority': 'bead.test:8443', host: 'rebind.example' }),
        answerOverHTTP2(session, { ':authority': 'rebind.example:8443', host: 'bead.test' }),
        answerOverHTTP2(session, {
          ':authority': 'bead.test:8443',
          host: 'rebind.example:8443',
          origin: 'https://bead.test:8443',
        }),
        answerOverHTTP2(session, {
          ':authority': 'bead.test:8443',
          host: 'rebind.example:8443',
          origin: 'https://rebind.example:8443',
        }),
      ])
    ).toEqual([
      [201, undefined],
      [403, REFUSALS.HOST],
      [201, undefined],
      [403, REFUSALS.ORIGIN],
    ]);
  });

  test('resets over HTTP/2 the stream of a request whose :authority is no host, PROTOCOL_ERROR, nothing written', async () => {
    await using started = await startSecure({ hosts: ['*'] });
    const { server, session } = started;
    const connections: unknown[] = [];

    server.on('connection', (...params) => {
      connections.push(params);
    });

    // a percent-encoded octet, `*`, `;` and `=`, `+` in a name, an IPvFuture literal, a colon with
    // no port, after a name and after a literal; then one it takes, on the same session
    expect(
      await Promise.all(
        ['a%41.test', 'a*b.test', 'a;b=c', 'a+b.test', '[v1.bead]', 'localhost:', '[::1]:'].map(
          (authority) => {
            return resetOf(session, { ':authority': authority });
          }
        )
      )
    ).toEqual(
      Array.from({ length: 7 }, () => {
        return PROTOCOL_ERROR;
      })
    );
    expect(connections).toEqual([]);
    expect(await answerOverHTTP2(session, { ':authority': 'localhost' })).toEqual([201, undefined]);
  });

  test('resets over HTTP/2 the stream of a request with a field holding an octet past ASCII, PROTOCOL_ERROR, and tells nothing', async () => {
    await using started = await startSecure();
    const { server, session } = started;
    const told: unknown[] = [];

    server.on('refusal', (refusal) => {
      told.push(refusal);
    });

    expect(
      await Promise.all([
        resetOf(session, { 'x-other': 'café' }),
        resetOf(session, { origin: 'http://café.example' }),
      ])
    ).toEqual([PROTOCOL_ERROR, PROTOCOL_ERROR]);
    expect(told).toEqual([]);
    // a tab is taken
    expect(await answerOverHTTP2(session, { 'x-other': 'a\tb' })).toEqual([201, undefined]);
  });

  test('takes over HTTP/2 a request with a field holding a control character but a tab, which Node’s parser drops before the transport reads the request', async () => {
    await using started = await startSecure();
    const { server, session } = started;
    const told: unknown[] = [];

    server.on('refusal', (refusal) => {
      told.push(refusal);
    });

    // ! nghttp2 drops a regular field whose value holds one, and Node gives the request without it:
    // an Origin judged as none, where the C# side's transport resets the stream
    expect(
      await Promise.all([
        answerOverHTTP2(session, { origin: 'http://a.example\u001B[2J' }),
        answerOverHTTP2(session, { 'x-other': 'a\u0007b' }),
      ])
    ).toEqual([
      [201, undefined],
      [201, undefined],
    ]);
    expect(told).toEqual([]);
  });

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
    server.on('message', ({ data }, connectionHandle) => {
      const envelope = data as Uint8Array;
      const callId = new DataView(envelope.buffer, envelope.byteOffset).getUint32(4);

      void server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId }) }, connectionHandle);
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

      // an authority that is no host: HTTP/2's stream reset, HTTP/1.1's 400
      expect([
        await resetOf(session, { ':authority': 'localhost:' }),
        (await postHTTPS(port, { headers: { host: 'localhost:' } })).status,
      ]).toEqual([PROTOCOL_ERROR, 400]);
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
  test('is secure under TLS whatever it listens on, or on a loopback host alone, and carries no credential toward a connection', async () => {
    const securedBy = async ({ address, isTls }: { address: string; isTls: boolean }) => {
      const fake = createFakeHTTPServer({ address: { address, port: 50_000 } });
      const server = createHTTPTransportServer({
        createServer: (listener) => {
          const created = fake.createServer(listener);

          // a server under TLS has its contexts, as Node's https server does
          return isTls ? Object.assign(created, { addContext: () => {} }) : created;
        },
      });
      const starting = server.start({ address, port: 50_000 });

      fake.listen();
      await starting;

      try {
        const drawn = 'type=HTTP;ip=192.0.2.9;ordinal=1' as const;

        return [server.carriesCredential(drawn), server.isSecure(drawn)];
      } finally {
        await server.stop();
      }
    };

    expect(
      await Promise.all([
        securedBy({ address: '192.0.2.1', isTls: true }),
        securedBy({ address: '192.0.2.1', isTls: false }),
        securedBy({ address: '127.0.0.1', isTls: false }),
      ])
    ).toEqual([
      [false, true],
      [false, false],
      [false, true],
    ]);
  });

  test('is secure as its application says what stands in front of it, whatever it listens on, and by what it listens on when it says nothing', async () => {
    const securedBy = async ({
      address,
      isTls = false,
      secure,
    }: {
      address: string;
      isTls?: boolean;
      secure?: boolean;
    }) => {
      const fake = createFakeHTTPServer({ address: { address, port: 50_000 } });
      const server = createHTTPTransportServer({
        createServer: (listener) => {
          const created = fake.createServer(listener);

          return isTls ? Object.assign(created, { addContext: () => {} }) : created;
        },
        ...(secure === undefined ? {} : { secure }),
      });
      const starting = server.start({ address, port: 50_000 });

      fake.listen();
      await starting;

      try {
        return server.isSecure('type=HTTP;ip=192.0.2.9;ordinal=1');
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
        // a proxy on the machine, or a server of its own under TLS, that serves the network in the
        // clear
        securedBy({ address: '127.0.0.1', secure: false }),
        securedBy({ address: '192.0.2.1', isTls: true, secure: false }),
        securedBy({ address: '127.0.0.1', secure: true }),
      ])
    ).toEqual([true, false, true, false, false, true]);
  });

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
    const { fake, server } = await startScripted({ hosts: ['bead.example'] });
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
      // an HTTP/1.1 request with no host, which HTTP refuses of its own, unmarked
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
      // HTTP/2's authority before a host beside it, one way and the other
      statusOf(
        { ':authority': 'bead.example', 'content-type': BEAD_MEDIA_TYPE, host: 'rebound.example' },
        { httpVersionMajor: 2 }
      ),
      statusOf(
        { ':authority': 'rebound.example', 'content-type': BEAD_MEDIA_TYPE, host: 'bead.example' },
        { httpVersionMajor: 2 }
      ),
      // a target in absolute-form names the authority, its Host ignored but for being one, its
      // path and its query read after it
      statusOf(bead, { url: 'http://bead.example:8443/bead' }),
      statusOf({ ...bead, host: 'rebound.example' }, { url: 'https://bead.example/bead' }),
      statusOf({ ...bead, host: 'bad host' }, { url: 'http://localhost/bead?after=1' }),
      statusOf(bead, { url: 'http://rebound.example/bead' }),
      statusOf(bead, { url: 'http://bead.example' }),
      statusOf(bead, { url: 'http://bead.example?after=1' }),
      // and HTTP refuses one that names no host, a colon with no port and a userinfo among them,
      // another scheme's, or one beside two Host lines
      statusOf(bead, { url: 'http:///bead' }),
      statusOf(bead, { url: 'http://a%41.test/bead' }),
      statusOf(bead, { url: 'http://127.0.0.1:/bead' }),
      statusOf(bead, { url: 'http://user@bead.example/bead' }),
      statusOf(bead, { url: 'HTTP://bead.example/bead' }),
      statusOf(bead, { url: 'ftp://bead.example/bead' }),
      statusOf(
        { ...bead, host: ['bead.example', 'bead.example'] },
        { url: 'http://bead.example/bead' }
      ),
    ]).toEqual([
      [201, undefined],
      [404, REFUSALS.PATH],
      [404, REFUSALS.PATH],
      [201, undefined],
      [403, REFUSALS.ORIGIN],
      [403, REFUSALS.HOST],
      [400, undefined],
      [201, undefined],
      [415, REFUSALS.TYPE],
      [201, undefined],
      [403, REFUSALS.HOST],
      [201, undefined],
      [201, undefined],
      [201, undefined],
      [403, REFUSALS.HOST],
      [404, REFUSALS.PATH],
      [404, REFUSALS.PATH],
      [400, undefined],
      [400, undefined],
      [400, undefined],
      [400, undefined],
      [400, undefined],
      [400, undefined],
      [400, undefined],
    ]);

    // HTTP/2's authority that is no host resets its stream, nothing written
    const reset = fake.exchange({
      headers: { ':authority': 'localhost:', 'content-type': BEAD_MEDIA_TYPE },
      httpVersionMajor: 2,
    });

    expect([reset.response.status, reset.response.isDestroyed]).toEqual([undefined, true]);

    const { response } = fake.exchange({ headers: bead, httpVersion: '1.0' });
    const absolute = fake.exchange({
      headers: bead,
      httpVersion: '1.0',
      url: 'http://bead.example/bead',
    });
    // no target at all: the root, which is not the path
    const untargeted = fake.exchange({
      headers: { ...bead, host: 'bead.example' },
      url: undefined,
    });

    // no host at all, which an HTTP/1.0 request may name, where hosts are listed; and none beside
    // a target in absolute-form, which names it
    expect([response.status, absolute.response.status]).toEqual([403, 201]);
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
    connectScripted({ socket: { remoteAddress: '10.0.0.4' } });

    expect(server.clients.at(-1)?.port).toBe(0);
    await server.stop();
  });

  test('names a client that comes over IPv4 to a dual-stack listener by its IPv4 address', async () => {
    const server = createHTTPTransportServer({
      createServer: (listener) => {
        return createServer(listener);
      },
      isProxyTrusted: true,
    });
    const { port } = await server.start({ address: '::', findOpenPort: true });
    const url = `http://${host}:${String(port)}/bead`;

    try {
      const drawn = await connect(url, server);
      // the socket's address, IPv4 mapped into IPv6, read as the loopback a proxy comes from
      const forwarded = await post(url, { headers: { 'x-forwarded-for': '203.0.113.9' } });

      expect(forwarded.status).toBe(201);
      expect(server.clients).toMatchObject([
        { address: host, connectionHandle: drawn.connectionHandle },
        { address: '203.0.113.9', connectionHandle: 'type=HTTP;ip=203.0.113.9;ordinal=2' },
      ]);
      expect(drawn.connectionHandle).toBe('type=HTTP;ip=127.0.0.1;ordinal=1');
    } finally {
      await server.stop();
    }
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

    const sending = server.send(
      { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) },
      connectionHandle
    );

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

  // spec 15.12.4
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

    connectScripted({ socket: { remoteAddress: '10.0.0.1', remotePort: 40_000 } });

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
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle);

    expect(clock.armed.slice(before)).toEqual([]);

    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) }, connectionHandle);

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
    await server.send({ data: answer }, connectionHandle);

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
    await server.send({ data: first }, connectionHandle);
    await server.send({ data: second }, connectionHandle);

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
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
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

    await server.send({ data: envelope }, connectionHandle);

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
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const first = listenOf(connectionToken, 'wait=20000');
    const second = listenOf(connectionToken, 'wait=20000');

    expect([first.response.status, second.response.status]).toEqual([204, undefined]);

    // what the second brings back goes nowhere: it is lost, and brought back to the next
    const envelope = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });

    second.response.isFinishing = false;
    await server.send({ data: envelope }, connectionHandle);
    second.response.close();

    const third = listenOf(connectionToken, 'after=0&wait=0');

    expect([third.response.status, [...(third.response.body ?? [])]]).toEqual([
      200,
      batchOf(envelope),
    ]);

    // a listen held, lost: what comes next waits for the one after it
    const dropped = listenOf(connectionToken, 'after=1&wait=20000');

    dropped.response.close();
    await server.send({ data: envelope }, connectionHandle);

    expect(dropped.response.status).toBeUndefined();
    expect(namesOf(events, 'close')).toEqual([]);
    await server.stop();
  });

  test('brings back all that waits in one batch, however large, numbered from its first', async () => {
    const { connectScripted, listenOf, server } = await startScripted({ maximumBodyBytes: 32 });
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const envelopes = [8, 8, 32].map((extra, index) => {
      return envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 2 * index + 1, extra });
    });

    for (const envelope of envelopes) {
      await server.send({ data: envelope }, connectionHandle);
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
    const listening = connectScripted({ isListening: true });
    const deaf = connectScripted();
    const late = envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 });
    const command = envelopeOf(EnvelopeKind.REQUEST, { callId: 2 });

    await server.send({ data: late }, listening.connectionHandle);
    await server.send({ data: command }, listening.connectionHandle);
    await expect(server.send({ data: late }, deaf.connectionHandle)).resolves.toBeUndefined();
    await expect(server.send({ data: command }, deaf.connectionHandle)).rejects.toThrow(
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
    const listening = connectScripted({ isListening: true });
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
    const listening = connectScripted({ isListening: true });

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

  test('tells a listen held, once past its refusals, and its end while its connection stands: one refused tells nothing and restarts nothing, and a second and the first it replaces each tell theirs', async () => {
    const clock = createTestClock();
    const { connectScripted, listenOf, server } = await startScripted({
      clock,
      inactivityTimeout: 2_000,
    });
    const told: unknown[] = [];

    server.on('listen', (isHeld, connectionHandle) => {
      told.push([isHeld, connectionHandle]);
    });

    const deaf = connectScripted();
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });

    // undeclared, 409, and asking what it cannot, 400: no timer stopped nor armed
    const refused = timersBy(clock, () => {
      expect(
        [
          listenOf(deaf.connectionToken),
          listenOf(connectionToken, 'wait=soon'),
          listenOf(connectionToken, 'after=1'),
        ].map(({ response }) => {
          return response.status;
        })
      ).toEqual([409, 400, 400]);
    });

    expect([told, refused]).toEqual([[], { armed: [], cleared: [] }]);

    // a second in the place of the first, which ends empty: each tells its own, the second first,
    // so a server's count never falls to none between them
    listenOf(connectionToken, 'wait=20000');
    listenOf(connectionToken, 'wait=20000');

    expect(told).toEqual([
      [true, connectionHandle],
      [true, connectionHandle],
      [false, connectionHandle],
    ]);

    // its connection closed: the listen it held ends untold
    await server.close(connectionHandle);

    expect(told).toHaveLength(3);
    await server.stop();
  });

  test('closes a connection whose outbox holds more than its bound, and its listen learns it is gone', async () => {
    const { connectScripted, events, listenOf, server } = await startScripted({
      maximumOutboxBytes: 20,
    });
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const envelope = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1, extra: 2 });

    // 10 bytes, then 20: held
    await server.send({ data: envelope }, connectionHandle);
    await server.send({ data: envelope }, connectionHandle);

    expect(namesOf(events, 'close')).toEqual([]);

    // acknowledged, 10 bytes again; then 30: past it
    listenOf(connectionToken, 'after=2&wait=0');
    await server.send({ data: envelope }, connectionHandle);

    const held = listenOf(connectionToken, 'after=3&wait=20000');

    await server.send({ data: envelope }, connectionHandle);
    held.response.isFinishing = true;

    expect(held.response.status).toBe(200);

    await server.send({ data: envelope }, connectionHandle);
    await server.send({ data: envelope }, connectionHandle);

    expect(namesOf(events, 'close')).toEqual([['close', false, connectionHandle]]);

    // a listen held as its connection closes learns it is gone
    const other = connectScripted({ isListening: true });
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
      const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
      const held = listenOf(connectionToken, 'wait=20000');
      const first = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });
      const second = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 3 });
      const third = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 5 });
      const changing = new Uint8Array(third);

      // its response closes later, as a real one does
      held.response.isFinishing = false;
      await server.send({ data: first }, connectionHandle);
      await server.send({ data: second }, connectionHandle);

      expect([...(held.response.body ?? [])]).toEqual(batchOf(first));
      expect(clock.cleared).toContain(clock.armed[0]?.handle);

      // what waits is a copy: changed after its send, it goes as it was
      await server.send({ data: changing }, connectionHandle);
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
    const { connectionToken } = connectScripted({ isListening: true });
    let status: number | undefined;
    const { armed } = timersBy(clock, () => {
      status = listenOf(connectionToken, 'wait=0').response.status;
    });

    expect([status, armed]).toEqual([204, []]);
    await server.stop();
  });

  test('keeps a notification for a listen, even on the call id of a request still waiting, which it never answers', async () => {
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted();
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const asking = exchangeOf(connectionToken);
    const notification = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });

    fake.feed(asking.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 })]);
    await server.send({ data: notification }, connectionHandle);

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
    const { connectionToken } = connectScripted({ isListening: true });

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
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const before = clock.armed.length;
    const held = listenOf(connectionToken, 'wait=20000');
    const delays = () => {
      return clock.armed.slice(before).map(({ delay }) => {
        return delay;
      });
    };

    // its wait alone, no rest
    expect(delays()).toEqual([20_000]);

    await server.send(
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }) },
      connectionHandle
    );

    // answered: the connection rests
    expect([held.response.status, delays()]).toEqual([200, [20_000, 2_000]]);
    await server.stop();
  });

  test('counts what it keeps of its connections, at the ceilings it has', async () => {
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted({
      maximumOutboxBytes: 64,
    });
    const listening = connectScripted({ isListening: true });
    const queued = connectScripted({
      isListening: true,
      socket: { remoteAddress: '10.0.0.1', remotePort: 40_001 },
    });
    const other = connectScripted({ socket: { remoteAddress: '10.0.0.2', remotePort: 40_002 } });
    const smaller = connectScripted({
      isListening: true,
      socket: { remoteAddress: '10.0.0.1', remotePort: 40_003 },
    });
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
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }) },
      queued.connectionHandle
    );
    await server.send(
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 3, extra: 4 }) },
      queued.connectionHandle
    );
    await server.send(
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 5 }) },
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
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });

    await server.close(connectionHandle);

    const { response } = listenOf(connectionToken, 'wait=20000');

    expect([response.status, response.headers?.[REFUSAL_HEADER]]).toEqual([
      404,
      REFUSALS.CONNECTION_UNKNOWN,
    ]);
    await server.stop();
  });
});

/**
 * What a request written raw as `head` is answered: its status and its mark, the fields its head
 * carries by their names in lower case, and the port it came from.
 */
const rawAnswerOf = async (port: number, head: string) => {
  const socket = connectTcp(port, host);
  let text = '';
  let isClosed = false;

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString('latin1');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    isClosed = true;
  });
  await once(socket, 'connect');

  const { localPort } = socket;

  socket.write(Buffer.from(head, 'latin1'));
  await expect
    .poll(() => {
      return text.includes('\r\n\r\n') || isClosed;
    })
    .toBe(true);
  socket.destroy();

  const lines = text.split('\r\n\r\n')[0]?.split('\r\n').slice(1) ?? [];

  return {
    answer: [
      Number(text.split(' ')[1]),
      new RegExp(`${REFUSAL_HEADER}: (.*)\r\n`, 'iu').exec(text)?.[1] ?? null,
    ],
    fields: new Map(
      lines.map((line) => {
        const colon = line.indexOf(':');

        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      })
    ),
    localPort,
  };
};

/** A connect written raw, naming `authority`, with the field lines `fields` before its own. */
const rawConnectOf = (authority: string, fields = '') => {
  return (
    `POST /bead HTTP/1.1\r\nHost: ${authority}\r\n${fields}` +
    `Content-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
  );
};

/** Each refusal `server` tells from now on. */
const refusalsOf = (server: HTTPTransportServer) => {
  const refusals: ITransportServerRefusal[] = [];

  server.on('refusal', (refusal) => {
    refusals.push(refusal);
  });

  return refusals;
};

/** A preflight from `origin` (Fetch §3.3.2): an `OPTIONS` naming the method it asks for, and its fields. */
const preflight = (
  url: string,
  { fields, method, origin = PAGE }: { fields?: string; method: string; origin?: string }
) => {
  return fetch(url, {
    headers: {
      'access-control-request-method': method,
      origin,
      ...(fields === undefined ? {} : { 'access-control-request-headers': fields }),
    },
    method: 'OPTIONS',
  });
};

test.describe('createHTTPTransportServer, CORS', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  // spec 15.6, 15.12
  test('answers a preflight from an origin it names 204, naming it, the methods, Authorization and any other field, for 7200 seconds, and tells no refusal', async () => {
    await using started = await startTransport({ origins: [PAGE, 'null'] });
    const { events, server, url } = started;
    const refusals = refusalsOf(server);
    // what a page asks before a connect, before a listen at its own URL, and of a method the
    // server does not take, which its browser refuses against the answer
    const answers = [
      await preflight(url, { fields: 'bead-listen,content-type,traceparent', method: 'POST' }),
      await preflight(`${url}?after=0&wait=0`, {
        fields: 'bead-connection-token',
        method: 'GET',
      }),
      await preflight(url, { method: 'PUT' }),
    ];

    for (const answer of answers) {
      expect([
        answer.status,
        fieldsOf(answer.headers, PREFLIGHT_ANSWER),
        await bytesOf(answer),
      ]).toEqual([204, PREFLIGHT_ANSWER, []]);
    }

    // null, when named, as any origin named
    const opaque = await preflight(url, { method: 'POST', origin: 'null' });

    expect([opaque.status, fieldsOf(opaque.headers, PREFLIGHT_ANSWER)]).toEqual([
      204,
      { ...PREFLIGHT_ANSWER, 'access-control-allow-origin': 'null' },
    ]);
    // no refusal, and no connection drawn
    expect(refusals).toEqual([]);
    expect([namesOf(events, 'connection'), server.clients]).toEqual([[], []]);
  });

  // spec 15.4, 15.9, 15.12
  test('names an origin it names on every answer it writes to it once that origin is judged, a batch and a refusal among them, and exposes every field', async () => {
    await using started = await startTransport({ origins: [PAGE, 'null'] });
    const { events, server, url } = started;
    const headers = { origin: PAGE };
    const named: unknown[] = [];
    const name = async (answered: Response | Promise<Response>) => {
      const response = await answered;

      named.push([response.status, fieldsOf(response.headers, NAMED_ANSWER)]);

      return response;
    };

    // a connect that listens, its token read
    const drawn = await name(post(url, { headers: { ...headers, [LISTEN_HEADER]: '?1' } }));
    const connectionToken = drawn.headers.get(CONNECTION_TOKEN_HEADER) ?? '';
    const connectionHandle = server.clients.at(-1)
      ?.connectionHandle as TransportServerConnectionHandle;

    // a request with its Authorization, its head going as it is handed on, then answered
    const request = post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
      headers: { ...headers, authorization: BEARER },
    });
    const head = await name(request);

    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle);
    await head.arrayBuffer();

    // one answered as it is handed on, in one go
    server.on('message', ({ data }) => {
      if ((data as Uint8Array)[7] === 3) {
        void server.send(
          { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) },
          connectionHandle
        );
      }
    });
    await name(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
        connectionToken,
        headers,
      })
    );

    // a batch
    await server.send(
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }) },
      connectionHandle
    );
    await name(
      fetch(`${url}?after=0&wait=0`, {
        headers: { ...headers, [CONNECTION_TOKEN_HEADER]: connectionToken },
      })
    );

    // refusals once the origin is judged: an OPTIONS that is no preflight, a body of another type,
    // a token that is none
    const bare = await name(fetch(url, { headers, method: 'OPTIONS' }));
    await name(
      post(url, { connectionToken, headers: { ...headers, 'content-type': 'text/plain' } })
    );
    await name(post(url, { connectionToken: 'not-a-token', headers }));

    // a DELETE, and an exchange after it
    await name(
      fetch(url, {
        headers: { ...headers, [CONNECTION_TOKEN_HEADER]: connectionToken },
        method: 'DELETE',
      })
    );
    await name(post(url, { connectionToken, headers }));

    expect(named).toEqual(
      [201, 200, 200, 200, 405, 415, 400, 204, 404].map((status) => {
        return [status, NAMED_ANSWER];
      })
    );
    expect(bare.headers.get('allow')).toBe('GET, POST, DELETE');
    expect(namesOf(events, 'message')).toHaveLength(2);

    // null, when named, as any origin named
    const opaque = await post(url, { headers: { origin: 'null' } });

    expect([opaque.status, fieldsOf(opaque.headers, NAMED_ANSWER)]).toEqual([
      201,
      { ...NAMED_ANSWER, 'access-control-allow-origin': 'null' },
    ]);
  });

  // spec 15.6, 15.12
  test('names no origin to its own, to a request with none, to one it does not take, nor before the origin is judged, and varies every answer by Origin but HTTP’s own 400', async () => {
    await using started = await startTransport({ origins: [PAGE] });
    const { server, url } = started;
    const refusals = refusalsOf(server);
    const port = Number(new URL(url).port);
    const authority = `${host}:${String(port)}`;
    const answerOf = async (head: string) => {
      const { answer, fields } = await rawAnswerOf(port, head);

      return [
        ...answer,
        fieldsOf(
          {
            get: (field) => {
              return fields.get(field);
            },
          },
          UNNAMED_ANSWER
        ),
      ];
    };
    const unnamed = (status: number, reason: string | null) => {
      return [status, reason, UNNAMED_ANSWER];
    };

    expect([
      // its own origin, and none
      await answerOf(rawConnectOf(authority, `Origin: http://${authority}\r\n`)),
      await answerOf(rawConnectOf(authority)),
      // a preflight from its own origin, and from none: no CORS request, so a method it does not take
      await answerOf(
        `OPTIONS /bead HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://${authority}\r\n` +
          'Access-Control-Request-Method: POST\r\n\r\n'
      ),
      await answerOf(
        `OPTIONS /bead HTTP/1.1\r\nHost: ${authority}\r\nAccess-Control-Request-Method: POST\r\n\r\n`
      ),
      // an origin it does not take
      await answerOf(rawConnectOf(authority, 'Origin: https://elsewhere.test\r\n')),
      // a page it names, before its origin is judged: by a host it does not take, at another path
      await answerOf(
        `OPTIONS /bead HTTP/1.1\r\nHost: rebind.example\r\nOrigin: ${PAGE}\r\n` +
          'Access-Control-Request-Method: POST\r\n\r\n'
      ),
      await answerOf(
        `OPTIONS /elsewhere HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${PAGE}\r\n` +
          'Access-Control-Request-Method: POST\r\n\r\n'
      ),
    ]).toEqual([
      unnamed(201, null),
      unnamed(201, null),
      unnamed(405, REFUSALS.METHOD),
      unnamed(405, REFUSALS.METHOD),
      unnamed(403, REFUSALS.ORIGIN),
      unnamed(403, REFUSALS.HOST),
      unnamed(404, REFUSALS.PATH),
    ]);
    expect(
      refusals.map(({ reason }) => {
        return reason;
      })
    ).toEqual([REFUSALS.METHOD, REFUSALS.METHOD, REFUSALS.ORIGIN, REFUSALS.HOST, REFUSALS.PATH]);

    // HTTP's own 400, from a page it names: two hosts, and a field of an octet past ASCII
    for (const fields of [`Host: ${authority}\r\n`, 'X-Other: café\r\n']) {
      const { answer, fields: carried } = await rawAnswerOf(
        port,
        rawConnectOf(authority, `Origin: ${PAGE}\r\n${fields}`)
      );

      expect([
        ...answer,
        ...PATH_FIELDS.filter((field) => {
          return carried.has(field);
        }),
      ]).toEqual([400, null]);
    }
  });
});

test.describe('createHTTPTransportServer, the refusals it tells', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('tells each refusal it judges of its own, its status, its reason, the request’s authority and origin and the client’s address and port, and nothing of HTTP’s own', async () => {
    const { connectScripted, exchangeOf, fake, server } = await startScripted({
      hosts: ['bead.test'],
      maximumBodyBytes: 16,
    });
    const refusals = refusalsOf(server);
    // an IPv4 client an IPv6 socket carries mapped, read as itself
    const socket = { remoteAddress: '::ffff:192.0.2.7', remotePort: 40_001 };
    const told = (refusal: Partial<ITransportServerRefusal>) => {
      return {
        address: '192.0.2.7',
        authority: 'bead.test',
        origin: undefined,
        port: 40_001,
        ...refusal,
      };
    };

    try {
      // a host it does not take, its origin in two field lines; then one named by its target
      fake.exchange({
        headers: { host: 'rebind.example:8080', origin: ['http://rebind.example:8080', 'null'] },
        socket,
      });
      fake.exchange({ headers: { host: 'bead.test' }, socket, url: 'http://elsewhere.test:81/' });
      // an HTTP/1.0 request names none
      fake.exchange({ headers: {}, httpVersion: '1.0', socket });
      fake.exchange({ headers: { host: 'bead.test' }, socket, url: '/other' });
      fake.exchange({ headers: { host: 'bead.test', origin: 'https://elsewhere.test' }, socket });
      fake.exchange({ headers: { host: 'bead.test' }, method: 'PUT', socket });
      fake.exchange({ headers: { host: 'bead.test', 'content-type': 'text/plain' }, socket });
      // a token no connection holds, as it arrives
      fake.exchange({
        headers: {
          host: 'bead.test',
          'content-type': BEAD_MEDIA_TYPE,
          [CONNECTION_TOKEN_HEADER]: 'A'.repeat(22),
        },
        socket,
      });

      // a body refused as it comes, past its bound
      const { connectionToken } = connectScripted();
      const large = exchangeOf(connectionToken);

      fake.feed(large.request, [new Uint8Array(17)]);

      // what HTTP refuses of its own, told by none: two hosts, an octet past ASCII
      fake.exchange({ headers: { host: ['bead.test', 'bead.test'] }, socket });
      fake.exchange({ headers: { host: 'bead.test', 'x-other': 'café' }, socket });
      // nor what is no refusal: a connect drawn, a DELETE
      fake.exchange({
        headers: { [CONNECTION_TOKEN_HEADER]: connectionToken },
        method: 'DELETE',
        socket,
      });

      expect(refusals).toEqual([
        told({
          authority: 'rebind.example:8080',
          origin: 'http://rebind.example:8080, null',
          reason: REFUSALS.HOST,
          status: 403,
        }),
        told({ authority: 'elsewhere.test:81', reason: REFUSALS.HOST, status: 403 }),
        told({ authority: undefined, reason: REFUSALS.HOST, status: 403 }),
        told({ reason: REFUSALS.PATH, status: 404 }),
        told({ origin: 'https://elsewhere.test', reason: REFUSALS.ORIGIN, status: 403 }),
        told({ reason: REFUSALS.METHOD, status: 405 }),
        told({ reason: REFUSALS.TYPE, status: 415 }),
        told({ reason: REFUSALS.CONNECTION_UNKNOWN, status: 404 }),
        {
          address: '10.0.0.1',
          authority: 'bead.localhost',
          origin: undefined,
          port: 40_000,
          reason: REFUSALS.TOO_LARGE,
          status: 413,
        },
      ]);
    } finally {
      await server.stop();
    }

    // on the wire, the port its client's socket came from, and the address of the loopback
    await using started = await startTransport({ isProxyTrusted: true });
    const wire = refusalsOf(started.server);
    const port = Number(new URL(started.url).port);
    const { answer, localPort } = await rawAnswerOf(port, rawConnectOf('rebind.example'));
    // behind a proxy it trusts, the address it forwarded, and the port of the proxy's connection
    const behind = await rawAnswerOf(
      port,
      rawConnectOf('rebind.example', 'X-Forwarded-For: 203.0.113.9\r\n')
    );

    expect([answer, behind.answer]).toEqual([
      [403, REFUSALS.HOST],
      [403, REFUSALS.HOST],
    ]);
    expect(wire).toEqual([
      {
        address: host,
        authority: 'rebind.example',
        origin: undefined,
        port: localPort,
        reason: REFUSALS.HOST,
        status: 403,
      },
      {
        address: '203.0.113.9',
        authority: 'rebind.example',
        origin: undefined,
        port: behind.localPort,
        reason: REFUSALS.HOST,
        status: 403,
      },
    ]);
  });

  test('tells no refusal of the 404 that ends an exchange or a listen as its connection closes, by a DELETE, a timeout, an outbox past its bound, a close and a stop', async () => {
    const clock = createTestClock();
    const { connectScripted, exchangeOf, fake, listenOf, server } = await startScripted({
      clock,
      exchangeTimeout: 1_000,
      maximumOutboxBytes: 20,
    });
    const refusals = refusalsOf(server);
    const ends: unknown[] = [];
    // a listen held on a connection that listens, its end read once it ended
    const holding = () => {
      const drawn = connectScripted({ isListening: true });
      const held = listenOf(drawn.connectionToken, 'wait=20000');

      return {
        ...drawn,
        read: () => {
          ends.push([held.response.status, held.response.headers?.[REFUSAL_HEADER]]);
        },
      };
    };

    // its client's DELETE
    const deleted = holding();

    fake.exchange({
      headers: { [CONNECTION_TOKEN_HEADER]: deleted.connectionToken },
      method: 'DELETE',
    });
    deleted.read();

    // a request unanswered past its timeout
    const timed = holding();

    fake.feed(exchangeOf(timed.connectionToken).request, [
      envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
    ]);
    clock.tick(1_000);
    timed.read();

    // an outbox past its bound, by one envelope larger than it
    const overflowing = holding();
    const notification = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1, extra: 20 });

    await server.send({ data: notification }, overflowing.connectionHandle);
    overflowing.read();

    // its application's close
    const closed = holding();

    await server.close(closed.connectionHandle);
    closed.read();

    // a body still coming as its connection closes
    const coming = connectScripted();
    const body = exchangeOf(coming.connectionToken);

    body.request.emit('data', envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }).subarray(0, 4));
    await server.close(coming.connectionHandle);
    body.request.emit('end');
    ends.push([body.response.status, body.response.headers?.[REFUSAL_HEADER]]);

    // a stop
    const stopped = holding();

    await server.stop();
    stopped.read();

    expect(ends).toEqual(
      Array.from({ length: 6 }, () => {
        return [404, REFUSALS.CONNECTION_UNKNOWN];
      })
    );
    expect(refusals).toEqual([]);
  });

  test('answers 400 unmarked, with none of the path’s fields, a field holding a control character other than HTAB or an octet past ASCII, and tells nothing', async () => {
    await using started = await startTransport({ origins: ['http://a.example'] });
    const refusals = refusalsOf(started.server);
    const port = Number(new URL(started.url).port);
    const authority = `${host}:${String(port)}`;
    // in Origin and in a field the transport never reads: an escape sequence, BEL, DEL, and an
    // octet past ASCII, written as the one octet 0xE9; Node's parser answers the first three
    const fields = [
      'Origin: http://a.example\u001B[2J\r\n',
      'X-Other: a\u0007b\r\n',
      'Origin: http://a.example\u007F\r\n',
      'Origin: http://café.example\r\n',
      'X-Other: café\r\n',
    ];
    const answers: unknown[] = [];

    // each from a page the server names besides, which none of them names
    for (const field of fields) {
      const { answer, fields: carried } = await rawAnswerOf(
        port,
        rawConnectOf(authority, `Origin: http://a.example\r\n${field}`)
      );

      answers.push([
        ...answer,
        ...PATH_FIELDS.filter((name) => {
          return carried.has(name);
        }),
      ]);
    }

    expect(answers).toEqual(
      fields.map(() => {
        return [400, null];
      })
    );
    expect(refusals).toEqual([]);
    expect(namesOf(started.events, 'connection')).toEqual([]);

    // a tab is taken, and the origin judged as any other
    const tabbed = await rawAnswerOf(
      port,
      rawConnectOf(authority, 'Origin: http://a.example\tb\r\n')
    );

    expect(tabbed.answer).toEqual([403, REFUSALS.ORIGIN]);
    expect(refusals).toEqual([
      {
        address: host,
        authority,
        origin: 'http://a.example\tb',
        port: tabbed.localPort,
        reason: REFUSALS.ORIGIN,
        status: 403,
      },
    ]);
  });

  test('refuses as it would though a refusal listener throws, the throw reported with no connection', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;

    server.on('refusal', () => {
      throw new Error('a refusal listener that throws');
    });

    // a listener after it is told all the same
    const after = refusalsOf(server);

    expect(await refusalOf(fetch(`${url}/other`, { method: 'POST' }))).toEqual([
      404,
      REFUSALS.PATH,
    ]);
    expect(await refusalOf(post(url, { connectionToken: 'A'.repeat(22) }))).toEqual([
      404,
      REFUSALS.CONNECTION_UNKNOWN,
    ]);
    expect(after).toHaveLength(2);
    expect(namesOf(events, 'error')).toEqual([
      ['error', 'a refusal listener that throws', ''],
      ['error', 'a refusal listener that throws', ''],
    ]);
    // and it draws a connection as before
    expect((await post(url)).status).toBe(201);
  });
});

test.describe('createHTTPTransportServer, the address it listens on', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('listens on the loopback when given no address, reached by 127.0.0.1 and by localhost, and is secure there', async () => {
    const server = createHTTPTransportServer({
      createServer: (listener) => {
        return createServer(listener);
      },
    });

    try {
      const { address, port } = await server.start({ findOpenPort: true });

      expect([address, server.address, START_DEFAULTS.address]).toEqual([
        '127.0.0.1',
        '127.0.0.1',
        '127.0.0.1',
      ]);

      for (const name of [host, 'localhost']) {
        const response = await post(`http://${name}:${String(port)}/bead`);

        expect([name, response.status]).toEqual([name, 201]);
      }

      expect(
        server.clients.map(({ connectionHandle }) => {
          return server.isSecure(connectionHandle);
        })
      ).toEqual([true, true]);
    } finally {
      await server.stop();
    }
  });

  test('refuses to start on an address that is no bare IP address, ending closed', async () => {
    const startedOn = async (address: string) => {
      const fake = createFakeHTTPServer({ address: { address, port: 50_000 } });
      const server = createHTTPTransportServer({ createServer: fake.createServer });
      const starting = server.start({ address, port: 50_000 });

      fake.listen();

      const outcome = await starting.then(
        () => {
          return 'listening';
        },
        (reason: unknown) => {
          return reason instanceof ProgrammerError ? reason.message : String(reason);
        }
      );

      await server.stop();

      // a server refused opened nothing
      return [address, outcome, server.isClosed(), fake.servers.length];
    };

    expect(await Promise.all(LISTENING_ADDRESSES.map(startedOn))).toEqual(
      LISTENING_ADDRESSES.map((address) => {
        return [address, 'listening', true, 1];
      })
    );
    expect(await Promise.all(NO_LISTENING_ADDRESSES.map(startedOn))).toEqual(
      NO_LISTENING_ADDRESSES.map((address) => {
        return [
          address,
          address === '[::1]'
            ? 'a server listens on an IP address, not "[::1]": write ::1, not [::1]'
            : `a server listens on an IP address, not "${address}"`,
          true,
          0,
        ];
      })
    );
  });

  test('is secure on the IPv6 loopback or an address in 127.0.0.0/8, and not on a wildcard', async () => {
    const securedOn = async (address: string) => {
      const fake = createFakeHTTPServer({ address: { address, port: 50_000 } });
      const server = createHTTPTransportServer({ createServer: fake.createServer });
      const starting = server.start({ address, port: 50_000 });

      fake.listen();
      await starting;

      try {
        return [address, server.isSecure('type=HTTP;ip=192.0.2.9;ordinal=1')];
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
