// ── Hosts and origins ─────────────────────────────────────────────────────────

// dependencies

import { isIPv6 } from 'node:net';
import { ProgrammerError } from '../shared/errors';

// interfaces

/**
 * A request's target as HTTP reads it (RFC 9112 §3.2): its authority when it is in absolute-form,
 * its path, and its query, the text after its first `?`.
 */
export interface IRequestTarget {
  readonly authority: string | undefined;
  readonly path: string;
  readonly query: string;
}

/** A request's authority (spec 15.12), once HTTP took its form; `undefined` when it names none. */
export interface IAuthority {
  readonly authority: string | undefined;
}

// constants

/** The refusal of a request that names a host the server does not take (spec 15.12). */
export const HOST_REFUSAL = 'host-refused';

/** The refusal of a request whose `Origin` is neither the server's own nor among those it takes. */
export const ORIGIN_REFUSAL = 'origin-refused';

/** The `hosts` entry that takes every host, an empty one and none, alone in its list (spec 15.12). */
export const EVERY_HOST = '*';

// a `name` of spec 15.12's grammar, an IPv4 address and the empty name among them: RFC 3986's
// `reg-name` with no percent-encoded octet, nor `*`, `+`, `,`, `;` or `=`
const NAME = /^[A-Za-z\d\-._~!$&'()]*$/u;

// an IP literal, an IPv6 address alone in its brackets (RFC 3986 §3.2.2), read apart
const IP_LITERAL = /^\[(?<literal>[^\]]*)\]$/u;

// RFC 3986's `IPv4address`: four `dec-octet`, none with a leading zero
const DEC_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)';
const IPV4_ADDRESS = new RegExp(`^${DEC_OCTET}(?:\\.${DEC_OCTET}){3}$`, 'u');

// an IPv4 address an IPv6 socket carries mapped, as Node writes it (RFC 4291 §2.5.5.2)
const IPV4_MAPPED = /^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/iu;

// a port of one digit at least
const PORT = /^\d+$/u;

// the two schemes whose target in absolute-form names the request's authority, written as HTTP
// servers read them, in lower case
const ABSOLUTE_FORM = /^https?:\/\//u;

// any other scheme's target in absolute-form, which no HTTP server serves
const OTHER_SCHEME = /^[A-Za-z][A-Za-z\d+\-.]*:\/\//u;

// the default port of each scheme a browser serializes an origin of without it (RFC 6454 §6.2)
const DEFAULT_PORTS: Readonly<Record<string, string>> = Object.freeze({
  http: '80',
  https: '443',
  ws: '80',
  wss: '443',
});

