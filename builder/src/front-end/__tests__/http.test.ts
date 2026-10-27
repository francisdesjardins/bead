import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DescMethod } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { compile } from '../../compile.ts';
import { hasError } from '../../diagnostics.ts';
import type { IBlueprint, IFieldEntry } from '../../model/blueprint.ts';
import { boundMessagesOf, shapesOf, variableRefusalOf, writtenRulesOf } from '../http.ts';
import { readSet } from '../input.ts';
import { editionRoot, RULE_FIXTURES } from './derive.ts';

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

// the messages of the findings of `rule` over a root
const findingsOf = (root: string, rule: string): string[] => {
  return checkRoots([root])
    .diagnostics.filter((diagnostic) => {
      return diagnostic.rule === rule;
    })
    .map((diagnostic) => {
      return diagnostic.message;
    });
};

const REQUIRED = 'features.field_presence = LEGACY_REQUIRED';

test('marks a field of LEGACY_REQUIRED presence legacyRequired and requires legacy-required', () => {
  const blueprint = transcoding();
  const fieldsOf = (fullName: string): readonly IFieldEntry[] => {
    return (
      blueprint.proto?.messages.find((message) => {
        return message.fullName === fullName;
      })?.fields ?? []
    );
  };
  const requiredOf = (fullName: string): string[] => {
    return fieldsOf(fullName)
      .filter((field) => {
        return field.legacyRequired === true;
      })
      .map((field) => {
        return field.fieldName;
      });
  };

  // * a required field tracks presence, as proto2's required does; every other field holds no member
  expect(fieldsOf('bead.transcoding.v1.Needs').slice(0, 2)).toEqual([
    {
      fieldName: 'name',
      fieldNumber: 1,
      jsonName: 'name',
      type: { scalar: 'string' },
      presence: 'explicit',
      legacyRequired: true,
    },
    {
      fieldName: 'count',
      fieldNumber: 2,
      jsonName: 'count',
      type: { scalar: 'int32' },
      presence: 'explicit',
      legacyRequired: true,
    },
  ]);
  expect(requiredOf('bead.transcoding.v1.Needs')).toEqual(['name', 'count']);
  expect(requiredOf('bead.transcoding.v1.NeedsUpdate')).toEqual(['update_mask']);
  expect(requiredOf('bead.transcoding.v1.Requiring')).toEqual([]);
  expect(requiredOf('bead.transcoding.v1.Everything')).toEqual([]);
  expect(blueprint.requires).toEqual(['legacy-required', 'validate']);

  // * a .proto that requires no field requires no feature of it
  expect(checkRoots([join(RULE_FIXTURES, 'HTTP_UPDATE_MASK')]).blueprint?.requires).toEqual([]);
});

