// ── Rules in JSON Schema's words ──────────────────────────────────────────────

// A message's rules (decision 0035) as JSON Schema 2020-12's validation vocabulary states them, for
// the OpenAPI document (decision 0037, 5f's design 3.20): a length of code points `minLength` and
// `maxLength`, of items `minItems` and `maxItems`, of pairs `minProperties` and `maxProperties`; a
// range `minimum`, `exclusiveMinimum`, `maximum` and `exclusiveMaximum`, a reversed one `anyOf` its
// halves; `const`, `in` as `enum`, `not_in` as `not: {enum}`, an enum's numbers as its names;
// `pattern` in ECMA-262's dialect where beadc can write the one that means RE2's, `prefix`,
// `suffix` and `contains` as patterns of their text; `unique` as `uniqueItems`; `example` as
// `examples`; `required` as the message's `required`, and on a field of no presence its zero
// refused. What no keyword holds — a length of UTF-8 or of bytes, a 64-bit integer's range, a
// `bytes` rule, a pattern beadc cannot write — is said in the schema's `description`: the gateway
// holds every rule, whatever the document says.

// dependencies

import type { FieldType, IEnumEntry, ScalarName } from '../model/blueprint.ts';
import type { IJudgment, IMessagePlan, IValuePlan } from '../model/rules.ts';

// types

/** A JSON Schema, as the document writes one. */
export type Schema = { [keyword: string]: unknown };

/** What a field's rules add to its schema, and what they say of it. */
export interface IFieldKeywords {
  /** What its value's schema takes beside its own form. */
  readonly value: readonly Schema[];
  /** What each item's, each key's, each value's schema takes. */
  readonly items: readonly Schema[];
  readonly keys: readonly Schema[];
  readonly values: readonly Schema[];
  /** Whether the message requires it. */
  readonly required: boolean;
  /** Rules no keyword holds, in words. */
  readonly unheld: readonly string[];
}

// constants

// the scalars whose numbers are 64 bits, a JSON string in protobuf's mapping
const WIDE = new Set<ScalarName>(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);

// what ECMA-262's patterns read as syntax, which an escape keeps literal under the `u` flag
const SYNTAX = new Set('^$\\.*+?()[]{}|/'.split(''));

// RE2's classes of ASCII, in ECMA-262's words with no flag
const CLASSES: Readonly<Record<string, string>> = Object.freeze({
  d: '[0-9]',
  D: '[^0-9]',
  w: '[0-9A-Za-z_]',
  W: '[^0-9A-Za-z_]',
  s: '[\\t\\n\\f\\r ]',
  S: '[^\\t\\n\\f\\r ]',
});
const CLASS_RANGES: Readonly<Record<string, string>> = Object.freeze({
  d: '0-9',
  w: '0-9A-Za-z_',
  s: '\\t\\n\\f\\r ',
});

// the keywords of a length, by what it measures: a length of UTF-8 or of bytes has none
const LENGTHS: Readonly<Partial<Record<string, readonly [string, string]>>> = Object.freeze({
  codePoints: ['minLength', 'maxLength'],
  items: ['minItems', 'maxItems'],
  pairs: ['minProperties', 'maxProperties'],
});

// helpers

const escapedOf = (text: string): string => {
  return Array.from(text)
    .map((character) => {
      return SYNTAX.has(character) || character === '-' ? `\\${character}` : character;
    })
    .join('');
};

class Untranslatable extends Error {}

// an escape of RE2's, `\` then `next`, in ECMA-262's words; inside a class, a class's
const escapeOf = (next: string, inClass: boolean): string => {
  const own = inClass ? CLASS_RANGES[next] : CLASSES[next];

  if (own !== undefined) {
    return own;
  }

  if ('DWS'.includes(next)) {
    throw new Untranslatable(`\\${next} in a class`);
  }

  if ('ntrfv'.includes(next)) {
    return `\\${next}`;
  }

  if (!inClass && (next === 'b' || next === 'B')) {
    return `\\${next}`;
  }

  if (SYNTAX.has(next) || next === '-') {
    return `\\${next}`;
  }

  if (/^[\x21-\x7E]$/u.test(next) && !/^[A-Za-z0-9]$/u.test(next)) {
    return next;
  }

  throw new Untranslatable(`\\${next}`);
};

/**
 * RE2's `pattern`, protovalidate's dialect, in ECMA-262's words where both mean one thing: `.` as
 * `[^\n]`, `\d`, `\w` and `\s` as their ASCII classes, `\A` and `\z` as `^` and `$`, a named group's
 * `(?P<` as `(?<`; none where it holds what beadc does not write, a flag, a Unicode class, a POSIX
 * class, `\C`, `\Q`, `\x{…}`.
 */
