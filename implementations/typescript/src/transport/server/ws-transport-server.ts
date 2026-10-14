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
import {
  assertHosts,
  assertListeningAddress,
  assertOrigins,
  credentialOf,
} from './hosts-and-origins';
import {
  createTransportServer,
  generateHandle,
  type ITransportServerBound,
  LOCALHOST,
  listenOn,
} from './transport-server';
import { clientAddressOf, trustedProxiesOf } from './trusted-proxies';
import type {
  IDrawingRequest,
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
  IDrawingRequest,
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
  address: LOCALHOST,
  findOpenPort: false,
  port: 80,
} satisfies ITransportServerStartOptions);

// helpers

// an HTTP server of the transport's, bound on one address, and its `WebSocketServer`: serving once
// it listens, until a stop, or a start that does not keep it, lets it go
interface IListener {
  readonly http: Server;
  readonly instance: IWebSocketServerLike;
  readonly stopServing: () => void;
}

// lets go of what a start opened: an HTTP server still binding its address is closed once it
// listens, since it closes nothing before then
const closeListener = (listener: IListener): void => {
  const { http, instance } = listener;

  listener.stopServing();
  instance.close();

  if (!http.listening) {
    http.once('listening', () => {
      http.close();
    });
  }

  http.close();
};

// the values of every line of the field `name` an upgrade carries, as they came: `headers` keeps
// the first of two, or joins them, so they are read where each stands
const linesOf = (request: IIncomingMessageLike, name: string): string[] => {
  const lines: string[] = [];
  const { rawHeaders } = request;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      lines.push(rawHeaders[index + 1] ?? '');
    }
  }

  return lines;
};

// an upgrade's `X-Forwarded-For`, every line of it joined by `, ` (RFC 9110 §5.3); none when it
// carries none
const forwardedOf = (request: IIncomingMessageLike): string | undefined => {
  const lines = linesOf(request, 'x-forwarded-for');

  return lines.length === 0 ? undefined : lines.join(', ');
};

