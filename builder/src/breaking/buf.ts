// ── buf ───────────────────────────────────────────────────────────────────────

// buf's breaking rules over the messages of two buf images, the earlier's and the current's, each
// written under the system's temporary folder, then `buf breaking` with a configuration of beadc's
// own: `WIRE` under `WIRE`, `FILE` under `API`, the imports excluded, `bead/options.proto` ignored,
// and every rule buf keys by a service's or an rpc's name excepted, since Bead keys them by id and
// holds them by its own rules (decision 0022). Each finding is `buf:` and buf's rule, at buf's place;
// buf's exit 100 is findings, 0 none, any other its refusal, exit 2.

// dependencies

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bufDiagnosticOf, type IDiagnostic, InputError } from '../diagnostics.ts';
import { displayOf, OPTIONS_FILE, pathOnDisk } from '../roots.ts';
import { Category } from '../rules.ts';

// types

/** The waivers a call gives buf: rules left out, and rules left out of paths, by import path. */
export interface IBufWaivers {
  readonly except: readonly string[];
  readonly ignoreOnly: Readonly<Record<string, readonly string[]>>;
}

/** What {@link bufFindings} compares the current image against. */
export interface IBufOptions {
  readonly earlier: Uint8Array;
  readonly category: Category;
  /** The current's `.proto` roots, where a finding's file is found. */
  readonly roots: readonly string[];
  readonly waivers?: IBufWaivers;
}

// a line of buf's `--error-format json`
interface IBufLine {
  readonly path?: string;
  readonly start_line?: number;
  readonly start_column?: number;
  readonly type?: string;
  readonly message?: string;
}

// constants

/**
 * buf's rules that key a service or an rpc by its name, excepted always: Bead keys them by id and
 * holds a rename, a deletion, a file, a kind and a binding by its own rules.
 */
export const BUF_EXCEPTED: readonly string[] = Object.freeze([
  'SERVICE_NO_DELETE',
  'RPC_NO_DELETE',
  'RPC_SAME_CLIENT_STREAMING',
  'RPC_SAME_IDEMPOTENCY_LEVEL',
  'RPC_SAME_REQUEST_TYPE',
  'RPC_SAME_RESPONSE_TYPE',
  'RPC_SAME_SERVER_STREAMING',
]);

/** buf's breaking rules, by id, at the buf beadc pins: what `--except buf:<RULE>` may name. */
export const BUF_RULES: ReadonlySet<string> = new Set([
  'ENUM_NO_DELETE',
  'ENUM_SAME_JSON_FORMAT',
  'ENUM_SAME_TYPE',
  'ENUM_VALUE_NO_DELETE',
  'ENUM_VALUE_NO_DELETE_UNLESS_NAME_RESERVED',
  'ENUM_VALUE_NO_DELETE_UNLESS_NUMBER_RESERVED',
  'ENUM_VALUE_SAME_NAME',
  'EXTENSION_MESSAGE_NO_DELETE',
  'EXTENSION_NO_DELETE',
  'FIELD_NO_DELETE',
  'FIELD_NO_DELETE_UNLESS_NAME_RESERVED',
  'FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED',
  'FIELD_SAME_CARDINALITY',
  'FIELD_SAME_CPP_STRING_TYPE',
  'FIELD_SAME_DEFAULT',
  'FIELD_SAME_JAVA_UTF8_VALIDATION',
  'FIELD_SAME_JSON_NAME',
  'FIELD_SAME_JSTYPE',
  'FIELD_SAME_NAME',
  'FIELD_SAME_ONEOF',
  'FIELD_SAME_TYPE',
  'FIELD_SAME_UTF8_VALIDATION',
  'FIELD_WIRE_COMPATIBLE_CARDINALITY',
  'FIELD_WIRE_COMPATIBLE_TYPE',
  'FIELD_WIRE_JSON_COMPATIBLE_CARDINALITY',
  'FIELD_WIRE_JSON_COMPATIBLE_TYPE',
  'FILE_NO_DELETE',
  'FILE_SAME_CC_ENABLE_ARENAS',
  'FILE_SAME_CC_GENERIC_SERVICES',
  'FILE_SAME_CSHARP_NAMESPACE',
  'FILE_SAME_GO_PACKAGE',
  'FILE_SAME_JAVA_GENERIC_SERVICES',
  'FILE_SAME_JAVA_MULTIPLE_FILES',
  'FILE_SAME_JAVA_OUTER_CLASSNAME',
  'FILE_SAME_JAVA_PACKAGE',
  'FILE_SAME_OBJC_CLASS_PREFIX',
  'FILE_SAME_OPTIMIZE_FOR',
  'FILE_SAME_PACKAGE',
  'FILE_SAME_PHP_CLASS_PREFIX',
  'FILE_SAME_PHP_METADATA_NAMESPACE',
  'FILE_SAME_PHP_NAMESPACE',
  'FILE_SAME_PY_GENERIC_SERVICES',
  'FILE_SAME_RUBY_PACKAGE',
  'FILE_SAME_SWIFT_PREFIX',
  'FILE_SAME_SYNTAX',
  'MESSAGE_NO_DELETE',
  'MESSAGE_NO_REMOVE_STANDARD_DESCRIPTOR_ACCESSOR',
  'MESSAGE_SAME_JSON_FORMAT',
  'MESSAGE_SAME_REQUIRED_FIELDS',
  'ONEOF_NO_DELETE',
  'PACKAGE_ENUM_NO_DELETE',
  'PACKAGE_EXTENSION_NO_DELETE',
  'PACKAGE_MESSAGE_NO_DELETE',
  'PACKAGE_NO_DELETE',
  'PACKAGE_SERVICE_NO_DELETE',
  'RESERVED_ENUM_NO_DELETE',
  'RESERVED_MESSAGE_NO_DELETE',
  'RPC_NO_DELETE',
  'RPC_SAME_CLIENT_STREAMING',
  'RPC_SAME_IDEMPOTENCY_LEVEL',
  'RPC_SAME_REQUEST_TYPE',
  'RPC_SAME_RESPONSE_TYPE',
  'RPC_SAME_SERVER_STREAMING',
  'SERVICE_NO_DELETE',
]);

