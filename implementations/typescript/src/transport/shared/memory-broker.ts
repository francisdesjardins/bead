// ── Memory broker ─────────────────────────────────────────────────────────────

// dependencies

import { type IClock, PLATFORM_CLOCK } from './clock';
import { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_BROKER } from './constants';
import { createEmitter } from './emitter';
import { GenericError, ProgrammerError, toError } from './errors';
import type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
  IBrokerCapabilities,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPublication,
  IBrokerStart,
  IBrokerSubscription,
} from './types';

export { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_BROKER } from './constants';
export type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
  IBrokerCapabilities,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPublication,
  IBrokerStart,
  IBrokerSubscription,
} from './types';

// interfaces

export interface IMemoryBrokerOptions {
  /** The clock a message's life runs on, `expiresAfter`; the platform's when not given. */
  clock?: IClock | undefined;
  /** What every adapter gives, but one given its own: at least once by default. */
  delivery?: BrokerDelivery | undefined;
  /** The largest payload a message carries; none by default. */
  maximumMessageBytes?: number | undefined;
  /**
   * The messages it holds for each subscriber, published to it and not yet handed on, past which
   * it drops the one published, as a broker whose queue is full does; none by default.
   */
  maximumQueuedMessages?: number | undefined;
}

export interface IMemoryBrokerAdapterOptions {
  /** What it offers of the optional capabilities: every one by default. */
  capabilities?: IBrokerCapabilities | undefined;
  /** What it gives, the broker's when not given. */
  delivery?: BrokerDelivery | undefined;
  /** Its participant's id: any name, as a broker takes any. */
  id: string;
}

/** A publication through the in-memory broker: as any, or handed on marked retained, as a test asks. */
export interface IMemoryBrokerPublication extends IBrokerPublication {
  readonly retained?: boolean | undefined;
}

/**
 * An adapter of the in-memory broker: an adapter as any, its link lost or taken over and its
 * acknowledgements counted.
 */
export interface IMemoryBrokerAdapter extends IBrokerAdapter {
  /** Whether its link is up: started, and neither stopped nor lost. */
  readonly isLinked: boolean;
  /** The messages handed it, at least once, that it has not acknowledged. */
  readonly unsettled: number;
  /** Its link lost, as a test asks: its will published, its `down` told in a later turn. */
  lose(): void;
  publish(publication: IMemoryBrokerPublication): Promise<BrokerPublished>;
  /**
   * Its link taken over, as a test asks, as by a second link of its id: its subscriptions dropped,
   * its will published, its `down` told taken over in a later turn.
   */
  takeOver(): void;
}

/** A broker in one process (spec 15.24), whose adapters each stand for one link of a participant. */
export interface IMemoryBroker {
  /** An adapter of this broker; one id is one participant's, and two adapters may not share one. */
  adapter(options: IMemoryBrokerAdapterOptions): IMemoryBrokerAdapter;
  /**
   * What befalls the next message published, to `topic` when given, as a test asks: copied, held
   * behind the one after it on its topic, dropped, or handed again to another member of its group.
   */
  fault(fault: MemoryBrokerFault, options?: { topic?: BrokerTopic | undefined }): void;
}

// types

/** What a test asks of a message: {@link MEMORY_BROKER_FAULTS}. */
export type MemoryBrokerFault = (typeof MEMORY_BROKER_FAULTS)[keyof typeof MEMORY_BROKER_FAULTS];

// a message on its way to one link, copied as it was published
interface IQueued {
  readonly expiresAt: number;
  readonly payload: Uint8Array;
  readonly retained: boolean;
  readonly topic: BrokerTopic;
}

// one adapter's link to the broker, while it is up
interface ILink {
  readonly adapter: IMemoryBrokerAdapter;
  /** Hands a message to its adapter's listeners, with its acknowledgement. */
  readonly deliver: (message: IQueued) => void;
  isDraining: boolean;
  readonly queue: IQueued[];
  readonly subscriptions: Map<string, string | undefined>;
  will?: { readonly payload: Uint8Array; readonly topic: BrokerTopic } | undefined;
}

// constants

/** What a test may ask of the next message (spec 15.24). */
export const MEMORY_BROKER_FAULTS = Object.freeze({
  /** Handed on twice, as a broker that delivers again. */
  COPY: 'copy',
  /** Never handed on, as a broker whose queue overran. */
  DROP: 'drop',
  /** Held behind the next message published to its topic. */
  HOLD: 'hold',
  /** Handed again to another member of its group, as a broker whose member's session ended. */
  REDELIVER: 'redeliver',
});

const ALL_CAPABILITIES: IBrokerCapabilities = Object.freeze({
  expiry: true,
  groups: true,
  noSubscriber: true,
  will: true,
});

// helpers

const keyOf = (topic: BrokerTopic): string => {
  return topic.join('/');
};

// definition

