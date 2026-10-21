// ── buf ───────────────────────────────────────────────────────────────────────

// buf's breaking rules over the messages of two buf images, the earlier's and the current's, each
// written under the system's temporary folder, then `buf breaking` with a configuration of beadc's
// own: `WIRE` under `WIRE`, `FILE` under `API`, the imports excluded, beadc's own files ignored,
// `bead/options.proto` and protovalidate's `buf/validate/validate.proto`, and every rule buf keys by a service's or an rpc's name excepted, since Bead keys them by id and
// holds them by its own rules (decision 0022). buf runs without the call's waivers, which beadc
// applies to its findings, by rule and by path as buf's `ignore_only` matches one, so that a waiver
// that waived nothing is said. Each finding is `buf:` and buf's rule, at buf's place, its import
// path kept; buf's exit 100 is findings, 0 none, any other its refusal, exit 2.

// dependencies

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bufDiagnosticOf, type IDiagnostic, InputError } from '../diagnostics.ts';
import { BEADC_FILES, displayOf, pathOnDisk } from '../roots.ts';
import { Category } from '../rules.ts';

// types

/** What {@link bufFindings} compares the current image against. */
export interface IBufOptions {
  readonly earlier: Uint8Array;
  readonly category: Category;
  /** The current's `.proto` roots, where a finding's file is found. */
  readonly roots: readonly string[];
  /** The earlier's `.proto` roots, where a file the current lost is found, when on disk. */
  readonly earlierRoots?: readonly string[];
}

/** A finding of buf's: its diagnostic, and the import path buf gave it, which a waiver's path matches. */
export interface IBufFinding {
  readonly diagnostic: IDiagnostic;
  readonly path?: string;
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

/**
 * The category of buf's that each of Bead's runs, `use`'s one: `WIRE`'s own, and `FILE` for `API`,
 * since a generated import path follows a file.
 */
export const BUF_CATEGORY: Readonly<Record<Category, string>> = Object.freeze({
  [Category.WIRE]: 'WIRE',
  [Category.API]: 'FILE',
});

/**
 * The rules each of buf's categories runs, at the buf beadc pins: a waiver of buf's names one its
 * category runs, or it would waive nothing under any call.
 */
export const BUF_RULES_RUN: Readonly<Record<Category, ReadonlySet<string>>> = Object.freeze({
  [Category.WIRE]: new Set([
    'ENUM_VALUE_NO_DELETE_UNLESS_NUMBER_RESERVED',
    'FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED',
    'FIELD_SAME_DEFAULT',
    'FIELD_SAME_ONEOF',
    'FIELD_WIRE_COMPATIBLE_CARDINALITY',
    'FIELD_WIRE_COMPATIBLE_TYPE',
    'FILE_SAME_PACKAGE',
    'MESSAGE_SAME_REQUIRED_FIELDS',
    'RESERVED_ENUM_NO_DELETE',
    'RESERVED_MESSAGE_NO_DELETE',
    'RPC_SAME_CLIENT_STREAMING',
    'RPC_SAME_IDEMPOTENCY_LEVEL',
    'RPC_SAME_REQUEST_TYPE',
    'RPC_SAME_RESPONSE_TYPE',
    'RPC_SAME_SERVER_STREAMING',
  ]),
  [Category.API]: new Set([
    'ENUM_NO_DELETE',
    'ENUM_SAME_JSON_FORMAT',
    'ENUM_SAME_TYPE',
    'ENUM_VALUE_NO_DELETE',
    'ENUM_VALUE_SAME_NAME',
    'EXTENSION_MESSAGE_NO_DELETE',
    'EXTENSION_NO_DELETE',
    'FIELD_NO_DELETE',
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
    'RESERVED_ENUM_NO_DELETE',
    'RESERVED_MESSAGE_NO_DELETE',
    'RPC_NO_DELETE',
    'RPC_SAME_CLIENT_STREAMING',
    'RPC_SAME_IDEMPOTENCY_LEVEL',
    'RPC_SAME_REQUEST_TYPE',
    'RPC_SAME_RESPONSE_TYPE',
    'RPC_SAME_SERVER_STREAMING',
    'SERVICE_NO_DELETE',
  ]),
});

// buf's exit on findings
const FINDINGS = 100;

// what buf's FILE_NO_DELETE says, at its pin: the file it names, by its import path
const DELETED_FILE = /^Previously present file "(.+)" was deleted\.$/u;

// what buf's findings can hold, every message of a project
const LARGEST_OUTPUT = 64 * 1024 * 1024;

// helpers

const require = createRequire(import.meta.url);

// definition

/** The configuration `buf breaking` takes under `category`. */
export const bufConfigOf = (category: Category): object => {
  return {
    version: 'v2',
    breaking: {
      use: [BUF_CATEGORY[category]],
      except: [...BUF_EXCEPTED],
      ignore: [...BEADC_FILES],
    },
  };
};

/**
 * Whether `path`, a file by its import path, is under `scope`, a file or a folder by its import
 * path, as buf's `ignore_only` matches it: the file itself, or a file under the folder, at a part's
 * boundary.
 */
export const isUnderScope = (path: string, scope: string): boolean => {
  const folder = scope.replace(/\/+$/u, '');

  return path === folder || path.startsWith(`${folder}/`);
};

/**
 * buf's breaking rules over `current`, buf's image of the current roots, against
 * `options.earlier`, the earlier's: each finding at its file among `options.roots`, its line and
 * column buf's; a file the current lost at the earlier's, among `options.earlierRoots` when they are
 * on disk, else by its import path. Throws an {@link InputError} holding buf's messages when it
 * refuses.
 */
export const bufFindings = (current: Uint8Array, options: IBufOptions): IBufFinding[] => {
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
        JSON.stringify(bufConfigOf(options.category)),
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
        // ! a file deleted is named in buf's message alone, at no path of its line
        const path =
          found.path === undefined || found.path === ''
            ? DELETED_FILE.exec(found.message ?? '')?.[1]
            : found.path;
        const onDisk = path === undefined ? undefined : pathOnDisk(path, options.roots);
        // * a file the current lost is the earlier's, never the current's first root
        const lost =
          path === undefined || onDisk !== undefined
            ? undefined
            : pathOnDisk(path, options.earlierRoots ?? []);
        const place =
          onDisk === undefined
            ? { file: lost === undefined ? (path ?? first) : displayOf(lost) }
            : {
                file: displayOf(onDisk),
                ...(found.start_line === undefined || found.start_line === 0
                  ? {}
                  : { line: found.start_line, column: found.start_column ?? 1 }),
              };

        return {
          diagnostic: bufDiagnosticOf(found.type ?? 'UNKNOWN', {
            message: found.message ?? '',
            place,
          }),
          ...(path === undefined ? {} : { path }),
        };
      });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};
