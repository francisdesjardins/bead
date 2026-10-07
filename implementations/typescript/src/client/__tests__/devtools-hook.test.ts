import { expect, test } from '@playwright/test';
import { createEmitter } from '../../transport/shared/emitter';
import type { ITransportMessage } from '../../transport/shared/types';
import type { IRouterDebugInfo } from '../../router/client/types';
import { EnvelopeKind } from '../../router/shared/constants';
import { bytesOf, readEnvelope, writeEnvelope } from '../../router/shared/envelope';
import { createMetricsRegistry } from '../../router/shared/metrics-registry';
import type { IDebugEvent } from '../../router/shared/types';
import { createClient, SERVER_FAILURES, type IClientTransportLike } from '../client';
import {
  announceToDevtools,
  DEVTOOLS_HOOK_KEY,
  type IDevtoolsHook,
  type IDevtoolsSource,
} from '../devtools-hook';
import { createHTTPClient } from '../http-client';
import { createWorkerClient } from '../worker-client';
import { createWSClient } from '../ws-client';

// helpers

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ECHO = Object.freeze({
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
});

const serializer = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (text: string) => {
    return encoder.encode(text);
  },
};

/** A transport that answers each request with its own payload. */
const createEchoTransport = (): IClientTransportLike => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, wasQuick: boolean];
    message: [message: ITransportMessage];
  }>();

  return {
    off: emitter.off,
    on: emitter.on,
    connect: () => {
      return Promise.resolve();
    },
    disconnect: () => {
      return Promise.resolve();
    },
    reconnect: () => {
      return Promise.resolve();
    },
    send: ({ data }) => {
      const request = readEnvelope(bytesOf(data), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
      });

      if (request?.kind === EnvelopeKind.REQUEST) {
        queueMicrotask(() => {
          emitter.emit('message', {
            data: writeEnvelope({
              header: { callId: request.header.callId, kind: EnvelopeKind.RESULT },
              kind: EnvelopeKind.RESULT,
              payload: request.payload,
            }),
          });
        });
      }

      return Promise.resolve();
    },
    [Symbol.asyncDispose]: () => {
      return Promise.resolve();
    },
  };
};

/** A hook on the page, which keeps what it is handed and counts what withdraws it. */
const defineHook = () => {
  const sources: IDevtoolsSource[] = [];
  const withdrawn: IDevtoolsSource[] = [];
  const hook: IDevtoolsHook = {
    register: (source) => {
      sources.push(source);

      return () => {
        withdrawn.push(source);
      };
    },
  };

  (globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK_KEY] = hook;

  return { sources, withdrawn };
};

/** What one watch heard: the calls' steps and the envelopes. */
const watchOf = (source: IDevtoolsSource | undefined) => {
  const calls: [error: unknown, event: IDebugEvent][] = [];
  const envelopes: IRouterDebugInfo[] = [];
  const stop = source?.watch({
    call: (error, event) => {
      calls.push([error, event]);
    },
    envelope: (info) => {
      envelopes.push(info);
    },
  });

  return { calls, envelopes, stop };
};

test.afterEach(() => {
  Reflect.deleteProperty(globalThis, DEVTOOLS_HOOK_KEY);
});

// definition

