#!/usr/bin/env node
// Compare bead-bench/1 reports. Exit 0 for a comparison within its thresholds, 1 for a regression,
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

export const validate = (report) => {
  if (report?.schema !== 'bead-bench/1' || !['typescript', 'csharp'].includes(report.side)) {
    fail('expected bead-bench/1 and a typescript or csharp side');
  }
  const { environment: env, method } = report;
  if (
    !text(env?.cpu?.model) ||
    !positiveInteger(env.cpu.count) ||
    !['platform', 'release', 'architecture'].every((key) => {
      return text(env?.os?.[key]);
    }) ||
    !['node', 'v8', 'dotnet'].every((key) => {
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
  if (!Array.isArray(report.measures) || report.measures.length === 0) {
    fail('report requires measurements');
  }
  const rows = new Map();
  for (const row of report.measures) {
    if (
      !text(row?.name) ||
      !['local', 'interop'].includes(row.scenario) ||
      !['none', 'http', 'websocket'].includes(row.transport) ||
      !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 0 ||
      !['ns', 'us', 'ms', 'calls/s', 'notifications/s', 'MiB/s', 'B/call'].includes(row.unit) ||
      row.direction !== (row.unit.endsWith('/s') ? 'higher' : 'lower') ||
      row.id !== `${row.scenario}.${row.transport}.${row.sizeBytes}.${row.name}`
    ) {
      fail('invalid measurement identity, unit or direction');
    }
    if (rows.has(row.id)) {
      fail(`duplicate measurement: ${row.id}`);
    }
    if (
      !Array.isArray(row.samples) ||
      row.samples.length !== method.runs ||
      !row.samples.every(Number.isFinite) ||
      ![row.min, row.median, row.max].every(Number.isFinite)
    ) {
      fail(`invalid samples or statistics: ${row.id}`);
    }
    const sorted = row.samples.toSorted((a, b) => {
      return a - b;
    });
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    const close = (a, b) => {
      return Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-12;
    };
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
  const selectors = new Set(['*']);
  const rows = [];
  for (const [id, row] of before) {
    const next = after.get(id);
    if (!next || next.unit !== row.unit || next.direction !== row.direction) {
      fail(`missing or incompatible measurement: ${id}`);
    }
    selectors.add(id);
    selectors.add(row.name);
    const delta = next.median - row.median;
    // Zero baselines have an unbounded relative change, except when both values are zero.
    const change =
      row.median === 0
        ? delta === 0
          ? 0
          : Math.sign(delta) * Infinity
        : (delta / Math.abs(row.median)) * 100;
    const regression = row.direction === 'higher' ? -change : change;
    const threshold = thresholds.get(id) ?? thresholds.get(row.name) ?? thresholds.get('*');
    rows.push({
      id,
      unit: row.unit,
      before: row.median,
      after: next.median,
      change,
      regression,
      threshold,
      failed: threshold !== undefined && regression > threshold,
    });
  }
  if (before.size !== after.size) {
    fail('reports have different measurement sets');
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
      '| measure | unit | baseline | candidate | change | threshold | result |\n| --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const row of rows) {
      console.log(
        `| ${row.id} | ${row.unit} | ${row.before.toFixed(3)} | ${row.after.toFixed(3)} | ${row.change.toFixed(2)}% | ${row.threshold === undefined ? '' : `${row.threshold}%`} | ${row.failed ? 'regression' : 'ok'} |`
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
