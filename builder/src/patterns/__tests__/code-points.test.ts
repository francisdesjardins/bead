import { expect, test } from '@playwright/test';

import {
  codePointsOf,
  complementOf,
  EVERY_CODE_POINT,
  foldedOf,
  includes,
  NO_CODE_POINT,
  orbitOf,
  rangesOf,
  sizeOf,
  unicodeClass,
  unionOf,
} from '../code-points.ts';

// ── Code points ───────────────────────────────────────────────────────────────

// Sets of code points, their union and complement; the classes RE2 names in `\p{…}`, of beadc's
// own tables, case by case as RE2 holds their names; and simple case folding's orbits.

test('merges ranges given in any order, overlapping or adjacent', () => {
  expect(
    codePointsOf([
      [0x61, 0x63],
      [0x30, 0x39],
      [0x64, 0x66],
      [0x62, 0x62],
    ])
  ).toEqual([0x30, 0x39, 0x61, 0x66]);
  expect(codePointsOf([])).toEqual([]);
});

test('takes a union, a complement and a size', () => {
  const digits = codePointsOf([[0x30, 0x39]]);
  const letters = codePointsOf([[0x61, 0x7a]]);

  expect(unionOf(digits, letters)).toEqual([0x30, 0x39, 0x61, 0x7a]);
  expect(complementOf(digits)).toEqual([0, 0x2f, 0x3a, 0x10ffff]);
  expect(complementOf(NO_CODE_POINT)).toEqual(EVERY_CODE_POINT);
  expect(complementOf(EVERY_CODE_POINT)).toEqual([]);
  expect(sizeOf(unionOf(digits, letters))).toBe(36);
  expect(rangesOf(digits)).toEqual([[0x30, 0x39]]);
});

test('finds a code point by a binary search over the ranges', () => {
  const set = codePointsOf([
    [0x30, 0x39],
    [0x61, 0x7a],
    [0x1f600, 0x1f64f],
  ]);

  expect(includes(set, 0x30)).toBe(true);
  expect(includes(set, 0x39)).toBe(true);
  expect(includes(set, 0x3a)).toBe(false);
  expect(includes(set, 0x1f600)).toBe(true);
  expect(includes(set, 0x10ffff)).toBe(false);
  expect(includes(NO_CODE_POINT, 0)).toBe(false);
});

test('names the classes RE2 takes: Any, the categories, the scripts', () => {
  expect(unicodeClass('Any')).toEqual(EVERY_CODE_POINT);
  // U+10940, a letter of Unicode 17.0.0, whatever the platform's version
  expect(includes(unicodeClass('L') ?? [], 0x10940)).toBe(true);
  expect(includes(unicodeClass('Lo') ?? [], 0x10940)).toBe(true);
  expect(includes(unicodeClass('Sidetic') ?? [], 0x10940)).toBe(true);
  expect(includes(unicodeClass('Greek') ?? [], 0x3b1)).toBe(true);
  expect(includes(unicodeClass('Greek') ?? [], 0x61)).toBe(false);
  expect(includes(unicodeClass('Nd') ?? [], 0x663)).toBe(true);
  // C groups the assigned others: an unassigned code point is none of them
  expect(includes(unicodeClass('C') ?? [], 0x0)).toBe(true);
  expect(includes(unicodeClass('C') ?? [], 0x378)).toBe(false);
});

test('refuses a name RE2 does not take: Cn, LC, another case, an alias', () => {
  for (const name of ['Cn', 'LC', 'greek', 'GREEK', 'Letter', 'Grek', 'Unknown', '', 'L&']) {
    expect(unicodeClass(name)).toBeUndefined();
  }
});

test('reads each code point’s orbit under simple case folding', () => {
  expect(orbitOf(0x6b)).toEqual([0x4b, 0x6b, 0x212a]);
  expect(orbitOf(0x17f)).toEqual([0x53, 0x73, 0x17f]);
  expect(orbitOf(0x3c2)).toEqual([0x3a3, 0x3c2, 0x3c3]);
  expect(orbitOf(0x345)).toEqual([0x345, 0x399, 0x3b9, 0x1fbe]);
  expect(orbitOf(0x1c5)).toEqual([0x1c4, 0x1c5, 0x1c6]);
  // a pair Unicode 17.0.0 added, whatever the platform's case mapping holds
  expect(orbitOf(0xa7ce)).toEqual([0xa7ce, 0xa7cf]);
  // İ and ı fold by the status T alone, left out
  expect(orbitOf(0x130)).toEqual([0x130]);
  expect(orbitOf(0x131)).toEqual([0x131]);
  expect(orbitOf(0x31)).toEqual([0x31]);
});

test('closes a set under simple case folding', () => {
  expect(foldedOf(codePointsOf([[0x6b, 0x6b]]))).toEqual([0x4b, 0x4b, 0x6b, 0x6b, 0x212a, 0x212a]);
  expect(foldedOf(codePointsOf([[0x30, 0x39]]))).toEqual([0x30, 0x39]);

  const lower = foldedOf(codePointsOf([[0x61, 0x7a]]));

  expect(includes(lower, 0x41)).toBe(true);
  expect(includes(lower, 0x17f)).toBe(true);
  expect(includes(lower, 0x212a)).toBe(true);
});
