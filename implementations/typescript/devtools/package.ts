// ── DevTools extension, packaged ──────────────────────────────────────────────

// The zip the Chrome Web Store takes: the extension built, then `devtools/dist/` zipped from the
// list below and nothing else, named by the package's version, its SHA-256 printed. One commit gives
// one zip, byte for byte: its entries sorted, stored, at one fixed time. It refuses a tree with
// changes, as the page's deploy does, so the zip is a commit's.
//
//   node devtools/package.ts           the build, then the zip, from a committed tree
//   node devtools/package.ts --trial   the same from the tree as it is, a zip never to upload

// dependencies

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32 } from 'node:zlib';

// interfaces

/** A file of the zip: its path inside it, `/` between its folders, and its bytes. */
export interface IZipEntry {
  name: string;
  bytes: Uint8Array;
}

// constants

const DEVTOOLS = fileURLToPath(new URL('./', import.meta.url));
const PACKAGE = join(DEVTOOLS, '..');
const DIST = join(DEVTOOLS, 'dist');

/** Where the zip is written, a folder git ignores. */
export const RELEASE = join(DEVTOOLS, 'release');

/**
 * ! every file the zip holds, by its path in `dist/`: the build's scripts, its pages, its manifest,
 * its messages, its icons and penumbra's two sheets the panel links. A file the build leaves that is
 * not here, a source map or a test, is a refusal, never a file shipped.
 */
export const FILES: readonly string[] = Object.freeze([
  '_locales/en/messages.json',
  '_locales/fr/messages.json',
  'background.js',
  'bridge.js',
  'devtools.html',
  'devtools.js',
  'hook.js',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'manifest.json',
  'panel.html',
  'panel.js',
  'penumbra/tokens.skin.base.css',
  'penumbra/tokens.system.css',
]);

/** The files read as text, whose line breaks are LF on every checkout. */
const TEXT = /\.(?:css|html|js|json)$/u;

/** 1980-01-01 at midnight, the first time a zip can write, in MS-DOS's form. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** Version 2.0 of the format, made and needed: what a stored entry asks of a reader. */
const ZIP_VERSION = 20;

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL = 0x06_05_4b_50;

// helpers

const textOf = (bytes: Uint8Array): string => {
  return new TextDecoder().decode(bytes);
};

/** The files under `folder`, by their path from it, `/` between their folders. */
const filesUnder = (folder: string): string[] => {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      return entry.isFile();
    })
    .map((entry) => {
      return relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/');
    });
};

// definition

/** The files of `listed` the zip holds, sorted, or a refusal naming those the list does not know. */
export const filesOf = (listed: readonly string[]): string[] => {
  const unknown = listed.filter((name) => {
    return !FILES.includes(name);
  });

  if (unknown.length > 0) {
    throw new Error(`package: dist/ holds what the list does not know: ${unknown.join(', ')}`);
  }

  const missing = FILES.filter((name) => {
    return !listed.includes(name);
  });

  if (missing.length > 0) {
    throw new Error(`package: dist/ lacks ${missing.join(', ')}`);
  }

  return [...FILES].sort();
};

/** What keeps the built files from shipping: a manifest whose version is not `version`, a CR. */
export const contentRefusals = (entries: readonly IZipEntry[], version: string): string[] => {
  const refusals: string[] = [];

  for (const { name, bytes } of entries) {
    if (TEXT.test(name) && bytes.includes(0x0d)) {
      refusals.push(`${name} holds a CR: a checkout other than LF built it`);
    }

    if (name === 'manifest.json') {
      const manifest = JSON.parse(textOf(bytes)) as { version?: unknown };

      if (manifest.version !== version) {
        refusals.push(`manifest.json says version ${String(manifest.version)}, not ${version}`);
      }
    }
  }

  return refusals;
};

/** A tree with changes, as `git` answers: a zip is a commit's. */
export const treeRefusals = (git: (args: readonly string[]) => string): string[] => {
  return git(['status', '--porcelain']).trim() === ''
    ? []
    : ['the tree has changes not committed: a zip is a commit’s; --trial for one never uploaded'];
};

/**
 * The zip of `entries` (APPNOTE.TXT, PKWARE's format), the same bytes for the same files in any
 * order: sorted by name, each stored, at {@link DOS_DATE}, no extra field, no attribute.
 */
export const zipOf = (entries: readonly IZipEntry[]): Uint8Array => {
  // * stored, never deflated: a deflater's bytes vary with its zlib, which this Node may not share
  const sorted = [...entries].sort((one, other) => {
    return one.name < other.name ? -1 : one.name > other.name ? 1 : 0;
  });
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, bytes } of sorted) {
    const path = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, path, Buffer.from(bytes));
    centrals.push(central, path);
    offset += local.length + path.length + bytes.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

/** The zip's name, by the package's version. */
export const zipNameOf = (version: string): string => {
  return `bead-devtools-${version}.zip`;
};

const git = (args: readonly string[]): string => {
  return execFileSync('git', ['-C', PACKAGE, ...args], { encoding: 'utf8' });
};

const main = (): void => {
  const { values } = parseArgs({ options: { trial: { type: 'boolean' } } });
  const refusals = values.trial === true ? [] : treeRefusals(git);

  if (refusals.length > 0) {
    throw new Error(
      refusals
        .map((refusal) => {
          return `package: ${refusal}`;
        })
        .join('\n')
    );
  }

  const built = spawnSync(process.execPath, [join(DEVTOOLS, 'build.ts')], {
    cwd: PACKAGE,
    stdio: 'inherit',
  });

  if (built.error !== undefined || built.status !== 0) {
    throw new Error('package: node devtools/build.ts failed');
  }

  const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
    version: string;
  };
  const entries = filesOf(filesUnder(DIST)).map((name) => {
    return { name, bytes: new Uint8Array(readFileSync(join(DIST, ...name.split('/')))) };
  });
  const problems = contentRefusals(entries, version);

  if (problems.length > 0) {
    throw new Error(
      problems
        .map((problem) => {
          return `package: ${problem}`;
        })
        .join('\n')
    );
  }

  const zip = zipOf(entries);
  const path = join(RELEASE, zipNameOf(version));

  mkdirSync(RELEASE, { recursive: true });
  writeFileSync(path, zip);

  const commit = git(['rev-parse', '--short', 'HEAD']).trim();
  const hash = createHash('sha256').update(zip).digest('hex');

  process.stdout.write(
    `package: ${relative(PACKAGE, path).split(sep).join('/')}, ${String(entries.length)} files, ${String(zip.length)} bytes, ${values.trial === true ? 'a trial of the tree at' : 'the commit'} ${commit}\n`
  );
  process.stdout.write(`package: sha256 ${hash}\n`);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
