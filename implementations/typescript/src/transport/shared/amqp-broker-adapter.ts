// ── AMQP broker adapter ───────────────────────────────────────────────────────

// dependencies

import rhea, {
  type Connection,
  type ConnectionOptions,
  type Delivery,
  type EventContext,
  type Receiver,
  type Sender,
  type Session,
} from 'rhea';
import {
  answerDetach,
  bindInbox,
  declareInbox,
  deleteInbox,
  endSession,
  isNone,
  terminusOf,
} from './amqp-management';
import {
  encodeMessage,
  exchangeAddressOf,
  LARGEST_UINT,
  largestPayload,
  MAXIMUM_MESSAGE_SIZE,
  messageBytes,
  queueAddressOf,
  topicOf,
} from './amqp-messages';
import { assertHeldFinite, LONGEST_TIMER, PLATFORM_CLOCK } from './clock';
import { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_AMQP } from './constants';
import { createEmitter } from './emitter';
import { GenericError, ProgrammerError, toCancelError, toError } from './errors';
import { isSecureUrl } from './secure';
import type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPublication,
  IBrokerSubscription,
} from './types';

export { MAXIMUM_MESSAGE_SIZE } from './amqp-messages';
export { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_AMQP } from './constants';
export type { BrokerDelivery, BrokerPublished, BrokerTopic, IBrokerAdapter } from './types';

// interfaces

export interface IAmqpBrokerAdapterOptions {
  /**
   * How long its start waits for its broker's OPEN and its sessions, its inbox's subscription for
   * its declaration, its binding and its receiver, and its inbox's deletion; how long a name's
   * let-go waits for what it handed on to be settled and its DETACH answered, past which its link
   * is lost; and its stop; in milliseconds (spec 15.34, 15.37). Defaults to
   * {@link CONNECT_TIMEOUT}.
   */
  connectTimeout?: number | undefined;
  /** At least once by default, each transfer unsettled; at most once, each settled (spec 15.35). */
  delivery?: BrokerDelivery | undefined;
  /** Its participant's id: the user its broker authenticates it as, and its OPEN's container-id. */
  id: string;
  /**
   * Its OPEN's idle-time-out, in milliseconds, from 1 to 1,073,741,823: it counts its link lost once
   * nothing came for twice it (spec 15.33). Defaults to {@link IDLE_TIMEOUT}.
   */
  idleTimeout?: number | undefined;
  /**
   * The credit it grants its inbox's receiver as it attaches, a whole number from 1 to
   * 2,147,483,647, a name's being 1; one more on each as each message is settled (spec 15.34,
   * 15.37). Defaults to {@link LINK_CREDIT}.
   */
  linkCredit?: number | undefined;
  /**
   * The largest message, as its publisher writes it, whose payload it takes: its receive bound's, a
   * whole number from 1 to 4,294,967,295 (spec 15.37). Defaults to {@link MAXIMUM_MESSAGE_SIZE}.
   */
  maximumMessageSize?: number | undefined;
  /**
   * Its password, SASL PLAIN's under its id; or asked at each link's start, so that one that expires
   * renews with each incarnation. None where its TLS client certificate authenticates it.
   */
  password?: string | (() => Promise<string> | string) | undefined;
  /**
   * Its TLS client certificate and key, which its broker maps to its id by SASL EXTERNAL, over
   * `amqps`; and the authority its broker's own certificate is trusted by, where not the platform's.
   */
  tls?:
    | {
        ca?: string | Uint8Array | undefined;
        cert: string | Uint8Array;
        key: string | Uint8Array;
      }
    | undefined;
  /** Its broker: `amqp://` or `amqps://`. */
  url: string;
  /** The virtual host its OPEN's hostname names, `vhost:` and it; its broker's default where none. */
  virtualHost?: string | undefined;
}

/** An adapter over AMQP 1.0 (spec 15.32 to 15.38): an adapter as any, its settlements counted. */
export interface IAmqpBrokerAdapter extends IBrokerAdapter {
  /** Whether its link is up: its broker's OPEN read and its inbox's receiver attached, and neither stopped nor lost since (spec 15.33). */
  readonly isLinked: boolean;
  /** The messages it handed its participant at least once that are not settled yet. */
  readonly unsettled: number;
}

// a receiver and its session: the inbox's, or a name's, its own
interface IReceiving {
  /** Told once it is let go and every message its receiver handed on was settled. */
  drained: (() => void) | undefined;
  /** The messages its receiver handed on at least once that are not settled yet. */
  handedOn: number;
  /** An inbox's deletion under way, or done: its receiver's DETACH that follows is no loss. */
  isDeleting: boolean;
  /** A name let go as asked: none handed on or credited after, and its loss no loss. */
  isLeaving: boolean;
  receiver: Receiver | undefined;
  session: Session | undefined;
  readonly topic: BrokerTopic;
}

// a sender to the anonymous terminus, on its session: the inboxes', or the names'
interface ISending {
  isAttached: boolean;
  isEnded: boolean;
  /** Its ATTACH answered with no target: refused, its DETACH to follow. */
  isRefused: boolean;
  /** Its ATTACH's max-message-size, the bound of what it publishes; none named, the largest uint. */
  maximumMessageSize: number;
  /** Its transfers unsettled, by their delivery, until their outcome comes. */
  readonly pending: Map<
    Delivery,
    (outcome: { error?: Error; published?: BrokerPublished }) => void
  >;
  readonly sender: Sender;
  /** The transfers it asked of rhea, written or not. */
  sent: number;
  readonly session: Session;
  /** Its publications waiting on its credit, in their order. */
  readonly waiting: { readonly fail: (error: Error) => void; readonly send: () => void }[];
}

