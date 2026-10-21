import type { Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { createTestClock, tcpSocketsClosed } from '../../shared/__tests__/fixtures';
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
  host,
  namesOf,
  portOf,
  post,
  postHeadOf,
  rawSocketOn,
  refusalOf,
  refusalsOf,
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

    // cancelled, and still coming past the limit: refused, its socket closed in stages, and what
    // comes after dropped
    for (const size of [40, 64]) {
      const endless = exchangeOf(connectionToken, { 'transfer-encoding': 'chunked' });

      endless.request.emit('data', request.subarray(0, 16));
      const cancelEndless = exchangeOf(connectionToken);

      fake.feed(cancelEndless.request, [envelopeOf(ENVELOPE_KINDS.CANCEL, { callId: 1 })]);
      expect(cancelEndless.response.status).toBe(204);
      endless.request.emit('data', new Uint8Array(size));

      if (size === 40) {
        expect(server.gauges().counts['bodyBytes']).toBe(56);
      }

      endless.request.emit('data', new Uint8Array(size));

      expect([
        endless.response.status,
        endless.response.headers?.[REFUSAL_HEADER],
        endless.response.headers?.['connection'],
        endless.request.isDestroyed,
      ]).toEqual([413, REFUSALS.TOO_LARGE, 'close', false]);
    }
    expect(
      namesOf(events, 'message').map(([, bytes]) => {
        return (bytes as number[])[1];
      })
    ).toEqual([ENVELOPE_KINDS.CANCEL, ENVELOPE_KINDS.CANCEL, ENVELOPE_KINDS.CANCEL]);
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

    // up to the budget exactly, across exchanges: 8 bytes held, and 16 more
    const holding = exchangeOf(connectionToken, { 'content-length': '16' });

    holding.request.emit('data', envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 5 }));
    expect(server.gauges().counts['bodyBytes']).toBe(8);

    const filling = exchangeOf(connectionToken, { 'content-length': '16' });

    fake.feed(filling.request, [envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 7, extra: 8 })]);
    expect(filling.response.status).toBe(200);
    expect(server.gauges().counts['bodyBytes']).toBe(8);
    expect(namesOf(events, 'message')).toHaveLength(3);
    fake.feed(holding.request, [new Uint8Array(8)]);
    expect(holding.response.status).toBe(200);
    expect(server.gauges().counts['bodyBytes']).toBe(0);
    expect(namesOf(events, 'message')).toHaveLength(4);
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
    await using started = await startTransport();
    const drawn = await connect(started.url, started.server);
    const { read, socket } = await rawSocketOn(portOf(started.url));

    try {
      socket.write(postHeadOf(drawn.connectionToken, request.length));
      socket.write(request.subarray(0, 12));
      await expect
        .poll(() => {
          return started.server.gauges().counts['waitingExchanges'];
        })
        .toBe(1);
      await started.server.send({ data: answer }, drawn.connectionHandle);
      await expect
        .poll(() => {
          const end = read.text.indexOf('\r\n\r\n');

          if (end < 0) {
            return false;
          }

          return /transfer-encoding: chunked/iu.test(read.text.slice(0, end))
            ? read.text.endsWith('\r\n0\r\n\r\n')
            : read.text.length - end - 4 >= answer.length;
        })
        .toBe(true);
      const end = read.text.indexOf('\r\n\r\n');
      const head = read.text.slice(0, end);
      const body = read.text.slice(end + 4);
      const expected = Buffer.from(answer).toString('latin1');

      expect(head).toMatch(/^HTTP\/1\.1 200/u);
      expect(body).toBe(
        /transfer-encoding: chunked/iu.test(head) ? `8\r\n${expected}\r\n0\r\n\r\n` : expected
      );
      expect(namesOf(started.events, 'message')).toEqual([]);
      expect(head.toLowerCase()).toContain('\r\nconnection: close');
      socket.write(request.subarray(12));
      await expect
        .poll(() => {
          return read.isClosed;
        })
        .toBe(true);
      expect(namesOf(started.events, 'message')).toEqual([]);
    } finally {
      socket.destroy();
    }
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
    const { receive } = createHTTPRequestExchange(port, {
      bodyGracePeriod: 5_000,
      clock: createTestClock(),
      maximumBodyBytes: 16,
      minimumBodyBytesPerSecond: 240,
    });
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

