// ── Transport server ──────────────────────────────────────────────────────────

// dependencies

import { PLATFORM_CLOCK } from '../shared/clock';
import { createEmitter } from '../shared/emitter';
import { ERROR_EVENT } from '../shared/constants';
import { ProgrammerError, toError } from '../shared/errors';
import { gaugesOf, mergeGauges } from '../shared/gauges';
import { createEventMethods, createReadyStateMethods } from '../shared/lifecycle';
import {
  getReadyStateName,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { isLoopbackHost } from '../shared/secure';
import type {
  ITransportServer,
  ITransportServerHandleInfo,
  ITransportServerImplementation,
  ITransportServerDefineOptions,
  TransportServerConnectionHandle,
  TransportServerConnections,
  TransportServerEventMap,
  TransportServerResolvedStartOptions,
  TransportServerToldEvent,
} from './types';

export { LONGEST_TIMER, PLATFORM_CLOCK } from '../shared/clock';
export type { IClock, TimeoutId } from '../shared/clock';
export {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  LISTEN_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
  TRANSPORT_HTTP,
  TRANSPORT_WS,
} from '../shared/constants';
export type { TRANSPORTS } from '../shared/constants';
export {
  CancelError,
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  ReconnectError,
  TimeoutError,
} from '../shared/errors';
export {
  getReadyState,
  isReadyStateClosed,
  isReadyStateClosing,
  isReadyStateConnecting,
  isReadyStateOpen,
  isReadyStateReconnecting,
  isReadyStateUninitialized,
  READY_STATE_NAMES,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
  setReadyStateReconnecting,
  setReadyStateUninitialized,
} from '../shared/ready-state';
export type { Data, IEventIteratorOptions, ITransportMessage } from '../shared/types';
export type {
  ITransportServer,
  ITransportServerAddress,
  ITransportServerClient,
  ITransportServerClientAware,
  ITransportServerHandleInfo,
  ITransportServerImplementation,
  ITransportServerDefineOptions,
  ITransportServerOptions,
  ITransportServerRefusal,
  ITransportServerStartOptions,
  TRANSPORT_SERVER_EVENTS,
  TransportServerConnectionHandle,
  TransportServerConnections,
  TransportServerEventMap,
  TransportServerOnCloseCallback,
  TransportServerOnConnectionCallback,
  TransportServerOnErrorCallback,
  TransportServerOnMessageCallback,
  TransportServerOnRefusalCallback,
  TransportServerResolvedStartOptions,
  TransportServerToldEvent,
} from './types';

// helpers

/**
 * `type=WS;ip=127.0.0.1;port=50000;ordinal=3`: one connection, named by who it came from, its peer's
 * port when it has a socket of its own, and the rank its transport took it at, which no other
 * connection of that transport shares (spec 15.1); `type=HTTP;ip=127.0.0.1;ordinal=7` without a port.
 */
export const generateHandle = ({
  ip,
  ordinal,
  port,
  type,
}: ITransportServerHandleInfo): TransportServerConnectionHandle => {
  return port === undefined
    ? `type=${type};ip=${ip};ordinal=${ordinal}`
    : `type=${type};ip=${ip};port=${port};ordinal=${ordinal}`;
};

// definition

/**
 * The shared half of every transport server: the events, the ready state, the connection registry,
 * `clients`, `closeAll`, and the guards around `start` and `stop`.
 *
 * `define` receives the server being built, the registry its transport fills, and the `tell` its
 * transport calls its listeners by, and returns what only that transport knows — the clock it
 * runs on, how to listen, stop, close one connection and send to one.
 *
 * @example
 * const server = createTransportServer((server, connections) => {
 *   return {
 *     defaults: { address: '0.0.0.0', findOpenPort: false, port: 80 },
 *     type: 'WS',
 *     close: () => Promise.resolve(),
 *     send: () => Promise.resolve(),
 *     start: ({ address, port }) => Promise.resolve({ address, port }),
 *     stop: () => Promise.resolve(),
 *   };
 * });
 */
export const createTransportServer = <Socket extends object, Request>(
  define: (
    server: ITransportServer<Socket, Request>,
    connections: TransportServerConnections<Socket>,
    options: ITransportServerDefineOptions<Socket, Request>
  ) => ITransportServerImplementation<Socket>
): ITransportServer<Socket, Request> => {
  const emitter = createEmitter<TransportServerEventMap<Socket, Request>>();
  const connections: TransportServerConnections<Socket> = new Map();

  // a placeholder until `define` returns its transport's defaults, since a transport may read
  // `server.address` while it is being built
  let startOptions: TransportServerResolvedStartOptions = {
    address: '',
    findOpenPort: false,
    port: 0,
  };
  let stopping: Promise<void> | undefined;

  // each listener within a guard (spec 15.1): what one throws is reported with the connection it
  // was told of, and the transport goes on as if it returned
  const defineOptions: ITransportServerDefineOptions<Socket, Request> = {
    isHeard: (event) => {
      return emitter.listenerCount(event) > 0;
    },
    tell: <K extends TransportServerToldEvent>(
      event: K,
      params: TransportServerEventMap<Socket, Request>[K]
    ) => {
      // ! every event but `error` and `refusal` carries its connection's handle last; a refusal
      // names none, so what its listener throws is reported with the empty handle
      const last: unknown = params.at(-1);
      const connectionHandle =
        typeof last === 'string' ? (last as TransportServerConnectionHandle) : '';

      return emitter.emitEach(event, {
        onError: (error) => {
          emitter.emit(ERROR_EVENT, toError(error), connectionHandle);
        },
        params,
      });
    },
  };

  const server: ITransportServer<Socket, Request> = {
    ...createEventMethods(emitter, () => {
      return server;
    }),
    ...createReadyStateMethods(() => {
      return server;
    }),

    get address() {
      return startOptions.address;
    },
    get clients() {
      return connections
        .values()
        .map(({ address, connectionHandle, lastActivity, port, type }) => {
          return { address, connectionHandle, lastActivity, port, type };
        })
        .toArray();
    },
    get clock() {
      return implementation.clock ?? PLATFORM_CLOCK;
    },
    get port() {
      return startOptions.port;
    },
    get type() {
      return implementation.type;
    },

    // none carries one toward its client: an answer, a batch, a message or a worker's alike
    carriesCredential: () => {
      return false;
    },
    close: async (connectionHandle) => {
      const connection = connections.get(connectionHandle);

      if (connection === undefined) {
        return false;
      }

      await implementation.close(connection);

      return true;
    },
    closeAll: () => {
      return Promise.all(
        connections
          .keys()
          .map((connectionHandle) => {
            return server.close(connectionHandle);
          })
          .toArray()
      );
    },
    // what its application says stands in front of it is believed first, whatever it listens on
    isSecure: () => {
      return (
        implementation.secure ??
        (implementation.isSecure === true || isLoopbackHost(startOptions.address))
      );
    },
    gauges: () => {
      return mergeGauges([
        gaugesOf({
          connectionHandles: connections.keys(),
          counts: { connections: connections.size },
        }),
        ...(implementation.gauges === undefined ? [] : [implementation.gauges()]),
      ]);
    },
    send: async (message, connectionHandle) => {
      const connection = connections.get(connectionHandle);

      if (connection !== undefined) {
        await implementation.send(message, connection);
      }
    },
    start: async (options) => {
      if (!server.isUninitialized() && !server.isClosed()) {
        throw new ProgrammerError(`server is already ${getReadyStateName(server)}`);
      }

      const { defaults } = implementation;
      const {
        address = defaults.address,
        findOpenPort = defaults.findOpenPort,
        port = defaults.port,
        signal,
      } = options ?? {};

      startOptions = { address, findOpenPort, port };

      setReadyStateConnecting(server);

      try {
        const boundAddress = await implementation.start({ ...startOptions, signal });

        startOptions = { ...startOptions, ...boundAddress };

        setReadyStateOpen(server);

        return boundAddress;
      } catch (reason) {
        setReadyStateClosed(server);

        throw reason;
      }
    },
    stop: () => {
      if (server.isUninitialized() || server.isClosed()) {
        return Promise.resolve();
      }

      if (stopping !== undefined) {
        return stopping;
      }

      if (server.isConnecting()) {
        return Promise.reject(new ProgrammerError('server is starting'));
      }

      setReadyStateClosing(server);

      // entered from a settled promise, so a throw becomes a rejection and a stop re-entered from a
      // `close` listener shares this one
      stopping = Promise.resolve()
        .then(() => {
          return implementation.stop();
        })
        .finally(() => {
          connections.clear();
          setReadyStateClosed(server);
          stopping = undefined;
        });

      return stopping;
    },
    [Symbol.asyncDispose]: () => {
      return server.stop();
    },
  };

  // after `server` exists, since `define` closes over it; the methods above only read this when called
  const implementation = define(server, connections, defineOptions);

  startOptions = implementation.defaults;

  return server;
};
