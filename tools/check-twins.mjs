#!/usr/bin/env node
// A test one side declares is played on the Rust side too, or a row of `tools/twins.tsv` says why
// it is not (CLAUDE.md, Parity: a test missing on one side is added to the others). The tool reads
// the declarations of the three sides from the files git lists: each TypeScript or JavaScript
// test's title, of a `*.test.ts` or `*.test.mjs` under a folder `typescript`, `builder` or `tools`;
// each C# method under `[Fact]` or `[Theory]` of `implementations/dotnet/tests/`, its generated
// files aside; and on the Rust side each `fn` under `#[test]` or `#[tokio::test]`, each trial a
// libtest-mimic player names by a literal, and the trials the codec, transcoding, transports and
// vectors players build from their files' entries. A TypeScript or a C# declaration is twinned when
// its title's key is a Rust declaration's.
//
//   node tools/check-twins.mjs           the declarations against tools/twins.tsv
//   node tools/check-twins.mjs --write   adds a `pending` row for each declaration with no twin and
//                                        no row, and drops each row whose declaration is twinned
//
// ! --write classifies nothing: a `pending` row fails the check until a reader gives it its class
// and its reason
//
// A title's key is its words in snake case, ASCII alone: a superscript after a digit its own word
// (`2³¹` is `2_31`), a camel-case boundary a word's, `µ` read as `u`, every other run of what is no
// letter or digit one separator, `type_script` and its kin one word, a possessive's `_s` the word
// before it, and a trailing spec label, `(spec 15.33)`, left out.
//
// A row is tab-separated: the side, `typescript` or `csharp`; the file, as git lists it; the title,
// as the side declares it; the class; and the reason, plain text that names the twin, the row of
// docs/support.md or the platform, `-` on a `pending` row. One row stands for every declaration of
// its title in its file. The rows are sorted by side, file and title. The class is one of these:
//
//   retitled   a Rust twin under another sentence
//   held       a Rust twin under the same sentence, which the key does not reach: a group's
//              title before it, a trial's name built at run time
//   ahead      what it tests is ahead for the Rust side, a row of docs/support.md
//   native     native to its platform or its tool, which the Rust side has no part of
//   pending    a declaration --write added, which no reader has classified yet
//
// What it does not reach: a Rust test with no twin on the other sides, and a twin the TypeScript
// and C# sides owe each other; a twin a row names, which review holds, not the tool; a title a
// TypeScript test builds from a variable or an expression, which declares nothing it can read.
//
// Exit 1 on a declaration with no twin and no row; on a `pending` row; on a row whose declaration
// is twinned or gone; on a row with the wrong number of cells, an unknown side or class, no reason,
// a duplicate, or out of order. Exit 2 on an argument it does not know.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const TWINS = 'tools/twins.tsv';

// the sides a row may name: the Rust side is the one each row is read against
export const SIDES = Object.freeze(['typescript', 'csharp']);

export const CLASSES = Object.freeze(['retitled', 'held', 'ahead', 'native', 'pending']);

// what a `pending` row's reason holds until a reader writes one
const UNREAD = '-';

// ── Keys ───────────────────────────────────────────────────────────────────────

const SUPERSCRIPTS = /(\d)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gu;

// words a camel-case split cuts in two, joined again
const JOINED = Object.freeze([
  ['type_script', 'typescript'],
  ['java_script', 'javascript'],
  ['web_socket', 'websocket'],
  ['i_pv6', 'ipv6'],
  ['i_pv4', 'ipv4'],
]);

/**
 * A title's key, by which a declaration finds its twin on another side: its words in snake case,
 * ASCII alone, as the header says.
 */
export const keyOf = (title) => {
  let key = title
    .replace(SUPERSCRIPTS, (_, digit, raised) => {
      return `${digit}_${raised.normalize('NFKD')}`;
    })
    .replace(/(?<=[a-z0-9])(?=[A-Z][a-z])/g, '_')
    .replaceAll('µs', 'us')
    .replaceAll('µ', 'u')
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  for (const [split, word] of JOINED) {
    key = key.replaceAll(split, word);
  }

  return key.replace(/_s(?=_|$)/g, 's').replace(/_spec(?:_\d+)+$/, '');
};

// ── TypeScript ─────────────────────────────────────────────────────────────────

// the members a test's call may name between its name and its parenthesis: `test.only(`
const MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);

// the words after which a `/` opens a regular expression, not a division
const KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

