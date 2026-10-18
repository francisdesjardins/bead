import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { readStandardInput } from '../breaking/against.ts';
import { extractArchive } from '../breaking/archive.ts';
import { InputError } from '../diagnostics.ts';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const PAIR = 'test/breaking/buf';
const ARCHIVE = new URL('../../test/breaking/archive/archive.tar', import.meta.url);

// beadc as a user runs it, outside a workflow: Node, src/cli.ts as written, from builder/ or the
// folder given, after the modules `node` is given to load first, `input` on its standard input
const beadc = (
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly imports?: readonly string[];
    readonly input?: Uint8Array;
  } = {}
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
    {
      cwd: options.cwd ?? BUILDER,
      encoding: 'utf8',
      // ! CI's runner sets GITHUB_WORKSPACE, which moves every file the github format names
      env: { ...process.env, GITHUB_WORKSPACE: '' },
      ...(options.input === undefined ? {} : { input: options.input }),
    }
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
    /^beadc \d+\.\d+\.\d+\nbuf 1\.74\.0\nprotobuf-es \d+\.\d+\.\d+\nprotoplugin \d+\.\d+\.\d+\nprotoc-gen-es \d+\.\d+\.\d+\nprotoc (?:\d+\.\d+|(?:none|\d+\.\d+), pinned \d+\.\d+)\nformat bead-blueprint\/1\nspec \d+\.\d+\.\d+\noptions 58500\n$/u
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

