// ── A pattern written out ─────────────────────────────────────────────────────

// A pattern in RE2's syntax, as protovalidate's `string.pattern` takes it, rewritten into one that
// means the same with no Unicode class and no case folding left: each class, `\p{Greek}`, `\d`,
// `[[:alpha:]]` or `[^a-z]`, written as the explicit ranges of beadc's own tables, and under `(?i)`
// each literal and each class written with its simple case folding, the flag itself taken out. So
// `@bufbuild/re2` compiles a pattern that asks nothing of its own tables, which sweep the running
// Node's `RegExp` for a `\p` class and ask its `toLowerCase` for a fold: the program follows Unicode
// 17.0.0 whatever the Node (spec 18.8.5, decision 0035).
//
// The reading is Go's `regexp/syntax` under its Perl flags, RE2's own, which buf's `PROTOVALIDATE`
// compiles a pattern with: an escape, a class, a group's flags and a repetition's braces read as it
// reads them, a fold applied to each part of a class before the class is negated. What RE2 refuses
// is refused here too: `\C`, a name RE2 does not take (`\p{Cn}`, `\p{LC}`, `\p{greek}`, which Go
// 1.25 takes and RE2 does not), an escape it does not know. The rest of the structure, its
// alternations, groups and repetitions, is copied as written, for RE2's compiler to judge.

// dependencies

import {
  type CodePoints,
  codePointsOf,
  complementOf,
  foldedOf,
  orbitOf,
  rangesOf,
  unicodeClass,
  unionOf,
} from './code-points.ts';

// types

/** A pattern written out: RE2's syntax with no Unicode class and no case folding left. */
export interface IRewritten {
  readonly kind: 'rewritten';
  /** The pattern rewritten. */
  readonly text: string;
  /**
   * Each code point written as a literal, or in a class of one or two: RE2's parser takes a class
   * of two, `[Δδ]` as written or `Δ|δ` as it merges it, for one literal folded by its own tables,
   * so the program's reader takes the other back from among these.
   */
  readonly literals: ReadonlySet<number>;
}

/** A pattern beadc does not compile, and why, in RE2's words where RE2 has them. */
export interface IRefused {
  readonly kind: 'refused';
  readonly reason: string;
}

// constants

const BACKSLASH = 0x5c;

// the surrogates, which no string's code point is: a lone one is read as U+FFFD
const SURROGATES: CodePoints = Object.freeze([0xd800, 0xdfff]);

// RE2's Perl classes, of ASCII
const PERL_CLASSES: Readonly<Record<string, CodePoints>> = Object.freeze({
  d: Object.freeze([0x30, 0x39]),
  s: Object.freeze([0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x20]),
  w: Object.freeze([0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]),
});

// RE2's POSIX classes, of ASCII
const POSIX_CLASSES: Readonly<Record<string, CodePoints>> = Object.freeze({
  alnum: Object.freeze([0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a]),
  alpha: Object.freeze([0x41, 0x5a, 0x61, 0x7a]),
  ascii: Object.freeze([0x00, 0x7f]),
  blank: Object.freeze([0x09, 0x09, 0x20, 0x20]),
  cntrl: Object.freeze([0x00, 0x1f, 0x7f, 0x7f]),
  digit: Object.freeze([0x30, 0x39]),
  graph: Object.freeze([0x21, 0x7e]),
  lower: Object.freeze([0x61, 0x7a]),
  print: Object.freeze([0x20, 0x7e]),
  punct: Object.freeze([0x21, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0x7e]),
  space: Object.freeze([0x09, 0x0d, 0x20, 0x20]),
  upper: Object.freeze([0x41, 0x5a]),
  word: Object.freeze([0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]),
  xdigit: Object.freeze([0x30, 0x39, 0x41, 0x46, 0x61, 0x66]),
});

// the C escapes RE2 takes, by their letter
const C_ESCAPES: Readonly<Record<string, number>> = Object.freeze({
  a: 0x07,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
});

