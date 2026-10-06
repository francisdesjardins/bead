import { expect, test } from '@playwright/test';
import { createWorkerTransportServer } from '../../server/worker-transport-server';
import { ConnectError, ProgrammerError, ReadyStateError, TimeoutError } from '../../shared/errors';
import type { ITransportMessage } from '../../shared/types';
import { dispose } from '../transport-client';
import type { ITransportClientInternal } from '../types';
import {
  CONNECT_DEFAULTS,
  createWorkerTransportClient,
  type IWorkerLike,
  WORKER_MESSAGES,
  type WorkerTransportClient,
} from '../worker-transport-client';

// helpers

/**
 * A server in a worker's scope — a port of a `MessageChannel` — and the worker as a page holds it,
 * whose `error` listeners the test fires by hand.
 */
const startWorker = async () => {
  const scope = new MessageChannel();
  const server = createWorkerTransportServer({ scope: scope.port1 });
  const errorListeners = new Set<() => void>();
  const serverEvents: unknown[][] = [];
  const worker: IWorkerLike = {
    addEventListener: (_, listener) => {
      errorListeners.add(listener);
    },
    postMessage: (message, transfer) => {
      scope.port2.postMessage(message, transfer as Transferable[]);
    },
    removeEventListener: (_, listener) => {
      errorListeners.delete(listener);
    },
  };

  scope.port1.start();
  server.on('message', ({ credential, data }, connectionHandle) => {
    serverEvents.push([
      'message',
      [...new Uint8Array(data as ArrayBuffer)],
      credential,
      connectionHandle,
    ]);
  });
  server.on('close', (...params) => {
    serverEvents.push(['close', ...params]);
  });
  await server.start();

  return {
    errorListeners,
    server,
    serverEvents,
    worker,
    [Symbol.asyncDispose]: async () => {
      await server.stop();
      scope.port1.close();
      scope.port2.close();
    },
  };
};

const nextEvent = (client: WorkerTransportClient, event: 'close' | 'message') => {
  return new Promise<unknown[]>((resolve) => {
    client.once(event, (...params) => {
      resolve(params);
    });
  });
};

// definition

