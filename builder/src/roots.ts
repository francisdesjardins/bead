// ── Roots ─────────────────────────────────────────────────────────────────────

// A project's `.proto` roots, read before buf compiles them: a `bead/options.proto` among them is a
// copy of beadc's, which beadc compiles first and alone (OPTIONS_COPY), and so is a
// `buf/validate/validate.proto`, protovalidate's, which beadc vendors at the version it compiles
// (VALIDATE_COPY). googleapis' `google/api/http.proto` and `annotations.proto`, which beadc vendors
// too (decision 0037), are taken from the roots where both are there and each is the pin's bytes, a
// line's CRLF read as LF, since many a project vendors googleapis whole; any other copy is HTTP_COPY.
// Where a file of the set is on disk, for a finding's path. The roots' source files are read alone;
// beadc's work area belongs to its own module.

// dependencies

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnosticOf, type IDiagnostic, InputError } from './diagnostics.ts';

// constants

/** Where Bead's options are, under a root, by the path an import names. */
export const OPTIONS_FILE = 'bead/options.proto';

/** Where protovalidate's options are, under a root, by the path an import names (decision 0035). */
export const VALIDATE_FILE = 'buf/validate/validate.proto';

/** The version of protovalidate's `validate.proto` beadc vendors and compiles. */
export const VALIDATE_VERSION = 'v1.2.2';

/** Where `google.api.http` is declared, under a root, by the path an import names (decision 0037). */
export const ANNOTATIONS_FILE = 'google/api/annotations.proto';

/** Where `google.api.HttpRule` is declared, under a root, by the path an import names. */
export const HTTP_FILE = 'google/api/http.proto';

/** googleapis' files beadc vendors, each pinned by its sha256 in `proto/pins.json`. */
export const HTTP_FILES: readonly string[] = Object.freeze([ANNOTATIONS_FILE, HTTP_FILE]);

/** The folder of beadc's own root that holds googleapis' files, which a root's copies stand for. */
export const HTTP_FOLDER = 'google/api';

/**
 * The files beadc compiles from its own root, never a project's: its options, protovalidate's and
 * googleapis' `google/api` pair, which a project's identical copies stand for.
 */
export const BEADC_FILES: ReadonlySet<string> = new Set([
  OPTIONS_FILE,
  VALIDATE_FILE,
  ...HTTP_FILES,
]);

// beadc's pins of googleapis' files, by their import paths
const PINS = fileURLToPath(new URL('../proto/pins.json', import.meta.url));

// a file's sha256, its CRLF read as LF, as a checkout may write it
const fingerprintOf = (path: string): string => {
  const text = readFileSync(path).toString('latin1').replaceAll('\r\n', '\n');

  return createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
};

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

/** The sha256 beadc pins each of googleapis' files to, by its import path. */
export const httpPins = (): ReadonlyMap<string, string> => {
  const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { sha256: string }>;

  return new Map(
    Object.entries(pins).map(([path, pin]) => {
      return [path, pin.sha256] as const;
    })
  );
};

/** Whether a root holds a copy of googleapis' `google/api` pair, which then stands for beadc's. */
export const holdsHttpCopy = (roots: readonly string[]): boolean => {
  return roots.some((root) => {
    return HTTP_FILES.some((file) => {
      return existsSync(join(root, ...file.split('/')));
    });
  });
};

// the copies of googleapis' pair among `roots` that cannot stand for beadc's: one off its pin, or
// one of the two alone, since beadc's own pair then goes whole
const httpCopiesOf = (roots: readonly string[]): IDiagnostic[] => {
  const pins = httpPins();
  const found = roots.flatMap((root) => {
    return HTTP_FILES.flatMap((file) => {
      const path = join(root, ...file.split('/'));

      return existsSync(path) ? [{ file, path }] : [];
    });
  });
  const held = new Set(
    found.map((copy) => {
      return copy.file;
    })
  );

  return found.flatMap(({ file, path }) => {
    const off = fingerprintOf(path) !== pins.get(file);
    const alone = held.size < HTTP_FILES.length;

    return off || alone
      ? [
          diagnosticOf('HTTP_COPY', {
            message: off
              ? `a copy of ${file} among the roots that is not googleapis' own at the commit beadc vendors: take it out, and imports find beadc's, or hold googleapis' bytes`
              : `a copy of ${file} among the roots without its pair: beadc takes the roots' copies of ${HTTP_FILES.join(' and ')} in place of its own where both are googleapis' own; hold both, or neither`,
            place: { file: displayOf(path), line: 1, column: 1 },
          }),
        ]
      : [];
  });
};

/**
 * A `bead/options.proto` among `roots`, each an OPTIONS_COPY; a `buf/validate/validate.proto`, each
 * a VALIDATE_COPY; and a copy of googleapis' `google/api` pair that cannot stand for beadc's, each
 * an HTTP_COPY.
 */
export const optionsCopiesOf = (roots: readonly string[]): IDiagnostic[] => {
  const options = roots.flatMap((root) => {
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

  return [...options, ...httpCopiesOf(roots)];
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
