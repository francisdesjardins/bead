// ── Structured fields ─────────────────────────────────────────────────────────

// interfaces

/** What a bare item of RFC 9651 is (§3.3), by the character it opens on. */
export const BARE_ITEM_TYPES = Object.freeze({
  BOOLEAN: 'boolean',
  BYTE_SEQUENCE: 'byte-sequence',
  DATE: 'date',
  DECIMAL: 'decimal',
  DISPLAY_STRING: 'display-string',
  INTEGER: 'integer',
  STRING: 'string',
  TOKEN: 'token',
});

/** A bare item of RFC 9651 (§3.3), its type beside its value: `0` and `0.0` are not one item. */
export type BareItem =
  | { readonly type: typeof BARE_ITEM_TYPES.BOOLEAN; readonly value: boolean }
  | { readonly type: typeof BARE_ITEM_TYPES.BYTE_SEQUENCE; readonly value: Uint8Array }
  | {
      readonly type:
        | typeof BARE_ITEM_TYPES.DATE
        | typeof BARE_ITEM_TYPES.DECIMAL
        | typeof BARE_ITEM_TYPES.INTEGER;
      readonly value: number;
    }
  | {
      readonly type:
        | typeof BARE_ITEM_TYPES.DISPLAY_STRING
        | typeof BARE_ITEM_TYPES.STRING
        | typeof BARE_ITEM_TYPES.TOKEN;
      readonly value: string;
    };

/** An Item of RFC 9651 (§3.3): its bare item, and its parameters in their order. */
export interface IItem {
  readonly bareItem: BareItem;
  readonly parameters: ReadonlyMap<string, BareItem>;
}

/** What is left of a field value to parse, from `index` on. */
interface IInput {
  index: number;
  readonly value: string;
}

// constants

// what an Integer holds at most, in digits, and a Decimal before and after its point (§3.3.1, §3.3.2)
const INTEGER_DIGITS = 15;
const DECIMAL_INTEGER_DIGITS = 12;
const DECIMAL_FRACTION_DIGITS = 3;

// the characters of a field value RFC 9651 reads: ASCII alone (§4.2)
const ASCII = /^[\0-\x7F]*$/u;

const DIGIT = /^[0-9]$/u;
const ALPHA = /^[A-Za-z]$/u;
const LCALPHA = /^[a-z]$/u;
const LCHEXDIG = /^[0-9a-f]{2}$/u;

// what a token goes on with: RFC 9110's tchar, a colon and a slash (§4.2.6)
const TOKEN_CHARACTER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z:/]$/u;

// what a key goes on with (§4.2.3.3)
const KEY_CHARACTER = /^[a-z0-9_\-.*]$/u;

// a Byte Sequence's content, before it is decoded (§4.2.7)
const BASE64 = /^[A-Za-z0-9+/=]*$/u;

// what a String holds: SP and visible ASCII, no control character, DEL nor past ASCII (§4.2.5)
const STRINGABLE = /^[ -~]$/u;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// helpers

const peek = (input: IInput): string => {
  return input.value.charAt(input.index);
};

const discardSpaces = (input: IInput): void => {
  while (peek(input) === ' ') {
    input.index += 1;
  }
};

const integerOrDecimalOf = (input: IInput): BareItem | undefined => {
  let sign = 1;
  let digits = '';
  let isDecimal = false;

  if (peek(input) === '-') {
    input.index += 1;
    sign = -1;
  }

  if (!DIGIT.test(peek(input))) {
    return undefined;
  }

  for (let character = peek(input); character !== ''; character = peek(input)) {
    if (DIGIT.test(character)) {
      digits += character;
    } else if (!isDecimal && character === '.') {
      if (digits.length > DECIMAL_INTEGER_DIGITS) {
        return undefined;
      }

      digits += character;
      isDecimal = true;
    } else {
      break;
    }

    input.index += 1;

    if (digits.length > (isDecimal ? INTEGER_DIGITS + 1 : INTEGER_DIGITS)) {
      return undefined;
    }
  }

  const fraction = isDecimal ? digits.slice(digits.indexOf('.') + 1) : undefined;

  if (fraction === '' || (fraction?.length ?? 0) > DECIMAL_FRACTION_DIGITS) {
    return undefined;
  }

  // * `-0` is 0 (§4.2.4): a sign kept on a zero would tell two counts apart that are one
  const value = sign * Number(digits);

  return Object.freeze({
    type: isDecimal ? BARE_ITEM_TYPES.DECIMAL : BARE_ITEM_TYPES.INTEGER,
    value: value === 0 ? 0 : value,
  });
};

const stringOf = (input: IInput): BareItem | undefined => {
  let value = '';

  input.index += 1;

  for (let character = peek(input); character !== ''; character = peek(input)) {
    input.index += 1;

    if (character === '"') {
      return Object.freeze({ type: BARE_ITEM_TYPES.STRING, value });
    }

    if (character === '\\') {
      const escaped = peek(input);

      if (escaped !== '"' && escaped !== '\\') {
        return undefined;
      }

      input.index += 1;
      value += escaped;
    } else if (!STRINGABLE.test(character)) {
      return undefined;
    } else {
      value += character;
    }
  }

  return undefined;
};

