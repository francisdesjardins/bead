// ── Call session ──────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { CredentialScheme } from './constants';
import { FailureError } from './errors';
import { isSameSessionToken } from './identifiers';
import type {
  Credential,
  ICallSession,
  IFailure,
  IRouterFailures,
  RequestCredential,
  SessionIdentifier,
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
 * The key a session is held under, per connection (spec 11.3, 13.10): `''` for its connection's
 * session, which a call presenting none runs in; for a credential's, its identifier's scheme, claim
 * name and values, written so that two keys are one exactly when the identifiers are one, octet for
 * octet.
 */
export const sessionKeyOf = (identifier: SessionIdentifier | undefined): string => {
  if (identifier === undefined) {
    return '';
  }

  if ('id' in identifier) {
    return JSON.stringify([identifier.scheme, 'id', identifier.id]);
  }

  return 'sid' in identifier
    ? JSON.stringify([identifier.scheme, 'sid', identifier.issuer, identifier.sid])
    : JSON.stringify([identifier.scheme, 'sub', identifier.issuer, identifier.sub]);
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
 * The credential a call's header presents, and what its transport carries beside it, as its options
 * ask: none, unless they ask one, or ask `NONE`; `OPAQUE` with `token`, the session its router
 * learned; a `JWT`, its token; an `ELSEWHERE`, its scheme in the header, and its value beside it.
 * Throws a {@link FailureError} of `failures`' table, `SESSION_REQUIRED`, when they ask `OPAQUE` and
 * the router knows no session — the call fails before it goes — and a {@link ProgrammerError} for a
 * `JWT` with no token, an `ELSEWHERE` with no value, or any other scheme.
 */
export const presentedCredentialOf = (
  requested: RequestCredential | undefined,
  { failures, token }: { failures: IRouterFailures; token: SessionToken | undefined }
): { carried?: string | undefined; credential?: Credential | undefined } => {
  const {
    carried,
    scheme,
    token: presented,
  } = (requested ?? {}) as {
    carried?: unknown;
    scheme?: unknown;
    token?: unknown;
  };

  switch (scheme) {
    case undefined:
    case CredentialScheme.NONE:
      return {};
    case CredentialScheme.OPAQUE:
      if (token === undefined) {
        throw new FailureError({
          ...failures.sessionRequired,
          detail: 'the call presents OPAQUE, and this side knows no session to present',
        });
      }

      return { credential: { scheme: CredentialScheme.OPAQUE, token } };
    case CredentialScheme.JWT:
      if (typeof presented !== 'string' || presented.length === 0) {
        throw new ProgrammerError('a call that presents a JWT gives its token, a string');
      }

      return { credential: { scheme: CredentialScheme.JWT, token: presented } };
    case CredentialScheme.ELSEWHERE:
      if (typeof carried !== 'string') {
        throw new ProgrammerError(
          'a call that presents ELSEWHERE gives what its transport carries, a string'
        );
      }

      return { carried, credential: { scheme: CredentialScheme.ELSEWHERE } };
    default:
      throw new ProgrammerError(
        `a call presents NONE, OPAQUE, JWT or ELSEWHERE, not scheme ${String(scheme)}`
      );
  }
};

/**
 * The failure of a call presenting `credential` that its transport cannot carry (spec 13.4):
 * `DESTINATION_UNREACHABLE`, nothing tried, for an `ELSEWHERE` whose `carried` its transport does
 * not carry beside an envelope — none, or, over a WebSocket, another than its upgrade's — and for a
 * `JWT` or an `ELSEWHERE` over one that is not secure; `undefined` for a call it carries, any
 * presenting none or `OPAQUE` among them. Its detail names the scheme alone, never the credential
 * (spec 15.1).
 */
export const uncarriedOf = (
  credential: Credential | undefined,
  options: {
    /** What an `ELSEWHERE` gives its transport to carry. */
    carried: string | undefined;
    /** Whether the transport carries a credential beside an envelope; none, without it. */
    carries: ((credential: string) => boolean) | undefined;
    failures: IRouterFailures;
    isSecure: boolean;
  }
): IFailure | undefined => {
  const { carried, carries, failures, isSecure } = options;
  const scheme = credential?.scheme;

  if (scheme !== CredentialScheme.JWT && scheme !== CredentialScheme.ELSEWHERE) {
    return undefined;
  }

  if (
    scheme === CredentialScheme.ELSEWHERE &&
    (carried === undefined || carries?.(carried) !== true)
  ) {
    return {
      ...failures.destinationUnreachable,
      detail:
        'its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another',
    };
  }

  return isSecure
    ? undefined
    : {
        ...failures.destinationUnreachable,
        detail:
          'its transport leaves the machine in the clear, which a bearer credential never crosses',
      };
};
