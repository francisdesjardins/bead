import { expect, test } from '@playwright/test';
import {
  CredentialScheme,
  FailureScope,
  ProtocolCode,
} from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import { writeEnvelope } from '../../src/router/shared/envelope';
import { bytesOfContent, isBeadType, readBody } from '../wire';

// helpers

const encoder = new TextEncoder();

const REQUEST = writeEnvelope({
  header: {
    callId: 1,
    credential: { scheme: CredentialScheme.JWT, token: 'eyJ.secret.token' },
    kind: EnvelopeKind.REQUEST,
    procedureId: 3,
    serviceId: 1,
  },
  kind: EnvelopeKind.REQUEST,
  payload: encoder.encode('hello'),
});

const RESULT = writeEnvelope({
  header: { callId: 1, kind: EnvelopeKind.RESULT },
  kind: EnvelopeKind.RESULT,
  payload: encoder.encode('hi'),
});

const FAILURE = writeEnvelope({
  failure: { code: ProtocolCode.ACCESS_DENIED, detail: 'not you', scope: FailureScope.PROTOCOL },
  header: { callId: 3, kind: EnvelopeKind.FAILURE },
  kind: EnvelopeKind.FAILURE,
});

/** A batch, as an answer or a listen carries one: each envelope after its length on 4 bytes. */
const batchOf = (...envelopes: Uint8Array[]): Uint8Array => {
  const batch = new Uint8Array(
    envelopes.reduce((total, envelope) => {
      return total + 4 + envelope.length;
    }, 0)
  );
  const view = new DataView(batch.buffer);
  let offset = 0;

  for (const envelope of envelopes) {
    view.setUint32(offset, envelope.length);
    batch.set(envelope, offset + 4);
    offset += 4 + envelope.length;
  }

  return batch;
};

// definition

test.describe('isBeadType', () => {
  test('knows Bead’s media type, its parameters and its case aside', () => {
    expect(isBeadType('application/prs.bead')).toBe(true);
    expect(isBeadType('Application/PRS.Bead; charset=binary')).toBe(true);
    expect(isBeadType('application/json')).toBe(false);
    expect(isBeadType(undefined)).toBe(false);
  });
});

test.describe('bytesOfContent', () => {
  test('reads base64, and a text whose every character is a byte, and gives none for one that is not', () => {
    expect(bytesOfContent({ encoding: 'base64', text: btoa('\u0000ÿ') })).toEqual(
      new Uint8Array([0, 255])
    );
    expect(bytesOfContent({ text: '\u0001þ' })).toEqual(new Uint8Array([1, 254]));
    expect(bytesOfContent({ text: '€' })).toBeUndefined();
  });
});

test.describe('readBody', () => {
  test('reads a POST’s body as one envelope, its credential by its scheme alone', () => {
    const reading = readBody(REQUEST, 'envelope');

    expect(reading).toEqual({
      envelopes: [
        {
          failure: undefined,
          header: expect.objectContaining({
            callId: 1,
            credentialScheme: CredentialScheme.JWT,
            kind: EnvelopeKind.REQUEST,
            procedureId: 3,
          }) as unknown,
          payloadBytes: 5,
        },
      ],
    });
    expect(JSON.stringify(reading)).not.toContain('secret');
  });

  test('reads a batch, each envelope after its length, a failure by its code, scope and detail', () => {
    expect(readBody(batchOf(RESULT, FAILURE), 'batch')).toEqual({
      envelopes: [
        { failure: undefined, header: { callId: 1, kind: EnvelopeKind.RESULT }, payloadBytes: 2 },
        {
          failure: {
            code: ProtocolCode.ACCESS_DENIED,
            detail: 'not you',
            scope: FailureScope.PROTOCOL,
          },
          header: expect.objectContaining({ callId: 3, kind: EnvelopeKind.FAILURE }) as unknown,
          payloadBytes: undefined,
        },
      ],
    });
  });

  test('says where a body stops reading, and keeps the envelopes before it', () => {
    const batch = batchOf(RESULT);
    const cut = readBody(batch.subarray(0, batch.length - 1), 'batch');

    expect(cut.envelopes).toEqual([]);
    expect(cut.problem).toMatch(/^a length of \d+, with \d+ bytes left$/);
    expect(readBody(new Uint8Array([...batch, 0, 0]), 'batch')).toMatchObject({
      envelopes: [{ payloadBytes: 2 }],
      problem: '2 bytes left, short of a length',
    });
    expect(readBody(new Uint8Array([0xff, 1, 2]), 'envelope').problem).toBeDefined();
  });
});
