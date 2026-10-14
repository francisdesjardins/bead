// ── HTTP transport server ─────────────────────────────────────────────────────

// dependencies

import {
  AFTER_HEADER,
  BEAD_BATCH_MEDIA_TYPE,
  BEAD_MEDIA_TYPE,
  CLOSE_EVENT,
  CONNECTION_EVENT,
  CONNECTION_TOKEN_HEADER,
  CONNECTION_UNKNOWN,
  ERROR_EVENT,
  LISTEN_EVENT,
  LISTEN_HEADER,
  MESSAGE_EVENT,
  REFUSAL_EVENT,
  REFUSAL_HEADER,
  SEQUENCE_HEADER,
  TRANSPORT_HTTP,
  WAIT_HEADER,
} from '../shared/constants';
import { assertHeld, assertHeldFinite, PLATFORM_CLOCK, type TimeoutId } from '../shared/clock';
import { createPromise } from '../shared/create-promise';
import { GenericError, ProgrammerError } from '../shared/errors';
import { gaugesOf } from '../shared/gauges';
import { BARE_ITEM_TYPES, type BareItem, parseItem } from '../shared/structured-fields';
import type { Data } from '../shared/types';
import {
  assertHosts,
  assertListeningAddress,
  assertOrigins,
  authorityOf,
  credentialOf,
  hasVisibleFields,
  HOST_REFUSAL,
  isAuthority,
  isListedOrigin,
  isTakenHost,
  isTakenOrigin,
  type IAuthority,
  ORIGIN_REFUSAL,
  originOf,
  ownAuthorityOf,
  requestTargetOf,
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

// interfaces

/** An exchange as the listener meets it: its request, and the response it writes. */
interface IExchangeIn {
  request: IHTTPRequestLike;
  response: IHTTPResponseLike;
}

/** How an exchange ends, when the transport ends it: its status, its reason, its headers. */
interface IEnd {
  headers?: Record<string, string> | undefined;
  /** The reason a refusal of the transport's own is marked with; none for a 201 or a 204. */
  reason?: string | undefined;
  status: number;
}

/** An exchange of a request, from its first 8 bytes to its answer. */
interface IExchange {
  /** A cancel came for it while its body was still coming: it is read to its end, then 204. */
  isCancelled: boolean;
  /** Its request went on to the router, which owes it an answer. */
  isDelivered: boolean;
  /** The transport ended it — an answer, a 204, a refusal, its connection closed — so its close is no loss. */
  isEnded: boolean;
  readonly response: IHTTPResponseLike;
  /** Ends its connection, as lost, once its request waited past `exchangeTimeout` for its answer. */
  timer: TimeoutId | undefined;
}

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

/** A body as it comes: one buffer it grows into, so no chunk it came in is kept. */
interface IBody {
  bytes: Uint8Array;
  length: number;
}

// constants

/** The bytes of body the exchanges under way may hold together, by default: 256 MiB. */
export const BODY_BYTES_BUDGET = 268_435_456;

/** How long a request handed on waits for its answer, by default: 5 minutes. */
export const EXCHANGE_TIMEOUT = 300_000;

/** How long a connection may go with no exchange under way, by default: 5 minutes. */
export const INACTIVITY_TIMEOUT = 300_000;

/** The largest body by default: a router's largest envelope. */
export const MAXIMUM_BODY_BYTES = 16_778_240;

/** The connections drawn at once, by default. */
export const MAXIMUM_CONNECTIONS = 10_000;

/** The connections one address holds at once, by default. */
export const MAXIMUM_CONNECTIONS_PER_ADDRESS = 64;

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
 * What the transport reads of an envelope, and nothing else (0020), in the prefix 0001 lays out and
 * every layout from 0xA1 to 0xAF keeps: the layout in its first byte, the kind in its second, the
 * call id in its fifth to eighth.
 */
export const ENVELOPE_PREFIX = Object.freeze({
  bytes: 8,
  firstLayout: 0xa1,
  lastLayout: 0xaf,
});

/** The kinds the transport tells apart: a request waits for its answer; a cancel ends one. */
export const ENVELOPE_KINDS = Object.freeze({
  REQUEST: 0x10,
  RESULT: 0x11,
  FAILURE: 0x12,
  CANCEL: 0x16,
});

/**
 * How long a cancel that came before its request buries that call id: 5 seconds, the least a
 * requester reserves one for. A request that comes later still runs, and its answer is dropped as
 * late by the requester.
 */
export const BURIAL_MILLISECONDS = 5_000;

/** The reasons each refusal of the transport's own is marked with, in `bead-refusal`. */
export const REFUSALS = Object.freeze({
  BUSY: 'busy',
  CALL_WAITING: 'call-waiting',
  CONNECTION_UNKNOWN,
  HOST: HOST_REFUSAL,
  LISTEN_UNDECLARED: 'listen-undeclared',
  MALFORMED: 'malformed',
  METHOD: 'method-refused',
  ORIGIN: ORIGIN_REFUSAL,
  PATH: 'path-unknown',
  TOO_LARGE: 'too-large',
  TYPE: 'type-refused',
});

// a token: 16 bytes from `crypto`, in base64url without padding, as a session's
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[\w-]{22}$/u;

// what a body is first given room for, before it grows
const FIRST_BODY_BYTES = 65_536;

// the length before each envelope of a batch
const LENGTH_BYTES = 4;

// what a listen that brings nothing back ends with
const NOTHING: IEnd = Object.freeze({ status: 204 });

// what every response on the path carries: never stored, never sniffed, and which one a request
// gets turns on its Origin; HTTP's own 400 carries none of these
const RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  vary: 'Origin',
  'x-content-type-options': 'nosniff',
});

