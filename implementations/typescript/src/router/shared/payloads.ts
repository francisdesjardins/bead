// ── Payloads ──────────────────────────────────────────────────────────────────

// The codecs of spec section 17: `raw`, `text` and `json`, the same bytes from every side, and a
// `proto` message's, made of its stock library's two functions. Public through `./service`, which
// generated code imports: what a serializer delegates to.

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';

// interfaces

/**
 * How one encoding reads a payload and writes a value: what does not read, or write, throws. `Given`
 * is what its writer takes, wider than what its reader gives where the encoding writes more than it
 * reads — a protobuf message's initializer, any value a `json` writer judges at run time.
 */
export interface IPayloadCodec<Value, Given = Value> {
  readonly decode: (bytes: Uint8Array) => Value;
  readonly encode: (value: Given) => Uint8Array;
}

// types

/**
 * A JSON value, as a `json` reader gives one (spec 17.5): what it hands on, never what a writer is
 * held to — spec 17.7 refuses at run time what this type takes, a number not finite or a surrogate
 * alone, and writes what it refuses, a value an interface types.
 */
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [name: string]: JsonValue };

// constants

/**
 * UTF-8, read strictly: a byte no sequence takes, an overlong form, a surrogate's code point or a
 * sequence cut short throws; a leading U+FEFF stays a character of the text, never stripped.
 */
export const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const ENCODER = new TextEncoder();

// how deep a json payload nests at most, the outermost at depth 1 (spec 17.5, item 7)
const DEPTH = 64;

// the characters a scan of a JSON text reads, by their codes
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const OPEN_ARRAY = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_ARRAY = 0x5d;
const LETTER_F = 0x66;
const LETTER_N = 0x6e;
const LETTER_T = 0x74;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const BYTE_ORDER_MARK = 0xfeff;

// helpers

/** The index of the quotation mark that closes the string opening at `index`; the length when none does. */
const endOfString = (text: string, index: number): number => {
  // * found by indexOf, not read character by character: a quote closes the string unless an odd
  // run of backslashes escapes it, and the run stops at the opening quote at the latest
  for (let from = index + 1; ;) {
    const quote = text.indexOf('"', from);

    if (quote === -1) {
      return text.length;
    }

    let backslashes = 0;

    while (text.charCodeAt(quote - 1 - backslashes) === BACKSLASH) {
      backslashes += 1;
    }

    if (backslashes % 2 === 0) {
      return quote;
    }

    from = quote + 1;
  }
};

/**
 * Throws when `text` opens an array or an object deeper than 64, its strings skipped: a count over
 * the text, every loop bounded by its length, whether or not it is JSON.
 */
const assertDepth = (text: string): void => {
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === QUOTE) {
      index = endOfString(text, index);
    } else if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      depth += 1;

      if (depth > DEPTH) {
        throw new SyntaxError(`the payload is nested deeper than ${String(DEPTH)}`);
      }
    } else if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      depth -= 1;
    }
  }
};

/** Throws when `value`, a leaf, is a number past a double or a string holding a surrogate alone. */
const assertLeaf = (value: unknown): void => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SyntaxError('the payload holds a number past the largest double');
  }

  if (typeof value === 'string' && !value.isWellFormed()) {
    throw new SyntaxError('the payload holds a surrogate alone');
  }
};

/**
 * `value`, as `JSON.parse` gave it, made the value of its canonical form in place, −0 as 0, each
 * leaf and each name checked. A walk with a stack of its own, never a recursion.
 */
const settle = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) {
    assertLeaf(value);

    return Object.is(value, -0) ? 0 : value;
  }

  const pending: object[] = [value];

  for (let container = pending.pop(); container !== undefined; container = pending.pop()) {
    const record = container as Record<string, unknown>;
    const names = Array.isArray(container) ? container.keys() : Object.keys(record);

    for (const name of names) {
      if (typeof name === 'string' && !name.isWellFormed()) {
        throw new SyntaxError('the payload holds a surrogate alone');
      }

      const item = record[name];

      if (typeof item === 'object' && item !== null) {
        pending.push(item);
      } else {
        assertLeaf(item);

        if (Object.is(item, -0)) {
          record[name] = 0;
        }
      }
    }
  }

  return value;
};

