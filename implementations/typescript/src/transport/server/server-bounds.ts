// ── Server bounds ─────────────────────────────────────────────────────────────

// dependencies

import { PLATFORM_CLOCK, type TimeoutId } from '../shared/clock';
import { GenericError, ProgrammerError } from '../shared/errors';

// interfaces

/**
 * What waits for one socket, held to a pace: told of each envelope handed to the socket, and
 * stopped once the socket is gone.
 */
export interface ISendPace {
  /** An envelope of `bytes` handed to the socket: its deadline moved, its check armed. */
  hand(bytes: number): void;
  /** Nothing more is judged: the socket is gone, or done. */
  stop(): void;
}

/** What a socket's pace is held to: the slowest it may take what waits, past a grace. */
export interface ISendPaceOptions {
  /** The slowest, in bytes a second, a socket may take what waits for it; 0 holds none. */
  minimumSendBytesPerSecond: number;
  /** The least time, in milliseconds, an envelope is given to be taken. */
  sendGracePeriod: number;
}

/**
 * The part of Node's HTTP server whose own bounds hold a request's head, which `node:http`'s and
 * `node:https`'s have and `node:http2`'s has not.
 */
export interface IHeadBoundServerLike {
  connectionsCheckingInterval?: number | undefined;
  headersTimeout?: number | undefined;
  requestTimeout?: number | undefined;
}

/**
 * The part of a socket an answer written before its request's body is whole closes in stages:
 * Node's `net.Socket`.
 */
export interface ILingeringSocketLike {
  destroy(): unknown;
  once(event: 'close' | 'end', listener: () => void): unknown;
  removeListener(event: 'finish', listener: () => unknown): unknown;
}

// constants

/** The connections a server holds at once, by default, at an HTTP or a WebSocket address. */
export const MAXIMUM_CONNECTIONS = 10_000;

/** The connections one address holds at once, by default, at an HTTP or a WebSocket address. */
export const MAXIMUM_CONNECTIONS_PER_ADDRESS = 64;

/**
 * The slowest, by default, a socket may take what waits for it once its grace passed: 240 bytes a
 * second, Kestrel's `MinResponseDataRate` (spec 15.12).
 */
export const MINIMUM_SEND_BYTES_PER_SECOND = 240;

/** The least time, by default, an envelope is given to be taken by its socket: 5 seconds. */
export const SEND_GRACE_PERIOD = 5_000;

/** How long, by default, a request's head may take to come whole: 30 seconds (spec 15.12). */
export const HEADERS_TIMEOUT = 30_000;

/**
 * How long a socket closed in stages reads on and drops what still comes once its write side ended,
 * unless its client closes first: 2 seconds, as Apache httpd lingers (RFC 9112 §9.6).
 */
export const LINGER_MILLISECONDS = 2_000;

// how often what waits for a socket, and a server's heads, are judged
const CHECK_MILLISECONDS = 1_000;

// helpers

/**
 * `value` held as a count: a whole number above 0, or from 0 where `mayBeNone` says 0 holds none;
 * any other is a {@link ProgrammerError} naming the option `name`.
 */
export const assertCount = (
  name: string,
  { mayBeNone = false, value }: { mayBeNone?: boolean; value: unknown }
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < (mayBeNone ? 0 : 1)) {
    throw new ProgrammerError(
      `${name} is a whole number${mayBeNone ? '' : ' above 0'}, not ${String(value)}`
    );
  }

  return value as number;
};

/**
 * A connection dropped behind a bound, as its server reports it on `error` (spec 15.1, 15.12): its
 * handle, then `why`, which names the bound in the spec's spelling and its value.
 */
export const droppedOf = (connectionHandle: string, why: string): GenericError => {
  return new GenericError(`${connectionHandle} is dropped: ${why}`);
};

/**
 * Why a connection whose socket held what waits for it past its deadline is dropped, naming the
 * pace's bounds in the spec's spelling and their values (spec 15.12).
 */
