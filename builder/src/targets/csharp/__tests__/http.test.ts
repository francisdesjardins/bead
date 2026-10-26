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

test('writes a typed HTTP client on default routes, with a stream for each notifying procedure and no command', () => {
  const blueprint = interop();
  const table = csharpTarget
    .generate(
      { blueprint, sources: { blueprint: 'spec/interop-blueprint.json' } },
      {
        namespace: 'Bead.Interop',
        messages: Messages.GENERATE,
        http: { prefix: '/api', document: documentOf(blueprint) },
      }
    )
    .find((file) => {
      return file.name === HTTP_FILE;
    })?.content;

  expect(table).toContain('public sealed class InteropHttpClient : global::System.IDisposable');
  expect(table).toContain(
    'Task<global::System.Text.Json.JsonElement> Echo(global::System.Text.Json.JsonElement request, global::Bead.Transcoding.HttpCallOptions? options = null)'
  );
  expect(table).toContain(
    'return _caller.Call<global::System.Text.Json.JsonElement>(HttpRoutes.All[0], request, options);'
  );
  expect(table).toContain('SubscribeTicks(');
  expect(table).not.toContain(' Clock(');
});

test('marks HTTP client types and requesters deprecated with their definitions', () => {
  const blueprint = interop();
  const changed = {
    ...blueprint,
    services: blueprint.services.map((service) => {
      return {
        ...service,
        deprecation: { message: 'Use Other.' },
        procedures: service.procedures.map((procedure) => {
          return { ...procedure, deprecation: { message: 'Call another procedure.' } };
        }),
      };
    }),
  };
  const table = csharpTarget
    .generate(
      { blueprint: changed, sources: { blueprint: 'spec/interop-blueprint.json' } },
      {
        namespace: 'Bead.Interop',
        messages: Messages.GENERATE,
        http: { prefix: '/api', document: documentOf(changed) },
      }
    )
    .find((file) => {
      return file.name === HTTP_FILE;
    })?.content;

  expect(table).toContain('Obsolete("Use Other."');
  expect(table).toContain('Obsolete("Call another procedure."');
  expect(table).toContain('public sealed class InteropHttpClient');
});

test('writes an HTTP client for a service whose procedures are commands alone', () => {
  const blueprint = interop();
  const changed = {
    ...blueprint,
    services: blueprint.services.map((service) => {
      return {
        ...service,
        procedures: service.procedures.filter((procedure) => {
          return procedure.procedureKind === 'command';
        }),
      };
    }),
  };
  const table = csharpTarget
    .generate(
      { blueprint: changed, sources: { blueprint: 'spec/interop-blueprint.json' } },
      {
        namespace: 'Bead.Interop',
        messages: Messages.GENERATE,
        http: { prefix: '/api', document: documentOf(changed) },
      }
    )
    .find((file) => {
      return file.name === HTTP_FILE;
    })?.content;

  expect(table).toContain('public sealed class InteropHttpClient');
  expect(table).not.toContain('return _caller.Call<');
  expect(table).not.toContain('return _caller.Subscribe<');
});

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
