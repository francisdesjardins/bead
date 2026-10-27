// dependencies

import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { FailureError } from '../../../router/server/router-server';
import { createRouterServer } from '../../../router/server/router-server';
import { CredentialScheme, ProtocolCode } from '../../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IProcedure } from '../../../router/shared/types';
import { encodeParcel, ParcelKind, readParcel, writeParcel } from '../../shared/broker-parcel';
import { createBrokerParticipant } from '../../shared/broker-participant';
import { ProgrammerError } from '../../shared/errors';
import { createMemoryBroker } from '../../shared/memory-broker';
import type { BrokerTopic, IBrokerAdapter } from '../../shared/types';
import { createTestClock } from '../../shared/__tests__/fixtures';
import {
  ACCEPT_TIMEOUT,
  createBrokerTransportServer,
  MAXIMUM_UNSENT_BYTES,
} from '../broker-transport-server';
import type { TransportServerConnectionHandle } from '../types';

// constants

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 1,
};

// helpers

/** A turn of the event loop, past what the broker handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

// definition

test.describe('createBrokerTransportServer', () => {
  test('draws a handle of its adapter type for each connection at its third leg, and gives none twice', async () => {
    const clock = createTestClock(Date.UTC(2026, 9, 26));
    const broker = createMemoryBroker({ clock });
    const participant = createBrokerParticipant({
      adapter: broker.adapter({ id: 'server' }),
      clock,
    });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }), clock });
    const opened: TransportServerConnectionHandle[] = [];
    const halfOpen: number[] = [];

    server.on('connection', (...[peer, request, connectionHandle]) => {
      expect([peer.id, request]).toEqual(['ada', undefined]);
      opened.push(connectionHandle);
    });

    expect(await server.start()).toEqual({ address: 'server', port: 0 });

    const first = ada.transportClient();
    const second = ada.transportClient();

    // * none told before its client's first parcel naming both halves came
    const connecting = first.connect({ server: 'interop' });

    await Promise.resolve();
    halfOpen.push(server.gauges().counts['halfOpen'] ?? -1);
    await connecting;
    await turn();
    await second.connect({ server: 'interop' });
    await turn();

    expect(opened).toEqual([
      'type=BROKER;participant=ada;ordinal=1',
      'type=BROKER;participant=ada;ordinal=2',
    ]);
    expect(server.clients).toEqual([
      {
        address: 'ada',
        connectionHandle: 'type=BROKER;participant=ada;ordinal=1',
        lastActivity: undefined,
        port: 0,
        type: 'BROKER',
      },
      {
        address: 'ada',
        connectionHandle: 'type=BROKER;participant=ada;ordinal=2',
        lastActivity: undefined,
        port: 0,
        type: 'BROKER',
      },
    ]);

    // a connection closed and another drawn: its handle is a new one
    await first.disconnect();
    await turn();
    await first.connect({ server: 'interop' });
    await turn();

    expect(opened.at(-1)).toBe('type=BROKER;participant=ada;ordinal=3');
    expect(server.isSecure(opened.at(-1) ?? 'type=BROKER;participant=ada;ordinal=3')).toBe(true);
    expect(server.isSecure('type=BROKER;participant=nobody;ordinal=1')).toBe(false);
    expect(server.gauges().counts).toMatchObject({ connections: 2, halfOpen: 0, names: 1 });

    // one closed of its own, clean, and one it holds no more closed of nothing
    expect(await server.close('type=BROKER;participant=ada;ordinal=2')).toBe(true);
    await turn();
    expect([
      second.isClosed(),
      await server.close('type=BROKER;participant=ada;ordinal=2'),
    ]).toEqual([true, false]);

    // its stop closes each with 1001, its participant's link kept
    await server.stop();
    await turn();

    expect([first.isClosed(), participant.isLinked]).toEqual([true, true]);

    await Promise.all([participant.stop(), ada.stop()]);

    // its bounds held as it is built
    expect([ACCEPT_TIMEOUT, MAXIMUM_UNSENT_BYTES]).toEqual([30_000, 184_551_424]);

    for (const options of [
      { names: [] },
      { names: ['a.b'] },
      { acceptTimeout: Infinity, names: ['interop'] },
      { maximumConnections: 0, names: ['interop'] },
    ]) {
      expect(() => {
        return createBrokerTransportServer(participant, options);
      }, JSON.stringify(options)).toThrow(ProgrammerError);
    }

    const plain = createBrokerParticipant({
      adapter: broker.adapter({ capabilities: { will: true }, id: 'plain' }),
    });

    expect(() => {
      return plain.transportServer({ group: true, names: ['interop'] });
    }).toThrow(
      'a name served in a group needs an adapter that offers groups, and the adapter of plain does not'
    );
  });

  test('carries no credential toward its client, and its command presenting ELSEWHERE fails before it goes', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();

    using router = createRouterServer(server);
    using routerClient = createRouterClient(client);

    createServiceManager(routerClient).getRequestResolver(echo, {
      serializer: PAYLOAD_CODECS.text,
    })((request, response) => {
      return response(request.payload);
    });

    await server.start();
    await client.connect({ server: 'interop' });
    await turn();

    const [{ connectionHandle } = { connectionHandle: undefined }] = server.clients;

    expect(
      connectionHandle === undefined ? undefined : server.carriesCredential(connectionHandle)
    ).toBe(false);

    // * refused before it goes: no transport carries one toward its client
    const commanded = await router
      .request(new TextEncoder().encode('hi'), {
        options: {
          connectionHandle: connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1',
          credential: { carried: 'Bearer token', scheme: CredentialScheme.ELSEWHERE },
          timeout: 1_000,
        },
        procedure: echo,
      })
      .then(
        () => {
          return 'answered';
        },
        (reason: unknown) => {
          return reason instanceof FailureError ? reason.code : reason;
        }
      );

    expect(commanded).toBe(ProtocolCode.DESTINATION_UNREACHABLE);

    // one presenting none goes, and its client answers it
    const answered = await router.request(new TextEncoder().encode('hi'), {
      options: {
        connectionHandle: connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1',
        timeout: 1_000,
      },
      procedure: echo,
    });

    expect(new TextDecoder().decode(answered.payload)).toBe('hi');

    await client.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('refuses 400 malformed an OPEN whose id is empty or no token, and tells it', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const peer = broker.adapter({ id: 'peer' });
    const heard: [string, number | undefined, number | undefined][] = [];
    const refusals: [string | undefined, number, string][] = [];

    server.on('refusal', ({ address, reason, status }) => {
      refusals.push([address, status, reason]);
    });
    peer.on('message', ({ payload, settle, topic }) => {
      const read = readParcel(payload);

      heard.push(
        'parcel' in read
          ? [topic.join('/'), read.parcel.kind, read.parcel.status]
          : [topic.join('/'), undefined, undefined]
      );
      settle();
    });
    await peer.start();
    await peer.subscribe(['bead', 'i', '']);
    await peer.subscribe(['bead', 'i', 'a.b']);
    await server.start();

    // * each answered at the inbox it names, as its id
    for (const id of ['', 'a.b']) {
      await peer.publish({
        payload: encodeParcel({
          acceptor: new Uint8Array(8),
          bound: 65_536,
          id,
          incarnation: new Uint8Array(16),
          kind: ParcelKind.OPEN,
          opener: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1),
          sequence: 1,
        }),
        topic: ['bead', 's', 'interop'],
      });
    }

    await turn();

    expect(refusals).toEqual([
      ['', 400, 'malformed'],
      ['a.b', 400, 'malformed'],
    ]);
    expect(heard).toEqual([
      ['bead/i/', ParcelKind.REFUSE, 400],
      ['bead/i/a.b', ParcelKind.REFUSE, 400],
    ]);

    await participant.stop();
  });

  test('reports a half-open connection it lost of its own by its opener’s id, with no handle, telling no connection', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ maximumUnsentBytes: 1, names: ['interop'] });
    const peer = broker.adapter({ id: 'peer' });
    const heard: [number | undefined, number | undefined, number | undefined][] = [];
    const told: [string, string][] = [];

    server.on('error', ({ message }, connectionHandle) => {
      told.push([message, connectionHandle]);
    });
    server.on('connection', () => {
      told.push(['connection', '']);
    });
    peer.on('message', ({ payload, settle }) => {
      const read = readParcel(payload);

      heard.push(
        'parcel' in read
          ? [read.parcel.kind, read.parcel.sequence, read.parcel.code]
          : [undefined, undefined, undefined]
      );
      settle();
    });
    await peer.start();
    await peer.subscribe(['bead', 'i', 'peer']);
    await server.start();

    // * its ACCEPT would pass maximumUnsentBytes: the CLOSE that loses it goes alone
    await peer.publish({
      payload: writeParcel({
        acceptor: new Uint8Array(8),
        bound: 65_536,
        id: 'peer',
        incarnation: new Uint8Array(16),
        kind: ParcelKind.OPEN,
        opener: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1),
        sequence: 1,
      }),
      topic: ['bead', 's', 'interop'],
    });
    await turn();

    expect(heard).toEqual([[ParcelKind.CLOSE, 1, 4000]]);
    expect(told).toEqual([
      [
        'a half-open connection of peer is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 1 bytes',
        '',
      ],
    ]);
    expect(server.gauges().counts).toMatchObject({ connections: 0, halfOpen: 0 });

    await participant.stop();
  });

  test('reports what a listener of its events threw, with its connection’s handle, or none for a refusal', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ maximumConnections: 1, names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const first = ada.transportClient();
    const second = ada.transportClient();
    const told: [string, string][] = [];

    server.on('connection', () => {
      throw new Error('a connection listener threw');
    });
    server.on('refusal', () => {
      throw new Error('a refusal listener threw');
    });
    server.on('error', ({ message }, connectionHandle) => {
      told.push([message, connectionHandle]);
    });
    await server.start();
    await first.connect({ server: 'interop' });
    await turn();

    // * past maximumConnections: refused 503, its listener's throw reported with no handle
    const refused = await second.connect({ server: 'interop' }).catch((reason: unknown) => {
      return reason;
    });

    expect((refused as Error).cause).toMatchObject({ reason: 'busy', status: 503 });
    expect(told).toEqual([
      ['a connection listener threw', 'type=BROKER;participant=ada;ordinal=1'],
      ['a refusal listener threw', ''],
    ]);
    expect(first.isOpen()).toBe(true);

    await first.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('refuses to send what is no envelope, keeping the connection, and holds a connection secure as its application says where it says', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'], secure: false });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();

    await server.start();
    await client.connect({ server: 'interop' });
    await turn();

    const handle = server.clients[0]?.connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1';

    await expect(server.send({ data: 'text' }, handle)).rejects.toThrow(
      new ProgrammerError('a broker connection carries envelopes, as bytes')
    );

    // * both its legs in memory, secure; its application says its own is not, and its ACCEPT so
    expect([client.isOpen(), server.isSecure(handle), client.isSecure]).toEqual([
      true,
      false,
      false,
    ]);

    await client.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('starts once its broker holds each name it serves, fails its start on a name refused, and stops once it let each go', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'server' });
    // each SUBSCRIBE and UNSUBSCRIBE of a name answered when the test says, or refused
    const answers: { refuse: (error: Error) => void; settle: () => void; what: string }[] = [];
    const held = Object.assign(Object.create(adapter) as IBrokerAdapter, {
      subscribe: (topic: BrokerTopic, options?: Parameters<IBrokerAdapter['subscribe']>[1]) => {
        if (topic[1] !== 's') {
          return adapter.subscribe(topic, options);
        }

        return new Promise<void>((resolve, reject) => {
          answers.push({
            refuse: reject,
            settle: () => {
              void adapter.subscribe(topic, options).then(resolve);
            },
            what: `subscribe ${topic.join('/')}`,
          });
        });
      },
      unsubscribe: (topic: BrokerTopic) => {
        return new Promise<void>((resolve, reject) => {
          answers.push({
            refuse: reject,
            settle: () => {
              void adapter.unsubscribe(topic).then(resolve);
            },
            what: `unsubscribe ${topic.join('/')}`,
          });
        });
      },
    });
    const participant = createBrokerParticipant({ adapter: held });
    const server = participant.transportServer({ names: ['ada', 'bob'] });
    const reported: string[] = [];

    server.on('error', ({ message }) => {
      reported.push(message);
    });

    let isStarted = false;
    const starting = server.start().then(() => {
      isStarted = true;
    });

    await turn();
    expect(
      answers.map(({ what }) => {
        return what;
      })
    ).toEqual(['subscribe bead/s/ada', 'subscribe bead/s/bob']);
    answers[0]?.settle();
    await turn();

    // * the gauge counts a name from its SUBACK: one held, one asked
    expect([isStarted, server.gauges().counts['names']]).toEqual([false, 1]);
    answers[1]?.settle();
    await starting;
    expect(server.gauges().counts['names']).toBe(2);

    let isStopped = false;
    const stopping = server.stop().then(() => {
      isStopped = true;
    });

    await turn();

    // * to its UNSUBACK, each name let go at once
    const unsubscribing = answers.splice(0).filter(({ what }) => {
      return what.startsWith('unsubscribe');
    });

    expect(
      unsubscribing.map(({ what }) => {
        return what;
      })
    ).toEqual(['unsubscribe bead/s/ada', 'unsubscribe bead/s/bob']);
    expect([isStopped, server.gauges().counts['names']]).toEqual([false, 2]);
    unsubscribing[0]?.settle();
    await turn();
    expect([isStopped, server.gauges().counts['names']]).toEqual([false, 1]);

    // * one its broker refuses to let go is reported, and its stop settles all the same
    unsubscribing[1]?.refuse(new Error('its broker refused to let bead/s/bob go: 0x80'));
    await stopping;
    expect([server.gauges().counts['names'], reported]).toEqual([
      0,
      ['its broker refused to let bead/s/bob go: 0x80'],
    ]);
    await participant.stop();

    // a name its broker refuses fails the start, and is not held
    const other = createBrokerParticipant({
      adapter: Object.assign(Object.create(broker.adapter({ id: 'other' })) as IBrokerAdapter, {
        subscribe: (topic: BrokerTopic) => {
          return topic[1] === 's'
            ? Promise.reject(new Error('its broker refused the subscription to bead/s/carol: 0x87'))
            : Promise.resolve();
        },
      }),
    });
    const refused = other.transportServer({ names: ['carol'] });

    await expect(refused.start()).rejects.toThrow('0x87');
    expect(refused.gauges().counts['names']).toBe(0);
    await other.stop();
  });
});