// ! an upgrade that carries an `Origin` carries no credential: a page's browser writes its own
// authentication on it (Fetch, credentials mode `include`), as the server's JSDoc says
const upgradeCredentialOf = (request: IIncomingMessageLike): string | undefined => {
  return linesOf(request, 'origin').length > 0
    ? undefined
    : credentialOf(linesOf(request, 'authorization'));
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
 * An upgrade that carries no `Origin` carries one credential, its `Authorization`, as it came,
 * whole, its surrounding whitespace removed, none when empty or absent: every message of its
 * connection is delivered with it, which a request presenting `ELSEWHERE` stands for, resolved per
 * request as over HTTP (spec 15.2). An upgrade that carries an `Origin` carries none, whatever its
 * `Authorization`: a page's browser writes its own authentication on it, so a page presents a
 * `JWT`. A credential given to `send` is not carried: nothing is toward a client. A `connection`
 * listener is shown the upgrade headers aside, its method, its target and its peer.
 *
 * A request at its address is judged in the order of spec 15.2, `hosts` and `origins` among its
 * steps as the HTTP transport's (spec 15.12): 400 as HTTP answers it to a `Host` missing, repeated
 * or no host, or to an absolute-form target that names none; 403 to a host it does not take; 405 to
 * a method but `GET` or `HEAD`; 426 to a request that asks no WebSocket, and to a version but 13;
 * 400 to a malformed upgrade, two `Authorization` lines among it; 403 to an `Origin` neither its
 * own nor among `origins`; each refusal as {@link refusalOfHandshake} writes it. A connection, and
 * a refusal, name the client's address: behind the proxies `trustedProxies` names, the upgrade's
 * `X-Forwarded-For` entry reached past them, as the HTTP transport reads it (spec 15.12), else its
 * socket's. It listens on `localhost` by default, both loopbacks on one port. Each message is an
 * envelope at most by default, {@link MAXIMUM_MESSAGE_BYTES}, and `ws` closes a connection that
 * sends a larger one with 1009.
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
    trustedProxies,
    WebSocketServer,
  } = options;
  const heartbeat = assertHeartbeat(givenHeartbeat);
  const closeTimeout = assertHeld('a close timeout', givenCloseTimeout);
  assertHosts(hosts);
  assertOrigins(origins);
  const proxies = trustedProxiesOf(trustedProxies);
  const judged = { hosts, origins };

  const decoder = new TextDecoder();

  return createTransportServer<IServerSocketLike, IDrawingRequest>(
    (server, connections, { isHeard, tell }) => {
      // what the start under way, or the last, opened and keeps: one listener an address bound
      const listeners = new Set<IListener>();
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

      // the client's address: the socket's, in the one form, or, behind proxies the transport
      // trusts, the rightmost `X-Forwarded-For` entry of its upgrade none of them holds (spec 15.12)
      const addressOf = (request: IIncomingMessageLike): string | undefined => {
        const { remoteAddress } = request.socket;

        return remoteAddress === undefined
          ? undefined
          : clientAddressOf(remoteAddress, {
              forwarded: forwardedOf(request),
              trustedProxies: proxies,
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
        const { remotePort } = request.socket;
        const refusal =
          reason === undefined || !isHeard(REFUSAL_EVENT)
            ? undefined
            : {
                address: addressOf(request),
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
        const address = addressOf(request);
        const { remotePort } = request.socket;
        // read once, and handed beside every envelope of the connection (spec 15.2)
        const credential = upgradeCredentialOf(request);

        // a socket gone has no peer to name, and its close is on its way
        if (address === undefined || remotePort === undefined) {
          return (socket.terminate(), undefined);
        }

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
            tell(MESSAGE_EVENT, [{ credential, data: delivered }, connectionHandle]), undefined
          );
        });

        // ! a stop that began as this registered closes it with its own, going away: its snapshot of
        // the connections was taken already, or its registry cleared; reached only by an injected
        // `WebSocketServer` that delivers a connection after its `close()`, since ws takes none then
        if (server.isClosing() || server.isClosed()) {
          void closeSocket(socket, 1001); // going away
        }

        // last and synchronous: a listener meets a connection already registered and wired, and before
        // any frame that arrived with the upgrade request is read; it is shown the upgrade headers
        // aside, a frozen copy, so no event carries its credential (spec 15.1)
        const upgrade: IDrawingRequest = Object.freeze({
          method: request.method,
          remoteAddress: address,
          remotePort,
          url: request.url,
        });

        tell(CONNECTION_EVENT, [socket, upgrade, connectionHandle]);
      };

      return {
        clock,
        defaults: START_DEFAULTS,
        secure,
        type: TRANSPORT_WS,

        start: async ({ address, findOpenPort, port, signal }) => {
          assertListeningAddress(address);

          // one address and port: an HTTP server of its own, which ws forwards `listening` and
          // `error` of, serving until it is let go
          const bind = (host: string, given: number): Promise<ITransportServerBound> => {
            return createPromise((resolve, reject) => {
              let isServing = false;
              // a head is judged by its own server: one that ends after it was let go is refused
              const { onRequest, shouldUpgradeCallback } = answersOf(() => {
                return !isServing;
              });
              const http = createServer({ shouldUpgradeCallback }, onRequest);
              const listener: IListener = {
                http,
                instance: new WebSocketServer({ maxPayload, server: http }),
                stopServing: () => {
                  isServing = false;
                },
              };
              const { instance } = listener;
              let isListening = false;

              const release = (): void => {
                listeners.delete(listener);
                closeListener(listener);
              };

              listeners.add(listener);
              http.on('connect', onConnect);

              instance.on(ERROR_EVENT, (error) => {
                if (isListening) {
                  return (server.emit(ERROR_EVENT, error, ''), undefined);
                }

                release();

                return (reject(error), undefined);
              });

              instance.on('listening', () => {
                const addressInfo = instance.address();

                isListening = true;
                // a start given up meanwhile let it go already
                isServing = listeners.has(listener);

                resolve({
                  close: release,
                  port:
                    typeof addressInfo === 'object' && addressInfo !== null
                      ? addressInfo.port
                      : port,
                });
              });

              instance.on(CONNECTION_EVENT, onConnection);
              instance.on('wsClientError', onClientError);
              http.listen(given, host);
            });
          };

          try {
            return await createPromise<ITransportServerAddress>(
              (resolve, reject) => {
                listenOn(bind, { address, findOpenPort, port, signal }).then(resolve, reject);
              },
              { signal }
            );
          } catch (reason) {
            // an error before listening, or an abort: close what was opened, listening or not, and
            // once it listens when its address is still being bound
            for (const listener of listeners) {
              closeListener(listener);
            }

            listeners.clear();

            throw reason;
          }
        },

        stop: async () => {
          const stopped = [...listeners];

          listeners.clear();

          // first, so no connection arrives while the open ones are closing; the port is free once it
          // returns, and its callback is not awaited because it also waits on peers that never
          // upgraded; ws leaves open the server it was given
          for (const { http, instance, stopServing } of stopped) {
            stopServing();
            instance.close();
            http.close();
            http.closeIdleConnections();
          }

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

        // a credential given here is not carried: nothing is toward a client, and the router fails a
        // command that presents one before it goes, DESTINATION_UNREACHABLE (decision 0032)
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
