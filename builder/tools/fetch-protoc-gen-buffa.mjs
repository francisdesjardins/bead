#!/usr/bin/env node
// ── protoc-gen-buffa, by its pin ──────────────────────────────────────────────
// beadc writes a project's Rust messages with Buffa's protoc-gen-buffa, the one
// `protoc-gen-buffa.json` pins: its version, the Buffa its code requires, and each release
// binary's sha256 (decision 0051). This downloads this platform's binary from Buffa's GitHub
// release into `.protoc-gen-buffa/<version>/`, which git ignores, checks its sha256 before it is
// written as an executable or run, checks that it says the pinned version, and prints its path,
// for `BEADC_PROTOC_GEN_BUFFA`. A plugin already there at the pin's version is printed as it is.
//
// Usage, from anywhere:
//   node builder/tools/fetch-protoc-gen-buffa.mjs              # prints the executable's path
//   export BEADC_PROTOC_GEN_BUFFA="$(node builder/tools/fetch-protoc-gen-buffa.mjs)"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILDER = fileURLToPath(new URL('../', import.meta.url));
const PIN = JSON.parse(readFileSync(join(BUILDER, 'protoc-gen-buffa.json'), 'utf8'));
const FOLDER = join(BUILDER, '.protoc-gen-buffa');

/** The binary's platform, in its name's words, for the running system. */
function platformOf() {
  const { platform, arch } = process;

  if (platform === 'win32' && arch === 'x64') return 'windows-x86_64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x86_64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-aarch64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-aarch64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x86_64';

  throw new Error(
    `no protoc-gen-buffa ${PIN.version} pinned for ${platform} ${arch}: builder/protoc-gen-buffa.json`
  );
}

/** The version `executable` says it is, its name taken off, or none when it does not run. */
function versionOf(executable) {
  try {
    return execFileSync(executable, ['--version'], { encoding: 'utf8' })
      .trim()
      .replace(/^protoc-gen-buffa /u, '');
  } catch {
    return undefined;
  }
}

async function main() {
  const platform = platformOf();
  const sha256 = PIN.sha256[platform];
  const target = join(FOLDER, PIN.version);
  const windows = process.platform === 'win32';
  const executable = join(target, windows ? 'protoc-gen-buffa.exe' : 'protoc-gen-buffa');

  if (sha256 === undefined)
    throw new Error(`no sha256 for ${platform} in builder/protoc-gen-buffa.json`);

  if (versionOf(executable) !== PIN.version) {
    const asset = `protoc-gen-buffa-v${PIN.version}-${platform}${windows ? '.exe' : ''}`;
    const url = `https://github.com/anthropics/buffa/releases/download/v${PIN.version}/${asset}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');

    // ! nothing of the binary is written as an executable, nor run, before its sha256 is the pin's
    if (actual !== sha256)
      throw new Error(`${asset}: sha256 ${actual}, where the pin says ${sha256}`);

    mkdirSync(target, { recursive: true });
    writeFileSync(`${executable}.tmp`, bytes);
    renameSync(`${executable}.tmp`, executable);

    if (!windows) chmodSync(executable, 0o755);
  }

  const said = versionOf(executable);

  if (said !== PIN.version)
    throw new Error(`${executable} says ${said ?? 'nothing'}, where the pin says ${PIN.version}`);
  if (!existsSync(executable)) throw new Error(`${executable}: not written`);

  process.stdout.write(`${executable}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`fetch-protoc-gen-buffa: ${error.message}\n`);
  process.exit(1);
}
