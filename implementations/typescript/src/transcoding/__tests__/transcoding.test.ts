// ── Transcoding ───────────────────────────────────────────────────────────────

// Bead's HTTP/JSON transcoding, `spec/transcoding.json`, played against the TypeScript side's
// entry, `./transcoding`, and its exchanges against its gateway over a real socket, in process with
// a server of the `Transcoding` service, joined. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { type DescMessage, fromBinary, type Message } from '@bufbuild/protobuf';
import { reflect, type ReflectMessage } from '@bufbuild/protobuf/reflect';
import { expect, test } from '@playwright/test';
import { protoCodecOf } from '../../proto/codec';
import { fromHexadecimal } from '../../router/shared/__tests__/vectors';
import { createTestClock } from '../../transport/shared/__tests__/fixtures';
import { createEventStream, EVENT_STREAM_MEDIA_TYPE, HEARTBEAT } from '../events';
import {
  type Arose,
  createHTTPBinding,
  createJsonForm,
  type Encoding,
  isTie,
  JsonFormError,
  type OwnFailure,
  parseTemplate,
  problemOfFailure,
  problemOfOwn,
  rawPathOf,
  type RequestPlace,
  routeIndexOf,
  templateOf,
  variablesOf,
} from '../transcoding';
import { HTTP_ROUTES } from './generated/bead_http';
import { EdgesSchema, EverythingSchema, RequiringSchema } from './generated/transcoding_pb';
import { NeedsSchema } from './generated/transcoding-required_pb';
import {
  gatewayOptionsOf,
  type IExchangeEntry,
  type IPeer,
  playExchange,
  readOn,
  startTranscoding,
} from './transcoding-service';

// interfaces

interface IEntry {
  clauses: string[];
  name: string;
}

interface ITemplatesEntry extends IEntry {
  paths?: {
    path: string;
    refused?: string;
    route: number | null;
    variables?: Record<string, string>;
    verb?: string;
  }[];
  refused?: string;
  templates: string[];
  tie?: boolean;
}

interface IReadingEntry extends IEntry {
  body?: string;
  bodyBytes?: string;
  message: string;
  payload?: string;
  pointer?: string;
  refused?: string;
}

interface IWritingEntry extends IEntry {
  body?: string;
  message: string;
  payload: string;
  refused?: string;
}

interface IBindingEntry extends IEntry {
  body?: string;
  parameter?: string;
  payload?: string;
  pointer?: string;
  procedure: string;
  refused?: string;
  route: { body?: string; method: string; template: string };
  target: string;
}

interface IFailureEntry extends IEntry {
  failure: {
    arose?: Arose;
    challenge?: string;
    code?: number;
    credential?: true;
    detail?: string;
    encoding?: Encoding;
    own?: OwnFailure;
    parameter?: string;
    pointer?: string;
    scope?: 'application' | 'protocol';
  };
  fields: Record<string, string>;
  problem: string;
  problemTypes?: string | null;
  procedure?: string;
  route?: { body?: string; method: string; template: string };
  status: number;
}

/** An event's data as the file writes it: a JSON text, a text, or bytes in hexadecimal. */
type EventData = string | { raw: string } | { text: string };

interface IEventsEntry extends IEntry {
  body: string;
  contentType: string;
  status: number;
  steps: {
    failure?: { problem: string; status: number };
    heartbeat?: true;
    notification?: EventData;
    result?: EventData;
  }[];
}

interface ITranscodingFile {
  bindings: IBindingEntry[];
  exchanges: IExchangeEntry[];
  events: IEventsEntry[];
  defaults: Record<string, unknown> & { challenge: string; problemTypes: string | null };
  failures: IFailureEntry[];
  readings: IReadingEntry[];
  templates: ITemplatesEntry[];
  transcodingVersion: string;
  writings: IWritingEntry[];
}

// constants

const FILE = JSON.parse(
  readFileSync(new URL('../../../../../spec/transcoding.json', import.meta.url), 'utf8')
) as ITranscodingFile;

/** The companion's version, as `spec/transcoding.md` states it. */
const COMPANION_VERSION = /\*\*Version: ([0-9]+\.[0-9]+\.[0-9]+)\*\*/.exec(
  readFileSync(new URL('../../../../../spec/transcoding.md', import.meta.url), 'utf8')
)?.[1];

const MESSAGES: Readonly<Record<string, DescMessage>> = Object.freeze({
  [EdgesSchema.typeName]: EdgesSchema,
  [EverythingSchema.typeName]: EverythingSchema,
  [NeedsSchema.typeName]: NeedsSchema,
  [RequiringSchema.typeName]: RequiringSchema,
});

