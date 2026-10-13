import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { hasError, type IDiagnostic, InputError } from '../../diagnostics.ts';
import { Category, Severity } from '../../rules.ts';
import { breaking, waiversOf } from '../breaking.ts';

const INTEROP = fileURLToPath(new URL('../../../../spec/interop-blueprint.json', import.meta.url));

// a blueprint as a value, its members as the interop's are
interface IValue {
  services: {
    serviceRevision: number;
    procedures: { procedureId: number; procedureName: string; deprecation?: object }[];
    reserved: { procedureIds: { first: number; last: number }[]; procedureNames: string[] };
  }[];
  reservedServices: { ids: { first: number; last: number }[]; names: string[] };
}

// the interop's blueprint, its text changed by `change`, in the running test's output folder
const interopWith = (name: string, change: (text: string) => string): string => {
  const path = test.info().outputPath(name);

  writeFileSync(path, change(readFileSync(INTEROP, 'utf8')));
  return path;
};

// the interop's blueprint, its value changed by `change`, in the running test's output folder
const blueprintWith = (name: string, change: (value: IValue) => void): string => {
  const value = JSON.parse(readFileSync(INTEROP, 'utf8')) as IValue;

  change(value);
  return interopWith(name, () => {
    return `${JSON.stringify(value, undefined, 2)}\n`;
  });
};

// fail and tick, procedures 2 and 11, swap their names, the revision moved: PROCEDURE_SAME_NAME at
// each, and their names neither theirs nor reserved
const swapped = (text: string): string => {
  return text
    .replace('"procedureName": "fail"', '"procedureName": "FAIL"')
    .replace('"procedureName": "tick"', '"procedureName": "fail"')
    .replace('"procedureName": "FAIL"', '"procedureName": "tick"')
    .replace('"serviceRevision": 1', '"serviceRevision": 2');
};

// each finding as its rule, then its subject or its pointer
const linesOf = (diagnostics: readonly IDiagnostic[]): string[] => {
  return diagnostics.map((diagnostic) => {
    return `${diagnostic.rule} ${diagnostic.subject ?? diagnostic.pointer ?? diagnostic.message}`;
  });
};

test('a current input check refuses is compared with nothing, exit 1', () => {
  // two names one as 16.6 folds them: NAME_UNIQUE; the earlier named is never read
  const refused = interopWith('refused.json', (text) => {
    return text.replace('"procedureName": "fail"', '"procedureName": "eCho"');
  });
  const run = breaking(
    { blueprint: refused },
    { against: 'no-such-earlier', category: Category.API }
  );

  expect(run.compared).toBe(false);
  expect(hasError(run.diagnostics)).toBe(true);
  expect(
    run.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['NAME_UNIQUE']);
});

test('a scoped waiver waives its subject and no other, each finding its own', () => {
  const current = interopWith('swapped.json', swapped);
  const linesFor = (except: readonly string[]): string[] => {
    return linesOf(
      breaking({ blueprint: current }, { against: INTEROP, category: Category.API, except })
        .diagnostics
    );
  };

  expect(linesFor([])).toEqual([
    'PROCEDURE_SAME_NAME service:1/procedure:2',
    'PROCEDURE_SAME_NAME service:1/procedure:11',
    'NAME_NO_DELETE service:1/procedure:2',
    'NAME_NO_DELETE service:1/procedure:11',
  ]);
  expect(linesFor(['PROCEDURE_SAME_NAME@service:1/procedure:2'])).toEqual([
    'PROCEDURE_SAME_NAME service:1/procedure:11',
    'NAME_NO_DELETE service:1/procedure:2',
    'NAME_NO_DELETE service:1/procedure:11',
  ]);
  expect(
    linesFor(['PROCEDURE_SAME_NAME@service:1/procedure:11', 'NAME_NO_DELETE@service:1/procedure:2'])
  ).toEqual(['PROCEDURE_SAME_NAME service:1/procedure:2', 'NAME_NO_DELETE service:1/procedure:11']);
  expect(linesFor(['PROCEDURE_SAME_NAME', 'NAME_NO_DELETE'])).toEqual([]);
});

