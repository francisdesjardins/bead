// dependencies

import { expect, test } from '@playwright/test';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import { type IParcel, ParcelFlag, ParcelKind, readParcel, writeParcel } from '../broker-parcel';
import { BROKER_DELIVERIES, createBrokerParticipant } from '../broker-participant';
import { ProgrammerError } from '../errors';
import {
  createMemoryBroker,
  type IMemoryBroker,
  type IMemoryBrokerAdapter,
  MEMORY_BROKER_FAULTS,
} from '../memory-broker';
import type { BrokerTopic, IBrokerAdapter } from '../types';

// interfaces

/** A peer of the test's own: an adapter, and the parcels it read, in their order. */
interface IPeer {
  readonly adapter: IMemoryBrokerAdapter;
  readonly heard: { parcel: IParcel | undefined; topic: string }[];
}

// constants

const NAME: BrokerTopic = ['bead', 's', 'interop'];
const INCARNATION = Uint8Array.from({ length: 16 }, (_, index) => {
  return 0xc0 + index;
});
const HALF = Uint8Array.of(0xa1, 0, 0, 0, 0, 0, 0, 1);

// helpers

/** Lets every turn the broker queued run, and the event loop past them. */
const settled = (): Promise<void> => {
  return new Promise(setImmediate);
};

/** A peer over `broker`, its inbox subscribed, and the name too when `isServing`. */
const peerOf = async (
  broker: IMemoryBroker,
  { id, isServing = false }: { id: string; isServing?: boolean }
): Promise<IPeer> => {
  const adapter = broker.adapter({ id });
  const heard: IPeer['heard'] = [];

  adapter.on('message', ({ payload, settle, topic }) => {
    const read = readParcel(payload);

    heard.push({ parcel: 'parcel' in read ? read.parcel : undefined, topic: topic.join('/') });
    settle();
  });
  await adapter.start();
  await adapter.subscribe(['bead', 'i', id]);

  if (isServing) {
    await adapter.subscribe(NAME);
  }

  return { adapter, heard };
};

/** An adapter that logs what its participant asks of it, in its order, as `adapter` does it. */
const loggedOf = (adapter: IBrokerAdapter, log: string[]): IBrokerAdapter => {
  const logged = Object.create(adapter) as IBrokerAdapter;

  return Object.assign(logged, {
    publish: (publication: Parameters<IBrokerAdapter['publish']>[0]) => {
      log.push(`publish ${publication.topic.join('/')}`);

      return adapter.publish(publication);
    },
    start: (options?: Parameters<IBrokerAdapter['start']>[0]) => {
      log.push(
        options?.will === undefined ? 'start' : `start, its will to ${options.will.topic.join('/')}`
      );

      return adapter.start(options);
    },
    subscribe: (topic: BrokerTopic, options?: Parameters<IBrokerAdapter['subscribe']>[1]) => {
      log.push(`subscribe ${topic.join('/')}`);

      return adapter.subscribe(topic, options);
    },
  });
};

/** The ACCEPT a peer answers an OPEN with, its own half `acceptor`. */
const acceptOf = (open: IParcel, { acceptor, id }: { acceptor: Uint8Array; id: string }) => {
  return writeParcel({
    acceptor,
    bound: 65_536,
    flags: ParcelFlag.SECURE,
    id,
    incarnation: INCARNATION,
    kind: ParcelKind.ACCEPT,
    opener: open.opener,
    sequence: 1,
  });
};

// definition

