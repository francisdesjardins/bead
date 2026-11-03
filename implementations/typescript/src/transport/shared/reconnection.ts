// ── Reconnection ──────────────────────────────────────────────────────────────

// dependencies

import { assertHeldDelay, type IClock } from './clock';
import { createPromise } from './create-promise';
import { CancelError, ProgrammerError, ReconnectError, wrapReason } from './errors';
import { nextTask } from './later-task';
import { noop } from './noop';
import type {
  TransportClientReconnectDelay,
  TransportClientReconnectTapCallback,
} from '../client/types';

// interfaces

/** A reconnection as its owner resolved it: each member given, its own default in its stead. */
export interface IReconnection {
  /** The clock its waits run on. */
  clock: IClock;
  delay: TransportClientReconnectDelay;
  maximumAttempts: number;
  signal?: AbortSignal | undefined;
  tap?: TransportClientReconnectTapCallback | undefined;
}

// constants

/** What a reconnection its signal ended rejects with, as the C# side words it. */
export const RECONNECTION_CANCELLED = 'the reconnection was cancelled';

// helpers

/** The {@link CancelError} a reconnection its `signal` ended rejects with, its reason the `cause`. */
export const reconnectionCancelOf = (signal: AbortSignal): CancelError => {
  return new CancelError(RECONNECTION_CANCELLED, { cause: signal.reason });
};

/**
 * Holds a reconnection's options where they are given (spec 1.4): a `maximumAttempts` that is not a
 * number, then a fixed delay out of bounds, each a {@link ProgrammerError}; a function's answer is
 * held at each attempt instead.
 */
export const assertHeldReconnection = (options: {
  delay?: TransportClientReconnectDelay | undefined;
  maximumAttempts?: number | undefined;
}): void => {
  if (Number.isNaN(options.maximumAttempts)) {
    throw new ProgrammerError('maximumAttempts is not a number');
  }

  if (options.delay !== undefined && typeof options.delay !== 'function') {
    assertHeldDelay('a delay', options.delay);
  }
};

// definition

/**
 * A reconnection's attempts, each made by `attempt`, given its signal: the first at once, each next
 * one after its delay on its clock, armed before `tap` hears it, so whoever moves the clock once
 * told moves it past the wait; at a delay of 0, in a later task of the event loop, never a
 * microtask. Its signal is read before each attempt, the first included, and during each wait; an
 * attempt under way is cut short only where `attempt` reads it. It resolves once one opens, and
 * rejects with a {@link CancelError} once its signal is aborted; with a {@link ReconnectError} once
 * its attempts ran out, the last one's error its `cause`; with a {@link ProgrammerError} that an
 * attempt met, which the next would meet again, or that its delay's function threw or answered out
 * of bounds; and with what `tap` throws, as it is.
 *
 * @example
 * await attemptReconnection(
 *   (signal) => {
 *     return client.connect({ ...target, signal });
 *   },
 *   { clock, delay: 1_000, maximumAttempts: 5 }
 * );
 */
export const attemptReconnection = async (
  attempt: (signal: AbortSignal | undefined) => Promise<void>,
  { clock, delay, maximumAttempts, signal, tap }: IReconnection
): Promise<void> => {
  // read afresh at each call: an attempt, a tap or a wait may abort it
  const isAborted = (): boolean => {
    return signal?.aborted === true;
  };
  let previousDelay: number | undefined;

  for (let number = 1; ; number += 1) {
    // * read before each attempt, the first included
    if (signal !== undefined && isAborted()) {
      throw reconnectionCancelOf(signal);
    }

    try {
      await attempt(signal);

      return;
    } catch (reason) {
      if (signal !== undefined && isAborted()) {
        throw reconnectionCancelOf(signal);
      }

      // a misuse an attempt met, the next would meet again
      if (reason instanceof ProgrammerError) {
        throw reason;
      }

      if (number >= maximumAttempts) {
        throw new ReconnectError(`attempt ${String(maximumAttempts)} reached`, { cause: reason });
      }
    }

    let nextDelay: number;

    try {
      nextDelay = typeof delay === 'function' ? delay(previousDelay, number) : delay;
    } catch (reason) {
      throw wrapReason(ProgrammerError, reason);
    }

    // held before "tap" hears it: 0 arms none, and never would wait for ever
    nextDelay = assertHeldDelay('a delay', nextDelay);

    // armed before "tap" is told, so whoever moves the clock once told moves it past the wait; none
    // at 0, which waits a later task of the event loop once told instead
    const pausing = new AbortController();
    const waiting =
      nextDelay === 0
        ? undefined
        : createPromise(
            (resolve) => {
              resolve();
            },
            {
              clock,
              delay: nextDelay,
              signal:
                signal === undefined ? pausing.signal : AbortSignal.any([signal, pausing.signal]),
            }
          );

    try {
      tap?.(nextDelay, number);
    } catch (reason) {
      pausing.abort();
      await waiting?.catch(noop);

      throw reason;
    }

    previousDelay = nextDelay;

    try {
      // * at 0, a task of the event loop, never a microtask: an attempt refused at once would
      // otherwise run on microtasks alone, which no timer and no I/O ever pass
      await (waiting ?? nextTask());
    } catch (reason) {
      throw signal !== undefined && isAborted() ? reconnectionCancelOf(signal) : reason;
    }
  }
};