export const ecmaPatternOf = (pattern: string): string | undefined => {
  const characters = Array.from(pattern);
  let out = '';
  let inClass = false;

  try {
    for (let at = 0; at < characters.length; at += 1) {
      const character = characters[at] ?? '';

      if (character === '\\') {
        const next = characters[at + 1];

        if (next === undefined) {
          throw new Untranslatable('a trailing \\');
        }

        at += 1;

        if (!inClass && next === 'A') {
          out += '^';
        } else if (!inClass && next === 'z') {
          out += '$';
        } else {
          out += escapeOf(next, inClass);
        }
      } else if (inClass) {
        if (character === '[') {
          throw new Untranslatable('a class within a class');
        }

        if (character === ']') {
          inClass = false;
        }

        out += character;
      } else if (character === '[') {
        inClass = true;
        out += character;

        // a class's leading ] or ^] is a literal in RE2
        if (characters[at + 1] === '^') {
          out += '^';
          at += 1;
        }

        if (characters[at + 1] === ']') {
          out += '\\]';
          at += 1;
        }
      } else if (character === '.') {
        out += '[^\\n]';
      } else if (character === '(' && characters[at + 1] === '?') {
        const rest = characters.slice(at, at + 4).join('');

        if (rest.startsWith('(?:')) {
          out += '(?:';
          at += 2;
        } else if (rest.startsWith('(?P<')) {
          out += '(?<';
          at += 3;
        } else {
          throw new Untranslatable('a flag');
        }
      } else if (character === '{' && characters[at + 1] === ',') {
        throw new Untranslatable('a {,');
      } else {
        out += character;
      }
    }
  } catch (error) {
    if (error instanceof Untranslatable) {
      return undefined;
    }

    throw error;
  }

  if (inClass) {
    return undefined;
  }

  try {
    // ! the dialect JSON Schema's patterns are read in, its `u` flag
    void new RegExp(out, 'u');
  } catch {
    return undefined;
  }

  return out;
};

// a number of a rule as JSON writes it
const numberOf = (text: string): number => {
  return Number(text);
};

// the name an enum's number is written by, its first value's, else the number
const enumNameOf = (entry: IEnumEntry | undefined, number: number): string | number => {
  return (
    entry?.values.find((value) => {
      return value.number === number;
    })?.name ?? number
  );
};

const scalarOf = (type: FieldType): ScalarName | undefined => {
  return 'scalar' in type ? type.scalar : 'wrapper' in type ? type.wrapper : undefined;
};

// what one judgment adds, or says where no keyword holds it
const keywordsOf = (
  judgment: IJudgment,
  details: { readonly type: FieldType; readonly enumOf: (name: string) => IEnumEntry | undefined }
): { readonly schema?: Schema; readonly unheld?: string } => {
  const { test, site } = judgment;
  const scalar = scalarOf(details.type);
  const wide = scalar !== undefined && WIDE.has(scalar);
  const entry = 'enum' in details.type ? details.enumOf(details.type.enum) : undefined;
  // a value as the mapping writes it: an enum's by its name, a 64-bit integer's and a value not
  // finite as their strings
  const valueOf = (text: string): unknown => {
    if ('enum' in details.type) {
      return enumNameOf(entry, numberOf(text));
    }

    return wide || !Number.isFinite(numberOf(text)) ? text : numberOf(text);
  };

  switch (test.test) {
    case 'range': {
      // ! a bound not finite has no JSON number: the gateway holds it alone
      const bounds = [test.lower, test.upper].flatMap((bound) => {
        return bound === undefined ? [] : [numberOf(bound.value.text)];
      });

      if (
        wide ||
        !bounds.every((bound) => {
          return Number.isFinite(bound);
        })
      ) {
        return { unheld: site.message };
      }

      const lower =
        test.lower === undefined
          ? {}
          : test.lower.inclusive
            ? { minimum: numberOf(test.lower.value.text) }
            : { exclusiveMinimum: numberOf(test.lower.value.text) };
      const upper =
        test.upper === undefined
          ? {}
          : test.upper.inclusive
            ? { maximum: numberOf(test.upper.value.text) }
            : { exclusiveMaximum: numberOf(test.upper.value.text) };

      return test.exclusive
        ? { schema: { anyOf: [upper, lower] } }
        : { schema: { ...lower, ...upper } };
    }
    case 'const': {
      return { schema: { const: valueOf(test.value.text) } };
    }
    case 'in': {
      return {
        schema: {
          enum: test.values.map((value) => {
            return valueOf(value.text);
          }),
        },
      };
    }
    case 'notIn': {
      return {
        schema: {
          not: {
            enum: test.values.map((value) => {
              return valueOf(value.text);
            }),
          },
        },
      };
    }
    case 'finite': {
      return { schema: { type: 'number' } };
    }
    case 'boolConst': {
      return { schema: { const: test.value } };
    }
    case 'stringConst': {
      return { schema: { const: test.value } };
    }
    case 'stringIn': {
      return { schema: { enum: [...test.values] } };
    }
    case 'stringNotIn': {
      return { schema: { not: { enum: [...test.values] } } };
    }
    case 'length': {
      const bound = Number(test.value);
      const keywords = LENGTHS[test.measure];

      if (keywords === undefined || !Number.isSafeInteger(bound)) {
        return { unheld: site.message };
      }

      const [low, high] = keywords;

      return {
        schema:
          test.compare === 'equal'
            ? { [low]: bound, [high]: bound }
            : test.compare === 'atLeast'
              ? { [low]: bound }
              : { [high]: bound },
      };
    }
    case 'pattern': {
      const pattern = ecmaPatternOf(test.pattern);

      return pattern === undefined ? { unheld: site.message } : { schema: { pattern } };
    }
    case 'prefix': {
      return { schema: { pattern: `^${escapedOf(test.value)}` } };
    }
    case 'suffix': {
      return { schema: { pattern: `${escapedOf(test.value)}$` } };
    }
    case 'contains': {
      return { schema: { pattern: escapedOf(test.value) } };
    }
    case 'notContains': {
      return { schema: { not: { pattern: escapedOf(test.value) } } };
    }
    case 'definedOnly': {
      return {
        schema: {
          enum: [
            ...new Set(
              (entry?.values ?? []).map((value) => {
                return value.name;
              })
            ),
          ],
        },
      };
    }
    case 'unique': {
      return { schema: { uniqueItems: true } };
    }
    case 'bytesConst':
    case 'bytesPrefix':
    case 'bytesSuffix':
    case 'bytesContains': {
      return { unheld: site.message };
    }
  }
};

