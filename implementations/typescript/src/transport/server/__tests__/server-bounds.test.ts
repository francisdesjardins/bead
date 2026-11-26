import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import { GenericError, ProgrammerError } from '../../shared/errors';
import { createTestClock, hasRef } from '../../shared/__tests__/fixtures';
import {
  answerBeforeClose,
  assertCount,
  boundHeadOf,
  createSendPace,
  droppedOf,
  HEADERS_TIMEOUT,
  lateOf,
  lingerOn,
  MINIMUM_SEND_BYTES_PER_SECOND,
  SEND_GRACE_PERIOD,
} from '../server-bounds';

// helpers

/** A socket as Node's closes one once its answer is written: its destroy armed on its `finish`. */
const createLingeringSocket = () => {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    destroyed: 0,
    destroy: () => {
      socket.destroyed += 1;

      return socket;
    },
  });

  // what Node's `destroySoon` arms as it ends the socket's write side
  socket.once('finish', socket.destroy);

  return socket;
};

// definition

test.describe('createSendPace', () => {
  test('holds what waits to its pace: a deadline the longer of its grace and its bytes at its rate, judged each second, late once past it', async () => {
    // * its timer is its stack's platform clock's, here a test's, stepped from check to check
    const platform = createTestClock();
    let unsent = 0;
    const lates: number[] = [];
    const pace = createSendPace(
      {
        clock: platform,
        late: () => {
          lates.push(unsent);
        },
        unsent: () => {
          return unsent;
        },
      },
      { minimumSendBytesPerSecond: 1_000, sendGracePeriod: 1_500 }
    );

    // 10 bytes take 10 ms at its rate: its grace stands
    unsent = 10;
    pace.hand(10);

    const [check] = platform.armed;

    // judged each second, keeping no process alive
    expect([platform.armed.length, check?.delay, check && hasRef(check.handle)]).toEqual([
      1,
      1_000,
      false,
    ]);

    await platform.tickAsync(1_000);

    expect(lates).toEqual([]);

    await platform.tickAsync(1_000);

    // late once, and judged no more
    expect([lates, platform.cleared]).toEqual([[10], [check?.handle]]);
    expect(platform.countTimers()).toBe(0);
  });

  test('moves its deadline by the time each envelope takes, the later of now and the deadline before, and runs none while nothing waits', async () => {
    const platform = createTestClock();
    let unsent = 0;
    let isLate = false;
    const pace = createSendPace(
      {
        clock: platform,
        late: () => {
          isLate = true;
        },
        unsent: () => {
          return unsent;
        },
      },
      { minimumSendBytesPerSecond: 80, sendGracePeriod: 20 }
    );

    // two envelopes of 50 bytes: 625 ms each, the second after the first, due at 1,250 ms
    unsent = 100;
    pace.hand(50);
    pace.hand(50);
    await platform.tickAsync(1_000);

    expect(isLate).toBe(false);

    await platform.tickAsync(1_000);

    expect(isLate).toBe(true);

    // nothing waiting, its check stops, and the next envelope starts from now
    const next = createSendPace(
      {
        clock: platform,
        late: () => {
          throw new Error('nothing waited');
        },
        unsent: () => {
          return unsent;
        },
      },
      { minimumSendBytesPerSecond: 1_000, sendGracePeriod: 20 }
    );

    unsent = 0;
    next.hand(10);
    await platform.tickAsync(1_000);

    expect(platform.cleared).toContain(platform.armed[1]?.handle);
    expect(platform.countTimers()).toBe(0);
  });

  test('holds none at a rate of 0, and its defaults are Kestrel’s, 240 bytes a second past 5 s', () => {
    const platform = createTestClock();
    const pace = createSendPace(
      {
        clock: platform,
        late: () => {
          throw new Error('no pace held');
        },
        unsent: () => {
          return 1;
        },
      },
      { minimumSendBytesPerSecond: 0, sendGracePeriod: 1 }
    );

    pace.hand(1_000_000);

    expect(platform.armed).toEqual([]);
    expect([MINIMUM_SEND_BYTES_PER_SECOND, SEND_GRACE_PERIOD, HEADERS_TIMEOUT]).toEqual([
      240, 5_000, 30_000,
    ]);
  });
});

test.describe('droppedOf', () => {
  // spec 15.1, 15.12
  test('reports a connection dropped behind its pace by its handle, naming minimumSendBytesPerSecond and sendGracePeriod with their values', () => {
    const dropped = droppedOf(
      'type=HTTP;ip=192.0.2.9;ordinal=1',
      lateOf({ minimumSendBytesPerSecond: 240, sendGracePeriod: 5_000 })
    );

    expect([dropped instanceof GenericError, dropped.message]).toEqual([
      true,
      'type=HTTP;ip=192.0.2.9;ordinal=1 is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 240 past sendGracePeriod 5000 ms',
    ]);
  });
});

