// ── Loopback ──────────────────────────────────────────────────────────────────

// dependencies

import type { Socket } from 'node:net';
import { type IClock, LONGEST_TIMER, PLATFORM_CLOCK, type TimeoutId } from './clock';
import { toError } from './errors';
import { noop } from './noop';
import { isLoopbackHost } from './secure';
import { builtinOf, type INodeTlsOptions } from './tls';

// interfaces

/** A loopback address and its family. */
interface ILoopbackAddress {
  address: string;
  family: 4 | 6;
}

/** What a race of the loopback's two addresses takes: its bound, and the seams of a test. */
export interface IRaceLoopbackOptions {
  /**
   * One attempt: a socket connecting `address` at `port`. Node's `net.connect`, its high-water mark
   * 64 KiB as undici's own, by default.
   */
  attempt?: ((address: string, port: number) => Socket) | undefined;
  /** The clock its attempt delay and its timeout run on: the platform's by default. */
  clock?: IClock | undefined;
  /** Gives the race up: every attempt ended, the race rejected with the signal's reason. */
  signal?: AbortSignal | null | undefined;
  /**
   * How long the race waits, in milliseconds, for an attempt to connect: every attempt still open is
   * ended then, and counted as Node's `connect ETIMEDOUT`. `Infinity` waits for ever.
   */
  timeout: number;
}

/** What undici's connector is asked to connect: the parts of the URL it reaches, among others. */
export interface IUndiciConnectOptions {
  readonly [key: string]: unknown;
  readonly hostname: string;
  readonly httpSocket?: Socket | undefined;
  readonly port: number | string;
  readonly protocol: string;
}

/** What undici's connector answers with: an error, or the socket it connected. */
// oxlint-disable-next-line max-params, bead/options-last -- undici's own callback, which it calls
type Connected = (error: Error | null, socket: Socket | null) => void;

/** undici's `connect` function, which its `Agent` takes and `buildConnector` builds. */
// oxlint-disable-next-line bead/options-last -- undici's own shape, which it calls
export type UndiciConnector = (options: IUndiciConnectOptions, callback: Connected) => void;

/** What `http`'s `createConnection` is handed by `ws`: its URL's parts and its TLS options. */
interface IWsConnectOptions {
  readonly [key: string]: unknown;
  readonly defaultPort?: number | undefined;
  readonly host?: string | undefined;
  readonly port?: number | string | undefined;
  readonly servername?: string | undefined;
}

/** What `http`'s `createConnection` answers with, in its callback form: an error, or the socket. */
type Created = (error: Error | null, socket?: Socket) => void;

/** `http`'s `createConnection` in its callback form, which `ws` hands its request. */
// oxlint-disable-next-line bead/options-last -- http's own shape, which it calls
export type CreateConnection = (options: IWsConnectOptions, oncreate: Created) => undefined;

// the part of `node:net` a race connects by
interface INetLike {
  connect(options: { highWaterMark: number; host: string; port: number }): Socket;
  isIP(host: string): number;
}

// the part of `node:tls` a race's socket is secured by
interface ITlsLike {
  connect(options: object): Socket;
}

/** What a dispatcher of undici's dispatches a request by: its options, and the handler of its outcome. */
type Dispatch = (options: object, handler: object) => boolean;

/** An `Agent` of the package undici's, which a client closes as it is dropped. */
export interface IUndiciAgent {
  close(): Promise<void>;
  compose(interceptor: (dispatch: Dispatch) => Dispatch): IUndiciAgent;
}

/** A dispatcher over a client's agent, and the error each request it dispatched failed with. */
export interface IUndiciWatched {
  readonly dispatcher: IUndiciAgent;
  readonly failures: readonly unknown[];
}

/**
 * The part of the package undici a client in Node reaches: its own `fetch` and `WebSocket`, and an
 * `Agent` of the client's, which each takes as its dispatcher.
 */
export interface IUndici {
  Agent: new (options: { connect: UndiciConnector }) => IUndiciAgent;
  buildConnector: (options: INodeTlsOptions) => UndiciConnector;
  fetch: (url: string, init: { dispatcher: IUndiciAgent }) => Promise<unknown>;
  WebSocket: new (url: string, init: { dispatcher: IUndiciAgent; protocols: string[] }) => unknown;
}

/** undici loaded, and the agent of the client that drew it. */
export interface IUndiciDrawn {
  readonly agent: IUndiciAgent;
  readonly undici: IUndici;
}

/**
 * undici and an `Agent` of one client's, drawn at its first connect that needs them and again after
 * {@link IUndiciDialer.close} closed it.
 */
export interface IUndiciDialer {
  /** Closes its agent once `after` settled, what the agent carries among it. */
  close(after: Promise<void>): void;
  /** undici and the client's agent; none where the package undici does not resolve. */
  draw(): Promise<IUndiciDrawn | undefined>;
}

