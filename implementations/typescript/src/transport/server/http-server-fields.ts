// ── HTTP server fields ────────────────────────────────────────────────────────

// dependencies

import {
  BEAD_MEDIA_TYPE,
  CONNECTION_UNKNOWN,
  LISTEN_HEADER,
  REFUSAL_HEADER,
} from '../shared/constants';
import { BARE_ITEM_TYPES, type BareItem, parseItem } from '../shared/structured-fields';
import {
  authorityOf,
  HOST_REFUSAL,
  ORIGIN_REFUSAL,
  isAuthority,
  isTransferEncodingFramed,
  requestTargetOf,
  type IAuthority,
} from './hosts-and-origins';
import { lingerOn } from './server-bounds';
import type { IHTTPRequestLike, IHTTPResponseLike } from './types';

// interfaces

/** An exchange as the listener meets it: its request, and the response it writes. */
export interface IExchangeIn {
  request: IHTTPRequestLike;
  response: IHTTPResponseLike;
}

/** How an exchange ends, when the transport ends it: its status, its reason, its headers. */
export interface IEnd {
  headers?: Record<string, string> | undefined;
  /** The reason a refusal of the transport's own is marked with; none for a 201 or a 204. */
  reason?: string | undefined;
  status: number;
}

// constants

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

/** The reasons each refusal of the transport's own is marked with, in `bead-refusal`. */
export const HTTP_REFUSALS = Object.freeze({
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
  TOO_SLOW: 'too-slow',
  TYPE: 'type-refused',
});

// what every response on the path carries: never stored, never sniffed, and which one a request
// gets turns on its Origin; HTTP's own 400 carries none of these
export const RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  vary: 'Origin',
  'x-content-type-options': 'nosniff',
});

// the methods the transport's path takes, which its preflight's answer names (spec 15.12)
const TRANSPORT_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);

// how long a browser keeps a preflight's answer, in seconds: what every one of them carries
const PREFLIGHT_MAX_AGE = '7200';

// HTTP/2's error code of a malformed request, which resets its stream (RFC 9113 §7, §8.1.1)
const PROTOCOL_ERROR = 0x1;

/**
 * The requests one HTTP/1 socket may hold unserved, pipelined behind an answer under way or behind
 * one that closes its connection. Past it, the socket is destroyed. Node's parser reads on while the
 * answers ahead write nothing, so behind a held listen or a stream one socket would queue requests
 * without end. 32 is far above what a client that pipelines sends, and 32 heads at Node's 16 KB
 * bound stay under the megabyte Kestrel buffers of a connection (`MaxRequestBufferSize`).
 */
export const MAXIMUM_UNSERVED_REQUESTS = 32;

// the 404 that tells a client its connection is gone
export const UNKNOWN_CONNECTION: IEnd = Object.freeze({
  reason: HTTP_REFUSALS.CONNECTION_UNKNOWN,
  status: 404,
});

// helpers

// the first line of the field `name` as Node keeps it in `headers`: read for a field's presence
// and for what HTTP holds to one line, never for a field spec 15.12 joins
export const headerOf = (request: IHTTPRequestLike, name: string): string | undefined => {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
};

// the path a request names, an absolute-form target's among them, its query read by no exchange;
// none for a target HTTP refuses
export const targetOf = (request: IHTTPRequestLike): { path: string } | undefined => {
  const target = requestTargetOf(request.url);

  return target === undefined ? undefined : { path: target.path };
};

// whether a request says it has a body: a length above 0, as RFC 9110 §8.6 reads its digits, or a
// transfer coding
export const hasBody = (request: IHTTPRequestLike): boolean => {
  return (
    Number(headerOf(request, 'content-length') ?? '0') > 0 ||
    headerOf(request, 'transfer-encoding') !== undefined
  );
};

// the values of every line of the field `name` a request carries, as they came: `headers` keeps
// the first of two, so they are counted where each stands
export const linesOf = (request: IHTTPRequestLike, name: string): string[] => {
  const values: string[] = [];
  const { rawHeaders } = request;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }

  return values;
};

// whether a request's `Transfer-Encoding` is one spec 15.12 takes: none, or one that frames its body
// with no `Content-Length` beside it (RFC 9112 §6.1, §6.3 item 3)
// ! Node's parser refuses the pair, but not a server's built with `insecureHTTPParser`
export const isTransferEncodingTaken = (request: IHTTPRequestLike): boolean => {
  const codings = linesOf(request, 'transfer-encoding');

  return (
    codings.length === 0 ||
    (linesOf(request, 'content-length').length === 0 &&
      isTransferEncodingFramed(request.httpVersion, codings))
  );
};

