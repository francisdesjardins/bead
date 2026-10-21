#!/usr/bin/env node
// ── The image's licences ──────────────────────────────────────────────────────
// The licence texts of what beadc's image adds to its base, laid out under the folder given, and
// every package held to the image's label (decision 0022). Run over `node_modules/` once it holds
// the runtime's packages alone: each package's own licence files are copied to
// `node_modules/<package>/`; a package that ships none has the texts its `license` field names
// written there, from what this tool knows of each; protoc's archive ships none, so protobuf's goes
// to `protoc/LICENSE`; protovalidate's `validate.proto`, which beadc vendors, carries Buf's notice in
// its header and the Apache License 2.0's text at `protovalidate/LICENSE`; and Bead's own to
// `LICENSE`. A package whose licence names an identifier
// outside the expression given, the image's `org.opencontainers.image.licenses`, or one it holds
// no text for, fails the build: the label and the files cannot part (OCI Image Format's
// annotations; SPDX's license expressions; Apache-2.0 4(a) and BSD-3-Clause's second clause, a
// redistribution in binary form carrying the licence's text).
//
// Usage, from builder/:
//   node tools/licenses.mjs /opt/bead/licenses "Apache-2.0 AND BSD-3-Clause AND ISC AND MIT"

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILDER = fileURLToPath(new URL('../', import.meta.url));
const MODULES = join(BUILDER, 'node_modules');

// Bead's licence, the Apache License 2.0's text, and protobuf's, BSD-3-Clause with Google's notice
const APACHE = join(BUILDER, '..', 'LICENSE');
const PROTOBUF = join(BUILDER, 'licenses', 'protobuf.txt');
// protovalidate's, the Apache License 2.0's text, for the validate.proto beadc vendors (0035)
const PROTOVALIDATE = join(BUILDER, 'licenses', 'protovalidate.txt');

// a package's licence files, as npm counts them, and its notices, typescript's third parties' among
// them, in any case
const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$|notice/iu;

// an SPDX expression's operators and parentheses, between its identifiers
const OPERATORS = /\s+|\(|\)|\bAND\b|\bOR\b|\bWITH\b/u;

// ! the texts this tool writes for a package that ships none: Apache-2.0's text holds no holder's
// name, so it serves any package; a BSD's or an MIT's names its holder, so it is a package's own
const TEXTS = new Map([['Apache-2.0', APACHE]]);
const TEXTS_OF = new Map([['@bufbuild/protobuf', new Map([['BSD-3-Clause', PROTOBUF]])]]);

/** The identifiers of an SPDX expression. */
function identifiersOf(expression) {
  return expression.split(OPERATORS).filter((part) => part !== undefined && part !== '');
}

/** Every package folder under `folder`, a `node_modules/`, scoped and nested ones among them. */
function packagesUnder(folder) {
  if (!existsSync(folder)) return [];

  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return [];

    const path = join(folder, entry.name);

    if (entry.name.startsWith('@')) return packagesUnder(path);
    if (!existsSync(join(path, 'package.json'))) return [];

    return [path, ...packagesUnder(join(path, 'node_modules'))];
  });
}

function main() {
  const [out, expression] = process.argv.slice(2);

  if (out === undefined || expression === undefined)
    throw new Error('usage: node tools/licenses.mjs <folder> "<the label\'s SPDX expression>"');

  const allowed = new Set(identifiersOf(expression));
  const refusals = [];
  const seen = new Set();

  for (const folder of packagesUnder(MODULES)) {
    const { name, version, license } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8')
    );
    const ids = typeof license === 'string' ? identifiersOf(license) : [];

    if (ids.length === 0) {
      refusals.push(`${name}@${version}: no SPDX expression in its license field`);
      continue;
    }

    for (const id of ids) {
      seen.add(id);

      if (!allowed.has(id))
        refusals.push(`${name}@${version}: ${id}, outside the label's ${expression}`);
    }

    const target = join(out, 'node_modules', name);
    const files = readdirSync(folder).filter((file) => LICENCE_FILE.test(file));

    mkdirSync(target, { recursive: true });

    if (files.length > 0) {
      for (const file of files) copyFileSync(join(folder, file), join(target, file));
      continue;
    }

    for (const id of ids) {
      const text = TEXTS_OF.get(name)?.get(id) ?? TEXTS.get(id);

      if (text === undefined) {
        refusals.push(
          `${name}@${version}: ships no licence file, and this tool holds no ${id} text for it`
        );
        continue;
      }

      copyFileSync(text, join(target, `${id}.txt`));
    }
  }

  if (refusals.length > 0) throw new Error(`\n  ${refusals.join('\n  ')}`);

  mkdirSync(join(out, 'protoc'), { recursive: true });
  copyFileSync(PROTOBUF, join(out, 'protoc', 'LICENSE'));
  mkdirSync(join(out, 'protovalidate'), { recursive: true });
  copyFileSync(PROTOVALIDATE, join(out, 'protovalidate', 'LICENSE'));
  copyFileSync(APACHE, join(out, 'LICENSE'));

  console.log(
    `licenses: ${[...seen].toSorted((a, b) => a.localeCompare(b)).join(', ')}, under ${out}`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`licenses: ${error.message}\n`);
  process.exit(1);
}
