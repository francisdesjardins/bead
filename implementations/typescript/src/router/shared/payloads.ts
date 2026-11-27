// ── Payloads ──────────────────────────────────────────────────────────────────

// The codecs of spec section 17: `raw`, `text` and `json`, the same bytes from every side, and a
// `proto` message's, made of its stock library's two functions. Public through `./service`, which
// generated code imports: what a serializer delegates to.

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { BYTE_ORDER_MARK } from './unicode';

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

/**
 * The reasons a codec of spec 17 refuses with, in 17.2's words and no others: a refusal's message
 * is its reason, exactly, and a request's `PAYLOAD_UNDECODABLE` carries it as its detail. What more
 * the side knows rides in the refusal's `cause`.
 */
export const CODEC_REASONS = Object.freeze({
  byteOrderMark: 'a byte order mark',
  nameTwice: 'a name twice',
  nestedPast64: 'nested past 64',
  noJsonValue: 'no JSON value',
  notAFiniteNumber: 'not a finite number',
  notJson: 'not JSON',
  notUtf8: 'not UTF-8',
  numberPastADouble: 'a number past a double',
  surrogateAlone: 'a surrogate alone',
});

// how deep a json payload nests at most, the outermost at depth 1 (spec 17.5, item 7)
const DEPTH = 64;

// the characters a scan of a JSON text reads, by their codes, as RFC 8259 names them

/** RFC 8259 §2: begin-array, `[`. */
export const BEGIN_ARRAY = 0x5b;

/** RFC 8259 §2: end-array, `]`. */
export const END_ARRAY = 0x5d;

/** RFC 8259 §2: begin-object, `{`. */
export const BEGIN_OBJECT = 0x7b;

/** RFC 8259 §2: end-object, `}`. */
export const END_OBJECT = 0x7d;

/** RFC 8259 §2: name-separator, `:`. */
export const NAME_SEPARATOR = 0x3a;

/** RFC 8259 §2: value-separator, `,`. */
export const VALUE_SEPARATOR = 0x2c;

/** RFC 8259 §7: quotation-mark, `"`, which opens and closes a string. */
export const QUOTATION_MARK = 0x22;

/** RFC 8259 §7: escape, `\`, which opens an escape in a string. */
export const ESCAPE = 0x5c;

/** RFC 8259 §2: a space, of the insignificant whitespace `ws` allows. */
export const SPACE = 0x20;

/** RFC 8259 §2: a horizontal tab, of the insignificant whitespace `ws` allows. */
export const HORIZONTAL_TAB = 0x09;

/** RFC 8259 §2: a line feed, of the insignificant whitespace `ws` allows. */
export const LINE_FEED = 0x0a;

/** RFC 8259 §2: a carriage return, of the insignificant whitespace `ws` allows. */
export const CARRIAGE_RETURN = 0x0d;

/** RFC 8259 §6: minus, `-`, before a negative number's digits. */
export const MINUS = 0x2d;

/** RFC 8259 §6: the digit zero, `0`, the least of a number's digits. */
export const DIGIT_ZERO = 0x30;

/** RFC 8259 §6: the digit nine, `9`, the greatest of a number's digits. */
export const DIGIT_NINE = 0x39;

// the first letter of each literal name, `false`, `null` and `true` (RFC 8259 §3)
const LETTER_F = 0x66;
const LETTER_N = 0x6e;
const LETTER_T = 0x74;

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

    while (text.charCodeAt(quote - 1 - backslashes) === ESCAPE) {
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

    if (code === QUOTATION_MARK) {
      index = endOfString(text, index);
    } else if (code === BEGIN_ARRAY || code === BEGIN_OBJECT) {
      depth += 1;

      if (depth > DEPTH) {
        throw new SyntaxError(CODEC_REASONS.nestedPast64);
      }
    } else if (code === END_ARRAY || code === END_OBJECT) {
      depth -= 1;
    }
  }
};

/**
 * Throws when `value`, as `JSON.parse` gave it, holds a number past a double at any depth. A walk
 * with a stack of its own, never a recursion.
 */
const assertFinite = (value: unknown): void => {
  const pending: unknown[] = [value];

  // ! no JSON value is undefined, so an empty stack alone ends the walk
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new SyntaxError(CODEC_REASONS.numberPastADouble);
    }

    if (typeof item === 'object' && item !== null) {
      // * one by one, never spread: an array as long as a token allows passes no argument limit
      for (const member of Object.values(item)) {
        pending.push(member);
      }
    }
  }
};

/**
 * `value`, as `JSON.parse` gave it, made the value of its canonical form in place, −0 as 0. A walk
 * with a stack of its own, never a recursion.
 */
