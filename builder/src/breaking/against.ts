// ── Against ───────────────────────────────────────────────────────────────────

// What `beadc breaking --against` names, read: a folder, `-` for a tar on standard input as `git
// archive` writes it, or a blueprint's file. The earlier is read for what it declares, never judged
// by the rules a later beadc added: a blueprint up to its schema; a folder's committed blueprint
// first, the release's own, for Bead's rules; its `.proto` compiled into buf's image for buf's rules,
// `checkProto` not run, a refusal skipping buf's half beside a committed blueprint and exit 2
// without one; its `beadc.yaml` for its source and its blueprint alone. A `.binpb` is refused: a
// release's `.proto` is its tag's (decision 0022).

// dependencies

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { compile } from '../compile.ts';
import { againstOfText, CONFIG_FILE, type IAgainstConfig, type Source } from '../config.ts';
import { InputError } from '../diagnostics.ts';
import { blueprintOf } from '../front-end/blueprint-of.ts';
import { readSet } from '../front-end/input.ts';
import { type IBlueprint, readBlueprint } from '../model/blueprint.ts';
import { assertRoots, displayOf } from '../roots.ts';
import { extractArchive } from './archive.ts';

// types

/** The earlier, read: the blueprint Bead's rules read, and buf's image of its `.proto`. */
export interface IEarlier {
  /** What a finding names it by: the folder, `-`, or the blueprint's file. */
  readonly file: string;
  readonly blueprint: IBlueprint;
  /** Whether it holds `.proto` roots, read for Bead's rules or for buf's. */
  readonly fromProto: boolean;
  /** buf's image of its `.proto`, where this beadc compiled it. */
  readonly image?: Uint8Array;
  /** Why its `.proto` went uncompiled beside a committed blueprint: buf's first message. */
  readonly skipped?: string;
}

/** What {@link againstOf} reads the earlier by: the current input's source and `beadc.yaml`. */
export interface IAgainstOptions {
  readonly current: Source;
  /** The current `beadc.yaml`, when the call read one. */
  readonly config?: IAgainstConfig;
  /** The tar `-` names, read from standard input. */
  readonly archive?: Uint8Array;
}

// constants

/** What `--against -` reads. */
export const STANDARD_INPUT = '-';

const BINPB = /\.binpb$/iu;

const NO_SET =
  "a release's .proto is its tag's: name its folder, pipe its git archive to --against -, or --against-ref it through a wrapper";

// helpers

// the first line of a refusal, as buf's first message
const firstLineOf = (error: unknown): string => {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
};

// a blueprint of the earlier's, read up to its schema
const readEarlierBlueprint = (path: string, file: string): IBlueprint => {
  const bytes = readFileSync(path);

  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new InputError(`the earlier, ${file}, is no JSON: ${NO_SET}`);
  }

  const reading = readBlueprint(bytes, { file, rules: false });
  const [first] = reading.diagnostics;

  if (reading.blueprint === undefined || first !== undefined) {
    throw new InputError(
      `the earlier, ${file}, is no bead-blueprint/1 this beadc reads: ${first === undefined ? 'refused' : `${first.rule} at ${first.pointer ?? `line ${String(first.line ?? 1)}`}, ${first.message}`}`
    );
  }

  return reading.blueprint;
};

// the earlier's `.proto` roots, compiled into buf's image and read as a set: its blueprint, the
// front end's derivation alone, and its image
const compileEarlier = (roots: readonly string[]): { blueprint: IBlueprint; image: Uint8Array } => {
  assertRoots(roots);

  const image = compile(roots, { image: true });

  return { blueprint: blueprintOf(readSet(image, { roots })).blueprint, image };
};

// the earlier's source in `folder`: its own `beadc.yaml`'s, or the current one's, its paths taken
// from the current `beadc.yaml`'s folder into this one, or the folder itself as the root named
const folderSourceOf = (
  folder: string,
  options: IAgainstOptions
): { source: Source; blueprint?: string } => {
  const own = join(folder, CONFIG_FILE);

  if (existsSync(own)) {
    return againstOfText(readFileSync(own, 'utf8'), { folder });
  }

  const { config, current } = options;

  if (config !== undefined) {
    const moved = (path: string): string => {
      return join(folder, relative(config.folder, path));
    };

    return 'proto' in config.source
      ? { source: { proto: config.source.proto.map(moved) } }
      : { source: { blueprint: moved(config.source.blueprint) } };
  }

  if ('proto' in current) {
    return { source: { proto: [folder] } };
  }

  throw new InputError(
    `the earlier, ${displayOf(folder)}, holds no ${CONFIG_FILE}, and a blueprint named on the command line names no path in it: name the earlier's blueprint itself`
  );
};

