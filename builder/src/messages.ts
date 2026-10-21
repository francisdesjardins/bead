// ── Messages ──────────────────────────────────────────────────────────────────

// The messages a project's `proto` bindings name, written by protoc-gen-es, the stock generator, in
// beadc's process over buf's set (decision 0022): the files that declare them and every file of the
// project they import, `bead/options.proto` among them where they import it, since a `_pb.ts` imports
// the `_pb.ts` of each file its embedded descriptor depends on. protobuf's well-known types are
// `@bufbuild/protobuf/wkt`'s, never generated. Each file is protoc-gen-es's output as `buf generate`
// writes it, its own header first. protovalidate's options are taken out of what it is handed, beadc
// compiling a request's rules itself, unless the output keeps them (decision 0035).

// dependencies

import { createRequire } from 'node:module';

import { create, fromBinary } from '@bufbuild/protobuf';
import { CodeGeneratorRequestSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import type { ImportExtension, Plugin } from '@bufbuild/protoplugin';

import type { IBlueprint } from './model/blueprint.ts';
import type { IGeneratedFile } from './targets/target.ts';
import { withoutValidateOptions } from './validate-options.ts';

// constants

// the files protoc-gen-es imports from @bufbuild/protobuf/wkt rather than generating them
const WELL_KNOWN = 'google/protobuf/';

// helpers

const require = createRequire(import.meta.url);

// protoc-gen-es's plugin, as its own executable runs it: the package exports no entry of its own
const protocGenEs = (): Plugin => {
  return (
    require('@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js') as {
      protocGenEs: Plugin;
    }
  ).protocGenEs;
};

// definition

/**
 * The `_pb.ts` files of the messages `blueprint` binds, from `set`, buf's FileDescriptorSet of its
 * `.proto` source: none when it binds none of a file of its own; protovalidate's options taken out
 * unless `keepValidateOptions`.
 */
export const generateMessages = (
  set: Uint8Array,
  options: {
    readonly blueprint: IBlueprint;
    readonly importExtension: ImportExtension;
    readonly keepValidateOptions?: boolean;
  }
): readonly IGeneratedFile[] => {
  const descriptors = fromBinary(
    FileDescriptorSetSchema,
    options.keepValidateOptions === true ? set : withoutValidateOptions(set)
  );
  const dependencies = new Map(
    descriptors.file.map((file) => {
      return [file.name, file.dependency];
    })
  );
  const wanted = new Set<string>();
  const want = (file: string): void => {
    if (file.startsWith(WELL_KNOWN) || wanted.has(file)) {
      return;
    }

    wanted.add(file);

    for (const dependency of dependencies.get(file) ?? []) {
      want(dependency);
    }
  };

  for (const message of options.blueprint.proto?.messages ?? []) {
    want(message.file);
  }

  if (wanted.size === 0) {
    return [];
  }

  const response = protocGenEs().run(
    create(CodeGeneratorRequestSchema, {
      parameter: `target=ts,erasable_syntax=true,import_extension=${options.importExtension}`,
      protoFile: descriptors.file,
      // in the set's order, which is buf's, every import before the file that imports it
      fileToGenerate: descriptors.file
        .map((file) => {
          return file.name;
        })
        .filter((name) => {
          return wanted.has(name);
        }),
    })
  );

  if (response.error !== '') {
    throw new Error(`protoc-gen-es: ${response.error}`);
  }

  return response.file.map((file) => {
    return { name: file.name, content: file.content };
  });
};
