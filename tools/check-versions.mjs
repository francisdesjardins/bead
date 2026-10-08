#!/usr/bin/env node
// Every version agrees with itself, a released section of the CHANGELOG stays as its tag shipped
// it, and a release moves each version its changes owe (decision 0008): the product's, the spec's
// and its companion's.
//
//   node tools/check-versions.mjs                   judged as the branch checked out
//   node tools/check-versions.mjs --ref <ref>       judged as that ref: a branch, or refs/tags/…
//   node tools/check-versions.mjs --base <branch>   a pull request's base: one into main is a release
//
// On every ref: the TypeScript package's `version`, the builder's where the tree has one, the C#
// side's `<Version>` and every project range of its lock files and of an example's agree; each
// conformance file repeats its document's version; and each `## [x.y.z]` section of the CHANGELOG
// is the one its `vx.y.z` shipped. On a release branch, a pull request into main and main,
// besides: the product and each document whose files changed move one step past their last
// release, at least the minor where a file, a key or a property was added, and a document whose
// files did not keeps its version; each document's tag stands at the first `v*` that gives its
// version; and the CHANGELOG dates and links the release. Exit 1 on a problem, one a line, then a summary; exit 2 on a usage error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ── Versions ──────────────────────────────────────────────────────────────────

// x.y.z, without a pre-release or a build: 0008 keeps every axis to it
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const parseVersion = (text) => {
  const found = VERSION.exec(text ?? '');
  return found === null ? null : found.slice(1).map(Number);
};

export const compareVersions = (a, b) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// the versions that may follow one, as Semantic Versioning counts them: its next patch, minor or
// major
export const successorsOf = (version) => {
  const [major, minor, patch] = parseVersion(version);
  return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`];
};

// the release of the highest version among some, or null
export const newest = (releases) => {
  return releases.reduce((best, release) => {
    return best === null || compareVersions(release.version, best.version) > 0 ? release : best;
  }, null);
};

// the release of the lowest version among some, or null
const oldest = (releases) => {
  return releases.reduce((best, release) => {
    return best === null || compareVersions(release.version, best.version) < 0 ? release : best;
  }, null);
};

// a calendar day as ISO 8601 writes it, YYYY-MM-DD, and one the calendar has
export const isDay = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? '')) {
    return false;
  }
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
};

// ── Texts ─────────────────────────────────────────────────────────────────────

// ! a working tree's text, read with LF: git keeps its blobs at LF, but a tool on Windows writes
// CRLF in the working tree, as `dotnet restore` writes its lock files
export const readText = (path) => {
  return existsSync(path) ? readFileSync(path, 'utf8').replaceAll('\r\n', '\n') : null;
};

// the line a document states its version on, as spec/generators/spec_version.py reads it
export const STATED = /^\*\*Version: (\d+\.\d+\.\d+)\*\*/m;

// ! a text with its versions masked: a release's own move of a version is no change of its document
export const unversioned = (text) => {
  return text
    .replace(/^\*\*Version: \d+\.\d+\.\d+\*\*/gm, '**Version: x.y.z**')
    .replace(/"(specVersion|debuggingVersion)"(\s*:\s*)"[^"]*"/g, '"$1"$2"x.y.z"');
};

const isObject = (value) => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// a JSON text's value, or null for a text that is no JSON
const parseJson = (text) => {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
};

// the top-level keys of a JSON object's text; none for any other text
const keysOf = (text) => {
  const value = parseJson(text);
  return new Set(isObject(value) ? Object.keys(value) : []);
};

// every property a schema declares, by its place: each key of each `properties` object, at any
// depth, as a JSON Pointer
const propertiesOf = (text) => {
  const found = new Set();
  const walk = (node, pointer) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${pointer}/${index}`);
      });
      return;
    }
    if (!isObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isObject(value)) {
        for (const name of Object.keys(value)) {
          found.add(`${pointer}/properties/${name}`);
        }
      }
      walk(value, `${pointer}/${key}`);
    }
  };
  walk(parseJson(text), '');
  return found;
};

// ── Axes ──────────────────────────────────────────────────────────────────────

export const PACKAGE = 'implementations/typescript/package.json';
export const PROPS = 'implementations/dotnet/Directory.Build.props';
// the builder's package, which ships with the product's releases at its version (decision 0008)
export const BUILDER = 'builder/package.json';
export const CHANGELOG = 'CHANGELOG.md';

