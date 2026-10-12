import { existsSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { Level, RULES, Severity } from '../rules.ts';

const TEST = new URL('../../test/', import.meta.url);

// a rule's cases: a fixture under test/proto/ for a .proto's level, a case under test/blueprints/ or
// test/form/ for a blueprint's, and for a breaking rule's a blueprint case under test/breaking/ and a
// .proto case under test/breaking/proto/
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

    if (level === Level.BREAKING) {
      expect(hasCases(rule, ['breaking']), `${rule} between two blueprints`).toBe(true);
      expect(hasCases(rule, ['breaking/proto']), `${rule} between two .proto`).toBe(true);
    }
  }
});

test('the warnings are the four a user may leave out', () => {
  expect(
    Object.entries(RULES)
      .filter(([, rule]) => {
        return rule.severity === Severity.WARNING;
      })
      .map(([name]) => {
        return name;
      })
  ).toEqual(['SERVICE_SKIPPED', 'NOTIFICATION_RESULT', 'SPEC_VERSION_NEWER', 'PROTO_SKIPPED']);
});
