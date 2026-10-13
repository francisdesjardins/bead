import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  EnvelopeKind,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { writeEnvelope } from '../envelope';
import { headerBytesOf } from '../header';
import {
  ChunkOutcome,
  chunkPayloadBytes,
  createIncomingTransfer,
  createOutgoingTransfer,
  type IIncomingTransfer,
} from '../transfer';
import type { EnvelopeHeader, IProtocolFailure, SessionToken } from '../types';

// helpers

/** The hexadecimal of `bytes`, spaced by byte. */
const hexadecimalOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0').toUpperCase();
    })
    .join(' ');
};

/** `length` bytes that differ from one to the next, so a byte out of place shows. */
const patternOf = (length: number): Uint8Array => {
  return Uint8Array.from({ length }, (_, index) => {
    return (index * 7 + (index >> 8)) % 251;
  });
};

// a chunk's header, as long as any: the prefix and its offset
const CHUNK_HEADER_BYTES = headerBytesOf({
  callId: 1,
  isLast: true,
  kind: EnvelopeKind.CHUNK,
  offset: 0,
});

/**
 * A transfer received, from `opening`, failing the test when it does not open; its chunks before the
 * last carry a byte, exactly, unless `payloadBytesPerChunk` says more.
 */
const incomingOf = (
  opening: Uint8Array,
  {
    maximumChunkRuns = LIMIT_DEFAULTS.maximumChunkRuns,
    payloadBytesPerChunk = 1,
    total,
    windowBytes = 8,
  }: {
    maximumChunkRuns?: number;
    payloadBytesPerChunk?: number;
    total: number;
    windowBytes?: number;
  }
): IIncomingTransfer => {
  const transfer = createIncomingTransfer(opening, {
    failures: SERVER_FAILURES,
    limits: { maximumChunkRuns, windowBytes },
    payloadBytesPerChunk,
    total,
  });

  if ('code' in transfer) {
    throw new Error(transfer.detail);
  }

  return transfer;
};

/** The code of a failure a placement gave, or its outcome. */
const codeOf = (outcome: ChunkOutcome | IProtocolFailure): number | string => {
  return typeof outcome === 'string' ? outcome : outcome.code;
};

// definition

test.describe('chunkPayloadBytes', () => {
  test('is what an envelope of the chunk size holds past its header, an envelope at most', () => {
    const limits = { chunkBytes: 1_048_576, maximumEnvelopeBytes: 16_778_240 };

    expect(CHUNK_HEADER_BYTES).toBe(16);
    expect(chunkPayloadBytes(limits, CHUNK_HEADER_BYTES)).toBe(1_048_560);
    expect(chunkPayloadBytes({ ...limits, chunkBytes: 1_024 }, CHUNK_HEADER_BYTES)).toBe(1_008);
    // an opening: a request, without and with a destination, and a result announcing a session
    const openings = (
      [
        { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 1, total: 0 },
        {
          callId: 1,
          destinationId: 1,
          kind: EnvelopeKind.REQUEST,
          procedureId: 1,
          serviceId: 1,
          total: 0,
        },
        {
          callId: 2,
          credential: {
            scheme: CredentialScheme.OPAQUE,
            token: 'AAECAwQFBgcICQoLDA0ODw' as SessionToken,
          },
          kind: EnvelopeKind.RESULT,
          total: 0,
        },
      ] satisfies EnvelopeHeader[]
    ).map((header) => {
      return headerBytesOf(header);
    });

    expect(openings).toEqual([20, 24, 36]);
    expect(
      openings.map((bytes) => {
        return chunkPayloadBytes(limits, bytes);
      })
    ).toEqual([1_048_556, 1_048_552, 1_048_540]);
    expect(chunkPayloadBytes({ chunkBytes: 4_096, maximumEnvelopeBytes: 1_024 }, 16)).toBe(1_008);
  });
});

