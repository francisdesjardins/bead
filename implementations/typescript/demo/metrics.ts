// ── Demo metrics, read ────────────────────────────────────────────────────────

// What a page reads of a metrics registry's exposition, the Prometheus text format 0.0.4 — the
// server's, which a `metrics` call answers, or its client's own: each procedure's calls, how they
// ended and how long they took, and what its subscriptions did. Nothing here touches a page, so
// whatever else reads an exposition reads it as this does.

// interfaces

/** One line of an exposition that holds a value: its family's name, its labels, and the value. */
export interface ISample {
  labels: Readonly<Record<string, string>>;
  name: string;
  value: number;
}

/** What a registry counted of one procedure's calls of one type, made or answered. */
export interface IProcedureMetrics {
  /** Each bucket's upper bound, in seconds, and the calls at or under it: in order, `+Inf` last. */
  buckets: [bound: number, cumulative: number][];
  /** The calls that ended, as their durations count them. */
  count: number;
  /**
   * What its subscriptions did, by what the page says of it: `sent`, `not sent`, `heard`, and
   * `dropped`, followed by the code that dropped them where one did.
   */
  notifications: Map<string, number>;
  /** How the calls that ended ended: by the code a failure names, else by their outcome. */
  outcomes: Map<string, number>;
  procedure: string;
  /** Whether this side made the calls, as a client's families count them, or answered them. */
  role: CallRole;
  service: string;
  /** The calls its router took, whether they ended or not. */
  started: number;
  /** Their durations, added, in seconds. */
  sum: number;
  type: string;
}

/**
 * The calls a server answered, as its registry counts them: how many, their mean, and their median
 * estimated within its bucket, as Prometheus's `histogram_quantile` estimates one, in milliseconds;
 * none while none ended.
 */
export interface IAnswered {
  count: number;
  mean: number | undefined;
  median: number | undefined;
}

// types

export type CallRole = 'answered' | 'made';

// constants

// a line that holds a value: its name, its labels as written, and its value
const SAMPLE = /^([A-Za-z_:][\w:]*)(?:\{(.*)\})? (\S+)$/;

// one label of a sample's: its name, and its value as written, escaped
const LABEL = /([A-Za-z_]\w*)="((?:[^"\\]|\\.)*)"/g;

/** The call families, by their name: the side that counts them, and what each sample of theirs is. */
const CALL_FAMILIES: Readonly<
  Record<
    string,
    readonly [role: CallRole, part: 'bucket' | 'count' | 'handled' | 'started' | 'sum']
  >
> = Object.freeze({
  bead_client_call_duration_seconds_bucket: ['made', 'bucket'],
  bead_client_call_duration_seconds_count: ['made', 'count'],
  bead_client_call_duration_seconds_sum: ['made', 'sum'],
  bead_client_call_handled_total: ['made', 'handled'],
  bead_client_call_started_total: ['made', 'started'],
  bead_server_call_duration_seconds_bucket: ['answered', 'bucket'],
  bead_server_call_duration_seconds_count: ['answered', 'count'],
  bead_server_call_duration_seconds_sum: ['answered', 'sum'],
  bead_server_call_handled_total: ['answered', 'handled'],
  bead_server_call_started_total: ['answered', 'started'],
});

// helpers

const unescaped = (value: string): string => {
  return value.replaceAll(/\\(.)/g, (_escape, character: string) => {
    return character === 'n' ? '\n' : character;
  });
};

/** Every line of `text` that holds a value; a comment, a blank line or one that does not read is none. */
export const samplesOf = (text: string): ISample[] => {
  return text.split('\n').flatMap((line) => {
    const [, name, labels = '', value] = SAMPLE.exec(line) ?? [];

    if (name === undefined || value === undefined) {
      return [];
    }

    return [
      {
        labels: Object.fromEntries(
          [...labels.matchAll(LABEL)].map(([, label = '', written = '']) => {
            return [label, unescaped(written)];
          })
        ),
        name,
        value: Number(value),
      },
    ];
  });
};

/**
 * The duration under which `quantile` of the calls `buckets` hold ended, in seconds, linearly between
 * its bucket's bounds, as `histogram_quantile` estimates it: past the last bound, that bound; none
 * while none ended.
 */
