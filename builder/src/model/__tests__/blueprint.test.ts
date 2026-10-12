import { readdirSync, readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { checkValue, readBlueprint } from '../blueprint.ts';
import { formOf } from '../form.ts';
import { applyPatch, blueprintCases } from './patch.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);
const RAW = new URL('../../../test/form/BLUEPRINT_JSON/', import.meta.url);
const VERDICTS = 'verdicts.json';

const interop = (): unknown => {
  return JSON.parse(readFileSync(INTEROP, 'utf8'));
};

// a value read as a blueprint's text in its form, as `form.ts` writes it
const read = (value: unknown): ReturnType<typeof readBlueprint> => {
  return readBlueprint(new TextEncoder().encode(formOf(value)), { file: 'case.json' });
};

const verdictsOf = (
  diagnostics: ReturnType<typeof readBlueprint>['diagnostics']
): { rule: string; pointer: string | undefined }[] => {
  return diagnostics.map((diagnostic) => {
    return { rule: diagnostic.rule, pointer: diagnostic.pointer };
  });
};

test("the interop's blueprint passes", () => {
  const reading = readBlueprint(readFileSync(INTEROP), { file: 'interop-blueprint.json' });

  expect(reading.diagnostics).toEqual([]);
  expect(reading.blueprint?.services[0]?.procedures).toHaveLength(18);
});

test('each case of test/blueprints/ and test/form/BLUEPRINT_JSON/ gives its rule at its pointer', () => {
  const cases = blueprintCases();
  const verdicts = JSON.parse(readFileSync(new URL(VERDICTS, RAW), 'utf8')) as Record<
    string,
    { pointer: string; line: number; column: number }[]
  >;
  const raw = readdirSync(RAW).filter((file) => {
    return file !== VERDICTS;
  });

  expect(cases.length).toBeGreaterThan(0);

  for (const each of cases) {
    const reading = read(applyPatch(interop(), each.patch));

    expect(verdictsOf(reading.diagnostics), `${each.rule}/${each.name}`).toEqual(each.findings);
    expect(
      reading.diagnostics.some((diagnostic) => {
        return diagnostic.rule === each.rule;
      }),
      `${each.rule}/${each.name} gives its folder's rule`
    ).toBe(true);
  }

  expect(raw.toSorted()).toEqual(Object.keys(verdicts).toSorted());

  for (const file of raw) {
    const reading = readBlueprint(readFileSync(new URL(file, RAW)), { file });

    expect(
      reading.diagnostics.map((diagnostic) => {
        return {
          rule: diagnostic.rule,
          pointer: diagnostic.pointer,
          line: diagnostic.line,
          column: diagnostic.column,
        };
      }),
      file
    ).toEqual(
      (verdicts[file] ?? []).map((verdict) => {
        return { rule: 'BLUEPRINT_JSON', ...verdict };
      })
    );
  }
});

test('bytes no UTF-8 writes are BLUEPRINT_JSON, at their offset', () => {
  const head = new TextEncoder().encode('{\n  "description": "');
  const bytes = new Uint8Array([...head, 0xed, 0xa0, 0x80, 0x22, 0x0a, 0x7d, 0x0a]);
  const reading = readBlueprint(bytes, { file: 'case.json' });

  expect(reading.diagnostics).toHaveLength(1);
  expect(reading.diagnostics[0]).toMatchObject({ rule: 'BLUEPRINT_JSON', line: 2, column: 19 });
  expect(reading.diagnostics[0]?.message).toContain(`byte ${String(head.length)}`);
});

test('each mapped place of the schema gives its rule, one finding a place', () => {
  const places = [
    ['/services/0/serviceId', 0, 'SERVICE_ID_RANGE'],
    ['/services/0/serviceRevision', 2147483648, 'SERVICE_REVISION_RANGE'],
    ['/services/0/procedures/0/procedureId', 0, 'PROCEDURE_ID_RANGE'],
    ['/services/0/failures/1/code', 65536, 'FAILURE_CODE'],
    ['/services/0/procedures/0/maximumPayloadBytes', 0, 'PROCEDURE_LIMIT_RANGE'],
    ['/services/0/serviceName', 'interop', 'NAME_FORM'],
    ['/services/0/procedures/0/procedureName', 'echo\n', 'NAME_FORM'],
    ['/services/0/procedures/4/admission/hook', 'Write', 'NAME_FORM'],
  ] as const;

  for (const [pointer, value, rule] of places) {
    const op = pointer.endsWith('maximumPayloadBytes') ? 'add' : 'replace';
    const reading = read(applyPatch(interop(), [{ op, path: pointer, value }]));

    expect(verdictsOf(reading.diagnostics), pointer).toEqual([{ rule, pointer }]);
  }
});

test('an admission {} is ADMISSION_EMPTY, alone', () => {
  const value = applyPatch(interop(), [
    { op: 'replace', path: '/services/0/procedures/0/admission', value: {} },
  ]);
  const reading = checkValue(value, {
    placeOf: (pointer) => {
      return { file: 'case.json', pointer };
    },
  });

  expect(verdictsOf(reading.diagnostics)).toEqual([
    { rule: 'ADMISSION_EMPTY', pointer: '/services/0/procedures/0/admission' },
  ]);
});

test('a newer specVersion is SPEC_VERSION_NEWER, a warning', () => {
  const newer = read(
    applyPatch(interop(), [{ op: 'replace', path: '/specVersion', value: '99.0.0' }])
  );
  const older = read(
    applyPatch(interop(), [{ op: 'replace', path: '/specVersion', value: '0.0.1' }])
  );

  expect(newer.diagnostics).toHaveLength(1);
  expect(newer.diagnostics[0]).toMatchObject({ rule: 'SPEC_VERSION_NEWER', severity: 'warning' });
  expect(newer.blueprint).toBeDefined();
  expect(older.diagnostics).toEqual([]);
});

test('the order: a stage that finds an error ends the reading', () => {
  // a member twice and an unknown format: the JSON's stage alone
  const twice = readBlueprint(
    new TextEncoder().encode('{"format": "bead-blueprint/2", "format": "bead-blueprint/2"}'),
    { file: 'case.json' }
  );
  // an unknown format and an unknown feature: the format's stage alone
  const format = read(
    applyPatch(interop(), [
      { op: 'replace', path: '/format', value: 'bead-blueprint/2' },
      { op: 'replace', path: '/requires', value: ['typed-json'] },
    ])
  );
  // an unknown feature and a schema's refusal: the features' stage alone
  const feature = read(
    applyPatch(interop(), [
      { op: 'replace', path: '/requires', value: ['typed-json'] },
      { op: 'replace', path: '/services/0/serviceId', value: 0 },
    ])
  );
  // a schema's refusal and a rule that spans entries: the schema's stage alone
  const schema = read(
    applyPatch(interop(), [
      { op: 'replace', path: '/services/0/serviceRevision', value: 0 },
      { op: 'replace', path: '/services/0/procedures/1/procedureId', value: 1 },
    ])
  );

  const rulesOf = (reading: ReturnType<typeof readBlueprint>): string[] => {
    return reading.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    });
  };

  expect(rulesOf(twice)).toEqual(['BLUEPRINT_JSON']);
  expect(rulesOf(format)).toEqual(['FORMAT_UNKNOWN']);
  expect(rulesOf(feature)).toEqual(['FEATURE_UNKNOWN']);
  expect(rulesOf(schema)).toEqual(['SERVICE_REVISION_RANGE']);
});