test.describe('createOutgoingTransfer', () => {
  // spec 12.11
  test('lays the plan’s 20 MiB out byte by byte: its opening, a credit, a chunk with more, the last', () => {
    const total = 20_971_520;
    const payload = patternOf(total);
    const openingHeader = {
      callId: 7,
      kind: EnvelopeKind.REQUEST,
      procedureId: 5,
      serviceId: 2,
      total,
    } as const;
    const openingBytes = chunkPayloadBytes(LIMIT_DEFAULTS, headerBytesOf(openingHeader));
    const outgoing = createOutgoingTransfer(payload, {
      openingBytes,
      payloadBytesPerChunk: chunkPayloadBytes(LIMIT_DEFAULTS, CHUNK_HEADER_BYTES),
    });
    const incoming = incomingOf(outgoing.opening, {
      total,
      windowBytes: LIMIT_DEFAULTS.windowBytes,
    });
    const opening = writeEnvelope({
      header: openingHeader,
      kind: EnvelopeKind.REQUEST,
      payload: outgoing.opening,
    });

    expect(opening).toHaveLength(1_048_576);
    expect(hexadecimalOf(opening.subarray(0, 20))).toBe(
      'A1 10 04 05 00 00 00 07 00 02 00 05 00 00 00 00 01 40 00 00'
    );

    const creditEnd = incoming.creditToGrant(Number.MAX_SAFE_INTEGER) ?? 0;

    expect(creditEnd).toBe(5_242_860);
    expect(
      hexadecimalOf(
        writeEnvelope({
          header: { callId: 7, creditEnd, kind: EnvelopeKind.CREDIT },
          kind: EnvelopeKind.CREDIT,
        })
      )
    ).toBe('A1 15 00 04 00 00 00 07 00 00 00 00 00 4F FF EC');

    outgoing.grant(creditEnd);

    const offsets: number[] = [];
    let chunk = outgoing.nextChunk();
    const first = chunk;

    while (chunk !== undefined) {
      offsets.push(chunk.offset);
      chunk = outgoing.nextChunk();
    }

    // four full chunks under the credit; the fifth would pass it, so it waits
    expect(offsets).toEqual([1_048_556, 2_097_116, 3_145_676, 4_194_236]);
    expect(
      hexadecimalOf(
        writeEnvelope({
          header: {
            callId: 7,
            isLast: false,
            kind: EnvelopeKind.CHUNK,
            offset: first?.offset ?? 0,
          },
          kind: EnvelopeKind.CHUNK,
          payload: first?.bytes ?? new Uint8Array(1),
        }).subarray(0, 16)
      )
    ).toBe('A1 14 40 04 00 00 00 07 00 00 00 00 00 0F FF EC');

    outgoing.grant(total);

    let last = outgoing.nextChunk();
    let count = 4;

    while (last?.isLast === false) {
      count += 1;
      last = outgoing.nextChunk();
    }

    // 19 full chunks after the opening, then 324 bytes
    expect(count).toBe(19);
    expect(last).toMatchObject({ isLast: true, offset: 20_971_196 });
    expect(last?.bytes).toHaveLength(324);
    expect(
      hexadecimalOf(
        writeEnvelope({
          header: { callId: 7, isLast: true, kind: EnvelopeKind.CHUNK, offset: 20_971_196 },
          kind: EnvelopeKind.CHUNK,
          payload: last?.bytes ?? new Uint8Array(1),
        }).subarray(0, 16)
      )
    ).toBe('A1 14 00 04 00 00 00 07 00 00 00 00 01 3F FE BC');
    expect(outgoing.isComplete).toBe(true);
    expect(outgoing.nextChunk()).toBeUndefined();
  });

  test('sends no small chunk: a full one, or the last, and waits for the credit either needs', () => {
    const outgoing = createOutgoingTransfer(patternOf(25), {
      openingBytes: 4,
      payloadBytesPerChunk: 6,
    });

    expect(outgoing.opening).toEqual(patternOf(25).subarray(0, 4));
    expect([outgoing.creditEnd, outgoing.total, outgoing.isComplete]).toEqual([4, 25, false]);
    expect(outgoing.nextChunk()).toBeUndefined();

    // 5 bytes of credit: a full chunk of 6 does not fit
    outgoing.grant(9);

    expect(outgoing.nextChunk()).toBeUndefined();

    outgoing.grant(10);

    expect(outgoing.nextChunk()).toMatchObject({ isLast: false, offset: 4 });
    expect(outgoing.nextChunk()).toBeUndefined();

    outgoing.grant(100);

    const sizes: number[] = [];

    for (let chunk = outgoing.nextChunk(); chunk !== undefined; chunk = outgoing.nextChunk()) {
      sizes.push(chunk.bytes.length);
    }

    // ⌈15 ÷ 6⌉ chunks for what is left, the last one short
    expect(sizes).toEqual([6, 6, 3]);
    expect(outgoing.isComplete).toBe(true);
  });

  test('keeps the highest credit, the total at most: a credit late or repeated grants nothing', () => {
    const outgoing = createOutgoingTransfer(patternOf(20), {
      openingBytes: 2,
      payloadBytesPerChunk: 4,
    });

    outgoing.grant(14);
    outgoing.grant(6);

    expect(outgoing.creditEnd).toBe(14);

    outgoing.grant(14);

    expect(outgoing.creditEnd).toBe(14);

    outgoing.grant(1_000);

    expect(outgoing.creditEnd).toBe(20);
  });
});

