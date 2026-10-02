// ── Demo playground ───────────────────────────────────────────────────────────

// The demo as a static host takes it: the page, its worker and its HTML in one folder, every path
// relative, so it is served under any path. It starts nothing — the page's server is its worker —
// and, like `serve.ts`, Node runs it as it is, its types stripped, importing packages and `node:`
// modules alone.
//
// The scripts are named by their content, as a bundler names its assets: a host keeps a script
// hours without asking again, and a script of the same name from an earlier build would run
// under the page of this one. The HTML, which a host asks again each time, names them.

// dependencies

import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// constants

const DEMO = new URL('./', import.meta.url);
const OUT = new URL('dist/playground/', DEMO);

/** What the server fills in for its page, and what a page with no server says instead. */
const SERVED = 'data-bead-pathname="%BEAD_PATHNAME%"';
const STATIC = 'data-bead-transport="worker"';

/** How the page loads its script, which this build names. */
const SCRIPT = 'src="./page.js"';

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
const page = await readFile(pathOf('index.html'), 'utf8');

// a page that no longer says where its server is, or loads its script otherwise, would ask what is
// not there
for (const expected of [SERVED, SCRIPT]) {
  if (!page.includes(expected)) {
    throw new Error(`demo/index.html no longer carries ${expected}`);
  }
}

await writeFile(
  pathOf('index.html', OUT),
  page
    .replace(SERVED, `${STATIC} data-bead-worker="${String(workerFile)}"`)
    .replace(SCRIPT, `src="./${String(pageFile)}"`)
);
