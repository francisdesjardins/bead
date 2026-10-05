import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import {
  createMetricsRegistry,
  METRICS_REGISTRY_DEFAULTS,
  microsecondsOf,
} from '../metrics-registry';

// helpers

const echo = { procedureId: 1, procedureName: 'echo', serviceId: 2 };

// definition

test.describe('createMetricsRegistry', () => {
  test('writes a lone surrogate in a name as U+FFFD, as spec 7.4 writes a detail', () => {
    const registry = createMetricsRegistry();

    registry
      .attach('client')
      .declareNotification({ procedureId: 1, procedureName: 'a\uD800b', serviceId: 2 })
      .heard();

    expect(registry.exposition().text).toContain(
      'bead_notifications_heard_total{service="2",procedure="a�b"} 1\n'
    );
  });

  test('refuses a declaration as it is made, in sentences that name its address, its names and its reason, declaring nothing', () => {
    const registry = createMetricsRegistry({ maximumProcedures: 1 });
    const metrics = registry.attach('server');

    metrics.declareResolver(echo, { notifies: false });

    const before = registry.exposition().text;

    expect(() => {
      return metrics.declareRequester({ ...echo, procedureName: 'other' });
    }).toThrow(
      new ProgrammerError(
        'the metrics registry holds 2/1 as "echo", and is given "other": another name at its address'
      )
    );
    expect(() => {
      return metrics.declareRequester({ ...echo, procedureId: 2 });
    }).toThrow(
      new ProgrammerError(
        'the metrics registry holds "echo" at 2/1, and is given it at 2/2: its name at another address'
      )
    );
    expect(() => {
      return metrics.declareResolver(
        { procedureId: 3, procedureName: 'slow', serviceId: 2 },
        { notifies: false }
      );
    }).toThrow(
      new ProgrammerError(
        "the metrics registry's server families name 1 procedures at most, and 2/3 is one more: past the ceiling"
      )
    );
    expect(registry.exposition().text).toBe(before);
  });

  test('refuses a ceiling that is not a whole number above 0, and names 1,000 procedures by default', () => {
    expect(METRICS_REGISTRY_DEFAULTS).toEqual({ maximumProcedures: 1_000 });

    for (const maximumProcedures of [0, 1.5, Number.NaN, Infinity]) {
      expect(() => {
        return createMetricsRegistry({ maximumProcedures });
      }, String(maximumProcedures)).toThrow(
        new ProgrammerError(
          `maximumProcedures is a whole number above 0, not ${String(maximumProcedures)}`
        )
      );
    }
  });
});

test.describe('microsecondsOf', () => {
  test('holds a duration in whole microseconds, its fraction dropped, a reading’s binary fraction losing none', () => {
    expect(
      [0, 0.03, 0.0309, 0.3 - 0.2, 1, 1_000.0004, 2.5].map((milliseconds) => {
        return microsecondsOf(milliseconds);
      })
    ).toEqual([0, 30, 30, 100, 1_000, 1_000_000, 2_500]);
  });
});
