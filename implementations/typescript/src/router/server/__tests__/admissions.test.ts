import { expect, test } from '@playwright/test';
import { CredentialScheme, EnvelopeKind, SERVER_FAILURES } from '../../shared/constants';
import type { Credential, IRequestHeader } from '../../shared/types';
import { requireSession, requireSessionOrCredential } from '../admissions';

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

test.describe('requireSessionOrCredential', () => {
  test('admits a call in a session, or presenting a JWT or an ELSEWHERE by its scheme alone, and refuses any other in none, SESSION_REQUIRED', () => {
    expect(
      CREDENTIALS.map((credential) => {
        return [
          requireSessionOrCredential({ header: headerOf(credential), session: SESSION }),
          requireSessionOrCredential({ header: headerOf(credential), session: undefined }),
        ];
      })
    ).toEqual([
      [true, false],
      [true, true],
      [true, true],
    ]);
    expect(requireSessionOrCredential.refusal).toBe(SERVER_FAILURES.sessionRequired);
  });
});
