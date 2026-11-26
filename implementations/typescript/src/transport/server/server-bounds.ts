// ── Server bounds ─────────────────────────────────────────────────────────────

// dependencies

import type { IClock, TimeoutId } from '../shared/clock';
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
  keepAliveTimeout?: number | undefined;
  requestTimeout?: number | undefined;
}

/** The part of an HTTP/2 stream an idle bound reads: Node's `Http2Stream`. */
export interface IBoundStreamLike {
  once(event: 'close', listener: () => void): unknown;
}

/** The part of an HTTP/2 session an idle bound holds: Node's `Http2Session`. */
export interface ISessionLike {
  close(): unknown;
  destroy(): unknown;
  on(event: 'stream', listener: (stream: IBoundStreamLike) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/** The part of a socket a TLS server hands its `connection` and `secureConnection`. */
export interface IPeerSocketLike {
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  destroy(): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * The part of Node's TLS server whose handshakes an idle bound times: `node:https`'s, and
 * `node:http2`'s secure one.
 */
export interface IHandshakeServerLike {
  on(
    event: 'connection' | 'secureConnection',
    listener: (socket: IPeerSocketLike) => void
  ): unknown;
  setSecureContext(context: unknown): unknown;
}

/** What an idle bound is held to: its time, and the clock its timers run on. */
export interface IIdleBoundOptions {
  /** How long, in milliseconds, a TLS handshake may take, or a session go with no answer. */
  headersTimeout: number;
  /** Its stack's platform clock, whatever clock the server is given. */
  platform: IClock;
}

/** The part of a socket Node hands its server's `clientError`: Node's `net.Socket`. */
export interface IClientErrorSocketLike {
  readonly writable: boolean;
  destroy(error?: Error): unknown;
  write(data: string): unknown;
}

/** The part of Node's HTTP server that tells its parser's refusals: its `clientError`. */
export interface IClientErrorServerLike {
  on(
    event: 'clientError',
    listener: (error: Error, socket: IClientErrorSocketLike) => void
  ): unknown;
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
 * The bytes a WebSocket server holds of messages partway, by default, across its connections:
 * 256 MiB (spec 15.12).
 */
export const MESSAGE_BYTES_BUDGET = 268_435_456;

/** The frames of one WebSocket message, by default, the first among them (spec 15.3). */
export const MAXIMUM_MESSAGE_FRAMES = 16_384;

/** How long a WebSocket message comes, by default, before its rate is held: 5 seconds. */
export const BODY_GRACE_PERIOD = 5_000;

/**
 * The slowest a WebSocket message may come, by default, once its grace passed: 240 bytes of
 * payload a second, Kestrel's `MinRequestBodyDataRate` (spec 15.12).
 */
export const MINIMUM_BODY_BYTES_PER_SECOND = 240;

/**
 * How long a socket closed in stages reads on and drops what still comes once its write side ended,
 * unless its client closes first: 2 seconds, as Apache httpd lingers (RFC 9112 §9.6).
 */
export const LINGER_MILLISECONDS = 2_000;

// how often what waits for a socket, and a server's heads, are judged
const CHECK_MILLISECONDS = 1_000;

// what Node's HTTP server answers each refusal of its parser's with, by its code, 400 for any
// other, as its `socketOnError` writes it when no listener hears `clientError`
const PARSER_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  ERR_HTTP_REQUEST_TIMEOUT: '408 Request Timeout',
  HPE_CHUNK_EXTENSIONS_OVERFLOW: '413 Payload Too Large',
  HPE_HEADER_OVERFLOW: '431 Request Header Fields Too Large',
});

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

// a timer that keeps no process alive: a browser's has no `unref`
const unrefOf = (timer: TimeoutId): TimeoutId => {
  (timer as { unref?: () => unknown }).unref?.();

  return timer;
};

/**
 * Sets the bounds Node's HTTP server holds a request's head to, before it listens: its head within
 * `headersTimeout`, judged each second; a kept-alive socket's idle span, its `keepAliveTimeout`,
 * the same time (spec 15.12); and no time for the whole request, a body's rate being the
 * transport's own. A server without them, `node:http2`'s in clear, is left as it is; its secure one
 * with `allowHTTP1` has them, and is set alike.
 */
export const boundHeadOf = (server: IHeadBoundServerLike, headersTimeout: number): void => {
  if (typeof server.headersTimeout !== 'number') {
    return;
  }

  server.headersTimeout = headersTimeout;
  server.keepAliveTimeout = headersTimeout;
  server.requestTimeout = 0;
  server.connectionsCheckingInterval = CHECK_MILLISECONDS;
};

/**
 * Holds an HTTP/2 session with no answer under way to `headersTimeout` (spec 15.12): its time runs
 * from the call, stops at each stream it opens, and runs again in full once its last stream
 * closes, a stream reset among them; a PING or a SETTINGS moves nothing. Past its time, the
 * session closes, its GOAWAY Node's own, and is destroyed {@link LINGER_MILLISECONDS} later unless
 * it closed by then. Its timers run on `platform` and keep no process alive.
 */
export const boundSessionOf = (
  session: ISessionLike,
  { headersTimeout, platform }: IIdleBoundOptions
): void => {
  // ! each stream's end is heard once, on every path: one left open keeps the session for ever
  const open = new Set<IBoundStreamLike>();
  let idle: TimeoutId | undefined;
  let linger: TimeoutId | undefined;
  let isClosed = false;

  const arm = (): void => {
    idle = unrefOf(
      platform.setTimeout(() => {
        idle = undefined;
        session.close();
        linger = unrefOf(
          platform.setTimeout(() => {
            linger = undefined;
            session.destroy();
          }, LINGER_MILLISECONDS)
        );
      }, headersTimeout)
    );
  };

  session.on('stream', (stream) => {
    open.add(stream);
    platform.clearTimeout(idle);
    idle = undefined;
    stream.once('close', () => {
      open.delete(stream);

      if (open.size === 0 && !isClosed && linger === undefined) {
        arm();
      }
    });
  });
  session.once('close', () => {
    isClosed = true;
    platform.clearTimeout(idle);
    platform.clearTimeout(linger);
    idle = undefined;
    linger = undefined;
  });
  arm();
};

/**
 * Holds each TLS handshake on `server` to `headersTimeout` (spec 15.12): a socket whose handshake
 * has not ended by then is destroyed, nothing written. A socket is told from its `connection` to
 * its `secureConnection` by its peer's address and port, which no two open sockets share. A server
 * that is not under TLS, which has no `setSecureContext`, is left as it is. Its timers run on
 * `platform` and keep no process alive.
 */
export const boundHandshakeOf = (
  server: object,
  { headersTimeout, platform }: IIdleBoundOptions
): void => {
  if (typeof (server as Partial<IHandshakeServerLike>).setSecureContext !== 'function') {
    return;
  }

  const secure = server as IHandshakeServerLike;
  const pending = new Map<string, TimeoutId>();

  const keyOf = ({ remoteAddress, remotePort }: IPeerSocketLike): string | undefined => {
    return remoteAddress === undefined || remotePort === undefined
      ? undefined
      : `${remoteAddress}|${String(remotePort)}`;
  };

  const settle = (key: string): void => {
    platform.clearTimeout(pending.get(key));
    pending.delete(key);
  };

  secure.on('connection', (socket) => {
    const key = keyOf(socket);

    // * a socket gone before it is read has no peer to wait for
    if (key === undefined) {
      return;
    }

    const timer = unrefOf(
      platform.setTimeout(() => {
        pending.delete(key);
        socket.destroy();
      }, headersTimeout)
    );

    pending.set(key, timer);
    // its own timer alone: once it is gone, another socket may come from its address and port
    socket.once('close', () => {
      if (pending.get(key) === timer) {
        settle(key);
      }
    });
  });
  secure.on('secureConnection', (socket) => {
    const key = keyOf(socket);

    if (key !== undefined) {
      settle(key);
    }
  });
};

/**
 * Lets the answer under way on a socket end when Node's parser refuses what comes behind a request
 * that asked its connection closed, `HPE_CLOSED_CONNECTION`: Node would write a bare 400 in its
 * place, its request already handed on, where the answer goes and Node closes its socket behind it
 * (RFC 9112 §9.6). Every other refusal of the parser's is answered as Node answers it. A server
 * without a head's bounds, `node:http2`'s, is left as it is.
 */
export const answerBeforeClose = (server: IHeadBoundServerLike & IClientErrorServerLike): void => {
  if (typeof server.headersTimeout !== 'number') {
    return;
  }

  server.on('clientError', (error, socket) => {
    // ! Node's own: the response its socket writes, `null` once none is under way
    const answer = (socket as { _httpMessage?: { _headerSent?: boolean } | null })._httpMessage;
    const code = (error as { code?: unknown }).code;
    const isUnderWay = answer !== undefined && answer !== null;

    if (code === 'HPE_CLOSED_CONNECTION' && isUnderWay) {
      return;
    }

    // * a refusal written where no answer began on the socket, then its close, as Node's own
    if (socket.writable && (!isUnderWay || answer._headerSent !== true)) {
      const refusal = typeof code === 'string' ? PARSER_REFUSALS[code] : undefined;

      socket.write(`HTTP/1.1 ${refusal ?? '400 Bad Request'}\r\nConnection: close\r\n\r\n`);
    }

    socket.destroy(error);
  });
};

/**
 * Closes `socket` in stages once the answer written on it ends (RFC 9112 §9.6): Node ends its write
 * side, and destroys it once that side is flushed, which resets a client still sending and may
 * erase the answer it has not read yet. So it reads on, dropping what comes, until its client
 * closes or {@link LINGER_MILLISECONDS} pass, on `clock`, its stack's platform clock, which bounds
 * the platform's own close.
 */
export const lingerOn = (
  socket: ILingeringSocketLike,
  response: { on(event: 'finish', listener: () => void): unknown },
  { clock }: { clock: IClock }
): void => {
  response.on('finish', () => {
    // ! Node armed the socket's destroy on its `finish`, once as it is written; `once` keeps the
    // listener's own function, so it is found and taken off
    // oxlint-disable-next-line typescript/unbound-method -- found by identity, never called here
    socket.removeListener('finish', socket.destroy);

    const timer = clock.setTimeout(() => {
      socket.destroy();
    }, LINGER_MILLISECONDS);

    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
    socket.once('end', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      clock.clearTimeout(timer);
    });
  });
};

// definition

/**
 * Holds what waits for one socket to a pace, as Kestrel holds a response to its
 * `MinResponseDataRate` (spec 15.12): each envelope of _S_ bytes handed moves the deadline to the
 * later of now plus the longer of `sendGracePeriod` and _S_ at `minimumSendBytesPerSecond`, and the
 * deadline before plus that time. While `unsent` says something waits, it is judged each second,
 * and `late` hears once it waits past its deadline; nothing waiting, no deadline runs. Its timer
 * runs on `clock`, its stack's platform clock, whatever clock the server is given, since it bounds
 * what the platform's socket does, as the heartbeat does (decision 0011); it keeps no process
 * alive. A rate of 0 holds none.
 */
export const createSendPace = (
  { clock, late, unsent }: { clock: IClock; late: () => void; unsent: () => number },
  { minimumSendBytesPerSecond, sendGracePeriod }: ISendPaceOptions
): ISendPace => {
  let deadline: number | undefined;
  let timer: TimeoutId | undefined;

  const stop = (): void => {
    clock.clearInterval(timer);
    timer = undefined;
    deadline = undefined;
  };

  const check = (): void => {
    if (unsent() === 0) {
      return (stop(), undefined);
    }

    if (deadline !== undefined && clock.performance.now() > deadline) {
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

      const now = clock.performance.now();
      const takes = (bytes * 1_000) / minimumSendBytesPerSecond;
      const earliest = now + Math.max(sendGracePeriod, takes);

      deadline = deadline === undefined ? earliest : Math.max(earliest, deadline + takes);

      if (timer === undefined) {
        timer = clock.setInterval(check, CHECK_MILLISECONDS);
        (timer as { unref?: () => unknown }).unref?.();
      }
    },
    stop,
  };
};
