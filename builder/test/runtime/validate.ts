// ── The runtime's validators, as the generated code takes them ────────────────

// The contract the TypeScript target's validators call (decision 0035), played here so that the
// builder's tests run what it generates: the verdicts of spec/validations.json through the
// validators beadc writes for spec/validations.proto, with no runtime's install. Every name, type
// and behaviour here is what the TypeScript side's `proto` module provides, by these names
// (`src/proto/validate.ts`, `src/proto/pattern.ts`), which its own tests hold to the same verdicts.

// dependencies

import {
  create,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';

// types

/** A rule's site, a constant of the generated file: what every violation of it says. */
export interface IViolationRule {
  readonly ruleId: string;
  readonly message: string;
  readonly bounds?: Readonly<Record<string, unknown>>;
  readonly forKey?: true;
}

/** A violation, spec 18.3, and the value that broke it, which stays on the side that judged. */
export interface IViolation {
  readonly bounds?: Readonly<Record<string, unknown>>;
  readonly fieldPath?: string;
  readonly forKey?: true;
  readonly message: string;
  readonly ruleId: string;
  readonly value?: unknown;
}

/** What a judging gives: the violations its detail can carry, the count of the rest, whether it stopped. */
export interface IJudged {
  readonly violations: readonly IViolation[];
  readonly more: number;
  readonly stopped: boolean;
}

/** What a validator is given: whether it stops at its first violation, and its detail's bound. */
export interface IValidateOptions {
  readonly failFast?: boolean;
  readonly maximumBytes?: number;
}

/** Where the generated rules write: a violation at the path it stands at, and the path's steps. */
export interface IViolationSink {
  /** Adds a violation of `rule`, of `value`; true where the judging stops there (failFast). */
  readonly add: (rule: IViolationRule, value: unknown) => boolean;
  /** Steps into the field `name` of the message it stands at. */
  readonly enter: (name: string) => void;
  /** Steps into the item `index` of the repeated field `name`. */
  readonly enterIndex: (name: string, index: number) => void;
  /** Steps into the entry `key` of the map field `name`. */
  readonly enterKey: (name: string, key: string | number | bigint | boolean) => void;
  /** Steps back out of the last field it stepped into. */
  readonly leave: () => void;
}

/** A pattern's table, as beadc builds it: a code point's class by `bounds`, then one cell. */
export interface IPatternTable {
  readonly accepting: readonly number[];
  readonly bounds: readonly number[];
  readonly classCount: number;
  readonly classes: readonly number[];
  readonly dead: number;
  readonly matched: number;
  readonly stateCount: number;
  readonly transitions: Uint16Array;
}

// constants

// the closing line at its longest, `{"more":N}` with N below 2⁵³, and the line feed before it
const KEPT = 26;

// a string key's subscript holds 64 bytes of it at most (spec 18.4)
const KEY_BYTES = 64;

const REPLACEMENT_CHARACTER = 0xfffd;

const UTF8 = new TextEncoder();

// helpers

const utf8Of = (text: string): number => {
  return UTF8.encode(text).length;
};

// a value's text in section 17.7's form, RFC 8785's
const canonicalOf = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalOf).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalOf((value as Record<string, unknown>)[key])}`;
      })
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

// a string key's subscript: whole within 64 bytes of UTF-8, else cut back to a character's start,
// marked `...` outside its quotation marks (spec 18.4)
const keyOf = (key: string | number | bigint | boolean): string => {
  if (typeof key !== 'string') {
    return String(key);
  }

  if (utf8Of(key) <= KEY_BYTES) {
    return JSON.stringify(key);
  }

  let cut = '';
  let size = 0;

  for (const character of key) {
    const length = utf8Of(character);

    if (size + length > KEY_BYTES) {
      break;
    }

    cut += character;
    size += length;
  }

  return `${JSON.stringify(cut)}...`;
};

// a violation's lines, whole, then without its message, then without its bounds too (spec 18.6)
const formsOf = (violation: IViolation): string[] => {
  const { value: _value, ...members } = violation;
  const { message: _message, ...short } = members;
  const { bounds: _bounds, ...shortest } = short;

  return [...new Set([canonicalOf(members), canonicalOf(short), canonicalOf(shortest)])];
};

// definition

/** A string's length in code points (spec 18.8.2), a lone surrogate one. */
export const codePointLength = (text: string): number => {
  let length = 0;

  for (const _character of text) {
    length += 1;
  }

  return length;
};

/** A string's length in the UTF-8 it is sent as, a lone surrogate's U+FFFD three bytes. */
export const utf8Length = (text: string): number => {
  return utf8Of(text);
};

/** Whether two byte strings are one. */
export const bytesEqual = (bytes: Uint8Array, other: Uint8Array): boolean => {
  return (
    bytes.length === other.length &&
    bytes.every((byte, at) => {
      return byte === other[at];
    })
  );
};

/** Whether `bytes` starts with `prefix`. */
export const bytesStartWith = (bytes: Uint8Array, prefix: Uint8Array): boolean => {
  return bytes.length >= prefix.length && bytesEqual(bytes.subarray(0, prefix.length), prefix);
};

/** Whether `bytes` ends with `suffix`. */
export const bytesEndWith = (bytes: Uint8Array, suffix: Uint8Array): boolean => {
  return (
    bytes.length >= suffix.length &&
    bytesEqual(bytes.subarray(bytes.length - suffix.length), suffix)
  );
};

/** Whether `bytes` holds `part`. */
export const bytesContain = (bytes: Uint8Array, part: Uint8Array): boolean => {
  for (let at = 0; at + part.length <= bytes.length; at += 1) {
    if (bytesEqual(bytes.subarray(at, at + part.length), part)) {
      return true;
    }
  }

  return false;
};

/** Whether no two items are one, as `==` compares (spec 18.8.4): 0 and −0 one, two NaN two. */
export const isUnique = (items: readonly unknown[]): boolean => {
  for (let at = 0; at < items.length; at += 1) {
    for (let other = at + 1; other < items.length; other += 1) {
      const one = items[at];
      const two = items[other];

      if (
        one instanceof Uint8Array && two instanceof Uint8Array ? bytesEqual(one, two) : one === two
      ) {
        return false;
      }
    }
  }

  return true;
};

/**
 * A map's entries by key (spec 18.5): integers ascending, `false` before `true`, strings by code
 * points, each key as protobuf-es keeps it, a string.
 */
export const entriesByKey = <Value>(
  map: { readonly [key: string]: Value } | { readonly [key: number]: Value },
  order: 'string' | 'integer' | 'bool'
): (readonly [string, Value])[] => {
  const entries: [string, Value][] = Object.entries(map);

  return entries.sort(([one], [other]) => {
    if (order === 'integer') {
      const left = BigInt(one);
      const right = BigInt(other);

      return left < right ? -1 : left > right ? 1 : 0;
    }

    if (order === 'bool') {
      return one === other ? 0 : one === 'false' ? -1 : 1;
    }

    const left = Array.from(one, (character) => {
      return character.codePointAt(0) ?? 0;
    });
    const right = Array.from(other, (character) => {
      return character.codePointAt(0) ?? 0;
    });

    for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
      if (left[at] !== right[at]) {
        return (left[at] ?? 0) - (right[at] ?? 0);
      }
    }

    return left.length - right.length;
  });
};

/** Whether `table`'s pattern matches anywhere in `text`: one class and one cell a code point. */
export const matchesPattern = (table: IPatternTable, text: string): boolean => {
  let state = 0;

  for (const character of text) {
    const read = character.codePointAt(0) ?? REPLACEMENT_CHARACTER;
    const point = read >= 0xd800 && read <= 0xdfff ? REPLACEMENT_CHARACTER : read;
    let low = 0;
    let high = table.bounds.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;

      if ((table.bounds[middle] ?? 0) <= point) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    state = table.transitions[state * table.classCount + (table.classes[low] ?? 0)] ?? 0;

    if (state === table.matched) {
      return true;
    }

    if (state === table.dead) {
      return false;
    }
  }

  return table.accepting.includes(state);
};

/**
 * The validator of `schema`'s `rules`: the value given made a message, `create(schema, given)`, its
 * rules judged into a sink that keeps the violations a detail of `maximumBytes` carries and counts
 * the rest, or stops at the first under `failFast`.
 */
export const validatorOf = <Desc extends DescMessage>(
  schema: Desc,
  rules: (message: MessageShape<Desc>, sink: IViolationSink) => boolean
): ((request: unknown, options?: IValidateOptions) => IJudged) => {
  return (request, options = {}) => {
    const failFast = options.failFast === true;
    const maximum = options.maximumBytes ?? 2_147_483_647;
    const steps: string[] = [];
    const violations: IViolation[] = [];
    let size = 0;
    let more = 0;
    let full = false;
    const sink: IViolationSink = {
      add: (rule, value) => {
        if (full) {
          more += 1;

          return false;
        }

        const fieldPath = steps.join('.');
        const violation: IViolation = {
          ...(rule.bounds === undefined ? {} : { bounds: rule.bounds }),
          ...(fieldPath === '' ? {} : { fieldPath }),
          ...(rule.forKey === true ? { forKey: true } : {}),
          message: rule.message,
          ruleId: rule.ruleId,
          ...(value === undefined ? {} : { value }),
        };
        const fits = formsOf(violation).find((line) => {
          return size + (violations.length > 0 ? 1 : 0) + utf8Of(line) + KEPT <= maximum;
        });

        if (fits === undefined) {
          full = true;
          more += 1;
        } else {
          size += (violations.length > 0 ? 1 : 0) + utf8Of(fits);
          violations.push(violation);
        }

        return failFast;
      },
      enter: (name) => {
        steps.push(name);
      },
      enterIndex: (name, index) => {
        steps.push(`${name}[${String(index)}]`);
      },
      enterKey: (name, key) => {
        steps.push(`${name}[${keyOf(key)}]`);
      },
      leave: () => {
        steps.pop();
      },
    };
    const message = create(schema, request as MessageInitShape<Desc>);
    const stopped = rules(message, sink);

    return { violations, more, stopped: failFast && stopped };
  };
};
