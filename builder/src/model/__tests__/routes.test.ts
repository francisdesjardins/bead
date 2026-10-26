import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint, IMessageEntry, IProcedureEntry, IServiceEntry } from '../blueprint.ts';
import {
  comparePrecedence,
  defaultTemplateOf,
  hasDefaultGet,
  matchesSegments,
  parseTemplate,
  PREFIX,
  queryCarries,
  routesOf,
  shapeOf,
  sharedPathsOf,
  templateOf,
} from '../routes.ts';

const TRANSCODING = new URL('../../../../spec/transcoding.json', import.meta.url);

// a templates entry of spec/transcoding.json
interface ITemplatesEntry {
  readonly name: string;
  readonly templates: readonly string[];
  readonly paths?: readonly { readonly path: string; readonly route: number | null }[];
  readonly refused?: string;
  readonly tie?: boolean;
}

const entries = (): ITemplatesEntry[] => {
  return (JSON.parse(readFileSync(TRANSCODING, 'utf8')) as { templates: ITemplatesEntry[] })
    .templates;
};

// a segment once percent-decoded, or as it is where it does not decode
const decodedOf = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// a raw path's segments and its verb, as transcoding 3.6 and 3.7 read one; none where a segment is
// empty, `.` or `..`, raw or once decoded
const splitOf = (path: string): { segments: string[]; verb?: string } | undefined => {
  const segments = path.slice(1).split('/');
  const last = segments.at(-1) ?? '';
  const at = last.lastIndexOf(':');
  const verb = at === -1 ? undefined : last.slice(at + 1);

  if (at !== -1) {
    segments[segments.length - 1] = last.slice(0, at);
  }

  if (
    segments.some((segment) => {
      return ['', '.', '..'].includes(decodedOf(segment));
    })
  ) {
    return undefined;
  }

  return { segments, ...(verb === undefined ? {} : { verb }) };
};

const routeOf = (templates: readonly string[], path: string): number | null => {
  const split = splitOf(path);
  const parsed = templates.map(templateOf);
  let best: number | null = null;

  if (split === undefined) {
    return null;
  }

  for (const [index, template] of parsed.entries()) {
    const current = best === null ? undefined : parsed[best];

    if (
      matchesSegments(template, split) &&
      (current === undefined ||
        comparePrecedence(template, { other: current, count: split.segments.length }) < 0)
    ) {
      best = index;
    }
  }

  return best;
};

const service: IServiceEntry = {
  serviceName: 'Books',
  serviceId: 1,
  serviceRevision: 1,
  failures: [],
  reserved: { procedureIds: [], procedureNames: [], failureCodes: [] },
  procedures: [],
};

const messages = new Map<string, IMessageEntry>([
  [
    'x.Request',
    {
      fullName: 'x.Request',
      file: 'x.proto',
      fields: [
        {
          fieldName: 'name',
          fieldNumber: 1,
          jsonName: 'name',
          type: { scalar: 'string' },
          presence: 'implicit',
        },
        {
          fieldName: 'at',
          fieldNumber: 2,
          jsonName: 'at',
          type: { message: 'google.protobuf.Timestamp' },
          presence: 'explicit',
        },
        {
          fieldName: 'sub',
          fieldNumber: 3,
          jsonName: 'sub',
          type: { message: 'x.Request' },
          presence: 'explicit',
        },
      ],
    },
  ],
  [
    'x.Mapped',
    {
      fullName: 'x.Mapped',
      file: 'x.proto',
      fields: [
        {
          fieldName: 'name',
          fieldNumber: 1,
          jsonName: 'name',
          type: { scalar: 'string' },
          presence: 'implicit',
        },
        {
          fieldName: 'labels',
          fieldNumber: 2,
          jsonName: 'labels',
          type: { scalar: 'string' },
          label: 'map',
          key: 'string',
          presence: 'implicit',
        },
      ],
    },
  ],
]);

const procedureOf = (request: string, http?: IProcedureEntry['http']): IProcedureEntry => {
  return {
    procedureId: 1,
    procedureName: 'getBook',
    procedureKind: 'request',
    request: { encoding: 'proto', message: request },
    result: { encoding: 'proto', message: request },
    admission: 'none',
    failures: [],
    ...(http === undefined ? {} : { http }),
  };
};