test('refuses a route whose required field no part of its request can set (HTTP_REQUIRED_UNBOUND)', () => {
  const root = editionRoot('required-unbound', {
    imports: ['google/protobuf/empty.proto', 'google/protobuf/struct.proto'],
    messages: [
      '// Plain.',
      'message Plain {',
      '  string name = 1;',
      '}',
      '',
      '// Maps alone.',
      'message Maps {',
      '  map<string, string> labels = 1;',
      '}',
      '',
      '// A message that requires itself.',
      'message Loop {',
      `  Loop next = 1 [${REQUIRED}];`,
      '}',
      '',
      '// A message a variable holds present.',
      'message Inner {',
      '  string name = 1;',
      `  google.protobuf.Struct filter = 2 [${REQUIRED}];`,
      '}',
      '',
      '// A Struct required.',
      'message StructRequest {',
      '  string name = 1;',
      `  google.protobuf.Struct filter = 2 [${REQUIRED}];`,
      '  string note = 3;',
      '}',
      '',
      '// An Empty required.',
      'message EmptyRequest {',
      '  string name = 1;',
      `  google.protobuf.Empty nothing = 2 [${REQUIRED}];`,
      '}',
      '',
      '// A message of maps alone required.',
      'message MapsRequest {',
      '  string name = 1;',
      `  Maps maps = 2 [${REQUIRED}];`,
      '}',
      '',
      '// A message that requires itself, required.',
      'message LoopRequest {',
      '  string name = 1;',
      `  Loop loop = 2 [${REQUIRED}];`,
      '}',
      '',
      '// A message the query sets, required.',
      'message PlainRequest {',
      '  string name = 1;',
      `  Plain plain = 2 [${REQUIRED}];`,
      '}',
      '',
      '// A message holding a required Struct.',
      'message HeldRequest {',
      '  Inner inner = 1;',
      '}',
    ],
    rpcs: [
      ['FindStruct', 'StructRequest', 'get: "/v1/structs/{name}"'],
      ['PostStruct', 'StructRequest', 'post: "/v1/structs/{name}:post" body: "*"'],
      ['NoteStruct', 'StructRequest', 'post: "/v1/structs/{name}:note" body: "note"'],
      ['FindEmpty', 'EmptyRequest', 'get: "/v1/empties/{name}"'],
      ['FindMaps', 'MapsRequest', 'get: "/v1/maps/{name}"'],
      ['FindLoop', 'LoopRequest', 'get: "/v1/loops/{name}"'],
      ['FindPlain', 'PlainRequest', 'get: "/v1/plains/{name}"'],
      ['FindHeld', 'HeldRequest', 'get: "/v1/held/{inner.name}"'],
      ['FindUnheld', 'HeldRequest', 'get: "/v1/unheld"'],
    ],
  });
  const unset = (method: string, path: string): string => {
    return `x.v1.XService.${method}'s ${method === 'NoteStruct' ? 'post' : 'get'} rule leaves ${path} unset whatever its caller sends: protobuf requires it, and neither its template, its body nor its query can set it, so a gateway refuses every call to it (transcoding 5.2)`;
  };

  // * a Struct, an Empty, a message of maps alone or one required of itself, the query sets none;
  // a body of * or of that field sets it, the query sets a message's scalar, and a message neither
  // required nor held present may be left out whole
  expect(findingsOf(root, 'HTTP_REQUIRED_UNBOUND')).toEqual([
    unset('FindStruct', 'filter'),
    unset('NoteStruct', 'filter'),
    unset('FindEmpty', 'nothing'),
    unset('FindMaps', 'maps'),
    unset('FindLoop', 'loop.next'),
    unset('FindHeld', 'inner.filter'),
  ]);
});

test('warns of a patch whose body’s message holds a required field (HTTP_PATCH_REQUIRED)', () => {
  const root = editionRoot('patch-required', {
    imports: ['google/protobuf/field_mask.proto'],
    messages: [
      '// A thing, its name and its count required.',
      'message Thing {',
      `  string name = 1 [${REQUIRED}];`,
      `  int32 count = 2 [${REQUIRED}];`,
      '  string note = 3;',
      '}',
      '',
      '// A note, nothing required.',
      'message Note {',
      '  string name = 1;',
      '  string text = 2;',
      '}',
      '',
      '// A patch of a thing.',
      'message UpdateThingRequest {',
      '  Thing thing = 1;',
      '  google.protobuf.FieldMask update_mask = 2;',
      '}',
      '',
      '// A patch of a thing, no mask.',
      'message ReplaceThingRequest {',
      '  Thing thing = 1;',
      '}',
      '',
      '// A patch of a note.',
      'message UpdateNoteRequest {',
      '  Note note = 1;',
      '  google.protobuf.FieldMask update_mask = 2;',
      '}',
    ],
    rpcs: [
      ['UpdateThing', 'UpdateThingRequest', 'patch: "/v1/things/{thing.name}" body: "thing"'],
      ['PatchThing', 'UpdateThingRequest', 'patch: "/v1/whole/{thing.name}" body: "*"'],
      ['ReplaceThing', 'ReplaceThingRequest', 'patch: "/v1/replaced/{thing.name}" body: "thing"'],
      ['UpdateNote', 'UpdateNoteRequest', 'patch: "/v1/notes/{note.name}" body: "note"'],
    ],
  });

  // * the derived mask names the count, which no variable binds; a body of *, a request of no mask
  // and a body's message of no required field derive none of it
  expect(findingsOf(root, 'HTTP_PATCH_REQUIRED')).toEqual([
    "x.v1.XService.UpdateThing's patch rule derives its update_mask from its body, whose x.v1.Thing requires count: the mask names it on every call, and a caller keeps it unchanged only by an update_mask of its own (transcoding 4.5, AIP-203)",
  ]);
  // * spec/transcoding.proto's own patch, its name bound by its variable
  expect(
    checkRoots([SPEC], { files: ['transcoding.proto'] })
      .diagnostics.filter((diagnostic) => {
        return diagnostic.rule === 'HTTP_PATCH_REQUIRED';
      })
      .map((diagnostic) => {
        return diagnostic.message.split(':')[0];
      })
  ).toEqual([
    "bead.transcoding.v1.TranscodingService.UpdateNeeds's patch rule derives its update_mask from its body, whose bead.transcoding.v1.Needs requires count",
  ]);
});
