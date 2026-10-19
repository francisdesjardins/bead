import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { expect } from '@playwright/test';
import {
  AFTER_HEADER,
  BEAD_MEDIA_TYPE,
  CONNECTION_TOKEN_HEADER,
  createHTTPTransportServer,
  LISTEN_HEADER,
  REFUSAL_HEADER,
  WAIT_HEADER,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../http-transport-server';
import type {
  IHTTPRequestLike,
  ITransportServerRefusal,
  TransportServerConnectionHandle,
} from '../types';
import { createFakeHTTPServer } from './fake-http-server';

/**
 * What the HTTP server's suites share: a transport started, its requests, and what reads what
 * it answered and emitted.
 */

// helpers

export const host = '127.0.0.1';

/**
 * A request as Node hands it over, of `fields` in their order and nothing else: `headers` keeps a
 * field's first line, `rawHeaders` every one.
 */
export const requestLikeOf = (fields: readonly (readonly [string, string])[]): IHTTPRequestLike => {
  const headers: Record<string, string> = {};

  for (const [name, value] of fields) {
    headers[name.toLowerCase()] ??= value;
  }

  return {
    destroy: () => {
      return undefined;
    },
    headers,
    httpVersion: '1.1',
    httpVersionMajor: 1,
    on: () => {
      return undefined;
    },
    rawHeaders: fields.flat(),
    socket: {},
  };
};

/** A bearer credential, RFC 6750's own example, its auth-scheme included. */
export const BEARER = 'Bearer mF_9.B5f-4.1JqM';

/** A page of another origin, which a server answers CORS to when `origins` names it. */
export const PAGE = 'https://page.test';

/** What a preflight from {@link PAGE} is answered beside its 204, whatever it asks for, but the fields it allows. */
const PREFLIGHT_ANSWER = Object.freeze({
  'access-control-allow-credentials': null,
  'access-control-allow-methods': 'GET, POST, DELETE',
  'access-control-allow-origin': PAGE,
  'access-control-expose-headers': '*',
  'access-control-max-age': '7200',
  'bead-refusal': null,
  'cache-control': 'no-store',
  vary: 'Origin',
  'x-content-type-options': 'nosniff',
});

/**
 * What a preflight from {@link PAGE} is answered beside its 204, whatever method it asks for:
 * `authorization`, the fields it asks for as they came, then any.
 */
export const preflightAnswerOf = (asked?: string) => {
  const allowed = ['authorization', ...(asked === undefined ? [] : [asked]), '*'];

  return { ...PREFLIGHT_ANSWER, 'access-control-allow-headers': allowed.join(', ') };
};

/** The fields `expected` names, as `headers` carries them: each one's value, or null when absent. */
export const fieldsOf = (
  headers: { get(name: string): string | null | undefined },
  expected: Readonly<Record<string, string | null>>
) => {
  return Object.fromEntries(
    Object.keys(expected).map((name) => {
      return [name, headers.get(name) ?? null];
    })
  );
};

/** An envelope as the transport reads it: its layout, its kind, its call id, and `extra` bytes. */
export const envelopeOf = (
  kind: number,
  { callId, extra = 0, layout = 0xa1 }: { callId: number; extra?: number; layout?: number }
): Uint8Array => {
  const bytes = new Uint8Array(8 + extra).fill(7);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, layout);
  view.setUint8(1, kind);
  view.setUint32(4, callId);

  return bytes;
};

/** What a listen brings back of `envelopes`: each after its length in 4 bytes. */
export const batchOf = (...envelopes: Uint8Array[]): number[] => {
  return envelopes.flatMap((envelope) => {
    const length = new Uint8Array(4);

    new DataView(length.buffer).setUint32(0, envelope.length);

    return [...length, ...envelope];
  });
};

/** The events a transport server emits, each as its name and what it carries. */
export const recordOf = (server: HTTPTransportServer) => {
  const events: [string, ...unknown[]][] = [];

  server.on('connection', (...[shown, drawing, connectionHandle]) => {
    events.push(['connection', shown, drawing, connectionHandle]);
  });
  server.on('message', ({ data }, connectionHandle) => {
    events.push(['message', [...(data as Uint8Array)], connectionHandle]);
  });
  server.on('close', (wasClean, connectionHandle) => {
    events.push(['close', wasClean, connectionHandle]);
  });
  server.on('error', (error, connectionHandle) => {
    events.push(['error', error.message, connectionHandle]);
  });

  return events;
};

export const namesOf = (events: [string, ...unknown[]][], name: string) => {
  return events.filter(([each]) => {
    return each === name;
  });
};

/** A transport server on a free port, with the events it emitted, and its URL. */
export const startTransport = async (options?: Partial<IHTTPTransportServerOptions>) => {
  const server = createHTTPTransportServer({
    createServer: (listener) => {
      return createServer(listener);
    },
    ...options,
  });
  const { port } = await server.start({ address: host, findOpenPort: true });
  const events = recordOf(server);

  return {
    events,
    server,
    url: `http://${host}:${String(port)}/bead`,
    [Symbol.asyncDispose]: () => {
      return server.stop();
    },
  };
};

