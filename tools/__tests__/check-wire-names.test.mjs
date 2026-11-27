import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  blankOf,
  definitionsOf,
  entriesOf,
  formProblemsOf,
  integerOf,
  keyOf,
  literalOf,
  modulesOf,
  problemsOf,
  reasonOf,
  renderingOf,
  rowsOf,
  SELF,
  selfFailuresOf,
  SIDES,
  TABLE,
} from '../check-wire-names.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

// a table of one row over three modules, and those modules, read from memory
const HEAD = '# format\tconcept\tstandard\tvalue\ttypescript\tcsharp\trust';
const READS = 'websocket\t@reads\tRFC 6455\t-\t-: none\t-: none\t-: none';
const TS = 'implementations/typescript/src/frame.ts';
const CS = 'implementations/dotnet/src/Frame.cs';
const RS = 'implementations/rust/crates/bead/src/frame.rs';

const problemsOver = (rows, files) => {
  return problemsOf([HEAD, READS, ...rows].join('\n'), {
    read: (path) => {
      return files[path];
    },
    exists: (path) => {
      return Object.hasOwn(files, path);
    },
  });
};

describe('its own cases', () => {
  for (const each of SELF) {
    test(each.title, () => {
      assert.deepEqual(selfFailuresOf([each]), []);
    });
  }
});

describe('the table', () => {
  test("reads a row's fields, skipping its head and its blank lines", () => {
    const rows = rowsOf(`${HEAD}\n\nwebsocket\tFIN_BIT\tRFC 6455 §5.2\t0x80\ta\tb\tc\r\n`);

    assert.deepEqual(rows, [
      {
        line: 3,
        fields: 7,
        format: 'websocket',
        concept: 'FIN_BIT',
        standard: 'RFC 6455 §5.2',
        value: '0x80',
        cells: { typescript: 'a', csharp: 'b', rust: 'c' },
      },
    ]);
  });

  test("reads a cell's paths, each with the name its module writes where it gives one", () => {
    assert.deepEqual(entriesOf(`${CS}#BrokerParcelCodes.NormalClosure, ${RS}`), [
      { path: CS, name: 'BrokerParcelCodes.NormalClosure' },
      { path: RS, name: undefined },
    ]);
  });

  test("reads a -'s reason, and none where it gives none", () => {
    assert.equal(reasonOf('-: MQTT.js writes it'), 'MQTT.js writes it');
    assert.equal(reasonOf('-'), undefined);
    assert.equal(reasonOf('-:'), undefined);
    assert.equal(reasonOf('-: '), undefined);
  });

  test("lists a side's modules once each, its holders and its readers alike", () => {
    const text = [
      HEAD,
      `websocket\t@reads\tRFC 6455\t-\t${TS.replace('frame', 'meter')}\t-: none\t-: none`,
      `websocket\tFIN_BIT\tRFC 6455 §5.2\t0x80\t${TS}\t${CS}\t${RS}`,
      `websocket\tMASK_BIT\tRFC 6455 §5.2\t0x80\t${TS}\t${CS}#Frame.MaskBit\t${RS}, ${RS.replace('frame', 'other')}`,
    ].join('\n');

    assert.deepEqual(modulesOf(text, 'typescript'), [TS.replace('frame', 'meter'), TS]);
    assert.deepEqual(modulesOf(text, 'csharp'), [CS]);
    assert.deepEqual(modulesOf(text, 'rust'), [RS, RS.replace('frame', 'other')]);
  });

  test('reads a cell that opens with - as its reason whole, never as paths', () => {
    const reason = "-: the platform's, WebSocketCloseStatus.Empty, #1005";
    const text = [
      HEAD,
      READS,
      `websocket\tNO_STATUS_RECEIVED\tRFC 6455 §7.4.1\t1005\t${reason}\t${reason}\t${RS}`,
    ].join('\n');

    assert.deepEqual(modulesOf(text, 'typescript'), []);
    assert.deepEqual(modulesOf(text, 'csharp'), []);
    assert.deepEqual(modulesOf(text, 'rust'), [RS]);
    assert.deepEqual(
      problemsOver([text.split('\n')[2]], {
        [RS]: 'const NO_STATUS_RECEIVED: u16 = 1005;\n',
      }),
      [
        `${TABLE}: the typescript column names no module`,
        `${TABLE}: the csharp column names no module`,
      ]
    );
  });

  test("the repository's table holds its form: each row's fields, case, value and reasons", () => {
    const text = readFileSync(resolve(ROOT, TABLE), 'utf8');

    assert.deepEqual(formProblemsOf(rowsOf(text)), []);
    for (const side of SIDES) {
      assert.ok(modulesOf(text, side).length > 0, side);
    }
  });
});

