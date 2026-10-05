// ── Credential sessions ───────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { type IClock, LONGEST_TIMER, type TimeoutId } from '../../transport/shared/clock';
import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import { sessionKeyOf } from '../shared/call-session';
import { CredentialScheme } from '../shared/constants';
import type { CallId, ICallSession, SessionIdentifier } from '../shared/types';
import type { INotificationManager, ISubscribingCall, ISubscriber } from './types';

// interfaces

/**
 * A credential's session a connection keeps (spec 13.9): its identifier, its end, the later of those
 * its calls resolved to — none for one without — the timer toward it, how many times it was timed,
 * which an end reached and taken in a later turn holds to, and the subscriptions it holds, by call
 * id.
 */
interface IKept {
  readonly calls: Set<CallId>;
  readonly connectionHandle: TransportServerConnectionHandle;
  end: number | undefined;
  readonly identifier: SessionIdentifier;
  timer: TimeoutId | undefined;
  timing: number;
}

/** The credentials' sessions of a server's connections, kept while they hold a subscription. */
export interface ICredentialSessions {
  /**
   * The notifications, tracked: a credential's session is kept, on its connection, from the first
   * subscription it holds there to its last, and timed meanwhile.
   */
  readonly notifications: INotificationManager;

  /** Forgets what the connection keeps — its sessions and their timers — as it closes. */
  clear(connectionHandle: TransportServerConnectionHandle): void;
  /**
   * Ends the credential's session `identifier` names on every connection that keeps it, and
   * settles once each ended what it bounded; one no connection keeps ends nothing.
   */
  end(identifier: SessionIdentifier): Promise<void>;
  /**
   * Ends every `JWT`'s session whose identifier's issuer is `issuer`, octet for octet, its `sid`'s
   * and its `sub`'s alike, on every connection that keeps one, and settles once each ended what it
   * bounded; an `ELSEWHERE`'s names no issuer, and one no connection keeps ends nothing.
   */
  endSessionsOf(issuer: string): Promise<void>;
  /** The sessions kept and their timers, counted, and their connections. */
  gauges(): IGauges<TransportServerConnectionHandle>;
  /**
   * A subscribing call answered, its subscription held: its session kept, should it have ended
   * while the call was in flight — and ended in a turn of its own, should its end have been reached.
   */
  held(
    call: Pick<ISubscribingCall, 'callId' | 'connectionHandle' | 'end'> & {
      identifier: SessionIdentifier;
    }
  ): void;
  /**
   * The session a call of `connectionHandle` runs in, its credential resolved to `session`: one the
   * connection keeps under its identifier takes the later of the two ends, timed anew, and the call
   * runs with it; any other runs with its own.
   */
  resolved(session: ICallSession, connectionHandle: TransportServerConnectionHandle): ICallSession;
  /** Stops every timer and forgets every session, as the router is disposed. */
  [Symbol.dispose](): void;
}

// helpers

/** The later of two ends, none — a session without one — the later of any. */
const laterOf = (first: number | undefined, second: number | undefined): number | undefined => {
  return first === undefined || second === undefined ? undefined : Math.max(first, second);
};

// definition

/**
 * The credentials' sessions a server's connections keep, on `clock`: each from the first
 * subscription it holds on its connection to its last, its end timed by reading the wall clock again
 * as it comes to be kept, as a renewal moves it, and at each due — a timer of the time left, at most
 * the longest one holds, in place of the one before — so a wall clock set by hand takes effect at the
 * next due. An end reached as it is read is taken in a turn of its own, past the answer of the call
 * that kept it. At its end, by its identifier or its issuer, `onEnd` ends what it bounds on its
 * connection.
 */
