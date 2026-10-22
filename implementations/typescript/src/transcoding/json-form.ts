// ── JSON form ─────────────────────────────────────────────────────────────────

// Bead's own mapping of protobuf's JSON (spec/transcoding.md 5, decision 0037): a `proto` body read
// over its message's descriptor, a result written in Bead's proto JSON form, one sequence of bytes on
// every side; the binary payload stays the stock library's.

// dependencies

import {
  create,
  fromBinary,
  isFieldSet,
  type DescEnum,
  type DescField,
  type DescFile,
  type DescMessage,
  type JsonObject,
  type JsonValue,
  type Message,
  ScalarType,
  toBinary,
} from '@bufbuild/protobuf';
import {
  isWrapperDesc,
  AnySchema,
  FeatureSet_FieldPresence,
  BoolValueSchema,
  BytesValueSchema,
  DoubleValueSchema,
  DurationSchema,
  EmptySchema,
  FieldMaskSchema,
  FloatValueSchema,
  Int32ValueSchema,
  Int64ValueSchema,
  ListValueSchema,
  StringValueSchema,
  StructSchema,
  TimestampSchema,
  UInt32ValueSchema,
  UInt64ValueSchema,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { STRICT_UTF8 } from '../router/shared/payloads';
import { ProgrammerError } from '../transport/shared/errors';

// types

/** A JSON value as Bead's mapping reads it: each number with its digits, each object's members in order. */
export type JsonNode =
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'number'; readonly text: string; readonly value: number }
  | { readonly kind: 'object'; readonly members: readonly (readonly [string, JsonNode])[] }
  | { readonly kind: 'string'; readonly value: string };

// interfaces

/**
 * The messages an `Any` may name, by their full names: those of its definitions, and the
 * well-known types (transcoding 5.4.6).
 */
export interface ITypeRegistry {
  readonly messageOf: (typeName: string) => DescMessage | undefined;
}

/** What a reading and a writing are given: the messages an `Any` may name. */
export interface IJsonFormOptions {
  readonly registry: ITypeRegistry;
}

// constants

/** How deep a message nests below the one read or written, as spec 17.9.3 counts it. */
export const MAXIMUM_DEPTH = 100;

/**
 * How deep a JSON text nests at most before its message is read: two levels a message, an array of
 * a repeated field and the object of each item, for 100 below the request and the request's own.
 */
const TEXT_DEPTH = 2 * (MAXIMUM_DEPTH + 1);

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const WHOLE_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;
const TIMESTAMP =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$/u;
const DURATION = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?s$/u;
const CAMEL_SEGMENT = /^[a-z][A-Za-z0-9]*$/u;

// a Timestamp's range, 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999999Z, in seconds
const EARLIEST_SECONDS = -62_135_596_800n;
const LATEST_SECONDS = 253_402_300_799n;
// a Duration's, ±315,576,000,000.999999999 seconds
const LONGEST_SECONDS = 315_576_000_000n;
const NANOS_PER_SECOND = 1_000_000_000;

const SECONDS_PER_DAY = 86_400;

// each type's integers, as 5.3 bounds them
const INT32 = { least: -(2n ** 31n), most: 2n ** 31n - 1n };
const UINT32 = { least: 0n, most: 2n ** 32n - 1n };
const INT64 = { least: -(2n ** 63n), most: 2n ** 63n - 1n };
const UINT64 = { least: 0n, most: 2n ** 64n - 1n };

// the largest power of ten past which no integer of 64 bits is, as a number's exponent
const LARGEST_EXPONENT = 20;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// each character's six bits, the URL-safe alphabet's `-` and `_` beside the standard's `+` and `/`
const SEXTETS: ReadonlyMap<string, number> = new Map([
  ...BASE64.split('').map((character, index) => {
    return [character, index] as const;
  }),
  ['-', 62],
  ['_', 63],
]);

// the well-known types whose JSON is a form of their own, under an `Any`'s `value` (5.4.6)
const OWN_FORMS: ReadonlySet<string> = new Set([
  'google.protobuf.Any',
  'google.protobuf.BoolValue',
  'google.protobuf.BytesValue',
  'google.protobuf.DoubleValue',
  'google.protobuf.Duration',
  'google.protobuf.FieldMask',
  'google.protobuf.FloatValue',
  'google.protobuf.Int32Value',
  'google.protobuf.Int64Value',
  'google.protobuf.ListValue',
  'google.protobuf.StringValue',
  'google.protobuf.Struct',
  'google.protobuf.Timestamp',
  'google.protobuf.UInt32Value',
  'google.protobuf.UInt64Value',
  'google.protobuf.Value',
]);

const WELL_KNOWN: readonly DescMessage[] = [
  AnySchema,
  BoolValueSchema,
  BytesValueSchema,
  DoubleValueSchema,
  DurationSchema,
  EmptySchema,
  FieldMaskSchema,
  FloatValueSchema,
  Int32ValueSchema,
  Int64ValueSchema,
  ListValueSchema,
  StringValueSchema,
  StructSchema,
  TimestampSchema,
  UInt32ValueSchema,
  UInt64ValueSchema,
  ValueSchema,
];

const NULL_VALUE = 'google.protobuf.NullValue';

// the strings a float or a double takes for what is not finite (5.3.3)
const NON_FINITE: Readonly<Record<string, number>> = Object.freeze({
  '-Infinity': Number.NEGATIVE_INFINITY,
  Infinity: Number.POSITIVE_INFINITY,
  NaN: Number.NaN,
});

// helpers

/**
 * A token of a place in a JSON value: a field's JSON name, an item's index, or a member's name or a
 * key the request carried, which a parameter cuts and a pointer stops before past 64 bytes of UTF-8
 * (transcoding 7.4).
 */
export interface IJsonToken {
  readonly isGiven: boolean;
  readonly text: string;
}

/** Where a reading is in the value it reads: the value itself, or a token below a place. */
export interface IJsonPlace {
  readonly token?: IJsonToken | undefined;
  readonly up?: IJsonPlace | undefined;
}

/** Where a request carried what its reading refuses (7.4): among its variables or in its query, or in its body. */
export type RequestPlace = { readonly parameter: string } | { readonly pointer: string };

/** The place of the value a reading reads, its root. */
const ROOT: IJsonPlace = Object.freeze({});

// the bytes of UTF-8 a key of the request is written whole within (spec 18.4)
const KEY_BYTES = 64;

/**
 * A name or a key the request carried, cut as spec 18.4 cuts a key: whole within 64 bytes of UTF-8,
 * else its first 64, back to the start of the character the cut fell in, and `...` after them.
 */
export const cutOf = (text: string): string => {
  const encoder = new TextEncoder();

  if (encoder.encode(text).length <= KEY_BYTES) {
    return text;
  }

  let kept = '';
  let size = 0;

  for (const character of text) {
    const { length } = encoder.encode(character);

    if (size + length > KEY_BYTES) {
      break;
    }

    kept += character;
    size += length;
  }

  return `${kept}...`;
};

/** `text` as a URI's fragment writes it: each character it does not take percent-encoded from its UTF-8. */
export const fragmentOf = (text: string): string => {
  return text.replaceAll(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?]/gu, (character) => {
    return [...new TextEncoder().encode(character)]
      .map((byte) => {
        return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      })
      .join('');
  });
};

/** A JSON Pointer's reference token, `~` and `/` escaped (RFC 6901 §4). */
export const pointerTokenOf = (text: string): string => {
  return text.replaceAll('~', '~0').replaceAll('/', '~1');
};

/**
 * A place's JSON Pointer, as a URI's fragment (RFC 6901 §6): `#`, then each token after a `/`, up to
 * the value that holds a name or a key the request carried past 64 bytes of UTF-8, which a pointer
 * never cuts (7.4).
 */
