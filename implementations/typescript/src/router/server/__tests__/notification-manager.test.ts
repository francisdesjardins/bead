import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import {
  createNotificationManager,
  PACING_DEFAULTS,
  ProgrammerError,
} from '../notification-manager';

// helpers

const first: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001';
const second: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50002';

// definition

test.describe('createNotificationManager', () => {
  test('registers each subscription under the call id of the request that made it', () => {
    const notifications = createNotificationManager();

    expect(
      notifications.register(
        { procedureId: 1, serviceId: 10 },
        { callId: 1, connectionHandle: first }
      )
    ).toBe(1);
    expect(
      notifications.register(
        { procedureId: 2, serviceId: 10 },
        { callId: 3, connectionHandle: second }
      )
    ).toBe(3);
    expect(
      notifications.register(
        { procedureId: 1, serviceId: 20 },
        { callId: 5, connectionHandle: first }
      )
    ).toBe(5);

    expect(notifications.subscriptions()).toEqual([
      { callId: 1, connectionHandle: first, procedureId: 1, serviceId: 10 },
      { callId: 5, connectionHandle: first, procedureId: 1, serviceId: 20 },
      { callId: 3, connectionHandle: second, procedureId: 2, serviceId: 10 },
    ]);
    expect(notifications.notifications).toEqual(
      new Map([
        [
          10,
          new Map([
            [1, new Map([[first, 1]])],
            [2, new Map([[second, 3]])],
          ]),
        ],
        [20, new Map([[1, new Map([[first, 5]])]])],
      ])
    );
  });

  test('takes the same call id on two connections as two subscriptions', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 13, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 13, connectionHandle: second }
    );

    expect(notifications.candidates({ procedureId: 1, serviceId: 10 })).toEqual(
      new Map([
        [first, 13],
        [second, 13],
      ])
    );
    expect(notifications.has(13, first)).toBe(true);
    expect(notifications.has(13, second)).toBe(true);

    notifications.unregister(13, first);

    expect(notifications.has(13, first)).toBe(false);
    expect(notifications.has(13, second)).toBe(true);
  });

  test('lists the candidates of one procedure, as a copy', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 3, connectionHandle: second }
    );
    notifications.register(
      { procedureId: 2, serviceId: 10 },
      { callId: 5, connectionHandle: second }
    );

    const candidates = notifications.candidates({ procedureId: 1, serviceId: 10 });

    expect([...candidates]).toEqual([
      [first, 1],
      [second, 3],
    ]);

    candidates.clear();

    expect(notifications.candidates({ procedureId: 1, serviceId: 10 }).size).toBe(2);
    expect(notifications.candidates({ procedureId: 3, serviceId: 10 }).size).toBe(0);
    expect(notifications.candidates({ procedureId: 1, serviceId: 99 }).size).toBe(0);
  });

  test('refuses a second subscription of a connection to a procedure, and a call id it holds, registering nothing', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 7, connectionHandle: first }
    );

    expect(() => {
      return notifications.register(
        { procedureId: 1, serviceId: 10 },
        { callId: 9, connectionHandle: first }
      );
    }).toThrow(ProgrammerError);
    expect(() => {
      return notifications.register(
        { procedureId: 2, serviceId: 20 },
        { callId: 7, connectionHandle: first }
      );
    }).toThrow(ProgrammerError);
    expect(notifications.subscriptions()).toEqual([
      { callId: 7, connectionHandle: first, procedureId: 1, serviceId: 10 },
    ]);
    // no empty map was made for what was refused
    expect([...notifications.notifications.keys()]).toEqual([10]);
    expect([...(notifications.notifications.get(10)?.keys() ?? [])]).toEqual([1]);
  });

  test("cleans a connection's subscriptions everywhere, and prunes what empties", () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 3, connectionHandle: second }
    );
    notifications.register(
      { procedureId: 2, serviceId: 10 },
      { callId: 5, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 20 },
      { callId: 7, connectionHandle: first }
    );

    notifications.clean(first);
    notifications.clean(first);
    notifications.clean('type=WS;ip=127.0.0.1;port=1');

    expect(notifications.subscriptions()).toEqual([
      { callId: 3, connectionHandle: second, procedureId: 1, serviceId: 10 },
    ]);
    expect([...notifications.notifications.keys()]).toEqual([10]);
    expect([...(notifications.notifications.get(10)?.keys() ?? [])]).toEqual([1]);
    expect(notifications.has(1, first)).toBe(false);
  });

  test('unregisters one subscription of its own connection, pruning what empties; any other is undefined', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 20 },
      { callId: 3, connectionHandle: second }
    );

    // no connection takes another's
    expect(notifications.unregister(3, first)).toBeUndefined();
    expect(notifications.unregister(3, second)).toBe(3);
    expect(notifications.unregister(3, second)).toBeUndefined();
    expect(notifications.unregister(99, first)).toBeUndefined();
    expect([...notifications.notifications.keys()]).toEqual([10]);
    expect(notifications.subscriptions()).toEqual([
      { callId: 1, connectionHandle: first, procedureId: 1, serviceId: 10 },
    ]);

    // a call id let go of may subscribe again
    notifications.register(
      { procedureId: 1, serviceId: 20 },
      { callId: 3, connectionHandle: second }
    );

    expect(notifications.subscriptionOf({ procedureId: 1, serviceId: 20 }, second)).toBe(3);
  });

  test('finds the subscription a connection has to a procedure, among its own only', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 2, serviceId: 10 },
      { callId: 3, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 20 },
      { callId: 5, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 7, connectionHandle: second }
    );

    expect(notifications.subscriptionOf({ procedureId: 1, serviceId: 10 }, first)).toBe(1);
    expect(notifications.subscriptionOf({ procedureId: 1, serviceId: 20 }, first)).toBe(5);
    expect(notifications.subscriptionOf({ procedureId: 1, serviceId: 10 }, second)).toBe(7);
    expect(notifications.subscriptionOf({ procedureId: 2, serviceId: 20 }, first)).toBeUndefined();
    expect(notifications.subscriptionOf({ procedureId: 2, serviceId: 10 }, second)).toBeUndefined();
    expect(
      notifications.subscriptionOf({ procedureId: 1, serviceId: 10 }, 'type=WS;ip=127.0.0.1;port=1')
    ).toBeUndefined();
  });

  test('hands out copies of its subscriptions', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );

    const [subscription] = notifications.subscriptions();

    if (subscription !== undefined) {
      subscription.callId = 99;
    }

    expect(notifications.subscriptions()).toEqual([
      { callId: 1, connectionHandle: first, procedureId: 1, serviceId: 10 },
    ]);
    expect(notifications.has(99, first)).toBe(false);
  });

  test('counts the subscriptions it notifies, and their connections, until each is cleaned', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 2, serviceId: 10 },
      { callId: 3, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 5, connectionHandle: second }
    );

    expect(notifications.gauges()).toMatchObject({
      connectionHandles: new Set([first, second]),
      counts: { notifiedSubscriptions: 3 },
    });

    notifications.clean(first);

    expect(notifications.gauges()).toMatchObject({
      connectionHandles: new Set([second]),
      counts: { notifiedSubscriptions: 1 },
    });
  });

  test('paces a subscription whose request asked, and no other', () => {
    const notifications = createNotificationManager();

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first, paced: true }
    );
    notifications.register(
      { procedureId: 2, serviceId: 10 },
      { callId: 3, connectionHandle: first, paced: false }
    );
    notifications.register(
      { procedureId: 3, serviceId: 10 },
      { callId: 5, connectionHandle: first }
    );

    expect(notifications.pacingOf(1, first)?.offer({ payload: new Uint8Array(1) })).toBe('send');
    expect(notifications.pacingOf(3, first)).toBeUndefined();
    expect(notifications.pacingOf(5, first)).toBeUndefined();
    // another connection's call id, and one no connection holds
    expect(notifications.pacingOf(1, second)).toBeUndefined();
    expect(notifications.pacingOf(7, first)).toBeUndefined();
  });

  test('lets a pacing go with its subscription, however it goes', () => {
    const notifications = createNotificationManager();
    const paced = { connectionHandle: first, paced: true };

    notifications.register({ procedureId: 1, serviceId: 10 }, { ...paced, callId: 1 });
    notifications.register({ procedureId: 2, serviceId: 10 }, { ...paced, callId: 3 });
    notifications.unregister(1, first);

    expect(notifications.pacingOf(1, first)).toBeUndefined();

    notifications.clean(first);

    expect(notifications.pacingOf(3, first)).toBeUndefined();
    expect(notifications.gauges().counts).toMatchObject({
      pausedSubscriptions: 0,
      queuedNotifications: 0,
    });

    // registered again, it starts anew
    notifications.register({ procedureId: 1, serviceId: 10 }, { ...paced, callId: 1 });

    expect(notifications.pacingOf(1, first)?.offer({ payload: new Uint8Array(1) })).toBe('send');
  });

  test('counts what paced subscriptions queue, all together and the fullest, at their limits', () => {
    const notifications = createNotificationManager({
      pacing: { maximumQueuedNotificationBytes: 100, maximumQueuedNotifications: 5 },
    });
    const register = (callId: number, connectionHandle = first) => {
      notifications.register(
        { procedureId: callId, serviceId: 10 },
        { callId, connectionHandle, paced: true }
      );

      // what its credit let go at once
      return notifications
        .pacingOf(callId, connectionHandle)
        ?.offer({ payload: new Uint8Array(1) });
    };

    expect(notifications.gauges()).toMatchObject({
      ceilings: { largestQueuedNotificationBytes: 100, largestQueuedNotifications: 5 },
      counts: {
        largestQueuedNotificationBytes: 0,
        largestQueuedNotifications: 0,
        pausedSubscriptions: 0,
        queuedNotificationBytes: 0,
        queuedNotifications: 0,
      },
    });

    register(1);
    register(3);
    register(5, second);
    notifications.register(
      { procedureId: 7, serviceId: 10 },
      { callId: 7, connectionHandle: first }
    );
    notifications.register(
      { procedureId: 9, serviceId: 10 },
      { callId: 9, connectionHandle: first, paced: true }
    );

    const queue = (
      {
        callId,
        connectionHandle = first,
      }: { callId: number; connectionHandle?: TransportServerConnectionHandle },
      sizes: number[]
    ) => {
      for (const size of sizes) {
        notifications.pacingOf(callId, connectionHandle)?.offer({ payload: new Uint8Array(size) });
      }
    };

    queue({ callId: 1 }, [10, 20]);
    queue({ callId: 3 }, [40]);
    queue({ callId: 5, connectionHandle: second }, [5, 5, 5]);

    expect(notifications.gauges().counts).toEqual({
      largestQueuedNotificationBytes: 40,
      largestQueuedNotifications: 3,
      notifiedSubscriptions: 5,
      // the fourth paced one still has its first credit
      pausedSubscriptions: 3,
      queuedNotificationBytes: 85,
      queuedNotifications: 6,
    });

    notifications.pacingOf(5, second)?.credit(10);

    expect(notifications.gauges().counts).toMatchObject({
      largestQueuedNotifications: 2,
      pausedSubscriptions: 2,
      queuedNotificationBytes: 70,
      queuedNotifications: 3,
    });
  });

  test('queues at the defaults when its options say nothing, and refuses a limit that is none', () => {
    expect(createNotificationManager().gauges().ceilings).toEqual({
      largestQueuedNotificationBytes: PACING_DEFAULTS.maximumQueuedNotificationBytes,
      largestQueuedNotifications: PACING_DEFAULTS.maximumQueuedNotifications,
    });
    expect(() => {
      return createNotificationManager({ pacing: { maximumQueuedNotifications: 0 } });
    }).toThrow(ProgrammerError);
  });

  test('queues a paced subscription up to the limits it was built with', () => {
    const notifications = createNotificationManager({ pacing: { maximumQueuedNotifications: 1 } });

    notifications.register(
      { procedureId: 1, serviceId: 10 },
      { callId: 1, connectionHandle: first, paced: true }
    );

    const pacing = notifications.pacingOf(1, first);
    const payload = new Uint8Array(1);

    expect([
      pacing?.offer({ payload }),
      pacing?.offer({ payload }),
      pacing?.offer({ payload }),
    ]).toEqual(['send', 'queued', 'exceeded']);
  });
});
