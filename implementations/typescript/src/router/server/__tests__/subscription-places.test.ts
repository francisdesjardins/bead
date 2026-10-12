import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { CredentialScheme } from '../../shared/constants';
import type { INotifyingSeries } from '../../shared/metrics-registry';
import { createNotificationManager } from '../notification-manager';
import { createSubscriptionPlaces, type ISubscribed } from '../subscription-places';

// helpers

const first: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';
const second: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=1';

const news = { procedureId: 5, serviceId: 2 };
const other = { procedureId: 7, serviceId: 2 };

/** A success that subscribes, as a notification's resolver answers a request that opens one. */
const subscribing = { isFailure: false, notifies: true, procedure: news } as const;

/** The call ids of the subscriptions given, in their order. */
const callIdsOf = (subscribed: ISubscribed[]): number[] => {
  return subscribed.map(({ callId }) => {
    return callId;
  });
};

/** A series a subscription counts into, which counts nothing: told apart by its identity alone. */
const seriesOf = (): INotifyingSeries => {
  return {
    dropped: () => {
      return undefined;
    },
    failed: () => {
      return undefined;
    },
    sent: () => {
      return undefined;
    },
  };
};

/** Places over a notification manager of their own, with the connections open in `open`. */
const createPlaces = (open: TransportServerConnectionHandle[] = [first, second]) => {
  const notifications = createNotificationManager();
  const places = createSubscriptionPlaces({
    isConnected: (connectionHandle) => {
      return open.includes(connectionHandle);
    },
    notifications,
  });

  // the call ids subscribed, by connection
  const held = (connectionHandle: TransportServerConnectionHandle = first) => {
    return notifications.subscriptions(connectionHandle).map(({ callId }) => {
      return callId;
    });
  };

  return { held, notifications, open, places };
};

// definition

