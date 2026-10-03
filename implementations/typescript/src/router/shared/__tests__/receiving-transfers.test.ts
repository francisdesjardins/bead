import { expect, test } from '@playwright/test';
import { createTestClock, hasRef } from '../../../transport/shared/__tests__/fixtures';
import { LIMIT_DEFAULTS, ProtocolCode, SERVER_FAILURES } from '../constants';
import { createReceivingTransfers, type IReceiving } from '../receiving-transfers';
import { ChunkOutcome } from '../transfer';
import type { IProtocolFailure, IRouterLimits } from '../types';

// helpers

type Handle = 'a' | 'b';

/**
 * Receiving transfers under `limits`, chunks of a byte at least, on a test clock, which record each
 * credit they send.
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
      ].map((refused) => {
        return 'code' in refused ? [refused.code, refused.detail] : refused;
      })
    ).toEqual([
      [ProtocolCode.PAYLOAD_TOO_LARGE, 'a transfer declares its total, not 0'],
      [ProtocolCode.PAYLOAD_TOO_LARGE, 'a payload is 50 bytes at most, not 51'],
      [ProtocolCode.CHUNK_INVALID, 'an opening of 4 bytes holds its whole total of 4'],
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

  test('holds an opening to the last byte of its budget, and refuses one byte more', () => {
    const { receiving } = createReceiving({ bufferedBytesBudget: 64, maximumPayloadBytes: 64 });

    openedOf(
      receiving.open(new Uint8Array(60), { call: { callId: 1, connectionHandle: 'a' }, total: 64 })
    );

    expect(receiving.available).toBe(4);
    expect(
      receiving.open(new Uint8Array(5), { call: { callId: 3, connectionHandle: 'a' }, total: 64 })
    ).toMatchObject({
      code: ProtocolCode.CAPACITY_EXCEEDED,
      detail: 'the transfers received hold the budget but 4 bytes',
    });
    expect(
      'code' in
        receiving.open(new Uint8Array(4), { call: { callId: 3, connectionHandle: 'a' }, total: 64 })
    ).toBe(false);
    expect(receiving.available).toBe(0);
  });

  test('reserves what each credit it sends opens, within the budget left', () => {
    const { credits, receiving } = createReceiving({ bufferedBytesBudget: 100 });
    const opened = openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 1, connectionHandle: 'a' }, total: 40 })
    );

    receiving.grant(opened);
    // nothing came since: nothing more to grant
    receiving.grant(opened);

    expect(credits).toEqual(['a 1 20']);
    expect(receiving.available).toBe(80);
  });

  test('gives a transfer’s bytes back as its payload goes on whole, and all it holds once closed', () => {
    const { credits, receiving } = createReceiving({ bufferedBytesBudget: 100 });
    const opened = openedOf(
      receiving.open(Uint8Array.of(1, 2), { call: { callId: 1, connectionHandle: 'a' }, total: 4 })
    );

    receiving.grant(opened);

    expect(receiving.place(opened, { bytes: Uint8Array.of(3, 4), isLast: true, offset: 2 })).toBe(
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

    receiving.close(closed);
    receiving.grant(closed);

    expect(credits).toEqual(['a 1 4']);
    expect(receiving.available).toBe(100);
  });

  test('grants a transfer the budget starved once another gives its bytes back', () => {
    const { credits, receiving } = createReceiving({
      bufferedBytesBudget: 20,
      maximumPayloadBytes: 20,
    });
    const first = openedOf(
      receiving.open(new Uint8Array(4), { call: { callId: 1, connectionHandle: 'a' }, total: 20 })
    );

    receiving.grant(first);

    const second = openedOf(
      receiving.open(new Uint8Array(0), { call: { callId: 1, connectionHandle: 'b' }, total: 20 })
    );

    receiving.grant(second);

    expect(credits).toEqual(['a 1 20']);
    expect(receiving.available).toBe(0);

    receiving.close(first);

    expect(credits).toEqual(['a 1 20', 'b 1 16']);
    expect(receiving.available).toBe(4);
  });

  test('ends every transfer of a connection, or of every one, before it grants the budget given back', () => {
    const { credits, receiving } = createReceiving({
      bufferedBytesBudget: 28,
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

    const starved = open(1, 'b');

    receiving.grant(starved);

    expect(credits).toEqual(['a 1 20']);

    // the budget first gives back goes to 'b' alone: no credit goes to 'a' 3, which ends too
    receiving.closeAll('a');

    expect(credits).toEqual(['a 1 20', 'b 1 20']);
    expect(receiving.available).toBe(8);

    // its place came back: 'a' receives again
    open(5, 'a');
    receiving.closeAll();

    expect(receiving.available).toBe(28);
    expect(credits).toEqual(['a 1 20', 'b 1 20']);
  });

  test('stalls a transfer nothing comes for, its timer on its clock set going again by bytes placed alone', () => {
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

    clock.tick(100);
    receiving.grant(opened);
    receiving.place(opened, { bytes: Uint8Array.of(2), isLast: false, offset: 1 });
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

    clock.tick(249);

    expect(stalled).toEqual([]);

    clock.tick(1);

    expect(stalled).toEqual([1]);
  });

  test('stops a transfer’s timer once its payload is whole, and once it is closed', () => {
    const { clock, receiving } = createReceiving({ transferInactivityTimeout: 250 });
    const onStall = () => {
      return undefined;
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

    // the opening's, the one the last bytes set going, and the second transfer's: none left
    expect(clock.armed).toHaveLength(3);
    expect(
      clock.armed.every(({ handle }) => {
        return clock.cleared.includes(handle);
      })
    ).toBe(true);
    expect(clock.countTimers()).toBe(0);
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

  test('counts the transfers received and the bytes of the budget they hold, under its ceiling', () => {
    const { receiving } = createReceiving({ bufferedBytesBudget: 64 });
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const opened = openedOf(receiving.open(new Uint8Array(4), { call, total: 8 }));

    receiving.grant(opened);

    expect(receiving.gauges()).toEqual({
      anomalies: [],
      ceilings: { bufferedBytes: 64 },
      connectionHandles: new Set(['a']),
      counts: { bufferedBytes: 64 - receiving.available, receivingTransfers: 1 },
    });
    expect(receiving.available).toBeLessThan(64);

    receiving.closeAll();

    expect(receiving.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: { bufferedBytes: 0, receivingTransfers: 0 },
    });
  });
});
