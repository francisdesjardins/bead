// ── Config ────────────────────────────────────────────────────────────────────

// `beadc.yaml`, at a project's root: its `version`, its `source` — `.proto` roots, or a blueprint —
// where `beadc blueprint` writes, the `outputs` `beadc generate` writes, a language and a folder
// each, TypeScript or C#, and whether `generate` takes out what it no longer writes, `clean`, buf's
// opt-in, off unless set; its HTTP prefix, the OpenAPI document `generate` writes, and each
// output's `http: true` (decision 0037). Every path stays under the folder that holds it, since the image sees
// nothing else; no output's folder holds another's, or another's messages, nor lies in one; a key
// beadc does not read is refused, never left unchecked. An earlier release's, which `beadc breaking`
// compares against, is read for its `version`, its `source` and its `blueprint` alone.

// dependencies

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { type PlatformPath } from 'node:path';

import { parse } from 'yaml';

import { InputError } from './diagnostics.ts';
import { DEFAULT_PREFIX, PREFIX } from './model/routes.ts';
import { NAMESPACE } from './targets/csharp/options.ts';
import { Messages } from './targets/target.ts';
import {
  DEFAULT_HTTP_RUNTIME,
  DEFAULT_PROTO_RUNTIME,
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
  /** The module of the check of a `proto` payload's records, as `runtime` names its own. */
  readonly protoRuntime: string;
  readonly messages: Messages;
  /** Where another generator writes the messages, for `external`. */
  readonly messagesOut?: string;
  /**
   * Whether the messages it generates keep protovalidate's options and its import, for a project
   * that runs protovalidate on its own; off, they go (decision 0035).
   */
  readonly keepValidateOptions?: boolean;
  /**
   * Whether it writes its route table and embeds the OpenAPI document, for a gateway (decision
   * 0037); off, it writes neither.
   */
  readonly http?: boolean;
  /** The module the route table imports its runtime from, under `http`, as `runtime` names one. */
  readonly httpRuntime?: string;
  /** Whether the messages it generates keep `google.api.http` and its import; off, they go. */
  readonly keepHttpOptions?: boolean;
}

/** A C# output: its folder, the namespace of a blueprint's services, and its messages. */
export interface ICSharpOutput {
  readonly language: 'csharp';
  readonly out: string;
  /** For a blueprint source alone: a `.proto`'s services take their file's. */
  readonly namespace?: string;
  readonly messages: Messages;
  /** As a TypeScript output's: protovalidate's options kept in the messages it generates. */
  readonly keepValidateOptions?: boolean;
  /** As a TypeScript output's: its route table and the document, for a gateway. */
  readonly http?: boolean;
  /** As a TypeScript output's: `google.api.http` kept in the messages it generates. */
  readonly keepHttpOptions?: boolean;
}

/** What `beadc.yaml`'s `http` says of every route: the default routes' prefix (transcoding 3.3). */
export interface IHttpConfig {
  readonly prefix: string;
}

/** The OpenAPI document `generate` writes of the blueprint, and what it says (decision 0037). */
export interface IOpenApiConfig {
  /** Where it is written; none where `beadc.yaml` names no `openapi.out`, an output's embedding it alone. */
  readonly out?: string;
  readonly title?: string;
  /** Its one security scheme, an OpenAPI Security Scheme Object; `{type: http, scheme: bearer}` by default. */
  readonly security?: Readonly<Record<string, unknown>>;
  /** The base of an application failure's problem type, an absolute URI (transcoding 7.3). */
  readonly problemTypes?: string;
}

/** An output `beadc generate` writes. */
export type Output = ITypeScriptOutput | ICSharpOutput;

/** What an earlier release's `beadc.yaml` gives `beadc breaking`: its source, and its blueprint. */
export interface IAgainstConfig {
  readonly folder: string;
  readonly source: Source;
  /** Where `beadc blueprint` writes, for a `.proto` source; `beadc generate` writes it too. */
  readonly blueprint?: string;
}

/** `beadc.yaml`, read, each path resolved against its folder. */
export interface IConfig extends IAgainstConfig {
  /** What `beadc generate` writes, when `beadc.yaml` names any. */
  readonly outputs?: readonly Output[];
  /**
   * Whether `generate` takes out of each output's folder a file of a kind it writes that it no
   * longer writes, as buf.gen.yaml's `clean`; off, it takes out nothing.
   */
  readonly clean?: boolean;
  /** Every route's prefix, `/api` unless given. */
  readonly http?: IHttpConfig;
  /** The OpenAPI document, where `beadc.yaml` says anything of it. */
  readonly openapi?: IOpenApiConfig;
}

