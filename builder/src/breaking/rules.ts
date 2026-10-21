// ── Rules ─────────────────────────────────────────────────────────────────────

// What `beadc breaking` reads of two blueprints' rules (decision 0035): where a request an earlier
// peer sends is one the current refuses, PROCEDURE_RULES_TIGHTENED's — a rule added to a field both
// hold, by number; `required` added; `ignore` moved toward judging; a lower bound raised, an upper
// lowered, an inclusive bound become exclusive; `len`, `const`, `pattern`, `prefix`, `suffix`,
// `contains` or `not_contains` set or changed; `in` that lost a value, `not_in` that gained one;
// `defined_only`, `unique` or `finite` set; a `min_*` raised, a `max_*` lowered; an item's, a key's
// or a value's rules tightened alike; a oneof's `required` set; a message's oneof rule added or
// changed — each named by its field's path and its rule. A range given reversed, the values outside
// it taken, is compared whole: changed, it is tightened. And whether the rules a request reaches
// changed at all, either way, which moves its service's revision.

// dependencies

import type {
  FieldRulesValue,
  IBlueprint,
  IFieldRulesEntry,
  IMessageRules,
  RuleValue,
} from '../model/blueprint.ts';
import {
  canonicalOf,
  compareNumbers,
  judgedMessagesOf,
  textOf as scalarOf,
} from '../model/rules.ts';

// constants

// how far `ignore` judges: always nothing, then nothing at a field's zero, then its value
const IGNORE_RANK: Readonly<Record<string, number>> = Object.freeze({
  IGNORE_ALWAYS: 0,
  IGNORE_IF_ZERO_VALUE: 1,
  IGNORE_UNSPECIFIED: 2,
});

// the members whose value set or changed tightens a field's rules
const EXACT = new Set([
  'const',
  'len',
  'len_bytes',
  'pattern',
  'prefix',
  'suffix',
  'contains',
  'not_contains',
]);

// the members that refuse a value once set
const FLAGS = new Set(['defined_only', 'unique', 'finite']);

// the members that raise a lower count, and those that lower an upper one
const MINIMA = new Set(['min_len', 'min_bytes', 'min_items', 'min_pairs']);
const MAXIMA = new Set(['max_len', 'max_bytes', 'max_items', 'max_pairs']);

// the members holding the rules of an item, a key or a value
const NESTED = new Set(['items', 'keys', 'values']);

// a type member whose values are numbers, by the scalar each judges
const NUMBER_TYPES = new Set([
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
  'enum',
]);

const TYPE_MEMBERS = new Set([...NUMBER_TYPES, 'bool', 'string', 'bytes', 'repeated', 'map']);

// helpers

const isRecord = (value: unknown): value is Record<string, RuleValue> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// a rule's value as section 17.7 writes it, compared as text
const jsonOf = (value: RuleValue | undefined): string => {
  return value === undefined ? '' : canonicalOf(value);
};

// a number's kind, as the comparison reads it: a float and a double alike, every integer whole
const kindOf = (type: string): 'double' | 'int64' => {
  return type === 'float' || type === 'double' ? 'double' : 'int64';
};