// the cause of a refusal, thrown from inside the reading and caught at its top
const REFUSED = Symbol('refused');

// a code point read, and where the reading goes on
interface IRead<T> {
  readonly value: T;
  readonly next: number;
}

// definition

const refuse = (reason: string): never => {
  throw new Error(reason, { cause: REFUSED });
};

const isRefusal = (thrown: unknown): thrown is Error => {
  return thrown instanceof Error && thrown.cause === REFUSED;
};

const isDigit = (point: number | undefined): point is number => {
  return point !== undefined && point >= 0x30 && point <= 0x39;
};

const isOctal = (point: number | undefined): point is number => {
  return point !== undefined && point >= 0x30 && point <= 0x37;
};

const isAlphanumeric = (point: number): boolean => {
  return isDigit(point) || (point >= 0x41 && point <= 0x5a) || (point >= 0x61 && point <= 0x7a);
};

const hexOf = (point: number | undefined): number => {
  if (point === undefined) {
    return -1;
  }

  if (isDigit(point)) {
    return point - 0x30;
  }

  if (point >= 0x41 && point <= 0x46) {
    return point - 0x41 + 10;
  }

  if (point >= 0x61 && point <= 0x66) {
    return point - 0x61 + 10;
  }

  return -1;
};

const textOf = (points: readonly number[], span: { from: number; to: number }): string => {
  return String.fromCodePoint(...points.slice(span.from, span.to));
};

const indexOf = (
  points: readonly number[],
  options: { from: number; sequence: string }
): number => {
  const sequence = Array.from(options.sequence, (character) => {
    return character.codePointAt(0) ?? 0;
  });

  for (let at = options.from; at + sequence.length <= points.length; at++) {
    if (
      sequence.every((point, offset) => {
        return points[at + offset] === point;
      })
    ) {
      return at;
    }
  }

  return -1;
};

/**
 * An ordinary escape at `at`, its backslash there: an octal, a hexadecimal, a C escape, or a
 * punctuation character escaped, as Go's `parseEscape` reads one.
 */
const escapeAt = (points: readonly number[], at: number): IRead<number> => {
  const letter = points[at + 1];

  if (letter === undefined) {
    return refuse('trailing backslash at end of expression');
  }

  const character = String.fromCodePoint(letter);
  const cEscape = C_ESCAPES[character];

  if (cEscape !== undefined) {
    return { next: at + 2, value: cEscape };
  }

  // a non-zero digit alone is a backreference, which RE2 does not take
  if (letter === 0x30 || (isOctal(letter) && isOctal(points[at + 2]))) {
    let value = letter - 0x30;
    let next = at + 2;

    for (let digits = 1; digits < 3 && isOctal(points[next]); digits++) {
      value = value * 8 + (points[next] ?? 0) - 0x30;
      next++;
    }

    return { next, value };
  }

  if (character === 'x') {
    if (points[at + 2] === 0x7b) {
      let value = 0;
      let next = at + 3;

      while (points[next] !== 0x7d) {
        const digit = hexOf(points[next]);

        if (digit < 0) {
          return refuse(
            `invalid escape sequence: \`${textOf(points, { from: at, to: next + 1 })}\``
          );
        }

        value = value * 16 + digit;

        if (value > 0x10ffff) {
          return refuse(
            `invalid escape sequence: \`${textOf(points, { from: at, to: next + 1 })}\``
          );
        }

        next++;
      }

      if (next === at + 3) {
        return refuse(`invalid escape sequence: \`${textOf(points, { from: at, to: next + 1 })}\``);
      }

      return { next: next + 1, value };
    }

    const high = hexOf(points[at + 2]);
    const low = hexOf(points[at + 3]);

    if (high < 0 || low < 0) {
      return refuse(`invalid escape sequence: \`${textOf(points, { from: at, to: at + 4 })}\``);
    }

    return { next: at + 4, value: high * 16 + low };
  }

  if (letter < 0x80 && !isAlphanumeric(letter)) {
    return { next: at + 2, value: letter };
  }

  return refuse(`invalid escape sequence: \`${textOf(points, { from: at, to: at + 2 })}\``);
};

