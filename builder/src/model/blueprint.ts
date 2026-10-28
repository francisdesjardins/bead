// ── Blueprint ─────────────────────────────────────────────────────────────────

// A blueprint, `bead-blueprint/1` (decision 0022), and how one given as bytes is read, in one order:
// its JSON and I-JSON (BLUEPRINT_JSON), its format (FORMAT_UNKNOWN), its features (FEATURE_UNKNOWN),
// the format's schema, each refusal mapped to its rule by its place, then the rules that span
// entries and SPEC_VERSION_NEWER. A stage that finds an error ends the reading: what follows reads
// the blueprint as the earlier stages left it. `beadc breaking` reads an earlier release's blueprint
// up to its schema alone: the rules a later beadc added never judge it.

// dependencies

import { readFileSync } from 'node:fs';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  diagnosticOf,
  hasError,
  type IDiagnostic,
  type IPlace,
  pointerOf,
  tokenOf,
} from '../diagnostics.ts';
import type { RuleName } from '../rules.ts';
import { FORMAT, specUrlOf, specVersion } from '../version.ts';
import { checkBlueprint } from './check-blueprint.ts';
import { reasonRankOf } from './identity.ts';
import { type IPosition, scan } from './scan.ts';

// types

/** A payload's encoding (spec 17): `raw`, `text` and `json` are Bead's payload types', `proto` any other message's. */
export type Encoding = 'raw' | 'text' | 'json' | 'proto';

/** How a procedure is called (spec 16.11). */
export type ProcedureKind = 'request' | 'notifies' | 'command';

/** Who may call a procedure: every call, a call with a session, or a named hook. */
export type AdmissionRule = 'none' | 'session' | { readonly hook: string };

/** A payload's encoding, and for `proto` alone its message's full name. */
export interface IBinding {
  readonly encoding: Encoding;
  readonly message?: string;
}

/** Deprecated, with what to use instead when it says. */
export interface IDeprecation {
  readonly message?: string;
}

/** Ids from first to last, both included. */
export interface IRange {
  readonly first: number;
  readonly last: number;
}

/** An HTTP method a `google.api.http` rule's pattern names, in upper case (decision 0037). */
export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';

/** A `google.api.http` rule: its method, its path template, its body and its response body. */
export interface IHttpRule {
  readonly method: HttpMethod;
  readonly template: string;
  /** `*`, the request whole, or a top-level field's name; none for no body. */
  readonly body?: string;
  /** A top-level field of the result, whose JSON is the response's body. */
  readonly responseBody?: string;
}

/** `descriptor.proto`'s `MethodOptions.idempotency_level`, but `IDEMPOTENCY_UNKNOWN`. */
export type IdempotencyLevel = 'NO_SIDE_EFFECTS' | 'IDEMPOTENT';

/** What a method's options say of its procedure over HTTP: its idempotency and its rules. */
export interface IHttpEntry {
  readonly idempotencyLevel?: IdempotencyLevel;
  /** Its rules, each of `additional_bindings` one of its own, in their order. */
  readonly rules: readonly IHttpRule[];
}

/** A procedure, resolved: no default, no inheritance. */
export interface IProcedureEntry {
  readonly procedureId: number;
  readonly procedureName: string;
  readonly procedureKind: ProcedureKind;
  readonly request: IBinding;
  readonly result: IBinding;
  readonly notification?: IBinding;
  readonly admission: AdmissionRule;
  readonly failures: readonly string[];
  readonly maximumPayloadBytes?: number;
  /** What its method's options say of it over HTTP, where they say anything (decision 0037). */
  readonly http?: IHttpEntry;
  readonly description?: string;
  readonly deprecation?: IDeprecation;
}

/** A failure of a service's catalogue (spec 9.5). */
export interface IFailureEntry {
  readonly code: number;
  readonly failureName: string;
  readonly description?: string;
  readonly deprecation?: IDeprecation;
}

