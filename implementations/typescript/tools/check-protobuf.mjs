#!/usr/bin/env node
// ── The generated protobuf code is what its generator writes ─────────────────
// `src/router/shared/__tests__/codecs_pb.ts` is committed, as a consumer's generated code is, and
// left out of the formatter, the lint and the comment budget, which judge code this package writes.
// So this writes it again, apart, from `buf.gen.yaml` and `spec/codecs.proto`, and fails on any
// difference: a file edited by hand, or a `.proto` or a generator moved without it.
//
// Usage, from the package's folder; `yarn check` runs the first:
//   node tools/check-protobuf.mjs           # check (exit 1 on a difference)
//   node tools/check-protobuf.mjs --write   # write it in place

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const BUF = join(ROOT, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf');
const GENERATED = 'src/router/shared/__tests__/codecs_pb.ts';

const WRITE = process.argv.includes('--write');

/** Runs buf's `generate` from the package's folder, its output under `into` when given. */
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

const apart = mkdtempSync(join(tmpdir(), 'bead-protobuf-'));

try {
  generate(apart);

  const written = readFileSync(join(apart, GENERATED));
  const committed = readFileSync(join(ROOT, GENERATED));

  if (!written.equals(committed)) {
    console.error(
      `check-protobuf: ${GENERATED} differs from what buf.gen.yaml writes; run \`yarn protobuf:generate\``
    );
    process.exit(1);
  }

  console.log(`check-protobuf: ${GENERATED} is what buf.gen.yaml writes`);
} finally {
  rmSync(apart, { force: true, recursive: true });
}
