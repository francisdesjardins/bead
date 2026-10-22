// ── Roots ─────────────────────────────────────────────────────────────────────

// A project's `.proto` roots, read before buf compiles them: a `bead/options.proto` among them is a
// copy of beadc's, which beadc compiles first and alone (OPTIONS_COPY), and so is a
// `buf/validate/validate.proto`, protovalidate's, which beadc vendors at the version it compiles
// (VALIDATE_COPY). Where a file of the set is on disk, for a finding's path. The roots' source
// files are read alone; beadc's work area belongs to its own module.

// dependencies

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { diagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';

// constants

/** Where Bead's options are, under a root, by the path an import names. */
export const OPTIONS_FILE = 'bead/options.proto';

/** Where protovalidate's options are, under a root, by the path an import names (decision 0035). */
export const VALIDATE_FILE = 'buf/validate/validate.proto';

/** The version of protovalidate's `validate.proto` beadc vendors and compiles. */
export const VALIDATE_VERSION = 'v1.2.2';

/** The files beadc compiles from its own root, never a project's: its options and protovalidate's. */
export const BEADC_FILES: ReadonlySet<string> = new Set([OPTIONS_FILE, VALIDATE_FILE]);

// definition

/** `path` as a finding names it: from the folder beadc runs in, with slashes. */
export const displayOf = (path: string): string => {
  return relative(process.cwd(), path).split(sep).join('/');
};

// whether `folder` holds a `.proto` file, at any depth
const holdsProto = (folder: string): boolean => {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' }).some((name) => {
    return name.endsWith('.proto');
  });
};

/**
 * Refuses a root that is no folder, with an {@link InputError}. An earlier's, read from `from`, its
 * folder, is named as its `beadc.yaml` names it, and refused too when it holds no `.proto`: git
 * archive writes a submodule as an empty folder, and leaves a link and what export-ignore names out.
 */
export const assertRoots = (
  roots: readonly string[],
  options: { readonly from?: string } = {}
): void => {
  const { from } = options;

  for (const root of roots) {
    const folder = existsSync(root) && statSync(root).isDirectory();

    if (from === undefined && !folder) {
      throw new InputError(`${root}: no folder of .proto files`);
    }

    if (from !== undefined && !(folder && holdsProto(root))) {
      throw new InputError(
        `${relative(from, root).split(sep).join('/')}: no folder of .proto files; git archive writes a submodule as an empty folder, and leaves a link and what export-ignore names out`
      );
    }
  }
};

/**
 * A `bead/options.proto` among `roots`, each an OPTIONS_COPY, and a `buf/validate/validate.proto`,
 * each a VALIDATE_COPY.
 */
export const optionsCopiesOf = (roots: readonly string[]): IDiagnostic[] => {
  return roots.flatMap((root) => {
    const options = join(root, ...OPTIONS_FILE.split('/'));
    const validate = join(root, ...VALIDATE_FILE.split('/'));

    return [
      ...(existsSync(options)
        ? [
            diagnosticOf('OPTIONS_COPY', {
              message: `a copy of ${OPTIONS_FILE} among the roots: beadc compiles its own, first, and imports find it; take the copy out`,
              place: { file: displayOf(options), line: 1, column: 1 },
            }),
          ]
        : []),
      ...(existsSync(validate)
        ? [
            diagnosticOf('VALIDATE_COPY', {
              message: `a copy of ${VALIDATE_FILE} among the roots: beadc compiles its own, protovalidate's ${VALIDATE_VERSION}, and imports find it; take the copy out`,
              place: { file: displayOf(validate), line: 1, column: 1 },
            }),
          ]
        : []),
    ];
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