// an origin as RFC 6454 §6.2 serializes it: a scheme in lower case, `://`, a host, and a port
// without a leading zero
const SERIALIZED_ORIGIN =
  /^(?<scheme>[a-z][a-z\d+\-.]*):\/\/(?<host>\[[^\]]*\]|[^:/?#[\]]*)(?::(?<port>0|[1-9]\d*))?$/u;

// helpers

// a field's value without the spaces and tabs around it (RFC 9110 §5.5)
const trimmed = (value: string): string => {
  return value.replaceAll(/^[\t ]+|[\t ]+$/gu, '');
};

// whether `value` is a `host` of spec 15.12's grammar: an IPv6 address in brackets, bare, with no
// zone; or a `name`, an IPv4 address and the empty name among them
const isHost = (value: string): boolean => {
  const literal = IP_LITERAL.exec(value)?.groups?.['literal'];

  if (literal === undefined) {
    return NAME.test(value);
  }

  return !literal.includes('%') && isIPv6(literal);
};

// an authority split at its port's colon: the bracketed literal, or the text before its first `:`;
// what follows a literal but a port stays with it, which is then no host
const partsOf = (authority: string): { host: string; port: string | undefined } => {
  if (!authority.startsWith('[')) {
    const colon = authority.indexOf(':');

    return colon === -1
      ? { host: authority, port: undefined }
      : { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
  }

  const end = authority.indexOf(']') + 1;
  const rest = end === 0 ? '' : authority.slice(end);

  return rest.startsWith(':')
    ? { host: authority.slice(0, end), port: rest.slice(1) }
    : { host: authority, port: undefined };
};

// a host or an origin in ASCII lower case: A to Z alone, every other character as it is
const asciiLowerCase = (text: string): string => {
  return text.replaceAll(/[A-Z]+/gu, (letters) => {
    return letters.toLowerCase();
  });
};

// whether a host is one every server takes, a name no page can rebind to its address (spec
// 15.12): `localhost`, a name ending in `.localhost`, an IPv6 address in brackets, an `IPv4address`
const isTakenByEveryServer = (host: string): boolean => {
  const lowered = asciiLowerCase(host);

  return (
    lowered === 'localhost' ||
    lowered.endsWith('.localhost') ||
    host.startsWith('[') ||
    isIPv4Address(host)
  );
};

// definition

/**
 * A client's address as its socket gives it (spec 15.12), an IPv4 address an IPv6 socket carries
 * mapped, `::ffff:a.b.c.d`, read as that IPv4 address (RFC 4291 §2.5.5.2).
 */
export const clientAddressOf = (socketAddress: string): string => {
  return IPV4_MAPPED.exec(socketAddress)?.groups?.['ipv4'] ?? socketAddress;
};

/**
 * Whether `value` is RFC 3986's `IPv4address`, four `dec-octet` with no leading zero: by the
 * grammar alone, never as a platform's parser reads one, which takes `127.1` or `0177.0.0.1`.
 */
export const isIPv4Address = (value: string): boolean => {
  return IPV4_ADDRESS.test(value);
};

/**
 * Whether `value` is an authority of spec 15.12's grammar: a host, then an optional `:` and a port
 * of one digit at least. A percent-encoded octet, `*`, `+`, `,`, `;` or `=` in a name, an
 * `IPvFuture` literal, a zone, and a colon with no port are none.
 */
export const isAuthority = (value: string): boolean => {
  const { host, port } = partsOf(value);

  return isHost(host) && (port === undefined || PORT.test(port));
};

/**
 * An authority's host, its port aside (RFC 9110 §4.2.3): the bracketed literal, or the text before
 * its first `:`.
 */
export const hostPartOf = (authority: string): string => {
  return partsOf(authority).host;
};

/**
 * A request's target as HTTP reads it: in absolute-form, `http://` or `https://` in lower case and
 * an authority as it came (RFC 9112 §3.2.2), then its path, `/` when it names none; otherwise its
 * path whole, `/` when there is none. `undefined` for a target HTTP refuses: another scheme's
 * absolute-form, or an authority that is no host, a userinfo, a colon with no port and an empty one
 * among them (RFC 9110 §4.2.1, §4.2.4). Read by hand, never by a URL parser, so no target throws.
 */
export const requestTargetOf = (target: string | undefined): IRequestTarget | undefined => {
  const given = target ?? '/';
  const scheme = ABSOLUTE_FORM.exec(given)?.[0];

  if (scheme === undefined) {
    if (OTHER_SCHEME.test(given)) {
      return undefined;
    }

    const index = given.indexOf('?');

    return index === -1
      ? { authority: undefined, path: given, query: '' }
      : { authority: undefined, path: given.slice(0, index), query: given.slice(index + 1) };
  }

  const rest = given.slice(scheme.length);
  const end = rest.search(/[#/?]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const after = end === -1 ? '' : rest.slice(end);
  const index = after.indexOf('?');
  const path = index === -1 ? after : after.slice(0, index);

  if (authority === '' || !isAuthority(authority)) {
    return undefined;
  }

  return {
    authority,
    path: path === '' ? '/' : path,
    query: index === -1 ? '' : after.slice(index + 1),
  };
};

/**
 * Whether a request's `Host` is one HTTP takes (RFC 9112 §3.2), from its field lines as they came:
 * one line at most, none only where `isRequired` is false, as in an HTTP/1.0 request; its value,
 * without the spaces and tabs around it, an authority of spec 15.12's grammar. An empty value is
 * one, and so is a name of invalid punycode, which {@link isTakenHost} judges. A request this
 * refuses is answered 400 before anything else of it is read.
 */
export const isWellFormedHost = (
  lines: readonly string[],
  { isRequired }: { isRequired: boolean }
): boolean => {
  const [line, ...others] = lines;

  if (line === undefined) {
    return !isRequired;
  }

  return others.length === 0 && isAuthority(trimmed(line));
};

/**
 * An HTTP/1 request's authority (spec 15.12), from its `Host` field lines as they came and its
 * target as {@link requestTargetOf} reads it: an absolute-form target's, its `Host` ignored but
 * for being one line, or none where `isRequired` is false; otherwise its `Host`, when
 * {@link isWellFormedHost} takes it, and none when it has none. `undefined` for what HTTP answers
 * 400 of its own.
 */
export const authorityOf = (
  hostLines: readonly string[],
  { isRequired, target }: { isRequired: boolean; target: IRequestTarget | undefined }
): IAuthority | undefined => {
  if (target === undefined) {
    return undefined;
  }

  if (target.authority !== undefined) {
    return hostLines.length === 1 || (hostLines.length === 0 && !isRequired)
      ? { authority: target.authority }
      : undefined;
  }

  if (!isWellFormedHost(hostLines, { isRequired })) {
    return undefined;
  }

  const [line] = hostLines;

  return { authority: line === undefined ? undefined : trimmed(line) };
};

/**
 * Whether a request that names `authority` is taken (spec 15.12), by its host, its port aside,
 * compared ASCII case-insensitively (RFC 9110 §4.2.3): every server takes `localhost`, a name that
 * ends in `.localhost`, an IPv6 address in brackets and an `IPv4address`; `hosts` takes those it
 * lists besides, and {@link EVERY_HOST}, alone in it, every host, an empty one and none. Any other,
 * an empty one and none are refused.
 */
export const isTakenHost = (
  authority: string | undefined,
  hosts: readonly string[] | undefined
): boolean => {
  if (hosts?.[0] === EVERY_HOST) {
    return true;
  }

  const host = authority === undefined ? '' : hostPartOf(authority);

  if (host === '') {
    return false;
  }

  return (
    isTakenByEveryServer(host) ||
    (hosts ?? []).some((taken) => {
      return asciiLowerCase(taken) === asciiLowerCase(host);
    })
  );
};

/**
 * Whether a request from `origin` is taken: one without an `Origin` comes from no page, and from
 * anywhere; one among `origins`, exactly; or the server's own, `http://` or `https://` followed by
 * the request's authority, compared ASCII case-insensitively. The field is read as the serialized
 * origin it carries (RFC 6454 §6.2; Fetch, "serializing a request origin"), never parsed as a URL:
 * a browser writes it and the `Host` from one URL alike. Any other is none of its own, `null` and
 * every other scheme among them, as is any `Origin` of a request without a host.
 */
export const isTakenOrigin = (
  origin: string | undefined,
  { host, origins }: { host: string | undefined; origins: readonly string[] }
): boolean => {
  if (origin === undefined || origins.includes(origin)) {
    return true;
  }

  if (host === undefined || host === '') {
    return false;
  }

  const serialized = asciiLowerCase(origin);
  const own = asciiLowerCase(host);

  return serialized === `http://${own}` || serialized === `https://${own}`;
};

/**
 * Refuses, with a {@link ProgrammerError} naming the entry, a `hosts` that holds an entry with a
 * port, an empty one, one that is no host of spec 15.12's grammar — a Unicode IDN among them, which
 * the field never carries — or {@link EVERY_HOST} beside another. `[]` and none take the hosts every
 * server takes alone; `['*']` takes every host, and reopens what the check closes: a page that
 * rebinds its name to the server's address.
 */
export const assertHosts = (hosts: readonly string[] | undefined): void => {
  for (const entry of hosts ?? []) {
    if (entry === EVERY_HOST) {
      if (hosts?.length !== 1) {
        throw new ProgrammerError(`hosts takes ${EVERY_HOST} alone, which takes every host`);
      }
    } else if (entry === '') {
      throw new ProgrammerError('a hosts entry is a host, not an empty one');
    } else if (isHost(entry)) {
      continue;
    } else if (isAuthority(entry)) {
      throw new ProgrammerError(
        `a hosts entry is a host without its port, compared on any port: ${hostPartOf(entry)}, not ${entry}`
      );
    } else {
      throw new ProgrammerError(
        `a hosts entry is a host as the Host field carries it, an IDN host in punycode: not ${entry}`
      );
    }
  }
};

/**
 * Refuses, with a {@link ProgrammerError} naming the entry, an `origins` entry that is neither `null`
 * nor an origin as RFC 6454 §6.2 serializes it — a scheme in lower case, `://`, a host of spec
 * 15.12's grammar, a port of 0 to 65535 with no leading zero, nothing after; for `http`, `https`,
 * `ws` and `wss`, the host in lower case and no port where it is the scheme's default, another
 * scheme's taken as written — since a browser writes `Origin` so, and an entry is compared exactly. `*` is none: no
 * origin wildcard exists, and taking every page is `hosts: ['*']` with no origin named, a decision
 * of its own. `[]` and none take a page of the server's own alone.
 */
export const assertOrigins = (origins: readonly string[] | undefined): void => {
  for (const entry of origins ?? []) {
    if (entry === '*') {
      throw new ProgrammerError(
        'origins has no wildcard: it names each origin a page comes from besides the server’s own'
      );
    }

    const { host = '', port, scheme = '' } = SERIALIZED_ORIGIN.exec(entry)?.groups ?? {};

    if (
      entry !== 'null' &&
      (host === '' ||
        !isHost(host) ||
        (DEFAULT_PORTS[scheme] !== undefined &&
          (host !== asciiLowerCase(host) || DEFAULT_PORTS[scheme] === port)) ||
        Number(port ?? 0) > 65_535)
    ) {
      throw new ProgrammerError(
        `an origins entry is null or an origin as a browser serializes it, scheme://host[:port] in lower case, no default port, nothing after: not ${entry}`
      );
    }
  }
};
