// ── Validate ──────────────────────────────────────────────────────────────────

// The validators beadc generates for spec/validations.proto, over this runtime, `generated/` here,
// which the root's tools/check-validations.mjs holds to its generator: each verdict of
// spec/validations.json judged through the procedure that binds its message, a test each, and the
// sink's own bounds. The C# side plays the same file through its own.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { IJudged, IViolation } from '../../router/shared/violations';
import { violationsDetailOf } from '../../router/shared/violations';
import {
  codePointLength,
  entriesByKey,
  isUnique,
  judgeRules,
  utf8Length,
  type IViolationRule,
  type Validator,
} from '../validate';

// interfaces

/** Bytes repeated, end to end, for a payload too long to write out. */
interface IRun {
  bytes: string;
  times: number;
}

/** A payload judged, and what its validator gives. */
interface IVerdict {
  clauses: string[];
  failFast?: true;
  maximumBytes?: number;
  message: string;
  more?: number;
  name: string;
  payload?: string;
  runs?: IRun[];
  stopped?: true;
  violations: IViolation[];
}

/** A procedure of the generated service: its request's codec, and its validator. */
interface IJudging {
  readonly request: { readonly decode: (bytes: Uint8Array) => unknown };
  readonly validate?: Validator;
}

// constants

const { verdicts: VERDICTS } = JSON.parse(
  readFileSync(new URL('../../../../../spec/validations.json', import.meta.url), 'utf8')
) as { verdicts: IVerdict[] };

// ! by its URL, so the package's type-check leaves it to tsconfig.validations.json
const GENERATED = new URL('./generated/validations_bead.ts', import.meta.url);

const EMPTY: IViolationRule = Object.freeze({
  bounds: Object.freeze({ min_len: '1' }),
  message: 'must be at least 1 characters',
  ruleId: 'string.min_len',
});

// helpers

const bytesOf = (hexadecimal: string): Uint8Array => {
  return Uint8Array.from(
    hexadecimal
      .split(' ')
      .filter((part) => {
        return part !== '';
      })
      .map((part) => {
        return Number.parseInt(part, 16);
      })
  );
};

/** A verdict's payload: its bytes, or its runs end to end. */
const payloadOf = ({ payload, runs = [] }: IVerdict): Uint8Array => {
  if (payload !== undefined) {
    return bytesOf(payload);
  }

  const parts = runs.flatMap(({ bytes, times }) => {
    return Array.from({ length: times }, () => {
      return bytesOf(bytes);
    });
  });
  const joined = new Uint8Array(
    parts.reduce((total, part) => {
      return total + part.length;
    }, 0)
  );
  let at = 0;

  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }

  return joined;
};

/** The procedure that binds `message`, a full name, as the generated service names it. */
const judgingOf = async (message: string): Promise<IJudging & { validate: Validator }> => {
  const { ValidationsProcedures } = (await import(GENERATED.href)) as {
    ValidationsProcedures: Record<string, IJudging>;
  };
  const judging = ValidationsProcedures[`judge${message.split('.').at(-1) ?? ''}`];

  if (judging?.validate === undefined) {
    throw new Error(`no validator of ${message}`);
  }

  return judging as IJudging & { validate: Validator };
};

/** What a judging gives, each violation without the value it keeps on its side. */
const sentOf = ({ more, stopped, violations }: IJudged) => {
  return {
    more,
    stopped,
    violations: violations.map(({ value: _value, ...violation }) => {
      return violation;
    }),
  };
};

// definition

test.describe('the verdicts', () => {
  test.describe.configure({ retries: 0 });

  for (const verdict of VERDICTS) {
    test(verdict.name, async () => {
      const { failFast, maximumBytes, message, more = 0, stopped, violations } = verdict;
      const { request, validate } = await judgingOf(message);

      // * read as a server reads a request, then judged as it judges one (spec 18.2)
      const judged = validate(request.decode(payloadOf(verdict)), {
        failFast: failFast === true,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });

      expect(sentOf(judged)).toEqual({ more, stopped: stopped === true, violations });
    });
  }
});

