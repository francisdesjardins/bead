// ── HTTP ──────────────────────────────────────────────────────────────────────

// What the Rust target prints for an output with a `gateway` (decisions 0037 and 0052): one
// `bead_http.rs` at the output's root, under its module `bead_http`: `HttpRoutes`, its route table,
// made once a process behind a `LazyLock`, each procedure a client calls by its descriptor, its
// messages' JSON forms, one `bead_protobuf::JsonForm` over the pool its messages embed, or the
// encoding of a native payload, whether it is marked `NO_SIDE_EFFECTS`, its service's catalogue, and
// its routes in their order, default first; `OPENAPI_DOCUMENT`, the document `generate` writes,
// embedded byte for byte as a string literal; `HTTP_PROBLEM_TYPES`, the base of an application
// failure's problem type; each service's HTTP client, flat, as transcoding 12.1 reads, a method a
// procedure a client calls by its own name in snake case, and one more, `subscribe_` and its name,
// for one that notifies; and the contract with the runtime, 5. The same data the TypeScript and C#
// targets write, in this language: each route made by a function of its own, so that no function
// grows with the table, and every runtime item named from its crate's root.

// dependencies

import type {
  HttpMethod,
  IBinding,
  IBlueprint,
  IProcedureEntry,
  IServiceEntry,
} from '../../model/blueprint.ts';
import { messagesOf, routesOf } from '../../model/routes.ts';
import type { IHttpInput } from '../target.ts';
import { identifierOf, snakeIdentifierOf, toSnakeCase } from './names.ts';
import { deprecatedOf, docOf, INDENT, literalOf } from './templates.ts';

// types

/** What a route table is printed with. */
export interface IRustHttpOptions {
  /** The gateway's view of the blueprint: the procedures its route table and its clients hold. */
  readonly blueprint: IBlueprint;
  readonly http: IHttpInput;
  /** A message's path from the module `bead_http`, by its full name: `super::messages::…`. */
  readonly messageOf: (fullName: string) => string;
  /** The path of a service's package module from the module `bead_http`: `super::services::…`. */
  readonly moduleOf: (service: IServiceEntry) => string;
}

// constants

/** The file an output with a `gateway` writes its route table, its document and its clients in. */
export const HTTP_FILE = 'bead_http.rs';

/** The module of the output's root that holds them. */
export const HTTP_MODULE = 'bead_http';

/** The type a service's HTTP client is, after its name, the one name the target adds in `bead_http`. */
export const HTTP_CLIENT_SUFFIX = 'HttpClient';

/**
 * The methods a service's HTTP client holds besides its procedures': its constructor, and those of
 * the traits it implements, `Clone` and `Debug`. A procedure that renders as one of them would be
 * two methods of one name, which the Rust target refuses for its output.
 */
export const HTTP_CLIENT_METHODS: ReadonlySet<string> = new Set(['new', 'clone', 'fmt']);

const ERROR = '::bead::ProgrammerError';
const ERROR_LINK = `[\`ProgrammerError\`](${ERROR})`;
// what a client's call fails with, the requester's own errors
const CALL_ERRORS =
  "# Errors\n\nA [`CallError`](::bead::CallError): the failure its gateway answers, or one of this side's, as [`HttpRequester::call`](::bead::HttpRequester::call) gives them.";
const ROUTE = '::bead::HttpRoute';
const FORM = '::bead_protobuf::JsonForm';

// the codec of each encoding that is no message's, and the variant of its payload in a route
const NATIVE = Object.freeze({
  raw: { codec: '::bead::RawCodec', payload: '::bead::HttpPayload::Raw' },
  text: { codec: '::bead::TextCodec', payload: '::bead::HttpPayload::Text' },
  json: { codec: '::bead::JsonCodec', payload: '::bead::HttpPayload::Json' },
} as const);

// each method a route takes, as the runtime's `HttpMethod` names it
const METHODS: Readonly<Record<HttpMethod, string>> = Object.freeze({
  DELETE: '::bead::HttpMethod::Delete',
  GET: '::bead::HttpMethod::Get',
  PATCH: '::bead::HttpMethod::Patch',
  POST: '::bead::HttpMethod::Post',
  PUT: '::bead::HttpMethod::Put',
});

// helpers

const isMessage = (binding: IBinding): binding is IBinding & { readonly message: string } => {
  return binding.encoding === 'proto' && binding.message !== undefined;
};

const nativeOf = (binding: IBinding) => {
  return NATIVE[binding.encoding as keyof typeof NATIVE];
};

