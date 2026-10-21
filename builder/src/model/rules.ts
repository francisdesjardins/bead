// ── Rules ─────────────────────────────────────────────────────────────────────

// A message's rules, as the blueprint carries them under `validate` (decision 0035), read into one
// plan both targets print: each field by its number, its `required`, then its type's rules by the
// numbers of their members in their rules' message, a range at the member `validate.proto` attaches
// it to, then a repeated field's items or a map's entries, each key then its value, then the
// message it holds; then the message's own `oneof` rules, then each oneof's `required` (spec 18.5).
// Each rule a site: its id, its words and its bounds, fixed when beadc writes it, since they depend on
// the rule alone, never on the value judged (spec 18.3, 18.8.6); so a runtime formats nothing. And the
// blueprint's half of the fit: a field's rules of its own type (VALIDATE_RULE_FIT).

// dependencies

import type {
  FieldRulesValue,
  FieldType,
  IBlueprint,
  IFieldRulesEntry,
  IMessageRules,
  IServiceEntry,
  RuleValue,
  ScalarName,
} from './blueprint.ts';

// types

/** A JSON value a violation's bounds hold, as protobuf's JSON mapping writes each member. */
export type BoundsValue =
  | string
  | number
  | boolean
  | readonly BoundsValue[]
  | { readonly [member: string]: BoundsValue };

/** A rule's site: what every violation of it says, whatever the value. */
export interface IRuleSite {
  readonly ruleId: string;
  /** Its words, spec 18.8.6's. */
  readonly message: string;
  /** Its bounds, the members it takes; none for a rule that takes none. */
  readonly bounds?: { readonly [member: string]: BoundsValue };
  /** The bounds' text in section 17.7's form, RFC 8785's. */
  readonly boundsText?: string;
  /** Whether it is a map key's rule. */
  readonly forKey: boolean;
}

/** A number of a rule: its kind, and its value as a decimal or 17.7.4's form, or not finite. */
export interface INumber {
  readonly kind: ScalarName;
  /** A decimal integer; or a double's 17.7.4 form, `Infinity`, `-Infinity` or `NaN`. */
  readonly text: string;
}

/** What a value breaks a rule by: each test's value as its type reads it. */
export type Test =
  /** Outside its range: `lower` and `upper` its bounds; `exclusive`, the values outside them taken. */
  | {
      readonly test: 'range';
      readonly lower?: { readonly value: INumber; readonly inclusive: boolean };
      readonly upper?: { readonly value: INumber; readonly inclusive: boolean };
      readonly exclusive: boolean;
    }
  | { readonly test: 'const'; readonly value: INumber }
  | { readonly test: 'in' | 'notIn'; readonly values: readonly INumber[] }
  | { readonly test: 'finite' }
  | { readonly test: 'boolConst'; readonly value: boolean }
  | { readonly test: 'stringConst'; readonly value: string }
  | { readonly test: 'stringIn' | 'stringNotIn'; readonly values: readonly string[] }
  | {
      readonly test: 'length';
      /** Code points, a string's UTF-8 bytes, bytes, items or pairs. */
      readonly measure: 'codePoints' | 'utf8' | 'bytes' | 'items' | 'pairs';
      readonly compare: 'equal' | 'atLeast' | 'atMost';
      /** The bound, a decimal, up to 2⁶⁴ − 1. */
      readonly value: string;
    }
  | { readonly test: 'pattern'; readonly pattern: string }
  | {
      readonly test: 'prefix' | 'suffix' | 'contains' | 'notContains';
      readonly value: string;
    }
  | {
      readonly test: 'bytesConst' | 'bytesPrefix' | 'bytesSuffix' | 'bytesContains';
      readonly value: Uint8Array;
    }
  | { readonly test: 'definedOnly' }
  | { readonly test: 'unique' };

/** A rule as a value is judged by it: its site, and what breaks it. */
export interface IJudgment {
  readonly site: IRuleSite;
  readonly test: Test;
}

/** How a field, an item, a key or a value is ignored: never, at its zero, or always. */
export type Ignore = 'unspecified' | 'ifZero' | 'always';

/** What one value is judged by: its type's rules, and the message it holds, its rules' full name. */
export interface IValuePlan {
  /** Its type, as its rules read it: a field's, an item's, a key's or a map value's. */
  readonly type: FieldType;
  readonly ignore: Ignore;
  readonly judgments: readonly IJudgment[];
  /** The message it holds, where that message has rules of its own, by its full name. */
  readonly message?: string;
}

