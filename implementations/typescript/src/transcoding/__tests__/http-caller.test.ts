import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { FailureScope, LIMIT_DEFAULTS, ProtocolCode } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { ProgrammerError } from '../../transport/shared/errors';
import { createHTTPCaller, type HTTPEvent } from '../http-caller';
import type { IHttpRouteInit } from '../routes';
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
    expect(init?.credentials).toBe('same-origin');
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

test('refuses an answer from a supplied executor that follows a redirect', async () => {
  let disposed = 0;
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            disposed += 1;
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
      Object.defineProperty(response, 'redirected', { value: true });
      return Promise.resolve(response);
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({ code: ProtocolCode.DESTINATION_LOST });
  expect(disposed).toBe(1);
});

// transcoding 12.1
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

// transcoding 12.4 and 12.4.1
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

// transcoding 12.3
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

// transcoding 12.5
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

// transcoding 12.6
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
    code: ProtocolCode.PAYLOAD_TOO_LARGE,
  });
  const stream = new TranscodingHttpClient('http://localhost', {
    maximumBodyBytes: 2,
    fetch: stubOf('data: {}\n\n'),
  });
  await expect(async () => {
    for await (const _event of stream.subscribeWatch({})) {
      /* the bound refuses the event */
    }
  }).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });
  const redirect = new TranscodingHttpClient('http://localhost', {
    fetch: (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(
        new Response(null, { status: 307, headers: { location: 'https://example.com' } })
      );
    },
  });
  await expect(redirect.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_LOST,
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
  for (const [body, status, type, code, origin] of [
    [
      'event: result\ndata: {}\n\n',
      200,
      'text/event-stream',
      ProtocolCode.DESTINATION_LOST,
      'local',
    ],
    ['{}', 400, 'application/problem+json', ProtocolCode.PAYLOAD_UNDECODABLE, 'peer'],
    [
      '{"code":0,"scope":"protocol"}',
      400,
      'application/problem+json',
      ProtocolCode.PAYLOAD_UNDECODABLE,
      'local',
    ],
    ['{}', 200, 'application/json', ProtocolCode.PAYLOAD_UNDECODABLE, 'local'],
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
    }).rejects.toMatchObject({ code, origin });
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

  for (const authorization of [
    'Bearer bad\r\ninjected: value',
    '\u0001',
    'Bearer José',
    ' Bearer good',
    'Bearer good ',
    '\tBearer good',
    'Bearer good\t',
  ]) {
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

// transcoding 12.4.3
test('maps an unmarked HTTP 401 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 401, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.SESSION_REQUIRED,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 401; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 403 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 403, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.ACCESS_DENIED,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 403; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 404 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 404, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_UNREACHABLE,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 404; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 413 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 413, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.PAYLOAD_TOO_LARGE,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 413; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 429 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 429, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.CAPACITY_EXCEEDED,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 429; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 503 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 503, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_UNREACHABLE,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 503; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 502 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 502, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_LOST,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 502; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 504 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 504, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_LOST,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 504; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 307 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 307, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_LOST,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 307; Retry-After: 7',
  });
});

test('maps an unmarked HTTP 418 and keeps its status and Retry-After', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      return Promise.resolve(
        new Response('upstream', { status: 418, headers: { 'retry-after': '7' } })
      );
    },
  });
  await expect(client.json(null)).rejects.toMatchObject({
    code: ProtocolCode.DESTINATION_LOST,
    scope: FailureScope.PROTOCOL,
    origin: 'peer',
    detail: 'the HTTP call answers 418; Retry-After: 7',
  });
});

// transcoding 12.4.2
test('reads gateway problems by their refusal before their status', async () => {
  for (const [status, refusal, code] of [
    [503, 'busy', ProtocolCode.CAPACITY_EXCEEDED],
    [404, 'path-unknown', ProtocolCode.DESTINATION_UNREACHABLE],
    [413, 'too-large', ProtocolCode.PAYLOAD_TOO_LARGE],
    [403, 'host-refused', ProtocolCode.ACCESS_DENIED],
    [403, 'origin-refused', ProtocolCode.ACCESS_DENIED],
    [405, 'method-refused', ProtocolCode.DESTINATION_UNREACHABLE],
    [400, 'malformed', ProtocolCode.PAYLOAD_UNDECODABLE],
    [415, 'type-refused', ProtocolCode.PAYLOAD_UNDECODABLE],
    [408, 'too-slow', ProtocolCode.DESTINATION_UNREACHABLE],
    [401, '', ProtocolCode.SESSION_REQUIRED],
    [502, '', ProtocolCode.DESTINATION_LOST],
  ] as const) {
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        return Promise.resolve(
          new Response('{"type":"about:blank","detail":"by the gateway"}', {
            status,
            headers: {
              'content-type': 'Application/Problem+JSON',
              'bead-refusal': refusal,
              'retry-after': '7',
            },
          })
        );
      },
    });
    await expect(client.json(null)).rejects.toMatchObject({
      code,
      origin: 'peer',
      scope: FailureScope.PROTOCOL,
      detail: 'the HTTP call answers ' + String(status) + '; Retry-After: 7; by the gateway',
    });
  }
});

