// ── Compile ───────────────────────────────────────────────────────────────────

// A project's `.proto` roots compiled by buf, as the TypeScript side runs it: buf from npm, under the
// Node that runs beadc, `build` with a configuration of beadc's own naming its options' root first
// and the project's roots after it, imports and source info included, into a FileDescriptorSet
// (decision 0022). buf's messages are printed as they came, and exit 2.

// dependencies

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InputError } from './diagnostics.ts';

// constants

/** Where beadc's own `bead/options.proto` is: the root it compiles first. */
export const OPTIONS_ROOT = fileURLToPath(new URL('../proto/', import.meta.url));

// a set holds every file of a project's roots and their imports, which can be many
const LARGEST_SET = 256 * 1024 * 1024;

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

// definition

/**
 * Compiles `roots`, folders of `.proto` files, beadc's options' root before them, into a
 * FileDescriptorSet with its imports and its source info; `files`, when given, the files of the
 * roots to build, by path. Throws an {@link InputError} holding buf's messages when it refuses.
 */
export const compile = (
  roots: readonly string[],
  options: { readonly files?: readonly string[] } = {}
): Uint8Array => {
  const folders = [OPTIONS_ROOT, ...roots].map((folder) => {
    return resolve(folder);
  });
  const ancestor = ancestorOf(folders);
  const config = {
    version: 'v2',
    modules: folders.map((folder) => {
      return { path: moduleOf(ancestor, folder) };
    }),
  };
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
        '--as-file-descriptor-set',
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
