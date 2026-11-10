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
import { assertHeldFinite, type IClock, PLATFORM_CLOCK } from './clock';
import { BROKER_DELIVERIES, BROKER_PUBLISHED } from './constants';
import { createEmitter, tellError } from './emitter';
import {
  ConnectError,
  GenericError,
  notServedOf,
  ProgrammerError,
  ReconnectError,
  toError,
  wrapReason,
} from './errors';
import { gaugesOf } from './gauges';
import {
  assertHeartbeat,
  createSilenceHeartbeat,
  HEARTBEAT,
  type ISilenceHeartbeat,
} from './heartbeat';
import { noop } from './noop';
import { announceParticipantToDevtools } from './participant-devtools';
import { assertHeldReconnection, attemptReconnection } from './reconnection';
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
import type {
  BrokerTransportClient,
  IBrokerTransportClientOptions,
  ITransportClientReconnectOptions,
} from '../client/types';
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
  IGauges,
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
   * What it holds of the envelopes of one connection its router paused, past which it loses that
   * connection, a CLOSE of 4000 (spec 15.23): a whole number above 0, charged to no budget of its
   * parts. Each connection's `maximumUnsentBytes`, its transport's, when not given: the most a
   * conforming peer has under way on it.
   */
  maximumHeldEnvelopeBytes?: number | undefined;
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
   * How its link connects again once lost, each time as a new incarnation (spec 15.21), as a
   * transport client's `reconnect` takes it: `delay` 1,000 milliseconds between attempts by
   * default, a fixed one held as it is built whatever `reconnects`; `maximumAttempts` without end by
   * default; `signal` read before each attempt and during each wait, an attempt under way not cut
   * short; `tap` told each wait. A delay of 0 waits a later task of the platform, which fake timers
   * on the globals hold, as they hold its timers. A stop ends it at once, in a wait or during an
   * attempt, the stop its cause. Once it ends it is reported on `error`, what ended it the `cause`,
   * and the next start or connect links it anew.
   */
  reconnect?: ITransportClientReconnectOptions | undefined;
  /**
   * Whether its link connects again once lost, as `reconnect` says: true by default; `false` leaves
   * it down, reported, until a start or a connect links it anew.
   */
  reconnects?: boolean | undefined;
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
  /**
   * Starts its link: its incarnation drawn, its inbox and its servers' names subscribed; settles
   * at once while it is up, and links anew once it is down, its stop settled among it, as another
   * incarnation. A {@link ProgrammerError} while its stop is under way, or once disposed (spec
   * 15.21).
   */
  start(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  /**
   * Ends its link in place, and with it what is under way: lets go of each name its broker holds
   * or was asked to hold, kept wanted for its next link, closes each of its connections with 1001,
   * those unsubscriptions handed first, gives up its link's start under way and awaits it, fails
   * each connect and ends each reconnection; then awaits its broker's word on each name, within its
   * adapter's bound, refusing 503 `busy` an OPEN its broker hands it meanwhile, a name it refuses to
   * let go reported and held until its stop settles; then stops its adapter, which sends those
   * CLOSEs before it ends the link, so its broker publishes no will. Its transports, their routers
   * and its listeners are kept, and its next start, a server's start or a client's connect over it
   * links it anew, resetting each peer whose CLOSE its broker did not take. A stop called again
   * settles with the first; a participant no longer in use is disposed (spec 15.18, 15.21).
   */
  stop(): Promise<void>;
  /** A client's transport over it, one connection at a time through a server's name. */
  transportClient(options?: IBrokerTransportClientOptions): BrokerTransportClient;
  /** A server's transport over it, serving the names it is given. */
  transportServer(options: IBrokerTransportServerOptions): BrokerTransportServer;
  /**
   * Stops it, then ends it for good: its adapter's listeners let go, its DevTools announcement
   * withdrawn. A start, and a client's connect or reconnect or a server's start over it, made
   * after it, is a {@link ProgrammerError}; a stop or a dispose after it settles with it (spec
   * 15.21).
   */
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
  /**
   * Holds each envelope that comes whole for it from now on, its router paused (spec 15.12): in
   * order, its peer's CLOSE behind them, to `maximumHeldEnvelopeBytes`, past which it is lost; its
   * link reads on, which carries other connections. Idempotent.
   */
  pause(): void;
  /** Ends it at once, unclean, by a RESET to its peer. */
  reset(): void;
  /**
   * Hands on what it holds, in order, from a microtask, never within this call, asking before
   * each whether it was paused again; then a CLOSE held behind them ends it. Idempotent.
   */
  resume(): void;
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
  /** Whether it was disposed: a call over it since is its application's misuse (spec 15.21). */
  readonly isDisposed: boolean;
  /** The names it holds a subscription to. */
  readonly names: ReadonlySet<string>;
  /**
   * The signal of its stop to come, or of the stop under way, read at each call: aborted as that
   * stop is called, apart from its adapter's start's signal; a client's connect and reconnection
   * end by the one they read, the stop its reason, and one read once that stop settled is the next.
   */
  readonly stopped: AbortSignal;
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
   * Resolves once its link is up, linking it while it is down; `isStart`, its application's start,
   * links anew a participant whose link was taken over, which nothing else does. While its stop is
   * under way a start is refused as a misuse, and a connect fails, stopped as it connected, as it
   * does at once once a stop overtakes it; once disposed, either is a misuse. A connect's misuse its
   * adapter meets fails it as a {@link ConnectError}, which another attempt may mend.
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

// a name its servers' transports want: its group, whether its broker holds it, from its SUBACK to
// its UNSUBACK, whether it was asked to, from its SUBSCRIBE to its answer, and its asks in order
interface INameEntry {
  group: string | undefined;
  isAsked: boolean;
  isHeld: boolean;
  isWanted: boolean;
  pending: number;
  settling: Promise<void>;
}

// one stop of a participant: marked as it is called, its adapter's start's signal then its clients'
// aborted; its successor drawn as it settles
interface IStopRecord {
  /** Its adapter told its link down as it stopped: what fails of the link then is that loss. */
  isDownAsItStops: boolean;
  isMarked: boolean;
  /** Its clients' connects and reconnections, and its own reconnection, end by it. */
  readonly ending: AbortController;
  /** Its adapter's start under way gives up on it. */
  readonly stopping: AbortController;
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

// a stop to come, unmarked
const stopRecordOf = (): IStopRecord => {
  return {
    ending: new AbortController(),
    isDownAsItStops: false,
    isMarked: false,
    stopping: new AbortController(),
  };
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
 * reported, one that holds `retained` rather than `isRetained` among them; a retained one dropped in
 * silence. As its link goes down it closes each connection, unclean, connects anew, and resets each
 * peer it held a connection with. Its stop ends its link in place, its next link another
 * incarnation; its dispose ends it for good (spec 15.21).
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
    maximumHeldEnvelopeBytes,
    minimumBodyBytesPerSecond = MINIMUM_BODY_BYTES_PER_SECOND,
    reconnect = {},
    reconnects = true,
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

  // * a fixed delay held as it is given, whether or not it reconnects (spec 1.4)
  assertHeldReconnection(reconnect);

  assertCount('heldBytesBudget', { value: heldBytesBudget });

  if (maximumHeldEnvelopeBytes !== undefined) {
    assertCount('maximumHeldEnvelopeBytes', { value: maximumHeldEnvelopeBytes });
  }

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
  // the names its servers' transports want, by name
  const names = new Map<string, INameEntry>();
  // the departures it subscribes, by peer, while it holds a connection with it
  const departures = new Map<string, { count: number; isAsked: boolean; isHeld: boolean }>();

  let ordinal = 0;
  let incarnation: Uint8Array | undefined;
  let linking: Promise<void> | undefined;
  // its reconnection under way, which its fence gives up
  let relinking: AbortController | undefined;
  let isLinked = false;
  // ! disposed: final, a call since is its application's misuse
  let isDisposed = false;
  // ! taken over by another link of its id: it connects no more until its application starts it
  let isTakenOver = false;
  // a link under way, and each down heard as one connects: that attempt fails
  let isLinking = false;
  let downsAsItLinks = 0;
  // each link and each down its own, so that what a former link asked does nothing on the next
  let epoch = 0;
  // * the record of its stop to come, renewed as that stop settles: each operation reads the one
  // current at its call, so that what a stop ended is told as its, though a start follows at once
  let current = stopRecordOf();
  // its adapter's start under way, which its stop awaits before it stops its adapter
  let starting: Promise<void> | undefined;
  // its last stop's end, which every later stop shares until its next link starts
  let stopped: Promise<void> | undefined;
  // its dispose, which every later stop and dispose shares
  let disposed: Promise<void> | undefined;
  // * the pairs whose CLOSE its broker did not take as it stopped: its next link resets each
  const unclosed: { acceptor: Uint8Array; opener: Uint8Array; peer: string }[] = [];

  const isDebugging = (): boolean => {
    return emitter.listenerCount('debug') > 0;
  };
  // what a debug listener throws is reported; what a listener of `error` throws is dropped (spec
  // 15.1)
  const debug = (event: IParticipantDebugEvent): void => {
    emitter.emitEach('debug', {
      onError: (reason) => {
        tellError(emitter, [toError(reason)]);
      },
      params: [event],
    });
  };
  const report = (error: Error): void => {
    if (isDebugging()) {
      debug({ event: 'report', report: error.message });
    }
    tellError(emitter, [error]);
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
  const settleName = async (name: string, entry: INameEntry): Promise<void> => {
    const asked = epoch;

    if (!isLinked) {
      return;
    }

    if (entry.isWanted && !entry.isHeld) {
      // * asked from its SUBSCRIBE on, so that a stop before its SUBACK lets it go
      entry.isAsked = true;

      try {
        await adapter.subscribe(
          topicOf('s', name),
          entry.group === undefined ? {} : { group: entry.group }
        );
      } finally {
        entry.isAsked = false;
      }

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
        // * one its broker refused to let go is reported and held still; a link that went down let
        // it go of its own, and a stop since lets it go itself (spec 15.21)
        if (asked === epoch) {
          report(toError(reason));
        }

        return;
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
      isAsked: false,
      isHeld: false,
      isWanted,
      pending: 0,
      settling: Promise.resolve(),
    };

    names.set(name, entry);
    entry.isWanted = isWanted;

    const ask = (): Promise<void> => {
      return settleName(name, entry).finally(() => {
        entry.pending -= 1;
      });
    };
    // ! each ask after the one before it: a name let go as its SUBSCRIBE goes is let go once it
    // came; one with none before it asked at once, so that a server's stop hands its UNSUBSCRIBE
    // before its CLOSEs (spec 15.21)
    const settled = entry.pending === 0 ? ask() : entry.settling.then(ask);

    entry.pending += 1;
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
    /** Closed with a CLOSE of `code`, as its connection's `close`: whether its broker took it. */
    closeWith(code: number): Promise<boolean>;
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
    // * what its router paused it for: each envelope come whole held in order, its bytes counted
    // apart from its parts', and the CLOSE that came behind them, whether clean (spec 15.12, 15.23)
    const heldBound = maximumHeldEnvelopeBytes ?? maximumUnsentBytes;
    const heldEnvelopes: { credential?: string | undefined; data: Uint8Array }[] = [];
    let heldEnvelopeBytes = 0;
    let isPaused = false;
    let isReleasing = false;
    let closing: boolean | undefined;

    const forget = (): void => {
      if (isEnded) {
        return;
      }

      isEnded = true;
      connections.delete(key);
      parts.stop();
      beat?.stop();
      heldEnvelopes.length = 0;
      heldEnvelopeBytes = 0;

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

    // a parcel of this connection, numbered unless it is a RESET, held to what may wait for its
    // broker: what its broker said of it, none where it did not go
    const published = (
      fields: Omit<ParcelFields, 'acceptor' | 'opener' | 'sequence'>,
      options?: { expiresAfter?: number | undefined }
    ): Promise<BrokerPublished | undefined> | undefined => {
      const isReset = fields.kind === ParcelKind.RESET;

      // * its peer's CLOSE came, held behind what it holds: nothing goes after a CLOSE
      if (closing !== undefined) {
        return undefined;
      }

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

        return undefined;
      }

      if (!isReset) {
        nextSend += 1;
      }

      unsentBytes += bytes.length;

      const publishing = publish(
        peerInbox,
        bytes,
        isDebugging() ? { ...options, parcel, record } : options
      );

      void publishing.then((outcome) => {
        unsentBytes -= bytes.length;

        // a parcel its broker refused, or no subscriber took: its peer's inbox is gone, as a
        // dropped socket's peer
        if (outcome !== BROKER_PUBLISHED.TAKEN) {
          end(false);
        }
      });

      return publishing;
    };
    const sendParcel = (
      fields: Omit<ParcelFields, 'acceptor' | 'opener' | 'sequence'>,
      options?: { expiresAfter?: number | undefined }
    ): void => {
      void published(fields, options);
    };

    // closed with a CLOSE of `code`: whether its broker took it, or none went
    const closeWith = (code: number): Promise<boolean> => {
      if (isEnded) {
        return Promise.resolve(true);
      }

      const sent = published({ code, kind: ParcelKind.CLOSE });

      end(code === CloseCode.NORMAL);

      return (
        sent?.then((outcome) => {
          return outcome === BROKER_PUBLISHED.TAKEN;
        }) ?? Promise.resolve(true)
      );
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
                void closeWith(CloseCode.UNANSWERED);
              },
              ping: () => {
                sendParcel({ kind: ParcelKind.PING });
              },
            });
    };

    // an envelope come whole handed on to its owner; or, while its router paused it or anything is
    // held, held behind what is held, in order, the connection lost past what it may hold
    const hand = (envelope: { credential?: string | undefined; data: Uint8Array }): void => {
      if (!isPaused && heldEnvelopes.length === 0) {
        return (owner.envelope(envelope), undefined);
      }

      if (heldEnvelopeBytes + envelope.data.length > heldBound) {
        return (
          lose({
            code: CloseCode.LOST,
            reason: `what it holds for its router, paused, would pass maximumHeldEnvelopeBytes, ${String(heldBound)} bytes`,
          }),
          undefined
        );
      }

      heldEnvelopeBytes += envelope.data.length;
      heldEnvelopes.push(envelope);
    };

    // * a resume's turn: what it holds handed on, in order, each after asking whether its router
    // paused it again, which handing one may do; then a CLOSE held behind them ends it (spec 15.21)
    const release = (): void => {
      isReleasing = false;

      while (!isPaused && !isEnded && heldEnvelopes.length > 0) {
        const envelope = heldEnvelopes.shift() as { credential?: string; data: Uint8Array };

        heldEnvelopeBytes -= envelope.data.length;
        owner.envelope(envelope);
      }

      if (!isPaused && heldEnvelopes.length === 0 && closing !== undefined) {
        end(closing);
      }
    };

    // a CLOSE ends its connection once all before it was handed on: at once, unless what its
    // router paused it for is held, which it then waits behind, its heartbeat stopped
    const takeClose = (isClean: boolean): void => {
      if (heldEnvelopes.length === 0) {
        return (end(isClean), undefined);
      }

      closing = isClean;
      beat?.stop();
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
        hand({ credential: verdict.credential, data: verdict.envelope });
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
        pause: () => {
          isPaused = true;
        },
        reset: () => {
          if (!isEnded) {
            sendParcel({ kind: ParcelKind.RESET });
            end(false);
          }
        },
        resume: () => {
          isPaused = false;

          if (!isReleasing && !isEnded) {
            isReleasing = true;
            queueMicrotask(release);
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
      closeWith,
      drop: () => {
        end(false);
      },
      take: (parcel, bytes, incoming: { flags?: number | undefined } | undefined) => {
        incomingOptions = incoming;
        incomingBytes = bytes;

        // * its peer's CLOSE held behind what it holds: nothing comes after a CLOSE but a RESET,
        // which ends it at once, what it holds lost with it
        if (closing !== undefined && parcel.kind !== ParcelKind.RESET) {
          return;
        }

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
            takeClose(parcel.code === CloseCode.NORMAL);

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

        // nothing comes after a CLOSE: what comes once one is held behind what it holds is dropped
        if (closing !== undefined) {
          return;
        }

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
    const { isRetained, payload, topic } = message;
    const [first, kind, token = ''] = topic;

    try {
      // ! an adapter that says retained, not isRetained, would hand a kept message on as a parcel
      if (Object.hasOwn(message, 'retained')) {
        if (isDebugging()) {
          traceParcel(undefined, {
            direction: 'rx',
            topic,
            bytes: payload.length,
            verdict: 'no-parcel',
          });
        }
        report(
          new ProgrammerError(
            'a broker message says it was kept by isRetained: one holding retained is no parcel'
          )
        );

        return;
      }

      if (
        isRetained === true ||
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
            verdict: isRetained === true ? 'retained' : 'off-topic',
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

  // a link its stop overtook as it connected, what its adapter failed with as its cause
  const stoppedAsItStarted = (cause?: unknown): GenericError => {
    return new GenericError(
      `the participant ${id} stopped as it started`,
      cause === undefined ? undefined : { cause }
    );
  };
  // a connect its stop overtook, what it awaited failing with as its cause
  const stoppedAsItConnected = (cause?: unknown): ConnectError => {
    return new ConnectError(
      `the participant ${id} stopped as it connected`,
      cause === undefined ? undefined : { cause }
    );
  };

  // read afresh at each call: its stop may come at any await of a link
  const isMarked = (record: IStopRecord): boolean => {
    return record.isMarked;
  };

  // a RESET to each peer of `pairs`, whose connection it ended unheard
  const resetEach = (pairs: { acceptor: Uint8Array; opener: Uint8Array; peer: string }[]): void => {
    for (const { acceptor, opener, peer } of pairs) {
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

  // starts a link, a new incarnation, its inbox and its names subscribed before anything goes, then
  // a RESET to each peer whose CLOSE its last stop's broker did not take
  const link = async (signal?: AbortSignal): Promise<void> => {
    // ! the stop current as it starts, read after each await: a later one is not this link's
    const record = current;
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

    // * a stop called from here stops this link, and none before it is shared any more
    stopped = undefined;
    isLinking = true;

    try {
      // * its stop's signal to its start alone: a SUBSCRIBE given up by a signal retires its link
      // with no DISCONNECT, so its will would go; its adapter's stop ends that one cleanly
      starting = adapter.start({
        signal:
          signal === undefined
            ? record.stopping.signal
            : AbortSignal.any([signal, record.stopping.signal]),
        will,
      });
      await starting;

      if (!isMarked(record)) {
        await adapter.subscribe(inbox, { signal });
      }
    } catch (reason) {
      throw isMarked(record) ? stoppedAsItStarted(reason) : reason;
    } finally {
      isLinking = false;
    }

    // ! stopped as it started: nothing of this link goes on, and its stop ends it once its start
    // settled
    if (isMarked(record)) {
      throw stoppedAsItStarted();
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
    if (isMarked(record)) {
      throw stoppedAsItStarted();
    }
    if (epoch === linkedEpoch) {
      resetEach(unclosed.splice(0));
      transition('up');
    }
  };

  const linked = (linkOptions?: {
    isStart?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<void> => {
    const isStart = linkOptions?.isStart === true;
    // ! the stop current at its call, which alone it answers to
    const record = current;

    if (isDisposed) {
      return Promise.reject(new ProgrammerError(`the participant ${id} is disposed`));
    }

    // * while a stop is under way, a start is a misuse; a connect fails, as one it overtook does
    if (record.isMarked) {
      return Promise.reject(
        isStart ? new ProgrammerError(`the participant ${id} is stopping`) : stoppedAsItConnected()
      );
    }

    if (isTakenOver && !isStart) {
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

    // * one attempt shared, the first start's or a reconnection's; one that fails is let go by
    // itself alone, so the next call starts another and a former one lets go of none after it
    if (linking === undefined) {
      const attempt: Promise<void> = link(linkOptions?.signal).catch((reason: unknown) => {
        if (linking === attempt) {
          linking = undefined;
        }

        throw toError(reason);
      });

      linking = attempt;
    }

    const shared = linking;

    if (isStart) {
      return shared;
    }

    // * a connect fails at once as a stop overtakes it, though the link it awaits ends later; an
    // adapter's misuse fails it as a connect, which another attempt may mend, as its own
    // reconnection takes it, and the start its application called meets it as it is
    return new Promise<void>((resolve, reject) => {
      const overtaken = (): void => {
        reject(stoppedAsItConnected());
      };

      record.ending.signal.addEventListener('abort', overtaken, { once: true });
      shared.then(
        () => {
          record.ending.signal.removeEventListener('abort', overtaken);
          resolve();
        },
        (reason: unknown) => {
          record.ending.signal.removeEventListener('abort', overtaken);
          reject(
            record.isMarked
              ? stoppedAsItConnected(reason)
              : reason instanceof ProgrammerError
                ? wrapReason(ConnectError, reason)
                : toError(reason)
          );
        }
      );
    });
  };

  // * its link lost: each connection closed, unclean, unreported; a new incarnation connected by
  // its own reconnection, without end unless its application bounds it, ended at once by its stop;
  // then a RESET to each peer it held a connection with
  const relink = async (
    former: { acceptor: Uint8Array; opener: Uint8Array; peer: string }[],
    fenced: AbortSignal
  ): Promise<void> => {
    const { delay = 1_000, maximumAttempts = Infinity, signal, tap } = reconnect;
    // ! the stop current as its link went down: its signal ends it, in a wait or once an attempt
    // failed, the stop the cause of its cancel
    const { ending } = current;
    // the attempts made, which its end's words count
    let attempts = 0;

    try {
      await attemptReconnection(
        async () => {
          attempts += 1;

          // * every failure of a link another attempt may mend, an adapter's misuse among them
          await link().catch((reason: unknown) => {
            throw wrapReason(ConnectError, reason);
          });
        },
        {
          clock,
          delay,
          maximumAttempts,
          signal: AbortSignal.any(
            signal === undefined ? [ending.signal, fenced] : [ending.signal, signal, fenced]
          ),
          tap,
        }
      );
    } catch (reason) {
      const cause = toError(reason);

      throw new GenericError(
        cause instanceof ReconnectError
          ? `the link of ${id} went down, and ${String(attempts)} attempts did not bring it back`
          : `the link of ${id} went down, and its reconnection ended: ${cause.message}`,
        { cause }
      );
    }

    resetEach(former);
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
    relinking?.abort();
    relinking = undefined;
    report(new GenericError(`the link of ${id} was taken over by another link of its id`));
  };

  const down = (event?: IBrokerDown): void => {
    if (!isLinked) {
      // * down as it stops: noted, so that what fails of its link then is read as that loss
      if (current.isMarked) {
        current.isDownAsItStops = true;
      }

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

    // * what its link held or was asked ends with it
    for (const entry of names.values()) {
      entry.isAsked = false;
      entry.isHeld = false;
    }

    departures.clear();
    transition(event?.isTakenOver === true ? 'taken-over' : 'down', ended);

    if (event?.isTakenOver === true) {
      fence();

      return;
    }

    if (!reconnects) {
      linking = undefined;

      report(new GenericError(`the link of ${id} went down`));

      return;
    }

    const fencing = new AbortController();

    relinking = fencing;

    const relinked = relink(former, fencing.signal).catch((reason: unknown) => {
      // * ended: it stays down, and the next start or connect links it anew
      if (linking === relinked) {
        linking = undefined;
      }

      // * taken over as it linked anew: its fence reported it
      if (!isTakenOver) {
        report(toError(reason));
      }

      throw toError(reason);
    });

    linking = relinked;
    linking.catch(noop);
  };

  // * a name let go as it stops, through its adapter, never `want`, which asks nothing of a link
  // down: told once let go; refused or past its adapter's bound, reported and held, unless its
  // link was lost meanwhile or none is up (spec 15.21)
  const letGoAsItStops = (
    name: string,
    { entry, record }: { entry: INameEntry; record: IStopRecord }
  ): Promise<void> => {
    let leaving: Promise<void>;

    // ! asked as it is called: an adapter that throws fails it as one that refuses
    try {
      leaving = adapter.unsubscribe(topicOf('s', name));
    } catch (reason) {
      leaving = Promise.reject(toError(reason));
    }

    return leaving.then(
      () => {
        // * its link lost meanwhile let it go of its own, told nothing
        if (record.isDownAsItStops) {
          return;
        }

        entry.isHeld = false;
        if (isDebugging()) {
          debug({ event: 'names', name, isHeld: false, group: entry.group });
        }
      },
      (reason: unknown) => {
        const error = toError(reason);

        if (!record.isDownAsItStops && error.message !== `the link of ${id} is not up`) {
          report(error);
        }
      }
    );
  };

  // * its link ended in place with what is under way, its adapter stopped once its start under way
  // settled and its broker let each name go, which sends each CLOSE first; shared until its next
  // link starts (spec 15.21)
  const stopInPlace = (): Promise<void> => {
    stopped ??= (async () => {
      const record = current;
      const ended = isDebugging()
        ? [...connections.values()].map((each) => {
            return each.ordinal;
          })
        : undefined;

      // ! a link up before it is shared by no later call, which links anew
      linking = undefined;
      relinking = undefined;

      // * in its turn, before its CLOSEs and before it reads its link down: each name its broker
      // holds or was asked to hold let go, kept wanted for its next link, so that its broker hands
      // it no OPEN once it read them (spec 15.18, 15.21)
      const letting = isLinked
        ? [...names]
            .filter(([, entry]) => {
              return entry.isHeld || entry.isAsked;
            })
            .map(([name, entry]) => {
              return letGoAsItStops(name, { entry, record });
            })
        : [];

      // * each CLOSE handed to its adapter before its stop: each pair its broker does not take is
      // reset at its next link
      const closes = [...connections.values()].map((each) => {
        const { connection, peer } = each;
        const pair = { acceptor: connection.acceptor, opener: connection.opener, peer: peer.id };

        return each.closeWith(CloseCode.GOING_AWAY).then((isTaken) => {
          return isTaken ? undefined : pair;
        });
      });

      failAwaiting(`the participant ${id} stopped as it connected`);
      record.isMarked = true;
      epoch += 1;
      isLinked = false;
      // * its adapter's start under way, given up, settles before its stop: the two never overlap,
      // and what that start brought up after the stop ends with it
      record.stopping.abort(stoppedAsItStarted());
      record.ending.abort(new GenericError(`the participant ${id} stopped`));

      try {
        await starting?.catch(noop);
        // * its adapter up while its broker lets each name go: an OPEN it hands meanwhile is
        // refused 503, that REFUSE among what its adapter's stop sends
        await Promise.all(letting);
        await adapter.stop();
      } finally {
        // ! an OPEN its link took as it ended, after its CLOSEs went, holds a connection on a link
        // ended: dropped, unclean
        for (const each of connections.values()) {
          each.drop();
        }

        for (const pair of await Promise.all(closes)) {
          if (pair !== undefined) {
            unclosed.push(pair);
          }
        }

        // * a name its broker did not let go, refused or past its bound, held until here
        for (const entry of names.values()) {
          entry.isAsked = false;
          entry.isHeld = false;
        }

        departures.clear();

        if (!isTakenOver) {
          transition('stopped', ended);
        }

        // ! renewed as it settles, never at the next start: a call made since reads a fresh one
        current = stopRecordOf();
      }
    })();

    return stopped;
  };

  adapter.on('message', take);
  adapter.on('down', down);

  const port: IBrokerParticipantPort = {
    adapter,
    clock,
    id,
    isSecure: adapter.isSecure,
    get isDisposed() {
      return isDisposed;
    },
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
    get stopped() {
      return current.ending.signal;
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
    // * once disposed, a stop settles with its dispose
    stop: () => {
      return disposed ?? stopInPlace();
    },
    transportClient: (clientOptions) => {
      return createBrokerTransportClient(participant, clientOptions);
    },
    transportServer: (serverOptions) => {
      return createBrokerTransportServer(participant, serverOptions);
    },
    [PARTICIPANT_PORT]: port,
    // ! final: stopped first, then its adapter's listeners and its announcement let go, once
    [Symbol.asyncDispose]: () => {
      disposed ??= (async () => {
        isDisposed = true;
        await stopInPlace();
        withdraw();
        adapter.off('message', take);
        adapter.off('down', down);
      })();

      return disposed;
    },
  };

  withdraw = options.devtools === false ? noop : announceParticipantToDevtools(participant);

  return participant;
};
