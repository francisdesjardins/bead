#!/usr/bin/env node
// Every test docs/support.md cites is one a side's tests hold, its name copied to the byte, an
// apostrophe included, `…` standing for any run of one character or more (decision 0006). The
// document is read whole, its cells and its prose, by its code spans as CommonMark reads them: each
// span shaped as a citation is held by what it is — a path, a C# class, a C# method, a Rust
// function, a sentence, or a span named in the parentheses after a cited file or class — and
// placed by what it names: a file or a folder git lists, a class or a method a C# test file
// declares, a `fn` of a Rust test file or a trial's title, a test's title (one built at run time
// filled by a literal of its file or an entry), an entry of `spec/*.json` a harness names at run
// time, a case's label, a row of the document, or a literal LITERALS lists with its reason.
//
//   node tools/check-citations.mjs             docs/support.md, with its floors
//   node tools/check-citations.mjs <file…>     those Markdown files alone, with no floor
//
// What it does not reach: a name tied to the file cited before it, so a name declared twice
// survives the drop of one; a span of no citation's shape outside the parentheses after a file, a
// one-word title among them; a one-word name inside them that stays a literal of some test file.
//
// Exit 1 on a held span placed by nothing, with its file, its line and its row; on a literal
// LITERALS lists that no span of docs/support.md holds; and, on the default run, on a kind whose
// citations placed fall under its floor in FLOORS.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SUPPORT = 'docs/support.md';

// U+2026, which stands in a span for any run of one character or more
const ELLIPSIS = '…';

const KIND = Object.freeze({
  path: 'path',
  class: 'C# class',
  method: 'C# method',
  function: 'Rust function',
  sentence: 'sentence',
  named: 'named in parentheses',
});

// what each kind looks for, as a failure says it
const SOUGHT = Object.freeze({
  [KIND.path]: 'file or folder git lists',
  [KIND.class]: 'class a C# test file declares',
  [KIND.method]: 'method a C# test file declares',
  [KIND.function]: "fn of a Rust test file nor a trial's title",
  [KIND.sentence]: "test's title, entry of spec/*.json, case's label or row of the matrix",
  [KIND.named]: "test's title, entry of spec/*.json, case's label or row of the matrix",
});

/**
 * The spans no test declares that the matrix cites all the same, each with its reason: placed by
 * nothing else, each must stand in a span of docs/support.md.
 */
export const LITERALS = Object.freeze({
  'from-binary.js': "protobuf-es's own reader, which no clone keeps",
  session_max_per_connection: "RabbitMQ's setting, by its name",
  max_header_list_size:
    "HTTP/2's SETTINGS_MAX_HEADER_LIST_SIZE (RFC 9113 §6.5.2), as the h2 crate names it",
  'unsafe impl': "Rust's syntax, which unsafe_code forbids",
  'a redirect': "the end of a page's connect failure, which cors-page.test.ts asserts whole",
});

/**
 * The citations docs/support.md must place of each kind, about half of what it held when the gate
 * landed, rounded down to the hundred: a reading that finds nothing fails.
 */
export const FLOORS = Object.freeze({
  paths: 500,
  titles: 600,
  'C#': 400,
  Rust: 200,
});

// the group of the floors and of the count each kind is counted in
const GROUP = Object.freeze({
  [KIND.path]: 'paths',
  [KIND.sentence]: 'titles',
  [KIND.named]: 'titles',
  [KIND.class]: 'C#',
  [KIND.method]: 'C#',
  [KIND.function]: 'Rust',
});

// ── Spans ──────────────────────────────────────────────────────────────────────

// a character blanked, but a line break, so an offset keeps its line
const blank = (match) => {
  return match.replace(/[^\n]/g, ' ');
};

// the text with every fenced code block blanked, as tools/check-links.mjs blanks it
const blankBlocks = (text) => {
  return text.replace(
    /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm,
    blank
  );
};

// whether the line around an offset is a table's row, where a span ends with its line
const isRow = (text, at) => {
  const start = text.lastIndexOf('\n', at - 1) + 1;

  return /^ {0,3}\|/.test(text.slice(start, start + 4));
};

// the first cell of a table's row, its escaped bars read, or nothing outside a row
const rowOf = (line) => {
  const cell = line.match(/^ {0,3}\|((?:\\.|[^|\\])*)\|/);

  return cell === null ? undefined : cell[1].trim().replace(/\\\|/g, '|');
};

