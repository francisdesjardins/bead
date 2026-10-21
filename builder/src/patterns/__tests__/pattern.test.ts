import { readFileSync } from 'node:fs';

import { RE2JS } from '@bufbuild/re2';
import { expect, test } from '@playwright/test';

import {
  classOfPoint,
  compilePattern,
  CONSTRUCTION_CELLS_MAXIMUM,
  type IPatternTable,
  matchesTable,
  PATTERN_CELLS_MAXIMUM,
} from '../pattern.ts';

// ── A pattern's table ─────────────────────────────────────────────────────────

// A pattern compiled ahead of time into the table each runtime walks. Its verdicts are RE2's own:
// `spec/validations.json`'s, which `google-re2` gives and the pinned UCD where a class is Unicode's
// (spec 18.8.5), and, over patterns drawn at random, `@bufbuild/re2`'s own matching of the program
// the table is built from, on ASCII, where no platform's tables decide anything.

const B = '\\';

// the characters a reader would not tell apart from others, by their code points
const KELVIN_SIGN = String.fromCodePoint(0x212a);
const LONG_S = String.fromCodePoint(0x17f);
const YPOGEGRAMMENI = String.fromCodePoint(0x345);
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
// a pair of Unicode 17.0.0's, whose case an older platform's mapping does not hold
const NEW_UPPER = String.fromCodePoint(0xa7ce);
const NEW_LOWER = String.fromCodePoint(0xa7cf);

const VALIDATIONS = new URL('../../../../spec/validations.json', import.meta.url);
const VALIDATIONS_PROTO = new URL('../../../../spec/validations.proto', import.meta.url);

interface IVerdict {
  readonly name: string;
  readonly message: string;
  // the payload's bytes in hexadecimal, or bytes repeated, end to end, for one too long to write out
  readonly payload?: string;
  readonly runs?: readonly { readonly bytes: string; readonly times: number }[];
  readonly violations: readonly { readonly fieldPath: string; readonly ruleId: string }[];
}

const tableOf = (pattern: string): IPatternTable => {
  const compiled = compilePattern(pattern);

  if (compiled.kind !== 'table') {
    throw new Error(`${pattern}: ${JSON.stringify(compiled)}`);
  }

  return compiled.table;
};

// the patterns of `validations.proto`'s `Patterns`, by their field's number, and its name
const patternsOf = (proto: string): Map<number, { name: string; pattern: string }> => {
  const body = /message Patterns \{([\s\S]*?)\n\}/u.exec(proto)?.[1] ?? '';
  const fields = new Map<number, { name: string; pattern: string }>();

  for (const found of body.matchAll(/string (\w+) = (\d+) \[.*?pattern: "((?:[^"\\]|\\.)*)"/gu)) {
    fields.set(Number(found[2]), {
      name: found[1] ?? '',
      pattern: (found[3] ?? '').replaceAll(/\\(.)/gu, '$1'),
    });
  }

  return fields;
};

const bytesOf = (hex: string): number[] => {
  return hex
    .split(' ')
    .filter(Boolean)
    .map((byte) => {
      return Number.parseInt(byte, 16);
    });
};

// a payload's one string field, as protobuf's encoding writes it: its tag, its length, its UTF-8
const fieldOf = (verdict: IVerdict): { number: number; text: string } => {
  const bytes = Uint8Array.from(
    verdict.runs === undefined
      ? bytesOf(verdict.payload ?? '')
      : verdict.runs.flatMap((run) => {
          return Array.from({ length: run.times }, () => {
            return bytesOf(run.bytes);
          }).flat();
        })
  );
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;

    for (;;) {
      const byte = bytes[at] ?? 0;

      at++;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;

      if ((byte & 0x80) === 0) {
        return value;
      }
    }
  };
  const tag = varint();
  const length = varint();

  return {
    number: Math.floor(tag / 8),
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + length)),
  };
};

