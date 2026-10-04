// dependencies

import { ProgrammerError } from '../../transport/shared/errors';

// interfaces

/**
 * A key a `JWT` is verified with: a JWK (RFC 7517), the issuer whose tokens it signs, and its one
 * algorithm, which the application names (RFC 8725 §3.1).
 */
export interface IJwtKey {
  readonly algorithm: JwtAlgorithm;
  readonly issuer: string;
  readonly jwk: Jwk;
}

/**
 * What {@link verifyJwt} holds a token to: the keys, the receiver's audience, and the wall clock's
 * reading, _W_, a whole number of milliseconds since the epoch.
 */
export interface IVerifyJwtProps {
  readonly audience: string;
  readonly keys: readonly IJwtKey[];
  readonly now: number;
}

// types

export type JwtAlgorithm = (typeof JwtAlgorithm)[keyof typeof JwtAlgorithm];
export type JwtRefusal = (typeof JwtRefusal)[keyof typeof JwtRefusal];

/** A JWK as a key set writes it: Web Crypto's, with the `kid` it leaves out (RFC 7517 §4.5). */
export type Jwk = JsonWebKey & { readonly kid?: string };

/** A `JWT`'s claims set, frozen to its depth. */
export type JwtClaims = Readonly<Record<string, unknown>>;

/** A `JWT`'s session's identifier: its issuer with its `sid`, else with its `sub`. */
export type JwtSessionIdentifier =
  | Readonly<{ issuer: string; sid: string }>
  | Readonly<{ issuer: string; sub: string }>;

/**
 * A `JWT`'s verdict: it holds, with its session's identifier, its claims set and its end, _E_, in
 * milliseconds since the epoch; or it does not, with the step of section 13.8 that refused it.
 */
export type JwtVerdict =
  | Readonly<{ claims: JwtClaims; end: number; holds: true; identifier: JwtSessionIdentifier }>
  | Readonly<{ holds: false; reason: JwtRefusal }>;

// constants

/**
 * The algorithms a `JWT`'s key verifies with: ES256 (RFC 7518 §3.4), for keys a federation shares
 * by their public half; HS256 (RFC 7518 §3.2), for one trust domain.
 */
export const JwtAlgorithm = Object.freeze({
  ES256: 'ES256',
  HS256: 'HS256',
} as const);

/** Why a `JWT` does not hold: the step of section 13.8 that refused it, in their order. */
export const JwtRefusal = Object.freeze({
  TOKEN: 'token',
  CRIT: 'crit',
  TYP: 'typ',
  KID: 'kid',
  ALG: 'alg',
  KEY: 'key',
  SIGNATURE: 'signature',
  ISS: 'iss',
  EXP: 'exp',
  NBF: 'nbf',
  AUD: 'aud',
  SID: 'sid',
  SUB: 'sub',
} as const);

/**
 * The leeway for clock skew on `exp` and `nbf`, in milliseconds: a constant on every side, which
 * the verdict vectors pin, never an option.
 */
export const JWT_LEEWAY = 60_000;

// the base64url alphabet (RFC 4648 §5), each character at its value
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// the media type of an access token (RFC 9068 §4), whole or without its `application/`
const ACCESS_TOKEN_TYPES: ReadonlySet<unknown> = new Set(['at+jwt', 'application/at+jwt']);

// ! a byte order mark kept, so that JSON refuses it as .NET's reader does
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// helpers

const refused = (reason: JwtRefusal): JwtVerdict => {
  return Object.freeze({ holds: false, reason });
};

const isString = (value: unknown): value is string => {
  return typeof value === 'string';
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * `text`'s bytes, strictly: base64url without padding, the bits past its last byte zero, so that
 * one string alone spells given bytes; `undefined` for any other text.
 */
const fromBase64url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (text.length % 4 === 1) {
    return undefined;
  }

  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;

  for (const character of text) {
    const value = BASE64URL.indexOf(character);

    if (value < 0) {
      return undefined;
    }

    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes[at] = buffer >> bits;
      at += 1;
    }
  }

  return (buffer & ((1 << bits) - 1)) === 0 ? bytes : undefined;
};

/** `object`'s member `name`, when it is a string of well-formed Unicode, which JSON's escapes need not write. */
const stringOf = (object: Record<string, unknown>, name: string): string | undefined => {
  const value = Object.hasOwn(object, name) ? object[name] : undefined;

  return typeof value === 'string' && value.isWellFormed() ? value : undefined;
};

/**
 * Whether every object of `text`, a JSON text already parsed, names each member once, by a
 * well-formed name: `JSON.parse` keeps the last of two, and .NET's reader both.
 */
