// ── HTTP ──────────────────────────────────────────────────────────────────────

// What the C# target prints for an output with `http: true` (decision 0037): one `BeadHttp.cs`,
// beside the first service's `*Bead.cs`, in its namespace, a static class `HttpRoutes`: `All`, the
// route table as data, each procedure a client calls by its descriptor's `Procedure`, its messages'
// `Descriptor`s, which the transcoding layer reads their JSON by, whether it is marked
// `NO_SIDE_EFFECTS`, its service's catalogue, and its routes in their order, default first;
// `OpenApiDocument`, the document `generate` writes, embedded byte for byte as a UTF-8 literal;
// `ProblemTypes`, the base of an application failure's problem type; and the contract with the
// runtime, 5. The same data the TypeScript target writes, in this language: every body a block,
// every type qualified from `global::`.

// dependencies

import type { IBinding, IBlueprint, IServiceEntry } from '../../model/blueprint.ts';
import { messagesOf, routesOf } from '../../model/routes.ts';
import { DEPRECATION_ID, type IHttpInput } from '../target.ts';
import { literalOf, obsoleteOf } from './templates.ts';

// types

/** What a route table is printed with. */
export interface ICSharpHttpOptions {
  readonly blueprint: IBlueprint;
  readonly http: IHttpInput;
  /** The namespace the file is written in. */
  readonly namespace: string;
  /** The namespace of each service's descriptors. */
  readonly namespaceOf: (service: IServiceEntry) => string;
  /** The C# type of a message a `proto` binding names, by its full name, qualified. */
  readonly messageOf: (fullName: string) => string;
}

// constants

/** The file an output with `http: true` writes its route table in. */
export const HTTP_FILE = 'BeadHttp.cs';

const INDENT = '    ';
const TRANSCODING = 'global::Bead.Transcoding';

// helpers

