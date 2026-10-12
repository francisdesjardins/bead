// ── Templates ─────────────────────────────────────────────────────────────────

// What the C# target prints for one service (decision 0022): its descriptors; its catalogue and a
// class of failures for each procedure that lists any; the records of its hooks and of its windows,
// which the service layer's options take typed by the service; the sealed classes its server and its
// client hold, a member a command, a procedure that notifies or its notification; a server class
// where only resolvers are written; and a client class holding a requester of each procedure by its
// rpc's name. The file's contract with the runtime follows its services. Every type is qualified
// from `global::`, so no type of the namespace takes a runtime type's place; every description goes
// through `docOf`, the one writer of a documentation comment.

// dependencies

import type {
  AdmissionRule,
  IBinding,
  IProcedureEntry,
  IServiceEntry,
} from '../../model/blueprint.ts';
import { csharpNameOfFailure } from '../names.ts';

// types

/** What a service is printed with. */
export interface ICSharpTemplateOptions {
  /** The C# type of a message a `proto` binding names, by its full name, qualified. */
  readonly messageOf: (fullName: string) => string;
}

// a member of a record or a holder: its documentation's lines, then its declaration
interface IMember {
  readonly doc: readonly string[];
  readonly declaration: string;
}

// constants

const INDENT = '    ';

// the type and the codec of each encoding that is no message's
const NATIVE = Object.freeze({
  raw: ['global::System.ReadOnlyMemory<byte>', 'global::Bead.PayloadCodecs.Raw'],
  text: ['string', 'global::Bead.PayloadCodecs.Text'],
  json: ['global::System.Text.Json.JsonElement', 'global::Bead.PayloadCodecs.Json'],
} as const);

// ! the characters C# reads as a line's end besides LF (ECMA-334, new-line-character), each of which
// would end a `///` line or a string literal: CR, NEL, LS and PS
const LINE_ENDS = /[\r\u{85}\u{2028}\u{2029}]/gu;

const DICTIONARY = 'global::System.Collections.Generic.Dictionary';
const READ_ONLY_DICTIONARY = 'global::System.Collections.Generic.IReadOnlyDictionary';

// the decoder's nesting limit, spec 17.9's bound, as the C# side reads a payload
const RECURSION_LIMIT = 101;

// helpers

