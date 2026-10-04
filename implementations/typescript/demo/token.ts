// ── Demo tokens ───────────────────────────────────────────────────────────────

// The demo's identity provider: an access token of RFC 9068's profile for a role, signed HS256 under
// the demo's key. The servers verify it with the runtime's own verifier, given that key as their
// credentials; nothing here verifies a token.

// dependencies

import { JwtAlgorithm } from '../src/router/shared/jwt-verifier';
import type { ICredentials } from '../src/router/shared/types';
import type { IClaims, Permission, Role } from './procedures';

// constants

/** Who issues the demo's tokens: a server holds a token's `iss` to it, octet for octet. */
const ISSUER = 'https://identity.demo.bead.example';

/** Who the demo's tokens are for, its Bead servers: a token whose `aud` names another is refused. */
const AUDIENCE = 'bead-demo';

/** The client the identity provider hands its tokens to: the demo's page. */
const CLIENT_ID = 'bead-demo-page';

/** An hour: long enough for a demo, short enough to show that a token ends. */
const LIFETIME_SECONDS = 3_600;

/** The shortest key HS256 takes, in bytes: as long as its hash's output (RFC 7518 §3.2). */
const KEY_BYTES = 32;

/** What each role is given; the server's checks read the scope, never the role. */
const PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  reader: ['read'],
  writer: ['read', 'write'],
});

/**
 * The test keys published whole with their RFCs, which `spec/check.py` watches for, each by the
 * SHA-256 of the bytes of a member that holds its material (`k`, `d`, `x`, `y`): never by the
 * material itself, nor by its thumbprint, which that check keeps to `spec/` and the tests. A demo
 * keyed with one of them would take a token anyone signs.
 */
const PUBLISHED_KEYS: ReadonlyMap<string, string> = new Map([
  ['c8ecc9361a05e285f04c26f9572131a6deab07e9e2b865053c6f75a4d8bd2b32', "RFC 7515's A.1 HMAC key"],
  [
    'cfcef6cfb631f2a350b70a6ab72b20696f65f854aa3649a26b4cc1d2b0f5ce76',
    "the d of RFC 7515's A.3 P-256 key",
  ],
  [
    'c4a8d76ecf5f712a6f98052d967a155f92e22a4151e176700b2d8077987967ab',
    "the x of RFC 7515's A.3 P-256 key",
  ],
  [
    'fab7f99fa13f824d7f119c4e162a9eb532e97717ab512f9fedddb2b139bea5a4',
    "the y of RFC 7515's A.3 P-256 key",
  ],
  [
    '43e4b74131385aec85e1f0764d6693ac5e7cc4977f998cc956e1241a818cfd1d',
    "the d of RFC 7517's A.2 P-256 key",
  ],
  [
    'fa0823c601e01670320f579ad4c5c453d77b6ca8d7bb6f2640abb11223a33580',
    "the x of RFC 7517's A.2 P-256 key",
  ],
  [
    '320c982cbda4bd3b8a43158f74eb8b9755d0c76af404998a679fbb9804176316',
    "the y of RFC 7517's A.2 P-256 key",
  ],
  ['73ec74458059c70cae3f0ade8663fe0da1dc4b114ed8cdac75364140b4458a4c', "RFC 7520's 3.5 HMAC key"],
]);

// the base64url alphabet (RFC 4648 §5), padding left out
const BASE64URL = /^[\w-]*$/u;

const encoder = new TextEncoder();

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

// the bytes base64url without padding writes; undefined for any other text
const bytesOf = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    return undefined;
  }

  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (character) => {
    return character.charCodeAt(0);
  });
};

const partOf = (value: unknown): string => {
  return base64urlOf(encoder.encode(JSON.stringify(value)));
};

const hexOf = (bytes: ArrayBuffer): string => {
  return [...new Uint8Array(bytes)]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
};

// definition

/** A key of 32 bytes drawn at random, as long as HS256 takes, so no token outlives what drew it. */
export const drawSecret = (): Uint8Array<ArrayBuffer> => {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
};

/**
 * The demo's key: the bytes `given` writes in base64url, as a JWK's `k` does, or one drawn at random
 * when nothing is given. Rejects, saying why, for a key that does not read as base64url, one
 * shorter than HS256 takes, or one published with its RFC.
 */
export const secretOf = async (given: string | undefined): Promise<Uint8Array<ArrayBuffer>> => {
  if (given === undefined || given === '') {
    return drawSecret();
  }

  const secret = bytesOf(given);

  if (secret === undefined) {
    throw new Error(
      'the key does not read as base64url without padding (RFC 4648 §5), as a JWK writes its k'
    );
  }

  if (secret.length < KEY_BYTES) {
    throw new Error(
      `the key holds ${String(secret.length)} bytes, and an HS256 key ${String(KEY_BYTES)} at least (RFC 7518 §3.2)`
    );
  }

  const published = PUBLISHED_KEYS.get(hexOf(await crypto.subtle.digest('SHA-256', secret)));

  if (published !== undefined) {
    throw new Error(
      `the key is ${published}, published with its RFC: anyone can sign a token the demo would take. Give the demo a key of its own, ${String(KEY_BYTES)} random bytes or more, or none, and it draws one`
    );
  }

  return secret;
};

/** What the demo's servers verify its tokens with: its key as a JWK, under its issuer, and its audience. */
export const credentialsOf = (secret: Uint8Array): ICredentials => {
  return Object.freeze({
    audience: AUDIENCE,
    keys: [
      {
        algorithm: JwtAlgorithm.HS256,
        issuer: ISSUER,
        jwk: { k: base64urlOf(secret), kty: 'oct' },
      },
    ],
  });
};

/** The key the identity provider signs with, HMAC-SHA256 (RFC 2104), by Web Crypto. */
export const keyOf = (secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  return crypto.subtle.importKey('raw', secret, { hash: 'SHA-256', name: 'HMAC' }, false, ['sign']);
};

/**
 * An access token for `role`, of RFC 9068's profile: typed `at+jwt`, with the claims it requires and
 * the role's scope (RFC 8693 §4.2), signed with `key` by HS256 (RFC 7518 §3.2). Each one names a
 * sign-in of its own, its `sid`, so the session a server makes of it is that sign-in's.
 */
export const issueToken = async (role: Role, key: CryptoKey): Promise<string> => {
  const issued = nowInSeconds();
  const claims: IClaims = {
    aud: AUDIENCE,
    client_id: CLIENT_ID,
    exp: issued + LIFETIME_SECONDS,
    iat: issued,
    iss: ISSUER,
    jti: crypto.randomUUID(),
    roles: [role],
    scope: PERMISSIONS[role].join(' '),
    sid: crypto.randomUUID(),
    sub: `demo-${role}`,
  };
  const content = `${partOf({ alg: JwtAlgorithm.HS256, typ: 'at+jwt' })}.${partOf(claims)}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(content));

  return `${content}.${base64urlOf(new Uint8Array(signature))}`;
};
