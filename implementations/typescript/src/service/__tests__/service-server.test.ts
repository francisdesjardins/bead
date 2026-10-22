import { expect, test } from '@playwright/test';
import { FailureScope, ProtocolCode } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import type { IProcedure, IRequestResolver } from '../../router/shared/types';
import { violationsOf } from '../../router/shared/violations';
import { ProgrammerError } from '../../transport/shared/errors';
import { commandOf, type IAdmissionHook, requestOf } from '../descriptors';
import { createServiceClient } from '../service-client';
import { createServiceServer } from '../service-server';
import {
  CONNECTION,
  connectWorker,
  deprecationsIn,
  GreeterFailures,
  GreeterProcedures,
  NOT_EMPTY,
  NOT_EMPTY_DETAIL,
  notEmpty,
} from './fixtures';

// helpers

const loud = {
  admits: () => {
    return true;
  },
};

/** The greeter's server side, its hook admitting every call unless one is given. */
const greeterOf = (hook: IAdmissionHook = loud) => {
  return createServiceServer<typeof GreeterProcedures, string>(GreeterProcedures, {
    admissions: { loud: hook },
  });
};

/** What `call` rejects with: a {@link FailureError}, by its code. */
const codeOf = async (call: Promise<unknown>): Promise<number | undefined> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(FailureError);

    return (error as FailureError).code;
  }

  return undefined;
};

// definition

