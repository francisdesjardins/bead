import { fileURLToPath } from 'node:url';

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../compile.ts';
import { HTTP_EXTENSION } from '../front-end/http.ts';
import { withoutHttpOptions } from '../http-options.ts';
import { ANNOTATIONS_FILE } from '../roots.ts';

const ROUTED = fileURLToPath(new URL('../../test/proto/HTTP_GET_UNMARKED/', import.meta.url));

const fileOf = (
  set: Uint8Array,
  name: string
): ReturnType<typeof fromBinary<typeof FileDescriptorSetSchema>>['file'][number] => {
  const file = fromBinary(FileDescriptorSetSchema, set).file.find((each) => {
    return each.name === name;
  });

  if (file === undefined) {
    throw new Error(`${name}: not in the set`);
  }

  return file;
};

test("takes google.api.http and its import out of every file but googleapis' own, idempotency_level kept", () => {
  const set = compile([ROUTED]);
  const before = fileOf(set, 'x/v1/x.proto');
  const after = fileOf(withoutHttpOptions(set), 'x/v1/x.proto');
  const extensionsOf = (file: typeof before): number[] => {
    return file.service.flatMap((service) => {
      return service.method.flatMap((method) => {
        return (method.options?.$unknown ?? []).map((field) => {
          return field.no;
        });
      });
    });
  };

  expect(before.dependency).toContain(ANNOTATIONS_FILE);
  expect(extensionsOf(before)).toContain(HTTP_EXTENSION);
  expect(after.dependency).not.toContain(ANNOTATIONS_FILE);
  expect(extensionsOf(after)).not.toContain(HTTP_EXTENSION);
  // * Bead's own option stays, beside it
  expect(extensionsOf(after).length).toBeGreaterThan(0);
  expect(fileOf(withoutHttpOptions(set), ANNOTATIONS_FILE).extension).toHaveLength(1);
});
