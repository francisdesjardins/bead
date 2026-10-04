import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createWSClient } from '../../client/ws-client';
import { createRouterServer } from '../../router/server/router-server';
import { createSessionManager } from '../../router/server/session-manager';
import { createServiceManager } from '../../router/shared/service-manager';
import { EnvelopeKind } from '../../router/shared/constants';
import { bytesOf } from '../../router/shared/envelope';
import { createPipedTransports, digestOf, patternOf } from '../../router/shared/__tests__/fixtures';
import { createRouterClient } from '../../router/client/router-client';
import type { IProcedure, RouterLimitsOptions } from '../../router/shared/types';
import { createFakeWebSocketServer } from '../../transport/server/__tests__/fake-websocket-server';
import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { allClosed, host, IMPLEMENTATIONS } from '../../transport/shared/__tests__/fixtures';
import {
  CancelError,
  createWSServer,
  FailureError,
  type IRelayOptions,
  ProtocolCode,
  TimeoutError,
} from '../ws-server';
import { expectAtRest } from './fixtures';

// helpers

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
};

const openSession: IProcedure = {
  procedureId: 1,
  procedureName: 'openSession',
  serviceId: 1,
  serviceRevision: 1,
};
const echo: IProcedure = {
  procedureId: 2,
  procedureName: 'echo',
  serviceId: 1,
  serviceRevision: 1,
};
const ping: IProcedure = {
  procedureId: 3,
  procedureName: 'ping',
  serviceId: 1,
  serviceRevision: 1,
};
const news: IProcedure = {
  procedureId: 4,
  procedureName: 'news',
  serviceId: 1,
  serviceRevision: 1,
};
const unsubscribe: IProcedure = {
  procedureId: 5,
  procedureName: 'unsubscribe',
  serviceId: 1,
  serviceRevision: 1,
};

// definition

test('createWSServer builds on a WebSocket transport server, not yet started, with the layers given', async () => {
  const sessions = createSessionManager();
  const built: string[] = [];
  const limits: unknown[] = [];

  await using server = createWSServer({
    limits: { maximumPayloadBytes: 8 },
    router: (transport, options) => {
      built.push('router');
      limits.push(options.limits);

      return createRouterServer(transport, options);
    },
    services: (router, options) => {
      built.push('services');

      return createServiceManager(router, options);
    },
    sessions: () => {
      built.push('sessions');

      return sessions;
    },
    transport: { WebSocketServer },
  });

  expect(server.transport.isUninitialized()).toBe(true);
  expect(server.router.transport).toBe(server.transport);
  expect(server.sessions).toBe(sessions);
  expect(built).toEqual(['sessions', 'router', 'services']);
  // the router is built with the server's limits
  expect(limits).toEqual([{ maximumPayloadBytes: 8 }]);
});

test('createWSServer takes a message of an envelope at most, more when the transport says so, and never less', async () => {
  // envelopes of 256 bytes
  const small = { chunkBytes: 128, maximumEnvelopeBytes: 256, windowBytes: 256 };

  for (const [limits, maxPayload, expected] of [
    [undefined, undefined, 16_778_240],
    [small, undefined, 256],
    [small, 1_024, 1_024],
  ] as const) {
    const fake = createFakeWebSocketServer();
    const server = createWSServer({
      limits,
      transport: { maxPayload, WebSocketServer: fake.FakeWebSocketServer },
    });
    const starting = server.transport.start({ port: 4_321 });

    fake.instances[0]?.emit('listening');
    await starting;

    expect(fake.instances[0]?.options).toMatchObject({ maxPayload: expected });
    await server[Symbol.asyncDispose]();
  }

  // a socket that cuts off what the router would take
  for (const [limits, maxPayload] of [
    [undefined, 256],
    [small, 255],
  ] as const) {
    expect(() => {
      return createWSServer({ limits, transport: { maxPayload, WebSocketServer } });
    }).toThrow(`maxPayload is an envelope's limit at least`);
  }
});

test('createWSServer builds its router with the pacing its options give', async () => {
  await using server = createWSServer({
    pacing: { maximumQueuedNotificationBytes: 2_048, maximumQueuedNotifications: 3 },
    transport: { WebSocketServer },
  });

  expect(server.gauges().router.ceilings).toMatchObject({
    largestQueuedNotificationBytes: 2_048,
    largestQueuedNotifications: 3,
  });
});

