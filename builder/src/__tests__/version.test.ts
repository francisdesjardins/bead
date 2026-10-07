import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { file, procedure, service } from '../generated/bead/options_pb.ts';
import { beadcVersion, OPTIONS_NUMBER, specUrlOf, specVersion, versionLines } from '../version.ts';

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/u;

test('every extension of bead/options.proto takes OPTIONS_NUMBER', () => {
  expect(
    [file, service, procedure].map((extension) => {
      return extension.number;
    })
  ).toEqual([OPTIONS_NUMBER, OPTIONS_NUMBER, OPTIONS_NUMBER]);
});

test("the spec's version is an x.y.z, and the interop's blueprint repeats it", () => {
  const blueprint = JSON.parse(readFileSync(specUrlOf('interop-blueprint.json'), 'utf8')) as {
    specVersion: string;
  };

  expect(specVersion()).toMatch(SEMANTIC_VERSION);
  expect(blueprint.specVersion).toBe(specVersion());
});

test("beadc's version is an x.y.z", () => {
  expect(beadcVersion()).toMatch(SEMANTIC_VERSION);
  expect(versionLines()[0]).toBe(`beadc ${beadcVersion()}`);
});
