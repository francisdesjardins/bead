import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  FailureError,
  FailureScope,
} from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { IDebugEvent } from '../../src/router/shared/types';
import { callRecordOf, envelopeRecordOf, plainHeaderOf } from '../records';

// helpers

const EVENT: IDebugEvent = Object.freeze({
  direction: 'rx',
  duration: 12,
  options: {
    credential: { scheme: CredentialScheme.JWT, token: 'eyJ.secret.token' },
    signal: new AbortController().signal,
    timeout: Infinity,
  },
  procedureId: 3,
  procedureName: 'read',
  rx: { value: 1 },
  serviceId: 1,
  serviceRevision: 2,
  startedAt: 1_000,
  tx: new Uint8Array([1, 2]),
  type: 'request',
} as IDebugEvent);

// definition

test.describe('callRecordOf', () => {
  test('makes a call’s step plain: its credential by its scheme alone, its payloads previewed, no signal', () => {
    const record = callRecordOf(4, [null, EVENT]);

    expect(record).toEqual({
      credentialScheme: CredentialScheme.JWT,
      direction: 'rx',
      duration: 12,
      error: undefined,
      kind: 'call',
      procedureId: 3,
      procedureName: 'read',
      rx: '{"value": 1}',
      serviceId: 1,
      serviceRevision: 2,
      source: 4,
      startedAt: 1_000,
      timeout: 'never',
      tx: '<2 bytes: 01 02>',
      type: 'request',
    });
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(JSON.parse(JSON.stringify(record))).toEqual(
      Object.fromEntries(
        Object.entries(record).filter(([, value]) => {
          return value !== undefined;
        })
      )
    );
  });

  test('makes a failure plain by its name, its message, its code, its scope and its detail', () => {
    const failure = new FailureError({
      code: 7,
      detail: 'on purpose',
      scope: FailureScope.APPLICATION,
    });

    expect(callRecordOf(1, [failure, EVENT]).error).toMatchObject({
      code: 7,
      detail: 'on purpose',
      name: 'FailureError',
      scope: FailureScope.APPLICATION,
    });
    expect(callRecordOf(1, [new Error('gone'), EVENT]).error).toEqual({
      code: undefined,
      detail: undefined,
      message: 'gone',
      name: 'Error',
      scope: undefined,
    });
    expect(callRecordOf(1, ['a reason', EVENT]).error).toEqual({
      message: 'a reason',
      name: 'string',
    });
  });
});

test.describe('envelopeRecordOf', () => {
  test('makes an envelope plain: its header’s fields, its credential by its scheme', () => {
    expect(
      envelopeRecordOf(
        { at: 5, source: 2 },
        {
          connectionHandle: 'server',
          direction: 'tx',
          header: {
            callId: 9,
            credentialScheme: CredentialScheme.JWT,
            kind: EnvelopeKind.REQUEST,
            procedureId: 3,
            serviceId: 1,
          },
        }
      )
    ).toEqual({
      at: 5,
      connectionHandle: 'server',
      direction: 'tx',
      header: {
        callId: 9,
        credentialScheme: CredentialScheme.JWT,
        kind: EnvelopeKind.REQUEST,
        procedureId: 3,
        serviceId: 1,
      },
      kind: 'envelope',
      source: 2,
    });
  });
});

test.describe('plainHeaderOf', () => {
  test('keeps a credential’s scheme and nothing of its bytes, a bigint as its digits, and leaves out what is neither', () => {
    expect(
      plainHeaderOf({
        callId: 1,
        credential: { scheme: CredentialScheme.OPAQUE, token: new Uint8Array([9]) },
        isLast: true,
        nested: { a: 1 },
        offset: 2n,
      })
    ).toEqual({ callId: 1, credentialScheme: CredentialScheme.OPAQUE, isLast: true, offset: '2' });
  });
});
