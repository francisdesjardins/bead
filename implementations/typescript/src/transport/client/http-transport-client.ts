// ── HTTP transport client ─────────────────────────────────────────────────────

// dependencies

import {
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CLOSE_EVENT,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  LISTEN_HEADER,
  MESSAGE_EVENT,
  REFUSAL_HEADER,
  SEQUENCE_HEADER,
} from '../shared/constants';
import { assertHeld, assertHeldFinite, type TimeoutId } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import { ConnectError, GenericError, ReadyStateError, wrapReason } from '../shared/errors';
import { noop } from '../shared/noop';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { dispose } from './symbols';
import { createTransportClient, DEFAULTS, DISCONNECT_DEFAULTS } from './transport-client';
import type {
  FetchLike,
  HTTPTransportClient,
  IFetchResponseLike,
  IHTTPClientConnection,
  IHTTPTransportClientConnectOptions,
  IHTTPTransportClientOptions,
} from './types';

export {
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  LISTEN_HEADER,
  REFUSAL_HEADER,
  SEQUENCE_HEADER,
} from '../shared/constants';
export type {
  FetchLike,
  HTTPTransportClient,
  IFetchInit,
  IFetchResponseLike,
  IHTTPClientConnection,
  IHTTPTransportClientConnectOptions,
  IHTTPTransportClientOptions,
} from './types';

// interfaces

/** A connection the server drew: where its exchanges go, its token, and what aborts them. */
interface IDrawn {
  readonly connectionToken: string;
  readonly controller: AbortController;
  /** The server said back at connect that it takes the listen. */
  readonly isListening: boolean;
  readonly url: string;
}

/** A batch as a listen reads it: the length being read, then the envelope it announced, filling. */
interface IReading {
  envelope: Uint8Array<ArrayBuffer> | undefined;
  filled: number;
  readonly length: Uint8Array;
  lengthFilled: number;
}

// constants

/** What an omitted connect option resolves to. */
export const CONNECT_DEFAULTS = Object.freeze({
  host: 'localhost',
  pathname: '/bead',
  port: 80,
  secured: false,
  timeout: 30_000,
} satisfies IHTTPTransportClientConnectOptions);

/** How long a disconnect waits on the server before it lets the connection go all the same. */
export const DISCONNECT_TIMEOUT = 5_000;

/**
 * How long a client goes on listening again, its listens lost, before it counts its connection lost,
 * by default: 5 minutes, a server's own inactivity timeout.
 */
export const INACTIVITY_TIMEOUT = 300_000;

/**
 * How long a client waits before it listens again, its listens lost: nothing after the first, then
 * `first`, twice as long each time, up to `ceiling` — each drawn between half of it and all of it.
 */
export const RETRY_DELAYS = Object.freeze({ ceiling: 30_000, first: 1_000 });

/** The largest answer read by default: a router's largest envelope. */
export const MAXIMUM_BODY_BYTES = 16_778_240;

/**
 * How long each listen asks the server to wait, by default: 25 seconds, under a server's own cap of
 * 30 and an intermediary's 60.
 */
export const WAIT = 25_000;

// the length before each envelope of a batch
const LENGTH_BYTES = 4;

// helpers

// the media type of a response, parameters aside
const typeOf = (response: IFetchResponseLike): string | undefined => {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
};

// a body read only to let its socket go
const drain = (response: IFetchResponseLike): void => {
  response.arrayBuffer().catch(noop);
};

// the envelopes a chunk of a batch completes, in order, what is left of it kept for the next chunk;
// none at all when a length announces nothing, or more than `limit`
const envelopesOf = (
  reading: IReading,
  { chunk, limit }: { chunk: Uint8Array; limit: number }
): Uint8Array<ArrayBuffer>[] | undefined => {
  const envelopes: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    if (reading.envelope === undefined) {
      const taken = Math.min(LENGTH_BYTES - reading.lengthFilled, chunk.length - offset);

      reading.length.set(chunk.subarray(offset, offset + taken), reading.lengthFilled);
      reading.lengthFilled += taken;
      offset += taken;

      if (reading.lengthFilled === LENGTH_BYTES) {
        const length = new DataView(reading.length.buffer).getUint32(0);

        if (length === 0 || length > limit) {
          return undefined;
        }

        reading.envelope = new Uint8Array(length);
        reading.filled = 0;
        reading.lengthFilled = 0;
      }
    } else {
      const taken = Math.min(reading.envelope.length - reading.filled, chunk.length - offset);

      reading.envelope.set(chunk.subarray(offset, offset + taken), reading.filled);
      reading.filled += taken;
      offset += taken;

      if (reading.filled === reading.envelope.length) {
        envelopes.push(reading.envelope);
        reading.envelope = undefined;
      }
    }
  }

  return envelopes;
};

