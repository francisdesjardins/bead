// ── Compile ───────────────────────────────────────────────────────────────────

// A project's `.proto` roots compiled by buf, as the TypeScript side runs it: buf from npm, under the
// Node that runs beadc, `build` with a configuration of beadc's own naming its options' root first
// and the project's roots after it, imports and source info included, into a FileDescriptorSet
// (decision 0022), or into buf's image, whose files mark the imports, for `beadc breaking`. buf's
// messages are printed as they came, their paths the roots' own, and exit 2. And buf's own `PROTOVALIDATE` lint rule over the
// same roots, protovalidate's check that a field's rules are coherent (decision 0035), each finding
// an error, `buf:PROTOVALIDATE`, at buf's line and column. buf builds a copy of the roots' `.proto`
// files beside beadc's, in the run's work area, never the project.

// dependencies

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BEADC_FOLDER } from './config.ts';
import { bufDiagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';
import { BEADC_FILES, displayOf, holdsHttpCopy, HTTP_FILES } from './roots.ts';
import { temporaryFolderOf } from './work-area.ts';

// constants

/** Where beadc's own options are: copied into the run's work area for buf. */
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

// the `.proto` files under `from` copied into `options.into`, at the same paths, a link followed as buf
// follows it, a folder `options.seen` holds never twice; beadc's own folder never, which holds the
// editor's copy of its options
const copyProtos = (
  from: string,
  options: { readonly into: string; readonly seen: Set<string> }
): void => {
  const { into: to, seen } = options;
  const real = realpathSync(from);

  if (seen.has(real)) {
    return;
  }

  seen.add(real);

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const path = join(from, entry.name);
    // * a link whose target is gone, as an editor's lock file is, holds nothing
    const target = entry.isSymbolicLink() ? statSync(path, { throwIfNoEntry: false }) : entry;

    if (target === undefined) {
      continue;
    }

    if (target.isDirectory()) {
      if (entry.name !== BEADC_FOLDER) {
        copyProtos(path, { into: join(to, entry.name), seen });
      }
    } else if (entry.name.endsWith('.proto')) {
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, entry.name), readFileSync(path));
    }
  }
};

// what buf is handed, in a folder of the run's work area: beadc's files under `include`, and a copy
// of the roots' `.proto` files under `tree`, each root at its path from the folder that holds them
// all, one module each; beadc's `google/api` left out where a root's stands for it, since buf
// refuses one file in two modules. `project` and `built` turn a path from one to the other.
interface IWorkspace {
  readonly folder: string;
  readonly modules: { path: string }[];
  /** A path of the roots, as buf is handed it. */
  readonly built: (path: string) => string;
  /** buf's text with every path of the copy turned to the roots' own. */
  readonly project: (text: string) => string;
}

// ! buf builds one folder and takes no module outside it, nor follows a junction on Windows: the
// roots are copied beside beadc's files, the system's temporary folder on a drive of its own
const workspaceOf = (roots: readonly string[]): IWorkspace => {
  const project = roots.map((folder) => {
    return resolve(folder);
  });
  const top = ancestorOf(project);
  const folder = temporaryFolderOf('buf-');

  try {
    const include = join(folder, 'include');
    const tree = join(folder, 'tree');
    const copied = holdsHttpCopy(roots);

    for (const file of BEADC_FILES) {
      if (copied && HTTP_FILES.includes(file)) {
        continue;
      }

      const copy = join(include, file);

      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, readFileSync(join(OPTIONS_ROOT, file)));
    }

    const mirrored = project.map((root) => {
      const copy = join(tree, relative(top, root));

      mkdirSync(copy, { recursive: true });
      copyProtos(root, { into: copy, seen: new Set() });

      return copy;
    });
    const treePrefix = `${tree}${sep}`;
    const topPrefix = top.endsWith(sep) ? top : `${top}${sep}`;

    return {
      folder,
      modules: [include, ...mirrored].map((module) => {
        return { path: moduleOf(folder, module) };
      }),
      built: (path) => {
        return join(tree, relative(top, resolve(path)));
      },
      project: (text) => {
        return text.replaceAll(treePrefix, topPrefix);
      },
    };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
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
  const { folder, modules, built, project } = workspaceOf(roots);
  const config = { version: 'v2', modules };
  const buf = require.resolve('@bufbuild/buf/bin/buf');
  const paths = (options.files ?? []).flatMap((file) => {
    return ['--path', built(file)];
  });

  try {
    return execFileSync(
      process.execPath,
      [
        buf,
        'build',
        folder,
        '--config',
        JSON.stringify(config),
        ...(options.image === true ? [] : ['--as-file-descriptor-set']),
        '-o',
        '-',
        ...paths,
      ],
      { cwd: folder, maxBuffer: LARGEST_SET, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim() ?? '';

    throw new InputError(
      stderr === '' ? `buf did not compile ${roots.join(', ')}` : project(stderr)
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
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
  const { folder, modules, built, project } = workspaceOf(roots);

  try {
    const config = { version: 'v2', modules, lint: { use: ['PROTOVALIDATE'] } };
    const buf = require.resolve('@bufbuild/buf/bin/buf');
    // * the project's files alone: beadc's own module is never a project's
    const paths = options.files.flatMap((path) => {
      return ['--path', built(path)];
    });
    const run = spawnSync(
      process.execPath,
      [buf, 'lint', folder, '--config', JSON.stringify(config), '--error-format', 'json', ...paths],
      { cwd: folder, maxBuffer: LARGEST_FINDINGS, encoding: 'utf8' }
    );

    if (run.status !== 0 && run.status !== BUF_FINDINGS) {
      const stderr = run.stderr.trim();

      throw new InputError(
        stderr === '' ? `buf did not lint ${roots.join(', ')}` : project(stderr)
      );
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
            file: displayOf(project(resolve(folder, finding.path))),
            line: finding.start_line,
            column: finding.start_column,
          },
        });
      });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};
