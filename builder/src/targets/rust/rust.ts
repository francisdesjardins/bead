// ── Rust ──────────────────────────────────────────────────────────────────────

// The Rust target (decision 0051): one module tree under four roots of beadc's own, mounted by the
// output's `mod.rs`. `messages`, Buffa's tree as Buffa writes it, never declared again by beadc:
// under `generate`, `messages/mod.rs` and the files `protoc-gen-buffa` writes (`messages.ts`); under
// `external`, the include file the application's build script writes into `OUT_DIR` by
// `bead_protobuf_build::config_of`. `services`, a module a package, each segment named as Buffa
// names a package's, its file `services/<package>.rs` holding every service of every `.proto` file
// of that package, and one with no `proto` member, or of the unnamed package, in `services` itself,
// from `services/__buffa.rs`. And `bead_served`, the procedures each transport of the server takes,
// where it names them (`served.ts`). And `bead_http`, for an output with a `gateway`: its route
// table, its document and each service's HTTP client (`http.ts`, decision 0052). Every file of
// `services`, `bead_served` and `bead_http` is `include!`d,
// which rustfmt never follows, and every item of `mod.rs` is `#[rustfmt::skip]`, so an application's
// formatter changes nothing beadc writes. Each package's file is beadc's header, then each service
// (`templates.ts`), the rules of each message its requests' rules reach (`validators.ts`), and once
// the contract with the runtime. A message is named by its path from the service's module to
// `messages`, as Buffa names its module and its nested types' module. An output holds the
// procedures its sides select, each side printed over its own (decision 0048), and a service none
// selects is not written.

// dependencies

