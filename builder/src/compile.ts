// ── Compile ───────────────────────────────────────────────────────────────────

// A project's `.proto` roots compiled by buf, as the TypeScript side runs it: buf from npm, under the
// Node that runs beadc, `build` with a configuration of beadc's own naming its options' root first
// and the project's roots after it, imports and source info included, into a FileDescriptorSet
// (decision 0022), or into buf's image, whose files mark the imports, for `beadc breaking`. buf's
// messages are printed as they came, and exit 2. And buf's own `PROTOVALIDATE` lint rule over the
// same roots, protovalidate's check that a field's rules are coherent (decision 0035), each finding
// an error, `buf:PROTOVALIDATE`, at buf's line and column.

// dependencies

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bufDiagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';
import { displayOf } from './roots.ts';

// constants

/** Where beadc's own `bead/options.proto` is: the root it compiles first. */
export const OPTIONS_ROOT = fileURLToPath(new URL('../proto/', import.meta.url));

// a set holds every file of a project's roots and their imports, which can be many
const LARGEST_SET = 256 * 1024 * 1024;

// what buf's lint findings can hold, every message of a project
const LARGEST_FINDINGS = 64 * 1024 * 1024;

// buf's exit on findings, its lint's and its breaking's alike
const BUF_FINDINGS = 100;

// helpers

const require = createRequire(import.meta.url);

// the folder that holds every one of `folders`: buf takes no module outside the folder it builds
const ancestorOf = (folders: readonly string[]): string => {
  let ancestor = folders[0] ?? '.';

  const holds = (folder: string): boolean => {
    const path = relative(ancestor, folder);

    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };

  for (const folder of folders) {
    while (!holds(folder)) {
      const parent = dirname(ancestor);

      if (parent === ancestor) {
        throw new InputError(
          `${folder} and beadc's ${OPTIONS_ROOT} share no folder, which buf needs to build them as one`
        );
      }

      ancestor = parent;
    }
  }

  return ancestor;
};

// a module's path as buf's configuration takes it: relative to the folder it builds, with slashes
const moduleOf = (ancestor: string, folder: string): string => {
  const path = relative(ancestor, folder).split(sep).join('/');

  return path === '' ? '.' : path;
};

// buf's configuration and its folder: the options' root and `roots`, one module each, under the folder
// that holds them all
const workspaceOf = (
  roots: readonly string[]
): { readonly ancestor: string; readonly modules: { path: string }[] } => {
  const folders = [OPTIONS_ROOT, ...roots].map((folder) => {
    return resolve(folder);
  });
  const ancestor = ancestorOf(folders);

  return {
    ancestor,
    modules: folders.map((folder) => {
      return { path: moduleOf(ancestor, folder) };
    }),
  };
};

// definition

/**
 * Compiles `roots`, folders of `.proto` files, beadc's options' root before them, into a
 * FileDescriptorSet with its imports and its source info; `files`, when given, the files of the
 * roots to build, by path; `image`, into buf's image instead, a set whose files mark the imports,
 * which the front end reads as a set. Throws an {@link InputError} holding buf's messages when it
 * refuses.
 */
export const compile = (
  roots: readonly string[],
  options: { readonly files?: readonly string[]; readonly image?: boolean } = {}
): Uint8Array => {
  const { ancestor, modules } = workspaceOf(roots);
  const config = { version: 'v2', modules };
  const buf = require.resolve('@bufbuild/buf/bin/buf');
  const paths = (options.files ?? []).flatMap((file) => {
    return ['--path', resolve(file)];
  });

  try {
    return execFileSync(
      process.execPath,
      [
        buf,
        'build',
        ancestor,
        '--config',
        JSON.stringify(config),
        ...(options.image === true ? [] : ['--as-file-descriptor-set']),
        '-o',
        '-',
        ...paths,
      ],
      { maxBuffer: LARGEST_SET, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim() ?? '';

    throw new InputError(stderr === '' ? `buf did not compile ${roots.join(', ')}` : stderr);
  }
};

/**
 * buf's `PROTOVALIDATE` lint rule over `files`, the project's among `roots` by their paths on disk,
 * as `buf lint` runs it with `use: [PROTOVALIDATE]` alone: each finding an error,
 * `buf:PROTOVALIDATE`, buf's message at buf's line and column. Throws an {@link InputError} holding
 * buf's messages when it refuses.
 */
export const lintRules = (
  roots: readonly string[],
  options: { readonly files: readonly string[] }
): IDiagnostic[] => {
  const { ancestor, modules } = workspaceOf(roots);
  const config = { version: 'v2', modules, lint: { use: ['PROTOVALIDATE'] } };
  const buf = require.resolve('@bufbuild/buf/bin/buf');
  // * the project's files alone: beadc's own module is never a project's
  const paths = options.files.flatMap((path) => {
    return ['--path', resolve(path)];
  });
  const run = spawnSync(
    process.execPath,
    [buf, 'lint', ancestor, '--config', JSON.stringify(config), '--error-format', 'json', ...paths],
    { maxBuffer: LARGEST_FINDINGS, encoding: 'utf8' }
  );

  if (run.status !== 0 && run.status !== BUF_FINDINGS) {
    const stderr = run.stderr.trim();

    throw new InputError(stderr === '' ? `buf did not lint ${roots.join(', ')}` : stderr);
  }

  return run.stdout
    .split('\n')
    .filter((line) => {
      return line.trim() !== '';
    })
    .map((line) => {
      const finding = JSON.parse(line) as {
        path: string;
        start_line: number;
        start_column: number;
        type: string;
        message: string;
      };

      return bufDiagnosticOf(finding.type, {
        message: finding.message,
        place: {
          file: displayOf(resolve(ancestor, finding.path)),
          line: finding.start_line,
          column: finding.start_column,
        },
      });
    });
};
