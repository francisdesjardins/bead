// ── Generate ──────────────────────────────────────────────────────────────────

// `beadc generate`, once `check` passed over `beadc.yaml`'s source (decision 0022): for a `.proto`
// source, the blueprint `beadc.yaml` names and the editor's copy of Bead's options; then each
// output, its messages first, then its target's files. Every file is encoded whole and moved over
// the one it replaces, as `beadc blueprint` writes; a file of an output's folder of a kind beadc writes
// there, which it would not write now, is taken out. With `--check`, beadc writes nothing and names
// each difference, each file missing and each such file left over, as `buf format --exit-code`
// holds a file to its form; CRLF is read as LF, as git may check a file out. The editor's copy is
// git's to ignore, and never compared.
//
// `cli.ts` loads this module only for `generate`: the targets load protoplugin, which loads a
// TypeScript compiler, which `check`, `blueprint` and `version` never need.

// dependencies

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import type { IChecked } from './check.ts';
import { OPTIONS_ROOT } from './compile.ts';
import type { IConfig, Output } from './config.ts';
import { InputError } from './diagnostics.ts';
import { generateMessages } from './messages.ts';
import { formOf } from './model/form.ts';
import { OPTIONS_FILE, pathOnDisk } from './roots.ts';
import {
  bindsMessages,
  type IGeneratedFile,
  type ITargetInput,
  Messages,
  type SourceNames,
} from './targets/target.ts';
import { typescriptTarget } from './targets/typescript/typescript.ts';

// types

/** A file `generate` writes: where, and its text. */
export interface IPlannedFile {
  readonly path: string;
  readonly content: string;
}

/** What `generate --check` finds of one file: where, at which line when it differs, and what. */
export interface IFileDifference {
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

/** What `generate` gives: the files it writes, and those of its kinds it takes out. */
export interface IPlan {
  readonly files: readonly IPlannedFile[];
  readonly stale: readonly string[];
}

// constants

/** Where `generate` writes the editor's copy of Bead's options, beside `beadc.yaml`. */
export const EDITOR_COPY = '.beadc/include';

// what a TypeScript output's folder holds of beadc's: its services, and its messages when it writes them
const SERVICES = /_bead\.ts$/u;
const MESSAGES = /_pb\.ts$/u;

// helpers

// a path as `beadc.yaml`'s folder sees it, with slashes
const slashed = (from: string, path: string): string => {
  return relative(from, path).split(sep).join('/');
};

// what a header names as each file's source
const sourcesOf = (config: IConfig, checked: IChecked): SourceNames => {
  const { source } = config;

  if ('blueprint' in source) {
    return { blueprint: slashed(config.folder, source.blueprint) };
  }

  return {
    proto: new Map(
      (checked.blueprint?.proto?.files ?? []).flatMap((file) => {
        const path = pathOnDisk(file.path, source.proto);

        return path === undefined ? [] : [[file.path, slashed(config.folder, path)] as const];
      })
    ),
  };
};

// every file under `folder` whose name `kind` matches, or none when it is no folder
const filesUnder = (folder: string, kind: RegExp): string[] => {
  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      return entry.isFile() && kind.test(entry.name);
    })
    .map((entry) => {
      return join(entry.parentPath, entry.name);
    });
};

// one output's files, under its folder
const outputFilesOf = (output: Output, input: ITargetInput): IGeneratedFile[] => {
  const messagesOut =
    output.messagesOut === undefined ? '' : slashed(output.out, output.messagesOut);

  return [
    ...(input.set === undefined || output.messages !== Messages.GENERATE
      ? []
      : generateMessages(input.set, {
          blueprint: input.blueprint,
          importExtension: output.importExtension,
        })),
    ...typescriptTarget.generate(input, {
      importExtension: output.importExtension,
      runtime: output.runtime,
      messages: output.messages,
      ...(messagesOut === '' ? {} : { messagesOut }),
    }),
  ];
};

