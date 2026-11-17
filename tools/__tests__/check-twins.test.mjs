import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import {
  checkOf,
  countsOf,
  cSharpDeclarationsOf,
  declarationsOf,
  keyOf,
  rowsOf,
  runOf,
  rustDeclarationsOf,
  scriptDeclarationsOf,
  TWINS,
} from '../check-twins.mjs';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// ! a fixture's source is a string of this file, which the real run reads as no declaration: a
// title held in a string is no call

const HEADER = ['# side\tfile\ttitle\tclass\treason'];

const TS_FILE = 'implementations/typescript/src/a/__tests__/a.test.ts';
const CS_FILE = 'implementations/dotnet/tests/Bead.Core.Tests/ATests.cs';
const RS_FILE = 'implementations/rust/crates/bead/src/a/tests.rs';

// a file's source from its lines
const sourceOf = (...lines) => {
  return lines.join('\n');
};

// the titles a TypeScript source declares
const scriptTitlesOf = (...lines) => {
  return scriptDeclarationsOf(sourceOf(...lines)).map(({ title }) => {
    return title;
  });
};

// declarations read from files held in memory
const declarationsWith = (files) => {
  return declarationsOf(Object.keys(files), (path) => {
    return files[path];
  });
};

// a twins file from its rows, each its five cells
const twinsOf = (...rows) => {
  return `${[...HEADER, ...rows.map((cells) => cells.join('\t'))].join('\n')}\n`;
};

// a TypeScript test, a C# test and a Rust test, the C# one alone twinned
const FILES = Object.freeze({
  [TS_FILE]: sourceOf("test('reads a frame', () => {});", "test('reads a frame', () => {});"),
  [CS_FILE]: sourceOf('    [Fact]', '    public void Writes_a_frame()', '    {', '    }'),
  [RS_FILE]: sourceOf('#[test]', 'fn writes_a_frame() {}'),
});

// ── Keys ───────────────────────────────────────────────────────────────────────

describe('keyOf', () => {
  test('writes a title in snake case, its punctuation and its case dropped', () => {
    assert.equal(keyOf('Refuses a frame: its length, "0"!'), 'refuses_a_frame_its_length_0');
    assert.equal(keyOf('Refuses_a_frame_its_length_0'), 'refuses_a_frame_its_length_0');
  });

  test('joins a possessive to its word, curly or straight', () => {
    assert.equal(keyOf('a proto map’s entries'), 'a_proto_maps_entries');
    assert.equal(keyOf('A_proto_map_s_entries'), 'a_proto_maps_entries');
  });

  test('splits camel case, but the words it would cut in two', () => {
    assert.equal(keyOf('calls getStatus over WebSocket'), 'calls_get_status_over_websocket');
    assert.equal(keyOf('Reads_an_IPv6_host_in_TypeScript'), 'reads_an_ipv6_host_in_typescript');
  });

  test('reads a superscript as its own word and µ as u', () => {
    assert.equal(keyOf('a revision up to 2³¹'), 'a_revision_up_to_2_31');
    assert.equal(keyOf('waits 500 µs'), 'waits_500_us');
  });

  test('leaves out a trailing spec label, and keeps one inside the title', () => {
    assert.equal(keyOf('fails its start (spec 15.33)'), 'fails_its_start');
    assert.equal(keyOf('Fails_its_start_spec_15_33'), 'fails_its_start');
    assert.equal(keyOf('reads spec 4.4 first'), 'reads_spec_4_4_first');
  });
});

// ── Declarations ───────────────────────────────────────────────────────────────

describe('scriptDeclarationsOf', () => {
  test('reads each test or it, a modifier between, with its line', () => {
    assert.deepEqual(
      scriptDeclarationsOf(
        sourceOf(
          "test('one', () => {});",
          '',
          'it.only("two", () => {});',
          "test.skip.fixme('three')"
        )
      ),
      [
        { title: 'one', line: 1 },
        { title: 'two', line: 3 },
        { title: 'three', line: 4 },
      ]
    );
  });

  test('reads no group, no step, no member called test and no title built by an expression', () => {
    assert.deepEqual(
      scriptTitlesOf(
        "test.describe('a group', () => {});",
        "test.step('a step', () => {});",
        "describe('another group', () => {});",
        "if (/x/.test('a value')) {}",
        "test('a ' + name, () => {});",
        'test(title, () => {});'
      ),
      []
    );
  });

  test('reads no call held in a comment, a string or a regular expression', () => {
    assert.deepEqual(
      scriptTitlesOf(
        "// test('in a line comment')",
        "/* test('in a block comment') */",
        'const source = "test(\'in a string\')";',
        "const quote = /'/;",
        "test('after them', () => {});"
      ),
      ['after them']
    );
  });

  test('reads a string with its escapes, and a template with a substitution as it is written', () => {
    assert.deepEqual(
      scriptTitlesOf(
        "test('the platform\\u2019s \\'own\\'', () => {});",
        'test(`a ${kind} of ${String(size)} bytes`, () => {});',
        'test(`plain`, () => {});'
      ),
      ["the platform’s 'own'", 'a ${kind} of ${String(size)} bytes', 'plain']
    );
  });

  test('reads past a template whose substitution holds braces and a string', () => {
    assert.deepEqual(
      scriptTitlesOf("const a = `${{ b: '}' }.b}`;", "test('after it', () => {});"),
      ['after it']
    );
  });

  test('builds the two titles a seed loop declares', () => {
    assert.deepEqual(
      scriptTitlesOf(
        'for (const seed of [1, 2]) {',
        '  test(`plays seed ${String(seed)}`, () => {});',
        '}'
      ),
      ['plays seed 1', 'plays seed 2']
    );
  });
});

