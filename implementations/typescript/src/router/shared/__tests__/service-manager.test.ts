import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { PLATFORM_CLOCK } from '../../../transport/shared/clock';
import { createSessionManager } from '../../server/session-manager';
import { judgeRules } from '../../../proto/validate';
import { CredentialScheme } from '../constants';
import {
  createServiceManager,
  DisconnectError,
  FailureError,
  FailureScope,
  ProgrammerError,
  ProtocolCode,
  SERVER_FAILURES,
  type IProcedure,
  type IRequestResolver,
  type IRouterResult,
  type IRouterLike,
  type ProcedureKind,
} from '../service-manager';
import type { IValidateOptions } from '../violations';
import {
  type IText,
  answerOf,
  connectionHandle,
  createFakeRouter,
  echo,
  encode,
  encoder,
  header,
  propsOf,
  recordDebug,
  serializer,
  serverSerializer,
} from './service-manager-fixtures';

// constants

/** A text's rule: one character at least, its violation at `text`. */
const NOT_EMPTY = Object.freeze({
  bounds: Object.freeze({ min_len: '1' }),
  message: 'must be at least 1 characters',
  ruleId: 'string.min_len',
});

/** The detail PAYLOAD_INVALID carries of a text that breaks {@link NOT_EMPTY}. */
const NOT_EMPTY_DETAIL =
  '{"bounds":{"min_len":"1"},"fieldPath":"text","message":"must be at least 1 characters","ruleId":"string.min_len"}\n{"more":0}';

// helpers

/** A text's rules, judged as generated code judges a message's, the options each is given kept. */
const textRulesOf = () => {
  const given: IValidateOptions[] = [];
  const validate = (request: IText, options: IValidateOptions) => {
    given.push(options);

    return judgeRules((sink) => {
      sink.enter('text');

      return request.text === '' && sink.add(NOT_EMPTY, request.text);
    }, options);
  };

  return { given, validate };
};

// definition

