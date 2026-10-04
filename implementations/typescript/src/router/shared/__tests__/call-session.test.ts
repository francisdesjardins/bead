import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import {
  connectionSessionOf,
  credentialSchemesDetailOf,
  presentedCredentialOf,
} from '../call-session';
import { CLIENT_FAILURES, CredentialScheme, ProtocolCode, SERVER_FAILURES } from '../constants';
import { FailureError } from '../errors';
import { toSessionToken } from '../identifiers';
import type { RequestCredential } from '../types';

// helpers

const TOKEN = toSessionToken(new Uint8Array(16).fill(1));
const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(2));

// definition

test.describe('credentialSchemesDetailOf', () => {
  test('names the schemes a side takes in the order of their numbers, a comma and a space between', () => {
    expect(credentialSchemesDetailOf([CredentialScheme.OPAQUE])).toBe('OPAQUE');
    expect(
      credentialSchemesDetailOf([
        CredentialScheme.ELSEWHERE,
        CredentialScheme.OPAQUE,
        CredentialScheme.JWT,
        CredentialScheme.OPAQUE,
      ])
    ).toBe('OPAQUE, JWT, ELSEWHERE');
  });
});

test.describe('connectionSessionOf', () => {
  test("runs none in the connection's session whenever it has one, and OPAQUE when it is its token, nothing else", () => {
    const asked: string[] = [];
    const dataOf = () => {
      asked.push('data');

      return 'ada';
    };
    const opaque = (token: typeof TOKEN) => {
      return { scheme: CredentialScheme.OPAQUE, token };
    };

    expect(connectionSessionOf(undefined, { dataOf, token: TOKEN })).toEqual({ data: 'ada' });
    expect(connectionSessionOf(opaque(TOKEN), { dataOf, token: TOKEN })).toEqual({ data: 'ada' });
    expect(Object.isFrozen(connectionSessionOf(undefined, { token: TOKEN }))).toBe(true);

    for (const [credential, token] of [
      [undefined, undefined],
      [opaque(TOKEN), undefined],
      [opaque(OTHER_TOKEN), TOKEN],
      [{ scheme: CredentialScheme.JWT, token: TOKEN }, TOKEN],
      [{ scheme: CredentialScheme.ELSEWHERE }, TOKEN],
    ] as const) {
      expect(connectionSessionOf(credential, { dataOf, token })).toBeUndefined();
    }

    // what the session holds is asked once it holds, and only then
    expect(asked).toEqual(['data', 'data']);
  });
});

test.describe('presentedCredentialOf', () => {
  test('presents none unless asked, OPAQUE with the token learned, and fails a call that asks before any session, SESSION_REQUIRED', () => {
    const opaque: RequestCredential = { scheme: CredentialScheme.OPAQUE };

    expect(presentedCredentialOf(undefined, { failures: CLIENT_FAILURES, token: TOKEN })).toBe(
      undefined
    );
    expect(presentedCredentialOf(opaque, { failures: CLIENT_FAILURES, token: TOKEN })).toEqual({
      scheme: CredentialScheme.OPAQUE,
      token: TOKEN,
    });

    for (const failures of [CLIENT_FAILURES, SERVER_FAILURES]) {
      let thrown: unknown;

      try {
        presentedCredentialOf(opaque, { failures, token: undefined });
      } catch (reason) {
        thrown = reason;
      }

      expect(thrown).toBeInstanceOf(FailureError);
      expect(thrown).toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        origin: 'local',
        side: failures.side,
      });
    }

    expect(() => {
      return presentedCredentialOf(
        { scheme: CredentialScheme.JWT } as unknown as RequestCredential,
        {
          failures: CLIENT_FAILURES,
          token: TOKEN,
        }
      );
    }).toThrow(ProgrammerError);
  });
});
