import { expect, test } from '@playwright/test';

import { INDENT, printerOf, statementOf } from '../lines.ts';

test('prints each line at its depth, an empty line left empty', () => {
  const lines: string[] = [];
  const print = printerOf(lines);

  print(0, 'class A');
  print(1, '{');
  print(2, '');
  print(2, 'return;');

  expect(lines).toEqual(['class A', `${INDENT}{`, '', `${INDENT}${INDENT}return;`]);
});

test("a statement's value of one line ends on its line, of several on its last", () => {
  expect(statementOf('return ', { value: ['x'], indent: INDENT })).toEqual([`${INDENT}return x;`]);
  expect(statementOf('let a = ', { value: ['A {', '    b: 1,', '}'], indent: '' })).toEqual([
    'let a = A {',
    '    b: 1,',
    '};',
  ]);
});