const settle = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) {
    return Object.is(value, -0) ? 0 : value;
  }

  const pending: object[] = [value];

  for (let container = pending.pop(); container !== undefined; container = pending.pop()) {
    const record = container as Record<string, unknown>;
    const names = Array.isArray(container) ? container.keys() : Object.keys(record);

    for (const name of names) {
      const item = record[name];

      if (typeof item === 'object' && item !== null) {
        pending.push(item);
      } else if (Object.is(item, -0)) {
        record[name] = 0;
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

    if (code === QUOTATION_MARK) {
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
    } else if (code === BEGIN_OBJECT || code === BEGIN_ARRAY) {
      scopes.push(code === BEGIN_OBJECT ? new Set() : undefined);
      expectsName = code === BEGIN_OBJECT;
    } else if (code === END_OBJECT || code === END_ARRAY) {
      scopes.pop();
      expectsName = false;
    } else if (code === VALUE_SEPARATOR) {
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
    code === VALUE_SEPARATOR ||
    code === END_ARRAY ||
    code === END_OBJECT ||
    code === SPACE ||
    code === HORIZONTAL_TAB ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN
  );
};

/**
 * Of spec 17.5's items 4, 5 and 6, the reason `text`, a JSON text `JSON.parse` took, meets first
 * from its start, and, where it meets none, whether a name of it holds an escape: a name or a
 * string holding a surrogate alone at that name or string, a name its object gave before at that
 * name, a number past a double at that number. A scan of the text, since `JSON.parse` keeps the
 * last of two names and puts a name that may be an array index first.
 */
const firstFault = (text: string): { isEscaped: boolean; reason: string | undefined } => {
  // each open object's names, undefined for an array
  const scopes: (Set<string> | undefined)[] = [];
  let expectsName = false;
  let hasEscape = false;
  // the next backslash at or past where the scan is, -1 for none: found again once passed, so the
  // text is searched once
  let backslash = text.indexOf('\\');

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === QUOTATION_MARK) {
      const end = endOfString(text, index);
      const isEscaped = backslash !== -1 && backslash < end;
      const names = scopes.at(-1);
      const isName = expectsName && names !== undefined;

      if (isEscaped) {
        backslash = text.indexOf('\\', end);
      }

      // * only an escape writes a surrogate alone: a string of none needs no reading
      if (isEscaped || isName) {
        const read = isEscaped
          ? (JSON.parse(text.slice(index, end + 1)) as string)
          : text.slice(index + 1, end);

        if (!read.isWellFormed()) {
          return { isEscaped: hasEscape, reason: CODEC_REASONS.surrogateAlone };
        }

        if (isName) {
          if (names.has(read)) {
            return { isEscaped: hasEscape, reason: CODEC_REASONS.nameTwice };
          }

          hasEscape ||= isEscaped;
          names.add(read);
          expectsName = false;
        }
      }

      index = end;
    } else if (code === BEGIN_OBJECT || code === BEGIN_ARRAY) {
      scopes.push(code === BEGIN_OBJECT ? new Set() : undefined);
      expectsName = code === BEGIN_OBJECT;
    } else if (code === END_OBJECT || code === END_ARRAY) {
      scopes.pop();
      expectsName = false;
    } else if (code === VALUE_SEPARATOR) {
      expectsName = scopes.at(-1) !== undefined;
    } else if (code === MINUS || (code >= DIGIT_ZERO && code <= DIGIT_NINE)) {
      let end = index + 1;

      while (end < text.length && !endsScalar(text.charCodeAt(end))) {
        end += 1;
      }

      if (!Number.isFinite(Number(text.slice(index, end)))) {
        return { isEscaped: hasEscape, reason: CODEC_REASONS.numberPastADouble };
      }

      index = end - 1;
    }
  }

  return { isEscaped: hasEscape, reason: undefined };
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

    if (code === QUOTATION_MARK) {
      const end = endOfString(text, index);
      const read = JSON.parse(text.slice(index, end + 1)) as string;
      const top = open.at(-1);

      if (top !== undefined && !Array.isArray(top.container) && top.name === undefined) {
        top.name = read;
      } else {
        place(read);
      }

      index = end;
    } else if (code === BEGIN_OBJECT || code === BEGIN_ARRAY) {
      const container = code === BEGIN_OBJECT ? {} : [];

      place(container);
      open.push({ container, name: undefined });
    } else if (code === END_OBJECT || code === END_ARRAY) {
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
 * The value of `text`, a JSON text, as `JSON.parse` reads it, bounded as spec 17.5's items 6 and 7
 * bound a payload: no number past the largest double, 64 deep at most. Built by Bead's own reader
 * when a member's name holds an escape, which V8 can read as the name of an earlier object of the
 * same shape, one holding a backslash and as long once read. Throws a `SyntaxError`.
 */
export const parseJson = (text: string): unknown => {
  // * before the parse, so a peer never chooses how deep it goes
  assertDepth(text);

  const value: unknown = JSON.parse(text);
  // * the parse holds the text to JSON's grammar; only the names it hands on are in doubt
  const read: unknown = scanNames(text).isEscaped ? buildJson(text) : value;

  assertFinite(read);

  return read;
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
    throw new SyntaxError(CODEC_REASONS.notUtf8, { cause: reason });
  }

  if (text.charCodeAt(0) === BYTE_ORDER_MARK) {
    throw new SyntaxError(CODEC_REASONS.byteOrderMark);
  }

  // * before the parse, so a peer never chooses how deep it goes
  assertDepth(text);

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (reason) {
    throw new SyntaxError(CODEC_REASONS.notJson, { cause: reason });
  }

  // * of the faults past the grammar, the first the text meets (spec 17.5, after item 7)
  const { isEscaped, reason } = firstFault(text);

  if (reason !== undefined) {
    throw new SyntaxError(reason);
  }

  // ! V8 can read a name that holds an escape as an earlier object's: such a payload is built again
  value = settle(isEscaped ? buildJson(text) : value);

  // * what JSON.parse gives, every leaf checked: a JSON value
  return value as JsonValue;
};

/** What a value JSON has no value for is, for a refusal's cause: its type, or its object's class. */
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

/** A writer's refusal of what JSON has no value for: its reason, what the value is in its cause. */
const noJsonValue = (what: string): TypeError => {
  return new TypeError(CODEC_REASONS.noJsonValue, {
    cause: new TypeError(`a json value holds what JSON has no value for, ${what}`),
  });
};

/**
 * The bytes of `value`'s canonical form, as spec 17.7 writes it: RFC 8785's, each object's names
 * sorted by their UTF-16 code units, which a string's default order compares. What no reader takes
 * throws a `TypeError` of its reason: a number that is not finite, a string or a name holding a
 * surrogate alone, a value nested deeper than 64, and what JSON has no value for — `undefined`, a
 * function, a `BigInt`, a `Date`, a `Map`, an object of a class, an array with a hole, which its
 * cause names.
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
        throw new TypeError(CODEC_REASONS.notAFiniteNumber);
      }

      return given === 0 ? 0 : given;
    }

    if (typeof given === 'string') {
      if (!given.isWellFormed()) {
        throw new TypeError(CODEC_REASONS.surrogateAlone);
      }

      return given;
    }

    if (typeof given !== 'object' || !(Array.isArray(given) || isPlain(given))) {
      throw noJsonValue(kindOf(given));
    }

    if (depth === DEPTH) {
      throw new TypeError(CODEC_REASONS.nestedPast64);
    }

    if (Array.isArray(given)) {
      const items: unknown[] = Array.from({ length: given.length });

      for (let index = 0; index < given.length; index += 1) {
        if (!Object.hasOwn(given, index)) {
          throw noJsonValue('an array with a hole');
        }

        items[index] = copy(given[index], depth + 1);
      }

      return items;
    }

    const record = given as Record<string, unknown>;
    const copied = Object.create(null) as Record<string, unknown>;

    for (const name of Object.keys(record).toSorted()) {
      if (!name.isWellFormed()) {
        throw new TypeError(CODEC_REASONS.surrogateAlone);
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
    throw new SyntaxError(CODEC_REASONS.notUtf8, { cause: reason });
  }
};

/**
 * A string's bytes in UTF-8; one holding a surrogate alone is refused. One that is not a string is
 * no value of the codec but its caller's error, as the C# side's `ArgumentNullException` is.
 */
const writeText = (text: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof text !== 'string') {
    throw new ProgrammerError(`a text payload is a string, not ${kindOf(text)}`);
  }

  if (!text.isWellFormed()) {
    throw new TypeError(CODEC_REASONS.surrogateAlone);
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
 * canonical form. A reader's refusal is a `SyntaxError`, a writer's a `TypeError`, each of its
 * reason in 17.2's words ({@link CODEC_REASONS}).
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
 * A codec of `codec`'s two functions, frozen: an encoding of a project's own, or a protobuf
 * message's, which generated code takes from `protoCodecOf` of `./proto`, spec 17.9 held there
 * whole. The runtime reads no field of the message; what does not read throws a `SyntaxError`, its
 * refusal, and a request's payload so refused is answered `PAYLOAD_UNDECODABLE` as any other's,
 * the refusal's message its detail: a codec an application writes refuses in words of its own.
 * Anything else its reader throws is the side's own error: a request is answered `PROCEDURE_FAILED`
 * and the error reported (spec 9.0, 17.2). One that is not a function is a {@link ProgrammerError}.
 *
 * @example
 * import { protoCodecOf } from '@francisdesjardins/bead/proto';
 * import { payloadCodecOf } from '@francisdesjardins/bead/service';
 *
 * const sayHelloRequest = protoCodecOf(SayHelloRequestSchema);
 * const counted = { reads: 0 };
 * const countedRequest = payloadCodecOf({
 *   decode: (bytes) => {
 *     counted.reads += 1;
 *
 *     return sayHelloRequest.decode(bytes);
 *   },
 *   encode: sayHelloRequest.encode,
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
