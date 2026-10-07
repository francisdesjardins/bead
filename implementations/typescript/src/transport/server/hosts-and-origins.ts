// ── Hosts and origins ─────────────────────────────────────────────────────────

// constants

/** The refusal of a request that names a host the server does not take (spec 15.12). */
export const HOST_REFUSAL = 'host-refused';

/** The refusal of a request whose `Origin` is neither the server's own nor among those it takes. */
export const ORIGIN_REFUSAL = 'origin-refused';

// helpers

// a host or an origin in ASCII lower case: A to Z alone, every other character as it is
const asciiLowerCase = (text: string): string => {
  return text.replaceAll(/[A-Z]+/gu, (letters) => {
    return letters.toLowerCase();
  });
};

// definition

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
