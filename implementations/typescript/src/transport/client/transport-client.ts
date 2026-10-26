// ── Transport client ──────────────────────────────────────────────────────────

// dependencies

import { assertHeld, assertHeldDelay, type IClock, PLATFORM_CLOCK } from '../shared/clock';
import { ERROR_EVENT, RECONNECT_EVENT } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { createEmitter } from '../shared/emitter';
import {
  CancelError,
  ProgrammerError,
  ReconnectError,
  toCancelError,
  toError,
  wrapReason,
} from '../shared/errors';
import { createEventMethods, createReadyStateMethods } from '../shared/lifecycle';
import { noop } from '../shared/noop';
import {
  getReadyStateName,
  setReadyStateClosed,
  setReadyStateReconnecting,
} from '../shared/ready-state';
import { dispose } from './symbols';
import type {
  ITransportClient,
  ITransportClientConnectOptions,
  ITransportClientDisconnectOptions,
  ITransportClientImplementation,
  ITransportClientInternal,
  ITransportClientDefineOptions,
  ITransportClientOptions,
  ITransportClientReconnectOptions,
  TRANSPORT_CLIENT_EVENTS,
  TransportClientEventMap,
} from './types';

export { LONGEST_TIMER, PLATFORM_CLOCK } from '../shared/clock';
export type { IClock, TimeoutId } from '../shared/clock';
export { CLOSE_EVENT, ERROR_EVENT, MESSAGE_EVENT } from '../shared/constants';
export {
  CancelError,
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  ReconnectError,
  TimeoutError,
} from '../shared/errors';
export {
  getReadyState,
  isReadyStateClosed,
  isReadyStateClosing,
  isReadyStateConnecting,
  isReadyStateOpen,
  isReadyStateReconnecting,
  isReadyStateUninitialized,
  READY_STATE_NAMES,
  ReadyState,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
  setReadyStateReconnecting,
  setReadyStateUninitialized,
} from '../shared/ready-state';
export type { Data, IEventIteratorOptions, ITransportMessage } from '../shared/types';
export { dispose } from './symbols';
export type {
  ITransportClient,
  ITransportClientAddressOptions,
  ITransportClientConnectOptions,
  ITransportClientDisconnectOptions,
  ITransportClientImplementation,
  ITransportClientInternal,
  ITransportClientDefineOptions,
  ITransportClientOptions,
  ITransportClientReconnectOptions,
  TRANSPORT_CLIENT_EVENTS,
  TransportClientEventMap,
  TransportClientOnCloseCallback,
  TransportClientOnErrorCallback,
  TransportClientOnMessageCallback,
  TransportClientReconnectDelay,
  TransportClientReconnectDelayOrDelayResolver,
  TransportClientReconnectDelayResolver,
  TransportClientReconnectTapCallback,
  TransportClientToldEvent,
} from './types';

// types

export type DEFAULTS = typeof DEFAULTS;
export type DISCONNECT_DEFAULTS = typeof DISCONNECT_DEFAULTS;
export type RECONNECT_DEFAULTS = typeof RECONNECT_DEFAULTS;

// constants

/** What an omitted transport option resolves to. */
export const DEFAULTS = (): ITransportClientOptions => {
  return { clock: PLATFORM_CLOCK };
};

/** What an omitted disconnect option resolves to. */
export const DISCONNECT_DEFAULTS = Object.freeze({
  isClean: true,
  isQuick: false,
} satisfies ITransportClientDisconnectOptions);

/** What an omitted reconnect option resolves to. */
export const RECONNECT_DEFAULTS = Object.freeze({
  delay: 1_000,
  maxAttempts: 5,
} satisfies ITransportClientReconnectOptions);

/** What a reconnection its signal ended rejects with, as the C# side words it. */
const RECONNECTION_CANCELLED = 'the reconnection was cancelled';

// a field's value, and so a credential an `Authorization` carries (RFC 9110 §5.5): visible ASCII,
// spaces and tabs alone, none first or last, which a field cannot keep
const FIELD_VALUE = /^(?:[!-~](?:[\t -~]*[!-~])?)?$/u;

// helpers

