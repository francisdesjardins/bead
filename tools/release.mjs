#!/usr/bin/env node
// A release's versions, moved in its release commit, and its documents' tags, set after its finish
// (decision 0008). It stages, commits and pushes nothing, and tags nothing but the documents.
//
//   node tools/release.mjs prepare [<version>] [--spec <move>] [--debugging <move>]
//                                  [--transcoding <move>] [--date YYYY-MM-DD] [--python <path>]
//                                  [--dry-run]
//   node tools/release.mjs tag [<version>]
//
// `prepare`, on a release/* or hotfix/* branch, the product's <version> defaulting to the branch's:
// moves the TypeScript package's version and the builder's where the tree has one, the C# side's
// <Version> and the project ranges of its lock files and of an example's, each document's line and
// every conformance file's repeat of it, the two versions beadc's header names in each file it
// generated, the image each committed wrapper of beadc's names and the spec's version in each
// blueprint beadc wrote outside spec/, every text changed before any is written; runs the
// generators; dates [Unreleased] as the version, under a new empty one, and links it; then runs the
// gate as a release, spec/check.py and the root's format check, naming one whose tool is absent;
// on a hotfix, which starts from main, takes every waiver out of CI's `beadc breaking` step, each
// moot since the release main holds; and lists what it owes by hand: the CHANGELOG's line on a
// document's new tag, each of decision 0006's gates owed that names the release, the documents
// brought to it, and both benches' reports, compared with the last release's.
// A <move> is x.y.z, patch, minor, major or same, from the document's last release. Run again, it
// re-dates, regenerates and checks. `tag`, after the finish, <version> defaulting to the newest v*:
// tags spec-v…, debugging-v… and transcoding-v… at the commit v<version> tags, for each document whose version no
// tag names yet; runs the gate as main's run will, then over the branch checked out; takes out of
// CI's `beadc breaking` step on the branch checked out, develop at its back-merge, each waiver the
// tagged commit carries, which the release makes moot, and prints the commit that keeps it; and
// prints the one push. Exit 1 on a refusal; exit 2 on a usage error.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  BUILDER,
  CHANGELOG,
  DOCUMENTS,
  LOCKS,
  MODES,
  PACKAGE,
  PROPS,
  STATED,
  checkVersions,
  gatherReleases,
  git,
  isDay,
  newest,
  parseVersion,
  readChangelog,
  readText,
  readVersions,
  successorsOf,
} from './check-versions.mjs';

// the root's formatter, from the TypeScript side's install, which the root's format check runs
const OXFMT = 'implementations/typescript/node_modules/oxfmt/bin/oxfmt';

// ── Texts ─────────────────────────────────────────────────────────────────────

// ! each write replaces one version in its text and nothing else, so a file keeps its format and
// its diff stays one line; a pattern that does not match exactly once is refused, never guessed at
const replaceOnce = (text, { pattern, replacement }) => {
  const found = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  if (found.length !== 1) {
    throw new Error(`${found.length} matches of ${pattern}, where one is due`);
  }
  return text.replace(pattern, replacement);
};

// the package's own version: the top-level key, found by its indentation
export const withPackageVersion = (text, version) => {
  return replaceOnce(text, {
    pattern: /^ {2}"version": "[^"]*"/m,
    replacement: `  "version": "${version}"`,
  });
};

export const withPropsVersion = (text, version) => {
  return replaceOnce(text, {
    pattern: /<Version>[^<]*<\/Version>/,
    replacement: `<Version>${version}</Version>`,
  });
};

// the line a document states its version on, which its generators read
export const withStatedVersion = (text, version) => {
  return replaceOnce(text, {
    pattern: /^\*\*Version: \d+\.\d+\.\d+\*\*/m,
    replacement: `**Version: ${version}**`,
  });
};

// a conformance file written by hand: its version's key, and nothing else, so its layout stays
export const withRepeatedVersion = (text, { key, version }) => {
  return replaceOnce(text, {
    pattern: new RegExp(`"${key}": "\\d+\\.\\d+\\.\\d+"`),
    replacement: `"${key}": "${version}"`,
  });
};

// every project range of a lock file, as NuGet writes it from <Version>, at the version: the text,
// and how many ranges it holds
export const withLockRanges = (text, version) => {
  let count = 0;
  const moved = text.replace(/("Bead\.[\w.]+": "\[)\d+\.\d+\.\d+(, \)")/g, (_, open, close) => {
    count += 1;
    return `${open}${version}${close}`;
  });
  return { text: moved, count };
};

