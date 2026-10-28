#!/usr/bin/env node
/**
 * What the tests leave unrun, file by file, whatever wrote the report, held to each side's floor.
 *
 * Bead is measured three times: c8 writes an istanbul `coverage-final.json` for the TypeScript
 * side, `dotnet test --coverage` writes one cobertura XML per test project for the C# side, and
 * `cargo llvm-cov --json` writes one LLVM coverage export for the Rust side, every test binary's
 * profile merged. This reads any number of them, merges what they say of the same file — a line is
 * run when any report ran it — and prints each file's lines and branches or regions run, then the
 * lines no report ran, and the lines whose branches ran only in part, so a gap reads the same on
 * every side. An LLVM export states each file's summary, its lines and its regions counted, and no
 * line of it: two reports that name one file are refused, since a summary merges by no line.
 *
 *   node tools/coverage-report.mjs <report>... [--under <path>]... [--floor <side>]
 *     [--raise <side>] [--summary <file>]
 *
 * `--under` keeps the files below a path, relative to the repository; given several times, below
 * any of them. `--floor` fails, exit 1, when a measure the side's floor in
 * `tools/coverage-floors.json` names — its lines, and its branches or its regions — falls under it,
 * or when no report measured it. `--raise` writes the side's floor up to what was measured, less the
 * margin, never down. `--summary` appends the totals, the floor and the files not wholly run to a
 * Markdown file, CI's `$GITHUB_STEP_SUMMARY`.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FLOORS = resolve(ROOT, 'tools/coverage-floors.json');

// ! a floor sits this far under what was measured: an async path a run may or may not take moves
// the measure by a tenth or two, which must not fail a push
export const MARGIN = 0.5;

// the measures a floor may name, each with its words, and the order they are held and printed in
const MEASURES = Object.freeze({
  branches: Object.freeze({ one: 'branch', title: 'Branches' }),
  lines: Object.freeze({ one: 'line', title: 'Lines' }),
  regions: Object.freeze({ one: 'region', title: 'Regions' }),
});
const ORDER = Object.freeze(['lines', 'branches', 'regions']);

// the type an LLVM coverage export states, which tells it from istanbul's JSON
export const LLVM_EXPORT = 'llvm.coverage.json.export';

// ── Reading ──────────────────────────────────────────────────────────────────

/** Each file's lines: whether a report ran each, and its branches run of all. */
const fileOf = (files, path) => {
  const name = relative(ROOT, path).replaceAll('\\', '/');

  if (!files.has(name)) {
    files.set(name, { branches: new Map(), lines: new Map(), summary: undefined });
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
const readIstanbul = (files, report) => {
  for (const [path, entry] of Object.entries(report)) {
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
 * An LLVM coverage export: each file's summary, its lines and its regions counted, by its absolute
 * `filename`. A file another report names too is refused, since a summary merges by no line.
 */
const readLlvm = (files, report) => {
  for (const data of report.data) {
    for (const entry of data.files) {
      const name = relative(ROOT, entry.filename).replaceAll('\\', '/');

      if (files.has(name)) {
        throw new Error(
          `coverage-report: two reports name ${name}, one of them an LLVM export, whose summary merges by no line`
        );
      }

      fileOf(files, entry.filename).summary = {
        lines: { count: entry.summary.lines.count, covered: entry.summary.lines.covered },
        regions: { count: entry.summary.regions.count, covered: entry.summary.regions.covered },
      };
    }
  }
};

/** A file's lines and those run, counted from its lines or, an LLVM export's, read from its summary. */
const linesOf = (file) => {
  if (file.summary !== undefined) {
    return { lines: file.summary.lines.count, linesRun: file.summary.lines.covered };
  }

  const linesRun = [...file.lines.values()].filter((isRun) => {
    return isRun;
  }).length;

  return { lines: file.lines.size, linesRun };
};

/**
 * Reports, each a cobertura `.xml` by its name, or a JSON told by its `type`, an LLVM export or
 * else istanbul's, merged, then each file below one of `unders` (every file when there is none),
 * but what a build writes under an `obj/` folder, as a row, and the totals.
 */
export const measure = (reports, unders) => {
  const files = new Map();

  for (const { name, text } of reports) {
    if (name.endsWith('.xml')) {
      readCobertura(files, text);
      continue;
    }

    const report = JSON.parse(text);

    if (report.type === LLVM_EXPORT) {
      readLlvm(files, report);
    } else {
      readIstanbul(files, report);
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
  const totals = { branches: 0, branchesRun: 0, lines: 0, linesRun: 0, regions: 0, regionsRun: 0 };
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
    const { lines, linesRun } = linesOf(file);
    const regionsAll = file.summary?.regions.count ?? 0;
    const regionsRun = file.summary?.regions.covered ?? 0;

    totals.lines += lines;
    totals.linesRun += linesRun;
    totals.branches += branchesAll;
    totals.branchesRun += branchesRun;
    totals.regions += regionsAll;
    totals.regionsRun += regionsRun;

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

    return {
      branchesAll,
      branchesRun,
      lines,
      linesRun,
      name,
      regionsAll,
      regionsRun,
      short,
      unrun,
    };
  });

  return {
    rows: rows.toSorted((first, second) => {
      return (
        second.lines - second.linesRun - (first.lines - first.linesRun) ||
        first.name.localeCompare(second.name)
      );
    }),
    totals,
  };
};

// ── Floors ───────────────────────────────────────────────────────────────────

/** The share run, in percent, unrounded: a floor is held to it, never to what is printed. */
export const percentOf = (part, whole) => {
  return whole === 0 ? 100 : (100 * part) / whole;
};

/** The measures a floor names, in their order: its lines, and its branches or its regions. */
export const measuresOf = (floor) => {
  return ORDER.filter((measure) => {
    return floor[measure] !== undefined;
  });
};

/**
 * What fails a side's floor: nothing measured, a measure the floor names that no report measured,
 * or a measure run under it.
 */
export const judge = (totals, floor) => {
  const problems = [];

  // * a run that measured nothing would read 100 %: a wrong --under, a report of no file
  if (totals.lines === 0) {
    problems.push('no line was measured: the reports name no file under the paths kept');

    return problems;
  }

  for (const measure of measuresOf(floor)) {
    // * a measure no report took would read 100 % too: a report of lines alone holds no floor of
    // branches, nor one of regions
    if (totals[measure] === 0) {
      problems.push(
        `no ${MEASURES[measure].one} was measured: a report of none holds no floor of ${measure}`
      );
      continue;
    }

    const share = percentOf(totals[`${measure}Run`], totals[measure]);

    if (share < floor[measure]) {
      problems.push(
        `${share.toFixed(2)}% of the ${measure} run, under the floor of ${floor[measure]}%`
      );
    }
  }

  return problems;
};

/** What was measured, less the margin, to a tenth, rounded down. */
const flooredOf = (percent) => {
  // a hair over, so 99.6 less 0.5 is 99.1, never the 99.0 a float's 990.9999 would floor to
  return Math.floor((percent - MARGIN) * 10 + 1e-9) / 10;
};

/**
 * The floor raised to what was measured, less the margin, each measure it names that a report
 * measured; a floor never goes down.
 */
export const raise = (totals, floor) => {
  const raised = { ...floor };

  for (const measure of measuresOf(floor)) {
    if (totals[measure] > 0) {
      raised[measure] = Math.max(
        floor[measure],
        flooredOf(percentOf(totals[`${measure}Run`], totals[measure]))
      );
    }
  }

  return raised;
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

/** The measure the reports took beside the lines: an LLVM export's regions, or the branches. */
const besideOf = (totals) => {
  return totals.regions > 0 && totals.branches === 0 ? 'regions' : 'branches';
};

/** A row's run and its all of a measure: its lines, its branches or its regions. */
const countsOf = (row, measure) => {
  if (measure === 'lines') {
    return [row.linesRun, row.lines];
  }

  return measure === 'regions'
    ? [row.regionsRun, row.regionsAll]
    : [row.branchesRun, row.branchesAll];
};

/** Each file, the most lines unrun first, then the totals. */
export const textOf = ({ rows, totals }) => {
  const beside = besideOf(totals);
  const lines = rows.map((row) => {
    const linesRun = shownOf(row.linesRun, row.lines);
    const besideRun = shownOf(...countsOf(row, beside));
    const gaps = row.unrun.length === 0 ? '' : `  unrun: ${rangesOf(row.unrun)}`;
    const partial = row.short.length === 0 ? '' : `  in part: ${row.short.join(', ')}`;

    return `${linesRun.padStart(5)}% lines  ${besideRun.padStart(5)}% ${beside}  ${row.name}${gaps}${partial}`;
  });

  return `${lines.join('\n')}\n\n${String(rows.length)} files: ${shownOf(totals.linesRun, totals.lines)}% of ${String(totals.lines)} lines, ${shownOf(totals[`${beside}Run`], totals[beside])}% of ${String(totals[beside])} ${beside}.\n`;
};

/** A side's totals against its floor, then the files not wholly run, in Markdown. */
export const summaryOf = ({ floor, measured, problems }) => {
  const { rows, totals } = measured;
  const measures = measuresOf(floor);
  const beside =
    measures.find((measure) => {
      return measure !== 'lines';
    }) ?? besideOf(totals);
  const raised = raise(totals, floor);
  const rises = measures.some((measure) => {
    return raised[measure] > floor[measure];
  });
  const gaps = rows.filter((row) => {
    const [run, all] = countsOf(row, beside);

    return row.linesRun < row.lines || run < all;
  });
  const out = [
    `### Coverage: ${floor.title}`,
    '',
    problems.length === 0 ? 'Every floor holds.' : `**Under its floor:** ${problems.join('; ')}.`,
    '',
    '|          | Run | Of | Floor |',
    '| -------- | --: | -: | ----: |',
    ...measures.map((measure) => {
      return `| ${MEASURES[measure].title.padEnd(8)} | ${shownOf(totals[`${measure}Run`], totals[measure])}% | ${String(totals[measure])} | ${String(floor[measure])}% |`;
    }),
    '',
  ];

  if (rises) {
    const shares = measures.map((measure) => {
      return `${String(raised[measure])}% of the ${measure}`;
    });

    out.push(`The floor can rise to ${shares.join(' and ')}: \`--raise\`.`, '');
  }

  if (gaps.length > 0) {
    const { title } = MEASURES[beside];

    out.push(
      `<details><summary>${String(rows.length)} files, ${String(gaps.length)} not wholly run, the most lines unrun first</summary>`,
      '',
      `| Lines | ${title} | File | Unrun |`,
      `| ----: | ${'-'.repeat(title.length - 1)}: | ---- | ----- |`,
      ...gaps.map((row) => {
        return `| ${shownOf(row.linesRun, row.lines)}% | ${shownOf(...countsOf(row, beside))}% | \`${row.name}\` | ${rangesOf(row.unrun)} |`;
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
    console.error(
      'coverage-report: name a report, a cobertura .xml, an istanbul .json or an LLVM coverage export.'
    );
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

    const shares = measuresOf(floor).map((measure) => {
      return `${String(floors[side][measure])}% of the ${measure}`;
    });

    console.log(`coverage-report: ${side}'s floor at ${shares.join(', ')}.`);
  }

  for (const problem of problems) {
    console.error(`coverage-report: ${side}: ${problem}`);
  }

  process.exit(options.floor !== undefined && problems.length > 0 ? 1 : 0);
}
