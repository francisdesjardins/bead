import { expect, test } from '@playwright/test';
import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { PLATFORM_CLOCK } from '../../../transport/shared/clock';
import { noop } from '../../../transport/shared/noop';
import {
  CLIENT_FAILURES,
  createServiceManager,
  FailureError,
  FailureScope,
  ProgrammerError,
  SERVER_FAILURES,
  type IBeforeRequest,
  type IProtocolFailure,
} from '../service-manager';
import { createServiceResolver, type IServiceResolverOptions } from '../service-resolver';
import { createServiceTrace } from '../service-trace';
import {
  type IText,
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

// definition

test.describe('createServiceManager', () => {
  test.describe('getRequestResolver', () => {
    test('traces an application failure as the answer with its request and duration', async () => {
      const clock = createTestClock(1_000);
      const { calls, router } = createFakeRouter('server', clock);
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const failure = { code: 7, detail: 'why' };
      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        _request,
        response
      ) => {
        clock.tick(30);

        return response(null, failure);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: { ...failure, scope: FailureScope.APPLICATION } },
        },
      ]);
      expect(seen).toHaveLength(2);
      expect(
        seen.map(({ error, info }) => {
          return [error, info.direction, info.rx, info.tx, info.duration, info.startedAt];
        })
      ).toEqual([
        [null, 'rx', { text: 'hi' }, undefined, undefined, 1_000],
        [null, 'tx', { text: 'hi' }, failure, 30, 1_000],
      ]);
      expect(
        seen.map(({ info }) => {
          return [info.callId, info.connectionHandle, info.type];
        })
      ).toEqual([
        [header.callId, connectionHandle, 'request'],
        [header.callId, connectionHandle, 'request'],
      ]);
      expect(calls.report).toEqual([]);
    });

    test('hands the router a procedure’s payload limit, with its requests and its resolver, and nothing else it carries', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const limited = { ...echo, extra: 'kept here', maximumPayloadBytes: 64 };

      manager.getRequestResolver(limited, { serializer: serverSerializer })(() => {
        return Promise.resolve();
      });
      await manager.getRequest(limited, { serializer })({ text: 'hi' })();

      expect([
        calls.registerResolver[0]?.maximumPayloadBytes,
        calls.request[0]?.request.procedure,
      ]).toEqual([64, { ...echo, maximumPayloadBytes: 64 }]);
      expect(calls.registerResolver[0]).not.toHaveProperty('extra');
    });

    test('refuses a resolver off section 16 as it is asked for, before its callback is given', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const named = { ...echo, procedureName: 'Echo' };
      const ranged = { ...echo, serviceRevision: 0 };

      expect(() => {
        manager.getRequestResolver(named, { serializer: serverSerializer });
      }).toThrow(/ is off its form: /);
      expect(() => {
        manager.getCommandResolver(named, { serializer: serverSerializer });
      }).toThrow(/ is off its form: /);
      expect(() => {
        manager.getNotificationResolver(ranged, { serializer: serverSerializer });
      }).toThrow(/ is out of its range: /);
    });

    test('makes and registers the resolver only once it is given its callback', () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const define = manager.getRequestResolver(echo, { serializer: serverSerializer });

      expect(calls.registerResolver).toEqual([]);

      const resolver = define(() => {
        return Promise.resolve();
      });

      expect(calls.registerResolver).toEqual([resolver]);
      expect(resolver.name).toBe('echo');
      expect(resolver.procedureId).toBe(1);
    });

    test('hands the callback a frozen, decoded request, and sends its answer back', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const handed: unknown[] = [];
      let frozen = false;

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        frozen = Object.isFrozen(request);
        handed.push(request.payload, request.connectionHandle, request.header);

        return response({ text: `${request.payload.text}!` });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(frozen).toBe(true);
      expect(handed).toEqual([{ text: 'hi' }, connectionHandle, header]);
      expect(handed[2]).toBe(header);
      expect(calls.respond).toEqual([
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi!' }) } },
      ]);
    });

    test('hands the callback the signal of its call, which its cancel aborts', async () => {
      const { router } = createFakeRouter();
      const manager = createServiceManager(router);
      const controller = new AbortController();
      const seen: boolean[] = [];

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        seen.push(request.signal.aborted);
        await Promise.resolve();
        controller.abort();
        seen.push(request.signal.aborted);

        return response({ text: 'late' });
      });

      await resolver(propsOf(encode({ text: 'hi' }), controller.signal));

      expect(seen).toEqual([false, true]);
    });

    test('an answer with a failure of the procedure’s own sends it as the application’s', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        _request,
        response
      ) => {
        return response(null, { code: 7, detail: 'why' });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond[0]?.response).toEqual({
        failure: { code: 7, detail: 'why', scope: FailureScope.APPLICATION },
      });
    });

    test('a payload that does not decode is answered as undecodable, with no detail, never reaching the callback', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      let reached = false;

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(() => {
        reached = true;

        return Promise.resolve();
      });

      await resolver(propsOf(encoder.encode('{not json')));

      expect(reached).toBe(false);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.payloadUndecodable },
        },
      ]);
    });

    test('a request "beforeRequest" refuses is answered with an access denied, seen on its header alone', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const reached: string[] = [];
      const seen: string[][] = [];
      const handed: unknown[] = [];

      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: (request) => {
          seen.push(Object.keys(request));
          handed.push(request);

          return request.header.callId === 9;
        },
        serializer: serverSerializer,
      })((request, response) => {
        reached.push(request.payload.text);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'refused' })));
      await resolver({ ...propsOf(encode({ text: 'allowed' })), header: { ...header, callId: 9 } });

      expect(reached).toEqual(['allowed']);
      expect(seen).toEqual([
        ['connectionHandle', 'header', 'session'],
        ['connectionHandle', 'header', 'session'],
      ]);
      expect(handed).toEqual([
        { connectionHandle, header, session: undefined },
        { connectionHandle, header: { ...header, callId: 9 }, session: undefined },
      ]);
      expect(calls.respond[0]?.response).toEqual({ failure: SERVER_FAILURES.accessDenied });
    });

    test('on a client’s router, a refusal is the client’s', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      // refused before it is read, one that does not decode as well
      await resolver(propsOf(encoder.encode('{not json')));
      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual([CLIENT_FAILURES.accessDenied, CLIENT_FAILURES.accessDenied]);
    });

    test('a request is answered once: a second answer is a programmer error, and sends nothing', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const second: unknown[] = [];

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        await response(request.payload);
        second.push(
          await response(request.payload).catch((reason: unknown) => {
            return reason;
          }),
          await response(null, { code: 1 }).catch((reason: unknown) => {
            return reason;
          })
        );
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(calls.respond).toHaveLength(1);
      expect(second).toEqual([expect.any(ProgrammerError), expect.any(ProgrammerError)]);
    });

    test('a callback that fails before it answers is answered as failed, and its reason goes on to the router', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const thrown = new Error('thrown');
      const rejected = new Error('rejected');

      const throwing = manager.getRequestResolver(echo, { serializer: serverSerializer })(() => {
        throw thrown;
      });
      const rejecting = manager.getRequestResolver(
        { ...echo, procedureId: 2 },
        { serializer: serverSerializer }
      )(() => {
        return Promise.reject(rejected);
      });
      const refusing = manager.getRequestResolver(
        { ...echo, procedureId: 3 },
        {
          beforeRequest: () => {
            throw thrown;
          },
          serializer: serverSerializer,
        }
      )(() => {
        return Promise.resolve();
      });

      const request = propsOf(encode({ text: 'hi' }));

      await expect(throwing(request)).rejects.toBe(thrown);
      await expect(rejecting(request)).rejects.toBe(rejected);
      await expect(refusing(request)).rejects.toBe(thrown);

      // the reason stays with the router: what the requester hears is only that it failed
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.procedureFailed },
        },
      ]);
    });

    // spec 17.2.5
    test('an answer that cannot go out leaves the request to be answered as failed', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failures: unknown[] = [];
      const answers: {
        failure?: { code: number; scope?: number; side?: string };
        payload?: IText;
      }[] = [
        // an answer the serializer cannot encode
        { payload: { text: 'unencodable' } },
        // a code of the procedure's own outside 1 to 65535
        { failure: { code: 0 } },
        { failure: { code: 0x10000 } },
        { failure: { code: 1.5 } },
        // a protocol failure other than an admission's, or of the other side's table
        { failure: SERVER_FAILURES.serviceUnknown },
        { failure: CLIENT_FAILURES.accessDenied },
        { failure: { code: 21, scope: FailureScope.APPLICATION } },
      ];

      for (const [index, answer] of answers.entries()) {
        const resolver = manager.getRequestResolver(
          { ...echo, procedureId: 10 + index },
          {
            serializer: {
              ...serverSerializer,
              encode: (value: IText) => {
                if (value.text === 'unencodable') {
                  throw new TypeError('cannot encode');
                }

                return encode(value);
              },
            },
          }
        )((_request, response) => {
          // what a caller without types may answer
          return answer.failure === undefined
            ? response(answer.payload ?? { text: '' })
            : response(null, answer.failure as unknown as { code: number });
        });

        failures.push(
          await resolver(propsOf(encode({ text: 'hi' }))).catch((reason: unknown) => {
            return reason;
          })
        );
      }

      expect(failures).toEqual([
        expect.any(TypeError),
        ...Array<unknown>(6).fill(expect.any(ProgrammerError)),
      ]);
      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual(Array(7).fill(SERVER_FAILURES.procedureFailed));
    });

    test('an answer the router cannot send is answered as failed, and the callback hears why', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const tooLong = new FailureError(SERVER_FAILURES.payloadTooLarge);
      const respond = router.respond;
      let heard: unknown;

      // the payload answer goes nowhere; a failure goes out
      router.respond = (response, request) => {
        return response.failure === undefined
          ? Promise.reject(tooLong)
          : respond(response, request);
      };

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        heard = await response(request.payload).catch((reason: unknown) => {
          return reason;
        });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(heard).toBe(tooLong);
      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual([SERVER_FAILURES.procedureFailed]);
    });

    test('a refusal that cannot go out is not answered again', async () => {
      const { calls, control, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const gone = new Error('gone');

      control.respondError = gone;

      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      await expect(resolver(propsOf(encode({ text: 'hi' })))).rejects.toBe(gone);
      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.accessDenied },
        },
      ]);
    });

    test('a callback that fails after it answered is not answered again', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const failure = new Error('after');

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        await response(request.payload);

        throw failure;
      });

      await expect(resolver(propsOf(encode({ text: 'hi' })))).rejects.toBe(failure);
      expect(calls.respond).toEqual([
        { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi' }) } },
      ]);
    });

    // debugging 4.1.10, 4.2.3 and 4.2.4
    test('tells the request it received and the answer it sent with that request’s call id and connection', async () => {
      const clock = createTestClock(1_000);
      const manager = createServiceManager(createFakeRouter('server', clock).router);
      const seen = recordDebug(manager);

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        clock.tick(30);
        return response({ text: `${request.payload.text}!` });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        seen.map(({ info }) => {
          return [
            info.direction,
            info.rx,
            info.tx,
            info.duration === undefined,
            info.callId,
            info.connectionHandle,
          ];
        })
      ).toEqual([
        ['rx', { text: 'hi' }, undefined, true, header.callId, connectionHandle],
        ['tx', { text: 'hi' }, { text: 'hi!' }, false, header.callId, connectionHandle],
      ]);
      expect(seen[1]?.info.duration).toBe(30);
      const received = {
        callId: 7,
        connectionHandle,
        direction: 'rx',
        procedureId: 1,
        procedureName: 'echo',
        rx: { text: 'hi' },
        serviceId: 2,
        serviceRevision: 3,
        startedAt: 1_000,
        type: 'request',
      };
      expect(
        seen.map(({ info }) => {
          return info;
        })
      ).toEqual([received, { ...received, direction: 'tx', duration: 30, tx: { text: 'hi!' } }]);
    });

    test('a received call starts as it arrives: its admission and its decoding count in its duration', async () => {
      const start = Date.UTC(2026, 0, 1);
      const clock = createTestClock(start);
      const manager = createServiceManager(createFakeRouter('server', clock).router);
      const seen = recordDebug(manager);

      // its admission takes 20 ms, and its callback 10 more
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          clock.tick(20);

          return true;
        },
        serializer: serverSerializer,
      })(async (request, response) => {
        await clock.tickAsync(10);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(
        seen.map(({ info: { direction, duration, startedAt } }) => {
          return [direction, startedAt, duration];
        })
      ).toEqual([
        ['rx', start, undefined],
        ['tx', start, 30],
      ]);
    });

    // debugging 4.2, 4.2.4 and 4.3
    test('tells a callback that fails before it answers as an answer that did not go, with why beside it; nothing more for one that fails once it answered, nor for an admission that fails', async () => {
      for (const [instant, rejectDelay, answerDelay, afterDelay] of [
        [Date.UTC(2026, 0, 1), 10, 0, 0],
        [1_000, 20, 5, 5],
      ] as const) {
        const start = instant;
        const clock = createTestClock(start);
        const manager = createServiceManager(createFakeRouter('server', clock).router);
        const seen = recordDebug(manager);
        const thrown = new Error('thrown');
        const rejected = new Error('rejected');
        const after = new Error('after');

        // the first throws after 10 ms; the next uses its own delay
        const throwing = manager.getRequestResolver(echo, { serializer: serverSerializer })(() => {
          clock.tick(10);

          throw thrown;
        });
        const rejecting = manager.getRequestResolver(
          { ...echo, procedureId: 2 },
          { serializer: serverSerializer }
        )(() => {
          clock.tick(rejectDelay);

          return Promise.reject(rejected);
        });
        const refusing = manager.getRequestResolver(
          { ...echo, procedureId: 3 },
          {
            beforeRequest: () => {
              throw thrown;
            },
            serializer: serverSerializer,
          }
        )(() => {
          return Promise.resolve();
        });
        const failingOnceAnswered = manager.getRequestResolver(
          { ...echo, procedureId: 4 },
          { serializer: serverSerializer }
        )(async (request, response) => {
          clock.tick(answerDelay);
          await response(request.payload);
          clock.tick(afterDelay);

          throw after;
        });

        const request = propsOf(encode({ text: 'hi' }));

        await expect(throwing(request)).rejects.toBe(thrown);
        await expect(rejecting(request)).rejects.toBe(rejected);
        await expect(refusing(request)).rejects.toBe(thrown);
        await expect(failingOnceAnswered(request)).rejects.toBe(after);

        expect(
          seen.map(({ error, info }) => {
            return [
              info.procedureId,
              info.direction,
              info.tx,
              error,
              info.startedAt,
              info.duration,
              info.callId,
              info.connectionHandle,
              info.rx,
            ];
          })
        ).toEqual(
          [
            [1, 'rx', undefined, null, start, undefined, header.callId],
            [1, 'tx', undefined, thrown, start, 10, header.callId],
            [2, 'rx', undefined, null, start + 10, undefined, header.callId],
            [2, 'tx', undefined, rejected, start + 10, rejectDelay, header.callId],
            [4, 'rx', undefined, null, start + 10 + rejectDelay, undefined, header.callId],
            [4, 'tx', { text: 'hi' }, null, start + 10 + rejectDelay, answerDelay, header.callId],
          ].map((row) => {
            return [...row, connectionHandle, { text: 'hi' }];
          })
        );
      }
    });

    // debugging 4.2 and 4.2.4
    test('tells an answer its router cannot send again at its start, with why beside it', async () => {
      const start = Date.UTC(2026, 0, 1);
      const clock = createTestClock(start);
      const { calls, router } = createFakeRouter('server', clock);
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const tooLong = new FailureError(SERVER_FAILURES.payloadTooLarge);
      const respond = router.respond;
      let heard: unknown;

      // the payload answer goes nowhere, 5 ms after it is handed over; a failure goes out
      router.respond = async (response, request) => {
        if (response.failure !== undefined) {
          return respond(response, request);
        }

        await clock.tickAsync(5);

        throw tooLong;
      };

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })(async (
        request,
        response
      ) => {
        await clock.tickAsync(10);
        heard = await response(request.payload).catch((reason: unknown) => {
          return reason;
        });
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      expect(heard).toBe(tooLong);
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.tx, error, info.startedAt, info.duration];
        })
      ).toEqual([
        ['rx', undefined, null, start, undefined],
        ['tx', { text: 'hi' }, null, start, 10],
        ['tx', { text: 'hi' }, tooLong, start, 15],
      ]);
      expect(
        calls.respond.map(({ response }) => {
          return response.failure;
        })
      ).toEqual([SERVER_FAILURES.procedureFailed]);
    });

    // debugging 4.2
    test('tells nothing more than its request for a callback that fails on its signal, its call cancelled or gone with its connection', async () => {
      const manager = createServiceManager(createFakeRouter().router);
      const seen = recordDebug(manager);
      const controller = new AbortController();

      const resolver = manager.getRequestResolver(echo, { serializer: serverSerializer })((
        request
      ) => {
        // its call cancelled, or its connection gone, as the callback runs
        controller.abort();
        request.signal.throwIfAborted();

        return Promise.resolve();
      });

      await expect(resolver(propsOf(encode({ text: 'hi' }), controller.signal))).rejects.toBe(
        controller.signal.reason
      );
      expect(
        seen.map(({ error, info }) => {
          return [info.direction, info.type, error];
        })
      ).toEqual([['rx', 'request', null]]);
    });
  });

  test.describe('commands', () => {
    test('getCommandResolver runs the server’s request, registered in the router, and tells debug it is a command', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);

      const resolver = manager.getCommandResolver(echo, { serializer: serverSerializer })((
        request,
        response
      ) => {
        return response({ text: `${request.payload.text} done` });
      });

      await resolver(propsOf(encode({ text: 'run' })));

      expect(calls.registerResolver).toEqual([resolver]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'run done' }) });
      expect(
        seen.map(({ info }) => {
          return [info.direction, info.type];
        })
      ).toEqual([
        ['rx', 'command'],
        ['tx', 'command'],
      ]);
    });
  });

  test.describe('admission', () => {
    const admit = async (beforeRequest: IBeforeRequest) => {
      const { calls, router } = createFakeRouter();
      const reached: string[] = [];
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        beforeRequest,
        serializer: serverSerializer,
      })((request, response) => {
        reached.push(request.payload.text);

        return response(request.payload);
      });

      await resolver(propsOf(encode({ text: 'hi' })));

      return { reached, response: calls.respond[0]?.response };
    };

    test('refuses with an access denied what is not admitted with `true`', async () => {
      expect(
        await admit(() => {
          return false;
        })
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      // a caller without types that returns nothing, or a failure
      expect(
        await admit((() => {
          return undefined;
        }) as unknown as () => boolean)
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      expect(
        await admit((() => {
          return SERVER_FAILURES.sessionRequired;
        }) as unknown as () => boolean)
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
      expect(
        await admit(() => {
          return true;
        })
      ).toEqual({ reached: ['hi'], response: { payload: encode({ text: 'hi' }) } });
    });

    test('refuses with the refusal a `beforeRequest` carries, and never reaches the callback', async () => {
      const requireSession: IBeforeRequest = Object.assign(
        (): boolean => {
          return false;
        },
        { refusal: SERVER_FAILURES.sessionRequired }
      );

      expect(await admit(requireSession)).toEqual({
        reached: [],
        response: { failure: SERVER_FAILURES.sessionRequired },
      });

      // composed with `&&`, the refusal is lost: the composition refuses as access denied
      expect(
        await admit((request) => {
          return requireSession(request) && request.header.callId === 7;
        })
      ).toEqual({ reached: [], response: { failure: SERVER_FAILURES.accessDenied } });
    });

    // debugging 4.3
    test('is asked before the payload is read: a request refused is refused undecodable, and never traced', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const resolver = manager.getRequestResolver(echo, {
        beforeRequest: () => {
          return false;
        },
        serializer: serverSerializer,
      })(() => {
        return Promise.resolve();
      });

      await resolver(propsOf(encoder.encode('{not json')));

      expect(calls.respond).toEqual([
        {
          request: { connectionHandle, header },
          response: { failure: SERVER_FAILURES.accessDenied },
        },
      ]);
      expect(seen).toEqual([]);
    });

    test('is the resolver’s to answer for its router: nothing admits, a failure refuses, a throw goes on', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const thrown = new Error('thrown');
      const callback = () => {
        return Promise.resolve();
      };
      const resolverOf = (procedureId: number, beforeRequest?: IBeforeRequest) => {
        return manager.getRequestResolver(
          { ...echo, procedureId },
          {
            ...(beforeRequest === undefined ? {} : { beforeRequest }),
            serializer: serverSerializer,
          }
        )(callback);
      };
      const request = { connectionHandle, header };

      expect([
        resolverOf(1).admit?.(request),
        resolverOf(2, () => {
          return true;
        }).admit?.(request),
        resolverOf(3, () => {
          return false;
        }).admit?.(request),
        resolverOf(
          4,
          Object.assign(
            () => {
              return false;
            },
            { refusal: SERVER_FAILURES.sessionRequired }
          )
        ).admit?.(request),
      ]).toEqual([
        undefined,
        undefined,
        SERVER_FAILURES.accessDenied,
        SERVER_FAILURES.sessionRequired,
      ]);
      expect(() => {
        return resolverOf(5, () => {
          throw thrown;
        }).admit?.(request);
      }).toThrow(thrown);
    });

    test('reads the call’s session its router resolved, and so does the callback, whoever asks it', async () => {
      const { router } = createFakeRouter();
      const session = Object.freeze({ data: 'ada' });
      const read: [string, unknown][] = [];
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        beforeRequest: (request) => {
          read.push(['admission', request.session]);

          return request.session !== undefined;
        },
        serializer: serverSerializer,
      })((request, response) => {
        read.push(['callback', request.session]);

        return response(request.payload);
      });

      // asked by its router, then by itself, for a router that asks nothing
      expect(resolver.admit?.({ connectionHandle, header, session })).toBeUndefined();
      await resolver({ ...propsOf(encode({ text: 'hi' })), isAdmitted: true, session });
      await resolver({ ...propsOf(encode({ text: 'hi' })), session });
      await resolver(propsOf(encode({ text: 'hi' })));

      expect(read).toEqual([
        ['admission', session],
        ['callback', session],
        ['admission', session],
        ['callback', session],
        ['admission', undefined],
      ]);
      for (const entry of read.slice(0, 4)) {
        expect(entry[1]).toBe(session);
      }

      const bob = Object.freeze({ data: 'bob' });
      const admitted: unknown[] = [];
      const received: unknown[] = [];
      const permissive = createServiceManager(createFakeRouter().router).getRequestResolver(echo, {
        beforeRequest: (request) => {
          admitted.push(request.session);

          return true;
        },
        serializer: serverSerializer,
      })((request, response) => {
        received.push(request.session);

        return response(request.payload);
      });

      await permissive({ ...propsOf(encode({ text: 'hi' })), session });
      await permissive(propsOf(encode({ text: 'hi' })));
      await permissive({ ...propsOf(encode({ text: 'hi' })), isAdmitted: true, session: bob });

      expect(admitted).toEqual([session, undefined]);
      expect(received).toEqual([session, undefined, bob]);
      expect(admitted[0]).toBe(session);
      expect(received[0]).toBe(session);
      expect(received[2]).toBe(bob);
    });

    test('is not asked again of a request its router admitted', async () => {
      const { calls, router } = createFakeRouter();
      const asked: number[] = [];
      const handed: string[][] = [];
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        beforeRequest: ({ header: { callId } }) => {
          asked.push(callId);

          return false;
        },
        serializer: serverSerializer,
      })((request, response) => {
        handed.push(Object.keys(request));

        return response(request.payload);
      });

      await resolver({ ...propsOf(encode({ text: 'hi' })), isAdmitted: true });

      expect(asked).toEqual([]);
      // the callback is handed the request, and nothing of its admission
      expect(handed).toEqual([['connectionHandle', 'header', 'payload', 'session', 'signal']]);
      expect(calls.respond[0]?.response).toEqual({ payload: encode({ text: 'hi' }) });
    });

    test('a refusal that is not an admission of the router’s side is a programmer error, as the resolver is made', () => {
      const manager = createServiceManager(createFakeRouter().router);

      for (const refusal of [
        CLIENT_FAILURES.sessionRequired,
        SERVER_FAILURES.procedureUnknown,
        { code: 33, scope: FailureScope.APPLICATION, side: 'server' },
      ]) {
        expect(() => {
          return manager.getRequestResolver(echo, {
            beforeRequest: Object.assign(
              () => {
                return false;
              },
              { refusal: refusal as unknown as typeof SERVER_FAILURES.accessDenied }
            ),
            serializer: serverSerializer,
          });
        }, JSON.stringify(refusal)).toThrow(ProgrammerError);
      }

      expect(() => {
        return manager.getNotificationResolver(echo, {
          beforeRequest: Object.assign(
            () => {
              return false;
            },
            { refusal: CLIENT_FAILURES.accessDenied }
          ),
          serializer: serverSerializer,
        });
      }).toThrow(ProgrammerError);
    });
  });

  test.describe('a resolver’s failures', () => {
    const answerWith = async (failure: unknown) => {
      const { calls, router } = createFakeRouter();
      const resolver = createServiceManager(router).getRequestResolver(echo, {
        serializer: serverSerializer,
      })((_request, response) => {
        return response(null, failure as { code: number });
      });

      await resolver(propsOf(encode({ text: 'hi' }))).catch(() => {
        return undefined;
      });

      return calls.respond[0]?.response;
    };

    test('are the procedure’s own from 1 to 65535, and nothing outside', async () => {
      for (const code of [1, 0x1000, 0xffff]) {
        expect(await answerWith({ code })).toEqual({
          failure: { code, scope: FailureScope.APPLICATION },
        });
      }

      for (const code of [0, 0x10000, 1.5, -1]) {
        expect(await answerWith({ code }), String(code)).toEqual({
          failure: SERVER_FAILURES.procedureFailed,
        });
      }
    });

    test('are nothing but objects, from a caller without types', async () => {
      expect(await answerWith(7)).toEqual({ failure: SERVER_FAILURES.procedureFailed });
      expect(() => {
        return createServiceManager(createFakeRouter().router).getRequestResolver(echo, {
          beforeRequest: Object.assign(
            () => {
              return false;
            },
            { refusal: null as unknown as typeof SERVER_FAILURES.accessDenied }
          ),
          serializer: serverSerializer,
        });
      }).toThrow(ProgrammerError);
    });

    test('may be a refusal of admission of the router’s side, with a detail', async () => {
      expect(await answerWith(SERVER_FAILURES.sessionRequired)).toEqual({
        failure: { code: 32, scope: FailureScope.PROTOCOL },
      });
      expect(await answerWith({ ...SERVER_FAILURES.accessDenied, detail: 'admins only' })).toEqual({
        failure: { code: 33, detail: 'admins only', scope: FailureScope.PROTOCOL },
      });
      expect(await answerWith(CLIENT_FAILURES.accessDenied)).toEqual({
        failure: SERVER_FAILURES.procedureFailed,
      });
    });

    test('are typed: a refusal of admission or the procedure’s own, and no other', () => {
      const manager = createServiceManager(createFakeRouter().router);
      const widened: IProtocolFailure = SERVER_FAILURES.serviceUnknown;

      manager.getRequestResolver(
        { ...echo, procedureId: 90 },
        { serializer: serverSerializer }
      )(async (_request, response) => {
        await response(null, SERVER_FAILURES.sessionRequired);
        await response(null, { code: 21 });
        await response(null, { ...SERVER_FAILURES.accessDenied, detail: 'admins only' });
        // @ts-expect-error: a routing failure is the router's to answer, never a resolver's
        await response(null, SERVER_FAILURES.serviceUnknown);
        // @ts-expect-error: nor is a protocol failure whose code is not known to be an admission's
        await response(null, widened);
      });

      expect(() => {
        return manager.getRequestResolver(
          { ...echo, procedureId: 91 },
          {
            // @ts-expect-error: a refusal is an admission failure
            beforeRequest: Object.assign(
              () => {
                return false;
              },
              { refusal: SERVER_FAILURES.procedureUnknown }
            ),
            serializer: serverSerializer,
          }
        );
      }).toThrow(ProgrammerError);
    });
  });
});

test.describe('createServiceResolver', () => {
  test('makes a resolver named after its procedure that answers its callback’s response through its router, and leaves its registration to its manager', async () => {
    const { calls, router } = createFakeRouter();
    const nameAfter: IServiceResolverOptions<string>['nameAfter'] = (resolver, procedure) => {
      return Object.assign(resolver, { ...procedure });
    };
    const trace = createServiceTrace<string>(
      {
        emit: noop,
        isDebugging: () => {
          return false;
        },
      },
      {
        clock: PLATFORM_CLOCK,
        side: () => {
          return 'server';
        },
      }
    );
    const { createResolver } = createServiceResolver(router, { nameAfter, trace });

    const resolver = createResolver<IText, IText, never>(echo, {
      callback: (request, response) => {
        return response({ text: `${request.payload.text}!` });
      },
      dependencies: { serializer: serverSerializer },
      type: 'request',
    });
    await resolver(propsOf(encode({ text: 'hi' })));

    expect(resolver.procedureName).toBe('echo');
    expect(calls.respond).toEqual([
      { request: { connectionHandle, header }, response: { payload: encode({ text: 'hi!' }) } },
    ]);
    expect(calls.registerResolver).toEqual([]);
  });
});
