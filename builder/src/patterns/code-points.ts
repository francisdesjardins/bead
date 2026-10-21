// ── Code points ───────────────────────────────────────────────────────────────

// Sets of code points, as a pattern's classes are: each a flat list of inclusive ranges, `[low,
// high, low, high, …]`, ascending, merged and never adjacent, so that two equal sets are equal
// lists. Unicode's classes and simple case folding are read from beadc's own tables,
// `unicode.ts`, of the version they name, never from the platform's (spec 18.8.5).

// dependencies

import { CASE_ORBITS, CATEGORIES, CATEGORY_GROUPS, SCRIPTS } from './unicode.ts';

// types

/** A set of code points: inclusive ranges, flat, ascending, merged. */
export type CodePoints = readonly number[];

// constants

/** The last code point. */
export const LAST_CODE_POINT = 0x10ffff;

/** Every code point. */
export const EVERY_CODE_POINT: CodePoints = Object.freeze([0, LAST_CODE_POINT]);

/** No code point. */
export const NO_CODE_POINT: CodePoints = Object.freeze([]);

// the classes by name, read once from their tables
const CLASSES = new Map<string, CodePoints>();

// each code point's orbit under simple case folding, read once from its table
let orbits: ReadonlyMap<number, readonly number[]> | undefined;

// definition

/** The set of `ranges`, `[low, high]` each, in any order, overlapping or not. */
export const codePointsOf = (ranges: readonly (readonly [number, number])[]): CodePoints => {
  const sorted = [...ranges].sort((a, b) => {
    return a[0] - b[0];
  });
  const merged: number[] = [];

  for (const [low, high] of sorted) {
    const last = merged.length - 1;

    if (last > 0 && low <= (merged[last] ?? 0) + 1) {
      merged[last] = Math.max(merged[last] ?? 0, high);
    } else {
      merged.push(low, high);
    }
  }

  return merged;
};

/** The pairs of `set`, `[low, high]` each. */
export const rangesOf = (set: CodePoints): [number, number][] => {
  const ranges: [number, number][] = [];

  for (let at = 0; at + 1 < set.length; at += 2) {
    ranges.push([set[at] ?? 0, set[at + 1] ?? 0]);
  }

  return ranges;
};

/** The code points in `a` or in `b`. */
export const unionOf = (a: CodePoints, b: CodePoints): CodePoints => {
  return codePointsOf([...rangesOf(a), ...rangesOf(b)]);
};

/** The code points not in `set`. */
export const complementOf = (set: CodePoints): CodePoints => {
  const complement: number[] = [];
  let next = 0;

  for (const [low, high] of rangesOf(set)) {
    if (low > next) {
      complement.push(next, low - 1);
    }

    next = high + 1;
  }

  if (next <= LAST_CODE_POINT) {
    complement.push(next, LAST_CODE_POINT);
  }

  return complement;
};

/** Whether `point` is in `set`, by a binary search over its ranges. */
export const includes = (set: CodePoints, point: number): boolean => {
  let low = 0;
  let high = set.length / 2 - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (point < (set[middle * 2] ?? 0)) {
      high = middle - 1;
    } else if (point > (set[middle * 2 + 1] ?? 0)) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
};

/** The number of code points in `set`. */
export const sizeOf = (set: CodePoints): number => {
  let size = 0;

  for (const [low, high] of rangesOf(set)) {
    size += high - low + 1;
  }

  return size;
};

// a table's ranges, as `unicode.ts` writes them
const readTable = (table: string): CodePoints => {
  return codePointsOf(
    table.split(' ').map((range) => {
      const [low = '', high = low] = range.split('-');

      return [Number.parseInt(low, 16), Number.parseInt(high, 16)];
    })
  );
};

/**
 * The class RE2 names `name` in `\p{name}`, of beadc's tables: `Any`, a general category of one or
 * two letters (`Cn` and `LC` none, `C` the assigned others), or a script by its long name; names
 * held case by case, as RE2 holds them. `undefined` for a name RE2 does not take.
 */
export const unicodeClass = (name: string): CodePoints | undefined => {
  const known = CLASSES.get(name);

  if (known !== undefined) {
    return known;
  }

  let found: CodePoints | undefined;

  if (name === 'Any') {
    found = EVERY_CODE_POINT;
  } else if (Object.hasOwn(CATEGORIES, name)) {
    found = readTable(CATEGORIES[name] ?? '');
  } else if (Object.hasOwn(CATEGORY_GROUPS, name)) {
    found = (CATEGORY_GROUPS[name] ?? []).reduce<CodePoints>((union, member) => {
      return unionOf(union, readTable(CATEGORIES[member] ?? ''));
    }, NO_CODE_POINT);
  } else if (Object.hasOwn(SCRIPTS, name)) {
    found = readTable(SCRIPTS[name] ?? '');
  }

  if (found !== undefined) {
    CLASSES.set(name, Object.freeze(found));
  }

  return found;
};

const orbitsByPoint = (): ReadonlyMap<number, readonly number[]> => {
  if (orbits === undefined) {
    const read = new Map<number, readonly number[]>();

    for (const written of CASE_ORBITS.split(',')) {
      const orbit = Object.freeze(
        written.split(' ').map((point) => {
          return Number.parseInt(point, 16);
        })
      );

      for (const point of orbit) {
        read.set(point, orbit);
      }
    }

    orbits = read;
  }

  return orbits;
};

/** `point`'s orbit under simple case folding, ascending: itself alone where nothing folds with it. */
export const orbitOf = (point: number): readonly number[] => {
  return orbitsByPoint().get(point) ?? [point];
};

/** `set` closed under simple case folding: each code point with every one of its orbit. */
export const foldedOf = (set: CodePoints): CodePoints => {
  const added: [number, number][] = [];

  for (const [point, orbit] of orbitsByPoint()) {
    if (includes(set, point)) {
      for (const each of orbit) {
        added.push([each, each]);
      }
    }
  }

  return added.length === 0 ? set : codePointsOf([...rangesOf(set), ...added]);
};
