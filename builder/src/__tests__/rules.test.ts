import { existsSync, readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { type IRule, Level, RULES, Severity } from '../rules.ts';

const TEST = new URL('../../test/', import.meta.url);
// the tests of what a run gives itself, apart from a comparison of two blueprints
const RUN_TESTS = ['against.test.ts', 'breaking.test.ts'].map((file) => {
  return new URL(`../breaking/__tests__/${file}`, import.meta.url);
});
// the test of what `generate` holds a blueprint to, beside its targets
const GENERATE_TEST = new URL('./generate.test.ts', import.meta.url);

// a rule's cases: a fixture under test/proto/ for a .proto's level, a case under test/blueprints/ or
// test/form/ for a blueprint's, and for a breaking rule's a blueprint case under test/breaking/ and a
// .proto case under test/breaking/proto/; for one the run gives itself, which no comparison of two
// blueprints gives, a .proto case, or a test of the run that names it; for one `generate` gives, a
// test of `generate` that names it
const hasCases = (rule: string, folders: readonly string[]): boolean => {
  return folders.some((folder) => {
    return existsSync(new URL(`${folder}/${rule}/`, TEST));
  });
};

test('every rule has its cases, at each of its levels', () => {
  for (const [rule, { level, category }] of Object.entries(RULES) as [string, IRule][]) {
    if (level === Level.PROTO || level === Level.BOTH) {
      expect(hasCases(rule, ['proto']), `${rule} on a .proto`).toBe(true);
    }

    if (level === Level.BLUEPRINT || level === Level.BOTH) {
      expect(hasCases(rule, ['blueprints', 'form']), `${rule} on a blueprint`).toBe(true);
    }

    if (level === Level.BREAKING && category === undefined) {
      expect(
        hasCases(rule, ['breaking/proto']) ||
          RUN_TESTS.some((file) => {
            return readFileSync(file, 'utf8').includes(`'${rule}`);
          }),
        `${rule}, the run's own`
      ).toBe(true);
    } else if (level === Level.BREAKING) {
      expect(hasCases(rule, ['breaking']), `${rule} between two blueprints`).toBe(true);
      expect(hasCases(rule, ['breaking/proto']), `${rule} between two .proto`).toBe(true);
    }

    if (level === Level.GENERATE) {
      expect(readFileSync(GENERATE_TEST, 'utf8').includes(`'${rule}`), `${rule}, generate's`).toBe(
        true
      );
    }
  }
});

test('the warnings are the seven a run may give, WAIVER_UNUSED the one nothing leaves out', () => {
  expect(
    Object.entries(RULES)
      .filter(([, rule]) => {
        return rule.severity === Severity.WARNING;
      })
      .map(([name]) => {
        return name;
      })
  ).toEqual([
    'SERVICE_SKIPPED',
    'VALIDATE_RULES_UNPLAYED',
    'NOTIFICATION_RESULT',
    'SPEC_VERSION_NEWER',
    'PROTO_SKIPPED',
    'AGAINST_BLUEPRINT',
    'WAIVER_UNUSED',
  ]);
});
