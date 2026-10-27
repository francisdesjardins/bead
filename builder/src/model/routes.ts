// ── Routes ────────────────────────────────────────────────────────────────────

// A blueprint's procedures as HTTP routes (decision 0037, spec/transcoding.md 3): `http.proto`'s
// path templates, parsed by its grammar as the spec's generator parses them, each refusal by its
// reason; a procedure's routes in their order, its default `POST` at `<prefix>/<Service>/<procedure>`,
// its default `GET` there where it is marked `NO_SIDE_EFFECTS` and the query carries its request
// whole, then each of its rules; and the precedence by which one route of a method answers a path
// more than one matches, a literal before `*`, `*` before `**`, a template that ends where the path
// ends before a `**` that takes none (3.5). What a builder refuses of them is `check-blueprint.ts`'s
// and `generate.ts`'s, by rule name; what a gateway answers is each runtime's.

// dependencies

import type {
  FieldType,
  HttpMethod,
  IBlueprint,
  IFieldEntry,
  IHttpRule,
  IMessageEntry,
  IProcedureEntry,
  IServiceEntry,
} from './blueprint.ts';

// types

/** A segment of a template: a literal, `*`, one segment, or `**`, zero or more. */
export type Segment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'stars' };

/** A variable of a template: its field path, and the segments it takes, `start` to `end`. */
export interface IVariable {
  readonly fieldPath: string;
  readonly start: number;
  readonly end: number;
}

/** A template of `http.proto`'s grammar, parsed. */
export interface ITemplate {
  readonly text: string;
  readonly segments: readonly Segment[];
  readonly variables: readonly IVariable[];
  readonly verb?: string;
}

/** A template read: parsed, or refused and why. */
export type TemplateReading =
  | { readonly kind: 'template'; readonly template: ITemplate }
  | { readonly kind: 'refused'; readonly reason: string };

/** Where a route comes from: a default route, or a procedure's rule by its index. */
export type RouteOrigin =
  | { readonly kind: 'post' }
  | { readonly kind: 'get' }
  | { readonly kind: 'rule'; readonly index: number };

/** One route of a procedure: its method, its template, its body and its response body. */
export interface IRoute {
  readonly method: HttpMethod;
  readonly template: string;
  readonly body?: string;
  readonly responseBody?: string;
  readonly origin: RouteOrigin;
}

/** A route with the procedure and the service it answers. */
export interface IServedRoute extends IRoute {
  readonly service: IServiceEntry;
  readonly procedure: IProcedureEntry;
}

// constants

/** A default route's prefix, unless `beadc.yaml`'s `http.prefix` gives another (transcoding 3.3). */
export const DEFAULT_PREFIX = '/api';

/** A prefix's form: `/` and segments of the unreserved characters, none `.` or `..` (3.3). */
export const PREFIX = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/u;

/** The path a gateway serves its document at (transcoding 11.1). */
export const DOCUMENT_PATH = '/openapi.json';

/**
 * The HTTP transport's pathname, `/bead` (spec 15.5), which no rule takes: a builder holds the
 * default, as an application that moves its transport's pathname knows where it moved it.
 */
export const TRANSPORT_PATHNAME = '/bead';

