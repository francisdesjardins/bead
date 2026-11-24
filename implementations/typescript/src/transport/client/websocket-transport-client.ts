// ── WebSocket transport client ────────────────────────────────────────────────

// dependencies

import {
  CLOSE_EVENT,
  CLOSE_TIMEOUT,
  MESSAGE_EVENT,
  REFUSAL_HEADER,
  TRANSPORT_WEBSOCKET_BINARYTYPE,
  WS_ERROR_CODE_PREFIX,
  WS_TOO_BIG_CODE,
  WS_LARGEST_COUNT,
  WS_TOO_MANY_FRAMES_CODE,
  WS_TOO_MANY_FRAMES_MESSAGE,
} from '../shared/constants';
import { assertHeld, LONGEST_TIMER } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import {
  closedWithOf,
  ConnectError,
  ProgrammerError,
  notOpenOf,
  ReadyStateError,
  toError,
  tooBigOf,
  wrapReason,
} from '../shared/errors';
import { assertHeartbeat, createHeartbeat, HEARTBEAT, type IHeartbeat } from '../shared/heartbeat';
import { bytesOf, createSendQueue, type ISendQueue } from '../shared/send-queue';
import { createHold } from '../shared/hold';
import { noop } from '../shared/noop';
import {
  createUndiciDialer,
  isConnectFailure,
  isLocalhostName,
  type IUndiciDrawn,
  loopbackCreateConnection,
  loopbackSentenceOf,
  watchedOf,
} from '../shared/loopback';
import { isLoopbackUrl, isSecureUrl, urlHostOf } from '../shared/secure';
import { assertTls, isNode, NO_TLS_IN_A_PAGE, nodeTlsOf, tlsOf } from '../shared/tls';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import type { Data, ITlsOptions, ITransportMessage } from '../shared/types';
import { assertCount, MAXIMUM_MESSAGE_FRAMES } from '../server/server-bounds';
import { dispose } from './symbols';
import {
  createTransportClient,
  DEFAULTS,
  DISCONNECT_DEFAULTS,
  isFieldValue,
} from './transport-client';
import type {
  IRawSocketLike,
  IUpgradeResponseLike,
  IWebSocketConstructor,
  IWebSocketLike,
  IWebSocketTransportClientConnectOptions,
  IWebSocketTransportClientOptions,
  WebSocketTransportClient,
} from './types';

export { CLOSE_TIMEOUT, TRANSPORT_WEBSOCKET_BINARYTYPE } from '../shared/constants';
export { HEARTBEAT } from '../shared/heartbeat';
export type { ITlsOptions } from '../shared/types';
export { MAXIMUM_MESSAGE_FRAMES } from '../server/server-bounds';
export type {
  ICloseEventLike,
  IMessageEventLike,
  IRawSocketLike,
  IUpgradeResponseLike,
  IWebSocketConstructor,
  IWebSocketLike,
  IWebSocketTransportClientConnectOptions,
  IWebSocketTransportClientOptions,
  WebSocketTransportClient,
} from './types';

// constants

/** The largest message by default: a router's largest envelope by default (spec 15.3). */
export const MAXIMUM_MESSAGE_BYTES = 16_778_240;

/** What an omitted connect option resolves to. */
export const CONNECT_DEFAULTS = Object.freeze({
  pathname: '/',
  secured: false,
  timeout: 30_000,
} satisfies Omit<IWebSocketTransportClientConnectOptions, 'host' | 'port'>);

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

/**
 * Holds `tls` as its client is built (spec 15.39), in the order every side holds it: in a page;
 * beside a `WebSocket` without `ws`'s shape, which keeps a TLS of its own; then as
 * {@link assertTls} does.
 */
const assertWebSocketTls = (WebSocket: IWebSocketConstructor, tls: ITlsOptions): void => {
  if (!isNode()) {
    throw new ProgrammerError(NO_TLS_IN_A_PAGE);
  }

  if (!isWsShaped(WebSocket)) {
    throw new ProgrammerError(
      "tls is refused beside a WebSocket without ws's shape, which keeps a TLS of its own"
    );
  }

  assertTls(tls);
};

