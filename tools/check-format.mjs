#!/usr/bin/env node
// The root's own files keep the layout the TypeScript side's formatter gives them, under its
// configuration: the README to the CI, the spec's texts and schemas, the tools, the workflows. The
// conformance files are left to their generators, the interop's blueprint to spec/check.py, which
// holds its form (decision 0022), what beadc generates to beadc; each implementation, the builder
// and each half of an example hold their own files in their gate. The CHANGELOG is held up to its
// first released section: a released one stays as its tag shipped it.
//
//   node tools/check-format.mjs            every root file this check holds
//   node tools/check-format.mjs --staged   the staged ones alone, as the pre-commit hook asks
//
// Exit 1 on a file off its format, or when the formatter is not installed (`yarn install` in
// implementations/typescript); with --staged, a clone without it commits, CI holding the check.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// ! CI's typescript job runs this check: a root file outside this list is held by nothing
const ROOT = [
  'README.md',
  'SECURITY.md',
  'CLAUDE.md',
  'beadc.yaml',
  'implementations/dotnet/README.md',
  'examples/hello/README.md',
  'examples/hello/beadc.yaml',
  'examples/hello/buf.yaml',
  'examples/hello/pairs.mjs',
  '.claude/workflows',
  'docs',
  'spec/spec.md',
  'spec/debugging.md',
  'spec/transcoding.md',
  'spec/interop-service.json',
  'spec/schemas',
  'tools',
  '.github',
];

const OXFMT = 'implementations/typescript/node_modules/oxfmt/bin/oxfmt';
const CONFIG = 'implementations/typescript/.oxfmtrc.json';

// ! the CHANGELOG is held up to its first released section alone: a released section stays as its
// tag shipped it (tools/check-versions.mjs), which a formatter that changes how it lays a list out
// may not rewrite
const CHANGELOG = 'CHANGELOG.md';

// ── Paths ──────────────────────────────────────────────────────────────────────

const isHeld = (path) => {
  return (
    path === CHANGELOG ||
    ROOT.some((entry) => {
      return path === entry || path.startsWith(`${entry}/`);
    })
  );
};

// the staged files this check holds; a deleted one has nothing left to lay out
const staged = () => {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => {
      return path !== '' && isHeld(path);
    });
};

// ── Check ──────────────────────────────────────────────────────────────────────

// the CHANGELOG as far as its first released section, whose heading opens `## [x.y.z]`
const unreleasedOf = (text) => {
  const at = text.search(/^## \[\d/mu);

  return at === -1 ? text : text.slice(0, at);
};

const onlyStaged = process.argv.includes('--staged');
const held = onlyStaged ? staged() : [...ROOT, CHANGELOG];
const paths = held.filter((path) => {
  return path !== CHANGELOG;
});

if (held.length === 0) {
  process.exit(0);
}

if (!existsSync(OXFMT)) {
  console.error(`format: no ${OXFMT}; run yarn install in implementations/typescript`);
  process.exit(onlyStaged ? 0 : 1);
}

// a staged file the formatter does not read (a shell script under tools/) is no error; a root
// entry that matches nothing is
const unmatched = onlyStaged ? ['--no-error-on-unmatched-pattern'] : [];
const result =
  paths.length === 0
    ? { status: 0 }
    : spawnSync(process.execPath, [OXFMT, '-c', CONFIG, '--check', ...unmatched, ...paths], {
        stdio: 'inherit',
      });
let status = result.status ?? 1;

if (held.includes(CHANGELOG)) {
  const unreleased = unreleasedOf(readFileSync(CHANGELOG, 'utf8'));
  const laid = spawnSync(process.execPath, [OXFMT, '-c', CONFIG, '--stdin-filepath', CHANGELOG], {
    encoding: 'utf8',
    input: unreleased,
  });

  if (laid.status !== 0 || laid.stdout.trimEnd() !== unreleased.trimEnd()) {
    console.error(`format: ${CHANGELOG} is off its format before its first released section`);
    status = 1;
  }
}

process.exit(status);
