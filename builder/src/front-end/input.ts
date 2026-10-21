// ── Input ─────────────────────────────────────────────────────────────────────

// buf's FileDescriptorSet, read: its registry, and the files a blueprint is read from, the project's
// own, in the set's order, each with the path a finding names; beadc's own, Bead's options and
// protovalidate's, are never the project's.

// dependencies

import {
  createFileRegistry,
  type DescFile,
  type FileRegistry,
  fromBinary,
} from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

import { BEADC_FILES, displayOf, pathOnDisk } from '../roots.ts';

// types

/** A file of the project's, and the path a finding names it by. */
export interface IProtoFile {
  readonly desc: DescFile;
  readonly path: string;
}

/** What a blueprint is read from: the set's registry, and the project's files. */
export interface IProtoInput {
  readonly registry: FileRegistry;
  readonly files: readonly IProtoFile[];
}

// definition

/**
 * Reads `bytes`, buf's set of `roots`: the files of the roots in the set's order, beadc's own files
 * and every import from elsewhere left out; only `files` among them when given, by their import
 * paths.
 */
export const readSet = (
  bytes: Uint8Array,
  options: { readonly roots: readonly string[]; readonly files?: readonly string[] }
): IProtoInput => {
  const set = fromBinary(FileDescriptorSetSchema, bytes);
  const registry = createFileRegistry(set);
  const files = set.file.flatMap((proto) => {
    const desc = registry.getFile(proto.name);
    const path = pathOnDisk(proto.name, options.roots);
    const wanted = options.files === undefined || options.files.includes(proto.name);

    return desc === undefined || path === undefined || BEADC_FILES.has(proto.name) || !wanted
      ? []
      : [{ desc, path: displayOf(path) }];
  });

  return { registry, files };
};
