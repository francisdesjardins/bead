import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { GenericError, ProgrammerError } from '../../shared/errors';
import { spyIntervals } from '../../shared/__tests__/fixtures';
import {
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
    using intervals = spyIntervals();
    let unsent = 0;
    const lates: number[] = [];
    const pace = createSendPace(
      {
        late: () => {
          lates.push(unsent);
        },
        unsent: () => {
          return unsent;
        },
      },
      { minimumSendBytesPerSecond: 1_000, sendGracePeriod: 40 }
    );

    // 10 bytes take 10 ms at its rate: its grace stands
    unsent = 10;
    pace.hand(10);

    const [check] = intervals.armed;

    expect([intervals.armed.length, check?.delay, check?.unrefs]).toEqual([1, 1_000, 1]);

    check?.beat();

    expect(lates).toEqual([]);

    await sleep(60);
    check?.beat();

    // late once, and judged no more
    expect([lates, intervals.cleared]).toEqual([[10], [check]]);
  });

  test('moves its deadline by the time each envelope takes, the later of now and the deadline before, and runs none while nothing waits', async () => {
    using intervals = spyIntervals();
    let unsent = 0;
    let isLate = false;
    const pace = createSendPace(
      {
        late: () => {
          isLate = true;
        },
        unsent: () => {
          return unsent;
        },
      },
      { minimumSendBytesPerSecond: 1_000, sendGracePeriod: 20 }
    );

    // two envelopes of 50 bytes: 50 ms each, the second after the first
    unsent = 100;
    pace.hand(50);
    pace.hand(50);
    await sleep(60);
    intervals.armed[0]?.beat();

    expect(isLate).toBe(false);

    await sleep(60);
    intervals.armed[0]?.beat();

    expect(isLate).toBe(true);

    // nothing waiting, its check stops, and the next envelope starts from now
    const next = createSendPace(
      {
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
    intervals.armed[1]?.beat();

    expect(intervals.cleared).toContain(intervals.armed[1]);
  });

  test('holds none at a rate of 0, and its defaults are Kestrel’s, 240 bytes a second past 5 s', () => {
    using intervals = spyIntervals();
    const pace = createSendPace(
      {
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

    expect(intervals.armed).toEqual([]);
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

test.describe('lingerOn', () => {
  test('reads on once its answer is written, the destroy Node armed taken off, and destroys the socket once its client ends it', () => {
    const socket = createLingeringSocket();
    const response = new EventEmitter();

    lingerOn(socket, response);
    response.emit('finish');
    // its write side flushed: Node would destroy it now
    socket.emit('finish');

    expect(socket.destroyed).toBe(0);

    socket.emit('end');

    expect(socket.destroyed).toBe(1);
    socket.emit('close');
  });

  test('destroys a socket whose client never ends it after 2 s, on the platform’s clock', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];

    // the platform's own timer, read for its delay and fired at once
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);

      return realSetTimeout(callback, 0);
    }) as typeof globalThis.setTimeout;

    try {
      const socket = createLingeringSocket();
      const response = new EventEmitter();

      lingerOn(socket, response);
      response.emit('finish');
      await sleep(10);

      expect([delays, socket.destroyed]).toEqual([[2_000], 1]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
