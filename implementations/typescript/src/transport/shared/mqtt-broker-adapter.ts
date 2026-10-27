// ── MQTT broker adapter ───────────────────────────────────────────────────────

// dependencies

// ! its default export alone: MQTT.js's browser build names no other, and Node's CJS one has it
import mqtt, {
  type IClientOptions,
  type IConnackPacket,
  type IDisconnectPacket,
  type IPublishPacket,
  type MqttClient,
  type Packet,
} from 'mqtt';
import { assertHeldFinite, LONGEST_TIMER, PLATFORM_CLOCK } from './clock';
import { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_MQTT } from './constants';
import { createEmitter } from './emitter';
import { GenericError, ProgrammerError, toCancelError, toError } from './errors';
import {
  groupFilterOf,
  LARGEST_PACKET_SIZE,
  largestPayload,
  MAXIMUM_PACKET_SIZE,
  publishBytes,
  topicOf,
} from './mqtt-packets';
import { isSecureUrl } from './secure';
import type {
  BrokerDelivery,
  BrokerPublished,
  IBrokerAdapter,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPublication,
  IBrokerStart,
  IBrokerSubscription,
} from './types';

export { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_MQTT } from './constants';
export { MAXIMUM_PACKET_SIZE } from './mqtt-packets';
export type { BrokerDelivery, BrokerPublished, BrokerTopic, IBrokerAdapter } from './types';

// interfaces

export interface IMqttBrokerAdapterOptions {
  /** How long its start waits for its CONNACK, in milliseconds (spec 15.30). Defaults to {@link CONNECT_TIMEOUT}. */
  connectTimeout?: number | undefined;
  /** At least once by default, each publication of QoS 1; at most once, of QoS 0 (spec 15.28). */
  delivery?: BrokerDelivery | undefined;
  /** `false` where its broker is known to offer no shared subscription (spec 15.25). */
  groups?: boolean | undefined;
  /** Its participant's id: its Client Identifier, and the User Name it authenticates by. */
  id: string;
  /**
   * Its CONNECT's Keep Alive, in milliseconds, sent in whole seconds rounded up: from 1 to 65,535
   * seconds (spec 15.30). Defaults to {@link KEEP_ALIVE}.
   */
  keepAlive?: number | undefined;
  /**
   * Its CONNECT's Maximum Packet Size, the largest packet its broker sends it, a whole number up to
   * 268,435,460 (spec 15.30). Defaults to {@link MAXIMUM_PACKET_SIZE}.
   */
  maximumPacketSize?: number | undefined;
  /**
   * Its Password, under its id as User Name; or asked at each link's start, so that one that expires
   * renews with each incarnation. None where its TLS client certificate authenticates it.
   */
  password?: string | (() => Promise<string> | string) | undefined;
  /**
   * Its TLS client certificate and key, which its broker ties to its id, over `mqtts` or `wss` in
   * Node, never in a page; and the authority its broker's own certificate is trusted by, where not
   * the platform's.
   */
  tls?:
    | {
        ca?: string | Uint8Array | undefined;
        cert: string | Uint8Array;
        key: string | Uint8Array;
      }
    | undefined;
  /** Its broker: `mqtt://`, `mqtts://`, or a WebSocket, `ws://` or `wss://`, of subprotocol `mqtt`. */
  url: string;
}

/** An adapter over MQTT 5 (spec 15.25 to 15.31): an adapter as any, its acknowledgements counted. */
export interface IMqttBrokerAdapter extends IBrokerAdapter {
  /** The messages it handed its participant at least once that are not acknowledged yet. */
  readonly unsettled: number;
}

