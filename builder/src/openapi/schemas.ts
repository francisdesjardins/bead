// ── Schemas ───────────────────────────────────────────────────────────────────

// A blueprint's messages as JSON Schema 2020-12 describes them, for the OpenAPI document (decision
// 0037, spec/transcoding.md 11.7 to 11.9): each the one form Bead's proto JSON form writes, which
// Bead's mapping also reads. A message by its full name, its fields by JSON name, closed; a 32-bit
// integer an `integer` of its range; a 64-bit one a `string` of its digits' pattern; a `float` or a
// `double` a `number`, or `"NaN"`, `"Infinity"` or `"-Infinity"`; `bytes` base64; an enum its names
// or a number; a repeated field an array; a map an object whose `propertyNames` are its key's form;
// a `oneof` its members, two never together; the well-known types in their own forms. Where the base
// dialect's `format` and `contentEncoding` only annotate, a `pattern` beside them holds exactly what
// the mapping reads, in ECMA-262's dialect with no lookaround (11.8); what no schema carries is said
// in its `description` (11.9). A message's rules join its fields' schemas (`rules.ts`).

// dependencies

import type {
  FieldType,
  IBlueprint,
  IEnumEntry,
  IFieldEntry,
  IMessageEntry,
  ScalarName,
} from '../model/blueprint.ts';
import { type IMessagePlan, judgedMessagesOf, messagePlanOf } from '../model/rules.ts';
import { NULL_VALUE } from '../model/routes.ts';
import { fieldKeywordsOf, type IFieldKeywords, type Schema } from './rules.ts';

// constants

/** Where the document's schemas are, as a `$ref` names one. */
export const SCHEMAS = '#/components/schemas/';

// the 32-bit integers' ranges
const RANGES: Readonly<Partial<Record<ScalarName, readonly [number, number]>>> = Object.freeze({
  int32: [-2_147_483_648, 2_147_483_647],
  sint32: [-2_147_483_648, 2_147_483_647],
  sfixed32: [-2_147_483_648, 2_147_483_647],
  uint32: [0, 4_294_967_295],
  fixed32: [0, 4_294_967_295],
});

// the 64-bit integers, signed and not
const SIGNED_64 = new Set<ScalarName>(['int64', 'sint64', 'sfixed64']);
const UNSIGNED_64 = new Set<ScalarName>(['uint64', 'fixed64']);

// ! what a float's reading rounds to its largest finite value lies below the midpoint between it and
// 2^128, which rounds, to even, past it (transcoding 5.3.3): the bound a float's number holds to
const FLOAT_PAST = 2 ** 128 - 2 ** 103;

/** A 64-bit signed integer's digits, 19 at most (11.7). */
export const SIGNED_64_PATTERN = '^-?(0|[1-9][0-9]{0,18})$';

/** A 64-bit unsigned integer's digits, 20 at most. */
export const UNSIGNED_64_PATTERN = '^(0|[1-9][0-9]{0,19})$';

/**
 * A `Timestamp` as Bead's mapping reads one (transcoding 5.4.1): RFC 3339's `date-time`, a year of
 * `0001` to `9999`, its month and day by their digits, its hour `00` to `23`, its minute and second
 * `00` to `59`, 1 to 9 fraction digits or none, upper-case `T`, and `Z` or an offset `±hh:mm`.
 */
export const TIMESTAMP_PATTERN =
  '^([1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$';

/** A `Duration` as Bead's mapping reads one (5.4.2). */
export const DURATION_PATTERN = '^-?(0|[1-9][0-9]*)(\\.[0-9]{1,9})?s$';

/** A `FieldMask` as Bead's mapping reads one (5.4.3): paths by `,`, segments by `.`, each lowerCamelCase. */
export const FIELD_MASK_PATTERN =
  '^([a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*(,[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*)*)?$';