test('createWSServer closes with 1009 a connection that sends more than `maxPayload`', async () => {
  const server = createWSServer({
    limits: { chunkBytes: 128, maximumEnvelopeBytes: 256, windowBytes: 256 },
    transport: { maxPayload: 256, WebSocketServer },
  });
  const { port } = await server.transport.start({ address: host, findOpenPort: true });
  const socket = new WebSocket(`ws://${host}:${String(port)}`);

  try {
    await once(socket, 'open');

    const closing = once(socket, 'close');

    socket.send(new Uint8Array(257));

    const [code] = (await closing) as [number];

    expect(code).toBe(1009);
  } finally {
    socket.terminate();
    await server[Symbol.asyncDispose]();
  }
});

test('createWSServer closes a client that lets a command go unanswered, when told to', async () => {
  const server = createWSServer({ closeOnCommandTimeout: true, transport: { WebSocketServer } });
  const { port } = await server.transport.start({ address: host, findOpenPort: true });
  const [, TrackedWebSocket] = IMPLEMENTATIONS[1];
  const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });
  const opened = Promise.withResolvers<TransportServerConnectionHandle>();

  try {
    server.services.getRequestResolver(openSession, { serializer: text })((request, response) => {
      opened.resolve(request.connectionHandle);

      return response('');
    });
    // a client that takes the command and never answers it
    client.services.getCommandResolver(ping, { serializer: text })(() => {
      return new Promise(() => {
        return undefined;
      });
    });

    await client.connect({ host, port });
    await client.services.getRequest(openSession, { serializer: text })('me')();

    await expect(
      server.services.getCommand(ping, { serializer: text })('ping')({
        connectionHandle: await opened.promise,
        timeout: 50,
      })
    ).rejects.toBeInstanceOf(TimeoutError);
    await expect
      .poll(() => {
        return client.transport.isClosed();
      })
      .toBe(true);
  } finally {
    await client[Symbol.asyncDispose]();
    await expectAtRest(server);
    await server[Symbol.asyncDispose]();
    await allClosed();
  }
});

