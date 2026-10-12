// ── Roots ─────────────────────────────────────────────────────────────────────

// A project's `.proto` roots, read before buf compiles them: a `bead/options.proto` among them is a
// copy of beadc's, which beadc compiles first and alone (OPTIONS_COPY). Where a file of the set is on
// disk, for a finding's path. beadc writes nothing into a root.

// dependencies

import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { diagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';

// constants

/** Where Bead's options are, under a root, by the path an import names. */
export const OPTIONS_FILE = 'bead/options.proto';

// definition

/** `path` as a finding names it: from the folder beadc runs in, with slashes. */
export const displayOf = (path: string): string => {
  return relative(process.cwd(), path).split(sep).join('/');
};

/** Refuses a root that is no folder, with an {@link InputError}. */
export const assertRoots = (roots: readonly string[]): void => {
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new InputError(`${root}: no folder of .proto files`);
    }
  }
};

/** A `bead/options.proto` among `roots`, each an OPTIONS_COPY. */
export const optionsCopiesOf = (roots: readonly string[]): IDiagnostic[] => {
  return roots.flatMap((root) => {
    const copy = join(root, ...OPTIONS_FILE.split('/'));

    return existsSync(copy)
      ? [
          diagnosticOf('OPTIONS_COPY', {
            message: `a copy of ${OPTIONS_FILE} among the roots: beadc compiles its own, first, and imports find it; take the copy out`,
            place: { file: displayOf(copy), line: 1, column: 1 },
          }),
        ]
      : [];
  });
};

/** Where `name`, a file of the set by its import path, is on disk among `roots`; none for an import of beadc's. */
export const pathOnDisk = (name: string, roots: readonly string[]): string | undefined => {
  for (const root of roots) {
    const path = resolve(root, ...name.split('/'));

    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
};
