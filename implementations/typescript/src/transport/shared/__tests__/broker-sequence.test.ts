// dependencies

import { expect, test } from '@playwright/test';
import { CloseCode } from '../broker-parcel';
import {
  createBrokerParts,
  createBrokerSequence,
  createHeldBytes,
  gapOf,
  type IBrokerLoss,
  partsOf,
  SEQUENCE_VERDICTS,
} from '../broker-sequence';
import { GenericError } from '../errors';
import { createTestClock, duesOn } from './fixtures';

// helpers

const bytesOf = (length: number, byte = 0x78): Uint8Array => {
  return new Uint8Array(length).fill(byte);
};

// definition

test.describe('broker sequence', () => {
  test('hands parcels on in their order once each, drops a copy, and loses the connection at a gap', () => {
    const sequence = createBrokerSequence(2);

    expect(
      [2, 3, 3, 2, 4].map((each) => {
        return sequence.take(each);
      })
    ).toEqual([
      SEQUENCE_VERDICTS.NEXT,
      SEQUENCE_VERDICTS.NEXT,
      SEQUENCE_VERDICTS.COPY,
      SEQUENCE_VERDICTS.COPY,
      SEQUENCE_VERDICTS.NEXT,
    ]);
    expect(sequence.awaited).toBe(5);

    // * past the next one awaited is a loss, and nothing is held for it: the gap never fills
    expect(sequence.take(7)).toBe(SEQUENCE_VERDICTS.LOSS);
    expect(sequence.awaited).toBe(5);
    expect(gapOf({ awaited: 5, came: 7 })).toEqual({
      code: CloseCode.LOST,
      reason: 'a parcel lost: 5 was awaited, and 7 came',
    });

    // from 1 by default
    expect(createBrokerSequence().take(1)).toBe(SEQUENCE_VERDICTS.NEXT);
  });

  test('reassembles an envelope from its parts, and loses the connection past its bound, its budget or its rate', async () => {
    const clock = createTestClock();
    const held = createHeldBytes(100);
    const slowed: IBrokerLoss[] = [];
    const bounds = {
      bodyGracePeriod: 5_000,
      clock,
      maximumEnvelopePartsBytes: 64,
      minimumBodyBytesPerSecond: 240,
    };
    const slow = (loss: IBrokerLoss): void => {
      slowed.push(loss);
    };
    const parts = createBrokerParts({ held, slow }, bounds);

    // a DATA that is no part is handed on as it came, held nowhere
    expect(parts.add(bytesOf(3), { credential: 'Bearer x', isLast: true })).toEqual({
      credential: 'Bearer x',
      envelope: bytesOf(3),
    });
    expect(held.held).toBe(0);

    // * the credential of its first part, the envelope once its last came, its budget given back
    expect(parts.add(bytesOf(10, 1), { credential: 'Bearer y', isLast: false })).toEqual({
      held: true,
    });
    expect(held.held).toBe(10);
    expect(duesOn(clock)).toEqual([5_000]);
    expect(parts.add(bytesOf(5, 2), { isLast: false })).toEqual({ held: true });
    expect(parts.add(bytesOf(1, 3), { isLast: true })).toEqual({
      credential: 'Bearer y',
      envelope: Uint8Array.from([...bytesOf(10, 1), ...bytesOf(5, 2), 3]),
    });
    expect({ bytes: parts.bytes, held: held.held, largest: held.largest }).toEqual({
      bytes: 0,
      held: 0,
      largest: 16,
    });
    expect(duesOn(clock)).toEqual([]);

    // past its bound: 1009, naming it
    parts.add(bytesOf(60), { isLast: false });
    expect(parts.add(bytesOf(5), { isLast: false })).toEqual({
      lost: {
        code: CloseCode.TOO_BIG,
        reason: "an envelope's parts past its maximumEnvelopePartsBytes, 64 bytes",
      },
    });
    expect(held.held).toBe(0);

    // past its participant's budget, which another connection's parts share: 4000, naming it
    const other = createBrokerParts({ held, slow }, bounds);

    other.add(bytesOf(60), { isLast: false });
    expect(parts.add(bytesOf(50), { isLast: false })).toEqual({
      lost: {
        code: CloseCode.LOST,
        reason: "parts past its participant's heldBytesBudget, 100 bytes",
      },
    });
    expect(held.held).toBe(60);
    other.stop();
    expect(held.held).toBe(0);

    // slower than its rate once its grace passed, on the clock given: 4000, naming it
    parts.add(bytesOf(10), { isLast: false });
    await clock.tickAsync(4_999);
    expect(slowed).toEqual([]);
    await clock.tickAsync(1);
    expect(slowed).toEqual([
      {
        code: CloseCode.LOST,
        reason:
          'parts came slower than minimumBodyBytesPerSecond, 240 bytes a second, past bodyGracePeriod, 5000 ms',
      },
    ]);
    expect(held.held).toBe(0);
  });

  test('cuts an envelope in parts each as large as the peer’s bound lets it, the credential on the first alone', () => {
    const envelope = bytesOf(1_510);

    expect(
      partsOf(envelope, { credentialBytes: 0, room: 1_024 }).map(({ length }) => {
        return length;
      })
    ).toEqual([996, 514]);
    expect(
      partsOf(envelope, { credentialBytes: 15, room: 1_024 }).map(({ length }) => {
        return length;
      })
    ).toEqual([979, 531]);
    expect(partsOf(envelope, { credentialBytes: 0, room: 4_096 })).toEqual([envelope]);
    expect(() => {
      return partsOf(envelope, { credentialBytes: 1_000, room: 1_024 });
    }).toThrow(GenericError);
  });
});
