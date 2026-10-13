import { expect, test } from '@playwright/test';
import { FailureScope, ProtocolCode } from '../../../src/router/client/router-client';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import { writeEnvelope } from '../../../src/router/shared/envelope';
import { readBody } from '../../wire';
import { codeOfCall, conversationOf } from '../snippets';
import { trafficCall } from './book';

// helpers

const encoder = new TextEncoder();

// definition

test.describe('codeOfCall', () => {
  test('writes a call made as a snippet that makes it again by the page’s own service manager, its payload whole', () => {
    const code = codeOfCall(trafficCall('relayed')) ?? '';

    expect(code).toContain(
      'await services.getRequest({ procedureId: 3, procedureName: "increment", serviceId: 1, serviceRevision: 1 }, { serializer })(1)({ destinationId: 7 });'
    );
    expect(codeOfCall(trafficCall('counter'))).toContain('services.getNotification(');
    expect(codeOfCall(trafficCall('whoami'))).toContain('it presented a credential, JWT');
  });

  test('writes none for a call the server made', () => {
    expect(codeOfCall(trafficCall('command'))).toBeUndefined();
  });
});

test.describe('conversationOf', () => {
  test('writes what an exchange sent as a conversation sends it, and what came back as it expects it', () => {
    const request = writeEnvelope({
      header: { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 1 },
      kind: EnvelopeKind.REQUEST,
      payload: encoder.encode('{"a":1}'),
    });
    const failure = writeEnvelope({
      failure: {
        code: ProtocolCode.ACCESS_DENIED,
        detail: 'not you',
        scope: FailureScope.PROTOCOL,
      },
      header: { callId: 1, kind: EnvelopeKind.FAILURE },
      kind: EnvelopeKind.FAILURE,
    });
    const conversation = JSON.parse(
      conversationOf({
        request: readBody(request, 'envelope').envelopes,
        response: readBody(failure, 'envelope').envelopes,
      })
    ) as { steps: unknown[] };

    expect(conversation.steps).toEqual([
      // as `spec/conversations.json` writes its first
      { send: 'A1 10 00 03  00 00 00 01  00 01 00 01 | 7B 22 61 22 3A 31 7D' },
      {
        expect: {
          callId: 1,
          failure: {
            code: ProtocolCode.ACCESS_DENIED,
            detail: 'not you',
            relays: 0,
            scope: FailureScope.PROTOCOL,
          },
          kind: EnvelopeKind.FAILURE,
        },
      },
    ]);
  });
});
