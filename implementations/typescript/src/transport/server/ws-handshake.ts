// ── WebSocket handshake ───────────────────────────────────────────────────────

// dependencies

import {
  authorityOf,
  hasVisibleFields,
  HOST_REFUSAL,
  isTakenHost,
  isTakenOrigin,
  ORIGIN_REFUSAL,
  originOf,
  ownAuthorityOf,
  requestTargetOf,
} from './hosts-and-origins';

// types

/** The part of a request at a WebSocket's address the judgement reads: each field as it came. */
export interface IHandshakeRequestLike {
  readonly httpVersion: string;
  readonly method?: string | undefined;
  /** Its fields as they came, each name before its value: what counts a field given twice. */
  readonly rawHeaders: readonly string[];
  /** Its target, which names its authority when it is in absolute-form. */
  readonly url?: string | undefined;
}

/** What a server answers a request it does not upgrade. */
export interface IHandshakeRefusal {
  /** Every field of the answer but its `date`, in the order they are written. */
  readonly fields: Readonly<Record<string, string>>;
  /** Its `bead-refusal`; none for what HTTP refuses of its own. */
  readonly refusal: string | undefined;
  readonly status: number;
}

// constants

/** The refusals of a WebSocket server's own, each its `bead-refusal` (spec 15.6). */
export const WS_REFUSALS = Object.freeze({
  BUSY: 'busy',
  HOST: HOST_REFUSAL,
  MALFORMED: 'malformed',
  METHOD: 'method-refused',
  ORIGIN: ORIGIN_REFUSAL,
  UPGRADE: 'upgrade-required',
  VERSION: 'version-refused',
});

// 16 bytes in base64 (RFC 6455 §4.2.1 item 5)
const KEY = /^[\d+/A-Za-z]{22}==$/u;

// a `Content-Length` of no content, read as the number it is (RFC 9110 §8.6), `00` among them
const NO_CONTENT = /^0+$/u;

// a `token` (RFC 9110 §5.6.2)
const TOKEN = /^[\d!#$%&'*+\-.^_`|~A-Za-z]+$/u;

// helpers

// a field's value without the spaces and tabs around it (RFC 9110 §5.5)
const trimmed = (value: string): string => {
  return value.replaceAll(/^[\t ]+|[\t ]+$/gu, '');
};

// the values of each line of the field `name`, as they came but for the whitespace around them:
// `headers` joins two lines, or keeps the first, so they are counted where each stands
const linesOf = (request: IHandshakeRequestLike, name: string): string[] => {
  const values: string[] = [];
  const { rawHeaders } = request;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(trimmed(rawHeaders[index + 1] ?? ''));
    }
  }

  return values;
};

// the elements of a list across its lines (RFC 9110 §5.6.1), the empty ones kept
const elementsOf = (lines: readonly string[]): string[] => {
  return lines.flatMap((line) => {
    return line.split(',').map(trimmed);
  });
};

// whether a list holds `token` in any ASCII case
const hasToken = (lines: readonly string[], token: string): boolean => {
  return elementsOf(lines).some((element) => {
    return (
      element.replaceAll(/[A-Z]+/gu, (letters) => {
        return letters.toLowerCase();
      }) === token
    );
  });
};

// a refusal of the transport's own, marked, never stored nor sniffed, its body empty
const refused = (
  status: number,
  { fields = {}, refusal }: { fields?: Record<string, string>; refusal: string }
): IHandshakeRefusal => {
  return Object.freeze({
    fields: Object.freeze({
      'bead-refusal': refusal,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...fields,
      'content-length': '0',
      connection: 'upgrade' in fields ? 'upgrade, close' : 'close',
    }),
    refusal,
    status,
  });
};

const HOST_REFUSED = refused(403, { refusal: WS_REFUSALS.HOST });

// a method the address does not serve, and those it does, named (RFC 9110 §15.5.6)
const METHOD_REFUSED = refused(405, {
  fields: { allow: 'GET, HEAD' },
  refusal: WS_REFUSALS.METHOD,
});

const ORIGIN_REFUSED = refused(403, { refusal: WS_REFUSALS.ORIGIN });

// a request that asks no WebSocket: the one protocol the address speaks, named (RFC 9110 §15.5.22)
const UPGRADE_REQUIRED = refused(426, {
  fields: { upgrade: 'websocket' },
  refusal: WS_REFUSALS.UPGRADE,
});

// the one version the server speaks, named (RFC 6455 §4.2.2)
const VERSION_REFUSED = refused(426, {
  fields: { upgrade: 'websocket', 'sec-websocket-version': '13' },
  refusal: WS_REFUSALS.VERSION,
});

/** A handshake the server cannot take, refused 400 `malformed`. */
export const MALFORMED_HANDSHAKE = refused(400, { refusal: WS_REFUSALS.MALFORMED });

/**
 * An upgrade the server would take once its stop began, refused 503 `busy`, told when to come back
 * (RFC 9110 §15.6.4, §10.2.3; spec 15.2.8).
 */
export const BUSY_HANDSHAKE = refused(503, {
  fields: { 'retry-after': '1' },
  refusal: WS_REFUSALS.BUSY,
});

// what HTTP refuses of its own (RFC 9112 §3.2, §3.2.2; RFC 9110 §5.5), unmarked
const HOST_MALFORMED: IHandshakeRefusal = Object.freeze({
  fields: Object.freeze({ 'content-length': '0', connection: 'close' }),
  refusal: undefined,
  status: 400,
});

