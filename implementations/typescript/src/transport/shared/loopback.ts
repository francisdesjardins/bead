// ── Loopback ──────────────────────────────────────────────────────────────────

// dependencies

import { noop } from './noop';
import { isLoopbackHost } from './secure';
import { builtinOf, type INodeTlsOptions } from './tls';

// interfaces

/** What `dns.lookup` is asked with: one address or all, of one family or either. */
interface ILookupOptions {
  all?: boolean | undefined;
  family?: number | string | undefined;
}

/** An address `dns.lookup` answers with, when it is asked for all of them. */
interface ILookupAddress {
  address: string;
  family: 4 | 6;
}

/** What `dns.lookup` answers with: an error, or one address and its family, or all of them. */
// oxlint-disable-next-line max-params, bead/options-last -- dns.lookup's own callback, which Node calls
type Answer = (error: Error | null, address: string | ILookupAddress[], family?: number) => void;

/** What `dns.lookup` is asked: its options, the family alone, or nothing but its callback. */
type Asked = ILookupOptions | number | Answer;

/** What Node's `net.connect` and `tls.connect` take to connect a localhost name to the loopback. */
export interface ILoopbackConnectOptions {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  lookup?: typeof loopbackLookup;
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
  Agent: new (options: { connect: ILoopbackConnectOptions & INodeTlsOptions }) => IUndiciAgent;
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
 * How long a connect to a localhost name waits on `127.0.0.1` before it tries `::1` beside it: RFC
 * 8305's Connection Attempt Delay, as every side races the two (spec 13.4).
 */
export const LOOPBACK_ATTEMPT_DELAY = 250;

// ! IPv4 first, against RFC 6724's default policy: a server on its defaults listens on 127.0.0.1,
// and a server given 127.0.0.1 alone is then never pre-empted by a process on [::1] (spec 15.12)
const LOOPBACK_ADDRESSES: readonly ILookupAddress[] = Object.freeze([
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
]);

// ! a specifier no bundler reads, so that no page's bundle carries undici, which a page never loads
const UNDICI = 'undici';

// helpers

// the family `dns.lookup` is asked for: 4, 6, or 0 for either
const familyOf = (family: number | string | undefined): number => {
  if (family === 'IPv4') {
    return 4;
  }

  if (family === 'IPv6') {
    return 6;
  }

  return typeof family === 'number' ? family : 0;
};

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

/**
 * A lookup of `dns.lookup`'s shape that answers a localhost name itself, `127.0.0.1` then `::1`, of
 * the family it is asked for, and asks no resolver (spec 13.4). It hands any other name to Node's
 * own `dns.lookup`, reached as it is called, so that one agent serves every host it is handed.
 */
// oxlint-disable-next-line max-params, bead/options-last -- dns.lookup's own shape, which Node calls
export const loopbackLookup = (hostname: string, options: Asked, callback?: Answer): void => {
  if (!isLocalhostName(hostname)) {
    const dns = builtinOf('node:dns') as { lookup: typeof loopbackLookup };

    if (callback === undefined) {
      dns.lookup(hostname, options);
    } else {
      dns.lookup(hostname, options, callback);
    }

    return;
  }

  const done = typeof options === 'function' ? options : callback;
  const asked: ILookupOptions =
    typeof options === 'number' ? { family: options } : typeof options === 'object' ? options : {};
  const family = familyOf(asked.family);
  const addresses = LOOPBACK_ADDRESSES.filter((address) => {
    return family === 0 || address.family === family;
  });
  const [first] = addresses;

  // answered from a microtask, as a resolver answers after its call returns
  queueMicrotask(() => {
    if (first === undefined) {
      done?.(
        Object.assign(new Error(`no loopback address of family ${String(asked.family)}`), {
          code: 'ENOTFOUND',
        }),
        []
      );
    } else if (asked.all === true) {
      done?.(
        null,
        addresses.map((address) => {
          return { ...address };
        })
      );
    } else {
      done?.(null, first.address, first.family);
    }
  });
};

/**
 * What a `net.connect` or a `tls.connect` takes to connect `host` to the loopback itself, when it is
 * a localhost name: its addresses by {@link loopbackLookup}, raced by RFC 8305's attempt delay. None
 * for any other host, which its platform's resolver reads.
 */
export const loopbackConnectOptions = (host: string): ILoopbackConnectOptions => {
  return isLocalhostName(host)
    ? {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: LOOPBACK_ATTEMPT_DELAY,
        lookup: loopbackLookup,
      }
    : {};
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
 * A client's undici and its agent, whose connect takes `tls` and answers a localhost name by
 * {@link loopbackLookup}, so that one agent serves a host on the loopback and one under TLS alike.
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

      agent ??= new undici.Agent({
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: LOOPBACK_ATTEMPT_DELAY,
          lookup: loopbackLookup,
          ...tls,
        },
      });

      return { agent, undici };
    },
  };
};
