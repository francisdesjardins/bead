// dependencies

import type { IClock } from '../shared/clock';
import type {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  TRANSPORTS,
} from '../shared/constants';
import type {
  Data,
  EmitterListener,
  IEventIteratorOptions,
  IGauges,
  IReadyStateMethods,
  IWorkerMessageEventLike,
  IWorkerPortLike,
} from '../shared/types';

// interfaces

/** Where a started server listens. */
export interface ITransportServerAddress {
  address: string;
  port: number;
}

/** One connection, as `clients` reports it. */
export interface ITransportServerClient {
  address: string;
  connectionHandle: TransportServerConnectionHandle;
  /**
   * When the connection last delivered a message, in milliseconds since the epoch, as its server's
   * clock reads the wall clock; `undefined` until it has.
   */
  lastActivity: number | undefined;
  port: number;
  type: TRANSPORTS;
}

/** One connection with its socket, as a transport registers it. */
export interface ITransportServerClientAware<Socket> extends ITransportServerClient {
  socket: Socket;
}

export interface ITransportServerClientHandleInfo {
  ip: string;
  port: number;
  type: TRANSPORTS;
}

/**
 * A connection with no address of its own — one a transport draws, one a worker takes — named by who
 * it came from and the rank it came at.
 */
export interface ITransportServerDrawnHandleInfo {
  ip: string;
  ordinal: number;
  type: TRANSPORTS;
}

/** What every transport server takes, and each transport extends with its own. */
export interface ITransportServerOptions {
  /**
   * The clock its timers run on, and the layers built on it with it; the platform's when not given.
   */
  clock?: IClock | undefined;
}

export interface ITransportServerStartOptions {
  /** The address to listen on. */
  address?: string | undefined;
  /** Lets the system pick a free port, which `start` then reports; `port` is ignored. */
  findOpenPort?: boolean | undefined;
  /** The port to listen on; `0` lets the system pick one, as `findOpenPort` does. */
  port?: number | undefined;
  /** Aborting it gives up on starting with a {@link CancelError}, ending CLOSED. */
  signal?: AbortSignal | undefined;
}

/** A transport's server side: its connections, their events, and its own start and stop. */
export interface ITransportServer<
  Socket extends object = object,
  Request = unknown,
> extends IReadyStateMethods {
  /** Where the server listens, or will: the defaults until the first `start`. */
  readonly address: string;
  /** A copy, so a caller may consume it; each entry is what the connection looked like then. */
  readonly clients: ITransportServerClient[];
  /** The clock it runs on, which a layer built on it runs on too. */
  readonly clock: IClock;
  readonly port: number;
  readonly type: TRANSPORTS;

  /** Closes one connection. Resolves `false` for an unknown handle, otherwise `true` once it closed. */
  close(connectionHandle: TransportServerConnectionHandle): Promise<boolean>;
  closeAll(): Promise<boolean[]>;
  emit<K extends TRANSPORT_SERVER_EVENTS>(
    event: K,
    ...params: TransportServerEventMap<Socket, Request>[K]
  ): boolean;
  /**
   * Every `event` from now on, as its arguments, for `for await`; the signal, a `break` or a throw
   * ends it.
   */
  events<K extends TRANSPORT_SERVER_EVENTS>(
    event: K,
    options?: IEventIteratorOptions
  ): AsyncIterableIterator<TransportServerEventMap<Socket, Request>[K], undefined>;
  /** What it holds right now, for diagnosis: its connections, and what its transport keeps of them. */
  gauges(): IGauges<TransportServerConnectionHandle>;
  off<K extends TRANSPORT_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<TransportServerEventMap<Socket, Request>[K]>
  ): this;
  on<K extends TRANSPORT_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<TransportServerEventMap<Socket, Request>[K]>
  ): this;
  once<K extends TRANSPORT_SERVER_EVENTS>(
    event: K,
    listener: EmitterListener<TransportServerEventMap<Socket, Request>[K]>
  ): this;
  removeAllListeners(event?: TRANSPORT_SERVER_EVENTS): this;
  /**
   * Hands a message to one connection. A message for a connection that is gone, or not open, is
   * dropped and resolves: the loss shows as that connection's `close`. A socket carries any message.
   * Over HTTP, an answer goes to the exchange of its request, and anything else waits for its client
   * to listen; a connection whose client does not listen rejects all but an answer with a
   * {@link GenericError} — bytes that are no envelope with a {@link ProgrammerError}.
   */
  send(data: Data, connectionHandle: TransportServerConnectionHandle): Promise<void>;
  /**
   * Listens. Rejects with a {@link ProgrammerError} unless UNINITIALIZED or CLOSED, a
   * {@link CancelError}, or the system's own error — `EADDRINUSE` for a port taken — ending CLOSED.
   */
  start(options?: ITransportServerStartOptions): Promise<ITransportServerAddress>;
  /**
   * Closes every connection, each emitting its `close`, then stops listening. Resolves at once when
   * never started or already stopped, shares a stop in progress, and rejects with a
   * {@link ProgrammerError} while starting.
   */
  stop(): Promise<void>;
  /** What `await using` calls: {@link ITransportServer.stop}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * What a transport supplies to {@link createTransportServer}. It registers each connection in the
 * `connections` it is handed and removes it before emitting its `close`; the shared half owns the
 * ready state, and hands `close` and `send` a connection it found registered, never a handle.
 */
