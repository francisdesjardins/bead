// ── Broker parcel fuzz ────────────────────────────────────────────────────────

// A broker's parcel reader fed seeded mutations of `spec/vectors.json`'s parcels (spec 15.17,
// decision 0006), held to the `broker-parcel` target's properties within a second an input. The C#
// side's `BrokerParcelFuzzTests` and the Rust side's `broker_parcel_fuzz.rs` draw the same inputs.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  digestOf,
  firstInputs,
  generatorOf,
  lowerHexOf,
  mutate,
} from '../../../router/shared/__tests__/mutations';
import { parcelBreakOf, parcelSeedsOf } from './parcel-properties';

// constants

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
const INPUTS = Number(process.env['BEAD_FUZZ_INPUTS'] ?? 20_000);

const SEEDS = parcelSeedsOf(
  JSON.parse(
    readFileSync(new URL('../../../../../../spec/vectors.json', import.meta.url), 'utf8')
  ) as Parameters<typeof parcelSeedsOf>[0]
);

// helpers

/** What `check` gives that breaks a property, with the input: a break, a throw, or over a second. */
const defectOf = (check: () => string | undefined, input: Uint8Array): string | undefined => {
  const started = performance.now();
  let broken: string | undefined;

  try {
    broken = check();
  } catch (reason) {
    return `${String(reason)}; input ${lowerHexOf(input)}`;
  }

  if (broken !== undefined) {
    return `${broken}; input ${lowerHexOf(input)}`;
  }

  return performance.now() - started > 1_000
    ? `over a second; input ${lowerHexOf(input)}`
    : undefined;
};

// definition

test.describe("a broker's parcel reader, fed mutations of the vectors' parcels", () => {
  test('finds the parcels bytes', () => {
    expect(SEEDS.length).toBe(72);
    // * the seeds in their order, as every side holds them
    expect(digestOf(SEEDS)).toBe(
      '654a2c65cf1911a21e201cd09d3f1cb59af1688e318e7ddf1f2f0d3c73984d45'
    );
  });

  test('draws what the other sides draw for a seed', () => {
    // * the first eight inputs of a seed of 1, as every side draws them
    expect(digestOf(firstInputs(SEEDS, { count: 8, seed: 1 }))).toBe(
      '3c513c8adf6e27cc4fbb1042b4f0dcaf9d6279e50b20ef52831433284c2c1e88'
    );
  });

  for (const seed of [1, 2]) {
    test(`reads, writes back or refuses as designed every mutation of a parcel, seed ${String(seed)}`, () => {
      const below = generatorOf(seed);
      const defects: string[] = [];

      for (let count = 0; count < INPUTS; count += 1) {
        const input = mutate(SEEDS[below(SEEDS.length)]!, { below, seeds: SEEDS });
        const defect = defectOf(() => {
          return parcelBreakOf(input);
        }, input);

        if (defect !== undefined) {
          defects.push(defect);
        }
      }

      expect(defects).toEqual([]);
    });
  }

  test('reports an exception that is no refusal', () => {
    const defect = defectOf(() => {
      throw new TypeError('boom');
    }, Uint8Array.of(1));

    expect(defect).toBe('TypeError: boom; input 01');
  });
});
