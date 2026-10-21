// ── HTTP transport server ─────────────────────────────────────────────────────

// dependencies

import {
  AFTER_HEADER,
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CLOSE_EVENT,
  CONNECTION_EVENT,
  CONNECTION_TOKEN_HEADER,
  ERROR_EVENT,
  LISTEN_EVENT,
  LISTEN_HEADER,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
  SEQUENCE_HEADER,
  TRANSPORT_HTTP,
  WAIT_HEADER,
} from '../shared/constants';
import { assertHeld, assertHeldFinite, PLATFORM_CLOCK, type TimeoutId } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import { GenericError, ProgrammerError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import type { Data } from '../shared/types';
import {
  assertHosts,
  assertListeningAddress,
  assertOrigins,
  hasVisibleFields,
  isListedOrigin,
  isTakenHost,
  isTakenOrigin,
  originOf,
  ownAuthorityOf,
} from './hosts-and-origins';
import {
  createTransportServer,
  generateHandle,
  type ITransportServerBound,
  LOCALHOST,
  listenOn,
} from './transport-server';
import {
  assertCount,
  boundHeadOf,
  createSendPace,
  droppedOf,
  HEADERS_TIMEOUT,
  type ISendPaceOptions,
  lateOf,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_CONNECTIONS_PER_ADDRESS,
  MINIMUM_SEND_BYTES_PER_SECOND,
  SEND_GRACE_PERIOD,
} from './server-bounds';
import { withPolicy } from './http-policy';
import { clientAddressOf, trustedProxiesOf } from './trusted-proxies';
import { createHTTPRequestExchange, type IExchange } from './http-request-exchange';
import {
  authorityNamedBy,
  countOf,
  closingOf,
  endClosing,
  endWith,
  ENVELOPE_KINDS,
  ENVELOPE_PREFIX,
  hasBody,
  headerOf,
  type IEnd,
  type IExchangeIn,
  isBeadBody,
  linesOf,
  listeningOf,
  preflightOf,
  REFUSALS,
  refuseMalformed,
  RESPONSE_HEADERS,
  sendHead,
  targetOf,
  UNKNOWN_CONNECTION,
} from './http-server-fields';
import type {
  HTTPRequestListener,
  HTTPTransportServer,
  IDrawingRequest,
  IDrawnConnection,
  IHTTPRequestLike,
  IHTTPResponseLike,
  IHTTPServerLike,
  IHTTPSessionLike,
  IHTTPTransportServerOptions,
  ITransportServerAddress,
  ITransportServerStartOptions,
  TransportServerConnectionHandle,
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
  HTTPRequestListener,
  HTTPTransportServer,
  IDrawingRequest,
  IDrawnConnection,
  IHTTPRequestLike,
  IHTTPResponseLike,
  IHTTPServerLike,
  IHTTPTransportServerOptions,
} from './types';
export { ENVELOPE_KINDS, ENVELOPE_PREFIX, REFUSALS } from './http-server-fields';
export { HTTP_POLICY_MEMBERS, httpPolicyOf } from './http-policy';
export type { IHTTPPolicy, IHTTPPolicyInit, IHTTPPolicyOption } from './http-policy';
export {
  HEADERS_TIMEOUT,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_CONNECTIONS_PER_ADDRESS,
  MINIMUM_SEND_BYTES_PER_SECOND,
  SEND_GRACE_PERIOD,
} from './server-bounds';

// interfaces

/** An envelope of the server's own, waiting in its connection's outbox until a listen acknowledges it. */
interface IOutgoing {
  readonly bytes: Uint8Array;
  readonly sequence: number;
}

/** A listen held until something comes for it, or its wait is over. */
interface IListen {
  readonly connection: IDrawn;
  readonly response: IHTTPResponseLike;
  timer: TimeoutId | undefined;
}

/**
 * A connection's own state, which nothing outside the transport reaches: what the registry holds for
 * it, as a socket transport's holds its socket. Events show a frozen copy of its ordinal alone, the
 * token staying here.
 */
interface IDrawn extends IDrawnConnection {
  readonly address: string;
  /** The call ids of the client's a cancel came for before their request, each until it lapses. */
  readonly buried: Map<number, TimeoutId>;
  readonly connectionHandle: TransportServerConnectionHandle;
  readonly connectionToken: string;
  idle: TimeoutId | undefined;
  /** Its client said at connect that it listens: the server may send of its own. */
  readonly isListening: boolean;
  /** The listen held, when one is. */
  listen: IListen | undefined;
  /** The exchanges under way, whatever they carry, listens included: the connection is idle at none. */
  open: number;
  /** What the server sent of its own and no listen acknowledged yet, in order. */
  outbox: IOutgoing[];
  outboxBytes: number;
  /** The number of the last envelope put in the outbox; the first is 1. */
  sequence: number;
  /** The exchanges of requests, by call id, from their first 8 bytes to their answer. */
  readonly waiting: Map<number, IExchange>;
}

// constants

/** The bytes of body the exchanges under way may hold together, by default: 256 MiB. */
export const BODY_BYTES_BUDGET = 268_435_456;

/** How long a body comes, by default, before its rate is held: 5 seconds, Kestrel's grace. */
export const BODY_GRACE_PERIOD = 5_000;

/**
 * The slowest a body may come, by default, once its grace passed: 240 bytes a second, Kestrel's
 * `MinRequestBodyDataRate` (spec 15.12).
 */
export const MINIMUM_BODY_BYTES_PER_SECOND = 240;

/** How long a request handed on waits for its answer, by default: 5 minutes. */
export const EXCHANGE_TIMEOUT = 300_000;

/** How long a connection may go with no exchange under way, by default: 5 minutes. */
export const INACTIVITY_TIMEOUT = 300_000;

/** The largest body by default: a router's largest envelope. */
export const MAXIMUM_BODY_BYTES = 16_778_240;

/** The bytes one connection's outbox holds, by default: two of the largest envelopes. */
export const MAXIMUM_OUTBOX_BYTES = 33_556_480;

/**
 * The longest a listen waits for something to bring back, by default: 30 seconds, under the 60 an
 * intermediary such as nginx gives a request.
 */
export const MAXIMUM_WAIT = 30_000;

/** The requests one connection has waiting at once, by default. */
export const MAXIMUM_WAITING_EXCHANGES = 64;

/** The path the transport answers on, by default. */
export const PATHNAME = '/bead';

/** What an omitted start option resolves to. */
export const START_DEFAULTS = Object.freeze({
  address: LOCALHOST,
  findOpenPort: false,
  port: 80,
} satisfies ITransportServerStartOptions);

/**
 * How long a cancel that came before its request buries that call id: 5 seconds, the least a
 * requester reserves one for. A request that comes later still runs, and its answer is dropped as
 * late by the requester.
 */
export const BURIAL_MILLISECONDS = 5_000;

// a token: 16 bytes from `crypto`, in base64url without padding, as a session's
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[\w-]{22}$/u;

// the length before each envelope of a batch
const LENGTH_BYTES = 4;

// what a listen that brings nothing back ends with
const NOTHING: IEnd = Object.freeze({ status: 204 });

// helpers

// the length an envelope goes after in a batch
const lengthOf = (bytes: Uint8Array): Uint8Array => {
  const length = new Uint8Array(LENGTH_BYTES);

  new DataView(length.buffer).setUint32(0, bytes.length);

  return length;
};

// the envelope a router hands over, as bytes; a string or a Blob it never sends
const bytesOf = (data: Data): Uint8Array | undefined => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : undefined;
};

