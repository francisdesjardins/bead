#!/usr/bin/env node
// Deploys what beadproto.dev serves: assembles `out/` from the files it lists, and nothing else, then
// uploads it by the Wrangler `package.json` pins, to the Worker `wrangler.jsonc` names, which serves
// files alone. The page, `dist/index.html`, at `/`; the demo's static build, `demo/dist/playground/`
// of the TypeScript side, built here from its own sources, at `/playground/`; Bead's mark and the
// faces the page draws with; the 404 page; and, written here, `_redirects`, `_headers`, `robots.txt`
// and `sitemap.xml`.
//
//   node deploy.mjs              the checks, `out/`, then `wrangler deploy`
//   node deploy.mjs --assemble   `out/` alone, from the tree as it is: a trial, never uploaded
//   node deploy.mjs --token      a deploy that means the CLOUDFLARE_API_TOKEN or
//                                CLOUDFLARE_ACCOUNT_ID the environment holds
//
// A deploy ships a commit that is on origin, from a tree with nothing changed, and says which. Its
// login is the operator's own, `wrangler login`; a token in the environment is refused unless
// `--token` says it is meant, so a token left in a shell is never used without a word.
//
// Exit 1 on a refusal, a page its build no longer gives, a file missing, or a file in the demo's build
// the list does not know.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TYPESCRIPT = join(ROOT, 'implementations', 'typescript');
const DEMO = join(TYPESCRIPT, 'demo', 'dist', 'playground');
export const OUT = join(HERE, 'out');
export const ADDRESS = 'https://beadproto.dev/';

// the variables by which Wrangler takes a login other than the operator's own
export const TOKEN_VARIABLES = Object.freeze(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);

// ── What ships ────────────────────────────────────────────────────────────────

// each file `out/` holds but the demo's and the four written here, by where it is served, from where
// it is, under this folder
export const FILES = Object.freeze({
  'index.html': 'dist/index.html',
  '404.html': 'src/404.html',
  'favicon.svg': 'src/favicon.svg',
  'favicon.ico': 'src/favicon.ico',
  'apple-touch-icon.png': 'src/apple-touch-icon.png',
  'fonts/geist.woff2': 'src/fonts/geist.woff2',
  'fonts/geist-mono.woff2': 'src/fonts/geist-mono.woff2',
  'fonts/newsreader.woff2': 'src/fonts/newsreader.woff2',
  'fonts/OFL.txt': 'src/fonts/OFL.txt',
});

// the demo's static build: its page, and its page's script and its worker's, each named by its
// content
export const DEMO_FILES = Object.freeze([
  /^index\.html$/u,
  /^page-[A-Z0-9]+\.js$/u,
  /^worker-[A-Z0-9]+\.js$/u,
]);

// ! every old path of the page and of the demo that reaches this host, in one hop to where it is;
// the demo's before the page's, the first rule that matches being the one applied
export const REDIRECTS = `/bead / 301
/bead/playground /playground/ 301
/playground /playground/ 301
/bead/playground/* /playground/:splat 301
/bead/* /:splat 301
`;

// what neither the page nor the demo asks of the browser
const DENIED = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'display-capture',
  'encrypted-media',
  'geolocation',
  'gyroscope',
  'hid',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
];

