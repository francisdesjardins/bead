// ── Pattern ───────────────────────────────────────────────────────────────────

// A pattern's table walked as generated code walks it: tables written by hand as beadc writes them,
// their reads counted, so a match is seen to cost one cell a code point and a search of the bounds,
// whatever the pattern. The C# side holds its walk alike.

// dependencies

import { expect, test } from '@playwright/test';
import { type IPatternTable, matchesPattern } from '../pattern';

// constants

/**
 * `^(a+)+$`, as its DFA: state 0 the start, 1 dead, 2 after one `a` or more, accepting at the end;
 * class 0 every code point but `a`, class 1 `a`.
 */
const NESTED: IPatternTable = Object.freeze({
  accepting: Object.freeze([2]),
  bounds: Object.freeze([0, 0x61, 0x62]),
  classCount: 2,
  classes: Object.freeze([0, 1, 0]),
  dead: 1,
  matched: -1,
  stateCount: 3,
  transitions: new Uint16Array([1, 2, 1, 1, 1, 2]),
});

/** `ok`, unanchored: matched for good once `ok` was read, wherever it is. */
const ANYWHERE: IPatternTable = Object.freeze({
  accepting: Object.freeze([2]),
  bounds: Object.freeze([0, 0x6b, 0x6c, 0x6f, 0x70]),
  classCount: 3,
  classes: Object.freeze([0, 1, 0, 2, 0]),
  dead: -1,
  matched: 2,
  stateCount: 3,
  transitions: new Uint16Array([0, 0, 1, 0, 2, 1, 2, 2, 2]),
});

// the largest table beadc takes, 16,384 cells: 4,096 states in a ring, each of 4 classes stepping on
const RING_STATES = 4_096;
const RING_CLASSES = 4;
const RING_RANGES = 1_024;

// helpers

/** `table`, its bounds and its cells counted as they are read. */
const countedOf = (
  table: IPatternTable
): { readonly reads: { bounds: number; cells: number }; readonly table: IPatternTable } => {
  const reads = { bounds: 0, cells: 0 };
  const counting = <Target extends object>(target: Target, key: 'bounds' | 'cells'): Target => {
    return new Proxy(target, {
      get: (held, property) => {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          reads[key] += 1;
        }

        const value: unknown = Reflect.get(held, property, held);

        return typeof value === 'function' ? (value as () => unknown).bind(held) : value;
      },
    });
  };

  return {
    reads,
    table: {
      ...table,
      bounds: counting(table.bounds, 'bounds'),
      transitions: counting(table.transitions, 'cells'),
    },
  };
};

/** A ring of `RING_STATES` states, each class stepping to the next, over `RING_RANGES` ranges. */
const ringOf = (): IPatternTable => {
  const transitions = new Uint16Array(RING_STATES * RING_CLASSES);

  for (let state = 0; state < RING_STATES; state += 1) {
    for (let each = 0; each < RING_CLASSES; each += 1) {
      transitions[state * RING_CLASSES + each] = (state + 1 + each) % RING_STATES;
    }
  }

  return Object.freeze({
    accepting: Object.freeze([0]),
    bounds: Object.freeze(
      Array.from({ length: RING_RANGES }, (_, at) => {
        return at * 64;
      })
    ),
    classCount: RING_CLASSES,
    classes: Object.freeze(
      Array.from({ length: RING_RANGES }, (_, at) => {
        return at % RING_CLASSES;
      })
    ),
    dead: -1,
    matched: -1,
    stateCount: RING_STATES,
    transitions,
  });
};

// definition

test.describe('matchesPattern', () => {
  test('matches in time linear in its input', () => {
    // * a backtracking engine never ends on this one; a table reads a cell a character
    for (const length of [1_000, 100_000]) {
      const { reads, table } = countedOf(NESTED);

      expect(matchesPattern(table, `${'a'.repeat(length)}!`)).toBe(false);
      expect(reads.cells).toBe(length + 1);
      expect(reads.bounds).toBeLessThanOrEqual((length + 1) * 2);
    }

    expect(matchesPattern(NESTED, 'a'.repeat(100_000))).toBe(true);
    expect(matchesPattern(NESTED, '')).toBe(false);
  });

  test('walks one cell a character, whatever the pattern’s size', () => {
    const ring = ringOf();
    const { reads, table } = countedOf(ring);
    // 1 MiB of characters, the first code point of every range in turn, a surrogate's left out
    const points = ring.bounds.filter((point) => {
      return point < 0xd800 || point > 0xdfff;
    });
    const text = Array.from({ length: 1_048_576 }, (_, at) => {
      return String.fromCodePoint(points[at % points.length] ?? 0);
    }).join('');

    expect(ring.transitions).toHaveLength(16_384);
    expect(matchesPattern(table, text)).toBe(true);
    expect(reads.cells).toBe(1_048_576);
    // a binary search over 1,024 bounds: 10 reads a character
    expect(reads.bounds).toBe(1_048_576 * Math.log2(RING_RANGES));
  });

  test('keeps a match once reached, wherever it is, and stops there', () => {
    const { reads, table } = countedOf(ANYWHERE);

    expect(matchesPattern(table, `xxok${'y'.repeat(1_000)}`)).toBe(true);
    expect(reads.cells).toBe(4);
    expect(matchesPattern(ANYWHERE, 'o k')).toBe(false);
  });

  test('reads a surrogate alone as U+FFFD, a code point of no range of its own', () => {
    const replacement: IPatternTable = Object.freeze({
      accepting: Object.freeze([2]),
      bounds: Object.freeze([0, 0xfffd, 0xfffe]),
      classCount: 2,
      classes: Object.freeze([0, 1, 0]),
      dead: 1,
      matched: -1,
      stateCount: 3,
      transitions: new Uint16Array([1, 2, 1, 1, 1, 1]),
    });

    expect(matchesPattern(replacement, '\uD800')).toBe(true);
    expect(matchesPattern(replacement, '\uDFFF')).toBe(true);
    expect(matchesPattern(replacement, '😀')).toBe(false);
  });
});