/** A service: its ids, its catalogue, its reservations and its procedures. */
export interface IServiceEntry {
  readonly serviceName: string;
  readonly serviceId: number;
  readonly serviceRevision: number;
  readonly description?: string;
  readonly deprecation?: IDeprecation;
  readonly failures: readonly IFailureEntry[];
  readonly reserved: {
    readonly procedureIds: readonly IRange[];
    readonly procedureNames: readonly string[];
    readonly failureCodes: readonly IRange[];
  };
  readonly procedures: readonly IProcedureEntry[];
  /** Where a front end read it. */
  readonly proto?: { readonly file: string; readonly fullName: string };
}

/** A protobuf scalar, by its name in `descriptor.proto`'s `FieldDescriptorProto.Type`, lowered. */
export type ScalarName =
  | 'double'
  | 'float'
  | 'int64'
  | 'uint64'
  | 'int32'
  | 'fixed64'
  | 'fixed32'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'uint32'
  | 'sfixed32'
  | 'sfixed64'
  | 'sint32'
  | 'sint64';

/**
 * A field's type, as its rules read it: a scalar, an enum or a message by its full name, or one of
 * `google/protobuf/wrappers.proto`'s messages by the scalar it wraps.
 */
export type FieldType =
  | { readonly scalar: ScalarName }
  | { readonly enum: string }
  | { readonly message: string }
  | { readonly wrapper: ScalarName };

/** A JSON value, as protobuf's JSON mapping writes a rule's member. */
export type RuleValue =
  | string
  | number
  | boolean
  | readonly RuleValue[]
  | { readonly [member: string]: RuleValue };

/**
 * A field's `(buf.validate.field)`, in protobuf's JSON mapping by proto names, as `validate.proto`
 * writes them: a 64-bit integer as a string, a float's or a double's value as a string, the double it
 * is (spec 17.7.4), a value not finite as `Infinity`, `-Infinity` or `NaN` (decision 0035).
 */
export type FieldRulesValue = { readonly [member: string]: RuleValue };

/** A field a message's rules judge: one that holds a rule, or leads to a message that does. */
export interface IFieldRulesEntry {
  readonly fieldName: string;
  readonly fieldNumber: number;
  readonly type: FieldType;
  /** `repeated`, or `map` with its key's scalar; none for a singular field. */
  readonly label?: 'repeated' | 'map';
  readonly key?: ScalarName;
  /** Whether it tracks presence: a repeated field and a map never do. */
  readonly presence: 'explicit' | 'implicit';
  /** The `oneof` it is a member of, by its name. */
  readonly oneof?: string;
  readonly rules?: FieldRulesValue;
}

/** A `oneof`'s `(buf.validate.oneof)`, by its name and its index among its message's. */
export interface IOneofRulesEntry {
  readonly oneofIndex: number;
  readonly oneofName: string;
  readonly rules: { readonly required?: boolean };
}

/** A message's rules: its fields', by number, its own `(buf.validate.message)`, its oneofs'. */
export interface IMessageRules {
  readonly fields: readonly IFieldRulesEntry[];
  readonly message: {
    readonly oneof?: readonly { readonly fields: readonly string[]; readonly required?: boolean }[];
  };
  readonly oneofs: readonly IOneofRulesEntry[];
}

/** A field of a message, as a route binds it and a document describes it (decision 0037). */
export interface IFieldEntry {
  readonly fieldName: string;
  readonly fieldNumber: number;
  readonly jsonName: string;
  readonly type: FieldType;
  /** `repeated`, or `map` with its key's scalar; none for a singular field. */
  readonly label?: 'repeated' | 'map';
  readonly key?: ScalarName;
  /** Whether it tracks presence: a repeated field and a map never do. */
  readonly presence: 'explicit' | 'implicit';
  /**
   * Under the feature `legacy-required`: a field of `LEGACY_REQUIRED` presence, proto2's `required`,
   * which a message that leaves it unset neither reads nor writes (spec 17.9.7, decision 0042).
   */
  readonly legacyRequired?: true;
  /** The `oneof` it is a member of, by its name; a synthetic one never. */
  readonly oneof?: string;
  readonly description?: string;
  readonly deprecated?: true;
}

