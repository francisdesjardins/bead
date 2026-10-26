import { expect, test } from '@playwright/test';
import { healthOf, layerGaugesOf } from '../../../server/health';
import { createTestClock, hasRef } from '../../../transport/shared/__tests__/fixtures';
import { gaugesOf } from '../../../transport/shared/gauges';
import { createAnsweringCalls } from '../answering-calls';
import { EnvelopeKind } from '../constants';
import { CallEnding, type IProcedureSeries } from '../metrics-registry';
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
  test('counts no ending for an absent call or a stale header on a replacement call', () => {
    const calls = createAnsweringCalls<Handle>({ clock: createTestClock() });
    const counted: string[] = [];
    const series: IProcedureSeries = {
      end: (ending, microseconds) => {
        counted.push(`end ${String(ending)} ${String(microseconds)}`);
      },
      start: () => {
        counted.push('start');
      },
    };
    const first = headerOf(1);

    calls.end({ connectionHandle: 'a', header: first }, CallEnding.RESULT);

    expect(counted).toEqual([]);

    const controller = calls.open({ connectionHandle: 'a', header: first }, series);

    calls.end({ connectionHandle: 'b', header: first }, CallEnding.RESULT);
    calls.end({ connectionHandle: 'a', header: { ...first } }, CallEnding.RESULT);

    expect(counted).toEqual(['start']);
    expect(calls.take({ callId: 1, connectionHandle: 'a' })).toBe(controller);

    calls.end({ connectionHandle: 'a', header: first }, CallEnding.RESULT);

    const replacement = headerOf(1);
    const next = calls.open({ connectionHandle: 'a', header: replacement }, series);

    calls.end({ connectionHandle: 'a', header: first }, CallEnding.RESULT);
    calls.end({ connectionHandle: 'a', header: headerOf(3) }, CallEnding.ERROR);

    expect(counted).toEqual(['start', `end ${String(CallEnding.CANCELLED)} 0`, 'start']);
    expect(calls.controllerOf(replacement)).toBe(next);
    expect(calls.countOn('a')).toBe(1);

    calls.end({ connectionHandle: 'a', header: replacement }, CallEnding.RESULT);
    calls.close({ callId: 1, connectionHandle: 'a' }, next);
    calls.end({ connectionHandle: 'a', header: replacement }, CallEnding.ERROR);

    expect(counted).toEqual([
      'start',
      `end ${String(CallEnding.CANCELLED)} 0`,
      'start',
      `end ${String(CallEnding.RESULT)} 0`,
    ]);
    expect(calls.countOn('a')).toBe(0);
  });

  test('count a call opened with a series once: as its end says, else cancelled as it is taken, closed with its connection, an error as it is closed unanswered', async () => {
    const clock = createTestClock();
    const calls = createAnsweringCalls<Handle>({ clock });
    const counted: string[] = [];
    const series: IProcedureSeries = {
      end: (ending, microseconds) => {
        counted.push(`end ${String(ending)} ${String(microseconds)}`);
      },
      start: () => {
        counted.push('start');
      },
    };
    const [ended, taken, closed, unanswered] = [headerOf(1), headerOf(3), headerOf(5), headerOf(7)];

    for (const header of [ended, taken, closed, unanswered]) {
      calls.open({ connectionHandle: header === closed ? 'b' : 'a', header }, series);
    }

    await clock.tickAsync(2);

    // its end once: a second, and its close after it, count nothing
    calls.end({ connectionHandle: 'a', header: ended }, CallEnding.RESULT);
    calls.end({ connectionHandle: 'a', header: ended }, CallEnding.ERROR);
    calls.close({ callId: 1, connectionHandle: 'a' }, calls.controllerOf(ended) as AbortController);
    calls.take({ callId: 3, connectionHandle: 'a' });
    calls.takeAll('b');
    calls.close(
      { callId: 7, connectionHandle: 'a' },
      calls.controllerOf(unanswered) as AbortController
    );

    expect(counted).toEqual([
      'start',
      'start',
      'start',
      'start',
      `end ${String(CallEnding.RESULT)} 2000`,
      `end ${String(CallEnding.CANCELLED)} 2000`,
      `end ${String(CallEnding.CLOSED)} 2000`,
      `end ${String(CallEnding.ERROR)} 2000`,
    ]);
  });

  test('opens a call as its request is dispatched, and finds it again by that very header alone', () => {
    const calls = createAnsweringCalls({ clock: createTestClock() });
    const header = headerOf(3);
    const controller = calls.open({ connectionHandle: 'a', header });

    expect(calls.has({ callId: 3, connectionHandle: 'a' })).toBe(true);
    expect(calls.has({ callId: 3, connectionHandle: 'b' })).toBe(false);
    expect(calls.controllerOf(header)).toBe(controller);
    expect(calls.isAnswering({ connectionHandle: 'a', header })).toBe(true);
    // a copy was never dispatched: it finds no call, and is taken as one to answer
    expect(calls.controllerOf({ ...header })).toBeUndefined();
    expect(calls.isAnswering({ connectionHandle: 'a', header: { ...header } })).toBe(true);
  });

  test('answers a call no more once its answer goes out, while the call stays until closed, a copy of its header marking nothing', () => {
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

  test('answers a call no more once closed by its own call, taken, or opened again', () => {
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

  test('takes out every call of a connection, or of every one, giving them', () => {
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

  test('gives a call what it receives, and hears it leave once, whichever way the call leaves', () => {
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

  test('keeps a call that received a transfer abandoned once it ends, the oldest of a connection yielding', () => {
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

  test('forgets a call abandoned once its transfer’s inactivity is over', () => {
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
      clock.armed.map(({ delay }) => {
        return delay;
      })
    ).toEqual([250, 250]);
    // the call a request took stops its timer
    expect(clock.cleared).toEqual([clock.armed[1]?.handle]);

    clock.tick(249);

    expect(calls.abandonedEndOf({ callId: 1, connectionHandle: 'a' })).toBe(10);

    clock.tick(1);

    expect(calls.abandonedEndOf({ callId: 1, connectionHandle: 'a' })).toBeUndefined();
    expect(calls.abandonedEndOf({ callId: 3, connectionHandle: 'a' })).toBeUndefined();
  });

  test('keeps no process alive for an abandoned call’s timer', () => {
    const clock = createTestClock();
    const calls = createAnsweringCalls<Handle, IReceivingOf>({
      clock,
      limits: { maximumTransfers: 4, transferInactivityTimeout: 250 },
    });

    calls.open({ connectionHandle: 'a', header: headerOf(1) });
    calls.attach({ callId: 1, connectionHandle: 'a' }, receivingOf('', 10));
    calls.take({ callId: 1, connectionHandle: 'a' });

    expect(
      clock.armed.map(({ handle }) => {
        return hasRef(handle);
      })
    ).toEqual([false]);
  });

  test('count the calls answered and those abandoned, and the connections they belong to', () => {
    const calls = createAnsweringCalls<Handle, IReceivingOf>({ clock: createTestClock() });
    const call = { callId: 1, connectionHandle: 'a' } as const;
    const controller = calls.open({ connectionHandle: 'a', header: headerOf(1) });

    calls.open({ connectionHandle: 'b', header: headerOf(3) });
    calls.attach(call, receivingOf('abandoned', 4));
    calls.close(call, controller);

    expect(calls.gauges().connectionHandles).toEqual(new Set(['a', 'b']));
    expect(calls.gauges().counts).toEqual({
      abandonedCalls: 1,
      answeringCalls: 1,
      largestAnsweringCalls: 1,
    });

    calls.takeAll();

    expect(calls.gauges().connectionHandles).toEqual(new Set());
    expect(calls.gauges().counts).toEqual({
      abandonedCalls: 0,
      answeringCalls: 0,
      largestAnsweringCalls: 0,
    });
  });

  test('gauges largestAnsweringCalls under its ceiling maximumAnsweringCalls, which health warns at', () => {
    const limits = {
      maximumAnsweringCalls: 5,
      maximumTransfers: 4,
      transferInactivityTimeout: 30_000,
    };
    const calls = createAnsweringCalls<Handle, IReceivingOf>({ clock: createTestClock(), limits });
    const healthOfCalls = () => {
      return healthOf({
        router: layerGaugesOf(calls.gauges(), new Set(['a', 'b'])),
        server: layerGaugesOf(gaugesOf({ counts: {} }), new Set()),
        sessions: layerGaugesOf(gaugesOf({ counts: {} }), new Set()),
        transport: layerGaugesOf(gaugesOf({ counts: {} }), new Set()),
      }).checks['router:largestAnsweringCalls']?.[0];
    };

    for (const callId of [1, 3, 5]) {
      calls.open({ connectionHandle: 'a', header: headerOf(callId) });
    }

    calls.open({ connectionHandle: 'b', header: headerOf(1) });

    // the busiest connection's, never the sum of them, under the bound of one connection
    expect(calls.gauges()).toMatchObject({
      ceilings: { largestAnsweringCalls: 5 },
      counts: { answeringCalls: 4, largestAnsweringCalls: 3 },
    });
    expect(calls.countOn('a')).toBe(3);
    expect(healthOfCalls()).toMatchObject({ output: '3 of 5', status: 'pass' });

    calls.open({ connectionHandle: 'a', header: headerOf(7) });

    expect(healthOfCalls()).toMatchObject({ output: '4 of 5', status: 'warn' });

    calls.takeAll('a');

    expect(calls.gauges().counts).toMatchObject({ largestAnsweringCalls: 1 });
  });
});
