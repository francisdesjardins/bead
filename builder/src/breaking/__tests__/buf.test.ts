import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../../compile.ts';
import { OPTIONS_FILE } from '../../roots.ts';
import { Category } from '../../rules.ts';
import { breaking } from '../breaking.ts';
import { BUF_EXCEPTED, BUF_RULES, bufConfigOf, bufFindings } from '../buf.ts';

const PAIR = fileURLToPath(new URL('../../../test/breaking/buf/', import.meta.url));
const EARLIER = join(PAIR, 'earlier');
const CURRENT = join(PAIR, 'current');

// buf's breaking rules at its pin, as `buf config ls-breaking-rules` lists them
const bufRules = (): { id: string; deprecated: boolean }[] => {
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
      return JSON.parse(line) as { id: string; deprecated: boolean };
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
        return /options|timestamp/u.test(`${diagnostic.file} ${diagnostic.message}`);
      }),
      category
    ).toEqual([]);
  }
});
