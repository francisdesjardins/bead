// dependencies

import { expect, test } from '@playwright/test';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import {
  type IParcel,
  ParcelFlag,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../../shared/broker-parcel';
import { createBrokerParticipant } from '../../shared/broker-participant';
import {
  CancelError,
  ConnectError,
  ProgrammerError,
  ReadyStateError,
  TimeoutError,
} from '../../shared/errors';
import {
  createMemoryBroker,
  type IMemoryBroker,
  type IMemoryBrokerAdapter,
} from '../../shared/memory-broker';
import type { BrokerTopic } from '../../shared/types';
import { createTestClock } from '../../shared/__tests__/fixtures';
import {
  BrokerRefusedError,
  CONNECT_DEFAULTS,
  createBrokerTransportClient,
} from '../broker-transport-client';

// constants

const INBOX: BrokerTopic = ['bead', 'i', 'ada'];
const HALF = Uint8Array.of(0xa1, 0, 0, 0, 0, 0, 0, 1);

// helpers

/** A turn of the event loop, past what the broker handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

/** A server of the test's own, `acceptor`, serving `interop`: what it read, in its order. */
const peerOf = async (
  broker: IMemoryBroker
): Promise<{ adapter: IMemoryBrokerAdapter; heard: IParcel[] }> => {
  const adapter = broker.adapter({ id: 'acceptor' });
  const heard: IParcel[] = [];

  adapter.on('message', ({ payload, settle }) => {
    const read = readParcel(payload);

    if ('parcel' in read) {
      heard.push(read.parcel);
    }

    settle();
  });
  await adapter.start();
  await adapter.subscribe(['bead', 'i', 'acceptor']);
  await adapter.subscribe(['bead', 's', 'interop']);

  return { adapter, heard };
};

/** The ACCEPT its server answers the OPEN of `opener` with, its own half {@link HALF}. */
const acceptOf = (opener: Uint8Array): Uint8Array => {
  return writeParcel({
    acceptor: HALF,
    bound: 65_536,
    flags: ParcelFlag.SECURE,
    id: 'acceptor',
    incarnation: new Uint8Array(16),
    kind: ParcelKind.ACCEPT,
    opener,
    sequence: 1,
  });
};

// definition

test.describe('createBrokerTransportClient', () => {
  test('reconnects through the name it serves, a pair drawn anew', async () => {
    const broker = createMemoryBroker();
    const one = createBrokerParticipant({ adapter: broker.adapter({ id: 'one' }) });
    const two = createBrokerParticipant({ adapter: broker.adapter({ id: 'two' }) });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const watcher = broker.adapter({ id: 'watcher' });
    const opens: string[] = [];
    const servers = [one, two].map((participant) => {
      return participant.transportServer({ group: true, names: ['interop'] });
    });
    const client = ada.transportClient();
    const heard: string[] = [];

    // * a member of the group alone sees each OPEN; the watcher, alone, sees every one
    await watcher.start();
    await watcher.subscribe(['bead', 's', 'interop']);
    watcher.on('message', ({ payload, settle }) => {
      const read = readParcel(payload);

      opens.push('parcel' in read ? hexadecimalOf(read.parcel.opener) : 'none');
      settle();
    });

    for (const server of servers) {
      server.on('connection', (...[, , connectionHandle]) => {
        heard.push(`${server.address} ${connectionHandle}`);
      });
      await server.start();
    }

    await client.connect({ server: 'interop' });
    await turn();
    await client.reconnect();
    await turn();

    // each attempt its own OPEN through the name, its half drawn anew, placed on the next member
    expect(opens).toHaveLength(2);
    expect(opens[0]).not.toBe(opens[1]);
    expect(heard).toEqual([
      'one type=BROKER;participant=ada;ordinal=1',
      'two type=BROKER;participant=ada;ordinal=1',
    ]);
    // the connection it replaced is reset, its server told
    expect(
      servers.map((server) => {
        return server.clients.length;
      })
    ).toEqual([0, 1]);
    expect([client.isOpen(), client.isSecure, client.socket?.id]).toEqual([true, true, 'two']);

    await client.disconnect();
    await Promise.all([one.stop(), two.stop(), ada.stop()]);
  });

  test('fails a connect refused, or past its time, or cancelled, and refuses what it cannot take', async () => {
    const clock = createTestClock();
    const broker = createMemoryBroker({ clock });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }), clock });
    const silent = broker.adapter({ id: 'silent' });
    const client = ada.transportClient();

    // nothing serves the name: its broker says so, and the connect fails at once, its refusal
    // the cause
    const nobody = await client.connect({ server: 'nobody' }).catch((reason: unknown) => {
      return reason;
    });

    expect(nobody).toBeInstanceOf(ConnectError);
    expect((nobody as ConnectError).cause).toBeInstanceOf(BrokerRefusedError);
    expect((nobody as ConnectError).cause).toMatchObject({
      reason: 'no-subscriber',
      status: undefined,
    });

    // one that serves it and never answers: past its time, then given up by its signal
    await silent.start();
    await silent.subscribe(['bead', 's', 'interop']);

    const timing = client
      .connect({ server: 'interop', timeout: 1_000 })
      .catch((reason: unknown) => {
        return reason;
      });

    await turn();
    await clock.tickAsync(1_000);

    expect(await timing).toBeInstanceOf(TimeoutError);
    expect(CONNECT_DEFAULTS.timeout).toBe(10_000);

    const controller = new AbortController();
    const cancelled = client
      .connect({ server: 'interop', signal: controller.signal })
      .catch((reason: unknown) => {
        return reason;
      });

    await turn();
    controller.abort();

    expect(await cancelled).toBeInstanceOf(CancelError);
    expect(client.isClosed()).toBe(true);

    // what it cannot take, refused before anything moves
    for (const server of ['', 'a.b', 'x'.repeat(65)]) {
      await expect(client.connect({ server })).rejects.toThrow(ProgrammerError);
    }

    await expect(client.send({ data: new Uint8Array(1) })).rejects.toThrow(ReadyStateError);
    await expect(client.disconnect()).rejects.toThrow(ReadyStateError);
    expect([client.carries('Bearer token'), client.carries(' padded')]).toEqual([true, false]);

    await ada.stop();
  });

  test('hands on an envelope its server sent as it accepted, once its connect opened', async () => {
    const broker = createMemoryBroker();
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const peer = await peerOf(broker);
    const client = ada.transportClient();
    const told: [boolean, string][] = [];

    client.on('message', ({ data }) => {
      told.push([client.isOpen(), hexadecimalOf(new Uint8Array(data as Uint8Array))]);
    });

    const connecting = client.connect({ server: 'interop' });

    await turn();

    const opener = peer.heard[0]?.opener ?? new Uint8Array(8);

    // * its ACCEPT and an envelope after it, published in one turn: the envelope comes before its
    // connect returned, and is told once it opened
    void peer.adapter.publish({ payload: acceptOf(opener), topic: INBOX });
    void peer.adapter.publish({
      payload: writeParcel({
        acceptor: HALF,
        carried: Uint8Array.of(0xa1, 0x16),
        kind: ParcelKind.DATA,
        opener,
        sequence: 2,
      }),
      topic: INBOX,
    });
    await connecting;
    await turn();

    expect(told).toEqual([[true, 'A1 16']]);

    await client.disconnect();
    await ada.stop();
  });

  test('fails a connect its server refused as malformed or closed as it opened, telling no close, and tells one once it opened', async () => {
    const broker = createMemoryBroker();
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const peer = await peerOf(broker);
    const client = ada.transportClient();
    const closes: [boolean, boolean][] = [];

    client.on('close', (wasClean, wasQuick) => {
      closes.push([wasClean, wasQuick]);
    });

    // refused 400: its refusal the cause, named as section 15.6 names it
    const refusing = client.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    await turn();
    await peer.adapter.publish({
      payload: writeParcel({
        acceptor: new Uint8Array(8),
        kind: ParcelKind.REFUSE,
        opener: peer.heard[0]?.opener ?? new Uint8Array(8),
        sequence: 1,
        status: 400,
      }),
      topic: INBOX,
    });

    const refused = await refusing;

    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).cause).toMatchObject({
      message: 'the server refused the connection: 400 malformed',
      reason: 'malformed',
      status: 400,
    });

    // * accepted, then closed in the same turn, before its connect returned: the connect fails,
    // and no close is told
    peer.heard.length = 0;

    const closing = client.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    await turn();

    const opener = peer.heard[0]?.opener ?? new Uint8Array(8);

    void peer.adapter.publish({ payload: acceptOf(opener), topic: INBOX });
    void peer.adapter.publish({
      payload: writeParcel({
        acceptor: HALF,
        code: 1000,
        kind: ParcelKind.CLOSE,
        opener,
        sequence: 2,
      }),
      topic: INBOX,
    });

    expect(await closing).toMatchObject({
      message: 'the server closed the connection as it opened',
      name: 'ConnectError',
    });
    expect([client.isClosed(), closes]).toEqual([true, []]);

    // once it opened, its server's close is told, unclean but for 1000
    peer.heard.length = 0;

    const opening = client.connect({ server: 'interop' });

    await turn();

    const opened = peer.heard[0]?.opener ?? new Uint8Array(8);

    await peer.adapter.publish({ payload: acceptOf(opened), topic: INBOX });
    await opening;
    await peer.adapter.publish({
      payload: writeParcel({
        acceptor: HALF,
        code: 1001,
        kind: ParcelKind.CLOSE,
        opener: opened,
        sequence: 2,
      }),
      topic: INBOX,
    });
    await turn();

    expect([client.isClosed(), closes]).toEqual([true, [[false, false]]]);

    await ada.stop();
  });

  test('refuses to send a credential no field carries or what is no envelope, keeping its connection, and closes it by a RESET where its disconnect is not clean', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();
    const closes: [boolean, string][] = [];

    server.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });
    await server.start();
    await client.connect({ server: 'interop' });
    await turn();

    await expect(client.send({ credential: ' padded', data: Uint8Array.of(0xa1) })).rejects.toThrow(
      new ProgrammerError(
        'a credential holds visible ASCII, spaces and tabs alone, none first or last'
      )
    );
    await expect(client.send({ data: 'text' })).rejects.toThrow(
      new ProgrammerError('a broker connection carries envelopes, as bytes')
    );

    expect(client.isOpen()).toBe(true);

    // * not clean: a RESET, its server told unclean
    await client.disconnect({ isClean: false });
    await turn();

    expect([client.isClosed(), closes]).toEqual([
      true,
      [[false, 'type=BROKER;participant=ada;ordinal=1']],
    ]);

    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('fails a connect under way once disposed, its link up or not yet', async () => {
    const broker = createMemoryBroker();
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const peer = await peerOf(broker);
    const disposed = {
      message: 'the transport client was disposed as it connected',
      name: 'ConnectError',
    };

    // * disposed before its link is up: no OPEN goes
    const early = ada.transportClient();
    const linking = early.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    await early[Symbol.asyncDispose]();

    expect(await linking).toMatchObject(disposed);

    await turn();

    expect(peer.heard).toEqual([]);

    // disposed as its OPEN awaits its answer
    const client = ada.transportClient();
    const connecting = client.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    await turn();

    expect(peer.heard).toHaveLength(1);

    await client[Symbol.asyncDispose]();

    expect(await connecting).toMatchObject(disposed);

    await ada.stop();
  });

  test('is refused as built over what is no participant of this package', () => {
    const participant = createBrokerParticipant({
      adapter: createMemoryBroker().adapter({ id: 'ada' }),
    });

    // * its face alone, without the port its transports reach it by
    expect(() => {
      return createBrokerTransportClient(
        Object.fromEntries(Object.entries(participant)) as unknown as typeof participant
      );
    }).toThrow(
      new ProgrammerError('a broker transport is built over a participant of this package')
    );
  });

  test('reports what a listener of its events threw, and tells the listeners after it', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();
    const told: number[] = [];
    const reported: string[] = [];

    client.on('message', () => {
      throw new Error('a message listener threw');
    });
    client.on('message', ({ data }) => {
      told.push((data as Uint8Array).length);
    });
    client.on('error', ({ message }) => {
      reported.push(message);
    });
    await server.start();
    await client.connect({ server: 'interop' });
    await turn();
    await server.send(
      { data: Uint8Array.of(0xa1, 0x16, 0x00, 0x02, 0, 0, 0, 1) },
      server.clients[0]?.connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1'
    );
    await turn();

    expect([reported, told, client.isOpen()]).toEqual([['a message listener threw'], [8], true]);

    await client.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('refuses a connect while one is under way, or one given up already', async () => {
    const broker = createMemoryBroker();
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const peer = await peerOf(broker);
    const client = ada.transportClient();

    // none held: not secure
    expect(client.isSecure).toBe(false);

    // given up already: refused, nothing sent
    await expect(
      client.connect({ server: 'interop', signal: AbortSignal.abort() })
    ).rejects.toThrow(CancelError);

    const connecting = client.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    // * one under way: a second is refused, and the first goes on
    await expect(client.connect({ server: 'interop' })).rejects.toThrow(
      new ProgrammerError('the transport client is already connecting')
    );
    await turn();

    expect(peer.heard).toHaveLength(1);

    await client[Symbol.asyncDispose]();
    await connecting;
    await ada.stop();
  });

  test('refuses a reconnection never connected, under way, while it connects, or given up already, and ends closed once its attempts run out', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const silent = broker.adapter({ id: 'silent' });
    const client = ada.transportClient();

    await silent.start();
    await silent.subscribe(['bead', 's', 'quiet']);
    await server.start();
    await expect(client.reconnect()).rejects.toThrow(
      new ProgrammerError('the transport client was never connected')
    );

    // a connect to a name nobody answers, given up once refused its reconnection
    const controller = new AbortController();
    const connecting = client
      .connect({ server: 'quiet', signal: controller.signal })
      .catch((reason: unknown) => {
        return reason;
      });

    await expect(client.reconnect()).rejects.toThrow(
      new ProgrammerError('the transport client cannot reconnect while connecting')
    );
    controller.abort();

    expect(await connecting).toBeInstanceOf(CancelError);

    // given up already: the open connection left alone
    await client.connect({ server: 'interop' });
    await expect(client.reconnect({ signal: AbortSignal.abort() })).rejects.toThrow(CancelError);
    expect(client.isOpen()).toBe(true);

    // * nothing serves the name any more: a reconnection under way refuses another, and ends
    // closed once its attempts run out
    await server.stop();
    await turn();

    const reconnecting = client
      .reconnect({ delay: 100, maxAttempts: 2 })
      .catch((reason: unknown) => {
        return reason;
      });

    await expect(client.reconnect()).rejects.toThrow(
      new ProgrammerError('the transport client is already reconnecting')
    );
    expect(await reconnecting).toMatchObject({
      message: 'attempt 2 reached',
      name: 'ReconnectError',
    });
    expect(client.isClosed()).toBe(true);

    await Promise.all([participant.stop(), ada.stop()]);
  });
});