const namesOnce = (text: string): boolean => {
  // each open object's names, undefined for an array
  const scopes: (Set<string> | undefined)[] = [];
  let expectsName = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      let end = index + 1;

      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }

      const names = scopes.at(-1);

      if (expectsName && names !== undefined) {
        const name = JSON.parse(text.slice(index, end + 1)) as string;

        if (!name.isWellFormed() || names.has(name)) {
          return false;
        }

        names.add(name);
        expectsName = false;
      }

      index = end;
    } else if (character === '{' || character === '[') {
      scopes.push(character === '{' ? new Set() : undefined);
      expectsName = character === '{';
    } else if (character === '}' || character === ']') {
      scopes.pop();
      expectsName = false;
    } else if (character === ',') {
      expectsName = scopes.at(-1) !== undefined;
    }
  }

  return true;
};

/** A header or a claims set: a JSON object in UTF-8 that names each member once; `undefined` for any other part. */
const objectOf = (part: string): Record<string, unknown> | undefined => {
  const bytes = fromBase64url(part);

  if (bytes === undefined) {
    return undefined;
  }

  try {
    const text = UTF8.decode(bytes);
    const value: unknown = JSON.parse(text);

    return isObject(value) && namesOnce(text) ? value : undefined;
  } catch {
    return undefined;
  }
};

const freezeDeeply = (root: object): void => {
  const pending = [root];

  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    Object.freeze(value);

    for (const child of Object.values(value) as unknown[]) {
      if (typeof child === 'object' && child !== null) {
        pending.push(child);
      }
    }
  }
};

// a key not shaped for its algorithm is the application's fault, never the token's: it throws, so
// the call fails rather than withdraw a credential that holds
const assertKey = ({ algorithm, issuer, jwk }: IJwtKey): void => {
  const fault = (what: string): ProgrammerError => {
    return new ProgrammerError(`a JWT's key ${what}, for the issuer ${JSON.stringify(issuer)}`);
  };

  if (!isString(issuer)) {
    throw fault('has its issuer as a string');
  }

  if (!isObject(jwk)) {
    throw fault('is a JWK, a JSON object');
  }

  if (Object.hasOwn(jwk, 'kid') && !isString(jwk['kid'])) {
    throw fault('names its kid by a string');
  }

  const bytesOf = (name: string): number => {
    const value = stringOf(jwk, name);

    return (value === undefined ? undefined : fromBase64url(value))?.length ?? -1;
  };

  switch (algorithm) {
    case JwtAlgorithm.ES256:
      if (
        jwk['kty'] !== 'EC' ||
        jwk['crv'] !== 'P-256' ||
        bytesOf('x') !== 32 ||
        bytesOf('y') !== 32
      ) {
        throw fault('of ES256 is EC on P-256, its x and y of 32 bytes each');
      }

      return;
    case JwtAlgorithm.HS256:
      if (jwk['kty'] !== 'oct' || bytesOf('k') < 32) {
        throw fault('of HS256 is oct, its k of 32 bytes at least (RFC 7518 §3.2)');
      }

      return;
    default:
      throw fault(`is of ES256 or HS256, not ${JSON.stringify(algorithm)}`);
  }
};

/**
 * The key the token names among `keys` alone: by its `kid`, the one key of that `kid`, or of
 * several the one of its `iss`; without a `kid`, its `iss`'s one key. `iss` is read unverified, to
 * choose, and held to its key's issuer once the signature verifies.
 */
const keyOf = (
  header: Record<string, unknown>,
  { claims, keys }: { claims: Record<string, unknown>; keys: readonly IJwtKey[] }
): IJwtKey | undefined => {
  const issuer = stringOf(claims, 'iss');
  const ofIssuer = (key: IJwtKey): boolean => {
    return key.issuer === issuer;
  };

  if (!Object.hasOwn(header, 'kid')) {
    const found = keys.filter(ofIssuer);

    return found.length === 1 ? found[0] : undefined;
  }

  const kid = stringOf(header, 'kid');
  const named = keys.filter((key) => {
    return kid !== undefined && key.jwk.kid === kid;
  });
  const found = named.length > 1 ? named.filter(ofIssuer) : named;

  return found.length === 1 ? found[0] : undefined;
};

/** Whether a key's JWK serves to verify: its `alg`, `use` and `key_ops`, each when present (RFC 7517 §4.2 to §4.4). */
const serves = ({ algorithm, jwk }: IJwtKey): boolean => {
  const operations: unknown = jwk.key_ops;

  return (
    (!Object.hasOwn(jwk, 'alg') || jwk.alg === algorithm) &&
    (!Object.hasOwn(jwk, 'use') || jwk.use === 'sig') &&
    (!Object.hasOwn(jwk, 'key_ops') || (Array.isArray(operations) && operations.includes('verify')))
  );
};

// * ES256's signature is R then S, 64 bytes (RFC 7518 §3.4), as Web Crypto takes it: never DER
const verifies = async (
  { algorithm, jwk }: IJwtKey,
  { signature, signingInput }: { signature: Uint8Array<ArrayBuffer>; signingInput: string }
): Promise<boolean> => {
  const data = new TextEncoder().encode(signingInput);

  if (algorithm === JwtAlgorithm.ES256) {
    if (signature.length !== 64) {
      return false;
    }

    // its point alone, so that Web Crypto reads none of the members section 13.8 has read already
    const key = await crypto.subtle.importKey(
      'jwk',
      { crv: 'P-256', kty: 'EC', x: jwk.x ?? '', y: jwk.y ?? '' },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    return crypto.subtle.verify({ hash: 'SHA-256', name: 'ECDSA' }, key, signature, data);
  }

  if (signature.length !== 32) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64url(jwk.k ?? '') ?? new Uint8Array(),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify']
  );

  return crypto.subtle.verify('HMAC', key, signature, data);
};

