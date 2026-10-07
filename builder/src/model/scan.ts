// ── Scan ──────────────────────────────────────────────────────────────────────

// One pass over a blueprint's text by RFC 8259's grammar, before any parser reads it: what
// `JSON.parse` takes in silence and a blueprint never holds — a member twice (I-JSON, RFC 7493 §2.3),
// a number with a fraction or an exponent — at its JSON Pointer, and the place of every value, for a
// finding's line. A text that is no JSON is refused at its line and column.

// dependencies

import { InputError, tokenOf } from '../diagnostics.ts';

// types

/** A line and a column, from 1. */
export interface IPosition {
  readonly line: number;
  readonly column: number;
}

/** A value's place: its JSON Pointer, and where its text starts. */
export interface IScanPlace extends IPosition {
  readonly pointer: string;
}

/** What a scan finds. */
export interface IScan {
  /** Each member whose name its object held already, at the second's place. */
  readonly duplicates: readonly IScanPlace[];
  /** Each number written with a fraction or an exponent. */
  readonly fractions: readonly IScanPlace[];
  /** Where each value starts, by its pointer: the first, where a name is held twice. */
  readonly positions: ReadonlyMap<string, IPosition>;
}

// constants

// RFC 8259's whitespace, and the escapes a string takes
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});
const HEX = /^[0-9A-Fa-f]{4}$/u;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/uy;
// deeper than any blueprint nests, and short of the stack
const DEEPEST = 512;
const FIRST_PRINTABLE = 0x20;
const BYTE_ORDER_MARK = '\uFEFF';

// definition

/**
 * Scans `text`, a blueprint's, after a byte order mark if one leads, by RFC 8259's grammar; throws an
 * {@link InputError} naming the line and the column where it stops being JSON.
 */
export const scan = (text: string): IScan => {
  const duplicates: IScanPlace[] = [];
  const fractions: IScanPlace[] = [];
  const positions = new Map<string, IPosition>();
  // ! a byte order mark that leads is read past, as RFC 8259 §8.1 lets a parser ignore one: the
  // first line's columns count from after it
  let index = text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const lineStarts = [index];

  for (let at = index; at < text.length; at += 1) {
    if (text[at] === '\n') {
      lineStarts.push(at + 1);
    }
  }

  const positionOf = (at: number): IPosition => {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);

      if ((lineStarts[middle] ?? 0) <= at) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return { line: low + 1, column: at - (lineStarts[low] ?? 0) + 1 };
  };

  const fail = (reason: string): never => {
    const { line, column } = positionOf(index);

    throw new InputError(`line ${String(line)}, column ${String(column)}: ${reason}, so no JSON`);
  };

  const skipWhitespace = (): void => {
    while (index < text.length && WHITESPACE.has(text[index] ?? '')) {
      index += 1;
    }
  };

  const expect = (character: string): void => {
    if (text[index] !== character) {
      fail(`${JSON.stringify(character)} expected`);
    }

    index += 1;
  };

  const readString = (): string => {
    expect('"');
    let value = '';

    for (;;) {
      const character = text[index];

      if (character === undefined) {
        return fail('a string that never ends');
      }

      if (character === '"') {
        index += 1;
        return value;
      }

      if (character.charCodeAt(0) < FIRST_PRINTABLE) {
        return fail('a control character unescaped in a string');
      }

      if (character === '\\') {
        const escape = text[index + 1] ?? '';

        if (escape === 'u') {
          const digits = text.slice(index + 2, index + 6);

          if (!HEX.test(digits)) {
            return fail('a \\u escape without its four hexadecimal digits');
          }

          value += String.fromCharCode(Number.parseInt(digits, 16));
          index += 6;
        } else {
          const escaped = ESCAPES[escape];

          if (escaped === undefined) {
            return fail(`an escape \\${escape} RFC 8259 does not name`);
          }

          value += escaped;
          index += 2;
        }
      } else {
        value += character;
        index += 1;
      }
    }
  };

  const readValue = (pointer: string, depth: number): void => {
    skipWhitespace();

    if (depth > DEEPEST) {
      fail(`a value nested past ${String(DEEPEST)}`);
    }

    if (!positions.has(pointer)) {
      positions.set(pointer, positionOf(index));
    }

    const character = text[index];

    if (character === '{') {
      const names = new Set<string>();
      index += 1;
      skipWhitespace();

      if (text[index] === '}') {
        index += 1;
        return;
      }

      for (;;) {
        skipWhitespace();
        const start = index;
        const name = readString();
        const member = `${pointer}/${tokenOf(name)}`;

        if (names.has(name)) {
          duplicates.push({ pointer: member, ...positionOf(start) });
        }

        names.add(name);
        skipWhitespace();
        expect(':');
        readValue(member, depth + 1);
        skipWhitespace();

        if (text[index] === ',') {
          index += 1;
        } else {
          expect('}');
          return;
        }
      }
    }

    if (character === '[') {
      index += 1;
      skipWhitespace();

      if (text[index] === ']') {
        index += 1;
        return;
      }

      for (let item = 0; ; item += 1) {
        readValue(`${pointer}/${String(item)}`, depth + 1);
        skipWhitespace();

        if (text[index] === ',') {
          index += 1;
        } else {
          expect(']');
          return;
        }
      }
    }

    if (character === '"') {
      readString();
      return;
    }

    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }

    NUMBER.lastIndex = index;
    const number = NUMBER.exec(text);

    if (number === null) {
      fail(
        character === undefined
          ? 'a value expected'
          : `${JSON.stringify(character)} where a value is`
      );
      return;
    }

    if (number[1] !== undefined || number[2] !== undefined) {
      fractions.push({ pointer, ...positionOf(index) });
    }

    index += number[0].length;
  };

  readValue('', 0);
  skipWhitespace();

  if (index < text.length) {
    fail('text after the value');
  }

  return { duplicates, fractions, positions };
};
