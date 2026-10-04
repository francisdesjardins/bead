// ── Secure ────────────────────────────────────────────────────────────────────

// constants

// an IPv4 address as a URL's host is written once parsed: four decimal numbers
const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

// the schemes under TLS
const SECURE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:']);

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
 * origin potentially trustworthy, by what it is given, never by what a name resolves to: `localhost`
 * or a name that ends in `.localhost`, in ASCII lower case, an IPv4 address in 127.0.0.0/8, or `::1`.
 */
export const isLoopbackHost = (host: string): boolean => {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return isLoopback(hostOf(`http://${bracketed}`));
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
