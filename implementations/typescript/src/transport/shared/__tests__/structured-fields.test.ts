import { expect, test } from '@playwright/test';
import { type BareItem, parseItem } from '../structured-fields';

// constants

/** A bare item as a row writes it: its type, then its value, a Byte Sequence's as its bytes. */
type Bare = [type: BareItem['type'], value: boolean | number | number[] | string];

/** What a row expects: none where parsing fails, else the bare item and its parameters in order. */
type Parsed = undefined | Bare | [...Bare, parameters: [key: string, value: Bare][]];

// the Items of httpwg's structured-field-tests, by file (an Item's raw lines, several given as an
// array), each with what RFC 9651 §4.2 reads: the C# side reads the same rows
const HTTPWG: [raw: string | string[], parsed: Parsed][] = [
  // item.json
  ['', undefined],
  [' \t 1', undefined],
  ['1 \t ', undefined],
  ['  1  ', ['integer', 1]],
  ['     1  ', ['integer', 1]],
  // number.json
  ['42', ['integer', 42]],
  ['0', ['integer', 0]],
  ['-0', ['integer', 0]],
  ['--0', undefined],
  ['-42', ['integer', -42]],
  ['042', ['integer', 42]],
  ['-042', ['integer', -42]],
  ['00', ['integer', 0]],
  ['2,3', undefined],
  ['-a23', undefined],
  ['4-2', undefined],
  ['- 42', undefined],
  ['123456789012345', ['integer', 123456789012345]],
  ['-123456789012345', ['integer', -123456789012345]],
  ['1234567890123456', undefined],
  ['-1234567890123456', undefined],
  ['1.23', ['decimal', 1.23]],
  ['-1.23', ['decimal', -1.23]],
  ['1. 23', undefined],
  ['1 .23', undefined],
  ['- 1.23', undefined],
  ['123456789012.1', ['decimal', 123456789012.1]],
  ['1.5.4', undefined],
  ['1..4', undefined],
  ['1.123', ['decimal', 1.123]],
  ['-1.123', ['decimal', -1.123]],
  ['1.', undefined],
  ['1.1234', undefined],
  ['-1.1234', undefined],
  ['1234567890123.0', undefined],
  ['-1234567890123.0', undefined],
  ['1.20', ['decimal', 1.2]],
  ['1.200', ['decimal', 1.2]],
  ['1.230', ['decimal', 1.23]],
  // string.json
  ['"foo bar"', ['string', 'foo bar']],
  ['""', ['string', '']],
  ['"   "', ['string', '   ']],
  ['"f\u00FC\u00FC"', undefined],
  ['"\t"', undefined],
  ['" \n "', undefined],
  ["'foo'", undefined],
  ['"foo', undefined],
  ['"foo \\"bar\\" \\\\ baz"', ['string', 'foo "bar" \\ baz']],
  ['"foo \\,"', undefined],
  ['"foo \\"', undefined],
  ['"foo \\', undefined],
  [
    ['"foo', 'bar"'],
    ['string', 'foo, bar'],
  ],
  // token.json
  ['a_b-c.d3:f%00/*', ['token', 'a_b-c.d3:f%00/*']],
  ['fooBar', ['token', 'fooBar']],
  ['FooBar', ['token', 'FooBar']],
  // binary.json
  [':aGVsbG8=:', ['byte-sequence', [104, 101, 108, 108, 111]]],
  ['::', ['byte-sequence', []]],
  [':=aGVsbG8=:', undefined],
  [':a=GVsbG8=:', undefined],
  [':aGVsbG8:', ['byte-sequence', [104, 101, 108, 108, 111]]],
  [':uuueGVsbG8=:', undefined],
  [':aGVsbG8==:', undefined],
  [':aGVsbG8.:', undefined],
  [':aGVsbG8=', undefined],
  [':aGVsb G8=:', undefined],
  [':    :', undefined],
  [':aGVsbG!8=:', undefined],
  [':aGVsbG8=!:', undefined],
  [':iZ==:', ['byte-sequence', [137]]],
  [':/+Ah:', ['byte-sequence', [255, 224, 33]]],
  [':_-Ah:', undefined],
  [':', undefined],
  // boolean.json
  ['?1', ['boolean', true]],
  ['?0', ['boolean', false]],
  ['?Q', undefined],
  ['? 1', undefined],
  ['?-0', undefined],
  ['?T', undefined],
  ['?F', undefined],
  ['?t', undefined],
  ['?f', undefined],
  ['?True', undefined],
  ['?False', undefined],
  ['?', undefined],
  // date.json
  ['@0', ['date', 0]],
  ['@1659578233', ['date', 1659578233]],
  ['@-1659578233', ['date', -1659578233]],
  ['@2147483648', ['date', 2147483648]],
  ['@4294967296', ['date', 4294967296]],
  ['@253402214400', ['date', 253402214400]],
  ['@-62135596800', ['date', -62135596800]],
  ['@1659578233.12', undefined],
  ['@999999999999999', ['date', 999999999999999]],
  ['@-999999999999999', ['date', -999999999999999]],
  ['@1000000000000000', undefined],
  ['@-1000000000000000', undefined],
  ['@-0', ['date', 0]],
  ['@', undefined],
  ['@-', undefined],
  ['@ 12345678', undefined],
  ['@abc', undefined],
  // display-string.json
  ['%"foo bar"', ['display-string', 'foo bar']],
  [
    '%" !%22#$%25&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"',
    [
      'display-string',
      ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
    ],
  ],
  ['%"f%C3%BC%C3%BC"', undefined],
  ['%"f%c3%bc%c3%bc"', ['display-string', 'f\u00FC\u00FC']],
  ['%"f\u00FC\u00FC"', undefined],
  ['%"\t"', undefined],
  ['%"\n"', undefined],
  ['%"\u001F"', undefined],
  ['%"\u007F"', undefined],
  ['%"%0a"', ['display-string', '\n']],
  ['%"%1f"', ['display-string', '\u001F']],
  ['%"%7f"', ['display-string', '\u007F']],
  ["%'foo'", undefined],
  ['%foo', undefined],
  ['%foo"', undefined],
  ['%"foo', undefined],
  ['%"foo %22bar%22 \\ baz"', ['display-string', 'foo "bar" \\ baz']],
  ['%"foo %a', undefined],
  ['%"%c3%28"', undefined],
  ['%"%a0%a1"', undefined],
  ['%"%g0%1w"', undefined],
  ['%"%e2%28%a1"', undefined],
  ['%"%f0%28%8c%28"', undefined],
  ['%"BOM: %ef%bb%bf"', ['display-string', 'BOM: \uFEFF']],
  [
    ['%"foo', 'bar"'],
    ['display-string', 'foo, bar'],
  ],
  ['%"%"', undefined],
  ['%"%61"', ['display-string', 'a']],
];

