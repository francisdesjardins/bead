// ── Protovalidate differential launcher ───────────────────────────────────────

// A file Node runs as it is, its types stripped, as tools/protovalidate-differential.mjs runs it:
// it bundles the testee, whose runtime's imports name no extension, then runs it, as
// tools/protobuf-conformance/testee.ts does its own.

// dependencies

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// constants

const HERE = new URL('./', import.meta.url);
const TESTEE = new URL('dist/validations-testee.mjs', HERE);

// definition

await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL('validations-testee.ts', HERE))],
  format: 'esm',
  logLevel: 'silent',
  outfile: fileURLToPath(TESTEE),
  platform: 'node',
  target: 'node24',
});

await import(TESTEE.href);
