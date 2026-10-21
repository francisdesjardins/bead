// ── Check proto ───────────────────────────────────────────────────────────────

// The rules at a `.proto`'s level, over the project's files of buf's set, protovalidate's options
// among them (`rules.ts`), each at buf's `file:line:column` of the option that causes it, or of the
// rpc or the service when none does. A blueprint is read from the files only once they pass. NAME_TARGET's half that needs the set: a
// class a service gives that a message or an enum of its C# namespace holds, since C# compiles every
// file of a namespace into one, which the blueprint, knowing no enum and no unbound message, cannot
// see.

// dependencies

import type { DescFile, DescMessage } from '@bufbuild/protobuf';
import type { DescriptorProto, FieldDescriptorProto } from '@bufbuild/protobuf/wkt';

import { diagnosticOf, type IDiagnostic } from '../diagnostics.ts';
import type { RuleName } from '../rules.ts';
import { NAMESPACE } from '../targets/csharp/options.ts';
import { classNamesOf, csharpNamespaceOf } from '../targets/names.ts';
import { enumNamed, messageNamed, PAYLOAD_TYPES } from './blueprint-of.ts';
import { pathOf, positionOf } from './comments.ts';
import type { IProtoFile, IProtoInput } from './input.ts';
import {
  admissionOf,
  FIELD,
  fileOptionsOf,
  OPTIONS_FIELD,
  optionPathOf,
  procedureOptionsOf,
  serviceOptionsOf,
} from './options.ts';
import { checkHttp } from './http.ts';
import { checkRules } from './rules.ts';

// constants

// the fields of descriptor.proto a file's and a message's declarations are under, by their numbers
const FILE_MESSAGE_TYPE = 4;
const FILE_EXTENSION = 7;
const FILE_OPTIONS = 8;
// FileOptions' csharp_namespace
const OPTIONS_CSHARP_NAMESPACE = 37;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED_TYPE = 3;
const MESSAGE_EXTENSION = 6;

// a map entry's value, its second field
const MAP_VALUE = 2;

// helpers

// a field of the set, as a finding names it: its type, its name, its source info path
interface IField {
  readonly typeName: string;
  readonly name: string;
  readonly path: number[];
}

// `fields`, each with its source info path under `at`: a map's by its own name, its type its
// entry's value's, since the entry is protoc's, declared nowhere
const declaredOf = (
  fields: readonly FieldDescriptorProto[],
  details: {
    readonly at: readonly number[];
    readonly entries: readonly DescriptorProto[];
    readonly scope: string;
  }
): IField[] => {
  return fields.map((field, number) => {
    const entry = details.entries.find((nested) => {
      return field.typeName === `${details.scope}.${nested.name}`;
    });
    const value = entry?.field.find((each) => {
      return each.number === MAP_VALUE;
    });

    return {
      typeName: value?.typeName ?? field.typeName,
      name: field.name,
      path: [...details.at, number],
    };
  });
};

// every field and every extension of `messages` and of the messages nested in them, a map entry's
// read through its map, with its source info path
const fieldsOf = (
  messages: readonly DescriptorProto[],
  at: { readonly path: readonly number[]; readonly scope: string }
): IField[] => {
  const { path, scope } = at;

  return messages.flatMap((message, index) => {
    // a map's entry, read through its map
    if (message.options?.mapEntry === true) {
      return [];
    }

    const place = [...path, index];
    const name = `${scope}.${message.name}`;
    const entries = message.nestedType.filter((nested) => {
      return nested.options?.mapEntry === true;
    });

    return [
      ...declaredOf(message.field, { at: [...place, MESSAGE_FIELD], entries, scope: name }),
      ...declaredOf(message.extension, {
        at: [...place, MESSAGE_EXTENSION],
        entries: [],
        scope: name,
      }),
      ...fieldsOf(message.nestedType, { path: [...place, MESSAGE_NESTED_TYPE], scope: name }),
    ];
  });
};

// the names of the top-level messages and enums of every file of the set, by the C# namespace
// protoc's C# generator writes the file in
const typesByNamespaceOf = (input: IProtoInput): Map<string, Set<string>> => {
  const types = new Map<string, Set<string>>();

  for (const file of input.registry.files) {
    const namespace = csharpNamespaceOf(file.proto.package, file.proto.options?.csharpNamespace);
    const held = types.get(namespace) ?? new Set<string>();

    for (const declared of [...file.messages, ...file.enums]) {
      held.add(declared.name);
    }

    types.set(namespace, held);
  }

  return types;
};

