// ── Health ────────────────────────────────────────────────────────────────────

// dependencies

import type { IGauges } from '../transport/shared/types';

// interfaces

/**
 * A layer's gauges as they leave the process: its counts, their ceilings, its anomalies, and its
 * orphans — the connections it keeps anything for that the transport no longer holds — never a
 * handle.
 */
export interface ILayerGauges {
  readonly anomalies: readonly string[];
  readonly ceilings: Readonly<Record<string, number>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly orphans: number;
}

/** A check, as the IETF draft "Health Check Response Format for HTTP APIs" writes one. */
export interface IHealthCheck {
  readonly observedValue: number;
  readonly output?: string;
  readonly status: HealthStatus;
}

/** A server's verdict: the worst of its checks, and each check under `layer:measure`. */
export interface IHealth {
  readonly checks: Readonly<Record<string, readonly IHealthCheck[]>>;
  readonly status: HealthStatus;
}

// types

export type HealthStatus = 'fail' | 'pass' | 'warn';

/** What each layer of a server holds. */
export type ServerGauges = Readonly<
  Record<'router' | 'server' | 'sessions' | 'transport', ILayerGauges>
>;

// constants

/** The share of its ceiling from which a count warns. */
export const WARNING_RATIO = 0.8;

const SEVERITIES = Object.freeze({ fail: 2, pass: 0, warn: 1 });

// helpers

/** `gauges` for leaving the process: its handles gone, each one `held` does not hold an orphan. */
export const layerGaugesOf = (gauges: IGauges, held: ReadonlySet<string>): ILayerGauges => {
  let orphans = 0;

  for (const connectionHandle of gauges.connectionHandles) {
    orphans += held.has(connectionHandle) ? 0 : 1;
  }

  const { anomalies, ceilings, counts } = gauges;

  return Object.freeze({ anomalies, ceilings, counts, orphans });
};

// definition

/**
 * The verdict on a server's gauges: `fail` for an orphan or an anomaly, `warn` for a count at
 * {@link WARNING_RATIO} of its ceiling or past it, `pass` otherwise; the server's, the worst.
 */
export const healthOf = (gauges: ServerGauges): IHealth => {
  const checks: Record<string, IHealthCheck[]> = {};
  let status: HealthStatus = 'pass';

  const check = (name: string, found: IHealthCheck): void => {
    checks[name] = [Object.freeze(found)];
    status = SEVERITIES[found.status] > SEVERITIES[status] ? found.status : status;
  };

  for (const [layer, { anomalies, ceilings, counts, orphans }] of Object.entries(gauges)) {
    check(
      `${layer}:orphans`,
      orphans === 0
        ? { observedValue: 0, status: 'pass' }
        : {
            observedValue: orphans,
            output: `${String(orphans)} connections kept that the transport no longer holds`,
            status: 'fail',
          }
    );
    check(
      `${layer}:anomalies`,
      anomalies.length === 0
        ? { observedValue: 0, status: 'pass' }
        : { observedValue: anomalies.length, output: anomalies.join('; '), status: 'fail' }
    );

    for (const [name, count] of Object.entries(counts)) {
      const ceiling = ceilings[name];

      if (ceiling !== undefined) {
        check(`${layer}:${name}`, {
          observedValue: count,
          output: `${String(count)} of ${String(ceiling)}`,
          status: count >= WARNING_RATIO * ceiling ? 'warn' : 'pass',
        });
      }
    }
  }

  return Object.freeze({ checks, status });
};