export const pointerOf = (tokens: readonly IJsonToken[]): string => {
  let pointer = '#';

  for (const { isGiven, text } of tokens) {
    if (isGiven && new TextEncoder().encode(text).length > KEY_BYTES) {
      break;
    }

    pointer += `/${fragmentOf(pointerTokenOf(text))}`;
  }

  return pointer;
};

/** A place's tokens, from the value read. */
const tokensOf = (place: IJsonPlace): IJsonToken[] => {
  const tokens: IJsonToken[] = [];

  for (let at: IJsonPlace | undefined = place; at?.token !== undefined; at = at.up) {
    tokens.unshift(at.token);
  }

  return tokens;
};

/**
 * A reading's or a writing's refusal: its reason, the mapping's own words; where the reading met
 * it, `at`, none for its text's own; and where its request carried it, `place`, which a binding
 * gives it (transcoding 7.4).
 */
export class JsonFormError extends Error {
  /** Why, in the words of transcoding 5, which name nothing the request carried. */
  readonly reason: string;
  /** The tokens of the place the reading met it, from the value read; none for its text's own. */
  readonly at: readonly IJsonToken[] | undefined;
  /** Where its request carried it, a parameter or a pointer of 7.4; none where nothing places it. */
  readonly place: RequestPlace | undefined;

  constructor(
    reason: string,
    { at, place }: { at?: IJsonPlace | undefined; place?: RequestPlace | undefined } = {}
  ) {
    super(reason);
    this.name = 'JsonFormError';
    this.reason = reason;
    this.at = at === undefined ? undefined : tokensOf(at);
    this.place = place;
  }

  /** Its place's pointer, the value read the body whole; none where the reading met it nowhere. */
  get pointer(): string | undefined {
    return this.at === undefined ? undefined : pointerOf(this.at);
  }
}

/**
 * The article a type's name takes, as it is read aloud: `an int32`, `an sint32`, `an Edges`, `an
 * Empty`; `a uint32`, `a fixed32`, `a Timestamp`.
 */
const articleOf = (name: string): string => {
  return /^(?:[aeio]|sint|sfixed)/iu.test(name) ? 'an' : 'a';
};

// a field's place below `at`, by its JSON name; a member's or a key's the request carried; an item's
const fieldAt = (at: IJsonPlace, name: string): IJsonPlace => {
  return { token: { isGiven: false, text: name }, up: at };
};

const givenAt = (at: IJsonPlace, name: string): IJsonPlace => {
  return { token: { isGiven: true, text: name }, up: at };
};

const itemAt = (at: IJsonPlace, index: number): IJsonPlace => {
  return { token: { isGiven: false, text: String(index) }, up: at };
};

// ── The text ──────────────────────────────────────────────────────────────────

/** A JSON text read into its nodes, its depth bounded, every number and name checked (5.2.1). */
const parseText = (text: string): JsonNode => {
  let at = 0;

  const fail = (reason = 'not JSON'): never => {
    throw new JsonFormError(reason);
  };

  const skip = (): void => {
    for (;;) {
      const code = text.charCodeAt(at);

      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return;
      }

      at += 1;
    }
  };

  const readString = (): string => {
    const start = at;

    at += 1;

    for (;;) {
      const code = text.charCodeAt(at);

      if (Number.isNaN(code)) {
        return fail();
      }

      if (code === 0x22) {
        break;
      }

      at += code === 0x5c ? 2 : 1;
    }

    at += 1;

    let value: string;

    try {
      value = JSON.parse(text.slice(start, at)) as string;
    } catch {
      return fail();
    }

    if (!value.isWellFormed()) {
      return fail('a surrogate alone');
    }

    return value;
  };

  const readValue = (depth: number): JsonNode => {
    skip();

    const code = text.charCodeAt(at);

    if (code === 0x7b || code === 0x5b) {
      if (depth >= TEXT_DEPTH) {
        return fail(`nested past ${String(MAXIMUM_DEPTH)}`);
      }

      at += 1;
      skip();

      if (code === 0x5b) {
        const items: JsonNode[] = [];

        if (text.charCodeAt(at) === 0x5d) {
          at += 1;

          return { items, kind: 'array' };
        }

        for (;;) {
          items.push(readValue(depth + 1));
          skip();

          const next = text.charCodeAt(at);

          at += 1;

          if (next === 0x5d) {
            return { items, kind: 'array' };
          }

          if (next !== 0x2c) {
            return fail();
          }
        }
      }

      const members: (readonly [string, JsonNode])[] = [];
      const names = new Set<string>();

      if (text.charCodeAt(at) === 0x7d) {
        at += 1;

        return { kind: 'object', members };
      }

      for (;;) {
        skip();

        if (text.charCodeAt(at) !== 0x22) {
          return fail();
        }

        const name = readString();

        if (names.has(name)) {
          return fail('a member named twice');
        }

        names.add(name);
        skip();

        if (text.charCodeAt(at) !== 0x3a) {
          return fail();
        }

        at += 1;
        members.push([name, readValue(depth + 1)]);
        skip();

        const next = text.charCodeAt(at);

        at += 1;

        if (next === 0x7d) {
          return { kind: 'object', members };
        }

        if (next !== 0x2c) {
          return fail();
        }
      }
    }

    if (code === 0x22) {
      return { kind: 'string', value: readString() };
    }

    for (const [literal, node] of [
      ['true', { kind: 'boolean', value: true }],
      ['false', { kind: 'boolean', value: false }],
      ['null', { kind: 'null' }],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;

        return node;
      }
    }

    NUMBER.lastIndex = at;

    const number = NUMBER.exec(text);

    if (number === null) {
      return fail();
    }

    at += number[0].length;

    const value = Number(number[0]);

    if (!Number.isFinite(value)) {
      return fail('a number past a double');
    }

    return { kind: 'number', text: number[0], value };
  };

  const node = readValue(0);

  skip();

  if (at !== text.length) {
    return fail();
  }

  return node;
};

/**
 * A body's bytes read as one JSON text, as section 17.5 of spec.md reads a `json` payload but for
 * its depth, which the message's descriptor counts, and the digits of each number, which it keeps
 * (transcoding 5.2.1): UTF-8, no byte order mark, one text, no member named twice, no surrogate
 * alone, no number past the largest double. A refusal is a {@link JsonFormError}.
 */
export const readJsonText = (bytes: Uint8Array): JsonNode => {
  let text: string;

  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new JsonFormError('not UTF-8');
  }

  if (text.charCodeAt(0) === 0xfeff) {
    throw new JsonFormError('a byte order mark');
  }

  return parseText(text);
};

// ── Numbers ───────────────────────────────────────────────────────────────────

/**
 * The integer a JSON number's digits write, read exactly: `1e2` and `5.0` among them; none for one
 * that is no integer, and `undefined` past what any 64-bit type holds.
 */
const integerOfDigits = (text: string): bigint | 'fraction' | 'past' => {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(text);

  if (match === null) {
    return 'fraction';
  }

  const [, sign = '', whole = '', fraction = '', exponentText = '0'] = match;
  let digits = `${whole}${fraction}`.replace(/^0+/u, '');
  let exponent = Number(exponentText) - fraction.length;

  if (digits === '') {
    return 0n;
  }

  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;

  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;

  if (exponent < 0) {
    return 'fraction';
  }

  if (digits.length + exponent > LARGEST_EXPONENT + 1) {
    return 'past';
  }

  const magnitude = BigInt(digits) * 10n ** BigInt(exponent);

  return sign === '-' ? -magnitude : magnitude;
};

