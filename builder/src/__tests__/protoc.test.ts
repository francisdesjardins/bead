import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearField, equals, fromBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { checkRoots, type IChecked } from '../check.ts';
import { InputError } from '../diagnostics.ts';
import type { IBlueprint } from '../model/blueprint.ts';
import {
  csharpPathOf,
  findProtoc,
  generateCSharpMessages,
  PROTOC_CSHARP_HEADER,
  PROTOC_CSHARP_SOURCE,
  protocPin,
} from '../protoc.ts';
import { csharpTarget } from '../targets/csharp/csharp.ts';
import { Messages } from '../targets/target.ts';
import { needsProtoc, stubProtoc, withProtoc } from './pinned.ts';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const OPTIONS_ROOT = join(BUILDER, 'proto');
const MESSAGES_PROTO = 'bead/messages/v1/messages.proto';

// the embedded descriptor of a file protoc's C# generator writes: its base64, by parts
const DESCRIPTOR = /string\.Concat\(\n((?:\s*"[A-Za-z0-9+/=]*",?\n)+?)\s*"[A-Za-z0-9+/=]*"\)\);/u;
const PART = /"([A-Za-z0-9+/=]*)"/gu;

const checked = (
  root: string,
  files?: readonly string[]
): IChecked & { blueprint: IBlueprint; set: Uint8Array } => {
  const result = checkRoots([root], files === undefined ? {} : { files });

  if (result.blueprint === undefined || result.set === undefined) {
    throw new Error(`${root}: no blueprint, ${JSON.stringify(result.diagnostics)}`);
  }

  return { ...result, blueprint: result.blueprint, set: result.set };
};

const namesOf = (files: readonly { name: string }[]): string[] => {
  return files.map((file) => {
    return file.name;
  });
};

// a file's code with its descriptor's parts taken out, and the descriptor they spell
const splitOf = (content: string): { code: string; descriptor: FileDescriptorProto } => {
  const found = DESCRIPTOR.exec(content);

  if (found === null) {
    throw new Error('no embedded descriptor');
  }

  const base64 = [...found[0].matchAll(PART)]
    .map((part) => {
      return part[1] ?? '';
    })
    .join('');

  return {
    code: content.replace(found[0], 'string.Concat());'),
    descriptor: fromBinary(FileDescriptorProtoSchema, Buffer.from(base64, 'base64')),
  };
};

// a field's JSON name as protoc computes it when none is written: each letter after `_` raised
const defaultJsonNameOf = (name: string): string => {
  return name.replaceAll(/_(.)/gu, (_, letter: string) => {
    return letter.toUpperCase();
  });
};

// every field of `file`, its messages', nested or not, and its extensions
const fieldsOf = (file: FileDescriptorProto): FieldDescriptorProto[] => {
  const walk = (message: DescriptorProto): FieldDescriptorProto[] => {
    return [...message.field, ...message.extension, ...message.nestedType.flatMap(walk)];
  };

  return [...file.extension, ...file.messageType.flatMap(walk)];
};

// protoc over the .proto files themselves, as a build compiles them: their C#, by path
const protocFromSource = (out: string): Map<string, string> => {
  const protoc = findProtoc();

  if (protoc === undefined) {
    throw new Error('no protoc');
  }

  mkdirSync(out, { recursive: true });

  for (const [option, file] of [
    ['base_namespace=', MESSAGES_PROTO],
    ['internal_access,base_namespace=', 'bead/options.proto'],
  ] as const) {
    execFileSync(protoc.path, [
      `-I${OPTIONS_ROOT}`,
      `-I${MESSAGES}`,
      `--csharp_out=${out}`,
      `--csharp_opt=${option}`,
      file,
    ]);
  }

  return new Map(
    ['Bead/Messages/V1/Messages.cs', 'Bead/Protobuf/Options.cs'].map((name) => {
      return [name, readFileSync(join(out, ...name.split('/')), 'utf8').replaceAll('\r\n', '\n')];
    })
  );
};

test("writes bead/options.proto's C# with internal_access beside a file that imports it", () => {
  needsProtoc();

  const messages = checked(MESSAGES);
  const files = generateCSharpMessages(messages.set, { blueprint: messages.blueprint });

  expect(namesOf(files)).toEqual([
    'Bead/Messages/V1/Messages.cs',
    'Bead/Messages/V1/Rules.cs',
    'Bead/Protobuf/Options.cs',
  ]);

  for (const file of files) {
    expect(file.content.startsWith(PROTOC_CSHARP_HEADER), file.name).toBe(true);
  }

  const [ownMessages, , options] = files;

  expect(ownMessages?.content).toContain('  public sealed partial class Greeting : ');
  expect(ownMessages?.content).toContain('global::Bead.Protobuf.OptionsReflection.Descriptor');
  expect(options?.content).toContain('  internal static partial class OptionsReflection {');
  expect(options?.content).not.toMatch(/^ {2}public /mu);
  expect(PROTOC_CSHARP_SOURCE.exec(ownMessages?.content ?? '')?.[1]).toBe(MESSAGES_PROTO);
});

