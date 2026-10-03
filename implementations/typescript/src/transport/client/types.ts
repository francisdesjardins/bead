// dependencies

import type { IClock } from '../shared/clock';
import type { CLOSE_EVENT, ERROR_EVENT, MESSAGE_EVENT } from '../shared/constants';
import type {
  Data,
  EmitterListener,
  IEventIteratorOptions,
  IReadyStateMethods,
  IWorkerPortLike,
} from '../shared/types';
import type { dispose } from './symbols';

// interfaces

/** What every connect takes: when to give up on it. */
export interface ITransportClientConnectOptions {
  /**
   * Aborting it gives up on the connection with a {@link CancelError}; one already aborted does so
   * before the transport is reached.
   */
  signal?: AbortSignal | undefined;
  /**
   * Milliseconds before `connect` rejects with a {@link TimeoutError}; `0` never times out. One a
   * timer does not hold — under a millisecond, or past 2³¹ − 1 — rejects with a
   * {@link ProgrammerError}.
   */
  timeout?: number | undefined;
}

/** What a connect over the network takes besides: where it goes. */
export interface ITransportClientAddressOptions extends ITransportClientConnectOptions {
  /** The host to reach. */
  host: string;
  /** The port to reach it on. */
  port: number;
}

export interface ITransportClientDisconnectOptions {
  /** Reported as `wasClean` on the `close` event. */
  isClean?: boolean | undefined;
  /** Drops the socket at once instead of waiting for its close handshake. */
  isQuick?: boolean | undefined;
}

/** What every transport client takes, and each transport extends with its own. */
export interface ITransportClientOptions {
  /**
   * The clock its connects, its waits and its reconnection run on, and the layers built on it with
   * it; the platform's when not given.
   */
  clock?: IClock | undefined;
}

export interface ITransportClientReconnectOptions {
  /**
   * Milliseconds to wait after a failed attempt before the next one, or a function of the previous
   * wait and the number of the attempt that failed. The first attempt goes at once; one of 0 or less
   * waits none, and one a timer does not hold — under a millisecond, or past 2³¹ − 1 — rejects with
   * a {@link ProgrammerError}.
   */
  delay?: TransportClientReconnectDelayOrDelayResolver | undefined;
  /** Attempts before giving up with a {@link ReconnectError}; there is always at least one. */
  maxAttempts?: number | undefined;
  /**
   * Aborting it stops the attempts, the one connecting included, or disconnects a success, with a
   * {@link CancelError}.
   */
  signal?: AbortSignal | undefined;
  /** Told the wait and the number of the attempt that failed, before waiting. */
  tap?: TransportClientReconnectTapCallback | undefined;
}

/** A transport's client side: one connection, its state, its events and its reconnection. */
export interface ITransportClient<
  Socket extends object = object,
  ConnectOptions extends ITransportClientConnectOptions = ITransportClientAddressOptions,
> extends IReadyStateMethods {
  /** The clock it runs on, which a layer built on it runs on too. */
  readonly clock: IClock;
  /** The current or last connection, possibly closed; `null` before the first and once dropped. */
  socket: Socket | null;

  /**
   * Opens the connection. Rejects with a {@link ProgrammerError} unless UNINITIALIZED or CLOSED, a
   * {@link ConnectError} when it cannot open, a {@link TimeoutError}, or a {@link CancelError}.
   */
  connect(options: ConnectOptions): Promise<void>;
  /**
   * Closes the connection and emits `close`. Rejects with a {@link ReadyStateError} unless OPEN, or a
   * {@link ProgrammerError} when the socket's close throws; the socket is then dropped, as
   * `[dispose]` drops one, ending CLOSED without a `close`.
   */
  disconnect(options?: ITransportClientDisconnectOptions): Promise<void>;
  emit<K extends TRANSPORT_CLIENT_EVENTS>(event: K, ...params: TransportClientEventMap[K]): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends TRANSPORT_CLIENT_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<TransportClientEventMap[K], undefined>;
  off<K extends TRANSPORT_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<TransportClientEventMap[K]>
  ): this;
  on<K extends TRANSPORT_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<TransportClientEventMap[K]>
  ): this;
  once<K extends TRANSPORT_CLIENT_EVENTS>(
    event: K,
    listener: EmitterListener<TransportClientEventMap[K]>
  ): this;
  /**
   * Connects again with the options of the last accepted `connect`, replacing an open socket without
   * a `close`. Attempts that run out end CLOSED without a `close`; a cancel after a successful
   * attempt disconnects, which emits one; a misuse or an already aborted signal leaves the state as it
   * was. Rejects with a {@link ProgrammerError}, a {@link ReconnectError} or a {@link CancelError};
   * an error thrown by `tap` passes through.
   */
  reconnect(options?: ITransportClientReconnectOptions): Promise<void>;
  removeAllListeners(event?: TRANSPORT_CLIENT_EVENTS): this;
  /**
   * Resolves once the message is on its way, not once it is delivered: over a socket, once the
   * socket has accepted it; over HTTP, on the head of its exchange's answer — the server had it — or
   * on its exchange lost, which closes the connection. Rejects with a {@link ReadyStateError} unless
   * OPEN, and over HTTP with a {@link GenericError} on a refusal the server marked, nothing tried; the
   * socket's own error passes through.
   */
  send(data: Data): Promise<void>;
  /**
   * What `await using` calls: disconnects an open client, and drops a connecting one. A reconnection
   * in progress is not stopped by it; abort its signal.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The client as its implementation reaches it: the public one, and the drop that only the
 * implementation and {@link createTransportClient} use. An application closes with `disconnect`,
 * cancels a connect with its `signal`, or lets `await using` do either.
 */
