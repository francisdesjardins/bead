import { expect, test } from '@playwright/test';
import { codeOfTree, isWhole, textOfTree, treeOfText } from '../tree';

// definition

test.describe('treeOfText', () => {
  test('reads a text preview that holds an object or an array as JSON, and nothing else', () => {
    expect(treeOfText('{"a": [1]}')).toEqual({
      entries: [['a', { items: [1], type: 'array' }]],
      type: 'object',
    });
    expect(treeOfText('42')).toBeUndefined();
    expect(treeOfText('{"a": …')).toBeUndefined();
    expect(treeOfText(undefined)).toBeUndefined();
  });
});

test.describe('textOfTree', () => {
  test('writes a tree out, a line a value, two spaces a level, its tags as the text preview writes them', () => {
    expect(
      textOfTree({
        entries: [
          ['a', { items: [1, { digits: '2', type: 'bigint' }], more: 3, type: 'array' }],
          ['b', { hex: '01', length: 1, type: 'bytes' }],
        ],
        type: 'object',
      })
    ).toBe(
      ['{', '  "a": [', '    1', '    2n', '    … 3 more', '  ]', '  "b": <1 bytes: 01>', '}'].join(
        '\n'
      )
    );
  });
});

test.describe('isWhole and codeOfTree', () => {
  test('write a whole tree as JavaScript that makes its value again, and none for one cut short', () => {
    expect(
      codeOfTree({
        entries: [
          ['a', { items: [1, 'b'], type: 'set' }],
          ['c', { hex: '01 ff', length: 2, type: 'bytes' }],
          ['d', { digits: '9', type: 'bigint' }],
          ['e', { entries: [['k', null]], type: 'map' }],
        ],
        type: 'object',
      })
    ).toBe(
      '{ "a": new Set([1, "b"]), "c": new Uint8Array([0x01, 0xff]), "d": 9n, "e": new Map([["k", null]]) }'
    );
    expect(isWhole({ items: [1], more: 2, type: 'array' })).toBe(false);
    expect(isWhole({ hex: '00', length: 40, type: 'bytes' })).toBe(false);
    expect(
      codeOfTree({ entries: [['a', { reason: 'depth', type: 'cut' }]], type: 'object' })
    ).toBeUndefined();
    expect(codeOfTree({ entries: [], type: 'object' })).toBe('{}');
  });
});
