import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import type { SessionToken } from '../types';
import {
  createSequence,
  drawDestinationId,
  drawSessionToken,
  isSessionToken,
  sideOfCallId,
  toSessionToken,
  toSessionTokenBytes,
} from '../identifiers';

test.describe('createSequence', () => {
  const free = () => {
    return false;
  };

  test('walks its range by its step, then from its first again', () => {
    const next = createSequence({ first: 1, last: 7, step: 2 });

    expect([next(free), next(free), next(free), next(free), next(free)]).toEqual([1, 3, 5, 7, 1]);
  });

  test('skips the ids in use, and gives none once every one is', () => {
    const next = createSequence({ first: 2, last: 8, step: 2 });
    const used = new Set([2, 6]);
    const isInUse = (callId: number) => {
      return used.has(callId);
    };

    expect([next(isInUse), next(isInUse), next(isInUse)]).toEqual([4, 8, 4]);

    used.add(4).add(8);

    expect(next(isInUse)).toBeUndefined();

    // ids outside the range, however many, stop nothing: every id but 5 is in use here
    const outside = createSequence({ first: 3, last: 7, step: 2 });

    expect(
      outside((callId) => {
        return callId !== 5;
      })
    ).toBe(5);
  });

  test('asks about each id once at most, however many are in use', () => {
    const next = createSequence({ first: 1, last: 9, step: 2 });
    const asked: number[] = [];

    expect(
      next((callId) => {
        asked.push(callId);

        return true;
      })
    ).toBeUndefined();
    expect(asked).toEqual([1, 3, 5, 7, 9]);
  });

  test('crosses 2^31 and reaches 0xffffffff, unsigned', () => {
    const next = createSequence({ first: 2 ** 31 - 1, last: 0xffffffff, step: 2 ** 31 });

    expect([next(free), next(free), next(free)]).toEqual([2 ** 31 - 1, 0xffffffff, 2 ** 31 - 1]);

    const odd = createSequence({ first: 0xfffffffb, last: 0xffffffff, step: 2 });

    expect([odd(free), odd(free), odd(free), odd(free)]).toEqual([
      0xfffffffb, 0xfffffffd, 0xffffffff, 0xfffffffb,
    ]);
  });

  test('refuses a range that is not of call ids, backwards, or not walked exactly by its step', () => {
    for (const range of [
      { first: 0, last: 3, step: 1 },
      { first: 1, last: 2 ** 32, step: 1 },
      { first: -1, last: 3, step: 2 },
      { first: 1.5, last: 3, step: 1 },
      { first: 1, last: 3, step: 0 },
      { first: 1, last: 3, step: 1.5 },
      { first: 5, last: 3, step: 2 },
      { first: 1, last: 4, step: 2 },
      { first: 1, last: Number.NaN, step: 2 },
    ]) {
      expect(() => {
        return createSequence(range);
      }, JSON.stringify(range)).toThrow(ProgrammerError);
    }
  });
});

test.describe('sideOfCallId', () => {
  test('is the client for an odd call id and the server for an even one', () => {
    expect([1, 3, 2 ** 31 + 1, 0xffffffff].map(sideOfCallId)).toEqual([
      'client',
      'client',
      'client',
      'client',
    ]);
    expect([2, 2 ** 31, 0xfffffffe].map(sideOfCallId)).toEqual(['server', 'server', 'server']);
  });

  test('is no side for what is not a call id', () => {
    for (const callId of [0, -1, -2, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      expect(sideOfCallId(callId), String(callId)).toBeUndefined();
    }
  });
});

test.describe('session tokens', () => {
  test('spell 16 bytes in unpadded base64url, and back', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => {
      return index * 17;
    });
    const token = toSessionToken(bytes);

    expect(token).toBe('ABEiM0RVZneImaq7zN3u_w');
    expect(isSessionToken(token)).toBe(true);
    expect(toSessionTokenBytes(token)).toEqual(bytes);

    // the characters base64 has that base64url replaces
    const high = toSessionToken(new Uint8Array(16).fill(0xfb));

    expect(high).toBe('-_v7-_v7-_v7-_v7-_v7-w');
    expect(toSessionTokenBytes(high)).toEqual(new Uint8Array(16).fill(0xfb));
  });

  test('refuse any length but 16 bytes, and 16 zero bytes', () => {
    for (const length of [0, 15, 17]) {
      expect(() => {
        return toSessionToken(new Uint8Array(length).fill(1));
      }).toThrow(ProgrammerError);
    }

    expect(() => {
      return toSessionToken(new Uint8Array(16));
    }).toThrow(ProgrammerError);
  });

  test('are only what the wire can spell', () => {
    for (const value of [
      '',
      'ABEiM0RVZneImaq7zN3u_',
      'ABEiM0RVZneImaq7zN3u_wA',
      'ABEiM0RVZneImaq7zN3u+w',
      'ABEiM0RVZneImaq7zN3u/w',
      'ABEiM0RVZneImaq7zN3u_w==',
      'ABEiM0RVZneImaq7zN3uAB',
      'AAAAAAAAAAAAAAAAAAAAAA',
      42,
      undefined,
    ]) {
      expect(isSessionToken(value), String(value)).toBe(false);
    }

    for (const last of ['A', 'Q', 'g', 'w']) {
      expect(isSessionToken(`ABEiM0RVZneImaq7zN3u_${last}`)).toBe(true);
    }

    expect(() => {
      return toSessionTokenBytes('ABEiM0RVZneImaq7zN3uAB' as SessionToken);
    }).toThrow(ProgrammerError);
    expect(() => {
      return toSessionTokenBytes('AAAAAAAAAAAAAAAAAAAAAA' as SessionToken);
    }).toThrow(ProgrammerError);
  });

  test('are drawn distinct, from crypto', () => {
    const drawn = new Set<SessionToken>();

    for (let draw = 0; draw < 100; draw += 1) {
      const token = drawSessionToken((candidate) => {
        return drawn.has(candidate);
      });

      expect(isSessionToken(token)).toBe(true);
      drawn.add(token);
    }

    expect(drawn.size).toBe(100);
  });

  test('are drawn again when all zero, or in use; so are destinations, when 0 or in use', () => {
    const destinationFills = [
      [0, 0, 0, 0],
      [0, 0, 0, 5],
      [0, 0, 1, 7],
    ];
    const destinationId = drawDestinationId(
      (candidate) => {
        return candidate === 5;
      },
      (bytes) => {
        bytes.set(destinationFills.shift() ?? [0, 0, 0, 9]);
      }
    );

    expect(destinationId).toBe(263);
    expect(destinationFills).toEqual([]);
    // from crypto, when not told: distinct, and the wire takes each
    const drawn = new Set<number>();

    for (let draw = 0; draw < 100; draw += 1) {
      drawn.add(
        drawDestinationId((candidate) => {
          return drawn.has(candidate);
        })
      );
    }

    expect(drawn.size).toBe(100);
    expect(
      [...drawn].every((drawnId) => {
        return Number.isInteger(drawnId) && drawnId >= 1 && drawnId <= 0xffffffff;
      })
    ).toBe(true);
  });

  test('are drawn again when all zero, or in use', () => {
    const fills = [0, 0, 1, 1, 2];
    const used = toSessionToken(new Uint8Array(16).fill(1));
    const token = drawSessionToken(
      (candidate) => {
        return candidate === used;
      },
      (bytes) => {
        bytes.fill(fills.shift() ?? 3);
      }
    );

    expect(toSessionTokenBytes(token)).toEqual(new Uint8Array(16).fill(2));
    expect(fills).toEqual([]);
  });
});
