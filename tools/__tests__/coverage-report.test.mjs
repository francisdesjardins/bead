import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MARGIN, judge, measure, raise, summaryOf } from '../coverage-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** An istanbul report of one file: a statement per line, `runs` its count; one branch of two. */
const istanbulOf = (path, { branch, runs }) => {
  const statementMap = {};
  const s = {};

  runs.forEach((count, index) => {
    statementMap[index] = { end: { line: index + 1 }, start: { line: index + 1 } };
    s[index] = count;
  });

  return {
    name: 'coverage-final.json',
    text: JSON.stringify({
      [resolve(ROOT, path)]: {
        b: { 0: branch },
        branchMap: { 0: { loc: { start: { line: 1 } }, locations: [] } },
        s,
        statementMap,
      },
    }),
  };
};

const coberturaOf = (path, lines) => {
  return {
    name: 'core.cobertura.xml',
    text: `<coverage><packages><package><classes><class name="A" filename="${resolve(ROOT, path)}"><lines>${lines}</lines></class></classes></package></packages></coverage>`,
  };
};

/** An LLVM coverage export of files, each its lines and its regions, counted and covered. */
const llvmOf = (files) => {
  return {
    name: 'rust.json',
    text: JSON.stringify({
      data: [
        {
          files: files.map(({ lines, path, regions }) => {
            return {
              filename: resolve(ROOT, path),
              summary: {
                branches: { count: 0, covered: 0, notcovered: 0 },
                lines: { count: lines[1], covered: lines[0] },
                regions: {
                  count: regions[1],
                  covered: regions[0],
                  notcovered: regions[1] - regions[0],
                },
              },
            };
          }),
        },
      ],
      type: 'llvm.coverage.json.export',
      version: '3.1.0',
    }),
  };
};

const FLOOR = { branches: 50, lines: 75, title: 'the TypeScript side' };
const RUST_FLOOR = { lines: 75, regions: 50, title: 'the Rust side' };

describe('measure', () => {
  test('a line run in any report stays run, a branch counts the most any report ran', () => {
    const { rows, totals } = measure(
      [
        istanbulOf('src/a.ts', { branch: [1, 0], runs: [1, 0, 0, 1] }),
        istanbulOf('src/a.ts', { branch: [0, 0], runs: [0, 1, 0, 1] }),
      ],
      []
    );

    assert.deepEqual(totals, {
      branches: 2,
      branchesRun: 1,
      lines: 4,
      linesRun: 3,
      regions: 0,
      regionsRun: 0,
    });
    assert.deepEqual(rows[0].unrun, [3]);
  });

  test("reads cobertura's hits and condition-coverage", () => {
    const { rows, totals } = measure(
      [
        coberturaOf(
          'src/A.cs',
          '<line number="1" hits="2" branch="True" condition-coverage="50% (1/2)"/><line number="2" hits="0"/>'
        ),
      ],
      []
    );

    assert.deepEqual(totals, {
      branches: 2,
      branchesRun: 1,
      lines: 2,
      linesRun: 1,
      regions: 0,
      regionsRun: 0,
    });
    assert.deepEqual(rows[0].short, ['1 (1/2)']);
  });

  test('keeps the files under the paths given, by their path in the repository', () => {
    const { rows } = measure(
      [
        istanbulOf('src/a.ts', { branch: [1, 1], runs: [1] }),
        istanbulOf('other/b.ts', { branch: [1, 1], runs: [1] }),
      ],
      ['src/']
    );

    assert.deepEqual(
      rows.map((row) => {
        return row.name;
      }),
      ['src/a.ts']
    );
  });

  test('leaves out what a build writes under obj/, a source generator’s code among it', () => {
    const { rows } = measure(
      [
        coberturaOf('src/Lib/Routes.cs', '<line number="1" hits="1"/>'),
        coberturaOf(
          'src/Lib/obj/Debug/net10.0/Gen/RegexGenerator.g.cs',
          '<line number="1" hits="0"/>'
        ),
      ],
      ['src/']
    );

    assert.deepEqual(
      rows.map((row) => {
        return row.name;
      }),
      ['src/Lib/Routes.cs']
    );
  });

  test('reads an LLVM export’s lines and regions by its type, a file of the paths kept alone', () => {
    const { rows, totals } = measure(
      [
        llvmOf([
          { lines: [9, 10], path: 'crates/bead/src/envelope.rs', regions: [7, 8] },
          { lines: [1, 4], path: 'crates/bead/src/router.rs', regions: [1, 2] },
          { lines: [0, 50], path: 'other/std/src/lib.rs', regions: [0, 90] },
        ]),
      ],
      ['crates/bead/src/']
    );

    assert.deepEqual(totals, {
      branches: 0,
      branchesRun: 0,
      lines: 14,
      linesRun: 10,
      regions: 10,
      regionsRun: 8,
    });
    assert.deepEqual(
      rows.map((row) => {
        return row.name;
      }),
      ['crates/bead/src/router.rs', 'crates/bead/src/envelope.rs']
    );
  });

  test('refuses two LLVM reports that name one file', () => {
    const report = llvmOf([
      { lines: [1, 1], path: 'crates/bead/src/envelope.rs', regions: [1, 1] },
    ]);

    assert.throws(() => {
      measure([report, report], []);
    }, /two reports name crates\/bead\/src\/envelope\.rs/);
  });
});

