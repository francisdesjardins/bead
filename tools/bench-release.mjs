#!/usr/bin/env node
// Fresh-process release measurements. JSON goes to stdout or --output; progress goes to stderr.

import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNTIMES, medianOf, validate } from './bench-compare.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
  throw new Error(message);
};

const processesOf = (reports, warmup) => {
  const first = reports[0];
  const identities = new Map(
    first.measures.map((row) => {
      return [
        row.id,
        [row.name, row.scenario, row.transport, row.sizeBytes, row.unit, row.direction],
      ];
    })
  );
  return reports.map((report) => {
    const measurements = validate(report);
    if (report.schema !== 'bead-bench/1') {
      fail('each fresh process must report bead-bench/1');
    }
    if (
      report.side !== first.side ||
      !isDeepStrictEqual(report.environment, first.environment) ||
      !isDeepStrictEqual(report.method, first.method)
    ) {
      fail('processes differ in side, environment, commit, runtimes or method');
    }
    if (report.method.runs <= warmup) {
      fail('warmup must leave at least one recorded run');
    }
    if (
      measurements.size !== identities.size ||
      report.measures.some((row) => {
        return !isDeepStrictEqual(identities.get(row.id), [
          row.name,
          row.scenario,
          row.transport,
          row.sizeBytes,
          row.unit,
          row.direction,
        ]);
      })
    ) {
      fail('processes differ in measurement IDs or units');
    }
    return measurements;
  });
};

export const merge = (reports, options = {}) => {
  const warmup = options.warmup ?? 1;
  if (!Number.isSafeInteger(warmup) || warmup < 0 || reports.length < 5) {
    fail('merge requires at least 5 processes and a nonnegative integer warmup');
  }
  const first = reports[0];
  const rows = processesOf(reports, warmup);
  const measures = first.measures.map((row) => {
    const processes = rows.map((measurements) => {
      const next = measurements.get(row.id);
      if (
        !next ||
        ['name', 'scenario', 'transport', 'sizeBytes', 'unit', 'direction'].some((key) => {
          return row[key] !== next[key];
        })
      ) {
        fail(`missing or incompatible process measurement: ${row.id}`);
      }
      return next.samples.slice(warmup);
    });
    const medians = processes.map(medianOf);
    const { samples: _samples, ...identity } = row;
    return {
      ...identity,
      processes,
      warmups: rows.map((measurements) => {
        return measurements.get(row.id).samples.slice(0, warmup);
      }),
      medians,
      median: medianOf(medians),
      min: Math.min(...medians),
      max: Math.max(...medians),
    };
  });
  if (
    rows.some((measurements) => {
      return measurements.size !== measures.length;
    })
  ) {
    fail('processes differ in measurement IDs');
  }
  const result = {
    schema: 'bead-bench/2',
    side: first.side,
    environment: first.environment,
    method: {
      ...first.method,
      processes: reports.length,
      runs: first.method.runs - warmup,
      warmup,
    },
    measures,
  };
  validate(result);
  return result;
};

