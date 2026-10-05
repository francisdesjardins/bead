// dependencies

import type {
  IRelayOptions,
  IRouterServerOptions,
  ISessionManager,
  PacingLimitsOptions,
} from '../router/server/types';
import type { IRouterServer, IRouterServerTransportLike } from '../router/server/router-server';
import type {
  AdmissionFailure,
  IAdmissionRequest,
  ICredentials,
  IServiceManager,
  IServiceManagerOptions,
  RouterLimitsOptions,
} from '../router/shared/types';
import type { TransportServerConnectionHandle } from '../transport/server/types';
import type { IClock } from '../transport/shared/clock';
import type { EmitterListener, IGauges, ITransportMessage } from '../transport/shared/types';
import type { IMetricsRegistry } from '../router/shared/metrics-registry';
import type { IHealth, ServerGauges } from './health';

// interfaces

/**
 * What an application serves its clients with: its three layers — the transport server, the router
 * on it, the services on the router — and the sessions whose tokens the router announces to the
 * connections.
 */
export interface IServer<
  Transport extends IServerTransportLike = IServerTransportLike,
  Data = unknown,
> {
  readonly router: IRouterServer<Transport>;
  /** The requesters, commands and resolvers of the services, made on {@link IServer.router}. */
  readonly services: IServiceManager<TransportServerConnectionHandle>;
  /**
   * The connections' sessions. A session is made by a request — a resolver stores it with
   * `sessions.set` — and goes with its connection. Its connection timeout closes the connection;
   * its session timeout ends the session, and the notifications its connection subscribed to, while
   * the connection stays.
   */
  readonly sessions: ISessionManager<Data>;
  readonly transport: Transport;

  /**
   * What each layer holds right now, for diagnosis: its counts, their ceilings, its anomalies, and
   * how many connections it keeps anything for that the transport no longer holds — no handle, token
   * or address.
   */
  gauges(): ServerGauges;
  /**
   * The verdict on {@link IServer.gauges}, as the IETF draft "Health Check Response Format for HTTP
   * APIs" writes one: `fail` for an orphan or an anomaly, `warn` for a count near its ceiling. What
   * timers hold in closures — a heartbeat's, a stalled transfer's — no gauge sees.
   */
  health(): IHealth;
  /**
   * A `beforeRequest` that lets through only a call with a session, its call's, never its
   * connection's (spec 13.5): what every procedure but the one that makes the session asks for. It
   * refuses with its `refusal`, SESSION_REQUIRED, which its router answers a call that presented a
   * credential with ACCESS_DENIED (spec 9.2, step 5). A composition by `&&` loses that refusal and
   * answers ACCESS_DENIED; a caller that wants to keep SESSION_REQUIRED puts `refusal` on its own
   * function.
   */
  requireSession: ((
    request: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'session'>
  ) => boolean) & { readonly refusal: AdmissionFailure };
  /**
   * A relay's `beforeRoute`, its server's by default (spec 14.3, step 1): a call in leg A's
   * connection's session, or one whose header presents a `JWT`, or an `ELSEWHERE` its transport
   * carried, which the relay forwards for its destination to verify. It refuses any other, a call in
   * none that presented none, with its `refusal`, SESSION_REQUIRED.
   */
  requireSessionOrCredential: ((
    request: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'header' | 'session'>
  ) => boolean) & { readonly refusal: AdmissionFailure };
  /**
   * What `await using` calls: the layers come apart in the reverse of the order they were built in
   * — the router stops listening to the transport, rejecting what still waits for an answer, the
   * sessions stop their timers, then the transport stops.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The layers of a server, bottom up: the transport server, built, then what builds each layer on
 * the one under it.
 */
export interface IServerLayers<Transport extends IServerTransportLike, Data = unknown> {
  /**
   * Builds the router on the transport, which the server gives its sessions' tokens and its limits;
   * `createRouterServer` when not given.
   */
  router?:
    | ((transport: Transport, options: IRouterServerOptions) => IRouterServer<Transport>)
    | undefined;
  /**
   * Builds the services on the router, which the server gives the means to close a connection that
   * lets a command go unanswered; `createServiceManager` when not given.
   */
  services?:
    | ((
        router: IRouterServer<Transport>,
        options: IServiceManagerOptions<TransportServerConnectionHandle>
      ) => IServiceManager<TransportServerConnectionHandle>)
    | undefined;
  /**
   * Builds the sessions on the clock it is given, the transport's, which they must run on;
   * `createSessionManager` when not given.
   */
  sessions?: ((options: { clock: IClock }) => ISessionManager<Data>) | undefined;
  transport: Transport;
}

export interface IServerOptions {
  /**
   * The clock the server runs on: its transport's, which one given must be; the platform's when
   * neither has one.
   */
  clock?: IClock | undefined;
  /**
   * What its router resolves a request presenting a `JWT` or an `ELSEWHERE` with: a `JWT`'s keys,
   * audience and key set, an `ELSEWHERE`'s verifier. A scheme it is given nothing for is refused,
   * CREDENTIAL_UNSUPPORTED.
   */
  credentials?: ICredentials | undefined;
  /**
   * How much the router reads, writes and holds, which it is built with: {@link LIMIT_DEFAULTS}'
   * where these say nothing. They must hold together, or the server is a {@link ProgrammerError}.
   */
  limits?: RouterLimitsOptions | undefined;
  /**
   * Milliseconds a connection with no session may stay silent before it is closed — one that never
   * opened a session, or one whose session ended, counted from that end; over HTTP, a listen held
   * is no silence, and the count starts anew at its end. From 1 to {@link LONGEST_TIMER}, rounded to
   * the nearest whole one, or `Infinity` for never, the default; anything else, 0 among them, is a
   * {@link ProgrammerError}.
   */
  connectionInactivityTimeout?: number | undefined;
  /**
   * Whether a connection that lets a command go unanswered past its timeout is closed; a command's
   * own `closeOnTimeout` says otherwise for that command. Not when not given.
   */
  closeOnCommandTimeout?: boolean | undefined;
  /**
   * The registry its router counts its calls and its notifications into, which it is built with:
   * served at `/metrics`, say, beside `/health`. None counts nothing.
   */
  metricsRegistry?: IMetricsRegistry | undefined;
  /**
   * What a paced subscription queues at most, which its router is built with: `PACING_DEFAULTS`'
   * where it says nothing.
   */
  pacing?: PacingLimitsOptions | undefined;
  /**
   * How the router relays a request that names a destination registered in it. Its `beforeRoute`
   * is `requireSessionOrCredential` when not given: a relay is a door to what is behind it, which a
   * credential it forwards opens for its destination to verify.
   */
  relay?: IRelayOptions | undefined;
}

/**
 * The part of a transport server a server uses, besides what its router does — met by this
 * package's. It asks only for connections named by a handle, and to be told when one opens, speaks or
 * closes, and, over HTTP, when a listen is held and when it ends; a transport over a broker meets it
 * once its handles have a shape of their own.
 */
export interface IServerTransportLike extends IRouterServerTransportLike {
  close(connectionHandle: TransportServerConnectionHandle): Promise<boolean>;
  /**
   * What it holds, counted: the connections it holds are the ones the other layers may keep anything
   * for. One that counts nothing leaves the server's own for those.
   */
  gauges?(): IGauges<TransportServerConnectionHandle>;
  off(
    event: 'close',
    listener: EmitterListener<
      [wasClean: boolean, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  off(
    event: 'connection',
    listener: EmitterListener<
      [socket: unknown, request: unknown, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  off(
    event: 'listen',
    listener: EmitterListener<[isHeld: boolean, connectionHandle: TransportServerConnectionHandle]>
  ): unknown;
  off(
    event: 'message',
    listener: EmitterListener<
      [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  on(
    event: 'close',
    listener: EmitterListener<
      [wasClean: boolean, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  on(
    event: 'connection',
    listener: EmitterListener<
      [socket: unknown, request: unknown, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  /** A listen held on a connection, `isHeld`, and its end; one that has no listen never says it. */
  on(
    event: 'listen',
    listener: EmitterListener<[isHeld: boolean, connectionHandle: TransportServerConnectionHandle]>
  ): unknown;
  on(
    event: 'message',
    listener: EmitterListener<
      [message: ITransportMessage, connectionHandle: TransportServerConnectionHandle]
    >
  ): unknown;
  stop(): Promise<void>;
}
