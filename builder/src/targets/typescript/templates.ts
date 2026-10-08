// ── Templates ─────────────────────────────────────────────────────────────────

// What the TypeScript target prints for one service, through protoplugin's symbols (decision 0022):
// its descriptors, its catalogue, its resolvers' and its options' types, a server class where only
// resolvers are written, and a client class holding a requester of each procedure by its name; the
// file's contract with the runtime follows its services. Every import is a symbol, so protoplugin writes each once and aliases a
// clash; every doc comment is `f.jsDoc`'s, which writes `*/` as `*\/`.

// dependencies

import type { DescMessage } from '@bufbuild/protobuf';
import type { GeneratedFile, Printable } from '@bufbuild/protoplugin';

import type {
  AdmissionRule,
  IBinding,
  IProcedureEntry,
  IServiceEntry,
} from '../../model/blueprint.ts';

// types

/** What a service's file is printed with. */
export interface ITemplateOptions {
  /** The module the file imports the runtime from, as `f.import` takes it. */
  readonly runtime: string;
  /** The descriptor of a message a `proto` binding names, by its full name. */
  readonly messageOf: (fullName: string) => DescMessage;
}

// constants

// the layer's codec of each encoding that is no message's
const PAYLOAD_CODEC = Object.freeze({ raw: 'raw', text: 'text', json: 'json' } as const);

// the server's members, each the layer's, in their order
const SERVER_MEMBERS: readonly (readonly [string, string])[] = [
  ['command', 'The requester of each command, made as the service is offered.'],
  ['notify', "Notifies each procedure's subscribers."],
  ['offer', 'Offers every resolver, now and later, on one Bead server, once.'],
  ['on', "Registers a procedure's resolver by its name, before or after the offer."],
  ['proceduresWithoutResolver', 'The procedures a client calls that no resolver answers yet.'],
];

// the decoder's nesting limit, the TypeScript side's own (decision 0018)
const RECURSION_LIMIT = 101;

// helpers

// a string as a single-quoted literal, whatever it holds
const literalOf = (text: string): string => {
  const escaped = JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");

  return `'${escaped}'`;
};

// what a procedure admits, in the words its doc comment ends with
const admitsOf = (admission: AdmissionRule): string => {
  if (admission === 'none') {
    return 'Admits every call.';
  }

  if (admission === 'session') {
    return 'Admits a call in a session.';
  }

  return `Admits a call its hook \`${admission.hook}\` admits.`;
};

const admissionOf = (admission: AdmissionRule): string => {
  return typeof admission === 'string'
    ? literalOf(admission)
    : `{ hook: ${literalOf(admission.hook)} }`;
};

// the procedure as the runtime takes it, its members in their names' order
const procedureOf = (procedure: IProcedureEntry, service: IServiceEntry): string => {
  const members = [
    ...(procedure.deprecation === undefined
      ? []
      : [
          procedure.deprecation.message === undefined
            ? 'deprecation: {}'
            : `deprecation: { message: ${literalOf(procedure.deprecation.message)} }`,
        ]),
    ...(procedure.maximumPayloadBytes === undefined
      ? []
      : [`maximumPayloadBytes: ${String(procedure.maximumPayloadBytes)}`]),
    `procedureId: ${String(procedure.procedureId)}`,
    `procedureName: ${literalOf(procedure.procedureName)}`,
    `serviceId: ${String(service.serviceId)}`,
    `serviceRevision: ${String(service.serviceRevision)}`,
  ];

  return `{ ${members.join(', ')} }`;
};

// definition