/** An integer scalar's type: its bounds, whether it holds 64 bits, and its name. */
interface IIntegerType {
  readonly bounds: { readonly least: bigint; readonly most: bigint };
  readonly is64: boolean;
  readonly name: string;
}

// each integer scalar's type, by its scalar
const INTEGER_TYPES: ReadonlyMap<ScalarType, IIntegerType> = new Map([
  [ScalarType.INT32, { bounds: INT32, is64: false, name: 'int32' }],
  [ScalarType.SINT32, { bounds: INT32, is64: false, name: 'sint32' }],
  [ScalarType.SFIXED32, { bounds: INT32, is64: false, name: 'sfixed32' }],
  [ScalarType.UINT32, { bounds: UINT32, is64: false, name: 'uint32' }],
  [ScalarType.FIXED32, { bounds: UINT32, is64: false, name: 'fixed32' }],
  [ScalarType.INT64, { bounds: INT64, is64: true, name: 'int64' }],
  [ScalarType.SINT64, { bounds: INT64, is64: true, name: 'sint64' }],
  [ScalarType.SFIXED64, { bounds: INT64, is64: true, name: 'sfixed64' }],
  [ScalarType.UINT64, { bounds: UINT64, is64: true, name: 'uint64' }],
  [ScalarType.FIXED64, { bounds: UINT64, is64: true, name: 'fixed64' }],
]);

/** The bounds of an integer scalar's type, and whether it holds 64 bits; none for another scalar. */
const integerTypeOf = (scalar: ScalarType): IIntegerType | undefined => {
  return INTEGER_TYPES.get(scalar);
};

/** The shortest decimal that reads back to `value`, a 32-bit float, as Number::toString writes it. */
const shortestFloatOf = (value: number): string => {
  for (let precision = 1; precision < 10; precision += 1) {
    const candidate = Number(value.toPrecision(precision));

    if (Math.fround(candidate) === value) {
      return String(candidate);
    }
  }

  return String(value);
};

/** A double's or a float's JSON (5.6.1, 5.6.6): its token, `"NaN"` and the infinities as strings. */
const numberJsonOf = (value: number, { isFloat }: { isFloat: boolean }): string => {
  if (Number.isNaN(value)) {
    return '"NaN"';
  }

  if (!Number.isFinite(value)) {
    return value > 0 ? '"Infinity"' : '"-Infinity"';
  }

  if (value === 0) {
    return '0';
  }

  return isFloat ? shortestFloatOf(value) : String(value);
};

// ── Base64 ────────────────────────────────────────────────────────────────────

/**
 * The bytes of `text`, base64 of one alphabet, the standard's or the URL-safe one, padded correctly
 * or not at all, the bits its last character holds past its bytes whatever they are (5.3.6).
 */
const bytesOfBase64 = (text: string, at: IJsonPlace): Uint8Array => {
  const padding = /=*$/u.exec(text)?.[0].length ?? 0;
  const body = text.slice(0, text.length - padding);

  if (/[^A-Za-z0-9+/_-]/u.test(body) || (/[+/]/u.test(body) && /[-_]/u.test(body))) {
    throw new JsonFormError('bytes of no one alphabet of base64', { at });
  }

  const rest = body.length % 4;

  if (rest === 1 || (padding > 0 && (padding > 2 || rest + padding !== 4))) {
    throw new JsonFormError('bytes padded wrongly', { at });
  }

  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let count = 0;
  let index = 0;

  for (const character of body) {
    bits = (bits << 6) | (SEXTETS.get(character) ?? 0);
    count += 6;

    if (count >= 8) {
      count -= 8;
      bytes[index] = (bits >> count) & 0xff;
      index += 1;
    }
  }

  return bytes;
};

/** `bytes` in standard base64, padded (5.6.6). */
export const base64Of = (bytes: Uint8Array): string => {
  let text = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[index], bytes[index + 1], bytes[index + 2]];
    const triple = (a << 16) | (b << 8) | c;

    text += BASE64[(triple >> 18) & 63] ?? '';
    text += BASE64[(triple >> 12) & 63] ?? '';
    text += index + 1 < bytes.length ? (BASE64[(triple >> 6) & 63] ?? '') : '=';
    text += index + 2 < bytes.length ? (BASE64[triple & 63] ?? '') : '=';
  }

  return text;
};

// ── Time ──────────────────────────────────────────────────────────────────────

/** The days from 1970-01-01 to a day of the proleptic Gregorian calendar. */
const daysFromCivil = ({
  day,
  month,
  year,
}: {
  day: number;
  month: number;
  year: number;
}): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
};

/** The day of the proleptic Gregorian calendar `days` after 1970-01-01. */
const civilFromDays = (days: number): { day: number; month: number; year: number } => {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;

  return {
    day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
    month,
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
  };
};

const isLeapYear = (year: number): boolean => {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
};

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** Nanoseconds as a fraction of 0, 3, 6 or 9 digits, the fewest that hold them (5.6.7). */
const fractionOf = (nanos: number): string => {
  if (nanos === 0) {
    return '';
  }

  const digits = String(nanos).padStart(9, '0');

  if (nanos % 1_000_000 === 0) {
    return `.${digits.slice(0, 3)}`;
  }

  return nanos % 1000 === 0 ? `.${digits.slice(0, 6)}` : `.${digits}`;
};

const pad = (value: number, width: number): string => {
  return String(value).padStart(width, '0');
};

// ── Fields ────────────────────────────────────────────────────────────────────

/** A message's fields as its members name them, and in its fields' numbers' order. */
interface IFieldsOf {
  readonly byName: ReadonlyMap<string, DescField>;
  readonly ordered: readonly DescField[];
}

const FIELDS = new WeakMap<DescMessage, IFieldsOf>();

const fieldsOf = (schema: DescMessage): IFieldsOf => {
  const known = FIELDS.get(schema);

  if (known !== undefined) {
    return known;
  }

  const byName = new Map<string, DescField>();

  for (const field of schema.fields) {
    byName.set(field.jsonName, field);
    byName.set(field.name, field);
  }

  const fields = {
    byName,
    ordered: schema.fields.toSorted((one, other) => {
      return one.number - other.number;
    }),
  };

  FIELDS.set(schema, fields);

  return fields;
};

/** The field of `schema` a member names, by its JSON name or its proto name; none for no field. */
export const fieldNamed = (schema: DescMessage, name: string): DescField | undefined => {
  return fieldsOf(schema).byName.get(name);
};

// the message a field holds, or each item or value of a repeated or a map field
const messageOfField = (field: DescField): DescMessage | undefined => {
  if (field.fieldKind === 'message') {
    return field.message;
  }

  if (field.fieldKind === 'list' && field.listKind === 'message') {
    return field.message;
  }

  return field.fieldKind === 'map' && field.mapKind === 'message' ? field.message : undefined;
};

const enumOfField = (field: DescField): DescEnum | undefined => {
  if (field.fieldKind === 'enum') {
    return field.enum;
  }

  if (field.fieldKind === 'list' && field.listKind === 'enum') {
    return field.enum;
  }

  return field.fieldKind === 'map' && field.mapKind === 'enum' ? field.enum : undefined;
};

const scalarOfField = (field: DescField): ScalarType | undefined => {
  if (field.fieldKind === 'scalar') {
    return field.scalar;
  }

  if (field.fieldKind === 'list' && field.listKind === 'scalar') {
    return field.scalar;
  }

  return field.fieldKind === 'map' && field.mapKind === 'scalar' ? field.scalar : undefined;
};

/**
 * How protobuf-es holds a message of `field` in its parent: a wrapper of a singular field outside a
 * oneof as its value, a `Struct` of a field of any message but a `Value` as a JSON object; any
 * other as the message.
 */