/** `bytes` as Bead's mapping reads them (5.3.6): base64 of one alphabet, padded correctly or not at all. */
export const BASE64_PATTERN =
  '^(([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}(==)?|[A-Za-z0-9+/]{3}=?)?|([A-Za-z0-9_-]{4})*([A-Za-z0-9_-]{2}(==)?|[A-Za-z0-9_-]{3}=?)?)$';

// a map key's form, by its scalar (5.3.8)
const SIGNED_KEY = '^-?(0|[1-9][0-9]*)$';
const UNSIGNED_KEY = '^(0|[1-9][0-9]*)$';

// what each well-known message's schema is, its form the mapping's
const WELL_KNOWN: Readonly<Record<string, Schema>> = Object.freeze({
  'google.protobuf.Timestamp': {
    type: 'string',
    format: 'date-time',
    pattern: TIMESTAMP_PATTERN,
    description:
      "A google.protobuf.Timestamp: RFC 3339's date-time, written in UTC with Z. A day past its month's end, and an instant outside 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999999Z, are refused, which no pattern holds.",
  },
  'google.protobuf.Duration': {
    type: 'string',
    pattern: DURATION_PATTERN,
    description:
      'A google.protobuf.Duration: its seconds, then s. One past ±315,576,000,000 seconds is refused, which no pattern holds.',
  },
  'google.protobuf.FieldMask': {
    type: 'string',
    pattern: FIELD_MASK_PATTERN,
    description:
      'A google.protobuf.FieldMask: its paths in lowerCamelCase, by commas. A path whose snake case does not give it back is refused.',
  },
  'google.protobuf.Struct': {
    type: 'object',
    description: 'A google.protobuf.Struct: JSON itself.',
  },
  'google.protobuf.Value': {
    description: 'A google.protobuf.Value: any JSON value, a number finite.',
  },
  'google.protobuf.ListValue': {
    type: 'array',
    description: 'A google.protobuf.ListValue: a JSON array.',
  },
  'google.protobuf.Any': {
    type: 'object',
    properties: { '@type': { type: 'string', pattern: '/' } },
    description:
      "A google.protobuf.Any: its @type, a URL whose last part names a message of the document's, then that message's members, or its value for a well-known type of a form of its own; {} the empty Any.",
  },
  'google.protobuf.Empty': { type: 'object', additionalProperties: false },
});

