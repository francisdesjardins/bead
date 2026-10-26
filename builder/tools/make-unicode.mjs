#!/usr/bin/env node
// ── beadc's Unicode tables ────────────────────────────────────────────────────
// Writes `src/patterns/unicode.ts`, the tables a pattern's classes and its case folding are read
// from (spec 18.8.5, decision 0035): never the platform's, whose `RegExp` and case mapping move with
// each Node. Read from Unicode's own files, the Unicode Character Database of the version that
// `../spec/generators/ucd.json` pins, each held to its sha256 before a line of it is read: the one
// pin the spec's generator reads too, so the verdicts of `spec/validations.json` and beadc's tables
// come from the same bytes. The files are fetched once into `<tmpdir>/bead-ucd/<version>/`, the
// spec's generator's cache, and never committed; the tables are.
//
// - `UnicodeData.txt`: each code point's general category, its `First>` and `Last>` lines a range;
// - `Scripts.txt`: each script's code points, by the long names RE2 takes;
// - `PropertyValueAliases.txt`: the categories each one-letter category groups, and each script's
//   name, held to Scripts.txt's;
// - `CaseFolding.txt`: simple case folding, its statuses C and S, as orbits of code points.
//
// RE2's names, as its syntax states them: the categories of one and two letters, `Cn` and `LC`
// left out, as RE2 refuses them, and `C` grouping the assigned others (Cc, Cf, Co, Cs), as RE2's own
// tables do; the scripts by their long names. A version moves by a regeneration and a CHANGELOG
// line, never by a platform. The file is laid out by the builder's oxfmt, as it would lay it out.
//
// Usage, from builder/:
//   node tools/make-unicode.mjs           # write src/patterns/unicode.ts
//   node tools/make-unicode.mjs --check   # exit 1 when the committed file is not what this writes

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILDER = fileURLToPath(new URL('../', import.meta.url));
const PIN = join(BUILDER, '..', 'spec', 'generators', 'ucd.json');
const OUTPUT = join(BUILDER, 'src', 'patterns', 'unicode.ts');
const OXFMT = join(BUILDER, 'node_modules', 'oxfmt', 'bin', 'oxfmt');

const CHECK = process.argv.includes('--check');

// the categories RE2 refuses by name: unassigned code points appear in no file, and a cased letter
// is no category of RE2's
const REFUSED_CATEGORIES = new Set(['Cn', 'LC']);

const ucd = JSON.parse(readFileSync(PIN, 'utf8'));

/** A file of the UCD as `ucd.json` pins it, from the cache, fetched there once; its sha256 held. */
async function ucdText(name) {
  const pinned = ucd.files.find((file) => file.name === name);

  if (pinned === undefined) throw new Error(`make-unicode: ${name} is not pinned by ${PIN}`);

  const cache = join(tmpdir(), 'bead-ucd', ucd.version);
  const path = join(cache, name);

  if (!existsSync(path)) {
    const response = await fetch(pinned.url);

    if (!response.ok) throw new Error(`make-unicode: ${pinned.url} answered ${response.status}`);

    const data = Buffer.from(await response.arrayBuffer());

    if (sha256(data) !== pinned.sha256) {
      throw new Error(`make-unicode: ${pinned.url}: its sha256 is not the one ${PIN} pins`);
    }

    mkdirSync(cache, { recursive: true });
    writeFileSync(`${path}.part`, data);
    renameSync(`${path}.part`, path);
  }

  const data = readFileSync(path);

  if (sha256(data) !== pinned.sha256) {
    throw new Error(`make-unicode: ${path}: its sha256 is not the one ${PIN} pins; delete it`);
  }

  return data.toString('utf8');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Code points as sorted, merged ranges, `[low, high]` each. */
function rangesOf(points) {
  const sorted = [...points].sort((a, b) => a - b);
  const ranges = [];

  for (const point of sorted) {
    const last = ranges.at(-1);

    if (last !== undefined && last[1] + 1 === point) {
      last[1] = point;
    } else if (last === undefined || last[1] < point) {
      ranges.push([point, point]);
    }
  }

  return ranges;
}

/** Ranges as the tables write them: lower-case hexadecimal, `low-high` or `point`, by spaces. */
function written(ranges) {
  return ranges
    .map(([low, high]) =>
      low === high ? low.toString(16) : `${low.toString(16)}-${high.toString(16)}`
    )
    .join(' ');
}

/** The UCD's semicolon-separated fields of each line that holds data, its comment set apart. */
function linesOf(text) {
  return text
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#');
      const data = hash < 0 ? line : line.slice(0, hash);

      return {
        comment: hash < 0 ? '' : line.slice(hash + 1),
        fields: data.split(';').map((f) => f.trim()),
      };
    })
    .filter((line) => line.fields[0] !== '');
}

function categoriesOf(text) {
  const categories = new Map();
  let first;

  for (const line of text.split('\n')) {
    if (line === '') continue;

    const fields = line.split(';');
    const point = Number.parseInt(fields[0], 16);
    const name = fields[1];
    const category = fields[2];

    if (name.endsWith(', First>')) {
      first = point;
      continue;
    }

    const low = name.endsWith(', Last>') ? first : point;

    first = undefined;

    if (!categories.has(category)) categories.set(category, []);

    for (let each = low; each <= point; each++) categories.get(category).push(each);
  }

  return categories;
}

