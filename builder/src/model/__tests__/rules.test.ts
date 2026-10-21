import { expect, test } from '@playwright/test';

import type { IMessageRules } from '../blueprint.ts';
import { canonicalOf, compareNumbers, type IMessagePlan, messagePlanOf } from '../rules.ts';

const planOf = (rules: IMessageRules): IMessagePlan => {
  return messagePlanOf('x.v1.Request', { rules, judged: new Set(['x.v1.Request']) });
};

test("judges a field's rules by their members' numbers, a range at its lower member, an upper bound alone at its own", () => {
  const plan = planOf({
    fields: [
      {
        fieldName: 'count',
        fieldNumber: 2,
        presence: 'explicit',
        rules: { int32: { const: 3, in: [3], lt: 10 } },
        type: { scalar: 'int32' },
      },
      {
        fieldName: 'name',
        fieldNumber: 1,
        presence: 'implicit',
        rules: { string: { len: '3', min_len: '1', not_contains: '-', in: ['abc'] } },
        type: { scalar: 'string' },
      },
      {
        fieldName: 'range',
        fieldNumber: 3,
        presence: 'explicit',
        rules: { int64: { in: ['5'], lte: '10', gt: '0' } },
        type: { scalar: 'int64' },
      },
    ],
    message: {},
    oneofs: [],
  });

  expect(
    plan.fields.map((field) => {
      return [
        field.entry.fieldName,
        ...field.value.judgments.map((judgment) => {
          return judgment.site.ruleId;
        }),
      ];
    })
  ).toEqual([
    ['name', 'string.min_len', 'string.in', 'string.len', 'string.not_contains'],
    ['count', 'int32.const', 'int32.lt', 'int32.in'],
    ['range', 'int64.gt_lte', 'int64.in'],
  ]);
  expect(plan.fields[2]?.value.judgments[0]?.site).toEqual({
    ruleId: 'int64.gt_lte',
    message: 'must be greater than 0 and less than or equal to 10',
    bounds: { gt: '0', lte: '10' },
    boundsText: '{"gt":"0","lte":"10"}',
    forKey: false,
  });
});

test('takes a range given reversed as the values outside it, its words joined by or, a float written as the double it is', () => {
  const plan = planOf({
    fields: [
      {
        fieldName: 'ratio',
        fieldNumber: 1,
        presence: 'explicit',
        rules: { float: { gte: '0.10000000149011612', lt: '-1' } },
        type: { scalar: 'float' },
      },
    ],
    message: {},
    oneofs: [],
  });
  const [judgment] = plan.fields[0]?.value.judgments ?? [];

  expect(judgment?.site.ruleId).toBe('float.gte_lt_exclusive');
  expect(judgment?.site.message).toBe(
    'must be greater than or equal to 0.10000000149011612 or less than -1'
  );
  expect(judgment?.site.boundsText).toBe('{"gte":0.10000000149011612,"lt":-1}');
  expect(judgment?.test).toMatchObject({ test: 'range', exclusive: true });
});

test("a field a message's oneof names takes IGNORE_IF_ZERO_VALUE unless it states its own, and the oneof's two sites share its bounds", () => {
  const plan = planOf({
    fields: [
      { fieldName: 'a', fieldNumber: 1, presence: 'implicit', type: { scalar: 'string' } },
      {
        fieldName: 'b',
        fieldNumber: 2,
        presence: 'implicit',
        rules: { ignore: 'IGNORE_ALWAYS' },
        type: { scalar: 'string' },
      },
    ],
    message: { oneof: [{ fields: ['a', 'b'], required: true }] },
    oneofs: [],
  });

  expect(
    plan.fields.map((field) => {
      return field.value.ignore;
    })
  ).toEqual(['ifZero', 'always']);
  expect(plan.oneofRules[0]?.many.message).toBe('only one of a, b can be set');
  expect(plan.oneofRules[0]?.none?.message).toBe('one of a, b must be set');
  expect(plan.oneofRules[0]?.none?.boundsText).toBe('{"fields":["a","b"],"required":true}');
});

test("writes a bound's JSON in section 17.7's form, and compares numbers as their type does", () => {
  expect(canonicalOf({ lte: 1e21, gt: 0.1, b: 'a"\t', a: [true, -0] })).toBe(
    '{"a":[true,0],"b":"a\\"\\t","gt":0.1,"lte":1e+21}'
  );
  expect(
    compareNumbers(
      { kind: 'int64', text: '9007199254740993' },
      { kind: 'int64', text: '9007199254740992' }
    )
  ).toBe(1);
  expect(compareNumbers({ kind: 'double', text: '-Infinity' }, { kind: 'double', text: '0' })).toBe(
    -1
  );
});
