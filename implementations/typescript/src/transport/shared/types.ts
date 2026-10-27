// dependencies

import type { IClock } from './clock';
import type { BROKER_DELIVERIES, BROKER_PUBLISHED, TRANSPORTS } from './constants';

// interfaces

export interface ICreatePromiseOptions {
  /** The clock its timers run on; the platform's when not given. */
  clock?: IClock | undefined;
  /**
   * Milliseconds to wait before the executor runs, rounded to the nearest whole one: 0, the default,
   * runs it at once; `Infinity` is refused.
   */
  delay?: number | undefined;
  /**
   * Aborting it rejects with a {@link CancelError} carrying the signal's reason; one already aborted
   * does so without running the executor.
   */
  signal?: AbortSignal | undefined;
  /**
   * Milliseconds the executor gets once the delay is over, rounded to the nearest whole one; the
   * {@link TimeoutError} reports the delay and the timeout together. `Infinity` or absent never
   * times out; 0 is refused.
   */
  timeout?: number | undefined;
}

export interface IEmitter<E extends EmitterEventMap<E>> {
  emit<K extends keyof E>(event: K, ...params: E[K]): boolean;
  /**
   * As `emit`, each listener called within a guard: what one throws goes to `onError`, and the
   * listeners after it are called all the same.
   */
  emitEach<K extends keyof E>(
    event: K,
    guarded: { onError: (error: unknown) => void; params: E[K] }
  ): boolean;
  /** How many registrations `event` has: a `once` counts until it fires. */
  listenerCount(event: keyof E): number;
  off<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): void;
  on<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): void;
  once<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): void;
  removeAllListeners(event?: keyof E): void;
}

/** One `on` or `once` of one listener: the emitter counts registrations, not listeners. */
export interface IEmitterRegistration<P extends unknown[]> {
  hasFired: boolean;
  isOnce: boolean;
  listener: EmitterListener<P>;
}

export interface IEventIteratorOptions {
  /** Aborting it ends the iteration, as a `break` would. */
  signal?: AbortSignal | undefined;
}

/** The event half every transport end shares; each registration returns the end itself. */
export interface IEventMethods<E extends EmitterEventMap<E>, End> {
  emit<K extends keyof E>(event: K, ...params: E[K]): boolean;
  /** Every `event` from now on, as its arguments, for `for await`. */
  events<K extends keyof E>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<E[K], undefined>;
  off<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): End;
  on<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): End;
  once<K extends keyof E>(event: K, listener: EmitterListener<E[K]>): End;
  removeAllListeners(event?: keyof E): End;
}

/** The ready-state half every transport end shares. */
export interface IReadyStateMethods {
  isClosed(): boolean;
  isClosing(): boolean;
  isConnecting(): boolean;
  isOpen(): boolean;
  isReconnecting(): boolean;
  isUninitialized(): boolean;
}

/**
 * What a part holds right now, for diagnosis: each count by its name, the ceiling of a count that has
 * one under the same name, the connections it keeps anything for, and each anomaly — what should never
 * be — told in a sentence that names no connection, token or address.
 */
