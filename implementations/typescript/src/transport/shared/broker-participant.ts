// ── Broker participant ────────────────────────────────────────────────────────

// dependencies

import {
  CloseCode,
  HALF_BYTES,
  hexOfByte,
  INCARNATION_BYTES,
  type IParcel,
  isKindToCome,
  isToken,
  kindNamed,
  LARGEST_RECEIVE_BOUND,
  LEAST_RECEIVE_BOUND,
  type ParcelFields,
  ParcelFlag,
  ParcelKind,
  PARCEL_LAYOUT,
  readParcel,
  writeParcel,
  FIRST_ADVISORY_KIND,
  type IParcelPrefix,
} from './broker-parcel';
import {
  createBrokerParts,
  createBrokerSequence,
  createHeldBytes,
  gapOf,
  HELD_BYTES_BUDGET,
  type IBrokerLoss,
  type IBrokerParts,
  partsOf,
  SEQUENCE_VERDICTS,
} from './broker-sequence';
import { assertHeldDelay, assertHeldFinite, type IClock, PLATFORM_CLOCK } from './clock';
import { BROKER_DELIVERIES, BROKER_PUBLISHED } from './constants';
import { createPromise } from './create-promise';
import { createEmitter } from './emitter';
import { ConnectError, GenericError, notServedOf, ProgrammerError, toError } from './errors';
import { gaugesOf } from './gauges';
import {
  assertHeartbeat,
  createSilenceHeartbeat,
  HEARTBEAT,
  type ISilenceHeartbeat,
} from './heartbeat';
import { noop } from './noop';
import { announceParticipantToDevtools } from './participant-devtools';
import {
  type IParticipantDebugEvent,
  type ParcelVerdict,
  participantHexOf,
  participantParcelOf,
} from './participant-debug';
export { PARCEL_VERDICTS } from './participant-debug';
export type { IParticipantDebugEvent, ParcelVerdict } from './participant-debug';
import type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPeer,
  IGauges,
} from './types';
import { createBrokerTransportClient } from '../client/broker-transport-client';
import type { BrokerTransportClient, IBrokerTransportClientOptions } from '../client/types';
import { createBrokerTransportServer } from '../server/broker-transport-server';
import { assertCount } from '../server/server-bounds';
import type { BrokerTransportServer, IBrokerTransportServerOptions } from '../server/types';

export { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORT_BROKER } from './constants';
export type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
  IBrokerCapabilities,
  IBrokerDown,
  IBrokerMessage,
  IBrokerPeer,
  IBrokerPublication,
  IBrokerStart,
  IBrokerSubscription,
} from './types';

// interfaces

export interface IBrokerParticipantOptions {
  /** Its one link to its broker: the adapter of that broker's client. */
  adapter: IBrokerAdapter;
  /** Announces this participant to the page’s hook unless false; independent of each client’s option. */
  devtools?: boolean | undefined;
  /**
   * Milliseconds from an envelope's first part before `minimumBodyBytesPerSecond` holds its parts,
   * at both ends (spec 15.20): from 1 to 2³¹ − 1, rounded to the nearest whole one; 0 and
   * `Infinity` are refused. Defaults to {@link BODY_GRACE_PERIOD}.
   */
  bodyGracePeriod?: number | undefined;
  /**
   * The clock its parts' rate and its link's reconnection run on, and its transports'; the
   * platform's when not given. Its heartbeat runs on the platform's timer whatever it is.
   */
  clock?: IClock | undefined;
  /**
   * Milliseconds a connection is silent before it is pinged, and a ping unanswered before it is
   * closed with 4001 (spec 15.21): from 1 to 2³¹ − 1, rounded to the nearest whole one, or
   * `Infinity` for none; 0 is refused. Defaults to {@link HEARTBEAT}.
   */
  heartbeat?: number | undefined;
  /**
   * The bytes it holds in parts across its connections; a part past them loses its connection,
   * 4000 (spec 15.20). A whole number above 0. Defaults to {@link HELD_BYTES_BUDGET}.
   */
  heldBytesBudget?: number | undefined;
  /**
   * One envelope's parts together, at most, at both ends; past them its connection closes with
   * 1009 (spec 15.20). A whole number above 0, its router's `maximumEnvelopeBytes` at least.
   * Defaults to {@link MAXIMUM_ENVELOPE_PARTS_BYTES}, the default envelope's limit.
   */
  maximumEnvelopePartsBytes?: number | undefined;
  /**
   * The slowest, in bytes a second, an envelope's parts may come once `bodyGracePeriod` passed, on
   * its clock (spec 15.20): a whole number above 0. Defaults to
   * {@link MINIMUM_BODY_BYTES_PER_SECOND}.
   */
  minimumBodyBytesPerSecond?: number | undefined;
  /**
   * How its link connects again once lost, each time as a new incarnation: `delay` milliseconds
   * between attempts, 1,000 by default, `maxAttempts` attempts, without end by default, `signal`
   * aborted ending them; `false` for none, which leaves it closed once its link is lost.
   */
  reconnect?:
    | false
    | {
        delay?: number | undefined;
        maxAttempts?: number | undefined;
        signal?: AbortSignal | undefined;
      }
    | undefined;
  /**
   * The delivery its application requires: one at least once of an adapter that gives at most once
   * is a {@link ProgrammerError} as it is built (spec 15.19).
   */
  requireDelivery?: BrokerDelivery | undefined;
  /** Its topics' first token, one for every participant of a deployment: `bead` by default. */
  root?: string | undefined;
}

/**
 * One link of a side to a broker (spec 15.16), its connections' inbox: a server's transport over it
 * serves names, and each client's transport over it holds one connection; both draw their
 * connections through it, which numbers their parcels, cuts their envelopes in parts, holds their
 * heartbeat and ends them as its link ends.
 */
