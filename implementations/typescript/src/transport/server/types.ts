// dependencies

import type { Server } from 'node:http';
import type { IClock } from '../shared/clock';
import type {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
  TRANSPORTS,
} from '../shared/constants';
import type {
  Data,
  EmitterListener,
  IEventIteratorOptions,
  IGauges,
  IReadyStateMethods,
  ITransportMessage,
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

/**
 * A refusal its transport judged of its own (spec 15.1): a request refused as it arrived, or whose
 * body it refused as it came, marked in `bead-refusal` — never the 404 that ends an exchange or a
 * listen already taken as its connection closes, which `close` tells, nor what HTTP refuses of its
 * own, unmarked. It carries nothing else of the request: neither its target, nor a connection's
 * token, nor a credential, nor any other field; and it names no connection, a refusal being a
 * request's. Each string is visible ASCII, spaces and tabs, as the client wrote it: a listener that
 * logs one quotes it.
 */
export interface ITransportServerRefusal {
  /**
   * The client's address, as `clients` reports one (spec 15.12): over HTTP, the `X-Forwarded-For`
   * entry reached past the proxies its `trustedProxies` names, else the socket's, in its one form;
   * `undefined` for a socket already gone.
   */
  address: string | undefined;
  /**
   * The request's authority as it came, its port included: its absolute-form target's, else its
   * `Host`; `''` for an empty `Host`, `undefined` when it names none.
   */
  authority: string | undefined;
  /** Its `Origin` as it came, its field lines joined by `, `; `undefined` when it sends none. */
  origin: string | undefined;
  /** The client's port, as `clients` reports one: behind a proxy it trusts, the nearest one's. */
  port: number;
  /** The mark it was refused with, its `bead-refusal`: `host-refused`, `busy`… */
  reason: string;
  status: number;
}

/** One connection with its socket, as a transport registers it. */
export interface ITransportServerClientAware<Socket> extends ITransportServerClient {
  socket: Socket;
}

/**
 * What names a connection a transport holds (spec 15.1): its type, who it came from, its peer's port
 * when it comes on a socket of its own, and the rank its transport took it at, which none shares.
 */
export interface ITransportServerHandleInfo {
  ip: string;
  ordinal: number;
  port?: number | undefined;
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
  /**
   * An IP address, bare, as RFC 3986 writes one (spec 15.12): `127.0.0.1`, the loopback, by
   * default; `0.0.0.0` or `::` for every interface, which a container needs. A name, a bracketed
   * or zoned address, an IPv4-mapped one or a form outside the grammar, `127.1` or `0` among them,
   * is a {@link ProgrammerError} as the start begins, ending CLOSED. A worker's listens on none.
   */
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

  /**
   * Whether it carries a credential beside an envelope it sends a connection: none of this package's
   * does — an answer, a listen's batch, a WebSocket's message, a worker's — so its router fails a
   * command presenting an `ELSEWHERE` before it goes, and its relay sends none on it (spec 13.4).
   */
  carriesCredential(connectionHandle: TransportServerConnectionHandle): boolean;
  /** Closes one connection. Resolves `false` for an unknown handle, otherwise `true` once it closed. */
  close(connectionHandle: TransportServerConnectionHandle): Promise<boolean>;
  closeAll(): Promise<boolean[]>;
  /**
   * Whether a connection is secure (spec 13.4): as its application says what stands in front of
   * the server, when it says, whatever the server listens on; otherwise by what the server listens
   * on, never by what a name resolves to — under TLS, on the loopback, 127.0.0.0/8 or `::1`, or
   * never leaving the machine, as a worker.
   */
  isSecure(connectionHandle: TransportServerConnectionHandle): boolean;
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
   * {@link GenericError} — bytes that are no envelope with a {@link ProgrammerError}. No server
   * carries a credential: an answer and what a listen brings back carry none, nor does a socket.
   */
  send(
    message: ITransportMessage,
    connectionHandle: TransportServerConnectionHandle
  ): Promise<void>;
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
  /**
   * Whether it is secure whatever it listens on: under TLS, or never leaving the machine, as a
   * worker; when not, it is so on a loopback address alone.
   */
  readonly isSecure?: boolean | undefined;
  /**
   * What its application says stands in front of it, believed before what it listens on and
   * {@link ITransportServerImplementation.isSecure}: `true` for TLS terminated before it, `false`
   * for a proxy that serves the network in the clear; nothing, when it says nothing.
   */
  readonly secure?: boolean | undefined;
  readonly defaults: TransportServerResolvedStartOptions;
  readonly type: TRANSPORTS;
  close(connection: ITransportServerClientAware<Socket>): Promise<void>;
  /** What the transport keeps of its connections besides the registry, counted; none, when nothing. */
  gauges?(): IGauges<TransportServerConnectionHandle>;
  send(message: ITransportMessage, connection: ITransportServerClientAware<Socket>): Promise<void>;
  start(
    options: TransportServerResolvedStartOptions & { signal?: AbortSignal | undefined }
  ): Promise<ITransportServerAddress>;
  stop(): Promise<void>;
}

/** What {@link createTransportServer} gives its transport beside the server and its registry. */
export interface ITransportServerDefineOptions<Socket = unknown, Request = unknown> {
  /**
   * Whether `event` has a listener now: what a transport builds for its listeners alone, a
   * refusal's record, it builds once this holds.
   */
  readonly isHeard: (event: TransportServerToldEvent) => boolean;
  /**
   * Calls each listener of `event` but `error` within a guard (spec 15.1): what one throws is
   * reported through `error`, with the connection `params` ends with — the empty handle for a
   * refusal, which names none — and the listeners after it are called all the same. Returns
   * whether `event` had any.
   */
  readonly tell: <K extends TransportServerToldEvent>(
    event: K,
    params: TransportServerEventMap<Socket, Request>[K]
  ) => boolean;
}

// types

/**
 * What names a connection its transport holds (spec 15.1), which {@link generateHandle} writes:
 * `type=WS;ip=127.0.0.1;port=50000;ordinal=3`, one on a socket of its own, by its peer's port and
 * the rank its transport took it at; `type=HTTP;ip=127.0.0.1;ordinal=7`, one a transport draws, or a
 * worker takes, by its rank alone. A transport gives none twice, so no two connections it holds
 * share one, two sockets from one address and port among them. Its form is this implementation's,
 * written for a reader of a trace: an application compares a handle whole. A handle is never a
 * secret: it names a connection in reports and events, and no token enters it.
 */
export type TransportServerConnectionHandle =
  | `type=${TRANSPORTS};ip=${string};ordinal=${number}`
  | `type=${TRANSPORTS};ip=${string};port=${number};ordinal=${number}`;

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
   * What went wrong on a connection, or what a listener of its events threw, which changes nothing
   * the server does; when it ends the connection, its `close` follows. An empty handle is the
   * server's own error, or what a `refusal` listener threw, which no connection was told with.
   */
  error: [error: Error, connectionHandle: TransportServerConnectionHandle | ''];
  /**
   * A listen held on the connection, `isHeld`, once its refusals passed, and its end, while the
   * connection stands: over HTTP alone, whose listen is no silence (spec 13.7). A transport that has
   * no listen never emits it.
   */
  listen: [isHeld: boolean, connectionHandle: TransportServerConnectionHandle];
  /** An envelope, and the credential carried beside it: over HTTP alone, with a request. */
  message: [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle];
  /**
   * Each refusal the transport judged of its own, once written: what to add to `hosts` or
   * `origins`, or who is refused. A worker's never refuses.
   */
  refusal: [refusal: ITransportServerRefusal];
};

