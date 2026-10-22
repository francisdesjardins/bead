import { expect, test } from '@playwright/test';
import { GenericError } from '../../../transport/shared/errors';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  FailureScope,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { DisconnectError, FailureError, failureErrorOf, redactHeader } from '../errors';
import { toSessionToken } from '../identifiers';
import type { IFailureHeader, IResultHeader } from '../types';

// definition

test.describe('DisconnectError', () => {
  test('is a GenericError of its own name', () => {
    const error = new DisconnectError('closed before the answer');

    expect(error).toBeInstanceOf(GenericError);
    expect(error.name).toBe('DisconnectError');
    expect(error.message).toBe('closed before the answer');
  });
});
test.describe('FailureError', () => {
  const token = toSessionToken(new Uint8Array(16).fill(7));

  test('carries the failure and where it belongs, and keeps a redacted copy of the header', () => {
    const header: IFailureHeader = {
      callId: 3,
      credential: { scheme: CredentialScheme.OPAQUE, token },
      kind: 0x12,
    };
    const cause = new Error('underneath');
    const error = new FailureError(
      {
        ...SERVER_FAILURES.procedureUnknown,
        detail: 'no procedure 1 in service 2',
        origin: 'peer',
      },
      { cause, destinationId: 5, header, procedureAddress: { procedureId: 1, serviceId: 2 } }
    );

    header.callId = 99;

    expect(error).toBeInstanceOf(GenericError);
    expect(error.name).toBe('FailureError');
    expect(error).toMatchObject({
      code: 19,
      destinationId: 5,
      detail: 'no procedure 1 in service 2',
      origin: 'peer',
      procedureAddress: { procedureId: 1, serviceId: 2 },
      relays: 0,
      scope: FailureScope.PROTOCOL,
      side: 'server',
    });
    expect(error.header).toEqual({
      callId: 3,
      credentialScheme: CredentialScheme.OPAQUE,
      kind: 0x12,
    });
    expect(error.header).not.toHaveProperty('credential');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error.cause).toBe(cause);
  });

  test('is local, through no relay, with no detail and nothing it belongs to, when not told', () => {
    const error = new FailureError(CLIENT_FAILURES.payloadTooLarge);

    expect(error).toMatchObject({
      code: 34,
      destinationId: undefined,
      detail: '',
      header: undefined,
      origin: 'local',
      procedureAddress: undefined,
      relays: 0,
      side: 'client',
    });
    expect(error.message).toBe('local client protocol failure 34 PAYLOAD_TOO_LARGE');
  });

  test('says a local protocol failure by its side, its code and its name', () => {
    // an empty detail says nothing
    expect(new FailureError({ ...SERVER_FAILURES.accessDenied, detail: '' }).message).toBe(
      'local server protocol failure 33 ACCESS_DENIED'
    );
    expect(
      new FailureError({ ...CLIENT_FAILURES.envelopeMalformed, detail: 'a call id is never 0' })
        .message
    ).toBe('local client protocol failure 1 ENVELOPE_MALFORMED: a call id is never 0');
    // raised by the peer, it is not local
    expect(
      new FailureError({
        ...SERVER_FAILURES.procedureUnknown,
        detail: 'no procedure 1 in service 2',
        origin: 'peer',
      }).message
    ).toBe('server protocol failure 19 PROCEDURE_UNKNOWN: no procedure 1 in service 2');
  });

  test('says a failure relayed has no side it knows', () => {
    expect(
      new FailureError({ code: 18, origin: 'relayed', relays: 1, scope: FailureScope.PROTOCOL })
        .message
    ).toBe('unknown side protocol failure 18 SERVICE_UNKNOWN, through 1 relay');
    expect(
      new FailureError({
        code: 18,
        detail: 'gone',
        origin: 'relayed',
        relays: 2,
        scope: FailureScope.PROTOCOL,
      }).message
    ).toBe('unknown side protocol failure 18 SERVICE_UNKNOWN, through 2 relays: gone');
  });

  test('names no protocol code for an application failure', () => {
    const error = new FailureError(
      {
        code: 21,
        detail: 'out of range',
        origin: 'peer',
        scope: FailureScope.APPLICATION,
        side: 'server',
      },
      { procedureAddress: { procedureId: 1, serviceId: 2 } }
    );

    expect(error.message).toBe(
      'server application failure 21 (service 2, procedure 1): out of range'
    );
    expect(error).toMatchObject({ code: 21, origin: 'peer', scope: FailureScope.APPLICATION });
    expect(
      new FailureError({
        code: 21,
        origin: 'peer',
        scope: FailureScope.APPLICATION,
        side: 'client',
      }).message
    ).toBe('client application failure 21');
  });

  // spec 8.1
  test('keeps a protocol code no name has as a number', () => {
    expect(
      new FailureError({ code: 77, origin: 'peer', scope: FailureScope.PROTOCOL, side: 'client' })
        .message
    ).toBe('client protocol failure 77');
  });

  test('"isProtocol" matches the protocol codes, and the side when given; through a relay, the code alone', () => {
    const error = new FailureError({ ...SERVER_FAILURES.serviceUnknown, origin: 'peer' });

    expect(error.isProtocol(ProtocolCode.SERVICE_UNKNOWN)).toBe(true);
    expect(error.isProtocol([ProtocolCode.PROCEDURE_UNKNOWN, ProtocolCode.SERVICE_UNKNOWN])).toBe(
      true
    );
    expect(error.isProtocol(ProtocolCode.PROCEDURE_UNKNOWN)).toBe(false);
    expect(error.isProtocol(ProtocolCode.SERVICE_UNKNOWN, 'server')).toBe(true);
    expect(error.isProtocol(ProtocolCode.SERVICE_UNKNOWN, 'client')).toBe(false);
    expect(error.isApplication()).toBe(false);

    const relayed = new FailureError({
      code: 18,
      origin: 'relayed',
      relays: 1,
      scope: FailureScope.PROTOCOL,
    });

    // its scope travelled with it; who raised it did not
    expect(relayed.isProtocol(ProtocolCode.SERVICE_UNKNOWN)).toBe(true);
    expect(relayed.isProtocol(ProtocolCode.PROCEDURE_UNKNOWN)).toBe(false);
    expect(relayed.isProtocol(ProtocolCode.SERVICE_UNKNOWN, 'server')).toBe(false);
    expect(relayed.isProtocol(ProtocolCode.SERVICE_UNKNOWN, 'client')).toBe(false);
  });

  test('"isApplication" matches the procedure’s own codes, never a protocol code of the same number', () => {
    const error = new FailureError({ code: 21, scope: FailureScope.APPLICATION, side: 'server' });

    expect(error.isApplication()).toBe(true);
    expect(error.isApplication(21)).toBe(true);
    expect(error.isApplication([7, 21])).toBe(true);
    expect(error.isApplication(7)).toBe(false);
    expect(error.isProtocol(ProtocolCode.SUBSCRIPTION_UNKNOWN)).toBe(false);

    const protocol = new FailureError(SERVER_FAILURES.subscriptionUnknown);

    expect(protocol.isApplication()).toBe(false);
    expect(protocol.isApplication(21)).toBe(false);
  });
});

