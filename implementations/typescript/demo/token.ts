// ── Demo tokens ───────────────────────────────────────────────────────────────

// dependencies

import type { IClaims, Permission, Role } from './procedures';

// constants

/** The one algorithm taken: a token that names another — `none`, say — is refused. */
const ALGORITHM = 'HS256';

/** An hour: long enough for a demo, short enough to show that a token ends. */
const LIFETIME_SECONDS = 3_600;

/** What each role is given; the server's checks read the permissions, never the role. */
const PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  reader: ['read'],
  writer: ['read', 'write'],
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// helpers

const nowInSeconds = (): number => {
  return Math.floor(Date.now() / 1_000);
};

// bytes as base64url without padding (RFC 4648 §5), in Node and in a browser alike
const base64urlOf = (bytes: Uint8Array): string => {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const bytesOf = (part: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    return Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), (character) => {
      return character.charCodeAt(0);
    });
  } catch {
    return undefined;
  }
};

const partOf = (value: unknown): string => {
  return base64urlOf(encoder.encode(JSON.stringify(value)));
};

const parsedOf = (part: string): unknown => {
  const bytes = bytesOf(part);

  try {
    return bytes === undefined ? undefined : JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
};

// definition

/**
 * The key `secret` signs and checks with, HMAC-SHA256 (RFC 2104), by Web Crypto: the same in Node
 * and in a worker.
 */
export const keyOf = (secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  return crypto.subtle.importKey('raw', secret, { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
    'verify',
  ]);
};

/**
 * A JSON Web Token for `role`, signed with `key` by HMAC-SHA256 (RFC 7519, RFC 7518 §3.2): what the
 * demo's identity provider hands out. A fake one: its secret is drawn as the demo starts.
 */
export const issueToken = async (role: Role, key: CryptoKey): Promise<string> => {
  const issued = nowInSeconds();
  const claims: IClaims = {
    exp: issued + LIFETIME_SECONDS,
    iat: issued,
    permissions: [...PERMISSIONS[role]],
    role,
    sub: `demo-${role}`,
  };
  const content = `${partOf({ alg: ALGORITHM, typ: 'JWT' })}.${partOf(claims)}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(content));

  return `${content}.${base64urlOf(new Uint8Array(signature))}`;
};

/**
 * The claims of a token `key` signed, or why it is refused: its shape, its algorithm, its signature
 * — which Web Crypto checks in constant time — then its expiry, in that order, so nothing it claims
 * is read before its signature holds.
 */
export const verifyToken = async (
  token: string,
  key: CryptoKey
): Promise<IClaims | { refusal: string }> => {
  const [header, payload, signature, ...rest] = token.split('.');

  if (header === undefined || payload === undefined || signature === undefined || rest.length > 0) {
    return { refusal: 'a token has three parts, parted by dots' };
  }

  const { alg } = (parsedOf(header) ?? {}) as { alg?: unknown };

  if (alg !== ALGORITHM) {
    return { refusal: `a token is signed by ${ALGORITHM}, not by ${String(alg)}` };
  }

  const given = bytesOf(signature);
  const holds =
    given !== undefined &&
    (await crypto.subtle.verify('HMAC', key, given, encoder.encode(`${header}.${payload}`)));

  if (!holds) {
    return { refusal: 'the signature does not match what the token says' };
  }

  const claims = parsedOf(payload) as IClaims;

  if (claims.exp <= nowInSeconds()) {
    return { refusal: 'the token has expired' };
  }

  return claims;
};
