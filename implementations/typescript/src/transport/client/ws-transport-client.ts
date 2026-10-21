// ── WebSocket transport client ────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  CLOSE_TIMEOUT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REFUSAL_HEADER,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  WS_ERROR_CODE_PREFIX,
  WS_TOO_BIG_CODE,
} from '../shared/constants';
import { assertHeld, LONGEST_TIMER } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import {
  ConnectError,
  ProgrammerError,
  ReadyStateError,
  tooBigOf,
  wrapReason,
} from '../shared/errors';
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
import {
  createTransportClient,
  DEFAULTS,
  DISCONNECT_DEFAULTS,
  isFieldValue,
} from './transport-client';
import type {
  IUpgradeResponseLike,
  IWebSocketConstructor,
  IWebSocketLike,
  IWSTransportClientConnectOptions,
  IWSTransportClientOptions,
  WSTransportClient,
} from './types';

export { CLOSE_TIMEOUT, TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
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

/**
 * Whether an error fails the connection of this side's own: one `ws` codes, a protocol error or a
 * message past its bound, as its receiver emits them. Its sender's own, a socket's and the global
 * `WebSocket`'s carry no such code.
 */
const isOwnFailure = (error: unknown): error is Error & { code: string } => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  return typeof error.code === 'string' && error.code.startsWith(WS_ERROR_CODE_PREFIX);
};

/**
 * Whether `presented` is the credential `carried`, compared in constant time (spec 15.1): every
 * character of `carried` is read, wherever the two differ, so time tells at most its length.
 */
const isCarried = (presented: string, carried: string): boolean => {
  let difference = presented.length ^ carried.length;

  for (let index = 0; index < carried.length; index += 1) {
    // ! past the end of `presented`, NaN reads as 0, and its length already differs
    difference |= presented.charCodeAt(index) ^ carried.charCodeAt(index);
  }

  return difference === 0;
};

/**
 * Whether a `WebSocket` constructor has `ws`'s shape, the one that writes a field of its caller's
 * choosing on its upgrade: its sockets ping, terminate and listen by `on`, as a heartbeat reads a
 * socket. A page's, a wrapper or a subclass of it, and Node's global have none of it.
 */
const isWsShaped = (WebSocket: IWebSocketConstructor): boolean => {
  const prototype = (WebSocket as { prototype?: Partial<IWebSocketLike> }).prototype;

  return (
    typeof prototype?.ping === 'function' &&
    typeof prototype.terminate === 'function' &&
    typeof prototype.on === 'function'
  );
};

