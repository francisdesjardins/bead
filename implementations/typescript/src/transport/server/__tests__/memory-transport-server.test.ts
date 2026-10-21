import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { createRouterServer } from '../../../router/server/router-server';
import { CredentialScheme, ProtocolCode } from '../../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IAccessRefusal, IProcedure } from '../../../router/shared/types';
import { createMemoryTransportClient } from '../../client/memory-transport-client';
import { ConnectError } from '../../shared/errors';
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
  // spec 15.13
  test('hands its router the address and the port its client gave as it connected', async () => {
    // a clock that never moves: what the server reads of it is the instant it starts at
    const clock = createTestClock(Date.UTC(2026, 9, 21));
    await using server = createMemoryTransportServer({ clock });
    await using caller = createMemoryTransportClient({ clock, server });
    await using nameless = createMemoryTransportClient({ clock, server });
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
    await caller.connect({ address: '192.0.2.7', port: 50_000 });
    await nameless.connect({});
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
    for (const options of [{ address: '' }, { address: 'a;b' }, { address: 'a b' }]) {
      await expect(nameless.connect(options)).rejects.toThrow("an in-memory connect's address");
    }

    for (const port of [-1, 65_536, 1.5, Number.NaN]) {
      await expect(nameless.connect({ port })).rejects.toThrow("an in-memory connect's port");
    }
  });

  // spec 15.13
  test('draws a handle of type MEMORY for each connect, and gives none twice', async () => {
    await using server = createMemoryTransportServer();
    await using first = createMemoryTransportClient({ server });
    await using second = createMemoryTransportClient({ server });
    const drawn: unknown[] = [];

    server.on('connection', (...[peer, request, connectionHandle]) => {
      drawn.push([peer.address, request, connectionHandle]);
    });
    await server.start();
    await first.connect({});
    await second.connect({});
    await first.disconnect();
    await turn();
    // the same client again, from the same address: a rank of its own
    await first.connect({});

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
  });

  // spec 15.13
  test('closes each connection as it stops, and takes no connect after', async () => {
    await using server = createMemoryTransportServer();
    await using first = createMemoryTransportClient({ server });
    await using second = createMemoryTransportClient({ server });
    const closes: unknown[] = [];

    // before it listens, a connect fails before anything goes
    await expect(first.connect({})).rejects.toThrow(
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
    await first.connect({});
    await second.connect({ address: '198.51.100.1' });
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
    await expect(first.connect({})).rejects.toThrow(
      new ConnectError('the in-memory transport server is closed, not open')
    );
    expect([server.clients, first.isClosed()]).toEqual([[], true]);
  });

  // spec 15.13
  test('carries a transfer under its routers’ credit', async () => {
    // a payload of 64 KiB, in chunks of 1 KiB each way, under a window of 4 KiB
    const limits = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 4_096 };
    const payload = 'x'.repeat(65_536);
    await using server = createMemoryTransportServer();
    await using caller = createMemoryTransportClient({ server });
    using router = createRouterServer(server, { limits });
    using client = createRouterClient(caller, { limits });
    let crossed = 0;

    server.on('message', () => {
      crossed += 1;
    });
    createServiceManager(router).getRequestResolver(echo, { serializer: PAYLOAD_CODECS.text })(
      (request, response) => {
        return response(request.payload);
      }
    );
    await server.start();
    await caller.connect({});

    const echoed = await createServiceManager(client).getRequest(echo, {
      serializer: PAYLOAD_CODECS.text,
    })(payload)();

    expect(echoed).toBe(payload);
    // its request's chunks, more than 64 of them, and the credit its result's chunks were granted
    expect(crossed).toBeGreaterThan(64);
    expect(router.gauges().counts).toMatchObject({ receivingTransfers: 0, sendingTransfers: 0 });
  });
});
