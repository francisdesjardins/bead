import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { createMemoryTransportServer } from '../../transport/server/memory-transport-server';
import type { IHTTPRequestLike, IHTTPResponseLike } from '../../transport/server/types';
import type { IClock } from '../../transport/shared/clock';
import { createHTTPGateway, type IHTTPGateway } from '../http-gateway';
import { HTTP_ROUTES, OPENAPI_DOCUMENT } from './generated/bead_http';
import { TranscodingProcedures } from './generated/transcoding_bead';
import { EdgesSchema } from './generated/transcoding_pb';
import { GOOD_CREDENTIAL, SESSION, startTranscoding } from './transcoding-service';

// interfaces

/** A request the test sends: its method, its target, its fields, its body's text, and its abort. */
interface ISent {
  body?: string;
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
        headers: { 'if-none-match': `W/${etag}` },
        method: 'GET',
        path: '/openapi.json',
      })
    ).status
  ).toBe(304);
  expect(await send(fixture.port, { method: 'HEAD', path: '/openapi.json' })).toMatchObject({
    body: '',
    headers: { 'content-length': String(Buffer.byteLength(OPENAPI_DOCUMENT)) },
    status: 200,
  });
  expect((await send(fixture.port, { body: '{}', path: '/openapi.json' })).headers).toMatchObject({
    allow: 'GET, HEAD',
  });

  // one given none serves none, and a handler mounted elsewhere leaves that server its other paths
  const silent = createHTTPGateway({
    routes: HTTP_ROUTES,
    transport: createMemoryTransportServer(),
  });

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

  expect(silent.listener(request, {} as IHTTPResponseLike)).toBe(false);
});

test('holds each caller’s calls and streams to bounds of their own', async () => {
  await using fixture = await startTranscoding({
    maximumConnectionsPerAddress: 1,
    maximumExchangesPerAddress: 1,
  });
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

  // * a stream holds one of its address's streams, not of its calls: past its call's bound, it opens
  const stream = new AbortController();
  const watching = send(fixture.port, {
    body: '{}',
    headers: { accept: 'text/event-stream' },
    path: '/api/Transcoding/watch',
    signal: stream.signal,
  });

  watching.catch(() => {});
  await sleep(100);

  const second = await send(fixture.port, {
    body: '{}',
    headers: { accept: 'text/event-stream' },
    path: '/api/Transcoding/watch',
  });

  expect(second.status).toBe(503);
  abort.abort();
  stream.abort();
  await until(() => {
    return fixture.counts.cancelled === 1;
  });

  // both freed as their exchanges end
  await sleep(50);
  expect((await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' })).status).toBe(
    200
  );
});

test('answers a result the stock library refuses 502, reported, none of its words in the problem', async () => {
  // * raw's route told its result is an Edges: the bytes its server echoes, `x`, a varint cut short
  await using fixture = await startTranscoding({
    routes: HTTP_ROUTES.map((init) => {
      return init.procedure === TranscodingProcedures.raw
        ? {
            ...init,
            procedure: { ...init.procedure, result: TranscodingProcedures.echoEdges.result },
            result: EdgesSchema,
          }
        : init;
    }),
  });
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
});

test('answers 503 DESTINATION_UNREACHABLE when its connection cannot be drawn, reported, none of its words in the problem', async () => {
  await using fixture = await startTranscoding();
  const reported = reportedBy(fixture.gateway);

  await fixture.memory.stop();

  const answered = await send(fixture.port, { body: '{}', path: '/api/Transcoding/echo' });

  expect(answered).toMatchObject({
    body: '{"code":17,"detail":"the connection is gone","scope":"protocol","status":503,"title":"DESTINATION_UNREACHABLE","type":"tag:francisdesjardins.ca,2026:bead/DESTINATION_UNREACHABLE"}',
    headers: { 'retry-after': '1' },
    status: 503,
  });
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatch(/, not open$/u);
});

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
    body: '{"detail":"the gateway failed","status":500,"title":"Internal Server Error","type":"about:blank"}',
    status: 500,
  });
  expect(reported).toEqual(['the clock broke']);
});