const drawToken = (): string => {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString('base64url');
};

// a whole number above 0
const assertOption = (name: string, { value }: { value: number }) => {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new ProgrammerError(`${name} is a whole number above 0, not ${String(value)}`);
  }
};

// a timer that keeps no process alive: a browser's has no `unref`
const unref = (timer: TimeoutId): void => {
  (timer as { unref?: () => unknown }).unref?.();
};

// definition

/**
 * A transport server over HTTP, which keeps no connection and so draws one. A `POST` with no body
 * and no token connects: the server draws a 16-byte connection token from `crypto`, emits
 * `connection`, and answers 201 with it in `bead-connection-token`; each exchange after presents the
 * token, and a `DELETE` ends the connection. The router, the sessions and the relays see a
 * connection, as over a socket; the token, a secret, enters no handle, event or report.
 *
 * Each `POST` carries one envelope, of type `application/prs.bead`. The transport reads its layout,
 * kind and call id, and nothing else: a request's exchange waits under its call id — from its first
 * 8 bytes — for the answer the router sends on it, whose head goes out as the request is handed on,
 * so the requester knows the router has it; any other envelope is handed on and its exchange ends
 * 204. A request is handed on with its credential, the `Authorization` field of its `POST` as it
 * came, its surrounding whitespace removed, and none when the field is empty or absent; no other
 * exchange's is read, and a `POST` with two is refused 400. An answer, and what a listen brings
 * back, carry none. A cancel ends the exchange of its call; one that comes before its request
 * buries that call id for {@link BURIAL_MILLISECONDS}. Each refusal of the transport's own is marked
 * in `bead-refusal`. To a page of an origin `origins` names, it answers CORS (spec 15.12): its
 * preflight 204, and every answer once its origin is judged naming it and exposing every field, no
 * credential allowed. An exchange lost — its response closed before the transport ended it — closes
 * the connection, as a socket that drops does; so do a request unanswered past `exchangeTimeout` and
 * a connection idle past `inactivityTimeout`.
 *
 * What the server sends of its own reaches a client that said at connect that it listens —
 * `bead-listen: ?1`, which the 201 says back. It waits in the connection's outbox, numbered, until a
 * listen — a `GET` at the connection's URL, its `bead-after` and `bead-wait` — brings back all that
 * waits, in a batch of `application/prs.bead-batch`, the number of its first in `bead-sequence`;
 * the next listen acknowledges by `bead-after` what its client heard whole, and what it did not
 * comes again, and one without it is refused. A listen waits up to `bead-wait` milliseconds, 0 when
 * left out, no longer than `maximumWait`, for something to bring back; a second takes the first's
 * place. Each listen held, once past its refusals, emits `listen` with `true`, and its end, while
 * its connection stands, `listen` with `false`: the layers above count no silence meanwhile (spec
 * 13.7). An outbox past `maximumOutboxBytes` drops its connection. A connection whose client does
 * not listen carries answers alone: anything else rejects its `send`.
 *
 * `error` tells, with a connection's handle (spec 15.1): a bound it is dropped behind, its outbox
 * past `maximumOutboxBytes` or an answer its socket held past its deadline at
 * `minimumSendBytesPerSecond` past `sendGracePeriod`, a {@link GenericError} naming the bound in the
 * spec's spelling and its value, told once, as its connection ends, its end begun, before its
 * unclean `close`, so a listener that throws keeps nothing open; and what a listener of its events
 * threw, as it threw. A client gone, an exchange lost, or a connection closed past
 * `exchangeTimeout` or `inactivityTimeout` emits no `error`: its unclean `close` tells it.
 *
 * @example
 * const server = createHTTPTransportServer({ createServer: (listener) => createServer(listener) });
 * server.on('message', ({ credential, data }, connectionHandle) => {});
 * const { port } = await server.start({ findOpenPort: true });
 */
