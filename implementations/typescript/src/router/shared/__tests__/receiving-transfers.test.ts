import { expect, test } from '@playwright/test';
import { createTestClock, hasRef } from '../../../transport/shared/__tests__/fixtures';
import { LIMIT_DEFAULTS, ProtocolCode, SERVER_FAILURES } from '../constants';
import { budgetWaitOf, createReceivingTransfers, type IReceiving } from '../receiving-transfers';
import { ChunkOutcome } from '../transfer';
import type { ICallAddress, IProtocolFailure, IRouterLimits } from '../types';

// helpers

type Handle = 'a' | 'b';

/**
 * Receiving transfers under `limits`, chunks before the last of a byte, exactly, and the last of a
 * byte at most, on a test clock, which record each credit they send.
 */
const createReceiving = (limits: Partial<IRouterLimits> = {}) => {
  const clock = createTestClock();
  const credits: string[] = [];
  const receiving = createReceivingTransfers<Handle>({
    clock,
    failures: SERVER_FAILURES,
    limits: { ...LIMIT_DEFAULTS, windowBytes: 16, ...limits },
    payloadBytesPerChunk: 1,
    sendCredit: ({ callId, connectionHandle }, creditEnd) => {
      credits.push(`${connectionHandle} ${String(callId)} ${String(creditEnd)}`);
    },
  });

  return { clock, credits, receiving };
};

/** The transfer opened, failing the test when it is refused. */
const openedOf = (opened: IReceiving<Handle> | IProtocolFailure): IReceiving<Handle> => {
  if ('code' in opened) {
    throw new Error(opened.detail);
  }

  return opened;
};

// definition

