import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFileRegistry, fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';

import { compile } from '../../../compile.ts';
import { propertyOf } from '../validators.ts';

const GOLDEN = new URL(
  '../../../../test/golden/csharp/Bead/Messages/V1/RulesBead.cs',
  import.meta.url
);

test("names a field's property as protoc's C# generator does: a member the message declares, or its own name, taken away with a _", () => {
  const folder = test.info().outputPath('names');

  mkdirSync(join(folder, 'n', 'v1'), { recursive: true });
  writeFileSync(
    join(folder, 'n', 'v1', 'n.proto'),
    [
      'syntax = "proto3";',
      '',
      'package n.v1;',
      '',
      'message Probe {',
      '  string types = 1;',
      '  string descriptor = 2;',
      '  string parser = 3;',
      '  string to_string = 4;',
      '  string probe = 5;',
      '  string a_1b = 6;',
      '  string x2y_z = 7;',
      '  string plain = 8;',
      '}',
      '',
    ].join('\n')
  );

  const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, compile([folder])));

  expect(registry.getMessage('n.v1.Probe')?.fields.map(propertyOf)).toEqual([
    'Types_',
    'Descriptor_',
    'Parser_',
    'ToString_',
    'Probe_',
    'A1B',
    'X2YZ',
    'Plain',
  ]);
});

test("writes each message's rules in a class of its file's own, its sites static readonly fields, and the bindings' Validate of them, a result's message never", () => {
  const golden = readFileSync(GOLDEN, 'utf8');

  expect(golden).toContain('\nfile static class MemberRules\n');
  expect(golden).toContain('\nfile static class AddressRules\n');
  expect(golden).toContain(
    'Validate = global::Bead.Protobuf.Validators.Of<global::Bead.Messages.V1.Member>(MemberRules.Check),'
  );
  expect(golden).toContain(
    '    private static readonly global::Bead.Protobuf.PatternTable NameStringPatternTable = new()'
  );
  expect(golden).not.toContain('ReceiptRules');
});

test('searches a string for a needle of one code unit by its char, ordinal already, as CA1847 and CA1865 ask', () => {
  const golden = readFileSync(GOLDEN, 'utf8');

  expect(golden).toContain("!message.Email.Contains('@')");
  expect(golden).not.toContain('Contains("@"');
});
