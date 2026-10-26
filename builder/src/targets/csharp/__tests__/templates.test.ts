import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../../../model/blueprint.ts';
import { Messages } from '../../target.ts';
import { csharpTarget } from '../csharp.ts';

const INTEROP = new URL('../../../../../spec/interop-blueprint.json', import.meta.url);

const contentOf = (blueprint: IBlueprint): string => {
  const [file] = csharpTarget.generate(
    { blueprint, sources: { blueprint: 'interop.json' } },
    { namespace: 'Bead.Interop', messages: Messages.GENERATE }
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
        deprecation: { message: 'Use "other", a\nline later.' },
        maximumPayloadBytes: 1024,
      });
      Object.assign(fail ?? {}, { deprecation: {} });
    })
  );

  expect(content).toContain(
    '        new global::Bead.Procedure { ServiceId = 1, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 2, MaximumPayloadBytes = 1024, Deprecation = new global::Bead.ProcedureDeprecation { Message = "Use \\"other\\", a\\nline later." } },\n'
  );
  expect(content).toContain(
    '        new global::Bead.Procedure { ServiceId = 1, ProcedureId = 2, ProcedureName = "fail", ServiceRevision = 2, Deprecation = new global::Bead.ProcedureDeprecation() },\n'
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
  const hooked = contentOf(patched(() => {}));

  expect(hooked).toContain(
    '    public InteropServer(global::Bead.ServiceServerOptions<InteropProcedures> options)\n    {\n'
  );
  expect(hooked).not.toContain('    public InteropServer()\n');
  expect(hooked).toContain(
    '    public required global::Bead.AdmissionHook Nobody { get; init; }\n'
  );
  expect(content).toContain(
    '    public InteropServer()\n        : this(new global::Bead.ServiceServer<InteropProcedures, TData>(InteropProcedures.All))\n'
  );
  expect(content).toContain(
    '    public InteropServer(global::Bead.ServiceServerOptions<InteropProcedures> options)\n        : this(new global::Bead.ServiceServer<InteropProcedures, TData>(InteropProcedures.All, options))\n'
  );
  expect(content).toContain(
    'public sealed class InteropAdmissions : global::Bead.IServiceAdmissions<InteropProcedures>\n{\n    global::'
  );
});

test('a client holds a requester of each procedure its server answers, and no command', () => {
  const content = contentOf(patched(() => {}));

  expect(content).toContain(
    '    public global::System.Func<global::System.Text.Json.JsonElement, global::Bead.BoundCall<global::System.Text.Json.JsonElement>> Echo { get; }\n'
  );
  expect(content).toContain('        Echo = _service.RequesterOf(InteropProcedures.Echo);\n');
  expect(content).not.toContain('_service.RequesterOf(InteropProcedures.Clock)');
  expect(content).toContain('            Clock = _service.CommandOf(InteropProcedures.Clock),\n');
});