// what a preflight's answer from an origin `origins` names (spec 15.12) carries whatever method it
// asks for: the browser judges its request against it
const PREFLIGHT = Object.freeze({
  'access-control-allow-methods': 'GET, POST, DELETE',
  'access-control-max-age': '7200',
});

// HTTP/2's error code of a malformed request, which resets its stream (RFC 9113 §7, §8.1.1)
const PROTOCOL_ERROR = 0x1;

// the 404 that tells a client its connection is gone
const UNKNOWN_CONNECTION: IEnd = Object.freeze({
  reason: REFUSALS.CONNECTION_UNKNOWN,
  status: 404,
});

// helpers

const headerOf = (request: IHTTPRequestLike, name: string): string | undefined => {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
};

// the path a request names, an absolute-form target's among them, its query read by no exchange;
// none for a target HTTP refuses
const targetOf = (request: IHTTPRequestLike): { path: string } | undefined => {
  const target = requestTargetOf(request.url);

  return target === undefined ? undefined : { path: target.path };
};

// the length an envelope goes after in a batch
const lengthOf = (bytes: Uint8Array): Uint8Array => {
  const length = new Uint8Array(LENGTH_BYTES);

  new DataView(length.buffer).setUint32(0, bytes.length);

  return length;
};

// whether a request says it has a body: a length above 0, as RFC 9110 §8.6 reads its digits, or a
// transfer coding
const hasBody = (request: IHTTPRequestLike): boolean => {
  return (
    Number(headerOf(request, 'content-length') ?? '0') > 0 ||
    headerOf(request, 'transfer-encoding') !== undefined
  );
};

// the values of every line of the field `name` a request carries, as they came: `headers` keeps
// the first of two, so they are counted where each stands
const linesOf = (request: IHTTPRequestLike, name: string): string[] => {
  const values: string[] = [];
  const { rawHeaders } = request;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }

  return values;
};

// a field a request carries read as an Item of RFC 9651, its lines joined by `, ` first (§4.2, RFC
// 9110 §5.3): its bare item, its parameters ignored (§2.3); `null` when the request carries none,
// `undefined` when it does not parse, two lines of it among them
const bareItemOf = (request: IHTTPRequestLike, name: string): BareItem | null | undefined => {
  const lines = linesOf(request, name);

  return lines.length === 0 ? null : parseItem(lines.join(', '))?.bareItem;
};