function scriptsOf(text) {
  const scripts = new Map();

  for (const { fields } of linesOf(text)) {
    const [low, high = low] = fields[0].split('..').map((hex) => Number.parseInt(hex, 16));
    const name = fields[1];

    if (!scripts.has(name)) scripts.set(name, []);

    for (let each = low; each <= high; each++) scripts.get(name).push(each);
  }

  return scripts;
}

/** The one-letter categories and the two-letter ones each groups, and each script's long name. */
function aliasesOf(text) {
  const groups = new Map();
  const scripts = new Set();

  for (const { comment, fields } of linesOf(text)) {
    if (fields[0] === 'gc' && fields[1].length === 1) {
      groups.set(
        fields[1],
        comment
          .split('|')
          .map((name) => name.trim())
          .filter((name) => !REFUSED_CATEGORIES.has(name))
      );
    } else if (fields[0] === 'sc') {
      scripts.add(fields[2]);
    }
  }

  return { groups, scripts };
}

/** Simple case folding's orbits: each set of code points folding to one, statuses C and S. */
function orbitsOf(text) {
  const orbits = new Map();

  for (const { fields } of linesOf(text)) {
    if (fields[1] !== 'C' && fields[1] !== 'S') continue;

    const point = Number.parseInt(fields[0], 16);
    const target = Number.parseInt(fields[2], 16);

    if (!orbits.has(target)) orbits.set(target, new Set([target]));

    orbits.get(target).add(point);
  }

  return [...orbits.values()]
    .map((orbit) => [...orbit].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function entries(map) {
  return [...map]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `  ${name}: ${value},`)
    .join('\n');
}

async function tables() {
  const categories = categoriesOf(await ucdText('UnicodeData.txt'));
  const scripts = scriptsOf(await ucdText('Scripts.txt'));
  const aliases = aliasesOf(await ucdText('PropertyValueAliases.txt'));
  const orbits = orbitsOf(await ucdText('CaseFolding.txt'));

  for (const name of scripts.keys()) {
    if (!aliases.scripts.has(name)) {
      throw new Error(`make-unicode: Scripts.txt names ${name}, which is no script's long name`);
    }
  }

  for (const [group, members] of aliases.groups) {
    for (const member of members) {
      if (!categories.has(member) && member !== 'Cs' && member !== 'Co') {
        throw new Error(
          `make-unicode: ${group} groups ${member}, which UnicodeData.txt never names`
        );
      }
    }
  }

  const pins = ucd.files
    .map((file) => `  Object.freeze({ name: '${file.name}', sha256: '${file.sha256}' }),`)
    .join('\n');
  const categoryRanges = new Map(
    [...categories].map(([name, points]) => [name, `'${written(rangesOf(points))}'`])
  );
  const groups = new Map(
    [...aliases.groups].map(([name, members]) => [
      name,
      `Object.freeze([${[...members]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((member) => `'${member}'`)
        .join(', ')}])`,
    ])
  );
  const scriptRanges = new Map(
    [...scripts].map(([name, points]) => [name, `'${written(rangesOf(points))}'`])
  );
  const folds = orbits.map((orbit) => orbit.map((point) => point.toString(16)).join(' ')).join(',');

  return `// ── Unicode's tables ──────────────────────────────────────────────────────────

// ! Written by \`tools/make-unicode.mjs\` from Unicode ${ucd.version}'s own files, which
// \`spec/generators/ucd.json\` pins by their sha256: edit the generator, never this file. A pattern's
// classes and its case folding are read from these tables alone, never from the platform's (spec
// 18.8.5, decision 0035). Each table writes its code points as ranges in lower-case hexadecimal,
// \`low-high\` or one point, separated by spaces.

/** The version of Unicode the tables are of. */
export const UNICODE_VERSION = '${ucd.version}';

/** The files of the UCD the tables are read from, each by its sha256. */
export const UNICODE_FILES = Object.freeze([
${pins}
]);

/** Each general category of two letters, from \`UnicodeData.txt\`. */
export const CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
${entries(categoryRanges)}
});

/**
 * Each general category of one letter, by the categories of two it groups, from
 * \`PropertyValueAliases.txt\`; \`Cn\`, which RE2 refuses, grouped by none.
 */
export const CATEGORY_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
${entries(groups)}
});

/** Each script, by its long name, from \`Scripts.txt\`. */
export const SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
${entries(scriptRanges)}
});

/**
 * Simple case folding's orbits, from \`CaseFolding.txt\`'s statuses C and S: each orbit its code
 * points ascending, in hexadecimal and separated by spaces, the orbits separated by commas.
 */
export const CASE_ORBITS =
  '${folds}';
`;
}

/** `text` as the builder's oxfmt lays out the file, under the builder's configuration. */
function formatted(text) {
  return execFileSync(process.execPath, [OXFMT, '--stdin-filepath=src/patterns/unicode.ts'], {
    cwd: BUILDER,
    encoding: 'utf8',
    input: text,
  });
}

const text = formatted(await tables());

if (CHECK) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';

  if (committed !== text) {
    console.error('make-unicode: src/patterns/unicode.ts differs from what it writes; run it');
    process.exit(1);
  }

  console.log(`make-unicode: src/patterns/unicode.ts is Unicode ${ucd.version}'s, as it writes it`);
} else {
  mkdirSync(join(BUILDER, 'src', 'patterns'), { recursive: true });
  writeFileSync(OUTPUT, text);
  console.log(`make-unicode: wrote src/patterns/unicode.ts from Unicode ${ucd.version}`);
}
