import { expect, test } from '@playwright/test';
import { timestamp } from '../timestamp';

test.describe('timestamp', () => {
  test('is now, in milliseconds and in seconds plus microseconds', () => {
    const before = Date.now();
    const current = timestamp();

    expect(current.ms).toBeGreaterThanOrEqual(before);
    expect(current.sec).toBe(Math.floor(current.ms / 1_000));
    expect(current.usec).toBe((current.ms % 1_000) * 1_000);
  });

  test('given a previous one, is the time elapsed since it', () => {
    const previous = { ms: Date.now() - 2_500, sec: Math.floor(Date.now() / 1_000) - 3, usec: 0 };
    const elapsed = timestamp(previous);

    expect(elapsed.ms).toBeGreaterThanOrEqual(2_500);
    expect(elapsed.sec).toBeGreaterThanOrEqual(3);
    expect(elapsed.usec).toBeGreaterThanOrEqual(0);
  });

  test('floors a negative microsecond part at zero', () => {
    const previous = { ms: 0, sec: 0, usec: 999_999_999 };
    expect(timestamp(previous).usec).toBe(0);
  });
});
