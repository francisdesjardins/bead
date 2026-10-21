import { expect, test } from '@playwright/test';
import { createMemoryTransportServer } from '../../server/memory-transport-server';
import type { MemoryTransportServer } from '../../server/types';
import { ProgrammerError, ReadyStateError } from '../../shared/errors';
import type {
  IMemoryEndLike,
  IMemoryPeerLike,
  IMemoryTransportServerLike,
  ITransportMessage,
} from '../../shared/types';
import { createMemoryTransportClient } from '../memory-transport-client';
import { dispose } from '../transport-client';
import type { ITransportClientInternal } from '../types';

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
 * met, each accept it holds, and each close its end was told, clean or not.
 */
const createHeldServer = () => {
  const accepts: { reject: (reason: Error) => void; resolve: (end: IMemoryEndLike) => void }[] = [];
  const closes: boolean[] = [];
  const peers: IMemoryPeerLike[] = [];
  const end: IMemoryEndLike = {
    close: (wasClean) => {
      closes.push(wasClean);
    },
    receive: () => {},
  };
  const server: IMemoryTransportServerLike = {
    accept: (peer) => {
      peers.push(peer);

      return new Promise((resolve, reject) => {
        accepts.push({ reject, resolve });
      });
    },
  };

  return { accepts, closes, end, peers, server };
};

// definition

test.describe('createMemoryTransportClient', () => {
  // spec 15.13
  test('hands each envelope on whole, once and in order, in a later turn than its send', async () => {
    await using pair = await connected();
    const { atClient, atServer, client, connectionHandle, server } = pair;
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);

    // a view on a larger buffer crosses as its own bytes alone
    const pooled = new Uint8Array([9, 6, 7, 9]).subarray(1, 3);

    const sends = [
      client.send({ data: first }),
      client.send({ data: second.buffer }),
      client.send({ data: pooled }),
      server.send({ data: new Uint8Array([8]) }, connectionHandle),
    ];

    // nothing within the send; the sender's buffers its own once sent
    expect([atServer, atClient]).toEqual([[], []]);

    first.fill(0);
    second.fill(0);
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
    // an empty field carries none
    await client.send({ credential: '', data: new Uint8Array([2]) });
    await expect(
      client.send({ credential: 'Bearer token ', data: new Uint8Array([3]) })
    ).rejects.toThrow('a credential holds visible ASCII, spaces and tabs alone');
    await server.send({ credential: 'Bearer back', data: new Uint8Array([4]) }, connectionHandle);
    await turn();

    expect(
      atServer.map(([, message]) => {
        return (message as { credential: unknown }).credential;
      })
    ).toEqual(['Bearer token', undefined]);
    expect(atClient).toEqual([
      ['message', { address: undefined, bytes: [4], credential: undefined, port: undefined }],
    ]);
    expect(client.isOpen()).toBe(true);
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
    const held = createHeldServer();
    await using client = createMemoryTransportClient({ server: held.server });
    const heard: number[][] = [];

    client.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);
    });

    const connecting = client.connect({});

    await turn();
    held.peers[0]?.receive({ data: new Uint8Array([1]) });
    held.peers[0]?.receive({ data: new Uint8Array([2]) });
    expect(heard).toEqual([]);
    held.accepts[0]?.resolve(held.end);
    await connecting;

    expect([heard, client.isOpen()]).toEqual([[[1], [2]], true]);
  });

  // spec 15.13
  test('fails a connect its server closed as it opened, what it sent before unheard', async () => {
    const held = createHeldServer();
    await using client = createMemoryTransportClient({ server: held.server });
    const heard: unknown[] = [];

    client.on('message', (message) => {
      heard.push(message);
    });

    const connecting = client.connect({});

    await turn();
    held.peers[0]?.close(false);
    held.peers[0]?.receive({ data: new Uint8Array([1]) });
    held.accepts[0]?.resolve(held.end);

    await expect(connecting).rejects.toThrow(
      'the in-memory transport server closed the connection as it opened'
    );
    expect([heard, client.isClosed()]).toEqual([[], true]);
  });

  // spec 15.13
  test('closes at once, unclean, a connection its server draws once a dispose gave up on its connect', async () => {
    const held = createHeldServer();
    const client = createMemoryTransportClient({ server: held.server });
    const heard: unknown[] = [];

    client.on('message', (message) => {
      heard.push(message);
    });

    const connecting = client.connect({});

    await turn();
    (client as unknown as ITransportClientInternal)[dispose]();
    await expect(connecting).rejects.toThrow('disposed while connecting');
    expect(client.isClosed()).toBe(true);

    held.accepts[0]?.resolve(held.end);
    held.peers[0]?.receive({ data: new Uint8Array([1]) });
    await turn();

    expect([held.closes, heard]).toEqual([[false], []]);
  });

  test('refuses a send or a disconnect unless open, and a send of what is no bytes', async () => {
    {
      await using client = createMemoryTransportClient({ server: createHeldServer().server });

      await expect(client.send({ data: new Uint8Array([1]) })).rejects.toThrow(ReadyStateError);
      await expect(client.disconnect()).rejects.toThrow(ReadyStateError);
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
});
