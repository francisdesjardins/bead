// ── Binding ───────────────────────────────────────────────────────────────────

// A request bound from its route's variables, its query and its body into one JSON value, then read
// by Bead's mapping, so one reader judges every field wherever it came from (spec/transcoding.md 4,
// `http.proto`'s rules alone).

// dependencies

import { type DescField, type DescMessage, type Message, ScalarType } from '@bufbuild/protobuf';
import { ProgrammerError } from '../transport/shared/errors';
import {
  fieldNamed,
  type ITypeRegistry,
  type JsonNode,
  JsonFormError,
  readJsonText,
  readMessage,
} from './json-form';
import { queryDecodeOf } from './templates';

// interfaces

/** What a request is bound from: its route's body, its variables decoded, its query and its body. */
export interface IBindingOptions {
  /** Its body's bytes, a `proto` body's JSON text; none where its route takes none. */
  readonly body?: Uint8Array | undefined;
  /** Whether its route is a `patch` rule's, whose `update_mask` its body's keys fill (4.5). */
  readonly isPatch?: boolean | undefined;
  /** Its query, raw, after the first `?`; none where its target has none. */
  readonly query?: string | undefined;
  readonly registry: ITypeRegistry;
  /** Its route's body: `*`, a top-level field's proto name, or none. */
  readonly routeBody?: string | undefined;
  /** Each variable's value, decoded, by its field path of proto names. */
  readonly variables: Readonly<Record<string, string>>;
}

/** A JSON object as the binding builds it: its members in order, each to be read as the body's. */
interface IDraft {
  readonly kind: 'object';
  readonly members: [string, JsonNode][];
}

// constants

// the well-known types whose JSON is a string a query parameter carries whole (4.3.2)
const STRING_FORMS: ReadonlySet<string> = new Set([
  'google.protobuf.Duration',
  'google.protobuf.FieldMask',
  'google.protobuf.Timestamp',
]);

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;

const UPDATE_MASK = 'update_mask';

const FIELD_MASK = 'google.protobuf.FieldMask';

// helpers

const isWrapper = (message: DescMessage): boolean => {
  return (
    message.typeName.startsWith('google.protobuf.') &&
    message.typeName.endsWith('Value') &&
    message.fields.length === 1 &&
    message.fields[0]?.fieldKind === 'scalar'
  );
};

const isWellKnown = (message: DescMessage): boolean => {
  return message.file.name.startsWith('google/protobuf/');
};

/**
 * A scalar's text made the JSON Bead's mapping reads of it (4.2): a string's a string; a number's a
 * string, which its reading reads as a number given so; a `bool`'s its word where it is one; an
 * enum's a number where it is an integer, a string otherwise; `bytes`' a string of base64.
 */
const scalarNodeOf = (text: string, field: DescField): JsonNode => {
  const enumerated =
    field.fieldKind === 'enum' || (field.fieldKind === 'list' && field.listKind === 'enum');

  if (enumerated) {
    return INTEGER.test(text)
      ? { kind: 'number', text, value: Number(text) }
      : { kind: 'string', value: text };
  }

  const scalar =
    field.fieldKind === 'scalar' || (field.fieldKind === 'list' && field.listKind === 'scalar')
      ? field.scalar
      : undefined;

  if (scalar === ScalarType.BOOL && (text === 'true' || text === 'false')) {
    return { kind: 'boolean', value: text === 'true' };
  }

  return { kind: 'string', value: text };
};

/** A value's text made the JSON of `field`: a scalar's, or a well-known type's whose JSON is a string. */
const valueNodeOf = (text: string, field: DescField): JsonNode => {
  if (field.fieldKind === 'message' && isWrapper(field.message)) {
    const [inner] = field.message.fields;

    return inner === undefined ? { kind: 'string', value: text } : scalarNodeOf(text, inner);
  }

  if (field.fieldKind === 'message') {
    return { kind: 'string', value: text };
  }

  return scalarNodeOf(text, field);
};

/** The fields a variable's field path names, by proto names, through singular message fields. */
const variablePathOf = (schema: DescMessage, fieldPath: string): DescField[] => {
  const fields: DescField[] = [];
  let message: DescMessage | undefined = schema;

  for (const name of fieldPath.split('.')) {
    const field: DescField | undefined = message?.fields.find((candidate) => {
      return candidate.name === name;
    });

    if (field === undefined) {
      throw new ProgrammerError(`${fieldPath} names no field of ${schema.typeName}`);
    }

    fields.push(field);
    message = field.fieldKind === 'message' ? field.message : undefined;
  }

  return fields;
};

