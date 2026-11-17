#!/usr/bin/env node
// Rasterizes Bead's mark, `src/favicon.svg`, in a headless Chromium: the favicon's fallback,
// `src/favicon.ico`, a PNG of 16 and one of 32 pixels in one ICO; the touch icon,
// `src/apple-touch-icon.png`, 180 pixels on the page's paper, opaque, the mark in its light scheme;
// and the DevTools extension's icons, `implementations/typescript/devtools/chrome/icons/icon-<size>.png`,
// 16, 32, 48 and 128. A PNG cannot follow a scheme, so every icon on no ground of its own takes the
// mark's dark one, its disc ringed, which reads on a light ground and a dark. `src/icons.json` records the sha256 of the mark and of each
// file written from it, which `check.mjs` compares without a browser.
//
//   node icons.mjs                       every icon
//   node icons.mjs --chromium <path>     the Chromium to drive, else Playwright's own
//
// Exit 1 on a mark Chromium does not draw.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const MARK = join(HERE, 'src', 'favicon.svg');
export const RECORD = join(HERE, 'src', 'icons.json');

// the page's paper, `--app-paper` in `src/styles.css`: a touch icon has no transparency to show
const PAPER = '#fdfcfe';

// each file the mark gives, from the repository's root: its sizes, and whether it lies on the paper,
// in the mark's light scheme, or on nothing, in its dark one
export const ICONS = Object.freeze({
  'site/src/favicon.ico': { sizes: [16, 32], ico: true },
  'site/src/apple-touch-icon.png': { sizes: [180], paper: true },
  'implementations/typescript/devtools/chrome/icons/icon-16.png': { sizes: [16] },
  'implementations/typescript/devtools/chrome/icons/icon-32.png': { sizes: [32] },
  'implementations/typescript/devtools/chrome/icons/icon-48.png': { sizes: [48] },
  'implementations/typescript/devtools/chrome/icons/icon-128.png': { sizes: [128] },
});

// a file's sha256, its bytes as they are
export const hashOf = (bytes) => {
  return createHash('sha256').update(bytes).digest('hex');
};

// the mark as the record hashes it: its line breaks LF, whatever a checkout gave it
export const markBytes = () => {
  return Buffer.from(readFileSync(MARK, 'utf8').replaceAll('\r\n', '\n'), 'utf8');
};

// PNGs in one ICO: its header, a directory entry for each, then each PNG whole
const icoOf = (images) => {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    // ! a size of 256 is written 0, as the format has it; none here reaches it
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([
    header,
    ...images.map(({ png }) => {
      return png;
    }),
  ]);
};

const main = async () => {
  const { values } = parseArgs({ options: { chromium: { type: 'string' } } });
  const mark = markBytes();
  const source = `data:image/svg+xml;base64,${mark.toString('base64')}`;
  // * loaded here, not imported: check.mjs reads this module's record with nothing installed
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch(
    values.chromium === undefined ? {} : { executablePath: values.chromium }
  );
  try {
    const pages = {
      light: await browser.newPage({ colorScheme: 'light', deviceScaleFactor: 1 }),
      dark: await browser.newPage({ colorScheme: 'dark', deviceScaleFactor: 1 }),
    };
    const draw = async (size, paper) => {
      const page = paper ? pages.light : pages.dark;
      await page.setViewportSize({ width: size, height: size });
      // the touch icon's mark keeps a margin, as the platforms round its corners
      const inset = paper ? Math.round(size * 0.14) : 0;
      await page.setContent(
        `<style>html,body{margin:0;background:${paper ? PAPER : 'transparent'}}img{display:block;margin:${inset}px}</style>` +
          `<img src="${source}" width="${size - 2 * inset}" height="${size - 2 * inset}" alt="">`
      );
      const drawn = await page.locator('img').evaluate((image) => {
        return image.decode().then(
          () => {
            return image.naturalWidth > 0;
          },
          () => {
            return false;
          }
        );
      });
      if (!drawn) {
        throw new Error('icons: Chromium does not draw src/favicon.svg');
      }
      return page.screenshot({ omitBackground: !paper, type: 'png' });
    };
    const files = {};
    for (const [file, { sizes, ico, paper }] of Object.entries(ICONS)) {
      const images = [];
      for (const size of sizes) {
        images.push({ size, png: await draw(size, paper === true) });
      }
      const bytes = ico === true ? icoOf(images) : images[0].png;
      mkdirSync(dirname(join(ROOT, file)), { recursive: true });
      writeFileSync(join(ROOT, file), bytes);
      files[file] = hashOf(bytes);
      console.log(`icons: ${file}, ${bytes.length} bytes`);
    }
    writeFileSync(RECORD, `${JSON.stringify({ mark: hashOf(mark), files }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
