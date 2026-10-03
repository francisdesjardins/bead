import { expect, test } from '@playwright/test';
import { createTestClock, hasRef } from '../../../transport/shared/__tests__/fixtures';
import { createAnsweringCalls } from '../answering-calls';
import { EnvelopeKind } from '../constants';
import type { IRequestHeader } from '../types';

// helpers

type Handle = 'a' | 'b';

/** What a call receives, named for the test to tell apart. */
interface IReceivingOf {
  readonly creditEnd: number;
  readonly name: string;
}

const headerOf = (callId: number): IRequestHeader => {
  return { callId, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 };
};

const receivingOf = (name: string, creditEnd = 0): IReceivingOf => {
  return { creditEnd, name };
};

// definition

test.describe('createAnsweringCalls', () => {
  test('open a call as its request is dispatched, and find it again by that very header alone', () => {
    const calls = createAnsweringCalls({ clock: createTestClock() });
    const header = headerOf(3);
    const controller = calls.open({ connectionHandle: 'a', header });

    expect(calls.has({ callId: 3, connectionHandle: 'a' })).toBe(true);
    expect(calls.has({ callId: 3, connectionHandle: 'b' })).toBe(false);
    expect(calls.controllerOf(header)).toBe(controller);
    expect(calls.isAnswering({ connectionHandle: 'a', header })).toBe(true);
    // a copy was never dispatched: it finds no call, and is taken as one to answer
    expect(calls.controllerOf({ ...header })).toBeUndefined();
  });

  test('answer a call no more once its answer goes out, while the call stays until closed; a copy of its header marks nothing', () => {
    const calls = createAnsweringCalls({ clock: createTestClock() });
    const header = headerOf(3);
    const controller = calls.open({ connectionHandle: 'a', header });

    calls.answer({ connectionHandle: 'a', header: { ...header } });
    calls.answer({ connectionHandle: 'b', header });

    expect(calls.isAnswering({ connectionHandle: 'a', header })).toBe(true);

    calls.answer({ connectionHandle: 'a', header });

    expect(calls.isAnswering({ connectionHandle: 'a', header })).toBe(false);
    expect(calls.has({ callId: 3, connectionHandle: 'a' })).toBe(true);

    calls.close({ callId: 3, connectionHandle: 'a' }, controller);

    expect(calls.has({ callId: 3, connectionHandle: 'a' })).toBe(false);
  });

  test('answer a call no more once closed by its own controller, taken, or opened again', () => {
    const calls = createAnsweringCalls({ clock: createTestClock() });
    const call = { callId: 3, connectionHandle: 'a' };
    const first = headerOf(3);
    const controller = calls.open({ connectionHandle: 'a', header: first });

    calls.close(call, new AbortController());

    expect(calls.isAnswering({ connectionHandle: 'a', header: first })).toBe(true);

    calls.close(call, controller);

    expect(calls.has(call)).toBe(false);
    expect(calls.isAnswering({ connectionHandle: 'a', header: first })).toBe(false);

    const second = headerOf(3);
    const again = calls.open({ connectionHandle: 'a', header: second });

    // the call id is open again, for another request
    expect(calls.isAnswering({ connectionHandle: 'a', header: first })).toBe(false);
    expect(calls.take(call)).toBe(again);
    expect(calls.take(call)).toBeUndefined();
    expect(calls.isAnswering({ connectionHandle: 'a', header: second })).toBe(false);
  });

  test('take out every call of a connection, or of every one, giving their controllers', () => {
    const calls = createAnsweringCalls({ clock: createTestClock() });
    const first = calls.open({ connectionHandle: 'a', header: headerOf(3) });
    const second = calls.open({ connectionHandle: 'b', header: headerOf(3) });

    expect(calls.takeAll('a')).toEqual([first]);
    expect(calls.has({ callId: 3, connectionHandle: 'b' })).toBe(true);
    expect(calls.takeAll()).toEqual([second]);
    expect(calls.takeAll()).toEqual([]);
    // nothing is aborted: the caller aborts what it took
    expect([first.signal.aborted, second.signal.aborted]).toEqual([false, false]);
  });

  test('give a call what it receives, and hear it leave once, whichever way the call leaves', () => {
    const removed: string[] = [];
    const calls = createAnsweringCalls<Handle, IReceivingOf>({
      clock: createTestClock(),
      onRemove: ({ name }) => {
        removed.push(name);
      },
    });
    const call = { callId: 3, connectionHandle: 'a' } as const;
    const controller = calls.open({ connectionHandle: 'a', header: headerOf(3) });

    // a call not open receives nothing, on a connection with calls open or none
    calls.attach({ callId: 5, connectionHandle: 'a' }, receivingOf('none'));
    calls.attach({ callId: 5, connectionHandle: 'b' }, receivingOf('none'));
    calls.attach(call, receivingOf('closed'));

    expect(calls.receivingOf({ callId: 5, connectionHandle: 'a' })).toBeUndefined();
    expect(calls.receivingOf(call)?.name).toBe('closed');

    // another request's controller takes nothing out
    calls.close(call, new AbortController());
    calls.close(call, controller);
    calls.close(call, controller);

    expect(calls.receivingOf(call)).toBeUndefined();

    calls.open({ connectionHandle: 'a', header: headerOf(3) });
    calls.attach(call, receivingOf('taken'));
    calls.take(call);
    calls.take(call);
    calls.open({ connectionHandle: 'a', header: headerOf(3) });
    calls.open({ connectionHandle: 'b', header: headerOf(3) });
    calls.attach({ callId: 3, connectionHandle: 'b' }, receivingOf('gone'));
    calls.takeAll();

    // a call that received nothing leaves unheard
    expect(removed).toEqual(['closed', 'taken', 'gone']);
  });

  test('keep a call that received a transfer abandoned once it ends, the oldest of a connection yielding', () => {
    const calls = createAnsweringCalls<Handle, IReceivingOf>({
      clock: createTestClock(),
      limits: { maximumTransfers: 2, transferInactivityTimeout: 250 },
    });
    const end = (
      { callId, connectionHandle }: { callId: number; connectionHandle: Handle },
      { creditEnd, how }: { creditEnd?: number; how: 'close' | 'take' }
    ) => {
      const controller = calls.open({ connectionHandle, header: headerOf(callId) });

      if (creditEnd !== undefined) {
        calls.attach({ callId, connectionHandle }, receivingOf('', creditEnd));
      }

      if (how === 'close') {
        calls.close({ callId, connectionHandle }, controller);
      } else {
        calls.take({ callId, connectionHandle });
      }
    };
    const endsOf = (connectionHandle: Handle, callIds: number[]) => {
      return callIds.map((callId) => {
        return calls.abandonedEndOf({ callId, connectionHandle });
      });
    };

    end({ callId: 1, connectionHandle: 'a' }, { creditEnd: 10, how: 'close' });
    end({ callId: 3, connectionHandle: 'a' }, { creditEnd: 20, how: 'take' });
    end({ callId: 1, connectionHandle: 'b' }, { creditEnd: 40, how: 'close' });
    // a call that received none ends abandoned by none
    end({ callId: 7, connectionHandle: 'a' }, { how: 'close' });

    expect(endsOf('a', [1, 3, 7])).toEqual([10, 20, undefined]);
    // a call abandoned is not one to answer
    expect(calls.has({ callId: 1, connectionHandle: 'a' })).toBe(false);

    // a request on its call id takes its place; ended again, the call is the newest
    calls.open({ connectionHandle: 'a', header: headerOf(1) });

    expect(endsOf('a', [1])).toEqual([undefined]);

    calls.take({ callId: 1, connectionHandle: 'a' });
    end({ callId: 1, connectionHandle: 'a' }, { creditEnd: 15, how: 'take' });
    end({ callId: 5, connectionHandle: 'a' }, { creditEnd: 30, how: 'close' });

    expect(endsOf('a', [1, 3, 5])).toEqual([15, undefined, 30]);
    expect(endsOf('b', [1])).toEqual([40]);

    // a call that goes with its connection is abandoned by none
    calls.open({ connectionHandle: 'a', header: headerOf(9) });
    calls.attach({ callId: 9, connectionHandle: 'a' }, receivingOf('', 50));
    calls.takeAll('a');

    expect(endsOf('a', [1, 5, 9])).toEqual([undefined, undefined, undefined]);
    expect(endsOf('b', [1])).toEqual([40]);

    calls.takeAll();

    expect(endsOf('b', [1])).toEqual([undefined]);
  });

  test('forget a call abandoned once its transfer’s inactivity is over, on its clock, keeping no process alive', () => {
    const clock = createTestClock();
    const calls = createAnsweringCalls<Handle, IReceivingOf>({
      clock,
      limits: { maximumTransfers: 4, transferInactivityTimeout: 250 },
    });

    for (const callId of [1, 3]) {
      calls.open({ connectionHandle: 'a', header: headerOf(callId) });
      calls.attach({ callId, connectionHandle: 'a' }, receivingOf('', 10));
      calls.take({ callId, connectionHandle: 'a' });
    }

    calls.open({ connectionHandle: 'a', header: headerOf(3) });

    expect(
      clock.armed.map(({ delay, handle }) => {
        return [delay, hasRef(handle)];
      })
    ).toEqual([
      [250, false],
      [250, false],
    ]);
    // the call a request took stops its timer
    expect(clock.cleared).toEqual([clock.armed[1]?.handle]);

    clock.tick(249);

    expect(calls.abandonedEndOf({ callId: 1, connectionHandle: 'a' })).toBe(10);

    clock.tick(1);

    expect(calls.abandonedEndOf({ callId: 1, connectionHandle: 'a' })).toBeUndefined();
  });

  test('count the calls answered and those abandoned, and the connections they belong to', () => {
    const calls = createAnsweringCalls<Handle, IReceivingOf>({ clock: createTestClock() });
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const controller = calls.open({ connectionHandle: 'a', header: headerOf(1) });

    calls.open({ connectionHandle: 'b', header: headerOf(3) });
    calls.attach(call, receivingOf('abandoned', 4));
    calls.close(call, controller);

    expect(calls.gauges()).toMatchObject({
      connectionHandles: new Set(['a', 'b']),
      counts: { abandonedCalls: 1, answeringCalls: 1 },
    });

    calls.takeAll();

    expect(calls.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: { abandonedCalls: 0, answeringCalls: 0 },
    });
  });
});
