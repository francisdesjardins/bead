import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../../../model/blueprint.ts';
import { documentOf } from '../../../openapi/document.ts';
import { Messages } from '../../target.ts';
import { csharpTarget } from '../csharp.ts';
import { HTTP_FILE } from '../http.ts';

const INTEROP = new URL('../../../../../spec/interop-blueprint.json', import.meta.url);

const interop = (): IBlueprint => {
  return JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint;
};

test("writes BeadHttp.cs beside the first service's file, in its namespace: each procedure a client calls by its descriptor's Procedure, a native payload by its encoding, its catalogue, its routes, the document a UTF-8 literal", () => {
  const blueprint = interop();
  const document = documentOf(blueprint);
  const written = csharpTarget.generate(
    { blueprint, sources: { blueprint: 'spec/interop-blueprint.json' } },
    {
      namespace: 'Bead.Interop',
      messages: Messages.GENERATE,
      http: { prefix: '/api', document, problemTypes: 'https://example.com/problems/' },
    }
  );
  const names = written.map((file) => {
    return file.name;
  });
  const table = written.find((file) => {
    return file.name === HTTP_FILE;
  })?.content;

  expect(names).toEqual(['InteropBead.cs', HTTP_FILE]);
  expect(table).toContain('namespace Bead.Interop;');
  expect(table).toContain(
    [
      '        new global::Bead.Transcoding.HttpRoute',
      '        {',
      '            Procedure = global::Bead.Interop.InteropProcedures.Echo.Procedure,',
      '            Request = global::Bead.Transcoding.HttpPayload.Json,',
      '            Result = global::Bead.Transcoding.HttpPayload.Json,',
      '            Failures = new global::System.Collections.Generic.Dictionary<string, int>',
      '            {',
      '                ["ON_PURPOSE"] = 7,',
      '                ["REGISTERED_ALREADY"] = 8,',
      '            },',
      '            Routes =',
      '            [',
      '                new global::Bead.Transcoding.HttpRouteTemplate { Method = "POST", Template = "/api/Interop/echo", Body = "*" },',
      '            ],',
      '        },',
    ].join('\n')
  );
  expect(table).toContain('            Notification = global::Bead.Transcoding.HttpPayload.Json,');
  expect(table).not.toContain('InteropProcedures.Clock');
  expect(table).toContain('            return "https://example.com/problems/";');
  expect(JSON.parse(/^ {12}return (".*")u8;$/mu.exec(table ?? '')?.[1] ?? '""')).toBe(document);
});

test('writes no BeadHttp.cs without http', () => {
  expect(
    csharpTarget
      .generate(
        { blueprint: interop(), sources: { blueprint: 'spec/interop-blueprint.json' } },
        { namespace: 'Bead.Interop', messages: Messages.GENERATE }
      )
      .map((file) => {
        return file.name;
      })
  ).toEqual(['InteropBead.cs']);
});
