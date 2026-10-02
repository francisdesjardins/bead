// dependencies

import { createEventIterator } from './event-iterator';
import {
  isReadyStateClosed,
  isReadyStateClosing,
  isReadyStateConnecting,
  isReadyStateOpen,
  isReadyStateReconnecting,
  isReadyStateUninitialized,
} from './ready-state';
import type { EmitterEventMap, IEmitter, IEventMethods, IReadyStateMethods } from './types';

// definition

/**
 * `emitter` exposed as methods that return the end they are spread into. `getEnd` is a getter
 * because the end is still being built when these are.
 */
export const createEventMethods = <E extends EmitterEventMap<E>, End>(
  emitter: IEmitter<E>,
  getEnd: () => End
): IEventMethods<E, End> => {
  return {
    emit: (event, ...params) => {
      return emitter.emit(event, ...params);
    },
    events: (event, options) => {
      return createEventIterator(emitter, { ...options, event });
    },
    off: (event, listener) => {
      return (emitter.off(event, listener), getEnd());
    },
    on: (event, listener) => {
      return (emitter.on(event, listener), getEnd());
    },
    once: (event, listener) => {
      return (emitter.once(event, listener), getEnd());
    },
    removeAllListeners: (event) => {
      return (emitter.removeAllListeners(event), getEnd());
    },
  };
};

/**
 * The ready state of `getEnd()` as predicates, read at each call. The end is the one they are spread
 * into, so only a transport end carries a ready state.
 */
export const createReadyStateMethods = (getEnd: () => IReadyStateMethods): IReadyStateMethods => {
  return {
    isClosed: () => {
      return isReadyStateClosed(getEnd());
    },
    isClosing: () => {
      return isReadyStateClosing(getEnd());
    },
    isConnecting: () => {
      return isReadyStateConnecting(getEnd());
    },
    isOpen: () => {
      return isReadyStateOpen(getEnd());
    },
    isReconnecting: () => {
      return isReadyStateReconnecting(getEnd());
    },
    isUninitialized: () => {
      return isReadyStateUninitialized(getEnd());
    },
  };
};