export interface ITransportServerImplementation<Socket = unknown> {
  /** The clock it runs on; the platform's when none. */
  readonly clock?: IClock | undefined;
  readonly defaults: TransportServerResolvedStartOptions;
  readonly type: TRANSPORTS;
  close(connection: ITransportServerClientAware<Socket>): Promise<void>;
  /** What the transport keeps of its connections besides the registry, counted; none, when nothing. */
  gauges?(): IGauges<TransportServerConnectionHandle>;
  send(data: Data, connection: ITransportServerClientAware<Socket>): Promise<void>;
  start(
    options: TransportServerResolvedStartOptions & { signal?: AbortSignal | undefined }
  ): Promise<ITransportServerAddress>;
  stop(): Promise<void>;
}

// types

/**
 * `type=WS;ip=127.0.0.1;port=50000`, a connection named by who is on the other end, which
 * {@link generateHandle} makes; or `type=HTTP;ip=127.0.0.1;ordinal=7`, one a transport that keeps no
 * connection draws, named by the rank it was drawn at, which {@link generateDrawnHandle} makes. A
 * handle is never a secret: it names a connection in reports and events, and no token enters it.
 */
export type TransportServerConnectionHandle =
  | `type=${TRANSPORTS};ip=${string};ordinal=${number}`
  | `type=${TRANSPORTS};ip=${string};port=${number}`;

/** The connections by handle: what a transport registers each one in and removes it from. */
export type TransportServerConnections<Socket> = Map<
  TransportServerConnectionHandle,
  ITransportServerClientAware<Socket>
>;

/** The start options with every default applied. */
export type TransportServerResolvedStartOptions = Readonly<{
  address: string;
  findOpenPort: boolean;
  port: number;
}>;

/** Event name → the arguments its listeners receive. */
export type TransportServerEventMap<Socket = unknown, Request = unknown> = {
  /** `wasClean` is whether the connection closed normally (1000). */
  close: [wasClean: boolean, connectionHandle: TransportServerConnectionHandle];
  /** The connection's socket, the request that opened it, and its handle, once it is registered. */
  connection: [socket: Socket, request: Request, connectionHandle: TransportServerConnectionHandle];
  /**
   * What went wrong on a connection; when it ends the connection, its `close` follows. An empty
   * handle is the server's own error.
   */
  error: [error: Error, connectionHandle: TransportServerConnectionHandle | ''];
  message: [data: Data, connectionHandle: TransportServerConnectionHandle];
};

/** The events a server emits, named by the table that types them. */
export type TRANSPORT_SERVER_EVENTS = keyof TransportServerEventMap;

export type TransportServerOnCloseCallback = EmitterListener<TransportServerEventMap[CLOSE_EVENT]>;
export type TransportServerOnConnectionCallback<
  Socket = unknown,
  Request = unknown,
> = EmitterListener<TransportServerEventMap<Socket, Request>[CONNECTION_EVENT]>;
export type TransportServerOnErrorCallback = EmitterListener<TransportServerEventMap[ERROR_EVENT]>;
export type TransportServerOnMessageCallback = EmitterListener<
  TransportServerEventMap[MESSAGE_EVENT]
>;

// ── WebSocket ─────────────────────────────────────────────────────────────────

// interfaces

/** The part of a connection's socket this transport touches — met by `ws`'s. */
export interface IServerSocketLike {
  binaryType: string;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  ping(): void;
  send(data: Data): void;
  terminate(): void;
}

/** The part of the request that opened a connection this transport reads — met by Node's. */
export interface IIncomingMessageLike {
  socket: {
    readonly remoteAddress?: string | undefined;
    readonly remotePort?: number | undefined;
  };
}

/** The part of a WebSocket server this transport touches — met by `ws`'s `WebSocketServer`. */
export interface IWebSocketServerLike {
  address(): { address: string; port: number } | string | null;
  close(callback?: (error?: Error) => void): void;
  on(
    event: 'connection',
    listener: (socket: IServerSocketLike, request: IIncomingMessageLike) => void
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'listening', listener: () => void): unknown;
}

