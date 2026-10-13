import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import type { IDiagnostic } from '../../diagnostics.ts';
import { checkValue, type IBlueprint, type PlaceOf, readBlueprint } from '../../model/blueprint.ts';
import { formOf } from '../../model/form.ts';
import { applyPatch, type IOperation, type IVerdict } from '../../model/__tests__/patch.ts';
import { Category, type IRule, isRuleName, RULES, type RuleName } from '../../rules.ts';
import { againstOfFolder, type IEarlier } from '../against.ts';
import { breaking } from '../breaking.ts';
import { compareBlueprints, messageIndexOf } from '../compare.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);
const COMMENTS = new URL('../../../test/golden/comments.blueprint.json', import.meta.url);
const MESSAGES = fileURLToPath(new URL('../../../test/messages/', import.meta.url));
const CASES = fileURLToPath(new URL('../../../test/breaking/', import.meta.url));
const PROTO_CASES = join(CASES, 'proto');
const SHARED_EARLIER = join(PROTO_CASES, 'earlier');

// a case of test/breaking/<RULE>/: the patches of each side, its category, and its findings there
interface IBreakingCase {
  readonly rule: string;
  readonly name: string;
  readonly category: Category;
  readonly earlier: readonly IOperation[];
  readonly current: readonly IOperation[];
  readonly findings: readonly IVerdict[];
}

// a finding of a .proto case: its rule, at its line and column
interface IProtoVerdict {
  readonly rule: string;
  readonly line?: number;
  readonly column?: number;
}

const interop = (): unknown => {
  return JSON.parse(readFileSync(INTEROP, 'utf8'));
};

const breakingCases = (): IBreakingCase[] => {
  return readdirSync(CASES)
    .filter(isRuleName)
    .flatMap((rule) => {
      return readdirSync(join(CASES, rule)).map((file) => {
        const read = JSON.parse(readFileSync(join(CASES, rule, file), 'utf8')) as {
          category?: Category;
          earlier?: IOperation[];
          current: IOperation[];
          findings: IVerdict[];
        };

        return {
          rule,
          name: file.replace(/\.json$/u, ''),
          category: read.category ?? Category.API,
          earlier: read.earlier ?? [],
          current: read.current,
          findings: read.findings,
        };
      });
    });
};

// the current side read as a blueprint's text in its form, `check` passing it
const currentOf = (value: unknown): { blueprint: IBlueprint; placeOf: PlaceOf } => {
  const reading = readBlueprint(new TextEncoder().encode(formOf(value)), { file: 'current.json' });

  expect(reading.diagnostics).toEqual([]);

  if (reading.blueprint === undefined || reading.placeOf === undefined) {
    throw new Error('the current side is a blueprint check takes');
  }

  return { blueprint: reading.blueprint, placeOf: reading.placeOf };
};

// the earlier side as its patch leaves it, its members and arrays in their order, `check` passing it
const earlierOf = (value: unknown): IBlueprint => {
  const reading = checkValue(value, {
    placeOf: (pointer) => {
      return { file: 'earlier.json', pointer };
    },
  });

  expect(reading.diagnostics).toEqual([]);

  if (reading.blueprint === undefined) {
    throw new Error('the earlier side is a blueprint check takes');
  }

  return reading.blueprint;
};

const verdictsOf = (diagnostics: readonly IDiagnostic[]): IVerdict[] => {
  return diagnostics.map((diagnostic) => {
    return { rule: diagnostic.rule, pointer: diagnostic.pointer ?? '' };
  });
};

const protoVerdictsOf = (diagnostics: readonly IDiagnostic[]): IProtoVerdict[] => {
  return diagnostics.map((diagnostic) => {
    return {
      rule: diagnostic.rule,
      ...(diagnostic.line === undefined
        ? {}
        : { line: diagnostic.line, column: diagnostic.column }),
    };
  });
};