// one network connection, from its OPEN to its end: every callback of a former one does nothing
interface IIncarnation {
  /** Its broker's OPEN's channel-max: its sessions number one more at most. */
  channelMax: number;
  readonly connection: Connection;
  /** What its awaited operations are failed with as it ends. */
  readonly failures: Set<(error: Error) => void>;
  inbox: IReceiving | undefined;
  /** The session its inbox's receiver is held on. */
  inboxSession: Session | undefined;
  /** Open, its OPEN read and its sessions begun, and not ended: what is asked of it goes. */
  isLinked: boolean;
  isRetired: boolean;
  /** Up, once its inbox's receiver attached, and not ended: its end then its link lost (spec 15.33). */
  isUp: boolean;
  /** Each name's receiver, by its topic. */
  readonly names: Map<string, IReceiving>;
  /** Each name's subscription under way, by its topic, until its ATTACH is answered. */
  readonly pending: Map<
    string,
    { readonly attached: Promise<void>; isGivenUp: boolean; readonly receiving: IReceiving }
  >;
  /** The names whose receiver its broker ended and it attached again: a second loss is the link's. */
  readonly reattached: Set<string>;
  /** Its two sending sessions: to inboxes, and to names. */
  readonly sending: { inboxes: ISending | undefined; names: ISending | undefined };
}

type SendingKind = keyof IIncarnation['sending'];

// constants

/** How long a start waits for its broker's OPEN and its sessions, by default: 30 seconds (spec 15.37). */
export const CONNECT_TIMEOUT = 30_000;

/** Its idle-time-out, by default: 30 seconds, its link counted lost silent for twice it (spec 15.37). */
export const IDLE_TIMEOUT = 30_000;

/** The credit its inbox's receiver grants, by default: 1,000 messages (spec 15.37). */
export const LINK_CREDIT = 1_000;

// ! AMQP's link-credit is a uint, AMQPNetLite's credit an int: both sides hold it to the int's
// range (docs/support.md, Leveled down)
const LARGEST_CREDIT = 2_147_483_647;

// the longest idle-time-out it announces: twice it still holds in a platform's timer (spec 15.37)
const LONGEST_IDLE_TIMEOUT = 1_073_741_823;

// the sessions beside its names: its inbox's, its two sending ones, and one for its management
const SESSIONS_BESIDE_NAMES = 4;

// a Data section's described type, the one body a parcel is (AMQP 1.0 Messaging §3.2.6)
const DATA_SECTION = 0x75;

const ALL_CAPABILITIES = Object.freeze({ expiry: true, groups: true, will: false });

const encoder = new TextEncoder();

// the constructor rhea decodes each body section as, so that a value that merely looks like one is none
const SECTION = Object.getPrototypeOf(rhea.message.data_section(Buffer.alloc(0))) as object;

// helpers

const isNode = (): boolean => {
  return (
    typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions
      ?.node === 'string'
  );
};

// the condition and description an ended endpoint carries, as a refusal names it
const conditionOf = (error: unknown): string => {
  const { condition, description, message } = (error ?? {}) as {
    condition?: unknown;
    description?: unknown;
    message?: unknown;
  };

  if (typeof condition !== 'string') {
    return typeof message === 'string' ? message : 'no error';
  }

  return typeof description === 'string' && description !== ''
    ? `${condition}, ${description}`
    : condition;
};

// a life in whole milliseconds, rounded up, 1 at least and the largest uint at most (spec 15.35)
const ttlOf = (milliseconds: number): number => {
  return Math.min(LARGEST_UINT, Math.max(1, Math.ceil(milliseconds)));
};

// the payload of a message that is one Data section, or none
const payloadOf = (message: unknown): Uint8Array | undefined => {
  const body = (message as { body?: unknown } | undefined)?.body;

  if (
    body === null ||
    typeof body !== 'object' ||
    Object.getPrototypeOf(body) !== SECTION ||
    (body as { typecode?: unknown }).typecode !== DATA_SECTION ||
    (body as { multiple?: unknown }).multiple === true
  ) {
    return undefined;
  }

  const { content } = body as { content?: unknown };

  return content instanceof Uint8Array ? content : undefined;
};

// a max-message-size an ATTACH named: none, or 0, is no maximum (AMQP 1.0 §2.7.3)
const boundOf = (named: unknown): number => {
  return typeof named === 'number' && named > 0 ? named : LARGEST_UINT;
};

/** `idleTimeout` held: a number of milliseconds from 1 to 1,073,741,823, never 0 nor without end. */
const assertIdleTimeout = (duration: unknown): number => {
  if (typeof duration !== 'number' || !(duration >= 1 && duration <= LONGEST_IDLE_TIMEOUT)) {
    const written = typeof duration === 'string' ? JSON.stringify(duration) : String(duration);

    throw new ProgrammerError(
      `idleTimeout is a number of milliseconds from 1 to ${String(LONGEST_IDLE_TIMEOUT)}, not ${written}`
    );
  }

  return Math.round(duration);
};

/** A count held: a whole number from 1 to `largest`. */
const assertCount = (name: string, { largest, value }: { largest: number; value: unknown }) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > largest) {
    throw new ProgrammerError(
      `${name} is a whole number from 1 to ${String(largest)}, not ${String(value)}`
    );
  }

  return value as number;
};

// ! a connection ended at once: its CLOSE written, then its socket aborted, so that a broker that no
// longer answers holds nothing of it, and rhea's timers end with it
const abandon = (connection: Connection): void => {
  try {
    connection.close();
  } catch {
    // its socket never opened
  }

  setImmediate(() => {
    const { abort_socket: abort, socket } = connection as unknown as {
      abort_socket?: (socket: unknown) => void;
      socket?: unknown;
    };

    if (socket !== undefined) {
      abort?.call(connection, socket);
      // ! rhea lets go of its socket's errors as it aborts it: a write still under way fails unheard
      (socket as { on?: (event: string, listener: () => void) => void }).on?.('error', () => {
        // the connection is abandoned
      });
    }
  });
};

// definition

