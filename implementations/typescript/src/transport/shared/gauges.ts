// ── Gauges ────────────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from './errors';
import type { IGauges } from './types';

// definition

/** A part's gauges, frozen, what it does not give being none. */
export const gaugesOf = <Handle extends string>({
  anomalies = [],
  ceilings = {},
  connectionHandles = [],
  counts,
}: {
  anomalies?: readonly string[] | undefined;
  ceilings?: Readonly<Record<string, number>> | undefined;
  connectionHandles?: Iterable<Handle> | undefined;
  counts: Readonly<Record<string, number>>;
}): IGauges<Handle> => {
  return Object.freeze({
    anomalies: Object.freeze([...anomalies]),
    ceilings: Object.freeze({ ...ceilings }),
    connectionHandles: new Set(connectionHandles),
    counts: Object.freeze({ ...counts }),
  });
};

/** The entries of maps kept by connection, all together. */
export const entriesOf = (
  byConnection: ReadonlyMap<unknown, { readonly size: number }>
): number => {
  let entries = 0;

  for (const { size } of byConnection.values()) {
    entries += size;
  }

  return entries;
};

/**
 * What several parts hold, as one: their counts and ceilings side by side, the connections any of
 * them keeps anything for, and all they found that should never be. A count two parts name is a
 * {@link ProgrammerError}.
 */
export const mergeGauges = <Handle extends string>(
  parts: readonly IGauges<Handle>[]
): IGauges<Handle> => {
  const counts: Record<string, number> = {};

  for (const part of parts) {
    for (const [name, count] of Object.entries(part.counts)) {
      if (name in counts) {
        throw new ProgrammerError(`two parts count ${name}`);
      }

      counts[name] = count;
    }
  }

  return gaugesOf({
    anomalies: parts.flatMap(({ anomalies }) => {
      return anomalies;
    }),
    ceilings: Object.assign(
      {},
      ...parts.map(({ ceilings }) => {
        return ceilings;
      })
    ) as Record<string, number>,
    connectionHandles: parts.flatMap(({ connectionHandles }) => {
      return [...connectionHandles];
    }),
    counts,
  });
};
