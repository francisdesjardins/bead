#!/usr/bin/env node
// Renders each diagram of the page, `diagrams/<language>/<name>.mmd`, into the SVG beside it, by
// Mermaid in a headless Chromium: one SVG that follows both themes. Mermaid draws with sentinel
// colours, distinct values nothing else uses, through its `base` theme's variables; each sentinel is
// then replaced by the page's token, `var(--diagram-…)`, so the same SVG reads in the light scheme
// and the dark one. Each SVG opens with the sha256 of its source, its line breaks LF, which
// `check.mjs` compares without a browser.
//
//   node render.mjs                       the diagrams whose SVG is missing or stale
//   node render.mjs --all                 every diagram
//   node render.mjs --chromium <path>     the Chromium to drive, else Playwright's own
//   node render.mjs --fonts <folder>      geist.woff2, geist-mono.woff2 and newsreader.woff2, the
//                                         faces the site serves at /fonts/, so labels are measured
//                                         in the face the page draws them with
//
// Exit 1 on a diagram Mermaid refuses, or on a colour left in an SVG that is not a token.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS = join(HERE, 'diagrams');
const LANGUAGES = ['en', 'fr'];
const MERMAID = join(HERE, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');

// ── Colours ───────────────────────────────────────────────────────────────────

// ! each sentinel appears nowhere else, in no diagram's source and in no colour Mermaid derives:
// the scan below fails on any colour left that is not one of these, once replaced
export const SENTINELS = Object.freeze({
  '#0b0101': '--diagram-surface',
  '#0b0102': '--diagram-node',
  '#0b0103': '--diagram-node-line',
  '#0b0104': '--diagram-ink',
  '#0b0105': '--diagram-edge',
  '#0b0106': '--diagram-note',
  '#0b0107': '--diagram-note-line',
  '#0b0108': '--diagram-cluster',
  '#0b0109': '--diagram-cluster-line',
  '#0b010a': '--diagram-actor',
  '#0b010b': '--diagram-actor-line',
});

const sentinelOf = (token) => {
  return Object.keys(SENTINELS).find((hex) => {
    return SENTINELS[hex] === token;
  });
};

const FONT = "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";

// every variable of the base theme a flowchart or a sequence diagram reads, set, so that Mermaid
// derives none
const themeVariables = () => {
  const surface = sentinelOf('--diagram-surface');
  const node = sentinelOf('--diagram-node');
  const nodeLine = sentinelOf('--diagram-node-line');
  const ink = sentinelOf('--diagram-ink');
  const edge = sentinelOf('--diagram-edge');
  const note = sentinelOf('--diagram-note');
  const noteLine = sentinelOf('--diagram-note-line');
  const cluster = sentinelOf('--diagram-cluster');
  const clusterLine = sentinelOf('--diagram-cluster-line');
  const actor = sentinelOf('--diagram-actor');
  const actorLine = sentinelOf('--diagram-actor-line');

  return {
    fontFamily: FONT,
    fontSize: '14px',
    background: surface,
    primaryColor: node,
    primaryBorderColor: nodeLine,
    primaryTextColor: ink,
    secondaryColor: cluster,
    secondaryBorderColor: clusterLine,
    secondaryTextColor: ink,
    tertiaryColor: cluster,
    tertiaryBorderColor: clusterLine,
    tertiaryTextColor: ink,
    mainBkg: node,
    secondBkg: cluster,
    nodeBkg: node,
    nodeBorder: nodeLine,
    nodeTextColor: ink,
    border1: nodeLine,
    border2: clusterLine,
    lineColor: edge,
    defaultLinkColor: edge,
    arrowheadColor: edge,
    textColor: ink,
    titleColor: ink,
    clusterBkg: cluster,
    clusterBorder: clusterLine,
    edgeLabelBackground: surface,
    actorBkg: actor,
    actorBorder: actorLine,
    actorTextColor: ink,
    actorLineColor: edge,
    signalColor: edge,
    signalTextColor: ink,
    labelBoxBkgColor: actor,
    labelBoxBorderColor: actorLine,
    labelTextColor: ink,
    loopTextColor: ink,
    noteBkgColor: note,
    noteBorderColor: noteLine,
    noteTextColor: ink,
    activationBkgColor: cluster,
    activationBorderColor: clusterLine,
    sequenceNumberColor: surface,
    errorBkgColor: surface,
    errorTextColor: ink,
  };
};

// ── Sources ───────────────────────────────────────────────────────────────────

// a source as it is hashed and drawn: its line breaks LF, whatever a checkout gave it
export const sourceOf = (path) => {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
};

export const hashOf = (source) => {
  return createHash('sha256').update(source, 'utf8').digest('hex');
};

// the first line of an SVG this script writes
export const stampOf = (hash) => {
  return `<!-- sha256 of its source: ${hash} -->`;
};

export const diagrams = () => {
  return LANGUAGES.flatMap((language) => {
    return readdirSync(join(DIAGRAMS, language))
      .filter((file) => {
        return file.endsWith('.mmd');
      })
      .sort()
      .map((file) => {
        const name = file.slice(0, -'.mmd'.length);
        return {
          language,
          name,
          source: join(DIAGRAMS, language, file),
          svg: join(DIAGRAMS, language, `${name}.svg`),
        };
      });
  });
};

const isStale = (diagram) => {
  if (!existsSync(diagram.svg)) {
    return true;
  }
  const first = readFileSync(diagram.svg, 'utf8').split('\n', 1)[0];
  return first !== stampOf(hashOf(sourceOf(diagram.source)));
};

// ── SVG ───────────────────────────────────────────────────────────────────────

const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(?:black|white)(?![\w-])/giu;

// what Mermaid writes on an element whatever its theme, a class's rule drawing over it where the
// element has one: each the token it stands for, so that none is left to the other scheme
const DEFAULTS = Object.freeze({
  '#eaeaea': '--diagram-actor',
  '#666': '--diagram-actor-line',
  '#999': '--diagram-edge',
  '#edf2ae': '--diagram-note',
  '#000000': '--diagram-edge',
  '#000': '--diagram-edge',
  black: '--diagram-edge',
  '#ffffff': '--diagram-surface',
  '#fff': '--diagram-surface',
  white: '--diagram-surface',
});

const ATTRIBUTE = /^(?:fill|stroke|stop-color|flood-color|lighting-color|color)$/u;

// a sentinel's rgb() or rgba(), as Mermaid writes one it fades: its token, mixed to its alpha
const faded = (text) => {
  return text.replace(
    /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/gu,
    (written, red, green, blue, alpha) => {
      const hex = `#${[red, green, blue]
        .map((channel) => {
          return Number(channel).toString(16).padStart(2, '0');
        })
        .join('')}`;
      const token = SENTINELS[hex];
      if (token === undefined) {
        return written;
      }
      const share = alpha === undefined ? 1 : Number(alpha);
      return share === 1
        ? `var(${token})`
        : `color-mix(in srgb, var(${token}) ${Math.round(share * 100)}%, transparent)`;
    }
  );
};

// the top-level rules of a style sheet, an at-rule's block kept whole
const rulesOf = (sheet) => {
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < sheet.length; at += 1) {
    if (sheet[at] === '{') {
      depth += 1;
    } else if (sheet[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push(sheet.slice(start, at + 1));
        start = at + 1;
      }
    }
  }
  const rest = sheet.slice(start).trim();
  return rest === '' ? rules : [...rules, rest];
};