// transcoding 12.2
test('joins a base URL path to its default routes and treats an empty authorization as none', async () => {
  for (const path of ['/proxy', '/proxy/']) {
    let sent = 0;
    const client = new TranscodingHttpClient('http://example.com' + path, {
      authorization: '',
      fetch: (url, init) => {
        sent += 1;
        expect(url).toBe('http://example.com/proxy/api/Transcoding/json');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        expect(init?.credentials).toBe('same-origin');
        return Promise.resolve(
          new Response('null', { headers: { 'content-type': 'Application/JSON' } })
        );
      },
    });
    expect(await client.json(null)).toBeNull();
    expect(sent).toBe(1);
  }
});

test('reads a leading stream BOM and media types without case', async () => {
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: stubOf(
      '﻿event: result\r\ndata: {}\r\n\r\nevent: failure\r\ndata: {"status":502}\r\n\r\n',
      { fragmented: true, type: 'Text/Event-Stream' }
    ),
  });
  const events: HTTPEvent<unknown, unknown>[] = [];
  await expect(async () => {
    for await (const event of client.subscribeWatch({})) {
      events.push(event);
    }
  }).rejects.toMatchObject({ code: ProtocolCode.DESTINATION_LOST, origin: 'peer' });
  expect(events).toEqual([{ kind: 'result', value: expect.anything() }]);
});

test('wraps malformed JSON UTF-8 base64 and event framing as an undecodable payload', async () => {
  const route = HTTP_ROUTES.find((entry) => {
    return entry.procedure.procedure.procedureName === 'watch';
  });
  if (route === undefined) {
    throw new Error('watch is a generated route');
  }
  for (const [body, raw] of [
    ['event: result\ndata: {\n\n', false],
    ['event: result\ndata: "%%%"\n\n', true],
    ['event: message\ndata: {}\n\n', false],
  ] as const) {
    const mapped = raw ? { ...route, result: 'raw' as const } : route;
    const caller = createHTTPCaller([mapped], 'http://localhost', {
      fetch: stubOf(body, { fragmented: true }),
    });
    await expect(async () => {
      for await (const event of caller.subscribe(mapped, {})) {
        void event;
      }
    }).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE, origin: 'local' });
  }
  for (const type of ['application/json', 'application/problem+json', 'text/event-stream']) {
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        return Promise.resolve(
          new Response(Uint8Array.of(0xff), {
            status: type === 'application/problem+json' ? 400 : 200,
            headers: { 'content-type': type },
          })
        );
      },
    });
    const waiting =
      type === 'text/event-stream'
        ? (async () => {
            for await (const event of client.subscribeWatch({})) {
              void event;
            }
          })()
        : client.json(null);
    await expect(waiting).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_UNDECODABLE,
      origin: 'local',
      detail: 'the HTTP payload cannot be decoded',
      cause: expect.anything(),
    });
  }
});

test('refuses non-string and noncanonical raw event data and releases its reader', async () => {
  const generated = HTTP_ROUTES.find((entry) => {
    return entry.procedure.procedure.procedureName === 'watch';
  });
  if (generated === undefined) {
    throw new Error('watch is a generated route');
  }
  const route = { ...generated, result: 'raw' as const };

  for (const [data, detail] of [
    ['null', 'an HTTP text or raw event holds a JSON string'],
    ['"AB=="', 'an HTTP raw event holds standard padded base64'],
  ] as const) {
    let cancelled = 0;
    let sent = 0;
    const fetcher = stubOf(`event: result\ndata: ${data}\n\n`, {
      fragmented: true,
      cancelled: () => {
        cancelled += 1;
      },
    });
    const caller = createHTTPCaller([route], 'http://localhost', {
      fetch: (url, init) => {
        sent += 1;
        return fetcher(url, init);
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];

    await expect(async () => {
      for await (const event of caller.subscribe(route, {})) {
        received.push(event);
      }
    }).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_UNDECODABLE,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
      detail,
    });
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(cancelled).toBe(1);
  }
});