// constants

/**
 * How long a connect to a localhost name waits on `127.0.0.1` before it tries `::1` beside it, the
 * first attempt kept: RFC 8305 §5's Connection Attempt Delay, as every side races the two, every
 * attempt kept until one connects (spec 13.4).
 */
export const LOOPBACK_ATTEMPT_DELAY = 250;

/** How long undici's connector waits for a localhost name's race: 10 seconds, undici's own default. */
export const LOOPBACK_CONNECT_TIMEOUT = 10_000;

// the high-water mark of an attempt's socket: 64 KiB, as undici's connector sets it in the clear
const HIGH_WATER_MARK = 65_536;

// a socket's keep-alive once raced in the clear, as undici's connector sets it: 60 seconds
const KEEP_ALIVE = 60_000;

// ! IPv4 first, against RFC 6724's default policy: a server on its defaults listens on 127.0.0.1,
// and a server given 127.0.0.1 alone is then never pre-empted by a process on [::1] (spec 15.12)
const LOOPBACK_ADDRESSES: readonly ILoopbackAddress[] = Object.freeze([
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
]);

// ! a specifier no bundler reads, so that no page's bundle carries undici, which a page never loads
const UNDICI = 'undici';

// definition

/**
 * Whether `host` is a localhost name: `localhost`, or a name that ends in `.localhost`, read as the
 * URL Standard's host parser reads it, in ASCII lower case. `localhost.` and a name that ends in
 * `.localhost.` are none, as they are off the loopback (spec 13.4), and so is an address.
 */
export const isLocalhostName = (host: string): boolean => {
  if (host.includes(':') || !isLoopbackHost(host)) {
    return false;
  }

  // ! a path after it, so that the URL parser trims nothing off the host's end
  const name = new URL(`http://${host}/`).hostname;

  return name === 'localhost' || name.endsWith('.localhost');
};

// an attempt's socket by default: Node's `net.connect`, reached as it is called
const connectOf = (address: string, port: number): Socket => {
  return (builtinOf('node:net') as INetLike).connect({
    highWaterMark: HIGH_WATER_MARK,
    host: address,
    port,
  });
};

// an attempt given up at the race's timeout, as Node words a connect that timed out
const timedOutOf = (address: string, port: number): Error => {
  return Object.assign(new Error(`connect ETIMEDOUT ${address}:${String(port)}`), {
    address,
    code: 'ETIMEDOUT',
    port,
    syscall: 'connect',
  });
};

// every attempt's error in one, as Node's own race gives it, its code the first one's
const everyFailureOf = (errors: readonly Error[]): AggregateError => {
  const messages = errors.map(({ message }) => {
    return message;
  });

  return Object.assign(new AggregateError(errors, messages.join('; ')), {
    code: (errors[0] as { code?: unknown } | undefined)?.code,
  });
};

/**
 * Connects `port` on the loopback, as RFC 8305 §5 races its attempts (spec 13.4): `127.0.0.1` at
 * once, then `::1` {@link LOOPBACK_ATTEMPT_DELAY} later, or at once when the first fails, which is
 * Bead's own. Every attempt is kept until one connects: the first connected is the race's, and the
 * other is destroyed, pending or connected after. Every attempt failing rejects an `AggregateError`
 * of their errors, which {@link isConnectFailure} reads. At its `timeout`, or as its `signal`
 * aborts, every attempt still open is destroyed and no socket stays: the timeout counts each as
 * Node's `connect ETIMEDOUT`, and the abort rejects with the signal's reason.
 */
