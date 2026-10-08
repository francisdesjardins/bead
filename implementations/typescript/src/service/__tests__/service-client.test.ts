import { expect, test } from '@playwright/test';
import { ProtocolCode } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import type { IProcedure } from '../../router/shared/types';
import { ProgrammerError } from '../../transport/shared/errors';
import { commandOf, requestOf } from '../descriptors';
import { createServiceClient } from '../service-client';
import { createServiceServer } from '../service-server';
import { CONNECTION, connectWorker, GreeterProcedures } from './fixtures';

// helpers

const loud = {
  admits: () => {
    return true;
  },
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

  test("validates a request before it encodes it, when its options say so, by its descriptor's validate", async () => {
    await using connected = await connectWorker();
    const procedures = Object.freeze({
      echo: requestOf({
        admission: 'none',
        failures: {},
        procedure: { procedureId: 1, procedureName: 'echo', serviceId: 8, serviceRevision: 1 },
        request: PAYLOAD_CODECS.text,
        result: PAYLOAD_CODECS.text,
        validate: (request: unknown) => {
          if (request === '') {
            throw new RangeError('an empty echo');
          }
        },
      }),
    });
    const echo = createServiceServer(procedures);
    const sent: string[] = [];

    echo.on('echo', (request, response) => {
      sent.push(request.payload);

      return response(request.payload);
    });
    echo.offer(connected.server);

    const validating = createServiceClient(procedures, connected.client, { validates: true });
    const trusting = createServiceClient(procedures, connected.client);

    await expect(validating.request.echo('')()).rejects.toBeInstanceOf(RangeError);
    // * the server's layer holds it too: the request went, and its resolver never saw it
    await expect(trusting.request.echo('')()).rejects.toBeInstanceOf(FailureError);
    expect(sent).toEqual([]);
  });
});