test('refuses invalid result media and malformed JSON without another call', async () => {
  for (const [body, type, detail] of [
    ['null', 'text/plain', 'the HTTP result has another media type'],
    ['{', 'application/json', 'the HTTP payload cannot be decoded'],
  ] as const) {
    let cancelled = 0;
    let sent = 0;
    const responses: Response[] = [];
    const fetcher = stubOf(body, {
      type,
      cancelled: () => {
        cancelled += 1;
      },
    });
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: async (url, init) => {
        sent += 1;
        const response =
          type === 'application/json'
            ? new Response(body, { headers: { 'content-type': type } })
            : await fetcher(url, init);

        responses.push(response);
        return response;
      },
    });

    await expect(client.json(null)).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_UNDECODABLE,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
      detail,
    });
    expect(sent).toBe(1);
    expect(cancelled).toBe(type === 'text/plain' ? 1 : 0);
    expect(responses[0]?.body?.locked).toBe(false);
  }
});

test('maps failed response reads to destination lost and releases their readers', async () => {
  for (const streaming of [false, true]) {
    const broken = new Error('the response reader broke');
    let reads = 0;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode(streaming ? 'event: result\ndata: ' : 'nu'));
          return;
        }
        throw broken;
      },
    });
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
          })
        );
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];

    const failed = await (async () => {
      if (streaming) {
        for await (const event of client.subscribeWatch({})) {
          received.push(event);
        }
      } else {
        await client.json(null);
      }
    })().catch((error: unknown) => {
      return error;
    });
    expect(failed).toBeInstanceOf(FailureError);
    expect(failed).toMatchObject({
      code: ProtocolCode.DESTINATION_LOST,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
      detail: 'the HTTP body ends before its answer',
      cause: broken,
    });
    expect((failed as FailureError).cause).toBe(broken);
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(reads).toBe(2);
    expect(stream.locked).toBe(false);
  }
});

test('bounds the decoded message even when the body bound is larger', async () => {
  const maximumBodyBytes = LIMIT_DEFAULTS.maximumEnvelopeBytes + 1;
  const client = new TranscodingHttpClient('http://localhost', {
    maximumBodyBytes,
    fetch: () => {
      return Promise.resolve(
        new Response(new Uint8Array(maximumBodyBytes), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
    },
  });
  await expect(client.raw(new Uint8Array())).rejects.toMatchObject({
    code: ProtocolCode.PAYLOAD_TOO_LARGE,
    origin: 'local',
    detail: 'the HTTP payload passes maximumEnvelopeBytes',
  });
});

test('maps a gateway problem without a refusal by its status', async () => {
  for (const [status, code] of [
    [400, ProtocolCode.PAYLOAD_UNDECODABLE],
    [401, ProtocolCode.SESSION_REQUIRED],
    [403, ProtocolCode.ACCESS_DENIED],
    [404, ProtocolCode.DESTINATION_UNREACHABLE],
    [405, ProtocolCode.DESTINATION_UNREACHABLE],
    [408, ProtocolCode.DESTINATION_UNREACHABLE],
    [413, ProtocolCode.PAYLOAD_TOO_LARGE],
    [415, ProtocolCode.PAYLOAD_UNDECODABLE],
    [422, ProtocolCode.PAYLOAD_INVALID],
    [429, ProtocolCode.CAPACITY_EXCEEDED],
    [431, ProtocolCode.PAYLOAD_TOO_LARGE],
    [500, ProtocolCode.DESTINATION_LOST],
    [501, ProtocolCode.PROCEDURE_UNKNOWN],
    [502, ProtocolCode.DESTINATION_LOST],
    [503, ProtocolCode.DESTINATION_UNREACHABLE],
    [504, ProtocolCode.DESTINATION_LOST],
  ] as const) {
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        return Promise.resolve(
          new Response('{"type":"about:blank"}', {
            status,
            headers: { 'content-type': 'application/problem+json' },
          })
        );
      },
    });
    await expect(client.json(null)).rejects.toMatchObject({
      code,
      origin: 'peer',
      scope: FailureScope.PROTOCOL,
      detail: 'the HTTP call answers ' + String(status),
    });
  }
});

