// ── Secure ────────────────────────────────────────────────────────────────────

// constants

// an IPv4 address as a URL's host is written once parsed: four decimal numbers
const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

// the schemes under TLS
const SECURE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:']);

// what the URL parser reads around a host, where the host parser refuses it: a tab or a newline,
// which it removes, and what ends a host or opens its userinfo
const AROUND_A_HOST = /[\t\n\r/?#\\@]/u;

// helpers

/** Whether a parsed host is on the loopback: `localhost`, a name in `.localhost`, 127.0.0.0/8, `::1`. */
const isLoopback = (host: string | undefined): boolean => {
  if (host === undefined) {
    return false;
  }

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    IPV4.exec(host)?.[1] === '127'
  );
};

// definition

/**
 * The host `url` names, read once as the WHATWG URL Standard's host parser reads a special scheme's
 * host, whatever its URL's scheme (spec 13.4): an IPv4 address through its IPv4 parser, `127.1` and
 * `127.0.0.1.` as `127.0.0.1`, a name percent-decoded and in ASCII lower case, an IPv6 address
 * bracketed. None where either parse fails: a URL that does not parse, or a host the parser fails
 * on, `foo.123` or `x%20.localhost`. An `mqtt:` or `amqp:` URL, whose scheme is not special, keeps
 * its host opaque, as given, which this reads as `http:` reads it.
 */
export const urlHostOf = (url: string): string | undefined => {
  try {
    // ! a path after it, so that the URL parser trims nothing off the host's end
    return new URL(`http://${new URL(url).host}/`).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Whether the address a server listens on is on the loopback (spec 13.4), as the W3C's Secure
 * Contexts judges an origin potentially trustworthy, by what it is given, never by what a name
 * resolves to: in 127.0.0.0/8, or `::1`, bare or bracketed. Read as the WHATWG URL Standard's host
 * parser reads a host — `localhost` or a name that ends in `.localhost` among the loopback's, which
 * a listening transport never takes (spec 15.12); a host the parser refuses, one followed by a
 * space among them, is none.
 */
export const isLoopbackHost = (host: string): boolean => {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  if (AROUND_A_HOST.test(host) || (bracketed.startsWith('[') && !bracketed.endsWith(']'))) {
    return false;
  }

  // ! a path after it, so that the URL parser trims nothing off the host's end
  return isLoopback(urlHostOf(`http://${bracketed}/`));
};

/**
 * Whether a transport that reaches `url` is secure for a bearer credential (spec 13.4, RFC 6750
 * §5.3): under TLS, its scheme `wss` or `https`; or on the loopback, its host read by
 * {@link urlHostOf}, whatever its scheme. Any other leaves the machine in the clear, and so does a
 * URL that does not parse or a host the parser fails on.
 */
export const isSecureUrl = (url: string): boolean => {
  const host = urlHostOf(url);

  return host !== undefined && (SECURE_SCHEMES.has(new URL(url).protocol) || isLoopback(host));
};

/**
 * Whether the host `url` names is on the loopback, read by {@link urlHostOf} whatever its scheme, as
 * {@link isSecureUrl} judges it: what a client's dialer connects to the loopback itself (spec 13.4).
 */
export const isLoopbackUrl = (url: string): boolean => {
  return isLoopback(urlHostOf(url));
};
