import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  FailureError,
  FailureScope,
  ProtocolCode,
} from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { IDebugEvent } from '../../src/router/shared/types';
import { callRecordOf, envelopeRecordOf, plainHeaderOf } from '../records';

// helpers

const EVENT: IDebugEvent = Object.freeze({
  callId: 9,
  connectionHandle: 'server',
  direction: 'rx',
  duration: 12,
  options: {
    closeOnTimeout: false,
    credential: { scheme: CredentialScheme.JWT, token: 'eyJ.secret.token' },
    destinationId: 7,
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
  test('makes a call’s step plain: its call, its options, its credential by its scheme alone, its payloads previewed as text and as a tree, no signal', () => {
    const record = callRecordOf(4, [null, EVENT]);

    expect(record).toEqual({
      callId: 9,
      closeOnTimeout: false,
      connectionHandle: 'server',
      credentialScheme: CredentialScheme.JWT,
      destinationId: 7,
      direction: 'rx',
      duration: 12,
      error: undefined,
      kind: 'call',
      procedureId: 3,
      procedureName: 'read',
      rx: '{"value": 1}',
      rxTree: { entries: [['value', 1]], type: 'object' },
      serviceId: 1,
      serviceRevision: 2,
      source: 4,
      startedAt: 1_000,
      timeout: 'never',
      tx: '<2 bytes: 01 02>',
      txTree: { hex: '01 02', length: 2, type: 'bytes' },
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

  test('keeps no call, and no connection, for a step that names none', () => {
    const record = callRecordOf(1, [
      null,
      { ...EVENT, callId: undefined, connectionHandle: undefined, type: 'notification' },
    ]);

    expect(record).toMatchObject({ callId: undefined, connectionHandle: undefined });
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty('callId');
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty('connectionHandle');
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
      callId: undefined,
      code: undefined,
      destinationId: undefined,
      detail: undefined,
      message: 'gone',
      name: 'Error',
      origin: undefined,
      relays: undefined,
      scope: undefined,
      side: undefined,
    });
    expect(callRecordOf(1, ['a reason', EVENT]).error).toEqual({
      message: 'a reason',
      name: 'string',
    });
  });
});

test.describe('callRecordOf, a failure whole', () => {
  test('keeps where a failure was raised, the relays it crossed, its destination and the call its envelope named', () => {
    const failure = new FailureError(
      {
        code: ProtocolCode.ACCESS_DENIED,
        detail: 'writers alone',
        origin: 'relayed',
        relays: 1,
        scope: FailureScope.PROTOCOL,
      },
      { destinationId: 7, header: { callId: 13, kind: EnvelopeKind.FAILURE } }
    );
    const { error } = callRecordOf(1, [failure, EVENT]);

    expect(error).toMatchObject({
      callId: 13,
      code: ProtocolCode.ACCESS_DENIED,
      destinationId: 7,
      detail: 'writers alone',
      origin: 'relayed',
      relays: 1,
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual(
      Object.fromEntries(
        Object.entries(error ?? {}).filter(([, value]) => {
          return value !== undefined;
        })
      )
    );
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
