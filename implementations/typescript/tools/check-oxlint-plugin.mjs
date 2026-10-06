#!/usr/bin/env node
// ── `bead/options-last` refuses exactly what its cases mark ──────────────────
// Lints `oxlint-plugin.cases.ts` through the package's configuration, by way of
// `oxlint-plugin.cases.oxlintrc.json`, and fails unless the lines `bead/options-last` refuses, at
// `error`, are exactly the lines its cases mark: a refusal lost, or one where none is marked. A
// floor of marks keeps a cases file emptied of them from passing.
//
// Usage, from the package's folder; `yarn check` runs it as `yarn lint:cases`:
//   node tools/check-oxlint-plugin.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CASES = 'tools/oxlint-plugin.cases.ts';
const CONFIG = 'tools/oxlint-plugin.cases.oxlintrc.json';
const RULE = 'bead(options-last)';
const FLOOR = 30;

/** The lines the cases mark refused: each the line below a `// refused:` comment of its own. */
function markedLines(source) {
  const marked = new Set();
  source.split('\n').forEach((line, index) => {
    if (/^\s*\/\/ refused:/.test(line)) {
      marked.add(index + 2);
    }
  });
  return marked;
}

/**
 * oxlint's report on the cases, as JSON. It exits 1 on what it refuses, so a failed run is read
 * too; one that never started throws, rather than reading as a clean lint.
 */
function lint() {
  // through Node, as `check-examples.mjs` runs it: the `.bin` entry is a shell shim
  const args = [
    join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint'),
    '-c',
    CONFIG,
    '--disable-nested-config',
    '-f',
    'json',
    CASES,
  ];
  let output;
  try {
    output = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (typeof error.status !== 'number') {
      throw error;
    }
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const start = output.indexOf('{');
  if (start === -1) {
    console.error(`check-oxlint-plugin: oxlint reported no JSON:\n${output}`);
    process.exit(1);
  }
  return JSON.parse(output.slice(start));
}

const marked = markedLines(readFileSync(join(ROOT, CASES), 'utf8'));
const { diagnostics = [], number_of_files: linted } = lint();
const refusals = diagnostics.filter((diagnostic) => {
  return diagnostic.code === RULE;
});
const refused = new Map(
  refusals.map((diagnostic) => {
    return [diagnostic.labels?.[0]?.span?.line, diagnostic.message];
  })
);

const failures = [];
if (linted !== 1) {
  failures.push(
    `oxlint linted ${String(linted)} files where the cases are one: the check is not running`
  );
}
if (marked.size < FLOOR) {
  failures.push(
    `the cases mark ${String(marked.size)} lines, under the floor of ${String(FLOOR)}, so a pass here would mean nothing`
  );
}
const severities = new Set(
  refusals.map((diagnostic) => {
    return diagnostic.severity;
  })
);
for (const severity of severities) {
  if (severity !== 'error') {
    failures.push(`${RULE} reports at ${String(severity)}, where the lint holds it at error`);
  }
}
for (const line of marked) {
  if (!refused.has(line)) {
    failures.push(`${CASES}:${String(line)} — marked refused, and accepted`);
  }
}
for (const [line, message] of refused) {
  if (!marked.has(line)) {
    failures.push(`${CASES}:${String(line)} — refused, and not marked: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(`check-oxlint-plugin: ${String(failures.length)} failure(s).`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `check-oxlint-plugin: ${RULE} refuses the ${String(marked.size)} lines its cases mark, and no other`
);