// an Item's parameters (§4.2.3.2), and what Bead's own fields carry (spec 15.9)
const PARAMETERS: [raw: string, parsed: Parsed][] = [
  ['0;x=1', ['integer', 0, [['x', ['integer', 1]]]]],
  ['0;y="a;b"', ['integer', 0, [['y', ['string', 'a;b']]]]],
  ['?1;x', ['boolean', true, [['x', ['boolean', true]]]]],
  ['-0;x', ['integer', 0, [['x', ['boolean', true]]]]],
  [
    'abc;a=1;b=2; cde_456',
    [
      'token',
      'abc',
      [
        ['a', ['integer', 1]],
        ['b', ['integer', 2]],
        ['cde_456', ['boolean', true]],
      ],
    ],
  ],
  [
    '1;a=1;b=2;a=3',
    [
      'integer',
      1,
      [
        ['a', ['integer', 3]],
        ['b', ['integer', 2]],
      ],
    ],
  ],
  ['1;*a-b.c_d*=?0', ['integer', 1, [['*a-b.c_d*', ['boolean', false]]]]],
  [
    '1;a=@0;b=:AQ==:;c=%"%c3%bc";d=1.5;e=tok',
    [
      'integer',
      1,
      [
        ['a', ['date', 0]],
        ['b', ['byte-sequence', [1]]],
        ['c', ['display-string', 'ü']],
        ['d', ['decimal', 1.5]],
        ['e', ['token', 'tok']],
      ],
    ],
  ],
  ['1;a=1 ', ['integer', 1, [['a', ['integer', 1]]]]],
  ['0;X=1', undefined],
  ['1 ;a=1', undefined],
  ['1;a=', undefined],
  ['1;=1', undefined],
  ['1;a=?2', undefined],
  ['1;a=1;', undefined],
  ['1;1a=1', undefined],
  ['0, 0', undefined],
  ['0;x=1, 0', undefined],
  ['0 0', undefined],
  ['\t0', undefined],
  ['0\t', undefined],
  ['+0', undefined],
];

// helpers

/** A parsed Item as a row writes it. */
const rowOf = (raw: string): Parsed => {
  const item = parseItem(raw);

  if (item === undefined) {
    return undefined;
  }

  const bareOf = ({ type, value }: BareItem): Bare => {
    return [type, value instanceof Uint8Array ? [...value] : value];
  };
  const bare = bareOf(item.bareItem);

  return item.parameters.size === 0
    ? bare
    : [
        ...bare,
        [...item.parameters].map(([key, value]): [string, Bare] => {
          return [key, bareOf(value)];
        }),
      ];
};

// definition

test.describe('structured fields', () => {
  test('parses an Item as RFC 9651 does: its bare item of each type, its parameters in their order, and none for anything else, as httpwg’s structured-field-tests hold', () => {
    for (const [raw, parsed] of [...HTTPWG, ...PARAMETERS]) {
      const value = Array.isArray(raw) ? raw.join(', ') : raw;

      expect(rowOf(value), JSON.stringify(raw)).toEqual(parsed);
    }

    // * a sign kept on a zero would tell two counts apart that are one (§4.2.4)
    expect(Object.is(parseItem('-0')?.bareItem.value, 0)).toBe(true);
    expect(Object.isFrozen(parseItem('0;x=1'))).toBe(true);
  });
});
