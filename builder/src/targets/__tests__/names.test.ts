import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../../model/blueprint.ts';
import { checkBlueprint } from '../../model/check-blueprint.ts';
import {
  C_SHARP_OBJECT_MEMBERS,
  classNamesOf,
  csharpNameOfFailure,
  csharpNamespaceOf,
  pascalOf,
  RUNTIME_TYPES,
  TYPESCRIPT_PROCEDURE_NAMES,
  xmlExcludedOf,
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
    'InteropCommands',
    'InteropNotifiers',
    'InteropNotifications',
    'InteropHttpClient',
  ]);
});

test("a C# namespace and a file's name, as protoc's C# generator gives them", () => {
  expect(csharpNamespaceOf('bead.messages.v1')).toBe('Bead.Messages.V1');
  expect(csharpNamespaceOf('acme.greeter_api.v1beta1')).toBe('Acme.GreeterApi.V1Beta1');
  expect(csharpNamespaceOf('bead', 'Bead.Protobuf')).toBe('Bead.Protobuf');
  expect(csharpNamespaceOf('x.v1', '')).toBe('X.V1');
  expect(pascalOf('messages')).toBe('Messages');
  expect(pascalOf('greeter_service_v2')).toBe('GreeterServiceV2');
  expect(pascalOf('HTTP_rules')).toBe('HTTPRules');
  expect(pascalOf('a.b')).toBe('AB');
});

test('the characters no XML document holds, raw or by reference', () => {
  for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0xfffe, 0xffff]) {
    const character = String.fromCodePoint(code);

    expect(xmlExcludedOf(`a${character}b`), code.toString(16)).toBe(character);
  }

  expect(xmlExcludedOf('a tab\t, a line\n, a return\r, \u007F, \u0085, \u2028 and 😀')).toBe(
    undefined
  );
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

test('refuses a procedure named as its HTTP client or a generated subscription method', () => {
  const blueprint = interop();
  const changed = structuredClone(blueprint) as unknown as {
    services: { procedures: { procedureName: string; procedureKind: string }[] }[];
  };
  const service = changed.services[0];
  if (service === undefined) {
    throw new Error('the interop holds a service');
  }
  const notifying = service.procedures.find((procedure) => {
    return procedure.procedureKind === 'notifies';
  });
  const request = service.procedures[0];
  if (notifying === undefined || request === undefined) {
    throw new Error('the interop holds requests and notifications');
  }
  request.procedureName = `subscribe${notifying.procedureName[0]?.toUpperCase() ?? ''}${notifying.procedureName.slice(1)}`;
  expect(findingsOf(changed as unknown as IBlueprint)).toContain(
    'NAME_TARGET /services/0/procedures/0/procedureName'
  );
  request.procedureName = 'interopHttpClient';
  expect(findingsOf(changed as unknown as IBlueprint)).toContain(
    'NAME_TARGET /services/0/procedures/0/procedureName'
  );
});

test('refuses a hook and a failure named as the C# class they sit in', () => {
  const blueprint = structuredClone(interop()) as unknown as {
    services: {
      failures: { failureName: string }[];
      procedures: { admission: unknown; failures: string[] }[];
    }[];
  };
  const [service] = blueprint.services;

  if (service === undefined) {
    throw new Error("the interop's blueprint declares a service");
  }

  const { procedures } = service;

  (procedures[4] as { admission: unknown }).admission = { hook: 'interopAdmissions' };
  (service.failures[0] as { failureName: string }).failureName = 'FAIL';
  (procedures[1] as { failures: string[] }).failures = ['FAIL'];
  (procedures[9] as { failures: string[] }).failures = ['FAIL'];

  expect(findingsOf(blueprint as unknown as IBlueprint)).toEqual([
    'NAME_TARGET /services/0/procedures/1/failures/0',
    'NAME_TARGET /services/0/procedures/4/admission/hook',
  ]);
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
