// ── Rules ─────────────────────────────────────────────────────────────────────

// protovalidate's options as a `.proto` states them, `buf.validate` at v1.2.2 (decision 0035):
// `(buf.validate.field)`, `(buf.validate.oneof)` and `(buf.validate.message)`, read through
// protoc-gen-es's code for the vendored `validate.proto`. What beadc compiles is the first set, every
// other member refused by name, never ignored (VALIDATE_RULE_UNSUPPORTED); a pattern whose table
// passes its bound is VALIDATE_PATTERN_LARGE. The messages a request binding reaches through fields
// that hold a rule or lead to one are judged, and their rules pass into the blueprint in
// protovalidate's own `FieldRules` shape, protobuf's JSON mapping by proto names; a message whose
// rules no request reaches is VALIDATE_RULES_UNPLAYED, since Bead judges requests alone.

// dependencies

import {
  type DescField,
  type DescFile,
  type DescMessage,
  type DescOneof,
  getOption,
  hasOption,
  isFieldSet,
  type Message,
  toJson,
} from '@bufbuild/protobuf';
import { reflect, type ReflectMessage } from '@bufbuild/protobuf/reflect';
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt';

import { diagnosticOf, type IDiagnostic } from '../diagnostics.ts';
import {
  field as fieldExtension,
  type FieldRules,
  FieldRulesSchema,
  message as messageExtension,
  type MessageRules,
  MessageRulesSchema,
  oneof as oneofExtension,
  type OneofRules,
  StringRulesSchema,
} from '../generated/buf/validate/validate_pb.ts';
import type {
  FieldRulesValue,
  FieldType,
  IFieldRulesEntry,
  IMessageRules,
  IOneofRulesEntry,
  RuleValue,
  ScalarName,
} from '../model/blueprint.ts';
import { compilePattern, PATTERN_CELLS_MAXIMUM } from '../patterns/pattern.ts';
import { VALIDATE_VERSION } from '../roots.ts';
import { positionOf } from './comments.ts';
import type { IProtoFile, IProtoInput } from './input.ts';
import { procedureOptionsOf, serviceOptionsOf } from './options.ts';

// types

/** What a project's rules give: the messages judged, by full name, with their rules. */
export interface IJudged {
  readonly messages: ReadonlyMap<
    string,
    { readonly desc: DescMessage; readonly rules: IMessageRules }
  >;
}

// a member of a rules message refused, by its names from the option and its numbers
interface IRefused {
  readonly member: string;
  readonly numbers: readonly number[];
}

// constants

/** The extensions protovalidate's options take, of each options message (`validate.proto`). */
export const VALIDATE_EXTENSION = 1159;

// the fields of descriptor.proto a declaration's options are under, by their numbers
const MESSAGE_FIELD = 2;
const MESSAGE_OPTIONS = 7;
const MESSAGE_ONEOF_DECL = 8;
const FIELD_OPTIONS = 8;
const ONEOF_OPTIONS = 2;
const FILE_MESSAGE_TYPE = 4;
const MESSAGE_NESTED_TYPE = 3;

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

/** `google/protobuf/wrappers.proto`'s messages, by the scalar each wraps (T10). */
export const WRAPPERS: Readonly<Record<string, ScalarName>> = Object.freeze({
  'google.protobuf.DoubleValue': 'double',
  'google.protobuf.FloatValue': 'float',
  'google.protobuf.Int64Value': 'int64',
  'google.protobuf.UInt64Value': 'uint64',
  'google.protobuf.Int32Value': 'int32',
  'google.protobuf.UInt32Value': 'uint32',
  'google.protobuf.BoolValue': 'bool',
  'google.protobuf.StringValue': 'string',
  'google.protobuf.BytesValue': 'bytes',
});

// the members of a number's rules beadc compiles, `finite` besides for a float and a double
const NUMBER_MEMBERS = ['const', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'example'] as const;

/**
 * The first set (decision 0035, 3.1): each type's members beadc compiles, by their names in
 * `validate.proto`; every other member is refused.
 */