/** The URL a connect reaches, an IPv6 literal bracketed, or its colons would read as the port's. */
const urlOf = ({
  host,
  pathname = CONNECT_DEFAULTS.pathname,
  port,
  secured = CONNECT_DEFAULTS.secured,
}: IWSTransportClientConnectOptions): string => {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `${secured ? 'wss' : 'ws'}://${authority}:${String(port)}${pathname.replace(/^\/?(.*)/, '/$1')}`;
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
 * never. A browser's socket cannot ping; the server's pings, which it answers, stand for it. Its
 * connect's `credential`, or what its `credentialProvider` hands at each attempt, goes in its
 * upgrade's `Authorization`, over `ws` alone, and is what it carries beside every envelope of that
 * connection, compared in constant time: one given to `send` is not carried, and its router fails a
 * call presenting an `ELSEWHERE` it does not carry before it goes (spec 15.2). It follows no
 * redirect: a 3xx answered to its upgrade fails its connect, its status named (spec 15.6). It is
 * secure under `wss`, or to a loopback host. Over `ws`, a message is an envelope at most by default,
 * {@link MAXIMUM_MESSAGE_BYTES}, and a larger one closes the connection with 1009; over the global
 * `WebSocket`, its platform's bound applies. Over `ws`, each close it begins — its `disconnect`'s,
 * a dispose's, its 1009 — waits on the server's answer `closeTimeout` at most, which `ws` is given,
 * then drops the socket; over the global `WebSocket`, its platform bounds its close. Over `ws`, an
 * upgrade refused fails the connect with its status and its reason, "the server refused the
 * upgrade: 403 host-refused"; the global `WebSocket` reads nothing of it, as the WHATWG WebSockets
 * Standard has a page's, and names its close alone, 1006.
 *
 * Once open, over `ws`, `error` tells what this side fails its connection for of its own (spec
 * 15.1): a protocol error, `ws`'s own error, or a message past `maxPayload`, a
 * `GenericError` "the connection is closed with 1009: a message past its maximumMessageBytes,
 * N bytes" keeping `ws`'s error as its `cause`; each once, as the connection ends, before its
 * unclean `close`, so a listener that throws keeps the close told. A server gone without its
 * closing handshake, its heartbeat's drop, and `ws`'s own drop past `closeTimeout` tell their
 * `close` alone; so does every unclean close over the global `WebSocket`, whose bare `error` cannot
 * be told from a drop.
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
    closeTimeout: givenCloseTimeout = CLOSE_TIMEOUT,
    heartbeat: givenHeartbeat = HEARTBEAT,
    maxPayload = MAXIMUM_MESSAGE_BYTES,
    WebSocket = globalThis.WebSocket,
  } = {
    ...DEFAULTS(),
    ...options,
  };
  const heartbeat = assertHeartbeat(givenHeartbeat);
  const closeTimeout = assertHeld('a close timeout', givenCloseTimeout);

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
      // the credential the upgrade of the current connection carried; none before it opens
      let carried: string | undefined;

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
        clock,
        get isSecure() {
          return isSecure;
        },

        // * a credential crosses the upgrade, so one the upgrade cannot carry as given is refused
        // before anything moves
        assertConnect: (connectOptions) => {
          const { credential, credentialProvider } = connectOptions;

          if (credential === undefined && credentialProvider === undefined) {
            return;
          }

          if (credential !== undefined && credentialProvider !== undefined) {
            throw new ProgrammerError(
              'a connect takes a credential or a credential provider, not both'
            );
          }

          if (credential !== undefined && !isFieldValue(credential)) {
            throw new ProgrammerError(
              'a credential holds visible ASCII, spaces and tabs alone, none first or last'
            );
          }

          if (!isSecureUrl(urlOf({ ...CONNECT_DEFAULTS, ...connectOptions }))) {
            throw new ProgrammerError(
              'a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback'
            );
          }

          if (!isWsShaped(WebSocket)) {
            throw new ProgrammerError(
              "a credential is written on its upgrade by ws's WebSocket alone: a page's, and Node's global, write no field of their caller's choosing, so present a JWT in the envelope"
            );
          }
        },

        // none once its connection is gone, whatever it carried
        carries: (credential) => {
          return client.isOpen() && carried !== undefined && isCarried(credential, carried);
        },

        connect: async (connectOptions) => {
          const {
            credential,
            credentialProvider,
            protocols,
            signal,
            timeout = CONNECT_DEFAULTS.timeout,
          } = { ...CONNECT_DEFAULTS, ...connectOptions };
          const url = urlOf({ ...CONNECT_DEFAULTS, ...connectOptions });
          // what the attempt's credential provider is told to give up by: the attempt settled
          const attempt = new AbortController();
          let opened: IWebSocketLike | undefined;

          isSecure = isSecureUrl(url);
          carried = undefined;

          try {
            await createPromise(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                rejectConnect = reject;

                // ! no `followRedirects`: a 3xx answered to the upgrade fails it, its status named,
                // since a redirect would carry it where its credential and its security were not
                // judged (spec 15.6); an empty credential is none, as the server reads an empty field
                const open = (given: string | undefined): void => {
                  const written = given === '' ? undefined : given;
                  let socket: IWebSocketLike;

                  // ! `closeTimeout`, `ws`'s own close timer, which it arms on every close, its
                  // 1009 among them: the transport's, so a server that never answers is dropped
                  // after one bound; for `Infinity`, the longest a timer holds, which Node would
                  // take for 1 ms
                  try {
                    socket =
                      opened =
                      client.socket =
                        new WebSocket(url, protocols, {
                          closeTimeout: closeTimeout === Infinity ? LONGEST_TIMER : closeTimeout,
                          maxPayload,
                          ...(written === undefined ? {} : { headers: { authorization: written } }),
                        });
                  } catch (reason) {
                    return (reject(wrapReason(ConnectError, reason)), undefined);
                  }

                  let lastError: unknown;
                  // the status and the mark of an upgrade the server refused, where it can be read
                  let refused: string | undefined;

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
                    // * what this side fails the connection for of its own, `ws`'s alone: a protocol
                    // error, or a message past `maxPayload`, told by the bound and its value; a drop
                    // emits none, and the global `WebSocket`'s bare `error` cannot be told from one
                    // (spec 15.1)
                    let failure: Error | undefined;

                    socket.onerror = (event) => {
                      const error = errorOf(event);

                      if (failure === undefined && isOwnFailure(error)) {
                        failure =
                          error.code === WS_TOO_BIG_CODE
                            ? tooBigOf('the connection', {
                                cause: error,
                                maximumMessageBytes: maxPayload,
                              })
                            : error;
                      }
                    };
                    socket.onmessage = ({ data }) => {
                      if (client.isClosing()) {
                        return undefined;
                      }

                      return (
                        tell(MESSAGE_EVENT, [{ credential: undefined, data: data as Data }]),
                        undefined
                      );
                    };

                    // * its end: its one error, then its close, told even when a listener of
                    // `error` throws, which is Node's or the page's (spec 15.1)
                    socket.onclose = () => {
                      stopBeating();

                      if (!client.isReconnecting()) {
                        setReadyStateClosed(client);

                        try {
                          if (failure !== undefined) {
                            client.emit(ERROR_EVENT, failure);
                          }
                        } finally {
                          tell(CLOSE_EVENT, [false, false]);
                        }
                      }
                    };

                    beating = beatOf(socket);
                    carried = written;
                    resolve();
                  };

                  return undefined;
                };

                if (credentialProvider === undefined) {
                  return (open(credential), undefined);
                }

                // called at each attempt, before its upgrade goes: what it hands is written once
                // held, what it throws fails the attempt, its cause
                Promise.resolve()
                  .then(() => {
                    return credentialProvider({ signal: attempt.signal });
                  })
                  .then(
                    (provided) => {
                      if (attempt.signal.aborted) {
                        return;
                      }

                      if (typeof provided !== 'string' || !isFieldValue(provided)) {
                        reject(
                          new ProgrammerError(
                            'a credential holds visible ASCII, spaces and tabs alone, none first or last'
                          )
                        );

                        return;
                      }

                      open(provided);
                    },
                    (reason: unknown) => {
                      reject(new ConnectError('the credential provider failed', { cause: reason }));
                    }
                  );

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
            attempt.abort();
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

        // a credential given here is not carried: its upgrade's is, and the client fails a call
        // that presents another before it goes, DESTINATION_UNREACHABLE (decision 0032)
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