// a case's findings under `category`
const runCase = (each: IBreakingCase, category: Category): IDiagnostic[] => {
  const { blueprint, placeOf } = currentOf(applyPatch(interop(), each.current));

  return compareBlueprints(blueprint, {
    earlier: earlierOf(applyPatch(interop(), each.earlier)),
    category,
    placeOf,
  });
};

// spec 16.8: an id or a name a release declared stays its declaration's, or is reserved, and the
// cases find each change between two releases that would part them
test('each case of test/breaking/ gives its rules at their pointers, under its category', () => {
  const cases = breakingCases();

  expect(cases.length).toBeGreaterThan(0);

  for (const each of cases) {
    expect(verdictsOf(runCase(each, each.category)), `${each.rule}/${each.name}`).toEqual(
      each.findings
    );
  }
});

test("a WIRE case's findings under API hold its findings under WIRE", () => {
  for (const each of breakingCases()) {
    const wire = verdictsOf(runCase(each, Category.WIRE));
    const api = verdictsOf(runCase(each, Category.API));

    expect(api, `${each.rule}/${each.name}`).toEqual(expect.arrayContaining(wire));
    expect(
      wire.every((verdict) => {
        const rule: IRule = RULES[verdict.rule as RuleName];

        return rule.category === Category.WIRE;
      }),
      `${each.rule}/${each.name}: WIRE runs its own rules alone`
    ).toBe(true);
  }
});

test("a blueprint against itself finds nothing: the interop's, the comments fixture's, the messages fixture's", () => {
  test.setTimeout(60_000);

  for (const url of [INTEROP, COMMENTS]) {
    const { blueprint, placeOf } = currentOf(JSON.parse(readFileSync(url, 'utf8')));

    expect(
      compareBlueprints(blueprint, { earlier: blueprint, category: Category.API, placeOf })
    ).toEqual([]);
  }

  const messages = checkRoots([MESSAGES], { image: true });

  if (
    messages.blueprint === undefined ||
    messages.placeOf === undefined ||
    messages.set === undefined
  ) {
    throw new Error('the messages fixture compiles');
  }

  const index = messageIndexOf(messages.set);

  expect(index.size).toBeGreaterThan(0);
  expect(
    compareBlueprints(messages.blueprint, {
      earlier: messages.blueprint,
      category: Category.API,
      placeOf: messages.placeOf,
      messages: { earlier: index, current: messageIndexOf(messages.set) },
    })
  ).toEqual([]);
});

test("a deletion is placed at the reservation that would waive it, naming the earlier's pointer", () => {
  const deletions = [
    ['SERVICE_NO_DELETE', 'a-service-gone', '/reservedServices/ids', '/services/1'],
    [
      'PROCEDURE_NO_DELETE',
      'a-procedure-gone',
      '/services/0/reserved/procedureIds',
      '/services/0/procedures/7',
    ],
    [
      'FAILURE_NO_DELETE',
      'a-failure-gone',
      '/services/0/reserved/failureCodes',
      'failure 8 REGISTERED_ALREADY',
    ],
  ] as const;

  for (const [rule, name, pointer, earlier] of deletions) {
    const each = breakingCases().find((one) => {
      return one.rule === rule && one.name === name;
    });

    if (each === undefined) {
      throw new Error(`${rule}/${name} is a case`);
    }

    const [finding] = runCase(each, Category.WIRE);

    expect(finding?.rule).toBe(rule);
    expect(finding?.pointer).toBe(pointer);
    expect(finding?.message).toContain(earlier);
  }
});

