// dependencies

import type { IClock } from './clock';

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
 * came, its surrounding whitespace removed; a WebSocket and a Web Worker carry none, and what a listen
 * brings back carries none either.
 */
export interface ITransportMessage {
  /**
   * The client's address of what brought it, as a server's transport reads it: over HTTP its
   * exchange's, over a WebSocket its connection's; none over a Web Worker, nor toward a client.
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

// types

/** What a transport receives and sends: what a WebSocket, `ws` or a socket deliver. */
export type Data = string | ArrayBuffer | ArrayBufferView | Blob;

/** Event name → the arguments its listeners receive. */
export type EmitterEventMap<E> = { [K in keyof E]: unknown[] };

export type EmitterListener<P extends unknown[]> = (...params: P) => void;

export type PromiseExecutor<T> = (
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason: Error) => void
) => void;