const SCHEMAS = [
  ...Object.values(MESSAGES),
  ...HTTP_ROUTES.flatMap((route) => {
    return [route.request, route.result].filter((payload) => {
      return typeof payload === 'object';
    });
  }),
];

const FORM = createJsonForm(SCHEMAS);

const ENCODER = new TextEncoder();

// the Transcoding service's catalogue, as its route table holds it
const CATALOGUE = HTTP_ROUTES[0].failures;

// helpers

/** The request's message of the procedure `name`, as the route table holds it. */
const requestOf = (name: string): DescMessage => {
  const route = HTTP_ROUTES.find((candidate) => {
    return candidate.procedure.procedure.procedureName === name;
  });

  if (route === undefined || typeof route.request !== 'object') {
    throw new Error(`${name} is no procedure of a proto request`);
  }

  return route.request;
};

/** A scalar number's bits, including its zero sign and NaN representation. */
const scalarOf = (value: unknown): unknown => {
  if (typeof value !== 'number') {
    return value;
  }

  const bits = Buffer.alloc(8);

  bits.writeDoubleLE(value);

  return bits;
};

/** A message's set fields, with presence, signed zeros, NaNs and unknown fields intact. */
const comparableOf = (message: ReflectMessage): unknown => {
  const fields = new Map<number, unknown>();

  for (const field of message.fields) {
    if (!message.isSet(field)) {
      continue;
    }

    switch (field.fieldKind) {
      case 'message': {
        fields.set(field.number, comparableOf(message.get(field)));
        break;
      }
      case 'list': {
        fields.set(
          field.number,
          [...message.get(field)].map((value) => {
            return field.listKind === 'message'
              ? comparableOf(value as ReflectMessage)
              : scalarOf(value);
          })
        );
        break;
      }
      case 'map': {
        fields.set(
          field.number,
          new Map(
            [...message.get(field)].map(([key, value]) => {
              return [
                key,
                field.mapKind === 'message'
                  ? comparableOf(value as ReflectMessage)
                  : scalarOf(value),
              ];
            })
          )
        );
        break;
      }
      case 'enum':
      case 'scalar': {
        fields.set(field.number, scalarOf(message.get(field)));
        break;
      }
    }
  }

  return { fields, unknown: message.getUnknown() ?? [] };
};

/** Whole messages, including unknown fields, with floating values compared as the C# player does. */
const isSame = (schema: DescMessage, { one, other }: { one: Message; other: Message }): boolean => {
  return (
    one.$typeName === schema.typeName &&
    other.$typeName === schema.typeName &&
    isDeepStrictEqual(comparableOf(reflect(schema, one)), comparableOf(reflect(schema, other)))
  );
};

/** An event's data, as a stream writes it of its payload. */
const dataOf = (data: EventData): string => {
  if (typeof data === 'string') {
    return data;
  }

  return 'text' in data
    ? FORM.eventDataOf('text', ENCODER.encode(data.text))
    : FORM.eventDataOf('raw', fromHexadecimal(data.raw));
};

const messageOf = (name: string): DescMessage => {
  const schema = MESSAGES[name];

  if (schema === undefined) {
    throw new Error(`${name} is no message the file plays`);
  }

  return schema;
};

/** The refusal `act` throws, a {@link JsonFormError}; none where it throws none. */
const refusalOf = (act: () => unknown): JsonFormError | undefined => {
  try {
    act();
  } catch (error) {
    return error instanceof JsonFormError ? error : undefined;
  }

  return undefined;
};

/** The reason `act` is refused for, in the words of transcoding 5. */
const reasonOf = (act: () => unknown): string | undefined => {
  return refusalOf(act)?.reason;
};

/** Where a request carried what its reading refused, as an entry writes it (7.4). */
const placeOf = (entry: { parameter?: string; pointer?: string }): RequestPlace | undefined => {
  if (entry.parameter !== undefined) {
    return { parameter: entry.parameter };
  }

  return entry.pointer === undefined ? undefined : { pointer: entry.pointer };
};

// tests

