#!/usr/bin/env node
// protovalidate-es against each side's generated validators (decision 0035): spec/validations.json's
// every verdict, and `corpus.size` payloads mutated from them from `corpus.seed`, judged by the
// validators beadc writes for spec/validations.proto and by protovalidate-es, the ecosystem's own
// implementation, at its pin: `protovalidate-differential/pin.json` gives each package's tarball and
// npm's integrity, a sha512, protovalidate-es and what it loads, @bufbuild/protobuf among them. This
// fetches each, checks its sha512 before it reads a byte of it, and unpacks it into
// `protovalidate-differential/.oracle/node_modules/`, which git ignores and CI caches by the pin, as
// protobuf-conformance.mjs does its runner: the root's tools take no dependency (decision 0005).
//
//   node tools/protovalidate-differential.mjs oracle        protovalidate-es over the verdicts alone
//   node tools/protovalidate-differential.mjs typescript    the corpus through the TypeScript side's
//   node tools/protovalidate-differential.mjs csharp        the corpus through the C# side's
//
// The violations are compared as protovalidate's own conformance compares them, sorted by `ruleId`
// then by path, and a path by its elements, protovalidate's `FieldPath` from `violationsToProto`,
// never as a string: Bead's rendering is its own (spec 18.4). A string key past 64 bytes is cut on
// protovalidate-es's side as 18.4 cuts it before the two are compared. `forKey` and every word are
// held equal, the words protovalidate-es 1.3.0's (spec 18.8.6). The order of the violations is
// Bead's alone, which `spec/validations.json` fixes, and is not compared; nor are `bounds`, which
// protovalidate's `Violation` does not carry. A verdict `excluded` names, where protovalidate-es parts
// from protovalidate's own text, is left out by its name.
//
// spec/validations.proto is built by the builder's buf, `beadc blueprint` and its set. For a side,
// beadc generates its validators into the side's testee, as protobuf-conformance.mjs does its codecs:
//
// - TypeScript: `implementations/typescript/tools/protovalidate-differential/`, its `generated/`
//   written here, its `testee.ts` run by Node on the side's own install;
// - C#: `implementations/dotnet/tools/Bead.ProtovalidateDifferential/`, its `Generated/` written
//   here, built in Release and run by `dotnet`.
//
// A testee reads a case a line on its standard input, `{"message":"<full name>","payload":"<base64>"}`,
// reads the payload as its message's codec reads it, judges it by the procedure that binds it,
// `failFast` off and no bound, and writes a line for each on its standard output:
// `{"violations":[<each violation, spec 18.3's members>]}`, or `{"refused":true}` where its library
// does not read the payload, which leaves the case uncompared and counted. A case protovalidate-es's
// library does not read is never sent.
//
// From the repository's root, once builder/ and the side are installed; protoc is `BEADC_PROTOC`, or
// the one builder/tools/fetch-protoc.mjs fetches. Exit 1 on a parting, with its case.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Places ────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HERE = join(ROOT, 'tools', 'protovalidate-differential');
const PIN_FILE = join(HERE, 'pin.json');
const ORACLE = join(HERE, '.oracle');
const WORK = join(HERE, '.work');
const BEADC = join(ROOT, 'builder', 'src', 'cli.ts');
const FETCH_PROTOC = join(ROOT, 'builder', 'tools', 'fetch-protoc.mjs');
const VALIDATIONS = join(ROOT, 'spec', 'validations.json');
const VALIDATIONS_PROTO = join(ROOT, 'spec', 'validations.proto');

// * each side's testee: where beadc's output goes, and how it is built and run
export const SIDES = Object.freeze({
  typescript: Object.freeze({
    language: 'typescript',
    folder: 'implementations/typescript/tools/protovalidate-differential',
    generated: 'generated',
    runtime: '../../../src/service/service',
    protoRuntime: '../../../src/proto/proto',
  }),
  csharp: Object.freeze({
    language: 'csharp',
    folder: 'implementations/dotnet/tools/Bead.ProtovalidateDifferential',
    generated: 'Generated',
  }),
});

// a string key's subscript holds 64 bytes of its UTF-8 at most (spec 18.4)
const KEY_BYTES = 64;

// ── Pin ───────────────────────────────────────────────────────────────────────

