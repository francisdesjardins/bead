// dependencies

import { expect, test } from '@playwright/test';
import type { Packet } from 'mqtt-packet';
import { hexadecimalOf } from '../../../router/server/__tests__/expected-envelope';
import {
  encodeParcel,
  type IParcel,
  KIND_NAMES,
  ParcelFlag,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../broker-parcel';
import {
  BROKER_DELIVERIES,
  BROKER_PUBLISHED,
  createBrokerParticipant,
} from '../broker-participant';
import { CancelError, GenericError, ProgrammerError } from '../errors';
import {
  createMemoryBroker,
  type IMemoryBroker,
  type IMemoryBrokerAdapter,
  MEMORY_BROKER_FAULTS,
} from '../memory-broker';
import { createMqttBrokerAdapter } from '../mqtt-broker-adapter';
import { noop } from '../noop';
import type { BrokerTopic, IBrokerAdapter, IBrokerMessage } from '../types';
import { createTestClock, trapUncaught } from './fixtures';
import { createMqttScript, type IScriptedLink } from './mqtt-script';

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

/** Waits, a millisecond at a time, until `condition` holds; past two seconds, fails naming `what`. */
const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let count = 0; count < 2_000 && !condition(); count += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }

  expect(condition(), what).toBe(true);
};

/** The starts of its link `log` holds, its first among them. */
const startsIn = (log: string[]): number => {
  return log.filter((entry) => {
    return entry.startsWith('start');
  }).length;
};

/** What `participant` reports, each kept whole, its `cause` among it. */
const hearing = (participant: ReturnType<typeof createBrokerParticipant>): Error[] => {
  const reported: Error[] = [];

  participant.on('error', (error) => {
    reported.push(error);
  });

  return reported;
};

