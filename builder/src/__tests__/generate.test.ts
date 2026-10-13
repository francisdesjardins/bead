import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkBlueprintFile, checkRoots, type IChecked } from '../check.ts';
import { type IConfig, parseConfig } from '../config.ts';
import { InputError } from '../diagnostics.ts';
import type { IBlueprint } from '../model/blueprint.ts';
import { differencesOf, EDITOR_COPY, planOf, writeEditorCopy, writePlan } from '../generate.ts';
import { PROTOC_CSHARP_HEADER } from '../protoc.ts';
import { needsProtoc } from './pinned.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));
const OPTIONS = fileURLToPath(new URL('../../proto/bead/options.proto', import.meta.url));
const MESSAGES_PROTO = 'bead/messages/v1/messages.proto';

// a project in the running test's output folder: its beadc.yaml and its files, by their paths
const projectOf = (yaml: string, files: Readonly<Record<string, string>> = {}): string => {
  const folder = test.info().outputPath('project');

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'beadc.yaml'), yaml);

  for (const [path, from] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    cpSync(from, join(folder, path), { recursive: true });
  }

  return folder;
};

const configOf = (folder: string): IConfig => {
  return parseConfig(readFileSync(join(folder, 'beadc.yaml'), 'utf8'), { folder });
};

const checkedOf = (config: IConfig): IChecked => {
  const { source } = config;

  return 'proto' in source
    ? checkRoots(source.proto)
    : checkBlueprintFile(source.blueprint, { file: 'blueprint.json' });
};

// what --check finds, each path from the project's folder, with slashes
const findingsOf = (folder: string): string[] => {
  const config = configOf(folder);

  return differencesOf(planOf(config, checkedOf(config))).map((difference) => {
    const path = difference.path.slice(folder.length + 1).replaceAll('\\', '/');

    return `${path}${difference.line === undefined ? '' : `:${String(difference.line)}`}: ${difference.message}`;
  });
};

const generate = (folder: string): void => {
  const config = configOf(folder);

  writePlan(planOf(config, checkedOf(config)), config);
};

const TWO_OUTPUTS = [
  'version: 1',
  'source:',
  '  blueprint: spec/interop-blueprint.json',
  'outputs:',
  '  - language: typescript',
  '    out: a',
  '  - language: typescript',
  '    out: b',
  '    importExtension: none',
  '',
].join('\n');

test("--check names a difference, a file missing and a stale _bead.ts, and leaves another generator's file alone", () => {
  const folder = projectOf(TWO_OUTPUTS, { 'spec/interop-blueprint.json': INTEROP });

  expect(findingsOf(folder)).toEqual([
    'a/interop_bead.ts: no such file; beadc generate writes it',
    'b/interop_bead.ts: no such file; beadc generate writes it',
  ]);

  generate(folder);
  expect(findingsOf(folder)).toEqual([]);

  const changed = join(folder, 'a', 'interop_bead.ts');

  writeFileSync(
    changed,
    readFileSync(changed, 'utf8').replace('echo: requestOf', 'echoed: requestOf')
  );
  rmSync(join(folder, 'b', 'interop_bead.ts'));
  writeFileSync(join(folder, 'a', 'old_bead.ts'), 'export {};\n');
  writeFileSync(join(folder, 'a', 'other_pb.ts'), 'export {};\n');
  writeFileSync(join(folder, 'a', 'handlers.ts'), 'export {};\n');

  expect(findingsOf(folder)).toEqual([
    'a/interop_bead.ts:17: line 17 differs from what beadc generate writes',
    'b/interop_bead.ts: no such file; beadc generate writes it',
    'a/old_bead.ts: beadc generate writes no such file from this source; it takes it out',
  ]);

  generate(folder);
  expect(findingsOf(folder)).toEqual([]);
  expect(existsSync(join(folder, 'a', 'old_bead.ts'))).toBe(false);
  expect(existsSync(join(folder, 'a', 'other_pb.ts'))).toBe(true);
  expect(existsSync(join(folder, 'a', 'handlers.ts'))).toBe(true);
});

test('--check reads CRLF as LF', () => {
  const folder = projectOf(TWO_OUTPUTS, { 'spec/interop-blueprint.json': INTEROP });

  generate(folder);

  for (const out of ['a', 'b']) {
    const file = join(folder, out, 'interop_bead.ts');

    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  }

  expect(findingsOf(folder)).toEqual([]);
});