/** A message a binding names, or a field of one reaches, or a request's rules reach, with its file. */
export interface IMessageEntry {
  readonly fullName: string;
  readonly file: string;
  /**
   * Its fields, by number (decision 0037): left out of a well-known type, whose JSON is its own
   * form, and of a blueprint an earlier beadc wrote.
   */
  readonly fields?: readonly IFieldEntry[];
  /** Under the feature `validate`: its rules, where a request's rules reach it (decision 0035). */
  readonly rules?: IMessageRules;
}

/** An enum a field names: its values in their declaration's order, an alias among them. */
export interface IEnumEntry {
  readonly fullName: string;
  readonly file: string;
  readonly values: readonly { readonly name: string; readonly number: number }[];
}

/** What a front end read of a `.proto`: its files, the messages its bindings reach, their enums. */
export interface IProtoSource {
  readonly files: readonly { readonly path: string; readonly package: string }[];
  readonly messages: readonly IMessageEntry[];
  readonly enums?: readonly IEnumEntry[];
}

/** A blueprint, `bead-blueprint/1`. */
export interface IBlueprint {
  readonly format: string;
  readonly specVersion: string;
  readonly requires: readonly string[];
  readonly proto?: IProtoSource;
  readonly reservedServices: { readonly ids: readonly IRange[]; readonly names: readonly string[] };
  readonly services: readonly IServiceEntry[];
}

/** Where a finding at a blueprint's pointer is printed. */
export type PlaceOf = (pointer: string) => IPlace;

/** What reading a blueprint gives: its findings, and the blueprint when no stage refused it. */
export interface IReading {
  readonly diagnostics: readonly IDiagnostic[];
  readonly blueprint?: IBlueprint;
  /** Where each pointer is in the text it was read from, for a blueprint read as bytes. */
  readonly placeOf?: PlaceOf;
}

// constants

/**
 * The feature a blueprint requires where a message carries its rules: a reader that does not know
 * it refuses the blueprint, and never generates a side that judges nothing (decision 0035).
 */
export const VALIDATE_FEATURE = 'validate';

/**
 * The feature a blueprint requires where a message's field is of `LEGACY_REQUIRED` presence: a
 * reader that does not know it refuses the blueprint, and never generates a side or a document that
 * takes a message its server refuses (decision 0042).
 */
export const LEGACY_REQUIRED_FEATURE = 'legacy-required';

/** The features of `requires` this beadc knows. */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set<string>([
  LEGACY_REQUIRED_FEATURE,
  VALIDATE_FEATURE,
]);

const BYTE_ORDER_MARK = '\uFEFF';

// what ajv names a refusal by, and what a place's rule says
const COMPOSITE_KEYWORDS = new Set(['oneOf', 'anyOf', 'if', 'not']);
const UNDER_A_BRANCH = /\/(?:oneOf|anyOf)\/\d+\//u;
const ADMISSION = /^\/services\/\d+\/procedures\/\d+\/admission$/u;

// what a list left empty means, at the places where a .proto leaves one so
const EMPTY_LIST: readonly (readonly [RegExp, string])[] = [
  [/^\/services$/u, 'no service declares (bead.service)'],
  [/^\/services\/\d+\/procedures$/u, 'a Bead service declares no rpc'],
];

