// ── Config ────────────────────────────────────────────────────────────────────

// `beadc.yaml`, at a project's root: its `version`, its `source` — `.proto` roots, or a blueprint —
// and where `beadc blueprint` writes. Every path stays under the folder that holds it, since the
// image sees nothing else; a key beadc does not read is refused, never left unchecked.

// dependencies

import { existsSync } from 'node:fs';
import nodePath, { type PlatformPath } from 'node:path';

import { parse } from 'yaml';

import { InputError } from './diagnostics.ts';

// types

/** Where a project's blueprint is read from: its `.proto` roots, or a blueprint's file. */
export type Source = { readonly proto: readonly string[] } | { readonly blueprint: string };

/** `beadc.yaml`, read, each path resolved against its folder. */
export interface IConfig {
  readonly folder: string;
  readonly source: Source;
  /** Where `beadc blueprint` writes, for a `.proto` source. */
  readonly blueprint?: string;
}

// constants

/** The file beadc reads its project from. */
export const CONFIG_FILE = 'beadc.yaml';

const KEYS = new Set(['version', 'source', 'blueprint']);
const SOURCE_KEYS = new Set(['proto', 'blueprint']);

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
    return refuse('a mapping of version, source and blueprint is due');
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

    return { folder, source: { blueprint: resolved(source['blueprint'], 'source.blueprint') } };
  }

  const given = source['proto'];
  const roots = (Array.isArray(given) ? given : [given]).map((root: unknown) => {
    return resolved(root, 'source.proto');
  });

  return {
    folder,
    source: { proto: roots },
    ...('blueprint' in value ? { blueprint: resolved(value['blueprint'], 'blueprint') } : {}),
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