/** The events a server emits, named by the table that types them. */
export type TRANSPORT_SERVER_EVENTS = keyof TransportServerEventMap;

/** The events a server tells its listeners of within a guard: every one but `error`. */
export type TransportServerToldEvent = Exclude<TRANSPORT_SERVER_EVENTS, ERROR_EVENT>;

export type TransportServerOnCloseCallback = EmitterListener<TransportServerEventMap[CLOSE_EVENT]>;
export type TransportServerOnConnectionCallback<
  Socket = unknown,
  Request = unknown,
> = EmitterListener<TransportServerEventMap<Socket, Request>[CONNECTION_EVENT]>;
export type TransportServerOnErrorCallback = EmitterListener<TransportServerEventMap[ERROR_EVENT]>;
export type TransportServerOnMessageCallback = EmitterListener<
  TransportServerEventMap[MESSAGE_EVENT]
>;
export type TransportServerOnRefusalCallback = EmitterListener<
  TransportServerEventMap[REFUSAL_EVENT]
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

/**
 * The part of the request that opened a connection this transport reads — met by Node's: its
 * fields, as `headers` gives them and each line as it came, its method, its version, and its
 * socket's address.
 */
export interface IIncomingMessageLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly httpVersion: string;
  readonly method?: string | undefined;
  /** Its fields as they came, each name before its value: what counts a field given twice. */
  readonly rawHeaders: readonly string[];
  readonly socket: {
    readonly remoteAddress?: string | undefined;
    readonly remotePort?: number | undefined;
  };
  /** Its target, which names its authority when it is in absolute-form. */
  readonly url?: string | undefined;
}

