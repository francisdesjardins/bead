import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  CASE_ORBITS,
  CATEGORIES,
  CATEGORY_GROUPS,
  SCRIPTS,
  UNICODE_FILES,
  UNICODE_VERSION,
} from '../unicode.ts';

// ── Unicode's tables ──────────────────────────────────────────────────────────

// The tables `tools/make-unicode.mjs` writes, held to the one pin they are read under,
// `spec/generators/ucd.json`, whose files the spec's verdicts are read from too. Regenerating them
// fetches the UCD, so the tests hold the committed file to its pins and to what Unicode 17.0.0
// states of a few code points; `node tools/make-unicode.mjs --check` holds the rest.

const PIN = new URL('../../../../spec/generators/ucd.json', import.meta.url);

interface IPin {
  readonly version: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
}

test('names the version and the files of the UCD that spec/generators/ucd.json pins', () => {
  const pin = JSON.parse(readFileSync(PIN, 'utf8')) as IPin;

  expect(UNICODE_VERSION).toBe('17.0.0');
  expect(UNICODE_VERSION).toBe(pin.version);
  expect(
    UNICODE_FILES.map((file) => {
      return { name: file.name, sha256: file.sha256 };
    })
  ).toEqual(
    pin.files.map((file) => {
      return { name: file.name, sha256: file.sha256 };
    })
  );
});

test('holds a letter Unicode 17.0.0 added, under its category and its script', () => {
  // U+10940, a Sidetic letter, new in 17.0.0
  expect(CATEGORIES['Lo']?.split(' ')).toContain('10940-10959');
  expect(SCRIPTS['Sidetic']).toBe('10940-10959');
});

test('groups each category of one letter by those of two, Cn among none', () => {
  expect(CATEGORY_GROUPS['C']).toEqual(['Cc', 'Cf', 'Co', 'Cs']);
  expect(CATEGORY_GROUPS['L']).toEqual(['Ll', 'Lm', 'Lo', 'Lt', 'Lu']);
  expect(Object.keys(CATEGORY_GROUPS).sort()).toEqual(['C', 'L', 'M', 'N', 'P', 'S', 'Z']);
});

test('leaves out the names RE2 refuses', () => {
  for (const name of ['Cn', 'LC']) {
    expect(Object.hasOwn(CATEGORIES, name)).toBe(false);
  }

  for (const name of ['Katakana_Or_Hiragana', 'Unknown', 'Grek']) {
    expect(Object.hasOwn(SCRIPTS, name)).toBe(false);
  }
});

test('writes simple case folding’s orbits, its statuses C and S alone', () => {
  const orbits = CASE_ORBITS.split(',');

  // K, k and the Kelvin sign; S, s and the long s; the three sigmas
  expect(orbits).toContain('4b 6b 212a');
  expect(orbits).toContain('53 73 17f');
  expect(orbits).toContain('3a3 3c2 3c3');
  // ẞ folds to ß by its status S, never to "ss" by its F
  expect(orbits).toContain('df 1e9e');
  // İ folds by its status T alone, which simple folding leaves out
  expect(
    orbits.some((orbit) => {
      return orbit.split(' ').includes('130');
    })
  ).toBe(false);
});
