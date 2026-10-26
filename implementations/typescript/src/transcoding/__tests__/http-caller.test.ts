import { expect, test } from '@playwright/test';
import { FailureScope, ProtocolCode } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { ProgrammerError } from '../../transport/shared/errors';
import { createHTTPCaller, type HTTPEvent } from '../http-caller';
import { HTTP_ROUTES, TranscodingHttpClient } from './generated/bead_http';
import { GOOD_CREDENTIAL, SESSION, startTranscoding } from './transcoding-service';

const urlOf = (port: number): string => {
  return `http://127.0.0.1:${String(port)}`;
};

const stubOf = (
  body: string,
  options: { status?: number; type?: string; fragmented?: boolean; cancelled?: () => void } = {}
): typeof fetch => {
  return (_url, init) => {
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('omit');
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (options.fragmented === true) {
          for (const octet of bytes) {
            controller.enqueue(Uint8Array.of(octet));
          }
        } else {
          controller.enqueue(bytes);
        }
        // ! left open so ending an iteration proves it cancels its reader
      },
      cancel: () => {
        options.cancelled?.();
      },
    });

    return Promise.resolve(
      new Response(stream, {
        status: options.status ?? 200,
        headers: { 'content-type': options.type ?? 'text/event-stream' },
      })
    );
  };
};

test('calls default routes with protobuf JSON and every native encoding through its gateway', async () => {
  await using fixture = await startTranscoding();
  const client = new TranscodingHttpClient(urlOf(fixture.port));

  expect(await client.getBook({ name: 'shelves/a/books/b', revision: 7n })).toMatchObject({
    name: 'shelves/a/books/b',
    pages: 7n,
    title: 'A tale',
  });
  expect(await client.text('Ada\r\nJosé')).toBe('Ada\r\nJosé');
  expect(await client.raw(Uint8Array.of(0, 127, 255))).toEqual(Uint8Array.of(0, 127, 255));
  expect(await client.json({ z: [true, null], a: 'José' })).toEqual({
    a: 'José',
    z: [true, null],
  });
});

test('reads application and protocol problems with their code scope and detail', async () => {
  await using fixture = await startTranscoding();
  const client = new TranscodingHttpClient(urlOf(fixture.port));

  await expect(client.fail({ detail: 'by choice' })).rejects.toMatchObject({
    code: 1,
    scope: FailureScope.APPLICATION,
    detail: 'by choice',
    origin: 'peer',
  });
  await expect(client.whoAmI({})).rejects.toMatchObject({
    code: ProtocolCode.SESSION_REQUIRED,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
  });
});

test('presents a default authorization or its override and omits it on request', async () => {
  await using fixture = await startTranscoding();
  const client = new TranscodingHttpClient(urlOf(fixture.port), {
    authorization: 'Bearer wrong',
  });

  expect(await client.whoAmI({}, { authorization: GOOD_CREDENTIAL })).toMatchObject({
    session: SESSION,
  });
  await expect(client.whoAmI({})).rejects.toMatchObject({
    code: ProtocolCode.SESSION_REQUIRED,
  });
  await expect(
    client.whoAmI({}, { authorization: GOOD_CREDENTIAL, withoutAuthorization: true })
  ).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
  expect(await client.json(null, { withoutAuthorization: true })).toBeNull();
});

test('refuses a credential in the clear before encoding or HTTP dispatch', async () => {
  for (const host of ['example.com', 'localhost.', '128.0.0.1']) {
    let sent = 0;
    const client = new TranscodingHttpClient(`http://${host}`, {
      authorization: GOOD_CREDENTIAL,
      fetch: () => {
        sent += 1;
        return Promise.resolve(
          new Response('null', { headers: { 'content-type': 'application/json' } })
        );
      },
    });

    await expect(client.json(undefined)).rejects.toMatchObject({
      code: ProtocolCode.DESTINATION_UNREACHABLE,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
    });
    expect(sent).toBe(0);
    expect(await client.json(null, { withoutAuthorization: true })).toBeNull();
    expect(sent).toBe(1);
  }
});

