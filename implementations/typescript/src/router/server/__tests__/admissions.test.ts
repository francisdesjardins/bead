import { expect, test } from '@playwright/test';
import { CredentialScheme, EnvelopeKind, SERVER_FAILURES } from '../../shared/constants';
import type { Credential, IRequestHeader, SessionToken } from '../../shared/types';
import { requireCredential, requireSession, shareLegBSession } from '../admissions';

// helpers

/** A request's header, presenting `credential` when given. */
const headerOf = (credential?: Credential): IRequestHeader => {
  return {
    callId: 1,
    kind: EnvelopeKind.REQUEST,
    procedureId: 1,
    serviceId: 2,
    ...(credential === undefined ? {} : { credential }),
  };
};

const SESSION = Object.freeze({ data: 'ada' });
const CREDENTIALS: readonly (Credential | undefined)[] = [
  undefined,
  { scheme: CredentialScheme.JWT, token: 'a.b.c' },
  { scheme: CredentialScheme.ELSEWHERE },
];
const OPAQUE = { scheme: CredentialScheme.OPAQUE, token: 'A'.repeat(22) as SessionToken } as const;

// definition

test.describe('requireSession', () => {
  test('admits a call with a session, its call’s, whatever its header presents, and refuses one in none, SESSION_REQUIRED', () => {
    expect(
      CREDENTIALS.map((credential) => {
        const header = headerOf(credential);

        return [SESSION, undefined].map((session) => {
          const request = { header, session };

          return requireSession(request);
        });
      })
    ).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ]);
    expect(requireSession.refusal).toBe(SERVER_FAILURES.sessionRequired);
  });
});

test.describe('requireCredential', () => {
  // spec 14.3.1
  test('admits a call presenting a JWT or an ELSEWHERE by its scheme alone, and refuses none and OPAQUE, in a session or in none, ACCESS_DENIED with its detail', () => {
    expect(
      [...CREDENTIALS, OPAQUE].map((credential) => {
        const header = headerOf(credential);

        // the call's session read nowhere: in one or in none, the same
        return [SESSION, undefined].map((session) => {
          const request = { header, session };

          return requireCredential(request);
        });
      })
    ).toEqual([
      [false, false],
      [true, true],
      [true, true],
      [false, false],
    ]);
    expect(requireCredential.refusal).toEqual({
      ...SERVER_FAILURES.accessDenied,
      detail: 'a relay admits by default only a credential it forwards',
    });
    expect(Object.isFrozen(requireCredential.refusal)).toBe(true);
  });
});

test.describe('shareLegBSession', () => {
  // spec 14.3.1
  test('admits a call in a session, or presenting a JWT or an ELSEWHERE by its scheme alone, and refuses any other in none, SESSION_REQUIRED', () => {
    expect(
      CREDENTIALS.map((credential) => {
        return [
          shareLegBSession({ header: headerOf(credential), session: SESSION }),
          shareLegBSession({ header: headerOf(credential), session: undefined }),
        ];
      })
    ).toEqual([
      [true, false],
      [true, true],
      [true, true],
    ]);
    expect(shareLegBSession.refusal).toBe(SERVER_FAILURES.sessionRequired);
  });
});
