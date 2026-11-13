// ── Transcoding service ───────────────────────────────────────────────────────

// The `Transcoding` service of `spec/transcoding.proto`, served as `spec/transcoding.json`'s
// `service` states each procedure, on a server whose in-memory transport is joined, behind a
// gateway on its own listener or mounted on an application's; and the player of the file's exchanges.

// dependencies

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { fromHexadecimal } from '../../router/shared/__tests__/vectors';
import { FailureScope } from '../../router/shared/constants';
import { createServer } from '../../server/server';
import { joinTransports } from '../../transport/server/joined-transport-server';
import { createMemoryTransportServer } from '../../transport/server/memory-transport-server';
import { createHTTPGateway, type IHTTPGateway, type IHTTPGatewayOptions } from '../http-gateway';
import { HTTP_PROBLEM_TYPES, HTTP_ROUTES, OPENAPI_DOCUMENT } from './generated/bead_http';
import { TranscodingFailures, TranscodingServer } from './generated/transcoding_bead';

// interfaces

/** An application's server a gateway built with no `createServer` is mounted on, listening. */
export interface IMounted extends AsyncDisposable {
  /** Its port, on 127.0.0.1. */
  readonly port: number;
}

/** Mounts a gateway built with no `createServer` on an application's server, and starts it. */
export type Mount = (gateway: IHTTPGateway) => Promise<IMounted>;

/** A gateway's options but its transport, and the application's server that mounts it, if one does. */
export interface ITranscodingOptions
  extends
    Omit<IHTTPGatewayOptions, 'routes' | 'transport'>,
    Partial<Pick<IHTTPGatewayOptions, 'routes'>> {
  readonly mount?: Mount | undefined;
}

/** A gateway in front of a server of the service, and the counts its exchanges wait on. */
export interface ITranscodingFixture extends AsyncDisposable {
  /**
   * The calls of `hang` its resolver took, and those that ended cancelled; the calls of `require`
   * its resolver took, and the errors its server reported.
   */
  readonly counts: { cancelled: number; hanging: number; reported: number; requires: number };
  readonly gateway: IHTTPGateway;
  /** The in-memory transport its gateway's connections cross. */
  readonly memory: ReturnType<typeof createMemoryTransportServer>;
  /** The port of the gateway's own listener, or of the server it is mounted on, on 127.0.0.1. */
  readonly port: number;
  /** The detail of each command of `ask` that failed, in their order. */
  readonly refused: string[];
  readonly server: ReturnType<typeof createServer>;
  /** Notifies each subscriber of `watch` with `remaining`, as its server's service does. */
  readonly watched: (remaining: number) => Promise<void>;
}

// constants

/** The value of `authorization` the server's `ELSEWHERE` verifier takes, and the session it names. */
export const GOOD_CREDENTIAL = 'Bearer good';
export const SESSION = 'ada';

// how long `cancels` waits for the cancels it is asked for at most
const CANCELS_PATIENCE = 1_000;

// definition

/**
 * A server of the `Transcoding` service, its in-memory transport joined, and a gateway of its route
 * table listening on 127.0.0.1 in front of it, of `options` beside the transport, the document, the
 * problem types and the table beadc wrote, unless `options` gives one; where `options` mounts it,
 * built with no `createServer`, listening on the server it is mounted on.
 */
