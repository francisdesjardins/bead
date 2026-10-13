import { expect, test } from '@playwright/test';
import { hasWord, keeperOf, keepsCall, toggleWord } from '../filter';
import { trafficBook } from './book';

// helpers

const namesKept = (spec: string): string[] => {
  const keeper = keeperOf(spec);

  return trafficBook()
    .calls.filter((call) => {
      return keepsCall(call, keeper);
    })
    .map(({ procedureName }) => {
      return procedureName ?? '';
    });
};

// definition

test.describe('keeperOf and keepsCall', () => {
  test('keep a call when one of its steps passes, by the package’s own filter', () => {
    expect(namesKept('t(notification)')).toEqual(['counter']);
    expect(namesKept('t(command)')).toEqual(['clock']);
    expect(
      namesKept('-counter, -stats, -read, -increment, -clock, -download, -slow, -fail')
    ).toEqual(['token', 'whoami']);
    expect(namesKept('who*')).toEqual(['whoami']);
  });

  test('keep an envelope on its direction and its kind, and refuse a filter that does not hold, with the package’s reason', () => {
    const keeper = keeperOf('e(credit)');
    const credits = trafficBook().calls.flatMap(({ envelopes }) => {
      return envelopes.filter((envelope) => {
        return keeper.keepsEnvelope(envelope);
      });
    });

    expect(credits).toHaveLength(3);
    expect(() => {
      return keeperOf('d(up)');
    }).toThrow('a debug filter takes a direction among rx, tx, not "up"');
  });
});

test.describe('toggleWord and hasWord', () => {
  test('add a word at the filter’s end, or take it out where it stood, in ASCII case', () => {
    expect(toggleWord('', 't(request)')).toBe('t(request)');
    expect(toggleWord('d(rx), -token', 't(request)')).toBe('d(rx), -token, t(request)');
    expect(toggleWord('d(rx) T(REQUEST)', 't(request)')).toBe('d(rx)');
    expect(hasWord('d(rx),t(Request)', 't(request)')).toBe(true);
  });
});
