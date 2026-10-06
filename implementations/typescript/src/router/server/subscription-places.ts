// ── Subscription places ───────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import { sessionKeyOf } from '../shared/call-session';
import type { INotifyingSeries } from '../shared/metrics-registry';
import type {
  CallId,
  ICallAddress,
  IProcedureAddress,
  ISubscriber,
  SessionIdentifier,
} from '../shared/types';
import type { INotificationManager, ISubscribingCall } from './types';

// types

/** A call of a connection's. */
type ServerCall = ICallAddress<TransportServerConnectionHandle>;

// interfaces

/**
 * A call answered while another holds its place, the procedure it would take the place for, the
 * session it holds it in, whether it asked to be paced there, and the series it counts into.
 */
interface IWaiting extends IProcedureAddress {
  callId: CallId;
  end: number | undefined;
  identifier: SessionIdentifier | undefined;
  paced: boolean | undefined;
  series: INotifyingSeries | undefined;
}

/** A subscription a connection holds, answered: its call id, and the series it counts into. */
export interface ISubscribed {
  callId: CallId;
  series: INotifyingSeries | undefined;
}

/** A connection's subscription places: who holds each, who is still in flight, who waits. */
export interface ISubscriptionPlaces {
  /**
   * The place's holder cancelled: its subscription, in flight or established, goes, it waits for
   * no place any more, and the call that waited on it takes the place.
   */
  cancel(call: ServerCall): void;
  /** Forgets every call in flight and every call waiting — `connectionHandle`'s alone, when given. */
  clear(connectionHandle?: TransportServerConnectionHandle): void;
  /**
   * The calls a session's end ends on its connection — its connection's session, or a credential's,
   * by its identifier: each established subscription it holds, and each call of it waiting, which no
   * longer waits. A call in flight, registered from the moment it subscribes and still owed its
   * answer, is left to that answer.
   */
  drop(subscriber: ISubscriber<TransportServerConnectionHandle>): ISubscribed[];
  /** The subscribing calls in flight and those waiting for a place, counted, and their connections. */
  gauges(): IGauges<TransportServerConnectionHandle>;
  /**
   * An answer about to go out for `call`: a failure takes away what the call subscribed, and hands
   * its place over; a success keeps it, subscribes the call — paced, when it asked — when it
   * `notifies` and its connection holds no place for `procedure` in its session, or has it wait on
   * a holder still in flight. What it returns undoes the success, should the answer not go out.
   */
  settle(
    call: ISubscribingCall,
    answer: { isFailure: boolean; notifies: boolean; procedure: IProcedureAddress }
  ): (() => void) | undefined;
  /**
   * Subscribes `call` to `procedure`, in its session — paced, when it asked — in flight until its
   * answer settles it, and gives its call id; a connection that holds the place in that session
   * already gives the holder's, and nothing changes.
   */
  subscribe(call: ISubscribingCall, procedure: IProcedureAddress): CallId;
  /**
   * Every subscription a connection holds that was answered — established, or waiting on a holder
   * in flight — each as it would end with its connection: none in flight, which its call's answer
   * settles.
   */
  subscribedOf(connectionHandle: TransportServerConnectionHandle): ISubscribed[];
  /** Takes a subscription away, as its requester asks; whether the connection held it. */
  unsubscribe(call: ServerCall): boolean;
}

// definition

/**
 * The subscription places of a server's connections. A place is the one subscription a connection
 * holds to a procedure in a session of its own — its connection's, or a credential's — and the first
 * call of that session to take it keeps it. A call in a place is:
 *
 * - in flight, from `subscribe` until its answer goes out;
 * - established, once its answer went out, until it is cancelled, unsubscribed or dropped;
 * - waiting, when it was answered while another call, still in flight, held the place: the first
 *   one answered waits, and takes the place should the holder fall — its answer a failure, its
 *   answer not gone out, or its call cancelled — while its connection is open and holds none.
 *
 * A holder answered successfully leaves nothing waiting on it. The notifications themselves are
 * `notifications`': the places only say who takes them. `isConnected` is asked when a place is
 * handed over, so a connection that closed meanwhile takes none.
 */
