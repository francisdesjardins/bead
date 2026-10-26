// ── HTTP transport client ─────────────────────────────────────────────────────

// dependencies

import {
  AFTER_HEADER,
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CLOSE_EVENT,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  ERROR_EVENT,
  LISTEN_HEADER,
  MESSAGE_EVENT,
  REFUSAL_HEADER,
  SEQUENCE_HEADER,
  WAIT_HEADER,
} from '../shared/constants';
import { assertHeld, assertHeldDelay, type TimeoutId } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import {
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  reasonMessage,
  toError,
  wrapReason,
} from '../shared/errors';
import { noop } from '../shared/noop';
import { isSecureUrl } from '../shared/secure';
import { BARE_ITEM_TYPES, parseItem } from '../shared/structured-fields';
import {
  getReadyState,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
} from '../shared/ready-state';
import { dispose } from './symbols';
import {
  createTransportClient,
  DEFAULTS,
  DISCONNECT_DEFAULTS,
  isFieldValue,
} from './transport-client';
import type {
  FetchLike,
  IFetchInit,
  HTTPTransportClient,
  IFetchResponseLike,
  IHTTPClientConnection,
  IHTTPTransportClientConnectOptions,
  IHTTPTransportClientOptions,
} from './types';

export {
  AFTER_HEADER,
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  LISTEN_HEADER,
  REFUSAL_HEADER,
  SEQUENCE_HEADER,
  WAIT_HEADER,
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

// a field's value read as an Item of RFC 9651, its parameters aside: its Integer, or none
const integerOf = (value: string | null): number | undefined => {
  const bareItem = value === null ? undefined : parseItem(value)?.bareItem;

  return bareItem?.type === BARE_ITEM_TYPES.INTEGER ? bareItem.value : undefined;
};

// a field's value read as an Item of RFC 9651, its parameters aside: whether it is the Boolean true
const isTrue = (value: string | null): boolean => {
  const bareItem = value === null ? undefined : parseItem(value)?.bareItem;

  return bareItem?.type === BARE_ITEM_TYPES.BOOLEAN && bareItem.value;
};

// a body left unread, cancelled so its socket goes: a gateway's page, a redirect's, is never read
// whole; none at all — a 204's, a page's opaque redirect — needs nothing
const drain = (response: IFetchResponseLike): void => {
  void response.body?.cancel().catch(noop);
};

// a redirect, Fetch's redirect statuses, judged as any status that is not 2xx, never followed: the
// connection's token would go where it was not judged (spec 15.6). 0 is a page's opaque redirect,
// which a fetch in `cors` mode hands back for nothing else, a network error rejecting
const isRedirect = (status: number): boolean => {
  return [0, 301, 302, 303, 307, 308].includes(status);
};

// ! whether a fetch followed a redirect all the same, which a given one may: its answer comes from
// a place never judged, so nothing of it is read. Its URL is never compared with the one asked,
// since Fetch's drops a default port and lowercases the host
const isFollowed = (response: IFetchResponseLike): boolean => {
  return response.redirected === true;
};

// * what this side closes a connection for of its own, as its `error` tells it before its close
// (spec 15.1): an envelope past its bound, named with its value, as a WebSocket's 1009 is
const pastBoundOf = (maximumBodyBytes: number): GenericError => {
  return new GenericError(
    `the connection is closed: an envelope past its maximumBodyBytes, ${String(maximumBodyBytes)} bytes`
  );
};

// and a batch that does not read, saying what of it does not, as a WebSocket's protocol error
const unreadOf = (why: string): GenericError => {
  return new GenericError(`the connection is closed: a batch that does not read, ${why}`);
};

// the envelopes a chunk of a batch completes, in order, what is left of it kept for the next chunk;
// none at all when a length announces nothing, or more than `limit`, which fails the connection
const envelopesOf = (
  reading: IReading,
  { chunk, limit }: { chunk: Uint8Array; limit: number }
): Uint8Array<ArrayBuffer>[] | GenericError => {
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

        if (length === 0) {
          return unreadOf('an envelope of 0 bytes');
        }

        if (length > limit) {
          return pastBoundOf(limit);
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

// definition

/**
 * A transport client over HTTP, on a connection the server draws for it: `connect` posts no envelope
 * and takes the connection token the server answers 201 with, each `send` posts one envelope with
 * that token, and `disconnect` deletes the connection. The token is kept here, never on `socket`.
 *
 * Each `send` carries its credential, when it has one, in the `Authorization` field of its `POST`,
 * as it is given; one that is no field's value — anything but visible ASCII, spaces and tabs — is
 * refused before it goes. An answer, and what a listen brings back, carry none.
 *
 * `send` settles on the head of its answer, so a caller knows whether the server had its envelope: a
 * 2xx resolves — the router has it, and an answer comes as a `message` when it does; a refusal the
 * transport marks in `bead-refusal` rejects, nothing having been tried, and the one that says the
 * connection is gone closes it, once its rejection is heard. Anything else — a status nothing marked,
 * an answer of another type, a network that failed, a redirect — leaves the outcome unknown: it
 * resolves, and closes the connection, as a socket that drops does.
 *
 * No redirect is followed: each fetch passes `redirect: 'manual'`, and a redirect is judged as any
 * status that is not 2xx, its `bead-refusal` unread (spec 15.6). A connect answered with one fails,
 * its status named — "the server drew no connection: 302"; a page's fetch, which reads none, "a
 * redirect" — a send so answered is lost, and a listen listened again. A `fetch` given that follows
 * all the same is caught at its answer, which says it followed: the connect fails, "the server drew
 * no connection: a redirect followed", and a send or a listen loses its connection, nothing of what
 * answered read.
 *
 * What the server sends of its own, a client that listens — the default, once the server says it
 * back at connect — hears by a listen: a `GET` at the connection's one URL, which the server holds
 * up to `wait`, asked in `bead-wait`, and which brings back a batch of envelopes, numbered from its
 * first, each heard as a `message` as it comes whole and bounded alone by `maximumBodyBytes`. The
 * next listen acknowledges in `bead-after` what was heard; one that brings nothing is followed by
 * another after `pause`. A listen lost is listened again from where it was, at once, then later and
 * later, drawn apart, until one reaches the server, as EventSource reconnects — or until
 * `inactivityTimeout` has passed, which loses the connection, as a refusal of the server's or a
 * batch that does not read does.
 *
 * `error` tells what this side closes its connection for of its own (spec 15.1), each a
 * {@link GenericError}: an envelope past `maximumBodyBytes`, an answer's or a batch's, "the
 * connection is closed: an envelope past its maximumBodyBytes, N bytes"; a batch that does not
 * read, "the connection is closed: a batch that does not read, …", saying what of it does not;
 * an executor's own failure, "the HTTP executor failed: …", keeping its cause; each once,
 * before its `close`, so a listener that throws keeps the close told. A server gone, a
 * refusal of its own, a redirect, a timeout, an answer of another type and a network that failed
 * tell their `close` alone.
 *
 * @example
 * const client = createHTTPTransportClient();
 * client.on('message', ({ data }) => {});
 * await client.connect({ host, port });
 * await client.send({ credential: 'Bearer mF_9.B5f-4.1JqM', data: envelope });
 * await client.disconnect();
 */
export const createHTTPTransportClient = (
  options?: IHTTPTransportClientOptions
): HTTPTransportClient => {
  const {
    clock,
    fetch: fetchImpl = globalThis.fetch as FetchLike,
    inactivityTimeout: givenInactivityTimeout = INACTIVITY_TIMEOUT,
    isListening = true,
    maximumBodyBytes = MAXIMUM_BODY_BYTES,
    pause: givenPause = 0,
    wait: givenWait = WAIT,
  } = {
    ...DEFAULTS(),
    ...options,
  };
  const inactivityTimeout = assertHeld('inactivityTimeout', givenInactivityTimeout);
  // 0 is at once: a listen again at once, and a listen the server answers at once, which polls
  const pause = assertHeldDelay('pause', givenPause);
  const wait = assertHeldDelay('wait', givenWait);

  return createTransportClient<IHTTPClientConnection, IHTTPTransportClientConnectOptions>(
    (client, { tell }) => {
      let drawn: IDrawn | undefined;
      // settles the connect in flight, so a dispose under it cannot leave it pending
      let rejectConnect: ((reason: Error) => void) | undefined;
      // whether the URL of the last connect is secure
      let isSecure = false;

      const execute = (url: string, init: IFetchInit): Promise<IFetchResponseLike> => {
        try {
          return fetchImpl(url, init);
        } catch (reason) {
          return Promise.reject(toError(reason));
        }
      };

      // a DELETE nobody waits on, which outlives a page that is closing
      const release = ({ connectionToken, url }: IDrawn): void => {
        void execute(url, {
          headers: { [CONNECTION_TOKEN_HEADER]: connectionToken },
          keepalive: true,
          method: 'DELETE',
          redirect: 'manual',
        }).then(drain, noop);
      };

      // the platform's network failure retries a listen; an executor's own failure ends it
      const executorFailureOf = (
        reason: unknown,
        signal: AbortSignal
      ): GenericError | undefined => {
        if (signal.aborted || reason instanceof TypeError) {
          return undefined;
        }
        return new GenericError(`the HTTP executor failed: ${reasonMessage(reason)}`, {
          cause: reason,
        });
      };

      // the connection is gone: its exchanges abort, and the client closes, as over a socket
      // dropped; one this side failed of its own tells why on `error` first, then its close all the
      // same, a listener of `error` that throws its platform's (spec 15.1)
      const lose = (
        connection: IDrawn,
        { failure, isReleased }: { failure?: GenericError | undefined; isReleased: boolean }
      ): void => {
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

          try {
            if (failure !== undefined) {
              client.emit(ERROR_EVENT, failure);
            }
          } finally {
            tell(CLOSE_EVENT, [false, false]);
          }
        }
      };

      // an envelope an answer or a listen brought back, which carry no credential, what a listen
      // brought marked as what may overtake an answer; a listener that throws is reported, and
      // stops nothing
      const hear = (envelope: ArrayBuffer, { mayOvertake }: { mayOvertake: boolean }): void => {
        tell(MESSAGE_EVENT, [
          {
            credential: undefined,
            data: envelope,
            ...(mayOvertake ? { mayOvertake: true } : {}),
          },
        ]);
      };

      // the answer a 200 carries, read up to an envelope's limit; anything else loses the connection
      const readAnswer = async (connection: IDrawn, response: IFetchResponseLike) => {
        if (response.status !== 200) {
          return (drain(response), undefined);
        }

        const declared = Number(response.headers.get('content-length') ?? Number.NaN);

        if (typeOf(response) !== BEAD_MEDIA_TYPE) {
          drain(response);

          return (lose(connection, { isReleased: true }), undefined);
        }

        if (declared > maximumBodyBytes) {
          drain(response);

          return (
            lose(connection, { failure: pastBoundOf(maximumBodyBytes), isReleased: true }),
            undefined
          );
        }

        let body: ArrayBuffer;

        try {
          body = await response.arrayBuffer();
        } catch (reason) {
          return (
            lose(connection, {
              failure: executorFailureOf(reason, connection.controller.signal),
              isReleased: true,
            }),
            undefined
          );
        }

        if (body.byteLength > maximumBodyBytes) {
          return (
            lose(connection, { failure: pastBoundOf(maximumBodyBytes), isReleased: true }),
            undefined
          );
        }

        // an exchange ended empty — cancelled — has nothing to say, and one past its connection's
        // end — lost, or disconnecting — is no answer of this one's
        if (body.byteLength > 0 && drawn === connection) {
          hear(body, { mayOvertake: false });
        }

        return undefined;
      };

      // one listen: each envelope heard as it comes whole, `cursor` advanced before — or what came
      // instead, the error that fails the connection among it
      const listenOnce = async (
        connection: IDrawn,
        cursor: { after: number }
      ): Promise<'followed' | 'gone' | 'heard' | 'lost' | 'nothing' | 'refused' | GenericError> => {
        let response: IFetchResponseLike;

        // * at the connection's one URL, its counts in fields: a moving URL is a preflight each time
        // for a page of another origin, whose browser caches the answer by URL (Fetch §4.9)
        try {
          response = await fetchImpl(connection.url, {
            headers: {
              [AFTER_HEADER]: String(cursor.after),
              [CONNECTION_TOKEN_HEADER]: connection.connectionToken,
              [WAIT_HEADER]: String(wait),
            },
            method: 'GET',
            redirect: 'manual',
            signal: connection.controller.signal,
          });
        } catch (reason) {
          return executorFailureOf(reason, connection.controller.signal) ?? 'lost';
        }

        // followed all the same: its batch is never read, and listening again would go the same way
        if (isFollowed(response)) {
          return (drain(response), 'followed');
        }

        if (response.status !== 200 || typeOf(response) !== BEAD_BATCH_MEDIA_TYPE) {
          drain(response);

          if (response.status === 204) {
            return 'nothing';
          }

          // a redirect's mark is left unread: no refusal of the transport's own is one
          const refusal = isRedirect(response.status) ? null : response.headers.get(REFUSAL_HEADER);

          if (refusal === null) {
            return 'lost';
          }

          return refusal === CONNECTION_UNKNOWN ? 'gone' : 'refused';
        }

        // numbered from the one after the last it heard, or it is no batch of this listen's
        if (integerOf(response.headers.get(SEQUENCE_HEADER)) !== cursor.after + 1) {
          return (drain(response), unreadOf(`its bead-sequence not ${String(cursor.after + 1)}`));
        }

        if (response.body === null) {
          return unreadOf('it holds no envelope');
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

            if (envelopes instanceof GenericError) {
              return envelopes;
            }

            for (const envelope of envelopes) {
              // gone as it was heard: what is left goes unheard
              if (drawn !== connection) {
                return 'heard';
              }

              cursor.after += 1;
              heard += 1;
              hear(envelope.buffer, { mayOvertake: true });
            }
          }
        } catch (reason) {
          // cut on its way: what came whole was heard, and the rest comes again
          return (
            executorFailureOf(reason, connection.controller.signal) ??
            (heard > 0 ? 'heard' : 'lost')
          );
        }

        // ended where an envelope ends, one at least; anything else is no batch
        if (reading.envelope !== undefined || reading.lengthFilled > 0) {
          return unreadOf('it ends within an envelope');
        }

        return heard > 0 ? 'heard' : unreadOf('it holds no envelope');
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
      // ends: never when it is Infinity, which a timer would take for 1 ms
      const expireAfter = (expiry: AbortController): TimeoutId | undefined => {
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

            if (listened instanceof GenericError) {
              return (lose(connection, { failure: listened, isReleased: true }), undefined);
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
        // * any field value, in each `POST`'s `Authorization`
        carries: isFieldValue,
        clock,
        get isSecure() {
          return isSecure;
        },

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

          isSecure = isSecureUrl(url);
          const attempt = { controller: new AbortController(), isDisposed: false };
          let connection: IDrawn | undefined;
          let opened: IDrawn;

          try {
            opened = await createPromise<IDrawn>(
              (resolve, reject) => {
                if (!client.isReconnecting()) {
                  setReadyStateConnecting(client);
                }

                rejectConnect = (reason) => {
                  attempt.isDisposed = true;
                  reject(reason);
                };

                fetchImpl(url, {
                  headers: {
                    'content-type': BEAD_MEDIA_TYPE,
                    ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
                  },
                  method: 'POST',
                  redirect: 'manual',
                  signal: attempt.controller.signal,
                }).then(
                  (response) => {
                    const connectionToken = response.headers.get(CONNECTION_TOKEN_HEADER);

                    drain(response);

                    // what drew it, if anything did, is a place never judged: it ends by its own
                    // inactivity timeout, nothing released
                    if (isFollowed(response)) {
                      return (
                        reject(
                          new ConnectError('the server drew no connection: a redirect followed')
                        ),
                        undefined
                      );
                    }

                    // its status alone, its mark unread; a page reads none of an opaque redirect
                    if (isRedirect(response.status)) {
                      const named = response.status === 0 ? 'a redirect' : String(response.status);

                      return (
                        reject(new ConnectError(`the server drew no connection: ${named}`)),
                        undefined
                      );
                    }

                    if (response.status !== 201 || connectionToken === null) {
                      // its status, and its reason where the server marked it (spec 15.6)
                      const reason = response.headers.get(REFUSAL_HEADER);
                      const status = String(response.status);
                      const refused = new ConnectError(
                        `the server drew no connection: ${reason === null ? status : `${status} ${reason}`}`
                      );

                      return (reject(refused), undefined);
                    }

                    connection = {
                      connectionToken,
                      controller: new AbortController(),
                      // taken where the server said it back, and nowhere else
                      isListening: isListening && isTrue(response.headers.get(LISTEN_HEADER)),
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

            if (attempt.isDisposed) {
              throw new ConnectError('the transport client was disposed as it connected');
            }
          } catch (reason) {
            // given up — timed out, cancelled, disposed — as it came: the connection drawn meanwhile
            // is let go, and the server told
            attempt.controller.abort();

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
          let failure: GenericError | undefined;

          if (isQuick) {
            connection.controller.abort();
            release(connection);
          } else {
            // the server ends it first, so what waits there learns it; then what waits here goes. Its
            // bound is the platform's, on the real clock, as a close handshake's: it bounds the
            // platform's own exchange with a server that does not answer (decision 0011)
            // oxlint-disable-next-line no-restricted-properties -- a disconnect's bound is the platform's
            const signal = AbortSignal.timeout(DISCONNECT_TIMEOUT);
            try {
              drain(
                await fetchImpl(connection.url, {
                  headers: { [CONNECTION_TOKEN_HEADER]: connection.connectionToken },
                  keepalive: true,
                  method: 'DELETE',
                  redirect: 'manual',
                  signal,
                })
              );
            } catch (reason) {
              failure = executorFailureOf(reason, signal);
            }

            connection.controller.abort();
          }

          client.socket = null;
          setReadyStateClosed(client);
          try {
            if (failure !== undefined) {
              client.emit(ERROR_EVENT, failure);
            }
          } finally {
            tell(CLOSE_EVENT, [isClean, isQuick]);
          }
        },

        send: ({ credential, data }) => {
          const connection = drawn;

          if (!client.isOpen() || connection === undefined) {
            return Promise.reject(new ReadyStateError(getReadyState(client), ReadyState.OPEN));
          }

          // refused before it goes, the connection kept: a field could not carry it as it is, and
          // one with a space or a tab first or last the server would read trimmed
          if (credential !== undefined && !isFieldValue(credential)) {
            return Promise.reject(
              new ProgrammerError(
                'a credential holds visible ASCII, spaces and tabs alone, none first or last'
              )
            );
          }

          return createPromise((resolve, reject) => {
            execute(connection.url, {
              body: data as BodyInit,
              headers: {
                ...(credential === undefined ? {} : { authorization: credential }),
                'content-type': BEAD_MEDIA_TYPE,
                [CONNECTION_TOKEN_HEADER]: connection.connectionToken,
              },
              method: 'POST',
              redirect: 'manual',
              signal: connection.controller.signal,
            })
              .then(
                (response) => {
                  // followed all the same: whatever the other place answered goes unheard, and the
                  // connection whose token crossed is lost
                  if (isFollowed(response)) {
                    drain(response);
                    resolve();

                    return (lose(connection, { isReleased: true }), undefined);
                  }

                  if (response.ok) {
                    resolve();

                    return readAnswer(connection, response);
                  }

                  // a redirect's mark is left unread: no refusal of the transport's own is one
                  const refusal = isRedirect(response.status)
                    ? null
                    : response.headers.get(REFUSAL_HEADER);

                  drain(response);

                  // a status nothing marked — a gateway's — or a redirect says nothing of whether the
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
                (reason: unknown) => {
                  // lost before its head: whether the server had it is not known, so it counts as
                  // handed over, and the connection closes, as a dropped socket's
                  resolve();
                  lose(connection, {
                    failure: executorFailureOf(reason, connection.controller.signal),
                    isReleased: true,
                  });
                }
              )
              .catch((reason: unknown) => {
                // a supplied answer can fail as its fields or its body are read, after its head
                resolve();
                lose(connection, {
                  failure:
                    executorFailureOf(reason, connection.controller.signal) ?? toError(reason),
                  isReleased: true,
                });
              });
          });
        },

        [dispose]: () => {
          const connection = drawn;

          rejectConnect?.(new ConnectError('the transport client was disposed as it connected'));
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