// the first line `actual` and `expected` differ at, from 1
const firstDifferenceOf = (actual: string, expected: string): number => {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const at = expectedLines.findIndex((line, index) => {
    return line !== actualLines[index];
  });

  return (at === -1 ? expectedLines.length : at) + 1;
};

// writes `content` beside `path` first, then moves it over: a failure never shortens the file
const writeWhole = (path: string, content: string): void => {
  const temporary = `${path}.tmp`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, content);
  renameSync(temporary, path);
};

// definition

/**
 * What `generate` writes for `config`, from `checked`, its source checked without an error: the
 * blueprint for a `.proto` source that names one, then each output's files; and the files of its
 * kinds the outputs' folders hold that it would not write. Throws an {@link InputError} for a source
 * it cannot generate from.
 */
export const planOf = (config: IConfig, checked: IChecked): IPlan => {
  const { blueprint } = checked;

  if (blueprint === undefined) {
    throw new InputError('generate runs on a source check takes');
  }

  if (blueprint.services.some(bindsMessages) && checked.set === undefined) {
    throw new InputError(
      "a blueprint's proto bindings name messages only its .proto declares: name the .proto roots as the source"
    );
  }

  if (config.outputs === undefined && config.blueprint === undefined) {
    throw new InputError('beadc.yaml names no output: outputs, each a language and its folder');
  }

  const input: ITargetInput = {
    blueprint,
    ...(checked.set === undefined ? {} : { set: checked.set }),
    sources: sourcesOf(config, checked),
  };
  const files: IPlannedFile[] =
    config.blueprint === undefined ? [] : [{ path: config.blueprint, content: formOf(blueprint) }];
  const stale: string[] = [];

  for (const output of config.outputs ?? []) {
    const written = outputFilesOf(output, input).map((file) => {
      return { path: join(output.out, ...file.name.split('/')), content: file.content };
    });
    const paths = new Set(
      written.map((file) => {
        return file.path;
      })
    );
    const kinds = [
      SERVICES,
      ...(input.set !== undefined && output.messages === Messages.GENERATE ? [MESSAGES] : []),
    ];

    files.push(...written);
    stale.push(
      ...kinds.flatMap((kind) => {
        return filesUnder(output.out, kind).filter((path) => {
          return !paths.has(path);
        });
      })
    );
  }

  return { files, stale };
};

/** What differs between `plan` and the files on disk: a file off, missing, or left over. */
export const differencesOf = (plan: IPlan): IFileDifference[] => {
  const differences: IFileDifference[] = [];

  for (const file of plan.files) {
    if (!existsSync(file.path)) {
      differences.push({ path: file.path, message: 'no such file; beadc generate writes it' });
      continue;
    }

    const actual = readFileSync(file.path, 'utf8').replaceAll('\r\n', '\n');

    if (actual !== file.content) {
      const line = firstDifferenceOf(actual, file.content);

      differences.push({
        path: file.path,
        line,
        message: `line ${String(line)} differs from what beadc generate writes`,
      });
    }
  }

  for (const path of plan.stale) {
    differences.push({
      path,
      message: 'beadc generate writes no such file from this source; it takes it out',
    });
  }

  return differences;
};

/**
 * Writes `plan` for `config`: each file whose text differs, whole, then moved over; each file left
 * over taken out; and, for a `.proto` source, the editor's copy of Bead's options beside
 * `beadc.yaml`.
 */
export const writePlan = (plan: IPlan, config: IConfig): void => {
  for (const file of plan.files) {
    if (!existsSync(file.path) || readFileSync(file.path, 'utf8') !== file.content) {
      writeWhole(file.path, file.content);
    }
  }

  for (const path of plan.stale) {
    rmSync(path);
  }

  if ('proto' in config.source) {
    const copy = join(config.folder, ...EDITOR_COPY.split('/'), ...OPTIONS_FILE.split('/'));

    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(join(OPTIONS_ROOT, ...OPTIONS_FILE.split('/')), copy);
  }
};
