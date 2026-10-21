import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { expect, test } from '@playwright/test';
import { EnvelopeKind } from '../../../router/shared/constants';
import { createTestClock, tcpSocketsClosed, timersBy } from '../../shared/__tests__/fixtures';
import {
  AFTER_HEADER,
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  ENVELOPE_KINDS,
  LISTEN_HEADER,
  REFUSAL_HEADER,
  REFUSALS,
  SEQUENCE_HEADER,
  WAIT_HEADER,
} from '../http-transport-server';
import { countOf, hasBody, headerOf, linesOf, listeningOf } from '../http-server-fields';
import type { TransportServerConnectionHandle } from '../types';
import {
  BEARER,
  PAGE,
  batchOf,
  bytesOf,
  envelopeOf,
  fieldsOf,
  host,
  namesOf,
  post,
  preflightAnswerOf,
  rawAnswerOf,
  rawConnectOf,
  refusalsOf,
  requestLikeOf,
  startScripted,
  startTransport,
} from './http-transport-server-fixtures';

// helpers

/** The fields every response on the path carries but HTTP's own 400, and the one CORS names. */
const PATH_FIELDS = [
  'access-control-allow-origin',
  'cache-control',
  'vary',
  'x-content-type-options',
] as const;

/** What every answer to {@link PAGE} carries of CORS once its origin is judged, but a preflight's. */
const NAMED_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-methods': null,
  'access-control-allow-headers': null,
  'access-control-max-age': null,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': PAGE,
  'access-control-expose-headers': '*',
  vary: 'Origin',
});

/** What an answer that names no origin carries of CORS. */
const UNNAMED_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-methods': null,
  'access-control-allow-headers': null,
  'access-control-max-age': null,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': null,
  'access-control-expose-headers': null,
  vary: 'Origin',
});

// definition

test.describe('createHTTPTransportServer', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
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
      const refusals = refusalsOf(started.server);

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
      expect(refusals).toEqual([]);
    }
  });
});