/** A field's plan, its own rules then its items' or its entries'. */
export interface IFieldPlan {
  readonly entry: IFieldRulesEntry;
  /** Its own: its `ignore`, and its value's rules, a repeated field's or a map's counts and `unique`. */
  readonly value: IValuePlan;
  readonly required?: IRuleSite;
  readonly items?: IValuePlan;
  readonly keys?: IValuePlan;
  readonly values?: IValuePlan;
}

/**
 * A message's `(buf.validate.message).oneof` rule: the fields it names, and its two sites, two of
 * them set and, for a required one, none.
 */
export interface IOneofRule {
  readonly fields: readonly IFieldRulesEntry[];
  readonly many: IRuleSite;
  readonly none?: IRuleSite;
}

/** A message's plan: its fields by number, its own oneof rules, its oneofs' `required`. */
export interface IMessagePlan {
  readonly fullName: string;
  readonly fields: readonly IFieldPlan[];
  readonly oneofRules: readonly IOneofRule[];
  readonly oneofs: readonly { readonly name: string; readonly site: IRuleSite }[];
}

/** A finding of the fit of a blueprint's rules: what it says, at its pointer. */
export interface IFitFinding {
  readonly pointer: string;
  readonly message: string;
}

// constants

// the scalars whose numbers are 64 bits, which the mapping writes as strings
const WIDE = new Set<ScalarName>(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const REAL = new Set<ScalarName>(['float', 'double']);

/** The type members a field's rules may hold, by the scalar each judges: a number's, a bool's... */
const SCALAR_MEMBERS = new Set<string>([
  'float',
  'double',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'bool',
  'string',
  'bytes',
]);
const TYPE_MEMBERS = new Set<string>([...SCALAR_MEMBERS, 'enum', 'repeated', 'map']);

// the words of a native rule, protovalidate's own (spec 18.8.6)
const REQUIRED_WORDS = 'value is required';
const ONEOF_REQUIRED_WORDS = 'exactly one field is required in oneof';
const DEFINED_ONLY_WORDS = 'value must be one of the defined enum values';
const UNIQUE_WORDS = 'repeated value must contain unique items';

// a number's members, in their numbers' order in every number's rules message: const 1, lt 2, lte
// 3, gt 4, gte 5, in 6, not_in 7, finite 8
const NUMBER_ORDER = ['const', 'less', 'greater', 'in', 'not_in', 'finite'] as const;

// the most a length is compared at in a language whose numbers are doubles: no length reaches it,
// so a bound past it is as far as one at it
export const LENGTH_CEILING = 9_007_199_254_740_992n;

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** `value`'s text in section 17.7's form, RFC 8785's: members by their names' UTF-16 code units. */
export const canonicalOf = (value: BoundsValue): string => {
  if (Array.isArray(value)) {
    return `[${value
      .map((item: BoundsValue) => {
        return canonicalOf(item);
      })
      .join(',')}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalOf(value[key] as BoundsValue)}`;
      })
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

/** The bytes `base64` writes, RFC 4648 §4, as the mapping writes bytes. */
export const bytesOf = (base64: string): Uint8Array => {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
};

const hexOf = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('hex');
};

/** A rule's scalar value as text: a number, a string, a boolean; nothing else. */
export const textOf = (value: RuleValue | undefined): string => {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
};

// a rule's number, as the blueprint writes it, its kind beside it
const numberOf = (kind: ScalarName, value: RuleValue | undefined): INumber => {
  return { kind, text: textOf(value) };
};

// a number as a violation's bounds hold it: a 64-bit integer as a string, a double as a number, a
// value not finite as the mapping's string
const boundOf = (value: INumber): BoundsValue => {
  if (WIDE.has(value.kind)) {
    return value.text;
  }

  if (REAL.has(value.kind)) {
    const read = Number(value.text);

    return Number.isFinite(read) ? read : value.text;
  }

  return Number(value.text);
};

// a number as a rule's words write it, `%s`: an integer as its decimal, a double as 17.7.4 writes
// it, a float's widened to a double (spec 18.8.6)
const wordOf = (value: INumber): string => {
  return value.text;
};

const listWordsOf = (words: readonly string[]): string => {
  return `[${words.join(', ')}]`;
};

const siteOf = (details: {
  readonly ruleId: string;
  readonly message: string;
  readonly bounds?: { readonly [member: string]: BoundsValue };
  readonly forKey: boolean;
}): IRuleSite => {
  return {
    ruleId: details.ruleId,
    message: details.message,
    ...(details.bounds === undefined
      ? {}
      : { bounds: details.bounds, boundsText: canonicalOf(details.bounds) }),
    forKey: details.forKey,
  };
};