/** The rule each place of the format's schema gives its refusals (decision 0022's D19). */
const RULE_OF_PLACE: readonly (readonly [RegExp, RuleName, string])[] = [
  [
    /^\/services\/\d+\/serviceId$/u,
    'SERVICE_ID_RANGE',
    "a service's id is a whole number from 1 to 65535 (spec 16.2)",
  ],
  [
    /^\/services\/\d+\/serviceRevision$/u,
    'SERVICE_REVISION_RANGE',
    "a service's revision is a whole number from 1 to 2147483647 (spec 16.2)",
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/procedureId$/u,
    'PROCEDURE_ID_RANGE',
    "a procedure's id is a whole number from 1 to 65535 (spec 16.2)",
  ],
  [
    /^\/services\/\d+\/failures\/\d+\/code$/u,
    'FAILURE_CODE',
    "a failure's code is a whole number from 1 to 65535 (spec 9.5)",
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/maximumPayloadBytes$/u,
    'PROCEDURE_LIMIT_RANGE',
    "a procedure's maximumPayloadBytes is a whole number from 1 to 2147483647",
  ],
  [
    /^\/(?:reservedServices\/ids|services\/\d+\/reserved\/(?:procedureIds|failureCodes))\/\d+\/(?:first|last)$/u,
    'RESERVED_RANGE',
    "a reserved range's ends are whole numbers from 1 to 65535",
  ],
  [
    /^\/services\/\d+\/serviceName$/u,
    'NAME_FORM',
    "a service's name is an upper-case ASCII letter, then 62 ASCII letters or digits at most (builder/README.md)",
  ],
  [
    /^\/reservedServices\/names\/\d+$/u,
    'NAME_FORM',
    "a reserved service's name is an upper-case ASCII letter, then 62 ASCII letters or digits at most (builder/README.md)",
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/procedureName$/u,
    'NAME_FORM',
    "a procedure's name is a lower-case ASCII letter, then 62 ASCII letters or digits at most (spec 16.4)",
  ],
  [
    /^\/services\/\d+\/reserved\/procedureNames\/\d+$/u,
    'NAME_FORM',
    "a reserved procedure's name is a lower-case ASCII letter, then 62 ASCII letters or digits at most (spec 16.4)",
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/admission\/hook$/u,
    'NAME_FORM',
    "a hook's name is a procedure's, a lower-case ASCII letter, then 62 ASCII letters or digits at most (builder/README.md)",
  ],
  [
    /^\/services\/\d+\/failures\/\d+\/failureName$/u,
    'NAME_FORM',
    "a failure's name is upper-case ASCII letters and digits in words parted by one underscore (builder/README.md)",
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/failures\/\d+$/u,
    'NAME_FORM',
    "a failure's name is upper-case ASCII letters and digits in words parted by one underscore (builder/README.md)",
  ],
  [
    /^\/(?:services\/\d+\/proto\/file|proto\/(?:messages|enums)\/\d+\/file|proto\/files\/\d+\/path)$/u,
    'PROTO_FILE',
    'a proto path is a path from its root, parts by /, none . or .., ending in .proto',
  ],
  [
    /^\/services\/\d+\/procedures\/\d+\/notification$/u,
    'NOTIFICATION_MESSAGE',
    'a notification binding is there exactly when its procedure notifies (spec 11.2)',
  ],
];

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// the format's schema, with the schema it takes its definitions from, each under its file's name, as
// spec/check.py's registry keys them; compiled once, at the first blueprint read
let validator: ValidateFunction | undefined;

const validatorOf = (): ValidateFunction => {
  if (validator === undefined) {
    // ! ajv's defaults but these: every refusal, not the first; the references inlined, stated so
    // that an upgrade moving ajv's default moves nothing in silence; and the refused schema kept on
    // each refusal, which places a `not` of one member at that member. `strict: true` refuses the
    // landed schema (strictRequired)
    const ajv = new Ajv2020({ allErrors: true, inlineRefs: true, verbose: true });
    const read = (name: string): unknown => {
      return JSON.parse(readFileSync(specUrlOf(`schemas/${name}`), 'utf8'));
    };

    ajv.addSchema(read('common.schema.json') as object, 'common.schema.json');
    ajv.addSchema(read('bead-blueprint.schema.json') as object, 'bead-blueprint.schema.json');
    validator = ajv.getSchema('bead-blueprint.schema.json');

    if (validator === undefined) {
      throw new Error('spec/schemas/bead-blueprint.schema.json did not compile');
    }
  }

  return validator;
};

// the value at `pointer` in `value`, or undefined
const valueAt = (value: unknown, pointer: string): unknown => {
  let at = value;

  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');

    if (Array.isArray(at)) {
      at = at[Number(key)];
    } else if (isRecord(at) && Object.hasOwn(at, key)) {
      at = at[key];
    } else {
      return undefined;
    }
  }

  return at;
};