test('compares payload signed zeros, NaNs and unknown fields', () => {
  const cases: [string, string, boolean][] = [
    ['C1 01 00 00 00 00 00 00 00 80', 'C1 01 00 00 00 00 00 00 00 00', false],
    ['3A 05 0D 00 00 00 80', '3A 05 0D 00 00 00 00', false],
    ['BA 01 0A C1 01 00 00 00 00 00 00 00 80', 'BA 01 0A C1 01 00 00 00 00 00 00 00 00', false],
    ['C1 01 00 00 00 00 00 00 F8 7F', 'C1 01 00 00 00 00 00 00 F8 7F', true],
    ['C1 01 00 00 00 00 00 00 F8 7F', 'C1 01 01 00 00 00 00 00 F8 7F', false],
    [
      '5A 05 08 01 12 01 61 5A 05 08 02 12 01 62',
      '5A 05 08 02 12 01 62 5A 05 08 01 12 01 61',
      true,
    ],
    ['', 'A0 06 01', false],
    ['A0 06 01', 'A0 06 01', true],
    ['A0 06 01', 'A0 06 02', false],
  ];

  for (const [one, other, expected] of cases) {
    expect(
      isSame(EdgesSchema, {
        one: fromBinary(EdgesSchema, fromHexadecimal(one)),
        other: fromBinary(EdgesSchema, fromHexadecimal(other)),
      }),
      `${one} / ${other}`
    ).toBe(expected);
  }
});

test('reads consecutive responses from their own bytes', async () => {
  // ! both responses and the next head arrive together; no read may replay or eat its neighbour
  const socket = new Socket();
  const peer: IPeer = {
    method: 'GET',
    socket,
    received: [
      Buffer.from(
        'HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\none' +
          'HTTP/1.1 201 Created\r\ntransfer-encoding: chunked\r\n\r\n3\r\ntwo\r\n0\r\nx-end: yes\r\n\r\n' +
          'HTTP/1.1 204 No Content\r\n\r\n',
        'latin1'
      ),
    ],
    isEnded: true,
    taken: 0,
    next: () => {
      return Promise.resolve();
    },
  };

  try {
    const first = await readOn(peer, {});
    const second = await readOn(peer, {});
    const third = await readOn(peer, {});

    expect([first.status, first.body.toString()]).toEqual([200, 'one']);
    expect([second.status, second.body.toString()]).toEqual([201, 'two']);
    expect([third.status, third.body.toString()]).toEqual([204, '']);
    expect(peer.taken).toBe(Buffer.concat(peer.received).length);
  } finally {
    socket.destroy();
  }
});