test('the verdicts of spec/validations.json’s patterns', () => {
  const fields = patternsOf(readFileSync(VALIDATIONS_PROTO, 'utf8'));
  const verdicts = (
    JSON.parse(readFileSync(VALIDATIONS, 'utf8')) as { verdicts: readonly IVerdict[] }
  ).verdicts.filter((verdict) => {
    return verdict.message === 'bead.validations.v1.Patterns';
  });

  expect(verdicts.length).toBeGreaterThan(20);

  for (const verdict of verdicts) {
    const { number, text } = fieldOf(verdict);
    const field = fields.get(number);

    expect(field, verdict.name).toBeDefined();

    if (field !== undefined) {
      const refused = verdict.violations.some((violation) => {
        return violation.fieldPath === field.name && violation.ruleId === 'string.pattern';
      });

      expect(matchesTable(tableOf(field.pattern), text), verdict.name).toBe(!refused);
    }
  }
});

test('matches as RE2’s own program does, over patterns drawn at random', () => {
  // a linear congruential generator, so the draw is the same on every run
  let seed = 20_261_020;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

    return seed / 2_147_483_648;
  };
  const pick = (choices: readonly string[]): string => {
    return choices[Math.floor(random() * choices.length)] ?? '';
  };
  const atoms = [
    'a',
    'b',
    'A',
    // two code points RE2's parser merges into a class, then folds into one literal
    '(?:a|A)',
    '(?:[b]|B)',
    '.',
    '[ab]',
    '[^a]',
    '[a-c]',
    `${B}d`,
    `${B}w`,
    `${B}s`,
    `${B}W`,
    `${B}b`,
    `${B}B`,
    '^',
    '$',
    `${B}A`,
    `${B}z`,
    '_',
    `${B}n`,
    '[[:upper:]]',
    `[^${B}n]`,
  ];
  const draw = (depth: number): string => {
    const choice = random();

    if (depth <= 0 || choice < 0.3) {
      return pick(atoms);
    }

    if (choice < 0.5) {
      return draw(depth - 1) + draw(depth - 1);
    }

    if (choice < 0.6) {
      return `${draw(depth - 1)}|${draw(depth - 1)}`;
    }

    if (choice < 0.7) {
      return `(${draw(depth - 1)})${pick(['*', '+', '?', '{1,3}', '{2}', '*?', ''])}`;
    }

    if (choice < 0.8) {
      return `(?:${draw(depth - 1)})${pick(['*', '+', '?', '{0,2}'])}`;
    }

    if (choice < 0.9) {
      return pick(['(?i)', '(?m)', '(?s)', '(?-i)', '(?im)']) + draw(depth - 1);
    }

    return `${pick(['(?i:', '(?m:', '(?s:', '(?-m:'])}${draw(depth - 1)})`;
  };
  const alphabet = ['a', 'b', 'A', 'B', 'c', '1', ' ', '\n', '_', '-'];
  let compared = 0;

  for (let drawn = 0; drawn < 600; drawn++) {
    const pattern = draw(4);
    let program: RE2JS;

    try {
      program = new RE2JS(pattern);
    } catch {
      continue;
    }

    const table = tableOf(pattern);

    for (let input = 0; input < 25; input++) {
      const length = Math.floor(random() * 8);
      const text = Array.from({ length }, () => {
        return pick(alphabet);
      }).join('');

      expect(matchesTable(table, text), `${pattern} on ${JSON.stringify(text)}`).toBe(
        program.test(text)
      );
      compared++;
    }
  }

  expect(compared).toBeGreaterThan(5_000);
});

test('judges the anchors, a word’s boundary and a line’s ends at the text’s end', () => {
  expect(matchesTable(tableOf('^$'), '')).toBe(true);
  expect(matchesTable(tableOf('^$'), 'a')).toBe(false);
  expect(matchesTable(tableOf(''), '')).toBe(true);
  expect(matchesTable(tableOf(`a${B}b`), 'a')).toBe(true);
  expect(matchesTable(tableOf(`a${B}B`), 'a')).toBe(false);
  expect(matchesTable(tableOf('a$'), 'a\n')).toBe(false);
  expect(matchesTable(tableOf('(?m)a$'), 'a\n')).toBe(true);
  expect(matchesTable(tableOf('(?m)^b'), 'a\nb')).toBe(true);
  expect(matchesTable(tableOf('^b'), 'a\nb')).toBe(false);
  expect(matchesTable(tableOf(`${B}Ab`), 'ab')).toBe(false);
  expect(matchesTable(tableOf(`a${B}z`), 'ba')).toBe(true);
});

