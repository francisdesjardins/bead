#!/usr/bin/env node
// Each side's validators of spec/validations.proto are what beadc writes (decision 0035): each side
// commits what beadc generates for it, its messages and its validators over the side's runtime,
// which its verdicts test plays spec/validations.json through, as a project's generated code is
// committed. So this generates each again, apart, from a copy of the `.proto` beside a beadc.yaml of
// its own, and fails on any difference: a file edited by hand, or a `.proto`, a rule or a target
// moved without it.
//
// - TypeScript: `implementations/typescript/src/proto/__tests__/generated/`, played by
//   `src/proto/__tests__/validate.test.ts`;
// - C#: `implementations/dotnet/tests/Bead.Protobuf.Tests/Generated/`, played by
//   `ValidatorsTests`.
//
//   node tools/check-validations.mjs                       # check both (exit 1 on a difference)
//   node tools/check-validations.mjs typescript            # check one side
//   node tools/check-validations.mjs typescript --write    # write it in place
//
// From the repository's root, once builder/ is installed: beadc runs on Node from builder/src;
// protoc is `BEADC_PROTOC`, or the one builder/tools/fetch-protoc.mjs fetches.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Places ────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BEADC = join(ROOT, 'builder', 'src', 'cli.ts');
const FETCH_PROTOC = join(ROOT, 'builder', 'tools', 'fetch-protoc.mjs');
const PROTO = join(ROOT, 'spec', 'validations.proto');

// * each side's folder, and its output's options: the TypeScript side's names its runtime from
// there, `src/service/service` and `src/proto/proto`
const SIDES = Object.freeze({
  typescript: Object.freeze({
    folder: 'implementations/typescript/src/proto/__tests__/generated',
    output: [
      '  - language: typescript',
      '    out: generated',
      '    importExtension: none',
      '    runtime: ../../../service/service',
      '    protoRuntime: ../../proto',
    ],
  }),
  csharp: Object.freeze({
    folder: 'implementations/dotnet/tests/Bead.Protobuf.Tests/Generated',
    output: ['  - language: csharp', '    out: generated'],
  }),
});

// ── Files ─────────────────────────────────────────────────────────────────────

/** Every file under `folder`, by its path from it, `/` between its parts. */
const filesOf = (folder) => {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      return entry.isFile();
    })
    .map((entry) => {
      return relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/');
    })
    .toSorted();
};

// ── Check ─────────────────────────────────────────────────────────────────────

/** What differs between `side`'s folder and what beadc writes for it, or nothing once written. */
const checkOf = (side, protoc) => {
  // ! apart under the root's `.beadc/`, not the system's temporary folder: beadc's options and a
  // project's roots must share a folder for buf, and on Windows they may sit on two drives
  mkdirSync(join(ROOT, '.beadc'), { recursive: true });
  const apart = mkdtempSync(join(ROOT, '.beadc', 'validations-'));
  const committed = join(ROOT, side.folder);

  try {
    mkdirSync(join(apart, 'spec'));
    writeFileSync(join(apart, 'spec', 'validations.proto'), readFileSync(PROTO));
    writeFileSync(
      join(apart, 'beadc.yaml'),
      [
        '# What check-validations.mjs generates spec/validations.proto into, apart.',
        'version: 1',
        'source:',
        '  proto: [spec]',
        'outputs:',
        ...side.output,
        '',
      ].join('\n')
    );
    execFileSync(process.execPath, [BEADC, 'generate'], {
      cwd: apart,
      env: { ...process.env, BEADC_PROTOC: protoc },
      stdio: 'inherit',
    });

    const written = join(apart, 'generated');

    if (process.argv.includes('--write')) {
      rmSync(committed, { force: true, recursive: true });
      cpSync(written, committed, { recursive: true });

      return [];
    }

    const expected = filesOf(written);
    const held = filesOf(committed);

    return [...new Set([...expected, ...held])].filter((name) => {
      return (
        !expected.includes(name) ||
        !held.includes(name) ||
        !readFileSync(join(written, name)).equals(readFileSync(join(committed, name)))
      );
    });
  } finally {
    rmSync(apart, { force: true, recursive: true });
  }
};

// ── Main ──────────────────────────────────────────────────────────────────────

const named = process.argv.slice(2).filter((argument) => {
  return !argument.startsWith('--');
});

for (const name of named) {
  if (!Object.hasOwn(SIDES, name)) {
    console.error('usage: node tools/check-validations.mjs [typescript|csharp] [--write]');
    process.exit(2);
  }
}

const protoc =
  process.env.BEADC_PROTOC ??
  execFileSync(process.execPath, [FETCH_PROTOC], { encoding: 'utf8' }).trim();

for (const name of named.length === 0 ? Object.keys(SIDES) : named) {
  const side = SIDES[name];
  const differing = checkOf(side, protoc);

  // * the exit code set, not exit called: every side is checked, and each folder apart taken out
  if (differing.length > 0) {
    console.error(
      `check-validations: ${side.folder}: ${differing.join(', ')} differ from what beadc writes for spec/validations.proto; run \`node tools/check-validations.mjs ${name} --write\``
    );
    process.exitCode = 1;
  } else {
    console.log(
      `check-validations: ${side.folder} is what beadc writes for spec/validations.proto`
    );
  }
}
