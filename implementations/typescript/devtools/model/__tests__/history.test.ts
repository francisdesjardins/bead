import { expect, test } from '@playwright/test';
import type { IProcedureMetrics } from '../../exposition';
import { lineKeyOf, READINGS_KEPT, ratesOf, withReading } from '../history';

// helpers

const row = (started: number): IProcedureMetrics => {
  return {
    buckets: [],
    count: started,
    notifications: new Map(),
    outcomes: new Map(),
    procedure: 'read',
    role: 'made',
    service: '1',
    started,
    sum: 0,
    type: 'request',
  };
};

// definition

test.describe('ratesOf', () => {
  test('gives a line’s calls a second between each reading and the one before, a counter that went back counted from 0', () => {
    const readings = [
      { at: 0, rows: [row(2)] },
      { at: 1_000, rows: [row(5)] },
      { at: 3_000, rows: [row(9)] },
      { at: 4_000, rows: [row(1)] },
    ];

    expect(ratesOf(readings, lineKeyOf(row(0)))).toEqual([3, 2, 1]);
    expect(ratesOf(readings, 'made/1/write/request')).toEqual([0, 0, 0]);
  });
});

test.describe('withReading', () => {
  test('keeps the last minute of readings', () => {
    let readings = withReading([], { at: 0, rows: [] });

    for (let at = 1; at <= READINGS_KEPT + 5; at += 1) {
      readings = withReading(readings, { at, rows: [] });
    }

    expect(readings).toHaveLength(READINGS_KEPT);
    expect(readings[0]?.at).toBe(6);
  });
});