/** A Unicode class at `at`, `\pL`, `\p{Greek}`, `\P{^Greek}`, folded first where `fold` holds. */
const unicodeClassAt = (
  points: readonly number[],
  options: { at: number; fold: boolean }
): IRead<CodePoints> => {
  const { at } = options;
  let negated = points[at + 1] === 0x50;
  const opening = points[at + 2];
  let name: string;
  let next: number;

  if (opening === undefined) {
    return refuse(`invalid character class range: \`${textOf(points, { from: at, to: at + 2 })}\``);
  }

  if (opening === 0x7b) {
    const end = points.indexOf(0x7d, at);

    if (end < 0) {
      return refuse(
        `invalid character class range: \`${textOf(points, { from: at, to: points.length })}\``
      );
    }

    name = textOf(points, { from: at + 3, to: end });
    next = end + 1;
  } else {
    name = String.fromCodePoint(opening);
    next = at + 3;
  }

  if (name.startsWith('^')) {
    negated = !negated;
    name = name.slice(1);
  }

  const found = unicodeClass(name);

  if (found === undefined) {
    return refuse(`invalid character class range: \`${textOf(points, { from: at, to: next })}\``);
  }

  const folded = options.fold ? foldedOf(found) : found;

  return { next, value: negated ? complementOf(folded) : folded };
};

/** A Perl class at `at`, `\d` or `\W`, or `undefined` where none is. */
const perlClassAt = (
  points: readonly number[],
  options: { at: number; fold: boolean }
): IRead<CodePoints> | undefined => {
  const letter = points[options.at + 1];

  if (points[options.at] !== BACKSLASH || letter === undefined) {
    return undefined;
  }

  const character = String.fromCodePoint(letter);
  const found = PERL_CLASSES[character.toLowerCase()];

  if (found === undefined || !'dDsSwW'.includes(character)) {
    return undefined;
  }

  const folded = options.fold ? foldedOf(found) : found;

  return {
    next: options.at + 2,
    value: character === character.toUpperCase() ? complementOf(folded) : folded,
  };
};

/** A class's character at `at`, as written or escaped. */
const classCharacterAt = (points: readonly number[], at: number): IRead<number> => {
  const point = points[at];

  if (point === undefined) {
    return refuse('missing closing ]');
  }

  return point === BACKSLASH ? escapeAt(points, at) : { next: at + 1, value: point };
};

/** A bracketed class at `at`, its `[` there, as Go's `parseClass` reads one. */
const classAt = (
  points: readonly number[],
  options: { at: number; fold: boolean }
): IRead<CodePoints> => {
  const { fold } = options;
  let at = options.at + 1;
  const negated = points[at] === 0x5e;
  let set: CodePoints = [];
  let first = true;

  if (negated) {
    at++;
  }

  for (;;) {
    const point = points[at];

    if (point === undefined) {
      return refuse(
        `missing closing ]: \`${textOf(points, { from: options.at, to: points.length })}\``
      );
    }

    if (point === 0x5d && !first) {
      break;
    }

    first = false;

    // a POSIX class, `[:alpha:]` or `[:^alpha:]`
    if (point === 0x5b && points[at + 1] === 0x3a) {
      const end = indexOf(points, { from: at + 2, sequence: ':]' });

      if (end >= 0) {
        const written = textOf(points, { from: at + 2, to: end });
        const name = written.startsWith('^') ? written.slice(1) : written;
        const found = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined;

        if (found === undefined) {
          return refuse(
            `invalid character class range: \`${textOf(points, { from: at, to: end + 2 })}\``
          );
        }

        const folded = fold ? foldedOf(found) : found;

        set = unionOf(set, written.startsWith('^') ? complementOf(folded) : folded);
        at = end + 2;
        continue;
      }
    }

    if (point === BACKSLASH && (points[at + 1] === 0x70 || points[at + 1] === 0x50)) {
      const read = unicodeClassAt(points, { at, fold });

      set = unionOf(set, read.value);
      at = read.next;
      continue;
    }

    const perl = perlClassAt(points, { at, fold });

    if (perl !== undefined) {
      set = unionOf(set, perl.value);
      at = perl.next;
      continue;
    }

    const low = classCharacterAt(points, at);
    let high = low;

    if (
      points[low.next] === 0x2d &&
      points[low.next + 1] !== undefined &&
      points[low.next + 1] !== 0x5d
    ) {
      high = classCharacterAt(points, low.next + 1);

      if (high.value < low.value) {
        return refuse(
          `invalid character class range: \`${textOf(points, { from: at, to: high.next })}\``
        );
      }
    }

    const range = codePointsOf([[low.value, high.value]]);

    set = unionOf(set, fold ? foldedOf(range) : range);
    at = high.next;
  }

  return { next: at + 1, value: negated ? complementOf(set) : set };
};

