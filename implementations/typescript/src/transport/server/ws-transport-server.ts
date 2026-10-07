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
import { assertHeld } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import { assertHeartbeat, createHeartbeat, HEARTBEAT } from '../shared/heartbeat';
import { ReadyState } from '../shared/ready-state';
import type { Data } from '../shared/types';
import { HOST_REFUSAL, isTakenHost, isTakenOrigin, ORIGIN_REFUSAL } from './hosts-and-origins';
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
export { HOST_REFUSAL, ORIGIN_REFUSAL } from './hosts-and-origins';
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

/** The largest message by default: a router's largest envelope by default (spec 15.3). */
export const MAXIMUM_MESSAGE_BYTES = 16_778_240;

/** What an omitted start option resolves to. */
export const START_DEFAULTS = Object.freeze({
  address: '0.0.0.0',
  findOpenPort: false,
  port: 80,
} satisfies ITransportServerStartOptions);

// helpers

/** A header of `request` as one string: none when it is absent or given more than once. */
const headerOf = (request: IIncomingMessageLike, name: string): string | undefined => {
  const value = request.headers[name];

  return typeof value === 'string' ? value : undefined;
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
 * An upgrade is taken as the HTTP transport takes an exchange (spec 15.2, 15.12): one that names a
 * host not among `hosts`, or that carries an `Origin` neither the server's own nor among `origins`,
 * is refused 403 before its handshake, and one of a version but 13 is answered 426. Each message is an envelope at most by default,
 * {@link MAXIMUM_MESSAGE_BYTES}, and `ws` closes a connection that sends a larger one with 1009.
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

    // ! ws writes a body of its own on an upgrade it is told not to take, where the transport's
    // answer has none (spec 15.6): it is written here, and ws, told nothing, goes no further with
    // this upgrade
    const answer = (
      request: IIncomingMessageLike,
      { fields, status }: { fields: readonly string[]; status: string }
    ): void => {
      const { socket } = request;

      socket.once('finish', () => {
        socket.destroy();
      });
      socket.end(
        [
          `HTTP/1.1 ${status}`,
          `date: ${new Date(server.clock.Date.now()).toUTCString()}`,
          ...fields,
          'content-length: 0',
          'connection: close',
          '',
          '',
        ].join('\r\n')
      );
    };

    const refuse = (request: IIncomingMessageLike, refusal: string): void => {
      answer(request, {
        fields: [
          `bead-refusal: ${refusal}`,
          'cache-control: no-store',
          'x-content-type-options: nosniff',
        ],
        status: '403 Forbidden',
      });
    };

    // an upgrade of a version but 13, answered 426, naming the one version the transport speaks
    // (RFC 6455 §4.4)
    const answerVersion = (request: IIncomingMessageLike): void => {
      answer(request, { fields: ['sec-websocket-version: 13'], status: '426 Upgrade Required' });
    };

    // ! ws answers an upgrade it cannot read before `verifyClient`, a version but 8 or 13 among
    // them, and nothing once told of it: a WebSocket's of a version but 13 is answered 426 here, as
    // `verifyClient` answers version 8, and any other 405 or 400, as ws would
    const onClientError = (
      _error: Error,
      _socket: unknown,
      // oxlint-disable-next-line bead/options-last -- ws's own, a `wsClientError` listener's
      request: IIncomingMessageLike
    ): void => {
      if (
        /websocket/iu.test(headerOf(request, 'upgrade') ?? '') &&
        headerOf(request, 'sec-websocket-version') !== '13'
      ) {
        return (answerVersion(request), undefined);
      }

      return (
        answer(request, {
          fields: [],
          status: request.method === 'GET' ? '400 Bad Request' : '405 Method Not Allowed',
        }),
        undefined
      );
    };

    // an upgrade of version 13, from a host and an origin the transport takes, judged before its
    // handshake; ws takes version 8 as well, whose origin it reads from another field, and the
    // transport answers it 426
    const verifyClient = (
      { origin, req }: { origin: string | undefined; req: IIncomingMessageLike },
      verified: (isTaken: boolean) => void
    ): void => {
      const host = headerOf(req, 'host');

      if (headerOf(req, 'sec-websocket-version') !== '13') {
        return (answerVersion(req), undefined);
      }

      if (!isTakenHost(host, hosts)) {
        return (refuse(req, HOST_REFUSAL), undefined);
      }

      if (!isTakenOrigin(origin, { host, origins })) {
        return (refuse(req, ORIGIN_REFUSAL), undefined);
      }

      return (verified(true), undefined);
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
        const delivered = isBinary ? (data as Data) : decoder.decode(data as ArrayBufferView);

        return (
          server.emit(MESSAGE_EVENT, { credential: undefined, data: delivered }, connectionHandle),
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
      secure,
      type: TRANSPORT_WS,

      start: async ({ address, findOpenPort, port, signal }) => {
        let opened: IWebSocketServerLike | undefined;
        let isListening = false;

        try {
          return await createPromise<ITransportServerAddress>(
            (resolve, reject) => {
              const instance = new WebSocketServer({
                host: address,
                maxPayload,
                port: findOpenPort ? 0 : port,
                verifyClient,
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
              instance.on('wsClientError', onClientError);
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
  });
};
