#!/usr/bin/env node
// The root's own files keep the layout the TypeScript side's formatter gives them, under its
// configuration: the README to the CI, the spec's texts and schemas, the tools, the workflows. The conformance
// files are left to their generators, the interop's blueprint to spec/check.py, which holds its form
// (decision 0022), and each implementation holds its own files in its gate.
//
//   node tools/check-format.mjs            every root file this check holds
//   node tools/check-format.mjs --staged   the staged ones alone, as the pre-commit hook asks
//
// Exit 1 on a file off its format, or when the formatter is not installed (`yarn install` in
// implementations/typescript); with --staged, a clone without it commits, CI holding the check.

import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// ! CI's typescript job runs this check: a root file outside this list is held by nothing
const ROOT = [
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  '.claude/workflows',
  'docs',
  'spec/spec.md',
  'spec/debugging.md',
  'spec/interop-service.json',
  'spec/schemas',
  'tools',
  '.github',
];

const OXFMT = 'implementations/typescript/node_modules/oxfmt/bin/oxfmt';
const CONFIG = 'implementations/typescript/.oxfmtrc.json';

// ── Paths ──────────────────────────────────────────────────────────────────────

const isHeld = (path) => {
  return ROOT.some((entry) => {
    return path === entry || path.startsWith(`${entry}/`);
  });
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

const onlyStaged = process.argv.includes('--staged');
const paths = onlyStaged ? staged() : ROOT;

if (paths.length === 0) {
  process.exit(0);
}

if (!existsSync(OXFMT)) {
  console.error(`format: no ${OXFMT}; run yarn install in implementations/typescript`);
  process.exit(onlyStaged ? 0 : 1);
}

// a staged file the formatter does not read (a shell script under tools/) is no error; a root
// entry that matches nothing is
const unmatched = onlyStaged ? ['--no-error-on-unmatched-pattern'] : [];
const result = spawnSync(
  process.execPath,
  [OXFMT, '-c', CONFIG, '--check', ...unmatched, ...paths],
  {
    stdio: 'inherit',
  }
);
process.exit(result.status ?? 1);
