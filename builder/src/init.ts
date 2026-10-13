// ── Init ──────────────────────────────────────────────────────────────────────

// `beadc init <name>`: a project beadc generates, written in the folder it runs in (decision 0022).
// Its `beadc.yaml`, each language's output under the folder of its half, `typescript/gen` and
// `dotnet/gen`, a `.proto` of one service that `beadc check` passes and buf's STANDARD lint takes,
// buf's own `buf.yaml` for an editor, the editor's copy of Bead's options, and the wrappers
// `beadc.sh` and `beadc.ps1` filled with beadc's version; then the lines a project's `.gitignore`
// and `.gitattributes` owe, each appended when absent. It writes over no file: every path is looked
// at before the first write, and one there is refused, but a wrapper that is byte for byte the one
// it would write, which `beadc wrapper` printed for the first run, and which it keeps.
//
// The name is asked, never taken from the folder: in the image the folder is `/work`, whatever the
// host calls it, and beadc on Node takes it the same way.

// dependencies

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_FILE } from './config.ts';
import { InputError } from './diagnostics.ts';
import { EDITOR_COPY, writeEditorCopy } from './generate.ts';
import { OPTIONS_FILE } from './roots.ts';
import { WRAPPERS, wrapperText } from './wrappers.ts';

// types

/** The languages `init` writes an output for. */
export const Language = Object.freeze({
  TYPESCRIPT: 'typescript',
  CSHARP: 'csharp',
} as const);

export type Language = (typeof Language)[keyof typeof Language];

/** What `init` did, each path from the folder, with slashes. */
export interface IInitialized {
  readonly written: readonly string[];
  readonly kept: readonly string[];
  readonly appended: readonly string[];
}

// constants

// a proto package's part, lower snake case, as buf's STANDARD lint asks
const NAME = /^[a-z][a-z0-9_]*$/u;

const LANGUAGES: readonly string[] = Object.values(Language);

// * each language's generated code under the folder of its half, named as the repository names its
// implementations: a generated `_bead.ts` resolves its packages from where it sits, so `<half>/gen`
// serves a package at the project's root and one in the half's folder alike
const OUT: Readonly<Record<Language, string>> = Object.freeze({
  [Language.TYPESCRIPT]: 'typescript/gen',
  [Language.CSHARP]: 'dotnet/gen',
});

// helpers

// `hello_world` as a type's name: HelloWorld
const pascalOf = (name: string): string => {
  return name
    .split('_')
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
};

// the lines a project's git files owe, each appended when absent: the wrappers', the blueprint's,
// then one for each language's output
const gitLinesOf = (languages: readonly Language[]): ReadonlyMap<string, readonly string[]> => {
  return new Map([
    ['.gitignore', ['.beadc/']],
    [
      '.gitattributes',
      [
        'beadc.sh text eol=lf',
        'beadc.ps1 text eol=lf',
        'gen/** text eol=lf linguist-generated=true',
        ...languages.map((language) => {
          return `${OUT[language]}/** text eol=lf linguist-generated=true`;
        }),
      ],
    ],
  ]);
};

const configOf = (name: string, languages: readonly Language[]): string => {
  return [
    `# beadc.yaml: ${name}'s services, from its .proto, generated in each language. ./beadc.sh`,
    '# generate (or ./beadc.ps1 generate) writes them, and generate --check holds them there.',
    'version: 1',
    'source:',
    '  proto: [proto]',
    `blueprint: gen/${name}.blueprint.json`,
    'outputs:',
    ...languages.flatMap((language) => {
      return language === Language.TYPESCRIPT
        ? ['  - language: typescript', `    out: ${OUT[language]}`, '    importExtension: ts']
        : ['  - language: csharp', `    out: ${OUT[language]}`];
    }),
    "# the output folders are beadc's own: generate takes out what it no longer writes there",
    'clean: true',
    '',
  ].join('\n');
};

const protoOf = (name: string): string => {
  const pascal = pascalOf(name);

  return [
    'syntax = "proto3";',
    '',
    `package ${name}.v1;`,
    '',
    'import "bead/options.proto";',
    '',
    `// ${pascal}'s service: its procedures, each with its id, which a peer calls it by.`,
    `service ${pascal}Service {`,
    '  option (bead.service) = {',
    '    id: 1',
    '    revision: 1',
    '    admission: {',
    '      none: {}',
    '    }',
    '  };',
    '',
    "  // Answers its request's text.",
    '  rpc Echo(bead.Text) returns (bead.Text) {',
    '    option (bead.procedure) = {id: 1};',
    '  }',
    '}',
    '',
  ].join('\n');
};

const BUF = [
  "# buf's workspace, for an editor, for buf lint, and for buf generate where a project's own build",
  '# writes its messages: beadc passes buf a configuration of its own and never reads this file.',
  "# .beadc/include holds the editor's copy of Bead's options, which beadc generate writes.",
  'version: v2',
  'modules:',
  '  - path: proto',
  '    lint:',
  '      use: [STANDARD]',
  '      # bead.Raw, bead.Text and bead.Json serve many rpcs, as request and as response',
  '      except: [RPC_REQUEST_STANDARD_NAME, RPC_RESPONSE_STANDARD_NAME, RPC_REQUEST_RESPONSE_UNIQUE]',
  `  - path: ${EDITOR_COPY}`,
  '    lint:',
  '      use: [STANDARD]',
  "      # bead/options.proto's package is `bead`, as protobuf's own options name none",
  '      except: [PACKAGE_VERSION_SUFFIX]',
  '',
].join('\n');