export interface ITransportClientInternal<
  Socket extends object = object,
  ConnectOptions extends ITransportClientConnectOptions = ITransportClientAddressOptions,
> extends ITransportClient<Socket, ConnectOptions> {
  /**
   * Drops the socket without a handshake and without a `close`: a connect in flight rejects, a
   * disconnect in flight resolves.
   */
  [dispose](): void;
}

/**
 * What a transport supplies to {@link createTransportClient}. It sets OPEN on every successful
 * connect, and moves its client through CONNECTING, CLOSING and CLOSED, emitting `close`, except
 * while `client.isReconnecting()`, when the shared half owns those; its `[dispose]` never touches the
 * state.
 */
export interface ITransportClientImplementation<
  ConnectOptions extends ITransportClientConnectOptions,
> {
  /** The clock it runs on, which the shared half waits on too; the platform's when none. */
  readonly clock?: IClock | undefined;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(options?: ITransportClientDisconnectOptions): Promise<void>;
  send(data: Data): Promise<void>;
  [dispose](): void;
}

// types

/** Event name → the arguments its listeners receive. */
export type TransportClientEventMap = {
  /**
   * `wasClean` is what `disconnect` was told, and false when the peer or the network closed;
   * `wasQuick` is true when the socket was dropped without a handshake.
   */
  close: [wasClean: boolean, wasQuick: boolean];
  /**
   * What went wrong on the connection; when it ends the connection, its `close` follows. No transport
   * client in this package emits it: a failure there shows as `connect` rejecting, or as `close`.
   */
  error: [error: Error];
  /** Not emitted while the client is closing. */
  message: [data: Data];
  /**
   * A reconnection starts: what was sent on the connection it replaces will not be answered there. An
   * open connection it replaces emits no `close`, so this is the one sign of it.
   */
  reconnect: [];
};

/** The events a client emits, named by the table that types them. */
export type TRANSPORT_CLIENT_EVENTS = keyof TransportClientEventMap;

export type TransportClientOnCloseCallback = EmitterListener<TransportClientEventMap[CLOSE_EVENT]>;
export type TransportClientOnErrorCallback = EmitterListener<TransportClientEventMap[ERROR_EVENT]>;
export type TransportClientOnMessageCallback = EmitterListener<
  TransportClientEventMap[MESSAGE_EVENT]
>;

export type TransportClientReconnectDelay = number;
export type TransportClientReconnectDelayResolver = (
  previousDelay: number | undefined,
  attempt: number
) => TransportClientReconnectDelay;
export type TransportClientReconnectDelayOrDelayResolver =
  | TransportClientReconnectDelay
  | TransportClientReconnectDelayResolver;
export type TransportClientReconnectTapCallback = (nextDelay: number, attempt: number) => void;

// ── WebSocket ─────────────────────────────────────────────────────────────────

// interfaces

export interface ICloseEventLike {
  code: number;
  reason: string;
}

export interface IMessageEventLike {
  /** `unknown` because `ws` types it with the `Buffer[]` of `'fragments'`, which `binaryType` excludes. */
  data: unknown;
}

/** The part of a WebSocket this transport touches — met by the global `WebSocket` and by `ws`. */
export interface IWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onclose: Handler<ICloseEventLike> | null;
  onerror: Handler<unknown> | null;
  onmessage: Handler<IMessageEventLike> | null;
  onopen: Handler<unknown> | null;
  close(code?: number, reason?: string): void;
  /** `ws`'s alone: a browser's socket cannot ping, and answers its server's pings by itself. */
  on?(event: 'pong', listener: () => void): unknown;
  /** As `on`. */
  ping?(): void;
  send(data: Data): void;
  /** As `on`: drops the socket without a close handshake. */
  terminate?(): void;
}