// an SVG whose sentinels are the page's tokens, at its own size, and the colours left that are not
const themed = (svg) => {
  let text = svg;
  for (const [hex, token] of Object.entries(SENTINELS)) {
    text = text.replace(new RegExp(hex, 'giu'), `var(${token})`);
  }
  text = faded(text);
  // a coordinate to the hundredth of a pixel: what Mermaid writes to the sixteenth draws no better.
  // ! never one that touches another dot: in a path's compact syntax `17.0001.45` is two numbers,
  // and `17` rounded would glue the second to it
  text = text.replace(/(?<![\d.])-?\d+\.\d{3,}(?![\d.])/gu, (number) => {
    return String(Number(Number(number).toFixed(2)));
  });
  // * a rule that still names a colour is one of a look or a feature these diagrams never use
  // (Mermaid's hand-drawn and neo looks, KaTeX, an actor's menu): dropped, the rest kept in order
  text = text.replace(/<style>([\s\S]*?)<\/style>/gu, (_, sheet) => {
    const kept = rulesOf(sheet).filter((rule) => {
      return rule.match(COLOUR) === null;
    });
    return `<style>${kept.join('')}</style>`;
  });
  // a presentation attribute takes no var(): each goes into the element's style, Mermaid's own
  // defaults as the tokens they stand for
  text = text.replace(
    /<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/gu,
    (tag, name, attributes, closing) => {
      const moved = [];
      let style = '';
      const kept = attributes.replace(/\s+([\w:-]+)="([^"]*)"/gu, (attribute, key, value) => {
        if (key === 'style') {
          style = value;
          return '';
        }
        const fallback = DEFAULTS[value.toLowerCase()];
        if (ATTRIBUTE.test(key) && fallback !== undefined) {
          moved.push(`${key}:var(${fallback})`);
          return '';
        }
        if (ATTRIBUTE.test(key) && value.includes('var(')) {
          moved.push(`${key}:${value}`);
          return '';
        }
        return attribute;
      });
      if (moved.length === 0) {
        return tag;
      }
      const merged = [style.replace(/;\s*$/u, ''), ...moved].filter(Boolean).join(';');
      return `<${name}${kept} style="${merged}"${closing === '/' ? '/' : ''}>`;
    }
  );
  // the diagram at the size Mermaid measured it, which the page scrolls rather than shrinks
  const viewBox = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/u.exec(text);
  if (viewBox === null) {
    throw new Error('an SVG without a viewBox');
  }
  const width = Math.ceil(Number(viewBox[3]));
  const height = Math.ceil(Number(viewBox[4]));
  text = text.replace(/<svg\b([^>]*)>/u, (open, attributes) => {
    const rest = attributes
      .replace(/\s+width="[^"]*"/u, '')
      .replace(/\s+height="[^"]*"/u, '')
      .replace(/\s+style="[^"]*"/u, '');
    return `<svg${rest} width="${width}" height="${height}" style="--w:${width}px">`;
  });
  const left = [...new Set(text.match(COLOUR) ?? [])];
  return { left, text };
};

