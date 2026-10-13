// ── Protobuf conformance launcher ─────────────────────────────────────────────

// A file Node runs as it is, its types stripped, as tools/protobuf-conformance.mjs runs it: it
// bundles the testee, whose runtime's imports name no extension, then runs it, as interop/serve.ts
// does the interop server.

// dependencies

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// constants

const HERE = new URL('./', import.meta.url);
const TESTEE = new URL('dist/conformance-testee.mjs', HERE);

// definition

await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL('conformance-testee.ts', HERE))],
  format: 'esm',
  logLevel: 'silent',
  outfile: fileURLToPath(TESTEE),
  platform: 'node',
  target: 'node24',
});

await import(TESTEE.href);