const ESCAPES = Object.freeze({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' });

// a string's or a template's escapes read, as the language reads them
const cooked = (raw) => {
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|(.))/gs,
    (_, braced, four, two, other) => {
      const code = braced ?? four ?? two;

      if (code !== undefined) {
        return String.fromCodePoint(Number.parseInt(code, 16));
      }
      if (other === undefined) {
        return '';
      }

      return ESCAPES[other] ?? other;
    }
  );
};

// where a quoted string that opens at an offset ends, past its quote
const stringEnd = (source, at) => {
  const quote = source[at];
  let index = at + 1;

  while (index < source.length && source[index] !== quote) {
    index += source[index] === '\\' ? 2 : 1;
  }

  return index + 1;
};

// where a regular expression that opens at an offset ends, past its flags
const regexEnd = (source, at) => {
  let index = at + 1;
  let inClass = false;

  while (index < source.length && source[index] !== '\n') {
    const character = source[index];

    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') {
      inClass = true;
    } else if (character === ']') {
      inClass = false;
    } else if (character === '/' && !inClass) {
      index += 1;
      break;
    }
    index += 1;
  }
  while (/[a-z]/i.test(source[index] ?? '')) {
    index += 1;
  }

  return index;
};

// the tokens of a stretch of code, from an offset to its end or to the `}` that closes a
// template's substitution; a template a token of its own, its substitutions read through
const tokensOf = (source, at, tokens, options = {}) => {
  let index = at;
  let depth = 0;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);

      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);

      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = stringEnd(source, index);

      tokens.push({
        type: 'string',
        start: index,
        value: cooked(source.slice(index + 1, end - 1)),
      });
      index = end;
      continue;
    }
    if (character === '`') {
      const start = index;
      let substituted = false;

      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') {
          index += 2;
        } else if (source.startsWith('${', index)) {
          substituted = true;
          index = tokensOf(source, index + 2, [], { inside: true });
        } else {
          index += 1;
        }
      }
      index += 1;
      const raw = source.slice(start + 1, index - 1);

      tokens.push({ type: 'string', start, value: substituted ? raw : cooked(raw) });
      continue;
    }
    if (/[\p{L}\p{Nl}$_]/u.test(character)) {
      const name = source.slice(index).match(/^[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]+/u)[0];

      tokens.push({ type: 'name', start: index, value: name });
      index += name.length;
      continue;
    }
    if (/\d/.test(character)) {
      const number = source.slice(index).match(/^[\d._a-zA-Z]+/)[0];

      tokens.push({ type: 'number', start: index, value: number });
      index += number.length;
      continue;
    }
    if (character === '/') {
      const before = tokens.at(-1);
      const divides =
        before !== undefined &&
        (before.type === 'string' ||
          before.type === 'number' ||
          (before.type === 'name' && !KEYWORDS.has(before.value)) ||
          (before.type === 'punctuation' && [')', ']'].includes(before.value)));

      if (!divides) {
        index = regexEnd(source, index);
        tokens.push({ type: 'regex', start: index, value: '' });
        continue;
      }
    }
    if (options.inside === true) {
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        if (depth === 0) {
          return index + 1;
        }
        depth -= 1;
      }
    }
    tokens.push({ type: 'punctuation', start: index, value: character });
    index += 1;
  }

  return index;
};

// the line of an offset, from one
const lineAt = (source, at) => {
  let line = 1;

  for (let index = source.indexOf('\n'); index !== -1 && index < at;) {
    line += 1;
    index = source.indexOf('\n', index + 1);
  }

  return line;
};

/**
 * A TypeScript or JavaScript test file's declarations: the title of each call of `test` or `it`,
 * a modifier or several between (`test.only(`), whose first argument is a string or a template
 * alone. A template's title is its text as written, its substitutions with it; one whose
 * substitution is `${String(seed)}` under `for (const seed of [1, 2])` is the two titles it builds.
 */
