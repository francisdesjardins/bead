#!/usr/bin/env node
// Each number a wire format's standard defines is a named constant, under one name on every side
// in its language's case, in the module `tools/wire-names.tsv` gives it (decision 0057). The table
// holds one row a concept: its format, its standard and section, its value, and its cell on the
// TypeScript, C# and Rust sides, the module that holds the name, or `-: ` and why the side reads no
// such number. This check holds the table to the sources:
//
//   - each name agrees with its concept, their letters alike once underscores are removed and case
//     is ignored, so `PUBACK` and `PubAck` are one name;
//   - each module the table names exists, on its side;
//   - each name is defined exactly once in its module, by its side's form: a TypeScript `const` or a
//     frozen object's member, a C# `const` or `static readonly` field, a Rust `const` or `static`
//     item, at the start of a line, or as a member of the holder its cell names; the definition
//     holds an integer or a character literal equal to the row's value, a Rust suffix, a byte
//     literal and a C# cast before the literal read for their value;
//   - each `-` carries a reason, and no side's column is empty.
//
//   node tools/check-wire-names.mjs          the table against the sources
//   node tools/check-wire-names.mjs --self   its own cases
//
// It reads the definitions alone and fails safe: a name it cannot find, finds twice, or finds
// holding no literal fails, so nothing it misreads lets a missing name pass. What it does not reach:
// a number written in decimal where the table names it, and a shift, which review holds; each side's
// lint holds the hex and binary literals of the modules its column names. Exit 1 on any problem,
// each with its row's line.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

export const TABLE = 'tools/wire-names.tsv';

export const SIDES = Object.freeze(['typescript', 'csharp', 'rust']);

// what a side's path starts and ends with
const FOLDERS = Object.freeze({
  typescript: 'implementations/typescript/',
  csharp: 'implementations/dotnet/',
  rust: 'implementations/rust/',
});
const EXTENSIONS = Object.freeze({ typescript: '.ts', csharp: '.cs', rust: '.rs' });

// the concept of a row that lists its format's readers
export const READS = '@reads';

const FIELDS = 7;

// ── The table ──────────────────────────────────────────────────────────────────

/** The rows of `text`, each with its line, its cells by side, and its field count. */
export const rowsOf = (text) => {
  const rows = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');

    if (line.trim() === '' || line.startsWith('#')) {
      return;
    }

    const fields = line.split('\t');
    const [format, concept, standard, value, typescript, csharp, rust] = fields;

    rows.push({
      line: index + 1,
      fields: fields.length,
      format,
      concept,
      standard,
      value,
      cells: { typescript, csharp, rust },
    });
  });

  return rows;
};

/** Whether `cell` is a `-`, which holds no path: a side that reads no such number. */
const isDash = (cell) => {
  return cell.startsWith('-');
};

/** The reason of a `-` cell, or undefined where it gives none. */
export const reasonOf = (cell) => {
  const reason = /^-: (\S.*)$/.exec(cell);

  return reason ? reason[1] : undefined;
};

/** The entries of a path cell: each path, and the name its module writes, `Holder.Member` among them. */
export const entriesOf = (cell) => {
  return cell.split(', ').map((entry) => {
    const hash = entry.indexOf('#');

    return hash === -1
      ? { path: entry, name: undefined }
      : { path: entry.slice(0, hash), name: entry.slice(hash + 1) };
  });
};

/** The modules a side's column names, its holders and its readers alike, once each, in order. */
export const modulesOf = (text, side) => {
  const paths = rowsOf(text).flatMap((row) => {
    const cell = row.cells[side] ?? '';

    return cell === '' || isDash(cell)
      ? []
      : entriesOf(cell).map(({ path }) => {
          return path;
        });
  });

  return [...new Set(paths)];
};

// ── Names ──────────────────────────────────────────────────────────────────────

/** A name's letters, by which two renderings are one name: its underscores removed, its case ignored. */
export const keyOf = (name) => {
  return name.replaceAll('_', '').toLowerCase();
};