// the first line of what beadc generates (decision 0022): beadc's version, the source, the
// blueprint's format and the spec's version
export const GENERATED =
  /^\/\/ @generated by beadc (\d+\.\d+\.\d+) from (.+): (bead-blueprint\/\d+), spec (\d+\.\d+\.\d+)\.$/;

// ! beadc's header, its two versions moved and nothing else: no tool runs (decision 0008), and the
// builder job's `generate --check` holds the replacement to what beadc writes. The text, or null
// for a text whose first line is no header of beadc's; the spec's version kept when none is given
export const withGeneratedHeader = (text, { beadc, spec }) => {
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  const header = GENERATED.exec(line);
  if (header === null) {
    return null;
  }
  const [, , source, format, stated] = header;
  const moved = `// @generated by beadc ${beadc} from ${source}: ${format}, spec ${spec ?? stated}.`;
  return `${moved}${text.slice(line.length)}`;
};

// a committed wrapper of beadc's, as `beadc wrapper` writes it outside the builder: the image it
// runs by default, named once, at the product's version; the examples job holds the rest of its
// text to beadc
export const WRAPPER = /(?:^|\/)beadc\.(?:sh|ps1)$/;

export const withWrapperImage = (text, version) => {
  return replaceOnce(text, {
    pattern: /ghcr\.io\/francisdesjardins\/beadc:\d+\.\d+\.\d+/,
    replacement: `ghcr.io/francisdesjardins/beadc:${version}`,
  });
};

// a blueprint beadc wrote, known by its format: its `specVersion` follows the spec's line, and the
// examples job's `generate --check` holds the rest of it to beadc
export const BLUEPRINT = /(?:^|\/)[^/]+\.blueprint\.json$/;

export const isBlueprint = (text) => {
  try {
    return JSON.parse(text)?.format === 'bead-blueprint/1';
  } catch {
    return false;
  }
};

