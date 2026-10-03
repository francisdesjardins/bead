// dependencies

import {
  assertHeld,
  assertHeldDelay,
  LONGEST_TIMER,
  PLATFORM_CLOCK,
  type TimeoutId,
} from './clock';
import { ProgrammerError, TimeoutError, toCancelError, toError } from './errors';
import type { ICreatePromiseOptions, PromiseExecutor } from './types';

// helpers

// a delay and a timeout as they are held: the delay 0, at once, when none, and the timeout never
const heldOf = ({
  delay = 0,
  timeout,
}: Pick<ICreatePromiseOptions, 'delay' | 'timeout'>): { delay: number; timeout: number } => {
  return {
    delay: assertHeldDelay('a delay', delay),
    timeout: timeout === undefined ? Infinity : assertHeld('a timeout', timeout),
  };
};

// definition

/**
 * A `new Promise(executor)` that can wait before it starts, give up after a while, or be cancelled.
 *
 * Its timers, on its `clock`, and its abort listener are released however the promise settles, so a
 * connect that fails fast does not keep the process alive for the rest of its timeout. Its delay is
 * held as {@link assertHeldDelay} holds one, 0 at once and the default; its timeout as
 * {@link assertHeld} does, never 0, and without end for `Infinity` and the default. One refused
 * rejects with a {@link ProgrammerError}, the executor never run; so does a timeout and its delay
 * together past {@link LONGEST_TIMER}.
 */
export const createPromise = <T = void>(
  executor: PromiseExecutor<T>,
  options?: ICreatePromiseOptions
): Promise<T> => {
  const { clock = PLATFORM_CLOCK, signal } = options ?? {};
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let held: { delay: number; timeout: number };

  try {
    held = heldOf(options ?? {});
  } catch (reason) {
    reject(toError(reason));

    return promise;
  }

  const { delay, timeout } = held;
  const total = timeout + delay;

  if (Number.isFinite(timeout) && total > LONGEST_TIMER) {
    reject(
      new ProgrammerError(
        `a timer waits ${String(LONGEST_TIMER)} milliseconds at most, a timeout and its delay together, not ${String(total)}`
      )
    );

    return promise;
  }

  if (signal?.aborted) {
    reject(toCancelError(signal));

    return promise;
  }

  let delayId: TimeoutId | undefined;
  let timeoutId: TimeoutId | undefined;

  const onAbort = (): void => {
    if (signal !== undefined) {
      reject(toCancelError(signal));
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  // if the Promise needs to timeout
  if (Number.isFinite(timeout)) {
    timeoutId = clock.setTimeout(() => {
      reject(new TimeoutError(total));
    }, total);
  }

  const execute = (): void => {
    try {
      executor(resolve, reject);
    } catch (reason) {
      reject(toError(reason));
    }
  };

  // if the Promise needs to delay
  if (delay > 0) {
    delayId = clock.setTimeout(execute, delay);
  } else {
    execute();
  }

  return promise.finally(() => {
    clock.clearTimeout(delayId);
    clock.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  });
};