test('takes TLS and URL loopback forms for an authorized call', async () => {
  for (const url of [
    'https://example.com',
    'http://LOCALHOST',
    'http://app.localhost',
    'http://127.1',
    'http://127.0.0.1.',
    'http://[::1]',
  ]) {
    let sent = 0;
    const client = new TranscodingHttpClient(url, {
      authorization: GOOD_CREDENTIAL,
      fetch: (_url, init) => {
        sent += 1;
        expect(new Headers(init?.headers).get('authorization')).toBe(GOOD_CREDENTIAL);
        return Promise.resolve(
          new Response('null', { headers: { 'content-type': 'application/json' } })
        );
      },
    });

    expect(await client.json(null)).toBeNull();
    expect(sent).toBe(1);
  }
});

test('reads the result then notifications and the failure ending its gateway stream', async () => {
  await using fixture = await startTranscoding();
  const client = new TranscodingHttpClient(urlOf(fixture.port));
  const received: HTTPEvent<unknown, unknown>[] = [];

  try {
    for await (const event of client.subscribeTicks({ from: 2 })) {
      received.push({
        kind: event.kind,
        value:
          'ticks' in event.value
            ? { ticks: event.value.ticks }
            : { remaining: event.value.remaining },
      });
    }
    throw new Error('the stream ends with its application failure');
  } catch (error) {
    expect(error).toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: 2, scope: FailureScope.APPLICATION });
  }

  expect(received).toEqual([
    { kind: 'result', value: { ticks: 2 } },
    { kind: 'notification', value: { remaining: 1 } },
    { kind: 'notification', value: { remaining: 0 } },
  ]);
});

test('reads fragmented UTF-8 and CRLF events and releases an iteration that stops', async () => {
  let cancelled = 0;
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: stubOf(
      ': heartbeat\r\nevent: result\r\nid: 1\r\ndata: {}\r\n\r\nid: 2\r\ndata: {"remaining":7}\r\n\r\n',
      {
        fragmented: true,
        cancelled: () => {
          cancelled += 1;
        },
      }
    ),
  });
  const received: HTTPEvent<unknown, unknown>[] = [];

  for await (const event of client.subscribeWatch({})) {
    received.push(event);

    if (received.length === 2) {
      break;
    }
  }

  expect(received[0]?.kind).toBe('result');
  expect(received[1]).toMatchObject({ kind: 'notification', value: { remaining: 7 } });
  expect(cancelled).toBe(1);
});

test('refuses notifications before the result and a second result and releases the stream', async () => {
  for (const body of ['data: {}\n\n', 'event: result\ndata: {}\n\nevent: result\ndata: {}\n\n']) {
    let cancelled = 0;
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: stubOf(body, {
        cancelled: () => {
          cancelled += 1;
        },
      }),
    });

    await expect(async () => {
      for await (const _event of client.subscribeWatch({})) {
        /* the parser refuses the sequence */
      }
    }).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
    expect(cancelled).toBe(1);
  }
});

test('bounds unary bodies and events and refuses redirects without following them', async () => {
  const unary = new TranscodingHttpClient('http://localhost', {
    maximumBodyBytes: 2,
    fetch: () => {
      return Promise.resolve(
        new Response('null', { headers: { 'content-type': 'application/json' } })
      );
    },
  });
  await expect(unary.json(null)).rejects.toMatchObject({
    code: ProtocolCode.PAYLOAD_UNDECODABLE,
  });
  const stream = new TranscodingHttpClient('http://localhost', {
    maximumBodyBytes: 2,
    fetch: stubOf('data: {}\n\n'),
  });
  await expect(async () => {
    for await (const _event of stream.subscribeWatch({})) {
      /* the bound refuses the event */
    }
  }).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
  const redirect = new TranscodingHttpClient('http://localhost', {
    fetch: (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(
        new Response(null, { status: 307, headers: { location: 'https://example.com' } })
      );
    },
  });
  await expect(redirect.json(null)).rejects.toMatchObject({
    code: ProtocolCode.PAYLOAD_UNDECODABLE,
  });
});

