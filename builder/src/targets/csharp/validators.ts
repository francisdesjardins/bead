// ── Validators ────────────────────────────────────────────────────────────────

// What the C# target prints of a file's rules (decision 0035): for each message its requests' rules
// reach, a file-local static class of rules over Google.Protobuf's message, `Check`, which judges
// each rule of the plan in 18.5's order into the runtime's sink and stops where the sink says so;
// each rule's site a static readonly field, its words and its bounds fixed, so a request that breaks
// nothing builds no violation and no path; each pattern's table a field, its classes once and its
// cells one `ushort[]` (spec 18.8.5). `file` keeps each class to its file, so two files that judge
// one message never meet. The runtime's `Validators.Of` makes the bindings' `Validate` of it.

// dependencies

import type { DescEnum, DescField, DescMessage, DescOneof } from '@bufbuild/protobuf';
import { FieldDescriptorProto_Type } from '@bufbuild/protobuf/wkt';

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
import { pascalOf } from '../names.ts';
import { literalOf } from './templates.ts';

// types

/** What a file's validators are printed with. */
export interface ICSharpValidatorOptions {
  /** The descriptor of a message, by its full name. */
  readonly messageOf: (fullName: string) => DescMessage;
  /** The C# type of a message, by its full name, qualified. */
  readonly typeOf: (fullName: string) => string;
}

// constants

const INDENT = '    ';

// the members a message's class declares or overrides, which protoc's C# generator takes a field's
// property away from with a `_` (`GetPropertyName`)
const RESERVED_MEMBERS = new Set([
  'Types',
  'Descriptor',
  'Equals',
  'ToString',
  'GetHashCode',
  'WriteTo',
  'Clone',
  'CalculateSize',
  'MergeFrom',
  'OnConstruction',
  'Parser',
]);

// each scalar's C# type, as Google.Protobuf holds it
const CSHARP_TYPES: Readonly<Record<ScalarName, string>> = Object.freeze({
  double: 'double',
  float: 'float',
  int64: 'long',
  uint64: 'ulong',
  int32: 'int',
  fixed64: 'ulong',
  fixed32: 'uint',
  bool: 'bool',
  string: 'string',
  bytes: 'global::Google.Protobuf.ByteString',
  uint32: 'uint',
  sfixed32: 'int',
  sfixed64: 'long',
  sint32: 'int',
  sint64: 'long',
});

// helpers

/** A field's property, as protoc's C# generator names it (`GetPropertyName`). */
export const propertyOf = (field: DescField): string => {
  // ! a group's field is named after its message, as protoc's C# generator names it
  const name = pascalOf(
    field.proto.type === FieldDescriptorProto_Type.GROUP
      ? (field.message?.name ?? field.name)
      : field.name
  );

  return name === field.parent.name || RESERVED_MEMBERS.has(name) ? `${name}_` : name;
};

// a oneof member's value of its case enum, as protoc's C# generator names it
const caseOf = (field: DescField): string => {
  const property = propertyOf(field);

  return property === 'None' ? 'None_' : property;
};

const oneofPropertyOf = (oneof: DescOneof): string => {
  return pascalOf(oneof.name);
};

const scalarOf = (type: FieldType): ScalarName | undefined => {
  if ('scalar' in type) {
    return type.scalar;
  }

  return 'wrapper' in type ? type.wrapper : undefined;
};

// a needle of one UTF-16 code unit as a C# char literal, every unit outside printable ASCII as its
// escape; `null` for any other needle, a surrogate pair among them, which keeps its string
const charLiteralOf = (text: string): string | null => {
  if (text.length !== 1) {
    return null;
  }

  const unit = text.charCodeAt(0);

  if (text === "'" || text === '\\') {
    return `'\\${text}'`;
  }

  return unit >= 0x20 && unit <= 0x7e
    ? `'${text}'`
    : `'\\u${unit.toString(16).toUpperCase().padStart(4, '0')}'`;
};

// `value.method(needle)`, ordinal: the char overload where the needle is one code unit, as CA1847 and
// CA1865 ask, which is ordinal already, else the string's with `StringComparison.Ordinal`
const searchOf = (value: string, options: { method: string; needle: string }): string => {
  const char = charLiteralOf(options.needle);

  return char === null
    ? `${value}.${options.method}(${literalOf(options.needle)}, global::System.StringComparison.Ordinal)`
    : `${value}.${options.method}(${char})`;
};

