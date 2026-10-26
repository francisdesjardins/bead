import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { againstOfText, type IConfig, isInside, parseConfig } from '../config.ts';
import { InputError } from '../diagnostics.ts';
import { DEFAULT_PROTO_RUNTIME, DEFAULT_RUNTIME } from '../targets/typescript/options.ts';

// The filesystem seam lives in a child so parallel tests never see its replacement.
const workspaceRace = (folder: string, options: { removals: number; code?: string }): void => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import path from 'node:path';

        const [module, folder, scenario] = process.argv.slice(1);
        const { removals, code } = JSON.parse(scenario);
        const { temporaryFolderOf, BEADC_FOLDER } = await import(module);
        const own = path.join(folder, BEADC_FOLDER);
        const make = fs.mkdtempSync;
        let attempts = 0;
        let failure = Object.assign(new Error('filesystem refusal'), { code });

        fs.mkdtempSync = (prefix, encoding) => {
          assert.equal(path.dirname(prefix), own);
          attempts += 1;
          if (code !== undefined) {
            throw failure;
          }
          if (attempts <= removals) {
            // Only an empty parent goes, just as another invocation's cleanup removes it.
            fs.rmdirSync(own);
          }
          try {
            return make(prefix, encoding);
          } catch (error) {
            failure = error;
            throw error;
          }
        };
        syncBuiltinESMExports();

        try {
          if (removals >= 3 || code !== undefined) {
            assert.throws(() => { temporaryFolderOf('buf-', { folder }); },
              (error) => { return error === failure; });
            assert.equal(attempts, code === undefined ? 3 : 1);
            assert.equal(failure.code, code ?? 'ENOENT');
          } else {
            const made = temporaryFolderOf('buf-', { folder });
            assert.equal(attempts, removals + 1);
            assert.equal(path.dirname(made), own);
            assert.ok(path.basename(made).startsWith('buf-'));
            assert.deepEqual(fs.readdirSync(own), [path.basename(made)]);
            fs.rmdirSync(made);
          }
        } finally {
          fs.mkdtempSync = make;
          syncBuiltinESMExports();
        }
      `,
      new URL('../config.ts', import.meta.url).href,
      folder,
      JSON.stringify(options),
    ],
    { stdio: 'pipe' }
  );
};

test('creates a temporary folder after a concurrent cleanup removes its parent', () => {
  for (const removals of [1, 2]) {
    workspaceRace(test.info().outputPath(`project-${String(removals)}`), { removals });
  }
});

test('bounds temporary folder creation when concurrent cleanups keep removing its parent', () => {
  workspaceRace(test.info().outputPath('project'), { removals: 3 });
});

test('passes a temporary folder creation error other than ENOENT straight to its caller', () => {
  workspaceRace(test.info().outputPath('project'), { removals: 0, code: 'EACCES' });
});

test("a path outside the folder is refused in Windows' forms, a backslash, a drive letter and a second drive, through path.win32", () => {
  const folder = 'C:\\work\\project';
  const win32 = path.win32;

  expect(isInside(folder, { target: 'proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'proto\\bead\\v1', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'C:\\work\\project\\proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: 'c:\\WORK\\Project\\proto', path: win32 })).toBe(true);
  expect(isInside(folder, { target: '..\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'proto\\..\\..\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'C:\\work\\other', path: win32 })).toBe(false);
  expect(isInside(folder, { target: 'D:\\project\\proto', path: win32 })).toBe(false);
  expect(isInside(folder, { target: '\\\\server\\share\\proto', path: win32 })).toBe(false);
  expect(() => {
    return parseConfig('version: 1\nsource:\n  proto: [D:\\proto]\n', { folder, path: win32 });
  }).toThrow(/outside the folder that holds beadc\.yaml.*move beadc\.yaml up/u);
  expect(
    parseConfig('version: 1\nsource:\n  proto: [proto]\nblueprint: gen\\bead.json\n', {
      folder,
      path: win32,
    })
  ).toEqual({
    folder,
    source: { proto: ['C:\\work\\project\\proto'] },
    blueprint: 'C:\\work\\project\\gen\\bead.json',
  });
});

test('reads its version, its source and its blueprint, each path under its folder', () => {
  const folder = '/work';
  const posix = path.posix;

  expect(parseConfig('version: 1\nsource:\n  proto: proto\n', { folder, path: posix })).toEqual({
    folder,
    source: { proto: ['/work/proto'] },
  });
  expect(
    parseConfig('version: 1\nsource:\n  blueprint: spec/a.json\n', { folder, path: posix })
  ).toEqual({ folder, source: { blueprint: '/work/spec/a.json' } });
  expect(isInside(folder, { target: '../other', path: posix })).toBe(false);
  expect(isInside(folder, { target: '/elsewhere', path: posix })).toBe(false);
});

test('refuses a key it does not read, and a source of neither or both kinds', () => {
  const refused = [
    'version: 1\nsource:\n  proto: [proto]\noutputs: []\n',
    'version: 2\nsource:\n  proto: [proto]\n',
    'version: 1\nsource:\n  proto: [proto]\n  blueprint: a.json\n',
    'version: 1\nsource: {}\n',
    'version: 1\nsource:\n  blueprint: a.json\nblueprint: b.json\n',
    'version: 1\nsource:\n  protos: [proto]\n',
    '- a list\n',
    'version: [1\n',
  ];

  for (const text of refused) {
    expect(() => {
      return parseConfig(text, { folder: '/work', path: path.posix });
    }, text).toThrow(InputError);
  }
});

test("reads an output's keys and refuses another, a C# output's namespace for a .proto or none for a blueprint, and messagesOut without external", () => {
  const folder = '/work';
  const posix = path.posix;
  const read = (outputs: string): IConfig => {
    return parseConfig(`version: 1\nsource:\n  blueprint: a.json\noutputs:\n${outputs}`, {
      folder,
      path: posix,
    });
  };

  expect(read('  - language: typescript\n    out: gen\n').outputs).toEqual([
    {
      language: 'typescript',
      out: '/work/gen',
      importExtension: 'ts',
      runtime: DEFAULT_RUNTIME,
      protoRuntime: DEFAULT_PROTO_RUNTIME,
      messages: 'generate',
    },
  ]);
  expect(
    read(
      [
        '  - language: typescript',
        '    out: interop/generated',
        '    importExtension: none',
        '    runtime: ../../src/service/service',
        '    protoRuntime: ../../src/proto/proto',
        '    messages: external',
        '    messagesOut: interop/messages',
        '',
      ].join('\n')
    ).outputs
  ).toEqual([
    {
      language: 'typescript',
      out: '/work/interop/generated',
      importExtension: 'none',
      runtime: '../../src/service/service',
      protoRuntime: '../../src/proto/proto',
      messages: 'external',
      messagesOut: '/work/interop/messages',
    },
  ]);

  expect(
    read('  - language: csharp\n    out: gen/cs\n    namespace: Acme.Greeter\n').outputs
  ).toEqual([
    { language: 'csharp', out: '/work/gen/cs', namespace: 'Acme.Greeter', messages: 'generate' },
  ]);
  expect(
    parseConfig(
      'version: 1\nsource:\n  proto: [proto]\noutputs:\n  - language: csharp\n    out: gen\n    messages: external\n',
      { folder, path: posix }
    ).outputs
  ).toEqual([{ language: 'csharp', out: '/work/gen', messages: 'external' }]);

  // ! a folder whose name opens another's is not inside it, and two outputs may read one messagesOut
  expect(
    read(
      [
        '  - language: typescript',
        '    out: gen',
        '  - language: typescript',
        '    out: gen2',
        '    messages: external',
        '    messagesOut: msgs',
        '  - language: typescript',
        '    out: gen3',
        '    importExtension: js',
        '    messages: external',
        '    messagesOut: msgs',
        '',
      ].join('\n')
    ).outputs
  ).toHaveLength(3);
  expect(() => {
    return parseConfig(
      'version: 1\nsource:\n  proto: [proto]\noutputs:\n  - language: csharp\n    out: gen\n    namespace: Acme\n',
      { folder, path: posix }
    );
  }).toThrow(/outputs\[0\]\.namespace: a \.proto's services take their file's/u);

  const refused: readonly (readonly [string, RegExp])[] = [
    ['  - language: csharp\n    out: gen\n', /outputs\[0\]\.namespace names the C# namespace/u],
    ['  - language: csharp\n    out: gen\n    namespace: Acme..X\n', /is a C# namespace/u],
    ['  - language: csharp\n    out: gen\n    namespace: 1Acme\n', /is a C# namespace/u],
    [
      '  - language: csharp\n    out: gen\n    namespace: Acme\n    importExtension: ts\n',
      /outputs\[0\]\.importExtension, a key/u,
    ],
    [
      '  - language: csharp\n    out: gen\n    namespace: Acme\n    messagesOut: msgs\n',
      /outputs\[0\]\.messagesOut, a key/u,
    ],
    [
      '  - language: csharp\n    out: gen\n    namespace: Acme\n    messages: none\n',
      /generate or external/u,
    ],
    ['  - language: go\n    out: gen\n', /outputs\[0\]\.language: typescript or csharp/u],
    [
      '  - language: typescript\n    out: gen\n    namespace: X\n',
      /outputs\[0\]\.namespace, a key/u,
    ],
    ['  - language: typescript\n', /outputs\[0\]\.out is a path/u],
    ['  - language: typescript\n    out: ../gen\n', /outside the folder/u],
    ['  - language: typescript\n    out: gen\n    importExtension: mjs\n', /none, js or ts/u],
    ['  - language: typescript\n    out: gen\n    runtime: ./service.ts\n', /names no extension/u],
    [
      '  - language: typescript\n    out: gen\n    runtime: /abs/service\n',
      /runtime is a package's name/u,
    ],
    [
      '  - language: typescript\n    out: gen\n    protoRuntime: ./records.ts\n',
      /protoRuntime: \.\/records\.ts names no extension/u,
    ],
    [
      '  - language: typescript\n    out: gen\n    protoRuntime: /abs/records\n',
      /protoRuntime is a package's name/u,
    ],
    ['  - language: typescript\n    out: gen\n    messages: none\n', /generate or external/u],
    ['  - language: typescript\n    out: gen\n    messagesOut: msgs\n', /messagesOut/u],
    ['  - language: typescript\n    out: gen\n    messages: external\n', /messagesOut/u],
    [
      '  - language: typescript\n    out: gen\n  - language: typescript\n    out: ./gen\n',
      /two outputs write one folder/u,
    ],
    // one output inside another, either way, in each language; another's messagesOut inside one
    [
      '  - language: typescript\n    out: gen\n  - language: typescript\n    out: gen/web\n',
      /outputs\[0\]\.out and outputs\[1\]\.out lie one inside the other/u,
    ],
    [
      '  - language: csharp\n    out: gen/web\n    namespace: Acme\n  - language: csharp\n    out: gen\n    namespace: Acme\n',
      /outputs\[0\]\.out and outputs\[1\]\.out lie one inside the other/u,
    ],
    [
      '  - language: typescript\n    out: gen\n  - language: typescript\n    out: web\n    messages: external\n    messagesOut: gen/own\n',
      /outputs\[0\]\.out and outputs\[1\]\.messagesOut lie one inside the other/u,
    ],
    [
      '  - language: typescript\n    out: web\n    messages: external\n    messagesOut: msgs\n  - language: typescript\n    out: msgs\n',
      /outputs\[1\]\.out and outputs\[0\]\.messagesOut lie one inside the other/u,
    ],
    ['  []\n', /outputs lists one output at least/u],
  ];

  for (const [outputs, reason] of refused) {
    expect(() => {
      return read(outputs);
    }, outputs).toThrow(reason);
  }
});

test('an earlier beadc.yaml gives its source and blueprint, its outputs unread', () => {
  const folder = '/earlier';
  const posix = path.posix;
  const later = [
    'version: 1',
    'source:',
    '  proto: [proto]',
    'blueprint: gen/a.blueprint.json',
    'lint: strict',
    'outputs:',
    '  - language: typescript',
    '    out: gen/typescript',
    '    dropped: true',
    '',
  ].join('\n');

  expect(() => {
    return parseConfig(later, { folder, path: posix });
  }).toThrow(InputError);
  expect(againstOfText(later, { folder, path: posix })).toEqual({
    folder,
    source: { proto: ['/earlier/proto'] },
    blueprint: '/earlier/gen/a.blueprint.json',
  });
  expect(
    againstOfText('version: 1\nsource:\n  blueprint: spec/a.json\noutputs: []\n', {
      folder,
      path: posix,
    })
  ).toEqual({ folder, source: { blueprint: '/earlier/spec/a.json' } });

  for (const refused of [
    'version: 2\nsource:\n  proto: [proto]\n',
    'version: 1\nsource:\n  proto: [../proto]\n',
    'version: 1\nsource:\n  blueprint: a.json\nblueprint: b.json\n',
  ]) {
    expect(() => {
      return againstOfText(refused, { folder, path: posix });
    }, refused).toThrow(InputError);
  }
});

test("reads clean, buf's opt-in, off unless set, and refuses one that is no boolean", () => {
  const folder = '/work';
  const read = (clean: string): IConfig => {
    return parseConfig(`version: 1\nsource:\n  blueprint: api.json\n${clean}`, {
      folder,
      path: path.posix,
    });
  };

  expect(read('').clean).toBeUndefined();
  expect(read('clean: false\n').clean).toBeUndefined();
  expect(read('clean: true\n').clean).toBe(true);
  expect(() => {
    return read('clean: yes please\n');
  }).toThrow(InputError);
});

test("reads keepValidateOptions, protovalidate's options kept in the messages an output generates, and only there", () => {
  const folder = '/work';
  const read = (output: string): IConfig => {
    return parseConfig(
      `version: 1\nsource:\n  proto: [proto]\noutputs:\n  - language: typescript\n    out: gen/ts\n${output}`,
      { folder, path: path.posix }
    );
  };
  const readCSharp = (output: string): IConfig => {
    return parseConfig(
      `version: 1\nsource:\n  proto: [proto]\noutputs:\n  - language: csharp\n    out: gen/cs\n${output}`,
      { folder, path: path.posix }
    );
  };

  expect(read('').outputs?.[0]?.keepValidateOptions).toBeUndefined();
  expect(read('    keepValidateOptions: true\n').outputs?.[0]?.keepValidateOptions).toBe(true);
  expect(readCSharp('    keepValidateOptions: true\n').outputs?.[0]?.keepValidateOptions).toBe(
    true
  );
  expect(read('    keepValidateOptions: false\n').outputs?.[0]?.keepValidateOptions).toBe(false);
  expect(() => {
    return read('    keepValidateOptions: kept\n');
  }).toThrow('outputs[0].keepValidateOptions is true or false');
  expect(() => {
    return read(
      '    messages: external\n    messagesOut: gen/messages\n    keepValidateOptions: true\n'
    );
  }).toThrow(
    "outputs[0].keepValidateOptions keeps protovalidate's options in the messages beadc generates, and only then"
  );
});

test("reads http's prefix, openapi's out, title, security and problemTypes, an output's http, httpRuntime and keepHttpOptions, and refuses each off its form", () => {
  const folder = '/work';
  const read = (text: string): IConfig => {
    return parseConfig(`version: 1\nsource:\n  proto: [proto]\n${text}`, {
      folder,
      path: path.posix,
    });
  };
  const output = (keys: string): string => {
    return `outputs:\n  - language: typescript\n    out: gen/ts\n${keys}`;
  };

  expect(read('').http).toBeUndefined();
  expect(read('http:\n  prefix: /rpc/v1\n').http).toEqual({ prefix: '/rpc/v1' });
  expect(read('http: {}\n').http).toEqual({ prefix: '/api' });
  expect(
    read(
      'openapi:\n  out: gen/openapi.json\n  title: Hello\n  security: {type: apiKey, in: header, name: x-key}\n  problemTypes: https://example.com/problems/\n'
    ).openapi
  ).toEqual({
    out: '/work/gen/openapi.json',
    title: 'Hello',
    security: { type: 'apiKey', in: 'header', name: 'x-key' },
    problemTypes: 'https://example.com/problems/',
  });

  const [typescript] = read(output('    http: true\n    keepHttpOptions: true\n')).outputs ?? [];

  expect(typescript).toMatchObject({
    http: true,
    httpRuntime: '@francisdesjardins/bead/transcoding',
    keepHttpOptions: true,
  });
  expect(read(output('')).outputs?.[0]).not.toHaveProperty('httpRuntime');
  expect(
    read(output('    http: true\n    httpRuntime: ../runtime/transcoding\n')).outputs?.[0]
  ).toMatchObject({ httpRuntime: '../runtime/transcoding' });

  for (const [text, refusal] of [
    ['http:\n  prefix: api\n', 'http.prefix is / and segments'],
    ['http:\n  prefix: /api/\n', 'http.prefix is / and segments'],
    ['http:\n  prefix: /a/../b\n', 'http.prefix is / and segments'],
    ['http:\n  port: 80\n', 'http.port, a key beadc does not read'],
    [
      'openapi:\n  security: {type: magic}\n',
      'openapi.security is an OpenAPI Security Scheme Object',
    ],
    ['openapi:\n  problemTypes: problems/\n', 'openapi.problemTypes is an absolute URI'],
    ['openapi:\n  out: ../openapi.json\n', 'openapi.out: ../openapi.json is outside the folder'],
    [output('    http: yes\n'), 'outputs[0].http is true or false'],
    [output('    httpRuntime: ../runtime\n'), 'outputs[0].httpRuntime names the route table'],
    [
      output('    messages: external\n    messagesOut: gen/messages\n    keepHttpOptions: true\n'),
      'outputs[0].keepHttpOptions keeps google.api.http in the messages beadc generates, and only then',
    ],
  ] as const) {
    expect(() => {
      return read(text);
    }, text).toThrow(refusal);
  }
});
