import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

// beadc as a user runs it: Node, src/cli.ts as written, from builder/ or the folder given, after
// the modules `node` is given to load first
const beadc = (
  args: readonly string[],
  options: { readonly cwd?: string; readonly imports?: readonly string[] } = {}
): { status: number | null; stdout: string; stderr: string } => {
  const run = spawnSync(
    process.execPath,
    [
      ...(options.imports ?? []).flatMap((module) => {
        return ['--import', module];
      }),
      CLI,
      ...args,
    ],
    { cwd: options.cwd ?? BUILDER, encoding: 'utf8' }
  );

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

// a project of the interop's blueprint and one output, in the running test's output folder
const interopProject = (): string => {
  const folder = test.info().outputPath('project');

  mkdirSync(join(folder, 'spec'), { recursive: true });
  writeFileSync(join(folder, 'spec', 'interop-blueprint.json'), readFileSync(INTEROP));
  writeFileSync(
    join(folder, 'beadc.yaml'),
    [
      'version: 1',
      'source:',
      '  blueprint: spec/interop-blueprint.json',
      'outputs:',
      '  - language: typescript',
      '    out: gen',
      '',
    ].join('\n')
  );

  return folder;
};

test('node runs src/cli.ts version as written, as a child process', () => {
  const run = beadc(['version']);

  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(
    /^beadc \d+\.\d+\.\d+\nbuf 1\.73\.0\nprotobuf-es \d+\.\d+\.\d+\nprotoplugin \d+\.\d+\.\d+\nprotoc-gen-es \d+\.\d+\.\d+\nformat bead-blueprint\/1\nspec \d+\.\d+\.\d+\noptions 58500\n$/u
  );
});

test("blueprint --check exits 1 on a blueprint off its form and 0 on the interop's", () => {
  const off = test.info().outputPath('off-form.json');

  writeFileSync(off, readFileSync(INTEROP, 'utf8').replace('"requires": []', '"requires":  []'));

  expect(beadc(['blueprint', '--check', INTEROP]).status).toBe(0);
  expect(beadc(['check', INTEROP]).status).toBe(0);

  const run = beadc(['blueprint', '--check', off]);

  expect(run.status).toBe(1);
  expect(run.stdout).toContain(':3: line 3 is off its form');
});

test('blueprint -o writes nothing for a blueprint check refuses', () => {
  const refused = test.info().outputPath('refused.json');
  const out = test.info().outputPath('out.json');

  writeFileSync(refused, readFileSync(INTEROP, 'utf8').replace('"serviceId": 1', '"serviceId": 0'));

  const run = beadc(['blueprint', refused, '-o', out]);

  expect(run.status).toBe(1);
  expect(run.stdout).toContain('error SERVICE_ID_RANGE');
  expect(existsSync(out)).toBe(false);
});

test(".proto's blueprint written in its form, and its set beside it", () => {
  const out = test.info().outputPath('fixtures.blueprint.json');
  const set = test.info().outputPath('fixtures.binpb');
  const run = beadc(['blueprint', FIXTURES, '-o', out, '--descriptor-set-out', set]);

  expect(run.stdout + run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(beadc(['blueprint', '--check', out]).status).toBe(0);
  expect(beadc(['blueprint', '--check', FIXTURES, '-o', out]).status).toBe(0);
  expect(existsSync(set)).toBe(true);
});

test('a call beadc cannot take exits 2', () => {
  expect(beadc([]).status).toBe(2);
  expect(beadc(['generate', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--no-such-flag', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--except', 'NAME_FORM', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--except', 'NO_SUCH_RULE', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--error-format', 'xml', INTEROP]).status).toBe(2);
  expect(beadc(['check', 'no-such-file.json']).status).toBe(2);
  expect(beadc(['blueprint', INTEROP]).status).toBe(2);
});

test('a warning fails under --fail-on-warning, and --except leaves it out', () => {
  const newer = test.info().outputPath('newer.json');

  writeFileSync(
    newer,
    readFileSync(INTEROP, 'utf8').replace(/"specVersion": "[^"]*"/u, '"specVersion": "99.0.0"')
  );

  expect(beadc(['check', newer]).status).toBe(0);
  expect(beadc(['check', '--fail-on-warning', newer]).status).toBe(1);
  expect(
    beadc(['check', '--fail-on-warning', '--except', 'SPEC_VERSION_NEWER', newer]).status
  ).toBe(0);
  expect(beadc(['check', '--error-format', 'github', newer]).stdout).toMatch(
    /^::warning file=.*title=SPEC_VERSION_NEWER::/u
  );
});

test("node runs src/cli.ts generate, then generate --check, over a fixture's beadc.yaml: exit 0, then exit 1 on a file changed", () => {
  const folder = interopProject();
  const generated = join(folder, 'gen', 'interop_bead.ts');

  expect(beadc(['generate', '--check'], { cwd: folder }).status).toBe(1);
  expect(beadc(['generate'], { cwd: folder })).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(beadc(['generate', '--check'], { cwd: folder })).toEqual({
    status: 0,
    stdout: '',
    stderr: '',
  });

  writeFileSync(generated, readFileSync(generated, 'utf8').replace('Do not edit', 'Edit'));

  const run = beadc(['generate', '--check', '--error-format', 'github'], { cwd: folder });

  expect(run.status).toBe(1);
  expect(run.stdout).toBe(
    '::error file=gen/interop_bead.ts,line=2,title=not what beadc generates::line 2 differs from what beadc generate writes\n'
  );
});

test('check, blueprint and version load no TypeScript compiler', () => {
  const hook = test.info().outputPath('compilers.mjs');
  const folder = interopProject();

  // * a resolve hook that names each TypeScript compiler a run resolves, as it exits
  writeFileSync(
    hook,
    [
      "import { writeSync } from 'node:fs';",
      "import { registerHooks } from 'node:module';",
      'const loaded = new Set();',
      'registerHooks({',
      '  resolve: (specifier, context, nextResolve) => {',
      '    const resolved = nextResolve(specifier, context);',
      '    const compiler = /\\/node_modules\\/(typescript|typescript-7|@typescript\\/vfs)\\//u.exec(resolved.url);',
      '    if (compiler !== null) {',
      '      loaded.add(compiler[1]);',
      '    }',
      '    return resolved;',
      '  },',
      '});',
      "process.on('exit', () => {",
      "  writeSync(2, `compilers: ${[...loaded].sort().join(' ')}\\n`);",
      '});',
      '',
    ].join('\n')
  );

  const compilersOf = (args: readonly string[], cwd?: string): string => {
    const run = beadc(args, {
      imports: [pathToFileURL(hook).href],
      ...(cwd === undefined ? {} : { cwd }),
    });

    expect(run.status, args.join(' ')).toBe(0);

    return /^compilers: (.*)$/mu.exec(run.stderr)?.[1] ?? 'none recorded';
  };

  expect(compilersOf(['check', INTEROP])).toBe('');
  expect(compilersOf(['blueprint', '--check', INTEROP])).toBe('');
  expect(compilersOf(['version'])).toBe('');
  // the hook sees what generate loads: protoplugin's compiler
  expect(compilersOf(['generate'], folder)).toContain('typescript');
});