/** The pin, `pin.json`, read: its packages, its corpus and its exclusions, each held to its form. */
export const readPin = (text) => {
  const pin = JSON.parse(text);
  const packages = Array.isArray(pin.packages) ? pin.packages : [];

  if (
    typeof pin.oracle !== 'string' ||
    packages.length === 0 ||
    !packages.some((each) => {
      return each.name === pin.oracle;
    })
  ) {
    throw new Error('pin.json: oracle names one of its packages');
  }

  for (const each of packages) {
    for (const key of ['name', 'version', 'tarball', 'integrity']) {
      if (typeof each[key] !== 'string' || each[key] === '') {
        throw new Error(`pin.json: each package's ${key} is a string`);
      }
    }

    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(each.integrity)) {
      throw new Error(`pin.json: ${each.name}'s integrity is npm's sha512`);
    }
  }

  if (!Number.isInteger(pin.corpus?.seed) || !Number.isInteger(pin.corpus?.size)) {
    throw new Error('pin.json: corpus is its seed and its size, whole numbers');
  }

  if (!Array.isArray(pin.excluded)) {
    throw new Error('pin.json: excluded lists verdicts by name');
  }

  return pin;
};

/** `bytes`' integrity, as npm's `dist.integrity` gives it: `sha512-<base64>`. */
export const integrityOf = (bytes) => {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
};

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * A field path as Bead renders it (spec 18.4), read back into its elements: each its name and, for
 * an item or an entry, its subscript, `{ index }`, `{ bool }`, `{ integer }` or `{ string, cut }`.
 */
export const elementsOfPath = (path) => {
  if (path === undefined || path === '') {
    return [];
  }

  const elements = [];
  let at = 0;

  while (at < path.length) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(path.slice(at));

    if (name === null) {
      throw new Error(`${path}: no name at ${String(at)}`);
    }

    at += name[0].length;

    const element = { name: name[0] };

    if (path[at] === '[') {
      at += 1;

      if (path[at] === '"') {
        let end = at + 1;

        while (path[end] !== '"') {
          end += path[end] === '\\' ? 2 : 1;
        }

        const string = JSON.parse(path.slice(at, end + 1));
        const cut = path.startsWith('...', end + 1);

        element.subscript = { string, cut };
        at = end + 1 + (cut ? 3 : 0);
      } else {
        const end = path.indexOf(']', at);
        const text = path.slice(at, end);

        element.subscript =
          text === 'true' || text === 'false'
            ? { bool: text === 'true' }
            : { integer: BigInt(text).toString() };
        at = end;
      }

      if (path[at] !== ']') {
        throw new Error(`${path}: no ] at ${String(at)}`);
      }

      at += 1;
    }

    elements.push(element);

    if (path[at] === '.') {
      at += 1;
    }
  }

  return elements;
};

/** A string key as 18.4 cuts it: whole within 64 bytes of UTF-8, else back to a character's start. */
export const cutKeyOf = (key) => {
  const bytes = new TextEncoder().encode(key);

  if (bytes.length <= KEY_BYTES) {
    return { string: key, cut: false };
  }

  let cut = '';
  let size = 0;

  for (const character of key) {
    const length = new TextEncoder().encode(character).length;

    if (size + length > KEY_BYTES) {
      break;
    }

    cut += character;
    size += length;
  }

  return { string: cut, cut: true };
};

/**
 * protovalidate's `FieldPath`, as `violationsToProto` gives it, in the elements `elementsOfPath`
 * reads: an index read alike, a bool key, an integer key whatever its sign, a string key cut as
 * 18.4 cuts it.
 */
export const elementsOfProto = (fieldPath) => {
  return (fieldPath?.elements ?? []).map((element) => {
    const { subscript } = element;
    const named = { name: element.fieldName };

    switch (subscript?.case) {
      case 'index': {
        return { ...named, subscript: { integer: String(subscript.value) } };
      }
      case 'boolKey': {
        return { ...named, subscript: { bool: subscript.value } };
      }
      case 'intKey':
      case 'uintKey': {
        return { ...named, subscript: { integer: String(subscript.value) } };
      }
      case 'stringKey': {
        return { ...named, subscript: cutKeyOf(subscript.value) };
      }
      default: {
        return named;
      }
    }
  });
};