// a rule's number as a C# literal of its type
const numberLiteralOf = (value: INumber): string => {
  if (value.kind === 'float' || value.kind === 'double') {
    const type = value.kind;
    const named = { Infinity: 'PositiveInfinity', '-Infinity': 'NegativeInfinity', NaN: 'NaN' }[
      value.text
    ];

    return named === undefined
      ? `${value.text}${type === 'float' ? 'f' : 'd'}`
      : `${type}.${named}`;
  }

  if (value.kind === 'uint32' || value.kind === 'fixed32') {
    return `${value.text}U`;
  }

  if (value.kind === 'uint64' || value.kind === 'fixed64') {
    return `${value.text}UL`;
  }

  if (value.kind === 'int64' || value.kind === 'sint64' || value.kind === 'sfixed64') {
    return value.text === '-9223372036854775808' ? 'long.MinValue' : `${value.text}L`;
  }

  return value.text === '-2147483648' ? 'int.MinValue' : value.text;
};

// a value's zero, as `required` and IGNORE_IF_ZERO_VALUE read it
const zeroOf = (expression: string, type: FieldType): string => {
  if ('message' in type) {
    return `${expression} == null`;
  }

  if ('enum' in type) {
    return `(int)${expression} == 0`;
  }

  const scalar = scalarOf(type);

  if (scalar === 'string') {
    return `${expression}.Length == 0`;
  }

  if (scalar === 'bytes') {
    return `${expression}.IsEmpty`;
  }

  return scalar === 'bool' ? `!${expression}` : `${expression} == 0`;
};

// definition

/**
 * The validators of `plans`, the rules of each message its file's requests reach, as the lines of a
 * C# file's classes; and the class of each message's rules, by its full name.
 */
