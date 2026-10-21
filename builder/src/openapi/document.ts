// ── The OpenAPI document ──────────────────────────────────────────────────────

// One OpenAPI 3.1.1 document a blueprint, written once by beadc (decision 0037, spec/transcoding.md
// 11), in the blueprint's own form but for its arrays, which keep their order: its members in RFC
// 8785's order, two spaces, a final line feed, UTF-8, so that one blueprint gives one sequence of
// bytes. A path a route, by `routes.ts`: each operation's `operationId` its service's and its
// procedure's names, `.get` for its default `GET`, `.http`, `.http1` and on for its rules in their
// order; `x-bead` its service, its procedure, their ids and its kind; its description and its
// deprecation its procedure's. A variable `in: path`, a multi-segment one written expanded, each `*`
// a parameter named by the literal before it, as protoc-gen-openapiv2's
// `expand_slashed_path_patterns` writes one, a `**` one parameter of `x-bead-segments`, since a path
// parameter's value holds no unescaped `/`; the query's fields by their JSON paths. The body its
// request's schema less what its path binds, or its `body` field's; its 200 its result's, or its
// `response_body` field's, and for a procedure that notifies `text/event-stream` beside it, its
// events' schemas in `x-bead-events`; `default` a `Problem`, 422 a `ValidationProblem` where its
// request holds rules, 401 with its `WWW-Authenticate` where its admission is not `none`. One
// security scheme, `{type: http, scheme: bearer}` unless `beadc.yaml` gives one, which an operation
// whose admission is `none` takes optionally.

// dependencies

import type {
  IBlueprint,
  IFieldEntry,
  IMessageEntry,
  IProcedureEntry,
  IServiceEntry,
} from '../model/blueprint.ts';
import { membersSortedTextOf } from '../model/form.ts';
import { judgedMessagesOf } from '../model/rules.ts';
import {
  DEFAULT_PREFIX,
  type IRoute,
  isMultiSegment,
  type ITemplate,
  messagesOf,
  messageTypeOf,
  routesOf,
  STRING_FORMS,
  templateOf,
  WELL_KNOWN_MESSAGES,
} from '../model/routes.ts';
import type { Schema } from './rules.ts';
import {
  componentSchemasOf,
  fieldSchemaOf,
  messageSchemaOf,
  objectSchemaOf,
  refOf,
} from './schemas.ts';

// types

/** What the document says beside the blueprint: `beadc.yaml`'s `http` and `openapi`. */
export interface IDocumentOptions {
  readonly prefix?: string;
  readonly title?: string;
  readonly security?: Readonly<Record<string, unknown>>;
}

// constants

/** The version of OpenAPI the document follows (decision 0037's U8). */
export const OPENAPI_VERSION = '3.1.1';

/** The dialect of its schemas, OpenAPI 3.1's base: `format` and `contentEncoding` annotate. */
export const DIALECT = 'https://spec.openapis.org/oas/3.1/dialect/base';

/** The name of the document's one security scheme. */
export const SECURITY_SCHEME = 'credential';

// the security scheme a document states where `beadc.yaml` gives none
const BEARER = Object.freeze({ type: 'http', scheme: 'bearer' });

// a failure's media type, RFC 9457's
const PROBLEM = 'application/problem+json';

// what a failure's problem holds (transcoding 7.1)
const PROBLEM_SCHEMA: Schema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      format: 'uri-reference',
      description:
        "The problem's identity: a protocol code's tag: URI, an application failure's under the project's problem types, or about:blank.",
    },
    title: {
      type: 'string',
      description: "The code's name, or the status's phrase for about:blank.",
    },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    detail: { type: 'string' },
    code: {
      type: 'integer',
      minimum: 1,
      maximum: 65_535,
      description: 'The code, as the wire carries it.',
    },
    scope: { enum: ['protocol', 'application'] },
  },
  required: ['status', 'title', 'type'],
  description: 'A failure, as RFC 9457 writes one (transcoding 7).',
};