test('takes (?i) and the \\p classes of Unicode 17.0.0, whatever the platform’s', () => {
  // the Kelvin sign and the long s, folded with k and s
  expect(matchesTable(tableOf('(?i)^k$'), KELVIN_SIGN)).toBe(true);
  expect(matchesTable(tableOf('(?i)^S$'), LONG_S)).toBe(true);
  expect(matchesTable(tableOf('(?i)^[^k]$'), KELVIN_SIGN)).toBe(false);
  // a pair Unicode 17.0.0 added, which an older platform's case mapping does not hold
  expect(matchesTable(tableOf(`(?i)^${NEW_UPPER}$`), NEW_LOWER)).toBe(true);
  // U+10940, a letter of Unicode 17.0.0
  expect(matchesTable(tableOf(`^${B}pL$`), '\u{10940}')).toBe(true);
  expect(matchesTable(tableOf(`^${B}p{Sidetic}+$`), '\u{10940}\u{10941}')).toBe(true);
  expect(matchesTable(tableOf(`^${B}PL$`), '\u{10940}')).toBe(false);
  expect(matchesTable(tableOf(`^${B}p{Greek}+$`), 'αβγ')).toBe(true);
  expect(matchesTable(tableOf(`^${B}p{Greek}+$`), 'αβc')).toBe(false);
  // U+0345 folds with ι: no letter, yet no other than a letter under (?i)
  expect(matchesTable(tableOf(`^${B}PL$`), YPOGEGRAMMENI)).toBe(true);
  expect(matchesTable(tableOf(`(?i)^${B}PL$`), YPOGEGRAMMENI)).toBe(false);
  expect(matchesTable(tableOf(`(?i)^${B}p{Greek}$`), YPOGEGRAMMENI)).toBe(true);
});

test('compiles a \\p class and (?i) without the platform’s RegExp or its case mapping', () => {
  const patterns = [
    `(?i)^${B}p{L}[${B}p{L}${B}p{M} '-]{0,63}$`,
    '(?i)[Δδ]k' + NEW_UPPER,
    `${B}p{Greek}`,
  ];
  const tables = patterns.map((pattern) => {
    return tableOf(pattern);
  });
  const { toLowerCase, toUpperCase } = String.prototype;
  const original = globalThis.RegExp;
  let unicodeSweeps = 0;

  globalThis.RegExp = new Proxy(original, {
    construct: (target, args: [string, string?]) => {
      if (args[0].includes('\\p{') || args[0].includes('\\P{')) {
        unicodeSweeps++;
      }

      return new target(...args);
    },
  });
  // a platform whose case mapping knows nothing
  String.prototype.toLowerCase = function identity(this: string): string {
    return this;
  };
  String.prototype.toUpperCase = String.prototype.toLowerCase;

  try {
    patterns.forEach((pattern, at) => {
      expect(tableOf(pattern)).toEqual(tables[at]);
    });
  } finally {
    globalThis.RegExp = original;
    String.prototype.toLowerCase = toLowerCase;
    String.prototype.toUpperCase = toUpperCase;
  }

  expect(unicodeSweeps).toBe(0);
});