test.describe('createServiceManager', () => {
  test.describe('what it makes callable', () => {
    test("a requester, a resolver and a notification carry their procedure's members as their own, and keep a function's call, apply and bind", async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const stating = (procedureId: number, procedureKind: ProcedureKind) => {
        return {
          ...echo,
          deprecation: { message: 'soon' },
          maximumPayloadBytes: 64,
          procedureId,
          procedureKind,
        } satisfies Required<IProcedure>;
      };
      const asked = stating(71, 'request');
      const answered = stating(72, 'request');
      const notifying = stating(73, 'notifies');
      const request = manager.getRequest(asked, { serializer });

      manager.getRequestResolver(answered, { serializer: serverSerializer })(() => {
        return Promise.resolve();
      });

      // the one resolver registered: the one just made
      const resolver = calls.registerResolver[0] as IRequestResolver;
      const notification = manager.getNotification(notifying, { serializer });

      for (const [callable, procedure] of [
        [request, asked],
        [resolver, answered],
        [notification, notifying],
      ] as const) {
        for (const [member, value] of Object.entries(procedure)) {
          expect(Object.hasOwn(callable, member), member).toBe(true);
          expect(Reflect.get(callable, member), member).toEqual(value);
        }

        expect(callable.call).toBe(Function.prototype.call);
        expect(callable.apply).toBe(Function.prototype.apply);
        expect(callable.bind).toBe(Function.prototype.bind);
      }

      // * each one still called through them
      await expect(request.call(undefined, { text: 'call' })()).resolves.toEqual({ text: 'call' });
      await expect(request.apply(undefined, [{ text: 'apply' }])()).resolves.toEqual({
        text: 'apply',
      });
      await expect(request.bind(undefined, { text: 'bind' })()()).resolves.toEqual({
        text: 'bind',
      });
    });

    test("no member of a procedure is one a bare function has, so the runtime's merge shadows none", () => {
      const procedure: Required<IProcedure> = {
        deprecation: { message: 'soon' },
        maximumPayloadBytes: 64,
        procedureId: 1,
        procedureKind: 'command',
        procedureName: 'echo',
        serviceId: 2,
        serviceRevision: 3,
      };
      const bare = () => {
        return undefined;
      };

      for (const member of Object.keys(procedure)) {
        expect(member in bare, member).toBe(false);
      }
    });
  });

  test.describe('debug', () => {
    test("refuses a clock that differs from its router's", () => {
      const { router } = createFakeRouter('server', createTestClock());

      expect(createServiceManager(router, { clock: router.clock })).toBeDefined();
      expect(() => {
        createServiceManager(router, { clock: PLATFORM_CLOCK });
      }).toThrow(
        new ProgrammerError(
          "a service manager runs on the clock of its router, one of its own, and was given another, the platform's"
        )
      );
    });

    // spec 17.2.2
    test('an answer that does not decode fails the call here, with its header and its call', async () => {
      const { control, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const answer = answerOf(encoder.encode('{not json'));

      control.answer = () => {
        return Promise.resolve(answer);
      };

      const failing = manager.getRequest(echo, { serializer })({ text: 'x' })({ destinationId: 4 });

      await expect(failing).rejects.toBeInstanceOf(FailureError);
      await expect(failing).rejects.toMatchObject({
        cause: expect.any(SyntaxError),
        code: ProtocolCode.PAYLOAD_UNDECODABLE,
        destinationId: 4,
        header: { callId: 7, kind: 0x11 },
        origin: 'local',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        scope: FailureScope.PROTOCOL,
        side: 'client',
      });
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, error instanceof FailureError, info.rx];
        })
      ).toEqual([
        ['tx', false, undefined],
        ['rx', true, expect.objectContaining({ code: ProtocolCode.PAYLOAD_UNDECODABLE })],
      ]);
    });
  });

  test.describe('getNotificationResolver', () => {
    test('registers its resolver with its notify, for its router to declare it as the side that notifies', () => {
      const { calls, router } = createFakeRouter();

      createServiceManager(router).getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      expect(
        calls.registerResolver.map((resolver) => {
          return typeof (resolver as { notify?: unknown }).notify;
        })
      ).toEqual(['function']);
    });

    test('notifies through the router with the encoded notification', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await resolver.notify({ text: 'news' });

      expect(calls.registerResolver).toEqual([resolver]);
      expect(calls.notify).toEqual([
        { filter: undefined, key: undefined, payload: { text: 'news' }, procedure: echo },
      ]);
    });

    test('its callback may subscribe the requester before answering, and is given the call id; not after', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const late: unknown[] = [];

      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        async (_request, response) => {
          const callId = response.registerNotification();

          await response({ text: String(callId) });

          try {
            response.registerNotification();
          } catch (reason) {
            late.push(reason);
          }
        }
      );

      await resolver(propsOf(encode({ text: 'subscribe' })));

      expect(calls.subscribe).toEqual([{ connectionHandle, header }]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: '7' }) });
      expect(late).toEqual([expect.any(ProgrammerError)]);
    });

    test('tells the router whom its options keep: none excluded, and those the filter keeps', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );
      const handles = ['a', 'b', 'c'];

      await resolver.notify({ text: 'news' }, {});
      await resolver.notify({ text: 'news' }, { exclude: 'b' });
      await resolver.notify(
        { text: 'news' },
        {
          filter: ({ connectionHandle }) => {
            return connectionHandle !== 'a';
          },
        }
      );
      await resolver.notify(
        { text: 'news' },
        {
          exclude: 'c',
          filter: ({ connectionHandle }) => {
            return connectionHandle !== 'a';
          },
        }
      );

      expect(
        calls.notify.map(({ filter }) => {
          return filter === undefined
            ? 'each'
            : handles.filter((connectionHandle) => {
                return filter({ connectionHandle });
              });
        })
      ).toEqual(['each', ['a', 'c'], ['b', 'c'], ['b']]);
    });

    test("hands the filter one subscriber, its connection and its session's identifier", async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );
      const grace = { id: 'grace', scheme: CredentialScheme.ELSEWHERE } as const;
      const seen: unknown[] = [];

      await resolver.notify(
        { text: 'news' },
        {
          exclude: 'b',
          filter: (subscriber) => {
            seen.push(subscriber);

            return subscriber.identifier !== undefined;
          },
        }
      );

      const [{ filter } = { filter: undefined }] = calls.notify;

      expect([
        filter?.({ connectionHandle: 'a', identifier: grace }),
        filter?.({ connectionHandle: 'a' }),
        filter?.({ connectionHandle: 'b', identifier: grace }),
      ]).toEqual([true, false, false]);
      expect(seen).toEqual([
        { connectionHandle: 'a', identifier: grace },
        { connectionHandle: 'a' },
      ]);
    });

    test('tells the router what a notification is about, for a paced subscription to keep its latest', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await resolver.notify({ text: 'news' }, { key: 7 });
      await resolver.notify({ text: 'news' }, { key: 'seven' });

      expect(
        calls.notify.map(({ key }) => {
          return key;
        })
      ).toEqual([7, 'seven']);
    });

    // spec 17.2.6
    test("a notification whose value does not write goes to its router in its payload's place, its failure told at its start, and resolves", async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const refusal = new TypeError('this value does not write');
      const resolver = manager.getNotificationResolver(echo, {
        serializer: {
          ...serverSerializer,
          encodeNotification: () => {
            throw refusal;
          },
        },
      })(() => {
        return Promise.resolve();
      });

      await expect(resolver.notify({ text: 'news' })).resolves.toBeUndefined();
      expect(
        calls.notify.map(({ payload }) => {
          return payload;
        })
      ).toStrictEqual([refusal]);
      expect(
        seen.map(({ error, info: { direction, startedAt } }) => {
          return [error, direction, startedAt];
        })
      ).toEqual([
        [null, 'tx', seen[0]?.info.startedAt],
        [refusal, 'tx', seen[0]?.info.startedAt],
      ]);
    });

    test('a failed notify resolves all the same, and only debug hears of it', async () => {
      const { control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const failure = new Error('gone');

      control.notifyError = failure;

      const resolver = manager.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await expect(resolver.notify({ text: 'news' })).resolves.toBeUndefined();
      expect(
        seen.map(({ error }) => {
          return error;
        })
      ).toEqual([null, failure]);
    });
  });

  test.describe('getNotification', () => {
    test('the first registration requests, registers, and then hears each notification', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(text);
      })();
      deliver(echo, { text: 'one' });
      deliver(echo, { text: 'two' });

      expect(calls.request.length).toBe(1);
      expect(calls.request[0]?.request.subscribes).toBe(notification);
      expect(calls.registerNotification).toEqual(['echo']);
      expect(heard).toEqual(['one', 'two']);
    });

    test('its request takes the destination and the timeout it is given, and names the notification it subscribes', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 's' }, () => {
        return undefined;
      })({ destinationId: 3, timeout: 50 });

      expect(calls.request[0]?.request).toEqual({
        options: { destinationId: 3, signal: undefined, timeout: 50 },
        procedure: echo,
        subscribes: notification,
      });
    });

    test('the router holds it before its request goes out, so a notification right behind the answer is heard', async () => {
      const { control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];

      // the notification comes with the answer, before anything waiting on the answer runs
      control.answer = (payload) => {
        deliver(echo, { text: 'right behind' });

        return Promise.resolve(answerOf(payload));
      };

      await manager.getNotification(echo, { serializer })({ text: 's' }, ({ text }) => {
        heard.push(text);
      })();

      expect(heard).toEqual(['right behind']);
    });

    test('once registered, another callback joins without a request', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      await notification({ text: 'subscribe' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(1);
      expect(heard).toEqual(['first news', 'second news']);
    });

    test('callbacks registering at once share one request and one registration', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await Promise.all([
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })(),
        notification({ text: 'b' }, ({ text }) => {
          heard.push(`b ${text}`);
        })(),
      ]);
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(1);
      expect(calls.registerNotification).toEqual(['echo']);
      expect(heard).toEqual(['a news', 'b news']);
    });

    test('a failed request rejects and keeps nothing: the next registration asks again', async () => {
      const { holds, calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const failure = new Error('refused');

      control.answer = () => {
        return Promise.reject(failure);
      };

      await expect(
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })()
      ).rejects.toBe(failure);
      expect(holds(echo)).toBe(false);

      control.answer = (payload) => {
        return Promise.resolve(answerOf(payload));
      };

      await notification({ text: 'b' }, ({ text }) => {
        heard.push(`b ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(calls.request.length).toBe(2);
      expect(heard).toEqual(['b news']);
      // the router cancels, by default, whatever its call may have left at the other end
      expect(calls.unregisterOptions).toEqual([undefined]);
    });

    test('an answer to its subscription that does not decode lets go of it, the router cancelling its call', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      control.answer = () => {
        return Promise.resolve(answerOf(encoder.encode('{not json')));
      };

      await expect(
        notification({ text: 'a' }, () => {
          return undefined;
        })()
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
      expect(holds(echo)).toBe(false);
      expect(calls.unregisterOptions).toEqual([undefined]);
    });

    test('the last callback taken away unregisters the notification; taking one away twice does nothing', async () => {
      const { holds, calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      const first = await notification({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      const second = await notification({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();

      await first.unregister();
      await first.unregister();
      deliver(echo, { text: 'one' });

      expect(calls.unregisterNotification).toEqual([]);

      await second.unregister();

      expect(calls.unregisterNotification).toEqual(['echo']);
      // with no unsubscription to tell the other end, the router cancels its call
      expect(calls.unregisterOptions).toEqual([{ cancel: true }]);
      expect(holds(echo)).toBe(false);
      expect(heard).toEqual(['second one']);
    });

    test('the last callback out unsubscribes with the call id and the answer that subscribed, before the router lets go of it', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const told: string[] = [];

      control.answer = () => {
        return Promise.resolve(answerOf(encode({ text: 'subscription 7' })));
      };

      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: (callId, response) => {
          told.push(`${String(callId)}: ${response.text}, held ${String(holds(echo))}`);

          return Promise.resolve();
        },
      });
      const first = await notification({ text: 's' }, () => {
        return undefined;
      })();
      const second = await notification({ text: 's' }, () => {
        return undefined;
      })();

      await first.unregister();

      expect(told).toEqual([]);

      await second.unregister();

      expect(told).toEqual(['7: subscription 7, held true']);
      expect(calls.unregisterNotification).toEqual(['echo']);
      // taken away at the other end, acknowledged: nothing is left there to cancel
      expect(calls.unregisterOptions).toEqual([{ cancel: false }]);
    });

    test('an unsubscription that fails rejects the last unregister, once the router let go all the same', async () => {
      const { holds, calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failure = new Error('refused');
      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: () => {
          return Promise.reject(failure);
        },
      });
      const registration = await notification({ text: 's' }, () => {
        return undefined;
      })();

      await expect(registration.unregister()).rejects.toBe(failure);
      expect(holds(echo)).toBe(false);
      // the other end may hold it still: the router cancels its call
      expect(calls.unregisterOptions).toEqual([{ cancel: true }]);

      // what comes next is not held back by it
      await notification({ text: 's' }, () => {
        return undefined;
      })();

      expect(calls.request.length).toBe(2);
    });

    test('dropped with its connection, it tells "dropped", hears nothing more, has nothing to take away, and asks anew', async () => {
      const { calls, deliver, drop, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const dropped: unknown[] = [];
      const unsubscribed: unknown[] = [];

      manager.on('dropped', (procedure, failure) => {
        dropped.push([procedure, failure]);
      });

      const notification = manager.getNotification(echo, {
        serializer,
        unsubscribe: (_callId, response) => {
          unsubscribed.push(response);

          return Promise.resolve();
        },
      });
      const registration = await notification({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();

      drop();
      await registration.unregister();

      expect(dropped).toEqual([[echo, undefined]]);
      expect(unsubscribed).toEqual([]);
      expect(calls.unregisterNotification).toEqual([]);

      await notification({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['second news']);
      expect(calls.request.length).toBe(2);

      // ended by the server: "dropped" says with what
      const failure = { ...SERVER_FAILURES.capacityExceeded, detail: 'queued', relays: 0 };

      drop(failure);

      expect(dropped).toEqual([
        [echo, undefined],
        [echo, failure],
      ]);
    });

    test('makes a notification with the window its dependencies give, paced by it', () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router);

      expect(manager.getNotification(echo, { serializer, window: 2 }).window).toBe(2);
      expect(
        manager.getNotification({ ...echo, procedureId: 9 }, { serializer }).window
      ).toBeUndefined();
    });

    test('a registration under way when its notification is dropped fails with a DisconnectError', async () => {
      const { control, deliver, drop, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const answered = Promise.withResolvers<IRouterResult>();

      control.answer = () => {
        return answered.promise;
      };

      const registering = manager.getNotification(echo, { serializer })(
        { text: 's' },
        ({ text }) => {
          heard.push(text);
        }
      )();

      await sleep(0);
      drop();
      answered.resolve(answerOf(encode({ text: 'ok' })));

      await expect(registering).rejects.toBeInstanceOf(DisconnectError);

      deliver(echo, { text: 'news' });

      expect(heard).toEqual([]);
    });

    test('"await using" takes the callback away', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });

      {
        await using registration = await notification({ text: 's' }, () => {
          return undefined;
        })();

        expect(registration).toBeDefined();
      }

      expect(calls.unregisterNotification).toEqual(['echo']);
    });

    test('a registration while the last one is leaving waits for it, then registers anew', async () => {
      const { calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const gate = Promise.withResolvers<undefined>();

      const leaving = await notification({ text: 's' }, () => {
        return undefined;
      })();

      control.unregisterGate = gate.promise;

      const left = leaving.unregister();
      const joining = notification({ text: 's' }, ({ text }) => {
        heard.push(text);
      })();

      gate.resolve(undefined);
      await left;
      await joining;
      deliver(echo, { text: 'news' });

      expect(calls.registerNotification).toEqual(['echo', 'echo']);
      expect(heard).toEqual(['news']);
    });

    test('taking the same registration away twice leaves another of the same callback alone', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });
      const callback = ({ text }: IText) => {
        heard.push(text);
      };

      const first = await notification({ text: 's' }, callback)();
      const second = await notification({ text: 's' }, callback)();

      await first.unregister();
      await first.unregister();
      deliver(echo, { text: 'one' });

      expect(calls.unregisterNotification).toEqual([]);
      expect(heard).toEqual(['one']);

      await second.unregister();
      await second.unregister();

      expect(calls.unregisterNotification).toEqual(['echo']);
    });

    test('a registration arriving while the router subscribes waits for the subscription', async () => {
      const { holds, calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const notification = manager.getNotification(echo, { serializer });
      const gate = Promise.withResolvers<undefined>();
      const settled: string[] = [];

      control.subscribeGate = gate.promise;

      const first = notification({ text: 'a' }, () => {
        return undefined;
      })().then(() => {
        settled.push('first');
      });

      // the router holds it now, and is still subscribing
      await sleep(0);
      expect(holds(echo)).toBe(true);

      const second = notification({ text: 'b' }, () => {
        return undefined;
      })().then(() => {
        settled.push('second');
      });

      await sleep(10);
      expect(settled).toEqual([]);

      gate.resolve(undefined);
      await Promise.all([first, second]);

      expect(settled).toEqual(['first', 'second']);
      expect(calls.request.length).toBe(1);
    });

    test('a subscription that fails is undone, so the next registration starts over', async () => {
      const { holds, calls, control, deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const notification = manager.getNotification(echo, { serializer });

      control.subscribeError = new Error('refused by the broker');

      await expect(
        notification({ text: 'a' }, ({ text }) => {
          heard.push(`a ${text}`);
        })()
      ).rejects.toThrow('refused by the broker');
      expect(holds(echo)).toBe(false);
      expect(calls.unregisterNotification).toEqual(['echo']);

      control.subscribeError = undefined;

      await notification({ text: 'b' }, ({ text }) => {
        heard.push(`b ${text}`);
      })();
      deliver(echo, { text: 'news' });

      // the first never asked: the router could not hold it
      expect(calls.request.length).toBe(1);
      expect(heard).toEqual(['b news']);
    });

    test('a second manager on the same router cannot take its procedure over, nor away', async () => {
      const { calls, deliver, router } = createFakeRouter();
      const first = createServiceManager(router);
      const second = createServiceManager(router);
      const heard: string[] = [];

      const registration = await first.getNotification(echo, { serializer })(
        { text: 's' },
        ({ text }) => {
          heard.push(text);
        }
      )();

      await expect(
        second.getNotification(echo, { serializer })({ text: 's' }, () => {
          return undefined;
        })()
      ).rejects.toBeInstanceOf(ProgrammerError);

      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['news']);
      expect(calls.unregisterNotification).toEqual([]);

      await registration.unregister();
    });

    test('the same procedure gives the same notification, so every callback is heard', async () => {
      const { deliver, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const heard: string[] = [];
      const first = manager.getNotification(echo, { serializer });
      const second = manager.getNotification(echo, { serializer });

      expect(second).toBe(first);

      await first({ text: 's' }, ({ text }) => {
        heard.push(`first ${text}`);
      })();
      await second({ text: 's' }, ({ text }) => {
        heard.push(`second ${text}`);
      })();
      deliver(echo, { text: 'news' });

      expect(heard).toEqual(['first news', 'second news']);
    });

    test('the same procedure under another kind, name, revision, deprecation or limit is a programmer error', () => {
      const manager = createServiceManager(createFakeRouter().router);

      manager.getNotification(echo, { serializer });

      for (const asked of [
        { ...echo, procedureKind: 'notifies' as const },
        { ...echo, procedureName: 'echo2' },
        { ...echo, serviceRevision: 4 },
        { ...echo, deprecation: {} },
        { ...echo, deprecation: { message: 'soon' } },
        { ...echo, maximumPayloadBytes: 8 },
      ]) {
        expect(() => {
          return manager.getNotification(asked, { serializer });
        }).toThrow(ProgrammerError);
      }

      // the same deprecation, asked again, is the same ask
      const deprecated = { ...echo, deprecation: { message: 'use news2' }, procedureId: 70 };

      expect(manager.getNotification(deprecated, { serializer })).toBe(
        manager.getNotification(
          { ...deprecated, deprecation: { message: 'use news2' } },
          { serializer }
        )
      );

      // a serializer of its own, for the same ask, gets the same notification
      expect(manager.getNotification(echo, { serializer: { ...serializer } })).toBe(
        manager.getNotification(echo, { serializer })
      );
    });

    test('refuses a notification asked for again at another window, none against one among them, and gives the same at the same', () => {
      for (const [pacedId, unpacedId] of [
        [71, 1],
        [1, 9],
      ] as const) {
        const manager = createServiceManager(createFakeRouter('client').router);
        const paced = { ...echo, procedureId: pacedId };
        const unpacedProcedure = { ...echo, procedureId: unpacedId };
        const notification = manager.getNotification(paced, { serializer, window: 4 });

        expect(manager.getNotification(paced, { serializer, window: 4 })).toBe(notification);
        expect(() => {
          return manager.getNotification(paced, { serializer, window: 1 });
        }).toThrow(
          new ProgrammerError(
            `2/${String(pacedId)} is already a notification with window 4, not window 1`
          )
        );
        expect(() => {
          return manager.getNotification(paced, { serializer });
        }).toThrow(ProgrammerError);

        const unpaced = manager.getNotification(unpacedProcedure, { serializer });

        expect(manager.getNotification(unpacedProcedure, { serializer })).toBe(unpaced);
        expect(() => {
          return manager.getNotification(unpacedProcedure, { serializer, window: 1 });
        }).toThrow(ProgrammerError);
        expect(() => {
          return manager.getNotification(unpacedProcedure, { serializer, window: 1 });
        }).toThrow(
          new ProgrammerError(
            `2/${String(unpacedId)} is already a notification with no window, not window 1`
          )
        );
      }
    });

    test("refuses a procedure off section 16 before its own reason, a notification's asked for otherwise", () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router);

      manager.getNotification(echo, { serializer });

      expect(() => {
        manager.getNotification({ ...echo, procedureName: 'Echo' }, { serializer });
      }).toThrow(/: off its form$/);
      expect(() => {
        manager.getNotification({ ...echo, serviceRevision: 0 }, { serializer });
      }).toThrow(/: out of its range$/);
    });

    test('a trigger the router never registered is a programmer error', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const notification = manager.getNotification(echo, { serializer });

      expect(() => {
        void notification.trigger(encode({ text: 'stray' }));
      }).toThrow(ProgrammerError);
    });

    // debugging 4.1.10, 4.2.5 and 4.2.6
    test('tells a notification sent or heard with no call id', async () => {
      const { deliver, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const notifying = createServiceManager(createFakeRouter('server').router);
      const notification = manager.getNotification(echo, { serializer });
      const resolver = notifying.getNotificationResolver(echo, { serializer: serverSerializer })(
        () => {
          return Promise.resolve();
        }
      );

      await notification({ text: 's' }, () => {
        return undefined;
      })();

      const seen = recordDebug(manager);
      const sent = recordDebug(notifying);

      deliver(echo, { text: 'news' });
      await resolver.notify({ text: 'more news' });

      // * a notification names no call: no id, and no connection
      expect(
        [...seen, ...sent].map(({ info }) => {
          return [
            info.direction,
            info.type,
            info.rx ?? info.tx,
            info.callId,
            info.connectionHandle,
          ];
        })
      ).toEqual([
        ['rx', 'notification', { text: 'news' }, undefined, undefined],
        ['tx', 'notification', { text: 'more news' }, undefined, undefined],
      ]);
    });

    // spec 17.2.3
    test('a notification that does not decode fails here, for the router to report', async () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const heard: unknown[] = [];
      const notification = manager.getNotification(echo, { serializer });

      await notification({ text: 's' }, (payload) => {
        heard.push(payload);
      })();

      const seen = recordDebug(manager);
      let failure: unknown;

      try {
        void notification.trigger(encoder.encode('{not json'));
      } catch (reason) {
        failure = reason;
      }

      expect(failure).toBeInstanceOf(FailureError);
      expect(failure).toMatchObject({
        cause: expect.any(SyntaxError),
        code: ProtocolCode.PAYLOAD_UNDECODABLE,
        header: undefined,
        origin: 'local',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        side: 'client',
      });
      expect(heard).toEqual([]);
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.type, error];
        })
      ).toEqual([['rx', 'notification', failure]]);
    });
  });

  test.describe('getRequestResolver', () => {
    test('answers PAYLOAD_INVALID to a request its rules refuse, before its callback', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const { given, validate } = textRulesOf();
      const seen: IText[] = [];

      const resolver = manager.getRequestResolver(echo, {
        failFast: true,
        serializer: serverSerializer,
        validate,
      })((request, response) => {
        seen.push(request.payload);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: '' })));
      await resolver(propsOf(encode({ text: 'hi' })));

      expect(seen).toEqual([{ text: 'hi' }]);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          // * stopped at its first, as its failFast asks: its detail says so, never a count
          response: {
            failure: {
              ...SERVER_FAILURES.payloadInvalid,
              detail: NOT_EMPTY_DETAIL.replace('{"more":0}', '{"stopped":true}'),
            },
          },
        },
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi' }) } },
      ]);
      // * judged under the detail's bound of its router, with its dependencies' failFast
      expect(given).toEqual([
        { failFast: true, maximumBytes: 1_024 },
        { failFast: true, maximumBytes: 1_024 },
      ]);
    });

    test('traces a request its rules refuse: its rx, then its failure', async () => {
      const { router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const { validate } = textRulesOf();

      const resolver = manager.getRequestResolver(echo, {
        serializer: serverSerializer,
        validate,
      })((request, response) => {
        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: '' })));

      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.callId, error, info.rx, info.tx];
        })
      ).toEqual([
        ['rx', 7, null, { text: '' }, undefined],
        [
          'tx',
          7,
          null,
          { text: '' },
          { ...SERVER_FAILURES.payloadInvalid, detail: NOT_EMPTY_DETAIL },
        ],
      ]);
    });

    test('answers PROCEDURE_FAILED to rules that throw, and hands why on for its router to report', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const broken = new RangeError('a rule that fails to judge');

      const resolver = manager.getRequestResolver(echo, {
        serializer: serverSerializer,
        validate: () => {
          throw broken;
        },
      })((request, response) => {
        return response(request.payload);
      });

      await expect(resolver(propsOf(encode({ text: 'hi' })))).rejects.toBe(broken);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
      ]);
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, error];
        })
      ).toEqual([
        ['rx', null],
        ['tx', broken],
      ]);
    });
  });

  test('a router’s own handle type reaches the callback, for the session manager to take', async () => {
    const { calls, router } = createFakeRouter();
    const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
    using sessions = createSessionManager();

    sessions.getOrElseSet(connectionHandle);

    const resolver = manager.getRequestResolver(echo, {
      beforeRequest: (request) => {
        return sessions.has(request.connectionHandle);
      },
      serializer: serverSerializer,
    })((request, response) => {
      return response(request.payload);
    });

    await resolver(propsOf(encode({ text: 'hi' })));

    expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'hi' }) });
  });
});