// the sha256 of each script the page holds inline, as a policy names it: the language and the theme
// before the first paint, and the page's own at the end of the body; the JSON its heads are in runs
// nothing
export const inlineScriptHashes = (html) => {
  // a parser reads a CRLF as an LF before a script's text is hashed
  const read = html.replaceAll('\r\n', '\n');
  return [...read.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(([, text]) => {
    return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  });
};

// * one policy for every path: the page's scripts by their hashes, the demo's and its worker's from
// this host; the styles inline, which the page's diagrams carry by the attribute, a hash taking none
// of them, and its sheets by the dozen
export const headersOf = (html) => {
  const policy = [
    "default-src 'none'",
    ["script-src 'self'", ...inlineScriptHashes(html)].join(' '),
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  return `/*
  Content-Security-Policy: ${policy}
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: ${DENIED.map((feature) => {
    return `${feature}=()`;
  }).join(', ')}
`;
};

export const ROBOTS = `User-agent: *
Allow: /

Sitemap: ${ADDRESS}sitemap.xml
`;

// the page's two languages, each its address, each naming both and the default, and the demo
export const sitemapOf = (day) => {
  const alternates = [
    ['en', ADDRESS],
    ['fr', `${ADDRESS}?lng=fr`],
    ['x-default', ADDRESS],
  ]
    .map(([language, address]) => {
      return `    <xhtml:link rel="alternate" hreflang="${language}" href="${address}"/>\n`;
    })
    .join('');
  const url = (address, links) => {
    return `  <url>\n    <loc>${address}</loc>\n    <lastmod>${day}</lastmod>\n${links}  </url>\n`;
  };
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    url(ADDRESS, alternates) +
    url(`${ADDRESS}?lng=fr`, alternates) +
    url(`${ADDRESS}playground/`, '') +
    '</urlset>\n'
  );
};

// ── Refusals ──────────────────────────────────────────────────────────────────

// a token in the environment, unless the operator says it is meant
export const tokenRefusals = (env, meant) => {
  const set = TOKEN_VARIABLES.filter((name) => {
    return (env[name] ?? '') !== '';
  });
  if (set.length === 0 || meant) {
    return [];
  }
  return [
    `${set.join(' and ')} set in the environment: the login is the operator's own, wrangler login; --token if this one is meant`,
  ];
};

// a tree with changes, or a commit no branch of origin holds: what ships is a commit anyone can
// read; `git` runs git in the repository and gives its output
export const treeRefusals = (git) => {
  const refusals = [];
  if (git(['status', '--porcelain']).trim() !== '') {
    refusals.push('the tree has changes not committed: a deploy ships a commit');
  }
  if (git(['branch', '--remotes', '--contains', 'HEAD']).trim() === '') {
    refusals.push('HEAD is on no branch of origin: push it, then deploy');
  }
  return refusals;
};

// ── Assembly ──────────────────────────────────────────────────────────────────

// the demo's files, each by the list, or a refusal naming what the list does not know
export const demoFilesOf = (names) => {
  const unknown = names.filter((name) => {
    return !DEMO_FILES.some((pattern) => {
      return pattern.test(name);
    });
  });
  if (unknown.length > 0) {
    throw new Error(
      `deploy: the demo's build holds what the list does not know: ${unknown.join(', ')}`
    );
  }
  for (const pattern of DEMO_FILES) {
    if (
      !names.some((name) => {
        return pattern.test(name);
      })
    ) {
      throw new Error(`deploy: the demo's build lacks ${String(pattern)}`);
    }
  }
  return names;
};

// `out/` from the lists alone, each file it writes named; `day` is the sitemap's lastmod
export const assemble = ({ out = OUT, demo = DEMO, day }) => {
  rmSync(out, { force: true, recursive: true });
  const written = [];
  const put = (served, write) => {
    const path = join(out, ...served.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    write(path);
    written.push(served);
  };
  // ! the page as the browser reads it, its line breaks LF: the hashes of its scripts are of these
  // bytes, which `out/` holds
  const page = join(HERE, ...FILES['index.html'].split('/'));
  const html = existsSync(page) ? readFileSync(page, 'utf8').replaceAll('\r\n', '\n') : '';
  for (const [served, source] of Object.entries(FILES)) {
    const from = join(HERE, ...source.split('/'));
    if (!existsSync(from)) {
      throw new Error(`deploy: ${source} is missing`);
    }
    put(served, (path) => {
      if (served === 'index.html') {
        writeFileSync(path, html);
      } else {
        copyFileSync(from, path);
      }
    });
  }
  for (const name of demoFilesOf(existsSync(demo) ? readdirSync(demo) : [])) {
    put(`playground/${name}`, (path) => {
      copyFileSync(join(demo, name), path);
    });
  }
  const generated = {
    _redirects: REDIRECTS,
    _headers: headersOf(html),
    'robots.txt': ROBOTS,
    'sitemap.xml': sitemapOf(day),
  };
  for (const [served, text] of Object.entries(generated)) {
    put(served, (path) => {
      writeFileSync(path, text);
    });
  }
  return written.sort();
};

// ── Deploy ────────────────────────────────────────────────────────────────────

const git = (args) => {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
};

// a command, its output the operator's, or a refusal naming it
const run = (command, args, cwd) => {
  console.log(`deploy: ${[command, ...args].join(' ')}, in ${cwd}`);
  const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (error !== undefined || status !== 0) {
    throw new Error(`deploy: ${command} ${args.join(' ')} failed`);
  }
};

// a project's own Yarn, the release its `.yarnrc.yml` vendors, by the Node running this
const yarnOf = (project) => {
  const release = /^yarnPath:\s*(\S+)\s*$/mu.exec(
    readFileSync(join(project, '.yarnrc.yml'), 'utf8')
  )?.[1];
  if (release === undefined) {
    throw new Error(`deploy: ${project}/.yarnrc.yml names no yarnPath`);
  }
  return (args) => {
    run(process.execPath, [join(project, release), ...args], project);
  };
};

const main = async () => {
  const { values } = parseArgs({
    options: { assemble: { type: 'boolean' }, token: { type: 'boolean' } },
  });
  const trial = values.assemble === true;
  const refusals = [
    ...tokenRefusals(process.env, values.token === true),
    ...(trial ? [] : treeRefusals(git)),
  ];
  if (refusals.length > 0) {
    throw new Error(refusals.map((refusal) => `deploy: ${refusal}`).join('\n'));
  }
  const commit = git(['rev-parse', '--short', 'HEAD']).trim();
  console.log(`deploy: ${trial ? 'a trial of the tree at' : 'the commit'} ${commit}`);

  // the page, as its build gives it, which check.mjs holds in CI
  const { OUT: PAGE, build } = await import('./build.mjs');
  if (readFileSync(PAGE, 'utf8').replaceAll('\r\n', '\n') !== build()) {
    throw new Error('deploy: dist/index.html is not what the build gives; node build.mjs');
  }

  // the demo, from its sources, as CI builds it
  const yarn = yarnOf(TYPESCRIPT);
  yarn(['install', '--immutable']);
  yarn(['playground:build:file']);

  const written = assemble({ day: git(['log', '-1', '--format=%cs']).trim() });
  console.log(`deploy: out/, ${String(written.length)} files\n  ${written.join('\n  ')}`);
  if (trial) {
    console.log('deploy: a trial, not uploaded');
    return;
  }

  // * the Wrangler package.json pins, never one resolved at deploy time
  const wrangler = join(HERE, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(wrangler)) {
    throw new Error('deploy: no Wrangler in node_modules; yarn install --immutable, in site/');
  }
  run(process.execPath, [wrangler, 'deploy'], HERE);
  console.log(`deploy: ${commit} at ${ADDRESS}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
