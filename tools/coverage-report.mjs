#!/usr/bin/env node
/**
 * What the tests leave unrun, file by file, whatever wrote the report.
 *
 * Bead is measured twice: c8 writes an istanbul `coverage-final.json` for the TypeScript side, and
 * `dotnet test --coverage` writes one cobertura XML per test project for the C# side. This reads
 * any number of either, merges what they say of the same file — a line is run when any report ran
 * it — and prints each file's lines and branches run, then the lines no report ran, and the lines
 * whose branches ran only in part, so a gap reads the same on both sides.
 *
 *   node tools/coverage-report.mjs <report>... [--under <path>]...
 *
 * `--under` keeps the files below a path, relative to the repository; given several times, below
 * any of them.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each file's lines: whether a report ran each, and its branches run of all. */
const files = new Map();

const fileOf = (path) => {
  const name = relative(root, path).replaceAll('\\', '/');

  if (!files.has(name)) {
    files.set(name, { branches: new Map(), lines: new Map() });
  }

  return files.get(name);
};

/** A line seen run or not; once run in any report, it stays run. */
const markLine = (file, { isRun, line }) => {
  file.lines.set(line, (file.lines.get(line) ?? false) || isRun);
};

/** A line's branches, the most a report ran of them. */
const markBranches = (file, { covered, line, total }) => {
  const known = file.branches.get(line);

  file.branches.set(line, {
    covered: Math.max(known?.covered ?? 0, covered),
    total: Math.max(known?.total ?? 0, total),
  });
};

/** A cobertura report: each `<line>` under the `<class>` that names its file. */
const readCobertura = (text) => {
  let file;

  for (const [tag] of text.matchAll(/<class\b[^>]*>|<line\b[^>]*>/g)) {
    if (tag.startsWith('<class')) {
      const filename = /filename="([^"]+)"/.exec(tag)?.[1];

      file = filename === undefined ? undefined : fileOf(filename);
      continue;
    }

    const number = Number(/number="(\d+)"/.exec(tag)?.[1]);
    const hits = Number(/hits="(\d+)"/.exec(tag)?.[1]);
    const condition = /condition-coverage="[^(]*\((\d+)\/(\d+)\)"/.exec(tag);

    if (file === undefined || Number.isNaN(number)) {
      continue;
    }

    markLine(file, { isRun: hits > 0, line: number });

    if (condition !== null) {
      markBranches(file, {
        covered: Number(condition[1]),
        line: number,
        total: Number(condition[2]),
      });
    }
  }
};

/** An istanbul report: a line is run when a statement on it ran; each branch path counted. */
const readIstanbul = (text) => {
  for (const [path, entry] of Object.entries(JSON.parse(text))) {
    const file = fileOf(path);

    for (const [id, location] of Object.entries(entry.statementMap)) {
      for (let line = location.start.line; line <= location.end.line; line += 1) {
        markLine(file, { isRun: entry.s[id] > 0, line });
      }
    }

    for (const [id, branch] of Object.entries(entry.branchMap)) {
      const counts = entry.b[id];

      markBranches(file, {
        covered: counts.filter((count) => {
          return count > 0;
        }).length,
        line: branch.loc?.start.line ?? branch.locations[0].start.line,
        total: counts.length,
      });
    }
  }
};

/** Line numbers as ranges: 3, 4, 5, 9 reads 3-5, 9. */
const rangesOf = (lines) => {
  const ranges = [];

  for (const line of lines) {
    const last = ranges.at(-1);

    if (last !== undefined && line === last[1] + 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }

  return ranges
    .map(([start, end]) => {
      return start === end ? String(start) : `${String(start)}-${String(end)}`;
    })
    .join(', ');
};

const percentOf = (part, whole) => {
  return whole === 0 ? '100.0' : ((100 * part) / whole).toFixed(1);
};

const reports = [];
const unders = [];

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--under') {
    unders.push(process.argv[(index += 1)]);
  } else {
    reports.push(process.argv[index]);
  }
}

if (reports.length === 0) {
  console.error('coverage-report: name a report, a cobertura .xml or an istanbul .json.');
  process.exit(1);
}

for (const report of reports) {
  const text = readFileSync(report, 'utf8');

  if (report.endsWith('.xml')) {
    readCobertura(text);
  } else {
    readIstanbul(text);
  }
}

const kept = [...files.entries()].filter(([name]) => {
  return (
    unders.length === 0 ||
    unders.some((under) => {
      return name.startsWith(under);
    })
  );
});
const totals = { branches: 0, branchesRun: 0, lines: 0, linesRun: 0 };
const rows = kept.map(([name, file]) => {
  const unrun = [...file.lines.entries()]
    .filter(([, isRun]) => {
      return !isRun;
    })
    .map(([line]) => {
      return line;
    })
    .toSorted((first, second) => {
      return first - second;
    });
  const branches = [...file.branches.values()];
  const branchesRun = branches.reduce((sum, { covered }) => {
    return sum + covered;
  }, 0);
  const branchesAll = branches.reduce((sum, { total }) => {
    return sum + total;
  }, 0);

  totals.lines += file.lines.size;
  totals.linesRun += file.lines.size - unrun.length;
  totals.branches += branchesAll;
  totals.branchesRun += branchesRun;

  // a line that ran, some of its branches not: a line unrun says so already
  const short = [...file.branches.entries()]
    .filter(([line, { covered, total }]) => {
      return covered < total && file.lines.get(line) === true;
    })
    .toSorted(([first], [second]) => {
      return first - second;
    })
    .map(([line, { covered, total }]) => {
      return `${String(line)} (${String(covered)}/${String(total)})`;
    });

  return { branchesAll, branchesRun, lines: file.lines.size, name, short, unrun };
});

for (const row of rows.toSorted((first, second) => {
  return second.unrun.length - first.unrun.length || first.name.localeCompare(second.name);
})) {
  const lines = percentOf(row.lines - row.unrun.length, row.lines);
  const branches = percentOf(row.branchesRun, row.branchesAll);
  const gaps = row.unrun.length === 0 ? '' : `  unrun: ${rangesOf(row.unrun)}`;
  const partial = row.short.length === 0 ? '' : `  in part: ${row.short.join(', ')}`;

  console.log(
    `${lines.padStart(5)}% lines  ${branches.padStart(5)}% branches  ${row.name}${gaps}${partial}`
  );
}

console.log(
  `\n${String(rows.length)} files: ${percentOf(totals.linesRun, totals.lines)}% of ${String(totals.lines)} lines, ${percentOf(totals.branchesRun, totals.branches)}% of ${String(totals.branches)} branches.`
);
