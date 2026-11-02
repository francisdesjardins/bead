// ── Mutations ─────────────────────────────────────────────────────────────────

// Seeded mutations of the conformance files' bytes (decision 0006): one generator, the same on
// every side, its seeds ordered by their SHA-1, so a seed draws the same inputs wherever it runs.
// The C# side's twin is `tests/Shared/Mutations.cs`, the Rust side's `bead::testing::mutations`.

// dependencies

import { createHash } from 'node:crypto';

// types

/** A draw in `[0, count)`. */
export type Below = (count: number) => number;

/** What a mutation draws with: its generator, and the seeds a tail may come from. */
export interface IMutation {
  readonly below: Below;
  readonly seeds: readonly Uint8Array[];
}

// constants

/** The bytes a mutation may write, as the other sides' generators hold them. */
const INTERESTING = Object.freeze([0x00, 0x01, 0x7f, 0x80, 0xff, 0x10, 0x11, 0x12, 0xa1]);

// helpers

/** The bytes `text` holds in hexadecimal, its spaces and bars aside; none where it holds other. */
export const bytesOfHex = (text: string): Uint8Array | undefined => {
  const digits = text.replace(/[\s|]/gu, '');

  if (!/^(?:[0-9A-Fa-f]{2})+$/u.test(digits)) {
    return undefined;
  }

  return Uint8Array.from(digits.match(/../gu) ?? [], (pair) => {
    return Number.parseInt(pair, 16);
  });
};

/** `bytes` in lowercase hexadecimal, unspaced. */
export const lowerHexOf = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('hex');
};

/** The bytes a conformance file holds under each `bytes` or `record` key, at any depth. */
const collect = (value: unknown, seeds: Uint8Array[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, seeds);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const bytes =
        (key === 'bytes' || key === 'record') && typeof inner === 'string'
          ? bytesOfHex(inner)
          : undefined;

      if (bytes === undefined) {
        collect(inner, seeds);
      } else {
        seeds.push(bytes);
      }
    }
  }
};

// definition

/** A xorshift32 generator: `below(count)` is in `[0, count)`, 0 for a count of 0, and one seed replays. */
export const generatorOf = (seed: number): Below => {
  let state = seed >>> 0 || 1;

  return (count) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    return count === 0 ? 0 : state % count;
  };
};

/**
 * `source` changed by one to four edits drawn from `below`: a bit flipped, a byte of `INTERESTING`
 * put in or written over one, bytes removed, the rest cut, the rest replaced by a tail of another
 * of `seeds`, or random bytes put in, each drawn as the other sides draw them, in their order.
 */
export const mutate = (source: Uint8Array, { below, seeds }: IMutation): Uint8Array => {
  let bytes = Array.from(source);

  for (let round = 1 + below(4); round > 0; round -= 1) {
    const at = below(bytes.length + 1);

    switch (below(7)) {
      case 0:
        // ! a bit and a byte are drawn only where there is a byte, as on the other sides
        if (bytes.length > 0) {
          const index = at % bytes.length;

          bytes[index] = (bytes[index] ?? 0) ^ (1 << below(8));
        }
        break;
      case 1:
        bytes.splice(at, 0, INTERESTING[below(INTERESTING.length)] ?? 0);
        break;
      case 2:
        bytes.splice(at, 1 + below(4));
        break;
      case 3:
        bytes = bytes.slice(0, at);
        break;
      case 4: {
        const other = seeds[below(seeds.length)] ?? new Uint8Array();

        bytes = [...bytes.slice(0, at), ...other.slice(below(other.length + 1))];
        break;
      }
      case 5:
        if (bytes.length > 0) {
          bytes[at % bytes.length] = INTERESTING[below(INTERESTING.length)] ?? 0;
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

/**
 * `seeds` ordered by their SHA-1, its hexadecimal ascending: the order every side draws them in,
 * whatever order its reader of the file walks them in.
 */
export const ordered = (seeds: readonly Uint8Array[]): Uint8Array[] => {
  return seeds
    .map((seed) => {
      return { key: createHash('sha1').update(seed).digest('hex'), seed };
    })
    .toSorted((one, other) => {
      return one.key < other.key ? -1 : one.key > other.key ? 1 : 0;
    })
    .map(({ seed }) => {
      return seed;
    });
};

/** The bytes a conformance file holds under each `bytes` or `record` key at any depth, ordered. */
export const seedsOf = (file: unknown): Uint8Array[] => {
  const seeds: Uint8Array[] = [];

  collect(file, seeds);

  return ordered(seeds);
};

/**
 * The SHA-256, in lowercase hexadecimal, of `inputs`' lowercase hexadecimal, each a line ended by a
 * line feed: what every side's twin asserts of its seeds and of its first inputs.
 */
export const digestOf = (inputs: readonly Uint8Array[]): string => {
  const hash = createHash('sha256');

  for (const input of inputs) {
    hash.update(`${lowerHexOf(input)}\n`);
  }

  return hash.digest('hex');
};

/** The first `count` inputs `seed` draws from `seeds`, as each twin draws them: a seed drawn, then mutated. */
export const firstInputs = (
  seeds: readonly Uint8Array[],
  { count, seed }: { count: number; seed: number }
): Uint8Array[] => {
  const below = generatorOf(seed);

  return Array.from({ length: count }, () => {
    return mutate(seeds[below(seeds.length)] ?? new Uint8Array(), { below, seeds });
  });
};