// a span's content as CommonMark 0.31.2 §6.1 reads it: a line ending and the indentation after it
// one space, one space stripped at each end when both are there and it is not all spaces; in a
// table's row, `\|` a bar (GFM 0.29 §4.10)
const contentOf = (raw, row) => {
  const joined = raw.replace(/\n[ \t]*/g, ' ');
  const stripped =
    /^ [\s\S]* $/.test(joined) && joined.trim() !== '' ? joined.slice(1, -1) : joined;

  return row ? stripped.replace(/\\\|/g, '|') : stripped;
};

// each code span with its offsets: a backtick string opens one and the next of the same length
// closes it, within its paragraph, or its line in a table's row; one closed by nothing is text
const rawSpansOf = (text) => {
  const spans = [];
  let at = 0;

  while (at < text.length) {
    if (text[at] === '\\') {
      at += 2;
      continue;
    }
    if (text[at] !== '`') {
      at += 1;
      continue;
    }
    let start = at;

    while (text[start] === '`') {
      start += 1;
    }
    const length = start - at;
    const row = isRow(text, at);
    const ending = row ? /\n/g : /\n[ \t]*\n/g;

    ending.lastIndex = start;
    const limit = ending.exec(text)?.index ?? text.length;
    const runs = /`+/g;
    let closing;

    runs.lastIndex = start;
    for (let run = runs.exec(text); run !== null && run.index < limit; run = runs.exec(text)) {
      if (run[0].length === length) {
        closing = run.index;
        break;
      }
    }
    if (closing === undefined) {
      at = start;
      continue;
    }
    spans.push({ raw: text.slice(start, closing), at, end: closing + length, row });
    at = closing + length;
  }

  return spans;
};

// the end of the parentheses opened right after a span: their close, or the end of their line or
// cell, code spans skipped; or nothing where no parenthesis opens there
const parenthesesAfter = (text, span, ends) => {
  const open = text.slice(span.end, span.end + 2).match(/^ ?\(/);

  if (open === null) {
    return undefined;
  }
  let depth = 0;

  for (let at = span.end + open[0].length - 1; at < text.length; at += 1) {
    if (ends.has(at)) {
      at = ends.get(at) - 1;
      continue;
    }
    const character = text[at];

    if (character === '\\') {
      at += 1;
      continue;
    }
    if (character === '\n' || character === '|') {
      return at;
    }
    if (character === '(') {
      depth += 1;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }

  return text.length;
};

/**
 * Each code span of a Markdown text, `{ text, line, row, inParentheses }`: its content as
 * CommonMark reads it, its line, its row's title when it stands in a table's row, and whether it
 * stands in the parentheses opened right after a path or a C# class.
 */
export const spansOf = (text) => {
  const normalized = blankBlocks(text.replace(/\r\n?/g, '\n'));
  const lines = normalized.split('\n');
  const raw = rawSpansOf(normalized);
  const ends = new Map(
    raw.map((span) => {
      return [span.at, span.end];
    })
  );
  let line = 1;
  let counted = 0;
  const read = raw.map((span) => {
    for (; counted < span.at; counted += 1) {
      line += normalized[counted] === '\n' ? 1 : 0;
    }

    return {
      ...span,
      text: contentOf(span.raw, span.row),
      line,
      row: span.row ? rowOf(lines[line - 1]) : undefined,
    };
  });
  const inside = new Set();

  for (const span of read) {
    const shape = shapeOf(span.text);

    if (shape !== KIND.path && shape !== KIND.class) {
      continue;
    }
    const close = parenthesesAfter(normalized, span, ends);

    if (close === undefined) {
      continue;
    }
    for (const other of read) {
      if (other.at > span.end && other.at < close) {
        inside.add(other);
      }
    }
  }

  return read.map((span) => {
    return { text: span.text, line: span.line, row: span.row, inParentheses: inside.has(span) };
  });
};

// ── Shapes ─────────────────────────────────────────────────────────────────────

const EXTENSIONS =
  /\.(?:ts|mts|mjs|js|tsx|cs|rs|json|md|yml|yaml|toml|proto|py|sh|ps1|tsv|txt|props|csproj|slnx|html)$/;

const PROGRAMS = /^(?:node|yarn|dotnet|cargo|pwsh|npx|docker|git|bash|sh|python|buf)(?:\s|$)/;

// what no citation is: bytes, a setting or a header, a command line, a comment, a unit's number as
// spec/check.py's NAMING writes one, a form with a placeholder
const isLeftOut = (span) => {
  return (
    /^(?:[0-9A-F]{2} )+[0-9A-F]{2}$/.test(span) ||
    /^[\w.-]+(?:\s*:\s|\s*=\s?)/.test(span) ||
    (!span.includes(',') && (PROGRAMS.test(span) || /^tools\/\S+ |^-/.test(span))) ||
    span.startsWith('//') ||
    /^(?:spec|debugging|transcoding) \d/.test(span) ||
    (!span.includes(',') && /<[a-z-]+>/.test(span))
  );
};

/**
 * The kind of citation a span is, tried in order, or nothing when it is none: left out first what
 * no citation is, then a path, a C# class, a C# method, a Rust function, a sentence; a span of none
 * of these shapes in the parentheses after a file or a class is named in them.
 */
export const shapeOf = (span, options = {}) => {
  if (isLeftOut(span)) {
    return undefined;
  }
  if (/^[^\s<>*:]+$/.test(span) && /^[\w…]/.test(span) && EXTENSIONS.test(span)) {
    return KIND.path;
  }
  if (/^[\w.-]+(?:\/[\w.-]+)*\/$/.test(span) && span.includes('-')) {
    return KIND.path;
  }
  if (/^Bead(?:\.\w+)+\/\w+$/.test(span) || /^[A-Z]\w*Tests$/.test(span)) {
    return KIND.class;
  }
  // ! a protocol's code in capitals, `PAYLOAD_INVALID`, is no method: a capital, then lower case
  if (/^(?:(?:Bead(?:\.\w+)+\/)?[A-Z]\w*\.)?[A-Z](?:[a-z0-9µ][\wµ…]*)?_[\wµ…]+$/u.test(span)) {
    return KIND.method;
  }
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9…]+){3,}$/.test(span)) {
    return KIND.function;
  }
  if (/\s/.test(span)) {
    return KIND.sentence;
  }

  return options.inParentheses === true ? KIND.named : undefined;
};

// ── Pools ──────────────────────────────────────────────────────────────────────

// a string literal's escapes read, as JavaScript, C# and Rust write the common ones
const unescape = (raw) => {
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\n\s*|(.))/gs,
    (escape, braced, four, two, other) => {
      const code = braced ?? four ?? two;

      if (code !== undefined) {
        return String.fromCodePoint(Number.parseInt(code, 16));
      }
      if (other === undefined) {
        return '';
      }

      return { n: '\n', r: '\r', t: '\t', 0: '\0' }[other] ?? other;
    }
  );
};

// the JavaScript string at an offset: its literal parts, a template's split at each `${…}`
const stringAt = (source, at) => {
  const quote = source[at];

  if (!`'"\``.includes(quote)) {
    return undefined;
  }
  const parts = [];
  let value = '';
  let index = at + 1;

  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') {
      value += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (quote === '`' && source.startsWith('${', index)) {
      let depth = 1;

      index += 2;
      while (index < source.length && depth > 0) {
        depth += source[index] === '{' ? 1 : source[index] === '}' ? -1 : 0;
        index += 1;
      }
      parts.push(unescape(value));
      value = '';
      continue;
    }
    if (quote !== '`' && source[index] === '\n') {
      return undefined;
    }
    value += source[index];
    index += 1;
  }
  parts.push(unescape(value));

  return parts;
};

