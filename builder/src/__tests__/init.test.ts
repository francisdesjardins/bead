import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { InputError } from '../diagnostics.ts';
import { initProject } from '../init.ts';
import { beadcVersion } from '../version.ts';
import { WRAPPERS, wrapperText } from '../wrappers.ts';
import { needsProtoc } from './pinned.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const OPTIONS = fileURLToPath(new URL('../../proto/bead/options.proto', import.meta.url));
const BUF = createRequire(import.meta.url).resolve('@bufbuild/buf/bin/buf');

const WINDOWS = process.platform === 'win32';

// beadc on Node, from `cwd`
const beadc = (
  args: readonly string[],
  cwd: string
): { status: number | null; stdout: string; stderr: string } => {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

// an empty folder in the running test's output folder
const folderOf = (name = 'project'): string => {
  const folder = test.info().outputPath(name);

  mkdirSync(folder, { recursive: true });

  return folder;
};

test('writes a project that check passes and generate writes', () => {
  needsProtoc();

  const folder = folderOf();
  const init = beadc(['init', 'hello_world'], folder);

  expect(init.stderr).toBe('');
  expect(init.status).toBe(0);
  expect(init.stdout).toContain('wrote proto/hello_world/v1/hello_world.proto\n');
  expect(init.stdout).toContain('  ./beadc.sh generate\n  ./beadc.ps1 generate\n');
  expect(init.stdout).toContain('  git add --chmod=+x beadc.sh\n');
  expect(readFileSync(join(folder, '.beadc', 'include', 'bead', 'options.proto'), 'utf8')).toBe(
    readFileSync(OPTIONS, 'utf8')
  );
  expect(
    readFileSync(join(folder, 'proto', 'hello_world', 'v1', 'hello_world.proto'), 'utf8')
  ).toContain('service HelloWorldService {');

  expect(beadc(['check'], folder)).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(beadc(['generate'], folder)).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(beadc(['generate', '--check'], folder)).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(existsSync(join(folder, 'gen', 'hello_world.blueprint.json'))).toBe(true);
  expect(
    existsSync(join(folder, 'typescript', 'gen', 'hello_world', 'v1', 'hello_world_bead.ts'))
  ).toBe(true);
  expect(existsSync(join(folder, 'dotnet', 'gen', 'HelloWorld', 'V1', 'HelloWorldBead.cs'))).toBe(
    true
  );

  // * buf's STANDARD lint, over buf.yaml's two modules, the editor's copy among them
  const lint = spawnSync(process.execPath, [BUF, 'lint'], { cwd: folder, encoding: 'utf8' });

  expect(lint.stdout + lint.stderr).toBe('');
  expect(lint.status).toBe(0);

  // one language asked, one output written, under its half's folder, and its git line alone
  const typescript = folderOf('typescript');

  expect(beadc(['init', 'hello', '--language', 'typescript'], typescript).status).toBe(0);

  const config = readFileSync(join(typescript, 'beadc.yaml'), 'utf8');

  expect(config).toContain('    out: typescript/gen\n    importExtension: ts\n');
  expect(config).not.toContain('csharp');
  expect(config).not.toContain('dotnet/gen');
  expect(readFileSync(join(typescript, '.gitattributes'), 'utf8')).toBe(
    [
      'beadc.sh text eol=lf',
      'beadc.ps1 text eol=lf',
      'gen/** text eol=lf linguist-generated=true',
      'typescript/gen/** text eol=lf linguist-generated=true',
      '',
    ].join('\n')
  );
});

test("lays each language's generated code under its own folder", () => {
  const version = beadcVersion();
  const folder = folderOf();

  initProject('hello', { folder, version });

  expect(readFileSync(join(folder, 'beadc.yaml'), 'utf8')).toContain(
    [
      'outputs:',
      '  - language: typescript',
      '    out: typescript/gen',
      '    importExtension: ts',
      '  - language: csharp',
      '    out: dotnet/gen',
      '',
    ].join('\n')
  );

  // the C# output alone: its folder, and its git line after the blueprint's
  const csharp = folderOf('csharp');

  initProject('hello', { folder: csharp, version, languages: ['csharp'] });

  const config = readFileSync(join(csharp, 'beadc.yaml'), 'utf8');

  expect(config).toContain('outputs:\n  - language: csharp\n    out: dotnet/gen\n');
  expect(config).not.toContain('typescript');
  expect(readFileSync(join(csharp, '.gitattributes'), 'utf8')).toBe(
    [
      'beadc.sh text eol=lf',
      'beadc.ps1 text eol=lf',
      'gen/** text eol=lf linguist-generated=true',
      'dotnet/gen/** text eol=lf linguist-generated=true',
      '',
    ].join('\n')
  );
});

test('writes nothing over a file that is there, exit 2', () => {
  const folder = folderOf();

  mkdirSync(join(folder, 'proto', 'hello', 'v1'), { recursive: true });
  writeFileSync(join(folder, 'proto', 'hello', 'v1', 'hello.proto'), '// mine\n');

  const run = beadc(['init', 'hello'], folder);

  expect(run.status).toBe(2);
  expect(run.stderr).toBe(
    'beadc: init writes proto/hello/v1/hello.proto, which is there: init writes over no file\n'
  );
  expect(readFileSync(join(folder, 'proto', 'hello', 'v1', 'hello.proto'), 'utf8')).toBe(
    '// mine\n'
  );

  for (const path of ['beadc.yaml', 'buf.yaml', 'beadc.sh', 'beadc.ps1', '.beadc', '.gitignore']) {
    expect(existsSync(join(folder, path)), path).toBe(false);
  }
});

test('keeps a wrapper that is byte for byte its own, and makes beadc.sh executable', () => {
  const version = beadcVersion();
  const folder = folderOf();

  writeFileSync(join(folder, 'beadc.sh'), wrapperText('beadc.sh', { version }));

  const initialized = initProject('hello', { folder, version });

  expect(initialized.kept).toEqual(['beadc.sh']);
  expect(initialized.written).toContain('beadc.ps1');
  expect(initialized.written).not.toContain('beadc.sh');

  if (!WINDOWS) {
    expect(statSync(join(folder, 'beadc.sh')).mode & 0o777).toBe(0o755);
  }

  // a wrapper of its own, or of another version, is the user's
  const other = folderOf('other');

  writeFileSync(join(other, 'beadc.ps1'), wrapperText('beadc.ps1', { version: '0.0.1' }));

  expect(() => {
    initProject('hello', { folder: other, version });
  }).toThrow(InputError);
  expect(existsSync(join(other, 'beadc.yaml'))).toBe(false);
});

test('appends its .gitattributes and .gitignore lines once', () => {
  const version = beadcVersion();
  const folder = folderOf();

  writeFileSync(join(folder, '.gitignore'), 'node_modules/');
  writeFileSync(join(folder, '.gitattributes'), '* text=auto\nbeadc.sh text eol=lf\n');

  expect(initProject('hello', { folder, version }).appended).toEqual([
    '.gitignore',
    '.gitattributes',
  ]);
  expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe('node_modules/\n.beadc/\n');
  expect(readFileSync(join(folder, '.gitattributes'), 'utf8')).toBe(
    [
      '* text=auto',
      'beadc.sh text eol=lf',
      'beadc.ps1 text eol=lf',
      'gen/** text eol=lf linguist-generated=true',
      'typescript/gen/** text eol=lf linguist-generated=true',
      'dotnet/gen/** text eol=lf linguist-generated=true',
      '',
    ].join('\n')
  );

  // a second project beside the same git files appends nothing
  const again = folderOf('again');

  for (const file of ['.gitignore', '.gitattributes']) {
    writeFileSync(join(again, file), readFileSync(join(folder, file)));
  }

  expect(initProject('hello', { folder: again, version }).appended).toEqual([]);
  expect(readFileSync(join(again, '.gitignore'), 'utf8')).toBe('node_modules/\n.beadc/\n');
});

test("refuses a name that is no proto package's part, and a missing one", () => {
  const folder = folderOf();

  for (const args of [
    ['init'],
    ['init', 'Hello'],
    ['init', '1hello'],
    ['init', 'hello-world'],
    ['init', 'hello.v1'],
    ['init', 'hello', '--language', 'rust'],
    ['check', '--language', 'typescript'],
  ]) {
    const run = beadc(args, folder);

    expect(run.status, args.join(' ')).toBe(2);
    expect(run.stderr, args.join(' ')).toMatch(/^beadc: /u);
  }

  expect(existsSync(join(folder, 'beadc.yaml'))).toBe(false);
});

test('writes beadc.sh executable, both wrappers filled and in LF', () => {
  const version = beadcVersion();
  const folder = folderOf();

  initProject('hello', { folder, version });

  for (const name of WRAPPERS) {
    const text = readFileSync(join(folder, name), 'utf8');

    expect(text).toBe(wrapperText(name, { version }));
    expect(text).not.toContain('\r');
    expect(text).toContain(`ghcr.io/francisdesjardins/beadc:${version}`);
  }

  if (!WINDOWS) {
    expect(statSync(join(folder, 'beadc.sh')).mode & 0o777).toBe(0o755);
  }
});