export const scriptDeclarationsOf = (source) => {
  const tokens = [];
  const declarations = [];

  tokensOf(source, 0, tokens);
  for (const [index, token] of tokens.entries()) {
    const before = tokens[index - 1];

    if (
      token.type !== 'name' ||
      !['test', 'it'].includes(token.value) ||
      (before?.type === 'punctuation' && before.value === '.')
    ) {
      continue;
    }
    let at = index + 1;

    while (
      tokens[at]?.value === '.' &&
      tokens[at + 1]?.type === 'name' &&
      MODIFIERS.has(tokens[at + 1].value)
    ) {
      at += 2;
    }
    const [open, title, after] = tokens.slice(at, at + 3);

    if (
      open?.value !== '(' ||
      title?.type !== 'string' ||
      after?.type !== 'punctuation' ||
      ![',', ')'].includes(after.value)
    ) {
      continue;
    }
    const line = lineAt(source, token.start);
    const seeded =
      title.value.includes('${String(seed)}') &&
      /for \(const seed of \[1, 2\]\)/.test(source.slice(0, token.start));
    const titles = seeded
      ? [1, 2].map((seed) => {
          return title.value.replace('${String(seed)}', String(seed));
        })
      : [title.value];

    for (const expanded of titles) {
      declarations.push({ title: expanded, line });
    }
  }

  return declarations;
};

// ── C# ─────────────────────────────────────────────────────────────────────────

/**
 * A C# test file's declarations: the name of each public method after a `[Fact]` or a `[Theory]`.
 */
export const cSharpDeclarationsOf = (source) => {
  const declarations = [];
  let pending = false;

  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*\[(?:Fact|Theory)\b/.test(line)) {
      pending = true;
      continue;
    }
    if (pending) {
      const method = line.match(
        /^\s*public\s+(?:async\s+)?(?:static\s+)?[\p{L}\p{N}_<>]+\s+([\p{L}\p{N}_]+)\s*\(/u
      );

      if (method !== null) {
        declarations.push({ title: method[1], line: index + 1 });
        pending = false;
      }
    }
  }

  return declarations;
};

// ── Rust ───────────────────────────────────────────────────────────────────────

// the players whose trials a file's entries name: `<group>: <entry>`, one declaration a group
const CODECS = Object.freeze([
  'implementations/rust/crates/bead/tests/codecs.rs',
  'implementations/rust/crates/bead-protobuf/tests/codecs.rs',
]);
const PLAYERS = Object.freeze([
  'implementations/rust/crates/bead-protobuf/tests/transcoding.rs',
  'implementations/rust/crates/bead/tests/transports.rs',
  'implementations/rust/crates/bead/tests/vectors.rs',
]);

/**
 * A Rust file's declarations: each `fn` under `#[test]` or `#[tokio::test]`, each libtest-mimic
 * trial named by a literal, `Trial::test("…"`, and, in the players that build their trials' names
 * from a file's entries, each such name as one declaration: `<group>: ${entry.name}`, and the
 * transports player's `reads ${name}, by its length…`.
 */
export const rustDeclarationsOf = (path, source) => {
  const declarations = [];
  let pending = false;

  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*#\[(?:tokio::)?test\b/.test(line)) {
      pending = true;
      continue;
    }
    if (pending) {
      const fn = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([\p{L}\p{N}_]+)/u);

      if (fn !== null) {
        declarations.push({ title: fn[1], line: index + 1 });
        pending = false;
      }
    }
  }
  const add = (title, at) => {
    declarations.push({ title, line: lineAt(source, at) });
  };

  for (const found of source.matchAll(/Trial::test\(\s*"([^"]+)"/g)) {
    add(found[1], found.index);
  }
  if (CODECS.includes(path)) {
    for (const found of source.matchAll(
      /let name = format!\(\s*"([^"\n]+): \{\}",\s*(?:payload|entry)\.name\s*\)/g
    )) {
      add(`${found[1]}: \${entry.name}`, found.index);
    }
  }
  if (PLAYERS.includes(path)) {
    for (const found of source.matchAll(/format!\(\s*"([a-z]+): \{\}",\s*entry\.name\s*\)/g)) {
      add(`${found[1]}: \${entry.name}`, found.index);
    }
    for (const found of source.matchAll(/format!\(\s*"(reads )\{name\}(, by its length[^"]+)"/g)) {
      add(`${found[1]}\${name}${found[2]}`, found.index);
    }
  }

  return declarations;
};

// ── Declarations ───────────────────────────────────────────────────────────────

// which side a file's declarations belong to, or none
const sideOf = (path) => {
  if (/\.test\.(?:ts|mjs)$/.test(path) && /(?:^|\/)(?:typescript|builder|tools)\//.test(path)) {
    return 'typescript';
  }
  if (
    path.startsWith('implementations/dotnet/tests/') &&
    path.endsWith('.cs') &&
    !path.includes('/Generated/')
  ) {
    return 'csharp';
  }
  if (path.startsWith('implementations/rust/') && path.endsWith('.rs')) {
    return 'rust';
  }

  return undefined;
};

