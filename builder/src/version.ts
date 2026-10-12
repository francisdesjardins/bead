// ── Version ───────────────────────────────────────────────────────────────────

// What beadc is and what it writes for: its own version, the product's, from its package; its
// tools', each from its own package, and protoc's, the one it finds against its pin; the blueprint's
// format; the spec's version, read from spec/spec.md in place, which a blueprint it writes repeats;
// and the number Bead's options take.

// dependencies

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { findProtoc, protocPin } from './protoc.ts';

// constants

/** The format and its major a blueprint states, which a reader refuses when it is another. */
export const FORMAT = 'bead-blueprint/1';

// ! the number bead/options.proto's three extensions take, which version.test.ts holds them to:
// 58500 until the first publication takes a number of protobuf's global registry, here, in
// options.proto and in options_pb.ts, regenerated, and in the goldens that embed it, written again:
// test/golden/typescript/bead/options_pb.ts and messages_pb.ts, and
// test/golden/csharp/Bead/Protobuf/Options.cs, its three extensions, and
// Bead/Messages/V1/Messages.cs, its descriptor (decisions 0008 and 0022)
export const OPTIONS_NUMBER = 58500;

/**
 * The oldest `@bufbuild/protobuf` protoc-gen-es's output runs on, with `erasable_syntax`: the
 * goldens are type-checked against it, `@bufbuild/protobuf-floor` (`tsconfig.floor.json`).
 */
export const PROTOBUF_FLOOR = '2.13.0';

// the spec's line that states its version, as spec/generators/spec_version.py reads it
const SPEC_VERSION_LINE = /^\*\*Version: (\d+\.\d+\.\d+)\*\*/mu;

// where beadc's own files and the spec's are: builder/ beside spec/, as the repository lays them out
const BUILDER = new URL('../', import.meta.url);
const SPEC = new URL('../../spec/', import.meta.url);

// helpers

const require = createRequire(import.meta.url);

// a package's own `version`, its package.json found by walking up from the file it resolves to, since
// a package that declares `exports` may not export its package.json; `entry`, a module of it, for a
// package that resolves to none by its name alone
const packageVersionOf = (name: string, entry: string = name): string => {
  let folder = dirname(require.resolve(entry));

  for (;;) {
    try {
      const declared = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };

      if (declared.name === name && typeof declared.version === 'string') {
        return declared.version;
      }
    } catch {
      // no package.json here: its parent's, then
    }

    const parent = dirname(folder);

    if (parent === folder) {
      return 'unknown';
    }

    folder = parent;
  }
};

// definition

/** Where the spec's files beadc reads are: its schemas, its version, its identities. */
export const specUrlOf = (path: string): URL => {
  return new URL(path, SPEC);
};

/** beadc's version, the product's, from its package. */
export const beadcVersion = (): string => {
  const declared = JSON.parse(readFileSync(new URL('package.json', BUILDER), 'utf8')) as {
    version: string;
  };

  return declared.version;
};

/** protoc-gen-es's version, which writes a project's messages and names itself in their header. */
export const protocGenEsVersion = (): string => {
  return packageVersionOf('@bufbuild/protoc-gen-es', '@bufbuild/protoc-gen-es/bin/protoc-gen-es');
};

/** The version of spec/spec.md, from its `**Version: x.y.z**` line. */
export const specVersion = (): string => {
  const stated = SPEC_VERSION_LINE.exec(readFileSync(specUrlOf('spec.md'), 'utf8'))?.[1];

  if (stated === undefined) {
    throw new Error('spec/spec.md states no **Version: x.y.z** line');
  }

  return stated;
};

/** The line `beadc version` names protoc on: its version, or another's and the pin's, or none's. */
export const protocLine = (): string => {
  const pinned = protocPin().version;
  const found = findProtoc();

  if (found === undefined) {
    return `protoc none, pinned ${pinned}`;
  }

  return found.version === pinned
    ? `protoc ${pinned}`
    : `protoc ${found.version}, pinned ${pinned}`;
};

/**
 * What `beadc version` prints, a line each: beadc's, its tools', protoc's, the format, the spec's, the
 * options'.
 */
export const versionLines = (): readonly string[] => {
  return [
    `beadc ${beadcVersion()}`,
    `buf ${packageVersionOf('@bufbuild/buf')}`,
    `protobuf-es ${packageVersionOf('@bufbuild/protobuf')}`,
    `protoplugin ${packageVersionOf('@bufbuild/protoplugin')}`,
    `protoc-gen-es ${protocGenEsVersion()}`,
    protocLine(),
    `format ${FORMAT}`,
    `spec ${specVersion()}`,
    `options ${String(OPTIONS_NUMBER)}`,
  ];
};