export const createCredentialSessions = ({
  clock,
  notifications,
  onEnd,
}: {
  clock: IClock;
  notifications: INotificationManager;
  /** Ends what a credential's session bounds on its connection: it ended. */
  onEnd: (subscriber: Required<ISubscriber>) => Promise<void>;
}): ICredentialSessions => {
  // by connection, then by the key the identifier gives
  const kept = new Map<TransportServerConnectionHandle, Map<string, IKept>>();

  const keptOf = (
    identifier: SessionIdentifier | undefined,
    connectionHandle: TransportServerConnectionHandle
  ): IKept | undefined => {
    return identifier === undefined
      ? undefined
      : kept.get(connectionHandle)?.get(sessionKeyOf(identifier));
  };

  // forgets a session kept, and stops its timer
  const forget = (session: IKept): void => {
    const sessions = kept.get(session.connectionHandle);

    clock.clearTimeout(session.timer);
    session.timer = undefined;
    sessions?.delete(sessionKeyOf(session.identifier));

    if (sessions?.size === 0) {
      kept.delete(session.connectionHandle);
    }
  };

  // ends a session kept: forgotten first, so what its end takes away finds nothing to release
  const end = (session: IKept): Promise<void> => {
    const { connectionHandle, identifier } = session;

    forget(session);

    return onEnd({ connectionHandle, identifier });
  };

  // * the wall clock read again, never counted down: the time left ends the session, or arms the
  // timer toward its end in place of the one before
  const time = (session: IKept): void => {
    clock.clearTimeout(session.timer);
    session.timer = undefined;
    session.timing += 1;

    if (session.end === undefined) {
      return;
    }

    const remaining = session.end - Math.floor(clock.Date.now());

    // ! ended in a turn of its own, no timer armed: a session kept by a subscribing call — its
    // resolver's, or its answer's, which reaches its transport in the turn it goes — ends past that
    // answer, never on a call still owed one; one timed again or forgotten meanwhile ends nothing
    if (remaining <= 0) {
      const { timing } = session;

      return (
        queueMicrotask(() => {
          if (
            session.timing === timing &&
            keptOf(session.identifier, session.connectionHandle) === session
          ) {
            void end(session);
          }
        }),
        undefined
      );
    }

    session.timer = clock.setTimeout(
      () => {
        time(session);
      },
      Math.min(remaining, LONGEST_TIMER)
    );
  };

  // a subscription of `call`'s session, kept from its first: its end the later of those it holds
  const keep = ({
    callId,
    connectionHandle,
    end: callEnd,
    identifier,
  }: {
    callId: CallId;
    connectionHandle: TransportServerConnectionHandle;
    end: number | undefined;
    identifier: SessionIdentifier;
  }): void => {
    const session = keptOf(identifier, connectionHandle);

    if (session !== undefined) {
      const moved = laterOf(session.end, callEnd);

      session.calls.add(callId);

      if (moved !== session.end) {
        session.end = moved;
        time(session);
      }

      return;
    }

    const sessions = kept.get(connectionHandle) ?? new Map<string, IKept>();
    const created: IKept = {
      calls: new Set([callId]),
      connectionHandle,
      end: callEnd,
      identifier,
      timer: undefined,
      timing: 0,
    };

    sessions.set(sessionKeyOf(identifier), created);
    kept.set(connectionHandle, sessions);
    time(created);
  };

  // a subscription gone: its session, once it holds none, is kept no more
  const release = (
    { callId, identifier }: { callId: CallId; identifier?: SessionIdentifier | undefined },
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    const session = keptOf(identifier, connectionHandle);

    session?.calls.delete(callId);

    if (session?.calls.size === 0) {
      forget(session);
    }
  };

  const tracked: INotificationManager = {
    get notifications() {
      return notifications.notifications;
    },

    candidates: (procedureAddress) => {
      return notifications.candidates(procedureAddress);
    },
    clean: (connectionHandle) => {
      notifications.clean(connectionHandle);

      for (const session of kept.get(connectionHandle)?.values() ?? []) {
        forget(session);
      }
    },
    gauges: () => {
      return notifications.gauges();
    },
    has: (callId, connectionHandle) => {
      return notifications.has(callId, connectionHandle);
    },
    pacingOf: (callId, connectionHandle) => {
      return notifications.pacingOf(callId, connectionHandle);
    },
    seriesOf: (callId, connectionHandle) => {
      return notifications.seriesOf(callId, connectionHandle);
    },
    register: (procedureAddress, subscription) => {
      const callId = notifications.register(procedureAddress, subscription);
      const { connectionHandle, end: callEnd, identifier } = subscription;

      if (identifier !== undefined) {
        keep({ callId, connectionHandle, end: callEnd, identifier });
      }

      return callId;
    },
    subscriptionOf: (procedureAddress, subscriber) => {
      return notifications.subscriptionOf(procedureAddress, subscriber);
    },
    subscriptions: (connectionHandle) => {
      return notifications.subscriptions(connectionHandle);
    },
    unregister: (callId, connectionHandle) => {
      const subscription = notifications.subscriptions(connectionHandle).find((held) => {
        return held.callId === callId;
      });
      const unregistered = notifications.unregister(callId, connectionHandle);

      if (subscription !== undefined) {
        release(subscription, connectionHandle);
      }

      return unregistered;
    },
  };

  return {
    notifications: tracked,

    clear: (connectionHandle) => {
      for (const session of kept.get(connectionHandle)?.values() ?? []) {
        forget(session);
      }
    },
    end: async (identifier) => {
      const ending = kept
        .values()
        .map((sessions) => {
          return sessions.get(sessionKeyOf(identifier));
        })
        .filter((session) => {
          return session !== undefined;
        })
        .toArray();

      await Promise.all(ending.map(end));
    },
    endSessionsOf: async (issuer) => {
      const ending = kept
        .values()
        .flatMap((sessions) => {
          return sessions.values();
        })
        .filter(({ identifier }) => {
          return identifier.scheme === CredentialScheme.JWT && identifier.issuer === issuer;
        })
        .toArray();

      await Promise.all(ending.map(end));
    },
    held: (call) => {
      const { callId, connectionHandle, identifier } = call;
      const subscription = notifications.subscriptions(connectionHandle).find((each) => {
        return each.callId === callId;
      });

      // a call whose answer did not go out, or that holds no subscription of that session, keeps
      // nothing
      if (
        subscription === undefined ||
        sessionKeyOf(subscription.identifier) !== sessionKeyOf(identifier) ||
        keptOf(identifier, connectionHandle)?.calls.has(callId) === true
      ) {
        return;
      }

      keep({ ...call, end: call.end });
    },
    gauges: () => {
      let timed = 0;

      for (const sessions of kept.values()) {
        for (const { timer } of sessions.values()) {
          timed += timer === undefined ? 0 : 1;
        }
      }

      return gaugesOf({
        connectionHandles: kept.keys(),
        counts: { credentialSessions: entriesOf(kept), timedCredentialSessions: timed },
      });
    },
    resolved: (session, connectionHandle) => {
      const held = keptOf(session.identifier, connectionHandle);

      if (held === undefined) {
        return session;
      }

      const moved = laterOf(held.end, session.end);

      // a renewal moves the end, whatever the order resolutions settle in
      if (moved !== held.end) {
        held.end = moved;
        time(held);
      }

      return Object.freeze({ ...session, end: held.end });
    },
    [Symbol.dispose]: () => {
      for (const sessions of kept.values()) {
        for (const session of sessions.values()) {
          clock.clearTimeout(session.timer);
        }
      }

      kept.clear();
    },
  };
};
