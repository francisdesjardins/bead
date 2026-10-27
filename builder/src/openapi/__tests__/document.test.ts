import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { checkRoots } from '../../check.ts';
import { editionRoot } from '../../front-end/__tests__/derive.ts';
import { hasError } from '../../diagnostics.ts';
import type { IBlueprint } from '../../model/blueprint.ts';
import {
  comparePrecedence,
  type IServedRoute,
  matchesSegments,
  servedRoutesOf,
  templateOf,
} from '../../model/routes.ts';
import { documentOf, documentValueOf } from '../document.ts';
import { messageSchemaOf } from '../schemas.ts';

const SPEC = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const TRANSCODING = new URL('../../../../spec/transcoding.json', import.meta.url);
const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);
// OpenAPI 3.1's own schema of a document, 2022-10-07, vendored and pinned by its sha256
const OAS_SCHEMA = new URL('../../../test/openapi/schema-2022-10-07.json', import.meta.url);
const OAS_SHA256 = 'da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0';

// ! the readings of spec/transcoding.json that Bead's mapping takes beside the one form a schema
// states (transcoding 5.2 to 5.4, 11.9), each by its name: no schema of the document takes them,
// since each schema is the form Bead's proto JSON form writes
const BESIDE_THE_FORM: Readonly<Record<string, string>> = Object.freeze({
  'a field by its proto name': "a field's proto name",
  'a field of a JSON name of its own, by its proto name': "a field's proto name",
  'null leaves each field unset': 'null for a field, its default',
  "NULL_VALUE sets a oneof's NullValue": "a NullValue by its value's name",
  "a oneof's null member before its other": "null beside a oneof's member",
  "a oneof's null member after its other": "null beside a oneof's member",
  'an int32 as a string of an exponent': 'a 32-bit integer as a string',
  'an int32 as a string of a fraction of zero': 'a 32-bit integer as a string',
  'an sint32 as a string': 'a 32-bit integer as a string',
  'an sfixed32 at its least, as a string': 'a 32-bit integer as a string',
  'a fixed32 as a string of an exponent': 'a 32-bit integer as a string',
  'an int64 past 2^53 as a number, read exactly': 'a 64-bit integer as a number',
  'an int64 at its largest as a number, read exactly': 'a 64-bit integer as a number',
  'an int64 written 1.0': 'a 64-bit integer as a number',
  'an int64 written 1e2': 'a 64-bit integer as a number',
  'a UInt64Value at its largest as a number, read exactly': 'a 64-bit integer as a number',
  'an sfixed64 past 2^53 as a number, read exactly': 'a 64-bit integer as a number',
  'a float as a string': 'a float as a string',
  'a double as a string of an exponent': 'a double as a string',
  'a body of every kind of field': 'a 64-bit integer as a number',
});

// a step of an exchange of spec/transcoding.json: a request sent, or a response expected
interface IStep {
  readonly on?: string;
  readonly send?: { readonly head: string };
  readonly expect?: {
    readonly status: number;
    readonly fields?: Readonly<Record<string, string | null>>;
    readonly body?: string;
  };
}

interface IBody {
  readonly name: string;
  readonly message: string;
  readonly body?: string;
  readonly payload?: string;
  readonly refused?: string;
}

const transcoding = (): {
  readonly readings: IBody[];
  readonly writings: IBody[];
  readonly exchanges: { readonly name: string; readonly steps: IStep[] }[];
} => {
  return JSON.parse(readFileSync(TRANSCODING, 'utf8')) as {
    readings: IBody[];
    writings: IBody[];
    exchanges: { name: string; steps: IStep[] }[];
  };
};

// the route a request line's method and path take among `routes`, by 3.5's precedence, a HEAD as
// its GET
const routeOf = (routes: readonly IServedRoute[], line: string): IServedRoute | undefined => {
  const [given = '', target = ''] = line.split(' ');
  const method = given === 'HEAD' ? 'GET' : given;
  const [path = ''] = target.split('?');
  const segments = path.slice(1).split('/');
  const last = segments.at(-1) ?? '';
  const colon = last.lastIndexOf(':');
  const split = {
    segments: colon === -1 ? segments : [...segments.slice(0, -1), last.slice(0, colon)],
    ...(colon === -1 ? {} : { verb: last.slice(colon + 1) }),
  };
  let best: IServedRoute | undefined;

  for (const route of routes) {
    const template = templateOf(route.template);

    if (
      route.method === method &&
      matchesSegments(template, split) &&
      (best === undefined ||
        comparePrecedence(template, {
          other: templateOf(best.template),
          count: split.segments.length,
        }) < 0)
    ) {
      best = route;
    }
  }

  return best;
};

