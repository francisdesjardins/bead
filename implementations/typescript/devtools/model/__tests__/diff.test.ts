import { expect, test } from '@playwright/test';
import { diffLines, diffPayloads } from '../diff';

// definition

test.describe('diffLines', () => {
  test('keeps the longest run of lines two texts share, and takes out or puts in the rest', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
      { change: 'same', text: 'a' },
      { change: 'removed', text: 'b' },
      { change: 'added', text: 'x' },
      { change: 'same', text: 'c' },
      { change: 'added', text: 'd' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ change: 'added', text: 'a' }]);
  });
});

test.describe('diffPayloads', () => {
  test('compares two payloads by their trees written out, a line a field, or by their texts', () => {
    expect(
      diffPayloads({ text: '{"value": 42, "at": 1}' }, { text: '{"value": 47, "at": 1}' }).filter(
        ({ change }) => {
          return change !== 'same';
        }
      )
    ).toEqual([
      { change: 'removed', text: '  "value": 42' },
      { change: 'added', text: '  "value": 47' },
    ]);
    expect(diffPayloads({ text: '"a"' }, { text: '"a"' })).toEqual([
      { change: 'same', text: '"a"' },
    ]);
  });
});
