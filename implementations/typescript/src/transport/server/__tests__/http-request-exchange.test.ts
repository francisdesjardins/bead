import { expect, test } from '@playwright/test';
import { tcpSocketsClosed } from '../../shared/__tests__/fixtures';
import { createHTTPRequestExchange, type IHTTPRequestExchangePort } from '../http-request-exchange';
import type { IEnd } from '../http-server-fields';
import {
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  ENVELOPE_KINDS,
  REFUSAL_HEADER,
  REFUSALS,
} from '../http-transport-server';
import type { IHTTPResponseLike } from '../types';
import {
  BEARER,
  connect,
  envelopeOf,
  namesOf,
  post,
  refusalOf,
  requestLikeOf,
  startScripted,
  startTransport,
} from './http-transport-server-fixtures';

// definition

test.describe('createHTTPTransportServer', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
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
});

test.describe('createHTTPTransportServer, its edges', () => {
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
});

test.describe('createHTTPRequestExchange', () => {
  test('finishes an exchange with two Authorization fields 400, one declared past its limit 413, and one its connection cannot take 429, before it reads a byte', () => {
    const asked: string[] = [];
    const ends: IEnd[] = [];
    // a port that records what is asked of it, takes no exchange, and records how each is finished
    const port = new Proxy({} as IHTTPRequestExchangePort<string>, {
      get: (_target, name) => {
        return (_first: unknown, second: unknown) => {
          asked.push(String(name));

          if (name === 'finish') {
            ends.push(second as IEnd);
          }

          return false;
        };
      },
    });
    const { receive } = createHTTPRequestExchange(port, { maximumBodyBytes: 16 });
    const response = {} as IHTTPResponseLike;

    for (const fields of [
      [
        ['Authorization', BEARER],
        ['Authorization', BEARER],
      ],
      [['Content-Length', '17']],
      [['Content-Length', '16']],
    ] as const) {
      receive({ request: requestLikeOf(fields), response }, 'a');
    }

    expect(ends).toEqual([
      { reason: REFUSALS.MALFORMED, status: 400 },
      { reason: REFUSALS.TOO_LARGE, status: 413 },
      { reason: REFUSALS.BUSY, status: 429 },
    ]);
    expect(asked).toEqual(['finish', 'finish', 'admitExchange', 'finish']);
  });
});