// what PAYLOAD_INVALID's problem holds besides (transcoding 7.4)
const VALIDATION_PROBLEM_SCHEMA: Schema = {
  allOf: [
    { $ref: '#/components/schemas/Problem' },
    {
      type: 'object',
      properties: {
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              detail: { type: 'string' },
              ruleId: { type: 'string' },
              fieldPath: { type: 'string' },
              bounds: {},
              forKey: { type: 'boolean' },
              pointer: {
                type: 'string',
                description: "Its field in the body, RFC 6901 §6's fragment by JSON names.",
              },
              parameter: {
                type: 'string',
                description: 'Its field, bound by a variable or a parameter of the query.',
              },
            },
            required: ['detail', 'ruleId'],
          },
        },
        more: { type: 'integer', minimum: 1 },
        stopped: { const: true },
      },
      required: ['errors'],
    },
  ],
  description:
    "PAYLOAD_INVALID: the request its message's rules refused, each violation an error (decision 0035).",
};

// helpers

// the services' names, and their names and revisions, as `info` writes them
const titleOf = (blueprint: IBlueprint): string => {
  return blueprint.services
    .map((service) => {
      return service.serviceName;
    })
    .join(', ');
};

const versionOf = (blueprint: IBlueprint): string => {
  return blueprint.services
    .map((service) => {
      return `${service.serviceName}.${String(service.serviceRevision)}`;
    })
    .join(', ');
};

// a field by its field path of proto names, through message fields
const fieldAlong = (
  message: IMessageEntry | undefined,
  details: { readonly path: string; readonly messages: ReadonlyMap<string, IMessageEntry> }
): IFieldEntry | undefined => {
  let at = message;
  let found: IFieldEntry | undefined;

  for (const part of details.path.split('.')) {
    found = at?.fields?.find((field) => {
      return field.fieldName === part;
    });

    const held = found === undefined ? undefined : messageTypeOf(found.type);

    at = held === undefined ? undefined : details.messages.get(held);
  }

  return found;
};

// a route's template as OpenAPI's path, and its path parameters
const pathOf = (
  template: ITemplate,
  details: {
    readonly request: IMessageEntry | undefined;
    readonly messages: ReadonlyMap<string, IMessageEntry>;
  }
): { readonly path: string; readonly parameters: Schema[] } => {
  const parameters: Schema[] = [];
  const taken = new Set<string>();
  const unique = (name: string): string => {
    let candidate = name;

    for (let count = 2; taken.has(candidate); count += 1) {
      candidate = `${name}${String(count)}`;
    }

    taken.add(candidate);

    return candidate;
  };
  const parts = template.segments.map((segment, index) => {
    const variable = template.variables.find((each) => {
      return index >= each.start && index < each.end;
    });

    if (segment.kind === 'literal') {
      return segment.text;
    }

    const before = template.segments[index - 1];
    const named = before?.kind === 'literal' ? before.text : `segment${String(index)}`;
    const whole = variable !== undefined && !isMultiSegment(template, variable);
    const name = unique(whole ? variable.fieldPath : named);
    const field =
      whole && details.request !== undefined
        ? fieldAlong(details.request, { path: variable.fieldPath, messages: details.messages })
        : undefined;
    const schema = field === undefined ? { type: 'string' } : fieldSchemaOf(field);

    parameters.push({
      name,
      in: 'path',
      required: true,
      schema,
      ...(variable === undefined || whole ? {} : { 'x-bead-variable': variable.fieldPath }),
      ...(segment.kind === 'stars'
        ? {
            'x-bead-segments': true,
            description: `Zero or more segments, by /, of ${variable?.fieldPath ?? 'the path'}, which this one parameter holds.`,
          }
        : {}),
    });

    return `{${name}}`;
  });

  return {
    path: `/${parts.join('/')}${template.verb === undefined ? '' : `:${template.verb}`}`,
    parameters,
  };
};

// the query's parameters: every field the path and the body leave that the query carries, by JSON
// paths, through message fields, a message never entered twice down one path
const queryOf = (
  request: IMessageEntry,
  details: {
    readonly bound: ReadonlySet<string>;
    readonly body?: string;
    readonly messages: ReadonlyMap<string, IMessageEntry>;
  }
): Schema[] => {
  const parameters: Schema[] = [];
  const walk = (
    message: IMessageEntry,
    at: { readonly proto: string; readonly json: string; readonly seen: ReadonlySet<string> }
  ): void => {
    for (const field of message.fields ?? []) {
      const proto = `${at.proto}${field.fieldName}`;
      const json = `${at.json}${field.jsonName}`;
      const held = messageTypeOf(field.type);

      if (details.bound.has(proto) || (at.proto === '' && field.fieldName === details.body)) {
        continue;
      }

      if (field.label === 'map' || (field.label === 'repeated' && held !== undefined)) {
        continue;
      }

      if (held === undefined || STRING_FORMS.has(held)) {
        parameters.push({
          name: json,
          in: 'query',
          ...(field.label === 'repeated' ? { explode: true, style: 'form' } : {}),
          schema: fieldSchemaOf(field),
          ...(field.deprecated === true ? { deprecated: true } : {}),
        });
        continue;
      }

      const inner = details.messages.get(held);

      if (inner?.fields !== undefined && !WELL_KNOWN_MESSAGES.has(held) && !at.seen.has(held)) {
        walk(inner, {
          proto: `${proto}.`,
          json: `${json}.`,
          seen: new Set([...at.seen, held]),
        });
      }
    }
  };

  walk(request, { proto: '', json: '', seen: new Set([request.fullName]) });

  return parameters;
};