test.describe('a WebSocket server and client, carrying transfers', () => {
  const MIB = 1_048_576;
  // envelopes of 1 024 bytes, a window of 8 KiB
  const small = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 8_192 };
  // payloads as they are: bytes
  const bytes = {
    decode: (payload: Uint8Array) => {
      return payload;
    },
    encode: (payload: Uint8Array) => {
      return payload;
    },
  };

  /**
   * A server and a client on `ws`, each with its limits, connected, which record the bytes of every
   * message they take, and each credit they send; `await using` takes them apart.
   */
  const connectWith = async ({
    client: clientLimits,
    server: serverLimits,
  }: { client?: RouterLimitsOptions; server?: RouterLimitsOptions } = {}) => {
    const server = createWSServer({ limits: serverLimits, transport: { WebSocketServer } });
    const { port } = await server.transport.start({ address: host, findOpenPort: true });
    const [, TrackedWebSocket] = IMPLEMENTATIONS[1];
    const client = createWSClient({
      limits: clientLimits,
      transport: { WebSocket: TrackedWebSocket },
    });
    const taken = { client: [] as number[], server: [] as number[] };
    const credits = { client: 0, server: 0 };

    server.transport.on('message', (data) => {
      taken.server.push(bytesOf(data).length);
    });
    client.transport.on('message', (data) => {
      taken.client.push(bytesOf(data).length);
    });
    server.router.on('debug', ({ direction, header }) => {
      credits.server += direction === 'tx' && header.kind === EnvelopeKind.CREDIT ? 1 : 0;
    });
    client.router.on('debug', ({ direction, header }) => {
      credits.client += direction === 'tx' && header.kind === EnvelopeKind.CREDIT ? 1 : 0;
    });
    await client.connect({ host, port });

    return {
      client,
      credits,
      server,
      taken,
      [Symbol.asyncDispose]: async () => {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      },
    };
  };

  test('carry 20 MiB both ways — a request, its result, a command and its answer — in messages of a chunk at most', async () => {
    // bytes by the tens of megabytes, on a machine that may be slow: the clock is the runner's alone
    test.slow();

    const limits = { maximumPayloadBytes: 32 * MIB };
    await using ends = await connectWith({ client: limits, server: limits });
    const { client, server, taken } = ends;
    const [request, result, command, answer] = [1, 2, 3, 4].map((index) => {
      return patternOf(20 * MIB + index);
    }) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const heard: string[] = [];
    const opened = Promise.withResolvers<TransportServerConnectionHandle>();

    server.services.getRequestResolver(echo, { serializer: bytes })((asked, response) => {
      opened.resolve(asked.connectionHandle);
      heard.push(digestOf(asked.payload));

      return response(result);
    });
    client.services.getCommandResolver(ping, { serializer: bytes })((asked, response) => {
      heard.push(digestOf(asked.payload));

      return response(answer);
    });

    // the clock is no part of it: a generous timeout
    const resulted = await client.services.getRequest(echo, { serializer: bytes })(request)({
      timeout: 30_000,
    });
    const answered = await server.services.getCommand(ping, { serializer: bytes })(command)({
      connectionHandle: await opened.promise,
      timeout: 30_000,
    });

    expect([digestOf(resulted), digestOf(answered)]).toEqual([digestOf(result), digestOf(answer)]);
    expect(heard).toEqual([digestOf(request), digestOf(command)]);
    expect(Math.max(...taken.server, ...taken.client)).toBeLessThanOrEqual(MIB);
  });

  test('refuse 20 MiB with the limits by default, here, sending nothing', async () => {
    await using ends = await connectWith();

    await expect(
      ends.client.services.getRequest(echo, { serializer: bytes })(patternOf(20 * MIB))()
    ).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_TOO_LARGE,
      detail: 'a payload is 16777216 bytes at most, not 20971520',
    });
    expect(ends.taken.server).toEqual([]);
  });

  test('carry 100 KiB over envelopes of 1 024 bytes, both ways, credited many times', async () => {
    await using ends = await connectWith({ client: small, server: small });
    const { client, credits, server, taken } = ends;
    const [request, result] = [patternOf(102_400), patternOf(102_401)];

    server.services.getRequestResolver(echo, { serializer: bytes })((_asked, response) => {
      return response(result);
    });

    const resulted = await client.services.getRequest(echo, { serializer: bytes })(request)();

    expect(digestOf(resulted)).toBe(digestOf(result));
    expect(Math.max(...taken.server, ...taken.client)).toBeLessThanOrEqual(1_024);
    expect(credits.server).toBeGreaterThan(1);
    expect(credits.client).toBeGreaterThan(1);
  });

  test('refuse a transfer at its opening — its route, its admission, its size, its connection’s capacity — before any credit', async () => {
    await using ends = await connectWith({
      client: small,
      server: { ...small, maximumTransfers: 1 },
    });
    const { client, server } = ends;
    const held: IProcedure = { ...echo, procedureId: 10, procedureName: 'held' };
    const refusing: IProcedure = { ...echo, procedureId: 11, procedureName: 'refusing' };
    const limited: IProcedure = { ...echo, procedureId: 12, procedureName: 'limited' };
    const unknown: IProcedure = { ...echo, procedureId: 13, procedureName: 'unknown' };
    const holding = Promise.withResolvers<undefined>();
    const taken = new Map<number, number[]>();
    const credited = new Set<number>();

    server.router.on('debug', ({ direction, header }) => {
      if (direction === 'rx') {
        taken.set(header.callId, [...(taken.get(header.callId) ?? []), header.kind]);
      } else if (header.kind === EnvelopeKind.CREDIT) {
        credited.add(header.callId);
      }
    });
    // taken whole, then held: its place on the connection stays until its call ends
    server.services.getRequestResolver(held, { serializer: bytes })(() => {
      holding.resolve(undefined);

      return new Promise(() => {
        return undefined;
      });
    });
    server.services.getRequestResolver(refusing, {
      beforeRequest: () => {
        return false;
      },
      serializer: bytes,
    })(() => {
      return Promise.resolve();
    });
    // the server's own limit: the client's copy of the procedure has none
    server.services.getRequestResolver(
      { ...limited, maximumPayloadBytes: 1_024 },
      { serializer: bytes }
    )(() => {
      return Promise.resolve();
    });
    server.services.getRequestResolver(echo, { serializer: bytes })(() => {
      return Promise.resolve();
    });

    const ask = (procedure: IProcedure) => {
      return client.services
        .getRequest(procedure, { serializer: bytes })(patternOf(102_400))()
        .catch((reason: unknown) => {
          return reason;
        });
    };

    void ask(held);
    await holding.promise;

    const refused = await Promise.all([unknown, refusing, limited, echo].map(ask));

    expect(
      refused.map((reason) => {
        return (reason as { code?: number }).code;
      })
    ).toEqual([
      ProtocolCode.PROCEDURE_UNKNOWN,
      ProtocolCode.ACCESS_DENIED,
      ProtocolCode.PAYLOAD_TOO_LARGE,
      ProtocolCode.CAPACITY_EXCEEDED,
    ]);

    // the server took each opening alone, and credited none
    for (const callId of [3, 5, 7, 9]) {
      expect(taken.get(callId), String(callId)).toEqual([EnvelopeKind.REQUEST]);
      expect(credited.has(callId), String(callId)).toBe(false);
    }
  });
});

