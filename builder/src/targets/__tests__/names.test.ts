import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../../model/blueprint.ts';
import { checkBlueprint } from '../../model/check-blueprint.ts';
import {
  C_SHARP_OBJECT_MEMBERS,
  classNamesOf,
  csharpNameOfFailure,
  RUNTIME_TYPES,
  TYPESCRIPT_PROCEDURE_NAMES,
} from '../names.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

// a procedure's name, spec 16.4: a lower-case ASCII letter, then 62 ASCII letters or digits at most
const PROCEDURE_NAME = /^[a-z][A-Za-z0-9]{0,62}$/u;

const interop = (): IBlueprint => {
  return JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint;
};

const findingsOf = (blueprint: IBlueprint): string[] => {
  return checkBlueprint(blueprint, {
    placeOf: (pointer) => {
      return { file: 'case.json', pointer };
    },
  }).map((diagnostic) => {
    return `${diagnostic.rule} ${diagnostic.pointer ?? ''}`;
  });
};

test("a service's classes, in every official target", () => {
  expect(classNamesOf('Interop')).toEqual([
    'InteropProcedures',
    'InteropFailures',
    'InteropServer',
    'InteropServerOptions',
    'InteropClient',
    'InteropClientOptions',
    'InteropResolvers',
    'InteropAdmissions',
    'InteropWindows',
  ]);
});

test("a failure's C# name: its words, each its first letter kept", () => {
  expect(csharpNameOfFailure('ON_PURPOSE')).toBe('OnPurpose');
  expect(csharpNameOfFailure('A_B1')).toBe(csharpNameOfFailure('A_B_1'));
  expect(csharpNameOfFailure('CODE')).toBe('Code');
});

test('the names each target reserves', () => {
  expect(TYPESCRIPT_PROCEDURE_NAMES.has('then')).toBe(true);
  expect(C_SHARP_OBJECT_MEMBERS.has('GetHashCode')).toBe(true);
  expect(RUNTIME_TYPES.has('HttpServer')).toBe(true);
});

test("refuses Object.prototype's seven names and the two classes a TypeScript service adds", () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype).filter((name) => {
    return PROCEDURE_NAME.test(name);
  });

  expect(prototypeNames).toHaveLength(7);

  for (const name of prototypeNames) {
    const blueprint = structuredClone(interop()) as unknown as {
      services: { procedures: { procedureName: string }[] }[];
    };
    const [procedure] = blueprint.services[0]?.procedures ?? [];

    (procedure as { procedureName: string }).procedureName = name;

    expect(findingsOf(blueprint as unknown as IBlueprint), name).toEqual([
      'NAME_TARGET /services/0/procedures/0/procedureName',
    ]);
  }

  const blueprint = structuredClone(interop()) as unknown as Record<string, unknown>;

  blueprint['proto'] = {
    files: [{ path: 'x.proto', package: 'x.v1' }],
    messages: [
      { fullName: 'x.v1.InteropClientOptions', file: 'x.proto' },
      { fullName: 'x.v1.InteropResolvers', file: 'x.proto' },
    ],
  };

  const diagnostics = checkBlueprint(blueprint as unknown as IBlueprint, {
    placeOf: (pointer) => {
      return { file: 'case.json', pointer };
    },
  });

  expect(
    diagnostics.map((diagnostic) => {
      return `${diagnostic.rule} ${diagnostic.pointer ?? ''}`;
    })
  ).toEqual(['NAME_TARGET /services/0/serviceName']);
  expect(diagnostics[0]?.message).toContain('InteropClientOptions, InteropResolvers');
});