// definition

/**
 * The earlier in `folder`, `name` what a finding names it by: its committed blueprint for Bead's
 * rules, where its `beadc.yaml` names one it holds, else its `.proto` compiled; its `.proto`, when
 * it has roots, compiled for buf's. Throws an {@link InputError} for an earlier beadc cannot read.
 */
export const againstOfFolder = (
  folder: string,
  options: IAgainstOptions & { readonly name: string }
): IEarlier => {
  const { name } = options;
  // a path of the folder as a message names it, from the folder
  const shown = (path: string): string => {
    return relative(folder, path).split(sep).join('/');
  };
  let read: { source: Source; blueprint?: string };

  try {
    read = folderSourceOf(folder, options);
  } catch (error) {
    throw new InputError(
      `the earlier, ${name}: ${firstLineOf(error).replace(`${join(folder, CONFIG_FILE)}:`, `${CONFIG_FILE}:`)}`
    );
  }

  const { source, blueprint: committed } = read;

  if ('blueprint' in source) {
    if (!existsSync(source.blueprint)) {
      throw new InputError(
        `the earlier, ${name}: its blueprint, ${shown(source.blueprint)}, is not there`
      );
    }

    return {
      file: name,
      blueprint: readEarlierBlueprint(source.blueprint, `${name}: ${shown(source.blueprint)}`),
      fromProto: false,
    };
  }

  const held = committed !== undefined && existsSync(committed) ? committed : undefined;
  let compiled: { blueprint: IBlueprint; image: Uint8Array } | undefined;
  let refusal: string | undefined;

  try {
    compiled = compileEarlier(source.proto);
  } catch (error) {
    // ! an option renamed since, or a derivation changed, costs the comparison of the messages,
    // never the gate, where the release committed its blueprint
    if (held === undefined) {
      throw new InputError(`the earlier, ${name}: ${firstLineOf(error)}`);
    }

    refusal = firstLineOf(error);
  }

  const blueprint =
    held === undefined
      ? compiled?.blueprint
      : readEarlierBlueprint(held, `${name}: ${shown(held)}`);

  if (blueprint === undefined) {
    throw new InputError(`the earlier, ${name}: its .proto gave no blueprint`);
  }

  return {
    file: name,
    blueprint,
    fromProto: true,
    ...(compiled === undefined ? {} : { image: compiled.image }),
    ...(refusal === undefined ? {} : { skipped: refusal }),
  };
};

/**
 * The earlier `path` names: a folder, `-` for the tar `options.archive` holds, or a blueprint's
 * file; a `.binpb`, or any file that is no JSON, refused. Throws an {@link InputError} for an
 * earlier beadc cannot read.
 */
export const againstOf = (path: string, options: IAgainstOptions): IEarlier => {
  if (path === STANDARD_INPUT) {
    if (options.archive === undefined) {
      throw new InputError('--against - reads a tar on standard input, and none came');
    }

    const folder = mkdtempSync(join(tmpdir(), 'beadc-against-'));

    try {
      extractArchive(options.archive, { into: folder });
      return againstOfFolder(folder, { ...options, name: STANDARD_INPUT });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  if (!existsSync(path)) {
    throw new InputError(`--against ${path}: no such file or folder`);
  }

  if (statSync(path).isDirectory()) {
    return againstOfFolder(path, { ...options, name: displayOf(path) });
  }

  if (BINPB.test(path)) {
    throw new InputError(`--against ${path}: ${NO_SET}`);
  }

  return {
    file: displayOf(path),
    blueprint: readEarlierBlueprint(path, displayOf(path)),
    fromProto: false,
  };
};

/**
 * Standard input, read whole, for `--against -`. Throws an {@link InputError} when it is a terminal,
 * which no archive comes from.
 */
export const readStandardInput = async (): Promise<Uint8Array> => {
  if (process.stdin.isTTY) {
    throw new InputError(
      '--against - reads a tar on standard input, which is a terminal: pipe git archive into it'
    );
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
};
