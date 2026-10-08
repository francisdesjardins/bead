import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  descriptorDifferences,
  foldersOf,
  judgeExample,
  missingLines,
  optionDifferences,
  parseJsonc,
} from '../check-examples.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const OXFMT = `{
  "$schema": "https://example.org/oxfmt.json",

  // the side's options, a comment among them
  "semi": true,
  "printWidth": 100,
  "ignorePatterns": [".yarn/**", "**/*_pb.ts"],
}
`;

const SIDE_PACKAGE = JSON.stringify({
  devDependencies: { esbuild: '0.28.2', oxfmt: '0.71.0', 'typescript-7': 'npm:typescript@7.0.2' },
});

const EXPECTED = {
  wrappers: new Map([
    ['beadc.sh', '#!/bin/sh\n'],
    ['beadc.ps1', '#Requires -Version 7.6\n'],
  ]),
  init: new Map([
    ['buf.yaml', 'version: v2\n'],
    ['.gitignore', '.beadc/\n'],
    ['.gitattributes', 'beadc.sh text eol=lf\ngen/** text eol=lf linguist-generated=true\n'],
  ]),
  dotnet: new Map([
    ['global.json', '{ "sdk": {} }\n'],
    ['nuget.config', '<configuration />\n'],
    ['.editorconfig', 'root = true\n'],
  ]),
  oxfmt: OXFMT,
  packageJson: SIDE_PACKAGE,
};

// an example's files, each held to its source unless `changes` says otherwise; a file changed to
// undefined is absent
const exampleOf = (changes = {}) => {
  const files = new Map([
    ['beadc.sh', '#!/bin/sh\n'],
    ['beadc.ps1', '#Requires -Version 7.6\n'],
    ['buf.yaml', 'version: v2\n'],
    ['.gitignore', '.beadc/\ntypescript/gen/messages/\n'],
    ['.gitattributes', 'beadc.sh text eol=lf\ngen/** text eol=lf linguist-generated=true\n'],
    ['dotnet/Hello.csproj', '<Project />\n'],
    ['dotnet/global.json', '{ "sdk": {} }\n'],
    ['dotnet/nuget.config', '<configuration />\n'],
    ['dotnet/.editorconfig', 'root = true\n'],
    [
      'typescript/.oxfmtrc.json',
      '{\n  // its own ignores\n  "semi": true,\n  "printWidth": 100,\n  "ignorePatterns": ["gen/**"]\n}\n',
    ],
    [
      'typescript/package.json',
      JSON.stringify({
        dependencies: { ws: '^8.22.0' },
        devDependencies: { esbuild: '0.28.2', typescript: '7.0.2' },
      }),
    ],
    ...Object.entries(changes),
  ]);
  const present = [...files].filter(([, text]) => {
    return text !== undefined;
  });
  return {
    folder: 'examples/hello',
    paths: present.map(([path]) => {
      return path;
    }),
    read: (path) => {
      return files.get(path);
    },
    expected: EXPECTED,
  };
};

// ── Texts ─────────────────────────────────────────────────────────────────────

describe('parseJsonc', () => {
  test('reads comments and trailing commas, and keeps the slashes a string holds', () => {
    assert.deepEqual(parseJsonc(OXFMT), {
      $schema: 'https://example.org/oxfmt.json',
      semi: true,
      printWidth: 100,
      ignorePatterns: ['.yarn/**', '**/*_pb.ts'],
    });
    assert.deepEqual(parseJsonc('{ "a": "/* kept */", /* gone */ "b": [1, 2,], }'), {
      a: '/* kept */',
      b: [1, 2],
    });
  });
});

describe('foldersOf', () => {
  test('takes each folder under examples once, sorted, and no file directly under it', () => {
    assert.deepEqual(
      foldersOf([
        'examples/hello/beadc.yaml',
        'examples/README.md',
        'examples/hello/dotnet/Program.cs',
        'examples/chat/beadc.yaml',
      ]),
      ['examples/chat', 'examples/hello']
    );
  });
});

// ── Comparisons ───────────────────────────────────────────────────────────────

describe('missingLines', () => {
  test('gives the lines a file lacks, its own lines and their spaces aside, and all of them where it is absent', () => {
    assert.deepEqual(missingLines('a\nb\n', 'b  \nc\n'), ['a']);
    assert.deepEqual(missingLines('a\nb\n', undefined), ['a', 'b']);
  });
});

describe('optionDifferences', () => {
  test("names an option at another value, one missing and one added, the example's ignores and schema its own", () => {
    assert.deepEqual(
      optionDifferences(
        { semi: false, tabWidth: 4, ignorePatterns: ['gen/**'], $schema: 'x' },
        { semi: true, printWidth: 100, ignorePatterns: ['.yarn/**'] }
      ),
      [
        '"semi" false, the side\'s true',
        '"printWidth" missing, the side\'s 100',
        '"tabWidth" 4, an option the side does not set',
      ]
    );
  });
});

describe('descriptorDifferences', () => {
  test("holds each descriptor both packages name to the side's, typescript to the side's alias, and leaves the example's own", () => {
    const side = JSON.parse(SIDE_PACKAGE);
    assert.deepEqual(
      descriptorDifferences(
        { devDependencies: { esbuild: '0.28.2', typescript: '7.0.2', ws: '^8.22.0' } },
        side
      ),
      []
    );
    assert.deepEqual(
      descriptorDifferences(
        { dependencies: { oxfmt: '0.70.0' }, devDependencies: { typescript: '7.0.1' } },
        side
      ),
      ["oxfmt 0.70.0, the side's 0.71.0", "typescript 7.0.1, the side's 7.0.2"]
    );
  });
});

// ── Judge ─────────────────────────────────────────────────────────────────────

describe('judgeExample', () => {
  test('finds no problem in an example held to its sources', () => {
    assert.deepEqual(judgeExample(exampleOf()), []);
  });

  test('names a wrapper that is not what beadc wrapper prints, and one that is missing', () => {
    assert.deepEqual(
      judgeExample(exampleOf({ 'beadc.sh': '#!/bin/sh\n# edited\n', 'beadc.ps1': undefined })),
      [
        'examples/hello/beadc.sh: not what beadc wrapper beadc.sh prints',
        'examples/hello/beadc.ps1: not what beadc wrapper beadc.ps1 prints',
      ]
    );
  });

  test('names a buf.yaml that is not the one beadc init writes, and each git line init writes that the example lacks', () => {
    assert.deepEqual(
      judgeExample(
        exampleOf({ 'buf.yaml': 'version: v1\n', '.gitattributes': 'beadc.sh text eol=lf\n' })
      ),
      [
        'examples/hello/buf.yaml: not the buf.yaml beadc init writes',
        'examples/hello/.gitattributes: no line gen/** text eol=lf linguist-generated=true, which beadc init writes',
      ]
    );
  });

  test("names a C# copy that is not the side's, byte for byte, and holds none where the example has no dotnet folder", () => {
    assert.deepEqual(
      judgeExample(exampleOf({ 'dotnet/global.json': '{ "sdk": { "version": "10.0.100" } }\n' })),
      ['examples/hello/dotnet/global.json: not implementations/dotnet/global.json, byte for byte']
    );
    assert.deepEqual(
      judgeExample(
        exampleOf({
          'dotnet/Hello.csproj': undefined,
          'dotnet/global.json': undefined,
          'dotnet/nuget.config': undefined,
          'dotnet/.editorconfig': undefined,
        })
      ),
      []
    );
  });

  test("names an oxfmt option and a descriptor that are not the side's, and a TypeScript half without its oxfmt options", () => {
    assert.deepEqual(
      judgeExample(
        exampleOf({
          'typescript/.oxfmtrc.json': '{ "semi": true, "printWidth": 120 }\n',
          'typescript/package.json': JSON.stringify({ devDependencies: { esbuild: '0.28.1' } }),
        })
      ),
      [
        'examples/hello/typescript/.oxfmtrc.json: "printWidth" 120, the side\'s 100 (implementations/typescript/.oxfmtrc.json)',
        "examples/hello/typescript/package.json: esbuild 0.28.1, the side's 0.28.2 (implementations/typescript/package.json)",
      ]
    );
    assert.deepEqual(judgeExample(exampleOf({ 'typescript/.oxfmtrc.json': undefined })), [
      'examples/hello/typescript/.oxfmtrc.json: missing: oxfmt would format the half by its defaults',
    ]);
  });

  test('names a folder whose name beadc init refuses', () => {
    assert.deepEqual(judgeExample({ ...exampleOf(), folder: 'examples/Hello-World' }).slice(0, 1), [
      'examples/Hello-World: Hello-World is no name beadc init takes, a lower-case letter, then lower-case letters, digits and _',
    ]);
  });
});
