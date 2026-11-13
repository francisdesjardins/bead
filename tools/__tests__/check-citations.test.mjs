import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { FLOORS, LITERALS, poolsOf, problemsOf, shapeOf, spansOf } from '../check-citations.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SUPPORT = 'docs/support.md';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// pools built in memory, each left empty but those given
const poolsWith = (given) => {
  return {
    paths: new Set(),
    titles: new Set(),
    trials: new Set(),
    templates: [],
    literals: new Map(),
    cases: new Set(),
    classes: new Map(),
    methods: new Map(),
    functions: new Set(),
    entries: new Set(),
    ...given,
  };
};

// the problems of a text read as a file given alone, with no floor and no list held
const problemsAlone = (text, pools) => {
  return problemsOf(text, pools, { file: 'doc.md' });
};

// the spans a text's problems name
const failedOf = (problems) => {
  return problems.map((problem) => {
    return problem.match(/: `(.*?)` \(/)[1];
  });
};

let repository;

// the matrix and the repository's pools, read once
const repositoryOf = () => {
  repository ??= {
    text: readFileSync(`${ROOT}/${SUPPORT}`, 'utf8'),
    pools: poolsOf(ROOT),
  };

  return repository;
};

// ! this file's literals are case labels of the real run: a fixture is a name no test holds, and
// a mutant or a span the matrix cites is built by replacement, never written whole, or it would
// place itself
const CREDIT = 'carries_a_transfer_under_its_routers_credit';
const CREDIX = CREDIT.replace(/t$/, 'x');
const OVER = 'over ';
const RUST_PATH = ['typescript', 'quic', '…'].join('::');

// ── spansOf ────────────────────────────────────────────────────────────────────

describe('spansOf', () => {
  test('reads a code span as CommonMark does: its backtick string, a line ending a space, one space stripped, and a table cell’s escaped bar', () => {
    const text = [
      'A ``double ` tick`` span, `one',
      '  line on` the next, ` padded ` and `` ` `` and ` ` alone, an ` unclosed one.',
      '',
      '```js',
      "test('in a block', () => { return `no span`; });",
      '```',
      '',
      '| Row \\| title | `a \\| b` |',
      '| --- | --- |',
      '| Next | `c',
      'd` |',
    ].join('\r\n');
    const spans = spansOf(text);

    assert.deepEqual(
      spans.map((span) => {
        return [span.text, span.line, span.row];
      }),
      [
        ['double ` tick', 1, undefined],
        ['one line on', 1, undefined],
        ['padded', 2, undefined],
        ['`', 2, undefined],
        [' ', 2, undefined],
        ['a | b', 8, 'Row | title'],
      ]
    );
  });
});

// ── shapeOf ────────────────────────────────────────────────────────────────────

describe('shapeOf', () => {
  test('leaves out bytes, a setting or a header, a command line, a comment, a unit’s number and a form with a placeholder', () => {
    const leftOut = [
      '82 A1 00',
      'connection: close',
      'panic = "abort"',
      'server=Rust',
      'node tools/check-links.mjs',
      'cargo test --workspace',
      'tools/release.mjs prepare',
      '--include-ignored',
      '// a comment',
      'spec 15.25',
      'debugging 3.5',
      'the link of <id> stopped',
    ];

    for (const span of leftOut) {
      assert.equal(shapeOf(span), undefined, span);
      assert.equal(shapeOf(span, { inParentheses: true }), undefined, span);
    }
  });

  test('holds a path, a C# class or method, a Rust function, a sentence, and what the parentheses after a file name', () => {
    const shapes = {
      'src/transport/__tests__/session-manager.test.ts': 'path',
      '…/interop.rs': 'path',
      'bead-house/surfaces/': 'path',
      'Bead.Core.Tests/RouterServerTests': 'C# class',
      RouterServerTests: 'C# class',
      A_paused_connection_closes_cleanly: 'C# method',
      'Bead.Core.Tests/RouterServerTests.Answers_…': 'C# method',
      Gauges_largestAnsweringCalls_under_its_ceiling_maximumAnsweringCalls_which_health_warns_at:
        'C# method',
      [CREDIT]: 'Rust function',
      'holds a sentence of its own: …': 'sentence',
    };

    for (const [span, shape] of Object.entries(shapes)) {
      assert.equal(shapeOf(span), shape, span);
    }
    for (const span of ['PAYLOAD_INVALID', 'HTTP_1_1_REQUIRED', RUST_PATH, 'meters']) {
      assert.equal(shapeOf(span), undefined, span);
    }
    assert.equal(shapeOf('meters', { inParentheses: true }), 'named in parentheses');

    const spans = spansOf(
      '`timers.test.ts` (`createClocks`, `meters` (`QUIC`)) and `createClocks`; `RouterTests` (`wss`\n`next`)'
    );

    assert.deepEqual(
      spans.map((span) => {
        return [span.text, span.inParentheses];
      }),
      [
        ['timers.test.ts', false],
        ['createClocks', true],
        ['meters', true],
        ['QUIC', true],
        ['createClocks', false],
        ['RouterTests', false],
        ['wss', true],
        ['next', false],
      ]
    );
  });
});

// ── poolsOf ────────────────────────────────────────────────────────────────────

describe('poolsOf', () => {
  test('fails a title one byte off', () => {
    const { text, pools } = repositoryOf();
    const lines = text.split(/\r?\n/);
    const citing = lines.flatMap((line, index) => {
      return line.includes(CREDIT) ? [index + 1] : [];
    });
    const problems = problemsOf(text.replaceAll(CREDIT, CREDIX), pools);

    assert.equal(citing.length, 2);
    assert.ok(lines[citing[0] - 1].startsWith('|'), 'a cell');
    assert.ok(!lines[citing[1] - 1].startsWith('|'), 'the prose');
    assert.deepEqual(
      problems.map((problem) => {
        return problem.split(':').slice(0, 2).join(':');
      }),
      citing.map((line) => {
        return `${SUPPORT}:${line}`;
      })
    );
    assert.match(
      problems[0],
      new RegExp(`\`${CREDIX}\` \\(Rust function\\) is no fn .*, in the row`)
    );
    assert.doesNotMatch(problems[1], /in the row/);
  });

  test('fails a file renamed', () => {
    const { text, pools } = repositoryOf();
    const renamed = [...pools.paths].map((path) => {
      return path.replace(/session-manager\.test\.ts$/, 'session-managers.test.ts');
    });
    const problems = problemsOf(text, { ...pools, paths: new Set(renamed) });

    assert.ok(problems.length > 0);
    for (const problem of problems) {
      assert.match(problem, /session-manager\.test\.ts` \(path\) is no file or folder git lists/);
    }
  });

  test('fails a test dropped that is cited by its whole name and declared once', () => {
    const { text, pools } = repositoryOf();
    const functions = new Set(pools.functions);

    functions.delete(CREDIT);
    const problems = problemsOf(text, { ...pools, functions });

    assert.deepEqual(failedOf(problems), [CREDIT, CREDIT]);
  });

  test('places every citation of the support matrix', () => {
    const { text, pools } = repositoryOf();

    assert.deepEqual(problemsOf(text, pools), []);
  });
});

// ── problemsOf ─────────────────────────────────────────────────────────────────

describe('problemsOf', () => {
  test('places a path from the repository’s root, by its end, and after a leading …/', () => {
    const pools = poolsWith({
      paths: new Set([
        'implementations',
        'implementations/rust',
        'implementations/rust/crates',
        'implementations/rust/crates/bead-house',
        'implementations/rust/crates/bead-house/surfaces',
        'implementations/rust/crates/bead-house/surfaces/core.txt',
        'implementations/rust/crates/bead/tests/interop.rs',
      ]),
    });
    const text = [
      '`implementations/rust/crates/bead/tests/interop.rs`, `crates/bead/tests/interop.rs`,',
      '`interop.rs`, `…/interop.rs`, `bead-house/surfaces/`, `implementations/rust/…/core.txt`;',
      '`interops.rs`, `…/bead-house/core.txt`',
    ].join('\n');

    assert.deepEqual(problemsAlone(text, pools), [
      'doc.md:3: `interops.rs` (path) is no file or folder git lists',
      'doc.md:3: `…/bead-house/core.txt` (path) is no file or folder git lists',
    ]);
  });

  test('places a C# method in the class it names, and a class in the project it names', () => {
    const file = 'implementations/dotnet/tests/Bead.Core.Tests/RouterServerTests.Telling.cs';
    const pools = poolsWith({
      classes: new Map([
        ['RouterServerTests', [file]],
        [
          'ListenerGuardTests',
          ['implementations/dotnet/tests/Bead.Core.Tests/ListenerGuardTests.cs'],
        ],
      ]),
      methods: new Map([['Tells_a_peer_its_fault', [{ file, owner: 'RouterServerTests' }]]]),
    });
    const text = [
      '`Bead.Core.Tests/RouterServerTests`, `RouterServerTests`, `Tells_a_peer_its_fault`,',
      '`RouterServerTests.Tells_a_peer_its_fault`, `Bead.Core.Tests/RouterServerTests.Tells_…`;',
      '`Bead.Transport.Http.Tests/RouterServerTests`, `ListenerGuardTests.Tells_a_peer_its_fault`,',
      '`MissingTests.Tells_a_peer_its_fault`, `Tells_a_peer_its_faults`',
    ].join('\n');

    assert.deepEqual(failedOf(problemsAlone(text, pools)), [
      'Bead.Transport.Http.Tests/RouterServerTests',
      'ListenerGuardTests.Tells_a_peer_its_fault',
      'MissingTests.Tells_a_peer_its_fault',
      'Tells_a_peer_its_faults',
    ]);
  });

  test('places a sentence by a title, an entry, a case’s label or a row', () => {
    const pools = poolsWith({
      titles: new Set(['holds what a title says']),
      entries: new Set(['a conversation of the file']),
      cases: new Set(['Rust, QUIC']),
    });
    const text = [
      '| Row        | Cell                                                                       |',
      '| ---------- | -------------------------------------------------------------------------- |',
      '| A row’s title | `holds what a title says`, `a conversation of the file`, `Rust, QUIC` |',
      '',
      'As `A row’s title` says, and not `holds what no title says`.',
    ].join('\n');

    assert.deepEqual(problemsAlone(text, pools), [
      "doc.md:5: `holds what no title says` (sentence) is no test's title, entry of spec/*.json, case's label or row of the matrix",
    ]);
  });

  test('reads … as any run of one character or more, wherever it stands and as often as it appears', () => {
    const pools = poolsWith({ titles: new Set(['holds a part’s bytes: each one, its end']) });
    const placed = [
      '`holds a part’s bytes: …`',
      '`… its end`',
      '`holds … bytes: … its end`',
      '`h… a part’s … each one, …`',
    ];
    const unplaced = [
      '`holds a part’s bytes: each one, its end…`',
      '`…holds a part’s bytes: each one, its end`',
      "`holds a part's bytes: …`",
    ];

    assert.deepEqual(problemsAlone(placed.join(', '), pools), []);
    assert.deepEqual(failedOf(problemsAlone(unplaced.join(', '), pools)), [
      ...unplaced.map((span) => {
        return span.slice(1, -1);
      }),
    ]);
  });

  test('fills a title built at run time only with a literal of its file, an entry or …', () => {
    const file = 'implementations/typescript/src/client/__tests__/interop.test.ts';
    const pools = poolsWith({
      templates: [
        { parts: ['over ', ''], file },
        { parts: ['gives each token its verdict: ', ''], file: 'jwt-verifier.test.ts' },
      ],
      literals: new Map([
        [file, new Set(['HTTP', 'MQTT 5'])],
        ['jwt-verifier.test.ts', new Set()],
      ]),
      cases: new Set(['HTTP', 'MQTT 5', 'an unknown key']),
      entries: new Set(['an expired token']),
    });
    const text = [
      `\`${OVER}HTTP\`, \`${OVER}MQTT 5\`, \`${OVER}…\`, \`gives each token its verdict: an expired token\`;`,
      `\`${OVER}HTTX\`, \`gives each token its verdict: an unknown key\``,
    ].join('\n');

    assert.deepEqual(failedOf(problemsAlone(text, pools)), [
      `${OVER}HTTX`,
      'gives each token its verdict: an unknown key',
    ]);
  });

  test('fails a literal LITERALS lists that no citation holds', () => {
    const literals = Object.keys(LITERALS);
    const all = literals
      .map((literal) => {
        return `\`${literal}\``;
      })
      .join(', ');
    const holding = (problems) => {
      return problems.filter((problem) => {
        return problem.includes('LITERALS holds');
      });
    };

    assert.deepEqual(holding(problemsOf(all, poolsWith({}))), []);
    assert.deepEqual(holding(problemsOf(all.replace('`a redirect`', ''), poolsWith({}))), [
      'tools/check-citations.mjs: LITERALS holds a redirect, which docs/support.md no longer cites',
    ]);
  });

  test('fails under a floor, and holds no floor when given files', () => {
    const pools = poolsWith({ paths: new Set(['a.test.ts']) });

    assert.deepEqual(
      problemsOf('`a.test.ts`', pools).filter((problem) => {
        return problem.includes('floor');
      }),
      Object.entries(FLOORS).map(([kind, floor]) => {
        return `${SUPPORT}: placed ${kind === 'paths' ? 1 : 0} ${kind}, under its floor of ${floor}`;
      })
    );
    assert.deepEqual(problemsAlone('`a.test.ts`', pools), []);
  });
});