/** The end of a repetition's braces at `at`, `{n}`, `{n,}` or `{n,m}`, or `-1` where `{` is a literal. */
const repetitionEndAt = (points: readonly number[], at: number): number => {
  // a count's digits, none led by a zero
  const countEnd = (from: number): number => {
    if (!isDigit(points[from])) {
      return -1;
    }

    if (points[from] === 0x30 && isDigit(points[from + 1])) {
      return -1;
    }

    let end = from;

    while (isDigit(points[end])) {
      end++;
    }

    return end;
  };

  let next = countEnd(at + 1);

  if (next < 0) {
    return -1;
  }

  if (points[next] === 0x2c) {
    next++;

    if (points[next] !== 0x7d) {
      next = countEnd(next);

      if (next < 0) {
        return -1;
      }
    }
  }

  return points[next] === 0x7d ? next + 1 : -1;
};

/** A group's flags at `at`, its `(?` there: `(?i)`, `(?-m:`, as Go's `parsePerlFlags` reads them. */
const flagsAt = (
  points: readonly number[],
  options: { at: number; fold: boolean }
): {
  readonly fold: boolean;
  readonly kept: string;
  readonly next: number;
  readonly opens: boolean;
} => {
  let fold = options.fold;
  let negative = false;
  let sawFlag = false;
  let positives = '';
  let negatives = '';

  for (let at = options.at + 2; at < points.length; at++) {
    const character = String.fromCodePoint(points[at] ?? 0);

    if (character === ':' || character === ')') {
      if (negative && !sawFlag) {
        break;
      }

      const kept = `${positives}${negatives === '' ? '' : `-${negatives}`}`;

      return { fold, kept, next: at + 1, opens: character === ':' };
    }

    if (character === '-') {
      if (negative) {
        break;
      }

      negative = true;
      sawFlag = false;
      continue;
    }

    if (!'imsU'.includes(character)) {
      break;
    }

    sawFlag = true;

    if (character === 'i') {
      fold = !negative;
    } else if (negative) {
      negatives += character;
    } else {
      positives += character;
    }
  }

  return refuse(
    `invalid or unsupported Perl syntax: \`${textOf(points, { from: options.at, to: options.at + 3 })}\``
  );
};

