// ── TypeScript ────────────────────────────────────────────────────────────────

// The TypeScript target, a protoplugin plugin run in beadc's process (decision 0022): protoc's
// plugin request built from buf's set, its files in their order and the services' files to
// generate, or empty for a blueprint alone; one `<file>_bead.ts` for each file a service's `proto`
// member names, at its path under the output whichever the source, as protoc and buf write a file
// at the path its descriptor names, or `<name>_bead.ts` at the output's root for a service with no
// `proto` member; each under beadc's header, and `/* eslint-disable */` where it marks a deprecation
// or names a message protobuf deprecates.

// dependencies

import { create, createRegistry, type DescMessage, fromBinary } from '@bufbuild/protobuf';
import { CodeGeneratorRequestSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { createEcmaScriptPlugin } from '@bufbuild/protoplugin';

import type { IServiceEntry } from '../../model/blueprint.ts';
import { beadcVersion, PROTOBUF_FLOOR, protocGenEsVersion } from '../../version.ts';
import {
  bindsMessages,
  headerOf,
  type IGeneratedFile,
  type ITarget,
  type ITargetInput,
  marksDeprecation,
  Messages,
  sourceNameOf,
} from '../target.ts';
import type { ITypeScriptOptions } from './options.ts';
import { printService } from './templates.ts';

// constants

// a path, as an import names it
const RELATIVE = /^\.{1,2}\//u;

// ! protoc-gen-es's own directive, which oxlint and ESLint read alike: a rule-named one fails ESLint
// where typescript-eslint is not loaded
const LINT_OFF = '/* eslint-disable */';

// helpers

const lowerFirst = (name: string): string => {
  return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
};

// the file a service is written in, under the output's folder: its `proto` member's, whichever the
// source, which the blueprint's schema and PROTO_FILE hold to a path under its root
const fileNameOf = (service: IServiceEntry): string => {
  return service.proto === undefined
    ? `${lowerFirst(service.serviceName)}_bead.ts`
    : service.proto.file.replace(/\.proto$/u, '_bead.ts');
};

// whether protobuf deprecates `message`, itself or through a message it is nested in, as
// protoplugin reads a deprecated parent
const isDeprecated = (message: DescMessage): boolean => {
  for (let at: DescMessage | undefined = message; at !== undefined; at = at.parent) {
    if (at.deprecated) {
      return true;
    }
  }

  return false;
};

// the full names of the messages `service` binds
const boundOf = (service: IServiceEntry): string[] => {
  return service.procedures.flatMap((procedure) => {
    return [procedure.request, procedure.result, procedure.notification].flatMap((binding) => {
      return binding?.encoding === 'proto' && binding.message !== undefined
        ? [binding.message]
        : [];
    });
  });
};

// the plugin's parameter: TypeScript, its imports' extension, and the messages' folder when external
const parameterOf = (options: ITypeScriptOptions): string => {
  const parameters = ['target=ts', `import_extension=${options.importExtension}`];

  if (options.messages === Messages.EXTERNAL && options.messagesOut !== undefined) {
    const folder = RELATIVE.test(options.messagesOut)
      ? options.messagesOut
      : `./${options.messagesOut}`;

    parameters.push(`rewrite_imports=./**/*_pb.js:${folder}`);
  }

  return parameters.join(',');
};

// definition

/** The TypeScript target: a `_bead.ts` for each service's file, over the service layer. */
export const typescriptTarget: ITarget<ITypeScriptOptions> = Object.freeze({
  name: 'typescript',
  generate: (input: ITargetInput, options: ITypeScriptOptions): readonly IGeneratedFile[] => {
    const { blueprint } = input;
    const set =
      input.set === undefined ? undefined : fromBinary(FileDescriptorSetSchema, input.set);
    // ! protoplugin changes the extension of a relative import that ends in `.js` alone
    const runtime = RELATIVE.test(options.runtime) ? `${options.runtime}.js` : options.runtime;
    const files = new Map<string, IServiceEntry[]>();
    // * the files that mark a deprecation or name a message protobuf deprecates: their own uses are
    // silenced, and only theirs, so the TypeScript side's lint holds every other file to its rules
    const silenced = new Set<string>();

    for (const service of blueprint.services) {
      const name = fileNameOf(service);

      files.set(name, [...(files.get(name) ?? []), service]);
    }

    const plugin = createEcmaScriptPlugin({
      name: 'beadc',
      version: `v${beadcVersion()}`,
      generateTs: (schema) => {
        const registry = createRegistry(...schema.allFiles);
        const messageOf = (fullName: string): DescMessage => {
          const message = registry.getMessage(fullName);

          if (message === undefined) {
            throw new Error(`${fullName}: no message of buf's set`);
          }

          return message;
        };

        for (const [name, services] of files) {
          const f = schema.generateFile(name);

          if (
            services.some((service) => {
              return (
                marksDeprecation(service) ||
                boundOf(service).some((fullName) => {
                  return isDeprecated(messageOf(fullName));
                })
              );
            })
          ) {
            silenced.add(name);
          }

          for (const service of services) {
            printService(f, { service, runtime, messageOf });
          }

          f.print();
          f.print(
            '// the contract with the runtime this file needs: an older runtime lacks the constant, and fails here'
          );
          f.print('void ', f.import('GENERATED_CODE_SUPPORTS_VERSION_2', runtime), ';');
        }
      },
    });
    const response = plugin.run(
      create(CodeGeneratorRequestSchema, {
        parameter: parameterOf(options),
        protoFile: set?.file ?? [],
        fileToGenerate:
          set === undefined
            ? []
            : [
                ...new Set(
                  blueprint.services.flatMap((service) => {
                    return service.proto === undefined ? [] : [service.proto.file];
                  })
                ),
              ],
      })
    );

    if (response.error !== '') {
      throw new Error(`the TypeScript target: ${response.error}`);
    }

    return response.file.map((file) => {
      const [service] = files.get(file.name) ?? [];
      const header = headerOf(blueprint, {
        source: sourceNameOf(input.sources, service?.proto?.file),
        ...(options.messages === Messages.GENERATE &&
        (files.get(file.name) ?? []).some(bindsMessages)
          ? {
              messages: `protoc-gen-es ${protocGenEsVersion()}, for @bufbuild/protobuf ${PROTOBUF_FLOOR} or later`,
            }
          : {}),
      });

      return {
        name: file.name,
        content: silenced.has(file.name)
          ? `${header.trimEnd()}\n${LINT_OFF}\n\n${file.content}`
          : `${header}${file.content}`,
      };
    });
  },
});