test.describe('createHTTPTransportServer, its edges', () => {
  test('checks every request field for visible bytes and edge whitespace before admission', async () => {
    const { events, fake, server } = await startScripted({ hosts: ['bead.test'] });
    const refusals = refusalsOf(server);
    const cases: [string, string, number, string | undefined][] = [
      ['origin', 'http://a.example\tb', 403, REFUSALS.ORIGIN],
      ['x-other', 'x \ty', 201, undefined],
      ['x-other', '', 201, undefined],
    ];

    for (const name of ['host', 'origin', 'x-other', 'bead-after']) {
      for (const value of ['café', 'a\u0007b', 'x ']) {
        cases.push([name, value, 400, undefined]);
      }
    }

    try {
      for (const [name, value, status, reason] of cases) {
        const before = namesOf(events, 'connection').length;
        const { response } = fake.exchange({
          headers: { host: 'bead.test', 'content-type': BEAD_MEDIA_TYPE, [name]: value },
        });

        expect([response.status, response.headers?.[REFUSAL_HEADER]], `${name}: ${value}`).toEqual([
          status,
          reason,
        ]);
        expect(namesOf(events, 'connection')).toHaveLength(before + (status === 201 ? 1 : 0));
      }

      expect(server.clients).toHaveLength(2);
      expect(
        refusals.map((refusal) => {
          return refusal.reason;
        })
      ).toEqual([REFUSALS.ORIGIN]);
    } finally {
      await server.stop();
    }
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
      // path read after it, and its query by no exchange
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
      statusOf({ ...bead, host: '' }),
      statusOf(bead, { url: '/' }),
      statusOf({ ...bead, host: 'rebound.example' }, { url: 'http://bead.example/bead' }),
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
      [403, REFUSALS.HOST],
      [404, REFUSALS.PATH],
      [201, undefined],
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
    await using started = await startTransport({ hosts: ['bead.example'] });
    const port = Number(new URL(started.url).port);

    for (const target of ['http:///', 'HTTP://127.0.0.1/']) {
      const { answer } = await rawAnswerOf(
        port,
        `POST ${target} HTTP/1.1\r\nHost: bead.example\r\nContent-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
      );

      expect(answer, target).toEqual([400, null]);
    }
    expect(namesOf(started.events, 'connection')).toEqual([]);
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

  // spec 15.6, 15.9
  test('reads a listen’s counts from bead-after and bead-wait, a field given as several lines joined, and refuses 400 a listen without bead-after, whatever its target holds', async () => {
    const clock = createTestClock();
    const {
      connectScripted,
      events: startedEvents,
      fake,
      listenOf,
      server,
    } = await startScripted({
      clock,
      inactivityTimeout: Infinity,
    });
    const { connectionHandle, connectionToken } = connectScripted({ isListening: true });
    const notification = envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 });
    const statusOf = (exchange: ReturnType<typeof listenOf>) => {
      return [exchange.response.status, exchange.response.headers?.[REFUSAL_HEADER]];
    };
    const at = (url: string, counts: Record<string, string>) => {
      return fake.exchange({
        headers: { [CONNECTION_TOKEN_HEADER]: connectionToken, ...counts },
        method: 'GET',
        url,
      });
    };

    await server.send({ data: notification }, connectionHandle);

    // Items of RFC 9651 whose bare item is an Integer of 0 or more, each field's lines joined
    // before they are read: two lines are a list, which no Item is
    expect([
      statusOf(listenOf(connectionToken, { after: ['0', '0'], wait: '0' })),
      statusOf(listenOf(connectionToken, { wait: ['0', '1'] })),
      statusOf(listenOf(connectionToken, { after: '0, 0' })),
      statusOf(listenOf(connectionToken, { after: '' })),
      statusOf(listenOf(connectionToken, { after: '1.0' })),
      statusOf(listenOf(connectionToken, { after: '"1"' })),
      statusOf(listenOf(connectionToken, { after: '-1' })),
      statusOf(listenOf(connectionToken, { after: '0', wait: '?1' })),
      statusOf(listenOf(connectionToken, { after: '0;X=1' })),
      // without bead-after, its counts in the query or not
      statusOf(listenOf(connectionToken, { after: null, wait: '0' })),
      statusOf(at('/bead?after=0&wait=0', {})),
    ]).toEqual(
      Array.from({ length: 11 }, () => {
        return [400, REFUSALS.MALFORMED];
      })
    );

    // with it, whatever its query: its parameters ignored, -0 read as 0
    const brought = at('/bead?after=5&x=1', {
      [AFTER_HEADER]: '-0;x=1',
      [WAIT_HEADER]: '0;y="a;b"',
    });

    expect([
      brought.response.status,
      brought.response.headers?.[SEQUENCE_HEADER],
      [...(brought.response.body ?? [])],
    ]).toEqual([200, '1', batchOf(notification)]);

    for (const url of ['/bead?after=5&x=1', '/bead?', '/bead']) {
      const response = at(url, {
        [AFTER_HEADER]: '0',
        ...(url === '/bead' ? {} : { [WAIT_HEADER]: '0' }),
      }).response;

      expect([
        response.status,
        response.headers?.[SEQUENCE_HEADER],
        [...(response.body ?? [])],
      ]).toEqual([200, '1', batchOf(notification)]);
    }
    expect(statusOf(at('/bead', { [AFTER_HEADER]: '1;x=1', [WAIT_HEADER]: '0;y="a;b"' }))).toEqual([
      204,
      undefined,
    ]);

    // a bead-wait left out is 0, answered at once; one given, held as long
    const { armed } = timersBy(clock, () => {
      expect(statusOf(at('/bead?', { [AFTER_HEADER]: '1' }))).toEqual([204, undefined]);
    });
    let waiting: ReturnType<typeof at> | undefined;
    const held = timersBy(clock, () => {
      waiting = at('/bead', { [AFTER_HEADER]: '1', [WAIT_HEADER]: '500' });
    });

    expect([
      armed,
      held.armed.map(({ delay }) => {
        return delay;
      }),
    ]).toEqual([[], [500]]);
    expect(waiting?.response.status).toBeUndefined();
    clock.tick(500);
    expect(waiting?.response.status).toBe(204);
    expect(namesOf(startedEvents, 'close')).toEqual([]);
    await server.stop();
  });
});

/** A preflight from `origin` (Fetch §3.3.2): an `OPTIONS` naming the method it asks for, and its fields. */
const preflight = (
  url: string,
  {
    fields,
    method,
    origin = PAGE,
  }: { fields?: string | undefined; method: string; origin?: string }
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
  test('answers a preflight from an origin it names 204, naming it, the methods, Authorization, the fields it asks for in its lines joined and any other field, for 7200 seconds, and tells no refusal', async () => {
    await using started = await startTransport({ origins: [PAGE] });
    const { events, server, url } = started;
    const refusals = refusalsOf(server);
    // what a page asks before a connect, before a listen at the connection's one URL, and of a
    // method the server does not take, which its browser refuses against the answer
    const asked = [
      'bead-listen,content-type,traceparent',
      'bead-listen,content-type,traceparent,sentry-trace,baggage',
      'bead-after,bead-connection-token,bead-wait',
      undefined,
    ];
    const answers = [
      await preflight(url, { fields: asked[0], method: 'POST' }),
      await preflight(url, { fields: asked[1], method: 'POST' }),
      await preflight(url, { fields: asked[2], method: 'GET' }),
      await preflight(url, { method: 'PUT' }),
    ];

    for (const [index, answer] of answers.entries()) {
      const expected = preflightAnswerOf(asked[index]);

      expect([answer.status, fieldsOf(answer.headers, expected), await bytesOf(answer)]).toEqual([
        204,
        expected,
        [],
      ]);
    }

    // what it asks in two field lines, joined as one value (RFC 9110 §5.3), and nothing asked
    // when the field is empty
    const scripted = await startScripted({ origins: [PAGE] });
    const preflightScripted = (lines: string[]) => {
      return scripted.fake.exchange({
        headers: {
          'access-control-request-headers': lines,
          'access-control-request-method': 'GET',
          origin: PAGE,
        },
        method: 'OPTIONS',
      }).response;
    };

    expect([
      preflightScripted(['bead-after', 'bead-wait']).headers?.['access-control-allow-headers'],
      preflightScripted(['']).headers?.['access-control-allow-headers'],
    ]).toEqual(['authorization, bead-after, bead-wait, *', 'authorization, *']);
    await scripted.server.stop();

    const port = Number(new URL(url).port);

    for (const lines of [
      'Access-Control-Request-Headers: bead-after\r\nAccess-Control-Request-Headers: bead-wait\r\n',
      'Access-Control-Request-Headers:\r\n',
    ]) {
      const answered = await rawAnswerOf(
        port,
        `OPTIONS /bead HTTP/1.1\r\nHost: ${host}:${String(port)}\r\nOrigin: ${PAGE}\r\nAccess-Control-Request-Method: GET\r\n${lines}\r\n`
      );
      const expected = preflightAnswerOf(
        lines.includes('bead-after') ? 'bead-after, bead-wait' : undefined
      );

      expect(answered.answer).toEqual([204, null]);
      expect(
        fieldsOf(
          {
            get: (name) => {
              return answered.fields.get(name);
            },
          },
          expected
        )
      ).toEqual(expected);
    }
    // no refusal, and no connection drawn
    expect(refusals).toEqual([]);
    expect([namesOf(events, 'connection'), server.clients]).toEqual([[], []]);

    const bare = await fetch(url, { headers: { origin: PAGE }, method: 'OPTIONS' });

    expect([bare.status, bare.headers.get(REFUSAL_HEADER)]).toEqual([405, REFUSALS.METHOD]);
    expect(await bytesOf(bare)).toEqual([]);
    await expect
      .poll(() => {
        return refusals.length;
      })
      .toBe(1);
    expect(
      refusals.map(({ reason }) => {
        return reason;
      })
    ).toEqual([REFUSALS.METHOD]);
  });

  // spec 15.4, 15.9, 15.12
  test('names an origin it names on every answer it writes to it once that origin is judged, a batch and a refusal among them, and exposes every field', async () => {
    await using started = await startTransport({ origins: [PAGE] });
    const { events, server, url } = started;
    const headers = { origin: PAGE };
    const named: unknown[] = [];
    const reasons: (string | null)[] = [];
    const name = async (answered: Response | Promise<Response>) => {
      const response = await answered;

      named.push([response.status, fieldsOf(response.headers, NAMED_ANSWER)]);
      reasons.push(response.headers.get(REFUSAL_HEADER));

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
    expect(await bytesOf(head)).toEqual([...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 })]);

    // one answered as it is handed on, in one go
    server.on('message', ({ data }) => {
      if ((data as Uint8Array)[7] === 3) {
        void server.send(
          { data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) },
          connectionHandle
        );
      }
    });
    for (const authorization of [undefined, BEARER]) {
      const response = await name(
        post(url, {
          body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 }),
          connectionToken,
          headers: { ...headers, ...(authorization === undefined ? {} : { authorization }) },
        })
      );

      expect(await bytesOf(response)).toEqual([
        ...envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }),
      ]);
    }
    await name(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 5 }),
        connectionToken,
        headers,
      })
    );

    // a batch
    await server.send(
      { data: envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }) },
      connectionHandle
    );
    const batch = await name(
      fetch(url, {
        headers: {
          ...headers,
          [AFTER_HEADER]: '0',
          [CONNECTION_TOKEN_HEADER]: connectionToken,
          [WAIT_HEADER]: '0',
        },
      })
    );

    expect(batch.headers.get(SEQUENCE_HEADER)).toBe('1');
    expect(await bytesOf(batch)).toEqual(
      batchOf(envelopeOf(EnvelopeKind.NOTIFICATION, { callId: 1 }))
    );
    const empty = await name(
      fetch(url, {
        headers: {
          ...headers,
          [AFTER_HEADER]: '1',
          [CONNECTION_TOKEN_HEADER]: connectionToken,
          [WAIT_HEADER]: '0',
        },
      })
    );

    expect(await bytesOf(empty)).toEqual([]);

    // refusals once the origin is judged: an OPTIONS that is no preflight, a body of another type,
    // a token that is none
    const bare = await name(fetch(url, { headers, method: 'OPTIONS' }));
    await name(
      post(url, { connectionToken, headers: { ...headers, 'content-type': 'text/plain' } })
    );
    await name(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 7 }),
        connectionToken,
        headers: { ...headers, 'content-type': 'text/plain' },
      })
    );
    await name(fetch(url, { headers, method: 'PUT' }));
    await name(post(url, { connectionToken: 'not-a-token', headers }));
    await name(
      fetch(url, {
        headers: { ...headers, [CONNECTION_TOKEN_HEADER]: 'not a token' },
        method: 'DELETE',
      })
    );

    // a DELETE, and an exchange after it
    await name(
      fetch(url, {
        headers: { ...headers, [CONNECTION_TOKEN_HEADER]: connectionToken },
        method: 'DELETE',
      })
    );
    await name(post(url, { connectionToken, headers }));
    await name(
      post(url, {
        body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 9 }),
        connectionToken,
        headers,
      })
    );

    expect(named).toEqual(
      [201, 200, 200, 200, 204, 200, 204, 405, 415, 415, 405, 400, 400, 204, 404, 404].map(
        (status) => {
          return [status, NAMED_ANSWER];
        }
      )
    );
    expect(reasons).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      REFUSALS.METHOD,
      REFUSALS.TYPE,
      REFUSALS.TYPE,
      REFUSALS.METHOD,
      REFUSALS.MALFORMED,
      REFUSALS.MALFORMED,
      null,
      REFUSALS.CONNECTION_UNKNOWN,
      REFUSALS.CONNECTION_UNKNOWN,
    ]);
    expect(bare.headers.get('allow')).toBe('GET, POST, DELETE');
    expect(namesOf(events, 'message')).toHaveLength(4);
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
      await answerOf(
        `OPTIONS /bead HTTP/1.1\r\nHost: ${authority}\r\nOrigin: https://elsewhere.test\r\nAccess-Control-Request-Method: POST\r\n\r\n`
      ),
      // a page it names, before its origin is judged: by a host it does not take, at another path
      await answerOf(
        `OPTIONS /bead HTTP/1.1\r\nHost: rebind.example\r\nOrigin: ${PAGE}\r\n` +
          'Access-Control-Request-Method: POST\r\n\r\n'
      ),
      await answerOf(
        `OPTIONS /elsewhere HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${PAGE}\r\n` +
          'Access-Control-Request-Method: POST\r\n\r\n'
      ),
      await answerOf(rawConnectOf(authority, `${CONNECTION_TOKEN_HEADER}: short\r\n`)),
    ]).toEqual([
      unnamed(201, null),
      unnamed(201, null),
      unnamed(405, REFUSALS.METHOD),
      unnamed(405, REFUSALS.METHOD),
      unnamed(403, REFUSALS.ORIGIN),
      unnamed(403, REFUSALS.ORIGIN),
      unnamed(403, REFUSALS.HOST),
      unnamed(404, REFUSALS.PATH),
      unnamed(400, REFUSALS.MALFORMED),
    ]);
    expect(
      refusals.map(({ reason }) => {
        return reason;
      })
    ).toEqual([
      REFUSALS.METHOD,
      REFUSALS.METHOD,
      REFUSALS.ORIGIN,
      REFUSALS.ORIGIN,
      REFUSALS.HOST,
      REFUSALS.PATH,
      REFUSALS.MALFORMED,
    ]);

    // HTTP's own 400, from a page it names: two hosts, and a field of an octet past ASCII
    for (const fields of [`Host: ${authority}\r\n`, 'X-Other: café\r\n', 'X-Other: a\u0007b\r\n']) {
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
    const malformed = await rawAnswerOf(
      port,
      `POST http://localhost:/bead HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${PAGE}\r\nContent-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
    );

    expect(malformed.answer).toEqual([400, null]);
    expect(
      PATH_FIELDS.filter((field) => {
        return malformed.fields.has(field);
      })
    ).toEqual([]);
    expect(refusals).toHaveLength(7);
  });
});

test.describe('createHTTPTransportServer, the refusals it tells', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('answers 400 unmarked, with none of the path’s fields, a field holding a control character other than HTAB or an octet past ASCII, and tells nothing', async () => {
    for (const origins of [undefined, ['http://a.example']]) {
      await using started = await startTransport({ origins });
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
        `X-Other: ${Buffer.from('café', 'utf8').toString('latin1')}\r\n`,
      ];
      const answers: unknown[] = [];

      // each from a page the server names besides, which none of them names
      for (const field of fields) {
        for (const origin of ['', 'Origin: http://a.example\r\n']) {
          const { answer, fields: carried } = await rawAnswerOf(
            port,
            rawConnectOf(authority, `${origin}${field}`)
          );

          answers.push([
            ...answer,
            ...PATH_FIELDS.filter((name) => {
              return carried.has(name);
            }),
          ]);
        }
      }

      expect(answers).toEqual(
        fields.flatMap(() => {
          return [
            [400, null],
            [400, null],
          ];
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
      expect(
        PATH_FIELDS.filter((name) => {
          return tabbed.fields.has(name);
        })
      ).toEqual(['cache-control', 'vary', 'x-content-type-options']);
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
    }
  });
});

test.describe('the fields a request carries', () => {
  test('reads a field by its first line or all of them, a count and a listen as RFC 9651 Items, and a body as its length or its coding says', () => {
    const counted = (values: string[]) => {
      return countOf(
        requestLikeOf(
          values.map((value) => {
            return [AFTER_HEADER, value] as const;
          })
        ),
        AFTER_HEADER
      );
    };
    const listening = (values: string[]) => {
      return listeningOf(
        requestLikeOf(
          values.map((value) => {
            return [LISTEN_HEADER, value] as const;
          })
        )
      );
    };
    const twice = requestLikeOf([
      ['Authorization', BEARER],
      ['authorization', 'Basic'],
    ]);

    expect(headerOf(twice, 'authorization')).toBe(BEARER);
    expect(linesOf(twice, 'authorization')).toEqual([BEARER, 'Basic']);
    expect([
      counted(['3']),
      counted(['0;p=1']),
      counted([]),
      counted(['-1']),
      counted(['1', '2']),
    ]).toEqual([3, 0, 0, undefined, undefined]);
    expect(countOf(requestLikeOf([]), AFTER_HEADER, { isRequired: true })).toBeUndefined();
    expect([listening(['?1']), listening(['?0']), listening([]), listening(['1'])]).toEqual([
      true,
      false,
      false,
      undefined,
    ]);
    expect(
      [
        [['Content-Length', '0']],
        [['Content-Length', '8']],
        [['Transfer-Encoding', 'chunked']],
        [],
      ].map((fields) => {
        return hasBody(requestLikeOf(fields as [string, string][]));
      })
    ).toEqual([false, true, true, false]);
  });
});
