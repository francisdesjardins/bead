// ── WebSocket transport server ────────────────────────────────────────────────

// dependencies

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import {
  CLOSE_EVENT,
  CONNECTION_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  TRANSPORT_WS,
} from '../shared/constants';
import { assertHeld } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import { assertHeartbeat, createHeartbeat, HEARTBEAT } from '../shared/heartbeat';
import { ReadyState } from '../shared/ready-state';
import type { Data } from '../shared/types';
import { assertHosts, assertOrigins, clientAddressOf } from './hosts-and-origins';
import { createTransportServer, generateHandle } from './transport-server';
import type {
  IIncomingMessageLike,
  IServerSocketLike,
  ITransportServerAddress,
  ITransportServerClientAware,
  ITransportServerStartOptions,
  IUpgradeSocketLike,
  IWebSocketServerLike,
  IWSTransportServerOptions,
  WSTransportServer,
} from './types';
import {
  BUSY_HANDSHAKE,
  type IHandshakeRefusal,
  MALFORMED_HANDSHAKE,
  refusalOfHandshake,
  toldOfHandshake,
} from './ws-handshake';

export { TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
export { HEARTBEAT } from '../shared/heartbeat';
export { HOST_REFUSAL, ORIGIN_REFUSAL } from './hosts-and-origins';
export type {
  IIncomingMessageLike,
  IServerSocketLike,
  IUpgradeSocketLike,
  IWebSocketServerConstructor,
  IWebSocketServerLike,
  IWSTransportServerOptions,
  WSTransportServer,
} from './types';
export { WS_REFUSALS } from './ws-handshake';

// constants

/** How long a close handshake may take by default: a peer that never answers is dropped after it. */
export const CLOSE_TIMEOUT = 5_000;

/** The largest message by default: a router's largest envelope by default (spec 15.3). */
export const MAXIMUM_MESSAGE_BYTES = 16_778_240;

/** What an omitted start option resolves to. */
export const START_DEFAULTS = Object.freeze({
  address: '0.0.0.0',
  findOpenPort: false,
  port: 80,
} satisfies ITransportServerStartOptions);

// helpers

// closes what a start opened and does not keep: an HTTP server still binding its address once it
// listens, since it closes nothing before then
const closeOpened = (
  opened: { http: Server; instance: IWebSocketServerLike } | undefined
): void => {
  if (opened === undefined) {
    return;
  }

  const { http, instance } = opened;

  instance.close();

  if (!http.listening) {
    http.once('listening', () => {
      http.close();
    });
  }

  http.close();
};

// definition

/**
 * A transport server over WebSocket connections.
 *
 * A text message is delivered as a `string` and a binary one per `binaryType`. A protocol error on a
 * connection emits `error` with its handle, then that connection's `close`. Each connection is
 * pinged every `heartbeat`, and dropped when it left a ping unanswered: a peer gone without a word
 * — a network cut, a machine asleep — ends in a `close` rather than never.
 *
 * A WebSocket carries no credential beside an envelope: each message delivered carries none, and a
 * credential given to `send` is not carried.
 *
 * A request at its address is judged in the order of spec 15.2, `hosts` and `origins` among its
 * steps as the HTTP transport's (spec 15.12): 400 as HTTP answers it to a `Host` missing, repeated
 * or no host, or to an absolute-form target that names none; 403 to a host it does not take; 405 to
 * a method but `GET` or `HEAD`; 426 to a request that asks no WebSocket, and to a version but 13;
 * 400 to a malformed upgrade; 403 to an `Origin` neither its own nor among `origins`; each refusal
 * as {@link refusalOfHandshake} writes it. Each message is an envelope at most by default, {@link MAXIMUM_MESSAGE_BYTES}, and `ws`
 * closes a connection that sends a larger one with 1009.
 *
 * @example
 * const server = createWSTransportServer({ WebSocketServer });
 * server.on('message', ({ data }, connectionHandle) => {});
 * const { port } = await server.start({ findOpenPort: true });
 * await server.stop();
 */
export const createWSTransportServer = (options: IWSTransportServerOptions): WSTransportServer => {
  const {
    binaryType = TRANSPORT_WEBSOCKET_BINARYTYPE,
    clock,
    closeTimeout: givenCloseTimeout = CLOSE_TIMEOUT,
    heartbeat: givenHeartbeat = HEARTBEAT,
    hosts,
    maxPayload = MAXIMUM_MESSAGE_BYTES,
    origins = [],
    secure,
    WebSocketServer,
  } = options;
  const heartbeat = assertHeartbeat(givenHeartbeat);
  const closeTimeout = assertHeld('a close timeout', givenCloseTimeout);
  assertHosts(hosts);
  assertOrigins(origins);
  const judged = { hosts, origins };

  const decoder = new TextDecoder();

  return createTransportServer<IServerSocketLike, IIncomingMessageLike>(
    (server, connections, { isHeard, tell }) => {
      let httpServer: Server | undefined;
      let webSocketServer: IWebSocketServerLike | undefined;
      // the rank of the last connection taken, across its starts: no handle is given twice
      let ordinal = 0;

      // resolves once `socket` has closed, dropping it when the handshake takes longer than allowed:
      // on the real clock, whatever the server's is, since it bounds the platform's own close against
      // a peer that does not answer (decision 0011)
      const closeSocket = (socket: IServerSocketLike, code: number): Promise<void> => {
        return createPromise((resolve) => {
          const terminate = (): void => {
            socket.terminate();
          };
          // `Infinity` waits on the peer without end, where Node's timer would take it for 1 ms
          const timeoutId =
            closeTimeout === Infinity
              ? undefined
              : // oxlint-disable-next-line no-restricted-properties -- a close handshake's bound is the platform's
                globalThis.setTimeout(terminate, closeTimeout);

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

      const dateOf = (): string => {
        return new Date(server.clock.Date.now()).toUTCString();
      };

      // writes a refusal by `write`, then tells it, when it is marked, the transport's own (spec
      // 15.1): every refusal at the address is an upgrade's, as it arrives; its record is built
      // for a listener alone, before the write, which may close its socket
      const refuse = (
        request: IIncomingMessageLike,
        { refusal: given, write }: { refusal: IHandshakeRefusal; write: () => void }
      ): void => {
        const { refusal: reason, status } = given;
        const { remoteAddress, remotePort } = request.socket;
        const refusal =
          reason === undefined || !isHeard(REFUSAL_EVENT)
            ? undefined
            : {
                address: remoteAddress === undefined ? undefined : clientAddressOf(remoteAddress),
                ...toldOfHandshake(request),
                port: remotePort ?? 0,
                reason,
                status,
              };

        write();

        if (refusal !== undefined) {
          tell(REFUSAL_EVENT, [refusal]);
        }
      };

      // a refusal written raw where no response is at hand, a `CONNECT`'s or an upgrade's ws could
      // not read, and its socket ended
      const answer = (socket: IUpgradeSocketLike, { fields, status }: IHandshakeRefusal): void => {
        socket.on(ERROR_EVENT, () => {
          socket.destroy();
        });
        socket.once('finish', () => {
          socket.destroy();
        });
        socket.end(
          [
            `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
            `date: ${dateOf()}`,
            ...Object.entries(fields).map(([name, value]) => {
              return `${name}: ${value}`;
            }),
            '',
            '',
          ].join('\r\n')
        );
      };

      // what one HTTP server answers of its own, made as it starts: `isStopped` says whether that
      // server's stop began, so a head that ends after it is judged by its own server, not a later one
      const answersOf = (isStopped: () => boolean) => {
        // ! Node raises `request` for no upgrade the callback takes: one the judgement takes here is
        // one the stop refused, busy, or one Node did not read as an upgrade, malformed
        const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
          const refusal =
            refusalOfHandshake(request, judged) ??
            (isStopped() ? BUSY_HANDSHAKE : MALFORMED_HANDSHAKE);

          refuse(request, {
            refusal,
            write: () => {
              response.sendDate = false;
              response.writeHead(refusal.status, { date: dateOf(), ...refusal.fields }).end();
            },
          });
        };

        // ! what the callback takes, ws takes, but for `Upgrade`: ws compares its whole value with
        // `websocket`, where RFC 9110 §7.8 makes it a list, so it is set to the token the judgement
        // found; once the stop began, ws listens no more, and Node would drop the upgrade unanswered
        const shouldUpgradeCallback = (request: IncomingMessage): boolean => {
          if (isStopped() || refusalOfHandshake(request, judged) !== undefined) {
            return false;
          }

          request.headers.upgrade = 'websocket';

          return true;
        };

        return { onRequest, shouldUpgradeCallback };
      };

      // a `CONNECT` keeps an event of its own, where it is refused for its host or its method
      const onConnect = (request: IncomingMessage, socket: IUpgradeSocketLike): void => {
        const refusal = refusalOfHandshake(request, judged) ?? MALFORMED_HANDSHAKE;

        refuse(request, {
          refusal,
          write: () => {
            answer(socket, refusal);
          },
        });
      };

      // a guard: ws reads nothing the judgement has not taken, and would refuse it 400
      const onClientError = (
        _error: Error,
        socket: IUpgradeSocketLike,
        // oxlint-disable-next-line bead/options-last -- ws's own, a `wsClientError` listener's
        request: IIncomingMessageLike
      ): void => {
        refuse(request, {
          refusal: MALFORMED_HANDSHAKE,
          write: () => {
            answer(socket, MALFORMED_HANDSHAKE);
          },
        });
      };

      const onConnection = (socket: IServerSocketLike, request: IIncomingMessageLike): void => {
        // read now: a socket already gone reports neither
        const { remoteAddress, remotePort } = request.socket;

        // a socket gone has no peer to name, and its close is on its way
        if (remoteAddress === undefined || remotePort === undefined) {
          return (socket.terminate(), undefined);
        }

        const address = clientAddressOf(remoteAddress);
        // drawn as it is taken, never from the peer's address alone, which another socket may share
        const connectionHandle = generateHandle({
          ip: address,
          ordinal: (ordinal += 1),
          port: remotePort,
          type: TRANSPORT_WS,
        });
        const connection: ITransportServerClientAware<IServerSocketLike> = {
          address,
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

        // a connection the registry no longer holds, which a stop cleared, tells no close of its own
        socket.on(CLOSE_EVENT, (code) => {
          beating.stop();

          if (connections.get(connectionHandle) !== connection) {
            return;
          }

          connections.delete(connectionHandle);
          tell(CLOSE_EVENT, [code === 1000, connectionHandle]);
        });

        socket.on(ERROR_EVENT, (error) => {
          server.emit(ERROR_EVENT, error, connectionHandle);
        });

        socket.on(MESSAGE_EVENT, (data, isBinary) => {
          connection.lastActivity = server.clock.Date.now();

          // a text frame arrives as bytes whatever `binaryType` says
          const delivered = isBinary ? (data as Data) : decoder.decode(data as ArrayBufferView);

          return (
            tell(MESSAGE_EVENT, [{ credential: undefined, data: delivered }, connectionHandle]),
            undefined
          );
        });

        // ! a stop that began as this registered closes it with its own, going away: its snapshot of
        // the connections was taken already, or its registry cleared; reached only by an injected
        // `WebSocketServer` that delivers a connection after its `close()`, since ws takes none then
        if (server.isClosing() || server.isClosed()) {
          void closeSocket(socket, 1001); // going away
        }

        // last and synchronous: a listener meets a connection already registered and wired, and before
        // any frame that arrived with the upgrade request is read
        tell(CONNECTION_EVENT, [socket, request, connectionHandle]);
      };

      return {
        clock,
        defaults: START_DEFAULTS,
        secure,
        type: TRANSPORT_WS,

        start: async ({ address, findOpenPort, port, signal }) => {
          let opened: { http: Server; instance: IWebSocketServerLike } | undefined;
          let isListening = false;

          try {
            return await createPromise<ITransportServerAddress>(
              (resolve, reject) => {
                const { onRequest, shouldUpgradeCallback } = answersOf(() => {
                  return httpServer !== http;
                });
                const http = createServer({ shouldUpgradeCallback }, onRequest);
                const instance = new WebSocketServer({ maxPayload, server: http });

                opened = { http, instance };
                http.on('connect', onConnect);

                // ws forwards its server's `error` and `listening`
                instance.on(ERROR_EVENT, (error) => {
                  if (isListening) {
                    return (server.emit(ERROR_EVENT, error, ''), undefined);
                  }

                  return (reject(error), undefined);
                });

                instance.on('listening', () => {
                  const addressInfo = instance.address();

                  isListening = true;
                  httpServer = http;
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
                instance.on('wsClientError', onClientError);
                http.listen(findOpenPort ? 0 : port, address);
              },
              { signal }
            );
          } catch (reason) {
            // an error before listening, or an abort: close what was opened, listening or not, and
            // once it listens when its address is still being bound
            httpServer = undefined;
            webSocketServer = undefined;
            closeOpened(opened);

            throw reason;
          }
        },

        stop: async () => {
          const instance = webSocketServer;
          const http = httpServer;

          webSocketServer = undefined;
          httpServer = undefined;

          // first, so no connection arrives while the open ones are closing; the port is free once it
          // returns, and its callback is not awaited because it also waits on peers that never
          // upgraded; ws leaves open the server it was given
          instance?.close();
          http?.close();
          http?.closeIdleConnections();

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

        // a credential given here is not carried: the router fails a command that presents one
        // its transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
        send: ({ data }, { socket }) => {
          return createPromise((resolve) => {
            // `ReadyState` keeps the WebSocket numbering, so its OPEN is the socket's
            if (socket.readyState === ReadyState.OPEN) {
              socket.send(data);
            }

            return (resolve(), undefined);
          });
        },
      };
    }
  );
};