test('a waiver by subject waives its entity alone, a deletion before it shifting nothing', () => {
  // * procedure 2 gone, its id reserved, every procedure after it a place earlier; procedures 4
  // and 6 renamed, the waiver written for 4's alone
  const current = blueprintWith('shifted.json', (value) => {
    const [service] = value.services;

    if (service === undefined) {
      throw new Error('the interop declares a service');
    }

    service.procedures = service.procedures.filter((procedure) => {
      return procedure.procedureId !== 2;
    });
    service.reserved.procedureIds.push({ first: 2, last: 2 });
    service.reserved.procedureNames.push('fail');
    service.serviceRevision = 2;

    for (const procedure of service.procedures) {
      procedure.procedureName =
        { 4: 'cancelled', 6: 'smashed' }[procedure.procedureId] ?? procedure.procedureName;
    }
  });
  const run = breaking(
    { blueprint: current },
    {
      against: INTEROP,
      category: Category.API,
      except: ['PROCEDURE_SAME_NAME@service:1/procedure:4', 'PROCEDURE_NO_DELETE'],
    }
  );

  expect(
    linesOf(run.diagnostics).filter((line) => {
      return line.startsWith('PROCEDURE_SAME_NAME');
    })
  ).toEqual(['PROCEDURE_SAME_NAME service:1/procedure:6']);
  // the renamed procedure the waiver names sits at /services/0/procedures/2 now, not /3
  expect(
    run.diagnostics.find((diagnostic) => {
      return diagnostic.subject === 'service:1/procedure:6';
    })?.pointer
  ).toBe('/services/0/procedures/4/procedureName');
});

test("a subject of another kind than the rule's is refused, exit 2", () => {
  for (const [given, form] of [
    ['PROCEDURE_SAME_NAME@service:1', 'service:<id>/procedure:<id>'],
    ['SERVICE_SAME_NAME@service:1/procedure:4', 'service:<id>'],
    ['SERVICE_SAME_HOOKS@service:1', 'service:<id>/hook:<name>'],
    ['FAILURE_NO_DELETE@service:1/procedure:4', 'service:<id>/failure:<code>'],
  ] as const) {
    expect(() => {
      return waiversOf([given], { category: Category.API });
    }).toThrow(`--except ${given}: a scope names one entity of the rule's kind, ${form}`);
  }

  // a subject off the grammar is refused alike, and a rule that finds no subject takes none
  for (const given of [
    'PROCEDURE_SAME_NAME@services/0/procedures/3',
    'PROCEDURE_SAME_NAME@service:0/procedure:4',
    'PROCEDURE_SAME_NAME@service:1/procedure:65536',
    'RESERVED_NO_DELETE@service:1/procedure:21-19',
    'PROCEDURE_SAME_NAME@service:1/procedure:4/',
    'PROTO_SKIPPED@service:1',
  ]) {
    expect(() => {
      return waiversOf([given], { category: Category.API });
    }, given).toThrow(InputError);
  }

  expect(
    waiversOf(
      [
        'NAME_NO_DELETE@service:1',
        'NAME_NO_DELETE@service:1/procedure:4',
        'NAME_NO_DELETE@service:1/failure:7',
        'RESERVED_NO_DELETE@service:1/procedure:19-21',
        'RESERVED_NO_DELETE@service:2-3',
        'RESERVED_NO_DELETE@service:1/name:fail',
        'RESERVED_NO_DELETE@name:Retired',
        'PROCEDURE_FAILURE_NO_DELETE@service:1/procedure:2/failure:7',
      ],
      { category: Category.API }
    )
  ).toHaveLength(8);
});

test("a reserved range is waived by the earlier's range, whatever part the current released", () => {
  const earlier = blueprintWith('earlier.json', (value) => {
    value.services[0]?.reserved.procedureIds.push({ first: 19, last: 21 });
  });

  // * one id of the range released, then the other end: the finding's subject is the earlier's
  // range both times, so the waiver written for the first stands for the second
  for (const [name, kept] of [
    ['narrowed.json', { first: 19, last: 20 }],
    ['other-end.json', { first: 20, last: 21 }],
  ] as const) {
    const current = blueprintWith(name, (value) => {
      value.services[0]?.reserved.procedureIds.push(kept);
    });
    const runWith = (except: readonly string[]): string[] => {
      return linesOf(
        breaking({ blueprint: current }, { against: earlier, category: Category.API, except })
          .diagnostics
      );
    };

    expect(runWith([]), name).toEqual([
      'RESERVED_NO_DELETE service:1/procedure:19-21',
      'SERVICE_REVISION service:1',
    ]);
    expect(
      runWith(['RESERVED_NO_DELETE@service:1/procedure:19-21', 'SERVICE_REVISION']),
      name
    ).toEqual([]);
  }
});

test("a deletion's subject is the earlier's", () => {
  // * procedure 18, the earlier's last, gone: no place in the current holds it, its subject does
  const current = blueprintWith('deleted.json', (value) => {
    value.services[0]?.procedures.pop();
  });
  const deleted = breaking(
    { blueprint: current },
    { against: INTEROP, category: Category.WIRE }
  ).diagnostics.find((diagnostic) => {
    return diagnostic.rule === 'PROCEDURE_NO_DELETE';
  });

  expect(deleted?.subject).toBe('service:1/procedure:18');
  expect(deleted?.pointer).toBe('/services/0/reserved/procedureIds');
});

