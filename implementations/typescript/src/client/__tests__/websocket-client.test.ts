import { expect, test } from '@playwright/test';
import type { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { WebSocketServer as WsServer } from 'ws';
import { createWebSocketServer } from '../../server/websocket-server';
import {
  allClosed,
  createTestClock,
  host,
  IMPLEMENTATIONS,
  portOf,
  startServer,
  stopServer,
} from '../../transport/shared/__tests__/fixtures';
import { createFakeWebSocket } from '../../transport/client/__tests__/fake-websocket';
import { CLOSE_TIMEOUT } from '../../transport/client/websocket-transport-client';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { CredentialScheme } from '../../router/shared/constants';
import { toSessionToken } from '../../router/shared/identifiers';
import { ReadyState } from '../../transport/shared/ready-state';
import { CancelError, ProgrammerError } from '../../transport/shared/errors';
import type { Announcement, Envelope, IFailure, OutgoingEnvelope } from '../../router/shared/types';
import {
  createWebSocketClient,
  DisconnectError,
  FailureError,
  FailureScope,
  ReadyStateError,
  SERVER_FAILURES,
  TimeoutError,
  type WebSocketClient,
} from '../websocket-client';

// helpers

interface IReceivedEnvelope {
  envelope: Envelope;
  socket: WsWebSocket;
}

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

const serializer = { ...text, decodeNotification: text.decode };
const serverSerializer = text;

const echo = { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 };

const TOKEN = toSessionToken(new Uint8Array(16).fill(9));

/** A `ws` server that reads envelopes as a server does: each one it receives waits for a test. */
const startEnvelopeServer = async () => {
  const server = await startServer();
  const received: IReceivedEnvelope[] = [];
  const readers: ((received: IReceivedEnvelope) => void)[] = [];

  server.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      const envelope = readEnvelope(bytesOf(data), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
      });

      if (envelope === undefined) {
        return;
      }

      const reader = readers.shift();

      if (reader === undefined) {
        received.push({ envelope, socket });
      } else {
        reader({ envelope, socket });
      }
    });
  });

  const nextEnvelope = (): Promise<IReceivedEnvelope> => {
    const next = received.shift();

    return next === undefined
      ? new Promise((resolve) => {
          readers.push(resolve);
        })
      : Promise.resolve(next);
  };

  const send = (socket: WsWebSocket, envelope: OutgoingEnvelope) => {
    socket.send(writeEnvelope(envelope));
  };

  return { nextEnvelope, received, send, server };
};

/** The answer to `request`, on its call id: a result, or a failure, announcing a session or not. */
const answerTo = (
  { envelope }: IReceivedEnvelope,
  {
    credential,
    failure,
    payload = new Uint8Array(0),
  }: { credential?: Announcement; failure?: IFailure; payload?: Uint8Array }
): OutgoingEnvelope => {
  const { callId } = envelope.header;
  const session = credential === undefined ? {} : { credential };

  return failure === undefined
    ? { header: { callId, kind: 0x11, ...session }, kind: 0x11, payload }
    : { failure, header: { callId, kind: 0x12, ...session }, kind: 0x12 };
};

// definition

test('createWebSocketClient runs on the global WebSocket by default, not yet connected', () => {
  const client = createWebSocketClient();

  expect(client.transport.isUninitialized()).toBe(true);
  expect(client.router.transport).toBe(client.transport);
});

test('builds its router with the limits given', async () => {
  const client = createWebSocketClient({ limits: { maximumPayloadBytes: 8 } });

  await expect(
    client.services.getRequest(echo, { serializer })('much too long')()
  ).rejects.toMatchObject({ detail: 'a payload is 8 bytes at most, not 13' });
});