// the type a scalar member's rules judge, by its member's name
const memberOfType = (type: FieldType): string | undefined => {
  if ('scalar' in type) {
    return type.scalar;
  }

  if ('wrapper' in type) {
    return type.wrapper;
  }

  return 'enum' in type ? 'enum' : undefined;
};

const ignoreOf = (rules: FieldRulesValue | undefined): Ignore => {
  const ignore = rules?.['ignore'];

  if (ignore === 'IGNORE_IF_ZERO_VALUE') {
    return 'ifZero';
  }

  return ignore === 'IGNORE_ALWAYS' ? 'always' : 'unspecified';
};

// a number's rules, in their members' order: const, the range at its lower bound's member or its
// upper's alone, in, not_in, finite
const numberJudgmentsOf = (
  rules: Record<string, RuleValue>,
  options: { readonly kind: ScalarName; readonly forKey: boolean }
): IJudgment[] => {
  const { kind, forKey } = options;
  const judgments: IJudgment[] = [];
  const typeName = kind;

  for (const step of NUMBER_ORDER) {
    switch (step) {
      case 'const': {
        if (rules['const'] !== undefined) {
          const value = numberOf(kind, rules['const']);

          judgments.push({
            site: siteOf({
              ruleId: `${typeName}.const`,
              message: `must equal ${wordOf(value)}`,
              bounds: { const: boundOf(value) },
              forKey,
            }),
            test: { test: 'const', value },
          });
        }

        break;
      }
      case 'less': {
        // * an upper bound alone is judged at its own member; with a lower one, at the lower's
        const lowerName =
          rules['gt'] !== undefined ? 'gt' : rules['gte'] !== undefined ? 'gte' : undefined;
        const upperName =
          rules['lt'] !== undefined ? 'lt' : rules['lte'] !== undefined ? 'lte' : undefined;

        if (upperName !== undefined && lowerName === undefined) {
          const value = numberOf(kind, rules[upperName]);

          judgments.push({
            site: siteOf({
              ruleId: `${typeName}.${upperName}`,
              message: `must be less than ${upperName === 'lte' ? 'or equal to ' : ''}${wordOf(value)}`,
              bounds: { [upperName]: boundOf(value) },
              forKey,
            }),
            test: {
              test: 'range',
              upper: { value, inclusive: upperName === 'lte' },
              exclusive: false,
            },
          });
        }

        break;
      }
      case 'greater': {
        const lowerName =
          rules['gt'] !== undefined ? 'gt' : rules['gte'] !== undefined ? 'gte' : undefined;
        const upperName =
          rules['lt'] !== undefined ? 'lt' : rules['lte'] !== undefined ? 'lte' : undefined;

        if (lowerName === undefined) {
          break;
        }

        const lower = numberOf(kind, rules[lowerName]);
        const lowerWords = `greater than ${lowerName === 'gte' ? 'or equal to ' : ''}${wordOf(lower)}`;

        if (upperName === undefined) {
          judgments.push({
            site: siteOf({
              ruleId: `${typeName}.${lowerName}`,
              message: `must be ${lowerWords}`,
              bounds: { [lowerName]: boundOf(lower) },
              forKey,
            }),
            test: {
              test: 'range',
              lower: { value: lower, inclusive: lowerName === 'gte' },
              exclusive: false,
            },
          });
          break;
        }

        const upper = numberOf(kind, rules[upperName]);
        // ! validate.proto's own reading: the range is taken outside where its upper bound is below
        // its lower one, a `lt` below or at a `gte`, a `lte` below a `gte` (spec 18.8.3)
        const exclusive = compareNumbers(upper, lower) < 0;
        const upperWords = `less than ${upperName === 'lte' ? 'or equal to ' : ''}${wordOf(upper)}`;

        judgments.push({
          site: siteOf({
            ruleId: `${typeName}.${lowerName}_${upperName}${exclusive ? '_exclusive' : ''}`,
            message: `must be ${lowerWords} ${exclusive ? 'or' : 'and'} ${upperWords}`,
            bounds: { [lowerName]: boundOf(lower), [upperName]: boundOf(upper) },
            forKey,
          }),
          test: {
            test: 'range',
            lower: { value: lower, inclusive: lowerName === 'gte' },
            upper: { value: upper, inclusive: upperName === 'lte' },
            exclusive,
          },
        });
        break;
      }
      case 'in':
      case 'not_in': {
        const listed = rules[step];

        if (Array.isArray(listed) && listed.length > 0) {
          const values = listed.map((item: RuleValue) => {
            return numberOf(kind, item);
          });

          judgments.push({
            site: siteOf({
              ruleId: `${typeName}.${step}`,
              message: `must ${step === 'in' ? '' : 'not '}be in list ${listWordsOf(values.map(wordOf))}`,
              bounds: { [step]: values.map(boundOf) },
              forKey,
            }),
            test: { test: step === 'in' ? 'in' : 'notIn', values },
          });
        }

        break;
      }
      case 'finite': {
        if (rules['finite'] === true) {
          judgments.push({
            site: siteOf({ ruleId: `${typeName}.finite`, message: 'must be finite', forKey }),
            test: { test: 'finite' },
          });
        }

        break;
      }
    }
  }

  return judgments;
};