test("writes protoc's C# from buf's set as protoc writes it from the .proto, its embedded descriptor aside, which differs by each field's default json_name alone", () => {
  needsProtoc();

  const messages = checked(MESSAGES);
  const fromSource = protocFromSource(test.info().outputPath('from-source'));
  // * rules.proto's messages lose protovalidate's options, which validate-options.test.ts holds
  const fromSet = generateCSharpMessages(messages.set, { blueprint: messages.blueprint }).filter(
    (file) => {
      return fromSource.has(file.name);
    }
  );

  expect(namesOf(fromSet)).toEqual([...fromSource.keys()]);

  for (const file of fromSet) {
    const theirs = splitOf(fromSource.get(file.name) ?? '');
    const ours = splitOf(file.content);
    const jsonNames = fieldsOf(ours.descriptor).filter((field) => {
      return field.jsonName !== '';
    });

    expect(ours.code, file.name).toBe(theirs.code);
    expect(equals(FileDescriptorProtoSchema, ours.descriptor, theirs.descriptor), file.name).toBe(
      false
    );

    // * buf's set writes each field's JSON name, its default; protoc's own descriptor leaves it out
    for (const field of jsonNames) {
      expect(field.jsonName, `${file.name} ${field.name}`).toBe(defaultJsonNameOf(field.name));
      clearField(field, FieldDescriptorProtoSchema.field.jsonName);
    }

    expect(jsonNames.length, file.name).toBeGreaterThan(0);
    expect(equals(FileDescriptorProtoSchema, ours.descriptor, theirs.descriptor), file.name).toBe(
      true
    );
  }
});

test('looks for no protoc for a blueprint of native bindings, and exits 2 naming the fix when it finds none', () => {
  const comments = checked(FIXTURES, ['bead/comments/v1/comments.proto']);
  const messages = checked(MESSAGES);
  const nowhere = join(test.info().outputPath('nowhere'), 'protoc');
  const pinned = protocPin().version;

  withProtoc(nowhere, () => {
    expect(generateCSharpMessages(comments.set, { blueprint: comments.blueprint })).toEqual([]);
    expect(() => {
      return generateCSharpMessages(messages.set, { blueprint: messages.blueprint });
    }).toThrow(InputError);
    expect(() => {
      return generateCSharpMessages(messages.set, { blueprint: messages.blueprint });
    }).toThrow(
      `no protoc at ${nowhere}, which writes the C# messages, pinned to protoc ${pinned}: name protoc ${pinned} by BEADC_PROTOC, from https://github.com/protocolbuffers/protobuf/releases/tag/v${pinned}, or run beadc's image, ghcr.io/francisdesjardins/beadc, which holds it; or set the output's messages to external`
    );
  });
});

test("writes two .proto files of one name in two packages, each in its namespace's folder", () => {
  const root = test.info().outputPath('two-greeters');

  for (const [letter, id] of [
    ['a', 1],
    ['b', 2],
  ] as const) {
    const path = join(root, 'acme', letter, 'v1', 'greeter.proto');

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        'syntax = "proto3";',
        '',
        `package acme.${letter}.v1;`,
        '',
        'import "bead/options.proto";',
        '',
        'option (bead.file) = {',
        '  admission: {',
        '    none: {}',
        '  }',
        '};',
        '',
        `service Greeter${letter.toUpperCase()}Service {`,
        `  option (bead.service) = {id: ${String(id)}, revision: 1};`,
        '',
        '  rpc Greet(Hello) returns (Hello) {',
        '    option (bead.procedure) = {id: 1};',
        '  }',
        '}',
        '',
        'message Hello {',
        '  string name = 1;',
        '}',
        '',
      ].join('\n')
    );
  }

  const greeters = checked(root);
  const services = csharpTarget.generate(
    {
      blueprint: greeters.blueprint,
      set: greeters.set,
      sources: { proto: new Map() },
    },
    { messages: Messages.GENERATE }
  );

  expect(csharpPathOf('acme/a/v1/greeter.proto', 'Acme.A.V1')).toBe('Acme/A/V1/Greeter.cs');
  expect(csharpPathOf('x/greeter_api.proto', '')).toBe('GreeterApi.cs');
  expect(namesOf(services)).toEqual(['Acme/A/V1/GreeterBead.cs', 'Acme/B/V1/GreeterBead.cs']);
  expect(services[0]?.content).toContain('\nnamespace Acme.A.V1;\n');
  expect(services[1]?.content).toContain('global::Acme.B.V1.Hello');

  needsProtoc();

  const messages = generateCSharpMessages(greeters.set, { blueprint: greeters.blueprint });

  expect(namesOf(messages)).toEqual([
    'Acme/A/V1/Greeter.cs',
    'Acme/B/V1/Greeter.cs',
    'Bead/Protobuf/Options.cs',
  ]);
});

test("protoc's refusal is beadc's exit 2, in protoc's words", () => {
  const stub = stubProtoc(test.info().outputPath('refusing'), {
    version: protocPin().version,
    refusal: 'bead/messages/v1/messages.proto: a refusal of its own',
  });
  const messages = checked(MESSAGES);

  withProtoc(stub, () => {
    expect(() => {
      return generateCSharpMessages(messages.set, { blueprint: messages.blueprint });
    }).toThrow(InputError);
    expect(() => {
      return generateCSharpMessages(messages.set, { blueprint: messages.blueprint });
    }).toThrow('protoc: bead/messages/v1/messages.proto: a refusal of its own');
  });
});

test('refuses a protoc of another version than its pin, naming both and the fix', () => {
  const stub = stubProtoc(test.info().outputPath('stub'), { version: '35.1' });
  const messages = checked(MESSAGES);
  const pinned = protocPin().version;

  withProtoc(stub, () => {
    expect(findProtoc()).toEqual({ path: stub, version: '35.1' });
    expect(() => {
      return generateCSharpMessages(messages.set, { blueprint: messages.blueprint });
    }).toThrow(
      `protoc 35.1 at ${stub}, where beadc is pinned to protoc ${pinned}, whose C# another writes otherwise: name protoc ${pinned} by BEADC_PROTOC, from https://github.com/protocolbuffers/protobuf/releases/tag/v${pinned}, or run beadc's image, ghcr.io/francisdesjardins/beadc, which holds it`
    );
  });
});