test('refuses a pattern whose table passes 16,384 cells, VALIDATE_PATTERN_LARGE', () => {
  expect(PATTERN_CELLS_MAXIMUM).toBe(16_384);

  const counted = '[a-z]{1,1000}[0-9]{1,1000}';
  const large = compilePattern(`^${counted}${counted}${counted}$`);

  expect(large).toEqual({
    bound: 'table',
    cells: 18_006,
    classes: 3,
    kind: 'large',
    pattern: `^${counted}${counted}${counted}$`,
    states: 6002,
  });

  // the largest pattern of the design's probe that buf takes, within the bound
  const taken = compilePattern(`^${B}pL{1,1000}$`);

  expect(taken.kind).toBe('table');

  if (taken.kind === 'table') {
    expect(taken.table.stateCount * taken.table.classCount).toBeLessThanOrEqual(
      PATTERN_CELLS_MAXIMUM
    );
  }
});

test('refuses a pattern whose automaton passes 16 times as many cells while it is built', () => {
  expect(CONSTRUCTION_CELLS_MAXIMUM).toBe(16 * PATTERN_CELLS_MAXIMUM);

  // an unanchored counted ., whose automaton doubles a count, though its table is 22 states
  const large = compilePattern('a.{20}');

  expect(large.kind).toBe('large');

  if (large.kind === 'large') {
    expect(large.bound).toBe('construction');
    expect(large.cells).toBeGreaterThan(CONSTRUCTION_CELLS_MAXIMUM);
    expect(large.cells).toBe(large.states * large.classes);
  }

  // ten built within it, and minimized to a count of what follows the first a
  expect(compilePattern('a.{10}')).toMatchObject({ kind: 'table', table: { stateCount: 12 } });
});

test('refuses a pattern RE2 refuses, by RE2’s reason', () => {
  for (const pattern of ['a**', '(a', 'a)', 'x{1001}', `${B}p{greek}`, `${B}C`, '(?P=n)']) {
    expect(compilePattern(pattern).kind, pattern).toBe('refused');
  }
});

test('writes each class once, each range naming its class by index, and its cells by state', () => {
  const table = tableOf(`^${B}pL{1,64}$`);

  // a letter or not: two classes, the letters' ranges each naming the one
  expect(table.classCount).toBe(2);
  expect(table.bounds[0]).toBe(0);
  expect(table.bounds.length).toBe(table.classes.length);
  table.bounds.forEach((start, range) => {
    if (range > 0) {
      expect(start).toBeGreaterThan(table.bounds[range - 1] ?? 0);
      expect(table.classes[range]).not.toBe(table.classes[range - 1]);
    }
  });
  expect(new Set(table.classes)).toEqual(new Set([0, 1]));
  expect(classOfPoint(table, 0x61)).toBe(classOfPoint(table, 0x10940));
  expect(classOfPoint(table, 0x61)).not.toBe(classOfPoint(table, 0x31));
  expect(table.transitions.length).toBe(table.stateCount * table.classCount);
  expect(
    table.transitions.every((state) => {
      return state >= 0 && state < table.stateCount && state < 2 ** 16;
    })
  ).toBe(true);
  // the start, one state a letter counted, and the state no text matches from
  expect(table.stateCount).toBe(66);
  expect(table.accepting.length).toBe(64);
  expect(table.matched).toBe(-1);
  expect(table.dead).toBeGreaterThan(0);
  expect(tableOf('b').matched).toBeGreaterThan(0);
});

test('walks one cell a character, a lone surrogate read as U+FFFD', () => {
  const table = tableOf(`^${B}x{FFFD}$`);

  expect(matchesTable(table, REPLACEMENT_CHARACTER)).toBe(true);
  expect(matchesTable(table, '\uD800')).toBe(true);
  expect(matchesTable(table, '\uDC00')).toBe(true);
  expect(matchesTable(tableOf('^.$'), '\u{1F600}')).toBe(true);
  expect(matchesTable(tableOf('^[^a]$'), '\u{1F600}')).toBe(true);
  // the inputs a backtracking engine never ends, in time linear in the text
  expect(matchesTable(tableOf('^(a+)+$'), `${'a'.repeat(100_000)}!`)).toBe(false);
  expect(matchesTable(tableOf('[a-z]{1,1000}[0-9]'), 'a'.repeat(65_536))).toBe(false);
});