export const FIRST_SET: Readonly<Record<string, readonly string[]>> = Object.freeze({
  float: [...NUMBER_MEMBERS, 'finite'],
  double: [...NUMBER_MEMBERS, 'finite'],
  int32: NUMBER_MEMBERS,
  int64: NUMBER_MEMBERS,
  uint32: NUMBER_MEMBERS,
  uint64: NUMBER_MEMBERS,
  sint32: NUMBER_MEMBERS,
  sint64: NUMBER_MEMBERS,
  fixed32: NUMBER_MEMBERS,
  fixed64: NUMBER_MEMBERS,
  sfixed32: NUMBER_MEMBERS,
  sfixed64: NUMBER_MEMBERS,
  bool: ['const', 'example'],
  string: [
    'const',
    'len',
    'min_len',
    'max_len',
    'len_bytes',
    'min_bytes',
    'max_bytes',
    'pattern',
    'prefix',
    'suffix',
    'contains',
    'not_contains',
    'in',
    'not_in',
    'example',
  ],
  bytes: ['const', 'len', 'min_len', 'max_len', 'prefix', 'suffix', 'contains', 'example'],
  enum: ['const', 'defined_only', 'in', 'not_in', 'example'],
  repeated: ['min_items', 'max_items', 'unique', 'items'],
  map: ['min_pairs', 'max_pairs', 'keys', 'values'],
});

// what a field's rules hold besides its type's, beadc compiling both
const FIELD_MEMBERS = new Set(['required', 'ignore']);

// the members of a rules message that are themselves a field's rules
const NESTED_RULES = new Set(['items', 'keys', 'values']);

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Where a message is declared in its file, as source info paths name it. */
export const messagePathOf = (message: DescMessage): number[] => {
  const path: number[] = [];

  for (let at: DescMessage = message; ;) {
    const holder = at.parent;

    path.unshift(
      holder === undefined ? FILE_MESSAGE_TYPE : MESSAGE_NESTED_TYPE,
      (holder === undefined ? at.file.proto.messageType : holder.proto.nestedType).indexOf(at.proto)
    );

    if (holder === undefined) {
      return path;
    }

    at = holder;
  }
};

/** Where a field's `(buf.validate.field)` is, as source info paths name it. */
export const fieldRulesPathOf = (field: DescField): number[] => {
  return [
    ...messagePathOf(field.parent),
    MESSAGE_FIELD,
    field.parent.proto.field.indexOf(field.proto),
    FIELD_OPTIONS,
    VALIDATE_EXTENSION,
  ];
};

const messageRulesPathOf = (message: DescMessage): number[] => {
  return [...messagePathOf(message), MESSAGE_OPTIONS, VALIDATE_EXTENSION];
};

const oneofRulesPathOf = (oneof: DescOneof): number[] => {
  return [
    ...messagePathOf(oneof.parent),
    MESSAGE_ONEOF_DECL,
    oneof.parent.proto.oneofDecl.indexOf(oneof.proto),
    ONEOF_OPTIONS,
    VALIDATE_EXTENSION,
  ];
};

/** A field's `(buf.validate.field)`, when it states one. */
export const fieldRulesOf = (field: DescField): FieldRules | undefined => {
  return hasOption(field, fieldExtension) ? getOption(field, fieldExtension) : undefined;
};

/** A message's `(buf.validate.message)`, when it states one. */
export const messageRulesOf = (message: DescMessage): MessageRules | undefined => {
  return hasOption(message, messageExtension) ? getOption(message, messageExtension) : undefined;
};

/** A oneof's `(buf.validate.oneof)`, when it states one. */
export const oneofRulesOf = (oneof: DescOneof): OneofRules | undefined => {
  return hasOption(oneof, oneofExtension) ? getOption(oneof, oneofExtension) : undefined;
};

// the members of `rules` that are set, by their names and numbers
const setMembersOf = (
  rules: ReflectMessage
): { readonly name: string; readonly number: number; readonly value: unknown }[] => {
  return rules.fields
    .filter((member) => {
      return rules.isSet(member);
    })
    .map((member) => {
      return { name: member.name, number: member.number, value: rules.get(member) };
    });
};