test.describe('failureErrorOf', () => {
  const header: IFailureHeader = { callId: 3, kind: 0x12 };

  test('is the peer’s, of the other side, through no relay', () => {
    const fromServer = failureErrorOf(
      { code: 19, detail: '', relays: 0, scope: FailureScope.PROTOCOL },
      {
        destinationId: 4,
        failures: CLIENT_FAILURES,
        header,
        procedureAddress: { procedureId: 1, serviceId: 2 },
      }
    );

    expect(fromServer).toMatchObject({
      destinationId: 4,
      origin: 'peer',
      procedureAddress: { procedureId: 1, serviceId: 2 },
      side: 'server',
    });
    expect(fromServer.header).toStrictEqual({ callId: 3, kind: 0x12 });
    expect(
      failureErrorOf(
        { code: 19, detail: '', relays: 0, scope: FailureScope.PROTOCOL },
        { failures: SERVER_FAILURES, header }
      ).side
    ).toBe('client');
  });

  test('is of no known side through a relay, and names where its call went', () => {
    const relayed = failureErrorOf(
      { code: 18, detail: '', relays: 1, scope: FailureScope.PROTOCOL },
      { destinationId: 4, failures: CLIENT_FAILURES, header }
    );

    expect(relayed).toMatchObject({
      destinationId: 4,
      origin: 'relayed',
      relays: 1,
      side: undefined,
    });
  });
});

test.describe('redactHeader', () => {
  test('leaves the credential out and says its scheme alone, when there was one', () => {
    const token = toSessionToken(new Uint8Array(16).fill(9));
    const result: IResultHeader = {
      callId: 2,
      credential: { scheme: CredentialScheme.OPAQUE, token },
      kind: 0x11,
    };
    const request = { callId: 1, kind: 0x10, procedureId: 1, serviceId: 2 } as const;

    expect(redactHeader(result)).toStrictEqual({
      callId: 2,
      credentialScheme: CredentialScheme.OPAQUE,
      kind: 0x11,
    });
    // an ended session is announced, and names none
    expect(
      redactHeader({ ...result, credential: { scheme: CredentialScheme.NONE } })
    ).toStrictEqual({ callId: 2, credentialScheme: CredentialScheme.NONE, kind: 0x11 });
    expect(redactHeader({ callId: 3, kind: 0x13 })).toStrictEqual({ callId: 3, kind: 0x13 });
    expect(
      redactHeader({ ...request, credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' } })
    ).toStrictEqual({ ...request, credentialScheme: CredentialScheme.JWT });
    expect(
      redactHeader({ ...request, credential: { bytes: new Uint8Array([1, 2]), scheme: 7 } })
    ).toStrictEqual({ ...request, credentialScheme: 7 });
  });
});
