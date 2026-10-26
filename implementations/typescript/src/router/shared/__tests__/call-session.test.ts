import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import {
  connectionSessionOf,
  credentialSchemesDetailOf,
  handedHeaderOf,
  presentedCredentialOf,
  sessionKeyOf,
  uncarriedOf,
} from '../call-session';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { FailureError } from '../errors';
import { toSessionToken } from '../identifiers';
import type { RequestCredential } from '../types';

// helpers

const TOKEN = toSessionToken(new Uint8Array(16).fill(1));
const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(2));

// definition

test.describe('credentialSchemesDetailOf', () => {
  test('names a scheme to come by the word scheme and its number, in the order of the numbers', () => {
    expect(
      credentialSchemesDetailOf([65_535, CredentialScheme.ELSEWHERE, 4, CredentialScheme.OPAQUE, 4])
    ).toBe('OPAQUE, ELSEWHERE, scheme 4, scheme 65535');
    expect(credentialSchemesDetailOf([])).toBe('');
  });

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
    expect(credentialSchemesDetailOf([CredentialScheme.ELSEWHERE, CredentialScheme.OPAQUE])).toBe(
      'OPAQUE, ELSEWHERE'
    );
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

test.describe('handedHeaderOf', () => {
  test('keeps of a JWT its scheme alone, in a copy, and hands any other header as it came', () => {
    const header = { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 };
    const jwt = { ...header, credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' } };
    const handed = handedHeaderOf(jwt);

    expect(handed).toStrictEqual({ ...header, credential: { scheme: CredentialScheme.JWT } });
    // the header as it came keeps its token, for its verifier; one made already is made to itself
    expect(jwt.credential.token).toBe('a.b.c');
    expect(handedHeaderOf(handed)).toBe(handed);

    for (const credential of [
      undefined,
      { scheme: CredentialScheme.OPAQUE, token: TOKEN },
      { scheme: CredentialScheme.ELSEWHERE },
    ] as const) {
      const other = { ...header, credential };

      expect(handedHeaderOf(other)).toBe(other);
    }
  });
});

test.describe('presentedCredentialOf', () => {
  test('presents none unless asked, OPAQUE with the token learned, and fails a call that asks before any session, SESSION_REQUIRED', () => {
    const opaque: RequestCredential = { scheme: CredentialScheme.OPAQUE };

    expect(presentedCredentialOf(undefined, { failures: CLIENT_FAILURES, token: TOKEN })).toEqual(
      {}
    );
    expect(presentedCredentialOf(opaque, { failures: CLIENT_FAILURES, token: TOKEN })).toEqual({
      credential: { scheme: CredentialScheme.OPAQUE, token: TOKEN },
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
        detail: 'no session is known for OPAQUE to stand for',
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

  test('presents NONE as none, a JWT as given, and an ELSEWHERE as its scheme, its value beside it for its transport', () => {
    const presented = (credential: RequestCredential) => {
      return presentedCredentialOf(credential, { failures: CLIENT_FAILURES, token: TOKEN });
    };

    expect(presented({ scheme: CredentialScheme.NONE })).toEqual({});
    expect(presented({ scheme: CredentialScheme.JWT, token: 'a.b.c' })).toEqual({
      credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' },
    });
    expect(
      presented({ carried: 'Bearer mF_9.B5f-4.1JqM', scheme: CredentialScheme.ELSEWHERE })
    ).toEqual({
      carried: 'Bearer mF_9.B5f-4.1JqM',
      credential: { scheme: CredentialScheme.ELSEWHERE },
    });

    for (const refused of [
      { scheme: CredentialScheme.JWT, token: '' },
      { scheme: CredentialScheme.ELSEWHERE },
      { scheme: 4 },
    ]) {
      expect(() => {
        return presented(refused as unknown as RequestCredential);
      }).toThrow(ProgrammerError);
    }
  });
});

test.describe('uncarriedOf', () => {
  test('fails an ELSEWHERE over a transport that carries none, and a JWT or an ELSEWHERE over one not secure, DESTINATION_UNREACHABLE; none or OPAQUE goes over any', () => {
    const jwt = { scheme: CredentialScheme.JWT, token: 'a.b.c' } as const;
    const elsewhere = { scheme: CredentialScheme.ELSEWHERE } as const;
    const opaque = { scheme: CredentialScheme.OPAQUE, token: TOKEN } as const;
    // a transport that carries every credential, none, or one alone, as a WebSocket's upgrade did
    const every = () => {
      return true;
    };
    const none = () => {
      return false;
    };
    const one = (credential: string) => {
      return credential === 'Interop sub=ada';
    };
    const codeOf = (
      credential: Parameters<typeof uncarriedOf>[0],
      [carries, isSecure]: [((credential: string) => boolean) | undefined, boolean]
    ) => {
      return uncarriedOf(credential, {
        carried: credential === elsewhere ? 'Interop sub=bob' : undefined,
        carries,
        failures: CLIENT_FAILURES,
        isSecure,
      })?.code;
    };
    const unreachable = ProtocolCode.DESTINATION_UNREACHABLE;

    expect(
      [undefined, opaque, jwt, elsewhere].map((credential) => {
        return [
          codeOf(credential, [every, true]),
          codeOf(credential, [none, true]),
          codeOf(credential, [undefined, true]),
          codeOf(credential, [one, true]),
          codeOf(credential, [every, false]),
          codeOf(credential, [none, false]),
        ];
      })
    ).toEqual([
      [undefined, undefined, undefined, undefined, undefined, undefined],
      [undefined, undefined, undefined, undefined, undefined, undefined],
      [undefined, undefined, undefined, undefined, unreachable, unreachable],
      [undefined, unreachable, unreachable, unreachable, unreachable, unreachable],
    ]);
    // the very bytes it carries go; its detail names the scheme alone, never the credential
    expect(
      uncarriedOf(elsewhere, {
        carried: 'Interop sub=ada',
        carries: one,
        failures: CLIENT_FAILURES,
        isSecure: true,
      })
    ).toBeUndefined();
    expect(
      uncarriedOf(elsewhere, {
        carried: 'Interop sub=bob',
        carries: one,
        failures: CLIENT_FAILURES,
        isSecure: true,
      })?.detail
    ).toBe(
      'its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another'
    );
    for (const credential of [jwt, elsewhere]) {
      expect(
        uncarriedOf(credential, {
          carried: credential === elsewhere ? 'Interop sub=ada' : undefined,
          carries: every,
          failures: CLIENT_FAILURES,
          isSecure: false,
        })?.detail
      ).toBe(
        'its transport leaves the machine in the clear, which a bearer credential never crosses'
      );
    }
  });
});

test.describe('sessionKeyOf', () => {
  test('keys a session by its scheme, its claim and its values: one sub under two issuers, sid and sub, and the connection’s session apart', () => {
    const keys = [
      sessionKeyOf(undefined),
      sessionKeyOf({ issuer: 'https://a.example', scheme: CredentialScheme.JWT, sub: 'grace' }),
      sessionKeyOf({ issuer: 'https://b.example', scheme: CredentialScheme.JWT, sub: 'grace' }),
      sessionKeyOf({ issuer: 'https://a.example', scheme: CredentialScheme.JWT, sid: 'grace' }),
      sessionKeyOf({ id: 'grace', scheme: CredentialScheme.ELSEWHERE }),
      sessionKeyOf({ issuer: 'https://a.example', scheme: CredentialScheme.JWT, sub: 'Grace' }),
      sessionKeyOf({ id: 'é', scheme: CredentialScheme.ELSEWHERE }),
      sessionKeyOf({ id: 'é', scheme: CredentialScheme.ELSEWHERE }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
    expect(
      sessionKeyOf({ issuer: 'https://a.example', scheme: CredentialScheme.JWT, sub: 'grace' })
    ).toBe(keys[1]);
  });
});
