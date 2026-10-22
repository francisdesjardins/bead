import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { CLIENT_FAILURES, SERVER_FAILURES } from '../constants';
import { readEnvelope, readFailure } from '../envelope';
import { FailureError } from '../errors';

// Seeded mutations of the vectors' bytes: each read returns or throws a `FailureError`, within a
// second, as the C# side's `EnvelopeFuzzTests` holds.

// constants

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
const INPUTS = Number(process.env['BEAD_FUZZ_INPUTS'] ?? 20_000);
const INTERESTING = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x10, 0x11, 0x12, 0xa1];
const LIMITS = { maximumDetailBytes: 1_024, maximumEnvelopeBytes: 16_778_240 };

// types

type Below = (count: number) => number;

interface IMutation {
  below: Below;
  seeds: Uint8Array[];
}

// helpers

/** The bytes the vectors hold under a `bytes` or a `record` key, spaces and bars aside. */
const seedsOf = (value: unknown, seeds: Uint8Array[] = []): Uint8Array[] => {
  if (Array.isArray(value)) {
    for (const item of value) {
      seedsOf(item, seeds);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const digits = typeof inner === 'string' ? inner.replace(/[\s|]/g, '') : '';

      if ((key === 'bytes' || key === 'record') && /^(?:[0-9A-Fa-f]{2})+$/.test(digits)) {
        seeds.push(
          Uint8Array.from(digits.match(/../g) ?? [], (pair) => {
            return parseInt(pair, 16);
          })
        );
      } else {
        seedsOf(inner, seeds);
      }
    }
  }

  return seeds;
};

/** A xorshift32 generator: `below(count)` is in `[0, count)`, and one seed replays. */
const generatorOf = (seed: number): Below => {
  let state = seed >>> 0 || 1;

  return (count) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    return state % count;
  };
};

/** `source` changed by one to four random edits. */
const mutate = (source: Uint8Array, { below, seeds }: IMutation): Uint8Array => {
  let bytes = Array.from(source);

  for (let round = 1 + below(4); round > 0; round--) {
    const at = below(bytes.length + 1);

    switch (below(7)) {
      case 0:
        if (bytes.length > 0) {
          bytes[at % bytes.length]! ^= 1 << below(8);
        }
        break;
      case 1:
        bytes.splice(at, 0, INTERESTING[below(INTERESTING.length)]!);
        break;
      case 2:
        bytes.splice(at, 1 + below(4));
        break;
      case 3:
        bytes = bytes.slice(0, at);
        break;
      case 4: {
        const other = seeds[below(seeds.length)]!;

        bytes = [...bytes.slice(0, at), ...other.slice(below(other.length + 1))];
        break;
      }
      case 5:
        if (bytes.length > 0) {
          bytes[at % bytes.length] = INTERESTING[below(INTERESTING.length)]!;
        }
        break;
      default:
        bytes.splice(
          at,
          0,
          ...Array.from({ length: 1 + below(16) }, () => {
            return below(256);
          })
        );
    }
  }

  return Uint8Array.from(bytes);
};

const hexadecimal = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => {
    return byte.toString(16).padStart(2, '0');
  }).join(' ');
};

/** `read`'s outcome: nothing for a return or a failure, else what went wrong, with the input. */
const defectOf = (read: () => unknown, input: Uint8Array): string | undefined => {
  const started = performance.now();

  try {
    read();
  } catch (reason) {
    if (!(reason instanceof FailureError)) {
      return `${String(reason)}; input ${hexadecimal(input)}`;
    }
  }

  return performance.now() - started > 1_000
    ? `over a second; input ${hexadecimal(input)}`
    : undefined;
};

const seeds = seedsOf(
  JSON.parse(readFileSync(new URL('../../../../../../spec/vectors.json', import.meta.url), 'utf8'))
);

// tests

test.describe('the envelope readers, fed mutations of the vectors', () => {
  test('find the vectors bytes', () => {
    expect(seeds.length).toBeGreaterThan(100);
  });

  for (const seed of [1, 2]) {
    test(`read or refuse with a failure every mutation of a vector, seed ${String(seed)}`, () => {
      const below = generatorOf(seed);
      const defects: (string | undefined)[] = [];

      for (let count = 0; count < INPUTS; count++) {
        const input = mutate(seeds[below(seeds.length)]!, { below, seeds });

        for (const failures of [SERVER_FAILURES, CLIENT_FAILURES]) {
          defects.push(
            defectOf(() => {
              return readEnvelope(input, { failures, ...LIMITS });
            }, input),
            defectOf(() => {
              return readFailure(input, { failures });
            }, input)
          );
        }
      }

      expect(defects.filter(Boolean)).toEqual([]);
    });
  }

  test('reports an exception that is no failure', () => {
    const defect = defectOf(() => {
      throw new TypeError('boom');
    }, Uint8Array.of(1));

    expect(defect).toBe('TypeError: boom; input 01');
  });
});
