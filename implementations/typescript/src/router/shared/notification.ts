// ── Notification ──────────────────────────────────────────────────────────────

// dependencies

import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError, toError } from '../../transport/shared/errors';
import { noop } from '../../transport/shared/noop';
import { TRIGGER_EVENT } from './constants';
import { DisconnectError, FailureError } from './errors';
import type {
  CallId,
  INotification,
  INotificationDependencies,
  INotificationLike,
  INotificationRegistration,
  IProcedure,
  IReceivedFailure,
  IRequestOptions,
  IRouterLike,
} from './types';

// interfaces

/** What a notification takes from the manager that makes it. */
export interface INotificationContext<RequestPayload, ResponsePayload, NotificationPayload> {
  dependencies: INotificationDependencies<RequestPayload, ResponsePayload, NotificationPayload>;
  /** `callable`, named after the procedure and carrying it, as everything the manager makes is. */
  named: <Callable extends (...params: never[]) => unknown>(
    callable: Callable
  ) => Callable & IProcedure;
  /** Tells the manager the notification was dropped, and the failure that ended it, if any. */
  onDropped: (failure: IReceivedFailure | undefined) => void;
  /** The requester of the call that subscribes the notification `subscribes` gives. */
  requesterOf: (
    subscribes: () => INotificationLike
  ) => (
    requestPayload: RequestPayload
  ) => (
    options: Pick<IRequestOptions, 'destinationId' | 'signal' | 'timeout'>
  ) => Promise<{ callId: CallId; payload: ResponsePayload }>;
  router: Pick<
    IRouterLike,
    'failures' | 'hasNotification' | 'registerNotification' | 'unregisterNotification'
  >;
  /** Tells `debug` of a notification that came in: its payload, or the failure it met. */
  trace: (step: { direction: 'rx'; error?: unknown; rx?: unknown }) => void;
}

// definition

/**
 * One procedure's notification, as a service manager makes it: a callable that registers a
 * callback, one request going out however many register at once, and what the router calls — its
 * `trigger`, with each notification, and its `drop`, when the other end ended its subscription. A
 * `window` that is not a whole number above 0 is a {@link ProgrammerError}.
 */
