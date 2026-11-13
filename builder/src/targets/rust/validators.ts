// ── Validators ────────────────────────────────────────────────────────────────

// What the Rust target prints of a package's rules (decisions 0035 and 0051): for each message its
// requests' rules reach, `rules_of_<message>`, `bead_protobuf`'s `MessageRules`, which judges each
// rule of the plan in spec 18.5's order into the runtime's sink and stops where the sink says so;
// each field's, and each of the message's own rules, in a function of its own, which the message's
// calls in that order, so that no function grows with the message. Each rule's site is a constant
// `ViolationRule`, its words and its bounds fixed, so a request that breaks nothing builds no
// violation and no path; each pattern's table a constant `PatternTable` (spec 18.8.5). Each reads
// Buffa's representation: an implicit field as its type, an explicit one as an `Option`, a message
// or a wrapper as a `MessageField`, a oneof as its enum under `__buffa::oneof`, a list as a `Vec`
// and a map by its keys' order (`entries_by_key`); an integer by its comparisons, a float widened
// to `f64` and compared by `partial_cmp`, so that a NaN breaks every bound; every length counted as
// a `u64`, every index and step checked. Every function and constant is private to its package's
// module, a name numbered `_2` on a collision, as the other targets number theirs.

// dependencies

import type { DescEnum, DescField, DescMessage } from '@bufbuild/protobuf';
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt';

import type { FieldType, IFieldRulesEntry, ScalarName } from '../../model/blueprint.ts';
import type {
  IFieldPlan,
  IJudgment,
  IMessagePlan,
  INumber,
  IRuleSite,
  IValuePlan,
} from '../../model/rules.ts';
import { compilePattern } from '../../patterns/pattern.ts';
import { identifierOf, toSnakeCase } from './names.ts';
import { INDENT, literalOf } from './templates.ts';

// types

/** What a package's validators are printed with. */
export interface IRustValidatorOptions {
  /** The descriptor of a message, by its full name. */
  readonly messageOf: (fullName: string) => DescMessage;
  /** A message's path from the package's module, by its full name. */
  readonly typeOf: (fullName: string) => string;
  /** The path of a oneof's enum from the package's module, by its message's full name and its name. */
  readonly oneofOf: (fullName: string, oneof: string) => string;
}

/** A package's validators: each message's rules function, by its full name, and their lines. */
export interface IRustValidators {
  readonly functions: ReadonlyMap<string, string>;
  readonly lines: readonly string[];
}

// what a value judged is: a field's own, a list or a map whole, an item, a key or a map's value
type Shape = 'value' | 'list' | 'map';

// constants

const SINK = '&mut dyn ::bead_protobuf::ViolationSink';
const RULE_VALUE = '::bead_protobuf::RuleValue';
const MAP_KEY = '::bead_protobuf::MapKey';

// each integer scalar's Rust type, and how it widens: signed to i64, unsigned to u64
const INTEGERS: Readonly<
  Partial<Record<ScalarName, { type: string; wide: 'Signed' | 'Unsigned' }>>
> = Object.freeze({
  int32: { type: 'i32', wide: 'Signed' },
  sint32: { type: 'i32', wide: 'Signed' },
  sfixed32: { type: 'i32', wide: 'Signed' },
  int64: { type: 'i64', wide: 'Signed' },
  sint64: { type: 'i64', wide: 'Signed' },
  sfixed64: { type: 'i64', wide: 'Signed' },
  uint32: { type: 'u32', wide: 'Unsigned' },
  fixed32: { type: 'u32', wide: 'Unsigned' },
  uint64: { type: 'u64', wide: 'Unsigned' },
  fixed64: { type: 'u64', wide: 'Unsigned' },
});

// the largest u64, the bound a length never passes
const U64_MAX = 18_446_744_073_709_551_615n;

// helpers

const scalarOf = (type: FieldType): ScalarName | undefined => {
  if ('scalar' in type) {
    return type.scalar;
  }

  return 'wrapper' in type ? type.wrapper : undefined;
};

// `digits` grouped by three with `_`, from the right or from the left, where they are five or more,
// as clippy's `unreadable_literal` asks
const groupedOf = (digits: string, from: 'right' | 'left'): string => {
  if (digits.length < 5) {
    return digits;
  }

  const groups: string[] = [];

  if (from === 'right') {
    for (let end = digits.length; end > 0; end -= 3) {
      groups.unshift(digits.slice(Math.max(0, end - 3), end));
    }
  } else {
    for (let start = 0; start < digits.length; start += 3) {
      groups.push(digits.slice(start, start + 3));
    }
  }

  return groups.join('_');
};

// an integer's decimal as a Rust literal, its digits grouped
const integerLiteralOf = (text: string): string => {
  const negative = text.startsWith('-');

  return `${negative ? '-' : ''}${groupedOf(negative ? text.slice(1) : text, 'right')}`;
};