// a `beadc.yaml` read as a mapping: how it refuses, and how a path of it resolves under its folder
interface IDocument {
  readonly value: Record<string, unknown>;
  readonly refuse: (reason: string) => never;
  readonly resolved: (given: unknown, key: string) => string;
}

// constants

/** The file beadc reads its project from. */
export const CONFIG_FILE = 'beadc.yaml';

/** The folder beadc keeps its own files in, beside `beadc.yaml`, which `init`'s `.gitignore` ignores. */
export const BEADC_FOLDER = '.beadc';

const KEYS = new Set(['version', 'source', 'blueprint', 'outputs', 'clean', 'http', 'openapi']);
const HTTP_KEYS = new Set(['prefix']);
const OPENAPI_KEYS = new Set(['out', 'title', 'security', 'problemTypes']);
// the types of an OpenAPI 3.1 Security Scheme Object
const SECURITY_TYPES = new Set(['apiKey', 'http', 'mutualTLS', 'oauth2', 'openIdConnect']);
const SOURCE_KEYS = new Set(['proto', 'blueprint']);
const TYPESCRIPT_KEYS = new Set([
  'language',
  'out',
  'importExtension',
  'runtime',
  'protoRuntime',
  'messages',
  'messagesOut',
  'keepValidateOptions',
  'http',
  'httpRuntime',
  'keepHttpOptions',
]);
const CSHARP_KEYS = new Set([
  'language',
  'out',
  'namespace',
  'messages',
  'keepValidateOptions',
  'http',
  'keepHttpOptions',
]);
// ! read as each output is, never as the module loads: target.ts and this module import each other
// through the targets' own imports, so Messages may not be there yet
const messagesOf = (): readonly unknown[] => {
  return Object.values(Messages);
};

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

