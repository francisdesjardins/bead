// ── HTTP ──────────────────────────────────────────────────────────────────────

// What a `.proto` says of its procedures over HTTP (decision 0037): each method's `google.api.http`
// rule, read through protoc-gen-es's code for the vendored `google/api/annotations.proto`, each of
// its `additional_bindings` a rule of its own in their order, and its `idempotency_level`,
// `descriptor.proto`'s own; and the shapes of the messages its bindings reach, every field of each by
// its name, number, JSON name and type, and the enums they name, which the routes bind and the
// OpenAPI document describes. A well-known type of `google/protobuf/` is never entered: its JSON is
// its own form. And the rules a `.proto` alone can judge, each by name, over the descriptors: a
// variable's field, a body, a response body, a `custom` pattern, a binding within a binding, a
// binding whose body is not its rule's, a field the query cannot carry, an `update_mask`, an `Any`.
// What a blueprint can judge, a template's grammar among it, is `check-blueprint.ts`'s.

// dependencies

import {
  type DescEnum,
  type DescField,
  type DescFile,
  type DescMessage,
  type DescMethod,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';
import { FeatureSet_FieldPresence, MethodOptions_IdempotencyLevel } from '@bufbuild/protobuf/wkt';

import { diagnosticOf, type IDiagnostic } from '../diagnostics.ts';
import { http as httpExtension } from '../generated/google/api/annotations_pb.ts';
import type { HttpRule } from '../generated/google/api/http_pb.ts';
import type {
  FieldType,
  HttpMethod,
  IEnumEntry,
  IFieldEntry,
  IHttpEntry,
  IHttpRule,
  IMessageEntry,
  ScalarName,
} from '../model/blueprint.ts';
import {
  NULL_VALUE,
  parseTemplate,
  queryCarries,
  type ITemplate,
  WELL_KNOWN_MESSAGES,
} from '../model/routes.ts';
import type { RuleName } from '../rules.ts';
import { leadingOf, pathOf, positionOf } from './comments.ts';
import type { IProtoFile, IProtoInput } from './input.ts';
import { procedureOptionsOf, serviceOptionsOf } from './options.ts';
import { messagePathOf, WRAPPERS } from './rules.ts';

// types

/** A method's rule as its `.proto` wrote it, flattened: where it is, and what it is. */
export interface IWrittenRule {
  /** The rule, or none for a `custom` pattern, which no blueprint holds. */
  readonly rule?: IHttpRule;
  /** Where it is, under the method's declaration, as source info paths name it. */
  readonly path: readonly number[];
  /** The source of the rule: the method's own, or its binding at an index. */
  readonly binding?: number;
  readonly custom: boolean;
  /** Whether a binding holds bindings of its own, which `http.proto` forbids. */
  readonly nested: boolean;
  readonly body: string;
}

/** The shapes of the messages a `.proto`'s bindings reach, and the enums their fields name. */
export interface IShapes {
  readonly messages: ReadonlyMap<
    string,
    { readonly desc: DescMessage; readonly fields?: readonly IFieldEntry[] }
  >;
  readonly enums: ReadonlyMap<string, { readonly desc: DescEnum; readonly entry: IEnumEntry }>;
}

// constants

/** The extension `google.api.http` takes on `MethodOptions` (`annotations.proto`). */
export const HTTP_EXTENSION = 72_295_728;

// the fields of descriptor.proto and http.proto a rule's place is under, by their numbers
const METHOD_OPTIONS = 4;
const MESSAGE_FIELD = 2;
const RULE_BODY = 7;
const RULE_RESPONSE_BODY = 12;
const RULE_ADDITIONAL_BINDINGS = 11;
const RULE_PATTERN: Readonly<Record<string, number>> = Object.freeze({
  get: 2,
  put: 3,
  post: 4,
  delete: 5,
  patch: 6,
  custom: 8,
});

// the scalars by their numbers in descriptor.proto's FieldDescriptorProto.Type
const SCALAR_NAMES: Readonly<Record<number, ScalarName>> = Object.freeze({
  1: 'double',
  2: 'float',
  3: 'int64',
  4: 'uint64',
  5: 'int32',
  6: 'fixed64',
  7: 'fixed32',
  8: 'bool',
  9: 'string',
  12: 'bytes',
  13: 'uint32',
  15: 'sfixed32',
  16: 'sfixed64',
  17: 'sint32',
  18: 'sint64',
});

const FIELD_MASK = 'google.protobuf.FieldMask';

// Bead's payload types, whose bytes are the payload: no message of fields
const PAYLOAD_TYPES: ReadonlySet<string> = new Set(['bead.Raw', 'bead.Text', 'bead.Json']);
const ANY = 'google.protobuf.Any';

// helpers

const byName = <T extends { readonly fullName: string }>(one: T, other: T): number => {
  return one.fullName < other.fullName ? -1 : one.fullName > other.fullName ? 1 : 0;
};

// a field's type as a route and a document read it: a wrapper is its scalar where it stands alone
const fieldTypeOf = (
  field: DescField
): { readonly type: FieldType; readonly label?: 'repeated' | 'map'; readonly key?: ScalarName } => {
  const messageType = (message: DescMessage, alone: boolean): FieldType => {
    const wrapped = WRAPPERS[message.typeName];

    return wrapped === undefined || !alone ? { message: message.typeName } : { wrapper: wrapped };
  };

  switch (field.fieldKind) {
    case 'scalar': {
      return { type: { scalar: SCALAR_NAMES[field.scalar] ?? 'bytes' } };
    }
    case 'enum': {
      return { type: { enum: field.enum.typeName } };
    }
    case 'message': {
      return { type: messageType(field.message, true) };
    }
    case 'list': {
      switch (field.listKind) {
        case 'scalar': {
          return { type: { scalar: SCALAR_NAMES[field.scalar] ?? 'bytes' }, label: 'repeated' };
        }
        case 'enum': {
          return { type: { enum: field.enum.typeName }, label: 'repeated' };
        }
        case 'message': {
          return { type: messageType(field.message, false), label: 'repeated' };
        }
      }
    }
    // falls through: every list kind returns above
    case 'map': {
      const key = SCALAR_NAMES[field.mapKey] ?? 'string';

      switch (field.mapKind) {
        case 'scalar': {
          return {
            type: { scalar: SCALAR_NAMES[field.scalar] ?? 'bytes' },
            label: 'map',
            key,
          };
        }
        case 'enum': {
          return { type: { enum: field.enum.typeName }, label: 'map', key };
        }
        case 'message': {
          return { type: messageType(field.message, false), label: 'map', key };
        }
      }
    }
  }
};

// the message a field holds, a singular one's, an item's or a map value's
const heldOf = (field: DescField): DescMessage | undefined => {
  return field.fieldKind === 'message' ||
    (field.fieldKind === 'list' && field.listKind === 'message') ||
    (field.fieldKind === 'map' && field.mapKind === 'message')
    ? field.message
    : undefined;
};

// the enum a field names, a singular one's, an item's or a map value's
const enumOf = (field: DescField): DescEnum | undefined => {
  return field.fieldKind === 'enum' ||
    (field.fieldKind === 'list' && field.listKind === 'enum') ||
    (field.fieldKind === 'map' && field.mapKind === 'enum')
    ? field.enum
    : undefined;
};

/** Where a field is declared in its file, as source info paths name it. */
export const fieldPathOf = (field: DescField): number[] => {
  return [
    ...messagePathOf(field.parent),
    MESSAGE_FIELD,
    field.parent.proto.field.indexOf(field.proto),
  ];
};

const fieldEntryOf = (field: DescField): IFieldEntry => {
  const { type, label, key } = fieldTypeOf(field);
  const singular = field.fieldKind !== 'list' && field.fieldKind !== 'map';
  const presence =
    singular && (field.oneof !== undefined || field.presence !== FeatureSet_FieldPresence.IMPLICIT)
      ? 'explicit'
      : 'implicit';
  const description = leadingOf(field.parent.file, fieldPathOf(field));

  return {
    fieldName: field.name,
    fieldNumber: field.number,
    jsonName: field.jsonName,
    type,
    ...(label === undefined ? {} : { label }),
    ...(key === undefined ? {} : { key }),
    presence,
    ...(field.oneof === undefined ? {} : { oneof: field.oneof.name }),
    ...(description === undefined ? {} : { description }),
    ...(field.deprecated ? { deprecated: true as const } : {}),
  };
};

// the methods of the project's Bead services that state their procedure
const methodsOf = (
  input: IProtoInput
): { readonly method: DescMethod; readonly file: IProtoFile }[] => {
  return input.files.flatMap((file) => {
    return file.desc.services.flatMap((service) => {
      return serviceOptionsOf(service) === undefined
        ? []
        : service.methods.flatMap((method) => {
            return procedureOptionsOf(method) === undefined ? [] : [{ method, file }];
          });
    });
  });
};

// definition

/** A method's rules as its `.proto` wrote them, its own then each binding's, in their order. */
export const writtenRulesOf = (method: DescMethod): IWrittenRule[] => {
  if (!hasOption(method, httpExtension)) {
    return [];
  }

  const top = getOption(method, httpExtension);
  const at = [...pathOf(method), METHOD_OPTIONS, HTTP_EXTENSION];
  const ruleOf = (rule: HttpRule): IWrittenRule['rule'] => {
    const { pattern } = rule;

    if (pattern.case === undefined || pattern.case === 'custom') {
      return undefined;
    }

    return {
      method: pattern.case.toUpperCase() as HttpMethod,
      template: pattern.value,
      ...(rule.body === '' ? {} : { body: rule.body }),
      ...(rule.responseBody === '' ? {} : { responseBody: rule.responseBody }),
    };
  };
  const writtenOf = (
    rule: HttpRule,
    details: { readonly path: readonly number[]; readonly binding?: number }
  ): IWrittenRule => {
    const read = ruleOf(rule);

    return {
      ...(read === undefined ? {} : { rule: read }),
      path: details.path,
      ...(details.binding === undefined ? {} : { binding: details.binding }),
      custom: rule.pattern.case === 'custom',
      nested: details.binding !== undefined && rule.additionalBindings.length > 0,
      body: rule.body,
    };
  };

  return [
    writtenOf(top, { path: at }),
    ...top.additionalBindings.map((binding, index) => {
      return writtenOf(binding, { path: [...at, RULE_ADDITIONAL_BINDINGS, index], binding: index });
    }),
  ];
};

/** Where a written rule's pattern, body and response body are, under its own place. */
export const rulePlacesOf = (
  written: IWrittenRule
): {
  readonly template: readonly number[];
  readonly body: readonly number[];
  readonly responseBody: readonly number[];
} => {
  const method = written.rule?.method.toLowerCase() ?? 'custom';

  return {
    template: [...written.path, RULE_PATTERN[method] ?? RULE_PATTERN['custom'] ?? 8],
    body: [...written.path, RULE_BODY],
    responseBody: [...written.path, RULE_RESPONSE_BODY],
  };
};

/** What a method's options say of its procedure over HTTP, where they say anything. */
export const httpEntryOf = (method: DescMethod): IHttpEntry | undefined => {
  const rules = writtenRulesOf(method).flatMap((written) => {
    return written.rule === undefined ? [] : [written.rule];
  });
  const level =
    method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS
      ? 'NO_SIDE_EFFECTS'
      : method.idempotency === MethodOptions_IdempotencyLevel.IDEMPOTENT
        ? 'IDEMPOTENT'
        : undefined;

  if (rules.length === 0 && level === undefined) {
    return undefined;
  }

  return { ...(level === undefined ? {} : { idempotencyLevel: level }), rules };
};

/**
 * The shapes of the messages `roots` reach, each message's fields by number, a well-known type's
 * none and never entered, and the enums their fields name, by full name, `google.protobuf.NullValue`
 * named alone.
 */
export const shapesOf = (roots: readonly DescMessage[]): IShapes => {
  const messages = new Map<string, { desc: DescMessage; fields?: IFieldEntry[] }>();
  const enums = new Map<string, { desc: DescEnum; entry: IEnumEntry }>();
  const visit = (message: DescMessage): void => {
    if (messages.has(message.typeName)) {
      return;
    }

    if (WELL_KNOWN_MESSAGES.has(message.typeName)) {
      messages.set(message.typeName, { desc: message });
      return;
    }

    const fields = [...message.fields].sort((one, other) => {
      return one.number - other.number;
    });

    messages.set(message.typeName, { desc: message, fields: fields.map(fieldEntryOf) });

    for (const field of fields) {
      const named = enumOf(field);

      if (named !== undefined && named.typeName !== NULL_VALUE && !enums.has(named.typeName)) {
        enums.set(named.typeName, {
          desc: named,
          entry: {
            fullName: named.typeName,
            file: named.file.proto.name,
            values: named.values.map((value) => {
              return { name: value.name, number: value.number };
            }),
          },
        });
      }

      const held = heldOf(field);

      // * a well-known type stands by its name alone, and enters no entry of its own here: its form
      // is the mapping's
      if (held !== undefined && !WELL_KNOWN_MESSAGES.has(held.typeName)) {
        visit(held);
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return { messages, enums };
};

/** Every message a `proto` binding of `input`'s procedures names, request, result and notification. */
export const boundMessagesOf = (input: IProtoInput): DescMessage[] => {
  return methodsOf(input).flatMap(({ method }) => {
    const options = procedureOptionsOf(method);
    const named =
      options?.procedureKind.case === 'notifies' ? options.procedureKind.value.message : '';
    const scope = method.parent.file.proto.package;
    const notified =
      named === ''
        ? undefined
        : ((scope === '' ? undefined : input.registry.getMessage(`${scope}.${named}`)) ??
          input.registry.getMessage(named));

    return [method.input, method.output, ...(notified === undefined ? [] : [notified])].filter(
      (message) => {
        return !PAYLOAD_TYPES.has(message.typeName);
      }
    );
  });
};

/** The message entries and the enum entries of `shapes`, in the blueprint's order. */
export const shapeEntriesOf = (
  shapes: IShapes
): { readonly messages: IMessageEntry[]; readonly enums: IEnumEntry[] } => {
  return {
    messages: [...shapes.messages.values()]
      .map(({ desc, fields }) => {
        return {
          fullName: desc.typeName,
          file: desc.file.proto.name,
          ...(fields === undefined ? {} : { fields }),
        };
      })
      .sort(byName),
    enums: [...shapes.enums.values()]
      .map(({ entry }) => {
        return entry;
      })
      .sort(byName),
  };
};

/**
 * The findings of `google.api.http` over `input`'s procedures that a `.proto` alone can judge, each
 * by its rule: a `custom` pattern, a binding within a binding, a binding whose body is not its
 * rule's, a variable's field, a body, a response body, a field a mapped `get` or `delete` leaves
 * the query that it cannot carry, a `patch`'s `update_mask` of another type, and an `Any` a binding
 * reaches.
 */
export const checkHttp = (input: IProtoInput): IDiagnostic[] => {
  const diagnostics: IDiagnostic[] = [];
  const fileNameOf = (desc: DescFile): string => {
    return (
      input.files.find((each) => {
        return each.desc === desc;
      })?.path ?? desc.proto.name
    );
  };
  const report = (
    rule: RuleName,
    details: { readonly file: DescFile; readonly path: readonly number[]; readonly message: string }
  ): void => {
    diagnostics.push(
      diagnosticOf(rule, {
        message: details.message,
        place: { file: fileNameOf(details.file), ...positionOf(details.file, details.path) },
      })
    );
  };
  const bound = boundMessagesOf(input);
  const shapes = shapesOf(bound);
  const entries = new Map(
    [...shapes.messages.values()].map(({ desc, fields }) => {
      return [
        desc.typeName,
        {
          fullName: desc.typeName,
          file: desc.file.proto.name,
          ...(fields === undefined ? {} : { fields }),
        },
      ] as const;
    })
  );

  for (const { method } of methodsOf(input)) {
    const written = writtenRulesOf(method);
    const [top] = written;
    const name = `${method.parent.typeName}.${method.proto.name}`;
    const request = method.input;
    const result = method.output;
    const nativeRequest = PAYLOAD_TYPES.has(request.typeName);
    const nativeResult = PAYLOAD_TYPES.has(result.typeName);

    for (const each of written) {
      const places = rulePlacesOf(each);

      if (each.custom) {
        report('HTTP_RULE_CUSTOM', {
          file: method.parent.file,
          path: places.template,
          message: `${name} states a custom pattern: its method's semantics are none Bead can judge, and AIP-127 has a rule not use it`,
        });
      }

      if (each.nested) {
        report('HTTP_RULE_NESTED', {
          file: method.parent.file,
          path: [...each.path, RULE_ADDITIONAL_BINDINGS],
          message: `${name}'s additional_bindings holds additional_bindings of its own, which http.proto forbids`,
        });
      }

      if (each.binding !== undefined && top !== undefined && each.body !== top.body) {
        report('HTTP_RULE_BODY_DIFFERS', {
          file: method.parent.file,
          path: places.body,
          message: `${name}'s binding ${String(each.binding)} states the body ${JSON.stringify(each.body)}, its rule ${JSON.stringify(top.body)}: AIP-127 has each binding's body its rule's`,
        });
      }

      const rule = each.rule;
      const reading = rule === undefined ? undefined : parseTemplate(rule.template);

      if (rule === undefined || reading === undefined || reading.kind === 'refused') {
        continue;
      }

      const template: ITemplate = reading.template;
      const variables = new Set(
        template.variables.map((variable) => {
          return variable.fieldPath;
        })
      );

      if (!nativeRequest) {
        for (const variable of template.variables) {
          const why = variableRefusalOf(request, variable.fieldPath);

          if (why !== undefined) {
            report('HTTP_RULE_FIELD', {
              file: method.parent.file,
              path: places.template,
              message: `${name}'s variable {${variable.fieldPath}} ${why}: a variable binds a non-repeated scalar field, through non-repeated message fields (http.proto)`,
            });
          }
        }

        if (rule.body !== undefined && rule.body !== '*') {
          const field = request.fields.find((each) => {
            return each.name === rule.body;
          });

          if (field === undefined) {
            report('HTTP_RULE_BODY', {
              file: method.parent.file,
              path: places.body,
              message: `${name}'s body ${JSON.stringify(rule.body)} names no top-level field of ${request.typeName}: a body is *, or one of its fields (http.proto, AIP-127)`,
            });
          } else if (variables.has(rule.body)) {
            report('HTTP_RULE_BODY', {
              file: method.parent.file,
              path: places.body,
              message: `${name}'s body ${JSON.stringify(rule.body)} is a field its template's variable binds too: one field, one value (AIP-127)`,
            });
          }
        }
      }

      if (rule.body !== undefined && (rule.method === 'GET' || rule.method === 'DELETE')) {
        report('HTTP_RULE_BODY', {
          file: method.parent.file,
          path: places.body,
          message: `${name}'s ${rule.method.toLowerCase()} rule states a body: a GET or a DELETE carries none (AIP-127)`,
        });
      }

      if (
        !nativeResult &&
        rule.responseBody !== undefined &&
        !result.fields.some((field) => {
          return field.name === rule.responseBody;
        })
      ) {
        report('HTTP_RULE_RESPONSE_BODY', {
          file: method.parent.file,
          path: places.responseBody,
          message: `${name}'s response_body ${JSON.stringify(rule.responseBody)} names no top-level field of ${result.typeName}`,
        });
      }

      if (
        !nativeRequest &&
        (rule.method === 'GET' || rule.method === 'DELETE') &&
        rule.body === undefined &&
        !queryCarries(request.typeName, { messages: entries, bound: variables })
      ) {
        report('HTTP_QUERY_UNBINDABLE', {
          file: method.parent.file,
          path: places.template,
          message: `${name}'s ${rule.method.toLowerCase()} rule leaves the query a field it cannot carry, a map, a repeated message or a well-known type but a Timestamp, a Duration, a FieldMask and a wrapper: no caller of it sets that field`,
        });
      }

      const mask = request.fields.find((field) => {
        return field.name === 'update_mask';
      });

      if (
        rule.method === 'PATCH' &&
        mask !== undefined &&
        (mask.fieldKind !== 'message' || mask.message.typeName !== FIELD_MASK)
      ) {
        report('HTTP_UPDATE_MASK', {
          file: mask.parent.file,
          path: fieldPathOf(mask),
          message: `${name}'s request holds an update_mask that is no ${FIELD_MASK}: a gateway fills none from its PATCH's body (AIP-134)`,
        });
      }
    }
  }

  // * an Any a binding reaches, once at each field that holds one
  for (const { desc } of shapes.messages.values()) {
    for (const field of desc.fields) {
      if (heldOf(field)?.typeName === ANY && !WELL_KNOWN_MESSAGES.has(desc.typeName)) {
        report('HTTP_ANY', {
          file: desc.file,
          path: fieldPathOf(field),
          message: `${desc.typeName}.${field.name} holds a ${ANY}: a gateway writes one of a type among the blueprint's messages, and fails any other, 500`,
        });
      }
    }
  }

  return diagnostics;
};

/** Why a variable's field path is refused over `request`, by its proto names; none when it binds. */
export const variableRefusalOf = (request: DescMessage, fieldPath: string): string | undefined => {
  const parts = fieldPath.split('.');
  let message: DescMessage = request;

  for (const [index, part] of parts.entries()) {
    const field = message.fields.find((each) => {
      return each.name === part;
    });

    if (field === undefined) {
      return `names no field ${part} of ${message.typeName}`;
    }

    const last = index === parts.length - 1;

    if (field.fieldKind === 'list' || field.fieldKind === 'map') {
      return last
        ? `ends at the ${field.fieldKind === 'map' ? 'map' : 'repeated'} field ${part}`
        : `passes through the ${field.fieldKind === 'map' ? 'map' : 'repeated'} field ${part}`;
    }

    if (last) {
      return field.fieldKind === 'message' ? `ends at the message field ${part}` : undefined;
    }

    if (field.fieldKind !== 'message' || WELL_KNOWN_MESSAGES.has(field.message.typeName)) {
      return `passes through ${part}, which holds no message of fields of its own`;
    }

    message = field.message;
  }

  return undefined;
};
