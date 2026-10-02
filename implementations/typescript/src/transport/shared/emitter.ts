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
 * makes `emit` return `false` instead of throwing.
 */
export const createEmitter = <E extends EmitterEventMap<E>>(): IEmitter<E> => {
  let registrationsByEvent: { [K in keyof E]?: IEmitterRegistration<E[K]>[] } = {};

  const add = <K extends keyof E>(event: K, registration: IEmitterRegistration<E[K]>): void => {
    (registrationsByEvent[event] ??= []).push(registration);
  };

  return {
    emit: (event, ...params) => {
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

        registration.listener(...params);
      }

      return true;
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
