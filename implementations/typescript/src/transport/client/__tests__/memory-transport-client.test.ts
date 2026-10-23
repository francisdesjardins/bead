import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { createRouterServer } from '../../../router/server/router-server';
import { CredentialScheme } from '../../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IProcedure } from '../../../router/shared/types';
import { createMemoryTransportServer } from '../../server/memory-transport-server';
import type { MemoryTransportServer } from '../../server/types';
import { createTestClock } from '../../shared/__tests__/fixtures';
import {
  CancelError,
  ConnectError,
  ProgrammerError,
  ReadyStateError,
  ReconnectError,
} from '../../shared/errors';
import { ReadyState } from '../../shared/ready-state';
import type {
  IMemoryAcceptOptions,
  IMemoryEndLike,
  IMemoryPeerLike,
  IMemoryTransportServerLike,
  ITransportMessage,
} from '../../shared/types';
import { createMemoryTransportClient } from '../memory-transport-client';
import { dispose } from '../transport-client';
import type { ITransportClientInternal } from '../types';

// constants

/** A procedure that answers the name of its call's session. */
const whoami: IProcedure = {
  procedureId: 1,
  procedureName: 'whoami',
  serviceId: 2,
  serviceRevision: 1,
};

// helpers

/** A turn of the event loop, past what each end handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

/** The bytes of a message as their numbers, and what came beside them. */
const recordOf = ({ address, credential, data, port }: ITransportMessage) => {
  return {
    address,
    bytes: [...new Uint8Array(data as ArrayBuffer)],
    credential,
    port,
  };
};

/** The bytes of a message as their numbers. */
const bytesOf = ({ data }: ITransportMessage): number[] => {
  return [...new Uint8Array(data as ArrayBuffer)];
};

/**
 * A server listening, a client connected to it, and what each end heard, in order: each message as
 * {@link recordOf} writes it, and each close.
 */
const connected = async () => {
  const server: MemoryTransportServer = createMemoryTransportServer();
  const client = createMemoryTransportClient({ server });
  const atServer: unknown[][] = [];
  const atClient: unknown[][] = [];

  server.on('message', (message, connectionHandle) => {
    atServer.push(['message', recordOf(message), connectionHandle]);
  });
  server.on('close', (...params) => {
    atServer.push(['close', ...params]);
  });
  client.on('message', (message) => {
    atClient.push(['message', recordOf(message)]);
  });
  client.on('close', (...params) => {
    atClient.push(['close', ...params]);
  });
  await server.start();
  await client.connect({});

  const [{ connectionHandle } = { connectionHandle: undefined }] = server.clients;

  if (connectionHandle === undefined) {
    throw new Error('the server holds no connection');
  }

  return {
    atClient,
    atServer,
    client,
    connectionHandle,
    server,
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await server.stop();
    },
  };
};

/**
 * A server of the test's own, which accepts each connect once the test resolves it: each peer it
 * met, the signal its connect handed it, each accept it holds, and each close its end was told,
 * clean or not.
 */
