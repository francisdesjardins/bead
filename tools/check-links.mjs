#!/usr/bin/env node
// Every relative link of the repository's Markdown resolves: its file, or its folder, is one git
// keeps, and its anchor, `#…`, is a heading of the file it names, as GitHub derives one.
//
//   node tools/check-links.mjs             every Markdown file git lists, untracked ones included
//   node tools/check-links.mjs <file…>     those files alone
//
// A link with a scheme (`https:`, `mailto:`) is left out, and so is what a code block or a code
// span holds. Exit 1 on a link that does not resolve, with its file and its line.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

// the files git keeps, and those it would: a file a change adds counts before it is staged
const listed = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\0')
  .filter((path) => path !== '' && existsSync(path));

const files = new Set(listed);
const folders = new Set(
  listed.flatMap((path) => {
    const parts = path.split('/').slice(0, -1);
    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  })
);

const args = process.argv.slice(2);
const markdown = args.length > 0 ? args : listed.filter((path) => path.endsWith('.md'));

// ── Text ───────────────────────────────────────────────────────────────────────

// a character blanked, but a line break, so an offset keeps its line
const blank = (match) => {
  return match.replace(/[^\n]/g, ' ');
};

// the text with every fenced code block blanked
const blankBlocks = (text) => {
  return text.replace(
    /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm,
    blank
  );
};

// the text with every code block and code span blanked: what they hold is no link
const blankCode = (text) => {
  return blankBlocks(text).replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank);
};

const lineOf = (text, offset) => {
  return text.slice(0, offset).split('\n').length;
};

// ── Anchors ────────────────────────────────────────────────────────────────────

// a heading's anchor, as GitHub derives it from the text it renders: lower case, every character
// but a letter, a mark, a digit, `_`, `-` and a space dropped, each space a `-`
const slugOf = (heading) => {
  const rendered = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|\b_|_\b)/g, '');
  return rendered
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
};

const anchorsCache = new Map();

// the anchors of a Markdown file: one per heading, a repeated one numbered `-1`, `-2`, as GitHub
// numbers them
const anchorsOf = (path) => {
  if (!anchorsCache.has(path)) {
    const text = blankBlocks(readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'));
    const anchors = new Set();
    const seen = new Map();
    for (const [, heading] of text.matchAll(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/gm)) {
      const slug = slugOf(heading);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    anchorsCache.set(path, anchors);
  }
  return anchorsCache.get(path);
};

// ── Links ──────────────────────────────────────────────────────────────────────

// each target with its offset: an inline link or image, `[text](target "title")`, its target in
// angle brackets or bare, and a reference's definition, `[label]: target`
const targetsOf = (text) => {
  const inline = [...text.matchAll(/\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)/g)].map(
    (match) => {
      return [match[1].replace(/^<|>$/g, ''), match.index];
    }
  );
  const references = [...text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)].map(
    (match) => {
      return [match[1].replace(/^<|>$/g, ''), match.index];
    }
  );
  return [...inline, ...references];
};

// why a target does not resolve from the file that holds it, or nothing when it does
const failureOf = (file, target) => {
  if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return undefined;
  }
  const hash = target.indexOf('#');
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  const decoded = decodeURIComponent(pathPart.split('?')[0]);
  const resolved =
    decoded === ''
      ? file
      : posix
          .normalize(
            decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(file), decoded)
          )
          .replace(/\/$/, '');
  if (resolved.startsWith('..')) {
    return 'outside the repository';
  }
  const isFile = files.has(resolved);
  if (!isFile && !folders.has(resolved) && resolved !== '.') {
    return 'no such file or folder';
  }
  if (anchor === undefined || anchor === '') {
    return undefined;
  }
  if (!isFile || !resolved.endsWith('.md')) {
    return 'an anchor on what is no Markdown file';
  }
  return anchorsOf(resolved).has(anchor.toLowerCase()) ? undefined : `no heading #${anchor}`;
};

// ── Check ──────────────────────────────────────────────────────────────────────

const failures = [];
let count = 0;
for (const file of markdown) {
  const text = blankCode(readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'));
  for (const [target, offset] of targetsOf(text)) {
    count += 1;
    const failure = failureOf(file, target);
    if (failure !== undefined) {
      failures.push(`  ${file}:${lineOf(text, offset)} ${target}: ${failure}`);
    }
  }
}

// a walk that read nothing found nothing: the repository has links, so none read is a fault
if (count === 0 && args.length === 0) {
  console.error(`links: no link read in ${markdown.length} file(s).`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`links: ${failures.length} of ${count} link(s) do not resolve:`);
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`links: ${count} link(s) in ${markdown.length} file(s), each resolves.`);