/** The URL a connect reaches, an IPv6 literal bracketed, or its colons would read as the port's. */
const urlOf = ({
  host,
  pathname = CONNECT_DEFAULTS.pathname,
  port,
  secured = CONNECT_DEFAULTS.secured,
}: IWebSocketTransportClientConnectOptions): string => {
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
 * A transport client over one WebSocket. Over `ws`, it pings the server once nothing of it has been
 * read for `heartbeat`, its ping ahead of what it holds unsent, and closes once the pong that echoes
 * that ping has not come within `heartbeat` (spec 15.3): a server gone without a word ends in a
 * `close` rather than never. A browser's socket cannot ping; the server's pings, which it answers,
 * stand for it. Its
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
 * Standard has a page's, and names its close alone, 1006. Its connect resolves once its upgrade is
 * answered with a 101 (RFC 6455 §4.1): what its server wrote after it, a close among it, is heard
 * after the connect.
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
 * Paused by its router, over `ws`, it reads no more of its socket, and holds in order what `ws`
 * still emits of the read under way, one socket read at most; resumed, it hands that on from a
 * microtask and reads its socket once nothing is held. The global `WebSocket` has no pause and
 * hands one message a task, which its router's count never pauses: paused all the same, it holds
 * what comes. A close it begins reads on to its server's Close, what it held dropped (spec 15.12).
 *
 * @example
 * const client = createWebSocketTransportClient();
 * client.on('message', ({ data }) => {});
 * await client.connect({ host, port });
 * await client.send({ data: 'hello' });
 * await client.disconnect();
 */
export const createWebSocketTransportClient = (
  options?: IWebSocketTransportClientOptions
): WebSocketTransportClient => {
  const {
    binaryType = TRANSPORT_WEBSOCKET_BINARYTYPE,
    clock,
    closeTimeout: givenCloseTimeout = CLOSE_TIMEOUT,
    heartbeat: givenHeartbeat = HEARTBEAT,
    maxPayload = MAXIMUM_MESSAGE_BYTES,
    maximumMessageFrames = MAXIMUM_MESSAGE_FRAMES,
    WebSocket = globalThis.WebSocket,
  } = {
    ...DEFAULTS(),
    ...options,
  };
  const heartbeat = assertHeartbeat(givenHeartbeat);

  // ! never without end: `ws` reads a `maxFragments` of 0 as none
  assertCount('maximumMessageFrames', { value: maximumMessageFrames });
  const closeTimeout = assertHeld('a close timeout', givenCloseTimeout);
  const tls = tlsOf(options?.tls);

  if (tls !== undefined) {
    assertWebSocketTls(WebSocket, tls);
  }

  // * given to `ws` under `wss` alone: in the clear, `tls` is held unused
  const nodeTls = nodeTlsOf(tls);
  // * in Node, no WebSocket given: a host on the loopback through undici's own WebSocket and the
  // client's agent (spec 13.4), or the global one where undici does not resolve
  const isDefault = options?.WebSocket === undefined;
  const dialer = createUndiciDialer({});

  return createTransportClient<IWebSocketLike, IWebSocketTransportClientConnectOptions>(
    (client, { report, tell }) => {
      // settle the connect or the disconnect in flight, so a socket dropped under either cannot leave
      // it pending, and the client with it
      let rejectConnect: ((reason: Error) => void) | undefined;
      // told whether a dispose dropped the socket, rather than its close handshake ending
      let resolveDisconnect: ((isDropped: boolean) => void) | undefined;
      // the open socket's, when it can ping, and what it holds that its socket was not handed yet,
      // so its ping goes ahead of it (spec 15.3)
      let beating: IHeartbeat | undefined;
      let queue: ISendQueue | undefined;
      // whether the URL of the last connect is secure
      let isSecure = false;
      // the credential the upgrade of the current connection carried; none before it opens
      let carried: string | undefined;
      // one call per provider identity; an earlier attempt's outcome serves none after it
      const pendingCredentials = new WeakMap<
        NonNullable<IWebSocketTransportClientConnectOptions['credentialProvider']>,
        Set<() => void>
      >();

      // * what its socket still brought once its router paused it, one read of `ws`'s at most, its
      // socket paused until it is handed on; a global WebSocket, which has no pause, hands one
      // message a task, which its router's count never pauses (spec 15.12, decision 0046)
      const hold = createHold(
        (message: ITransportMessage) => {
          if (!client.isClosing()) {
            tell(MESSAGE_EVENT, [message]);
          }
        },
        {
          onReleased: () => {
            client.socket?.resume?.();
          },
        }
      );

      // a drop closes as a network does, and the open socket's `onclose` reports it; one that throws
      // is handed to `thrown`, which ends the connection. What it reads is each read of `raw`, its
      // raw socket, a frame's part among it; without one, each message and pong its socket emits
      const beatOf = (
        { raw, socket }: { raw: IRawSocketLike | undefined; socket: IWebSocketLike },
        thrown: (reason: unknown) => void
      ): IHeartbeat | undefined => {
        if (
          socket.ping === undefined ||
          socket.on === undefined ||
          socket.terminate === undefined
        ) {
          return undefined;
        }

        const beats = createHeartbeat(heartbeat, {
          drop: () => {
            try {
              socket.terminate?.();
            } catch (reason) {
              thrown(reason);
            }
          },
          // at once, ahead of what the queue holds
          ping: (data) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.ping?.(data);
            }
          },
        });

        raw?.on?.('data', () => {
          beats.heard();
        });
        socket.on('pong', (data) => {
          beats.answer(data);
        });

        return beats;
      };

      const stopBeating = (): void => {
        beating?.stop();
        beating = undefined;
      };
      // what the queue holds goes ahead of a close, or is dropped with its socket
      const flushQueue = (): void => {
        queue?.flush();
        queue = undefined;
      };
      const dropQueue = (): void => {
        queue?.clear();
        queue = undefined;
      };

      return {
        clock,
        get isSecure() {
          return isSecure;
        },

        // * a credential crosses the upgrade, so one the upgrade cannot carry as given is refused
        // before anything moves
        assertConnect: (connectOptions) => {
          const { credential, credentialProvider, host, port } = connectOptions;

          // what its type requires, and a caller in JavaScript may still leave out
          if (typeof host !== 'string' || typeof port !== 'number') {
            throw new ProgrammerError('a connect names the host and the port it reaches');
          }

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

          const url = urlOf({ ...CONNECT_DEFAULTS, ...connectOptions });

          // * a host no URL can name is its connect's to refuse, before any socket opens
          if (urlHostOf(url) !== undefined && !isSecureUrl(url)) {
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
            host,
            protocols,
            signal,
            timeout = CONNECT_DEFAULTS.timeout,
          } = { ...CONNECT_DEFAULTS, ...connectOptions };
          const url = urlOf({ ...CONNECT_DEFAULTS, ...connectOptions });
          const isThroughUndici = isDefault && isNode() && isLoopbackUrl(url);
          // * what bounds a localhost name's race below `ws`, which hands it no signal and no
          // timeout: this connect's deadline, and its signal or the attempt's end, whichever first
          const deadline = client.clock.performance.now() + timeout;
          // what the attempt's credential provider is told to give up by, the attempt settled; whether
          // a dispose ended it; whether its socket closed before its connect ended, and the end its
          // connect still tells then, a reconnection's attempt telling none as it closes
          const attempt: {
            controller: AbortController;
            isClosedEarly: boolean;
            isDisposed: boolean;
            untoldEnd: (() => void) | undefined;
          } = {
            controller: new AbortController(),
            isClosedEarly: false,
            isDisposed: false,
            untoldEnd: undefined,
          };
          let ended = false;
          const providerAttempt = { called: false };
          let stopWaiting: (() => void) | undefined;
          let opened: IWebSocketLike | undefined;
          // this attempt's own, which only it clears: a newer attempt may hold the shared one
          let ownReject: ((reason: Error) => void) | undefined;

          isSecure = isSecureUrl(url);
          carried = undefined;

          try {
            await createPromise(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                rejectConnect = ownReject = (reason) => {
                  attempt.isDisposed = true;
                  ended = true;
                  reject(reason);
                };

                // * read once as the URL Standard reads it: a host it fails on opens no socket
                if (urlHostOf(url) === undefined) {
                  reject(new ConnectError(`${host} is no host a URL can name`));

                  return undefined;
                }

                // ! no `followRedirects`: a 3xx answered to the upgrade fails it, its status named,
                // since a redirect would carry it where its credential and its security were not
                // judged (spec 15.6); an empty credential is none, as the server reads an empty field
                const open = (given: string | undefined, drawn?: IUndiciDrawn): void => {
                  if (ended || signal?.aborted === true) {
                    return;
                  }

                  const written = given === '' ? undefined : given;
                  // what undici's own connect failed with, which its `error` event does not carry
                  const watched = drawn === undefined ? undefined : watchedOf(drawn.agent);
                  let socket: IWebSocketLike;

                  // ! `closeTimeout`, `ws`'s own close timer, which it arms on every close, its
                  // 1009 among them: the transport's, so a server that never answers is dropped
                  // after one bound; for `Infinity`, the longest a timer holds, which Node would
                  // take for 1 ms
                  try {
                    socket =
                      opened =
                      client.socket =
                        drawn === undefined
                          ? // ! `?? []`: Chromium offers "undefined" for an `undefined` beside the
                            // options, a subprotocol no server selects (spec 15.2)
                            new WebSocket(url, protocols ?? [], {
                              closeTimeout:
                                closeTimeout === Infinity ? LONGEST_TIMER : closeTimeout,
                              // ! never without end: `ws` truncates a count to 32 bits
                              maxFragments: Math.min(maximumMessageFrames, WS_LARGEST_COUNT),
                              maxPayload,
                              // ! no permessage-deflate offer, as the C# client offers none: a
                              // third-party server must not negotiate compression on this side
                              // alone (RFC 7692)
                              perMessageDeflate: false,
                              ...(url.startsWith('wss:') ? nodeTls : {}),
                              ...(isWsShaped(WebSocket) && isLocalhostName(host)
                                ? {
                                    createConnection: loopbackCreateConnection(host, {
                                      signal: AbortSignal.any([
                                        attempt.controller.signal,
                                        ...(signal === undefined ? [] : [signal]),
                                      ]),
                                      timeout: Math.max(
                                        1,
                                        deadline - client.clock.performance.now()
                                      ),
                                    }),
                                  }
                                : {}),
                              ...(written === undefined
                                ? {}
                                : { headers: { authorization: written } }),
                            })
                          : (new drawn.undici.WebSocket(url, {
                              dispatcher: watched?.dispatcher ?? drawn.agent,
                              protocols: protocols ?? [],
                            }) as IWebSocketLike);
                  } catch (reason) {
                    return (reject(wrapReason(ConnectError, reason)), undefined);
                  }

                  let lastError: unknown;
                  // the status and the mark of an upgrade the server refused, where it can be read
                  let refused: string | undefined;
                  // its raw socket, which `ws` shows with the response to its upgrade
                  let raw: IRawSocketLike | undefined;

                  socket.on?.('upgrade', (response) => {
                    raw = response.socket;
                  });

                  // ! ended by `terminate`: a request destroyed leaves the socket connecting for ever;
                  // a `terminate` that throws fails the connect here, its cause what it threw, since
                  // that socket may never close
                  socket.on?.('unexpected-response', (_request, response) => {
                    refused = refusalOf(response);
                    response.resume?.();

                    try {
                      socket.terminate?.();
                    } catch (reason) {
                      reject(
                        new ConnectError(`the server refused the upgrade: ${refused}`, {
                          cause: reason,
                        })
                      );
                    }
                  });

                  socket.binaryType = binaryType;

                  socket.onerror = (event) => {
                    lastError = errorOf(event);
                  };
                  socket.onclose = (closeEvent) => {
                    const closed = closeEvent.reason
                      ? `${closeEvent.reason} (${String(closeEvent.code)})`
                      : String(closeEvent.code);
                    // where its dialer took a localhost name to the loopback itself, and its
                    // every attempt failed: no socket opened (spec 13.4)
                    const said =
                      (drawn !== undefined || isWsShaped(WebSocket)) &&
                      isConnectFailure(watched?.failures[0] ?? lastError)
                        ? loopbackSentenceOf(host)
                        : undefined;
                    const message =
                      refused === undefined
                        ? said === undefined
                          ? closed
                          : `${closed}; ${said}`
                        : `the server refused the upgrade: ${refused}`;

                    reject(
                      new ConnectError(
                        message,
                        lastError === undefined ? undefined : { cause: lastError }
                      )
                    );
                  };
                  socket.onopen = () => {
                    if (ended || signal?.aborted === true) {
                      client[dispose]();
                      return;
                    }

                    // ! a page's WebSocket, in Firefox, opens on a 101 that names none of the
                    // subprotocols it offered: the connect fails a socket whose protocol is none
                    // of them, compared byte for byte (spec 15.2), its socket closed as it fails
                    if (
                      protocols !== undefined &&
                      protocols.length > 0 &&
                      socket.protocol !== undefined &&
                      !protocols.includes(socket.protocol)
                    ) {
                      reject(
                        new ConnectError(
                          "the server's upgrade names none of the subprotocols offered (spec 15.2)"
                        )
                      );
                      return;
                    }

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
                            : error.code === WS_TOO_MANY_FRAMES_CODE &&
                                error.message === WS_TOO_MANY_FRAMES_MESSAGE
                              ? closedWithOf('the connection', {
                                  cause: error,
                                  code: 1008,
                                  why: `a message past its maximumMessageFrames, ${String(maximumMessageFrames)} frames`,
                                })
                              : error;
                      }
                    };
                    socket.onmessage = ({ data }) => {
                      if (client.isClosing()) {
                        return undefined;
                      }

                      beating?.heard();

                      return (hold.offer({ credential: undefined, data: data as Data }), undefined);
                    };

                    // * its end: its one error, then its close, what a listener of `error` throws
                    // dropped (spec 15.1)
                    const end = (): void => {
                      setReadyStateClosed(client);

                      if (failure !== undefined) {
                        report(failure);
                      }

                      tell(CLOSE_EVENT, [false, false]);
                    };

                    const closed = (): void => {
                      stopBeating();
                      dropQueue();
                      hold.drop();

                      // ! a reconnection's attempt closed before its connect ended: the connect
                      // tells its end, unless a dispose ends the attempt first
                      if (client.isReconnecting()) {
                        if (!ended) {
                          attempt.isClosedEarly = true;
                          attempt.untoldEnd = end;
                        }

                        return;
                      }

                      // ! closed before its connect ended, which ends without opening: a dispose
                      // from now on finds the attempt over
                      if (!ended) {
                        attempt.isClosedEarly = true;

                        if (rejectConnect === ownReject) {
                          rejectConnect = undefined;
                        }
                      }

                      end();
                    };

                    socket.onclose = closed;
                    // ! a heartbeat's drop that throws is the connection's error, and its end is
                    // told here, since that socket may never close: what it does after goes unheard
                    beating = beatOf({ raw, socket }, (reason) => {
                      failure ??= toError(reason);
                      socket.onerror = noop;
                      socket.onclose = noop;
                      socket.onmessage = noop;
                      closed();
                    });
                    queue = beating === undefined ? undefined : createSendQueue(socket);
                    carried = written;

                    // * read no further until its connect ends, so nothing is heard before it, and
                    // on only then unless its router paused it: its pause outlasts the connection
                    // it was made on
                    socket.pause?.();

                    resolve();
                  };

                  return undefined;
                };

                if (credentialProvider === undefined) {
                  if (!isThroughUndici) {
                    return (open(credential), undefined);
                  }

                  // * undici loaded before its socket opens, which `open` then judges as it judges
                  // a provider's answer: a dispose or a timeout meanwhile ends the attempt
                  void dialer.draw().then(
                    (drawn) => {
                      open(credential, drawn);
                    },
                    (reason: unknown) => {
                      reject(wrapReason(ConnectError, reason));
                    }
                  );

                  return undefined;
                }

                const credentialWaiter = {
                  resolve: (provided: string) => {
                    if (ended || signal?.aborted === true) {
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
                  reject: (reason: unknown) => {
                    reject(new ConnectError('the credential provider failed', { cause: reason }));
                  },
                };
                const provide = (): void => {
                  if (ended || signal?.aborted === true) {
                    return;
                  }

                  // attempts are sequential: an earlier ask settles before this source is asked anew
                  const waiting = pendingCredentials.get(credentialProvider);
                  if (waiting !== undefined) {
                    waiting.add(provide);
                    stopWaiting = () => {
                      waiting.delete(provide);
                    };
                    return;
                  }

                  providerAttempt.called = true;
                  const settled = new Set<() => void>();
                  const pending = Promise.resolve().then(() => {
                    return credentialProvider({ signal: attempt.controller.signal });
                  });
                  pendingCredentials.set(credentialProvider, settled);
                  const finish = (outcome: { value: string } | { reason: unknown }): void => {
                    if (pendingCredentials.get(credentialProvider) === settled) {
                      pendingCredentials.delete(credentialProvider);
                    }
                    for (const resume of settled) {
                      resume();
                    }
                    settled.clear();
                    if (ended || signal?.aborted === true) {
                      return;
                    }
                    if ('value' in outcome) {
                      credentialWaiter.resolve(outcome.value);
                    } else {
                      credentialWaiter.reject(outcome.reason);
                    }
                  };
                  void pending.then(
                    (value) => {
                      finish({ value });
                    },
                    (reason: unknown) => {
                      finish({ reason });
                    }
                  );
                };
                provide();

                return undefined;
              },
              {
                clock: {
                  ...client.clock,
                  clearTimeout: (timer) => {
                    client.clock.clearTimeout(timer);
                  },
                  setTimeout: (callback, delay) => {
                    return client.clock.setTimeout(() => {
                      // ! the timeout ends the attempt before a provider can settle in this turn
                      ended = true;
                      callback();
                    }, delay);
                  },
                },
                signal,
                timeout,
              }
            );

            // * a dispose between the open and here fails the connect in its own words (spec 15.15),
            // its socket reading on to its server's Close
            if (attempt.isDisposed) {
              opened?.resume?.();

              throw new ConnectError('the transport client was disposed as it connected');
            }
          } catch (reason) {
            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            // ! its own socket alone: a close listener may have begun a newer attempt meanwhile
            if (opened === undefined || client.socket === opened) {
              client[dispose]();
            }

            throw reason;
          } finally {
            if (rejectConnect === ownReject) {
              rejectConnect = undefined;
            }
            ended = true;
            stopWaiting?.();
            if (!providerAttempt.called) {
              attempt.controller.abort();
            } else {
              // oxlint-disable-next-line no-restricted-properties -- provider callbacks run after the connect settles, outside its stack
              globalThis.setTimeout(() => {
                try {
                  attempt.controller.abort();
                } catch {
                  /* the provider cannot replace the attempt's outcome */
                }
              }, 0);
            }
          }

          // * a socket closed between its open and here opened all the same (RFC 6455 §4.1): the
          // connect resolves, its client closed, its close told once, by its socket's `onclose` or
          // here; whatever a close listener began meanwhile is left alone
          if (attempt.isClosedEarly) {
            attempt.untoldEnd?.();
            return;
          }

          // a socket still open, or closing: its own `onclose` tells its end
          setReadyStateOpen(client);

          if (!hold.isPaused) {
            opened?.resume?.();
          }
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
            // ! a socket that closes reads on to its peer's Close, so its handshake never waits on
            // its own pause: what it held is dropped with it (RFC 6455 §7.1.1)
            hold.drop();
            socket.resume?.();

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
              flushQueue();
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

        // ! `ws` stops its socket, and emits what it already parsed of the read under way, which
        // the hold keeps in order; a socket closing reads on, paused no more
        pause: () => {
          hold.pause();

          if (!client.isClosing()) {
            client.socket?.pause?.();
          }
        },
        // what it held handed on from a microtask, its socket read again once nothing is held
        resume: () => {
          hold.resume();
        },

        // a credential given here is not carried: its upgrade's is, and the client fails a call
        // that presents another before it goes, DESTINATION_UNREACHABLE (decision 0032)
        send: ({ data }) => {
          return createPromise((resolve, reject) => {
            const { socket } = client;

            if (!client.isOpen() || socket === null) {
              return (reject(notOpenOf(getReadyState(client))), undefined);
            }

            // behind what its queue holds, over `ws`, its ping going ahead of it (spec 15.3)
            if (queue === undefined) {
              socket.send(data);
            } else {
              queue.send(data, bytesOf(data));
            }

            return (resolve(), undefined);
          });
        },

        [dispose]: () => {
          const { socket } = client;

          rejectConnect?.(new ConnectError('the transport client was disposed as it connected'));
          resolveDisconnect?.(true);
          stopBeating();
          hold.drop();
          // its agent closed, drawn again at its next connect: a socket it upgraded is the
          // WebSocket's own, which the agent no longer holds
          dialer.close(Promise.resolve());

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
          // both implementations, behind what its queue holds
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
            try {
              flushQueue();
              socket.close();
            } catch {
              /* a close that throws changes nothing: the socket is dropped below either way */
            }
          }

          dropQueue();
          client.socket = null;
        },
      };
    }
  );
};
