import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../../compile.ts';
import { type IDiagnostic, InputError } from '../../diagnostics.ts';
import { displayOf, OPTIONS_FILE } from '../../roots.ts';
import { Category } from '../../rules.ts';
import { breaking, waiversOf } from '../breaking.ts';
import {
  BUF_CATEGORY,
  BUF_EXCEPTED,
  BUF_RULES,
  BUF_RULES_RUN,
  bufConfigOf,
  bufFindings,
} from '../buf.ts';

const PAIR = fileURLToPath(new URL('../../../test/breaking/buf/', import.meta.url));
const EARLIER = join(PAIR, 'earlier');
const CURRENT = join(PAIR, 'current');

// buf's breaking rules at its pin, as `buf config ls-breaking-rules` lists them
const bufRules = (): { id: string; deprecated: boolean; categories: string[] }[] => {
  const run = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('@bufbuild/buf/bin/buf'),
      'config',
      'ls-breaking-rules',
      '--version',
      'v2',
      '--format',
      'json',
    ],
    { encoding: 'utf8' }
  );

  expect(run.status, run.stderr).toBe(0);

  return run.stdout
    .trim()
    .split('\n')
    .map((line) => {
      return JSON.parse(line) as { id: string; deprecated: boolean; categories: string[] };
    });
};

test("buf's rules run once over the pair that breaks a field, by category, at the field's line", () => {
  test.setTimeout(60_000);

  const expected = JSON.parse(readFileSync(join(PAIR, 'expected.json'), 'utf8')) as Record<
    Category,
    unknown[]
  >;

  for (const category of Object.values(Category)) {
    const run = breaking({ proto: [CURRENT] }, { against: EARLIER, category });

    expect(
      run.diagnostics.map((diagnostic) => {
        return { rule: diagnostic.rule, line: diagnostic.line, column: diagnostic.column };
      }),
      category
    ).toEqual(expected[category]);
    expect(
      run.diagnostics.every((diagnostic) => {
        return diagnostic.file.endsWith('current/parcel/v1/parcel.proto');
      }),
      `${category}: each at the current's file`
    ).toBe(true);
  }
});

test("buf's except list is every RPC_ rule buf lists, and its SERVICE_NO_DELETE", () => {
  const keyedByName = bufRules()
    .map((rule) => {
      return rule.id;
    })
    .filter((id) => {
      return id.startsWith('RPC_') || id === 'SERVICE_NO_DELETE';
    });

  expect([...BUF_EXCEPTED].sort()).toEqual(keyedByName.sort());
});

test("BUF_RULES is buf's list at its pin", () => {
  expect([...BUF_RULES].sort()).toEqual(
    bufRules()
      .filter((rule) => {
        return !rule.deprecated;
      })
      .map((rule) => {
        return rule.id;
      })
      .sort()
  );
});

test('bead/options.proto and an import dropped are never compared', () => {
  test.setTimeout(60_000);

  const earlier = compile([EARLIER], { image: true });
  const current = fromBinary(FileDescriptorSetSchema, compile([CURRENT], { image: true }));
  const options = current.file.find((file) => {
    return file.name === OPTIONS_FILE;
  });
  const procedure = options?.messageType.find((message) => {
    return message.name === 'Procedure';
  });

  // * the current's own bead/options.proto loses a field, which buf would refuse anywhere else
  procedure?.field.pop();
  expect(procedure).toBeDefined();

  for (const category of Object.values(Category)) {
    expect(bufConfigOf(category)).toMatchObject({ breaking: { ignore: [OPTIONS_FILE] } });

    const found = bufFindings(toBinary(FileDescriptorSetSchema, current), {
      earlier,
      category,
      roots: [CURRENT],
    });

    expect(found.length, category).toBeGreaterThan(0);
    expect(
      found.filter((diagnostic) => {
        return /options|timestamp/u.test(
          `${diagnostic.diagnostic.file} ${diagnostic.diagnostic.message}`
        );
      }),
      category
    ).toEqual([]);
  }
});

test("BUF_RULES_RUN is what each category's use runs, at buf's pin", () => {
  const listed = bufRules();

  for (const category of Object.values(Category)) {
    expect([...BUF_RULES_RUN[category]].sort(), category).toEqual(
      listed
        .filter((rule) => {
          return !rule.deprecated && rule.categories.includes(BUF_CATEGORY[category]);
        })
        .map((rule) => {
          return rule.id;
        })
        .sort()
    );
  }
});

test("a buf: waiver waives under its file or its folder, as buf's ignore_only matches one, and names a rule its category runs", () => {
  test.setTimeout(60_000);

  const rulesOf = (except: readonly string[]): string[] => {
    return breaking(
      { proto: [CURRENT] },
      { against: EARLIER, category: Category.API, except }
    ).diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    });
  };

  for (const scope of ['parcel', 'parcel/', 'parcel/v1', 'parcel/v1/parcel.proto']) {
    expect(rulesOf([`buf:FIELD_SAME_TYPE@${scope}`]), scope).not.toContain('buf:FIELD_SAME_TYPE');
  }

  // * a scope at no part's boundary names no file of either side, and is refused
  expect(() => {
    return rulesOf(['buf:FIELD_SAME_TYPE@parcel/v']);
  }).toThrow(InputError);
  // a rule buf's FILE runs, which WIRE does not
  expect(() => {
    return waiversOf(['buf:FILE_SAME_GO_PACKAGE'], { category: Category.WIRE });
  }).toThrow("--except buf:FILE_SAME_GO_PACKAGE: a rule buf's WIRE does not run");
  expect(waiversOf(['buf:FILE_SAME_GO_PACKAGE'], { category: Category.API })).toHaveLength(1);
});

test("a file the current lost is placed at the earlier's path, which a buf: scope names", () => {
  test.setTimeout(60_000);

  const earlier = test.info().outputPath('earlier');
  const lost = join(earlier, 'parcel', 'v1', 'lost.proto');

  cpSync(EARLIER, earlier, { recursive: true });
  writeFileSync(
    lost,
    'syntax = "proto3";\n\npackage parcel.v1;\n\nmessage Lost {\n  string name = 1;\n}\n'
  );

  const found = (except: readonly string[]): IDiagnostic[] => {
    return breaking(
      { proto: [CURRENT] },
      { against: earlier, category: Category.API, except }
    ).diagnostics.filter((diagnostic) => {
      return diagnostic.rule === 'buf:FILE_NO_DELETE';
    });
  };

  expect(
    found([]).map((diagnostic) => {
      return diagnostic.file;
    })
  ).toEqual([displayOf(lost)]);
  expect(found(['buf:FILE_NO_DELETE@parcel/v1/lost.proto'])).toEqual([]);
});
