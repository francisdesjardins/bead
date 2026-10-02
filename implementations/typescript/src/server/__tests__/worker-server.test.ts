import { expect, test } from '@playwright/test';
import { createWorkerClient } from '../../client/worker-client';
import type { INotifyOptions, IProcedure } from '../../router/shared/types';
import { createWorkerServer, ProtocolCode, type PacingLimitsOptions } from '../worker-server';
import { expectAtRest } from './fixtures';

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
const bytes = {
  decode: (payload: Uint8Array) => {
    return payload;
  },
  encode: (payload: Uint8Array) => {
    return payload;
  },
};

const procedureOf = (procedureId: number, procedureName: string): IProcedure => {
  return { procedureId, procedureName, serviceId: 1, serviceRevision: 1 };
};

const echo = procedureOf(1, 'echo');
const news = procedureOf(2, 'news');
const ping = procedureOf(3, 'ping');
const upload = procedureOf(4, 'upload');

// envelopes of 1 KiB, so 8 KiB goes as a transfer; 64 KiB at most
const limits = {
  chunkBytes: 1_024,
  maximumEnvelopeBytes: 1_024,
  maximumPayloadBytes: 65_536,
  windowBytes: 4_096,
};

/**
 * A server in a worker's scope — a port of a `MessageChannel` — and a client to it through the other
 * end, as a page holds its worker; `await using` takes them apart once the server keeps nothing.
 */
const connectWorker = async (pacing?: PacingLimitsOptions) => {
  const scope = new MessageChannel();
  const server = createWorkerServer({ limits, pacing, transport: { scope: scope.port1 } });
  const client = createWorkerClient({
    limits,
    transport: {
      worker: {
        postMessage: (message, transfer) => {
          scope.port2.postMessage(message, transfer as Transferable[]);
        },
      },
    },
  });
  const newsChanges = server.services.getNotificationResolver(news, {
    serializer: { ...text, encodeNotification: text.encode },
  })((_request, response) => {
    response.registerNotification();

    return response('subscribed');
  });

  scope.port1.start();
  server.services.getRequestResolver(echo, { serializer: text })((request, response) => {
    return response(request.payload.toUpperCase());
  });
  server.services.getRequestResolver(upload, { serializer: bytes })((request, response) => {
    return response(request.payload.slice().reverse());
  });
  await server.transport.start();
  await client.connect({});

  return {
    client,
    notify: (value: string, notifyOptions?: Pick<INotifyOptions, 'key'>) => {
      return newsChanges.notify(value, notifyOptions);
    },
    server,
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await expectAtRest(server);
      await server[Symbol.asyncDispose]();
      scope.port1.close();
      scope.port2.close();
    },
  };
};

// definition

test.describe('a server in a worker, and a client to it', () => {
  test('answer a call, notify a subscription, and command the client, with no socket at all', async () => {
    await using connected = await connectWorker();
    const { client, server } = connected;
    const heard: string[] = [];

    await expect(client.services.getRequest(echo, { serializer: text })('hi')()).resolves.toBe(
      'HI'
    );

    await using subscribed = await client.services.getNotification(news, {
      serializer: { ...text, decodeNotification: text.decode },
    })('subscribe', (notification) => {
      heard.push(notification);
    })();

    expect(subscribed.unregister).toBeInstanceOf(Function);
    await connected.notify('first');
    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['first']);

    client.services.getRequestResolver(ping, { serializer: text })((request, response) => {
      return response(`${request.payload} pong`);
    });

    await expect(
      server.services.getCommand(ping, { serializer: text })('ping')({
        connectionHandle: 'type=WORKER;ip=local;ordinal=1',
        timeout: 1_000,
      })
    ).resolves.toBe('ping pong');
  });

  test('pace a subscription at its callback: forty-five changes during one fetch come as two', async () => {
    await using connected = await connectWorker();
    const { client, server } = connected;
    const heard: string[] = [];
    const { promise: fetched, resolve: fetch } = Promise.withResolvers<void>();

    await using _subscribed = await client.services.getNotification(news, {
      serializer: { ...text, decodeNotification: text.decode },
      window: 1,
    })('subscribe', async (notification) => {
      heard.push(notification);
      await fetched;
    })();

    for (let change = 1; change <= 45; change += 1) {
      await connected.notify(`article 7, change ${String(change)}`, { key: 'article 7' });
    }

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['article 7, change 1']);
    expect(server.gauges().router.counts).toMatchObject({
      pausedSubscriptions: 1,
      queuedNotifications: 1,
    });

    fetch();

    await expect
      .poll(() => {
        return heard;
      })
      .toEqual(['article 7, change 1', 'article 7, change 45']);
    await expect
      .poll(() => {
        return server.gauges().router.counts['pausedSubscriptions'];
      })
      .toBe(0);
  });

  test('end a paced subscription whose queue goes past the bounds its server was given, and say why', async () => {
    await using connected = await connectWorker({ maximumQueuedNotifications: 1 });
    const { client } = connected;
    const heard: string[] = [];
    const dropped: unknown[] = [];
    const { promise: fetched, resolve: fetch } = Promise.withResolvers<void>();

    client.services.on('dropped', (procedure, failure) => {
      dropped.push([procedure.procedureName, failure?.code]);
    });

    await using _subscribed = await client.services.getNotification(news, {
      serializer: { ...text, decodeNotification: text.decode },
      window: 1,
    })('subscribe', async (notification) => {
      heard.push(notification);
      await fetched;
    })();

    // the first goes, one waits, and the one past it ends the subscription
    for (const event of ['a', 'b', 'c']) {
      await connected.notify(event);
    }

    await expect
      .poll(() => {
        return dropped;
      })
      .toEqual([['news', ProtocolCode.CAPACITY_EXCEEDED]]);
    fetch();

    expect(heard).toEqual(['a']);
  });

  test('carry a payload past one envelope as a transfer, both ways, and refuse one past its limit', async () => {
    await using connected = await connectWorker();
    const payload = new Uint8Array(8_192).map((_, index) => {
      return index % 251;
    });
    const uploading = connected.client.services.getRequest(upload, { serializer: bytes });

    expect([...(await uploading(payload)())]).toEqual([...payload].reverse());
    await expect(uploading(new Uint8Array(65_537))()).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_TOO_LARGE,
    });
  });
});