const upperFirst = (name: string): string => {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

// definition

/** The lines of `BeadHttp.cs` below its header: the namespace, `HttpRoutes`, the contract. */
export const printCSharpHttp = (options: ICSharpHttpOptions): string[] => {
  const { blueprint, http, messageOf } = options;
  const messages = messagesOf(blueprint);
  const payloadOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? `${TRANSCODING}.HttpPayload.Of(${messageOf(binding.message)}.Descriptor)`
      : `${TRANSCODING}.HttpPayload.${upperFirst(binding.encoding)}`;
  };
  const services = blueprint.services
    .map((service) => {
      return service.serviceName;
    })
    .join(', ');
  const entries = blueprint.services.flatMap((service) => {
    const qualified = options.namespaceOf(service);
    const holder = `global::${qualified === '' ? '' : `${qualified}.`}${service.serviceName}Procedures`;

    return service.procedures.flatMap((procedure) => {
      const routes = routesOf(service, { procedure, messages, prefix: http.prefix });

      if (routes.length === 0) {
        return [];
      }

      const at = INDENT.repeat(3);

      return [
        `${INDENT.repeat(2)}new ${TRANSCODING}.HttpRoute`,
        `${INDENT.repeat(2)}{`,
        `${at}Procedure = ${holder}.${upperFirst(procedure.procedureName)}.Procedure,`,
        `${at}Request = ${payloadOf(procedure.request)},`,
        `${at}Result = ${payloadOf(procedure.result)},`,
        ...(procedure.notification === undefined
          ? []
          : [`${at}Notification = ${payloadOf(procedure.notification)},`]),
        ...(procedure.http?.idempotencyLevel === 'NO_SIDE_EFFECTS'
          ? [`${at}NoSideEffects = true,`]
          : []),
        `${at}Failures = new global::System.Collections.Generic.Dictionary<string, int>`,
        `${at}{`,
        ...service.failures.map((failure) => {
          return `${at}${INDENT}[${literalOf(failure.failureName)}] = ${String(failure.code)},`;
        }),
        `${at}},`,
        `${at}Routes =`,
        `${at}[`,
        ...routes.map((route) => {
          const members = [
            `Method = ${literalOf(route.method)}`,
            `Template = ${literalOf(route.template)}`,
            ...(route.body === undefined ? [] : [`Body = ${literalOf(route.body)}`]),
            ...(route.responseBody === undefined
              ? []
              : [`ResponseBody = ${literalOf(route.responseBody)}`]),
          ];

          return `${at}${INDENT}new ${TRANSCODING}.HttpRouteTemplate { ${members.join(', ')} },`;
        }),
        `${at}],`,
        `${INDENT.repeat(2)}},`,
      ];
    });
  });

  const native = Object.freeze({
    raw: 'global::System.ReadOnlyMemory<byte>',
    text: 'string',
    json: 'global::System.Text.Json.JsonElement',
  });
  const typeOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? messageOf(binding.message)
      : native[binding.encoding as keyof typeof native];
  };
  let index = 0;
  const clients = blueprint.services.flatMap((service) => {
    const name = `${service.serviceName}HttpClient`;
    const methods = service.procedures.flatMap((procedure) => {
      if (procedure.procedureKind === 'command') {
        return [];
      }

      const route = `HttpRoutes.All[${String(index)}]`;
      const request = typeOf(procedure.request);
      const result = typeOf(procedure.result);
      const rpc = upperFirst(procedure.procedureName);

      index += 1;

      return [
        '',
        `    /// <summary>Calls ${procedure.procedureName} on its default HTTP route.</summary>`,
        ...obsoleteOf(procedure.deprecation ?? service.deprecation, INDENT),
        `    public global::System.Threading.Tasks.Task<${result}> ${rpc}(${request} request, ${TRANSCODING}.HttpCallOptions? options = null)`,
        '    {',
        `        return _caller.Call<${result}>(${route}, request, options);`,
        '    }',
        ...(procedure.notification === undefined
          ? []
          : [
              '',
              `    /// <summary>Reads the result and notifications of ${procedure.procedureName}; it never reconnects.</summary>`,
              ...obsoleteOf(procedure.deprecation ?? service.deprecation, INDENT),
              `    public global::System.Collections.Generic.IAsyncEnumerable<${TRANSCODING}.HttpEvent<${result}, ${typeOf(procedure.notification)}>> Subscribe${rpc}(${request} request, ${TRANSCODING}.HttpCallOptions? options = null)`,
              '    {',
              `        return _caller.Subscribe<${result}, ${typeOf(procedure.notification)}>(${route}, request, options);`,
              '    }',
            ]),
      ];
    });

    return [
      `/// <summary>The HTTP client of ${service.serviceName}, over HttpClient, on its default routes.</summary>`,
      ...obsoleteOf(service.deprecation, ''),
      `public sealed class ${name} : global::System.IDisposable`,
      '{',
      `    private readonly ${TRANSCODING}.HttpCaller _caller;`,
      '',
      '    /// <summary>Its gateway URL, handler and default authorization.</summary>',
      `    public ${name}(global::System.Uri url, ${TRANSCODING}.HttpCallerOptions? options = null)`,
      '    {',
      `        _caller = new ${TRANSCODING}.HttpCaller(HttpRoutes.All, url, options);`,
      '    }',
      ...methods,
      '',
      '    /// <summary>Releases its HTTP client and handler.</summary>',
      '    public void Dispose()',
      '    {',
      '        _caller.Dispose();',
      '    }',
      '}',
      '',
    ];
  });

  return [
    '#nullable enable',
    // ! the route table names each procedure's descriptor, a deprecated one's among them
    `#pragma warning disable CS0612, CS0618, ${DEPRECATION_ID} // a deprecated member, protobuf's or Bead's, is named by its own file`,
    ...(options.namespace === '' ? [] : ['', `namespace ${options.namespace};`]),
    '',
    `/// <summary>The HTTP routes of ${services}, a gateway's table, its document and its problem types (decision 0037).</summary>`,
    'public static class HttpRoutes',
    '{',
    `${INDENT}/// <summary>Each procedure a client calls, by its descriptor, its messages, which a gateway reads and writes their JSON by, whether it is marked NO_SIDE_EFFECTS, its service's catalogue, and its routes, its default ones first, then its google.api.http rules in their order.</summary>`,
    `${INDENT}public static global::System.Collections.Generic.IReadOnlyList<${TRANSCODING}.HttpRoute> All { get; } =`,
    `${INDENT}[`,
    ...entries,
    `${INDENT}];`,
    '',
    `${INDENT}/// <summary>The OpenAPI document beadc wrote of the blueprint, byte for byte, which a gateway serves at /openapi.json (transcoding 11.1).</summary>`,
    `${INDENT}public static global::System.ReadOnlySpan<byte> OpenApiDocument`,
    `${INDENT}{`,
    `${INDENT.repeat(2)}get`,
    `${INDENT.repeat(2)}{`,
    `${INDENT.repeat(3)}return ${literalOf(http.document)}u8;`,
    `${INDENT.repeat(2)}}`,
    `${INDENT}}`,
    '',
    `${INDENT}/// <summary>The base of an application failure's problem type, which its name follows (transcoding 7.3); none where beadc.yaml gives none.</summary>`,
    `${INDENT}public static string? ProblemTypes`,
    `${INDENT}{`,
    `${INDENT.repeat(2)}get`,
    `${INDENT.repeat(2)}{`,
    `${INDENT.repeat(3)}return ${http.problemTypes === undefined ? 'null' : literalOf(http.problemTypes)};`,
    `${INDENT.repeat(2)}}`,
    `${INDENT}}`,
    '}',
    '',
    ...clients,
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here',
    'file static class GeneratedCodeContract',
    '{',
    `${INDENT}private const bool Supported = global::Bead.GeneratedCode.SupportsVersion5;`,
    '}',
    '',
  ];
};
