// dependencies

import type { IClock } from '../shared/clock';
import type { CLOSE_EVENT, ERROR_EVENT, MESSAGE_EVENT } from '../shared/constants';
import type {
  Data,
  EmitterListener,
  IEventIteratorOptions,
  IMemoryEndLike,
  IMemoryTransportServerLike,
  IReadyStateMethods,
  ITransportMessage,
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
   * Milliseconds before `connect` rejects with a {@link TimeoutError}: from 1 to 2³¹ − 1, rounded to
   * the nearest whole one, or `Infinity`, which never times out. Any other, 0 among them, rejects
   * with a {@link ProgrammerError}.
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
   * wait and the number of the attempt that failed. The first attempt goes at once; one of 0 waits
   * none, one from 1 to 2³¹ − 1 is rounded to the nearest whole one, which `tap` hears, and any
   * other — `Infinity` among them — rejects with a {@link ProgrammerError}, before `tap` hears it.
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
  /**
   * Whether it is secure, judged by what it was given, never by what a name resolves to (spec 13.4):
   * the URL of its current or last connect under TLS, `wss` or `https`, or to a loopback host; a
   * worker, which never leaves the machine. Not before its first connect.
   */
  readonly isSecure: boolean;
  /** The current or last connection, possibly closed; `null` before the first and once dropped. */
  socket: Socket | null;

  /**
   * Whether it carries `credential` beside an envelope it sends (spec 15.1): over HTTP, any field
   * value, in each `POST`'s `Authorization`; over a WebSocket, the bytes its open connection's
   * upgrade carried alone, compared in constant time, and none while it is not open; over a worker,
   * none. A call presenting `ELSEWHERE` with a credential it does not carry fails before it
   * goes, DESTINATION_UNREACHABLE (spec 13.4).
   */
  carries(credential: string): boolean;
  /**
   * Opens the connection. Refused with a {@link ProgrammerError} for a timeout `timeout` does not
   * take, or an option its transport does not, which leaves the state, and the target a
   * reconnection replays, as they were; with a {@link ProgrammerError} unless UNINITIALIZED or
   * CLOSED; and with a
   * {@link CancelError}, nothing changed, when its signal is aborted already. Then it rejects with a
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
   * an error thrown by `tap` passes through, and so does a {@link ProgrammerError} an attempt
   * rejects with, which the next would meet again.
   */
  reconnect(options?: ITransportClientReconnectOptions): Promise<void>;
  removeAllListeners(event?: TRANSPORT_CLIENT_EVENTS): this;
  /**
   * Resolves once the message is on its way, not once it is delivered: over a socket, once the
   * socket has accepted it; over HTTP, on the head of its exchange's answer — the server had it — or
   * on its exchange lost, which closes the connection. Rejects with a {@link ReadyStateError} unless
   * OPEN, and over HTTP with a {@link GenericError} on a refusal the server marked, nothing tried; the
   * socket's own error passes through. Its credential goes over HTTP in the `Authorization` of its
   * `POST`, over a WebSocket in its upgrade's, which its connect is given; a worker carries none.
   */
  send(message: ITransportMessage): Promise<void>;
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
  /**
   * Refuses, by throwing, what a connect is given that it cannot take, before the state moves and
   * before the target a reconnection replays is kept: as a timeout refused is.
   */
  assertConnect?(options: ConnectOptions): void;
  /** Whether it carries `credential` beside an envelope it sends; none, without it. */
  carries?(credential: string): boolean;
  /** The clock it runs on, which the shared half waits on too; the platform's when none. */
  readonly clock?: IClock | undefined;
  /** Whether it is secure, as its last connect was given; not, without it. */
  readonly isSecure?: boolean | undefined;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(options?: ITransportClientDisconnectOptions): Promise<void>;
  send(message: ITransportMessage): Promise<void>;
  [dispose](): void;
}

/** What {@link createTransportClient} gives its transport beside the client. */
export interface ITransportClientDefineOptions {
  /**
   * Calls each listener of a `message` or a `close` within a guard (spec 15.1): what one throws is
   * reported through `error`, and the listeners after it are called all the same. Returns whether
   * `event` had any.
   */
  readonly tell: <K extends TransportClientToldEvent>(
    event: K,
    params: TransportClientEventMap[K]
  ) => boolean;
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
   * What a listener of its `message`, its `close` or its `reconnect` threw, which changes nothing the
   * client does; and, once open, what the client closes its connection for of its own — a protocol
   * error, a message or an envelope past its bound, a batch that does not read — once, as the
   * connection ends, before its `close` (spec 15.1). A connect that fails rejects; a server or a
   * network that ends the connection shows as `close` alone.
   */
  error: [error: Error];
  /**
   * An envelope, and the credential carried beside it, which no client is ever given: an answer and
   * what a listen brings back carry none. Not emitted while the client is closing.
   */
  message: [message: ITransportMessage];
  /**
   * A reconnection starts: what was sent on the connection it replaces will not be answered there. An
   * open connection it replaces emits no `close`, so this is the one sign of it.
   */
  reconnect: [];
};