export const raceLoopback = (
  port: number,
  { attempt = connectOf, clock = PLATFORM_CLOCK, signal, timeout }: IRaceLoopbackOptions
): Promise<Socket> => {
  return new Promise<Socket>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(toError(signal.reason));

      return;
    }

    // the attempts begun and not failed, each by its address, and the errors of those that failed
    const open = new Map<Socket, string>();
    const errors: Error[] = [];
    let begun = 0;
    let isSettled = false;
    let delay: TimeoutId | undefined;
    let bound: TimeoutId | undefined;

    // ! on every way out: its timers and its listener let go, every attempt still open ended
    const settle = (): void => {
      isSettled = true;
      clock.clearTimeout(delay);
      clock.clearTimeout(bound);
      signal?.removeEventListener('abort', abort);

      for (const socket of open.keys()) {
        socket.destroy();
      }

      open.clear();
    };

    // fails the race once every attempt began and failed
    const fail = (): void => {
      if (!isSettled && open.size === 0 && begun === LOOPBACK_ADDRESSES.length) {
        settle();
        reject(everyFailureOf(errors));
      }
    };

    const start = (): void => {
      const address = LOOPBACK_ADDRESSES[begun]?.address;

      if (isSettled || address === undefined) {
        return;
      }

      begun += 1;

      let socket: Socket;

      try {
        socket = attempt(address, port);
      } catch (reason) {
        errors.push(toError(reason));
        clock.clearTimeout(delay);
        start();
        fail();

        return;
      }

      open.set(socket, address);
      // ! kept for the socket's life: a loser destroyed, and a winner whose error comes before its
      // consumer listens, throw nothing
      socket.on('error', (error: Error) => {
        if (isSettled || !open.delete(socket)) {
          return;
        }

        errors.push(error);
        // * an attempt that fails starts the next at once
        clock.clearTimeout(delay);
        start();
        fail();
      });
      socket.once('connect', () => {
        if (isSettled || !open.delete(socket)) {
          socket.destroy();

          return;
        }

        settle();
        resolve(socket);
      });
    };

    const abort = (): void => {
      if (!isSettled) {
        settle();
        reject(toError(signal?.reason));
      }
    };

    signal?.addEventListener('abort', abort, { once: true });

    if (timeout !== Infinity) {
      bound = clock.setTimeout(
        () => {
          for (const address of open.values()) {
            errors.push(timedOutOf(address, port));
          }

          // * every attempt still open counted and ended, the next one never begun
          settle();
          reject(everyFailureOf(errors));
        },
        Math.min(Math.max(1, Math.ceil(timeout)), LONGEST_TIMER)
      );
    }

    start();

    // * none when the first attempt threw, which began the next at once
    if (begun < LOOPBACK_ADDRESSES.length) {
      delay = clock.setTimeout(start, LOOPBACK_ATTEMPT_DELAY);
    }
  });
};

/**
 * `http`'s `createConnection` in its callback form, for `ws`, to a localhost name `host`: it races
 * the loopback by {@link raceLoopback}, bounded by `timeout` and `signal`, of which `ws` hands none,
 * then, under `wss`, lays TLS over the winner with the options `ws` handed it, its TLS options
 * among them, and the server name `ws` would set, none for an IP literal.
 */
export const loopbackCreateConnection = (
  host: string,
  { signal, timeout }: { signal?: AbortSignal | null | undefined; timeout: number }
): CreateConnection => {
  return (options, oncreate) => {
    raceLoopback(Number(options.port), { signal, timeout }).then(
      (socket) => {
        // ! `ws` gives a `wss` URL's request 443 as its default port, and a `ws` one's 80
        if (options.defaultPort !== 443) {
          oncreate(null, socket);

          return;
        }

        const name = options.host ?? host;
        const given = options.servername;
        const servername =
          given !== undefined && given !== ''
            ? given
            : (builtinOf('node:net') as INetLike).isIP(name) === 0
              ? name
              : '';
        let secured: Socket;

        // ! a TLS that throws as it is laid fails the connect, its socket let go
        try {
          secured = (builtinOf('node:tls') as ITlsLike).connect({
            ...options,
            path: undefined,
            servername,
            socket,
          });
        } catch (reason) {
          socket.destroy();
          oncreate(toError(reason));

          return;
        }

        oncreate(null, secured);
      },
      (reason: unknown) => {
        oncreate(toError(reason));
      }
    );

    return undefined;
  };
};

/**
 * undici's `connect` function over `undici.buildConnector(tls)`, `tls` last as its options: a host but a localhost name goes to
 * undici's own connector unchanged. A localhost name races the loopback by {@link raceLoopback},
 * bounded by {@link LOOPBACK_CONNECT_TIMEOUT}. Under `https:`, the winner goes to that same connector
 * as its `httpSocket`, so its ALPN, its server name, its session cache, its keep-alive, its
 * `setNoDelay` and its connect timer hold over the TLS handshake; in the clear, the winner takes
 * undici's keep-alive and `setNoDelay` here.
 */
export const loopbackConnector = (undici: IUndici, tls: INodeTlsOptions): UndiciConnector => {
  const connector = undici.buildConnector(tls);

  return (options, callback) => {
    if (!isLocalhostName(options.hostname)) {
      connector(options, callback);

      return;
    }

    const isSecure = options.protocol === 'https:';
    const port = options.port === '' ? (isSecure ? 443 : 80) : Number(options.port);

    raceLoopback(port, { timeout: LOOPBACK_CONNECT_TIMEOUT }).then(
      (socket) => {
        if (isSecure) {
          // ! a connector that throws as it is called fails the connect, its socket let go
          try {
            connector({ ...options, httpSocket: socket }, callback);
          } catch (reason) {
            socket.destroy();
            callback(toError(reason), null);
          }

          return;
        }

        socket.setKeepAlive(true, KEEP_ALIVE);
        socket.setNoDelay(true);
        callback(null, socket);
      },
      (reason: unknown) => {
        callback(toError(reason), null);
      }
    );
  };
};