test('the usage names every command, init and wrapper among them', () => {
  const run = beadc([]);

  expect(run.status).toBe(2);

  for (const command of [
    'check',
    'blueprint',
    'generate',
    'breaking',
    'init <name>',
    'wrapper',
    'version',
  ]) {
    expect(run.stderr).toContain(`
  ${command} `);
  }

  expect(run.stderr).toContain('--language typescript|csharp');
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

test("generate --check in the github format escapes its file as a workflow command's property", () => {
  const folder = interopProject();

  writeFileSync(
    join(folder, 'beadc.yaml'),
    [
      'version: 1',
      'source:',
      '  blueprint: spec/interop-blueprint.json',
      'outputs:',
      '  - language: typescript',
      "    out: 'gen,v2%'",
      '',
    ].join('\n')
  );

  const run = beadc(['generate', '--check', '--error-format', 'github'], { cwd: folder });

  expect(run.status).toBe(1);
  expect(run.stdout).toBe(
    '::error file=gen%2Cv2%25/interop_bead.ts,title=not what beadc generates::no such file; beadc generate writes it\n'
  );
});

test('check, blueprint, breaking and version load no TypeScript compiler', () => {
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
  expect(compilersOf(['breaking', INTEROP, '--against', INTEROP])).toBe('');
  // the hook sees what generate loads: protoplugin's compiler
  expect(compilersOf(['generate'], folder)).toContain('typescript');
});

test('breaking exits 0 against itself, 1 on a finding, 0 once a scoped --except names its subject', () => {
  const limited = test.info().outputPath('limited.json');

  // echo states a limit, the revision moved: PROCEDURE_SAME_LIMIT alone
  writeFileSync(
    limited,
    readFileSync(INTEROP, 'utf8')
      .replace('"procedureId": 1,', '"maximumPayloadBytes": 1024,\n          "procedureId": 1,')
      .replace('"serviceRevision": 1', '"serviceRevision": 2')
  );

  expect(beadc(['breaking', INTEROP, '--against', INTEROP]).status).toBe(0);

  const found = beadc(['breaking', limited, '--against', INTEROP]);

  expect(found.status).toBe(1);
  expect(found.stdout).toMatch(
    /#\/services\/0\/procedures\/0\/maximumPayloadBytes: error PROCEDURE_SAME_LIMIT: /u
  );
  expect(
    beadc([
      'breaking',
      limited,
      '--against',
      INTEROP,
      '--except',
      'PROCEDURE_SAME_LIMIT@service:1/procedure:1',
    ]).status
  ).toBe(0);

  // * another procedure's subject waives nothing: the finding stands, and the waiver is said
  const other = beadc([
    'breaking',
    limited,
    '--against',
    INTEROP,
    '--except',
    'PROCEDURE_SAME_LIMIT@service:1/procedure:2',
  ]);

  expect(other.status).toBe(1);
  expect(other.stdout).toContain(
    'warning WAIVER_UNUSED: --except PROCEDURE_SAME_LIMIT@service:1/procedure:2 waived nothing: take it out'
  );
  expect(beadc(['breaking', limited, '--against', INTEROP, '--category', 'WIRE']).status).toBe(1);
});

test("breaking refuses --against missing, --category other than WIRE or API, --except of a rule it does not run, buf:<RULE> buf does not know, and a breaking rule's or buf's bare, exit 2", () => {
  const refused = [
    ['breaking', INTEROP],
    ['breaking', INTEROP, '--against', INTEROP, '--category', 'FILE'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'NAME_FORM'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'NO_SUCH_RULE'],
    ['breaking', INTEROP, '--against', INTEROP, '--category', 'WIRE', '--except', 'NAME_NO_DELETE'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'buf:NO_SUCH_RULE'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'buf:RPC_NO_DELETE'],
    [
      'breaking',
      INTEROP,
      '--against',
      INTEROP,
      '--category',
      'WIRE',
      '--except',
      'buf:FIELD_SAME_TYPE',
    ],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'PROCEDURE_SAME_NAME@/services/0'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'PROCEDURE_SAME_NAME@service:1'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'WAIVER_UNUSED'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'PROCEDURE_SAME_NAME'],
    ['breaking', INTEROP, '--against', INTEROP, '--except', 'buf:FIELD_SAME_TYPE'],
    ['breaking', INTEROP, '--against', 'no-such-earlier'],
    ['check', INTEROP, '--against', INTEROP],
    ['check', INTEROP, '--category', 'WIRE'],
  ];

  for (const args of refused) {
    const run = beadc(args);

    expect(run.status, args.join(' ')).toBe(2);
    expect(run.stderr, args.join(' ')).toMatch(/^beadc: /u);
  }

  // a warning of check's is no refusal: it waives nothing here, which WAIVER_UNUSED says, a
  // warning that --fail-on-warning refuses
  for (const except of ['SPEC_VERSION_NEWER']) {
    const unused = beadc(['breaking', INTEROP, '--against', INTEROP, '--except', except]);

    expect(unused.status, except).toBe(0);
    expect(unused.stdout, except).toContain(
      `warning WAIVER_UNUSED: --except ${except} waived nothing`
    );
    expect(
      beadc(['breaking', INTEROP, '--against', INTEROP, '--except', except, '--fail-on-warning'])
        .status,
      except
    ).toBe(1);
  }
});

test("breaking over a .proto prints Bead's finding at the rpc's span and buf's at the field's", () => {
  test.setTimeout(60_000);

  const file = `${PAIR}/current/parcel/v1/parcel.proto`;
  const pair = ['breaking', `${PAIR}/current`, '--against', `${PAIR}/earlier`];
  const run = beadc(pair);
  const renamed = `${file}:22:7: error PROCEDURE_SAME_NAME: `;
  const field = `${file}:34:3: error buf:FIELD_SAME_TYPE: `;

  expect(run.status).toBe(1);
  expect(run.stdout).toContain(renamed);
  expect(run.stdout).toContain(
    '(at /services/0/procedures/0/procedureName) [service:1/procedure:1]'
  );
  expect(run.stdout).toContain(field);

  // * each waived at its scope, its subject or its file, and the other findings kept
  const waived = beadc([
    ...pair,
    '--except',
    'buf:FIELD_SAME_TYPE@parcel/v1/parcel.proto',
    '--except',
    'PROCEDURE_SAME_NAME@service:1/procedure:1',
  ]);

  expect(waived.status).toBe(1);
  expect(waived.stdout).not.toContain(renamed);
  expect(waived.stdout).not.toContain(field);
  expect(waived.stdout).toContain('error NAME_NO_DELETE: ');
  expect(waived.stdout).toContain('error buf:FIELD_NO_DELETE: ');
  expect(
    beadc([...pair, '--except', 'PROCEDURE_SAME_NAME@service:1/procedure:2']).stdout
  ).toContain(renamed);
  expect(beadc([...pair, '--except', 'buf:FIELD_SAME_TYPE@parcel/v1/other.proto']).status).toBe(2);
});

test('--against - reads a tar from standard input, and refuses a terminal', async () => {
  const archive = new Uint8Array(readFileSync(ARCHIVE));
  const folder = test.info().outputPath('current');

  // the current, the archive's own blueprint: the earlier on standard input holds it too
  extractArchive(archive, { into: folder });

  const current = join(folder, 'interop-blueprint.json');
  const cut = beadc(['breaking', current, '--against', '-'], { input: archive.subarray(0, 4096) });

  expect(beadc(['breaking', current, '--against', '-'], { input: archive }).status).toBe(0);
  expect(cut.status).toBe(2);
  expect(cut.stderr).toMatch(/cut short/u);

  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

  try {
    await expect(readStandardInput()).rejects.toThrow(InputError);
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    } else {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    }
  }
});

