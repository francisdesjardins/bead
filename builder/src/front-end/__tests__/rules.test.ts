import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import type { IMessageEntry } from '../../model/blueprint.ts';

const SPEC = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../../test/messages/', import.meta.url));

const messagesOf = (
  roots: readonly string[],
  files?: readonly string[]
): Map<string, IMessageEntry> => {
  const checked = checkRoots(roots, files === undefined ? {} : { files });

  expect(checked.diagnostics).toEqual([]);

  return new Map(
    (checked.blueprint?.proto?.messages ?? []).map((message) => {
      return [message.fullName, message] as const;
    })
  );
};

test("reads a field's rules in protobuf's JSON mapping by proto names, a float widened to the double it is and a 64-bit integer as strings, its type and presence beside them", () => {
  const messages = messagesOf([SPEC], ['validations.proto']);
  const fields = (name: string) => {
    return messages.get(`bead.validations.v1.${name}`)?.rules?.fields ?? [];
  };

  expect(fields('Floats')[0]).toEqual({
    fieldName: 'above_tenth',
    fieldNumber: 1,
    presence: 'explicit',
    rules: { float: { gt: '0.10000000149011612' } },
    type: { scalar: 'float' },
  });
  expect(fields('Floats')[3]?.rules).toEqual({ double: { in: ['-Infinity', '1'] } });
  expect(fields('Numbers')[10]?.rules).toEqual({ int64: { lt: '-9007199254740993' } });
  expect(fields('Presence')[5]).toEqual({
    fieldName: 'skipped_zero',
    fieldNumber: 6,
    presence: 'implicit',
    rules: { ignore: 'IGNORE_IF_ZERO_VALUE', int32: { gt: 5 } },
    type: { scalar: 'int32' },
  });
  expect(fields('Wrappers')[1]).toEqual({
    fieldName: 'title',
    fieldNumber: 2,
    presence: 'explicit',
    rules: { required: true, string: { min_len: '1' } },
    type: { wrapper: 'string' },
  });
  expect(fields('Maps')[0]).toMatchObject({ key: 'string', label: 'map', presence: 'implicit' });
});

test("lists a message's fields by number, those that lead to a rule and those its oneof names among them, its own oneof rules and its oneofs'", () => {
  const messages = messagesOf([SPEC], ['validations.proto']);
  const order = messages.get('bead.validations.v1.Order')?.rules;
  const nested = messages.get('bead.validations.v1.Nested')?.rules;

  expect(
    order?.fields.map((field) => {
      return field.fieldName;
    })
  ).toEqual(['inner', 'early', 'p', 'q', 'late']);
  expect(order?.message).toEqual({ oneof: [{ fields: ['p', 'q'], required: true }] });
  expect(order?.oneofs).toEqual([
    { oneofIndex: 0, oneofName: 'choice', rules: { required: true } },
  ]);
  expect(
    nested?.fields.map((field) => {
      return [field.fieldName, field.type, field.rules === undefined];
    })
  ).toEqual([
    ['inner', { message: 'bead.validations.v1.Inner' }, true],
    ['pair', { message: 'bead.validations.v1.Pair' }, true],
    ['pairs', { message: 'bead.validations.v1.Pair' }, true],
    ['deep', { message: 'bead.validations.v1.Nested' }, true],
  ]);
  // * a result's message is listed, as a binding names it, its fields, none, and no rules
  expect(messages.get('bead.validations.v1.Taken')).toEqual({
    fields: [],
    file: 'validations.proto',
    fullName: 'bead.validations.v1.Taken',
  });
});

test("judges what a request reaches alone: a message its rules reach through a field is listed with its rules, a result's never", () => {
  const messages = messagesOf([MESSAGES]);

  expect(messages.get('bead.messages.v1.Member')?.rules).toBeDefined();
  expect(messages.get('bead.messages.v1.Address')?.rules?.fields).toEqual([
    {
      fieldName: 'country',
      fieldNumber: 1,
      presence: 'implicit',
      rules: { string: { len: '2', pattern: '^[A-Z]{2}$' } },
      type: { scalar: 'string' },
    },
  ]);
  expect(messages.get('bead.messages.v1.Member.Receipt')?.rules).toBeUndefined();
  expect(messages.get('bead.messages.v1.Greeting')?.rules).toBeUndefined();
});
