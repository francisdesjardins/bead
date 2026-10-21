import { expect, test } from '@playwright/test';
import { FailureScope, ProtocolCode } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { createMetricsRegistry } from '../../router/shared/metrics-registry';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import type { IDebugEvent, IProcedure } from '../../router/shared/types';
import { violationsOf } from '../../router/shared/violations';
import { ProgrammerError } from '../../transport/shared/errors';
import { commandOf, requestOf } from '../descriptors';
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

/** A procedure of service 8 that echoes a text, judged by {@link notEmpty}; one that notifies too. */
const ECHO_PROCEDURES = Object.freeze({
  echo: requestOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 1, procedureName: 'echo', serviceId: 8, serviceRevision: 1 },
    request: PAYLOAD_CODECS.text,
    result: PAYLOAD_CODECS.text,
    validate: notEmpty,
  }),
  news: requestOf({
    admission: 'none',
    failures: {},
    notification: PAYLOAD_CODECS.text,
    procedure: { procedureId: 2, procedureName: 'news', serviceId: 8, serviceRevision: 1 },
    request: PAYLOAD_CODECS.text,
    result: PAYLOAD_CODECS.text,
    validate: notEmpty,
  }),
});

/** What `call` fails with; a call that is taken fails the test. */
const failureOf = (call: PromiseLike<unknown>): Promise<FailureError> => {
  return Promise.resolve(call).then(
    () => {
      throw new Error('the call was taken');
    },
    (error: unknown) => {
      return error as FailureError;
    }
  );
};

// definition

