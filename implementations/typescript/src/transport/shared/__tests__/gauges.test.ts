import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../errors';
import { entriesOf, gaugesOf, mergeGauges } from '../gauges';

// definition

test.describe('gaugesOf', () => {
  test('gives a part’s gauges frozen, what it does not give being none', () => {
    const gauges = gaugesOf<string>({ counts: { calls: 2 } });

    expect(gauges).toEqual({
      anomalies: [],
      ceilings: {},
      connectionHandles: new Set(),
      counts: { calls: 2 },
    });
    expect(
      [gauges, gauges.anomalies, gauges.ceilings, gauges.counts].every((part) => {
        return Object.isFrozen(part);
      })
    ).toBe(true);
    expect(
      gaugesOf({
        anomalies: ['odd'],
        ceilings: { calls: 4 },
        connectionHandles: ['a', 'a', 'b'],
        counts: { calls: 3 },
      })
    ).toEqual({
      anomalies: ['odd'],
      ceilings: { calls: 4 },
      connectionHandles: new Set(['a', 'b']),
      counts: { calls: 3 },
    });
    expect(gaugesOf({ counts: {}, connectionHandles: ['a', 'a', 'b'] }).connectionHandles).toEqual(
      new Set(['a', 'b'])
    );
    expect(gaugesOf({ counts: {} }).counts).toEqual({});
  });
});

test.describe('entriesOf', () => {
  test('counts the entries of maps kept by connection, all together', () => {
    expect(
      entriesOf(
        new Map<string, { size: number }>([
          ['a', new Map([[1, 'one']])],
          ['b', new Set([1, 2])],
        ])
      )
    ).toBe(3);
    expect(entriesOf(new Map())).toBe(0);
  });
});

test.describe('mergeGauges', () => {
  test('gives several parts as one, and refuses a count two of them name', () => {
    const merged = mergeGauges([
      gaugesOf({ ceilings: { bytes: 8 }, connectionHandles: ['a'], counts: { bytes: 1 } }),
      gaugesOf({ anomalies: ['odd'], connectionHandles: ['a', 'b'], counts: { calls: 2 } }),
    ]);

    expect(merged).toEqual({
      anomalies: ['odd'],
      ceilings: { bytes: 8 },
      connectionHandles: new Set(['a', 'b']),
      counts: { bytes: 1, calls: 2 },
    });
    expect(mergeGauges([])).toEqual(gaugesOf({ counts: {} }));
    expect(() => {
      return mergeGauges([gaugesOf({ counts: { calls: 1 } }), gaugesOf({ counts: { calls: 2 } })]);
    }).toThrow(new ProgrammerError('two parts count calls'));
  });
});