// spec 17.9.7, transcoding 5.2.4
test('fails a request whose value leaves a required field unset before anything goes, with the codec’s refusal', async () => {
  let sent = 0;
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      sent += 1;

      return Promise.resolve(
        new Response('{}', { headers: { 'content-type': 'application/json' } })
      );
    },
  });
  const refused = await client.require({ needs: { count: 1 } }).catch((error: unknown) => {
    return error;
  });

  // * the codec's own refusal, a writer's, as it is on every encoding: no Bead failure
  expect(refused).toBeInstanceOf(TypeError);
  expect((refused as Error).message).toBe(
    'a proto message leaves bead.transcoding.v1.Needs.name unset'
  );
  expect(sent).toBe(0);
});

test('fails a result that leaves a required field unset with PAYLOAD_UNDECODABLE', async () => {
  let sent = 0;
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      sent += 1;

      return Promise.resolve(
        new Response('{"count":1}', { headers: { 'content-type': 'application/json' } })
      );
    },
  });

  await expect(client.require({})).rejects.toMatchObject({
    code: ProtocolCode.PAYLOAD_UNDECODABLE,
    detail: 'the HTTP payload cannot be decoded',
    origin: 'local',
    scope: FailureScope.PROTOCOL,
  });
  expect(sent).toBe(1);
});

test('refuses invalid low-level call inputs before HTTP dispatch', async () => {
  const generated = HTTP_ROUTES.find((route) => {
    return route.procedure.procedure.procedureName === 'json';
  });
  const template = generated?.routes[0];
  if (generated === undefined || template === undefined) {
    throw new Error('json has a generated default route');
  }
  let sent = 0;
  const fetcher: typeof fetch = () => {
    sent += 1;
    return Promise.resolve(new Response('null'));
  };
  const choices: IHttpRouteInit['routes'][] = [
    [],
    [{ ...template, method: 'GET' }],
    [{ ...template, body: undefined }],
    [{ ...template, responseBody: 'field' }],
    [{ ...template, template: '/items/{name}' }],
  ];
  for (const routes of choices) {
    const route = { ...generated, routes };
    const caller = createHTTPCaller([route], 'http://localhost', { fetch: fetcher });
    await expect(caller.call(route, null)).rejects.toThrow(
      'an HTTP client calls a default POST route with a whole body and result'
    );
  }
  const elsewhere = {
    ...generated,
    routes: [{ ...template, template: 'https://elsewhere.example/call' }],
  };
  const caller = createHTTPCaller([generated, elsewhere], 'http://localhost', { fetch: fetcher });
  await expect(caller.call(elsewhere, null)).rejects.toThrow(
    'an HTTP route stays on its gateway origin'
  );
  for (const authorization of [' Bearer x', 'Bearer x ', 'Bearer\nx', '\t', 'É']) {
    await expect(caller.call(generated, null, { authorization })).rejects.toThrow(
      'a credential holds visible ASCII, spaces and tabs alone, none first or last'
    );
  }
  await expect(async () => {
    for await (const event of caller.subscribe(generated, null)) {
      throw new Error(`a non-notifying call yielded ${event.kind}`);
    }
  }).rejects.toThrow('only a notifying HTTP procedure opens a stream');
  expect(sent).toBe(0);
});

test('refuses invalid UTF-8 on a terminated event line and releases its reader', async () => {
  let cancelled = 0;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const octet of [...new TextEncoder().encode('event: result\ndata: '), 255, 10, 10]) {
        controller.enqueue(Uint8Array.of(octet));
      }
    },
    cancel: () => {
      cancelled += 1;
    },
  });
  const client = new TranscodingHttpClient('http://localhost', {
    fetch: () => {
      sent += 1;
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      );
    },
  });
  const received: HTTPEvent<unknown, unknown>[] = [];
  const failed = await (async () => {
    for await (const event of client.subscribeWatch({})) {
      received.push(event);
    }
  })().catch((error: unknown) => {
    return error;
  });
  expect(failed).toBeInstanceOf(FailureError);
  expect(failed).toMatchObject({
    code: ProtocolCode.PAYLOAD_UNDECODABLE,
    origin: 'local',
    scope: FailureScope.PROTOCOL,
    detail: 'the HTTP payload cannot be decoded',
  });
  expect((failed as FailureError).cause).toBeInstanceOf(TypeError);
  expect(received).toEqual([]);
  expect(sent).toBe(1);
  expect(cancelled).toBe(1);
  expect(stream.locked).toBe(false);
});