test.describe('announceToDevtools', () => {
  test('keys the hook by the package that owns it, in the global symbol registry', () => {
    expect(DEVTOOLS_HOOK_KEY).toBe(Symbol.for('@francisdesjardins/bead/devtools-hook'));
  });

  test('announces a client to the page’s hook, a frozen source of protocol 1 that holds no part of the client', async () => {
    const { sources } = defineHook();
    const client = createClient({ transport: createEchoTransport() });
    const [source] = sources;

    expect(sources).toHaveLength(1);
    expect(source).toMatchObject({ protocol: 1, side: 'client' });
    expect(Object.keys(source ?? {}).toSorted()).toEqual([
      'exposition',
      'protocol',
      'side',
      'watch',
    ]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.values(source ?? {})).not.toContain(client.router);
    await client[Symbol.asyncDispose]();
  });

  test('attaches nothing until it is watched, and a watch’s stop takes its listeners away', async () => {
    const { sources } = defineHook();
    const client = createClient({ transport: createEchoTransport() });
    const echo = client.services.getRequest(ECHO, { serializer });

    expect(client.services.isDebugging).toBe(false);

    const heard = watchOf(sources[0]);

    expect(client.services.isDebugging).toBe(true);
    await expect(echo('hello')()).resolves.toBe('hello');
    expect(
      heard.calls.map(([error, { direction, procedureName }]) => {
        return [error, direction, procedureName];
      })
    ).toEqual([
      [null, 'tx', 'echo'],
      [null, 'rx', 'echo'],
    ]);
    expect(
      heard.envelopes.map(({ direction, header }) => {
        return [direction, header.kind];
      })
    ).toEqual([
      ['tx', EnvelopeKind.REQUEST],
      ['rx', EnvelopeKind.RESULT],
    ]);

    heard.stop?.();

    expect(client.services.isDebugging).toBe(false);
    await expect(echo('again')()).resolves.toBe('again');
    expect([heard.calls.length, heard.envelopes.length]).toEqual([2, 2]);
    await client[Symbol.asyncDispose]();
  });

  test('hears alike in two watches, and one’s stop leaves the other listening', async () => {
    const { sources } = defineHook();
    const client = createClient({ transport: createEchoTransport() });
    const echo = client.services.getRequest(ECHO, { serializer });
    const first = watchOf(sources[0]);
    const second = watchOf(sources[0]);

    await echo('one')();
    first.stop?.();
    await echo('two')();

    expect([first.calls.length, first.envelopes.length]).toEqual([2, 2]);
    expect([second.calls.length, second.envelopes.length]).toEqual([4, 4]);
    expect(client.services.isDebugging).toBe(true);
    second.stop?.();
    expect(client.services.isDebugging).toBe(false);
    await client[Symbol.asyncDispose]();
  });

  test('gives its registry’s exposition, and undefined when the client was given none', async () => {
    const { sources } = defineHook();
    const metricsRegistry = createMetricsRegistry();
    const counted = createClient({ transport: createEchoTransport() }, { metricsRegistry });
    const uncounted = createClient({ transport: createEchoTransport() });

    await counted.services.getRequest(ECHO, { serializer })('hello')();

    expect(sources[0]?.exposition()?.text).toContain(
      'bead_client_call_started_total{service="2",procedure="echo",type="request"} 1'
    );
    expect(sources[1]?.exposition()).toBeUndefined();
    await counted[Symbol.asyncDispose]();
    await uncounted[Symbol.asyncDispose]();
  });

  test('withdraws its source as the client is disposed, once', async () => {
    const { sources, withdrawn } = defineHook();
    const client = createClient({ transport: createEchoTransport() });

    expect(withdrawn).toEqual([]);
    await client[Symbol.asyncDispose]();
    await client[Symbol.asyncDispose]();
    expect(withdrawn).toEqual(sources);
  });

  test('announces nothing with devtools false, through createClient and each client of a transport', async () => {
    const { sources } = defineHook();
    const worker = { postMessage: () => {} };

    for (const client of [
      createClient({ transport: createEchoTransport() }, { devtools: false }),
      createWSClient({ devtools: false }),
      createHTTPClient({ devtools: false }),
      createWorkerClient({ devtools: false, transport: { worker } }),
    ]) {
      await client[Symbol.asyncDispose]();
    }

    expect(sources).toEqual([]);

    for (const client of [
      createWSClient(),
      createHTTPClient(),
      createWorkerClient({ transport: { worker } }),
    ]) {
      await client[Symbol.asyncDispose]();
    }

    expect(sources).toHaveLength(3);
  });

  test('ignores a hook that is none, one whose read throws, one whose register throws, and one whose withdraw throws, the client built all the same', async () => {
    const layers = () => {
      const client = createClient({ transport: createEchoTransport() }, { devtools: false });

      return { metricsRegistry: undefined, router: client.router, services: client.services };
    };

    for (const hook of [undefined, null, 42, {}, { register: 'no' }]) {
      (globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK_KEY] = hook;
      expect(() => {
        announceToDevtools(layers())();
      }).not.toThrow();
    }

    (globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK_KEY] = {
      register: () => {
        throw new Error('a hook that fails');
      },
    };

    const refused = createClient({ transport: createEchoTransport() });

    await expect(refused.services.getRequest(ECHO, { serializer })('still here')()).resolves.toBe(
      'still here'
    );
    await refused[Symbol.asyncDispose]();

    (globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK_KEY] = {
      register: () => {
        return () => {
          throw new Error('a withdraw that fails');
        };
      },
    };

    const kept = createClient({ transport: createEchoTransport() });

    await expect(kept[Symbol.asyncDispose]()).resolves.toBeUndefined();

    // a hook whose register is a getter that throws, then a global that is one
    Object.defineProperty(globalThis, DEVTOOLS_HOOK_KEY, {
      configurable: true,
      value: Object.defineProperty({}, 'register', {
        get: () => {
          throw new Error('a register that fails as it is read');
        },
      }),
    });

    const unread = createClient({ transport: createEchoTransport() });

    await expect(unread.services.getRequest(ECHO, { serializer })('still here')()).resolves.toBe(
      'still here'
    );
    await expect(unread[Symbol.asyncDispose]()).resolves.toBeUndefined();

    Object.defineProperty(globalThis, DEVTOOLS_HOOK_KEY, {
      configurable: true,
      get: () => {
        throw new Error('a hook that fails as it is read');
      },
    });

    const unreadable = createClient({ transport: createEchoTransport() });

    await expect(
      unreadable.services.getRequest(ECHO, { serializer })('still here')()
    ).resolves.toBe('still here');
    await expect(unreadable[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
