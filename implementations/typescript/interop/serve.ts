// ── Interop launcher ──────────────────────────────────────────────────────────

// A file Node runs as it is, its types stripped: it bundles the interop server, whose imports name
// no extension, then runs it, its arguments passed on.

// dependencies

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// constants

const INTEROP = new URL('./', import.meta.url);
// Each fixture process imports its own bundle while other fixtures build theirs.
const SERVER = new URL(`dist/interop-server-${process.pid}.mjs`, INTEROP);

// definition

// `ws` is left to the package that has it
await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL('interop-server.ts', INTEROP))],
  external: ['ws'],
  format: 'esm',
  logLevel: 'silent',
  outfile: fileURLToPath(SERVER),
  platform: 'node',
  target: 'node24',
});

await import(SERVER.href);