// a number of a rule as a Rust literal: an integer of its scalar's type, a float as an f64, which a
// field's value is widened to
const numberLiteralOf = (value: INumber): string => {
  if (value.kind === 'float' || value.kind === 'double') {
    const named = { Infinity: 'f64::INFINITY', '-Infinity': 'f64::NEG_INFINITY', NaN: 'f64::NAN' }[
      value.text
    ];

    if (named !== undefined) {
      return named;
    }

    const [, sign = '', whole = '', fraction, exponent = ''] =
      /^(-?)(\d+)(?:\.(\d+))?((?:[eE][+-]?\d+)?)$/u.exec(value.text) ?? [];

    return `${sign}${groupedOf(whole, 'right')}.${groupedOf(fraction ?? '0', 'left')}${exponent}`;
  }

  // ! the minimum's decimal would be a negated literal one past its type's maximum
  if (value.text === '-2147483648' || value.text === '-9223372036854775808') {
    return `${INTEGERS[value.kind]?.type ?? 'i64'}::MIN`;
  }

  return integerLiteralOf(value.text);
};

// a needle of one code point as a Rust char literal, every point outside printable ASCII as its
// escape, as clippy's `single_char_pattern` asks; `null` for any other needle, which keeps its string
const charLiteralOf = (text: string): string | null => {
  if (Array.from(text).length !== 1) {
    return null;
  }

  if (text === "'" || text === '\\') {
    return `'\\${text}'`;
  }

  const point = text.codePointAt(0) ?? 0;

  return point >= 0x20 && point <= 0x7e
    ? `'${text}'`
    : `'\\u{${point.toString(16).toUpperCase()}}'`;
};

