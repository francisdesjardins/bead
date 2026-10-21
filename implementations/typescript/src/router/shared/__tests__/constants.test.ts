import { expect, test } from '@playwright/test';
import {
  CALL_ID_RANGES,
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeFlag,
  EnvelopeKind,
  EnvelopeLayout,
  FAILURE_KEYS,
  FailureScope,
  failureTableOf,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
  SESSION_TOKEN_BYTES,
} from '../constants';
import { createSequence } from '../identifiers';

test.describe('ProtocolCode', () => {
  // spec 8.1
  test('puts each code in the block of the stage that raises it', () => {
    const blocks = {
      ENVELOPE_MALFORMED: 0,
      LAYOUT_UNSUPPORTED: 0,
      KIND_UNSUPPORTED: 0,
      ENVELOPE_TOO_LARGE: 0,
      DESTINATION_UNKNOWN: 1,
      DESTINATION_UNREACHABLE: 1,
      SERVICE_UNKNOWN: 1,
      PROCEDURE_UNKNOWN: 1,
      CALL_UNKNOWN: 1,
      SUBSCRIPTION_UNKNOWN: 1,
      SUBSCRIPTION_UNSUPPORTED: 1,
      SESSION_REQUIRED: 2,
      ACCESS_DENIED: 2,
      PAYLOAD_TOO_LARGE: 2,
      CAPACITY_EXCEEDED: 2,
      CREDENTIAL_UNSUPPORTED: 2,
      CHUNK_INVALID: 3,
      CREDIT_EXCEEDED: 3,
      PAYLOAD_UNDECODABLE: 3,
      TRANSFER_STALLED: 3,
      PAYLOAD_INVALID: 3,
      PROCEDURE_FAILED: 4,
      DESTINATION_LOST: 4,
    } as const;

    expect(Object.keys(ProtocolCode)).toEqual(Object.keys(blocks));

    for (const [name, code] of Object.entries(ProtocolCode)) {
      expect(Math.floor(code / 16), name).toBe(blocks[name as keyof typeof blocks]);
    }
  });

  test('holds 23 codes, each once, and leaves out the ones to come', () => {
    const codes = Object.values(ProtocolCode);

    expect(codes).toHaveLength(23);
    expect(new Set(codes).size).toBe(23);

    for (const later of [23, 37, 53, 66]) {
      expect(codes).not.toContain(later);
    }

    expect(Object.isFrozen(ProtocolCode)).toBe(true);
  });
});

test.describe('FAILURE_KEYS', () => {
  test('names each code exactly once', () => {
    expect(
      Object.values(FAILURE_KEYS).toSorted((first, second) => {
        return first - second;
      })
    ).toEqual(
      Object.values(ProtocolCode).toSorted((first, second) => {
        return first - second;
      })
    );
    expect(FAILURE_KEYS.procedureUnknown).toBe(ProtocolCode.PROCEDURE_UNKNOWN);
    expect(FAILURE_KEYS.sessionRequired).toBe(32);
    expect(FAILURE_KEYS.accessDenied).toBe(33);
    expect(FAILURE_KEYS.credentialUnsupported).toBe(36);
  });
});

test.describe('failureTableOf', () => {
  test('gives one frozen entry of its side per key, and its side', () => {
    const table = failureTableOf('client');

    expect(Object.isFrozen(table)).toBe(true);
    expect(table.side).toBe('client');

    for (const [key, code] of Object.entries(FAILURE_KEYS)) {
      const entry = table[key as keyof typeof FAILURE_KEYS];

      expect(entry).toEqual({ code, scope: FailureScope.PROTOCOL, side: 'client' });
      expect(Object.isFrozen(entry)).toBe(true);
    }

    expect(Object.keys(table)).toHaveLength(Object.keys(FAILURE_KEYS).length + 1);
  });

  test('makes two tables that differ by side alone', () => {
    const { side: clientSide, ...client } = CLIENT_FAILURES;
    const { side: serverSide, ...server } = SERVER_FAILURES;

    expect([clientSide, serverSide]).toEqual(['client', 'server']);

    for (const key of Object.keys(FAILURE_KEYS) as (keyof typeof FAILURE_KEYS)[]) {
      expect(client[key].side).toBe('client');
      expect(server[key].side).toBe('server');
      expect({ ...client[key], side: 'server' }).toEqual(server[key]);
    }
  });
});

test.describe('the wire values', () => {
  test('are the layout, the kinds, the flags and the scopes of the envelope', () => {
    expect(EnvelopeLayout).toEqual({ FIRST: 0xa1 });
    expect(EnvelopeKind).toEqual({
      REQUEST: 0x10,
      RESULT: 0x11,
      FAILURE: 0x12,
      NOTIFICATION: 0x13,
      CHUNK: 0x14,
      CREDIT: 0x15,
      CANCEL: 0x16,
    });
    expect(EnvelopeFlag).toEqual({
      DESTINATION: 0x02,
      TRANSFER: 0x04,
      CREDENTIAL: 0x08,
      SUBSCRIPTION: 0x10,
      PACED: 0x20,
      MORE: 0x40,
    });
    expect(CredentialScheme).toEqual({ NONE: 0, OPAQUE: 1, JWT: 2, ELSEWHERE: 3 });
    expect(FailureScope).toEqual({ PROTOCOL: 0, APPLICATION: 1 });
    expect(SESSION_TOKEN_BYTES).toBe(16);

    for (const table of [
      EnvelopeLayout,
      EnvelopeKind,
      EnvelopeFlag,
      CredentialScheme,
      FailureScope,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
  });

  test('give each side a call id range of its own parity', () => {
    expect(CALL_ID_RANGES).toEqual({
      client: { first: 1, last: 0xffffffff, step: 2 },
      server: { first: 2, last: 0xfffffffe, step: 2 },
    });

    for (const range of Object.values(CALL_ID_RANGES)) {
      expect(() => {
        return createSequence(range);
      }).not.toThrow();
    }
  });

  // spec 12.2.2, 12.2.3, 12.2.4, 12.2.5, 12.2.7, 12.2.9 and 12.2.10
  test('leave room for a full header between an envelope and its payload', () => {
    expect(LIMIT_DEFAULTS).toEqual({
      bufferedBytesBudget: 268_435_456,
      chunkBytes: 1_048_576,
      maximumAnsweringCalls: 64,
      maximumChunkRuns: 1_024,
      maximumDetailBytes: 1_024,
      maximumEnvelopeBytes: 16_778_240,
      maximumPayloadBytes: 16_777_216,
      maximumTransfers: 4,
      transferInactivityTimeout: 30_000,
      windowBytes: 4_194_304,
    });
    // a peer that splits nothing sends a whole payload in one envelope, the longest header before it
    expect(
      LIMIT_DEFAULTS.maximumEnvelopeBytes - LIMIT_DEFAULTS.maximumPayloadBytes
    ).toBeGreaterThanOrEqual(1_020);
    // a chunk fits in an envelope, and a window holds two, so a sender waits on no credit it is owed
    expect(LIMIT_DEFAULTS.chunkBytes).toBeLessThanOrEqual(LIMIT_DEFAULTS.maximumEnvelopeBytes);
    expect(LIMIT_DEFAULTS.windowBytes).toBeGreaterThanOrEqual(2 * LIMIT_DEFAULTS.chunkBytes);
    expect(LIMIT_DEFAULTS.maximumPayloadBytes).toBeLessThanOrEqual(
      LIMIT_DEFAULTS.bufferedBytesBudget
    );
  });
});