export interface IWebSocketServerConstructor {
  new (options: {
    host?: string | undefined;
    maxPayload?: number | undefined;
    port?: number | undefined;
  }): IWebSocketServerLike;
}

export interface IWSTransportServerOptions extends ITransportServerOptions {
  /** Defaults to {@link TRANSPORT_WEBSOCKET_BINARYTYPE}, for every connection. */
  binaryType?: 'arraybuffer' | 'blob' | 'nodebuffer' | undefined;
  /**
   * Milliseconds a connection gets to answer a close before it is dropped, which bounds `close` and
   * `stop`, on the real clock whatever `clock` is: it bounds the platform's own close handshake.
   * From 1 to 2³¹ − 1, rounded to the nearest whole one, or `Infinity` to wait without end; any
   * other, 0 among them, is a {@link ProgrammerError}. Defaults to {@link CLOSE_TIMEOUT}.
   */
  closeTimeout?: number | undefined;
  /**
   * Milliseconds between two pings of each connection, rounded to the nearest whole one, from 1 to
   * 2³¹ − 1, and `Infinity` for none; 0 is refused: a connection that has not answered one by the
   * next is dropped, and its `close` says it was not clean. Defaults to
   * {@link HEARTBEAT}. A heartbeat keeps nothing of a session alive: it tells a live connection
   * from a dead one, and the session's own timers still count what the peer sends.
   */
  heartbeat?: number | undefined;
  /**
   * The largest message a connection may send, in bytes; `ws` closes a connection that sends a
   * larger one with 1009. `ws`'s own default when not given.
   */
  maxPayload?: number | undefined;
  /** `ws`'s `WebSocketServer`: there is no global one to default to. */
  WebSocketServer: IWebSocketServerConstructor;
}

// types

export type WSTransportServer = ITransportServer<IServerSocketLike, IIncomingMessageLike>;

// ── HTTP ──────────────────────────────────────────────────────────────────────

// interfaces

/**
 * A connection the HTTP transport drew, as its events and `clients` show it: the order it was drawn
 * in, and nothing more. What the transport keeps of it — its token, its exchanges — stays inside.
 */
export interface IDrawnConnection {
  readonly ordinal: number;
}

/** The request that drew a connection, as the `connection` event shows it: nothing of its headers. */
export interface IDrawingRequest {
  readonly method: string | undefined;
  readonly remoteAddress: string;
  readonly remotePort: number | undefined;
  readonly url: string | undefined;
}

/** The part of a request this transport reads — met by Node's, and by HTTP/2's compatibility one. */
export interface IHTTPRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly httpVersionMajor: number;
  readonly method?: string | undefined;
  readonly socket: {
    readonly remoteAddress?: string | undefined;
    readonly remotePort?: number | undefined;
  };
  readonly url?: string | undefined;
  destroy(): unknown;
  on(event: 'close' | 'end', listener: () => void): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The part of a response this transport writes — met by Node's, and by HTTP/2's compatibility one. */
export interface IHTTPResponseLike {
  readonly headersSent: boolean;
  readonly writableFinished: boolean;
  destroy(): unknown;
  end(): unknown;
  // oxlint-disable-next-line typescript/unified-signatures -- two, as HTTP/2's response has them: one optional parameter would meet neither its `end(callback)` nor its `end(data)`
  end(data: Uint8Array): unknown;
  /** Sends the head now; HTTP/2's has it, though its type says nothing of it. */
  flushHeaders?(): void;
  on(event: 'close' | 'finish', listener: () => void): unknown;
  write(chunk: Uint8Array): unknown;
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
}

