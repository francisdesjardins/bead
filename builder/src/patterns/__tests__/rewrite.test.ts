import { expect, test } from '@playwright/test';

import { type CodePoints, codePointsOf, includes, unicodeClass } from '../code-points.ts';
import { rewritePattern } from '../rewrite.ts';

// ── A pattern written out ─────────────────────────────────────────────────────

// A pattern rewritten for RE2's compiler with no Unicode class and no case folding left, read as
// Go's `regexp/syntax` reads it under its Perl flags, and what RE2 refuses refused.

const B = '\\';

const rewritten = (pattern: string): string => {
  const result = rewritePattern(pattern);

  if (result.kind === 'refused') {
    throw new Error(`${pattern} refused: ${result.reason}`);
  }

  return result.text;
};

const refusal = (pattern: string): string => {
  const result = rewritePattern(pattern);

  return result.kind === 'refused' ? result.reason : `taken as ${result.text}`;
};

// the code points of one class as the rewriting writes it, `[\x{41}-\x{5A}…]`
const setOf = (written: string): CodePoints => {
  const ranges: [number, number][] = [];

  for (const found of written.matchAll(/\\x\{([0-9A-F]+)\}(?:-\\x\{([0-9A-F]+)\})?/gu)) {
    const low = Number.parseInt(found[1] ?? '', 16);

    ranges.push([low, Number.parseInt(found[2] ?? found[1] ?? '', 16)]);
  }

  return written.startsWith('[^') ? [] : codePointsOf(ranges);
};

const KELVIN = `[${B}x{4B}${B}x{6B}${B}x{212A}]`;

test('writes a literal under (?i) as its orbit, and takes the flag out', () => {
  expect(rewritten('(?i)k')).toBe(KELVIN);
  expect(rewritten('(?i)1')).toBe('1');
  expect(rewritten('(?i)')).toBe('');
});

test('keeps a flag to its group, to the rest of its group, and to its negation', () => {
  expect(rewritten('(?i:k)k')).toBe(`(?:${KELVIN})k`);
  expect(rewritten('a(?i)k|k')).toBe(`a${KELVIN}|${KELVIN}`);
  expect(rewritten('(?i)k(?-i)k')).toBe(`${KELVIN}k`);
  expect(rewritten('((?i)k)k')).toBe(`(${KELVIN})k`);
  expect(rewritten('(?im)^k')).toBe(`(?m)^${KELVIN}`);
  expect(rewritten('(?i-m:k)')).toBe(`(?-m:${KELVIN})`);
  expect(rewritten('(?s-i:k)')).toBe('(?s:k)');
  expect(rewritten('(?P<name>k)(?<other>k)')).toBe('(?P<name>k)(?<other>k)');
});

test('writes a Unicode class as its ranges of Unicode 17.0.0, alone or in a class', () => {
  const letters = setOf(rewritten(`${B}pL`));

  expect(letters).toEqual(unicodeClass('L'));
  expect(includes(letters, 0x10940)).toBe(true);
  expect(setOf(rewritten(`${B}p{Greek}`))).toEqual(unicodeClass('Greek'));
  expect(includes(setOf(rewritten(`[${B}p{Greek}a]`)), 0x61)).toBe(true);
  expect(includes(setOf(rewritten(`${B}PL`)), 0x31)).toBe(true);
  expect(includes(setOf(rewritten(`${B}PL`)), 0x61)).toBe(false);
  expect(rewritten(`${B}p{^Greek}`)).toBe(rewritten(`${B}P{Greek}`));
  expect(rewritten(`${B}P{^Greek}`)).toBe(rewritten(`${B}p{Greek}`));
  expect(rewritten(`${B}p{Any}`)).toBe(`[${B}x{0}-${B}x{D7FF}${B}x{E000}-${B}x{10FFFF}]`);
});

