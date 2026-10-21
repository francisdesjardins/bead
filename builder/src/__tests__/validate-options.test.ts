import { fileURLToPath } from 'node:url';

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { checkRoots } from '../check.ts';
import { generateMessages } from '../messages.ts';
import { VALIDATE_FILE } from '../roots.ts';
import { withoutValidateOptions } from '../validate-options.ts';

const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));
const RULES = 'bead/messages/v1/rules.proto';

// the numbers of the unknown fields, protovalidate's extensions among them, of every options
// message of a file's messages and their fields
const extensionsOf = (set: Uint8Array, file: string): number[] => {
  const descriptor = fromBinary(FileDescriptorSetSchema, set).file.find((each) => {
    return each.name === file;
  });

  return (descriptor?.messageType ?? []).flatMap((message) => {
    return [
      ...(message.options?.$unknown ?? []),
      ...message.field.flatMap((field) => {
        return field.options?.$unknown ?? [];
      }),
      ...message.oneofDecl.flatMap((oneof) => {
        return oneof.options?.$unknown ?? [];
      }),
    ].map((unknown) => {
      return unknown.no;
    });
  });
};

test("takes protovalidate's options and import out of a file that states rules, and leaves every other file as it was", () => {
  const { set } = checkRoots([MESSAGES]);

  if (set === undefined) {
    throw new Error('the messages fixture compiles');
  }

  const stripped = withoutValidateOptions(set);
  const fileOf = (bytes: Uint8Array, name: string) => {
    return fromBinary(FileDescriptorSetSchema, bytes).file.find((each) => {
      return each.name === name;
    });
  };

  expect(fileOf(set, RULES)?.dependency).toContain(VALIDATE_FILE);
  expect(extensionsOf(set, RULES)).toContain(1159);
  expect(fileOf(stripped, RULES)?.dependency).not.toContain(VALIDATE_FILE);
  expect(extensionsOf(stripped, RULES)).toEqual([]);
  expect(fileOf(stripped, 'bead/messages/v1/messages.proto')).toEqual(
    fileOf(set, 'bead/messages/v1/messages.proto')
  );
  expect(fileOf(stripped, VALIDATE_FILE)).toEqual(fileOf(set, VALIDATE_FILE));
});

test("a generated message imports no validate_pb.ts, unless its output keeps protovalidate's options", () => {
  const { blueprint, set } = checkRoots([MESSAGES]);

  if (blueprint === undefined || set === undefined) {
    throw new Error('the messages fixture compiles');
  }

  const filesOf = (keepValidateOptions: boolean): Map<string, string> => {
    return new Map(
      generateMessages(set, { blueprint, importExtension: 'ts', keepValidateOptions }).map(
        (file) => {
          return [file.name, file.content] as const;
        }
      )
    );
  };
  const stripped = filesOf(false);
  const kept = filesOf(true);

  expect(stripped.get('bead/messages/v1/rules_pb.ts')).not.toContain('validate_pb');
  expect(stripped.has('buf/validate/validate_pb.ts')).toBe(false);
  expect(kept.get('bead/messages/v1/rules_pb.ts')).toContain(
    'from "../../../buf/validate/validate_pb.ts"'
  );
  expect(kept.has('buf/validate/validate_pb.ts')).toBe(true);
});
