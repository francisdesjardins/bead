import {
  FieldOptionsSchema,
  ListValueSchema,
  NullValueSchema,
  StructSchema,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { enumOfField, fieldOf, messageOfField } from '../descriptors.ts';
import type { IFieldRulesEntry } from '../model/blueprint.ts';

// a rules entry of `fieldNumber`, the one member fieldOf reads
const entryOf = (fieldNumber: number): IFieldRulesEntry => {
  return { fieldName: 'field', fieldNumber, type: { scalar: 'string' }, presence: 'implicit' };
};

test("a message's field by a rules entry's number, and an error where it holds none", () => {
  expect(fieldOf(ValueSchema, entryOf(3)).name).toBe('string_value');
  expect(() => {
    return fieldOf(ValueSchema, entryOf(99));
  }).toThrow('google.protobuf.Value holds no field 99');
});

test('the enum a field names, singular or an item', () => {
  expect(enumOfField(fieldOf(ValueSchema, entryOf(1)))).toBe(NullValueSchema);
  expect(enumOfField(fieldOf(FieldOptionsSchema, entryOf(19)))?.typeName).toBe(
    'google.protobuf.FieldOptions.OptionTargetType'
  );
  expect(enumOfField(fieldOf(ValueSchema, entryOf(3)))).toBeUndefined();
});

test('the message a field holds, singular, an item or a map value', () => {
  expect(messageOfField(fieldOf(ValueSchema, entryOf(5)))).toBe(StructSchema);
  expect(messageOfField(fieldOf(ListValueSchema, entryOf(1)))).toBe(ValueSchema);
  expect(messageOfField(fieldOf(StructSchema, entryOf(1)))).toBe(ValueSchema);
  expect(messageOfField(fieldOf(ValueSchema, entryOf(1)))).toBeUndefined();
});