export const post = (
  url: string,
  {
    body,
    connectionToken,
    headers,
    signal,
  }: {
    body?: Uint8Array | ReadableStream<Uint8Array>;
    connectionToken?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
) => {
  return fetch(url, {
    body,
    // a stream goes chunked, its length unknown
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    headers: {
      'content-type': BEAD_MEDIA_TYPE,
      ...(connectionToken === undefined ? {} : { [CONNECTION_TOKEN_HEADER]: connectionToken }),
      ...headers,
    },
    method: 'POST',
    signal,
  } as RequestInit);
};

/** Connects: the token the server drew, and the handle it named the connection by. */
export const connect = async (url: string, server: HTTPTransportServer) => {
  const response = await post(url);

  return {
    connectionHandle: server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle,
    connectionToken: response.headers.get(CONNECTION_TOKEN_HEADER) ?? '',
    response,
  };
};

export const bytesOf = async (response: Response) => {
  return [...new Uint8Array(await response.arrayBuffer())];
};

/** What a response says of itself: its status and its refusal's reason. */
export const refusalOf = async (answered: Promise<Response>) => {
  const response = await answered;

  await response.arrayBuffer().catch(() => {});

  return [response.status, response.headers.get(REFUSAL_HEADER)];
};

/** A scripted transport server, listening, with the events it emitted. */
export const startScripted = async (options?: Partial<IHTTPTransportServerOptions>) => {
  const fake = createFakeHTTPServer();
  const server = createHTTPTransportServer({ createServer: fake.createServer, ...options });
  const starting = server.start({ address: host, port: 4_321 });

  fake.listen();
  await starting;

  const events = recordOf(server);

  // a connect: its token, and the handle it drew; `isListening`, its client listens
  const connectScripted = ({
    isListening = false,
    socket,
  }: {
    isListening?: boolean;
    socket?: { remoteAddress?: string; remotePort?: number };
  } = {}) => {
    const { response } = fake.exchange({
      headers: {
        'content-type': BEAD_MEDIA_TYPE,
        ...(isListening ? { [LISTEN_HEADER]: '?1' } : {}),
      },
      ...(socket === undefined ? {} : { socket }),
    });

    return {
      connectionHandle: server.clients.at(-1)?.connectionHandle as TransportServerConnectionHandle,
      connectionToken: response.headers?.[CONNECTION_TOKEN_HEADER] ?? '',
    };
  };

  // an exchange on a connection, its body fed by the test
  const exchangeOf = (connectionToken: string, headers: Record<string, string> = {}) => {
    return fake.exchange({
      headers: {
        'content-type': BEAD_MEDIA_TYPE,
        [CONNECTION_TOKEN_HEADER]: connectionToken,
        ...headers,
      },
    });
  };

  // a listen, its counts in their fields (spec 15.9): `bead-after` 0 unless given, `null` leaving it
  // out, and `bead-wait` left out unless given
  const listenOf = (
    connectionToken: string,
    {
      after = '0',
      wait,
    }: { after?: string | string[] | null; wait?: string | string[] | undefined } = {}
  ) => {
    return fake.exchange({
      headers: {
        [CONNECTION_TOKEN_HEADER]: connectionToken,
        ...(after === null ? {} : { [AFTER_HEADER]: after }),
        ...(wait === undefined ? {} : { [WAIT_HEADER]: wait }),
      },
      method: 'GET',
      url: '/bead',
    });
  };

  return { connectScripted, events, exchangeOf, fake, listenOf, server };
};

/**
 * What a request written raw as `head` is answered: its status and its mark, the fields its head
 * carries by their names in lower case, and the port it came from.
 */
export const rawAnswerOf = async (port: number, head: string) => {
  const socket = connectTcp(port, host);
  let text = '';
  let isClosed = false;

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString('latin1');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    isClosed = true;
  });
  await once(socket, 'connect');

  const { localPort } = socket;

  socket.write(Buffer.from(head, 'latin1'));
  await expect
    .poll(() => {
      return text.includes('\r\n\r\n') || isClosed;
    })
    .toBe(true);
  socket.destroy();

  const lines = text.split('\r\n\r\n')[0]?.split('\r\n').slice(1) ?? [];

  return {
    answer: [
      Number(text.split(' ')[1]),
      new RegExp(`${REFUSAL_HEADER}: (.*)\r\n`, 'iu').exec(text)?.[1] ?? null,
    ],
    fields: new Map(
      lines.map((line) => {
        const colon = line.indexOf(':');

        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      })
    ),
    localPort,
  };
};

/** A connect written raw, naming `authority`, with the field lines `fields` before its own. */
export const rawConnectOf = (authority: string, fields = '') => {
  return (
    `POST /bead HTTP/1.1\r\nHost: ${authority}\r\n${fields}` +
    `Content-Type: ${BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n`
  );
};

/** Each refusal `server` tells from now on. */
export const refusalsOf = (server: HTTPTransportServer) => {
  const refusals: ITransportServerRefusal[] = [];

  server.on('refusal', (refusal) => {
    refusals.push(refusal);
  });

  return refusals;
};