test('folds each part of a class before the class is negated, as RE2 does', () => {
  // U+0345 is no letter, and folds with ι, which is one
  expect(includes(setOf(rewritten(`${B}PL`)), 0x345)).toBe(true);
  expect(includes(setOf(rewritten(`(?i)${B}PL`)), 0x345)).toBe(false);
  expect(includes(setOf(rewritten(`(?i)[${B}PL]`)), 0x345)).toBe(false);
  expect(includes(setOf(rewritten(`(?i)[^${B}pL]`)), 0x345)).toBe(false);
  expect(includes(setOf(rewritten('(?i)[^k]')), 0x212a)).toBe(false);
  expect(includes(setOf(rewritten('[^k]')), 0x212a)).toBe(true);
});

test('writes the Perl and the POSIX classes as RE2 holds them, of ASCII', () => {
  expect(rewritten(`${B}d`)).toBe(`[${B}x{30}-${B}x{39}]`);
  expect(rewritten(`${B}s`)).toBe(`[${B}x{9}-${B}x{A}${B}x{C}-${B}x{D}${B}x{20}]`);
  expect(includes(setOf(rewritten(`${B}w`)), 0x5f)).toBe(true);
  expect(includes(setOf(rewritten(`${B}w`)), 0xe9)).toBe(false);
  expect(includes(setOf(rewritten(`(?i)${B}w`)), 0x17f)).toBe(true);
  expect(includes(setOf(rewritten(`(?i)${B}w`)), 0x212a)).toBe(true);
  expect(includes(setOf(rewritten(`(?i)${B}W`)), 0x17f)).toBe(false);
  expect(includes(setOf(rewritten(`${B}D`)), 0x663)).toBe(true);
  expect(rewritten('[[:digit:]]')).toBe(`[${B}x{30}-${B}x{39}]`);
  expect(includes(setOf(rewritten('[[:^alpha:]]')), 0x61)).toBe(false);
  expect(includes(setOf(rewritten('[[:^alpha:]]')), 0x31)).toBe(true);
  expect(rewritten('[[:word:]]')).toBe(rewritten(`${B}w`));
});

test('reads a class as Go’s regexp/syntax does: ], - and its ranges', () => {
  expect(rewritten('[]a]')).toBe(`[${B}x{5D}${B}x{61}]`);
  expect(rewritten('[a-]')).toBe(`[${B}x{2D}${B}x{61}]`);
  expect(rewritten('[-a]')).toBe(`[${B}x{2D}${B}x{61}]`);
  expect(rewritten(`[${B}x{41}-${B}x{43}]`)).toBe(`[${B}x{41}-${B}x{43}]`);
  expect(rewritten('[^\u0000-\u{10FFFF}]')).toBe(`[^${B}x{0}-${B}x{10FFFF}]`);
  expect(rewritten('[a[]')).toBe(`[${B}x{5B}${B}x{61}]`);
});

test('reads the escapes RE2 takes: octal, hexadecimal, C, punctuation, \\Q…\\E', () => {
  expect(rewritten(`${B}x41`)).toBe('A');
  expect(rewritten(`${B}x{1F600}`)).toBe(`${B}x{1F600}`);
  expect(rewritten(`${B}101`)).toBe('A');
  expect(rewritten(`${B}0`)).toBe(`${B}x{0}`);
  expect(rewritten(`${B}012`)).toBe(`${B}x{A}`);
  expect(rewritten(`${B}1234`)).toBe('S4');
  expect(rewritten(`${B}t${B}n`)).toBe(`${B}x{9}${B}x{A}`);
  expect(rewritten(`${B}.${B}_`)).toBe(`${B}x{2E}${B}x{5F}`);
  expect(rewritten(`${B}Qa.(b${B}E*`)).toBe(`a${B}x{2E}${B}x{28}b*`);
  expect(rewritten(`${B}Qa.b`)).toBe(`a${B}x{2E}b`);
  expect(rewritten(`(?i)${B}Qk${B}E`)).toBe(KELVIN);
  expect(rewritten(`${B}A${B}b${B}B${B}z`)).toBe(`${B}A${B}b${B}B${B}z`);
});

