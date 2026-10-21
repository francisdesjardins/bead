// ── Validators ────────────────────────────────────────────────────────────────

// What the TypeScript target prints of a file's rules (decision 0035): for each message its requests'
// rules reach, a function of rules over protobuf-es's message, which judges each rule of the plan in
// 18.5's order into the runtime's sink, and stops where the sink says so; each rule's site a frozen
// constant of the file, its words and its bounds fixed, so a request that breaks nothing builds no
// violation and no path; each pattern's table a constant, its classes once and its cells one
// `Uint16Array` (spec 18.8.5). The runtime's `validatorOf` makes the descriptor's `validate` of it.

// dependencies

import type { DescEnum, DescField, DescMessage } from '@bufbuild/protobuf';
import type { GeneratedFile, Printable } from '@bufbuild/protoplugin';

import type { FieldType, IFieldRulesEntry, ScalarName } from '../../model/blueprint.ts';
import {
  type BoundsValue,
  type IFieldPlan,
  type IJudgment,
  type IMessagePlan,
  type INumber,
  type IRuleSite,
  type IValuePlan,
  LENGTH_CEILING,
} from '../../model/rules.ts';
import { compilePattern, type IPatternTable } from '../../patterns/pattern.ts';

// types

/** What a file's validators are printed with. */
export interface IValidatorOptions {
  /** The module the file imports the runtime's validators from, as `f.import` takes it. */
  readonly protoRuntime: string;
  /** The descriptor of a message, by its full name. */
  readonly messageOf: (fullName: string) => DescMessage;
}

// a value judged, as the printed code reads it: its expression, and how its type reads it
interface IValueOf {
  readonly expression: string;
  readonly type: FieldType;
  /** For a 64-bit integer protobuf-es writes as a string, `jstype = JS_STRING`. */
  readonly asString?: boolean;
}

// constants