test('writes nothing when check refuses', () => {
  const folder = projectOf(TWO_OUTPUTS, { 'spec/interop-blueprint.json': INTEROP });

  writeFileSync(
    join(folder, 'spec', 'interop-blueprint.json'),
    readFileSync(INTEROP, 'utf8').replace('"serviceId": 1', '"serviceId": 0')
  );

  const run = spawnSync(process.execPath, [CLI, 'generate'], { cwd: folder, encoding: 'utf8' });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain('error SERVICE_ID_RANGE');
  expect(existsSync(join(folder, 'a'))).toBe(false);
  expect(existsSync(join(folder, 'b'))).toBe(false);
});

test("writes the editor's copy for a .proto source and never compares it", () => {
  const folder = projectOf(
    [
      'version: 1',
      'source:',
      '  proto: [proto]',
      'blueprint: gen/bead.blueprint.json',
      'outputs:',
      '  - language: typescript',
      '    out: gen/ts',
      '',
    ].join('\n'),
    { proto: MESSAGES }
  );
  const copy = join(folder, ...EDITOR_COPY.split('/'), 'bead', 'options.proto');

  generate(folder);

  expect(readFileSync(copy, 'utf8')).toBe(readFileSync(OPTIONS, 'utf8'));
  expect(existsSync(join(folder, 'gen', 'bead.blueprint.json'))).toBe(true);
  expect(existsSync(join(folder, 'gen', 'ts', 'bead', 'options_pb.ts'))).toBe(true);
  expect(existsSync(join(folder, 'gen', 'ts', 'bead', 'messages', 'v1', 'messages_pb.ts'))).toBe(
    true
  );
  expect(
    readFileSync(join(folder, 'gen', 'ts', 'bead', 'messages', 'v1', 'messages_bead.ts'), 'utf8')
  ).toMatch(/^\/\/ @generated by beadc [^ ]+ from proto\/bead\/messages\/v1\/messages\.proto: /u);

  writeFileSync(copy, '// changed\n');
  writeFileSync(join(folder, 'gen', 'ts', 'old_pb.ts'), 'export {};\n');

  expect(findingsOf(folder)).toEqual([
    'gen/ts/old_pb.ts: beadc generate writes no such file from this source; it takes it out',
  ]);
});

test("writes the editor's copy by its content, its mode the folder's own", () => {
  const folder = test.info().outputPath('project');
  const copy = join(folder, ...EDITOR_COPY.split('/'), 'bead', 'options.proto');

  writeEditorCopy(folder);

  expect(readFileSync(copy, 'utf8')).toBe(readFileSync(OPTIONS, 'utf8'));

  // ! a copy of the file would carry its mode, 0755 in an image built from a Windows checkout:
  // written, it takes the one any file written there takes
  const written = join(folder, 'written');

  writeFileSync(written, '');

  expect(statSync(copy).mode & 0o777).toBe(statSync(written).mode & 0o777);
});

// protoc's first lines for `source`, and the namespace it writes its types in, as its C# file holds
const protocFileOf = (source: string, namespace: string): string => {
  return [
    `${PROTOC_CSHARP_HEADER}//     source: ${source}`,
    '// </auto-generated>',
    '#pragma warning disable 1591, 0612, 3021, 8981',
    '#region Designer generated code',
    '',
    `namespace ${namespace} {`,
    '}',
    '',
    '#endregion Designer generated code',
    '',
  ].join('\n');
};

// a .proto of package `packageName` declaring `service`, its procedures over JSON
const greeterOf = (
  packageName: string,
  service: { readonly name: string; readonly id: number }
) => {
  return [
    'syntax = "proto3";',
    '',
    `package ${packageName};`,
    '',
    'import "bead/options.proto";',
    '',
    'option (bead.file) = {',
    '  admission: {',
    '    none: {}',
    '  }',
    '};',
    '',
    `service ${service.name}Service {`,
    `  option (bead.service) = {id: ${String(service.id)}, revision: 1};`,
    '',
    '  rpc Greet(bead.Json) returns (bead.Json) {',
    '    option (bead.procedure) = {id: 1};',
    '  }',
    '}',
    '',
  ].join('\n');
};