const localOf = (field: DescField, message: DescMessage): 'message' | 'struct' | 'wrapper' => {
  if (field.fieldKind === 'message' && field.oneof === undefined && isWrapperDesc(message)) {
    return 'wrapper';
  }

  return message.typeName === 'google.protobuf.Struct' &&
    field.parent.typeName !== 'google.protobuf.Value'
    ? 'struct'
    : 'message';
};

// whether a `null` given for a value of the field is a value of its own (5.2.2)
const isNullItself = (field: DescField): boolean => {
  return (
    messageOfField(field)?.typeName === 'google.protobuf.Value' ||
    enumOfField(field)?.typeName === NULL_VALUE
  );
};

// ── Reading ───────────────────────────────────────────────────────────────────

/** What a reading carries down a message: the messages an `Any` names, and its depth. */
interface IReadingOptions {
  readonly at: IJsonPlace;
  readonly depth: number;
  readonly registry: ITypeRegistry;
}

/** A scalar's value of `node`, read as 5.3 pins its type's forms. */
const readScalar = (
  scalar: ScalarType,
  { at, longAsString, node }: { at: IJsonPlace; longAsString: boolean; node: JsonNode }
): unknown => {
  const integer = integerTypeOf(scalar);

  if (integer !== undefined) {
    const { bounds, is64, name } = integer;
    let read: bigint | 'fraction' | 'past';

    if (node.kind === 'number') {
      read = integerOfDigits(node.text);

      if (read === 'fraction') {
        throw new JsonFormError(`${articleOf(name)} ${name} that is no integer`, { at });
      }
    } else if (node.kind === 'string' && is64) {
      if (!INTEGER.test(node.value)) {
        throw new JsonFormError(`${articleOf(name)} ${name} string off -?(0|[1-9][0-9]*)`, { at });
      }

      read = BigInt(node.value);
    } else if (node.kind === 'string' && WHOLE_NUMBER.test(node.value)) {
      read = integerOfDigits(node.value);

      if (read === 'fraction') {
        throw new JsonFormError(`${articleOf(name)} ${name} that is no integer`, { at });
      }
    } else {
      throw new JsonFormError(`no ${name}`, { at });
    }

    if (read === 'past' || read < bounds.least || read > bounds.most) {
      throw new JsonFormError(`${articleOf(name)} ${name} past its range`, { at });
    }

    if (!is64) {
      return Number(read);
    }

    return longAsString ? read.toString() : read;
  }

  if (scalar === ScalarType.DOUBLE || scalar === ScalarType.FLOAT) {
    const name = scalar === ScalarType.FLOAT ? 'float' : 'double';
    let value: number;

    if (node.kind === 'number') {
      ({ value } = node);
    } else if (node.kind === 'string' && WHOLE_NUMBER.test(node.value)) {
      value = Number(node.value);

      if (!Number.isFinite(value)) {
        throw new JsonFormError(`a ${name} past its range`, { at });
      }
    } else if (node.kind === 'string' && Object.hasOwn(NON_FINITE, node.value)) {
      return NON_FINITE[node.value];
    } else {
      throw new JsonFormError(`no ${name}`, { at });
    }

    if (scalar === ScalarType.FLOAT) {
      const float = Math.fround(value);

      if (!Number.isFinite(float)) {
        throw new JsonFormError('a float past its range', { at });
      }

      return float;
    }

    return value;
  }

  if (scalar === ScalarType.BOOL) {
    if (node.kind !== 'boolean') {
      throw new JsonFormError('no bool', { at });
    }

    return node.value;
  }

  if (scalar === ScalarType.STRING) {
    if (node.kind !== 'string') {
      throw new JsonFormError('no string', { at });
    }

    return node.value;
  }

  if (node.kind !== 'string') {
    throw new JsonFormError('no bytes', { at });
  }

  return bytesOfBase64(node.value, at);
};

/** An enum's number of `node`: one of its values' names, or a number its values or its openness take. */
const readEnum = (descEnum: DescEnum, { at, node }: { at: IJsonPlace; node: JsonNode }): number => {
  if (descEnum.typeName === NULL_VALUE && node.kind === 'null') {
    return 0;
  }

  if (node.kind === 'string') {
    const value = descEnum.values.find((candidate) => {
      return candidate.name === node.value;
    });

    if (value === undefined) {
      throw new JsonFormError(`no value of ${descEnum.name} of that name`, { at });
    }

    return value.number;
  }

  if (node.kind !== 'number') {
    throw new JsonFormError(`no ${descEnum.name}`, { at });
  }

  const read = integerOfDigits(node.text);

  if (read === 'fraction') {
    throw new JsonFormError('an enum number that is no integer', { at });
  }

  if (read === 'past' || read < INT32.least || read > INT32.most) {
    throw new JsonFormError('an enum number past its range', { at });
  }

  const number = Number(read);

  if (
    !descEnum.open &&
    !descEnum.values.some((value) => {
      return value.number === number;
    })
  ) {
    throw new JsonFormError(`no value of ${descEnum.name} of that number`, { at });
  }

  return number;
};

/** A map's key of its member's name, in the key's string form, its value canonical (5.3.8). */
const readMapKey = (scalar: ScalarType, { at, key }: { at: IJsonPlace; key: string }): string => {
  if (scalar === ScalarType.STRING) {
    return key;
  }

  if (scalar === ScalarType.BOOL) {
    if (key !== 'true' && key !== 'false') {
      throw new JsonFormError('a bool key that is neither true nor false', { at });
    }

    return key;
  }

  const integer = integerTypeOf(scalar);
  const name = integer?.name ?? 'integer';
  const article = articleOf(name);

  if (integer === undefined || !INTEGER.test(key)) {
    throw new JsonFormError(`${article} ${name} key off -?(0|[1-9][0-9]*)`, { at });
  }

  const value = BigInt(key);

  if (value < integer.bounds.least || value > integer.bounds.most) {
    throw new JsonFormError(`${article} ${name} key past its range`, { at });
  }

  return value.toString();
};

/** A value of `field` of `node`, one item of it where it is repeated or a map (5.2.2, 5.2.3). */
const readValueOf = (field: DescField, node: JsonNode, reading: IReadingOptions): unknown => {
  const message = messageOfField(field);

  if (message !== undefined) {
    const below = { ...reading, depth: reading.depth + 1 };
    const local = localOf(field, message);
    const [inner] = message.fields;

    if (local === 'wrapper' && inner?.fieldKind === 'scalar') {
      assertDepth(below.depth, reading.at);

      return readScalar(inner.scalar, { at: reading.at, longAsString: inner.longAsString, node });
    }

    if (local === 'struct') {
      return localOfStruct(readStruct(node, below));
    }

    return readMessageAt(message, node, below);
  }

  const descEnum = enumOfField(field);

  if (descEnum !== undefined) {
    return readEnum(descEnum, { at: reading.at, node });
  }

  return readScalar(scalarOfField(field) ?? ScalarType.STRING, {
    at: reading.at,
    longAsString: (field as { longAsString?: boolean }).longAsString === true,
    node,
  });
};

/** Throws where a message `depth` below the one read would be built past 17.9.3's bound. */
const assertDepth = (depth: number, at: IJsonPlace): void => {
  if (depth > MAXIMUM_DEPTH) {
    throw new JsonFormError(`nested past ${String(MAXIMUM_DEPTH)}`, { at });
  }
};

