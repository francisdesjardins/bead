import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../blueprint.ts';
import { checkBlueprint } from '../check-blueprint.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

const interop = (): IBlueprint => {
  return JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint;
};

const placeOf = (pointer: string): { file: string; pointer: string } => {
  return { file: 'case.json', pointer };
};

const rulesOf = (blueprint: IBlueprint): string[] => {
  return checkBlueprint(blueprint, { placeOf }).map((diagnostic) => {
    return `${diagnostic.rule} ${diagnostic.pointer ?? ''}`;
  });
};

test("the interop's blueprint spans no rule", () => {
  expect(rulesOf(interop())).toEqual([]);
});

test('one hook named twice is one hook, and two hooks one folded are refused', () => {
  const blueprint = structuredClone(interop()) as unknown as {
    services: { procedures: { admission: unknown }[] }[];
  };
  const procedures = blueprint.services[0]?.procedures ?? [];

  (procedures[0] as { admission: unknown }).admission = { hook: 'nobody' };
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([]);

  (procedures[1] as { admission: unknown }).admission = { hook: 'noBody' };
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([
    'NAME_UNIQUE /services/0/procedures/1/admission/hook',
  ]);
});

test('a proto binding whose message proto lists passes, and one it does not list is BINDING_SOURCE', () => {
  const blueprint = structuredClone(interop()) as unknown as Record<string, unknown> & {
    services: { procedures: { request: unknown }[] }[];
  };
  const [procedure] = blueprint.services[0]?.procedures ?? [];

  (procedure as { request: unknown }).request = { encoding: 'proto', message: 'x.v1.Request' };
  blueprint['proto'] = {
    files: [{ path: 'x.proto', package: 'x.v1' }],
    messages: [{ fullName: 'x.v1.Request', file: 'x.proto' }],
  };
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([]);

  blueprint['proto'] = { files: [], messages: [] };
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([
    'BINDING_SOURCE /services/0/procedures/0/request',
  ]);
});
