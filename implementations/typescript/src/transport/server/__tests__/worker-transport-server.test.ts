import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../shared/errors';
import type { IWorkerMessageEventLike, IWorkerPortLike } from '../../shared/types';
import {
  createWorkerTransportServer,
  START_DEFAULTS,
  TRANSPORT_WORKER,
  WORKER_MESSAGES,
} from '../worker-transport-server';

// helpers

/** What a port heard, in order: bytes as their numbers, anything else as it came. */
const recordOf = (port: MessagePort) => {
  const heard: unknown[] = [];

  port.addEventListener('message', ({ data }: { data: unknown }) => {
    heard.push(data instanceof ArrayBuffer ? [...new Uint8Array(data)] : data);
  });
  port.start();

  return heard;
};

/**
 * A worker's scope, as a port of a `MessageChannel` — the page's end posts to it — a server
 * listening on it, and a way to connect as a page would: a channel whose other end the connect
 * carries, and what the page's end hears.
 */
const startWorker = async () => {
  const worker = new MessageChannel();
  const server = createWorkerTransportServer({ scope: worker.port1 });
  const events: unknown[][] = [];
  const channels: MessageChannel[] = [];

  worker.port1.start();
  server.on('connection', (...[, request, connectionHandle]) => {
    events.push(['connection', request, connectionHandle]);
  });
  server.on('message', (data, connectionHandle) => {
    events.push(['message', [...new Uint8Array(data as ArrayBuffer)], connectionHandle]);
  });
  server.on('close', (...params) => {
    events.push(['close', ...params]);
  });

  const address = await server.start();

  const connect = () => {
    const channel = new MessageChannel();
    const heard = recordOf(channel.port1);

    channels.push(channel);
    worker.port2.postMessage(WORKER_MESSAGES.CONNECT, [channel.port2]);

    return { heard, port: channel.port1 };
  };

  return {
    address,
    connect,
    events,
    server,
    worker,
    [Symbol.asyncDispose]: async () => {
      await server.stop();

      for (const port of [
        worker.port1,
        worker.port2,
        ...channels.map(({ port1 }) => {
          return port1;
        }),
      ]) {
        port.close();
      }
    },
  };
};

const settled = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
};

// definition