/**
 * An adapter of RabbitMQ 4 over AMQP 1.0 and rhea (spec 15.32 to 15.38; decision 0043): each start a
 * new network connection, its container-id its id, authenticated by SASL PLAIN under its id or by
 * SASL EXTERNAL under its TLS client certificate, its idle-time-out its own, which no library
 * reconnects, recovers or holds anything for while down. On it a session for its inbox's receiver,
 * one for each name it serves, one sending to inboxes and one sending to names, each to the
 * anonymous terminus. Its inbox is a queue declared exclusive, classic and not durable through its
 * broker's management on that connection, then bound to its root's topic exchange by its name, so
 * that it ends with it. Each receiver is unsettled, first, of no max-message-size, its credit its
 * own: its inbox's `linkCredit` and a name's 1 as it attaches, and one more as each message is
 * settled `accepted`, never released nor modified; a name is let go within `connectTimeout`, what
 * it handed on settled and its DETACH answered, or its link is lost. Each publication is one
 * message of the profile, counted to its byte and refused past its sender's max-message-size, held
 * to its sender's credit, later ones waiting in their order; `accepted` is taken, `released` no
 * subscriber, any other outcome refuses it. The end of its connection, of its inbox's session or
 * receiver, is its link lost; a name's receiver its broker ends is attached again once, on a
 * session of its own. No link of an id takes another over. Its leg is secure under TLS or to the
 * loopback; it runs in Node alone.
 *
 * @example
 * const adapter = createAmqpBrokerAdapter({ id: 'server', password, url: 'amqps://broker:5671' });
 * const participant = createBrokerParticipant({ adapter });
 */
