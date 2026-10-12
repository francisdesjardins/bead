import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { hasError, InputError } from '../../diagnostics.ts';
import { Category } from '../../rules.ts';
import { breaking, waiversOf } from '../breaking.ts';

const INTEROP = fileURLToPath(new URL('../../../../spec/interop-blueprint.json', import.meta.url));

// the interop's blueprint, its text changed by `change`, in the running test's output folder
const interopWith = (name: string, change: (text: string) => string): string => {
  const path = test.info().outputPath(name);

  writeFileSync(path, change(readFileSync(INTEROP, 'utf8')));
  return path;
};

// fail and tick, procedures 1 and 10, swap their names, the revision moved: PROCEDURE_SAME_NAME at
// each, and their names neither theirs nor reserved
const swapped = (text: string): string => {
  return text
    .replace('"procedureName": "fail"', '"procedureName": "FAIL"')
    .replace('"procedureName": "tick"', '"procedureName": "fail"')
    .replace('"procedureName": "FAIL"', '"procedureName": "tick"')
    .replace('"serviceRevision": 1', '"serviceRevision": 2');
};

test('a current input check refuses is compared with nothing, exit 1', () => {
  // two names one as 16.6 folds them: NAME_UNIQUE; the earlier named is never read
  const refused = interopWith('refused.json', (text) => {
    return text.replace('"procedureName": "fail"', '"procedureName": "eCho"');
  });
  const run = breaking(
    { blueprint: refused },
    { against: 'no-such-earlier', category: Category.API }
  );

  expect(run.compared).toBe(false);
  expect(hasError(run.diagnostics)).toBe(true);
  expect(
    run.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['NAME_UNIQUE']);
});

test('a scoped waiver waives its pointer and no other; one the current does not resolve is exit 2', () => {
  const current = interopWith('swapped.json', swapped);
  const rulesOf = (except: readonly string[]): string[] => {
    return breaking(
      { blueprint: current },
      { against: INTEROP, category: Category.API, except }
    ).diagnostics.map((diagnostic) => {
      return `${diagnostic.rule} ${diagnostic.pointer ?? ''}`;
    });
  };

  expect(rulesOf([])).toEqual([
    'PROCEDURE_SAME_NAME /services/0/procedures/1/procedureName',
    'PROCEDURE_SAME_NAME /services/0/procedures/10/procedureName',
    'NAME_NO_DELETE /services/0/reserved/procedureNames',
    'NAME_NO_DELETE /services/0/reserved/procedureNames',
  ]);
  // a scope waives under it at a token's boundary: /services/0/procedures/10 is not under .../1
  expect(rulesOf(['PROCEDURE_SAME_NAME@/services/0/procedures/1'])).toEqual([
    'PROCEDURE_SAME_NAME /services/0/procedures/10/procedureName',
    'NAME_NO_DELETE /services/0/reserved/procedureNames',
    'NAME_NO_DELETE /services/0/reserved/procedureNames',
  ]);
  expect(
    rulesOf(['PROCEDURE_SAME_NAME@/services/0/procedures/10/procedureName', 'NAME_NO_DELETE'])
  ).toEqual(['PROCEDURE_SAME_NAME /services/0/procedures/1/procedureName']);
  expect(rulesOf(['PROCEDURE_SAME_NAME', 'NAME_NO_DELETE@/services/0/reserved'])).toEqual([]);
  expect(() => {
    return rulesOf(['PROCEDURE_SAME_NAME@/services/0/procedures/40']);
  }).toThrow(/holds nothing at \/services\/0\/procedures\/40/u);
  expect(() => {
    return waiversOf(['PROCEDURE_SAME_NAME@services/0'], { category: Category.API });
  }).toThrow(InputError);
});
