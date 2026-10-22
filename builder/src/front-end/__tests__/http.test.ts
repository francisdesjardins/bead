import { fileURLToPath } from 'node:url';

import type { DescMethod } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { compile } from '../../compile.ts';
import { hasError } from '../../diagnostics.ts';
import type { IBlueprint } from '../../model/blueprint.ts';
import { boundMessagesOf, shapesOf, variableRefusalOf, writtenRulesOf } from '../http.ts';
import { readSet } from '../input.ts';

const SPEC = fileURLToPath(new URL('../../../../spec/', import.meta.url));

const transcoding = (): IBlueprint => {
  const checked = checkRoots([SPEC], { files: ['transcoding.proto'] });

  expect(hasError(checked.diagnostics)).toBe(false);

  if (checked.blueprint === undefined) {
    throw new Error('spec/transcoding.proto: no blueprint');
  }

  return checked.blueprint;
};

const input = (): ReturnType<typeof readSet> => {
  return readSet(compile([SPEC], { files: [`${SPEC}transcoding.proto`] }), {
    roots: [SPEC],
    files: ['transcoding.proto'],
  });
};

const method = (name: string): DescMethod => {
  const found = input().files[0]?.desc.services[0]?.methods.find((each) => {
    return each.name === name;
  });

  if (found === undefined) {
    throw new Error(`${name}: no method`);
  }

  return found;
};

test("reads each method's google.api.http rule and idempotency_level, its additional_bindings rules of their own, in their order", () => {
  const procedures = transcoding().services[0]?.procedures ?? [];
  const byName = new Map(
    procedures.map((procedure) => {
      return [procedure.procedureName, procedure.http] as const;
    })
  );

  expect(byName.get('getBook')).toEqual({
    idempotencyLevel: 'NO_SIDE_EFFECTS',
    rules: [
      { method: 'GET', template: '/v1/{name=shelves/*/books/*}' },
      { method: 'GET', template: '/v1/books/{name}' },
    ],
  });
  expect(byName.get('listBooks')).toEqual({
    rules: [{ method: 'GET', template: '/v1/{parent=shelves/*}/books', responseBody: 'books' }],
  });
  expect(byName.get('updateBook')).toEqual({
    rules: [{ method: 'PATCH', template: '/v1/{book.name=shelves/*/books/*}', body: 'book' }],
  });
  expect(byName.get('ticks')).toEqual({ idempotencyLevel: 'NO_SIDE_EFFECTS', rules: [] });
  expect(byName.get('echo')).toBeUndefined();
  expect(
    writtenRulesOf(method('GetBook')).map((written) => {
      return [written.binding, written.custom, written.nested];
    })
  ).toEqual([
    [undefined, false, false],
    [0, false, false],
  ]);
});

test('writes every field of every message a binding reaches, by number and JSON name, the enums they name with their aliases in order, and enters no well-known type', () => {
  const blueprint = transcoding();
  const messages = new Map(
    (blueprint.proto?.messages ?? []).map((message) => {
      return [message.fullName, message] as const;
    })
  );
  const edges = messages.get('bead.transcoding.v1.Edges');

  expect(messages.get('google.protobuf.Empty')).toEqual({
    fullName: 'google.protobuf.Empty',
    file: 'google/protobuf/empty.proto',
  });
  expect(messages.has('google.protobuf.Timestamp')).toBe(false);
  expect(
    edges?.fields?.map((field) => {
      return field.fieldNumber;
    })
  ).toEqual(
    [...(edges?.fields ?? [])]
      .map((field) => {
        return field.fieldNumber;
      })
      .sort((one, other) => {
        return one - other;
      })
  );
  expect(
    messages.get('bead.transcoding.v1.Everything')?.fields?.find((field) => {
      return field.fieldName === 'custom_named';
    })?.jsonName
  ).toBe('renamed');
  expect(
    blueprint.proto?.enums?.find((entry) => {
      return entry.fullName === 'bead.transcoding.v1.Aliased';
    })?.values
  ).toEqual([
    { name: 'ALIASED_UNSPECIFIED', number: 0 },
    { name: 'ALIASED_FIRST', number: 1 },
    { name: 'ALIASED_SECOND', number: 1 },
  ]);
  expect(
    blueprint.proto?.enums?.some((entry) => {
      return entry.fullName === 'google.protobuf.NullValue';
    })
  ).toBe(false);

  const shapes = shapesOf(boundMessagesOf(input()));

  expect(shapes.messages.get('google.protobuf.Empty')?.fields).toBeUndefined();
});

test('refuses a variable whose field path names no field, passes a repeated or a well-known field, or ends at a message', () => {
  const request = method('UpdateBook').input;

  expect(variableRefusalOf(request, 'book.name')).toBeUndefined();
  expect(variableRefusalOf(request, 'nope')).toBe(`names no field nope of ${request.typeName}`);
  expect(variableRefusalOf(request, 'book')).toBe('ends at the message field book');
  expect(variableRefusalOf(request, 'update_mask.paths')).toBe(
    'passes through update_mask, which holds no message of fields of its own'
  );
});