const transcodingBlueprint = (): IBlueprint => {
  const checked = checkRoots([SPEC], { files: ['transcoding.proto'] });

  expect(hasError(checked.diagnostics)).toBe(false);

  if (checked.blueprint === undefined) {
    throw new Error('spec/transcoding.proto: no blueprint');
  }

  return checked.blueprint;
};

// OpenAPI 3.1's schema, its `$dynamicRef` to a schema object read as the reference it resolves to,
// which ajv's 2020 dialect follows from no dynamic scope here
const oasValidator = (): ReturnType<Ajv2020['compile']> => {
  const text = readFileSync(OAS_SCHEMA, 'utf8');

  expect(createHash('sha256').update(text).digest('hex')).toBe(OAS_SHA256);

  const schema = JSON.parse(
    text.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')
  ) as object;

  return new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
};

// the document's own schemas, `format` an annotation as OpenAPI 3.1's base dialect makes it
const schemasOf = (document: object): Ajv2020 => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  for (const format of ['date-time', 'int64', 'uint64', 'float', 'double', 'uri-reference']) {
    ajv.addFormat(format, true);
  }

  ajv.addSchema(document, 'document.json');

  return ajv;
};

// transcoding 11.2: OpenAPI 3.1.1, its dialect, its info
test("spec/transcoding.proto's document is OpenAPI 3.1.1, by OpenAPI 3.1's own schema", () => {
  const document = documentValueOf(transcodingBlueprint(), { prefix: '/api' });
  const validate = oasValidator();

  expect(document).toMatchObject({
    openapi: '3.1.1',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: { title: 'Transcoding', version: 'Transcoding.1' },
  });
  expect(validate(document), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
});

// transcoding 11.7, 11.8 and 11.9: each schema the one form Bead writes, its patterns, what none
// carries
test('every body Bead writes is valid against the document, and every reading it takes in the form a schema states', () => {
  const document = documentValueOf(transcodingBlueprint(), { prefix: '/api' });
  const ajv = schemasOf(document);
  const { readings, writings } = transcoding();
  const beside: string[] = [];
  const valid = (each: IBody): boolean => {
    const validate = ajv.getSchema(`document.json#/components/schemas/${each.message}`);

    if (validate === undefined) {
      throw new Error(`${each.message}: no schema of the document`);
    }

    return validate(JSON.parse(each.body ?? 'null')) === true;
  };

  for (const writing of writings) {
    if (writing.body !== undefined) {
      expect(valid(writing), writing.name).toBe(true);
    }
  }

  for (const reading of readings) {
    if (reading.payload !== undefined && reading.body !== undefined && !valid(reading)) {
      beside.push(reading.name);
    }
  }

  expect(beside.sort()).toEqual(Object.keys(BESIDE_THE_FORM).sort());
});

// transcoding 11.5 and 11.7: what a gateway answers, a result by its route's schema and a failure as
// its problem
test("every JSON body spec/transcoding.json's exchanges answer is valid against the document: a result its route's, a failure a Problem or a ValidationProblem", () => {
  const blueprint = transcodingBlueprint();
  const document = documentValueOf(blueprint, { prefix: '/api' });
  const ajv = schemasOf(document);
  const routes = servedRoutesOf(blueprint, { prefix: '/api' });
  let checked = 0;

  for (const exchange of transcoding().exchanges) {
    const sent = new Map<string, string>();

    for (const step of exchange.steps) {
      const on = step.on ?? 'a';

      if (step.send !== undefined) {
        sent.set(on, step.send.head.split('\r\n')[0] ?? '');
      }

      const body = step.expect?.body;
      const type = step.expect?.fields?.['content-type'];

      // * a HEAD's body is none, and the gateway's own words and its document no schema of it
      if (
        body === undefined ||
        body === '' ||
        body.includes('{words}') ||
        body.includes('{document}')
      ) {
        continue;
      }

      const route = routeOf(routes, sent.get(on) ?? '');
      let schema: string | undefined;

      if (type === 'application/problem+json') {
        schema = body.includes('"errors"') ? 'ValidationProblem' : 'Problem';
      } else if (
        type === 'application/json' &&
        route !== undefined &&
        route.procedure.result.encoding === 'proto'
      ) {
        const result = route.procedure.result.message ?? '';
        const field = blueprint.proto?.messages
          .find((message) => {
            return message.fullName === result;
          })
          ?.fields?.find((each) => {
            return each.fieldName === route.responseBody;
          });

        schema =
          route.responseBody === undefined
            ? result
            : `${result}/properties/${field?.jsonName ?? ''}`;
      }

      if (schema === undefined) {
        continue;
      }

      // * a well-known result, google.protobuf.Empty's among them, is its own form, inline
      const validate =
        ajv.getSchema(`document.json#/components/schemas/${schema}`) ??
        ajv.compile(messageSchemaOf(schema));

      checked += 1;
      expect(validate(JSON.parse(body)), `${exchange.name}: ${body}`).toBe(true);
    }
  }

  expect(checked).toBeGreaterThan(20);
});

// transcoding 11.3, 11.4, 11.5 and 11.6: the operations, their parameters, bodies, responses and
// security
test("a path a route: a multi-segment variable written expanded, each * named by the literal before it, a ** one parameter; an operation's id, its kind, its security and its failures", () => {
  const document = documentValueOf(transcodingBlueprint(), { prefix: '/api' }) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const get = document.paths['/v1/shelves/{shelves}/books/{books}']?.['get'];
  const operation = document.paths['/v1/operations/{operations}']?.['get'];
  const whoAmI = document.paths['/api/Transcoding/whoAmI']?.['post'];
  const judge = document.paths['/api/Transcoding/judge']?.['post'];
  const ticks = document.paths['/api/Transcoding/ticks']?.['post'] as {
    responses: { '200': { content: Record<string, Record<string, unknown>> } };
  };

  expect(get).toMatchObject({
    operationId: 'Transcoding.getBook.http',
    'x-bead': { service: 'Transcoding', procedure: 'getBook', procedureKind: 'request' },
    security: [{}, { credential: [] }],
  });
  expect(((get?.['parameters'] ?? []) as unknown[]).slice(0, 2)).toEqual([
    {
      name: 'shelves',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      'x-bead-variable': 'name',
    },
    {
      name: 'books',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      'x-bead-variable': 'name',
    },
  ]);
  expect(((operation?.['parameters'] ?? []) as unknown[])[0]).toMatchObject({
    name: 'operations',
    in: 'path',
    'x-bead-segments': true,
  });
  expect(document.paths['/api/Transcoding/getBook']?.['post']?.['operationId']).toBe(
    'Transcoding.getBook'
  );
  expect(document.paths['/v1/books/{name}']?.['get']?.['operationId']).toBe(
    'Transcoding.getBook.http1'
  );
  expect(whoAmI).toMatchObject({ security: [{ credential: [] }], responses: { '401': {} } });
  expect(judge).toMatchObject({ responses: { '422': {} } });
  expect(Object.keys(ticks.responses['200'].content).sort()).toEqual([
    'application/json',
    'text/event-stream',
  ]);
  expect(ticks.responses['200'].content['text/event-stream']?.['x-bead-events']).toEqual({
    result: { $ref: '#/components/schemas/bead.transcoding.v1.TicksResponse' },
    message: { $ref: '#/components/schemas/bead.transcoding.v1.Tick' },
    failure: { $ref: '#/components/schemas/Problem' },
  });
});

test("one blueprint gives one sequence of bytes: members sorted, two spaces, a final line feed; a blueprint written by hand's native bindings described as they are", () => {
  const blueprint = JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint;
  const text = documentOf(blueprint, {
    title: 'Interop',
    security: { type: 'apiKey', in: 'header', name: 'x-key' },
  });
  const value = JSON.parse(text) as {
    info: unknown;
    paths: Record<string, Record<string, { requestBody?: unknown }>>;
    components: { securitySchemes: unknown };
  };

  expect(text.endsWith('}\n')).toBe(true);
  expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`);
  expect(Object.keys(value)).toEqual([
    'components',
    'info',
    'jsonSchemaDialect',
    'openapi',
    'paths',
    'tags',
  ]);
  expect(value.info).toEqual({ title: 'Interop', version: 'Interop.2' });
  expect(value.components.securitySchemes).toEqual({
    credential: { type: 'apiKey', in: 'header', name: 'x-key' },
  });
  expect(value.paths['/api/Interop/echo']?.['post']?.requestBody).toEqual({
    required: true,
    content: {
      'application/json': {
        schema: { description: 'A JSON value, the payload as it is (spec 17.5).' },
      },
    },
  });
  // * a command is called by no HTTP client: no route
  expect(value.paths['/api/Interop/clock']).toBeUndefined();
  expect(oasValidator()(value)).toBe(true);
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

// transcoding 11.4: a query's parameter required where protobuf requires its field, down a path of
// fields required or held present by a variable
test('requires a query parameter whose field is required on a path required or held present by a variable', () => {
  const root = editionRoot('required-parameters', {
    imports: ['google/protobuf/field_mask.proto'],
    messages: [
      '// Deep.',
      'message Deep {',
      `  int32 level = 1 [${REQUIRED}];`,
      '}',
      '',
      '// Inner.',
      'message Inner {',
      '  string name = 1;',
      `  int32 count = 2 [${REQUIRED}];`,
      '  Deep deep = 3;',
      '}',
      '',
      '// Outer.',
      'message Outer {',
      `  string id = 1 [${REQUIRED}];`,
      `  int32 size = 2 [${REQUIRED}];`,
      '  Inner inner = 3;',
      '  Inner held = 4;',
      `  Inner kept = 5 [${REQUIRED}];`,
      `  google.protobuf.FieldMask update_mask = 6 [${REQUIRED}];`,
      '}',
    ],
    rpcs: [
      ['Get', 'Outer', 'get: "/v1/outers/{held.name}"'],
      ['Update', 'Outer', 'patch: "/v1/outers/{id}" body: "inner"'],
    ],
  });
  const document = documentValueOf(blueprintOf(root), { prefix: '/api' }) as {
    paths: Record<string, Record<string, { parameters: Record<string, unknown>[] }>>;
  };
  const queryOf = (path: string, method: string): Record<string, boolean> => {
    return Object.fromEntries(
      (document.paths[path]?.[method]?.parameters ?? [])
        .filter((parameter) => {
          return parameter['in'] === 'query';
        })
        .map((parameter) => {
          return [String(parameter['name']), parameter['required'] === true];
        })
    );
  };

  // * held present by its variable, held's count is required; inner's, of a field neither required
  // nor held, is not, nor is a level below a deep no path requires
  expect(queryOf('/v1/outers/{held.name}', 'get')).toEqual({
    id: true,
    size: true,
    'inner.name': false,
    'inner.count': false,
    'inner.deep.level': false,
    'held.count': true,
    'held.deep.level': false,
    'kept.name': false,
    'kept.count': true,
    'kept.deep.level': false,
    updateMask: true,
  });
  // * a PATCH derives its update_mask from its body (transcoding 4.5): no caller need send it
  expect(queryOf('/v1/outers/{id}', 'patch')).toEqual({
    size: true,
    'held.name': false,
    'held.count': false,
    'held.deep.level': false,
    'kept.name': false,
    'kept.count': true,
    'kept.deep.level': false,
    updateMask: false,
  });
  expect(
    document.paths['/v1/outers/{held.name}']?.['get']?.parameters.find((parameter) => {
      return parameter['name'] === 'updateMask';
    })
  ).toMatchObject({
    in: 'query',
    required: true,
    description: expect.stringContaining('update_mask'),
  });
});

// transcoding 11.5: a body less what its variables bind keeps each rule of what remains
test('keeps the rules of a body a variable binds into', () => {
  const root = editionRoot('body-rules', {
    imports: ['buf/validate/validate.proto'],
    messages: [
      '// A book.',
      'message Book {',
      '  string name = 1;',
      '  int32 pages = 2 [(buf.validate.field).int32.gt = 0];',
      '  string title = 3 [(buf.validate.field).required = true];',
      '}',
      '',
      '// An update of a book.',
      'message UpdateBookRequest {',
      '  Book book = 1;',
      '  string reason = 2 [(buf.validate.field).string.min_len = 1];',
      '}',
    ],
    rpcs: [
      ['UpdateBook', 'UpdateBookRequest', 'patch: "/v1/{book.name}" body: "book"'],
      ['RenameBook', 'UpdateBookRequest', 'post: "/v1/{book.name}:rename" body: "*"'],
    ],
  });
  const document = documentValueOf(blueprintOf(root), { prefix: '/api' }) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, { properties: Record<string, unknown> }> };
  };
  const bodyOf = (path: string, method: string): Record<string, unknown> => {
    const body = document.paths[path]?.[method]?.['requestBody'] as {
      content: { 'application/json': { schema: Record<string, unknown> } };
    };

    return body.content['application/json'].schema;
  };
  const book = document.components.schemas['x.v1.Book'];
  const request = document.components.schemas['x.v1.UpdateBookRequest'];
  const inline = {
    type: 'object',
    properties: { pages: book?.properties['pages'], title: book?.properties['title'] },
    additionalProperties: false,
    required: ['title'],
    description: "x.v1.Book. Bead's mapping reads each field by its proto name too.",
  };

  // * each field left to the body keeps its rules, the message's component's own
  expect(book?.properties['pages']).toMatchObject({ allOf: [{ type: 'integer' }, {}] });
  expect(bodyOf('/v1/{book.name}', 'patch')).toEqual(inline);
  expect(bodyOf('/v1/{book.name}:rename', 'post')).toEqual({
    type: 'object',
    properties: { book: inline, reason: request?.properties['reason'] },
    additionalProperties: false,
    description: "x.v1.UpdateBookRequest. Bead's mapping reads each field by its proto name too.",
  });
});