/** The name a side writes for `concept` where its cell gives none: the concept, in PascalCase on C#. */
export const renderingOf = (concept, side) => {
  if (side !== 'csharp') {
    return concept;
  }

  return concept
    .split('_')
    .map((word) => {
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join('');
};

// ── Literals ───────────────────────────────────────────────────────────────────

const INTEGER = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*)$/;

/** The value of an integer literal, hex, binary, octal or decimal, `_` allowed, or undefined. */
export const integerOf = (text) => {
  if (!INTEGER.test(text) || text.endsWith('_') || /^0[xXbBoO]_*$/.test(text)) {
    return undefined;
  }

  return BigInt(text.replaceAll('_', ''));
};

// a suffix each side may write after an integer literal
const SUFFIXES = Object.freeze({
  typescript: /n$/,
  csharp: /(?:[uU][lL]?|[lL][uU]?)$/,
  rust: /_?(?:[ui](?:8|16|32|64|128|size))$/,
});

// an escape of a character literal, and the code point it stands for
const ESCAPES = Object.freeze({ n: 10, r: 13, t: 9, 0: 0, '\\': 92, "'": 39, '"': 34 });

/** The code point a character literal's body stands for, or undefined. */
const characterOf = (body) => {
  if (!body.startsWith('\\')) {
    return [...body].length === 1 ? BigInt(body.codePointAt(0)) : undefined;
  }

  const escape = body.slice(1);

  if (escape.length === 1 && escape in ESCAPES) {
    return BigInt(ESCAPES[escape]);
  }

  const hex = /^(?:x([0-9a-fA-F]{1,4})|u\{([0-9a-fA-F_]{1,6})\}|u([0-9a-fA-F]{4}))$/.exec(escape);

  if (!hex) {
    return undefined;
  }

  return BigInt(`0x${(hex[1] ?? hex[2] ?? hex[3]).replaceAll('_', '')}`);
};

/**
 * The value `expression` holds when it is a literal alone, by `side`'s reading: an integer literal
 * with its suffix, a character literal (Rust's byte literal among them), a C# cast before either, a
 * Rust `as` after; undefined for anything else.
 */
export const literalOf = (expression, side) => {
  let text = expression.trim();

  if (side === 'csharp') {
    text = text.replace(/^\(\s*[\w.]+\s*\)\s*/, '');
  }

  if (side === 'rust') {
    text = text.replace(/\s+as\s+\w+$/, '');
  }

  const character = side === 'typescript' ? null : /^b?'(\\.[^']*|[^'\\]+)'$/u.exec(text);

  if (character) {
    return characterOf(character[1]);
  }

  return integerOf(text.replace(SUFFIXES[side], ''));
};

// ── Reading a module ───────────────────────────────────────────────────────────

/**
 * `text` with every comment and every string or character literal blanked to spaces, its length and
 * its lines kept, so that a brace, a `;` or a name inside one is never read as code. A template's
 * holes are blanked with it.
 */
export const blankOf = (text, side) => {
  const out = [...text];
  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) {
      if (out[at] !== '\n') {
        out[at] = ' ';
      }
    }
  };
  let at = 0;

  while (at < text.length) {
    const rest = text.slice(at, at + 4);
    let end = at + 1;

    if (rest.startsWith('//')) {
      end = text.indexOf('\n', at);
      end = end === -1 ? text.length : end;
      blank(at, end);
    } else if (rest.startsWith('/*')) {
      end = text.indexOf('*/', at + 2);
      end = end === -1 ? text.length : end + 2;
      blank(at, end);
    } else if (
      side === 'rust' &&
      !/\w/.test(text[at - 1] ?? '') &&
      /^b?r#*"/.test(text.slice(at, at + 260))
    ) {
      const [open] = /^b?r(#*)"/.exec(text.slice(at, at + 260));
      const hashes = open.length - open.indexOf('r') - 2;
      const close = `"${'#'.repeat(hashes)}`;
      const found = text.indexOf(close, at + open.length);
      end = found === -1 ? text.length : found + close.length;
      blank(at, end);
    } else if (side === 'csharp' && text.startsWith('"""', at)) {
      const found = text.indexOf('"""', at + 3);
      end = found === -1 ? text.length : found + 3;
      blank(at, end);
    } else if (side === 'csharp' && /^\$?@\$?"/.test(rest)) {
      end = text.indexOf('"', at) + 1;
      while (end < text.length) {
        if (text[end] === '"' && text[end + 1] === '"') {
          end += 2;
        } else if (text[end] === '"') {
          end += 1;
          break;
        } else {
          end += 1;
        }
      }
      blank(at, end);
    } else if (
      text[at] === '"' ||
      text[at] === '`' ||
      (side === 'typescript' && text[at] === "'")
    ) {
      const quote = text[at];
      end = at + 1;
      while (end < text.length && text[end] !== quote) {
        end += text[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + 1, text.length);
      blank(at, end);
    } else if (text[at] === "'") {
      // a character literal, or a Rust lifetime, which has no closing quote
      const character = /^'(?:\\[^']*|[^'\\\n])'/u.exec(text.slice(at, at + 16));
      if (character) {
        end = at + character[0].length;
        blank(at, end);
      }
    }

    at = end;
  }

  return out.join('');
};

// the brackets a span counts, each opening's closing
const CLOSING = Object.freeze({ '(': ')', '[': ']', '{': '}' });

/** Where the bracket opened at `open` of `blank` closes, or the text's length where it never does. */
const closingOf = (blank, open) => {
  let depth = 0;

  for (let at = open; at < blank.length; at += 1) {
    if (blank[at] in CLOSING) {
      depth += 1;
    } else if (')]}'.includes(blank[at])) {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }

  return blank.length;
};

/** The end of the expression starting at `from`: its first `;`, or `,` or closing bracket, at its depth. */
const expressionEndOf = (blank, from) => {
  let depth = 0;

  for (let at = from; at < blank.length; at += 1) {
    const char = blank[at];

    if (char in CLOSING) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      if (depth === 0) {
        return at;
      }
      depth -= 1;
    } else if (depth === 0 && (char === ';' || char === ',')) {
      return at;
    }
  }

  return blank.length;
};

/** The depth of brackets at `at` of `blank`, counted from `from`. */
const depthOf = (blank, from, at) => {
  let depth = 0;

  for (let index = from; index < at; index += 1) {
    if (blank[index] in CLOSING) {
      depth += 1;
    } else if (')]}'.includes(blank[index])) {
      depth -= 1;
    }
  }

  return depth;
};

const escape = (name) => {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// where each side's form of a definition of `name` starts, its value after the match: a definition
// at the start of a line, a frozen object's member among them on the TypeScript side
const FORMS = Object.freeze({
  typescript: (name) => {
    return [
      new RegExp(
        `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${escape(name)}(?![\\w$])[ \\t]*(?::[^=\\n]*)?=`,
        'gm'
      ),
      new RegExp(`^[ \\t]*${escape(name)}[ \\t]*:`, 'gm'),
    ];
  },
  csharp: (name) => {
    return [
      new RegExp(
        `^[ \\t]*(?:(?:public|private|protected|internal|new|file)[ \\t]+)*(?:const|static[ \\t]+readonly|readonly[ \\t]+static)[ \\t]+[\\w<>\\[\\],.? \\t]+?[ \\t]+${escape(name)}[ \\t]*=`,
        'gm'
      ),
      new RegExp(
        `^[ \\t]*(?:(?:public|private|protected|internal|new|file)[ \\t]+)*static[ \\t]+ReadOnlySpan<byte>[ \\t]+${escape(name)}[ \\t]*$`,
        'gm'
      ),
    ];
  },
  rust: (name) => {
    return [
      new RegExp(
        `^[ \\t]*(?:pub(?:\\([^)\\n]*\\))?[ \\t]+)?(?:const|static)[ \\t]+${escape(name)}[ \\t]*:[^=\\n]*?=`,
        'gm'
      ),
    ];
  },
});

// where a holder's body opens, `{`, on each side: a frozen object, a static class, a module
const HOLDERS = Object.freeze({
  typescript: (holder) => {
    return new RegExp(
      `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${escape(holder)}(?![\\w$])[^=\\n]*=[ \\t]*Object\\.freeze\\([ \\t]*\\{`,
      'gm'
    );
  },
  csharp: (holder) => {
    return new RegExp(`\\b(?:class|struct|record)[ \\t]+${escape(holder)}\\b[^{;]*\\{`, 'g');
  },
  rust: (holder) => {
    return new RegExp(
      `^[ \\t]*(?:pub(?:\\([^)\\n]*\\))?[ \\t]+)?mod[ \\t]+${escape(holder)}[ \\t]*\\{`,
      'gm'
    );
  },
});

const lineAt = (text, at) => {
  return text.slice(0, at).split('\n').length;
};

/**
 * Each definition of `name` in `text`, a module of `side`, with its line and the expression it
 * holds, or undefined for a property's span; `Holder.Member` is read inside its holder alone, a
 * TypeScript member written on its holder's line among them.
 */
export const definitionsOf = (text, side, name) => {
  const blank = blankOf(text, side);
  const dot = name.indexOf('.');
  let from = 0;
  let to = blank.length;
  let member = name;
  let anywhere = false;

  if (dot !== -1) {
    const holders = [...blank.matchAll(HOLDERS[side](name.slice(0, dot)))];

    if (holders.length !== 1) {
      return [];
    }

    from = holders[0].index + holders[0][0].length - 1;
    to = closingOf(blank, from);
    member = name.slice(dot + 1);
    anywhere = side === 'typescript';
  }

  const body = blank.slice(0, to);
  const forms = anywhere
    ? [new RegExp(`(?<=[{,][ \\t\\n]*)${escape(member)}[ \\t]*:`, 'g')]
    : FORMS[side](member);
  const definitions = [];

  for (const form of forms) {
    form.lastIndex = from;

    for (let match = form.exec(body); match; match = form.exec(body)) {
      // * inside a holder, its own members alone: those at its body's depth
      if (match.index < from || (dot !== -1 && depthOf(blank, from, match.index) !== 1)) {
        continue;
      }

      const start = match.index + match[0].length;
      const holdsValue = /[=:]$/.test(match[0]);
      const end = holdsValue ? expressionEndOf(blank, start) : start;

      definitions.push({
        line: lineAt(text, match.index),
        expression: holdsValue ? text.slice(start, end).trim() : undefined,
      });
    }
  }

  return definitions.sort((one, other) => {
    return one.line - other.line;
  });
};

// ── Checking ───────────────────────────────────────────────────────────────────

/** What fails in the table's own form, its sources unread. */
export const formProblemsOf = (rows) => {
  const problems = [];
  const seen = new Set();
  const reads = new Map();

  for (const row of rows) {
    const at = `${TABLE}:${String(row.line)}`;

    if (row.fields !== FIELDS) {
      problems.push(`${at}: ${String(row.fields)} fields, not ${String(FIELDS)}`);
      continue;
    }

    const label = `${row.format} ${row.concept}`;

    if (!/^[a-z][a-z0-9]*$/.test(row.format)) {
      problems.push(`${at}: the format "${row.format}" is not a word in lower case`);
    }
    if (row.concept !== READS && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(row.concept)) {
      problems.push(`${at}: the concept "${row.concept}" is not in SCREAMING_SNAKE case`);
    }
    if (seen.has(label)) {
      problems.push(`${at}: ${label} has a row already`);
    }
    seen.add(label);

    if (row.standard.trim() === '') {
      problems.push(`${at}: ${label} names no standard`);
    }

    if (row.concept === READS) {
      reads.set(row.format, (reads.get(row.format) ?? 0) + 1);
      if (row.value !== '-') {
        problems.push(`${at}: ${label}'s value is "${row.value}", not "-"`);
      }
    } else if (
      isDash(row.value) ? reasonOf(row.value) === undefined : integerOf(row.value) === undefined
    ) {
      problems.push(
        `${at}: ${label}'s value "${row.value}" is no integer literal, nor "-: " and a reason`
      );
    }

    for (const side of SIDES) {
      const cell = row.cells[side];

      if (cell === '' || isDash(cell)) {
        if (reasonOf(cell) === undefined) {
          problems.push(`${at}: ${label}, ${side}: "${cell}" gives no reason; write "-: " and why`);
        }
        continue;
      }

      for (const { path, name } of entriesOf(cell)) {
        if (!path.startsWith(FOLDERS[side]) || !path.endsWith(EXTENSIONS[side])) {
          problems.push(
            `${at}: ${label}, ${side}: "${path}" is no ${EXTENSIONS[side]} module under ${FOLDERS[side]}`
          );
        }
        if (name !== undefined && row.concept === READS) {
          problems.push(`${at}: ${label}, ${side}: a reader's path names no name`);
        }
        if (name !== undefined && row.concept !== READS) {
          const written = name.slice(name.indexOf('.') + 1);

          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(written) || keyOf(written) !== keyOf(row.concept)) {
            problems.push(
              `${at}: ${label}, ${side}: "${name}" is not the concept's name, its letters alike under the case rule`
            );
          }
        }
      }
    }
  }

  for (const side of SIDES) {
    if (
      !rows.some((row) => {
        return row.fields === FIELDS && row.cells[side] !== '' && !isDash(row.cells[side]);
      })
    ) {
      problems.push(`${TABLE}: the ${side} column names no module`);
    }
  }

  for (const [format, count] of reads) {
    if (count > 1) {
      problems.push(`${TABLE}: ${format} has ${String(count)} ${READS} rows, not one`);
    }
  }
  for (const format of new Set(
    rows.map((row) => {
      return row.format;
    })
  )) {
    if (!reads.has(format)) {
      problems.push(`${TABLE}: ${format} has no ${READS} row`);
    }
  }

  return problems;
};

/** What fails between the table and its sources: each module there, each name defined once with its value. */
export const sourceProblemsOf = (rows, { read, exists }) => {
  const problems = [];
  const texts = new Map();
  const textOf = (path) => {
    if (!texts.has(path)) {
      texts.set(path, exists(path) ? read(path) : undefined);
    }

    return texts.get(path);
  };

  for (const row of rows) {
    if (row.fields !== FIELDS) {
      continue;
    }

    const at = `${TABLE}:${String(row.line)}`;
    const label = `${row.format} ${row.concept}`;

    for (const side of SIDES) {
      const cell = row.cells[side];

      if (cell === '' || isDash(cell)) {
        continue;
      }

      for (const { path, name } of entriesOf(cell)) {
        // a path off its side is the form's problem, and is not read
        if (!path.startsWith(FOLDERS[side]) || !path.endsWith(EXTENSIONS[side])) {
          continue;
        }

        const text = textOf(path);

        if (text === undefined) {
          problems.push(`${at}: ${label}, ${side}: ${path} does not exist`);
          continue;
        }
        if (row.concept === READS) {
          continue;
        }

        const written = name ?? renderingOf(row.concept, side);
        const definitions = definitionsOf(text, side, written);

        if (definitions.length === 0) {
          problems.push(`${at}: ${label}, ${side}: ${written} is defined nowhere in ${path}`);
          continue;
        }
        if (definitions.length > 1) {
          problems.push(
            `${at}: ${label}, ${side}: ${written} is defined ${String(definitions.length)} times in ${path}, at lines ${definitions
              .map((each) => {
                return String(each.line);
              })
              .join(', ')}`
          );
          continue;
        }
        // a value that is a reason asks the name alone; one that is no literal is the form's problem
        if (integerOf(row.value) === undefined) {
          continue;
        }

        const [{ line, expression }] = definitions;
        const value = expression === undefined ? undefined : literalOf(expression, side);

        if (value === undefined) {
          problems.push(
            `${at}: ${label}, ${side}: ${path}:${String(line)} holds no literal alone, but "${expression ?? ''}"`
          );
        } else if (value !== integerOf(row.value)) {
          problems.push(
            `${at}: ${label}, ${side}: ${path}:${String(line)} holds ${String(value)}, not the row's ${row.value}`
          );
        }
      }
    }
  }

  return problems;
};

/** What fails in `text`, the table, read against the sources by `read` and `exists`. */
export const problemsOf = (text, io) => {
  const rows = rowsOf(text);

  return [...formProblemsOf(rows), ...sourceProblemsOf(rows, io)];
};

// ── Its own cases ──────────────────────────────────────────────────────────────

const HEAD = '# format\tconcept\tstandard\tvalue\ttypescript\tcsharp\trust';
const TS_FRAME = 'implementations/typescript/src/frame.ts';
const CS_FRAME = 'implementations/dotnet/src/Frame.cs';
const RS_FRAME = 'implementations/rust/crates/bead/src/frame.rs';
const READ_ROW = ['websocket', READS, 'RFC 6455', '-', '-: none', '-: none', '-: none'];

// a table of the rows given, after its head and a format's readers' row
const tableOf = (...rows) => {
  return [HEAD, READ_ROW.join('\t'), ...rows.map((row) => row.join('\t'))].join('\n');
};

// a row of `concept` at `value`, held by the three frames, or the cells given
const rowOf = (concept, value, cells = [TS_FRAME, CS_FRAME, RS_FRAME]) => {
  return ['websocket', concept, 'RFC 6455 §5.2', value, ...cells];
};

// the three frames, each defining FIN_BIT as 0x80, then what a case adds
const FRAMES = Object.freeze({
  [TS_FRAME]: '/** RFC 6455 §5.2: FIN. */\nexport const FIN_BIT = 0x80;\n',
  [CS_FRAME]: 'internal static class Frame\n{\n    internal const byte FinBit = 0x80;\n}\n',
  [RS_FRAME]: '/// RFC 6455 §5.2: FIN.\npub(crate) const FIN_BIT: u8 = 0x80;\n',
});

/**
 * The checker's own cases: each a table and its modules, and the problems it gives, each matched
 * by one pattern, in order; none for a case that passes.
 */
export const SELF = Object.freeze([
  {
    title: 'a name defined once in each module, with its value, passes',
    table: tableOf(rowOf('FIN_BIT', '0x80')),
    files: FRAMES,
    expected: [],
  },
  {
    title: 'a name missing fails',
    table: tableOf(rowOf('FIN_BIT', '0x80')),
    files: { ...FRAMES, [RS_FRAME]: 'pub(crate) const FIN: u8 = 0x80;\n' },
    expected: [
      /rust: FIN_BIT is defined nowhere in implementations\/rust\/crates\/bead\/src\/frame\.rs$/,
    ],
  },
  {
    title: 'a name only a comment or a string writes is missing',
    table: tableOf(rowOf('FIN_BIT', '0x80')),
    files: {
      ...FRAMES,
      [TS_FRAME]: '// const FIN_BIT = 0x80;\nconst text = `\nconst FIN_BIT = 0x80;\n`;\n',
    },
    expected: [/typescript: FIN_BIT is defined nowhere/],
  },
  {
    title: 'a name found twice fails',
    table: tableOf(rowOf('FIN_BIT', '0x80')),
    files: {
      ...FRAMES,
      [CS_FRAME]:
        'internal static class Frame\n{\n    internal const byte FinBit = 0x80;\n    private static readonly byte FinBit = 0x80;\n}\n',
    },
    expected: [/csharp: FinBit is defined 2 times in .*Frame\.cs, at lines 3, 4$/],
  },
  {
    title: 'a name of another value fails',
    table: tableOf(rowOf('FIN_BIT', '0x80')),
    files: { ...FRAMES, [TS_FRAME]: 'export const FIN_BIT = 0x40;\n' },
    expected: [/typescript: .*frame\.ts:1 holds 64, not the row's 0x80$/],
  },
  {
    title: 'a name holding an expression, not a literal alone, fails',
    table: tableOf(rowOf('LONGEST_HEAD_BYTES', '14')),
    files: {
      [TS_FRAME]: 'export const LONGEST_HEAD_BYTES = 2 + 8 + 4;\n',
      [CS_FRAME]: 'internal const int LongestHeadBytes = 14;\n',
      [RS_FRAME]: 'const LONGEST_HEAD_BYTES: usize = 14;\n',
    },
    expected: [/typescript: .*frame\.ts:1 holds no literal alone, but "2 \+ 8 \+ 4"$/],
  },
  {
    title: 'a name misspelt against its concept fails',
    table: tableOf(rowOf('FIN_BIT', '0x80', [TS_FRAME, `${CS_FRAME}#FinalBit`, RS_FRAME])),
    files: FRAMES,
    expected: [
      /csharp: "FinalBit" is not the concept's name/,
      /csharp: FinalBit is defined nowhere/,
    ],
  },
  {
    title: 'a name spelt as its module writes it, PubAck for PUBACK, is one name',
    table: tableOf(rowOf('PUBACK', '4', [TS_FRAME, `${CS_FRAME}#PubAck`, RS_FRAME])),
    files: {
      [TS_FRAME]: 'const PUBACK = 4;\n',
      [CS_FRAME]:
        '    public const int PubAck = 4;\n    private static readonly HashSet<int> PubAckCodes = [0x00];\n',
      [RS_FRAME]: 'const PUBACK: u8 = 4;\nconst PUBACK_CODES: [u8; 1] = [0x00];\n',
    },
    expected: [],
  },
  {
    title: "a holder's member is read inside its holder, on one line or on several",
    table: tableOf(
      rowOf('PUBACK', '4', [`${TS_FRAME}#TYPES.PUBACK`, `${CS_FRAME}#Codes.PubAck`, RS_FRAME]),
      rowOf('SUCCESS', '0x00', [
        `${TS_FRAME}#REASON.SUCCESS`,
        '-: none',
        `${RS_FRAME}#codes.SUCCESS`,
      ])
    ),
    files: {
      [TS_FRAME]:
        'const PUBACK = 9;\nexport const TYPES = Object.freeze({ PUBACK: 4, SUBACK: 9 });\nconst REASON = Object.freeze({\n  NO_MATCH: 0x10,\n  SUCCESS: 0x00,\n});\n',
      [CS_FRAME]:
        'internal static class Other\n{\n    internal const int PubAck = 9;\n}\n\ninternal static class Codes\n{\n    internal const int PubAck = 4;\n}\n',
      [RS_FRAME]:
        'const PUBACK: u8 = 4;\npub(crate) mod codes {\n    /// Table 2-6.\n    pub(crate) const SUCCESS: u8 = 0x00;\n}\n',
    },
    expected: [],
  },
  {
    title: 'a member outside the holder its cell names is missing',
    table: tableOf(rowOf('SUCCESS', '0x00', [`${TS_FRAME}#REASON.SUCCESS`, CS_FRAME, RS_FRAME])),
    files: {
      [TS_FRAME]:
        'const REASON = Object.freeze({ FAILURE: 0x80 });\nconst OTHER = Object.freeze({ SUCCESS: 0x00 });\n',
      [CS_FRAME]: 'internal const int Success = 0x00;\n',
      [RS_FRAME]: 'const SUCCESS: u8 = 0x00;\n',
    },
    expected: [/typescript: REASON\.SUCCESS is defined nowhere/],
  },
  {
    title: 'a Rust suffix, a C# suffix and a TypeScript BigInt are read for their value',
    table: tableOf(rowOf('LARGEST_LAST_BYTE_64', '0x01')),
    files: {
      [TS_FRAME]: 'const LARGEST_LAST_BYTE_64 = 0x01n;\n',
      [CS_FRAME]: 'private const ulong LargestLastByte64 = 0x01UL;\n',
      [RS_FRAME]: 'const LARGEST_LAST_BYTE_64: u64 = 0x01_u64;\n',
    },
    expected: [],
  },
  {
    title: 'a byte literal, a character literal and a C# cast to an enum are read for their value',
    table: tableOf(
      rowOf('QUOTATION_MARK', '0x22'),
      rowOf('ESCAPE', '0x5C'),
      rowOf('TRY_AGAIN_LATER', '1013', ['-: none', CS_FRAME, RS_FRAME])
    ),
    files: {
      [TS_FRAME]: 'const QUOTATION_MARK = 0x22;\nconst ESCAPE = 0x5c;\n',
      [CS_FRAME]:
        "private const char QuotationMark = '\"';\nprivate const char Escape = '\\\\';\ninternal const WebSocketCloseStatus TryAgainLater = (WebSocketCloseStatus)1013;\n",
      [RS_FRAME]:
        "const QUOTATION_MARK: u8 = b'\"';\nconst ESCAPE: u8 = b'\\\\';\nconst TRY_AGAIN_LATER: u16 = 1_013;\n",
    },
    expected: [],
  },
  {
    title: 'a row whose value is a reason asks its name alone, an array or a span of bytes',
    table: tableOf(rowOf('BYTE_ORDER_MARK', '-: its unit on one side, its bytes on the others')),
    files: {
      [TS_FRAME]: 'const BYTE_ORDER_MARK = 0xfeff;\n',
      [CS_FRAME]:
        '    private static ReadOnlySpan<byte> ByteOrderMark\n    {\n        get\n        {\n            return [0xEF, 0xBB, 0xBF];\n        }\n    }\n',
      [RS_FRAME]: 'const BYTE_ORDER_MARK: [u8; 3] = [0xEF, 0xBB, 0xBF];\n',
    },
    expected: [],
  },
  {
    title: 'a name of several packages is defined in each',
    table: tableOf(
      rowOf('LAST_CONTROL_CHARACTER', '0x1F', [
        TS_FRAME,
        CS_FRAME,
        `${RS_FRAME}, implementations/rust/crates/bead-protobuf/src/text.rs`,
      ])
    ),
    files: {
      [TS_FRAME]: 'const LAST_CONTROL_CHARACTER = 0x1f;\n',
      [CS_FRAME]: "private const char LastControlCharacter = '\\u001F';\n",
      [RS_FRAME]: 'const LAST_CONTROL_CHARACTER: u8 = 0x1F;\n',
      'implementations/rust/crates/bead-protobuf/src/text.rs': 'const LAST_CONTROL: u8 = 0x1F;\n',
    },
    expected: [
      /rust: LAST_CONTROL_CHARACTER is defined nowhere in .*bead-protobuf\/src\/text\.rs$/,
    ],
  },
  {
    title: 'an empty column fails, and so does a module that does not exist',
    table: tableOf(
      rowOf('FIN_BIT', '0x80', [
        TS_FRAME,
        '-: none',
        'implementations/rust/crates/bead/src/gone.rs',
      ])
    ),
    files: FRAMES,
    expected: [/the csharp column names no module$/, /rust: .*gone\.rs does not exist$/],
  },
  {
    title: 'a - without a reason fails, and so does an empty cell',
    table: tableOf(
      rowOf('FIN_BIT', '0x80', [TS_FRAME, '-', '']),
      rowOf('MASK_BIT', '0x80', [TS_FRAME, CS_FRAME, '-:'])
    ),
    files: {
      ...FRAMES,
      [TS_FRAME]: 'const FIN_BIT = 0x80;\nconst MASK_BIT = 0x80;\n',
      [CS_FRAME]: 'internal const byte FinBit = 0x80;\ninternal const byte MaskBit = 0x80;\n',
    },
    expected: [
      /websocket FIN_BIT, csharp: "-" gives no reason/,
      /websocket FIN_BIT, rust: "" gives no reason/,
      /websocket MASK_BIT, rust: "-:" gives no reason/,
      /the rust column names no module$/,
    ],
  },
  {
    title: "a row's form: its fields, its concept's case, its value and a path off its side",
    table: tableOf(
      ['websocket', 'FIN_BIT', 'RFC 6455 §5.2', '0x80', TS_FRAME, CS_FRAME],
      rowOf('maskBit', '0x80', [TS_FRAME, '-: none', '-: none']),
      rowOf('OPCODE_MASK', 'fifteen'),
      rowOf('CONTROL_BIT', '0x08', [CS_FRAME, CS_FRAME, RS_FRAME])
    ),
    files: {
      ...FRAMES,
      [TS_FRAME]: 'const maskBit = 0x80;\nconst OPCODE_MASK = 0x0f;\n',
      [CS_FRAME]:
        'internal const byte MaskBit = 0x80;\ninternal const byte OpcodeMask = 0x0F;\ninternal const byte ControlBit = 0x08;\n',
      [RS_FRAME]:
        'const maskBit: u8 = 0x80;\nconst OPCODE_MASK: u8 = 0x0F;\nconst CONTROL_BIT: u8 = 0x08;\n',
    },
    expected: [
      /6 fields, not 7$/,
      /the concept "maskBit" is not in SCREAMING_SNAKE case$/,
      /OPCODE_MASK's value "fifteen" is no integer literal/,
      /CONTROL_BIT, typescript: ".*Frame\.cs" is no \.ts module under implementations\/typescript\/$/,
    ],
  },
]);

/** Each of `cases` that fails, with the problems it gave. */
export const selfFailuresOf = (cases = SELF) => {
  return cases.flatMap(({ title, table, files, expected }) => {
    const problems = problemsOf(table, {
      read: (path) => {
        return files[path];
      },
      exists: (path) => {
        return Object.hasOwn(files, path);
      },
    });
    const matches =
      problems.length === expected.length &&
      expected.every((pattern, index) => {
        return pattern.test(problems[index]);
      });

    return matches ? [] : [{ title, problems }];
  });
};

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === '--self') {
    const failures = selfFailuresOf();

    for (const { title, problems } of failures) {
      console.error(`not ok: ${title}`);
      for (const problem of problems) {
        console.error(`  ${problem}`);
      }
    }
    console.log(`${String(SELF.length - failures.length)} of ${String(SELF.length)} cases hold`);
    process.exit(failures.length > 0 ? 1 : 0);
  }

  if (args.length > 0) {
    console.error(`unknown arguments: ${args.join(' ')}; give none, or --self`);
    process.exit(1);
  }

  const problems = problemsOf(readFileSync(resolve(ROOT, TABLE), 'utf8'), {
    read: (path) => {
      return readFileSync(resolve(ROOT, path), 'utf8');
    },
    exists: (path) => {
      return existsSync(resolve(ROOT, path));
    },
  });

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