/** The member of `draft` that names `field`, by either of its names. */
const memberOf = (draft: IDraft, field: DescField): [string, JsonNode] | undefined => {
  return draft.members.find(([name]) => {
    return name === field.name || name === field.jsonName;
  });
};

/** `draft` with its members copied, so a binding writes none of the body's own nodes. */
const draftOf = (node: JsonNode): IDraft | undefined => {
  return node.kind === 'object'
    ? {
        kind: 'object',
        members: node.members.map(([name, value]) => {
          return [name, value];
        }),
      }
    : undefined;
};

/**
 * Sets `value` at `path` of `draft`, each object on the way made a draft of its own; a field set
 * already, or a message the body gave no object for, refused: one field, one value (4.1).
 */
const setAt = (draft: IDraft, { path, value }: { path: readonly DescField[]; value: JsonNode }) => {
  const [field, ...rest] = path;

  if (field === undefined) {
    return;
  }

  const held = memberOf(draft, field);

  if (rest.length === 0) {
    if (held !== undefined) {
      throw new JsonFormError('a field that two of the request set', field.name);
    }

    draft.members.push([field.name, value]);

    return;
  }

  if (held === undefined) {
    const below: IDraft = { kind: 'object', members: [] };

    draft.members.push([field.name, below]);
    setAt(below, { path: rest, value });

    return;
  }

  const below = draftOf(held[1]);

  if (below === undefined) {
    throw new JsonFormError('a field that two of the request set', field.name);
  }

  held[1] = below;
  setAt(below, { path: rest, value });
};

/** The query's parameters, in order, as the form decoding reads them (4.3). */
const parametersOf = (query: string): [string, string][] => {
  return query
    .split('&')
    .filter((sequence) => {
      return sequence !== '';
    })
    .map((sequence) => {
      const equals = sequence.indexOf('=');
      const [rawName, rawValue] =
        equals === -1 ? [sequence, ''] : [sequence.slice(0, equals), sequence.slice(equals + 1)];
      const name = queryDecodeOf(rawName.replaceAll('+', ' '));
      const value = queryDecodeOf(rawValue.replaceAll('+', ' '));

      if (name === undefined || value === undefined) {
        throw new JsonFormError('a query whose bytes are not UTF-8');
      }

      return [name, value];
    });
};

/** The fields a parameter's name names, by JSON or proto names, through singular message fields. */
const parameterPathOf = (schema: DescMessage, name: string): DescField[] => {
  const fields: DescField[] = [];
  let message: DescMessage | undefined = schema;

  for (const segment of name.split('.')) {
    const field: DescField | undefined =
      message === undefined ? undefined : fieldNamed(message, segment);

    if (field === undefined) {
      throw new JsonFormError('a parameter no field path names', name);
    }

    fields.push(field);
    message =
      field.fieldKind === 'message' && !isWellKnown(field.message) ? field.message : undefined;
  }

  return fields;
};

/** The proto names of a path of fields, by `.`. */
const namesOf = (path: readonly DescField[]): string => {
  return path
    .map((field) => {
      return field.name;
    })
    .join('.');
};

/**
 * The paths of the members of a `PATCH`'s body (4.5): each by its field's proto name, into a
 * message's object that is no well-known type's, by its own path where it holds none.
 */
const maskPathsOf = (
  schema: DescMessage,
  { node, prefix }: { node: JsonNode; prefix: string }
): string[] => {
  if (node.kind !== 'object') {
    return [];
  }

  return node.members.flatMap(([name, value]) => {
    const field = fieldNamed(schema, name);

    if (field === undefined) {
      return [];
    }

    const path = `${prefix}${field.name}`;

    if (
      field.fieldKind === 'message' &&
      !isWellKnown(field.message) &&
      value.kind === 'object' &&
      value.members.length > 0
    ) {
      return maskPathsOf(field.message, { node: value, prefix: `${path}.` });
    }

    return [path];
  });
};

/** A snake-case path's lowerCamelCase, as a FieldMask's JSON writes it. */
const camelOf = (path: string): string => {
  return path.replaceAll(/_([a-z])/gu, (_match, letter: string) => {
    return letter.toUpperCase();
  });
};

// definition

