import { expect, test } from '@playwright/test';
import { createEmitter } from '../../transport/shared/emitter';
import type { Data } from '../../transport/shared/types';
import { createRouterClient } from '../../router/client/router-client';
import { EnvelopeKind } from '../../router/shared/constants';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { createServiceManager } from '../../router/shared/service-manager';
import {
  createClient,
  DisconnectError,
  SERVER_FAILURES,
  type IClientTransportLike,
} from '../client';

// helpers

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const serializer = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (text: string) => {
    return encoder.encode(text);
  },
};

/** The echo transport's own options, which the client reads back from it. */
interface IEchoTransport extends IClientTransportLike {
  connect(options: { host: string }): Promise<void>;
  reconnect(options?: { maxAttempts?: number; signal?: AbortSignal | undefined }): Promise<void>;
}

/** A transport that records its calls, and answers each request with its own payload. */
const createEchoTransport = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, wasQuick: boolean];
    message: [data: Data];
  }>();
  const calls: unknown[][] = [];

  const transport: IEchoTransport = {
    off: emitter.off,
    on: emitter.on,
    connect: (options) => {
      calls.push(['connect', options]);

      return Promise.resolve();
    },
    disconnect: (options) => {
      calls.push(['disconnect', options]);

      return Promise.resolve();
    },
    reconnect: (options) => {
      calls.push(['reconnect', options]);

      // a reconnection that only its signal ends, as one still attempting
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const reason: unknown = options.signal?.reason;

          reject(reason instanceof Error ? reason : new Error('aborted'));
        });
        queueMicrotask(() => {
          if (options?.maxAttempts !== undefined) {
            reject(new Error('given up'));
          }
        });
      });
    },
    send: (data) => {
      const request = readEnvelope(bytesOf(data), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
      });

      // a result on the request's own call id, with its own payload
      if (request?.kind === EnvelopeKind.REQUEST) {
        queueMicrotask(() => {
          emitter.emit(
            'message',
            writeEnvelope({
              header: { callId: request.header.callId, kind: EnvelopeKind.RESULT },
              kind: EnvelopeKind.RESULT,
              payload: request.payload,
            })
          );
        });
      }

      return Promise.resolve();
    },
    [Symbol.asyncDispose]: () => {
      calls.push(['asyncDispose']);
      emitter.emit('message', new Uint8Array(0));

      return Promise.resolve();
    },
  };

  return { calls, transport };
};

// definition

test.describe('createClient', () => {
  test('connects, disconnects and reconnects through its transport, with the options given', async () => {
    const { calls, transport } = createEchoTransport();
    const client = createClient({ transport });

    await client.connect({ host: 'h' });
    await client.disconnect({ isClean: false });
    await expect(client.reconnect({ maxAttempts: 2 })).rejects.toThrow('given up');

    expect(calls).toEqual([
      ['connect', { host: 'h' }],
      ['disconnect', { isClean: false }],
      ['reconnect', { maxAttempts: 2, signal: expect.any(AbortSignal) }],
    ]);
    expect(client.transport).toBe(transport);
    expect(client.router.transport).toBe(transport);
  });

  test('builds its router on its transport and its services on its router', async () => {
    const { transport } = createEchoTransport();
    const client = createClient({ transport });
    const echo = client.services.getRequest(
      { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 },
      { serializer }
    );

    await expect(echo('hello')()).resolves.toBe('hello');
  });

  test('"await using" takes the layers apart in reverse: the router lets go, then the transport closes', async () => {
    const { calls, transport } = createEchoTransport();
    const errors: Error[] = [];

    {
      await using client = createClient({ transport });

      client.router.on('error', (error) => {
        errors.push(error);
      });
    }

    // the transport's dispose sends a message nobody may hear any more
    expect(calls).toEqual([['asyncDispose']]);
    expect(errors).toEqual([]);
  });

  test('builds each layer with the factory given for it', async () => {
    const { transport } = createEchoTransport();
    const built: string[] = [];

    const given: unknown[] = [];
    const client = createClient({
      router: (below) => {
        built.push('router');
        given.push(below);

        return createRouterClient(below);
      },
      services: (below) => {
        built.push('services');
        given.push(below);

        return createServiceManager(below);
      },
      transport,
    });

    expect(built).toEqual(['router', 'services']);
    // each built on the very layer the client exposes under it
    expect(given[0]).toBe(transport);
    expect(given[1]).toBe(client.router);

    const echo = client.services.getRequest(
      { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 },
      { serializer }
    );

    await expect(echo('layered')()).resolves.toBe('layered');
  });

  test('builds its router with the limits given, its own or the factory given for it', async () => {
    const { transport } = createEchoTransport();
    const limits = { maximumPayloadBytes: 8 };
    const given: unknown[] = [];
    const limited = createClient({ transport }, { limits });
    const layered = createClient(
      {
        router: (below, options) => {
          given.push(options);

          return createRouterClient(below, options);
        },
        transport,
      },
      { limits }
    );
    const echoOf = (client: typeof limited) => {
      return client.services.getRequest(
        { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 3 },
        { serializer }
      );
    };

    expect(given).toEqual([{ limits }]);
    await expect(echoOf(limited)('much too long')()).rejects.toMatchObject({
      detail: 'a payload is 8 bytes at most, not 13',
    });
    await expect(echoOf(layered)('much too long')()).rejects.toMatchObject({
      detail: 'a payload is 8 bytes at most, not 13',
    });
  });

  test('a dispose aborts a reconnection under way, and a signal given still aborts it too', async () => {
    const { transport } = createEchoTransport();
    const client = createClient({ transport });
    const controller = new AbortController();

    const byDispose = client.reconnect();
    const bySignal = createClient({ transport }).reconnect({ signal: controller.signal });

    await client[Symbol.asyncDispose]();
    controller.abort(new Error('given signal'));

    await expect(byDispose).rejects.toBeInstanceOf(DisconnectError);
    await expect(bySignal).rejects.toThrow('given signal');
  });
});