/** Two numbers of one kind compared as their type compares them: below 0, `one` is less. */
export const compareNumbers = (one: INumber, other: INumber): number => {
  if (REAL.has(one.kind)) {
    const left = Number(one.text);
    const right = Number(other.text);

    return left < right ? -1 : left > right ? 1 : 0;
  }

  const left = BigInt(one.text);
  const right = BigInt(other.text);

  return left < right ? -1 : left > right ? 1 : 0;
};

const lengthOf = (
  details: {
    readonly ruleId: string;
    readonly member: string;
    readonly measure: 'codePoints' | 'utf8' | 'bytes' | 'items' | 'pairs';
    readonly compare: 'equal' | 'atLeast' | 'atMost';
    readonly words: (count: string) => string;
  },
  options: { readonly value: RuleValue | undefined; readonly forKey: boolean }
): IJudgment | undefined => {
  if (options.value === undefined) {
    return undefined;
  }

  const value = textOf(options.value);

  return {
    site: siteOf({
      ruleId: details.ruleId,
      message: details.words(value),
      bounds: { [details.member]: value },
      forKey: options.forKey,
    }),
    test: { test: 'length', measure: details.measure, compare: details.compare, value },
  };
};

// a string's rules, by their members' numbers: const 1, min_len 2, max_len 3, min_bytes 4,
// max_bytes 5, pattern 6, prefix 7, suffix 8, contains 9, in 10, not_in 11, len 19, len_bytes 20,
// not_contains 23
const stringJudgmentsOf = (rules: Record<string, RuleValue>, forKey: boolean): IJudgment[] => {
  const judgments: (IJudgment | undefined)[] = [];
  const text = (member: string): string | undefined => {
    const value = rules[member];

    return typeof value === 'string' ? value : undefined;
  };
  const textSite = (
    member: string,
    details: {
      readonly test: 'prefix' | 'suffix' | 'contains' | 'notContains';
      readonly words: string;
    }
  ): IJudgment | undefined => {
    const value = text(member);

    return value === undefined
      ? undefined
      : {
          site: siteOf({
            ruleId: `string.${member}`,
            message: `${details.words} \`${value}\``,
            bounds: { [member]: value },
            forKey,
          }),
          test: { test: details.test, value },
        };
  };
  const listOf = (member: 'in' | 'not_in'): IJudgment | undefined => {
    const listed = rules[member];

    if (!Array.isArray(listed) || listed.length === 0) {
      return undefined;
    }

    const values = listed.map((item: RuleValue) => {
      return textOf(item);
    });

    return {
      site: siteOf({
        ruleId: `string.${member}`,
        message: `must ${member === 'in' ? '' : 'not '}be in list ${listWordsOf(values)}`,
        bounds: { [member]: values },
        forKey,
      }),
      test: { test: member === 'in' ? 'stringIn' : 'stringNotIn', values },
    };
  };
  const constant = text('const');

  judgments.push(
    constant === undefined
      ? undefined
      : {
          site: siteOf({
            ruleId: 'string.const',
            message: `must equal \`${constant}\``,
            bounds: { const: constant },
            forKey,
          }),
          test: { test: 'stringConst', value: constant },
        },
    lengthOf(
      {
        ruleId: 'string.min_len',
        member: 'min_len',
        measure: 'codePoints',
        compare: 'atLeast',
        words: (count) => {
          return `must be at least ${count} characters`;
        },
      },
      { value: rules['min_len'], forKey }
    ),
    lengthOf(
      {
        ruleId: 'string.max_len',
        member: 'max_len',
        measure: 'codePoints',
        compare: 'atMost',
        words: (count) => {
          return `must be at most ${count} characters`;
        },
      },
      { value: rules['max_len'], forKey }
    ),
    lengthOf(
      {
        ruleId: 'string.min_bytes',
        member: 'min_bytes',
        measure: 'utf8',
        compare: 'atLeast',
        words: (count) => {
          return `must be at least ${count} bytes`;
        },
      },
      { value: rules['min_bytes'], forKey }
    ),
    lengthOf(
      {
        ruleId: 'string.max_bytes',
        member: 'max_bytes',
        measure: 'utf8',
        compare: 'atMost',
        words: (count) => {
          return `must be at most ${count} bytes`;
        },
      },
      { value: rules['max_bytes'], forKey }
    )
  );

  const pattern = text('pattern');

  judgments.push(
    pattern === undefined
      ? undefined
      : {
          site: siteOf({
            ruleId: 'string.pattern',
            message: `does not match regex pattern \`${pattern}\``,
            bounds: { pattern },
            forKey,
          }),
          test: { test: 'pattern', pattern },
        },
    textSite('prefix', { test: 'prefix', words: 'does not have prefix' }),
    textSite('suffix', { test: 'suffix', words: 'does not have suffix' }),
    textSite('contains', { test: 'contains', words: 'does not contain substring' }),
    listOf('in'),
    listOf('not_in'),
    lengthOf(
      {
        ruleId: 'string.len',
        member: 'len',
        measure: 'codePoints',
        compare: 'equal',
        words: (count) => {
          return `must be ${count} characters`;
        },
      },
      { value: rules['len'], forKey }
    ),
    lengthOf(
      {
        ruleId: 'string.len_bytes',
        member: 'len_bytes',
        measure: 'utf8',
        compare: 'equal',
        words: (count) => {
          return `must be ${count} bytes`;
        },
      },
      { value: rules['len_bytes'], forKey }
    ),
    textSite('not_contains', { test: 'notContains', words: 'contains substring' })
  );

  return judgments.filter((judgment): judgment is IJudgment => {
    return judgment !== undefined;
  });
};