/** The events a client emits, named by the table that types them. */
export type TRANSPORT_CLIENT_EVENTS = keyof TransportClientEventMap;

/** The events its transport tells a client's listeners of within a guard. */
export type TransportClientToldEvent = CLOSE_EVENT | MESSAGE_EVENT;

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

/** The response to an upgrade refused, as `ws` hands it over: Node's. */
export interface IUpgradeResponseLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly statusCode?: number | undefined;
  /** Reads its body to its end, unread, so its socket is free to go. */
  resume?(): unknown;
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
  /**
   * As `on`: an upgrade answered by any status but 101, its response readable (RFC 6455 §4.1),
   * which a browser's socket never shows.
   */
  on?(
    event: 'unexpected-response',
    listener: (request: unknown, response: IUpgradeResponseLike) => void
  ): unknown;
  /** As `on`. */
  ping?(): void;
  send(data: Data): void;
  /** As `on`: drops the socket without a close handshake. */
  terminate?(): void;
}

/** `CONNECTING` and `OPEN` are read from the injected constructor, so `ws` and the global agree. */
export interface IWebSocketConstructor {
  /**
   * `options` is `ws`'s alone, its `headers` written on the upgrade, its `closeTimeout` what it
   * waits on a close within, its own 1009's among them, from ws 8.22; the global `WebSocket` takes
   * two parameters, and still meets it.
   */
  new (
    url: string,
    protocols?: string | string[],
    options?: { closeTimeout?: number; headers?: Record<string, string>; maxPayload?: number }
  ): IWebSocketLike;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

export interface IWSTransportClientConnectOptions extends ITransportClientAddressOptions {
  /**
   * The credential its upgrade carries, in its `Authorization`, as given (spec 15.2): what a call
   * presenting `ELSEWHERE` over it stands for at its server, resolved per request; a reconnection
   * writes it again. Refused with a {@link ProgrammerError}, the state untouched, beside a
   * `credentialProvider`; when it is no field value — anything but visible ASCII, spaces and tabs,
   * or a space or a tab first or last (RFC 9110 §5.5); over a URL that leaves the machine in the
   * clear, `ws://` off the loopback (spec 13.4), the upgrade being where it would cross; and over a
   * `WebSocket` constructor without `ws`'s shape — a page's, Node's global — which writes no field
   * of its caller's choosing: a page presents a `JWT`.
   */
  credential?: string | undefined;
  /**
   * What hands the credential its upgrade carries, called at each attempt, the first connect's and
   * every reconnection's, before its upgrade goes, with the attempt's `signal`: where a credential
   * past its end is renewed, as SignalR's `accessTokenFactory` is. Refused as `credential` is, and
   * beside it. What it throws fails that attempt, its cause, which a reconnection counts as a refused
   * connect; a value it hands that is no field value fails it with a {@link ProgrammerError}, which
   * a reconnection does not try again.
   */
  credentialProvider?: ((options: { signal: AbortSignal }) => string | Promise<string>) | undefined;
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
   * Milliseconds the server gets to answer a close before it is dropped, which bounds `disconnect`,
   * a dispose's close and the 1009 a message past `maxPayload` fails it with, on the real clock
   * whatever `clock` is: it bounds the platform's own close handshake, and is given to `ws` as its
   * own. From 1 to 2³¹ − 1, rounded to the nearest whole one, or `Infinity` to wait without end,
   * which the timer `ws` arms on every close holds to 2³¹ − 1; any other, 0 among them, is a
   * {@link ProgrammerError}. The global `WebSocket` takes none, its platform's bound applying.
   * Defaults to {@link CLOSE_TIMEOUT}.
   */
  closeTimeout?: number | undefined;
  /**
   * Milliseconds between two pings of the server, rounded to the nearest whole one, from 1 to
   * 2³¹ − 1, and `Infinity` for none; 0 is refused: a server that has not answered one by the next
   * is dropped, and the client closes. Defaults to {@link HEARTBEAT}. Only a socket that can ping
   * beats — `ws`'s; a browser's cannot, and its server's pings stand for it.
   */
  heartbeat?: number | undefined;
  /**
   * The largest message it reads, in bytes, where its `WebSocket` takes a bound — `ws`'s, which
   * closes a connection that sends a larger one with 1009, told on `error` naming it and its value;
   * the global `WebSocket` takes none, its
   * platform's bound applying. Defaults to {@link MAXIMUM_MESSAGE_BYTES}, the default envelope's
   * limit: a router whose `maximumEnvelopeBytes` is raised needs it raised alike, as
   * `createWSClient` does.
   */
  maxPayload?: number | undefined;
  /**
   * Defaults to the global `WebSocket`; pass `ws`'s where there is none, and where a connect gives a
   * credential, which `ws` alone writes on the upgrade.
   */
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
  /**
   * Always `'manual'`: a redirect is judged as any status, never followed, since following it would
   * carry the connection's token where it was not judged (spec 15.6).
   */
  redirect: 'manual';
  signal?: AbortSignal | undefined;
}

/** The part of a response this transport reads — met by `fetch`'s. */
export interface IFetchResponseLike {
  /** Its body as it comes, which a listen reads; none on a 204. */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: { get(name: string): string | null };
  readonly ok: boolean;
  /** Whether the fetch followed a redirect, as `fetch`'s says; one that does not say followed none. */
  readonly redirected?: boolean | undefined;
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
  /**
   * Defaults to the global `fetch`. One given honours `redirect`, and follows no redirect: one whose
   * answer says it followed one fails the connect, and loses the connection of a send or a listen.
   */
  fetch?: FetchLike | undefined;
  /**
   * Milliseconds the client goes on listening again, its listens lost, before it counts its
   * connection lost: the server's own inactivity timeout by default, past which the server would
   * have closed it; `Infinity` for as long as the server does not say it is gone. From 1 to 2³¹ − 1
   * otherwise, rounded to the nearest whole one; 0 is refused. Defaults to
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
   * The largest answer taken, in bytes: an envelope's limit; one past it closes the connection, told
   * on `error` first, naming it and its value. It is checked once the answer is read, and it bounds
   * each envelope a listen brings back, alone, as it comes. Defaults to {@link MAXIMUM_BODY_BYTES}.
   */
  maximumBodyBytes?: number | undefined;
  /**
   * Milliseconds between a listen that brought nothing back and the next: `0` listens again at once,
   * and from 1 to 2³¹ − 1, rounded to the nearest whole one, waits; `Infinity` is refused. A pause
   * past the server's inactivity timeout loses the connection. Defaults to `0`.
   */
  pause?: number | undefined;
  /**
   * Milliseconds each listen asks the server to wait for something to bring back, which the server
   * caps; `0` asks it to answer at once, which polls, and from 1 to 2³¹ − 1, rounded to the nearest
   * whole one, to wait; `Infinity` is refused. Defaults to {@link WAIT}.
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

// ── Memory ────────────────────────────────────────────────────────────────────

// interfaces

/** What an in-memory connect takes besides: who connects, as its server's router is to see it. */
export interface IMemoryTransportClientConnectOptions extends ITransportClientConnectOptions {
  /**
   * The address its server hands with each envelope and names its connection by (spec 15.13): the
   * caller a gateway connects for, say; `local` when not given. Visible ASCII but `;`, which ends a
   * handle's part; any other is a {@link ProgrammerError}.
   */
  address?: string | undefined;
  /** The port its server hands beside the address: a whole number from 0 to 65535; none by default. */
  port?: number | undefined;
}

export interface IMemoryTransportClientOptions extends ITransportClientOptions {
  /** What it connects to: an in-memory transport server of the same process. */
  server: IMemoryTransportServerLike;
}

// types

/** A client of the in-memory transport: its socket is its server's end of the connection. */
export type MemoryTransportClient = ITransportClient<
  IMemoryEndLike,
  IMemoryTransportClientConnectOptions
>;

// ── Worker ────────────────────────────────────────────────────────────────────

// interfaces

/**
 * What a worker's `error` says, the shape of HTML's `ErrorEvent`: each member where it is given, none
 * for a script that failed to load.
 */
export interface IWorkerErrorEventLike {
  readonly colno?: number;
  readonly filename?: string;
  readonly lineno?: number;
  readonly message?: string;
}

/**
 * What a page posts its connects to: a `Worker`, or any port to one. Its `error`, when it has one,
 * fails the connect under way, or closes the connection, unclean, told first on the client's
 * `error`.
 */
export interface IWorkerLike {
  addEventListener?(type: 'error', listener: (event: IWorkerErrorEventLike) => void): void;
  postMessage(message: unknown, transfer: readonly unknown[]): void;
  removeEventListener?(type: 'error', listener: (event: IWorkerErrorEventLike) => void): void;
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
