// ── WebSocket transport client ────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  MESSAGE_EVENT,
  REFUSAL_HEADER,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
} from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { ConnectError, ProgrammerError, ReadyStateError, wrapReason } from '../shared/errors';
import { assertHeartbeat, createHeartbeat, HEARTBEAT, type IHeartbeat } from '../shared/heartbeat';
import { noop } from '../shared/noop';
import { isSecureUrl } from '../shared/secure';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import type { Data } from '../shared/types';
import { dispose } from './symbols';
import { createTransportClient, DEFAULTS, DISCONNECT_DEFAULTS } from './transport-client';
import type {
  IUpgradeResponseLike,
  IWebSocketLike,
  IWSTransportClientConnectOptions,
  IWSTransportClientOptions,
  WSTransportClient,
} from './types';

export { TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
export { HEARTBEAT } from '../shared/heartbeat';
export type {
  ICloseEventLike,
  IMessageEventLike,
  IUpgradeResponseLike,
  IWebSocketConstructor,
  IWebSocketLike,
  IWSTransportClientConnectOptions,
  IWSTransportClientOptions,
  WSTransportClient,
} from './types';

// constants

/** The largest message by default: a router's largest envelope by default (spec 15.3). */
export const MAXIMUM_MESSAGE_BYTES = 16_778_240;

/** What an omitted connect option resolves to. */
export const CONNECT_DEFAULTS = Object.freeze({
  host: 'localhost',
  pathname: '',
  port: 80,
  secured: false,
  timeout: 30_000,
} satisfies IWSTransportClientConnectOptions);

// helpers

/** The error an `error` event carries, when the implementation gives one. */
const errorOf = (event: unknown): unknown => {
  return typeof event === 'object' && event !== null && 'error' in event ? event.error : undefined;
};

/** A refused upgrade's status, and the reason it was marked with when it was (spec 15.6). */
const refusalOf = ({ headers, statusCode }: IUpgradeResponseLike): string => {
  const mark = headers[REFUSAL_HEADER];
  const reason = Array.isArray(mark) ? mark[0] : mark;

  return reason === undefined ? String(statusCode) : `${String(statusCode)} ${reason}`;
};

// definition

/**
 * A transport client over one WebSocket. Over `ws`, it pings the server every `heartbeat`, and
 * closes when a ping went unanswered: a server gone without a word ends in a `close` rather than
 * never. A browser's socket cannot ping; the server's pings, which it answers, stand for it. A
 * WebSocket carries no credential beside an envelope: one given to `send` is not carried, and its
 * router fails a call that presents an `ELSEWHERE` before it goes. It is secure under `wss`, or to a
 * loopback host. Over `ws`, a message is an envelope at most by default,
 * {@link MAXIMUM_MESSAGE_BYTES}, and a larger one closes the connection with 1009; over the global
 * `WebSocket`, its platform's bound applies. Over `ws`, an upgrade refused fails the connect with
 * its status and its reason, "the server refused the upgrade: 403 host-refused"; the global
 * `WebSocket` reads nothing of it, as the WHATWG WebSockets Standard has a page's, and names its
 * close alone, 1006.
 *
 * @example
 * const client = createWSTransportClient();
 * client.on('message', ({ data }) => {});
 * await client.connect({ host, port });
 * await client.send({ data: 'hello' });
 * await client.disconnect();
 */
export const createWSTransportClient = (options?: IWSTransportClientOptions): WSTransportClient => {
  const {
    binaryType = TRANSPORT_WEBSOCKET_BINARYTYPE,
    clock,
    heartbeat: givenHeartbeat = HEARTBEAT,
    maxPayload = MAXIMUM_MESSAGE_BYTES,
    WebSocket = globalThis.WebSocket,
  } = {
    ...DEFAULTS(),
    ...options,
  };
  const heartbeat = assertHeartbeat(givenHeartbeat);

  return createTransportClient<IWebSocketLike, IWSTransportClientConnectOptions>(
    (client, { tell }) => {
      // settle the connect or the disconnect in flight, so a socket dropped under either cannot leave
      // it pending, and the client with it
      let rejectConnect: ((reason: Error) => void) | undefined;
      // told whether a dispose dropped the socket, rather than its close handshake ending
      let resolveDisconnect: ((isDropped: boolean) => void) | undefined;
      // the open socket's, when it can ping
      let beating: IHeartbeat | undefined;
      // whether the URL of the last connect is secure
      let isSecure = false;

      // a drop closes as a network does, and the open socket's `onclose` reports it
      const beatOf = (socket: IWebSocketLike): IHeartbeat | undefined => {
        if (
          socket.ping === undefined ||
          socket.on === undefined ||
          socket.terminate === undefined
        ) {
          return undefined;
        }

        const beats = createHeartbeat(heartbeat, {
          drop: () => {
            socket.terminate?.();
          },
          ping: () => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.ping?.();
            }
          },
        });

        socket.on('pong', () => {
          beats.answer();
        });

        return beats;
      };

      const stopBeating = (): void => {
        beating?.stop();
        beating = undefined;
      };

      return {
        carriesCredential: false,
        clock,
        get isSecure() {
          return isSecure;
        },

        connect: async (connectOptions) => {
          const {
            host,
            pathname = CONNECT_DEFAULTS.pathname,
            port,
            protocols,
            secured = CONNECT_DEFAULTS.secured,
            signal,
            timeout = CONNECT_DEFAULTS.timeout,
          } = { ...CONNECT_DEFAULTS, ...connectOptions };

          // an IPv6 literal is bracketed, or its colons would read as the port's
          const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
          const url = `${secured ? 'wss' : 'ws'}://${authority}:${String(port)}${pathname.replace(/^\/?(.*)/, '/$1')}`;
          let opened: IWebSocketLike | undefined;

          isSecure = isSecureUrl(url);

          try {
            await createPromise(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                let socket: IWebSocketLike;

                try {
                  socket = opened = client.socket = new WebSocket(url, protocols, { maxPayload });
                } catch (reason) {
                  return (reject(wrapReason(ConnectError, reason)), undefined);
                }

                let lastError: unknown;
                // the status and the mark of an upgrade the server refused, where it can be read
                let refused: string | undefined;

                rejectConnect = reject;

                // ! ended by `terminate`: a request destroyed leaves the socket connecting for ever
                socket.on?.('unexpected-response', (_request, response) => {
                  refused = refusalOf(response);
                  response.resume?.();
                  socket.terminate?.();
                });

                socket.binaryType = binaryType;

                socket.onerror = (event) => {
                  lastError = errorOf(event);
                };
                socket.onclose = (closeEvent) => {
                  const closed = closeEvent.reason
                    ? `${closeEvent.reason} (${String(closeEvent.code)})`
                    : String(closeEvent.code);
                  const message =
                    refused === undefined ? closed : `the server refused the upgrade: ${refused}`;

                  reject(
                    new ConnectError(
                      message,
                      lastError === undefined ? undefined : { cause: lastError }
                    )
                  );
                };
                socket.onopen = () => {
                  // an error is always followed by its close, and once open the close is what reports it
                  socket.onerror = noop;
                  socket.onmessage = ({ data }) => {
                    if (client.isClosing()) {
                      return undefined;
                    }

                    return (
                      tell(MESSAGE_EVENT, [{ credential: undefined, data: data as Data }]),
                      undefined
                    );
                  };

                  socket.onclose = () => {
                    stopBeating();

                    if (!client.isReconnecting()) {
                      setReadyStateClosed(client);

                      tell(CLOSE_EVENT, [false, false]);
                    }
                  };

                  beating = beatOf(socket);
                  resolve();
                };

                return undefined;
              },
              { clock: client.clock, signal, timeout }
            );

            // a close or a dispose between the open and here comes after it: what it left is kept
            if (client.socket !== opened || opened.readyState !== WebSocket.OPEN) {
              throw new ConnectError('closed as it opened');
            }
          } catch (reason) {
            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            // a ConnectError means the socket closed or never existed; anything else leaves one behind
            if (!(reason instanceof ConnectError)) {
              client[dispose]();
            }

            throw reason;
          } finally {
            rejectConnect = undefined;
          }

          setReadyStateOpen(client);
        },

        disconnect: async (disconnectOptions) => {
          const { isClean = DISCONNECT_DEFAULTS.isClean, isQuick = DISCONNECT_DEFAULTS.isQuick } =
            disconnectOptions ?? {};

          // this call's own resolver, so that only this call clears the shared one
          let ownResolve: ((isDropped: boolean) => void) | undefined;

          const closing = createPromise<boolean>((resolve, reject) => {
            const { socket } = client;

            if (!client.isOpen() || socket === null) {
              return (
                reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN)), undefined
              );
            }

            setReadyStateClosing(client);
            stopBeating();

            if (isQuick) {
              client[dispose]();

              return (resolve(false), undefined);
            }

            resolveDisconnect = ownResolve = resolve;

            socket.onerror = noop;
            socket.onclose = () => {
              resolve(false);
            };

            try {
              socket.close(1000); // @see https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
            } catch (reason) {
              return (reject(wrapReason(ProgrammerError, reason)), undefined);
            }

            return undefined;
          }).finally(() => {
            // a second disconnect, rejected because this one is under way, must not orphan this one
            if (resolveDisconnect === ownResolve) {
              resolveDisconnect = undefined;
            }
          });

          let isDropped: boolean;

          try {
            isDropped = await closing;
          } catch (reason) {
            // a close that throws leaves a socket nothing can close: it is dropped as `[dispose]`
            // drops one, without a `close`, and the client ends CLOSED rather than stuck CLOSING
            if (reason instanceof ProgrammerError) {
              client[dispose]();
              setReadyStateClosed(client);
            }

            throw reason;
          }

          setReadyStateClosed(client);

          // a dispose dropped the socket meanwhile, without a handshake: it tells no `close`, as a
          // dispose never does
          if (!isDropped) {
            tell(CLOSE_EVENT, [isClean, isQuick]);
          }
        },

        // a credential given here is not carried: the client fails a call that presents one its
        // transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
        send: ({ data }) => {
          return createPromise((resolve, reject) => {
            const { socket } = client;

            if (!client.isOpen() || socket === null) {
              return (
                reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN)), undefined
              );
            }

            socket.send(data);

            return (resolve(), undefined);
          });
        },

        [dispose]: () => {
          const { socket } = client;

          rejectConnect?.(new ConnectError('disposed while connecting'));
          resolveDisconnect?.(true);
          stopBeating();

          if (socket === null) {
            return;
          }

          // parked on `noop` rather than `null`: `ws` emits `error` when a connecting socket is aborted,
          // and an `error` nobody listens to throws
          socket.onerror = noop;
          socket.onclose = noop;
          socket.onmessage = noop;
          socket.onopen = noop;

          // a connecting socket is aborted rather than left to open; `close()` ends the handshake on
          // both implementations
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
            try {
              socket.close();
            } catch {
              /* a close that throws changes nothing: the socket is dropped below either way */
            }
          }

          client.socket = null;
        },
      };
    }
  );
};