// a wrapper's full name, by the scalar it wraps
const WRAPPED: Readonly<Record<string, ScalarName>> = Object.freeze({
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

// helpers

/** A schema that names a message's or an enum's component, by its full name. */
export const refOf = (fullName: string): Schema => {
  return { $ref: `${SCHEMAS}${fullName}` };
};

/** A scalar's schema, as Bead's proto JSON form writes it. */
export const scalarSchemaOf = (scalar: ScalarName): Schema => {
  const range = RANGES[scalar];

  if (range !== undefined) {
    return { type: 'integer', minimum: range[0], maximum: range[1] };
  }

  if (SIGNED_64.has(scalar) || UNSIGNED_64.has(scalar)) {
    return {
      type: 'string',
      format: SIGNED_64.has(scalar) ? 'int64' : 'uint64',
      pattern: SIGNED_64.has(scalar) ? SIGNED_64_PATTERN : UNSIGNED_64_PATTERN,
      description: `A 64-bit integer, ${scalar}, as a decimal string. One past its type's range is refused, which its pattern does not hold; Bead's mapping reads a JSON number of it too.`,
    };
  }

  if (scalar === 'float' || scalar === 'double') {
    return {
      anyOf: [
        {
          type: 'number',
          format: scalar,
          ...(scalar === 'float'
            ? { exclusiveMinimum: -FLOAT_PAST, exclusiveMaximum: FLOAT_PAST }
            : {}),
        },
        { enum: ['NaN', 'Infinity', '-Infinity'] },
      ],
    };
  }

  if (scalar === 'bool') {
    return { type: 'boolean' };
  }

  return scalar === 'bytes'
    ? { type: 'string', contentEncoding: 'base64', pattern: BASE64_PATTERN }
    : { type: 'string' };
};

// a map key's schema, by its scalar's form (5.3.8)
const keySchemaOf = (key: ScalarName): Schema => {
  if (key === 'bool') {
    return { enum: ['true', 'false'] };
  }

  if (key === 'string') {
    return { type: 'string' };
  }

  return {
    pattern: SIGNED_64.has(key) || (RANGES[key]?.[0] ?? 0) < 0 ? SIGNED_KEY : UNSIGNED_KEY,
  };
};

/** A field's type's schema, an item's or a map value's: no label. */
export const typeSchemaOf = (type: FieldType): Schema => {
  if ('scalar' in type) {
    return scalarSchemaOf(type.scalar);
  }

  if ('wrapper' in type) {
    return scalarSchemaOf(type.wrapper);
  }

  if ('enum' in type) {
    return type.enum === NULL_VALUE ? { type: 'null' } : refOf(type.enum);
  }

  const wrapped = WRAPPED[type.message];

  if (wrapped !== undefined) {
    return scalarSchemaOf(wrapped);
  }

  const known = WELL_KNOWN[type.message];

  return known === undefined ? refOf(type.message) : { ...known };
};

/** A message's schema by its full name: a well-known type's form, or its component. */
export const messageSchemaOf = (fullName: string): Schema => {
  return typeSchemaOf({ message: fullName });
};

const allOf = (schema: Schema, more: readonly Schema[]): Schema => {
  return more.length === 0 ? schema : { allOf: [schema, ...more] };
};

/** A field's schema, its label's and its rules' with its type's, its description and its deprecation. */
export const fieldSchemaOf = (field: IFieldEntry, keywords?: IFieldKeywords): Schema => {
  const item = allOf(typeSchemaOf(field.type), keywords?.items ?? []);
  const schema =
    field.label === 'repeated'
      ? { type: 'array', items: item }
      : field.label === 'map'
        ? {
            type: 'object',
            propertyNames: allOf(keySchemaOf(field.key ?? 'string'), keywords?.keys ?? []),
            additionalProperties: allOf(typeSchemaOf(field.type), keywords?.values ?? []),
          }
        : typeSchemaOf(field.type);
  const unheld = keywords?.unheld ?? [];
  const words = [
    ...(field.description === undefined ? [] : [field.description]),
    ...(unheld.length === 0
      ? []
      : [
          `Beside this schema, the gateway refuses a value of which it says: ${unheld.join('; ')}.`,
        ]),
  ];

  return {
    ...allOf(schema, keywords?.value ?? []),
    ...(words.length === 0 ? {} : { description: words.join('\n\n') }),
    ...(field.deprecated === true ? { deprecated: true } : {}),
  };
};

/** A message's rules as its schema takes them: its plan, and its fields' keywords by number. */
export interface IMessageKeywords {
  readonly plan?: IMessagePlan;
  readonly keywords?: ReadonlyMap<number, IFieldKeywords>;
}

/** The rules of a message, by its full name: none where it holds none. */
export type KeywordsOf = (fullName: string) => IMessageKeywords;

/** The rules of each of `blueprint`'s messages, by full name, as their schemas take them. */
export const keywordsOfBlueprint = (blueprint: IBlueprint): KeywordsOf => {
  const enums = new Map(
    (blueprint.proto?.enums ?? []).map((entry) => {
      return [entry.fullName, entry] as const;
    })
  );
  const rules = judgedMessagesOf(blueprint);
  const judged = new Set(rules.keys());
  const enumOf = (name: string): IEnumEntry | undefined => {
    return enums.get(name);
  };
  const known = new Map<string, IMessageKeywords>();

  return (fullName) => {
    const cached = known.get(fullName);

    if (cached !== undefined) {
      return cached;
    }

    const own = rules.get(fullName);
    const plan = own === undefined ? undefined : messagePlanOf(fullName, { rules: own, judged });
    const found = plan === undefined ? {} : { plan, keywords: fieldKeywordsOf(plan, enumOf) };

    known.set(fullName, found);

    return found;
  };
};

// the paths `bound` names under a field, behind its name and a `.`
const innerOf = (field: IFieldEntry, bound: ReadonlySet<string>): string[] => {
  return [...bound]
    .filter((path) => {
      return path.startsWith(`${field.fieldName}.`);
    })
    .map((path) => {
      return path.slice(field.fieldName.length + 1);
    });
};

// whether a message whose fields `bound` names by their proto paths keeps, left to the body, a
// field of LEGACY_REQUIRED presence: one no path names, or one whose own fields a path names and
// whose message keeps one in turn (transcoding 11.5)
const keepsRequired = (
  entry: IMessageEntry,
  details: {
    readonly bound: ReadonlySet<string>;
    readonly messages: ReadonlyMap<string, IMessageEntry>;
  }
): boolean => {
  return (entry.fields ?? []).some((field) => {
    if (details.bound.has(field.fieldName)) {
      return false;
    }

    const inner = innerOf(field, details.bound);
    const held = 'message' in field.type ? details.messages.get(field.type.message) : undefined;

    return inner.length > 0 && held?.fields !== undefined
      ? keepsRequired(held, { bound: new Set(inner), messages: details.messages })
      : field.legacyRequired === true;
  });
};

// a message's own rules in JSON Schema's words: a oneof required, one of its members there; a
// message's oneof rule, at most one of the fields it names, and one where it is required
const messageKeywordsOf = (entry: IMessageEntry, plan: IMessagePlan | undefined): Schema[] => {
  const fields = entry.fields ?? [];
  const jsonOf = (name: string): string | undefined => {
    return fields.find((field) => {
      return field.fieldName === name;
    })?.jsonName;
  };
  const oneOfThem = (members: readonly string[]): Schema => {
    return {
      anyOf: members.map((member) => {
        return { required: [member] };
      }),
    };
  };
  const atMostOne = (members: readonly string[]): Schema => {
    return {
      not: {
        anyOf: members.flatMap((member, at) => {
          return members.slice(at + 1).map((other) => {
            return { required: [member, other] };
          });
        }),
      },
    };
  };

  return [
    ...(plan?.oneofs ?? []).map((oneof) => {
      return oneOfThem(
        fields
          .filter((field) => {
            return field.oneof === oneof.name;
          })
          .map((field) => {
            return field.jsonName;
          })
      );
    }),
    ...(plan?.oneofRules ?? []).flatMap((rule) => {
      const members = rule.fields.flatMap((field) => {
        const json = jsonOf(field.fieldName);

        return json === undefined ? [] : [json];
      });

      return [
        ...(members.length > 1 ? [atMostOne(members)] : []),
        ...(rule.none === undefined ? [] : [oneOfThem(members)]),
      ];
    }),
  ];
};

/**
 * A message's schema, closed: its fields by JSON name, each `oneof`'s members never two together,
 * what its rules require and each field of `LEGACY_REQUIRED` presence required, by number, and its
 * own rules beside them; `bound`, the fields by their proto paths a route binds elsewhere, left out,
 * a message whose own fields it binds there written inline, its rules by `keywordsOf` kept, and
 * required where it keeps a field of `LEGACY_REQUIRED` presence left to the body.
 */
export const objectSchemaOf = (
  entry: IMessageEntry,
  details: IMessageKeywords & {
    readonly messages: ReadonlyMap<string, IMessageEntry>;
    readonly bound?: ReadonlySet<string>;
    readonly keywordsOf?: KeywordsOf;
  }
): Schema => {
  const bound = details.bound ?? new Set<string>();
  const fields = (entry.fields ?? []).filter((field) => {
    return !bound.has(field.fieldName);
  });
  const inline = new Set<number>();
  const properties = Object.fromEntries(
    fields.map((field) => {
      const keywords = details.keywords?.get(field.fieldNumber);
      const inner = innerOf(field, bound);
      const held = 'message' in field.type ? details.messages.get(field.type.message) : undefined;

      // * a field whose own fields a route binds elsewhere is its message's schema less them, inline,
      // its message's rules and its own kept
      if (inner.length > 0 && held?.fields !== undefined) {
        inline.add(field.fieldNumber);

        return [
          field.jsonName,
          allOf(
            objectSchemaOf(held, {
              messages: details.messages,
              bound: new Set(inner),
              ...(details.keywordsOf === undefined
                ? {}
                : { keywordsOf: details.keywordsOf, ...details.keywordsOf(held.fullName) }),
            }),
            keywords?.value ?? []
          ),
        ];
      }

      return [field.jsonName, fieldSchemaOf(field, keywords)];
    })
  );
  const oneofs = new Map<string, string[]>();

  for (const field of fields) {
    if (field.oneof !== undefined) {
      oneofs.set(field.oneof, [...(oneofs.get(field.oneof) ?? []), field.jsonName]);
    }
  }

  // * two members of one oneof never together: each member's presence takes none of the others
  const dependent = Object.fromEntries(
    [...oneofs.values()]
      .filter((members) => {
        return members.length > 1;
      })
      .flatMap((members) => {
        return members.map((member) => {
          return [
            member,
            {
              not: {
                anyOf: members
                  .filter((other) => {
                    return other !== member;
                  })
                  .map((other) => {
                    return { required: [other] };
                  }),
              },
            },
          ];
        });
      })
  );
  // * what its rules require, and what protobuf requires (transcoding 11.7); a field a variable binds
  // into, which that variable holds present, where its message keeps one left to the body (11.5)
  const required = fields
    .filter((field) => {
      const held = 'message' in field.type ? details.messages.get(field.type.message) : undefined;

      if (inline.has(field.fieldNumber) && held !== undefined) {
        return keepsRequired(held, {
          bound: new Set(innerOf(field, bound)),
          messages: details.messages,
        });
      }

      return (
        details.keywords?.get(field.fieldNumber)?.required === true || field.legacyRequired === true
      );
    })
    .map((field) => {
      return field.jsonName;
    });

  const own = messageKeywordsOf(entry, details.plan);

  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(Object.keys(dependent).length === 0 ? {} : { dependentSchemas: dependent }),
    ...(required.length === 0 ? {} : { required }),
    ...(own.length === 0 ? {} : { allOf: own }),
    description: `${entry.fullName}. Bead's mapping reads each field by its proto name too.`,
  };
};

// definition

/** An enum's schema: its names, or a number, which Bead's mapping writes where no value names it. */
export const enumSchemaOf = (entry: IEnumEntry): Schema => {
  return {
    anyOf: [
      {
        type: 'string',
        enum: [
          ...new Set(
            entry.values.map((value) => {
              return value.name;
            })
          ),
        ],
      },
      { type: 'integer', minimum: -2_147_483_648, maximum: 2_147_483_647 },
    ],
    description: `${entry.fullName}, by the name of its value declared first for its number; a number where none names it. Bead's mapping reads any of its names, and its number.`,
  };
};

/** The document's schemas of `blueprint`'s messages and enums, by full name, its rules joined. */
export const componentSchemasOf = (blueprint: IBlueprint): Record<string, Schema> => {
  const messages = new Map(
    (blueprint.proto?.messages ?? []).map((message) => {
      return [message.fullName, message] as const;
    })
  );
  const keywordsOf = keywordsOfBlueprint(blueprint);

  return {
    ...Object.fromEntries(
      [...messages.values()]
        .filter((message) => {
          return message.fields !== undefined;
        })
        .map((message) => {
          return [
            message.fullName,
            objectSchemaOf(message, { messages, ...keywordsOf(message.fullName) }),
          ];
        })
    ),
    ...Object.fromEntries(
      (blueprint.proto?.enums ?? []).map((entry) => {
        return [entry.fullName, enumSchemaOf(entry)];
      })
    ),
  };
};