export const lateOf = ({
  minimumSendBytesPerSecond,
  sendGracePeriod,
}: ISendPaceOptions): string => {
  return `what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond ${String(minimumSendBytesPerSecond)} past sendGracePeriod ${String(sendGracePeriod)} ms`;
};

/**
 * Sets the bounds Node's HTTP server holds a request's head to, before it listens: its head within
 * `headersTimeout`, judged each second, and no time for the whole request, a body's rate being the
 * transport's own. A server without them, `node:http2`'s, is left as it is.
 */
export const boundHeadOf = (server: IHeadBoundServerLike, headersTimeout: number): void => {
  if (typeof server.headersTimeout !== 'number') {
    return;
  }

  server.headersTimeout = headersTimeout;
  server.requestTimeout = 0;
  server.connectionsCheckingInterval = CHECK_MILLISECONDS;
};

/**
 * Closes `socket` in stages once the answer written on it ends (RFC 9112 §9.6): Node ends its write
 * side, and destroys it once that side is flushed, which resets a client still sending and may
 * erase the answer it has not read yet. So it reads on, dropping what comes, until its client
 * closes or {@link LINGER_MILLISECONDS} pass, on the platform's clock, which bounds the platform's
 * own close.
 */
export const lingerOn = (
  socket: ILingeringSocketLike,
  response: { on(event: 'finish', listener: () => void): unknown }
): void => {
  response.on('finish', () => {
    // ! Node armed the socket's destroy on its `finish`, once as it is written; `once` keeps the
    // listener's own function, so it is found and taken off
    // oxlint-disable-next-line typescript/unbound-method -- found by identity, never called here
    socket.removeListener('finish', socket.destroy);

    const timer = PLATFORM_CLOCK.setTimeout(() => {
      socket.destroy();
    }, LINGER_MILLISECONDS);

    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
    socket.once('end', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      PLATFORM_CLOCK.clearTimeout(timer);
    });
  });
};

// definition

/**
 * Holds what waits for one socket to a pace, as Kestrel holds a response to its
 * `MinResponseDataRate` (spec 15.12): each envelope of _S_ bytes handed moves the deadline to the
 * later of now plus the longer of `sendGracePeriod` and _S_ at `minimumSendBytesPerSecond`, and the
 * deadline before plus that time. While `unsent` says something waits, it is judged each second,
 * and `late` hears once it waits past its deadline; nothing waiting, no deadline runs. Its timer is
 * the platform's, whatever clock the server is given, since it bounds what the platform's socket
 * does, as the heartbeat does (decision 0011); it keeps no process alive. A rate of 0 holds none.
 */
export const createSendPace = (
  { late, unsent }: { late: () => void; unsent: () => number },
  { minimumSendBytesPerSecond, sendGracePeriod }: ISendPaceOptions
): ISendPace => {
  let deadline: number | undefined;
  let timer: TimeoutId | undefined;

  const stop = (): void => {
    PLATFORM_CLOCK.clearInterval(timer);
    timer = undefined;
    deadline = undefined;
  };

  const check = (): void => {
    if (unsent() === 0) {
      return (stop(), undefined);
    }

    if (deadline !== undefined && PLATFORM_CLOCK.performance.now() > deadline) {
      stop();
      late();
    }

    return undefined;
  };

  return {
    hand: (bytes) => {
      if (minimumSendBytesPerSecond === 0) {
        return;
      }

      const now = PLATFORM_CLOCK.performance.now();
      const takes = (bytes * 1_000) / minimumSendBytesPerSecond;
      const earliest = now + Math.max(sendGracePeriod, takes);

      deadline = deadline === undefined ? earliest : Math.max(earliest, deadline + takes);

      if (timer === undefined) {
        timer = PLATFORM_CLOCK.setInterval(check, CHECK_MILLISECONDS);
        (timer as { unref?: () => unknown }).unref?.();
      }
    },
    stop,
  };
};
