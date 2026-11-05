// ── Depth ─────────────────────────────────────────────────────────────────────

// A `proto` writer's depth pass (spec 17.2, 17.9.3; decision 0031): a walk of a value's known
// fields as the wire nests them, before protobuf-es builds any of it, so that no recursion is
// reached; the bound itself is the reader's check over the written bytes.

// dependencies

import type { DescField, DescMessage, JsonObject, JsonValue } from '@bufbuild/protobuf';
import { isWrapperDesc } from '@bufbuild/protobuf/wkt';
import { nestsPastOf, PROTO_DEPTH, PROTO_REASONS } from './records';

// types

/** A field that may hold a message: a message field, a list or a map. */
type HoldingField = Extract<DescField, { fieldKind: 'message' | 'list' | 'map' }>;

// constants

const STRUCT = 'google.protobuf.Struct';
const VALUE = 'google.protobuf.Value';

// helpers

/** Whether `value` is an object a walk looks into: a message, its initializer, a list or a map. */
const isObject = (value: unknown): value is object => {
  return typeof value === 'object' && value !== null;
};

/**
 * A field's value as protobuf-es holds it, or as its initializer gives it: a oneof's member's under
 * the oneof's name, as `{ case, value }`, where it is the one set.
 */
const valueOf = (message: object, field: DescField): unknown => {
  const held = message as Record<string, unknown>;

  if (field.oneof === undefined) {
    return held[field.localName];
  }

  const chosen = held[field.oneof.localName];

  return isObject(chosen) && (chosen as { case?: unknown }).case === field.localName
    ? (chosen as { value?: unknown }).value
    : undefined;
};

/**
 * Whether a JSON value, as the `Value` it stands for at `depth`, nests a message past the bound: an
 * array a `ListValue` below it and its items' `Value`s below that, an object a `Struct` below it.
 */
const valueNestsPast = (value: JsonValue, depth: number): boolean => {
  if (depth > PROTO_DEPTH) {
    return true;
  }

  if (Array.isArray(value)) {
    return (
      depth + 1 > PROTO_DEPTH ||
      value.some((item) => {
        return valueNestsPast(item, depth + 2);
      })
    );
  }

  return isObject(value) && jsonNestsPast(value, depth + 1);
};

/** Whether `given`, a message of `schema` at `depth` or its initializer, nests one past the bound. */
const messageNestsPast = (
  schema: DescMessage,
  { depth, given }: { depth: number; given: unknown }
): boolean => {
  if (!isObject(given)) {
    return false;
  }

  return schema.fields.some((field) => {
    return fieldNestsPast(field, { depth, value: valueOf(given, field) });
  });
};

/** The message a field holds, its list's items' or its map's values'; none of scalars or enums. */
const heldMessageOf = (field: HoldingField): DescMessage | undefined => {
  switch (field.fieldKind) {
    case 'message':
      return field.message;
    case 'list':
      return field.listKind === 'message' ? field.message : undefined;
    case 'map':
      return field.mapKind === 'message' ? field.message : undefined;
  }
};

/** Whether a message `field` holds, `held`, at `depth`, nests one past the bound. */
const heldNestsPast = (
  field: HoldingField,
  { depth, held }: { depth: number; held: unknown }
): boolean => {
  const schema = heldMessageOf(field);

  if (schema === undefined || held === undefined || held === null) {
    return false;
  }

  if (depth > PROTO_DEPTH) {
    return true;
  }

  // * a wrapper of a singular field outside a oneof is held as its scalar: one message, no more
  if (
    !isObject(held) ||
    (field.fieldKind === 'message' && field.oneof === undefined && isWrapperDesc(schema))
  ) {
    return false;
  }

  // ! protobuf-es holds a Struct of a field as a JSON object, but in a Value
  if (schema.typeName === STRUCT && field.parent.typeName !== VALUE) {
    return jsonNestsPast(held as JsonObject, depth);
  }

  return messageNestsPast(schema, { depth, given: held });
};

/** Whether what `field` holds, `value`, in a message at `depth`, nests one past the bound. */
const fieldNestsPast = (
  field: DescField,
  { depth, value }: { depth: number; value: unknown }
): boolean => {
  switch (field.fieldKind) {
    case 'message':
      return heldNestsPast(field, { depth: depth + 1, held: value });
    case 'list':
      return (
        Array.isArray(value) &&
        value.some((item) => {
          return heldNestsPast(field, { depth: depth + 1, held: item });
        })
      );
    case 'map': {
      const items = isObject(value) ? Object.values(value) : [];

      // * an entry is a message on the wire, a map of scalars' among them; its message value one more
      if (items.length === 0) {
        return false;
      }

      return (
        depth + 1 > PROTO_DEPTH ||
        items.some((item) => {
          return heldNestsPast(field, { depth: depth + 2, held: item });
        })
      );
    }
    case 'enum':
    case 'scalar':
      return false;
  }
};

// definition

/**
 * Whether a JSON object protobuf-es holds of a `google.protobuf.Struct`, that `Struct` at `depth`
 * below the top message, nests a message more than 100 deep below it (spec 17.9.3): a member a
 * map's entry below the `Struct` and its `Value` below that, three messages a level. The HTTP
 * gateway's writer counts with it too.
 */
export const jsonNestsPast = (object: JsonObject, depth: number): boolean => {
  if (depth > PROTO_DEPTH) {
    return true;
  }

  return Object.values(object).some((member) => {
    return valueNestsPast(member ?? null, depth + 2);
  });
};

/**
 * Refuses `given`, a message of `schema` or its initializer, where its known fields nest a message
 * more than 100 deep below it (spec 17.2, 17.9.3), as the wire nests them: a message field, an
 * item and a group one each, a oneof's message member among them; a map's entry one, a map of
 * scalars' among them, and its message value one more; a `Struct` held as a JSON object three a
 * level. The refusal is the writer's, a `TypeError` of `nested past 100`. The walk is bounded at
 * 101 frames, and skipped where `schema`'s fields cannot nest so deep; it counts less than the
 * wire where a value holds what a reading kept, an extension or an `Any`'s bytes, never more.
 */
export const assertProtoDepth = (schema: DescMessage, given: unknown): void => {
  if (nestsPastOf(schema) && messageNestsPast(schema, { depth: 0, given })) {
    throw new TypeError(PROTO_REASONS.nestedPast100, {
      cause: new TypeError(
        `a proto value nests a message more than ${String(PROTO_DEPTH)} deep below the top one`
      ),
    });
  }
};