/** `pattern` written out, or why beadc refuses it. */
export const rewritePattern = (pattern: string): IRewritten | IRefused => {
  const points = Array.from(pattern, (character) => {
    return character.codePointAt(0) ?? 0;
  });
  const literals = new Set<number>();
  const out: string[] = [];
  // each group's fold, the innermost last
  const folds = [false];

  const writeClass = (set: CodePoints): void => {
    const kept = complementOf(unionOf(complementOf(set), SURROGATES));
    const ranges = rangesOf(kept);

    if (ranges.length === 0) {
      out.push('[^\\x{0}-\\x{10FFFF}]');

      return;
    }

    const [first, second] = ranges;

    if (first !== undefined && ranges.length <= 2) {
      const last = second ?? first;
      const size = first[1] - first[0] + 1 + (second === undefined ? 0 : second[1] - second[0] + 1);

      if (size <= 2) {
        literals.add(first[0]);
        literals.add(last[1]);
      }
    }

    const written = ranges.map(([low, high]) => {
      const lowText = `\\x{${low.toString(16).toUpperCase()}}`;

      return low === high ? lowText : `${lowText}-\\x{${high.toString(16).toUpperCase()}}`;
    });

    out.push(`[${written.join('')}]`);
  };

  const writeLiteral = (point: number, fold: boolean): void => {
    const orbit = fold ? orbitOf(point) : [point];

    if (orbit.length > 1) {
      writeClass(
        codePointsOf(
          orbit.map((each) => {
            return [each, each];
          })
        )
      );
    } else if (isAlphanumeric(point)) {
      literals.add(point);
      out.push(String.fromCodePoint(point));
    } else {
      literals.add(point);
      out.push(`\\x{${point.toString(16).toUpperCase()}}`);
    }
  };

  try {
    let at = 0;

    while (at < points.length) {
      const point = points[at] ?? 0;
      const fold = folds.at(-1) ?? false;
      const character = String.fromCodePoint(point);

      if (character === '(') {
        if (points[at + 1] !== 0x3f) {
          folds.push(fold);
          out.push('(');
          at++;
        } else if (
          points[at + 2] === 0x3c ||
          (points[at + 2] === 0x50 && points[at + 3] === 0x3c)
        ) {
          const end = points.indexOf(0x3e, at);

          if (end < 0) {
            return refuse(
              `invalid named capture: \`${textOf(points, { from: at, to: points.length })}\``
            );
          }

          folds.push(fold);
          out.push(textOf(points, { from: at, to: end + 1 }));
          at = end + 1;
        } else {
          const flags = flagsAt(points, { at, fold });

          if (flags.opens) {
            folds.push(flags.fold);
            out.push(`(?${flags.kept}:`);
          } else {
            folds[folds.length - 1] = flags.fold;

            if (flags.kept !== '') {
              out.push(`(?${flags.kept})`);
            }
          }

          at = flags.next;
        }
      } else if (character === ')') {
        if (folds.length > 1) {
          folds.pop();
        }

        out.push(')');
        at++;
      } else if (character === '[') {
        const read = classAt(points, { at, fold });

        writeClass(read.value);
        at = read.next;
      } else if (character === '{') {
        const end = repetitionEndAt(points, at);

        if (end < 0) {
          writeLiteral(point, fold);
          at++;
        } else {
          out.push(textOf(points, { from: at, to: end }));
          at = end;
        }
      } else if ('.^$|*+?'.includes(character)) {
        out.push(character);
        at++;
      } else if (point !== BACKSLASH) {
        writeLiteral(point, fold);
        at++;
      } else {
        const letter = String.fromCodePoint(points[at + 1] ?? 0);
        const perl = perlClassAt(points, { at, fold });

        if ('AzbB'.includes(letter)) {
          out.push(`\\${letter}`);
          at += 2;
        } else if (letter === 'C') {
          return refuse('invalid escape sequence: `\\C`');
        } else if (letter === 'Q') {
          const end = indexOf(points, { from: at + 2, sequence: '\\E' });
          const last = end < 0 ? points.length : end;

          for (const quoted of points.slice(at + 2, last)) {
            writeLiteral(quoted, fold);
          }

          at = end < 0 ? points.length : end + 2;
        } else if (letter === 'p' || letter === 'P') {
          const read = unicodeClassAt(points, { at, fold });

          writeClass(read.value);
          at = read.next;
        } else if (perl !== undefined) {
          writeClass(perl.value);
          at = perl.next;
        } else {
          const read = escapeAt(points, at);

          writeLiteral(read.value, fold);
          at = read.next;
        }
      }
    }
  } catch (thrown) {
    if (isRefusal(thrown)) {
      return { kind: 'refused', reason: thrown.message };
    }

    throw thrown;
  }

  return { kind: 'rewritten', literals, text: out.join('') };
};
