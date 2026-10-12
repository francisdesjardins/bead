import { expect, test } from '@playwright/test';

import { InputError } from '../../diagnostics.ts';
import { scan } from '../scan.ts';

test('a member twice and a fraction or an exponent, at their pointers', () => {
  const scanned = scan(
    '{\n  "a": {"b": 1, "b": 2},\n  "c": [1.5, 2e3, -0, 10],\n  "d/e~f": 1, "d/e~f": 0.0\n}'
  );

  expect(scanned.duplicates).toEqual([
    { pointer: '/a/b', line: 2, column: 17 },
    { pointer: '/d~1e~0f', line: 4, column: 15 },
  ]);
  expect(
    scanned.fractions.map((place) => {
      return place.pointer;
    })
  ).toEqual(['/c/0', '/c/1', '/d~1e~0f']);
  expect(scanned.positions.get('/c/3')).toEqual({ line: 3, column: 23 });
});

test('a byte order mark read past', () => {
  const scanned = scan('\uFEFF{"a": 1}');

  expect(scanned.positions.get('')).toEqual({ line: 1, column: 1 });
  expect(scanned.positions.get('/a')).toEqual({ line: 1, column: 7 });
  expect(() => {
    return scan('{}\uFEFF');
  }).toThrow(InputError);
});

test('a text no JSON at its line and column', () => {
  const cases = [
    ['{\n  "a": 1,\n}', 'line 3, column 1'],
    ['{"a": tru}', 'line 1, column 7'],
    ['{"a": "\u0001"}', 'line 1, column 8'],
    ['{"a": 01}', 'line 1, column 8'],
    ['', 'line 1, column 1'],
    ['{} {}', 'line 1, column 4'],
    ['{"a": "\\x"}', 'line 1, column 8'],
  ] as const;

  for (const [text, where] of cases) {
    expect(() => {
      return scan(text);
    }, JSON.stringify(text)).toThrow(where);
  }
});