export const startTranscoding = async (
  options: ITranscodingOptions = {}
): Promise<ITranscodingFixture> => {
  const { mount, ...given } = options;
  const memory = createMemoryTransportServer();
  const server = createServer(
    { transport: joinTransports([memory]) },
    {
      credentials: {
        verify: (carried) => {
          return carried === GOOD_CREDENTIAL ? { id: SESSION } : undefined;
        },
      },
    }
  );
  const counts = { cancelled: 0, hanging: 0, reported: 0, requires: 0 };
  const refused: string[] = [];
  const service = new TranscodingServer();

  service.on('echo', (request, response) => {
    return response(request.payload);
  });
  service.on('echoEdges', (request, response) => {
    return response(request.payload);
  });
  service.on('getBook', (request, response) => {
    const { name, revision } = request.payload;

    return response({ name, pages: revision, title: 'A tale' });
  });
  service.on('listBooks', (request, response) => {
    const { parent } = request.payload;

    return response({
      books: [
        { name: `${parent}/books/a`, title: 'A' },
        { name: `${parent}/books/b`, title: 'B' },
      ],
    });
  });
  service.on('updateBook', (request, response) => {
    return response(request.payload);
  });
  service.on('archiveBook', (_request, response) => {
    return response({});
  });
  service.on('listOperations', (request, response) => {
    return response({ operations: [{ done: false, name: `${request.payload.name}/a` }] });
  });
  service.on('getOperation', (request, response) => {
    return response({ done: true, name: request.payload.name });
  });
  service.on('judge', (_request, response) => {
    return response({});
  });
  service.on('ticks', async (request, response) => {
    const { connectionHandle, payload } = request;

    await response({ ticks: payload.from });

    for (let remaining = payload.from - 1; remaining >= 0; remaining -= 1) {
      await service.notify.ticks(
        { remaining },
        {
          filter: (subscriber) => {
            return subscriber.connectionHandle === connectionHandle;
          },
        }
      );
    }

    // * the subscription ends with the service's own failure, on its call id
    await server.router.dropSubscriptions(connectionHandle, {
      code: 2,
      detail: '',
      scope: FailureScope.APPLICATION,
    });
  });
  service.on('watch', (_request, response) => {
    return response({});
  });
  service.on('raw', (request, response) => {
    return response(request.payload);
  });
  service.on('text', (request, response) => {
    return response(request.payload);
  });
  service.on('json', (request, response) => {
    return response(request.payload);
  });
  service.on('fail', (request, response) => {
    return response(null, TranscodingFailures.of('REFUSED', request.payload.detail));
  });
  service.on('whoAmI', (request, response) => {
    const identifier = request.session?.identifier;

    return response({
      session: identifier !== undefined && 'id' in identifier ? identifier.id : '',
    });
  });
  service.on('ask', async (request, response) => {
    let code = 0;

    try {
      await service.command.answer({})({ connectionHandle: request.connectionHandle });
    } catch (error) {
      const failed = error as { code?: number; detail?: string };

      code = failed.code ?? 0;
      refused.push(failed.detail ?? '');
    }

    await response({ code });
  });
  service.on('hang', (request) => {
    counts.hanging += 1;
    request.signal.addEventListener('abort', () => {
      counts.cancelled += 1;
    });

    return new Promise(() => {});
  });
  service.on('cancels', async (request, response) => {
    const until = performance.now() + CANCELS_PATIENCE;

    while (counts.cancelled < request.payload.atLeast && performance.now() < until) {
      await sleep(5);
    }

    return response({ count: counts.cancelled });
  });
  service.on('require', (request, response) => {
    counts.requires += 1;

    // * a Needs of no field where none is set, which its codec refuses to write (spec 17.9.7)
    return response(request.payload.needs ?? {});
  });
  service.on('getNeeds', (request, response) => {
    return response(request.payload);
  });
  service.on('updateNeeds', (request, response) => {
    return response(request.payload.needs ?? {});
  });
  server.router.on('error', () => {
    counts.reported += 1;
  });
  service.offer(server);
  await memory.start();

  const gateway = createHTTPGateway({
    ...(mount === undefined
      ? {
          createServer: (listener) => {
            return createNodeServer(listener);
          },
        }
      : {}),
    document: OPENAPI_DOCUMENT,
    problemTypes: HTTP_PROBLEM_TYPES,
    routes: HTTP_ROUTES,
    ...given,
    transport: memory,
  });
  const mounted = mount === undefined ? undefined : await mount(gateway);
  const { port } = mounted ?? (await gateway.start({ address: '127.0.0.1' }));

  return {
    counts,
    gateway,
    memory,
    port,
    refused,
    server,
    watched: async (remaining) => {
      await service.notify.watch({ remaining });
    },
    [Symbol.asyncDispose]: async () => {
      await gateway.stop();
      await mounted?.[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    },
  };
};

// ── Exchanges ─────────────────────────────────────────────────────────────────

// `spec/transcoding.json`'s exchanges, each played over real sockets against a fixture's port, as
// its bytes: the gateway on its own listener, or mounted on an application's server.

// interfaces

/** A response's field as an exchange expects it: its value, absent, or an entity tag's shape. */
type ExpectedField = string | null | { capture?: string; shape: 'etag' };

/** An entry of the file's `exchanges`. */
export interface IExchangeEntry {
  clauses: string[];
  name: string;
  options?: Record<string, unknown>;
  realTime?: true;
  steps: {
    close?: string;
    expect?: {
      body?: string;
      bodyBytes?: string;
      fields: Record<string, ExpectedField>;
      status: number;
      stream?: string;
    };
    on?: string;
    send?: { body?: string; head: string };
    until?: Record<string, number>;
  }[];
}

/** A socket of an exchange, and what came on it so far. */
export interface IPeer {
  readonly method: string;
  readonly received: Buffer[];
  readonly socket: Socket;
  /** Settles once more came, or the socket ended. */
  next: () => Promise<void>;
  isEnded: boolean;
  taken: number;
}

/** A response as a peer read it: its status, its fields by lower-case name, and its body. */
interface IRead {
  body: Buffer;
  fields: Map<string, string>;
  status: number;
}

// constants

const EXCHANGES_FILE = JSON.parse(
  readFileSync(new URL('../../../../../spec/transcoding.json', import.meta.url), 'utf8')
) as { defaults: Record<string, unknown>; exchanges: IExchangeEntry[] };

/** The file's exchanges, in its order. */
export const EXCHANGES: readonly IExchangeEntry[] = EXCHANGES_FILE.exchanges;

// how long an exchange waits for what it expects, on the real clock
const PATIENCE = 5_000;

const HEAD_END = Buffer.from('\r\n\r\n');

// helpers

/** Opens a socket to the gateway, and writes `head` and `body` on it. */
const openPeer = (port: number, { body, head }: { body: Uint8Array; head: string }): IPeer => {
  const socket = connect({ host: '127.0.0.1', port });
  const received: Buffer[] = [];
  let wake: (() => void) | undefined;
  const peer: IPeer = {
    isEnded: false,
    taken: 0,
    method: head.split(' ')[0] ?? '',
    next: () => {
      return new Promise((resolve) => {
        wake = resolve;
      });
    },
    received,
    socket,
  };
  const woken = (): void => {
    const waking = wake;

    wake = undefined;
    waking?.();
  };

  socket.on('data', (bytes) => {
    received.push(bytes);
    woken();
  });
  socket.on('close', () => {
    peer.isEnded = true;
    woken();
  });
  socket.on('error', () => {
    peer.isEnded = true;
    woken();
  });
  socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));

  return peer;
};