test('propagates a response read error after cancellation without mapping it to a failure', async () => {
  for (const streaming of [false, true]) {
    const abort = new AbortController();
    const broken = new Error('the cancelled response reader broke');
    let reads = 0;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          reads += 1;
          if (reads === 1) {
            controller.enqueue(
              new TextEncoder().encode(streaming ? 'event: result\ndata: ' : 'nu')
            );
            return;
          }
          abort.abort();
          throw broken;
        },
      },
      { highWaterMark: 0 }
    );
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
          })
        );
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];
    const failed = await (async () => {
      if (streaming) {
        for await (const event of client.subscribeWatch({}, { signal: abort.signal })) {
          received.push(event);
        }
      } else {
        await client.json(null, { signal: abort.signal });
      }
    })().catch((error: unknown) => {
      return error;
    });
    expect(failed).toBe(broken);
    expect(abort.signal.aborted).toBe(true);
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(reads).toBe(2);
    expect(stream.locked).toBe(false);
  }
});

test('refuses malformed JSON in native stream data before delivering an event', async () => {
  const generated = HTTP_ROUTES.find((entry) => {
    return entry.procedure.procedure.procedureName === 'watch';
  });
  if (generated === undefined) {
    throw new Error('watch is a generated route');
  }
  for (const result of ['text', 'raw'] as const) {
    const route = { ...generated, result };
    let cancelled = 0;
    let sent = 0;
    const fetcher = stubOf('event: result\ndata: {\n\n', {
      fragmented: true,
      cancelled: () => {
        cancelled += 1;
      },
    });
    const caller = createHTTPCaller([route], 'http://localhost', {
      fetch: (url, init) => {
        sent += 1;
        return fetcher(url, init);
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];
    const failed = await (async () => {
      for await (const event of caller.subscribe(route, {})) {
        received.push(event);
      }
    })().catch((error: unknown) => {
      return error;
    });
    expect(failed).toBeInstanceOf(FailureError);
    expect(failed).toMatchObject({
      code: ProtocolCode.PAYLOAD_UNDECODABLE,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
      detail: 'the HTTP payload cannot be decoded',
    });
    expect((failed as FailureError).cause).toBeInstanceOf(Error);
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(cancelled).toBe(1);
  }
});

test('reads an empty raw result and maps an empty non-problem refusal by status', async () => {
  for (const status of [200, 503]) {
    let sent = 0;
    const response = new Response(null, {
      status,
      headers: { 'content-type': 'application/octet-stream', 'retry-after': '7' },
    });
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(response);
      },
    });
    if (status === 200) {
      expect(await client.raw(new Uint8Array())).toEqual(new Uint8Array());
    } else {
      await expect(client.raw(new Uint8Array())).rejects.toMatchObject({
        code: ProtocolCode.DESTINATION_UNREACHABLE,
        scope: FailureScope.PROTOCOL,
        origin: 'peer',
        detail: 'the HTTP call answers 503; Retry-After: 7',
      });
    }
    expect(sent).toBe(1);
    expect(response.body).toBeNull();
  }
});

test('rejects empty responses with no required media type and releases their content', async () => {
  for (const [streaming, status, code, detail] of [
    [false, 200, ProtocolCode.PAYLOAD_UNDECODABLE, 'the HTTP result has another media type'],
    [true, 200, ProtocolCode.PAYLOAD_UNDECODABLE, 'the HTTP subscription answers no event stream'],
    [false, 503, ProtocolCode.DESTINATION_UNREACHABLE, 'the HTTP call answers 503'],
  ] as const) {
    let sent = 0;
    const response = new Response(null, { status });
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(response);
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];
    await expect(async () => {
      if (streaming) {
        for await (const event of client.subscribeWatch({})) {
          received.push(event);
        }
      } else {
        await client.json(null);
      }
    }).rejects.toMatchObject({
      code,
      detail,
      scope: FailureScope.PROTOCOL,
      origin: status === 200 ? 'local' : 'peer',
    });
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(response.body).toBeNull();
  }
});

