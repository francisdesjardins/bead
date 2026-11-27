#!/usr/bin/env node
// ── The plugin's rules refuse exactly what their cases mark ──────────────────
// Lints each rule's cases through the package's configuration, by way of the cases' own
// configuration, and fails unless the lines the rule refuses, at `error`, are exactly the lines its
// cases mark: a refusal lost, or one where none is marked. A floor of marks keeps a cases file
// emptied of them from passing. `bead/wire-literal` must also fail the lint when a module it holds
// is missing, or when it holds none, rather than pass it.
//
// Usage, from the package's folder; `yarn check` runs it as `yarn lint:cases`:
//   node tools/check-oxlint-plugin.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableModulesOf, wireModulesOf } from './oxlint-plugin.mjs';

const ROOT = process.cwd();

/** Each rule, its cases, the configuration they are linted through, and the floor of their marks. */
const RULES = Object.freeze([
  {
    cases: 'tools/oxlint-plugin.cases.ts',
    config: 'tools/oxlint-plugin.cases.oxlintrc.json',
    floor: 30,
    rule: 'bead(options-last)',
  },
  {
    cases: 'tools/wire-literal.cases.ts',
    config: 'tools/wire-literal.cases.oxlintrc.json',
    floor: 20,
    rule: 'bead(wire-literal)',
  },
]);

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
function lint({ cases, config }) {
  // through Node, as `check-examples.mjs` runs it: the `.bin` entry is a shell shim
  const args = [
    join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint'),
    '-c',
    config,
    '--disable-nested-config',
    '-f',
    'json',
    cases,
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

/** What fails in one rule's verdicts on its cases, and how many lines they mark. */
function verdictOf({ cases, config, floor, rule }) {
  const marked = markedLines(readFileSync(join(ROOT, cases), 'utf8'));
  const { diagnostics = [], number_of_files: linted } = lint({ cases, config });
  const refusals = diagnostics.filter((diagnostic) => {
    return diagnostic.code === rule;
  });
  const refused = new Map(
    refusals.map((diagnostic) => {
      return [diagnostic.labels?.[0]?.span?.line, diagnostic.message];
    })
  );

  const failures = [];
  if (linted !== 1) {
    failures.push(
      `${rule}: oxlint linted ${String(linted)} files where the cases are one: the check is not running`
    );
  }
  if (marked.size < floor) {
    failures.push(
      `${rule}: the cases mark ${String(marked.size)} lines, under the floor of ${String(floor)}, so a pass here would mean nothing`
    );
  }
  const severities = new Set(
    refusals.map((diagnostic) => {
      return diagnostic.severity;
    })
  );
  for (const severity of severities) {
    if (severity !== 'error') {
      failures.push(`${rule} reports at ${String(severity)}, where the lint holds it at error`);
    }
  }
  for (const line of marked) {
    if (!refused.has(line)) {
      failures.push(`${cases}:${String(line)} — marked refused, and accepted`);
    }
  }
  for (const [line, message] of refused) {
    if (!marked.has(line)) {
      failures.push(`${cases}:${String(line)} — refused, and not marked: ${message}`);
    }
  }
  return { failures, marks: marked.size, rule };
}

/** Whether `wireModulesOf` throws, as the rule must on what would leave it holding nothing. */
function throws(options) {
  try {
    wireModulesOf(options);
  } catch {
    return true;
  }
  return false;
}

/** What fails in how `bead/wire-literal` reads its modules, the table's grammar among it. */
function moduleFailures() {
  const failures = [];
  const row = (cell) => {
    return ['websocket', 'FIN_BIT', 'RFC 6455 §5.2', '0x80', cell, '-: none', '-: none'].join('\t');
  };
  const read = tableModulesOf(
    [
      '# format\tconcept\tstandard\tvalue\ttypescript\tcsharp\trust',
      row('implementations/typescript/a.ts'),
      row('implementations/typescript/a.ts#Holder.MEMBER, implementations/typescript/b.ts'),
      row('-: a reason, with a comma, and implementations/typescript/c.ts'),
      '',
    ].join('\n')
  );
  if (read.join(' ') !== 'implementations/typescript/a.ts implementations/typescript/b.ts') {
    failures.push(`bead(wire-literal): a table's TypeScript column reads as ${read.join(', ')}`);
  }
  if (!throws({ modules: ['tools/no-such-module.ts'] })) {
    failures.push('bead(wire-literal): a module missing passes, where it must fail the lint');
  }
  if (!throws({ modules: [] })) {
    failures.push('bead(wire-literal): no module at all passes, where it must fail the lint');
  }
  if (!throws({ table: 'tools/no-such-table.tsv' })) {
    failures.push('bead(wire-literal): a table missing passes, where it must fail the lint');
  }
  if (throws({})) {
    failures.push("bead(wire-literal): the root's table names a module that is missing");
  }
  return failures;
}

const verdicts = RULES.map(verdictOf);
const failures = [
  ...verdicts.flatMap((verdict) => {
    return verdict.failures;
  }),
  ...moduleFailures(),
];

if (failures.length > 0) {
  console.error(`check-oxlint-plugin: ${String(failures.length)} failure(s).`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

for (const { marks, rule } of verdicts) {
  console.log(
    `check-oxlint-plugin: ${rule} refuses the ${String(marks)} lines its cases mark, and no other`
  );
}