/** A Timestamp's seconds and nanoseconds of its RFC 3339 form (5.4.1). */
const readTimestamp = (node: JsonNode, at: IJsonPlace): { nanos: number; seconds: bigint } => {
  if (node.kind !== 'string') {
    throw new JsonFormError('a Timestamp that is no string', { at });
  }

  const match = TIMESTAMP.exec(node.value);

  if (match === null) {
    throw new JsonFormError('a Timestamp off RFC 3339', { at });
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const offset = match[8] ?? 'Z';
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number) as [number, number, number, number, number, number];

  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));

    if (hours > 23 || minutes > 59) {
      throw new JsonFormError('a Timestamp of no offset', { at });
    }
  }

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new JsonFormError('a Timestamp of no instant', { at });
  }

  const offsetSeconds =
    offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60);
  const seconds =
    BigInt(daysFromCivil({ day, month, year })) * BigInt(SECONDS_PER_DAY) +
    BigInt(hour * 3600 + minute * 60 + second - offsetSeconds);

  if (seconds < EARLIEST_SECONDS || seconds > LATEST_SECONDS) {
    throw new JsonFormError('a Timestamp past its range', { at });
  }

  return { nanos: Number(fraction.padEnd(9, '0')), seconds };
};

/** A Duration's seconds and nanoseconds of its form, both of its sign (5.4.2). */
const readDuration = (node: JsonNode, at: IJsonPlace): { nanos: number; seconds: bigint } => {
  const match = node.kind === 'string' ? DURATION.exec(node.value) : null;

  if (match === null) {
    throw new JsonFormError('a Duration off its form', { at });
  }

  const [, minus, whole = '0', fraction = ''] = match;
  const seconds = BigInt(whole);

  if (seconds > LONGEST_SECONDS) {
    throw new JsonFormError('a Duration past its range', { at });
  }

  const sign = minus === undefined ? 1 : -1;
  const nanos = Number(fraction.padEnd(9, '0'));

  return { nanos: nanos === 0 ? 0 : sign * nanos, seconds: sign === 1 ? seconds : -seconds };
};

/** A FieldMask's paths of its form, each read to snake case and held to reverse (5.4.3). */
const readFieldMask = (node: JsonNode, at: IJsonPlace): string[] => {
  if (node.kind !== 'string') {
    throw new JsonFormError('a FieldMask that is no string', { at });
  }

  if (node.value === '') {
    return [];
  }

  return node.value.split(',').map((path) => {
    if (path === '') {
      throw new JsonFormError('a FieldMask of an empty path', { at });
    }

    const segments = path.split('.');

    if (
      !segments.every((segment) => {
        return CAMEL_SEGMENT.test(segment);
      })
    ) {
      throw new JsonFormError('a FieldMask path off lowerCamelCase', { at });
    }

    const snake = path.replaceAll(/[A-Z]/gu, (letter) => {
      return `_${letter.toLowerCase()}`;
    });

    if (camelOf(snake) !== path) {
      throw new JsonFormError('a FieldMask path off lowerCamelCase', { at });
    }

    return snake;
  });
};

/** A snake-case path's lowerCamelCase: each `_` and the lower-case letter after it, that letter upper-case. */
const camelOf = (path: string): string => {
  return path.replaceAll(/_([a-z])/gu, (_match, letter: string) => {
    return letter.toUpperCase();
  });
};

/** A `google.protobuf.Value` of `node`: JSON itself, a number a double's (5.4.5). */
const readValueMessage = (node: JsonNode, reading: IReadingOptions): Message => {
  assertDepth(reading.depth, reading.at);

  const value = create(ValueSchema);
  const below = { ...reading, depth: reading.depth + 1 };

  switch (node.kind) {
    case 'null':
      value.kind = { case: 'nullValue', value: 0 };
      break;
    case 'number':
      value.kind = { case: 'numberValue', value: node.value };
      break;
    case 'string':
      value.kind = { case: 'stringValue', value: node.value };
      break;
    case 'boolean':
      value.kind = { case: 'boolValue', value: node.value };
      break;
    case 'object':
      value.kind = { case: 'structValue', value: readStruct(node, below) };
      break;
    case 'array':
      value.kind = { case: 'listValue', value: readListValue(node, below) };
      break;
  }

  return value;
};

const readStruct = (node: JsonNode, reading: IReadingOptions) => {
  assertDepth(reading.depth, reading.at);

  if (node.kind !== 'object') {
    throw new JsonFormError('a Struct that is no object', { at: reading.at });
  }

  // * its members are a map's entries, messages below it, counted before any is read
  if (node.members.length > 0) {
    assertDepth(reading.depth + 1, reading.at);
  }

  const struct = create(StructSchema);

  for (const [name, member] of node.members) {
    // * a member is a map's entry, a message below the Struct, and its Value one below that
    struct.fields[name] = readValueMessage(member, {
      ...reading,
      at: givenAt(reading.at, name),
      depth: reading.depth + 2,
    }) as (typeof struct.fields)[string];
  }

  return struct;
};

/** A `Value`'s JSON value, as protobuf-es holds a `Struct` of a field. */
const localOfValue = (value: Message): JsonValue => {
  const { kind } = value as Message & { kind: { case: string | undefined; value?: unknown } };

  switch (kind.case) {
    case 'structValue':
      return localOfStruct(kind.value as Message);
    case 'listValue':
      return (kind.value as Message & { values: Message[] }).values.map(localOfValue);
    case 'numberValue':
    case 'stringValue':
    case 'boolValue':
      return kind.value as JsonValue;
    case 'nullValue':
    case undefined:
    default:
      return null;
  }
};

/** A `Struct`'s JSON object, as protobuf-es holds one of a field. */
const localOfStruct = (struct: Message): JsonObject => {
  const { fields } = struct as Message & { fields: Record<string, Message> };
  const object: JsonObject = {};

  for (const [name, value] of Object.entries(fields)) {
    object[name] = localOfValue(value);
  }

  return object;
};

const readListValue = (node: JsonNode, reading: IReadingOptions) => {
  assertDepth(reading.depth, reading.at);

  if (node.kind !== 'array') {
    throw new JsonFormError('a ListValue that is no array', { at: reading.at });
  }

  const list = create(ListValueSchema);

  for (const [index, item] of node.items.entries()) {
    list.values.push(
      readValueMessage(item, {
        ...reading,
        at: itemAt(reading.at, index),
        depth: reading.depth + 1,
      }) as (typeof list.values)[number]
    );
  }

  return list;
};

/** An `Any` of `node`: its `@type`, a message of the registry, then that message's members (5.4.6). */
const readAny = (node: JsonNode, reading: IReadingOptions): Message => {
  const { at, registry } = reading;

  if (node.kind !== 'object') {
    throw new JsonFormError('an Any that is no object', { at });
  }

  const any = create(AnySchema);

  if (node.members.length === 0) {
    return any;
  }

  const typeMember = node.members.find(([name]) => {
    return name === '@type';
  });

  if (typeMember === undefined) {
    throw new JsonFormError('an Any without its @type', { at });
  }

  const [, typeNode] = typeMember;

  if (typeNode.kind !== 'string' || !typeNode.value.includes('/')) {
    throw new JsonFormError('an Any whose @type is no URL', { at });
  }

  const typeName = typeNode.value.slice(typeNode.value.lastIndexOf('/') + 1);
  const schema = registry.messageOf(typeName);

  if (schema === undefined) {
    throw new JsonFormError('an Any of a type its definitions do not hold', { at });
  }

  const rest = node.members.filter(([name]) => {
    return name !== '@type';
  });
  const below = { ...reading, depth: reading.depth + 1 };
  let message: Message;

  if (OWN_FORMS.has(typeName)) {
    const [only] = rest;

    if (rest.length !== 1 || only?.[0] !== 'value') {
      throw new JsonFormError('an Any of a well-known type whose members are not its value alone', {
        at,
      });
    }

    message = readMessageAt(schema, only[1], { ...below, at: fieldAt(at, 'value') });
  } else {
    message = readMessageAt(schema, { kind: 'object', members: rest }, below);
  }

  any.typeUrl = typeNode.value;
  any.value = toBinary(schema, message);

  return any;
};

