#!/usr/bin/env node
// Coverage-guided fuzzing of Bead's own parsers, on both sides, by hand: never in CI. Four targets,
// the same on each side and named alike, each fed raw bytes:
//
// - `envelope`: the envelope reader, its header then its body, and a failure's record;
// - `payload-codecs`: the `json` and `text` codecs' readers, and the writers behind them;
// - `http-fields`: the HTTP transport's field parsers, an Item of RFC 9651 for the `Bead-*` fields,
//   `Authorization`, `X-Forwarded-For`, the target and its `Host`, `Origin`, by the first byte;
// - `debug-filter`: the `debug` filter's parser, and the patterns of a filter it returns.
//
// A target lets the refusal its parser is designed to give pass; anything else it throws, an input
// past a second, or memory past 256 MiB of its own is a finding, which the fuzzer keeps.
//
// - TypeScript: Jazzer.js, in-process, over `implementations/typescript/tools/fuzz/`, a project of
//   its own that `yarn install` there installs by hand, so neither the package's install nor CI
//   fetches it. Each target is bundled by the package's esbuild into `.build/`, which Jazzer.js
//   instruments alone. Node and Jazzer.js hold about 220 MiB of their own before the first input,
//   so libFuzzer's limit on the process is 512 MiB.
// - C#: libFuzzer as libfuzzer-dotnet builds it for Windows, over
//   `implementations/dotnet/tools/Bead.Fuzz/`, which it runs as its child, once SharpFuzz has
//   instrumented Bead.Core in a copy of its build. `fuzz/fuzzer.json` pins both: the fuzzer's
//   release and its SHA-256, checked before a byte of it is written, and the instrumenter's
//   version, which is the SharpFuzz library's in implementations/dotnet/Directory.Packages.props.
//   Both land in `.fuzzer/` beside the project, which git ignores. The child's runtime holds its
//   managed heap to 256 MiB.
//
//   node tools/fuzz.mjs seed                     both sides' corpora, from the conformance files
//   node tools/fuzz.mjs fetch                    the C# side's fuzzer and instrumenter, by the pin
//   node tools/fuzz.mjs build <side>             typescript: the bundles; csharp: the instrumented build
//   node tools/fuzz.mjs run <side> <target> [input...] [-- libFuzzer flags...]
//
// `run` fuzzes from the side's `corpus/<target>/`, where it keeps what it finds new, and writes a
// finding to `findings/<target>/`, both beside the side's targets and ignored by git; given inputs,
// it runs each once instead, a finding's among them, on either side. libFuzzer's flags follow `--`:
// `-max_total_time=600` for ten minutes, `-minimize_crash=1 -runs=10000` with a finding to minimise
// it. The seeds are the conformance files' bytes, each file named by its SHA-1, as libFuzzer names
// what it keeps, so seeding again adds nothing twice. Exit as the fuzzer exits, 1 on a usage error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Places ────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC = join(ROOT, 'spec');
const PIN_FILE = join(ROOT, 'tools', 'fuzz', 'fuzzer.json');
const PACKAGES = join(ROOT, 'implementations', 'dotnet', 'Directory.Packages.props');
const TYPESCRIPT = join(ROOT, 'implementations', 'typescript');

/** The targets, the same on each side, by their names. */
export const TARGETS = Object.freeze(['envelope', 'payload-codecs', 'http-fields', 'debug-filter']);

/** Each side's folder, where its targets, its corpora and its findings are. */
export const SIDES = Object.freeze({
  typescript: join(TYPESCRIPT, 'tools', 'fuzz'),
  csharp: join(ROOT, 'implementations', 'dotnet', 'tools', 'Bead.Fuzz'),
});

const FUZZER = join(SIDES.csharp, '.fuzzer');
const BUILD = join(FUZZER, 'out');

// ── Seeds ─────────────────────────────────────────────────────────────────────

// the slots of the HTTP target's first byte, as both sides' targets read it
const SLOTS = Object.freeze({
  ITEM: 0,
  AUTHORIZATION: 1,
  FORWARDED_FOR: 2,
  HOST: 3,
  ORIGIN: 4,
});