/** The words of each of `reported`. */
const wordsOf = (reported: Error[]): string[] => {
  return reported.map(({ message }) => {
    return message;
  });
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

/**
 * An adapter whose every start, while `holding.isHolding`, waits for the test to release it, its
 * signal unheard, as a CONNACK that comes after its participant's stop went.
 */
const heldOf = (adapter: IBrokerAdapter) => {
  const releases: (() => void)[] = [];
  const holding = { isHolding: true };
  const held = Object.assign(Object.create(adapter) as IBrokerAdapter, {
    start: (options?: Parameters<IBrokerAdapter['start']>[0]) => {
      if (!holding.isHolding) {
        return adapter.start(options);
      }

      return new Promise<void>((resolve, reject) => {
        releases.push(() => {
          adapter.start(options).then(resolve, reject);
        });
      });
    },
  });

  return { held, holding, releases };
};

/** What a peer's publication to the inbox of `id` meets over `broker`: a subscriber, or none. */
const inboxOf = async (broker: IMemoryBroker, id: string) => {
  const peer = broker.adapter({ id: `${id}-peer` });

  await peer.start();

  const published = await peer.publish({ payload: Uint8Array.of(1), topic: ['bead', 'i', id] });

  await peer.stop();

  return published;
};

/** The states of the link `participant` tells its trace, in their order. */
const linkStatesOf = (participant: ReturnType<typeof createBrokerParticipant>): string[] => {
  const states: string[] = [];

  participant.on('debug', (event) => {
    if (event.event === 'link') {
      states.push(String(event.state));
    }
  });

  return states;
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

/**
 * A participant `ada` of `options` whose `count` client transports each hold a connection to a
 * peer of the test's own, `acceptor`: what each heard, how each closed, and the parcels the peer
 * sends on each, numbered from 2, behind its ACCEPT.
 */
const heldConnections = async (
  options: Omit<Parameters<typeof createBrokerParticipant>[0], 'adapter'>,
  { count, maximumUnsentBytes }: { count: number; maximumUnsentBytes?: number }
) => {
  const broker = createMemoryBroker();
  const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
  const participant = createBrokerParticipant({
    adapter: broker.adapter({ id: 'ada' }),
    ...options,
  });
  const reported: string[] = [];
  const connections: {
    client: ReturnType<typeof participant.transportClient>;
    closes: boolean[];
    told: number[][];
    send: (fields: Omit<IParcel, 'acceptor' | 'layout' | 'opener' | 'sequence'>) => Promise<void>;
  }[] = [];

  for (let index = 0; index < count; index += 1) {
    const client = participant.transportClient({ maximumUnsentBytes });
    const acceptor = Uint8Array.of(0xa1, 0, 0, 0, 0, 0, 1, index + 1);
    const told: number[][] = [];
    const closes: boolean[] = [];
    const connecting = client.connect({ server: 'interop' });

    client.on('message', ({ data }) => {
      told.push([...(data as Uint8Array)]);
    });
    client.on('close', (wasClean) => {
      closes.push(wasClean);
    });
    client.on('error', ({ message }) => {
      reported.push(message);
    });
    await settled();

    const opener = peer.heard.findLast(({ topic }) => {
      return topic === NAME.join('/');
    })?.parcel?.opener;

    if (opener === undefined) {
      throw new Error('no OPEN came');
    }

    await peer.adapter.publish({
      payload: acceptOf({ opener } as IParcel, { acceptor, id: 'acceptor' }),
      topic: ['bead', 'i', 'ada'],
    });
    await connecting;
    await settled();

    let sequence = 1;

    connections.push({
      client,
      closes,
      send: (fields) => {
        const isReset = fields.kind === ParcelKind.RESET;

        sequence += isReset ? 0 : 1;

        return peer.adapter
          .publish({
            payload: writeParcel({
              ...fields,
              acceptor,
              opener,
              sequence: isReset ? 0 : sequence,
            }),
            topic: ['bead', 'i', 'ada'],
          })
          .then(() => {
            return undefined;
          });
      },
      told,
    });
  }

  return { connections, participant, peer, reported };
};

/**
 * An adapter whose every stop waits for the test to release it, as a broker slow to take a
 * DISCONNECT: its participant's stop under way meanwhile.
 */
const stopsHeldOf = (adapter: IBrokerAdapter) => {
  const releases: (() => void)[] = [];
  const held = Object.assign(Object.create(adapter) as IBrokerAdapter, {
    stop: () => {
      return new Promise<void>((resolve, reject) => {
        releases.push(() => {
          adapter.stop().then(resolve, reject);
        });
      });
    },
  });

  return { held, releases };
};

/**
 * An adapter that logs what its participant asks of it, in its order, but its peers' departures,
 * which each connection's end lets go: each unsubscription of a name held while
 * `holding.isHoldingUnsubscribes` says so, its broker holding the name until the test settles it,
 * or refused; each subscription of a name answered once the test grants it, its broker holding it
 * from its call, while `holding.isHoldingSubscribes` says so; and each stop held while
 * `holding.isHoldingStops` says so.
 */
const lettingOf = (adapter: IBrokerAdapter) => {
  const log: string[] = [];
  const holding = {
    isHoldingStops: false,
    isHoldingSubscribes: false,
    isHoldingUnsubscribes: true,
  };
  const unsubscribes: { refuse: (error: Error) => void; settle: () => void }[] = [];
  const grants: (() => void)[] = [];
  const stops: (() => void)[] = [];
  const noted = (what: string): void => {
    if (!what.includes('bead/d/')) {
      log.push(what);
    }
  };
  const held = Object.assign(Object.create(adapter) as IBrokerAdapter, {
    publish: (publication: Parameters<IBrokerAdapter['publish']>[0]) => {
      noted(`publish ${publication.topic.join('/')}`);

      return adapter.publish(publication);
    },
    stop: () => {
      noted('stop');

      if (!holding.isHoldingStops) {
        return adapter.stop();
      }

      return new Promise<void>((resolve, reject) => {
        stops.push(() => {
          adapter.stop().then(resolve, reject);
        });
      });
    },
    subscribe: (topic: BrokerTopic, options?: Parameters<IBrokerAdapter['subscribe']>[1]) => {
      noted(`subscribe ${topic.join('/')}`);

      const subscribing = adapter.subscribe(topic, options);

      if (topic[1] !== 's' || !holding.isHoldingSubscribes) {
        return subscribing;
      }

      return new Promise<void>((resolve, reject) => {
        grants.push(() => {
          subscribing.then(resolve, reject);
        });
      });
    },
    unsubscribe: (topic: BrokerTopic) => {
      noted(`unsubscribe ${topic.join('/')}`);

      if (topic[1] !== 's' || !holding.isHoldingUnsubscribes) {
        return adapter.unsubscribe(topic);
      }

      return new Promise<void>((resolve, reject) => {
        unsubscribes.push({
          refuse: reject,
          settle: () => {
            adapter.unsubscribe(topic).then(resolve, reject);
          },
        });
      });
    },
  });

  return { grants, held, holding, log, stops, unsubscribes };
};

/**
 * A participant `server` over `letting`, serving `interop`, started, and a client of a participant
 * `client`'s connected to it: what the server's transport tells, and how the client closed.
 */
const lettingServerOf = async (broker: IMemoryBroker, letting: ReturnType<typeof lettingOf>) => {
  const participant = createBrokerParticipant({ adapter: letting.held });
  const server = participant.transportServer({ names: ['interop'] });
  const clients = createBrokerParticipant({ adapter: broker.adapter({ id: 'client' }) });
  const client = clients.transportClient();
  const told = {
    closes: [] as boolean[],
    messages: 0,
    opened: 0,
    refusals: [] as [string | undefined, number, string][],
  };

  server.on('connection', () => {
    told.opened += 1;
  });
  server.on('message', () => {
    told.messages += 1;
  });
  server.on('refusal', ({ address, reason, status }) => {
    told.refusals.push([address, status, reason]);
  });
  client.on('close', (wasClean) => {
    told.closes.push(wasClean);
  });
  await server.start();
  await client.connect({ server: 'interop' });
  await until(() => {
    return told.opened === 1;
  }, 'its server told it open');

  return { clients, participant, server, told };
};

/** The `names` events `participant` tells its trace, each its name and whether held. */
const namesOf = (participant: ReturnType<typeof createBrokerParticipant>): string[] => {
  const told: string[] = [];

  participant.on('debug', (event) => {
    if (event.event === 'names') {
      told.push(`${String(event.name)} ${event.isHeld === true ? 'held' : 'let go'}`);
    }
  });

  return told;
};

/** Stops `participant`, whose adapter `holding` holds each stop, once that stop is held. */
const stoppedOf = async (
  participant: ReturnType<typeof createBrokerParticipant>,
  holding: ReturnType<typeof stopsHeldOf>
): Promise<void> => {
  const stopping = participant.stop();

  await until(() => {
    return holding.releases.length === 1;
  }, "its adapter's stop held");
  holding.releases.shift()?.();
  await stopping;
};

/** An adapter that logs each listener its participant hooks or lets go, and its stops, into `log`. */
const listenedOf = (adapter: IBrokerAdapter, log: string[]): IBrokerAdapter => {
  const listened = Object.create(adapter) as IBrokerAdapter;
  const each = (verb: 'off' | 'on') => {
    return (event: 'down' | 'message', listener: never): unknown => {
      log.push(`${verb} ${event}`);

      return adapter[verb](event as 'message', listener);
    };
  };

  return Object.assign(listened, {
    off: each('off'),
    on: each('on'),
    stop: () => {
      log.push('stop');

      return adapter.stop();
    },
  });
};

/**
 * A participant `srv` over the MQTT 5 adapter, linked to a scripted broker of a Receive Maximum of
 * 1, whose server transport holds `count` connections, each of a peer `c1`, `c2`… the script plays:
 * what the broker read, in its order, from each SUBSCRIBE to its DISCONNECT, each PUBLISH answered
 * while `acknowledging` says so, each UNSUBSCRIBE at once, and its next link once its participant
 * starts again.
 */
const scriptedServerOf = async ({
  connectTimeout,
  count,
}: {
  connectTimeout: number;
  count: number;
}) => {
  const script = await createMqttScript();
  const adapter = createMqttBrokerAdapter({
    connectTimeout,
    id: 'srv',
    password: 'secret',
    url: script.url,
  });
  const participant = createBrokerParticipant({ adapter, devtools: false, heartbeat: Infinity });
  const server = participant.transportServer({ names: ['interop'] });
  const seen: string[] = [];
  // * each PUBLISH answered while it acknowledges, or while it has answers left; held otherwise
  const acknowledging = { answers: 0, isAcknowledging: true };
  const held: { link: IScriptedLink; messageId: number }[] = [];
  const accepts = new Map<string, Uint8Array>();
  let opened = 0;

  server.on('connection', () => {
    opened += 1;
  });

  const pump = async (link: IScriptedLink): Promise<void> => {
    while (!link.isClosed) {
      let packet: Packet;

      try {
        packet = await link.next(undefined, { within: 100 });
      } catch {
        continue;
      }

      if (packet.cmd === 'subscribe') {
        seen.push(`SUBSCRIBE ${packet.subscriptions[0]?.topic ?? ''}`);
        link.send({
          cmd: 'suback',
          granted: [1],
          messageId: packet.messageId ?? 0,
          properties: {},
        });
      } else if (packet.cmd === 'publish') {
        const read = readParcel(new Uint8Array(packet.payload as Buffer));
        const parcel = 'parcel' in read ? read.parcel : undefined;
        const code = parcel?.code === undefined ? '' : ` ${String(parcel.code)}`;

        seen.push(
          `PUBLISH ${packet.topic} ${parcel === undefined ? 'none' : (KIND_NAMES[parcel.kind] ?? '')}${code}`
        );

        if (parcel?.kind === ParcelKind.ACCEPT) {
          accepts.set(packet.topic, parcel.acceptor);
        }

        if (acknowledging.isAcknowledging || acknowledging.answers > 0) {
          acknowledging.answers = Math.max(0, acknowledging.answers - 1);
          link.send({ cmd: 'puback', messageId: packet.messageId ?? 0, reasonCode: 0 });
        } else {
          held.push({ link, messageId: packet.messageId ?? 0 });
        }
      } else if (packet.cmd === 'unsubscribe') {
        // * each let go at once: a stop awaits its UNSUBACK before its adapter's stop; its peers'
        // departures, which each connection's end lets go, left out
        const filters = packet.unsubscriptions.filter((filter) => {
          return !filter.startsWith('bead/d/');
        });

        if (filters.length > 0) {
          seen.push(`UNSUBSCRIBE ${filters.join(' ')}`);
        }

        link.send({
          cmd: 'unsuback',
          granted: packet.unsubscriptions.map(() => {
            return 0;
          }),
          messageId: packet.messageId ?? 0,
          properties: {},
        });
      } else if (packet.cmd === 'disconnect') {
        seen.push(`DISCONNECT 0x${(packet.reasonCode ?? 0).toString(16).padStart(2, '0')}`);
      }
    }
  };
  // its next link, once `starting` asks it: a CONNACK of a Receive Maximum of 1
  const linked = async (starting: Promise<unknown>): Promise<IScriptedLink> => {
    const link = await script.link();

    link.send({
      cmd: 'connack',
      properties: { receiveMaximum: 1 },
      reasonCode: 0,
      sessionPresent: false,
    });
    void pump(link);
    await starting;

    return link;
  };
  const first = await linked(server.start());
  let messageId = 100;

  // * each peer's OPEN to the name, then its third leg once its ACCEPT came
  for (let index = 1; index <= count; index += 1) {
    const id = `c${String(index)}`;
    const opener = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, index);

    messageId += 1;
    first.send({
      cmd: 'publish',
      dup: false,
      messageId,
      payload: Buffer.from(
        writeParcel({
          acceptor: new Uint8Array(8),
          bound: 65_536,
          flags: 0,
          id,
          incarnation: INCARNATION,
          kind: ParcelKind.OPEN,
          opener,
          sequence: 1,
        })
      ),
      qos: 1,
      retain: false,
      topic: 'bead/s/interop',
    });
    await until(() => {
      return accepts.has(`bead/i/${id}`);
    }, `the ACCEPT of ${id}`);
    messageId += 1;
    first.send({
      cmd: 'publish',
      dup: false,
      messageId,
      payload: Buffer.from(
        writeParcel({
          acceptor: accepts.get(`bead/i/${id}`) ?? new Uint8Array(8),
          kind: ParcelKind.PING,
          opener,
          sequence: 2,
        })
      ),
      qos: 1,
      retain: false,
      topic: 'bead/i/srv',
    });
  }

  // * each open, its PONG answered: nothing waits on the quota
  await until(() => {
    return (
      opened === count &&
      seen.filter((line) => {
        return line.endsWith(' PONG');
      }).length === count
    );
  }, 'each connection open');
  await settled();

  return {
    acknowledging,
    participant,
    seen,
    acknowledgeHeld: () => {
      for (const each of held.splice(0)) {
        each.link.send({ cmd: 'puback', messageId: each.messageId, reasonCode: 0 });
      }
    },
    relinked: async () => {
      await linked(participant.start());
    },
    [Symbol.asyncDispose]: async () => {
      await participant[Symbol.asyncDispose]();
      await script[Symbol.asyncDispose]();
    },
  };
};

/** An envelope of `length` bytes, each `byte`, in one DATA. */
const dataOf = (byte: number, length = 1) => {
  return { carried: new Uint8Array(length).fill(byte), kind: ParcelKind.DATA };
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
    const alone = createBrokerParticipant({ adapter: lone, reconnects: false });
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

  // spec 15.12.17, 15.23.5
  test('holds what comes for a paused connection, in order, and loses it alone past maximumHeldEnvelopeBytes', async () => {
    const { connections, participant, peer, reported } = await heldConnections(
      { maximumHeldEnvelopeBytes: 100 },
      { count: 2 }
    );
    const [held, other] = connections;

    if (held === undefined || other === undefined) {
      throw new Error('two connections');
    }

    // * held while paused, in order, its link reading on for the other connection
    held.client.pause();
    await held.send(dataOf(1, 40));
    await held.send(dataOf(2, 40));
    await other.send(dataOf(9));
    await settled();

    expect([held.told, other.told]).toEqual([[], [[9]]]);

    held.client.resume();
    await settled();

    expect(
      held.told.map(([byte]) => {
        return byte;
      })
    ).toEqual([1, 2]);

    // * past what one connection may hold: that connection lost, a CLOSE of 4000, and no other
    held.client.pause();
    peer.heard.length = 0;
    await held.send(dataOf(3, 40));
    await held.send(dataOf(4, 40));
    await held.send(dataOf(5, 40));
    await settled();
    await other.send(dataOf(10));
    await settled();

    expect([held.closes, held.client.isOpen()]).toEqual([[false], false]);
    expect(
      peer.heard.map(({ parcel }) => {
        return [parcel?.kind, parcel?.code];
      })
    ).toEqual([[ParcelKind.CLOSE, 4000]]);
    expect(reported).toEqual([
      'the connection to acceptor is closed with 4000: what it holds for its router, paused, would pass maximumHeldEnvelopeBytes, 100 bytes',
    ]);
    expect([other.told, other.closes, other.client.isOpen()]).toEqual([[[9], [10]], [], true]);
    expect(() => {
      return createBrokerParticipant({
        adapter: createMemoryBroker().adapter({ id: 'bob' }),
        maximumHeldEnvelopeBytes: 0,
      });
    }).toThrow(new ProgrammerError('maximumHeldEnvelopeBytes is a whole number above 0, not 0'));

    await participant.stop();
  });

  // spec 15.12.17, 15.23.5
  test('a resume with a hand already queued keeps the order of what is held', async () => {
    const { connections, participant } = await heldConnections({}, { count: 1 });
    const [held] = connections;

    if (held === undefined) {
      throw new Error('one connection');
    }

    held.client.pause();
    await held.send(dataOf(1));
    await settled();

    // * the next one's hand queued ahead of the resume's release: held behind what is held
    const sending = held.send(dataOf(2));

    held.client.resume();
    await sending;
    await settled();
    await held.send(dataOf(3));
    await settled();

    expect(
      held.told.map(([byte]) => {
        return byte;
      })
    ).toEqual([1, 2, 3]);

    await participant.stop();
  });

  // spec 15.12.17, 15.21
  test('a CLOSE behind held envelopes comes after them, and a RESET drops them', async () => {
    const { connections, participant, peer } = await heldConnections({}, { count: 2 });
    const [closing, reset] = connections;

    if (closing === undefined || reset === undefined) {
      throw new Error('two connections');
    }

    // * a CLOSE that comes while anything is held waits behind it
    closing.client.pause();
    await closing.send(dataOf(1));
    await closing.send({ code: 1000, kind: ParcelKind.CLOSE });
    await settled();

    expect([closing.told, closing.closes, closing.client.isOpen()]).toEqual([[], [], true]);

    // nothing comes after a CLOSE: a DATA behind it dropped, and nothing of this side's goes
    const heard = peer.heard.length;

    await closing.send(dataOf(9));
    await closing.client.send({ data: Uint8Array.of(0xa1, 0x16) });
    await settled();

    expect(peer.heard.length).toBe(heard);

    closing.client.resume();
    await settled();

    expect([closing.told, closing.closes, closing.client.isOpen()]).toEqual([[[1]], [true], false]);

    // * a RESET ends it at once, whatever its order, what is held lost with it
    reset.client.pause();
    await reset.send(dataOf(2));
    await reset.send({ kind: ParcelKind.RESET });
    await settled();

    expect([reset.closes, reset.client.isOpen()]).toEqual([[false], false]);

    reset.client.resume();
    await settled();

    expect(reset.told).toEqual([]);

    await participant.stop();
  });

  // spec 15.23.4, 15.23.5
  test('one connection held to its bound fails the parts of no other connection', async () => {
    const { connections, participant } = await heldConnections(
      { heldBytesBudget: 2_048 },
      { count: 2, maximumUnsentBytes: 65_536 }
    );
    const [held, other] = connections;

    if (held === undefined || other === undefined) {
      throw new Error('two connections');
    }

    // * past the budget of the parts, held whole: charged to none of it
    held.client.pause();

    for (const byte of [1, 2, 3]) {
      await held.send(dataOf(byte, 1_000));
    }

    await settled();

    // the other's envelope in two parts of 600 bytes, under the budget alone
    await other.send({ ...dataOf(7, 600), flags: ParcelFlag.MORE });
    await other.send(dataOf(8, 600));
    await settled();

    expect([
      other.told.map(({ length }) => {
        return length;
      }),
      other.closes,
    ]).toEqual([[1_200], []]);
    expect([held.told, held.closes, held.client.isOpen()]).toEqual([[], [], true]);

    held.client.resume();
    await settled();

    expect(
      held.told.map(([byte]) => {
        return byte;
      })
    ).toEqual([1, 2, 3]);

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
    await peer.adapter.publishRetained({ payload: data, topic: ['bead', 'i', 'server'] });
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
    expect(participant.gauges().ceilings).toEqual({
      largestPartsBytes: 2_048,
      partsBytes: 4_096,
      unsentBytes: 65_536,
      largestUnsentBytes: 65_536,
    });
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

  // spec 15.1
  test('drops what an error listener throws, the next error listener told, and the participant goes on', async () => {
    using uncaught = trapUncaught();
    const broker = createMemoryBroker();
    const peer = await peerOf(broker, { id: 'acceptor', isServing: true });
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const heard: string[] = [];

    participant.on('error', () => {
      throw new Error('an error listener that throws');
    });
    participant.on('error', ({ message }) => {
      heard.push(message);
    });
    await participant.start();

    // a report of its own: a message that is no parcel
    await peer.adapter.publish({ payload: Uint8Array.of(0xb1), topic: ['bead', 'i', 'ada'] });
    await settled();

    // * it takes the next parcel: the ACCEPT that opens its connection
    const client = participant.transportClient();
    const connecting = client.connect({ server: 'interop' });

    await settled();

    const open = peer.heard.at(-1)?.parcel;

    expect(open?.kind).toBe(ParcelKind.OPEN);

    if (open !== undefined) {
      await peer.adapter.publish({
        payload: acceptOf(open, { acceptor: HALF, id: 'acceptor' }),
        topic: ['bead', 'i', 'ada'],
      });
    }

    await connecting;

    // the report told the next listener once, the throw of the first told to none
    expect([client.isOpen(), heard, uncaught.thrown]).toEqual([
      true,
      ["a message to the inbox of ada is no parcel: 1 bytes, under a parcel's 28"],
      [],
    ]);

    await client.disconnect();
    await participant.stop();
  });

  test('lets a listener go, fails a connect awaiting its answer as it stops, and stops once', async () => {
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

    // * the connect fails as its participant stops, and a second stop does nothing
    expect(await pending).toMatchObject({
      message: 'the participant ada stopped as it connected',
      name: 'ConnectError',
    });
    await participant.stop();

    expect([participant.isLinked, reported]).toEqual([
      false,
      ["a message to the inbox of ada is no parcel: 1 bytes, under a parcel's 28"],
    ]);

    // * taken over, then stopped: a stop leaves the fence, so a connect reads the takeover's words
    const cat = broker.adapter({ id: 'cat' });
    const fenced = createBrokerParticipant({ adapter: cat, reconnects: false });
    const fencing = hearing(fenced);

    await fenced.start();
    cat.takeOver();
    await until(() => {
      return fencing.length > 0;
    }, 'its takeover reported');
    await fenced.stop();

    const refused = fenced.transportClient().connect({ server: 'interop' });

    await expect(refused, 'not a misuse').rejects.not.toBeInstanceOf(ProgrammerError);
    await expect(refused, "the takeover's words").rejects.toThrow(
      'the link of cat was taken over by another link of its id, and connects no more until it is started again'
    );
    await fenced[Symbol.asyncDispose]();
    await participant[Symbol.asyncDispose]();
  });

  test('fails a start its stop overtakes, what its adapter’s start failed with as its cause', async () => {
    const broker = createMemoryBroker();
    const calls: string[] = [];
    const ada = broker.adapter({ id: 'ada' });
    // an adapter whose start waits for its stop's signal, then gives up
    const giving = Object.assign(Object.create(ada) as IBrokerAdapter, {
      start: (options?: Parameters<IBrokerAdapter['start']>[0]) => {
        calls.push('start');

        return new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new GenericError('the adapter gave up its start'));
          });
        });
      },
      stop: () => {
        calls.push('stop');

        return ada.stop();
      },
    });
    const participant = createBrokerParticipant({ adapter: giving });
    const starting = participant.start().catch((reason: unknown) => {
      return reason;
    });

    await until(() => {
      return calls.length > 0;
    }, 'its start asked');
    await participant.stop();

    // * its start fails as a link fails, its adapter's failure its cause, by its words
    const failed = await starting;

    expect(failed, "a link's failure").toBeInstanceOf(GenericError);
    expect(failed, 'not a misuse').not.toBeInstanceOf(ProgrammerError);
    expect(failed).toMatchObject({
      cause: { message: 'the adapter gave up its start' },
      message: 'the participant ada stopped as it started',
    });
    expect(calls, 'its adapter stopped once').toEqual(['start', 'stop']);
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
      reconnect: { delay: 0, maximumAttempts: 5 },
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
      reconnect: { delay: 0, maximumAttempts: 2 },
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

  // spec 1.4, 15.21
  test('refuses a fixed reconnection delay out of bounds as it is built, and ends its reconnection, reported, on a function’s answer out of bounds', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });

    // * a fixed delay held as it is built, whether or not it reconnects
    for (const [delay, reconnects, written] of [
      [0.4, undefined, '0.4'],
      [2 ** 31, true, '2147483648'],
      [Infinity, false, 'Infinity'],
    ] as const) {
      expect(() => {
        return createBrokerParticipant({ adapter, reconnect: { delay }, reconnects });
      }, `${written} refused as it is built`).toThrow(
        new ProgrammerError(
          `a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not ${written}`
        )
      );
    }

    expect(adapter.isLinked, 'nothing started').toBe(false);

    // a function's answer held at each attempt: out of bounds, its reconnection ends, reported,
    // its refusal the report's cause
    const participant = createBrokerParticipant({
      adapter,
      reconnect: {
        delay: () => {
          return Infinity;
        },
      },
    });
    const reported = hearing(participant);

    await participant.start();
    adapter.lose();
    await adapter.start();
    await until(() => {
      return reported.length > 0;
    }, 'its reconnection ended');
    await settled();

    expect(wordsOf(reported), 'reported once').toEqual([
      'the link of ada went down, and its reconnection ended: a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not Infinity',
    ]);
    expect(reported[0]?.cause, "its refusal the report's cause").toBeInstanceOf(ProgrammerError);
    expect(participant.isLinked, 'down').toBe(false);

    await participant.stop();
  });

  // spec 15.21
  test('reconnects without end when given a delay alone', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const log: string[] = [];
    const participant = createBrokerParticipant({
      adapter: loggedOf(adapter, log),
      reconnect: { delay: 1 },
    });
    const reported = hearing(participant);

    await participant.start();
    adapter.lose();
    await adapter.start();

    // * past the 5 attempts a transport client's reconnection makes when it names none
    await until(() => {
      return startsIn(log) > 8;
    }, 'its attempts past five');
    expect([wordsOf(reported), participant.isLinked], 'nothing reported, down').toEqual([
      [],
      false,
    ]);

    // its broker lets it through: linked again, by its own reconnection
    await adapter.stop();
    await until(() => {
      return participant.isLinked;
    }, 'linked again');
    expect(wordsOf(reported), 'nothing reported').toEqual([]);

    await participant.stop();
  });

  // spec 15.21
  test('ends its reconnection at once as it is stopped, in a wait or in an attempt, told so, the stop its cause', async () => {
    // in a wait: on the test's clock, a delay of 10 s never advanced, its first attempt refused
    const clock = createTestClock();
    const broker = createMemoryBroker({ clock });
    const adapter = broker.adapter({ id: 'ada' });
    const log: string[] = [];
    const tapped: number[] = [];
    const participant = createBrokerParticipant({
      adapter: loggedOf(adapter, log),
      clock,
      reconnect: {
        delay: 10_000,
        tap: (delay) => {
          tapped.push(delay);
        },
      },
    });
    const reported = hearing(participant);

    await participant.start();
    adapter.lose();
    await adapter.start();
    await until(() => {
      return tapped.length === 1;
    }, 'its first wait told');

    const before = clock.now;

    // * its stop ends its link, the test's own among it: its broker would let it through now
    await participant.stop();
    await until(() => {
      return reported.length > 0;
    }, 'its reconnection ended');
    await settled();

    // * ended at once, told once, the stop its cause
    expect(wordsOf(reported), 'told so, once').toEqual([
      'the link of ada went down, and its reconnection ended: the reconnection was cancelled',
    ]);
    expect(reported[0]?.cause, 'cancelled').toBeInstanceOf(CancelError);
    expect(reported[0]?.cause, 'the stop its cause').toMatchObject({
      cause: { message: 'the participant ada stopped' },
      message: 'the reconnection was cancelled',
    });
    expect(clock.now, 'the clock not moved').toBe(before);
    expect(tapped, 'no wait told after its stop').toEqual([10_000]);
    expect(startsIn(log), 'no attempt after its stop').toBe(2);
    expect([participant.isLinked, adapter.isLinked], 'linked no more').toEqual([false, false]);

    // in an attempt: its attempt's start held, then its stop
    const bob = broker.adapter({ id: 'bob' });
    const holding = heldOf(bob);
    const taps: number[] = [];
    const linking = createBrokerParticipant({
      adapter: holding.held,
      clock,
      reconnect: {
        delay: 10_000,
        tap: (delay) => {
          taps.push(delay);
        },
      },
    });
    const told = hearing(linking);

    holding.holding.isHolding = false;
    await linking.start();
    holding.holding.isHolding = true;
    bob.lose();
    await until(() => {
      return holding.releases.length > 0;
    }, "its attempt's start held");

    const stopping = linking.stop();

    holding.releases.shift()?.();
    await stopping;
    await until(() => {
      return told.length > 0;
    }, 'its reconnection ended');
    await settled();

    // * its attempt fails, and its reconnection ends at once, no wait told after it, the stop its
    // cause
    expect(wordsOf(told), 'told so, once').toEqual([
      'the link of bob went down, and its reconnection ended: the reconnection was cancelled',
    ]);
    expect(told[0]?.cause, 'the stop its cause').toMatchObject({
      cause: { message: 'the participant bob stopped' },
      message: 'the reconnection was cancelled',
    });
    expect(taps, 'no wait told').toEqual([]);
    expect(clock.now, 'the clock not moved').toBe(before);
    expect([linking.isLinked, bob.isLinked], 'linked no more').toEqual([false, false]);
  });

  // spec 15.21
  test('ends its reconnection before any attempt once its signal is aborted', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const log: string[] = [];
    const cancelling = new AbortController();
    const participant = createBrokerParticipant({
      adapter: loggedOf(adapter, log),
      reconnect: { delay: 0, signal: cancelling.signal },
    });
    const reported = hearing(participant);

    await participant.start();

    // * aborted before its link goes down, its broker letting it through
    cancelling.abort();
    adapter.lose();
    await until(() => {
      return reported.length > 0;
    }, 'its reconnection ended');
    await settled();

    expect(wordsOf(reported), 'reported once').toEqual([
      'the link of ada went down, and its reconnection ended: the reconnection was cancelled',
    ]);
    expect(startsIn(log), 'no attempt, its start alone').toBe(1);
    expect(participant.isLinked, 'down').toBe(false);

    await participant.stop();
  });

  // spec 15.21
  test('links anew at its next start once its reconnection ended', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    const participant = createBrokerParticipant({
      adapter,
      reconnect: { delay: 0, maximumAttempts: 2 },
    });
    const reported = hearing(participant);

    await participant.start();

    const former = participant.incarnation;

    adapter.lose();
    await adapter.start();
    await until(() => {
      return reported.length > 0;
    }, 'given up on');
    expect(wordsOf(reported), 'reported').toEqual([
      'the link of ada went down, and 2 attempts did not bring it back',
    ]);

    // its broker lets it through: it stays down until it is started
    await adapter.stop();
    await settled();
    expect(participant.isLinked, 'down').toBe(false);

    // * its next start links it anew, another incarnation, not the first start's outcome
    await participant.start();
    expect([participant.isLinked, adapter.isLinked], 'linked anew').toEqual([true, true]);
    expect(participant.incarnation, 'another incarnation').not.toEqual(former);

    await participant.stop();
  });

  // spec 15.21
  test('reports its reconnection ended when its delay function or its tap throws', async () => {
    const broker = createMemoryBroker();
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });
    const delayBroke = new Error('its delay broke');
    const tapBroke = new Error('its tap broke');
    const throwing = createBrokerParticipant({
      adapter: ada,
      reconnect: {
        delay: () => {
          throw delayBroke;
        },
      },
    });
    const tapping = createBrokerParticipant({
      adapter: bob,
      reconnect: {
        delay: 0,
        tap: () => {
          throw tapBroke;
        },
      },
    });
    const reported = [hearing(throwing), hearing(tapping)];

    await throwing.start();
    await tapping.start();
    ada.lose();
    await ada.start();
    bob.lose();
    await bob.start();
    await until(() => {
      return reported.every((each) => {
        return each.length > 0;
      });
    }, 'each reconnection ended');
    await settled();

    // * each told once, what it threw its cause
    expect(reported.map(wordsOf), 'each reported once').toEqual([
      ['the link of ada went down, and its reconnection ended: its delay broke'],
      ['the link of bob went down, and its reconnection ended: its tap broke'],
    ]);
    expect(reported[0]?.[0]?.cause, "its delay's throw, a misuse").toMatchObject({
      cause: delayBroke,
      name: 'ProgrammerError',
    });
    expect(reported[1]?.[0]?.cause, "its tap's throw, as it is").toBe(tapBroke);
    expect([throwing.isLinked, tapping.isLinked], 'each down').toEqual([false, false]);

    await throwing.stop();
    await tapping.stop();
  });

  // spec 1.4
  test('takes a turn of its platform between two attempts at a delay of 0, over an adapter that refuses its start at once', async () => {
    const broker = createMemoryBroker();
    const adapter = broker.adapter({ id: 'ada' });
    let starts = 0;
    let ranAt: number | undefined;
    const refusing = Object.assign(Object.create(adapter) as IBrokerAdapter, {
      start: (options?: Parameters<IBrokerAdapter['start']>[0]) => {
        starts += 1;

        return starts === 1
          ? adapter.start(options)
          : Promise.reject(new GenericError('refused at once'));
      },
    });
    const participant = createBrokerParticipant({
      adapter: refusing,
      reconnect: {
        delay: 0,
        maximumAttempts: 3,
        tap: (_delay, attempt) => {
          // * a task queued as its first wait is told
          if (attempt === 1) {
            setImmediate(() => {
              ranAt = starts;
            });
          }
        },
      },
    });
    const reported = hearing(participant);

    await participant.start();
    adapter.lose();
    await until(() => {
      return reported.length > 0;
    }, 'its attempts spent');

    expect(ranAt, 'that task runs before its second attempt').toBe(2);
    expect(wordsOf(reported)).toEqual([
      'the link of ada went down, and 3 attempts did not bring it back',
    ]);

    await participant.stop();
  });

  test('fails a link its stop meets as it connects, at its start or as it links anew, and stops its adapter once that start settles, nothing left subscribed (spec 15.21)', async () => {
    const broker = createMemoryBroker();

    // at its start: both its stops await the start under way, which then fails
    const ada = broker.adapter({ id: 'ada' });
    const atStart = heldOf(ada);
    const starting = createBrokerParticipant({ adapter: atStart.held });
    const links = linkStatesOf(starting);
    const started = starting.start().catch((reason: unknown) => {
      return reason;
    });

    await settled();

    const stops = [starting.stop(), starting.stop()];
    const settledStops: number[] = [];

    for (const [index, stop] of stops.entries()) {
      void stop.then(() => {
        settledStops.push(index);
      });
    }

    await settled();
    expect(settledStops, 'neither stop settles while its start is held').toEqual([]);
    atStart.releases.shift()?.();
    await Promise.all(stops);
    expect(settledStops, 'both settle once it is released').toEqual([0, 1]);

    const failed = await started;

    expect(failed, 'its start failed, as a link fails').toBeInstanceOf(GenericError);
    expect(failed).toMatchObject({ message: 'the participant ada stopped as it started' });
    expect([starting.isLinked, ada.isLinked, links], 'its adapter stopped, no up told').toEqual([
      false,
      false,
      ['stopped'],
    ]);
    expect(await inboxOf(broker, 'ada'), 'its inbox let go').toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);

    // with no turn between them: whatever its start's outcome, nothing of its link is left
    const cy = broker.adapter({ id: 'cy' });
    const sudden = createBrokerParticipant({ adapter: cy });
    const suddenLinks = linkStatesOf(sudden);
    const suddenStart = sudden.start().catch(noop);

    void sudden.stop();
    await sudden.stop();
    await suddenStart;
    expect([sudden.isLinked, cy.isLinked], 'linked no more').toEqual([false, false]);
    expect(await inboxOf(broker, 'cy'), 'its inbox let go').toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    expect(suddenLinks.slice(suddenLinks.indexOf('stopped')), 'no up told after its stop').toEqual([
      'stopped',
    ]);

    // as it links anew: its reconnection ends at once, no wait told after the stop
    const bob = broker.adapter({ id: 'bob' });
    const anew = heldOf(bob);
    const taps: number[] = [];
    const linking = createBrokerParticipant({
      adapter: anew.held,
      reconnect: {
        delay: 0,
        tap: (delay) => {
          taps.push(delay);
        },
      },
    });
    const reported = hearing(linking);

    anew.holding.isHolding = false;
    await linking.start();
    anew.holding.isHolding = true;
    bob.lose();
    await until(() => {
      return anew.releases.length > 0;
    }, 'an attempt under way');

    const relinking = linking.stop();

    anew.releases.shift()?.();
    await relinking;
    await until(() => {
      return reported.length > 0;
    }, 'its reconnection ended');
    await settled();
    expect(wordsOf(reported), 'told so, once').toEqual([
      'the link of bob went down, and its reconnection ended: the reconnection was cancelled',
    ]);
    expect(
      [taps, linking.isLinked, bob.isLinked],
      'no wait after its stop, linked no more'
    ).toEqual([[], false, false]);
    expect(await inboxOf(broker, 'bob'), 'its inbox let go').toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
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

  test('drops and reports a message that holds retained, which says it was kept by isRetained', async () => {
    const broker = createMemoryBroker();
    const inner = broker.adapter({ id: 'server' });
    const wrapped = new Map<unknown, unknown>();
    // * an adapter written for 0.9.0: each message it hands on holds retained, false or true
    const adapter = Object.assign(Object.create(inner) as IBrokerAdapter, {
      off: (event: string, listener: (message: IBrokerMessage) => void) => {
        return inner.off(
          event as 'message',
          (wrapped.get(listener) ?? listener) as typeof listener
        );
      },
      on: (event: string, listener: (message: IBrokerMessage) => void) => {
        const holding =
          event === 'message'
            ? (message: IBrokerMessage) => {
                listener({ ...message, retained: false } as IBrokerMessage);
              }
            : listener;

        wrapped.set(listener, holding);

        return inner.on(event as 'message', holding);
      },
    });
    const participant = createBrokerParticipant({ adapter });
    const transport = participant.transportServer({ names: ['interop'] });
    const tester = await peerOf(broker, { id: 'tester' });
    const reported = hearing(participant);
    const verdicts: unknown[] = [];

    participant.on('debug', ({ direction, verdict }) => {
      if (direction === 'rx') {
        verdicts.push(verdict);
      }
    });

    await transport.start();
    await tester.adapter.publish({
      payload: writeParcel({
        acceptor: new Uint8Array(8),
        bound: 65_536,
        id: 'tester',
        incarnation: INCARNATION,
        kind: ParcelKind.OPEN,
        opener: HALF,
        sequence: 1,
      }),
      topic: NAME,
    });
    await settled();

    // * no value of retained is read: an OPEN that holds it is no parcel, settled, and opens nothing
    expect(wordsOf(reported)).toEqual([
      'a broker message says it was kept by isRetained: one holding retained is no parcel',
    ]);
    expect(reported[0]).toBeInstanceOf(ProgrammerError);
    expect([tester.heard, transport.clients.length, inner.unsettled]).toEqual([[], 0, 0]);
    // * traced as a message that is no parcel while a debug listener watches
    expect(verdicts).toEqual(['no-parcel']);

    await participant.stop();
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

  // ── a stop in place, its next link, and a dispose (spec 15.21) ──

  test('stops in place and starts again as another incarnation, its server transports’ names served again and its listeners kept, no will gone (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const watching = await peerOf(broker, { id: 'watching' });
    const adapter = broker.adapter({ id: 'server' });
    const participant = createBrokerParticipant({ adapter });
    const transport = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();
    const closes = { client: [] as boolean[], server: [] as boolean[] };

    await watching.adapter.subscribe(['bead', 'd', 'server']);
    transport.on('close', (wasClean) => {
      closes.server.push(wasClean);
    });
    client.on('close', (wasClean) => {
      closes.client.push(wasClean);
    });
    await transport.start();
    await client.connect({ server: 'interop' });
    await until(() => {
      return transport.clients.length === 1;
    }, 'its server told it open');

    const links = linkStatesOf(participant);
    const reported = hearing(participant);
    const former = participant.incarnation;

    await participant.stop();

    // * each connection closed with a CLOSE of 1001, unclean at both ends, its link ended, its name
    // held no more, its server's transport kept
    await until(() => {
      return closes.client.length === 1;
    }, 'its client told its close');
    expect(closes, 'closed with 1001').toEqual({ client: [false], server: [false] });
    expect([participant.isLinked, adapter.isLinked], 'its link ended').toEqual([false, false]);
    expect(transport.gauges().counts['names'], 'its name held no more').toBe(0);
    expect(participant.names.size, 'none held').toBe(0);
    expect(transport.isOpen(), "its server's transport kept").toBe(true);

    // * its next start: another incarnation, its name served again, each listener kept
    await participant.start();
    expect(participant.isLinked, 'linked anew').toBe(true);
    expect(
      hexadecimalOf(participant.incarnation ?? new Uint8Array()),
      'another incarnation'
    ).not.toBe(hexadecimalOf(former ?? new Uint8Array()));
    await until(() => {
      return transport.gauges().counts['names'] === 1;
    }, 'its name served again');

    const again = ada.transportClient();

    await again.connect({ server: 'interop' });
    expect(again.isOpen(), 'served anew').toBe(true);
    expect(links, 'its trace heard on').toEqual(['stopped', 'up']);
    expect(wordsOf(reported), 'nothing reported').toEqual([]);
    await settled();
    expect(
      watching.heard.filter(({ topic }) => {
        return topic === 'bead/d/server';
      }),
      'no will gone'
    ).toEqual([]);
    await again.disconnect();
    await ada[Symbol.asyncDispose]();
    await participant[Symbol.asyncDispose]();
  });

  test('refuses a start while its stop is under way, and links anew at a start, a connect or a server’s start once that stop settled (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const serving = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });

    await serving.transportServer({ names: ['interop'] }).start();

    const holding = stopsHeldOf(broker.adapter({ id: 'ada' }));
    const participant = createBrokerParticipant({ adapter: holding.held });

    await participant.start();

    const incarnations = [hexadecimalOf(participant.incarnation ?? new Uint8Array())];

    // * a start while its stop is under way: its application's misuse, refused
    const stopping = participant.stop();

    await until(() => {
      return holding.releases.length === 1;
    }, "its adapter's stop held");

    const refused = participant.start();

    await expect(refused, 'a misuse').rejects.toBeInstanceOf(ProgrammerError);
    await expect(refused, 'its words').rejects.toThrow('the participant ada is stopping');

    // * a connect while its stop is under way fails, as one that stop overtook does
    await expect(
      participant.transportClient().connect({ server: 'interop' }),
      'a connect as it stops'
    ).rejects.toThrow('the participant ada stopped as it connected');
    holding.releases.shift()?.();
    await stopping;
    expect(participant.isLinked, 'down').toBe(false);

    // * a connect once that stop settled, then a stop with no turn between them: that stop ends
    // what the connect would link
    const connecting = participant
      .transportClient()
      .connect({ server: 'interop' })
      .catch((reason: unknown) => {
        return reason;
      });

    await stoppedOf(participant, holding);
    expect(await connecting, 'the connect fails').toMatchObject({
      message: 'the participant ada stopped as it connected',
      name: 'ConnectError',
    });
    await settled();
    expect(participant.isLinked, 'linked by none').toBe(false);

    // * once that stop settled, a start links it anew
    await participant.start();
    expect(participant.isLinked, 'linked anew by a start').toBe(true);
    incarnations.push(hexadecimalOf(participant.incarnation ?? new Uint8Array()));

    // * so does a client's connect over it
    await stoppedOf(participant, holding);
    await participant.transportClient().connect({ server: 'interop' });
    expect(participant.isLinked, 'linked anew by a connect').toBe(true);
    incarnations.push(hexadecimalOf(participant.incarnation ?? new Uint8Array()));

    // * and a server's start over it
    await stoppedOf(participant, holding);
    await participant.transportServer({ names: ['own'] }).start();
    expect(participant.isLinked, "linked anew by a server's start").toBe(true);
    expect([...participant.names], 'its name served').toEqual(['own']);
    incarnations.push(hexadecimalOf(participant.incarnation ?? new Uint8Array()));
    expect(new Set(incarnations).size, 'each link another incarnation').toBe(4);
    await stoppedOf(participant, holding);
    await participant[Symbol.asyncDispose]();
    await serving[Symbol.asyncDispose]();
  });

  test('refuses a start once disposed, lets its adapter go, and disposes once, stopping it first (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const ada = broker.adapter({ id: 'ada' });
    const log: string[] = [];
    const participant = createBrokerParticipant({ adapter: listenedOf(loggedOf(ada, log), log) });
    const links = linkStatesOf(participant);

    await participant.start();
    expect(log, 'its adapter heard').toEqual([
      'on message',
      'on down',
      'start, its will to bead/d/ada',
      'subscribe bead/i/ada',
    ]);

    // * two disposes: one stop of its adapter, then its listeners let go of, once
    await Promise.all([participant[Symbol.asyncDispose](), participant[Symbol.asyncDispose]()]);
    expect(log.slice(4), 'stopped first, then let go of, once').toEqual([
      'stop',
      'off message',
      'off down',
    ]);
    expect([participant.isLinked, ada.isLinked], 'neither linked').toEqual([false, false]);

    // * a start once disposed: its application's misuse, refused before anything moves
    const refused = participant.start();

    await expect(refused, 'a misuse').rejects.toBeInstanceOf(ProgrammerError);
    await expect(refused, 'its words').rejects.toThrow('the participant ada is disposed');

    // * a stop or a dispose after it settles with it, nothing asked of its adapter, nothing told
    await participant.stop();
    await participant[Symbol.asyncDispose]();
    await settled();
    expect(log, 'nothing more asked').toHaveLength(7);
    expect(links, 'its stop told once').toEqual(['up', 'stopped']);
  });

  test('attributes to its stop what that stop ended, though a start follows it at once, and lets the next link stand (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const serving = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });

    await serving.transportServer({ names: ['interop'] }).start();

    const ada = broker.adapter({ id: 'ada' });
    const holding = heldOf(ada);
    const participant = createBrokerParticipant({ adapter: holding.held, reconnects: false });
    const reported = hearing(participant);
    const waiting = participant.transportClient();
    const again = participant.transportClient();

    holding.holding.isHolding = false;
    await again.connect({ server: 'interop' });
    ada.lose();
    await until(() => {
      return reported.length > 0 && again.isClosed();
    }, 'its link down, its client closed');
    holding.holding.isHolding = true;

    // a link's start, a connect awaiting it and a client's reconnection in flight, its start held
    const caught = (pending: Promise<unknown>): Promise<unknown> => {
      return pending.catch((reason: unknown) => {
        return reason;
      });
    };
    const starting = caught(participant.start());

    await until(() => {
      return holding.releases.length === 1;
    }, 'its start held');

    const ended: string[] = [];
    const connecting = caught(waiting.connect({ server: 'interop' })).finally(() => {
      ended.push('connect');
    });
    const reconnecting = caught(again.reconnect({ delay: 60_000 })).finally(() => {
      ended.push('reconnection');
    });

    await settled();

    const stopping = participant.stop();

    // * the connect and the reconnection end at once, its start held still
    await until(() => {
      return ended.length === 2;
    }, 'each ended');
    holding.releases.shift()?.();
    await stopping;

    // ! a start, with no turn between it and the stop's end
    const restarting = participant.start();

    await until(() => {
      return holding.releases.length === 1;
    }, 'its next start held');
    holding.releases.shift()?.();
    await restarting;

    // * each told as the stop's, though a start followed it at once
    expect(await starting, 'its start').toMatchObject({
      message: 'the participant ada stopped as it started',
    });
    expect(await connecting, 'the connect').toMatchObject({
      message: 'the participant ada stopped as it connected',
      name: 'ConnectError',
    });

    const reconnected = await reconnecting;

    expect(reconnected, 'the reconnection cancelled').toBeInstanceOf(CancelError);
    expect(reconnected, 'its stop its cause').toMatchObject({
      cause: { message: 'the participant ada stopped' },
      message: 'the reconnection was cancelled',
    });

    // * the next link stands: linked, and a connect goes through it
    await settled();
    expect(participant.isLinked, 'linked').toBe(true);
    await waiting.connect({ server: 'interop' });
    expect(waiting.isOpen(), 'open').toBe(true);
    expect(wordsOf(reported), 'its loss alone reported').toEqual(['the link of ada went down']);
    await participant[Symbol.asyncDispose]();
    await serving[Symbol.asyncDispose]();
  });

  test('sends each connection’s CLOSE of 1001 before its adapter’s DISCONNECT, past its broker’s Receive Maximum (spec 15.21)', async () => {
    await using scripted = await scriptedServerOf({ connectTimeout: 5_000, count: 3 });

    // * its broker holds its PUBACKs as the stop begins, as one a round trip away does, then gives
    // them: each CLOSE goes before the DISCONNECT, one at a time at a Receive Maximum of 1
    scripted.acknowledging.isAcknowledging = false;

    const from = scripted.seen.length;
    const stopping = scripted.participant.stop();

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(
      scripted.seen.slice(from),
      'its name let go, then one CLOSE alone, its PUBACK held'
    ).toEqual(['UNSUBSCRIBE bead/s/interop', 'PUBLISH bead/i/c1 CLOSE 1001']);
    scripted.acknowledging.isAcknowledging = true;
    scripted.acknowledgeHeld();
    await stopping;
    await until(() => {
      return scripted.seen.at(-1) === 'DISCONNECT 0x00';
    }, 'its DISCONNECT read');
    expect(
      scripted.seen.slice(from),
      'its name, each CLOSE, its inbox, then the DISCONNECT'
    ).toEqual([
      'UNSUBSCRIBE bead/s/interop',
      'PUBLISH bead/i/c1 CLOSE 1001',
      'PUBLISH bead/i/c2 CLOSE 1001',
      'PUBLISH bead/i/c3 CLOSE 1001',
      'UNSUBSCRIBE bead/i/srv',
      'DISCONNECT 0x00',
    ]);
    await scripted.participant[Symbol.asyncDispose]();
  });

  test('resets at its next link each peer whose CLOSE its broker did not take as it stopped (spec 15.21)', async () => {
    await using scripted = await scriptedServerOf({ connectTimeout: 500, count: 2 });

    // * the CLOSE of the first its broker takes; the second's it never answers, past the stop's
    // connectTimeout
    scripted.acknowledging.isAcknowledging = false;
    scripted.acknowledging.answers = 1;

    const from = scripted.seen.length;

    await scripted.participant.stop();
    expect(scripted.seen.slice(from), 'each CLOSE, the second unanswered').toEqual([
      'UNSUBSCRIBE bead/s/interop',
      'PUBLISH bead/i/c1 CLOSE 1001',
      'PUBLISH bead/i/c2 CLOSE 1001',
      'UNSUBSCRIBE bead/i/srv',
      'DISCONNECT 0x00',
    ]);

    // * its next link resets the second, whose CLOSE did not go, and no other, once its inbox and
    // its name are subscribed again
    scripted.acknowledging.isAcknowledging = true;

    const next = scripted.seen.length;

    await scripted.relinked();
    await until(() => {
      return scripted.seen.some((line, index) => {
        return index >= next && line.includes('RESET');
      });
    }, 'a RESET read');
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(scripted.seen.slice(next), 'its link, then a RESET of the second alone').toEqual([
      'SUBSCRIBE bead/i/srv',
      'SUBSCRIBE bead/s/interop',
      'PUBLISH bead/i/c2 RESET',
    ]);

    // * a stop and a start again: none left to reset
    await scripted.participant.stop();

    const last = scripted.seen.length;

    await scripted.relinked();
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(
      scripted.seen.slice(last).filter((line) => {
        return line.includes('RESET');
      }),
      'no RESET again'
    ).toEqual([]);
    await scripted.participant[Symbol.asyncDispose]();
  });

  // ── a stop that lets each name go first (spec 15.18, 15.21) ──

  test('a participant’s stop lets each name go and closes each connection with 1001 at its call, then stops its adapter once its broker let each go, each served again at its next link (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const letting = lettingOf(broker.adapter({ id: 'server' }));
    const { clients, participant, server, told } = await lettingServerOf(broker, letting);
    const from = letting.log.length;
    let isStopped = false;
    const stopping = participant.stop().then(() => {
      isStopped = true;
    });

    // * in its turn, its name's unsubscription, then its CLOSE: its link down, its connection
    // forgotten, nothing handed on after its call, its adapter up
    expect(letting.log.slice(from), "its name's unsubscription, then its CLOSE").toEqual([
      'unsubscribe bead/s/interop',
      'publish bead/i/client',
    ]);
    expect(participant.isLinked, 'down from its call').toBe(false);
    expect(server.gauges().counts['connections'], 'its connection forgotten').toBe(0);
    await until(() => {
      return told.closes.length === 1;
    }, 'its client told its close');
    expect(told.closes, 'with 1001').toEqual([false]);
    expect(told.messages, 'nothing handed on').toBe(0);
    await settled();
    expect(isStopped, "awaiting its broker's word").toBe(false);

    // * its adapter stopped once its broker let its name go
    letting.unsubscribes.shift()?.settle();
    await stopping;
    expect(letting.log.slice(from), "then its adapter's stop").toEqual([
      'unsubscribe bead/s/interop',
      'publish bead/i/client',
      'stop',
    ]);
    expect(participant.names.size, 'none held').toBe(0);

    // * served again at its next link
    await participant.start();
    await until(() => {
      return server.gauges().counts['names'] === 1;
    }, 'served again');

    const disposing = participant[Symbol.asyncDispose]();

    await until(() => {
      return letting.unsubscribes.length === 1;
    }, 'let go of again');
    letting.unsubscribes.shift()?.settle();
    await disposing;
    await clients[Symbol.asyncDispose]();
  });

  test('refuses 503 an OPEN that comes while its stop lets its names go, its adapter up (spec 15.18, 15.21)', async () => {
    const broker = createMemoryBroker();
    const letting = lettingOf(broker.adapter({ id: 'server' }));
    const { clients, participant, told } = await lettingServerOf(broker, letting);
    const late = await peerOf(broker, { id: 'late' });
    const stopping = participant.stop();

    // * its broker holds its name still: the OPEN reaches it, and is refused 503, its adapter up
    const opener = Uint8Array.of(0xa4, 0, 0, 0, 0, 0, 0, 4);

    await expect(
      late.adapter.publish({
        payload: writeParcel({
          acceptor: new Uint8Array(8),
          bound: 65_536,
          flags: 0,
          id: 'late',
          incarnation: INCARNATION,
          kind: ParcelKind.OPEN,
          opener,
          sequence: 1,
        }),
        topic: NAME,
      }),
      'its broker holds its name'
    ).resolves.toBe(BROKER_PUBLISHED.TAKEN);
    await until(() => {
      return late.heard.length > 0;
    }, 'the OPEN answered');
    expect(
      late.heard.map(({ parcel }) => {
        return [parcel?.kind, hexadecimalOf(parcel?.opener ?? new Uint8Array()), parcel?.status];
      }),
      'refused 503'
    ).toEqual([[ParcelKind.REFUSE, hexadecimalOf(opener), 503]]);
    expect(told.refusals, 'told').toEqual([['late', 503, 'busy']]);
    expect(told.opened, 'no connection told').toBe(1);
    letting.unsubscribes.shift()?.settle();
    await stopping;
    await late.adapter.stop();
    await participant[Symbol.asyncDispose]();
    await clients[Symbol.asyncDispose]();
  });

  test('lets go at its stop a name whose subscription is under way (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const letting = lettingOf(broker.adapter({ id: 'server' }));

    letting.holding.isHoldingSubscribes = true;
    letting.holding.isHoldingUnsubscribes = false;
    letting.holding.isHoldingStops = true;

    const participant = createBrokerParticipant({ adapter: letting.held });
    const names = namesOf(participant);
    const asking = await peerOf(broker, { id: 'asking' });

    await participant.start();

    const server = participant.transportServer({ names: ['interop'] });
    const starting = server.start().catch((reason: unknown) => {
      return reason;
    });

    await until(() => {
      return letting.grants.length === 1;
    }, 'its name asked of its broker');

    // * asked, unanswered: its stop lets it go all the same, its broker's word on it coming after
    const from = letting.log.length;
    const stopping = participant.stop();

    expect(letting.log.slice(from), 'its name let go of').toEqual(['unsubscribe bead/s/interop']);
    letting.grants.shift()?.();
    await until(() => {
      return letting.stops.length === 1;
    }, "its adapter's stop held");
    await expect(
      asking.adapter.publish({ payload: Uint8Array.of(0), topic: NAME }),
      "let go before its adapter's stop"
    ).resolves.toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    expect(participant.names.size, 'never held').toBe(0);
    expect(
      names.filter((each) => {
        return each.endsWith(' held');
      }),
      'never told held'
    ).toEqual([]);
    letting.stops.shift()?.();
    await stopping;
    await starting;
    await asking.adapter.stop();
    letting.holding.isHoldingStops = false;
    await participant[Symbol.asyncDispose]();
  });

  test('reports a name its broker refuses to let go at its stop, keeps it held, and stops all the same (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const letting = lettingOf(broker.adapter({ id: 'server' }));
    const { clients, participant, server } = await lettingServerOf(broker, letting);
    const reported = hearing(participant);
    const names = namesOf(participant);

    letting.holding.isHoldingStops = true;

    const stopping = participant.stop();

    letting.unsubscribes
      .shift()
      ?.refuse(new GenericError('its broker refused to let bead/s/interop go: 0x80'));

    // * reported, held still, and its adapter stopped all the same
    await until(() => {
      return letting.stops.length === 1;
    }, "its adapter's stop held");
    expect(wordsOf(reported), 'reported').toEqual([
      'its broker refused to let bead/s/interop go: 0x80',
    ]);
    expect([...participant.names], 'held still').toEqual(['interop']);
    expect(server.gauges().counts['names'], 'counted').toBe(1);
    expect(names, 'told nothing').toEqual([]);
    letting.stops.shift()?.();
    await stopping;

    // * its stopped clears it
    expect(participant.names.size, 'none held once stopped').toBe(0);
    expect(server.gauges().counts['names'], 'none counted').toBe(0);
    letting.holding.isHoldingStops = false;
    await participant[Symbol.asyncDispose]();
    await clients[Symbol.asyncDispose]();
  });

  test('reports a name its broker refuses as it links anew, leaves it unheld, and keeps its link (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const inner = broker.adapter({ id: 'server' });
    let asked = 0;
    const refusing = Object.assign(Object.create(inner) as IBrokerAdapter, {
      subscribe: (topic: BrokerTopic, options?: Parameters<IBrokerAdapter['subscribe']>[1]) => {
        // * its name served at its first link, refused at the next
        if (topic[1] === 's') {
          asked += 1;

          if (asked > 1) {
            return Promise.reject(
              new GenericError('its broker refused the subscription to bead/s/interop: 0x87')
            );
          }
        }

        return inner.subscribe(topic, options);
      },
    });
    const participant = createBrokerParticipant({ adapter: refusing, reconnect: { delay: 0 } });
    const reported = hearing(participant);

    await participant.transportServer({ names: ['interop'] }).start();
    expect([...participant.names], 'served').toEqual(['interop']);
    inner.lose();
    await until(() => {
      return reported.length > 0;
    }, 'its refusal reported');
    expect(wordsOf(reported), 'reported').toEqual([
      'the name interop is not served: its broker refused its subscription, its broker refused the subscription to bead/s/interop: 0x87',
    ]);
    expect([participant.isLinked, [...participant.names]], 'linked, unheld').toEqual([true, []]);
    await participant.stop();
  });

  test('reports a name whose adapter throws as it is asked to let it go at its stop, as one that refuses, and stops all the same (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const letting = lettingOf(broker.adapter({ id: 'server' }));
    const { clients, participant } = await lettingServerOf(broker, letting);
    const reported = hearing(participant);

    const { unsubscribe } = letting.held;

    // * its name's alone: what else it lets go, it lets go as it would
    letting.held.unsubscribe = (topic) => {
      if (topic[1] === 's') {
        throw new GenericError('an adapter that throws as it is asked');
      }

      return unsubscribe(topic);
    };
    await participant.stop();
    expect(wordsOf(reported), 'reported').toEqual(['an adapter that throws as it is asked']);
    expect([participant.isLinked, participant.names.size], 'stopped').toEqual([false, 0]);
    await participant[Symbol.asyncDispose]();
    await clients[Symbol.asyncDispose]();
  });

  test('tells nothing of a name its link lost as it stopped (spec 15.21)', async () => {
    const broker = createMemoryBroker();
    const inner = broker.adapter({ id: 'server' });
    const letting = lettingOf(inner);
    const { clients, participant } = await lettingServerOf(broker, letting);
    const reported = hearing(participant);
    const names = namesOf(participant);

    letting.holding.isHoldingStops = true;

    const stopping = participant.stop();

    // * its link lost as it lets its name go: what fails then is that loss, reported by none
    inner.lose();
    await settled();
    letting.unsubscribes
      .shift()
      ?.refuse(new GenericError('the UNSUBACK of bead/s/interop never came'));
    await until(() => {
      return letting.stops.length === 1;
    }, "its adapter's stop held");
    expect(wordsOf(reported), 'nothing reported').toEqual([]);
    expect(names, 'told nothing').toEqual([]);
    letting.stops.shift()?.();
    await stopping;
    expect(participant.names.size, 'none held once stopped').toBe(0);
    expect(wordsOf(reported), 'nothing reported once stopped').toEqual([]);

    // * its link lost as it lets its name go, its broker letting it go after: told nothing all the
    // same, and held until its stop settles
    await participant.start();
    await until(() => {
      return participant.names.size === 1;
    }, 'its name held at its next link');
    names.length = 0;

    const restopping = participant.stop();

    await until(() => {
      return letting.unsubscribes.length === 1;
    }, 'its name let go of again');
    inner.lose();
    await settled();
    letting.unsubscribes.shift()?.settle();
    await until(() => {
      return letting.stops.length === 1;
    }, "its adapter's stop held again");
    expect(names, 'told nothing, let go').toEqual([]);
    expect(participant.names.size, 'held until its stop settles').toBe(1);
    letting.stops.shift()?.();
    await restopping;
    expect(participant.names.size, 'none held once stopped again').toBe(0);
    expect(wordsOf(reported), 'nothing reported, let go').toEqual([]);
    letting.holding.isHoldingStops = false;
    await participant[Symbol.asyncDispose]();
    await clients[Symbol.asyncDispose]();
  });
});