const isScriptTest = (path) => {
  return /\.test\.(?:ts|mjs)$/.test(path);
};

const isCSharpTest = (path) => {
  return path.startsWith('implementations/dotnet/tests/') && path.endsWith('.cs');
};

// spec/check.py's rust_tests: a module's tests beside it, tests.rs; each file of a tests/ folder;
// and the test kit, testing.rs and testing/
const isRustTest = (path) => {
  const parts = path.split('/');
  const name = parts.at(-1);

  return (
    name.endsWith('.rs') &&
    (name === 'tests.rs' ||
      name === 'testing.rs' ||
      parts.slice(0, -1).includes('tests') ||
      parts.slice(0, -1).includes('testing'))
  );
};

// a TypeScript test's titles and templates: the first argument of each `test`, `it` or `describe`,
// members between (`test.describe.serial(`), a string or a template
const scriptTitlesOf = (source) => {
  const titles = [];

  for (const call of source.matchAll(/\b(?:test|it|describe)(?:\.\w+)*\(\s*/g)) {
    const parts = stringAt(source, call.index + call[0].length);

    if (parts !== undefined) {
      titles.push(parts);
    }
  }

  return titles;
};

// the whole string literals of a test file, by its language: a theory's data, a case's label
const literalsOf = (path, source) => {
  const pattern = path.endsWith('.rs')
    ? /'(?:\\.|[^'\\\n])'|"((?:\\.|[^"\\])*)"/g
    : path.endsWith('.cs')
      ? /"((?:\\.|[^"\\\n])*)"/g
      : /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g;
  const literals = [];

  for (const found of source.matchAll(pattern)) {
    const raw = found[1] ?? found[2];

    if (raw !== undefined) {
      literals.push(unescape(raw));
    }
  }

  return literals;
};