/** A wrapper of `node`: its value's form, as its scalar's (5.4.4). */
const readWrapper = (
  schema: DescMessage,
  { at, node }: { at: IJsonPlace; node: JsonNode }
): Message => {
  const message = create(schema) as Message & Record<string, unknown>;
  const [field] = schema.fields;

  if (field?.fieldKind === 'scalar') {
    message[field.localName] = readScalar(field.scalar, {
      at,
      longAsString: field.longAsString,
      node,
    });
  }

  return message;
};

/** The well-known type `schema` of `node`, by its own form; none for one read as any message. */
const readWellKnown = (
  schema: DescMessage,
  node: JsonNode,
  reading: IReadingOptions
): Message | undefined => {
  const { at } = reading;

  switch (schema.typeName) {
    case 'google.protobuf.Timestamp':
      return create(TimestampSchema, readTimestamp(node, at));
    case 'google.protobuf.Duration':
      return create(DurationSchema, readDuration(node, at));
    case 'google.protobuf.FieldMask':
      return create(FieldMaskSchema, { paths: readFieldMask(node, at) });
    case 'google.protobuf.Struct':
      return readStruct(node, reading);
    case 'google.protobuf.Value':
      return readValueMessage(node, reading);
    case 'google.protobuf.ListValue':
      return readListValue(node, reading);
    case 'google.protobuf.Any':
      return readAny(node, reading);
    default:
      return schema.typeName.startsWith('google.protobuf.') &&
        schema.typeName.endsWith('Value') &&
        schema.fields.length === 1
        ? readWrapper(schema, { at, node })
        : undefined;
  }
};

/** A message of `schema` of `node`, `reading.depth` below the one read (5.2.2 to 5.2.4). */
const readMessageAt = (schema: DescMessage, node: JsonNode, reading: IReadingOptions): Message => {
  const { at } = reading;

  assertDepth(reading.depth, at);

  const wellKnown = readWellKnown(schema, node, reading);

  if (wellKnown !== undefined) {
    return wellKnown;
  }

  if (node.kind !== 'object') {
    throw new JsonFormError(`${articleOf(schema.name)} ${schema.name} that is no object`, { at });
  }

  const message = create(schema) as Message & Record<string, unknown>;
  const { byName } = fieldsOf(schema);
  // the fields named so far, each by the name it came by
  const named = new Map<DescField, string>();
  // each oneof's member set, by a value that is no null
  const chosen = new Map<string, DescField>();

  for (const [name, value] of node.members) {
    const field = byName.get(name);

    if (field === undefined) {
      throw new JsonFormError('a key no field names', { at: givenAt(at, name) });
    }

    const here = fieldAt(at, field.jsonName);

    if (named.has(field)) {
      throw new JsonFormError('a field by its two names', { at: here });
    }

    named.set(field, name);

    // * null leaves its field unset, but where it is a value of its own
    if (
      value.kind === 'null' &&
      !(field.fieldKind !== 'list' && field.fieldKind !== 'map' && isNullItself(field))
    ) {
      continue;
    }

    const below = { ...reading, at: here };

    switch (field.fieldKind) {
      case 'list': {
        if (value.kind !== 'array') {
          throw new JsonFormError('a repeated field that is no array', { at: here });
        }

        const list = message[field.localName] as unknown[];

        for (const [index, item] of value.items.entries()) {
          if (item.kind === 'null' && !isNullItself(field)) {
            throw new JsonFormError('a null item', { at: itemAt(here, index) });
          }

          list.push(readValueOf(field, item, { ...below, at: itemAt(here, index) }));
        }

        break;
      }
      case 'map': {
        if (value.kind !== 'object') {
          throw new JsonFormError('a map that is no object', { at: here });
        }

        if (value.members.length > 0) {
          assertDepth(reading.depth + 1, here);
        }

        const map = message[field.localName] as Record<string, unknown>;

        for (const [key, item] of value.members) {
          const keyAt = givenAt(here, key);
          const read = readMapKey(field.mapKey, { at: keyAt, key });

          if (Object.hasOwn(map, read)) {
            throw new JsonFormError('two keys of one value', { at: keyAt });
          }

          if (item.kind === 'null' && !isNullItself(field)) {
            throw new JsonFormError('a null value in a map', { at: keyAt });
          }

          // * the entry is a message below this one, and its value one below the entry
          map[read] = readValueOf(field, item, { ...below, at: keyAt, depth: reading.depth + 1 });
        }

        break;
      }
      case 'enum':
      case 'message':
      case 'scalar':
      default: {
        const read = readValueOf(field, value, below);
        const { oneof } = field;

        if (oneof === undefined) {
          message[field.localName] = read;

          break;
        }

        if (chosen.has(oneof.name)) {
          throw new JsonFormError('two members of one oneof', { at: here });
        }

        chosen.set(oneof.name, field);
        message[oneof.localName] = { case: field.localName, value: read };
      }
    }
  }

  return message;
};

/**
 * A message of `schema` of `node`, read by Bead's mapping (transcoding 5.2, items 2 and 3): its
 * members by its fields, each by its JSON name or its proto name and never by both; `null` its
 * field unset but where it is a value of its own; each scalar and well-known type in its one form;
 * a message nested more than 100 deep refused before it is built. A refusal is a
 * {@link JsonFormError}.
 */
export const readMessage = (
  schema: DescMessage,
  { node, registry }: IJsonFormOptions & { node: JsonNode }
): Message => {
  return readMessageAt(schema, node, { at: ROOT, depth: 0, registry });
};

/** A `proto` request's body read by Bead's mapping, its text then its message (transcoding 5.2). */
export const readProtoJson = (
  schema: DescMessage,
  { bytes, registry }: IJsonFormOptions & { bytes: Uint8Array }
): Message => {
  return readMessage(schema, { node: readJsonText(bytes), registry });
};

// ── Writing ───────────────────────────────────────────────────────────────────

/** What a writing carries down a message: the messages an `Any` names, and its depth. */
interface IWritingOptions {
  readonly depth: number;
  readonly registry: ITypeRegistry;
}

/** A scalar's JSON (5.6.1, 5.6.6). */
const scalarJsonOf = (scalar: ScalarType, value: unknown): string => {
  if (scalar === ScalarType.DOUBLE || scalar === ScalarType.FLOAT) {
    return numberJsonOf(value as number, { isFloat: scalar === ScalarType.FLOAT });
  }

  if (scalar === ScalarType.BOOL) {
    return value === true ? 'true' : 'false';
  }

  if (scalar === ScalarType.STRING) {
    return JSON.stringify(value);
  }

  if (scalar === ScalarType.BYTES) {
    return `"${base64Of(value as Uint8Array)}"`;
  }

  if (integerTypeOf(scalar)?.is64 === true) {
    return `"${String(value)}"`;
  }

  return value === 0 ? '0' : String(value);
};

/** An enum's JSON: the name of its value declared first for its number, or its number (5.6.5). */
const enumJsonOf = (descEnum: DescEnum, value: number): string => {
  if (descEnum.typeName === NULL_VALUE) {
    return 'null';
  }

  const named = descEnum.values.find((candidate) => {
    return candidate.number === value;
  });

  return named === undefined ? String(value) : JSON.stringify(named.name);
};

