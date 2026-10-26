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
import { ConnectError, GenericError, ProgrammerError, toError } from './errors';
import { gaugesOf } from './gauges';
import {
  assertHeartbeat,
  createSilenceHeartbeat,
  HEARTBEAT,
  type ISilenceHeartbeat,
} from './heartbeat';
import { noop } from './noop';
import type {
  BrokerDelivery,
  BrokerPublished,
  BrokerTopic,
  IBrokerAdapter,
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
   * its clock (spec 15.20): a whole number above 0. Defaults to {@link MINIMUM_BODY_BYTES_PER_SECOND}.
   */
  minimumBodyBytesPerSecond?: number | undefined;
  /**
   * How its link connects again once lost, each time as a new incarnation: `delay` milliseconds
   * between attempts, 1,000 by default, `maxAttempts` attempts, without end by default; `false`
   * for none, which leaves it closed once its link is lost.
   */
  reconnect?: false | { delay?: number | undefined; maxAttempts?: number | undefined } | undefined;
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
  readonly root: string;
  /** What it holds: its connections, what it holds in parts, and the departures it subscribes. */
  gauges(): IGauges;
  off(event: 'error', listener: (error: Error) => void): this;
  /** What it reports of its own: a message that is no parcel, or its link given up on. */
  on(event: 'error', listener: (error: Error) => void): this;
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
  readonly peer: IBrokerPeer;
  /** What its broker has not taken yet of what it published. */
  readonly unsentBytes: number;
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
   * A connection, by both halves: at its acceptor half-open, its ACCEPT sent; at its opener open,
   * its third leg sent.
   */
  connect(
    pair: { acceptor: Uint8Array; isOpener: boolean; opener: Uint8Array; peer: IBrokerPeer },
    options: { maximumUnsentBytes: number; owner: IBrokerConnectionOwner }
  ): IBrokerConnection;
  /** A half, 8 bytes from a cryptographic source, never all zero, none it holds. */
  drawHalf(): Uint8Array;
  /** Resolves once its link is up, starting it the first time. */
  linked(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  /** Publishes an OPEN of `opener`'s half to a server's name. */
  open(name: string, opener: Uint8Array): Promise<BrokerPublished>;
  /** Refuses an OPEN with `status`, to the inbox it names. */
  refuse(open: IParcel, status: number): void;
  report(error: Error): void;
  /** Holds `names` for one server's transport of it; one another holds already is a {@link ProgrammerError}. */
  reserve(names: readonly string[]): void;
  serve(name: string, serving: IBrokerServing): void;
  /** Subscribes `name`, in its group when given, while wanted; lets it go once not. */
  want(name: string, { group, isWanted }: { group?: string | undefined; isWanted: boolean }): void;
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
        };

  assertCount('heldBytesBudget', { value: heldBytesBudget });
  assertCount('maximumEnvelopePartsBytes', { value: maximumEnvelopePartsBytes });
  assertCount('minimumBodyBytesPerSecond', { value: minimumBodyBytesPerSecond });

  const receiveBound = Math.min(adapter.receiveBound, LARGEST_RECEIVE_BOUND);

  if (receiveBound < LEAST_RECEIVE_BOUND) {
    throw new ProgrammerError(
      `a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of ${id} takes ${String(receiveBound)}`
    );
  }

  const emitter = createEmitter<{ error: [Error] }>();
  const held = createHeldBytes(heldBytesBudget);
  const partsBounds = {
    bodyGracePeriod,
    clock,
    maximumEnvelopePartsBytes,
    minimumBodyBytesPerSecond,
  };
  const topicOf = (kind: 'd' | 'i' | 's', token: string): BrokerTopic => {
    return Object.freeze([root, kind, token]);
  };
  const inbox = topicOf('i', id);

  // its connections by both halves, half-open ones among them
  const connections = new Map<string, IConnectionRecord>();
  // the connects awaiting their answer, by the opener's half
  const awaiting = new Map<string, IBrokerAnswers>();
  // the servers' transports, by the names they serve
  const serving = new Map<string, IBrokerServing>();
  // the names its servers' transports hold, each one's alone, from the time each is built
  const reserved = new Set<string>();
  // the names wanted, their group, and whether the broker holds them now
  const names = new Map<
    string,
    { group: string | undefined; isHeld: boolean; isWanted: boolean }
  >();
  // the departures it subscribes, by peer, while it holds a connection with it
  const departures = new Map<string, { count: number; isAsked: boolean; isHeld: boolean }>();

  let incarnation: Uint8Array | undefined;
  let linking: Promise<void> | undefined;
  let isLinked = false;
  let isStopped = false;

  const report = (error: Error): void => {
    emitter.emitEach('error', { onError: noop, params: [error] });
  };

  // a publication on the link, whatever its broker says of it; a link down tells itself by `down`
  const publish = (
    topic: BrokerTopic,
    payload: Uint8Array
  ): Promise<BrokerPublished | undefined> => {
    return adapter.publish({ payload, topic }).catch(() => {
      return undefined;
    });
  };

  // ── names and departures ──

  const holdName = (name: string): void => {
    const entry = names.get(name);

    if (entry === undefined || !entry.isWanted || entry.isHeld || !isLinked) {
      return;
    }

    entry.isHeld = true;
    adapter
      .subscribe(topicOf('s', name), entry.group === undefined ? {} : { group: entry.group })
      .catch((reason: unknown) => {
        entry.isHeld = false;
        report(toError(reason));
      });
  };

  const want = (
    name: string,
    { group, isWanted }: { group?: string | undefined; isWanted: boolean }
  ): void => {
    const entry = names.get(name) ?? { group, isHeld: false, isWanted };

    names.set(name, entry);
    entry.isWanted = isWanted;

    if (isWanted) {
      holdName(name);

      return;
    }

    if (entry.isHeld) {
      entry.isHeld = false;
      adapter.unsubscribe(topicOf('s', name)).catch(noop);
    }
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
    readonly connection: IBrokerConnection;
    /** Its peer's id and incarnation, which a GONE names. */
    readonly peer: IBrokerPeer;
    /** Dropped as its link went down: unclean, unreported, nothing sent. */
    drop(): void;
    take(parcel: IParcel): void;
    violate(read: { prefix: IParcelPrefix; reason: string }): void;
  }

  const connect: IBrokerParticipantPort['connect'] = (
    { acceptor, isOpener, opener, peer },
    { maximumUnsentBytes, owner }
  ) => {
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
    const sendParcel = (fields: Omit<ParcelFields, 'acceptor' | 'opener' | 'sequence'>): void => {
      const isReset = fields.kind === ParcelKind.RESET;
      const bytes = writeParcel({
        ...fields,
        acceptor,
        opener,
        sequence: isReset ? 0 : nextSend,
      });

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
      void publish(peerInbox, bytes).then((published) => {
        unsentBytes -= bytes.length;

        // a parcel its broker refused, or no subscriber took: its peer's inbox is gone, as a
        // dropped socket's peer
        if (published !== BROKER_PUBLISHED.TAKEN) {
          end(false);
        }
      });
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
      owner.report(
        new GenericError(`${owner.subject()} is closed with ${String(code)}: ${reason}`)
      );
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

    const record: IConnectionRecord = {
      connection: {
        acceptor,
        get isHalfOpen() {
          return isHalfOpen;
        },
        opener,
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
            sendParcel({
              carried,
              ...(index === 0 && credential !== undefined ? { credential } : {}),
              flags: index < pieces.length - 1 ? ParcelFlag.MORE : 0,
              kind: ParcelKind.DATA,
            });
          }

          return Promise.resolve();
        },
      },
      peer,
      drop: () => {
        end(false);
      },
      take: (parcel) => {
        beat?.heard();

        if (parcel.kind === ParcelKind.RESET) {
          end(false);

          return;
        }

        if (parcel.layout !== PARCEL_LAYOUT) {
          lose({
            code: CloseCode.PROTOCOL_ERROR,
            reason: `a parcel of a layout to come, ${hexOfByte(parcel.layout)}`,
          });

          return;
        }

        const verdict = received.take(parcel.sequence);

        if (verdict === SEQUENCE_VERDICTS.COPY) {
          return undefined;
        }

        if (verdict === SEQUENCE_VERDICTS.LOSS) {
          lose(gapOf({ awaited: received.awaited, came: parcel.sequence }));

          return;
        }

        // * its third leg: the opener's first parcel naming both halves proves it reads its inbox
        if (isHalfOpen) {
          open();
          owner.opened?.();
        }

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
      violate: ({ prefix, reason }) => {
        beat?.heard();

        // a kind to come is taken in its order: a copy dropped, a gap a loss
        if (isKindToCome(prefix.kind) && prefix.sequence <= Number.MAX_SAFE_INTEGER) {
          const verdict = received.take(prefix.sequence);

          if (verdict === SEQUENCE_VERDICTS.COPY) {
            return;
          }

          if (verdict === SEQUENCE_VERDICTS.LOSS) {
            lose(gapOf({ awaited: received.awaited, came: prefix.sequence }));

            return;
          }
        }

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
        flags: adapter.isSecure ? ParcelFlag.SECURE : 0,
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

    void publish(
      topicOf('i', peerId),
      writeParcel({ acceptor, kind: ParcelKind.RESET, opener, sequence: 0 })
    );
  };

  const refuse = (open: IParcel, status: number): void => {
    if (open.id === undefined) {
      return;
    }

    void publish(
      topicOf('i', open.id),
      writeParcel({
        acceptor: ZERO_HALF,
        kind: ParcelKind.REFUSE,
        ...(status === 426 ? { layouts: [PARCEL_LAYOUT] } : {}),
        opener: open.opener,
        sequence: 1,
        status,
      })
    );
  };

  const takeAtInbox = (payload: Uint8Array): void => {
    const read = readParcel(payload);

    if ('refused' in read && read.refused === 'no-parcel') {
      report(new GenericError(`a message to the inbox of ${id} is no parcel: ${read.reason}`));

      return;
    }

    if ('prefix' in read) {
      return connections.get(pairOf(read.prefix))?.violate(read);
    }

    const { parcel } = read;
    const record = connections.get(pairOf(parcel));

    if (record !== undefined) {
      record.take(parcel);

      return;
    }

    const answers = awaiting.get(keyOf(parcel.opener));

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
  const takeAtDeparture = (payload: Uint8Array): void => {
    const read = readParcel(payload);

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
      if (retained === true || first !== root || topic.length !== 3) {
        return;
      }

      if (kind === 'i' && token === id) {
        takeAtInbox(payload);
      } else if (kind === 's') {
        takeAtName(token, payload);
      } else if (kind === 'd') {
        takeAtDeparture(payload);
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

    await adapter.start({ signal, will });
    await adapter.subscribe(inbox, { signal });
    incarnation = drawnIncarnation;
    isLinked = true;

    for (const name of names.keys()) {
      holdName(name);
    }
  };

  const linked = (linkOptions?: { signal?: AbortSignal | undefined }): Promise<void> => {
    if (isStopped) {
      return Promise.reject(new GenericError(`the participant ${id} is stopped`));
    }

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
    const { delay, maxAttempts } = reconnection ?? { delay: 0, maxAttempts: 0 };

    for (let attempt = 1; ; attempt += 1) {
      if (isStopped) {
        throw new GenericError(`the participant ${id} is stopped`);
      }

      try {
        await link();
        break;
      } catch (reason) {
        if (attempt >= maxAttempts) {
          throw new GenericError(
            `the link of ${id} went down, and ${String(attempt)} attempts did not bring it back`,
            { cause: reason }
          );
        }
      }

      await createPromise(
        (resolve) => {
          resolve();
        },
        { clock, delay }
      );
    }

    for (const { acceptor, opener, peer } of former) {
      void publish(
        topicOf('i', peer),
        writeParcel({ acceptor, kind: ParcelKind.RESET, opener, sequence: 0 })
      );
    }
  };

  // a connect awaiting its answer fails: what it opened toward is the former link's
  const failAwaiting = (why: string): void => {
    for (const answers of awaiting.values()) {
      answers.fail(new ConnectError(why));
    }

    awaiting.clear();
  };

  const down = (): void => {
    if (!isLinked) {
      return;
    }

    isLinked = false;

    const former = [...connections.values()].map(({ connection, peer }) => {
      return { acceptor: connection.acceptor, opener: connection.opener, peer: peer.id };
    });

    for (const record of connections.values()) {
      record.drop();
    }

    failAwaiting(`the link of ${id} went down as it connected`);

    for (const entry of names.values()) {
      entry.isHeld = false;
    }

    departures.clear();

    if (reconnection === undefined) {
      linking = undefined;

      report(new GenericError(`the link of ${id} went down`));

      return;
    }

    linking = relink(former).catch((reason: unknown) => {
      linking = undefined;
      report(toError(reason));

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
    open: async (name, opener) => {
      if (incarnation === undefined) {
        throw new GenericError(`the link of ${id} is not up`);
      }

      const published = await adapter.publish({
        payload: writeParcel({
          acceptor: ZERO_HALF,
          bound: receiveBound,
          flags: adapter.isSecure ? ParcelFlag.SECURE : 0,
          id,
          incarnation,
          kind: ParcelKind.OPEN,
          opener,
          sequence: 1,
        }),
        topic: topicOf('s', name),
      });

      return published;
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
    gauges: () => {
      let halfOpen = 0;
      let unsentBytes = 0;

      for (const { connection } of connections.values()) {
        halfOpen += connection.isHalfOpen ? 1 : 0;
        unsentBytes += connection.unsentBytes;
      }

      return gaugesOf({
        ceilings: { largestPartsBytes: held.budget },
        counts: {
          connections: connections.size - halfOpen,
          departures: [...departures.values()].filter(({ isHeld }) => {
            return isHeld;
          }).length,
          halfOpen,
          largestPartsBytes: held.largest,
          partsBytes: held.held,
          unsentBytes,
        },
      });
    },
    off: (event, listener) => {
      emitter.off(event, listener);

      return participant;
    },
    on: (event, listener) => {
      emitter.on(event, listener);

      return participant;
    },
    start: async (startOptions) => {
      await linked(startOptions);
    },
    stop: async () => {
      if (isStopped) {
        return;
      }

      for (const record of connections.values()) {
        record.connection.close(CloseCode.GOING_AWAY);
      }

      failAwaiting(`the participant ${id} stopped as it connected`);
      isStopped = true;
      isLinked = false;
      await adapter.stop();
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

  return participant;
};