/** What a scan of `text`, a JSON text already parsed, finds of its objects' names. */
const scanNames = (text: string): { isEscaped: boolean; isOnce: boolean } => {
  // each open object's names, undefined for an array
  const scopes: (Set<string> | undefined)[] = [];
  let expectsName = false;
  let hasEscape = false;
  // the next backslash at or past where the scan is, -1 for none: found again once passed, so the
  // text is searched once
  let backslash = text.indexOf('\\');

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === QUOTE) {
      const end = endOfString(text, index);
      const isEscaped = backslash !== -1 && backslash < end;

      if (isEscaped) {
        backslash = text.indexOf('\\', end);
      }

      const names = scopes.at(-1);

      if (expectsName && names !== undefined) {
        const name = isEscaped
          ? (JSON.parse(text.slice(index, end + 1)) as string)
          : text.slice(index + 1, end);

        if (!name.isWellFormed() || names.has(name)) {
          return { isEscaped: hasEscape || isEscaped, isOnce: false };
        }

        hasEscape ||= isEscaped;
        names.add(name);
        expectsName = false;
      }

      index = end;
    } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      scopes.push(code === OPEN_OBJECT ? new Set() : undefined);
      expectsName = code === OPEN_OBJECT;
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      scopes.pop();
      expectsName = false;
    } else if (code === COMMA) {
      expectsName = scopes.at(-1) !== undefined;
    }
  }

  return { isEscaped: hasEscape, isOnce: true };
};

/**
 * Whether every object of `text`, a JSON text already parsed, names each member once, by a
 * well-formed name, its names compared once their escapes are read: `JSON.parse` keeps the last of
 * two, and .NET's reader both.
 */
export const namesOnce = (text: string): boolean => {
  return scanNames(text).isOnce;
};

/** Whether `code` opens a number or a literal. */
const isScalarStart = (code: number): boolean => {
  return (
    code === MINUS ||
    (code >= DIGIT_ZERO && code <= DIGIT_NINE) ||
    code === LETTER_F ||
    code === LETTER_N ||
    code === LETTER_T
  );
};

/** Whether `code` ends a number or a literal: what may follow one in a JSON text. */
const endsScalar = (code: number): boolean => {
  return (
    code === COMMA ||
    code === CLOSE_ARRAY ||
    code === CLOSE_OBJECT ||
    code === SPACE ||
    code === TAB ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN
  );
};

/**
 * The value of `text`, a JSON text `JSON.parse` took, built in the order of its text: each string,
 * number and literal read by `JSON.parse` alone, each object made of `Object`'s prototype and each
 * member defined as its own, one named `__proto__` among them. A walk with a stack of its own.
 */
const buildJson = (text: string): unknown => {
  // each open array or object, and for an object the name its next value takes
  const open: { container: unknown[] | Record<string, unknown>; name: string | undefined }[] = [];
  let root: unknown;

  const place = (value: unknown): void => {
    const top = open.at(-1);

    if (top === undefined) {
      root = value;
    } else if (Array.isArray(top.container)) {
      top.container.push(value);
    } else {
      // ! defined, never assigned: an assignment to __proto__ would set the object's prototype
      Object.defineProperty(top.container, top.name ?? '', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      top.name = undefined;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === QUOTE) {
      const end = endOfString(text, index);
      const read = JSON.parse(text.slice(index, end + 1)) as string;
      const top = open.at(-1);

      if (top !== undefined && !Array.isArray(top.container) && top.name === undefined) {
        top.name = read;
      } else {
        place(read);
      }

      index = end;
    } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      const container = code === OPEN_OBJECT ? {} : [];

      place(container);
      open.push({ container, name: undefined });
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      open.pop();
    } else if (isScalarStart(code)) {
      let end = index + 1;

      while (end < text.length && !endsScalar(text.charCodeAt(end))) {
        end += 1;
      }

      place(JSON.parse(text.slice(index, end)));
      index = end - 1;
    }
  }

  return root;
};

/**
 * The value of `text`, a JSON text, as `JSON.parse` reads it: built by Bead's own reader when a
 * member's name holds an escape, which V8 can read as the name of an earlier object of the same
 * shape, one holding a backslash and as long once read. Throws what `JSON.parse` throws.
 */
export const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);

  // * the parse holds the text to JSON's grammar; only the names it hands on are in doubt
  return scanNames(text).isEscaped ? buildJson(text) : value;
};

