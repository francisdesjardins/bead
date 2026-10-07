import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { checkValue } from '../blueprint.ts';
import { areOneName, foldOf, IdentityReason, RULES_OF_REASON, reasonRankOf } from '../identity.ts';

interface IEntry {
  readonly name: string;
  readonly refused?: string;
  readonly refusedAt?: readonly string[];
  readonly serviceId?: unknown;
  readonly procedureId?: unknown;
  readonly serviceRevision?: unknown;
  readonly procedureName?: unknown;
  readonly procedureKind?: unknown;
  readonly names?: readonly [string, string];
  readonly one?: boolean;
}

interface IIdentities {
  readonly names: readonly IEntry[];
  readonly ids: readonly IEntry[];
  readonly folds: readonly IEntry[];
  readonly procedureKinds: readonly IEntry[];
}

const SPEC = new URL('../../../../spec/', import.meta.url);
const identities = JSON.parse(
  readFileSync(new URL('identities.json', SPEC), 'utf8')
) as IIdentities;
const interop = JSON.parse(readFileSync(new URL('interop-blueprint.json', SPEC), 'utf8')) as {
  services: { procedures: unknown[] }[];
};

// an entry as a one-procedure blueprint: the interop's, its first procedure alone, the entry's
// ids, name and kind put in
const blueprintOf = (entry: IEntry): unknown => {
  const blueprint = structuredClone(interop) as {
    services: Record<string, unknown>[];
  };
  const service = blueprint.services[0] as Record<string, unknown>;
  const [first] = interop.services[0]?.procedures ?? [];
  const procedure = structuredClone(first) as Record<string, unknown>;

  service['procedures'] = [procedure];

  for (const key of ['serviceId', 'serviceRevision'] as const) {
    if (key in entry) {
      service[key] = entry[key];
    }
  }

  for (const key of ['procedureId', 'procedureName', 'procedureKind'] as const) {
    if (key in entry) {
      procedure[key] = entry[key];
    }
  }

  if (procedure['procedureKind'] === 'notifies') {
    procedure['notification'] = { encoding: 'json' };
  }

  return blueprint;
};

test('plays every name, id and fold of spec/identities.json, and the kinds a blueprint states', () => {
  // the kinds a blueprint can state: one that names a kind, and that no way of declaring refuses
  const kinds = identities.procedureKinds.filter((entry) => {
    return entry.procedureKind !== undefined && entry.refusedAt === undefined;
  });
  const played = [...identities.names, ...identities.ids, ...kinds];
  let verdicts = 0;

  for (const entry of played) {
    const reading = checkValue(blueprintOf(entry), {
      placeOf: (pointer) => {
        return { file: 'identities.json', pointer };
      },
    });
    const rules = reading.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    });

    if (entry.refused === undefined) {
      expect(rules, entry.name).toEqual([]);
    } else {
      // every finding, 16.10's order first: the entry's reason gives the first
      const reasons = RULES_OF_REASON[entry.refused as IdentityReason];

      expect(reasons, entry.name).toBeDefined();
      expect(reasons, entry.name).toContain(rules[0]);
    }

    verdicts += 1;
  }

  for (const entry of identities.folds) {
    const [one, other] = entry.names ?? ['', ''];

    expect(areOneName(one, other), entry.name).toBe(entry.one);
    expect(foldOf(one) === foldOf(other), entry.name).toBe(entry.one);
    verdicts += 1;
  }

  // the count held to the file's: every name, id and fold, and two of its six kinds
  expect(
    kinds.map((entry) => {
      return entry.name;
    })
  ).toEqual(['command at service 0', 'command under the name Echo']);
  expect(verdicts).toBe(
    identities.names.length + identities.ids.length + identities.folds.length + kinds.length
  );
  expect(verdicts).toBe(31 + 28 + 8 + 2);
});

test("16.10's order: a range's rule, then a name's form, then the others", () => {
  expect(reasonRankOf('SERVICE_ID_RANGE')).toBeLessThan(reasonRankOf('NAME_FORM'));
  expect(reasonRankOf('NAME_FORM')).toBeLessThan(reasonRankOf('NAME_UNIQUE'));
  expect(Object.values(IdentityReason)).toEqual(['out of its range', 'off its form']);
});