const READERS = Object.freeze({
  typescript: (_, source) => {
    return scriptDeclarationsOf(source);
  },
  csharp: (_, source) => {
    return cSharpDeclarationsOf(source);
  },
  rust: rustDeclarationsOf,
});

/**
 * The declarations of the three sides, each with its file, its line, its title and its key, read
 * from the files given, each read by `read`.
 */
export const declarationsOf = (paths, read) => {
  const declarations = { typescript: [], csharp: [], rust: [] };

  for (const path of [...paths].sort()) {
    const side = sideOf(path);

    if (side === undefined) {
      continue;
    }
    const source = read(path).replace(/\r\n?/g, '\n');

    for (const { title, line } of READERS[side](path, source)) {
      declarations[side].push({ file: path, line, title, key: keyOf(title) });
    }
  }

  return declarations;
};

// the files git lists under a folder, tracked or not but never ignored, each one there
const listedOf = (root) => {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => {
      return path !== '' && existsSync(join(root, path));
    });
};

// ── Rows ───────────────────────────────────────────────────────────────────────

const identityOf = ({ side, file, title }) => {
  return `${side}\t${file}\t${title}`;
};

// rows in order: by side, as SIDES lists them, then by file and title, by code point
const compareRows = (a, b) => {
  const bySide = SIDES.indexOf(a.side) - SIDES.indexOf(b.side);

  if (bySide !== 0) {
    return bySide;
  }
  const byFile = a.file < b.file ? -1 : a.file > b.file ? 1 : 0;

  return byFile !== 0 ? byFile : a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
};

/**
 * A twins file read: its comment lines, kept as they are, its rows, each with its line, and the
 * problems of their shape.
 */
