// ── Check ─────────────────────────────────────────────────────────────────────

// `beadc check` over one input, every stage in its order: a project's `.proto` roots — a copy of the
// options among them, buf's compile, the `.proto` rules, then the blueprint they give, at the
// blueprint's level — or a blueprint's file, read as bytes.

// dependencies

import { readFileSync } from 'node:fs';

import { compile } from './compile.ts';
import { hasError, type IDiagnostic, InputError } from './diagnostics.ts';
import { blueprintOf } from './front-end/blueprint-of.ts';
import { checkProto } from './front-end/check-proto.ts';
import { readSet } from './front-end/input.ts';
import { checkValue, type IBlueprint, readBlueprint } from './model/blueprint.ts';
import { assertRoots, optionsCopiesOf, pathOnDisk } from './roots.ts';

// types

/** What checking an input gives: its findings, and its blueprint when nothing refused it. */
export interface IChecked {
  readonly diagnostics: readonly IDiagnostic[];
  readonly blueprint?: IBlueprint;
  /** buf's set, for a `.proto` input that compiled. */
  readonly set?: Uint8Array;
  /** The input's text, for a blueprint's file. */
  readonly text?: string;
}

// definition

/**
 * Checks the `.proto` files of `roots`, or only `files` among them by their import paths. Throws an
 * {@link InputError} for a root that is no folder or a set buf does not compile.
 */
export const checkRoots = (
  roots: readonly string[],
  options: { readonly files?: readonly string[] } = {}
): IChecked => {
  assertRoots(roots);

  const copies = optionsCopiesOf(roots);

  if (copies.length > 0) {
    return { diagnostics: copies };
  }

  const files = options.files?.map((name) => {
    const path = pathOnDisk(name, roots);

    if (path === undefined) {
      throw new InputError(`${name}: no file of the roots`);
    }

    return path;
  });
  const set = compile(roots, files === undefined ? {} : { files });
  const input = readSet(set, {
    roots,
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  const proto = checkProto(input);

  if (hasError(proto)) {
    return { diagnostics: proto, set };
  }

  const { blueprint, placeOf } = blueprintOf(input);
  const reading = checkValue(blueprint, { placeOf });

  return {
    diagnostics: [...proto, ...reading.diagnostics],
    set,
    ...(reading.blueprint === undefined ? {} : { blueprint: reading.blueprint }),
  };
};

/** Checks the blueprint in `path`, read as bytes. Throws an {@link InputError} for a text that is no JSON. */
export const checkBlueprintFile = (path: string, options: { readonly file: string }): IChecked => {
  const bytes = readFileSync(path);
  const reading = readBlueprint(bytes, { file: options.file });

  return { ...reading, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
};