test('refuses an empty event stream from a supplied executor and over HTTP', async () => {
  for (const wire of [false, true]) {
    let sent = 0;
    await using host = createServer((_request, response) => {
      sent += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '0' });
      response.end();
    });
    await new Promise<void>((resolve) => {
      host.listen(0, '127.0.0.1', resolve);
    });
    const address = host.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the HTTP fixture listens on no port');
    }
    let answered: Response | undefined;
    const client = new TranscodingHttpClient(urlOf(address.port), {
      fetch: async (url, init) => {
        if (wire) {
          answered = await fetch(url, init);
          expect(answered.body).not.toBeNull();
        } else {
          sent += 1;
          answered = new Response(null, { headers: { 'content-type': 'text/event-stream' } });
        }
        return answered;
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];
    await expect(async () => {
      for await (const event of client.subscribeWatch({})) {
        received.push(event);
      }
    }).rejects.toMatchObject({
      code: wire ? ProtocolCode.DESTINATION_LOST : ProtocolCode.PAYLOAD_UNDECODABLE,
      detail: wire
        ? 'the HTTP event stream ends without a failure'
        : 'the HTTP subscription answers no event stream',
      scope: FailureScope.PROTOCOL,
      origin: 'local',
    });
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(answered?.bodyUsed).toBe(wire);
    expect(answered?.body?.locked ?? false).toBe(false);
  }
});

test('maps unmarked HTTP statuses without treating an intermediary as its gateway', async () => {
  for (const [status, code] of [
    [201, ProtocolCode.DESTINATION_LOST],
    [204, ProtocolCode.DESTINATION_LOST],
    [299, ProtocolCode.DESTINATION_LOST],
    [300, ProtocolCode.DESTINATION_LOST],
    [304, ProtocolCode.DESTINATION_LOST],
    [399, ProtocolCode.DESTINATION_LOST],
    [400, ProtocolCode.DESTINATION_LOST],
    [401, ProtocolCode.SESSION_REQUIRED],
    [403, ProtocolCode.ACCESS_DENIED],
    [404, ProtocolCode.DESTINATION_UNREACHABLE],
    [405, ProtocolCode.DESTINATION_LOST],
    [408, ProtocolCode.DESTINATION_LOST],
    [413, ProtocolCode.PAYLOAD_TOO_LARGE],
    [415, ProtocolCode.DESTINATION_LOST],
    [422, ProtocolCode.DESTINATION_LOST],
    [429, ProtocolCode.CAPACITY_EXCEEDED],
    [431, ProtocolCode.DESTINATION_LOST],
    [500, ProtocolCode.DESTINATION_LOST],
    [501, ProtocolCode.DESTINATION_LOST],
    [502, ProtocolCode.DESTINATION_LOST],
    [503, ProtocolCode.DESTINATION_UNREACHABLE],
    [504, ProtocolCode.DESTINATION_LOST],
    [599, ProtocolCode.DESTINATION_LOST],
  ] as const) {
    let sent = 0;
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: () => {
        sent += 1;
        return Promise.resolve(new Response(null, { status, headers: { 'retry-after': '7' } }));
      },
    });
    await expect(client.json(null)).rejects.toMatchObject({
      code,
      scope: FailureScope.PROTOCOL,
      origin: 'peer',
      detail: `the HTTP call answers ${String(status)}; Retry-After: 7`,
    });
    expect(sent).toBe(1);
  }
});

test('refuses a stream failure with an invalid HTTP problem status and no Bead code', async () => {
  for (const data of [
    'null',
    '{}',
    '{"status":99}',
    '{"status":600}',
    '{"status":1.5}',
    '{"status":"502"}',
    '{"status":null}',
  ]) {
    let cancelled = 0;
    let sent = 0;
    const fetcher = stubOf(`event: failure\ndata: ${data}\n\n`, {
      fragmented: true,
      cancelled: () => {
        cancelled += 1;
      },
    });
    const client = new TranscodingHttpClient('http://localhost', {
      fetch: (url, init) => {
        sent += 1;
        return fetcher(url, init);
      },
    });
    const received: HTTPEvent<unknown, unknown>[] = [];
    await expect(async () => {
      for await (const event of client.subscribeWatch({})) {
        received.push(event);
      }
    }).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_UNDECODABLE,
      scope: FailureScope.PROTOCOL,
      origin: 'local',
      detail: 'the HTTP problem holds no Bead failure',
    });
    expect(received).toEqual([]);
    expect(sent).toBe(1);
    expect(cancelled).toBe(1);
  }
});
