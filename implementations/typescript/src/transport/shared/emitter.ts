// dependencies

import type { EmitterEventMap, IEmitter, IEmitterRegistration } from './types';

// definition

/**
 * The part of Node's `EventEmitter` a transport uses, typed per event and without `events`, so the
 * same code runs in a browser.
 *
 * Every registration counts, as in Node: `on(f)` twice calls `f` twice, and `off(event, f)` removes
 * the latest registration of `f`. Listeners run in registration order over a snapshot, so one added
 * or removed mid-emit changes the next emit, not this one. Unlike Node, an `error` nobody listens to
 * makes `emit` return `false` instead of throwing. `emitEach` calls each listener within a guard, for
 * what must never fail its emitter — a debug listener's trace: what one throws goes to `onError`.
 */
export const createEmitter = <E extends EmitterEventMap<E>>(): IEmitter<E> => {
  let registrationsByEvent: { [K in keyof E]?: IEmitterRegistration<E[K]>[] } = {};

  const add = <K extends keyof E>(event: K, registration: IEmitterRegistration<E[K]>): void => {
    (registrationsByEvent[event] ??= []).push(registration);
  };

  // each listener of `event`, called with `params` over a snapshot; within a guard, when `onError`
  // is given, so what one throws goes to it and the next is called all the same
  const run = <K extends keyof E>(
    event: K,
    { onError, params }: { onError?: ((error: unknown) => void) | undefined; params: E[K] }
  ): boolean => {
    const registrations = registrationsByEvent[event];

    if (registrations === undefined || registrations.length === 0) {
      return false;
    }

    for (const registration of Array.from(registrations)) {
      if (registration.isOnce) {
        // an emit nested in an earlier listener may already have run it
        if (registration.hasFired) {
          continue;
        }

        registration.hasFired = true;

        // an earlier listener may already have taken it out with `off` or `removeAllListeners`
        const index = registrations.indexOf(registration);

        if (index !== -1) {
          registrations.splice(index, 1);
        }
      }

      if (onError === undefined) {
        registration.listener(...params);
      } else {
        try {
          registration.listener(...params);
        } catch (error) {
          onError(error);
        }
      }
    }

    return true;
  };

  return {
    emit: (event, ...params) => {
      return run(event, { params });
    },
    emitEach: (event, guarded) => {
      return run(event, guarded);
    },
    listenerCount: (event) => {
      return registrationsByEvent[event]?.length ?? 0;
    },
    off: (event, listener) => {
      const registrations = registrationsByEvent[event] ?? [];
      const index = registrations.findLastIndex((registration) => {
        return registration.listener === listener;
      });

      if (index !== -1) {
        registrations.splice(index, 1);
      }
    },
    on: (event, listener) => {
      add(event, { hasFired: false, isOnce: false, listener });
    },
    once: (event, listener) => {
      add(event, { hasFired: false, isOnce: true, listener });
    },
    removeAllListeners: (event) => {
      if (event === undefined) {
        registrationsByEvent = {};
      } else {
        registrationsByEvent[event]?.splice(0);
      }
    },
  };
};