// the fields a listen reads as an Item (spec 15.9)
const ITEM_FIELDS = Object.freeze(['bead-after', 'bead-wait', 'bead-listen']);

// what a transport case's head stands in for, written as a request carries it
const PLACEHOLDERS = Object.freeze({ host: '127.0.0.1:8080' });

/** The bytes of a conformance file's hexadecimal, its spaces and bars aside; none for other text. */
export const hexBytesOf = (text) => {
  const digits = typeof text === 'string' ? text.replaceAll(/[\s|]/gu, '') : '';

  return /^(?:[0-9A-Fa-f]{2})+$/u.test(digits) ? Buffer.from(digits, 'hex') : undefined;
};

/** Every hexadecimal string `value` holds under one of `keys`, at any depth, as bytes. */
export const hexUnder = (value, keys) => {
  const found = [];

  const walk = (inner) => {
    if (Array.isArray(inner)) {
      inner.forEach(walk);
    } else if (inner !== null && typeof inner === 'object') {
      for (const [key, nested] of Object.entries(inner)) {
        const bytes = keys.includes(key) ? hexBytesOf(nested) : undefined;

        if (bytes === undefined) {
          walk(nested);
        } else {
          found.push(bytes);
        }
      }
    }
  };

  walk(value);

  return found;
};

/** A request's head read as the HTTP target's seeds: each field's lines, after its slot's byte. */
export const headSeedsOf = (head) => {
  const [requestLine = '', ...fieldLines] = head
    .replaceAll(/\{(\w+)\}/gu, (_, name) => {
      return PLACEHOLDERS[name] ?? name;
    })
    .split('\r\n');
  const target = requestLine.split(' ')[1] ?? '/';
  const fields = new Map();

  for (const line of fieldLines) {
    const colon = line.indexOf(':');

    if (colon > 0) {
      const name = line.slice(0, colon).toLowerCase();

      fields.set(name, [...(fields.get(name) ?? []), line.slice(colon + 1).trim()]);
    }
  }

  const seedOf = (slot, text) => {
    return Buffer.concat([Buffer.of(slot), Buffer.from(text, 'latin1')]);
  };
  const linesOf = (name) => {
    return fields.get(name) ?? [];
  };

  return [
    ...ITEM_FIELDS.flatMap(linesOf).map((value) => {
      return seedOf(SLOTS.ITEM, value);
    }),
    ...(fields.has('authorization')
      ? [seedOf(SLOTS.AUTHORIZATION, linesOf('authorization').join('\n'))]
      : []),
    ...(fields.has('x-forwarded-for')
      ? [seedOf(SLOTS.FORWARDED_FOR, linesOf('x-forwarded-for').join(','))]
      : []),
    seedOf(SLOTS.HOST, [target, ...linesOf('host')].join('\n')),
    ...(fields.has('origin') ? [seedOf(SLOTS.ORIGIN, linesOf('origin').join('\n'))] : []),
  ];
};

/** Every string `value` holds under `key`, at any depth. */
const stringsUnder = (value, key) => {
  const found = [];

  const walk = (inner) => {
    if (Array.isArray(inner)) {
      inner.forEach(walk);
    } else if (inner !== null && typeof inner === 'object') {
      for (const [name, nested] of Object.entries(inner)) {
        if (name === key && typeof nested === 'string') {
          found.push(nested);
        } else {
          walk(nested);
        }
      }
    }
  };

  walk(value);

  return found;
};

/**
 * Each target's seeds, from the conformance files as `files` holds them parsed, by their names:
 * the envelopes of `vectors.json`, `conversations.json` and `transports.json`; the `json` and
 * `text` payloads of `codecs.json`, read and written, and the payloads the conversations and the
 * transports carry; the heads of `transports.json`, field by field; the filters of
 * `debug-filters.json`, as written and as given by a function.
 */
