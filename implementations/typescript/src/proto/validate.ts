// ── Validate ──────────────────────────────────────────────────────────────────

// What a `proto` request's generated rules judge with (spec 18, decision 0035): a sink that holds
// the violations its detail carries and counts the rest, a path built for a violation held alone,
// and the readings 18.8 fixes: code points, UTF-8 bytes, `==`, a map's keys in order.

// dependencies

import {
  create,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';

import {
  createViolationHolder,
  type IJudged,
  type IValidateOptions,
  type IViolation,
} from '../router/shared/violations';

// interfaces

/** A rule's site, a constant of the generated file: what every violation of it says. */
export interface IViolationRule {
  /** The members its rule takes, as protobuf's JSON mapping writes them; none for a flag alone. */
  readonly bounds?: Readonly<Record<string, unknown>> | undefined;
  readonly forKey?: true | undefined;
  /** Its words (spec 18.8.6). */
  readonly message: string;
  readonly ruleId: string;
}

/** Where the generated rules write: a violation where the judging stands, and the path's steps. */
export interface IViolationSink {
  /** Adds a violation of `rule` by `value`; `true` where the judging stops there, under `failFast`. */
  readonly add: (rule: IViolationRule, value: unknown) => boolean;
  /** Steps into the field `name` of the message it stands at. */
  readonly enter: (name: string) => void;
  /** Steps into the item `index` of the repeated field `name`. */
  readonly enterIndex: (name: string, index: number) => void;
  /** Steps into the entry `key` of the map field `name`. */
  readonly enterKey: (name: string, key: bigint | boolean | number | string) => void;
  /** Steps back out of the last step it took. */
  readonly leave: () => void;
}

// types

/** A message's generated rules: each judged into `sink`, `true` where the judging stopped. */
export type MessageRules<Message> = (message: Message, sink: IViolationSink) => boolean;

/** A request's validator, as a descriptor's `validate` holds one. */
export type Validator = (request: unknown, options?: IValidateOptions) => IJudged;

// constants

/** A string key's subscript holds 64 bytes of its UTF-8 at most (spec 18.4). */
const KEY_BYTES = 64;

/** The judging of a request that breaks nothing, which allocates nothing. */
const NOTHING_BROKEN: IJudged = Object.freeze({
  more: 0,
  stopped: false,
  violations: Object.freeze([]),
});

/** A step into a field alone, no item nor entry. */
const NO_SUBSCRIPT = Symbol('no subscript');

const ENCODER = new TextEncoder();

// helpers

/**
 * A key's subscript (spec 18.4): an integer or a boolean as it reads, a string in section 17.7's
 * form, whole within 64 bytes of UTF-8, else cut back to a character's start and marked `...`.
 */
const subscriptOf = (key: bigint | boolean | number | string): string => {
  if (typeof key !== 'string') {
    return String(key);
  }

  // ! a surrogate alone goes as U+FFFD, as a writer writes one (spec 7.4)
  const text = key.toWellFormed();

  if (ENCODER.encode(text).length <= KEY_BYTES) {
    return JSON.stringify(text);
  }

  let cut = '';
  let size = 0;

  for (const character of text) {
    const length = ENCODER.encode(character).length;

    if (size + length > KEY_BYTES) {
      break;
    }

    cut += character;
    size += length;
  }

  return `${JSON.stringify(cut)}...`;
};

/** Whether `bytes` holds `part` from `at` on. */
const holdsAt = (bytes: Uint8Array, { at, part }: { at: number; part: Uint8Array }): boolean => {
  for (let index = 0; index < part.length; index += 1) {
    if (bytes[at + index] !== part[index]) {
      return false;
    }
  }

  return true;
};

/** Code points, in order, compared as numbers: a string's order by code points (spec 18.5). */
const byCodePoints = (first: string, second: string): number => {
  const left = first[Symbol.iterator]();
  const right = second[Symbol.iterator]();

  for (;;) {
    const one = left.next();
    const two = right.next();

    if (one.done === true || two.done === true) {
      return (one.done === true ? 0 : 1) - (two.done === true ? 0 : 1);
    }

    const difference = (one.value.codePointAt(0) ?? 0) - (two.value.codePointAt(0) ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }
};

// definition

/** A string's length in code points (spec 18.8.2), a surrogate alone one. */
export const codePointLength = (text: string): number => {
  let length = 0;

  for (const _character of text) {
    length += 1;
  }

  return length;
};

/** A string's length in the UTF-8 it is sent as, a surrogate alone U+FFFD's three bytes. */
export const utf8Length = (text: string): number => {
  return ENCODER.encode(text).length;
};

/** Whether two byte strings are one. */
export const bytesEqual = (bytes: Uint8Array, other: Uint8Array): boolean => {
  return bytes.length === other.length && holdsAt(bytes, { at: 0, part: other });
};

/** Whether `bytes` starts with `prefix`. */
export const bytesStartWith = (bytes: Uint8Array, prefix: Uint8Array): boolean => {
  return bytes.length >= prefix.length && holdsAt(bytes, { at: 0, part: prefix });
};

/** Whether `bytes` ends with `suffix`. */
export const bytesEndWith = (bytes: Uint8Array, suffix: Uint8Array): boolean => {
  return (
    bytes.length >= suffix.length &&
    holdsAt(bytes, { at: bytes.length - suffix.length, part: suffix })
  );
};

/** Whether `bytes` holds `part`. */
export const bytesContain = (bytes: Uint8Array, part: Uint8Array): boolean => {
  for (let at = 0; at + part.length <= bytes.length; at += 1) {
    if (holdsAt(bytes, { at, part })) {
      return true;
    }
  }

  return false;
};

/**
 * Whether no two items are one, as `==` compares them (spec 18.8.4): `0.0` and `-0.0` one, two NaN
 * two, bytes by their bytes.
 */
export const isUnique = (items: readonly unknown[]): boolean => {
  const isOfBytes = items.some((item) => {
    return item instanceof Uint8Array;
  });

  // * a Set takes 0 and −0 as one, as `==` does, and every NaN as one, which `==` takes as two
  if (!isOfBytes) {
    const nans = items.filter(Number.isNaN).length;

    return new Set(items).size + Math.max(nans - 1, 0) === items.length;
  }

  for (let at = 0; at < items.length; at += 1) {
    for (let other = at + 1; other < items.length; other += 1) {
      const one = items[at];
      const two = items[other];

      if (one instanceof Uint8Array && two instanceof Uint8Array && bytesEqual(one, two)) {
        return false;
      }
    }
  }

  return true;
};

/**
 * A map's entries by key (spec 18.5): integers ascending, `false` before `true`, strings by code
 * points; each key as protobuf-es keeps it, a string.
 */
export const entriesByKey = <Value>(
  map: { readonly [key: string]: Value } | { readonly [key: number]: Value },
  order: 'bool' | 'integer' | 'string'
): (readonly [string, Value])[] => {
  const entries: [string, Value][] = Object.entries(map);

  if (order === 'integer') {
    return entries.toSorted(([first], [second]) => {
      const left = BigInt(first);
      const right = BigInt(second);

      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  if (order === 'bool') {
    return entries.toSorted(([first], [second]) => {
      return first === second ? 0 : first === 'false' ? -1 : 1;
    });
  }

  return entries.toSorted(([first], [second]) => {
    return byCodePoints(first, second);
  });
};

/**
 * Judges `rules` into a sink that holds the violations a detail of `maximumBytes` carries, each as
 * its writer sizes it, and counts the rest without building their path, or stops at the first
 * under `failFast` (spec 18.2, 18.6). A judging that breaks nothing allocates no violation.
 *
 * @example
 * import { judgeRules } from '@francisdesjardins/bead/proto';
 *
 * const judged = judgeRules(
 *   (sink) => {
 *     sink.enter('names');
 *     if (names.length > 50 && sink.add(TOO_MANY, names)) {
 *       return true;
 *     }
 *     sink.leave();
 *     return false;
 *   },
 *   { maximumBytes: 1_024 }
 * );
 */
export const judgeRules = (
  rules: (sink: IViolationSink) => boolean,
  options: IValidateOptions = {}
): IJudged => {
  const { failFast = false, maximumBytes } = options;
  const holder = maximumBytes === undefined ? undefined : createViolationHolder(maximumBytes);
  // * the path as steps, a name and its subscript each, rendered only for a violation held
  const names: string[] = [];
  const subscripts: unknown[] = [];
  let violations: IViolation[] | undefined;
  let more = 0;
  let isFull = false;

  const pathOf = (): string | undefined => {
    if (names.length === 0) {
      return undefined;
    }

    return names
      .map((name, at) => {
        const subscript = subscripts[at];

        return subscript === NO_SUBSCRIPT
          ? name
          : `${name}[${subscriptOf(subscript as bigint | boolean | number | string)}]`;
      })
      .join('.');
  };

  const sink: IViolationSink = {
    add: (rule, value) => {
      if (!isFull) {
        const { bounds, forKey, message, ruleId } = rule;
        const fieldPath = pathOf();
        const violation: IViolation = {
          ...(bounds === undefined ? {} : { bounds }),
          ...(fieldPath === undefined ? {} : { fieldPath }),
          ...(forKey === true ? { forKey } : {}),
          message,
          ruleId,
          ...(value === undefined ? {} : { value }),
        };

        if (holder === undefined || holder.hold(violation)) {
          violations ??= [];
          violations.push(violation);

          return failFast;
        }

        isFull = true;
      }

      more += 1;

      return failFast;
    },
    enter: (name) => {
      names.push(name);
      subscripts.push(NO_SUBSCRIPT);
    },
    enterIndex: (name, index) => {
      names.push(name);
      subscripts.push(index);
    },
    enterKey: (name, key) => {
      names.push(name);
      subscripts.push(key);
    },
    leave: () => {
      names.pop();
      subscripts.pop();
    },
  };

  const stopped = rules(sink) && failFast;

  return violations === undefined && more === 0
    ? NOTHING_BROKEN
    : { more, stopped, violations: violations ?? [] };
};

/**
 * The validator of `schema`'s `rules`, as generated code makes a descriptor's `validate`: the value
 * given made a message, `create(schema, given)` — a message handed back as it is — and its rules
 * judged by {@link judgeRules}.
 *
 * @example
 * import { validatorOf } from '@francisdesjardins/bead/proto';
 *
 * const validate = validatorOf(CountDownRequestSchema, rulesOfCountDownRequest);
 * const { more, violations } = validate({ from: 11 }, { maximumBytes: 1_024 });
 */
export const validatorOf = <Desc extends DescMessage>(
  schema: Desc,
  rules: MessageRules<MessageShape<Desc>>
): Validator => {
  return (request, options) => {
    const message = create(schema, request as MessageInitShape<Desc>);

    return judgeRules((sink) => {
      return rules(message, sink);
    }, options);
  };
};