const describe = (value: unknown): string => {
  return value === undefined ? 'none stated' : `not ${JSON.stringify(value)}`;
};

// the place a refusal is about: a member missing, a member unknown, or a member a `not` refuses
// sits under the object ajv names
const placeOfRefusal = (error: ErrorObject): string => {
  const params = error.params as Record<string, unknown>;

  if (error.keyword === 'required' && typeof params['missingProperty'] === 'string') {
    return `${error.instancePath}/${tokenOf(params['missingProperty'])}`;
  }

  if (
    error.keyword === 'additionalProperties' &&
    typeof params['additionalProperty'] === 'string'
  ) {
    return `${error.instancePath}/${tokenOf(params['additionalProperty'])}`;
  }

  if (error.keyword === 'not' && isRecord(error.schema)) {
    const required = error.schema['required'];

    if (Array.isArray(required) && required.length === 1 && typeof required[0] === 'string') {
      return `${error.instancePath}/${tokenOf(required[0])}`;
    }
  }

  return error.instancePath;
};

const isComposite = (error: ErrorObject): boolean => {
  return (
    (COMPOSITE_KEYWORDS.has(error.keyword) && placeOfRefusal(error) === error.instancePath) ||
    UNDER_A_BRANCH.test(error.schemaPath)
  );
};

const isUnder = (pointer: string, place: string): boolean => {
  return pointer.startsWith(`${place}/`);
};

// RFC 6901 pointers in the order their values are written: token by token, an index as a number
const comparePointers = (one: string, other: string): number => {
  const left = one.split('/');
  const right = other.split('/');

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';

    if (a !== b) {
      const numbers = /^\d+$/u.test(a) && /^\d+$/u.test(b);

      return numbers ? Number(a) - Number(b) : a < b ? -1 : 1;
    }
  }

  return left.length - right.length;
};

/** Findings in 16.10's order, a range's first, then a name's form, then the others, each by its place. */
export const sortFindings = (diagnostics: readonly IDiagnostic[]): IDiagnostic[] => {
  return [...diagnostics].sort((one, other) => {
    return (
      reasonRankOf(one.rule) - reasonRankOf(other.rule) ||
      comparePointers(one.pointer ?? '', other.pointer ?? '')
    );
  });
};

// the format's schema's refusals, a finding a place and a keyword, each mapped to its rule by its
// place: a `oneOf`, `anyOf`, `if` or `not`, and its branches' refusals at its place, are dropped when
// a refusal lies under that place, and are one finding otherwise
const schemaFindingsOf = (
  value: unknown,
  details: { readonly errors: readonly ErrorObject[]; readonly placeOf: PlaceOf }
): IDiagnostic[] => {
  const refusals = details.errors.map((error) => {
    const composite = isComposite(error);

    // a branch's refusal is its alternative's, at the place the alternatives are
    return { error, place: composite ? error.instancePath : placeOfRefusal(error), composite };
  });
  const findings = new Map<string, { place: string; message: string }>();

  for (const refusal of refusals) {
    if (refusal.composite) {
      const deeper = refusals.some((other) => {
        return !other.composite && isUnder(other.place, refusal.place);
      });

      if (!deeper && !findings.has(`${refusal.place} composite`)) {
        findings.set(`${refusal.place} composite`, {
          place: refusal.place,
          message: `${refusal.place || 'the blueprint'} fits none of the format's forms`,
        });
      }
    } else {
      const key = `${refusal.place} ${refusal.error.keyword}`;

      if (!findings.has(key)) {
        const empty =
          refusal.error.keyword === 'minItems'
            ? EMPTY_LIST.find(([pattern]) => {
                return pattern.test(refusal.place);
              })
            : undefined;
        const message =
          empty !== undefined
            ? empty[1]
            : refusal.error.keyword === 'additionalProperties'
              ? 'a member the format does not know'
              : refusal.error.keyword === 'required'
                ? 'a member the format requires, missing'
                : (refusal.error.message ?? 'refused');

        findings.set(key, { place: refusal.place, message });
      }
    }
  }

  const diagnostics: IDiagnostic[] = [];
  const admissionsEmpty = new Set<string>();

  for (const { place, message } of findings.values()) {
    const at = valueAt(value, place);

    // ! an admission that is an object holding no member states no rule: ADMISSION_EMPTY, read off
    // the instance, every refusal of the schema at that place dropped
    if (ADMISSION.test(place) && isRecord(at) && Object.keys(at).length === 0) {
      if (!admissionsEmpty.has(place)) {
        admissionsEmpty.add(place);
        diagnostics.push(
          diagnosticOf('ADMISSION_EMPTY', {
            message: 'an admission that states no rule: none, session or a hook',
            place: details.placeOf(place),
          })
        );
      }
      continue;
    }

    const mapped = RULE_OF_PLACE.find(([pattern]) => {
      return pattern.test(place);
    });

    diagnostics.push(
      mapped === undefined
        ? diagnosticOf('BLUEPRINT_SCHEMA', { message, place: details.placeOf(place) })
        : diagnosticOf(mapped[1], {
            message: `${mapped[2]}, ${describe(at)}`,
            place: details.placeOf(place),
          })
    );
  }

  return sortFindings(diagnostics);
};

