import { expect, test } from '@playwright/test';
import { createWorkerTransportServer } from '../../server/worker-transport-server';
import { createTestClock, delaysOn } from '../../shared/__tests__/fixtures';
import {
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  TimeoutError,
} from '../../shared/errors';
import type { ITransportMessage } from '../../shared/types';
import { dispose } from '../transport-client';
import type { ITransportClientInternal } from '../types';
import {
  CONNECT_DEFAULTS,
  createWorkerTransportClient,
  type IWorkerErrorEventLike,
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
  const errorListeners = new Set<(event: IWorkerErrorEventLike) => void>();
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

/** What the client tells of its end, in order: each error by its class and words, each close. */
const recordEnds = (client: WorkerTransportClient) => {
  const told: unknown[][] = [];

  client.on('error', (error) => {
    told.push(['error', error instanceof GenericError, error.message]);
  });
  client.on('close', (...params) => {
    told.push(['close', ...params]);
  });

  return told;
};

/** The worker's `error`, as HTML fires it on a `Worker`, heard by each listener the client keeps. */
const fireError = (
  errorListeners: ReadonlySet<(event: IWorkerErrorEventLike) => void>,
  event: IWorkerErrorEventLike
) => {
  for (const listener of errorListeners) {
    listener(event);
  }
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

    expect([client.carries('Bearer mF_9.B5f-4.1JqM'), client.isSecure]).toEqual([false, true]);
  });

  test('closes as its server closes it, or as its worker errs, and connects again', async () => {
    await using started = await startWorker();
    const { errorListeners, server, worker } = started;
    const client = createWorkerTransportClient({ worker });

    await client.connect({});

    const closedByServer = nextEvent(client, 'close');

    await server.close('type=WORKER;ip=local;ordinal=1');

    expect(await closedByServer).toEqual([false, false]);
    expect(errorListeners.size).toBe(0);

    // again, then lost with its worker
    await client.reconnect();

    const told = recordEnds(client);

    fireError(errorListeners, {
      colno: 7,
      filename: 'worker.js',
      lineno: 3,
      message: 'Uncaught TypeError: answer is not a function',
    });

    expect(told).toEqual([
      [
        'error',
        true,
        'its worker erred: Uncaught TypeError: answer is not a function (at worker.js:3:7)',
      ],
      ['close', false, false],
    ]);
    expect([client.isClosed(), errorListeners.size]).toEqual([true, 0]);
    await expect
      .poll(() => {
        return [server.clients, started.serverEvents];
      })
      .toEqual([
        [],
        [
          ['close', true, 'type=WORKER;ip=local;ordinal=1'],
          ['close', false, 'type=WORKER;ip=local;ordinal=2'],
        ],
      ]);
  });

  test('tells its worker’s error once, as the connection ends and before its close, in the words the error gives, or saying it gives none', async () => {
    await using started = await startWorker();
    const { errorListeners, worker } = started;
    const client = createWorkerTransportClient({ worker });
    const told = recordEnds(client);
    const events: IWorkerErrorEventLike[] = [
      { filename: 'worker.js', message: 'Uncaught RangeError: too deep' },
      { colno: 0, filename: 'worker.js', lineno: 12, message: 'Uncaught RangeError: too deep' },
      { colno: 5, lineno: 12, message: 'Uncaught RangeError: too deep' },
      { colno: 2, filename: 'worker.js', lineno: 1 },
      { colno: 0, filename: '', lineno: 0, message: '' },
      {},
    ];

    for (const event of events) {
      await client.connect({});

      // heard twice, told once: the first ends the connection
      fireError(errorListeners, event);
      fireError(errorListeners, event);
    }

    const erred = 'its worker erred';

    expect(told).toEqual([
      ['error', true, `${erred}: Uncaught RangeError: too deep (at worker.js)`],
      ['close', false, false],
      ['error', true, `${erred}: Uncaught RangeError: too deep (at worker.js:12)`],
      ['close', false, false],
      ['error', true, `${erred}: Uncaught RangeError: too deep`],
      ['close', false, false],
      ['error', true, `${erred}, saying nothing (at worker.js:1:2)`],
      ['close', false, false],
      ['error', true, `${erred}, saying nothing`],
      ['close', false, false],
      ['error', true, `${erred}, saying nothing`],
      ['close', false, false],
    ]);
  });

  test('tells its server its close as clean as its disconnect says', async () => {
    await using started = await startWorker();
    const { serverEvents, worker } = started;
    const client = createWorkerTransportClient({ worker });
    const told = recordEnds(client);

    await client.connect({});
    await client.disconnect();
    await client.connect({});
    await client.disconnect({ isClean: false });

    expect(told).toEqual([
      ['close', true, false],
      ['close', false, false],
    ]);
    await expect
      .poll(() => {
        return serverEvents;
      })
      .toEqual([
        ['close', true, 'type=WORKER;ip=local;ordinal=1'],
        ['close', false, 'type=WORKER;ip=local;ordinal=2'],
      ]);
  });

  test('fails its connect at once as its worker errs before the connection opens, telling a server that takes the port later', async () => {
    // a clock that never moves: no timeout fails the connect
    const clock = createTestClock(Date.UTC(2026, 0, 1));
    const held: MessagePort[] = [];
    const errorListeners = new Set<(event: IWorkerErrorEventLike) => void>();
    const failing: IWorkerLike = {
      addEventListener: (_, listener) => {
        errorListeners.add(listener);
      },
      postMessage: (_, transfer) => {
        held.push(transfer[0] as MessagePort);
      },
      removeEventListener: (_, listener) => {
        errorListeners.delete(listener);
      },
    };
    const client = createWorkerTransportClient({ clock, worker: failing });
    const told = recordEnds(client);
    const connecting = client.connect({});

    // a script that failed to load: a bare `Event`, which says nothing
    fireError(errorListeners, {});

    await expect(connecting).rejects.toThrow(
      new ConnectError('its worker erred before the connection opened, saying nothing')
    );

    const loading = client.connect({});

    fireError(errorListeners, {
      colno: 1,
      filename: 'worker.js',
      lineno: 1,
      message: 'Uncaught SyntaxError: Unexpected token',
    });

    await expect(loading).rejects.toThrow(
      new ConnectError(
        'its worker erred before the connection opened: Uncaught SyntaxError: Unexpected token (at worker.js:1:1)'
      )
    );
    // no timer left, and nothing told but the rejections
    expect([client.isClosed(), errorListeners.size, delaysOn(clock), told]).toEqual([
      true,
      0,
      [],
      [],
    ]);

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

    for (const port of held) {
      port.close();
    }
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