test.describe('createServiceClient', () => {
  test('admits a command by its rule', async () => {
    await using connected = await connectWorker();
    const greeter = createServiceServer<typeof GreeterProcedures, string>(GreeterProcedures, {
      admissions: { loud },
    });
    const client = createServiceClient(GreeterProcedures, connected.client);
    const refused = await (async () => {
      try {
        await greeter.command.guarded('who')({ connectionHandle: CONNECTION, timeout: 1_000 });
      } catch (error) {
        return error;
      }

      return undefined;
    })();

    greeter.on('login', (request, response) => {
      const { sessions } = connected.server;

      sessions.set(sessions.create(request.connectionHandle));

      return response('in');
    });
    client.on('clock', (_request, response) => {
      return response('noon');
    });
    client.on('guarded', (request, response) => {
      return response(`guarded ${request.payload}`);
    });

    // * before the offer, no command is made: the refusal is the layer's, not the router's
    expect(refused).toBeInstanceOf(ProgrammerError);

    greeter.offer(connected.server);

    const call = { connectionHandle: CONNECTION, timeout: 1_000 };

    await expect(greeter.command.clock('now')(call)).resolves.toBe('noon');
    await expect(greeter.command.guarded('who')(call)).rejects.toMatchObject({
      code: ProtocolCode.SESSION_REQUIRED,
    });

    // a session learned by the client: the server's command runs in it
    await client.request.login('ada')();

    await expect(greeter.command.guarded('who')(call)).resolves.toBe('guarded who');
  });

  test('refuses a command admitted by a hook, which a client side is given none of', async () => {
    await using connected = await connectWorker();
    const procedures = Object.freeze({
      clock: commandOf({
        admission: { hook: 'loud' },
        failures: {},
        procedure: { procedureId: 9, procedureName: 'clock', serviceId: 8, serviceRevision: 1 },
        request: PAYLOAD_CODECS.text,
        result: PAYLOAD_CODECS.text,
      }),
    });
    const client = createServiceClient(procedures, connected.client);

    expect(() => {
      client.on('clock', (_request, response) => {
        return response('noon');
      });
    }).toThrow(ProgrammerError);
  });

  test('makes each requester and notification once, at its window', async () => {
    await using connected = await connectWorker();
    const declared: string[] = [];
    const { router } = connected.client;
    const declareRequester = router.declareRequester;

    router.declareRequester = (procedure: IProcedure) => {
      declared.push(procedure.procedureName);

      return declareRequester(procedure);
    };

    const client = createServiceClient(GreeterProcedures, connected.client, {
      windows: { news: 4 },
    });

    expect(client.notifications.news.window).toBe(4);
    expect(Object.keys(client.request).toSorted()).toEqual([
      'login',
      'news',
      'sayHello',
      'shout',
      'whoami',
    ]);
    // * the notification's subscribing call is a requester of its own procedure, declared with it
    expect(declared.toSorted()).toEqual(['login', 'news', 'news', 'sayHello', 'shout', 'whoami']);
    // the same procedure at the same window gives the same notification; at another, a refusal
    expect(
      createServiceClient(GreeterProcedures, connected.client, { windows: { news: 4 } })
        .notifications.news
    ).toBe(client.notifications.news);
    expect(() => {
      return createServiceClient(GreeterProcedures, connected.client);
    }).toThrow(ProgrammerError);
  });

  test('a request to a procedure that notifies opens no subscription', async () => {
    await using connected = await connectWorker();
    const greeter = createServiceServer<typeof GreeterProcedures, string>(GreeterProcedures, {
      admissions: { loud },
    });
    const client = createServiceClient(GreeterProcedures, connected.client);
    const opened: boolean[] = [];

    greeter.on('news', (request, response) => {
      opened.push(request.header.opensSubscription === true);

      return response('headlines');
    });
    greeter.offer(connected.server);

    await expect(client.request.news('today')()).resolves.toBe('headlines');
    expect(opened).toEqual([false]);
    expect(connected.server.router.notifications.subscriptions()).toEqual([]);
  });

  test('refuses a window for a procedure that does not notify', async () => {
    await using connected = await connectWorker();

    expect(() => {
      return createServiceClient(GreeterProcedures, connected.client, {
        windows: { sayHello: 1 } as never,
      });
    }).toThrow(ProgrammerError);
    expect(() => {
      return createServiceClient(GreeterProcedures, connected.client, {
        windows: { news: 0 },
      });
    }).toThrow(ProgrammerError);
  });

  test('fails a call before it goes with PAYLOAD_INVALID, when its options say so, and sends nothing', async () => {
    await using connected = await connectWorker();
    const echo = createServiceServer(ECHO_PROCEDURES);
    const sent: string[] = [];
    const steps: IDebugEvent[] = [];

    echo.on('echo', (request, response) => {
      sent.push(request.payload);

      return response(request.payload);
    });
    echo.on('news', (_request, response) => {
      return response('');
    });
    echo.offer(connected.server);

    const validating = createServiceClient(ECHO_PROCEDURES, connected.client, { validates: true });
    const trusting = createServiceClient(ECHO_PROCEDURES, connected.client);

    connected.client.services.on('debug', (_error, info) => {
      steps.push(info);
    });

    const refused = await failureOf(validating.request.echo('')());

    expect(refused).toBeInstanceOf(FailureError);
    expect(refused).toMatchObject({
      code: ProtocolCode.PAYLOAD_INVALID,
      destinationId: undefined,
      detail: NOT_EMPTY_DETAIL,
      origin: 'local',
      procedureAddress: { procedureId: 1, serviceId: 8 },
      scope: FailureScope.PROTOCOL,
      side: 'client',
    });
    expect(violationsOf(refused)).toEqual({ more: 0, violations: [NOT_EMPTY] });
    // * a call refused before it goes: its tx step names no call, then its failure
    expect(
      steps.map(({ callId, direction }) => {
        return [direction, callId];
      })
    ).toEqual([
      ['tx', undefined],
      ['rx', undefined],
    ]);
    // the server's layer holds it too: the request went, and its resolver never saw it
    expect((await failureOf(trusting.request.echo('')())).code).toBe(ProtocolCode.PAYLOAD_INVALID);
    expect(sent).toEqual([]);
    await expect(validating.request.echo('hi')()).resolves.toBe('hi');
    expect(sent).toEqual(['hi']);
  });

  test('validates a subscribing request as a plain one, when its options say so', async () => {
    await using connected = await connectWorker();
    const echo = createServiceServer(ECHO_PROCEDURES);
    const subscribed: string[] = [];

    echo.on('echo', (request, response) => {
      return response(request.payload);
    });
    echo.on('news', (request, response) => {
      subscribed.push(request.payload);
      response.registerNotification();

      return response(request.payload);
    });
    echo.offer(connected.server);

    const validating = createServiceClient(ECHO_PROCEDURES, connected.client, { validates: true });
    const refused = await failureOf(
      validating.notifications.news('', () => {
        return undefined;
      })()
    );

    expect(refused).toMatchObject({
      code: ProtocolCode.PAYLOAD_INVALID,
      detail: NOT_EMPTY_DETAIL,
      origin: 'local',
    });
    expect(subscribed).toEqual([]);
  });

  test('answers PAYLOAD_INVALID to a command its rules refuse, before its resolver', async () => {
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
    const server = createServiceServer(procedures);
    const client = createServiceClient(procedures, connected.client);
    const heard: string[] = [];

    client.on('shout', (request, response) => {
      heard.push(request.payload);

      return response(request.payload.toUpperCase());
    });
    server.offer(connected.server);

    const refused = await failureOf(
      server.command.shout('')({ connectionHandle: CONNECTION, timeout: 1_000 })
    );

    expect(refused).toMatchObject({
      code: ProtocolCode.PAYLOAD_INVALID,
      detail: NOT_EMPTY_DETAIL,
      origin: 'peer',
    });
    expect(heard).toEqual([]);
    await expect(
      server.command.shout('hi')({ connectionHandle: CONNECTION, timeout: 1_000 })
    ).resolves.toBe('HI');
    expect(heard).toEqual(['hi']);
  });

  // debugging 9.6.5
  test('counts a call its rules refuse before it goes as PAYLOAD_INVALID, started and ended in its turn', async () => {
    const clientMetricsRegistry = createMetricsRegistry();
    await using connected = await connectWorker({ clientMetricsRegistry });
    const echo = createServiceServer(ECHO_PROCEDURES);
    const validating = createServiceClient(ECHO_PROCEDURES, connected.client, { validates: true });
    const labels = 'service="8",procedure="echo",type="request"';

    echo.on('echo', (request, response) => {
      return response(request.payload);
    });
    echo.on('news', (_request, response) => {
      return response('');
    });
    echo.offer(connected.server);

    const refused = failureOf(validating.request.echo('')());
    // * read in the turn the call started: it started, and it ended there
    const { text } = clientMetricsRegistry.exposition();

    expect(text).toContain(`bead_client_call_started_total{${labels}} 1\n`);
    expect(text).toContain(
      `bead_client_call_handled_total{${labels},outcome="failure",code="PAYLOAD_INVALID"} 1\n`
    );
    expect(text).toContain(`bead_client_call_duration_seconds_count{${labels}} 1\n`);
    expect((await refused).code).toBe(ProtocolCode.PAYLOAD_INVALID);
  });

  test("a mapped member keeps its descriptor's @deprecated", async () => {
    // * each requester, notification and window of a deprecated descriptor is flagged at each use, and none of another
    expect(await deprecationsIn('deprecated-client-uses.ts')).toEqual({
      directives: 4,
      files: 1,
      reports: [],
    });
  });

  test('refuses to answer what is no command of its service, a command twice, and a window of what it does not hold', async () => {
    await using connected = await connectWorker();
    const client = createServiceClient(GreeterProcedures, connected.client);
    const answer = (_request: unknown, response: (result: string) => Promise<void>) => {
      return response('noon');
    };

    expect(() => {
      client.on('sayHello' as 'clock', answer);
    }).toThrow(new ProgrammerError("sayHello is no command this service's client answers"));
    expect(() => {
      client.on('toString' as 'clock', answer);
    }).toThrow(new ProgrammerError("toString is no command this service's client answers"));
    client.on('clock', answer);
    expect(() => {
      client.on('clock', answer);
    }).toThrow(new ProgrammerError('clock has a resolver already'));
    expect(() => {
      return createServiceClient(GreeterProcedures, connected.client, {
        windows: { toString: 1 } as never,
      });
    }).toThrow(new ProgrammerError('toString does not notify, and takes no window'));
  });

  test('sends a command’s unlisted code as written, and reports it', async () => {
    await using connected = await connectWorker();
    const greeter = createServiceServer<typeof GreeterProcedures, string>(GreeterProcedures, {
      admissions: { loud },
    });
    const client = createServiceClient(GreeterProcedures, connected.client);
    const reported: unknown[] = [];

    connected.client.router.on('error', (error) => {
      reported.push(error);
    });
    client.on('clock', (_request, response) => {
      // ! a cast alone reaches a failure its procedure does not list
      return response(null, GreeterFailures.of('TOO_LOUD') as never);
    });
    greeter.offer(connected.server);

    const failure = await failureOf(
      greeter.command.clock('now')({ connectionHandle: CONNECTION, timeout: 1_000 })
    );

    expect(GreeterFailures.is(failure, 'TOO_LOUD')).toBe(true);
    expect(reported).toEqual([
      new ProgrammerError('clock answers failure 2, which it does not list'),
    ]);
  });
});
