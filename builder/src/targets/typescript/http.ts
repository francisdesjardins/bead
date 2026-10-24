// ── HTTP ──────────────────────────────────────────────────────────────────────

// What the TypeScript target prints for an output with `http: true` (decision 0037): one
// `bead_http.ts` at the output's root, its route table as data, each procedure a client calls by
// its descriptor, its messages' schemas, which the transcoding layer reads their JSON by over
// protobuf-es's reflection, whether it is marked `NO_SIDE_EFFECTS`, its service's catalogue, and its
// routes in their order, default first; the OpenAPI document `generate` writes, embedded byte for
// byte as a string the gateway encodes once; the base of an application failure's problem type;
// and the contract with the runtime, 5. The same data the C# target writes, in this language.

// dependencies

import type { DescMessage } from '@bufbuild/protobuf';
import type { GeneratedFile, Printable } from '@bufbuild/protoplugin';

import type { IBinding, IBlueprint, IServiceEntry } from '../../model/blueprint.ts';
import { messagesOf, routesOf } from '../../model/routes.ts';
import type { IHttpInput } from '../target.ts';
import { deprecatedOf } from './templates.ts';

// types

/** What a route table is printed with. */
export interface IHttpTemplateOptions {
  readonly blueprint: IBlueprint;
  readonly http: IHttpInput;
  /** The module the table imports its runtime from, as `f.import` takes it. */
  readonly runtime: string;
  /** The module each service's descriptors are imported from, as `f.import` takes it. */
  readonly serviceModuleOf: (service: IServiceEntry) => string;
  /** The descriptor of a message a `proto` binding names, by its full name. */
  readonly messageOf: (fullName: string) => DescMessage;
}

// constants

/** The file an output with `http: true` writes its route table in, at its root. */
export const HTTP_FILE = 'bead_http.ts';

// a text as a single-quoted literal, the TypeScript side's own quotes
const quotedOf = (text: string): string => {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
};

// definition

/** Prints `bead_http.ts`: the route table, the document, the problem types and the contract. */
export const printHttp = (f: GeneratedFile, options: IHttpTemplateOptions): void => {
  const { blueprint, http, runtime, messageOf } = options;
  const messages = messagesOf(blueprint);
  const payloadOf = (binding: IBinding): Printable => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? f.importSchema(messageOf(binding.message))
      : `'${binding.encoding}'`;
  };
  const services = blueprint.services
    .map((service) => {
      return service.serviceName;
    })
    .join(', ');

  f.print(
    f.jsDoc(
      `The HTTP routes of ${services}, a gateway's table (decision 0037): each procedure a client calls, by its descriptor, its messages, which a gateway reads and writes their JSON by, whether it is marked NO_SIDE_EFFECTS, its service's catalogue, and its routes, its default ones first, then its google.api.http rules in their order.`
    )
  );
  f.print(f.export('const', 'HTTP_ROUTES'), ' = Object.freeze([');

  for (const service of blueprint.services) {
    const catalogue = service.failures
      .map((failure) => {
        return `${failure.failureName}: ${String(failure.code)}`;
      })
      .join(', ');

    for (const procedure of service.procedures) {
      const routes = routesOf(service, { procedure, messages, prefix: http.prefix });

      if (routes.length === 0) {
        continue;
      }

      f.print('  ', f.import('routeOf', runtime), '({');
      f.print(
        '    procedure: ',
        f.import(`${service.serviceName}Procedures`, options.serviceModuleOf(service)),
        `.${procedure.procedureName},`
      );
      f.print('    request: ', payloadOf(procedure.request), ',');
      f.print('    result: ', payloadOf(procedure.result), ',');

      if (procedure.notification !== undefined) {
        f.print('    notification: ', payloadOf(procedure.notification), ',');
      }

      if (procedure.http?.idempotencyLevel === 'NO_SIDE_EFFECTS') {
        f.print('    noSideEffects: true,');
      }

      f.print('    failures: {', catalogue === '' ? '' : ` ${catalogue} `, '},');
      f.print('    routes: [');

      for (const route of routes) {
        const members = [
          `method: ${quotedOf(route.method)}`,
          `template: ${quotedOf(route.template)}`,
          ...(route.body === undefined ? [] : [`body: ${quotedOf(route.body)}`]),
          ...(route.responseBody === undefined
            ? []
            : [`responseBody: ${quotedOf(route.responseBody)}`]),
        ];

        f.print(`      { ${members.join(', ')} },`);
      }

      f.print('    ],');
      f.print('  }),');
    }
  }

  f.print('] as const);');
  f.print();
  let index = 0;

  for (const service of blueprint.services) {
    const answered = service.procedures.filter((procedure) => {
      return procedure.procedureKind !== 'command';
    });
    const start = index;

    f.print(
      f.jsDoc(
        `The HTTP client of ${service.serviceName}, over fetch, on its default routes.${deprecatedOf(service.deprecation)}`
      )
    );
    f.print(f.export('class', `${service.serviceName}HttpClient`), ' {');

    for (const procedure of answered) {
      f.print(
        f.jsDoc(
          `Calls ${procedure.procedureName}; subscribe reads its result and notifications where it notifies.${deprecatedOf(procedure.deprecation ?? service.deprecation)}`,
          '  '
        )
      );
      f.print(
        '  public readonly ',
        procedure.procedureName,
        ': ',
        f.import('IHTTPRequester', runtime, true),
        '<typeof HTTP_ROUTES[',
        String(index),
        ']>;'
      );
      index += 1;
    }

    f.print(
      f.jsDoc(
        'Its gateway URL, fetch and default authorization; each call may give its own or omit it.',
        '  '
      )
    );
    f.print('  public constructor(options: ', f.import('IHTTPCallerOptions', runtime, true), ') {');
    f.print(
      '    const caller = ',
      f.import('createHTTPCaller', runtime),
      '(HTTP_ROUTES, options);'
    );

    if (answered.length === 0) {
      f.print('    void caller;');
    }

    for (const [offset, procedure] of answered.entries()) {
      f.print(
        '    this.',
        procedure.procedureName,
        ' = ',
        f.import('httpRequesterOf', runtime),
        '(HTTP_ROUTES[',
        String(start + offset),
        '], caller);'
      );
    }

    f.print('  }');
    f.print('}');
    f.print();
  }

  f.print(
    f.jsDoc(
      'The OpenAPI document beadc wrote of the blueprint, byte for byte, which a gateway serves at /openapi.json (transcoding 11.1).'
    )
  );
  f.print(f.export('const', 'OPENAPI_DOCUMENT'), ' = ', JSON.stringify(http.document), ';');
  f.print();
  f.print(
    f.jsDoc(
      "The base of an application failure's problem type, which its name follows (transcoding 7.3); none where beadc.yaml gives none."
    )
  );
  f.print(
    f.export('const', 'HTTP_PROBLEM_TYPES'),
    ' = ',
    http.problemTypes === undefined ? 'undefined' : quotedOf(http.problemTypes),
    ';'
  );
  f.print();
  f.print(
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here'
  );
  f.print('void ', f.import('GENERATED_CODE_SUPPORTS_VERSION_5', runtime), ';');
};
