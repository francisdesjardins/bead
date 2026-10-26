import { createHash } from 'node:crypto';
import {
  createServer as createNodeServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import {
  connect as connectHTTP2,
  constants as http2Constants,
  createServer as createHTTP2Server,
} from 'node:http2';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { create, toBinary } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { EnvelopeKind, LIMIT_DEFAULTS, SERVER_FAILURES } from '../../router/shared/constants';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { httpPolicyOf } from '../../transport/server/http-policy';
import { createMemoryTransportServer } from '../../transport/server/memory-transport-server';
import type { IHTTPRequestLike, IHTTPResponseLike } from '../../transport/server/types';
import { createTestClock } from '../../transport/shared/__tests__/fixtures';
import type { IClock } from '../../transport/shared/clock';
import { ProgrammerError } from '../../transport/shared/errors';
import { createHTTPGateway, type IHTTPGateway } from '../http-gateway';
import type { IHttpRouteInit } from '../routes';
import { HTTP_ROUTES, OPENAPI_DOCUMENT } from './generated/bead_http';
import { TranscodingProcedures } from './generated/transcoding_bead';
import { EdgesSchema, TickSchema } from './generated/transcoding_pb';
import { GOOD_CREDENTIAL, SESSION, startTranscoding } from './transcoding-service';

// interfaces

/** A request the test sends: its method, its target, its fields, its body's text, and its abort. */
interface ISent {
  body?: string | Uint8Array;
  headers?: Record<string, string | string[]>;
  method?: string;
  path: string;
  signal?: AbortSignal;
}

/** A response as the test reads it. */
interface IAnswered {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

/** A refusal or a failure of the gateway's own, as a request meets it: its status, mark and words. */
interface IOwnCase {
  body?: string;
  /** Its request's line, then its fields; a `host` of the gateway's own where it names none. */
  lines: readonly string[];
  /** Its `bead-refusal`; none for a failure of its own, unmarked. */
  reason?: string;
  status: number;
  words: string;
}

// constants

/** The origin of another site the gateways here name. */
const ORIGIN = 'https://app.example';

// helpers

/** Sends `sent` to the gateway on `port`, and reads its whole response; its `signal` drops its socket. */
const send = (port: number, sent: ISent): Promise<IAnswered> => {
  const { body, headers = {}, method = 'POST', path, signal } = sent;

  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        host: '127.0.0.1',
        method,
        path,
        port,
        ...(signal === undefined ? {} : { signal }),
      },
      (incoming) => {
        const chunks: Buffer[] = [];

        incoming.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0,
          });
        });
      }
    );

    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

/** A request's octets as a socket of the test's own writes them: its lines, its length, its body. */
const octetsOf = (port: number, { body = '', lines }: Pick<IOwnCase, 'body' | 'lines'>): string => {
  const [line = '', ...fields] = lines;
  const named = fields.some((field) => {
    return field.toLowerCase().startsWith('host:');
  });
  const isChunked = fields.some((field) => {
    return field.toLowerCase().startsWith('transfer-encoding:');
  });

  return [
    line,
    ...(named ? [] : [`host: 127.0.0.1:${String(port)}`]),
    ...fields,
    ...(body === '' || isChunked ? [] : [`content-length: ${String(Buffer.byteLength(body))}`]),
    'connection: close',
    '',
    body,
  ].join('\r\n');
};

/** Opens a socket of the test's own to the gateway on `port` and writes `octets` on it. */
const opened = (port: number, octets: string): Socket => {
  const socket = connect(port, '127.0.0.1');

  socket.on('error', () => {});
  socket.write(octets);

  return socket;
};

/** Writes `octets` on a socket of its own, and reads the response whole, to the socket's close. */
const exchanged = (port: number, octets: string): Promise<IAnswered> => {
  const socket = opened(port, octets);
  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  return new Promise((resolve) => {
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const end = text.indexOf('\r\n\r\n');
      const [statusLine = '', ...fields] = text.slice(0, end).split('\r\n');
      const headers: IncomingHttpHeaders = {};

      for (const field of fields) {
        const colon = field.indexOf(':');

        headers[field.slice(0, colon).trim().toLowerCase()] = field.slice(colon + 1).trim();
      }

      resolve({
        body: text.slice(end + 4),
        headers,
        status: Number(statusLine.split(' ')[1]),
      });
    });
  });
};

/** Reads `socket` until what came holds `end`, and gives what came; fails as it closes before. */
const readUntil = (socket: Socket, end: string): Promise<string> => {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    const onClose = (): void => {
      reject(
        new Error(`the socket ended before ${end}: ${Buffer.concat(chunks).toString('utf8')}`)
      );
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);

      const text = Buffer.concat(chunks).toString('utf8');

      if (text.includes(end)) {
        socket.off('data', onData);
        socket.off('close', onClose);
        resolve(text);
      }
    };

    socket.on('data', onData);
    socket.on('close', onClose);
  });
};

/** Writes `octets` on a socket of its own, and counts every byte that came back to its close. */
const receivedOn = (port: number, octets: string): Promise<number> => {
  const socket = opened(port, octets);
  let count = 0;

  socket.on('data', (chunk: Buffer) => {
    count += chunk.length;
  });

  return new Promise((resolve) => {
    socket.on('close', () => {
      resolve(count);
    });
  });
};

/** What a case's response parts from it: its status, its mark, and its problem's words exactly. */
const partsOf = (answered: IAnswered, expected: IOwnCase): string[] => {
  const { detail } = JSON.parse(answered.body || '{}') as { detail?: string };
  const parts = [
    ...(answered.status === expected.status ? [] : [`status ${String(answered.status)}`]),
    ...(answered.headers['bead-refusal'] === expected.reason
      ? []
      : [`bead-refusal ${String(answered.headers['bead-refusal'])}`]),
    ...(detail === expected.words ? [] : [`detail ${String(detail)}`]),
  ];

  return parts.map((part) => {
    return `${expected.words}: ${part}`;
  });
};

/** The messages of every error `gateway` reports, as it reports them. */
const reportedBy = (gateway: IHTTPGateway): string[] => {
  const reported: string[] = [];

  gateway.on('error', (error) => {
    reported.push(error.message);
  });

  return reported;
};

/** Waits, on the real clock, for `condition`; throws past `within` milliseconds. */
const until = async (condition: () => boolean, within = 2_000): Promise<void> => {
  const deadline = performance.now() + within;

  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error('the condition never held');
    }

    await sleep(5);
  }
};

/** The route table, raw's route told its result is an Edges: what it echoes read as one. */
const rawAsEdges = (): readonly IHttpRouteInit[] => {
  return HTTP_ROUTES.map((init) => {
    return init.procedure === TranscodingProcedures.raw
      ? {
          ...init,
          procedure: { ...init.procedure, result: TranscodingProcedures.echoEdges.result },
          result: EdgesSchema,
        }
      : init;
  });
};

// tests

test('draws one Bead connection per exchange, and closes it as its response ends', async () => {
  await using fixture = await startTranscoding();
  const opened: string[] = [];
  const closed: string[] = [];

  fixture.server.transport.on('connection', (...[, , connectionHandle]) => {
    opened.push(connectionHandle);
  });
  fixture.server.transport.on('close', (_wasClean, connectionHandle) => {
    closed.push(connectionHandle);
  });

  const [one, other] = await Promise.all([
    send(fixture.port, { body: '{"anInt32":1}', path: '/api/Transcoding/echo' }),
    send(fixture.port, { body: '{"anInt32":2}', path: '/api/Transcoding/echo' }),
  ]);

  expect([one.body, other.body].toSorted()).toEqual(['{"anInt32":1}', '{"anInt32":2}']);
  await until(() => {
    return closed.length === 2;
  });
  expect(opened.length).toBe(2);
  expect(new Set(opened).size).toBe(2);
  expect(closed.toSorted()).toEqual(opened.toSorted());

  for (const handle of opened) {
    // * each the in-memory transport's, drawn for the caller's address
    expect(handle).toMatch(/^type=MEMORY;ip=127\.0\.0\.1;/u);
  }

  // a refusal of its own, or a body its reading refuses, draws none
  expect(
    (await send(fixture.port, { body: '{"nope":1}', path: '/api/Transcoding/echo' })).status
  ).toBe(400);
  expect((await send(fixture.port, { method: 'GET', path: '/nope' })).status).toBe(404);
  expect(opened.length).toBe(2);
});

