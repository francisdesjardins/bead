import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { Messages } from '../../target.ts';
import { DEFAULT_PROTO_RUNTIME, DEFAULT_RUNTIME, IMPORT_EXTENSIONS } from '../options.ts';

const PACKAGE = new URL('../../../../../implementations/typescript/package.json', import.meta.url);

test("the default runtime is the service layer the TypeScript side's package exports", () => {
  const declared = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    name: string;
    exports: Record<string, string>;
  };
  const subpath = DEFAULT_RUNTIME.slice(declared.name.length);

  expect(DEFAULT_RUNTIME.startsWith(`${declared.name}/`)).toBe(true);
  expect(declared.exports[`.${subpath}`]).toBe('./src/service/service.ts');
});

test("the default module of the proto check is the subpath the TypeScript side's package exports for it", () => {
  const declared = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    name: string;
    exports: Record<string, string>;
  };
  const subpath = DEFAULT_PROTO_RUNTIME.slice(declared.name.length);

  expect(DEFAULT_PROTO_RUNTIME.startsWith(`${declared.name}/`)).toBe(true);
  expect(declared.exports[`.${subpath}`]).toBe('./src/proto/proto.ts');
});

test("an output's extensions and messages, in beadc.yaml's words", () => {
  expect(IMPORT_EXTENSIONS).toEqual(['none', 'js', 'ts']);
  expect(Object.values(Messages)).toEqual(['generate', 'external']);
});
