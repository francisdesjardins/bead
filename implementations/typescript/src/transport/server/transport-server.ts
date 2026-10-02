// ── Transport server ──────────────────────────────────────────────────────────

// dependencies

import { createEmitter } from '../shared/emitter';
import { ProgrammerError } from '../shared/errors';
import { gaugesOf, mergeGauges } from '../shared/gauges';
import { createEventMethods, createReadyStateMethods } from '../shared/lifecycle';
import {
  getReadyStateName,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import type {
  ITransportServer,
  ITransportServerClientHandleInfo,
  ITransportServerDrawnHandleInfo,
  ITransportServerImplementation,
  TransportServerConnectionHandle,
  TransportServerConnections,
  TransportServerEventMap,
  TransportServerResolvedStartOptions,
} from './types';

export {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
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
export { timestamp } from '../shared/timestamp';
export type { Data, IEventIteratorOptions, ITimestamp } from '../shared/types';
export type {
  ITransportServer,
  ITransportServerAddress,
  ITransportServerClient,
  ITransportServerClientAware,
  ITransportServerClientHandleInfo,
  ITransportServerDrawnHandleInfo,
  ITransportServerImplementation,
  ITransportServerStartOptions,
  TRANSPORT_SERVER_EVENTS,
  TransportServerConnectionHandle,
  TransportServerConnections,
  TransportServerEventMap,
  TransportServerOnCloseCallback,
  TransportServerOnConnectionCallback,
  TransportServerOnErrorCallback,
  TransportServerOnMessageCallback,
  TransportServerResolvedStartOptions,
} from './types';

// helpers

/** `type=WS;ip=127.0.0.1;port=50000`: one connection, named by who is on the other end. */
export const generateHandle = (
  handleInfo: ITransportServerClientHandleInfo
): TransportServerConnectionHandle => {
  return `type=${handleInfo.type};ip=${handleInfo.ip};port=${handleInfo.port}`;
};

/**
 * `type=HTTP;ip=127.0.0.1;ordinal=7`: one connection a transport drew, named by the rank it was drawn
 * at, since the socket it came on does not outlive the exchange that drew it.
 */
export const generateDrawnHandle = (
  handleInfo: ITransportServerDrawnHandleInfo
): TransportServerConnectionHandle => {
  return `type=${handleInfo.type};ip=${handleInfo.ip};ordinal=${handleInfo.ordinal}`;
};

// definition

/**
 * The shared half of every transport server: the events, the ready state, the connection registry,
 * `clients`, `closeAll`, and the guards around `start` and `stop`.
 *
 * `define` receives the server being built and the registry its transport fills, and returns what
 * only that transport knows — how to listen, stop, close one connection and send to one.
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
    connections: TransportServerConnections<Socket>
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
        .map(({ address, connectionHandle, lastActivityTimestamp, port, type }) => {
          return { address, connectionHandle, lastActivityTimestamp, port, type };
        })
        .toArray();
    },
    get port() {
      return startOptions.port;
    },
    get type() {
      return implementation.type;
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
    gauges: () => {
      return mergeGauges([
        gaugesOf({
          connectionHandles: connections.keys(),
          counts: { connections: connections.size },
        }),
        ...(implementation.gauges === undefined ? [] : [implementation.gauges()]),
      ]);
    },
    send: async (data, connectionHandle) => {
      const connection = connections.get(connectionHandle);

      if (connection !== undefined) {
        await implementation.send(data, connection);
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
  const implementation = define(server, connections);

  startOptions = implementation.defaults;

  return server;
};