// the tightenings of a number's range: a bound added, a lower raised, an upper lowered, an
// inclusive become exclusive; a range given reversed compared whole
const rangeOf = (
  type: string,
  sides: { readonly was: Record<string, RuleValue>; readonly now: Record<string, RuleValue> }
): string[] => {
  const { was, now } = sides;
  const kind = kindOf(type);
  const boundOf = (
    rules: Record<string, RuleValue>,
    side: 'lower' | 'upper'
  ):
    | { readonly value: string; readonly exclusive: boolean; readonly member: string }
    | undefined => {
    const [strict, loose] = side === 'lower' ? ['gt', 'gte'] : ['lt', 'lte'];
    const member =
      rules[strict] !== undefined ? strict : rules[loose] !== undefined ? loose : undefined;

    return member === undefined
      ? undefined
      : { value: scalarOf(rules[member]), exclusive: member === strict, member };
  };
  const reversed = (rules: Record<string, RuleValue>): boolean => {
    const lower = boundOf(rules, 'lower');
    const upper = boundOf(rules, 'upper');

    return (
      lower !== undefined &&
      upper !== undefined &&
      compareNumbers({ kind, text: upper.value }, { kind, text: lower.value }) < 0
    );
  };
  const members = ['gt', 'gte', 'lt', 'lte'];
  const same = members.every((member) => {
    return jsonOf(was[member]) === jsonOf(now[member]);
  });

  if (same) {
    return [];
  }

  if (reversed(was) || reversed(now)) {
    return [`${type}'s range`];
  }

  const found: string[] = [];

  for (const side of ['lower', 'upper'] as const) {
    const before = boundOf(was, side);
    const after = boundOf(now, side);

    if (after === undefined) {
      continue;
    }

    if (before === undefined) {
      found.push(`${type}.${after.member} added`);
      continue;
    }

    const order = compareNumbers({ kind, text: after.value }, { kind, text: before.value });
    const narrower = side === 'lower' ? order > 0 : order < 0;

    if (narrower || (order === 0 && after.exclusive && !before.exclusive)) {
      found.push(`${type}.${after.member} ${side === 'lower' ? 'raised' : 'lowered'}`);
    }
  }

  return found;
};

// what of `now` refuses a value `was` takes, a field's rules, each by its member's names
const tightenedOf = (
  was: FieldRulesValue | undefined,
  now: FieldRulesValue | undefined
): string[] => {
  const before = was ?? {};
  const after = now ?? {};
  const found: string[] = [];

  if (after['required'] === true && before['required'] !== true) {
    found.push('required added');
  }

  const ignoredAfter = scalarOf(after['ignore'] ?? 'IGNORE_UNSPECIFIED');
  const ignoreBefore = IGNORE_RANK[scalarOf(before['ignore'] ?? 'IGNORE_UNSPECIFIED')] ?? 2;
  const ignoreAfter = IGNORE_RANK[ignoredAfter] ?? 2;

  if (ignoreAfter > ignoreBefore) {
    found.push(`ignore moved toward judging, ${ignoredAfter}`);
  }

  if (ignoreAfter === 0) {
    return found;
  }

  for (const type of Object.keys(after)) {
    if (!TYPE_MEMBERS.has(type)) {
      continue;
    }

    const typedAfter = isRecord(after[type]) ? after[type] : {};
    const typedBefore = isRecord(before[type]) ? before[type] : undefined;

    if (typedBefore === undefined) {
      found.push(
        ...Object.keys(typedAfter)
          .filter((member) => {
            return member !== 'example';
          })
          .map((member) => {
            return `${type}.${member} added`;
          })
      );
      continue;
    }

    if (NUMBER_TYPES.has(type)) {
      found.push(...rangeOf(type, { was: typedBefore, now: typedAfter }));
    }

    for (const [member, value] of Object.entries(typedAfter)) {
      const prior = typedBefore[member];

      if (EXACT.has(member) && jsonOf(value) !== jsonOf(prior)) {
        found.push(`${type}.${member} ${prior === undefined ? 'set' : 'changed'}`);
      } else if (FLAGS.has(member) && value === true && prior !== true) {
        found.push(`${type}.${member} set`);
      } else if (
        MINIMA.has(member) &&
        (prior === undefined || BigInt(scalarOf(value)) > BigInt(scalarOf(prior)))
      ) {
        found.push(`${type}.${member} raised`);
      } else if (
        MAXIMA.has(member) &&
        (prior === undefined || BigInt(scalarOf(value)) < BigInt(scalarOf(prior)))
      ) {
        found.push(`${type}.${member} lowered`);
      } else if (member === 'in' && Array.isArray(value)) {
        const kept = new Set(value.map(jsonOf));
        const lost =
          !Array.isArray(prior) ||
          prior.some((item: RuleValue) => {
            return !kept.has(jsonOf(item));
          });

        if (lost) {
          found.push(`${type}.in lost a value`);
        }
      } else if (member === 'not_in' && Array.isArray(value)) {
        const held = new Set(Array.isArray(prior) ? prior.map(jsonOf) : []);

        if (
          value.some((item: RuleValue) => {
            return !held.has(jsonOf(item));
          })
        ) {
          found.push(`${type}.not_in gained a value`);
        }
      } else if (NESTED.has(member) && isRecord(value)) {
        found.push(
          ...tightenedOf(isRecord(prior) ? prior : undefined, value).map((each) => {
            return `${type}.${member}: ${each}`;
          })
        );
      }
    }
  }

  return found;
};