test('copies a repetition’s braces, and writes a brace that opens none as a literal', () => {
  expect(rewritten('a{2,3}')).toBe('a{2,3}');
  expect(rewritten('a{2,}?')).toBe('a{2,}?');
  expect(rewritten('a{2}')).toBe('a{2}');
  expect(rewritten('a{,3}')).toBe(`a${B}x{7B}${B}x{2C}3${B}x{7D}`);
  expect(rewritten('a{01}')).toBe(`a${B}x{7B}01${B}x{7D}`);
  expect(rewritten('a{')).toBe(`a${B}x{7B}`);
  expect(rewritten('.^$|*+?')).toBe('.^$|*+?');
});

test('refuses what RE2 refuses, a name Go takes and RE2 does not among them', () => {
  expect(refusal(`${B}C`)).toBe(`invalid escape sequence: \`${B}C\``);
  expect(refusal(`${B}Z`)).toBe(`invalid escape sequence: \`${B}Z\``);
  expect(refusal(`${B}8`)).toBe(`invalid escape sequence: \`${B}8\``);
  expect(refusal(`${B}1`)).toBe(`invalid escape sequence: \`${B}1\``);
  expect(refusal(`${B}x{110000}`)).toMatch(/^invalid escape sequence/u);
  expect(refusal(`${B}x{}`)).toMatch(/^invalid escape sequence/u);
  expect(refusal(`${B}xg0`)).toMatch(/^invalid escape sequence/u);
  expect(refusal(B)).toBe('trailing backslash at end of expression');
  expect(refusal(`${B}p{Cn}`)).toBe(`invalid character class range: \`${B}p{Cn}\``);
  expect(refusal(`${B}p{LC}`)).toBe(`invalid character class range: \`${B}p{LC}\``);
  expect(refusal(`${B}p{greek}`)).toBe(`invalid character class range: \`${B}p{greek}\``);
  expect(refusal(`${B}p{Letter}`)).toBe(`invalid character class range: \`${B}p{Letter}\``);
  expect(refusal(`${B}p{Greek`)).toMatch(/^invalid character class range/u);
  expect(refusal(`${B}pX`)).toBe(`invalid character class range: \`${B}pX\``);
  expect(refusal('[[:foo:]]')).toBe('invalid character class range: `[:foo:]`');
  expect(refusal(`[a-${B}d]`)).toBe(`invalid escape sequence: \`${B}d\``);
  expect(refusal('[z-a]')).toBe('invalid character class range: `z-a`');
  expect(refusal('[a')).toBe('missing closing ]: `[a`');
  expect(refusal(`[${B}Q]`)).toBe(`invalid escape sequence: \`${B}Q\``);
  expect(refusal('(?i-)a')).toMatch(/^invalid or unsupported Perl syntax/u);
  expect(refusal('(?--i)a')).toMatch(/^invalid or unsupported Perl syntax/u);
  expect(refusal('(?x)a')).toMatch(/^invalid or unsupported Perl syntax/u);
  expect(refusal('(?P=name)')).toMatch(/^invalid or unsupported Perl syntax/u);
});

test('lists each code point written alone or in a class of two, which RE2’s parser may fold', () => {
  const result = rewritePattern(`[Δδ][ab]x|[c-e]${B}.(?i)k`);

  expect(result.kind).toBe('rewritten');

  if (result.kind === 'rewritten') {
    expect(
      [...result.literals].sort((a, b) => {
        return a - b;
      })
    ).toEqual([0x2e, 0x61, 0x62, 0x78, 0x394, 0x3b4]);
  }
});

test('leaves RE2’s compiler no Unicode class and no case folding to read of its own tables', () => {
  for (const pattern of [
    `(?i)^${B}p{L}[${B}p{L}${B}p{M} '-]{0,63}$`,
    `(?i)[^${B}PL${B}d]+`,
    '(?i:(?m:a)(?s:b))(?-i)c',
    `(?i)${B}Qk${B}E[[:upper:]]${B}w`,
  ]) {
    const text = rewritten(pattern);

    expect(text).not.toMatch(/\\[pP]/u);
    expect(text).not.toMatch(/\(\?[msU-]*i/u);
  }
});
