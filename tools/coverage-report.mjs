#!/usr/bin/env node
/**
 * What the tests leave unrun, file by file, whatever wrote the report, held to each side's floor.
 *
 * Bead is measured twice: c8 writes an istanbul `coverage-final.json` for the TypeScript side, and
 * `dotnet test --coverage` writes one cobertura XML per test project for the C# side. This reads
 * any number of either, merges what they say of the same file — a line is run when any report ran
 * it — and prints each file's lines and branches run, then the lines no report ran, and the lines
 * whose branches ran only in part, so a gap reads the same on both sides.
 *
 *   node tools/coverage-report.mjs <report>... [--under <path>]... [--floor <side>]
 *     [--raise <side>] [--summary <file>]
 *
 * `--under` keeps the files below a path, relative to the repository; given several times, below
 * any of them. `--floor` fails, exit 1, when the lines or the branches run fall under the side's
 * floor in `tools/coverage-floors.json`, or when nothing was measured. `--raise` writes the side's
 * floor up to what was measured, less the margin, never down. `--summary` appends the totals, the
 * floor and the files not wholly run to a Markdown file, CI's `$GITHUB_STEP_SUMMARY`.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FLOORS = resolve(ROOT, 'tools/coverage-floors.json');

// ! a floor sits this far under what was measured: an async path a run may or may not take moves
// the measure by a tenth or two, which must not fail a push
export const MARGIN = 0.5;

// ── Reading ──────────────────────────────────────────────────────────────────

/** Each file's lines: whether a report ran each, and its branches run of all. */
const fileOf = (files, path) => {
  const name = relative(ROOT, path).replaceAll('\\', '/');

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
const readCobertura = (files, text) => {
  let file;

  for (const [tag] of text.matchAll(/<class\b[^>]*>|<line\b[^>]*>/g)) {
    if (tag.startsWith('<class')) {
      const filename = /filename="([^"]+)"/.exec(tag)?.[1];

      file = filename === undefined ? undefined : fileOf(files, filename);
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
const readIstanbul = (files, text) => {
  for (const [path, entry] of Object.entries(JSON.parse(text))) {
    const file = fileOf(files, path);

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

/**
 * Reports, each a cobertura `.xml` or an istanbul `.json` by its name, merged, then each file
 * below one of `unders` (every file when there is none), but what a build writes under an `obj/`
 * folder, as a row, and the totals.
 */
export const measure = (reports, unders) => {
  const files = new Map();

  for (const { name, text } of reports) {
    if (name.endsWith('.xml')) {
      readCobertura(files, text);
    } else {
      readIstanbul(files, text);
    }
  }

  const kept = [...files.entries()].filter(([name]) => {
    // ! what a build writes under obj/, a source generator's code among it, is no source of the side
    if (name.split('/').includes('obj')) {
      return false;
    }

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

  return {
    rows: rows.toSorted((first, second) => {
      return second.unrun.length - first.unrun.length || first.name.localeCompare(second.name);
    }),
    totals,
  };
};

// ── Floors ───────────────────────────────────────────────────────────────────

/** The share run, in percent, unrounded: a floor is held to it, never to what is printed. */
export const percentOf = (part, whole) => {
  return whole === 0 ? 100 : (100 * part) / whole;
};

/** What fails a side's floor: nothing measured, or lines or branches run under it. */
export const judge = (totals, floor) => {
  const problems = [];

  // * a run that measured nothing would read 100 %: a wrong --under, a report of no file
  if (totals.lines === 0) {
    problems.push('no line was measured: the reports name no file under the paths kept');

    return problems;
  }

  const lines = percentOf(totals.linesRun, totals.lines);
  const branches = percentOf(totals.branchesRun, totals.branches);

  if (lines < floor.lines) {
    problems.push(`${lines.toFixed(2)}% of the lines run, under the floor of ${floor.lines}%`);
  }

  if (branches < floor.branches) {
    problems.push(
      `${branches.toFixed(2)}% of the branches run, under the floor of ${floor.branches}%`
    );
  }

  return problems;
};

/** What was measured, less the margin, to a tenth, rounded down. */
const flooredOf = (percent) => {
  // a hair over, so 99.6 less 0.5 is 99.1, never the 99.0 a float's 990.9999 would floor to
  return Math.floor((percent - MARGIN) * 10 + 1e-9) / 10;
};

/** The floor raised to what was measured, less the margin; a floor never goes down. */
export const raise = (totals, floor) => {
  return {
    ...floor,
    branches: Math.max(floor.branches, flooredOf(percentOf(totals.branchesRun, totals.branches))),
    lines: Math.max(floor.lines, flooredOf(percentOf(totals.linesRun, totals.lines))),
  };
};

// ── Printing ─────────────────────────────────────────────────────────────────

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

const shownOf = (part, whole) => {
  return percentOf(part, whole).toFixed(1);
};

/** Each file, the most lines unrun first, then the totals. */
export const textOf = ({ rows, totals }) => {
  const lines = rows.map((row) => {
    const linesRun = shownOf(row.lines - row.unrun.length, row.lines);
    const branchesRun = shownOf(row.branchesRun, row.branchesAll);
    const gaps = row.unrun.length === 0 ? '' : `  unrun: ${rangesOf(row.unrun)}`;
    const partial = row.short.length === 0 ? '' : `  in part: ${row.short.join(', ')}`;

    return `${linesRun.padStart(5)}% lines  ${branchesRun.padStart(5)}% branches  ${row.name}${gaps}${partial}`;
  });

  return `${lines.join('\n')}\n\n${String(rows.length)} files: ${shownOf(totals.linesRun, totals.lines)}% of ${String(totals.lines)} lines, ${shownOf(totals.branchesRun, totals.branches)}% of ${String(totals.branches)} branches.\n`;
};

/** A side's totals against its floor, then the files not wholly run, in Markdown. */
export const summaryOf = ({ floor, measured, problems }) => {
  const { rows, totals } = measured;
  const raised = raise(totals, floor);
  const gaps = rows.filter((row) => {
    return row.unrun.length > 0 || row.branchesRun < row.branchesAll;
  });
  const out = [
    `### Coverage: ${floor.title}`,
    '',
    problems.length === 0 ? 'Every floor holds.' : `**Under its floor:** ${problems.join('; ')}.`,
    '',
    '|          | Run | Of | Floor |',
    '| -------- | --: | -: | ----: |',
    `| Lines    | ${shownOf(totals.linesRun, totals.lines)}% | ${String(totals.lines)} | ${String(floor.lines)}% |`,
    `| Branches | ${shownOf(totals.branchesRun, totals.branches)}% | ${String(totals.branches)} | ${String(floor.branches)}% |`,
    '',
  ];

  if (raised.lines > floor.lines || raised.branches > floor.branches) {
    out.push(
      `The floor can rise to ${String(raised.lines)}% of the lines and ${String(raised.branches)}% of the branches: \`--raise\`.`,
      ''
    );
  }

  if (gaps.length > 0) {
    out.push(
      `<details><summary>${String(rows.length)} files, ${String(gaps.length)} not wholly run, the most lines unrun first</summary>`,
      '',
      '| Lines | Branches | File | Unrun |',
      '| ----: | -------: | ---- | ----- |',
      ...gaps.map((row) => {
        return `| ${shownOf(row.lines - row.unrun.length, row.lines)}% | ${shownOf(row.branchesRun, row.branchesAll)}% | \`${row.name}\` | ${rangesOf(row.unrun)} |`;
      }),
      '',
      '</details>',
      ''
    );
  }

  return `${out.join('\n')}\n`;
};

// ── Command ──────────────────────────────────────────────────────────────────

const argumentsOf = (argv) => {
  const options = {
    floor: undefined,
    raise: undefined,
    reports: [],
    summary: undefined,
    unders: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--under') {
      options.unders.push(argv[(index += 1)]);
    } else if (argument === '--floor' || argument === '--raise' || argument === '--summary') {
      options[argument.slice(2)] = argv[(index += 1)];
    } else {
      options.reports.push(argument);
    }
  }

  return options;
};

if (import.meta.main) {
  const options = argumentsOf(process.argv.slice(2));

  if (options.reports.length === 0) {
    console.error('coverage-report: name a report, a cobertura .xml or an istanbul .json.');
    process.exit(1);
  }

  const measured = measure(
    options.reports.map((name) => {
      return { name, text: readFileSync(name, 'utf8') };
    }),
    options.unders
  );

  process.stdout.write(textOf(measured));

  const side = options.floor ?? options.raise;

  if (side === undefined) {
    process.exit(0);
  }

  const floors = JSON.parse(readFileSync(FLOORS, 'utf8'));
  const floor = floors[side];

  if (floor === undefined) {
    console.error(`coverage-report: ${FLOORS} has no floor for ${side}.`);
    process.exit(1);
  }

  const problems = judge(measured.totals, floor);

  if (options.summary !== undefined) {
    appendFileSync(options.summary, summaryOf({ floor, measured, problems }));
  }

  if (options.raise !== undefined && measured.totals.lines > 0) {
    floors[side] = raise(measured.totals, floor);
    writeFileSync(FLOORS, `${JSON.stringify(floors, null, 2)}\n`);
    console.log(
      `coverage-report: ${side}'s floor at ${String(floors[side].lines)}% of the lines, ${String(floors[side].branches)}% of the branches.`
    );
  }

  for (const problem of problems) {
    console.error(`coverage-report: ${side}: ${problem}`);
  }

  process.exit(options.floor !== undefined && problems.length > 0 ? 1 : 0);
}