// a count a listen gives (spec 15.9): an Integer of 0 or more, anything else none; left out, 0, or
// none where it `isRequired`
const countOf = (
  request: IHTTPRequestLike,
  name: string,
  { isRequired = false }: { isRequired?: boolean } = {}
): number | undefined => {
  const bareItem = bareItemOf(request, name);

  if (bareItem === null) {
    return isRequired ? undefined : 0;
  }

  return bareItem?.type === BARE_ITEM_TYPES.INTEGER && bareItem.value >= 0
    ? bareItem.value
    : undefined;
};

// whether a connect says its client listens: a Boolean, absent being false; anything else is none
const listeningOf = (request: IHTTPRequestLike): boolean | undefined => {
  const bareItem = bareItemOf(request, LISTEN_HEADER);

  if (bareItem === null) {
    return false;
  }

  return bareItem?.type === BARE_ITEM_TYPES.BOOLEAN ? bareItem.value : undefined;
};

// a preflight's answer (spec 15.12): `authorization`, which no wildcard covers (Fetch §4.8); the
// names asked, for a browser that caches names and no wildcard; then `*`. No `Vary` names what was
// asked: no cache stores an answer to `OPTIONS` (RFC 9110 §9.3.7)
const preflightOf = (request: IHTTPRequestLike): IEnd => {
  const asked = linesOf(request, 'access-control-request-headers').join(', ');
  const allowed = ['authorization', ...(asked === '' ? [] : [asked]), '*'];

  return {
    headers: { ...PREFLIGHT, 'access-control-allow-headers': allowed.join(', ') },
    status: 204,
  };
};

// a request's authority (spec 15.12): over HTTP/2, its `:authority`, else its `host`, judged by
// its form; over HTTP/1, as `authorityOf` reads it. None for what HTTP refuses of its own
const authorityNamedBy = (request: IHTTPRequestLike): IAuthority | undefined => {
  if (request.httpVersionMajor !== 1) {
    const authority = headerOf(request, ':authority') ?? headerOf(request, 'host');

    return authority === undefined || isAuthority(authority) ? { authority } : undefined;
  }

  return authorityOf(linesOf(request, 'host'), {
    isRequired: request.httpVersion === '1.1',
    target: requestTargetOf(request.url),
  });
};