/**
 * A request of `schema` bound from its route's variables, its query and its body, then read by
 * Bead's mapping (transcoding 4): a variable by its proto names; the query's parameters by their
 * field paths, each field by its JSON name or its proto name, when its route has no body or one
 * that names a field; the body whole or that field's; and a `PATCH`'s `update_mask`, unset, the
 * paths of the keys its body holds. A field two of them set, a parameter no field path names, one of
 * a message, a map or a repeated message, or of a field its route binds otherwise, a field named
 * twice, or a query under a body of the request whole, is a {@link JsonFormError}, as is every
 * refusal of the reading: a gateway answers each 400 `PAYLOAD_UNDECODABLE`.
 */
export const bindRequest = (schema: DescMessage, options: IBindingOptions): Message => {
  const { body, isPatch = false, query, registry, routeBody, variables } = options;
  const bodyNode = body === undefined ? undefined : readJsonText(body);
  const bodyField =
    routeBody === undefined || routeBody === '*'
      ? undefined
      : schema.fields.find((field) => {
          return field.name === routeBody;
        });
  let draft: IDraft = { kind: 'object', members: [] };

  if (routeBody === '*' && bodyNode !== undefined) {
    const whole = draftOf(bodyNode);

    // * not an object: the reading refuses it as the message's, with nothing bound beside it
    if (whole === undefined) {
      return readMessage(schema, { node: bodyNode, registry });
    }

    draft = whole;
  }

  if (bodyField !== undefined && bodyNode !== undefined) {
    draft.members.push([bodyField.name, bodyNode]);
  }

  const variablePaths = Object.keys(variables).map((fieldPath) => {
    return variablePathOf(schema, fieldPath);
  });
  const bound = new Set(variablePaths.map(namesOf));

  for (const path of variablePaths) {
    const last = path.at(-1);

    if (last !== undefined) {
      setAt(draft, { path, value: valueNodeOf(variables[namesOf(path)] ?? '', last) });
    }
  }

  const parameters = query === undefined ? [] : parametersOf(query);

  if (routeBody === '*' && parameters.length > 0) {
    throw new JsonFormError('a query beside a body of the whole request');
  }

  // each repeated scalar's items, in their order, set once the query is read
  const repeated = new Map<DescField, { items: JsonNode[]; path: DescField[] }>();
  const named = new Set<DescField>();
  let isMaskGiven = false;

  for (const [name, value] of parameters) {
    const path = parameterPathOf(schema, name);
    const field = path.at(-1);

    if (field === undefined) {
      continue;
    }

    const isRepeatedScalar =
      field.fieldKind === 'list' && (field.listKind === 'scalar' || field.listKind === 'enum');

    if (field.fieldKind === 'map' || (field.fieldKind === 'list' && !isRepeatedScalar)) {
      throw new JsonFormError('a parameter of a map or a repeated message', name);
    }

    if (
      field.fieldKind === 'message' &&
      !STRING_FORMS.has(field.message.typeName) &&
      !isWrapper(field.message)
    ) {
      throw new JsonFormError('a parameter of a message', name);
    }

    const names = namesOf(path);

    if (bound.has(names) || (bodyField !== undefined && path[0] === bodyField)) {
      throw new JsonFormError('a parameter of a field the route binds otherwise', name);
    }

    if (named.has(field) && !isRepeatedScalar) {
      throw new JsonFormError('a field the query names twice', name);
    }

    named.add(field);
    isMaskGiven ||= path.length === 1 && field.name === UPDATE_MASK;

    if (isRepeatedScalar) {
      const held = repeated.get(field) ?? { items: [], path };

      held.items.push(valueNodeOf(value, field));
      repeated.set(field, held);
    } else {
      setAt(draft, { path, value: valueNodeOf(value, field) });
    }
  }

  for (const { items, path } of repeated.values()) {
    setAt(draft, { path, value: { items, kind: 'array' } });
  }

  // * a PATCH's update_mask, unset by its query and its body, the keys its body holds (4.5)
  const mask = schema.fields.find((field) => {
    return field.name === UPDATE_MASK;
  });

  if (
    isPatch &&
    bodyField?.fieldKind === 'message' &&
    bodyNode !== undefined &&
    mask?.fieldKind === 'message' &&
    mask.message.typeName === FIELD_MASK &&
    !isMaskGiven
  ) {
    const paths = maskPathsOf(bodyField.message, { node: bodyNode, prefix: '' });

    setAt(draft, { path: [mask], value: { kind: 'string', value: paths.map(camelOf).join(',') } });
  }

  return readMessage(schema, { node: draft, registry });
};