// ── Render ────────────────────────────────────────────────────────────────────

const FACES = [
  ['Geist', 'geist.woff2'],
  ['Geist Mono', 'geist-mono.woff2'],
  ['Newsreader', 'newsreader.woff2'],
];

// a page that serves Mermaid and the faces, on the loopback, for the run
const serve = (fonts) => {
  const faces = FACES.map(([family, file]) => {
    return `@font-face { font-family: '${family}'; src: url('/fonts/${file}') format('woff2'); font-weight: 100 900; }`;
  }).join('\n');
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${faces}</style><script src="/mermaid.min.js"></script></head><body></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (request.url === '/mermaid.min.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(readFileSync(MERMAID));
      return;
    }
    const face = FACES.find(([, file]) => {
      return request.url === `/fonts/${file}`;
    });
    if (face !== undefined && fonts !== undefined && existsSync(join(fonts, face[1]))) {
      response.writeHead(200, { 'content-type': 'font/woff2' });
      response.end(readFileSync(join(fonts, face[1])));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      chromium: { type: 'string' },
      fonts: { type: 'string' },
    },
  });
  if (values.fonts === undefined) {
    console.warn('render: no --fonts; labels are measured in a fallback face, not the page’s');
  }
  const todo = diagrams().filter((diagram) => {
    return values.all || isStale(diagram);
  });
  if (todo.length === 0) {
    console.log('render: every SVG is its source’s');
    return 0;
  }

  const server = await serve(values.fonts);
  const browser = await chromium.launch(
    values.chromium === undefined ? {} : { executablePath: values.chromium }
  );
  let status = 0;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(
      async (families) => {
        await Promise.all(
          families.map((family) => {
            return document.fonts.load(`14px '${family}'`);
          })
        );
      },
      FACES.map(([family]) => family)
    );
    for (const diagram of todo) {
      const source = sourceOf(diagram.source);
      const id = `d-${diagram.name}-${diagram.language}`;
      const svg = await page.evaluate(
        async ({ id, source, theme }) => {
          // ! initialized for each diagram: deterministic ids restart from the seed, so the same
          // source gives the same SVG
          window.mermaid.initialize({
            startOnLoad: false,
            theme: 'base',
            themeVariables: theme,
            securityLevel: 'strict',
            look: 'classic',
            htmlLabels: false,
            markdownAutoWrap: false,
            deterministicIds: true,
            deterministicIDSeed: id,
            fontFamily: theme.fontFamily,
            flowchart: {
              htmlLabels: false,
              useMaxWidth: false,
              curve: 'basis',
              wrappingWidth: 1000,
            },
            sequence: { useMaxWidth: false, mirrorActors: false, wrap: false },
          });
          const { svg } = await window.mermaid.render(id, source);
          return svg;
        },
        { id, source, theme: themeVariables() }
      );
      const { left, text } = themed(svg);
      const relative = `${diagram.language}/${diagram.name}`;
      if (left.length > 0) {
        console.error(`render: ${relative}: colours left that are no token: ${left.join(', ')}`);
        status = 1;
      }
      writeFileSync(diagram.svg, `${stampOf(hashOf(source))}\n${text}\n`);
      const width = /width="(\d+)"/u.exec(text)[1];
      console.log(`render: ${relative}.svg, ${width} px wide`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return status;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