// a text's UTF-8 as a Rust byte string literal: printable ASCII as it is, every other byte escaped
const byteLiteralOf = (text: string): string => {
  const bytes = [...new TextEncoder().encode(text)].map((byte) => {
    if (byte === 0x5c || byte === 0x22) {
      return `\\${String.fromCodePoint(byte)}`;
    }

    return byte >= 0x20 && byte <= 0x7e
      ? String.fromCodePoint(byte)
      : `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  });

  return `b"${bytes.join('')}"`;
};

// a name of Bead's as an upper snake case constant's part
const upperOf = (name: string): string => {
  return toSnakeCase(name.replaceAll(/[^A-Za-z0-9]+/gu, '_'))
    .replaceAll(/_+/gu, '_')
    .replaceAll(/^_|_$/gu, '')
    .toUpperCase();
};

// definition

/**
 * The validators of `plans`, the rules of each message its package's requests reach, as the lines
 * of Rust of its module; and each message's rules function, by its full name.
 */
export const printRustValidators = (
  plans: readonly IMessagePlan[],
  options: IRustValidatorOptions
): IRustValidators => {
  const { messageOf, typeOf, oneofOf } = options;
  const functions = new Map<string, string>();
  const takenFunctions = new Set<string>();
  const takenConstants = new Set<string>();
  const uniqueOf = (name: string, taken: Set<string>): string => {
    let unique = name;

    for (let suffix = 2; taken.has(unique); suffix += 1) {
      unique = `${name}_${String(suffix)}`;
    }

    taken.add(unique);

    return unique;
  };
  // a message's name in its package, its enclosing messages' before it
  const localOf = (message: DescMessage): string => {
    const packageName = message.file.proto.package;

    return packageName === '' ? message.typeName : message.typeName.slice(packageName.length + 1);
  };

  for (const plan of plans) {
    functions.set(
      plan.fullName,
      uniqueOf(
        `rules_of_${toSnakeCase(localOf(messageOf(plan.fullName)).replaceAll('.', '_'))}`,
        takenFunctions
      )
    );
  }

  const lines: string[] = [];

  if (plans.length > 0) {
    lines.push(
      '',
      "// * each request's rules, judged before its resolver, every rule a site of its own (spec 18,",
      '// decision 0035)'
    );
  }

  for (const plan of plans) {
    const message = messageOf(plan.fullName);
    const type = typeOf(plan.fullName);
    const rules = functions.get(plan.fullName) ?? '';
    const prefix = upperOf(localOf(message).replaceAll('.', '_'));
    const constants: string[] = [];
    const parts: { readonly name: string; readonly lines: readonly string[] }[] = [];
    const constantOf = (
      name: string,
      details: { readonly type: string; readonly value: readonly string[] }
    ): string => {
      const unique = uniqueOf(name, takenConstants);
      const [first = '', ...rest] = details.value;

      constants.push('', `const ${unique}: ${details.type} = ${first}`, ...rest);
      constants[constants.length - 1] = `${constants.at(-1) ?? ''};`;

      return unique;
    };
    const siteOf = (site: IRuleSite, name: string): string => {
      return constantOf(name, {
        type: '::bead_protobuf::ViolationRule',
        value: [
          '::bead_protobuf::ViolationRule {',
          `${INDENT}rule_id: ${literalOf(site.ruleId)},`,
          `${INDENT}message: ${literalOf(site.message)},`,
          `${INDENT}bounds: ${site.boundsText === undefined ? 'None' : `Some(${literalOf(site.boundsText)})`},`,
          `${INDENT}for_key: ${String(site.forKey)},`,
          '}',
        ],
      });
    };
    const fieldOf = (entry: IFieldRulesEntry): DescField => {
      const field = message.fields.find((each) => {
        return each.number === entry.fieldNumber;
      });

      if (field === undefined) {
        throw new Error(`${plan.fullName} holds no field ${String(entry.fieldNumber)}`);
      }

      return field;
    };
    const enumOfField = (field: DescField): DescEnum | undefined => {
      return field.fieldKind === 'enum' ||
        (field.fieldKind === 'list' && field.listKind === 'enum') ||
        (field.fieldKind === 'map' && field.mapKind === 'enum')
        ? field.enum
        : undefined;
    };
    // an enum's number of a value at `value`, a reference: Buffa's EnumValue's own, or a closed
    // enum's, held bare, through its trait
    const numberOf = (value: string, closed: boolean): string => {
      return closed ? `::buffa::Enumeration::to_i32(${value})` : `${value}.to_i32()`;
    };
    // what a rule reads of a value at `value`, a reference, by its type
    const ruleValueOf = (
      value: string,
      details: { readonly type: FieldType; readonly shape: Shape; readonly closed: boolean }
    ): string => {
      if (details.shape !== 'value') {
        return 'message' in details.type
          ? `${RULE_VALUE}::Absent`
          : `${RULE_VALUE}::Items(${value})`;
      }

      if ('message' in details.type) {
        return `${RULE_VALUE}::Absent`;
      }

      if ('enum' in details.type) {
        return `${RULE_VALUE}::Signed(i64::from(${numberOf(value, details.closed)}))`;
      }

      const scalar = scalarOf(details.type) ?? 'string';
      const integer = INTEGERS[scalar];

      if (integer !== undefined) {
        return integer.type === 'i64' || integer.type === 'u64'
          ? `${RULE_VALUE}::${integer.wide}(*${value})`
          : `${RULE_VALUE}::${integer.wide}(${integer.wide === 'Signed' ? 'i64' : 'u64'}::from(*${value}))`;
      }

      if (scalar === 'bool') {
        return `${RULE_VALUE}::Bool(*${value})`;
      }

      if (scalar === 'float') {
        return `${RULE_VALUE}::Float(f64::from(*${value}))`;
      }

      if (scalar === 'double') {
        return `${RULE_VALUE}::Float(*${value})`;
      }

      return scalar === 'bytes'
        ? `${RULE_VALUE}::Bytes(${value})`
        : `${RULE_VALUE}::Text(${value})`;
    };
    // a map's key at `key`, a reference, as a path's subscript renders it
    const mapKeyOf = (key: string, scalar: ScalarName): string => {
      if (scalar === 'string') {
        return `${MAP_KEY}::Text(${key})`;
      }

      if (scalar === 'bool') {
        return `${MAP_KEY}::Bool(*${key})`;
      }

      const integer = INTEGERS[scalar];

      return integer?.type === 'i64' || integer?.type === 'u64'
        ? `${MAP_KEY}::${integer.wide}(*${key})`
        : `${MAP_KEY}::${integer?.wide ?? 'Signed'}(${integer?.wide === 'Unsigned' ? 'u64' : 'i64'}::from(*${key}))`;
    };
    // whether a value at `value`, a reference, is its type's zero
    const zeroOf = (
      value: string,
      details: { readonly type: FieldType; readonly closed: boolean }
    ): string => {
      if ('enum' in details.type) {
        return `${numberOf(value, details.closed)} == 0`;
      }

      const scalar = scalarOf(details.type);

      if (scalar === 'string' || scalar === 'bytes') {
        return `${value}.is_empty()`;
      }

      if (scalar === 'bool') {
        return `!*${value}`;
      }

      return scalar === 'float' || scalar === 'double' ? `*${value} == 0.0` : `*${value} == 0`;
    };
    // a number of a value at `value`, a reference, as its bounds compare it: a float widened to f64
    const comparedOf = (
      value: string,
      details: { readonly type: FieldType; readonly closed: boolean }
    ): string => {
      if ('enum' in details.type) {
        return numberOf(value, details.closed);
      }

      return scalarOf(details.type) === 'float' ? `f64::from(*${value})` : value;
    };
    // the test a value breaks a rule by, as a condition; none where no value breaks it
    const brokenOf = (
      judgment: IJudgment,
      details: {
        readonly value: string;
        readonly type: FieldType;
        readonly shape: Shape;
        readonly site: string;
        readonly closed: boolean;
        readonly enumOf?: DescEnum;
      }
    ): string | undefined => {
      const test = judgment.test;
      const { value } = details;
      const compared = comparedOf(value, details);
      const ordered = (
        bound: INumber,
        is: 'is_ge' | 'is_gt' | 'is_le' | 'is_lt' | 'is_eq'
      ): string => {
        return `${compared}.partial_cmp(&${numberLiteralOf(bound)}).is_some_and(::core::cmp::Ordering::${is})`;
      };

      switch (test.test) {
        case 'range': {
          const parts = [
            test.lower === undefined
              ? undefined
              : ordered(test.lower.value, test.lower.inclusive ? 'is_ge' : 'is_gt'),
            test.upper === undefined
              ? undefined
              : ordered(test.upper.value, test.upper.inclusive ? 'is_le' : 'is_lt'),
          ].filter((part): part is string => {
            return part !== undefined;
          });

          return parts.length === 1
            ? `!${String(parts[0])}`
            : `!(${parts.join(test.exclusive ? ' || ' : ' && ')})`;
        }
        case 'const': {
          return `!${ordered(test.value, 'is_eq')}`;
        }
        case 'in':
        case 'notIn': {
          const kind = test.values[0]?.kind ?? 'int32';
          const element =
            'enum' in details.type
              ? 'i32'
              : kind === 'float' || kind === 'double'
                ? 'f64'
                : (INTEGERS[kind]?.type ?? 'i64');
          // ! NaN equals nothing, so no list holds it
          const list = constantOf(`${details.site}_VALUES`, {
            type: `&[${element}]`,
            value: [
              `&[${test.values
                .filter((each) => {
                  return each.text !== 'NaN';
                })
                .map(numberLiteralOf)
                .join(', ')}]`,
            ],
          });
          const held =
            'enum' in details.type || scalarOf(details.type) === 'float'
              ? `${list}.contains(&${compared})`
              : `${list}.contains(${value})`;

          return test.test === 'in' ? `!${held}` : held;
        }
        case 'finite': {
          return `!${value}.is_finite()`;
        }
        case 'boolConst': {
          return test.value ? `!*${value}` : `*${value}`;
        }
        case 'stringConst': {
          return `${value} != ${literalOf(test.value)}`;
        }
        case 'stringIn':
        case 'stringNotIn': {
          const list = constantOf(`${details.site}_VALUES`, {
            type: '&[&str]',
            value: [`&[${test.values.map(literalOf).join(', ')}]`],
          });
          const held = `${list}.contains(&${value}.as_str())`;

          return test.test === 'stringIn' ? `!${held}` : held;
        }
        case 'length': {
          const bound = BigInt(test.value);

          // * a bound no length breaks: none below 0, none past the largest u64
          if (
            (test.compare === 'atLeast' && bound === 0n) ||
            (test.compare === 'atMost' && bound >= U64_MAX)
          ) {
            return undefined;
          }

          const measured =
            test.measure === 'codePoints'
              ? `::bead_protobuf::code_point_length(${value})`
              : test.measure === 'utf8'
                ? `::bead_protobuf::utf8_length(${value})`
                : `u64::try_from(${value}.len()).unwrap_or(u64::MAX)`;
          const operator = test.compare === 'equal' ? '!=' : test.compare === 'atLeast' ? '<' : '>';

          return `${measured} ${operator} ${integerLiteralOf(test.value)}`;
        }
        case 'pattern': {
          const compiled = compilePattern(test.pattern);

          if (compiled.kind !== 'table') {
            throw new Error(
              `the pattern ${JSON.stringify(test.pattern)}, which beadc check refuses first`
            );
          }

          const { table } = compiled;
          const numbers = (each: readonly number[]): string => {
            return `&[${each
              .map((number) => {
                return integerLiteralOf(String(number));
              })
              .join(', ')}]`;
          };
          const optional = (number: number): string => {
            // ! the compiler marks a state it has none of by -1
            return number < 0 ? 'None' : `Some(${integerLiteralOf(String(number))})`;
          };
          const named = constantOf(`${details.site}_TABLE`, {
            type: '::bead_protobuf::PatternTable',
            value: [
              '::bead_protobuf::PatternTable {',
              `${INDENT}accepting: ${numbers(table.accepting)},`,
              `${INDENT}bounds: ${numbers(table.bounds)},`,
              `${INDENT}class_count: ${integerLiteralOf(String(table.classCount))},`,
              `${INDENT}classes: ${numbers(table.classes)},`,
              `${INDENT}dead: ${optional(table.dead)},`,
              `${INDENT}matched: ${optional(table.matched)},`,
              `${INDENT}state_count: ${integerLiteralOf(String(table.stateCount))},`,
              `${INDENT}transitions: ${numbers(table.transitions)},`,
              '}',
            ],
          });

          return `!::bead_protobuf::matches_pattern(&${named}, ${value})`;
        }
        case 'prefix':
        case 'suffix':
        case 'contains':
        case 'notContains': {
          const method = {
            prefix: 'starts_with',
            suffix: 'ends_with',
            contains: 'contains',
            notContains: 'contains',
          }[test.test];
          const char = charLiteralOf(test.value);
          // ! a suffix of several characters by its UTF-8, which ends the text's alike: clippy reads
          // `ends_with(".v1")` as a file's extension, compared with its case
          const searched =
            char === null && test.test === 'suffix'
              ? `${value}.as_bytes().ends_with(${byteLiteralOf(test.value)})`
              : `${value}.${method}(${char ?? literalOf(test.value)})`;

          return test.test === 'notContains' ? searched : `!${searched}`;
        }
        case 'bytesConst':
        case 'bytesPrefix':
        case 'bytesSuffix':
        case 'bytesContains': {
          const bytes = constantOf(`${details.site}_BYTES`, {
            type: '&[u8]',
            value: [
              `&[${[...test.value]
                .map((byte) => {
                  return `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
                })
                .join(', ')}]`,
            ],
          });
          const helper = {
            bytesConst: 'bytes_equal',
            bytesPrefix: 'bytes_start_with',
            bytesSuffix: 'bytes_end_with',
            bytesContains: 'bytes_contain',
          }[test.test];

          return `!::bead_protobuf::${helper}(${value}, ${bytes})`;
        }
        case 'definedOnly': {
          if (details.enumOf === undefined) {
            throw new Error(
              'defined_only on a value of no enum, which VALIDATE_RULE_FIT refuses first'
            );
          }

          const numbers = [
            ...new Set(
              details.enumOf.values.map((each) => {
                return each.number;
              })
            ),
          ].sort((one, other) => {
            return one - other;
          });
          const defined = constantOf(`${upperOf(details.enumOf.name)}_DEFINED`, {
            type: '&[i32]',
            value: [
              `&[${numbers
                .map((number) => {
                  return integerLiteralOf(String(number));
                })
                .join(', ')}]`,
            ],
          });

          return `!${defined}.contains(&${compared})`;
        }
        case 'unique': {
          return `!::bead_protobuf::is_unique(${value})`;
        }
      }
    };
    // the judgments of a value at `value`, a reference, then its message's rules, at `indent`
    const judge = (
      body: string[],
      details: {
        readonly indent: string;
        readonly plan: IValuePlan;
        readonly value: string;
        readonly site: string;
        readonly shape: Shape;
        readonly closed: boolean;
        readonly enumOf?: DescEnum;
      }
    ): void => {
      const { indent } = details;

      for (const judgment of details.plan.judgments) {
        const site = `${details.site}_${upperOf(judgment.site.ruleId)}`;
        const broken = brokenOf(judgment, {
          value: details.value,
          type: details.plan.type,
          shape: details.shape,
          site,
          closed: details.closed,
          ...(details.enumOf === undefined ? {} : { enumOf: details.enumOf }),
        });

        if (broken === undefined) {
          continue;
        }

        const named = siteOf(judgment.site, site);

        body.push(
          `${indent}if ${broken}`,
          `${indent}${INDENT}&& sink.add(&${named}, ${ruleValueOf(details.value, { type: details.plan.type, shape: details.shape, closed: details.closed })})`,
          `${indent}{`,
          `${indent}${INDENT}return true;`,
          `${indent}}`,
          ''
        );
      }

      if (details.plan.message !== undefined && details.shape === 'value') {
        body.push(
          `${indent}if ${functions.get(details.plan.message) ?? 'missing'}(${details.value}, sink) {`,
          `${indent}${INDENT}return true;`,
          `${indent}}`,
          ''
        );
      }
    };
    const hasWork = (value: IValuePlan | undefined): boolean => {
      return value !== undefined && (value.judgments.length > 0 || value.message !== undefined);
    };
    // a required rule's violation at the field `name`, then the field's function ends
    const requiredOf = (
      indent: string,
      details: { readonly name: string; readonly site: string }
    ): string[] => {
      return [
        `${indent}sink.enter(${details.name});`,
        '',
        `${indent}if sink.add(&${details.site}, ${RULE_VALUE}::Absent) {`,
        `${indent}${INDENT}return true;`,
        `${indent}}`,
        '',
        `${indent}sink.leave();`,
        '',
        `${indent}return false;`,
      ];
    };
    // where Buffa holds a field: its oneof's variant, an Option, a MessageField, or the field bare
    const holdingOf = (
      entry: IFieldRulesEntry,
      field: DescField
    ): 'oneof' | 'option' | 'message' | 'bare' => {
      if (field.oneof !== undefined) {
        return 'oneof';
      }

      if (entry.label !== undefined) {
        return 'bare';
      }

      if ('message' in entry.type || 'wrapper' in entry.type) {
        return 'message';
      }

      // ! a field protobuf requires is held bare: a message that leaves it unset is never read
      if (field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED) {
        return 'bare';
      }

      return entry.presence === 'explicit' ? 'option' : 'bare';
    };
    // the variant of a oneof's member, as Buffa names its enum and its variant
    const variantOf = (field: DescField): string => {
      return `${oneofOf(plan.fullName, field.oneof?.name ?? '')}::${identifierOf(pascalOf(field.name))}`;
    };
    // the condition a field is set by, as a message's oneof rules read it: a place's, no reference
    // taken
    const setOf = (entry: IFieldRulesEntry, field: DescField): string => {
      const access = `message.${identifierOf(field.name)}`;

      switch (holdingOf(entry, field)) {
        case 'oneof': {
          return `matches!(message.${identifierOf(field.oneof?.name ?? '')}, Some(${variantOf(field)}(_)))`;
        }
        case 'option': {
          return `${access}.is_some()`;
        }
        case 'message': {
          return `${access}.is_set()`;
        }
        case 'bare': {
          if (entry.label !== undefined) {
            return `!${access}.is_empty()`;
          }

          if (field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED) {
            return 'true';
          }

          if ('enum' in entry.type) {
            return `${numberOf(`&${access}`, !(field.enum?.open ?? true))} != 0`;
          }

          const scalar = scalarOf(entry.type);

          if (scalar === 'string' || scalar === 'bytes') {
            return `!${access}.is_empty()`;
          }

          if (scalar === 'bool') {
            return access;
          }

          return scalar === 'float' || scalar === 'double' ? `${access} != 0.0` : `${access} != 0`;
        }
      }
    };

    const printField = (fieldPlan: IFieldPlan): void => {
      const { entry } = fieldPlan;
      const field = fieldOf(entry);
      const name = literalOf(entry.fieldName);
      const site = `${prefix}_${upperOf(entry.fieldName)}`;
      const enumOf = enumOfField(field);
      const access = `message.${identifierOf(field.name)}`;
      const body: string[] = [];

      if (fieldPlan.value.ignore === 'always') {
        return;
      }

      const holding = holdingOf(entry, field);
      // * a field protobuf requires is set on every message Buffa holds: its `required` never breaks
      const required =
        fieldPlan.required === undefined ||
        field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED
          ? undefined
          : siteOf(fieldPlan.required, `${site}_REQUIRED`);
      // a singular closed enum is held bare, a repeated or a mapped one opened, as Buffa's EnumValue
      const closedValue = enumOf !== undefined && !enumOf.open && entry.label === undefined;

      if (entry.label === 'repeated' || entry.label === 'map') {
        const member = entry.label === 'map' ? fieldPlan.values : fieldPlan.items;

        if (
          fieldPlan.value.judgments.length === 0 &&
          required === undefined &&
          !hasWork(member) &&
          !hasWork(fieldPlan.keys)
        ) {
          return;
        }

        body.push(`${INDENT}let value = &${access};`, '');

        // ! `required` is judged before IGNORE_IF_ZERO_VALUE, which a field required never skips
        if (required !== undefined) {
          body.push(
            `${INDENT}if value.is_empty() {`,
            ...requiredOf(`${INDENT}${INDENT}`, { name, site: required }),
            `${INDENT}}`,
            ''
          );
        } else if (fieldPlan.value.ignore === 'ifZero') {
          body.push(
            `${INDENT}if value.is_empty() {`,
            `${INDENT}${INDENT}return false;`,
            `${INDENT}}`,
            ''
          );
        }

        if (fieldPlan.value.judgments.length > 0) {
          body.push(`${INDENT}sink.enter(${name});`, '');
          judge(body, {
            indent: INDENT,
            plan: fieldPlan.value,
            value: 'value',
            site,
            shape: entry.label === 'map' ? 'map' : 'list',
            closed: false,
          });
          body.push(`${INDENT}sink.leave();`, '');
        }

        if (
          entry.label === 'repeated' &&
          fieldPlan.items !== undefined &&
          hasWork(fieldPlan.items)
        ) {
          body.push(`${INDENT}for (index, item) in value.iter().enumerate() {`);

          if (fieldPlan.items.ignore === 'ifZero') {
            body.push(
              `${INDENT}${INDENT}if ${zeroOf('item', { type: entry.type, closed: false })} {`,
              `${INDENT}${INDENT}${INDENT}continue;`,
              `${INDENT}${INDENT}}`,
              ''
            );
          }

          body.push(`${INDENT}${INDENT}sink.enter_index(${name}, index);`, '');
          judge(body, {
            indent: `${INDENT}${INDENT}`,
            plan: fieldPlan.items,
            value: 'item',
            site: `${site}_ITEMS`,
            shape: 'value',
            closed: false,
            ...(enumOf === undefined ? {} : { enumOf }),
          });
          body.push(`${INDENT}${INDENT}sink.leave();`, `${INDENT}}`, '');
        }

        if (entry.label === 'map' && (hasWork(fieldPlan.keys) || hasWork(fieldPlan.values))) {
          const key = entry.key ?? 'string';

          body.push(
            `${INDENT}for entry in ::bead_protobuf::entries_by_key(value) {`,
            `${INDENT}${INDENT}sink.enter_key(${name}, ${mapKeyOf('entry.key', key)});`,
            ''
          );

          const guarded = (
            plan: IValuePlan,
            details: {
              readonly value: string;
              readonly type: FieldType;
              readonly site: string;
              readonly enumOf?: DescEnum;
            }
          ): void => {
            const values = {
              plan,
              value: details.value,
              site: details.site,
              shape: 'value' as const,
              closed: false,
              ...(details.enumOf === undefined ? {} : { enumOf: details.enumOf }),
            };

            if (plan.ignore === 'ifZero') {
              body.push(
                `${INDENT}${INDENT}if !(${zeroOf(details.value, { type: details.type, closed: false })}) {`
              );
              judge(body, { ...values, indent: `${INDENT}${INDENT}${INDENT}` });
              body.push(`${INDENT}${INDENT}}`, '');
            } else {
              judge(body, { ...values, indent: `${INDENT}${INDENT}` });
            }
          };

          if (fieldPlan.keys !== undefined && hasWork(fieldPlan.keys)) {
            guarded(fieldPlan.keys, {
              value: 'entry.key',
              type: { scalar: key },
              site: `${site}_KEYS`,
            });
          }

          if (fieldPlan.values !== undefined && hasWork(fieldPlan.values)) {
            guarded(fieldPlan.values, {
              value: 'entry.value',
              type: entry.type,
              site: `${site}_VALUES`,
              ...(enumOf === undefined ? {} : { enumOf }),
            });
          }

          body.push(`${INDENT}${INDENT}sink.leave();`, `${INDENT}}`, '');
        }
      } else {
        // * a singular field: its value read once, judged where it is set
        const work = fieldPlan.value.judgments.length > 0 || fieldPlan.value.message !== undefined;

        if (!work && required === undefined) {
          return;
        }

        const wrapped = 'wrapper' in entry.type ? '.map(|wrapper| &wrapper.value)' : '';
        const held = {
          oneof: `&message.${identifierOf(field.oneof?.name ?? '')}`,
          option: `&${access}`,
          message: `${access}.as_option()${wrapped}`,
          bare: `&${access}`,
        }[holding];

        if (holding === 'bare') {
          body.push(`${INDENT}let value = ${held};`, '');

          if (required !== undefined) {
            body.push(
              `${INDENT}if ${zeroOf('value', { type: entry.type, closed: closedValue })} {`,
              ...requiredOf(`${INDENT}${INDENT}`, { name, site: required }),
              `${INDENT}}`,
              ''
            );
          } else if (
            fieldPlan.value.ignore === 'ifZero' &&
            field.presence !== FeatureSet_FieldPresence.LEGACY_REQUIRED
          ) {
            body.push(
              `${INDENT}if ${zeroOf('value', { type: entry.type, closed: closedValue })} {`,
              `${INDENT}${INDENT}return false;`,
              `${INDENT}}`,
              ''
            );
          }
        } else if (!work) {
          // * required alone: its presence, no value read
          const unset = {
            oneof: `!${setOf(entry, field)}`,
            option: `${access}.is_none()`,
            message: `${access}.is_unset()`,
          }[holding];

          body.push(
            `${INDENT}if ${unset} {`,
            ...requiredOf(`${INDENT}${INDENT}`, { name, site: required ?? '' }),
            `${INDENT}}`,
            ''
          );
        } else {
          const pattern = holding === 'oneof' ? `Some(${variantOf(field)}(value))` : 'Some(value)';

          body.push(
            `${INDENT}let ${pattern} = ${held} else {`,
            ...(required === undefined
              ? [`${INDENT}${INDENT}return false;`]
              : requiredOf(`${INDENT}${INDENT}`, { name, site: required })),
            `${INDENT}};`,
            ''
          );

          // a wrapper a oneof holds, boxed: its value
          if (holding === 'oneof' && 'wrapper' in entry.type) {
            body.push(`${INDENT}let value = &value.value;`, '');
          }
        }

        if (!work) {
          pushPart(entry, body);

          return;
        }

        body.push(`${INDENT}sink.enter(${name});`, '');
        judge(body, {
          indent: INDENT,
          plan: fieldPlan.value,
          value: 'value',
          site,
          shape: 'value',
          closed: closedValue,
          ...(enumOf === undefined ? {} : { enumOf }),
        });
        body.push(`${INDENT}sink.leave();`, '');
      }

      pushPart(entry, body);
    };
    // a field's function, its body ended by `false`: the judging goes on
    const pushPart = (entry: IFieldRulesEntry, body: readonly string[]): void => {
      const name = uniqueOf(`${rules}_${toSnakeCase(entry.fieldName)}`, takenFunctions);

      parts.push({
        name,
        lines: [
          '',
          `// ${entry.fieldName}, ${String(entry.fieldNumber)}`,
          `fn ${name}(message: &${type}, sink: ${SINK}) -> bool {`,
          ...body,
          ...(body.at(-1) === '' ? [] : ['']),
          `${INDENT}false`,
          '}',
        ],
      });
    };

    for (const fieldPlan of plan.fields) {
      printField(fieldPlan);
    }

    // * the message's own rules, at its own path: its oneof rules, then each oneof's required
    plan.oneofRules.forEach((rule, at) => {
      const many = siteOf(rule.many, `${prefix}_ONEOF_${String(at)}`);
      const counted = rule.fields.map((entry) => {
        return setOf(entry, fieldOf(entry));
      });
      const name = uniqueOf(`${rules}_oneof_${String(at)}`, takenFunctions);
      const body = [
        `${INDENT}let set = [${counted.join(', ')}].into_iter().filter(|set| *set).count();`,
        '',
        `${INDENT}if set > 1 && sink.add(&${many}, ${RULE_VALUE}::Absent) {`,
        `${INDENT}${INDENT}return true;`,
        `${INDENT}}`,
        '',
      ];

      if (rule.none !== undefined) {
        const none = siteOf(rule.none, `${prefix}_ONEOF_${String(at)}_NONE`);

        body.push(
          `${INDENT}if set == 0 && sink.add(&${none}, ${RULE_VALUE}::Absent) {`,
          `${INDENT}${INDENT}return true;`,
          `${INDENT}}`,
          ''
        );
      }

      parts.push({
        name,
        lines: [
          '',
          `// (buf.validate.message).oneof ${String(at)}`,
          `fn ${name}(message: &${type}, sink: ${SINK}) -> bool {`,
          ...body,
          `${INDENT}false`,
          '}',
        ],
      });
    });

    for (const oneof of plan.oneofs) {
      const site = siteOf(oneof.site, `${prefix}_${upperOf(oneof.name)}_REQUIRED`);
      const name = uniqueOf(`${rules}_${toSnakeCase(oneof.name)}`, takenFunctions);

      parts.push({
        name,
        lines: [
          '',
          `// ${oneof.name}, its required`,
          `fn ${name}(message: &${type}, sink: ${SINK}) -> bool {`,
          `${INDENT}if message.${identifierOf(oneof.name)}.is_some() {`,
          `${INDENT}${INDENT}return false;`,
          `${INDENT}}`,
          '',
          `${INDENT}sink.enter(${literalOf(oneof.name)});`,
          '',
          `${INDENT}if sink.add(&${site}, ${RULE_VALUE}::Absent) {`,
          `${INDENT}${INDENT}return true;`,
          `${INDENT}}`,
          '',
          `${INDENT}sink.leave();`,
          '',
          `${INDENT}false`,
          '}',
        ],
      });
    }

    const [first, ...rest] = parts;

    lines.push(
      ...constants,
      '',
      `// the rules of \`${plan.fullName}\`, in spec 18.5's order: \`true\` where the judging stops`,
      first === undefined
        ? `fn ${rules}(_message: &${type}, _sink: ${SINK}) -> bool {`
        : `fn ${rules}(message: &${type}, sink: ${SINK}) -> bool {`,
      ...(first === undefined
        ? [`${INDENT}false`]
        : [
            `${INDENT}${first.name}(message, sink)`,
            ...rest.map((part) => {
              return `${INDENT}${INDENT}|| ${part.name}(message, sink)`;
            }),
          ]),
      '}',
      ...parts.flatMap((part) => {
        return part.lines;
      })
    );
  }

  return { functions, lines };
};

// a field's or a oneof's name in Pascal case, as Buffa's `to_pascal_case` writes a variant
const pascalOf = (name: string): string => {
  return name
    .split('_')
    .map((part) => {
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join('');
};
