// dependencies

import { LONGEST_TIMER, PLATFORM_CLOCK, type TimeoutId } from './clock';
import { ProgrammerError, TimeoutError, toCancelError, toError } from './errors';
import type { ICreatePromiseOptions, PromiseExecutor } from './types';

// definition

/**
 * A `new Promise(executor)` that can wait before it starts, give up after a while, or be cancelled.
 *
 * Its timers, on its `clock`, and its abort listener are released however the promise settles, so a
 * connect that fails fast does not keep the process alive for the rest of its timeout. A delay, or a
 * timeout and its delay together, past {@link LONGEST_TIMER} rejects with a {@link ProgrammerError},
 * the executor never run.
 */
export const createPromise = <T = void>(
  executor: PromiseExecutor<T>,
  options?: ICreatePromiseOptions
): Promise<T> => {
  const {
    clock = PLATFORM_CLOCK,
    delay: requestedDelay = 0,
    signal,
    timeout: requestedTimeout = 0,
  } = options ?? {};

  // anything but a positive finite number means none, NaN included
  const delay = Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : 0;
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 0;
  const total = timeout + delay;
  const { promise, resolve, reject } = Promise.withResolvers<T>();

  if (delay > LONGEST_TIMER || (timeout > 0 && total > LONGEST_TIMER)) {
    reject(
      new ProgrammerError(
        `a timer waits ${String(LONGEST_TIMER)} milliseconds at most, a timeout and its delay together, not ${String(timeout > 0 ? total : delay)}`
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
  if (timeout) {
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
  if (delay) {
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