// the C# lock files that take the side's projects: every packages.lock.json git lists under
// implementations/dotnet, and under an example's dotnet folder
export const LOCKS =
  /^(?:implementations\/dotnet|examples\/[^/]+\/dotnet)\/(?:.+\/)?packages\.lock\.json$/;

// each document: its id, its name in prose, its tag's prefix, the file that states its version,
// and the key its conformance files repeat that version under
export const DOCUMENTS = Object.freeze([
  Object.freeze({
    id: 'spec',
    name: 'the spec',
    prefix: 'spec-v',
    path: 'spec/spec.md',
    key: 'specVersion',
  }),
  Object.freeze({
    id: 'debugging',
    name: 'the companion',
    prefix: 'debugging-v',
    path: 'spec/debugging.md',
    key: 'debuggingVersion',
  }),
]);

// a conformance file: a JSON file directly under spec/
const CONFORMANCE = /^spec\/[^/]+\.json$/;

// a conformance file's schema, by the file's name
const SCHEMA = /^spec\/schemas\/([^/]+)\.schema\.json$/;

// what under spec/ is tooling, of no document: its output CI holds byte for byte
const TOOLING = /^spec\/(?:generators\/|check\.py$|requirements\.(?:in|txt)$)/;

// the keys a conformance file may gain without a minor: its schema's link, a comment, its version
const UNCOUNTED_KEYS = new Set(['$schema', '$comment', 'specVersion', 'debuggingVersion']);

// the documents a file of the repository belongs to, a conformance file's content read through
// `read(path)`, which gives a text or null: the companion's text, the conformance files that repeat
// its version and their schemas are the companion's; common.schema.json is both's; tooling and
// what lies outside spec/ are none's; every other file of spec/ is the spec's
export const documentOf = (path, read) => {
  if (!path.startsWith('spec/') || TOOLING.test(path)) {
    return [];
  }
  if (path === 'spec/schemas/common.schema.json') {
    return ['spec', 'debugging'];
  }
  if (path.startsWith('spec/debugging')) {
    return ['debugging'];
  }
  const schema = SCHEMA.exec(path);
  const file = schema === null ? path : `spec/${schema[1]}.json`;
  if (CONFORMANCE.test(file) && keysOf(read(file)).has('debuggingVersion')) {
    return ['debugging'];
  }
  return ['spec'];
};

// the project ranges of a lock file: each dependency that an entry of `"type": "Project"` takes on
// another such entry, which NuGet writes from the other's <Version> as `[x.y.z, )`
const projectRangesOf = (text) => {
  const lock = parseJson(text);
  const ranges = [];
  for (const target of Object.values(isObject(lock?.dependencies) ? lock.dependencies : {})) {
    const projects = Object.entries(isObject(target) ? target : {}).filter(([, entry]) => {
      return entry?.type === 'Project';
    });
    const names = new Set(projects.map(([name]) => name.toLowerCase()));
    for (const [owner, entry] of projects) {
      for (const [name, range] of Object.entries(entry.dependencies ?? {})) {
        if (names.has(name.toLowerCase())) {
          ranges.push({ owner, name, range });
        }
      }
    }
  }
  return ranges;
};

// the versions a tree states, read through `read(path)` from the paths it lists
export const readVersions = (read, paths) => {
  const props = read(PROPS);
  const versions = {
    package: parseJson(read(PACKAGE))?.version ?? null,
    builder: parseJson(read(BUILDER))?.version ?? null,
    hasBuilder: read(BUILDER) !== null,
    props: props === null ? null : (/<Version>([^<]*)<\/Version>/.exec(props)?.[1] ?? null),
    locks: {},
    documents: {},
  };
  for (const path of paths.filter((path) => LOCKS.test(path))) {
    versions.locks[path] = projectRangesOf(read(path));
  }
  for (const document of DOCUMENTS) {
    const text = read(document.path);
    versions.documents[document.id] = {
      present: text !== null,
      stated: text === null ? null : (STATED.exec(text)?.[1] ?? null),
      files: {},
    };
  }
  for (const path of paths.filter((path) => CONFORMANCE.test(path))) {
    const json = parseJson(read(path));
    for (const document of DOCUMENTS) {
      if (isObject(json) && document.key in json) {
        versions.documents[document.id].files[path] = json[document.key];
      }
    }
  }
  return versions;
};