// bytes' rules, by their members' numbers: const 1, min_len 2, max_len 3, prefix 5, suffix 6,
// contains 7, len 13
const bytesJudgmentsOf = (rules: Record<string, RuleValue>, forKey: boolean): IJudgment[] => {
  const bytesSite = (
    member: string,
    details: {
      readonly test: 'bytesConst' | 'bytesPrefix' | 'bytesSuffix' | 'bytesContains';
      readonly words: string;
    }
  ): IJudgment | undefined => {
    const value = rules[member];

    if (typeof value !== 'string') {
      return undefined;
    }

    const bytes = bytesOf(value);

    return {
      site: siteOf({
        ruleId: `bytes.${member}`,
        message: `${details.words} ${hexOf(bytes)}`,
        bounds: { [member]: value },
        forKey,
      }),
      test: { test: details.test, value: bytes },
    };
  };
  const judgments = [
    bytesSite('const', { test: 'bytesConst', words: 'must be' }),
    lengthOf(
      {
        ruleId: 'bytes.min_len',
        member: 'min_len',
        measure: 'bytes',
        compare: 'atLeast',
        words: (count) => {
          return `must be at least ${count} bytes`;
        },
      },
      { value: rules['min_len'], forKey }
    ),
    lengthOf(
      {
        ruleId: 'bytes.max_len',
        member: 'max_len',
        measure: 'bytes',
        compare: 'atMost',
        words: (count) => {
          return `must be at most ${count} bytes`;
        },
      },
      { value: rules['max_len'], forKey }
    ),
    bytesSite('prefix', { test: 'bytesPrefix', words: 'does not have prefix' }),
    bytesSite('suffix', { test: 'bytesSuffix', words: 'does not have suffix' }),
    bytesSite('contains', { test: 'bytesContains', words: 'does not contain' }),
    lengthOf(
      {
        ruleId: 'bytes.len',
        member: 'len',
        measure: 'bytes',
        compare: 'equal',
        words: (count) => {
          return `must be ${count} bytes`;
        },
      },
      { value: rules['len'], forKey }
    ),
  ];

  return judgments.filter((judgment): judgment is IJudgment => {
    return judgment !== undefined;
  });
};

