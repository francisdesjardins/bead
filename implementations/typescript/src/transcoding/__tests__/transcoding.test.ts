// ── Transcoding ───────────────────────────────────────────────────────────────

// Bead's HTTP/JSON transcoding, `spec/transcoding.json`, played against the TypeScript side's
// entry, `./transcoding`, and its exchanges against its gateway over a real socket, in process with
// a server of the `Transcoding` service, joined. The C# side plays the same file.

// dependencies

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { type DescMessage, equals, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import { fromHexadecimal } from '../../router/shared/__tests__/vectors';
import { createTestClock } from '../../transport/shared/__tests__/fixtures';
import { HEARTBEAT } from '../events';
import {
  type Arose,
  bindRequest,
  createEventStream,
  type Encoding,
  EVENT_STREAM_MEDIA_TYPE,
  eventDataOf,
  isTie,
  JsonFormError,
  type OwnFailure,
  parseTemplate,
  problemOfFailure,
  problemOfOwn,
  rawPathOf,
  readProtoJson,
  type RequestPlace,
  routeIndexOf,
  templateOf,
  typeRegistryOf,
  variablesOf,
  writeProtoJson,
} from '../transcoding';
import { HTTP_ROUTES, OPENAPI_DOCUMENT } from './generated/bead_http';
import { EdgesSchema, EverythingSchema } from './generated/transcoding_pb';
import { startTranscoding } from './transcoding-service';

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

/** A response's field as an exchange expects it: its value, absent, or an entity tag's shape. */
type ExpectedField = string | null | { capture?: string; shape: 'etag' };

interface IExchangeEntry extends IEntry {
  options?: Record<string, unknown>;
  realTime?: true;
  steps: {
    close?: string;
    expect?: {
      body?: string;
      bodyBytes?: string;
      fields: Record<string, ExpectedField>;
      status: number;
      stream?: string;
    };
    on?: string;
    send?: { body?: string; head: string };
    until?: Record<string, number>;
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

const MESSAGES: Readonly<Record<string, DescMessage>> = Object.freeze({
  [EdgesSchema.typeName]: EdgesSchema,
  [EverythingSchema.typeName]: EverythingSchema,
});

const REGISTRY = typeRegistryOf([
  ...Object.values(MESSAGES),
  ...HTTP_ROUTES.flatMap((route) => {
    return [route.request, route.result].filter((payload) => {
      return typeof payload === 'object';
    });
  }),
]);

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

/** Whether two messages are one: as messages, or by their bytes, where a NaN holds them apart. */
const isSame = (schema: DescMessage, { one, other }: { one: Message; other: Message }): boolean => {
  return (
    equals(schema, one, other) || Buffer.from(toBinary(schema, one)).equals(toBinary(schema, other))
  );
};

/** An event's data, as a stream writes it of its payload. */
const dataOf = (data: EventData): string => {
  if (typeof data === 'string') {
    return data;
  }

  return 'text' in data
    ? eventDataOf({ encoding: 'text', text: data.text })
    : eventDataOf({ bytes: fromHexadecimal(data.raw), encoding: 'raw' });
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

/** A socket of an exchange, and what came on it so far. */
interface IPeer {
  readonly method: string;
  readonly received: Buffer[];
  readonly socket: Socket;
  /** Settles once more came, or the socket ended. */
  next: () => Promise<void>;
  isEnded: boolean;
}

/** A response as a peer read it: its status, its fields by lower-case name, and its body. */
interface IRead {
  body: Buffer;
  fields: Map<string, string>;
  status: number;
}

// how long an exchange waits for what it expects, on the real clock
const PATIENCE = 5_000;

const HEAD_END = Buffer.from('\r\n\r\n');

/** Opens a socket to the gateway, and writes `head` and `body` on it. */
const openPeer = (port: number, { body, head }: { body: Uint8Array; head: string }): IPeer => {
  const socket = connect({ host: '127.0.0.1', port });
  const received: Buffer[] = [];
  let wake: (() => void) | undefined;
  const peer: IPeer = {
    isEnded: false,
    method: head.split(' ')[0] ?? '',
    next: () => {
      return new Promise((resolve) => {
        wake = resolve;
      });
    },
    received,
    socket,
  };
  const woken = (): void => {
    const waking = wake;

    wake = undefined;
    waking?.();
  };

  socket.on('data', (bytes) => {
    received.push(bytes);
    woken();
  });
  socket.on('close', () => {
    peer.isEnded = true;
    woken();
  });
  socket.on('error', () => {
    peer.isEnded = true;
    woken();
  });
  socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));

  return peer;
};

/** A chunked body's bytes so far, and whether its last chunk came. */
const dechunk = (bytes: Buffer): { body: Buffer; isWhole: boolean } => {
  const parts: Buffer[] = [];
  let at = 0;

  for (;;) {
    const end = bytes.indexOf('\r\n', at);

    if (end === -1) {
      return { body: Buffer.concat(parts), isWhole: false };
    }

    const size = Number.parseInt(bytes.subarray(at, end).toString('latin1'), 16);

    if (size === 0) {
      return { body: Buffer.concat(parts), isWhole: true };
    }

    if (bytes.length < end + 2 + size) {
      parts.push(bytes.subarray(end + 2));

      return { body: Buffer.concat(parts), isWhole: false };
    }

    parts.push(bytes.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
};

const sleep = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/**
 * What came on `peer` as one response: its head, then its body by its length, de-chunked to its
 * end, or to its socket's end; for a stream, as soon as its body begins with `stream`.
 */
const readOn = async (peer: IPeer, { stream }: { stream?: string | undefined }): Promise<IRead> => {
  const deadline = performance.now() + PATIENCE;

  for (;;) {
    const bytes = Buffer.concat(peer.received);
    const at = bytes.indexOf(HEAD_END);

    if (at !== -1) {
      const [statusLine = '', ...lines] = bytes.subarray(0, at).toString('latin1').split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const fields = new Map<string, string>();

      for (const line of lines) {
        const colon = line.indexOf(':');

        // * a field given twice is one, its values joined (RFC 9110 5.3), as the C# side reads it
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const before = fields.get(name);

        fields.set(name, before === undefined ? value : `${before}, ${value}`);
      }

      const rest = bytes.subarray(at + HEAD_END.length);
      const length = fields.get('content-length');
      const isChunked = fields.get('transfer-encoding') === 'chunked';

      if (peer.method === 'HEAD' || status === 204 || status === 304) {
        return { body: Buffer.alloc(0), fields, status };
      }

      if (length !== undefined && rest.length >= Number(length)) {
        return { body: rest.subarray(0, Number(length)), fields, status };
      }

      if (isChunked) {
        const { body, isWhole } = dechunk(rest);

        if (isWhole || (stream !== undefined && body.toString('utf8').startsWith(stream))) {
          return { body, fields, status };
        }
      }

      if (length === undefined && !isChunked && peer.isEnded) {
        return { body: rest, fields, status };
      }
    }

    if (peer.isEnded && at === -1) {
      throw new Error('the socket ended before a response came');
    }

    if (performance.now() > deadline) {
      throw new Error(`no whole response within ${String(PATIENCE)} ms`);
    }

    await Promise.race([peer.next(), sleep(50)]);
  }
};

/** A gateway's options of the file's defaults and an exchange's own, by the gateway's names. */
const gatewayOptionsOf = (entry: IExchangeEntry): Record<string, unknown> => {
  const { document, problemTypes, ...rest } = { ...FILE.defaults, ...entry.options };

  return {
    ...rest,
    ...(document === false ? { document: undefined } : {}),
    problemTypes: problemTypes ?? undefined,
  };
};

// tests

test.describe('plays transcoding.json', () => {
  test('its version is the companion’s', () => {
    expect(FILE.transcodingVersion).toBe('0.1.0');
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
      const read = (): ReturnType<typeof readProtoJson> => {
        return readProtoJson(schema, { bytes, registry: REGISTRY });
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

        return bindRequest(schema, {
          ...(entry.body === undefined ? {} : { body: ENCODER.encode(entry.body) }),
          isPatch: entry.route.method === 'PATCH',
          ...(queries.length === 0 ? {} : { query: queries.join('?') }),
          registry: REGISTRY,
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
          : problemOfOwn(failure.own, {
              challenge: failure.challenge ?? FILE.defaults.challenge,
              detail: failure.detail ?? '',
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
      const peers = new Map<string, IPeer>();
      const captured = new Map<string, string>();
      const etag = `"${createHash('sha256').update(OPENAPI_DOCUMENT).digest('hex')}"`;

      try {
        for (const step of entry.steps) {
          if (step.send !== undefined && step.on !== undefined) {
            let head = step.send.head.replaceAll('{host}', `127.0.0.1:${String(fixture.port)}`);

            for (const [name, value] of captured) {
              head = head.replaceAll(`{${name}}`, value);
            }

            peers.set(
              step.on,
              openPeer(fixture.port, { body: fromHexadecimal(step.send.body ?? ''), head })
            );
          } else if (step.expect !== undefined && step.on !== undefined) {
            const peer = peers.get(step.on);

            if (peer === undefined) {
              throw new Error(`no exchange ${step.on}`);
            }

            const read = await readOn(peer, { stream: step.expect.stream });

            expect(read.status, step.on).toBe(step.expect.status);

            for (const [name, value] of Object.entries(step.expect.fields)) {
              const held = read.fields.get(name.toLowerCase());

              if (value === null) {
                expect(held, name).toBeUndefined();
              } else if (typeof value === 'string') {
                expect(held, name).toBe(value);
              } else {
                expect(held, name).toBe(etag);

                if (value.capture !== undefined && held !== undefined) {
                  captured.set(value.capture, held);
                }
              }
            }

            if (step.expect.bodyBytes !== undefined) {
              expect([...read.body]).toEqual([...fromHexadecimal(step.expect.bodyBytes)]);
            } else if (step.expect.stream !== undefined) {
              expect(read.body.toString('utf8').startsWith(step.expect.stream)).toBe(true);
            } else {
              expect(read.body.toString('utf8')).toBe(
                (step.expect.body ?? '').replaceAll('{document}', OPENAPI_DOCUMENT)
              );
            }
          } else if (step.close !== undefined) {
            peers.get(step.close)?.socket.destroy();
          } else if (step.until !== undefined) {
            const deadline = performance.now() + PATIENCE;

            for (const [name, value] of Object.entries(step.until)) {
              while ((fixture.counts as Record<string, number>)[name] !== value) {
                if (performance.now() > deadline) {
                  throw new Error(`${name} never reached ${String(value)}`);
                }

                await sleep(10);
              }
            }
          }
        }
      } finally {
        for (const peer of peers.values()) {
          peer.socket.destroy();
        }
      }
    });
  }

  for (const entry of FILE.writings) {
    test(`writings: ${entry.name}`, () => {
      const schema = messageOf(entry.message);
      const message = fromBinary(schema, fromHexadecimal(entry.payload), { recursionLimit: 101 });
      const write = (): string => {
        return writeProtoJson(schema, { message, registry: REGISTRY });
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
