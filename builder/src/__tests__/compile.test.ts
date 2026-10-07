import { fileURLToPath } from 'node:url';

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../compile.ts';
import { InputError } from '../diagnostics.ts';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const UNCOMPILED = fileURLToPath(new URL('../../test/proto/PROCEDURE_OPTIONS/', import.meta.url));

test("compiles the roots after beadc's options, imports and source info included", () => {
  const set = fromBinary(FileDescriptorSetSchema, compile([FIXTURES]));
  const names = set.file.map((file) => {
    return file.name;
  });

  expect(names).toContain('google/protobuf/descriptor.proto');
  expect(names).toContain('bead/options.proto');
  expect(names).toContain('bead/interop/v1/interop.proto');
  expect(set.file.at(-1)?.sourceCodeInfo?.location.length).toBeGreaterThan(0);
  expect(fromBinary(FileDescriptorSetSchema, compile([UNCOMPILED])).file.length).toBe(3);
});

test("buf's refusal is an input error, its messages as they came", () => {
  expect(() => {
    return compile([fileURLToPath(new URL('../../test/golden/', import.meta.url))], {
      files: ['no/such/file.proto'],
    });
  }).toThrow(InputError);
});
