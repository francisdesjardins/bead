// dependencies

import { expect, test } from '@playwright/test';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import {
  encodeParcel,
  type IParcel,
  ParcelFlag,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../broker-parcel';
import { BROKER_DELIVERIES, createBrokerParticipant } from '../broker-participant';
import { ProgrammerError } from '../errors';
import {
  createMemoryBroker,
  type IMemoryBroker,
  type IMemoryBrokerAdapter,
  MEMORY_BROKER_FAULTS,
} from '../memory-broker';
import type { BrokerTopic, IBrokerAdapter } from '../types';
import { createTestClock } from './fixtures';

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

/** The ACCEPT a peer answers an OPEN with, its own half `acceptor`, its bound 65,536 unless told. */
const acceptOf = (
  open: IParcel,
  { acceptor, bound = 65_536, id }: { acceptor: Uint8Array; bound?: number; id: string }
) => {
  return writeParcel({
    acceptor,
    bound,
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
    // ! no will: what its peer hears is the RESET it sends once linked again
    const adapter = broker.adapter({
      capabilities: { groups: true, noSubscriber: true },
      id: 'ada',
    });
    const participant = createBrokerParticipant({ adapter, reconnect: { delay: 0 } });
    const client = participant.transportClient();
    const closes: [boolean, boolean][] = [];

    client.on('close', (wasClean, wasQuick) => {
      closes.push([wasClean, wasQuick]);
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

    // * its connection told closed, unclean and not quick, as a dropped socket's; its link connected
    // anew
    expect(closes).toEqual([[false, false]]);
    expect(client.isClosed()).toBe(true);
    expect(participant.isLinked).toBe(true);
    expect(participant.incarnation).toHaveLength(16);
    expect(hexadecimalOf(participant.incarnation ?? new Uint8Array())).not.toBe(
      hexadecimalOf(former ?? new Uint8Array())
    );

    // a RESET of the pair it held, once its inbox is held again
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

  test('a parcel that would pass maximumUnsentBytes loses its connection with a CLOSE of 4000 whose sequence is the next, reported naming the bound', async () => {
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = participant.transportClient({ maximumUnsentBytes: 2_048 });
    const reported: string[] = [];

    client.on('error', ({ message }) => {
      reported.push(message);
    });

    const connecting = client.connect({ server: 'interop' });

    await settled();

    const open = peer.heard[0]?.parcel;

    if (open !== undefined) {
      await peer.adapter.publish({
        payload: acceptOf(open, { acceptor: HALF, bound: 1_024, id: 'acceptor' }),
        topic: ['bead', 'i', 'ada'],
      });
    }

    await connecting;
    await settled();

    // its third leg's PING, the second of its sequence
    expect(peer.heard.at(-1)?.parcel).toMatchObject({ kind: ParcelKind.PING, sequence: 2 });
    peer.heard.length = 0;

    // * an envelope in three parts of 1,024, 1,024 and 536 bytes, sent at once: each part held to
    // the bound, the third would pass it and goes not, and the CLOSE that loses the connection
    // takes its sequence, the next
    await client.send({ data: new Uint8Array(2_500) });
    await settled();

    expect(
      peer.heard.map(({ parcel }) => {
        return [parcel?.kind, parcel?.sequence, parcel?.code];
      })
    ).toEqual([
      [ParcelKind.DATA, 3, undefined],
      [ParcelKind.DATA, 4, undefined],
      [ParcelKind.CLOSE, 5, 4000],
    ]);
    expect(reported).toEqual([
      'the connection to acceptor is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 2048 bytes',
    ]);

    await participant.stop();
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

  test('is refused as built over an adapter whose inbox takes a parcel under 1,024 bytes', () => {
    const narrow = createMemoryBroker({ maximumMessageBytes: 1_023 }).adapter({ id: 'ada' });

    expect(() => {
      return createBrokerParticipant({ adapter: narrow });
    }).toThrow(
      new ProgrammerError(
        "a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of ada takes 1023"
      )
    );
    expect(
      createBrokerParticipant({
        adapter: createMemoryBroker({ maximumMessageBytes: 1_024 }).adapter({ id: 'ada' }),
      }).id
    ).toBe('ada');
  });

  test('is refused as built with a minimumBodyBytesPerSecond of 0, as an HTTP server is', () => {
    const adapter = createMemoryBroker().adapter({ id: 'ada' });

    expect(() => {
      return createBrokerParticipant({ adapter, minimumBodyBytesPerSecond: 0 });
    }).toThrow(new ProgrammerError('minimumBodyBytesPerSecond is a whole number above 0, not 0'));
    expect(createBrokerParticipant({ adapter, minimumBodyBytesPerSecond: 1 }).id).toBe('ada');
  });

  test('refuses a server transport a name another of its server transports serves', () => {
    const participant = createBrokerParticipant({
      adapter: createMemoryBroker().adapter({ id: 'server' }),
    });

    participant.transportServer({ names: ['interop', 'echo'] });
    expect(() => {
      return participant.transportServer({ names: ['other', 'echo'] });
    }).toThrow(
      new ProgrammerError(
        'the name echo is served already by a server transport of this participant'
      )
    );

    // the one refused holds none of its names
    expect(participant.transportServer({ names: ['other'] })).toBeDefined();
  });

  test('a parcel that does not read closes its connection with 1002 at once, but a kind to come, which is taken in its order', async () => {
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = participant.transportClient();
    const reported: string[] = [];

    client.on('error', ({ message }) => {
      reported.push(message);
    });

    const connecting = client.connect({ server: 'interop' });

    await settled();

    const opener = peer.heard[0]?.parcel?.opener ?? new Uint8Array(8);

    await peer.adapter.publish({
      payload: acceptOf({ opener } as IParcel, { acceptor: HALF, id: 'acceptor' }),
      topic: ['bead', 'i', 'ada'],
    });
    await connecting;
    await settled();
    peer.heard.length = 0;

    // * a kind to come below the next awaited is a copy, dropped in silence
    await peer.adapter.publish({
      payload: encodeParcel({ acceptor: HALF, kind: 0x0a, opener, sequence: 1 }),
      topic: ['bead', 'i', 'ada'],
    });
    await settled();
    expect([client.isOpen(), peer.heard, reported]).toEqual([true, [], []]);

    // any other that does not read closes at once, whatever its sequence, a copy's among them
    const kept = encodeParcel({ acceptor: HALF, kind: ParcelKind.PING, opener, sequence: 1 });

    kept[3] = 1;
    await peer.adapter.publish({ payload: kept, topic: ['bead', 'i', 'ada'] });
    await settled();

    expect(
      peer.heard.map(({ parcel }) => {
        return [parcel?.kind, parcel?.sequence, parcel?.code];
      })
    ).toEqual([[ParcelKind.CLOSE, 3, 1002]]);
    expect(reported).toEqual([
      'the connection to acceptor is closed with 1002: a parcel that does not read: a kept byte that is not 0',
    ]);

    await participant.stop();
  });

  test('refuses a send whose room fits no part and keeps the connection, on the client and the server alike', async () => {
    const broker = createMemoryBroker();
    // an adapter whose broker publishes 28 bytes at most to a peer's inbox: a prefix, and no more
    const narrowOf = (id: string): IBrokerAdapter => {
      return Object.assign(Object.create(broker.adapter({ id })) as IBrokerAdapter, {
        maximumPayloadBytes: () => {
          return 28;
        },
      });
    };
    const serving = createBrokerParticipant({ adapter: narrowOf('server') });
    const server = serving.transportServer({ names: ['interop'] });
    const connecting = createBrokerParticipant({ adapter: narrowOf('ada') });
    const client = connecting.transportClient();
    const refusal = 'a parcel of 28 bytes leaves no byte of an envelope beside its credential';

    await server.start();
    await client.connect({ server: 'interop' });
    await settled();

    const [{ connectionHandle } = { connectionHandle: undefined }] = server.clients;

    await expect(client.send({ data: new Uint8Array(1) })).rejects.toThrow(refusal);
    await expect(
      server.send(
        { data: new Uint8Array(1) },
        connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1'
      )
    ).rejects.toThrow(refusal);
    await settled();

    expect([client.isOpen(), server.gauges().counts['connections']]).toEqual([true, 1]);

    await connecting.stop();
    await serving.stop();
  });

  test('holds a connection secure only while both its legs are', async () => {
    for (const insecure of ['ada', 'server']) {
      const broker = createMemoryBroker();
      const adapterOf = (id: string): IBrokerAdapter => {
        const adapter = broker.adapter({ id });

        return id === insecure
          ? Object.assign(Object.create(adapter) as IBrokerAdapter, { isSecure: false })
          : adapter;
      };
      const serving = createBrokerParticipant({ adapter: adapterOf('server') });
      // its application saying its own leg secure changes nothing of its peer's
      const server = serving.transportServer({
        names: ['interop'],
        ...(insecure === 'ada' ? { secure: true } : {}),
      });
      const connecting = createBrokerParticipant({ adapter: adapterOf('ada') });
      const client = connecting.transportClient();

      await server.start();
      await client.connect({ server: 'interop' });
      await settled();

      const handle = server.clients[0]?.connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1';

      // * one leg not secure, as its OPEN or its ACCEPT says: neither end holds it secure
      expect([client.isOpen(), client.isSecure, server.isSecure(handle)], insecure).toEqual([
        true,
        false,
        false,
      ]);

      await connecting.stop();
      await serving.stop();
    }
  });

  test('starts anew once a start failed', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const participant = createBrokerParticipant({ adapter });

    // its broker holds a link of its id already: its first start is refused
    await adapter.start();
    await expect(participant.start()).rejects.toThrow('the link of ada is up already');
    await adapter.stop();

    // * the next starts another
    await participant.start();

    expect(participant.isLinked).toBe(true);

    await participant.stop();
  });

  test('counts its connections, half-open among them, what they hold in parts and what waits for its broker, by the same keys on its own face and its server transport’s', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({
      adapter: broker.adapter({ id: 'server' }),
      heldBytesBudget: 4_096,
      maximumEnvelopePartsBytes: 2_048,
    });
    const server = participant.transportServer({
      maximumConnections: 8,
      maximumUnsentBytes: 65_536,
      names: ['interop'],
    });
    const peer = await peerOf(broker, { id: 'peer' });
    const inbox: BrokerTopic = ['bead', 'i', 'server'];

    await server.start();
    await peer.adapter.publish({
      payload: writeParcel({
        acceptor: new Uint8Array(8),
        bound: 65_536,
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
    const none = {
      departures: 0,
      largestPartsBytes: 0,
      largestUnsentBytes: 0,
      partsBytes: 0,
      unsentBytes: 0,
    };

    // half-open, its third leg awaited
    expect(participant.gauges().counts).toEqual({ ...none, connections: 0, halfOpen: 1 });

    // * open, and 100 bytes of an envelope held in parts
    await peer.adapter.publish({
      payload: writeParcel({ acceptor, kind: ParcelKind.PING, opener: HALF, sequence: 2 }),
      topic: inbox,
    });
    await peer.adapter.publish({
      payload: writeParcel({
        acceptor,
        carried: new Uint8Array(100),
        flags: ParcelFlag.MORE,
        kind: ParcelKind.DATA,
        opener: HALF,
        sequence: 3,
      }),
      topic: inbox,
    });
    await settled();

    const held = {
      ...none,
      connections: 1,
      departures: 1,
      halfOpen: 0,
      largestPartsBytes: 100,
      partsBytes: 100,
    };

    expect(participant.gauges().counts).toEqual(held);
    expect(server.gauges().counts).toEqual({ ...held, names: 1 });
    expect(participant.gauges().ceilings).toEqual({ largestPartsBytes: 2_048, partsBytes: 4_096 });
    expect(server.gauges().ceilings).toEqual({
      connections: 8,
      halfOpen: 8,
      largestPartsBytes: 2_048,
      largestUnsentBytes: 65_536,
      partsBytes: 4_096,
    });

    await participant.stop();
  });

  test('is refused as built with a root that is no token, and names each topic by the root it is given', async () => {
    const broker = createMemoryBroker();
    const log: string[] = [];

    expect(() => {
      return createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }), root: 'a.b' });
    }).toThrow(
      new ProgrammerError(
        `a participant's root is a token of base64url's alphabet, 1 to 64 characters, not "a.b"`
      )
    );

    const participant = createBrokerParticipant({
      adapter: loggedOf(broker.adapter({ id: 'bob' }), log),
      root: 'deploy',
    });

    await participant.start();

    expect([participant.root, log]).toEqual([
      'deploy',
      ['start, its will to deploy/d/bob', 'subscribe deploy/i/bob'],
    ]);

    await participant.stop();
  });

  test('lets a listener go, fails a connect awaiting its answer as it stops, refuses a start once stopped, and stops once', async () => {
    const broker = createMemoryBroker();
    const silent = await peerOf(broker, { id: 'silent', isServing: true });
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const reported: string[] = [];
    const listener = ({ message }: Error): void => {
      reported.push(message);
    };

    participant.on('error', listener);

    // a connect whose OPEN reached a name nobody answers
    const pending = participant
      .transportClient()
      .connect({ server: 'interop' })
      .catch((reason: unknown) => {
        return reason;
      });

    await settled();

    // a listener let go of hears no more
    await silent.adapter.publish({ payload: Uint8Array.of(0xb1), topic: ['bead', 'i', 'ada'] });
    await settled();
    participant.off('error', listener);
    await silent.adapter.publish({ payload: Uint8Array.of(0xb1), topic: ['bead', 'i', 'ada'] });
    await settled();

    expect(
      silent.heard.map(({ parcel }) => {
        return parcel?.kind;
      })
    ).toEqual([ParcelKind.OPEN]);
    expect(participant.gauges().counts).toMatchObject({ connections: 0, departures: 0 });

    await participant.stop();

    // * the connect fails as its participant stops; a start since is refused, a second stop does nothing
    expect(await pending).toMatchObject({
      message: 'the participant ada stopped as it connected',
      name: 'ConnectError',
    });
    await expect(participant.start()).rejects.toThrow('the participant ada is stopped');
    await expect(participant.transportClient().connect({ server: 'interop' })).rejects.toThrow(
      'the participant ada is stopped'
    );
    await participant[Symbol.asyncDispose]();

    expect([participant.isLinked, reported]).toEqual([
      false,
      ["a message to the inbox of ada is no parcel: 1 bytes, under a parcel's 28"],
    ]);
  });

  test('closes a connection with 1002 for a parcel of a layout to come, an ACCEPT on it open, or another kind between an envelope’s parts, and with 4000 at a gap a kind to come leaves', async () => {
    const opened = { acceptor: HALF, sequence: 2 };
    const part = {
      ...opened,
      carried: Uint8Array.of(0xa1),
      flags: ParcelFlag.MORE,
      kind: ParcelKind.DATA,
    };
    const cases: {
      code: number;
      parcels: (opener: Uint8Array) => Uint8Array[];
      reason: string;
    }[] = [
      {
        code: 1002,
        parcels: (opener) => {
          return [encodeParcel({ ...opened, kind: ParcelKind.PING, layout: 0xb2, opener })];
        },
        reason: 'a parcel of a layout to come, 0xB2',
      },
      {
        code: 1002,
        parcels: (opener) => {
          return [
            writeParcel({
              ...opened,
              bound: 65_536,
              id: 'acceptor',
              incarnation: INCARNATION,
              kind: ParcelKind.ACCEPT,
              opener,
            }),
          ];
        },
        reason: 'an ACCEPT on a connection open',
      },
      {
        code: 1002,
        parcels: (opener) => {
          return [
            writeParcel({ ...part, opener }),
            writeParcel({ acceptor: HALF, answers: 2, kind: ParcelKind.PONG, opener, sequence: 3 }),
          ];
        },
        reason: "a PONG between an envelope's parts",
      },
      {
        code: 1002,
        parcels: (opener) => {
          return [
            writeParcel({ ...part, opener }),
            writeParcel({
              acceptor: HALF,
              code: 1000,
              kind: ParcelKind.CLOSE,
              opener,
              sequence: 3,
            }),
          ];
        },
        reason: "a CLOSE between an envelope's parts",
      },
      {
        code: 4000,
        parcels: (opener) => {
          return [encodeParcel({ acceptor: HALF, kind: 0x0a, opener, sequence: 5 })];
        },
        reason: 'a parcel lost: 2 was awaited, and 5 came',
      },
    ];

    for (const { code, parcels, reason } of cases) {
      const broker = createMemoryBroker();
      const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
      const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
      const client = participant.transportClient();
      const reported: string[] = [];
      const closes: boolean[] = [];

      client.on('error', ({ message }) => {
        reported.push(message);
      });
      client.on('close', (wasClean) => {
        closes.push(wasClean);
      });

      const connecting = client.connect({ server: 'interop' });

      await settled();

      const opener = peer.heard[0]?.parcel?.opener ?? new Uint8Array(8);

      await peer.adapter.publish({
        payload: acceptOf({ opener } as IParcel, { acceptor: HALF, id: 'acceptor' }),
        topic: ['bead', 'i', 'ada'],
      });
      await connecting;
      await settled();
      peer.heard.length = 0;

      for (const payload of parcels(opener)) {
        await peer.adapter.publish({ payload, topic: ['bead', 'i', 'ada'] });
      }

      await settled();

      // * its CLOSE the next of its sequence, after its OPEN and its third leg; reported, unclean
      expect(
        peer.heard.map(({ parcel }) => {
          return [parcel?.kind, parcel?.sequence, parcel?.code];
        }),
        reason
      ).toEqual([[ParcelKind.CLOSE, 3, code]]);
      expect([reported, closes], reason).toEqual([
        [`the connection to acceptor is closed with ${String(code)}: ${reason}`],
        [false],
      ]);

      await participant.stop();
    }
  });

  test('ends a connection unclean, reporting nothing, once its broker refuses a parcel to its peer’s inbox or says no subscriber takes it', async () => {
    for (const isRefused of [false, true]) {
      const broker = createMemoryBroker();
      const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
      const adapter = broker.adapter({ id: 'ada' });
      const participant = createBrokerParticipant({ adapter });
      const client = participant.transportClient();
      const reported: string[] = [];
      const closes: boolean[] = [];

      client.on('error', ({ message }) => {
        reported.push(message);
      });
      client.on('close', (wasClean) => {
        closes.push(wasClean);
      });

      const connecting = client.connect({ server: 'interop' });

      await settled();
      await peer.adapter.publish({
        payload: acceptOf(peer.heard[0]?.parcel ?? ({ opener: new Uint8Array(8) } as IParcel), {
          acceptor: HALF,
          id: 'acceptor',
        }),
        topic: ['bead', 'i', 'ada'],
      });
      await connecting;
      await settled();

      // * its own link refused by its broker under it, or its peer's inbox gone, as a dropped
      // socket's peer
      await (isRefused ? adapter.stop() : peer.adapter.stop());
      await client.send({ data: Uint8Array.of(0xa1, 0x16, 0x00, 0x02, 0, 0, 0, 1) });
      await settled();

      expect([client.isClosed(), closes, reported], String(isRefused)).toEqual([true, [false], []]);

      await participant.stop();
    }
  });

  test('keeps a connection whose parts come at their rate past the grace, and hands their envelope on whole', async () => {
    const clock = createTestClock();
    const broker = createMemoryBroker({ clock });
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }), clock });
    const client = participant.transportClient();
    const told: number[] = [];
    const closes: boolean[] = [];

    client.on('message', ({ data }) => {
      told.push((data as Uint8Array).length);
    });
    client.on('close', (wasClean) => {
      closes.push(wasClean);
    });

    const connecting = client.connect({ server: 'interop' });

    await settled();

    const opener = peer.heard[0]?.parcel?.opener ?? new Uint8Array(8);
    const partOf = (
      sequence: number,
      { isLast = false, length }: { isLast?: boolean; length: number }
    ): Uint8Array => {
      return writeParcel({
        acceptor: HALF,
        carried: new Uint8Array(length),
        flags: isLast ? 0 : ParcelFlag.MORE,
        kind: ParcelKind.DATA,
        opener,
        sequence,
      });
    };

    await peer.adapter.publish({
      payload: acceptOf({ opener } as IParcel, { acceptor: HALF, id: 'acceptor' }),
      topic: ['bead', 'i', 'ada'],
    });
    await connecting;
    await settled();

    // * 2,600 bytes by the grace's end, owed by 10,833 ms at 240 bytes a second: not late, held on
    await peer.adapter.publish({
      payload: partOf(2, { length: 1_300 }),
      topic: ['bead', 'i', 'ada'],
    });
    await settled();
    await clock.tickAsync(4_000);
    await peer.adapter.publish({
      payload: partOf(3, { length: 1_300 }),
      topic: ['bead', 'i', 'ada'],
    });
    await settled();
    await clock.tickAsync(1_000);
    await peer.adapter.publish({
      payload: partOf(4, { isLast: true, length: 1 }),
      topic: ['bead', 'i', 'ada'],
    });
    await settled();

    expect([told, closes, client.isOpen()]).toEqual([[2_601], [], true]);

    await participant.stop();
  });

  test('fails a link that goes down as it connects, at its start or as it links anew, and fences it where another link of its id took it over then (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    // * its inbox's SUBSCRIBE held until the test grants it, as a SUBACK that came before its
    // link's loss was read
    const grants: (() => void)[] = [];
    const granting = Object.assign(Object.create(adapter) as IBrokerAdapter, {
      subscribe: (topic: BrokerTopic, options?: Parameters<IBrokerAdapter['subscribe']>[1]) => {
        if (topic[1] !== 'i') {
          return adapter.subscribe(topic, options);
        }

        return new Promise<void>((resolve, reject) => {
          grants.push(() => {
            if (adapter.isLinked) {
              adapter.subscribe(topic, options).then(resolve, reject);
            } else {
              resolve();
            }
          });
        });
      },
    });
    const participant = createBrokerParticipant({
      adapter: granting,
      reconnect: { delay: 0, maxAttempts: 5 },
    });
    const reported: string[] = [];
    const asked = async (): Promise<void> => {
      for (let count = 0; count < 100 && grants.length === 0; count += 1) {
        await settled();
      }
    };

    participant.on('error', ({ message }) => {
      reported.push(message);
    });

    // a loss as it subscribes its inbox fails its start, though its SUBACK came
    const starting = participant.start();

    await asked();
    adapter.lose();
    await settled();
    grants.shift()?.();
    await expect(starting).rejects.toThrow('the link of ada went down as it connected');
    expect([participant.isLinked, reported]).toEqual([false, []]);

    // * the next start links anew
    const again = participant.start();

    await asked();
    grants.shift()?.();
    await again;
    expect(participant.isLinked).toBe(true);

    // a takeover as it links anew fences it: reported once, and no attempt after it
    adapter.lose();
    await asked();
    adapter.takeOver();
    await settled();
    expect(reported).toEqual(['the link of ada was taken over by another link of its id']);
    grants.shift()?.();

    for (let count = 0; count < 10; count += 1) {
      await settled();
    }

    expect([reported, grants.length, participant.isLinked]).toEqual([
      ['the link of ada was taken over by another link of its id'],
      0,
      false,
    ]);
    await expect(participant.transportClient().connect({ server: 'interop' })).rejects.toThrow(
      'the link of ada was taken over by another link of its id, and connects no more until it is started again'
    );
    await participant.stop();
  });

  test('reports its link given up on once its reconnection’s attempts run out', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const participant = createBrokerParticipant({
      adapter,
      reconnect: { delay: 0, maxAttempts: 2 },
    });
    const reported = new Promise<Error>((resolve) => {
      participant.on('error', resolve);
    });

    await participant.start();
    adapter.lose();

    // * its broker holds its id's link of another start already: each attempt is refused
    await adapter.start();

    expect(await reported).toMatchObject({
      message: 'the link of ada went down, and 2 attempts did not bring it back',
    });
    expect(participant.isLinked).toBe(false);

    await participant.stop();
  });

  test('reports its reconnection ended once its signal is aborted', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const cancelling = new AbortController();
    const participant = createBrokerParticipant({
      adapter,
      reconnect: { delay: 60_000, signal: cancelling.signal },
    });
    const reported = new Promise<Error>((resolve) => {
      participant.on('error', resolve);
    });

    await participant.start();
    adapter.lose();

    // * each attempt is refused, and the wait before the next one is cut short
    await adapter.start();
    cancelling.abort();

    expect(await reported).toMatchObject({
      message:
        'the link of ada went down, and its reconnection ended: the reconnection was cancelled',
    });
    expect(participant.isLinked).toBe(false);

    await participant.stop();
  });

  test('serves its names again once its link connects anew, its former peers reset', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'server' });
    const participant = createBrokerParticipant({ adapter, reconnect: { delay: 0 } });
    const transport = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const first = ada.transportClient();
    const closes: boolean[] = [];

    first.on('close', (wasClean) => {
      closes.push(wasClean);
    });
    await transport.start();
    await first.connect({ server: 'interop' });
    await settled();

    const former = participant.incarnation;

    adapter.lose();

    for (let turn = 0; turn < 20 && !(participant.isLinked && closes.length > 0); turn += 1) {
      await settled();
    }

    // * its connection closed, unclean; its name held again, by another incarnation
    expect([closes, participant.isLinked, transport.gauges().counts['names']]).toEqual([
      [false],
      true,
      1,
    ]);
    expect(hexadecimalOf(participant.incarnation ?? new Uint8Array())).not.toBe(
      hexadecimalOf(former ?? new Uint8Array())
    );

    const second = ada.transportClient();

    await second.connect({ server: 'interop' });
    await settled();

    expect(
      transport.clients.map(({ connectionHandle }) => {
        return connectionHandle;
      })
    ).toEqual(['type=BROKER;participant=ada;ordinal=2']);

    await second.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('reports what reaches a name but a parcel and an OPEN that does not read, and drops in silence any other parcel there, a parcel at its inbox that names no connection, and anything but a GONE at a departure', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const transport = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();
    const tester = await peerOf(broker, { id: 'tester' });
    const reported: string[] = [];
    const told: [string, string][] = [];

    participant.on('error', ({ message }) => {
      reported.push(message);
    });
    transport.on('error', ({ message }, connectionHandle) => {
      told.push([message, connectionHandle]);
    });
    await transport.start();
    await client.connect({ server: 'interop' });
    await settled();

    const open = writeParcel({
      acceptor: new Uint8Array(8),
      bound: 65_536,
      id: 'tester',
      incarnation: INCARNATION,
      kind: ParcelKind.OPEN,
      opener: HALF,
      sequence: 1,
    });
    // an OPEN of a layout to come whose id runs past its bytes, and one whose kept byte is not 0
    const cut = encodeParcel({
      acceptor: new Uint8Array(8),
      id: 'tester',
      kind: ParcelKind.OPEN,
      layout: 0xb2,
      opener: HALF,
      sequence: 1,
    }).slice(0, 31);
    const kept = open.slice();
    const ping = writeParcel({ acceptor: HALF, kind: ParcelKind.PING, opener: HALF, sequence: 2 });
    const unread = ping.slice();

    kept[3] = 1;
    unread[3] = 1;

    for (const payload of [Uint8Array.of(0xb1), cut, kept, ping, unread]) {
      await tester.adapter.publish({ payload, topic: NAME });
    }

    // at its inbox, an ACCEPT of a layout to come and a parcel that does not read, naming no pair
    for (const payload of [
      encodeParcel({
        acceptor: HALF,
        kind: ParcelKind.ACCEPT,
        layout: 0xb2,
        opener: HALF,
        sequence: 1,
      }),
      unread,
    ]) {
      await tester.adapter.publish({ payload, topic: ['bead', 'i', 'server'] });
    }

    // at a departure it subscribes, no parcel and a parcel but a GONE
    for (const payload of [Uint8Array.of(0xb1), ping]) {
      await tester.adapter.publish({ payload, topic: ['bead', 'd', 'ada'] });
    }

    await settled();

    const reports = [
      "a message to the name interop is no parcel: 1 bytes, under a parcel's 28",
      'an OPEN to the name interop does not read, dropped: an OPEN whose id runs past its bytes',
      'an OPEN to the name interop does not read, dropped: a kept byte that is not 0',
    ];

    // * each reported by its participant, and by its server transport with no handle
    expect(reported).toEqual(reports);
    expect(told).toEqual(
      reports.map((message) => {
        return [message, ''];
      })
    );
    expect([tester.heard, client.isOpen(), transport.clients.length]).toEqual([[], true, 1]);

    await client.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });

  test('gives no life to a publication of an adapter that offers none', async () => {
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const lives: (number | undefined)[] = [];
    const adapter = broker.adapter({
      capabilities: { groups: true, noSubscriber: true, will: true },
      id: 'ada',
    });
    const recorded = Object.assign(Object.create(adapter) as IBrokerAdapter, {
      publish: (publication: Parameters<IBrokerAdapter['publish']>[0]) => {
        lives.push(publication.expiresAfter);

        return adapter.publish(publication);
      },
    });
    const participant = createBrokerParticipant({ adapter: recorded, heartbeat: 30_000 });
    const client = participant.transportClient();
    const connecting = client.connect({ server: 'interop', timeout: 10_000 });

    await settled();

    const open = peer.heard[0]?.parcel;

    if (open !== undefined) {
      await peer.adapter.publish({
        payload: acceptOf(open, { acceptor: HALF, id: 'acceptor' }),
        topic: ['bead', 'i', 'ada'],
      });
    }

    await connecting;
    // * its OPEN, its third leg, and a DATA that carries a credential: none with a life
    await client.send({ credential: 'Bearer token', data: Uint8Array.of(1) });
    await settled();
    expect(lives).toEqual([undefined, undefined, undefined]);
    await client.disconnect();
    await participant.stop();
  });

  test('a participant taken over reports it, connects no more, and fails each connect naming it until it is started again (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const adapter = broker.adapter({ id: 'ada' });
    const clock = createTestClock();
    const participant = createBrokerParticipant({ adapter, clock, reconnect: { delay: 1_000 } });
    const client = participant.transportClient();
    const reported: string[] = [];
    const closes: boolean[] = [];

    participant.on('error', ({ message }) => {
      reported.push(message);
    });
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

    // a connect its link is taken over under fails, naming it
    const pending = participant
      .transportClient()
      .connect({ server: 'interop' })
      .catch((reason: unknown) => {
        return reason;
      });

    await settled();
    adapter.takeOver();
    await settled();

    expect(await pending).toMatchObject({
      message: 'the link of ada was taken over by another link of its id as it connected',
      name: 'ConnectError',
    });
    // * each connection closed unclean, reported, and no link anew past its reconnection's delay
    expect(closes).toEqual([false]);
    expect(reported).toEqual(['the link of ada was taken over by another link of its id']);
    await clock.tickAsync(5_000);
    await settled();
    expect(participant.isLinked).toBe(false);
    expect(adapter.isLinked).toBe(false);
    await expect(participant.transportClient().connect({ server: 'interop' })).rejects.toThrow(
      'the link of ada was taken over by another link of its id, and connects no more until it is started again'
    );
    expect(adapter.isLinked).toBe(false);

    // its application's start links it anew, as another incarnation
    const former = participant.incarnation;

    await participant.start();
    expect(participant.isLinked).toBe(true);
    expect(hexadecimalOf(participant.incarnation ?? new Uint8Array())).not.toBe(
      hexadecimalOf(former ?? new Uint8Array())
    );
    await participant.stop();
  });
});