const createHeldServer = () => {
  const accepts: { reject: (reason: Error) => void; resolve: (end: IMemoryEndLike) => void }[] = [];
  const closes: boolean[] = [];
  const peers: IMemoryPeerLike[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const end: IMemoryEndLike = {
    close: (wasClean) => {
      closes.push(wasClean);
    },
    receive: () => {},
  };
  const server: IMemoryTransportServerLike = {
    accept: (peer, options?: IMemoryAcceptOptions) => {
      peers.push(peer);
      signals.push(options?.signal);

      return new Promise((resolve, reject) => {
        accepts.push({ reject, resolve });
      });
    },
  };

  return { accepts, closes, end, peers, server, signals };
};

// definition

test.describe('createMemoryTransportClient', () => {
  // spec 15.13
  test('hands each envelope on whole, once and in order, in a later turn than its send', async () => {
    await using pair = await connected();
    const { atClient, atServer, client, connectionHandle, server } = pair;
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const answer = new Uint8Array([8]);

    // a view on a larger buffer crosses as its own bytes alone
    const pooled = new Uint8Array([9, 6, 7, 9]).subarray(1, 3);

    const sends = [
      client.send({ data: first }),
      client.send({ data: second.buffer }),
      client.send({ data: pooled }),
      server.send({ data: answer }, connectionHandle),
    ];

    // nothing within the send; the sender's buffers its own once sent, both ways
    expect([atServer, atClient]).toEqual([[], []]);

    for (const bytes of [first, second, pooled, answer]) {
      bytes.fill(0);
    }

    await Promise.all(sends);
    await turn();

    expect(atServer).toEqual([
      [
        'message',
        { address: 'local', bytes: [1, 2, 3], credential: undefined, port: undefined },
        connectionHandle,
      ],
      [
        'message',
        { address: 'local', bytes: [4, 5], credential: undefined, port: undefined },
        connectionHandle,
      ],
      [
        'message',
        { address: 'local', bytes: [6, 7], credential: undefined, port: undefined },
        connectionHandle,
      ],
    ]);
    expect(atClient).toEqual([
      ['message', { address: undefined, bytes: [8], credential: undefined, port: undefined }],
    ]);

    await turn();

    expect([atServer.length, atClient.length]).toEqual([3, 1]);
  });

  // spec 15.13
  test('carries the credential a request presents beside it, and none toward its client', async () => {
    await using pair = await connected();
    const { atClient, atServer, client, connectionHandle, server } = pair;

    expect([
      client.carries('Bearer token'),
      client.carries('Basic a b'),
      client.carries(' Bearer'),
      client.carries('Bearer\n'),
      client.isSecure,
    ]).toEqual([true, true, false, false, true]);
    expect([server.carriesCredential(connectionHandle), server.isSecure(connectionHandle)]).toEqual(
      [false, true]
    );

    await client.send({ credential: 'Bearer token', data: new Uint8Array([1]) });
    await client.send({ data: new Uint8Array([2]) });
    // an empty field carries none
    await client.send({ credential: '', data: new Uint8Array([3]) });
    await expect(
      client.send({ credential: 'Bearer token ', data: new Uint8Array([4]) })
    ).rejects.toThrow('a credential holds visible ASCII, spaces and tabs alone');
    await server.send({ credential: 'Bearer back', data: new Uint8Array([5]) }, connectionHandle);
    await turn();

    expect(
      atServer.map(([, message]) => {
        return (message as { credential: unknown }).credential;
      })
    ).toEqual(['Bearer token', undefined, undefined]);
    expect(atClient).toEqual([
      ['message', { address: undefined, bytes: [5], credential: undefined, port: undefined }],
    ]);
    expect(client.isOpen()).toBe(true);

    // * through both routers: a call presenting ELSEWHERE stands for what came beside it
    const carried = 'Interop sub=ada';
    await using transport = createMemoryTransportServer();
    await using caller = createMemoryTransportClient({ server: transport });
    using router = createRouterServer(transport, {
      credentials: {
        verify: (given) => {
          return given === carried ? { data: 'ada', id: 'ada' } : undefined;
        },
      },
    });
    using routerClient = createRouterClient(caller, {
      credential: { carried, scheme: CredentialScheme.ELSEWHERE },
    });

    createServiceManager(router).getRequestResolver(whoami, { serializer: PAYLOAD_CODECS.text })(
      ({ session }, response) => {
        return response(String(session?.data));
      }
    );
    await transport.start();
    await caller.connect({});

    await expect(
      createServiceManager(routerClient).getRequest(whoami, { serializer: PAYLOAD_CODECS.text })(
        ''
      )()
    ).resolves.toBe('ada');
  });

  // spec 15.13
  test('tells the other end of a close in a later turn, the closer’s clean', async () => {
    {
      await using pair = await connected();
      const { atClient, atServer, client, connectionHandle, server } = pair;

      const sending = client.send({ data: new Uint8Array([1]) });
      const disconnecting = client.disconnect();

      // the closer's close at once, clean; the other end's in a later turn, after what came first
      expect([atClient, atServer, client.isClosed()]).toEqual([[['close', true, false]], [], true]);

      await Promise.all([sending, disconnecting]);
      await turn();

      expect(atServer).toEqual([
        [
          'message',
          { address: 'local', bytes: [1], credential: undefined, port: undefined },
          connectionHandle,
        ],
        ['close', true, connectionHandle],
      ]);
      expect(server.clients).toEqual([]);
    }

    {
      await using pair = await connected();
      const { atClient, atServer, client, connectionHandle, server } = pair;

      const sending = server.send({ data: new Uint8Array([2]) }, connectionHandle);
      const closing = server.close(connectionHandle);

      // the closer's close in a later turn too, clean, settled once told; its client's after it
      expect([atServer, atClient, client.isOpen()]).toEqual([[], [], true]);
      expect(await Promise.all([sending, closing])).toEqual([undefined, true]);
      expect(atServer).toEqual([['close', true, connectionHandle]]);
      expect(await server.close(connectionHandle)).toBe(false);

      await turn();

      expect(atClient).toEqual([
        ['message', { address: undefined, bytes: [2], credential: undefined, port: undefined }],
        ['close', false, false],
      ]);
      expect(client.isClosed()).toBe(true);
    }

    {
      await using pair = await connected();
      const { atClient, atServer, client, connectionHandle } = pair;

      // a close told unclean is told so at its server
      await client.disconnect({ isClean: false });
      await turn();

      expect([atClient, atServer]).toEqual([
        [['close', false, false]],
        [['close', false, connectionHandle]],
      ]);
    }

    {
      await using pair = await connected();
      const { atClient, atServer, client, connectionHandle } = pair;

      // dropped, as a socket is: no close at this end, and its server told of none clean
      (client as unknown as ITransportClientInternal)[dispose]();

      expect([atClient, atServer, client.isClosed()]).toEqual([[], [], true]);

      await turn();

      expect(atServer).toEqual([['close', false, connectionHandle]]);
    }
  });

  // spec 15.13
  test('hears what its server sent before the connection opened once it has, in its order', async () => {
    {
      const held = createHeldServer();
      await using client = createMemoryTransportClient({ server: held.server });
      const heard: number[][] = [];

      client.on('message', (message) => {
        heard.push(bytesOf(message));
      });

      const connecting = client.connect({});

      await turn();
      held.peers[0]?.receive({ data: new Uint8Array([1]) });
      held.peers[0]?.receive({ data: new Uint8Array([2]) });
      expect(heard).toEqual([]);
      held.accepts[0]?.resolve(held.end);
      await connecting;

      expect([heard, client.isOpen()]).toEqual([[[1], [2]], true]);
    }

    {
      await using server = createMemoryTransportServer();
      await using client = createMemoryTransportClient({ server });
      const heard: number[][] = [];

      // * sent in the turn its server draws it, before its client opened: heard once it has, in order
      server.on('connection', (...[, , connectionHandle]) => {
        void server.send({ data: new Uint8Array([1]) }, connectionHandle);
        void server.send({ data: new Uint8Array([2]) }, connectionHandle);
      });
      client.on('message', (message) => {
        heard.push(bytesOf(message));
      });
      await server.start();
      await client.connect({});
      await turn();

      expect([heard, client.isOpen()]).toEqual([[[1], [2]], true]);
    }
  });

  // spec 15.13
  test('fails a connect its server closed as it opened, what it sent before unheard', async () => {
    {
      const held = createHeldServer();
      await using client = createMemoryTransportClient({ server: held.server });
      const heard: unknown[] = [];

      client.on('message', (message) => {
        heard.push(message);
      });
      client.on('close', (...params) => {
        heard.push(['close', ...params]);
      });

      const connecting = client.connect({});

      await turn();
      held.peers[0]?.close(false);
      held.peers[0]?.receive({ data: new Uint8Array([1]) });
      held.accepts[0]?.resolve(held.end);

      await expect(connecting).rejects.toThrow(
        new ConnectError('the in-memory transport server closed the connection as it opened')
      );
      expect([heard, client.isClosed()]).toEqual([[], true]);
    }

    {
      await using server = createMemoryTransportServer();
      await using client = createMemoryTransportClient({ server });
      const heard: unknown[] = [];

      // * sent and closed in the turn its server draws it, before its client opened
      server.on('connection', (...[, , connectionHandle]) => {
        void server.send({ data: new Uint8Array([1]) }, connectionHandle);
        void server.close(connectionHandle);
      });
      client.on('message', (message) => {
        heard.push(message);
      });
      client.on('close', (...params) => {
        heard.push(['close', ...params]);
      });
      await server.start();

      await expect(client.connect({})).rejects.toThrow(
        new ConnectError('the in-memory transport server closed the connection as it opened')
      );
      await turn();

      expect([heard, client.isClosed(), server.clients]).toEqual([[], true, []]);
    }
  });

  // spec 15.13
  test('closes at once, unclean, a connection its server draws once a dispose gave up on its connect', async () => {
    {
      const held = createHeldServer();
      await using client = createMemoryTransportClient({ server: held.server });
      const heard: unknown[] = [];

      client.on('message', (message) => {
        heard.push(message);
      });
      client.on('close', (...flags) => {
        heard.push(flags);
      });

      const connecting = client.connect({});
      const refused = expect(connecting).rejects.toThrow(
        new ConnectError('the transport client was disposed as it connected')
      );

      // * accept settles first; its callback queues the connect behind this dispose.
      held.accepts[0]?.resolve(held.end);
      queueMicrotask(() => {
        (client as unknown as ITransportClientInternal)[dispose]();
      });
      await refused;
      await turn();

      expect([client.isClosed(), client.socket, held.closes, heard]).toEqual([
        true,
        null,
        [false],
        [],
      ]);
    }

    {
      const held = createHeldServer();
      const client = createMemoryTransportClient({ server: held.server });
      const heard: unknown[] = [];

      client.on('message', (message) => {
        heard.push(message);
      });

      const connecting = client.connect({});

      await turn();
      (client as unknown as ITransportClientInternal)[dispose]();
      await expect(connecting).rejects.toThrow(
        new ConnectError('the transport client was disposed as it connected')
      );
      expect(client.isClosed()).toBe(true);

      held.accepts[0]?.resolve(held.end);
      held.peers[0]?.receive({ data: new Uint8Array([1]) });
      await turn();

      expect([held.closes, heard]).toEqual([[false], []]);
    }

    {
      await using server = createMemoryTransportServer();
      const client = createMemoryTransportClient({ server });
      const heard: unknown[] = [];
      const closedAtServer: boolean[] = [];

      // * its dispose in the turn its server draws the connection, before its client opened; what
      // its server sends after goes unheard
      server.on('connection', (...[, , connectionHandle]) => {
        (client as unknown as ITransportClientInternal)[dispose]();
        void server.send({ data: new Uint8Array([1]) }, connectionHandle);
      });
      server.on('close', (wasClean) => {
        closedAtServer.push(wasClean);
      });
      client.on('message', (message) => {
        heard.push(message);
      });
      await server.start();

      await expect(client.connect({})).rejects.toThrow(
        new ConnectError('the transport client was disposed as it connected')
      );
      await turn();

      expect([client.isClosed(), closedAtServer, heard, server.clients]).toEqual([
        true,
        [false],
        [],
        [],
      ]);
    }
  });

  test('refuses a send or a disconnect unless open, and a send of what is no bytes', async () => {
    {
      await using client = createMemoryTransportClient({ server: createHeldServer().server });
      const unopened = { expected: ReadyState.OPEN, got: ReadyState.UNINITIALIZED };

      // * never connected: nothing to send on, nor to close
      await expect(client.send({ data: new Uint8Array([1]) })).rejects.toThrow(ReadyStateError);
      await expect(client.send({ data: new Uint8Array([1]) })).rejects.toMatchObject({
        ...unopened,
        message: 'the transport client is uninitialized, not open',
      });
      await expect(client.disconnect()).rejects.toThrow(ReadyStateError);
      await expect(client.disconnect()).rejects.toMatchObject({
        ...unopened,
        message: 'the transport client is uninitialized, not open',
      });
    }

    {
      await using pair = await connected();
      const { atServer, client } = pair;

      await expect(client.send({ data: 'text' })).rejects.toThrow(
        new ProgrammerError('an in-memory connection carries envelopes, as bytes')
      );
      await turn();

      expect([atServer, client.isOpen()]).toEqual([[], true]);
    }
  });

  // spec 15.13
  test('refuses a reconnect never connected, and a connect unless closed, nothing changed', async () => {
    await using server = createMemoryTransportServer();
    await using client = createMemoryTransportClient({ server });
    const aborted = AbortSignal.abort();

    // * never connected: nothing to connect again to
    await expect(client.reconnect()).rejects.toThrow(
      new ProgrammerError('the transport client was never connected')
    );

    // its token, a signal on this side, aborted already, and a server not started: refused, the
    // first leaving its state as it was
    await expect(client.connect({ signal: aborted })).rejects.toBeInstanceOf(CancelError);
    expect(client.isUninitialized()).toBe(true);
    await expect(client.connect({})).rejects.toThrow(
      new ConnectError('the in-memory transport server is uninitialized, not open')
    );
    expect(client.isClosed()).toBe(true);

    // open: a second connect refused, and a reconnection whose signal is aborted already leaves it
    // open
    await server.start();
    await client.connect({});
    await expect(client.connect({})).rejects.toThrow(
      new ProgrammerError('the transport client is already open')
    );
    await expect(client.reconnect({ signal: aborted })).rejects.toBeInstanceOf(CancelError);

    expect([client.isOpen(), server.clients.length]).toEqual([true, 1]);
  });

  // spec 15.13
  test('refuses a second connect or reconnect while one is pending', async () => {
    for (const isReconnect of [false, true]) {
      await using server = createMemoryTransportServer();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let isHolding = !isReconnect;
      const accepting: IMemoryTransportServerLike = {
        accept: async (peer, options) => {
          if (isHolding) {
            held.resolve();
            await release.promise;
          }

          return server.accept(peer, options);
        },
      };
      await using client = createMemoryTransportClient({ server: accepting });
      const drawn: string[] = [];
      const clientCloses: boolean[][] = [];
      const serverCloses: boolean[] = [];
      const errors: Error[] = [];
      let starts = 0;

      server.on('connection', (...[, , handle]) => {
        drawn.push(handle);
      });
      server.on('close', (isClean) => {
        serverCloses.push(isClean);
      });
      server.on('error', (error) => {
        errors.push(error);
      });
      client.on('close', (...flags) => {
        clientCloses.push(flags);
      });
      client.on('error', (error) => {
        errors.push(error);
      });
      client.on('reconnect', () => {
        starts += 1;
      });
      await server.start();

      if (isReconnect) {
        await client.connect({});
        isHolding = true;
      }

      const pending = isReconnect ? client.reconnect({ maxAttempts: 1 }) : client.connect({});

      try {
        await held.promise;
        await turn();

        const state = isReconnect ? 'reconnecting' : 'connecting';

        await expect(client.connect({})).rejects.toThrow(
          new ProgrammerError(`the transport client is already ${state}`)
        );
        await expect(client.reconnect()).rejects.toThrow(
          new ProgrammerError(
            isReconnect
              ? 'the transport client is already reconnecting'
              : 'the transport client cannot reconnect while connecting'
          )
        );
        expect(client.isReconnecting()).toBe(isReconnect);
        expect(client.isConnecting()).toBe(!isReconnect);
        expect([starts, drawn.length, server.clients, clientCloses, serverCloses, errors]).toEqual([
          isReconnect ? 1 : 0,
          isReconnect ? 1 : 0,
          [],
          [],
          isReconnect ? [false] : [],
          [],
        ]);
      } finally {
        release.resolve();
        await pending;
      }

      await turn();
      expect(client.isOpen()).toBe(true);
      expect(server.clients).toHaveLength(1);
      expect(drawn).toHaveLength(isReconnect ? 2 : 1);
      expect(clientCloses).toEqual([]);
      await client.disconnect();
      await turn();
      expect([client.isClosed(), server.clients, clientCloses, serverCloses, errors]).toEqual([
        true,
        [],
        [[true, false]],
        isReconnect ? [false, true] : [true],
        [],
      ]);
    }
  });

  test('reconnects with its last connect’s options, replacing its connection without a close', async () => {
    await using server = createMemoryTransportServer();
    await using client = createMemoryTransportClient({ server });
    const drawn: string[] = [];
    const closedAtServer: string[] = [];
    const closedAtClient: string[] = [];
    const reported: string[] = [];
    let starts = 0;

    server.on('connection', (...[, , connectionHandle]) => {
      drawn.push(connectionHandle);
    });
    server.on('close', (wasClean, connectionHandle) => {
      closedAtServer.push(`${connectionHandle} ${String(wasClean)}`);
    });
    client.on('close', (isClean, isQuick) => {
      closedAtClient.push(`${String(isClean)} ${String(isQuick)}`);
    });
    client.on('error', (error) => {
      reported.push(error.message);
    });

    // * each listener of its start told, the one that throws reported, and the reconnection goes on
    client.on('reconnect', () => {
      starts += 1;
    });
    client.on('reconnect', () => {
      throw new Error('a listener broke');
    });

    await server.start();
    await client.connect({ address: '10.0.0.1', port: 4_000 });
    await client.reconnect();
    await turn();

    expect([client.isOpen(), drawn, closedAtServer, closedAtClient, starts, reported]).toEqual([
      true,
      ['type=MEMORY;ip=10.0.0.1;ordinal=1', 'type=MEMORY;ip=10.0.0.1;ordinal=2'],
      ['type=MEMORY;ip=10.0.0.1;ordinal=1 false'],
      [],
      1,
      ['a listener broke'],
    ]);

    // its server gone: each attempt refused, until they run out, CLOSED with no close of its own
    await server.stop();
    await turn();
    expect(closedAtClient).toEqual(['false false']);

    const gaveUp = await client.reconnect({ maxAttempts: 1 }).then(
      () => {
        throw new Error('the reconnection was taken');
      },
      (reason: unknown) => {
        return reason;
      }
    );

    expect(gaveUp).toBeInstanceOf(ReconnectError);
    expect((gaveUp as ReconnectError).cause).toBeInstanceOf(ConnectError);
    expect([client.isClosed(), closedAtClient.length]).toEqual([true, 1]);
  });

  // spec 15.13
  test('cancels a reconnection before its first attempt when its start listener cancels', async () => {
    await using pair = await connected();
    const { atClient, atServer, client, connectionHandle, server } = pair;
    const cancelling = new AbortController();
    const reason = new Error('the caller cancels at the start');
    const drawn: string[] = [];
    const errors: Error[] = [];
    let starts = 0;

    server.on('connection', (...[, , handle]) => {
      drawn.push(handle);
    });
    server.on('error', (error) => {
      errors.push(error);
    });
    client.on('error', (error) => {
      errors.push(error);
    });
    client.on('reconnect', () => {
      starts += 1;
      cancelling.abort(reason);
    });

    const cancelled: unknown = await client
      .reconnect({ maxAttempts: 1, signal: cancelling.signal })
      .catch((error: unknown) => {
        return error;
      });

    await turn();
    expect(cancelled).toBeInstanceOf(CancelError);
    expect(cancelled).toMatchObject({ cause: reason, message: 'the reconnection was cancelled' });
    expect([starts, client.isClosed(), server.clients, drawn, atClient, atServer, errors]).toEqual([
      1,
      true,
      [],
      [],
      [],
      [['close', false, connectionHandle]],
      [],
    ]);
  });

  test('closes what its last attempt opened as its reconnection was cancelled', async () => {
    await using server = createMemoryTransportServer();
    await using client = createMemoryTransportClient({ server });
    const cancelling = new AbortController();
    const closedAtClient: string[] = [];
    const closedAtServer: boolean[] = [];

    await server.start();
    await client.connect({});
    client.on('close', (isClean, isQuick) => {
      closedAtClient.push(`${String(isClean)} ${String(isQuick)}`);
    });
    server.on('close', (wasClean) => {
      closedAtServer.push(wasClean);
    });

    // * the reconnection cancelled in the very turn its server draws the connection: the cancel
    // holds until its attempt's connect settles, which fails, what was drawn closed unclean and no
    // close told here
    server.on('connection', () => {
      cancelling.abort();
    });

    const cancelled = await client
      .reconnect({ signal: cancelling.signal })
      .catch((error: unknown) => {
        return error;
      });

    await turn();

    // * worded as the C# side words it, the reason its signal was aborted with its cause
    expect(cancelled).toBeInstanceOf(CancelError);
    expect(cancelled).toHaveProperty('message', 'the reconnection was cancelled');
    expect((cancelled as CancelError).cause).toBe(cancelling.signal.reason);
    expect([client.isClosed(), closedAtClient, closedAtServer, server.clients]).toEqual([
      true,
      [],
      [false, false],
      [],
    ]);
  });

  // spec 15.13
  test('gives up a connect its dispose, its token or its clock ends before its server drew it', async () => {
    // * a server that holds each connect, as a peer that never answers; its token, on this side,
    // the connect's signal
    const held = createHeldServer();
    const clock = createTestClock();

    // its clock past its timeout
    {
      await using timed = createMemoryTransportClient({ clock, server: held.server });
      const timing = timed.connect({ timeout: 1_000 });
      const timedOut = expect(timing).rejects.toMatchObject({
        message: 'timed out after 1000ms',
        name: 'TimeoutError',
      });

      await turn();
      expect(held.peers).toHaveLength(1);
      await clock.tickAsync(1_000);
      await timedOut;
      expect(timed.isClosed()).toBe(true);
    }

    // its token cancelled
    {
      await using asked = createMemoryTransportClient({ server: held.server });
      const cancelling = new AbortController();
      const asking = asked.connect({ signal: cancelling.signal });

      await turn();
      expect(held.peers).toHaveLength(2);
      cancelling.abort();
      await expect(asking).rejects.toBeInstanceOf(CancelError);
      expect(asked.isClosed()).toBe(true);
    }

    // its dispose
    {
      const disposed = createMemoryTransportClient({ server: held.server });
      const disposing = disposed.connect({});

      await turn();
      expect(held.peers).toHaveLength(3);
      await disposed[Symbol.asyncDispose]();
      await expect(disposing).rejects.toThrow(
        new ConnectError('the transport client was disposed as it connected')
      );
      expect(disposed.isClosed()).toBe(true);
    }

    // each connect its server held told it was given up, so none is drawn for it
    expect(
      held.signals.map((signal) => {
        return signal?.aborted;
      })
    ).toEqual([true, true, true]);
  });

  // spec 15.13
  test('hears nothing once it let go of its connection, and tells one close at each end', async () => {
    await using pair = await connected();
    const { atClient, atServer, client, connectionHandle, server } = pair;

    // * its server sends and ends it as its client closes it, in one turn: none of it heard, one
    // close told at each end
    const sending = server.send({ data: new Uint8Array([8]) }, connectionHandle);
    const ending = server.close(connectionHandle);

    await client.disconnect();

    expect(await Promise.all([sending, ending])).toEqual([undefined, true]);

    await turn();

    expect([atClient, atServer]).toEqual([
      [['close', true, false]],
      [['close', true, connectionHandle]],
    ]);
  });
});