// a native binding's schema and its media type
const nativeOf = (encoding: string): { readonly type: string; readonly schema?: Schema } => {
  switch (encoding) {
    case 'json': {
      return {
        type: 'application/json',
        schema: { description: 'A JSON value, the payload as it is (spec 17.5).' },
      };
    }
    case 'text': {
      return { type: 'text/plain', schema: { type: 'string' } };
    }
    default: {
      return { type: 'application/octet-stream' };
    }
  }
};

const mediaOf = (media: { readonly type: string; readonly schema?: Schema }): Schema => {
  return { [media.type]: media.schema === undefined ? {} : { schema: media.schema } };
};

// definition

/**
 * The OpenAPI document of `blueprint`, as a value: its routes under `options.prefix`, `/api` by
 * default, its schemas, its security scheme.
 */
export const documentValueOf = (blueprint: IBlueprint, options: IDocumentOptions = {}): Schema => {
  const messages = messagesOf(blueprint);
  const judged = judgedMessagesOf(blueprint);
  const paths: Record<string, Record<string, Schema>> = {};
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const schemaOfBinding = (
    binding: IProcedureEntry['result']
  ): { readonly type: string; readonly schema?: Schema } => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? { type: 'application/json', schema: messageSchemaOf(binding.message) }
      : nativeOf(binding.encoding);
  };
  const operationOf = (
    route: IRoute,
    details: { readonly service: IServiceEntry; readonly procedure: IProcedureEntry }
  ): { readonly path: string; readonly operation: Schema } => {
    const { service, procedure } = details;
    const template = templateOf(route.template);
    const request =
      procedure.request.message === undefined ? undefined : messages.get(procedure.request.message);
    const result =
      procedure.result.message === undefined ? undefined : messages.get(procedure.result.message);
    const { path, parameters } = pathOf(template, { request, messages });
    const bound = new Set(
      template.variables.map((variable) => {
        return variable.fieldPath;
      })
    );
    const proto = procedure.request.encoding === 'proto' && request !== undefined;
    const query =
      proto && route.body !== '*'
        ? queryOf(request, {
            bound,
            ...(route.body === undefined ? {} : { body: route.body }),
            messages,
          })
        : [];
    const operationId =
      route.origin.kind === 'post'
        ? `${service.serviceName}.${procedure.procedureName}`
        : route.origin.kind === 'get'
          ? `${service.serviceName}.${procedure.procedureName}.get`
          : `${service.serviceName}.${procedure.procedureName}.http${route.origin.index === 0 ? '' : String(route.origin.index)}`;
    const body = (): Schema | undefined => {
      if (route.body === undefined) {
        return undefined;
      }

      if (!proto) {
        return mediaOf(nativeOf(procedure.request.encoding));
      }

      if (route.body === '*') {
        return {
          'application/json': {
            schema:
              bound.size === 0 || request.fields === undefined
                ? messageSchemaOf(request.fullName)
                : objectSchemaOf(request, { messages, bound }),
          },
        };
      }

      const field = request.fields?.find((each) => {
        return each.fieldName === route.body;
      });
      const inner = [...bound]
        .filter((each) => {
          return each.startsWith(`${String(route.body)}.`);
        })
        .map((each) => {
          return each.slice(String(route.body).length + 1);
        });
      const held = field === undefined ? undefined : messageTypeOf(field.type);
      const heldEntry = held === undefined ? undefined : messages.get(held);

      return {
        'application/json': {
          schema:
            field === undefined
              ? {}
              : inner.length > 0 && heldEntry?.fields !== undefined && field.label === undefined
                ? objectSchemaOf(heldEntry, { messages, bound: new Set(inner) })
                : fieldSchemaOf(field),
        },
      };
    };
    const resultMedia = (): { readonly type: string; readonly schema?: Schema } => {
      if (route.responseBody !== undefined) {
        const field = result?.fields?.find((each) => {
          return each.fieldName === route.responseBody;
        });

        return {
          type: 'application/json',
          schema: field === undefined ? {} : fieldSchemaOf(field),
        };
      }

      return schemaOfBinding(procedure.result);
    };
    const resultOf = resultMedia();
    const notifies = procedure.procedureKind === 'notifies' && procedure.notification !== undefined;
    const content = {
      ...mediaOf(resultOf),
      ...(notifies
        ? {
            'text/event-stream': {
              schema: { type: 'string' },
              'x-bead-events': {
                result: resultOf.schema ?? {},
                message: schemaOfBinding(procedure.notification).schema ?? {},
                failure: refOf('Problem'),
              },
            },
          }
        : {}),
    };
    const requestBody = body();
    const open = procedure.admission === 'none';
    const description = procedure.description;
    const [summary] = (description ?? '').split(/\n[ \t]*\n/u);

    return {
      path,
      operation: {
        operationId,
        tags: [service.serviceName],
        ...(summary === undefined || summary === ''
          ? {}
          : { summary: summary.replaceAll('\n', ' ') }),
        ...(description === undefined ? {} : { description }),
        ...((procedure.deprecation ?? service.deprecation) === undefined
          ? {}
          : { deprecated: true }),
        'x-bead': {
          service: service.serviceName,
          serviceId: service.serviceId,
          procedure: procedure.procedureName,
          procedureId: procedure.procedureId,
          procedureKind: procedure.procedureKind,
        },
        ...(parameters.length + query.length === 0
          ? {}
          : { parameters: [...parameters, ...query] }),
        ...(requestBody === undefined
          ? {}
          : { requestBody: { required: true, content: requestBody } }),
        responses: {
          '200': {
            description: notifies
              ? 'The result; with Accept: text/event-stream, the result, then each notification, then the failure that ends them (transcoding 8).'
              : 'The result.',
            content,
          },
          ...(open
            ? {}
            : {
                '401': {
                  description: 'SESSION_REQUIRED: a call its admission needs a credential for.',
                  headers: {
                    'WWW-Authenticate': {
                      description: "The gateway's challenge (RFC 6750 §3).",
                      schema: { type: 'string' },
                    },
                  },
                  content: { [PROBLEM]: { schema: refOf('Problem') } },
                },
              }),
          ...(procedure.request.message !== undefined && judged.has(procedure.request.message)
            ? {
                '422': {
                  description: "PAYLOAD_INVALID: its request's rules refused it.",
                  content: { [PROBLEM]: { schema: refOf('ValidationProblem') } },
                },
              }
            : {}),
          default: {
            description: 'A failure (transcoding 7).',
            content: { [PROBLEM]: { schema: refOf('Problem') } },
          },
        },
        security: open ? [{}, { [SECURITY_SCHEME]: [] }] : [{ [SECURITY_SCHEME]: [] }],
      },
    };
  };

  for (const service of blueprint.services) {
    for (const procedure of service.procedures) {
      for (const route of routesOf(service, { procedure, messages, prefix })) {
        const { path, operation } = operationOf(route, { service, procedure });
        const item = paths[path] ?? {};
        const method = route.method.toLowerCase();

        if (item[method] !== undefined) {
          throw new Error(
            `${route.method} ${path}: two operations, which HTTP_ROUTE_OVERLAP refuses first`
          );
        }

        item[method] = operation;
        paths[path] = item;
      }
    }
  }

  return {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: DIALECT,
    info: { title: options.title ?? titleOf(blueprint), version: versionOf(blueprint) },
    tags: blueprint.services.map((service) => {
      return {
        name: service.serviceName,
        ...(service.description === undefined ? {} : { description: service.description }),
      };
    }),
    paths,
    components: {
      schemas: {
        ...componentSchemasOf(blueprint),
        Problem: PROBLEM_SCHEMA,
        ValidationProblem: VALIDATION_PROBLEM_SCHEMA,
      },
      securitySchemes: { [SECURITY_SCHEME]: options.security ?? BEARER },
    },
  };
};

/** The OpenAPI document of `blueprint`, as its bytes are written: members sorted, two spaces, a final line feed. */
export const documentOf = (blueprint: IBlueprint, options: IDocumentOptions = {}): string => {
  return membersSortedTextOf(documentValueOf(blueprint, options));
};