test("prints each breaking finding's subject, in text, json and github", () => {
  test.setTimeout(60_000);

  const pair = ['breaking', `${PAIR}/current`, '--against', `${PAIR}/earlier`];
  const [text] = beadc(pair).stdout.split('\n');
  const [json] = beadc([...pair, '--error-format', 'json']).stdout.split('\n');
  // * GitHub's annotation names its file from the workspace, wherever beadc ran
  const github = spawnSync(process.execPath, [CLI, ...pair, '--error-format', 'github'], {
    cwd: BUILDER,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: join(BUILDER, '..') },
  }).stdout.split('\n')[0];

  expect(text).toMatch(
    / \(at \/services\/0\/procedures\/0\/procedureName\) \[service:1\/procedure:1\]$/u
  );
  expect(JSON.parse(String(json))).toMatchObject({
    rule: 'PROCEDURE_SAME_NAME',
    subject: 'service:1/procedure:1',
  });
  expect(github).toMatch(
    /^::error file=builder\/test\/breaking\/buf\/current\/parcel\/v1\/parcel\.proto,line=22,col=7,title=PROCEDURE_SAME_NAME::.* \[service:1\/procedure:1\]$/u
  );
});

test('--against-ref is refused on Node, naming the pipe that does its work, exit 2', () => {
  for (const args of [
    ['breaking', INTEROP, '--against-ref', 'v0.3.0'],
    ['breaking', INTEROP, '--against-ref=v0.3.0'],
  ]) {
    const run = beadc(args);

    expect(run.status, args.join(' ')).toBe(2);
    expect(run.stderr).toBe(
      "beadc: --against-ref is the wrappers' own: on Node, pipe git archive <ref> into --against -\n"
    );
  }
});

test('a path the file system refuses is one line, exit 2; a folder the output names is made', () => {
  const folder = test.info().outputPath('written');
  const file = join(folder, 'file');

  mkdirSync(folder, { recursive: true });
  writeFileSync(file, 'a file, where a folder is meant\n');

  const refused = beadc(['blueprint', INTEROP, '-o', join(file, 'interop.json')]);

  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/^beadc: .+: E[A-Z]+ on \w+, which the file system refuses\n$/u);
  expect(existsSync(`${join(file, 'interop.json')}.tmp`)).toBe(false);

  const made = join(folder, 'made', 'interop.json');

  expect(beadc(['blueprint', INTEROP, '-o', made]).status).toBe(0);
  expect(readFileSync(made, 'utf8')).toBe(readFileSync(INTEROP, 'utf8').replaceAll('\r\n', '\n'));
});
