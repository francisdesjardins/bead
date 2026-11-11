import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { createRouterServer } from '../../../router/server/router-server';
import { CredentialScheme, EnvelopeKind, ProtocolCode } from '../../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IAccessRefusal, IProcedure } from '../../../router/shared/types';
import { createMemoryTransportClient } from '../../client/memory-transport-client';
import { CancelError, ConnectError } from '../../shared/errors';
import { createTestClock } from '../../shared/__tests__/fixtures';
import { createMemoryTransportServer, START_DEFAULTS } from '../memory-transport-server';
import type { TransportServerConnectionHandle } from '../types';

// constants

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 1,
};

// helpers

/** A turn of the event loop, past what each end handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

// definition

test.describe('createMemoryTransportServer', () => {
  test('an envelope or a close a listener of the transport sends within its turn comes behind what was sent before it', async () => {
    for (const closes of [false, true]) {
      await using server = createMemoryTransportServer();
      await using client = createMemoryTransportClient();
      const heard: unknown[] = [];

      await server.start();
      await client.connect({ server });

      const handle = server.clients[0]?.connectionHandle;

      expect(handle).toBeDefined();

      if (handle === undefined) {
        throw new Error('no connection');
      }

      server.on('message', ({ data }, connectionHandle) => {
        expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([0xff]);

        if (closes) {
          void server.close(connectionHandle);
        } else {
          void server.send({ data: new Uint8Array([2]) }, connectionHandle);
        }
      });
      client.on('message', ({ data }) => {
        heard.push([...new Uint8Array(data as ArrayBuffer)]);
      });
      client.on('close', (wasClean, isQuick) => {
        heard.push(['closed', wasClean, isQuick]);
      });

      const trigger = client.send({ data: new Uint8Array([0xff]) });
      const firstSent = server.send({ data: new Uint8Array([1]) }, handle);

      await Promise.all([trigger, firstSent]);
      await turn();

      expect(heard).toEqual(closes ? [[1], ['closed', false, false]] : [[1], [2]]);
    }
  });

  // spec 15.13
  test('hands its router the address and the port its client gave as it connected', async () => {
    // a clock that never moves: what the server reads of it is the instant it starts at
    const clock = createTestClock(Date.UTC(2026, 9, 21));
    await using server = createMemoryTransportServer({ clock });
    await using caller = createMemoryTransportClient({ clock });
    await using nameless = createMemoryTransportClient({ clock });
    using router = createRouterServer(server);
    using client = createRouterClient(caller, {
      credential: { carried: 'Bearer token', scheme: CredentialScheme.ELSEWHERE },
    });
    const refusals: IAccessRefusal<TransportServerConnectionHandle>[] = [];
    const heard: unknown[] = [];

    expect(await server.start()).toEqual({ address: 'local', port: 0 });
    expect([server.address, server.port]).toEqual([START_DEFAULTS.address, START_DEFAULTS.port]);

    createServiceManager(router).getRequestResolver(echo, { serializer: PAYLOAD_CODECS.text })(
      (request, response) => {
        return response(request.payload);
      }
    );
    router.on('accessRefused', (refusal) => {
      refusals.push(refusal);
    });
    server.on('message', ({ address, port }, connectionHandle) => {
      heard.push([address, port, connectionHandle]);
    });
    await caller.connect({ address: '192.0.2.7', port: 50_000, server });
    await nameless.connect({ server });
    await nameless.send({ data: new Uint8Array([0]) });

    // a router with no verifier refuses the ELSEWHERE it was handed, and tells who asked
    await expect(
      createServiceManager(client).getRequest(echo, { serializer: PAYLOAD_CODECS.text })('hi')()
    ).rejects.toMatchObject({ code: ProtocolCode.CREDENTIAL_UNSUPPORTED });
    await turn();

    expect(refusals).toMatchObject([
      {
        address: '192.0.2.7',
        code: ProtocolCode.CREDENTIAL_UNSUPPORTED,
        connectionHandle: 'type=MEMORY;ip=192.0.2.7;ordinal=1',
        port: 50_000,
      },
    ]);
    expect(heard).toEqual([
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=2'],
      ['192.0.2.7', 50_000, 'type=MEMORY;ip=192.0.2.7;ordinal=1'],
    ]);
    expect(server.clients).toEqual([
      {
        address: '192.0.2.7',
        connectionHandle: 'type=MEMORY;ip=192.0.2.7;ordinal=1',
        lastActivity: Date.UTC(2026, 9, 21),
        port: 50_000,
        type: 'MEMORY',
      },
      {
        address: 'local',
        connectionHandle: 'type=MEMORY;ip=local;ordinal=2',
        lastActivity: Date.UTC(2026, 9, 21),
        port: 0,
        type: 'MEMORY',
      },
    ]);

    // what no handle could name, nor a socket carry, refused before anything moves
    for (const address of ['', 'a;b', 'a b']) {
      await expect(nameless.connect({ address, server })).rejects.toThrow(
        "an in-memory connect's address"
      );
    }

    for (const port of [-1, 65_536, 1.5, Number.NaN]) {
      await expect(nameless.connect({ port, server })).rejects.toThrow(
        "an in-memory connect's port"
      );
    }
  });

  // spec 15.13
  test('draws a handle of type MEMORY for each connect, and gives none twice', async () => {
    await using server = createMemoryTransportServer();
    await using first = createMemoryTransportClient();
    await using second = createMemoryTransportClient();
    const drawn: unknown[] = [];

    server.on('connection', (...[{ request, socket: peer }, connectionHandle]) => {
      drawn.push([peer.address, request, connectionHandle]);
    });
    await server.start();
    await first.connect({ server });
    await second.connect({ server });
    await first.disconnect();
    await turn();
    // the same client again, from the same address: a rank of its own
    await first.connect({ server });

    expect(drawn).toEqual([
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=1'],
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=2'],
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=3'],
    ]);
    expect(
      server.clients.map(({ connectionHandle }) => {
        return connectionHandle;
      })
    ).toEqual(['type=MEMORY;ip=local;ordinal=2', 'type=MEMORY;ip=local;ordinal=3']);
    expect(server.type).toBe('MEMORY');

    // so is one reconnected, and one after a stop and a start, which reset no rank
    await second.reconnect();
    await server.stop();
    await turn();
    await server.start();
    await first.connect({ server });

    expect(drawn.slice(3)).toEqual([
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=4'],
      ['local', undefined, 'type=MEMORY;ip=local;ordinal=5'],
    ]);
    expect(
      server.clients.map(({ connectionHandle }) => {
        return connectionHandle;
      })
    ).toEqual(['type=MEMORY;ip=local;ordinal=5']);
  });

  // spec 15.13
  test('closes each connection as it stops, and takes no connect after', async () => {
    await using server = createMemoryTransportServer();
    await using first = createMemoryTransportClient();
    await using second = createMemoryTransportClient();
    const closes: unknown[] = [];

    // before it listens, a connect fails before anything goes
    await expect(first.connect({ server })).rejects.toThrow(
      new ConnectError('the in-memory transport server is uninitialized, not open')
    );
    expect(first.isClosed()).toBe(true);

    server.on('close', (...params) => {
      closes.push(['server', ...params]);
    });
    first.on('close', (...params) => {
      closes.push(['first', ...params]);
    });
    second.on('close', (...params) => {
      closes.push(['second', ...params]);
    });
    await server.start();
    await first.connect({ server });
    await second.connect({ address: '198.51.100.1', server });
    await server.stop();
    await turn();

    // each closed clean at the server, its client told after
    expect([closes, server.clients, server.isClosed()]).toEqual([
      [
        ['server', true, 'type=MEMORY;ip=local;ordinal=1'],
        ['server', true, 'type=MEMORY;ip=198.51.100.1;ordinal=2'],
        ['first', false, false],
        ['second', false, false],
      ],
      [],
      true,
    ]);
    expect([first.isClosed(), second.isClosed()]).toEqual([true, true]);
    await expect(first.connect({ server })).rejects.toThrow(
      new ConnectError('the in-memory transport server is closed, not open')
    );
    expect([server.clients, first.isClosed()]).toEqual([[], true]);

    // * a connect its server took as it listened, its draw still queued as a stop begins: judged
    // in the turn it would be drawn in, refused, and no connection drawn
    const drawn: string[] = [];

    server.on('connection', (...[, connectionHandle]) => {
      drawn.push(connectionHandle);
    });
    await server.start();

    const queued = first.connect({ server });
    const stopping = server.stop();

    await expect(queued).rejects.toThrow(
      new ConnectError('the in-memory transport server is closing, not open')
    );
    await stopping;
    await turn();

    expect([drawn, server.clients, server.isClosed(), first.isClosed()]).toEqual([
      [],
      [],
      true,
      true,
    ]);
    expect(server.gauges().counts).toMatchObject({ connections: 0 });
  });

  // spec 15.13
  test('carries a transfer under its routers’ credit', async () => {
    // a payload of 64 KiB, in chunks of 1 KiB each way, under a window of 4 KiB
    const limits = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 4_096 };
    const payload = 'x'.repeat(65_536);
    await using server = createMemoryTransportServer();
    await using caller = createMemoryTransportClient();
    using router = createRouterServer(server, { limits });
    using client = createRouterClient(caller, { limits });
    let crossed = 0;
    const kinds: Record<string, number[]> = { rx: [], tx: [] };

    server.on('message', () => {
      crossed += 1;
    });
    client.on('debug', ({ direction, header }) => {
      kinds[direction]?.push(header.kind);
    });
    createServiceManager(router).getRequestResolver(echo, { serializer: PAYLOAD_CODECS.text })(
      (request, response) => {
        return response(request.payload);
      }
    );
    await server.start();
    await caller.connect({ server });

    const echoed = await createServiceManager(client).getRequest(echo, {
      serializer: PAYLOAD_CODECS.text,
    })(payload)();

    expect(echoed).toBe(payload);
    // its request's chunks, more than 64 of them, and the credit its result's chunks were granted
    expect(crossed).toBeGreaterThan(64);
    // * chunks each way, each crossing as its other end credits it
    for (const direction of ['tx', 'rx']) {
      expect(kinds[direction]).toContain(EnvelopeKind.CREDIT);
      expect(
        kinds[direction]?.filter((kind) => {
          return kind === EnvelopeKind.CHUNK;
        }).length
      ).toBeGreaterThan(2);
    }
    expect(router.gauges().counts).toMatchObject({ receivingTransfers: 0, sendingTransfers: 0 });
  });

  // spec 15.13
  test('drops what an end it no longer holds receives, and refuses to send what is no bytes', async () => {
    await using server = createMemoryTransportServer();
    const heard: unknown[] = [];
    const told: boolean[] = [];
    const closed: boolean[] = [];

    server.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);
    });
    await server.start();

    const end = await server.accept({
      address: 'local',
      close: (wasClean) => {
        told.push(wasClean);
      },
      port: undefined,
      receive: () => {},
    });
    const [{ connectionHandle } = { connectionHandle: undefined }] = server.clients;

    if (connectionHandle === undefined) {
      throw new Error('the server holds no connection');
    }

    server.on('close', (wasClean) => {
      closed.push(wasClean);
    });

    await expect(server.send({ data: 'text' }, connectionHandle)).rejects.toThrow(
      'an in-memory connection carries envelopes, as bytes'
    );
    end.receive({ data: new Uint8Array([1]) });

    // ended twice in one turn, then what its end receives once it heard so: neither heard nor
    // ended again
    expect(
      await Promise.all([server.close(connectionHandle), server.close(connectionHandle)])
    ).toEqual([true, true]);
    end.receive({ data: new Uint8Array([2]) });
    await turn();

    expect([heard, told, closed, server.clients]).toEqual([[[1]], [true], [true], []]);

    // * ended twice, then a send its client made before it heard so, queued behind both ends:
    // neither heard nor ended again, its client told unclean
    await using client = createMemoryTransportClient();
    const closedAtClient: unknown[] = [];

    client.on('close', (...params) => {
      closedAtClient.push(params);
    });
    await client.connect({ server });
    await client.send({ data: new Uint8Array([3]) });
    await turn();

    const [{ connectionHandle: held } = { connectionHandle: undefined }] = server.clients;

    if (held === undefined) {
      throw new Error('the server holds no connection');
    }

    const ending = server.close(held);
    const again = server.close(held);

    await client.send({ data: new Uint8Array([4]) });

    expect(await Promise.all([ending, again])).toEqual([true, true]);

    await turn();

    expect([heard, closed, closedAtClient, client.isClosed(), server.clients]).toEqual([
      [[1], [3]],
      [true, true],
      [[false, false]],
      true,
      [],
    ]);
  });

  // spec 15.13
  test('draws no connection for a connect cancelled as it held it, and reports what a listener throws', async () => {
    await using server = createMemoryTransportServer();
    await using client = createMemoryTransportClient();
    const drawn: string[] = [];
    const heard: number[][] = [];
    const reported: string[] = [];

    server.on('connection', (...[, connectionHandle]) => {
      drawn.push(connectionHandle);
    });
    server.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);

      throw new Error('a listener broke');
    });
    server.on('error', (error, connectionHandle) => {
      reported.push(`${error.message} ${connectionHandle}`);
    });
    await server.start();

    // * a connect whose token, a signal on this side, is cancelled as its server holds it, before
    // the turn it would be drawn in: no connection drawn
    const cancelling = new AbortController();
    const connecting = client.connect({ server, signal: cancelling.signal });

    cancelling.abort();
    await expect(connecting).rejects.toBeInstanceOf(CancelError);
    await turn();
    expect([drawn, server.clients]).toEqual([[], []]);

    // a listener's throw reported with its connection, the transport going on
    await client.connect({ server });
    await client.send({ data: new Uint8Array([1]) });
    await client.send({ data: new Uint8Array([2]) });
    await turn();

    const connectionHandle = 'type=MEMORY;ip=local;ordinal=1';

    expect([drawn, heard, reported]).toEqual([
      [connectionHandle],
      [[1], [2]],
      [`a listener broke ${connectionHandle}`, `a listener broke ${connectionHandle}`],
    ]);
  });

  // spec 15.12.17, 15.12.18
  test('a paused in-memory transport holds what it is sent, in order, and hands it on once resumed', async () => {
    await using server = createMemoryTransportServer();
    await using client = createMemoryTransportClient();
    const atServer: number[] = [];
    const atClient: number[] = [];
    const connectionHandle = 'type=MEMORY;ip=local;ordinal=1';

    server.on('message', ({ data }) => {
      const [byte = 0] = new Uint8Array(data as ArrayBuffer);

      atServer.push(byte);

      // * a router at its bound pauses within the hand: what comes after waits
      if (byte === 3) {
        server.pause(connectionHandle);
      }
    });
    client.on('message', ({ data }) => {
      atClient.push(...new Uint8Array(data as ArrayBuffer));
    });
    await server.start();
    await client.connect({ server });

    // the server's end, paused, then paused again as it hands what it held
    server.pause(connectionHandle);
    server.pause(connectionHandle);

    for (const byte of [1, 2, 3, 4, 5]) {
      await client.send({ data: new Uint8Array([byte]) });
    }

    await turn();

    expect(atServer).toEqual([]);

    // * handed from a microtask, never within the resume; what comes meanwhile waits behind it
    server.resume(connectionHandle);
    void client.send({ data: new Uint8Array([6]) });

    expect(atServer).toEqual([]);

    await turn();

    expect(atServer).toEqual([1, 2, 3]);

    server.resume(connectionHandle);
    await turn();

    expect(atServer).toEqual([1, 2, 3, 4, 5, 6]);

    // the client's end, paused whole
    client.pause();

    for (const byte of [7, 8]) {
      await server.send({ data: new Uint8Array([byte]) }, connectionHandle);
    }

    await turn();

    expect(atClient).toEqual([]);

    client.resume();
    client.resume();
    await turn();

    expect(atClient).toEqual([7, 8]);

    // * a handle no longer held is let be; what a connection held goes with it
    server.pause(connectionHandle);
    await client.send({ data: new Uint8Array([9]) });
    await turn();
    await client.disconnect();
    await turn();
    server.resume(connectionHandle);
    await turn();

    expect([atServer, server.clients]).toEqual([[1, 2, 3, 4, 5, 6], []]);
  });
});