export const seedsOf = (files) => {
  const { codecs, conversations, debugFilters, transports, vectors } = files;
  const isTextual = (entry) => {
    return entry.encoding === 'json' || entry.encoding === 'text';
  };

  return {
    envelope: [
      ...hexUnder(vectors, ['bytes', 'record']),
      ...hexUnder(conversations, ['send']),
      ...hexUnder(transports, ['binary', 'body']),
    ],
    'payload-codecs': [
      ...hexUnder(codecs.payloads.filter(isTextual), ['bytes', 'written']),
      ...hexUnder(codecs.values.filter(isTextual), ['written']),
      ...hexUnder([conversations, transports], ['payload']),
    ],
    'http-fields': stringsUnder(transports, 'head').flatMap(headSeedsOf),
    'debug-filter': [
      ...stringsUnder(debugFilters.filters, 'filter'),
      ...stringsUnder(debugFilters.sources, 'gives'),
    ].map((filter) => {
      return Buffer.from(filter, 'utf8');
    }),
  };
};

/** A seed's file name, its SHA-1 in hexadecimal, as libFuzzer names an input it keeps. */
export const seedNameOf = (bytes) => {
  return createHash('sha1').update(bytes).digest('hex');
};

const readSpec = (name) => {
  return JSON.parse(readFileSync(join(SPEC, name), 'utf8'));
};

const seed = () => {
  const seeds = seedsOf({
    codecs: readSpec('codecs.json'),
    conversations: readSpec('conversations.json'),
    debugFilters: readSpec('debug-filters.json'),
    transports: readSpec('transports.json'),
    vectors: readSpec('vectors.json'),
  });

  for (const target of TARGETS) {
    const unique = new Map(
      seeds[target].map((bytes) => {
        return [seedNameOf(bytes), bytes];
      })
    );

    for (const folder of Object.values(SIDES)) {
      const corpus = join(folder, 'corpus', target);

      mkdirSync(corpus, { recursive: true });

      for (const [name, bytes] of unique) {
        writeFileSync(join(corpus, name), bytes);
      }
    }

    process.stdout.write(`fuzz: ${target}, ${String(unique.size)} seeds on each side\n`);
  }
};

// ── Pin ───────────────────────────────────────────────────────────────────────

/** The pin, `fuzz/fuzzer.json`, read. */
export const readPin = (text) => {
  const pin = JSON.parse(text);

  for (const key of ['repository', 'release', 'asset', 'url']) {
    if (typeof pin.libfuzzerDotnet?.[key] !== 'string' || pin.libfuzzerDotnet[key] === '') {
      throw new Error(`fuzzer.json: libfuzzerDotnet.${key} is missing`);
    }
  }

  if (!/^[0-9a-f]{64}$/u.test(pin.libfuzzerDotnet.sha256 ?? '')) {
    throw new Error('fuzzer.json: libfuzzerDotnet.sha256 is 64 lower-case hexadecimal digits');
  }

  if (typeof pin.sharpfuzz?.package !== 'string' || typeof pin.sharpfuzz?.version !== 'string') {
    throw new Error("fuzzer.json: sharpfuzz is the instrumenter's package and its version");
  }

  return pin;
};

/** The SharpFuzz library's version in Directory.Packages.props; none when it pins none. */
export const sharpFuzzOf = (text) => {
  return /<PackageVersion Include="SharpFuzz" Version="([^"]+)"/u.exec(text)?.[1];
};

/** Why the instrumenter's pin and the library's version disagree; none when they agree. */
export const pinDisagreement = (pin, library) => {
  return pin.sharpfuzz.version === library
    ? undefined
    : `fuzzer.json pins SharpFuzz's instrumenter at ${pin.sharpfuzz.version}, Directory.Packages.props its library at ${String(library)}`;
};

/** `bytes`' SHA-256, in lower-case hexadecimal. */
export const sha256Of = (bytes) => {
  return createHash('sha256').update(bytes).digest('hex');
};

