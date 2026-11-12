// ── MQTT broker adapter ───────────────────────────────────────────────────────

// dependencies

// ! its default export alone: MQTT.js's browser build names no other, and Node's CJS one has it
import mqtt, {
  type IClientOptions,
  type IDisconnectPacket,
  type IPublishPacket,
  type MqttClient,
  type Packet,
} from 'mqtt';
import { assertHeldFinite, assertHeldWithin, LONGEST_TIMER, PLATFORM_CLOCK } from './clock';
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
import { guardPacketSize } from './mqtt-packet-guard';
import { isSecureUrl } from './secure';
import { withSlicedSends } from './sliced-sends';
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
  /**
   * How long it waits, in milliseconds: its start, for its password, where it asks its provider,
   * and its CONNACK; a subscription let go, for its UNSUBACK; and its stop, for what it was handed
   * and its UNSUBACKs, then for its DISCONNECT (spec 15.26, 15.27, 15.30). Defaults to
   * {@link CONNECT_TIMEOUT}.
   */
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
   * Its Password, under its id as User Name, as given: UTF-8 text, never empty and holding no NUL
   * (spec 15.26). Refused with a {@link ProgrammerError} as it is built when it is not, beside a
   * `passwordProvider`, and beside `tls`. With neither, its CONNECT carries its User Name alone.
   */
  password?: string | undefined;
  /**
   * What hands its Password at each link's start, before its network connection opens, with a signal
   * aborted as its start's own signal aborts, as its link is stopped, as its `connectTimeout` passes,
   * and once its start ends, linked or not: so that one that expires renews with each incarnation.
   * Refused as `password` is, and beside it. Its start fails as it outlives that `connectTimeout`,
   * or as a stop meets it, whether or not it hears its signal, a later answer serving nothing; what it
   * throws fails its start, its cause; an answer that is no password fails it with a
   * {@link ProgrammerError} (spec 15.26).
   */
  passwordProvider?: ((options: { signal: AbortSignal }) => string | Promise<string>) | undefined;
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
  /** Whether its link is up: its CONNACK read, and neither stopped nor lost since. */
  readonly isLinked: boolean;
  /** The messages it handed its participant at least once that are not acknowledged yet. */
  readonly unsettled: number;
}

// one network connection, from its CONNECT to its end: every callback of a former one does nothing
interface IIncarnation {
  readonly client: MqttClient;
  /** Told, while its stop drains it, each time a publication settles or it ends. */
  drained: (() => void) | undefined;
  /** Its stop under way, which a later stop shares. */
  ending: Promise<void> | undefined;
  /** What its awaited operations are failed with as it ends. */
  readonly failures: Set<(error: Error) => void>;
  /**
   * The filter each topic's SUBSCRIBE named, by its topic, from its SUBSCRIBE until its UNSUBACK:
   * what its UNSUBSCRIBE names, and what its stop lets go. Each SUBSCRIBE's its own record, so that
   * the UNSUBACK of a former one never forgets a later one.
   */
  readonly filters: Map<string, { readonly filter: string }>;
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

/** How long a start waits for its password, where it asks its provider, and its CONNACK, and a stop for what it was handed and its UNSUBACKs, then for its DISCONNECT, by default: 30 seconds (spec 15.30). */
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
  NO_SUBSCRIPTION_EXISTED: 0x11,
  SESSION_TAKEN_OVER: 0x8e,
  SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: 0x9e,
  SUCCESS: 0x00,
});

const ALL_CAPABILITIES = Object.freeze({ expiry: true, will: true });

// MQTT.js's word on an acknowledgement of a kind its pending request takes none of, read whole
const UNANSWERED_ACK = /^Protocol error: \w+ does not answer /u;

const encoder = new TextEncoder();

// helpers

// whether a library's callback came with a failure: MQTT.js gives `null`, or nothing, for none
const isFailure = (error: unknown): error is Error => {
  return error instanceof Error;
};

