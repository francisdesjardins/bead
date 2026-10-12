// dependencies

import type { EmitterEventMap, IEmitter, IEventIteratorOptions } from './types';

// definition

/**
 * Every `event` from now on, as an async iterator of its arguments: what `for await` reads.
 *
 * Events that arrive faster than the loop reads them are buffered, in order, without bound, as Node's
 * `events.on` does by default. The loop ends by `break`, `return()`, a throw, or the signal aborting,
 * and its listener goes then, not before: an iterator left unread keeps what comes until one of them.
 */
export const createEventIterator = <E extends EmitterEventMap<E>, K extends keyof E>(
  emitter: IEmitter<E>,
  { event, signal }: IEventIteratorOptions & { event: K }
): AsyncIterableIterator<E[K], undefined> => {
  const buffered: E[K][] = [];
  // the `next()` calls not answered yet, in the order they were made
  const waiting: PromiseWithResolvers<IteratorResult<E[K], undefined>>[] = [];

  let isFinished = false;

  const listener = (...params: E[K]): void => {
    const next = waiting.shift();

    if (next === undefined) {
      return (buffered.push(params), undefined);
    }

    return (next.resolve({ done: false, value: params }), undefined);
  };

  const finish = (): IteratorResult<E[K], undefined> => {
    if (!isFinished) {
      isFinished = true;
      emitter.off(event, listener);
      signal?.removeEventListener('abort', finish);

      for (const next of waiting.splice(0)) {
        next.resolve({ done: true, value: undefined });
      }
    }

    return { done: true, value: undefined };
  };

  emitter.on(event, listener);

  if (signal?.aborted) {
    finish();
  } else {
    signal?.addEventListener('abort', finish, { once: true });
  }

  const iterator: AsyncIterableIterator<E[K], undefined> = {
    next: () => {
      const params = buffered.shift();

      if (params !== undefined) {
        return Promise.resolve({ done: false, value: params });
      }

      if (isFinished) {
        return Promise.resolve({ done: true, value: undefined });
      }

      const next = Promise.withResolvers<IteratorResult<E[K], undefined>>();

      waiting.push(next);

      return next.promise;
    },
    return: () => {
      return Promise.resolve(finish());
    },
    [Symbol.asyncIterator]: () => {
      return iterator;
    },
  };

  return iterator;
};