const readPins = () => {
  const pin = readPin(readFileSync(PIN_FILE, 'utf8'));
  const disagreement = pinDisagreement(pin, sharpFuzzOf(readFileSync(PACKAGES, 'utf8')));

  if (disagreement !== undefined) {
    throw new Error(disagreement);
  }

  return pin;
};

// ── Running ───────────────────────────────────────────────────────────────────

const USAGE = [
  'usage: node tools/fuzz.mjs seed',
  '       node tools/fuzz.mjs fetch',
  '       node tools/fuzz.mjs build typescript|csharp',
  `       node tools/fuzz.mjs run typescript|csharp ${TARGETS.join('|')} [input...] [-- libFuzzer flags...]`,
].join('\n');

/** A command line read: the command, its side and target, its inputs, and libFuzzer's flags. */
export const argumentsOf = (argv) => {
  const dash = argv.indexOf('--');
  const [command, side, target, ...inputs] = dash === -1 ? argv : argv.slice(0, dash);
  const flags = dash === -1 ? [] : argv.slice(dash + 1);

  if (command === 'seed' || command === 'fetch') {
    return side === undefined ? { command } : undefined;
  }

  if (command === 'build') {
    return side in SIDES && target === undefined ? { command, side } : undefined;
  }

  if (command === 'run') {
    return side in SIDES && TARGETS.includes(target)
      ? { command, side, target, inputs, flags }
      : undefined;
  }

  return undefined;
};

// `command` run, its output the terminal's; its exit status, or an error when it cannot start
const run = (command, args, { cwd, env } = {}) => {
  const done = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  if (done.error !== undefined) {
    throw done.error;
  }

  return done.status ?? 1;
};

const runOrThrow = (command, args, options) => {
  const status = run(command, args, options);

  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')}: exit ${String(status)}`);
  }
};

const assertWindows = () => {
  if (process.platform !== 'win32') {
    throw new Error("the C# side's fuzzer is libfuzzer-dotnet's Windows build: fuzz it on Windows");
  }
};