/**
 * The value of a `json` payload, read as spec 17.5 and 17.6 read one: its canonical form's, every
 * number a double, −0 as 0. What it refuses throws a `SyntaxError`.
 */
const readJson = (bytes: Uint8Array): JsonValue => {
  let text: string;

  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (reason) {
    throw new SyntaxError('the payload is not UTF-8', { cause: reason });
  }

  if (text.charCodeAt(0) === BYTE_ORDER_MARK) {
    throw new SyntaxError('the payload starts with a byte order mark');
  }

  // * before the parse, so a peer never chooses how deep it goes
  assertDepth(text);

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (reason) {
    throw new SyntaxError(`the payload is not JSON: ${(reason as Error).message}`, {
      cause: reason,
    });
  }

  const names = scanNames(text);

  // ! V8 can read a name that holds an escape as an earlier object's: such a payload is built again
  value = settle(names.isEscaped ? buildJson(text) : value);

  if (!names.isOnce) {
    throw new SyntaxError('the payload names a member twice');
  }

  // * what JSON.parse gives, every leaf checked: a JSON value
  return value as JsonValue;
};

/** What a value JSON has no value for is, for a refusal's words: its type, or its object's class. */
const kindOf = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) {
    return typeof value;
  }

  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;

  return typeof name === 'string' && name !== '' ? `an object of ${name}` : 'an object of no class';
};

/** Whether `value` is an object of the plain kind, whose prototype is `Object`'s or none. */
const isPlain = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

/** Writes `value`, a copy every refusal has passed, into `parts`, each object's names sorted. */
const writeByHand = (value: unknown, parts: string[]): void => {
  if (Array.isArray(value)) {
    parts.push('[');

    for (const [index, item] of value.entries()) {
      if (index > 0) {
        parts.push(',');
      }

      writeByHand(item, parts);
    }

    parts.push(']');
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;

    parts.push('{');

    for (const [index, name] of Object.keys(record).toSorted().entries()) {
      if (index > 0) {
        parts.push(',');
      }

      parts.push(JSON.stringify(name), ':');
      writeByHand(record[name], parts);
    }

    parts.push('}');
  } else {
    parts.push(JSON.stringify(value));
  }
};

/**
 * The bytes of `value`'s canonical form, as spec 17.7 writes it: RFC 8785's, each object's names
 * sorted by their UTF-16 code units, which a string's default order compares. What no reader takes
 * throws a `TypeError`: a number that is not finite, a string or a name holding a surrogate alone,
 * a value nested deeper than 64, and what JSON has no value for — `undefined`, a function, a
 * `BigInt`, a `Date`, a `Map`, an object of a class, an array with a hole.
 */
const writeJson = (value: unknown): Uint8Array<ArrayBuffer> => {
  // set as the copy finds one, out of the flow a type follows here
  let hasIndexName = false as boolean;

  // * one pass that refuses, and copies each object, its names sorted, into one of no prototype,
  // which holds a member named __proto__ as a member
  const copy = (given: unknown, depth: number): unknown => {
    if (given === null || typeof given === 'boolean') {
      return given;
    }

    if (typeof given === 'number') {
      if (!Number.isFinite(given)) {
        throw new TypeError(`the value holds a number that is not finite, ${String(given)}`);
      }

      return given === 0 ? 0 : given;
    }

    if (typeof given === 'string') {
      if (!given.isWellFormed()) {
        throw new TypeError('the value holds a surrogate alone');
      }

      return given;
    }

    if (typeof given !== 'object' || !(Array.isArray(given) || isPlain(given))) {
      throw new TypeError(`the value holds what JSON has no value for, ${kindOf(given)}`);
    }

    if (depth === DEPTH) {
      throw new TypeError(`the value is nested deeper than ${String(DEPTH)}`);
    }

    if (Array.isArray(given)) {
      const items: unknown[] = Array.from({ length: given.length });

      for (let index = 0; index < given.length; index += 1) {
        if (!Object.hasOwn(given, index)) {
          throw new TypeError('the value holds what JSON has no value for, an array with a hole');
        }

        items[index] = copy(given[index], depth + 1);
      }

      return items;
    }

    const record = given as Record<string, unknown>;
    const copied = Object.create(null) as Record<string, unknown>;

    for (const name of Object.keys(record).toSorted()) {
      if (!name.isWellFormed()) {
        throw new TypeError('the value holds a surrogate alone');
      }

      const first = name.charCodeAt(0);

      // ! a name that may be an array index is held first by every object, whatever order it is
      // given in, so JSON.stringify would write it first
      hasIndexName ||= first >= DIGIT_ZERO && first <= DIGIT_NINE;
      copied[name] = copy(record[name], depth + 1);
    }

    return copied;
  };

  const copied = copy(value, 0);

  if (!hasIndexName) {
    return ENCODER.encode(JSON.stringify(copied));
  }

  const parts: string[] = [];

  writeByHand(copied, parts);

  return ENCODER.encode(parts.join(''));
};