test.describe('a WebSocket relay, its leg B on a pipe to a device', () => {
  const device: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50100';
  const held: IProcedure = { ...echo, procedureId: 12, procedureName: 'held' };
  const unknown: IProcedure = { ...echo, procedureId: 99, procedureName: 'unknown' };
  // envelopes of 1 024 bytes, a window of 8 KiB
  const small = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 8_192 };
  const bytes = {
    decode: (payload: Uint8Array) => {
      return payload;
    },
    encode: (payload: Uint8Array) => {
      return payload;
    },
  };

  /**
   * A relay's WebSocket server — relaying as `relay` says, a session required by default — with a
   * device's router behind it at destination 7, on a pipe, and a WebSocket client connected to it;
   * every router under `limits`. `await using` takes them apart.
   */
  const connectRelayed = async ({
    limits,
    relay,
  }: { limits?: RouterLimitsOptions; relay?: IRelayOptions } = {}) => {
    const server = createWSServer({ limits, relay, transport: { WebSocketServer } });
    const { port } = await server.transport.start({ address: host, findOpenPort: true });
    const pipe = createPipedTransports({ connectionHandle: device });
    const toDevice = createRouterClient(pipe.client, { limits });
    const deviceRouter = createRouterServer(pipe.server, { limits });
    const [, TrackedWebSocket] = IMPLEMENTATIONS[1];
    const client = createWSClient({ limits, transport: { WebSocket: TrackedWebSocket } });

    pipe.open();
    server.router.registerDestination(toDevice, { destinationId: 7, label: 'the device' });
    server.services.getRequestResolver(openSession, { serializer: text })((request, response) => {
      server.sessions.set({
        ...server.sessions.create(request.connectionHandle),
        connectionInactivityTimeout: Infinity,
        sessionInactivityTimeout: Infinity,
      });

      return response('');
    });
    await client.connect({ host, port });

    return {
      client,
      deviceRouter,
      deviceServices: createServiceManager(deviceRouter),
      server,
      toDevice,
      [Symbol.asyncDispose]: async () => {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        toDevice[Symbol.dispose]();
        deviceRouter[Symbol.dispose]();
        await allClosed();
      },
    };
  };

  test('relay a call to the device once a session admits it, and bring back the device’s own failure, one relay more', async () => {
    await using relayed = await connectRelayed();
    const { client, deviceRouter, deviceServices } = relayed;
    // the credential scheme each envelope the device took presented, none for none
    const presented: (number | undefined)[] = [];

    deviceRouter.on('debug', ({ direction, header }) => {
      if (direction === 'rx') {
        presented.push(header.credentialScheme);
      }
    });
    deviceServices.getRequestResolver(echo, { serializer: text })((request, response) => {
      return response(request.payload.toUpperCase());
    });

    const echoing = client.services.getRequest(echo, { serializer: text });

    // a relay is a door: without a session, nothing goes through it, and the device sees nothing
    await expect(echoing('hi')({ destinationId: 7 })).rejects.toMatchObject({
      code: ProtocolCode.SESSION_REQUIRED,
      origin: 'peer',
      relays: 0,
    });
    expect(presented).toEqual([]);
    await client.services.getRequest(openSession, { serializer: text })('me')();
    await expect(echoing('hi')({ destinationId: 7 })).resolves.toBe('HI');

    const refused = await client.services
      .getRequest(unknown, { serializer: text })('hi')({ destinationId: 7 })
      .catch((reason: unknown) => {
        return reason;
      });

    expect(refused).toMatchObject({
      code: ProtocolCode.PROCEDURE_UNKNOWN,
      destinationId: 7,
      origin: 'relayed',
      relays: 1,
      side: undefined,
    });
    // the protocol's code, from behind the relay, whose side no one knows
    expect((refused as FailureError).isProtocol(ProtocolCode.PROCEDURE_UNKNOWN)).toBe(true);
    expect((refused as FailureError).isProtocol(ProtocolCode.PROCEDURE_UNKNOWN, 'server')).toBe(
      false
    );
    // the client's session stays on leg A: none crosses to the device
    expect(presented).toEqual([undefined, undefined]);
  });

  test('relay as the server’s options say: an admission of the application’s own, no session asked', async () => {
    await using relayed = await connectRelayed({
      relay: {
        beforeRoute: ({ header }) => {
          return header.destinationId === 7;
        },
      },
    });
    const { client, deviceServices } = relayed;

    deviceServices.getRequestResolver(echo, { serializer: text })((request, response) => {
      return response(request.payload.toUpperCase());
    });

    const echoing = client.services.getRequest(echo, { serializer: text });

    await expect(echoing('hi')({ destinationId: 7 })).resolves.toBe('HI');
    await expect(echoing('hi')({ destinationId: 8 })).rejects.toMatchObject({
      code: ProtocolCode.ACCESS_DENIED,
    });
  });

  test('relay 100 KiB each way as transfers on each leg, put together at the relay', async () => {
    await using relayed = await connectRelayed({ limits: small });
    const { client, deviceServices, server, toDevice } = relayed;
    const [request, result] = [patternOf(102_400), patternOf(102_401)];
    const heard: string[] = [];
    const credits = { legA: 0, legB: 0 };

    server.router.on('debug', ({ direction, header }) => {
      credits.legA += direction === 'tx' && header.kind === EnvelopeKind.CREDIT ? 1 : 0;
    });
    toDevice.on('debug', ({ direction, header }) => {
      credits.legB += direction === 'tx' && header.kind === EnvelopeKind.CREDIT ? 1 : 0;
    });
    deviceServices.getRequestResolver(echo, { serializer: bytes })((asked, response) => {
      heard.push(digestOf(asked.payload));

      return response(result);
    });
    await client.services.getRequest(openSession, { serializer: text })('me')();

    const resulted = await client.services.getRequest(echo, { serializer: bytes })(request)({
      destinationId: 7,
      timeout: 30_000,
    });

    expect(digestOf(resulted)).toBe(digestOf(result));
    expect(heard).toEqual([digestOf(request)]);
    // the relay credited the client's request on leg A, and the device's result on leg B
    expect(credits.legA).toBeGreaterThan(1);
    expect(credits.legB).toBeGreaterThan(1);
  });

  test('cancel the device’s call when the client cancels its own', async () => {
    await using relayed = await connectRelayed();
    const { client, deviceServices } = relayed;
    const started: string[] = [];
    const reasons: unknown[] = [];

    deviceServices.getRequestResolver(held, { serializer: text })((request) => {
      started.push(request.payload);

      return new Promise((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            reasons.push(request.signal.reason);
            resolve(undefined);
          },
          { once: true }
        );
      });
    });
    await client.services.getRequest(openSession, { serializer: text })('me')();

    const controller = new AbortController();
    const asking = client.services
      .getRequest(held, { serializer: text })('wait')({
        destinationId: 7,
        signal: controller.signal,
      })
      .catch((reason: unknown) => {
        return reason;
      });

    await expect
      .poll(() => {
        return started;
      })
      .toEqual(['wait']);
    controller.abort();

    expect(await asking).toBeInstanceOf(CancelError);
    await expect
      .poll(() => {
        return reasons;
      })
      .toEqual([expect.any(CancelError)]);
  });
});

