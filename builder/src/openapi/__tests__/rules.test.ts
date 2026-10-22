import { expect, test } from '@playwright/test';

import type { IEnumEntry, IMessageRules } from '../../model/blueprint.ts';
import { messagePlanOf } from '../../model/rules.ts';
import { ecmaPatternOf, fieldKeywordsOf, zeroOf } from '../rules.ts';

const LEVEL: IEnumEntry = {
  fullName: 'x.v1.Level',
  file: 'x.proto',
  values: [
    { name: 'LEVEL_UNSPECIFIED', number: 0 },
    { name: 'LEVEL_GOLD', number: 1 },
  ],
};

const enumOf = (name: string): IEnumEntry | undefined => {
  return name === LEVEL.fullName ? LEVEL : undefined;
};

test("writes RE2's pattern in ECMA-262's words where both mean one thing, and none where beadc cannot", () => {
  expect(ecmaPatternOf('^[a-z]+$')).toBe('^[a-z]+$');
  expect(ecmaPatternOf('a.b')).toBe('a[^\\n]b');
  expect(ecmaPatternOf('\\d+\\s\\w')).toBe('[0-9]+[\\t\\n\\f\\r ][0-9A-Za-z_]');
  expect(ecmaPatternOf('[\\d_]')).toBe('[0-9_]');
  expect(ecmaPatternOf('\\Aab\\z')).toBe('^ab$');
  expect(ecmaPatternOf('(?P<word>a)(?:b)')).toBe('(?<word>a)(?:b)');
  expect(ecmaPatternOf('a\\#b')).toBe('a#b');
  expect(ecmaPatternOf('[]a]')).toBe('[\\]a]');

  for (const pattern of [
    '(?i)abc',
    '\\pL',
    '[[:alpha:]]',
    '\\Qa\\E',
    '\\x{41}',
    'a{,2}',
    '[\\D]',
    '[a',
  ]) {
    expect(ecmaPatternOf(pattern), pattern).toBeUndefined();
  }
});

test("adds a field's rules to its schema: a range, a length, an enum's numbers as its names, required, and its zero where it ignores it", () => {
  const rules: IMessageRules = {
    fields: [
      {
        fieldName: 'count',
        fieldNumber: 1,
        type: { scalar: 'int32' },
        presence: 'implicit',
        rules: { int32: { gte: 1, lt: 10 }, required: true },
      },
      {
        fieldName: 'level',
        fieldNumber: 2,
        type: { enum: LEVEL.fullName },
        presence: 'implicit',
        rules: { enum: { in: [1] } },
      },
      {
        fieldName: 'title',
        fieldNumber: 3,
        type: { scalar: 'string' },
        presence: 'implicit',
        rules: { string: { max_len: '3', prefix: 'a.' }, ignore: 'IGNORE_IF_ZERO_VALUE' },
      },
      {
        fieldName: 'big',
        fieldNumber: 4,
        type: { scalar: 'int64' },
        presence: 'implicit',
        rules: { int64: { gt: '0' } },
      },
    ],
    message: {},
    oneofs: [],
  };
  const keywords = fieldKeywordsOf(
    messagePlanOf('x.v1.Thing', { rules, judged: new Set(['x.v1.Thing']) }),
    enumOf
  );

  expect(keywords.get(1)).toEqual({
    value: [{ minimum: 1, exclusiveMaximum: 10 }, { not: { const: 0 } }],
    items: [],
    keys: [],
    values: [],
    required: true,
    unheld: [],
  });
  expect(keywords.get(2)?.value).toEqual([{ enum: ['LEVEL_GOLD'] }]);
  expect(keywords.get(3)?.value).toEqual([
    { anyOf: [{ const: '' }, { allOf: [{ maxLength: 3 }, { pattern: '^a\\.' }] }] },
  ]);
  expect(keywords.get(4)).toMatchObject({ value: [], unheld: ['must be greater than 0'] });
  expect(zeroOf({ enum: LEVEL.fullName }, enumOf)).toBe('LEVEL_UNSPECIFIED');
  expect(zeroOf({ scalar: 'uint64' }, enumOf)).toBe('0');
  expect(zeroOf({ message: 'x.v1.Thing' }, enumOf)).toBeUndefined();
});