test.describe('createIncomingTransfer', () => {
  test('refuses an opening that holds its whole total, and one without a byte of its payload', () => {
    for (const opening of [patternOf(4), new Uint8Array(0)]) {
      const refused = createIncomingTransfer(opening, {
        failures: SERVER_FAILURES,
        limits: { maximumChunkRuns: 4, windowBytes: 8 },
        payloadBytesPerChunk: 1,
        total: 4,
      });

      expect(refused, String(opening.length)).toMatchObject({
        code: ProtocolCode.CHUNK_INVALID,
        side: 'server',
      });
    }

    expect(incomingOf(patternOf(1), { total: 4 })).toMatchObject({
      contiguous: 1,
      creditEnd: 1,
      total: 4,
    });
  });

  test('checks a chunk in order: its bounds, its bytes, its last, then its credit, then whether it came', () => {
    const incoming = incomingOf(patternOf(2), { payloadBytesPerChunk: 2, total: 10 });

    // past the total, even without credit, then without a byte, then with a last that lies
    expect(codeOf(incoming.place(patternOf(3), { isLast: true, offset: 10 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
    expect(codeOf(incoming.place(patternOf(9), { isLast: true, offset: 2 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
    expect(codeOf(incoming.place(new Uint8Array(0), { isLast: false, offset: 5 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
    expect(codeOf(incoming.place(patternOf(3), { isLast: true, offset: 2 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
    expect(codeOf(incoming.place(patternOf(8), { isLast: false, offset: 2 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
    // within the total, past the credit of the opening's 2 bytes
    expect(codeOf(incoming.place(patternOf(2), { isLast: false, offset: 2 }))).toBe(
      ProtocolCode.CREDIT_EXCEEDED
    );
    // what came already comes as a duplicate
    expect(codeOf(incoming.place(patternOf(2), { isLast: false, offset: 0 }))).toBe(
      ChunkOutcome.DUPLICATE
    );
  });

  test('joins the whole out of order, once, and gives the same whole when asked again', () => {
    const whole = patternOf(28);
    const incoming = incomingOf(whole.subarray(0, 4), {
      payloadBytesPerChunk: 5,
      total: 28,
      windowBytes: 60,
    });

    incoming.creditToGrant(Number.MAX_SAFE_INTEGER);

    expect(
      [19, 9, 24, 4, 14].map((offset) => {
        return incoming.place(whole.slice(offset, offset + 5), {
          isLast: offset + 5 >= 28,
          offset,
        });
      })
    ).toEqual([
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.COMPLETE,
    ]);
    expect(incoming.contiguous).toBe(28);

    const joined = incoming.payload();

    expect(joined).toEqual(whole);
    expect(incoming.payload()).toBe(joined);
  });

  test('refuses a chunk before the last that is not full, and one over bytes received in part', () => {
    const whole = patternOf(19);
    const incoming = incomingOf(whole.subarray(0, 4), {
      payloadBytesPerChunk: 4,
      total: 19,
      windowBytes: 40,
    });
    const place = (offset: number, length: number) => {
      return codeOf(
        incoming.place(whole.slice(offset, offset + length), {
          isLast: offset + length === 19,
          offset,
        })
      );
    };

    incoming.creditToGrant(Number.MAX_SAFE_INTEGER);

    expect([
      // 3 bytes, though more follow
      place(4, 3),
      place(8, 4),
      // over the opening, then over the chunk at 8, each in part
      place(2, 4),
      place(6, 4),
      // received whole already, the opening's bytes too: a duplicate
      place(8, 4),
      place(0, 4),
      // the last carries what is left, however little
      place(16, 3),
      place(4, 4),
      place(12, 4),
    ]).toEqual([
      ProtocolCode.CHUNK_INVALID,
      ChunkOutcome.PLACED,
      ProtocolCode.CHUNK_INVALID,
      ProtocolCode.CHUNK_INVALID,
      ChunkOutcome.DUPLICATE,
      ChunkOutcome.DUPLICATE,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.COMPLETE,
    ]);
    expect(incoming.payload()).toEqual(whole);
  });

  test('refuses a chunk past full, before the last or the last, CHUNK_INVALID, and places a full one and a last one full at most', () => {
    const whole = patternOf(16);
    const incoming = incomingOf(whole.subarray(0, 4), {
      payloadBytesPerChunk: 4,
      total: 16,
      windowBytes: 40,
    });
    const place = (offset: number, length: number) => {
      return incoming.place(whole.slice(offset, offset + length), {
        isLast: offset + length === 16,
        offset,
      });
    };

    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBe(16);
    // a byte past full, before the last and as the last, though it reaches the total
    expect(place(4, 5)).toMatchObject({
      code: ProtocolCode.CHUNK_INVALID,
      detail: 'a chunk before the last carries 4 bytes, not 5',
    });
    expect(place(11, 5)).toMatchObject({
      code: ProtocolCode.CHUNK_INVALID,
      detail: 'a last chunk carries 4 bytes at most, not 5',
    });
    expect([place(4, 4), place(8, 4), place(12, 4)]).toEqual([
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.COMPLETE,
    ]);
    expect(incoming.payload()).toEqual(whole);
  });

  // spec 12.6.5
  test('refuses more runs of bytes apart than its bound, one byte at a time', () => {
    const incoming = incomingOf(patternOf(1), { maximumChunkRuns: 3, total: 20, windowBytes: 40 });

    incoming.creditToGrant(Number.MAX_SAFE_INTEGER);

    expect(
      [2, 4].map((offset) => {
        return incoming.place(Uint8Array.of(1), { isLast: false, offset });
      })
    ).toEqual([ChunkOutcome.PLACED, ChunkOutcome.PLACED]);
    expect(codeOf(incoming.place(Uint8Array.of(1), { isLast: false, offset: 6 }))).toBe(
      ProtocolCode.CHUNK_INVALID
    );
  });

  test('grants a window past the bytes received, once half of it can go, the rest at the end', () => {
    const incoming = incomingOf(patternOf(4), {
      payloadBytesPerChunk: 2,
      total: 22,
      windowBytes: 8,
    });
    const placeAll = (offsets: number[]) => {
      return offsets.map((offset) => {
        return incoming.place(patternOf(2), { isLast: false, offset });
      });
    };

    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBe(12);
    // nothing received since: nothing more to grant
    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(placeAll([4])).toEqual([ChunkOutcome.PLACED]);
    // 6 received: 14 would grant 2 more, less than half a window
    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(placeAll([6, 8, 10])).toEqual([
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
    ]);
    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBe(20);
    expect(placeAll([12, 14, 16, 18])).toEqual([
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
      ChunkOutcome.PLACED,
    ]);
    // 2 bytes are left, less than half a window: granted all the same
    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBe(22);
    expect(incoming.creditToGrant(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(incoming.place(patternOf(2), { isLast: true, offset: 20 })).toBe(ChunkOutcome.COMPLETE);
  });

  test('grants no more than the bytes it is told are available', () => {
    const incoming = incomingOf(patternOf(4), { total: 30, windowBytes: 8 });

    // 2 bytes available: less than half a window, so nothing
    expect(incoming.creditToGrant(2)).toBeUndefined();
    expect(incoming.creditToGrant(5)).toBe(9);
    expect(incoming.creditEnd).toBe(9);
  });

  test('carries 100 KiB through envelopes of 1,024 bytes and a window of 8 KiB, a few credits apart', () => {
    const limits = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 8_192 };
    const total = 102_400;
    const payload = patternOf(total);
    const outgoing = createOutgoingTransfer(payload, {
      openingBytes: chunkPayloadBytes(limits, 20),
      payloadBytesPerChunk: chunkPayloadBytes(limits, CHUNK_HEADER_BYTES),
    });
    const incoming = incomingOf(outgoing.opening, {
      payloadBytesPerChunk: chunkPayloadBytes(limits, CHUNK_HEADER_BYTES),
      total,
      windowBytes: limits.windowBytes,
    });
    let credits = 0;
    let chunks = 0;

    for (;;) {
      const granted = incoming.creditToGrant(Number.MAX_SAFE_INTEGER);

      if (granted !== undefined) {
        credits += 1;
        outgoing.grant(granted);
      }

      const chunk = outgoing.nextChunk();

      if (chunk === undefined) {
        break;
      }

      chunks += 1;
      expect(chunk.bytes.length + CHUNK_HEADER_BYTES).toBeLessThanOrEqual(1_024);
      incoming.place(chunk.bytes, chunk);
    }

    expect(outgoing.isComplete).toBe(true);
    expect(incoming.contiguous).toBe(total);
    expect(incoming.payload()).toEqual(payload);
    // 101 chunks after the opening of 1,004 bytes; a credit each half window, not each chunk
    expect(chunks).toBe(101);
    expect(credits).toBeGreaterThan(1);
    expect(credits).toBeLessThan(chunks / 2);
  });
});