/** Prints `service`'s file into `f`. */
export const printService = (
  f: GeneratedFile,
  details: ITemplateOptions & { readonly service: IServiceEntry }
): void => {
  const { service, runtime, messageOf } = details;
  const name = service.serviceName;
  const shown = service.proto?.fullName ?? name;
  const procedures = `${name}Procedures`;
  const codes = new Map(
    service.failures.map((failure) => {
      return [failure.failureName, failure.code];
    })
  );
  const answered = service.procedures.filter((procedure) => {
    return procedure.procedureKind !== 'command';
  });
  const hooks = [
    ...new Set(
      service.procedures.flatMap((procedure) => {
        return typeof procedure.admission === 'object' ? [procedure.admission.hook] : [];
      })
    ),
  ].sort();
  const fromRuntime = (symbol: string, typeOnly = false): Printable => {
    return f.import(symbol, runtime, typeOnly);
  };
  const codecOf = (binding: IBinding): Printable => {
    if (binding.encoding !== 'proto' || binding.message === undefined) {
      return [
        fromRuntime('PAYLOAD_CODECS'),
        `.${PAYLOAD_CODEC[binding.encoding as keyof typeof PAYLOAD_CODEC]}`,
      ];
    }

    const message = messageOf(binding.message);
    const schema = f.importSchema(message);

    return [
      fromRuntime('payloadCodecOf'),
      '<',
      f.importShape(message),
      ', ',
      f.import('MessageInitShape', '@bufbuild/protobuf', true),
      '<typeof ',
      schema,
      '>>({ decode: (bytes) => { return ',
      f.runtime.fromBinary,
      '(',
      schema,
      `, bytes, { recursionLimit: ${String(RECURSION_LIMIT)} }); }, encode: (given) => { return `,
      f.runtime.toBinary,
      '(',
      schema,
      ', ',
      f.runtime.create,
      '(',
      schema,
      ', given)); } })',
    ];
  };
  const server = [fromRuntime('IServiceServer', true), `<typeof ${procedures}, Data>`];
  const client = [fromRuntime('IServiceClient', true), `<typeof ${procedures}>`];

  // * the descriptors, the catalogue and the types: what a module of resolvers imports
  f.print();
  f.print(
    f.jsDoc(
      `The procedures of \`${shown}\`: service ${String(service.serviceId)}, revision ${String(service.serviceRevision)}.${
        service.description === undefined ? '' : `\n\n${service.description}`
      }`
    )
  );
  f.print(f.export('const', procedures), ' = Object.freeze({');

  for (const procedure of service.procedures) {
    const failures = procedure.failures
      .map((failure) => {
        return `${failure}: ${String(codes.get(failure))}`;
      })
      .join(', ');

    f.print(
      f.jsDoc(
        `${procedure.description === undefined ? '' : `${procedure.description} `}${admitsOf(procedure.admission)}`,
        '  '
      )
    );
    f.print(
      '  ',
      procedure.procedureName,
      ': ',
      fromRuntime(procedure.procedureKind === 'command' ? 'commandOf' : 'requestOf'),
      '({'
    );
    f.print('    admission: ', admissionOf(procedure.admission), ',');
    f.print('    failures: {', failures === '' ? '' : ` ${failures} `, '},');

    if (procedure.notification !== undefined) {
      f.print('    notification: ', codecOf(procedure.notification), ',');
    }

    f.print('    procedure: ', procedureOf(procedure, service), ',');
    f.print('    request: ', codecOf(procedure.request), ',');
    f.print('    result: ', codecOf(procedure.result), ',');
    f.print('  }),');
  }

  f.print('});');
  f.print();
  f.print(
    f.jsDoc(
      `The failures of \`${shown}\`, by name: service ${String(service.serviceId)}'s catalogue.`
    )
  );
  f.print(
    f.export('const', `${name}Failures`),
    ' = ',
    fromRuntime('failuresOf'),
    '({ codes: { ',
    service.failures
      .map((failure) => {
        return `${failure.failureName}: ${String(failure.code)}`;
      })
      .join(', '),
    ` }, serviceId: ${String(service.serviceId)} });`
  );
  f.print();
  f.print(
    f.jsDoc(
      "Each procedure's resolver, by its name: for resolvers written in a module of their own."
    )
  );
  f.print(
    f.export('type', `${name}Resolvers`),
    ' = ',
    fromRuntime('ServiceResolvers', true),
    `<typeof ${procedures}>;`
  );
  f.print();
  f.print(
    f.jsDoc(
      `What the server side of \`${shown}\` is given: its hooks, by the names its procedures give them.`
    )
  );
  f.print(
    f.export('type', `${name}ServerOptions`),
    ' = Exclude<',
    fromRuntime('ServiceServerOptions', true),
    `<typeof ${procedures}>[0], undefined>;`
  );
  f.print();
  f.print(f.jsDoc(`What a client side of \`${shown}\` is given besides its Bead client.`));
  f.print(
    f.export('type', `${name}ClientOptions`),
    ' = Omit<Parameters<typeof ',
    fromRuntime('createServiceClient'),
    `<typeof ${procedures}>>[1], 'client'>;`
  );

  // * the server: the layer's members, taken in the constructor, its options one parameter
  f.print();
  f.print(
    f.jsDoc(
      `The server side of \`${shown}\`, offered on one Bead server: only its resolvers are written.`
    )
  );
  f.print(f.export('class', `${name}Server`), '<Data = unknown> {');

  for (const [member, doc] of SERVER_MEMBERS) {
    f.print(f.jsDoc(doc, '  '));
    f.print(`  public readonly ${member}: `, server, `['${member}'];`);
  }

  f.print();

  if (hooks.length > 0) {
    f.print(
      f.jsDoc(
        `Its options, its hooks among them, required since a procedure names one: ${hooks.join(', ')}.`,
        '  '
      )
    );
    f.print(`  public constructor(options: ${name}ServerOptions) {`);
  } else {
    f.print(f.jsDoc('Its options, which name no hook.', '  '));
    f.print(`  public constructor(options?: ${name}ServerOptions) {`);
  }

  f.print(
    '    const service = ',
    fromRuntime('createServiceServer'),
    `<typeof ${procedures}, Data>(${procedures}, options);`
  );
  f.print();

  for (const [member] of SERVER_MEMBERS) {
    f.print(`    this.${member} = service.${member};`);
  }

  f.print('  }');
  f.print('}');

  // * the client: a requester of each procedure its server answers, by its name
  f.print();
  f.print(
    f.jsDoc(
      `The client side of \`${shown}\`, over one Bead client: a requester of each procedure its server answers, by its name.`
    )
  );
  f.print(f.export('class', `${name}Client`), ' {');

  for (const procedure of answered) {
    f.print(
      f.jsDoc(procedure.description ?? `The requester of \`${procedure.procedureName}\`.`, '  ')
    );
    f.print(
      `  public readonly ${procedure.procedureName}: `,
      client,
      `['request']['${procedure.procedureName}'];`
    );
  }

  f.print(
    f.jsDoc(
      'The notification of each procedure that notifies, at the window its options gave, or unpaced.',
      '  '
    )
  );
  f.print('  public readonly notifications: ', client, "['notifications'];");
  f.print(f.jsDoc('Registers the resolver of a command it answers, by its name.', '  '));
  f.print('  public readonly on: ', client, "['on'];");
  f.print();
  f.print(
    f.jsDoc(
      'Its Bead client, and its options: the windows of its notifications, and whether it validates.',
      '  '
    )
  );
  f.print(
    '  public constructor(client: Parameters<typeof ',
    fromRuntime('createServiceClient'),
    `>[1]['client'], options: ${name}ClientOptions = {}) {`
  );
  f.print(
    '    const service = ',
    fromRuntime('createServiceClient'),
    `(${procedures}, { ...options, client });`
  );
  f.print();

  for (const procedure of answered) {
    f.print(`    this.${procedure.procedureName} = service.request.${procedure.procedureName};`);
  }

  f.print('    this.notifications = service.notifications;');
  f.print('    this.on = service.on;');
  f.print('  }');
  f.print('}');
};
