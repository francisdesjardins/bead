import { expect, test } from '@playwright/test';
import { thrownMessage } from '../thrown-message';

test.describe('thrownMessage', () => {
  test('keeps a primitive as its text', () => {
    expect(thrownMessage('boom')).toBe('boom');
    expect(thrownMessage(3)).toBe('3');
    expect(thrownMessage(true)).toBe('true');
    expect(thrownMessage(10n)).toBe('10');
    expect(thrownMessage(null)).toBe('null');
    expect(thrownMessage(undefined)).toBe('undefined');
  });

  test('never stringifies an object, even one that cannot be stringified', () => {
    expect(thrownMessage({})).toBe('Non-error thrown');
    expect(thrownMessage(Object.create(null))).toBe('Non-error thrown');
    expect(
      thrownMessage({
        toString: () => {
          throw new Error('no');
        },
      })
    ).toBe('Non-error thrown');
  });
});