describe('the names', () => {
  test('two renderings are one name when their letters agree, underscores removed and case ignored', () => {
    assert.equal(keyOf('PUBACK'), keyOf('PubAck'));
    assert.equal(keyOf('SGROUP'), keyOf('SGroup'));
    assert.equal(keyOf('LARGEST_SMALLUINT'), keyOf('LargestSmallUint'));
    assert.notEqual(keyOf('FIN_BIT'), keyOf('FinalBit'));
  });

  test("a side's name where its cell gives none: the concept, in PascalCase on C#", () => {
    assert.equal(renderingOf('EXTENDED_LENGTH_16', 'typescript'), 'EXTENDED_LENGTH_16');
    assert.equal(renderingOf('EXTENDED_LENGTH_16', 'rust'), 'EXTENDED_LENGTH_16');
    assert.equal(renderingOf('EXTENDED_LENGTH_16', 'csharp'), 'ExtendedLength16');
    assert.equal(renderingOf('GRANTED_QOS_1', 'csharp'), 'GrantedQos1');
    assert.equal(renderingOf('LONGEST_VBIN8', 'csharp'), 'LongestVbin8');
  });
});

describe('the literals', () => {
  test('reads an integer literal, hex, binary or decimal, with its underscores', () => {
    assert.equal(integerOf('0x7F'), 127n);
    assert.equal(integerOf('0b0010'), 2n);
    assert.equal(integerOf('16_384'), 16_384n);
    assert.equal(integerOf('0x1_0000'), 65_536n);
    assert.equal(integerOf('0x'), undefined);
    assert.equal(integerOf('12_'), undefined);
    assert.equal(integerOf('twelve'), undefined);
  });

  test("reads each side's suffix, Rust's byte and character literals, C#'s and a cast", () => {
    assert.equal(literalOf('0x80_u8', 'rust'), 128n);
    assert.equal(literalOf('128u8', 'rust'), 128n);
    assert.equal(literalOf('1_000 as u16', 'rust'), 1000n);
    assert.equal(literalOf("b'\"'", 'rust'), 34n);
    assert.equal(literalOf("b'\\\\'", 'rust'), 92n);
    assert.equal(literalOf("b'\\x1f'", 'rust'), 31n);
    assert.equal(literalOf("'\\u{feff}'", 'rust'), 0xfeffn);
    assert.equal(literalOf('0xFFUL', 'csharp'), 255n);
    assert.equal(literalOf("'\\u001F'", 'csharp'), 31n);
    assert.equal(literalOf('(WebSocketCloseStatus)1013', 'csharp'), 1013n);
    assert.equal(literalOf('0x01n', 'typescript'), 1n);
  });

  test('reads no value from an expression, a name or a literal of another side', () => {
    assert.equal(literalOf('2 + 8 + 4', 'typescript'), undefined);
    assert.equal(literalOf('LONGEST_VARINT - 1', 'rust'), undefined);
    assert.equal(literalOf('CONTINUATION_BIT', 'csharp'), undefined);
    assert.equal(literalOf("'\"'", 'typescript'), undefined);
    assert.equal(literalOf('0x80_u8', 'csharp'), undefined);
    assert.equal(literalOf('[0xEF, 0xBB, 0xBF]', 'rust'), undefined);
  });
});

