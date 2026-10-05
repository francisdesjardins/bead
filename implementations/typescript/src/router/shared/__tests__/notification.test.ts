import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { CLIENT_FAILURES, ProtocolCode } from '../constants';
import { DisconnectError, FailureError } from '../errors';
import { createNotification, type INotificationContext } from '../notification';
import type { INotificationLike, IProcedure } from '../types';

// helpers

const text = new TextEncoder();
const news: IProcedure = {
  procedureId: 5,
  procedureName: 'news',
  serviceId: 2,
  serviceRevision: 1,
};

/**
 * A notification over a router that holds what it registers, and a requester that answers each
 * call at once, under the next odd call id; what each was asked is recorded.
 */
const createNotified = (
  more: Partial<INotificationContext<string, string, string>['dependencies']> = {}
) => {
  const held = new Set<INotificationLike>();
  const asked = {
    dropped: [] as unknown[],
    requests: [] as string[],
    traced: [] as unknown[],
    unregistered: [] as unknown[],
  };
  let callId = -1;

  const notification = createNotification<string, string, string>(news, {
    dependencies: {
      serializer: {
        decode: (response) => {
          return new TextDecoder().decode(response);
        },
        encode: (request) => {
          return text.encode(request);
        },
        decodeNotification: (payload) => {
          if (payload.length === 0) {
            throw new Error('empty');
          }

          return new TextDecoder().decode(payload);
        },
      },
      ...more,
    },
    named: (callable) => {
      return Object.assign(callable, news);
    },
    onDropped: (failure) => {
      asked.dropped.push(failure);
    },
    requesterOf: (subscribes) => {
      return (requestPayload) => {
        return () => {
          asked.requests.push(`${requestPayload} for ${subscribes().procedureName}`);
          callId += 2;

          return Promise.resolve({ callId, payload: 'subscribed' });
        };
      };
    },
    router: {
      failures: CLIENT_FAILURES,
      hasNotification: (notification) => {
        return held.has(notification);
      },
      registerNotification: (notification) => {
        held.add(notification);

        return Promise.resolve();
      },
      unregisterNotification: (notification, options) => {
        held.delete(notification);
        asked.unregistered.push(options);

        return Promise.resolve();
      },
    },
    trace: (error, rx) => {
      asked.traced.push({ error, rx });
    },
  });

  return { asked, held, notification };
};

// definition

test.describe('createNotification', () => {
  test('is held by the router before its one request goes out, however many register at once', async () => {
    const { asked, held, notification } = createNotified();
    const heard: string[] = [];

    await Promise.all([
      notification('first', (payload) => {
        heard.push(`a ${payload}`);
      })(),
      notification('second', (payload) => {
        heard.push(`b ${payload}`);
      })(),
    ]);
    void notification.trigger(text.encode('flash'));

    expect(held.has(notification)).toBe(true);
    expect(asked.requests).toEqual(['first for news']);
    expect(heard).toEqual(['a flash', 'b flash']);
    expect(asked.traced).toEqual([{ error: undefined, rx: 'flash' }]);
  });

  test('the last callback out unsubscribes, then unregisters the notification, with no cancel once acknowledged', async () => {
    const unsubscribed: unknown[] = [];
    const { asked, held, notification } = createNotified({
      unsubscribe: (callId, response) => {
        unsubscribed.push([callId, response]);

        return Promise.resolve();
      },
    });
    const first = await notification('s', () => {
      return undefined;
    })();
    const second = await notification('s', () => {
      return undefined;
    })();

    await first.unregister();

    expect(held.has(notification)).toBe(true);

    await second.unregister();
    await second.unregister();

    expect(unsubscribed).toEqual([[1, 'subscribed']]);
    expect(asked.unregistered).toEqual([{ cancel: false }]);
    expect(held.has(notification)).toBe(false);
  });

  test('without an unsubscribe, the router is told to cancel', async () => {
    const { asked, notification } = createNotified();
    const registration = await notification('s', () => {
      return undefined;
    })();

    await registration[Symbol.asyncDispose]();

    expect(asked.unregistered).toEqual([{ cancel: true }]);
  });

  test('a drop silences the callbacks, tells the manager, and fails a registration under way', async () => {
    const { asked, held, notification } = createNotified();
    const heard: string[] = [];
    const registration = await notification('s', (payload) => {
      heard.push(payload);
    })();
    const registering = notification('s', () => {
      return undefined;
    })();

    notification.drop?.();
    held.delete(notification);

    await expect(registering).rejects.toBeInstanceOf(DisconnectError);

    // taken away already, with its connection: nothing is asked of the router
    await registration.unregister();

    expect(asked.dropped).toEqual([undefined]);
    expect(asked.unregistered).toEqual([]);
    expect(heard).toEqual([]);
  });

  test('a drop tells the manager the failure the other end ended its subscription with', () => {
    const { asked, notification } = createNotified();
    const failure = { ...CLIENT_FAILURES.capacityExceeded, detail: 'too many', relays: 0 };

    notification.drop?.(failure);

    expect(asked.dropped).toEqual([failure]);
  });

  test('a trigger settles as every callback did, the promises they returned too', async () => {
    const { notification } = createNotified();
    const { promise: fetched, resolve: fetch } = Promise.withResolvers<string>();
    let isSettled = false;

    await notification('s', () => {
      return 'sync';
    })();
    await notification('s', () => {
      return fetched;
    })();
    await notification('s', () => {
      return Promise.reject(new Error('fetch failed'));
    })();

    const settling = notification.trigger(text.encode('flash')).then((settled) => {
      isSettled = true;

      return settled;
    });

    await Promise.resolve();

    expect(isSettled).toBe(false);

    fetch('fetched');

    expect(await settling).toEqual([
      { status: 'fulfilled', value: 'sync' },
      { status: 'fulfilled', value: 'fetched' },
      { reason: new Error('fetch failed'), status: 'rejected' },
    ]);
  });

  test('carries its window, and refuses one that is not a whole number above 0', () => {
    expect(createNotified({ window: 3 }).notification.window).toBe(3);
    expect(createNotified().notification.window).toBeUndefined();

    for (const window of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => {
        return createNotified({ window });
      }, String(window)).toThrow(`a window is a whole number above 0, not ${String(window)}`);
    }
  });

  test('the same callback registered twice is heard twice, and its registrations taken away one by one', async () => {
    const { notification } = createNotified();
    const heard: string[] = [];
    const callback = (payload: string) => {
      heard.push(payload);
    };
    const first = await notification('s', callback)();

    await notification('s', callback)();
    await notification.trigger(text.encode('both'));
    await first.unregister();
    await first.unregister();
    await notification.trigger(text.encode('one'));

    expect(heard).toEqual(['both', 'both', 'one']);
  });

  test('a trigger never registered is a programmer error; a payload that does not decode, a failure traced', async () => {
    const { asked, notification } = createNotified();

    expect(() => {
      void notification.trigger(text.encode('early'));
    }).toThrow(ProgrammerError);

    await notification('s', () => {
      return undefined;
    })();

    expect(() => {
      void notification.trigger(new Uint8Array(0));
    }).toThrow(FailureError);
    expect(asked.traced).toEqual([
      {
        error: expect.objectContaining({ code: ProtocolCode.PAYLOAD_UNDECODABLE }),
        rx: undefined,
      },
    ]);
  });
});
