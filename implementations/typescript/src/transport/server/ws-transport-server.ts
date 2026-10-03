// ── WebSocket transport server ────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  TRANSPORT_WS,
} from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { assertHeartbeat, createHeartbeat, HEARTBEAT } from '../shared/heartbeat';
import { ReadyState } from '../shared/ready-state';
import type { Data } from '../shared/types';
import { createTransportServer, generateHandle } from './transport-server';
import type {
  IIncomingMessageLike,
  IServerSocketLike,
  ITransportServerAddress,
  ITransportServerClientAware,
  ITransportServerStartOptions,
  IWebSocketServerLike,
  IWSTransportServerOptions,
  WSTransportServer,
} from './types';

export { TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
export { HEARTBEAT } from '../shared/heartbeat';
export type {
  IIncomingMessageLike,
  IServerSocketLike,
  IWebSocketServerConstructor,
  IWebSocketServerLike,
  IWSTransportServerOptions,
  WSTransportServer,
} from './types';

// constants

/** How long a close handshake may take by default: a peer that never answers is dropped after it. */
export const CLOSE_TIMEOUT = 5_000;

/** What an omitted start option resolves to. */
export const START_DEFAULTS = Object.freeze({
  address: '0.0.0.0',
  findOpenPort: false,
  port: 80,
} satisfies ITransportServerStartOptions);

// definition

/**
 * A transport server over WebSocket connections.
 *
 * A text message is delivered as a `string` and a binary one per `binaryType`. A protocol error on a
 * connection emits `error` with its handle, then that connection's `close`. Each connection is
 * pinged every `heartbeat`, and dropped when it left a ping unanswered: a peer gone without a word
 * — a network cut, a machine asleep — ends in a `close` rather than never.
 *
 * @example
 * const server = createWSTransportServer({ WebSocketServer });
 * server.on('message', (data, connectionHandle) => {});
 * const { port } = await server.start({ findOpenPort: true });
 * await server.stop();
 */
export const createWSTransportServer = (options: IWSTransportServerOptions): WSTransportServer => {
  const {
    binaryType = TRANSPORT_WEBSOCKET_BINARYTYPE,
    clock,
    closeTimeout = CLOSE_TIMEOUT,
    heartbeat = HEARTBEAT,
    maxPayload,
    WebSocketServer,
  } = options;

  assertHeartbeat(heartbeat);

  const decoder = new TextDecoder();

  return createTransportServer<IServerSocketLike, IIncomingMessageLike>((server, connections) => {
    let webSocketServer: IWebSocketServerLike | undefined;

    // resolves once `socket` has closed, dropping it when the handshake takes longer than allowed:
    // on the real clock, whatever the server's is, since it bounds the platform's own close against
    // a peer that does not answer (decision 0011)
    const closeSocket = (socket: IServerSocketLike, code: number): Promise<void> => {
      return createPromise((resolve) => {
        const terminate = (): void => {
          socket.terminate();
        };
        // oxlint-disable-next-line no-restricted-properties -- a close handshake's bound is the platform's
        const timeoutId = globalThis.setTimeout(terminate, closeTimeout);

        socket.once(CLOSE_EVENT, () => {
          // oxlint-disable-next-line no-restricted-properties -- as its bound above
          globalThis.clearTimeout(timeoutId);
          resolve();
        });

        try {
          socket.close(code);
        } catch {
          socket.terminate();
        }
      });
    };

    const onConnection = (socket: IServerSocketLike, request: IIncomingMessageLike): void => {
      // read now: a socket already gone reports neither
      const { remoteAddress, remotePort } = request.socket;

      // nothing tells one gone socket's handle from another's, and its close is on its way
      if (remoteAddress === undefined || remotePort === undefined) {
        return (socket.terminate(), undefined);
      }

      const connectionHandle = generateHandle({
        ip: remoteAddress,
        port: remotePort,
        type: TRANSPORT_WS,
      });
      const connection: ITransportServerClientAware<IServerSocketLike> = {
        address: remoteAddress,
        connectionHandle,
        lastActivity: undefined,
        port: remotePort,
        socket,
        type: TRANSPORT_WS,
      };

      connections.set(connectionHandle, connection);

      socket.binaryType = binaryType;

      // a socket that is closing has its close handshake, bounded by `closeTimeout`, to end it
      const beating = createHeartbeat(heartbeat, {
        drop: () => {
          socket.terminate();
        },
        ping: () => {
          if (socket.readyState === ReadyState.OPEN) {
            socket.ping();
          }
        },
      });

      socket.on('pong', () => {
        beating.answer();
      });

      // a socket whose handle a newer one took — its port given again — closes no connection: the
      // handle names the newer one now
      socket.on(CLOSE_EVENT, (code) => {
        beating.stop();

        if (connections.get(connectionHandle) !== connection) {
          return;
        }

        connections.delete(connectionHandle);
        server.emit(CLOSE_EVENT, code === 1000, connectionHandle);
      });

      socket.on(ERROR_EVENT, (error) => {
        server.emit(ERROR_EVENT, error, connectionHandle);
      });

      socket.on(MESSAGE_EVENT, (data, isBinary) => {
        connection.lastActivity = server.clock.Date.now();

        // a text frame arrives as bytes whatever `binaryType` says
        return (
          server.emit(
            MESSAGE_EVENT,
            isBinary ? (data as Data) : decoder.decode(data as ArrayBufferView),
            connectionHandle
          ),
          undefined
        );
      });

      // last and synchronous: a listener meets a connection already registered and wired, and before
      // any frame that arrived with the upgrade request is read
      server.emit(CONNECTION_EVENT, socket, request, connectionHandle);
    };

    return {
      clock,
      defaults: START_DEFAULTS,
      type: TRANSPORT_WS,

      start: async ({ address, findOpenPort, port, signal }) => {
        let opened: IWebSocketServerLike | undefined;
        let isListening = false;

        try {
          return await createPromise<ITransportServerAddress>(
            (resolve, reject) => {
              const instance = new WebSocketServer({
                host: address,
                port: findOpenPort ? 0 : port,
                ...(maxPayload === undefined ? {} : { maxPayload }),
              });

              opened = instance;

              instance.on(ERROR_EVENT, (error) => {
                if (isListening) {
                  return (server.emit(ERROR_EVENT, error, ''), undefined);
                }

                return (reject(error), undefined);
              });

              instance.on('listening', () => {
                const addressInfo = instance.address();

                isListening = true;
                webSocketServer = instance;

                resolve({
                  address,
                  port:
                    typeof addressInfo === 'object' && addressInfo !== null
                      ? addressInfo.port
                      : port,
                });
              });

              instance.on(CONNECTION_EVENT, onConnection);
            },
            { signal }
          );
        } catch (reason) {
          // an error before listening, or an abort: close what was opened, listening or not
          webSocketServer = undefined;
          opened?.close();

          throw reason;
        }
      },

      stop: async () => {
        const instance = webSocketServer;

        webSocketServer = undefined;

        // first, so no connection arrives while the open ones are closing; the port is free once it
        // returns, and its callback is not awaited because it also waits on peers that never upgraded
        instance?.close();

        await Promise.all(
          connections
            .values()
            .map(({ socket }) => {
              return closeSocket(socket, 1001); // going away
            })
            .toArray()
        );
      },

      close: ({ socket }) => {
        return closeSocket(socket, 1000);
      },

      send: (data, { socket }) => {
        return createPromise((resolve) => {
          // `ReadyState` keeps the WebSocket numbering, so its OPEN is the socket's
          if (socket.readyState === ReadyState.OPEN) {
            socket.send(data);
          }

          return (resolve(), undefined);
        });
      },
    };
  });
};