/** A `text` payload's string: its bytes in UTF-8, read strictly, a leading U+FEFF kept (spec 17.4). */
const readText = (bytes: Uint8Array): string => {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (reason) {
    throw new SyntaxError('the payload is not UTF-8', { cause: reason });
  }
};

/** A string's bytes in UTF-8; one that is not a string, or holds a surrogate alone, throws. */
const writeText = (text: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof text !== 'string') {
    throw new TypeError(`a text payload is a string, not ${kindOf(text)}`);
  }

  if (!text.isWellFormed()) {
    throw new TypeError('the text holds a surrogate alone');
  }

  return ENCODER.encode(text);
};

/** A `raw` payload, its bytes as they are, any of them, none included (spec 17.3). */
const passBytes = (bytes: Uint8Array): Uint8Array => {
  return bytes;
};

// definition

/**
 * The codecs of spec section 17, by their encoding's name: `raw`, the bytes; `text`, a string in
 * UTF-8; `json`, a JSON value, read as I-JSON but for its noncharacters and written in RFC 8785's
 * canonical form. A reader's refusal is a `SyntaxError`, a writer's a `TypeError`.
 */
export const PAYLOAD_CODECS: Readonly<{
  json: IPayloadCodec<JsonValue, unknown>;
  raw: IPayloadCodec<Uint8Array>;
  text: IPayloadCodec<string>;
}> = Object.freeze({
  json: Object.freeze({ decode: readJson, encode: writeJson }),
  raw: Object.freeze({ decode: passBytes, encode: passBytes }),
  text: Object.freeze({ decode: readText, encode: writeText }),
});

/**
 * A codec of `codec`'s two functions, frozen: a protobuf message's, from its stock library's binary
 * reader and writer, as generated code passes them, the bound of spec 17.9.3 set in its reader and
 * the payload's records checked first by `checkProtoRecords` of `./proto`. The runtime reads no
 * field of the message; what does not read throws, and a request's payload is answered
 * `PAYLOAD_UNDECODABLE` as any other's. One that is not a function is a {@link ProgrammerError}.
 *
 * @example
 * import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
 * import { checkProtoRecords } from '@francisdesjardins/bead/proto';
 * import { payloadCodecOf } from '@francisdesjardins/bead/service';
 *
 * const sayHelloRequest = payloadCodecOf({
 *   decode: (bytes) => {
 *     checkProtoRecords(bytes, SayHelloRequestSchema);
 *
 *     // ! protobuf-es counts the top message: 101 is spec 17.9's 100 below it
 *     return fromBinary(SayHelloRequestSchema, bytes, { recursionLimit: 101 });
 *   },
 *   encode: (given) => {
 *     return toBinary(SayHelloRequestSchema, create(SayHelloRequestSchema, given));
 *   },
 * });
 */
export const payloadCodecOf = <Value, Given = Value>(
  codec: IPayloadCodec<Value, Given>
): IPayloadCodec<Value, Given> => {
  // a caller without types may give anything
  const given: unknown = codec;
  const { decode, encode } = (typeof given === 'object' && given !== null ? given : {}) as Partial<
    Record<'decode' | 'encode', unknown>
  >;

  if (typeof decode !== 'function' || typeof encode !== 'function') {
    throw new ProgrammerError(
      `a payload's codec is two functions, decode and encode, not ${typeof decode} and ${typeof encode}`
    );
  }

  return Object.freeze({
    decode: decode as IPayloadCodec<Value, Given>['decode'],
    encode: encode as IPayloadCodec<Value, Given>['encode'],
  });
};
