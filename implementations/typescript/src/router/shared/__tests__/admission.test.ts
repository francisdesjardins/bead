import { expect, test } from '@playwright/test';
import { admissionOf, isAdmissionFailure } from '../admission';
import { CLIENT_FAILURES, CredentialScheme, FailureScope, SERVER_FAILURES } from '../constants';
import { toSessionToken } from '../identifiers';
import type { IAdmissionRequest, IBeforeRequest } from '../types';

// helpers

type Handle = 'a' | 'b';

const request: IAdmissionRequest<Handle> = {
  connectionHandle: 'a',
  header: { callId: 1, kind: 0x10, procedureId: 1, serviceId: 2 },
};

// definition

test.describe('isAdmissionFailure', () => {
  test('is one of the two admission failures of the table’s own side, and nothing else', () => {
    expect(isAdmissionFailure(SERVER_FAILURES.accessDenied, SERVER_FAILURES)).toBe(true);
    expect(isAdmissionFailure(SERVER_FAILURES.sessionRequired, SERVER_FAILURES)).toBe(true);
    // the other side's, another code, the procedure's own, or no failure at all
    expect(isAdmissionFailure(CLIENT_FAILURES.accessDenied, SERVER_FAILURES)).toBe(false);
    expect(isAdmissionFailure(SERVER_FAILURES.payloadTooLarge, SERVER_FAILURES)).toBe(false);
    expect(
      isAdmissionFailure(
        { ...SERVER_FAILURES.accessDenied, scope: FailureScope.APPLICATION },
        SERVER_FAILURES
      )
    ).toBe(false);

    for (const failure of [undefined, null, 33, 'ACCESS_DENIED']) {
      expect(isAdmissionFailure(failure, SERVER_FAILURES)).toBe(false);
    }
  });
});

test.describe('admissionOf', () => {
  test('admits on `true` alone, and refuses anything else with its refusal, or access denied', () => {
    const asked: IAdmissionRequest<Handle>[] = [];
    const answers: unknown[] = [true, false, 1, 'yes', undefined];
    const plain: IBeforeRequest<Handle> = (admission) => {
      asked.push(admission);

      return answers.shift() as boolean;
    };
    const admit = admissionOf(plain, SERVER_FAILURES);

    expect(
      Array.from({ length: 5 }, () => {
        return admit(request);
      })
    ).toEqual([
      undefined,
      SERVER_FAILURES.accessDenied,
      SERVER_FAILURES.accessDenied,
      SERVER_FAILURES.accessDenied,
      SERVER_FAILURES.accessDenied,
    ]);
    // asked with the request's connection and header alone
    expect(asked).toEqual(
      Array.from({ length: 5 }, () => {
        return request;
      })
    );

    const withRefusal = Object.assign(
      () => {
        return false;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    );

    expect(admissionOf(withRefusal, SERVER_FAILURES)(request)).toBe(
      SERVER_FAILURES.sessionRequired
    );
  });

  test('keeps its refusal SESSION_REQUIRED whatever the call presented, for its router to answer', () => {
    const credentials = [
      undefined,
      { scheme: CredentialScheme.OPAQUE, token: toSessionToken(new Uint8Array(16).fill(1)) },
      { scheme: CredentialScheme.JWT, token: 'a.b.c' },
      { scheme: CredentialScheme.ELSEWHERE },
    ] as const;

    for (const failures of [SERVER_FAILURES, CLIENT_FAILURES]) {
      const refusal = { ...failures.sessionRequired, detail: 'sign in first' };
      const refusing = Object.assign(
        () => {
          return false;
        },
        { refusal }
      );

      // the router answers it ACCESS_DENIED to a call that presented a credential, whatever handler
      // refused it
      for (const credential of credentials) {
        const presenting = {
          ...request,
          header: { ...request.header, ...(credential === undefined ? {} : { credential }) },
        };

        expect(admissionOf(refusing, failures)(presenting)).toBe(refusal);
      }
    }
  });

  test('throws what the admission throws', () => {
    const thrown = new Error('no admission today');
    const throwing: IBeforeRequest<Handle> = () => {
      throw thrown;
    };

    expect(() => {
      return admissionOf(throwing, SERVER_FAILURES)(request);
    }).toThrow(thrown);
  });
});