// a predefined rule, an extension of a rules message, which the vendored file's code reads as
// unknown fields of it
const hasUnknown = (message: Message): boolean => {
  return (message.$unknown ?? []).length > 0;
};

// the members of a field's rules beadc does not compile, `at` their names and numbers so far
const refusedOfField = (
  rules: FieldRules,
  at: { readonly names: readonly string[]; readonly numbers: readonly number[] }
): IRefused[] => {
  const refused: IRefused[] = [];

  if (hasUnknown(rules)) {
    refused.push({
      member: [...at.names, '(predefined)'].join('.'),
      numbers: at.numbers,
    });
  }

  for (const member of setMembersOf(reflect(FieldRulesSchema, rules))) {
    const names = [...at.names, member.name];
    const numbers = [...at.numbers, member.number];

    if (FIELD_MEMBERS.has(member.name)) {
      continue;
    }

    const allowed = FIRST_SET[member.name];

    if (allowed === undefined || !isRecord(member.value)) {
      refused.push({ member: names.join('.'), numbers });
      continue;
    }

    const typed = member.value as unknown as ReflectMessage;

    if (hasUnknown(typed.message)) {
      refused.push({ member: [...names, '(predefined)'].join('.'), numbers });
    }

    for (const inner of setMembersOf(typed)) {
      const innerNames = [...names, inner.name];
      const innerNumbers = [...numbers, inner.number];

      if (!allowed.includes(inner.name)) {
        refused.push({ member: innerNames.join('.'), numbers: innerNumbers });
      } else if (NESTED_RULES.has(inner.name) && isRecord(inner.value)) {
        refused.push(
          ...refusedOfField((inner.value as unknown as ReflectMessage).message as FieldRules, {
            names: innerNames,
            numbers: innerNumbers,
          })
        );
      }
    }
  }

  return refused;
};

// every `string.pattern` of a field's rules, its items', its keys' and its values', with its numbers
const patternsOf = (
  rules: FieldRules,
  numbers: readonly number[]
): { readonly pattern: string; readonly numbers: readonly number[] }[] => {
  const { type } = rules;

  if (type.case === 'string') {
    return isFieldSet(type.value, StringRulesSchema.field.pattern)
      ? [{ pattern: type.value.pattern, numbers: [...numbers, 14, 6] }]
      : [];
  }

  if (type.case === 'repeated') {
    const { items } = type.value;

    return items === undefined ? [] : patternsOf(items, [...numbers, 18, 4]);
  }

  if (type.case === 'map') {
    const { keys, values } = type.value;

    return [
      ...(keys === undefined ? [] : patternsOf(keys, [...numbers, 19, 4])),
      ...(values === undefined ? [] : patternsOf(values, [...numbers, 19, 5])),
    ];
  }

  return [];
};

