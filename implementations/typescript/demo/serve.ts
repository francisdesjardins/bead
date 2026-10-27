// ── Demo launcher ─────────────────────────────────────────────────────────────

// A file Node runs as it is, its types stripped, as `playground.ts` is: it imports packages and
// `node:` modules alone, so it needs no bundler to start the one that builds the rest.

// dependencies

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// constants

const DEMO = new URL('./', import.meta.url);
const SERVER = new URL('dist/server.mjs', DEMO);

// helpers

const pathOf = (relative: string): string => {
  return fileURLToPath(new URL(relative, DEMO));
};

// definition

// the page, for a browser, and what it loads over MQTT 5 apart; the server, for Node, `ws` and `mqtt`
// left to the package that has them
await Promise.all([
  build({
    bundle: true,
    entryPoints: [pathOf('page.ts')],
    format: 'esm',
    outfile: pathOf('dist/page.js'),
    platform: 'browser',
    sourcemap: 'inline',
    target: 'es2022',
  }),
  // the page's client over MQTT 5, for `?transport=mqtt`, which a page served as files never loads
  build({
    bundle: true,
    entryPoints: [pathOf('over-mqtt.ts')],
    format: 'esm',
    outfile: pathOf('dist/over-mqtt.js'),
    platform: 'browser',
    sourcemap: 'inline',
    target: 'es2022',
  }),
  // the page's own server, for `?transport=worker`
  build({
    bundle: true,
    entryPoints: [pathOf('worker.ts')],
    format: 'esm',
    outfile: pathOf('dist/worker.js'),
    platform: 'browser',
    sourcemap: 'inline',
    target: 'es2022',
  }),
  build({
    bundle: true,
    entryPoints: [pathOf('server.ts')],
    external: ['mqtt', 'ws'],
    format: 'esm',
    outfile: fileURLToPath(SERVER),
    platform: 'node',
    target: 'node24',
  }),
]);

await import(SERVER.href);