test("--check names a stale Bead.cs by its header and protoc's file by its header and the path protoc gives its source, and leaves a project's .cs, a gRPC stub and a build's obj/ alone", () => {
  needsProtoc();

  const folder = projectOf(
    [
      'version: 1',
      'source:',
      '  proto: [proto]',
      'outputs:',
      '  - language: csharp',
      '    out: gen',
      '',
    ].join('\n'),
    { proto: MESSAGES }
  );
  const write = (path: string, content: string): string => {
    const file = join(folder, 'gen', ...path.split('/'));

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);

    return file;
  };

  expect(findingsOf(folder)).toEqual([
    'gen/Bead/Messages/V1/Messages.cs: no such file; beadc generate writes it',
    'gen/Bead/Protobuf/Options.cs: no such file; beadc generate writes it',
    'gen/Bead/Messages/V1/MessagesBead.cs: no such file; beadc generate writes it',
  ]);

  generate(folder);
  expect(findingsOf(folder)).toEqual([]);

  const kept = [
    // a project's own, gRPC's stub of a source beadc generates, and a build's outputs
    write('Notes.cs', 'namespace Acme;\n'),
    write('Bead/Messages/V1/MessagesGrpc.cs', protocFileOf(MESSAGES_PROTO, 'Bead.Messages.V1')),
    write(
      'obj/Debug/net10.0/Bead/Messages/V1/Messages.cs',
      protocFileOf(MESSAGES_PROTO, 'Bead.Messages.V1')
    ),
    write('obj/OldBead.cs', `// @generated by beadc 0.1.0 from proto/old.proto: x, spec 0.1.0.\n`),
  ];
  const taken = [
    write(
      'Bead/Messages/V1/Old.cs',
      protocFileOf('bead/messages/v1/old.proto', 'Bead.Messages.V1')
    ),
    write('OldBead.cs', `// @generated by beadc 0.1.0 from proto/old.proto: x, spec 0.1.0.\n`),
  ];

  expect(findingsOf(folder)).toEqual([
    'gen/Bead/Messages/V1/Old.cs: beadc generate writes no such file from this source; it takes it out',
    'gen/OldBead.cs: beadc generate writes no such file from this source; it takes it out',
  ]);

  generate(folder);
  expect(findingsOf(folder)).toEqual([]);
  expect(
    taken.filter((file) => {
      return existsSync(file);
    })
  ).toEqual([]);
  expect(
    kept.filter((file) => {
      return existsSync(file);
    })
  ).toEqual(kept);
});

test('refuses two files written at one path, naming both sources', () => {
  // C#: two .proto files of one namespace and one name, each a service
  const csharp = projectOf(
    [
      'version: 1',
      'source:',
      '  proto: [proto]',
      'outputs:',
      '  - language: csharp',
      '    out: gen',
      '',
    ].join('\n')
  );

  for (const [path, service] of [
    ['acme/v1/greeter.proto', { name: 'Greeter', id: 1 }],
    ['acme/v1/sub/greeter.proto', { name: 'Other', id: 2 }],
  ] as const) {
    const file = join(csharp, 'proto', ...path.split('/'));

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, greeterOf('acme.v1', service));
  }

  const config = configOf(csharp);
  const checked = checkedOf(config);

  expect(checked.diagnostics).toEqual([]);
  expect(() => {
    return planOf(config, checked);
  }).toThrow(InputError);
  expect(() => {
    return planOf(config, checked);
  }).toThrow(
    'generate would write gen/Acme/V1/GreeterBead.cs from proto/acme/v1/greeter.proto and gen/Acme/V1/GreeterBead.cs from proto/acme/v1/sub/greeter.proto, one file where a system folds case'
  );

  // TypeScript: two outputs whose folders a system that folds case reads as one
  const typescript = projectOf(
    [
      'version: 1',
      'source:',
      '  blueprint: spec/interop-blueprint.json',
      'outputs:',
      '  - language: typescript',
      '    out: gen',
      '  - language: typescript',
      '    out: Gen',
      '',
    ].join('\n'),
    { 'spec/interop-blueprint.json': INTEROP }
  );
  const twoFolders = configOf(typescript);

  expect(() => {
    return planOf(twoFolders, checkedOf(twoFolders));
  }).toThrow(
    'generate would write gen/interop_bead.ts from spec/interop-blueprint.json and Gen/interop_bead.ts from spec/interop-blueprint.json, one file where a system folds case'
  );
});

