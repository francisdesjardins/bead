// ── Session manager ───────────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError } from '../../transport/shared/errors';
import { gaugesOf, mergeGauges } from '../../transport/shared/gauges';
import { createEventMethods } from '../../transport/shared/lifecycle';
import { timestamp } from '../../transport/shared/timestamp';
import { SESSION_TOKEN_BYTES } from '../shared/constants';
import { DisconnectError } from '../shared/errors';
import { drawSessionToken, isSessionToken } from '../shared/identifiers';
import type { SessionToken } from '../shared/types';
import { areSimilar } from './are-similar';
import {
  CONNECTION_INACTIVITY_TIMEOUT_CHANGED_EVENT,
  CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  CREATED_EVENT,
  DATA_CHANGED_EVENT,
  DELETED_EVENT,
  LAST_ACTIVITY_TIMESTAMP_CHANGED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_CHANGED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  UPDATED_EVENT,
} from './constants';
import type {
  ISession,
  ISessionManager,
  ISessionManagerOptions,
  ISessionManagerTimers,
  ISessionTimeoutIds,
  SESSION_MANAGER_EVENTS,
  SessionManagerEventMap,
} from './types';

export {
  CONNECTION_INACTIVITY_TIMEOUT_CHANGED_EVENT,
  CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  CREATED_EVENT,
  DATA_CHANGED_EVENT,
  DELETED_EVENT,
  LAST_ACTIVITY_TIMESTAMP_CHANGED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_CHANGED_EVENT,
  SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT,
  UPDATED_EVENT,
} from './constants';
export { SESSION_TOKEN_BYTES } from '../shared/constants';
export { GenericError, ProgrammerError } from '../../transport/shared/errors';
export type { IEventIteratorOptions, ITimestamp } from '../../transport/shared/types';
export type { SessionToken } from '../shared/types';
export type {
  ISession,
  ISessionManager,
  ISessionManagerOptions,
  ISessionManagerTimers,
  ISessionTimeoutIds,
  SESSION_MANAGER_EVENTS,
  SessionManagerEventMap,
  SessionManagerOnInactivityTimeoutCallback,
  SessionManagerOnSessionCallback,
  TimeoutId,
} from './types';

// types

export type DEFAULTS = typeof DEFAULTS;

// constants

export const DEFAULTS = Object.freeze({
  connectionInactivityTimeout: 600,
  sessionInactivityTimeout: 30_000,
});

/** The longest `setTimeout` waits; a longer delay would fire at once instead. */
const TIMEOUT_MAX = 2 ** 31 - 1;

// helpers

/** Whether `timeout` arms a timer: finite, and no longer than `setTimeout` waits. */
export const isArmable = (timeout: number): boolean => {
  return Number.isFinite(timeout) && timeout <= TIMEOUT_MAX;
};

/**
 * A default the manager falls back on is a timeout itself: positive, or `Infinity` for never. Anything
 * else would let `0` through as a timer that fires at once.
 */
const assertDefaultTimeout = (name: string, timeout: number): void => {
  if (Number.isNaN(timeout) || timeout <= 0) {
    throw new ProgrammerError(
      `${name} is a positive number of milliseconds, got ${String(timeout)}`
    );
  }
};

/**
 * An inactivity timeout as the manager stores it: `0` or `NaN` takes `fallback`. A negative one is a
 * {@link ProgrammerError}, since `setTimeout` would fire it at once.
 */
const resolveTimeout = (timeout: number, fallback: number): number => {
  if (timeout < 0) {
    throw new ProgrammerError(`an inactivity timeout cannot be negative, got ${String(timeout)}`);
  }

  return timeout || fallback;
};

