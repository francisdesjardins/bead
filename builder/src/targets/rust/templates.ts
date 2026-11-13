// ── Templates ─────────────────────────────────────────────────────────────────

// What the Rust target prints for one service (decision 0051): its descriptors, made once a process
// behind a `LazyLock`, since the service layer matches a descriptor by its identity; its catalogue,
// a constant a failure; the records of its hooks and of its windows, and the options its server and
// its client side take; the records of the handles its sides hold, a field a requester, a command, a
// notifier or a notification; a server where only resolvers are written, one `on_<procedure>` a
// procedure it serves; and a client holding a requester of each procedure its server answers. Each
// side and the records it holds are printed over the procedures it holds, a side that holds none
// left out (decision 0048). A `proto` binding's codec is `bead_protobuf`'s of its message, which
// Buffa writes under the output's `messages` root, and a request whose message holds rules is judged
// by its generated rules (decision 0035). Every runtime item is named from its crate's root,
// `::bead::…`, `::bead_protobuf::…`, `::std::…`, `::core::…`, so no item of the module takes its
// place. Every description goes through `docOf`, the one writer of a documentation comment, and
// every deprecation through `deprecatedOf`, the one writer of the mark, on each item the file
// writes for it, as `#[deprecated]` marks a deprecated item in Rust.

// dependencies

import type {
  AdmissionRule,
  IBinding,
  IDeprecation,
  IProcedureEntry,
  IServiceEntry,
} from '../../model/blueprint.ts';
import { deprecationTextOf } from '../target.ts';
import { identifierOf, snakeIdentifierOf, toSnakeCase } from './names.ts';

// types

/** What a service is printed with. */
export interface IRustTemplateOptions {
  /** A message's path from the service's module, by its full name: `super::super::messages::…`. */
  readonly messageOf: (fullName: string) => string;
  /** The rules of each message a request's rules reach, by its full name: their function's name. */
  readonly validators: ReadonlyMap<string, string>;
  /** The procedures its server holds, by their names; none, no server. */
  readonly served: ReadonlySet<string> | undefined;
  /** The procedures its client holds, by their names; none, no client. */
  readonly called: ReadonlySet<string> | undefined;
}

// a field of a record: its documentation's and its marks' lines, then its declaration
interface IField {
  readonly doc: readonly string[];
  readonly declaration: string;
}

// constants

/** One level of indentation, rustfmt's. */
export const INDENT = '    ';

// the codec of each encoding that is no message's, a value of its own type
const NATIVE = Object.freeze({
  raw: '::bead::RawCodec',
  text: '::bead::TextCodec',
  json: '::bead::JsonCodec',
} as const);

const ERROR = '::bead::ProgrammerError';
const ERROR_LINK = `[\`ProgrammerError\`](${ERROR})`;