export const rowsOf = (text) => {
  const comments = [];
  const rows = [];
  const problems = [];
  const seen = new Set();

  for (const [index, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const at = `${TWINS}:${index + 1}`;

    if (line.startsWith('#')) {
      comments.push(line);
      continue;
    }
    if (line === '') {
      continue;
    }
    const cells = line.split('\t');

    if (cells.length !== 5) {
      problems.push(`${at}: ${cells.length} cells, not 5: side, file, title, class, reason`);
      continue;
    }
    const [side, file, title, kind, reason] = cells;
    const row = { side, file, title, kind, reason, line: index + 1 };

    if (!SIDES.includes(side)) {
      problems.push(`${at}: side \`${side}\` is none of ${SIDES.join(', ')}`);
    }
    if (!CLASSES.includes(kind)) {
      problems.push(`${at}: class \`${kind}\` is none of ${CLASSES.join(', ')}`);
    }
    if (kind !== 'pending' && (reason.trim() === '' || reason === UNREAD)) {
      problems.push(`${at}: a ${kind} row with no reason`);
    }
    if (seen.has(identityOf(row))) {
      problems.push(`${at}: a second row for \`${title}\` in ${file}`);
    }
    if (rows.length > 0 && compareRows(rows.at(-1), row) > 0) {
      problems.push(`${at}: out of order, by side, file and title: --write sorts the rows`);
    }
    seen.add(identityOf(row));
    rows.push(row);
  }

  return { comments, rows, problems };
};

// a row as its line
const lineOf = (row) => {
  return [row.side, row.file, row.title, row.kind, row.reason].join('\t');
};

/**
 * The file's text from its comments and its rows, the rows sorted.
 */
export const textOf = (comments, rows) => {
  return `${[...comments, ...[...rows].sort(compareRows).map(lineOf)].join('\n')}\n`;
};

// ── Check ──────────────────────────────────────────────────────────────────────

/**
 * The TypeScript and C# declarations with no Rust twin, one a side, file and title, each with the
 * first line it stands on.
 */
export const unmatchedOf = (declarations) => {
  const twins = new Set(
    declarations.rust.map(({ key }) => {
      return key;
    })
  );
  const unmatched = new Map();

  for (const side of SIDES) {
    for (const declaration of declarations[side]) {
      const identity = identityOf({ side, ...declaration });

      if (!twins.has(declaration.key) && !unmatched.has(identity)) {
        unmatched.set(identity, { side, ...declaration });
      }
    }
  }

  return unmatched;
};

/**
 * The problems of the rows against the declarations, and what `--write` makes of them: the rows
 * kept, a `pending` one added for each declaration with no twin and no row, a row whose
 * declaration is twinned dropped, a row whose declaration is gone kept for its reader.
 */
export const checkOf = (declarations, text) => {
  const { comments, rows, problems } = rowsOf(text);
  const unmatched = unmatchedOf(declarations);
  const declared = new Set(
    SIDES.flatMap((side) => {
      return declarations[side].map((declaration) => {
        return identityOf({ side, ...declaration });
      });
    })
  );
  const kept = [];
  const added = [];
  const dropped = [];
  const rowed = new Set();

  for (const row of rows) {
    const identity = identityOf(row);
    const at = `${TWINS}:${row.line}`;

    rowed.add(identity);
    if (unmatched.has(identity)) {
      if (row.kind === 'pending') {
        problems.push(`${at}: pending: \`${row.title}\` in ${row.file} awaits its class`);
      }
      kept.push(row);
    } else if (declared.has(identity)) {
      problems.push(
        `${at}: \`${row.title}\` in ${row.file} is twinned on the Rust side: drop the row`
      );
      dropped.push(row);
    } else {
      problems.push(`${at}: ${row.file} declares no \`${row.title}\``);
      kept.push(row);
    }
  }
  for (const [identity, { side, file, line, title }] of unmatched) {
    if (!rowed.has(identity)) {
      problems.push(
        `${file}:${line}: \`${title}\` has no Rust twin and no row in ${TWINS}: run --write, then classify it`
      );
      added.push({ side, file, title, kind: 'pending', reason: UNREAD });
    }
  }
  for (const row of added) {
    if (/[\t\n]/.test(row.title)) {
      problems.push(`${row.file}: a title with a tab or a line break, which a row cannot hold`);
    }
  }

  return {
    problems,
    rows,
    unmatched,
    written: textOf(comments, [...kept, ...added]),
    added,
    dropped,
  };
};

/**
 * The counts a run tells: the declarations of each side, those twinned, and the rows by class.
 */
export const countsOf = (declarations, rows, unmatched) => {
  const twinned = SIDES.reduce((sum, side) => {
    return sum + declarations[side].length;
  }, 0);
  const classes = Object.fromEntries(
    CLASSES.map((kind) => {
      return [
        kind,
        rows.filter((row) => {
          return row.kind === kind;
        }).length,
      ];
    })
  );
  const unmatchedCount = SIDES.reduce((sum, side) => {
    return (
      sum +
      declarations[side].filter((declaration) => {
        return unmatched.has(identityOf({ side, ...declaration }));
      }).length
    );
  }, 0);

  return {
    declarations: Object.fromEntries(
      Object.entries(declarations).map(([side, list]) => {
        return [side, list.length];
      })
    ),
    twinned: twinned - unmatchedCount,
    classes,
  };
};

/**
 * One run over a folder git lists: the declarations, the check, and with `write` the file written.
 */
export const runOf = (root, options = {}) => {
  const declarations = declarationsOf(listedOf(root), (path) => {
    return readFileSync(join(root, path), 'utf8');
  });
  const path = join(root, TWINS);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const check = checkOf(declarations, text);

  if (options.write === true) {
    const malformed = rowsOf(text).problems.filter((problem) => {
      return !problem.includes('out of order');
    });

    if (malformed.length > 0) {
      return { ...check, problems: malformed, declarations };
    }
    writeFileSync(path, check.written);

    return {
      ...checkOf(declarations, check.written),
      added: check.added,
      dropped: check.dropped,
      declarations,
    };
  }

  return { ...check, declarations };
};

if (import.meta.main) {
  const given = process.argv.slice(2);

  if (given.some((argument) => argument !== '--write')) {
    console.error('usage: node tools/check-twins.mjs [--write]');
    process.exit(2);
  }
  const write = given.includes('--write');
  const { problems, declarations, rows, unmatched, added, dropped } = runOf(ROOT, { write });
  const { declarations: sides, twinned, classes } = countsOf(declarations, rows, unmatched);

  if (write) {
    console.log(
      `${TWINS}: ${added.length} pending row(s) added, ${dropped.length} twinned row(s) dropped`
    );
  }
  for (const problem of problems) {
    console.error(problem);
  }
  console.log(
    `declarations: typescript ${sides.typescript}, csharp ${sides.csharp}, rust ${sides.rust}; ` +
      `twinned on the Rust side ${twinned}; rows: ${CLASSES.map((kind) => {
        return `${kind} ${classes[kind]}`;
      }).join(', ')}`
  );
  process.exit(problems.length > 0 ? 1 : 0);
}
