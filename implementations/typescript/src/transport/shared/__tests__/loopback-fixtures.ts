// ── Loopback fixtures ─────────────────────────────────────────────────────────

// What the twins of a client's connect to the loopback share (spec 13.4): a resolver that answers
// a localhost name elsewhere, a proxy that takes every request, and a Node where undici does not
// resolve.

// dependencies

import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import type { loopbackLookup } from '../loopback';

// interfaces

// the part of `node:dns` a test replaces: its lookup, of the shape `loopbackLookup` has
interface IDnsLike {
  lookup: typeof loopbackLookup;
}

/** What a request that reached a server or a proxy said: its first line and its fields. */
export interface IHeard {
  readonly authorization: string | undefined;
  readonly host: string | undefined;
  readonly line: string;
}

// constants

/** A localhost name, which no resolver may be asked for. */
export const PROBE = 'bead-probe.localhost';

/** An address of TEST-NET-1 (RFC 5737), where nothing answers: a resolver's answer for a localhost name. */
export const ELSEWHERE = '192.0.2.7';

// helpers

// whether `hostname` is a localhost name, a trailing dot or not, as the replaced resolver answers it
const isLocalhost = (hostname: string): boolean => {
  const name = hostname.toLowerCase().replace(/\.$/u, '');

  return name === 'localhost' || name.endsWith('.localhost');
};

// definition

/**
 * Node's own `dns.lookup` replaced, until disposed, by one that answers a localhost name with
 * `answer` and notes it, and hands any other name on: what `net.connect`, the global `fetch` and
 * `WebSocket` and `ws` all ask.
 */
export const replaceResolver = (answer: string = ELSEWHERE): Disposable & { asked: string[] } => {
  const dns = process.getBuiltinModule('node:dns') as unknown as IDnsLike;
  const { lookup } = dns;
  const asked: string[] = [];

  // oxlint-disable-next-line max-params, bead/options-last -- dns.lookup's own shape, which Node calls
  dns.lookup = (hostname, options, callback) => {
    if (!isLocalhost(hostname)) {
      lookup(hostname, options, callback);

      return;
    }

    asked.push(hostname);

    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options.all === true;

    queueMicrotask(() => {
      if (all) {
        done?.(null, [{ address: answer, family: 4 }]);
      } else {
        done?.(null, answer, 4);
      }
    });
  };

  return {
    asked,
    [Symbol.dispose]: () => {
      dns.lookup = lookup;
    },
  };
};

/**
 * A Node where the package undici does not resolve, until disposed: its module resolution, which
 * `process.getBuiltinModule('node:module')` reaches, finds none.
 */
export const withoutUndici = (): Disposable => {
  const own = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');
  const getBuiltinModule = process.getBuiltinModule.bind(process);

  process.getBuiltinModule = (id: string) => {
    return id === 'node:module'
      ? {
          createRequire: () => {
            return {
              resolve: () => {
                throw new Error('Cannot find module undici');
              },
            };
          },
        }
      : getBuiltinModule(id);
  };

  return {
    [Symbol.dispose]: () => {
      if (own !== undefined) {
        Object.defineProperty(process, 'getBuiltinModule', own);
      }
    },
  };
};

/**
 * A server on 127.0.0.1 that notes each request and each upgrade it is sent, answers a request as
 * `answer` does, 404 by default, and refuses every upgrade with 403.
 */
export const startHeard = async (
  answer?: (request: IncomingMessage) => { headers?: Record<string, string>; status: number }
) => {
  const heard: IHeard[] = [];
  const noted = (request: IncomingMessage): void => {
    heard.push({
      authorization: request.headers.authorization,
      host: request.headers.host,
      line: `${request.method ?? ''} ${request.url ?? ''}`,
    });
  };
  const server = createHttpServer((request, reply) => {
    noted(request);
    request.resume();

    const { headers, status } = answer?.(request) ?? { status: 404 };

    reply.writeHead(status, headers);
    reply.end();
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    noted(request);
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    heard,
    port: (server.address() as AddressInfo).port,
    [Symbol.asyncDispose]: () => {
      server.closeAllConnections();

      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

/**
 * The platform's proxy, until disposed: a listener on 127.0.0.1 that notes the first line of each
 * request it is sent and answers 502, which the global dispatcher, the global `fetch`'s and
 * `WebSocket`'s, sends every request through, as Node's own does under `NODE_USE_ENV_PROXY` and
 * `HTTP_PROXY`.
 */
export const startPlatformProxy = async () => {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const proxy = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {
      // a client that gave up
    });
    socket.once('data', (data) => {
      received.push(data.toString('latin1').split('\r\n')[0] ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    });
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  const previous = getGlobalDispatcher();
  const dispatcher = new ProxyAgent(
    `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
  );

  setGlobalDispatcher(dispatcher);

  return {
    received,
    [Symbol.asyncDispose]: async () => {
      setGlobalDispatcher(previous);
      await dispatcher.close();

      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        proxy.close(() => {
          resolve();
        });
      });
    },
  };
};

/** The outcome of `run`: what it resolved with, or the reason it rejected with. */
export const settledOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  return run().then(
    (value) => {
      return value;
    },
    (reason: unknown) => {
      return reason;
    }
  );
};
