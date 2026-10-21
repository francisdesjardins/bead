import { fileURLToPath } from 'node:url';

import { fromBinary } from '@bufbuild/protobuf';
import { BinaryReader } from '@bufbuild/protobuf/wire';
import { type FileDescriptorProto, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../compile.ts';
import { InputError } from '../diagnostics.ts';
import { blueprintOf } from '../front-end/blueprint-of.ts';
import { readSet } from '../front-end/input.ts';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const UNCOMPILED = fileURLToPath(new URL('../../test/proto/PROCEDURE_OPTIONS/', import.meta.url));

// buf's ImageFileExtension, by the field number an image's file carries it at, and its is_import
const IMAGE_FILE_EXTENSION = 8042;
const IS_IMPORT = 1;

// whether buf's image marks `file` an import, read from its ImageFileExtension; none in a set
const isImportOf = (file: FileDescriptorProto): boolean | undefined => {
  const extension = (file.$unknown ?? []).find((field) => {
    return field.no === IMAGE_FILE_EXTENSION;
  });

  if (extension === undefined) {
    return undefined;
  }

  const reader = new BinaryReader(new BinaryReader(extension.data).bytes());

  while (reader.pos < reader.len) {
    const [number, type] = reader.tag();

    if (number === IS_IMPORT) {
      return reader.bool();
    }

    reader.skip(type);
  }

  return false;
};

test("compiles the roots after beadc's options, imports and source info included", () => {
  const set = fromBinary(FileDescriptorSetSchema, compile([FIXTURES]));
  const names = set.file.map((file) => {
    return file.name;
  });

  expect(names).toContain('google/protobuf/descriptor.proto');
  expect(names).toContain('bead/options.proto');
  expect(names).toContain('bead/interop/v1/interop.proto');
  expect(names).toContain('buf/validate/validate.proto');
  expect(set.file.at(-1)?.sourceCodeInfo?.location.length).toBeGreaterThan(0);
  // * the root's file, beadc's two and their imports: descriptor.proto, then the duration, the
  // timestamp and the field mask protovalidate's options name
  expect(fromBinary(FileDescriptorSetSchema, compile([UNCOMPILED])).file.length).toBe(7);
});

test("buf's refusal is an input error, its messages as they came", () => {
  expect(() => {
    return compile([fileURLToPath(new URL('../../test/golden/', import.meta.url))], {
      files: ['no/such/file.proto'],
    });
  }).toThrow(InputError);
});

test('an image marks the imports buf compiled, and reads as a set', () => {
  const image = compile([FIXTURES], { image: true });
  const set = compile([FIXTURES]);
  const marked = fromBinary(FileDescriptorSetSchema, image).file.map((file) => {
    return { name: file.name, isImport: isImportOf(file) };
  });

  expect(marked).toContainEqual({ name: 'google/protobuf/descriptor.proto', isImport: true });
  expect(marked).toContainEqual({ name: 'bead/options.proto', isImport: false });
  expect(marked).toContainEqual({ name: 'bead/interop/v1/interop.proto', isImport: false });
  expect(
    fromBinary(FileDescriptorSetSchema, set).file.map((file) => {
      return isImportOf(file);
    })
  ).not.toContain(true);
  expect(blueprintOf(readSet(image, { roots: [FIXTURES] })).blueprint).toEqual(
    blueprintOf(readSet(set, { roots: [FIXTURES] })).blueprint
  );
});