test('presents the Authorization field ELSEWHERE, or as a JWT under bearer-jwt', async () => {
  await using elsewhere = await startTranscoding();
  const whoAmI = { body: '{}', path: '/api/Transcoding/whoAmI' };

  expect(
    await send(elsewhere.port, { ...whoAmI, headers: { authorization: ` ${GOOD_CREDENTIAL} ` } })
  ).toMatchObject({ body: `{"session":"${SESSION}"}`, status: 200 });
  expect(await send(elsewhere.port, whoAmI)).toMatchObject({
    headers: { 'www-authenticate': 'Bearer' },
    status: 401,
  });
  expect(
    await send(elsewhere.port, { ...whoAmI, headers: { authorization: 'Bearer bad' } })
  ).toMatchObject({ headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, status: 401 });

  await using jwt = await startTranscoding({ authorization: 'bearer-jwt' });
  const reported = reportedBy(jwt.gateway);
  // the server is given no JWT verifier: the scheme the gateway chose is its own misconfiguration
  const presented = await send(jwt.port, { ...whoAmI, headers: { authorization: 'bearer a.b.c' } });

  expect(presented.status).toBe(500);
  expect(JSON.parse(presented.body)).toMatchObject({ code: 36, title: 'CREDENTIAL_UNSUPPORTED' });
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatch(/^the server takes none of the scheme this gateway presents: /u);
  expect(
    await send(jwt.port, { ...whoAmI, headers: { authorization: 'Basic YTpi' } })
  ).toMatchObject({
    headers: { 'www-authenticate': 'Bearer error="invalid_request"' },
    status: 401,
  });
  // a token its request's block holds, 1,004 bytes, and one past it
  expect(
    (await send(jwt.port, { ...whoAmI, headers: { authorization: `Bearer ${'a'.repeat(1_004)}` } }))
      .status
  ).toBe(500);
  expect(
    (await send(jwt.port, { ...whoAmI, headers: { authorization: `Bearer ${'a'.repeat(1_005)}` } }))
      .status
  ).toBe(431);
});

test('refuses a request with no Origin from a page of another site, and a navigation to an unmarked get rule', async () => {
  await using fixture = await startTranscoding({ origins: [ORIGIN] });
  const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' };
  const subresource = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' };

  // a navigation to what reads alone: the document, and a GET on a method marked NO_SIDE_EFFECTS
  expect(
    (await send(fixture.port, { headers: navigation, method: 'GET', path: '/openapi.json' })).status
  ).toBe(200);
  expect(
    (
      await send(fixture.port, {
        headers: navigation,
        method: 'GET',
        path: '/v1/books/2',
      })
    ).status
  ).toBe(200);

  for (const [headers, path] of [
    [subresource, '/v1/books/2'],
    [navigation, '/v1/shelves/s/books'],
    [{ ...navigation, 'sec-fetch-site': 'same-site' }, '/v1/shelves/s/books'],
    [{ ...navigation, 'sec-fetch-site': 'same-site' }, '/v1/operations'],
  ] as const) {
    const refused = await send(fixture.port, { headers, method: 'GET', path });

    expect(refused.status, path).toBe(403);
    expect(refused.headers['bead-refusal']).toBe('origin-refused');
  }

  // its own origin's, and one from no browser, taken; an origin shown is judged by its own gate
  expect(
    (
      await send(fixture.port, {
        headers: { ...subresource, 'sec-fetch-site': 'same-origin' },
        method: 'GET',
        path: '/v1/shelves/s/books',
      })
    ).status
  ).toBe(200);
  expect((await send(fixture.port, { method: 'GET', path: '/v1/shelves/s/books' })).status).toBe(
    200
  );
  expect(
    (
      await send(fixture.port, {
        headers: { ...subresource, origin: ORIGIN },
        method: 'GET',
        path: '/v1/shelves/s/books',
      })
    ).status
  ).toBe(200);
});

test('answers a call whose peer closes before its result with 502 and releases its place', async () => {
  await using memory = createMemoryTransportServer();
  await memory.start();
  await using gateway = createHTTPGateway({
    createServer: createNodeServer,
    maximumExchanges: 1,
    routes: HTTP_ROUTES,
    transport: memory,
  });
  const reported = reportedBy(gateway);
  let requests = 0;

  memory.on('message', ({ data }, connectionHandle) => {
    const envelope = readEnvelope(bytesOf(data), {
      failures: SERVER_FAILURES,
      maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
    });

    if (envelope?.kind === EnvelopeKind.REQUEST) {
      requests += 1;
      void memory.close(connectionHandle);
    }
  });
  const { port } = await gateway.start({ address: '127.0.0.1' });

  for (let index = 0; index < 2; index += 1) {
    const answered = await send(port, { body: '{}', path: '/api/Transcoding/echo' });

    expect(answered).toMatchObject({
      body: '{"detail":"the connection closed","status":502,"title":"Bad Gateway","type":"about:blank"}',
      headers: { 'content-type': 'application/problem+json' },
      status: 502,
    });
    expect(answered.headers['bead-refusal']).toBeUndefined();
    await until(() => {
      return memory.clients.length === 0;
    });
  }
  expect(requests).toBe(2);
  expect(reported).toHaveLength(2);
});

test('answers a failed stream request as a problem before writing any event', async () => {
  await using fixture = await startTranscoding({
    maximumConnections: 1,
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.watch
        ? {
            ...init,
            procedure: {
              ...init.procedure,
              procedure: { ...init.procedure.procedure, procedureId: 99 },
            },
          }
        : init;
    }),
  });
  const reported = reportedBy(fixture.gateway);
  const drawn: string[] = [];
  const closed: string[] = [];

  fixture.memory.on('connection', (...[, , handle]) => {
    drawn.push(handle);
  });
  fixture.memory.on('close', (_wasClean, handle) => {
    closed.push(handle);
  });

  for (let count = 1; count <= 2; count += 1) {
    const answered = await send(fixture.port, {
      body: '{}',
      headers: { accept: 'text/event-stream' },
      path: '/api/Transcoding/watch',
    });

    expect(answered).toMatchObject({
      body: '{"code":19,"detail":"no procedure 99 in service 1","scope":"protocol","status":501,"title":"PROCEDURE_UNKNOWN","type":"tag:francisdesjardins.ca,2026:bead/PROCEDURE_UNKNOWN"}',
      status: 501,
    });
    expect(answered.headers['content-type']).toBe('application/problem+json');
    expect(answered.headers['bead-refusal']).toBeUndefined();
    await until(() => {
      return closed.length === count;
    });
    expect(drawn).toHaveLength(count);
    expect(closed.toSorted()).toEqual(drawn.toSorted());
    expect(reported).toHaveLength(count);
  }
});

test('answers a stream’s request that carries Last-Event-ID with 204 and no call', async () => {
  await using fixture = await startTranscoding();
  let connections = 0;

  fixture.server.transport.on('connection', () => {
    connections += 1;
  });

  const answered = await send(fixture.port, {
    body: '{"from":2}',
    headers: { accept: 'text/event-stream', 'last-event-id': '3' },
    path: '/api/Transcoding/ticks',
  });

  expect(answered).toMatchObject({ body: '', status: 204 });
  expect(answered.headers['content-type']).toBeUndefined();
  expect(connections).toBe(0);

  // a call to the same procedure, not asking for a stream, is a call
  expect(
    await send(fixture.port, {
      body: '{"from":2}',
      headers: { 'last-event-id': '3' },
      path: '/api/Transcoding/ticks',
    })
  ).toMatchObject({ body: '{"ticks":2}', status: 200 });
});

test('answers a preflight with the methods its URL’s routes take', async () => {
  await using fixture = await startTranscoding({ origins: [ORIGIN] });
  const preflight = (path: string): Promise<IAnswered> => {
    return send(fixture.port, {
      headers: {
        'access-control-request-headers': 'content-type',
        'access-control-request-method': 'PATCH',
        origin: ORIGIN,
      },
      method: 'OPTIONS',
      path,
    });
  };

  expect(await preflight('/v1/shelves/1/books/2')).toMatchObject({
    headers: {
      'access-control-allow-headers': 'authorization, content-type, *',
      'access-control-allow-methods': 'GET, HEAD, PATCH',
      'access-control-allow-origin': ORIGIN,
      'access-control-max-age': '7200',
    },
    status: 204,
  });
  expect((await preflight('/v1/shelves/1/books/2:archive')).headers).toMatchObject({
    'access-control-allow-methods': 'POST',
  });
  expect((await preflight('/api/Transcoding/echo')).headers).toMatchObject({
    'access-control-allow-methods': 'POST',
  });
  expect((await preflight('/api/Transcoding/getOperation')).headers).toMatchObject({
    'access-control-allow-methods': 'GET, HEAD, POST',
  });
  expect((await preflight('/openapi.json')).headers).toMatchObject({
    'access-control-allow-methods': 'GET, HEAD',
  });

  // from an origin it does not name, refused before any preflight
  expect(
    (
      await send(fixture.port, {
        headers: { 'access-control-request-method': 'POST', origin: 'https://other.example' },
        method: 'OPTIONS',
        path: '/api/Transcoding/echo',
      })
    ).status
  ).toBe(403);
});

test('cancels the call of a request aborted', async () => {
  await using fixture = await startTranscoding();
  const abort = new AbortController();
  const hanging = send(fixture.port, {
    body: '{}',
    path: '/api/Transcoding/hang',
    signal: abort.signal,
  });

  hanging.catch(() => {});
  await until(() => {
    return fixture.counts.hanging === 1;
  });
  abort.abort();
  await until(() => {
    return fixture.counts.cancelled === 1;
  });

  // and a call past its timeout ends cancelled too, answered 504
  await using timed = await startTranscoding({ timeout: 50 });
  const answered = await send(timed.port, { body: '{}', path: '/api/Transcoding/hang' });

  expect(answered.status).toBe(504);
  await until(() => {
    return timed.counts.cancelled === 1;
  });
});

test('answers a command to an exchange’s connection SERVICE_UNKNOWN', async () => {
  await using fixture = await startTranscoding();

  expect(await send(fixture.port, { body: '{}', path: '/api/Transcoding/ask' })).toMatchObject({
    body: '{"code":18}',
    status: 200,
  });
  expect(fixture.refused).toEqual(['no service 1']);
});

