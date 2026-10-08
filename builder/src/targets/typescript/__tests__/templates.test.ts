import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../../../model/blueprint.ts';
import { Messages } from '../options.ts';
import { typescriptTarget } from '../typescript.ts';

const INTEROP = new URL('../../../../../spec/interop-blueprint.json', import.meta.url);

const contentOf = (blueprint: IBlueprint): string => {
  const [file] = typescriptTarget.generate(
    { blueprint, sources: { blueprint: 'interop.json' } },
    {
      importExtension: 'none',
      runtime: '@francisdesjardins/bead/service',
      messages: Messages.GENERATE,
    }
  );

  return file?.content ?? '';
};

const patched = (change: (procedures: Record<string, unknown>[]) => void): IBlueprint => {
  const blueprint = JSON.parse(readFileSync(INTEROP, 'utf8')) as {
    services: { procedures: Record<string, unknown>[] }[];
  };

  change(blueprint.services[0]?.procedures ?? []);

  return blueprint as unknown as IBlueprint;
};

test("prints a procedure's deprecation and its payload limit in its procedure, as the runtime takes them", () => {
  const content = contentOf(
    patched(([echo, fail]) => {
      Object.assign(echo ?? {}, {
        deprecation: { message: "Use 'other', a\nline later." },
        maximumPayloadBytes: 1024,
      });
      Object.assign(fail ?? {}, { deprecation: {} });
    })
  );

  expect(content).toContain(
    "    procedure: { deprecation: { message: 'Use \\'other\\', a\\nline later.' }, maximumPayloadBytes: 1024, procedureId: 1, procedureName: 'echo', serviceId: 1, serviceRevision: 1 },\n"
  );
  expect(content).toContain(
    "    procedure: { deprecation: {}, procedureId: 2, procedureName: 'fail', serviceId: 1, serviceRevision: 1 },\n"
  );
});

test('takes its options as optional where no procedure names a hook, and required where one does', () => {
  const content = contentOf(
    patched((procedures) => {
      for (const procedure of procedures) {
        procedure['admission'] = 'none';
      }
    })
  );

  expect(contentOf(patched(() => {}))).toContain(
    '  public constructor(options: InteropServerOptions) {\n'
  );
  expect(content).toContain('  public constructor(options?: InteropServerOptions) {\n');
  expect(content).toContain('Its options, which name no hook.');
});

test('a client holds a requester of each procedure its server answers, and no command', () => {
  const content = contentOf(patched(() => {}));

  expect(content).toContain(
    "  public readonly echo: IServiceClient<typeof InteropProcedures>['request']['echo'];\n"
  );
  expect(content).not.toContain("['request']['clock']");
  expect(content).toContain('  clock: commandOf({\n');
});