// a CHANGELOG as Keep a Changelog 1.1.0 writes it: its `## ` sections in order, each from its
// heading to the next `## ` heading or to the first link reference, and its link references
export const readChangelog = (text) => {
  const end = text.search(/^\[[^\]\n]+\]: /m);
  const body = end === -1 ? text : text.slice(0, end);
  const starts = [...body.matchAll(/^## .*$/gm)];
  const sections = starts.map((start, index) => {
    const section = body.slice(start.index, starts[index + 1]?.index ?? body.length);
    const heading = /^## \[([^\]]+)\](?: - (.*))?$/.exec(start[0]);
    return {
      label: heading?.[1] ?? null,
      date: heading?.[2] ?? null,
      text: section.trimEnd(),
      entries: section.match(/^- /gm)?.length ?? 0,
    };
  });
  const links = {};
  for (const [, label, target] of text.matchAll(/^\[([^\]\n]+)\]: (\S+)/gm)) {
    links[label] ??= target;
  }
  return { sections, links };
};

// ── Modes ─────────────────────────────────────────────────────────────────────

// 'develop' holds each axis to itself: develop, a feature branch, any other ref; 'release' prepares
// one: a release/* or hotfix/* branch, or a pull request into main, every v* it reaches being of a
// release before it; 'released' is one: main and a tag, the v* at its commit being its own
export const MODES = Object.freeze({
  develop: 'develop',
  release: 'release',
  released: 'released',
});