// buf's exit on findings
const FINDINGS = 100;

// the category of buf's that each of Bead's takes: `WIRE`'s own, and `FILE` for `API`, since a
// generated import path follows a file
const BUF_CATEGORY: Readonly<Record<Category, string>> = Object.freeze({
  [Category.WIRE]: 'WIRE',
  [Category.API]: 'FILE',
});

// what buf's findings can hold, every message of a project
const LARGEST_OUTPUT = 64 * 1024 * 1024;

// helpers

const require = createRequire(import.meta.url);

// definition

/** The configuration `buf breaking` takes under `category`, with the call's waivers. */
export const bufConfigOf = (
  category: Category,
  waivers: IBufWaivers = { except: [], ignoreOnly: {} }
): object => {
  return {
    version: 'v2',
    breaking: {
      use: [BUF_CATEGORY[category]],
      except: [...BUF_EXCEPTED, ...waivers.except],
      ignore: [OPTIONS_FILE],
      ...(Object.keys(waivers.ignoreOnly).length === 0 ? {} : { ignore_only: waivers.ignoreOnly }),
    },
  };
};

/**
 * buf's breaking rules over `current`, buf's image of the current roots, against
 * `options.earlier`, the earlier's: each finding at its file among `options.roots`, its line and
 * column buf's; a file no root holds, a deleted one, at the first root. Throws an
 * {@link InputError} holding buf's messages when it refuses.
 */
export const bufFindings = (current: Uint8Array, options: IBufOptions): IDiagnostic[] => {
  const folder = mkdtempSync(join(tmpdir(), 'beadc-breaking-'));

  try {
    const currentFile = join(folder, 'current.binpb');
    const earlierFile = join(folder, 'earlier.binpb');

    writeFileSync(currentFile, current);
    writeFileSync(earlierFile, options.earlier);

    const run = spawnSync(
      process.execPath,
      [
        require.resolve('@bufbuild/buf/bin/buf'),
        'breaking',
        currentFile,
        '--against',
        earlierFile,
        '--exclude-imports',
        '--error-format',
        'json',
        '--config',
        JSON.stringify(bufConfigOf(options.category, options.waivers)),
      ],
      { encoding: 'utf8', maxBuffer: LARGEST_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    if (run.status === 0) {
      return [];
    }

    if (run.status !== FINDINGS) {
      const stderr = run.stderr.trim();

      throw new InputError(stderr === '' ? `buf breaking exited ${String(run.status)}` : stderr);
    }

    const first = options.roots[0] === undefined ? '.' : displayOf(options.roots[0]);

    return run.stdout
      .split('\n')
      .filter((line) => {
        return line.trim() !== '';
      })
      .map((line) => {
        const found = JSON.parse(line) as IBufLine;
        const onDisk =
          found.path === undefined || found.path === ''
            ? undefined
            : pathOnDisk(found.path, options.roots);
        const place =
          onDisk === undefined
            ? { file: first }
            : {
                file: displayOf(onDisk),
                ...(found.start_line === undefined || found.start_line === 0
                  ? {}
                  : { line: found.start_line, column: found.start_column ?? 1 }),
              };

        return bufDiagnosticOf(found.type ?? 'UNKNOWN', {
          message: found.message ?? '',
          place,
        });
      });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};