// a listener that throws is told as a socket's is — uncaught — and the listening goes on
const rethrow = (reason: unknown): void => {
  queueMicrotask(() => {
    throw reason;
  });
};

// how long to wait before listening again after `losses` listens lost in a row, drawn apart so the
// clients one restart dropped together come back apart, as EventSource's do; in whole
// milliseconds, as every wait of Bead's
const retryDelayOf = (losses: number): number => {
  if (losses === 1) {
    return 0;
  }

  const delay = Math.min(RETRY_DELAYS.ceiling, RETRY_DELAYS.first * 2 ** (losses - 2));

  return Math.floor(delay / 2 + (Math.random() * delay) / 2);
};

// a bound of the listens, which 0 gives a meaning of its own: lost, listened again or answered at
// once; `Infinity`, only where it may be
const assertDelay = (
  name: string,
  { isUnbounded = false, value }: { isUnbounded?: boolean; value: number }
): void => {
  if (value === 0) {
    return;
  }

  if (isUnbounded) {
    assertHeld(name, value);
  } else {
    assertHeldFinite(name, value);
  }
};

// definition

/**
 * A transport client over HTTP, on a connection the server draws for it: `connect` posts no envelope
 * and takes the connection token the server answers 201 with, each `send` posts one envelope with
 * that token, and `disconnect` deletes the connection. The token is kept here, never on `socket`.
 *
 * `send` settles on the head of its answer, so a caller knows whether the server had its envelope: a
 * 2xx resolves — the router has it, and an answer comes as a `message` when it does; a refusal the
 * transport marks in `bead-refusal` rejects, nothing having been tried, and the one that says the
 * connection is gone closes it, once its rejection is heard. Anything else — a status nothing marked,
 * an answer of another type, a network that failed, a redirect — leaves the outcome unknown: it
 * resolves, and closes the connection, as a socket that drops does.
 *
 * What the server sends of its own, a client that listens — the default, once the server says it
 * back at connect — hears by a listen: a `GET` the server holds up to `wait`, which brings back a
 * batch of envelopes, numbered from its first, each heard as a `message` as it comes whole and
 * bounded alone by `maximumBodyBytes`. The next listen acknowledges what was heard; one that brings
 * nothing is followed by another after `pause`. A listen lost is listened again from where it was, at
 * once, then later and later, drawn apart, until one reaches the server, as EventSource reconnects —
 * or until `inactivityTimeout` has passed, which loses the connection, as a refusal of the server's
 * or a batch that does not read does.
 *
 * @example
 * const client = createHTTPTransportClient();
 * client.on('message', (data) => {});
 * await client.connect({ host, port });
 * await client.send(envelope);
 * await client.disconnect();
 */
