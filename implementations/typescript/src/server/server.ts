// ── Server ────────────────────────────────────────────────────────────────────

// dependencies

import {
  CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  CREATED_EVENT,
  DELETED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT,
} from '../router/server/constants';
import { createRouterServer, SERVER_FAILURES } from '../router/server/router-server';
import { createSessionManager } from '../router/server/session-manager';
import type { ISession } from '../router/server/types';
import { createServiceManager } from '../router/shared/service-manager';
import type { TransportServerConnectionHandle } from '../transport/server/types';
import { assertHeld, clockOf, type TimeoutId } from '../transport/shared/clock';
import { CLOSE_EVENT, CONNECTION_EVENT, MESSAGE_EVENT } from '../transport/shared/constants';
import { toError } from '../transport/shared/errors';
import { gaugesOf } from '../transport/shared/gauges';
import type { Data as TransportData } from '../transport/shared/types';
import { healthOf, layerGaugesOf, type ServerGauges } from './health';
import type { IServer, IServerLayers, IServerOptions, IServerTransportLike } from './types';

export {
  CLIENT_FAILURES,
  DisconnectError,
  FailureError,
  FailureScope,
  LIMIT_DEFAULTS,
  PACING_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../router/server/router-server';
export { LONGEST_TIMER, PLATFORM_CLOCK } from '../transport/shared/clock';
export type { IClock, TimeoutId } from '../transport/shared/clock';
export {
  CancelError,
  GenericError,
  ProgrammerError,
  TimeoutError,
} from '../transport/shared/errors';
export type {
  AdmissionFailure,
  IAdmissionRequest,
  IBeforeRequest,
  IConnectionTarget,
  IDestination,
  IDestinationOptions,
  IDestinationRegistration,
  IPacingLimits,
  IRelayOptions,
  IRouterLimits,
  IRouterServerOptions,
  NotificationKey,
  PacingLimitsOptions,
  RelayTarget,
  RouterLimitsOptions,
  TransportServerConnectionHandle,
} from '../router/server/router-server';
export type { ISession, ISessionManager } from '../router/server/types';
export type { IServer, IServerLayers, IServerOptions, IServerTransportLike } from './types';
export { WARNING_RATIO } from './health';
export type { HealthStatus, IHealth, IHealthCheck, ILayerGauges, ServerGauges } from './health';

// interfaces

/** A connection with no session: how long it may stay silent, and the timer that closes it. */
interface IIdleConnection {
  timeout: number;
  timeoutId: TimeoutId | undefined;
}

// definition

/**
 * A server from its layers, bottom up: the transport server, the router built on it, the services
 * built on the router, and the sessions whose tokens the router announces to their connections as
 * they change. The router, the services and the sessions are this package's unless others are
 * given.
 *
 * A session is made by a request: the resolver of the procedure that opens one — with credentials,
 * say — stores it with `sessions.set`, and the others take `requireSession` as their
 * `beforeRequest`, which refuses with SESSION_REQUIRED. A procedure that closes a session calls
 * `sessions.delete` before it answers, so the next answer to go out announces the end: its own, or
 * the failure that ends one of the connection's subscriptions. Each message from a connection is
 * activity for it. When the connection timeout of a session passes, its connection is closed; when
 * its session timeout passes, the session ends and the connection stays, its idleness counted
 * afresh against that session's connection timeout, and none of the notifications it subscribed to
 * stay: each subscription is ended with SESSION_REQUIRED. A connection that closes takes its
 * session with it, and a session stored for a connection already closed goes at once.
 *
 * Every layer runs on the transport's clock: the router is built with it, and the builder of the
 * sessions is given it. A clock its options give that differs from the transport's, or a layer
 * built on another, is a {@link ProgrammerError}.
 *
 * @example
 * import { createServer } from '@francisdesjardins/bead/server';
 * import { createWSTransportServer } from '@francisdesjardins/bead/ws-transport-server';
 *
 * const server = createServer({ transport: createWSTransportServer({ WebSocketServer }) });
 *
 * server.router.on('error', (error, connectionHandle) => {
 *   console.error(connectionHandle, error);
 * });
 * void server.transport.start({ port });
 */
export const createServer = <Transport extends IServerTransportLike, Data = unknown>(
  {
    router: createRouter = createRouterServer,
    services: createServices = createServiceManager,
    sessions: createSessions = createSessionManager<Data>,
    transport,
  }: IServerLayers<Transport, Data>,
  options?: IServerOptions
): IServer<Transport, Data> => {
  const { connectionInactivityTimeout = Infinity } = options ?? {};
  const clock = clockOf(
    { beneath: transport.clock, given: options?.clock },
    { below: 'its transport', layer: 'a server' }
  );

  // refused as it is built, as a transfer's inactivity is, rather than a timer armed for no time,
  // which the platforms do not wait alike
  assertHeld("a connection's inactivity timeout", connectionInactivityTimeout);

  const sessions = createSessions({ clock });

  // sessions a builder made on another clock come apart, refused
  try {
    clockOf(
      { beneath: clock, given: sessions.clock },
      { below: 'its server', layer: "a server's session manager" }
    );
  } catch (reason) {
    sessions[Symbol.dispose]();

    throw reason;
  }

  // the connections the transport holds: only these keep a session. The router keeps its own; this
  // one hears of a connection before the router and forgets it first, so a session a close ends
  // finds its connection gone, and asks the router for nothing on it
  const connections = new Set<TransportServerConnectionHandle>();
  // the connections being closed, so each is asked to close once
  const closing = new Set<TransportServerConnectionHandle>();
  const idle = new Map<TransportServerConnectionHandle, IIdleConnection>();

  const stopWaiting = (connectionHandle: TransportServerConnectionHandle): void => {
    clock.clearTimeout(idle.get(connectionHandle)?.timeoutId);
    idle.delete(connectionHandle);
  };

  // a connection that was never opened or is gone keeps nothing
  const forgetConnection = (connectionHandle: TransportServerConnectionHandle): void => {
    connections.delete(connectionHandle);
    stopWaiting(connectionHandle);
    sessions.delete(connectionHandle);
  };

  // a close that fails is the router's to report, with the connection; one the transport no longer
  // holds tells no `close`, so what it left goes now
  const close = (connectionHandle: TransportServerConnectionHandle): void => {
    if (closing.has(connectionHandle)) {
      return;
    }

    closing.add(connectionHandle);
    transport
      .close(connectionHandle)
      .then(
        (isClosed) => {
          if (!isClosed) {
            forgetConnection(connectionHandle);
          }
        },
        (reason: unknown) => {
          router.emit('error', toError(reason), connectionHandle);
        }
      )
      .finally(() => {
        closing.delete(connectionHandle);
      });
  };

  // a connection without a session is closed once silent for its own timeout
  const wait = (connectionHandle: TransportServerConnectionHandle, timeout: number): void => {
    const connection = idle.get(connectionHandle) ?? { timeout, timeoutId: undefined };

    clock.clearTimeout(connection.timeoutId);
    connection.timeoutId = Number.isFinite(connection.timeout)
      ? clock.setTimeout(() => {
          close(connectionHandle);
        }, connection.timeout)
      : undefined;
    idle.set(connectionHandle, connection);
  };

  // before the router's own: a resolver that stores a session as the router reads the envelope finds
  // its connection open already
  const onConnection = (
    ...[, , connectionHandle]: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ]
  ): void => {
    connections.add(connectionHandle);
    wait(connectionHandle, connectionInactivityTimeout);
  };

  // each message is activity, whatever it is and whatever the router makes of it; a connection that
  // speaks is open, even one opened before the server was built
  const onMessage = (_: TransportData, connectionHandle: TransportServerConnectionHandle): void => {
    connections.add(connectionHandle);

    if (!sessions.touch(connectionHandle)) {
      wait(connectionHandle, connectionInactivityTimeout);
    }
  };

  const onClose = (_: boolean, connectionHandle: TransportServerConnectionHandle): void => {
    forgetConnection(connectionHandle);
  };

  // what the server hears of its transport, and lets go of as it comes apart
  const release = (): void => {
    transport.off(CONNECTION_EVENT, onConnection);
    transport.off(MESSAGE_EVENT, onMessage);
    transport.off(CLOSE_EVENT, onClose);
  };

  transport.on(CONNECTION_EVENT, onConnection);
  transport.on(MESSAGE_EVENT, onMessage);
  transport.on(CLOSE_EVENT, onClose);

  // a refusal of its own, which a composition by `&&` loses to ACCESS_DENIED; the relay's by default
  const requireSession = Object.assign(
    ({ connectionHandle }: { connectionHandle: TransportServerConnectionHandle }): boolean => {
      return sessions.has(connectionHandle);
    },
    { refusal: SERVER_FAILURES.sessionRequired }
  );

  let router: ReturnType<typeof createRouter>;

  // limits that do not hold together refuse the router: the server lets go of its transport
  try {
    router = createRouter(transport, {
      clock,
      limits: options?.limits,
      pacing: options?.pacing,
      relay: { ...options?.relay, beforeRoute: options?.relay?.beforeRoute ?? requireSession },
      sessionTokenOf: (connectionHandle) => {
        return sessions.sessionTokenOf(connectionHandle);
      },
    });
  } catch (reason) {
    release();

    throw reason;
  }

  // so does a router a builder made on another clock, which comes apart first
  try {
    clockOf(
      { beneath: clock, given: router.clock },
      { below: 'its server', layer: "a server's router" }
    );
  } catch (reason) {
    router[Symbol.dispose]();
    release();

    throw reason;
  }

  const services = createServices(router, {
    closeConnection: close,
    defaults: { closeOnTimeout: options?.closeOnCommandTimeout },
  });

  // a session stored once its connection was gone would outlive it, for a later connection of the
  // same handle to take over; the session's own timers take over from the idle one
  const onSessionCreated = ({ connectionHandle }: ISession<Data>): void => {
    if (!connections.has(connectionHandle)) {
      return (sessions.delete(connectionHandle), undefined);
    }

    stopWaiting(connectionHandle);
  };

  // a session that ended takes with it what its connection subscribed to, which the session let it
  // have — each subscription ends with SESSION_REQUIRED, which a client that only listens hears —
  // and leaves the connection its connection timeout
  const onSessionDeleted = ({
    connectionHandle,
    connectionInactivityTimeout: timeout,
  }: ISession<Data>): void => {
    if (connections.has(connectionHandle)) {
      void router.dropSubscriptions({
        connectionHandle,
        failure: router.failures.sessionRequired,
      });
      wait(connectionHandle, timeout);
    }
  };

  // a connection silent for too long is gone: closing it ends its session too
  const onConnectionInactive = ({ connectionHandle }: ISession<Data>): void => {
    close(connectionHandle);
  };

  // a session unused for too long ends; its connection stays, to open another
  const onSessionInactive = ({ connectionHandle }: ISession<Data>): void => {
    sessions.delete(connectionHandle);
  };

  // each layer's, set against the connections the transport holds — the server's own, when it counts
  // nothing; one being closed is counted, and stands for no connection until its close ends
  const gauges = (): ServerGauges => {
    const held = transport.gauges?.() ?? gaugesOf({ connectionHandles: connections, counts: {} });

    return Object.freeze({
      router: layerGaugesOf(router.gauges(), held.connectionHandles),
      server: layerGaugesOf(
        gaugesOf({
          connectionHandles: [...connections, ...idle.keys()],
          counts: { closing: closing.size, connections: connections.size, idle: idle.size },
        }),
        held.connectionHandles
      ),
      sessions: layerGaugesOf(sessions.gauges(), held.connectionHandles),
      transport: layerGaugesOf(held, held.connectionHandles),
    });
  };

  sessions.on(CREATED_EVENT, onSessionCreated);
  sessions.on(DELETED_EVENT, onSessionDeleted);
  sessions.on(CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT, onConnectionInactive);
  sessions.on(SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT, onSessionInactive);

  return {
    router,
    services,
    sessions,
    transport,

    gauges,
    health: () => {
      return healthOf(gauges());
    },
    requireSession,
    [Symbol.asyncDispose]: async () => {
      release();
      sessions.off(CREATED_EVENT, onSessionCreated);
      sessions.off(DELETED_EVENT, onSessionDeleted);
      sessions.off(CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT, onConnectionInactive);
      sessions.off(SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT, onSessionInactive);

      for (const { timeoutId } of idle.values()) {
        clock.clearTimeout(timeoutId);
      }

      idle.clear();
      connections.clear();

      // the reverse of the order they were built in; the services hold nothing of their own
      router[Symbol.dispose]();
      sessions[Symbol.dispose]();
      await transport.stop();
    },
  };
};