// an element as both sides compare it: an index and an integer key alike, as Bead renders both
const elementKeyOf = (element) => {
  const { subscript } = element;

  if (subscript === undefined) {
    return element.name;
  }

  if ('bool' in subscript) {
    return `${element.name}[${String(subscript.bool)}]`;
  }

  if ('integer' in subscript) {
    return `${element.name}[${subscript.integer}]`;
  }

  return `${element.name}[${JSON.stringify(subscript.string)}${subscript.cut ? '...' : ''}]`;
};

/**
 * Violations as protovalidate's conformance compares them: each its rule, its path by elements,
 * `forKey` and its words, sorted by `ruleId`, then by path.
 */
export const comparableOf = (violations) => {
  return violations
    .map((violation) => {
      return {
        ruleId: violation.ruleId,
        path: violation.elements.map(elementKeyOf).join('.'),
        forKey: violation.forKey === true,
        message: violation.message,
      };
    })
    .sort((one, other) => {
      if (one.ruleId !== other.ruleId) {
        return one.ruleId < other.ruleId ? -1 : 1;
      }

      return one.path < other.path ? -1 : one.path > other.path ? 1 : 0;
    });
};

// ── Corpus ────────────────────────────────────────────────────────────────────

// mulberry32, a fixed seed's numbers in [0, 1)
const randomOf = (seed) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);

    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const bytesOf = (hex) => {
  return Uint8Array.from(
    hex
      .split(' ')
      .filter((part) => {
        return part !== '';
      })
      .map((part) => {
        return Number.parseInt(part, 16);
      })
  );
};

/** A verdict's payload: its bytes, or its runs end to end. */
export const payloadOf = (verdict) => {
  if (verdict.payload !== undefined) {
    return bytesOf(verdict.payload);
  }

  const parts = verdict.runs.flatMap((run) => {
    return Array.from({ length: run.times }, () => {
      return bytesOf(run.bytes);
    });
  });

  return Uint8Array.from(parts.flatMap((part) => [...part]));
};

/**
 * The corpus: every verdict's payload, then `size` payloads mutated from `seed`, each from a
 * verdict's of 4 KiB at most, by a bit flipped or a byte set, most often, or a byte inserted or taken
 * out, a run doubled or the payload cut, one to three times.
 */
export const corpusOf = (verdicts, options) => {
  const random = randomOf(options.seed);
  const cases = verdicts.map((verdict) => {
    return { name: verdict.name, message: verdict.message, payload: payloadOf(verdict) };
  });
  const sources = cases.filter((each) => {
    return each.payload.length > 0 && each.payload.length <= 4096;
  });
  const pick = (limit) => {
    return Math.floor(random() * limit);
  };

  for (let index = 0; index < options.size; index += 1) {
    const source = sources[pick(sources.length)];
    const bytes = [...source.payload];

    for (let times = 1 + pick(3); times > 0; times -= 1) {
      const at = pick(Math.max(bytes.length, 1));

      // * a byte's value changed far more often than the records' shape, which most cuts break
      const kind = pick(16);

      if (kind < 7) {
        bytes[at] = (bytes[at] ?? 0) ^ (1 << pick(8));
      } else if (kind < 12) {
        bytes[at] = pick(256);
      } else if (kind < 13) {
        bytes.splice(at, 0, pick(256));
      } else if (kind < 14) {
        bytes.splice(at, 1);
      } else if (kind < 15) {
        bytes.splice(at, 0, ...bytes.slice(at, at + 1 + pick(8)));
      } else {
        bytes.length = at;
      }
    }

    cases.push({
      name: `${source.name}, mutated ${String(index)}`,
      message: source.message,
      payload: Uint8Array.from(bytes),
    });
  }

  return cases;
};

// ── Running ───────────────────────────────────────────────────────────────────