// an enum's rules, by their members' numbers: const 1, defined_only 2, in 3, not_in 4; its numbers
// int32s
const enumJudgmentsOf = (rules: Record<string, RuleValue>, forKey: boolean): IJudgment[] => {
  const judgments: IJudgment[] = [];

  if (rules['const'] !== undefined) {
    const value = numberOf('int32', rules['const']);

    judgments.push({
      site: siteOf({
        ruleId: 'enum.const',
        message: `must equal ${value.text}`,
        bounds: { const: boundOf(value) },
        forKey,
      }),
      test: { test: 'const', value },
    });
  }

  if (rules['defined_only'] === true) {
    judgments.push({
      site: siteOf({ ruleId: 'enum.defined_only', message: DEFINED_ONLY_WORDS, forKey }),
      test: { test: 'definedOnly' },
    });
  }

  for (const member of ['in', 'not_in'] as const) {
    const listed = rules[member];

    if (Array.isArray(listed) && listed.length > 0) {
      const values = listed.map((item: RuleValue) => {
        return numberOf('int32', item);
      });

      judgments.push({
        site: siteOf({
          ruleId: `enum.${member}`,
          message: `must ${member === 'in' ? '' : 'not '}be in list ${listWordsOf(values.map(wordOf))}`,
          bounds: { [member]: values.map(boundOf) },
          forKey,
        }),
        test: { test: member === 'in' ? 'in' : 'notIn', values },
      });
    }
  }

  return judgments;
};

// the rules of one value of `type`: a scalar's, a wrapper's scalar's or an enum's
const valueJudgmentsOf = (
  type: FieldType,
  options: { readonly rules: FieldRulesValue | undefined; readonly forKey: boolean }
): IJudgment[] => {
  const { rules, forKey } = options;
  const member = memberOfType(type);
  const typed = member === undefined ? undefined : rules?.[member];

  if (member === undefined || !isRecord(typed)) {
    return [];
  }

  const held = typed as Record<string, RuleValue>;

  switch (member) {
    case 'string': {
      return stringJudgmentsOf(held, forKey);
    }
    case 'bytes': {
      return bytesJudgmentsOf(held, forKey);
    }
    case 'enum': {
      return enumJudgmentsOf(held, forKey);
    }
    case 'bool': {
      return held['const'] === undefined
        ? []
        : [
            {
              site: siteOf({
                ruleId: 'bool.const',
                message: `must equal ${textOf(held['const'])}`,
                bounds: { const: held['const'] === true },
                forKey,
              }),
              test: { test: 'boolConst', value: held['const'] === true },
            },
          ];
    }
    default: {
      return numberJudgmentsOf(held, { kind: member as ScalarName, forKey });
    }
  }
};

const valuePlanOf = (
  type: FieldType,
  details: {
    readonly rules: FieldRulesValue | undefined;
    readonly forKey: boolean;
    readonly judged: ReadonlySet<string>;
  }
): IValuePlan => {
  const held = 'message' in type && details.judged.has(type.message) ? type.message : undefined;

  return {
    type,
    ignore: ignoreOf(details.rules),
    judgments: valueJudgmentsOf(type, { rules: details.rules, forKey: details.forKey }),
    ...(held === undefined ? {} : { message: held }),
  };
};

const countSite = (
  details: {
    readonly ruleId: string;
    readonly member: string;
    readonly measure: 'items' | 'pairs';
    readonly compare: 'atLeast' | 'atMost';
    readonly words: (count: string) => string;
  },
  value: RuleValue | undefined
): IJudgment | undefined => {
  return lengthOf(details, { value, forKey: false });
};

