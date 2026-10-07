#!/usr/bin/env node
// ── The options' generated code is what its generator writes ─────────────────
// `src/generated/bead/options_pb.ts` is committed, and the front end reads a .proto's options
// through it; it is left out of the formatter and the lint, which judge code the builder writes. So
// this writes it again, apart, from `buf.gen.yaml` and `proto/bead/options.proto`, and fails on any
// difference: a file edited by hand, or the options or the generator moved without it.
//
// Usage, from builder/; `yarn check` runs the first:
//   node tools/check-options.mjs           # check (exit 1 on a difference)
//   node tools/check-options.mjs --write   # write it in place

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const BUF = join(ROOT, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf');
const GENERATED = 'src/generated/bead/options_pb.ts';

const WRITE = process.argv.includes('--write');

/** Runs buf's `generate` from the builder's folder, its output under `into` when given. */
function generate(into) {
  execFileSync(process.execPath, [BUF, 'generate', ...(into === undefined ? [] : ['-o', into])], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

if (WRITE) {
  generate(undefined);
  process.exit(0);
}

const apart = mkdtempSync(join(tmpdir(), 'beadc-options-'));

try {
  generate(apart);

  const written = readFileSync(join(apart, GENERATED));
  const committed = readFileSync(join(ROOT, GENERATED));

  if (!written.equals(committed)) {
    console.error(
      `check-options: ${GENERATED} differs from what buf.gen.yaml writes; run \`yarn options:generate\``
    );
    process.exit(1);
  }

  console.log(`check-options: ${GENERATED} is what buf.gen.yaml writes`);
} finally {
  rmSync(apart, { force: true, recursive: true });
}
