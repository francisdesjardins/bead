#!/usr/bin/env node
// ── protoc, by its pin ────────────────────────────────────────────────────────
// beadc writes a project's C# messages with protoc, the one `protoc.json` pins: its version, and
// each release archive's sha256. This downloads this platform's archive from protobuf's GitHub
// release into `.protoc/`, which git ignores, checks its sha256 before it reads a byte of it,
// extracts it into `.protoc/<version>/`, its `bin/` and the well-known types' `include/`, checks
// that the executable says the pinned version, and prints its path, for `BEADC_PROTOC`. A protoc
// already there at the pin's version is printed as it is. Node's own zlib reads the zip: no
// `unzip`, which Windows lacks.
//
// Usage, from anywhere:
//   node builder/tools/fetch-protoc.mjs              # prints the executable's path
//   export BEADC_PROTOC="$(node builder/tools/fetch-protoc.mjs)"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const BUILDER = fileURLToPath(new URL('../', import.meta.url));
const PIN = JSON.parse(readFileSync(join(BUILDER, 'protoc.json'), 'utf8'));
const FOLDER = join(BUILDER, '.protoc');

// the zip's signatures and the stored and deflated methods (APPNOTE.TXT, 4.3 and 4.4.5)
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The archive's platform, in its name's words, for the running system. */
function platformOf() {
  const { platform, arch } = process;

  if (platform === 'win32') return 'win64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x86_64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-aarch_64';
  if (platform === 'darwin' && arch === 'arm64') return 'osx-aarch_64';
  if (platform === 'darwin' && arch === 'x64') return 'osx-x86_64';

  throw new Error(`no protoc ${PIN.version} pinned for ${platform} ${arch}: builder/protoc.json`);
}

/** The version `executable` says it is, `libprotoc` taken off, or none when it does not run. */
function versionOf(executable) {
  try {
    return execFileSync(executable, ['--version'], { encoding: 'utf8' })
      .trim()
      .replace(/^libprotoc /u, '');
  } catch {
    return undefined;
  }
}

/** Each file of the zip in `bytes`, by its name, as its bytes and its Unix mode. */
function entriesOf(bytes) {
  let end = bytes.length - 22;

  while (end >= 0 && bytes.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error('the archive is no zip: no end of its central directory');

  const count = bytes.readUInt16LE(end + 10);
  const entries = [];
  let at = bytes.readUInt32LE(end + 16);

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== DIRECTORY_ENTRY)
      throw new Error('a central directory entry is off');

    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);

    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (name.split('/').includes('..') || name.startsWith('/'))
      throw new Error(`${name}: outside the archive`);
    if (bytes.readUInt32LE(local) !== LOCAL_ENTRY)
      throw new Error(`${name}: its local header is off`);

    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);

    if (method !== STORED && method !== DEFLATED) throw new Error(`${name}: compression ${method}`);

    entries.push({ name, mode, data: method === STORED ? data : inflateRawSync(data) });
  }

  return entries;
}

async function main() {
  const platform = platformOf();
  const sha256 = PIN.sha256[platform];
  const target = join(FOLDER, PIN.version);
  const executable = join(target, 'bin', process.platform === 'win32' ? 'protoc.exe' : 'protoc');

  if (sha256 === undefined) throw new Error(`no sha256 for ${platform} in builder/protoc.json`);

  if (versionOf(executable) !== PIN.version) {
    const archive = `protoc-${PIN.version}-${platform}.zip`;
    const url = `https://github.com/protocolbuffers/protobuf/releases/download/v${PIN.version}/${archive}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');

    // ! nothing of the archive is read before its sha256 is the pin's
    if (actual !== sha256)
      throw new Error(`${archive}: sha256 ${actual}, where the pin says ${sha256}`);

    rmSync(target, { force: true, recursive: true });

    for (const entry of entriesOf(bytes)) {
      const path = resolve(target, ...entry.name.split('/'));

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.data);

      if (process.platform !== 'win32')
        chmodSync(path, entry.mode === 0 ? 0o644 : entry.mode & 0o777);
    }

    if (process.platform !== 'win32') chmodSync(executable, 0o755);
  }

  const said = versionOf(executable);

  if (said !== PIN.version)
    throw new Error(`${executable} says ${said ?? 'nothing'}, where the pin says ${PIN.version}`);
  if (!existsSync(executable)) throw new Error(`${executable}: not extracted`);

  process.stdout.write(`${executable}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`fetch-protoc: ${error.message}\n`);
  process.exit(1);
}
