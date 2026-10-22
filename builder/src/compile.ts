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
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { temporaryFolderOf } from './config.ts';
import { bufDiagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';
import { BEADC_FILES, displayOf, holdsHttpCopy, HTTP_FILES } from './roots.ts';

// constants

/** Where beadc's own options are: copied to the project's drive for buf. */
export const OPTIONS_ROOT = fileURLToPath(new URL('../proto/', import.meta.url));

// a set holds every file of a project's roots and their imports, which can be many
const LARGEST_SET = 256 * 1024 * 1024;

// what buf's lint findings can hold, every message of a project
const LARGEST_FINDINGS = 64 * 1024 * 1024;

// buf's exit on findings, its lint's and its breaking's alike
const BUF_FINDINGS = 100;

// helpers

const require = createRequire(import.meta.url);

// * leave no empty work area among a standalone root's siblings; another run or an editor keeps it.
const removeWorkspace = (folder: string): void => {
  rmSync(folder, { recursive: true, force: true });

  try {
    rmdirSync(dirname(folder));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error;
    }
  }
};

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
        throw new InputError(`the .proto roots share no folder: ${folders.join(', ')}`);
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

// buf's configuration and its folder: beadc's files copied into the work area and `roots`, one module
// each, under the folder that holds them all; beadc's `google/api` left out of the copy where a root's
// stands for it, since buf refuses one file in two modules
const workspaceOf = (
  roots: readonly string[],
  options: { readonly folder?: string }
): {
  readonly ancestor: string;
  readonly modules: { path: string; excludes?: string[] }[];
  readonly folder: string;
} => {
  const project = roots.map((folder) => {
    return resolve(folder);
  });
  // * without a configuration, keep the copy beside a lone root, or under the roots' ancestor.
  const base =
    options.folder ?? (project.length === 1 ? dirname(project[0] ?? '.') : ancestorOf(project));
  const folder = temporaryFolderOf('buf-', { folder: resolve(base) });

  try {
    const include = join(folder, 'include');
    const copied = holdsHttpCopy(roots);

    for (const file of BEADC_FILES) {
      if (copied && HTTP_FILES.includes(file)) {
        continue;
      }

      const copy = join(include, file);

      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, readFileSync(join(OPTIONS_ROOT, file)));
    }

    const folders = [include, ...project];
    const ancestor = ancestorOf(folders);

    return {
      ancestor,
      folder,
      modules: folders.map((module) => {
        const own = relative(module, join(resolve(base), '.beadc'));
        // ! a project's root can hold the work area: the options belong to their own module alone.
        const excludes =
          own !== '' && own !== '..' && !own.startsWith(`..${sep}`) && !isAbsolute(own)
            ? [own.split(sep).join('/')]
            : [];

        return {
          path: moduleOf(ancestor, module),
          ...(excludes.length === 0 ? {} : { excludes }),
        };
      }),
    };
  } catch (error) {
    removeWorkspace(folder);
    throw error;
  }
};

// definition

/**
 * Compiles `roots`, folders of `.proto` files, beadc's options' root before them, into a
 * FileDescriptorSet with its imports and its source info; `files`, when given, the files of the
 * roots to build, by path; `image`, into buf's image instead, a set whose files mark the imports,
 * which the front end reads as a set. Throws an {@link InputError} holding buf's messages when it
 * refuses. `folder` places the temporary options under the project's `.beadc/`.
 */
export const compile = (
  roots: readonly string[],
  options: {
    readonly files?: readonly string[];
    readonly image?: boolean;
    readonly folder?: string;
  } = {}
): Uint8Array => {
  const { ancestor, modules, folder } = workspaceOf(roots, options);
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
      { cwd: ancestor, maxBuffer: LARGEST_SET, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim() ?? '';

    throw new InputError(stderr === '' ? `buf did not compile ${roots.join(', ')}` : stderr);
  } finally {
    removeWorkspace(folder);
  }
};

/**
 * buf's `PROTOVALIDATE` lint rule over `files`, the project's among `roots` by their paths on disk,
 * as `buf lint` runs it with `use: [PROTOVALIDATE]` alone: each finding an error,
 * `buf:PROTOVALIDATE`, buf's message at buf's line and column. Throws an {@link InputError} holding
 * buf's messages when it refuses. `folder` places the temporary options under the project's `.beadc/`.
 */
export const lintRules = (
  roots: readonly string[],
  options: { readonly files: readonly string[]; readonly folder?: string }
): IDiagnostic[] => {
  const { ancestor, modules, folder } = workspaceOf(roots, options);
  try {
    const config = { version: 'v2', modules, lint: { use: ['PROTOVALIDATE'] } };
    const buf = require.resolve('@bufbuild/buf/bin/buf');
    // * the project's files alone: beadc's own module is never a project's
    const paths = options.files.flatMap((path) => {
      return ['--path', resolve(path)];
    });
    const run = spawnSync(
      process.execPath,
      [
        buf,
        'lint',
        ancestor,
        '--config',
        JSON.stringify(config),
        '--error-format',
        'json',
        ...paths,
      ],
      { cwd: ancestor, maxBuffer: LARGEST_FINDINGS, encoding: 'utf8' }
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
  } finally {
    removeWorkspace(folder);
  }
};