test.describe('createReceivingTransfers', () => {
  test('refuses an opening by its own failure, and holds nothing of one refused', () => {
    const { receiving } = createReceiving({ bufferedBytesBudget: 64, maximumPayloadBytes: 50 });
    const call = { callId: 1, connectionHandle: 'a' } as const;

    expect(
      [
        receiving.open(new Uint8Array(1), { call, total: 0 }),
        receiving.open(new Uint8Array(1), { call, total: 51 }),
        receiving.open(new Uint8Array(4), { call, total: 4 }),
        receiving.open(new Uint8Array(2), { call, openingBytes: 3, total: 8 }),
      ].map((refused) => {
        return 'code' in refused ? [refused.code, refused.detail] : refused;
      })
    ).toEqual([
      [ProtocolCode.PAYLOAD_TOO_LARGE, 'a transfer declares its total, not 0'],
      [ProtocolCode.PAYLOAD_TOO_LARGE, 'a payload is 50 bytes at most, not 51'],
      [ProtocolCode.CHUNK_INVALID, 'an opening of 4 bytes holds its whole total of 4'],
      [ProtocolCode.CHUNK_INVALID, 'an opening carries 3 bytes of its payload, not 2'],
    ]);
    expect(receiving.available).toBe(64);

    const none = createReceiving({ maximumTransfers: 0 }).receiving;

    expect(none.open(new Uint8Array(1), { call, total: 8 })).toMatchObject({
      code: ProtocolCode.PAYLOAD_TOO_LARGE,
      detail: 'this peer takes no transfer',
    });
  });

  test('takes as many transfers on a connection as it may, and one on another all the same', () => {
    const { receiving } = createReceiving({ maximumTransfers: 2 });
    const open = (callId: number, connectionHandle: Handle) => {
      return receiving.open(new Uint8Array(1), { call: { callId, connectionHandle }, total: 8 });
    };
    const first = openedOf(open(1, 'a'));

    openedOf(open(3, 'a'));

    expect(open(5, 'a')).toMatchObject({ code: ProtocolCode.CAPACITY_EXCEEDED });
    expect('code' in open(1, 'b')).toBe(false);

    // its place comes back once closed, and not before
    receiving.complete(first);

    expect(open(5, 'a')).toMatchObject({ code: ProtocolCode.CAPACITY_EXCEEDED });

    receiving.close(first);

    expect('code' in open(5, 'a')).toBe(false);
  });

  test('admits an opening whose total the budget left holds to its last byte, and has one a byte past it wait', () => {
    const { credits, receiving } = createReceiving({
      bufferedBytesBudget: 64,
      maximumPayloadBytes: 64,
    });

    openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 1, connectionHandle: 'a' }, total: 40 })
    );

    expect(receiving.available).toBe(24);

    // a byte past the budget left: it waits, holding none of it, and is granted nothing
    const past = openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 3, connectionHandle: 'a' }, total: 25 })
    );

    receiving.grant(past);

    expect(credits).toEqual([]);
    expect(receiving.available).toBe(24);
    expect(receiving.gauges().counts).toMatchObject({ waitingTransfers: 1 });

    receiving.close(past);
    openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 5, connectionHandle: 'a' }, total: 24 })
    );

    expect(receiving.available).toBe(0);
    expect(receiving.gauges().counts).toMatchObject({ waitingTransfers: 0 });
  });

  test('reserves a transfer’s whole total as it admits it, and nothing more as it credits it', () => {
    const { credits, receiving } = createReceiving({ bufferedBytesBudget: 100 });
    const opened = openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 1, connectionHandle: 'a' }, total: 40 })
    );

    expect(receiving.available).toBe(60);

    receiving.grant(opened);
    // nothing came since: nothing more to grant
    receiving.grant(opened);

    for (let offset = 4; offset < 12; offset += 1) {
      receiving.place(opened, { bytes: Uint8Array.of(offset), isLast: false, offset });
    }

    receiving.grant(opened);

    expect(credits).toEqual(['a 1 20', 'a 1 28']);
    expect(receiving.available).toBe(60);
  });

  test('gives a transfer’s bytes back as its payload goes on whole, and all it holds once closed', () => {
    const { credits, receiving } = createReceiving({ bufferedBytesBudget: 100 });
    const opened = openedOf(
      receiving.open(Uint8Array.of(1, 2), { call: { callId: 1, connectionHandle: 'a' }, total: 4 })
    );

    expect(receiving.available).toBe(96);

    receiving.grant(opened);

    expect(receiving.place(opened, { bytes: Uint8Array.of(3), isLast: false, offset: 2 })).toBe(
      ChunkOutcome.PLACED
    );
    expect(receiving.place(opened, { bytes: Uint8Array.of(4), isLast: true, offset: 3 })).toBe(
      ChunkOutcome.COMPLETE
    );
    expect(receiving.complete(opened)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(receiving.available).toBe(100);

    // closed twice, it gives nothing back twice
    receiving.close(opened);
    receiving.close(opened);

    expect(receiving.available).toBe(100);

    // a transfer closed grants nothing, though it has credit to grant still
    const closed = openedOf(
      receiving.open(Uint8Array.of(1), { call: { callId: 3, connectionHandle: 'a' }, total: 40 })
    );

    expect(receiving.available).toBe(60);

    receiving.close(closed);
    receiving.grant(closed);

    expect(credits).toEqual(['a 1 4']);
    expect(receiving.available).toBe(100);
  });

  test('admits the openings that wait in the order they opened, one that fits waiting behind one before it', () => {
    const { credits, receiving } = createReceiving({
      bufferedBytesBudget: 60,
      maximumPayloadBytes: 60,
    });
    const open = (call: ICallAddress<Handle>, total: number) => {
      return openedOf(receiving.open(new Uint8Array(1), { call, total }));
    };
    const first = open({ callId: 1, connectionHandle: 'a' }, 40);

    // 'b' 1 waits for 30 bytes, and 'b' 3 behind it, though the 20 left hold it to its last byte
    open({ callId: 1, connectionHandle: 'b' }, 30);

    const third = open({ callId: 3, connectionHandle: 'b' }, 20);

    expect(credits).toEqual([]);
    expect(receiving.available).toBe(20);

    // the budget given back admits both, in the order they opened, each credited as it is
    receiving.close(first);

    expect(credits).toEqual(['b 1 17', 'b 3 17']);
    expect(receiving.available).toBe(10);

    // the 10 left hold 'a' 5, which waits behind 'a' 3 all the same
    open({ callId: 3, connectionHandle: 'a' }, 20);
    open({ callId: 5, connectionHandle: 'a' }, 5);

    expect(credits).toHaveLength(2);

    receiving.close(third);

    expect(credits).toEqual(['b 1 17', 'b 3 17', 'a 3 17', 'a 5 5']);
    expect(receiving.available).toBe(5);
    expect(receiving.gauges().counts).toMatchObject({ waitingTransfers: 0 });
  });

  test('ends every transfer of a connection, or of every one, waiting or admitted, before it admits an opening the budget given back holds', () => {
    const { credits, receiving } = createReceiving({
      bufferedBytesBudget: 48,
      maximumPayloadBytes: 24,
    });
    const open = (callId: number, connectionHandle: Handle) => {
      return openedOf(
        receiving.open(new Uint8Array(4), { call: { callId, connectionHandle }, total: 24 })
      );
    };
    const first = open(1, 'a');

    receiving.grant(first);
    open(3, 'a');

    // 'b' 1 waits, and 'a' 5 behind it
    open(1, 'b');
    open(5, 'a');

    expect(credits).toEqual(['a 1 20']);
    expect(receiving.gauges().counts).toMatchObject({ waitingTransfers: 2 });

    // the budget given back admits 'b' alone: 'a' 5, which waited before it, ends too
    receiving.closeAll('a');

    expect(credits).toEqual(['a 1 20', 'b 1 20']);
    expect(receiving.available).toBe(24);
    expect(receiving.gauges().counts).toMatchObject({ waitingTransfers: 0 });

    // its place came back: 'a' receives again
    open(7, 'a');
    receiving.closeAll();

    expect(receiving.available).toBe(48);
    expect(credits).toEqual(['a 1 20', 'b 1 20']);
  });

  test('refuses an opening still waiting at half the inactivity allowed, CAPACITY_EXCEEDED, and admits the one behind it', () => {
    expect(
      [30_000, 3, 1].map((transferInactivityTimeout) => {
        return budgetWaitOf({ transferInactivityTimeout });
      })
    ).toEqual([15_000, 1, 0]);

    const { clock, credits, receiving } = createReceiving({
      bufferedBytesBudget: 48,
      maximumPayloadBytes: 48,
      transferInactivityTimeout: 250,
    });
    const refused: IProtocolFailure[] = [];
    const open = (callId: number, total: number) => {
      return openedOf(
        receiving.open(new Uint8Array(1), {
          call: { callId, connectionHandle: 'a' },
          onRefused: (failure) => {
            refused.push(failure);
          },
          total,
        })
      );
    };

    open(1, 40);
    open(3, 24);
    clock.tick(60);
    // 'a' 5 fits the 8 bytes left, and waits behind 'a' 3, its own wait counted from its opening
    open(5, 8);
    clock.tick(64);

    expect(refused).toEqual([]);

    clock.tick(1);

    expect(refused).toEqual([
      {
        ...SERVER_FAILURES.capacityExceeded,
        detail: 'a total of 24 bytes waited 125 milliseconds for the budget',
      },
    ]);
    expect(credits).toEqual(['a 5 8']);
    expect(receiving.gauges().counts).toMatchObject({ receivingTransfers: 2, waitingTransfers: 0 });

    // a wait of 0 refuses at once an opening that would wait, and holds nothing of it
    const once = createReceiving({
      bufferedBytesBudget: 8,
      transferInactivityTimeout: 1,
    }).receiving;

    openedOf(
      once.open(new Uint8Array(1), { call: { callId: 1, connectionHandle: 'a' }, total: 8 })
    );

    expect(
      once.open(new Uint8Array(1), { call: { callId: 3, connectionHandle: 'a' }, total: 8 })
    ).toEqual({
      ...SERVER_FAILURES.capacityExceeded,
      detail: 'a total of 8 bytes waited 0 milliseconds for the budget',
    });
    expect(once.gauges().counts).toMatchObject({ receivingTransfers: 1, waitingTransfers: 0 });
  });

  test('sets a transfer’s timer going as it admits it, never while it waits', () => {
    const { clock, credits, receiving } = createReceiving({
      bufferedBytesBudget: 16,
      transferInactivityTimeout: 250,
    });
    const stalled: number[] = [];
    const refused: IProtocolFailure[] = [];
    const open = (callId: number, total: number) => {
      return openedOf(
        receiving.open(new Uint8Array(1), {
          call: { callId, connectionHandle: 'a' },
          onAdmitted: () => {
            credits.push(`admitted ${String(callId)}`);
          },
          onRefused: (failure) => {
            refused.push(failure);
          },
          onStall: () => {
            stalled.push(callId);
          },
          total,
        })
      );
    };
    const first = open(1, 16);

    open(3, 8);

    // the first's inactivity, and the second's wait for the budget: no inactivity of its own
    expect(
      clock.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([250, 125]);

    clock.tick(100);
    receiving.close(first);

    // admitted, its wait stopped, its inactivity set going, then its first credit sent
    expect(credits).toEqual(['admitted 3', 'a 3 8']);
    expect(clock.cleared).toContain(clock.armed[1]?.handle);
    expect(clock.armed.at(-1)?.delay).toBe(250);
    expect(clock.countTimers()).toBe(1);

    clock.tick(249);

    expect([stalled, refused]).toEqual([[], []]);

    clock.tick(1);

    expect([stalled, refused]).toEqual([[3], []]);
  });

  test('stalls a transfer nothing comes for, its timer set going again by bytes placed alone', () => {
    for (const [progressAt, duplicateAfter] of [
      [100, 0],
      [200, 100],
    ] as const) {
      const { clock, receiving } = createReceiving({ transferInactivityTimeout: 250 });
      const stalled: number[] = [];
      const opened = openedOf(
        receiving.open(new Uint8Array(1), {
          call: { callId: 1, connectionHandle: 'a' },
          onStall: () => {
            stalled.push(1);
          },
          total: 8,
        })
      );

      clock.tick(progressAt);
      receiving.grant(opened);
      receiving.place(opened, { bytes: Uint8Array.of(2), isLast: false, offset: 1 });
      clock.tick(duplicateAfter);
      // a duplicate is no progress
      receiving.place(opened, { bytes: Uint8Array.of(2), isLast: false, offset: 1 });

      // without `onStall`, no timer
      openedOf(
        receiving.open(new Uint8Array(1), { call: { callId: 3, connectionHandle: 'a' }, total: 8 })
      );

      expect(
        clock.armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([250, 250]);
      // the stall counts from the last bytes placed, not from the opening
      expect(clock.cleared).toContain(clock.armed[0]?.handle);
      expect(clock.cleared).not.toContain(clock.armed[1]?.handle);

      clock.tick(249 - duplicateAfter);

      expect(stalled).toEqual([]);

      clock.tick(1);

      expect(stalled).toEqual([1]);
    }
  });

  test('stops a transfer’s timer once its payload is whole, and once it is closed', () => {
    const { clock, receiving } = createReceiving({ transferInactivityTimeout: 250 });
    let stalled = 0;
    const onStall = () => {
      stalled += 1;
    };
    const whole = openedOf(
      receiving.open(Uint8Array.of(1), {
        call: { callId: 1, connectionHandle: 'a' },
        onStall,
        total: 2,
      })
    );

    receiving.grant(whole);
    receiving.place(whole, { bytes: Uint8Array.of(2), isLast: true, offset: 1 });

    // the chunk that made it whole stopped its timer, and set none going
    expect(clock.armed).toHaveLength(1);
    expect(clock.cleared).toContain(clock.armed[0]?.handle);
    expect(clock.countTimers()).toBe(0);

    receiving.complete(whole);
    receiving.close(
      openedOf(
        receiving.open(Uint8Array.of(1), {
          call: { callId: 3, connectionHandle: 'a' },
          onStall,
          total: 2,
        })
      )
    );

    // the opening's and the second transfer's: none left
    expect(clock.armed).toHaveLength(2);
    expect(
      clock.armed.every(({ handle }) => {
        return clock.cleared.includes(handle);
      })
    ).toBe(true);
    expect(clock.countTimers()).toBe(0);
    clock.tick(1_000);
    expect(stalled).toBe(0);
  });

  test('keeps no process alive for a transfer’s timer', () => {
    const { clock, receiving } = createReceiving();
    const opened = openedOf(
      receiving.open(new Uint8Array(1), {
        call: { callId: 1, connectionHandle: 'a' },
        onStall: () => {
          return undefined;
        },
        total: 8,
      })
    );

    expect(
      clock.armed.map(({ handle }) => {
        return hasRef(handle);
      })
    ).toEqual([false]);

    receiving.close(opened);
  });

  test('counts the transfers received and those waiting, the bytes of the budget they reserve under its ceiling, and the bytes they hold', () => {
    const { receiving } = createReceiving({ bufferedBytesBudget: 64 });
    const opened = openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 1, connectionHandle: 'a' }, total: 40 })
    );

    receiving.grant(opened);
    receiving.place(opened, { bytes: Uint8Array.of(4), isLast: false, offset: 4 });
    // a duplicate holds nothing more
    receiving.place(opened, { bytes: Uint8Array.of(4), isLast: false, offset: 4 });
    // past the 24 bytes left: it waits, its opening's bytes held all the same
    openedOf(
      receiving.open(new Uint8Array(2), { call: { callId: 1, connectionHandle: 'b' }, total: 30 })
    );

    expect(receiving.gauges()).toEqual({
      anomalies: [],
      ceilings: { reservedBytes: 64 },
      connectionHandles: new Set(['a', 'b']),
      counts: {
        bufferedBytes: 7,
        outlivingTransfers: 0,
        receivingTransfers: 2,
        reservedBytes: 40,
        waitingTransfers: 1,
      },
    });

    receiving.closeAll();

    expect(receiving.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: {
        bufferedBytes: 0,
        outlivingTransfers: 0,
        receivingTransfers: 0,
        reservedBytes: 0,
        waitingTransfers: 0,
      },
    });
  });

  test('holds a received transfer’s place while its call’s resolver outlives the call, among twice maximumTransfers, and gives it back as that resolver settles', () => {
    const { receiving } = createReceiving({ bufferedBytesBudget: 64, maximumTransfers: 1 });
    const open = (callId: number, connectionHandle: Handle = 'a') => {
      return receiving.open(new Uint8Array(1), { call: { callId, connectionHandle }, total: 2 });
    };
    const whole = (opened: IReceiving<Handle>): IReceiving<Handle> => {
      receiving.grant(opened);
      receiving.place(opened, { bytes: new Uint8Array(1), isLast: true, offset: 1 });
      receiving.complete(opened);

      return opened;
    };
    const first = whole(openedOf(open(1)));

    // its call ends while its resolver runs on: its bytes go back, its place among the transfers
    // the connection receives too, but not among those and the ones its resolvers outlive
    receiving.outlive(first);

    expect(receiving.gauges()).toMatchObject({
      connectionHandles: new Set(['a']),
      counts: { bufferedBytes: 0, outlivingTransfers: 1, receivingTransfers: 0 },
    });

    const second = openedOf(open(3));

    // * past maximumTransfers first, then past twice as many with those its resolvers outlive,
    // checked first, its detail its own; another connection's are its own
    expect(open(5)).toMatchObject({
      code: ProtocolCode.CAPACITY_EXCEEDED,
      detail: 'the transfers a connection receives and those its resolvers outlive are 2 at most',
    });

    receiving.outlive(whole(second));

    expect(open(5)).toMatchObject({
      code: ProtocolCode.CAPACITY_EXCEEDED,
      detail: 'the transfers a connection receives and those its resolvers outlive are 2 at most',
    });
    expect(receiving.gauges().counts).toMatchObject({ outlivingTransfers: 2 });
    openedOf(open(1, 'b'));

    // the resolver settles: its place goes back, once, and the next opening is taken
    receiving.settle(first);
    receiving.settle(first);

    expect(receiving.gauges().counts).toMatchObject({ outlivingTransfers: 1 });

    const third = openedOf(open(5));

    expect(open(7)).toMatchObject({
      code: ProtocolCode.CAPACITY_EXCEEDED,
      detail: 'the transfers a connection receives and those its resolvers outlive are 2 at most',
    });

    receiving.settle(second);

    expect(open(7)).toMatchObject({
      code: ProtocolCode.CAPACITY_EXCEEDED,
      detail: 'the transfers a connection receives at once are 1 at most',
    });

    // its connection closes: the places its resolvers outlive end with it, and settle to nothing
    receiving.outlive(third);
    receiving.closeAll('a');

    expect(receiving.gauges()).toMatchObject({
      connectionHandles: new Set(['b']),
      counts: { outlivingTransfers: 0, receivingTransfers: 1 },
    });

    receiving.settle(third);
    openedOf(open(9));
  });
});
