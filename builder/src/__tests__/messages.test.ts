import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkRoots, type IChecked } from '../check.ts';
import { generateMessages } from '../messages.ts';
import type { IBlueprint } from '../model/blueprint.ts';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const MESSAGES_PROTO = 'bead/messages/v1/messages.proto';

const require = createRequire(import.meta.url);

const checked = (
  root: string,
  files?: readonly string[]
): IChecked & { blueprint: IBlueprint; set: Uint8Array } => {
  const result = checkRoots([root], files === undefined ? {} : { files });

  if (result.blueprint === undefined || result.set === undefined) {
    throw new Error(`${root}: no blueprint`);
  }

  return { ...result, blueprint: result.blueprint, set: result.set };
};

test('generates bead/options_pb.ts beside a file that imports it', () => {
  const messages = checked(MESSAGES);
  const files = generateMessages(messages.set, {
    blueprint: messages.blueprint,
    importExtension: 'ts',
  });

  expect(
    files.map((file) => {
      return file.name;
    })
  ).toEqual([
    'bead/options_pb.ts',
    'bead/messages/v1/messages_pb.ts',
    'bead/messages/v1/rules_pb.ts',
  ]);
  expect(files[1]?.content).toContain(' from "../../options_pb.ts";\n');
  expect(files[1]?.content).toContain(' from "@bufbuild/protobuf/wkt";\n');

  // a blueprint that binds no message of its own generates none
  const comments = checked(FIXTURES, ['bead/comments/v1/comments.proto']);

  expect(
    generateMessages(comments.set, { blueprint: comments.blueprint, importExtension: 'ts' })
  ).toEqual([]);
});

test("writes protoc-gen-es's output as buf generate does", () => {
  const messages = checked(MESSAGES);
  const out = test.info().outputPath('buf-generate');
  // * rules.proto's messages lose protovalidate's options, which validate-options.test.ts holds
  const files = generateMessages(messages.set, {
    blueprint: messages.blueprint,
    importExtension: 'ts',
  }).filter((file) => {
    return file.name !== 'bead/messages/v1/rules_pb.ts';
  });

  // buf generate over beadc's options and the fixture, the stock plugin under the Node that runs it
  execFileSync(
    process.execPath,
    [
      require.resolve('@bufbuild/buf/bin/buf'),
      'generate',
      BUILDER,
      '--config',
      JSON.stringify({
        version: 'v2',
        modules: [{ path: 'proto' }, { path: 'test/messages' }],
      }),
      '--template',
      JSON.stringify({
        version: 'v2',
        plugins: [
          {
            local: [process.execPath, require.resolve('@bufbuild/protoc-gen-es/bin/protoc-gen-es')],
            out,
            opt: ['target=ts', 'erasable_syntax=true', 'import_extension=ts'],
          },
        ],
      }),
      '--path',
      join(BUILDER, 'proto', 'bead', 'options.proto'),
      '--path',
      join(MESSAGES, ...MESSAGES_PROTO.split('/')),
    ],
    { cwd: BUILDER, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  expect(files).toHaveLength(2);

  for (const file of files) {
    expect(file.content, file.name).toBe(readFileSync(join(out, file.name), 'utf8'));
  }
});