// the bindings of a procedure: its request, its result, and its notification where it has one
const bindingsOf = (procedure: IProcedureEntry): IBinding[] => {
  return [
    procedure.request,
    procedure.result,
    ...(procedure.notification === undefined ? [] : [procedure.notification]),
  ];
};

// `text` as an optional string of a route's
const optionalOf = (text: string | undefined): string => {
  return text === undefined ? 'None' : `Some(${literalOf(text)}.to_owned())`;
};

// the field and the method of a procedure's subscriber: `subscribe_` and its name, never a keyword
const subscriberOf = (procedure: IProcedureEntry): string => {
  return `subscribe_${toSnakeCase(procedure.procedureName)}`;
};

// definition

/** The lines of `bead_http.rs` below its header: `HttpRoutes`, the document, the problem types, each client and the contract. */
export const printRustHttp = (options: IRustHttpOptions): string[] => {
  const { blueprint, http, messageOf, moduleOf } = options;
  const messages = messagesOf(blueprint);
  const at = `${INDENT}${INDENT}`;
  const shownOf = (service: IServiceEntry): string => {
    return `\`${service.proto?.fullName ?? service.serviceName}\``;
  };
  const proceduresOf = (service: IServiceEntry): string => {
    return `${moduleOf(service)}${service.serviceName}Procedures`;
  };
  const codecTypeOf = (binding: IBinding): string => {
    return isMessage(binding)
      ? `::bead_protobuf::ProtoCodec<${messageOf(binding.message)}>`
      : nativeOf(binding).codec;
  };
  // the value a codec reads and writes: a message's own type, a native codec's by its trait
  const valueOf = (binding: IBinding): string => {
    return isMessage(binding)
      ? messageOf(binding.message)
      : `<${codecTypeOf(binding)} as ::bead::PayloadCodec>::Value`;
  };
  const payloadOf = (binding: IBinding): string => {
    return isMessage(binding)
      ? `::bead::HttpPayload::Message(form.form_of(::bead_protobuf::ProtoSchema::of::<${messageOf(binding.message)}>()))`
      : nativeOf(binding).payload;
  };
  const services = blueprint.services
    .map((service) => {
      return service.serviceName;
    })
    .join(', ');
  // * the table: each procedure a client calls, in the blueprint's order, its index the client's
  const entries = blueprint.services.flatMap((service) => {
    return service.procedures.flatMap((procedure) => {
      const routes = routesOf(service, { procedure, messages, prefix: http.prefix });

      return routes.length === 0 ? [] : [{ service, procedure, routes }];
    });
  });
  const binds = entries.some(({ procedure }) => {
    return bindingsOf(procedure).some(isMessage);
  });
  const firstMessage = entries
    .flatMap(({ procedure }) => {
      return bindingsOf(procedure).filter(isMessage);
    })
    .at(0);
  const tabled = [
    ...new Set(
      entries.map(({ service }) => {
        return service;
      })
    ),
  ];
  // the binding of each service's procedures in `made`, never `form`'s name
  const bindingOf = (service: IServiceEntry): string => {
    return `${toSnakeCase(service.serviceName)}_procedures`;
  };
  const indexOf = new Map(
    entries.map((entry, index) => {
      return [entry.procedure, index] as const;
    })
  );
  // * a route's function: its procedure's init, `route_of` judging it
  const routeFunctionOf = (entry: (typeof entries)[number], index: number): string[] => {
    const { service, procedure, routes } = entry;
    const procedures = proceduresOf(service);
    const failures = `${moduleOf(service)}${service.serviceName}Failures`;
    const listed = service.failures.map((failure) => {
      return `${failures}::${identifierOf(failure.failureName)}`;
    });
    const usesForm = bindingsOf(procedure).some(isMessage);

    return [
      '',
      `${INDENT}// the route of \`${service.serviceName}/${procedure.procedureName}\``,
      `${INDENT}fn route_${String(index)}(procedures: &${procedures}${usesForm ? `, form: &${FORM}` : ''}) -> Result<${ROUTE}, ${ERROR}> {`,
      `${at}::bead::route_of(::bead::HttpRouteInit {`,
      `${at}${INDENT}procedure: ::bead::ServiceProcedure::from(&procedures.${snakeIdentifierOf(procedure.procedureName)}),`,
      `${at}${INDENT}request: ${payloadOf(procedure.request)},`,
      `${at}${INDENT}result: ${payloadOf(procedure.result)},`,
      `${at}${INDENT}notification: ${procedure.notification === undefined ? 'None' : `Some(${payloadOf(procedure.notification)})`},`,
      `${at}${INDENT}failures: ${listed.length === 0 ? '::std::vec::Vec::new()' : `::std::vec![${listed.join(', ')}]`},`,
      `${at}${INDENT}no_side_effects: ${String(procedure.http?.idempotencyLevel === 'NO_SIDE_EFFECTS')},`,
      `${at}${INDENT}routes: ::std::vec![`,
      ...routes.map((route) => {
        return `${at}${INDENT}${INDENT}::bead::HttpRouteTemplate { method: ${METHODS[route.method]}, template: ${literalOf(route.template)}.to_owned(), body: ${optionalOf(route.body)}, response_body: ${optionalOf(route.responseBody)} },`;
      }),
      `${at}${INDENT}],`,
      `${at}})`,
      `${INDENT}}`,
    ];
  };
  const table = [
    ...docOf(
      {
        summary: `The HTTP routes of ${services}, a gateway's table (decision 0037): each procedure a client calls, by its descriptor, its messages' JSON forms, which a gateway reads and writes their JSON by, whether it is marked \`NO_SIDE_EFFECTS\`, its service's catalogue, and its routes, its default ones first, then its \`google.api.http\` rules in their order.`,
      },
      ''
    ),
    '#[derive(Debug)]',
    '#[non_exhaustive]',
    'pub struct HttpRoutes {',
    `${INDENT}/// Each procedure's route, in the blueprint's order.`,
    `${INDENT}pub all: ::std::vec::Vec<${ROUTE}>,`,
    '}',
    '',
    'impl HttpRoutes {',
    ...docOf(
      {
        summary: binds
          ? 'The routes, made once a process over the pool its messages embed, one JSON form for all.'
          : 'The routes, made once a process.',
        sections: [
          `# Errors\n\nA ${ERROR_LINK} where a route does not hold, or a descriptor or a codec of its service does not.`,
        ],
      },
      INDENT
    ),
    `${INDENT}pub fn get() -> Result<&'static Self, ${ERROR}> {`,
    `${at}static ROUTES: ::std::sync::LazyLock<Result<HttpRoutes, ${ERROR}>> =`,
    `${at}${INDENT}::std::sync::LazyLock::new(HttpRoutes::made);`,
    '',
    `${at}ROUTES.as_ref().map_err(::core::clone::Clone::clone)`,
    `${INDENT}}`,
    '',
    `${INDENT}fn made() -> Result<Self, ${ERROR}> {`,
    ...tabled.map((service) => {
      return `${at}let ${bindingOf(service)} = ${proceduresOf(service)}::get()?;`;
    }),
    ...(firstMessage === undefined
      ? []
      : [
          `${at}let form = ${FORM}::new(::std::sync::Arc::clone(::bead_protobuf::ProtoSchema::of::<${messageOf(firstMessage.message)}>().pool()));`,
        ]),
    '',
    `${at}Ok(Self {`,
    ...(entries.length === 0
      ? [`${at}${INDENT}all: ::std::vec::Vec::new(),`]
      : [
          `${at}${INDENT}all: ::std::vec![`,
          ...entries.map(({ service, procedure }, index) => {
            const usesForm = bindingsOf(procedure).some(isMessage);

            return `${at}${INDENT}${INDENT}Self::route_${String(index)}(${bindingOf(service)}${usesForm ? ', &form' : ''})?,`;
          }),
          `${at}${INDENT}],`,
        ]),
    `${at}})`,
    `${INDENT}}`,
    ...entries.flatMap(routeFunctionOf),
    '',
    `${INDENT}// the route at \`index\` of the table, which a client takes by the index beadc gave it`,
    `${INDENT}fn at(&self, index: usize) -> Result<&${ROUTE}, ${ERROR}> {`,
    `${at}self.all.get(index).ok_or_else(|| ${ERROR}::new("beadc's route table holds no route at the index its client names"))`,
    `${INDENT}}`,
    '}',
    '',
  ];
  // * each service's client: a requester of each procedure a client calls, and a subscriber of each
  // that notifies, on its default route
  const clients = blueprint.services.flatMap((service) => {
    const name = `${service.serviceName}${HTTP_CLIENT_SUFFIX}`;
    const shown = shownOf(service);
    const called = service.procedures.filter((procedure) => {
      return indexOf.has(procedure);
    });
    const mark = deprecatedOf(service.deprecation, '');
    const head = [
      ...docOf(
        {
          summary: `The HTTP client of ${shown}, over Bead's HTTP caller, on its default routes.`,
        },
        ''
      ),
      ...mark,
      '#[derive(Debug, Clone)]',
    ];
    const newDoc = docOf(
      {
        summary: "Its gateway's URL and its options: a default authorization, its bounds, its TLS.",
        sections: [
          `# Errors\n\nA ${ERROR_LINK} where the caller refuses its URL or its options${called.length === 0 ? '' : ', or the routes or a descriptor of its service do not hold'}.`,
        ],
      },
      INDENT
    );
    const signature = `${INDENT}pub fn new(url: &str, options: &::bead::HttpCallerOptions) -> Result<Self, ${ERROR}> {`;

    if (called.length === 0) {
      return [
        ...head,
        `pub struct ${name};`,
        '',
        `impl ${name} {`,
        ...newDoc,
        signature,
        `${at}::bead::HttpCaller::new(url, options).map(|_caller| Self)`,
        `${INDENT}}`,
        '}',
        '',
      ];
    }

    const fields = called.flatMap((procedure) => {
      const field = snakeIdentifierOf(procedure.procedureName);
      const pair = `${codecTypeOf(procedure.request)}, ${codecTypeOf(procedure.result)}`;

      return [
        `${INDENT}${field}: ::bead::HttpRequester<${pair}>,`,
        ...(procedure.notification === undefined
          ? []
          : [
              `${INDENT}${subscriberOf(procedure)}: ::bead::HttpSubscriber<${pair}, ${codecTypeOf(procedure.notification)}>,`,
            ]),
      ];
    });
    const made = called.flatMap((procedure) => {
      const field = snakeIdentifierOf(procedure.procedureName);
      const index = String(indexOf.get(procedure));
      const notifies = procedure.notification !== undefined;
      const descriptor = notifies ? `procedures.${field}.descriptor()` : `&procedures.${field}`;

      return [
        `${at}${INDENT}${field}: caller.requester_of(routes.at(${index})?, ${descriptor})?,`,
        ...(notifies
          ? [
              `${at}${INDENT}${subscriberOf(procedure)}: caller.subscriber_of(routes.at(${index})?, &procedures.${field})?,`,
            ]
          : []),
      ];
    });
    const methods = called.flatMap((procedure) => {
      const field = snakeIdentifierOf(procedure.procedureName);
      const procedureMark = deprecatedOf(procedure.deprecation ?? service.deprecation, INDENT);
      const request = valueOf(procedure.request);
      const result = valueOf(procedure.result);
      const parameters = `&self, request: &${request}, options: &::bead::HttpCallOptions`;

      return [
        '',
        ...docOf(
          {
            summary:
              procedure.notification === undefined
                ? `Calls \`${procedure.procedureName}\` on its default route.`
                : `Calls \`${procedure.procedureName}\` on its default route, its result alone.`,
            sections: [CALL_ERRORS],
          },
          INDENT
        ),
        ...procedureMark,
        `${INDENT}pub fn ${field}(${parameters}) -> ::bead::BoxFuture<Result<${result}, ::bead::CallError>> {`,
        `${at}self.${field}.call(request, options)`,
        `${INDENT}}`,
        ...(procedure.notification === undefined
          ? []
          : [
              '',
              ...docOf(
                {
                  summary: `Reads the result and notifications of \`${procedure.procedureName}\`; it never reconnects.`,
                },
                INDENT
              ),
              ...procedureMark,
              `${INDENT}pub fn ${subscriberOf(procedure)}(${parameters}) -> ::bead::HttpSubscription<${result}, ${valueOf(procedure.notification)}> {`,
              `${at}self.${subscriberOf(procedure)}.call(request, options)`,
              `${INDENT}}`,
            ]),
      ];
    });

    return [
      ...head,
      `pub struct ${name} {`,
      ...fields,
      '}',
      '',
      `impl ${name} {`,
      ...newDoc,
      signature,
      `${at}let procedures = ${proceduresOf(service)}::get()?;`,
      `${at}let routes = HttpRoutes::get()?;`,
      `${at}let caller = ::bead::HttpCaller::new(url, options)?;`,
      '',
      `${at}Ok(Self {`,
      ...made,
      `${at}})`,
      `${INDENT}}`,
      ...methods,
      '}',
      '',
    ];
  });

  return [
    ...table,
    `/// The document beadc wrote of the blueprint, byte for byte, which a gateway serves at \`/openapi.json\` (transcoding 11.1).`,
    `pub const OPENAPI_DOCUMENT: &str = ${literalOf(http.document)};`,
    '',
    "/// The base of an application failure's problem type, which its name follows (transcoding 7.3); none where `beadc.yaml` gives none.",
    `pub const HTTP_PROBLEM_TYPES: ::core::option::Option<&str> = ${http.problemTypes === undefined ? '::core::option::Option::None' : `::core::option::Option::Some(${literalOf(http.problemTypes)})`};`,
    '',
    ...clients,
    '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here',
    'const _: bool = ::bead::GENERATED_CODE_SUPPORTS_VERSION_5;',
    '',
  ];
};
