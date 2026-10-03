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
  IServiceManager,
  IServiceManagerOptions,
  RouterLimitsOptions,
} from '../router/shared/types';
import type { TransportServerConnectionHandle } from '../transport/server/types';
import type { IClock } from '../transport/shared/clock';
import type { IGauges } from '../transport/shared/types';
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
   * A `beforeRequest` that lets through only a connection with a session: what every procedure but
   * the one that makes the session asks for. It refuses with its `refusal`, SESSION_REQUIRED. A
   * composition by `&&` loses that refusal and answers ACCESS_DENIED; a caller that wants to keep
   * SESSION_REQUIRED puts `refusal` on its own function.
   */
  requireSession: ((
    request: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'connectionHandle'>
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
   * How much the router reads, writes and holds, which it is built with: {@link LIMIT_DEFAULTS}'
   * where these say nothing. They must hold together, or the server is a {@link ProgrammerError}.
   */
  limits?: RouterLimitsOptions | undefined;
  /**
   * Milliseconds a connection with no session may stay silent before it is closed — one that never
   * opened a session. One whose session ended keeps that session's connection timeout. A whole
   * number of milliseconds from 1 to {@link LONGEST_TIMER}, or `Infinity` for never, the default;
   * anything else, 0 among them, is a {@link ProgrammerError}.
   */
  connectionInactivityTimeout?: number | undefined;
  /**
   * Whether a connection that lets a command go unanswered past its timeout is closed; a command's
   * own `closeOnTimeout` says otherwise for that command. Not when not given.
   */
  closeOnCommandTimeout?: boolean | undefined;
  /**
   * What a paced subscription queues at most, which its router is built with: `PACING_DEFAULTS`'
   * where it says nothing.
   */
  pacing?: PacingLimitsOptions | undefined;
  /**
   * How the router relays a request that names a destination registered in it. Its `beforeRoute`
   * is `requireSession` when not given: a relay is a door to what is behind it.
   */
  relay?: IRelayOptions | undefined;
}

/**
 * The part of a transport server a server uses, besides what its router does — met by this
 * package's. It asks only for connections named by a handle, and to be told when one opens, speaks or
 * closes; a transport over a broker meets it once its handles have a shape of their own.
 */
export interface IServerTransportLike extends IRouterServerTransportLike {
  close(connectionHandle: TransportServerConnectionHandle): Promise<boolean>;
  /**
   * What it holds, counted: the connections it holds are the ones the other layers may keep anything
   * for. One that counts nothing leaves the server's own for those.
   */
  gauges?(): IGauges<TransportServerConnectionHandle>;
  stop(): Promise<void>;
}