// a blueprint whose service names `file` as its `.proto`, a description in it that a shell would run
const climbingOf = (file: string): string => {
  return `${JSON.stringify(
    {
      format: 'bead-blueprint/1',
      specVersion: '0.3.0',
      requires: [],
      reservedServices: { ids: [], names: [] },
      services: [
        {
          serviceName: 'Shop',
          serviceId: 1,
          serviceRevision: 1,
          description: 'A shop.\n\n$(echo INJECTED-BY-BLUEPRINT > injected.txt)',
          failures: [],
          reserved: { procedureIds: [], procedureNames: [], failureCodes: [] },
          procedures: [
            {
              procedureId: 1,
              procedureName: 'echo',
              procedureKind: 'request',
              request: { encoding: 'text' },
              result: { encoding: 'text' },
              admission: 'none',
              failures: [],
            },
          ],
          proto: { file, fullName: 'shop.v1.ShopService' },
        },
      ],
    },
    undefined,
    2
  )}\n`;
};

test("a blueprint's proto.file that climbs out is check's PROTO_FILE, and planOf, given it unchecked, still refuses a file outside its output's folder and writes nothing", () => {
  const folder = projectOf(
    [
      'version: 1',
      'source:',
      '  blueprint: api.blueprint.json',
      'outputs:',
      '  - language: typescript',
      '    out: gen/ts',
      '',
    ].join('\n')
  );
  const wrapper = join(folder, 'beadc.sh');

  writeFileSync(join(folder, 'api.blueprint.json'), climbingOf('../../beadc.sh'));
  writeFileSync(wrapper, '#!/bin/sh\necho kept\n');

  const config = configOf(folder);

  expect(
    checkedOf(config).diagnostics.map((diagnostic) => {
      return `${diagnostic.rule} ${diagnostic.pointer ?? ''}`;
    })
  ).toEqual(['PROTO_FILE /services/0/proto/file']);

  // * the layer below: a blueprint given to planOf through the API, without check
  const unchecked = (file: string): IChecked => {
    return { diagnostics: [], blueprint: JSON.parse(climbingOf(file)) as IBlueprint };
  };

  expect(() => {
    return planOf(config, unchecked('../../beadc.sh'));
  }).toThrow(
    "generate would write beadc.sh, outside its output gen/ts: a service's proto.file in the blueprint names a path that climbs out of it"
  );

  for (const args of [['generate'], ['generate', '--check']]) {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: folder, encoding: 'utf8' });

    expect(run.status, args.join(' ')).toBe(1);
    expect(run.stdout, args.join(' ')).toContain('PROTO_FILE');
  }

  expect(readFileSync(wrapper, 'utf8')).toBe('#!/bin/sh\necho kept\n');
  expect(existsSync(join(folder, 'gen'))).toBe(false);

  // above the project's folder, where a run on Node reaches
  expect(() => {
    return planOf(config, unchecked('../../../outside/.bashrc.proto'));
  }).toThrow(/generate would write \.\.\/outside\/\.bashrc_bead\.ts, outside its output gen\/ts/u);
});

test('writes a C# output from a blueprint at its root, in its namespace, and --check holds it there', () => {
  const folder = projectOf(
    [
      'version: 1',
      'source:',
      '  blueprint: spec/interop-blueprint.json',
      'outputs:',
      '  - language: csharp',
      '    out: gen',
      '    namespace: Acme.Interop',
      '',
    ].join('\n'),
    { 'spec/interop-blueprint.json': INTEROP }
  );

  expect(findingsOf(folder)).toEqual([
    'gen/InteropBead.cs: no such file; beadc generate writes it',
  ]);

  generate(folder);

  const written = join(folder, 'gen', 'InteropBead.cs');

  expect(readFileSync(written, 'utf8')).toContain('\nnamespace Acme.Interop;\n');
  expect(findingsOf(folder)).toEqual([]);

  writeFileSync(written, readFileSync(written, 'utf8').replace('Acme.Interop;', 'Acme.Other;'));
  expect(findingsOf(folder)).toEqual([
    'gen/InteropBead.cs:8: line 8 differs from what beadc generate writes',
  ]);
});