export const printCSharpValidators = (
  plans: readonly IMessagePlan[],
  options: ICSharpValidatorOptions
): { readonly lines: readonly string[]; readonly classes: ReadonlyMap<string, string> } => {
  const { messageOf, typeOf } = options;
  const classes = new Map<string, string>();
  const taken = new Set<string>();

  for (const plan of plans) {
    const message = messageOf(plan.fullName);
    const packageName = message.file.proto.package;
    const base = (
      packageName === '' ? message.typeName : message.typeName.slice(packageName.length + 1)
    ).replaceAll('.', '_');
    let name = `${base}Rules`;

    for (let suffix = 2; taken.has(name); suffix += 1) {
      name = `${base}Rules${String(suffix)}`;
    }

    taken.add(name);
    classes.set(plan.fullName, name);
  }

  const lines: string[] = [];

  for (const plan of plans) {
    const message = messageOf(plan.fullName);
    const type = typeOf(plan.fullName);
    const fields: string[] = [];
    const body: string[] = [];
    const names = new Set<string>();
    const print = (indent: number, line: string): void => {
      body.push(line === '' ? '' : `${INDENT.repeat(indent)}${line}`);
    };
    const fieldNameOf = (name: string): string => {
      let unique = name;

      for (let suffix = 2; names.has(unique); suffix += 1) {
        unique = `${name}${String(suffix)}`;
      }

      names.add(unique);

      return unique;
    };
    const constantOf = (
      name: string,
      details: { readonly type: string; readonly value: readonly string[] }
    ): string => {
      const unique = fieldNameOf(name);
      const [first = '', ...rest] = details.value;

      fields.push(
        `${INDENT}private static readonly ${details.type} ${unique} = ${first}`,
        ...rest.map((line) => {
          return `${INDENT}${line}`;
        })
      );
      fields[fields.length - 1] = `${fields[fields.length - 1] ?? ''};`;
      fields.push('');

      return unique;
    };
    const siteOf = (site: IRuleSite, name: string): string => {
      return constantOf(name, {
        type: 'global::Bead.Protobuf.ViolationRule',
        value: [
          'new()',
          '{',
          `${INDENT}RuleId = ${literalOf(site.ruleId)},`,
          `${INDENT}Message = ${literalOf(site.message)},`,
          ...(site.boundsText === undefined
            ? []
            : [
                `${INDENT}Bounds = global::Bead.Protobuf.Validators.BoundsOf(${literalOf(site.boundsText)}),`,
              ]),
          ...(site.forKey ? [`${INDENT}ForKey = true,`] : []),
          '}',
        ],
      });
    };
    const definedOf = (desc: DescEnum, name: string): string => {
      const numbers = [
        ...new Set(
          desc.values.map((value) => {
            return value.number;
          })
        ),
      ].sort((one, other) => {
        return one - other;
      });

      return constantOf(name, {
        type: 'global::System.Collections.Generic.HashSet<int>',
        value: [`[${numbers.join(', ')}]`],
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
    // the test a value breaks a rule by, as a condition
    const brokenOf = (
      judgment: IJudgment,
      details: {
        readonly value: string;
        readonly type: FieldType;
        readonly site: string;
        readonly enumOf?: DescEnum;
      }
    ): string => {
      const test = judgment.test;
      const isEnum = 'enum' in details.type;
      const value = isEnum ? `(int)${details.value}` : details.value;

      switch (test.test) {
        case 'range': {
          const parts = [
            test.lower === undefined
              ? undefined
              : `${value} ${test.lower.inclusive ? '>=' : '>'} ${numberLiteralOf(test.lower.value)}`,
            test.upper === undefined
              ? undefined
              : `${value} ${test.upper.inclusive ? '<=' : '<'} ${numberLiteralOf(test.upper.value)}`,
          ].filter((part): part is string => {
            return part !== undefined;
          });

          return `!(${parts.join(test.exclusive ? ' || ' : ' && ')})`;
        }
        case 'const': {
          return `${value} != ${numberLiteralOf(test.value)}`;
        }
        case 'in':
        case 'notIn': {
          const kind = test.values[0]?.kind ?? 'int32';
          const element = isEnum ? 'int' : CSHARP_TYPES[kind];
          // ! NaN equals nothing, so no set holds it: a HashSet's own equality takes NaN as itself
          const set = constantOf(`${details.site}Values`, {
            type: `global::System.Collections.Generic.HashSet<${element}>`,
            value: [
              `[${test.values
                .filter((each) => {
                  return each.text !== 'NaN';
                })
                .map(numberLiteralOf)
                .join(', ')}]`,
            ],
          });

          return test.test === 'in' ? `!${set}.Contains(${value})` : `${set}.Contains(${value})`;
        }
        case 'finite': {
          return `!${scalarOf(details.type) === 'float' ? 'float' : 'double'}.IsFinite(${value})`;
        }
        case 'boolConst': {
          return `${value} != ${String(test.value)}`;
        }
        case 'stringConst': {
          return `!string.Equals(${value}, ${literalOf(test.value)}, global::System.StringComparison.Ordinal)`;
        }
        case 'stringIn':
        case 'stringNotIn': {
          const set = constantOf(`${details.site}Values`, {
            type: 'global::System.Collections.Generic.HashSet<string>',
            value: [
              `new(global::System.StringComparer.Ordinal) { ${test.values.map(literalOf).join(', ')} }`,
            ],
          });

          return test.test === 'stringIn'
            ? `!${set}.Contains(${value})`
            : `${set}.Contains(${value})`;
        }
        case 'length': {
          const measured =
            test.measure === 'codePoints'
              ? `global::Bead.Protobuf.Validators.CodePointLength(${value})`
              : test.measure === 'utf8'
                ? `global::Bead.Protobuf.Validators.Utf8Length(${value})`
                : test.measure === 'bytes'
                  ? `${value}.Length`
                  : `${value}.Count`;
          const operator = test.compare === 'equal' ? '!=' : test.compare === 'atLeast' ? '<' : '>';

          return `(ulong)${measured} ${operator} ${test.value}UL`;
        }
        case 'pattern': {
          const compiled = compilePattern(test.pattern);

          if (compiled.kind !== 'table') {
            throw new Error(
              `the pattern ${JSON.stringify(test.pattern)}, which beadc check refuses first`
            );
          }

          const { table } = compiled;
          const table$ = constantOf(`${details.site}Table`, {
            type: 'global::Bead.Protobuf.PatternTable',
            value: [
              'new()',
              '{',
              `${INDENT}Accepting = [${table.accepting.join(', ')}],`,
              `${INDENT}Bounds = [${table.bounds.join(', ')}],`,
              `${INDENT}ClassCount = ${String(table.classCount)},`,
              `${INDENT}Classes = [${table.classes.join(', ')}],`,
              `${INDENT}Dead = ${String(table.dead)},`,
              `${INDENT}Matched = ${String(table.matched)},`,
              `${INDENT}StateCount = ${String(table.stateCount)},`,
              `${INDENT}Transitions = [${table.transitions.join(', ')}],`,
              '}',
            ],
          });

          return `!global::Bead.Protobuf.Pattern.Matches(${table$}, ${value})`;
        }
        case 'prefix': {
          return `!${searchOf(value, { method: 'StartsWith', needle: test.value })}`;
        }
        case 'suffix': {
          return `!${searchOf(value, { method: 'EndsWith', needle: test.value })}`;
        }
        case 'contains': {
          return `!${searchOf(value, { method: 'Contains', needle: test.value })}`;
        }
        case 'notContains': {
          return searchOf(value, { method: 'Contains', needle: test.value });
        }
        case 'bytesConst':
        case 'bytesPrefix':
        case 'bytesSuffix':
        case 'bytesContains': {
          const bytes = constantOf(`${details.site}Bytes`, {
            type: 'global::Google.Protobuf.ByteString',
            value: [
              test.value.length === 0
                ? 'global::Google.Protobuf.ByteString.Empty'
                : `global::Google.Protobuf.ByteString.CopyFrom(${[...test.value]
                    .map((byte) => {
                      return `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
                    })
                    .join(', ')})`,
            ],
          });

          switch (test.test) {
            case 'bytesConst': {
              return `${value} != ${bytes}`;
            }
            case 'bytesPrefix': {
              return `!${value}.Span.StartsWith(${bytes}.Span)`;
            }
            case 'bytesSuffix': {
              return `!${value}.Span.EndsWith(${bytes}.Span)`;
            }
            case 'bytesContains': {
              return `global::System.MemoryExtensions.IndexOf(${value}.Span, ${bytes}.Span) < 0`;
            }
          }
        }
        // falls through: every case of bytes returns above
        case 'definedOnly': {
          if (details.enumOf === undefined) {
            throw new Error(
              'defined_only on a value of no enum, which VALIDATE_RULE_FIT refuses first'
            );
          }

          return `!${definedOf(details.enumOf, `${pascalOf(details.enumOf.name)}Defined`)}.Contains(${value})`;
        }
        case 'unique': {
          return `!global::Bead.Protobuf.Validators.IsUnique(${details.value})`;
        }
      }
    };
    const judge = (
      indent: number,
      details: {
        readonly plan: IValuePlan;
        readonly value: string;
        readonly site: string;
        readonly enumOf?: DescEnum;
      }
    ): void => {
      for (const judgment of details.plan.judgments) {
        const site = `${details.site}${pascalOf(judgment.site.ruleId)}`;
        const name = siteOf(judgment.site, site);
        const broken = brokenOf(judgment, {
          value: details.value,
          type: details.plan.type,
          site,
          ...(details.enumOf === undefined ? {} : { enumOf: details.enumOf }),
        });

        print(indent, `if (${broken} && sink.Add(${name}, ${details.value}))`);
        print(indent, '{');
        print(indent + 1, 'return true;');
        print(indent, '}');
        print(0, '');
      }

      if (details.plan.message !== undefined) {
        print(
          indent,
          `if (${classes.get(details.plan.message) ?? 'Missing'}.Check(${details.value}, sink))`
        );
        print(indent, '{');
        print(indent + 1, 'return true;');
        print(indent, '}');
        print(0, '');
      }
    };
    const hasWork = (value: IValuePlan | undefined): boolean => {
      return value !== undefined && (value.judgments.length > 0 || value.message !== undefined);
    };
    // the condition a field is set by, as `required` and a message's oneof read it
    const setOf = (entry: IFieldRulesEntry, field: DescField): string => {
      const access = `message.${propertyOf(field)}`;

      if (entry.label !== undefined) {
        return `${access}.Count > 0`;
      }

      if (field.oneof !== undefined) {
        return `message.${oneofPropertyOf(field.oneof)}Case == ${type}.${oneofPropertyOf(field.oneof)}OneofCase.${caseOf(field)}`;
      }

      if ('message' in entry.type || 'wrapper' in entry.type) {
        return `${access} != null`;
      }

      if (entry.presence === 'explicit') {
        return `message.Has${propertyOf(field)}`;
      }

      return `!(${zeroOf(access, entry.type)})`;
    };

    const printField = (plan: IFieldPlan): void => {
      const { entry } = plan;
      const field = fieldOf(entry);
      const name = literalOf(entry.fieldName);
      const site = pascalOf(entry.fieldName);
      const enumOf = enumOfField(field);
      const access = `message.${propertyOf(field)}`;

      if (plan.value.ignore === 'always') {
        return;
      }

      const required =
        plan.required === undefined ? undefined : siteOf(plan.required, `${site}Required`);
      const comment = `// ${entry.fieldName}, ${String(entry.fieldNumber)}`;
      const requiredLines = (indent: number): void => {
        print(indent, `sink.Enter(${name});`);
        print(0, '');
        print(indent, `if (sink.Add(${required ?? ''}, null))`);
        print(indent, '{');
        print(indent + 1, 'return true;');
        print(indent, '}');
        print(0, '');
        print(indent, 'sink.Leave();');
      };

      if (entry.label === 'repeated' || entry.label === 'map') {
        const member = entry.label === 'map' ? plan.values : plan.items;

        if (
          plan.value.judgments.length === 0 &&
          required === undefined &&
          !hasWork(member) &&
          !hasWork(plan.keys)
        ) {
          return;
        }

        print(2, comment);

        let indent = 2;

        // ! `required` is judged before IGNORE_IF_ZERO_VALUE, which a field required never skips
        if (plan.value.ignore === 'ifZero' && required === undefined) {
          print(indent, `if (${access}.Count > 0)`);
          print(indent, '{');
          indent += 1;
        }

        if (required !== undefined) {
          print(indent, `if (${access}.Count == 0)`);
          print(indent, '{');
          requiredLines(indent + 1);
          print(indent, '}');
          print(indent, 'else');
          print(indent, '{');
          indent += 1;
        }

        if (plan.value.judgments.length > 0) {
          print(indent, `sink.Enter(${name});`);
          print(0, '');
          judge(indent, { plan: plan.value, value: access, site });
          print(indent, 'sink.Leave();');
          print(0, '');
        }

        if (entry.label === 'repeated' && plan.items !== undefined && hasWork(plan.items)) {
          print(indent, `for (var index = 0; index < ${access}.Count; index++)`);
          print(indent, '{');
          print(indent + 1, `var item = ${access}[index];`);
          print(0, '');

          if (plan.items.ignore === 'ifZero') {
            print(indent + 1, `if (${zeroOf('item', entry.type)})`);
            print(indent + 1, '{');
            print(indent + 2, 'continue;');
            print(indent + 1, '}');
            print(0, '');
          }

          print(indent + 1, `sink.EnterIndex(${name}, index);`);
          print(0, '');
          judge(indent + 1, {
            plan: plan.items,
            value: 'item',
            site: `${site}Items`,
            ...(enumOf === undefined ? {} : { enumOf }),
          });
          print(indent + 1, 'sink.Leave();');
          print(indent, '}');
          print(0, '');
        }

        if (entry.label === 'map' && (hasWork(plan.keys) || hasWork(plan.values))) {
          const key = entry.key ?? 'string';
          const typedKey = key === 'uint32' || key === 'fixed32' ? '(ulong)entry.Key' : 'entry.Key';

          print(indent, `foreach (var entry in global::Bead.Protobuf.Validators.ByKey(${access}))`);
          print(indent, '{');
          print(indent + 1, `sink.EnterKey(${name}, ${typedKey});`);
          print(0, '');

          if (plan.keys !== undefined && hasWork(plan.keys)) {
            if (plan.keys.ignore === 'ifZero') {
              print(indent + 1, `if (!(${zeroOf('entry.Key', { scalar: key })}))`);
              print(indent + 1, '{');
              judge(indent + 2, { plan: plan.keys, value: 'entry.Key', site: `${site}Keys` });
              print(indent + 1, '}');
              print(0, '');
            } else {
              judge(indent + 1, { plan: plan.keys, value: 'entry.Key', site: `${site}Keys` });
            }
          }

          if (plan.values !== undefined && hasWork(plan.values)) {
            const values = {
              plan: plan.values,
              value: 'entry.Value',
              site: `${site}Values`,
              ...(enumOf === undefined ? {} : { enumOf }),
            };

            if (plan.values.ignore === 'ifZero') {
              print(indent + 1, `if (!(${zeroOf('entry.Value', entry.type)}))`);
              print(indent + 1, '{');
              judge(indent + 2, values);
              print(indent + 1, '}');
              print(0, '');
            } else {
              judge(indent + 1, values);
            }
          }

          print(indent + 1, 'sink.Leave();');
          print(indent, '}');
          print(0, '');
        }

        for (; indent > 2; indent -= 1) {
          print(indent - 1, '}');
          print(0, '');
        }

        return;
      }

      // * a singular field: its value read once, judged where it is set
      const work = plan.value.judgments.length > 0 || plan.value.message !== undefined;

      if (!work && required === undefined) {
        return;
      }

      print(2, comment);

      const oneof = field.oneof;
      const nullable = 'message' in entry.type || 'wrapper' in entry.type;
      const judged = (indent: number, value: string): void => {
        print(indent, `sink.Enter(${name});`);
        print(0, '');
        judge(indent, {
          plan: plan.value,
          value,
          site,
          ...(enumOf === undefined ? {} : { enumOf }),
        });
        print(indent, 'sink.Leave();');
      };

      if (nullable && oneof === undefined) {
        // * a message or a wrapper: null while unset, its value once set; a block of its own, which
        // holds its pattern's variable, as an `if`'s condition gives it its enclosing block's scope
        print(2, '{');

        if (required !== undefined) {
          print(3, `if (${access} is not { } value)`);
          print(3, '{');
          requiredLines(4);
          print(3, '}');

          if (work) {
            print(3, 'else');
            print(3, '{');
            judged(4, 'value');
            print(3, '}');
          }
        } else {
          print(3, `if (${access} is { } value)`);
          print(3, '{');
          judged(4, 'value');
          print(3, '}');
        }

        print(2, '}');
        print(0, '');
        return;
      }

      const tracked = oneof !== undefined || entry.presence === 'explicit';
      const present = tracked ? setOf(entry, field) : `!(${zeroOf(access, entry.type)})`;

      if (required !== undefined) {
        print(2, `if (!(${present}))`);
        print(2, '{');
        requiredLines(3);
        print(2, '}');

        if (work) {
          print(2, 'else');
          print(2, '{');
          judged(3, access);
          print(2, '}');
        }
      } else if (tracked) {
        print(2, `if (${present})`);
        print(2, '{');
        judged(3, access);
        print(2, '}');
      } else if (plan.value.ignore === 'ifZero') {
        print(2, `if (${present})`);
        print(2, '{');
        judged(3, access);
        print(2, '}');
      } else {
        judged(2, access);
      }

      print(0, '');
    };

    for (const field of plan.fields) {
      printField(field);
    }

    // * the message's own rules, at its own path: its oneof rules, then each oneof's required
    plan.oneofRules.forEach((rule, at) => {
      const many = siteOf(rule.many, `Oneof${String(at)}`);
      const counted = rule.fields.map((entry) => {
        return `(${setOf(entry, fieldOf(entry))} ? 1 : 0)`;
      });

      print(2, `// (buf.validate.message).oneof ${String(at)}`);
      print(2, '{');
      print(3, `var set = ${counted.length === 0 ? '0' : counted.join(' + ')};`);
      print(0, '');
      print(3, `if (set > 1 && sink.Add(${many}, null))`);
      print(3, '{');
      print(4, 'return true;');
      print(3, '}');

      if (rule.none !== undefined) {
        const none = siteOf(rule.none, `Oneof${String(at)}None`);

        print(0, '');
        print(3, `if (set == 0 && sink.Add(${none}, null))`);
        print(3, '{');
        print(4, 'return true;');
        print(3, '}');
      }

      print(2, '}');
      print(0, '');
    });

    for (const oneof of plan.oneofs) {
      const desc = message.oneofs.find((each) => {
        return each.name === oneof.name;
      });

      if (desc === undefined) {
        throw new Error(`${plan.fullName} holds no oneof ${oneof.name}`);
      }

      const site = siteOf(oneof.site, `${pascalOf(oneof.name)}Required`);
      const property = oneofPropertyOf(desc);

      print(2, `// ${oneof.name}, its required`);
      print(2, `sink.Enter(${literalOf(oneof.name)});`);
      print(0, '');
      print(
        2,
        `if (message.${property}Case == ${type}.${property}OneofCase.None && sink.Add(${site}, null))`
      );
      print(2, '{');
      print(3, 'return true;');
      print(2, '}');
      print(0, '');
      print(2, 'sink.Leave();');
      print(0, '');
    }

    print(2, 'return false;');

    lines.push(
      '',
      `/// <summary>The rules of <c>${plan.fullName}</c>, in spec 18.5's order: true where the judging stops.</summary>`,
      `file static class ${classes.get(plan.fullName) ?? ''}`,
      '{',
      ...fields,
      `${INDENT}public static bool Check(${type} message, global::Bead.Protobuf.IViolationSink sink)`,
      `${INDENT}{`,
      ...body,
      `${INDENT}}`,
      '}'
    );
  }

  return { lines, classes };
};
