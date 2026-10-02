// ── Notification manager ──────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { ProgrammerError } from '../../transport/shared/errors';
import { entriesOf, gaugesOf } from '../../transport/shared/gauges';
import type { CallId, IProcedureAddress, ProcedureId, ServiceId } from '../shared/types';
import { createPacing, pacingLimitsOf } from './notification-pacing';
import type {
  INotificationManager,
  INotificationManagerOptions,
  IPacing,
  NotificationCandidates,
} from './types';

export { ProgrammerError } from '../../transport/shared/errors';
export { PACING_DEFAULTS } from './notification-pacing';
export type { CallId, IProcedureAddress, ProcedureId, ServiceId } from '../shared/types';
export type {
  INotificationManager,
  INotificationManagerOptions,
  IPacing,
  ISubscribingCall,
  ISubscription,
  NotificationCandidates,
  Notifications,
  PacingLimitsOptions,
} from './types';

// interfaces

/**
 * One subscription: which procedure, which connection, under which call id, its pacing when its
 * request asked for one, and the collections holding it, so taking it out needs no lookup that could
 * miss.
 */
interface INotificationTarget extends IProcedureAddress {
  readonly callId: CallId;
  readonly candidates: NotificationCandidates;
  readonly candidatesByProcedure: Map<ProcedureId, NotificationCandidates>;
  readonly connectionHandle: TransportServerConnectionHandle;
  readonly connectionTargets: Map<CallId, INotificationTarget>;
  readonly pacing: IPacing | undefined;
}

// definition

/**
 * Who asked to be notified of which procedure of which service, each subscription under the call id
 * of the request that made it — two connections may each hold the same one. The router registers a
 * connection when it subscribes, looks up the `candidates` when the procedure notifies, and `clean`s
 * a connection when it closes. Each of those costs what it touches, not the size of the registry.
 * A subscription whose request asked to be paced holds its pacing, which goes with it, queue and
 * all, however it goes.
 *
 * @example
 * import { createNotificationManager } from '@francisdesjardins/bead/notification-manager';
 *
 * const notifications = createNotificationManager();
 *
 * notifications.register(
 *   { procedureId: 1, serviceId: 2 },
 *   { callId: 13, connectionHandle: 'type=WS;ip=127.0.0.1;port=50000' }
 * );
 */
