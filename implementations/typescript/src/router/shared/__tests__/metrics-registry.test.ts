import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import {
  CallEnding,
  createMetricsRegistry,
  METRICS_REGISTRY_DEFAULTS,
  microsecondsOf,
} from '../metrics-registry';

// helpers

const echo = { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 };

/**
 * What an exposition writes of the calls a server answers, by each series' labels: its handled
 * counts summed, its `_count` and its started count.
 */
const answeredOf = (
  text: string
): Map<string, { count: number; handled: number; started: number }> => {
  const read = new Map<string, { count: number; handled: number; started: number }>();

  for (const line of text.split('\n')) {
    const sample =
      /^bead_server_call_(handled_total|started_total|duration_seconds_count)\{(service="[^"]*",procedure="[^"]*",type="[^"]*")[^}]*\} (\d+)$/u.exec(
        line
      );

    if (sample !== null) {
      const [, family = '', labels = '', value = ''] = sample;
      const counts = read.get(labels) ?? { count: 0, handled: 0, started: 0 };
      const key =
        family === 'handled_total' ? 'handled' : family === 'started_total' ? 'started' : 'count';

      counts[key] += Number(value);
      read.set(labels, counts);
    }
  }

  return read;
};

// definition

test.describe('createMetricsRegistry', () => {
  test('writes a lone surrogate in a name as U+FFFD, as spec 7.4 writes a detail', () => {
    const registry = createMetricsRegistry();

    registry
      .attach('client')
      .declareNotification({ ...echo, procedureName: 'a\uD800b' })
      .heard();

    expect(registry.exposition().text).toContain(
      'bead_notifications_heard_total{service="2",procedure="a�b"} 1\n'
    );
  });

  // spec 16.7
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
        'the metrics registry holds "echo" at 2/1, and is given "echo" at 2/2: its name at another address'
      )
    );
    expect(() => {
      return metrics.declareRequester({ ...echo, procedureId: 2, procedureName: 'ECHO' });
    }).toThrow(
      new ProgrammerError(
        'the metrics registry holds "echo" at 2/1, and is given "ECHO" at 2/2: its name at another address'
      )
    );
    expect(() => {
      return metrics.declareResolver(
        { ...echo, procedureId: 3, procedureName: 'slow' },
        { notifies: false }
      );
    }).toThrow(
      new ProgrammerError(
        "the metrics registry's server families name 1 procedures at most, and 2/3 is one more: past the ceiling"
      )
    );
    expect(registry.exposition().text).toBe(before);
  });

  // spec 16.7
  test('counts a service declared at a second revision into its series', () => {
    const registry = createMetricsRegistry();
    const metrics = registry.attach('server');
    const first = metrics.declareResolver(echo, { notifies: false }).calls;
    // another router of the same side, given the registry, its service at a second revision
    const second = registry
      .attach('server')
      .declareResolver({ ...echo, serviceRevision: 4 }, { notifies: false }).calls;
    const other = metrics.declareResolver(
      { ...echo, procedureId: 2, procedureName: 'fail', serviceRevision: 5 },
      { notifies: false }
    ).calls;

    for (const series of [first, second, other]) {
      series.start();
      series.end(CallEnding.RESULT, 10);
    }

    const answered = answeredOf(registry.exposition().text);

    expect(answered.get('service="2",procedure="echo",type="request"')).toEqual({
      count: 2,
      handled: 2,
      started: 2,
    });
    expect(answered.get('service="2",procedure="fail",type="request"')).toEqual({
      count: 1,
      handled: 1,
      started: 1,
    });
  });

  // debugging 8.5 and 11.2
  test('writes each series from one reading of its counts', () => {
    const registry = createMetricsRegistry();
    const metrics = registry.attach('server');
    const echoing = metrics.declareResolver(echo, { notifies: false }).calls;
    const failing = metrics.declareResolver(
      { ...echo, procedureId: 2, procedureName: 'fail' },
      { notifies: false }
    ).calls;

    // three echoes started, two ended; one failing call ended; one call of _OTHER under way
    for (const series of [echoing, echoing, echoing, failing, metrics.otherServer]) {
      series.start();
    }

    echoing.end(CallEnding.RESULT, 10);
    echoing.end(CallEnding.APPLICATION, 20);
    failing.end(CallEnding.TIMEOUT, 30);

    const { text } = registry.exposition();
    const answered = answeredOf(text);

    // * its `_count` the sum of its handled counts, and what is under way never below 0
    for (const [labels, { count, handled, started }] of answered) {
      expect(count, labels).toBe(handled);
      expect(started, labels).toBeGreaterThanOrEqual(handled);
    }

    expect(
      [...answered].map(([labels, { handled, started }]) => {
        return [labels, started - handled];
      })
    ).toEqual([
      ['service="2",procedure="echo",type="request"', 1],
      ['service="2",procedure="fail",type="request"', 0],
      ['service="_OTHER",procedure="_OTHER",type="request"', 1],
    ]);
    expect(text.indexOf('# HELP bead_server_call_handled_total')).toBeLessThan(
      text.indexOf('# HELP bead_server_call_started_total')
    );
  });

  // spec 16.7
  test('folds ASCII letters alone as it compares names, a name outside ASCII its own, and takes a name at its address exactly', () => {
    const metrics = createMetricsRegistry().attach('server');
    const resolve = (procedureId: number, procedureName: string) => {
      return metrics.declareResolver({ ...echo, procedureId, procedureName }, { notifies: false });
    };

    resolve(1, 'caf\u00e9');
    resolve(2, 'caf\u00c9');
    resolve(3, 'key');
    resolve(4, '\u212aey');
    metrics.declareRequester({ ...echo, procedureName: 'caf\u00e9' });

    expect(() => {
      return metrics.declareRequester({ ...echo, procedureName: 'CAF\u00e9' });
    }).toThrow(
      new ProgrammerError(
        'the metrics registry holds 2/1 as "caf\u00e9", and is given "CAF\u00e9": another name at its address'
      )
    );
    expect(() => {
      return resolve(5, 'KEY');
    }).toThrow(
      new ProgrammerError(
        'the metrics registry holds "key" at 2/3, and is given "KEY" at 2/5: its name at another address'
      )
    );
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