test('a scope that is a pointer is refused, exit 2, naming the subject form', () => {
  for (const given of ['PROCEDURE_SAME_NAME@/services/0/procedures/3', 'PROCEDURE_SAME_NAME@']) {
    expect(() => {
      return waiversOf([given], { category: Category.API });
    }).toThrow(
      `--except ${given}: a scope names a finding's subject, as its line prints it, such as service:1/procedure:4; a pointer shifts`
    );
  }
});

test('a subject neither side holds is WAIVER_UNUSED, its message saying so', () => {
  const current = interopWith('swapped.json', swapped);
  const run = breaking(
    { blueprint: current },
    {
      against: INTEROP,
      category: Category.API,
      except: [
        'PROCEDURE_SAME_NAME',
        'NAME_NO_DELETE',
        'PROCEDURE_SAME_NAME@service:1/procedure:40',
        'PROCEDURE_SAME_KIND@service:1/procedure:4',
      ],
    }
  );

  expect(run.diagnostics).toEqual([
    {
      rule: 'WAIVER_UNUSED',
      severity: Severity.WARNING,
      message:
        '--except PROCEDURE_SAME_NAME@service:1/procedure:40 waived nothing, and neither side holds it: take it out',
      file: expect.any(String),
    },
    {
      rule: 'WAIVER_UNUSED',
      severity: Severity.WARNING,
      message: '--except PROCEDURE_SAME_KIND@service:1/procedure:4 waived nothing: take it out',
      file: expect.any(String),
    },
  ]);
});

test('a waiver that waived nothing is WAIVER_UNUSED, a warning, over a bare, a scoped and a buf: waiver', () => {
  const run = breaking(
    { blueprint: INTEROP },
    {
      against: INTEROP,
      category: Category.API,
      except: [
        'NOTIFICATION_RESULT',
        'PROCEDURE_SAME_NAME@service:1/procedure:4',
        'buf:FIELD_SAME_TYPE',
      ],
    }
  );

  expect(run.compared).toBe(true);
  expect(hasError(run.diagnostics)).toBe(false);
  expect(linesOf(run.diagnostics)).toEqual([
    'WAIVER_UNUSED --except NOTIFICATION_RESULT waived nothing: take it out',
    'WAIVER_UNUSED --except PROCEDURE_SAME_NAME@service:1/procedure:4 waived nothing: take it out',
    'WAIVER_UNUSED --except buf:FIELD_SAME_TYPE waived nothing: take it out',
  ]);
});

test('--except WAIVER_UNUSED is refused', () => {
  for (const given of ['WAIVER_UNUSED', 'WAIVER_UNUSED@service:1']) {
    expect(() => {
      return waiversOf([given], { category: Category.API });
    }).toThrow(`--except ${given}: a waiver that waived nothing is taken out, never waived`);
  }
});

test('a deletion waived, then the release compared with itself, is WAIVER_UNUSED, a warning, never exit 2', () => {
  // * the waiver a release's cycle carried: procedure 18, deprecated, taken out and its id and name
  // reserved, which API finds; then, on the release's own commit, the release against itself, where
  // the waiver waives nothing and is said, never refused
  const earlier = blueprintWith('deprecated.json', (value) => {
    const last = value.services[0]?.procedures.at(-1);

    if (last !== undefined) {
      last.deprecation = {};
    }
  });
  const current = blueprintWith('released.json', (value) => {
    const [service] = value.services;

    service?.procedures.pop();
    service?.reserved.procedureIds.push({ first: 18, last: 18 });
    service?.reserved.procedureNames.push('endSessionsOf');

    if (service !== undefined) {
      service.serviceRevision = 2;
    }
  });
  const except = ['PROCEDURE_NO_DELETE@service:1/procedure:18'];

  expect(
    breaking({ blueprint: current }, { against: earlier, category: Category.API, except })
      .diagnostics
  ).toEqual([]);

  const again = breaking(
    { blueprint: current },
    { against: current, category: Category.API, except }
  ).diagnostics;

  expect(
    again.map((diagnostic) => {
      return `${diagnostic.rule} ${diagnostic.severity}`;
    })
  ).toEqual(['WAIVER_UNUSED warning']);
  expect(again[0]?.message).toBe(
    '--except PROCEDURE_NO_DELETE@service:1/procedure:18 waived nothing: take it out'
  );
});