/** The socket of a request the transport answers itself, raw: a `CONNECT`'s, or an upgrade's. */
export interface IUpgradeSocketLike {
  destroy(): unknown;
  end(data: string): unknown;
  on(event: 'error', listener: () => void): unknown;
  once(event: 'finish', listener: () => void): unknown;
}

/** The part of a WebSocket server this transport touches — met by `ws`'s `WebSocketServer`. */
export interface IWebSocketServerLike {
  address(): { address: string; port: number } | string | null;
  close(callback?: (error?: Error) => void): void;
  on(
    event: 'connection',
    listener: (socket: IServerSocketLike, request: IIncomingMessageLike) => void
  ): unknown;
  /** Its HTTP server's error, which `ws` forwards. */
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** Its HTTP server's `listening`, which `ws` forwards. */
  on(event: 'listening', listener: () => void): unknown;
  /** An upgrade `ws` cannot read, which it leaves to the listener to answer. */
  on(
    event: 'wsClientError',
    // oxlint-disable-next-line bead/options-last -- ws's own, a `wsClientError` listener's
    listener: (error: Error, socket: IUpgradeSocketLike, request: IIncomingMessageLike) => void
  ): unknown;
}

export interface IWebSocketServerConstructor {
  /**
   * `server` is the transport's own HTTP server, which `ws` upgrades on and leaves open when it
   * closes.
   */
  new (options: { maxPayload?: number | undefined; server: Server }): IWebSocketServerLike;
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
   * The hosts a request at the server's address may name besides those every server takes —
   * `localhost`, a name under `.localhost`, an IP literal — by its authority: its absolute-form
   * target's, else its `Host` (spec 15.12). Any other, an empty one and none are refused 403,
   * whatever the request, before anything else of it is read, which a page that rebinds its name to
   * this server's address cannot pass: a server a browser, a proxy that keeps `Host`, or a service
   * reaches by a name names it here. Each entry is a host without its port, compared by the
   * request's host on any port, ASCII case-insensitively, an IDN host in punycode. `[]`, or none, is
   * those every server takes alone; `['*']` takes every host and makes none of their origins its
   * own, so a page that rebinds its name passes this check and is refused by `origins`'. An entry
   * with a port, an empty one, one that is no host, or `*` beside another is a
   * {@link ProgrammerError} as the server is built. A refusal is told on the wire, to a client
   * over `ws`, and by the server's `refusal`; a page's WebSocket reads nothing of it but its close.
   * A `Host` missing, repeated or no host is answered 400 before it, as HTTP answers it (RFC 9112
   * §3.2).
   */
  hosts?: readonly string[] | undefined;
  /**
   * The largest message a connection may send, in bytes; `ws` closes a connection that sends a
   * larger one with 1009. Defaults to {@link MAXIMUM_MESSAGE_BYTES}, the default envelope's limit: a
   * router whose `maximumEnvelopeBytes` is raised needs it raised alike, as `createWSServer` does.
   */
  maxPayload?: number | undefined;
  /**
   * The origins an upgrade that sends an `Origin` may come from, besides the server's own —
   * `http://` or `https://` followed by its authority, in any ASCII case, when its host is one the
   * server takes by name, never by `*` — each compared exactly, checked on the upgrade, after its
   * version and its form; any other is refused 403, since no same-origin policy guards an upgrade.
   * One with no `Origin` comes from anywhere. A WebSocket answers no CORS, which no browser asks of
   * an upgrade. None, when not given. Each entry is an origin as a browser serializes it (RFC 6454
   * §6.2): `*`, which no origin is, `null`, which every page with no origin of its own sends, and
   * any other are a {@link ProgrammerError} as the server is built.
   */
  origins?: readonly string[] | undefined;
  /**
   * What stands in front of it, which it cannot tell (spec 13.4): `true` for TLS terminated before
   * it, which makes each connection secure; `false` for a proxy that serves the network in the
   * clear, which leaves each in the clear, a loopback listener among them. When not given, a
   * connection is secure as the server listens on a loopback address alone.
   */
  secure?: boolean | undefined;
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
  /** `1.0`, `1.1` or `2.0`: an HTTP/1.1 request names its host, which an HTTP/1.0 one may not. */
  readonly httpVersion: string;
  readonly httpVersionMajor: number;
  readonly method?: string | undefined;
  /**
   * Its fields as they came, each name before its value: what counts an `Authorization` or a
   * `Host` given twice, which `headers` keeps once.
   */
  readonly rawHeaders: readonly string[];
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
  /** HTTP/2's stream, which a malformed request's reset closes with its error code. */
  readonly stream?: { close(code?: number): void } | undefined;
  /** Sets a field the head carries, which `writeHead` merges with its own. */
  setHeader(name: string, value: string): unknown;
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
  // oxlint-disable-next-line bead/options-last -- Node's own, `listen(port, host, callback)`
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
   * The hosts a request may name besides those every server takes — `localhost`, a name under
   * `.localhost`, an IP literal — by its authority: its absolute-form target's, else over HTTP/2 its
   * `:authority`, else its `Host` (spec 15.12). Any other, an empty one and none are refused 403
   * before anything else is read, which a page that rebinds its name to this server's address
   * cannot pass: a server a browser, a proxy that keeps `Host`, or a service reaches by a name names
   * it here. Each entry is a host without its port, compared by the request's host on any port,
   * ASCII case-insensitively, an IDN host in punycode. `[]`, or none, is those every server takes
   * alone; `['*']` takes every host and makes none of their origins its own, so a page that rebinds
   * its name passes this check and is refused by `origins`'. An entry with a port, an empty one, one
   * that is no host, or `*` beside another is a {@link ProgrammerError} as the server is built. A refusal is told on the wire, to an HTTP client, and by the server's
   * `refusal`. An HTTP/1.1 request without a `Host`, with two, or with an authority that is no host is answered
   * 400 before it, unmarked, as HTTP answers it (RFC 9112 §3.2); over HTTP/2, its stream is reset.
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
   * The origins an exchange that sends an `Origin` may come from, besides the server's own —
   * `http://` or `https://` followed by its authority, in any ASCII case, when its host is one the
   * server takes by name, never by `*` — each compared exactly; any other is refused 403. One with
   * no `Origin` comes from anywhere. It serves a proxy that rewrites the host, a page under
   * `hosts: ['*']`, and a page of another origin, to which the server answers CORS (spec 15.12): its
   * preflight 204, and on every answer once its origin is judged `Access-Control-Allow-Origin` and
   * every field exposed, never `Access-Control-Allow-Credentials`. None, when not given. Each entry
   * is an origin as a browser serializes it (RFC 6454 §6.2): `*`, which no origin is, `null`, which
   * every page with no origin of its own sends — a sandboxed frame of any site among them — and any
   * other are a {@link ProgrammerError} as the server is built.
   */
  origins?: readonly string[] | undefined;
  /** The path the transport answers on; anything else is 404. Defaults to {@link PATHNAME}. */
  pathname?: string | undefined;
  /**
   * What stands in front of it, which it cannot tell (spec 13.4): `true` for TLS terminated before
   * it, which makes each connection secure; `false` for a proxy that serves the network in the
   * clear, which leaves each in the clear, a loopback listener or a server of its own under TLS
   * among them. When not given, a connection is secure as the server is under TLS or listens on a
   * loopback address.
   */
  secure?: boolean | undefined;
  /**
   * The proxies whose `X-Forwarded-For` the transport believes (spec 15.12): each an IP address in
   * the form a server listens on, or a network, that address, `/` and its prefix's length (RFC 4632
   * §3.1, RFC 4291 §2.3), from 1, its bits past the prefix zero. While the address reached is one
   * they hold, the field's next entry from the right is the client's, when it is an address — bare,
   * or as RFC 7239 §6 writes a node, its port dropped — held in one form, IPv4-mapped as IPv4 and
   * IPv6 as RFC 5952 writes it. A proxy not listed is a client as any other, every client behind it
   * its address: a told `busy` naming it, or a `largestAddressConnections` near its ceiling, is a
   * proxy to list. None, when not given, the loopback among them. A name, and a network of prefix 0,
   * which would trust what every client writes, are a {@link ProgrammerError} as the server is
   * built, as is any other entry. `Forwarded` is never read.
   */
  trustedProxies?: readonly string[] | undefined;
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
