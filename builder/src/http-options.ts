// ── HTTP options ──────────────────────────────────────────────────────────────

// `google.api.http` taken out of what protoc-gen-es and protoc are handed (decision 0037), as
// protovalidate's options are (`validate-options.ts`): beadc reads each method's rules into the
// blueprint and writes its route table of its own, so no `_pb.ts` imports
// `google/api/annotations_pb.ts`, and no C# project compiles `Google.Api`'s classes, for options
// nobody reads at run time. Each method's `(google.api.http)` goes, and its file's import of
// `google/api/annotations.proto` with it; a file that names a `google.api` type itself keeps both.
// `idempotency_level` is `descriptor.proto`'s own and stays. A project that reads the option at run
// time keeps it, `keepHttpOptions` in its `beadc.yaml`.

// dependencies

import { fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
  MethodOptionsSchema,
} from '@bufbuild/protobuf/wkt';

import { HTTP_EXTENSION } from './front-end/http.ts';
import { ANNOTATIONS_FILE, HTTP_FILES } from './roots.ts';

// constants

// a type of googleapis' `google.api`, as a field or an rpc names one
const GOOGLE_API_TYPE = /^\.google\.api\./u;

// helpers

const fieldsOf = (message: DescriptorProto): FieldDescriptorProto[] => {
  return [
    ...message.field,
    ...message.extension,
    ...message.nestedType.flatMap((nested) => {
      return fieldsOf(nested);
    }),
  ];
};

// whether a file names a type of `google.api` itself, which keeps its import
const namesGoogleApiType = (file: FileDescriptorProto): boolean => {
  const fields = [
    ...file.extension,
    ...file.messageType.flatMap((message) => {
      return fieldsOf(message);
    }),
  ];

  return (
    fields.some((field) => {
      return GOOGLE_API_TYPE.test(field.typeName) || GOOGLE_API_TYPE.test(field.extendee);
    }) ||
    file.service.some((service) => {
      return service.method.some((method) => {
        return GOOGLE_API_TYPE.test(method.inputType) || GOOGLE_API_TYPE.test(method.outputType);
      });
    })
  );
};

// definition

/**
 * `set`, buf's FileDescriptorSet, with `google.api.http` and its import taken out of every file but
 * googleapis' own and one that names their types.
 */
export const withoutHttpOptions = (set: Uint8Array): Uint8Array => {
  const descriptors = fromBinary(FileDescriptorSetSchema, set);

  for (const file of descriptors.file) {
    const imported = file.dependency.indexOf(ANNOTATIONS_FILE);

    if (HTTP_FILES.includes(file.name) || imported === -1 || namesGoogleApiType(file)) {
      continue;
    }

    for (const method of file.service.flatMap((service) => {
      return service.method;
    })) {
      const { options } = method;

      if (options !== undefined) {
        options.$unknown = (options.$unknown ?? []).filter((field) => {
          return field.no !== HTTP_EXTENSION;
        });
        method.options = toBinary(MethodOptionsSchema, options).length === 0 ? undefined : options;
      }
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