const upperFirst = (name: string): string => {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

const hexOf = (character: string): string => {
  return (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
};

// text as an XML documentation comment holds it, a line's end as its reference
const xmlOf = (text: string): string => {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(LINE_ENDS, (character) => {
      return `&#x${hexOf(character).replace(/^0+/u, '')};`;
    });
};

/** A string as a C# literal, whatever it holds: JSON's escapes, and C#'s other line ends besides. */
export const literalOf = (text: string): string => {
  return JSON.stringify(text).replace(LINE_ENDS, (character) => {
    return `\\u${hexOf(character)}`;
  });
};

/**
 * `text` as `///` lines at `indent`: `markup`, the template's own words, its XML written as is, then
 * the description, XML-escaped, then `suffix` after its last line; one `<summary>` line for one line
 * of one paragraph, a `<para>` a paragraph for two or more.
 */
export const docOf = (
  text: { readonly markup?: string; readonly description?: string; readonly suffix?: string },
  indent: string
): string[] => {
  const paragraphs = [
    ...(text.markup === undefined ? [] : [[text.markup]]),
    ...(text.description === undefined
      ? []
      : text.description.split(/\n[ \t]*\n/u).map((paragraph) => {
          return paragraph.split('\n').map(xmlOf);
        })),
  ];

  // the template's own words, after the description's last line, or alone
  if (text.suffix !== undefined) {
    const last = paragraphs.at(-1);

    if (last === undefined) {
      paragraphs.push([text.suffix]);
    } else {
      last[last.length - 1] = `${String(last.at(-1))} ${text.suffix}`;
    }
  }

  const [first] = paragraphs;

  if (paragraphs.length === 1 && first?.length === 1) {
    return [`${indent}/// <summary>${String(first[0])}</summary>`];
  }

  const lines =
    paragraphs.length === 1
      ? (first ?? [])
      : paragraphs.flatMap((paragraph) => {
          return paragraph.map((line, at) => {
            return `${at === 0 ? '<para>' : ''}${line}${at === paragraph.length - 1 ? '</para>' : ''}`;
          });
        });

  return [
    `${indent}/// <summary>`,
    ...lines.map((line) => {
      return `${indent}/// ${line}`;
    }),
    `${indent}/// </summary>`,
  ];
};

// what a procedure admits, in the words its doc comment ends with, as the TypeScript target writes them
const admitsOf = (admission: AdmissionRule): string => {
  if (admission === 'none') {
    return 'Admits every call.';
  }

  if (admission === 'session') {
    return 'Admits a call in a session.';
  }

  return `Admits a call its hook <c>${xmlOf(admission.hook)}</c> admits.`;
};

const admissionOf = (admission: AdmissionRule): string => {
  if (admission === 'none') {
    return 'global::Bead.AdmissionRule.None';
  }

  if (admission === 'session') {
    return 'global::Bead.AdmissionRule.Session';
  }

  return `global::Bead.AdmissionRule.Hook(${literalOf(admission.hook)})`;
};

// the procedure as the runtime takes it, its members in the record's order
const procedureOf = (procedure: IProcedureEntry, service: IServiceEntry): string => {
  const members = [
    `ServiceId = ${String(service.serviceId)}`,
    `ProcedureId = ${String(procedure.procedureId)}`,
    `ProcedureName = ${literalOf(procedure.procedureName)}`,
    `ServiceRevision = ${String(service.serviceRevision)}`,
    ...(procedure.maximumPayloadBytes === undefined
      ? []
      : [`MaximumPayloadBytes = ${String(procedure.maximumPayloadBytes)}`]),
    ...(procedure.deprecation === undefined
      ? []
      : [
          procedure.deprecation.message === undefined
            ? 'Deprecation = new global::Bead.ProcedureDeprecation()'
            : `Deprecation = new global::Bead.ProcedureDeprecation { Message = ${literalOf(procedure.deprecation.message)} }`,
        ]),
  ];

  return `new global::Bead.Procedure { ${members.join(', ')} }`;
};

// an object initializer of `type` at `indent`, each member on a line of its own, or `new T()`
const initializerOf = (
  type: string,
  details: { readonly members: readonly (readonly [string, string])[]; readonly indent: string }
): string[] => {
  const { members, indent } = details;

  return members.length === 0
    ? [`new ${type}()`]
    : [
        `new ${type}`,
        `${indent}{`,
        ...members.map(([member, value]) => {
          return `${indent}${INDENT}${member} = ${value},`;
        }),
        `${indent}}`,
      ];
};

// a statement, `head` then a value of several lines at `indent`, its last line ending it
const statementOf = (
  head: string,
  details: { readonly value: readonly string[]; readonly indent: string }
): string[] => {
  const [first, ...rest] = details.value;

  if (rest.length === 0) {
    return [`${details.indent}${head}${String(first)};`];
  }

  return [
    `${details.indent}${head}${String(first)}`,
    ...rest.slice(0, -1),
    `${String(rest.at(-1))};`,
  ];
};

// definition

/** Prints `service` as lines of C#, in the file's namespace. */
export const printService = (service: IServiceEntry, options: ICSharpTemplateOptions): string[] => {
  const name = service.serviceName;
  const shown = `<c>${service.proto?.fullName ?? name}</c>`;
  const procedures = `${name}Procedures`;
  const failures = `${name}Failures`;
  const codes = new Map(
    service.failures.map((failure) => {
      return [failure.failureName, failure] as const;
    })
  );
  const answered = service.procedures.filter((procedure) => {
    return procedure.procedureKind !== 'command';
  });
  const commands = service.procedures.filter((procedure) => {
    return procedure.procedureKind === 'command';
  });
  const notifying = service.procedures.filter((procedure) => {
    return procedure.procedureKind === 'notifies';
  });
  const hooks = [
    ...new Set(
      service.procedures.flatMap((procedure) => {
        return typeof procedure.admission === 'object' ? [procedure.admission.hook] : [];
      })
    ),
  ].sort();
  const typeOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? options.messageOf(binding.message)
      : NATIVE[binding.encoding as keyof typeof NATIVE][0];
  };
  const notifiedOf = (procedure: IProcedureEntry): string => {
    return typeOf(procedure.notification ?? procedure.result);
  };
  const failureOf = (procedure: IProcedureEntry): string => {
    return procedure.failures.length === 0
      ? 'global::Bead.NoFailure'
      : `${failures}.${upperFirst(procedure.procedureName)}`;
  };
  const typesOf = (procedure: IProcedureEntry): string => {
    return [
      typeOf(procedure.request),
      typeOf(procedure.result),
      ...(procedure.notification === undefined ? [] : [typeOf(procedure.notification)]),
    ].join(', ');
  };
  const descriptorOf = (procedure: IProcedureEntry): string => {
    const kind = procedure.procedureKind === 'command' ? 'CommandProcedure' : 'RequestProcedure';

    return `global::Bead.${kind}<${procedures}, ${typesOf(procedure)}, ${failureOf(procedure)}>`;
  };
  const requesterOf = (procedure: IProcedureEntry): string => {
    return `global::System.Func<${typeOf(procedure.request)}, global::Bead.BoundCall<${typeOf(procedure.result)}>>`;
  };
  const requesterDocOf = (procedure: IProcedureEntry, indent: string): string[] => {
    return docOf(
      procedure.description === undefined
        ? { markup: `The requester of <c>${procedure.procedureName}</c>.` }
        : { description: procedure.description },
      indent
    );
  };
  // a codec, at `indent`, the lines after its first indented one level more
  const codecOf = (binding: IBinding, indent: string): string[] => {
    if (binding.encoding !== 'proto' || binding.message === undefined) {
      return [NATIVE[binding.encoding as keyof typeof NATIVE][1]];
    }

    const message = options.messageOf(binding.message);
    const inner = `${indent}${INDENT}`;
    const body = `${inner}${INDENT}`;

    return [
      `global::Bead.PayloadCodecs.Of<${message}>(`,
      `${inner}(bytes) =>`,
      `${inner}{`,
      `${body}// ! spec 17.9's bound, set here rather than left to the library's default. The payload is`,
      `${body}// read as a message field holds one, after its length, and the top message counts: 101 is`,
      `${body}// 100 below it`,
      `${body}var framed = new byte[global::Google.Protobuf.CodedOutputStream.ComputeLengthSize(bytes.Length) + bytes.Length];`,
      '',
      `${body}using (var output = new global::Google.Protobuf.CodedOutputStream(framed))`,
      `${body}{`,
      `${body}${INDENT}output.WriteLength(bytes.Length);`,
      `${body}}`,
      '',
      `${body}bytes.Span.CopyTo(framed.AsSpan(framed.Length - bytes.Length));`,
      '',
      `${body}using var stream = new global::System.IO.MemoryStream(framed, writable: false);`,
      `${body}using var input = global::Google.Protobuf.CodedInputStream.CreateWithLimits(stream, int.MaxValue, ${String(RECURSION_LIMIT)});`,
      `${body}var message = new ${message}();`,
      '',
      `${body}input.ReadMessage(message);`,
      '',
      `${body}return message;`,
      `${inner}},`,
      `${inner}(message) =>`,
      `${inner}{`,
      `${body}return global::Google.Protobuf.MessageExtensions.ToByteArray(message);`,
      `${inner}})`,
    ];
  };
  const lines: string[] = [];
  // a sealed class of `members`; for a record the layer reads, the interface it implements and the
  // dictionary its `ToDictionary` gives, each member by the name its procedures give it
  const classOf = (
    details: {
      readonly type: string;
      readonly doc: string;
      readonly record?: {
        readonly entry: string;
        readonly names: readonly (readonly [string, string])[];
      };
    },
    members: readonly IMember[]
  ): void => {
    const { type, record } = details;
    const implemented =
      record === undefined
        ? undefined
        : `global::Bead.IService${type.slice(name.length)}<${procedures}>`;

    lines.push(
      '',
      `/// <summary>${details.doc}</summary>`,
      `public sealed class ${type}${implemented === undefined ? '' : ` : ${implemented}`}`,
      '{'
    );
    members.forEach((member, at) => {
      lines.push(...(at === 0 ? [] : ['']), ...member.doc, `${INDENT}${member.declaration}`);
    });

    if (record !== undefined && implemented !== undefined) {
      const dictionary = `${DICTIONARY}<string, ${record.entry}>`;

      lines.push(
        ...(members.length === 0 ? [] : ['']),
        `${INDENT}${READ_ONLY_DICTIONARY}<string, ${record.entry}> ${implemented}.ToDictionary()`,
        `${INDENT}{`,
        ...statementOf('return ', {
          value: initializerOf(dictionary, {
            members: record.names.map(([key, member]) => {
              return [`[${literalOf(key)}]`, member] as const;
            }),
            indent: `${INDENT}${INDENT}`,
          }),
          indent: `${INDENT}${INDENT}`,
        }),
        `${INDENT}}`
      );
    }

    lines.push('}');
  };

  // * the descriptors: the service's type tag, a descriptor a procedure, and all of them
  lines.push(
    ...docOf(
      {
        markup: `The procedures of ${shown}: service ${String(service.serviceId)}, revision ${String(service.serviceRevision)}.`,
        ...(service.description === undefined ? {} : { description: service.description }),
      },
      ''
    ),
    `public sealed class ${procedures}`,
    '{',
    `${INDENT}private ${procedures}()`,
    `${INDENT}{`,
    `${INDENT}}`
  );

  for (const procedure of service.procedures) {
    const bindings = `global::Bead.ProcedureBindings<${typesOf(procedure)}>`;
    const member = `${INDENT}${INDENT}${INDENT}`;
    const codecLines = (key: string, binding: IBinding): string[] => {
      const [first, ...rest] = codecOf(binding, member);

      const all = [`${member}${key} = ${String(first)}`, ...rest];

      return all.map((line, at) => {
        return at === all.length - 1 ? `${line},` : line;
      });
    };

    lines.push(
      '',
      ...docOf(
        {
          ...(procedure.description === undefined ? {} : { description: procedure.description }),
          suffix: admitsOf(procedure.admission),
        },
        INDENT
      ),
      `${INDENT}public static ${descriptorOf(procedure)} ${upperFirst(procedure.procedureName)} { get; } = new(`,
      `${INDENT}${INDENT}${procedureOf(procedure, service)},`,
      `${INDENT}${INDENT}new ${bindings}`,
      `${INDENT}${INDENT}{`,
      `${member}Admission = ${admissionOf(procedure.admission)},`,
      ...codecLines('Request', procedure.request),
      ...codecLines('Result', procedure.result),
      ...(procedure.notification === undefined
        ? []
        : codecLines('Notification', procedure.notification)),
      `${INDENT}${INDENT}});`
    );
  }

  lines.push(
    '',
    `${INDENT}/// <summary>Every procedure, in their ids' order: what its server and its client sides are built over.</summary>`,
    `${INDENT}public static global::System.Collections.Generic.IReadOnlyList<global::Bead.IServiceProcedure<${procedures}>> All { get; } =`,
    `${INDENT}[`,
    ...service.procedures.map((procedure) => {
      return `${INDENT}${INDENT}${upperFirst(procedure.procedureName)},`;
    }),
    `${INDENT}];`,
    '}'
  );

  // * the catalogue, and a class of failures a procedure that lists any, its values its own
  lines.push(
    '',
    `/// <summary>The failures of ${shown}: service ${String(service.serviceId)}'s catalogue, and whether a failure received is one of it.</summary>`,
    `public static class ${failures}`,
    '{'
  );

  for (const procedure of service.procedures.filter((each) => {
    return each.failures.length > 0;
  })) {
    const rpc = upperFirst(procedure.procedureName);

    lines.push(
      `${INDENT}/// <summary>The failures <c>${procedure.procedureName}</c> may answer, and no other.</summary>`,
      `${INDENT}public sealed class ${rpc} : global::Bead.IApplicationFailure`,
      `${INDENT}{`,
      `${INDENT}${INDENT}private readonly ushort _code;`,
      '',
      `${INDENT}${INDENT}private ${rpc}(ushort code)`,
      `${INDENT}${INDENT}{`,
      `${INDENT}${INDENT}${INDENT}_code = code;`,
      `${INDENT}${INDENT}}`
    );

    for (const failureName of procedure.failures) {
      const failure = codes.get(failureName);

      lines.push(
        '',
        ...docOf(
          failure?.description === undefined
            ? { markup: `The failure <c>${failureName}</c>.` }
            : { description: failure.description },
          `${INDENT}${INDENT}`
        ),
        `${INDENT}${INDENT}public static ${rpc} ${csharpNameOfFailure(failureName)} { get; } = new(${String(failure?.code)});`
      );
    }

    lines.push(
      '',
      `${INDENT}${INDENT}/// <summary>Its code, from 1 to 65,535 (spec 9.5).</summary>`,
      `${INDENT}${INDENT}public ushort Code`,
      `${INDENT}${INDENT}{`,
      `${INDENT}${INDENT}${INDENT}get`,
      `${INDENT}${INDENT}${INDENT}{`,
      `${INDENT}${INDENT}${INDENT}${INDENT}return _code;`,
      `${INDENT}${INDENT}${INDENT}}`,
      `${INDENT}${INDENT}}`,
      `${INDENT}}`,
      ''
    );
  }

  lines.push(
    `${INDENT}/// <summary>Whether <paramref name="exception"/> is <paramref name="failure"/>, answered by a procedure of this service.</summary>`,
    `${INDENT}public static bool Is(global::Bead.FailureException exception, global::Bead.IApplicationFailure failure)`,
    `${INDENT}{`,
    `${INDENT}${INDENT}return new global::Bead.FailureCatalogue(${String(service.serviceId)}).Is(exception, failure);`,
    `${INDENT}}`,
    '}'
  );

  // * the records the layer's options take, typed by the service, and the classes its sides hold
  classOf(
    {
      type: `${name}Admissions`,
      doc:
        hooks.length === 0
          ? `The hooks of ${shown}: none, since no procedure names one.`
          : `The hooks of ${shown}, each by the name its procedures give it: every one is required.`,
      record: {
        entry: 'global::Bead.AdmissionHook',
        names: hooks.map((hook) => {
          return [hook, upperFirst(hook)] as const;
        }),
      },
    },
    hooks.map((hook) => {
      const admitted = service.procedures
        .filter((procedure) => {
          return typeof procedure.admission === 'object' && procedure.admission.hook === hook;
        })
        .map((procedure) => {
          return `<c>${procedure.procedureName}</c>`;
        })
        .join(', ');

      return {
        doc: [
          `${INDENT}/// <summary>The hook <c>${hook}</c>, which admits a call to ${admitted}.</summary>`,
        ],
        declaration: `public required global::Bead.AdmissionHook ${upperFirst(hook)} { get; init; }`,
      };
    })
  );
  classOf(
    {
      type: `${name}Commands`,
      doc: `The requester of each command of ${shown}, its server's, by its rpc's name.`,
    },
    commands.map((procedure) => {
      return {
        doc: requesterDocOf(procedure, INDENT),
        declaration: `public required ${requesterOf(procedure)} ${upperFirst(procedure.procedureName)} { get; init; }`,
      };
    })
  );
  classOf(
    {
      type: `${name}Notifiers`,
      doc: `What notifies the subscribers of each procedure of ${shown} that notifies.`,
    },
    notifying.map((procedure) => {
      return {
        doc: [
          `${INDENT}/// <summary>Notifies the subscribers of <c>${procedure.procedureName}</c>.</summary>`,
        ],
        declaration: `public required global::System.Func<${notifiedOf(procedure)}, global::Bead.NotifyOptions?, global::System.Threading.Tasks.Task> ${upperFirst(procedure.procedureName)} { get; init; }`,
      };
    })
  );
  classOf(
    {
      type: `${name}Windows`,
      doc: `The window each procedure of ${shown} that notifies is asked for; none, unpaced.`,
      record: {
        entry: 'int?',
        names: notifying.map((procedure) => {
          return [procedure.procedureName, upperFirst(procedure.procedureName)] as const;
        }),
      },
    },
    notifying.map((procedure) => {
      return {
        doc: [
          `${INDENT}/// <summary>The window of <c>${procedure.procedureName}</c>, a whole number above 0.</summary>`,
        ],
        declaration: `public int? ${upperFirst(procedure.procedureName)} { get; init; }`,
      };
    })
  );
  classOf(
    {
      type: `${name}Notifications`,
      doc: `The notification of each procedure of ${shown} that notifies.`,
    },
    notifying.map((procedure) => {
      return {
        doc: [
          `${INDENT}/// <summary>The notification of <c>${procedure.procedureName}</c>.</summary>`,
        ],
        declaration: `public required global::Bead.INotification<${typeOf(procedure.request)}, ${notifiedOf(procedure)}> ${upperFirst(procedure.procedureName)} { get; init; }`,
      };
    })
  );

  // * the server: the layer's members, its options the layer's, typed by the service
  const server = `${name}Server`;
  const layer = `global::Bead.ServiceServer<${procedures}, TData>`;
  const serverOptions = `global::Bead.ServiceServerOptions<${procedures}>`;
  const holders = [
    ...statementOf('Command = ', {
      value: initializerOf(`${name}Commands`, {
        members: commands.map((procedure) => {
          const rpc = upperFirst(procedure.procedureName);

          return [rpc, `_service.CommandOf(${procedures}.${rpc})`] as const;
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      indent: `${INDENT}${INDENT}`,
    }),
    ...statementOf('Notify = ', {
      value: initializerOf(`${name}Notifiers`, {
        members: notifying.map((procedure) => {
          const rpc = upperFirst(procedure.procedureName);

          return [rpc, `_service.NotifierOf(${procedures}.${rpc})`] as const;
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      indent: `${INDENT}${INDENT}`,
    }),
  ];

  lines.push(
    '',
    `/// <summary>The server side of ${shown}, offered on one Bead server: only its resolvers are written.</summary>`,
    '/// <typeparam name="TData">What a session of its server keeps.</typeparam>',
    `public sealed class ${server}<TData>`,
    '{',
    `${INDENT}private readonly ${layer} _service;`,
    ''
  );

  if (hooks.length > 0) {
    lines.push(
      `${INDENT}/// <summary>The server side of ${shown}, given the layer's options, its hooks among them, required since a procedure names one: ${hooks.join(', ')}.</summary>`,
      `${INDENT}public ${server}(${serverOptions} options)`,
      `${INDENT}{`,
      `${INDENT}${INDENT}_service = new(${procedures}.All, options);`,
      ...holders,
      `${INDENT}}`
    );
  } else {
    lines.push(
      `${INDENT}/// <summary>The server side of ${shown}, whose procedures name no hook.</summary>`,
      `${INDENT}public ${server}()`,
      `${INDENT}${INDENT}: this(new ${layer}(${procedures}.All))`,
      `${INDENT}{`,
      `${INDENT}}`,
      '',
      `${INDENT}/// <summary>The server side of ${shown}, given the layer's options, which name no hook.</summary>`,
      `${INDENT}public ${server}(${serverOptions} options)`,
      `${INDENT}${INDENT}: this(new ${layer}(${procedures}.All, options))`,
      `${INDENT}{`,
      `${INDENT}}`,
      '',
      `${INDENT}private ${server}(${layer} service)`,
      `${INDENT}{`,
      `${INDENT}${INDENT}_service = service;`,
      ...holders,
      `${INDENT}}`
    );
  }

  lines.push(
    '',
    `${INDENT}/// <summary>The requester of each command, made as the service is offered.</summary>`,
    `${INDENT}public ${name}Commands Command { get; }`,
    '',
    `${INDENT}/// <summary>Notifies each procedure's subscribers.</summary>`,
    `${INDENT}public ${name}Notifiers Notify { get; }`,
    '',
    `${INDENT}/// <summary>Registers a request's resolver, before or after the offer.</summary>`,
    `${INDENT}public void On<TRequest, TResult, TFailure>(`,
    `${INDENT}${INDENT}global::Bead.RequestProcedure<${procedures}, TRequest, TResult, TFailure> procedure,`,
    `${INDENT}${INDENT}global::Bead.ServiceResolverCallback<TRequest, TResult, TFailure> callback)`,
    `${INDENT}${INDENT}where TFailure : global::Bead.IApplicationFailure`,
    `${INDENT}{`,
    `${INDENT}${INDENT}_service.On(procedure, callback);`,
    `${INDENT}}`,
    '',
    `${INDENT}/// <summary>Registers the resolver of a procedure that notifies, before or after the offer.</summary>`,
    `${INDENT}public void On<TRequest, TResult, TNotification, TFailure>(`,
    `${INDENT}${INDENT}global::Bead.RequestProcedure<${procedures}, TRequest, TResult, TNotification, TFailure> procedure,`,
    `${INDENT}${INDENT}global::Bead.ServiceNotificationResolverCallback<TRequest, TResult, TFailure> callback)`,
    `${INDENT}${INDENT}where TFailure : global::Bead.IApplicationFailure`,
    `${INDENT}{`,
    `${INDENT}${INDENT}_service.On(procedure, callback);`,
    `${INDENT}}`,
    '',
    `${INDENT}/// <summary>Offers every resolver, now and later, on <paramref name="server"/>, once.</summary>`,
    `${INDENT}public void Offer(global::Bead.IBeadServer<TData> server)`,
    `${INDENT}{`,
    `${INDENT}${INDENT}_service.Offer(server);`,
    `${INDENT}}`,
    '',
    `${INDENT}/// <summary>The procedures a client calls that no resolver answers yet.</summary>`,
    `${INDENT}public global::System.Collections.Generic.IReadOnlyList<global::Bead.Procedure> ProceduresWithoutResolver()`,
    `${INDENT}{`,
    `${INDENT}${INDENT}return _service.ProceduresWithoutResolver();`,
    `${INDENT}}`,
    '}'
  );

  // * the client: a requester of each procedure its server answers, by its rpc's name
  const client = `${name}Client`;

  lines.push(
    '',
    `/// <summary>The client side of ${shown}, over one Bead client: a requester of each procedure its server answers, by its name.</summary>`,
    `public sealed class ${client}`,
    '{',
    `${INDENT}private readonly global::Bead.ServiceClient<${procedures}> _service;`,
    '',
    `${INDENT}/// <summary>The client side of ${shown}, over its Bead client, given the layer's options: the windows of its notifications, and whether it validates.</summary>`,
    `${INDENT}public ${client}(global::Bead.IClient client, global::Bead.ServiceClientOptions<${procedures}>? options = null)`,
    `${INDENT}{`,
    `${INDENT}${INDENT}_service = new(${procedures}.All, client, options);`,
    ...answered.map((procedure) => {
      const rpc = upperFirst(procedure.procedureName);

      return `${INDENT}${INDENT}${rpc} = _service.RequesterOf(${procedures}.${rpc});`;
    }),
    ...statementOf('Notifications = ', {
      value: initializerOf(`${name}Notifications`, {
        members: notifying.map((procedure) => {
          const rpc = upperFirst(procedure.procedureName);

          return [rpc, `_service.NotificationOf(${procedures}.${rpc})`] as const;
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      indent: `${INDENT}${INDENT}`,
    }),
    `${INDENT}}`
  );

  for (const procedure of answered) {
    lines.push(
      '',
      ...requesterDocOf(procedure, INDENT),
      `${INDENT}public ${requesterOf(procedure)} ${upperFirst(procedure.procedureName)} { get; }`
    );
  }

  lines.push(
    '',
    `${INDENT}/// <summary>The notification of each procedure that notifies, at the window its options gave, or unpaced.</summary>`,
    `${INDENT}public ${name}Notifications Notifications { get; }`,
    '',
    `${INDENT}/// <summary>Registers the resolver of a command it answers.</summary>`,
    `${INDENT}public void On<TRequest, TResult, TFailure>(`,
    `${INDENT}${INDENT}global::Bead.CommandProcedure<${procedures}, TRequest, TResult, TFailure> procedure,`,
    `${INDENT}${INDENT}global::Bead.ServiceResolverCallback<TRequest, TResult, TFailure> callback)`,
    `${INDENT}${INDENT}where TFailure : global::Bead.IApplicationFailure`,
    `${INDENT}{`,
    `${INDENT}${INDENT}_service.On(procedure, callback);`,
    `${INDENT}}`,
    '}'
  );

  return lines;
};
