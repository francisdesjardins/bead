import { once } from 'node:events';
import { expect } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsWebSocket, WebSocketServer, type ServerOptions } from 'ws';

/**
 * What the client and server suites share: a loopback host, raw `ws` servers with a clean stop, and
 * tracked client sockets on both implementations.
 */

export const host = '127.0.0.1';

export const startServer = async (options?: ServerOptions) => {
  const server = new WebSocketServer({ host, port: 0, ...options });
  await once(server, 'listening');
  return server;
};

export const portOf = (server: WebSocketServer) => {
  return (server.address() as AddressInfo).port;
};

// Every client gets a clean close handshake, and the server goes only once they are all gone. A
// `terminate()` resets the TCP connection instead, which leaves the global WebSocket's socket to be
// torn down after the test has moved on. Stopping a stopped server is safe: `close(cb)` still calls
// back.
export const stopServer = async (server: WebSocketServer) => {
  await Promise.all(
    Array.from(server.clients, (socket) => {
      return new Promise<void>((resolve) => {
        // A reset after the client dropped its end is expected here, and must not fail the teardown.
        socket.on('error', () => {});
        socket.once('close', () => {
          resolve();
        });
        socket.close(1000);
      });
    })
  );
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
};

/** A port nothing listens on: one a server held and let go. */
export const closedPort = async () => {
  const server = await startServer();
  const port = portOf(server);
  await stopServer(server);
  return port;
};

// Every socket a test opens, with its close, so teardown waits for each and none outlives its test.
// The close is listened for from construction rather than read from `readyState`: the global
// WebSocket reports CLOSING for good once `close()` has aborted its handshake, after its `close`.
export const sockets = new Map<WebSocket | WsWebSocket, Promise<unknown>>();

const track = <C extends typeof WebSocket | typeof WsWebSocket>(Constructor: C): C => {
  return new Proxy(Constructor, {
    construct: (target, args) => {
      const socket = Reflect.construct(target, args) as WebSocket | WsWebSocket;
      sockets.set(
        socket,
        new Promise((resolve) => {
          socket.addEventListener('close', resolve, { once: true });
        })
      );
      return socket;
    },
  });
};

export const allClosed = async () => {
  await Promise.all(sockets.values());
  sockets.clear();
};

/** Both client implementations, tracked, for a suite to run on each. */
export const IMPLEMENTATIONS = [
  ['the global WebSocket', track(WebSocket)],
  ['ws', track(WsWebSocket)],
] as const;

export interface ISpiedInterval {
  beat: () => void;
  delay: number | undefined;
  unrefs: number;
}

/** The intervals armed from now on, each beaten by hand and never by the clock, until disposed. */
export const spyIntervals = () => {
  const armed: ISpiedInterval[] = [];
  const cleared: unknown[] = [];
  const { clearInterval: realClear, setInterval: realSet } = globalThis;

  globalThis.setInterval = ((beat: () => void, delay?: number) => {
    const timer = {
      beat,
      delay,
      unrefs: 0,
      unref: () => {
        timer.unrefs += 1;

        return timer;
      },
    };

    armed.push(timer);

    return timer;
  }) as unknown as typeof realSet;
  globalThis.clearInterval = (timer: unknown) => {
    cleared.push(timer);
  };

  return {
    armed,
    cleared,
    [Symbol.dispose]: () => {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
};

/**
 * Resolves once no TCP socket is left open in the process. A `fetch` keeps its socket alive after its
 * answer, and one still closing as a test worker exits trips an assertion of libuv on Windows; a
 * suite that fetches waits on this last, once its servers have stopped.
 */
export const tcpSocketsClosed = async () => {
  await expect
    .poll(() => {
      return process.getActiveResourcesInfo().filter((resource) => {
        return resource === 'TCPSocketWrap';
      }).length;
    })
    .toBe(0);
};