/** Each connection's two timers, in a record made on the first one set. */
export const createTimers = (): ISessionManagerTimers => {
  const timeoutIdsByConnection = new Map<TransportServerConnectionHandle, ISessionTimeoutIds>();

  const timeoutIdsOf = (connectionHandle: TransportServerConnectionHandle): ISessionTimeoutIds => {
    let timeoutIds = timeoutIdsByConnection.get(connectionHandle);

    if (timeoutIds === undefined) {
      timeoutIds = { connectionTimeoutId: undefined, sessionTimeoutId: undefined };
      timeoutIdsByConnection.set(connectionHandle, timeoutIds);
    }

    return timeoutIds;
  };

  const clearConnectionInactivityTimeout = (
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    clearTimeout(timeoutIdsByConnection.get(connectionHandle)?.connectionTimeoutId);
  };
  const clearSessionInactivityTimeout = (
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    clearTimeout(timeoutIdsByConnection.get(connectionHandle)?.sessionTimeoutId);
  };
  const clearInactivityTimeout = (connectionHandle: TransportServerConnectionHandle): void => {
    clearConnectionInactivityTimeout(connectionHandle);
    clearSessionInactivityTimeout(connectionHandle);
  };

  return {
    clearConnectionInactivityTimeout,
    clearInactivityTimeout,
    clearSessionInactivityTimeout,
    create: (connectionHandle) => {
      clearInactivityTimeout(connectionHandle);
      timeoutIdsByConnection.set(connectionHandle, {
        connectionTimeoutId: undefined,
        sessionTimeoutId: undefined,
      });
    },
    gauges: () => {
      return gaugesOf({
        connectionHandles: timeoutIdsByConnection.keys(),
        counts: { timedConnections: timeoutIdsByConnection.size },
      });
    },
    delete: (connectionHandle) => {
      if (!timeoutIdsByConnection.has(connectionHandle)) {
        return false;
      }

      // stop the timers first, then forget them
      clearInactivityTimeout(connectionHandle);

      return timeoutIdsByConnection.delete(connectionHandle);
    },
    setConnectionInactivityTimeout: (timeoutId, connectionHandle) => {
      const timeoutIds = timeoutIdsOf(connectionHandle);

      clearTimeout(timeoutIds.connectionTimeoutId);
      timeoutIds.connectionTimeoutId = timeoutId;
    },
    setSessionInactivityTimeout: (timeoutId, connectionHandle) => {
      const timeoutIds = timeoutIdsOf(connectionHandle);

      clearTimeout(timeoutIds.sessionTimeoutId);
      timeoutIds.sessionTimeoutId = timeoutId;
    },
    [Symbol.dispose]: () => {
      for (const connectionHandle of timeoutIdsByConnection.keys()) {
        clearInactivityTimeout(connectionHandle);
      }

      timeoutIdsByConnection.clear();
    },
  };
};

// definition

/**
 * The sessions of a router server, by connection: each one's token, which the router announces to
 * its connection when it changes, its data, and the two inactivity timers that tell the router when
 * to drop it.
 *
 * Nothing handed in or out is shared with what is stored: `data` must be structured-cloneable.
 *
 * @example
 * import { createSessionManager } from '@francisdesjardins/bead/session-manager';
 *
 * using sessions = createSessionManager<{ username: string }>();
 *
 * sessions.on('sessionInactivityTimeoutReached', (session) => {
 *   sessions.delete(session.connectionHandle);
 * });
 *
 * const session = sessions.getOrElseSet('type=WS;ip=127.0.0.1;port=50000');
 *
 * session.data = { username: 'guest' };
 * session.sessionInactivityTimeout = 10_000;
 *
 * sessions.updateData(session);
 * sessions.updateSessionInactivityTimeout(session);
 */