test.describe('plays transcoding.json', () => {
  test('its version is the companion’s', () => {
    expect(FILE.transcodingVersion).toBe(COMPANION_VERSION);
  });

  for (const entry of FILE.templates) {
    test(`templates: ${entry.name}`, () => {
      if (entry.tie !== undefined) {
        const [one = '', other = ''] = entry.templates;

        expect(isTie(templateOf(one), templateOf(other))).toBe(entry.tie);

        return;
      }

      if (entry.paths === undefined) {
        expect(parseTemplate(entry.templates[0] ?? '').reason).toBe(entry.refused);

        return;
      }

      const templates = entry.templates.map(templateOf);

      for (const expected of entry.paths) {
        const path = rawPathOf(expected.path);
        const index = path === undefined ? undefined : routeIndexOf(templates, path);

        expect(index ?? null, expected.path).toBe(expected.route);

        const template = index === undefined ? undefined : templates[index];

        if (template === undefined || path === undefined) {
          continue;
        }

        const read = variablesOf(template, path);

        if (expected.refused === undefined) {
          expect(read.variables, expected.path).toEqual(expected.variables ?? {});
          expect(path.verb, expected.path).toBe(expected.verb);
        } else {
          expect(read.reason, expected.path).toBe(expected.refused);
        }
      }
    });
  }

  for (const entry of FILE.readings) {
    test(`readings: ${entry.name}`, () => {
      const schema = messageOf(entry.message);
      const bytes =
        entry.bodyBytes === undefined
          ? ENCODER.encode(entry.body ?? '')
          : fromHexadecimal(entry.bodyBytes);
      const read = (): Message => {
        return FORM.read(schema, bytes);
      };

      if (entry.payload === undefined) {
        expect(read).toThrow(JsonFormError);
        expect(reasonOf(read)).toBe(entry.refused);
        expect(refusalOf(read)?.pointer).toBe(entry.pointer);

        return;
      }

      const expected = fromBinary(schema, fromHexadecimal(entry.payload), { recursionLimit: 101 });

      expect(isSame(schema, { one: read(), other: expected })).toBe(true);
    });
  }

  for (const entry of FILE.bindings) {
    test(`bindings: ${entry.name}`, () => {
      const schema = requestOf(entry.procedure);
      const template = templateOf(entry.route.template);
      const [pathText = '', ...queries] = entry.target.split('?');
      const path = rawPathOf(pathText);

      if (path === undefined) {
        throw new Error(`${entry.target} matches no route`);
      }

      // * a target its template matches, as the C# side requires it
      expect(routeIndexOf([template], path), entry.target).toBe(0);

      const decoded = variablesOf(template, path);
      const bind = (): Message => {
        // * as its gateway binds it: a value that does not decode refused at its own variable
        if (decoded.variables === undefined) {
          throw new JsonFormError(decoded.reason, { place: { parameter: decoded.fieldPath } });
        }

        return createHTTPBinding(SCHEMAS).bind(schema, {
          ...(entry.body === undefined ? {} : { body: ENCODER.encode(entry.body) }),
          isPatch: entry.route.method === 'PATCH',
          ...(queries.length === 0 ? {} : { query: queries.join('?') }),
          routeBody: entry.route.body,
          variables: decoded.variables,
        });
      };

      if (entry.payload === undefined) {
        expect(bind).toThrow(JsonFormError);
        expect(reasonOf(bind)).toBe(entry.refused);
        expect(refusalOf(bind)?.place).toEqual(placeOf(entry));

        return;
      }

      const expected = fromBinary(schema, fromHexadecimal(entry.payload));

      expect(isSame(schema, { one: bind(), other: expected })).toBe(true);
    });
  }

  for (const entry of FILE.failures) {
    test(`failures: ${entry.name}`, () => {
      const { failure } = entry;
      const problemTypes =
        entry.problemTypes === undefined ? FILE.defaults.problemTypes : entry.problemTypes;
      const route =
        entry.procedure === undefined || entry.route === undefined
          ? undefined
          : {
              body: entry.route.body,
              request: requestOf(entry.procedure),
              variables: templateOf(entry.route.template).variables.map(({ fieldPath }) => {
                return fieldPath;
              }),
            };
      const problem =
        failure.own === undefined
          ? problemOfFailure(
              {
                arose: failure.arose ?? 'server',
                code: failure.code ?? 0,
                credential: failure.credential,
                detail: failure.detail,
                encoding: failure.encoding,
                place: placeOf(failure),
                scope: failure.scope ?? 'protocol',
              },
              {
                catalogue: CATALOGUE,
                challenge: failure.challenge ?? FILE.defaults.challenge,
                problemTypes: problemTypes ?? undefined,
                route,
              }
            )
          : problemOfOwn(failure.own, failure.detail ?? '', {
              challenge: failure.challenge ?? FILE.defaults.challenge,
            });

      expect(problem.status).toBe(entry.status);
      expect(problem.fields).toEqual(entry.fields);
      expect(problem.body).toBe(entry.problem);
    });
  }

  for (const entry of FILE.events) {
    test(`events: ${entry.name}`, async () => {
      const clock = createTestClock();
      const response = { body: '', contentType: '', status: 0 };
      const stream = createEventStream(
        {
          answer: ({ body, status }) => {
            Object.assign(response, { body, contentType: 'application/problem+json', status });
          },
          end: () => {},
          open: () => {
            Object.assign(response, { contentType: EVENT_STREAM_MEDIA_TYPE, status: 200 });
          },
          write: (text) => {
            response.body += text;

            return Promise.resolve();
          },
        },
        { clock, heartbeat: HEARTBEAT }
      );

      for (const step of entry.steps) {
        if (step.result !== undefined) {
          stream.result(dataOf(step.result));
        } else if (step.notification !== undefined) {
          void stream.notification(dataOf(step.notification));
        } else if (step.failure !== undefined) {
          stream.failure({ body: step.failure.problem, fields: {}, status: step.failure.status });
        } else {
          await clock.tickAsync(HEARTBEAT);
        }
      }

      stream.close();
      expect(response).toEqual({
        body: entry.body,
        contentType: entry.contentType,
        status: entry.status,
      });
    });
  }

  for (const entry of FILE.exchanges) {
    test(`exchanges: ${entry.name}`, async () => {
      await using fixture = await startTranscoding(gatewayOptionsOf(entry));

      await playExchange(entry, fixture);
    });
  }

  for (const entry of FILE.writings) {
    test(`writings: ${entry.name}`, () => {
      const schema = messageOf(entry.message);
      // * read through the runtime's reader, as the gateway reads a result
      const message = protoCodecOf(schema).decode(fromHexadecimal(entry.payload));
      const write = (): string => {
        return FORM.write(schema, message);
      };

      if (entry.body === undefined) {
        expect(write).toThrow(JsonFormError);
        expect(reasonOf(write)).toBe(entry.refused);
      } else {
        expect(write()).toBe(entry.body);
      }
    });
  }
});