/** The part of an HTTP/2 session this transport touches: its close, and the end of it. */
export interface IHTTPSessionLike {
  close(): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * The part of an HTTP server this transport touches — met by `node:http`'s, `node:https`'s and
 * `node:http2`'s.
 */
export interface IHTTPServerLike {
  address(): { address: string; port: number } | string | null;
  close(callback?: (error?: Error) => void): unknown;
  /** Ends the keep-alive sockets too, without which a stop waits on them; HTTP/1's since Node 18.2. */
  closeAllConnections?(): void;
  listen(port: number, host: string, callback?: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** HTTP/2's: each session, which a stop closes, since it outlives the server's close. */
  on(event: 'session', listener: (session: IHTTPSessionLike) => void): unknown;
}

export interface IHTTPTransportServerOptions extends ITransportServerOptions {
  /**
   * The bytes of body the exchanges under way may hold together, counted as they come; past them,
   * an exchange is refused 503. Defaults to {@link BODY_BYTES_BUDGET}.
   */
  bodyBytesBudget?: number | undefined;
  /**
   * Builds the server on the transport's listener: `(listener) => createServer(listener)` from
   * `node:http`, `(listener) => createServer({ key, cert }, listener)` from `node:https`, or
   * `createSecureServer({ allowHTTP1: true, … }, listener)` from `node:http2`. Its own timeouts —
   * `headersTimeout`, `requestTimeout`, `keepAliveTimeout` — are the application's to set.
   */
  createServer: (listener: HTTPRequestListener) => IHTTPServerLike;
  /**
   * Milliseconds a request handed on waits for its answer before its exchange counts as lost, which
   * closes its connection: from 1 to 2³¹ − 1, rounded to the nearest whole one, or `Infinity` for
   * ever; 0 is refused. Defaults to {@link EXCHANGE_TIMEOUT}.
   */
  exchangeTimeout?: number | undefined;
  /**
   * The hosts — `Host`, or HTTP/2's `:authority` — a request may name; any other is refused 403
   * before anything is read, which a page that rebinds its name to this server's address cannot
   * pass. Every host, when not given.
   */
  hosts?: readonly string[] | undefined;
  /**
   * Milliseconds a connection may go with no exchange under way before it is closed: from 1 to
   * 2³¹ − 1, rounded to the nearest whole one, or `Infinity` for never; 0 is refused. It tells a
   * client alive from one gone, as a WebSocket's heartbeat does: a listen held is an exchange under
   * way, so a client that listens again as each listen ends — or pauses less than this — stays. A
   * session's own timers still count what the client says. Defaults to {@link INACTIVITY_TIMEOUT}.
   */
  inactivityTimeout?: number | undefined;
  /**
   * Whether the address in `x-forwarded-for` — its last one — is taken for the client's, when the
   * request comes from this machine: a proxy in front of the transport. The socket's address, when
   * not.
   */
  isProxyTrusted?: boolean | undefined;
  /** The largest body, in bytes: an envelope's limit. Defaults to {@link MAXIMUM_BODY_BYTES}. */
  maximumBodyBytes?: number | undefined;
  /**
   * The connections drawn at once; past them, a connect is refused 503. Defaults to
   * {@link MAXIMUM_CONNECTIONS}.
   */
  maximumConnections?: number | undefined;
  /**
   * The connections one address holds at once; past them, its connect is refused 503. Defaults to
   * {@link MAXIMUM_CONNECTIONS_PER_ADDRESS}.
   */
  maximumConnectionsPerAddress?: number | undefined;
  /**
   * The bytes one connection's outbox holds — what the server sent of its own and no listen
   * acknowledged yet; past them, the connection closes, as one whose client fell behind. Defaults to
   * {@link MAXIMUM_OUTBOX_BYTES}.
   */
  maximumOutboxBytes?: number | undefined;
  /**
   * Milliseconds a listen waits at most for something to bring back, whatever `wait` it asks: from 1
   * to 2³¹ − 1, rounded to the nearest whole one; 0 and `Infinity` are refused. An intermediary's
   * own timeout must be longer. Defaults to {@link MAXIMUM_WAIT}.
   */
  maximumWait?: number | undefined;
  /**
   * The requests one connection has waiting for their answer at once; past them, one more is refused
   * 429, and a cancel, which takes no place, never is. Defaults to {@link MAXIMUM_WAITING_EXCHANGES}.
   */
  maximumWaitingExchanges?: number | undefined;
  /**
   * The origins a browser's exchange may come from, besides the server's own; one with no `Origin` —
   * no browser's — comes from anywhere. It serves a proxy that rewrites the host: a page of another
   * origin also needs CORS, which the transport does not answer yet.
   */
  origins?: readonly string[] | undefined;
  /** The path the transport answers on; anything else is 404. Defaults to {@link PATHNAME}. */
  pathname?: string | undefined;
}

// types

/** What the transport hands the server it builds: every exchange, on every path. */
export type HTTPRequestListener = (request: IHTTPRequestLike, response: IHTTPResponseLike) => void;

export type HTTPTransportServer = ITransportServer<IDrawnConnection, IDrawingRequest> & {
  /**
   * Whether a connection carries both ways — what the server sends of its own as well as its
   * answers: one whose client said at connect that it listens, for the connection's life.
   */
  isTwoWay(connectionHandle: TransportServerConnectionHandle): boolean;
};

// ── Worker ────────────────────────────────────────────────────────────────────

// interfaces

/** Where a worker hears its page: its global scope — `self` — or any port to it. */
export interface IWorkerScopeLike {
  addEventListener(type: 'message', listener: (event: IWorkerMessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: IWorkerMessageEventLike) => void): void;
}

export interface IWorkerTransportServerOptions extends ITransportServerOptions {
  /** Where connects come: a worker's `self`, or a port a test holds. */
  scope: IWorkerScopeLike;
}

// types

export type WorkerTransportServer = ITransportServer<IWorkerPortLike, undefined>;
