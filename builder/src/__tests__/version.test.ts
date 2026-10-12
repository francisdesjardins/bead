import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { file, procedure, service } from '../generated/bead/options_pb.ts';
import { protocPin } from '../protoc.ts';
import {
  beadcVersion,
  OPTIONS_NUMBER,
  PROTOBUF_FLOOR,
  protocLine,
  specUrlOf,
  specVersion,
  versionLines,
} from '../version.ts';
import { stubProtoc, withProtoc } from './pinned.ts';

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

test('names protoc at its pin, one of another version beside the pin, or none', () => {
  const pinned = protocPin().version;
  const folder = test.info().outputPath('stubs');

  expect(pinned).toMatch(/^\d+\.\d+$/u);
  expect(
    withProtoc(stubProtoc(`${folder}/pinned`, { version: pinned }), () => {
      return protocLine();
    })
  ).toBe(`protoc ${pinned}`);
  expect(
    withProtoc(stubProtoc(`${folder}/older`, { version: '35.1' }), () => {
      return protocLine();
    })
  ).toBe(`protoc 35.1, pinned ${pinned}`);
  expect(
    withProtoc(`${folder}/nowhere/protoc`, () => {
      return protocLine();
    })
  ).toBe(`protoc none, pinned ${pinned}`);
});

test("the goldens' floor type-check reads @bufbuild/protobuf at PROTOBUF_FLOOR", () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as {
    devDependencies: Record<string, string>;
  };

  expect(PROTOBUF_FLOOR).toMatch(SEMANTIC_VERSION);
  expect(manifest.devDependencies['@bufbuild/protobuf-floor']).toBe(
    `npm:@bufbuild/protobuf@${PROTOBUF_FLOOR}`
  );
});

test("beadc's version is an x.y.z", () => {
  expect(beadcVersion()).toMatch(SEMANTIC_VERSION);
  expect(versionLines()[0]).toBe(`beadc ${beadcVersion()}`);
});