// each place of `value` whose string, a member's name or its value, holds a surrogate alone
const surrogatesOf = (value: unknown, keys: readonly (string | number)[]): string[] => {
  if (typeof value === 'string') {
    return value.isWellFormed() ? [] : [pointerOf(keys)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      return surrogatesOf(item, [...keys, index]);
    });
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, member]) => {
      return [
        ...(key.isWellFormed() ? [] : [pointerOf([...keys, key])]),
        ...surrogatesOf(member, [...keys, key]),
      ];
    });
  }

  return [];
};

// the offset of the first byte of `bytes` no UTF-8 writes (RFC 3629): a byte out of place, a
// sequence cut short, an overlong form, a surrogate's, or past U+10FFFF; -1 when every byte is UTF-8
const invalidUtf8At = (bytes: Uint8Array): number => {
  let index = 0;

  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    let length = 0;
    let low = 0x80;
    let high = 0xbf;

    if (lead < 0x80) {
      index += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      low = lead === 0xe0 ? 0xa0 : 0x80;
      high = lead === 0xed ? 0x9f : 0xbf;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      low = lead === 0xf0 ? 0x90 : 0x80;
      high = lead === 0xf4 ? 0x8f : 0xbf;
    } else {
      return index;
    }

    for (let next = 1; next < length; next += 1) {
      const byte = bytes[index + next];
      const [floor, ceiling] = next === 1 ? [low, high] : [0x80, 0xbf];

      if (byte === undefined || byte < floor || byte > ceiling) {
        return index;
      }
    }

    index += length;
  }

  return -1;
};

const compareVersions = (one: string, other: string): number => {
  const left = one.split('.').map(Number);
  const right = other.split('.').map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
};

// definition

/**
 * Checks `value`, a blueprint's parsed value, past its JSON: its format, its features, the format's
 * schema, then the rules that span entries and its `specVersion`, a stage that finds an error ending
 * the check; with `rules: false`, the check ends after the schema. Each finding at the place
 * `placeOf` gives its pointer.
 */