for (const [label, TrackedWebSocket] of IMPLEMENTATIONS) {
  test.describe(`a WebSocket server and client, the client on ${label}`, () => {
    test('open a session by a request, answer within it, command the client, and close a silent connection', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });
      const opened = Promise.withResolvers<TransportServerConnectionHandle>();

      try {
        server.services.getRequestResolver(openSession, { serializer: text })(
          (request, response) => {
            const session = server.sessions.set({
              ...server.sessions.create(request.connectionHandle),
              connectionInactivityTimeout: 300,
              sessionInactivityTimeout: Infinity,
            });

            opened.resolve(request.connectionHandle);

            return response(session.sessionToken ?? '');
          }
        );
        server.services.getRequestResolver(echo, {
          beforeRequest: server.requireSession,
          serializer: text,
        })((request, response) => {
          return response(request.payload.toUpperCase());
        });
        client.services.getCommandResolver(ping, { serializer: text })((_request, response) => {
          return response('pong');
        });

        await client.connect({ host, port });

        const echoing = client.services.getRequest(echo, { serializer: text });

        // nothing but the procedure that opens a session answers without one: the server refuses
        await expect(echoing('hi')()).rejects.toBeInstanceOf(FailureError);
        await expect(echoing('hi')()).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
          origin: 'peer',
          side: 'server',
        });

        const sessionToken = await client.services.getRequest(openSession, { serializer: text })(
          'me'
        )();

        // the same token at both ends
        expect(sessionToken).toBe(server.sessions.sessionTokenOf(await opened.promise));
        expect(client.router.sessionToken).toBe(sessionToken);
        await expect(echoing('hi')()).resolves.toBe('HI');

        // the server commands the client it names
        await expect(
          server.services.getCommand(ping, { serializer: text })('ping')({
            connectionHandle: await opened.promise,
          })
        ).resolves.toBe('pong');

        // silent past its connection timeout, the client is closed, and its session goes with it
        await expect
          .poll(() => {
            return client.transport.isClosed();
          })
          .toBe(true);
        await expect
          .poll(() => {
            return server.sessions.getAll();
          })
          .toEqual([]);
        expect(client.router.sessionToken).toBeUndefined();
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('subscribe, get the notification that doubles its result, and unsubscribe by call id', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });

      try {
        const newsResolver = server.services.getNotificationResolver(news, {
          serializer: { ...text, encodeNotification: text.encode },
        })(async (_request, response) => {
          const callId = response.registerNotification();

          // sent before the answer, under the call id the answer is for
          await newsResolver.notify('ahead');
          await response(String(callId));
        });

        server.services.getRequestResolver(unsubscribe, { serializer: text })(
          (request, response) => {
            return response(
              String(
                server.router.unsubscribe({
                  callId: Number(request.payload),
                  connectionHandle: request.connectionHandle,
                })
              )
            );
          }
        );

        await client.connect({ host, port });

        const heard: string[] = [];
        const unsubscribing = client.services.getRequest(unsubscribe, { serializer: text });
        const registration = await client.services.getNotification(news, {
          serializer: { ...text, decodeNotification: text.decode },
          unsubscribe: (callId) => {
            return unsubscribing(String(callId))();
          },
        })('subscribe', (payload) => {
          heard.push(payload);
        })();

        await expect
          .poll(() => {
            return heard;
          })
          .toEqual(['ahead']);
        expect(server.router.notifications.subscriptions()).toMatchObject([{ callId: 1 }]);

        await registration.unregister();

        expect(server.router.notifications.subscriptions()).toEqual([]);
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('a subscription let go of without an unsubscribe is cancelled, so subscribing again is heard', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });

      try {
        const newsResolver = server.services.getNotificationResolver(news, {
          serializer: { ...text, encodeNotification: text.encode },
        })((_request, response) => {
          return response('ok');
        });

        await client.connect({ host, port });

        const heard: string[] = [];
        const subscribe = client.services.getNotification(news, {
          serializer: { ...text, decodeNotification: text.decode },
        });
        const first = await subscribe('subscribe', (payload) => {
          heard.push(`first ${payload}`);
        })();

        await first.unregister();
        await expect
          .poll(() => {
            return server.router.notifications.subscriptions();
          })
          .toEqual([]);

        await subscribe('subscribe', (payload) => {
          heard.push(`again ${payload}`);
        })();
        await newsResolver.notify('flash');

        await expect
          .poll(() => {
            return heard;
          })
          .toEqual(['again flash']);
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('a command whose timeout passes is cancelled, and the client’s resolver hears it', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });
      const opened = Promise.withResolvers<TransportServerConnectionHandle>();
      const reasons: unknown[] = [];

      try {
        server.services.getRequestResolver(openSession, { serializer: text })(
          (request, response) => {
            opened.resolve(request.connectionHandle);

            return response('');
          }
        );
        client.services.getCommandResolver(ping, { serializer: text })((request) => {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              reasons.push(request.signal.reason);
              reject(new Error('stopped'));
            });
          });
        });

        await client.connect({ host, port });
        await client.services.getRequest(openSession, { serializer: text })('me')();

        await expect(
          server.services.getCommand(ping, { serializer: text })('ping')({
            connectionHandle: await opened.promise,
            timeout: 50,
          })
        ).rejects.toBeInstanceOf(TimeoutError);
        await expect
          .poll(() => {
            return reasons;
          })
          .toEqual([expect.any(CancelError)]);
        // cancelled, not closed: closeOnCommandTimeout is not set
        expect(client.transport.isOpen()).toBe(true);
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('a request whose timeout passes is cancelled, and the server’s resolver hears it', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });
      const reasons: unknown[] = [];
      const errors: Error[] = [];

      try {
        server.router.on('error', (error) => {
          errors.push(error);
        });
        server.services.getRequestResolver(echo, { serializer: text })((request) => {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              reasons.push(request.signal.reason);
              reject(new Error('stopped'));
            });
          });
        });

        await client.connect({ host, port });

        await expect(
          client.services.getRequest(echo, { serializer: text })('hi')({ timeout: 50 })
        ).rejects.toBeInstanceOf(TimeoutError);
        await expect
          .poll(() => {
            return reasons;
          })
          .toEqual([expect.any(CancelError)]);
        // what stopped because its call was cancelled is no one's to hear of
        expect(errors).toEqual([]);
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('a session that ends ends the subscriptions it let the client have: the client drops them, and asks anew', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });

      try {
        server.services.getRequestResolver(openSession, { serializer: text })(
          (request, response) => {
            server.sessions.set({
              ...server.sessions.create(request.connectionHandle),
              connectionInactivityTimeout: Infinity,
              // wide enough that the subscription below comes inside it on a loaded machine
              sessionInactivityTimeout: 400,
            });

            return response('');
          }
        );
        server.services.getNotificationResolver(news, {
          beforeRequest: server.requireSession,
          serializer: { ...text, encodeNotification: text.encode },
        })((_request, response) => {
          return response('ok');
        });

        await client.connect({ host, port });
        await client.services.getRequest(openSession, { serializer: text })('me')();

        const dropped = Promise.withResolvers<unknown>();

        client.services.on('dropped', (procedure) => {
          dropped.resolve(procedure);
        });

        const notification = client.services.getNotification(news, {
          serializer: { ...text, decodeNotification: text.decode },
        });

        await notification('subscribe', () => {
          return undefined;
        })();

        expect(client.router.sessionToken).toBeDefined();
        await expect(dropped.promise).resolves.toEqual(news);
        expect(client.router.sessionToken).toBeUndefined();
        expect(server.router.notifications.subscriptions()).toEqual([]);

        // without a session, the next registration asks anew, and is refused
        await expect(
          notification('subscribe', () => {
            return undefined;
          })()
        ).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });

    test('an ordinary request to the procedure of a subscription held moves nothing: notify still reaches it', async () => {
      const server = createWSServer({ transport: { WebSocketServer } });
      const { port } = await server.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });

      try {
        const newsResolver = server.services.getNotificationResolver(news, {
          serializer: { ...text, encodeNotification: text.encode },
        })((request, response) => {
          // an ordinary request subscribes nothing: its callback cannot, and fails if it tries
          if (request.payload === 'fail') {
            response.registerNotification();
          }

          return response('ok');
        });

        await client.connect({ host, port });

        const heard: string[] = [];
        const notification = client.services.getNotification(news, {
          serializer: { ...text, decodeNotification: text.decode },
        });

        await notification('subscribe', (payload) => {
          heard.push(payload);
        })();

        const plain = client.services.getRequest(news, { serializer: text });

        await expect(plain('again')()).resolves.toBe('ok');
        await expect(plain('fail')()).rejects.toMatchObject({
          code: ProtocolCode.PROCEDURE_FAILED,
        });
        await newsResolver.notify('still');

        await expect
          .poll(() => {
            return heard;
          })
          .toEqual(['still']);
        expect(server.router.notifications.subscriptions()).toMatchObject([{ callId: 1 }]);
      } finally {
        await client[Symbol.asyncDispose]();
        await expectAtRest(server);
        await server[Symbol.asyncDispose]();
        await allClosed();
      }
    });
  });
}