// a C# test file's classes and its methods returning void, Task or ValueTask, each with its class
const cSharpDeclarationsOf = (source) => {
  const classes = [];
  const methods = [];
  let owner;

  for (const line of source.split('\n')) {
    if (/^\s*\/\//.test(line)) {
      continue;
    }
    const type = line.match(/\b(?:(?:record\s+)?(?:class|struct)|record)\s+([\p{L}\p{N}_]+)/u);

    if (type !== null) {
      owner = type[1];
      classes.push(owner);
    }
    const method = line.match(
      /^\s*(?:(?:public|private|internal|protected|static|async|override|virtual|new)\s+)*(?:void|Task|ValueTask)\s+([\p{L}\p{N}_]+)\s*[(<]/u
    );

    if (method !== null) {
      methods.push({ name: method[1], owner });
    }
  }

  return { classes, methods };
};

// a Rust test file's functions, and its trials' titles: `Trial::test(`'s first argument, a string
// or a `format!`'s, each `{…}` a hole
const rustDeclarationsOf = (source) => {
  const functions = [
    ...source.matchAll(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/gm
    ),
  ].map((found) => {
    return found[1];
  });
  const trials = [...source.matchAll(/Trial::test\(\s*(?:format!\(\s*)?"((?:\\.|[^"\\])*)"/g)].map(
    (found) => {
      return unescape(found[1]).split(/\{[^{}]*\}/);
    }
  );

  return { functions, trials };
};

// every `name` and `id` string member of a conformance file, at any depth
const entriesOf = (value) => {
  if (Array.isArray(value)) {
    return value.flatMap(entriesOf);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, member]) => {
    const own = (key === 'name' || key === 'id') && typeof member === 'string' ? [member] : [];

    return [...own, ...entriesOf(member)];
  });
};

const add = (map, key, value) => {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
};

/**
 * What the citations are placed in, read from the files git lists under `root`: its files and
 * folders, the TypeScript tests' titles and templates, the Rust trials' titles and templates, each
 * test file's whole literals, the C# tests' classes and methods, the Rust tests' functions and the
 * entries of `spec/*.json`.
 */
export const poolsOf = (root) => {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((path) => {
      return path !== '' && existsSync(join(root, path));
    });
  const read = (path) => {
    return readFileSync(join(root, path), 'utf8').replace(/\r\n?/g, '\n');
  };
  const pools = {
    paths: new Set(),
    titles: new Set(),
    trials: new Set(),
    templates: [],
    literals: new Map(),
    cases: new Set(),
    classes: new Map(),
    methods: new Map(),
    functions: new Set(),
    entries: new Set(),
  };

  for (const path of listed) {
    const parts = path.split('/');

    for (let index = 1; index <= parts.length; index += 1) {
      pools.paths.add(parts.slice(0, index).join('/'));
    }
  }
  for (const path of listed) {
    const tested = [isScriptTest, isCSharpTest, isRustTest].some((is) => {
      return is(path);
    });

    if (tested) {
      const source = read(path);
      const literals = literalsOf(path, source);

      pools.literals.set(path, new Set(literals));
      for (const literal of literals) {
        pools.cases.add(literal);
      }
      if (isScriptTest(path)) {
        for (const parts of scriptTitlesOf(source)) {
          if (parts.length === 1) {
            pools.titles.add(parts[0]);
          } else {
            pools.templates.push({ parts, file: path });
          }
        }
      } else if (isCSharpTest(path)) {
        const { classes, methods } = cSharpDeclarationsOf(source);

        for (const name of classes) {
          add(pools.classes, name, path);
        }
        for (const { name, owner } of methods) {
          add(pools.methods, name, { file: path, owner });
        }
      } else {
        const { functions, trials } = rustDeclarationsOf(source);

        for (const name of functions) {
          pools.functions.add(name);
        }
        for (const parts of trials) {
          if (parts.length === 1) {
            pools.trials.add(parts[0]);
          } else {
            pools.templates.push({ parts, file: path });
          }
        }
      }
    }
    if (/^spec\/[^/]+\.json$/.test(path)) {
      for (const entry of entriesOf(JSON.parse(read(path)))) {
        pools.entries.add(entry);
      }
    }
  }

  return pools;
};