// one network connection, from its CONNECT to its end: every callback of a former one does nothing
interface IIncarnation {
  readonly client: MqttClient;
  /** What its awaited operations are failed with as it ends. */
  readonly failures: Set<(error: Error) => void>;
  /** The filter each topic was subscribed by, which its UNSUBSCRIBE names. */
  readonly filters: Map<string, string>;
  /** Its QoS 1 publications sent and not acknowledged. */
  inFlight: number;
  /** Up, its CONNACK read, and not ended. */
  isLinked: boolean;
  isRetired: boolean;
  /** Its broker said no shared subscription, by its CONNACK or a SUBACK of 0x9E. */
  isSharedRefused: boolean;
  /** Ended by its broker for another link of its id, DISCONNECT 0x8E. */
  isTakenOver: boolean;
  /** Its CONNACK's Maximum Packet Size, the bound of what it publishes. */
  maximumPacketSize: number;
  /** Each PUBACK's Reason Code, by its packet identifier, until its publication settles. */
  readonly reasons: Map<number, number>;
  /** Its CONNACK's Receive Maximum, its send quota. */
  receiveMaximum: number;
  /** Its publications waiting on the quota, in their order. */
  readonly waiting: { readonly fail: (error: Error) => void; readonly send: () => void }[];
}

// constants

/** How long a start waits for its CONNACK, by default: 30 seconds (spec 15.30). */
export const CONNECT_TIMEOUT = 30_000;

/** Its Keep Alive, by default: 30 seconds, its will inside two heartbeats (spec 15.30). */
export const KEEP_ALIVE = 30_000;

// the longest Keep Alive a CONNECT carries, a Two Byte Integer of seconds (MQTT 5.0 §3.1.2.10)
const LONGEST_KEEP_ALIVE = 65_535_000;

// its inbound quota, the most a broker may hold unacknowledged toward it (MQTT 5.0 §3.1.2.11.3)
const RECEIVE_MAXIMUM = 65_535;

// the longest life a Message Expiry Interval holds, a Four Byte Integer of seconds
const LONGEST_LIFE_SECONDS = 4_294_967_295;

const REASON = Object.freeze({
  NO_MATCHING_SUBSCRIBERS: 0x10,
  SESSION_TAKEN_OVER: 0x8e,
  SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: 0x9e,
});

const ALL_CAPABILITIES = Object.freeze({ expiry: true, will: true });

const encoder = new TextEncoder();

// helpers

// whether a library's callback came with a failure: MQTT.js gives `null`, or nothing, for none
const isFailure = (error: unknown): error is Error => {
  return error instanceof Error;
};

const isNode = (): boolean => {
  return (
    typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions
      ?.node === 'string'
  );
};