// a field's type as its rules read it
const fieldTypeOf = (
  field: DescField
): { readonly type: FieldType; readonly label?: 'repeated' | 'map'; readonly key?: ScalarName } => {
  // * a wrapper is its scalar where it stands alone, as both libraries unbox it there; an item's or
  // a map value's stays its message, whose rules VALIDATE_RULE_UNSUPPORTED refuses
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

// the message a field holds, a singular one's, an item's or a map value's; none for a wrapper
const heldOf = (field: DescField): DescMessage | undefined => {
  const message =
    field.fieldKind === 'message' ||
    (field.fieldKind === 'list' && field.listKind === 'message') ||
    (field.fieldKind === 'map' && field.mapKind === 'message')
      ? field.message
      : undefined;

  return message === undefined || WRAPPERS[message.typeName] !== undefined ? undefined : message;
};

// whether a field's rules ignore it always, the message it holds with it
const ignoresAlways = (rules: FieldRules | undefined): boolean => {
  return rules?.ignore === 3;
};

// a JSON value's float and double members written as the strings the blueprint's form takes, the
// double each is in 17.7.4's form: `String` writes it, a value not finite already a string
const realsAsStrings = (value: RuleValue): RuleValue => {
  if (typeof value === 'number') {
    return String(value);
  }

  return Array.isArray(value)
    ? value.map((item: RuleValue) => {
        return realsAsStrings(item);
      })
    : value;
};

const blueprintRulesOf = (rules: FieldRules): FieldRulesValue => {
  const json = toJson(FieldRulesSchema, rules, { useProtoFieldName: true }) as Record<
    string,
    RuleValue
  >;
  const written: Record<string, RuleValue> = {};

  for (const [member, value] of Object.entries(json)) {
    if ((member === 'float' || member === 'double') && isRecord(value)) {
      written[member] = Object.fromEntries(
        Object.entries(value).map(([name, inner]) => {
          return [name, typeof inner === 'boolean' ? inner : realsAsStrings(inner)];
        })
      );
    } else if ((member === 'repeated' || member === 'map') && isRecord(value)) {
      written[member] = { ...value };
    } else {
      written[member] = value;
    }
  }

  // * the rules an item, a key or a value takes, written alike
  const nested = rules.type;

  if (nested.case === 'repeated' && nested.value.items !== undefined) {
    (written['repeated'] as Record<string, RuleValue>)['items'] = blueprintRulesOf(
      nested.value.items
    );
  }

  if (nested.case === 'map') {
    const map = written['map'] as Record<string, RuleValue>;

    if (nested.value.keys !== undefined) {
      map['keys'] = blueprintRulesOf(nested.value.keys);
    }

    if (nested.value.values !== undefined) {
      map['values'] = blueprintRulesOf(nested.value.values);
    }
  }

  return written;
};

// the request messages of the project's Bead services: a request's, a notifying request's and a
// command's, which their answering side judges
const requestsOf = (input: IProtoInput): DescMessage[] => {
  return input.files.flatMap((file) => {
    return file.desc.services.flatMap((service) => {
      return serviceOptionsOf(service) === undefined
        ? []
        : service.methods.flatMap((method) => {
            return procedureOptionsOf(method) === undefined ? [] : [method.input];
          });
    });
  });
};

// whether a message states a rule itself: on a field, on itself or on a oneof
const holdsRules = (message: DescMessage): boolean => {
  return (
    message.fields.some((field) => {
      return fieldRulesOf(field) !== undefined;
    }) ||
    messageRulesOf(message) !== undefined ||
    message.oneofs.some((oneof) => {
      return oneofRulesOf(oneof) !== undefined;
    })
  );
};

// the messages of the registry that hold a rule, or lead to one through the messages their fields
// hold, a field that ignores always leading nowhere
const leadingOf = (input: IProtoInput): Set<string> => {
  const messages = [...input.registry].filter((type) => {
    return type.kind === 'message';
  });
  const leading = new Set(
    messages.filter(holdsRules).map((message) => {
      return message.typeName;
    })
  );

  for (let grown = true; grown;) {
    grown = false;

    for (const message of messages) {
      if (leading.has(message.typeName)) {
        continue;
      }

      const leads = message.fields.some((field) => {
        const held = heldOf(field);

        return (
          held !== undefined && !ignoresAlways(fieldRulesOf(field)) && leading.has(held.typeName)
        );
      });

      if (leads) {
        leading.add(message.typeName);
        grown = true;
      }
    }
  }

  return leading;
};

const rulesOfMessage = (message: DescMessage, leading: ReadonlySet<string>): IMessageRules => {
  const own = messageRulesOf(message);
  const named = new Set(
    (own?.oneof ?? []).flatMap((rule) => {
      return rule.fields;
    })
  );
  const fields: IFieldRulesEntry[] = message.fields
    .filter((field) => {
      const held = heldOf(field);

      return (
        fieldRulesOf(field) !== undefined ||
        named.has(field.name) ||
        (held !== undefined && leading.has(held.typeName))
      );
    })
    .sort((one, other) => {
      return one.number - other.number;
    })
    .map((field) => {
      const rules = fieldRulesOf(field);
      const { type, label, key } = fieldTypeOf(field);
      const singular = field.fieldKind !== 'list' && field.fieldKind !== 'map';
      const presence =
        singular &&
        (field.oneof !== undefined || field.presence !== FeatureSet_FieldPresence.IMPLICIT)
          ? 'explicit'
          : 'implicit';

      return {
        fieldName: field.name,
        fieldNumber: field.number,
        type,
        ...(label === undefined ? {} : { label }),
        ...(key === undefined ? {} : { key }),
        presence,
        ...(field.oneof === undefined ? {} : { oneof: field.oneof.name }),
        ...(rules === undefined ? {} : { rules: blueprintRulesOf(rules) }),
      };
    });
  const oneofs: IOneofRulesEntry[] = message.oneofs.flatMap((oneof) => {
    const rules = oneofRulesOf(oneof);

    return rules === undefined
      ? []
      : [
          {
            oneofIndex: message.proto.oneofDecl.indexOf(oneof.proto),
            oneofName: oneof.name,
            rules: rules.required ? { required: true } : {},
          },
        ];
  });

  return {
    fields,
    message:
      own === undefined || own.oneof.length === 0
        ? {}
        : {
            oneof: own.oneof.map((rule) => {
              return {
                fields: [...rule.fields],
                ...(rule.required ? { required: true } : {}),
              };
            }),
          },
    oneofs,
  };
};

// definition

/**
 * The messages `input`'s request bindings reach through fields that hold a rule or lead to one,
 * each with its rules in the blueprint's form, its fields by number (decision 0035).
 */
export const judgedOf = (input: IProtoInput): IJudged => {
  const leading = leadingOf(input);
  const messages = new Map<string, { desc: DescMessage; rules: IMessageRules }>();
  const visit = (message: DescMessage): void => {
    if (!leading.has(message.typeName) || messages.has(message.typeName)) {
      return;
    }

    messages.set(message.typeName, { desc: message, rules: rulesOfMessage(message, leading) });

    for (const field of message.fields) {
      const held = heldOf(field);

      if (held !== undefined && !ignoresAlways(fieldRulesOf(field))) {
        visit(held);
      }
    }
  };

  for (const request of requestsOf(input)) {
    visit(request);
  }

  return { messages };
};

/**
 * The findings of protovalidate's options over `input`: a member beadc does not compile
 * (VALIDATE_RULE_UNSUPPORTED), a pattern past its bound (VALIDATE_PATTERN_LARGE), over the project's
 * files and every message its requests' rules reach; and a message of the project's whose rules no
 * request reaches (VALIDATE_RULES_UNPLAYED).
 */
export const checkRules = (input: IProtoInput): IDiagnostic[] => {
  const diagnostics: IDiagnostic[] = [];
  const judged = judgedOf(input);
  const fileOf = (desc: DescFile): IProtoFile | undefined => {
    return input.files.find((each) => {
      return each.desc === desc;
    });
  };
  // a file of the project's by its path from where beadc runs; an import's by its import path
  const fileNameOf = (desc: DescFile): string => {
    return fileOf(desc)?.path ?? desc.proto.name;
  };
  const report = (
    rule: 'VALIDATE_RULE_UNSUPPORTED' | 'VALIDATE_PATTERN_LARGE' | 'VALIDATE_RULES_UNPLAYED',
    details: { readonly file: DescFile; readonly path: readonly number[]; readonly message: string }
  ): void => {
    diagnostics.push(
      diagnosticOf(rule, {
        message: details.message,
        place: {
          file: fileNameOf(details.file),
          ...positionOf(details.file, details.path),
        },
      })
    );
  };
  const unsupported = (member: string): string => {
    return `${member} is a rule of protovalidate's ${VALIDATE_VERSION} beadc does not compile yet: a rule written and not judged would let through what a protovalidate server refuses`;
  };
  const project = input.files.flatMap((file) => {
    const all: DescMessage[] = [];
    const walk = (messages: readonly DescMessage[]): void => {
      for (const message of messages) {
        all.push(message);
        walk(message.nestedMessages);
      }
    };

    walk(file.desc.messages);

    return all;
  });
  const checked = new Set<DescMessage>([
    ...project,
    ...[...judged.messages.values()].map((entry) => {
      return entry.desc;
    }),
  ]);

  for (const message of checked) {
    if (message.proto.options?.mapEntry === true) {
      continue;
    }

    const own = messageRulesOf(message);

    if (own !== undefined) {
      const at = messageRulesPathOf(message);

      if (hasUnknown(own)) {
        report('VALIDATE_RULE_UNSUPPORTED', {
          file: message.file,
          path: at,
          message: unsupported('(buf.validate.message).(predefined)'),
        });
      }

      for (const member of setMembersOf(reflect(MessageRulesSchema, own))) {
        if (member.name !== 'oneof') {
          report('VALIDATE_RULE_UNSUPPORTED', {
            file: message.file,
            path: [...at, member.number],
            message: unsupported(`(buf.validate.message).${member.name}`),
          });
        }
      }
    }

    for (const field of message.fields) {
      const rules = fieldRulesOf(field);

      if (rules === undefined) {
        continue;
      }

      const at = fieldRulesPathOf(field);
      const wrapped =
        (field.fieldKind === 'list' && field.listKind === 'message') ||
        (field.fieldKind === 'map' && field.mapKind === 'message')
          ? WRAPPERS[field.message.typeName]
          : undefined;
      const nested =
        rules.type.case === 'repeated'
          ? { member: 'repeated.items', number: 4, rules: rules.type.value.items }
          : rules.type.case === 'map'
            ? { member: 'map.values', number: 5, rules: rules.type.value.values }
            : undefined;

      // * a wrapper's items or a map's wrapper values: messages both libraries keep boxed
      if (wrapped !== undefined && nested?.rules?.type.case !== undefined) {
        report('VALIDATE_RULE_UNSUPPORTED', {
          file: message.file,
          path: [...at, rules.type.case === 'repeated' ? 18 : 19, nested.number],
          message: unsupported(
            `${field.name}'s ${nested.member}, of a ${field.message?.typeName ?? 'wrapper'},`
          ),
        });
      }

      for (const refused of refusedOfField(rules, { names: [], numbers: [] })) {
        report('VALIDATE_RULE_UNSUPPORTED', {
          file: message.file,
          path: [...at, ...refused.numbers],
          message: unsupported(`${field.name}'s ${refused.member}`),
        });
      }

      for (const { pattern, numbers } of patternsOf(rules, [])) {
        const compiled = compilePattern(pattern);

        if (compiled.kind === 'large') {
          report('VALIDATE_PATTERN_LARGE', {
            file: message.file,
            path: [...at, ...numbers],
            message: `${field.name}'s pattern ${JSON.stringify(pattern)} ${
              compiled.bound === 'table'
                ? `compiles to ${String(compiled.states)} states × ${String(compiled.classes)} classes, ${String(compiled.cells)} cells`
                : `passed ${String(compiled.cells)} cells, ${String(compiled.states)} states × ${String(compiled.classes)} classes, while its table was built`
            }, past ${String(PATTERN_CELLS_MAXIMUM)}: anchor it, narrow its ., or shorten its repetition`,
          });
        } else if (compiled.kind === 'refused') {
          report('VALIDATE_RULE_UNSUPPORTED', {
            file: message.file,
            path: [...at, ...numbers],
            message: `${field.name}'s pattern ${JSON.stringify(pattern)} is one beadc does not compile yet: ${compiled.reason}`,
          });
        }
      }
    }

    for (const oneof of message.oneofs) {
      const rules = oneofRulesOf(oneof);

      if (rules !== undefined && hasUnknown(rules)) {
        report('VALIDATE_RULE_UNSUPPORTED', {
          file: oneof.parent.file,
          path: oneofRulesPathOf(oneof),
          message: unsupported('(buf.validate.oneof).(predefined)'),
        });
      }
    }
  }

  for (const message of project) {
    if (holdsRules(message) && !judged.messages.has(message.typeName)) {
      report('VALIDATE_RULES_UNPLAYED', {
        file: message.file,
        path: [...messagePathOf(message), 1],
        message: `${message.typeName} states rules no request binding reaches: Bead judges a request alone, never a result or a notification`,
      });
    }
  }

  return diagnostics;
};

/** Whether a file of `input`'s imports protovalidate's options, which buf's PROTOVALIDATE judges. */
export const importsValidate = (input: IProtoInput, file: string): boolean => {
  return input.files.some((each) => {
    return each.desc.dependencies.some((dependency) => {
      return dependency.proto.name === file;
    });
  });
};