describe('judge', () => {
  test('holds at the floor, fails under it, lines and branches each', () => {
    assert.deepEqual(judge({ branches: 2, branchesRun: 1, lines: 4, linesRun: 3 }, FLOOR), []);
    assert.equal(judge({ branches: 2, branchesRun: 0, lines: 4, linesRun: 2 }, FLOOR).length, 2);
  });

  test('holds the share unrounded: 74.96% fails a floor of 75%', () => {
    const problems = judge({ branches: 2, branchesRun: 2, lines: 2500, linesRun: 1874 }, FLOOR);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /74\.96% of the lines/);
  });

  test('fails when nothing was measured, which would otherwise read 100%', () => {
    const problems = judge({ branches: 0, branchesRun: 0, lines: 0, linesRun: 0 }, FLOOR);

    assert.match(problems[0], /no line was measured/);
  });

  test('fails a floor on a measure no report measured, which would otherwise read 100%', () => {
    const lines = { branches: 0, branchesRun: 0, lines: 4, linesRun: 4, regions: 0, regionsRun: 0 };

    assert.deepEqual(judge(lines, FLOOR), [
      'no branch was measured: a report of none holds no floor of branches',
    ]);
    assert.deepEqual(judge(lines, RUST_FLOOR), [
      'no region was measured: a report of none holds no floor of regions',
    ]);
    assert.deepEqual(judge({ ...lines, regions: 4, regionsRun: 2 }, RUST_FLOOR), []);
  });
});

describe('raise', () => {
  test('to what was measured less the margin, to a tenth rounded down', () => {
    const raised = raise({ branches: 1000, branchesRun: 987, lines: 1000, linesRun: 999 }, FLOOR);

    assert.equal(MARGIN, 0.5);
    assert.deepEqual(raised, { ...FLOOR, branches: 98.2, lines: 99.4 });
  });

  test('never down', () => {
    const raised = raise({ branches: 10, branchesRun: 1, lines: 10, linesRun: 1 }, FLOOR);

    assert.deepEqual(raised, FLOOR);
  });

  test('the measures its floor names, its regions among them', () => {
    const raised = raise(
      { branches: 0, branchesRun: 0, lines: 1000, linesRun: 999, regions: 1000, regionsRun: 987 },
      RUST_FLOOR
    );

    assert.deepEqual(raised, { ...RUST_FLOOR, lines: 99.4, regions: 98.2 });
  });
});

describe('summaryOf', () => {
  test('says which floor fails, and lists the files not wholly run', () => {
    const measured = measure([istanbulOf('src/a.ts', { branch: [1, 0], runs: [1, 0] })], []);
    const summary = summaryOf({ floor: FLOOR, measured, problems: judge(measured.totals, FLOOR) });

    assert.match(summary, /^### Coverage: the TypeScript side/);
    assert.match(summary, /\*\*Under its floor:\*\* 50\.00% of the lines run/);
    assert.match(summary, /\| 50\.0% \| 50\.0% \| `src\/a\.ts` \| 2 \|/);
  });

  test('says when the floor can rise', () => {
    const measured = measure([istanbulOf('src/a.ts', { branch: [1, 1], runs: [1, 1] })], []);
    const summary = summaryOf({ floor: FLOOR, measured, problems: [] });

    assert.match(summary, /Every floor holds/);
    assert.match(summary, /can rise to 99\.5% of the lines and 99\.5% of the branches/);
  });

  test('names the regions where the floor holds them', () => {
    const measured = measure(
      [llvmOf([{ lines: [3, 4], path: 'crates/bead/src/router.rs', regions: [1, 2] }])],
      []
    );
    const summary = summaryOf({ floor: RUST_FLOOR, measured, problems: [] });

    assert.match(summary, /\| Regions  \| 50\.0% \| 2 \| 50% \|/);
    assert.match(summary, /\| 75\.0% \| 50\.0% \| `crates\/bead\/src\/router\.rs` \|/);
  });
});