export const createAmqpBrokerAdapter = (options: IAmqpBrokerAdapterOptions): IAmqpBrokerAdapter => {
  const {
    delivery = BROKER_DELIVERIES.AT_LEAST_ONCE,
    id,
    password,
    tls,
    url,
    virtualHost,
  } = options;
  const idleTimeout = assertIdleTimeout(options.idleTimeout ?? IDLE_TIMEOUT);
  const connectTimeout = assertHeldFinite(
    'connectTimeout',
    options.connectTimeout ?? CONNECT_TIMEOUT
  );
  const linkCredit = assertCount('linkCredit', {
    largest: LARGEST_CREDIT,
    value: options.linkCredit ?? LINK_CREDIT,
  });
  const maximumMessageSize = assertCount('maximumMessageSize', {
    largest: LARGEST_UINT,
    value: options.maximumMessageSize ?? MAXIMUM_MESSAGE_SIZE,
  });

  if (typeof id !== 'string' || id.length === 0) {
    throw new ProgrammerError(
      `an AMQP 1.0 adapter's id is the user its broker authenticates, not ${JSON.stringify(id)}`
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new ProgrammerError(`an AMQP 1.0 adapter's url is amqp or amqps, not ${url}`);
  }

  // * no open-source RabbitMQ 4 carries AMQP 1.0 over a WebSocket, so no page reaches one
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    throw new ProgrammerError(
      `an AMQP 1.0 adapter's url is amqp or amqps, not ${url}: RabbitMQ 4 carries AMQP 1.0 over no WebSocket`
    );
  }

  if (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') {
    throw new ProgrammerError(`an AMQP 1.0 adapter's url is amqp or amqps, not ${url}`);
  }

  if (!isNode()) {
    throw new ProgrammerError(
      'an AMQP 1.0 adapter runs in Node alone: a page opens no TCP connection, and RabbitMQ 4 carries AMQP 1.0 over no WebSocket'
    );
  }

  if (tls !== undefined && parsed.protocol !== 'amqps:') {
    throw new ProgrammerError(`a TLS client certificate is carried over amqps, not ${url}`);
  }

  const isAtMostOnce = delivery === BROKER_DELIVERIES.AT_MOST_ONCE;
  const isTls = parsed.protocol === 'amqps:';
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = parsed.port === '' ? (isTls ? 5671 : 5672) : Number(parsed.port);
  const emitter = createEmitter<{ down: [IBrokerDown]; message: [IBrokerMessage] }>();
  const capabilities = Object.freeze({
    ...ALL_CAPABILITIES,
    // * a settled transfer has no outcome, so no word of a subscriber
    noSubscriber: !isAtMostOnce,
  });
  // * a container of its own, whose errors no endpoint heard are its own: none reaches the process
  const container = rhea.create_container({ id });

  container.on('error', () => {
    // each endpoint's end is heard where it is held
  });

  let current: IIncarnation | undefined;
  // each start and each stop its own, so that a stop as a start asks its password ends that start
  let starts = 0;
  let isStarting = false;
  // what its last link's senders' ATTACHes said, read while it is down
  const lastBounds: Record<SendingKind, number> = { inboxes: LARGEST_UINT, names: LARGEST_UINT };
  let unsettled = 0;

  const notUp = (): GenericError => {
    return new GenericError(`the link of ${id} is not up`);
  };

  const live = (): IIncarnation | undefined => {
    return current?.isLinked === true && !current.isRetired ? current : undefined;
  };

  const kindOf = (topic: BrokerTopic): SendingKind => {
    return topic[1] === 'i' ? 'inboxes' : 'names';
  };

  // what each sending session holds failed, it let go
  const endSending = (sending: ISending, error: Error): void => {
    if (sending.isEnded) {
      return;
    }

    sending.isEnded = true;

    for (const { fail } of sending.waiting.splice(0)) {
      fail(error);
    }

    for (const settle of sending.pending.values()) {
      settle({ error });
    }

    sending.pending.clear();
  };

  // * an incarnation ended: what it awaits failed, what it holds let go, its connection abandoned;
  // `down` told once, where it was up
  const retire = (incarnation: IIncarnation, error: Error): void => {
    if (incarnation.isRetired) {
      return;
    }

    const wasUp = incarnation.isUp;

    incarnation.isRetired = true;
    incarnation.isLinked = false;
    incarnation.isUp = false;

    for (const fail of incarnation.failures) {
      fail(error);
    }

    incarnation.failures.clear();

    for (const sending of Object.values(incarnation.sending)) {
      if (sending !== undefined) {
        endSending(sending, error);
      }
    }

    abandon(incarnation.connection);

    if (current === incarnation) {
      current = undefined;
      unsettled = 0;
    }

    if (wasUp) {
      emitter.emit('down', { isTakenOver: false });
    }
  };

  // an operation of `incarnation`, failed as it ends, given up as `signal` aborts, `onAbort` then
  // undoing what it began
  const awaited = <T>(
    incarnation: IIncarnation,
    {
      begin,
      onAbort,
      signal,
    }: {
      begin: (settle: { reject: (error: Error) => void; resolve: (value: T) => void }) => void;
      onAbort?: ((error: Error) => void) | undefined;
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
          onAbort?.(error);
        }
      };

      if (signal?.aborted === true) {
        reject(toCancelError(signal));

        return;
      }

      if (incarnation.isRetired) {
        reject(notUp());

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

  // a session begun, settled once its broker's BEGIN came, failed as it ends first
  const begun = (session: Session): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      session.once('session_open', () => {
        resolve();
      });
      session.once('session_close', (context: EventContext) => {
        reject(
          new GenericError(
            `a session of ${id} ended as it began: ${conditionOf(context.session?.error)}`
          )
        );
      });
      session.begin();
    });
  };

  // ! the credit its broker left it: rhea counts a transfer against its credit only once it writes
  // it, a turn after it is asked, so what it was asked and has not written yet is deducted
  const creditOf = (sending: ISending): number => {
    const { credit, delivery_count: transferred } = sending.sender as unknown as {
      credit: number;
      delivery_count: number;
    };

    return credit - (sending.sent - transferred);
  };

  // * the next publications its credit frees, in their order
  const release = (sending: ISending): void => {
    while (
      !sending.isEnded &&
      sending.isAttached &&
      sending.waiting.length > 0 &&
      creditOf(sending) > 0 &&
      sending.sender.sendable()
    ) {
      sending.waiting.shift()?.send();
    }
  };

  // a sending session and its sender to the anonymous terminus, begun; its end refuses what it held
  const openSending = (incarnation: IIncarnation, kind: SendingKind): ISending => {
    const session = incarnation.connection.create_session();
    const sender = session.open_sender({
      rcv_settle_mode: 0,
      snd_settle_mode: isAtMostOnce ? 1 : 0,
      target: {},
      treat_modified_as_released: false,
    });
    const sending: ISending = {
      isAttached: false,
      isEnded: false,
      isRefused: false,
      maximumMessageSize: LARGEST_UINT,
      pending: new Map(),
      sender,
      sent: 0,
      session,
      waiting: [],
    };
    const ended = (context: EventContext): void => {
      const error = context.sender?.error ?? context.session?.error;

      answerDetach(context.sender);

      if (incarnation.sending[kind] === sending) {
        incarnation.sending[kind] = undefined;
      }

      endSending(
        sending,
        new GenericError(
          sending.isRefused
            ? `its broker refused the sender of ${id} to ${kind}: ${conditionOf(error)}`
            : `the broker of ${id} ended the session that sends to ${kind}: ${conditionOf(error)}`
        )
      );

      try {
        session.close();
      } catch {
        // its connection ended
      }
    };
    // * each outcome read on the delivery it names: accepted taken, released no subscriber, any
    // other a refusal naming what it says
    const outcome = (state: 'accepted' | 'modified' | 'rejected' | 'released') => {
      return (context: EventContext): void => {
        const { delivery: settled } = context;
        const settle = settled === undefined ? undefined : sending.pending.get(settled);

        if (settled === undefined || settle === undefined) {
          return;
        }

        sending.pending.delete(settled);

        if (state === 'accepted' || state === 'released') {
          settle({
            published:
              state === 'accepted' ? BROKER_PUBLISHED.TAKEN : BROKER_PUBLISHED.NO_SUBSCRIBER,
          });

          return;
        }

        const { error } = (settled.remote_state ?? {}) as { error?: unknown };

        settle({
          error: new GenericError(
            `the broker of ${id} refused a publication, ${state}${error === undefined || error === null ? '' : `: ${conditionOf(error)}`}`
          ),
        });
      };
    };

    incarnation.sending[kind] = sending;
    session.on('session_close', ended);
    sender.on('sender_close', ended);
    for (const state of ['accepted', 'modified', 'rejected', 'released'] as const) {
      sender.on(state, outcome(state));
    }

    sender.once('sender_open', () => {
      // * an ATTACH that names no target is a refusal, its DETACH to follow (AMQP 1.0 §2.6.3):
      // nothing goes on it, and its end refuses what waits
      if (isNone(terminusOf(sender, 'target'))) {
        sending.isRefused = true;

        return;
      }

      sending.isAttached = true;
      sending.maximumMessageSize = boundOf(sender.max_message_size);
      lastBounds[kind] = sending.maximumMessageSize;
      release(sending);
    });
    sender.on('sendable', () => {
      release(sending);
    });
    session.begin();

    return sending;
  };

  // * a message handed on with its topic, its payload no parcel where it is not one Data section or
  // passes its receive bound; settled `accepted` once, on the receiver it came on, one more credit
  // granted
  const handOn = (
    incarnation: IIncarnation,
    { context, receiving }: { context: EventContext; receiving: IReceiving }
  ): void => {
    const { delivery: received, message, receiver } = context;
    const payload = payloadOf(message);
    const isTaken =
      payload !== undefined && payload.length <= adapter.receiveBound(receiving.topic);
    const isSettledAlready = received?.remote_settled === true;
    let isSettled = false;

    if (!isSettledAlready) {
      unsettled += 1;
      receiving.handedOn += 1;
    }

    emitter.emit('message', {
      payload: isTaken ? new Uint8Array(payload) : new Uint8Array(0),
      settle: () => {
        if (isSettled) {
          return;
        }

        isSettled = true;

        // * a message of a lost receiver is never settled on its successor, nor on it once it
        // ended, what it handed on counted no more
        if (
          current !== incarnation ||
          incarnation.isRetired ||
          receiving.receiver !== receiver ||
          receiver === undefined ||
          !receiver.is_open()
        ) {
          return;
        }

        if (!isSettledAlready) {
          unsettled -= 1;
          receiving.handedOn -= 1;
          received?.accept();
        }

        if (!receiving.isLeaving) {
          receiver.add_credit(1);
        } else if (receiving.handedOn === 0) {
          receiving.drained?.();
        }
      },
      topic: receiving.topic,
    });
  };

  // a receiver of `receiving`'s queue on `session`, held once its ATTACH named its source and its
  // credit went; refused as its ATTACH names none and a DETACH follows, or as its session ends
  const attach = (
    incarnation: IIncarnation,
    {
      onLost,
      receiving,
      session,
    }: { onLost: (condition: string) => void; receiving: IReceiving; session: Session }
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let isHeld = false;
      let isEnded = false;
      const receiver = session.open_receiver({
        autoaccept: false,
        credit_window: 0,
        rcv_settle_mode: 0,
        snd_settle_mode: isAtMostOnce ? 1 : 0,
        source: { address: queueAddressOf(receiving.topic) },
      });
      const ended = (error: unknown): void => {
        if (isEnded) {
          return;
        }

        isEnded = true;

        // * what it handed on is settled on it no more, nor counted
        if (receiving.receiver === receiver) {
          if (current === incarnation && !incarnation.isRetired) {
            unsettled -= receiving.handedOn;
          }

          receiving.handedOn = 0;
        }

        const condition = conditionOf(error);

        if (isHeld) {
          onLost(condition);
        } else {
          reject(
            new GenericError(
              `the broker of ${id} refused the subscription to ${topicOf(receiving.topic)}: ${condition}`
            )
          );
        }
      };

      receiving.receiver = receiver;
      receiving.handedOn = 0;
      receiving.session = session;
      session.on('session_close', (context: EventContext) => {
        ended(context.session?.error);
      });
      receiver.on('receiver_close', (context: EventContext) => {
        answerDetach(receiver);
        ended(context.receiver?.error);
      });
      receiver.on('message', (context: EventContext) => {
        // * none handed on once let go: unsettled, it goes back to its queue
        if (!incarnation.isRetired && receiving.receiver === receiver && !receiving.isLeaving) {
          handOn(incarnation, { context, receiving });
        }
      });
      receiver.once('receiver_open', () => {
        const source = (receiver as unknown as { remote?: { attach?: { source?: unknown } } })
          .remote?.attach?.source;

        // * an ATTACH that names no source is a refusal, its DETACH to follow (AMQP 1.0 §2.6.3)
        if (isNone(source) || isEnded) {
          return;
        }

        // * its inbox's receiver `linkCredit`; a name's 1, so that its queue hands a member one
        // OPEN at a time, the others waiting there for whichever member reads next (AMQP 1.0
        // §2.6.7)
        receiver.add_credit(receiving.topic[1] === 'i' ? linkCredit : 1);
        isHeld = true;
        resolve();
      });
    });
  };

  // a receiver's DETACH, asked: whatever came after is its own
  const close = (endpoint: Receiver | undefined): void => {
    try {
      endpoint?.close();
    } catch {
      // its connection ended
    }
  };

  // * a held name's receiver its broker ended: attached again once, on a fresh session, its core
  // told nothing; that refused, or the name lost again on this link, is the link lost
  const lostName = (incarnation: IIncarnation, receiving: IReceiving) => {
    return (condition: string): void => {
      const key = topicOf(receiving.topic);

      endSession(receiving.session);

      if (receiving.isLeaving || incarnation.isRetired) {
        return;
      }

      if (incarnation.reattached.has(key)) {
        retire(
          incarnation,
          new GenericError(`the link of ${id} lost the name ${key} twice: ${condition}`)
        );

        return;
      }

      incarnation.reattached.add(key);

      const session = incarnation.connection.create_session();

      session.begin();
      // ! a name let go meanwhile is never attached again: its let-go ended this session, which is
      // no loss
      attach(incarnation, { onLost: lostName(incarnation, receiving), receiving, session }).catch(
        (reason: unknown) => {
          if (!receiving.isLeaving) {
            retire(
              incarnation,
              new GenericError(
                `the link of ${id} could not attach the name ${key} again: ${toError(reason).message}`
              )
            );
          }
        }
      );
    };
  };

  // * its inbox: declared exclusive on its own connection, bound to its root's exchange by its own
  // name, then its receiver attached; any refusal or end meanwhile retires the link, the queue
  // ending with its connection
  const subscribeInbox = (
    incarnation: IIncarnation,
    { signal, topic }: { signal?: AbortSignal | undefined; topic: BrokerTopic }
  ): Promise<void> => {
    const queue = topicOf(topic);
    const receiving: IReceiving = {
      drained: undefined,
      handedOn: 0,
      isDeleting: false,
      isLeaving: false,
      receiver: undefined,
      session: undefined,
      topic,
    };
    const exchange = topic[0] ?? '';
    const retiring = (error: Error): void => {
      retire(incarnation, new GenericError(`the link of ${id} was retired: ${error.message}`));
    };
    let timer: ReturnType<typeof PLATFORM_CLOCK.setTimeout> | undefined;

    return awaited<void>(incarnation, {
      begin: ({ reject, resolve }) => {
        timer = PLATFORM_CLOCK.setTimeout(
          () => {
            const error = new GenericError(
              `the inbox of ${id} was not held within ${String(connectTimeout)} ms`
            );

            reject(error);
            retiring(error);
          },
          Math.min(connectTimeout, LONGEST_TIMER)
        );
        const failed = (reason: unknown): void => {
          const error = toError(reason);

          reject(error);
          retiring(error);
        };
        const session = incarnation.inboxSession;

        if (session === undefined) {
          failed(notUp());

          return;
        }

        incarnation.inbox = receiving;
        declareInbox(incarnation.connection, { queue, signal })
          .then(() => {
            return bindInbox(incarnation.connection, { exchange, queue, signal });
          })
          .then(() => {
            if (incarnation.isRetired) {
              throw notUp();
            }

            return attach(incarnation, {
              onLost: (condition) => {
                if (!receiving.isDeleting) {
                  retire(
                    incarnation,
                    new GenericError(`the link of ${id} lost its inbox: ${condition}`)
                  );
                }
              },
              receiving,
              session,
            });
          })
          .then(() => {
            // * up once its inbox's receiver attached, not before
            incarnation.isUp = !incarnation.isRetired;
            resolve();
          }, failed);
      },
      onAbort: retiring,
      signal,
    }).finally(() => {
      PLATFORM_CLOCK.clearTimeout(timer);
    });
  };

  // * a name: a receiver of its queue on a session of its own, its group the queue itself; one met
  // under way is waited for, held once its ATTACH named its source
  const subscribeName = (
    incarnation: IIncarnation,
    { signal, topic }: { signal?: AbortSignal | undefined; topic: BrokerTopic }
  ): Promise<void> => {
    const key = topicOf(topic);
    const held = incarnation.names.get(key);

    if (held !== undefined && !held.isLeaving) {
      return Promise.resolve();
    }

    const pending = incarnation.pending.get(key);

    if (pending !== undefined) {
      // ! one an unsubscription met before this came, or one given up, is never held: the name is
      // then subscribed anew; any other's outcome is this one's
      const isMet = pending.receiving.isLeaving;
      const again = (): Promise<void> => {
        return subscribeName(incarnation, { signal, topic });
      };

      return awaited<void>(incarnation, {
        begin: ({ reject, resolve }) => {
          pending.attached
            .then(
              () => {
                return isMet ? again() : undefined;
              },
              (reason: unknown) => {
                if (isMet || pending.isGivenUp) {
                  return again();
                }

                throw reason;
              }
            )
            .then(resolve, (reason: unknown) => {
              reject(toError(reason));
            });
        },
        signal,
      });
    }

    // ! past its broker's channel-max no session begins: refused before one is asked
    if (
      incarnation.names.size + incarnation.pending.size + SESSIONS_BESIDE_NAMES >=
      incarnation.channelMax + 1
    ) {
      return Promise.reject(
        new GenericError(
          `the broker of ${id} gives ${String(incarnation.channelMax + 1)} sessions a connection, its channel-max ${String(incarnation.channelMax)}, so no session for ${key}`
        )
      );
    }

    const receiving: IReceiving = {
      drained: undefined,
      handedOn: 0,
      isDeleting: false,
      isLeaving: false,
      receiver: undefined,
      session: undefined,
      topic,
    };
    const session = incarnation.connection.create_session();
    const settled = (): void => {
      if (incarnation.pending.get(key)?.receiving === receiving) {
        incarnation.pending.delete(key);
      }
    };
    const forget = (): void => {
      settled();
      receiving.isLeaving = true;
      endSession(session);
    };
    const attached = awaited<void>(incarnation, {
      begin: ({ reject, resolve }) => {
        session.begin();
        attach(incarnation, { onLost: lostName(incarnation, receiving), receiving, session }).then(
          () => {
            settled();

            // * one an unsubscription met as it attached is that unsubscription's to let go
            if (!receiving.isLeaving) {
              incarnation.names.set(key, receiving);
            }

            resolve();
          },
          (reason: unknown) => {
            forget();
            reject(toError(reason));
          }
        );
      },
      onAbort: () => {
        entry.isGivenUp = true;
        forget();
      },
      signal,
    });
    const entry = { attached, isGivenUp: false, receiving };

    if (!incarnation.isRetired && signal?.aborted !== true) {
      incarnation.pending.set(key, entry);
    }

    return attached;
  };

  // * a name let go within one connectTimeout: its DETACH once what its receiver handed on was
  // settled, then its session ended once its broker answered it; past that bound, its link lost
  const letGo = (incarnation: IIncarnation, receiving: IReceiving): Promise<void> => {
    const key = topicOf(receiving.topic);
    let timer: ReturnType<typeof PLATFORM_CLOCK.setTimeout> | undefined;

    return awaited<void>(incarnation, {
      begin: ({ resolve }) => {
        const { receiver, session } = receiving;
        const done = (): void => {
          endSession(session);
          resolve();
        };
        // * once: its drain is told no more as its DETACH goes
        const detach = (): void => {
          receiving.drained = undefined;
          receiver?.once('receiver_close', done);
          session?.once('session_close', done);
          close(receiver);
        };

        if (receiver === undefined || !receiver.is_open()) {
          done();

          return;
        }

        // ! what it handed on is settled before its DETACH goes: one detached unsettled goes back
        // to its queue, and an OPEN whose connection its server took and has since closed would be
        // answered anew, its pair gone
        timer = PLATFORM_CLOCK.setTimeout(
          () => {
            retire(
              incarnation,
              new GenericError(
                `the link of ${id} was lost: it let the name ${key} go within no ${String(connectTimeout)} ms, its connectTimeout`
              )
            );
          },
          Math.min(connectTimeout, LONGEST_TIMER)
        );

        if (receiving.handedOn === 0) {
          detach();

          return;
        }

        receiving.drained = detach;
      },
    }).finally(() => {
      PLATFORM_CLOCK.clearTimeout(timer);
    });
  };

  const ending = (incarnation: IIncarnation) => {
    return (context: EventContext): void => {
      const error = context.connection.error ?? context.error;
      const said = error === undefined ? '' : `: ${conditionOf(error)}`;

      retire(
        incarnation,
        new GenericError(
          incarnation.isLinked
            ? `the link of ${id} went down${said}`
            : `the link of ${id} ended as it started${said}`
        )
      );
    };
  };

  const linkWith = async (signal: AbortSignal | undefined): Promise<void> => {
    const asked = starts;
    const secret = typeof password === 'function' ? await password() : password;

    if (asked !== starts) {
      throw new GenericError(`the link of ${id} stopped as it started`);
    }

    const connectionOptions: ConnectionOptions = {
      container_id: id,
      host,
      id: `${id}-${String(starts)}`,
      idle_time_out: idleTimeout,
      port,
      reconnect: false,
      ...(virtualHost === undefined ? {} : { hostname: `vhost:${virtualHost}` }),
      ...(isTls
        ? {
            servername: host,
            transport: 'tls' as const,
            ...(tls === undefined
              ? {}
              : {
                  cert: tls.cert as never,
                  enable_sasl_external: true,
                  key: tls.key as never,
                  ...(tls.ca === undefined ? {} : { ca: tls.ca as never }),
                }),
          }
        : {}),
      ...(tls === undefined
        ? { username: id, ...(secret === undefined ? {} : { password: secret }) }
        : {}),
    };
    const connection = container.connect(connectionOptions);
    const held: IIncarnation = {
      channelMax: 65_535,
      connection,
      failures: new Set(),
      inbox: undefined,
      inboxSession: undefined,
      isLinked: false,
      isRetired: false,
      isUp: false,
      names: new Map(),
      pending: new Map(),
      reattached: new Set(),
      sending: { inboxes: undefined, names: undefined },
    };

    current = held;
    // * its link lost: once, as its connection ends, unless it was stopped
    connection.on('disconnected', ending(held));
    connection.on('connection_close', ending(held));
    connection.on('error', () => {
      // its end is heard as it disconnects
    });
    connection.on('protocol_error', () => {
      // its end is heard as it disconnects
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = PLATFORM_CLOCK.setTimeout(
          () => {
            fail(
              new GenericError(
                `the link of ${id} had no OPEN and no sessions within ${String(connectTimeout)} ms`
              )
            );
          },
          Math.min(connectTimeout, LONGEST_TIMER)
        );
        let isSettled = false;
        const fail = (error: Error): void => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          PLATFORM_CLOCK.clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          held.failures.delete(fail);
          reject(error);
        };
        const abort = (): void => {
          fail(toCancelError(signal as AbortSignal));
        };

        if (signal?.aborted === true) {
          abort();

          return;
        }

        held.failures.add(fail);
        signal?.addEventListener('abort', abort, { once: true });
        connection.once('connection_open', () => {
          const remote = (
            connection as unknown as { remote?: { open?: { channel_max?: unknown } } }
          ).remote?.open?.channel_max;

          held.channelMax = typeof remote === 'number' ? remote : 65_535;

          const inboxSession = connection.create_session();

          held.inboxSession = inboxSession;
          // * its inbox's session ended is its link lost
          inboxSession.on('session_close', (context: EventContext) => {
            retire(
              held,
              new GenericError(
                `the broker of ${id} ended its inbox's session: ${conditionOf(context.session?.error)}`
              )
            );
          });

          const inboxes = openSending(held, 'inboxes');
          const names = openSending(held, 'names');

          Promise.all([
            begun(inboxSession),
            ...[inboxes, names].map((sending) => {
              return new Promise<void>((attached, refused) => {
                if (sending.isAttached) {
                  attached();

                  return;
                }

                sending.sender.once('sender_open', () => {
                  if (sending.isAttached) {
                    attached();
                  }
                });
                sending.sender.once('sender_close', (context: EventContext) => {
                  if (sending.isRefused) {
                    refused(
                      new GenericError(
                        `its broker refused a sender of ${id}: ${conditionOf(context.sender?.error)}`
                      )
                    );
                  }
                });
                sending.session.once('session_close', (context: EventContext) => {
                  refused(
                    new GenericError(
                      `a sending session of ${id} ended as it began: ${conditionOf(context.session?.error)}`
                    )
                  );
                });
              });
            }),
          ]).then(
            () => {
              if (isSettled) {
                return;
              }

              isSettled = true;
              PLATFORM_CLOCK.clearTimeout(timer);
              signal?.removeEventListener('abort', abort);
              held.failures.delete(fail);
              resolve();
            },
            (reason: unknown) => {
              fail(toError(reason));
            }
          );
        });
      });
    } catch (reason) {
      retire(held, toError(reason));

      throw toError(reason);
    }

    held.isLinked = true;
  };

  const adapter: IAmqpBrokerAdapter = {
    capabilities,
    delivery,
    id,
    isSecure: isTls || isSecureUrl(url),
    type: TRANSPORT_AMQP,
    get isLinked() {
      return live()?.isUp === true;
    },
    get unsettled() {
      return unsettled;
    },

    // * its sender's ATTACH's bound, the last link's while it is down
    maximumPayloadBytes: (topic) => {
      const kind = kindOf(topic);
      const sending = live()?.sending[kind];
      const bound = sending?.isAttached === true ? sending.maximumMessageSize : lastBounds[kind];

      return largestPayload(exchangeAddressOf(topic), bound) ?? 0;
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

      if (signal?.aborted === true) {
        return Promise.reject(toCancelError(signal));
      }

      const kind = kindOf(topic);
      const address = exchangeAddressOf(topic);
      const hasLife = expiresAfter !== undefined;
      const counted = messageBytes(encoder.encode(address).length, payload.length, { hasLife });
      const pastOf = (bound: number): GenericError | undefined => {
        // ! counted before it goes: its broker ends the sending session on one past its bound
        return counted > bound
          ? new GenericError(
              `a message of ${String(counted)} bytes to ${address}, past its sender's max-message-size, ${String(bound)} bytes`
            )
          : undefined;
      };
      const sending = incarnation.sending[kind] ?? openSending(incarnation, kind);
      const past = pastOf(sending.isAttached ? sending.maximumMessageSize : lastBounds[kind]);

      if (past !== undefined) {
        return Promise.reject(past);
      }

      let bytes: Uint8Array;

      try {
        bytes = encodeMessage(address, payload, hasLife ? { ttl: ttlOf(expiresAfter) } : undefined);
      } catch (reason) {
        return Promise.reject(
          new GenericError(
            `a message to ${address} is none of the profile's: ${toError(reason).message}`
          )
        );
      }

      return new Promise<BrokerPublished>((resolve, reject) => {
        let isSent = false;
        let isSettled = false;
        let sent: Delivery | undefined;
        const settle = ({ error, published }: { error?: Error; published?: BrokerPublished }) => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          signal?.removeEventListener('abort', leave);

          if (error !== undefined) {
            reject(error);
          } else {
            resolve(published ?? BROKER_PUBLISHED.TAKEN);
          }
        };
        const entry = {
          fail: (error: Error) => {
            settle({ error });
          },
          send: () => {
            isSent = true;

            const refused = pastOf(sending.maximumMessageSize);

            if (refused !== undefined) {
              settle({ error: refused });

              return;
            }

            sending.sent += 1;
            sent = sending.sender.send(Buffer.from(bytes), undefined, 0);

            if (isAtMostOnce) {
              settle({ published: BROKER_PUBLISHED.TAKEN });
            } else {
              sending.pending.set(sent, settle);
            }
          },
        };
        // * given up, its link kept: one waiting on credit leaves unsent; one sent is forgotten, its
        // outcome its own delivery's, which nothing else reads
        const leave = (): void => {
          if (signal === undefined || isSettled) {
            return;
          }

          if (!isSent) {
            const index = sending.waiting.indexOf(entry);

            if (index !== -1) {
              sending.waiting.splice(index, 1);
            }
          } else if (sent !== undefined) {
            sending.pending.delete(sent);
          }

          settle({ error: toCancelError(signal) });
        };

        signal?.addEventListener('abort', leave, { once: true });
        sending.waiting.push(entry);
        release(sending);
      });
    },
    receiveBound: (topic) => {
      return largestPayload(exchangeAddressOf(topic), maximumMessageSize) ?? 0;
    },
    start: async (startOptions) => {
      if (current !== undefined || isStarting) {
        throw new ProgrammerError(`the link of ${id} is up already`);
      }

      isStarting = true;

      try {
        await linkWith(startOptions?.signal);
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
      incarnation.isRetired = true;
      incarnation.isUp = false;
      current = undefined;
      unsettled = 0;

      const stopped = new GenericError(`the link of ${id} stopped`);

      for (const fail of incarnation.failures) {
        fail(stopped);
      }

      incarnation.failures.clear();

      for (const sending of Object.values(incarnation.sending)) {
        if (sending !== undefined) {
          endSending(sending, stopped);
        }
      }

      const { connection } = incarnation;
      // * one bounded shutdown: what does not come within it is not waited for
      const bounded = Promise.withResolvers<void>();
      const timer = PLATFORM_CLOCK.setTimeout(
        bounded.resolve,
        Math.min(connectTimeout, LONGEST_TIMER)
      );
      const gone = new Promise<void>((resolve) => {
        connection.once('connection_close', () => {
          resolve();
        });
        connection.once('disconnected', () => {
          resolve();
        });
      });

      if (connection.is_open()) {
        // * each receiver detached, its DETACH awaited, then each session ended
        const receivings = [
          ...(incarnation.inbox === undefined ? [] : [incarnation.inbox]),
          ...incarnation.names.values(),
        ];

        await Promise.race([
          bounded.promise,
          gone,
          Promise.all(
            receivings.map(({ receiver }) => {
              return new Promise<void>((resolve) => {
                if (receiver === undefined || !receiver.is_open()) {
                  resolve();

                  return;
                }

                receiver.once('receiver_close', () => {
                  resolve();
                });
                close(receiver);
              });
            })
          ),
        ]);

        for (const { session } of receivings) {
          endSession(session);
        }

        endSession(incarnation.inboxSession);

        for (const sending of Object.values(incarnation.sending)) {
          endSession(sending?.session);
        }

        // * then its CLOSE, of no error, and its peer's awaited
        try {
          connection.close();
        } catch {
          // its socket ended
        }

        await Promise.race([bounded.promise, gone]);
      }

      PLATFORM_CLOCK.clearTimeout(timer);
      abandon(connection);
    },
    subscribe: (topic, subscription?: IBrokerSubscription) => {
      const incarnation = live();

      if (incarnation === undefined) {
        return Promise.reject(notUp());
      }

      // * no will, so no departure
      if (topic[1] === 'd') {
        return Promise.reject(
          new GenericError(`the adapter of ${id} offers no will, so no departure to subscribe`)
        );
      }

      if (topic[1] === 'i') {
        return subscribeInbox(incarnation, { signal: subscription?.signal, topic });
      }

      return subscribeName(incarnation, { signal: subscription?.signal, topic });
    },
    unsubscribe: (topic) => {
      const incarnation = live();

      if (incarnation === undefined) {
        return Promise.reject(notUp());
      }

      const key = topicOf(topic);

      // * an inbox, deleted by its broker's management within connectTimeout, handing on and
      // crediting what comes meanwhile: its receiver's DETACH is no loss
      if (topic[1] === 'i') {
        const inbox = incarnation.inbox;
        const given = new AbortController();
        let timer: ReturnType<typeof PLATFORM_CLOCK.setTimeout> | undefined;

        if (inbox !== undefined) {
          inbox.isDeleting = true;
        }

        return awaited<void>(incarnation, {
          begin: ({ reject, resolve }) => {
            timer = PLATFORM_CLOCK.setTimeout(
              () => {
                reject(
                  new GenericError(
                    `the broker of ${id} answered the deletion of ${key} within no ${String(connectTimeout)} ms, its connectTimeout`
                  )
                );
                given.abort();
              },
              Math.min(connectTimeout, LONGEST_TIMER)
            );
            deleteInbox(incarnation.connection, { queue: key, signal: given.signal }).then(
              () => {
                if (incarnation.inbox === inbox) {
                  incarnation.inbox = undefined;
                }

                // * its messages end with it: its receiver ended at once, where its broker did not
                close(inbox?.receiver);
                resolve();
              },
              (reason: unknown) => {
                // * its deletion refused, its inbox still held: its end is its link lost again
                if (inbox !== undefined) {
                  inbox.isDeleting = false;
                }

                reject(toError(reason));
              }
            );
          },
        }).finally(() => {
          PLATFORM_CLOCK.clearTimeout(timer);
        });
      }

      const receiving = incarnation.names.get(key);

      if (receiving !== undefined) {
        receiving.isLeaving = true;
        incarnation.names.delete(key);

        return letGo(incarnation, receiving);
      }

      const pending = incarnation.pending.get(key);

      if (pending === undefined) {
        return Promise.resolve();
      }

      // * a subscription under way, met: never held, and let go once its ATTACH is answered
      pending.receiving.isLeaving = true;

      return pending.attached.then(
        () => {
          return letGo(incarnation, pending.receiving);
        },
        () => {
          // refused or given up: nothing is held to let go
        }
      );
    },
  };

  return adapter;
};
