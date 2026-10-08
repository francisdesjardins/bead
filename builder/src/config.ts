// ── Config ────────────────────────────────────────────────────────────────────

// `beadc.yaml`, at a project's root: its `version`, its `source` — `.proto` roots, or a blueprint —
// where `beadc blueprint` writes, and the `outputs` `beadc generate` writes, a language and a folder
// each. Every path stays under the folder that holds it, since the image sees nothing else; a key
// beadc does not read is refused, never left unchecked.

// dependencies

import { existsSync } from 'node:fs';
import nodePath, { type PlatformPath } from 'node:path';

import { parse } from 'yaml';

import { InputError } from './diagnostics.ts';
import { Messages } from './targets/target.ts';
import {
  DEFAULT_RUNTIME,
  IMPORT_EXTENSIONS,
  type ImportExtension,
} from './targets/typescript/options.ts';

// types

/** Where a project's blueprint is read from: its `.proto` roots, or a blueprint's file. */
export type Source = { readonly proto: readonly string[] } | { readonly blueprint: string };

/** A TypeScript output: its folder, and how its files import. */
export interface ITypeScriptOutput {
  readonly language: 'typescript';
  readonly out: string;
  readonly importExtension: ImportExtension;
  /** A package's name, or a path relative to `out` without its extension. */
  readonly runtime: string;
  readonly messages: Messages;
  /** Where another generator writes the messages, for `external`. */
  readonly messagesOut?: string;
}

/** An output `beadc generate` writes. */
export type Output = ITypeScriptOutput;

/** `beadc.yaml`, read, each path resolved against its folder. */
export interface IConfig {
  readonly folder: string;
  readonly source: Source;
  /** Where `beadc blueprint` writes, for a `.proto` source; `beadc generate` writes it too. */
  readonly blueprint?: string;
  /** What `beadc generate` writes, when `beadc.yaml` names any. */
  readonly outputs?: readonly Output[];
}

// constants

/** The file beadc reads its project from. */
export const CONFIG_FILE = 'beadc.yaml';

const KEYS = new Set(['version', 'source', 'blueprint', 'outputs']);
const SOURCE_KEYS = new Set(['proto', 'blueprint']);
const TYPESCRIPT_KEYS = new Set([
  'language',
  'out',
  'importExtension',
  'runtime',
  'messages',
  'messagesOut',
]);
const MESSAGES: readonly unknown[] = Object.values(Messages);

// a path an import names, relative to the importer, and the extension it would name itself
const RELATIVE = /^\.{1,2}\//u;
const EXTENSION = /\.[cm]?[jt]s$/u;

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isText = (value: unknown): value is string => {
  return typeof value === 'string' && value !== '';
};

// definition