export const createHTTPTransportClient = (
  options?: IHTTPTransportClientOptions
): HTTPTransportClient => {
  const {
    clock,
    fetch: fetchImpl = globalThis.fetch as FetchLike,
    inactivityTimeout = INACTIVITY_TIMEOUT,
    isListening = true,
    maximumBodyBytes = MAXIMUM_BODY_BYTES,
    pause = 0,
    wait = WAIT,
  } = {
    ...DEFAULTS(),
    ...options,
  };

  assertDelay('inactivityTimeout', { isUnbounded: true, value: inactivityTimeout });
  assertDelay('pause', { value: pause });
  assertDelay('wait', { value: wait });

  return createTransportClient<IHTTPClientConnection, IHTTPTransportClientConnectOptions>(
    (client) => {
      let drawn: IDrawn | undefined;
      // settles the connect in flight, so a dispose under it cannot leave it pending
      let rejectConnect: ((reason: Error) => void) | undefined;

      // a DELETE nobody waits on, which outlives a page that is closing
      const release = ({ connectionToken, url }: IDrawn): void => {
        fetchImpl(url, {
          headers: { [CONNECTION_TOKEN_HEADER]: connectionToken },
          keepalive: true,
          method: 'DELETE',
          redirect: 'error',
        }).then(drain, noop);
      };

      // the connection is gone: its exchanges abort, and the client closes, as over a socket dropped
      const lose = (connection: IDrawn, { isReleased }: { isReleased: boolean }): void => {
        if (drawn !== connection) {
          return;
        }

        drawn = undefined;
        client.socket = null;
        connection.controller.abort();

        if (isReleased) {
          release(connection);
        }

        if (!client.isReconnecting()) {
          setReadyStateClosed(client);
          client.emit(CLOSE_EVENT, false, false);
        }
      };

      // an envelope an answer or a listen brought back; a listener that throws stops nothing
      const hear = (envelope: ArrayBuffer): void => {
        try {
          client.emit(MESSAGE_EVENT, envelope);
        } catch (reason) {
          rethrow(reason);
        }
      };

      // the answer a 200 carries, read up to an envelope's limit; anything else loses the connection
      const readAnswer = async (connection: IDrawn, response: IFetchResponseLike) => {
        if (response.status !== 200) {
          return (drain(response), undefined);
        }

        const declared = Number(response.headers.get('content-length') ?? Number.NaN);

        if (typeOf(response) !== BEAD_MEDIA_TYPE || declared > maximumBodyBytes) {
          drain(response);

          return (lose(connection, { isReleased: true }), undefined);
        }

        let body: ArrayBuffer;

        try {
          body = await response.arrayBuffer();
        } catch {
          return (lose(connection, { isReleased: true }), undefined);
        }

        if (body.byteLength > maximumBodyBytes) {
          return (lose(connection, { isReleased: true }), undefined);
        }

        // an exchange ended empty — cancelled — has nothing to say, and one past its connection's
        // end — lost, or disconnecting — is no answer of this one's
        if (body.byteLength > 0 && drawn === connection) {
          hear(body);
        }

        return undefined;
      };

      // one listen: each envelope it brings back heard as it comes whole, `cursor` advanced before —
      // or what came instead: nothing, the connection gone, a refusal of the server's, a batch that
      // does not read, or the listen lost before it brought anything whole
      const listenOnce = async (
        connection: IDrawn,
        cursor: { after: number }
      ): Promise<'broken' | 'gone' | 'heard' | 'lost' | 'nothing' | 'refused'> => {
        const query = `after=${String(cursor.after)}&wait=${String(wait)}`;
        let response: IFetchResponseLike;

        try {
          response = await fetchImpl(`${connection.url}?${query}`, {
            headers: { [CONNECTION_TOKEN_HEADER]: connection.connectionToken },
            method: 'GET',
            redirect: 'error',
            signal: connection.controller.signal,
          });
        } catch {
          return 'lost';
        }

        const refusal = response.headers.get(REFUSAL_HEADER);

        if (response.status !== 200 || typeOf(response) !== BEAD_BATCH_MEDIA_TYPE) {
          drain(response);

          if (response.status === 204) {
            return 'nothing';
          }

          if (refusal === null) {
            return 'lost';
          }

          return refusal === CONNECTION_UNKNOWN ? 'gone' : 'refused';
        }

        // numbered from the one after the last it heard, or it is no batch of this listen's
        if (
          response.headers.get(SEQUENCE_HEADER) !== String(cursor.after + 1) ||
          response.body === null
        ) {
          return (drain(response), 'broken');
        }

        const reader = response.body.getReader();
        const reading: IReading = {
          envelope: undefined,
          filled: 0,
          length: new Uint8Array(LENGTH_BYTES),
          lengthFilled: 0,
        };
        let heard = 0;

        try {
          for (let read = await reader.read(); !read.done; read = await reader.read()) {
            const envelopes = envelopesOf(reading, { chunk: read.value, limit: maximumBodyBytes });

            if (envelopes === undefined) {
              return 'broken';
            }

            for (const envelope of envelopes) {
              // gone as it was heard: what is left goes unheard
              if (drawn !== connection) {
                return 'heard';
              }

              cursor.after += 1;
              heard += 1;
              hear(envelope.buffer);
            }
          }
        } catch {
          // cut on its way: what came whole was heard, and the rest comes again
          return heard > 0 ? 'heard' : 'lost';
        }

        // ended where an envelope ends, one at least; anything else is no batch
        return heard > 0 && reading.envelope === undefined && reading.lengthFilled === 0
          ? 'heard'
          : 'broken';
      };

      // a wait between two listens, which `signal` cuts short: the connection's end, or the end of
      // its inactivity timeout
      const pauseFor = (signal: AbortSignal, delay: number): Promise<void> => {
        return createPromise(
          (resolve) => {
            resolve();
          },
          { clock: client.clock, delay, signal }
        ).catch(noop);
      };

      // the inactivity timeout of a count of losses, armed at its first, which aborts `expiry` as it
      // ends: at once when it is 0, and never when it is Infinity, which a timer would take for 1 ms
      const expireAfter = (expiry: AbortController): TimeoutId | undefined => {
        if (inactivityTimeout === 0) {
          return (expiry.abort(), undefined);
        }

        if (inactivityTimeout === Infinity) {
          return undefined;
        }

        return client.clock.setTimeout(() => {
          expiry.abort();
        }, inactivityTimeout);
      };

      // listened for while the connection stands. A listen lost is listened again from where it was —
      // at once, then later and later — until one reaches the server, or until `inactivityTimeout`
      // has passed since the first was lost: the wait under way ends, and the next listen is the last
      const listen = async (connection: IDrawn): Promise<void> => {
        const cursor = { after: 0 };
        let losses = 0;
        // a timer measures the timeout, never a reading of the wall clock, which a clock set or a
        // machine woken from sleep moves: the listens it allows are the same on any machine
        let expiry: AbortController | undefined;
        let timeoutId: TimeoutId | undefined;

        try {
          while (drawn === connection) {
            const listened = await listenOnce(connection, cursor);

            // its connection gone meanwhile — disconnected, disposed: nothing is counted on it
            if (drawn !== connection) {
              return;
            }

            if (listened === 'lost') {
              losses += 1;

              if (expiry === undefined) {
                expiry = new AbortController();
                timeoutId = expireAfter(expiry);
              }

              if (expiry.signal.aborted) {
                return (lose(connection, { isReleased: true }), undefined);
              }

              await pauseFor(
                AbortSignal.any([connection.controller.signal, expiry.signal]),
                retryDelayOf(losses)
              );

              continue;
            }

            if (listened !== 'heard' && listened !== 'nothing') {
              return (lose(connection, { isReleased: listened !== 'gone' }), undefined);
            }

            // it reached the server: the count ends, and its timeout with it
            client.clock.clearTimeout(timeoutId);
            expiry = undefined;
            losses = 0;

            if (listened === 'nothing') {
              await pauseFor(connection.controller.signal, pause);
            }
          }
        } finally {
          // the connection's end disarms it, so nothing fires after
          client.clock.clearTimeout(timeoutId);
        }
      };

      return {
        clock,

        connect: async (connectOptions) => {
          const {
            host,
            pathname = CONNECT_DEFAULTS.pathname,
            port,
            secured = CONNECT_DEFAULTS.secured,
            signal,
            timeout = CONNECT_DEFAULTS.timeout,
          } = { ...CONNECT_DEFAULTS, ...connectOptions };

          // an IPv6 literal is bracketed, or its colons would read as the port's
          const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
          const url = `${secured ? 'https' : 'http'}://${authority}:${String(port)}${pathname.replace(/^\/?(.*)/u, '/$1')}`;
          const attempt = new AbortController();
          let connection: IDrawn | undefined;
          let opened: IDrawn;

          try {
            opened = await createPromise<IDrawn>(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                rejectConnect = reject;

                fetchImpl(url, {
                  headers: {
                    'content-type': BEAD_MEDIA_TYPE,
                    ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
                  },
                  method: 'POST',
                  redirect: 'error',
                  signal: attempt.signal,
                }).then(
                  (response) => {
                    const connectionToken = response.headers.get(CONNECTION_TOKEN_HEADER);

                    drain(response);

                    if (response.status !== 201 || connectionToken === null) {
                      const refused = new ConnectError(
                        `the server drew no connection: ${String(response.status)}`
                      );

                      return (reject(refused), undefined);
                    }

                    connection = {
                      connectionToken,
                      controller: new AbortController(),
                      // taken where the server said it back, and nowhere else
                      isListening: isListening && response.headers.get(LISTEN_HEADER) === '?1',
                      url,
                    };

                    return (resolve(connection), undefined);
                  },
                  (reason: unknown) => {
                    reject(wrapReason(ConnectError, reason));
                  }
                );
              },
              { clock: client.clock, signal, timeout }
            );
          } catch (reason) {
            // given up — timed out, cancelled, disposed — as it came: the connection drawn meanwhile
            // is let go, and the server told
            attempt.abort();

            if (connection !== undefined) {
              release(connection);
            }

            if (!client.isReconnecting()) {
              setReadyStateClosed(client);
            }

            throw reason;
          } finally {
            rejectConnect = undefined;
          }

          drawn = opened;
          client.socket = { url };
          setReadyStateOpen(client);

          if (opened.isListening) {
            void listen(opened);
          }
        },

        disconnect: async (disconnectOptions) => {
          const { isClean = DISCONNECT_DEFAULTS.isClean, isQuick = DISCONNECT_DEFAULTS.isQuick } =
            disconnectOptions ?? {};
          const connection = drawn;

          if (!client.isOpen() || connection === undefined) {
            throw new ReadyStateError(getReadyState(client), ReadyState.OPEN);
          }

          setReadyStateClosing(client);
          drawn = undefined;

          if (isQuick) {
            connection.controller.abort();
            release(connection);
          } else {
            // the server ends it first, so what waits there learns it; then what waits here goes. Its
            // bound is the platform's, on the real clock, as a close handshake's: it bounds the
            // platform's own exchange with a server that does not answer (decision 0011)
            try {
              drain(
                await fetchImpl(connection.url, {
                  headers: { [CONNECTION_TOKEN_HEADER]: connection.connectionToken },
                  keepalive: true,
                  method: 'DELETE',
                  redirect: 'error',
                  // oxlint-disable-next-line no-restricted-properties -- a disconnect's bound is the platform's
                  signal: AbortSignal.timeout(DISCONNECT_TIMEOUT),
                })
              );
            } catch {
              /* gone already, or unreachable: the connection ends here all the same */
            }

            connection.controller.abort();
          }

          client.socket = null;
          setReadyStateClosed(client);
          client.emit(CLOSE_EVENT, isClean, isQuick);
        },

        send: (data) => {
          const connection = drawn;

          if (!client.isOpen() || connection === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          return createPromise((resolve, reject) => {
            fetchImpl(connection.url, {
              body: data as BodyInit,
              headers: {
                'content-type': BEAD_MEDIA_TYPE,
                [CONNECTION_TOKEN_HEADER]: connection.connectionToken,
              },
              method: 'POST',
              redirect: 'error',
              signal: connection.controller.signal,
            }).then(
              (response) => {
                if (response.ok) {
                  resolve();

                  return readAnswer(connection, response);
                }

                const refusal = response.headers.get(REFUSAL_HEADER);

                drain(response);

                // a status nothing marked — a gateway's, a redirect's — says nothing of whether the
                // server had it: lost
                if (refusal === null) {
                  resolve();

                  return (lose(connection, { isReleased: true }), undefined);
                }

                // refused by the transport before the router saw it: nothing of it was tried
                reject(
                  new GenericError(
                    `the server refused the exchange: ${String(response.status)} ${refusal}`
                  )
                );

                // its connection gone: told after the refusal is heard, so its caller learns first
                // that it was never tried
                if (refusal === CONNECTION_UNKNOWN) {
                  const loseIt = (): void => {
                    lose(connection, { isReleased: false });
                  };

                  // oxlint-disable-next-line no-restricted-properties -- a deferral to the next turn, which no clock times
                  globalThis.setTimeout(loseIt, 0);
                }

                return undefined;
              },
              () => {
                // lost before its head: whether the server had it is not known, so it counts as
                // handed over, and the connection closes, as a dropped socket's
                resolve();
                lose(connection, { isReleased: true });
              }
            );
          });
        },

        [dispose]: () => {
          const connection = drawn;

          rejectConnect?.(new ConnectError('disposed while connecting'));
          drawn = undefined;
          client.socket = null;

          if (connection !== undefined) {
            connection.controller.abort();
            release(connection);
          }
        },
      };
    }
  );
};
