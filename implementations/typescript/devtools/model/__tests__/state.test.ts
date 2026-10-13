import { expect, test } from '@playwright/test';
import { T0 } from '../../__tests__/traffic';
import type { ICall } from '../calls';
import { spanOfCalls, stateAt } from '../state';
import { trafficBook } from './book';

// helpers

const namesOf = (calls: readonly ICall[]): (string | undefined)[] => {
  return calls.map(({ procedureName }) => {
    return procedureName;
  });
};

// definition

test.describe('stateAt', () => {
  test('rebuilds what was in flight, subscribed and under way at a moment, and the session announced by then', () => {
    const state = stateAt(trafficBook().calls, T0 + 1_430);

    expect(namesOf(state.inFlight)).toEqual(['download']);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      credited: 3,
      heard: 2,
      isOpen: true,
      latest: { text: '{"value": 47}' },
    });
    expect(state.transfers[0]).toMatchObject({ credited: 2_621_440, isWhole: false, passed: 0 });
    expect(state.session).toMatchObject({ announced: { state: 'opened' }, isAnyMade: true });
    expect(state.session.refused).toEqual([]);
  });

  test('holds nothing that started after its moment, and the end of what ended before it', () => {
    const { calls } = trafficBook();
    const early = stateAt(calls, T0 + 7);
    const late = stateAt(calls, T0 + 2_000);

    expect(namesOf(early.inFlight)).toEqual(['whoami']);
    expect(early.session.announced).toBeUndefined();
    expect(early.transfers).toEqual([]);
    expect(late.subscriptions[0]).toMatchObject({ endedBy: 'the server', isOpen: false });
    expect(namesOf(late.session.refused)).toEqual(['read']);
  });
});

test.describe('spanOfCalls', () => {
  test('spans the calls from their first start to their last record, and none for none', () => {
    expect(spanOfCalls(trafficBook().calls)).toEqual({ from: T0, to: T0 + 1_900 });
    expect(spanOfCalls([])).toBeUndefined();
  });
});
