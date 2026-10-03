// ── Transport client ──────────────────────────────────────────────────────────

// dependencies

import { assertHeld, type IClock, LONGEST_TIMER, PLATFORM_CLOCK } from '../shared/clock';
import { RECONNECT_EVENT } from '../shared/constants';
import { createPromise } from '../shared/create-promise';
import { createEmitter } from '../shared/emitter';
import {
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
  ITransportClientOptions,
  ITransportClientReconnectOptions,
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
export type { Data, IEventIteratorOptions } from '../shared/types';
export { dispose } from './symbols';
export type {
  ITransportClient,
  ITransportClientAddressOptions,
  ITransportClientConnectOptions,
  ITransportClientDisconnectOptions,
  ITransportClientImplementation,
  ITransportClientInternal,
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

// helpers

// a connect's timeout, or a reconnection's delay, as a timer holds it: one of 0 or less, or
// `Infinity`, never times out, or waits none; any other is one a timer holds, a millisecond at least
const assertTimer = (name: string, given: number): void => {
  if (Number.isFinite(given) && given > LONGEST_TIMER) {
    throw new ProgrammerError(
      `${name} is ${String(LONGEST_TIMER)} milliseconds at most, as a timer holds, not ${String(given)}`
    );
  }

  if (Number.isNaN(given) || given > 0) {
    assertHeld(name, given);
  }
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
 * `define` receives the client being built and returns what only its transport knows — its clock,
 * `connect`, `disconnect`, `send` and `[dispose]`. Those are reached through the client, never
 * captured, so `reconnect` calls whatever `client.connect` is at the time, as a subclass override
 * would; a replacement must call the original before its first `await`, which is when `reconnect`
 * lets it past the state guard.
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
    client: ITransportClientInternal<Socket, ConnectOptions>
  ) => ITransportClientImplementation<ConnectOptions>
): ITransportClient<Socket, ConnectOptions> => {
  const emitter = createEmitter<TransportClientEventMap>();

  // true only while `reconnect` calls `client.connect`, which the state guard then lets through
  let isAttempting = false;
  let lastConnectOptions: ConnectOptions | undefined;

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

    connect: (options) => {
      // refused here, so by every transport, before anything moves or is kept for a reconnection
      try {
        assertTimer("a connect's timeout", options.timeout ?? 0);
      } catch (reason) {
        return Promise.reject(toError(reason));
      }

      if (!isAttempting && !client.isUninitialized() && !client.isClosed()) {
        return Promise.reject(
          new ProgrammerError(
            client.isOpen()
              ? 'transport is already opened'
              : `transport is already ${getReadyStateName(client)}`
          )
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
    send: (data) => {
      return implementation.send(data);
    },
    [dispose]: () => {
      const wasOpen = client.isOpen();

      implementation[dispose]();

      if (wasOpen) {
        setReadyStateClosed(client);
      }
    },
    [Symbol.asyncDispose]: async () => {
      if (client.isOpen()) {
        await client.disconnect();
      } else {
        client[dispose]();
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
        throw new ProgrammerError('already reconnecting');
      }

      if (lastConnectOptions === undefined) {
        throw new ProgrammerError('transport was never connected');
      }

      if (client.isConnecting() || client.isClosing()) {
        throw new ProgrammerError(`cannot reconnect while ${getReadyStateName(client)}`);
      }

      if (Number.isNaN(maxAttempts)) {
        throw new ProgrammerError('maxAttempts is not a number');
      }

      // before the dispose below, so an already aborted signal leaves an open connection alone
      if (signal?.aborted) {
        throw toCancelError(signal);
      }

      const target = lastConnectOptions;

      emitter.emit(RECONNECT_EVENT);

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
              throw toCancelError(signal);
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

          // refused before "tap" hears it
          assertTimer('a delay', nextDelay);
          tap?.(nextDelay, attempt);

          previousDelay = nextDelay;

          await sleep(nextDelay, { clock: client.clock, signal });
        }

        if (signal?.aborted) {
          await client.disconnect().catch(noop);

          throw toCancelError(signal);
        }
      } catch (reason) {
        setReadyStateClosed(client);

        throw reason;
      }
    },
  };

  // after `client` exists, since `define` closes over it; the methods above only read this when called
  const implementation = define(client);

  return client;
};