const run = (command, args, options = {}) => {
  const done = spawnSync(command, args, { stdio: 'inherit', ...options });

  if (done.error !== undefined) {
    throw done.error;
  }

  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}: exit ${String(done.status ?? done.signal)}`);
  }
};

// each package of the pin, fetched and unpacked, or as it is when its integrity is the pin's
const fetchOracle = async (pin) => {
  for (const each of pin.packages) {
    const target = join(ORACLE, 'node_modules', ...each.name.split('/'));
    const mark = join(target, '.integrity');

    if (existsSync(mark) && readFileSync(mark, 'utf8') === each.integrity) {
      continue;
    }

    const response = await fetch(each.tarball);

    if (!response.ok) {
      throw new Error(`${each.tarball}: ${String(response.status)} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = integrityOf(bytes);

    // ! nothing of a tarball is read before its integrity is the pin's
    if (actual !== each.integrity) {
      throw new Error(`${each.tarball}: ${actual}, where the pin says ${each.integrity}`);
    }

    const unpacked = join(ORACLE, '.unpacked');

    rmSync(unpacked, { force: true, recursive: true });
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(unpacked, 'package.tgz'), bytes);
    run('tar', ['-xzf', 'package.tgz'], { cwd: unpacked });
    rmSync(target, { force: true, recursive: true });
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(join(unpacked, 'package'), target);
    rmSync(unpacked, { force: true, recursive: true });
    writeFileSync(mark, each.integrity);
  }
};

// spec/validations.proto's set, as the builder's buf builds it
const setOf = () => {
  mkdirSync(WORK, { recursive: true });

  const set = join(WORK, 'validations.binpb');
  // ! spec/validations.proto alone, apart from spec/'s other .proto files: each is a blueprint of
  // its own, whose services may take the same ids
  const apart = join(WORK, 'set');

  rmSync(apart, { force: true, recursive: true });
  mkdirSync(apart, { recursive: true });
  writeFileSync(join(apart, 'validations.proto'), readFileSync(VALIDATIONS_PROTO));
  run(process.execPath, [
    BEADC,
    'blueprint',
    apart,
    '-o',
    join(WORK, 'validations.blueprint.json'),
    '--descriptor-set-out',
    set,
  ]);

  return readFileSync(set);
};

// protovalidate-es and its protobuf-es, as the pin loads them, over the set
const oracleOf = async (set) => {
  const at = (name, entry) => {
    return pathToFileURL(join(ORACLE, 'node_modules', ...name.split('/'), entry)).href;
  };
  const protobuf = await import(at('@bufbuild/protobuf', 'dist/esm/index.js'));
  const wkt = await import(at('@bufbuild/protobuf', 'dist/esm/wkt/index.js'));
  const protovalidate = await import(at('@bufbuild/protovalidate', 'dist/esm/index.js'));
  const registry = protobuf.createFileRegistry(
    protobuf.fromBinary(wkt.FileDescriptorSetSchema, set)
  );
  const validator = protovalidate.createValidator({ registry });

  return (message, payload) => {
    const schema = registry.getMessage(message);
    let read;

    try {
      read = protobuf.fromBinary(schema, payload);
    } catch {
      return undefined;
    }

    const result = validator.validate(schema, read);

    if (result.kind === 'error') {
      return { error: result.error.message };
    }

    const [violations] =
      result.kind === 'valid'
        ? [{ violations: [] }]
        : protovalidate.violationsToProto(result.violations);

    return violations.violations.map((violation) => {
      return {
        ruleId: violation.ruleId,
        elements: elementsOfProto(violation.field),
        forKey: violation.forKey,
        message: violation.message,
      };
    });
  };
};

// beadc's output for `side`, generated over spec/validations.proto into its testee
const generate = (side) => {
  const work = join(WORK, side.language);
  const out = join(ROOT, side.folder, side.generated);

  rmSync(work, { force: true, recursive: true });
  mkdirSync(join(work, 'proto'), { recursive: true });
  writeFileSync(join(work, 'proto', 'validations.proto'), readFileSync(VALIDATIONS_PROTO));
  rmSync(out, { force: true, recursive: true });
  writeFileSync(
    join(work, 'beadc.yaml'),
    [
      'version: 1',
      'source:',
      '  proto: [proto]',
      'outputs:',
      ...(side.language === 'typescript'
        ? [
            '  - language: typescript',
            '    out: generated',
            '    importExtension: ts',
            `    runtime: ${side.runtime}`,
            `    protoRuntime: ${side.protoRuntime}`,
          ]
        : ['  - language: csharp', '    out: generated']),
      '',
    ].join('\n')
  );
  run(process.execPath, [BEADC, 'generate'], {
    cwd: work,
    env: {
      ...process.env,
      BEADC_PROTOC:
        process.env.BEADC_PROTOC ??
        execFileSync(process.execPath, [FETCH_PROTOC], { encoding: 'utf8' }).trim(),
    },
  });
  rmSync(out, { force: true, recursive: true });
  renameSync(join(work, 'generated'), out);
};