export const quantileOf = (
  buckets: readonly (readonly [bound: number, cumulative: number])[],
  quantile: number
): number | undefined => {
  const total = buckets.at(-1)?.[1] ?? 0;
  const rank = quantile * total;
  let lower = 0;
  let below = 0;

  if (total === 0) {
    return undefined;
  }

  for (const [bound, cumulative] of buckets) {
    if (cumulative >= rank) {
      return bound === Infinity
        ? lower
        : lower + ((bound - lower) * (rank - below)) / Math.max(cumulative - below, 1);
    }

    lower = bound;
    below = cumulative;
  }

  return lower;
};

/**
 * Each procedure's calls that `text` counts, made or answered, those named in `left` left out: the
 * reads that show them, whose own would count each read. A procedure's subscriptions are counted on
 * its request's: what was sent on the one that answered it, what was heard on the one that made it.
 * By procedure and by type, made before answered.
 */
export const metricsOf = (text: string, left: readonly string[]): IProcedureMetrics[] => {
  const rows = new Map<string, IProcedureMetrics>();

  const rowOf = (labels: ISample['labels'], role: CallRole): IProcedureMetrics => {
    const { procedure = '', service = '', type = 'request' } = labels;
    const key = [role, service, procedure, type].join('\n');
    const row = rows.get(key) ?? {
      buckets: [],
      count: 0,
      notifications: new Map<string, number>(),
      outcomes: new Map<string, number>(),
      procedure,
      role,
      service,
      started: 0,
      sum: 0,
      type,
    };

    rows.set(key, row);

    return row;
  };

  const add = (counts: Map<string, number>, [key, value]: [string, number]): void => {
    counts.set(key, (counts.get(key) ?? 0) + value);
  };

  for (const { labels, name, value } of samplesOf(text)) {
    const [role, part] = CALL_FAMILIES[name] ?? [];

    if (left.includes(labels['procedure'] ?? '')) {
      continue;
    }

    if (role !== undefined) {
      const row = rowOf(labels, role);

      if (part === 'bucket') {
        row.buckets.push([labels['le'] === '+Inf' ? Infinity : Number(labels['le']), value]);
      } else if (part === 'count') {
        row.count += value;
      } else if (part === 'sum') {
        row.sum += value;
      } else if (part === 'started') {
        row.started += value;
      } else {
        add(row.outcomes, [labels['code'] ?? labels['outcome'] ?? '', value]);
      }
    } else if (name === 'bead_notifications_sent_total') {
      add(rowOf(labels, 'answered').notifications, [
        labels['outcome'] === 'sent' ? 'sent' : 'not sent',
        value,
      ]);
    } else if (name === 'bead_notifications_heard_total') {
      add(rowOf(labels, 'made').notifications, ['heard', value]);
    } else if (name === 'bead_subscriptions_dropped_total') {
      // at this end, which a registry does not say: the request's row it already holds, or the one
      // that answered it
      const made = rows.get(['made', labels['service'], labels['procedure'], 'request'].join('\n'));

      add((made ?? rowOf(labels, 'answered')).notifications, [
        labels['code'] === undefined ? 'dropped' : `dropped ${labels['code']}`,
        value,
      ]);
    }
  }

  return [...rows.values()].toSorted((first, second) => {
    return (
      first.procedure.localeCompare(second.procedure) ||
      first.type.localeCompare(second.type) ||
      second.role.localeCompare(first.role)
    );
  });
};

/** The calls `rows` answered, every procedure's together: how many, their mean, and their median. */
export const answeredOf = (rows: readonly IProcedureMetrics[]): IAnswered => {
  const buckets = new Map<number, number>();
  let count = 0;
  let sum = 0;

  for (const row of rows) {
    if (row.role === 'answered') {
      count += row.count;
      sum += row.sum;

      for (const [bound, cumulative] of row.buckets) {
        buckets.set(bound, (buckets.get(bound) ?? 0) + cumulative);
      }
    }
  }

  if (count === 0) {
    return { count, mean: undefined, median: undefined };
  }

  const median = quantileOf(
    [...buckets].toSorted(([first], [second]) => {
      return first - second;
    }),
    0.5
  );

  return { count, mean: (sum / count) * 1_000, median: (median ?? 0) * 1_000 };
};