// ── Placing ────────────────────────────────────────────────────────────────────

const escape = (text) => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// a span as a pattern: each `…` any run of one character or more, the bytes around it exactly
const patternOf = (span, options = {}) => {
  const body = span.split(ELLIPSIS).map(escape).join('.+');

  return new RegExp(`${options.suffix === true ? '(?:^|/)' : '^'}${body}$`, 'su');
};

// whether a pool holds the span, `…` read as any run
const holds = (pool, span) => {
  if (!span.includes(ELLIPSIS)) {
    return pool.has(span);
  }
  const pattern = patternOf(span);

  for (const member of pool) {
    if (pattern.test(member)) {
      return true;
    }
  }

  return false;
};

// whether a title built at run time is the span: its literal parts in order, each hole a whole
// literal of the template's own file, an entry's name or id, or `…`; or a span cut by `…` that
// matches the template's form, its holes written `…`
const fills = (span, template, pools) => {
  const { parts, file } = template;

  if (span.includes(ELLIPSIS) && patternOf(span).test(parts.join(ELLIPSIS))) {
    return true;
  }
  const own = pools.literals.get(file) ?? new Set();
  const isHole = (value) => {
    return value === ELLIPSIS || pools.entries.has(value) || own.has(value);
  };
  const from = (at, index) => {
    if (!span.startsWith(parts[index], at)) {
      return false;
    }
    const after = at + parts[index].length;

    if (index === parts.length - 1) {
      return after === span.length;
    }
    for (let end = after + 1; end <= span.length; end += 1) {
      if (isHole(span.slice(after, end)) && from(end, index + 1)) {
        return true;
      }
    }

    return false;
  };

  return from(0, 0);
};

const placesPath = (span, pools) => {
  const path = (span.startsWith(`${ELLIPSIS}/`) ? span.slice(2) : span).replace(/\/$/, '');
  const pattern = patternOf(path, { suffix: true });

  if (pools.paths.has(path)) {
    return true;
  }
  for (const member of pools.paths) {
    if (pattern.test(member)) {
      return true;
    }
  }

  return false;
};

// the files of the class a span names, under its project's folder when it names one
const filesOfClass = (name, project, pools) => {
  return (pools.classes.get(name) ?? []).filter((file) => {
    return project === undefined || file.startsWith(`implementations/dotnet/tests/${project}/`);
  });
};

const placesClass = (span, pools) => {
  const [project, name] = span.includes('/') ? span.split('/') : [undefined, span];

  return filesOfClass(name, project, pools).length > 0;
};

