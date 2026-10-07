import { expect, test } from '@playwright/test';
import { CallEnding, createMetricsRegistry } from '../../src/router/shared/metrics-registry';
import { answeredOf, metricsOf, quantileOf, samplesOf } from '../exposition';

// helpers

const READ = Object.freeze({
  procedureId: 3,
  procedureName: 'read',
  serviceId: 1,
  serviceRevision: 1,
});
const COUNTER = Object.freeze({
  procedureId: 5,
  procedureName: 'counter',
  serviceId: 1,
  serviceRevision: 1,
});
const STATS = Object.freeze({
  procedureId: 15,
  procedureName: 'stats',
  serviceId: 1,
  serviceRevision: 1,
});

/** A server's registry that answered `read` three times, one of them refused, and notified. */
const answeredExposition = (): string => {
  const registry = createMetricsRegistry();
  const server = registry.attach('server');
  const read = server.declareResolver(READ, { notifies: false });
  const counter = server.declareResolver(COUNTER, { notifies: true });
  const stats = server.declareResolver(STATS, { notifies: false });

  for (const [ending, microseconds] of [
    [CallEnding.RESULT, 400],
    [CallEnding.RESULT, 600],
    [CallEnding.APPLICATION, 2_000],
  ] as const) {
    read.calls.start();
    read.calls.end(ending, microseconds);
  }

  counter.calls.start();
  counter.notifying?.sent();
  counter.notifying?.sent();
  counter.notifying?.dropped(undefined);
  stats.calls.start();
  stats.calls.end(CallEnding.RESULT, 100);

  return registry.exposition().text;
};

// definition

test.describe('samplesOf', () => {
  test('reads each line that holds a value, its labels unescaped, and leaves comments and blanks out', () => {
    expect(
      samplesOf(
        [
          '# HELP x A family.',
          '# TYPE x counter',
          'x{procedure="a\\"b\\\\c\\nd",le="+Inf"} 3',
          'y 0.5',
          '',
          'not a sample',
        ].join('\n')
      )
    ).toEqual([
      { labels: { le: '+Inf', procedure: 'a"b\\c\nd' }, name: 'x', value: 3 },
      { labels: {}, name: 'y', value: 0.5 },
    ]);
  });
});

test.describe('quantileOf', () => {
  test('estimates within its bucket, linearly, as histogram_quantile does, and none while none ended', () => {
    const buckets = [
      [0.001, 2],
      [0.002, 3],
      [Infinity, 4],
    ] as const;

    expect(quantileOf(buckets, 0.5)).toBeCloseTo(0.001);
    expect(quantileOf(buckets, 0.75)).toBeCloseTo(0.002);
    expect(quantileOf(buckets, 0.25)).toBeCloseTo(0.0005);
    // past the last bound, that bound
    expect(quantileOf(buckets, 1)).toBeCloseTo(0.002);
    expect(quantileOf([[Infinity, 0]], 0.5)).toBeUndefined();
  });
});

test.describe('metricsOf', () => {
  test('gives each procedure’s calls, outcomes and durations, its subscriptions’ on its request, and leaves out what it is told to', () => {
    const rows = metricsOf(answeredExposition(), ['stats']);
    const read = rows.find(({ procedure }) => {
      return procedure === 'read';
    });
    const counter = rows.find(({ procedure }) => {
      return procedure === 'counter';
    });

    expect(
      rows.map(({ procedure }) => {
        return procedure;
      })
    ).not.toContain('stats');
    expect(read).toMatchObject({ count: 3, role: 'answered', started: 3, type: 'request' });
    expect(read?.outcomes.get('result')).toBe(2);
    expect(read?.outcomes.get('application')).toBe(1);
    expect(read?.sum).toBeCloseTo(0.003);
    expect(read?.buckets.at(-1)).toEqual([Infinity, 3]);
    expect(counter).toMatchObject({ count: 0, role: 'answered', started: 1 });
    expect(Object.fromEntries(counter?.notifications ?? [])).toMatchObject({
      dropped: 1,
      'not sent': 0,
      sent: 2,
    });
  });

  test('sorts by procedure and by type, made before answered', () => {
    const registry = createMetricsRegistry();
    const clock = Object.freeze({
      procedureId: 11,
      procedureName: 'clock',
      serviceId: 1,
      serviceRevision: 1,
    });

    const server = registry.attach('server');

    registry.attach('client').declareRequester(READ);
    server.declareResolver(READ, { notifies: false });
    server.declareRequester(clock);

    expect(
      metricsOf(registry.exposition().text, ['_OTHER']).map(({ procedure, role, type }) => {
        return `${procedure} ${type} ${role}`;
      })
    ).toEqual(['clock command made', 'read request made', 'read request answered']);
  });
});

test.describe('answeredOf', () => {
  test('sums every procedure’s calls answered, their mean and their median, in milliseconds', () => {
    const answered = answeredOf(metricsOf(answeredExposition(), []));

    expect(answered.count).toBe(4);
    expect(answered.mean).toBeCloseTo((0.4 + 0.6 + 2 + 0.1) / 4);
    expect(answered.median).toBeGreaterThan(0);
    expect(answeredOf([])).toEqual({ count: 0, mean: undefined, median: undefined });
  });
});