// ! its parser's refusal of a packet, which leaves its stream standing and its parser astray
// (MQTT 5.0 §4.13.1): every other `error` MQTT.js tells of a link up ends its stream first, but its
// word on an acknowledgement read whole; a bump of MQTT.js re-reads each `emit('error'`
const isUnreadable = (client: MqttClient, error: Error): boolean => {
  return !client.stream.destroyed && !UNANSWERED_ACK.test(error.message);
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

// ! no refusal names the password it refuses: a word never carries the secret
const NOT_A_PASSWORD = 'a password is a non-empty string holding no NUL';

/** Whether `password` is one: UTF-8 text, never empty and holding no NUL (spec 15.26). */
const isPassword = (password: unknown): password is string => {
  return typeof password === 'string' && password.length > 0 && !password.includes('\0');
};

/** What its link authenticates by, held as it is built: a password, its provider, or `tls` alone. */
const assertAuthentication = ({
  password,
  passwordProvider,
  tls,
}: Pick<IMqttBrokerAdapterOptions, 'password' | 'passwordProvider' | 'tls'>): void => {
  if (password !== undefined && passwordProvider !== undefined) {
    throw new ProgrammerError('a link takes a password or a password provider, not both');
  }

  if ((password !== undefined || passwordProvider !== undefined) && tls !== undefined) {
    throw new ProgrammerError(
      'a link authenticates by its client certificate or by a password, not both'
    );
  }

  if (password !== undefined && !isPassword(password)) {
    throw new ProgrammerError(NOT_A_PASSWORD);
  }
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
 * group's its shared subscription, held once its SUBACK grants QoS 1, and let go once its UNSUBACK
 * came of 0x00 or 0x11, any other code refusing it, none within connectTimeout failing it, its link
 * and its filter kept. Each publication is of QoS 1,
 * or 0 at most once, RETAIN 0, a life in whole seconds where asked and no other property, counted
 * to its byte and refused past its CONNACK's Maximum Packet Size, held to its CONNACK's Receive
 * Maximum, later ones waiting in their order; its PUBACK of 0x10 says no subscriber, of 0x80 or
 * more refuses it. Each message is handed on before its PUBACK, which goes once it is settled. A
 * DISCONNECT of 0x8E tells its link taken over; any other end, lost; its stop takes no publication,
 * sends what waits on the quota and awaits each PUBACK, fails what has not gone by then, sends an
 * UNSUBSCRIBE for each filter its link asked or holds, one filter a packet, all at once, and awaits
 * their UNSUBACKs, all within one connectTimeout of its call, then sends a DISCONNECT of 0x00
 * within a connectTimeout of its own, so that no will goes: once it settled, its broker hands
 * it nothing. A packet past its own Maximum Packet Size, read at its Remaining Length, or one its
 * client cannot read, closes its network connection, no DISCONNECT, its link lost. Its link is up
 * as MQTT.js reads a CONNACK of 0x00 whose Maximum QoS is not 0, whatever comes after it; any other
 * CONNACK fails its start, naming its code, and sends nothing. Its leg is secure under TLS or to the
 * loopback.
 * In a page, its WebSocket sends no message past 16 KiB, which Chromium sends as one frame.
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
    passwordProvider,
    tls,
    url,
  } = options;
  const keepAlive = assertHeldWithin('keepAlive', options.keepAlive ?? KEEP_ALIVE, {
    ceiling: LONGEST_KEEP_ALIVE,
  });
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

  assertAuthentication({ password, passwordProvider, tls });

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
  // the start under way's ask, its provider's signal, which its stop aborts
  let asking: AbortController | undefined;
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
    incarnation.drained?.();

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
          retire(
            incarnation,
            new GenericError(
              `the link of ${id} was retired: what it was asked was given up once it may have gone`
            )
          );
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

    incarnation.drained?.();
  };

  // * what it was handed to publish before its stop, sent and answered first: settles once nothing
  // waits on the quota and every PUBACK came, its link ended, or its connectTimeout passed
  // (spec 15.24)
  const drain = (incarnation: IIncarnation): Promise<void> => {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        PLATFORM_CLOCK.clearTimeout(timer);
        incarnation.drained = undefined;
        resolve();
      };
      const timer = PLATFORM_CLOCK.setTimeout(done, Math.min(connectTimeout, LONGEST_TIMER));

      incarnation.drained = () => {
        if (
          incarnation.isRetired ||
          (incarnation.waiting.length === 0 && incarnation.inFlight === 0)
        ) {
          done();
        }
      };
      incarnation.drained();
    });
  };

  // * each filter its link asked or holds let go, one UNSUBSCRIBE each, all sent at once: settles
  // once every UNSUBACK came, 0x00 or 0x11 letting it go and any other code too, its link ended, or
  // `within` passed (spec 15.26, 15.27)
  const letGo = (incarnation: IIncarnation, within: number): Promise<void> => {
    // ! one filter a packet: one UNSUBSCRIBE of them all may pass its CONNACK's Maximum Packet Size,
    // which its broker ends the link for, its will published
    const asked = [...incarnation.filters.values()].map(({ filter }) => {
      return filter;
    });
    const answered = [...new Set(asked)].map((filter) => {
      return new Promise<void>((resolve) => {
        const done = (): void => {
          incarnation.failures.delete(done);
          resolve();
        };

        incarnation.failures.add(done);
        // ! a callback after its bound, the purge's 'Message removed' among them, serves nothing
        incarnation.client.unsubscribe(filter, done);
      });
    });

    return new Promise<void>((resolve) => {
      const timer = PLATFORM_CLOCK.setTimeout(resolve, Math.min(within, LONGEST_TIMER));

      void Promise.all(answered).then(() => {
        PLATFORM_CLOCK.clearTimeout(timer);
        resolve();
      });
    });
  };

  // * its stop, once: no down told, a stop is no loss, and no publication taken from it; what it
  // was handed sent first, what is left failed, each filter let go, then its DISCONNECT of 0x00 sent
  const endOf = async (incarnation: IIncarnation): Promise<void> => {
    // * one connectTimeout from its stop's call: what it was handed, then its UNSUBACKs
    const deadline = PLATFORM_CLOCK.performance.now() + connectTimeout;

    incarnation.isLinked = false;

    // ! before any packet awaiting its answer is let go below, whose PUBACK it waits on: what it
    // was handed goes first, so that its broker reads it before the DISCONNECT
    await drain(incarnation);

    const stopped = new GenericError(`the link of ${id} stopped`);

    for (const fail of incarnation.failures) {
      fail(stopped);
    }

    for (const { fail } of incarnation.waiting.splice(0)) {
      fail(stopped);
    }

    // ! after the drain, so that no UNSUBSCRIBE overtakes a publication waiting on its broker's
    // Receive Maximum; and before it retires, so that a message that comes meanwhile is still handed
    // on and settled: MQTT.js reads no UNSUBACK behind a PUBLISH it holds unacknowledged
    if (!incarnation.isRetired && incarnation.client.connected) {
      await letGo(incarnation, Math.max(0, deadline - PLATFORM_CLOCK.performance.now()));
    }

    incarnation.isRetired = true;
    incarnation.filters.clear();

    if (current === incarnation) {
      current = undefined;
      unsettled = 0;
    }

    if (incarnation.client.connected) {
      // ! MQTT.js's clean end waits for every packet it awaits an answer to, a SUBACK or an UNSUBACK
      // that never comes among them: its DISCONNECT goes now, behind what was written
      for (const messageId of Object.keys(incarnation.client.outgoing)) {
        incarnation.client.removeOutgoingMessage(Number(messageId));
      }

      // * its DISCONNECT within a connectTimeout of its own, though the drain spent the first: then
      // its network connection ended at once, its broker never answering
      await new Promise<void>((resolve) => {
        const timer = PLATFORM_CLOCK.setTimeout(
          () => {
            try {
              incarnation.client.stream.destroy();
            } catch {
              // its stream ended
            }

            resolve();
          },
          Math.min(connectTimeout, LONGEST_TIMER)
        );

        incarnation.client.end(false, { reasonCode: 0 }, () => {
          PLATFORM_CLOCK.clearTimeout(timer);
          resolve();
        });
      });
    } else {
      incarnation.client.end(true);
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
      isRetained: packet.retain,
      payload: new Uint8Array(packet.payload as Uint8Array),
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

  // * its password asked of its provider, raced against its start's own signal, its stop and its
  // connectTimeout: whichever ends the ask aborts its provider's signal with that start's outcome,
  // and a later answer serves nothing (spec 15.26)
  const askPassword = (
    provider: NonNullable<IMqttBrokerAdapterOptions['passwordProvider']>,
    { ask, signal }: { ask: AbortController; signal: AbortSignal | undefined }
  ): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      let isSettled = false;
      const settle = (): boolean => {
        if (isSettled) {
          return false;
        }

        isSettled = true;
        PLATFORM_CLOCK.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        ask.signal.removeEventListener('abort', giveUp);

        return true;
      };
      const giveUp = (): void => {
        if (settle()) {
          reject(toError(ask.signal.reason));
        }
      };
      const cancel = (): void => {
        ask.abort(toCancelError(signal as AbortSignal));
      };
      const timer = PLATFORM_CLOCK.setTimeout(
        () => {
          ask.abort(
            new GenericError(
              `the link of ${id} had no password within ${String(connectTimeout)} ms, its connectTimeout`
            )
          );
        },
        Math.min(connectTimeout, LONGEST_TIMER)
      );

      ask.signal.addEventListener('abort', giveUp, { once: true });

      if (signal?.aborted === true) {
        cancel();

        return;
      }

      signal?.addEventListener('abort', cancel, { once: true });
      // * a throw as it is called fails its start as a rejection does
      void Promise.resolve()
        .then(() => {
          return provider({ signal: ask.signal });
        })
        .then(
          (answer: unknown) => {
            if (!settle()) {
              return;
            }

            if (isPassword(answer)) {
              resolve(answer);
            } else {
              reject(new ProgrammerError(NOT_A_PASSWORD));
            }
          },
          (reason: unknown) => {
            if (settle()) {
              reject(new GenericError('the password provider failed', { cause: reason }));
            }
          }
        );
    });
  };

  const linkWith = async (
    will: IBrokerStart['will'],
    { ask, signal }: { ask: AbortController; signal: AbortSignal | undefined }
  ): Promise<void> => {
    const asked = starts;
    // * one connectTimeout from its start's call: its password's ask, then its CONNACK
    const deadline = PLATFORM_CLOCK.performance.now() + connectTimeout;
    const secret =
      passwordProvider === undefined
        ? password
        : await askPassword(passwordProvider, { ask, signal });

    if (asked !== starts) {
      throw new GenericError(`the link of ${id} stopped as it started`);
    }

    const left = Math.max(0, Math.min(deadline - PLATFORM_CLOCK.performance.now(), LONGEST_TIMER));

    // the incarnation its hook hands messages on in, once its client is built
    const hooked: { incarnation?: IIncarnation | undefined } = {};
    const clientOptions: IClientOptions = {
      autoAssignTopicAlias: false,
      autoUseTopicAlias: false,
      clean: true,
      clientId: id,
      connectTimeout: Math.max(1, Math.ceil(left)),
      // ! in a page alone, each message one frame (spec 15.25): in Node, `ws` fragments none, and
      // its stream sends with a callback, which the sliced send would drop
      ...(isNode()
        ? {}
        : {
            createWebsocket: (webSocketUrl: string, protocols: string[]) => {
              return withSlicedSends(new WebSocket(webSocketUrl, protocols));
            },
          }),
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
      drained: undefined,
      ending: undefined,
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

    // a packet its client cannot read before its CONNACK put its link up, which then loses it
    let unreadable: Error | undefined;

    // * a packet its client cannot read closes its network connection, no DISCONNECT, its link
    // lost once its CONNACK put it up, and never once its stop began (spec 15.26, 15.29)
    client.on('error', (error) => {
      if (held.isRetired || held.ending !== undefined || !isUnreadable(client, error)) {
        return;
      }

      const lost = new GenericError(
        `the link of ${id} went down: its broker sent a packet its client cannot read: ${error.message}`,
        { cause: error }
      );

      if (held.isLinked) {
        retire(held, lost);
      } else {
        unreadable ??= lost;
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let lastError: Error | undefined;
        // whether its first CONNACK was read, and whether its start settled
        let isJudged = false;
        let isSettled = false;
        const timer = PLATFORM_CLOCK.setTimeout(() => {
          fail(
            new GenericError(
              `the link of ${id} had no CONNACK within ${String(connectTimeout)} ms, its connectTimeout`
            )
          );
        }, left);
        const fail = (error: Error): void => {
          isSettled = true;
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
        // ! MQTT.js parses and handles within one push what its stream pushes, a CONNACK first, so
        // this judgment precedes the guard's for a packet beside it; a bump of MQTT.js re-reads its
        // writable's _write and handlers/index.js, and twin A pins it
        client.on('packetreceive', (packet: Packet) => {
          if (packet.cmd !== 'connack' || isJudged) {
            return;
          }

          isJudged = true;

          // * a start already failed, by its signal or its timer, takes no CONNACK after
          if (isSettled) {
            return;
          }

          if (held.isRetired || held.ending !== undefined) {
            fail(new GenericError(`the link of ${id} stopped as it started`));

            return;
          }

          const { properties = {}, reasonCode: code } = packet;

          // * by its own code, which MQTT.js reads in every MQTT 5 CONNACK, before MQTT.js's error:
          // MQTT 5 names none under 0x80 (§3.2.2.2)
          if (code !== undefined && code !== 0) {
            const name =
              code >= 0x80
                ? (mqtt.ReasonCodes as Readonly<Record<number, string | undefined>>)[code]
                : undefined;

            fail(
              new GenericError(
                `its broker refused the link of ${id}: CONNACK ${reasonOf(code)}${name === undefined ? '' : `, ${name}`}`
              )
            );

            return;
          }

          // * its subscriptions and its will are of QoS 1, which a broker of Maximum QoS 0 refuses
          if (properties.maximumQoS === 0) {
            fail(
              new GenericError(`the broker of ${id} says Maximum QoS 0, and its link is of QoS 1`)
            );

            return;
          }

          isSettled = true;
          PLATFORM_CLOCK.clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          held.maximumPacketSize = properties.maximumPacketSize ?? LARGEST_PACKET_SIZE;
          held.receiveMaximum = properties.receiveMaximum ?? RECEIVE_MAXIMUM;
          held.isSharedRefused = properties.sharedSubscriptionAvailable === false;
          lastMaximumPacketSize = held.maximumPacketSize;
          // * up as its CONNACK is read, whatever comes after it (spec 15.26)
          held.isLinked = true;
          // * its link lost: once, as its network connection ends, unless it was stopped
          client.on('close', () => {
            retire(held, new GenericError(`the link of ${id} went down`));
          });

          // * its start is over: its down's listener may start anew
          if (asking === ask) {
            asking = undefined;
            isStarting = false;
          }

          resolve();

          // ! its parser tells its refusal of a packet as it reads it, ahead of the CONNACK it read
          // before in that read, which MQTT.js handles after: its link up, then lost once MQTT.js
          // handled that CONNACK, which would otherwise arm its Keep Alive on an ended client
          const lost = unreadable;

          if (lost !== undefined) {
            queueMicrotask(() => {
              retire(held, lost);
            });
          }
        });
        client.connect();
        guardPacketSize(client.stream, {
          maximumPacketSize,
          // * its start failed where no CONNACK put its link up, its link lost once one did
          onPastMaximum: (size) => {
            const error = new GenericError(
              `the link of ${id} went down: its broker sent a packet of ${String(size)} bytes, past its Maximum Packet Size, ${String(maximumPacketSize)} bytes`
            );

            fail(error);
            retire(held, error);
          },
        });
      });
    } catch (reason) {
      retire(held, toError(reason));

      throw toError(reason);
    }
  };

  const adapter: IMqttBrokerAdapter = {
    capabilities,
    delivery,
    id,
    isSecure: protocol === 'mqtts:' || isSecureUrl(url),
    type: TRANSPORT_MQTT,
    get isLinked() {
      return live() !== undefined;
    },
    get unsettled() {
      return unsettled;
    },

    // * the last link's bound while it is down, a start under way among it
    maximumPayloadBytes: (topic) => {
      return (
        largestPayload(topicOf(topic), live()?.maximumPacketSize ?? lastMaximumPacketSize, {
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
            incarnation.drained?.();
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

      const ask = new AbortController();

      asking = ask;

      try {
        await linkWith(startOptions?.will, { ask, signal: startOptions?.signal });
      } finally {
        // * a start its stop ended no longer holds the next
        if (asking === ask) {
          asking = undefined;
          isStarting = false;
        }

        // ! its provider's signal aborted once its start ended, linked or not, in a later turn,
        // so that its listeners run outside the start's own stack
        if (passwordProvider !== undefined) {
          PLATFORM_CLOCK.setTimeout(() => {
            ask.abort();
          }, 0);
        }
      }
    },
    stop: async () => {
      const incarnation = current;

      starts += 1;

      // * a start that asks its password ends at once, whether or not its provider hears its
      // signal, and the next start links and asks anew
      if (asking !== undefined) {
        asking.abort(new GenericError(`the link of ${id} stopped as it started`));
        asking = undefined;
        isStarting = false;
      }

      if (incarnation === undefined) {
        return;
      }

      incarnation.ending ??= endOf(incarnation);
      await incarnation.ending;
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

      const key = topicOf(topic);
      const filter = group === undefined ? key : groupFilterOf(group, topic);

      return awaited<void>(incarnation, {
        begin: ({ reject, resolve }) => {
          // * recorded as its SUBSCRIBE goes, so that a stop before its SUBACK lets it go: its
          // broker, reading the link's packets in their order, installs it before that UNSUBSCRIBE
          const record = { filter };

          incarnation.filters.set(key, record);
          incarnation.client.subscribe(
            filter,
            { nl: false, qos: 1, rap: false, rh: 2 },
            (...[error, , suback]: [unknown, unknown, { granted?: unknown } | undefined]) => {
              // * the SUBACK's own code: MQTT.js gives back what was asked beside a failure
              const code = (suback?.granted as number[] | undefined)?.[0];

              if (code === 1) {
                resolve();

                return;
              }

              // ! kept where its broker may hold it, QoS 0 granted among them, which its stop lets
              // go; a code of 0x80 or more installed nothing
              if (code !== undefined && code >= 0x80 && incarnation.filters.get(key) === record) {
                incarnation.filters.delete(key);
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
      const record = incarnation.filters.get(key);
      const filter = record?.filter ?? key;
      let timer: ReturnType<typeof PLATFORM_CLOCK.setTimeout> | undefined;

      return awaited<void>(incarnation, {
        begin: ({ reject, resolve }) => {
          // * its UNSUBACK awaited within connectTimeout, past which it fails, its link kept so that
          // no will goes, and its filter kept, which its stop lets go (spec 15.27)
          timer = PLATFORM_CLOCK.setTimeout(
            () => {
              reject(
                new GenericError(
                  `the subscription of ${id} to ${filter} had no UNSUBACK within ${String(connectTimeout)} ms, its connectTimeout`
                )
              );
            },
            Math.min(connectTimeout, LONGEST_TIMER)
          );
          // ! its request never given up: MQTT.js reads a late UNSUBACK, which drops its record
          incarnation.client.unsubscribe(filter, (error, unsuback) => {
            // * the UNSUBACK's own code: 0x00, or 0x11 where its broker held none, lets it go, and
            // any other refuses it (spec 15.27)
            const code = (unsuback as { granted?: number[] } | undefined)?.granted?.[0] ?? 0;

            if (isFailure(error)) {
              reject(toError(error));
            } else if (code !== REASON.SUCCESS && code !== REASON.NO_SUBSCRIPTION_EXISTED) {
              reject(
                new GenericError(
                  `the broker of ${id} refused to let the subscription to ${filter} go: ${reasonOf(code)}`
                )
              );
            } else {
              // ! the record it let go alone: a SUBSCRIBE asked again meanwhile keeps its own
              if (record !== undefined && incarnation.filters.get(key) === record) {
                incarnation.filters.delete(key);
              }

              resolve();
            }
          });
        },
      }).finally(() => {
        PLATFORM_CLOCK.clearTimeout(timer);
      });
    },
  };

  return adapter;
};