test.describe('createServiceServer', () => {
  test.describe('admission', () => {
    test('admits every call with none', async () => {
      await using connected = await connectWorker();
      const greeter = greeterOf();
      const client = createServiceClient(GreeterProcedures, connected.client);

      greeter.on('sayHello', (request, response) => {
        return response(`Hello, ${request.payload}!`);
      });
      greeter.offer(connected.server);

      await expect(client.request.sayHello('Bead')()).resolves.toBe('Hello, Bead!');
    });

    test('refuses a call in no session SESSION_REQUIRED', async () => {
      await using connected = await connectWorker();
      const greeter = greeterOf();
      const client = createServiceClient(GreeterProcedures, connected.client);

      greeter.on('whoami', (request, response) => {
        return response(request.payload);
      });
      greeter.offer(connected.server);

      expect(await codeOf(client.request.whoami('who')())).toBe(ProtocolCode.SESSION_REQUIRED);
    });

    test("refuses with a hook's detail ACCESS_DENIED, in a session or in none", async () => {
      await using connected = await connectWorker();
      const greeter = greeterOf({
        admits: () => {
          return false;
        },
        detail: 'too quiet',
      });
      const client = createServiceClient(GreeterProcedures, connected.client);
      const refusals: unknown[] = [];

      greeter.on('login', (request, response) => {
        const { sessions } = connected.server;

        sessions.set(sessions.create(request.connectionHandle));

        return response('in');
      });
      greeter.on('shout', (request, response) => {
        return response(request.payload.toUpperCase());
      });
      greeter.offer(connected.server);

      for (const _session of ['none', 'in one']) {
        try {
          await client.request.shout('hi')();
        } catch (error) {
          const { code, detail } = error as FailureError;

          refusals.push([code, detail]);
        }

        await client.request.login('ada')();
      }

      expect(refusals).toEqual([
        [ProtocolCode.ACCESS_DENIED, 'too quiet'],
        [ProtocolCode.ACCESS_DENIED, 'too quiet'],
      ]);
    });

    test('answers PROCEDURE_FAILED to a hook that throws, and reports it', async () => {
      await using connected = await connectWorker();
      const thrown = new Error('the hook broke');
      const greeter = greeterOf({
        admits: () => {
          throw thrown;
        },
      });
      const client = createServiceClient(GreeterProcedures, connected.client);
      const reported: unknown[] = [];

      connected.server.router.on('error', (error, connectionHandle) => {
        reported.push([error, connectionHandle]);
      });
      greeter.on('shout', (request, response) => {
        return response(request.payload);
      });
      greeter.offer(connected.server);

      expect(await codeOf(client.request.shout('hi')())).toBe(ProtocolCode.PROCEDURE_FAILED);
      expect(reported).toEqual([[thrown, CONNECTION]]);
    });

    test('refuses a hook the options lack, one no procedure names, and one that is no hook', () => {
      expect(() => {
        return createServiceServer(GreeterProcedures, { admissions: { loud: undefined as never } });
      }).toThrow(ProgrammerError);
      expect(() => {
        return createServiceServer(GreeterProcedures, {
          admissions: { loud: { admits: undefined as never } },
        });
      }).toThrow(ProgrammerError);
      expect(() => {
        return createServiceServer(GreeterProcedures, { admissions: {} as never });
      }).toThrow(ProgrammerError);
      expect(() => {
        return createServiceServer(GreeterProcedures, {
          admissions: { loud, quiet: loud } as never,
        });
      }).toThrow(ProgrammerError);
      // each hook given is checked in turn, as the C# side checks it
      expect(() => {
        return createServiceServer(GreeterProcedures, {
          admissions: { loud: null, quiet: loud } as never,
        });
      }).toThrow(/^the hook loud admits by a function/u);
    });
  });

  test('answers a failure its procedure lists', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);

    greeter.on('sayHello', (request, response) => {
      return request.payload === ''
        ? response(null, GreeterFailures.of('NOBODY_TO_GREET', 'a name is needed'))
        : response(`Hello, ${request.payload}!`);
    });
    greeter.offer(connected.server);

    const failure = await client.request
      .sayHello('')()
      .catch((error: unknown) => {
        return error;
      });

    expect(GreeterFailures.is(failure, 'NOBODY_TO_GREET')).toBe(true);
    expect(failure).toMatchObject({ code: 1, detail: 'a name is needed' });
  });

  test('sends an unlisted code as written, and reports it', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);
    const reported: unknown[] = [];

    connected.server.router.on('error', (error, connectionHandle) => {
      reported.push([error, connectionHandle]);
    });
    greeter.on('sayHello', (_request, response) => {
      // ! a cast alone reaches a failure its procedure does not list
      return response(null, GreeterFailures.of('TOO_LOUD') as never);
    });
    greeter.offer(connected.server);

    const failure = await client.request
      .sayHello('Bead')()
      .catch((error: unknown) => {
        return error;
      });

    expect(GreeterFailures.is(failure, 'TOO_LOUD')).toBe(true);
    expect(reported).toEqual([[expect.any(ProgrammerError), CONNECTION]]);
    expect((reported[0] as [Error])[0].message).toContain('sayHello answers failure 2');
  });

  test('registers before and after offer', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);

    greeter.on('sayHello', (request, response) => {
      return response(`Hello, ${request.payload}!`);
    });
    greeter.offer(connected.server);
    greeter.on('login', (_request, response) => {
      return response('in');
    });

    await expect(client.request.sayHello('Bead')()).resolves.toBe('Hello, Bead!');
    await expect(client.request.login('ada')()).resolves.toBe('in');
  });

  test('refuses on twice, offered or not', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const answer = (_request: unknown, response: (result: string) => Promise<void>) => {
      return response('x');
    };

    greeter.on('sayHello', answer);
    expect(() => {
      greeter.on('sayHello', answer);
    }).toThrow(ProgrammerError);

    greeter.offer(connected.server);
    greeter.on('login', answer);
    expect(() => {
      greeter.on('login', answer);
    }).toThrow(ProgrammerError);
    // * a command, or a name the service lacks, is no procedure this side answers, past the types
    expect(() => {
      greeter.on('clock' as never, answer);
    }).toThrow(ProgrammerError);
    expect(() => {
      greeter.on('farewell' as never, answer);
    }).toThrow(ProgrammerError);
  });

  test('refuses a second offer', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();

    greeter.offer(connected.server);

    expect(() => {
      greeter.offer(connected.server);
    }).toThrow(ProgrammerError);
  });

  test("makes each command's requester once, as it is offered, and refuses one called before", async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);
    const declared: string[] = [];
    const { router } = connected.server;
    const declareRequester = router.declareRequester;

    router.declareRequester = (procedure: IProcedure) => {
      declared.push(procedure.procedureName);

      return declareRequester(procedure);
    };
    client.on('clock', (request, response) => {
      return response(`noon, ${request.payload}`);
    });

    expect(() => {
      return greeter.command.clock('now');
    }).toThrow(ProgrammerError);
    expect(declared).toEqual([]);

    greeter.offer(connected.server);

    for (const asked of ['now', 'again']) {
      await expect(
        greeter.command.clock(asked)({ connectionHandle: CONNECTION, timeout: 1_000 })
      ).resolves.toBe(`noon, ${asked}`);
    }

    expect(declared.toSorted()).toEqual(['clock', 'guarded']);
    expect({ ...greeter.command.clock }).toMatchObject({ procedureName: 'clock', serviceId: 7 });
  });

  test('notifies nothing before it is offered, and resolves', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);
    const heard: string[] = [];

    await expect(greeter.notify.news('before')).resolves.toBeUndefined();

    greeter.on('news', (_request, response) => {
      response.registerNotification();

      return response('subscribed');
    });
    greeter.offer(connected.server);

    await using _registration = await client.notifications.news('subscribe', (notification) => {
      heard.push(notification);
    })();

    await greeter.notify.news('after');
    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['after']);
  });

  test('lists the procedures without a resolver, which the router answers PROCEDURE_UNKNOWN', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const client = createServiceClient(GreeterProcedures, connected.client);

    greeter.on('sayHello', (_request, response) => {
      return response('hi');
    });
    greeter.offer(connected.server);

    expect(
      greeter.proceduresWithoutResolver().map(({ procedureName }) => {
        return procedureName;
      })
    ).toEqual(['login', 'news', 'shout', 'whoami']);
    expect(await codeOf(client.request.login('ada')())).toBe(ProtocolCode.PROCEDURE_UNKNOWN);
  });

  test('declares each resolver and requester once to a registry', async () => {
    await using connected = await connectWorker();
    const greeter = greeterOf();
    const { router } = connected.server;
    const declared: string[] = [];
    const declareRequester = router.declareRequester;
    const registerResolver = router.registerResolver;

    router.declareRequester = (procedure: IProcedure) => {
      declared.push(`requester ${procedure.procedureName}`);

      return declareRequester(procedure);
    };
    router.registerResolver = (resolver: IRequestResolver) => {
      declared.push(`resolver ${resolver.procedureName}`);
      registerResolver(resolver);
    };
    greeter.on('sayHello', (_request, response) => {
      return response('hi');
    });
    greeter.on('news', (_request, response) => {
      return response('subscribed');
    });
    greeter.offer(connected.server);
    greeter.on('login', (_request, response) => {
      return response('in');
    });

    await greeter.command
      .clock('now')({ connectionHandle: CONNECTION, timeout: 50 })
      .catch(() => {
        return undefined;
      });

    expect(declared.toSorted()).toEqual([
      'requester clock',
      'requester guarded',
      'resolver login',
      'resolver news',
      'resolver sayHello',
    ]);
  });

  test('answers PAYLOAD_INVALID with its violations to a request its rules refuse, before its resolver', async () => {
    await using connected = await connectWorker();
    const reported: unknown[] = [];
    const seen: unknown[] = [];
    const procedures = Object.freeze({
      echo: requestOf({
        admission: 'none',
        failures: {},
        procedure: { procedureId: 1, procedureName: 'echo', serviceId: 8, serviceRevision: 1 },
        request: PAYLOAD_CODECS.text,
        result: PAYLOAD_CODECS.text,
        validate: notEmpty,
      }),
    });
    const echo = createServiceServer(procedures);
    const client = createServiceClient(procedures, connected.client);

    connected.server.router.on('error', (error) => {
      reported.push(error);
    });
    echo.on('echo', (request, response) => {
      seen.push(request.payload);

      return response(request.payload);
    });
    echo.offer(connected.server);

    await expect(client.request.echo('hi')()).resolves.toBe('hi');

    const refused = await client.request
      .echo('')()
      .catch((error: unknown) => {
        return error as FailureError;
      });

    expect(refused).toBeInstanceOf(FailureError);
    expect(refused).toMatchObject({
      code: ProtocolCode.PAYLOAD_INVALID,
      detail: NOT_EMPTY_DETAIL,
      origin: 'peer',
      scope: FailureScope.PROTOCOL,
    });
    expect(violationsOf(refused as FailureError)).toEqual({ more: 0, violations: [NOT_EMPTY] });
    // * the protocol's answer, never its resolver's: nothing ran, nothing to report
    expect(seen).toEqual(['hi']);
    expect(reported).toEqual([]);
  });

  test('answers PROCEDURE_FAILED to a validate that throws, and reports it', async () => {
    await using connected = await connectWorker();
    const reported: unknown[] = [];
    const seen: unknown[] = [];
    const procedures = Object.freeze({
      echo: requestOf({
        admission: 'none',
        failures: {},
        procedure: { procedureId: 1, procedureName: 'echo', serviceId: 8, serviceRevision: 1 },
        request: PAYLOAD_CODECS.text,
        result: PAYLOAD_CODECS.text,
        validate: (request: unknown) => {
          if (request === '') {
            throw new RangeError('a rule that fails to judge');
          }

          return notEmpty(request);
        },
      }),
    });
    const echo = createServiceServer(procedures);
    const client = createServiceClient(procedures, connected.client);

    connected.server.router.on('error', (error) => {
      reported.push(error);
    });
    echo.on('echo', (request, response) => {
      seen.push(request.payload);

      return response(request.payload);
    });
    echo.offer(connected.server);

    await expect(client.request.echo('hi')()).resolves.toBe('hi');
    expect(await codeOf(client.request.echo('')())).toBe(ProtocolCode.PROCEDURE_FAILED);
    expect(seen).toEqual(['hi']);
    expect(reported).toEqual([expect.any(RangeError)]);
  });

  test('validates a command before it goes, when its options say so', async () => {
    await using connected = await connectWorker();
    const procedures = Object.freeze({
      shout: commandOf({
        admission: 'none',
        failures: {},
        procedure: { procedureId: 3, procedureName: 'shout', serviceId: 8, serviceRevision: 1 },
        request: PAYLOAD_CODECS.text,
        result: PAYLOAD_CODECS.text,
        validate: notEmpty,
      }),
    });
    const validating = createServiceServer(procedures, { validates: true });
    const heard: unknown[] = [];
    const client = createServiceClient(procedures, connected.client);
    const failureOf = (call: Promise<unknown>): Promise<FailureError> => {
      return call.then(
        () => {
          throw new Error('the command was taken');
        },
        (error: unknown) => {
          return error as FailureError;
        }
      );
    };

    client.on('shout', (request, response) => {
      heard.push(request.payload);

      return response(request.payload.toUpperCase());
    });
    validating.offer(connected.server);

    const refused = await failureOf(
      validating.command.shout('')({ connectionHandle: CONNECTION, timeout: 1_000 })
    );

    expect(refused).toBeInstanceOf(FailureError);
    // * refused on this side, before it went: its client heard nothing
    expect(refused).toMatchObject({
      code: ProtocolCode.PAYLOAD_INVALID,
      detail: NOT_EMPTY_DETAIL,
      origin: 'local',
      side: 'server',
    });
    expect(heard).toEqual([]);
    await expect(
      validating.command.shout('hi')({ connectionHandle: CONNECTION, timeout: 1_000 })
    ).resolves.toBe('HI');
    expect(heard).toEqual(['hi']);
  });

  test("a mapped member keeps its descriptor's @deprecated", async () => {
    // * each command's requester, notifier and resolver of a deprecated descriptor is flagged at each use, and none of another
    expect(await deprecationsIn('deprecated-server-uses.ts')).toEqual({
      directives: 4,
      files: 1,
      reports: [],
    });
  });
});
