import { expect, test } from '@playwright/test';

import type { FieldRulesValue, IBlueprint } from '../../model/blueprint.ts';
import { rulesChangedOf, tighteningsOf } from '../rules.ts';

// a blueprint whose one message, x.v1.Request, holds one field of `rules`
const blueprintOf = (rules: FieldRulesValue | undefined): IBlueprint => {
  return {
    format: 'bead-blueprint/1',
    specVersion: '0.7.0',
    requires: ['validate'],
    proto: {
      files: [{ path: 'x/v1/x.proto', package: 'x.v1' }],
      messages: [
        {
          file: 'x/v1/x.proto',
          fullName: 'x.v1.Request',
          rules: {
            fields: [
              {
                fieldName: 'count',
                fieldNumber: 1,
                presence: 'explicit',
                type: { scalar: 'int32' },
                ...(rules === undefined ? {} : { rules }),
              },
            ],
            message: {},
            oneofs: [],
          },
        },
      ],
    },
    reservedServices: { ids: [], names: [] },
    services: [],
  };
};

const tightened = (
  was: FieldRulesValue | undefined,
  now: FieldRulesValue | undefined
): string[] => {
  return tighteningsOf({ earlier: blueprintOf(was), current: blueprintOf(now) }, 'x.v1.Request');
};

test('finds a bound raised or lowered, an inclusive one become exclusive, a rule added, required added, ignore moved toward judging', () => {
  expect(tightened({ int32: { gte: 0 } }, { int32: { gte: 1 } })).toEqual([
    'count: int32.gte raised',
  ]);
  expect(tightened({ int32: { lte: 10 } }, { int32: { lt: 10 } })).toEqual([
    'count: int32.lt lowered',
  ]);
  expect(tightened(undefined, { int32: { gt: 0 } })).toEqual(['count: int32.gt added']);
  expect(tightened({ int32: { gt: 0 } }, { required: true, int32: { gt: 0 } })).toEqual([
    'count: required added',
  ]);
  expect(tightened({ ignore: 'IGNORE_ALWAYS' }, { ignore: 'IGNORE_IF_ZERO_VALUE' })).toEqual([
    'count: ignore moved toward judging, IGNORE_IF_ZERO_VALUE',
  ]);
  expect(tightened({ int32: { in: [1, 2] } }, { int32: { in: [1] } })).toEqual([
    'count: int32.in lost a value',
  ]);
  expect(tightened({ int32: { not_in: [1] } }, { int32: { not_in: [1, 2] } })).toEqual([
    'count: int32.not_in gained a value',
  ]);
});

test("a range given reversed is compared whole, and a rule loosened tightens nothing but changes the request's rules", () => {
  expect(tightened({ int32: { gt: 10, lt: 5 } }, { int32: { gt: 10, lt: 4 } })).toEqual([
    "count: int32's range",
  ]);
  expect(tightened({ int32: { gte: 1 } }, { int32: { gte: 0 } })).toEqual([]);
  expect(tightened({ int32: { gt: 0, example: [1] } }, { int32: { gt: 0, example: [2] } })).toEqual(
    []
  );
  expect(
    rulesChangedOf(
      { earlier: blueprintOf({ int32: { gte: 1 } }), current: blueprintOf({ int32: { gte: 0 } }) },
      'x.v1.Request'
    )
  ).toBe(true);
  expect(
    rulesChangedOf(
      { earlier: blueprintOf({ int32: { gte: 1 } }), current: blueprintOf({ int32: { gte: 1 } }) },
      'x.v1.Request'
    )
  ).toBe(false);
});
