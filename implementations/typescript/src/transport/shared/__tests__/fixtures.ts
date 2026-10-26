import { ADDRCONFIG } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { expect } from '@playwright/test';
import { createClock } from '@sinonjs/fake-timers';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsWebSocket, WebSocketServer, type ServerOptions } from 'ws';
import { type IClock, LONGEST_TIMER, type TimeoutId } from '../clock';

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

/**
 * What a test's listeners throw meanwhile, which reaches Node as an uncaught exception: taken from
 * the runner's own listeners, which would fail the test, and given back to them once it ends.
 */
export const trapUncaught = (): Disposable & { thrown: unknown[] } => {
  const thrown: unknown[] = [];
  const runners = process.rawListeners('uncaughtException');
  const trap = (error: unknown): void => {
    thrown.push(error);
  };

  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', trap);

  return {
    thrown,
    [Symbol.dispose]: () => {
      process.off('uncaughtException', trap);

      for (const runner of runners) {
        process.on('uncaughtException', runner as (error: Error) => void);
      }
    },
  };
};

/** Both client implementations, tracked, for a suite to run on each. */
export const IMPLEMENTATIONS = [
  ['the global WebSocket', track(WebSocket)],
  ['ws', track(WsWebSocket)],
] as const;

/** A timer armed on a test clock: its delay, and the handle it gave. */
export interface IArmedTimer {
  delay: number;
  handle: TimeoutId;
}

// a timer's delay or period as Bead arms one: from a millisecond to the longest a timer waits
const armedDelayOf = (delay: number | undefined): number => {
  if (delay === undefined || !Number.isFinite(delay) || delay < 1 || delay > LONGEST_TIMER) {
    throw new Error(
      `a test clock arms a timer for 1 to ${String(LONGEST_TIMER)} milliseconds, as Bead does, not ${String(delay)}`
    );
  }

  return delay;
};

/**
 * A test's clock: `@sinonjs/fake-timers`' `createClock()`, never installed on the globals, which Bead
 * runs on once given it as `clock`, and which the test advances with `tickAsync`, from due to due.
 * A timer is due in whole milliseconds, a fraction dropped, as `fake-timers` counts it.
 *
 * It refuses what Bead never arms, with an `Error` that names it: a timer or a period that is not a
 * finite number of milliseconds from 1 to {@link LONGEST_TIMER}, and a `tickAsync` while another is
 * under way, which would move the clock back. It keeps each timer armed in `armed`, each handle
 * cleared in `cleared`, and counts each reading Bead takes, wall and monotonic, in `readings`.
 */
export const createTestClock = (now?: number) => {
  const clock = createClock(now);
  const armed: IArmedTimer[] = [];
  const cleared: unknown[] = [];
  const readings = { monotonic: 0, wall: 0 };
  // the clock as Bead reads it, its two readings counted
  const read: Pick<IClock, 'Date' | 'performance'> = clock;
  const wallNow = read.Date.now.bind(read.Date);
  const monotonicNow = read.performance.now.bind(read.performance);

  read.Date.now = () => {
    readings.wall += 1;

    return wallNow();
  };
  read.performance.now = () => {
    readings.monotonic += 1;

    return monotonicNow();
  };
  const {
    clearInterval: clearEvery,
    clearTimeout: clear,
    setInterval: every,
    setTimeout: set,
    tickAsync: tick,
  } = clock;
  let isAdvancing = false;

  clock.setTimeout = (callback, given) => {
    const delay = armedDelayOf(given);
    const handle = set(callback, delay);

    armed.push({ delay, handle });

    return handle;
  };
  clock.setInterval = (callback, given) => {
    const delay = armedDelayOf(given);
    const handle = every(callback, delay);

    armed.push({ delay, handle });

    return handle;
  };
  clock.tickAsync = async (time) => {
    if (isAdvancing) {
      throw new Error(
        'a test clock advances once at a time: an advance within another would move it back'
      );
    }

    isAdvancing = true;

    try {
      return await tick(time);
    } finally {
      isAdvancing = false;
    }
  };
  // a clear of none, which Bead makes of a timer it never armed, clears nothing to read
  clock.clearTimeout = (handle) => {
    if (handle !== undefined) {
      cleared.push(handle);
    }

    clear(handle);
  };
  clock.clearInterval = (handle) => {
    if (handle !== undefined) {
      cleared.push(handle);
    }

    clearEvery(handle);
  };

  return Object.assign(clock, { armed, cleared, readings });
};

export type TestClock = ReturnType<typeof createTestClock>;

/** The delays of the timers armed on `clock` and neither fired nor cleared, by when they are due. */
export const delaysOn = (clock: TestClock): number[] => {
  return [...(clock.timers?.values() ?? [])]
    .toSorted((a, b) => {
      return (a.callAt ?? 0) - (b.callAt ?? 0) || (a.id ?? 0) - (b.id ?? 0);
    })
    .map(({ delay }) => {
      return delay ?? 0;
    });
};

/**
 * When the timers armed on `clock` and neither fired nor cleared are due, in milliseconds from its
 * reading, soonest first: a periodic timer's next due, which `until` waits for before an advance.
 */
export const duesOn = (clock: TestClock): number[] => {
  return [...(clock.timers?.values() ?? [])]
    .map(({ callAt = clock.now }) => {
      return callAt - clock.now;
    })
    .toSorted((a, b) => {
      return a - b;
    });
};

/** The timers `run` arms on `clock`, and the handles it clears there, as it runs. */
export const timersBy = (clock: TestClock, run: () => void) => {
  const [armedFrom, clearedFrom] = [clock.armed.length, clock.cleared.length];

  run();

  return { armed: clock.armed.slice(armedFrom), cleared: clock.cleared.slice(clearedFrom) };
};

/** As {@link timersBy}, for a `run` that waits: the timers until it settles. */
export const timersUntil = async (clock: TestClock, run: () => Promise<unknown>) => {
  const [armedFrom, clearedFrom] = [clock.armed.length, clock.cleared.length];

  await run();

  return { armed: clock.armed.slice(armedFrom), cleared: clock.cleared.slice(clearedFrom) };
};

/** Whether a handle a test clock gave keeps a process alive: an `unref`ed one does not. */
export const hasRef = (handle: TimeoutId): boolean => {
  return (handle as { hasRef: () => boolean }).hasRef();
};

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
 * The loopback addresses a client reaches by `localhost` here, as the C# side's `Addresses` reads
 * them: `::1` only where the name resolves to it under `ADDRCONFIG`, as a connect resolves it, which
 * a host or a container with no IPv6 address configured drops.
 */
export const reachedByLocalhost = async (): Promise<string[]> => {
  const resolved = await lookup('localhost', { all: true, hints: ADDRCONFIG });

  return resolved.some(({ address }) => {
    return address === '::1';
  })
    ? ['127.0.0.1', '::1']
    : ['127.0.0.1'];
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