test.describe('assertCount', () => {
  test('holds a whole number above 0, or from 0 where 0 holds none, and refuses any other naming its option', () => {
    expect([
      assertCount('n', { value: 1 }),
      assertCount('n', { mayBeNone: true, value: 0 }),
    ]).toEqual([1, 0]);

    for (const [value, mayBeNone, refusal] of [
      [0, false, 'n is a whole number above 0, not 0'],
      [1.5, false, 'n is a whole number above 0, not 1.5'],
      [Infinity, false, 'n is a whole number above 0, not Infinity'],
      [-1, true, 'n is a whole number, not -1'],
      [Number.NaN, true, 'n is a whole number, not NaN'],
      ['1', true, 'n is a whole number, not 1'],
    ] as const) {
      expect(() => {
        return assertCount('n', { mayBeNone, value });
      }).toThrow(new ProgrammerError(refusal));
    }
  });
});

test.describe('boundHeadOf', () => {
  test('sets a server’s headersTimeout, no requestTimeout and a check each second, and leaves one without them as it is', () => {
    const http1 = {
      connectionsCheckingInterval: 30_000,
      headersTimeout: 60_000,
      requestTimeout: 300_000,
    };
    const http2 = {};

    boundHeadOf(http1, 1_234);
    boundHeadOf(http2, 1_234);

    expect([http1, http2]).toEqual([
      { connectionsCheckingInterval: 1_000, headersTimeout: 1_234, requestTimeout: 0 },
      {},
    ]);
  });
});

test.describe('answerBeforeClose', () => {
  // RFC 9112 §9.6
  test('lets the answer under way end behind a request that asked its connection closed, and answers every other refusal of its parser’s as Node does', () => {
    const http1 = Object.assign(new EventEmitter(), { headersTimeout: 1_000 });
    const http2 = new EventEmitter();
    const socketOf = (answer: { _headerSent: boolean } | null) => {
      const socket = {
        _httpMessage: answer,
        destroyed: [] as (Error | undefined)[],
        destroy: (error?: Error) => {
          socket.destroyed.push(error);
        },
        writable: true,
        write: (data: string) => {
          socket.written.push(data);
        },
        written: [] as string[],
      };

      return socket;
    };
    const refusalOf = (code: string): Error => {
      return Object.assign(new Error(code), { code });
    };

    answerBeforeClose(http1);
    answerBeforeClose(http2);

    // * an answer under way, its head written or not: left to end
    const underWay = socketOf({ _headerSent: true });

    http1.emit('clientError', refusalOf('HPE_CLOSED_CONNECTION'), underWay);

    expect([underWay.written, underWay.destroyed]).toEqual([[], []]);

    // none under way, or another refusal: answered as Node answers it, then destroyed
    for (const [code, answer, written] of [
      ['HPE_CLOSED_CONNECTION', null, '400 Bad Request'],
      ['HPE_INVALID_METHOD', null, '400 Bad Request'],
      ['ERR_HTTP_REQUEST_TIMEOUT', null, '408 Request Timeout'],
      ['HPE_CHUNK_EXTENSIONS_OVERFLOW', null, '413 Payload Too Large'],
      ['HPE_HEADER_OVERFLOW', { _headerSent: false }, '431 Request Header Fields Too Large'],
      ['HPE_INVALID_METHOD', { _headerSent: true }, undefined],
    ] as const) {
      const socket = socketOf(answer);
      const error = refusalOf(code);

      http1.emit('clientError', error, socket);

      expect(socket.written).toEqual(
        written === undefined ? [] : [`HTTP/1.1 ${written}\r\nConnection: close\r\n\r\n`]
      );
      expect(socket.destroyed).toEqual([error]);
    }

    // a server without a head's bounds heard nothing
    expect(http2.listenerCount('clientError')).toBe(0);
  });
});

test.describe('lingerOn', () => {
  test('reads on once its answer is written and destroys the socket once its client ends it', () => {
    const socket = createLingeringSocket();
    const response = new EventEmitter();

    lingerOn(socket, response, { clock: createTestClock() });
    response.emit('finish');
    // its write side flushed: Node would destroy it now
    socket.emit('finish');

    expect(socket.destroyed).toBe(0);

    socket.emit('end');

    expect(socket.destroyed).toBe(1);
    socket.emit('close');
  });

  test('destroys a socket whose client never ends it after 2 s, on the platform’s clock', async () => {
    // * its timer is its stack's platform clock's, here a test's, stepped to its due
    const platform = createTestClock();
    const socket = createLingeringSocket();
    const response = new EventEmitter();

    lingerOn(socket, response, { clock: platform });
    response.emit('finish');

    // armed for 2 s, keeping no process alive
    expect(
      platform.armed.map(({ delay, handle }) => {
        return [delay, hasRef(handle)];
      })
    ).toEqual([[2_000, false]]);

    await platform.tickAsync(1_999);

    expect(socket.destroyed).toBe(0);

    await platform.tickAsync(1);

    expect(socket.destroyed).toBe(1);
  });
});