// a body of Bead's media type, parameters aside, sent as it is
const isBeadBody = (request: IHTTPRequestLike): boolean => {
  const type = headerOf(request, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  const encoding = headerOf(request, 'content-encoding')?.trim().toLowerCase();

  return type === BEAD_MEDIA_TYPE && (encoding === undefined || encoding === 'identity');
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

// a chunk copied into the body, which doubles its room as it needs, up to `limit`
const append = (body: IBody, { chunk, limit }: { chunk: Uint8Array; limit: number }): void => {
  const length = body.length + chunk.length;

  if (length > body.bytes.length) {
    const grown = new Uint8Array(Math.min(Math.max(length, 2 * body.bytes.length), limit));

    grown.set(body.bytes.subarray(0, body.length));
    body.bytes = grown;
  }

  body.bytes.set(chunk, body.length);
  body.length = length;
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

// writes an exchange's end, once: its status and headers, marked when it is a refusal
// ! never tells: the 404 of a connection that closes is section 15.7's close, told by `close`, and
// no refusal; a refusal the transport judges goes through `finish`, which tells it
const endWith = (response: IHTTPResponseLike, { headers, reason, status }: IEnd): void => {
  if (!response.headersSent) {
    response.writeHead(status, {
      ...RESPONSE_HEADERS,
      ...headers,
      ...(reason === undefined ? {} : { [REFUSAL_HEADER]: reason }),
    });
  }

  response.end();
};

// a malformed HTTP/2 request's end: its stream reset, nothing written (RFC 9113 §8.1.1)
const reset = (response: IHTTPResponseLike): void => {
  if (response.stream === undefined) {
    response.destroy();
  } else {
    response.stream.close(PROTOCOL_ERROR);
  }
};

// what HTTP refuses of its own (RFC 9112 §3.2, §3.2.2; RFC 9110 §5.5), as HTTP answers it,
// unmarked, with none of the path's fields, as Node's parser writes its own; over HTTP/2, a
// malformed request, its stream reset
const refuseMalformed = ({ request, response }: IExchangeIn): void => {
  if (request.httpVersionMajor !== 1) {
    return (reset(response), undefined);
  }

  response.writeHead(400, { 'content-length': '0', connection: 'close' });
  response.end();

  return undefined;
};

// a request's head, a 200 of Bead's type, which says the router has it: once, before its answer
const sendHead = (response: IHTTPResponseLike): void => {
  if (!response.headersSent) {
    response.writeHead(200, { ...RESPONSE_HEADERS, 'content-type': BEAD_MEDIA_TYPE });
    response.flushHeaders?.();
  }
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
 * 13.7). An outbox past `maximumOutboxBytes` closes its connection. A connection whose client does
 * not listen carries answers alone: anything else rejects its `send`.
 *
 * @example
 * const server = createHTTPTransportServer({ createServer: (listener) => createServer(listener) });
 * server.on('message', ({ credential, data }, connectionHandle) => {});
 * const { port } = await server.start({ findOpenPort: true });
 */
export const createHTTPTransportServer = (
  options: IHTTPTransportServerOptions
): HTTPTransportServer => {
  const {
    bodyBytesBudget = BODY_BYTES_BUDGET,
    clock = PLATFORM_CLOCK,
    createServer,
    exchangeTimeout: givenExchangeTimeout = EXCHANGE_TIMEOUT,
    hosts,
    inactivityTimeout: givenInactivityTimeout = INACTIVITY_TIMEOUT,
    maximumBodyBytes = MAXIMUM_BODY_BYTES,
    maximumConnections = MAXIMUM_CONNECTIONS,
    maximumConnectionsPerAddress = MAXIMUM_CONNECTIONS_PER_ADDRESS,
    maximumOutboxBytes = MAXIMUM_OUTBOX_BYTES,
    maximumWait: givenMaximumWait = MAXIMUM_WAIT,
    maximumWaitingExchanges = MAXIMUM_WAITING_EXCHANGES,
    origins = [],
    pathname = PATHNAME,
    secure,
    trustedProxies,
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
  assertHosts(hosts);
  assertOrigins(origins);
  const proxies = trustedProxiesOf(trustedProxies);

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

      // the client's address: the socket's, in the one form, or, behind proxies the transport
      // trusts, the rightmost `X-Forwarded-For` entry none of them holds (spec 15.12)
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
      // over HTTP/1, a refusal of a body it will not read closes its socket, lest the rest read as
      // the next request
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

        endWith(
          response,
          isClosing ? { ...end, headers: { ...end.headers, connection: 'close' } } : end
        );

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

      // out of the registry before its close is told; each exchange still waiting learns its
      // connection is gone — by the marked 404 until its request is handed on, then by its socket cut
      // after its head, as a lost exchange's: a request handed on ran, which no refusal may deny
      const closeDrawn = (connection: IDrawn, isClean: boolean): void => {
        const { address, connectionHandle, connectionToken } = connection;

        if (drawn.get(connectionHandle) !== connection) {
          return;
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

          if (exchange.response.headersSent) {
            exchange.response.destroy();
          } else {
            endWith(exchange.response, UNKNOWN_CONNECTION);
          }
        }

        connection.waiting.clear();
        connection.outbox = [];
        connection.outboxBytes = 0;

        if (connection.listen !== undefined) {
          answer(connection.listen, UNKNOWN_CONNECTION);
        }

        tell(CLOSE_EVENT, [isClean, connectionHandle]);
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
      };

      // an envelope of the server's own waits in its connection's outbox, numbered, for a listen to
      // bring it back; past the outbox's bound the connection closes, as one whose client fell behind
      const enqueue = (connection: IDrawn, bytes: Uint8Array): void => {
        if (connection.outboxBytes + bytes.length > maximumOutboxBytes) {
          return (closeDrawn(connection, false), undefined);
        }

        connection.sequence += 1;
        connection.outbox.push({ bytes: bytes.slice(), sequence: connection.sequence });
        connection.outboxBytes += bytes.length;

        if (connection.listen !== undefined) {
          answer(connection.listen, NOTHING);
        }
      };

      // a listen: what it acknowledges goes, and it brings back what is left — at once, or once
      // something comes within its wait. One listen at a time: a second ends the first, which brings
      // back nothing, and takes its place. A listen lost closes nothing: what it carried comes again.
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

      // one envelope: read into one buffer, its prefix checked from its first 8 bytes, then handed on
      const receive = (exchange: IExchangeIn, connection: IDrawn): void => {
        const { request, response } = exchange;
        const { connectionHandle } = connection;
        const declared = Number(headerOf(request, 'content-length') ?? Number.NaN);
        const authorizations = linesOf(request, 'authorization');

        // ! a field that is no list is not combined (RFC 9110 §5.3): two are refused before either
        // could be taken for the other
        if (authorizations.length > 1) {
          return (finish(exchange, { reason: REFUSALS.MALFORMED, status: 400 }), undefined);
        }

        if (Number.isFinite(declared) && declared > maximumBodyBytes) {
          return (finish(exchange, { reason: REFUSALS.TOO_LARGE, status: 413 }), undefined);
        }

        // a bound on what one connection has under way, cancels included, well past what its
        // waiting requests may be: those are refused at their prefix
        if (connection.open >= 2 * maximumWaitingExchanges) {
          return (finish(exchange, { reason: REFUSALS.BUSY, status: 429 }), undefined);
        }

        const state: IExchange = {
          isCancelled: false,
          isDelivered: false,
          isEnded: false,
          response,
          timer: undefined,
        };
        const body: IBody = {
          bytes: new Uint8Array(
            Number.isFinite(declared) ? Math.min(declared, FIRST_BODY_BYTES) : FIRST_BODY_BYTES
          ),
          length: 0,
        };
        let charged = 0;
        let received = 0;
        let prefix: { callId: number; kind: number } | undefined;
        // under way until both its request and its response are done
        let sides = 2;

        connection.open += 1;
        clock.clearTimeout(connection.idle);

        const client = connections.get(connectionHandle);

        if (client !== undefined) {
          client.lastActivity = clock.Date.now();
        }

        const release = (): void => {
          bodyBytes -= charged;
          charged = 0;
        };

        const done = (): void => {
          sides -= 1;

          if (sides === 0) {
            connection.open -= 1;

            if (drawn.get(connectionHandle) === connection) {
              rest(connection);
            }
          }
        };

        // ends it now, before its body or its answer; what still comes is counted, and dropped
        const endEarly = (end: IEnd): void => {
          state.isEnded = true;
          clock.clearTimeout(state.timer);

          if (prefix !== undefined && connection.waiting.get(prefix.callId) === state) {
            connection.waiting.delete(prefix.callId);
          }

          finish(exchange, end);
        };

        // what the first 8 bytes say: a request waits under its call id from now on
        const classify = (head: Uint8Array): void => {
          const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
          const layout = view.getUint8(0);
          const kind = view.getUint8(1);
          const callId = view.getUint32(4);

          if (layout < ENVELOPE_PREFIX.firstLayout || layout > ENVELOPE_PREFIX.lastLayout) {
            return (endEarly({ reason: REFUSALS.MALFORMED, status: 400 }), undefined);
          }

          if (kind !== ENVELOPE_KINDS.REQUEST) {
            return ((prefix = { callId, kind }), undefined);
          }

          // a client's call ids are odd, and none is 0
          if (callId % 2 === 0) {
            return (endEarly({ reason: REFUSALS.MALFORMED, status: 400 }), undefined);
          }

          if (connection.waiting.has(callId)) {
            return (endEarly({ reason: REFUSALS.CALL_WAITING, status: 409 }), undefined);
          }

          if (connection.waiting.size >= maximumWaitingExchanges) {
            return (endEarly({ reason: REFUSALS.BUSY, status: 429 }), undefined);
          }

          prefix = { callId, kind };

          if (connection.buried.has(callId)) {
            clock.clearTimeout(connection.buried.get(callId));
            connection.buried.delete(callId);
            state.isCancelled = true;
          }

          return (connection.waiting.set(callId, state), undefined);
        };

        response.on('close', () => {
          release();
          clock.clearTimeout(state.timer);

          // closed before the transport ended it: lost, as a dropped socket's frames are
          if (!state.isEnded) {
            closeDrawn(connection, false);
          }

          done();
        });

        request.on('close', () => {
          release();
          done();
        });

        request.on('data', (chunk) => {
          received += chunk.length;
          charged += chunk.length;
          bodyBytes += chunk.length;

          // past the limit, it is refused, and then no more of it is read
          if (received > maximumBodyBytes) {
            if (!state.isEnded) {
              endEarly({ reason: REFUSALS.TOO_LARGE, status: 413 });
            }

            return (request.destroy(), undefined);
          }

          if (bodyBytes > bodyBytesBudget && !state.isEnded) {
            const busy = { headers: { 'retry-after': '1' }, reason: REFUSALS.BUSY, status: 503 };

            return (endEarly(busy), undefined);
          }

          if (state.isEnded || state.isCancelled) {
            return undefined;
          }

          append(body, { chunk, limit: maximumBodyBytes });

          if (prefix === undefined && body.length >= ENVELOPE_PREFIX.bytes) {
            classify(body.bytes.subarray(0, ENVELOPE_PREFIX.bytes));
          }

          return undefined;
        });

        request.on('error', () => {
          release();
        });

        request.on('end', () => {
          release();

          if (state.isEnded) {
            return undefined;
          }

          // its connection closed while its body came: its client learns it is gone
          if (drawn.get(connectionHandle) !== connection) {
            state.isEnded = true;

            return (endWith(response, UNKNOWN_CONNECTION), undefined);
          }

          if (prefix === undefined) {
            return (endEarly({ reason: REFUSALS.MALFORMED, status: 400 }), undefined);
          }

          const { callId, kind } = prefix;

          // its cancel came first, or while it came: dropped, and ended empty
          if (state.isCancelled) {
            return (endEarly({ status: 204 }), undefined);
          }

          const envelope = body.bytes.slice(0, body.length);

          // a request is handed on with the credential its exchange carried; no other envelope is
          if (kind === ENVELOPE_KINDS.REQUEST) {
            const credential = credentialOf(authorizations);

            state.isDelivered = true;
            tell(MESSAGE_EVENT, [{ credential, data: envelope }, connectionHandle]);

            // still waiting — not answered as it came — its head goes now, so its client knows the
            // router has it; and it waits for its answer no longer than it may
            if (connection.waiting.get(callId) === state) {
              sendHead(response);

              if (exchangeTimeout !== Infinity) {
                state.timer = clock.setTimeout(() => {
                  closeDrawn(connection, false);
                }, exchangeTimeout);
                unref(state.timer);
              }
            }

            return undefined;
          }

          tell(MESSAGE_EVENT, [{ credential: undefined, data: envelope }, connectionHandle]);

          if (kind === ENVELOPE_KINDS.CANCEL) {
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
              endWith(cancelled.response, { status: 204 });
            } else {
              cancelled.isCancelled = true;
            }
          }

          return (endEarly({ status: 204 }), undefined);
        });
      };

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

            const entry = {
              instance: createServer(onExchange, { address: host }),
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
                'content-length': String(bytes.length),
                'content-type': BEAD_MEDIA_TYPE,
              });
            }

            response.end(bytes);
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
