// ── DevTools extension, built ─────────────────────────────────────────────────

// The extension as Chrome loads it unpacked, into `devtools/dist/`: each script bundled with what it
// takes of the package, its pages, and its manifest at the package's version. Node runs it as it is,
// its types stripped, as it runs the demo's builds.

// dependencies

import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// constants

const DEVTOOLS = new URL('./', import.meta.url);
const OUT = new URL('dist/', DEVTOOLS);

/** The scripts, each a script of its own: none is a module, as a content script is none. */
const SCRIPTS = Object.freeze(['background', 'bridge', 'devtools', 'hook', 'panel']);

/** What the manifest holds in place of the package's version. */
const VERSION = '%VERSION%';

// helpers

const pathOf = (relative: string, base: URL = DEVTOOLS): string => {
  return fileURLToPath(new URL(relative, base));
};

// definition

// what an earlier build left would load with this one
await rm(OUT, { force: true, recursive: true });
await mkdir(OUT, { recursive: true });

await build({
  bundle: true,
  entryPoints: SCRIPTS.map((name) => {
    return pathOf(`${name}.ts`);
  }),
  format: 'iife',
  outdir: fileURLToPath(OUT),
  platform: 'browser',
  target: 'chrome111',
});

const { version } = JSON.parse(await readFile(pathOf('../package.json'), 'utf8')) as {
  version: string;
};
const manifest = await readFile(pathOf('manifest.json'), 'utf8');

// a manifest that no longer leaves its version to this build would ship another one's
if (!manifest.includes(VERSION)) {
  throw new Error(`devtools/manifest.json no longer carries ${VERSION}`);
}

await writeFile(pathOf('manifest.json', OUT), manifest.replace(VERSION, version));
await Promise.all(
  ['devtools.html', 'panel.html'].map((page) => {
    return copyFile(pathOf(page), pathOf(page, OUT));
  })
);
