// ── Debug statistics ──────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import type { ServiceManagerOnDebugCallback } from './types';

// interfaces

/** How long the calls recorded took, in milliseconds; each measure `undefined` while none is. */
export interface IDurationSummary {
  count: number;
  maximum: number | undefined;
  mean: number | undefined;
  median: number | undefined;
  minimum: number | undefined;
}

/** How long the last calls took, as `debug` tells it once each answers. */
export interface IDebugStatistics {
  /**
   * What records each duration a `debug` event carries, for `on('debug', …)` — through
   * `filterDebug`, to count one side's calls alone. It never throws.
   */
  readonly listener: ServiceManagerOnDebugCallback;
  /** Forgets every duration recorded. */
  clear(): void;
  /** The durations recorded, summed up. */
  durations(): IDurationSummary;
}

export interface IDebugStatisticsOptions {
  /** How many durations are kept, the last ones; {@link DEBUG_STATISTICS_DEFAULTS}' when not given. */
  size?: number | undefined;
}

// constants

export const DEBUG_STATISTICS_DEFAULTS = Object.freeze({
  size: 1_000,
});

// definition

/**
 * The durations of the last calls, from the `debug` events that carry one: a call's answer on the
 * side that asked — its round trip — and an answer on the side that resolved it — its handling.
 * The oldest leaves as each new one comes, past `size`.
 *
 * @example
 * import {
 *   createDebugStatistics,
 *   createServiceManager,
 *   filterDebug,
 * } from '@francisdesjardins/bead/service-manager';
 *
 * const statistics = createDebugStatistics();
 *
 * createServiceManager(router).on('debug', filterDebug(statistics.listener, 'd(rx)'));
 * console.log(statistics.durations().median);
 */
export const createDebugStatistics = (options?: IDebugStatisticsOptions): IDebugStatistics => {
  const size = options?.size ?? DEBUG_STATISTICS_DEFAULTS.size;

  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ProgrammerError(
      `debug statistics keep a whole number of durations, not ${String(size)}`
    );
  }

  // the last durations, the next one written over the oldest once full
  const durations: number[] = [];
  let next = 0;

  return {
    clear: () => {
      durations.length = 0;
      next = 0;
    },
    durations: () => {
      const count = durations.length;

      if (count === 0) {
        return {
          count,
          maximum: undefined,
          mean: undefined,
          median: undefined,
          minimum: undefined,
        };
      }

      // walked rather than spread, so a large `size` never runs out of arguments
      let maximum = -Infinity;
      let minimum = Infinity;
      let total = 0;

      for (const duration of durations) {
        maximum = Math.max(maximum, duration);
        minimum = Math.min(minimum, duration);
        total += duration;
      }

      const sorted = durations.toSorted((a, b) => {
        return a - b;
      });
      // the middle one, or the mean of the two middle ones: the same one twice, for an odd count
      const [lower, upper] = [sorted[Math.ceil(count / 2) - 1], sorted[Math.floor(count / 2)]] as [
        number,
        number,
      ];
      const median = (lower + upper) / 2;

      return { count, maximum, mean: total / count, median, minimum };
    },
    listener: (_error, { timestamp: { duration } }) => {
      // a step that has not answered carries none
      if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
        return;
      }

      durations[next] = duration;
      next = (next + 1) % size;
    },
  };
};