const placesMethod = (span, pools) => {
  const project = span.match(/^(Bead(?:\.\w+)+)\//)?.[1];
  const qualified = project === undefined ? span : span.slice(project.length + 1);
  const dot = qualified.indexOf('.');
  const owner = dot === -1 ? undefined : qualified.slice(0, dot);
  const method = dot === -1 ? qualified : qualified.slice(dot + 1);
  const files = owner === undefined ? undefined : filesOfClass(owner, project, pools);

  if (files !== undefined && files.length === 0) {
    return false;
  }
  const pattern = patternOf(method);

  for (const [name, declarations] of pools.methods) {
    if (!pattern.test(name)) {
      continue;
    }
    const declared = declarations.some((declaration) => {
      return files === undefined || declaration.owner === owner || files.includes(declaration.file);
    });

    if (declared) {
      return true;
    }
  }

  return false;
};

const placesFunction = (span, pools) => {
  return holds(pools.functions, span) || holds(pools.trials, span);
};

const placesSentence = (span, pools, rows) => {
  return (
    holds(pools.titles, span) ||
    holds(pools.trials, span) ||
    pools.templates.some((template) => {
      return fills(span, template, pools);
    }) ||
    holds(pools.entries, span) ||
    holds(rows, span) ||
    holds(pools.cases, span)
  );
};

const placesOf = (kind, span, pools, rows) => {
  switch (kind) {
    case KIND.path:
      return placesPath(span, pools);
    case KIND.class:
      return placesClass(span, pools);
    case KIND.method:
      return placesMethod(span, pools);
    case KIND.function:
      return placesFunction(span, pools);
    case KIND.sentence:
      return placesSentence(span, pools, rows);
    default:
      return (
        placesSentence(span, pools, rows) ||
        placesPath(span, pools) ||
        placesMethod(span, pools) ||
        placesClass(span, pools) ||
        placesFunction(span, pools)
      );
  }
};

// the title of each table row of a text: the rows a sentence may name
const rowsOf = (text) => {
  return new Set(
    blankBlocks(text.replace(/\r\n?/g, '\n'))
      .split('\n')
      .filter((line) => {
        return !/^ {0,3}\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
      })
      .map(rowOf)
      .filter((row) => {
        return row !== undefined;
      })
  );
};

// each span of a text held as a citation: its kind, and whether it is placed, or listed
const citationsOf = (text, pools) => {
  const rows = rowsOf(text);

  return spansOf(text).flatMap((span) => {
    const kind = shapeOf(span.text, { inParentheses: span.inParentheses });

    if (kind === undefined) {
      return [];
    }
    const placed = placesOf(kind, span.text, pools, rows);
    const listed = !placed && Object.hasOwn(LITERALS, span.text);

    return [{ ...span, kind, placed, listed }];
  });
};

/** What a text's citations count, `{ paths, titles, 'C#', Rust, listed }`, each kind placed. */
const countsOf = (citations) => {
  const counts = { paths: 0, titles: 0, 'C#': 0, Rust: 0, listed: 0 };

  for (const citation of citations) {
    if (citation.placed) {
      counts[GROUP[citation.kind]] += 1;
    } else if (citation.listed) {
      counts.listed += 1;
    }
  }

  return counts;
};

// ── Check ──────────────────────────────────────────────────────────────────────

/**
 * Why the citations of a Markdown text fail against the pools, one line each, or nothing: each held
 * span placed by nothing; and, unless `options.file` names the text, docs/support.md being read,
 * each literal LITERALS lists that no span holds and each kind placed under its floor.
 */
export const problemsOf = (text, pools, options = {}) => {
  const file = options.file ?? SUPPORT;
  const citations = citationsOf(text, pools);
  const problems = citations
    .filter((citation) => {
      return !citation.placed && !citation.listed;
    })
    .map((citation) => {
      const row = citation.row === undefined ? '' : `, in the row ${citation.row}`;

      return `${file}:${citation.line}: \`${citation.text}\` (${citation.kind}) is no ${SOUGHT[citation.kind]}${row}`;
    });

  if (options.file !== undefined) {
    return problems;
  }
  const cited = new Set(
    citations.map((citation) => {
      return citation.text;
    })
  );

  for (const literal of Object.keys(LITERALS)) {
    if (!cited.has(literal)) {
      problems.push(
        `tools/check-citations.mjs: LITERALS holds ${literal}, which ${SUPPORT} no longer cites`
      );
    }
  }
  const counts = countsOf(citations);

  for (const [kind, floor] of Object.entries(FLOORS)) {
    if (counts[kind] < floor) {
      problems.push(`${SUPPORT}: placed ${counts[kind]} ${kind}, under its floor of ${floor}`);
    }
  }

  return problems;
};

if (import.meta.main) {
  const given = process.argv.slice(2);
  const documents = given.length > 0 ? given : [join(ROOT, SUPPORT)];
  const pools = poolsOf(ROOT);
  const problems = [];
  const counts = { paths: 0, titles: 0, 'C#': 0, Rust: 0, listed: 0 };

  for (const document of documents) {
    const text = readFileSync(document, 'utf8');

    problems.push(...problemsOf(text, pools, given.length > 0 ? { file: document } : {}));
    for (const [kind, count] of Object.entries(countsOf(citationsOf(text, pools)))) {
      counts[kind] += count;
    }
  }
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  const total = Object.values(counts).reduce((sum, count) => {
    return sum + count;
  }, 0);

  console.log(
    `${total} citations placed: ${counts.paths} paths, ${counts.titles} titles, ${counts['C#']} C#, ${counts.Rust} Rust, ${counts.listed} listed`
  );
}