// whether a list of subprotocols is of distinct tokens (RFC 6455 §4.1 item 10), none empty
const isProtocolList = (lines: readonly string[]): boolean => {
  const elements = elementsOf(lines);

  return (
    elements.every((element) => {
      return TOKEN.test(element);
    }) && new Set(elements).size === elements.length
  );
};

// a version 13 upgrade's form beside its version: one key, its subprotocols, an `Authorization`
// at most, which is no list to combine (RFC 9110 §5.3), and no content
const isWellFormed = (request: IHandshakeRequestLike): boolean => {
  const keys = linesOf(request, 'sec-websocket-key');
  const protocols = linesOf(request, 'sec-websocket-protocol');

  return (
    keys.length === 1 &&
    KEY.test(keys[0] ?? '') &&
    (protocols.length === 0 || isProtocolList(protocols)) &&
    linesOf(request, 'authorization').length <= 1 &&
    linesOf(request, 'content-length').every((length) => {
      return NO_CONTENT.test(length);
    }) &&
    linesOf(request, 'transfer-encoding').length === 0
  );
};

// a request's authority (spec 15.12), as the judgement reads it; none for what HTTP refuses
const authorityNamedBy = (request: IHandshakeRequestLike) => {
  return authorityOf(linesOf(request, 'host'), {
    isRequired: request.httpVersion === '1.1',
    target: requestTargetOf(request.url),
  });
};

// definition

/**
 * What a refusal at a WebSocket's address tells of its request (spec 15.1), as the judgement read
 * it: its authority, its port included, and its `Origin`, its lines joined by `, `; each
 * `undefined` when it names none.
 */
export const toldOfHandshake = (
  request: IHandshakeRequestLike
): { authority: string | undefined; origin: string | undefined } => {
  return {
    authority: authorityNamedBy(request)?.authority,
    origin: originOf(linesOf(request, 'origin')),
  };
};

/**
 * What a server answers a request at its WebSocket's address that it does not upgrade, judged in
 * the order of spec 15.2, the first that applies answering; none for an upgrade it takes:
 *
 * 1. what HTTP refuses of its own, a field value holding a control character but a tab or an
 *    octet past ASCII (RFC 9110 §5.5), a `Host` missing, repeated or no host, or a target in
 *    absolute-form that names none or another scheme (RFC 9112 §3.2, §3.2.2), 400 unmarked;
 * 2. a request whose authority — its absolute-form target's, else its `Host` — names a host it
 *    does not take (spec 15.12), or none, whatever else the request holds, 403 `host-refused`;
 * 3. a method but `GET` or `HEAD`, 405 `method-refused`, its `Allow` naming both;
 * 4. a request that asks no WebSocket — a `HEAD`, an `HTTP/1.0` request, an `Upgrade` listing no
 *    `websocket` or a `Connection` listing no `upgrade`, in any ASCII case — 426 `upgrade-required`;
 * 5. a `Sec-WebSocket-Version` in two lines, 400 `malformed`; any but 13, or none, 426
 *    `version-refused`, naming 13;
 * 6. a key not one line of 16 bytes in base64, subprotocols no list of distinct tokens, more than
 *    one `Authorization` line, which is no list to combine (RFC 9110 §5.3), or content, 400
 *    `malformed`;
 * 7. an `Origin` neither the server's own, by the request's authority, nor among `origins`, 403
 *    `origin-refused`.
 *
 * Each refusal but HTTP's own is marked, never stored nor sniffed, its body empty, and closes its
 * connection; a 426 names `websocket` in its `Upgrade`, and `upgrade` in its `Connection`.
 */
export const refusalOfHandshake = (
  request: IHandshakeRequestLike,
  { hosts, origins }: { hosts: readonly string[] | undefined; origins: readonly string[] }
): IHandshakeRefusal | undefined => {
  const { httpVersion, method } = request;

  // * before anything else: Node's parser answers a control character itself, so this meets an
  // octet past ASCII alone
  if (!hasVisibleFields(request.rawHeaders)) {
    return HOST_MALFORMED;
  }

  const named = authorityNamedBy(request);

  if (named === undefined) {
    return HOST_MALFORMED;
  }

  const { authority } = named;

  if (!isTakenHost(authority, hosts)) {
    return HOST_REFUSED;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return METHOD_REFUSED;
  }

  // ! a `HEAD` cannot switch, and an `HTTP/1.0` request's `Upgrade` is ignored (RFC 9110 §7.8)
  if (
    method === 'HEAD' ||
    httpVersion !== '1.1' ||
    !hasToken(linesOf(request, 'upgrade'), 'websocket') ||
    !hasToken(linesOf(request, 'connection'), 'upgrade')
  ) {
    return UPGRADE_REQUIRED;
  }

  const versions = linesOf(request, 'sec-websocket-version');

  if (versions.length > 1) {
    return MALFORMED_HANDSHAKE;
  }

  if (versions[0] !== '13') {
    return VERSION_REFUSED;
  }

  if (!isWellFormed(request)) {
    return MALFORMED_HANDSHAKE;
  }

  const own = ownAuthorityOf(authority, hosts);

  if (!isTakenOrigin(originOf(linesOf(request, 'origin')), { host: own, origins })) {
    return ORIGIN_REFUSED;
  }

  return undefined;
};
