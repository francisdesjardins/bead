import { existsSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { Level, RULES, Severity } from '../rules.ts';

const TEST = new URL('../../test/', import.meta.url);

// a rule's cases: a fixture under test/proto/ for a .proto's level, a case under test/blueprints/ or
// test/form/ for a blueprint's
const hasCases = (rule: string, folders: readonly string[]): boolean => {
  return folders.some((folder) => {
    return existsSync(new URL(`${folder}/${rule}/`, TEST));
  });
};

test('every rule has its cases, at each of its levels', () => {
  for (const [rule, { level }] of Object.entries(RULES)) {
    if (level === Level.PROTO || level === Level.BOTH) {
      expect(hasCases(rule, ['proto']), `${rule} on a .proto`).toBe(true);
    }

    if (level === Level.BLUEPRINT || level === Level.BOTH) {
      expect(hasCases(rule, ['blueprints', 'form']), `${rule} on a blueprint`).toBe(true);
    }
  }
});

test('the warnings are the three a user may leave out', () => {
  expect(
    Object.entries(RULES)
      .filter(([, rule]) => {
        return rule.severity === Severity.WARNING;
      })
      .map(([name]) => {
        return name;
      })
  ).toEqual(['SERVICE_SKIPPED', 'NOTIFICATION_RESULT', 'SPEC_VERSION_NEWER']);
});