/**
 * Whether `reason` failed a connect that opened no socket: Node's error of its `connect` call, or an
 * `AggregateError` of one such error per address it raced. An error after a socket opened, a reset
 * as it read or a refused upgrade, is none.
 */
export const isConnectFailure = (reason: unknown): boolean => {
  if (reason instanceof AggregateError) {
    return (
      reason.errors.length > 0 &&
      reason.errors.every((error) => {
        return isConnectFailure(error);
      })
    );
  }

  return reason instanceof Error && 'syscall' in reason && reason.syscall === 'connect';
};

/**
 * What a connect to `host` whose every attempt failed says of where it went, when `host` is a
 * localhost name: "bead.localhost names the loopback: connected to 127.0.0.1 and ::1, no resolver
 * asked" (spec 13.4); none for any other host.
 */
export const loopbackSentenceOf = (host: string): string | undefined => {
  if (!isLocalhostName(host)) {
    return undefined;
  }

  const name = new URL(`http://${host}/`).hostname;

  return `${name} names the loopback: connected to 127.0.0.1 and ::1, no resolver asked`;
};

/**
 * A fetch's network failure toward `host`, a `TypeError`, followed by {@link loopbackSentenceOf}
 * when `host` is a localhost name and its cause {@link isConnectFailure}, a `TypeError` still,
 * `reason` its cause. Anything else is kept as it is: a socket that opened, and a fetch whose
 * `signal` aborted, which rejects with that signal's own reason.
 */
export const loopbackFailureOf = (
  reason: unknown,
  { host, signal }: { host: string; signal?: AbortSignal | null | undefined }
): unknown => {
  const sentence = loopbackSentenceOf(host);

  if (
    sentence === undefined ||
    signal?.aborted === true ||
    !(reason instanceof TypeError) ||
    !isConnectFailure(reason.cause)
  ) {
    return reason;
  }

  return new TypeError(`${reason.message}; ${sentence}`, { cause: reason });
};

/**
 * `agent` composed with an interceptor that notes the error each request it dispatches fails with:
 * the `error` event of undici's `WebSocket` carries no cause, and this tells a connect that opened
 * no socket from an upgrade refused after one did.
 */
export const watchedOf = (agent: IUndiciAgent): IUndiciWatched => {
  const failures: unknown[] = [];
  const dispatcher = agent.compose((dispatch) => {
    // ! two parameters, as undici's `compose` requires of what an interceptor returns
    return (options, handler) => {
      return dispatch(
        options,
        new Proxy(handler, {
          get: (target, key) => {
            const value: unknown = Reflect.get(target, key, target);

            if (key === 'onResponseError' && typeof value === 'function') {
              return (controller: unknown, error: unknown): unknown => {
                failures.push(error);

                return value.call(target, controller, error) as unknown;
              };
            }

            return typeof value === 'function' ? (value.bind(target) as unknown) : value;
          },
        })
      );
    };
  });

  return { dispatcher, failures };
};

/** Whether the package undici resolves from here, as Node's `import` of it would. */
export const resolvesUndici = (): boolean => {
  try {
    const nodeModule = builtinOf('node:module') as {
      createRequire(from: string): { resolve(id: string): string };
    };

    nodeModule.createRequire(import.meta.url).resolve(UNDICI);

    return true;
  } catch {
    return false;
  }
};

/** undici's own module: CommonJS, its exports the namespace's default. */
export const undiciOf = async (): Promise<IUndici> => {
  const namespace = (await import(/* @vite-ignore */ UNDICI)) as IUndici & {
    default?: IUndici | undefined;
  };

  return namespace.default ?? namespace;
};

/**
 * A client's undici and its agent, whose connect, {@link loopbackConnector}, takes `tls` and races a
 * localhost name on the loopback, so that one agent serves a host on the loopback and one under TLS
 * alike.
 * Where the package undici does not resolve, it draws none, and the client takes Node's global
 * `fetch` and `WebSocket`, which ask the platform's resolver (spec 13.4).
 */
export const createUndiciDialer = (tls: INodeTlsOptions): IUndiciDialer => {
  // `null` once undici was found not to resolve, for this client's life
  let undici: IUndici | null | undefined;
  let agent: IUndiciAgent | undefined;

  return {
    close: (after) => {
      const closing = agent;

      agent = undefined;

      if (closing !== undefined) {
        void after
          .then(() => {
            return closing.close();
          })
          .catch(noop);
      }
    },
    draw: async () => {
      if (undici === undefined) {
        undici = resolvesUndici() ? await undiciOf() : null;
      }

      if (undici === null) {
        return undefined;
      }

      agent ??= new undici.Agent({ connect: loopbackConnector(undici, tls) });

      return { agent, undici };
    },
  };
};