export const createSessionManager = <Data>(
  options?: ISessionManagerOptions
): ISessionManager<Data> => {
  const {
    connectionInactivityTimeout:
      defaultConnectionInactivityTimeout = DEFAULTS.connectionInactivityTimeout,
    sessionInactivityTimeout: defaultSessionInactivityTimeout = DEFAULTS.sessionInactivityTimeout,
  } = options ?? {};

  assertDefaultTimeout('connectionInactivityTimeout', defaultConnectionInactivityTimeout);
  assertDefaultTimeout('sessionInactivityTimeout', defaultSessionInactivityTimeout);

  const emitter = createEmitter<SessionManagerEventMap<Data>>();
  // by token, so a draw or a check costs nothing however many sessions there are, and by
  // connection through the token each one holds
  const sessions = new Map<SessionToken, ISession<Data>>();
  const tokens = new Map<TransportServerConnectionHandle, SessionToken>();
  const timers = createTimers();

  // `emit` stays in here: only the manager says what happened to its sessions
  // oxlint-disable-next-line typescript/unbound-method -- `createEventMethods` returns arrow functions, which have no `this` to lose
  const { emit, ...eventMethods } = createEventMethods(emitter, () => {
    return manager;
  });

  const copyOf = (session: ISession<Data>): ISession<Data> => {
    return structuredClone(session);
  };

  // an event's copies are made only when someone will receive them: activity comes with every message
  const emitIfHeard = <K extends SESSION_MANAGER_EVENTS>(
    event: K,
    params: () => SessionManagerEventMap<Data>[K]
  ): void => {
    if (emitter.listenerCount(event) > 0) {
      emit(event, ...params());
    }
  };

  const storedOf = (
    connectionHandle: TransportServerConnectionHandle
  ): ISession<Data> | undefined => {
    const token = tokens.get(connectionHandle);

    return token === undefined ? undefined : sessions.get(token);
  };

  // a token given to `set` is one the wire can carry, and no other connection holds it
  const assertSessionToken = (
    sessionToken: unknown,
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    if (!isSessionToken(sessionToken)) {
      throw new ProgrammerError(
        `a session token is ${String(SESSION_TOKEN_BYTES)} bytes in unpadded base64url, not all zero`
      );
    }

    const holder = sessions.get(sessionToken);

    if (holder !== undefined && holder.connectionHandle !== connectionHandle) {
      throw new ProgrammerError('this session token belongs to another connection');
    }
  };

  // what fires is the session as it is then, not as it was when the timer was set
  const reach = (
    event: CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT | SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT,
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    const session = storedOf(connectionHandle);

    if (session !== undefined) {
      emitIfHeard(event, () => {
        return [copyOf(session)];
      });
    }
  };

  let isDisposed = false;

  // stamps a session's activity now and restarts both its timers; the stored session, not a copy
  const stamp = (connectionHandle: TransportServerConnectionHandle): ISession<Data> | undefined => {
    const storedSession = storedOf(connectionHandle);

    if (storedSession === undefined) {
      return undefined;
    }

    const newTimestamp = timestamp();
    const oldTimestamp = storedSession.lastActivityTimestamp;

    storedSession.lastActivityTimestamp = newTimestamp;

    // activity restarts both timers, even within the same millisecond
    manager.resetConnectionInactivityTimeout(
      storedSession,
      storedSession.connectionInactivityTimeout
    );
    manager.resetSessionInactivityTimeout(storedSession, storedSession.sessionInactivityTimeout);

    if (newTimestamp.ms !== oldTimestamp.ms) {
      emitIfHeard(LAST_ACTIVITY_TIMESTAMP_CHANGED_EVENT, () => {
        return [copyOf(storedSession), { ...newTimestamp }, oldTimestamp];
      });
    }

    return storedSession;
  };

  const manager: ISessionManager<Data> = {
    ...eventMethods,

    get timers() {
      return timers;
    },

    connectionHandles: () => {
      return [...tokens.keys()];
    },
    create: (connectionHandle) => {
      return {
        connectionHandle,
        connectionInactivityTimeout: Infinity,
        data: undefined,
        lastActivityTimestamp: timestamp(),
        sessionInactivityTimeout: Infinity,
        sessionToken: undefined,
      };
    },
    delete: (connectionHandle) => {
      const session = storedOf(connectionHandle);

      if (session === undefined) {
        return false;
      }

      tokens.delete(connectionHandle);

      if (session.sessionToken !== undefined) {
        sessions.delete(session.sessionToken);
      }

      timers.delete(connectionHandle);

      emitIfHeard(DELETED_EVENT, () => {
        return [copyOf(session)];
      });

      return true;
    },
    gauges: () => {
      const timed = timers.gauges();
      let untied = 0;

      for (const connectionHandle of timed.connectionHandles) {
        untied += tokens.has(connectionHandle) ? 0 : 1;
      }

      return mergeGauges([
        gaugesOf({
          anomalies:
            untied === 0 ? [] : [`${String(untied)} connections keep timers with no session`],
          connectionHandles: tokens.keys(),
          counts: { sessions: sessions.size },
        }),
        timed,
      ]);
    },
    get: (connectionHandle) => {
      const session = storedOf(connectionHandle);

      return session === undefined ? undefined : copyOf(session);
    },
    getAll: () => {
      return sessions
        .values()
        .map((session) => {
          return copyOf(session);
        })
        .toArray();
    },
    getOrElseSet: (connectionHandle) => {
      return manager.get(connectionHandle) ?? manager.set(manager.create(connectionHandle));
    },
    has: (connectionHandle) => {
      return tokens.has(connectionHandle);
    },
    resetConnectionInactivityTimeout: ({ connectionHandle }, timeout) => {
      timers.clearConnectionInactivityTimeout(connectionHandle);

      if (tokens.has(connectionHandle) && isArmable(timeout)) {
        timers.setConnectionInactivityTimeout(
          setTimeout(() => {
            reach(CONNECTION_INACTIVITY_TIMEOUT_REACHED_EVENT, connectionHandle);
          }, timeout),
          connectionHandle
        );
      }
    },
    resetSessionInactivityTimeout: ({ connectionHandle }, timeout) => {
      timers.clearSessionInactivityTimeout(connectionHandle);

      if (tokens.has(connectionHandle) && isArmable(timeout)) {
        timers.setSessionInactivityTimeout(
          setTimeout(() => {
            reach(SESSION_INACTIVITY_TIMEOUT_REACHED_EVENT, connectionHandle);
          }, timeout),
          connectionHandle
        );
      }
    },
    set: (session) => {
      // a resolver that finishes once its server is gone has nowhere left to store a session
      if (isDisposed) {
        throw new DisconnectError('the sessions were disposed');
      }

      const { connectionHandle } = session;
      const storedSession = storedOf(connectionHandle);
      const isNew = session.sessionToken === undefined;

      // everything that can throw runs before anything is stored, so a throw leaves the manager as
      // it was
      if (!isNew) {
        assertSessionToken(session.sessionToken, connectionHandle);
      }

      const sessionToken =
        session.sessionToken ??
        drawSessionToken((token) => {
          return sessions.has(token);
        });
      const nextSession = copyOf({
        ...session,
        connectionInactivityTimeout: resolveTimeout(
          session.connectionInactivityTimeout,
          defaultConnectionInactivityTimeout
        ),
        sessionInactivityTimeout: resolveTimeout(
          session.sessionInactivityTimeout,
          defaultSessionInactivityTimeout
        ),
        sessionToken,
      });
      const isSimilar = storedSession !== undefined && areSimilar(storedSession, nextSession);

      if (storedSession?.sessionToken !== undefined) {
        sessions.delete(storedSession.sessionToken);
      }

      sessions.set(sessionToken, nextSession);
      tokens.set(connectionHandle, sessionToken);

      // the timers follow what is stored: a new session starts over with no timer, and a timeout
      // that changed restarts its own
      if (isNew) {
        timers.create(connectionHandle);
      }

      if (
        isNew ||
        storedSession?.connectionInactivityTimeout !== nextSession.connectionInactivityTimeout
      ) {
        manager.resetConnectionInactivityTimeout(
          nextSession,
          nextSession.connectionInactivityTimeout
        );
      }

      if (
        isNew ||
        storedSession?.sessionInactivityTimeout !== nextSession.sessionInactivityTimeout
      ) {
        manager.resetSessionInactivityTimeout(nextSession, nextSession.sessionInactivityTimeout);
      }

      if (storedSession === undefined) {
        emitIfHeard(CREATED_EVENT, () => {
          return [copyOf(nextSession)];
        });
      } else if (!isSimilar) {
        emitIfHeard(UPDATED_EVENT, () => {
          return [copyOf(nextSession)];
        });
      }

      return copyOf(nextSession);
    },
    updateConnectionInactivityTimeout: (session) => {
      const storedSession = storedOf(session.connectionHandle);

      if (storedSession === undefined) {
        return undefined;
      }

      const newTimeout = resolveTimeout(
        session.connectionInactivityTimeout,
        defaultConnectionInactivityTimeout
      );
      const oldTimeout = storedSession.connectionInactivityTimeout;

      storedSession.connectionInactivityTimeout = newTimeout;

      if (newTimeout !== oldTimeout) {
        manager.resetConnectionInactivityTimeout(storedSession, newTimeout);
        emitIfHeard(CONNECTION_INACTIVITY_TIMEOUT_CHANGED_EVENT, () => {
          return [copyOf(storedSession), newTimeout, oldTimeout];
        });
      }

      return copyOf(storedSession);
    },
    updateData: (session) => {
      const storedSession = storedOf(session.connectionHandle);

      if (storedSession === undefined) {
        return undefined;
      }

      const newData = structuredClone(session.data);
      const oldData = storedSession.data;
      // compared before anything is stored, so a throw leaves the manager as it was
      const isSimilar = areSimilar(newData, oldData);

      storedSession.data = newData;

      if (!isSimilar) {
        emitIfHeard(DATA_CHANGED_EVENT, () => {
          return [copyOf(storedSession), structuredClone(newData), oldData];
        });
      }

      return copyOf(storedSession);
    },
    sessionTokenOf: (connectionHandle) => {
      return tokens.get(connectionHandle);
    },
    touch: (connectionHandle) => {
      return stamp(connectionHandle) !== undefined;
    },
    updateLastActivityTimestamp: (session) => {
      const storedSession = stamp(session.connectionHandle);

      return storedSession === undefined ? undefined : copyOf(storedSession);
    },
    updateSessionInactivityTimeout: (session) => {
      const storedSession = storedOf(session.connectionHandle);

      if (storedSession === undefined) {
        return undefined;
      }

      const newTimeout = resolveTimeout(
        session.sessionInactivityTimeout,
        defaultSessionInactivityTimeout
      );
      const oldTimeout = storedSession.sessionInactivityTimeout;

      storedSession.sessionInactivityTimeout = newTimeout;

      if (newTimeout !== oldTimeout) {
        manager.resetSessionInactivityTimeout(storedSession, newTimeout);
        emitIfHeard(SESSION_INACTIVITY_TIMEOUT_CHANGED_EVENT, () => {
          return [copyOf(storedSession), newTimeout, oldTimeout];
        });
      }

      return copyOf(storedSession);
    },
    [Symbol.dispose]: () => {
      isDisposed = true;
      timers[Symbol.dispose]();
      sessions.clear();
      tokens.clear();
    },
  };

  return manager;
};
