import { expect, test } from '@playwright/test';
import { EnvelopeKind, LIMIT_DEFAULTS } from '../../router/shared/constants';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { createFakeFetch, responseOf } from '../../transport/client/__tests__/fake-fetch';
import {
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
} from '../../transport/client/http-transport-client';
import { createHTTPClient, SERVER_FAILURES } from '../http-client';

// helpers

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
};

const echo = { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 };

// definition

test.describe('createHTTPClient', () => {
  test('builds on an HTTP transport with the fetch it is given, one envelope per exchange, and no transfer', async () => {
    // a server that draws the connection, then answers each request with its payload in upper case
    const fake = createFakeFetch((init) => {
      if (init.body === undefined) {
        return responseOf({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
      }

      const request = readEnvelope(bytesOf(init.body as Uint8Array), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      });

      if (request?.kind !== EnvelopeKind.REQUEST) {
        return responseOf({ status: 204 });
      }

      return responseOf({
        body: writeEnvelope(
          {
            header: { callId: request.header.callId, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: encoder.encode(decoder.decode(request.payload).toUpperCase()),
          },
          LIMIT_DEFAULTS.maximumDetailBytes
        ),
        headers: { 'content-type': BEAD_MEDIA_TYPE },
        status: 200,
      });
    });
    const client = createHTTPClient({
      limits: { maximumEnvelopeBytes: 4_096 },
      transport: { fetch: fake.fetch, isListening: false },
    });

    await client.connect({ host: 'localhost', port: 8_080 });

    await expect(client.services.getRequest(echo, { serializer: text })('hi')()).resolves.toBe(
      'HI'
    );
    expect(client.router.limits).toMatchObject({
      chunkBytes: 4_096,
      maximumEnvelopeBytes: 4_096,
      maximumTransfers: 0,
      windowBytes: 8_192,
    });
    expect(
      fake.calls.map(({ init, url }) => {
        return [init.method, url];
      })
    ).toEqual([
      ['POST', 'http://localhost:8080/bead'],
      ['POST', 'http://localhost:8080/bead'],
    ]);
    await client.transport.disconnect();
  });

  test('builds with nothing given: the global fetch, one envelope of the default size, no transfer', () => {
    const client = createHTTPClient();

    expect(client.router.limits).toMatchObject({
      maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
      maximumTransfers: 0,
    });
    expect(client.transport.isUninitialized()).toBe(true);
  });

  test('reads an answer no larger than the envelope its router takes, and closes on one past it', async () => {
    const fake = createFakeFetch();
    const client = createHTTPClient({
      limits: { maximumEnvelopeBytes: 1_024 },
      transport: { fetch: fake.fetch, isListening: false },
    });
    const connecting = client.connect({ host: 'localhost', port: 8_080 });

    fake.calls[0]?.answer({ headers: { [CONNECTION_TOKEN_HEADER]: 'T'.repeat(22) }, status: 201 });
    await connecting;

    const calling = client.services.getRequest(echo, { serializer: text })('hi')();

    await expect
      .poll(() => {
        return fake.calls.length;
      })
      .toBe(2);
    fake.calls[1]?.answer({
      body: new Uint8Array(1_025),
      headers: { 'content-type': BEAD_MEDIA_TYPE },
      status: 200,
    });

    await expect(calling).rejects.toThrow();
    expect(client.transport.isClosed()).toBe(true);
  });
});