/** A Timestamp's JSON, in UTC, with `Z` (5.6.7); one outside its range refused (5.7). */
const timestampJsonOf = (message: { nanos: number; seconds: bigint }): string => {
  const { nanos, seconds } = message;

  if (
    seconds < EARLIEST_SECONDS ||
    seconds > LATEST_SECONDS ||
    nanos < 0 ||
    nanos >= NANOS_PER_SECOND
  ) {
    throw new JsonFormError('a Timestamp outside its range');
  }

  const total = Number(seconds);
  const days = Math.floor(total / SECONDS_PER_DAY);
  const inDay = total - days * SECONDS_PER_DAY;
  const { day, month, year } = civilFromDays(days);
  const time = `${pad(Math.floor(inDay / 3600), 2)}:${pad(Math.floor(inDay / 60) % 60, 2)}:${pad(inDay % 60, 2)}`;

  return `"${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${time}${fractionOf(nanos)}Z"`;
};

/** A Duration's JSON, with `s` (5.6.7); one outside its range, or whose signs part, refused (5.7). */
const durationJsonOf = (message: { nanos: number; seconds: bigint }): string => {
  const { nanos, seconds } = message;

  if (
    seconds > LONGEST_SECONDS ||
    seconds < -LONGEST_SECONDS ||
    nanos >= NANOS_PER_SECOND ||
    nanos <= -NANOS_PER_SECOND ||
    (seconds > 0n && nanos < 0) ||
    (seconds < 0n && nanos > 0)
  ) {
    throw new JsonFormError('a Duration outside its range');
  }

  const isNegative = seconds < 0n || nanos < 0;
  const whole = seconds < 0n ? -seconds : seconds;

  return `"${isNegative ? '-' : ''}${whole.toString()}${fractionOf(Math.abs(nanos))}s"`;
};

/** A FieldMask's JSON, its paths in lowerCamelCase by `,`, each held to read back (5.6.7, 5.7). */
const fieldMaskJsonOf = (paths: readonly string[]): string => {
  const camel = paths.map((path) => {
    const written = camelOf(path);
    const back = written.replaceAll(/[A-Z]/gu, (letter) => {
      return `_${letter.toLowerCase()}`;
    });
    const isCamel = written.split('.').every((segment) => {
      return CAMEL_SEGMENT.test(segment);
    });

    if (!isCamel || back !== path) {
      throw new JsonFormError('a FieldMask path whose lowerCamelCase does not read back');
    }

    return written;
  });

  return JSON.stringify(camel.join(','));
};

const assertWritingDepth = (depth: number): void => {
  if (depth > MAXIMUM_DEPTH) {
    throw new JsonFormError(`a message nested past ${String(MAXIMUM_DEPTH)}`);
  }
};

const valueJsonOf = (value: Message, writing: IWritingOptions): string => {
  assertWritingDepth(writing.depth);

  const { kind } = value as Message & { kind: { case: string | undefined; value?: unknown } };
  const below = { ...writing, depth: writing.depth + 1 };

  switch (kind.case) {
    case 'nullValue':
      return 'null';
    case 'numberValue': {
      const number = kind.value as number;

      if (!Number.isFinite(number)) {
        throw new JsonFormError('a Value whose number is not finite');
      }

      return number === 0 ? '0' : String(number);
    }
    case 'stringValue':
      return JSON.stringify(kind.value);
    case 'boolValue':
      return kind.value === true ? 'true' : 'false';
    case 'structValue':
      return structJsonOf(kind.value as Message, below);
    case 'listValue':
      return listValueJsonOf(kind.value as Message, below);
    case undefined:
    default:
      throw new JsonFormError('a Value that holds no kind');
  }
};

const structJsonOf = (struct: Message, writing: IWritingOptions): string => {
  assertWritingDepth(writing.depth);

  const { fields } = struct as Message & { fields: Record<string, Message> };
  // * a member is a map's entry, a message below the Struct, and its Value one below that
  const below = { ...writing, depth: writing.depth + 2 };
  const members = Object.keys(fields)
    .toSorted()
    .map((name) => {
      return `${JSON.stringify(name)}:${valueJsonOf(fields[name] as Message, below)}`;
    });

  return `{${members.join(',')}}`;
};

/**
 * A JSON value protobuf-es holds of a `Struct` of a field, as the `Value` it stands for, at
 * `depth`: an object a `Struct` below it, an array a `ListValue`, a number held finite.
 */
const localValueJsonOf = (value: JsonValue, depth: number): string => {
  assertWritingDepth(depth);

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonFormError('a Value whose number is not finite');
    }

    return value === 0 ? '0' : String(value);
  }

  if (Array.isArray(value)) {
    assertWritingDepth(depth + 1);

    return `[${value
      .map((item) => {
        return localValueJsonOf(item, depth + 2);
      })
      .join(',')}]`;
  }

  return localStructJsonOf(value, depth + 1);
};

/** A JSON object protobuf-es holds of a `Struct` of a field, as that `Struct` at `depth`. */
const localStructJsonOf = (object: JsonObject, depth: number): string => {
  assertWritingDepth(depth);

  const members = Object.keys(object)
    .toSorted()
    .map((name) => {
      return `${JSON.stringify(name)}:${localValueJsonOf(object[name] ?? null, depth + 2)}`;
    });

  return `{${members.join(',')}}`;
};

const listValueJsonOf = (list: Message, writing: IWritingOptions): string => {
  assertWritingDepth(writing.depth);

  const { values } = list as Message & { values: Message[] };
  const below = { ...writing, depth: writing.depth + 1 };

  return `[${values
    .map((value) => {
      return valueJsonOf(value, below);
    })
    .join(',')}]`;
};

/** An `Any`'s JSON: `@type` first, then its message's members or its `value` (5.6.2, 5.6.7). */
const anyJsonOf = (any: Message, writing: IWritingOptions): string => {
  const { typeUrl, value } = any as Message & { typeUrl: string; value: Uint8Array };

  if (typeUrl === '' && value.length === 0) {
    return '{}';
  }

  const typeName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
  const schema = typeUrl.includes('/') ? writing.registry.messageOf(typeName) : undefined;

  if (schema === undefined) {
    throw new JsonFormError('an Any whose type its definitions do not hold');
  }

  let message: Message;

  try {
    message = fromBinary(schema, value, { recursionLimit: MAXIMUM_DEPTH + 1 - writing.depth });
  } catch {
    throw new JsonFormError('an Any whose bytes do not read as its type');
  }

  const below = { ...writing, depth: writing.depth + 1 };
  const type = `"@type":${JSON.stringify(typeUrl)}`;

  if (OWN_FORMS.has(typeName)) {
    return `{${type},"value":${messageJsonOf(schema, message, below)}}`;
  }

  const members = membersOf(schema, message, below);

  return `{${[type, ...members].join(',')}}`;
};

/** A value of `field`, one item of it where it is repeated or a map. */
const fieldValueJsonOf = (field: DescField, value: unknown, writing: IWritingOptions): string => {
  const message = messageOfField(field);

  if (message !== undefined) {
    const below = { ...writing, depth: writing.depth + 1 };
    const local = localOf(field, message);
    const [inner] = message.fields;

    if (local === 'wrapper' && inner?.fieldKind === 'scalar') {
      assertWritingDepth(below.depth);

      return scalarJsonOf(inner.scalar, value);
    }

    if (local === 'struct') {
      return localStructJsonOf(value as JsonObject, below.depth);
    }

    return messageJsonOf(message, value as Message, below);
  }

  const descEnum = enumOfField(field);

  if (descEnum !== undefined) {
    return enumJsonOf(descEnum, value as number);
  }

  return scalarJsonOf(scalarOfField(field) ?? ScalarType.STRING, value);
};

