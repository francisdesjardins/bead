// ── Descriptors ───────────────────────────────────────────────────────────────

// What beadc reads of a protobuf descriptor alike in the front end and in every target's
// validators: a message's field by its number, and the enum or the message a field holds, a
// singular one's, an item's or a map value's. This module imports types alone.

// dependencies

import type { DescEnum, DescField, DescMessage } from '@bufbuild/protobuf';

import type { IFieldRulesEntry } from './model/blueprint.ts';

// definition

/** The field of `message` a rules entry names, by its number; an error where it holds none. */
export const fieldOf = (message: DescMessage, entry: IFieldRulesEntry): DescField => {
  const field = message.fields.find((each) => {
    return each.number === entry.fieldNumber;
  });

  if (field === undefined) {
    throw new Error(`${message.typeName} holds no field ${String(entry.fieldNumber)}`);
  }

  return field;
};

/** The enum a field names, a singular one's, an item's or a map value's. */
export const enumOfField = (field: DescField): DescEnum | undefined => {
  return field.fieldKind === 'enum' ||
    (field.fieldKind === 'list' && field.listKind === 'enum') ||
    (field.fieldKind === 'map' && field.mapKind === 'enum')
    ? field.enum
    : undefined;
};

/** The message a field holds, a singular one's, an item's or a map value's. */
export const messageOfField = (field: DescField): DescMessage | undefined => {
  return field.fieldKind === 'message' ||
    (field.fieldKind === 'list' && field.listKind === 'message') ||
    (field.fieldKind === 'map' && field.mapKind === 'message')
    ? field.message
    : undefined;
};
