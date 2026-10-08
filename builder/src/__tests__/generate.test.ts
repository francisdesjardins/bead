import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { checkBlueprintFile, checkRoots, type IChecked } from '../check.ts';
import { type IConfig, parseConfig } from '../config.ts';
import { differencesOf, EDITOR_COPY, planOf, writePlan } from '../generate.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));
const OPTIONS = fileURLToPath(new URL('../../proto/bead/options.proto', import.meta.url));

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
