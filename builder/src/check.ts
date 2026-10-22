// ── Check ─────────────────────────────────────────────────────────────────────

// `beadc check` over one input, every stage in its order: a project's `.proto` roots — a copy of the
// options among them, Bead's or protovalidate's, buf's compile, buf's `PROTOVALIDATE` where a file
// imports protovalidate's options, the `.proto` rules, then the blueprint they give, at the
// blueprint's level — or a blueprint's file, read as bytes.

// dependencies

import { readFileSync } from 'node:fs';

import { compile, lintRules } from './compile.ts';
import { hasError, type IDiagnostic, InputError } from './diagnostics.ts';
import { blueprintOf } from './front-end/blueprint-of.ts';
import { checkProto } from './front-end/check-proto.ts';
import { readSet } from './front-end/input.ts';
import { importsValidate } from './front-end/rules.ts';
import { checkValue, type IBlueprint, type PlaceOf, readBlueprint } from './model/blueprint.ts';
import { assertRoots, optionsCopiesOf, pathOnDisk, VALIDATE_FILE } from './roots.ts';

// types

/** What checking an input gives: its findings, and its blueprint when nothing refused it. */
export interface IChecked {
  readonly diagnostics: readonly IDiagnostic[];
  readonly blueprint?: IBlueprint;
  /** Where each of the blueprint's pointers is in the input, a `.proto`'s line or a text's. */
  readonly placeOf?: PlaceOf;
  /** buf's set, for a `.proto` input that compiled; buf's image under `image`. */
  readonly set?: Uint8Array;
  /** The input's text, for a blueprint's file. */
  readonly text?: string;
}

// definition

/**
 * Checks the `.proto` files of `roots`, or only `files` among them by their import paths; `image`
 * compiles buf's image, for `beadc breaking`, which reads as a set. Throws an {@link InputError} for
 * a root that is no folder or a set buf does not compile. `folder` names the project's work area.
 */
export const checkRoots = (
  roots: readonly string[],
  options: {
    readonly files?: readonly string[];
    readonly image?: boolean;
    readonly folder?: string;
  } = {}
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
  const set = compile(roots, {
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    ...(files === undefined ? {} : { files }),
    ...(options.image === true ? { image: true } : {}),
  });
  const input = readSet(set, {
    roots,
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  // * buf's own check that a field's rules are coherent, run only where a file states some
  const linted = importsValidate(input, VALIDATE_FILE)
    ? lintRules(roots, {
        ...(options.folder === undefined ? {} : { folder: options.folder }),
        files: input.files.flatMap((file) => {
          const path = pathOnDisk(file.desc.proto.name, roots);

          return path === undefined ? [] : [path];
        }),
      })
    : [];
  // * rules buf refuses are none beadc reads further
  const proto = [...linted, ...checkProto(input, { rules: linted.length === 0 })];

  if (hasError(proto)) {
    return { diagnostics: proto, set };
  }

  const { blueprint, placeOf } = blueprintOf(input);
  const reading = checkValue(blueprint, { placeOf });

  return {
    diagnostics: [...proto, ...reading.diagnostics],
    set,
    placeOf,
    ...(reading.blueprint === undefined ? {} : { blueprint: reading.blueprint }),
  };
};

/** Checks the blueprint in `path`, read as bytes. Throws an {@link InputError} for a text that is no JSON. */
export const checkBlueprintFile = (path: string, options: { readonly file: string }): IChecked => {
  const bytes = readFileSync(path);
  const reading = readBlueprint(bytes, { file: options.file });

  return { ...reading, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
};