// the message a field holds, by its full name, where its type names one
const heldOf = (entry: IFieldRulesEntry): string | undefined => {
  return 'message' in entry.type ? entry.type.message : undefined;
};

// definition

/**
 * What of `current`'s rules a request of `message` its `earlier` takes now refuses, each a field's
 * path and its rule, through the messages both reach by the same fields.
 */
export const tighteningsOf = (
  sides: { readonly earlier: IBlueprint; readonly current: IBlueprint },
  message: string
): string[] => {
  const earlier = judgedMessagesOf(sides.earlier);
  const current = judgedMessagesOf(sides.current);
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (names: { readonly was: string; readonly now: string }, path: string): void => {
    const key = `${names.was} ${names.now}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const was: IMessageRules | undefined = earlier.get(names.was);
    const now: IMessageRules | undefined = current.get(names.now);

    if (now === undefined) {
      return;
    }

    const prefix = path === '' ? '' : `${path}.`;

    for (const entry of now.fields) {
      const before = was?.fields.find((each) => {
        return each.fieldNumber === entry.fieldNumber;
      });
      const at = `${prefix}${entry.fieldName}`;

      found.push(
        ...tightenedOf(before?.rules, entry.rules).map((each) => {
          return `${at}: ${each}`;
        })
      );

      const heldNow = heldOf(entry);
      const heldBefore = before === undefined ? undefined : heldOf(before);

      // * a message held by the same field, by number, whose rules are read further down
      if (
        heldNow !== undefined &&
        heldBefore !== undefined &&
        entry.rules?.['ignore'] !== 'IGNORE_ALWAYS'
      ) {
        walk({ was: heldBefore, now: heldNow }, at);
      }
    }

    const rulesBefore = new Set((was?.message.oneof ?? []).map(canonicalOf));

    for (const rule of now.message.oneof ?? []) {
      if (!rulesBefore.has(canonicalOf(rule))) {
        found.push(
          `${path === '' ? 'its message' : path}: (buf.validate.message).oneof ${rule.fields.join(', ')} added or changed`
        );
      }
    }

    for (const oneof of now.oneofs) {
      const prior = was?.oneofs.find((each) => {
        return each.oneofName === oneof.oneofName;
      });

      if (oneof.rules.required === true && prior?.rules.required !== true) {
        found.push(`${prefix}${oneof.oneofName}: (buf.validate.oneof).required set`);
      }
    }
  };

  walk({ was: message, now: message }, '');

  return found;
};

/** Whether the rules a request of `message` reaches differ between `sides`, either way. */
export const rulesChangedOf = (
  sides: { readonly earlier: IBlueprint; readonly current: IBlueprint },
  message: string
): boolean => {
  const reached = (blueprint: IBlueprint): string => {
    const rules = judgedMessagesOf(blueprint);
    const texts: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string): void => {
      const held = rules.get(name);

      if (held === undefined || seen.has(name)) {
        return;
      }

      seen.add(name);
      texts.push(`${name} ${canonicalOf(held as unknown as RuleValue)}`);

      for (const entry of held.fields) {
        const inner = heldOf(entry);

        if (inner !== undefined) {
          visit(inner);
        }
      }
    };

    visit(message);

    return texts.join('\n');
  };

  return reached(sides.earlier) !== reached(sides.current);
};