/** Whether `target` is `folder` or under it, by `path`'s rules: no `..` out of it, no other drive. */
export const isInside = (
  folder: string,
  details: { readonly target: string; readonly path?: PlatformPath }
): boolean => {
  const path = details.path ?? nodePath;
  const relative = path.relative(folder, path.resolve(folder, details.target));

  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * Reads `text`, a `beadc.yaml` in `folder`, each path resolved by `path`'s rules, the platform's
 * unless given. Throws an {@link InputError} for a file beadc cannot take, with the fix.
 */
export const parseConfig = (
  text: string,
  options: { readonly folder: string; readonly path?: PlatformPath }
): IConfig => {
  const path = options.path ?? nodePath;
  const { folder } = options;
  const refuse = (reason: string): never => {
    throw new InputError(`${path.join(folder, CONFIG_FILE)}: ${reason}`);
  };
  let value: unknown;

  try {
    value = parse(text) as unknown;
  } catch (error) {
    return refuse(`no YAML beadc reads: ${(error as Error).message}`);
  }

  if (!isRecord(value)) {
    return refuse('a mapping of version, source, blueprint and outputs is due');
  }

  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) {
      refuse(`${key}, a key beadc does not read`);
    }
  }

  if (value['version'] !== 1) {
    refuse('version: 1 is due');
  }

  const resolved = (given: unknown, key: string): string => {
    if (!isText(given)) {
      return refuse(`${key} is a path`);
    }

    if (!isInside(folder, { target: given, path })) {
      refuse(
        `${key}: ${given} is outside the folder that holds ${CONFIG_FILE}, which is all the image sees; move ${CONFIG_FILE} up to a folder that holds it`
      );
    }

    return path.resolve(folder, given);
  };
  // each output, its keys read or refused, its folders under this one
  const outputOf = (given: unknown, at: number): Output => {
    const key = `outputs[${String(at)}]`;

    if (!isRecord(given)) {
      return refuse(`${key} is a mapping of language, out and the language's keys`);
    }

    if (given['language'] === 'csharp') {
      return refuse(`${key}: no target csharp in this beadc, which writes typescript alone`);
    }

    if (given['language'] !== 'typescript') {
      return refuse(`${key}.language: typescript, the one target of this beadc`);
    }

    for (const name of Object.keys(given)) {
      if (!TYPESCRIPT_KEYS.has(name)) {
        refuse(`${key}.${name}, a key beadc does not read`);
      }
    }

    const importExtension = given['importExtension'] ?? 'ts';
    const runtime = given['runtime'] ?? DEFAULT_RUNTIME;
    const messages = given['messages'] ?? Messages.GENERATE;

    if (!(IMPORT_EXTENSIONS as readonly unknown[]).includes(importExtension)) {
      refuse(`${key}.importExtension is none, js or ts`);
    }

    if (!isText(runtime) || path.isAbsolute(runtime)) {
      return refuse(`${key}.runtime is a package's name, or a path relative to out`);
    }

    if (RELATIVE.test(runtime) && EXTENSION.test(runtime)) {
      refuse(`${key}.runtime: ${runtime} names no extension; importExtension gives it`);
    }

    if (!MESSAGES.includes(messages)) {
      refuse(`${key}.messages is generate or external`);
    }

    if ((messages === Messages.EXTERNAL) !== 'messagesOut' in given) {
      refuse(`${key}.messagesOut names where messages: external finds them, and only then`);
    }

    return {
      language: 'typescript',
      out: resolved(given['out'], `${key}.out`),
      importExtension: importExtension as ImportExtension,
      runtime,
      messages: messages as Messages,
      ...('messagesOut' in given
        ? { messagesOut: resolved(given['messagesOut'], `${key}.messagesOut`) }
        : {}),
    };
  };
  const outputsOf = (): { outputs?: readonly Output[] } => {
    if (!('outputs' in value)) {
      return {};
    }

    const given = value['outputs'];

    if (!Array.isArray(given) || given.length === 0) {
      return refuse('outputs lists one output at least, or is left out');
    }

    const outputs = given.map(outputOf);
    const folders = new Set(
      outputs.map((output) => {
        return path.resolve(output.out);
      })
    );

    if (folders.size < outputs.length) {
      refuse('two outputs write one folder');
    }

    return { outputs };
  };
  const source = value['source'];

  if (!isRecord(source)) {
    return refuse('source is a mapping of proto, its roots, or blueprint, a blueprint');
  }

  for (const key of Object.keys(source)) {
    if (!SOURCE_KEYS.has(key)) {
      refuse(`source.${key}, a key beadc does not read`);
    }
  }

  if ('proto' in source === 'blueprint' in source) {
    refuse('source names its proto roots or a blueprint, one of them');
  }

  if ('blueprint' in source) {
    if ('blueprint' in value) {
      refuse('blueprint, an output, beside a blueprint as the source, which is that file');
    }

    return {
      folder,
      source: { blueprint: resolved(source['blueprint'], 'source.blueprint') },
      ...outputsOf(),
    };
  }

  const given = source['proto'];
  const roots = (Array.isArray(given) ? given : [given]).map((root: unknown) => {
    return resolved(root, 'source.proto');
  });

  return {
    folder,
    source: { proto: roots },
    ...('blueprint' in value ? { blueprint: resolved(value['blueprint'], 'blueprint') } : {}),
    ...outputsOf(),
  };
};

/** The `beadc.yaml` nearest `from`, upward, or none. */
export const findConfig = (from: string): string | undefined => {
  for (let folder = nodePath.resolve(from); ;) {
    const candidate = nodePath.join(folder, CONFIG_FILE);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = nodePath.dirname(folder);

    if (parent === folder) {
      return undefined;
    }

    folder = parent;
  }
};