// Keep a Changelog 1.1.0: [Unreleased] becomes the version and its date, under a new empty
// [Unreleased]; its link compares from the version's tag, and the version's compares the last
// release's tag with its own. Run again, the version right below [Unreleased] is its own: it is
// re-dated, and its links stay. The text, and whether the version's heading is new
export const withChangelogRelease = (text, { version, last, date, branch }) => {
  const { sections } = readChangelog(text);
  const at = sections.findIndex((section) => section.label === 'Unreleased');
  if (at === -1) {
    throw new Error('no ## [Unreleased]');
  }
  const own = sections[at + 1]?.label === version;
  if (!own && sections.some((section) => section.label === version)) {
    throw new Error(`[${version}] stands elsewhere than right below [Unreleased]`);
  }
  const link = /^\[Unreleased\]: (\S+)\/compare\/v\d+\.\d+\.\d+\.\.\.develop$/m.exec(text);
  if (link === null) {
    throw new Error(
      'no [Unreleased]: <repository>/compare/v<last>...develop to read the repository from'
    );
  }
  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\].*$`, 'm');
  if (own) {
    const { entries } = sections[at];
    if (entries > 0) {
      throw new Error(
        `[Unreleased] holds ${entries} ${entries === 1 ? 'entry' : 'entries'}: on ${branch}, a line goes under [${version}]`
      );
    }
    return { text: text.replace(heading, `## [${version}] - ${date}`), first: false };
  }
  const repository = link[1];
  const compared =
    last === null
      ? `${repository}/releases/tag/v${version}`
      : `${repository}/compare/v${last}...v${version}`;
  return {
    text: text
      .replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`)
      .replace(
        link[0],
        `[Unreleased]: ${repository}/compare/v${version}...develop\n[${version}]: ${compared}`
      ),
    first: true,
  };
};

// ── Moves ─────────────────────────────────────────────────────────────────────

// the version a move gives from the last release's: a level, `same`, or a version given whole
export const resolveMove = (move, { last, label }) => {
  if (parseVersion(move) !== null) {
    return move;
  }
  const levels = ['patch', 'minor', 'major', 'same'];
  if (!levels.includes(move)) {
    throw new Error(`${label}: ${move} is no move; give x.y.z, ${levels.join(', ')}`);
  }
  if (last === null) {
    throw new Error(`${label} was never released, so ${move} has nothing to move from: give x.y.z`);
  }
  const [patch, minor, major] = successorsOf(last);
  return { patch, minor, major, same: last }[move];
};

// a document's version in the release, from its facts as the gate reads them, held to the same
// rules: a successor of its last release when its files changed, at least the minor when a
// conformance file, a key or a property was added; its last release's when they did not
export const versionOf = (document, { stated, move, facts }) => {
  const { last, changed, added } = facts;
  const flag = `--${document.id}`;
  if (last === null) {
    if (move === undefined) {
      if (parseVersion(stated) === null) {
        throw new Error(`${document.path} states no version: give its first, ${flag} x.y.z`);
      }
      return stated;
    }
    return resolveMove(move, { last: null, label: document.path });
  }
  if (changed.length === 0) {
    if (move === undefined || move === 'same' || move === last.version) {
      return last.version;
    }
    throw new Error(
      `${document.path}: none of its files changed since ${last.name}, so it keeps ${last.version}, and ${flag} ${move} is refused`
    );
  }
  const [patch, minor, major] = successorsOf(last.version);
  // * run again, a move already made is kept
  if (move === undefined && ![patch, minor, major].includes(stated)) {
    const files = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ', …' : '');
    throw new Error(
      `${document.path} changed since ${last.name} (${files}): give ${flag} minor when an implementation must change to keep passing, ${flag} patch when a conforming one passes unchanged (decision 0008)`
    );
  }
  const version =
    move === undefined ? stated : resolveMove(move, { last: last.version, label: document.path });
  if (![patch, minor, major].includes(version)) {
    throw new Error(
      `${document.path}: ${version}, where its changes since ${last.name} owe one of ${patch}, ${minor}, ${major}`
    );
  }
  if (version === patch && added.length > 0) {
    const { path, what } = added[0];
    throw new Error(
      `${document.path}: ${version}, a patch, where ${what === 'file' ? `the file ${path}` : `${path}'s ${what}`} was added since ${last.name}: ${flag} minor at least (decision 0008)`
    );
  }
  return version;
};

// ── Owed ──────────────────────────────────────────────────────────────────────

// what a release reads for the work it owes by hand (decision 0022): the waivers of CI's `beadc
// breaking` step, each moot once the release is the last one, and decision 0006's gates owed, one
// that names the release moving to its table
export const CI = '.github/workflows/ci.yml';
export const GATES = 'docs/decisions/0006-a-rule-has-its-gate.md';

// the records' index: a tree that keeps it owes its documents brought to each release
export const RECORDS = 'docs/decisions/README.md';

// the benches' comparison: a tree that keeps it owes each release both benches' reports, kept in
// REPORTS, which git ignores, and compared with the last release's, made on the same machine
export const BENCH = 'tools/bench-compare.mjs';
export const REPORTS = '.bench';

// a line that runs `beadc breaking`, read whole
const BREAKING = /\b(?:cli\.ts|beadc(?:\.sh|\.ps1)?) breaking\b/;

// each `--except` of the lines that run `beadc breaking`, as written, its quotes dropped; a line
// continued by a backslash is read whole, and a comment is no line that runs
export const breakingWaivers = (text) => {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => {
      return !line.trimStart().startsWith('#') && BREAKING.test(line);
    })
    .flatMap((line) => {
      return [...line.matchAll(/--except[= ](?:'([^']*)'|"([^"]*)"|(\S+))/g)].map((match) => {
        return match[1] ?? match[2] ?? match[3];
      });
    });
};

// `text` with each of `waivers` taken out of the lines that run `beadc breaking`, as written, its
// quotes or none; every other line, a comment's among them, as it was
export const withoutWaivers = (text, waivers) => {
  const lines = text.split('\n');
  const out = [];
  for (let first = 0; first < lines.length;) {
    // a line, and those a backslash continues it on
    let last = first;
    while (last < lines.length - 1 && lines[last].endsWith('\\')) {
      last += 1;
    }
    const command = lines.slice(first, last + 1);
    const runs = !command[0].trimStart().startsWith('#') && BREAKING.test(command.join(' '));
    for (const line of command) {
      out.push(
        runs
          ? waivers.reduce((kept, waiver) => {
              const escaped = waiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return kept.replace(
                new RegExp(
                  `[ \\t]+--except[= ](?:'${escaped}'|"${escaped}"|${escaped})(?=\\s|$)`,
                  'g'
                ),
                ''
              );
            }, line)
          : line
      );
    }
    first = last + 1;
  }
  return out.join('\n');
};