test.describe('validatorOf', () => {
  test('stops at the first violation with failFast, the first of its order', async () => {
    const { validate } = await judgingOf('bead.validations.v1.Order');
    // fields declared out of their numbers, each breaking its rule, then the message's own
    const request = { early: 1, inner: { name: '' }, late: '' };
    const every = validate(request);
    const first = validate(request, { failFast: true });

    expect(
      every.violations.map(({ fieldPath, ruleId }) => {
        return `${fieldPath ?? ''} ${ruleId}`;
      })
    ).toEqual([
      'inner.name string.min_len',
      'early int32.gt',
      'late string.min_len',
      ' message.oneof',
      'choice required',
    ]);
    expect(every.stopped).toBe(false);
    expect(sentOf(first)).toEqual({
      more: 0,
      stopped: true,
      violations: sentOf(every).violations.slice(0, 1),
    });
  });

  test('judges a request that breaks nothing and allocates no path', async () => {
    const { validate } = await judgingOf('bead.validations.v1.Numbers');
    const trap = {
      toString: () => {
        throw new Error('a path was built');
      },
    };

    // * one frozen judging for every request that breaks nothing: no violation is made
    expect(validate({ atMostTen: 10 })).toBe(validate({ atMostTen: 1, aboveZero: 3 }));
    expect(Object.isFrozen(validate({}).violations)).toBe(true);
    // a step that breaks nothing renders no subscript
    expect(
      judgeRules((sink) => {
        sink.enterKey('labels', trap as unknown as string);
        sink.enterIndex('items', 7);
        sink.leave();
        sink.leave();

        return false;
      })
    ).toEqual({ more: 0, stopped: false, violations: [] });
  });

  test('holds no more than its bound of a request that breaks every item, and counts the rest', async () => {
    const { validate } = await judgingOf('bead.validations.v1.Repeated');
    const many = Array.from({ length: 100_000 }, () => {
      return '';
    });
    const judged = validate({ many, names: ['a'] }, { maximumBytes: 1_024 });
    const detail = violationsDetailOf(judged, { maximumBytes: 1_024 });

    expect(judged.violations.length).toBeLessThan(10);
    expect(judged.violations.length + judged.more).toBe(100_000);
    expect(utf8Length(detail)).toBeLessThanOrEqual(1_024);
    expect(detail.endsWith(`{"more":${String(judged.more)}}`)).toBe(true);
    // unbounded, it holds every one
    expect(validate({ many, names: ['a'] }).violations).toHaveLength(100_000);
  });

  test('judges a wrapper’s value once set, and its required while unset', async () => {
    const { validate } = await judgingOf('bead.validations.v1.Wrappers');

    expect(sentOf(validate({}))).toEqual({
      more: 0,
      stopped: false,
      violations: [{ fieldPath: 'title', message: 'value is required', ruleId: 'required' }],
    });
    // * its path the field's alone, never its value's
    expect(sentOf(validate({ count: 0, title: '' })).violations).toEqual([
      {
        bounds: { gt: 0 },
        fieldPath: 'count',
        message: 'must be greater than 0',
        ruleId: 'int32.gt',
      },
      {
        bounds: { min_len: '1' },
        fieldPath: 'title',
        message: 'must be at least 1 characters',
        ruleId: 'string.min_len',
      },
    ]);
    expect(validate({ count: 1, title: 'a' }).violations).toEqual([]);
  });

  test('keeps the value a violation broke on the side that judged', async () => {
    const { validate } = await judgingOf('bead.validations.v1.Numbers');

    expect(validate({ atMostTen: 11 }).violations).toEqual([
      {
        bounds: { lte: 10 },
        fieldPath: 'at_most_ten',
        message: 'must be less than or equal to 10',
        ruleId: 'int32.lte',
        value: 11,
      },
    ]);
  });
});

test.describe('judgeRules', () => {
  test('holds every violation without a bound, and stops where its rules say so under failFast', () => {
    const rules = (sink: Parameters<Parameters<typeof judgeRules>[0]>[0]): boolean => {
      for (const index of [0, 1, 2]) {
        sink.enterIndex('names', index);

        if (sink.add(EMPTY, '')) {
          return true;
        }

        sink.leave();
      }

      return false;
    };

    expect(
      judgeRules(rules).violations.map(({ fieldPath }) => {
        return fieldPath;
      })
    ).toEqual(['names[0]', 'names[1]', 'names[2]']);
    expect(sentOf(judgeRules(rules, { failFast: true }))).toEqual({
      more: 0,
      stopped: true,
      violations: [{ ...EMPTY, fieldPath: 'names[0]' }],
    });
    // a bound that holds no line of it: counted, and stopped all the same
    expect(judgeRules(rules, { failFast: true, maximumBytes: 0 })).toEqual({
      more: 1,
      stopped: true,
      violations: [],
    });
  });

  test('renders a key as spec 18.4 does: whole within 64 bytes, else cut on a character and marked', () => {
    const pathOf = (key: bigint | boolean | number | string): string | undefined => {
      return judgeRules((sink) => {
        sink.enterKey('keyed', key);

        return sink.add(EMPTY, key);
      }).violations[0]?.fieldPath;
    };

    expect(pathOf('a\tb\u0001')).toBe('keyed["a\\tb\\u0001"]');
    expect(pathOf(-1)).toBe('keyed[-1]');
    expect(pathOf(18_446_744_073_709_551_615n)).toBe('keyed[18446744073709551615]');
    expect(pathOf(true)).toBe('keyed[true]');
    expect(pathOf(`${'k'.repeat(63)}é`)).toBe(`keyed["${'k'.repeat(63)}"...]`);
    expect(pathOf('\uD800')).toBe('keyed["�"]');
  });
});

test.describe('the readings', () => {
  test('counts a string in code points, and in UTF-8 bytes', () => {
    expect(codePointLength('😀ab')).toBe(3);
    expect(utf8Length('😀ab')).toBe(6);
    expect(utf8Length('\uD800')).toBe(3);
  });

  test('holds items unique as == compares them: 0 and −0 one, two NaN two, bytes by their bytes', () => {
    expect(isUnique([0, -0])).toBe(false);
    expect(isUnique([Number.NaN, Number.NaN])).toBe(true);
    expect(isUnique([Number.NaN, Number.NaN, 1, 1])).toBe(false);
    expect(isUnique([1n, 1n])).toBe(false);
    expect(isUnique([new Uint8Array([1]), new Uint8Array([1])])).toBe(false);
    expect(isUnique([new Uint8Array([1]), new Uint8Array([2])])).toBe(true);
  });

  test('orders a map’s entries by key: integers ascending, false before true, strings by code points', () => {
    const keys = (
      map: Record<string, number>,
      order: Parameters<typeof entriesByKey>[1]
    ): string[] => {
      return entriesByKey(map, order).map(([key]) => {
        return key;
      });
    };

    expect(keys({ '10': 0, '3': 0, '-1': 0 }, 'integer')).toEqual(['-1', '3', '10']);
    expect(keys({ true: 0, false: 0 }, 'bool')).toEqual(['false', 'true']);
    expect(keys({ '': 0, '😀': 0, zz: 0, a: 0 }, 'string')).toEqual(['a', 'zz', '', '😀']);
    expect(keys({}, 'string')).toEqual([]);
  });
});