/** A NumericDate's milliseconds, rounded up, when it is a JSON number every side holds exactly (section 1.2). */
const millisecondsOf = (value: unknown): number | undefined => {
  const milliseconds = typeof value === 'number' ? Math.ceil(value * 1000) : undefined;

  return milliseconds !== undefined && Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
};

const namesAudience = (aud: unknown, audience: string): boolean => {
  if (typeof aud === 'string') {
    return aud === audience;
  }

  return (
    Array.isArray(aud) &&
    aud.every((name) => {
      return typeof name === 'string';
    }) &&
    aud.includes(audience)
  );
};

/** Steps 8 to 13 of section 13.8, on a token whose signature verified under `key`. */
const verdictOf = (
  claims: Record<string, unknown>,
  { audience, key, now }: { audience: string; key: IJwtKey; now: number }
): JwtVerdict => {
  if (stringOf(claims, 'iss') !== key.issuer) {
    return refused(JwtRefusal.ISS);
  }

  const expiry = millisecondsOf(claims['exp']);

  if (
    expiry === undefined ||
    expiry > Number.MAX_SAFE_INTEGER - JWT_LEEWAY ||
    now >= expiry + JWT_LEEWAY
  ) {
    return refused(JwtRefusal.EXP);
  }

  if (Object.hasOwn(claims, 'nbf')) {
    const start = millisecondsOf(claims['nbf']);

    if (start === undefined || now + JWT_LEEWAY < start) {
      return refused(JwtRefusal.NBF);
    }
  }

  if (!namesAudience(claims['aud'], audience)) {
    return refused(JwtRefusal.AUD);
  }

  const sid = stringOf(claims, 'sid');
  const sub = stringOf(claims, 'sub');

  if (Object.hasOwn(claims, 'sid') && sid === undefined) {
    return refused(JwtRefusal.SID);
  }

  if (sid === undefined && sub === undefined) {
    return refused(JwtRefusal.SUB);
  }

  freezeDeeply(claims);

  return Object.freeze({
    claims,
    end: expiry + JWT_LEEWAY,
    holds: true,
    identifier: Object.freeze(
      sid === undefined ? { issuer: key.issuer, sub: sub ?? '' } : { issuer: key.issuer, sid }
    ),
  });
};

// definition

/**
 * The verdict on `token`, a `JWT`: an access token of RFC 9068's profile in JWS Compact
 * Serialization (RFC 7515), verified as section 13.8 states, step by step, the first that fails
 * naming the verdict's reason. It settles in a later turn, Web Crypto's. Throws a
 * {@link ProgrammerError} for a key not shaped for its algorithm, an audience that is not
 * well-formed Unicode, or a reading that is not a whole number of milliseconds; rejects for a key
 * Web Crypto does not import, a point off its curve.
 */
export const verifyJwt = async (
  token: string,
  { audience, keys, now }: IVerifyJwtProps
): Promise<JwtVerdict> => {
  if (!Number.isSafeInteger(now)) {
    throw new ProgrammerError(
      `the wall clock's reading is a whole number of milliseconds, got ${String(now)}`
    );
  }

  if (!isString(audience) || !audience.isWellFormed()) {
    throw new ProgrammerError('an audience is a string of well-formed Unicode');
  }

  for (const key of keys) {
    assertKey(key);
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return refused(JwtRefusal.TOKEN);
  }

  const [encodedHeader = '', encodedClaims = '', encodedSignature = ''] = parts;
  const header = objectOf(encodedHeader);
  const claims = objectOf(encodedClaims);
  const signature = fromBase64url(encodedSignature);

  if (header === undefined || claims === undefined || signature === undefined) {
    return refused(JwtRefusal.TOKEN);
  }

  // ! jwk, jku, x5u and x5c are never read: a token names no key of its own
  if (Object.hasOwn(header, 'crit')) {
    return refused(JwtRefusal.CRIT);
  }

  if (!ACCESS_TOKEN_TYPES.has(stringOf(header, 'typ'))) {
    return refused(JwtRefusal.TYP);
  }

  const key = keyOf(header, { claims, keys });

  if (key === undefined) {
    return refused(JwtRefusal.KID);
  }

  if (stringOf(header, 'alg') !== key.algorithm) {
    return refused(JwtRefusal.ALG);
  }

  if (!serves(key)) {
    return refused(JwtRefusal.KEY);
  }

  if (!(await verifies(key, { signature, signingInput: `${encodedHeader}.${encodedClaims}` }))) {
    return refused(JwtRefusal.SIGNATURE);
  }

  return verdictOf(claims, { audience, key, now });
};
