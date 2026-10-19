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
  requestTargetOf,
  type IAuthority,
} from './hosts-and-origins';
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

// what every response on the path carries: never stored, never sniffed, and which one a request
// gets turns on its Origin; HTTP's own 400 carries none of these
export const RESPONSE_HEADERS = Object.freeze({
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

// helpers

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

// a preflight's answer (spec 15.12): `authorization`, which no wildcard covers (Fetch §4.8); the
// names asked, for a browser that caches names and no wildcard; then `*`. No `Vary` names what was
// asked: no cache stores an answer to `OPTIONS` (RFC 9110 §9.3.7)
export const preflightOf = (request: IHTTPRequestLike): IEnd => {
  const asked = linesOf(request, 'access-control-request-headers').join(', ');
  const allowed = ['authorization', ...(asked === '' ? [] : [asked]), '*'];

  return {
    headers: { ...PREFLIGHT, 'access-control-allow-headers': allowed.join(', ') },
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

// a body of Bead's media type, parameters aside, sent as it is
export const isBeadBody = (request: IHTTPRequestLike): boolean => {
  const type = headerOf(request, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  const encoding = headerOf(request, 'content-encoding')?.trim().toLowerCase();

  return type === BEAD_MEDIA_TYPE && (encoding === undefined || encoding === 'identity');
};

// writes an exchange's end, once: its status and headers, marked when it is a refusal
// ! never tells: the 404 of a connection that closes is section 15.7's close, told by `close`, and
// no refusal; a refusal the transport judges goes through `finish`, which tells it
export const endWith = (response: IHTTPResponseLike, { headers, reason, status }: IEnd): void => {
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
export const refuseMalformed = ({ request, response }: IExchangeIn): void => {
  if (request.httpVersionMajor !== 1) {
    return (reset(response), undefined);
  }

  response.writeHead(400, { 'content-length': '0', connection: 'close' });
  response.end();

  return undefined;
};

// a request's head, a 200 of Bead's type, which says the router has it: once, before its answer
export const sendHead = (response: IHTTPResponseLike): void => {
  if (!response.headersSent) {
    response.writeHead(200, { ...RESPONSE_HEADERS, 'content-type': BEAD_MEDIA_TYPE });
    response.flushHeaders?.();
  }
};

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

// the 404 that tells a client its connection is gone
export const UNKNOWN_CONNECTION: IEnd = Object.freeze({
  reason: REFUSALS.CONNECTION_UNKNOWN,
  status: 404,
});