test('serves the document beadc wrote, byte for byte', async () => {
  await using fixture = await startTranscoding();
  const etag = `"${createHash('sha256').update(OPENAPI_DOCUMENT).digest('hex')}"`;
  const served = await send(fixture.port, { method: 'GET', path: '/openapi.json' });

  expect(served).toMatchObject({
    body: OPENAPI_DOCUMENT,
    headers: { 'cache-control': 'no-cache', 'content-type': 'application/json', etag },
    status: 200,
  });
  expect(
    (
      await send(fixture.port, {
        headers: { 'if-none-match': served.headers.etag ?? '' },
        method: 'GET',
        path: '/openapi.json',
      })
    ).status
  ).toBe(304);
  expect((await send(fixture.port, { body: '{}', path: '/openapi.json' })).headers).toMatchObject({
    allow: 'GET, HEAD',
  });
});

test('holds each caller’s calls and streams to bounds of their own', async () => {
  await using fixture = await startTranscoding({
    maximumConnectionsPerAddress: 1,
    maximumExchangesPerAddress: 1,
  });
  const watch = {
    body: '{}',
    lines: [
      'POST /api/Transcoding/watch HTTP/1.1',
      'content-type: application/json',
      'accept: text/event-stream',
    ],
  };

  // * a stream holds one of its address's streams, and none of its calls
  const stream = opened(fixture.port, octetsOf(fixture.port, watch));

  await readUntil(stream, 'data: {}\n\n');

  const second = await exchanged(fixture.port, octetsOf(fixture.port, watch));
  const call = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

  expect([second.status, call.status]).toEqual([503, 200]);
  expect(second.headers).toMatchObject({ 'bead-refusal': 'busy', 'retry-after': '1' });

  // a call that hangs holds its address's one call, and a stream still opens beside none
  const abort = new AbortController();
  const hanging = send(fixture.port, {
    body: '{}',
    path: '/api/Transcoding/hang',
    signal: abort.signal,
  });

  hanging.catch(() => {});
  await until(() => {
    return fixture.counts.hanging === 1;
  });

  const busy = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

  expect(busy).toMatchObject({
    headers: { 'bead-refusal': 'busy', 'retry-after': '1' },
    status: 503,
  });
  abort.abort();
  stream.destroy();
  await until(() => {
    return fixture.counts.cancelled === 1;
  });

  // both freed as their exchanges end, which no event of this side tells: asked again until one is
  // taken, as the C# side asks, never decided by a delay
  const deadline = performance.now() + 2_000;
  let freed = 503;

  while (freed !== 200 && performance.now() < deadline) {
    freed = (await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' })).status;
  }

  expect(freed).toBe(200);
});

test('answers a result the stock library refuses 502, reported, none of its words in the problem', async () => {
  // * the bytes its server echoes, `x`, a varint cut short
  await using fixture = await startTranscoding({ routes: rawAsEdges() });
  const reported = reportedBy(fixture.gateway);
  const answered = await send(fixture.port, {
    body: 'x',
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(answered).toMatchObject({
    body: '{"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}',
    status: 502,
  });
  expect(reported).toHaveLength(1);
  expect(answered.body).not.toContain(reported[0]);

  // and one whose records its codec refuses first (spec 17.9.5): `at`, a message, as a varint
  const recorded = await send(fixture.port, {
    body: '\u0008\u0000',
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(recorded).toMatchObject({ body: answered.body, status: 502 });
  expect(reported).toHaveLength(2);
});

test('answers 503 DESTINATION_UNREACHABLE when its connection cannot be drawn, reported, none of its words in the problem', async () => {
  await using fixture = await startTranscoding();
  const reported = reportedBy(fixture.gateway);

  await fixture.memory.stop();

  const answered = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

  expect(answered).toMatchObject({
    body: '{"code":17,"scope":"protocol","status":503,"title":"DESTINATION_UNREACHABLE","type":"tag:francisdesjardins.ca,2026:bead/DESTINATION_UNREACHABLE"}',
    headers: { 'retry-after': '1' },
    status: 503,
  });
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatch(/, not open$/u);
});

// transcoding 7.6.27
test('answers what no gate foresaw 500, reported, none of its words in the problem', async () => {
  // * a clock that breaks as a body is read, past every gate
  const broken: IClock = {
    clearInterval: (timer) => {
      clearInterval(timer as Parameters<typeof clearInterval>[0]);
    },
    clearTimeout: (timer) => {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    },
    Date,
    performance: {
      now: () => {
        throw new Error('the clock broke');
      },
    },
    setInterval,
    setTimeout,
  };
  await using fixture = await startTranscoding({ clock: broken });
  const reported = reportedBy(fixture.gateway);
  const answered = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

  expect(answered).toMatchObject({
    body: '{"status":500,"title":"Internal Server Error","type":"about:blank"}',
    status: 500,
  });
  expect(reported).toEqual(['the clock broke']);
});

test('answers 500 a connection its server failed to draw but by refusing it, reported, with no detail', async () => {
  // * a transport whose accept throws what no refusal of a connect is; C#'s, a concrete class,
  // takes no stand-in, and refuses an exchange's port past 65535, which no socket of Node's shows
  await using gateway = createHTTPGateway({
    createServer: (listener) => {
      return createNodeServer(listener);
    },
    routes: HTTP_ROUTES,
    transport: {
      accept: () => {
        return Promise.reject(new ProgrammerError('the transport broke'));
      },
    },
  });
  const reported = reportedBy(gateway);
  const { port } = await gateway.start();
  const answered = await send(port, { body: '{}', path: '/api/Transcoding/echo' });

  expect(answered).toMatchObject({
    body: '{"status":500,"title":"Internal Server Error","type":"about:blank"}',
    status: 500,
  });
  expect(reported).toEqual(['the transport broke']);
});

test('reports each failure it answers a call with 500 or above, and none below', async () => {
  // * a route of a procedure its server does not offer, 501; a call past its timeout, 504, on a
  // clock that moves only as the test moves it, so no call races its deadline
  const clock = createTestClock();
  await using fixture = await startTranscoding({
    clock,
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.raw
        ? {
            ...init,
            procedure: {
              ...init.procedure,
              procedure: { ...init.procedure.procedure, procedureId: 99 },
            },
          }
        : init;
    }),
    timeout: 50,
  });
  const reported = reportedBy(fixture.gateway);
  const unknown = await send(fixture.port, {
    body: 'x',
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(unknown.status).toBe(501);
  expect(reported).toHaveLength(1);

  // its resolver holds it: its timeout passes as the clock moves
  const hanging = send(fixture.port, { body: '{}', path: '/api/Transcoding/hang' });

  await until(() => {
    return fixture.counts.hanging === 1;
  });
  await clock.tickAsync(50);

  const hung = await hanging;

  expect(hung.status).toBe(504);
  expect(reported).toHaveLength(2);

  // an application failure is the caller's, 400, and no session one, 401: reported none
  const failed = await send(fixture.port, {
    body: '{"detail":"no"}',
    path: '/api/Transcoding/fail',
  });
  const unknownSession = await send(fixture.port, { body: '{}', path: '/api/Transcoding/whoAmI' });

  expect([failed.status, unknownSession.status]).toEqual([400, 401]);
  expect(reported).toHaveLength(2);
});

test('answers 502 a text result that is no UTF-8, reported, none of its words in the problem', async () => {
  // * raw's route told its result is a text: the bytes its server echoes, FF, no UTF-8
  await using fixture = await startTranscoding({
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.raw
        ? {
            ...init,
            procedure: { ...init.procedure, result: TranscodingProcedures.text.result },
            result: 'text' as const,
          }
        : init;
    }),
  });
  const reported = reportedBy(fixture.gateway);
  const answered = await send(fixture.port, {
    body: Uint8Array.of(0xff),
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(answered).toMatchObject({
    body: '{"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}',
    status: 502,
  });
  expect(reported).toHaveLength(1);
});

test('words each refusal of its gates exactly, none of them what its request carried', async () => {
  const json = 'content-type: application/json';
  const book = '{"aString":"0123456789"}';
  const cases: Record<'jwt' | 'plain' | 'small', IOwnCase[]> = {
    jwt: [
      {
        lines: ['POST /api/Transcoding/whoAmI HTTP/1.1', json, 'authorization: Basic YTpi'],
        body: '{}',
        status: 401,
        words: 'an auth-scheme but Bearer',
      },
      {
        lines: [
          'POST /api/Transcoding/whoAmI HTTP/1.1',
          json,
          `authorization: Bearer ${'a'.repeat(1_005)}`,
        ],
        body: '{}',
        status: 431,
        words: 'a token past 1004 bytes',
      },
      {
        lines: ['POST /api/Transcoding/whoAmI HTTP/1.1', json, 'authorization: Bearer'],
        body: '{}',
        status: 401,
        words: 'an auth-scheme but Bearer',
      },
    ],
    plain: [
      {
        lines: ['GET /v1/books/2 HTTP/1.1', 'host: evil.example'],
        reason: 'host-refused',
        status: 403,
        words: 'a host it does not take',
      },
      {
        lines: ['GET /nope HTTP/1.1'],
        reason: 'path-unknown',
        status: 404,
        words: 'a path no route matches',
      },
      {
        lines: ['GET /v1/books/2 HTTP/1.1', 'origin: https://other.example'],
        reason: 'origin-refused',
        status: 403,
        words: 'an origin neither its own nor listed',
      },
      {
        lines: [
          'GET /v1/books/2 HTTP/1.1',
          'sec-fetch-site: cross-site',
          'sec-fetch-mode: no-cors',
        ],
        reason: 'origin-refused',
        status: 403,
        words: 'a request from a page of another site that shows no origin',
      },
      {
        lines: ['PUT /v1/shelves/1/books/2 HTTP/1.1', json],
        body: '{}',
        reason: 'method-refused',
        status: 405,
        words: 'a method no route of its path takes',
      },
      {
        lines: ['POST /openapi.json HTTP/1.1', json],
        body: '{}',
        reason: 'method-refused',
        status: 405,
        words: 'a method the document takes none of',
      },
      {
        lines: ['GET /openapi.json HTTP/1.1', json],
        body: '{}',
        reason: 'malformed',
        status: 400,
        words: 'content to the document',
      },
      {
        lines: ['POST /api/Transcoding/echo HTTP/1.1', 'content-type: text/plain'],
        body: '{}',
        reason: 'type-refused',
        status: 415,
        words: "this route's body is application/json, unencoded",
      },
      {
        lines: ['GET /v1/books/2 HTTP/1.1', json],
        body: '{}',
        reason: 'malformed',
        status: 400,
        words: 'content to a route that takes none',
      },
      {
        lines: [
          'POST /api/Transcoding/whoAmI HTTP/1.1',
          json,
          'authorization: Bearer good',
          'authorization: Bearer good',
        ],
        body: '{}',
        reason: 'malformed',
        status: 400,
        words: 'two authorization fields',
      },
      ...[
        [json, json],
        ['content-type: application/json; boundary=x'],
        ['content-type: application/json; charset'],
      ].map((fields) => {
        return {
          lines: ['POST /api/Transcoding/echo HTTP/1.1', ...fields],
          body: '{}',
          reason: 'type-refused',
          status: 415,
          words: "this route's body is application/json, unencoded",
        };
      }),
      {
        lines: ['POST /api/Transcoding/echo HTTP/1.1', 'content-type: text/plain'],
        reason: 'type-refused',
        status: 415,
        words: "this route's body is application/json, unencoded",
      },
      {
        lines: [
          'POST /api/Transcoding/echo HTTP/1.1',
          json,
          'sec-fetch-site: cross-site',
          'sec-fetch-mode: navigate',
        ],
        body: '{}',
        reason: 'origin-refused',
        status: 403,
        words: 'a request from a page of another site that shows no origin',
      },
    ],
    small: [
      {
        lines: ['POST /api/Transcoding/echo HTTP/1.1', json],
        body: book,
        reason: 'too-large',
        status: 413,
        words: 'a body declared past maximumBodyBytes 16',
      },
      {
        lines: ['POST /api/Transcoding/echo HTTP/1.1', json, 'transfer-encoding: chunked'],
        body: `18\r\n${book}\r\n0\r\n\r\n`,
        reason: 'too-large',
        status: 413,
        words: 'a body past maximumBodyBytes 16',
      },
    ],
  };
  await using plain = await startTranscoding();
  await using jwt = await startTranscoding({ authorization: 'bearer-jwt' });
  await using small = await startTranscoding({ maximumBodyBytes: 16 });
  const parted: string[] = [];

  for (const [fixture, each] of [
    [plain, cases.plain],
    [jwt, cases.jwt],
    [small, cases.small],
  ] as const) {
    for (const expected of each) {
      parted.push(
        ...partsOf(await exchanged(fixture.port, octetsOf(fixture.port, expected)), expected)
      );
    }
  }

  expect(parted).toEqual([]);
});

// transcoding 7.7.6
test('words each refusal of its bounds exactly', async () => {
  const echo: Pick<IOwnCase, 'body' | 'lines'> = {
    body: '{}',
    lines: ['POST /api/Transcoding/echo HTTP/1.1', 'content-type: application/json'],
  };
  const hang = {
    ...echo,
    lines: ['POST /api/Transcoding/hang HTTP/1.1', 'content-type: application/json'],
  };
  const watch = {
    ...echo,
    lines: [
      'POST /api/Transcoding/watch HTTP/1.1',
      'content-type: application/json',
      'accept: text/event-stream',
    ],
  };
  const parted: string[] = [];
  const meet = async (
    fixture: Awaited<ReturnType<typeof startTranscoding>>,
    expected: IOwnCase
  ): Promise<void> => {
    parted.push(
      ...partsOf(await exchanged(fixture.port, octetsOf(fixture.port, expected)), expected)
    );
  };

  // * a call that hangs holds its bound; a second is refused past it, every caller's or its address's
  for (const [options, words] of [
    [{ maximumExchanges: 1 }, 'the calls under way hold maximumExchanges'],
    [{ maximumExchangesPerAddress: 1 }, 'the calls of its address hold maximumExchangesPerAddress'],
  ] as const) {
    await using fixture = await startTranscoding(options);
    const held = opened(fixture.port, octetsOf(fixture.port, hang));

    await until(() => {
      return fixture.counts.hanging === 1;
    });
    await meet(fixture, { ...echo, reason: 'busy', status: 503, words });
    held.destroy();
  }

  // a stream that stays holds its own, apart from the calls
  for (const [options, words] of [
    [{ maximumConnections: 1 }, 'the streams under way hold maximumConnections'],
    [
      { maximumConnectionsPerAddress: 1 },
      'the streams of its address hold maximumConnectionsPerAddress',
    ],
  ] as const) {
    await using fixture = await startTranscoding(options);
    const held = opened(fixture.port, octetsOf(fixture.port, watch));

    await new Promise((resolve) => {
      held.once('data', resolve);
    });
    await meet(fixture, { ...watch, reason: 'busy', status: 503, words });
    held.destroy();
  }

  await using budget = await startTranscoding({ bodyBytesBudget: 4 });
  await using slow = await startTranscoding({ bodyGracePeriod: 100 });
  await using timed = await startTranscoding({ timeout: 50 });

  await meet(budget, {
    body: '{"anInt32":1}',
    lines: echo.lines,
    reason: 'busy',
    status: 503,
    words: 'the bodies under way hold bodyBytesBudget',
  });
  await meet(slow, {
    lines: [...echo.lines, 'content-length: 10'],
    reason: 'too-slow',
    status: 408,
    words: 'a body slower than minimumBodyBytesPerSecond',
  });
  await meet(timed, { ...hang, status: 504, words: 'no answer within 50 ms' });

  expect(parted).toEqual([]);
});

test('refuses an authorization but elsewhere or bearer-jwt, and a bound that is no whole number above 0', () => {
  const transport = createMemoryTransportServer();

  expect(() => {
    return createHTTPGateway({
      authorization: 'basic' as 'elsewhere',
      routes: HTTP_ROUTES,
      transport,
    });
  }).toThrow(new ProgrammerError("a gateway's authorization is elsewhere or bearer-jwt"));
  expect(() => {
    return createHTTPGateway({ maximumBodyBytes: 0, routes: HTTP_ROUTES, transport });
  }).toThrow(new ProgrammerError('maximumBodyBytes is a whole number above 0, not 0'));
  expect(() => {
    return createHTTPGateway({ routes: HTTP_ROUTES, transport, window: 0 });
  }).toThrow(new ProgrammerError('window is a whole number above 0, not 0'));
  // a C# Window is an int, which holds no 1.5
  expect(() => {
    return createHTTPGateway({ routes: HTTP_ROUTES, transport, window: 1.5 });
  }).toThrow(new ProgrammerError('window is a whole number above 0, not 1.5'));
});

test('reports to a handler until it is off', async () => {
  await using fixture = await startTranscoding();
  const reported = reportedBy(fixture.gateway);
  const off: unknown[] = [];
  const handler = (error: Error): void => {
    off.push(error);
  };

  fixture.gateway.on('error', handler);
  fixture.gateway.off('error', handler);
  await fixture.memory.stop();

  expect((await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' })).status).toBe(
    503
  );
  expect([reported.length, off]).toEqual([1, []]);
});

test('writes a text or a raw stream’s data as a JSON string and a result it cannot read as a call’s failure', async () => {
  // * ticks served thrice more, its result and its notifications told they are raw, text, or an Edges
  const ticks = HTTP_ROUTES.find((init) => {
    return init.procedure === TranscodingProcedures.ticks;
  });

  if (ticks === undefined) {
    throw new Error('no ticks in the route table');
  }

  const streamed = (
    template: string,
    told: Pick<IHttpRouteInit, 'notification' | 'procedure' | 'result'>
  ): IHttpRouteInit => {
    return { ...ticks, ...told, routes: [{ body: '*', method: 'POST', template }] };
  };
  await using fixture = await startTranscoding({
    routes: [
      ...HTTP_ROUTES,
      streamed('/raw-ticks', { notification: 'raw', procedure: ticks.procedure, result: 'raw' }),
      streamed('/text-ticks', { notification: 'text', procedure: ticks.procedure, result: 'text' }),
      streamed('/edges-ticks', {
        notification: TickSchema,
        procedure: { ...ticks.procedure, result: TranscodingProcedures.echoEdges.result },
        result: EdgesSchema,
      }),
    ],
  });
  const reported = reportedBy(fixture.gateway);

  // a listener that throws: the exchange answers on
  fixture.gateway.on('error', () => {
    throw new Error('a listener broke');
  });

  const ticked = (path: string, from: number): Promise<IAnswered> => {
    return send(fixture.port, {
      body: `{"from":${String(from)}}`,
      headers: { accept: 'text/event-stream' },
      path,
    });
  };

  // * its result, each notification and the failure that ends them, in their order, none overtaken
  expect((await ticked('/raw-ticks', 2)).body).toMatch(
    /^event: result\nid: 1\ndata: "CAI="\n\nid: 2\ndata: "CAE="\n\nid: 3\ndata: ""\n\nevent: failure\nid: 4\n/u
  );
  expect((await ticked('/text-ticks', 2)).body).toMatch(
    /^event: result\nid: 1\ndata: "\\b\\u0002"\n\nid: 2\ndata: "\\b\\u0001"\n\nid: 3\ndata: ""\n\nevent: failure\nid: 4\n/u
  );
  expect((await ticked('/text-ticks', 0)).body).toMatch(
    /^event: result\nid: 1\ndata: ""\n\nevent: failure\nid: 2\n/u
  );
  expect(reported).toEqual([]);

  // a result its stock library refuses, or a text one not UTF-8: 502, nothing of the stream written, reported
  const undecodable =
    '{"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}';

  expect(await ticked('/edges-ticks', 2)).toMatchObject({ body: undecodable, status: 502 });
  expect(await ticked('/text-ticks', -1)).toMatchObject({ body: undecodable, status: 502 });
  expect(reported).toHaveLength(2);
});

test('answers 500 a result its mapping holds no form of, reported, in the mapping’s words', async () => {
  // * raw's route told its result is an Edges: the bytes its server echoes, a Value of NaN, a mask of foo_
  await using fixture = await startTranscoding({ routes: rawAsEdges() });
  const reported = reportedBy(fixture.gateway);
  const nan = toBinary(
    EdgesSchema,
    create(EdgesSchema, { value: { kind: { case: 'numberValue', value: Number.NaN } } })
  );
  const answered = await send(fixture.port, {
    body: nan,
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(answered).toMatchObject({
    body: '{"detail":"a Value whose number is not finite","status":500,"title":"Internal Server Error","type":"about:blank"}',
    status: 500,
  });
  expect(reported).toEqual(['a Value whose number is not finite']);

  const unwritable = await send(fixture.port, {
    body: toBinary(EdgesSchema, create(EdgesSchema, { mask: { paths: ['foo_'] } })),
    headers: { 'content-type': 'application/octet-stream' },
    path: '/api/Transcoding/raw',
  });

  expect(unwritable).toMatchObject({
    body: '{"detail":"a FieldMask path whose lowerCamelCase does not read back","status":500,"title":"Internal Server Error","type":"about:blank"}',
    status: 500,
  });
  expect(reported).toEqual([
    'a Value whose number is not finite',
    'a FieldMask path whose lowerCamelCase does not read back',
  ]);
});

test('refuses a query beside a body of a json, text or raw route, and a variable that does not decode, 400', async () => {
  await using fixture = await startTranscoding();
  const undecodable = (detail: string, place = ''): string => {
    return `{"code":50,"detail":"${detail}",${place}"scope":"protocol","status":400,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}`;
  };

  for (const [path, type, body] of [
    ['raw', 'application/octet-stream', 'x'],
    ['text', 'text/plain', 'x'],
    ['json', 'application/json', '1'],
  ] as const) {
    const queried = await send(fixture.port, {
      body,
      headers: { 'content-type': type },
      path: `/api/Transcoding/${path}?a=1`,
    });

    expect(queried, path).toMatchObject({
      body: undecodable('a query beside a body of the whole request'),
      status: 400,
    });
  }

  const undecoded = await send(fixture.port, { method: 'GET', path: '/v1/shelves/%FF/books/2' });

  expect(undecoded).toMatchObject({
    body: undecodable('a value whose bytes are not UTF-8', '"parameter":"name",'),
    status: 400,
  });
});

test('answers 304 a request for the document under an if-none-match of any entity tag', async () => {
  await using fixture = await startTranscoding();
  const { etag } = (await send(fixture.port, { method: 'GET', path: '/openapi.json' })).headers;

  // * any tag, among others or alone, and a weak tag of its own compared as its strong one
  for (const asked of [' * ', '"other", *', `W/${etag ?? ''}`]) {
    const held = await send(fixture.port, {
      headers: { 'if-none-match': asked },
      method: 'GET',
      path: '/openapi.json',
    });

    expect(held.status, asked).toBe(304);
  }
});

test('takes its hosts and proxies from its policy or beside it, and refuses one given in both', async () => {
  const members = { hosts: ['api.example'], trustedProxies: ['127.0.0.1'], unnamedProxies: 0 };
  const policy = httpPolicyOf(members);
  await using fromPolicy = await startTranscoding({ policy });
  await using beside = await startTranscoding(members);

  for (const fixture of [fromPolicy, beside]) {
    const drawn: string[] = [];

    fixture.server.transport.on('connection', (...[, , connectionHandle]) => {
      drawn.push(connectionHandle);
    });

    // * a host it takes, and its caller's address as the proxy it trusts forwards it
    const taken = await send(fixture.port, {
      headers: { host: 'api.example', 'x-forwarded-for': '203.0.113.9' },
      method: 'GET',
      path: '/v1/books/2',
    });
    const refused = await send(fixture.port, {
      headers: { host: 'evil.example' },
      method: 'GET',
      path: '/v1/books/2',
    });

    expect([taken.status, refused.status]).toEqual([200, 403]);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatch(/^type=MEMORY;ip=203\.0\.113\.9;/u);
  }

  // a member given in its policy and beside it, whatever its value
  const transport = createMemoryTransportServer();

  expect(() => {
    return createHTTPGateway({ hosts: ['api.example'], policy, routes: HTTP_ROUTES, transport });
  }).toThrow(new ProgrammerError('hosts is given in the policy and beside it: give it once'));
  expect(() => {
    return createHTTPGateway({
      policy: httpPolicyOf({ unnamedProxies: 1 }),
      routes: HTTP_ROUTES,
      transport,
      unnamedProxies: 0,
    });
  }).toThrow(
    new ProgrammerError('unnamedProxies is given in the policy and beside it: give it once')
  );
});

test('resets over HTTP/2 the stream of a request whose target or a field holds an octet past visible ASCII, PROTOCOL_ERROR, nothing written', async () => {
  await using fixture = await startTranscoding();
  await using gateway = createHTTPGateway({
    createServer: (listener) => {
      return createHTTP2Server((request, response) => {
        listener(request, response);
      });
    },
    routes: HTTP_ROUTES,
    transport: fixture.memory,
  });
  const { port } = await gateway.start({ address: '127.0.0.1' });
  const session = connectHTTP2(`http://127.0.0.1:${String(port)}`);

  session.on('error', () => {});

  // its status and body, or the code its stream was reset with when none came
  const answerOf = (headers: Record<string, string>) => {
    return new Promise<[number, string] | number>((resolve) => {
      const stream = session.request({ ':method': 'GET', ...headers });
      let status: number | undefined;
      const body: Buffer[] = [];

      stream.once('response', (response) => {
        status = response[':status'];
      });
      stream.on('data', (bytes: Buffer) => {
        body.push(bytes);
      });
      stream.on('error', () => {});
      stream.once('close', () => {
        resolve(
          status === undefined ? stream.rstCode : [status, Buffer.concat(body).toString('utf8')]
        );
      });
      stream.end();
    });
  };

  try {
    // ! nghttp2 resets a control character in :path before the gateway reads the request; é, the one
    // octet of its Latin-1 code, a NUL percent-encoded in its path, a path no route matches among
    // them, and a field past ASCII the gateway resets, before its path is matched
    expect(
      await Promise.all(
        [
          { ':path': '/v1/books/a\u0001b' },
          { ':path': '/v1/books/é' },
          { ':path': '/v1/books/a%00b' },
          { ':path': '/nowhere%00' },
          { ':path': '/v1/books/2', 'x-other': 'café' },
        ].map(answerOf)
      )
    ).toEqual(
      Array.from({ length: 5 }, () => {
        return http2Constants.NGHTTP2_PROTOCOL_ERROR;
      })
    );
    // what its target percent-encodes is no octet of it
    expect(await answerOf({ ':path': '/v1/books/a%01b' })).toEqual([
      200,
      '{"name":"a\\u0001b","title":"A tale"}',
    ]);
  } finally {
    session.close();
  }
});

test('refuses a route off its template’s grammar, and listens once', async () => {
  await using fixture = await startTranscoding();
  const echo = HTTP_ROUTES.find((init) => {
    return init.procedure === TranscodingProcedures.echo;
  });

  if (echo === undefined) {
    throw new Error('no echo in the route table');
  }

  const crooked: IHttpRouteInit = { ...echo, routes: [{ method: 'GET', template: '/v1/{name' }] };
  const ownOf = (): IHTTPGateway => {
    return createHTTPGateway({
      createServer: (listener) => {
        return createNodeServer(listener);
      },
      routes: HTTP_ROUTES,
      transport: fixture.memory,
    });
  };

  // * a template off http.proto's grammar is refused as the gateway is built, naming its route
  expect(() => {
    return createHTTPGateway({ routes: [crooked], transport: fixture.memory });
  }).toThrow(new ProgrammerError("echo's route GET /v1/{name: a variable that does not close"));

  // one that listens on localhost, its loopbacks, listens once; one that listens on none stops at once
  await using gateway = ownOf();
  const listening = await gateway.start();

  await expect(gateway.start()).rejects.toThrow(new ProgrammerError('a gateway listens once'));
  expect(listening.address).toBe('localhost');
  expect((await send(listening.port, { method: 'GET', path: '/v1/books/2' })).status).toBe(200);

  // a port another listener holds: its listen fails, and it listens on none
  await using held = ownOf();
  const { port } = await held.start({ address: '127.0.0.1' });
  await using second = ownOf();

  await expect(second.start({ address: '127.0.0.1', port })).rejects.toMatchObject({
    code: 'EADDRINUSE',
  });
  await second.stop();

  await using never = ownOf();

  await never.stop();
});

test('refuses a route table of two routes of one method that tie, naming both', async () => {
  await using fixture = await startTranscoding();
  const echo = HTTP_ROUTES.find((init) => {
    return init.procedure === TranscodingProcedures.echo;
  });

  if (echo === undefined) {
    throw new Error('no echo in the route table');
  }

  const tying: IHttpRouteInit = {
    ...echo,
    routes: [{ method: 'GET', template: '/v1/books/{id}' }],
  };
  const beside: IHttpRouteInit = {
    ...echo,
    routes: [{ body: '*', method: 'POST', template: '/v1/books/{id}' }],
  };

  // * two tables built apart and joined: the tie no builder saw is refused as the gateway is built
  expect(() => {
    return createHTTPGateway({ routes: [...HTTP_ROUTES, tying], transport: fixture.memory });
  }).toThrow(
    new ProgrammerError("echo's route GET /v1/books/{id} ties getBook's route GET /v1/books/{name}")
  );

  // a route of another method at that template ties none
  await using gateway = createHTTPGateway({
    routes: [...HTTP_ROUTES, beside],
    transport: fixture.memory,
  });

  await gateway.stop();
});

test('answers as the endpoint an application maps, and a caller of no address as local', async () => {
  await using fixture = await startTranscoding();
  const drawn: string[] = [];

  fixture.server.transport.on('connection', (...[, , connectionHandle]) => {
    drawn.push(connectionHandle);
  });

  // * built with no createServer, it listens on none of its own: an application's server mounts it
  await using mounted = createHTTPGateway({ routes: HTTP_ROUTES, transport: fixture.memory });

  await expect(mounted.start()).rejects.toThrow(
    new ProgrammerError('a gateway built with no createServer listens on none of its own')
  );

  const application = createNodeServer((request, response) => {
    if (request.url === '/own') {
      response.end('its own');

      return;
    }

    // an exchange handed on with no remote address, as a test host's: its caller is local
    const handed: IHTTPRequestLike =
      request.headers['x-handed'] === 'local'
        ? (Object.create(request, { socket: { value: {} } }) as IHTTPRequestLike)
        : request;

    // ! where C#'s endpoint, its application's fallback, answers 404 path-unknown, a handler
    // gives back to its server each path it serves none of
    if (!mounted.listener(handed, response)) {
      response.writeHead(404);
      response.end("the application's own");
    }
  });

  await new Promise<void>((resolve) => {
    application.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = application.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const book = '{"name":"2","title":"A tale"}';

    expect((await send(port, { method: 'GET', path: '/own' })).body).toBe('its own');
    expect((await send(port, { method: 'GET', path: '/v1/books/2' })).body).toBe(book);
    expect(await send(port, { method: 'GET', path: '/nope' })).toMatchObject({
      body: "the application's own",
      status: 404,
    });
    expect(
      await send(port, { headers: { 'x-handed': 'local' }, method: 'GET', path: '/v1/books/2' })
    ).toMatchObject({ body: book, status: 200 });
    expect(drawn.at(-1)).toMatch(/^type=MEMORY;ip=local;/u);
  } finally {
    application.closeAllConnections();
    await new Promise((resolve) => {
      application.close(resolve);
    });
  }

  // one given no document serves none: its path goes back to the server it is mounted on
  const request: IHTTPRequestLike = {
    destroy: () => {},
    headers: {},
    httpVersion: '1.1',
    httpVersionMajor: 1,
    method: 'GET',
    on: () => {},
    rawHeaders: [],
    socket: {},
    url: '/openapi.json',
  };

  expect(mounted.listener(request, {} as IHTTPResponseLike)).toBe(false);
});

test('answers each request at the edges of its gates', async () => {
  await using fixture = await startTranscoding();
  const { port } = fixture;

  // * a field of a control character: what HTTP refuses of its own, unmarked, its body empty
  const bell = await exchanged(
    port,
    octetsOf(port, { lines: ['GET /v1/books/2 HTTP/1.1', 'x-other: a\u0007b'] })
  );

  expect([bell.status, bell.headers['bead-refusal'], bell.body]).toEqual([400, undefined, '']);

  // an absolute-form target: its path and query, its authority aside
  const absolute = await exchanged(
    port,
    octetsOf(port, {
      lines: [`GET http://127.0.0.1:${String(port)}/v1/books/2?revision=3 HTTP/1.1`],
    })
  );

  expect(absolute).toMatchObject({
    body: '{"name":"2","title":"A tale","pages":"3"}',
    status: 200,
  });

  // a range of application/* weighed below text/event-stream: a stream; a weight it cannot read is 1
  for (const accept of [
    'application/*;q=0.5, text/event-stream',
    'text/event-stream;q=x;level, application/json',
  ]) {
    const stream = opened(
      port,
      octetsOf(port, {
        body: '{}',
        lines: [
          'POST /api/Transcoding/watch HTTP/1.1',
          'content-type: application/json',
          `accept: ${accept}`,
        ],
      })
    );

    expect(await readUntil(stream, 'data: {}\n\n'), accept).toContain(
      'event: result\nid: 1\ndata: {}\n\n'
    );
    stream.destroy();
  }

  // a raw route's query of empty parameters alone binds nothing, a charset quoted and an identity encoding are taken
  for (const lines of [
    ['POST /api/Transcoding/raw?& HTTP/1.1', 'content-type: application/octet-stream'],
    [
      'POST /api/Transcoding/raw HTTP/1.1',
      'content-type: application/octet-stream; charset="UTF-8"',
      'content-encoding: identity',
    ],
  ]) {
    expect(await exchanged(port, octetsOf(port, { body: 'hi', lines }))).toMatchObject({
      body: 'hi',
      status: 200,
    });
  }

  // a call that hangs and one beside it of the same address: each held, then each let go
  const abort = new AbortController();
  const hanging = send(port, { body: '{}', path: '/api/Transcoding/hang', signal: abort.signal });

  hanging.catch(() => {});
  await until(() => {
    return fixture.counts.hanging === 1;
  });
  expect((await send(port, { body: '{"anInt32":2}', path: '/api/Transcoding/echo' })).body).toBe(
    '{"anInt32":2}'
  );
  abort.abort();
  await expect(hanging).rejects.toThrow();
  await until(() => {
    return fixture.counts.cancelled === 1;
  });
});

test('serves its document to a HEAD and to a preflight that asks for no field', async () => {
  await using fixture = await startTranscoding({ origins: [ORIGIN] });

  expect(await send(fixture.port, { method: 'HEAD', path: '/openapi.json' })).toMatchObject({
    body: '',
    headers: { 'content-length': String(Buffer.byteLength(OPENAPI_DOCUMENT)) },
    status: 200,
  });

  // a preflight from an origin it lists that asks for no field: GET and HEAD, authorization and any other
  expect(
    await send(fixture.port, {
      headers: { 'access-control-request-method': 'GET', origin: ORIGIN },
      method: 'OPTIONS',
      path: '/openapi.json',
    })
  ).toMatchObject({
    headers: {
      'access-control-allow-headers': 'authorization, *',
      'access-control-allow-methods': 'GET, HEAD',
    },
    status: 204,
  });
});

test('ends a stream whose notification its stock library refuses with 502 as its last event', async () => {
  // * ticks' notification told it is an Edges: a Tick's remaining, field 1 a varint, where an Edges' at is a message
  await using fixture = await startTranscoding({
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.ticks
        ? {
            ...init,
            notification: EdgesSchema,
            procedure: { ...init.procedure, notification: TranscodingProcedures.echoEdges.result },
          }
        : init;
    }),
  });
  const reported = reportedBy(fixture.gateway);
  const ticks = await send(fixture.port, {
    body: '{"from":2}',
    headers: { accept: 'text/event-stream' },
    path: '/api/Transcoding/ticks',
  });
  const begun =
    'event: result\nid: 1\ndata: {"ticks":2}\n\nevent: failure\nid: 2\ndata: {"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}\n\n';

  expect(ticks.status).toBe(200);
  expect(ticks.body.slice(0, begun.length)).toBe(begun);
  expect(reported).toHaveLength(1);
});

test('reads a held body past its grace when its minimum rate is zero', async () => {
  const reading = Promise.withResolvers<void>();
  const clock = createTestClock();
  await using fixture = await startTranscoding({
    bodyGracePeriod: 1_000,
    clock,
    minimumBodyBytesPerSecond: 0,
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        request.on('data', () => {
          reading.resolve();
        });
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const socket = opened(
    fixture.port,
    octetsOf(fixture.port, {
      lines: [
        'POST /api/Transcoding/echo HTTP/1.1',
        'content-type: application/json',
        'content-length: 2',
      ],
    }) + '{'
  );

  try {
    await reading.promise;
    await clock.tickAsync(2_000);

    expect(fixture.memory.clients).toHaveLength(0);
    socket.write('}');
    const answered = await readUntil(socket, '\r\n\r\n{}');

    expect(answered).toMatch(/^HTTP\/1\.1 200 /u);
    expect(answered).toContain('content-type: application/json\r\n');
    expect(answered.endsWith('\r\n\r\n{}')).toBe(true);
    expect(reported).toEqual([]);
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
  } finally {
    socket.destroy();
  }
});

test('ignores request callbacks after its body settles', async () => {
  let late = 0;
  await using fixture = await startTranscoding({
    bodyBytesBudget: 2,
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        request.on('end', () => {
          // * a mounted request can deliver callbacks after the body end.
          queueMicrotask(() => {
            if (late < 2) {
              late += 1;
              request.emit('data', Buffer.from('extra'));
              request.emit('error', new Error('a body callback after settlement'));
            }
          });
        });
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);

  for (let request = 0; request < 2; request += 1) {
    const answered = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

    expect(answered.status).toBe(200);
    expect(answered.body).toBe('{}');
    expect(answered.headers['bead-refusal']).toBeUndefined();
  }

  const refused = await send(fixture.port, { body: ' {}', path: '/api/Transcoding/echo' });

  expect(refused.status).toBe(503);
  expect(refused.headers['bead-refusal']).toBe('busy');
  expect(JSON.parse(refused.body)).toEqual({
    detail: 'the bodies under way hold bodyBytesBudget',
    status: 503,
    title: 'Service Unavailable',
    type: 'about:blank',
  });
  expect(late).toBe(2);
  expect(reported).toEqual([]);
  await until(() => {
    return fixture.memory.clients.length === 0;
  });
});

test('leaves a response whose application sends its headers before the gateway answers', async () => {
  await using fixture = await startTranscoding({
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        response.writeHead(202, { 'x-mounted': 'yes' });
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  let drawn = 0;

  fixture.memory.on('connection', () => {
    drawn += 1;
  });
  const answered = await send(fixture.port, { method: 'GET', path: '/v1/books/2' });

  expect(answered.status).toBe(202);
  expect(answered.headers['x-mounted']).toBe('yes');
  expect(answered.headers['content-type']).toBeUndefined();
  expect(answered.body).toBe('');
  expect(drawn).toBe(1);
  expect(reported).toEqual([]);
  await until(() => {
    return fixture.memory.clients.length === 0;
  });
});

test('drops a notification while an unreadable notification holds its stream’s end before the result', async () => {
  await using memory = createMemoryTransportServer();
  await memory.start();
  await using gateway = createHTTPGateway({
    createServer: createNodeServer,
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.watch
        ? {
            ...init,
            notification: EdgesSchema,
            procedure: { ...init.procedure, notification: TranscodingProcedures.echoEdges.result },
          }
        : init;
    }),
    transport: memory,
    window: 2,
  });
  const reported = reportedBy(gateway);
  let requests = 0;

  memory.on('message', ({ data }, connectionHandle) => {
    const envelope = readEnvelope(bytesOf(data), {
      failures: SERVER_FAILURES,
      maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
    });

    if (envelope?.kind !== EnvelopeKind.REQUEST) {
      return;
    }

    requests += 1;
    const { callId } = envelope.header;

    // * both callbacks precede the result: the first holds the end, the second must drop.
    for (const payload of [new Uint8Array([8, 1]), new Uint8Array()]) {
      void memory.send(
        {
          data: writeEnvelope({
            header: { callId, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload,
          }),
        },
        connectionHandle
      );
    }
    void memory.send(
      {
        data: writeEnvelope({
          header: { callId, kind: EnvelopeKind.RESULT },
          kind: EnvelopeKind.RESULT,
          payload: new Uint8Array(),
        }),
      },
      connectionHandle
    );
  });
  const { port } = await gateway.start({ address: '127.0.0.1' });
  const answered = await send(port, {
    body: '{}',
    headers: { accept: 'text/event-stream' },
    path: '/api/Transcoding/watch',
  });

  expect(answered.status).toBe(200);
  expect(answered.headers['content-type']).toBe('text/event-stream');
  expect(answered.body).toBe(
    'event: result\nid: 1\ndata: {}\n\nevent: failure\nid: 2\ndata: {"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}\n\n'
  );
  expect(requests).toBe(1);
  expect(reported).toHaveLength(1);
  await until(() => {
    return memory.clients.length === 0;
  });
});

test('drops a late notification after an unreadable notification starts ending its stream', async () => {
  const firstWritten = Promise.withResolvers<void>();
  const chunks: string[] = [];
  await using fixture = await startTranscoding({
    window: 1,
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.watch
        ? {
            ...init,
            notification: EdgesSchema,
            procedure: { ...init.procedure, notification: TranscodingProcedures.echoEdges.result },
          }
        : init;
    }),
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        const write = response.write.bind(response);

        response.write = (
          chunk: Uint8Array,
          done?: BufferEncoding | ((error?: Error | null) => void)
        ): boolean => {
          chunks.push(new TextDecoder().decode(chunk));
          firstWritten.resolve();

          return write(chunk, typeof done === 'function' ? done : undefined);
        };
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const answering = send(fixture.port, {
    body: '{}',
    headers: { accept: 'text/event-stream' },
    path: '/api/Transcoding/watch',
  });

  await firstWritten.promise;
  await fixture.watched(1);
  const answered = await answering;

  await fixture.watched(0);
  expect(answered.status).toBe(200);
  expect(answered.body).toBe(
    'event: result\nid: 1\ndata: {}\n\nevent: failure\nid: 2\ndata: {"code":50,"scope":"protocol","status":502,"title":"PAYLOAD_UNDECODABLE","type":"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE"}\n\n'
  );
  expect(chunks).toHaveLength(2);
  expect(reported).toHaveLength(1);
  await until(() => {
    return fixture.memory.clients.length === 0;
  });
});

test('waits for a stream response to drain before writing its next event', async () => {
  const waiting = Promise.withResolvers<void>();
  const chunks: string[] = [];
  let drain: (() => void) | undefined;
  await using fixture = await startTranscoding({
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        const write = response.write.bind(response);

        response.write = (
          chunk: Uint8Array,
          done?: BufferEncoding | ((error?: Error | null) => void)
        ): boolean => {
          chunks.push(new TextDecoder().decode(chunk));
          const isTaken =
            chunks.length === 1
              ? write(chunk)
              : write(chunk, typeof done === 'function' ? done : undefined);

          if (chunks.length === 1) {
            drain = () => {
              response.emit('drain');
            };
            waiting.resolve();
            return false;
          }

          return isTaken;
        };
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const socket = opened(
    fixture.port,
    octetsOf(fixture.port, {
      body: '{}',
      lines: [
        'POST /api/Transcoding/watch HTTP/1.1',
        'content-type: application/json',
        'accept: text/event-stream',
      ],
    })
  );

  try {
    await waiting.promise;
    const notifying = fixture.watched(2);

    expect(chunks).toEqual(['event: result\nid: 1\ndata: {}\n\n']);
    expect(drain).toBeDefined();
    drain?.();
    await notifying;
    expect(chunks).toEqual([
      'event: result\nid: 1\ndata: {}\n\n',
      'id: 2\ndata: {"remaining":2}\n\n',
    ]);
    expect(reported).toEqual([]);
  } finally {
    socket.destroy();
  }
});

test('releases a stream closed while its response waits for drainage', async () => {
  const waiting = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const chunks: string[] = [];
  const clock = createTestClock();
  await using fixture = await startTranscoding({
    clock,
    heartbeat: 1_000,
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        const write = response.write.bind(response);
        response.once('close', () => {
          released.resolve();
        });
        response.write = (chunk: Uint8Array): boolean => {
          chunks.push(new TextDecoder().decode(chunk));
          write(chunk);
          waiting.resolve();

          return false;
        };
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const socket = opened(
    fixture.port,
    octetsOf(fixture.port, {
      body: '{}',
      lines: [
        'POST /api/Transcoding/watch HTTP/1.1',
        'content-type: application/json',
        'accept: text/event-stream',
      ],
    })
  );

  try {
    await waiting.promise;
    socket.destroy();
    await released.promise;
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
    await fixture.watched(2);
    await clock.tickAsync(1_000);

    expect(chunks).toEqual(['event: result\nid: 1\ndata: {}\n\n']);
    expect(reported).toEqual([]);
  } finally {
    socket.destroy();
  }
});

test('writes a comment on a quiet stream each heartbeat on its clock, and drops one past maximumUnsentBytes', async () => {
  const watch = {
    body: '{}',
    lines: [
      'POST /api/Transcoding/watch HTTP/1.1',
      'content-type: application/json',
      'accept: text/event-stream',
    ],
  };

  {
    const clock = createTestClock();
    await using fixture = await startTranscoding({ clock, heartbeat: 1_000 });
    const stream = opened(fixture.port, octetsOf(fixture.port, watch));

    await readUntil(stream, 'data: {}\n\n');

    // * nothing written for a heartbeat: a comment, which no EventSource dispatches
    const comment = readUntil(stream, ':\n\r\n');

    await clock.tickAsync(1_000);
    expect((await comment).endsWith(':\n\r\n')).toBe(true);
    stream.destroy();
  }

  // a stream's write past what its response may hold unsent: dropped, its socket aborted, nothing written
  await using bounded = await startTranscoding({ maximumUnsentBytes: 1 });
  const reported = reportedBy(bounded.gateway);
  expect(await receivedOn(bounded.port, octetsOf(bounded.port, watch))).toBe(0);
  expect(reported).toEqual(['the response is dropped: maximumUnsentBytes 1 bytes']);
});

test('paces every response body and reports its send bound', async () => {
  for (const kind of ['answer', 'problem', 'document', 'event']) {
    const closed = Promise.withResolvers<void>();
    const chunks: Uint8Array[] = [];
    const statuses: number[] = [];
    let requests = 0;
    await using fixture = await startTranscoding({
      heartbeat: Infinity,
      maximumExchanges: 1,
      maximumConnections: 1,
      minimumSendBytesPerSecond: 1_000_000,
      sendGracePeriod: 1,
      createServer: (listener) => {
        return createNodeServer((request, response) => {
          requests += 1;
          if (requests > 1) {
            listener(request, response);
            return;
          }
          Object.defineProperty(response, 'writableLength', {
            get: () => {
              return chunks.length === 0 ? 0 : 1;
            },
          });
          response.write = (chunk: Uint8Array): boolean => {
            statuses.push(response.statusCode);
            chunks.push(chunk);
            return false;
          };
          response.once('close', () => {
            closed.resolve();
          });
          listener(request, response);
        });
      },
    });
    const reported = reportedBy(fixture.gateway);
    const path =
      kind === 'problem'
        ? '/missing'
        : kind === 'document'
          ? '/openapi.json'
          : kind === 'event'
            ? '/api/Transcoding/watch'
            : '/api/Transcoding/echo';
    const hasBody = kind === 'answer' || kind === 'event';
    // * no release competes with the deadline: the write stays held until its socket is aborted.
    const received = receivedOn(
      fixture.port,
      octetsOf(fixture.port, {
        ...(hasBody ? { body: '{}' } : {}),
        lines: [
          (hasBody ? 'POST ' : 'GET ') + path + ' HTTP/1.1',
          ...(hasBody ? ['content-type: application/json'] : []),
          ...(kind === 'event' ? ['accept: text/event-stream'] : []),
        ],
      })
    );
    await closed.promise;
    expect(await received).toBe(0);
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
    await fixture.watched(2);
    expect(chunks).toHaveLength(1);
    expect(statuses).toEqual([kind === 'problem' ? 404 : 200]);
    expect(chunks[0]?.length).toBeGreaterThan(0);
    if (kind === 'event') {
      const probe = opened(
        fixture.port,
        octetsOf(fixture.port, {
          body: '{}',
          lines: [
            'POST /api/Transcoding/watch HTTP/1.1',
            'content-type: application/json',
            'accept: text/event-stream',
          ],
        })
      );
      try {
        await readUntil(probe, 'data: {}\n\n');
      } finally {
        probe.destroy();
      }
    } else {
      expect((await send(fixture.port, { path: '/api/Transcoding/echo', body: '{}' })).status).toBe(
        200
      );
    }
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
    expect(reported).toEqual([
      'the response is dropped: minimumSendBytesPerSecond 1000000 after sendGracePeriod 1ms',
    ]);
  }
});

test('bounds every response body by maximumUnsentBytes before writing', async () => {
  for (const kind of ['answer', 'problem', 'document', 'event']) {
    await using fixture = await startTranscoding({ maximumUnsentBytes: 1, heartbeat: Infinity });
    const reported = reportedBy(fixture.gateway);
    const path =
      kind === 'problem'
        ? '/missing'
        : kind === 'document'
          ? '/openapi.json'
          : kind === 'event'
            ? '/api/Transcoding/watch'
            : '/api/Transcoding/echo';
    const hasBody = kind === 'answer' || kind === 'event';
    const received = await receivedOn(
      fixture.port,
      octetsOf(fixture.port, {
        ...(hasBody ? { body: '{}' } : {}),
        lines: [
          (hasBody ? 'POST ' : 'GET ') + path + ' HTTP/1.1',
          ...(hasBody ? ['content-type: application/json'] : []),
          ...(kind === 'event' ? ['accept: text/event-stream'] : []),
        ],
      })
    );
    expect(received).toBe(0);
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
    await fixture.watched(2);
    expect(reported).toEqual(['the response is dropped: maximumUnsentBytes 1 bytes']);
  }
});

test('bounds an accepted slice until its pending bytes are flushed', async () => {
  const closed = Promise.withResolvers<void>();
  const sizes: number[] = [];
  await using fixture = await startTranscoding({
    minimumSendBytesPerSecond: 1_000_000,
    sendGracePeriod: 1,
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        Object.defineProperty(response, 'writableLength', {
          get: () => {
            return sizes.length === 0 ? 0 : 65536;
          },
        });
        response.write = (bytes: Uint8Array): boolean => {
          sizes.push(bytes.length);
          return true;
        };
        response.once('close', () => {
          closed.resolve();
        });
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const received = receivedOn(
    fixture.port,
    octetsOf(fixture.port, {
      body: 'a'.repeat(3 * 65536 + 7),
      lines: ['POST /api/Transcoding/raw HTTP/1.1', 'content-type: application/octet-stream'],
    })
  );
  await closed.promise;
  expect(await received).toBe(0);
  await until(() => {
    return fixture.memory.clients.length === 0;
  });
  expect(sizes).toEqual([65536]);
  expect(reported).toEqual([
    'the response is dropped: minimumSendBytesPerSecond 1000000 after sendGracePeriod 1ms',
  ]);
});

test('writes whole answers and documents in slices of at most 64 KiB', async () => {
  const body = 'a'.repeat(3 * 64 * 1024 + 7);
  for (const kind of ['answer', 'document']) {
    const sizes: number[] = [];
    await using fixture = await startTranscoding({
      document: body,
      createServer: (listener) => {
        return createNodeServer((request, response) => {
          const write = response.write.bind(response);
          response.write = (
            chunk: Uint8Array,
            done?: BufferEncoding | ((error?: Error | null) => void)
          ): boolean => {
            sizes.push(chunk.length);
            return write(chunk, typeof done === 'function' ? done : undefined);
          };
          listener(request, response);
        });
      },
    });
    const reported = reportedBy(fixture.gateway);
    const received = await send(
      fixture.port,
      kind === 'document'
        ? { method: 'GET', path: '/openapi.json' }
        : {
            path: '/api/Transcoding/raw',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          }
    );
    expect(received.status).toBe(200);
    expect(received.body).toBe(body);
    expect(sizes).toEqual([65536, 65536, 65536, 7]);
    expect(reported).toEqual([]);
  }
});

test('stops heartbeats after their write loses its response', async () => {
  const written = Promise.withResolvers<void>();
  const chunks: string[] = [];
  const clock = createTestClock();
  await using fixture = await startTranscoding({
    clock,
    heartbeat: 1_000,
    createServer: (listener) => {
      return createNodeServer((request, response) => {
        const write = response.write.bind(response);

        response.write = (
          chunk: Uint8Array,
          done?: BufferEncoding | ((error?: Error | null) => void)
        ): boolean => {
          const text = new TextDecoder().decode(chunk);

          chunks.push(text);

          if (text === ':\n') {
            response.destroy();

            return false;
          }

          const taken = write(chunk, typeof done === 'function' ? done : undefined);

          written.resolve();

          return taken;
        };
        listener(request, response);
      });
    },
  });
  const reported = reportedBy(fixture.gateway);
  const socket = opened(
    fixture.port,
    octetsOf(fixture.port, {
      body: '{}',
      lines: [
        'POST /api/Transcoding/watch HTTP/1.1',
        'content-type: application/json',
        'accept: text/event-stream',
      ],
    })
  );

  try {
    await written.promise;
    await clock.tickAsync(1_000);
    await until(() => {
      return fixture.memory.clients.length === 0;
    });
    await clock.tickAsync(1_000);
    await fixture.watched(2);

    expect(chunks).toEqual(['event: result\nid: 1\ndata: {}\n\n', ':\n']);
    expect(reported).toEqual([]);
  } finally {
    socket.destroy();
  }
});

test('writes its comment a heartbeat after its last write, and none while writes go', async () => {
  const clock = createTestClock();
  await using fixture = await startTranscoding({ clock, heartbeat: 1_000 });
  const stream = opened(
    fixture.port,
    octetsOf(fixture.port, {
      body: '{}',
      lines: [
        'POST /api/Transcoding/watch HTTP/1.1',
        'content-type: application/json',
        'accept: text/event-stream',
      ],
    })
  );

  await readUntil(stream, 'data: {}\n\n');
  await clock.tickAsync(600);

  const first = readUntil(stream, '"remaining":2');

  await fixture.watched(2);
  await first;
  await clock.tickAsync(600);

  // * 1.2 s after the result, 0.6 s after the notification: no comment came before this one
  const second = readUntil(stream, '"remaining":1');

  await fixture.watched(1);
  expect(await second).not.toContain(':\n\r\n');

  const comment = readUntil(stream, ':\n\r\n');

  await clock.tickAsync(1_000);
  expect((await comment).endsWith(':\n\r\n')).toBe(true);
  stream.destroy();
});