// a field's lines joined in their order by `, ` (RFC 9110 §5.3, spec 15.12); none without a line
// ! from `rawHeaders`: over HTTP/2, `headers` keeps a single-value field's first line alone
export const joinedOf = (request: IHTTPRequestLike, name: string): string | undefined => {
  const lines = linesOf(request, name);

  return lines.length === 0 ? undefined : lines.join(', ');
};

// whether a body is sent as it is (spec 15.12): a Content-Encoding that lists no coding, or
// `identity` once in any case, its empty elements ignored (RFC 9110 §5.6.1.2), as an absent one
export const isUnencoded = (request: IHTTPRequestLike): boolean => {
  const codings = linesOf(request, 'content-encoding')
    .join(',')
    .split(',')
    .map((coding) => {
      return coding.replace(/^[\t ]+|[\t ]+$/gu, '');
    })
    .filter((coding) => {
      return coding !== '';
    });

  return codings.length === 0 || (codings.length === 1 && codings[0]?.toLowerCase() === 'identity');
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
export const countOf = (
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
export const listeningOf = (request: IHTTPRequestLike): boolean | undefined => {
  const bareItem = bareItemOf(request, LISTEN_HEADER);

  if (bareItem === null) {
    return false;
  }

  return bareItem?.type === BARE_ITEM_TYPES.BOOLEAN ? bareItem.value : undefined;
};

// a preflight's answer (spec 15.12): the methods its path takes, the transport's by default;
// `authorization`, which no wildcard covers (Fetch §4.8); the names asked, for a browser that caches
// names and no wildcard; then `*`. No `Vary`: no cache stores an answer to `OPTIONS` (RFC 9110 §9.3.7)
export const preflightOf = (
  request: IHTTPRequestLike,
  { methods = TRANSPORT_METHODS }: { methods?: readonly string[] } = {}
): IEnd => {
  const asked = linesOf(request, 'access-control-request-headers').join(', ');
  const allowed = ['authorization', ...(asked === '' ? [] : [asked]), '*'];

  return {
    headers: {
      'access-control-allow-headers': allowed.join(', '),
      'access-control-allow-methods': methods.join(', '),
      'access-control-max-age': PREFLIGHT_MAX_AGE,
    },
    status: 204,
  };
};

// a request's authority (spec 15.12): over HTTP/2, its `:authority`, else its `host`, judged by
// its form; over HTTP/1, as `authorityOf` reads it. None for what HTTP refuses of its own
export const authorityNamedBy = (request: IHTTPRequestLike): IAuthority | undefined => {
  if (request.httpVersionMajor !== 1) {
    const authority = headerOf(request, ':authority') ?? headerOf(request, 'host');

    return authority === undefined || isAuthority(authority) ? { authority } : undefined;
  }

  return authorityOf(linesOf(request, 'host'), {
    isRequired: request.httpVersion === '1.1',
    target: requestTargetOf(request.url),
  });
};

// a body of Bead's media type, parameters aside, in one field line, and sent as it is (spec 15.12)
export const isBeadBody = (request: IHTTPRequestLike): boolean => {
  // ! a singleton field (RFC 9110 §8.3): two Content-Type lines are no type, whatever the first
  const types = linesOf(request, 'content-type');
  const type = types.length === 1 ? types[0]?.split(';')[0]?.trim().toLowerCase() : undefined;

  return type === BEAD_MEDIA_TYPE && isUnencoded(request);
};

/**
 * The fields of an answer that carries no length, a 204's, a 304's or a HEAD's: where Node closes a
 * connection kept alive for want of one, over HTTP/1.0, `connection: keep-alive`, as its request
 * asks (RFC 9112 §9.3); none otherwise, Node's own fields standing.
 */
export const keptAliveOf = (response: IHTTPResponseLike): Readonly<Record<string, string>> => {
  // ! Node's own condition: it keeps an answer of no length only where it would chunk one
  return response.shouldKeepAlive === true && response.useChunkedEncodingByDefault === false
    ? { connection: 'keep-alive' }
    : {};
};

// writes an exchange's end, once: its status and headers, marked when it is a refusal
// ! never tells: the 404 of a connection that closes is section 15.7's close, told by `close`, and
// no refusal; a refusal the transport judges goes through `finish`, which tells it
export const endWith = (response: IHTTPResponseLike, { headers, reason, status }: IEnd): void => {
  if (!response.headersSent) {
    response.writeHead(status, {
      ...RESPONSE_HEADERS,
      // * its length, 0, so its connection is kept over HTTP/1.0 and its end framed by no chunk
      // (RFC 9110 §8.6); a 204, a 304 or a HEAD's carries none, kept alive as its request asks
      ...(status === 204 || status === 304 || response.req?.method === 'HEAD'
        ? keptAliveOf(response)
        : { 'content-length': '0' }),
      ...headers,
      ...(reason === undefined ? {} : { [REFUSAL_HEADER]: reason }),
    });
  }

  response.end();
};

/**
 * Writes the end of an exchange whose body may still come, as `endWith` does; over HTTP/1 it says
 * `connection: close`, and its socket closes in stages, its write side first, reading on and
 * dropping what still comes, so its client reads it before the close (RFC 9112 §9.6). Over HTTP/2,
 * its stream ends alone.
 */
export const endClosing = ({ request, response }: IExchangeIn, end: IEnd): void => {
  if (request.httpVersionMajor !== 1) {
    return (endWith(response, end), undefined);
  }

  const { socket } = request;

  // a socket of the platform's alone: a fake of a test's lingers nothing
  if (typeof socket.removeListener === 'function' && typeof socket.destroy === 'function') {
    lingerOn(socket as Parameters<typeof lingerOn>[0], response);
  }

  endWith(response, { ...end, headers: { ...end.headers, connection: 'close' } });

  return undefined;
};

/**
 * The fields of an answer that closes its connection behind a body it does not read whole: over
 * HTTP/1, `connection: close`, its socket closing in stages as `endClosing`'s, so what still comes
 * is dropped, never read as a next request (RFC 9112 §9.6), as Kestrel closes it; none over HTTP/2,
 * whose stream ends alone. Whether it closes is its caller's to judge.
 */
export const closingOf = ({ request, response }: IExchangeIn): Readonly<Record<string, string>> => {
  if (request.httpVersionMajor !== 1) {
    return {};
  }

  const { socket } = request;

  if (typeof socket.removeListener === 'function' && typeof socket.destroy === 'function') {
    lingerOn(socket as Parameters<typeof lingerOn>[0], response);
  }

  return { connection: 'close' };
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
export const refuseMalformed = ({ request, response }: IExchangeIn): void => {
  if (request.httpVersionMajor !== 1) {
    return (reset(response), undefined);
  }

  response.writeHead(400, { 'content-length': '0', connection: 'close' });
  response.end();

  return undefined;
};

// the requests each HTTP/1 socket holds unserved, by its socket
const unserved = new WeakMap<object, number>();

// whether `socket` may hold one more request unserved, which it counts; past
// MAXIMUM_UNSERVED_REQUESTS, it is destroyed instead
const isHeld = (socket: IHTTPRequestLike['socket']): boolean => {
  const count = (unserved.get(socket) ?? 0) + 1;

  unserved.set(socket, count);

  if (count > MAXIMUM_UNSERVED_REQUESTS) {
    socket.destroy?.();

    return false;
  }

  return true;
};

/**
 * Serves an exchange in its turn. Over HTTP/1, Node's parser hands on every request a read holds,
 * one pipelined behind an answer under way among them, and that request's answer holds no socket
 * until the answers before it ended; behind one that closes its connection, it never does. So a
 * request is served once its answer holds its socket, and none is served behind an answer that
 * closes, whatever closed it (RFC 9112 §9.3, §9.6). A socket that holds more than
 * {@link MAXIMUM_UNSERVED_REQUESTS} unserved is destroyed. Over HTTP/2, or for a fake of a test's,
 * at once.
 */
export const inTurn = ({ request, response }: IExchangeIn, serve: () => void): void => {
  if (request.httpVersionMajor !== 1) {
    return (serve(), undefined);
  }

  const { socket } = request;

  if (socket.destroyed === true) {
    return undefined;
  }

  // * its socket closes behind an answer already written: a request in a later read, never served
  if (socket.writableEnded === true) {
    return (isHeld(socket), undefined);
  }

  // ! Node's own: `null` while an answer before it is under way, then `socket` once that one ended
  // keeping its connection; a fake's has none, and is served at once
  if (response.socket === null && response.once !== undefined) {
    if (isHeld(socket)) {
      response.once('socket', () => {
        unserved.set(socket, (unserved.get(socket) ?? 1) - 1);
        serve();
      });
    }

    return undefined;
  }

  serve();

  return undefined;
};

// a request's head, a 200 of Bead's type, which says the router has it: once, before its answer
export const sendHead = (response: IHTTPResponseLike): void => {
  if (!response.headersSent) {
    response.writeHead(200, { ...RESPONSE_HEADERS, 'content-type': BEAD_MEDIA_TYPE });
    response.flushHeaders?.();
  }
};