test('passes cancellation to HTTP dispatch and rejects a URL or bound outside its contract', async () => {
  const abort = new AbortController();
  const reason = new Error('cancelled by the call');
  let seen: AbortSignal | null | undefined;
  let entered: () => void = () => {};
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: (_url, init) => {
      seen = init?.signal;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        seen?.addEventListener(
          'abort',
          () => {
            reject(reason);
          },
          { once: true }
        );
      });
    },
  });
  const waiting = client.json(null, { signal: abort.signal });
  await entering;
  abort.abort(reason);
  await expect(waiting).rejects.toBe(abort.signal.reason);
  expect(seen).toBe(abort.signal);

  for (const url of [
    'http://user:secret@localhost',
    'http://localhost/path',
    'http://localhost?x=1',
    'http://localhost/#fragment',
    'ftp://localhost',
  ]) {
    expect(() => {
      return new TranscodingHttpClient(url);
    }).toThrow(ProgrammerError);
  }
  expect(() => {
    return new TranscodingHttpClient('http://localhost', { maximumBodyBytes: 0 });
  }).toThrow(ProgrammerError);
});

test('reads text and raw event data by their encodings', async () => {
  const watch = HTTP_ROUTES.find((route) => {
    return route.procedure.procedure.procedureName === 'watch';
  });
  if (watch === undefined) {
    throw new Error('watch is a generated route');
  }
  const route = { ...watch, result: 'text', notification: 'raw' } as const;
  const caller = createHTTPCaller([route], 'http://localhost', {
    fetch: stubOf(
      'event: result\ndata: "Ada\\rJosé"\n\ndata: "AAH/"\n\nevent: failure\ndata: {"code":7,"scope":"protocol"}\n\n',
      { fragmented: true }
    ),
  });
  const received: HTTPEvent<unknown, unknown>[] = [];

  await expect(async () => {
    for await (const entry of caller.subscribe(route, {})) {
      received.push(entry);
    }
  }).rejects.toMatchObject({ code: 7, scope: FailureScope.PROTOCOL });
  expect(received).toEqual([
    { kind: 'result', value: 'Ada\rJosé' },
    { kind: 'notification', value: Uint8Array.of(0, 1, 255) },
  ]);
});

test('refuses a truncated stream and malformed problems without another call', async () => {
  for (const [body, status, type] of [
    ['event: result\ndata: {}\n\n', 200, 'text/event-stream'],
    ['{}', 400, 'application/problem+json'],
    ['{"code":0,"scope":"protocol"}', 400, 'application/problem+json'],
    ['{}', 200, 'application/json'],
  ] as const) {
    let sent = 0;
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(new Response(body, { status, headers: { 'content-type': type } }));
      },
    });

    await expect(async () => {
      for await (const _entry of client.subscribeWatch({})) {
        /* a truncated stream fails */
      }
    }).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE, origin: 'local' });
    expect(sent).toBe(1);
  }
});

test('refuses an authorization outside HTTP field values before dispatch', async () => {
  let sent = 0;
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      sent += 1;
      return Promise.resolve(new Response('null'));
    },
  });

  for (const authorization of ['Bearer bad\r\ninjected: value', '\u0001', 'Bearer José']) {
    await expect(client.json(null, { authorization })).rejects.toBeInstanceOf(ProgrammerError);
  }
  expect(sent).toBe(0);
});

test('reads numeric problem codes by their integer value and refuses another JSON kind', async () => {
  for (const [body, code, scope, origin] of [
    ['{"code":1.0,"scope":"application"}', 1, FailureScope.APPLICATION, 'peer'],
    ['{"code":1e0,"scope":"application"}', 1, FailureScope.APPLICATION, 'peer'],
    [
      '{"code":"1","scope":"application"}',
      ProtocolCode.PAYLOAD_UNDECODABLE,
      FailureScope.PROTOCOL,
      'local',
    ],
    ['{"code":1,"scope":1}', ProtocolCode.PAYLOAD_UNDECODABLE, FailureScope.PROTOCOL, 'local'],
    [
      '{"code":1,"scope":"application","detail":2}',
      ProtocolCode.PAYLOAD_UNDECODABLE,
      FailureScope.PROTOCOL,
      'local',
    ],
  ] as const) {
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        return Promise.resolve(
          new Response(body, {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          })
        );
      },
    });
    await expect(client.json(null)).rejects.toMatchObject({ code, scope, origin });
  }
});
