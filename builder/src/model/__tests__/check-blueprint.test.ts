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

test('reserves TypeScript subscription members for each notifying procedure', () => {
  const blueprint = interop();
  const [service] = blueprint.services;
  const request = service?.procedures.find((procedure) => {
    return procedure.procedureKind === 'request';
  });

  if (service === undefined || request === undefined) {
    throw new Error('the interop blueprint declares a requesting service');
  }

  for (const notifying of service.procedures.filter((procedure) => {
    return procedure.procedureKind === 'notifies';
  })) {
    const name = `subscribe${notifying.procedureName[0]?.toUpperCase()}${notifying.procedureName.slice(1)}`;
    const changed = {
      ...blueprint,
      services: [
        {
          ...service,
          procedures: [
            ...service.procedures,
            { ...request, procedureId: 65_535, procedureName: name },
          ],
        },
      ],
    };
    const findings = checkBlueprint(changed, { placeOf });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'NAME_TARGET',
      pointer: `/services/0/procedures/${String(service.procedures.length)}/procedureName`,
      message: `${name} is a member TypeScript's generated client holds already`,
    });
  }
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

test('a description holding a character no XML document holds is DESCRIPTION_TARGET, wherever it is', () => {
  const blueprint = structuredClone(interop()) as unknown as {
    services: {
      description?: string;
      failures: { description?: string }[];
      procedures: { description?: string }[];
    }[];
  };
  const [service] = blueprint.services;

  if (service === undefined) {
    throw new Error("the interop's blueprint declares a service");
  }

  // tab, LF, CR, DEL and C#'s other line ends are XML's: the C# target writes them, by reference
  service.description = 'A tab\t, a line\nanother, a return\r, \u007F, \u0085, \u2028 and \u2029.';
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([]);

  service.description = 'A form feed\f.';
  (service.procedures[2] as { description?: string }).description = 'A NUL\u0000.';
  (service.failures[1] as { description?: string }).description = 'Not a character: \uFFFF.';
  expect(rulesOf(blueprint as unknown as IBlueprint)).toEqual([
    'DESCRIPTION_TARGET /services/0/description',
    'DESCRIPTION_TARGET /services/0/failures/1/description',
    'DESCRIPTION_TARGET /services/0/procedures/2/description',
  ]);
});