test("parses a template as http.proto's grammar states it, and refuses any other by spec/transcoding.json's reasons", () => {
  const refused = entries().filter((entry) => {
    return entry.refused !== undefined;
  });

  expect(refused.length).toBeGreaterThan(0);

  for (const entry of refused) {
    expect(parseTemplate(entry.templates[0] ?? ''), entry.name).toEqual({
      kind: 'refused',
      reason: entry.refused,
    });
  }

  expect(templateOf('/v1/{name=shelves/*/books/*}:archive')).toEqual({
    text: '/v1/{name=shelves/*/books/*}:archive',
    segments: [
      { kind: 'literal', text: 'v1' },
      { kind: 'literal', text: 'shelves' },
      { kind: 'star' },
      { kind: 'literal', text: 'books' },
      { kind: 'star' },
    ],
    variables: [{ fieldPath: 'name', start: 1, end: 5 }],
    verb: 'archive',
  });
});

test("ties two templates one up to their variables' names, and plays spec/transcoding.json's precedence", () => {
  for (const entry of entries()) {
    const [one = '', other = ''] = entry.templates;

    if (entry.tie !== undefined) {
      expect(shapeOf(templateOf(one)) === shapeOf(templateOf(other)), entry.name).toBe(entry.tie);
    }

    for (const path of entry.paths ?? []) {
      expect(routeOf(entry.templates, path.path), `${entry.name}: ${path.path}`).toBe(path.route);
    }
  }
});

test('finds the paths two templates both match, a ** of none and of one tried', () => {
  expect(sharedPathsOf(templateOf('/api/**'), templateOf('/api/Books/getBook'))).toEqual([
    { segments: ['api', 'Books', 'getBook'] },
  ]);
  expect(
    sharedPathsOf(templateOf('/v1/{name=operations}'), templateOf('/v1/{name=operations/**}'))
  ).toEqual([{ segments: ['v1', 'operations'] }]);
  expect(sharedPathsOf(templateOf('/v1/a'), templateOf('/v1/b'))).toEqual([]);
  expect(sharedPathsOf(templateOf('/v1/{a}:x'), templateOf('/v1/{b}:y'))).toEqual([]);
});

test("a procedure's routes: its default POST, its default GET where it is NO_SIDE_EFFECTS and the query carries its request, then its rules; none for a command", () => {
  const marked = procedureOf('x.Request', {
    idempotencyLevel: 'NO_SIDE_EFFECTS',
    rules: [{ method: 'GET', template: '/v1/books/{name}', responseBody: 'name' }],
  });

  expect(defaultTemplateOf(service, { procedure: marked, prefix: '/rpc' })).toBe(
    '/rpc/Books/getBook'
  );
  expect(routesOf(service, { procedure: marked, messages })).toEqual([
    { method: 'POST', template: '/api/Books/getBook', body: '*', origin: { kind: 'post' } },
    { method: 'GET', template: '/api/Books/getBook', origin: { kind: 'get' } },
    {
      method: 'GET',
      template: '/v1/books/{name}',
      responseBody: 'name',
      origin: { kind: 'rule', index: 0 },
    },
  ]);
  expect(
    hasDefaultGet(
      procedureOf('x.Mapped', { idempotencyLevel: 'NO_SIDE_EFFECTS', rules: [] }),
      messages
    )
  ).toBe(false);
  expect(hasDefaultGet(procedureOf('x.Request'), messages)).toBe(false);
  expect(
    routesOf(service, { procedure: { ...marked, procedureKind: 'command' }, messages })
  ).toEqual([]);
});

test('the query carries a scalar, a Timestamp and a message of its own fields, a message it meets again among them, and never a map', () => {
  expect(queryCarries('x.Request', { messages })).toBe(true);
  expect(queryCarries('x.Mapped', { messages })).toBe(false);
  expect(queryCarries('x.Mapped', { messages, bound: new Set(['labels']) })).toBe(true);
});

test('a prefix is / and segments of the unreserved characters, none . or .., no / at its end', () => {
  expect(
    ['/api', '/v1/rpc', '/a.b~c_d-e'].every((prefix) => {
      return PREFIX.test(prefix);
    })
  ).toBe(true);
  expect(
    ['api', '/api/', '/', '/a//b', '/./a', '/a/..', '/a b'].some((prefix) => {
      return PREFIX.test(prefix);
    })
  ).toBe(false);
});

test('a blueprint written by hand has its default routes with nothing written', () => {
  const blueprint = JSON.parse(
    readFileSync(new URL('../../../../spec/interop-blueprint.json', import.meta.url), 'utf8')
  ) as IBlueprint;
  const [interop] = blueprint.services;

  expect(interop).toBeDefined();
  expect(
    routesOf(interop ?? service, {
      procedure: interop?.procedures[0] ?? procedureOf('x.Request'),
      messages: new Map(),
    })
  ).toEqual([
    { method: 'POST', template: '/api/Interop/echo', body: '*', origin: { kind: 'post' } },
  ]);
});
