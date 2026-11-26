// ── Demo playground ───────────────────────────────────────────────────────────

// The demo as a static host takes it: the page, its worker and its HTML in one folder, every path
// relative, so it is served under any path. Its faces alone it asks at `/fonts/`, where
// beadproto.dev serves the page's: a copy of them in `fonts/` serves a host of this folder at its
// root, and the deploy leaves it out. It starts nothing — the page's server is its worker — and,
// like `serve.ts`, Node runs it as it is, its types stripped, importing packages and `node:` modules
// alone.
//
// The scripts are named by their content, as a bundler names its assets: a host keeps a script
// hours without asking again, and a script of the same name from an earlier build would run
// under the page of this one. The HTML, which a host asks again each time, names them.

// dependencies

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// constants

const DEMO = new URL('./', import.meta.url);

/**
 * The package's folder, where the page's `yaml` is found: the Packages tab's and the builder's
 * `config.ts`'s alike, one copy, whether `builder/` has its own installed or not.
 */
const PACKAGE = fileURLToPath(new URL('../', DEMO));

const OUT = new URL('dist/playground/', DEMO);

/** What the server fills in for its page, and what a page with no server says instead. */
const SERVED = 'data-bead-pathname="%BEAD_PATHNAME%"';
const STATIC = 'data-bead-transport="worker"';

/** How the page loads its script, which this build names. */
const SCRIPT = 'src="./page.js"';

/** How the page loads its theme before the first paint: a classic script, which this build names. */
const THEME = '<script src="skin/theme.js"></script>';

/** The page's faces, which the folder holds where a host of it at its root serves them. */
const FONTS = new URL('../../../site/src/fonts/', DEMO);

/** The skin's two base sheets, which the DevTools panel links too, Bead's overrides of them, Bead's
 * skin and Bead's top bar, which the page links under its own styles. */
const SHEETS: readonly string[] = Object.freeze([
  'skin/tokens.system.css',
  'skin/tokens.skin.base.css',
  'skin/tokens.system.overrides.css',
  'skin/tokens.skin.css',
  'skin/chrome.css',
]);

// helpers

const pathOf = (relative: string, base: URL = DEMO): string => {
  return fileURLToPath(new URL(relative, base));
};

// definition

// what an earlier build left would be published with this one
await rm(OUT, { force: true, recursive: true });
await mkdir(OUT, { recursive: true });

// the page and its worker, as `serve.ts` builds them, made small — nothing here is debugged — and
// each named by its content; the name of each, as it was written
const [pageFile, workerFile] = await Promise.all(
  ['page', 'worker'].map(async (name) => {
    const { metafile } = await build({
      absWorkingDir: PACKAGE,
      alias: { yaml: 'yaml' },
      bundle: true,
      entryNames: '[name]-[hash]',
      entryPoints: [pathOf(`${name}.ts`)],
      format: 'esm',
      metafile: true,
      minify: true,
      outdir: fileURLToPath(OUT),
      platform: 'browser',
      target: 'es2022',
    });
    const [written] = Object.keys(metafile.outputs);

    if (written === undefined) {
      throw new Error(`esbuild wrote nothing for ${name}.ts`);
    }

    return written.split('/').at(-1) ?? written;
  })
);

// * the theme's script as it is, no module, so it runs where the head names it, before the first
// paint; named by its content, as the page's are
const { metafile: themed } = await build({
  entryNames: '[name]-[hash]',
  entryPoints: [pathOf('../skin/theme.js')],
  format: 'iife',
  metafile: true,
  minify: true,
  outdir: fileURLToPath(OUT),
  platform: 'browser',
  target: 'es2022',
});
const themeFile = Object.keys(themed.outputs)[0]?.split('/').at(-1);

if (themeFile === undefined) {
  throw new Error('esbuild wrote nothing for theme.js');
}

await cp(FONTS, new URL('fonts/', OUT), { recursive: true });

const page = await readFile(pathOf('index.html'), 'utf8');

// a sheet as the page links it
const linkOf = (sheet: string): string => {
  return `<link rel="stylesheet" href="${sheet}" />`;
};

// a page that no longer says where its server is, or loads its script or its sheets otherwise,
// would ask what is not there
for (const expected of [SERVED, SCRIPT, THEME, ...SHEETS.map(linkOf)]) {
  if (!page.includes(expected)) {
    throw new Error(`demo/index.html no longer carries ${expected}`);
  }
}

// * the sheets written into the page: the folder a host publishes stays the page and its scripts
const sheets = await Promise.all(
  SHEETS.map(async (sheet) => {
    return { link: linkOf(sheet), text: await readFile(pathOf(`../${sheet}`), 'utf8') };
  })
);
const sheeted = sheets.reduce((written, { link, text }) => {
  return written.replace(link, () => {
    return `<style>\n${text}</style>`;
  });
}, page);

await writeFile(
  pathOf('index.html', OUT),
  sheeted
    .replace(SERVED, `${STATIC} data-bead-worker="${String(workerFile)}"`)
    .replace(SCRIPT, `src="./${String(pageFile)}"`)
    .replace(THEME, `<script src="./${themeFile}"></script>`)
);