// definition

/**
 * The findings of the `.proto`-level rules over `input`'s files; protovalidate's options among them
 * unless `rules` is false, where buf's PROTOVALIDATE refused them first.
 */
export const checkProto = (
  input: IProtoInput,
  options: { readonly rules?: boolean } = {}
): IDiagnostic[] => {
  const diagnostics: IDiagnostic[] = [];

  const report = (
    rule: RuleName,
    details: {
      readonly file: IProtoFile;
      readonly path: readonly number[];
      readonly message: string;
    }
  ): void => {
    diagnostics.push(
      diagnosticOf(rule, {
        message: details.message,
        place: { file: details.file.path, ...positionOf(details.file.desc, details.path) },
      })
    );
  };

  const typesByNamespace = typesByNamespaceOf(input);

  for (const file of input.files) {
    const desc: DescFile = file.desc;
    const fileOptions = fileOptionsOf(desc);
    const namespace = csharpNamespaceOf(desc.proto.package, desc.proto.options?.csharpNamespace);
    const csharpNamespace = desc.proto.options?.csharpNamespace;

    // ! the C# target writes it as it is, `namespace <it>;`: anything but identifiers by dots would
    // be code of the .proto's author in every consumer's build, which protoc's own C# writes alike
    if (
      csharpNamespace !== undefined &&
      csharpNamespace !== '' &&
      !NAMESPACE.test(csharpNamespace)
    ) {
      report('CSHARP_NAMESPACE', {
        file,
        path: [FILE_OPTIONS, OPTIONS_CSHARP_NAMESPACE],
        message: `csharp_namespace ${JSON.stringify(csharpNamespace)} is no C# namespace: identifiers of ASCII letters, digits and _, by dots`,
      });
    }

    // the full name a top-level declaration's type is under, as a field's type names it
    const packageScope = desc.proto.package === '' ? '' : `.${desc.proto.package}`;

    for (const field of [
      ...fieldsOf(desc.proto.messageType, { path: [FILE_MESSAGE_TYPE], scope: packageScope }),
      ...declaredOf(desc.proto.extension, {
        at: [FILE_EXTENSION],
        entries: [],
        scope: packageScope,
      }),
    ]) {
      const typeName = field.typeName.replace(/^\./u, '');

      if (PAYLOAD_TYPES[typeName] !== undefined) {
        report('PAYLOAD_TYPE_FIELD', {
          file,
          path: field.path,
          message: `the field ${field.name} is a ${typeName}, a payload type whose protobuf form is never written`,
        });
      }
    }

    if (fileOptions?.admission !== undefined && admissionOf(fileOptions.admission) === 'empty') {
      report('ADMISSION_EMPTY', {
        file,
        path: optionPathOf([], { options: OPTIONS_FIELD.FILE, fields: [FIELD.FILE_ADMISSION] }),
        message: 'an admission that states no rule: none, session or a hook',
      });
    }

    for (const service of desc.services) {
      const options = serviceOptionsOf(service);
      const declaration = pathOf(service);
      const serviceField = (number: number): number[] => {
        return optionPathOf(declaration, { options: OPTIONS_FIELD.SERVICE, fields: [number] });
      };

      if (options === undefined) {
        report('SERVICE_SKIPPED', {
          file,
          path: [...declaration, 1],
          message: `${service.typeName} has no (bead.service): beadc reads nothing of it`,
        });
        continue;
      }

      const taken = classNamesOf(service.name.replace(/Service$/u, '')).filter((className) => {
        return typesByNamespace.get(namespace)?.has(className) === true;
      });

      if (taken.length > 0) {
        report('NAME_TARGET', {
          file,
          path: [...declaration, 1],
          message: `${service.typeName} gives the classes ${taken.join(', ')}, which a message or an enum of its C# namespace, ${namespace}, holds already`,
        });
      }

      if (options.admission !== undefined && admissionOf(options.admission) === 'empty') {
        report('ADMISSION_EMPTY', {
          file,
          path: serviceField(FIELD.SERVICE_ADMISSION),
          message: 'an admission that states no rule: none, session or a hook',
        });
      }

      if (options.admission === undefined && fileOptions?.admission === undefined) {
        report('ADMISSION_DEFAULT', {
          file,
          path: optionPathOf(declaration, { options: OPTIONS_FIELD.SERVICE }),
          message: `${service.typeName} states no admission, nor does its file: the runtime's default would admit every call`,
        });
      }

      if (options.deprecationMessage !== '' && service.proto.options?.deprecated !== true) {
        report('DEPRECATION_MESSAGE', {
          file,
          path: serviceField(FIELD.SERVICE_DEPRECATION_MESSAGE),
          message: `${service.typeName} states a deprecation_message without option deprecated = true, which says it`,
        });
      }

      const catalogue =
        options.failures === ''
          ? undefined
          : enumNamed(input.registry, { name: options.failures, scope: desc.proto.package });

      if (options.failures !== '' && catalogue === undefined) {
        report('FAILURES_ENUM', {
          file,
          path: serviceField(FIELD.SERVICE_FAILURES),
          message: `failures names ${options.failures}, no enum of the set`,
        });
      }

      if (catalogue?.proto.options?.allowAlias === true) {
        report('FAILURES_ENUM', {
          file,
          path: serviceField(FIELD.SERVICE_FAILURES),
          message: `${catalogue.typeName} allows aliases: a failure's code has one name`,
        });
      }

      for (const method of service.methods) {
        const procedure = procedureOptionsOf(method);
        const at = pathOf(method);
        const procedureField = (number: number): number[] => {
          return optionPathOf(at, { options: OPTIONS_FIELD.METHOD, fields: [number] });
        };

        if (method.methodKind !== 'unary') {
          report('STREAM_RESERVED', {
            file,
            path: at,
            message: `${method.parent.typeName}.${method.proto.name} streams, which Bead keeps for its own streams`,
          });
        }

        if (procedure === undefined) {
          report('PROCEDURE_OPTIONS', {
            file,
            path: at,
            message: `${method.parent.typeName}.${method.proto.name} has no (bead.procedure): its id cannot be guessed`,
          });
          continue;
        }

        if (procedure.admission !== undefined && admissionOf(procedure.admission) === 'empty') {
          report('ADMISSION_EMPTY', {
            file,
            path: procedureField(FIELD.PROCEDURE_ADMISSION),
            message: 'an admission that states no rule: none, session or a hook',
          });
        }

        if (procedure.deprecationMessage !== '' && method.proto.options?.deprecated !== true) {
          report('DEPRECATION_MESSAGE', {
            file,
            path: procedureField(FIELD.PROCEDURE_DEPRECATION_MESSAGE),
            message: `${method.proto.name} states a deprecation_message without option deprecated = true, which says it`,
          });
        }

        procedure.failures.forEach((name, index) => {
          const value = catalogue?.values.find((each) => {
            return each.name === name;
          });

          if (value === undefined) {
            report('FAILURES_ENUM', {
              file,
              path: procedureField(FIELD.PROCEDURE_FAILURES).concat(index),
              message:
                catalogue === undefined
                  ? `${method.proto.name} lists the failure ${name}, and its service names no failures enum`
                  : `${name} is no value of ${catalogue.typeName}`,
            });
          }
        });

        if (procedure.procedureKind.case === 'notifies') {
          const name = procedure.procedureKind.value.message;
          const message: DescMessage | undefined =
            name === ''
              ? undefined
              : messageNamed(input.registry, { name, scope: desc.proto.package });

          if (message === undefined) {
            report('NOTIFICATION_MESSAGE', {
              file,
              path: procedureField(FIELD.PROCEDURE_NOTIFIES),
              message:
                name === ''
                  ? `${method.proto.name} notifies, and names no message`
                  : `${method.proto.name} notifies ${name}, no message of the set`,
            });
          }
        }
      }
    }
  }

  // * protovalidate's options: what beadc compiles of them, and what a request reaches
  if (options.rules !== false) {
    diagnostics.push(...checkRules(input));
  }

  // * google.api.http: what the .proto's fields judge of its rules (decision 0037)
  diagnostics.push(...checkHttp(input));

  return diagnostics;
};
