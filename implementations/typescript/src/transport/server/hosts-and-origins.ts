// ── Hosts and origins ─────────────────────────────────────────────────────────

// dependencies

import { isIPv6 } from 'node:net';

// constants

/** The refusal of a request that names a host the server does not take (spec 15.12). */
export const HOST_REFUSAL = 'host-refused';

/** The refusal of a request whose `Origin` is neither the server's own nor among those it takes. */
export const ORIGIN_REFUSAL = 'origin-refused';

// a `reg-name`, an IPv4 address among them, then an optional port (RFC 3986 §3.2.2, §3.2.3)
const REG_NAME_HOST = /^(?:[A-Za-z\d\-._~!$&'()*+,;=]|%[\dA-Fa-f]{2})*(?::\d*)?$/u;

// an IP literal, then an optional port: what is inside the brackets is read apart
const IP_LITERAL_HOST = /^\[(?<literal>[^\]]*)\](?::\d*)?$/u;

// `IPvFuture` (RFC 3986 §3.2.2)
const IP_FUTURE = /^[Vv][\dA-Fa-f]+\.[A-Za-z\d\-._~!$&'()*+,;=:]+$/u;

// helpers

// a field's value without the spaces and tabs around it (RFC 9110 §5.5)
const trimmed = (value: string): string => {
  return value.replaceAll(/^[\t ]+|[\t ]+$/gu, '');
};

// whether `value` is `uri-host [ ":" port ]` (RFC 9110 §7.2): an IPv6 address bare, with no zone
const isHost = (value: string): boolean => {
  const literal = IP_LITERAL_HOST.exec(value)?.groups?.['literal'];

  if (literal === undefined) {
    return REG_NAME_HOST.test(value);
  }

  return IP_FUTURE.test(literal) || (!literal.includes('%') && isIPv6(literal));
};

// a host or an origin in ASCII lower case: A to Z alone, every other character as it is
const asciiLowerCase = (text: string): string => {
  return text.replaceAll(/[A-Z]+/gu, (letters) => {
    return letters.toLowerCase();
  });
};

// definition

/**
 * Whether a request's `Host` is one HTTP takes (RFC 9112 §3.2), from its field lines as they came:
 * one line at most, none only where `isRequired` is false, as in an HTTP/1.0 request; its value,
 * without the spaces and tabs around it, `uri-host` and an optional port (RFC 9110 §7.2, RFC 3986
 * §3.2.2–3.2.3). An empty value is one, and so is a name of invalid punycode, which
 * {@link isTakenHost} judges. A request this refuses is answered 400 before anything else of it is
 * read.
 */
export const isWellFormedHost = (
  lines: readonly string[],
  { isRequired }: { isRequired: boolean }
): boolean => {
  const [line, ...others] = lines;

  if (line === undefined) {
    return !isRequired;
  }

  return others.length === 0 && isHost(trimmed(line));
};

/**
 * Whether a request that names `host` is taken: every host when `hosts` is not given; otherwise one
 * among them, compared ASCII case-insensitively (RFC 9110 §4.2.3). None names no host taken.
 */
export const isTakenHost = (
  host: string | undefined,
  hosts: readonly string[] | undefined
): boolean => {
  if (hosts === undefined) {
    return true;
  }

  return (
    host !== undefined &&
    hosts.some((taken) => {
      return asciiLowerCase(taken) === asciiLowerCase(host);
    })
  );
};

/**
 * Whether a request from `origin` is taken: one without an `Origin` comes from no page, and from
 * anywhere; one among `origins`, exactly; or the server's own, `http://` or `https://` followed by
 * the request's `host`, compared ASCII case-insensitively. The field is read as the serialized
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
