// dependencies

import { expect, test } from '@playwright/test';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import { readParcel } from '../../shared/broker-parcel';
import { createBrokerParticipant } from '../../shared/broker-participant';
import {
  CancelError,
  ConnectError,
  ProgrammerError,
  ReadyStateError,
  TimeoutError,
} from '../../shared/errors';
import { createMemoryBroker } from '../../shared/memory-broker';
import { createTestClock } from '../../shared/__tests__/fixtures';
import { BrokerRefusedError, CONNECT_DEFAULTS } from '../broker-transport-client';

// helpers

/** A turn of the event loop, past what the broker handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
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
});
