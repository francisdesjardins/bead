import { expect, test } from '@playwright/test';
import { gaugesOf } from '../../transport/shared/gauges';
import { healthOf, type ILayerGauges, layerGaugesOf, WARNING_RATIO } from '../health';

// helpers

const quiet: ILayerGauges = { anomalies: [], ceilings: {}, counts: {}, orphans: 0 };

const layersOf = (
  layers: Partial<Record<'router' | 'server' | 'sessions' | 'transport', ILayerGauges>>
) => {
  return { router: quiet, server: quiet, sessions: quiet, transport: quiet, ...layers };
};

// definition

test.describe('layerGaugesOf', () => {
  test('keeps a layer’s counts, ceilings and anomalies, and counts as orphans the connections held nowhere else', () => {
    const layer = layerGaugesOf(
      gaugesOf({
        anomalies: ['odd'],
        ceilings: { calls: 4 },
        connectionHandles: ['a', 'b', 'c'],
        counts: { calls: 3 },
      }),
      new Set(['a'])
    );

    expect(layer).toEqual({
      anomalies: ['odd'],
      ceilings: { calls: 4 },
      counts: { calls: 3 },
      orphans: 2,
    });
    expect(Object.isFrozen(layer)).toBe(true);
    // no handle leaves with it
    expect(JSON.stringify(layer)).not.toContain('"a"');
  });
});

test.describe('healthOf', () => {
  test('passes a server with no orphan, no anomaly, and each count under its ceiling', () => {
    const health = healthOf(
      layersOf({
        transport: {
          ...quiet,
          ceilings: { connections: 10 },
          counts: { connections: 7, listens: 3 },
        },
      })
    );

    expect(health).toEqual({
      checks: {
        'router:anomalies': [{ observedValue: 0, status: 'pass' }],
        'router:orphans': [{ observedValue: 0, status: 'pass' }],
        'server:anomalies': [{ observedValue: 0, status: 'pass' }],
        'server:orphans': [{ observedValue: 0, status: 'pass' }],
        'sessions:anomalies': [{ observedValue: 0, status: 'pass' }],
        'sessions:orphans': [{ observedValue: 0, status: 'pass' }],
        'transport:anomalies': [{ observedValue: 0, status: 'pass' }],
        'transport:connections': [{ observedValue: 7, output: '7 of 10', status: 'pass' }],
        'transport:orphans': [{ observedValue: 0, status: 'pass' }],
      },
      status: 'pass',
    });
    expect(Object.isFrozen(health)).toBe(true);
  });

  test('warns of a count from its warning share of its ceiling, and fails an orphan or an anomaly, the worst standing', () => {
    const near = healthOf(
      layersOf({
        transport: { ...quiet, ceilings: { connections: 10 }, counts: { connections: 8 } },
      })
    );

    expect([near.status, near.checks['transport:connections']]).toEqual([
      'warn',
      [{ observedValue: 8, output: '8 of 10', status: 'warn' }],
    ]);
    expect(WARNING_RATIO).toBe(0.8);

    const failing = healthOf(
      layersOf({
        router: { ...quiet, orphans: 2 },
        sessions: { ...quiet, anomalies: ['one', 'two'] },
        transport: { ...quiet, ceilings: { connections: 10 }, counts: { connections: 9 } },
      })
    );

    expect(failing.status).toBe('fail');
    expect([failing.checks['router:orphans'], failing.checks['sessions:anomalies']]).toEqual([
      [
        {
          observedValue: 2,
          output: '2 connections kept that the transport no longer holds',
          status: 'fail',
        },
      ],
      [{ observedValue: 2, output: 'one; two', status: 'fail' }],
    ]);
    // a warning after a failure leaves it the worst
    expect(
      healthOf(
        layersOf({
          router: { ...quiet, orphans: 1 },
          transport: { ...quiet, ceilings: { connections: 1 }, counts: { connections: 1 } },
        })
      ).status
    ).toBe('fail');
  });
});
