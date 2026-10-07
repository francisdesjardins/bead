import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { InputError } from '../../diagnostics.ts';
import { deriveRoot, INTEROP_PROTO, RULE_FIXTURES } from './derive.ts';

test('each fixture of test/proto/ gives its rule', () => {
  const rules = readdirSync(RULE_FIXTURES);

  expect(rules.length).toBeGreaterThan(0);

  for (const rule of rules) {
    const root = join(RULE_FIXTURES, rule);
    const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as unknown[];
    const checked = checkRoots([root]);

    expect(
      checked.diagnostics.map((diagnostic) => {
        return { rule: diagnostic.rule, line: diagnostic.line, column: diagnostic.column };
      }),
      rule
    ).toEqual(expected);
    expect(
      checked.diagnostics.map((diagnostic) => {
        return diagnostic.rule;
      }),
      rule
    ).toContain(rule);
  }
});

test('an admission written {} is ADMISSION_EMPTY', () => {
  const root = deriveRoot(INTEROP_PROTO, {
    root: 'admission-empty',
    change: (text) => {
      return text.replace(
        '      admission: {\n        session: {}\n      }\n',
        '      admission: {}\n'
      );
    },
  });
  const checked = checkRoots([root]);

  expect(
    checked.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['ADMISSION_EMPTY']);
});

test("two kinds are buf's refusal, exit 2", () => {
  const root = deriveRoot(INTEROP_PROTO, {
    root: 'two-kinds',
    change: (text) => {
      return text.replace(
        '      command: {}\n',
        '      command: {}\n      notifies: {message: "bead.Json"}\n'
      );
    },
  });

  expect(() => {
    return checkRoots([root]);
  }).toThrow(InputError);
  expect(() => {
    return checkRoots([root]);
  }).toThrow(/oneof `?bead\.Procedure\.procedure_kind`? set multiple times/u);
});