test('a procedure or a service gone, deprecated then reserved, passes WIRE, and under API is its deletion, its generated code named', () => {
  const gone = [
    ['PROCEDURE_NO_DELETE', 'deprecated-by-its-service-then-reserved-under-api', 'its requester'],
    ['SERVICE_NO_DELETE', 'deprecated-then-its-id-and-name-reserved-under-api', 'its generated'],
  ] as const;

  for (const [rule, name, named] of gone) {
    const each = breakingCases().find((one) => {
      return one.rule === rule && one.name === name;
    });

    if (each === undefined) {
      throw new Error(`${rule}/${name} is a case`);
    }

    const [finding, ...others] = runCase(each, Category.API);

    expect(runCase(each, Category.WIRE), `${rule}/${name} under WIRE`).toEqual([]);
    expect(others, `${rule}/${name}`).toEqual([]);
    expect(finding?.rule).toBe(rule);
    expect(finding?.message).toContain(`deprecated and its id reserved: ${named}`);
    expect(finding?.message).toContain('take it out in a release that moves the major');
  }
});

test('a revision is read through the model: an earlier in another form changes nothing', () => {
  // every object's members in reverse, every array of entries in reverse: a blueprint no form writes
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(reversed).reverse();
    }

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, member]) => {
            return [key, reversed(member)];
          })
      );
    }

    return value;
  };
  const text = JSON.stringify(reversed(interop()), null, 4);
  const earlier = readBlueprint(new TextEncoder().encode(text), {
    file: 'earlier.json',
    rules: false,
  });
  const { blueprint, placeOf } = currentOf(interop());

  expect(text).not.toBe(formOf(interop()));
  expect(earlier.blueprint).toBeDefined();
  expect(
    compareBlueprints(blueprint, {
      earlier: earlier.blueprint as IBlueprint,
      category: Category.API,
      placeOf,
    })
  ).toEqual([]);

  const described = applyPatch(interop(), [
    { op: 'add', path: '/services/0/description', value: 'Described anew.' },
    { op: 'replace', path: '/services/0/failures/0/description', value: 'Described anew.' },
  ]);

  expect(
    compareBlueprints(currentOf(described).blueprint, {
      earlier: earlier.blueprint as IBlueprint,
      category: Category.API,
      placeOf,
    })
  ).toEqual([]);
});

test('each .proto case gives its rules at their lines and columns', () => {
  test.setTimeout(60_000);

  const rules = readdirSync(PROTO_CASES).filter(isRuleName);
  const shared = againstOfFolder(SHARED_EARLIER, {
    current: { proto: [SHARED_EARLIER] },
    name: 'earlier',
  });

  expect(rules.length).toBeGreaterThan(0);

  for (const rule of rules) {
    for (const name of readdirSync(join(PROTO_CASES, rule))) {
      const folder = join(PROTO_CASES, rule, name);
      const root = join(folder, 'current');
      const own = join(folder, 'earlier');
      const source = { proto: [root] };
      const earlier: IEarlier = existsSync(own)
        ? againstOfFolder(own, { current: source, name: 'earlier' })
        : shared;
      const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as Record<
        Category,
        IProtoVerdict[]
      >;
      const current = checkRoots([root], { image: true });

      expect(current.diagnostics, `${rule}/${name}`).toEqual([]);

      if (
        current.blueprint === undefined ||
        current.placeOf === undefined ||
        current.set === undefined
      ) {
        throw new Error(`${rule}/${name}: its current compiles`);
      }

      for (const category of Object.values(Category)) {
        // * buf's half runs once, over buf's pair: an earlier that compiled gives Bead's rules alone
        const found =
          earlier.image === undefined
            ? breaking(source, { against: own, category }).diagnostics
            : compareBlueprints(current.blueprint, {
                earlier: earlier.blueprint,
                category,
                placeOf: current.placeOf,
                messages: {
                  earlier: messageIndexOf(earlier.image),
                  current: messageIndexOf(current.set),
                },
              });

        expect(protoVerdictsOf(found), `${rule}/${name} under ${category}`).toEqual(
          expected[category]
        );
        expect(
          found.some((diagnostic) => {
            return diagnostic.line === 1 && diagnostic.column === 1;
          }),
          `${rule}/${name}: none at the file's 1:1`
        ).toBe(false);
      }
    }
  }
});