/** A chunked body's bytes so far, and whether its last chunk came. */
const dechunk = (bytes: Buffer): { body: Buffer; isWhole: boolean; taken: number } => {
  const parts: Buffer[] = [];
  let at = 0;

  for (;;) {
    const end = bytes.indexOf('\r\n', at);

    if (end === -1) {
      return { body: Buffer.concat(parts), isWhole: false, taken: at };
    }

    const size = Number.parseInt(bytes.subarray(at, end).toString('latin1'), 16);

    if (size === 0) {
      let trailer = end + 2;

      for (;;) {
        const lineEnd = bytes.indexOf('\r\n', trailer);

        if (lineEnd === -1) {
          return { body: Buffer.concat(parts), isWhole: false, taken: at };
        }

        if (lineEnd === trailer) {
          return { body: Buffer.concat(parts), isWhole: true, taken: lineEnd + 2 };
        }

        trailer = lineEnd + 2;
      }
    }

    if (bytes.length < end + 2 + size + 2) {
      parts.push(bytes.subarray(end + 2));

      return { body: Buffer.concat(parts), isWhole: false, taken: at };
    }

    parts.push(bytes.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
};

// definition

/**
 * What came on `peer` as one response: its head, then its body by its length, de-chunked to its
 * end, or to its socket's end; for a stream, as soon as its body begins with `stream`.
 */
export const readOn = async (
  peer: IPeer,
  { stream }: { stream?: string | undefined }
): Promise<IRead> => {
  const deadline = performance.now() + PATIENCE;

  for (;;) {
    const bytes = Buffer.concat(peer.received).subarray(peer.taken);
    const at = bytes.indexOf(HEAD_END);

    if (at !== -1) {
      const [statusLine = '', ...lines] = bytes.subarray(0, at).toString('latin1').split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const fields = new Map<string, string>();

      for (const line of lines) {
        const colon = line.indexOf(':');

        // * a field given twice is one, its values joined (RFC 9110 5.3), as the C# side reads it
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const before = fields.get(name);

        fields.set(name, before === undefined ? value : `${before}, ${value}`);
      }

      const rest = bytes.subarray(at + HEAD_END.length);
      const length = fields.get('content-length');
      const isChunked = fields.get('transfer-encoding') === 'chunked';

      if (
        peer.method === 'HEAD' ||
        (status >= 100 && status < 200) ||
        status === 204 ||
        status === 304
      ) {
        peer.taken += at + HEAD_END.length;

        return { body: Buffer.alloc(0), fields, status };
      }

      if (!isChunked && length !== undefined && rest.length >= Number(length)) {
        peer.taken += at + HEAD_END.length + Number(length);

        return { body: rest.subarray(0, Number(length)), fields, status };
      }

      if (isChunked) {
        const { body, isWhole, taken } = dechunk(rest);

        if (
          isWhole ||
          (taken > 0 && stream !== undefined && body.toString('utf8').startsWith(stream))
        ) {
          peer.taken += at + HEAD_END.length + taken;

          return { body, fields, status };
        }
      }

      if (length === undefined && !isChunked && peer.isEnded) {
        peer.taken += bytes.length;

        return { body: rest, fields, status };
      }
    }

    if (peer.isEnded && at === -1) {
      throw new Error('the socket ended before a response came');
    }

    if (performance.now() > deadline) {
      throw new Error(`no whole response within ${String(PATIENCE)} ms`);
    }

    await Promise.race([peer.next(), sleep(50)]);
  }
};

/** A gateway's options of the file's defaults and an exchange's own, by the gateway's names. */
export const gatewayOptionsOf = (entry: IExchangeEntry): Record<string, unknown> => {
  const { document, problemTypes, ...rest } = { ...EXCHANGES_FILE.defaults, ...entry.options };

  return {
    ...rest,
    ...(document === false ? { document: undefined } : {}),
    problemTypes: problemTypes ?? undefined,
  };
};

/** Plays `entry`'s steps against the fixture's port, each response held to what it expects. */
export const playExchange = async (
  entry: IExchangeEntry,
  fixture: Pick<ITranscodingFixture, 'counts' | 'port'>
): Promise<void> => {
  const peers = new Map<string, IPeer>();
  const captured = new Map<string, string>();
  const etag = `"${createHash('sha256').update(OPENAPI_DOCUMENT).digest('hex')}"`;

  try {
    for (const step of entry.steps) {
      if (step.send !== undefined && step.on !== undefined) {
        let head = step.send.head.replaceAll('{host}', `127.0.0.1:${String(fixture.port)}`);

        for (const [name, value] of captured) {
          head = head.replaceAll(`{${name}}`, value);
        }

        peers.set(
          step.on,
          openPeer(fixture.port, { body: fromHexadecimal(step.send.body ?? ''), head })
        );
      } else if (step.expect !== undefined && step.on !== undefined) {
        const peer = peers.get(step.on);

        if (peer === undefined) {
          throw new Error(`no exchange ${step.on}`);
        }

        const read = await readOn(peer, { stream: step.expect.stream });

        expect(read.status, step.on).toBe(step.expect.status);

        for (const [name, value] of Object.entries(step.expect.fields)) {
          const held = read.fields.get(name.toLowerCase());

          if (value === null) {
            expect(held, name).toBeUndefined();
          } else if (typeof value === 'string') {
            expect(held, name).toBe(value);
          } else {
            expect(held, name).toBe(etag);

            if (value.capture !== undefined && held !== undefined) {
              captured.set(value.capture, held);
            }
          }
        }

        if (step.expect.bodyBytes !== undefined) {
          expect([...read.body]).toEqual([...fromHexadecimal(step.expect.bodyBytes)]);
        } else if (step.expect.stream !== undefined) {
          expect(read.body.toString('utf8').startsWith(step.expect.stream)).toBe(true);
        } else {
          expect(read.body.toString('utf8')).toBe(
            (step.expect.body ?? '').replaceAll('{document}', OPENAPI_DOCUMENT)
          );
        }
      } else if (step.close !== undefined) {
        peers.get(step.close)?.socket.destroy();
      } else if (step.until !== undefined) {
        const deadline = performance.now() + PATIENCE;

        for (const [name, value] of Object.entries(step.until)) {
          while ((fixture.counts as Record<string, number>)[name] !== value) {
            if (performance.now() > deadline) {
              throw new Error(`${name} never reached ${String(value)}`);
            }

            await sleep(10);
          }
        }
      }
    }
  } finally {
    for (const peer of peers.values()) {
      peer.socket.destroy();
    }
  }
};