// ! the characters rustc refuses in a comment or a literal: a lone CR, which ends no line of Rust's,
// and the bidirectional controls of CVE-2021-42574 (`text_direction_codepoint_in_comment` and
// `_in_literal`)
const REFUSED = /[\r\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

// helpers

const hexOf = (character: string): string => {
  return (character.codePointAt(0) ?? 0).toString(16).toUpperCase();
};

// text as an HTML block holds it: `&`, `<` and `>` by their entities, and each character rustc
// refuses in a comment by its numeric reference
const htmlOf = (text: string): string => {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(REFUSED, (character) => {
      return `&#x${hexOf(character)};`;
    });
};

/**
 * A string as a Rust literal, whatever it holds: `\` and `"` escaped, a line's end, a tab and every
 * other control character, and each character rustc refuses in a literal, as `\u{…}` or its own
 * escape.
 */
export const literalOf = (text: string): string => {
  const escaped = Array.from(text)
    .map((character) => {
      if (character === '\\' || character === '"') {
        return `\\${character}`;
      }

      if (character === '\n') {
        return '\\n';
      }

      if (character === '\r') {
        return '\\r';
      }

      if (character === '\t') {
        return '\\t';
      }

      // oxlint-disable-next-line no-control-regex -- the controls are the characters it escapes
      return /[\u{0}-\u{1F}\u{7F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(character)
        ? `\\u{${hexOf(character)}}`
        : character;
    })
    .join('');

  return `"${escaped}"`;
};

/**
 * `text` as `///` lines at `indent`: `summary`, beadc's own line, in Markdown, then the
 * description, an HTML block of one `<p>` a paragraph, its text escaped as HTML's (CommonMark
 * 0.31.2, §4.6), so that rustdoc reads no Markdown of it; then `sections`, the template's own, each
 * a heading and its lines.
 */
export const docOf = (
  text: {
    readonly summary: string;
    readonly description?: string | undefined;
    readonly sections?: readonly string[];
  },
  indent: string
): string[] => {
  const paragraphs =
    text.description === undefined
      ? []
      : text.description.split(/\n[ \t]*\n/u).map((paragraph) => {
          const lines = paragraph.split('\n').map(htmlOf);

          return lines.map((line, at) => {
            return `${at === 0 ? '<p>' : ''}${line}${at === lines.length - 1 ? '</p>' : ''}`;
          });
        });
  const blocks = [
    [text.summary],
    ...paragraphs,
    ...(text.sections ?? []).map((section) => {
      return section.split('\n');
    }),
  ];

  return blocks.flatMap((block, at) => {
    return [
      ...(at === 0 ? [] : [`${indent}///`]),
      ...block.map((line) => {
        return line === '' ? `${indent}///` : `${indent}/// ${line}`;
      }),
    ];
  });
};

/** The mark of `deprecation` at `indent`: none, or one `#[deprecated]` line with its text. */
export const deprecatedOf = (deprecation: IDeprecation | undefined, indent: string): string[] => {
  return deprecation === undefined
    ? []
    : [`${indent}#[deprecated(note = ${literalOf(deprecationTextOf(deprecation))})]`];
};

// what a procedure admits, in the words its documentation ends with
const admitsOf = (admission: AdmissionRule): string => {
  if (admission === 'none') {
    return 'every call';
  }

  if (admission === 'session') {
    return 'a call in a session';
  }

  return `a call its hook \`${admission.hook}\` admits`;
};

const admissionOf = (admission: AdmissionRule): string => {
  if (admission === 'none') {
    return '::bead::AdmissionRule::None';
  }

  if (admission === 'session') {
    return '::bead::AdmissionRule::Session';
  }

  return `::bead::AdmissionRule::Hook(${literalOf(admission.hook)})`;
};

// the `# Errors` section of a function that answers a `ProgrammerError`
const errorsOf = (cause: string): string => {
  return `# Errors\n\nA ${ERROR_LINK} ${cause}.`;
};

// a struct of `fields` at the file's root, after its documentation and marks; a unit struct where
// it holds none
const structOf = (
  head: { readonly doc: readonly string[]; readonly derives: string; readonly name: string },
  fields: readonly IField[]
): string[] => {
  if (fields.length === 0) {
    return [...head.doc, head.derives, `pub struct ${head.name};`];
  }

  return [
    ...head.doc,
    head.derives,
    `pub struct ${head.name} {`,
    ...fields.flatMap((field) => {
      return [...field.doc, `${INDENT}${field.declaration}`];
    }),
    '}',
  ];
};

// a value of a record of `fields`, each `name: value` on a line of its own at `indent`; its name
// alone for a unit struct
const recordValueOf = (
  name: string,
  details: { readonly fields: readonly (readonly [string, string])[]; readonly indent: string }
): string[] => {
  if (details.fields.length === 0) {
    return [name];
  }

  return [
    `${name} {`,
    ...details.fields.map(([field, value]) => {
      return `${details.indent}${INDENT}${field}: ${value},`;
    }),
    `${details.indent}}`,
  ];
};

// a `let` of `value`, its first line after `head`, its last ending the statement
const letOf = (
  head: string,
  details: { readonly value: readonly string[]; readonly indent: string }
) => {
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

/**
 * Prints `service` as lines of Rust, in its package's module: its server and the records it holds
 * over the procedures `options.served` names, its client and its own over those `options.called`
 * names, each side left out where it names none (decision 0048).
 */
export const printService = (service: IServiceEntry, options: IRustTemplateOptions): string[] => {
  const name = service.serviceName;
  const shown = `\`${service.proto?.fullName ?? name}\``;
  const procedures = `${name}Procedures`;
  const failures = `${name}Failures`;
  const pickOf = (
    names: ReadonlySet<string> | undefined
  ): readonly IProcedureEntry[] | undefined => {
    if (names === undefined || names.size === 0) {
      return undefined;
    }

    return service.procedures.filter((procedure) => {
      return names.has(procedure.procedureName);
    });
  };
  const servedPick = pickOf(options.served);
  const calledPick = pickOf(options.called);
  const served = servedPick ?? [];
  const called = calledPick ?? [];
  const answered = called.filter((procedure) => {
    return procedure.procedureKind !== 'command';
  });
  const commands = served.filter((procedure) => {
    return procedure.procedureKind === 'command';
  });
  const answering = served.filter((procedure) => {
    return procedure.procedureKind !== 'command';
  });
  const notifying = served.filter((procedure) => {
    return procedure.procedureKind === 'notifies';
  });
  const notified = called.filter((procedure) => {
    return procedure.procedureKind === 'notifies';
  });
  const answeredCommands = called.filter((procedure) => {
    return procedure.procedureKind === 'command';
  });
  const hooks = [
    ...new Set(
      served.flatMap((procedure) => {
        return typeof procedure.admission === 'object' ? [procedure.admission.hook] : [];
      })
    ),
  ].sort();
  // a procedure's own deprecation, or its service's, which a blueprint written by hand may give alone
  const deprecationOf = (procedure: IProcedureEntry): IDeprecation | undefined => {
    return procedure.deprecation ?? service.deprecation;
  };
  // * every type the file declares for a deprecated service is marked
  const serviceMark = deprecatedOf(service.deprecation, '');
  const fieldOf = (procedure: IProcedureEntry): string => {
    return snakeIdentifierOf(procedure.procedureName);
  };
  const codecTypeOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? `::bead_protobuf::ProtoCodec<${options.messageOf(binding.message)}>`
      : NATIVE[binding.encoding as keyof typeof NATIVE];
  };
  const codecOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? '::bead_protobuf::ProtoCodec::new()?'
      : NATIVE[binding.encoding as keyof typeof NATIVE];
  };
  // the value a codec reads and writes: a message's own type, a native codec's by its trait
  const valueOf = (binding: IBinding): string => {
    return binding.encoding === 'proto' && binding.message !== undefined
      ? options.messageOf(binding.message)
      : `<${codecTypeOf(binding)} as ::bead::PayloadCodec>::Value`;
  };
  const notificationOf = (procedure: IProcedureEntry): IBinding => {
    return procedure.notification ?? procedure.result;
  };
  const pairOf = (procedure: IProcedureEntry): string => {
    return `${codecTypeOf(procedure.request)}, ${codecTypeOf(procedure.result)}`;
  };
  const descriptorTypeOf = (procedure: IProcedureEntry): string => {
    return procedure.procedureKind === 'notifies'
      ? `::bead::NotifyingDescriptor<${pairOf(procedure)}, ${codecTypeOf(notificationOf(procedure))}>`
      : `::bead::Descriptor<${pairOf(procedure)}>`;
  };
  const lines: string[] = [];

  // * the descriptors: a field a procedure, made once a process
  lines.push(
    ...structOf(
      {
        doc: [
          ...docOf(
            {
              summary: `The procedures of ${shown}: service ${String(service.serviceId)}, revision ${String(service.serviceRevision)}.`,
              description: service.description,
            },
            ''
          ),
          ...serviceMark,
          '#[derive(Debug, Clone)]',
        ],
        derives: '#[non_exhaustive]',
        name: procedures,
      },
      service.procedures.map((procedure) => {
        const kind =
          procedure.procedureKind === 'command'
            ? `The command \`${procedure.procedureName}\`, which admits`
            : procedure.procedureKind === 'notifies'
              ? `The procedure \`${procedure.procedureName}\`, which notifies and admits`
              : `The procedure \`${procedure.procedureName}\`, which admits`;

        return {
          doc: [
            ...docOf(
              {
                summary: `${kind} ${admitsOf(procedure.admission)}.`,
                description: procedure.description,
              },
              INDENT
            ),
            ...deprecatedOf(deprecationOf(procedure), INDENT),
          ],
          declaration: `pub ${fieldOf(procedure)}: ${descriptorTypeOf(procedure)},`,
        };
      })
    )
  );

  // * a procedure's descriptor, made by a function of its own, so that no function grows with the
  // service
  const describerOf = (procedure: IProcedureEntry): string[] => {
    const at = `${INDENT}${INDENT}`;
    const deprecation =
      procedure.deprecation === undefined
        ? 'None'
        : procedure.deprecation.message === undefined
          ? 'Some(::bead::Deprecation { message: None })'
          : `Some(::bead::Deprecation { message: Some(${literalOf(procedure.deprecation.message)}.to_owned()) })`;
    const listed = procedure.failures.map((failure) => {
      return `${failures}::${identifierOf(failure)}`;
    });
    const message = procedure.request.message;
    const rules = message === undefined ? undefined : options.validators.get(message);
    const made = procedure.procedureKind === 'notifies' ? `${at}${INDENT}` : at;
    const init = [
      '::bead::DescriptorInit {',
      `${made}${INDENT}procedure: ::bead::Procedure {`,
      `${made}${INDENT}${INDENT}service_id: ${String(service.serviceId)},`,
      `${made}${INDENT}${INDENT}procedure_id: ${String(procedure.procedureId)},`,
      `${made}${INDENT}${INDENT}service_revision: ${String(service.serviceRevision)},`,
      `${made}${INDENT}${INDENT}procedure_name: ${literalOf(procedure.procedureName)}.to_owned(),`,
      `${made}${INDENT}${INDENT}procedure_kind: None,`,
      `${made}${INDENT}${INDENT}maximum_payload_bytes: ${procedure.maximumPayloadBytes === undefined ? 'None' : `Some(${String(procedure.maximumPayloadBytes)})`},`,
      `${made}${INDENT}${INDENT}deprecation: ${deprecation},`,
      `${made}${INDENT}},`,
      `${made}${INDENT}admission: ${admissionOf(procedure.admission)},`,
      `${made}${INDENT}failures: ${listed.length === 0 ? '::std::vec::Vec::new()' : `::std::vec![${listed.join(', ')}]`},`,
      `${made}${INDENT}request: ${codecOf(procedure.request)},`,
      `${made}${INDENT}result: ${codecOf(procedure.result)},`,
      `${made}${INDENT}validate: ${rules === undefined ? 'None' : `Some(::bead_protobuf::validator_of(${rules}))`},`,
      `${made}}`,
    ];
    const kind = procedure.procedureKind === 'command' ? 'command_of' : 'request_of';
    const [first, ...rest] = init;
    const body =
      procedure.procedureKind === 'notifies'
        ? [
            `${at}::bead::notifying_of(`,
            `${at}${INDENT}${init.join('\n')},`,
            `${at}${INDENT}${codecOf(notificationOf(procedure))},`,
            `${at})`,
          ]
        : [
            `${at}::bead::${kind}(${String(first)}`,
            ...rest.slice(0, -1),
            `${String(rest.at(-1))})`,
          ];

    return [
      '',
      `${INDENT}// the descriptor of \`${procedure.procedureName}\``,
      `${INDENT}fn ${fieldOf(procedure)}() -> Result<${descriptorTypeOf(procedure)}, ${ERROR}> {`,
      ...body,
      `${INDENT}}`,
    ];
  };

  lines.push(
    '',
    `impl ${procedures} {`,
    ...docOf(
      {
        summary: `Each procedure of ${shown}, described once a process: the one set its server side and its client side match a descriptor against.`,
        sections: [errorsOf('where the runtime refuses a descriptor or a codec of the service')],
      },
      INDENT
    ),
    `${INDENT}pub fn get() -> Result<&'static Self, ${ERROR}> {`,
    `${INDENT}${INDENT}static PROCEDURES: ::std::sync::LazyLock<Result<${procedures}, ${ERROR}>> =`,
    `${INDENT}${INDENT}${INDENT}::std::sync::LazyLock::new(${procedures}::made);`,
    '',
    `${INDENT}${INDENT}PROCEDURES.as_ref().map_err(::core::clone::Clone::clone)`,
    `${INDENT}}`,
    '',
    `${INDENT}fn made() -> Result<Self, ${ERROR}> {`,
    `${INDENT}${INDENT}Ok(Self {`,
    ...service.procedures.map((procedure) => {
      return `${INDENT}${INDENT}${INDENT}${fieldOf(procedure)}: Self::${fieldOf(procedure)}()?,`;
    }),
    `${INDENT}${INDENT}})`,
    `${INDENT}}`,
    ...service.procedures.flatMap(describerOf),
    '',
    `${INDENT}/// Every procedure, in their ids' order: what its server side and its client side are built over.`,
    `${INDENT}#[must_use]`,
    `${INDENT}pub fn all(&self) -> ::std::vec::Vec<::bead::ServiceProcedure> {`,
    `${INDENT}${INDENT}::std::vec![`,
    ...service.procedures.map((procedure) => {
      return `${INDENT}${INDENT}${INDENT}::bead::ServiceProcedure::from(&self.${fieldOf(procedure)}),`;
    }),
    `${INDENT}${INDENT}]`,
    `${INDENT}}`,
    '}'
  );

  // * the catalogue: a constant a failure, and whether a failure received is one of it
  lines.push(
    '',
    ...docOf(
      {
        summary: `The failures of ${shown}: service ${String(service.serviceId)}'s catalogue, and whether a failure received is one of it.`,
      },
      ''
    ),
    ...serviceMark,
    '#[derive(Debug, Clone, Copy)]',
    `pub struct ${failures};`,
    '',
    `impl ${failures} {`
  );

  for (const failure of service.failures) {
    lines.push(
      ...docOf(
        {
          summary: `The failure \`${failure.failureName}\`, code ${String(failure.code)}.`,
          description: failure.description,
        },
        INDENT
      ),
      ...deprecatedOf(failure.deprecation, INDENT),
      `${INDENT}pub const ${identifierOf(failure.failureName)}: ::bead::ListedFailure = ::bead::ListedFailure::new(`,
      `${INDENT}${INDENT}${literalOf(failure.failureName)},`,
      `${INDENT}${INDENT}::core::num::NonZeroU16::new(${String(failure.code)}).expect("a failure's code, from 1 to 65,535 (spec 9.5)"),`,
      `${INDENT});`,
      ''
    );
  }

  lines.push(
    ...docOf(
      {
        summary: `The catalogue of service ${String(service.serviceId)}, every failure of it, made once a process.`,
        sections: [errorsOf('where the runtime refuses the catalogue')],
      },
      INDENT
    ),
    `${INDENT}pub fn catalogue() -> Result<&'static ::bead::FailureCatalogue, ${ERROR}> {`,
    `${INDENT}${INDENT}static CATALOGUE: ::std::sync::LazyLock<Result<::bead::FailureCatalogue, ${ERROR}>> =`,
    `${INDENT}${INDENT}${INDENT}::std::sync::LazyLock::new(|| {`,
    `${INDENT}${INDENT}${INDENT}${INDENT}::bead::failures_of(${String(service.serviceId)}, &[${service.failures
      .map((failure) => {
        return `${failures}::${identifierOf(failure.failureName)}`;
      })
      .join(', ')}])`,
    `${INDENT}${INDENT}${INDENT}});`,
    '',
    `${INDENT}${INDENT}CATALOGUE.as_ref().map_err(::core::clone::Clone::clone)`,
    `${INDENT}}`,
    '',
    `${INDENT}/// Whether \`error\` is \`failure\`, answered by a procedure of this service.`,
    `${INDENT}#[must_use]`,
    `${INDENT}pub fn is(error: &::bead::CallError, failure: &::bead::ListedFailure) -> bool {`,
    `${INDENT}${INDENT}Self::catalogue().is_ok_and(|catalogue| catalogue.is(error, failure))`,
    `${INDENT}}`,
    '}'
  );

  // a record of handles over `held`, its field a procedure's, deprecated with it
  const handlesOf = (details: {
    readonly name: string;
    readonly summary: string;
    readonly held: readonly IProcedureEntry[];
    readonly fieldDoc: (procedure: IProcedureEntry) => string[];
    readonly type: (procedure: IProcedureEntry) => string;
  }): string[] => {
    return [
      '',
      ...structOf(
        {
          doc: [
            ...docOf({ summary: details.summary }, ''),
            ...serviceMark,
            '#[derive(Debug, Clone)]',
          ],
          derives: '#[non_exhaustive]',
          name: details.name,
        },
        details.held.map((procedure) => {
          return {
            doc: [
              ...details.fieldDoc(procedure),
              ...deprecatedOf(deprecationOf(procedure), INDENT),
            ],
            declaration: `pub ${fieldOf(procedure)}: ${details.type(procedure)},`,
          };
        })
      ),
    ];
  };
  const requesterDocOf = (procedure: IProcedureEntry): string[] => {
    return docOf(
      {
        summary: `The requester of \`${procedure.procedureName}\`.`,
        description: procedure.description,
      },
      INDENT
    );
  };
  // a registration of a resolver of `procedure`, by `through`, the layer's method
  const registrationOf = (
    procedure: IProcedureEntry,
    details: { readonly summary: string; readonly through: string; readonly cause: string }
  ): string[] => {
    return [
      '',
      ...docOf({ summary: details.summary, sections: [errorsOf(details.cause)] }, INDENT),
      ...deprecatedOf(deprecationOf(procedure), INDENT),
      `${INDENT}pub fn on_${toSnakeCase(procedure.procedureName)}<F, Fut>(&self, resolver: F) -> Result<(), ${ERROR}>`,
      `${INDENT}where`,
      `${INDENT}${INDENT}F: Fn(`,
      `${INDENT}${INDENT}${INDENT}${INDENT}::bead::RequestProps<${valueOf(procedure.request)}>,`,
      `${INDENT}${INDENT}${INDENT}${INDENT}::bead::Response<${codecTypeOf(procedure.result)}>,`,
      `${INDENT}${INDENT}${INDENT}) -> Fut`,
      `${INDENT}${INDENT}${INDENT}+ Send`,
      `${INDENT}${INDENT}${INDENT}+ Sync`,
      `${INDENT}${INDENT}${INDENT}+ 'static,`,
      `${INDENT}${INDENT}Fut: ::core::future::Future<Output = Result<(), ::bead::ResolverError>> + Send + 'static,`,
      `${INDENT}{`,
      `${INDENT}${INDENT}self.service.${details.through}(`,
      `${INDENT}${INDENT}${INDENT}&self.procedures.${fieldOf(procedure)},`,
      `${INDENT}${INDENT}${INDENT}::std::sync::Arc::new(move |request, response| ::std::boxed::Box::pin(resolver(request, response))),`,
      `${INDENT}${INDENT})`,
      `${INDENT}}`,
    ];
  };

  if (servedPick !== undefined) {
    // * the server's records: its hooks, its options, its commands and its notifiers
    lines.push(
      '',
      ...structOf(
        {
          doc: [
            ...docOf(
              {
                summary:
                  hooks.length === 0
                    ? `The hooks of ${shown}: none, since no procedure names one.`
                    : `The hooks of ${shown}, each by the name its procedures give it: every one is required.`,
              },
              ''
            ),
            ...serviceMark,
          ],
          derives: '#[derive(Debug, Clone)]',
          name: `${name}Admissions`,
        },
        hooks.map((hook) => {
          const admitted = served
            .filter((procedure) => {
              return typeof procedure.admission === 'object' && procedure.admission.hook === hook;
            })
            .map((procedure) => {
              return `\`${procedure.procedureName}\``;
            })
            .join(', ');

          return {
            doc: docOf(
              { summary: `The hook \`${hook}\`, which admits a call to ${admitted}.` },
              INDENT
            ),
            declaration: `pub ${snakeIdentifierOf(hook)}: ::bead::AdmissionHook,`,
          };
        })
      )
    );

    const optionsFields: IField[] = [
      ...(hooks.length === 0
        ? []
        : [
            {
              doc: docOf({ summary: 'The hooks its procedures are admitted by.' }, INDENT),
              declaration: `pub admissions: ${name}Admissions,`,
            },
          ]),
      {
        doc: docOf(
          { summary: 'Whether its rules stop at the first violation: `false` when none.' },
          INDENT
        ),
        declaration: 'pub fail_fast: Option<bool>,',
      },
      {
        doc: docOf(
          {
            summary: 'Whether its commands judge their requests by their rules: `false` when none.',
          },
          INDENT
        ),
        declaration: 'pub validates: Option<bool>,',
      },
    ];

    lines.push(
      '',
      ...structOf(
        {
          doc: [
            ...docOf(
              {
                summary:
                  hooks.length === 0
                    ? `What the server side of ${shown} is given: how it judges requests.`
                    : `What the server side of ${shown} is given: its hooks, required since a procedure names one, and how it judges requests.`,
              },
              ''
            ),
            ...serviceMark,
            hooks.length === 0 ? '#[derive(Debug, Clone, Default)]' : '#[derive(Debug, Clone)]',
          ],
          derives: '#[non_exhaustive]',
          name: `${name}ServerOptions`,
        },
        optionsFields
      ),
      ...(hooks.length === 0
        ? []
        : [
            '',
            `impl ${name}ServerOptions {`,
            `${INDENT}/// The options of a server side admitting by \`admissions\`, every other option none.`,
            `${INDENT}#[must_use]`,
            `${INDENT}pub const fn new(admissions: ${name}Admissions) -> Self {`,
            `${INDENT}${INDENT}Self {`,
            `${INDENT}${INDENT}${INDENT}admissions,`,
            `${INDENT}${INDENT}${INDENT}fail_fast: None,`,
            `${INDENT}${INDENT}${INDENT}validates: None,`,
            `${INDENT}${INDENT}}`,
            `${INDENT}}`,
            '}',
          ]),
      ...handlesOf({
        name: `${name}Commands`,
        summary: `The requester of each command of ${shown}, its server's, by its name.`,
        held: commands,
        fieldDoc: requesterDocOf,
        type: (procedure) => {
          return `::bead::Command<${pairOf(procedure)}>`;
        },
      }),
      ...handlesOf({
        name: `${name}Notifiers`,
        summary: `What notifies the subscribers of each procedure of ${shown} that notifies.`,
        held: notifying,
        fieldDoc: (procedure) => {
          return docOf(
            { summary: `Notifies the subscribers of \`${procedure.procedureName}\`.` },
            INDENT
          );
        },
        type: (procedure) => {
          return `::bead::Notifier<${codecTypeOf(notificationOf(procedure))}>`;
        },
      })
    );
  }

  if (calledPick !== undefined) {
    // * the client's records: its windows, its options, its requesters and its notifications
    lines.push(
      '',
      ...structOf(
        {
          doc: [
            ...docOf(
              {
                summary: `The window each procedure of ${shown} that notifies is asked for; none, unpaced.`,
              },
              ''
            ),
            ...serviceMark,
            '#[derive(Debug, Clone, Default)]',
          ],
          derives: '#[non_exhaustive]',
          name: `${name}Windows`,
        },
        notified.map((procedure) => {
          return {
            doc: [
              ...docOf(
                {
                  summary: `The window of \`${procedure.procedureName}\`, a whole number above 0.`,
                },
                INDENT
              ),
              ...deprecatedOf(deprecationOf(procedure), INDENT),
            ],
            declaration: `pub ${fieldOf(procedure)}: Option<u64>,`,
          };
        })
      ),
      '',
      ...structOf(
        {
          doc: [
            ...docOf(
              {
                summary: `What a client side of ${shown} is given besides its Bead client: whether it validates, and the windows of its notifications.`,
              },
              ''
            ),
            ...serviceMark,
            '#[derive(Debug, Clone, Default)]',
          ],
          derives: '#[non_exhaustive]',
          name: `${name}ClientOptions`,
        },
        [
          {
            doc: docOf(
              {
                summary:
                  'Whether the judging of a request stops at its first violation: `false` when none.',
              },
              INDENT
            ),
            declaration: 'pub fail_fast: Option<bool>,',
          },
          {
            doc: docOf(
              {
                summary:
                  'Whether each requester judges a request by its rules before it goes: `false` when none.',
              },
              INDENT
            ),
            declaration: 'pub validates: Option<bool>,',
          },
          {
            doc: docOf(
              { summary: 'The window of each procedure that notifies: unpaced when none.' },
              INDENT
            ),
            declaration: `pub windows: Option<${name}Windows>,`,
          },
        ]
      ),
      ...handlesOf({
        name: `${name}Requesters`,
        summary: `The requester of each procedure of ${shown} its server answers, its client's, by its name.`,
        held: answered,
        fieldDoc: requesterDocOf,
        type: (procedure) => {
          return `::bead::Request<${pairOf(procedure)}>`;
        },
      }),
      ...handlesOf({
        name: `${name}Notifications`,
        summary: `The notification of each procedure of ${shown} that notifies.`,
        held: notified,
        fieldDoc: (procedure) => {
          return docOf({ summary: `The notification of \`${procedure.procedureName}\`.` }, INDENT);
        },
        type: (procedure) => {
          return `::bead::Notification<${pairOf(procedure)}, ${codecTypeOf(notificationOf(procedure))}>`;
        },
      })
    );
  }

  // the layer's procedures a side is built over: every one, or its pick
  const builtOverOf = (held: readonly IProcedureEntry[]): string[] => {
    if (held.length === service.procedures.length) {
      return ['procedures.all()'];
    }

    return [
      '::std::vec![',
      ...held.map((procedure) => {
        return `${INDENT}${INDENT}${INDENT}::bead::ServiceProcedure::from(&procedures.${fieldOf(procedure)}),`;
      }),
      `${INDENT}${INDENT}]`,
    ];
  };

  if (servedPick !== undefined) {
    // * the server: the layer's members, its records built as it is
    const server = `${name}Server`;
    const built = builtOverOf(served);

    lines.push(
      '',
      ...docOf(
        {
          summary: `The server side of ${shown}, offered on one Bead server: only its resolvers are written.`,
        },
        ''
      ),
      ...serviceMark,
      '#[derive(Debug, Clone)]',
      `pub struct ${server} {`,
      `${INDENT}procedures: &'static ${procedures},`,
      `${INDENT}service: ::bead::ServiceServer,`,
      `${INDENT}command: ${name}Commands,`,
      `${INDENT}notify: ${name}Notifiers,`,
      '}',
      '',
      `impl ${server} {`,
      ...docOf(
        {
          summary:
            hooks.length === 0
              ? `The server side of ${shown}, given its options, whose procedures name no hook.`
              : `The server side of ${shown}, given its options, its hooks among them, required since a procedure names one: ${hooks.join(', ')}.`,
          sections: [
            errorsOf('where the runtime refuses the service, or the service layer its options'),
          ],
        },
        INDENT
      ),
      `${INDENT}pub fn new(options: &${name}ServerOptions) -> Result<Self, ${ERROR}> {`,
      `${INDENT}${INDENT}let procedures = ${procedures}::get()?;`,
      `${INDENT}${INDENT}let mut layer = ::bead::ServiceServerOptions::default();`,
      '',
      ...(hooks.length === 0
        ? []
        : [
            `${INDENT}${INDENT}layer.admissions = Some(::std::collections::BTreeMap::from([`,
            ...hooks.map((hook) => {
              return `${INDENT}${INDENT}${INDENT}(${literalOf(hook)}, options.admissions.${snakeIdentifierOf(hook)}.clone()),`;
            }),
            `${INDENT}${INDENT}]));`,
          ]),
      `${INDENT}${INDENT}layer.fail_fast = options.fail_fast;`,
      `${INDENT}${INDENT}layer.validates = options.validates;`,
      '',
      ...letOf('let service = ::bead::ServiceServer::new(', {
        value: [...built.slice(0, -1), `${String(built.at(-1))}, &layer)?`],
        indent: `${INDENT}${INDENT}`,
      }),
      ...letOf('let command = ', {
        value: recordValueOf(`${name}Commands`, {
          fields: commands.map((procedure) => {
            return [
              fieldOf(procedure),
              `service.command_of(&procedures.${fieldOf(procedure)})?`,
            ] as const;
          }),
          indent: `${INDENT}${INDENT}`,
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      ...letOf('let notify = ', {
        value: recordValueOf(`${name}Notifiers`, {
          fields: notifying.map((procedure) => {
            return [
              fieldOf(procedure),
              `service.notifier_of(&procedures.${fieldOf(procedure)})?`,
            ] as const;
          }),
          indent: `${INDENT}${INDENT}`,
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      '',
      `${INDENT}${INDENT}Ok(Self {`,
      `${INDENT}${INDENT}${INDENT}procedures,`,
      `${INDENT}${INDENT}${INDENT}service,`,
      `${INDENT}${INDENT}${INDENT}command,`,
      `${INDENT}${INDENT}${INDENT}notify,`,
      `${INDENT}${INDENT}})`,
      `${INDENT}}`,
      '',
      `${INDENT}/// The requester of each command, made as the service is offered.`,
      `${INDENT}#[must_use]`,
      `${INDENT}pub const fn command(&self) -> &${name}Commands {`,
      `${INDENT}${INDENT}&self.command`,
      `${INDENT}}`,
      '',
      `${INDENT}/// Notifies each procedure's subscribers.`,
      `${INDENT}#[must_use]`,
      `${INDENT}pub const fn notify(&self) -> &${name}Notifiers {`,
      `${INDENT}${INDENT}&self.notify`,
      `${INDENT}}`,
      ...answering.flatMap((procedure) => {
        return registrationOf(procedure, {
          summary:
            procedure.procedureKind === 'notifies'
              ? `Registers the resolver of \`${procedure.procedureName}\`, which notifies, before or after the offer.`
              : `Registers the resolver of \`${procedure.procedureName}\`, before or after the offer.`,
          through: procedure.procedureKind === 'notifies' ? 'on_notifying' : 'on',
          cause: 'for a resolver registered already, or one its server refuses',
        });
      }),
      '',
      ...docOf(
        {
          summary: 'Offers every resolver, now and later, on `server`, once.',
          sections: [errorsOf('for a service offered already, or a resolver its server refuses')],
        },
        INDENT
      ),
      `${INDENT}pub fn offer(&self, server: &::bead::Server) -> Result<(), ${ERROR}> {`,
      `${INDENT}${INDENT}self.service.offer(server)`,
      `${INDENT}}`,
      '',
      `${INDENT}/// The procedures a client calls that no resolver answers yet.`,
      `${INDENT}#[must_use]`,
      `${INDENT}pub fn procedures_without_resolver(&self) -> ::std::vec::Vec<::bead::Procedure> {`,
      `${INDENT}${INDENT}self.service.procedures_without_resolver()`,
      `${INDENT}}`,
      '}'
    );
  }

  if (calledPick !== undefined) {
    // * the client: a requester of each procedure its server answers, by its name
    const client = `${name}Client`;
    const built = builtOverOf(called);

    lines.push(
      '',
      ...docOf(
        {
          summary: `The client side of ${shown}, over one Bead client: a requester of each procedure its server answers, by its name.`,
        },
        ''
      ),
      ...serviceMark,
      '#[derive(Debug, Clone)]',
      `pub struct ${client} {`,
      `${INDENT}procedures: &'static ${procedures},`,
      `${INDENT}service: ::bead::ServiceClient,`,
      `${INDENT}request: ${name}Requesters,`,
      `${INDENT}notifications: ${name}Notifications,`,
      '}',
      '',
      `impl ${client} {`,
      ...docOf(
        {
          summary: `The client side of ${shown}, over \`client\`, given its options: whether it validates, and the windows of its notifications.`,
          sections: [
            errorsOf(
              'where the runtime refuses the service; for a window of 0, a second client side over one client at another window, or a procedure its router refuses to declare'
            ),
          ],
        },
        INDENT
      ),
      `${INDENT}pub fn new(client: &::bead::Client, options: &${name}ClientOptions) -> Result<Self, ${ERROR}> {`,
      `${INDENT}${INDENT}let procedures = ${procedures}::get()?;`,
      `${INDENT}${INDENT}let mut layer = ::bead::ServiceClientOptions::default();`,
      '',
      ...(notified.length === 0
        ? []
        : [
            `${INDENT}${INDENT}let windows = options.windows.clone().unwrap_or_default();`,
            `${INDENT}${INDENT}let mut given = ::std::collections::BTreeMap::new();`,
            '',
            ...notified.flatMap((procedure) => {
              return [
                `${INDENT}${INDENT}if let Some(window) = windows.${fieldOf(procedure)} {`,
                `${INDENT}${INDENT}${INDENT}given.insert(${literalOf(procedure.procedureName)}.to_owned(), window);`,
                `${INDENT}${INDENT}}`,
                '',
              ];
            }),
            `${INDENT}${INDENT}layer.windows = Some(given);`,
          ]),
      `${INDENT}${INDENT}layer.fail_fast = options.fail_fast;`,
      `${INDENT}${INDENT}layer.validates = options.validates;`,
      '',
      ...letOf('let service = ::bead::ServiceClient::new(', {
        value: [...built.slice(0, -1), `${String(built.at(-1))}, client, &layer)?`],
        indent: `${INDENT}${INDENT}`,
      }),
      ...letOf('let request = ', {
        value: recordValueOf(`${name}Requesters`, {
          fields: answered.map((procedure) => {
            const descriptor =
              procedure.procedureKind === 'notifies'
                ? `procedures.${fieldOf(procedure)}.descriptor()`
                : `&procedures.${fieldOf(procedure)}`;

            return [fieldOf(procedure), `service.requester_of(${descriptor})?`] as const;
          }),
          indent: `${INDENT}${INDENT}`,
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      ...letOf('let notifications = ', {
        value: recordValueOf(`${name}Notifications`, {
          fields: notified.map((procedure) => {
            return [
              fieldOf(procedure),
              `service.notification_of(&procedures.${fieldOf(procedure)})?`,
            ] as const;
          }),
          indent: `${INDENT}${INDENT}`,
        }),
        indent: `${INDENT}${INDENT}`,
      }),
      '',
      `${INDENT}${INDENT}Ok(Self {`,
      `${INDENT}${INDENT}${INDENT}procedures,`,
      `${INDENT}${INDENT}${INDENT}service,`,
      `${INDENT}${INDENT}${INDENT}request,`,
      `${INDENT}${INDENT}${INDENT}notifications,`,
      `${INDENT}${INDENT}})`,
      `${INDENT}}`,
      '',
      `${INDENT}/// The requester of each procedure its server answers, by its name.`,
      `${INDENT}#[must_use]`,
      `${INDENT}pub const fn request(&self) -> &${name}Requesters {`,
      `${INDENT}${INDENT}&self.request`,
      `${INDENT}}`,
      '',
      `${INDENT}/// The notification of each procedure that notifies, at the window its options gave, or unpaced.`,
      `${INDENT}#[must_use]`,
      `${INDENT}pub const fn notifications(&self) -> &${name}Notifications {`,
      `${INDENT}${INDENT}&self.notifications`,
      `${INDENT}}`,
      ...answeredCommands.flatMap((procedure) => {
        return registrationOf(procedure, {
          summary: `Registers the resolver of the command \`${procedure.procedureName}\`, which it answers.`,
          through: 'on',
          cause: 'for a resolver registered already, or one its router refuses',
        });
      }),
      '}'
    );
  }

  return lines;
};