/**
 * A broker in memory (spec 15.24), each adapter a participant's link: topics and subscriptions,
 * alone and in groups, a group's members chosen in turn; each message copied as it is published,
 * and handed on whole in a later turn than its publish, in the order its publisher published it to
 * that topic, once — or, as a test asks, again, behind the next, never, or to another member of its
 * group. A subscriber's queue drops a message past `maximumQueuedMessages`; a message past its
 * `expiresAfter` on the clock is deleted; a will is published as a link is lost or taken over, never
 * at a stop.
 * Its handles' type is `BROKER`, and it never leaves the process, so its every leg is secure.
 *
 * @example
 * const broker = createMemoryBroker();
 * const adapter = broker.adapter({ id: 'ada' });
 * await adapter.start();
 * await adapter.subscribe(['bead', 'i', 'ada']);
 */
export const createMemoryBroker = (options?: IMemoryBrokerOptions): IMemoryBroker => {
  const {
    clock = PLATFORM_CLOCK,
    delivery: brokerDelivery = BROKER_DELIVERIES.AT_LEAST_ONCE,
    maximumMessageBytes = Infinity,
    maximumQueuedMessages = Infinity,
  } = options ?? {};
  const links = new Map<IMemoryBrokerAdapter, ILink>();
  const ids = new Set<string>();
  // each group's turn, by its topic and its name
  const turns = new Map<string, number>();
  const faults: { fault: MemoryBrokerFault; topic: string | undefined }[] = [];
  // a message a test held, by its topic: handed on behind the next one published there
  const held = new Map<string, { message: IQueued; to: ILink[] }>();

  // * one message a turn, in the order each link's queue holds them: a later turn than its publish
  const drain = (link: ILink): void => {
    if (link.isDraining) {
      return;
    }

    link.isDraining = true;
    queueMicrotask(() => {
      link.isDraining = false;

      const message = link.queue.shift();

      if (message === undefined || links.get(link.adapter) !== link) {
        return;
      }

      if (link.queue.length > 0) {
        drain(link);
      }

      if (message.expiresAt <= clock.performance.now()) {
        return;
      }

      link.deliver(message);
    });
  };

  const enqueue = (to: readonly ILink[], message: IQueued): void => {
    for (const link of to) {
      if (link.queue.length >= maximumQueuedMessages) {
        continue;
      }

      link.queue.push(message);
      drain(link);
    }
  };

  // the links a message to `topic` reaches: each alone, and one of each group, in turn
  const recipientsOf = (topic: string, { again }: { again: boolean }): ILink[][] => {
    const alone: ILink[] = [];
    const groups = new Map<string, ILink[]>();

    for (const link of links.values()) {
      if (!link.subscriptions.has(topic)) {
        continue;
      }

      const group = link.subscriptions.get(topic);

      if (group === undefined) {
        alone.push(link);
      } else {
        groups.set(group, [...(groups.get(group) ?? []), link]);
      }
    }

    const chosen: ILink[][] = [alone];

    for (const [group, members] of groups) {
      const key = `${topic}\n${group}`;
      const turn = turns.get(key) ?? 0;
      const first = members[turn % members.length];
      const second = members[(turn + 1) % members.length];

      turns.set(key, turn + 1);
      chosen.push(
        first === undefined ? [] : again && second !== undefined ? [first, second] : [first]
      );
    }

    return chosen;
  };

  const faultOf = (topic: string): MemoryBrokerFault | undefined => {
    const index = faults.findIndex((entry) => {
      return entry.topic === undefined || entry.topic === topic;
    });

    return index === -1 ? undefined : faults.splice(index, 1)[0]?.fault;
  };

  const publishFrom = (
    link: ILink | undefined,
    publication: IMemoryBrokerPublication
  ): BrokerPublished => {
    const { expiresAfter, payload, retained = false, topic } = publication;
    const key = keyOf(topic);
    const fault = faultOf(key);
    const recipients = recipientsOf(key, { again: fault === MEMORY_BROKER_FAULTS.REDELIVER });
    const to = recipients.flat();
    const message: IQueued = {
      expiresAt: expiresAfter === undefined ? Infinity : clock.performance.now() + expiresAfter,
      payload: payload.slice(),
      retained,
      topic: [...topic],
    };

    if (to.length === 0) {
      return link?.adapter.capabilities.noSubscriber === true
        ? BROKER_PUBLISHED.NO_SUBSCRIBER
        : BROKER_PUBLISHED.TAKEN;
    }

    if (fault === MEMORY_BROKER_FAULTS.DROP) {
      return BROKER_PUBLISHED.TAKEN;
    }

    if (fault === MEMORY_BROKER_FAULTS.HOLD) {
      held.set(key, { message, to });

      return BROKER_PUBLISHED.TAKEN;
    }

    enqueue(to, message);

    if (fault === MEMORY_BROKER_FAULTS.COPY) {
      enqueue(to, message);
    }

    const behind = held.get(key);

    if (behind !== undefined) {
      held.delete(key);
      enqueue(behind.to, behind.message);
    }

    return BROKER_PUBLISHED.TAKEN;
  };

  // a link gone, lost or stopped: what it held goes with it, no session kept
  const unlink = (link: ILink): void => {
    links.delete(link.adapter);
    link.queue.length = 0;
    link.subscriptions.clear();
  };

  return {
    adapter: ({ capabilities = ALL_CAPABILITIES, delivery = brokerDelivery, id }) => {
      if (ids.has(id)) {
        throw new ProgrammerError(`an adapter of this broker is ${id} already`);
      }

      ids.add(id);

      const emitter = createEmitter<{ down: [IBrokerDown]; message: [IBrokerMessage] }>();
      let unsettled = 0;
      const linkOf = (): ILink => {
        const link = links.get(adapter);

        if (link === undefined) {
          throw new GenericError(`the link of ${id} is not up`);
        }

        return link;
      };
      const offered = Object.freeze({ ...capabilities });
      // * its link ended without a clean end: what it held dropped, its will published, its `down`
      // told in a later turn
      const end = (down: IBrokerDown): void => {
        const link = links.get(adapter);

        if (link === undefined) {
          return;
        }

        unlink(link);
        unsettled = 0;

        if (link.will !== undefined) {
          publishFrom(undefined, link.will);
        }

        queueMicrotask(() => {
          emitter.emit('down', down);
        });
      };

      const adapter: IMemoryBrokerAdapter = {
        capabilities: offered,
        delivery,
        id,
        isSecure: true,
        type: TRANSPORT_BROKER,

        get isLinked() {
          return links.has(adapter);
        },
        get unsettled() {
          return unsettled;
        },

        lose: () => {
          end({ isTakenOver: false });
        },
        maximumPayloadBytes: () => {
          return maximumMessageBytes;
        },
        off: (
          event: 'down' | 'message',
          listener: ((down: IBrokerDown) => void) | ((message: IBrokerMessage) => void)
        ) => {
          emitter.off(event, listener as never);
        },
        on: (
          event: 'down' | 'message',
          listener: ((down: IBrokerDown) => void) | ((message: IBrokerMessage) => void)
        ) => {
          emitter.on(event, listener as never);
        },
        publish: (publication) => {
          try {
            const link = linkOf();

            if (publication.payload.length > maximumMessageBytes) {
              throw new GenericError(
                `a payload of ${String(publication.payload.length)} bytes, past the broker's maximumMessageBytes, ${String(maximumMessageBytes)} bytes`
              );
            }

            if (publication.signal?.aborted === true) {
              throw new GenericError('the publication was given up on');
            }

            return Promise.resolve(publishFrom(link, publication));
          } catch (reason) {
            return Promise.reject(toError(reason));
          }
        },
        // it has no packet: every message's payload is its own, whatever its topic
        receiveBound: () => {
          return maximumMessageBytes;
        },
        start: (startOptions?: IBrokerStart) => {
          if (links.has(adapter)) {
            return Promise.reject(new ProgrammerError(`the link of ${id} is up already`));
          }

          if (startOptions?.will !== undefined && offered.will !== true) {
            return Promise.reject(new ProgrammerError(`the adapter of ${id} takes no will`));
          }

          const link: ILink = {
            adapter,
            // * counted until acknowledged, once, while it delivers at least once
            deliver: ({ payload, retained, topic }) => {
              let isSettled = delivery === BROKER_DELIVERIES.AT_MOST_ONCE;

              if (!isSettled) {
                unsettled += 1;
              }

              emitter.emit('message', {
                payload: payload.slice(),
                retained,
                settle: () => {
                  if (!isSettled && links.get(adapter) === link) {
                    unsettled -= 1;
                  }

                  isSettled = true;
                },
                topic,
              });
            },
            isDraining: false,
            queue: [],
            subscriptions: new Map(),
            will: startOptions?.will,
          };

          links.set(adapter, link);

          return Promise.resolve();
        },
        stop: () => {
          const link = links.get(adapter);

          if (link !== undefined) {
            unlink(link);
            unsettled = 0;
          }

          return Promise.resolve();
        },
        subscribe: (topic, subscription?: IBrokerSubscription) => {
          try {
            const group = subscription?.group;

            if (group !== undefined && offered.groups !== true) {
              throw new ProgrammerError(`the adapter of ${id} offers no groups`);
            }

            linkOf().subscriptions.set(keyOf(topic), group);

            return Promise.resolve();
          } catch (reason) {
            return Promise.reject(toError(reason));
          }
        },
        // ! the broker keeps one adapter to an id: a takeover's second link is the test's to imagine,
        // holding no subscription
        takeOver: () => {
          end({ isTakenOver: true });
        },
        unsubscribe: (topic) => {
          links.get(adapter)?.subscriptions.delete(keyOf(topic));

          return Promise.resolve();
        },
      };

      return adapter;
    },
    fault: (fault, faultOptions) => {
      const topic = faultOptions?.topic;

      faults.push({ fault, topic: topic === undefined ? undefined : keyOf(topic) });
    },
  };
};
