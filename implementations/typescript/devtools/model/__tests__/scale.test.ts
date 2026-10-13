import { expect, test } from '@playwright/test';
import { scaleOf, tickStepOf, ticksOf } from '../scale';

// definition

test.describe('scaleOf', () => {
  test('puts a moment across a width and a place back in time, each held within its bounds', () => {
    const scale = scaleOf({ from: 1_000, to: 2_000 }, { left: 100, right: 300 });

    expect(scale.xOf(1_500)).toBe(200);
    expect(scale.xOf(5_000)).toBe(300);
    expect(scale.timeOf(150)).toBe(1_250);
    expect(scale.timeOf(0)).toBe(1_000);
  });
});

test.describe('tickStepOf and ticksOf', () => {
  test('mark a span with round steps of 1, 2 or 5 times a power of ten milliseconds', () => {
    expect(tickStepOf({ from: 0, to: 1_900 })).toBe(500);
    expect(tickStepOf({ from: 0, to: 70 })).toBe(10);
    expect(ticksOf({ from: 10, to: 1_910 })).toEqual([0, 500, 1_000, 1_500]);
  });
});
