import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  FailureScope,
  ProtocolCode,
} from '../../../src/router/client/router-client';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import { bytesOf, envelopeLineOf, failureWordsOf, originWordsOf, spanOf } from '../words';

// definition

test.describe('envelopeLineOf', () => {
  test('says an envelope in words: what a request opens and presents, what an answer announces, a credit’s reach, a chunk’s place', () => {
    expect(
      envelopeLineOf({
        callId: 5,
        credentialScheme: CredentialScheme.JWT,
        kind: EnvelopeKind.REQUEST,
        opensSubscription: true,
        paced: true,
      })
    ).toBe('REQUEST · paced subscription · credential JWT');
    expect(
      envelopeLineOf({
        callId: 3,
        credentialScheme: CredentialScheme.OPAQUE,
        kind: EnvelopeKind.RESULT,
        total: 2_621_440,
      })
    ).toBe('RESULT · opens a transfer of 2.5 MiB · announces a session, OPAQUE');
    expect(
      envelopeLineOf({
        callId: 3,
        credentialScheme: CredentialScheme.NONE,
        kind: EnvelopeKind.FAILURE,
      })
    ).toBe('FAILURE · announces the session ended, NONE');
    expect(envelopeLineOf({ callId: 3, creditEnd: 2_621_440, kind: EnvelopeKind.CREDIT })).toBe(
      'CREDIT · up to 2.5 MiB'
    );
    expect(
      envelopeLineOf({ callId: 3, creditEnd: 1, kind: EnvelopeKind.CREDIT, paced: true })
    ).toBe('CREDIT · up to 1 notification');
    expect(
      envelopeLineOf({ callId: 3, isLast: false, kind: EnvelopeKind.CHUNK, offset: 1_048_576 })
    ).toBe('CHUNK · at 1 MiB · more');
    expect(envelopeLineOf({ callId: 3, kind: 0x90 })).toBe('0x90');
  });
});

test.describe('failureWordsOf and originWordsOf', () => {
  test('name a failure by its code, the procedure’s own as such, and where it was raised', () => {
    const relayed = {
      code: ProtocolCode.ACCESS_DENIED,
      message: '',
      name: 'FailureError',
      origin: 'relayed',
      relays: 2,
      scope: FailureScope.PROTOCOL,
    };

    expect(failureWordsOf(relayed)).toBe('ACCESS_DENIED, beyond 2 relays');
    expect(originWordsOf(relayed)).toBe('raised beyond 2 relays');
    expect(
      failureWordsOf({
        code: 7,
        message: '',
        name: 'FailureError',
        scope: FailureScope.APPLICATION,
      })
    ).toBe('procedure code 7');
    expect(failureWordsOf({ message: 'late', name: 'TimeoutError' })).toBe('TimeoutError');
  });
});

test.describe('bytesOf and spanOf', () => {
  test('write a count of bytes and a span of time as a person reads them', () => {
    expect(bytesOf(1)).toBe('1 byte');
    expect(bytesOf(1_536)).toBe('1.5 KiB');
    expect(bytesOf(1_048_560)).toBe('1 MiB');
    expect(spanOf(3)).toBe('3 ms');
    expect(spanOf(1_250)).toBe('1.25 s');
  });
});