/**
 * Whether `value` is a field value (RFC 9110 §5.5), as a credential every client writes must be
 * (spec 15.5): visible ASCII, spaces and tabs alone, none first or last, which a field cannot keep
 * and a server would read trimmed.
 */
export const isFieldValue = (value: string): boolean => {
  return FIELD_VALUE.test(value);
};

/** The {@link CancelError} a reconnection its `signal` ended rejects with, its reason the `cause`. */
const reconnectionCancelOf = (signal: AbortSignal): CancelError => {
  return new CancelError(RECONNECTION_CANCELLED, { cause: signal.reason });
};

const sleep = (
  delay: number,
  { clock, signal }: { clock: IClock; signal: AbortSignal | undefined }
) => {
  return createPromise(
    (resolve) => {
      resolve();
    },
    { clock, delay, signal }
  );
};

// definition

/**
 * The shared half of every transport client: the events, the ready state around `reconnect` and
 * `[dispose]`, and `reconnect` itself, which waits between its attempts on the clock its transport
 * runs on.
 *
 * `define` receives the client being built and the `tell` its transport calls its listeners by
 * (spec 15.1), and returns what only its transport knows — its clock, `connect`, `disconnect`,
 * `send` and `[dispose]`. Those are reached through the client, never captured, so `reconnect` calls
 * whatever `client.connect` is at the time, as a subclass override would; a replacement must call
 * the original before its first `await`, which is when `reconnect` lets it past the state guard.
 *
 * @example
 * const client = createTransportClient((client) => {
 *   return {
 *     connect: () => {
 *       client.socket = { open: true };
 *       setReadyStateOpen(client);
 *       return Promise.resolve();
 *     },
 *     disconnect: () => {
 *       setReadyStateClosed(client);
 *       client.emit('close', true, false);
 *       return Promise.resolve();
 *     },
 *     send: () => Promise.resolve(),
 *     [dispose]: () => {
 *       client.socket = null;
 *     },
 *   };
 * });
 */
export const createTransportClient = <
  Socket extends object,
  ConnectOptions extends ITransportClientConnectOptions,