export interface IBrokerParticipant {
  readonly adapter: IBrokerAdapter;
  readonly clock: IClock;
  /** Its adapter's id, the identity its broker authenticates its link by. */
  readonly id: string;
  /** Its link's incarnation, drawn as it connected; none before. */
  readonly incarnation: Uint8Array | undefined;
  /** Whether its link is up, its inbox subscribed. */
  readonly isLinked: boolean;
  /** Whether a listener watches its trace of parcels (debugging 13). */
  readonly isDebugging: boolean;
  /** The names its broker holds for it. */
  readonly names: ReadonlySet<string>;
  readonly root: string;
  /**
   * What it holds: `connections`, those open, and `halfOpen`, those whose third leg has not come;
   * `partsBytes`, what it holds in parts, and `unsentBytes`, what waits for its broker, with the
   * largest of each one connection holds; and `departures`, the peers' departures it subscribes.
   */
  gauges(): IGauges;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'debug', listener: (event: IParticipantDebugEvent) => void): this;
  /** What it reports of its own: a message that is no parcel, or its link given up on. */
  on(event: 'error', listener: (error: Error) => void): this;
  /** Each parcel's verdict, its link's transitions, its names and its reports. */
  on(event: 'debug', listener: (event: IParticipantDebugEvent) => void): this;
  /** Starts its link, once: its incarnation drawn, its inbox subscribed. */
  start(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  /** Closes each of its connections with 1001, then ends its link cleanly, so no will goes. */
  stop(): Promise<void>;
  /** A client's transport over it, one connection at a time through a server's name. */
  transportClient(options?: IBrokerTransportClientOptions): BrokerTransportClient;
  /** A server's transport over it, serving the names it is given. */
  transportServer(options: IBrokerTransportServerOptions): BrokerTransportServer;
  [Symbol.asyncDispose](): Promise<void>;
}

/** What owns a connection — a server's transport, a client's — told what befalls it. @internal */
export interface IBrokerConnectionOwner {
  /** Its third leg came, at its acceptor: the connection opens. */
  readonly opened?: (() => void) | undefined;
  /** Its server's handle once drawn, or `server` on a client. */
  readonly connectionHandle?: (() => string | undefined) | undefined;
  /** An envelope came whole, with the credential its DATA carried. */
  envelope(message: { credential?: string | undefined; data: Uint8Array }): void;
  /** It ended: clean by a CLOSE of 1000 alone. */
  end(wasClean: boolean): void;
  /** What it was lost or closed for of its own, before its end. */
  report(error: Error): void;
  /** How a report names it. */
  subject(): string;
}

/** One connection, by both its halves, as its owner reaches it. @internal */
export interface IBrokerConnection {
  readonly acceptor: Uint8Array;
  /** Whether it waits for its third leg, at its acceptor. */
  readonly isHalfOpen: boolean;
  readonly opener: Uint8Array;
  /** What it holds in parts of an envelope coming. */
  readonly partsBytes: number;
  readonly peer: IBrokerPeer;
  /** What its broker has not taken yet of what it published. */
  readonly unsentBytes: number;
  readonly maximumUnsentBytes: number;
  /** Closes it with a CLOSE of `code`, forgotten as it goes; its owner told, clean for 1000 alone. */
  close(code: number): void;
  /** Forgets it, sending nothing: a half-open connection whose third leg never came. */
  forget(): void;
  /** Ends it at once, unclean, by a RESET to its peer. */
  reset(): void;
  /** Sends an envelope, in parts past what its peer takes whole, a credential beside it. */
  send(data: Uint8Array, options?: { credential?: string | undefined }): Promise<void>;
}

/** What a client's connect is told of the answers naming its half. @internal */
export interface IBrokerAnswers {
  accept(parcel: IParcel): void;
  /** Its participant's link went down, or stopped, before an answer came. */
  fail(error: Error): void;
  refuse(parcel: IParcel): void;
}

/** A server's transport, as the OPENs to a name it serves reach it. @internal */
export interface IBrokerServing {
  offer(open: IParcel): void;
}

/** What a participant's transports reach of it. @internal */
export interface IBrokerParticipantPort {
  readonly adapter: IBrokerAdapter;
  readonly clock: IClock;
  readonly id: string;
  /** Its own leg, as an OPEN or an ACCEPT marks it. */
  readonly isSecure: boolean;
  /** The names it holds a subscription to. */
  readonly names: ReadonlySet<string>;
  /** Waits for answers naming `opener`'s half, until the returned function lets it go. */
  awaitAnswers(opener: Uint8Array, answers: IBrokerAnswers): () => void;
  /**
   * A connection, by both halves: at its acceptor half-open, its ACCEPT sent, marked secure as
   * `isSecure` says of its own leg, its adapter's unless told; at its opener open, its third leg
   * sent.
   */
  connect(
    pair: { acceptor: Uint8Array; isOpener: boolean; opener: Uint8Array; peer: IBrokerPeer },
    options: {
      isSecure?: boolean | undefined;
      maximumUnsentBytes: number;
      owner: IBrokerConnectionOwner;
    }
  ): IBrokerConnection;
  /** A half, 8 bytes from a cryptographic source, never all zero, none it holds. */
  drawHalf(): Uint8Array;
  /**
   * Resolves once its link is up, starting it the first time; `isStart`, its application's start,
   * links anew a participant whose link was taken over, which nothing else does.
   */
  linked(options?: {
    isStart?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<void>;
  /**
   * Publishes an OPEN of `opener`'s half to a server's name, living `expiresAfter` milliseconds in
   * its broker where its adapter offers a message's life (spec 15.18).
   */
  open(
    name: string,
    { expiresAfter, opener }: { expiresAfter?: number | undefined; opener: Uint8Array }
  ): Promise<BrokerPublished>;
  /** Refuses an OPEN with `status`, to the inbox it names. */
  refuse(open: IParcel, status: number): void;
  report(error: Error): void;
  /** Holds `names` for one server's transport of it; one another holds already is a {@link ProgrammerError}. */
  reserve(names: readonly string[]): void;
  serve(name: string, serving: IBrokerServing): void;
  /**
   * Subscribes `name`, in its group when given, while wanted, and lets it go once not: settles once
   * its broker holds it, or let it go, failing on a subscription its broker refused.
   */
  want(
    name: string,
    { group, isWanted }: { group?: string | undefined; isWanted: boolean }
  ): Promise<void>;
}

// constants

/** One envelope's parts together, at most, by default: the default envelope's limit (spec 15.23). */
export const MAXIMUM_ENVELOPE_PARTS_BYTES = 16_778_240;

/** How long parts come, by default, before their rate is held: 5 seconds (spec 15.12). */
export const BODY_GRACE_PERIOD = 5_000;

/** The slowest parts may come by default once their grace passed: 240 bytes a second (spec 15.12). */
export const MINIMUM_BODY_BYTES_PER_SECOND = 240;

/** Its topics' first token by default. */
export const ROOT = 'bead';

/** The port its transports reach it by: kept off its public face. @internal */
export const PARTICIPANT_PORT: unique symbol = Symbol('bead.brokerParticipant');

const ZERO_HALF = new Uint8Array(HALF_BYTES);

// helpers

const keyOf = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => {
    return byte.toString(16).padStart(2, '0');
  }).join('');
};

const pairOf = ({ acceptor, opener }: { acceptor: Uint8Array; opener: Uint8Array }): string => {
  return `${keyOf(opener)}${keyOf(acceptor)}`;
};