// a Reason Code as a refusal names it
const reasonOf = (code: number): string => {
  return `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
};

// a life in whole seconds, rounded up, 1 at least (spec 15.28)
const secondsOf = (milliseconds: number): number => {
  return Math.min(LONGEST_LIFE_SECONDS, Math.max(1, Math.ceil(milliseconds / 1_000)));
};

/** `keepAlive` held: a number of milliseconds from 1 to 65,535 seconds, never 0 nor without end. */
const assertKeepAlive = (duration: unknown): number => {
  if (typeof duration !== 'number' || !(duration >= 1 && duration <= LONGEST_KEEP_ALIVE)) {
    const written = typeof duration === 'string' ? JSON.stringify(duration) : String(duration);

    throw new ProgrammerError(
      `keepAlive is a number of milliseconds from 1 to ${String(LONGEST_KEEP_ALIVE)}, not ${written}`
    );
  }

  return Math.round(duration);
};

// definition

/**
 * An adapter of a broker of MQTT 5.0 over MQTT.js (spec 15.25 to 15.31; decision 0041): each start a
 * new client, one network connection that keeps no session — Clean Start 1, a Session Expiry
 * Interval of 0 — its Client Identifier its id, authenticated by its Password under its id or by its
 * TLS client certificate, a Receive Maximum of 65,535, a Topic Alias Maximum of 0, its Maximum
 * Packet Size and its Keep Alive; its will the participant's GONE, QoS 1, RETAIN 0, a Will Delay
 * Interval of 0. Its library reconnects nothing, subscribes nothing again and holds nothing while
 * down. Each subscription is of QoS 1, No Local 0, Retain As Published 0 and Retain Handling 2, a
 * group's its shared subscription, held once its SUBACK grants QoS 1. Each publication is of QoS 1,
 * or 0 at most once, RETAIN 0, a life in whole seconds where asked and no other property, counted
 * to its byte and refused past its CONNACK's Maximum Packet Size, held to its CONNACK's Receive
 * Maximum, later ones waiting in their order; its PUBACK of 0x10 says no subscriber, of 0x80 or
 * more refuses it. Each message is handed on before its PUBACK, which goes once it is settled. A
 * DISCONNECT of 0x8E tells its link taken over; any other end, lost; its stop sends a DISCONNECT
 * of 0x00, so that no will goes. Its leg is secure under TLS or to the loopback.
 *
 * @example
 * const adapter = createMqttBrokerAdapter({ id: 'server', password, url: 'mqtts://broker:8883' });
 * const participant = createBrokerParticipant({ adapter });
 */
export const createMqttBrokerAdapter = (options: IMqttBrokerAdapterOptions): IMqttBrokerAdapter => {
  const {
    delivery = BROKER_DELIVERIES.AT_LEAST_ONCE,
    groups = true,
    id,
    maximumPacketSize = MAXIMUM_PACKET_SIZE,
    password,
    tls,
    url,
  } = options;
  const keepAlive = assertKeepAlive(options.keepAlive ?? KEEP_ALIVE);
  const connectTimeout = assertHeldFinite(
    'connectTimeout',
    options.connectTimeout ?? CONNECT_TIMEOUT
  );

  if (typeof id !== 'string' || id.length === 0) {
    throw new ProgrammerError(
      `an MQTT 5 adapter's id is its Client Identifier, not ${JSON.stringify(id)}`
    );
  }

  if (
    !Number.isSafeInteger(maximumPacketSize) ||
    maximumPacketSize < 1 ||
    maximumPacketSize > LARGEST_PACKET_SIZE
  ) {
    throw new ProgrammerError(
      `maximumPacketSize is a whole number from 1 to ${String(LARGEST_PACKET_SIZE)}, not ${String(maximumPacketSize)}`
    );
  }

  if (tls !== undefined && !isNode()) {
    throw new ProgrammerError(
      'a page chooses no TLS client certificate, its browser does: authenticate it by a password'
    );
  }

  let protocol: string;

  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new ProgrammerError(`an MQTT 5 adapter's url is mqtt, mqtts, ws or wss, not ${url}`);
  }

  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(protocol)) {
    throw new ProgrammerError(`an MQTT 5 adapter's url is mqtt, mqtts, ws or wss, not ${url}`);
  }

  if (tls !== undefined && protocol !== 'mqtts:' && protocol !== 'wss:') {
    throw new ProgrammerError(`a TLS client certificate is carried over mqtts or wss, not ${url}`);
  }

  const isAtMostOnce = delivery === BROKER_DELIVERIES.AT_MOST_ONCE;
  const emitter = createEmitter<{ down: [IBrokerDown]; message: [IBrokerMessage] }>();
  const capabilities = Object.freeze({
    ...ALL_CAPABILITIES,
    groups,
    // * QoS 0 has no PUBACK, so no word of a subscriber
    noSubscriber: !isAtMostOnce,
  });
  let current: IIncarnation | undefined;
  // each start and each stop its own, so that a stop as a start asks its password ends that start
  let starts = 0;
  let isStarting = false;
  // what its last link's CONNACK said, read while it is down
  let lastMaximumPacketSize = LARGEST_PACKET_SIZE;
  let unsettled = 0;

  const notUp = (): GenericError => {
    return new GenericError(`the link of ${id} is not up`);
  };

  const live = (): IIncarnation | undefined => {
    return current?.isLinked === true && !current.isRetired && current.client.connected
      ? current
      : undefined;
  };

  // * an incarnation ended: what it awaits failed, what it holds let go, its client discarded with
  // no packet of its own; `down` told once, where it was up
  const retire = (incarnation: IIncarnation, error: Error): void => {
    if (incarnation.isRetired) {
      return;
    }

    const wasLinked = incarnation.isLinked;

    incarnation.isRetired = true;
    incarnation.isLinked = false;

    for (const fail of incarnation.failures) {
      fail(error);
    }

    for (const { fail } of incarnation.waiting.splice(0)) {
      fail(error);
    }

    incarnation.failures.clear();
    incarnation.reasons.clear();
    incarnation.filters.clear();

    // ! a client whose network connection never opened has no stream to end
    try {
      incarnation.client.end(true);
    } catch {
      // nothing to end
    }

    if (current === incarnation) {
      current = undefined;
      unsettled = 0;
    }

    if (wasLinked) {
      emitter.emit('down', { isTakenOver: incarnation.isTakenOver });
    }
  };

  // an operation of `incarnation`, failed as it ends, given up as `signal` aborts: `retiring` where
  // what it asked may have gone, so that nothing of it enters another incarnation
  const awaited = <T>(
    incarnation: IIncarnation,
    {
      begin,
      signal,
    }: {
      begin: (settle: { reject: (error: Error) => void; resolve: (value: T) => void }) => void;
      signal?: AbortSignal | undefined;
    }
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      let isSettled = false;
      const done = (): void => {
        isSettled = true;
        incarnation.failures.delete(failure);
        signal?.removeEventListener('abort', abort);
      };
      const failure = (error: Error): void => {
        if (!isSettled) {
          done();
          reject(error);
        }
      };
      const abort = (): void => {
        if (!isSettled && signal !== undefined) {
          const error = toCancelError(signal);

          done();
          reject(error);
          retire(incarnation, new GenericError(`the link of ${id} was retired: ${error.message}`));
        }
      };

      if (signal?.aborted === true) {
        reject(toCancelError(signal));

        return;
      }

      incarnation.failures.add(failure);
      signal?.addEventListener('abort', abort, { once: true });
      begin({
        reject: failure,
        resolve: (value) => {
          if (!isSettled) {
            done();
            resolve(value);
          }
        },
      });
    });
  };

  // * the next publications the quota frees, in their order
  const release = (incarnation: IIncarnation): void => {
    while (
      !incarnation.isRetired &&
      incarnation.inFlight < incarnation.receiveMaximum &&
      incarnation.waiting.length > 0
    ) {
      incarnation.waiting.shift()?.send();
    }
  };

  // ! handed on inside MQTT.js's hook, which holds its packet pump: its PUBACK goes once settled,
  // and its later `message` event is ignored, else each message would be handed on twice
  const handOn = (
    incarnation: IIncarnation,
    { done, packet }: { done: ((code: number) => void) | undefined; packet: IPublishPacket }
  ): void => {
    let isSettled = done === undefined;

    if (!isSettled) {
      unsettled += 1;
    }

    emitter.emit('message', {
      payload: new Uint8Array(packet.payload as Uint8Array),
      retained: packet.retain,
      settle: () => {
        if (isSettled) {
          return;
        }

        isSettled = true;

        // * a message of a lost link is never acknowledged on the next one
        if (current === incarnation && !incarnation.isRetired) {
          unsettled -= 1;
          done?.(0);
        }
      },
      topic: Object.freeze(packet.topic.split('/')),
    });
  };

  const linkWith = async (
    will: IBrokerStart['will'],
    signal: AbortSignal | undefined
  ): Promise<void> => {
    const asked = starts;
    const secret = typeof password === 'function' ? await password() : password;

    if (asked !== starts) {
      throw new GenericError(`the link of ${id} stopped as it started`);
    }

    // the incarnation its hook hands messages on in, once its client is built
    const hooked: { incarnation?: IIncarnation | undefined } = {};
    const clientOptions: IClientOptions = {
      autoAssignTopicAlias: false,
      autoUseTopicAlias: false,
      clean: true,
      clientId: id,
      connectTimeout,
      // * handed on before its PUBACK, each QoS 1 message
      // oxlint-disable-next-line max-params, bead/options-last -- MQTT.js's own hook, whatever it takes
      customHandleAcks: (_topic, _message, packet: IPublishPacket, done) => {
        const { incarnation } = hooked;

        if (incarnation === undefined || incarnation.isRetired) {
          return;
        }

        handOn(incarnation, {
          done: (code) => {
            done(code);
          },
          packet,
        });
      },
      keepalive: Math.ceil(keepAlive / 1_000),
      manualConnect: true,
      properties: {
        maximumPacketSize,
        receiveMaximum: RECEIVE_MAXIMUM,
        sessionExpiryInterval: 0,
        topicAliasMaximum: 0,
      },
      protocolVersion: 5,
      queueQoSZero: false,
      reconnectOnConnackError: false,
      reconnectPeriod: 0,
      resubscribe: false,
      ...(tls === undefined
        ? { username: id }
        : {
            cert: tls.cert as never,
            key: tls.key as never,
            ...(tls.ca === undefined ? {} : { ca: tls.ca as never }),
          }),
      ...(secret === undefined ? {} : { password: secret }),
      ...(will === undefined
        ? {}
        : {
            will: {
              payload: will.payload as never,
              properties: { willDelayInterval: 0 },
              qos: 1,
              retain: false,
              topic: topicOf(will.topic),
            },
          }),
    };
    const client = mqtt.connect(url, clientOptions);
    const held: IIncarnation = {
      client,
      failures: new Set(),
      filters: new Map(),
      inFlight: 0,
      isLinked: false,
      isRetired: false,
      isSharedRefused: false,
      isTakenOver: false,
      maximumPacketSize: LARGEST_PACKET_SIZE,
      reasons: new Map(),
      receiveMaximum: RECEIVE_MAXIMUM,
      waiting: [],
    };

    hooked.incarnation = held;
    current = held;

    // * a PUBACK's Reason Code, which MQTT.js keeps from its publication's callback
    client.on('packetreceive', (packet: Packet) => {
      if (packet.cmd === 'puback' && !held.isRetired && packet.messageId !== undefined) {
        held.reasons.set(packet.messageId, packet.reasonCode ?? 0);
      }
    });
    // a QoS 0 message, which no hook sees and no PUBACK answers
    // oxlint-disable-next-line bead/options-last -- MQTT.js's own event, whatever it takes
    client.on('message', (_topic, _payload, packet) => {
      if (packet.qos === 0 && !held.isRetired) {
        handOn(held, { done: undefined, packet });
      }
    });
    client.on('disconnect', (packet: IDisconnectPacket) => {
      if (packet.reasonCode === REASON.SESSION_TAKEN_OVER && held.isLinked) {
        held.isTakenOver = true;
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let lastError: Error | undefined;
        const timer = PLATFORM_CLOCK.setTimeout(
          () => {
            fail(
              new GenericError(
                `the link of ${id} had no CONNACK within ${String(connectTimeout)} ms`
              )
            );
          },
          Math.min(connectTimeout, LONGEST_TIMER)
        );
        const fail = (error: Error): void => {
          PLATFORM_CLOCK.clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(error);
        };
        const abort = (): void => {
          fail(toCancelError(signal as AbortSignal));
        };

        if (signal?.aborted === true) {
          abort();

          return;
        }

        signal?.addEventListener('abort', abort, { once: true });
        client.on('error', (error) => {
          lastError = error;
        });
        client.once('close', () => {
          fail(
            new GenericError(
              `the link of ${id} ended before its CONNACK${lastError === undefined ? '' : `: ${lastError.message}`}`,
              { cause: lastError }
            )
          );
        });
        client.once('connect', (connack: IConnackPacket) => {
          PLATFORM_CLOCK.clearTimeout(timer);
          signal?.removeEventListener('abort', abort);

          const { properties = {} } = connack;

          // * its subscriptions and its will are of QoS 1, which a broker of Maximum QoS 0 refuses
          if (properties.maximumQoS === 0) {
            reject(
              new GenericError(`the broker of ${id} says Maximum QoS 0, and its link is of QoS 1`)
            );

            return;
          }

          held.maximumPacketSize = properties.maximumPacketSize ?? LARGEST_PACKET_SIZE;
          held.receiveMaximum = properties.receiveMaximum ?? RECEIVE_MAXIMUM;
          held.isSharedRefused = properties.sharedSubscriptionAvailable === false;
          lastMaximumPacketSize = held.maximumPacketSize;
          resolve();
        });
        client.connect();
      });
    } catch (reason) {
      retire(held, toError(reason));

      throw toError(reason);
    }

    // * its link lost: once, as its network connection ends, unless it was stopped
    client.on('close', () => {
      retire(held, new GenericError(`the link of ${id} went down`));
    });

    if (!client.connected) {
      retire(held, notUp());

      throw notUp();
    }

    held.isLinked = true;
  };

  const adapter: IMqttBrokerAdapter = {
    capabilities,
    delivery,
    id,
    isSecure: protocol === 'mqtts:' || isSecureUrl(url),
    type: TRANSPORT_MQTT,
    get unsettled() {
      return unsettled;
    },

    maximumPayloadBytes: (topic) => {
      return (
        largestPayload(topicOf(topic), current?.maximumPacketSize ?? lastMaximumPacketSize, {
          qos: isAtMostOnce ? 0 : 1,
        }) ?? 0
      );
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
    publish: (publication: IBrokerPublication) => {
      const { expiresAfter, payload, signal, topic } = publication;
      const incarnation = live();

      if (incarnation === undefined) {
        return Promise.reject(notUp());
      }

      const name = topicOf(topic);
      const hasLife = expiresAfter !== undefined;
      const qos = isAtMostOnce ? 0 : 1;
      const bytes = publishBytes(encoder.encode(name).length, payload.length, {
        hasLife,
        qos,
      });

      // ! counted before it goes: its broker ends the whole link on one past its bound
      if (bytes > incarnation.maximumPacketSize) {
        return Promise.reject(
          new GenericError(
            `a PUBLISH of ${String(bytes)} bytes to ${name}, past its broker's Maximum Packet Size, ${String(incarnation.maximumPacketSize)} bytes`
          )
        );
      }

      const publishOptions = {
        qos,
        retain: false,
        ...(hasLife ? { properties: { messageExpiryInterval: secondsOf(expiresAfter) } } : {}),
      } as const;

      if (qos === 0) {
        return awaited<BrokerPublished>(incarnation, {
          begin: ({ reject, resolve }) => {
            incarnation.client.publish(name, payload as never, publishOptions, (error) => {
              if (!isFailure(error)) {
                resolve(BROKER_PUBLISHED.TAKEN);
              } else {
                reject(toError(error));
              }
            });
          },
          signal,
        });
      }

      return new Promise<BrokerPublished>((resolve, reject) => {
        let isSent = false;
        const entry = {
          fail: (error: Error) => {
            signal?.removeEventListener('abort', leave);
            reject(error);
          },
          send: () => {
            isSent = true;
            signal?.removeEventListener('abort', leave);
            incarnation.inFlight += 1;
            awaited<BrokerPublished>(incarnation, {
              begin: ({ reject: refuse, resolve: take }) => {
                incarnation.client.publish(
                  name,
                  payload as never,
                  publishOptions,
                  (error, packet) => {
                    const messageId = (packet as { messageId?: number } | undefined)?.messageId;
                    const code =
                      (messageId === undefined ? undefined : incarnation.reasons.get(messageId)) ??
                      (error as { code?: number } | undefined)?.code ??
                      0;

                    if (messageId !== undefined) {
                      incarnation.reasons.delete(messageId);
                    }

                    if (code >= 0x80 || (isFailure(error) && code === 0)) {
                      refuse(
                        new GenericError(
                          `the broker of ${id} refused a publication to ${name}: ${reasonOf(code)}`,
                          { cause: error }
                        )
                      );
                    } else {
                      take(
                        code === REASON.NO_MATCHING_SUBSCRIBERS
                          ? BROKER_PUBLISHED.NO_SUBSCRIBER
                          : BROKER_PUBLISHED.TAKEN
                      );
                    }
                  }
                );
              },
              signal,
            })
              .finally(() => {
                incarnation.inFlight -= 1;
                release(incarnation);
              })
              .then(resolve, reject);
          },
        };
        // * a publication that waits on the quota leaves it unsent as its signal aborts, its link kept
        const leave = (): void => {
          const index = incarnation.waiting.indexOf(entry);

          if (!isSent && index !== -1 && signal !== undefined) {
            incarnation.waiting.splice(index, 1);
            reject(toCancelError(signal));
          }
        };

        if (signal?.aborted === true) {
          reject(toCancelError(signal));

          return;
        }

        signal?.addEventListener('abort', leave, { once: true });
        incarnation.waiting.push(entry);
        release(incarnation);
      });
    },
    receiveBound: (topic) => {
      return largestPayload(topicOf(topic), maximumPacketSize) ?? 0;
    },
    start: async (startOptions) => {
      if (current !== undefined || isStarting) {
        throw new ProgrammerError(`the link of ${id} is up already`);
      }

      isStarting = true;

      try {
        await linkWith(startOptions?.will, startOptions?.signal);
      } finally {
        isStarting = false;
      }
    },
    stop: async () => {
      const incarnation = current;

      starts += 1;

      if (incarnation === undefined) {
        return;
      }

      // * no down told: a stop is no loss
      incarnation.isLinked = false;

      const stopped = new GenericError(`the link of ${id} stopped`);

      for (const fail of incarnation.failures) {
        fail(stopped);
      }

      for (const { fail } of incarnation.waiting.splice(0)) {
        fail(stopped);
      }

      incarnation.isRetired = true;
      current = undefined;
      unsettled = 0;

      if (incarnation.client.connected) {
        // ! MQTT.js's clean end waits for every packet it awaits an answer to, a SUBACK that never
        // comes among them: its DISCONNECT goes now, behind what was written
        for (const messageId of Object.keys(incarnation.client.outgoing)) {
          incarnation.client.removeOutgoingMessage(Number(messageId));
        }

        await new Promise<void>((resolve) => {
          incarnation.client.end(false, { reasonCode: 0 }, () => {
            resolve();
          });
        });
      } else {
        incarnation.client.end(true);
      }
    },
    subscribe: (topic, subscription?: IBrokerSubscription) => {
      const group = subscription?.group;
      const incarnation = live();

      if (group !== undefined && !groups) {
        return Promise.reject(new ProgrammerError(`the adapter of ${id} offers no groups`));
      }

      if (incarnation === undefined) {
        return Promise.reject(notUp());
      }

      if (group !== undefined && incarnation.isSharedRefused) {
        return Promise.reject(
          new GenericError(`the broker of ${id} offers no shared subscription, so no group`)
        );
      }

      const filter = group === undefined ? topicOf(topic) : groupFilterOf(group, topic);

      return awaited<void>(incarnation, {
        begin: ({ reject, resolve }) => {
          incarnation.client.subscribe(
            filter,
            { nl: false, qos: 1, rap: false, rh: 2 },
            (...[error, , suback]: [unknown, unknown, { granted?: unknown } | undefined]) => {
              // * the SUBACK's own code: MQTT.js gives back what was asked beside a failure
              const code = (suback?.granted as number[] | undefined)?.[0];

              if (code === 1) {
                incarnation.filters.set(topicOf(topic), filter);
                resolve();

                return;
              }

              if (code === REASON.SHARED_SUBSCRIPTIONS_NOT_SUPPORTED) {
                incarnation.isSharedRefused = true;
              }

              reject(
                new GenericError(
                  `the broker of ${id} refused the subscription to ${filter}: ${code === undefined ? toError(error).message : reasonOf(code)}`,
                  { cause: error }
                )
              );
            }
          );
        },
        signal: subscription?.signal,
      });
    },
    unsubscribe: (topic) => {
      const incarnation = live();

      if (incarnation === undefined) {
        return Promise.reject(notUp());
      }

      const key = topicOf(topic);
      const filter = incarnation.filters.get(key) ?? key;

      return awaited<void>(incarnation, {
        begin: ({ reject, resolve }) => {
          incarnation.client.unsubscribe(filter, (error) => {
            if (!isFailure(error)) {
              incarnation.filters.delete(key);
              resolve();
            } else {
              reject(toError(error));
            }
          });
        },
      });
    },
  };

  return adapter;
};