const fieldPlanOf = (entry: IFieldRulesEntry, judged: ReadonlySet<string>): IFieldPlan => {
  const rules = entry.rules;
  const required =
    rules?.['required'] === true
      ? siteOf({ ruleId: 'required', message: REQUIRED_WORDS, forKey: false })
      : undefined;
  const ignore = ignoreOf(rules);

  if (entry.label === 'repeated') {
    const repeated = isRecord(rules?.['repeated'])
      ? (rules['repeated'] as Record<string, RuleValue>)
      : {};
    const judgments = [
      countSite(
        {
          ruleId: 'repeated.min_items',
          member: 'min_items',
          measure: 'items',
          compare: 'atLeast',
          words: (count) => {
            return `must contain at least ${count} item(s)`;
          },
        },
        repeated['min_items']
      ),
      countSite(
        {
          ruleId: 'repeated.max_items',
          member: 'max_items',
          measure: 'items',
          compare: 'atMost',
          words: (count) => {
            return `must contain no more than ${count} item(s)`;
          },
        },
        repeated['max_items']
      ),
      repeated['unique'] === true
        ? {
            site: siteOf({ ruleId: 'repeated.unique', message: UNIQUE_WORDS, forKey: false }),
            test: { test: 'unique' } as const,
          }
        : undefined,
    ].filter((judgment): judgment is IJudgment => {
      return judgment !== undefined;
    });
    const items = isRecord(repeated['items']) ? repeated['items'] : undefined;

    return {
      entry,
      value: { type: entry.type, ignore, judgments },
      ...(required === undefined ? {} : { required }),
      items: valuePlanOf(entry.type, { rules: items, forKey: false, judged }),
    };
  }

  if (entry.label === 'map') {
    const map = isRecord(rules?.['map']) ? (rules['map'] as Record<string, RuleValue>) : {};
    const judgments = [
      countSite(
        {
          ruleId: 'map.min_pairs',
          member: 'min_pairs',
          measure: 'pairs',
          compare: 'atLeast',
          words: (count) => {
            return `map must be at least ${count} entries`;
          },
        },
        map['min_pairs']
      ),
      countSite(
        {
          ruleId: 'map.max_pairs',
          member: 'max_pairs',
          measure: 'pairs',
          compare: 'atMost',
          words: (count) => {
            return `map must be at most ${count} entries`;
          },
        },
        map['max_pairs']
      ),
    ].filter((judgment): judgment is IJudgment => {
      return judgment !== undefined;
    });
    const keyType: FieldType = { scalar: entry.key ?? 'string' };

    return {
      entry,
      value: { type: entry.type, ignore, judgments },
      ...(required === undefined ? {} : { required }),
      keys: valuePlanOf(keyType, {
        rules: isRecord(map['keys']) ? map['keys'] : undefined,
        forKey: true,
        judged,
      }),
      values: valuePlanOf(entry.type, {
        rules: isRecord(map['values']) ? map['values'] : undefined,
        forKey: false,
        judged,
      }),
    };
  }

  return {
    entry,
    value: valuePlanOf(entry.type, { rules, forKey: false, judged }),
    ...(required === undefined ? {} : { required }),
  };
};

// definition

/** The full names of the messages `blueprint` carries rules for. */
export const judgedMessagesOf = (blueprint: IBlueprint): ReadonlyMap<string, IMessageRules> => {
  return new Map(
    (blueprint.proto?.messages ?? []).flatMap((message) => {
      return message.rules === undefined ? [] : [[message.fullName, message.rules] as const];
    })
  );
};

/** The plan of `fullName`'s rules: what each field, item, key and value is judged by, in order. */
export const messagePlanOf = (
  fullName: string,
  details: { readonly rules: IMessageRules; readonly judged: ReadonlySet<string> }
): IMessagePlan => {
  const { rules, judged } = details;
  const byName = new Map(
    rules.fields.map((entry) => {
      return [entry.fieldName, entry] as const;
    })
  );
  const fields = [...rules.fields]
    .sort((one, other) => {
      return one.fieldNumber - other.fieldNumber;
    })
    .map((entry) => {
      // ! a field a message's oneof names takes IGNORE_IF_ZERO_VALUE unless it states its own
      // ignore (spec 18.8.1)
      const named = (rules.message.oneof ?? []).some((rule) => {
        return rule.fields.includes(entry.fieldName);
      });
      const stated = entry.rules?.['ignore'];
      const plan = fieldPlanOf(entry, judged);

      return named && (stated === undefined || stated === 'IGNORE_UNSPECIFIED')
        ? { ...plan, value: { ...plan.value, ignore: 'ifZero' as const } }
        : plan;
    });
  const oneofRules: IOneofRule[] = (rules.message.oneof ?? []).map((rule) => {
    const names = rule.fields.join(', ');
    const required = rule.required === true;
    const bounds = { fields: [...rule.fields], ...(required ? { required: true } : {}) };

    return {
      fields: rule.fields.flatMap((name) => {
        const entry = byName.get(name);

        return entry === undefined ? [] : [entry];
      }),
      many: siteOf({
        ruleId: 'message.oneof',
        message: `only one of ${names} can be set`,
        bounds,
        forKey: false,
      }),
      ...(required
        ? {
            none: siteOf({
              ruleId: 'message.oneof',
              message: `one of ${names} must be set`,
              bounds,
              forKey: false,
            }),
          }
        : {}),
    };
  });

  return {
    fullName,
    fields,
    oneofRules,
    oneofs: [...rules.oneofs]
      .sort((one, other) => {
        return one.oneofIndex - other.oneofIndex;
      })
      .filter((oneof) => {
        return oneof.rules.required === true;
      })
      .map((oneof) => {
        return {
          name: oneof.oneofName,
          site: siteOf({ ruleId: 'required', message: ONEOF_REQUIRED_WORDS, forKey: false }),
        };
      }),
  };
};