>(
  define: (
    client: ITransportClientInternal<Socket, ConnectOptions>,
    options: ITransportClientDefineOptions
  ) => ITransportClientImplementation<ConnectOptions>
): ITransportClient<Socket, ConnectOptions> => {
  const emitter = createEmitter<TransportClientEventMap>();

  // true only while `reconnect` calls `client.connect`, which the state guard then lets through
  let isAttempting = false;
  let lastConnectOptions: ConnectOptions | undefined;

  // each listener within a guard (spec 15.1): what one throws is reported, and the transport goes
  // on as if it returned; the transport tells its `message` and its `close` by it, and the client
  // its `reconnect`
  const tell = <K extends Exclude<TRANSPORT_CLIENT_EVENTS, ERROR_EVENT>>(
    event: K,
    params: TransportClientEventMap[K]
  ): boolean => {
    return emitter.emitEach(event, {
      onError: (error) => {
        emitter.emit(ERROR_EVENT, toError(error));
      },
      params,
    });
  };
  const defineOptions: ITransportClientDefineOptions = { tell };

  const client: ITransportClientInternal<Socket, ConnectOptions> = {
    socket: null,

    ...createEventMethods(emitter, () => {
      return client;
    }),
    ...createReadyStateMethods(() => {
      return client;
    }),

    get clock() {
      return implementation.clock ?? PLATFORM_CLOCK;
    },
    get isSecure() {
      return implementation.isSecure === true;
    },

    carries: (credential) => {
      return implementation.carries?.(credential) === true;
    },
    connect: (given) => {
      // held here, so by every transport, before anything moves or is kept for a reconnection, which
      // connects again with the timeout held; and what its transport refuses of the options alike
      let options: ConnectOptions;

      try {
        options =
          given.timeout === undefined
            ? given
            : { ...given, timeout: assertHeld("a connect's timeout", given.timeout) };
        implementation.assertConnect?.(options);
      } catch (reason) {
        return Promise.reject(toError(reason));
      }

      if (!isAttempting && !client.isUninitialized() && !client.isClosed()) {
        return Promise.reject(
          new ProgrammerError(`the transport client is already ${getReadyStateName(client)}`)
        );
      }

      // without its signal: a reconnection brings its own, and this one may be long aborted
      lastConnectOptions = { ...options, signal: undefined };

      // an aborted signal is honoured here, so by every transport, whatever it does with the signal
      if (options.signal?.aborted) {
        return Promise.reject(toCancelError(options.signal));
      }

      return implementation.connect(options);
    },
    disconnect: (options) => {
      return implementation.disconnect(options);
    },
    send: (message) => {
      return implementation.send(message);
    },
    [dispose]: () => {
      const wasOpen = client.isOpen();

      implementation[dispose]();

      if (wasOpen) {
        setReadyStateClosed(client);
      }
    },
    [Symbol.asyncDispose]: async () => {
      const wasOpen = client.isOpen();

      try {
        if (wasOpen) {
          await client.disconnect();
        }
      } finally {
        client[dispose]();

        if (wasOpen) {
          setReadyStateClosed(client);
        }
      }
    },

    reconnect: async (options) => {
      const {
        delay = RECONNECT_DEFAULTS.delay,
        maxAttempts = RECONNECT_DEFAULTS.maxAttempts,
        signal,
        tap,
      } = options ?? {};

      if (client.isReconnecting()) {
        throw new ProgrammerError('the transport client is already reconnecting');
      }

      if (lastConnectOptions === undefined) {
        throw new ProgrammerError('the transport client was never connected');
      }

      if (client.isConnecting() || client.isClosing()) {
        throw new ProgrammerError(
          `the transport client cannot reconnect while ${getReadyStateName(client)}`
        );
      }

      if (Number.isNaN(maxAttempts)) {
        throw new ProgrammerError('maxAttempts is not a number');
      }

      // before the dispose below, so an already aborted signal leaves an open connection alone
      if (signal?.aborted) {
        throw reconnectionCancelOf(signal);
      }

      const target = lastConnectOptions;

      tell(RECONNECT_EVENT, []);

      if (client.isOpen()) {
        // dropped without a handshake, so no `close` reaches the listeners for a connection replaced
        client[dispose]();
      }

      setReadyStateReconnecting(client);

      const attemptConnect = (): Promise<void> => {
        isAttempting = true;

        try {
          return client.connect({ ...target, signal });
        } finally {
          isAttempting = false;
        }
      };

      let previousDelay: number | undefined;

      try {
        // an abort between attempts needs no check here: `connect` is handed the signal and rejects
        // at once when it is aborted, which the catch below reports as the CancelError
        for (let attempt = 1; ; attempt += 1) {
          try {
            await attemptConnect();

            break;
          } catch (reason) {
            if (signal?.aborted) {
              throw reconnectionCancelOf(signal);
            }

            // a misuse an attempt met, the next would meet again
            if (reason instanceof ProgrammerError) {
              throw reason;
            }

            if (attempt >= maxAttempts) {
              throw new ReconnectError(`attempt ${String(maxAttempts)} reached`, {
                cause: reason,
              });
            }
          }

          let nextDelay: number;

          try {
            nextDelay = typeof delay === 'function' ? delay(previousDelay, attempt) : delay;
          } catch (reason) {
            throw wrapReason(ProgrammerError, reason);
          }

          // held before "tap" hears it: 0 waits none, and never would wait for ever
          nextDelay = assertHeldDelay('a delay', nextDelay);

          // armed before "tap" is told, so whoever moves the clock once told moves it past the wait
          const pausing = new AbortController();
          const waiting = sleep(nextDelay, {
            clock: client.clock,
            signal:
              signal === undefined ? pausing.signal : AbortSignal.any([signal, pausing.signal]),
          });

          try {
            tap?.(nextDelay, attempt);
          } catch (reason) {
            pausing.abort();
            await waiting.catch(noop);

            throw reason;
          }

          previousDelay = nextDelay;

          try {
            await waiting;
          } catch (reason) {
            throw signal?.aborted === true ? reconnectionCancelOf(signal) : reason;
          }
        }

        if (signal?.aborted) {
          await client.disconnect().catch(noop);

          throw reconnectionCancelOf(signal);
        }
      } catch (reason) {
        setReadyStateClosed(client);

        throw reason;
      }
    },
  };

  // after `client` exists, since `define` closes over it; the methods above only read this when called
  const implementation = define(client, defineOptions);

  return client;
};
