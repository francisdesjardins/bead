import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkBlueprintFile, checkRoots } from '../check.ts';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const COPY = fileURLToPath(new URL('../../test/proto/OPTIONS_COPY/', import.meta.url));

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