test('with rules off, a reading ends after the schema', () => {
  // two names one as 16.6 folds them, which the rules that span entries refuse, and a newer spec
  const value = applyPatch(interop(), [
    { op: 'replace', path: '/services/0/procedures/1/procedureName', value: 'eCho' },
    { op: 'replace', path: '/specVersion', value: '99.0.0' },
  ]);
  const off = readBlueprint(new TextEncoder().encode(formOf(value)), {
    file: 'case.json',
    rules: false,
  });

  expect(verdictsOf(read(value).diagnostics)).toEqual([
    { rule: 'NAME_UNIQUE', pointer: '/services/0/procedures/1/procedureName' },
    { rule: 'SPEC_VERSION_NEWER', pointer: '/specVersion' },
  ]);
  expect(off.diagnostics).toEqual([]);
  expect(off.blueprint?.services[0]?.procedures[1]?.procedureName).toBe('eCho');
  expect(
    verdictsOf(
      checkValue(applyPatch(value, [{ op: 'replace', path: '/services/0/serviceId', value: 0 }]), {
        placeOf: (pointer) => {
          return { file: 'case.json', pointer };
        },
        rules: false,
      }).diagnostics
    )
  ).toEqual([{ rule: 'SERVICE_ID_RANGE', pointer: '/services/0/serviceId' }]);
});