const WIDE = new Set<ScalarName>(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const REAL = new Set<ScalarName>(['float', 'double']);

// the kind a map's key is ordered by (spec 18.5)
const KEY_ORDER: Readonly<Record<string, 'string' | 'integer' | 'bool'>> = Object.freeze({
  string: 'string',
  bool: 'bool',
});

// helpers

// a string as a single-quoted literal, whatever it holds
const literalOf = (text: string): string => {
  const escaped = JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");

  return `'${escaped}'`;
};

// a JSON value of a rule's bounds as a frozen literal
const frozenOf = (value: BoundsValue): string => {
  if (Array.isArray(value)) {
    return `Object.freeze([${value
      .map((item: BoundsValue) => {
        return frozenOf(item);
      })
      .join(', ')}])`;
  }

  if (typeof value === 'object') {
    return `Object.freeze({ ${Object.keys(value)
      .sort()
      .map((key) => {
        return `${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : literalOf(key)}: ${frozenOf((value as Record<string, BoundsValue>)[key] as BoundsValue)}`;
      })
      .join(', ')} })`;
  }

  return typeof value === 'string' ? literalOf(value) : String(value);
};

// a rule's number as a TypeScript literal of its type: a `bigint` for a 64-bit integer
const numberLiteralOf = (value: INumber): string => {
  if (WIDE.has(value.kind)) {
    return `${value.text}n`;
  }

  if (REAL.has(value.kind) && value.text === 'NaN') {
    return 'Number.NaN';
  }

  return value.text;
};

const scalarOf = (type: FieldType): ScalarName | undefined => {
  if ('scalar' in type) {
    return type.scalar;
  }

  return 'wrapper' in type ? type.wrapper : undefined;
};

// a part of a name, its characters but letters and digits taken as `_`
const partOf = (text: string): string => {
  return text.replace(/[^A-Za-z0-9]/gu, '_');
};

// a value's zero, as `required` and IGNORE_IF_ZERO_VALUE read it
const zeroOf = (value: IValueOf): string => {
  const scalar = scalarOf(value.type);

  if ('message' in value.type) {
    return `${value.expression} === undefined`;
  }

  if ('enum' in value.type) {
    return `${value.expression} === 0`;
  }

  if (scalar === 'string') {
    return `${value.expression} === ''`;
  }

  if (scalar === 'bytes') {
    return `${value.expression}.length === 0`;
  }

  if (scalar === 'bool') {
    return `!${value.expression}`;
  }

  if (scalar !== undefined && WIDE.has(scalar)) {
    return value.asString === true ? `${value.expression} === '0'` : `${value.expression} === 0n`;
  }

  return `${value.expression} === 0`;
};

// definition

/**
 * Prints the validators of `plans` into `f`, the rules of each message its file's requests reach;
 * returns the name of each message's function, by its full name.
 */
export const printValidators = (
  f: GeneratedFile,
  details: IValidatorOptions & { readonly plans: readonly IMessagePlan[] }
): ReadonlyMap<string, string> => {
  const { plans, protoRuntime, messageOf } = details;
  const fromProto = (symbol: string, typeOnly = false): Printable => {
    return f.import(symbol, protoRuntime, typeOnly);
  };
  const isFieldSet = f.import('isFieldSet', '@bufbuild/protobuf');
  // each message's base name, protoc-gen-es's, `Outer_Inner`; one taken twice, by two packages,
  // numbered
  const baseOf = new Map<string, string>();
  const taken = new Set<string>();

  for (const plan of plans) {
    const message = messageOf(plan.fullName);
    const local = message.typeName.slice(
      message.file.proto.package === '' ? 0 : message.file.proto.package.length + 1
    );
    let base = partOf(local);

    for (let suffix = 2; taken.has(base); suffix += 1) {
      base = `${partOf(local)}$${String(suffix)}`;
    }

    taken.add(base);
    baseOf.set(plan.fullName, base);
  }

  const functionOf = (fullName: string): string => {
    return `rulesOf${baseOf.get(fullName) ?? partOf(fullName)}`;
  };
  const constants: Printable[][] = [];
  const names = new Set<string>();
  // a constant of the file, its name unique, its value printed once
  const constantOf = (name: string, value: Printable): string => {
    let unique = name;

    for (let suffix = 2; names.has(unique); suffix += 1) {
      unique = `${name}$${String(suffix)}`;
    }

    names.add(unique);
    constants.push(['const ', unique, ' = ', value, ';']);

    return unique;
  };
  const siteConstantOf = (site: IRuleSite, name: string): string => {
    const members = [
      ...(site.bounds === undefined ? [] : [`bounds: ${frozenOf(site.bounds)}`]),
      ...(site.forKey ? ['forKey: true'] : []),
      `message: ${literalOf(site.message)}`,
      `ruleId: ${literalOf(site.ruleId)}`,
    ];

    return constantOf(name, [
      'Object.freeze<',
      fromProto('IViolationRule', true),
      `>({ ${members.join(', ')} })`,
    ]);
  };
  const tableConstantOf = (pattern: string, name: string): string => {
    const compiled = compilePattern(pattern);

    if (compiled.kind !== 'table') {
      throw new Error(`the pattern ${JSON.stringify(pattern)}, which beadc check refuses first`);
    }

    const table: IPatternTable = compiled.table;

    return constantOf(name, [
      'Object.freeze<',
      fromProto('IPatternTable', true),
      `>({ accepting: Object.freeze([${table.accepting.join(', ')}]), bounds: Object.freeze([${table.bounds.join(', ')}]), classCount: ${String(table.classCount)}, classes: Object.freeze([${table.classes.join(', ')}]), dead: ${String(table.dead)}, matched: ${String(table.matched)}, stateCount: ${String(table.stateCount)}, transitions: new Uint16Array([${table.transitions.join(', ')}]) })`,
    ]);
  };
  const enumSets = new Map<string, string>();
  const definedOf = (desc: DescEnum): string => {
    const known = enumSets.get(desc.typeName);

    if (known !== undefined) {
      return known;
    }

    const name = constantOf(
      `${partOf(desc.typeName.split('.').at(-1) ?? desc.name)}$defined`,
      `Object.freeze(new Set([${[
        ...new Set(
          desc.values.map((value) => {
            return value.number;
          })
        ),
      ]
        .sort((one, other) => {
          return one - other;
        })
        .join(', ')}]))`
    );

    enumSets.set(desc.typeName, name);

    return name;
  };

  // the test a value breaks a rule by, as a condition, `value` already of its type
  const brokenOf = (
    judgment: IJudgment,
    details: { readonly value: string; readonly site: string; readonly enumOf?: DescEnum }
  ): Printable => {
    const { value } = details;
    const test = judgment.test;

    switch (test.test) {
      case 'range': {
        const lower =
          test.lower === undefined
            ? undefined
            : `${value} ${test.lower.inclusive ? '>=' : '>'} ${numberLiteralOf(test.lower.value)}`;
        const upper =
          test.upper === undefined
            ? undefined
            : `${value} ${test.upper.inclusive ? '<=' : '<'} ${numberLiteralOf(test.upper.value)}`;
        const parts = [lower, upper].filter((part): part is string => {
          return part !== undefined;
        });

        return `!(${parts.join(test.exclusive ? ' || ' : ' && ')})`;
      }
      case 'const': {
        return `${value} !== ${numberLiteralOf(test.value)}`;
      }
      case 'in':
      case 'notIn': {
        // ! NaN equals nothing, so no set holds it: a Set's own equality takes NaN as itself
        const set = constantOf(
          `${details.site}$values`,
          `Object.freeze(new Set([${test.values
            .filter((each) => {
              return each.text !== 'NaN';
            })
            .map(numberLiteralOf)
            .join(', ')}]))`
        );

        return test.test === 'in' ? `!${set}.has(${value})` : `${set}.has(${value})`;
      }
      case 'finite': {
        return `!Number.isFinite(${value})`;
      }
      case 'boolConst': {
        return `${value} !== ${String(test.value)}`;
      }
      case 'stringConst': {
        return `${value} !== ${literalOf(test.value)}`;
      }
      case 'stringIn':
      case 'stringNotIn': {
        const set = constantOf(
          `${details.site}$values`,
          `Object.freeze(new Set([${test.values.map(literalOf).join(', ')}]))`
        );

        return test.test === 'stringIn' ? `!${set}.has(${value})` : `${set}.has(${value})`;
      }
      case 'length': {
        const measured: Printable =
          test.measure === 'codePoints'
            ? [fromProto('codePointLength'), `(${value})`]
            : test.measure === 'utf8'
              ? [fromProto('utf8Length'), `(${value})`]
              : test.measure === 'pairs'
                ? `Object.keys(${value}).length`
                : `${value}.length`;
        // * a length is a double here: a bound past 2⁵³ is as far as one at it, which no length
        // reaches
        const bound = BigInt(test.value) > LENGTH_CEILING ? LENGTH_CEILING : BigInt(test.value);
        const operator = test.compare === 'equal' ? '!==' : test.compare === 'atLeast' ? '<' : '>';

        return [measured, ` ${operator} ${String(bound)}`];
      }
      case 'pattern': {
        return [
          '!',
          fromProto('matchesPattern'),
          `(${tableConstantOf(test.pattern, `${details.site}$table`)}, ${value})`,
        ];
      }
      case 'prefix': {
        return `!${value}.startsWith(${literalOf(test.value)})`;
      }
      case 'suffix': {
        return `!${value}.endsWith(${literalOf(test.value)})`;
      }
      case 'contains': {
        return `!${value}.includes(${literalOf(test.value)})`;
      }
      case 'notContains': {
        return `${value}.includes(${literalOf(test.value)})`;
      }
      case 'bytesConst':
      case 'bytesPrefix':
      case 'bytesSuffix':
      case 'bytesContains': {
        const bytes = constantOf(
          `${details.site}$bytes`,
          `new Uint8Array([${[...test.value].join(', ')}])`
        );
        const helper = {
          bytesConst: 'bytesEqual',
          bytesPrefix: 'bytesStartWith',
          bytesSuffix: 'bytesEndWith',
          bytesContains: 'bytesContain',
        }[test.test];

        return ['!', fromProto(helper), `(${value}, ${bytes})`];
      }
      case 'definedOnly': {
        if (details.enumOf === undefined) {
          throw new Error(
            'defined_only on a value of no enum, which VALIDATE_RULE_FIT refuses first'
          );
        }

        return `!${definedOf(details.enumOf)}.has(${value})`;
      }
      case 'unique': {
        return ['!', fromProto('isUnique'), `(${value})`];
      }
    }
  };

  const bodies: Printable[][] = [];

  for (const plan of plans) {
    const message = messageOf(plan.fullName);
    const base = baseOf.get(plan.fullName) ?? partOf(plan.fullName);
    const lines: Printable[] = [];
    const print = (indent: string, parts: Printable): void => {
      lines.push([indent, parts, '\n']);
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
    const asStringOf = (field: DescField): boolean => {
      return 'longAsString' in field && field.longAsString;
    };
    // a value's judgments, each a condition and its site, `value` read as its type reads it
    const judge = (
      indent: string,
      details: {
        readonly plan: IValuePlan;
        readonly value: string;
        readonly site: string;
        readonly enumOf?: DescEnum;
        readonly asString?: boolean;
      }
    ): void => {
      const scalar = scalarOf(details.plan.type);
      const typed =
        details.asString === true && WIDE.has(scalar ?? 'int32')
          ? `BigInt(${details.value})`
          : details.value;

      for (const judgment of details.plan.judgments) {
        const name = siteConstantOf(
          judgment.site,
          `${details.site}$${partOf(judgment.site.ruleId)}`
        );

        print(indent, [
          'if (',
          brokenOf(judgment, {
            value: typed,
            site: `${details.site}$${partOf(judgment.site.ruleId)}`,
            ...(details.enumOf === undefined ? {} : { enumOf: details.enumOf }),
          }),
          ` && sink.add(${name}, ${details.value})) {`,
        ]);
        print(indent, '  return true;');
        print(indent, '}');
      }

      if (details.plan.message !== undefined) {
        print(indent, `if (${functionOf(details.plan.message)}(${details.value}, sink)) {`);
        print(indent, '  return true;');
        print(indent, '}');
      }
    };
    const hasWork = (value: IValuePlan | undefined): boolean => {
      return value !== undefined && (value.judgments.length > 0 || value.message !== undefined);
    };

    // the condition a field is set by, as `required` and a message's oneof read it
    const setOf = (entry: IFieldRulesEntry, field: DescField): string => {
      const access = `message.${field.localName}`;

      if (entry.label === 'repeated') {
        return `${access}.length > 0`;
      }

      if (entry.label === 'map') {
        return `Object.keys(${access}).length > 0`;
      }

      if (field.oneof !== undefined) {
        return `message.${field.oneof.localName}.case === ${literalOf(field.localName)}`;
      }

      if ('message' in entry.type || 'wrapper' in entry.type) {
        return `${access} !== undefined`;
      }

      // * a proto3 `optional` field is an optional property, its absence `undefined`
      if (entry.presence === 'explicit' && field.proto.proto3Optional) {
        return `${access} !== undefined`;
      }

      if (entry.presence === 'explicit') {
        return '';
      }

      return `!(${zeroOf({ expression: access, type: entry.type, asString: asStringOf(field) })})`;
    };
    const explicitSetOf = (field: DescField): Printable => {
      return [isFieldSet, '(message, ', f.importSchema(message), `.field.${field.localName})`];
    };
    const setPrintable = (entry: IFieldRulesEntry, field: DescField): Printable => {
      const condition = setOf(entry, field);

      return condition === '' ? explicitSetOf(field) : condition;
    };

    const printField = (plan: IFieldPlan): void => {
      const { entry } = plan;
      const field = fieldOf(entry);
      const name = literalOf(entry.fieldName);
      const site = `${base}$${partOf(entry.fieldName)}`;
      const enumOf = enumOfField(field);
      const asString = asStringOf(field);

      if (plan.value.ignore === 'always') {
        return;
      }

      const required =
        plan.required === undefined ? undefined : siteConstantOf(plan.required, `${site}$required`);

      const comment = `// ${entry.fieldName}, ${String(entry.fieldNumber)}`;

      if (entry.label === 'repeated' || entry.label === 'map') {
        const access = `message.${field.localName}`;
        const empty =
          entry.label === 'map' ? `Object.keys(${access}).length === 0` : `${access}.length === 0`;
        const member = entry.label === 'map' ? plan.values : plan.items;
        const work =
          plan.value.judgments.length > 0 ||
          required !== undefined ||
          hasWork(member) ||
          hasWork(plan.keys);

        if (!work) {
          return;
        }

        print('  ', comment);
        // ! `required` is judged before IGNORE_IF_ZERO_VALUE, which a field required never skips
        print(
          '  ',
          plan.value.ignore === 'ifZero' && required === undefined ? `if (!(${empty})) {` : '{'
        );

        if (required !== undefined) {
          print('    ', `if (${empty}) {`);
          print('      ', `sink.enter(${name});`);
          print('      ', `if (sink.add(${required}, undefined)) {`);
          print('      ', '  return true;');
          print('      ', '}');
          print('      ', 'sink.leave();');
          print('    ', '} else {');
        } else {
          print('    ', '{');
        }

        const inner = '      ';

        if (plan.value.judgments.length > 0) {
          print(inner, `sink.enter(${name});`);
          judge(inner, { plan: plan.value, value: access, site });
          print(inner, 'sink.leave();');
        }

        if (entry.label === 'repeated' && plan.items !== undefined && hasWork(plan.items)) {
          print(inner, `for (const [index, item] of ${access}.entries()) {`);

          if (plan.items.ignore === 'ifZero') {
            print(inner, `  if (${zeroOf({ expression: 'item', type: entry.type, asString })}) {`);
            print(inner, '    continue;');
            print(inner, '  }');
          }

          print(inner, `  sink.enterIndex(${name}, index);`);
          judge(`${inner}  `, {
            plan: plan.items,
            value: 'item',
            site: `${site}$items`,
            ...(enumOf === undefined ? {} : { enumOf }),
            asString,
          });
          print(inner, '  sink.leave();');
          print(inner, '}');
        }

        if (entry.label === 'map' && (hasWork(plan.keys) || hasWork(plan.values))) {
          const key = entry.key ?? 'string';
          const order = KEY_ORDER[key] ?? 'integer';
          const typedKey =
            key === 'string'
              ? 'key'
              : key === 'bool'
                ? "key === 'true'"
                : WIDE.has(key)
                  ? 'BigInt(key)'
                  : 'Number(key)';

          print(inner, [
            'for (const [key, entry] of ',
            fromProto('entriesByKey'),
            `(${access}, ${literalOf(order)})) {`,
          ]);
          print(inner, `  const typedKey = ${typedKey};`);
          print(inner, '');
          print(inner, `  sink.enterKey(${name}, typedKey);`);

          if (plan.keys !== undefined && hasWork(plan.keys)) {
            const keyValue: IValueOf = { expression: 'typedKey', type: { scalar: key } };

            if (plan.keys.ignore === 'ifZero') {
              print(inner, `  if (!(${zeroOf(keyValue)})) {`);
              judge(`${inner}    `, { plan: plan.keys, value: 'typedKey', site: `${site}$keys` });
              print(inner, '  }');
            } else {
              judge(`${inner}  `, { plan: plan.keys, value: 'typedKey', site: `${site}$keys` });
            }
          }

          if (plan.values !== undefined && hasWork(plan.values)) {
            const entryValue: IValueOf = { expression: 'entry', type: entry.type, asString };

            if (plan.values.ignore === 'ifZero') {
              print(inner, `  if (!(${zeroOf(entryValue)})) {`);
              judge(`${inner}    `, {
                plan: plan.values,
                value: 'entry',
                site: `${site}$values`,
                ...(enumOf === undefined ? {} : { enumOf }),
                asString,
              });
              print(inner, '  }');
            } else {
              judge(`${inner}  `, {
                plan: plan.values,
                value: 'entry',
                site: `${site}$values`,
                ...(enumOf === undefined ? {} : { enumOf }),
                asString,
              });
            }
          }

          print(inner, '  sink.leave();');
          print(inner, '}');
        }

        print('    ', '}');
        print('  ', '}');
        return;
      }

      // * a singular field: its value read once, judged where it is set
      const oneof = field.oneof;
      const work = plan.value.judgments.length > 0 || plan.value.message !== undefined;

      if (!work && required === undefined) {
        return;
      }

      print('  ', comment);

      const valueAccess =
        oneof === undefined ? `message.${field.localName}` : `message.${oneof.localName}.value`;
      const valueOf: IValueOf = { expression: 'value', type: entry.type, asString };
      const presenceOf = (): Printable => {
        if (oneof !== undefined) {
          return `message.${oneof.localName}.case === ${literalOf(field.localName)}`;
        }

        if ('message' in entry.type || 'wrapper' in entry.type) {
          return 'value !== undefined';
        }

        if (entry.presence === 'explicit' && field.proto.proto3Optional) {
          return 'value !== undefined';
        }

        return entry.presence === 'explicit' ? explicitSetOf(field) : `!(${zeroOf(valueOf)})`;
      };
      const tracked =
        oneof !== undefined ||
        'message' in entry.type ||
        'wrapper' in entry.type ||
        entry.presence === 'explicit';

      if (oneof === undefined) {
        print('  ', '{');
        print('    ', `const value = ${valueAccess};`);
        print('', '');
      } else {
        print('  ', '{');
      }

      const body = (indent: string): void => {
        if (oneof !== undefined) {
          print(indent, `const value = ${valueAccess};`);
          print('', '');
        }

        print(indent, `sink.enter(${name});`);
        judge(indent, {
          plan: plan.value,
          value: 'value',
          site,
          ...(enumOf === undefined ? {} : { enumOf }),
          asString,
        });
        print(indent, 'sink.leave();');
      };

      if (required !== undefined) {
        print('    ', ['if (!(', presenceOf(), ')) {']);
        print('      ', `sink.enter(${name});`);
        print('      ', `if (sink.add(${required}, undefined)) {`);
        print('      ', '  return true;');
        print('      ', '}');
        print('      ', 'sink.leave();');

        if (work) {
          print('    ', '} else {');
          body('      ');
        }

        print('    ', '}');
      } else if (tracked) {
        print('    ', ['if (', presenceOf(), ') {']);
        body('      ');
        print('    ', '}');
      } else if (plan.value.ignore === 'ifZero') {
        print('    ', `if (!(${zeroOf(valueOf)})) {`);
        body('      ');
        print('    ', '}');
      } else {
        print('    ', `sink.enter(${name});`);
        judge('    ', {
          plan: plan.value,
          value: 'value',
          site,
          ...(enumOf === undefined ? {} : { enumOf }),
          asString,
        });
        print('    ', 'sink.leave();');
      }

      print('  ', '}');
    };

    for (const field of plan.fields) {
      printField(field);
    }

    // * the message's own rules, at its own path: its oneof rules, then each oneof's required
    plan.oneofRules.forEach((rule, at) => {
      const counted = rule.fields.map((entry) => {
        return setPrintable(entry, fieldOf(entry));
      });
      const many = siteConstantOf(rule.many, `${base}$oneof${String(at)}`);

      print('  ', `// (buf.validate.message).oneof ${String(at)}`);
      print('  ', '{');
      print('    ', [
        'const set = ',
        ...counted.flatMap((condition, index) => {
          return [index === 0 ? '' : ' + ', '(', condition, ' ? 1 : 0)'];
        }),
        ';',
      ]);
      print('', '');
      print('    ', `if (set > 1 && sink.add(${many}, undefined)) {`);
      print('    ', '  return true;');
      print('    ', '}');

      if (rule.none !== undefined) {
        const none = siteConstantOf(rule.none, `${base}$oneof${String(at)}$none`);

        print('    ', `if (set === 0 && sink.add(${none}, undefined)) {`);
        print('    ', '  return true;');
        print('    ', '}');
      }

      print('  ', '}');
    });

    for (const oneof of plan.oneofs) {
      const desc = message.oneofs.find((each) => {
        return each.name === oneof.name;
      });

      if (desc === undefined) {
        throw new Error(`${plan.fullName} holds no oneof ${oneof.name}`);
      }

      const site = siteConstantOf(oneof.site, `${base}$${partOf(oneof.name)}$required`);

      print('  ', `// ${oneof.name}, its required`);
      print('  ', `sink.enter(${literalOf(oneof.name)});`);
      print(
        '  ',
        `if (message.${desc.localName}.case === undefined && sink.add(${site}, undefined)) {`
      );
      print('  ', '  return true;');
      print('  ', '}');
      print('  ', 'sink.leave();');
    }

    print('  ', 'return false;');

    bodies.push([
      'const ',
      functionOf(plan.fullName),
      ' = (message: ',
      f.importShape(message),
      ', sink: ',
      fromProto('IViolationSink', true),
      '): boolean => {\n',
      ...lines,
      '};',
    ]);
  }

  if (plans.length > 0) {
    f.print();
    f.print(
      "// * each request's rules, judged before its resolver, every rule a site of its own (spec 18, decision 0035)"
    );

    for (const constant of constants) {
      f.print(...constant);
    }

    for (const body of bodies) {
      f.print();
      f.print(...body);
    }
  }

  return new Map(
    plans.map((plan) => {
      return [plan.fullName, functionOf(plan.fullName)] as const;
    })
  );
};
