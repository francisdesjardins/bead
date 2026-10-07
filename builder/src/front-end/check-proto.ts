// ── Check proto ───────────────────────────────────────────────────────────────

// The rules at a `.proto`'s level, over the project's files of buf's set, each at buf's
// `file:line:column` of the option that causes it, or of the rpc or the service when none does. A
// blueprint is read from the files only once they pass.

// dependencies

import type { DescFile, DescMessage } from '@bufbuild/protobuf';
import type { DescriptorProto } from '@bufbuild/protobuf/wkt';

import { diagnosticOf, type IDiagnostic } from '../diagnostics.ts';
import type { RuleName } from '../rules.ts';
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

// constants

// the fields of descriptor.proto a message's fields and nested messages are under, by their numbers
const FILE_MESSAGE_TYPE = 4;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED_TYPE = 3;

// helpers

// every field of `messages` and of the messages nested in them, with its source info path
const fieldsOf = (
  messages: readonly DescriptorProto[],
  path: readonly number[]
): { readonly typeName: string; readonly name: string; readonly path: number[] }[] => {
  return messages.flatMap((message, index) => {
    const at = [...path, index];

    return [
      ...message.field.map((field, number) => {
        return { typeName: field.typeName, name: field.name, path: [...at, MESSAGE_FIELD, number] };
      }),
      ...fieldsOf(message.nestedType, [...at, MESSAGE_NESTED_TYPE]),
    ];
  });
};

// definition

/** The findings of the `.proto`-level rules over `input`'s files. */
export const checkProto = (input: IProtoInput): IDiagnostic[] => {
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

  for (const file of input.files) {
    const desc: DescFile = file.desc;
    const fileOptions = fileOptionsOf(desc);

    for (const field of fieldsOf(desc.proto.messageType, [FILE_MESSAGE_TYPE])) {
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

  return diagnostics;
};
