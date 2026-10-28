// ── Required ──────────────────────────────────────────────────────────────────

// The walk of spec 17.9.7 over a message protobuf-es holds, for the first field of
// `LEGACY_REQUIRED` presence it leaves unset: its reader takes one, so Bead walks after the read
// and before the write, by its records' shape (decision 0042).

// dependencies

import { type DescField, type DescMessage, type Message, ScalarType } from '@bufbuild/protobuf';
import { requiredShapeOf } from './records';
import { entriesByKey } from './validate';

// types

/** Where a field left unset is: each field on the way, an item's index, a map's key; the field last. */
export type RequiredPath = readonly (DescField | number | string)[];

// helpers

/** A field's value as protobuf-es holds it, a oneof's member's where it is the one set. */
const valueOf = (message: Message, field: DescField): unknown => {
  const held = message as unknown as Record<string, unknown>;

  if (field.oneof === undefined) {
    return held[field.localName];
  }

  const chosen = held[field.oneof.localName] as { case?: string; value?: unknown } | undefined;

  return chosen?.case === field.localName ? chosen.value : undefined;
};

/**
 * Whether `message` holds a value of a required field: one it was set to, as protobuf-es's writer
 * judges it, and of a closed enum a number its enum declares (protobuf's "Required Is Forever").
 */
const isHeld = (message: Message, field: DescField): boolean => {
  const value = (message as unknown as Record<string, unknown>)[field.localName];

  if (value === undefined || !Object.hasOwn(message, field.localName)) {
    return false;
  }

  return (
    field.fieldKind !== 'enum' || field.enum.open || field.enum.value[value as number] !== undefined
  );
};

/** The order of spec 18.5 a map's keys are taken in, by its key's scalar. */
const orderOf = (key: ScalarType): 'bool' | 'integer' | 'string' => {
  if (key === ScalarType.BOOL) {
    return 'bool';
  }

  return key === ScalarType.STRING ? 'string' : 'integer';
};

/** The walk below `message` of `schema`, the path from it to the first field unset; none if none is. */
const walk = (schema: DescMessage, message: Message): RequiredPath | undefined => {
  const shape = requiredShapeOf(schema);

  if (shape === undefined) {
    return undefined;
  }

  // * its own fields first, by number, then each message it holds, depth first
  for (const field of shape.required) {
    if (!isHeld(message, field)) {
      return [field];
    }
  }

  for (const field of shape.holders) {
    const below = walkHolder(field, valueOf(message, field));

    if (below !== undefined) {
      return [field, ...below];
    }
  }

  return undefined;
};

/** The walk of what `field` holds, `value`: a message, a list's items by index, a map's values by key. */
const walkHolder = (field: DescField, value: unknown): RequiredPath | undefined => {
  if (value === undefined) {
    return undefined;
  }

  switch (field.fieldKind) {
    case 'message':
      return walk(field.message, value as Message);
    case 'list': {
      if (field.listKind !== 'message') {
        return undefined;
      }

      for (const [index, item] of (value as readonly Message[]).entries()) {
        const below = walk(field.message, item);

        if (below !== undefined) {
          return [index, ...below];
        }
      }

      return undefined;
    }
    case 'map': {
      if (field.mapKind !== 'message') {
        return undefined;
      }

      for (const [key, item] of entriesByKey(
        value as Readonly<Record<string, Message>>,
        orderOf(field.mapKey)
      )) {
        const below = walk(field.message, item);

        if (below !== undefined) {
          return [key, ...below];
        }
      }

      return undefined;
    }
    case 'enum':
    case 'scalar':
      return undefined;
  }
};

// definition

/**
 * The path to the first field of `LEGACY_REQUIRED` presence that `message` of `schema` leaves
 * unset, in spec 17.9.7's order, or none: a message's own fields first, by number, then each
 * message it holds, depth first, by field number, a repeated field's items by index and a map's
 * values by key in 18.5's order. A closed enum's number its enum does not declare is no value of
 * it. An extension and an `Any`'s message are not looked into.
 */
export const unsetPathOf = (schema: DescMessage, message: Message): RequiredPath | undefined => {
  return walk(schema, message);
};

/** The full name of the field a path leaves unset, its last: `package.Message.field`. */
export const unsetNameOf = (path: RequiredPath): string => {
  const field = path.at(-1);

  return typeof field === 'object' ? `${field.parent.typeName}.${field.name}` : '';
};