// the bullets of 0006's gates owed that name `version`, each by its words before its first
// reference or its colon
export const gatesOwedAt = (text, version) => {
  const list = /^\*\*Gates owed\*\*[^\n]*\n\n((?:- [^\n]*\n(?: {2}[^\n]*\n)*)+)/m.exec(text)?.[1];
  if (list === undefined) {
    return [];
  }
  return list
    .split(/\n(?=- )/)
    .map((bullet) => {
      return bullet
        .replace(/^- /, '')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
    })
    .filter((bullet) => {
      return (bullet.match(/\d+\.\d+\.\d+/g) ?? []).includes(version);
    })
    .map((bullet) => {
      return bullet.split(/ \(\[|: /)[0].replace(/[,;.]$/, '');
    });
};

// ── Prepare ───────────────────────────────────────────────────────────────────

// the local calendar day: the day the tag the finish writes carries, in its offset; not UTC's
export const localDay = (date) => {
  const pad = (value) => {
    return String(value).padStart(2, '0');
  };
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// runs a command from the root, its output shown, or none when quiet; throws when it fails
const runFrom = (root) => {
  return (command, args, { quiet = false } = {}) => {
    const result = spawnSync(command, args, { cwd: root, stdio: quiet ? 'ignore' : 'inherit' });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `${[command, ...args].join(' ')}: ${result.error?.message ?? `exit ${result.status}`}`
      );
    }
  };
};

// prepares the release on the branch checked out
//   version  the product's, the branch's by default
//   moves    each document's move, by its id
//   date     the CHANGELOG's, the local day by default
//   python   the generators' interpreter, and spec/check.py's when it imports jsonschema
//   dryRun   prints the plan and writes nothing
//   run      runs a command; a stand-in in the tests
//   log      prints a line
export const prepare = (root, options = {}) => {
  const {
    moves = {},
    date = localDay(new Date()),
    python = process.platform === 'win32' ? 'python' : 'python3',
    dryRun = false,
    run = runFrom(root),
    log = console.log,
  } = options;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const named = /^(release|hotfix)\/(.+)$/.exec(branch);
  if (named === null) {
    throw new Error(`${branch}: a release is prepared on a release/* or hotfix/* branch`);
  }
  const [, kind, branchVersion] = named;
  const product = options.version ?? branchVersion;
  if (parseVersion(product) === null) {
    throw new Error(`${product}: x.y.z is due`);
  }
  if (product !== branchVersion) {
    throw new Error(`${product}: the branch ${branch} names ${branchVersion}`);
  }
  if (!isDay(date)) {
    throw new Error(`--date ${date}: a day, YYYY-MM-DD, is due`);
  }

  // * every fact from the last release and the tree, so a second run converges on the first
  const releases = gatherReleases(root, { mode: MODES.release });
  const last = newest(releases.tags.filter((tag) => tag.reached));
  if (last !== null && !successorsOf(last.version).includes(product)) {
    throw new Error(
      `${product}: the product's last release, ${last.name}, owes one of ${successorsOf(last.version).join(', ')}`
    );
  }
  const plan = { product, documents: {}, written: [] };
  for (const document of DOCUMENTS) {
    const text = readText(join(root, document.path));
    if (text === null) {
      continue;
    }
    plan.documents[document.id] = versionOf(document, {
      stated: STATED.exec(text)?.[1] ?? null,
      move: moves[document.id],
      facts: releases.documents[document.id],
    });
  }
  const summary = `release ${product}: ${Object.entries(plan.documents)
    .map(([id, version]) => `${id} ${version}`)
    .join(', ')}`;
  if (dryRun) {
    log(summary);
    return plan;
  }
  try {
    run(python, ['--version'], { quiet: true });
  } catch {
    throw new Error(`${python}: no Python to run the generators; give --python <path>`);
  }

  // the versions, each one replacement in its text, every text changed before any is written
  const staged = new Map();
  const stage = (path, change) => {
    const text = readText(join(root, path));
    if (text === null) {
      throw new Error(`${path}: no such file`);
    }
    try {
      staged.set(path, change(text));
    } catch (error) {
      throw new Error(`${path}: ${error.message}`);
    }
    if (staged.get(path) === text) {
      staged.delete(path);
    }
  };
  stage(PACKAGE, (text) => withPackageVersion(text, product));
  if (readText(join(root, BUILDER)) !== null) {
    stage(BUILDER, (text) => withPackageVersion(text, product));
  }
  stage(PROPS, (text) => withPropsVersion(text, product));
  // * a hotfix starts from main, whose CI keeps the waivers of the release it tags, all moot: the
  // branch compares against that release, where none waives anything
  const moot = kind === 'hotfix' ? breakingWaivers(readText(join(root, CI)) ?? '') : [];
  if (moot.length > 0) {
    stage(CI, (text) => withoutWaivers(text, moot));
  }
  for (const document of DOCUMENTS.filter((document) => document.id in plan.documents)) {
    stage(document.path, (text) => withStatedVersion(text, plan.documents[document.id]));
  }
  // every conformance file that repeats a moved document's version, as check-versions.mjs reads
  // them: a generator writes its own again after, and a file written by hand keeps its layout
  const repeated = readVersions(
    (path) => {
      return readText(join(root, path));
    },
    git(root, ['ls-files', '--', 'spec']).split('\n')
  );
  for (const document of DOCUMENTS.filter((document) => document.id in plan.documents)) {
    for (const path of Object.keys(repeated.documents[document.id].files)) {
      stage(path, (text) => {
        return withRepeatedVersion(text, {
          key: document.key,
          version: plan.documents[document.id],
        });
      });
    }
  }
  // every file git lists, read once for the lock files, beadc's wrappers and its blueprints, and
  // its generated files
  const listed = git(root, ['ls-files'])
    .split('\n')
    .filter((path) => {
      return path !== '';
    });
  // ! a text replacement, not `dotnet restore --force-evaluate`: the root's tools run no third
  // toolchain (decision 0005), and the lock files keep LF
  const locks = listed.filter((path) => {
    return LOCKS.test(path);
  });
  let ranges = 0;
  let holding = 0;
  for (const path of locks) {
    stage(path, (text) => {
      const moved = withLockRanges(text, product);
      ranges += moved.count;
      holding += moved.count > 0 ? 1 : 0;
      return moved.text;
    });
  }
  if (ranges === 0) {
    throw new Error(
      `no project range, "Bead.<Name>": "[x.y.z, )", in the ${locks.length} lock files of implementations/dotnet and examples`
    );
  }
  // every file beadc generated, known by its first line, outside the builder, whose goldens take
  // today's versions in their own test
  const outside = listed.filter((path) => {
    return !path.startsWith('builder/');
  });
  const generated = outside.filter((path) => {
    const text = readText(join(root, path));
    return text !== null && withGeneratedHeader(text, { beadc: product }) !== null;
  });
  for (const path of generated) {
    stage(path, (text) => {
      return withGeneratedHeader(text, { beadc: product, spec: plan.documents.spec });
    });
  }
  // each committed wrapper's image, at the product's version: the builder's own are templates,
  // which `beadc wrapper` fills
  const wrappers = outside.filter((path) => {
    return WRAPPER.test(path);
  });
  for (const path of wrappers) {
    stage(path, (text) => {
      return withWrapperImage(text, product);
    });
  }
  // * each blueprint beadc wrote outside spec/, at the spec's version: spec/'s own is a conformance
  // file, moved above, and one outside spec/ is none of the spec's files
  if (plan.documents.spec !== undefined) {
    const blueprints = outside.filter((path) => {
      return (
        !path.startsWith('spec/') && BLUEPRINT.test(path) && isBlueprint(readText(join(root, path)))
      );
    });
    for (const path of blueprints) {
      stage(path, (text) => {
        return withRepeatedVersion(text, { key: 'specVersion', version: plan.documents.spec });
      });
    }
  }
  let first = false;
  stage(CHANGELOG, (text) => {
    const released = withChangelogRelease(text, {
      version: product,
      last: last?.version ?? null,
      date,
      branch,
    });
    first = released.first;
    return released.text;
  });
  for (const [path, text] of staged) {
    writeFileSync(join(root, path), text);
    plan.written.push(path);
  }

  // ! the order is free: no generator reads another's output; one that comes to makes the order
  // matter, and then this glob gives way to CI's list
  const generators = readdirSync(join(root, 'spec/generators'))
    .filter((name) => /^make_\w+\.py$/.test(name))
    .sort();
  for (const name of generators) {
    run(python, [`spec/generators/${name}`]);
  }

  // the checks: the gate is required; one whose tool is absent is named, with the CI job holding it
  const { problems } = checkVersions(root, { ref: branch });
  if (problems.length > 0) {
    throw new Error(
      `the gate, as a release:\n${problems.map((problem) => `  ${problem}`).join('\n')}`
    );
  }
  let jsonschema = true;
  try {
    run(python, ['-c', 'import jsonschema'], { quiet: true });
  } catch {
    jsonschema = false;
  }
  if (jsonschema) {
    run(python, ['spec/check.py']);
  } else {
    log(`skipped: spec/check.py (no jsonschema for ${python}); CI's spec job holds it`);
  }
  // ! the root's own check, which holds the CHANGELOG up to its first released section alone: a
  // released section stays as its tag shipped it, whatever a newer formatter would lay out
  if (existsSync(join(root, OXFMT))) {
    run(process.execPath, ['tools/check-format.mjs']);
  } else {
    log(`skipped: the root's format check (no ${OXFMT}); CI's typescript job holds it`);
  }

  // what follows, which it does none of
  log(`${summary} (${ranges} project ranges in ${holding} lock files)`);
  const owed = DOCUMENTS.filter((document) => {
    const facts = releases.documents[document.id];
    return document.id in plan.documents && plan.documents[document.id] !== facts.last?.version;
  }).map((document) => {
    const version = plan.documents[document.id];
    return `${document.name}'s ${version} (${document.prefix}${version})`;
  });
  if (owed.length > 0) {
    log(`owed by hand: the [${product}] line on ${owed.join(' and ')}`);
  }
  for (const waiver of moot) {
    log(`taken out of ${CI}: --except ${waiver}, moot since the release main holds`);
  }
  for (const gate of gatesOwedAt(readText(join(root, GATES)) ?? '', product)) {
    log(`owed by hand: decision 0006's gate owed until ${product} moves to its table: ${gate}`);
  }
  if (existsSync(join(root, RECORDS))) {
    log(
      `owed by hand: the documents brought to ${product}, by the bead-release-documents workflow (.claude/workflows/README.md)`
    );
  }
  if (existsSync(join(root, BENCH))) {
    const kept = `${REPORTS}/v${product}-typescript.json and -csharp.json`;
    log(
      last === null
        ? `owed by hand: both benches run, their reports kept as ${kept} (README.md, "Measurement")`
        : `owed by hand: both benches run, their reports kept as ${kept}, each compared with ${last.name}'s on the machine that made them (README.md, "Measurement")`
    );
  }
  if (first) {
    log(`next: git add -A && git commit -m "chore(release): ${product}"`);
    log(`      git flow ${kind} publish ${product}, and wait for ci-ok`);
    log('      node tools/release.mjs prepare, again right before the finish');
  } else {
    log(`next: git commit -am "chore(release): ${product}, dated", if git status shows a change`);
    log(`      wait for ci-ok on ${branch}`);
    log(
      `      git flow ${kind} finish --keepremote ${product}, without -p; then node tools/release.mjs tag`
    );
  }
  return plan;
};

// ── Tag ───────────────────────────────────────────────────────────────────────

// sets each document's tag at the commit v<version> tags, the newest v* by default
//   version  the product's
//   log      prints a line
export const tag = (root, options = {}) => {
  const { log = console.log } = options;
  const released = git(root, ['for-each-ref', '--format=%(refname)', 'refs/tags/v*'])
    .split('\n')
    .map((ref) => /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(ref)?.[1])
    .filter((version) => version !== undefined)
    .map((version) => ({ version }));
  // ! the finish ends on develop, at its back-merge: the tagged commit is no HEAD to read
  const version = options.version ?? newest(released)?.version;
  if (version === undefined) {
    throw new Error('no v* tag: finish the release first');
  }
  const name = `v${version}`;
  if (!released.some((release) => release.version === version)) {
    throw new Error(`${name}: no such tag`);
  }
  const commit = git(root, ['rev-parse', `refs/tags/${name}^{commit}`]).trim();
  try {
    git(root, ['merge-base', '--is-ancestor', commit, 'main']);
  } catch {
    throw new Error(`${name} is not on main: finish the release first`);
  }
  const show = (path) => {
    try {
      return git(root, ['show', `${commit}:${path}`]);
    } catch {
      return null;
    }
  };
  const product = JSON.parse(show(PACKAGE) ?? '{}').version;
  if (product !== version) {
    throw new Error(`${name}: its tree states the product ${product}, where ${version} is due`);
  }

  const exists = (tagName) => {
    return git(root, ['tag', '--list', tagName]).trim() !== '';
  };
  const made = [];
  for (const document of DOCUMENTS) {
    const stated = STATED.exec(show(document.path) ?? '')?.[1];
    if (stated === undefined || exists(`${document.prefix}${stated}`)) {
      continue;
    }
    // ! at the commit, peeled: a tag of the tag would nest it
    git(root, [
      'tag',
      '-a',
      `${document.prefix}${stated}`,
      '-m',
      `${document.path} ${stated}`,
      commit,
    ]);
    made.push(`${document.prefix}${stated}`);
  }
  log(
    made.length > 0 ? `tagged ${made.join(', ')} at ${name}` : `no document's tag to set at ${name}`
  );

  // the gate as main's run will judge it, then over the branch checked out, where a released
  // section of the CHANGELOG shows a line the back-merge filed under it
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const problems = [
    ...checkVersions(root, { ref: 'main', commit: 'main' }).problems.map((problem) => {
      return `main: ${problem}`;
    }),
    ...checkVersions(root).problems.map((problem) => `${branch}: ${problem}`),
  ];
  // each document's tag at the commit, in the documents' order
  const documentTags = DOCUMENTS.flatMap((document) => {
    return git(root, [
      'for-each-ref',
      '--format=%(refname:strip=2) %(*objectname) %(objectname)',
      `refs/tags/${document.prefix}*`,
    ])
      .split('\n')
      .filter((line) => line.split(' ').slice(1).includes(commit))
      .map((line) => line.split(' ')[0]);
  });
  // ! a published release or hotfix branch stays on origin through the finish (--keepremote):
  // the one push deletes it, so nothing reaches origin before the user's push
  const published = ['release', 'hotfix']
    .map((kind) => {
      return `${kind}/${version}`;
    })
    .filter((branch) => {
      return (
        git(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`]) !== ''
      );
    })
    .map((branch) => {
      return `:${branch}`;
    });
  const push = `git push --atomic origin main develop ${[name, ...documentTags, ...published].join(' ')}`;
  if (problems.length > 0) {
    throw new Error(
      [
        ...problems,
        `fix them, then run node tools/release.mjs tag again, which sets no tag twice, and push: ${push}`,
      ].join('\n')
    );
  }

  // * the waivers the tagged commit carries, moot once it is the release CI compares against: out
  // of the branch checked out, develop at its back-merge, committed before the one push
  const moot = breakingWaivers(show(CI) ?? '');
  const ci = readText(join(root, CI));
  const without = ci === null ? null : withoutWaivers(ci, moot);
  if (ci !== null && without !== ci) {
    writeFileSync(join(root, CI), without);
    for (const waiver of moot) {
      log(`taken out of ${CI}: --except ${waiver}, which ${name} makes moot`);
    }
    log(`next: git commit -m "ci: take out the waivers ${name} makes moot" -- ${CI}`);
  }
  log(`push: ${push}`);
  return { version, made, push };
};

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const usage = () => {
    console.error(
      'usage: node tools/release.mjs prepare [<version>] [--spec <move>] [--debugging <move>] [--transcoding <move>] [--date YYYY-MM-DD] [--python <path>] [--dry-run]'
    );
    console.error('       node tools/release.mjs tag [<version>]');
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        spec: { type: 'string' },
        debugging: { type: 'string' },
        transcoding: { type: 'string' },
        date: { type: 'string' },
        python: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch (error) {
    console.error(`release: ${error.message}`);
    usage();
  }
  const { values, positionals } = parsed;
  const [command, version, ...rest] = positionals;
  if (
    rest.length > 0 ||
    !['prepare', 'tag'].includes(command) ||
    (command === 'tag' && Object.keys(values).length > 0)
  ) {
    usage();
  }
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    if (command === 'prepare') {
      prepare(root, {
        version,
        moves: { spec: values.spec, debugging: values.debugging, transcoding: values.transcoding },
        date: values.date,
        python: values.python,
        dryRun: values['dry-run'],
      });
    } else {
      tag(root, { version });
    }
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
