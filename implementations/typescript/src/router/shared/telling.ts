// ── Telling ───────────────────────────────────────────────────────────────────

// dependencies

import type { EmitterEventMap, IEmitter } from '../../transport/shared/types';

// interfaces

/**
 * A router's telling, which its core and its facade share: what each tells its application runs
 * within it, and what that application does with the router from within one is taken in a later
 * turn, behind what the turn that tells sends and among what it defers, in the order deferred (spec
 * 9.0; decision 0045). The turns are the job queue's, one first in first out, as ECMA-262 runs its
 * jobs to completion.
 */
export interface ITelling {
  /** Runs `operation` now, or — within a telling — in a later turn, at the job queue's tail. */
  defer(operation: () => void): void;
  /** Runs `listener` within a telling, and gives what it returns. */
  heard<Value>(listener: () => Value): Value;
  /** Whether a telling runs now. */
  isTelling(): boolean;
  /**
   * Runs `operation` now, or — within a telling — in a later turn, at the job queue's tail; what it
   * throws there rejects what it gives.
   */
  later<Value>(operation: () => Promise<Value>): Promise<Value>;
}

// definition

/** A router's telling, none running. */
export const createTelling = (): ITelling => {
  // the tellings running, one within another
  let depth = 0;

  const isTelling = (): boolean => {
    return depth > 0;
  };

  return {
    defer: (operation) => {
      if (!isTelling()) {
        return (operation(), undefined);
      }

      queueMicrotask(operation);

      return undefined;
    },
    heard: (listener) => {
      depth += 1;

      try {
        return listener();
      } finally {
        depth -= 1;
      }
    },
    isTelling,
    later: (operation) => {
      // * a reaction job, queued now, behind what the turn deferred before it, as queueMicrotask
      // queues one
      return isTelling() ? Promise.resolve().then(operation) : operation();
    },
  };
};

/**
 * `emitter`, each of its emits a telling of `telling`'s: what a listener does with the router from
 * within it is taken in a later turn, wherever the emit came from — the core, a transport's event,
 * the layer above.
 */
export const toldOf = <E extends EmitterEventMap<E>>(
  emitter: IEmitter<E>,
  telling: ITelling
): IEmitter<E> => {
  return {
    ...emitter,
    emit: (event, ...params) => {
      return telling.heard(() => {
        return emitter.emit(event, ...params);
      });
    },
    emitEach: (event, guarded) => {
      return telling.heard(() => {
        return emitter.emitEach(event, guarded);
      });
    },
  };
};