// a value plan's keywords, an `ignore` at its zero taking its zero beside them
const planKeywordsOf = (
  plan: IValuePlan | undefined,
  details: {
    readonly enumOf: (name: string) => IEnumEntry | undefined;
    readonly zero?: unknown;
    readonly unheld: string[];
  }
): Schema[] => {
  if (plan === undefined || plan.ignore === 'always') {
    return [];
  }

  const schemas = plan.judgments.flatMap((judgment) => {
    const found = keywordsOf(judgment, { type: plan.type, enumOf: details.enumOf });

    if (found.unheld !== undefined) {
      details.unheld.push(found.unheld);
    }

    return found.schema === undefined ? [] : [found.schema];
  });

  if (schemas.length > 0 && plan.ignore === 'ifZero' && details.zero !== undefined) {
    return [{ anyOf: [{ const: details.zero }, { allOf: schemas }] }];
  }

  return schemas;
};

/** The zero of a field's type, as protobuf's JSON mapping writes it; none for a message. */
export const zeroOf = (
  type: FieldType,
  enumOf: (name: string) => IEnumEntry | undefined
): unknown => {
  if ('enum' in type) {
    return enumNameOf(enumOf(type.enum), 0);
  }

  const scalar = scalarOf(type);

  if (scalar === undefined) {
    return undefined;
  }

  return WIDE.has(scalar)
    ? '0'
    : scalar === 'bool'
      ? false
      : scalar === 'string' || scalar === 'bytes'
        ? ''
        : 0;
};

// definition

/** What `plan`'s rules add to each of its fields' schemas, by field number. */
export const fieldKeywordsOf = (
  plan: IMessagePlan,
  enumOf: (name: string) => IEnumEntry | undefined
): ReadonlyMap<number, IFieldKeywords> => {
  return new Map(
    plan.fields.map((field) => {
      const unheld: string[] = [];
      const { entry } = field;
      const singular = entry.label === undefined;
      const zero = singular ? zeroOf(entry.type, enumOf) : undefined;
      const value = planKeywordsOf(field.value, {
        enumOf,
        ...(zero === undefined ? {} : { zero }),
        unheld,
      });
      const required = field.required !== undefined;

      // * a field of no presence that is required: its zero is refused, as never written
      if (required && singular && entry.presence === 'implicit' && zero !== undefined) {
        value.push({ not: { const: zero } });
      }

      if (required && !singular) {
        value.push(entry.label === 'map' ? { minProperties: 1 } : { minItems: 1 });
      }

      return [
        entry.fieldNumber,
        {
          value,
          items: planKeywordsOf(field.items, { enumOf, unheld }),
          keys: planKeywordsOf(field.keys, { enumOf, unheld }),
          values: planKeywordsOf(field.values, { enumOf, unheld }),
          required,
          unheld,
        },
      ] as const;
    })
  );
};
