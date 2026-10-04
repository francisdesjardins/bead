// ── WebSocket transport client ────────────────────────────────────────────────

// dependencies

import { CLOSE_EVENT, MESSAGE_EVENT, TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { ConnectError, ProgrammerError, ReadyStateError, wrapReason } from '../shared/errors';
import { assertHeartbeat, createHeartbeat, HEARTBEAT, type IHeartbeat } from '../shared/heartbeat';
import { noop } from '../shared/noop';
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
  IWebSocketConstructor,
  IWebSocketLike,
  IWSTransportClientConnectOptions,
  IWSTransportClientOptions,
  WSTransportClient,
} from './types';

// constants

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

// definition

/**
 * A transport client over one WebSocket. Over `ws`, it pings the server every `heartbeat`, and
 * closes when a ping went unanswered: a server gone without a word ends in a `close` rather than
 * never. A browser's socket cannot ping; the server's pings, which it answers, stand for it. A
 * WebSocket carries no credential beside an envelope: one given to `send` is not carried.
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
    WebSocket = globalThis.WebSocket,
  } = {
    ...DEFAULTS(),
    ...options,
  };
  const heartbeat = assertHeartbeat(givenHeartbeat);

  return createTransportClient<IWebSocketLike, IWSTransportClientConnectOptions>((client) => {
    // settle the connect or the disconnect in flight, so a socket dropped under either cannot leave
    // it pending, and the client with it
    let rejectConnect: ((reason: Error) => void) | undefined;
    // told whether a dispose dropped the socket, rather than its close handshake ending
    let resolveDisconnect: ((isDropped: boolean) => void) | undefined;
    // the open socket's, when it can ping
    let beating: IHeartbeat | undefined;

    // a drop closes as a network does, and the open socket's `onclose` reports it
    const beatOf = (socket: IWebSocketLike): IHeartbeat | undefined => {
      if (!('ping' in socket) || !('on' in socket) || !('terminate' in socket)) {
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
      clock,

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

        try {
          await createPromise(
            (resolve, reject) => {
              if (!client.isReconnecting()) {
                setReadyStateConnecting(client);
              }

              let socket: IWebSocketLike;

              try {
                socket = opened = client.socket = new WebSocket(url, protocols);
              } catch (reason) {
                return (reject(wrapReason(ConnectError, reason)), undefined);
              }

              let lastError: unknown;

              rejectConnect = reject;

              socket.binaryType = binaryType;

              socket.onerror = (event) => {
                lastError = errorOf(event);
              };
              socket.onclose = (closeEvent) => {
                const message = closeEvent.reason
                  ? `${closeEvent.reason} (${String(closeEvent.code)})`
                  : String(closeEvent.code);

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
                    client.emit(MESSAGE_EVENT, { credential: undefined, data: data as Data }),
                    undefined
                  );
                };

                socket.onclose = () => {
                  stopBeating();

                  if (!client.isReconnecting()) {
                    setReadyStateClosed(client);

                    client.emit(CLOSE_EVENT, false, false);
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
            return (reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN)), undefined);
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
          client.emit(CLOSE_EVENT, isClean, isQuick);
        }
      },

      // TODO a credential given here is not carried: the client fails a call that presents one its
      // transport cannot carry before it goes, DESTINATION_UNREACHABLE (decision 0010)
      send: ({ data }) => {
        return createPromise((resolve, reject) => {
          const { socket } = client;

          if (!client.isOpen() || socket === null) {
            return (reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN)), undefined);
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
  });
};