import { createFileRegistry, type DescMessage, fromBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';

import { InputError } from '../../diagnostics.ts';
import {
  type IServiceEntry,
  LEGACY_REQUIRED_FEATURE,
  VALIDATE_FEATURE,
} from '../../model/blueprint.ts';
import { judgedMessagesOf, plansOf } from '../../model/rules.ts';
import { cutOf } from '../../model/selection.ts';
import {
  bindsMessages,
  headerOf,
  type IGeneratedFile,
  type ITarget,
  type ITargetInput,
  Messages,
  sourceNameOf,
} from '../target.ts';
import {
  buffaMessagesOf,
  buffaRequestOf,
  hasOwnMessages,
  MESSAGES_FOLDER,
  WELL_KNOWN_PATH,
} from './messages.ts';
import {
  childSegmentsOf,
  identifierOf,
  nestedModulesOf,
  packageToFilename,
  SENTINEL_MOD,
  toSnakeCase,
} from './names.ts';
import { EXTERNAL_INCLUDE_FILE, type IRustOptions } from './options.ts';
import { HTTP_CLIENT_METHODS, HTTP_FILE, HTTP_MODULE, printRustHttp } from './http.ts';
import { printRustServed, SERVED_FILE, SERVED_MODULE } from './served.ts';
import { INDENT, printService } from './templates.ts';
import { printRustValidators } from './validators.ts';

// constants

/** The folder of an output that holds each package's services, and the module that mounts them. */
export const SERVICES_FOLDER = 'services';

/** The module root of an output, which an application mounts: `mod generated;`. */
export const ROOT_FILE = 'mod.rs';

/**
 * The types a service gives, after its name, in the Rust target: what its package's module holds
 * beside a module of a sub-package, which may take none of their names.
 */
export const RUST_CLASS_SUFFIXES: readonly string[] = Object.freeze([
  'Procedures',
  'Failures',
  'Admissions',
  'ServerOptions',
  'Commands',
  'Notifiers',
  'Server',
  'Windows',
  'ClientOptions',
  'Requesters',
  'Notifications',
  'Client',
]);

// the well-known types' files, which buffa-types holds
const WELL_KNOWN = 'google/protobuf/';

// the lints Buffa's tree answers to instead of its application's, and Bead's roots' own
const MESSAGES_ALLOW = [
  '#[rustfmt::skip]',
  '#[allow(',
  `${INDENT}clippy::all,`,
  `${INDENT}clippy::pedantic,`,
  `${INDENT}clippy::nursery,`,
  `${INDENT}clippy::restriction,`,
  `${INDENT}missing_docs,`,
  `${INDENT}unnameable_types,`,
  `${INDENT}unreachable_pub,`,
  `${INDENT}unused_qualifications,`,
  `${INDENT}reason = "Buffa's generated code answers to Buffa's lints, not its application's"`,
  ')]',
];
const SERVICES_ALLOW = [
  '#[rustfmt::skip]',
  '#[allow(',
  `${INDENT}dead_code,`,
  `${INDENT}deprecated,`,
  `${INDENT}clippy::allow_attributes,`,
  `${INDENT}unreachable_pub,`,
  `${INDENT}clippy::struct_field_names,`,
  `${INDENT}clippy::type_complexity,`,
  `${INDENT}reason = "an application uses the classes of its own side alone and mounts them where it will, beadc's code names what it marks deprecated, a record's fields are its procedures' names, and a descriptor's type names each of its codecs by its whole path"`,
  ')]',
];
const HTTP_ALLOW = [
  '#[rustfmt::skip]',
  '#[allow(',
  `${INDENT}dead_code,`,
  `${INDENT}deprecated,`,
  `${INDENT}unreachable_pub,`,
  `${INDENT}clippy::allow_attributes,`,
  `${INDENT}clippy::struct_field_names,`,
  `${INDENT}clippy::type_complexity,`,
  `${INDENT}reason = "an application serves its routes or calls them, and mounts the tree where it will, beadc's code names what it marks deprecated, a client's fields are its procedures' names, and a requester's type names each of its codecs by its whole path"`,
  ')]',
];
const SERVED_ALLOW = [
  '#[rustfmt::skip]',
  '#[allow(',
  `${INDENT}dead_code,`,
  `${INDENT}unreachable_pub,`,
  `${INDENT}clippy::allow_attributes,`,
  `${INDENT}reason = "an application hands a transport the list it names, and mounts it where it will"`,
  ')]',
];

// the contract a package's file names, and the line that names it
const CONTRACT = [
  '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here',
  'const _: bool = ::bead::GENERATED_CODE_SUPPORTS_VERSION_7;',
];

// helpers

// each message of the set, by its full name, as its path under `messages` names it, or
// buffa-types' for a well-known type, as Buffa's context maps them: a package's segments, then the
// module of its nested types, its top-level message's deconflicted against the package's
// sub-packages
const messagePathsOf = (files: readonly FileDescriptorProto[]): Map<string, string> => {
  const packages = new Set(
    files.map((file) => {
      return file.package;
    })
  );
  const topLevel = new Map<string, string[]>();

  for (const file of files) {
    if (!file.name.startsWith(WELL_KNOWN)) {
      topLevel.set(file.package, [
        ...(topLevel.get(file.package) ?? []),
        ...file.messageType.map((message) => {
          return message.name;
        }),
      ]);
    }
  }

  const modules = new Map<string, string>();

  for (const [packageName, names] of topLevel) {
    const deconflicted = nestedModulesOf(names, childSegmentsOf(packageName, packages));

    names.forEach((name, at) => {
      modules.set(
        packageName === '' ? name : `${packageName}.${name}`,
        deconflicted[at] ?? toSnakeCase(name)
      );
    });
  }

  const paths = new Map<string, string>();

  for (const file of files) {
    const base = file.name.startsWith(WELL_KNOWN)
      ? WELL_KNOWN_PATH
      : [
          MESSAGES_FOLDER,
          ...(file.package === '' ? [] : file.package.split('.').map(identifierOf)),
        ].join('::');
    const walk = (
      message: DescriptorProto,
      place: { readonly fullName: string; readonly path: string }
    ) => {
      paths.set(place.fullName, `${place.path}::${message.name}`);

      const module = modules.get(place.fullName) ?? toSnakeCase(message.name);

      for (const nested of message.nestedType) {
        walk(nested, {
          fullName: `${place.fullName}.${nested.name}`,
          path: `${place.path}::${identifierOf(module)}`,
        });
      }
    };

    for (const message of file.messageType) {
      walk(message, {
        fullName: file.package === '' ? message.name : `${file.package}.${message.name}`,
        path: base,
      });
    }
  }

  return paths;
};

// the package a service's module is, its `.proto` file's; none for a blueprint's alone
const packageOf = (service: IServiceEntry, packages: ReadonlyMap<string, string>): string => {
  return service.proto === undefined ? '' : (packages.get(service.proto.file) ?? '');
};

// `name` as a module path from a module `depth` deep under the root
const fromDepth = (path: string, depth: number): string => {
  return path.startsWith('::') ? path : `${'super::'.repeat(depth)}${path}`;
};

// definition

/** The Rust target: a module tree of each package's services beside Buffa's messages. */
export const rustTarget: ITarget<IRustOptions> = Object.freeze({
  name: 'rust',
  features: new Set([LEGACY_REQUIRED_FEATURE, VALIDATE_FEATURE]),
  http: true,
  generate: (input: ITargetInput, options: IRustOptions): readonly IGeneratedFile[] => {
    // * what the output holds: every procedure, both sides whole, where no cut is given
    const cut = input.cut ?? cutOf(input.blueprint, {});
    const { blueprint } = cut;

    if (blueprint.services.length === 0) {
      return [];
    }

    // * the messages of the whole blueprint, as generate writes them, whatever the output selects;
    // none where it binds Google's well-known types alone, which buffa-types holds
    const binds = input.blueprint.services.some(bindsMessages) && hasOwnMessages(input.blueprint);
    const set =
      input.set === undefined ? undefined : fromBinary(FileDescriptorSetSchema, input.set);
    // the set Buffa reads: beadc's pruned one under generate, the application's under external
    const request =
      input.set === undefined || options.messages !== Messages.GENERATE
        ? undefined
        : buffaRequestOf(input.set, { blueprint });
    const read = request === undefined ? set : fromBinary(FileDescriptorSetSchema, request.set);
    const paths = messagePathsOf(read?.file ?? []);
    const registry = set === undefined ? undefined : createFileRegistry(set);
    const rules = judgedMessagesOf(blueprint);
    const packages = new Map(
      (blueprint.proto?.files ?? []).map((file) => {
        return [file.path, file.package] as const;
      })
    );
    const descOf = (fullName: string): DescMessage => {
      const message = registry?.getMessage(fullName);

      if (message === undefined) {
        throw new Error(`${fullName}: no message of buf's set`);
      }

      return message;
    };
    // * each package's services, in the blueprint's order, a file a package
    const byPackage = new Map<string, IServiceEntry[]>();

    for (const service of blueprint.services) {
      const name = packageOf(service, packages);

      byPackage.set(name, [...(byPackage.get(name) ?? []), service]);
    }

    // ! a sub-package's module and a class of its parent package's services are one name of one
    // module: refused for this output, which would not compile
    for (const [parent, services] of byPackage) {
      const classes = new Map(
        services.flatMap((service) => {
          return RUST_CLASS_SUFFIXES.map((suffix) => {
            return [`${service.serviceName}${suffix}`, service.serviceName] as const;
          });
        })
      );

      for (const segment of childSegmentsOf(parent, byPackage.keys())) {
        const service = classes.get(identifierOf(segment));

        if (service !== undefined) {
          throw new InputError(
            `the package ${parent === '' ? segment : `${parent}.${segment}`}'s module is ${identifierOf(segment)}, a type the service ${service} of ${parent === '' ? 'the unnamed package' : parent} gives beside it in Rust: rename the package or the service`
          );
        }
      }
    }

    const written = [...byPackage.entries()].map(([packageName, services]): IGeneratedFile => {
      const depth = 1 + (packageName === '' ? 0 : packageName.split('.').length);
      const messageOf = (fullName: string): string => {
        const path = paths.get(fullName);

        if (path === undefined) {
          throw new Error(`${fullName}: no message of buf's set`);
        }

        return fromDepth(path, depth);
      };
      const sources = [
        ...new Set(
          services.map((service) => {
            return sourceNameOf(input.sources, service.proto?.file);
          })
        ),
      ];
      const header = headerOf(blueprint, {
        source: sources.join(', '),
        ...(options.messages === Messages.GENERATE && binds && services.some(bindsMessages)
          ? { messages: buffaMessagesOf() }
          : {}),
      });
      // a oneof's enum, as Buffa lays its ancillary tree: its package's `__buffa::oneof`, then each
      // message of its path in snake case, then the oneof in Pascal case
      const oneofOf = (fullName: string, oneof: string): string => {
        const desc = descOf(fullName);
        const owner = desc.file.proto.package;
        const within = owner === '' ? desc.typeName : desc.typeName.slice(owner.length + 1);

        return fromDepth(
          [
            MESSAGES_FOLDER,
            ...(owner === '' ? [] : owner.split('.').map(identifierOf)),
            SENTINEL_MOD,
            'oneof',
            ...within.split('.').map((segment) => {
              return identifierOf(toSnakeCase(segment));
            }),
            oneof
              .split('_')
              .map((part) => {
                return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
              })
              .join(''),
          ].join('::'),
          depth
        );
      };
      const validators = printRustValidators(plansOf(services, rules), {
        messageOf: descOf,
        typeOf: messageOf,
        oneofOf,
      });
      const body = [
        ...services.flatMap((service, at) => {
          return [
            ...(at === 0 ? [] : ['']),
            ...printService(service, {
              messageOf,
              validators: validators.functions,
              served: cut.served?.get(service.serviceName),
              called: cut.called?.get(service.serviceName),
            }),
          ];
        }),
        ...validators.lines,
        '',
        ...CONTRACT,
        '',
      ];

      return {
        name: `${SERVICES_FOLDER}/${packageToFilename(packageName)}`,
        content: `${header}${body.join('\n')}`,
      };
    });
    const [first] = blueprint.services;
    const source = sourceNameOf(input.sources, first?.proto?.file);
    // * an output with a gateway: its route table, its document and its clients, of what it selects
    const gateway = cut.gateway ?? blueprint;

    if (options.http !== undefined) {
      // ! a procedure a client calls whose method would be one its HTTP client holds already, its
      // constructor's or a trait's it implements: two methods of one name, refused for this output
      for (const service of gateway.services) {
        for (const procedure of service.procedures) {
          const method = toSnakeCase(procedure.procedureName);

          if (procedure.procedureKind !== 'command' && HTTP_CLIENT_METHODS.has(method)) {
            throw new InputError(
              `the procedure ${service.serviceName}/${procedure.procedureName} is the method ${method} of ${service.serviceName}HttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway`
            );
          }
        }
      }
    }

    const httpFiles =
      options.http === undefined
        ? []
        : [
            {
              name: HTTP_FILE,
              content: `${headerOf(blueprint, {
                source: sourceNameOf(input.sources, gateway.services[0]?.proto?.file),
              })}${printRustHttp({
                blueprint: gateway,
                http: options.http,
                messageOf: (fullName) => {
                  const path = paths.get(fullName);

                  if (path === undefined) {
                    throw new Error(`${fullName}: no message of buf's set`);
                  }

                  return fromDepth(path, 1);
                },
                moduleOf: (service) => {
                  const packageName = packageOf(service, packages);

                  return `super::${[SERVICES_FOLDER, ...(packageName === '' ? [] : packageName.split('.').map(identifierOf))].join('::')}::`;
                },
              }).join('\n')}`,
            },
          ];
    const served =
      cut.transports === undefined
        ? []
        : [
            {
              name: SERVED_FILE,
              content: `${headerOf(blueprint, { source })}${printRustServed({ transports: cut.transports }).join('\n')}`,
            },
          ];

    // * the services' module tree: a module a package segment, each package's file included where
    // its last segment is, the unnamed package's in `services` itself
    interface INode {
      readonly packageName: string;
      readonly children: Map<string, INode>;
    }

    const root: INode = { packageName: '', children: new Map() };

    for (const packageName of byPackage.keys()) {
      let node = root;
      const segments = packageName === '' ? [] : packageName.split('.');

      segments.forEach((segment, at) => {
        const child = node.children.get(segment) ?? {
          packageName: segments.slice(0, at + 1).join('.'),
          children: new Map(),
        };

        node.children.set(segment, child);
        node = child;
      });
    }

    const tree: string[] = [];
    const emit = (node: INode, indent: string): void => {
      const services = byPackage.get(node.packageName);

      if (services !== undefined) {
        tree.push(
          '',
          `${indent}include!("${SERVICES_FOLDER}/${packageToFilename(node.packageName)}");`
        );
      }

      const children = [...node.children.entries()].toSorted(([one], [other]) => {
        return one < other ? -1 : Number(one > other);
      });

      for (const [segment, child] of children) {
        const files = [
          ...new Set(
            (byPackage.get(child.packageName) ?? []).flatMap((service) => {
              return service.proto === undefined ? [] : [service.proto.file];
            })
          ),
        ];

        tree.push(
          '',
          `${indent}pub mod ${identifierOf(segment)} {`,
          files.length === 0
            ? `${indent}${INDENT}//! The package \`${child.packageName}\`.`
            : `${indent}${INDENT}//! The package \`${child.packageName}\`: the services of ${files
                .map((file) => {
                  return `\`${file}\``;
                })
                .join(', ')}.`
        );
        emit(child, `${indent}${INDENT}`);
        tree.push(`${indent}}`);
      }
    };

    emit(root, INDENT);

    const messagesLines =
      !binds || input.set === undefined
        ? []
        : options.messages === Messages.GENERATE
          ? ['', ...MESSAGES_ALLOW, `pub mod ${MESSAGES_FOLDER};`]
          : [
              '',
              ...MESSAGES_ALLOW,
              `pub mod ${MESSAGES_FOLDER} {`,
              `${INDENT}include!(concat!(env!("OUT_DIR"), "/${EXTERNAL_INCLUDE_FILE}"));`,
              '}',
            ];
    const parts = [
      ...(messagesLines.length === 0 ? [] : ["Buffa's messages under `messages`"]),
      "each package's services under `services`",
      ...(served.length === 0 ? [] : ['the procedures each transport of its server takes']),
      ...(httpFiles.length === 0
        ? []
        : [
            "its gateway's routes, the document it serves at `/openapi.json` and each service's HTTP client",
          ]),
    ];
    const said =
      parts.length === 1
        ? String(parts[0])
        : `${parts.slice(0, -1).join(', ')}, and ${String(parts.at(-1))}`;
    const mod = [
      `//! The code beadc writes for this output: ${said}.`,
      ...messagesLines,
      '',
      ...SERVICES_ALLOW,
      `pub mod ${SERVICES_FOLDER} {`,
      `${INDENT}//! Each package's services, a module a package${byPackage.has('') ? `, the unnamed package's and a blueprint's own here, from \`${SENTINEL_MOD}.rs\`` : ''}.`,
      ...tree,
      '}',
      ...(served.length === 0
        ? []
        : [
            '',
            ...SERVED_ALLOW,
            `pub mod ${SERVED_MODULE} {`,
            `${INDENT}//! The procedures each transport of the server takes.`,
            '',
            `${INDENT}include!("${SERVED_FILE}");`,
            '}',
          ]),
      ...(httpFiles.length === 0
        ? []
        : [
            '',
            ...HTTP_ALLOW,
            `pub mod ${HTTP_MODULE} {`,
            `${INDENT}//! Its gateway's routes, the document it serves at \`/openapi.json\` and each service's HTTP client.`,
            '',
            `${INDENT}include!("${HTTP_FILE}");`,
            '}',
          ]),
      '',
    ];

    return [
      {
        name: ROOT_FILE,
        content: `${headerOf(blueprint, {
          source,
          ...(options.messages === Messages.GENERATE && binds
            ? { messages: buffaMessagesOf() }
            : {}),
        })}${mod.join('\n')}`,
      },
      ...written,
      ...served,
      ...httpFiles,
    ];
  },
});
