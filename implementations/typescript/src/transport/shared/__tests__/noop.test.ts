import { expect, test } from '@playwright/test';
import { noop } from '../noop';

test.describe('noop', () => {
  test('is a function that does nothing, without throwing', () => {
    expect(typeof noop).toBe('function');
    expect(() => {
      noop();
    }).not.toThrow();

    const call: () => unknown = noop;
    const returned = call();
    expect(returned).toBeUndefined();
  });
});
