// ── The cases of `bead/wire-literal` ─────────────────────────────────────────
// A line for each verdict of the notation rule (decision 0057): a line the rule refuses follows a
// comment of its own, `// refused:` and why, and every other line is one it accepts.
// `check-oxlint-plugin.mjs` lints this file alone, through `wire-literal.cases.oxlintrc.json`,
// which gives it as the rule's one module, and fails unless the lines refused are exactly the ones
// marked. The package's own lint leaves it out, and no `tsconfig` includes it.

// ── Definitions ──────────────────────────────────────────────────────────────

const FIN_BIT = 0x80;
export const MASK_BIT = 0x80;
export const RESERVED_SUBSCRIBE_FLAGS = 0b0010;
export const LARGEST_RELAYS = 0xffn;
export const HEAD = FIN_BIT | 0x0f;
export const CODES = Object.freeze({ TEXT: 0x1, BINARY: 0x2, MASK: 0x80 & 0x7f });
export const PLACES = Object.freeze([0x01, 0x80, 0x4000]);
export const NESTED = Object.freeze({ inner: { deep: [0x10, 0x11] } });
export const TYPED: Readonly<Record<number, string>> = Object.freeze({ [0x04]: 'a PUBACK' });

// refused: a definition's name opens with a capital
const lower = 0x80;
// refused: a definition is a `const`
export let Mutable = 0x80;
export const bump = (): void => {
  Mutable += 1;
};
// refused: an object a lower-case name holds is no definition
export const table = { first: 0x01 };

// ── A function between ───────────────────────────────────────────────────────

export const Named = (byte: number): boolean => {
  // refused: a literal inside an arrow function that a capitalized `const` holds
  return byte === 0x80;
};

export const Computed = (() => {
  // refused: a literal inside a function that a capitalized `const` calls
  return 0x80;
})();

export const local = (byte: number): number => {
  // refused: a capitalized `const` inside a function is no module-level definition
  const INNER = 0x0f;
  return byte & INNER;
};

export const expressed = function (byte: number): boolean {
  // refused: a literal inside a function expression
  return byte < 0x80;
};

export const HOLDER = Object.freeze({
  judge: (byte: number): boolean => {
    // refused: a literal inside a method of a frozen object
    return byte > 0xdf;
  },
});

// ── Literals outside a definition ────────────────────────────────────────────

export const notations = (byte: number): number[] => {
  return [
    // refused: a hex literal
    0x7f,
    // refused: a binary literal
    0b0111_1111,
    // refused: a BigInt's hex literal
    Number(0x7fn),
    // a decimal literal, alone, is review's
    127,
    // an octal literal is no notation the rule holds
    0o177,
    byte,
  ];
};

// ── `&`, `|` and `^` ─────────────────────────────────────────────────────────

export const operands = (tag: number, big: bigint): number[] => {
  const digit = tag + 1;
  let value = tag;
  // refused: a decimal literal above 1 as an operand of `&`
  value = tag & 7;
  // refused: a decimal literal above 1 as an operand of `|`
  value = digit | 128;
  // refused: a decimal literal above 1 as an operand of `^`
  value = 2 ^ digit;
  // refused: a compound `|=`
  value |= 4;
  // refused: a compound `&=`
  value &= 3;
  // refused: a compound `^=`
  value ^= 9;
  // refused: a BigInt's decimal literal above 1
  const bigValue = big & 255n;
  value = tag & 1;
  value = digit | 0;
  value = tag ^ 1;
  value |= 1;
  value = Number(big & 1n);
  // a shift is review's
  value = (tag >> 3) + (digit << 7) + (tag >>> 4);
  value = tag & FIN_BIT & MASK_BIT;
  value = tag | value;
  return [value, Number(bigValue)];
};

// ── What is never code ───────────────────────────────────────────────────────

export const notCode = (text: string, byte: number): string[] => {
  // a comment holds 0x80 and tag & 7, and is no code
  /* nor is a block comment's 0xff | 128 */
  const quoted = '0x80 & 7';
  const doubled = '0xff | 128';
  const template = `0x7f ^ 4 ${quoted}`;
  const raw = String.raw`0x80 & 7 \x`;
  const regex = /0x80 & 7|[({'`]/u.test(text) ? 'matched' : doubled;
  return [quoted, template, raw, regex, String(byte)];
};

export const holes = (byte: number, text: string): string[] => {
  return [
    // refused: a template's hole is code
    `the digit ${String(byte & 0x7f)}`,
    // refused: a literal after a regex holding `(`, `{`, `'` and a backquote
    /[({'`]/u.test(text) ? String(0x80) : '',
  ];
};

// ── What is no expression ────────────────────────────────────────────────────

// a union type of decimal literals is no expression
export type Code = 1002 | 1008 | 1009;

export const judged = (code: Code): string => {
  switch (code) {
    case 1002:
      return 'a protocol error';
    case 1008:
      return 'a policy violation';
    case 1009:
      return 'a message too big';
  }
};

export { lower };