test.describe('createWorkerTransportClient', () => {
  test('connects through a channel of its own, carries bytes both ways, and disconnects, the server told', async () => {
    await using started = await startWorker();
    const { server, serverEvents, worker } = started;
    const client = createWorkerTransportClient({ worker });

    await client.connect({});

    const connectionHandle = 'type=WORKER;ip=local;ordinal=1';
    const hearing = nextEvent(client, 'message');

    // a worker carries no credential, either way
    await client.send({ credential: 'Bearer mF_9.B5f-4.1JqM', data: Uint8Array.of(1, 2) });
    await server.send(
      { credential: 'Bearer mF_9.B5f-4.1JqM', data: Uint8Array.of(3, 4) },
      connectionHandle
    );

    const [{ credential, data }] = (await hearing) as [ITransportMessage];

    expect([...new Uint8Array(data as ArrayBuffer), credential]).toEqual([3, 4, undefined]);
    expect(client.socket).not.toBeNull();

    const closed = nextEvent(client, 'close');

    await client.disconnect({ isClean: true });

    expect(await closed).toEqual([true, false]);
    expect(started.errorListeners.size).toBe(0);
    await expect
      .poll(() => {
        return serverEvents;
      })
      .toEqual([
        ['message', [1, 2], undefined, connectionHandle],
        ['close', true, connectionHandle],
      ]);
    expect([client.isClosed(), client.socket]).toEqual([true, null]);
    expect(CONNECT_DEFAULTS.timeout).toBe(10_000);
  });

  test('says it carries no credential beside an envelope, and is secure, never leaving the machine, before any connect', async () => {
    await using started = await startWorker();
    const client = createWorkerTransportClient({ worker: started.worker });

    expect([client.carriesCredential, client.isSecure]).toEqual([false, true]);
  });

  test('closes as its server closes it, or as its worker errs, and connects again', async () => {
    await using started = await startWorker();
    const { errorListeners, server, worker } = started;
    const client = createWorkerTransportClient({ worker });

    await client.connect({});

    const closedByServer = nextEvent(client, 'close');

    await server.close('type=WORKER;ip=local;ordinal=1');

    expect(await closedByServer).toEqual([true, false]);
    expect(errorListeners.size).toBe(0);

    // again, then lost with its worker
    await client.reconnect();

    const lost = nextEvent(client, 'close');

    for (const listener of errorListeners) {
      listener();
    }

    expect(await lost).toEqual([false, false]);
    expect([client.isClosed(), errorListeners.size]).toEqual([true, 0]);
    await expect
      .poll(() => {
        return server.clients;
      })
      .toEqual([]);
  });

  test('gives up on a worker that never answers, telling a server that takes the port later', async () => {
    const held: MessagePort[] = [];
    const silent: IWorkerLike = {
      postMessage: (_, transfer) => {
        held.push(transfer[0] as MessagePort);
      },
    };
    const client = createWorkerTransportClient({ worker: silent });

    await expect(client.connect({ timeout: 30 })).rejects.toBeInstanceOf(TimeoutError);
    expect(client.isClosed()).toBe(true);

    const heard: unknown[] = [];
    const [late] = held;

    late?.addEventListener('message', ({ data }) => {
      heard.push(data);
    });
    late?.start();
    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([WORKER_MESSAGES.CLOSE]);
    late?.close();

    // a dispose while it connects rejects the connect
    const disposed = client.connect({});

    (client as ITransportClientInternal<object, never>)[dispose]();

    await expect(disposed).rejects.toThrow(new ConnectError('disposed while connecting'));

    for (const port of held) {
      port.close();
    }
  });

  test('hears nothing before its connection opens — no envelope, no close — over a worker with no error to hear', async () => {
    const scope = new MessageChannel();
    const worker: IWorkerLike = {
      postMessage: (message, transfer) => {
        scope.port2.postMessage(message, transfer as Transferable[]);
      },
    };
    const heard: unknown[] = [];

    // a scope that sends bytes, and a close, before it opens the connection: neither names it yet
    scope.port1.addEventListener('message', ({ ports: [port] }) => {
      port?.postMessage(Uint8Array.of(1).buffer);
      port?.postMessage(WORKER_MESSAGES.CLOSE);
      port?.postMessage(WORKER_MESSAGES.OPEN);
      port?.postMessage(Uint8Array.of(2).buffer);
    });
    scope.port1.start();

    const client = createWorkerTransportClient({ worker });

    client.on('message', ({ data }) => {
      heard.push([...new Uint8Array(data as ArrayBuffer)]);
    });
    client.on('close', () => {
      heard.push('close');
    });
    await client.connect({});

    // the port keeps its order: once the last bytes are heard, all before them were judged
    await expect
      .poll(() => {
        return [heard, client.isOpen()];
      })
      .toEqual([[[2]], true]);

    // dropped: its server is told, as a port does not tell its close
    (client as ITransportClientInternal<object, never>)[dispose]();
    scope.port1.close();
    scope.port2.close();
  });

  test('refuses to send or disconnect before it opens, and to send what is no bytes', async () => {
    await using started = await startWorker();
    const client = createWorkerTransportClient({ worker: started.worker });

    await expect(client.send({ data: Uint8Array.of(1) })).rejects.toBeInstanceOf(ReadyStateError);
    await expect(client.disconnect()).rejects.toBeInstanceOf(ReadyStateError);

    await client.connect({});

    await expect(client.send({ data: 'text' })).rejects.toThrow(
      new ProgrammerError('a worker connection carries envelopes, as bytes')
    );

    // dropped while open: the server hears its close all the same
    (client as ITransportClientInternal<object, never>)[dispose]();

    await expect
      .poll(() => {
        return started.serverEvents;
      })
      .toEqual([['close', true, 'type=WORKER;ip=local;ordinal=1']]);
  });
});
