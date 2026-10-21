import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  FailureScope,
  ProtocolCode,
} from '../../../src/router/client/router-client';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import { INVALID_DETAILS, specDetailOf } from '../../__tests__/traffic';
import {
  boundsWordsOf,
  bytesOf,
  closingWordsOf,
  envelopeLineOf,
  failureLineOf,
  failureWordsOf,
  originWordsOf,
  spanOf,
  violationFieldOf,
  violationsReadOf,
} from '../words';

// helpers

/** A PAYLOAD_INVALID of the protocol's, its detail the entry of the spec's details named. */
const invalidOf = (name: string): { code: number; detail: string; scope: number } => {
  return {
    code: ProtocolCode.PAYLOAD_INVALID,
    detail: specDetailOf(name),
    scope: FailureScope.PROTOCOL,
  };
};

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

test.describe('violationsReadOf', () => {
  test('reads a PAYLOAD_INVALID’s detail by the package’s reader, a line without its words given those of its rule and bounds', () => {
    const read = violationsReadOf(invalidOf(INVALID_DETAILS.wordless));

    expect(read?.more).toBe(0);
    expect(
      read?.violations.map(({ message }) => {
        return message;
      })
    ).toEqual([
      'must be less than or equal to 10',
      expect.stringMatching(/^does not match regex pattern `\^\(\?:code-000\|/u),
      'must be at least 1 characters',
      'repeated value must contain unique items',
      'must be greater than 0.10000000149011612',
      'must be 00ff',
    ]);
  });

  test('reads a closing line alone, and gives none for another code, another scope or a detail of another form', () => {
    expect(
      violationsReadOf({
        code: ProtocolCode.PAYLOAD_INVALID,
        detail: specDetailOf('a closing line alone gives no violation and its count'),
        scope: FailureScope.PROTOCOL,
      })
    ).toEqual({ more: 4, violations: [] });
    expect(violationsReadOf(invalidOf(INVALID_DETAILS.text))).toBeUndefined();
    expect(
      violationsReadOf({ ...invalidOf(INVALID_DETAILS.whole), scope: FailureScope.APPLICATION })
    ).toBeUndefined();
    expect(
      violationsReadOf({ ...invalidOf(INVALID_DETAILS.whole), code: ProtocolCode.ACCESS_DENIED })
    ).toBeUndefined();
    expect(violationsReadOf({ detail: 'timed out' })).toBeUndefined();
  });
});

test.describe('violationFieldOf, boundsWordsOf and closingWordsOf', () => {
  test('write a violation’s field, a map key’s and the message’s own said so, its bounds as compact JSON', () => {
    const [key] = violationsReadOf(invalidOf(INVALID_DETAILS.key))?.violations ?? [];

    expect(key === undefined ? undefined : violationFieldOf(key)).toBe('labels["a"] (its key)');
    expect(key === undefined ? undefined : boundsWordsOf(key)).toBe('{"min_len":"2"}');
    expect(violationFieldOf({ ruleId: 'message.oneof' })).toBe('(the message)');
    expect(boundsWordsOf({ fieldPath: 'distinct', ruleId: 'repeated.unique' })).toBe('');
  });

  test('say what a closing line counts, that its side stopped, or that the detail was cut', () => {
    const closingOf = (name: string): string | undefined => {
      const read = violationsReadOf(invalidOf(name));

      return read === undefined ? 'unread' : closingWordsOf(read);
    };

    expect(closingOf(INVALID_DETAILS.whole)).toBeUndefined();
    expect(closingOf(INVALID_DETAILS.counted)).toBe('and 3 more');
    expect(closingOf(INVALID_DETAILS.stopped)).toBe('stopped at the first (failFast)');
    expect(closingOf(INVALID_DETAILS.cut)).toBe('cut: what follows is not counted');
  });
});

test.describe('failureLineOf', () => {
  test('sums a PAYLOAD_INVALID up on one line: its count, the first violation’s field and words, and … +N for the more its closing line counts', () => {
    expect(failureLineOf(invalidOf(INVALID_DETAILS.whole))).toBe(
      'PAYLOAD_INVALID · 1 violation · from: must be less than or equal to 10'
    );
    expect(failureLineOf(invalidOf(INVALID_DETAILS.counted))).toBe(
      'PAYLOAD_INVALID · 2 violations · from: must be less than or equal to 10 … +3'
    );
    expect(failureLineOf(invalidOf(INVALID_DETAILS.stopped))).toBe(
      'PAYLOAD_INVALID · 1 violation · from: must be less than or equal to 10'
    );
    expect(failureLineOf(invalidOf(INVALID_DETAILS.cut))).toBe(
      'PAYLOAD_INVALID · 1 violation · from: must be less than or equal to 10'
    );
    expect(failureLineOf(invalidOf(INVALID_DETAILS.wordless))).toBe(
      'PAYLOAD_INVALID · 6 violations · from: must be less than or equal to 10'
    );
    expect(failureLineOf(invalidOf(INVALID_DETAILS.key))).toBe(
      'PAYLOAD_INVALID · 1 violation · labels["a"] (its key): must be at least 2 characters'
    );
    expect(
      failureLineOf(
        invalidOf(
          'a line without its bounds keeps no words where its rule needs them, nor required and message.oneof'
        )
      )
    ).toBe('PAYLOAD_INVALID · 3 violations · from: int32.lte');
    expect(failureLineOf(invalidOf('a closing line alone gives no violation and its count'))).toBe(
      'PAYLOAD_INVALID · 0 violations · +4'
    );
  });

  test('writes another failure, or a detail of another form, as its code and its text, on one line', () => {
    expect(failureLineOf(invalidOf(INVALID_DETAILS.text))).toBe(
      'PAYLOAD_INVALID: the request is invalid'
    );
    expect(
      failureLineOf({
        code: ProtocolCode.ACCESS_DENIED,
        detail: 'writers\nalone',
        scope: FailureScope.PROTOCOL,
      })
    ).toBe('ACCESS_DENIED: writers alone');
    expect(
      failureLineOf({ code: ProtocolCode.ACCESS_DENIED, detail: '', scope: FailureScope.PROTOCOL })
    ).toBe('ACCESS_DENIED');
  });
});