// the languages asked, each once, in the order given; both when none is
const languagesOf = (given: readonly string[]): readonly Language[] => {
  for (const language of given) {
    if (!LANGUAGES.includes(language)) {
      throw new InputError(
        `--language ${language}: typescript or csharp, the targets of this beadc`
      );
    }
  }

  return given.length === 0 ? Object.values(Language) : [...new Set(given as Language[])];
};

// ! executable where the file system holds a mode its writer may set: git on Windows records none,
// and a Windows folder Docker Desktop mounts refuses a mode to the image's user for a file the caller
// wrote, beadc.sh kept as it was printed
const makeExecutable = (path: string): void => {
  if ((statSync(path).mode & 0o111) === 0o111) {
    return;
  }

  try {
    chmodSync(path, 0o755);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EPERM') {
      throw error;
    }
  }
};

// the lines of `lines` that `path` does not hold yet
const absentOf = (path: string, lines: readonly string[]): readonly string[] => {
  const held = new Set(
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .map((line) => {
            return line.trim();
          })
      : []
  );

  return lines.filter((line) => {
    return !held.has(line);
  });
};

// definition

/**
 * Writes the project `name` into `options.folder`, its outputs those of `options.languages`, both
 * when none is named, its wrappers filled with `options.version`. Throws an {@link InputError} for a
 * name that is no proto package's part, a language beadc has no target for, and a file there that it
 * would write, before anything is written.
 */
export const initProject = (
  name: string | undefined,
  options: {
    readonly folder: string;
    readonly version: string;
    readonly languages?: readonly string[];
  }
): IInitialized => {
  const { folder, version } = options;

  if (name === undefined) {
    throw new InputError("init names the project: beadc init <name>, a proto package's part");
  }

  if (!NAME.test(name)) {
    throw new InputError(
      `init ${name}: a proto package's part is due, a lower-case letter, then lower-case letters, digits and _`
    );
  }

  const languages = languagesOf(options.languages ?? []);
  const files = new Map<string, string>([
    [CONFIG_FILE, configOf(name, languages)],
    [`proto/${name}/v1/${name}.proto`, protoOf(name)],
    ['buf.yaml', BUF],
  ]);
  const wrappers = new Map(
    WRAPPERS.map((wrapper) => {
      return [wrapper, wrapperText(wrapper, { version })] as const;
    })
  );
  const editorCopy = `${EDITOR_COPY}/${OPTIONS_FILE}`;
  const pathOf = (path: string): string => {
    return join(folder, ...path.split('/'));
  };

  // * every path looked at before the first write: a refusal writes nothing
  for (const path of [...files.keys(), editorCopy]) {
    if (existsSync(pathOf(path))) {
      throw new InputError(`init writes ${path}, which is there: init writes over no file`);
    }
  }

  const kept: string[] = [...wrappers].flatMap(([wrapper, text]) => {
    const path = pathOf(wrapper);

    if (!existsSync(path)) {
      return [];
    }

    if (readFileSync(path, 'utf8') !== text) {
      throw new InputError(
        `init writes ${wrapper}, which is there and differs from beadc ${version}'s: init writes over no file`
      );
    }

    return [wrapper];
  });
  const written: string[] = [];

  for (const [path, text] of [...files, ...wrappers]) {
    if (!kept.includes(path)) {
      mkdirSync(dirname(pathOf(path)), { recursive: true });
      writeFileSync(pathOf(path), text);
      written.push(path);
    }
  }

  makeExecutable(pathOf('beadc.sh'));
  writeEditorCopy(folder);
  written.push(editorCopy);

  const appended = [...gitLinesOf(languages)].flatMap(([file, lines]) => {
    const path = pathOf(file);
    const absent = absentOf(path, lines);

    if (absent.length === 0) {
      return [];
    }

    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const separator = before === '' || before.endsWith('\n') ? '' : '\n';

    appendFileSync(path, `${separator}${absent.join('\n')}\n`);

    return [file];
  });

  return { written, kept, appended };
};

/** What `beadc init` prints once it wrote a project: what it did, then the next commands. */
export const initLines = (initialized: IInitialized): readonly string[] => {
  return [
    ...initialized.written.map((path) => {
      return `wrote ${path}`;
    }),
    ...initialized.kept.map((path) => {
      return `kept ${path}, beadc's own`;
    }),
    ...initialized.appended.map((path) => {
      return `appended to ${path}`;
    }),
    'next, in bash or in PowerShell 7.6:',
    '  ./beadc.sh generate',
    '  ./beadc.ps1 generate',
    'and, since git on Windows records no mode:',
    '  git add --chmod=+x beadc.sh',
  ];
};