export const createHTTPTransportServer = (
  given: IHTTPTransportServerOptions
): HTTPTransportServer => {
  // * a policy's members in its place, each given once, there or beside it
  const options = withPolicy(given);
  const {
    bodyBytesBudget = BODY_BYTES_BUDGET,
    bodyGracePeriod: givenBodyGracePeriod = BODY_GRACE_PERIOD,
    clock = PLATFORM_CLOCK,
    createServer,
    exchangeTimeout: givenExchangeTimeout = EXCHANGE_TIMEOUT,
    headersTimeout: givenHeadersTimeout = HEADERS_TIMEOUT,
    hosts,
    inactivityTimeout: givenInactivityTimeout = INACTIVITY_TIMEOUT,
    maximumBodyBytes = MAXIMUM_BODY_BYTES,
    maximumConnections = MAXIMUM_CONNECTIONS,
    maximumConnectionsPerAddress = MAXIMUM_CONNECTIONS_PER_ADDRESS,
    maximumOutboxBytes = MAXIMUM_OUTBOX_BYTES,
    maximumWait: givenMaximumWait = MAXIMUM_WAIT,
    maximumWaitingExchanges = MAXIMUM_WAITING_EXCHANGES,
    minimumBodyBytesPerSecond = MINIMUM_BODY_BYTES_PER_SECOND,
    minimumSendBytesPerSecond = MINIMUM_SEND_BYTES_PER_SECOND,
    origins = [],
    pathname = PATHNAME,
    secure,
    sendGracePeriod: givenSendGracePeriod = SEND_GRACE_PERIOD,
    trustedProxies,
    unnamedProxies,
  } = options;

  assertOption('bodyBytesBudget', { value: bodyBytesBudget });
  const exchangeTimeout = assertHeld('exchangeTimeout', givenExchangeTimeout);
  const inactivityTimeout = assertHeld('inactivityTimeout', givenInactivityTimeout);
  assertOption('maximumBodyBytes', { value: maximumBodyBytes });
  assertOption('maximumConnections', { value: maximumConnections });
  assertOption('maximumConnectionsPerAddress', { value: maximumConnectionsPerAddress });
  assertOption('maximumOutboxBytes', { value: maximumOutboxBytes });
  const maximumWait = assertHeldFinite('maximumWait', givenMaximumWait);
  assertOption('maximumWaitingExchanges', { value: maximumWaitingExchanges });
  const headersTimeout = assertHeldFinite('headersTimeout', givenHeadersTimeout);
  assertOption('minimumBodyBytesPerSecond', { value: minimumBodyBytesPerSecond });
  const bodyGracePeriod = assertHeldFinite('bodyGracePeriod', givenBodyGracePeriod);
  const pace: ISendPaceOptions = {
    minimumSendBytesPerSecond: assertCount('minimumSendBytesPerSecond', {
      mayBeNone: true,
      value: minimumSendBytesPerSecond,
    }),
    sendGracePeriod: assertHeldFinite('sendGracePeriod', givenSendGracePeriod),
  };
  assertHosts(hosts);
  assertOrigins(origins);
  const proxies = trustedProxiesOf(trustedProxies, { unnamedProxies });

  // what the transport keeps of each connection, by handle
  const drawn = new Map<TransportServerConnectionHandle, IDrawn>();

  const transport = createTransportServer<IDrawnConnection, IDrawingRequest>(
    (server, connections, { isHeard, tell }) => {
      // the servers the start under way, or the last, built and keeps: one an address bound, each
      // by the application's `createServer`, configured alike
      const httpServers = new Set<IHTTPServerLike>();
      let ordinal = 0;
      // the bytes of body the exchanges under way hold, all together, counted as they come
      let bodyBytes = 0;
      // and by token
      const byToken = new Map<string, IDrawn>();
      // the connections each address holds; an address that holds none is not kept
      const perAddress = new Map<string, number>();
      // an HTTP/2 server's sessions, which its close leaves open, each until it ends
      const sessions = new Set<IHTTPSessionLike>();

      const heldBy = (address: string): number => {
        return perAddress.get(address) ?? 0;
      };

      // the client's address: the socket's, in the one form, or, behind the proxies the transport
      // names and counts, the `X-Forwarded-For` entry the walk reaches (spec 15.12)
      const addressOf = (request: IHTTPRequestLike): string | undefined => {
        const { remoteAddress } = request.socket;
        const lines = linesOf(request, 'x-forwarded-for');

        return remoteAddress === undefined
          ? undefined
          : clientAddressOf(remoteAddress, {
              forwarded: lines.length === 0 ? undefined : lines.join(', '),
              trustedProxies: proxies,
            });
      };

      // ends an exchange the transport answers itself, telling a refusal once written (spec 15.1);
      // over HTTP/1, a refusal of a body it will not read closes its socket, in stages, lest the rest
      // read as the next request and so its client reads it as it sends
      const finish = ({ request, response }: IExchangeIn, end: IEnd): void => {
        const isClosing = end.status >= 400 && request.httpVersionMajor === 1 && hasBody(request);
        const { reason, status } = end;
        // read before the end is written, which may close its socket
        const refusal =
          reason === undefined || !isHeard(REFUSAL_EVENT)
            ? undefined
            : {
                address: addressOf(request),
                authority: authorityNamedBy(request)?.authority,
                origin: originOf(linesOf(request, 'origin')),
                port: request.socket.remotePort ?? 0,
                reason,
                status,
              };

        if (isClosing) {
          endClosing({ request, response }, end);
        } else {
          endWith(response, end);
        }

        if (refusal !== undefined) {
          tell(REFUSAL_EVENT, [refusal]);
        }
      };

      // a connection idle — no exchange under way — closes past its timeout
      const rest = (connection: IDrawn): void => {
        clock.clearTimeout(connection.idle);
        connection.idle = undefined;

        if (inactivityTimeout === Infinity || connection.open > 0) {
          return;
        }

        connection.idle = clock.setTimeout(() => {
          closeDrawn(connection, false);
        }, inactivityTimeout);
        unref(connection.idle);
      };

      // a connection's end begun, false once begun already: out of the registry, each exchange still
      // waiting told by the marked 404 until its request is handed on, then by its socket cut after
      // its head, as a lost exchange's: a request handed on ran, which no refusal may deny
      const takeDrawn = (connection: IDrawn): boolean => {
        const { address, connectionHandle, connectionToken } = connection;

        if (drawn.get(connectionHandle) !== connection) {
          return false;
        }

        drawn.delete(connectionHandle);
        byToken.delete(connectionToken);
        connections.delete(connectionHandle);
        const others = heldBy(address) - 1;

        if (others === 0) {
          perAddress.delete(address);
        } else {
          perAddress.set(address, others);
        }
        clock.clearTimeout(connection.idle);

        for (const burial of connection.buried.values()) {
          clock.clearTimeout(burial);
        }

        connection.buried.clear();

        for (const exchange of connection.waiting.values()) {
          exchange.isEnded = true;
          clock.clearTimeout(exchange.timer);

          if (exchange.isDelivered) {
            sendHead(exchange.response);
          }

          // * one whose body still comes is answered before it is whole: its socket closes in stages
          if (exchange.response.headersSent) {
            exchange.response.destroy();
          } else {
            endClosing(exchange, UNKNOWN_CONNECTION);
          }
        }

        connection.waiting.clear();
        connection.outbox = [];
        connection.outboxBytes = 0;

        if (connection.listen !== undefined) {
          answer(connection.listen, UNKNOWN_CONNECTION);
        }

        return true;
      };

      const closeDrawn = (connection: IDrawn, isClean: boolean): void => {
        if (takeDrawn(connection)) {
          tell(CLOSE_EVENT, [isClean, connection.connectionHandle]);
        }
      };

      // ! a connection behind its bounds is dropped, its close unclean, then reported, naming the
      // bound, so an operator tells it from a network that failed; once, as it ends, and its close
      // told even when a listener of `error` throws, which is Node's (spec 15.1)
      const drop = (connection: IDrawn, why: string): void => {
        const { connectionHandle } = connection;

        if (!takeDrawn(connection)) {
          return;
        }

        try {
          server.emit(ERROR_EVENT, droppedOf(connectionHandle, why), connectionHandle);
        } finally {
          tell(CLOSE_EVENT, [false, connectionHandle]);
        }
      };

      // an answer's bytes, held to the pace its socket takes them at; `late` hears, naming the
      // bound, once its socket still holds them past their deadline
      const paceAnswer = (
        response: IHTTPResponseLike,
        { bytes, late }: { bytes: number; late: (why: string) => void }
      ): void => {
        if (response.writableFinished) {
          return;
        }

        const paced = createSendPace(
          {
            late: () => {
              late(lateOf(pace));
            },
            unsent: () => {
              return response.writableFinished ? 0 : Math.max(1, response.writableLength ?? 1);
            },
          },
          pace
        );

        paced.hand(bytes);
        response.on('close', () => {
          paced.stop();
        });
      };

      // a listen ends: with what waits for it, as a batch, or, nothing waiting, with `end`
      const answer = (listen: IListen, end: IEnd): void => {
        const { connection, response } = listen;
        const { outbox } = connection;

        if (connection.listen === listen) {
          connection.listen = undefined;
        }

        clock.clearTimeout(listen.timer);

        if (outbox.length === 0) {
          return (endWith(response, end), undefined);
        }

        // what waits follows what was acknowledged, one by one: the first is the last minus the rest
        const length = outbox.reduce((total, { bytes }) => {
          return total + LENGTH_BYTES + bytes.length;
        }, 0);

        response.writeHead(200, {
          ...RESPONSE_HEADERS,
          'content-length': String(length),
          'content-type': BEAD_BATCH_MEDIA_TYPE,
          [SEQUENCE_HEADER]: String(connection.sequence - outbox.length + 1),
        });

        for (const { bytes } of outbox) {
          response.write(lengthOf(bytes));
          response.write(bytes);
        }

        response.end();
        // ! held to its pace: one past its deadline is an answer that could not be written, its
        // exchange lost, which drops its connection at both ends (spec 15.7, 15.12)
        paceAnswer(response, {
          bytes: length,
          late: (why) => {
            response.destroy();
            drop(connection, why);
          },
        });
      };

      // an envelope of the server's own waits in its connection's outbox, numbered, for a listen to
      // bring it back; past the outbox's bound the connection is dropped, its client behind (spec
      // 15.9)
      const enqueue = (connection: IDrawn, bytes: Uint8Array): void => {
        if (connection.outboxBytes + bytes.length > maximumOutboxBytes) {
          return (
            drop(
              connection,
              `its outbox would pass maximumOutboxBytes, ${String(maximumOutboxBytes)} bytes`
            ),
            undefined
          );
        }

        connection.sequence += 1;
        connection.outbox.push({ bytes: bytes.slice(), sequence: connection.sequence });
        connection.outboxBytes += bytes.length;

        if (connection.listen !== undefined) {
          answer(connection.listen, NOTHING);
        }
      };

      // a listen: what it acknowledges goes, and it brings back what is left — at once, or once
      // something comes within its wait. One listen at a time: a second ends the first, empty, and
      // takes its place. A listen its client loses closes nothing: what it carried comes again.
      const listen = (exchange: IExchangeIn, connection: IDrawn): void => {
        const { request, response } = exchange;
        const after = countOf(request, AFTER_HEADER, { isRequired: true });
        const wait = countOf(request, WAIT_HEADER);

        if (!connection.isListening) {
          return (finish(exchange, { reason: REFUSALS.LISTEN_UNDECLARED, status: 409 }), undefined);
        }

        if (
          hasBody(request) ||
          after === undefined ||
          wait === undefined ||
          after > connection.sequence
        ) {
          return (finish(exchange, { reason: REFUSALS.MALFORMED, status: 400 }), undefined);
        }

        const kept = connection.outbox.filter(({ sequence }) => {
          return sequence > after;
        });
        const held: IListen = { connection, response, timer: undefined };
        const client = connections.get(connection.connectionHandle);

        connection.outbox = kept;
        connection.outboxBytes = kept.reduce((total, { bytes }) => {
          return total + bytes.length;
        }, 0);
        connection.open += 1;
        clock.clearTimeout(connection.idle);

        if (client !== undefined) {
          client.lastActivity = clock.Date.now();
        }

        response.on('close', () => {
          clock.clearTimeout(held.timer);

          if (connection.listen === held) {
            connection.listen = undefined;
          }

          connection.open -= 1;

          if (drawn.get(connection.connectionHandle) === connection) {
            rest(connection);
            tell(LISTEN_EVENT, [false, connection.connectionHandle]);
          }
        });
        // said before the listen it replaces ends, so a second keeps its connection held throughout
        tell(LISTEN_EVENT, [true, connection.connectionHandle]);

        if (connection.listen !== undefined) {
          answer(connection.listen, NOTHING);
        }

        if (connection.outbox.length > 0 || wait === 0) {
          return (answer(held, NOTHING), undefined);
        }

        connection.listen = held;
        held.timer = clock.setTimeout(
          () => {
            answer(held, NOTHING);
          },
          Math.min(wait, maximumWait)
        );
        unref(held.timer);
      };

      // a cancel that came before its request: the request, when it comes, is dropped; only the
      // client's call ids, and so many as a connection has requests waiting
      const bury = (connection: IDrawn, callId: number): void => {
        if (callId % 2 === 0 || connection.buried.size >= maximumWaitingExchanges) {
          return;
        }

        clock.clearTimeout(connection.buried.get(callId));

        const burial = clock.setTimeout(() => {
          connection.buried.delete(callId);
        }, BURIAL_MILLISECONDS);

        unref(burial);
        connection.buried.set(callId, burial);
      };

      const onConnect = (exchange: IExchangeIn): void => {
        const { request } = exchange;
        const address = addressOf(request);
        const isListening = listeningOf(request);

        // a connect carries no body, and says whether it listens in the one way; a socket already
        // gone reports no address
        if (hasBody(request) || address === undefined || isListening === undefined) {
          return (finish(exchange, { reason: REFUSALS.MALFORMED, status: 400 }), undefined);
        }

        // none is drawn once a stop began, as none past the bounds: busy, told when to come back
        if (
          server.isClosing() ||
          server.isClosed() ||
          drawn.size >= maximumConnections ||
          heldBy(address) >= maximumConnectionsPerAddress
        ) {
          const busy = { headers: { 'retry-after': '1' }, reason: REFUSALS.BUSY, status: 503 };

          return (finish(exchange, busy), undefined);
        }

        const connectionToken = drawToken();
        const connectionHandle = generateHandle({
          ip: address,
          ordinal: (ordinal += 1),
          type: TRANSPORT_HTTP,
        });
        const connection: IDrawn = {
          address,
          buried: new Map(),
          connectionHandle,
          connectionToken,
          idle: undefined,
          isListening,
          listen: undefined,
          open: 0,
          ordinal,
          outbox: [],
          outboxBytes: 0,
          sequence: 0,
          waiting: new Map(),
        };
        // what its events show of it: the order it was drawn in, and what drew it, headers aside —
        // a frozen copy, never the state the registry holds, which keeps the token
        const shown: IDrawnConnection = Object.freeze({ ordinal });
        const drawing: IDrawingRequest = Object.freeze({
          method: request.method,
          remoteAddress: address,
          remotePort: request.socket.remotePort,
          url: request.url,
        });

        drawn.set(connectionHandle, connection);
        byToken.set(connectionToken, connection);
        perAddress.set(address, heldBy(address) + 1);
        connections.set(connectionHandle, {
          address,
          connectionHandle,
          lastActivity: undefined,
          port: request.socket.remotePort ?? 0,
          socket: connection,
          type: TRANSPORT_HTTP,
        });
        rest(connection);

        // a listener meets the connection registered, before its client has its token
        tell(CONNECTION_EVENT, [shown, drawing, connectionHandle]);

        // the listen taken, said back, so a client whose header something on the way dropped never
        // listens where it would be refused
        const drew = {
          headers: {
            [CONNECTION_TOKEN_HEADER]: connectionToken,
            ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
          },
          status: 201,
        };

        return (finish(exchange, drew), undefined);
      };

      const { receive } = createHTTPRequestExchange<IDrawn>(
        {
          admitExchange: (connection) => {
            return connection.open < 2 * maximumWaitingExchanges;
          },
          createExchange: ({ request, response }) => {
            return {
              isCancelled: false,
              isDelivered: false,
              isEnded: false,
              prefix: undefined,
              request,
              response,
              timer: undefined,
            };
          },
          beginExchange: (connection) => {
            connection.open += 1;
            clock.clearTimeout(connection.idle);

            const client = connections.get(connection.connectionHandle);

            if (client !== undefined) {
              client.lastActivity = clock.Date.now();
            }
          },
          chargeBody: (count) => {
            bodyBytes += count;

            return bodyBytes > bodyBytesBudget;
          },
          releaseBody: (count) => {
            bodyBytes -= count;
          },
          endExchange: (connection) => {
            connection.open -= 1;

            if (drawn.get(connection.connectionHandle) === connection) {
              rest(connection);
            }
          },
          endEarly: (connection, state) => {
            state.isEnded = true;
            clock.clearTimeout(state.timer);

            const { prefix } = state;

            if (prefix !== undefined && connection.waiting.get(prefix.callId) === state) {
              connection.waiting.delete(prefix.callId);
            }
          },
          classify: (connection, state, { layout, prefix }) => {
            const { callId, kind } = prefix;

            if (layout < ENVELOPE_PREFIX.firstLayout || layout > ENVELOPE_PREFIX.lastLayout) {
              return { reason: REFUSALS.MALFORMED, status: 400 };
            }

            if (kind !== ENVELOPE_KINDS.REQUEST) {
              state.prefix = prefix;

              return undefined;
            }

            // a client's call ids are odd, and none is 0
            if (callId % 2 === 0) {
              return { reason: REFUSALS.MALFORMED, status: 400 };
            }

            if (connection.waiting.has(callId)) {
              return { reason: REFUSALS.CALL_WAITING, status: 409 };
            }

            if (connection.waiting.size >= maximumWaitingExchanges) {
              return { reason: REFUSALS.BUSY, status: 429 };
            }

            state.prefix = prefix;

            if (connection.buried.has(callId)) {
              clock.clearTimeout(connection.buried.get(callId));
              connection.buried.delete(callId);
              state.isCancelled = true;
            }

            connection.waiting.set(callId, state);

            return undefined;
          },
          prefixOf: (state) => {
            return state.prefix;
          },
          isEnded: (state) => {
            return state.isEnded;
          },
          isCancelled: (state) => {
            return state.isCancelled;
          },
          lose: (connection, state) => {
            clock.clearTimeout(state.timer);

            if (!state.isEnded) {
              closeDrawn(connection, false);
            }
          },
          finishBody: (connection, state) => {
            if (state.isEnded) {
              return 'ended';
            }

            if (drawn.get(connection.connectionHandle) !== connection) {
              state.isEnded = true;

              return 'gone';
            }

            return 'continue';
          },
          beginHandOff: (state) => {
            state.isDelivered = true;
          },
          waitAfterHandOff: (connection, state, { callId }) => {
            return connection.waiting.get(callId) === state;
          },
          armExchangeTimer: (connection, state) => {
            if (exchangeTimeout !== Infinity) {
              state.timer = clock.setTimeout(() => {
                closeDrawn(connection, false);
              }, exchangeTimeout);
              unref(state.timer);
            }
          },
          message: (connection, message) => {
            tell(MESSAGE_EVENT, [message, connection.connectionHandle]);
          },
          // * the exchange's own, whichever socket or proxy brought its connect (spec 15.1)
          originOf: (request) => {
            return { address: addressOf(request), port: request.socket.remotePort };
          },
          cancel: (connection, callId) => {
            const cancelled = connection.waiting.get(callId);

            // a cancel is never answered: the exchange of its call ends empty — a 200 with no body
            // once its head went — or, its body still coming, once whole; one that has not come is
            // buried
            if (cancelled === undefined) {
              bury(connection, callId);
            } else if (cancelled.isDelivered) {
              connection.waiting.delete(callId);
              cancelled.isEnded = true;
              clock.clearTimeout(cancelled.timer);

              return cancelled.response;
            } else {
              cancelled.isCancelled = true;
            }

            return undefined;
          },
          finish,
        },
        { bodyGracePeriod, clock, maximumBodyBytes, minimumBodyBytesPerSecond }
      );

      const onExchange: HTTPRequestListener = (request, response) => {
        const exchange = { request, response };

        // * a field of a control character but a tab, of an octet past ASCII, or padded at either
        // end, before anything else: Node's parser answers the first itself, and drops a padded one
        // over HTTP/2 unless `strictFieldWhitespaceValidation` is false
        if (!hasVisibleFields(request.rawHeaders)) {
          return (refuseMalformed(exchange), undefined);
        }

        const named = authorityNamedBy(request);

        if (named === undefined) {
          return (refuseMalformed(exchange), undefined);
        }

        const { authority } = named;

        if (!isTakenHost(authority, hosts)) {
          return (finish(exchange, { reason: REFUSALS.HOST, status: 403 }), undefined);
        }

        if (targetOf(request)?.path !== pathname) {
          return (finish(exchange, { reason: REFUSALS.PATH, status: 404 }), undefined);
        }

        // an exchange from the server's own origin, by a host it takes by name, or one it was told;
        // one with no `Origin` comes from anywhere, and any client that sends one is judged by it
        const origin = headerOf(request, 'origin');

        if (!isTakenOrigin(origin, { host: ownAuthorityOf(authority, hosts), origins })) {
          return (finish(exchange, { reason: REFUSALS.ORIGIN, status: 403 }), undefined);
        }

        // the origin the server answers CORS to, as it came: one `origins` names
        const listed = isListedOrigin(origin, origins) ? origin : undefined;

        // * every answer a page `origins` names can read carries it, a refusal's too, which its
        // client reads; a refusal judged before the origin answers a preflight no browser reads. The
        // writers' `writeHead` merges it
        if (listed !== undefined) {
          response.setHeader('access-control-allow-origin', listed);
          response.setHeader('access-control-expose-headers', '*');
        }

        // a preflight is no refusal: `endWith`, never `finish`, so nothing tells it
        if (
          listed !== undefined &&
          request.method === 'OPTIONS' &&
          headerOf(request, 'access-control-request-method') !== undefined
        ) {
          return (endWith(response, preflightOf(request)), undefined);
        }

        if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
          const refused = {
            headers: { allow: 'GET, POST, DELETE' },
            reason: REFUSALS.METHOD,
            status: 405,
          };

          return (finish(exchange, refused), undefined);
        }

        const connectionToken = headerOf(request, CONNECTION_TOKEN_HEADER);

        if (connectionToken === undefined && request.method === 'POST') {
          if (!isBeadBody(request)) {
            return (finish(exchange, { reason: REFUSALS.TYPE, status: 415 }), undefined);
          }

          return (onConnect(exchange), undefined);
        }

        if (connectionToken === undefined || !TOKEN_PATTERN.test(connectionToken)) {
          return (finish(exchange, { reason: REFUSALS.MALFORMED, status: 400 }), undefined);
        }

        // none is held once a stop began: an exchange learns its connection is gone, as the stop's
        // close would tell it, nothing of it handed on
        const connection =
          server.isClosing() || server.isClosed() ? undefined : byToken.get(connectionToken);

        if (connection === undefined) {
          return (finish(exchange, UNKNOWN_CONNECTION), undefined);
        }

        if (request.method === 'DELETE') {
          closeDrawn(connection, true);

          return (finish(exchange, { status: 204 }), undefined);
        }

        if (request.method === 'GET') {
          return (listen(exchange, connection), undefined);
        }

        if (!isBeadBody(request)) {
          return (finish(exchange, { reason: REFUSALS.TYPE, status: 415 }), undefined);
        }

        return (receive(exchange, connection), undefined);
      };

      return {
        clock,
        defaults: START_DEFAULTS,
        // a server under TLS has its contexts, as Node's https and its HTTP/2 secure server do; each
        // the application builds is built alike, so the first stands for every one
        get isSecure() {
          const [first] = httpServers;

          return typeof (first as { addContext?: unknown } | undefined)?.addContext === 'function';
        },
        secure,
        type: TRANSPORT_HTTP,

        start: async ({ address, findOpenPort, port, signal }) => {
          assertListeningAddress(address);

          // each address bound has its server, built once, and what its `error` is told to: a port
          // drawn again listens again on the servers built, never asking the application for another
          const built = new Map<
            string,
            { instance: IHTTPServerLike; onError: (error: Error) => void }
          >();

          const builtOn = (host: string) => {
            const known = built.get(host);

            if (known !== undefined) {
              return known;
            }

            const instance = createServer(onExchange, { address: host });

            // * its head within `headersTimeout`, judged each second, its 408 the server's own; no
            // time for the whole request, which a body's rate holds instead (spec 15.12)
            boundHeadOf(instance, headersTimeout);

            const entry = {
              instance,
              onError: (error: Error): void => {
                server.emit(ERROR_EVENT, error, '');
              },
            };

            built.set(host, entry);
            entry.instance.on(ERROR_EVENT, (error) => {
              entry.onError(error);
            });
            entry.instance.on('session', (session) => {
              sessions.add(session);
              session.once('close', () => {
                sessions.delete(session);
              });
            });

            return entry;
          };

          const bind = (host: string, given: number): Promise<ITransportServerBound> => {
            return createPromise((resolve, reject) => {
              const entry = builtOn(host);
              const { instance } = entry;

              const release = (): void => {
                httpServers.delete(instance);
                instance.close();
              };

              httpServers.add(instance);

              // an error before it listens fails the bind; after, the server reports it
              entry.onError = (error) => {
                release();
                reject(error);
              };

              instance.listen(given, host, () => {
                const addressInfo = instance.address();

                entry.onError = (error) => {
                  server.emit(ERROR_EVENT, error, '');
                };

                resolve({
                  close: release,
                  port:
                    typeof addressInfo === 'object' && addressInfo !== null
                      ? addressInfo.port
                      : port,
                });
              });
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
            // an error before listening, or an abort: close what was opened, listening or not
            for (const instance of httpServers) {
              instance.close();
            }

            httpServers.clear();

            throw reason;
          }
        },

        stop: () => {
          const stopped = [...httpServers];

          httpServers.clear();

          for (const connection of drawn.values()) {
            closeDrawn(connection, false);
          }

          // the port is free once `close` returns; its callback, which waits on keep-alive sockets
          // and HTTP/2 sessions, is not awaited, and those are ended where the server can
          for (const instance of stopped) {
            instance.close();
            instance.closeAllConnections?.();
          }

          for (const session of sessions) {
            session.close();
          }

          sessions.clear();

          return Promise.resolve();
        },

        // what it keeps of its connections, at its ceilings where it has them
        gauges: () => {
          const kept = {
            buriedCallIds: 0,
            largestAddressConnections: 0,
            largestOutboxBytes: 0,
            listens: 0,
            outboxBytes: 0,
            outboxEnvelopes: 0,
            waitingExchanges: 0,
          };

          for (const connection of drawn.values()) {
            kept.buriedCallIds += connection.buried.size;
            kept.largestOutboxBytes = Math.max(kept.largestOutboxBytes, connection.outboxBytes);
            kept.listens += connection.listen === undefined ? 0 : 1;
            kept.outboxBytes += connection.outboxBytes;
            kept.outboxEnvelopes += connection.outbox.length;
            kept.waitingExchanges += connection.waiting.size;
          }

          // * the busiest address, under its ceiling: a proxy left off `trustedProxies` holds every
          // connection, and the health warns before its first 503
          for (const held of perAddress.values()) {
            kept.largestAddressConnections = Math.max(kept.largestAddressConnections, held);
          }

          return gaugesOf({
            ceilings: {
              bodyBytes: bodyBytesBudget,
              connections: maximumConnections,
              largestAddressConnections: maximumConnectionsPerAddress,
              largestOutboxBytes: maximumOutboxBytes,
            },
            connectionHandles: drawn.keys(),
            counts: {
              ...kept,
              addresses: perAddress.size,
              bodyBytes,
              http2Sessions: sessions.size,
            },
          });
        },

        // the registry holds what `connect` put there: the connection's own state
        close: ({ socket }) => {
          closeDrawn(socket as IDrawn, true);

          return Promise.resolve();
        },

        // an answer ends the exchange of its request; anything else — a late answer too — waits for
        // a listen, when its client listens
        // neither carries a credential: the router fails a command that presents one before it
        // goes, DESTINATION_UNREACHABLE (decision 0010)
        send: ({ data }, { socket }) => {
          const bytes = bytesOf(data);

          if (bytes === undefined || bytes.length < ENVELOPE_PREFIX.bytes) {
            return Promise.reject(
              new ProgrammerError('an HTTP exchange carries one envelope, as bytes')
            );
          }

          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const kind = view.getUint8(1);
          const callId = view.getUint32(4);
          const connection = socket as IDrawn;
          const isAnswer = kind === ENVELOPE_KINDS.RESULT || kind === ENVELOPE_KINDS.FAILURE;
          const exchange = isAnswer ? connection.waiting.get(callId) : undefined;

          if (exchange === undefined) {
            if (connection.isListening) {
              enqueue(connection, bytes);

              return Promise.resolve();
            }

            if (isAnswer) {
              return Promise.resolve();
            }

            return Promise.reject(
              new GenericError(
                `this connection does not listen: an envelope of kind 0x${kind.toString(16)} goes nowhere`
              )
            );
          }

          connection.waiting.delete(callId);
          exchange.isEnded = true;
          clock.clearTimeout(exchange.timer);

          const { response } = exchange;

          return createPromise((resolve, reject) => {
            response.on('finish', () => {
              resolve();
            });
            response.on('close', () => {
              if (!response.writableFinished) {
                reject(new GenericError('the exchange closed before its answer went out'));
              }
            });

            if (!response.headersSent) {
              response.writeHead(200, {
                ...RESPONSE_HEADERS,
                ...closingOf(exchange),
                'content-length': String(bytes.length),
                'content-type': BEAD_MEDIA_TYPE,
              });
            }

            response.end(bytes);
            // ! held to its pace: one past its deadline is an answer that could not be written,
            // its exchange lost, which drops its connection at both ends (spec 15.7, 15.12)
            paceAnswer(response, {
              bytes: bytes.length,
              late: (why) => {
                response.destroy();
                drop(connection, why);
              },
            });
          });
        },
      };
    }
  );

  return Object.assign(transport, {
    isTwoWay: (connectionHandle: TransportServerConnectionHandle) => {
      return drawn.get(connectionHandle)?.isListening === true;
    },
  });
};