export const createNotificationManager = (
  options?: INotificationManagerOptions
): INotificationManager => {
  const limits = pacingLimitsOf(options?.pacing);
  const notifications = new Map<ServiceId, Map<ProcedureId, NotificationCandidates>>();
  // the subscriptions paced, so their gauges walk no other
  const paced = new Map<INotificationTarget, IPacing>();
  // the same subscriptions by connection and call id, so nothing walks the registry
  const targetsByConnection = new Map<
    TransportServerConnectionHandle,
    Map<CallId, INotificationTarget>
  >();

  const remove = (target: INotificationTarget): void => {
    const {
      callId,
      candidates,
      candidatesByProcedure,
      connectionHandle,
      connectionTargets,
      procedureId,
      serviceId,
    } = target;

    connectionTargets.delete(callId);
    candidates.delete(connectionHandle);
    paced.delete(target);

    // an empty collection leaves with its last entry, so the registry holds only what is registered
    if (connectionTargets.size === 0) {
      targetsByConnection.delete(connectionHandle);
    }

    if (candidates.size === 0) {
      candidatesByProcedure.delete(procedureId);
    }

    if (candidatesByProcedure.size === 0) {
      notifications.delete(serviceId);
    }
  };

  const subscriptionOf: INotificationManager['subscriptionOf'] = (
    { procedureId, serviceId },
    connectionHandle
  ) => {
    return notifications.get(serviceId)?.get(procedureId)?.get(connectionHandle);
  };

  return {
    get notifications() {
      return notifications;
    },

    candidates: ({ procedureId, serviceId }) => {
      return new Map(notifications.get(serviceId)?.get(procedureId));
    },
    clean: (connectionHandle) => {
      // a map skips what is deleted from it mid-walk, so each removal is safe here
      for (const target of targetsByConnection.get(connectionHandle)?.values() ?? []) {
        remove(target);
      }
    },
    gauges: () => {
      const queued = {
        largestQueuedNotificationBytes: 0,
        largestQueuedNotifications: 0,
        pausedSubscriptions: 0,
        queuedNotificationBytes: 0,
        queuedNotifications: 0,
      };

      for (const { isPaused, queuedNotificationBytes, queuedNotifications } of paced.values()) {
        queued.largestQueuedNotificationBytes = Math.max(
          queued.largestQueuedNotificationBytes,
          queuedNotificationBytes
        );
        queued.largestQueuedNotifications = Math.max(
          queued.largestQueuedNotifications,
          queuedNotifications
        );
        queued.pausedSubscriptions += isPaused ? 1 : 0;
        queued.queuedNotificationBytes += queuedNotificationBytes;
        queued.queuedNotifications += queuedNotifications;
      }

      return gaugesOf({
        // a subscription queues up to its limits, so the fullest one says how near they are
        ceilings: {
          largestQueuedNotificationBytes: limits.maximumQueuedNotificationBytes,
          largestQueuedNotifications: limits.maximumQueuedNotifications,
        },
        connectionHandles: targetsByConnection.keys(),
        counts: { ...queued, notifiedSubscriptions: entriesOf(targetsByConnection) },
      });
    },
    has: (callId, connectionHandle) => {
      return targetsByConnection.get(connectionHandle)?.has(callId) === true;
    },
    pacingOf: (callId, connectionHandle) => {
      return targetsByConnection.get(connectionHandle)?.get(callId)?.pacing;
    },
    register: ({ procedureId, serviceId }, { callId, connectionHandle, paced: isPaced }) => {
      const holder = subscriptionOf({ procedureId, serviceId }, connectionHandle);

      // the first subscription wins: another would take the notifications from the call that has them
      if (holder !== undefined) {
        throw new ProgrammerError(
          `${connectionHandle} is subscribed to ${String(serviceId)}/${String(procedureId)} under call ${String(holder)} already`
        );
      }

      if (targetsByConnection.get(connectionHandle)?.has(callId) === true) {
        throw new ProgrammerError(`${connectionHandle} holds call ${String(callId)} already`);
      }

      let candidatesByProcedure = notifications.get(serviceId);

      if (candidatesByProcedure === undefined) {
        candidatesByProcedure = new Map();
        notifications.set(serviceId, candidatesByProcedure);
      }

      let candidates = candidatesByProcedure.get(procedureId);

      if (candidates === undefined) {
        candidates = new Map();
        candidatesByProcedure.set(procedureId, candidates);
      }

      let connectionTargets = targetsByConnection.get(connectionHandle);

      if (connectionTargets === undefined) {
        connectionTargets = new Map();
        targetsByConnection.set(connectionHandle, connectionTargets);
      }

      const pacing = isPaced === true ? createPacing(limits) : undefined;
      const target: INotificationTarget = {
        callId,
        candidates,
        candidatesByProcedure,
        connectionHandle,
        connectionTargets,
        pacing,
        procedureId,
        serviceId,
      };

      candidates.set(connectionHandle, callId);
      connectionTargets.set(callId, target);

      if (pacing !== undefined) {
        paced.set(target, pacing);
      }

      return callId;
    },
    subscriptionOf,
    subscriptions: (connectionHandle) => {
      // one connection's walks only what it holds
      const byConnection =
        connectionHandle === undefined
          ? targetsByConnection.values()
          : [
              targetsByConnection.get(connectionHandle) ?? new Map<CallId, INotificationTarget>(),
            ].values();

      return byConnection
        .flatMap((connectionTargets) => {
          return connectionTargets.values();
        })
        .map(({ callId, connectionHandle, procedureId, serviceId }) => {
          return { callId, connectionHandle, procedureId, serviceId };
        })
        .toArray();
    },
    unregister: (callId, connectionHandle) => {
      const target = targetsByConnection.get(connectionHandle)?.get(callId);

      if (target === undefined) {
        return undefined;
      }

      return (remove(target), callId);
    },
  };
};
