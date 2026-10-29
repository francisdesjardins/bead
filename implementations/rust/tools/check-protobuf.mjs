#!/usr/bin/env node
// ── The tests' descriptor set is what protoc writes ──────────────────────────
// `crates/bead-protobuf/proto/tests.binpb`, the set bead-protobuf's build script generates its
// tests' messages from, is committed: Buffa's generator is fed the set protoc writes at its pin,
// builder/protoc.json's, and no Rust build runs protoc (decision 0044). So this writes it again,
// apart, from spec/codecs.proto, spec/transcoding-required.proto and the crate's proto/codec.proto
// and proto/requiring.proto, and fails on any difference: a set edited by hand, or a `.proto` or the
// pin moved without it. protoc is `BEADC_PROTOC`, or the one builder/tools/fetch-protoc.mjs fetches;
// the set is the same on every platform.
//
// Usage, from the Rust side's folder:
//   node tools/check-protobuf.mjs           # check (exit 1 on a difference)
//   node tools/check-protobuf.mjs --write   # write it in place

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDE = fileURLToPath(new URL('../', import.meta.url));
const ROOT = join(SIDE, '..', '..');
const SET = 'crates/bead-protobuf/proto/tests.binpb';

// * the files the set holds, as bead-protobuf's build script generates them, and the folders
// protoc finds them in
const FILES = ['codecs.proto', 'transcoding-required.proto', 'codec.proto', 'requiring.proto'];
const INCLUDES = [join(ROOT, 'spec'), join(SIDE, 'crates', 'bead-protobuf', 'proto')];

const WRITE = process.argv.includes('--write');

/** protoc at its pin: the environment's, or the one fetched. */
function protocOf() {
  return (
    process.env.BEADC_PROTOC ??
    execFileSync(process.execPath, [join(ROOT, 'builder', 'tools', 'fetch-protoc.mjs')], {
      encoding: 'utf8',
    }).trim()
  );
}

/** Writes the set at `path`. */
function generate(path) {
  const protoc = protocOf();

  execFileSync(
    protoc,
    [
      ...INCLUDES.map((include) => {
        return `-I${include}`;
      }),
      `-I${join(dirname(protoc), '..', 'include')}`,
      '--include_imports',
      `--descriptor_set_out=${path}`,
      ...FILES,
    ],
    { stdio: 'inherit' }
  );
}

if (WRITE) {
  generate(join(SIDE, SET));
  process.exit(0);
}

const apart = mkdtempSync(join(tmpdir(), 'bead-rust-protobuf-'));

try {
  const path = join(apart, 'tests.binpb');

  generate(path);

  if (!readFileSync(path).equals(readFileSync(join(SIDE, SET)))) {
    console.error(
      `check-protobuf: ${SET} differs from what protoc writes; run \`node tools/check-protobuf.mjs --write\``
    );
    process.exit(1);
  }

  console.log(`check-protobuf: ${SET} is what protoc writes`);
} finally {
  rmSync(apart, { force: true, recursive: true });
}