/** Whether a field with no presence of its own holds its default, which its JSON leaves out (5.6.3). */
const isDefault = (value: unknown): boolean => {
  if (typeof value === 'number') {
    return value === 0;
  }

  if (typeof value === 'bigint') {
    return value === 0n;
  }

  if (value instanceof Uint8Array) {
    return value.length === 0;
  }

  return value === '' || value === false || value === '0';
};

/** A field's JSON, its default written where it is at its default too, as a `response_body` (5.8). */
const wholeFieldJsonOf = (field: DescField, value: unknown, writing: IWritingOptions): string => {
  if (field.fieldKind === 'list') {
    return `[${(value as unknown[])
      .map((item) => {
        return fieldValueJsonOf(field, item, writing);
      })
      .join(',')}]`;
  }

  if (field.fieldKind === 'map') {
    if (Object.keys(value as object).length > 0) {
      assertWritingDepth(writing.depth + 1);
    }

    const map = value as Record<string, unknown>;
    const entries = Object.keys(map)
      .toSorted()
      .map((key) => {
        const entry = { ...writing, depth: writing.depth + 1 };

        return `${JSON.stringify(key)}:${fieldValueJsonOf(field, map[key], entry)}`;
      });

    return `{${entries.join(',')}}`;
  }

  const message = messageOfField(field);

  if (message !== undefined && value === undefined) {
    return messageJsonOf(message, create(message), { ...writing, depth: writing.depth + 1 });
  }

  return fieldValueJsonOf(field, value, writing);
};

/** A message's members, by their JSON names in their fields' numbers' order (5.6.2, 5.6.3). */
const membersOf = (schema: DescMessage, message: Message, writing: IWritingOptions): string[] => {
  const record = message as Message & Record<string, unknown>;
  const members: string[] = [];

  for (const field of fieldsOf(schema).ordered) {
    let value: unknown;

    if (field.oneof !== undefined) {
      const choice = record[field.oneof.localName] as { case?: string; value?: unknown };

      if (choice.case !== field.localName) {
        continue;
      }

      ({ value } = choice);
    } else {
      value = record[field.localName];

      if (value === undefined) {
        continue;
      }

      if (field.fieldKind === 'list' && (value as unknown[]).length === 0) {
        continue;
      }

      if (field.fieldKind === 'map' && Object.keys(value as object).length === 0) {
        continue;
      }

      if (
        (field.fieldKind === 'scalar' || field.fieldKind === 'enum') &&
        field.presence === FeatureSet_FieldPresence.IMPLICIT &&
        isDefault(value)
      ) {
        continue;
      }

      // ! a field of its own presence, proto2's or an edition's, reads its default when unset,
      // which protobuf-es keeps on its message's prototype: only its presence tells it was set
      if (
        (field.fieldKind === 'scalar' || field.fieldKind === 'enum') &&
        field.presence !== FeatureSet_FieldPresence.IMPLICIT &&
        !isFieldSet(message, field)
      ) {
        continue;
      }
    }

    members.push(`${JSON.stringify(field.jsonName)}:${wholeFieldJsonOf(field, value, writing)}`);
  }

  return members;
};

/** A message's JSON in Bead's proto JSON form, `writing.depth` below the one written. */
const messageJsonOf = (schema: DescMessage, message: Message, writing: IWritingOptions): string => {
  assertWritingDepth(writing.depth);

  const record = message as Message & Record<string, unknown>;

  switch (schema.typeName) {
    case 'google.protobuf.Timestamp':
      return timestampJsonOf(record as unknown as { nanos: number; seconds: bigint });
    case 'google.protobuf.Duration':
      return durationJsonOf(record as unknown as { nanos: number; seconds: bigint });
    case 'google.protobuf.FieldMask':
      return fieldMaskJsonOf(record['paths'] as string[]);
    case 'google.protobuf.Struct':
      return structJsonOf(message, writing);
    case 'google.protobuf.Value':
      return valueJsonOf(message, writing);
    case 'google.protobuf.ListValue':
      return listValueJsonOf(message, writing);
    case 'google.protobuf.Any':
      return anyJsonOf(message, writing);
    default:
      break;
  }

  const [only] = schema.fields;

  if (
    schema.typeName.startsWith('google.protobuf.') &&
    schema.typeName.endsWith('Value') &&
    only?.fieldKind === 'scalar'
  ) {
    return scalarJsonOf(only.scalar, record[only.localName]);
  }

  return `{${membersOf(schema, message, writing).join(',')}}`;
};

/**
 * A message's JSON in Bead's proto JSON form (transcoding 5.6): 17.7's tokens, its members by JSON
 * name in their fields' numbers' order, a map's entries and a `Struct`'s members sorted, an
 * aliased enum by its first name, a `float` at its shortest, each well-known type in its form.
 * What the form holds none of is a {@link JsonFormError} (5.7), which a gateway answers 500.
 */
export const writeProtoJson = (
  schema: DescMessage,
  { message, registry }: IJsonFormOptions & { message: Message }
): string => {
  return messageJsonOf(schema, message, { depth: 0, registry });
};

/**
 * The JSON of `message`'s top-level field `name`, by its proto name as `http.proto`'s
 * `response_body` names it, its default written where it is at its default too, so that a body is
 * always there (transcoding 5.8). A name of no field is its caller's bug, which a route's builder
 * refuses (3.9).
 */
export const writeFieldJson = (
  schema: DescMessage,
  { message, name, registry }: IJsonFormOptions & { message: Message; name: string }
): string => {
  const field = schema.fields.find((each) => {
    return each.name === name;
  });

  if (field === undefined) {
    throw new ProgrammerError(`${schema.typeName} has no field ${name}`);
  }

  const record = message as Message & Record<string, unknown>;
  const choice =
    field.oneof === undefined
      ? undefined
      : (record[field.oneof.localName] as { case?: string; value?: unknown });
  const value =
    choice === undefined
      ? record[field.localName]
      : choice.case === field.localName
        ? choice.value
        : undefined;

  return wholeFieldJsonOf(field, value ?? defaultOf(field), { depth: 0, registry });
};

// a field's default, where a oneof's member holds none
const defaultOf = (field: DescField): unknown => {
  if (field.fieldKind === 'enum') {
    return field.enum.values[0]?.number ?? 0;
  }

  if (field.fieldKind !== 'scalar') {
    return undefined;
  }

  const { scalar } = field;

  if (integerTypeOf(scalar)?.is64 === true) {
    return field.longAsString ? '0' : 0n;
  }

  if (scalar === ScalarType.BOOL) {
    return false;
  }

  if (scalar === ScalarType.STRING) {
    return '';
  }

  return scalar === ScalarType.BYTES ? new Uint8Array(0) : 0;
};

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * The messages an `Any` may name (transcoding 5.4.6): every message of the files `schemas` are
 * declared in and of the files those import, nested ones among them, and the well-known types.
 */
export const typeRegistryOf = (schemas: readonly DescMessage[]): ITypeRegistry => {
  const messages = new Map<string, DescMessage>();
  const files = new Set<DescFile>();

  const addMessage = (message: DescMessage): void => {
    messages.set(message.typeName, message);

    for (const nested of message.nestedMessages) {
      addMessage(nested);
    }
  };

  const addFile = (file: DescFile): void => {
    if (files.has(file)) {
      return;
    }

    files.add(file);

    for (const message of file.messages) {
      addMessage(message);
    }

    for (const dependency of file.dependencies) {
      addFile(dependency);
    }
  };

  for (const schema of [...WELL_KNOWN, ...schemas]) {
    addFile(schema.file);
    addMessage(schema);
  }

  return Object.freeze({
    messageOf: (typeName: string) => {
      return messages.get(typeName);
    },
  });
};
