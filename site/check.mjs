#!/usr/bin/env node
// Holds the page to its sources, with no browser and nothing installed: each diagram's SVG opens
// with the sha256 of its source, `diagrams/<language>/<name>.mmd`, its line breaks LF, and every
// source has its SVG and every SVG its source; then the build gives the committed
// `dist/index.html` byte for byte.
//
//   node check.mjs
//
// Exit 1 on a stale or orphaned SVG, saying `node render.mjs`, or on a page the build no longer
// gives, saying `node build.mjs`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES, OUT, build } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS = join(HERE, 'diagrams');
const STAMP = /^<!-- sha256 of its source: ([0-9a-f]{64}) -->\n/u;

const read = (path) => {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
};

const problems = [];

// ── Diagrams ──────────────────────────────────────────────────────────────────

for (const language of LANGUAGES) {
  const files = readdirSync(join(DIAGRAMS, language)).sort();
  for (const file of files) {
    const name = file.replace(/\.(?:mmd|svg)$/u, '');
    const source = join(DIAGRAMS, language, `${name}.mmd`);
    const svg = join(DIAGRAMS, language, `${name}.svg`);
    if (file.endsWith('.svg') && !existsSync(source)) {
      problems.push(`${language}/${file}: no source beside it`);
    }
    if (!file.endsWith('.mmd')) {
      continue;
    }
    if (!existsSync(svg)) {
      problems.push(`${language}/${name}.mmd: no SVG; node render.mjs`);
      continue;
    }
    const stamp = STAMP.exec(read(svg));
    const hash = createHash('sha256').update(read(source), 'utf8').digest('hex');
    if (stamp === null || stamp[1] !== hash) {
      problems.push(`${language}/${name}.svg: not its source’s render; node render.mjs`);
    }
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  try {
    const page = build();
    if (!existsSync(OUT) || read(OUT) !== page) {
      problems.push('dist/index.html: not what the build gives; node build.mjs');
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`site: ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log('site: every SVG is its source’s render, and the build gives dist/index.html');
}