export interface IGauges<Handle extends string = string> {
  readonly anomalies: readonly string[];
  readonly ceilings: Readonly<Record<string, number>>;
  readonly connectionHandles: ReadonlySet<Handle>;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * What a transport carries, both ways: an envelope, and the credential it carried beside it (spec
 * 15.1). Over HTTP, it is the `Authorization` field of the `POST /bead` that carries a request, as it
 * came, its surrounding whitespace removed; in memory, what its client handed with a request; a
 * WebSocket and a Web Worker carry none, and what a listen brings back carries none either.
 */
export interface ITransportMessage {
  /**
   * The client's address of what brought it, as a server's transport reads it: over HTTP its
   * exchange's, over a WebSocket its connection's, in memory the one its client gave as it connected;
   * none over a Web Worker, nor toward a client.
   */
  readonly address?: string | undefined;
  /** None when nothing was carried: an empty field carries none. */
  readonly credential?: string | undefined;
  readonly data: Data;
  /**
   * Whether it came by a way that keeps no order with the answers to the requests its side sent,
   * which it may overtake: over HTTP, a listen's batch (spec 15.9). None for any other.
   */
  readonly mayOvertake?: boolean | undefined;
  /** The port of what brought it, beside its `address`. */
  readonly port?: number | undefined;
}

/**
 * One end of an in-memory connection, as the other end reaches it (spec 15.13). The other end calls
 * it in a later turn than what it tells, never within it, in the order it happened.
 */
export interface IMemoryEndLike {
  /**
   * The other end closed the connection: `wasClean` when by its own word, as a WebSocket's 1000;
   * not when it dropped it.
   */
  close(wasClean: boolean): void;
  /** An envelope the other end sent, in bytes of its own, and what came beside it. */
  receive(message: ITransportMessage): void;
}

/** A client's end, as its connect hands it to its server: the address and port it gave, or none. */
export interface IMemoryPeerLike extends IMemoryEndLike {
  readonly address: string;
  readonly port: number | undefined;
}

/** What an in-memory connect hands its server beside its end. */
export interface IMemoryAcceptOptions {
  /** Aborted once its client gave the connect up: a server draws no connection for it then. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * What an in-memory client connects to: its server, which meets it, or anything that accepts a
 * connection as it does. `accept` resolves, in a later turn, with the server's end of a connection
 * it drew, or rejects with a {@link ConnectError} when it takes none, and with a `CancelError`,
 * none drawn, when its signal was aborted by the turn it would draw it in.
 */
export interface IMemoryTransportServerLike {
  accept(peer: IMemoryPeerLike, options?: IMemoryAcceptOptions): Promise<IMemoryEndLike>;
}

/** A message as a port or a worker's scope delivers it: its data, and the ports it carried. */
export interface IWorkerMessageEventLike {
  readonly data: unknown;
  readonly ports: readonly IWorkerPortLike[];
}

/** The part of a `MessagePort` a worker transport touches — met by a browser's and by Node's. */
export interface IWorkerPortLike {
  addEventListener(type: 'message', listener: (event: IWorkerMessageEventLike) => void): void;
  close(): void;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  start(): void;
}

/**
 * A message a broker's adapter hands its participant (spec 15.24): the topic it came to, its
 * payload, whether its broker handed it as one it kept, and its acknowledgement, which the
 * participant calls once it took it, handed on or dropped as a copy, never once its router is done
 * with it (spec 15.19).
 */
export interface IBrokerMessage {
  readonly payload: Uint8Array;
  /** Handed on as a message its broker kept, which a participant drops in silence (spec 15.23). */
  readonly retained?: boolean | undefined;
  readonly topic: BrokerTopic;
  settle(): void;
}

/**
 * The peer of a broker's connection, as its OPEN or its ACCEPT named it (spec 15.18): its
 * participant's id, its incarnation, the largest parcel its inbox takes whole, and whether its own
 * leg is secure.
 */
export interface IBrokerPeer {
  readonly bound: number;
  readonly id: string;
  readonly incarnation: Uint8Array;
  readonly isSecure: boolean;
}

/** A link lost, as its adapter tells it: whether another link of its identity took it over. */
export interface IBrokerDown {
  /** Ended by its broker for another link of its id (spec 15.21): its participant connects no more. */
  readonly isTakenOver: boolean;
}

/** What a participant publishes: a payload to a topic, and how long its broker may keep it. */
export interface IBrokerPublication {
  /** Milliseconds its broker keeps it before onward delivery, where its adapter offers `expiry`. */
  readonly expiresAfter?: number | undefined;
  readonly payload: Uint8Array;
  readonly signal?: AbortSignal | undefined;
  readonly topic: BrokerTopic;
}

/** How a participant subscribes a topic: alone, or as one member of a group. */
export interface IBrokerSubscription {
  /** The group it joins, whose broker hands each message to one member, where `groups` is offered. */
  readonly group?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** How a participant starts its link: the will its broker publishes should the link be lost. */
export interface IBrokerStart {
  readonly signal?: AbortSignal | undefined;
  /** What its broker publishes once it loses the link without a clean end, where `will` is offered. */
  readonly will?: { readonly payload: Uint8Array; readonly topic: BrokerTopic } | undefined;
}

/** What an adapter offers besides what every adapter does (spec 15.24). */
export interface IBrokerCapabilities {
  /** A message's life in its broker, a publication's `expiresAfter`. */
  readonly expiry?: boolean | undefined;
  /** A subscription in a group, its broker handing each message to one member. */
  readonly groups?: boolean | undefined;
  /** A publication no subscriber takes, said so: {@link BROKER_PUBLISHED}'s `NO_SUBSCRIBER`. */
  readonly noSubscriber?: boolean | undefined;
  /** A will, published once its link is lost without a clean end. */
  readonly will?: boolean | undefined;
}

/**
 * One broker's client, as a participant reaches it (spec 15.24): the identity its broker
 * authenticates its link by, a link that keeps no broker session, publications and subscriptions
 * at topics, each message with its acknowledgement, the link's loss, its bounds, its delivery and
 * whether its leg is secure. An adapter routes nothing of Bead's: it carries bytes at topics.
 */
export interface IBrokerAdapter {
  readonly capabilities: IBrokerCapabilities;
  /**
   * At least once, its broker acknowledging each publication it took, and its adapter holding what it
   * publishes to the quota its broker gives; or at most once.
   */
  readonly delivery: BrokerDelivery;
  /** The identity its broker authenticates its link by, a token (spec 15.16): never one Bead draws. */
  readonly id: string;
  /** Its leg under TLS, its broker on the loopback, or in memory (spec 15.22). */
  readonly isSecure: boolean;
  /** Its connections' handles' type: `BROKER` in memory, `MQTT` over MQTT 5. */
  readonly type: TRANSPORTS;
  /** The largest payload a message it publishes to `topic` carries, its own bytes deducted. */
  maximumPayloadBytes(topic: BrokerTopic): number;
  off(event: 'down', listener: (down: IBrokerDown) => void): unknown;
  off(event: 'message', listener: (message: IBrokerMessage) => void): unknown;
  /** Its link lost, or taken over: every message after is a new link's. */
  on(event: 'down', listener: (down: IBrokerDown) => void): unknown;
  on(event: 'message', listener: (message: IBrokerMessage) => void): unknown;
  /**
   * Publishes a payload, settling once its broker took it, at least once, or as it goes, at most
   * once; or said refused when no subscriber takes it, where its broker says so.
   */
  publish(publication: IBrokerPublication): Promise<BrokerPublished>;
  /** The largest payload a message to `topic`, its own inbox, carries whole. */
  receiveBound(topic: BrokerTopic): number;
  /** Connects a link that keeps no broker session, its will set where it takes one. */
  start(options?: IBrokerStart): Promise<void>;
  /** Ends its link cleanly, so no will goes. */
  stop(): Promise<void>;
  /** Holds a subscription, settling once its broker holds it. */
  subscribe(topic: BrokerTopic, options?: IBrokerSubscription): Promise<void>;
  unsubscribe(topic: BrokerTopic): Promise<void>;
}

// types

/**
 * A topic, by its tokens (spec 15.16): `['bead', 'i', 'ada']`, a participant's inbox; each adapter
 * writes it as its broker's binding says.
 */
export type BrokerTopic = readonly string[];

/** The delivery an adapter gives (spec 15.19). */
export type BrokerDelivery = (typeof BROKER_DELIVERIES)[keyof typeof BROKER_DELIVERIES];

/** What a broker said of a publication. */
export type BrokerPublished = (typeof BROKER_PUBLISHED)[keyof typeof BROKER_PUBLISHED];

/** What a transport receives and sends: what a WebSocket, `ws` or a socket deliver. */
export type Data = string | ArrayBuffer | ArrayBufferView | Blob;

/** Event name → the arguments its listeners receive. */
export type EmitterEventMap<E> = { [K in keyof E]: unknown[] };

export type EmitterListener<P extends unknown[]> = (...params: P) => void;

export type PromiseExecutor<T> = (
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason: Error) => void
) => void;
