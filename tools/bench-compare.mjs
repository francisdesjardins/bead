#!/usr/bin/env node
// Compare bead-bench/1 and /2 reports. Exit 0 for a comparison, 1 for an advisory regression,
// and 2 for invalid input. The README defines the format and the threshold selectors.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => {
  throw new Error(message);
};
const text = (value) => {
  return typeof value === 'string' && value.length > 0;
};
const positiveInteger = (value) => {
  return Number.isSafeInteger(value) && value > 0;
};

export const medianOf = (values) => {
  const sorted = values.toSorted((a, b) => {
    return a - b;
  });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const close = (a, b) => {
  return Number.isFinite(a) && Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-12;
};

export const mediansOf = (report, row) => {
  return report.schema === 'bead-bench/2' ? row.medians : [row.median];
};

// * Each labeling of the pooled observations has equal probability. Doubled midranks keep
// ties exact; dynamic enumeration counts every split, including equal-valued observations.
const distributions = new Map();
export const mannWhitney = (baseline, candidate, { direction = 'lower' } = {}) => {
  const pooled = [...baseline, ...candidate].toSorted((a, b) => {
    return a - b;
  });
  const ranks = [];
  for (let at = 0; at < pooled.length;) {
    let end = at + 1;
    while (end < pooled.length && pooled[end] === pooled[at]) {
      end++;
    }
    ranks.push(...Array(end - at).fill(at + 1 + end));
    at = end;
  }
  const count = candidate.length;
  const key = `${count}:${ranks.join(',')}`;
  let distribution = distributions.get(key);
  if (!distribution) {
    const sums = Array.from({ length: count + 1 }, () => {
      return new Map();
    });
    sums[0].set(0, 1n);
    for (const rank of ranks) {
      for (let chosen = count; chosen > 0; chosen--) {
        for (const [sum, ways] of sums[chosen - 1]) {
          sums[chosen].set(sum + rank, (sums[chosen].get(sum + rank) ?? 0n) + ways);
        }
      }
    }
    distribution = sums[count];
    distributions.set(key, distribution);
  }
  let u = 0;
  for (const next of candidate) {
    for (const before of baseline) {
      u += next === before ? 0.5 : (direction === 'lower' ? next > before : next < before) ? 1 : 0;
    }
  }
  let tail = 0n;
  let total = 0n;
  for (const [sum, ways] of distribution) {
    const highU = (sum - count * (count + 1)) / 2;
    const rankedU = direction === 'lower' ? highU : baseline.length * count - highU;
    total += ways;
    if (rankedU >= u) {
      tail += ways;
    }
  }
  return { u, p: Number(tail) / Number(total) };
};

export const hodgesLehmann = (baseline, candidate) => {
  const changes = candidate.flatMap((next) => {
    return baseline.map((before) => {
      return before === 0 ? (next === 0 ? 0 : Infinity) : ((next - before) / before) * 100;
    });
  });
  return medianOf(changes);
};

// The infimum rank-significant effect under a multiplicative shift of the observed spreads.
// It describes resolution at these samples, not power under an assumed population model.
export const smallestDetectableChange = (baseline, candidate, { direction = 'lower' } = {}) => {
  if (
    [...baseline, ...candidate].some((value) => {
      return value <= 0;
    })
  ) {
    return null;
  }
  const ratio = 1 + hodgesLehmann(baseline, candidate) / 100;
  const normalized = candidate.map((value) => {
    return value / ratio;
  });
  const boundaries = [
    ...new Set([
      1,
      ...baseline.flatMap((before) => {
        return normalized.map((next) => {
          return before / next;
        });
      }),
    ]),
  ]
    .filter((value) => {
      return direction === 'lower' ? value >= 1 : value <= 1;
    })
    .sort((a, b) => {
      return direction === 'lower' ? a - b : b - a;
    });
  for (let at = 0; at < boundaries.length; at++) {
    const boundary = boundaries[at];
    const beyond = boundaries[at + 1] ?? (direction === 'lower' ? boundary * 2 : boundary / 2);
    for (const multiplier of [boundary, (boundary + beyond) / 2]) {
      const shifted = normalized.map((value) => {
        return value * multiplier;
      });
      if (mannWhitney(baseline, shifted, { direction }).p <= 0.05) {
        return Math.abs(boundary - 1) * 100;
      }
    }
  }
  return null;
};

// each side a bench reports, and the runtimes its report names: the TypeScript and C# benches run
// the interop against each other, the Rust side's its in-memory bench alone (decision 0036)
export const RUNTIMES = Object.freeze({
  typescript: Object.freeze(['node', 'v8', 'dotnet']),
  csharp: Object.freeze(['node', 'v8', 'dotnet']),
  rust: Object.freeze(['rustc']),
});

export const validate = (report) => {
  if (
    !['bead-bench/1', 'bead-bench/2'].includes(report?.schema) ||
    !Object.hasOwn(RUNTIMES, report.side ?? '')
  ) {
    fail('expected bead-bench/1 or /2 and a typescript, csharp or rust side');
  }
  const { environment: env, method } = report;
  if (
    !text(env?.cpu?.model) ||
    !positiveInteger(env.cpu.count) ||
    !['platform', 'release', 'architecture'].every((key) => {
      return text(env?.os?.[key]);
    }) ||
    !RUNTIMES[report.side].every((key) => {
      return text(env?.runtimes?.[key]);
    }) ||
    !/^[a-f\d]{40,64}$/u.test(env?.commit ?? '')
  ) {
    fail('report requires CPU, OS, runtime versions and a commit');
  }
  if (
    ![
      'runs',
      'seconds',
      'concurrency',
      'notificationIntervalMs',
      'notificationWindow',
      'memoryCalls',
    ].every((key) => {
      return positiveInteger(method?.[key]);
    }) ||
    !['method', 'scope', 'limitations'].every((key) => {
      return text(method?.memory?.[key]);
    }) ||
    !text(method.transfer) ||
    !text(method.interop)
  ) {
    fail('report requires its run and measurement methods');
  }
  const merged = report.schema === 'bead-bench/2';
  if (
    merged &&
    (!positiveInteger(method.processes) ||
      !Number.isSafeInteger(method.warmup) ||
      method.warmup < 0)
  ) {
    fail('merged report requires processes and warmup');
  }
  if (!Array.isArray(report.measures) || report.measures.length === 0) {
    fail('report requires measurements');
  }
  const rows = new Map();
  for (const row of report.measures) {
    if (
      !text(row?.name) ||
      !['local', 'interop'].includes(row.scenario) ||
      !['none', 'http', 'websocket', 'memory'].includes(row.transport) ||
      !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 0 ||
      ![
        'ns',
        'us',
        'ms',
        'calls/s',
        'exchanges/s',
        'notifications/s',
        'MiB/s',
        'B/call',
        'B/exchange',
      ].includes(row.unit) ||
      row.direction !== (row.unit.endsWith('/s') ? 'higher' : 'lower') ||
      row.id !== `${row.scenario}.${row.transport}.${row.sizeBytes}.${row.name}`
    ) {
      fail('invalid measurement identity, unit or direction');
    }
    if (rows.has(row.id)) {
      fail(`duplicate measurement: ${row.id}`);
    }
    const samples = merged ? row.medians : row.samples;
    if (
      merged &&
      (!Array.isArray(row.processes) ||
        row.processes.length !== method.processes ||
        !row.processes.every((runs, index) => {
          return (
            Array.isArray(runs) &&
            runs.length === method.runs &&
            runs.every((value) => {
              return Number.isFinite(value) && value >= 0;
            }) &&
            close(row.medians?.[index], medianOf(runs))
          );
        }))
    ) {
      fail(`invalid processes or medians: ${row.id}`);
    }
    if (
      merged &&
      row.warmups !== undefined &&
      (!Array.isArray(row.warmups) ||
        row.warmups.length !== method.processes ||
        !row.warmups.every((runs) => {
          return (
            Array.isArray(runs) &&
            runs.length === method.warmup &&
            runs.every((value) => {
              return Number.isFinite(value) && value >= 0;
            })
          );
        }))
    ) {
      fail(`invalid warmups: ${row.id}`);
    }
    if (
      !Array.isArray(samples) ||
      samples.length !== (merged ? method.processes : method.runs) ||
      !samples.every(Number.isFinite) ||
      ![row.min, row.median, row.max].every(Number.isFinite)
    ) {
      fail(`invalid samples or statistics: ${row.id}`);
    }
    const sorted = samples.toSorted((a, b) => {
      return a - b;
    });
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    if (
      !close(row.min, sorted[0]) ||
      !close(row.max, sorted.at(-1)) ||
      !close(row.median, median) ||
      row.min < 0
    ) {
      fail(`statistics disagree with samples: ${row.id}`);
    }
    rows.set(row.id, row);
  }
  return rows;
};

export const thresholdsOf = (values) => {
  const thresholds = new Map();
  for (const value of values) {
    const match = /^(?:(.+)=)?(\d+(?:\.\d+)?)%$/u.exec(value);
    if (!match || !Number.isFinite(Number(match[2]))) {
      fail(`invalid threshold: ${value}; expected 25% or selector=25%`);
    }
    const selector = match[1] ?? '*';
    if (thresholds.has(selector)) {
      fail(`duplicate threshold: ${selector}`);
    }
    thresholds.set(selector, Number(match[2]));
  }
  return thresholds;
};

export const compare = (baseline, candidate, thresholds = new Map()) => {
  const before = validate(baseline);
  const after = validate(candidate);
  if (
    thresholds.size > 0 &&
    [baseline, candidate].some((report) => {
      return (report.schema === 'bead-bench/2' ? report.method.processes : 1) < 5;
    })
  ) {
    fail('a threshold verdict requires at least 5 processes per side; re-bench the baseline');
  }
  const selectors = new Set(['*']);
  const rows = [];
  for (const [id, row] of before) {
    const next = after.get(id);
    if (!next || next.unit !== row.unit || next.direction !== row.direction) {
      fail(`missing or incompatible measurement: ${id}`);
    }
    selectors.add(id);
    selectors.add(row.name);
    const baseMedians = mediansOf(baseline, row);
    const nextMedians = mediansOf(candidate, next);
    const change = hodgesLehmann(baseMedians, nextMedians);
    const regression = row.direction === 'higher' ? -change : change;
    const threshold = thresholds.get(id) ?? thresholds.get(row.name) ?? thresholds.get('*');
    const { u, p } = mannWhitney(baseMedians, nextMedians, { direction: row.direction });
    const verdict =
      threshold !== undefined && regression > threshold
        ? p <= 0.05
          ? 'regression'
          : 'inconclusive'
        : 'ok';
    rows.push({
      id,
      unit: row.unit,
      before: row.median,
      after: next.median,
      change,
      regression,
      threshold,
      u,
      p,
      baseMedians,
      nextMedians,
      smallestDetectableChange: smallestDetectableChange(baseMedians, nextMedians, {
        direction: row.direction,
      }),
      verdict,
      failed: verdict === 'regression',
    });
  }
  // a measure the candidate adds has no baseline yet: listed, never judged; one it drops is an error
  for (const [id, next] of after) {
    if (!before.has(id)) {
      rows.push({ id, unit: next.unit, after: next.median, added: true, failed: false });
    }
  }
  for (const selector of thresholds.keys()) {
    if (!selectors.has(selector)) {
      fail(`threshold matches no measurement: ${selector}`);
    }
  }
  return rows;
};

export const main = (args) => {
  try {
    const files = [];
    const thresholds = [];
    for (let at = 0; at < args.length; at++) {
      if (args[at] === '--threshold') {
        thresholds.push(args[++at] ?? '');
      } else if (args[at].startsWith('--')) {
        fail(`unknown argument: ${args[at]}`);
      } else {
        files.push(args[at]);
      }
    }
    if (files.length !== 2) {
      fail(
        'usage: node tools/bench-compare.mjs baseline.json candidate.json [--threshold 25%] [--threshold selector=25%]'
      );
    }
    const reports = files.map((file) => {
      return JSON.parse(readFileSync(file, 'utf8'));
    });
    const rows = compare(reports[0], reports[1], thresholdsOf(thresholds));
    console.log(
      `${reports[0].side} ${reports[0].environment.commit} -> ${reports[1].side} ${reports[1].environment.commit}`
    );
    if (reports[0].method.memory.method !== reports[1].method.memory.method) {
      console.log(
        `Allocation counters: ${reports[0].method.memory.method} -> ${reports[1].method.memory.method}; each report states its heap scope and exclusions.`
      );
    }
    console.log(
      '| measure | unit | baseline | candidate | HL change | U | one-sided p | smallest detectable change | threshold | result |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const row of rows) {
      console.log(
        row.added
          ? `| ${row.id} | ${row.unit} | | ${row.after.toFixed(3)} | | | | | | new |`
          : `| ${row.id} | ${row.unit} | ${row.before.toFixed(3)} | ${row.after.toFixed(3)} | ${row.change.toFixed(2)}% | ${row.u} | ${row.p.toPrecision(4)} | ${row.smallestDetectableChange === null ? 'unavailable' : `${row.smallestDetectableChange.toFixed(2)}%`} | ${row.threshold === undefined ? '' : `${row.threshold}%`} | ${row.verdict} |`
      );
    }
    for (const row of rows) {
      if (row.added) {
        continue;
      }
      console.log(
        `${row.id} process medians: baseline [${row.baseMedians.join(', ')}]; candidate [${row.nextMedians.join(', ')}]`
      );
    }
    return rows.some((row) => {
      return row.failed;
    })
      ? 1
      : 0;
  } catch (error) {
    console.error(`bench-compare: ${error.message}`);
    return 2;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