export const modeOf = ({ ref, base }) => {
  const name = ref.replace(/^refs\/heads\//, '');
  if (/^(?:release|hotfix)\//.test(name) || base?.replace(/^refs\/heads\//, '') === 'main') {
    return MODES.release;
  }
  if (name === 'main' || name.startsWith('refs/tags/')) {
    return MODES.released;
  }
  return MODES.develop;
};

// ── Judge ─────────────────────────────────────────────────────────────────────

// a few paths, then how many more
const listOf = (paths) => {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
};

// an addition, in words
const additionOf = ({ path, what }) => {
  return what === 'file' ? `the file ${path}` : `${path}'s ${what}`;
};

// the problems of a tree, from facts gathered beforehand; no git and no file is read here
//   versions   what the tree states, as readVersions gives it
//   mode       one of MODES
//   releases   what gatherReleases gives
//   changelog  the tree's CHANGELOG, as readChangelog gives it
export const judge = (versions, { mode, releases, changelog }) => {
  const problems = [
    ...judgeAxes(versions),
    ...judgeFrozen(changelog, { mode, product: versions.package, tags: releases.tags }),
  ];
  if (mode === MODES.develop || problems.length > 0) {
    return problems;
  }
  const reached = releases.tags.filter((tag) => tag.reached);
  // ! a floor: a clone without its tags would pass every release
  if (reached.length === 0) {
    return ['tags: no v* is reached from HEAD: fetch the history and its tags'];
  }
  const last = newest(reached.filter((tag) => !tag.own));
  // the CHANGELOG of a release is read once its product moved, which names its section
  const moved = last === null || successorsOf(last.version).includes(versions.package);
  return [
    ...judgeMoves(versions, { last, documents: releases.documents }),
    ...judgeTags(versions, { mode, reached, documentTags: releases.documentTags }),
    ...(moved ? judgeRelease(changelog, { product: versions.package, last }) : []),
  ];
};

// A1 to A3: each axis agrees with itself
const judgeAxes = (versions) => {
  const problems = [];
  if (parseVersion(versions.package) === null) {
    problems.push(`${PACKAGE}: version ${versions.package}, where x.y.z is due`);
  }
  // a tree from before the builder holds none, and owes none
  if (versions.hasBuilder && versions.builder !== versions.package) {
    problems.push(
      `${BUILDER}: version ${versions.builder}, where ${PACKAGE} states ${versions.package}`
    );
  }
  if (versions.props !== versions.package) {
    problems.push(
      `${PROPS}: <Version> ${versions.props}, where ${PACKAGE} states ${versions.package}`
    );
  }
  // ! NuGet writes a project's range from the other's <Version>, and a locked restore accepts a
  // stale one: only a later restore would move it, in a commit about something else
  for (const [path, ranges] of Object.entries(versions.locks)) {
    for (const { owner, name, range } of ranges) {
      if (range !== `[${versions.props}, )`) {
        problems.push(
          `${path}: ${owner} takes ${name} at ${range}, where <Version> ${versions.props} owes [${versions.props}, )`
        );
      }
    }
  }
  for (const document of DOCUMENTS) {
    const { present, stated, files } = versions.documents[document.id];
    if (!present) {
      continue;
    }
    if (parseVersion(stated) === null) {
      problems.push(`${document.path}: states no **Version: x.y.z**`);
    }
    const entries = Object.entries(files);
    // ! a floor: a walk that reads no file of a document proves nothing of its files
    if (entries.length === 0) {
      problems.push(`${document.path}: no conformance file repeats it as its ${document.key}`);
    }
    for (const [path, version] of entries) {
      if (version !== stated) {
        problems.push(
          `${path}: ${document.key} ${version}, where ${document.path} states ${stated}`
        );
      }
    }
  }
  return problems;
};

// A4: a released section of the CHANGELOG is the one its tag shipped, so a line filed under it
// later, as a back-merge files develop's, fails; on a release ref, the release's own section, its
// v* not reached yet, is exempt, and V5 and V6 judge it
const judgeFrozen = (changelog, { mode, product, tags }) => {
  const problems = [];
  for (const section of changelog.sections) {
    if (parseVersion(section.label) === null) {
      continue;
    }
    const tag = tags.find((tag) => tag.version === section.label && tag.reached);
    if (mode !== MODES.develop && section.label === product && tag === undefined) {
      continue;
    }
    if (tag === undefined) {
      problems.push(
        `${CHANGELOG}: [${section.label}] names no v${section.label} reached from HEAD: fetch the history and its tags`
      );
      continue;
    }
    const shipped = readChangelog(tag.changelog ?? '').sections.find((other) => {
      return other.label === section.label;
    });
    if (shipped?.text !== section.text) {
      const now = section.text.split('\n');
      const then = shipped?.text.split('\n') ?? [];
      const at = now.findIndex((line, index) => line !== then[index]);
      const line = now[at === -1 ? now.length - 1 : at];
      problems.push(
        `${CHANGELOG}: [${section.label}] is not the section ${tag.name} shipped, from "${line.slice(0, 60)}": a released section stays as its tag shipped it, and a line filed under it goes back under [Unreleased]`
      );
    }
  }
  return problems;
};

// V2 to V4: the product and each document one step past its last release, at least the minor
// where something was added, and a document whose files did not change, kept
const judgeMoves = (versions, { last, documents }) => {
  const problems = [];
  if (last !== null && !successorsOf(last.version).includes(versions.package)) {
    problems.push(
      `${PACKAGE}: ${versions.package}, where the product's last release, ${last.name}, owes one of ${successorsOf(last.version).join(', ')}`
    );
  }
  for (const document of DOCUMENTS) {
    const { present, stated } = versions.documents[document.id];
    const facts = documents[document.id];
    // a document in no release takes any first version
    if (!present || facts.last === null) {
      continue;
    }
    const { name, version } = facts.last;
    if (facts.changed.length === 0) {
      if (stated !== version) {
        problems.push(
          `${document.path}: ${stated}, though none of its files changed since ${name}, which gives it ${version}`
        );
      }
      continue;
    }
    const [patch, minor, major] = successorsOf(version);
    if (![patch, minor, major].includes(stated)) {
      problems.push(
        `${document.path}: ${stated}, where its changes since ${name} (${listOf(facts.changed)}) owe one of ${patch}, ${minor}, ${major}`
      );
    } else if (stated === patch && facts.added.length > 0) {
      problems.push(
        `${document.path}: ${stated}, a patch, where ${additionOf(facts.added[0])}, added since ${name}, owes at least its minor, ${minor} (decision 0008)`
      );
    }
  }
  return problems;
};

// V5: a released ref is its v*; each v* that states a document's version has that version's tag;
// each document's tag stands at the first v* that gives its version, and names the version of the
// v* it stands at
const judgeTags = (versions, { mode, reached, documentTags }) => {
  const problems = [];
  if (mode === MODES.released) {
    const own = reached.filter((tag) => tag.own);
    if (own.length === 0) {
      problems.push(
        'tags: no v* tags HEAD: a release pushes main and its tags at once, git push --atomic'
      );
    }
    for (const tag of own.filter((tag) => tag.version !== versions.package)) {
      problems.push(`${tag.name}: tags HEAD, where ${PACKAGE} states ${versions.package}`);
    }
  }
  for (const document of DOCUMENTS) {
    const own = documentTags.filter((tag) => tag.document === document.id);
    for (const release of reached) {
      const stated = release.states[document.id];
      if (stated !== null && !own.some((tag) => tag.version === stated)) {
        problems.push(
          `${release.name}: its tree states ${document.path} ${stated}, which no ${document.prefix}${stated} tags: node tools/release.mjs tag`
        );
      }
    }
    for (const tag of own) {
      const giver = oldest(reached.filter((release) => release.gives[document.id] === tag.version));
      if (giver !== null && tag.commit !== giver.commit) {
        problems.push(
          `${tag.name}: at ${tag.commit.slice(0, 7)}, where ${giver.name}, the first v* that gives ${document.path} ${tag.version}, is at ${giver.commit.slice(0, 7)}`
        );
      }
      for (const release of reached.filter((release) => release.commit === tag.commit)) {
        if (release.gives[document.id] !== tag.version) {
          problems.push(
            `${tag.name}: at ${release.name}, whose tree gives ${document.path} ${release.gives[document.id] ?? 'no version'}`
          );
        }
      }
    }
  }
  return problems;
};

// V6: a release's CHANGELOG ships its lines under its version, dated, and links both
const judgeRelease = (changelog, { product, last }) => {
  const problems = [];
  const at = changelog.sections.findIndex((section) => section.label === 'Unreleased');
  if (at === -1) {
    problems.push(`${CHANGELOG}: no ## [Unreleased]`);
  } else {
    const [unreleased, own] = [changelog.sections[at], changelog.sections[at + 1]];
    if (unreleased.entries > 0) {
      problems.push(
        `${CHANGELOG}: [Unreleased] holds ${unreleased.entries} ${unreleased.entries === 1 ? 'entry' : 'entries'}, which a release ships under [${product}]`
      );
    }
    if (own?.label !== product) {
      problems.push(`${CHANGELOG}: no ## [${product}] - YYYY-MM-DD right below ## [Unreleased]`);
    } else {
      if (!isDay(own.date)) {
        problems.push(
          `${CHANGELOG}: [${product}] dated ${own.date ?? 'nowhere'}, where a day, YYYY-MM-DD, is due`
        );
      }
      if (own.entries === 0) {
        problems.push(`${CHANGELOG}: [${product}] holds no entry`);
      }
    }
  }
  const repository = /^(\S+)\/compare\/v[^/]+\.\.\.develop$/.exec(
    changelog.links.Unreleased ?? ''
  )?.[1];
  if (repository === undefined) {
    problems.push(
      `${CHANGELOG}: no [Unreleased]: <repository>/compare/v${product}...develop to read the repository from`
    );
    return problems;
  }
  const links = {
    Unreleased: `${repository}/compare/v${product}...develop`,
    [product]:
      last === null
        ? `${repository}/releases/tag/v${product}`
        : `${repository}/compare/v${last.version}...v${product}`,
  };
  for (const [label, target] of Object.entries(links)) {
    if (changelog.links[label] !== target) {
      problems.push(
        `${CHANGELOG}: [${label}]: ${changelog.links[label] ?? 'none'}, where ${target} is due`
      );
    }
  }
  return problems;
};

// ── Git ───────────────────────────────────────────────────────────────────────

const BUFFER = 256 * 1024 * 1024;

export const git = (root, args) => {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const lines = (text, separator = '\n') => {
  return text.split(separator).filter((line) => line !== '');
};

// the objects git holds under some names, `<commit>` or `<commit>:<path>`, in one call: each a text,
// or null where git holds none
const objectsOf = (root, names) => {
  const texts = new Map();
  if (names.length === 0) {
    return texts;
  }
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${names.join('\n')}\n`,
    maxBuffer: BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let at = 0;
  for (const name of names) {
    const end = out.indexOf(0x0a, at);
    const header = out.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (header.length !== 3) {
      texts.set(name, null);
      continue;
    }
    const size = Number(header[2]);
    texts.set(name, header[1] === 'tree' ? null : out.toString('utf8', at, at + size));
    at += size + 1;
  }
  return texts;
};

// a tree to read: the working tree, or a commit's when one is given; `load` reads many paths of a
// commit's in one call, ahead of `read`
const treeOf = (root, commit) => {
  if (commit === undefined) {
    const listed = lines(
      git(root, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']),
      '\0'
    );
    const paths = [...new Set(listed.map((line) => line.slice(2)))].filter((path) => {
      return existsSync(join(root, path));
    });
    const untracked = listed.filter((line) => line.startsWith('? ')).map((line) => line.slice(2));
    return {
      paths,
      read: (path) => {
        return readText(join(root, path));
      },
      load: () => {},
      // what differs under spec/ from a commit: git's diff, and what git does not keep yet
      diff: (since) => {
        const diffed = lines(
          git(root, ['diff', '-z', '--name-only', '--no-renames', since, '--', 'spec']),
          '\0'
        );
        return [...new Set([...diffed, ...untracked])].filter((path) => path.startsWith('spec/'));
      },
    };
  }
  const cache = new Map();
  const load = (paths) => {
    const missing = paths.filter((path) => !cache.has(path));
    const found = objectsOf(
      root,
      missing.map((path) => `${commit}:${path}`)
    );
    for (const path of missing) {
      cache.set(path, found.get(`${commit}:${path}`) ?? null);
    }
  };
  const paths = lines(git(root, ['ls-tree', '-r', '-z', '--name-only', commit]), '\0');
  load(
    paths.filter((path) => {
      return (
        path.startsWith('spec/') ||
        LOCKS.test(path) ||
        [PACKAGE, BUILDER, PROPS, CHANGELOG].includes(path)
      );
    })
  );
  return {
    paths,
    read: (path) => {
      load([path]);
      return cache.get(path);
    },
    load,
    diff: (since) => {
      return lines(
        git(root, ['diff', '-z', '--name-only', '--no-renames', since, commit, '--', 'spec']),
        '\0'
      );
    },
  };
};

// what changed under spec/ since a commit, in the tree judged, and what was added: each path whose
// text differs once its versions are masked, and each conformance file, top-level key of one and
// property of a schema added; each with the documents it belongs to
const differencesOf = (root, { since, tree }) => {
  const then = treeOf(root, since);
  const listed = tree.diff(since);
  const read = (path) => {
    return tree.read(path) ?? then.read(path);
  };
  const changed = listed.filter((path) => {
    const [before, after] = [then.read(path), tree.read(path)];
    return before === null || after === null || unversioned(before) !== unversioned(after);
  });
  const added = [];
  for (const path of changed) {
    const [before, after] = [then.read(path), tree.read(path)];
    if (after === null) {
      continue;
    }
    if (CONFORMANCE.test(path)) {
      if (before === null) {
        added.push({ path, what: 'file' });
        continue;
      }
      const keys = keysOf(before);
      for (const key of keysOf(after)) {
        if (!keys.has(key) && !UNCOUNTED_KEYS.has(key)) {
          added.push({ path, what: `key "${key}"` });
        }
      }
    } else if (SCHEMA.test(path)) {
      const properties = propertiesOf(before);
      for (const pointer of propertiesOf(after)) {
        if (!properties.has(pointer)) {
          added.push({ path, what: `property ${pointer}` });
        }
      }
    }
  }
  return {
    changed: changed.map((path) => ({ path, documents: documentOf(path, read) })),
    added: added.map((addition) => ({ ...addition, documents: documentOf(addition.path, read) })),
  };
};

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

// a document's own tag: its prefix, then its version
const tagOf = (document) => {
  return new RegExp(`^${document.prefix}(\\d+\\.\\d+\\.\\d+)$`);
};

// the facts judge reads, from git and the tree judged: the working tree, or a commit's
//   tags          every v*: its commit; whether HEAD reaches it, by its commit or by its merge's
//                 second parent, the release branch a back-merge of the branch brings in; whether
//                 it is the release judged; what its tree states and gives of each document; and
//                 its CHANGELOG
//   documentTags  every spec-v* and debugging-v* in the repository, peeled to its commit
//   documents     on a strict mode, each document's last release, and what of it changed and was
//                 added since
export const gatherReleases = (root, { mode, commit }) => {
  const head = commit ?? 'HEAD';
  const names = lines(
    git(root, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/tags/v*',
      ...DOCUMENTS.map((document) => `refs/tags/${document.prefix}*`),
    ])
  )
    .map((ref) => ref.replace(/^refs\/tags\//, ''))
    .filter((name) => {
      return [RELEASE_TAG, ...DOCUMENTS.map((document) => tagOf(document))].some((pattern) => {
        return pattern.test(name);
      });
    });
  // ! each tag peeled to its commit, however deep a tag of a tag nests it
  const [headCommit, ...commits] = lines(
    git(root, ['rev-parse', head, ...names.map((name) => `refs/tags/${name}^{commit}`)])
  );
  const peeled = names.map((name, index) => ({ name, commit: commits[index] }));
  const ancestors = new Set(lines(git(root, ['rev-list', head])));
  const releases = peeled.filter(({ name }) => RELEASE_TAG.test(name));
  const objects = objectsOf(
    root,
    releases.flatMap(({ commit }) => {
      return [
        commit,
        `${commit}:${CHANGELOG}`,
        ...DOCUMENTS.map((document) => `${commit}:${document.path}`),
      ];
    })
  );
  const tags = releases.map(({ name, commit }) => {
    const version = RELEASE_TAG.exec(name)[1];
    const parents = [...(objects.get(commit) ?? '').matchAll(/^parent ([0-9a-f]+)$/gm)].map(
      (match) => match[1]
    );
    // a tree gives a document the version it states or, stating none, the v*'s own
    const states = {};
    const gives = {};
    for (const document of DOCUMENTS) {
      const text = objects.get(`${commit}:${document.path}`);
      states[document.id] = text === null ? null : (STATED.exec(text)?.[1] ?? null);
      gives[document.id] = text === null ? null : (states[document.id] ?? version);
    }
    return {
      name,
      version,
      commit,
      reached: ancestors.has(commit) || (parents[1] !== undefined && ancestors.has(parents[1])),
      own: mode === MODES.released && commit === headCommit,
      states,
      gives,
      changelog: objects.get(`${commit}:${CHANGELOG}`),
    };
  });
  const documentTags = peeled.flatMap(({ name, commit }) => {
    return DOCUMENTS.filter((document) => tagOf(document).test(name)).map((document) => {
      return { name, document: document.id, version: tagOf(document).exec(name)[1], commit };
    });
  });
  if (mode === MODES.develop) {
    return { tags, documentTags, documents: null };
  }
  const tree = treeOf(root, commit);
  const differences = new Map();
  const documents = {};
  for (const document of DOCUMENTS) {
    // * a document's last release is read from the v* alone: its own tags are outputs, checked
    const release = newest(
      tags.filter((tag) => tag.reached && !tag.own && tag.gives[document.id] !== null)
    );
    if (release === null) {
      documents[document.id] = { last: null, changed: [], added: [] };
      continue;
    }
    if (!differences.has(release.commit)) {
      differences.set(release.commit, differencesOf(root, { since: release.commit, tree }));
    }
    const { changed, added } = differences.get(release.commit);
    const owned = (item) => {
      return item.documents.includes(document.id);
    };
    documents[document.id] = {
      last: { name: release.name, version: release.gives[document.id], commit: release.commit },
      changed: changed.filter(owned).map((item) => item.path),
      added: added.filter(owned),
    };
  }
  return { tags, documentTags, documents };
};

// ── Main ──────────────────────────────────────────────────────────────────────

// the problems of a tree judged as a ref: the working tree, or the tree of `commit` when given,
// which then stands for HEAD
export const checkVersions = (root, { ref, base, commit } = {}) => {
  const mode = modeOf({
    ref: ref || git(root, ['rev-parse', '--abbrev-ref', commit ?? 'HEAD']).trim(),
    base: base || undefined,
  });
  const tree = treeOf(root, commit);
  const versions = readVersions(tree.read, tree.paths);
  const changelog = readChangelog(tree.read(CHANGELOG) ?? '');
  const releases = gatherReleases(root, { mode, commit });
  return { mode, versions, problems: judge(versions, { mode, releases, changelog }) };
};

if (import.meta.main) {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: { ref: { type: 'string' }, base: { type: 'string' } },
    }));
  } catch (error) {
    console.error(`versions: ${error.message}`);
    console.error('usage: node tools/check-versions.mjs [--ref <ref>] [--base <branch>]');
    process.exit(2);
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const { mode, versions, problems } = checkVersions(root, options);
  for (const problem of problems) {
    console.error(`versions: ${problem}`);
  }
  const documents = DOCUMENTS.filter((document) => versions.documents[document.id].present)
    .map((document) => `${document.id} ${versions.documents[document.id].stated}`)
    .join(', ');
  console.log(`versions (${mode}): product ${versions.package}, ${documents}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
