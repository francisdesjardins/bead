#!/usr/bin/env node
// ── What reads beadc.yaml touches no platform ─────────────────────────────────
// A page builds its `beadc.yaml` in a browser with the builder's own code: the selection of
// procedures (`src/model/selection.ts`) and the reading of `beadc.yaml` (`src/config.ts`), with the
// finding a refusal throws. This walks their imports, the relative ones to the end, and fails on
// any that reaches the platform (`node:` and every package but those `ALLOWED` names), with the
// chain that brought it in. A type-only import (`import type`, `export type`) is erased, so it
// passes; `import { type X }` is kept as an import of its module, so it does not.
//
// Usage, from builder/; `yarn check` runs it:
//   node tools/check-pure.mjs

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ROOT = process.cwd();

/** The modules a page takes, and everything they import. */
const ENTRIES = ['src/config.ts', 'src/model/selection.ts'];

/** The packages a page bundles with them: plain JavaScript, no platform. */
const ALLOWED = new Set(['yaml']);

// every `import … from '…'`, `export … from '…'` and `import '…'`, type-only ones marked
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?'([^']+)'/gmu;
const DYNAMIC = /\bimport\(\s*'([^']+)'\s*\)/gu;

const from = new Map();
const refusals = [];

const chainOf = (file) => {
  const chain = [];

  for (let at = file; at !== undefined; at = from.get(at)) {
    chain.unshift(relative(ROOT, at).replaceAll('\\', '/'));
  }

  return chain.join(' → ');
};

const walk = (file, parent) => {
  if (from.has(file)) {
    return;
  }

  from.set(file, parent);

  const text = readFileSync(file, 'utf8');
  const specifiers = [
    ...[...text.matchAll(IMPORT)]
      .filter((match) => {
        return match[1] === undefined;
      })
      .map((match) => {
        return match[2];
      }),
    ...[...text.matchAll(DYNAMIC)].map((match) => {
      return match[1];
    }),
  ];

  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      walk(resolve(dirname(file), specifier), file);
    } else if (!ALLOWED.has(specifier)) {
      refusals.push(`${chainOf(file)} imports ${specifier}`);
    }
  }
};

for (const entry of ENTRIES) {
  walk(resolve(ROOT, entry), undefined);
}

if (refusals.length > 0) {
  for (const refusal of refusals) {
    console.error(`check-pure: ${refusal}`);
  }

  console.error(
    'check-pure: what reads beadc.yaml runs in a page too; move what needs the platform beside it (config-files.ts, format-diagnostic.ts)'
  );
  process.exit(1);
}

console.log(`check-pure: ${String(from.size)} modules, none reaching the platform`);