export const parse = (args) => {
  const options = { side: args[0], processes: 5, runs: 2, seconds: 3, transcoding: false };
  if (!Object.hasOwn(RUNTIMES, options.side ?? '')) {
    fail(
      'usage: node tools/bench-release.mjs typescript|csharp|rust [--tree baseline-checkout --baseline-output baseline.json] [--output candidate.json] [--processes 5] [--runs 2] [--seconds 3] [--transcoding] [--filter id-or-name]'
    );
  }
  const seen = new Set();
  for (let at = 1; at < args.length; at++) {
    const flag = args[at];
    if (seen.has(flag)) {
      fail(`duplicate argument: ${flag}`);
    }
    seen.add(flag);
    if (flag === '--transcoding') {
      options.transcoding = true;
    } else if (['--processes', '--runs', '--seconds'].includes(flag)) {
      const value = Number(args[++at]);
      if (!Number.isSafeInteger(value) || value < (flag === '--processes' ? 5 : 1)) {
        fail(`${flag} requires an integer of at least ${flag === '--processes' ? 5 : 1}`);
      }
      options[flag.slice(2)] = value;
    } else if (['--tree', '--output', '--baseline-output', '--filter'].includes(flag)) {
      const value = args[++at];
      if (!value || value.startsWith('--')) {
        fail(`${flag} requires a value`);
      }
      options[flag === '--baseline-output' ? 'baselineOutput' : flag.slice(2)] = value;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  if (Boolean(options.tree) !== Boolean(options.baselineOutput)) {
    fail('--tree and --baseline-output are required together');
  }
  if (
    options.output &&
    options.baselineOutput &&
    resolve(options.output) === resolve(options.baselineOutput)
  ) {
    fail('baseline and candidate output paths must differ');
  }
  return options;
};

const execute = (command, args, options) => {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, BEAD_BENCH_INTEROP_BUILT: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (options.build) {
        process.stderr.write(chunk);
      } else {
        output += chunk;
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed (${signal ?? code})`));
      } else {
        resolveRun(output);
      }
    });
  });
};

// each side's bench, by the source that says whether it takes a --filter
const SOURCES = Object.freeze({
  typescript: 'implementations/typescript/tools/bench.mjs',
  csharp: 'implementations/dotnet/tools/Bead.Benchmarks/Program.cs',
  rust: 'implementations/rust/benches/src/main.rs',
});

const sourceOf = (tree, side) => {
  return join(tree, SOURCES[side]);
};

// ! A filter reaches the benches only when every one takes it, so that a measure meets the same
// phases before it in each tree, its warm-up among them: a bench run whole against one that ran
// its measure cold compares the warm-up, not the code. Otherwise every tree runs whole, and the
// collection selects the filter's measures in each report.
export const level = (filters, options) => {
  if (!options.filter || filters.every(Boolean)) {
    return options;
  }
  console.error(`a bench has no --filter; every tree runs whole, then selects ${options.filter}`);
  return { ...options, filter: undefined };
};

// a bench's command and its arguments, the measures' own after the side's
const finished = (command, args, options, filtered) => {
  const measured = [
    ...args,
    '--runs',
    String(options.runs + 1),
    '--seconds',
    String(options.seconds),
    '--json',
  ];
  if (options.transcoding) {
    measured.push('--transcoding');
  }
  if (options.filter && filtered) {
    measured.push('--filter', options.filter);
  }
  return { command, args: measured };
};

const prepare = async (tree, options) => {
  const dotnet = join(tree, 'implementations/dotnet');
  const source = sourceOf(tree, options.side);
  const filtered = readFileSync(source, 'utf8').includes('--filter');
  let command = process.execPath;
  let args = ['--expose-gc', source];
  if (options.side === 'rust') {
    // * bead-bench, the Rust side's in-memory bench, built once in release, then each fresh process
    // runs what cargo built, by its lock
    const rust = join(tree, 'implementations/rust');
    const manifest = ['--manifest-path', 'benches/Cargo.toml', '--release', '--locked'];
    await execute('cargo', ['build', ...manifest], { cwd: rust, build: true });
    command = 'cargo';
    args = ['run', '--quiet', ...manifest, '--'];
    return { tree: rust, ...finished(command, args, options, filtered) };
  }
  if (options.side === 'csharp') {
    await execute('dotnet', ['build', '-c', 'Release', 'tools/Bead.Benchmarks'], {
      cwd: dotnet,
      build: true,
    });
    const target = await execute(
      'dotnet',
      [
        'msbuild',
        'tools/Bead.Benchmarks',
        '-getProperty:TargetPath',
        '-property:Configuration=Release',
      ],
      { cwd: dotnet }
    );
    command = 'dotnet';
    args = [target.trim()];
  } else if (
    !options.transcoding &&
    (!options.filter || options.filter.startsWith('interop.') || options.filter.startsWith('call.'))
  ) {
    await execute('dotnet', ['build', '-c', 'Release', 'interop/Bead.Interop.Server'], {
      cwd: dotnet,
      build: true,
    });
  }
  return { tree, ...finished(command, args, options, filtered) };
};

// * Alternate the trees process by process, in ABBA order: baseline then candidate, then candidate
// then baseline, so neither always runs second, after the other has warmed the machine. No report
// is published on a failure.
export const collect = async (trees, options) => {
  const reports = trees.map(() => {
    return [];
  });
  for (let processIndex = 0; processIndex < options.processes; processIndex++) {
    const order = trees.map((_, treeIndex) => {
      return processIndex % 2 === 0 ? treeIndex : trees.length - 1 - treeIndex;
    });
    for (const treeIndex of order) {
      const tree = trees[treeIndex];
      const report = await options.run(tree, processIndex);
      validate(report);
      if (options.filter) {
        report.measures = report.measures.filter((row) => {
          return row.id === options.filter || row.name === options.filter;
        });
        if (report.measures.length === 0) {
          fail(`filter matches no measurement: ${options.filter}`);
        }
        report.method = { ...report.method, filter: options.filter };
      }
      reports[treeIndex].push(report);
      // Refuse a mixed process as soon as it arrives, before spending the rest of the run.
      processesOf(reports[treeIndex], 1);
      for (const row of report.measures) {
        console.error(
          `${tree.tree ?? tree} process ${processIndex + 1}/${options.processes} ${row.id}: ${medianOf(row.samples.slice(1))} ${row.unit}`
        );
      }
    }
  }
  return reports.map((processes) => {
    return merge(processes);
  });
};

export const main = async (args) => {
  try {
    const options = parse(args);
    for (const output of [options.output, options.baselineOutput]) {
      if (output) {
        mkdirSync(dirname(resolve(output)), { recursive: true });
      }
    }
    const roots = options.tree ? [resolve(options.tree), ROOT] : [ROOT];
    const leveled = level(
      roots.map((root) => {
        return readFileSync(sourceOf(root, options.side), 'utf8').includes('--filter');
      }),
      options
    );
    const trees = [];
    for (const root of roots) {
      trees.push(await prepare(root, leveled));
    }
    const reports = await collect(trees, {
      ...options,
      run: async (tree) => {
        return JSON.parse(await execute(tree.command, tree.args, { cwd: tree.tree }));
      },
    });
    if (options.tree) {
      writeFileSync(options.baselineOutput, `${JSON.stringify(reports[0], null, 2)}\n`);
    }
    const json = `${JSON.stringify(reports.at(-1), null, 2)}\n`;
    if (options.output) {
      writeFileSync(options.output, json);
    } else {
      process.stdout.write(json);
    }
    return 0;
  } catch (error) {
    console.error(`bench-release: ${error.message}`);
    return 2;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
