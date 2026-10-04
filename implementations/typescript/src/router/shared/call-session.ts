// ── Call session ──────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { CredentialScheme } from './constants';
import { FailureError } from './errors';
import { isSameSessionToken } from './identifiers';
import type {
  Credential,
  ICallSession,
  IRouterFailures,
  RequestCredential,
  SessionToken,
} from './types';

// constants

// each credential scheme's name, by its number
const SCHEME_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(CredentialScheme).map(([name, scheme]) => {
    return [scheme, name];
  })
);

// definition

/**
 * `CREDENTIAL_UNSUPPORTED`'s detail, as a 401 names its schemes in `WWW-Authenticate` (RFC 9110
 * §11.6.1): the names of the credential schemes a side takes, in the order of their numbers, a
 * comma and a space between — `OPAQUE, JWT, ELSEWHERE` from one that takes them all.
 */
export const credentialSchemesDetailOf = (schemes: Iterable<number>): string => {
  return [...new Set(schemes)]
    .toSorted((first, second) => {
      return first - second;
    })
    .map((scheme) => {
      return SCHEME_NAMES.get(scheme) ?? String(scheme);
    })
    .join(', ');
};

/**
 * The connection's session a request presenting `credential` runs in, its token `token` (spec 13.1):
 * one presenting none runs in it whenever there is one; one presenting `OPAQUE`, when it is that
 * token, compared in constant time. `undefined` otherwise, any other scheme included. `dataOf` gives
 * what the session holds, asked only once it holds.
 */
export const connectionSessionOf = (
  credential: Credential | undefined,
  { dataOf, token }: { dataOf?: (() => unknown) | undefined; token: SessionToken | undefined }
): ICallSession | undefined => {
  if (token === undefined) {
    return undefined;
  }

  if (
    credential !== undefined &&
    !(
      credential.scheme === CredentialScheme.OPAQUE &&
      'token' in credential &&
      isSameSessionToken(credential.token, token)
    )
  ) {
    return undefined;
  }

  return Object.freeze({ data: dataOf?.() });
};

/**
 * The credential a call's header presents, as its options ask: none, unless they ask; `OPAQUE` with
 * `token`, the session its router learned. Throws a {@link FailureError} of `failures`' table,
 * `SESSION_REQUIRED`, when they ask `OPAQUE` and the router knows no session — the call fails before
 * it goes — and a {@link ProgrammerError} for any other scheme.
 */
export const presentedCredentialOf = (
  requested: RequestCredential | undefined,
  { failures, token }: { failures: IRouterFailures; token: SessionToken | undefined }
): Credential | undefined => {
  if (requested === undefined) {
    return undefined;
  }

  if ((requested.scheme as number) !== CredentialScheme.OPAQUE) {
    throw new ProgrammerError(
      `a call presents OPAQUE, or no credential at all, not scheme ${String(requested.scheme)}`
    );
  }

  if (token === undefined) {
    throw new FailureError({
      ...failures.sessionRequired,
      detail: 'the call presents OPAQUE, and this side knows no session to present',
    });
  }

  return { scheme: CredentialScheme.OPAQUE, token };
};