test.describe('createWorkerTransportServer', () => {
  test('takes each connect’s port as a connection, says so on it, and hears its envelopes', async () => {
    await using started = await startWorker();
    const { address, connect, events, server } = started;
    const first = connect();
    const second = connect();

    await expect
      .poll(() => {
        return [first.heard, second.heard];
      })
      .toEqual([[WORKER_MESSAGES.OPEN], [WORKER_MESSAGES.OPEN]]);
    first.port.postMessage(Uint8Array.of(1, 2).buffer);
    await expect
      .poll(() => {
        return events;
      })
      .toEqual([
        ['connection', undefined, 'type=WORKER;ip=local;ordinal=1'],
        ['connection', undefined, 'type=WORKER;ip=local;ordinal=2'],
        ['message', [1, 2], 'type=WORKER;ip=local;ordinal=1'],
      ]);

    expect(address).toEqual({ address: 'local', port: 0 });
    expect(START_DEFAULTS).toEqual({ address: 'local', findOpenPort: false, port: 0 });
    expect(server.clients).toEqual([
      {
        address: 'local',
        connectionHandle: 'type=WORKER;ip=local;ordinal=1',
        lastActivityTimestamp: expect.any(Object),
        port: 0,
        type: TRANSPORT_WORKER,
      },
      {
        address: 'local',
        connectionHandle: 'type=WORKER;ip=local;ordinal=2',
        lastActivityTimestamp: undefined,
        port: 0,
        type: TRANSPORT_WORKER,
      },
    ]);
  });

  test('leaves the worker’s other messages to it, and a connect with no port', async () => {
    await using started = await startWorker();
    const { events, server, worker } = started;

    const own = new MessageChannel();

    worker.port2.postMessage('the application’s own');
    worker.port2.postMessage('the application’s own port', [own.port2]);
    worker.port2.postMessage(WORKER_MESSAGES.CONNECT);
    await settled();
    own.port1.close();

    expect([events, server.clients]).toEqual([[], []]);
  });

  test('sends a copy of the bytes it is given, and refuses what is no bytes', async () => {
    await using started = await startWorker();
    const { connect, server } = started;
    const { heard } = connect();

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([WORKER_MESSAGES.OPEN]);

    const connectionHandle =
      server.clients[0]?.connectionHandle ?? 'type=WORKER;ip=local;ordinal=1';
    const envelope = Uint8Array.of(7, 8, 9);

    await server.send(envelope.subarray(1), connectionHandle);

    // the caller's bytes stay its own
    await expect
      .poll(() => {
        return [heard, [...envelope]];
      })
      .toEqual([
        [WORKER_MESSAGES.OPEN, [8, 9]],
        [7, 8, 9],
      ]);
    await expect(server.send('text', connectionHandle)).rejects.toThrow(
      new ProgrammerError('a worker connection carries envelopes, as bytes')
    );
  });

  test('ends a connection its page closes, once, and one it closes itself, telling the page', async () => {
    await using started = await startWorker();
    const { connect, events, server } = started;
    const leaving = connect();
    const staying = connect();
    const closes = () => {
      return events.filter(([name]) => {
        return name !== 'connection';
      });
    };

    await expect
      .poll(() => {
        return [leaving.heard, staying.heard];
      })
      .toEqual([[WORKER_MESSAGES.OPEN], [WORKER_MESSAGES.OPEN]]);
    leaving.port.postMessage(WORKER_MESSAGES.CLOSE);
    leaving.port.postMessage(WORKER_MESSAGES.CLOSE);
    // its port closed: what comes after is heard by nobody
    leaving.port.postMessage(Uint8Array.of(1).buffer);
    await expect.poll(closes).toEqual([['close', true, 'type=WORKER;ip=local;ordinal=1']]);

    await expect(server.close('type=WORKER;ip=local;ordinal=2')).resolves.toBe(true);
    await expect
      .poll(() => {
        return staying.heard;
      })
      .toEqual([WORKER_MESSAGES.OPEN, WORKER_MESSAGES.CLOSE]);

    expect(closes()).toEqual([
      ['close', true, 'type=WORKER;ip=local;ordinal=1'],
      ['close', true, 'type=WORKER;ip=local;ordinal=2'],
    ]);
    expect(server.gauges().counts).toEqual({ connections: 0 });
  });

  test('stops by closing each connection, telling its page, and hears no connect after', async () => {
    const started = await startWorker();
    const { connect, events, server } = started;
    const { heard } = connect();

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([WORKER_MESSAGES.OPEN]);
    await server.stop();
    await expect
      .poll(() => {
        return heard;
      })
      .toEqual([WORKER_MESSAGES.OPEN, WORKER_MESSAGES.CLOSE]);
    // a connect after the stop, given the time a message takes to come through, were it to come
    connect();
    await settled();

    expect(heard).toEqual([WORKER_MESSAGES.OPEN, WORKER_MESSAGES.CLOSE]);
    expect(
      events.map(([name]) => {
        return name;
      })
    ).toEqual(['connection', 'close']);
    await started[Symbol.asyncDispose]();
  });

  test('takes any port-like the scope hands it, as a page would post one: starts it, and transfers what it sends', async () => {
    const listeners: ((event: IWorkerMessageEventLike) => void)[] = [];
    const posted: unknown[] = [];
    const port: IWorkerPortLike = {
      addEventListener: (_, listener) => {
        listeners.push(listener);
      },
      close: () => {
        posted.push('closed');
      },
      postMessage: (message, transfer) => {
        posted.push(transfer === undefined ? message : ['transferred', transfer[0] === message]);
      },
      start: () => {
        posted.push('started');
      },
    };
    const server = createWorkerTransportServer({
      scope: {
        addEventListener: (_, listener) => {
          listeners.push(listener);
        },
        removeEventListener: () => {},
      },
    });

    void server.start();
    listeners[0]?.({ data: WORKER_MESSAGES.CONNECT, ports: [port] });

    // listening at once, before anything was awaited
    expect([posted, server.clients.length]).toEqual([['started', WORKER_MESSAGES.OPEN], 1]);

    await server.send(Uint8Array.of(1), 'type=WORKER;ip=local;ordinal=1');

    expect(posted.at(-1)).toEqual(['transferred', true]);

    // the page's close: its port closed, and nothing it still had queued heard
    listeners[1]?.({ data: WORKER_MESSAGES.CLOSE, ports: [] });
    listeners[1]?.({ data: Uint8Array.of(2).buffer, ports: [] });

    expect([posted.at(-1), server.clients.length]).toEqual(['closed', 0]);
  });
});