/** `CONNECTING` and `OPEN` are read from the injected constructor, so `ws` and the global agree. */
export interface IWebSocketConstructor {
  new (url: string, protocols?: string | string[]): IWebSocketLike;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

export interface IWSTransportClientConnectOptions extends ITransportClientAddressOptions {
  /** Prefixed with a single leading slash. */
  pathname?: string | undefined;
  /** The subprotocols offered in the handshake. */
  protocols?: string[] | undefined;
  /** `wss` rather than `ws`. */
  secured?: boolean | undefined;
}

export interface IWSTransportClientOptions extends ITransportClientOptions {
  /**
   * Defaults to {@link TRANSPORT_WEBSOCKET_BINARYTYPE}. `ws`'s `'fragments'` is left out: it delivers
   * an array of buffers, which is not a {@link Data}. `'nodebuffer'` needs `ws`; the global
   * WebSocket ignores it and keeps delivering Blobs.
   */
  binaryType?: 'arraybuffer' | 'blob' | 'nodebuffer' | undefined;
  /**
   * Milliseconds between two pings of the server, and `Infinity` for none: a server that has not
   * answered one by the next is dropped, and the client closes. Defaults to {@link HEARTBEAT}. Only a
   * socket that can ping beats — `ws`'s; a browser's cannot, and its server's pings stand for it.
   */
  heartbeat?: number | undefined;
  /** Defaults to the global `WebSocket`; pass `ws`'s where there is none. */
  WebSocket?: IWebSocketConstructor | undefined;
}

// types

// Declared as methods and read back as properties: a method's parameters are compared both ways,
// which is what lets the DOM's `(this: WebSocket, ev: CloseEvent) => any` and `ws`'s own handler
// types both satisfy these without a cast.
type Handler<E> = { handler(event: E): void }['handler'];

export type WSTransportClient = ITransportClient<IWebSocketLike, IWSTransportClientConnectOptions>;

// ── HTTP ──────────────────────────────────────────────────────────────────────

// interfaces

/** A connection the server drew for an HTTP client, as it shows it: where its exchanges go, never its token. */
export interface IHTTPClientConnection {
  readonly url: string;
}

/** What this transport hands `fetch`. */
export interface IFetchInit {
  body?: BodyInit | undefined;
  headers: Record<string, string>;
  /** Set on a DELETE, so it outlives a page that is closing. */
  keepalive?: boolean | undefined;
  method: 'DELETE' | 'GET' | 'POST';
  /** Always `'error'`: a redirect would turn a POST into a GET, and drop its envelope. */
  redirect: 'error';
  signal?: AbortSignal | undefined;
}

/** The part of a response this transport reads — met by `fetch`'s. */
export interface IFetchResponseLike {
  /** Its body as it comes, which a listen reads; none on a 204. */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: { get(name: string): string | null };
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface IHTTPTransportClientConnectOptions extends ITransportClientAddressOptions {
  /** The path the server answers on, prefixed with a single leading slash; `/bead` by default. */
  pathname?: string | undefined;
  /** `https` rather than `http`. */
  secured?: boolean | undefined;
}

export interface IHTTPTransportClientOptions extends ITransportClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike | undefined;
  /**
   * Milliseconds the client goes on listening again, its listens lost, before it counts its
   * connection lost: the server's own inactivity timeout by default, past which the server would
   * have closed it; `Infinity` for as long as the server does not say it is gone. Defaults to
   * {@link INACTIVITY_TIMEOUT}.
   */
  inactivityTimeout?: number | undefined;
  /**
   * Whether the client listens for what the server sends of its own — a notification, a command, a
   * relayed request, a cancel: it says so at connect, and, once the server says it back, listens as
   * long as it is connected. One that does not is refused a subscription. Defaults to `true`.
   */
  isListening?: boolean | undefined;
  /**
   * The largest answer taken, in bytes: an envelope's limit; one past it loses the connection. It is
   * checked once the answer is read, and it bounds each envelope a listen brings back, alone, as it
   * comes. Defaults to {@link MAXIMUM_BODY_BYTES}.
   */
  maximumBodyBytes?: number | undefined;
  /**
   * Milliseconds between a listen that brought nothing back and the next: `0` listens again at once.
   * A pause past the server's inactivity timeout loses the connection. Defaults to `0`.
   */
  pause?: number | undefined;
  /**
   * Milliseconds each listen asks the server to wait for something to bring back, which the server
   * caps; `0` asks it to answer at once, which polls. Defaults to {@link WAIT}.
   */
  wait?: number | undefined;
}

// types

/** The part of `fetch` this transport calls — met by the global one. */
export type FetchLike = (url: string, init: IFetchInit) => Promise<IFetchResponseLike>;

export type HTTPTransportClient = ITransportClient<
  IHTTPClientConnection,
  IHTTPTransportClientConnectOptions
>;

// ── Worker ────────────────────────────────────────────────────────────────────

// interfaces

/**
 * What a page posts its connects to: a `Worker`, or any port to one. Its `error`, when it has one,
 * loses the connection.
 */
export interface IWorkerLike {
  addEventListener?(type: 'error', listener: () => void): void;
  postMessage(message: unknown, transfer: readonly unknown[]): void;
  removeEventListener?(type: 'error', listener: () => void): void;
}

/** A connection's two ends: the client's own, and the one it hands the worker. */
export interface IWorkerChannelLike {
  readonly port1: IWorkerPortLike;
  readonly port2: unknown;
}

export interface IWorkerTransportClientOptions extends ITransportClientOptions {
  /** Makes each connection's channel; the global `MessageChannel` by default. */
  MessageChannel?: (new () => IWorkerChannelLike) | undefined;
  worker: IWorkerLike;
}

// types

export type WorkerTransportClient = ITransportClient<
  IWorkerPortLike,
  ITransportClientConnectOptions
>;
