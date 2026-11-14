#!/usr/bin/env node
// Each side's route table and document of spec/transcoding.proto are what beadc writes (decision
// 0037): each side commits what beadc generates for it, its messages, its procedures, its route
// table and its document embedded byte for byte, over the side's runtime, which its gateway's tests
// and its play of spec/transcoding.json answer by, as a project's generated code is committed. So
// this generates each again, apart, from a copy of the `.proto` beside a beadc.yaml of its own, and
// fails on any difference: a file edited by hand, or a `.proto`, a rule or a target moved without
// it. Each beadc.yaml gives `openapi.problemTypes` as spec/transcoding.json's defaults name it.
// spec/transcoding.proto imports spec/transcoding-required.proto, its edition's messages, so both
// are copied.
//
// - TypeScript: `implementations/typescript/src/transcoding/__tests__/generated/`, played by
//   `src/transcoding/__tests__/transcoding.test.ts` and `http-gateway.test.ts`;
// - C#: `implementations/dotnet/tests/Bead.Transcoding.Tests/Generated/`, its `openapi.json`
//   beside its code, played by `TranscodingTests` and `HttpGatewayTests`;
// - Rust: `implementations/rust/crates/bead-interop/src/transcoding/generated/`, its messages
//   Buffa's, its document embedded in its `bead_http.rs`, under `bead-interop`'s feature
//   `transcoding`, played by `bead-protobuf`'s `tests/transcoding.rs` and the core's
//   `tests/gateway.rs` and `tests/caller.rs` (decision 0052).
//
//   node tools/check-transcoding.mjs                       # check each (exit 1 on a difference)
//   node tools/check-transcoding.mjs typescript            # check one side
//   node tools/check-transcoding.mjs typescript --write    # write it in place
//
// From the repository's root, once builder/ is installed: beadc runs on Node from builder/src;
// protoc is `BEADC_PROTOC`, or the one builder/tools/fetch-protoc.mjs fetches; protoc-gen-buffa,
// for the Rust side, `BEADC_PROTOC_GEN_BUFFA`, or the one builder/tools/fetch-protoc-gen-buffa.mjs
// fetches.

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
const FETCH_PROTOC_GEN_BUFFA = join(ROOT, 'builder', 'tools', 'fetch-protoc-gen-buffa.mjs');
// ! every `.proto` spec/transcoding.proto imports goes with it, by its name under spec/
const PROTOS = Object.freeze(['transcoding.proto', 'transcoding-required.proto']);

// ! spec/transcoding.json's defaults: the problem types of the gateway it plays
const PROBLEM_TYPES = 'https://example.com/problems/';

// * each side's folder, its output's options and where its document goes: the TypeScript side's
// names its runtime from there, `src/service/service`, `src/proto/proto` and
// `src/transcoding/routes`; it and the Rust side embed their document alone, the Rust side's
// messages Buffa's, through protoc-gen-buffa
const SIDES = Object.freeze({
  typescript: Object.freeze({
    folder: 'implementations/typescript/src/transcoding/__tests__/generated',
    openapi: [],
    output: [
      '  - language: typescript',
      '    out: generated',
      '    importExtension: none',
      '    runtime: ../../../service/service',
      '    protoRuntime: ../../../proto/proto',
      '    gateway:',
      '      runtime: ../../transcoding',
    ],
  }),
  csharp: Object.freeze({
    folder: 'implementations/dotnet/tests/Bead.Transcoding.Tests/Generated',
    openapi: ['  out: generated/openapi.json'],
    output: ['  - language: csharp', '    out: generated', '    gateway: {}'],
  }),
  rust: Object.freeze({
    folder: 'implementations/rust/crates/bead-interop/src/transcoding/generated',
    openapi: [],
    output: [
      '  - language: rust',
      '    out: generated',
      '    messages: generate',
      '    gateway: {}',
    ],
    plugin: true,
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
const checkOf = (side, tools) => {
  // ! apart under the root's `.beadc/`, not the system's temporary folder: beadc's options and a
  // project's roots must share a folder for buf, and on Windows they may sit on two drives
  mkdirSync(join(ROOT, '.beadc'), { recursive: true });
  const apart = mkdtempSync(join(ROOT, '.beadc', 'transcoding-'));
  const committed = join(ROOT, side.folder);

  try {
    mkdirSync(join(apart, 'spec'));
    for (const name of PROTOS) {
      writeFileSync(join(apart, 'spec', name), readFileSync(join(ROOT, 'spec', name)));
    }
    writeFileSync(
      join(apart, 'beadc.yaml'),
      [
        '# What check-transcoding.mjs generates spec/transcoding.proto into, apart.',
        'version: 1',
        'source:',
        '  proto: [spec]',
        'openapi:',
        ...side.openapi,
        `  problemTypes: ${PROBLEM_TYPES}`,
        'outputs:',
        ...side.output,
        '',
      ].join('\n')
    );
    execFileSync(process.execPath, [BEADC, 'generate'], {
      cwd: apart,
      env: { ...process.env, ...tools },
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
    console.error('usage: node tools/check-transcoding.mjs [typescript|csharp|rust] [--write]');
    process.exit(2);
  }
}

const checked = named.length === 0 ? Object.keys(SIDES) : named;

// the path a tool's fetch prints, where its variable names none
const fetched = (fetch) => {
  return execFileSync(process.execPath, [fetch], { encoding: 'utf8' }).trim();
};

// * protoc for every side; protoc-gen-buffa only where a side's messages are Buffa's
const tools = {
  BEADC_PROTOC: process.env.BEADC_PROTOC ?? fetched(FETCH_PROTOC),
  ...(checked.some((name) => {
    return SIDES[name].plugin === true;
  })
    ? {
        BEADC_PROTOC_GEN_BUFFA:
          process.env.BEADC_PROTOC_GEN_BUFFA ?? fetched(FETCH_PROTOC_GEN_BUFFA),
      }
    : {}),
};

for (const name of checked) {
  const side = SIDES[name];
  const differing = checkOf(side, tools);

  // * the exit code set, not exit called: every side is checked, and each folder apart taken out
  if (differing.length > 0) {
    console.error(
      `check-transcoding: ${side.folder}: ${differing.join(', ')} differ from what beadc writes for spec/transcoding.proto; run \`node tools/check-transcoding.mjs ${name} --write\``
    );
    process.exitCode = 1;
  } else {
    console.log(
      `check-transcoding: ${side.folder} is what beadc writes for spec/transcoding.proto`
    );
  }
}
