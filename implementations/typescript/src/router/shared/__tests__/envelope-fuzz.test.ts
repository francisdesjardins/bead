import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { CLIENT_FAILURES, SERVER_FAILURES } from '../constants';
import { readEnvelope, readFailure } from '../envelope';
import { FailureError } from '../errors';
import { digestOf, firstInputs, generatorOf, mutate, seedsOf } from './mutations';

// Seeded mutations of the vectors' bytes: each read returns or throws a `FailureError`, within a
// second. The generator is `./mutations`, the other sides' own; the C# side's `EnvelopeFuzzTests`
// and the Rust side's `envelope_fuzz.rs` draw the same inputs.

// constants

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
const INPUTS = Number(process.env['BEAD_FUZZ_INPUTS'] ?? 20_000);
const LIMITS = { maximumDetailBytes: 1_024, maximumEnvelopeBytes: 16_778_240 };

// helpers

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
  test('finds the vectors bytes', () => {
    expect(seeds.length).toBe(273);
    // * the seeds in their order, as every side holds them
    expect(digestOf(seeds)).toBe(
      'da5504c90e2f128e857c8111daf89b83a499ba58178644a2136b429900b6d702'
    );
  });

  test('draws what the other sides draw for a seed', () => {
    const below = generatorOf(1);

    expect(
      Array.from({ length: 8 }, () => {
        return below(1_000);
      })
    ).toEqual([369, 689, 461, 695, 233, 504, 482, 210]);
    // * the first eight inputs of a seed of 1, as every side draws them
    expect(digestOf(firstInputs(seeds, { count: 8, seed: 1 }))).toBe(
      'a9fdb025bb9eb61a4cd1b1ddb9523fb1edc4d518f9386bfc55ada17b68cb28b8'
    );
  });

  for (const seed of [1, 2]) {
    test(`reads or refuses with a failure every mutation of a vector, seed ${String(seed)}`, () => {
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
