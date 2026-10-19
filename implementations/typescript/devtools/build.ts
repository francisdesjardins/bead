// ── DevTools extension, built ─────────────────────────────────────────────────

// The extension as Chrome loads it unpacked, into `devtools/dist/`: each script bundled with what it
// takes of the package, its pages, and its manifest at the package's version. The hook and the panel
// are every browser's; the rest, Chrome's own glue, is in `chrome/`. Node runs it as it is, its
// types stripped, as it runs the demo's builds.

// dependencies

import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// constants

const DEVTOOLS = new URL('./', import.meta.url);
const OUT = new URL('dist/', DEVTOOLS);

/**
 * The scripts, each a script of its own, by the name the manifest and the pages load it by: none is a
 * module, as a content script is none.
 */
const SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  background: 'chrome/background.ts',
  bridge: 'chrome/bridge.ts',
  devtools: 'chrome/devtools.ts',
  hook: 'hook.ts',
  panel: 'chrome/panel.ts',
});

/** The pages, each where the build leaves it. */
const PAGES: Readonly<Record<string, string>> = Object.freeze({
  'devtools.html': 'chrome/devtools.html',
  'panel.html': 'panel.html',
});

/** Penumbra's two sheets, which the panel links under its own skin. */
const STYLES: readonly string[] = Object.freeze([
  'penumbra/tokens.skin.base.css',
  'penumbra/tokens.system.css',
]);

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
  entryPoints: Object.entries(SCRIPTS).map(([name, path]) => {
    return { in: pathOf(path), out: name };
  }),
  format: 'iife',
  outdir: fileURLToPath(OUT),
  platform: 'browser',
  target: 'chrome111',
});

const { version } = JSON.parse(await readFile(pathOf('../package.json'), 'utf8')) as {
  version: string;
};
const manifest = await readFile(pathOf('chrome/manifest.json'), 'utf8');

// a manifest that no longer leaves its version to this build would hold another one's
if (!manifest.includes(VERSION)) {
  throw new Error(`devtools/chrome/manifest.json no longer carries ${VERSION}`);
}

await writeFile(pathOf('manifest.json', OUT), manifest.replace(VERSION, version));
await Promise.all(
  Object.entries(PAGES).map(([page, path]) => {
    return copyFile(pathOf(path), pathOf(page, OUT));
  })
);

await mkdir(new URL('penumbra/', OUT), { recursive: true });
await Promise.all(
  STYLES.map((path) => {
    return copyFile(pathOf(path), pathOf(path, OUT));
  })
);