describe('cSharpDeclarationsOf', () => {
  test('reads the public method after a Fact or a Theory, past the attributes between', () => {
    assert.deepEqual(
      cSharpDeclarationsOf(
        sourceOf(
          '    [Fact]',
          '    public void Reads_a_frame()',
          '    [Theory]',
          '    [InlineData(1)]',
          '    public async Task Reads_a_frame_of_each_size(int size)',
          '    private static void Helper()',
          '    public void Not_a_test()'
        )
      ),
      [
        { title: 'Reads_a_frame', line: 2 },
        { title: 'Reads_a_frame_of_each_size', line: 5 },
      ]
    );
  });
});

describe('rustDeclarationsOf', () => {
  test('reads the fn after a test attribute, and a trial named by a literal', () => {
    assert.deepEqual(
      rustDeclarationsOf(
        RS_FILE,
        sourceOf(
          '#[test]',
          'fn reads_a_frame() {}',
          '#[tokio::test(flavor = "current_thread")]',
          'async fn reads_a_stream() {}',
          '#[test_case(1)]',
          'fn not_a_test() {}',
          'let trial = Trial::test(',
          '    "plays its table",',
          '    run,',
          ');'
        )
      ),
      [
        { title: 'reads_a_frame', line: 2 },
        { title: 'reads_a_stream', line: 4 },
        { title: 'plays its table', line: 7 },
      ]
    );
  });

  test('reads the trials a player names from its entries in that player alone', () => {
    const player = sourceOf(
      'Trial::test(',
      '    format!("templates: {}", entry.name),',
      '    move || run(&entry),',
      ')'
    );

    assert.deepEqual(
      rustDeclarationsOf('implementations/rust/crates/bead-protobuf/tests/transcoding.rs', player),
      [{ title: 'templates: ${entry.name}', line: 2 }]
    );
    assert.deepEqual(rustDeclarationsOf(RS_FILE, player), []);
  });

  test('reads the codec players’ trials, `<sentence>: ${entry.name}`', () => {
    assert.deepEqual(
      rustDeclarationsOf(
        'implementations/rust/crates/bead/tests/codecs.rs',
        'let name = format!("reads_each_payload: {}", payload.name);'
      ),
      [{ title: 'reads_each_payload: ${entry.name}', line: 1 }]
    );
  });
});

describe('declarationsOf', () => {
  test('reads each side from its folders alone, a generated C# file aside', () => {
    const declarations = declarationsWith({
      ...FILES,
      'builder/src/__tests__/b.test.ts': "test('builds', () => {});",
      'tools/__tests__/t.test.mjs': "test('checks', () => {});",
      'site/__tests__/s.test.mjs': "test('serves', () => {});",
      'implementations/dotnet/tests/Bead.Core.Tests/Generated/G.cs':
        '[Fact]\npublic void Generated()',
      'implementations/dotnet/src/Bead.Core/C.cs': '[Fact]\npublic void Not_a_test()',
    });

    assert.deepEqual(
      declarations.typescript.map(({ title }) => {
        return title;
      }),
      ['builds', 'reads a frame', 'reads a frame', 'checks']
    );
    assert.deepEqual(declarations.csharp, [
      { file: CS_FILE, line: 2, title: 'Writes_a_frame', key: 'writes_a_frame' },
    ]);
  });
});

// ── Rows ───────────────────────────────────────────────────────────────────────