const tokenOf = (input: IInput): BareItem => {
  const start = input.index;

  input.index += 1;

  while (TOKEN_CHARACTER.test(peek(input))) {
    input.index += 1;
  }

  return Object.freeze({
    type: BARE_ITEM_TYPES.TOKEN,
    value: input.value.slice(start, input.index),
  });
};

// base64, its padding optional and its pad bits ignored, as §4.2.7 advises; `atob` decodes so
const byteSequenceOf = (input: IInput): BareItem | undefined => {
  const end = input.value.indexOf(':', input.index + 1);

  if (end === -1) {
    return undefined;
  }

  const content = input.value.slice(input.index + 1, end);

  input.index = end + 1;

  if (!BASE64.test(content)) {
    return undefined;
  }

  try {
    const decoded = atob(content);

    return Object.freeze({
      type: BARE_ITEM_TYPES.BYTE_SEQUENCE,
      value: Uint8Array.from(decoded, (character) => {
        return character.charCodeAt(0);
      }),
    });
  } catch {
    return undefined;
  }
};

const booleanOf = (input: IInput): BareItem | undefined => {
  const character = input.value.charAt(input.index + 1);

  if (character !== '0' && character !== '1') {
    return undefined;
  }

  input.index += 2;

  return Object.freeze({ type: BARE_ITEM_TYPES.BOOLEAN, value: character === '1' });
};

const dateOf = (input: IInput): BareItem | undefined => {
  input.index += 1;

  const seconds = integerOrDecimalOf(input);

  return seconds?.type === BARE_ITEM_TYPES.INTEGER
    ? Object.freeze({ type: BARE_ITEM_TYPES.DATE, value: seconds.value })
    : undefined;
};

// percent-encoded UTF-8 between quotes, its hex digits in lower case (§4.2.10)
const displayStringOf = (input: IInput): BareItem | undefined => {
  if (input.value.charAt(input.index + 1) !== '"') {
    return undefined;
  }

  const bytes: number[] = [];

  input.index += 2;

  for (let character = peek(input); character !== ''; character = peek(input)) {
    input.index += 1;

    if (!STRINGABLE.test(character)) {
      return undefined;
    }

    if (character === '"') {
      try {
        return Object.freeze({
          type: BARE_ITEM_TYPES.DISPLAY_STRING,
          value: UTF8.decode(new Uint8Array(bytes)),
        });
      } catch {
        return undefined;
      }
    }

    if (character === '%') {
      const hex = input.value.slice(input.index, input.index + 2);

      if (!LCHEXDIG.test(hex)) {
        return undefined;
      }

      input.index += 2;
      bytes.push(Number.parseInt(hex, 16));
    } else {
      bytes.push(character.charCodeAt(0));
    }
  }

  return undefined;
};

// a bare item, by the character it opens on (§4.2.3.1)
const bareItemOf = (input: IInput): BareItem | undefined => {
  const character = peek(input);

  if (character === '-' || DIGIT.test(character)) {
    return integerOrDecimalOf(input);
  }

  if (character === '"') {
    return stringOf(input);
  }

  if (character === '*' || ALPHA.test(character)) {
    return tokenOf(input);
  }

  switch (character) {
    case ':': {
      return byteSequenceOf(input);
    }
    case '?': {
      return booleanOf(input);
    }
    case '@': {
      return dateOf(input);
    }
    case '%': {
      return displayStringOf(input);
    }
    default: {
      return undefined;
    }
  }
};

// a key: a lower-case letter or `*`, then lower-case letters, digits and `_-.*` (§4.2.3.3)
const keyOf = (input: IInput): string | undefined => {
  const start = input.index;
  const first = peek(input);

  if (first !== '*' && !LCALPHA.test(first)) {
    return undefined;
  }

  input.index += 1;

  while (KEY_CHARACTER.test(peek(input))) {
    input.index += 1;
  }

  return input.value.slice(start, input.index);
};

// each parameter after a `;`, a key without a value true, a key given twice its last value (§4.2.3.2)
const parametersOf = (input: IInput): Map<string, BareItem> | undefined => {
  const parameters = new Map<string, BareItem>();

  while (peek(input) === ';') {
    input.index += 1;
    discardSpaces(input);

    const key = keyOf(input);

    if (key === undefined) {
      return undefined;
    }

    let value: BareItem | undefined = Object.freeze({ type: BARE_ITEM_TYPES.BOOLEAN, value: true });

    if (peek(input) === '=') {
      input.index += 1;
      value = bareItemOf(input);
    }

    if (value === undefined) {
      return undefined;
    }

    parameters.set(key, value);
  }

  return parameters;
};

// definition

/**
 * A field value parsed as an Item of RFC 9651 (§4.2, §4.2.3), its field lines combined first by
 * `, ` as RFC 9110 §5.3 combines them: its bare item and its parameters. None when it does not
 * parse: past ASCII, empty, of anything left after the item, two lines of it among them. Spaces
 * around it are discarded, a tab is not.
 */
export const parseItem = (value: string): IItem | undefined => {
  if (!ASCII.test(value)) {
    return undefined;
  }

  const input: IInput = { index: 0, value };

  discardSpaces(input);

  const bareItem = bareItemOf(input);
  const parameters = bareItem === undefined ? undefined : parametersOf(input);

  discardSpaces(input);

  if (bareItem === undefined || parameters === undefined || input.index !== value.length) {
    return undefined;
  }

  return Object.freeze({ bareItem, parameters });
};