const isSame = (one: Uint8Array, other: Uint8Array): boolean => {
  return one.length === other.length && keyOf(one) === keyOf(other);
};

// bytes drawn from a cryptographic source
const drawn = (length: number): Uint8Array => {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
};

/** The participant a transport is built over, by its port. @internal */
export const portOf = (participant: IBrokerParticipant): IBrokerParticipantPort => {
  const port = (participant as unknown as Record<symbol, IBrokerParticipantPort | undefined>)[
    PARTICIPANT_PORT
  ];

  if (port === undefined) {
    throw new ProgrammerError('a broker transport is built over a participant of this package');
  }

  return port;
};

// definition

/**
 * A participant over `adapter` (spec 15.16 to 15.24): its link started once, each time as a new
 * incarnation drawn from a cryptographic source, its inbox subscribed before anything goes, its will
 * a GONE of that incarnation where its adapter takes one. Every message is taken — handed on, or
 * dropped as a copy — and then acknowledged: a parcel of a pair it holds by its connection's
 * sequence, a copy dropped, a gap a loss; an ACCEPT for no connect it awaits answered with a RESET;
 * an OPEN to a name by the server's transport serving it, or refused 503 when none does; a GONE by
 * the connections bound to the incarnation it names. A message that is no parcel is dropped and
 * reported; a retained one dropped in silence. As its link goes down it closes each connection,
 * unclean, connects anew, and resets each peer it held a connection with.
 *
 * @example
 * const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
 * const transport = participant.transportServer({ names: ['interop'] });
 * await transport.start();
 */