/**
 * The fit of `blueprint`'s rules, VALIDATE_RULE_FIT's: a field's rules hold the one type member its
 * type takes, a wrapper's its scalar's, a repeated field's `repeated`, a map's `map`, and an item's,
 * a key's and a value's alike; a message's oneof names fields its rules list.
 */
export const fitFindingsOf = (blueprint: IBlueprint): IFitFinding[] => {
  const findings: IFitFinding[] = [];
  const fitOf = (
    type: FieldType,
    details: { readonly rules: FieldRulesValue; readonly at: string; readonly what: string }
  ): void => {
    const expected = memberOfType(type);
    const members = Object.keys(details.rules).filter((member) => {
      return TYPE_MEMBERS.has(member);
    });

    for (const member of members) {
      if (member !== expected) {
        findings.push({
          pointer: `${details.at}/${member}`,
          message: `${details.what} takes ${
            expected === undefined ? 'no type rules' : `${expected}'s rules`
          }, not ${member}'s`,
        });
      }
    }
  };

  (blueprint.proto?.messages ?? []).forEach((message, index) => {
    const rules = message.rules;

    if (rules === undefined) {
      return;
    }

    const place = `/proto/messages/${String(index)}/rules`;
    const names = new Set(
      rules.fields.map((entry) => {
        return entry.fieldName;
      })
    );

    rules.fields.forEach((entry, at) => {
      const fieldRules = entry.rules;
      const rulesAt = `${place}/fields/${String(at)}/rules`;
      const what = `${message.fullName}.${entry.fieldName}`;

      if (fieldRules === undefined) {
        return;
      }

      if (entry.label === undefined) {
        fitOf(entry.type, { rules: fieldRules, at: rulesAt, what });
        return;
      }

      const expected = entry.label;

      for (const member of Object.keys(fieldRules)) {
        if (TYPE_MEMBERS.has(member) && member !== expected) {
          findings.push({
            pointer: `${rulesAt}/${member}`,
            message: `${what}, a ${expected === 'map' ? 'map' : 'repeated field'}, takes ${expected}'s rules, not ${member}'s`,
          });
        }
      }

      const held = fieldRules[expected];

      if (!isRecord(held)) {
        return;
      }

      if (expected === 'repeated' && isRecord(held['items'])) {
        fitOf(entry.type, {
          rules: held['items'],
          at: `${rulesAt}/repeated/items`,
          what: `${what}'s items`,
        });
      }

      if (expected === 'map') {
        if (isRecord(held['keys'])) {
          fitOf(
            { scalar: entry.key ?? 'string' },
            {
              rules: held['keys'],
              at: `${rulesAt}/map/keys`,
              what: `${what}'s keys`,
            }
          );
        }

        if (isRecord(held['values'])) {
          fitOf(entry.type, {
            rules: held['values'],
            at: `${rulesAt}/map/values`,
            what: `${what}'s values`,
          });
        }
      }
    });

    (rules.message.oneof ?? []).forEach((rule, at) => {
      rule.fields.forEach((name, item) => {
        if (!names.has(name)) {
          findings.push({
            pointer: `${place}/message/oneof/${String(at)}/fields/${String(item)}`,
            message: `${message.fullName}'s oneof rule names ${name}, a field its rules do not list`,
          });
        }
      });
    });
  });

  return findings;
};

/**
 * The plans of the messages `services`' requests' rules reach, from `rules`: each request's first,
 * then each message their rules lead to, in the order they are reached.
 */
export const plansOf = (
  services: readonly IServiceEntry[],
  rules: ReadonlyMap<string, IMessageRules>
): IMessagePlan[] => {
  const judged = new Set(rules.keys());
  const plans = new Map<string, IMessagePlan>();
  const visit = (fullName: string): void => {
    const held = rules.get(fullName);

    if (held === undefined || plans.has(fullName)) {
      return;
    }

    const plan = messagePlanOf(fullName, { rules: held, judged });

    plans.set(fullName, plan);

    for (const field of plan.fields) {
      for (const value of [field.value, field.items, field.values]) {
        if (value?.message !== undefined) {
          visit(value.message);
        }
      }
    }
  };

  for (const service of services) {
    for (const procedure of service.procedures) {
      if (procedure.request.message !== undefined) {
        visit(procedure.request.message);
      }
    }
  }

  return [...plans.values()];
};