test('createWebSocketClient takes a message of an envelope at most, more when the transport says so, and never less', async () => {
  // envelopes of 256 bytes
  const small = { chunkBytes: 128, maximumEnvelopeBytes: 256, windowBytes: 256 };

  for (const [limits, maxPayload, expected] of [
    [undefined, undefined, 16_778_240],
    [small, undefined, 256],
    [small, 1_024, 1_024],
  ] as const) {
    const given: unknown[] = [];
    const { FakeWebSocket, sockets } = createFakeWebSocket();
    const Recording = Object.assign(
      // oxlint-disable-next-line prefer-arrow-callback -- the transport calls it with `new`, which an arrow refuses
      function (
        _url: string,
        _protocols: unknown,
        options?: { closeTimeout?: number; maxPayload?: number; perMessageDeflate?: false }
      ) {
        given.push(options);

        return new (FakeWebSocket as unknown as new () => object)();
      },
      { CONNECTING: 0, OPEN: 1 }
    ) as unknown as typeof FakeWebSocket;
    const client = createWebSocketClient({
      limits,
      transport: { maxPayload, WebSocket: Recording },
    });
    const connecting = client.connect({ host, port: 8_080 });

    sockets.at(-1)?.fireOpen();
    await connecting;

    expect(given).toEqual([
      { closeTimeout: CLOSE_TIMEOUT, maxPayload: expected, perMessageDeflate: false },
    ]);
    await client[Symbol.asyncDispose]();
  }

  // a socket that cuts off what the router would take
  for (const [limits, maxPayload] of [
    [undefined, 256],
    [small, 255],
  ] as const) {
    expect(() => {
      return createWebSocketClient({ limits, transport: { maxPayload } });
    }).toThrow(`maxPayload is an envelope's limit at least`);
  }
});

