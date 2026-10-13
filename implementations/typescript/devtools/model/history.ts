// ── What a registry counted, over time ────────────────────────────────────────

// The expositions the Metrics view reads each second, kept, so a procedure's line shows its calls a
// second over the last minute: each reading's calls started against the one before, as Prometheus's
// `rate` reads a counter, a counter that went back — its client built anew — counted from 0.

// dependencies

import type { IProcedureMetrics } from '../exposition';

// interfaces

/** One reading of a registry: when, and what it counted. */
export interface IReading {
  at: number;
  rows: readonly IProcedureMetrics[];
}

// constants

/** The readings kept: a minute of them, one a second. */
export const READINGS_KEPT = 60;

// definition

/** What names a procedure's line across readings: its role, its service, its name and its type. */
export const lineKeyOf = ({ procedure, role, service, type }: IProcedureMetrics): string => {
  return [role, service, procedure, type].join('/');
};

/** Readings with one more, the oldest let go past {@link READINGS_KEPT}. */
export const withReading = (readings: readonly IReading[], reading: IReading): IReading[] => {
  return [...readings, reading].slice(-READINGS_KEPT);
};

/** A line's calls started a second, between each reading and the one before it. */
export const ratesOf = (readings: readonly IReading[], key: string): number[] => {
  const counts = readings.map(({ at, rows }) => {
    const row = rows.find((candidate) => {
      return lineKeyOf(candidate) === key;
    });

    return { at, started: row?.started ?? 0 };
  });

  return counts.slice(1).map(({ at, started }, index) => {
    const before = counts[index] ?? { at, started: 0 };
    const seconds = Math.max((at - before.at) / 1_000, 0.001);
    const delta = started >= before.started ? started - before.started : started;

    return delta / seconds;
  });
};
