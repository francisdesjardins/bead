import { expect, test } from '@playwright/test';
import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { CLIENT_FAILURES, SERVER_FAILURES } from '../constants';
import { createPendingCalls, type IPendingRequest } from '../pending-calls';

// helpers

/** A request waiting, which records how it settled. */
const requestOf = (): IPendingRequest & { settled: unknown[] } => {
  const settled: unknown[] = [];

  return {
    destinationId: undefined,
    isSent: false,
    maximumPayloadBytes: 1_024,
    procedureAddress: { procedureId: 1, serviceId: 2 },
    reject: (reason) => {
      settled.push(reason);
    },
    resolve: (result) => {
      settled.push(result);
    },
    settled,
    timeout: undefined,
  };
};

// definition

test.describe('createPendingCalls', () => {
  test('draw call ids of its side, skipping those waited on, reserved, or in use by the side', () => {
    const client = createPendingCalls(
      {
        failures: CLIENT_FAILURES,
        isCallIdInUse: (callId) => {
          return callId === 5;
        },
      },
      { clock: createTestClock(), lastCallId: 9 }
    );
    const server = createPendingCalls({ failures: SERVER_FAILURES }, { clock: createTestClock() });

    client.add({ callId: 1, connectionHandle: 'a' }, requestOf());
    client.reserve({ callId: 3, connectionHandle: 'a' });

    expect([client.draw('a'), client.draw('a'), client.draw('a')]).toEqual([7, 9, 7]);
    // another connection waits on nothing, and reserved nothing
    expect(client.draw('b')).toBe(9);
    expect([server.draw('a'), server.draw('a')]).toEqual([2, 4]);
  });

  test('forget a call, only while it is the request given, when one is', () => {
    const calls = createPendingCalls({ failures: CLIENT_FAILURES }, { clock: createTestClock() });
    const call = { callId: 1, connectionHandle: 'a' };
    const waiting = requestOf();

    calls.add(call, waiting);
    calls.forget(call, requestOf());

    expect(calls.get(call)).toBe(waiting);

    calls.forget(call, waiting);
    calls.forget(call);

    expect(calls.get(call)).toBeUndefined();
  });

  test('reserve a call id until its timer fires on its clock, the later end of two standing', () => {
    const clock = createTestClock();
    const calls = createPendingCalls({ failures: CLIENT_FAILURES }, { clock });

    calls.reserve({ callId: 1, connectionHandle: 'a', timeout: 40 });
    calls.reserve({ callId: 1, connectionHandle: 'a', timeout: 10 });
    calls.reserve({ callId: 3, connectionHandle: 'a', timeout: 10 });
    calls.reserve({ callId: 3, connectionHandle: 'a', timeout: 40 });

    // the earlier end of call id 1 arms nothing; the later one of call id 3 replaces its timer
    expect(
      clock.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([40, 10, 40]);
    expect(clock.cleared).toEqual([clock.armed[1]?.handle]);
    expect([calls.isReserved(1, 'a'), calls.isReserved(3, 'a'), calls.isReserved(1, 'b')]).toEqual([
      true,
      true,
      false,
    ]);

    // the timer replaced frees nothing
    clock.tick(10);
    expect([calls.isReserved(1, 'a'), calls.isReserved(3, 'a')]).toEqual([true, true]);
    clock.tick(29);

    expect([calls.isReserved(1, 'a'), calls.isReserved(3, 'a')]).toEqual([true, true]);

    clock.tick(1);

    expect([calls.isReserved(1, 'a'), calls.isReserved(3, 'a')]).toEqual([false, false]);
  });

  test("compare a reservation's end on its clock's monotonic reading, which a wall clock set by hand does not move", () => {
    const clock = createTestClock(Date.UTC(2026, 0, 1));
    const calls = createPendingCalls({ failures: CLIENT_FAILURES }, { clock });

    calls.reserve({ callId: 1, connectionHandle: 'a', timeout: 40 });
    // a wall clock moved an hour on, or back, says nothing of which end is later
    clock.setSystemTime(Date.UTC(2026, 0, 1, 1));
    calls.reserve({ callId: 1, connectionHandle: 'a', timeout: 10 });
    clock.setSystemTime(Date.UTC(2025, 11, 31));
    calls.reserve({ callId: 1, connectionHandle: 'a', timeout: 20 });

    expect(
      clock.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([40]);

    clock.tick(39);

    expect(calls.isReserved(1, 'a')).toBe(true);

    clock.tick(1);

    expect(calls.isReserved(1, 'a')).toBe(false);
  });

  test('take out every call of a connection, or of every one, freeing the call ids it reserved', () => {
    const calls = createPendingCalls({ failures: CLIENT_FAILURES }, { clock: createTestClock() });
    const first = requestOf();
    const second = requestOf();

    calls.add({ callId: 1, connectionHandle: 'a' }, first);
    calls.add({ callId: 1, connectionHandle: 'b' }, second);
    calls.reserve({ callId: 3, connectionHandle: 'a' });

    expect(calls.takeAll('a')).toEqual([first]);
    expect(calls.isReserved(3, 'a')).toBe(false);
    expect(calls.get({ callId: 1, connectionHandle: 'b' })).toBe(second);
    expect(calls.takeAll()).toEqual([second]);
    expect(calls.takeAll()).toEqual([]);
    // nothing is settled: the caller rejects what it took
    expect([...first.settled, ...second.settled]).toEqual([]);
  });

  test('hear each call leave once, whichever way it leaves', () => {
    const removed: IPendingRequest[] = [];
    const calls = createPendingCalls(
      { failures: CLIENT_FAILURES },
      {
        clock: createTestClock(),
        onRemove: (pendingRequest) => {
          removed.push(pendingRequest);
        },
      }
    );
    const add = (callId: number, connectionHandle = 'a') => {
      const pendingRequest = requestOf();

      calls.add({ callId, connectionHandle }, pendingRequest);

      return pendingRequest;
    };
    const first = add(1);

    // another request takes nothing out
    calls.forget({ callId: 1, connectionHandle: 'a' }, requestOf());
    calls.forget({ callId: 1, connectionHandle: 'a' }, first);
    calls.forget({ callId: 1, connectionHandle: 'a' }, first);

    const second = add(3);

    calls.forget({ callId: 3, connectionHandle: 'a' });

    expect(removed).toEqual([first, second]);

    const third = add(5);
    const fourth = add(7, 'b');

    calls.takeAll('a');

    expect(removed).toEqual([first, second, third]);

    calls.takeAll();

    expect(removed).toEqual([first, second, third, fourth]);
  });

  test('count the calls waited on and the call ids reserved, and the connections they belong to', () => {
    const calls = createPendingCalls<string>(
      { failures: CLIENT_FAILURES },
      { clock: createTestClock() }
    );

    calls.add({ callId: 1, connectionHandle: 'a' }, requestOf());
    calls.add({ callId: 3, connectionHandle: 'a' }, requestOf());
    calls.reserve({ callId: 5, connectionHandle: 'b' });

    expect(calls.gauges()).toMatchObject({
      connectionHandles: new Set(['a', 'b']),
      counts: { pendingCalls: 2, reservedCallIds: 1 },
    });

    calls.takeAll();

    expect(calls.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: { pendingCalls: 0, reservedCallIds: 0 },
    });
  });
});
