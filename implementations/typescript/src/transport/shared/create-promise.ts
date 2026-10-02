// dependencies

import { TimeoutError, toCancelError, toError } from './errors';
import type { ICreatePromiseOptions, PromiseExecutor } from './types';

// definition

/**
 * A `new Promise(executor)` that can wait before it starts, give up after a while, or be cancelled.
 *
 * Its timers and its abort listener are released however the promise settles, so a connect that
 * fails fast does not keep the process alive for the rest of its timeout.
 */
export const createPromise = <T = void>(
  executor: PromiseExecutor<T>,
  options?: ICreatePromiseOptions
): Promise<T> => {
  const { delay: requestedDelay = 0, signal, timeout: requestedTimeout = 0 } = options ?? {};

  // anything but a positive finite number means none, NaN included
  const delay = Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : 0;
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 0;
  const { promise, resolve, reject } = Promise.withResolvers<T>();

  if (signal?.aborted) {
    reject(toCancelError(signal));

    return promise;
  }

  let delayId: ReturnType<typeof setTimeout> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    if (signal !== undefined) {
      reject(toCancelError(signal));
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  // if the Promise needs to timeout
  if (timeout) {
    const total = timeout + delay;

    timeoutId = setTimeout(() => {
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
    delayId = setTimeout(execute, delay);
  } else {
    execute();
  }

  return promise.finally(() => {
    clearTimeout(delayId);
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  });
};