export const createSubscriptionPlaces = ({
  isConnected,
  notifications,
}: {
  isConnected: (connectionHandle: TransportServerConnectionHandle) => boolean;
  notifications: INotificationManager;
}): ISubscriptionPlaces => {
  // by connection, the calls subscribed that their answer still has to settle
  const inFlight = new Map<TransportServerConnectionHandle, Set<CallId>>();
  // by connection, for each holder in flight, the first call answered meanwhile for its place
  const waiting = new Map<TransportServerConnectionHandle, Map<CallId, IWaiting>>();

  const isInFlight = ({ callId, connectionHandle }: ServerCall): boolean => {
    return inFlight.get(connectionHandle)?.has(callId) === true;
  };

  // takes a call out of flight; whether it was in flight
  const takeInFlight = ({ callId, connectionHandle }: ServerCall): boolean => {
    const calls = inFlight.get(connectionHandle);
    const was = calls?.delete(callId) === true;

    if (calls?.size === 0) {
      inFlight.delete(connectionHandle);
    }

    return was;
  };

  // takes out the call waiting on the place `holder` holds
  const takeWaiting = (holder: ServerCall): IWaiting | undefined => {
    const calls = waiting.get(holder.connectionHandle);
    const successor = calls?.get(holder.callId);

    calls?.delete(holder.callId);

    if (calls?.size === 0) {
      waiting.delete(holder.connectionHandle);
    }

    return successor;
  };

  // a call that leaves before the place it waits for is free waits no more
  const leaveWaiting = ({ callId, connectionHandle }: ServerCall): void => {
    const calls = waiting.get(connectionHandle);

    for (const [holder, successor] of calls ?? []) {
      if (successor.callId === callId) {
        calls?.delete(holder);
      }
    }

    if (calls?.size === 0) {
      waiting.delete(connectionHandle);
    }
  };

  // the place goes to the call that waited on it, while its connection is open and holds none
  const handOver = (
    successor: IWaiting | undefined,
    connectionHandle: TransportServerConnectionHandle
  ): void => {
    if (
      successor !== undefined &&
      isConnected(connectionHandle) &&
      notifications.subscriptionOf(successor, {
        connectionHandle,
        identifier: successor.identifier,
      }) === undefined
    ) {
      const { callId, end, identifier, paced, procedureId, series, serviceId } = successor;

      notifications.register(
        { procedureId, serviceId },
        { callId, connectionHandle, end, identifier, paced, series }
      );
    }
  };

  return {
    cancel: (call) => {
      takeInFlight(call);
      notifications.unregister(call.callId, call.connectionHandle);
      leaveWaiting(call);
      handOver(takeWaiting(call), call.connectionHandle);
    },
    clear: (connectionHandle) => {
      if (connectionHandle === undefined) {
        inFlight.clear();
        waiting.clear();
      } else {
        inFlight.delete(connectionHandle);
        waiting.delete(connectionHandle);
      }
    },
    drop: ({ connectionHandle, identifier }) => {
      const sessionKey = sessionKeyOf(identifier);
      const isOfSession = (held: { identifier?: SessionIdentifier | undefined }): boolean => {
        return sessionKeyOf(held.identifier) === sessionKey;
      };
      // a call waiting on one in flight already believes it is subscribed: it ends as one that is
      const calls = waiting.get(connectionHandle);
      const successors = [...(calls?.entries() ?? [])].filter(([, successor]) => {
        return isOfSession(successor);
      });

      for (const [holder] of successors) {
        calls?.delete(holder);
      }

      if (calls?.size === 0) {
        waiting.delete(connectionHandle);
      }

      return [
        ...notifications
          .subscriptions(connectionHandle)
          .filter((held) => {
            return isOfSession(held) && !isInFlight({ callId: held.callId, connectionHandle });
          })
          .map(({ callId }) => {
            return { callId, series: notifications.seriesOf(callId, connectionHandle) };
          }),
        ...successors.map(([, { callId, series }]) => {
          return { callId, series };
        }),
      ];
    },
    gauges: () => {
      return gaugesOf({
        // a call waits only on a holder in flight on its own connection
        connectionHandles: inFlight.keys(),
        counts: {
          subscriptionsInFlight: entriesOf(inFlight),
          subscriptionsWaiting: entriesOf(waiting),
        },
      });
    },
    settle: (call, { isFailure, notifies, procedure }) => {
      const { callId, connectionHandle } = call;
      let isSubscribed = takeInFlight(call);

      // a failure subscribes nobody, whatever its resolver did before it, and leaves its place to
      // the call that waited on it
      if (isFailure) {
        if (isSubscribed) {
          notifications.unregister(callId, connectionHandle);
          handOver(takeWaiting(call), connectionHandle);
        }

        return undefined;
      }

      const holder = notifies ? notifications.subscriptionOf(procedure, call) : undefined;

      // a notification's successful answer subscribes the connection under the request's call id,
      // when its resolver did not and the connection holds no place for it yet, before it goes out,
      // so no notification sent once the requester has its answer can miss it
      if (notifies && holder === undefined) {
        notifications.register(procedure, call);
        isSubscribed = true;
      }

      // answered while another call, still in flight, holds the place: the first answered waits
      if (
        holder !== undefined &&
        holder !== callId &&
        isInFlight({ callId: holder, connectionHandle }) &&
        waiting.get(connectionHandle)?.has(holder) !== true
      ) {
        const calls = waiting.get(connectionHandle) ?? new Map<CallId, IWaiting>();

        calls.set(holder, {
          callId,
          end: call.end,
          identifier: call.identifier,
          paced: call.paced,
          series: call.series,
          ...procedure,
        });
        waiting.set(connectionHandle, calls);
      }

      if (!isSubscribed) {
        return undefined;
      }

      // answered, the call keeps its place: what waited on it waits no more, unless the answer does
      // not go out, which takes away what it subscribed and hands the place over
      const successor = takeWaiting(call);

      return () => {
        notifications.unregister(callId, connectionHandle);
        handOver(successor, connectionHandle);
      };
    },
    subscribe: (call, procedure) => {
      const holder = notifications.subscriptionOf(procedure, call);

      // the first subscription is kept, and nothing is in flight for this call
      if (holder !== undefined) {
        return holder;
      }

      const calls = inFlight.get(call.connectionHandle) ?? new Set<CallId>();

      // ! in flight before it is registered: what its registration sets going — a session's end it
      // reached, say — drops no call still owed its answer
      calls.add(call.callId);
      inFlight.set(call.connectionHandle, calls);
      notifications.register(procedure, call);

      return call.callId;
    },
    subscribedOf: (connectionHandle) => {
      return [
        ...notifications
          .subscriptions(connectionHandle)
          .filter(({ callId }) => {
            return !isInFlight({ callId, connectionHandle });
          })
          .map(({ callId }) => {
            return { callId, series: notifications.seriesOf(callId, connectionHandle) };
          }),
        ...[...(waiting.get(connectionHandle)?.values() ?? [])].map(({ callId, series }) => {
          return { callId, series };
        }),
      ];
    },
    unsubscribe: (call) => {
      leaveWaiting(call);

      return notifications.unregister(call.callId, call.connectionHandle) !== undefined;
    },
  };
};