/** Writes `bytes` on `socket` at full speed, a mebibyte at a time, until it closes or `limit` went. */
const pumpOn = (socket: Socket, { limit = Infinity }: { limit?: number } = {}): void => {
  const chunk = new Uint8Array(1_048_576);
  let sent = 0;

  const pump = (): void => {
    while (!socket.destroyed && sent < limit) {
      const piece = chunk.subarray(0, Math.min(chunk.length, limit - sent));

      sent += piece.length;

      if (!socket.write(piece)) {
        return;
      }
    }
  };

  socket.on('drain', pump);
  pump();
};

/** The status line of what `read` holds, once its head came. */
const statusOf = async (read: { text: string }) => {
  await expect
    .poll(() => {
      return read.text.includes('\r\n\r\n');
    })
    .toBe(true);

  return read.text.split('\r\n')[0];
};

/** Whether the head `read` holds carries the field line `line`, in any case. */
const carries = (read: { text: string }, line: string): boolean => {
  return (read.text.split('\r\n\r\n')[0] ?? '').toLowerCase().split('\r\n').includes(line);
};

test.describe('createHTTPTransportServer, a body as it comes', () => {
  test.afterAll(async () => {
    await tcpSocketsClosed();
  });

  test('refuses 408 too-slow a body that comes slower than its rate once its grace passed, its client reading the 408 as it goes on sending, and keeps its connection; a body at its rate taken', async () => {
    const clock = createTestClock();
    await using started = await startTransport({
      bodyGracePeriod: 1_000,
      clock,
      minimumBodyBytesPerSecond: 1_000,
    });
    const { events, server, url } = started;
    const refusals = refusalsOf(server);
    const { connectionHandle, connectionToken } = await connect(url, server);
    const bodyBytes = () => {
      return server.gauges().counts['bodyBytes'];
    };
    const slow = await rawSocketOn(portOf(url));
    const trickled = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1, extra: 4_000 });

    slow.socket.write(postHeadOf(connectionToken, trickled.length));
    slow.socket.write(trickled.subarray(0, 12));
    await expect.poll(bodyBytes).toBe(12);

    // its grace passed with 12 bytes: refused as it goes on sending
    await clock.tickAsync(1_000);
    slow.socket.write(trickled.subarray(12, 2_000));

    expect(await statusOf(slow.read)).toBe('HTTP/1.1 408 Request Timeout');
    expect([
      carries(slow.read, 'bead-refusal: too-slow'),
      carries(slow.read, 'connection: close'),
    ]).toEqual([true, true]);
    slow.socket.write(trickled.subarray(2_000));
    await expect
      .poll(() => {
        return slow.read.isClosed;
      })
      .toBe(true);
    expect(
      refusals.map(({ reason, status }) => {
        return [status, reason];
      })
    ).toEqual([[408, REFUSALS.TOO_SLOW]]);
    expect([bodyBytes(), namesOf(events, 'message'), namesOf(events, 'close')]).toEqual([
      0,
      [],
      [],
    ]);

    // its Bead connection kept: a body that comes at its rate is taken, and answered
    const paced = await rawSocketOn(portOf(url));
    const request = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3, extra: 3_000 });

    paced.socket.write(postHeadOf(connectionToken, request.length));
    paced.socket.write(request.subarray(0, 1_000));
    await expect.poll(bodyBytes).toBe(1_000);
    await clock.tickAsync(900);
    paced.socket.write(request.subarray(1_000, 2_000));
    await expect.poll(bodyBytes).toBe(2_000);
    await clock.tickAsync(1_000);
    paced.socket.write(request.subarray(2_000));
    await expect
      .poll(() => {
        return namesOf(events, 'message').length;
      })
      .toBe(1);
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 3 }) }, connectionHandle);

    expect(await statusOf(paced.read)).toBe('HTTP/1.1 200 OK');
    expect(refusals).toHaveLength(1);
    paced.socket.destroy();
  });

  test('closes in stages every answer written before its body is whole, so a client that sends at full speed reads it, and its connection then answers a POST', async () => {
    await using started = await startTransport({ maximumBodyBytes: 16_000_000 });
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);

    // a 413 to a body declared past its limit, written before any of it is read
    const large = await rawSocketOn(portOf(url));

    large.socket.write(postHeadOf(connectionToken, 67_108_864));
    pumpOn(large.socket);

    expect(await statusOf(large.read)).toBe('HTTP/1.1 413 Payload Too Large');
    expect(carries(large.read, 'connection: close')).toBe(true);
    await expect
      .poll(() => {
        return large.read.isClosed;
      })
      .toBe(true);

    // its connection answers a POST after it
    const answered = post(url, {
      body: envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 }),
      connectionToken,
    });

    await expect
      .poll(() => {
        return namesOf(events, 'message').length;
      })
      .toBe(1);
    await server.send({ data: envelopeOf(ENVELOPE_KINDS.RESULT, { callId: 1 }) }, connectionHandle);

    expect((await answered).status).toBe(200);

    // a 404 to a body still coming as its connection closes
    const coming = await rawSocketOn(portOf(url));
    const request = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 3 });

    coming.socket.write(postHeadOf(connectionToken, 15_000_000));
    coming.socket.write(request);
    await expect
      .poll(() => {
        return server.gauges().counts['bodyBytes'];
      })
      .toBe(request.length);
    pumpOn(coming.socket, { limit: 14_000_000 });
    await server.close(connectionHandle);

    expect(await statusOf(coming.read)).toBe('HTTP/1.1 404 Not Found');
    expect([
      carries(coming.read, 'bead-refusal: connection-unknown'),
      carries(coming.read, 'connection: close'),
    ]).toEqual([true, true]);
    await expect
      .poll(() => {
        return coming.read.isClosed;
      })
      .toBe(true);
  });

  test('answers a body whose read fails, a malformed chunked one, the status of its failure, unmarked, its connection closed, never 200 and empty', async () => {
    await using started = await startTransport();
    const { events, server, url } = started;
    const { connectionHandle, connectionToken } = await connect(url, server);
    const { read, socket } = await rawSocketOn(portOf(url));
    const prefix = envelopeOf(ENVELOPE_KINDS.REQUEST, { callId: 1 });

    socket.write(
      `POST /bead HTTP/1.1\r\nHost: ${host}\r\nContent-Type: ${BEAD_MEDIA_TYPE}\r\n` +
        `${CONNECTION_TOKEN_HEADER}: ${connectionToken}\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n`
    );
    socket.write(prefix);
    await expect
      .poll(() => {
        return server.gauges().counts['bodyBytes'];
      })
      .toBe(prefix.length);
    // a chunk size that is none
    socket.write('\r\nzz\r\n');

    expect(await statusOf(read)).toBe('HTTP/1.1 400 Bad Request');
    expect(read.text).not.toMatch(/bead-refusal/iu);
    await expect
      .poll(() => {
        return read.isClosed;
      })
      .toBe(true);
    // the exchange lost, as a dropped socket's, which closes its connection; nothing handed on
    await expect
      .poll(() => {
        return namesOf(events, 'close');
      })
      .toEqual([['close', false, connectionHandle]]);
    expect([namesOf(events, 'message'), server.gauges().counts['bodyBytes']]).toEqual([[], 0]);
  });
});
