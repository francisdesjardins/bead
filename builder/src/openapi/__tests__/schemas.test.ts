import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { hasError } from '../../diagnostics.ts';
import { editionRoot } from '../../front-end/__tests__/derive.ts';
import type { IBlueprint, IFieldEntry } from '../../model/blueprint.ts';
import {
  BASE64_PATTERN,
  componentSchemasOf,
  DURATION_PATTERN,
  enumSchemaOf,
  FIELD_MASK_PATTERN,
  fieldSchemaOf,
  objectSchemaOf,
  scalarSchemaOf,
  TIMESTAMP_PATTERN,
  typeSchemaOf,
} from '../schemas.ts';

const MESSAGES = fileURLToPath(new URL('../../../test/messages/', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../../spec/', import.meta.url));

const takes = (pattern: string, values: readonly string[]): boolean[] => {
  const compiled = new RegExp(pattern, 'u');

  return values.map((value) => {
    return compiled.test(value);
  });
};

test("each well-known form's pattern takes exactly what Bead's mapping reads of it, in ECMA-262's dialect", () => {
  expect(
    takes(TIMESTAMP_PATTERN, [
      '2026-02-28T00:00:00Z',
      '0001-01-01T00:00:00.123456789+23:59',
      '2026-01-01T00:00:00-00:00',
      '0000-01-01T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01t00:00:00z',
      '2026-01-01T00:00:00.1234567890Z',
      '2026-01-01T00:00:60Z',
      '2026-13-01T00:00:00Z',
    ])
  ).toEqual([true, true, true, false, false, false, false, false, false]);
  expect(
    takes(DURATION_PATTERN, ['1s', '-0.5s', '1.123456789s', '01s', '1.1234567891s', '1'])
  ).toEqual([true, true, true, false, false, false]);
  expect(
    takes(BASE64_PATTERN, ['AQ==', 'AQ', 'AQE=', '-_8', '+/8=', '', 'AQ=', 'AQ===', '+_8=', 'A'])
  ).toEqual([true, true, true, true, true, true, false, false, false, false]);
  expect(takes(FIELD_MASK_PATTERN, ['fooBar,a.b', '', 'a', 'FooBar', 'a,,b', 'a.', '_a'])).toEqual([
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
});

test('a scalar its form: a 32-bit integer of its range, a 64-bit one its digits, a float a number or a word, bytes base64', () => {
  expect(scalarSchemaOf('uint32')).toEqual({ type: 'integer', minimum: 0, maximum: 4_294_967_295 });
  expect(scalarSchemaOf('uint64')).toMatchObject({
    type: 'string',
    format: 'uint64',
    pattern: '^(0|[1-9][0-9]{0,19})$',
  });
  expect(scalarSchemaOf('float')).toEqual({
    anyOf: [
      {
        type: 'number',
        format: 'float',
        exclusiveMinimum: -(2 ** 128 - 2 ** 103),
        exclusiveMaximum: 2 ** 128 - 2 ** 103,
      },
      { enum: ['NaN', 'Infinity', '-Infinity'] },
    ],
  });
  expect(scalarSchemaOf('bytes')).toMatchObject({ contentEncoding: 'base64' });
  expect(typeSchemaOf({ wrapper: 'bool' })).toEqual({ type: 'boolean' });
  expect(typeSchemaOf({ message: 'google.protobuf.Int32Value' })).toEqual(scalarSchemaOf('int32'));
  expect(typeSchemaOf({ enum: 'google.protobuf.NullValue' })).toEqual({ type: 'null' });
  expect(typeSchemaOf({ message: 'x.v1.Thing' })).toEqual({
    $ref: '#/components/schemas/x.v1.Thing',
  });
});

test('a repeated field an array, a map an object whose names are its key form, an enum its names or a number', () => {
  const map: IFieldEntry = {
    fieldName: 'by_id',
    fieldNumber: 1,
    jsonName: 'byId',
    type: { scalar: 'string' },
    label: 'map',
    key: 'uint32',
    presence: 'implicit',
    description: 'By id.',
    deprecated: true,
  };

  expect(fieldSchemaOf(map)).toEqual({
    type: 'object',
    propertyNames: { pattern: '^(0|[1-9][0-9]*)$' },
    additionalProperties: { type: 'string' },
    description: 'By id.',
    deprecated: true,
  });
  const list: IFieldEntry = {
    fieldName: 'tags',
    fieldNumber: 2,
    jsonName: 'tags',
    type: { scalar: 'string' },
    label: 'repeated',
    presence: 'implicit',
  };

  expect(fieldSchemaOf(list)).toMatchObject({
    type: 'array',
    items: { type: 'string' },
  });
  expect(
    enumSchemaOf({
      fullName: 'x.v1.Aliased',
      file: 'x.proto',
      values: [
        { name: 'A', number: 0 },
        { name: 'B', number: 1 },
        { name: 'C', number: 1 },
      ],
    })
  ).toMatchObject({ anyOf: [{ type: 'string', enum: ['A', 'B', 'C'] }, { type: 'integer' }] });
});

test("a message's rules in JSON Schema's words, and what no keyword holds in its description", () => {
  const checked = checkRoots([MESSAGES]);

  if (checked.blueprint === undefined) {
    throw new Error('test/messages: no blueprint');
  }

  const member = componentSchemasOf(checked.blueprint)['bead.messages.v1.Member'] as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    allOf: unknown[];
  };

  expect(member.required).toEqual(['address']);
  expect(member.properties['age']).toMatchObject({
    allOf: [{ type: 'integer' }, { minimum: 13, maximum: 130 }],
  });
  expect(member.properties['score']).toMatchObject({
    allOf: [{}, { anyOf: [{ exclusiveMaximum: -1 }, { exclusiveMinimum: 1 }] }],
  });
  expect(member.properties['tags']).toMatchObject({
    allOf: [{ type: 'array' }, { minItems: 1 }, { maxItems: 5 }, { uniqueItems: true }],
  });
  expect(member.properties['card']).toMatchObject({
    allOf: [{}, { minLength: 16, maxLength: 16 }],
  });
  // * a Unicode class beadc does not write in ECMA-262's words, a 64-bit range and bytes: the gateway's
  expect(member.properties['name']?.['description']).toContain(
    'Beside this schema, the gateway refuses a value of which it says: does not match regex pattern'
  );
  expect(member.properties['account']?.['description']).toContain('must be greater than 0');
  expect(member.properties['photo']?.['description']).toContain('does not have prefix');
  // * its oneof required, one of its members there
  expect(member.allOf).toContainEqual({
    anyOf: [{ required: ['card'] }, { required: ['account'] }],
  });
});

// the blueprint of a root, which no error refuses
const blueprintOf = (root: string): IBlueprint => {
  const checked = checkRoots([root]);

  expect(hasError(checked.diagnostics), JSON.stringify(checked.diagnostics)).toBe(false);

  if (checked.blueprint === undefined) {
    throw new Error(`${root}: no blueprint`);
  }

  return checked.blueprint;
};

const REQUIRED = 'features.field_presence = LEGACY_REQUIRED';

// transcoding 11.7 and 11.5: what protobuf requires, required, beside what the rules require
test('requires each field of LEGACY_REQUIRED presence in its message’s schema, beside its rules’ required', () => {
  const root = editionRoot('required-fields', {
    imports: ['buf/validate/validate.proto'],
    messages: [
      '// A card.',
      'message Card {',
      `  string number = 1 [${REQUIRED}];`,
      '  string holder = 2;',
      '}',
      '',
      '// A member.',
      'message Member {',
      `  string name = 1 [${REQUIRED}];`,
      `  string address = 2 [${REQUIRED}, (buf.validate.field).required = true];`,
      '  string note = 3 [(buf.validate.field).required = true];',
      '  int32 age = 4;',
      '  Card card = 5;',
      '}',
    ],
    rpcs: [['Join', 'Member', 'post: "/v1/members/{card.holder}:join" body: "*"']],
  });
  const blueprint = blueprintOf(root);
  const schemas = componentSchemasOf(blueprint) as Record<string, { required?: string[] }>;
  const messages = new Map(
    (blueprint.proto?.messages ?? []).map((message) => {
      return [message.fullName, message] as const;
    })
  );
  const member = messages.get('x.v1.Member');

  if (member === undefined) {
    throw new Error('x.v1.Member: no entry');
  }

  // * by number, each once: address protobuf's and its rules' both
  expect(schemas['x.v1.Member']?.required).toEqual(['name', 'address', 'note']);
  expect(schemas['x.v1.Card']?.required).toEqual(['number']);

  // * a field a variable binds into, held present by it, required where its message keeps a field
  // protobuf requires left to the body
  expect(objectSchemaOf(member, { messages, bound: new Set(['card.holder']) })['required']).toEqual(
    ['name', 'address', 'card']
  );
  expect(objectSchemaOf(member, { messages, bound: new Set(['card.number']) })['required']).toEqual(
    ['name', 'address']
  );

  // * spec/transcoding.proto's own
  const transcoding = checkRoots([SPEC], { files: ['transcoding.proto'] }).blueprint;
  const spec = (transcoding === undefined ? {} : componentSchemasOf(transcoding)) as Record<
    string,
    { required?: string[] }
  >;

  expect(spec['bead.transcoding.v1.Needs']?.required).toEqual(['name', 'count']);
  expect(spec['bead.transcoding.v1.NeedsUpdate']?.required).toEqual(['updateMask']);
  expect(spec['bead.transcoding.v1.Requiring']?.required).toBeUndefined();
});
