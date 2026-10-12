import { expect, test } from '@playwright/test';

import { compile } from '../../compile.ts';
import { readSet } from '../input.ts';
import { COMMENTS_PROTO, FIXTURES, INTEROP_PROTO } from './derive.ts';

test("reads the project's files of buf's set, beadc's options and the imports left out", () => {
  const input = readSet(compile([FIXTURES]), { roots: [FIXTURES] });

  expect(
    input.files.map((file) => {
      return file.desc.proto.name;
    })
  ).toEqual([COMMENTS_PROTO, INTEROP_PROTO]);
  expect(input.files[1]?.path).toMatch(/test\/fixtures\/bead\/interop\/v1\/interop\.proto$/u);
  expect(input.registry.getFile('bead/options.proto')).toBeDefined();
  expect(input.registry.getFile('google/protobuf/descriptor.proto')).toBeDefined();
});

test('reads only the files named', () => {
  const input = readSet(compile([FIXTURES]), { roots: [FIXTURES], files: [INTEROP_PROTO] });

  expect(
    input.files.map((file) => {
      return file.desc.proto.name;
    })
  ).toEqual([INTEROP_PROTO]);
});
