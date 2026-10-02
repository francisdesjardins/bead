import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { filterDebug } from '../debug-filter';
import { createDebugStatistics, DEBUG_STATISTICS_DEFAULTS } from '../debug-statistics';
import type { DebugDirection, IDebugEvent } from '../types';

// helpers

/** A debug event that took `duration`, going `direction`. */
const eventOf = (duration: number | undefined, direction: DebugDirection = 'rx'): IDebugEvent => {
  return {
    direction,
    options: undefined,
    procedureId: 1,
    procedureName: 'echo',
    rx: undefined,
    serviceId: 2,
    serviceRevision: 1,
    timestamp: { duration, event: 0 },
    tx: undefined,
    type: 'request',
  };
};

// definition

test.describe('createDebugStatistics', () => {
  test('keeps the last thousand durations by default', () => {
    expect(DEBUG_STATISTICS_DEFAULTS).toEqual({ size: 1_000 });
    expect(Object.isFrozen(DEBUG_STATISTICS_DEFAULTS)).toBe(true);
  });

  test('says nothing of durations it has none of, rather than infinities', () => {
    expect(createDebugStatistics().durations()).toEqual({
      count: 0,
      maximum: undefined,
      mean: undefined,
      median: undefined,
      minimum: undefined,
    });
  });

  test('sums up the durations recorded, and passes over a step that carries none', () => {
    const statistics = createDebugStatistics();

    for (const duration of [30, undefined, 10, Number.NaN, 20, -5, 40]) {
      statistics.listener(null, eventOf(duration));
    }

    expect(statistics.durations()).toEqual({
      count: 4,
      maximum: 40,
      mean: 25,
      median: 25,
      minimum: 10,
    });

    statistics.listener(null, eventOf(5));

    expect(statistics.durations()).toMatchObject({ count: 5, median: 20 });
  });

  test('keeps the last `size` durations alone, the oldest leaving first', () => {
    const statistics = createDebugStatistics({ size: 3 });

    for (const duration of [100, 1, 2, 3, 4]) {
      statistics.listener(null, eventOf(duration));
    }

    expect(statistics.durations()).toEqual({
      count: 3,
      maximum: 4,
      mean: 3,
      median: 3,
      minimum: 2,
    });
  });

  test('forgets every duration on clear, and keeps recording after', () => {
    const statistics = createDebugStatistics({ size: 3 });

    // cleared part way through, so the next is written at the start again
    statistics.listener(null, eventOf(10));
    statistics.listener(null, eventOf(20));
    statistics.clear();
    statistics.listener(null, eventOf(7));

    expect(statistics.durations()).toMatchObject({ count: 1, maximum: 7, minimum: 7 });
  });

  test('refuses a size that is not a whole number of durations', () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        return createDebugStatistics({ size });
      }, String(size)).toThrow(ProgrammerError);
    }
  });

  test('counts one side of the calls alone through a debug filter', () => {
    const statistics = createDebugStatistics();
    const listener = filterDebug(statistics.listener, 'd(rx)');

    listener(null, eventOf(10, 'rx'));
    listener(null, eventOf(99, 'tx'));

    expect(statistics.durations()).toMatchObject({ count: 1, maximum: 10 });
  });
});
