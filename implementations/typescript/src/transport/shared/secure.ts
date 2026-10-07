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

/** The host of `url` as a URL parses it, in ASCII lower case, an IPv6 one bracketed; none when it does not parse. */
const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

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
 * Whether a host a server listens on is on the loopback, as the W3C's Secure Contexts judges an
 * origin potentially trustworthy, by what it is given, never by what a name resolves to: the host as
 * the WHATWG URL Standard's host parser reads it — `localhost` or a name that ends in `.localhost`,
 * in ASCII lower case, an IPv4 address in 127.0.0.0/8, `127.0.0.1.` among them, or `::1`, bare or
 * bracketed. A host the parser refuses, one followed by a space among them, is none.
 */
export const isLoopbackHost = (host: string): boolean => {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  if (AROUND_A_HOST.test(host) || (bracketed.startsWith('[') && !bracketed.endsWith(']'))) {
    return false;
  }

  // ! a path after it, so that the URL parser trims nothing off the host's end
  return isLoopback(hostOf(`http://${bracketed}/`));
};

/**
 * Whether a transport that reaches `url` is secure for a bearer credential (spec 13.4, RFC 6750
 * §5.3): under TLS, its scheme `wss` or `https`; or on the loopback, its host as
 * {@link isLoopbackHost} judges it. Any other leaves the machine in the clear, and so does a URL
 * that does not parse.
 */
export const isSecureUrl = (url: string): boolean => {
  try {
    return SECURE_SCHEMES.has(new URL(url).protocol) || isLoopback(hostOf(url));
  } catch {
    return false;
  }
};