// an absolute URI, a scheme and what follows it (RFC 3986 §4.3), as the URL parser takes one
const isAbsoluteUri = (value: string): boolean => {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(value) && URL.canParse(value);
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

// `text` read as a mapping whose version is 1, each path resolved by `path`'s rules under `folder`;
// with `keys`, a key it does not list refused
const documentOf = (
  text: string,
  options: {
    readonly folder: string;
    readonly path?: PlatformPath;
    readonly keys?: ReadonlySet<string>;
  }
): IDocument => {
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
    if (options.keys !== undefined && !options.keys.has(key)) {
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

  return { value, refuse, resolved };
};

// a document's source, its `.proto` roots or a blueprint, and the blueprint it writes from roots
const sourceOf = (document: IDocument): { source: Source; blueprint?: string } => {
  const { value, refuse, resolved } = document;
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

    return { source: { blueprint: resolved(source['blueprint'], 'source.blueprint') } };
  }

  const given = source['proto'];
  const roots = (Array.isArray(given) ? given : [given]).map((root: unknown) => {
    return resolved(root, 'source.proto');
  });

  return {
    source: { proto: roots },
    ...('blueprint' in value ? { blueprint: resolved(value['blueprint'], 'blueprint') } : {}),
  };
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
  const document = documentOf(text, { ...options, keys: KEYS });
  const { value, refuse, resolved } = document;
  // whether an output keeps protovalidate's options, which only messages it generates hold
  const keepsOf = (
    given: Record<string, unknown>,
    details: { readonly key: string; readonly messages: unknown }
  ): { keepValidateOptions?: boolean } => {
    const keeps = given['keepValidateOptions'];

    if (keeps === undefined) {
      return {};
    }

    if (typeof keeps !== 'boolean') {
      return refuse(`${details.key}.keepValidateOptions is true or false`);
    }

    if (keeps && details.messages !== Messages.GENERATE) {
      refuse(
        `${details.key}.keepValidateOptions keeps protovalidate's options in the messages beadc generates, and only then`
      );
    }

    return { keepValidateOptions: keeps };
  };
  // whether an output writes its route table, and keeps google.api.http in the messages it generates
  const httpOf = (
    given: Record<string, unknown>,
    details: { readonly key: string; readonly messages: unknown }
  ): { http?: boolean; keepHttpOptions?: boolean } => {
    const http = given['http'];
    const keeps = given['keepHttpOptions'];

    if (http !== undefined && typeof http !== 'boolean') {
      return refuse(
        `${details.key}.http is true or false: whether it writes its route table and the document`
      );
    }

    if (keeps !== undefined && typeof keeps !== 'boolean') {
      return refuse(`${details.key}.keepHttpOptions is true or false`);
    }

    if (keeps === true && details.messages !== Messages.GENERATE) {
      refuse(
        `${details.key}.keepHttpOptions keeps google.api.http in the messages beadc generates, and only then`
      );
    }

    return {
      ...(http === true ? { http } : {}),
      ...(keeps === undefined ? {} : { keepHttpOptions: keeps }),
    };
  };
  // a C# output, its keys read or refused: a namespace for a blueprint's services, and only then
  const csharpOutputOf = (given: Record<string, unknown>, key: string): ICSharpOutput => {
    const source = value['source'];
    const fromBlueprint = isRecord(source) && 'blueprint' in source;
    const namespace = given['namespace'];
    const messages = given['messages'] ?? Messages.GENERATE;

    for (const name of Object.keys(given)) {
      if (!CSHARP_KEYS.has(name)) {
        refuse(`${key}.${name}, a key beadc does not read`);
      }
    }

    if (fromBlueprint && namespace === undefined) {
      refuse(
        `${key}.namespace names the C# namespace of the services a blueprint declares, which no .proto gives`
      );
    }

    if (!fromBlueprint && namespace !== undefined) {
      refuse(
        `${key}.namespace: a .proto's services take their file's, its csharp_namespace or its package`
      );
    }

    if (namespace !== undefined && (typeof namespace !== 'string' || !NAMESPACE.test(namespace))) {
      refuse(`${key}.namespace is a C# namespace, identifiers of letters, digits and _ by dots`);
    }

    if (!messagesOf().includes(messages)) {
      refuse(`${key}.messages is generate or external`);
    }

    return {
      language: 'csharp',
      out: resolved(given['out'], `${key}.out`),
      ...(typeof namespace === 'string' ? { namespace } : {}),
      messages: messages as Messages,
      ...keepsOf(given, { key, messages }),
      ...httpOf(given, { key, messages }),
    };
  };
  // each output, its keys read or refused, its folders under this one
  const outputOf = (given: unknown, at: number): Output => {
    const key = `outputs[${String(at)}]`;

    if (!isRecord(given)) {
      return refuse(`${key} is a mapping of language, out and the language's keys`);
    }

    if (given['language'] === 'csharp') {
      return csharpOutputOf(given, key);
    }

    if (given['language'] !== 'typescript') {
      return refuse(`${key}.language: typescript or csharp, the targets of this beadc`);
    }

    for (const name of Object.keys(given)) {
      if (!TYPESCRIPT_KEYS.has(name)) {
        refuse(`${key}.${name}, a key beadc does not read`);
      }
    }

    const importExtension = given['importExtension'] ?? 'ts';
    const runtime = given['runtime'] ?? DEFAULT_RUNTIME;
    const protoRuntime = given['protoRuntime'] ?? DEFAULT_PROTO_RUNTIME;
    const httpRuntime = given['httpRuntime'] ?? DEFAULT_HTTP_RUNTIME;
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

    if (!isText(protoRuntime) || path.isAbsolute(protoRuntime)) {
      return refuse(`${key}.protoRuntime is a package's name, or a path relative to out`);
    }

    if (RELATIVE.test(protoRuntime) && EXTENSION.test(protoRuntime)) {
      refuse(`${key}.protoRuntime: ${protoRuntime} names no extension; importExtension gives it`);
    }

    if (!isText(httpRuntime) || path.isAbsolute(httpRuntime)) {
      return refuse(`${key}.httpRuntime is a package's name, or a path relative to out`);
    }

    if (RELATIVE.test(httpRuntime) && EXTENSION.test(httpRuntime)) {
      refuse(`${key}.httpRuntime: ${httpRuntime} names no extension; importExtension gives it`);
    }

    if ('httpRuntime' in given && given['http'] !== true) {
      refuse(`${key}.httpRuntime names the route table's runtime, which only http: true writes`);
    }

    if (!messagesOf().includes(messages)) {
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
      protoRuntime,
      ...(given['http'] === true ? { httpRuntime } : {}),
      messages: messages as Messages,
      ...('messagesOut' in given
        ? { messagesOut: resolved(given['messagesOut'], `${key}.messagesOut`) }
        : {}),
      ...keepsOf(given, { key, messages }),
      ...httpOf(given, { key, messages }),
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

    // ! generate takes out of an output's folder, wherever under it, each file of its kinds that
    // output does not write: no folder another output writes, or reads its messages from, lies in it
    const others = outputs.flatMap((output, at) => {
      return [
        { at, key: `outputs[${String(at)}].out`, folder: output.out, written: true },
        ...(output.language === 'typescript' && output.messagesOut !== undefined
          ? [
              {
                at,
                key: `outputs[${String(at)}].messagesOut`,
                folder: output.messagesOut,
                written: false,
              },
            ]
          : []),
      ];
    });
    // two outputs' folders one where a system folds case are left to generate, which names the
    // sources of the files it would write at one path
    const foldedOne = (one: string, other: string): boolean => {
      return path.resolve(one).toLowerCase() === path.resolve(other).toLowerCase();
    };

    outputs.forEach((output, at) => {
      for (const other of others) {
        if (
          other.at !== at &&
          !(other.written && foldedOne(output.out, other.folder)) &&
          (isInside(output.out, { target: other.folder, path }) ||
            isInside(other.folder, { target: output.out, path }))
        ) {
          refuse(
            `outputs[${String(at)}].out and ${other.key} lie one inside the other, and generate takes out of an output's folder the files of its kinds it does not write: give each a folder of its own`
          );
        }
      }
    });

    return { outputs };
  };
  // `http`, its prefix held to 3.3's form
  const httpConfigOf = (): { http?: IHttpConfig } => {
    if (!('http' in value)) {
      return {};
    }

    const given = value['http'];

    if (!isRecord(given)) {
      return refuse("http is a mapping of prefix, the default routes' prefix");
    }

    for (const key of Object.keys(given)) {
      if (!HTTP_KEYS.has(key)) {
        refuse(`http.${key}, a key beadc does not read`);
      }
    }

    const prefix = given['prefix'] ?? DEFAULT_PREFIX;

    if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
      return refuse(
        'http.prefix is / and segments of letters, digits, -, ., _ and ~, none . or .., no / at its end (transcoding 3.3)'
      );
    }

    return { http: { prefix } };
  };
  // `openapi`: where the document goes, its title, its security scheme and its problem types
  const openapiOf = (): { openapi?: IOpenApiConfig } => {
    if (!('openapi' in value)) {
      return {};
    }

    const given = value['openapi'];

    if (!isRecord(given)) {
      return refuse('openapi is a mapping of out, title, security and problemTypes');
    }

    for (const key of Object.keys(given)) {
      if (!OPENAPI_KEYS.has(key)) {
        refuse(`openapi.${key}, a key beadc does not read`);
      }
    }

    const { title, security, problemTypes } = given;

    if (title !== undefined && !isText(title)) {
      refuse("openapi.title is a text: the document's info.title");
    }

    if (
      security !== undefined &&
      (!isRecord(security) ||
        typeof security['type'] !== 'string' ||
        !SECURITY_TYPES.has(security['type']))
    ) {
      refuse(
        'openapi.security is an OpenAPI Security Scheme Object, its type apiKey, http, mutualTLS, oauth2 or openIdConnect'
      );
    }

    if (
      problemTypes !== undefined &&
      (typeof problemTypes !== 'string' || !isAbsoluteUri(problemTypes))
    ) {
      refuse(
        "openapi.problemTypes is an absolute URI, which an application failure's name follows as its problem type (RFC 9457 §3.1.1)"
      );
    }

    return {
      openapi: {
        ...('out' in given ? { out: resolved(given['out'], 'openapi.out') } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        ...(isRecord(security) ? { security } : {}),
        ...(typeof problemTypes === 'string' ? { problemTypes } : {}),
      },
    };
  };
  const read = sourceOf(document);
  const clean = value['clean'];

  if (clean !== undefined && typeof clean !== 'boolean') {
    refuse('clean is true or false: whether generate takes out what it no longer writes');
  }

  return {
    folder,
    ...read,
    ...outputsOf(),
    ...(clean === true ? { clean } : {}),
    ...httpConfigOf(),
    ...openapiOf(),
  };
};

/** Whether `config` asks for HTTP: an output with `http: true`, or the OpenAPI document written. */
export const asksHttp = (config: Pick<IConfig, 'openapi' | 'outputs'>): boolean => {
  return (
    config.openapi?.out !== undefined ||
    (config.outputs ?? []).some((output) => {
      return output.http === true;
    })
  );
};

/**
 * Reads `text`, an earlier release's `beadc.yaml` in `folder`, for `beadc breaking`: its `version`,
 * its `source` and its `blueprint` alone, each path under its folder, so that a key a later beadc
 * dropped stops no comparison. Throws an {@link InputError} for a file beadc cannot take.
 */
export const againstOfText = (
  text: string,
  options: { readonly folder: string; readonly path?: PlatformPath }
): IAgainstConfig => {
  return { folder: options.folder, ...sourceOf(documentOf(text, options)) };
};

/**
 * A temporary folder of beadc's, made: under `options.folder`'s `.beadc/` where a `beadc.yaml` was
 * read, on the project's drive, which buf's build of one module over its roots and beadc's options
 * needs; under the system's temporary folder otherwise. The caller takes it out.
 */
export const temporaryFolderOf = (
  prefix: string,
  options: { readonly folder?: string } = {}
): string => {
  if (options.folder === undefined) {
    return mkdtempSync(nodePath.join(tmpdir(), `beadc-${prefix}`));
  }

  const own = nodePath.join(options.folder, BEADC_FOLDER);

  mkdirSync(own, { recursive: true });

  return mkdtempSync(nodePath.join(own, prefix));
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