/** The methods in the order an `allow` names them (transcoding 3.10), `HEAD` beside `GET`. */
export const METHOD_ORDER: readonly string[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * The well-known types whose JSON is a string, which a query parameter carries whole (transcoding
 * 4.3): a `Timestamp`, a `Duration` and a `FieldMask`; a wrapper is its scalar already.
 */
export const STRING_FORMS: ReadonlySet<string> = new Set([
  'google.protobuf.Timestamp',
  'google.protobuf.Duration',
  'google.protobuf.FieldMask',
]);

/** The well-known messages whose JSON is a form of their own, which no field of theirs reads. */
export const WELL_KNOWN_MESSAGES: ReadonlySet<string> = new Set([
  'google.protobuf.Any',
  'google.protobuf.Duration',
  'google.protobuf.Empty',
  'google.protobuf.FieldMask',
  'google.protobuf.ListValue',
  'google.protobuf.Struct',
  'google.protobuf.Timestamp',
  'google.protobuf.Value',
  'google.protobuf.DoubleValue',
  'google.protobuf.FloatValue',
  'google.protobuf.Int64Value',
  'google.protobuf.UInt64Value',
  'google.protobuf.Int32Value',
  'google.protobuf.UInt32Value',
  'google.protobuf.BoolValue',
  'google.protobuf.StringValue',
  'google.protobuf.BytesValue',
]);

/** The well-known enum, whose JSON is `null`. */
export const NULL_VALUE = 'google.protobuf.NullValue';

// a literal of a template, and a field path of a variable (http.proto's grammar)
const LITERAL = /^[A-Za-z0-9._~-]+/u;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u;

// a segment's rank under 3.5's precedence: a literal, then `*`, then `**`; a template that ends
// where the path ends before a `**` that takes none
const END = -1;
const LITERAL_RANK = 0;
const STAR_RANK = 1;
const STARS_RANK = 2;

// helpers

class Refusal extends Error {}

// a template's text from `at`, parsed into `segments` and `variables`, inside a variable or not
const parseSegments = (
  text: string,
  state: { at: number; segments: Segment[]; variables: IVariable[]; inside: boolean }
): void => {
  const { inside } = state;

  for (;;) {
    const rest = text.slice(state.at);

    if (rest.startsWith('**')) {
      state.segments.push({ kind: 'stars' });
      state.at += 2;
    } else if (rest.startsWith('*')) {
      state.segments.push({ kind: 'star' });
      state.at += 1;
    } else if (rest.startsWith('{')) {
      if (inside) {
        throw new Refusal('a variable within a variable');
      }

      const path = FIELD_PATH.exec(rest.slice(1));

      if (path === null) {
        throw new Refusal('a variable that names no field path');
      }

      const start = state.segments.length;

      state.at += 1 + path[0].length;

      if (text.startsWith('=', state.at)) {
        state.at += 1;
        state.inside = true;
        parseSegments(text, state);
        state.inside = false;
      } else {
        state.segments.push({ kind: 'star' });
      }

      if (!text.startsWith('}', state.at)) {
        throw new Refusal('a variable that does not close');
      }

      state.at += 1;
      state.variables.push({ fieldPath: path[0], start, end: state.segments.length });
    } else {
      const literal = LITERAL.exec(rest);

      if (literal === null) {
        throw new Refusal('a literal that is no segment');
      }

      state.segments.push({ kind: 'literal', text: literal[0] });
      state.at += literal[0].length;
    }

    if (text.startsWith('/', state.at)) {
      state.at += 1;
      continue;
    }

    return;
  }
};

const rankOf = (segment: Segment): number => {
  return segment.kind === 'literal'
    ? LITERAL_RANK
    : segment.kind === 'star'
      ? STAR_RANK
      : STARS_RANK;
};

// a matching template's ranks for a path of `count` segments (3.5)
const ranksOf = (template: ITemplate, count: number): number[] => {
  return [...template.segments.map(rankOf), ...(template.segments.length === count ? [END] : [])];
};

const compareRanks = (one: readonly number[], other: readonly number[]): number => {
  for (let index = 0; index < Math.min(one.length, other.length); index += 1) {
    const difference = (one[index] ?? 0) - (other[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return one.length - other.length;
};

// definition

/** Parses `text` as `http.proto`'s grammar writes a template (`:221-230`), or says why it is not one. */
export const parseTemplate = (text: string): TemplateReading => {
  const state = {
    at: 0,
    segments: [] as Segment[],
    variables: [] as IVariable[],
    inside: false,
  };
  let verb: string | undefined;

  try {
    if (!text.startsWith('/')) {
      throw new Refusal('a template that does not begin with /');
    }

    state.at = 1;
    parseSegments(text, state);

    if (text.startsWith(':', state.at)) {
      const literal = LITERAL.exec(text.slice(state.at + 1));

      if (literal === null || state.at + 1 + literal[0].length !== text.length) {
        throw new Refusal('a verb that is no literal');
      }

      verb = literal[0];
      state.at = text.length;
    }

    if (state.at !== text.length) {
      throw new Refusal('a literal that is no segment');
    }

    if (
      state.segments.slice(0, -1).some((segment) => {
        return segment.kind === 'stars';
      })
    ) {
      throw new Refusal('a ** that is not its last segment');
    }
  } catch (error) {
    if (error instanceof Refusal) {
      return { kind: 'refused', reason: error.message };
    }

    throw error;
  }

  return {
    kind: 'template',
    template: {
      text,
      segments: state.segments,
      variables: state.variables,
      ...(verb === undefined ? {} : { verb }),
    },
  };
};

/** `text` parsed, for a template a rule already checked; throws for one off the grammar. */
export const templateOf = (text: string): ITemplate => {
  const reading = parseTemplate(text);

  if (reading.kind === 'refused') {
    throw new Error(`${text}: ${reading.reason}`);
  }

  return reading.template;
};

/** A template up to its variables' names: two of one shape tie under 3.5's precedence (3.9). */
export const shapeOf = (template: ITemplate): string => {
  const segments = template.segments.map((segment) => {
    return segment.kind === 'literal' ? `=${segment.text}` : segment.kind === 'star' ? '*' : '**';
  });

  return `/${segments.join('/')}${template.verb === undefined ? '' : `:${template.verb}`}`;
};

/** Whether a variable takes more than one segment, or `**`: its value keeps each `%2F` (3.8). */
export const isMultiSegment = (template: ITemplate, variable: IVariable): boolean => {
  return (
    variable.end - variable.start > 1 ||
    template.segments.slice(variable.start, variable.end).some((segment) => {
      return segment.kind === 'stars';
    })
  );
};

/** A procedure's default route's template: its prefix, its service's name, its own (3.2). */
export const defaultTemplateOf = (
  service: IServiceEntry,
  details: { readonly procedure: IProcedureEntry; readonly prefix?: string }
): string => {
  return `${details.prefix ?? DEFAULT_PREFIX}/${service.serviceName}/${details.procedure.procedureName}`;
};

/** The message entries of `blueprint`, by full name. */
export const messagesOf = (blueprint: IBlueprint): ReadonlyMap<string, IMessageEntry> => {
  return new Map(
    (blueprint.proto?.messages ?? []).map((message) => {
      return [message.fullName, message] as const;
    })
  );
};

/** The full name of the message a field's type names, a wrapper's among them; none for a scalar or an enum. */
export const messageTypeOf = (type: FieldType): string | undefined => {
  return 'message' in type ? type.message : undefined;
};

/**
 * Whether the query carries every field of `fullName` but those `bound` names by their field paths
 * (transcoding 4.3): a scalar, an enum, a repeated one of either, a wrapper, a `Timestamp`, a
 * `Duration`, a `FieldMask`, or a message whose own fields it carries; never a map, a repeated
 * message or another well-known type, at any depth. A message it meets again carries what it did.
 */
export const queryCarries = (
  fullName: string,
  details: {
    readonly messages: ReadonlyMap<string, IMessageEntry>;
    readonly bound?: ReadonlySet<string>;
  }
): boolean => {
  const seen = new Set<string>();
  const carries = (name: string, prefix: string): boolean => {
    const entry = details.messages.get(name);

    if (seen.has(name) || entry === undefined) {
      return true;
    }

    seen.add(name);

    return (entry.fields ?? []).every((field: IFieldEntry) => {
      const path = `${prefix}${field.fieldName}`;
      const held = messageTypeOf(field.type);

      if (details.bound?.has(path) === true) {
        return true;
      }

      if (field.label === 'map') {
        return false;
      }

      if (held === undefined) {
        return true;
      }

      if (field.label === 'repeated') {
        return false;
      }

      if (STRING_FORMS.has(held)) {
        return true;
      }

      return !WELL_KNOWN_MESSAGES.has(held) && carries(held, `${path}.`);
    });
  };

  return carries(fullName, '');
};

/**
 * The first field of `LEGACY_REQUIRED` presence, by its proto path, of `fullName`'s message that no
 * part of a route can set, which section 5.2 refuses on every call (transcoding 5.2, step 4): one on
 * a path each message field of which is required, or held present by a variable, that no variable
 * binds, that is no part of the route's `body` field, and that the query cannot set (4.3): a
 * `Struct`, a `Value`, a `ListValue`, an `Any` or an `Empty`, a message the query reaches no field
 * of, such as one of maps alone, or a message required of itself without end. None where a body of
 * `*` takes the request whole, and none where every such field can be set.
 */
export const requiredUnboundOf = (
  fullName: string,
  details: {
    readonly messages: ReadonlyMap<string, IMessageEntry>;
    readonly variables: ReadonlySet<string>;
    readonly body?: string;
  }
): string | undefined => {
  const variables = [...details.variables];

  if (details.body === '*') {
    return undefined;
  }

  // whether the query sets some field of a message, which makes it present, at any depth
  const settable = (name: string, seen: ReadonlySet<string>): boolean => {
    return (details.messages.get(name)?.fields ?? []).some((field) => {
      const held = messageTypeOf(field.type);

      if (field.label === 'map') {
        return false;
      }

      if (held === undefined) {
        return true;
      }

      if (field.label === 'repeated') {
        return false;
      }

      return (
        STRING_FORMS.has(held) ||
        (!WELL_KNOWN_MESSAGES.has(held) &&
          !seen.has(held) &&
          settable(held, new Set([...seen, held])))
      );
    });
  };
  const walk = (
    name: string,
    at: { readonly prefix: string; readonly chain: ReadonlySet<string> }
  ): string | undefined => {
    for (const field of details.messages.get(name)?.fields ?? []) {
      const path = `${at.prefix}${field.fieldName}`;
      const held = messageTypeOf(field.type);
      const present = variables.some((variable) => {
        return variable.startsWith(`${path}.`);
      });

      if (
        details.variables.has(path) ||
        (at.prefix === '' && field.fieldName === details.body) ||
        held === undefined ||
        field.label !== undefined
      ) {
        continue;
      }

      if (field.legacyRequired === true) {
        if (STRING_FORMS.has(held)) {
          continue;
        }

        // ! a message that requires itself, down a path no variable holds, is never whole
        if (WELL_KNOWN_MESSAGES.has(held) || (at.chain.has(held) && !present)) {
          return path;
        }

        const inner = walk(held, { prefix: `${path}.`, chain: new Set([...at.chain, held]) });

        if (inner !== undefined) {
          return inner;
        }

        const own = details.messages.get(held)?.fields ?? [];

        // * present by a variable, by a required field of its own, or by a field the query sets
        if (
          present ||
          own.some((each) => {
            return each.legacyRequired === true;
          }) ||
          settable(held, new Set([held]))
        ) {
          continue;
        }

        return path;
      }

      // * a message a variable holds present has its required fields judged in turn, a chain of them
      // from it
      if (present && !WELL_KNOWN_MESSAGES.has(held)) {
        const inner = walk(held, { prefix: `${path}.`, chain: new Set([held]) });

        if (inner !== undefined) {
          return inner;
        }
      }
    }

    return undefined;
  };

  return walk(fullName, { prefix: '', chain: new Set([fullName]) });
};

/**
 * Whether a procedure has a default `GET` (3.2): marked `NO_SIDE_EFFECTS`, a `proto` request, and
 * the query carrying it whole.
 */
export const hasDefaultGet = (
  procedure: IProcedureEntry,
  messages: ReadonlyMap<string, IMessageEntry>
): boolean => {
  const { request } = procedure;

  return (
    procedure.http?.idempotencyLevel === 'NO_SIDE_EFFECTS' &&
    request.encoding === 'proto' &&
    request.message !== undefined &&
    queryCarries(request.message, { messages })
  );
};

/**
 * A procedure's routes, in their order: its default `POST`, its default `GET` where it has one,
 * then each of its rules; none for a command, which no HTTP client calls (3.1).
 */
export const routesOf = (
  service: IServiceEntry,
  details: {
    readonly procedure: IProcedureEntry;
    readonly messages: ReadonlyMap<string, IMessageEntry>;
    readonly prefix?: string;
  }
): IRoute[] => {
  const { procedure } = details;

  if (procedure.procedureKind === 'command') {
    return [];
  }

  const template = defaultTemplateOf(service, details);

  return [
    { method: 'POST', template, body: '*', origin: { kind: 'post' } },
    ...(hasDefaultGet(procedure, details.messages)
      ? [{ method: 'GET' as const, template, origin: { kind: 'get' as const } }]
      : []),
    ...(procedure.http?.rules ?? []).map((rule: IHttpRule, index) => {
      return {
        method: rule.method,
        template: rule.template,
        ...(rule.body === undefined ? {} : { body: rule.body }),
        ...(rule.responseBody === undefined ? {} : { responseBody: rule.responseBody }),
        origin: { kind: 'rule' as const, index },
      };
    }),
  ];
};

/** Every route of `blueprint`, service by service, procedure by procedure, each in its order. */
export const servedRoutesOf = (
  blueprint: IBlueprint,
  options: { readonly prefix?: string } = {}
): IServedRoute[] => {
  const messages = messagesOf(blueprint);

  return blueprint.services.flatMap((service) => {
    return service.procedures.flatMap((procedure) => {
      return routesOf(service, {
        procedure,
        messages,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      }).map((route) => {
        return { ...route, service, procedure };
      });
    });
  });
};

/**
 * Whether `template` matches `path`, given as its segments and its verb, raw: a literal its text, `*`
 * one segment, `**` the rest (3.6, 3.7).
 */
export const matchesSegments = (
  template: ITemplate,
  path: { readonly segments: readonly string[]; readonly verb?: string }
): boolean => {
  const { segments } = template;

  if (template.verb !== path.verb) {
    return false;
  }

  const stars = segments.at(-1)?.kind === 'stars';
  const fixed = stars ? segments.slice(0, -1) : segments;

  if (stars ? path.segments.length < fixed.length : path.segments.length !== fixed.length) {
    return false;
  }

  return fixed.every((segment, index) => {
    return segment.kind !== 'literal' || segment.text === path.segments[index];
  });
};

/** Of two templates that match a path of `count` segments, the order 3.5 answers them by. */
export const comparePrecedence = (
  one: ITemplate,
  details: { readonly other: ITemplate; readonly count: number }
): number => {
  return compareRanks(ranksOf(one, details.count), ranksOf(details.other, details.count));
};

/**
 * Paths both templates match, as their segments: the fewest segments both take, and one more where
 * a `**` would take it, so that a `**` that takes none and one that takes one are each tried; none
 * where no path matches both.
 */
export const sharedPathsOf = (
  one: ITemplate,
  other: ITemplate
): { readonly segments: readonly string[]; readonly verb?: string }[] => {
  if (one.verb !== other.verb) {
    return [];
  }

  const fixedOf = (template: ITemplate): readonly Segment[] => {
    return template.segments.at(-1)?.kind === 'stars'
      ? template.segments.slice(0, -1)
      : template.segments;
  };
  const left = fixedOf(one);
  const right = fixedOf(other);
  const open = (template: ITemplate): boolean => {
    return template.segments.at(-1)?.kind === 'stars';
  };
  const fewest = Math.max(left.length, right.length);
  const counts = open(one) || open(other) ? [fewest, fewest + 1] : [fewest];

  return counts.flatMap((count) => {
    const segments: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const a = left[index];
      const b = right[index];
      const literal = [a, b].find((segment) => {
        return segment?.kind === 'literal';
      });

      if (a?.kind === 'literal' && b?.kind === 'literal' && a.text !== b.text) {
        return [];
      }

      segments.push(literal?.kind === 'literal' ? literal.text : 'x');
    }

    const path = { segments, ...(one.verb === undefined ? {} : { verb: one.verb }) };

    return matchesSegments(one, path) && matchesSegments(other, path) ? [path] : [];
  });
};
