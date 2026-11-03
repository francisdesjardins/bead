// ── Proto records ─────────────────────────────────────────────────────────────

// A `proto` payload's records, read against its message before protobuf-es reads them (decision
// 0028): what protobuf refuses where the library reads on, what spec 17.9.5 and 17.9.6 level, and
// a singular closed enum's undeclared number, dropped (17.9.8). Its shape is the descriptor's,
// by type alone: no protobuf code loads here.

// dependencies

import type { DescField, DescMessage, ScalarType } from '@bufbuild/protobuf';
import type { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt';

// interfaces

/** What one field's records take: its wire types, what a packed record of it holds, its message's shape. */
interface IFieldShape {
  /**
   * The numbers its enum declares, where it is a singular field of a closed enum, whose record of
   * any other sets nothing (spec 17.9.8); none otherwise, a list's and a map's value among them.
   */
  readonly declared: ReadonlySet<number> | undefined;
  /** The message a record of it holds, a map's entry's or a group's among them; none for a scalar. */
  readonly holds: IMessageShape | undefined;
  /** What a length-delimited record of it holds when packed: its values' fixed width, or varints. */
  readonly packs: number;
  /** The wire types its records take, one bit each. */
  readonly takes: number;
}

/**
 * What spec 17.9.7's walk takes of a message that reaches a field of `LEGACY_REQUIRED` presence:
 * those it declares, and the fields that hold a message reaching one, each by number.
 */
export interface IRequiredShape {
  /** Its singular, repeated and map fields whose message reaches one, a group's among them. */
  readonly holders: readonly DescField[];
  readonly required: readonly DescField[];
}

/** A message's fields by number, and whether it takes a field it does not declare. */
interface IMessageShape {
  readonly fields: Map<number, IFieldShape>;
  /** A map's entry takes its key and its value alone (spec 17.9.6). */
  readonly isClosed: boolean;
  /**
   * How deep its known fields can nest a message below it, as the wire nests them, at most 101
   * (spec 17.9.3): set once its closure is searched.
   */
  nesting?: number;
  /** Its walk's facts once its closure is searched: `null` where it reaches no required field. */
  required?: IRequiredShape | null;
}

/** One walk of a payload: where it is, where the message it is in ends, how deep, in which group. */
interface IReader {
  at: number;
  readonly bytes: Uint8Array;
  depth: number;
  end: number;
  /** The number of the group being read, whose end group closes it; 0 in a length-delimited message. */
  group: number;
  /** Whether it met a singular closed enum's record of a number its enum does not declare. */
  isUndeclared: boolean;
}

/** Where a rewrite writes: its bytes, sized to the payload, and how many it holds. */
interface IOutput {
  at: number;
  readonly bytes: Uint8Array;
}

// constants

// the wire types of protobuf's Encoding guide, "Message Structure"
const VARINT = 0;
const I64 = 1;
const LEN = 2;
const SGROUP = 3;
const EGROUP = 4;
const I32 = 5;

/**
 * How deep a message nests at most below the top one, a group and a map's entry each a message
 * (spec 17.9.3).
 */
export const PROTO_DEPTH = 100;

const DEPTH = PROTO_DEPTH;

// a packed record not taken, and one of varints; any other is its values' fixed width
const NOT_PACKED = 0;
const VARINTS = 1;

const NO_GROUP = 0;

// ! `FeatureSet.FieldPresence.LEGACY_REQUIRED` of descriptor.proto, which protobuf-es gives proto2's
// `required` too: a literal of its type, since no protobuf code loads here
const LEGACY_REQUIRED: FeatureSet_FieldPresence.LEGACY_REQUIRED = 3;

// what a varint's byte at each place is worth, ten places at most
const PLACES = Object.freeze(
  Array.from({ length: 10 }, (_, place) => {
    return 2 ** (7 * place);
  })
);

// the place of a varint's 10th byte, the last, which holds its 64th bit and no other
const LAST_PLACE = PLACES.length - 1;

/**
 * Each scalar type's wire type, by `descriptor.proto`'s type number, which protobuf-es's
 * `ScalarType` carries: keyed by that type, so a type added or renumbered fails the type-check.
 */
const WIRE_OF_SCALAR: Readonly<Record<ScalarType, number>> = Object.freeze({
  1: I64,
  2: I32,
  3: VARINT,
  4: VARINT,
  5: VARINT,
  6: I64,
  7: I32,
  8: VARINT,
  9: LEN,
  12: LEN,
  13: VARINT,
  15: I32,
  16: I64,
  17: VARINT,
  18: VARINT,
});

/**
 * The reasons a `proto` codec refuses with, in spec 17.2's words and no others: a refusal's message
 * is its reason, exactly; what Bead found, the record refused or the field left unset, rides in its
 * `cause`.
 */
export const PROTO_REASONS = Object.freeze({
  nestedPast100: 'nested past 100',
  notItsMessage: 'not its message',
  requiredUnset: 'a required field unset',
});

// an unknown group's shape: any field, each skipped
const ANY_FIELD: IMessageShape = Object.freeze({ fields: new Map(), isClosed: false });

// the bytes of a varint that hold an int32's 32 bits, the last of them holding its top 4
const INT32_PLACES = 5;

// each message's shape, built once, at first use
const SHAPES = new WeakMap<DescMessage, IMessageShape>();

// helpers

/**
 * A refusal of the payload, `reason` one of {@link PROTO_REASONS}: what the check found, `found`,
 * in its cause.
 */
const refuseFor = (reason: string, found: string): never => {
  throw new SyntaxError(reason, { cause: new SyntaxError(`the proto payload ${found}`) });
};

/** A refusal of the payload as no encoding of its message, or one spec 17.9 refuses. */
const refuse = (found: string): never => {
  return refuseFor(PROTO_REASONS.notItsMessage, found);
};

/** What a field's records take at `wire`, a scalar's or an enum's: a repeated one's packed too. */
const scalarShape = (wire: number, isRepeated: boolean): IFieldShape => {
  // * a repeated scalar of a numeric type takes its own wire type and a packed record, packed or not
  if (!isRepeated || wire === LEN) {
    return { declared: undefined, holds: undefined, packs: NOT_PACKED, takes: 1 << wire };
  }

  return {
    declared: undefined,
    holds: undefined,
    packs: wire === VARINT ? VARINTS : wire === I32 ? 4 : 8,
    takes: (1 << wire) | (1 << LEN),
  };
};

/** What a field of a message type's records take: a group's, or a length-delimited record. */
const messageShape = (message: DescMessage, isDelimited: boolean): IFieldShape => {
  return {
    declared: undefined,
    holds: shapeOf(message),
    packs: NOT_PACKED,
    takes: 1 << (isDelimited ? SGROUP : LEN),
  };
};

/** A map's entry, as it is on the wire: a message of its key at 1 and its value at 2 (Encoding, "Maps"). */
const entryShape = (field: Extract<DescField, { fieldKind: 'map' }>): IMessageShape => {
  let value: IFieldShape;

  switch (field.mapKind) {
    case 'message':
      value = messageShape(field.message, false);
      break;
    case 'enum':
      value = scalarShape(VARINT, false);
      break;
    case 'scalar':
      value = scalarShape(WIRE_OF_SCALAR[field.scalar], false);
      break;
  }

  return {
    fields: new Map([
      [1, scalarShape(WIRE_OF_SCALAR[field.mapKey], false)],
      [2, value],
    ]),
    isClosed: true,
  };
};

/** What a field's records take, read from its descriptor; an enum is a varint on the wire. */
const fieldShape = (field: DescField): IFieldShape => {
  switch (field.fieldKind) {
    case 'scalar':
      return scalarShape(WIRE_OF_SCALAR[field.scalar], false);
    case 'enum':
      // * spec 17.9.8: a singular field of a closed enum, as protobuf-es reads the field
      return field.enum.open
        ? scalarShape(VARINT, false)
        : {
            ...scalarShape(VARINT, false),
            declared: new Set(
              field.enum.values.map((value) => {
                return value.number;
              })
            ),
          };
    case 'message':
      return messageShape(field.message, field.delimitedEncoding);
    case 'map':
      return { declared: undefined, holds: entryShape(field), packs: NOT_PACKED, takes: 1 << LEN };
    case 'list':
      switch (field.listKind) {
        case 'message':
          return messageShape(field.message, field.delimitedEncoding);
        case 'enum':
          return scalarShape(VARINT, true);
        case 'scalar':
          return scalarShape(WIRE_OF_SCALAR[field.scalar], true);
      }
  }
};

/**
 * `message`'s shape, built at its first payload and kept by its descriptor: cached before its
 * fields are read, so a message that holds itself names its own shape.
 */
const shapeOf = (message: DescMessage): IMessageShape => {
  const known = SHAPES.get(message);

  if (known !== undefined) {
    return known;
  }

  const fields = new Map<number, IFieldShape>();
  const shape: IMessageShape = { fields, isClosed: false };

  SHAPES.set(message, shape);

  for (const field of message.fields) {
    fields.set(field.number, fieldShape(field));
  }

  return shape;
};

/** Whether `field` is of `LEGACY_REQUIRED` presence: a singular field, outside any oneof. */
const isRequired = (field: DescField): boolean => {
  return field.presence === LEGACY_REQUIRED;
};

/** The message a field's records hold, a list's items' or a map's values' among them; none for a scalar. */
const heldOf = (field: DescField): DescMessage | undefined => {
  switch (field.fieldKind) {
    case 'message':
      return field.message;
    case 'list':
      return field.listKind === 'message' ? field.message : undefined;
    case 'map':
      return field.mapKind === 'message' ? field.message : undefined;
    case 'enum':
    case 'scalar':
      return undefined;
  }
};

/** Fields by number, as spec 17.9.7's walk takes them. */
const byNumber = (one: DescField, other: DescField): number => {
  return one.number - other.number;
};

/**
 * Searches the closure of `root` for what reaches a required field, and sets each shape's walk
 * facts: one least fixed point over the whole closure, cycles included, so no message is judged
 * from a search still under way. A message searched before is taken as it was judged. An `Any`
 * holds its message as bytes and an extension is no field of the descriptor, so neither is reached.
 */
const searchRequired = (root: DescMessage): void => {
  const closure: DescMessage[] = [];
  const seen = new Set<DescMessage>();
  const pending = [root];

  for (let message = pending.pop(); message !== undefined; message = pending.pop()) {
    if (seen.has(message) || shapeOf(message).required !== undefined) {
      continue;
    }

    seen.add(message);
    closure.push(message);

    for (const field of message.fields) {
      const held = heldOf(field);

      if (held !== undefined) {
        pending.push(held);
      }
    }
  }

  const reaching = new Set<DescMessage>();
  const reaches = (message: DescMessage): boolean => {
    const known = shapeOf(message).required;

    return reaching.has(message) || (known !== undefined && known !== null);
  };
  const holds = (field: DescField): boolean => {
    const held = heldOf(field);

    return held !== undefined && reaches(held);
  };

  for (let isMoved = true; isMoved;) {
    isMoved = false;

    for (const message of closure) {
      if (
        !reaching.has(message) &&
        message.fields.some((field) => {
          return isRequired(field) || holds(field);
        })
      ) {
        reaching.add(message);
        isMoved = true;
      }
    }
  }

  for (const message of closure) {
    shapeOf(message).required = reaching.has(message)
      ? {
          holders: message.fields.filter(holds).toSorted(byNumber),
          required: message.fields.filter(isRequired).toSorted(byNumber),
        }
      : null;
  }
};

/** How deep a field of a message nests below it, by `below`, the depth of the message it holds. */
const nestingOf = (field: DescField, below: (held: DescMessage) => number): number => {
  const held = heldOf(field);

  // * a map's entry is a message on the wire, a map of scalars' among them; its message value one more
  if (field.fieldKind === 'map') {
    return held === undefined ? 1 : 2 + below(held);
  }

  return held === undefined ? 0 : 1 + below(held);
};

/**
 * Searches the closure of `root` for how deep each message's known fields can nest below it, at
 * most `DEPTH + 1`: from 0, grown until none grows, so a cycle stops at the cap. A message searched
 * before is taken as it was judged.
 */
const searchNesting = (root: DescMessage): void => {
  const closure: DescMessage[] = [];
  const seen = new Set<DescMessage>();
  const pending = [root];

  for (let message = pending.pop(); message !== undefined; message = pending.pop()) {
    if (seen.has(message) || shapeOf(message).nesting !== undefined) {
      continue;
    }

    seen.add(message);
    closure.push(message);

    for (const field of message.fields) {
      const held = heldOf(field);

      if (held !== undefined) {
        pending.push(held);
      }
    }
  }

  const deepest = new Map<DescMessage, number>(
    closure.map((message) => {
      return [message, 0];
    })
  );
  const below = (held: DescMessage): number => {
    return deepest.get(held) ?? shapeOf(held).nesting ?? 0;
  };

  for (let isGrown = true; isGrown;) {
    isGrown = false;

    for (const message of closure) {
      const deep = Math.min(
        DEPTH + 1,
        Math.max(
          0,
          ...message.fields.map((field) => {
            return nestingOf(field, below);
          })
        )
      );

      if (deep > (deepest.get(message) ?? 0)) {
        deepest.set(message, deep);
        isGrown = true;
      }
    }
  }

  for (const message of closure) {
    shapeOf(message).nesting = deepest.get(message) ?? 0;
  }
};

/**
 * The varint at the reader, ten bytes at most, within 64 bits (Encoding, "Base 128 Varints") and
 * within its message; the reader moves past it.
 */
const readVarint = (reader: IReader): number => {
  const { bytes, end } = reader;
  let value = 0;

  // * an index, not an iterator: a varint costs no object
  for (let place = 0; place < PLACES.length; place += 1) {
    if (reader.at >= end) {
      return refuse('holds a varint past the end of its message');
    }

    const byte = bytes[reader.at] ?? 0;

    reader.at += 1;
    value += (byte & 0x7f) * (PLACES[place] ?? 0);

    if (byte < 0x80) {
      // ! a 10th byte past 0x01 sets a bit past the 64th: no unsigned 64-bit integer, so no
      // encoding, refused here before protobuf-es drops those bits
      if (place === LAST_PLACE && byte > 0x01) {
        refuse('holds a varint past 64 bits');
      }

      return value;
    }
  }

  return refuse('holds a varint of more than 10 bytes');
};

/**
 * The varint at `at` of `bytes`, which the walk took, as protobuf reads an int32: its low 32 bits
 * (Language Guide, "Updating A Message Type"), exact where the varint passes 2^53.
 */
const int32At = (bytes: Uint8Array, at: number): number => {
  let value = 0;

  for (let place = 0; place < INT32_PLACES; place += 1) {
    const byte = bytes[at + place] ?? 0;

    // ! a shift is an int32's: the 5th byte's bits past the 32nd fall away
    value |= (byte & 0x7f) << (7 * place);

    if (byte < 0x80) {
      break;
    }
  }

  return value;
};

/** The tag at the reader: a uint32 varint, five bytes at most (Encoding, its reference card). */
const readTag = (reader: IReader): number => {
  const start = reader.at;
  const tag = readVarint(reader);

  if (reader.at - start > 5) {
    refuse('holds a tag of more than 5 bytes');
  }

  if (tag > 0xffff_ffff) {
    refuse('holds a tag past 32 bits');
  }

  return tag;
};

/** Moves the reader past `width` bytes of a fixed value, within its message. */
const skipFixed = (reader: IReader, width: number): void => {
  if (reader.end - reader.at < width) {
    refuse('holds a fixed value past the end of its message');
  }

  reader.at += width;
};

/** The length at the reader, of a record within its message. */
const readLength = (reader: IReader): number => {
  const length = readVarint(reader);

  if (length > reader.end - reader.at) {
    refuse('holds a length past the end of its message');
  }

  return length;
};

/** Moves the reader past a packed record's values, which end at its end (spec 17.9.1). */
const skipPacked = (reader: IReader, packs: number): void => {
  const length = readLength(reader);

  if (packs !== VARINTS) {
    if (length % packs !== 0) {
      refuse(`holds a packed record of ${String(length)} bytes, no multiple of ${String(packs)}`);
    }

    reader.at += length;
    return;
  }

  const { bytes } = reader;
  const end = reader.at + length;
  // how many bytes the varint being read has carried on, ten at most
  let carried = 0;

  // * no value is read: each varint ends within ten bytes, and the last at the record's end
  for (let at = reader.at; at < end; at += 1) {
    const byte = bytes[at] ?? 0;

    // ! the byte that ends a varint after nine carried ones is its 10th: past 0x01, past 64 bits
    if (byte < 0x80 && carried === LAST_PLACE && byte > 0x01) {
      refuse('holds a varint past 64 bits');
    }

    carried = byte < 0x80 ? 0 : carried + 1;

    if (carried === PLACES.length) {
      refuse('holds a varint of more than 10 bytes');
    }
  }

  if (carried !== 0) {
    refuse('holds a packed record whose last varint runs past its end');
  }

  reader.at = end;
};

/** One more message below the top, or the refusal of spec 17.9.3. */
const deeper = (reader: IReader): number => {
  if (reader.depth >= DEPTH) {
    refuseFor(
      PROTO_REASONS.nestedPast100,
      `nests a message more than ${String(DEPTH)} deep below the top one`
    );
  }

  return reader.depth + 1;
};

/**
 * Walks the records at the reader by `shape`, to the end of their message, or for a group to its
 * own end group, as protobuf parses a message (Encoding, "Message Structure"): a message a record
 * holds by its shape, a packed record by its values, any other skipped.
 */
const walkRecords = (reader: IReader, shape: IMessageShape): void => {
  while (reader.at < reader.end) {
    const tag = readTag(reader);
    const number = tag >>> 3;
    const wire = tag & 7;

    if (number === 0) {
      refuse('holds a field numbered 0');
    }

    if (wire === EGROUP) {
      if (number !== reader.group) {
        refuse(`holds an end group of ${String(number)}, which closes no group`);
      }

      return;
    }

    const field = shape.fields.get(number);

    if (field === undefined && shape.isClosed) {
      refuse("holds a map's entry with a field other than its key and its value (spec 17.9.6)");
    }

    // * spec 17.9.5: protobuf's reference parsers keep such a field as unknown, protobuf-es reads it
    // as its declared type
    if (field !== undefined && (field.takes & (1 << wire)) === 0) {
      refuse(`holds field ${String(number)} at a wire type its type does not take (spec 17.9.5)`);
    }

    switch (wire) {
      case VARINT: {
        const start = reader.at;

        readVarint(reader);

        // * spec 17.9.8: a record that sets nothing, which `filtered` drops
        if (field?.declared !== undefined && !field.declared.has(int32At(reader.bytes, start))) {
          reader.isUndeclared = true;
        }
        break;
      }
      case I64:
        skipFixed(reader, 8);
        break;
      case I32:
        skipFixed(reader, 4);
        break;
      case LEN:
        if (field?.holds !== undefined) {
          const length = readLength(reader);
          const { depth, end, group } = reader;

          reader.depth = deeper(reader);
          reader.end = reader.at + length;
          reader.group = NO_GROUP;
          walkRecords(reader, field.holds);
          reader.depth = depth;
          reader.end = end;
          reader.group = group;
        } else if (field !== undefined && field.packs !== NOT_PACKED) {
          skipPacked(reader, field.packs);
        } else {
          // * a string, bytes, or an unknown record: opaque, as protobuf keeps it; its length read
          // before the reader moves, which `reader.at += readLength(reader)` would not
          const length = readLength(reader);

          reader.at += length;
        }
        break;
      case SGROUP: {
        const { depth, group } = reader;

        reader.depth = deeper(reader);
        reader.group = number;
        walkRecords(reader, field?.holds ?? ANY_FIELD);
        reader.depth = depth;
        reader.group = group;
        break;
      }
      default:
        refuse(`holds the wire type ${String(wire)}, which protobuf has not`);
    }
  }

  if (reader.group !== NO_GROUP) {
    refuse(`holds a group of ${String(reader.group)} never closed`);
  }
};

/** Writes `value` as a varint's shortest form at `at` of `bytes` (Encoding, "Base 128 Varints"). */
const writeVarint = (bytes: Uint8Array, { at, value }: { at: number; value: number }): void => {
  let rest = value;
  let place = at;

  while (rest >= 0x80) {
    bytes[place] = (rest & 0x7f) | 0x80;
    rest >>>= 7;
    place += 1;
  }

  bytes[place] = rest;
};

/** How many bytes a length takes as a varint's shortest form. */
const lengthSizeOf = (length: number): number => {
  let size = 1;

  for (let rest = length; rest >= 0x80; rest >>>= 7) {
    size += 1;
  }

  return size;
};

/**
 * Writes the records at the reader, which the walk took, to `output`, as `shape` reads them, but
 * each singular closed enum's record of a number its enum does not declare, the length of each
 * message that held one written again (spec 17.9.8): to the end of their message, or for a group
 * through its own end group. What it writes is never longer than what it read, so it writes in
 * place of what it read, in one array of the payload's size.
 */
const rewriteRecords = (
  reader: IReader,
  { output, shape }: { output: IOutput; shape: IMessageShape }
): void => {
  const { bytes } = reader;

  while (reader.at < reader.end) {
    const start = reader.at;
    const tag = readTag(reader);
    const field = shape.fields.get(tag >>> 3);

    switch (tag & 7) {
      case EGROUP:
        output.bytes.set(bytes.subarray(start, reader.at), output.at);
        output.at += reader.at - start;
        return;
      case VARINT: {
        const value = reader.at;

        readVarint(reader);

        if (field?.declared !== undefined && !field.declared.has(int32At(bytes, value))) {
          continue;
        }
        break;
      }
      case I64:
        reader.at += 8;
        break;
      case I32:
        reader.at += 4;
        break;
      case LEN: {
        const tagEnd = reader.at;
        const length = readLength(reader);

        if (field?.holds === undefined) {
          reader.at += length;
          break;
        }

        // * the message's records written after room for its length as it came, then its new
        // length, never longer, written in its place and the records moved up to it
        const { end } = reader;
        const lengthAt = output.at + tagEnd - start;
        const room = reader.at - tagEnd;

        output.bytes.set(bytes.subarray(start, tagEnd), output.at);
        output.at = lengthAt + room;
        reader.end = reader.at + length;
        rewriteRecords(reader, { output, shape: field.holds });
        reader.end = end;

        const written = output.at - lengthAt - room;
        const size = lengthSizeOf(written);

        output.bytes.copyWithin(lengthAt + size, lengthAt + room, output.at);
        writeVarint(output.bytes, { at: lengthAt, value: written });
        output.at = lengthAt + size + written;
        continue;
      }
      default:
        // * a group: its tag, then its records through its end group
        output.bytes.set(bytes.subarray(start, reader.at), output.at);
        output.at += reader.at - start;
        rewriteRecords(reader, { output, shape: field?.holds ?? ANY_FIELD });
        continue;
    }

    output.bytes.set(bytes.subarray(start, reader.at), output.at);
    output.at += reader.at - start;
  }
};

/** A walk of `bytes` from their start, as `checkProtoRecords` begins one. */
const readerOf = (bytes: Uint8Array): IReader => {
  return { at: 0, bytes, depth: 0, end: bytes.length, group: NO_GROUP, isUndeclared: false };
};

// definition

/**
 * Reads `bytes`' records against `message`, the descriptor its generated code holds, before
 * protobuf-es reads them, and throws a `SyntaxError` where they are no encoding of it or where
 * spec 17.9 refuses them: a record past the end of its message, at any depth, its field known or
 * not; a packed record whose values do not end at its length; a varint of more than 10 bytes, or
 * whose 10th byte sets a bit past the 64th, its field known or not, packed or not; a tag of more
 * than 5 bytes or past 32 bits, field number 0, the wire types 6 and 7; a group not closed by its
 * own end group; a message nested more than 100 deep below the top one, a group and a map's entry
 * each counting (17.9.3); a field at a wire type its type does not take, in a map's entry too
 * (17.9.5); and a map's entry with a field other than its key and its value (17.9.6).
 * Its message is spec 17.2's reason, `nested past 100` for the depth and `not its message` for any
 * other, the record refused in its `cause`. It reads nothing of the message and allocates nothing
 * per record; each message's shape is built once, from its descriptor. `protoCodecOf` runs it
 * first, through `filtered`, as generated code reads a payload, and again over what its writer
 * wrote.
 *
 * @example
 * import { fromBinary } from '@bufbuild/protobuf';
 * import { checkProtoRecords } from '@francisdesjardins/bead/proto';
 *
 * checkProtoRecords(bytes, SayHelloRequestSchema);
 *
 * const request = fromBinary(SayHelloRequestSchema, bytes, { recursionLimit: 101 });
 */
export const checkProtoRecords = (bytes: Uint8Array, message: DescMessage): void => {
  walkRecords(readerOf(bytes), shapeOf(message));
};

/**
 * `bytes`, checked as `checkProtoRecords` checks them, without each singular closed enum's record
 * of a number its enum declares no value of, the length of each message that held one written
 * again (spec 17.9.8): what protobuf keeps among the unknown fields, protobuf-es then never reads,
 * as every side drops it; the field holds the last declared number its records give, or none.
 * `bytes` themselves where they hold none, which costs nothing past the check.
 */
export const filtered = (bytes: Uint8Array, message: DescMessage): Uint8Array => {
  const walked = readerOf(bytes);

  walkRecords(walked, shapeOf(message));

  if (!walked.isUndeclared) {
    return bytes;
  }

  const output: IOutput = { at: 0, bytes: new Uint8Array(bytes.length) };

  rewriteRecords(readerOf(bytes), { output, shape: shapeOf(message) });

  return output.bytes.subarray(0, output.at);
};

/**
 * Whether the known fields of `message` can nest a message more than 100 deep below it (spec
 * 17.9.3): a cycle among them, or a path that deep, a map's entry counting as a message, a map of
 * scalars' among them. Sound for keeping a walk of a value's fields within the bound, never for the
 * bound itself: any message holds what a reading kept. Searched once, by its descriptor.
 */
export const nestsPastOf = (message: DescMessage): boolean => {
  if (shapeOf(message).nesting === undefined) {
    searchNesting(message);
  }

  return (shapeOf(message).nesting ?? 0) > DEPTH;
};

/**
 * What spec 17.9.7's walk takes of `message`: its fields of `LEGACY_REQUIRED` presence and those
 * that hold a message reaching one; none where it reaches none, which costs one lookup once its
 * closure is searched.
 */
export const requiredShapeOf = (message: DescMessage): IRequiredShape | undefined => {
  if (shapeOf(message).required === undefined) {
    searchRequired(message);
  }

  return shapeOf(message).required ?? undefined;
};