export const createNotification = <RequestPayload, ResponsePayload, NotificationPayload>(
  procedure: IProcedure,
  context: INotificationContext<RequestPayload, ResponsePayload, NotificationPayload>
): INotification<RequestPayload, NotificationPayload> => {
  const { dependencies, named, onDropped, requesterOf, router, trace } = context;
  const { serializer, unsubscribe } = dependencies;
  // named apart from a browser's global
  const notificationWindow = dependencies.window;

  if (
    notificationWindow !== undefined &&
    (!Number.isSafeInteger(notificationWindow) || notificationWindow < 1)
  ) {
    throw new ProgrammerError(
      `a window is a whole number above 0, not ${String(notificationWindow)}`
    );
  }

  // the call that subscribes names the notification, which is made below
  const requester = requesterOf(() => {
    return notification;
  });
  // each registration counts once, as in Node; every callback gets the same payload, and what it
  // returns goes in `returned`, for the trigger to wait on
  const callbacks = createEmitter<{
    trigger: [notification: NotificationPayload, returned: unknown[]];
  }>();

  /**
   * The notification's state, each variable answering one question. `registering`: is its one
   * request in flight? Callbacks registering meanwhile wait on it, so the router sees one request
   * and one registration. `unregistering`: is the last callback leaving? A registration waits for
   * it. `subscription`: which call subscribed, and with what answer, for `unsubscribe` to name it.
   * `generation`: how many times the notification was dropped with its connection, so a
   * registration that began before a drop — its `own` generation — knows it was dropped. Each
   * registration keeps `isRegistered` besides: whether it was taken away.
   */
  let registering: Promise<void> | undefined;
  let unregistering: Promise<unknown> | undefined;
  let subscription: { callId: CallId; response: ResponsePayload } | undefined;
  let generation = 0;

  const register = async (requestPayload: RequestPayload, options?: IRequestOptions) => {
    // held before it is asked for: a notification sent right behind the answer can come in the
    // same read as the answer, before anything waiting on the answer runs
    try {
      await router.registerNotification(notification);
      // a notification's own request names no connection, whichever router it goes through
      const { callId, payload } = await requester(requestPayload)({
        destinationId: options?.destinationId,
        signal: options?.signal,
        timeout: options?.timeout,
      });

      subscription = { callId, response: payload };
    } catch (reason) {
      // a router may hold it when what follows fails, as a subscription can
      if (router.hasNotification(notification)) {
        await router.unregisterNotification(notification).catch(noop);
      }

      throw reason;
    }
  };

  // the last callback out stops the notification: at the other end first, when it can be told,
  // so none comes for it after, then in the router
  const leave = async (): Promise<void> => {
    const left = subscription;
    // taken away at the other end, acknowledged: nothing is left there to cancel
    let isAcknowledged = false;

    subscription = undefined;

    try {
      if (unsubscribe !== undefined && left !== undefined) {
        await unsubscribe(left.callId, left.response);
        isAcknowledged = true;
      }
    } finally {
      await router.unregisterNotification(notification, { cancel: !isAcknowledged }).catch(noop);
    }
  };

  const notification: INotification<RequestPayload, NotificationPayload> = Object.assign(
    named(
      (
        requestPayload: RequestPayload,
        callback: (notification: NotificationPayload) => unknown
      ) => {
        return async (options?: IRequestOptions): Promise<INotificationRegistration> => {
          const own = generation;
          // this registration's own, so taking it away takes no other of the same callback
          const listener = (
            notificationPayload: NotificationPayload,
            returned: unknown[]
          ): void => {
            returned.push(callback(notificationPayload));
          };

          // listening first, so a notification the registration lets through is not lost
          callbacks.on(TRIGGER_EVENT, listener);

          try {
            await unregistering;

            // a registration in flight is waited on even when the router already holds it
            if (registering === undefined && !router.hasNotification(notification)) {
              registering = register(requestPayload, options).finally(() => {
                registering = undefined;
              });
            }

            await registering;

            // dropped with its connection meanwhile: nothing is left to listen to
            if (own !== generation) {
              throw new DisconnectError(
                `${procedure.procedureName} was dropped with its connection`
              );
            }
          } catch (reason) {
            callbacks.off(TRIGGER_EVENT, listener);

            throw reason;
          }

          let isRegistered = true;

          const unregister = async (): Promise<void> => {
            // taken away already, or dropped with its connection
            if (!isRegistered || own !== generation) {
              return;
            }

            isRegistered = false;
            callbacks.off(TRIGGER_EVENT, listener);

            if (callbacks.listenerCount(TRIGGER_EVENT) === 0) {
              const leaving = leave();

              unregistering = leaving.catch(noop).finally(() => {
                unregistering = undefined;
              });

              await leaving;
            }
          };

          return { unregister, [Symbol.asyncDispose]: unregister };
        };
      }
    ),
    {
      window: notificationWindow,

      drop: (failure?: IReceivedFailure) => {
        // the other end forgot the subscription, with its connection or with a failure: the
        // callbacks hear nothing more, their registrations have nothing left to take away, and the
        // next asks anew
        generation += 1;
        subscription = undefined;
        callbacks.removeAllListeners(TRIGGER_EVENT);
        onDropped(failure);
      },
      trigger: (payload: Uint8Array) => {
        if (!router.hasNotification(notification)) {
          throw new ProgrammerError(`${procedure.procedureName} should not have been triggered`);
        }

        let notificationPayload: NotificationPayload;

        // a notification that does not decode fails here, for the router to report
        try {
          notificationPayload = serializer.decodeNotification(payload);
        } catch (reason) {
          const error = new FailureError(
            { ...router.failures.payloadUndecodable, detail: toError(reason).message },
            { cause: reason, procedureAddress: procedure }
          );

          trace({ direction: 'rx', error });

          throw error;
        }

        trace({ direction: 'rx', rx: notificationPayload });

        const returned: unknown[] = [];

        callbacks.emit(TRIGGER_EVENT, notificationPayload, returned);

        return Promise.allSettled(returned);
      },
    }
  );

  return notification;
};
