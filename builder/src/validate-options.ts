// ── Validate options ──────────────────────────────────────────────────────────

// protovalidate's options taken out of what protoc-gen-es and protoc are handed (decision 0035,
// T11): beadc compiles a request's rules into code of its own, so no `_pb.ts` imports
// `buf/validate/validate_pb.ts` and the well-known files it imports, and no C# project compiles
// `validate.proto`'s classes, for rules nobody reads at run time. Each file's
// `(buf.validate.field)`, `(buf.validate.predefined)`, `(buf.validate.message)` and
// `(buf.validate.oneof)` go, and its import of `buf/validate/validate.proto` with them; a file that
// names a `buf.validate` type itself, a field or an rpc of one, keeps both. A project that runs
// protovalidate on its own keeps them, `keepValidateOptions` in its `beadc.yaml`.

// dependencies

import { type DescMessage, fromBinary, type MessageShape, toBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  type FieldDescriptorProto,
  FieldOptionsSchema,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
  MessageOptionsSchema,
  OneofOptionsSchema,
} from '@bufbuild/protobuf/wkt';

import { VALIDATE_FILE } from './roots.ts';

// constants

// the numbers protovalidate's extensions take on FieldOptions, MessageOptions and OneofOptions:
// `field`, `message` and `oneof` at 1159, `predefined` at 1160 (validate.proto)
const VALIDATE_EXTENSIONS = new Set([1159, 1160]);

// a type of protovalidate's, as a field or an rpc names one
const VALIDATE_TYPE = /^\.buf\.validate\./u;

// helpers

// an options message without protovalidate's extensions, none where nothing else is left of it,
// as protoc writes no options a declaration states none of
const strippedOf = <Desc extends DescMessage>(
  schema: Desc,
  options: MessageShape<Desc> | undefined
): MessageShape<Desc> | undefined => {
  if (options === undefined) {
    return undefined;
  }

  options.$unknown = (options.$unknown ?? []).filter((field) => {
    return !VALIDATE_EXTENSIONS.has(field.no);
  });

  return toBinary(schema, options).length === 0 ? undefined : options;
};

const fieldsOf = (message: DescriptorProto): FieldDescriptorProto[] => {
  return [
    ...message.field,
    ...message.extension,
    ...message.nestedType.flatMap((nested) => {
      return fieldsOf(nested);
    }),
  ];
};

const messagesOf = (message: DescriptorProto): DescriptorProto[] => {
  return [
    message,
    ...message.nestedType.flatMap((nested) => {
      return messagesOf(nested);
    }),
  ];
};

// whether a file names a type of protovalidate's itself, which keeps its import
const namesValidateType = (file: FileDescriptorProto): boolean => {
  const fields = [
    ...file.extension,
    ...file.messageType.flatMap((message) => {
      return fieldsOf(message);
    }),
  ];
  const methods = file.service.flatMap((service) => {
    return service.method;
  });

  return (
    fields.some((field) => {
      return VALIDATE_TYPE.test(field.typeName) || VALIDATE_TYPE.test(field.extendee);
    }) ||
    methods.some((method) => {
      return VALIDATE_TYPE.test(method.inputType) || VALIDATE_TYPE.test(method.outputType);
    })
  );
};

// definition

/**
 * `set`, buf's FileDescriptorSet, with protovalidate's options and import taken out of every file
 * but protovalidate's own and one that names its types.
 */
export const withoutValidateOptions = (set: Uint8Array): Uint8Array => {
  const descriptors = fromBinary(FileDescriptorSetSchema, set);

  for (const file of descriptors.file) {
    const imported = file.dependency.indexOf(VALIDATE_FILE);

    if (file.name === VALIDATE_FILE || imported === -1 || namesValidateType(file)) {
      continue;
    }

    const messages = file.messageType.flatMap((message) => {
      return messagesOf(message);
    });

    for (const message of messages) {
      message.options = strippedOf(MessageOptionsSchema, message.options);

      for (const oneof of message.oneofDecl) {
        oneof.options = strippedOf(OneofOptionsSchema, oneof.options);
      }
    }

    for (const field of [
      ...file.extension,
      ...file.messageType.flatMap((message) => {
        return fieldsOf(message);
      }),
    ]) {
      field.options = strippedOf(FieldOptionsSchema, field.options);
    }

    // ! the import's index shifts every public and weak import after it
    file.dependency.splice(imported, 1);
    file.publicDependency = file.publicDependency
      .filter((index) => {
        return index !== imported;
      })
      .map((index) => {
        return index > imported ? index - 1 : index;
      });
    file.weakDependency = file.weakDependency
      .filter((index) => {
        return index !== imported;
      })
      .map((index) => {
        return index > imported ? index - 1 : index;
      });
  }

  return toBinary(FileDescriptorSetSchema, descriptors);
};