for (const [label, TrackedWebSocket] of IMPLEMENTATIONS) {
  test.describe(`createWebSocketClient, on ${label}`, () => {
    let envelopes: Awaited<ReturnType<typeof startEnvelopeServer>>;
    let server: WebSocketServer;
    let client: WebSocketClient;

    test.beforeEach(async () => {
      envelopes = await startEnvelopeServer();
      server = envelopes.server;
      client = createWebSocketClient({ transport: { WebSocket: TrackedWebSocket } });
      await client.connect({ host, port: portOf(server) });
    });

    test.afterEach(async () => {
      await client[Symbol.asyncDispose]();
      await stopServer(server);
      await allClosed();
    });

    test('runs its router on its transport’s clock, which times a request out', async () => {
      const clock = createTestClock();
      await using timed = createWebSocketClient({
        transport: { clock, WebSocket: TrackedWebSocket },
      });

      expect([timed.transport.clock, timed.router.clock]).toEqual([clock, clock]);
      await timed.connect({ host, port: portOf(server) });

      const calling = timed.services.getRequest(echo, { serializer })('wait')({ timeout: 1_000 });
      const refused = expect(calling).rejects.toBeInstanceOf(TimeoutError);

      await envelopes.nextEnvelope();
      clock.tick(1_000);
      await refused;
    });

    test('cancels a call at the server when its token is cancelled', async () => {
      await using serving = createWebSocketServer({ transport: { WebSocketServer: WsServer } });
      const entered = Promise.withResolvers<void>();
      let cancelled = 0;

      serving.services.getRequestResolver(echo, { serializer: text })((request) => {
        entered.resolve();

        return new Promise((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              cancelled += 1;
              resolve(undefined);
            },
            { once: true }
          );
        });
      });
      const { port } = await serving.transport.start({ address: host, findOpenPort: true });
      await using callingClient = createWebSocketClient({
        transport: { WebSocket: TrackedWebSocket },
      });

      await callingClient.connect({ host, port });
      const controller = new AbortController();
      const calling = callingClient.services.getRequest(echo, { serializer })('wait')({
        signal: controller.signal,
      });
      const refused = expect(calling).rejects.toBeInstanceOf(CancelError);

      await entered.promise;
      controller.abort();
      await refused;
      await expect
        .poll(() => {
          return cancelled;
        })
        .toBe(1);
    });

    test('takes its layers apart in reverse, rejecting what waits as disposed, then closing', async () => {
      const errors: Error[] = [];
      const closes: boolean[][] = [];
      const calling = client.services.getRequest(echo, { serializer })('wait')();
      const refused = expect(calling).rejects.toThrow('the router was disposed before the answer');

      client.router.on('error', (error) => {
        errors.push(error);
      });
      client.transport.on('close', (...flags) => {
        closes.push(flags);
      });
      await envelopes.nextEnvelope();
      await client[Symbol.asyncDispose]();
      await refused;
      expect(closes).toEqual([[true, false]]);
      expect(errors).toEqual([]);
    });

    test('rejects what waits once the server stops', async () => {
      const closes: boolean[][] = [];
      const calling = client.services.getRequest(echo, { serializer })('wait')();
      const refused = expect(calling).rejects.toBeInstanceOf(DisconnectError);

      client.transport.on('close', (...flags) => {
        closes.push(flags);
      });
      await envelopes.nextEnvelope();
      for (const socket of server.clients) {
        socket.close(1001);
      }
      await stopServer(server);
      await refused;
      expect(closes).toEqual([[false, false]]);
    });

    test('refuses a connect while open and a message limit below its envelope’s', async () => {
      await expect(client.connect({ host, port: portOf(server) })).rejects.toBeInstanceOf(
        ProgrammerError
      );
      expect(() => {
        return createWebSocketClient({ transport: { maxPayload: 64 } });
      }).toThrow(ProgrammerError);
    });

    test('connects, disconnects and reconnects through its transport, with the options given', async () => {
      const closes: boolean[][] = [];

      client.transport.on('close', (...flags) => {
        closes.push(flags);
      });
      await client.disconnect({ isClean: false });
      expect(closes).toEqual([[false, false]]);
      expect(client.transport.isClosed()).toBe(true);

      const controller = new AbortController();

      controller.abort();
      await expect(client.reconnect({ signal: controller.signal })).rejects.toBeInstanceOf(
        CancelError
      );
      expect(client.transport.isClosed()).toBe(true);
      await client.reconnect({ maximumAttempts: 1 });
      expect(client.transport.isOpen()).toBe(true);
      expect(client.router.transport).toBe(client.transport);

      const calling = client.services.getRequest(echo, { serializer })('a')();
      const request = await envelopes.nextEnvelope();

      envelopes.send(request.socket, answerTo(request, { payload: text.encode('a') }));
      await expect(calling).resolves.toBe('a');
    });

    test('a dispose cancels a reconnection under way, and a token given still cancels it too', async () => {
      await using other = createWebSocketClient({ transport: { WebSocket: TrackedWebSocket } });

      await other.connect({ host, port: portOf(server) });
      await stopServer(server);

      const controller = new AbortController();
      const byDispose = expect(client.reconnect({ delay: 60_000 })).rejects.toBeInstanceOf(
        CancelError
      );
      const bySignal = expect(
        other.reconnect({ delay: 60_000, signal: controller.signal })
      ).rejects.toBeInstanceOf(CancelError);

      await client[Symbol.asyncDispose]();
      controller.abort();
      await byDispose;
      await bySignal;
      expect([client.transport.isClosed(), other.transport.isClosed()]).toEqual([true, true]);
    });

    test('rejects what waits as replaced once its transport reconnects', async () => {
      const calling = client.services.getRequest(echo, { serializer })('wait')();
      const refused = expect(calling).rejects.toThrow(
        'the connection was replaced before the answer'
      );

      await envelopes.nextEnvelope();
      await client.reconnect();
      await refused;
      expect(client.transport.isOpen()).toBe(true);

      const following = client.services.getRequest(echo, { serializer })('a')();
      const request = await envelopes.nextEnvelope();

      envelopes.send(request.socket, answerTo(request, { payload: text.encode('a') }));
      await expect(following).resolves.toBe('a');
    });

    test('sends a request as an envelope, resolves with its result, and learns the session', async () => {
      const answering = client.services.getRequest(echo, { serializer })('hello')();
      const request = await envelopes.nextEnvelope();

      expect(request.envelope).toEqual({
        header: { callId: 1, kind: 0x10, procedureId: 1, serviceId: 2 },
        kind: 0x10,
        payload: text.encode('hello'),
      });

      envelopes.send(
        request.socket,
        answerTo(request, {
          credential: { scheme: CredentialScheme.OPAQUE, token: TOKEN },
          payload: text.encode('HELLO'),
        })
      );

      await expect(answering).resolves.toBe('HELLO');
      expect(client.router.sessionToken).toBe(TOKEN);
    });

    test('rejects with the failure the server answers, its procedure’s own included', async () => {
      const answering = client.services.getRequest(echo, { serializer })('hello')();
      const request = await envelopes.nextEnvelope();

      envelopes.send(
        request.socket,
        answerTo(request, {
          failure: { code: 21, detail: 'not ready', scope: FailureScope.APPLICATION },
        })
      );

      await expect(answering).rejects.toBeInstanceOf(FailureError);
      await expect(answering).rejects.toMatchObject({
        code: 21,
        detail: 'not ready',
        origin: 'peer',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        side: 'server',
      });
      await expect(
        answering.catch((reason: unknown) => {
          return (reason as FailureError).isApplication(21);
        })
      ).resolves.toBe(true);
    });

    test('hears the notifications of its subscription, under the call id that opened it, one ahead of its result included', async () => {
      const heard: string[] = [];
      const notification = client.services.getNotification(echo, { serializer });
      const subscribing = notification('subscribe', (payload) => {
        heard.push(payload);
      })();
      const request = await envelopes.nextEnvelope();
      const { callId } = request.envelope.header;

      // sent right before the result: the subscription is bound before the request went out
      envelopes.send(request.socket, {
        header: { callId, kind: 0x13 },
        kind: 0x13,
        payload: text.encode('first'),
      });
      envelopes.send(request.socket, answerTo(request, {}));
      await subscribing;
      envelopes.send(request.socket, {
        header: { callId, kind: 0x13 },
        kind: 0x13,
        payload: text.encode('news'),
      });

      await expect
        .poll(() => {
          return heard;
        })
        .toEqual(['first', 'news']);
    });

    test('answers the server’s commands, on even call ids, with the resolver registered', async () => {
      client.services.getCommandResolver(echo, { serializer: serverSerializer })(
        (request, response) => {
          return response(request.payload.toUpperCase());
        }
      );

      const [socket] = server.clients;

      socket?.send(
        writeEnvelope({
          header: { callId: 78, kind: 0x10, procedureId: 1, serviceId: 2 },
          kind: 0x10,
          payload: text.encode('quiet'),
        })
      );

      const response = await envelopes.nextEnvelope();

      expect(response.envelope).toEqual({
        header: { callId: 78, kind: 0x11 },
        kind: 0x11,
        payload: text.encode('QUIET'),
      });
    });

    test('cancels a request whose timeout passes, and hears nothing of an answer too late', async () => {
      const errors: Error[] = [];

      client.router.on('error', (error) => {
        errors.push(error);
      });

      // a call id stays reserved as long as its call's timeout: long enough here for the late
      // answer to come back within it, and be known for late
      const answering = client.services.getRequest(echo, { serializer })('hello')({
        timeout: 500,
      });
      // its rejection awaited from the start: on a loaded machine the timeout can pass before the
      // request is seen to arrive, and a rejection nothing awaits yet fails the run
      const rejected = expect(answering).rejects.toBeInstanceOf(TimeoutError);
      const request = await envelopes.nextEnvelope();

      await rejected;
      expect((await envelopes.nextEnvelope()).envelope).toEqual({
        header: { callId: 1, kind: 0x16 },
        kind: 0x16,
      });

      envelopes.send(request.socket, answerTo(request, { payload: text.encode('late') }));

      // a call after it, answered on the same socket: its result read, the late answer was too
      const following = client.services.getRequest(echo, { serializer })('after')();
      const next = await envelopes.nextEnvelope();

      envelopes.send(next.socket, answerTo(next, { payload: text.encode('AFTER') }));
      await expect(following).resolves.toBe('AFTER');
      expect(errors).toEqual([]);
    });

    test('rejects a request still waiting when the server closes the connection', async () => {
      const answering = client.services.getRequest(echo, { serializer })('hello')();
      const request = await envelopes.nextEnvelope();

      request.socket.close(1001);

      await expect(answering).rejects.toBeInstanceOf(DisconnectError);
    });

    // debugging 9.7
    test('fails a call before it connects by its ready state, sending nothing', async () => {
      await using unconnected = createWebSocketClient({
        transport: { WebSocket: TrackedWebSocket },
      });
      const failing = unconnected.services.getRequest(echo, { serializer })('hello')();

      await expect(failing).rejects.toBeInstanceOf(ReadyStateError);
      await expect(failing).rejects.toMatchObject({
        expected: ReadyState.OPEN,
        got: ReadyState.UNINITIALIZED,
      });
      expect(envelopes.received).toEqual([]);
    });

    // debugging 9.7
    test('fails a call once disconnected as a disconnection, sending nothing', async () => {
      await client.disconnect();

      const failing = client.services.getRequest(echo, { serializer })('hello')();

      await expect(failing).rejects.toBeInstanceOf(DisconnectError);
      await expect(failing).rejects.toThrow('the transport client is closed, not open');
      expect(envelopes.received).toEqual([]);
    });
  });
}