describe('reading a module', () => {
  test('blanks comments and literals, keeping the length and the lines', () => {
    const text = 'const A = 1; // a { brace\nconst B = "}"; /* and\n{ */ const C = `x${"{"}`;\n';
    const blank = blankOf(text, 'typescript');

    assert.equal(blank.length, text.length);
    assert.equal(blank.split('\n').length, text.split('\n').length);
    assert.doesNotMatch(blank, /[{}"`]/);
    assert.match(blank, /const C = /);
  });

  test("blanks Rust's raw strings and character literals, and keeps a lifetime", () => {
    const text = "const A: &str = r#\"}\"#;\nconst B: char = '{';\nfn f<'a>(x: &'a u8) {}\n";
    const blank = blankOf(text, 'rust');

    assert.equal(blank.length, text.length);
    assert.match(blank, /fn f<'a>\(x: &'a u8\) \{\}/);
    assert.doesNotMatch(blank.split('\n').slice(0, 2).join('\n'), /[{}]/);
  });

  test("blanks C#'s verbatim, interpolated and raw strings", () => {
    const text = 'var a = @"a "" }";\nvar b = $"{x} }";\nvar c = """\n}\n""";\nconst int D = 1;\n';
    const blank = blankOf(text, 'csharp');

    assert.equal(blank.length, text.length);
    assert.doesNotMatch(blank, /[{}]/);
    assert.match(blank, /const int D = 1;/);
  });

  test('finds a Rust item gated by a feature, and one whose value stands on the next line', () => {
    const text =
      '#[cfg(feature = "websocket")]\npub(crate) const OPCODE_MASK: u8 = 0x0F;\nconst LARGEST: u64 =\n    0xFFFF_FFFF;\n';

    assert.deepEqual(definitionsOf(text, 'rust', 'OPCODE_MASK'), [{ line: 2, expression: '0x0F' }]);
    assert.deepEqual(definitionsOf(text, 'rust', 'LARGEST'), [
      { line: 3, expression: '0xFFFF_FFFF' },
    ]);
  });

  test("finds a holder's members at its own depth alone, not a nested object's", () => {
    const text =
      "const NAMES = Object.freeze({\n  PUBACK: { name: 'a PUBACK', PUBACK: 9 },\n  SUBACK: 9,\n});\n";

    assert.deepEqual(definitionsOf(text, 'typescript', 'NAMES.SUBACK'), [
      { line: 3, expression: '9' },
    ]);
    assert.equal(definitionsOf(text, 'typescript', 'NAMES.PUBACK').length, 1);
  });

  test('finds a whole name alone: PUBACK is not PUBACK_CODES', () => {
    const text = 'const PUBACK_CODES: [u8; 1] = [0x00];\n';

    assert.deepEqual(definitionsOf(text, 'rust', 'PUBACK'), []);
  });

  test('finds no holder that is not there, nor one written twice', () => {
    const text = 'const A = Object.freeze({ X: 1 });\nconst A = Object.freeze({ X: 1 });\n';

    assert.deepEqual(definitionsOf(text, 'typescript', 'B.X'), []);
    assert.deepEqual(definitionsOf(text, 'typescript', 'A.X'), []);
  });
});

describe('the problems', () => {
  test("name the row's line, its format and concept, and the side", () => {
    const problems = problemsOver(
      [`websocket\tFIN_BIT\tRFC 6455 §5.2\t0x80\t${TS}\t${CS}\t${RS}`],
      {
        [TS]: 'export const FIN_BIT = 0x80;\n',
        [CS]: 'internal const byte FinBit = 0x80;\n',
      }
    );

    assert.deepEqual(problems, [`${TABLE}:3: websocket FIN_BIT, rust: ${RS} does not exist`]);
  });

  test('fail a format with no row of its readers, and one with two', () => {
    const problems = rowsOf(
      [
        HEAD,
        `mqtt\tPUBACK\tMQTT 5.0 §2.1.2\t4\t${TS}\t${CS}\t${RS}`,
        READS,
        READS.replace('RFC 6455', 'RFC 6455 again'),
      ].join('\n')
    );

    assert.deepEqual(
      formProblemsOf(problems).filter((problem) => {
        return problem.includes('@reads');
      }),
      [
        `${TABLE}:4: websocket @reads has a row already`,
        `${TABLE}: websocket has 2 @reads rows, not one`,
        `${TABLE}: mqtt has no @reads row`,
      ]
    );
  });

  test("fail a value of a readers' row other than -, and a reader written with a name", () => {
    const rows = rowsOf(
      [HEAD, `websocket\t@reads\tRFC 6455\t0x80\t${TS}#X\t-: none\t-: none`].join('\n')
    );

    assert.deepEqual(formProblemsOf(rows).slice(0, 2), [
      `${TABLE}:2: websocket @reads's value is "0x80", not "-"`,
      `${TABLE}:2: websocket @reads, typescript: a reader's path names no name`,
    ]);
  });
});