export const checkValue = (
  value: unknown,
  options: { readonly placeOf: PlaceOf; readonly rules?: boolean }
): IReading => {
  const { placeOf } = options;
  const format = isRecord(value) ? value['format'] : undefined;

  if (format !== undefined && format !== FORMAT) {
    return {
      diagnostics: [
        diagnosticOf('FORMAT_UNKNOWN', {
          message: `a format this beadc reads is ${FORMAT}, ${describe(format)}`,
          place: placeOf('/format'),
        }),
      ],
    };
  }

  const requires = isRecord(value) ? value['requires'] : undefined;
  const unknown = (Array.isArray(requires) ? requires : []).flatMap((feature: unknown, index) => {
    return typeof feature === 'string' && !KNOWN_FEATURES.has(feature)
      ? [
          diagnosticOf('FEATURE_UNKNOWN', {
            message: `a feature this beadc does not know: ${feature}`,
            place: placeOf(`/requires/${String(index)}`),
          }),
        ]
      : [];
  });

  if (unknown.length > 0) {
    return { diagnostics: unknown };
  }

  const validate = validatorOf();

  if (!validate(value)) {
    return { diagnostics: schemaFindingsOf(value, { errors: validate.errors ?? [], placeOf }) };
  }

  const blueprint = value as IBlueprint;

  if (options.rules === false) {
    return { diagnostics: [], blueprint };
  }

  const diagnostics = sortFindings(checkBlueprint(blueprint, { placeOf }));
  const spec = specVersion();

  if (compareVersions(blueprint.specVersion, spec) > 0) {
    diagnostics.push(
      diagnosticOf('SPEC_VERSION_NEWER', {
        message: `its specVersion ${blueprint.specVersion} is newer than the spec this beadc follows, ${spec}: its identity rules may be ones beadc does not know`,
        place: placeOf('/specVersion'),
      })
    );
  }

  return { diagnostics, ...(hasError(diagnostics) ? {} : { blueprint }) };
};

/**
 * Reads a blueprint given as `bytes`, from `file`: UTF-8, after a byte order mark if one leads; a
 * member twice, a number with a fraction or an exponent, a surrogate alone (BLUEPRINT_JSON); then
 * {@link checkValue}, its `rules` passed on. Throws an {@link InputError} for a text that is no
 * JSON.
 */
export const readBlueprint = (
  bytes: Uint8Array,
  options: { readonly file: string; readonly rules?: boolean }
): IReading => {
  const { file } = options;
  const invalid = invalidUtf8At(bytes);

  if (invalid !== -1) {
    const before = new TextDecoder('utf-8').decode(bytes.subarray(0, invalid)).split('\n');

    return {
      diagnostics: [
        diagnosticOf('BLUEPRINT_JSON', {
          message: `byte ${String(invalid)} is no UTF-8's (RFC 7493 §2.1)`,
          place: { file, line: before.length, column: (before.at(-1)?.length ?? 0) + 1 },
        }),
      ],
    };
  }

  const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const scanned = scan(decoded);
  const text = decoded.startsWith(BYTE_ORDER_MARK)
    ? decoded.slice(BYTE_ORDER_MARK.length)
    : decoded;
  const placeOf = (pointer: string): IPlace => {
    let at: string = pointer;
    let position: IPosition | undefined = scanned.positions.get(at);

    while (position === undefined && at !== '') {
      at = at.slice(0, at.lastIndexOf('/'));
      position = scanned.positions.get(at);
    }

    return { file, pointer, ...(position === undefined ? {} : position) };
  };
  const json = [
    ...scanned.duplicates.map((place) => {
      return diagnosticOf('BLUEPRINT_JSON', {
        message: 'a member its object holds already (RFC 7493 §2.3)',
        place: { file, ...place },
      });
    }),
    ...scanned.fractions.map((place) => {
      return diagnosticOf('BLUEPRINT_JSON', {
        message: 'a number with a fraction or an exponent, which a blueprint never writes',
        place: { file, ...place },
      });
    }),
  ];
  const value: unknown = JSON.parse(text);

  for (const pointer of surrogatesOf(value, [])) {
    json.push(
      diagnosticOf('BLUEPRINT_JSON', {
        message: 'a surrogate alone, which I-JSON forbids (RFC 7493 §2.1)',
        place: placeOf(pointer),
      })
    );
  }

  if (json.length > 0) {
    return { diagnostics: sortFindings(json), placeOf };
  }

  return {
    ...checkValue(value, {
      placeOf,
      ...(options.rules === undefined ? {} : { rules: options.rules }),
    }),
    placeOf,
  };
};