const fetchFuzzer = async () => {
  assertWindows();

  const { libfuzzerDotnet, sharpfuzz } = readPins();
  const exe = join(FUZZER, libfuzzerDotnet.asset);

  if (!existsSync(exe) || sha256Of(readFileSync(exe)) !== libfuzzerDotnet.sha256) {
    const response = await fetch(libfuzzerDotnet.url);

    if (!response.ok) {
      throw new Error(`${libfuzzerDotnet.url}: ${String(response.status)} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256Of(bytes);

    // ! nothing of the fuzzer is written before its SHA-256 is the pin's
    if (actual !== libfuzzerDotnet.sha256) {
      throw new Error(
        `${libfuzzerDotnet.url}: ${actual}, where the pin says ${libfuzzerDotnet.sha256}`
      );
    }

    mkdirSync(FUZZER, { recursive: true });
    writeFileSync(exe, bytes);
  }

  rmSync(join(FUZZER, 'tools'), { force: true, recursive: true });
  runOrThrow(
    'dotnet',
    [
      'tool',
      'install',
      sharpfuzz.package,
      '--version',
      sharpfuzz.version,
      '--tool-path',
      join(FUZZER, 'tools'),
    ],
    { cwd: SIDES.csharp }
  );
  process.stdout.write(
    `fuzz: ${libfuzzerDotnet.asset} ${libfuzzerDotnet.release} and ${sharpfuzz.package} ${sharpfuzz.version} in ${FUZZER}\n`
  );
};

const buildTypeScript = () => {
  const esbuild = join(TYPESCRIPT, 'node_modules', 'esbuild', 'bin', 'esbuild');

  if (!existsSync(esbuild)) {
    throw new Error(
      "esbuild is the TypeScript side's: run `yarn install` in implementations/typescript"
    );
  }

  runOrThrow(
    process.execPath,
    [
      esbuild,
      ...TARGETS.map((target) => {
        return `${target}=${target}.ts`;
      }),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node24',
      '--sourcemap=inline',
      '--out-extension:.js=.cjs',
      '--outdir=.build',
      '--log-level=warning',
    ],
    { cwd: SIDES.typescript }
  );
};

const buildCSharp = () => {
  assertWindows();

  const sharpfuzz = join(FUZZER, 'tools', 'sharpfuzz.exe');

  if (!existsSync(sharpfuzz)) {
    throw new Error('the instrumenter is missing: run `node tools/fuzz.mjs fetch`');
  }

  // ! an assembly is instrumented once: the build is made again whole before it
  rmSync(BUILD, { force: true, recursive: true });
  runOrThrow(
    'dotnet',
    ['publish', 'Bead.Fuzz.csproj', '-c', 'Release', '-o', BUILD, '--nologo', '-v', 'quiet'],
    {
      cwd: SIDES.csharp,
    }
  );
  runOrThrow(sharpfuzz, [join(BUILD, 'Bead.Core.dll')]);
};

// the flags every run takes: an input past a second hangs, and a finding goes to its folder
const flagsOf = ({ side, target }) => {
  const findings = join(SIDES[side], 'findings', target);

  mkdirSync(findings, { recursive: true });

  return ['-timeout=1', `-artifact_prefix=${findings}/`];
};

const corpusOf = ({ side, target, inputs }) => {
  // ! the fuzzer runs from its side's folder: an input is named from where the tool was run
  if (inputs.length > 0) {
    return inputs.map((input) => {
      return resolve(input);
    });
  }

  const corpus = join(SIDES[side], 'corpus', target);

  mkdirSync(corpus, { recursive: true });

  return [corpus];
};

const runTypeScript = ({ target, inputs, flags }) => {
  const jazzer = join(SIDES.typescript, 'node_modules', '@jazzer.js', 'core', 'dist', 'cli.js');
  const bundle = join(SIDES.typescript, '.build', `${target}.cjs`);

  if (!existsSync(jazzer)) {
    throw new Error(
      'Jazzer.js is missing: run `yarn install` in implementations/typescript/tools/fuzz'
    );
  }

  if (!existsSync(bundle)) {
    throw new Error('the bundles are missing: run `node tools/fuzz.mjs build typescript`');
  }

  return run(
    process.execPath,
    [
      jazzer,
      bundle,
      ...corpusOf({ side: 'typescript', target, inputs }),
      '--sync',
      '--includes=.build',
      '--timeout=1000',
      '--',
      ...flagsOf({ side: 'typescript', target }),
      '-rss_limit_mb=512',
      ...flags,
    ],
    { cwd: SIDES.typescript, env: { NODE_OPTIONS: '--enable-source-maps' } }
  );
};

const runCSharp = ({ target, inputs, flags }) => {
  assertWindows();

  const { libfuzzerDotnet } = readPins();
  const exe = join(FUZZER, libfuzzerDotnet.asset);
  const fuzz = join(BUILD, 'Bead.Fuzz.exe');

  if (!existsSync(exe)) {
    throw new Error('the fuzzer is missing: run `node tools/fuzz.mjs fetch`');
  }

  if (!existsSync(fuzz)) {
    throw new Error('the instrumented build is missing: run `node tools/fuzz.mjs build csharp`');
  }

  return run(exe, [
    `--target_path=${fuzz}`,
    `--target_arg=${target}`,
    ...flagsOf({ side: 'csharp', target }),
    ...flags,
    ...corpusOf({ side: 'csharp', target, inputs }),
  ]);
};

// ── Main ──────────────────────────────────────────────────────────────────────

const main = async (argv) => {
  const given = argumentsOf(argv);

  if (given === undefined) {
    throw new Error(USAGE);
  }

  switch (given.command) {
    case 'seed':
      seed();
      return 0;
    case 'fetch':
      await fetchFuzzer();
      return 0;
    case 'build':
      if (given.side === 'typescript') {
        buildTypeScript();
      } else {
        buildCSharp();
      }

      return 0;
    default:
      return given.side === 'typescript' ? runTypeScript(given) : runCSharp(given);
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fuzz: ${error.message}\n`);
    process.exitCode = 1;
  }
}