// the testee of `side`, its cases a line each in, a line each out
const testeeOf = (side) => {
  const folder = join(ROOT, side.folder);

  if (side.language === 'typescript') {
    return (input) => {
      return spawnSync(process.execPath, ['testee.ts'], {
        cwd: folder,
        input,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 1024,
      });
    };
  }

  run('dotnet', ['build', '--configuration', 'Release', '--nologo'], { cwd: folder });

  return (input) => {
    return spawnSync('dotnet', ['run', '--configuration', 'Release', '--no-build'], {
      cwd: folder,
      input,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
    });
  };
};

const main = async () => {
  const [mode] = process.argv.slice(2);
  const pin = readPin(readFileSync(PIN_FILE, 'utf8'));
  const { verdicts } = JSON.parse(readFileSync(VALIDATIONS, 'utf8'));
  const excluded = new Set(pin.excluded);
  const kept = verdicts.filter((verdict) => {
    return !excluded.has(verdict.name);
  });

  await fetchOracle(pin);

  const oracle = await oracleOf(setOf());
  const partings = [];

  if (mode === 'oracle') {
    // * a verdict judged whole: one under a bound or failFast holds what Bead's sink keeps, which
    // protovalidate-es knows nothing of
    const whole = kept.filter((verdict) => {
      return verdict.maximumBytes === undefined && verdict.failFast === undefined;
    });

    for (const verdict of whole) {
      const theirs = oracle(verdict.message, payloadOf(verdict));
      const ours = verdict.violations.map((violation) => {
        return { ...violation, elements: elementsOfPath(violation.fieldPath) };
      });

      if (
        theirs === undefined ||
        'error' in theirs ||
        JSON.stringify(comparableOf(theirs)) !== JSON.stringify(comparableOf(ours))
      ) {
        partings.push({
          name: verdict.name,
          theirs: theirs === undefined || 'error' in theirs ? theirs : comparableOf(theirs),
          ours: comparableOf(ours),
        });
      }
    }
  } else if (mode === 'typescript' || mode === 'csharp') {
    const side = SIDES[mode];

    generate(side);

    const cases = corpusOf(kept, pin.corpus).flatMap((each) => {
      const theirs = oracle(each.message, each.payload);

      return theirs === undefined || 'error' in theirs ? [] : [{ ...each, theirs }];
    });
    const input = cases
      .map((each) => {
        return JSON.stringify({
          message: each.message,
          payload: Buffer.from(each.payload).toString('base64'),
        });
      })
      .join('\n');
    const done = testeeOf(side)(`${input}\n`);

    if (done.status !== 0) {
      throw new Error(`the ${mode} testee: exit ${String(done.status)}\n${done.stderr}`);
    }

    const lines = done.stdout.split('\n').filter((line) => {
      return line !== '';
    });
    let refused = 0;

    if (lines.length !== cases.length) {
      throw new Error(
        `the ${mode} testee answered ${String(lines.length)} of ${String(cases.length)}`
      );
    }

    cases.forEach((each, at) => {
      const answer = JSON.parse(lines[at]);

      if (answer.refused === true) {
        refused += 1;
        return;
      }

      const ours = answer.violations.map((violation) => {
        return { ...violation, elements: elementsOfPath(violation.fieldPath) };
      });

      if (JSON.stringify(comparableOf(each.theirs)) !== JSON.stringify(comparableOf(ours))) {
        partings.push({
          name: each.name,
          theirs: comparableOf(each.theirs),
          ours: comparableOf(ours),
        });
      }
    });

    console.log(
      `protovalidate-differential: ${String(cases.length)} cases through the ${mode} side, ${String(refused)} its library does not read`
    );
  } else {
    throw new Error('usage: node tools/protovalidate-differential.mjs oracle|typescript|csharp');
  }

  for (const parting of partings.slice(0, 20)) {
    console.error(`parts: ${parting.name}`);
    console.error(`  protovalidate-es: ${JSON.stringify(parting.theirs).slice(0, 2000)}`);
    console.error(`  Bead:             ${JSON.stringify(parting.ours).slice(0, 2000)}`);
  }

  if (partings.length > 0) {
    throw new Error(`${String(partings.length)} cases part`);
  }

  console.log(`protovalidate-differential: ${mode}, no case parts`);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`protovalidate-differential: ${error.message}\n`);
    process.exit(1);
  });
}