test.describe('broker participant', () => {
  test('subscribes its inbox before anything goes, takes its id from its adapter, and draws its incarnation and each half from a cryptographic source (spec 15.24)', async () => {
    const broker = createMemoryBroker();
    const log: string[] = [];
    const drawn: Uint8Array[] = [];
    const { crypto } = globalThis;
    const getRandomValues = crypto.getRandomValues.bind(crypto);

    Object.defineProperty(crypto, 'getRandomValues', {
      configurable: true,
      value: (array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
        const filled = getRandomValues(array);

        drawn.push(filled.slice());

        return filled;
      },
    });

    try {
      const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
      const participant = createBrokerParticipant({
        adapter: loggedOf(broker.adapter({ id: 'ada' }), log),
      });
      const client = participant.transportClient();

      expect(participant.id).toBe('ada');
      expect(participant.incarnation).toBeUndefined();

      const connecting = client.connect({ server: 'interop' });

      await settled();

      const open = peer.heard[0]?.parcel;

      expect(open?.kind).toBe(ParcelKind.OPEN);

      if (open !== undefined) {
        await peer.adapter.publish({
          payload: acceptOf(open, { acceptor: HALF, id: 'acceptor' }),
          topic: ['bead', 'i', 'ada'],
        });
      }

      await connecting;

      // * its link, its inbox, and then its first parcel: nothing goes before its inbox is held
      expect(log).toEqual([
        'start, its will to bead/d/ada',
        'subscribe bead/i/ada',
        'publish bead/s/interop',
        'subscribe bead/d/acceptor',
        'publish bead/i/acceptor',
      ]);

      // its incarnation and its half, each as its source drew them, the OPEN naming its id
      expect(participant.incarnation).toHaveLength(16);
      expect(
        drawn.map((bytes) => {
          return hexadecimalOf(bytes);
        })
      ).toEqual([
        hexadecimalOf(participant.incarnation ?? new Uint8Array()),
        hexadecimalOf(open?.opener ?? new Uint8Array()),
      ]);
      expect(open).toMatchObject({ id: 'ada', incarnation: participant.incarnation, sequence: 1 });

      await client.disconnect();
      await participant.stop();
    } finally {
      Reflect.deleteProperty(crypto, 'getRandomValues');
    }

    // an id that is no token is refused as it is built, whatever its broker takes
    expect(() => {
      return createBrokerParticipant({ adapter: broker.adapter({ id: 'a.b' }) });
    }).toThrow(ProgrammerError);
  });

  test('closes each connection as its link goes down, and connects anew as another incarnation, resetting its peers', async () => {
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const adapter = broker.adapter({ id: 'ada' });
    const participant = createBrokerParticipant({ adapter, reconnect: { delay: 0 } });
    const client = participant.transportClient();
    const closes: boolean[] = [];

    client.on('close', (wasClean) => {
      closes.push(wasClean);
    });

    const connecting = client.connect({ server: 'interop' });

    await settled();

    const open = peer.heard[0]?.parcel;

    if (open !== undefined) {
      await peer.adapter.publish({
        payload: acceptOf(open, { acceptor: HALF, id: 'acceptor' }),
        topic: ['bead', 'i', 'ada'],
      });
    }

    await connecting;
    await settled();

    const former = participant.incarnation;
    // a connect its link goes down under, its OPEN unanswered
    const pending = participant
      .transportClient()
      .connect({ server: 'interop' })
      .catch((reason: unknown) => {
        return reason;
      });

    await settled();
    peer.heard.length = 0;
    adapter.lose();
    await settled();
    await settled();

    expect(await pending).toMatchObject({
      message: 'the link of ada went down as it connected',
      name: 'ConnectError',
    });

    // * its connection told closed, unclean, as a dropped socket's; its link connected anew
    expect(closes).toEqual([false]);
    expect(client.isClosed()).toBe(true);
    expect(participant.isLinked).toBe(true);
    expect(participant.incarnation).toHaveLength(16);
    expect(hexadecimalOf(participant.incarnation ?? new Uint8Array())).not.toBe(
      hexadecimalOf(former ?? new Uint8Array())
    );

    // its will went as its link was lost, then a RESET of the pair it held, once its inbox is held
    expect(
      peer.heard.map(({ parcel, topic }) => {
        return [topic, parcel?.kind, parcel?.sequence];
      })
    ).toEqual([['bead/i/acceptor', ParcelKind.RESET, 0]]);
    expect(peer.heard[0]?.parcel).toMatchObject({ acceptor: HALF, opener: open?.opener });

    await participant.stop();

    // without a reconnection, a link lost stays down, and says so
    const lone = broker.adapter({ id: 'bob' });
    const alone = createBrokerParticipant({ adapter: lone, reconnect: false });
    const reported: string[] = [];

    alone.on('error', ({ message }) => {
      reported.push(message);
    });
    await alone.start();
    lone.lose();
    await settled();

    expect([alone.isLinked, reported]).toEqual([false, ['the link of bob went down']]);
  });

  test('closes each connection bound to the incarnation a GONE names, and none bound to another', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const transport = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const bob = createBrokerParticipant({ adapter: broker.adapter({ id: 'bob' }) });
    const tester = await peerOf(broker, { id: 'tester' });
    const closes: [boolean, string][] = [];

    transport.on('close', (wasClean, connectionHandle) => {
      closes.push([wasClean, connectionHandle]);
    });
    await transport.start();

    const adaClient = ada.transportClient();
    const bobClient = bob.transportClient();

    await adaClient.connect({ server: 'interop' });
    await bobClient.connect({ server: 'interop' });
    await settled();

    const goneOf = (incarnation: Uint8Array): Uint8Array => {
      return writeParcel({
        acceptor: new Uint8Array(8),
        id: 'ada',
        incarnation,
        kind: ParcelKind.GONE,
        opener: new Uint8Array(8),
        sequence: 0,
      });
    };

    expect(transport.gauges().counts['departures']).toBe(2);

    // a GONE of another incarnation of ada's closes none
    await tester.adapter.publish({ payload: goneOf(INCARNATION), topic: ['bead', 'd', 'ada'] });
    await settled();

    expect(closes).toEqual([]);

    // * one of its incarnation closes ada's connection, unclean, and bob's stays
    await tester.adapter.publish({
      payload: goneOf(ada.incarnation ?? new Uint8Array()),
      topic: ['bead', 'd', 'ada'],
    });
    await settled();

    expect(closes).toEqual([[false, 'type=BROKER;participant=ada;ordinal=1']]);
    expect(
      transport.clients.map(({ address }) => {
        return address;
      })
    ).toEqual(['bob']);
    expect(transport.gauges().counts['departures']).toBe(1);

    await bobClient.disconnect();
    await adaClient[Symbol.asyncDispose]();
    await Promise.all([participant.stop(), ada.stop(), bob.stop()]);
  });

  test('acknowledges a message once taken or dropped as a copy, never after its router is done with it', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'server' });
    const participant = createBrokerParticipant({ adapter });
    const transport = participant.transportServer({ names: ['interop'] });
    const peer = await peerOf(broker, { id: 'peer' });
    const unsettledAtMessage: number[] = [];

    // * a router that never gets done with what it was handed
    transport.on('message', () => {
      unsettledAtMessage.push(adapter.unsettled);
    });
    await transport.start();
    await peer.adapter.publish({
      payload: writeParcel({
        acceptor: new Uint8Array(8),
        bound: 65_536,
        flags: ParcelFlag.SECURE,
        id: 'peer',
        incarnation: INCARNATION,
        kind: ParcelKind.OPEN,
        opener: HALF,
        sequence: 1,
      }),
      topic: NAME,
    });
    await settled();

    const acceptor = peer.heard[0]?.parcel?.acceptor ?? new Uint8Array(8);
    const pair = { acceptor, opener: HALF };

    await peer.adapter.publish({
      payload: writeParcel({ ...pair, kind: ParcelKind.PING, sequence: 2 }),
      topic: ['bead', 'i', 'server'],
    });

    const data = writeParcel({
      ...pair,
      carried: Uint8Array.of(0xa1, 0x16, 0x00, 0x02, 0, 0, 0, 1),
      kind: ParcelKind.DATA,
      sequence: 3,
    });

    // a message and its copy, handed in one turn
    broker.fault(MEMORY_BROKER_FAULTS.COPY);
    await peer.adapter.publish({ payload: data, topic: ['bead', 'i', 'server'] });
    await settled();

    // * handed on once, while its message was still unacknowledged; it and its copy acknowledged since
    expect(unsettledAtMessage).toEqual([1]);
    expect(adapter.unsettled).toBe(0);

    // a message that is no parcel, and a retained one, are acknowledged too
    await peer.adapter.publish({ payload: Uint8Array.of(0xb1), topic: ['bead', 'i', 'server'] });
    await peer.adapter.publish({ payload: data, retained: true, topic: ['bead', 'i', 'server'] });
    await settled();

    expect(adapter.unsettled).toBe(0);

    await participant.stop();
  });

  test('is refused as built when its application requires delivery at least once of an adapter that gives it at most once', () => {
    const broker = createMemoryBroker({ delivery: BROKER_DELIVERIES.AT_MOST_ONCE });

    expect(() => {
      return createBrokerParticipant({
        adapter: broker.adapter({ id: 'ada' }),
        requireDelivery: BROKER_DELIVERIES.AT_LEAST_ONCE,
      });
    }).toThrow(
      new ProgrammerError(
        'its application requires delivery at least once, and the adapter of ada gives it at most once'
      )
    );

    // what it does not require, it is built over
    expect(
      createBrokerParticipant({ adapter: broker.adapter({ id: 'bob' }) }).adapter.delivery
    ).toBe(BROKER_DELIVERIES.AT_MOST_ONCE);
    expect(
      createBrokerParticipant({
        adapter: createMemoryBroker().adapter({ id: 'carol' }),
        requireDelivery: BROKER_DELIVERIES.AT_LEAST_ONCE,
      }).adapter.delivery
    ).toBe(BROKER_DELIVERIES.AT_LEAST_ONCE);
  });
});