describe('rowsOf', () => {
  test('reads a row of five cells, its comments kept', () => {
    const { comments, rows, problems } = rowsOf(
      twinsOf(['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'])
    );

    assert.deepEqual(comments, HEADER);
    assert.deepEqual(rows, [
      {
        side: 'typescript',
        file: TS_FILE,
        title: 'reads a frame',
        kind: 'native',
        reason: 'Its platform’s.',
        line: 2,
      },
    ]);
    assert.deepEqual(problems, []);
  });

  test('refuses a row of the wrong shape, side or class, with no reason, twice or out of order', () => {
    const { problems } = rowsOf(
      twinsOf(
        ['typescript', TS_FILE, 'reads a frame', 'native'],
        ['rust', RS_FILE, 'reads_a_frame', 'native', 'A reason.'],
        ['typescript', TS_FILE, 'writes a frame', 'twinned', 'A reason.'],
        ['typescript', TS_FILE, 'writes a frame', 'native', '-'],
        ['typescript', TS_FILE, 'writes a frame', 'native', 'A reason.'],
        ['typescript', TS_FILE, 'reads a frame', 'native', 'A reason.']
      )
    );

    assert.deepEqual(problems, [
      `${TWINS}:2: 4 cells, not 5: side, file, title, class, reason`,
      `${TWINS}:3: side \`rust\` is none of typescript, csharp`,
      `${TWINS}:4: class \`twinned\` is none of retitled, held, ahead, native, pending`,
      `${TWINS}:5: a native row with no reason`,
      `${TWINS}:5: a second row for \`writes a frame\` in ${TS_FILE}`,
      `${TWINS}:6: a second row for \`writes a frame\` in ${TS_FILE}`,
      `${TWINS}:7: out of order, by side, file and title: --write sorts the rows`,
    ]);
  });
});

// ── Check ──────────────────────────────────────────────────────────────────────

describe('checkOf', () => {
  test('passes a declaration twinned on the Rust side, and one a row classifies', () => {
    const { problems } = checkOf(
      declarationsWith(FILES),
      twinsOf(['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'])
    );

    assert.deepEqual(problems, []);
  });

  test('fails a declaration with no twin and no row, and writes it pending, once a title', () => {
    const { problems, written } = checkOf(declarationsWith(FILES), twinsOf());

    assert.deepEqual(problems, [
      `${TS_FILE}:1: \`reads a frame\` has no Rust twin and no row in ${TWINS}: run --write, then classify it`,
    ]);
    assert.equal(written, twinsOf(['typescript', TS_FILE, 'reads a frame', 'pending', '-']));
  });

  test('fails a pending row, which --write keeps as it is', () => {
    const twins = twinsOf(['typescript', TS_FILE, 'reads a frame', 'pending', '-']);
    const { problems, written } = checkOf(declarationsWith(FILES), twins);

    assert.deepEqual(problems, [
      `${TWINS}:2: pending: \`reads a frame\` in ${TS_FILE} awaits its class`,
    ]);
    assert.equal(written, twins);
  });

  test('fails a row whose declaration is twinned, which --write drops', () => {
    const { problems, written, dropped } = checkOf(
      declarationsWith(FILES),
      twinsOf(
        ['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'],
        ['csharp', CS_FILE, 'Writes_a_frame', 'native', 'Its platform’s.']
      )
    );

    assert.deepEqual(problems, [
      `${TWINS}:3: \`Writes_a_frame\` in ${CS_FILE} is twinned on the Rust side: drop the row`,
    ]);
    assert.equal(dropped.length, 1);
    assert.equal(
      written,
      twinsOf(['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'])
    );
  });

  test('fails a row whose declaration is gone, which --write keeps for its reader', () => {
    const twins = twinsOf(
      ['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'],
      ['typescript', TS_FILE, 'reads a frame twice', 'native', 'Its platform’s.']
    );
    const { problems, written } = checkOf(declarationsWith(FILES), twins);

    assert.deepEqual(problems, [`${TWINS}:3: ${TS_FILE} declares no \`reads a frame twice\``]);
    assert.equal(written, twins);
  });

  test('counts the declarations, those twinned and the rows by class', () => {
    const declarations = declarationsWith(FILES);
    const { rows, unmatched } = checkOf(
      declarations,
      twinsOf(['typescript', TS_FILE, 'reads a frame', 'native', 'Its platform’s.'])
    );

    assert.deepEqual(countsOf(declarations, rows, unmatched), {
      declarations: { typescript: 2, csharp: 1, rust: 1 },
      twinned: 1,
      classes: { retitled: 0, held: 0, ahead: 0, native: 1, pending: 0 },
    });
  });
});

describe('runOf', () => {
  test('reads the files git lists, and --write adds what a reader then classifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-twins-'));

    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      for (const [path, source] of Object.entries(FILES)) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), source);
      }
      mkdirSync(join(root, 'tools'));
      writeFileSync(join(root, TWINS), twinsOf());
      writeFileSync(join(root, '.gitignore'), 'ignored/\n');
      mkdirSync(join(root, 'ignored/typescript'), { recursive: true });
      writeFileSync(join(root, 'ignored/typescript/i.test.ts'), "test('ignored', () => {});");

      assert.equal(runOf(root).problems.length, 1);

      const written = runOf(root, { write: true });

      assert.equal(written.added.length, 1);
      assert.deepEqual(written.problems, [
        `${TWINS}:2: pending: \`reads a frame\` in ${TS_FILE} awaits its class`,
      ]);

      const twins = readFileSync(join(root, TWINS), 'utf8');

      writeFileSync(join(root, TWINS), twins.replace('pending\t-', 'native\tIts platform’s.'));
      assert.deepEqual(runOf(root).problems, []);
      assert.equal(runOf(root, { write: true }).added.length, 0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
