import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkBlueprintFile, checkRoots } from '../check.ts';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const COPY = fileURLToPath(new URL('../../test/proto/OPTIONS_COPY/', import.meta.url));
const PROTOVALIDATE = new URL('../../test/protovalidate/', import.meta.url);
const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));

test("checks the fixtures' roots, every service in one blueprint", () => {
  const checked = checkRoots([FIXTURES]);

  expect(checked.diagnostics).toEqual([]);
  expect(
    checked.blueprint?.services.map((service) => {
      return service.serviceName;
    })
  ).toEqual(['Interop', 'Comments', 'OldComments']);
  expect(checked.set?.length).toBeGreaterThan(0);
});

test('a copy of the options ends the check before buf compiles', () => {
  const checked = checkRoots([COPY]);

  expect(
    checked.diagnostics.map((diagnostic) => {
      return diagnostic.rule;
    })
  ).toEqual(['OPTIONS_COPY']);
  expect(checked.set).toBeUndefined();
});

test("checks a blueprint's file, read as bytes", () => {
  const checked = checkBlueprintFile(INTEROP, { file: 'spec/interop-blueprint.json' });

  expect(checked.diagnostics).toEqual([]);
  expect(checked.text?.startsWith('{\n  "format": "bead-blueprint/1"')).toBe(true);
});

test("buf's PROTOVALIDATE refuses incoherent rules, each buf's finding at buf's place, and beadc reads them no further", () => {
  const checked = checkRoots([fileURLToPath(PROTOVALIDATE)]);
  const expected = JSON.parse(
    readFileSync(new URL('expected.json', PROTOVALIDATE), 'utf8')
  ) as unknown;

  expect(
    checked.diagnostics.map((diagnostic) => {
      return { rule: diagnostic.rule, line: diagnostic.line, column: diagnostic.column };
    })
  ).toEqual(expected);
  expect(
    checked.diagnostics.map((diagnostic) => {
      return diagnostic.severity;
    })
  ).not.toContain('warning');
  expect(checked.blueprint).toBeUndefined();
});

test("spec/validations.proto passes, its every message's rules read, the feature validate required", () => {
  const checked = checkRoots([SPEC], { files: ['validations.proto'] });
  const ruled = (checked.blueprint?.proto?.messages ?? []).filter((message) => {
    return message.rules !== undefined;
  });

  expect(checked.diagnostics).toEqual([]);
  expect(checked.blueprint?.requires).toEqual(['validate']);
  expect(
    ruled.map((message) => {
      return message.fullName.split('.').at(-1);
    })
  ).toEqual([
    'Bytes',
    'Enums',
    'Floats',
    'Inner',
    'Maps',
    'Nested',
    'Numbers',
    'Oneofs',
    'Order',
    'Pair',
    'Patterns',
    'Presence',
    'Repeated',
    'Strings',
    'Wrappers',
  ]);
});