test.describe('createSubscriptionPlaces', () => {
  test('subscribe puts a call in its place, in flight, and gives any other the holder’s call id', () => {
    const { held, places } = createPlaces();

    expect(places.subscribe({ callId: 3, connectionHandle: first }, news)).toBe(3);
    expect(places.subscribe({ callId: 5, connectionHandle: first }, news)).toBe(3);
    expect(places.subscribe({ callId: 5, connectionHandle: second }, news)).toBe(5);
    expect(held()).toEqual([3]);
  });

  test('settle keeps a success, and its undo takes it away when the answer does not go out', () => {
    const { held, places } = createPlaces();
    const call = { callId: 3, connectionHandle: first };

    places.subscribe(call, news);

    const undo = places.settle(call, { ...subscribing, notifies: false });

    expect(held()).toEqual([3]);

    undo?.();

    expect(held()).toEqual([]);
  });

  test('settle subscribes a call that notifies while its connection holds no place, and nothing else', () => {
    const { held, places } = createPlaces();

    expect(places.settle({ callId: 3, connectionHandle: first }, subscribing)).toBeDefined();
    expect(
      places.settle({ callId: 5, connectionHandle: first }, { ...subscribing, procedure: other })
    ).toBeDefined();
    // the place of `news` is held already, and nothing of it is in flight: no one waits
    expect(places.settle({ callId: 7, connectionHandle: first }, subscribing)).toBeUndefined();
    expect(
      places.settle({ callId: 9, connectionHandle: second }, { ...subscribing, notifies: false })
    ).toBeUndefined();
    expect(held()).toEqual([3, 5]);
    expect(held(second)).toEqual([]);
  });

  test('a failure takes the holder away, and hands its place to the first call answered meanwhile', () => {
    const { held, places } = createPlaces();
    const holder = { callId: 3, connectionHandle: first };

    places.subscribe(holder, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);
    places.settle({ callId: 7, connectionHandle: first }, subscribing);
    places.settle(holder, { ...subscribing, isFailure: true });

    expect(held()).toEqual([5]);
  });

  test('paces a call subscribed, settled or handed its place, as its own request asked', () => {
    const { notifications, places } = createPlaces();

    places.subscribe({ callId: 3, connectionHandle: first, paced: true }, news);
    places.settle({ callId: 5, connectionHandle: first, paced: false }, subscribing);
    places.settle(
      { callId: 7, connectionHandle: first, paced: true },
      { ...subscribing, procedure: other }
    );
    places.subscribe({ callId: 3, connectionHandle: second }, news);
    places.settle({ callId: 5, connectionHandle: second, paced: true }, subscribing);

    expect(notifications.pacingOf(3, first)).toBeDefined();
    expect(notifications.pacingOf(7, first)).toBeDefined();
    expect(notifications.pacingOf(3, second)).toBeUndefined();

    // each takes the place its holder falls from as it asked, whatever the holder asked
    places.settle({ callId: 3, connectionHandle: first }, { ...subscribing, isFailure: true });
    places.cancel({ callId: 3, connectionHandle: second });

    expect(notifications.pacingOf(5, first)).toBeUndefined();
    expect(notifications.has(5, first)).toBe(true);
    expect(notifications.pacingOf(5, second)).toBeDefined();
  });

  test('a failure of a call not in flight takes nothing away', () => {
    const { held, places } = createPlaces();

    places.settle({ callId: 3, connectionHandle: first }, subscribing);
    places.settle({ callId: 3, connectionHandle: first }, { ...subscribing, isFailure: true });

    expect(held()).toEqual([3]);
  });

  test('a holder answered successfully leaves nothing waiting on it', () => {
    const { held, places } = createPlaces();
    const holder = { callId: 3, connectionHandle: first };

    places.subscribe(holder, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);
    places.settle(holder, subscribing);
    places.cancel(holder);

    expect(held()).toEqual([]);
  });

  test('an undo hands the place over, to a connection still open that holds none', () => {
    const { held, open, places } = createPlaces();
    const holder = { callId: 3, connectionHandle: first };

    places.subscribe(holder, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);

    const undo = places.settle(holder, subscribing);

    open.length = 0;
    undo?.();

    expect(held()).toEqual([]);
  });

  test('cancel takes the holder away and hands its place over, on its own connection alone', () => {
    const { held, places } = createPlaces();

    places.subscribe({ callId: 3, connectionHandle: first }, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);
    places.subscribe({ callId: 3, connectionHandle: second }, news);
    places.cancel({ callId: 3, connectionHandle: first });

    expect(held()).toEqual([5]);
    expect(held(second)).toEqual([3]);
  });

  test('a call that waited, cancelled or unsubscribed, waits no more', () => {
    const { held, places } = createPlaces();
    const holder = { callId: 3, connectionHandle: first };

    places.subscribe(holder, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);
    places.cancel({ callId: 5, connectionHandle: first });
    places.settle({ callId: 7, connectionHandle: first }, subscribing);

    expect(places.unsubscribe({ callId: 7, connectionHandle: first })).toBe(false);

    places.cancel(holder);

    expect(held()).toEqual([]);
  });

  test('unsubscribe takes a subscription away, and says whether the connection held it', () => {
    const { held, places } = createPlaces();

    places.settle({ callId: 3, connectionHandle: first }, subscribing);

    expect(places.unsubscribe({ callId: 3, connectionHandle: second })).toBe(false);
    expect(places.unsubscribe({ callId: 3, connectionHandle: first })).toBe(true);
    expect(held()).toEqual([]);
  });

  test('holds a place a procedure for each session of a connection, and drop gives a session’s own: its connection’s, or a credential’s by its identifier', () => {
    const { places } = createPlaces();
    const grace = { id: 'grace', scheme: CredentialScheme.ELSEWHERE } as const;

    for (const call of [
      { callId: 21, connectionHandle: first, identifier: grace },
      { callId: 23, connectionHandle: first },
      { callId: 25, connectionHandle: first, identifier: { ...grace } },
    ]) {
      places.settle(call, subscribing);
    }

    expect(callIdsOf(places.drop({ connectionHandle: first }))).toEqual([23]);
    expect(callIdsOf(places.drop({ connectionHandle: first, identifier: { ...grace } }))).toEqual([
      21,
    ]);
  });

  test('drop gives the established and the waiting, never one in flight, and no call waits after', () => {
    const { held, places } = createPlaces();
    const holder = { callId: 3, connectionHandle: first };

    places.subscribe(holder, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);
    places.settle({ callId: 7, connectionHandle: first }, { ...subscribing, procedure: other });

    expect(callIdsOf(places.drop({ connectionHandle: first }))).toEqual([7, 5]);
    expect(places.drop({ connectionHandle: second })).toEqual([]);

    places.settle(holder, { ...subscribing, isFailure: true });

    expect(held()).toEqual([7]);
  });

  test('subscribedOf and drop give each subscription answered with the series it counts into, the waiting among them, never one in flight', () => {
    const { places } = createPlaces();
    const [held, waiting, established] = [seriesOf(), seriesOf(), seriesOf()];

    places.subscribe({ callId: 3, connectionHandle: first, series: held }, news);
    places.settle({ callId: 5, connectionHandle: first, series: waiting }, subscribing);
    places.settle(
      { callId: 7, connectionHandle: first, series: established },
      { ...subscribing, procedure: other }
    );

    const answered = [
      { callId: 7, series: established },
      { callId: 5, series: waiting },
    ];

    expect(places.subscribedOf(first)).toEqual(answered);
    expect(places.subscribedOf(second)).toEqual([]);
    expect(places.drop({ connectionHandle: first })).toEqual(answered);
  });

  test('clear forgets the calls in flight and waiting of a connection, or of every one', () => {
    const { held, places } = createPlaces();

    for (const connectionHandle of [first, second]) {
      places.subscribe({ callId: 3, connectionHandle }, news);
      places.settle({ callId: 5, connectionHandle }, subscribing);
    }

    places.clear(first);
    // no longer in flight, the holder's failure takes nothing away, and no one waits on it
    places.settle({ callId: 3, connectionHandle: first }, { ...subscribing, isFailure: true });

    expect(held()).toEqual([3]);

    places.clear();
    places.settle({ callId: 3, connectionHandle: second }, { ...subscribing, isFailure: true });

    expect(held(second)).toEqual([3]);
  });

  test('counts the subscribing calls in flight and those waiting for a place, and their connections', () => {
    const { places } = createPlaces();

    places.subscribe({ callId: 3, connectionHandle: first }, news);

    // in flight, nobody waiting on it: its connection is kept all the same
    expect(places.gauges().connectionHandles).toEqual(new Set([first]));

    places.subscribe({ callId: 5, connectionHandle: first }, news);
    places.settle({ callId: 5, connectionHandle: first }, subscribing);

    expect(places.gauges()).toMatchObject({
      connectionHandles: new Set([first]),
      counts: { subscriptionsInFlight: 1, subscriptionsWaiting: 1 },
    });

    places.clear(first);

    expect(places.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: { subscriptionsInFlight: 0, subscriptionsWaiting: 0 },
    });
  });
});