export const createBrokerParticipant = (options: IBrokerParticipantOptions): IBrokerParticipant => {
  const {
    adapter,
    clock = PLATFORM_CLOCK,
    heldBytesBudget = HELD_BYTES_BUDGET,
    maximumEnvelopePartsBytes = MAXIMUM_ENVELOPE_PARTS_BYTES,
    minimumBodyBytesPerSecond = MINIMUM_BODY_BYTES_PER_SECOND,
    reconnect = {},
    requireDelivery,
    root = ROOT,
  } = options;
  const { id } = adapter;

  if (!isToken(id)) {
    throw new ProgrammerError(
      `a participant's id is a token of base64url's alphabet, 1 to 64 characters, not ${JSON.stringify(id)}`
    );
  }

  if (!isToken(root)) {
    throw new ProgrammerError(
      `a participant's root is a token of base64url's alphabet, 1 to 64 characters, not ${JSON.stringify(root)}`
    );
  }

  if (
    requireDelivery === BROKER_DELIVERIES.AT_LEAST_ONCE &&
    adapter.delivery === BROKER_DELIVERIES.AT_MOST_ONCE
  ) {
    throw new ProgrammerError(
      `its application requires delivery at least once, and the adapter of ${id} gives it at most once`
    );
  }

  const heartbeat = assertHeartbeat(options.heartbeat ?? HEARTBEAT);
  const bodyGracePeriod = assertHeldFinite(
    'bodyGracePeriod',
    options.bodyGracePeriod ?? BODY_GRACE_PERIOD
  );
  const reconnection =
    reconnect === false
      ? undefined
      : {
          delay: assertHeldDelay('a delay', reconnect.delay ?? 1_000),
          maxAttempts: reconnect.maxAttempts ?? Infinity,
          signal: reconnect.signal,
        };

  assertCount('heldBytesBudget', { value: heldBytesBudget });
  assertCount('maximumEnvelopePartsBytes', { value: maximumEnvelopePartsBytes });
  assertCount('minimumBodyBytesPerSecond', { value: minimumBodyBytesPerSecond });

  const topicOf = (kind: 'd' | 'i' | 's', token: string): BrokerTopic => {
    return Object.freeze([root, kind, token]);
  };
  const inbox = topicOf('i', id);
  // * asked once, with its inbox, whose topic a broker's packet counts (spec 15.30)
  const receiveBound = Math.min(adapter.receiveBound(inbox), LARGEST_RECEIVE_BOUND);

  if (receiveBound < LEAST_RECEIVE_BOUND) {
    throw new ProgrammerError(
      `a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of ${id} takes ${String(receiveBound)}`
    );
  }

  // a DATA that carries a credential lives twice its heartbeat in its broker, none without one (spec
  // 15.22)
  const credentialLife = heartbeat === Infinity ? undefined : 2 * heartbeat;
  const emitter = createEmitter<{ error: [Error]; debug: [IParticipantDebugEvent] }>();
  const held = createHeldBytes(heldBytesBudget);
  const partsBounds = {
    bodyGracePeriod,
    clock,
    maximumEnvelopePartsBytes,
    minimumBodyBytesPerSecond,
  };
  // its connections by both halves, half-open ones among them
  const connections = new Map<string, IConnectionRecord>();
  // the connects awaiting their answer, by the opener's half
  const awaiting = new Map<string, IBrokerAnswers>();
  // the servers' transports, by the names they serve
  const serving = new Map<string, IBrokerServing>();
  // the names its servers' transports hold, each one's alone, from the time each is built
  const reserved = new Set<string>();
  // the names wanted, their group, whether the broker holds them now, from its SUBACK to its
  // UNSUBACK, and what was asked of it last, each ask after the one before it
  const names = new Map<
    string,
    { group: string | undefined; isHeld: boolean; isWanted: boolean; settling: Promise<void> }
  >();
  // the departures it subscribes, by peer, while it holds a connection with it
  const departures = new Map<string, { count: number; isAsked: boolean; isHeld: boolean }>();

  let ordinal = 0;
  let incarnation: Uint8Array | undefined;
  let linking: Promise<void> | undefined;
  let isLinked = false;
  let isStopped = false;
  // ! taken over by another link of its id: it connects no more until its application starts it
  let isTakenOver = false;
  // a link under way, and each down heard as one connects: that attempt fails
  let isLinking = false;
  let downsAsItLinks = 0;
  // each link and each down its own, so that what a former link asked does nothing on the next
  let epoch = 0;

  const isDebugging = (): boolean => {
    return emitter.listenerCount('debug') > 0;
  };
  const debug = (event: IParticipantDebugEvent): void => {
    emitter.emitEach('debug', {
      onError: (reason) => {
        emitter.emitEach('error', { onError: noop, params: [toError(reason)] });
      },
      params: [event],
    });
  };
  const report = (error: Error): void => {
    if (isDebugging()) {
      debug({ event: 'report', report: error.message });
    }
    emitter.emitEach('error', { onError: noop, params: [error] });
  };
  const traceParcel = (
    parcel: IParcelPrefix | undefined,
    event: Omit<IParticipantDebugEvent, 'event'>
  ): void => {
    debug({
      ...(parcel === undefined ? {} : participantParcelOf(parcel)),
      ...event,
      event: 'parcel',
    });
  };
  const transition = (
    state: 'up' | 'down' | 'taken-over' | 'stopped',
    ended?: readonly number[]
  ): void => {
    if (isDebugging()) {
      debug({
        event: 'link',
        state,
        incarnation: incarnation === undefined ? undefined : participantHexOf(incarnation),
        ended,
      });
    }
  };

  // a publication with its life, where its adapter offers one and one is asked
  const publicationOf = (
    topic: BrokerTopic,
    { expiresAfter, payload }: { expiresAfter?: number | undefined; payload: Uint8Array }
  ) => {
    return adapter.capabilities.expiry === true && expiresAfter !== undefined
      ? { expiresAfter, payload, topic }
      : { payload, topic };
  };

  // a publication on the link, whatever its broker says of it; a link down tells itself by `down`
  const publish = (
    topic: BrokerTopic,
    payload: Uint8Array,
    options?: {
      expiresAfter?: number | undefined;
      parcel?: IParcel | undefined;
      record?: IConnectionRecord | undefined;
    }
  ): Promise<BrokerPublished | undefined> => {
    if (options?.parcel !== undefined) {
      traceParcel(options.parcel, {
        bytes: payload.length,
        direction: 'tx',
        topic,
        connection: options.record?.ordinal,
        connectionHandle: options.record?.handle(),
      });
    }
    return adapter
      .publish(publicationOf(topic, { expiresAfter: options?.expiresAfter, payload }))
      .catch(() => {
        return undefined;
      });
  };

  // ── names and departures ──

  // * a name held by its broker's word: from its SUBACK to its UNSUBACK, on the link that asked it
  const settleName = async (
    name: string,
    entry: { group: string | undefined; isHeld: boolean; isWanted: boolean }
  ): Promise<void> => {
    const asked = epoch;

    if (!isLinked) {
      return;
    }

    if (entry.isWanted && !entry.isHeld) {
      await adapter.subscribe(
        topicOf('s', name),
        entry.group === undefined ? {} : { group: entry.group }
      );
      entry.isHeld = asked === epoch;
      if (entry.isHeld && isDebugging()) {
        debug({ event: 'names', name, isHeld: true, group: entry.group });
      }

      return;
    }

    if (!entry.isWanted && entry.isHeld) {
      try {
        await adapter.unsubscribe(topicOf('s', name));
      } catch (reason) {
        // a link that went down let it go of its own
        if (asked === epoch) {
          report(toError(reason));
        }
      }

      // ! nothing asks it again before this settles: each ask after the one before it
      entry.isHeld = false;
      if (asked === epoch && isDebugging()) {
        debug({ event: 'names', name, isHeld: false, group: entry.group });
      }
    }
  };

  const want = (
    name: string,
    { group, isWanted }: { group?: string | undefined; isWanted: boolean }
  ): Promise<void> => {
    const entry = names.get(name) ?? {
      group,
      isHeld: false,
      isWanted,
      settling: Promise.resolve(),
    };

    names.set(name, entry);
    entry.isWanted = isWanted;

    // ! each ask after the one before it: a name let go as its SUBSCRIBE goes is let go once it came
    const settled = entry.settling.then(() => {
      return settleName(name, entry);
    });

    entry.settling = settled.catch(noop);

    return settled;
  };

  // * a peer's departure subscribed while a connection with it is held, where a will can be left
  const depart = (peer: string, change: 1 | -1): void => {
    if (adapter.capabilities.will !== true) {
      return;
    }

    const entry = departures.get(peer) ?? { count: 0, isAsked: false, isHeld: false };

    entry.count += change;
    departures.set(peer, entry);

    if (entry.count > 0 && !entry.isAsked && isLinked) {
      entry.isAsked = true;
      adapter.subscribe(topicOf('d', peer)).then(() => {
        entry.isHeld = departures.get(peer) === entry;
      }, noop);
    }

    if (entry.count === 0) {
      departures.delete(peer);

      if (isLinked) {
        adapter.unsubscribe(topicOf('d', peer)).catch(noop);
      }
    }
  };

  // ── connections ──

  interface IConnectionRecord {
    readonly ordinal: number;
    handle(): string | undefined;
    readonly connection: IBrokerConnection;
    /** Its peer's id and incarnation, which a GONE names. */
    readonly peer: IBrokerPeer;
    /** Dropped as its link went down: unclean, unreported, nothing sent. */
    drop(): void;
    take(parcel: IParcel, bytes: number, options?: { flags?: number | undefined }): void;
    violate(
      read: { prefix: IParcelPrefix; reason: string },
      bytes: number,
      options?: { flags?: number | undefined }
    ): void;
  }

  const connect: IBrokerParticipantPort['connect'] = (
    { acceptor, isOpener, opener, peer },
    { isSecure = adapter.isSecure, maximumUnsentBytes, owner }
  ) => {
    const connectionOrdinal = ++ordinal;
    const key = pairOf({ acceptor, opener });
    const peerInbox = topicOf('i', peer.id);
    const received = createBrokerSequence(2);
    let nextSend = 1;
    let unsentBytes = 0;
    let isHalfOpen = !isOpener;
    let isEnded = false;
    let beat: ISilenceHeartbeat | undefined;

    const forget = (): void => {
      if (isEnded) {
        return;
      }

      isEnded = true;
      connections.delete(key);
      parts.stop();
      beat?.stop();

      if (!isHalfOpen) {
        depart(peer.id, -1);
      }
    };

    const end = (wasClean: boolean): void => {
      if (!isEnded) {
        forget();
        owner.end(wasClean);
      }
    };

    // a parcel of this connection, numbered unless it is a RESET, held to what may wait for its broker
    const sendParcel = (
      fields: Omit<ParcelFields, 'acceptor' | 'opener' | 'sequence'>,
      options?: { expiresAfter?: number | undefined }
    ): void => {
      const isReset = fields.kind === ParcelKind.RESET;
      const parcel: IParcel = {
        ...fields,
        flags: (fields.flags ?? 0) | (fields.credential === undefined ? 0 : ParcelFlag.CREDENTIAL),
        layout: PARCEL_LAYOUT,
        acceptor,
        opener,
        sequence: isReset ? 0 : nextSend,
      };
      const bytes = writeParcel(parcel);

      // ! held before its sequence is taken: the CLOSE that loses the connection is the next, with
      // no gap before it
      if (unsentBytes + bytes.length > maximumUnsentBytes && fields.kind !== ParcelKind.CLOSE) {
        lose({
          code: CloseCode.LOST,
          reason: `what waits for its broker would pass maximumUnsentBytes, ${String(maximumUnsentBytes)} bytes`,
        });

        return;
      }

      if (!isReset) {
        nextSend += 1;
      }

      unsentBytes += bytes.length;
      void publish(peerInbox, bytes, isDebugging() ? { ...options, parcel, record } : options).then(
        (published) => {
          unsentBytes -= bytes.length;

          // a parcel its broker refused, or no subscriber took: its peer's inbox is gone, as a
          // dropped socket's peer
          if (published !== BROKER_PUBLISHED.TAKEN) {
            end(false);
          }
        }
      );
    };

    const closeWith = (code: number): void => {
      if (isEnded) {
        return;
      }

      sendParcel({ code, kind: ParcelKind.CLOSE });
      end(code === CloseCode.NORMAL);
    };

    // * lost of its own: its peer told by a CLOSE, the loss reported, its end unclean
    const lose = ({ code, reason }: IBrokerLoss): void => {
      if (isEnded) {
        return;
      }

      sendParcel({ code, kind: ParcelKind.CLOSE });
      forget();
      const error = new GenericError(
        `${owner.subject()} is closed with ${String(code)}: ${reason}`
      );
      if (isDebugging()) {
        debug({
          event: 'report',
          report: error.message,
          connection: record.ordinal,
          connectionHandle: record.handle(),
        });
      }
      owner.report(error);
      owner.end(false);
    };

    const parts: IBrokerParts = createBrokerParts({ held, slow: lose }, partsBounds);

    const open = (): void => {
      isHalfOpen = false;
      depart(peer.id, 1);
      beat =
        heartbeat === Infinity
          ? undefined
          : createSilenceHeartbeat(heartbeat, {
              drop: () => {
                closeWith(CloseCode.UNANSWERED);
              },
              ping: () => {
                sendParcel({ kind: ParcelKind.PING });
              },
            });
    };

    const takeData = (parcel: IParcel): void => {
      const { carried = new Uint8Array(), credential, flags = 0 } = parcel;

      // ! a server carries no credential toward its client (spec 15.22)
      if (isOpener && credential !== undefined) {
        lose({
          code: CloseCode.PROTOCOL_ERROR,
          reason: "a DATA toward its client carries a credential, which no server's does",
        });

        return;
      }

      const verdict = parts.add(carried, { credential, isLast: (flags & ParcelFlag.MORE) === 0 });

      if ('lost' in verdict) {
        lose(verdict.lost);

        return;
      }

      if ('envelope' in verdict) {
        owner.envelope({ credential: verdict.credential, data: verdict.envelope });
      }
    };

    let incomingBytes = 0;
    let incomingOptions: { flags?: number | undefined } | undefined;
    const trace = (parcel: IParcelPrefix, verdict: ParcelVerdict): void => {
      if (incomingOptions !== undefined) {
        traceParcel(parcel, {
          bytes: incomingBytes,
          flags: incomingOptions.flags,
          direction: 'rx',
          topic: inbox,
          verdict,
          connection: record.ordinal,
          connectionHandle: record.handle(),
          ...(verdict === 'loss' ? { awaited: received.awaited, came: parcel.sequence } : {}),
        });
      }
    };
    const record: IConnectionRecord = {
      ordinal: connectionOrdinal,
      handle: () => {
        return isOpener ? 'server' : owner.connectionHandle?.();
      },
      connection: {
        maximumUnsentBytes,
        acceptor,
        get isHalfOpen() {
          return isHalfOpen;
        },
        opener,
        get partsBytes() {
          return parts.bytes;
        },
        peer,
        get unsentBytes() {
          return unsentBytes;
        },
        close: closeWith,
        forget: () => {
          end(false);
        },
        reset: () => {
          if (!isEnded) {
            sendParcel({ kind: ParcelKind.RESET });
            end(false);
          }
        },
        send: (data, sendOptions) => {
          if (isEnded) {
            return Promise.resolve();
          }

          const credential = sendOptions?.credential;
          const room = Math.min(peer.bound, adapter.maximumPayloadBytes(peerInbox));
          let pieces: Uint8Array[];

          try {
            pieces = partsOf(data, {
              credentialBytes: credential === undefined ? 0 : credential.length,
              room,
            });
          } catch (reason) {
            return Promise.reject(toError(reason));
          }

          for (const [index, carried] of pieces.entries()) {
            const isCarrying = index === 0 && credential !== undefined;

            sendParcel(
              {
                carried,
                ...(isCarrying ? { credential } : {}),
                flags: index < pieces.length - 1 ? ParcelFlag.MORE : 0,
                kind: ParcelKind.DATA,
              },
              isCarrying ? { expiresAfter: credentialLife } : {}
            );
          }

          return Promise.resolve();
        },
      },
      peer,
      drop: () => {
        end(false);
      },
      take: (parcel, bytes, incoming: { flags?: number | undefined } | undefined) => {
        incomingOptions = incoming;
        incomingBytes = bytes;
        beat?.heard();

        if (parcel.kind === ParcelKind.RESET) {
          trace(parcel, 'taken');
          end(false);

          return;
        }

        if (parcel.layout !== PARCEL_LAYOUT) {
          trace(parcel, 'taken');
          lose({
            code: CloseCode.PROTOCOL_ERROR,
            reason: `a parcel of a layout to come, ${hexOfByte(parcel.layout)}`,
          });

          return;
        }

        const verdict = received.take(parcel.sequence);

        if (verdict === SEQUENCE_VERDICTS.COPY) {
          trace(parcel, 'copy');
          return undefined;
        }

        if (verdict === SEQUENCE_VERDICTS.LOSS) {
          trace(parcel, 'loss');
          lose(gapOf({ awaited: received.awaited, came: parcel.sequence }));

          return;
        }

        // * its third leg: the opener's first parcel naming both halves proves it reads its inbox
        if (isHalfOpen) {
          open();
          owner.opened?.();
        }

        trace(parcel, parcel.kind >= FIRST_ADVISORY_KIND ? 'advisory' : 'taken');
        if (parcel.kind >= FIRST_ADVISORY_KIND) {
          return undefined;
        }

        if (parts.bytes > 0 && parcel.kind !== ParcelKind.DATA) {
          lose({
            code: CloseCode.PROTOCOL_ERROR,
            reason: `${kindNamed(parcel.kind)} between an envelope's parts`,
          });

          return;
        }

        switch (parcel.kind) {
          case ParcelKind.DATA:
            takeData(parcel);

            return;
          case ParcelKind.PING:
            sendParcel({ answers: parcel.sequence, kind: ParcelKind.PONG });

            return;
          case ParcelKind.PONG:
            return undefined;
          case ParcelKind.CLOSE:
            end(parcel.code === CloseCode.NORMAL);

            return;
          default:
            lose({
              code: CloseCode.PROTOCOL_ERROR,
              reason: `${kindNamed(parcel.kind)} on a connection open`,
            });

            return;
        }
      },
      violate: (
        { prefix, reason },
        bytes,
        incoming: { flags?: number | undefined } | undefined
      ) => {
        incomingOptions = incoming;
        incomingBytes = bytes;
        beat?.heard();

        // a kind to come is taken in its order: a copy dropped, a gap a loss
        if (isKindToCome(prefix.kind) && prefix.sequence <= Number.MAX_SAFE_INTEGER) {
          const verdict = received.take(prefix.sequence);

          if (verdict === SEQUENCE_VERDICTS.COPY) {
            trace(prefix, 'copy');
            return;
          }

          if (verdict === SEQUENCE_VERDICTS.LOSS) {
            trace(prefix, 'loss');
            lose(gapOf({ awaited: received.awaited, came: prefix.sequence }));

            return;
          }
        }

        trace(prefix, 'does-not-read');
        lose({ code: CloseCode.PROTOCOL_ERROR, reason: `a parcel that does not read: ${reason}` });
      },
    };

    connections.set(key, record);

    if (isOpener) {
      // the ACCEPT taken was its acceptor's first; its third leg goes at once
      nextSend = 2;
      open();
      sendParcel({ kind: ParcelKind.PING });
    } else {
      sendParcel({
        bound: receiveBound,
        flags: isSecure ? ParcelFlag.SECURE : 0,
        id,
        incarnation,
        kind: ParcelKind.ACCEPT,
      });
    }

    return record.connection;
  };

  const isZero8 = (half: Uint8Array): boolean => {
    return half.every((byte) => {
      return byte === 0;
    });
  };

  const drawHalf = (): Uint8Array => {
    for (;;) {
      const half = drawn(HALF_BYTES);
      const key = keyOf(half);
      const isHeld =
        isZero8(half) ||
        awaiting.has(key) ||
        [...connections.keys()].some((pair) => {
          return pair.startsWith(key) || pair.endsWith(key);
        });

      if (!isHeld) {
        return half;
      }
    }
  };

  // ── what comes ──

  const resetOf = ({ acceptor, id: peerId, opener }: IParcel): void => {
    if (peerId === undefined) {
      return;
    }

    const parcel = {
      acceptor,
      kind: ParcelKind.RESET,
      layout: PARCEL_LAYOUT,
      flags: 0,
      opener,
      sequence: 0,
    };
    void publish(topicOf('i', peerId), writeParcel(parcel), isDebugging() ? { parcel } : undefined);
  };

  const refuse = (open: IParcel, status: number): void => {
    if (open.id === undefined) {
      return;
    }

    const parcel = {
      acceptor: ZERO_HALF,
      kind: ParcelKind.REFUSE,
      layout: PARCEL_LAYOUT,
      flags: 0,
      ...(status === 426 ? { layouts: [PARCEL_LAYOUT] } : {}),
      opener: open.opener,
      sequence: 1,
      status,
    };
    void publish(
      topicOf('i', open.id),
      writeParcel(parcel),
      isDebugging() ? { parcel } : undefined
    );
  };

  const takeAtInbox = (payload: Uint8Array): void => {
    const read = readParcel(payload);

    if ('refused' in read && read.refused === 'no-parcel') {
      if (isDebugging()) {
        traceParcel(undefined, {
          direction: 'rx',
          topic: inbox,
          bytes: payload.length,
          verdict: 'no-parcel',
        });
      }
      report(new GenericError(`a message to the inbox of ${id} is no parcel: ${read.reason}`));

      return;
    }

    if ('prefix' in read) {
      const record = connections.get(pairOf(read.prefix));
      if (record === undefined) {
        if (isDebugging()) {
          traceParcel(read.prefix, {
            flags: payload[2],
            direction: 'rx',
            topic: inbox,
            bytes: payload.length,
            verdict: 'does-not-read',
          });
        }
      } else {
        record.violate(read, payload.length, isDebugging() ? { flags: payload[2] } : undefined);
      }
      return;
    }

    const { parcel } = read;
    const record = connections.get(pairOf(parcel));

    if (record !== undefined) {
      record.take(parcel, payload.length, isDebugging() ? { flags: payload[2] } : undefined);

      return;
    }

    const answers = awaiting.get(keyOf(parcel.opener));
    if (isDebugging()) {
      traceParcel(parcel, {
        flags: payload[2],
        direction: 'rx',
        topic: inbox,
        bytes: payload.length,
        verdict:
          answers !== undefined &&
          (parcel.kind === ParcelKind.ACCEPT || parcel.kind === ParcelKind.REFUSE)
            ? 'taken'
            : 'pair-not-held',
      });
    }

    if (parcel.kind === ParcelKind.ACCEPT && parcel.layout === PARCEL_LAYOUT) {
      // * the first ACCEPT naming its half opens its connect; any other is reset, its router told nothing
      if (answers === undefined) {
        resetOf(parcel);
      } else {
        answers.accept(parcel);
      }

      return;
    }

    if (parcel.kind === ParcelKind.REFUSE) {
      answers?.refuse(parcel);
    }

    return undefined;
  };

  const takeAtName = (name: string, payload: Uint8Array): void => {
    const read = readParcel(payload);

    if (isDebugging()) {
      traceParcel('parcel' in read ? read.parcel : 'prefix' in read ? read.prefix : undefined, {
        flags: 'parcel' in read || 'prefix' in read ? payload[2] : undefined,
        direction: 'rx',
        topic: topicOf('s', name),
        bytes: payload.length,
        verdict:
          'parcel' in read
            ? read.parcel.kind >= FIRST_ADVISORY_KIND
              ? 'advisory'
              : 'taken'
            : read.refused,
      });
    }
    // * no parcel, or an OPEN that does not read, names no connection: dropped and reported
    if (!('parcel' in read)) {
      if (!('prefix' in read)) {
        report(new GenericError(`a message to the name ${name} is no parcel: ${read.reason}`));
      } else if (read.prefix.kind === ParcelKind.OPEN) {
        report(
          new GenericError(`an OPEN to the name ${name} does not read, dropped: ${read.reason}`)
        );
      }

      return;
    }

    if (read.parcel.kind !== ParcelKind.OPEN) {
      return undefined;
    }

    const server = serving.get(name);

    if (server === undefined) {
      refuse(read.parcel, 503);
    } else {
      server.offer(read.parcel);
    }
  };

  // * a GONE closes each connection bound to the id and the incarnation it names, never another
  const takeAtDeparture = (payload: Uint8Array, topic: BrokerTopic): void => {
    const read = readParcel(payload);
    if (isDebugging()) {
      traceParcel('parcel' in read ? read.parcel : 'prefix' in read ? read.prefix : undefined, {
        flags: 'parcel' in read || 'prefix' in read ? payload[2] : undefined,
        direction: 'rx',
        topic,
        bytes: payload.length,
        verdict:
          'parcel' in read
            ? read.parcel.kind >= FIRST_ADVISORY_KIND
              ? 'advisory'
              : 'taken'
            : read.refused,
      });
    }

    if (!('parcel' in read) || read.parcel.kind !== ParcelKind.GONE) {
      return;
    }

    const { id: gone, incarnation: of } = read.parcel;

    for (const record of connections.values()) {
      if (record.peer.id === gone && of !== undefined && isSame(record.peer.incarnation, of)) {
        record.drop();
      }
    }
  };

  // ! taken, handed on or dropped as a copy, then acknowledged: never once a router is done with it
  const take = (message: IBrokerMessage): void => {
    const { payload, retained, topic } = message;
    const [first, kind, token = ''] = topic;

    try {
      if (
        retained === true ||
        first !== root ||
        topic.length !== 3 ||
        !(
          (kind === 'i' && token === id) ||
          (kind === 's' && reserved.has(token)) ||
          (kind === 'd' && departures.has(token))
        )
      ) {
        if (isDebugging()) {
          traceParcel(undefined, {
            direction: 'rx',
            topic,
            bytes: payload.length,
            verdict: retained === true ? 'retained' : 'off-topic',
          });
        }
        return;
      }

      if (kind === 'i' && token === id) {
        takeAtInbox(payload);
      } else if (kind === 's') {
        takeAtName(token, payload);
      } else if (kind === 'd') {
        takeAtDeparture(payload, topic);
      }
    } finally {
      message.settle();
    }
  };

  // ── the link ──

  // starts a link, a new incarnation, its inbox and its names subscribed before anything goes
  const link = async (signal?: AbortSignal): Promise<void> => {
    const drawnIncarnation = drawn(INCARNATION_BYTES);
    const will =
      adapter.capabilities.will === true
        ? {
            payload: writeParcel({
              acceptor: ZERO_HALF,
              id,
              incarnation: drawnIncarnation,
              kind: ParcelKind.GONE,
              opener: ZERO_HALF,
              sequence: 0,
            }),
            topic: topicOf('d', id),
          }
        : undefined;

    const downsBefore = downsAsItLinks;

    isLinking = true;

    try {
      await adapter.start({ signal, will });
      await adapter.subscribe(inbox, { signal });
    } finally {
      isLinking = false;
    }

    // ! a link that went down as it connected is none: this attempt fails, and the next links
    // anew, rather than call it up and miss its loss
    if (downsAsItLinks !== downsBefore) {
      throw new GenericError(`the link of ${id} went down as it connected`);
    }

    incarnation = drawnIncarnation;
    epoch += 1;
    isLinked = true;

    // * a name its broker refuses at a later link is reported and left unheld
    const linkedEpoch = epoch;
    await Promise.all(
      [...names].map(async ([name, { group, isWanted }]) => {
        try {
          await want(name, { group, isWanted });
        } catch (reason) {
          report(notServedOf(name, reason));
        }
      })
    );
    if (epoch === linkedEpoch) {
      transition('up');
    }
  };

  const linked = (linkOptions?: {
    isStart?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<void> => {
    if (isStopped) {
      return Promise.reject(new GenericError(`the participant ${id} is stopped`));
    }

    if (isTakenOver && linkOptions?.isStart !== true) {
      return Promise.reject(
        new GenericError(
          `the link of ${id} was taken over by another link of its id, and connects no more until it is started again`
        )
      );
    }

    isTakenOver = false;

    if (isLinked) {
      return Promise.resolve();
    }

    // * one attempt shared, the first start's or a reconnection's; one that fails is let go, so
    // the next call starts another
    linking ??= link(linkOptions?.signal).catch((reason: unknown) => {
      linking = undefined;

      throw toError(reason);
    });

    return linking;
  };

  // * its link lost: each connection closed, unclean, unreported; a new incarnation connected by
  // its own reconnection; then a RESET to each peer it held a connection with
  const relink = async (
    former: { acceptor: Uint8Array; opener: Uint8Array; peer: string }[]
  ): Promise<void> => {
    const { delay, maxAttempts, signal } = reconnection ?? { delay: 0, maxAttempts: 0 };
    // ! the same words as the C# side's: a stop or a cancel ends the reconnection, told so
    const ended = (reason: string): GenericError => {
      return new GenericError(`the link of ${id} went down, and its reconnection ended: ${reason}`);
    };

    for (let attempt = 1; ; attempt += 1) {
      if (isStopped) {
        throw ended(`the participant ${id} is stopped`);
      }

      if (signal?.aborted === true) {
        throw ended('the reconnection was cancelled');
      }

      try {
        await link();
        break;
      } catch (reason) {
        // * taken over as it linked anew: no attempt follows it
        if (isTakenOver) {
          throw new GenericError(
            `the link of ${id} was taken over by another link of its id, and connects no more until it is started again`,
            { cause: reason }
          );
        }

        if (attempt >= maxAttempts) {
          throw new GenericError(
            `the link of ${id} went down, and ${String(attempt)} attempts did not bring it back`,
            { cause: reason }
          );
        }
      }

      try {
        await createPromise(
          (resolve) => {
            resolve();
          },
          { clock, delay, signal }
        );
      } catch {
        throw ended('the reconnection was cancelled');
      }
    }

    for (const { acceptor, opener, peer } of former) {
      const parcel = {
        acceptor,
        kind: ParcelKind.RESET,
        layout: PARCEL_LAYOUT,
        flags: 0,
        opener,
        sequence: 0,
      };
      void publish(topicOf('i', peer), writeParcel(parcel), isDebugging() ? { parcel } : undefined);
    }
  };

  // a connect awaiting its answer fails: what it opened toward is the former link's
  const failAwaiting = (why: string): void => {
    for (const answers of awaiting.values()) {
      answers.fail(new ConnectError(why));
    }

    awaiting.clear();
  };

  // * fenced: two holders of one id that each linked anew would take each other over without end;
  // the later link keeps the id (spec 15.21)
  const fence = (): void => {
    isTakenOver = true;
    linking = undefined;
    report(new GenericError(`the link of ${id} was taken over by another link of its id`));
  };

  const down = (event?: IBrokerDown): void => {
    if (!isLinked) {
      // * down as it connects: the attempt under way fails; taken over, none follows it
      if (isLinking) {
        downsAsItLinks += 1;

        if (event?.isTakenOver === true) {
          fence();
        }
      }

      return;
    }

    isLinked = false;
    epoch += 1;

    const ended = isDebugging()
      ? [...connections.values()].map((record) => {
          return record.ordinal;
        })
      : undefined;
    const former = [...connections.values()].map(({ connection, peer }) => {
      return { acceptor: connection.acceptor, opener: connection.opener, peer: peer.id };
    });

    for (const record of connections.values()) {
      record.drop();
    }

    failAwaiting(
      event?.isTakenOver === true
        ? `the link of ${id} was taken over by another link of its id as it connected`
        : `the link of ${id} went down as it connected`
    );

    for (const entry of names.values()) {
      entry.isHeld = false;
    }

    departures.clear();
    transition(event?.isTakenOver === true ? 'taken-over' : 'down', ended);

    if (event?.isTakenOver === true) {
      fence();

      return;
    }

    if (reconnection === undefined) {
      linking = undefined;

      report(new GenericError(`the link of ${id} went down`));

      return;
    }

    linking = relink(former).catch((reason: unknown) => {
      linking = undefined;

      // * taken over as it linked anew: its fence reported it
      if (!isTakenOver) {
        report(toError(reason));
      }

      throw toError(reason);
    });
    linking.catch(noop);
  };

  adapter.on('message', take);
  adapter.on('down', down);

  const port: IBrokerParticipantPort = {
    adapter,
    clock,
    id,
    isSecure: adapter.isSecure,
    get names() {
      return new Set(
        [...names.entries()]
          .filter(([, { isHeld }]) => {
            return isHeld;
          })
          .map(([name]) => {
            return name;
          })
      );
    },
    awaitAnswers: (opener, answers) => {
      const key = keyOf(opener);

      awaiting.set(key, answers);

      return () => {
        if (awaiting.get(key) === answers) {
          awaiting.delete(key);
        }
      };
    },
    connect,
    drawHalf,
    linked,
    open: async (name, { expiresAfter, opener }) => {
      if (incarnation === undefined) {
        throw new GenericError(`the link of ${id} is not up`);
      }

      const parcel = {
        acceptor: ZERO_HALF,
        layout: PARCEL_LAYOUT,
        bound: receiveBound,
        flags: adapter.isSecure ? ParcelFlag.SECURE : 0,
        id,
        incarnation,
        kind: ParcelKind.OPEN,
        opener,
        sequence: 1,
      };
      const payload = writeParcel(parcel);
      const topic = topicOf('s', name);
      if (isDebugging()) {
        traceParcel(parcel, { direction: 'tx', topic, bytes: payload.length });
      }
      return adapter.publish(publicationOf(topic, { expiresAfter, payload }));
    },
    refuse,
    report,
    reserve: (given) => {
      for (const name of given) {
        if (reserved.has(name)) {
          throw new ProgrammerError(
            `the name ${name} is served already by a server transport of this participant`
          );
        }
      }

      for (const name of given) {
        reserved.add(name);
      }
    },
    serve: (name, server) => {
      serving.set(name, server);
    },
    want,
  };

  let withdraw = noop;
  const participant: IBrokerParticipant & { [PARTICIPANT_PORT]: IBrokerParticipantPort } = {
    adapter,
    clock,
    id,
    get incarnation() {
      return incarnation;
    },
    get isLinked() {
      return isLinked;
    },
    root,
    get isDebugging() {
      return isDebugging();
    },
    get names() {
      return port.names;
    },
    gauges: () => {
      let halfOpen = 0;
      let unsentBytes = 0;
      let largestPartsBytes = 0;
      let largestUnsentBytes = 0;
      let unsentCeiling = 0;
      let largestUnsentCeiling = 0;

      for (const { connection } of connections.values()) {
        halfOpen += connection.isHalfOpen ? 1 : 0;
        unsentBytes += connection.unsentBytes;
        largestPartsBytes = Math.max(largestPartsBytes, connection.partsBytes);
        unsentCeiling += connection.maximumUnsentBytes;
        if (connection.unsentBytes >= largestUnsentBytes) {
          largestUnsentBytes = connection.unsentBytes;
          largestUnsentCeiling = connection.maximumUnsentBytes;
        }
      }

      return gaugesOf({
        ceilings: {
          largestPartsBytes: maximumEnvelopePartsBytes,
          partsBytes: held.budget,
          ...(connections.size === 0
            ? {}
            : { unsentBytes: unsentCeiling, largestUnsentBytes: largestUnsentCeiling }),
        },
        counts: {
          connections: connections.size - halfOpen,
          departures: [...departures.values()].filter(({ isHeld }) => {
            return isHeld;
          }).length,
          halfOpen,
          largestPartsBytes,
          largestUnsentBytes,
          partsBytes: held.held,
          unsentBytes,
        },
      });
    },
    off: (
      event: 'error' | 'debug',
      listener: ((error: Error) => void) | ((event: IParticipantDebugEvent) => void)
    ) => {
      if (event === 'error') {
        emitter.off(event, listener as (error: Error) => void);
      } else {
        emitter.off(event, listener as (event: IParticipantDebugEvent) => void);
      }

      return participant;
    },
    on: (
      event: 'error' | 'debug',
      listener: ((error: Error) => void) | ((event: IParticipantDebugEvent) => void)
    ) => {
      if (event === 'error') {
        emitter.on(event, listener as (error: Error) => void);
      } else {
        emitter.on(event, listener as (event: IParticipantDebugEvent) => void);
      }

      return participant;
    },
    start: async (startOptions) => {
      await linked({ isStart: true, signal: startOptions?.signal });
    },
    stop: async () => {
      if (isStopped) {
        return;
      }

      const ended = isDebugging()
        ? [...connections.values()].map((record) => {
            return record.ordinal;
          })
        : undefined;
      for (const record of connections.values()) {
        record.connection.close(CloseCode.GOING_AWAY);
      }

      failAwaiting(`the participant ${id} stopped as it connected`);
      isStopped = true;
      epoch += 1;
      isLinked = false;
      await adapter.stop();
      for (const entry of names.values()) {
        entry.isHeld = false;
      }
      departures.clear();
      if (!isTakenOver) {
        transition('stopped', ended);
      }
      withdraw();
    },
    transportClient: (clientOptions) => {
      return createBrokerTransportClient(participant, clientOptions);
    },
    transportServer: (serverOptions) => {
      return createBrokerTransportServer(participant, serverOptions);
    },
    [PARTICIPANT_PORT]: port,
    [Symbol.asyncDispose]: () => {
      return participant.stop();
    },
  };

  withdraw = options.devtools === false ? noop : announceParticipantToDevtools(participant);

  return participant;
};
